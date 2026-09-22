import {
  approvedOperationNames,
  approvedOperationScopes,
  operationMetadataForName,
  operationTypeCatalogForScope,
  parseOperation,
} from './structured-policy.mjs'

const PROJECTION_ROUTES = Object.freeze([
  'emit_operation',
  'need_observation',
  'wake_planner',
  'ask_user',
])

const FALLBACK_ACTIONS = Object.freeze([
  'need_observation',
  'wake_planner',
  'ask_user',
])

const CANDIDATE_ID = /^[A-Za-z0-9_.:-]{1,80}$/
const FRESHNESS_TOKEN = /^[A-Za-z0-9_.:-]{1,160}$/
const MAX_CANDIDATES = 32

const PROJECTION_RISK_POLICY = Object.freeze({
  low: Object.freeze({
    automatic_projection_eligible: true,
    calibration_status: 'operation_specific',
  }),
  moderate: Object.freeze({
    automatic_projection_eligible: false,
    calibration_status: 'pending_phase9_e2e',
  }),
  high: Object.freeze({
    automatic_projection_eligible: false,
    calibration_status: 'pending_phase9_e2e',
  }),
  combat: Object.freeze({
    automatic_projection_eligible: false,
    calibration_status: 'pending_phase9_e2e',
  }),
})

const PROJECTION_OPERATION_POLICY = Object.freeze({
  walk_to_entity_exact: Object.freeze({
    automatic_projection: true,
    minimum_confidence: 0.85,
    low_confidence_route: 'wake_planner',
    calibration_status: 'existing_m6_live_baseline',
  }),
})

function check(ok, message) {
  if (!ok) throw new Error(message)
}

function cleanText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max)
}

function answerChoice(response) {
  return response?.answers?.projection_action?.choice
}

