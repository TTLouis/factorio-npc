import { authoritativeRuntimeState } from './outcome-authority.mjs'

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

// Canonical Jev control-plane vocabulary. Internal runtime fallbacks such as
// wait_runtime, targeted_observation and pause_recoverable are code-owned
// implementation details and are never offered to Jev.
export const RECOVERY_ROUTES = new Set([
  'continue_runtime',
  'observe',
  'wake_planner',
  'ask_user',
])

// Compatibility only for persisted provider-budget handoffs created before M9.
// No live M9 question asks Jev to choose a semantic scope.
export const RECOVERY_SEMANTIC_SCOPES = new Set([
  'keep_target',
  'reanchor_target',
])

const LEGACY_RECOVERY_ROUTE_ALIASES = Object.freeze({
  wait_runtime: 'continue_runtime',
  targeted_observation: 'observe',
  retry_compact: 'wake_planner',
  continue_low: 'wake_planner',
  replan_high: 'wake_planner',
  fallback_runtime: 'wake_planner',
  pause_recoverable: 'ask_user',
  propose_blocker: 'ask_user',
  deterministic_close: 'wake_planner',
})

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
      instructions: 'Classify this bounded recovery failure for routing telemetry only. Do not invent Factorio facts, completion, blockers, or plan changes.',
      criteria: {
        provider_format: 'Malformed or invalid provider response/tool-call formatting.',
        provider_budget: 'Provider output budget or finish=length exhaustion.',
        provider_safety: 'Provider safety/content-filter refusal. This is terminal for ordinary main-provider retry.',
        missing_fact: 'One bounded authoritative observation may resolve the immediate uncertainty.',
        semantic_replan: 'The remaining strategy needs semantic reconsideration.',
        runtime_busy: 'Authoritative runtime work is already active.',
        grounded_world_failure: 'Supplied authoritative evidence describes a real world/runtime failure.',
        unknown: 'The bounded capsule is insufficient to classify safely.',
      },
    },
    next_recovery: {
      type: 'choice',
      instructions: {
        task: 'Choose the cheapest useful next reasoning route after this bounded failure.',
        rules: [
          'Routing only: do not claim completion, author blockers, mutate plans, or invent world facts.',
          'continue_runtime is only a request; deterministic code independently verifies active runtime work.',
          'observe requests bounded read-only grounding; deterministic observation admission still applies.',
          'ask_user is only valid when deterministic lifecycle state already requires user authority.',
        ],
      },
      criteria: {
        continue_runtime: 'Authoritative runtime work is already active and can continue without another Main-LLM decision.',
        observe: 'A bounded deterministic read is needed before the next semantic decision.',
        wake_planner: 'The Main LLM must reason about the next semantic step, repair, or strategy.',
        ask_user: 'The runtime is already at a lifecycle boundary that requires an explicit user choice.',
      },
    },
  }
}

function normalizeRecoveryRoute(value) {
  if (RECOVERY_ROUTES.has(value)) return value
  return LEGACY_RECOVERY_ROUTE_ALIASES[value]
}

export function parseRecoveryDecision(response) {
  const failure = response?.answers?.failure_class
  const route = response?.answers?.next_recovery
  if (!failure || !RECOVERY_FAILURE_CLASSES.has(failure.choice)) throw new Error('Decision provider returned invalid recovery failure class')
  const normalizedRoute = normalizeRecoveryRoute(route?.choice)
  if (!normalizedRoute) throw new Error('Decision provider returned invalid recovery route')
  const confidence = typeof route?.confidence === 'number' && Number.isFinite(route.confidence) ? route.confidence : 0
  if (confidence < 0 || confidence > 1) throw new Error('Decision provider returned invalid recovery confidence')
  return {
    failure_class: failure.choice,
    route: normalizedRoute,
    requested_route: route.choice,
    confidence,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function validateRecoveryRoute(decision, {
  world = {},
  observationBudgetAvailable = true,
  failureClassHint = 'unknown',
  userDecisionRequired = false,
} = {}) {
  const runtime = authoritativeRuntimeState(world)
  const requested = normalizeRecoveryRoute(decision?.route) ?? 'wake_planner'
  const hintedFailureClass = RECOVERY_FAILURE_CLASSES.has(failureClassHint) ? failureClassHint : 'unknown'
  const providerSafetyFailure = hintedFailureClass === 'provider_safety'
  const safeNoProviderRoute = runtime.active ? 'wait_runtime' : runtime.idle ? 'pause_recoverable' : 'fallback_runtime'
  let route
  let rejection_reason = ''

  if (requested === 'continue_runtime') {
    if (runtime.active) route = 'wait_runtime'
    else if (providerSafetyFailure) {
      route = safeNoProviderRoute
      rejection_reason = 'continue_runtime_without_authoritative_active_runtime'
    }
    else {
      route = 'wake_planner'
      rejection_reason = 'continue_runtime_without_authoritative_active_runtime'
    }
  }
  else if (requested === 'observe') {
    if (providerSafetyFailure) {
      route = safeNoProviderRoute
      rejection_reason = 'provider_safety_is_terminal_for_main_provider'
    }
    else if (!observationBudgetAvailable) {
      route = 'wake_planner'
      rejection_reason = 'targeted_observation_budget_exhausted'
    }
    else {
      route = 'targeted_observation'
    }
  }
  else if (requested === 'ask_user') {
    if (userDecisionRequired) route = 'ask_user'
    else if (providerSafetyFailure) {
      route = safeNoProviderRoute
      rejection_reason = 'ask_user_without_authoritative_user_boundary'
    }
    else {
      route = 'wake_planner'
      rejection_reason = 'ask_user_without_authoritative_user_boundary'
    }
  }
  else if (providerSafetyFailure) {
    route = safeNoProviderRoute
    rejection_reason = 'provider_safety_is_terminal_for_main_provider'
  }
  else {
    route = 'wake_planner'
  }

  return {
    requested_route: requested,
    route,
    rejection_reason,
    runtime,
  }
}
