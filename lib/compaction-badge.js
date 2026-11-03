/**
 * BADGE work-log compaction backend.
 *
 * A subclass of the shipped `@deepseek-ai/dsh-compaction-basic` engine that
 * replaces the summarization call with a filesystem checkpoint. All
 * `@deepseek-ai/*` dependencies are loaded from the running host installation
 * (located from `process.argv[1]`) and validated before the class is defined; a
 * profile-local copy is only a warned fallback, never the intended source.
 *
 * Only the steps where the shipped policy is opinionated are overridden:
 *
 * 1. `summarize()` — never sends a model request. The checkpoint body is the
 *    current BADGE work log (`.local/work_log_current.md`), optionally followed
 *    by the agent-written history digest (`.local/work_log_digest.md`) and by a
 *    rendered transcript of the last real user turn. Every optional source is
 *    skipped when absent, so compaction cannot fail because of them. A missing
 *    or empty current work log is still a hard error — the checkpoint IS the
 *    log, so silently landing an empty one would drop context.
 *
 * 2. `compactIfNeeded()` — pressure is decided at turn end, not at a pre-step:
 *    this hook is inert for pressure (context overflow and subagents still
 *    delegate to the shipped engine). On every genuine `idle` transition the
 *    engine either arms one independent follow-up turn, "update the work log and
 *    the history digest per the BADGE constitution", when the routed model is
 *    at the threshold, or compacts the file on disk when that refresh turn just
 *    ended. The `idle`
 *    check is re-validated one microtask later because the driver may hand off
 *    to replacement work synchronously. The refresh is never retried; a refresh
 *    turn that never ends is cleared by a 15-minute survival timer and
 *    compacted anyway. The file's stat identity is only a warning signal, never
 *    a release condition. Once compaction leaves the surface above the
 *    threshold, the existing same-user-input `suppressed` back-off keeps it
 *    quiet until the next real user input.
 *
 * 3. `triggerTokens` — an optional absolute pressure line that decouples the
 *    policy threshold from the physical window. When set, it is used verbatim;
 *    otherwise the shipped `resolveCompactSpec` formula is reproduced.
 *
 * 4. `compactNow()` — manual `/compact` refreshes the log first: it queues the
 *    same refresh message as its own follow-up turn, waits for that turn to
 *    settle (bounded), then runs the shipped manual transaction. The command
 *    therefore reports the real shadowed range, with the refreshed file as the
 *    checkpoint. A failed or timed-out refresh still compacts the log currently
 *    on disk; only an aborted command cancels the operation.
 *
 * 5. `.local/work_log_digest.md` — written by the refresh turn itself: it
 *    reads the history archive with read/grep and distills it. Compaction only
 *    reads the file, so the compaction path performs no model call. An
 *    over-long digest is cut at a `## ` boundary from the front and marked, so
 *    the checkpoint stays bounded.
 *
 * The compaction itself is always the shipped transaction: checkpoint framing,
 * range selection, the tool-pairing-safe cut, and the durable session flush are
 * inherited — this engine does not implement its own shadow. After a refresh
 * turn has closed there is no open turn, so the pressure (open-turn) transaction
 * cannot run; the idle-session transaction is the shipped `compactNow`, which
 * claims `runMaintenance` and supplies the maintenance signal.
 *
 * Subagent sessions keep the shipped LLM summarizer: they do one task, keep
 * their own station log, and must not read the commander's project work log.
 *
 * @module @deepseek-ai/dsh-compaction-badge
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

//#region host modules

/**
 * Locate the running DSH installation.
 *
 * The profile can carry its own (older) copies of the @deepseek-ai packages.
 * Subclassing those while the host service comes from the running installation
 * mixes versions, so the entry module is resolved and its tree is walked up
 * until the `@deepseek-ai/dsh` manifest is found.
 *
 * @returns {{ root: string, version: string } | undefined}
 */
function findHostRoot() {
  const entry = process.argv[1]
  if (entry === undefined) return undefined
  let directory
  try {
    directory = dirname(realpathSync(entry))
  } catch {
    return undefined
  }
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const metadata = JSON.parse(readFileSync(manifest, 'utf-8'))
        if (metadata.name === '@deepseek-ai/dsh') {
          return {
            root: directory,
            version: typeof metadata.version === 'string' ? metadata.version : 'unknown',
          }
        }
      } catch {
        // Unreadable/invalid manifest: keep walking up.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Nearest `package.json` for a resolved module file.
 * @param {string} fileUrl - file URL of the resolved module.
 * @returns {{ root: string, version: string }}
 */
function nearestPackage(fileUrl) {
  let directory
  try {
    directory = dirname(fileURLToPath(fileUrl))
  } catch {
    return { root: '(normal resolution)', version: 'unknown' }
  }
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const metadata = JSON.parse(readFileSync(manifest, 'utf-8'))
        return {
          root: directory,
          version: typeof metadata.version === 'string' ? metadata.version : 'unknown',
        }
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return { root: directory, version: 'unknown' }
    directory = parent
  }
}

const host = findHostRoot()
const hostModules = new Map()
const hostModuleMetadata = new Map()
let hostFallbackWarned = false

/**
 * Load one dependency from the host installation, falling back to ordinary
 * resolution (with one warning) when the host cannot be found or resolved.
 *
 * @param {string} name - bare package specifier.
 * @returns {Promise<Record<string, unknown>>} the module namespace.
 */