function answerConfidence(response) {
  const value = response?.answers?.projection_action?.confidence
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

function answerProbabilities(response) {
  const value = response?.answers?.projection_action?.probabilities
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : undefined
}

function candidateActionKey(index) {
  return `candidate_${index + 1}`
}

function exactIdentityRequired(metadata) {
  return Object.values(metadata.arguments).some(argument => argument.kind === 'exact_entity_identity')
}

function fallbackProjection(scope, route, failure, extras = {}) {
  return {
    route,
    scope,
    operation_type: undefined,
    candidate_id: undefined,
    operation: undefined,
    admission: 'not_applicable',
    ...extras,
    ...(failure ? { projection_failure: failure } : {}),
  }
}

export function typedProjectionRoutes() {
  return [...PROJECTION_ROUTES]
}

export function typedProjectionScopes() {
  return approvedOperationScopes()
}

export function typedProjectionTypeCatalog(scope) {
  check(approvedOperationScopes().includes(scope), `Unknown operation scope: ${scope}`)
  return operationTypeCatalogForScope(scope)
}

export function typedProjectionRiskPolicy(risk) {
  check(Object.hasOwn(PROJECTION_RISK_POLICY, risk), `Unknown projection risk class: ${risk}`)
  return { risk, ...PROJECTION_RISK_POLICY[risk] }
}

export function typedProjectionOperationPolicy(operationType) {
  const metadata = operationMetadataForName(operationType)
  const riskPolicy = typedProjectionRiskPolicy(metadata.risk)
  const explicit = PROJECTION_OPERATION_POLICY[operationType]
  if (explicit) {
    return {
      operation_type: operationType,
      risk: metadata.risk,
      automatic_projection: explicit.automatic_projection === true,
      minimum_confidence: explicit.minimum_confidence,
      low_confidence_route: explicit.low_confidence_route,
      calibration_status: explicit.calibration_status,
      risk_automatic_projection_eligible: riskPolicy.automatic_projection_eligible,
    }
  }
  return {
    operation_type: operationType,
    risk: metadata.risk,
    automatic_projection: false,
    minimum_confidence: null,
    low_confidence_route: 'wake_planner',
    calibration_status: 'pending_phase9_e2e',
    risk_automatic_projection_eligible: riskPolicy.automatic_projection_eligible,
  }
}

export function typedProjectionPolicyCatalog() {
  return Object.fromEntries(
    approvedOperationNames().map(name => [name, typedProjectionOperationPolicy(name)]),
  )
}

export function normalizeTypedOperationCandidates(scope, candidates = []) {
  check(approvedOperationScopes().includes(scope), `Unknown operation scope: ${scope}`)
  check(Array.isArray(candidates), 'Typed projection candidates must be an array')
  check(candidates.length <= MAX_CANDIDATES, `Typed projection supports at most ${MAX_CANDIDATES} candidates`)

  const allowed = new Set(operationTypeCatalogForScope(scope).map(entry => entry.name))
  const seen = new Set()

  return candidates.map((candidate, index) => {
    check(candidate && typeof candidate === 'object' && !Array.isArray(candidate), `Candidate ${index} must be an object`)
    const id = String(candidate.id ?? '').trim()
    check(CANDIDATE_ID.test(id), `Candidate ${index} has an invalid id`)
    check(!seen.has(id), `Duplicate typed projection candidate id: ${id}`)
    seen.add(id)

    const operation = parseOperation(candidate.operation)
    check(allowed.has(operation.name), `Operation ${operation.name} is outside scope ${scope}`)
    const metadata = operationMetadataForName(operation.name)
    const freshness_required = exactIdentityRequired(metadata)
    const freshness_token = candidate.freshness_token === undefined
      ? undefined
      : String(candidate.freshness_token).trim()
    if (freshness_required) {
      check(FRESHNESS_TOKEN.test(freshness_token ?? ''), `Candidate ${id} requires a valid freshness_token for exact identity`)
    }
    else if (freshness_token !== undefined) {
      check(FRESHNESS_TOKEN.test(freshness_token), `Candidate ${id} has an invalid freshness_token`)
    }

    return {
      id,
      action_key: candidateActionKey(index),
      operation,
      risk: metadata.risk,
      freshness_required,
      freshness_token,
      description: cleanText(candidate.description || `${operation.name} with grounded harness arguments`),
    }
  })
}

export function typedProjectionQuestions({ scope, candidates = [] } = {}) {
  const normalized = normalizeTypedOperationCandidates(scope, candidates)
  const criteria = {}

  for (const candidate of normalized) {
    criteria[candidate.action_key] = {
      candidate_id: candidate.id,
      operation: candidate.operation.name,
      scope,
      risk: candidate.risk,
      meaning: candidate.description,
      rule: 'Select only if this complete harness-built operation exactly expresses the already-decided semantic intent. Do not reinterpret or modify its arguments.',
      freshness_required: candidate.freshness_required,
    }
  }

  criteria.need_observation = {
    meaning: 'A bounded deterministic observation can supply a missing authoritative fact or candidate.',
    authority: 'runtime',
  }
  criteria.wake_planner = {
    meaning: 'Semantic intent, strategy, target choice, quantity, coordinates, or another open value is still unresolved.',
    authority: 'main_llm',
  }
  criteria.ask_user = {
    meaning: 'A genuine user-owned preference, constraint, approval, or authority decision is required.',
    authority: 'user',
  }

  return {
    projection_action: {
      type: 'choice',
      instructions: {
        task: 'Select exactly one complete typed-projection action.',
        architecture: 'Main LLM reasons; Jev selects; harness validates; Autorio executes.',
        rules: [
          'Candidate operations are complete harness-built values and may only be selected verbatim.',
          'Never invent or repair an operation argument.',
          'Use need_observation when an authoritative runtime fact is missing.',
          'Use wake_planner when semantic or open-valued intent is unresolved.',
          'Use ask_user only for user-owned authority or preference.',
          'This selection is not completion truth and does not bypass parseOperation or preflight.',
        ],
      },
      criteria,
    },
  }
}

export function parseTypedProjection(response, { scope, candidates = [] } = {}) {
  const normalized = normalizeTypedOperationCandidates(scope, candidates)
  const selected = answerChoice(response)
  const confidence = answerConfidence(response)
  const probabilities = answerProbabilities(response)

  if (FALLBACK_ACTIONS.includes(selected)) {
    return fallbackProjection(scope, selected, undefined, { confidence, probabilities })
  }

  const candidate = normalized.find(entry => entry.action_key === selected)
  if (!candidate) {
    return fallbackProjection(scope, 'wake_planner', 'unknown_projection_action', { confidence, probabilities })
  }

  return {
    route: 'emit_operation',
    scope,
    operation_type: candidate.operation.name,
    candidate_id: candidate.id,
    operation: parseOperation(candidate.operation),
    risk: candidate.risk,
    freshness_required: candidate.freshness_required,
    freshness_token: candidate.freshness_token,
    confidence,
    probabilities,
    admission: 'requires_normal_preflight',
  }
}

export function routeTypedProjectionByRisk(projection, {
  currentFreshnessToken,
} = {}) {
  check(projection && typeof projection === 'object' && !Array.isArray(projection), 'Typed projection result must be an object')
  if (projection.route !== 'emit_operation') return { ...projection }

  const policy = typedProjectionOperationPolicy(projection.operation_type)
  check(policy.risk === projection.risk, `Typed projection risk mismatch for ${projection.operation_type}`)

  if (projection.freshness_required) {
    if (
      typeof currentFreshnessToken !== 'string'
      || currentFreshnessToken !== projection.freshness_token
    ) {
      return fallbackProjection(projection.scope, 'need_observation', 'stale_exact_identity', {
        confidence: projection.confidence,
        probabilities: projection.probabilities,
        confidence_policy: policy,
      })
    }
  }

  if (policy.automatic_projection !== true) {
    return fallbackProjection(projection.scope, 'wake_planner', 'projection_operation_not_calibrated', {
      confidence: projection.confidence,
      probabilities: projection.probabilities,
      confidence_policy: policy,
    })
  }

  const threshold = policy.minimum_confidence
  check(
    typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1,
    `Calibrated projection operation ${projection.operation_type} has no valid confidence threshold`,
  )

  const confidence = projection.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < threshold) {
    const route = policy.low_confidence_route === 'need_observation' || policy.low_confidence_route === 'wake_planner'
      ? policy.low_confidence_route
      : 'wake_planner'
    return fallbackProjection(projection.scope, route, 'projection_confidence_below_policy', {
      confidence,
      probabilities: projection.probabilities,
      confidence_policy: policy,
    })
  }

  return {
    ...projection,
    confidence_policy: policy,
    admission: 'requires_normal_preflight',
  }
}
