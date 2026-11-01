// Decision overrides belong to the wake's generation and lineage, not its conversation.
// A C5/C6/C8 swap continues the wake; a reset or cancellation invalidates its cleanup.
export const DECISION_BUDGET_FIELDS = Object.freeze([
  'reasoningBudgetOverride', 'observationBudgetOverride', 'observationBudgetRemaining',
  'observationRelevanceOverride', 'planningHorizonOverride',
])

export function decisionBudgetOwner(agent) {
  return { generation: agent.generation, lineage: agent.agentContext?.lineageSequence }
}

export function ownsDecisionBudgets(agent, scope) {
  return agent.generation === scope.generation && agent.agentContext?.lineageSequence === scope.lineage
}

export function captureDecisionBudgets(agent, { requestId = agent.traceRequest?.id } = {}) {
  return { ...decisionBudgetOwner(agent), requestId,
    values: Object.fromEntries(DECISION_BUDGET_FIELDS.map(field => [field, agent[field]])) }
}

export async function restoreDecisionBudgets(agent, scope) {
  const owned = ownsDecisionBudgets(agent, scope)
  // Restore synchronously before tracing: an awaited writer may itself be superseded.
  if (owned) Object.assign(agent, scope.values)
  try {
    await agent.traceEvent?.(owned ? 'decision.budgets_restored' : 'decision.budgets_restore_skipped', {
      request_id: scope.requestId,
      reason: owned ? 'decision_scope_finished' : 'decision_owner_superseded',
    }, { requestId: scope.requestId })
  }
  catch {} // Cleanup never masks the wake's result or original exception.
  return owned
}
