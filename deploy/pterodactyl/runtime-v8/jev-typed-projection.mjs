import {
  approvedOperationScopes,
  operationNamesForScope,
  operationTypeCatalog,
  parseOperation,
} from './structured-policy.mjs'

const PROJECTION_ROUTES = Object.freeze([
  'emit_operation',
  'need_observation',
  'wake_planner',
  'ask_user',
])

const CANDIDATE_ID = /^[A-Za-z0-9_.:-]{1,80}$/
const MAX_CANDIDATES = 32

function check(ok, message) {
  if (!ok) throw new Error(message)
}

function cleanText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max)
}

function choice(response, id) {
  return response?.answers?.[id]?.choice
}

export function typedProjectionRoutes() {
  return [...PROJECTION_ROUTES]
}

export function typedProjectionScopes() {
  return approvedOperationScopes()
}

export function typedProjectionTypeCatalog(scope) {
  check(approvedOperationScopes().includes(scope), `Unknown operation scope: ${scope}`)
  const allowed = new Set(operationNamesForScope(scope))
  return operationTypeCatalog().filter(entry => allowed.has(entry.name))
}

export function normalizeTypedOperationCandidates(scope, candidates = []) {
  check(approvedOperationScopes().includes(scope), `Unknown operation scope: ${scope}`)
  check(Array.isArray(candidates), 'Typed projection candidates must be an array')
  check(candidates.length <= MAX_CANDIDATES, `Typed projection supports at most ${MAX_CANDIDATES} candidates`)

  const allowed = new Set(operationNamesForScope(scope))
  const seen = new Set()

  return candidates.map((candidate, index) => {
    check(candidate && typeof candidate === 'object' && !Array.isArray(candidate), `Candidate ${index} must be an object`)
    const id = String(candidate.id ?? '').trim()
    check(CANDIDATE_ID.test(id), `Candidate ${index} has an invalid id`)
    check(id !== 'none', 'Candidate id "none" is reserved')
    check(!seen.has(id), `Duplicate typed projection candidate id: ${id}`)
    seen.add(id)

    const operation = parseOperation(candidate.operation)
    check(allowed.has(operation.name), `Operation ${operation.name} is outside scope ${scope}`)

    return {
      id,
      operation,
      description: cleanText(candidate.description || `${operation.name} with grounded harness arguments`),
    }
  })
}

export function typedProjectionQuestions({ scope, candidates = [] } = {}) {
  const types = typedProjectionTypeCatalog(scope)
  const normalized = normalizeTypedOperationCandidates(scope, candidates)

  const typeCriteria = {
    none: 'No operation type in this scope is sufficiently specified by the supplied intent and grounded facts.',
  }
  for (const entry of types) {
    typeCriteria[entry.name] = `Project the intent as ${entry.name}; required/accepted argument keys: ${entry.args.join(', ') || '(none)'}.`
  }

  const questions = {
    projection_route: {
      type: 'choice',
      instructions:
        'Choose the cheapest safe typed-projection route. This is formatting/projection, not correctness review. Emit an operation only when the supplied semantic intent plus grounded candidate data already determine it. Never invent a missing target, quantity, entity identity, recipe, technology, position, or other argument.',
      criteria: {
        emit_operation: 'A supplied prevalidated candidate exactly expresses the already-decided Main-LLM intent.',
        need_observation: 'A bounded deterministic read can provide a missing factual argument or candidate.',
        wake_planner: 'Semantic intent is underspecified or a strategy/quantity/target choice still belongs to the Main LLM.',
        ask_user: 'A genuine user preference or authority decision is required.',
      },
    },
    operation_type: {
      type: 'choice',
      instructions:
        `Select only an operation type available in the "${scope}" scope. Choose none when the operation type is not already determined by Main-LLM intent and grounded facts. This selection does not authorize execution by itself.`,
      criteria: typeCriteria,
    },
  }

  if (normalized.length > 0) {
    const candidateCriteria = {
      none: 'No supplied prevalidated candidate exactly matches the already-decided Main-LLM intent.',
    }
    for (const candidate of normalized) {
      candidateCriteria[candidate.id] = `${candidate.operation.name}: ${candidate.description}`
    }
    questions.operation_candidate = {
      type: 'choice',
      instructions:
        'Choose one supplied prevalidated operation candidate. Candidates are harness-built typed values. Do not reinterpret or modify their arguments. Choose none if the correct operation is absent.',
      criteria: candidateCriteria,
    }
  }

  return questions
}

export function parseTypedProjection(response, { scope, candidates = [] } = {}) {
  const normalized = normalizeTypedOperationCandidates(scope, candidates)
  const allowedTypes = new Set(operationNamesForScope(scope))
  const requestedRoute = choice(response, 'projection_route')
  const route = PROJECTION_ROUTES.includes(requestedRoute) ? requestedRoute : 'wake_planner'

  const selectedType = choice(response, 'operation_type')
  const operation_type = allowedTypes.has(selectedType) ? selectedType : undefined

  const selectedCandidateId = choice(response, 'operation_candidate')
  const candidate = normalized.find(entry => entry.id === selectedCandidateId)

  if (route !== 'emit_operation') {
    return {
      route,
      scope,
      operation_type,
      candidate_id: candidate?.id,
      operation: undefined,
    }
  }

  if (!candidate || !operation_type || candidate.operation.name !== operation_type) {
    return {
      route: 'wake_planner',
      scope,
      operation_type,
      candidate_id: candidate?.id,
      operation: undefined,
      projection_failure: !candidate
        ? 'missing_prevalidated_candidate'
        : !operation_type
          ? 'missing_scope_operation_type'
          : 'candidate_type_mismatch',
    }
  }

  return {
    route: 'emit_operation',
    scope,
    operation_type,
    candidate_id: candidate.id,
    operation: candidate.operation,
  }
}