async function hostModule(name) {
  const cached = hostModules.get(name)
  if (cached !== undefined) return cached
  let loaded
  let metadata
  if (host !== undefined) {
    try {
      const requireFromHost = createRequire(join(host.root, 'package.json'))
      const file = requireFromHost.resolve(name)
      loaded = await import(pathToFileURL(file).href)
      metadata = { ...nearestPackage(pathToFileURL(file).href), source: 'host' }
    } catch {
      loaded = undefined
    }
  }
  if (loaded === undefined) {
    if (!hostFallbackWarned) {
      hostFallbackWarned = true
      console.warn(
        `badge compaction: 未能定位宿主安装（process.argv[1]=${String(process.argv[1])}），退回普通解析；加载到的版本可能与宿主不一致。`
      )
    }
    loaded = await import(name)
    try {
      metadata = { ...nearestPackage(import.meta.resolve(name)), source: 'fallback' }
    } catch {
      metadata = { root: '(normal resolution)', version: 'unknown', source: 'fallback' }
    }
  }
  hostModules.set(name, loaded)
  hostModuleMetadata.set(name, metadata)
  return loaded
}

const { BasicCompactionEngine } = await hostModule('@deepseek-ai/dsh-compaction-basic')
const { ManualCompactionError } = await hostModule('@deepseek-ai/dsh-compaction')
const { createUserMessage } = await hostModule('@deepseek-ai/dsh-llm')
const z = (await hostModule('@deepseek-ai/schemastery')).default
const Base = BasicCompactionEngine
const baseMetadata = hostModuleMetadata.get('@deepseek-ai/dsh-compaction-basic')

// Fail before the class definition if the host does not expose the API this
// plugin subclasses. A raw "not a constructor" or missing-method TypeError would
// otherwise point at an arbitrary line with no upgrade path.
if (typeof Base !== 'function') {
  throw new Error(
    'badge compaction: 无法从宿主加载 BasicCompactionEngine（package: @deepseek-ai/dsh-compaction-basic）'
  )
}
const REQUIRED_BASE_METHODS = ['compactIfNeeded', 'compactNow', 'summarize', 'regionDependencies']
const missingBaseMethods = REQUIRED_BASE_METHODS.filter(
  (method) => typeof Base.prototype?.[method] !== 'function'
)
if (missingBaseMethods.length > 0) {
  throw new Error(
    `badge compaction: 无法初始化：@deepseek-ai/dsh-compaction-basic ${baseMetadata?.version ?? 'unknown'} 缺少必需方法 ${missingBaseMethods.join(', ')}；当前宿主 @deepseek-ai/dsh ${host?.version ?? 'unknown'} 与该 DSH 版本不兼容，请升级/降级插件（要求 dsh >=0.2.0 <0.3.0）。`
  )
}
console.info(
  `badge compaction: host @deepseek-ai/dsh ${host?.version ?? 'unknown'}, base @deepseek-ai/dsh-compaction-basic ${baseMetadata?.version ?? 'unknown'}, resolved from ${host?.root ?? baseMetadata?.root ?? '(normal resolution)'}`
)

//#endregion

//#region constants

/** Tags wrapping the work-log checkpoint inside the durable framing. */
const WORKLOG_OPEN_TAG = '<compacted-worklog>'
const WORKLOG_CLOSE_TAG = '</compacted-worklog>'

/** Work log files written by the agent's file tools, relative to the cwd. */
const WORKLOG_DIRECTORY = '.local'
const WORKLOG_FILE = 'work_log_current.md'
const WORKLOG_DIGEST_FILE = 'work_log_digest.md'

/** Hard character cap of the agent-written history digest in the checkpoint. */
const DIGEST_MAX_CHARS = 30000

/** Line appended when the digest is cut, naming the untouched source file. */
const DIGEST_TRUNCATION_NOTE =
  '（历史要点超过 30,000 字符，已截断；完整内容见 .local/work_log_digest.md）'

/**
 * Last-resort headroom when a host predates `headroomTokens`. It is reached only
 * when neither the resolved policy nor the base config exposes the key; the
 * first such use is warned about.
 */
const DEFAULT_HEADROOM_TOKENS = 65536

/** Characters kept from one tool result inside the recent-turn transcript. */
const TOOL_RESULT_MAX_CHARS = 600

/** Characters kept from one tool-call argument string. */
const TOOL_ARGUMENT_MAX_CHARS = 300

/** Hard cap for the whole recent-turn transcript. */
const RECENT_TURN_MAX_CHARS = 6000

/** Message source kind of this engine's own work-log refresh request. */
const WORKLOG_SOURCE_KIND = 'badge-worklog'

/**
 * Survival bound for one refresh turn, shared by the automatic and manual
 * paths. The wait is event-driven; this only keeps a refresh that is never
 * consumed (or a driver that never settles) from pinning the trigger forever.
 * On expiry the compaction reads the work log currently on disk.
 */
const REFRESH_TURN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * User message that asks the model to refresh the work log one step before the
 * checkpoint is taken. It is a normal durable user message: the model answers
 * it with its existing file tools, and the next step compacts.
 */
const WORKLOG_UPDATE_INSTRUCTION = [
  '【压缩前检查】当前上下文已到达压缩阈值。压缩将直接读取工作日志作为 checkpoint，',
  '不再另外调用模型做摘要。请完成两件事：',
  '',
  '1. 更新工作日志：该更新 `.local/work_log_current.md` 就更新它，',
  '   该把新事件归档进 `.local/work_log_history.md` 就归档（以项目自己的日志约定为准）。',
  '',
  '2. 用 read/grep 按需分段查阅 `.local/work_log_history.md`（可能很长，不要整份读入），',
  '   把「历史要点」写入 `.local/work_log_digest.md`：',
  '   - 近期办过的事（按日期一行一条）；',
  '   - 所有与当前任务相关的决策、仍然有效的约束与口径、踩过的坑、未完成事项、',
  '     关键路径与 ID；',
  '   - 保留原始日期与标识符，不要推测、不要润色，拿不准就保留；',
  '   - 总长不超过 10,000 字；只写这个文件。',
  '',
  '完成后继续当前任务。',
].join('\n')

