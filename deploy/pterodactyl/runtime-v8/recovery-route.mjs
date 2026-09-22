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

export const RECOVERY_SEMANTIC_CLASSES = new Set([
  'missing_fact',
  'semantic_replan',
  'grounded_world_failure',
  'unclear',
])

export function recoveryDecisionQuestions() {
  return {
    recovery_semantics: {
      type: 'choice',
      instructions: {
        task: 'Classify only the ambiguous semantic recovery need left after deterministic runtime/provider checks have already run.',
        rules: [
          'Do not re-classify provider budget, provider safety, provider formatting, runtime activity, completion, or user lifecycle state; code already owns those facts.',
          'Do not claim completion, author blockers, mutate plans, or invent Factorio facts.',
        ],
      },
      criteria: {
        missing_fact: 'The next semantic decision is blocked mainly by one missing or stale authoritative fact.',
        semantic_replan: 'Grounded evidence means the Main LLM should reconsider the remaining semantic approach.',
        grounded_world_failure: 'Grounded world evidence indicates the attempted approach failed in a way the Main LLM must interpret.',
        unclear: 'The supplied bounded state does not support a more specific semantic recovery class.',
      },
    },
    one_observation_can_resolve: {
      type: 'noul',
      instructions: 'Can one bounded deterministic read plausibly resolve the immediate semantic uncertainty before the Main LLM reasons again? Judge only from supplied state; this does not authorize the read.',
      criteria: {
        true: 'One targeted deterministic observation is likely sufficient to resolve the immediate uncertainty.',
        false: 'A single targeted observation is not sufficient or the Main LLM should reason directly.',
      },
    },
  }
}

function normalizeRecoveryRoute(value) {
  if (RECOVERY_ROUTES.has(value)) return value
  return LEGACY_RECOVERY_ROUTE_ALIASES[value]
}

export function parseRecoveryDecision(response) {
  const semantic = response?.answers?.recovery_semantics
  if (semantic) {
    if (!RECOVERY_SEMANTIC_CLASSES.has(semantic.choice)) throw new Error('Decision provider returned invalid recovery semantic class')
    const confidence = typeof semantic.confidence === 'number' && Number.isFinite(semantic.confidence) ? semantic.confidence : 0
    if (confidence < 0 || confidence > 1) throw new Error('Decision provider returned invalid recovery confidence')
    const rawObservation = response?.answers?.one_observation_can_resolve?.noul
    if (typeof rawObservation !== 'number' || !Number.isFinite(rawObservation) || rawObservation < 0 || rawObservation > 1) {
      throw new Error('Decision provider returned invalid recovery observation probability')
    }
    const route = semantic.choice === 'missing_fact' && rawObservation >= 0.5
      ? 'observe'
      : 'wake_planner'
    return {
      failure_class: semantic.choice === 'unclear' ? 'unknown' : semantic.choice,
      semantic_class: semantic.choice,
      route,
      requested_route: route,
      confidence,
      observation_probability: rawObservation,
      model: typeof response?.model === 'string' ? response.model : undefined,
      provider: typeof response?.provider === 'string' ? response.provider : undefined,
      usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
    }
  }

  // Parser-only compatibility for pre-M11D persisted fixtures/responses.
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
    legacy: true,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function deterministicRecoveryRoute({
  failureClass = 'unknown',
  world = {},
  observationBudgetAvailable = true,
  userDecisionRequired = false,
} = {}) {
  const runtime = authoritativeRuntimeState(world)

  if (userDecisionRequired) {
    return {
      route: 'ask_user',
      failure_class: failureClass,
      reason: 'authoritative_user_boundary',
      runtime,
    }
  }
  if (runtime.active) {
    return {
      route: 'wait_runtime',
      failure_class: failureClass,
      reason: 'authoritative_runtime_active',
      runtime,
    }
  }
  if (failureClass === 'provider_safety') {
    return {
      route: runtime.idle ? 'pause_recoverable' : 'fallback_runtime',
      failure_class: failureClass,
      reason: 'provider_safety_is_terminal_for_main_provider',
      runtime,
    }
  }
  if (failureClass === 'provider_budget' || failureClass === 'provider_format') {
    return {
      route: 'wake_planner',
      failure_class: failureClass,
      reason: 'deterministic_provider_failure_class',
      runtime,
    }
  }
  if (failureClass === 'missing_fact' && !observationBudgetAvailable) {
    return {
      route: 'wake_planner',
      failure_class: failureClass,
      reason: 'targeted_observation_budget_exhausted',
      runtime,
    }
  }
  return null
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
