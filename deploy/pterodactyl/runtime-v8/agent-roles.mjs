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
