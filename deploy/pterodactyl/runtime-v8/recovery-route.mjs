import { authoritativeRuntimeState, hasAuthoritativeBlockerEvidence } from './outcome-authority.mjs'

export const RECOVERY_FAILURE_CLASSES = new Set([
  'provider_format',
  'provider_budget',
  'provider_safety',
  'missing_fact',
  'semantic_replan',
  'runtime_busy',
  'grounded_world_failure',
  'unknown',
])

export const RECOVERY_ROUTES = new Set([
  'deterministic_close',
  'wait_runtime',
  'targeted_observation',
  'retry_compact',
  'continue_low',
  'replan_high',
  'pause_recoverable',
  'propose_blocker',
  'fallback_runtime',
])

export const RECOVERY_SEMANTIC_SCOPES = new Set([
  'keep_target',
  'reanchor_target',
])

export function recoveryFailureClassHint(reason) {
  const text = String(reason ?? '')
  if (/finish=length|output budget|context[_ -]?(?:length|window)[_ -]?exceeded|provider_(?:context_window_exceeded|turn_output_cap_exceeded|output_budget(?:_recovery)?_(?:exhausted|budget_unavailable))/i.test(text)) return 'provider_budget'
  if (/provider_safety_blocked|content_filter|safety block/i.test(text)) return 'provider_safety'
  if (/invalid provider|invalid json|strict json|malformed|parse/i.test(text)) return 'provider_format'
  if (/observation|missing fact|exact entity requires live observation/i.test(text)) return 'missing_fact'
  if (/strategy|replan|dependency|preflight/i.test(text)) return 'semantic_replan'
  return 'unknown'
}

export function recoveryDecisionQuestions() {
  return {
    failure_class: {
      type: 'choice',
      instructions: 'Classify this bounded recovery failure. Routing only: do not invent Factorio facts.',
      criteria: {
        provider_format: 'Malformed or invalid provider response/tool-call formatting.',
        provider_budget: 'Provider output budget or finish=length exhaustion.',
        provider_safety: 'Provider safety/content-filter refusal. This is terminal for ordinary main-provider retry.',
        missing_fact: 'Exactly one mutable fact is missing and one bounded observation may resolve it.',
        semantic_replan: 'The remaining strategy needs semantic reconsideration.',
        runtime_busy: 'Authoritative runtime work is already active.',
        grounded_world_failure: 'Supplied authoritative evidence supports an actual world/runtime blocker.',
        unknown: 'The bounded capsule is insufficient to classify safely.',
      },
    },
    next_recovery: {
      type: 'choice',
      instructions: 'Choose the smallest bounded next recovery. Runtime independently validates the route and owns durable state.',
      criteria: {
        deterministic_close: 'Existing authoritative evidence already proves the canonical final work complete.',
        wait_runtime: 'Authoritative runtime work is active; skip the main planner.',
        targeted_observation: 'Exactly one admissible observation is needed before deciding.',
        retry_compact: 'Retry once with compact context and low reasoning.',
        continue_low: 'Continue once with compact context and low reasoning.',
        replan_high: 'Wake once with high reasoning because strategy changed.',
        pause_recoverable: 'No world work is active; preserve the task and pause recoverably.',
        propose_blocker: 'Authoritative evidence appears to support a real world blocker.',
        fallback_runtime: 'Use the existing safe runtime fallback.',
      },
    },
    semantic_scope: {
      type: 'choice',
      instructions: 'At a provider-budget boundary, decide whether the current committed semantic target still fits the next planner handoff. This is routing only: it never proves completion, splits a plan, or writes planning hierarchy.',
      criteria: {
        keep_target: 'Keep the current committed semantic target; only renew the planner budget/context.',
        reanchor_target: 'Keep the immutable committed plan, but let the next planner re-anchor its focus from authoritative state.',
      },
    },
    world_failure_supported: {
      type: 'noul',
      instructions: 'Do the supplied authoritative facts support a real world blocker?',
    },
    need_fresh_observation: {
      type: 'noul',
      instructions: 'Is exactly one fresh mutable fact required before a safe next action?',
    },
    need_semantic_replan: {
      type: 'noul',
      instructions: 'Does the remaining strategy require semantic replanning rather than a compact retry?',
    },
  }
}