//#endregion

//#region helpers

/**
 * The exact provider/model durably routed for the latest request.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string } | undefined}
 */
function routedTargetOf(agent) {
  const config = agent.session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Whether this session is a subagent child (executor, reviewer, recon) rather
 * than a top-level commander session.
 *
 * Subagents keep their own station log (`.local/hb-workspace/<stamp>/<station>/`)
 * and the project-level work log belongs to the commander alone, so this
 * engine steps aside for them entirely and lets the shipped engine summarize.
 *
 * `origin === 'subagent'` is the header's documented subagent classification and
 * `delegationDepth > 0` is the persisted recursion depth; either alone suffices.
 * `parentSession` is deliberately NOT used: it records fork lineage, so a
 * top-level forked session carries it too.
 *
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {boolean}
 */
function isSubagentSession(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && depth > 0
}

/**
 * Seq of the newest genuine user input, or the cached value when none is newer.
 *
 * `user/message` events are also produced by this plugin's own refresh request,
 * by the compaction checkpoint, and by automatic goal rounds. Only a real user
 * prompt (`source.kind === 'user'`) clears the deferred-trigger guard. User
 * messages are logged before their turn runs, so the cached value is current at
 * an idle transition.
 *
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @param {number} cached - previously found seq; only newer events are scanned.
 * @returns {number}
 */
function latestUserInputSeq(session, cached) {
  for (let seq = session.seq - 1; seq > cached; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    if (event.data.source?.kind === 'user') return seq
  }
  return cached
}

/**
 * Stat-only identity of the work log. `mtimeMs` plus `size` is enough to detect
 * a rewrite; hashing the content would read a potentially large file on every
 * step for no extra safety.
 *
 * @param {string} path
 * @returns {{ mtimeMs: number, size: number } | undefined} identity, or undefined when absent.
 */
function statWorkLog(path) {
  try {
    const stats = statSync(path)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

/**
 * Whether the work log changed between two stat identities.
 *
 * An absent file counts as unchanged unless it appeared or disappeared: a real
 * refresh rewrites the file (mtime/size change) and a deletion is not a refresh.
 *
 * @param {{ mtimeMs: number, size: number } | undefined} previous
 * @param {{ mtimeMs: number, size: number } | undefined} current
 * @returns {boolean}
 */
function workLogChanged(previous, current) {
  if (previous === undefined) return current !== undefined
  if (current === undefined) return false
  return previous.mtimeMs !== current.mtimeMs || previous.size !== current.size
}

/**
 * Keep the leading part of an over-long digest, cutting at a `## ` boundary.
 *
 * The refresh turn writes the digest newest-first, so the leading sections are
 * the most relevant. Cut at the last heading at or before the character budget
 * so no section is split, then append one marked note naming the full file.
 * When the only heading is the first byte, cutting there would discard
 * everything, so the text is hard-cut at the budget instead.
 *
 * @param {string} text - trimmed digest text, longer than the cap.
 * @param {number} max - hard cap for the returned text, note included.
 * @returns {string}
 */
function truncateDigest(text, max) {
  const note = `\n\n${DIGEST_TRUNCATION_NOTE}`
  const budget = max - note.length
  const heading = /^## /gm
  let cut = -1
  let match
  while ((match = heading.exec(text)) !== null) {
    if (match.index > budget) break
    cut = match.index
  }
  const kept = cut > 0 ? text.slice(0, cut).trimEnd() : text.slice(0, budget).trimEnd()
  return `${kept}${note}`
}

/**
 * Trim one rendered block to a hard character cap, keeping an ellipsis.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateText(text, max) {
  const normalized = String(text).replace(/\r\n/g, '\n').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1).trimEnd()}…`
}

/**
 * Render one message's visible text, with placeholders for attachments.
 * Reasoning is omitted: it is not part of the conversation transcript.
 * @param {readonly import('@deepseek-ai/dsh-llm').ContentBlock[]} content
 * @returns {string}
 */
function messageText(content) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') {
      const text = block.text.trim()
      if (text.length > 0) parts.push(text)
    } else if (block.type === 'image') {
      parts.push('[图片]')
    } else if (block.type === 'file') {
      parts.push('[文件]')
    }
  }
  return parts.join('\n')
}

//#endregion

//#region main class

/**
 * Work-log-checkpoint compaction engine.
 *
 * Overrides the trigger, the refresh turn, and the summary of the shipped
 * engine; the durable transaction, the checkpoint framing, and the surface
 * selection stay inherited. Both overrides apply to commander sessions only: a
 * subagent child delegates straight to the shipped engine.
 */
export class BadgeCompactionEngine extends Base {
  /**
   * The shipped compaction config plus this engine's absolute pressure line.
   *
   * `triggerTokens` is a positive integer token count. Rebuilding from
   * `BasicCompactionEngine.Config.dict` keeps every shipped key (and any key a
   * later upstream version adds) while letting the loader reject an invalid
   * value before the plugin starts.
   */
  static Config = z.object({
    ...BasicCompactionEngine.Config.dict,
    triggerTokens: z.number().step(1).min(1),
  })

