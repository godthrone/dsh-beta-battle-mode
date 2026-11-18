/**
 * BADGE chairman ledger (主席原文台账).
 *
 * The commander's session log already stores every user message verbatim, but
 * the commander cannot read it: the log lives outside the workspace, is zstd
 * compressed, and no tool exposes it. This plugin writes a small JSONL index
 * beside the work log so a decision can always be traced back to what the
 * chairman actually said, and to the questions it was answering.
 *
 * What is stored per user message:
 *   text   the chairman's words, verbatim (small, so it is kept inline)
 *   sid    the session id, so the full context can be resolved on demand
 *
 * Scope: mounted by the agent preset, so only BETA sessions record. Subagent
 * sessions are skipped: their user messages are dispatch briefs, not rulings.
 *
 * @module dsh-beta-battle-mode/lib/chairman-ledger
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis plugin name. */
const name = 'chairman-ledger'

/** Mounted row needs the tool registry. */
export const inject = ['tools', 'llm']

/** Ledger directory relative to the workspace root. */
const LEDGER_DIR = join('.local', '主席原文')

/** Only real user input counts; runtime context and catalogs are injected. */
function isChairmanMessage(message) {
  return message?.source?.kind === 'user'
}

/** Local ISO timestamp with offset. */
function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** Date key used in the file name. */
function dayKey(stamp) {
  return stamp.slice(0, 10)
}

/** Ledger directory of a workspace. */
function ledgerDir(cwd) {
  return join(cwd, LEDGER_DIR)
}

