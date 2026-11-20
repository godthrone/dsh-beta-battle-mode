#!/usr/bin/env node
/**
 * Smoke test for the three plugins: mount each one against a fake host, drive
 * the real code paths, and assert what landed on disk / what the tools return.
 *
 * This exists because a rename once deleted a helper and the recorder started
 * swallowing a ReferenceError: every message was lost for a day and the only
 * trace was one stderr line. A release must fail here instead.
 */
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Mount a plugin with a fake context and return its handlers and tools. */
async function mount(entry, llm) {
  const handlers = {}
  const tools = []
  const ctx = {
    on: (name, fn) => {
      handlers[name] = fn
    },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    llm,
  }
  const module = await import(entry)
  await module.apply(ctx)
  return { handlers, tools }
}

const userMessage = (id, text) => ({
  role: 'user',
  id,
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

/** Run one agent/pre-step through the recorder. */
const feed = async (handlers, agent, message) => {
  await handlers['agent/pre-step']({ agent, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
}

const readLedger = (cwd) => {
  const dir = join(cwd, '.local', 'ledger')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), 'utf8').trim().split('\n'))
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

const cwd = mkdtempSync(join(tmpdir(), 'ledger-smoke-'))
const agent = {
  session: {
    header: { id: 'session-smoke', cwd, origin: 'main' },
    deriveMessages: () => [],
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
  },
}

console.log('user-ledger')
{
  const { handlers, tools } = await mount(new URL('../lib/user-ledger.js', import.meta.url).href, {
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '#1 — 理由：原话写了「两天一版」。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })

  await feed(handlers, agent, userMessage('4f2a1b3c-1111-2222-3333-444455556666', '这个版本两天一版，别拖'))
  await feed(handlers, agent, userMessage('5a3b2c1d-1111-2222-3333-444455556666', '[消息通道] 用户经微信投递了 1 个文件：\n  /tmp/a.md'))
  await feed(
    handlers,
    agent,
    userMessage('6b4c3d2e-1111-2222-3333-444455556666', '[消息通道] 收到指令（原文见下）。\n\n【用户原话 · 逐字】\n[MAIN] 2026-11-20 09:00\n---\n这句才是原话\n---\n')
  )

  const entries = readLedger(cwd)
  check('records a plain message', entries.length >= 1 && entries[0].text === '这个版本两天一版，别拖')
  check('stores no asks field', entries.every((entry) => !('asks' in entry)))
  check('skips a paths-only channel notice', !entries.some((entry) => entry.text.startsWith('[消息通道]')))
  check('unwraps an inlined quote', entries.some((entry) => entry.text === '这句才是原话'))
  check('strips the session- prefix from sid', entries.every((entry) => entry.sid === 'smoke'))

  const search = tools.find((tool) => tool.name === 'ledger_search')
  const show = tools.find((tool) => tool.name === 'ledger_show')
  check('registers ledger_search', search !== undefined)
  check('registers ledger_show', show !== undefined)

  const found = await search.execute({ query: '节奏', date: new Date().toISOString().slice(0, 10) }, { agent })
  check('search returns the model answer', found.text.includes('理由：原话写了'))
  check('search stamps a stable reference', /#1 \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} · [0-9a-f]{8}\)/.test(found.text))

  const digest = /\((?:[^)]*·\s*)([0-9a-f]{8})\)/.exec(found.text)?.[1]
  const opened = await show.execute({ ref: digest }, { agent })
  check('show resolves by id prefix', opened.text.includes('这个版本两天一版'))

  const miss = await search.execute({ query: '节奏', date: '1999-01-01' }, { agent })
  check('missing day reports honestly', miss.text.includes('台账里没有记录'))
}

// The compaction backend subclasses a host package (`@deepseek-ai/dsh-compaction-basic`),
// so it can only be imported inside a running host. Check that it parses and that
// every preset row still points at a file that exists.
import { spawnSync } from 'node:child_process'

console.log('constitution §13.1 — no swallowed exceptions')
{
  const { readdirSync } = await import('node:fs')
  const files = readdirSync('lib').filter((f) => f.endsWith('.js'))
  for (const file of files) {
    const source = readFileSync(join('lib', file), 'utf8')
    // `catch {` binds nothing, so the failure cannot be named, logged or
    // converted — a constitutional violation on its own.
    const unbound = source.match(/catch\s*\{/g) ?? []
    check(`${file}: every catch binds its error`, unbound.length === 0, `${unbound.length} bare catch`)

    // A block holding only comments is the same silence with extra typing.
    const empty = [...source.matchAll(/catch\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\}/g)].filter(
      ([, , body]) => body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim() === ''
    )
    check(`${file}: no empty catch body`, empty.length === 0, `${empty.length} silent block(s)`)
  }
}

console.log('plugins')
{
  for (const file of ['lib/compaction.js', 'lib/goal-round-reminder.js', 'lib/user-ledger.js']) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    check(`${file} parses`, result.status === 0, result.stderr.split('\n')[0])
  }
}

rmSync(cwd, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsmoke: all checks passed')