  /**
   * @param {object} ctx - plugin context with the injected services.
   * @param {object} [config] - loader config, possibly carrying `triggerTokens`.
   */
  constructor(ctx, config = {}) {
    // `triggerTokens` is this plugin's own key. The shipped resolver rejects
    // unknown keys, so it is taken out before the base constructor sees it.
    const { triggerTokens, ...baseConfig } = config ?? {}
    super(ctx, baseConfig)
    if (triggerTokens !== undefined) {
      if (
        typeof triggerTokens !== 'number' ||
        !Number.isInteger(triggerTokens) ||
        triggerTokens <= 0
      ) {
        throw new Error(
          `BadgeCompactionConfig: triggerTokens (${String(triggerTokens)}) must be a positive integer`
        )
      }
    }
    /** Configured absolute pressure line, or `undefined` for the shipped formula. */
    this.triggerTokens = triggerTokens
    /**
     * The pristine resolved config. `compactIfNeeded()` passes a temporary
     * retention/threshold override through `this.config`, so anything that must
     * see the user's own settings reads this.
     */
    this.baseConfig = this.config
    /** Per-agent refresh/trigger guard state. */
    this.worklogStates = new WeakMap()
    /** Whether the missing-headroom fallback warning already fired. */
    this.headroomWarned = false
    /** Survival bound for one automatic refresh turn (overridable in tests). */
    this.autoRefreshTimeoutMs = REFRESH_TURN_TIMEOUT_MS
    /** Survival bound for one manual refresh turn (overridable in tests). */
    this.manualRefreshTimeoutMs = REFRESH_TURN_TIMEOUT_MS
    if (this.config.auto) this._registerIdleTrigger()
  }

  /**
   * Return the refresh/trigger guard state of one agent.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @returns {{ refreshing: boolean, manualRefresh: boolean, suppressed: boolean, suppressedAtUserSeq: number, thresholdTokens: number | undefined, lastUserInputSeq: number, refreshBaseline: { mtimeMs: number, size: number } | undefined, refreshPath: string | undefined, refreshStartedAt: number | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined }}
   */
  worklogState(agent) {
    let state = this.worklogStates.get(agent)
    if (state === undefined) {
      state = {
        refreshing: false,
        manualRefresh: false,
        suppressed: false,
        suppressedAtUserSeq: -1,
        thresholdTokens: undefined,
        lastUserInputSeq: -1,
        refreshBaseline: undefined,
        refreshPath: undefined,
        refreshStartedAt: undefined,
        refreshTimer: undefined,
      }
      this.worklogStates.set(agent, state)
    }
    return state
  }

  /**
   * Current genuine user-input seq, reusing the cached one when nothing newer
   * was appended. User messages are logged before their turn runs, so the cached
   * value is current at an idle transition.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {object} state - the agent's trigger state.
   * @returns {number}
   */
  userInputSeq(agent, state) {
    state.lastUserInputSeq = latestUserInputSeq(agent.session, state.lastUserInputSeq)
    return state.lastUserInputSeq
  }

  /**
   * The exact per-model policy for a target, when one was configured.
   * @param {{ provider: string, model: string }} target
   * @returns {object | undefined}
   */
  targetPolicy(target) {
    return this.baseConfig.modelPolicies.find(
      (policy) => policy.provider === target.provider && policy.model === target.model
    )
  }

