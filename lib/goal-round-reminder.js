/**
 * BADGE goal-round reminder.
 *
 * The shipped `@deepseek-ai/dsh-goal-round-driver` renders one `<goal_round>`
 * user message per autonomous round. That generic continuation wording makes
 * the commander forget its role and start implementing by itself, so this
 * plugin appends a short reminder block to every goal-round message.
 *
 * Why not copy the driver: a second driver registers a second `agent/pre-step`
 * fence and the two instances reject each other's reserved round, which ends
 * in `{ code: "prompt-rejected" }` and a blocked goal. Rewriting the message
 * in `agent/pre-step` needs no second driver at all.
 *
 * Why this is safe:
 *   - `await next()` runs first, so the official driver's reservation fence
 *     validates the STOCK content it captured before this listener ran; its
 *     post-decision recheck compares the same captured content.
 *   - `dsh-tool-goal`'s authority check matches only `source`
 *     (kind/goalId/revision/round), never the message body.
 *   - Editing `decision.messages` is the supported pre-step extension point;
 *     `dsh-agent-instructions` composes workspace context the same way.
 *
 * Scope: this row is mounted by an agent preset, so the reminder only affects
 * sessions composed from that preset (BETA).
 *
 * @module @deepseek-ai/dsh-goal-round-reminder
 */

/** Cordis plugin name. */
const name = 'goal-round-reminder'

/** The appended reminder block; kept to role and constitution. */
const REMINDER = [
  '提醒（每轮必读）：你是本集群的指挥官（Commander），不是执行者。',
  '继续按 OODA 循环设计工作包，并调度执行者/审查者推进；不要自己闷头实现具体工作。',
  '按总则「执行第一原则」分级：不可逆任务先加载并对照 badge-constitution skill 自查，可逆任务守核心红线即可。',
].join('\n')

/** Whether one message is an automatic, positive-numbered goal round. */
function isGoalRound(message) {
  const source = message.source
  return source !== undefined && source.kind === 'goal' && source.round > 0
}

/**
 * Register the goal-round reminder.
 * @param ctx - Cordis context of the mounting preset.
 */
function apply(ctx) {
  ctx.on('agent/pre-step', async ({ messages }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const annotated = decision.messages.map((message) => {
      if (!isGoalRound(message)) return message
      return {
        ...message,
        content: [...message.content, { type: 'text', text: REMINDER }],
      }
    })
    return annotated.some((message, index) => message !== decision.messages[index])
      ? { ...decision, messages: annotated }
      : decision
  })
}

export { apply, name }
