// Agent role config (delegation plan U1, design note section 6).
//
// Pure. Maps a conversation role to the provider fields it runs on:
//   planner  (roadmap / plan drafting) = models[0]
//   executor (plan agent carrying one committed plan) = models[1] ?? models[0]
// `config.models` is the parsed OPENAI_MODEL list (supervisor.mjs). With a
// single model configured both roles resolve to it, so the request built from
// either role is identical to the pre-roles single-model request. This is a
// mechanism only: no new setting selects a role or a model.

export const PLANNER_ROLE = 'planner'
export const EXECUTOR_ROLE = 'executor'
export const AGENT_ROLES = Object.freeze([PLANNER_ROLE, EXECUTOR_ROLE])

function modelsOf(config) {
  return Array.isArray(config?.models) && config.models.length > 0
    ? config.models
    : [config?.model]
}

// Returns { base, key, model, profile, timeoutMs, role } without mutating
// `config`. The provider fields keep the order of the request the supervisor
// built before roles existed.
export function resolveAgentRole(config, role = PLANNER_ROLE) {
  if (!AGENT_ROLES.includes(role)) throw new Error(`Unknown agent role: ${String(role)}`)
  const models = modelsOf(config)
  const model = role === EXECUTOR_ROLE ? (models[1] ?? models[0]) : models[0]
  return {
    base: config.base,
    key: config.key,
    model,
    profile: config.profile,
    timeoutMs: config.providerTimeoutMs,
    role,
  }
}

// The executor's role suffix (delegation U6, design note section 6). The
// executor carries one committed plan slice: the planner authored it, the harness
// committed it, and it is immutable. There is ONE submitPlan tool for both roles;
// only this suffix and the loop's plan-semantics validator differ.
export const EXECUTOR_ROLE_PROMPT = [
  '[ROLE: EXECUTOR] You are the executor for one committed plan slice. The planner authored the slice and the harness committed it; the committed plan is in the [HANDOFF] block and is immutable.',
  'Execute the committed ACTIVE step only. Return approved observation tool calls, or submitPlan carrying the operations that advance the active step (plus semanticCompletion or a checkpoint for that step only). Do not author or revise the plan: do not change, reorder, reword, add or drop steps, and do not send a goal definition (scope, doneWhen), a roadmap or a development mode. In submitPlan send stepId as the active step id from [CONTROL_DECISION_STATE]; plan and currentStep are not needed. The harness ignores plan changes from you and records that it did.',
  'When tool calls are disabled, return that same control decision as ONE strict JSON object in assistant content; checkpoint and semanticCompletion are still accepted. Preserve committed stepCompletions if restating them. A grounded semanticCompletion for the final prose-only step may have operations: []; the harness checks the goal and returns the next slice to the planner. Never add an unrelated action merely to close a completed step.',
  'If the active step cannot be completed, say so with an explicit BLOCKED reason and do not improvise a different plan; the harness decides what happens next. Goal completion is decided by the harness from the game, never by you.',
].join('\n')

/** The system prefix text of a role's conversation: the shared system prompt, plus the executor suffix for the executor. */
export function roleSystemPrompt(systemPrompt, role = PLANNER_ROLE) {
  return role === EXECUTOR_ROLE ? `${systemPrompt}\n\n${EXECUTOR_ROLE_PROMPT}` : systemPrompt
}