export function parseRecoveryDecision(response) {
  const failure = response?.answers?.failure_class
  const route = response?.answers?.next_recovery
  if (!failure || !RECOVERY_FAILURE_CLASSES.has(failure.choice)) throw new Error('Decision provider returned invalid recovery failure class')
  if (!route || !RECOVERY_ROUTES.has(route.choice)) throw new Error('Decision provider returned invalid recovery route')
  const confidence = typeof route.confidence === 'number' && Number.isFinite(route.confidence) ? route.confidence : 0
  if (confidence < 0 || confidence > 1) throw new Error('Decision provider returned invalid recovery confidence')
  const noul = key => {
    const value = response?.answers?.[key]?.noul
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined
  }
  const semanticScope = response?.answers?.semantic_scope?.choice
  return {
    failure_class: failure.choice,
    route: route.choice,
    semantic_scope: RECOVERY_SEMANTIC_SCOPES.has(semanticScope) ? semanticScope : 'keep_target',
    confidence,
    world_failure_supported: noul('world_failure_supported'),
    need_fresh_observation: noul('need_fresh_observation'),
    need_semantic_replan: noul('need_semantic_replan'),
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function validateRecoveryRoute(decision, {
  world = {},
  finalCompletionProven = false,
  observationBudgetAvailable = true,
  evidence = [],
  failureClassHint = 'unknown',
} = {}) {
  const runtime = authoritativeRuntimeState(world)
  const requested = RECOVERY_ROUTES.has(decision?.route) ? decision.route : 'fallback_runtime'
  const hintedFailureClass = RECOVERY_FAILURE_CLASSES.has(failureClassHint) ? failureClassHint : 'unknown'
  const providerControlPlaneFailure = hintedFailureClass === 'provider_format' || hintedFailureClass === 'provider_budget' || hintedFailureClass === 'provider_safety'
  const providerSafetyFailure = hintedFailureClass === 'provider_safety'
  const safeNonBlockingRoute = runtime.idle ? 'pause_recoverable' : runtime.active ? 'wait_runtime' : 'fallback_runtime'
  let route = requested
  let rejection_reason = ''

  if (providerSafetyFailure && ['targeted_observation', 'retry_compact', 'continue_low', 'replan_high'].includes(route)) {
    route = safeNonBlockingRoute
    rejection_reason = 'provider_safety_is_terminal_for_main_provider'
  }
  else if (route === 'deterministic_close' && !finalCompletionProven) {
    route = 'fallback_runtime'
    rejection_reason = 'deterministic_close_without_authoritative_completion'
  }
  else if (route === 'wait_runtime' && !runtime.active) {
    route = runtime.idle ? 'pause_recoverable' : 'fallback_runtime'
    rejection_reason = 'wait_runtime_without_authoritative_active_runtime'
  }
  else if (route === 'pause_recoverable' && !runtime.idle) {
    route = runtime.active ? 'wait_runtime' : 'fallback_runtime'
    rejection_reason = 'pause_recoverable_requires_authoritative_idle'
  }
  else if (route === 'targeted_observation' && !observationBudgetAvailable) {
    route = 'fallback_runtime'
    rejection_reason = 'targeted_observation_budget_exhausted'
  }
  else if (route === 'propose_blocker' && providerControlPlaneFailure) {
    route = safeNonBlockingRoute
    rejection_reason = 'provider_failure_cannot_be_world_blocker'
  }
  else if (route === 'propose_blocker' && decision?.failure_class !== 'grounded_world_failure') {
    route = safeNonBlockingRoute
    rejection_reason = 'blocker_proposal_requires_grounded_world_failure'
  }
  else if (route === 'propose_blocker' && !hasAuthoritativeBlockerEvidence(evidence)) {
    route = safeNonBlockingRoute
    rejection_reason = 'blocker_proposal_without_authoritative_evidence'
  }

  return {
    requested_route: requested,
    route,
    rejection_reason,
    runtime,
  }
}
