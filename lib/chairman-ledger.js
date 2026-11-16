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
 *   asks   assistant messages between the previous user message and this one
 *          that look like questions: only an id and a first line (pointers,
 *          because assistant traffic is large)
 *   sid    the session id, so the full context can be resolved on demand
 *
 * Scope: mounted by the agent preset, so only BETA sessions record. Subagent
 * sessions are skipped: their user messages are dispatch briefs, not rulings.
 *
 * @module dsh-beta-battle-mode/lib/chairman-ledger
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** Cordis plugin name. */
const name = 'chairman-ledger'

/** Mounted row needs the tool registry. */
export const inject = ['tools']

/** Ledger directory relative to the workspace root. */
const LEDGER_DIR = join('.local', '主席原文')

/**
 * A line that looks like an option the chairman can answer with a number or a
 * letter: `1. 维持现状`, `A 让 UI 显示真实结果`, `（乙）照收`.
 */
const OPTION_LINE = /^\s*(?:[-*]\s*)?[(（]?([1-9]|[A-Za-z]|[一二三四五六七八九十]|[甲乙丙丁])[)）.．、:：\s]\s*(\S.{0,60})$/

/**
 * Whether one assistant message is a question worth remembering.
 *
 * Requires a question mark or an option block: a bare keyword list matched too
 * much prose (`是否命中`, `给你定论`), which crowded real questions out of the
 * three-slot window.
 */
function looksLikeAsk(text) {
  if (/[？?]/.test(text)) return true
  return optionsOf(text).length >= 2
}

/** Options parsed from an assistant message, in order, deduplicated by key. */
function optionsOf(text) {
  const seen = new Set()
  const options = []
  for (const line of text.split('\n')) {
    const match = OPTION_LINE.exec(line)
    if (match === null) continue
    const key = match[1]
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ key, text: match[2].trim().replace(/[。；;]$/, '').slice(0, 40) })
    if (options.length >= 6) break
  }
  return options
}

/**
 * Whether a chairman message is answering a pending question rather than
 * raising a new topic. Only answers are labelled: a long new instruction that
 * merely happens to follow a question must stay unlabelled.
 */
function looksLikeAnswer(text) {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 40) return false
  if (/^[\d\s、,，.．;；\/A-Za-z甲乙丙丁一二三四五六七八九十]+$/.test(trimmed)) return true
  return /^(同意|可以|行|好|对|是的?|否|不要|要|不改|改|都行|随便|按你说的|按上次|按这个|就这个|没问题)/.test(trimmed)
}