  /**
   * Pressure threshold for the routed target, using the configured absolute
   * line when present and otherwise the shipped `resolveCompactSpec` formula:
   *
   *   messageBudget    = contextWindow - reservedCompletionTokens
   *   pressureBudget   = messageBudget - headroomTokens
   *   thresholdTokens  = floor(min(contextWindow * thresholdRatio, pressureBudget))
   *
   * `resolveCompactSpec` lives in the shipped module's private region and is not
   * exported, so the formula is reproduced here; `thresholdRatio` is the
   * per-model override when configured, exactly as `resolveTargetPolicy` picks it.
   *
   * A `null` result means the decision must be delegated to the shipped engine,
   * which either returns `null` (no routed target) or raises its own actionable
   * configuration error (no context capacity).
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ target: { provider: string, model: string }, thresholdTokens: number, thresholdRatio: number } | null>}
   */
  async pressureSpec(agent, signal) {
    const target = routedTargetOf(agent)
    if (target === undefined) return null
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return null

    const policy = this.targetPolicy(target)
    const thresholdRatio = policy?.thresholdRatio ?? this.baseConfig.thresholdRatio
    const configuredHeadroom = policy?.headroomTokens ?? this.baseConfig.headroomTokens
    if (configuredHeadroom === undefined && !this.headroomWarned) {
      this.headroomWarned = true
      this.ctx.logger.warn(
        'badge compaction: this host does not expose headroomTokens; falling back to 65536 for the pressure threshold'
      )
    }
    const headroomTokens = configuredHeadroom ?? DEFAULT_HEADROOM_TOKENS
    const reserved = agent.session.requestHeader()?.config.maxTokens ?? info.defaultMaxTokens ?? 0
    const messageBudget = contextWindow - reserved
    if (messageBudget <= 0) return null
    const pressureBudget = messageBudget - headroomTokens
    if (pressureBudget <= 0) return null

    if (this.triggerTokens !== undefined) {
      return {
        target,
        thresholdTokens: this.triggerTokens,
        // The shipped engine derives its own threshold from the window, so the
        // temporary config carries the ratio that reproduces the absolute line.
        thresholdRatio: Math.min(1, this.triggerTokens / contextWindow),
      }
    }
    return {
      target,
      thresholdTokens: Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudget)),
      thresholdRatio,
    }
  }

  /**
   * Pressure is decided at turn end, not at a pre-step.
   *
   * The shipped automatic listener still calls this hook before every step; for
   * pressure it deliberately does nothing, so no token is measured, no message
   * is injected, and no compaction starts inside a turn. Context overflow keeps
   * the shipped emergency behavior, and subagent sessions keep the shipped LLM
   * summarizer.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {"pressure" | "context-overflow"} trigger
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('@deepseek-ai/dsh-compaction-basic').CompactionResult | null>}
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (isSubagentSession(agent)) return super.compactIfNeeded(agent, trigger, signal)
    if (trigger !== 'pressure') return super.compactIfNeeded(agent, trigger, signal)
    return null
  }

  /**
   * Compact one session using the work log as the checkpoint.
   *
   * Both the automatic path (after its refresh turn) and the manual path (after
   * the command's refresh turn) call this with no open turn. The shipped
   * pressure transaction cannot be used there: `compactSurfaceRegion` with
   * `owner: 'current-turn'` rejects the call with "no open turn" once a turn has
   * closed. The valid idle-session transaction is the shipped `compactNow`,
   * which claims `agent.runMaintenance` itself, combines the maintenance signal
   * with the caller signal (`AbortSignal.any`), enforces selected-span
   * stability, and flushes the session before returning the real
   * `CompactionResult`.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} [signal]
   * @param {import('@deepseek-ai/dsh-commands').CommandId} [sourceCommandId]
   * @returns {Promise<import('@deepseek-ai/dsh-compaction').CompactionResult | null>}
   */
  compactWithCheckpoint(agent, signal, sourceCommandId) {
    return super.compactNow(agent, signal ?? new AbortController().signal, sourceCommandId)
  }

  /**
   * Refuse to trigger again while the post-compaction surface is still above the
   * threshold; the guard is cleared by the next genuine user input.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {object} state - the agent's trigger state.
   */
  deferUntilNextUserInput(agent, state) {
    if (state.thresholdTokens === undefined) return
    const total = this.ctx.tokenMeter.measure(agent.session).totalTokens
    if (total < state.thresholdTokens) return
    state.suppressed = true
    state.suppressedAtUserSeq = this.userInputSeq(agent, state)
    this.ctx.logger.warn(
      `badge compaction: still ~${total} estimated tokens after the work-log checkpoint (threshold ${state.thresholdTokens}); the next work-log refresh waits for new user input`
    )
  }

  /**
   * Drop the refresh snapshot bookkeeping.
   * @param {object} state - the agent's trigger state.
   */
  clearRefreshWait(state) {
    state.refreshBaseline = undefined
    state.refreshPath = undefined
    state.refreshStartedAt = undefined
  }

  /**
   * Clear the refreshing state, its survival timer, and the snapshot.
   * @param {object} state - the agent's trigger state.
   */
  clearRefreshing(state) {
    state.refreshing = false
    if (state.refreshTimer !== undefined) {
      clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
    }
    this.clearRefreshWait(state)
  }

  /**
   * Manual `/compact`: refresh the work log in its own turn, then run the
   * shipped manual transaction against the refreshed file.
   *
   * The command awaits this method and reports the real shadowed range, so the
   * compaction must happen before it returns. Ordering:
   *
   * 1. A busy agent, or one already refreshing, keeps the shipped busy failure.
   * 2. Queue the refresh message with `followup()`; a turn starts immediately.
   * 3. Wait for that turn to settle via the shared `awaitRefreshTurnEnd()`,
   *    bounded by `manualRefreshTimeoutMs` and the command's abort signal.
   * 4. Run the shipped `compactNow`, then clear every per-turn guard.
   *
   * A failed, blocked, or timed-out refresh never fails the command: it is
   * logged and the compaction reads whatever the work-log file holds on disk.
   * An aborted command cancels the whole operation instead of compacting.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} signal - command-scoped cancellation signal.
   * @param {import('@deepseek-ai/dsh-commands').CommandId} [sourceCommandId]
   * @returns {Promise<import('@deepseek-ai/dsh-compaction').CompactionResult | null>}
   */
  async compactNow(agent, signal, sourceCommandId) {
    if (isSubagentSession(agent)) return super.compactNow(agent, signal, sourceCommandId)
    signal?.throwIfAborted()
    const state = this.worklogState(agent)
    if (state.manualRefresh) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction: a work-log refresh is already in progress for this agent'
      )
    }
    // The shipped transaction claims the idle phase synchronously, so a busy
    // agent keeps the shipped busy result instead of queuing a refresh behind
    // work the command never observed.
    if (agent.status !== 'idle') return super.compactNow(agent, signal, sourceCommandId)

    // A user-initiated compaction supersedes an automatic refresh that has not
    // compacted yet; the idle trigger checks `manualRefresh` before acting.
    this.clearRefreshing(state)

    state.manualRefresh = true
    // Snapshot before the refresh turn: after it settles, an unchanged stat
    // identity proves the model never rewrote the log.
    const manualPath = this.workLogPath(agent)
    const manualBaseline = statWorkLog(manualPath)
    try {
      const refresh = await this.awaitRefreshTurnEnd(
        agent,
        signal,
        this.manualRefreshTimeoutMs,
        () => agent.followup(this.createRefreshMessage())
      )
      if (refresh.outcome === 'aborted') {
        signal?.throwIfAborted()
        throw new ManualCompactionError(
          'cancelled',
          'manual compaction cancelled during the work-log refresh'
        )
      }
      const workLogUpdated = workLogChanged(manualBaseline, statWorkLog(manualPath))
      if (refresh.outcome === 'timeout') {
        this.ctx.logger.warn(
          `badge compaction: the manual work-log refresh did not settle within ${this.manualRefreshTimeoutMs} ms (work log ${workLogUpdated ? 'was updated' : 'was not updated'}); compacting the content currently on disk`
        )
      } else if (refresh.outcome === 'completed' && refresh.reason !== undefined) {
        this.ctx.logger.warn(
          `badge compaction: the manual work-log refresh turn ended with "${refresh.reason}" (work log ${workLogUpdated ? 'was updated' : 'was not updated'}); compacting the content currently on disk`
        )
      } else if (refresh.outcome === 'completed' && !workLogUpdated) {
        this.ctx.logger.warn(
          `badge compaction: the manual work-log refresh turn finished but ${manualPath} was not updated; compacting the content currently on disk`
        )
      }
      // outcome 'failed' was already logged when the delivery failed.
      return await this.compactWithCheckpoint(agent, signal, sourceCommandId)
    } finally {
      state.manualRefresh = false
      state.suppressed = false
      state.suppressedAtUserSeq = -1
      this.clearRefreshing(state)
    }
  }

  /**
   * Register the turn-end trigger.
   *
   * Pressure is evaluated once the agent is genuinely idle: a driver may hand
   * off to replacement work synchronously after emitting `idle`, so the check is
   * deferred one microtask and re-validated before it acts.
   *
   * @private
   */
  _registerIdleTrigger() {
    this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      queueMicrotask(() => {
        if (agent.status !== 'idle') return
        void this.handleAgentIdle(agent).catch((error) => {
          this.ctx.logger.warn(
            `badge compaction: idle compaction check failed (${error instanceof Error ? error.message : String(error)}); continuing`
          )
        })
      })
    })
  }

  /**
   * One idle transition: finish a pending refresh, or start one at the
   * threshold.
   *
   * The two states are exclusive. `refreshing` means the refresh turn has been
   * queued and its end owns the compaction; otherwise this idle decides whether
   * a refresh is needed. Manual compaction and subagent sessions stay out.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   */
  async handleAgentIdle(agent) {
    if (!this.config.auto || isSubagentSession(agent)) return
    const state = this.worklogState(agent)
    if (state.manualRefresh) return
    if (state.refreshing) {
      await this.finishRefresh(agent, state)
      return
    }
    if (state.suppressed) {
      if (this.userInputSeq(agent, state) === state.suppressedAtUserSeq) return
      state.suppressed = false
    }
    const spec = await this.pressureSpec(agent)
    if (spec === null) return
    state.thresholdTokens = spec.thresholdTokens
    if (this.ctx.tokenMeter.measure(agent.session).totalTokens < spec.thresholdTokens) return
    this.startRefresh(agent, state)
  }

  /**
   * Queue the refresh turn from the genuine idle state and arm the survival
   * timer. There is no waiting task on the normal path: the next idle
   * transition completes it.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {object} state - the agent's trigger state.
   */
  startRefresh(agent, state) {
    state.refreshing = true
    state.refreshStartedAt = Date.now()
    state.refreshPath = this.workLogPath(agent)
    state.refreshBaseline = statWorkLog(state.refreshPath)
    const startedAt = state.refreshStartedAt
    state.refreshTimer = setTimeout(() => {
      void this.expireRefresh(agent, startedAt)
    }, this.autoRefreshTimeoutMs)
    try {
      agent.followup(this.createRefreshMessage())
    } catch (error) {
      this.ctx.logger.warn(
        `badge compaction: could not queue the work-log refresh (${error instanceof Error ? error.message : String(error)}); compacting the work log currently on disk`
      )
      this.clearRefreshing(state)
      void this.compactAfterRefresh(agent, state)
    }
  }

  /**
   * A refresh turn ended. Warn when the file did not change, then compact the
   * file on disk. No retry: one refresh per threshold crossing.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {object} state - the agent's trigger state.
   */
  async finishRefresh(agent, state) {
    const path = state.refreshPath ?? this.workLogPath(agent)
    if (!workLogChanged(state.refreshBaseline, statWorkLog(path))) {
      this.ctx.logger.warn(
        `badge compaction: refresh turn finished but ${path} was not updated; compacting the content currently on disk`
      )
    }
    this.clearRefreshing(state)
    await this.compactAfterRefresh(agent, state)
  }

  /**
   * Survival bound: the refresh turn never produced an idle transition (for
   * example the follow-up was never consumed). Clear the state and try to
   * compact anyway.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {number} startedAt - the refresh start this timer belongs to.
   */
  async expireRefresh(agent, startedAt) {
    const state = this.worklogState(agent)
    if (!state.refreshing || state.refreshStartedAt !== startedAt) return
    this.ctx.logger.warn(
      `badge compaction: the work-log refresh did not settle within ${this.autoRefreshTimeoutMs} ms; compacting the content currently on disk`
    )
    this.clearRefreshing(state)
    await this.compactAfterRefresh(agent, state)
  }

  /**
   * Run the transaction after a refresh (or after a failed delivery) and restore
   * the pressure guard. Failures only warn.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {object} state - the agent's trigger state.
   */
  async compactAfterRefresh(agent, state) {
    try {
      const compaction = await this.compactWithCheckpoint(agent)
      if (compaction !== null) {
        this.ctx.logger.info(
          `compaction (turn end): shadowed ${compaction.shadowedSeqs.length} surface nodes (seqs ${compaction.shadowedRange.start}-${compaction.shadowedRange.end}, ~${compaction.shadowedTokenCount} tokens)`
        )
      }
    } catch (error) {
      this.ctx.logger.warn(
        `badge compaction: compaction after the work-log refresh failed: ${error instanceof Error ? error.message : String(error)}; continuing`
      )
    }
    try {
      // Existing semantics: when the surface is still above the threshold, stay
      // quiet until the next genuine user input.
      this.deferUntilNextUserInput(agent, state)
    } catch (error) {
      this.ctx.logger.warn(
        `badge compaction: could not record the post-compaction pressure state (${error instanceof Error ? error.message : String(error)}); continuing`
      )
    }
  }

  /**
   * Build the one refresh request message shared by the automatic and manual
   * paths: same text and same `source.kind` in both.
   * @returns {import('@deepseek-ai/dsh-llm').UserMessage}
   */
  createRefreshMessage() {
    return createUserMessage({
      content: [{ type: 'text', text: WORKLOG_UPDATE_INSTRUCTION }],
      source: { kind: WORKLOG_SOURCE_KIND },
    })
  }

  /**
   * Shared refresh-turn waiter used by the automatic and manual paths.
   *
   * Listeners are attached *before* `deliver()` runs, so an idle `followup()`
   * that emits `running` synchronously cannot be missed. Completion is the
   * first `idle` status after the observed activity, re-checked one microtask
   * later because the driver may hand off to replacement work synchronously
   * after emitting `idle`; `whenIdle()` is deliberately not used because it
   * cannot identify one message's settlement. `turn/end` is a second signal,
   * used only to classify a failed/aborted turn.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} [signal] - optional external cancellation (manual command).
   * @param {number} timeoutMs - survival bound measured from this call.
   * @param {() => void} deliver - queues the refresh message after the listeners are attached.
   * @returns {Promise<{ outcome: 'completed' | 'timeout' | 'aborted' | 'failed', reason?: string }>}
   */
  awaitRefreshTurnEnd(agent, signal, timeoutMs, deliver) {
    return new Promise((resolve) => {
      let started = agent.status === 'running'
      let settled = false
      let reason
      /** @type {(() => void)[]} */
      const disposers = []
      let timer
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        for (const dispose of disposers) dispose()
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        resolve({ outcome, ...(reason === undefined ? {} : { reason }) })
      }
      const onAbort = () => finish('aborted')

      disposers.push(
        this.ctx.on('agent/status', ({ agent: target, status }) => {
          if (target !== agent) return
          if (status === 'running') {
            started = true
            return
          }
          if (!started) return
          queueMicrotask(() => {
            if (!settled && agent.status === 'idle') finish('completed')
          })
        })
      )
      disposers.push(
        this.ctx.on('session/event', (session, event) => {
          if (session !== agent.session || event.type !== 'turn/end') return
          const kind = event.data?.reason?.kind
          if (kind !== undefined && kind !== 'completed') reason = kind
        })
      )
      if (signal !== undefined) {
        if (signal.aborted) {
          finish('aborted')
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      timer = setTimeout(() => finish('timeout'), timeoutMs)

      try {
        deliver()
      } catch (error) {
        this.ctx.logger.warn(
          `badge compaction: could not queue the work-log refresh (${error instanceof Error ? error.message : String(error)}); compacting the work log currently on disk`
        )
        finish('failed')
        return
      }
      // Defensive: also covers a wake latched behind work not visible here.
      if (agent.status === 'running') started = true
    })
  }

  /**
   * Absolute path of the work log for this session.
   *
   * The work log belongs to the session's own working directory (the project
   * root), not to the directory the harness process happened to start in.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @returns {string}
   */
  sessionWorkLogPath(agent, file) {
    const sessionCwd = agent.session.header.cwd
    if (sessionCwd === undefined) {
      this.ctx.logger.warn(
        'badge compaction: session header carries no cwd; falling back to the process working directory for the work log'
      )
    }
    return join(sessionCwd ?? process.cwd(), WORKLOG_DIRECTORY, file)
  }

  /**
   * Absolute path of the current work log for this session.
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @returns {string}
   */
  workLogPath(agent) {
    return this.sessionWorkLogPath(agent, WORKLOG_FILE)
  }

  /**
   * Build the checkpoint from the current work log, the agent-written history
   * digest, and the last real user turn.
   *
   * No model request is made anywhere on this path. Both optional sources are
   * read from disk and are omitted entirely (header included) when absent or
   * empty, so compaction cannot fail because of them. `readWorkLogDigest`
   * bounds an over-long digest from the front and marks the cut.
   *
   * Section order: current work log → history digest → the most recent raw
   * turn. The durable state comes first, the digest reads as background, and
   * the raw transcript sits closest to the messages that follow the checkpoint,
   * so the continuation sees the freshest conversation last.
   *
   * A missing or empty current work log fails closed with an actionable error
   * naming the absolute path: the file is the checkpoint, so there is nothing
   * safe to fall back to.
   *
   * Subagent sessions never reach this code: they delegate to the shipped
   * summarizer, so no file under `.local/` is read for them.
   *
   * @param {import('@deepseek-ai/dsh-compaction-basic').SummarizationInput} input
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @param {AbortSignal} [signal]
   * @returns {Promise<import('@deepseek-ai/dsh-compaction-basic').SummaryResult>}
   */
  async summarize(input, agent, signal) {
    if (isSubagentSession(agent)) return super.summarize(input, agent, signal)
    const path = this.workLogPath(agent)
    let body
    try {
      body = readFileSync(path, 'utf-8')
    } catch (error) {
      throw new Error(
        `BADGE compaction: work log not found at ${path}; 先让 agent 更新工作日志（${WORKLOG_DIRECTORY}/${WORKLOG_FILE}），再触发压缩。`,
        { cause: error }
      )
    }
    if (body.trim().length === 0) {
      throw new Error(
        `BADGE compaction: work log at ${path} is empty; 先让 agent 更新工作日志（${WORKLOG_DIRECTORY}/${WORKLOG_FILE}），再触发压缩。`
      )
    }

    const digest = this.readWorkLogDigest(agent)
    const recentTurn = this.renderRecentTurn(agent)
    const sections = [body.trim()]
    if (digest.length > 0) {
      sections.push(
        `## 历史要点（压缩前由 agent 写入 ${WORKLOG_DIRECTORY}/${WORKLOG_DIGEST_FILE}）\n\n${digest}`
      )
    }
    if (recentTurn.length > 0) {
      sections.push(`## 最近一轮对话（原文）\n\n${recentTurn}`)
    }
    return {
      summary: [
        {
          type: 'text',
          text: `${WORKLOG_OPEN_TAG}\n\n${sections.join('\n\n')}\n\n${WORKLOG_CLOSE_TAG}`,
        },
      ],
      provider: 'badge',
      model: 'worklog',
    }
  }

  /**
   * Read the agent-written history digest, if any.
   *
   * The refresh turn writes `.local/work_log_digest.md`; compaction only reads
   * it, so this method (and the whole checkpoint path) performs no model call.
   * A missing file is normal and silent. A digest longer than `DIGEST_MAX_CHARS`
   * keeps its leading, most relevant sections, is cut at a `## ` boundary when
   * one exists, and gets a marked note pointing at the full file; the file
   * itself is never rewritten.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @returns {string} trimmed digest text, or '' when absent/empty.
   */
  readWorkLogDigest(agent) {
    const path = this.sessionWorkLogPath(agent, WORKLOG_DIGEST_FILE)
    let digest
    try {
      digest = readFileSync(path, 'utf-8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn(
          `badge compaction: could not read ${path} (${error instanceof Error ? error.message : String(error)}); the checkpoint omits the history digest`
        )
      }
      return ''
    }
    const trimmed = digest.trim()
    if (trimmed.length === 0) return ''
    if (trimmed.length <= DIGEST_MAX_CHARS) return trimmed
    this.ctx.logger.warn(
      `badge compaction: ${path} exceeds ${DIGEST_MAX_CHARS} characters; keeping the leading section-aligned part and marking the truncation`
    )
    return truncateDigest(trimmed, DIGEST_MAX_CHARS)
  }

  /**
   * Render the last real user turn from the session surface.
   *
   * The turn starts at the newest `user/message` whose source is a genuine user
   * prompt (`source.kind === 'user'`), so injected messages (this engine's
   * refresh, runtime context, checkpoints, goal/schedule/agent messages, ...)
   * neither start the turn nor enter the transcript. Messages after that point
   * are rendered in surface order: user text, assistant text, and tool calls
   * with their paired result summaries. Tool results are clipped per result and
   * the whole transcript is capped; when it is too long, the earliest rendered
   * messages are dropped so the newest content survives.
   *
   * @param {import('@deepseek-ai/dsh-agent').Agent} agent
   * @returns {string} transcript, or '' when no real user turn exists.
   */
  renderRecentTurn(agent) {
    const session = agent.session
    const nodes = session.surface.nodes
    let start = -1
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.eventAt(nodes[index])
      if (event === undefined) continue
      // Project through the same path as the render, so the start never depends
      // on the raw event payload shape.
      const message = session.deriveEventMessage(event)
      if (message?.role === 'user' && message.source?.kind === 'user') {
        start = index
        break
      }
    }
    if (start < 0) return ''

    const messages = []
    for (let index = start; index < nodes.length; index += 1) {
      const event = session.eventAt(nodes[index])
      if (event === undefined) continue
      const message = session.deriveEventMessage(event)
      if (message !== null && message !== undefined) messages.push(message)
    }

    const toolResults = new Map()
    const callIds = new Set()
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool-call') callIds.add(block.id)
        }
      }
    }
    for (const message of messages) {
      if (message.role === 'tool') {
        toolResults.set(
          message.toolCallId,
          truncateText(messageText(message.content), TOOL_RESULT_MAX_CHARS)
        )
      }
    }

    const units = []
    for (const message of messages) {
      if (message.role === 'user') {
        // Only a genuine user prompt is part of the conversation transcript.
        if (message.source?.kind !== 'user') continue
        const text = messageText(message.content)
        if (text.length > 0) units.push(`[用户] ${text}`)
        continue
      }
      if (message.role === 'assistant') {
        const lines = []
        const text = messageText(message.content)
        if (text.length > 0) lines.push(`[助手] ${text}`)
        for (const block of message.content) {
          if (block.type !== 'tool-call') continue
          const result = toolResults.get(block.id)
          const args = truncateText(block.arguments, TOOL_ARGUMENT_MAX_CHARS)
          const suffix = result === undefined || result.length === 0 ? '' : ` → ${result}`
          lines.push(`[工具调用] ${block.name}(${args})${suffix}`)
        }
        if (lines.length > 0) units.push(lines.join('\n'))
        continue
      }
      if (message.role === 'tool') {
        // Paired results were already inlined with their call.
        if (callIds.has(message.toolCallId)) continue
        const text =
          toolResults.get(message.toolCallId) ??
          truncateText(messageText(message.content), TOOL_RESULT_MAX_CHARS)
        if (text.length > 0) units.push(`[工具结果] ${text}`)
      }
    }

    while (units.length > 1 && units.join('\n').length > RECENT_TURN_MAX_CHARS) units.shift()
    let transcript = units.join('\n')
    if (transcript.length > RECENT_TURN_MAX_CHARS) {
      transcript = transcript.slice(transcript.length - RECENT_TURN_MAX_CHARS)
    }
    return transcript
  }
}

//#endregion

export { BadgeCompactionEngine as default }
