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
export const inject = ['tools', 'llm']

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

/**
 * Channel wrappers are user messages too, but they are the notice the message
 * channel generated, not the chairman's words: `[消息通道] … 附件 …`. When the
 * notice inlined a MAIN block the quote is inside it; when it only listed paths
 * there is no quote at all, and recording the wrapper would poison every later
 * citation.
 *
 * @param text - raw message text.
 * @returns the chairman's words, or null when the message carries none.
 */
function unwrapChannelNotice(text) {
  if (!text.startsWith('[消息通道]')) return text
  // v2 notice: a MAIN block whose body sits between --- fences.
  const fenced = /\n---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (fenced !== null && fenced[1].trim() !== '') return fenced[1].trim()
  // v1 notice: paths only, nothing the chairman actually said.
  return null
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

  /**
   * One-shot retrieval: the whole day's quotes plus the question go to a fresh
   * model call, so the answer comes from a clean context instead of leaning on
   * substring luck. The caller's own session stays untouched.
   *
   * @param ctx - Cordis context carrying the LLM service.
   * @param agent - the calling agent, used only for its routed provider/model.
   * @returns the model's ranked answer, or a readable failure.
   */
  async function searchDay(ctx, agent, query, date, entries) {
    const header = agent?.session?.requestHeader?.()
    const route = header?.config ?? {}
    if (typeof route.provider !== 'string' || typeof route.model !== 'string') {
      return '检索失败：拿不到当前会话的模型路由。'
    }

    // A day can hold a long dictation or two; keep the prompt bounded without
    // dropping whole entries.
    const BUDGET = 60_000
    let used = 0
    const lines = []
    for (const entry of entries) {
      const body = entry.text.length <= 1200 ? entry.text : `${entry.text.slice(0, 1200)}…`
      const line = `#${entry.n} ${entry.time.slice(11, 16)} 「${body}」`
      if (used + line.length > BUDGET) break
      used += line.length
      lines.push(line)
    }

    const system =
      '你是检索器，只做一件事：在用户（主席）当天说过的原话里，找出与检索问题相关的条目。\n' +
      '规则：\n' +
      '1. 只输出条目序号和理由，每条一行，形如 `#18 — 理由：……`；最多 5 条，按相关度从高到低。\n' +
      '2. 理由要具体：指出这条原话里哪个说法回答了问题，或与问题冲突在哪里。\n' +
      '3. 一条都不相关就只输出 `没有`，不要编造序号。\n' +
      '4. 不确定的条目不要列。宁可少列。'

    const user =
      `检索问题：\n${query}\n\n` +
      `${date} 主席原话共 ${entries.length} 条${lines.length < entries.length ? `（因长度只送前 ${lines.length} 条）` : ''}：\n` +
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
      // `ctx.llm.stream()` yields raw StreamChunk values (not the packed
      // AssistantStreamRecord the accumulator produces), so the deltas are read
      // directly.
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
        if (Array.isArray(entry.asks) && entry.asks.length > 0) {
          const ids = entry.asks.map((ask) => ask.id).filter((id) => typeof id === 'string')
          const full = ids.length > 0 ? textsById(entry.sid, ids) : new Map()
          out.push('', '当时在问：')
          entry.asks.forEach((ask, index) => {
            const body = full.get(ask.id)
            out.push(`${index + 1}. ${body ?? `${ask.first}（原文已不可读，仅存首行）`}`)
          })
        }
        out.push('', `稳定引用：${entry.time.slice(0, 16).replace('T', ' ')} · ${String(entry.id).slice(0, 8)}`)
        return { text: out.join('\n') }
      },
    })
}

export { apply, name }