/** Append one entry, creating the directory on first use. */
function appendEntry(cwd, entry) {
  const dir = ledgerDir(cwd)
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `utterances-${dayKey(entry.time)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Every entry of a workspace, oldest first, with its `n` assigned. */
function readEntries(cwd) {
  const dir = ledgerDir(cwd)
  if (!existsSync(dir)) return []
  const entries = []
  for (const file of readdirSync(dir).filter((f) => /^utterances-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    let raw
    try {
      raw = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        // A half-written line is not worth failing a read over.
      }
    }
  }
  entries.forEach((entry, index) => {
    entry.n = index + 1
  })
  return entries
}

/** Parse a `since` window such as `3d`, `12h`, or an ISO date. */
function parseSince(since) {
  if (since === undefined) return Date.now() - 7 * 86_400_000
  const match = /^(\d+)([dh])$/.exec(since.trim())
  if (match !== null) {
    const value = Number(match[1])
    return Date.now() - value * (match[2] === 'd' ? 86_400_000 : 3_600_000)
  }
  const parsed = Date.parse(since)
  return Number.isNaN(parsed) ? Date.now() - 2 * 86_400_000 : parsed
}

/** Register the recorder and the two read tools. */
async function apply(ctx) {
  const recorded = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    try {
      record(payload?.agent, payload?.messages)
    } catch (error) {
      console.warn(`chairman-ledger: 记录失败 ${error?.message ?? error}`)
    }
    return decision
  })

  function record(agent, messages) {
    const header = agent?.session?.header
    if (header === undefined || header === null) return
    if (header.origin === 'subagent') return
    if (typeof header.cwd !== 'string' || header.cwd === '') return
    if (!Array.isArray(messages) || messages.length === 0) return

    const sid = String(header.id).replace(/^session-/, '')
    let seen = recorded.get(sid)
    if (seen === undefined) {
      // Seed from disk: a restarted host must not re-record messages it already
      // wrote in a previous life. Older rows may still carry the `session-`
      // prefix, so compare on the bare id.
      seen = new Set(
        readEntries(header.cwd)
          .filter((entry) => String(entry.sid).replace(/^session-/, '') === sid)
          .map((entry) => entry.id)
      )
      recorded.set(sid, seen)
    }

    for (const message of messages) {
      if (!isChairmanMessage(message) || message.id === undefined) continue
      if (seen.has(message.id)) continue
      const text = unwrapChannelNotice(textOf(message))
      if (text === null || text === '') {
        seen.add(message.id)
        continue
      }
      appendEntry(header.cwd, {
        time: localStamp(),
        sid,
        id: message.id,
        text,
      })
      seen.add(message.id)
    }
  }

  /**
   * Resolve a citation to one entry. Accepts the stable form printed by
   * `ledger_search` (`2026-11-18 16:05 · 4f2a1b3c`), a bare id prefix, or the
   * legacy `#n` running number (kept for older reports, but it drifts).
   *
   * @param entries - every entry of the workspace, oldest first.
   * @param raw - the citation text as the caller wrote it.
   * @returns the matching entry, or undefined.
   */
  function resolveRef(entries, raw) {
    const trimmed = raw.trim()
    const hash = /^#?(\d+)$/.exec(trimmed)
    if (hash !== null) {
      const byNumber = entries.find((entry) => entry.n === Number(hash[1]))
      if (byNumber !== undefined) return byNumber
    }
    const stamp = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(trimmed)
    if (stamp !== null) {
      const exact = entries.find((entry) => entry.time.slice(0, 16).replace('T', ' ') === `${stamp[1]} ${stamp[2]}`)
      if (exact !== undefined) return exact
    }
    const idHint = trimmed.replace(/[^0-9a-zA-Z-]/g, '')
    if (idHint.length >= 6) {
      const matches = entries.filter((entry) => String(entry.id).startsWith(idHint))
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) return undefined
    }
    return undefined
  }

  /**
   * One-shot retrieval: the whole day's quotes plus the question go to a fresh
   * model call, so the answer comes from a clean context instead of leaning on
   * substring luck. The caller's own session stays untouched.
   *
   * Nothing is truncated per entry and no result count is imposed: the model
   * decides what is relevant. The only guard is a very high total-size ceiling,
   * so one pathological day cannot blow the request up.
   */
  async function searchDay(ctx, agent, query, date, entries) {
    const header = agent?.session?.requestHeader?.()
    const route = header?.config ?? {}
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') {
      return '检索未完成：拿不到当前会话的模型路由。'
    }

    const CEILING = 400_000
    let used = 0
    const lines = []
    let omitted = 0
    for (const entry of entries) {
      const line = `#${entry.n} ${entry.time.slice(11, 16)} 「${entry.text}」`
      if (used + line.length > CEILING) {
        omitted += 1
        continue
      }
      used += line.length
      lines.push(line)
    }

    const system =
      '你是检索器，只做一件事：在用户（主席）当天说过的原话里，找出与检索问题相关的条目。\n' +
      '规则：\n' +
      '1. 只输出条目序号和理由，每条一行，形如 `#18 — 理由：……`。\n' +
      '2. 先列确定相关的，按相关度从高到低；不确定相关的放在最后，理由里注明「不确定」。\n' +
      '3. 理由要具体：指出这条原话里哪个说法回答了问题，或与问题冲突在哪里。\n' +
      '4. 一条都不相关就只输出 `没有`，不要编造序号。'

    const user =
      `检索问题：\n${query}\n\n` +
      `${date} 主席原话共 ${entries.length} 条${omitted > 0 ? `（因总量超限省略 ${omitted} 条）` : ''}：\n` +
      lines.join('\n')

    const chunks = []
    let reasoning = ''
    let finish
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      })
      // `ctx.llm.stream()` yields raw StreamChunk values (text-delta /
      // reasoning-delta / finish), not the packed AssistantStreamRecord.
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') chunks.push(chunk.text)
        else if (chunk?.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk?.type === 'finish') finish = chunk.reason
        else if (chunk?.type === 'error') finish = { kind: 'error', failure: chunk.failure ?? chunk }
      }
    } catch (error) {
      return (
        `检索未完成（模型调用出错：${error?.message ?? error}）。` +
        `这不算「查过」：不要据此声称已核对台账，可重试一次。`
      )
    }

    const answer = chunks.join('').trim()
    if (answer === '') {
      const reason =
        finish === undefined
          ? '没有结束记录'
          : finish.kind === 'error'
            ? `失败 ${finish.failure?.code ?? ''} ${finish.failure?.message ?? ''}`.trim()
            : String(finish.kind)
      return (
        `检索未完成（结束原因：${reason}；推理 ${reasoning.length} 字）。` +
        `这不算「查过」：不要据此声称已核对台账；可重试一次，或直接看 .local/主席原文/ 里当天的文件。`
      )
    }

    // `#n` is a global running number that shifts whenever the ledger is
    // rewritten (a backfill reorders every file), so every hit also carries a
    // stable reference: the message timestamp and the message id prefix.
    const byNumber = new Map(entries.map((entry) => [entry.n, entry]))
    const stamped = answer.replace(/#(\d+)/g, (match, digits) => {
      const entry = byNumber.get(Number(digits))
      if (entry === undefined) return match
      const when = entry.time.slice(0, 16).replace('T', ' ')
      return `#${digits} (${when} · ${String(entry.id).slice(0, 8)})`
    })
    return `${date} 台账 ${entries.length} 条，检索结果：\n${stamped}\n\n引用时请用括号里的「日期 时间 · id 前缀」，不要用 #n（会随台账重排漂移）。`
  }

  ctx.tools.register({
      name: 'ledger_search',
      description:
        '在主席原话台账里做一次语义检索：把「你要找的东西」和指定那一天的全部原话交给一个独立模型，' +
        '由它挑出最相关的条目序号并说明理由（没有就回「没有」）。返回的是候选序号，展开原文用 ledger_show。' +
        '要改代码、改蓝图口径、改提示词，或怀疑与既有裁决冲突时用它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '要找什么，自然语言，写清议题、涉及的概念和你担心的冲突点。不超过 5000 字。',
          },
          date: {
            type: 'string',
            description: '查哪一天的主席原话，格式 yyyy-MM-dd（例如 2026-11-16）。台账按天分文件。',
          },
        },
        required: ['query', 'date'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string') return { text: '台账不可用：当前会话没有工作目录。' }

        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') return { text: 'ledger_search 需要一个 query。' }
        if (query.length > 5000) return { text: `query 太长（${query.length} 字），请压到 5000 字以内。` }

        const date = typeof args?.date === 'string' ? args.date.trim() : ''
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { text: 'date 必须是 yyyy-MM-dd。' }

        const entries = readEntries(cwd).filter((entry) => entry.time.startsWith(date))
        if (entries.length === 0) return { text: `${date} 台账里没有记录。` }

        const answer = await searchDay(ctx, exec?.agent, query, date, entries)
        return { text: answer }
      },
    })

  ctx.tools.register({
      name: 'ledger_show',
      description:
        '按引用展开一条台账：返回主席原话全文，以及当时那个问题的完整原文与选项。' +
        '引用取 ledger_search 返回的「日期 时间 · id 前缀」，例如 `2026-11-18 16:05 · 4f2a1b3c` 或旧的 `#947`。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: {
            type: 'string',
            description: '台账引用：`日期 时间 · id前缀`、裸 id 前缀（至少 6 位）、或不稳定的 `#序号`。',
          },
        },
        required: ['ref'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string') return { text: '台账不可用：当前会话没有工作目录。' }
        const raw = typeof args?.ref === 'string' ? args.ref.trim() : ''
        if (raw === '') return { text: 'ledger_show 需要一个 ref。' }
        const entries = readEntries(cwd)
        const entry = resolveRef(entries, raw)
        if (entry === undefined) return { text: `台账里没有匹配「${raw}」的条目。` }
        const out = [`主席 ${entry.time.slice(0, 16).replace('T', ' ')}：`, entry.text]
        out.push('', `稳定引用：${entry.time.slice(0, 16).replace('T', ' ')} · ${String(entry.id).slice(0, 8)}`)
        return { text: out.join('\n') }
      },
    })
}

export { apply, name }