/** Flatten a message's text parts. */
function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/** First non-empty line, clipped. */
function firstLine(text, max = 60) {
  const line = text.split('\n').find((row) => row.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** Assistant turns are stored as `model` in this harness; accept both spellings. */
function isAssistantMessage(message) {
  return message?.role === 'assistant' || message?.role === 'model'
}

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

/** Resolve a session log file by session id. */
function sessionLogOf(sid) {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  const bare = String(sid).replace(/^session-/, '')
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace, `session-${bare}`)
    const file = join(dir, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return undefined
}

/** Read assistant texts by message id from one session log. */
function textsById(sid, ids) {
  const file = sessionLogOf(sid)
  if (file === undefined) return new Map()
  let raw
  try {
    raw = execFileSync('zstd', ['-dc', '--', file], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch {
    return new Map()
  }
  const wanted = new Set(ids)
  const found = new Map()
  for (const line of raw.split('\n')) {
    if (line === '' || !line.includes('assistant/message')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'assistant/message') continue
    const message = event.data?.message ?? event.data
    if (message?.id === undefined || !wanted.has(message.id)) continue
    found.set(message.id, textOf(message))
  }
  return found
}

/** Parse a `since` window such as `3d`, `12h`, or an ISO date. */
function parseSince(since) {
  if (since === undefined) return Date.now() - 2 * 86_400_000
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
      const text = textOf(message)
      // Questions are harvested from the turn that just ended; only an
      // answer-shaped reply consumes them.
      harvestAsks(agent, sid, message.id)
      appendEntry(header.cwd, {
        time: localStamp(),
        sid,
        id: message.id,
        text,
        asks: takeAsks(sid, text),
      })
      seen.add(message.id)
    }
  }

  /**
   * Question queue per session: asks accumulate across chairman messages until
   * one of them is answered, so a question asked before topic A can still be
   * attached to the answer that arrives after topic B.
   *
   * Bounded to the newest five and to a day, so a stale question does not get
   * glued onto an unrelated short reply hours later.
   */
  const pendingAsks = new Map()

  const ASK_TTL_MS = 24 * 60 * 60 * 1000
  const ASK_QUEUE_MAX = 5
  const ASK_ATTACH_MAX = 3

  function pendingOf(sid) {
    const queue = pendingAsks.get(sid) ?? []
    const fresh = queue.filter((entry) => Date.now() - entry.at < ASK_TTL_MS)
    pendingAsks.set(sid, fresh)
    return fresh
  }

  /** Remember questions seen in the newest assistant stretch, newest last. */
  function harvestAsks(agent, sid, messageId) {
    let history
    try {
      history = typeof agent?.session?.deriveMessages === 'function' ? agent.session.deriveMessages() : []
    } catch {
      return
    }
    if (!Array.isArray(history) || history.length === 0) return

    let anchor = history.findIndex((item) => item?.id === messageId)
    if (anchor < 0) anchor = history.length

    const queue = pendingOf(sid)
    const known = new Set(queue.map((entry) => entry.id))
    const fresh = []
    for (let i = anchor - 1; i >= 0; i--) {
      const item = history[i]
      if (isChairmanMessage(item)) break
      if (!isAssistantMessage(item) || item.id === undefined || known.has(item.id)) continue
      const text = textOf(item)
      if (text === '' || !looksLikeAsk(text)) continue
      fresh.unshift({
        id: item.id,
        first: firstLine(text),
        options: optionsOf(text),
        at: Date.now(),
      })
    }
    if (fresh.length === 0) return
    pendingAsks.set(sid, [...queue, ...fresh].slice(-ASK_QUEUE_MAX))
  }

  /** Answers to attach to one chairman message, consuming the queue on a reply. */
  function takeAsks(sid, text) {
    const queue = pendingOf(sid)
    if (queue.length === 0) return []
    if (!looksLikeAnswer(text)) return []
    pendingAsks.set(sid, [])
    return queue.slice(-ASK_ATTACH_MAX).map((entry) => ({
      id: entry.id,
      first: entry.first,
      ...(entry.options.length > 0 ? { options: entry.options } : {}),
    }))
  }

  ctx.tools.register({
      name: 'ledger_list',
      description:
        '列出主席在最近一段时间内的原话（台账，按时间正序）。做决定之前先查：这个议题是否已有裁决、是否互相冲突。' +
        '返回每行形如 `#序号 时间 「原话首行」 ← 当时问你的 N 个问题`；序号用于 ledger_show。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          since: { type: 'string', description: '时间窗，如 `3d`、`12h` 或 `2026-11-13T00:00:00+08:00`；默认 2d。' },
          grep: { type: 'string', description: '可选：只列出原话中包含该子串的条目。' },
          limit: { type: 'number', description: '可选：最多返回条数（从最新往前数，默认 40）。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'integer' },
            text: { type: 'string' },
          },
          required: ['total', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string') return { total: 0, text: '台账不可用：当前会话没有工作目录。' }
        const from = parseSince(args?.since)
        const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.floor(args.limit) : 40
        const needle = typeof args?.grep === 'string' && args.grep !== '' ? args.grep : undefined
        const all = readEntries(cwd).filter((entry) => Date.parse(entry.time) >= from)
        const hits = needle === undefined ? all : all.filter((entry) => entry.text.includes(needle))
        const shown = hits.slice(-limit)
        const lines = shown.map((entry) => {
          const asks = entry.asks?.length ? ` ← 当时问你的 ${entry.asks.length} 个问题` : ''
          return `#${entry.n} ${entry.time.slice(5, 16).replace('T', ' ')} 「${firstLine(entry.text, 48)}」${asks}`
        })
        return {
          total: hits.length,
          text: lines.length === 0 ? '台账里这个时间窗没有条目。' : lines.join('\n'),
        }
      },
  })

  ctx.tools.register({
      name: 'ledger_show',
      description:
        '按序号展开台账条目：返回主席原话全文，以及当时问你（或你问主席）的那些问题的完整原文。' +
        '协商裁决冲突、或核对交付是否偏离原意时用它取上下文。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n: { type: 'number', description: 'ledger_list 返回的序号（#后面的数字）。' },
        },
        required: ['n'],
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
        const n = Math.floor(Number(args?.n))
        const entry = readEntries(cwd).find((item) => item.n === n)
        if (entry === undefined) return { text: `台账里没有 #${n}。` }
        const out = [`主席 ${entry.time.slice(0, 16).replace('T', ' ')}：`, entry.text]
        if (Array.isArray(entry.asks) && entry.asks.length > 0) {
          const ids = entry.asks.map((ask) => ask.id).filter((id) => typeof id === 'string')
          const full = ids.length > 0 ? textsById(entry.sid, ids) : new Map()
          out.push('', '当时在问：')
          entry.asks.forEach((ask, index) => {
            const body = full.get(ask.id)
            out.push(`${index + 1}. ${body ?? `${ask.first}（原文已不可读，仅存首行）`}`)
          })
        }
        out.push('', `会话：session-${String(entry.sid).replace(/^session-/, '')}`)
        return { text: out.join('\n') }
      },
  })
}

export { apply, name }
