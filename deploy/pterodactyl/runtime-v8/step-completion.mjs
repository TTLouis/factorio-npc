const SUPPORTED_REQUIREMENT_KINDS = new Set([
  'inventory_count',
  'entity_inventory_count',
  'entity_exists',
  'entity_state',
  'authoritative_operation_receipt',
  'runtime_controller_state',
])

function clean(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const DEFAULT_CONDITION_TIMEOUT_MS = 30 * 60 * 1000
const MAX_CONDITION_TIMEOUT_MS = 2 * 60 * 60 * 1000

function boundedTimeoutMs(value) {
  return Number.isSafeInteger(value)
    ? Math.max(1000, Math.min(value, MAX_CONDITION_TIMEOUT_MS))
    : DEFAULT_CONDITION_TIMEOUT_MS
}

function boundedRequirement(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = String(raw.kind ?? '')
  if (!SUPPORTED_REQUIREMENT_KINDS.has(kind)) return undefined
  const id = clean(raw.id || `requirement_${index + 1}`, 80)
  if (!id) return undefined

  if (kind === 'inventory_count') {
    const minimum = positiveInteger(raw.minimum)
    const itemName = clean(raw.item_name, 160)
    if (!minimum || !itemName) return undefined
    return { id, kind, item_name: itemName, minimum }
  }

  if (kind === 'entity_inventory_count') {
    const unitNumber = positiveInteger(raw.unit_number)
    const minimum = positiveInteger(raw.minimum)
    const itemName = clean(raw.item_name, 160)
    if (!unitNumber || !minimum || !itemName) return undefined
    return { id, kind, unit_number: unitNumber, item_name: itemName, minimum }
  }

  if (kind === 'entity_exists') {
    const unitNumber = positiveInteger(raw.unit_number)
    if (!unitNumber) return undefined
    return { id, kind, unit_number: unitNumber }
  }

  if (kind === 'entity_state') {
    const unitNumber = positiveInteger(raw.unit_number)
    const expected = clean(raw.expected, 80)
    if (!unitNumber || !['working', 'not_working', 'exists'].includes(expected)) return undefined
    return { id, kind, unit_number: unitNumber, expected }
  }

  if (kind === 'authoritative_operation_receipt') {
    const operationName = clean(raw.operation_name, 100)
    if (!operationName) return undefined
    return { id, kind, operation_name: operationName }
  }

  const controller = clean(raw.controller, 80)
  const expected = clean(raw.expected, 80)
  if (!controller || !['active', 'idle', 'healthy'].includes(expected)) return undefined
  return { id, kind, controller, expected }
}

export function sanitizeStepCompletionContract(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { mode: 'semantic_unknown', requirements: [], confidence: 0 }
  }
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0
  if (raw.mode === 'semantic_unknown') return { mode: 'semantic_unknown', requirements: [], confidence }
  if (!['all', 'any'].includes(raw.mode)) return { mode: 'semantic_unknown', requirements: [], confidence }
  const rawRequirements = Array.isArray(raw.requirements) ? raw.requirements : []
  if (rawRequirements.length === 0 || rawRequirements.length > 8) {
    return { mode: 'semantic_unknown', requirements: [], confidence }
  }
  const requirements = rawRequirements.map(boundedRequirement)
  if (requirements.some(requirement => !requirement)) {
    return { mode: 'semantic_unknown', requirements: [], confidence }
  }
  const ids = new Set()
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) return { mode: 'semantic_unknown', requirements: [], confidence }
    ids.add(requirement.id)
  }
  return { mode: raw.mode, requirements, confidence, source: clean(raw.source, 80) || undefined }

}

export function completionContractSupported(contract) {
  const normalized = sanitizeStepCompletionContract(contract)
  return normalized.mode !== 'semantic_unknown' && normalized.requirements.length > 0
}

function evaluateRequirementFact(requirement, fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { satisfied: false, missing: true }
  if (fact.kind !== requirement.kind) return { satisfied: false, mismatched: true }
  if (requirement.kind === 'inventory_count') {
    return { satisfied: fact.item_name === requirement.item_name && Number.isFinite(fact.current) && fact.current >= requirement.minimum }
  }
  if (requirement.kind === 'entity_inventory_count') {
    return { satisfied: fact.stale !== true && fact.unit_number === requirement.unit_number && fact.item_name === requirement.item_name && Number.isFinite(fact.current) && fact.current >= requirement.minimum }
  }
  if (requirement.kind === 'entity_exists') {
    return { satisfied: fact.stale !== true && fact.unit_number === requirement.unit_number && fact.exists === true }
  }
  if (requirement.kind === 'entity_state') {
    const exact = fact.stale !== true && fact.unit_number === requirement.unit_number && fact.exists === true
    return { satisfied: requirement.expected === 'exists' ? exact : requirement.expected === 'working' ? exact && fact.working === true : exact && fact.working === false }
  }
  if (requirement.kind === 'authoritative_operation_receipt') {
    const names = Array.isArray(fact.operation_names) ? fact.operation_names : []
    return { satisfied: fact.authoritative === true && (fact.operation_name === requirement.operation_name || names.includes(requirement.operation_name)) }
  }
  return { satisfied: fact.authoritative === true && fact.controller === requirement.controller && fact.state === requirement.expected }
}

export function evaluateCompletionContract(contract, facts = {}) {
  const normalized = sanitizeStepCompletionContract(contract)
  if (normalized.mode === 'semantic_unknown') return { status: 'unknown', satisfied: false, contract: normalized, results: [] }
  const results = normalized.requirements.map(requirement => {
    const fact = facts[requirement.id]
    const evaluated = evaluateRequirementFact(requirement, fact)
    return { id: requirement.id, kind: requirement.kind, ...evaluated, progressing: fact?.progressing === true, summary: clean(fact?.summary, 300) }
  })
  const satisfied = normalized.mode === 'any' ? results.some(result => result.satisfied) : results.every(result => result.satisfied)
  return { status: satisfied ? 'verified' : 'waiting', satisfied, contract: normalized, results }
}

// Requirement kinds that name ONE exact entity identity. Only these can ever be
// proven permanently unsatisfiable, because only these are pinned to a
// unit_number that the world can destroy.
const IDENTITY_PINNED_REQUIREMENT_KINDS = new Set([
  'entity_inventory_count',
  'entity_exists',
  'entity_state',
])

/**
 * Prove, deterministically, that a completion contract can never be satisfied.
 *
 * The ONLY proof this accepts is a destroyed exact identity. Factorio
 * unit_numbers are allocated monotonically and never reused, so once the game
 * itself reports that unit N no longer resolves -- which is what the
 * `stale_exact_target` preflight rejection is -- no future world state can make
 * a requirement pinned to unit N true again. That is a proof, not an estimate:
 * it is monotone (a stale identity never becomes live), it comes from the game
 * rather than from a model, and it needs no threshold or retry count.
 *
 * Deliberately NOT proofs: `inventory_count`, `authoritative_operation_receipt`
 * and `runtime_controller_state` are not pinned to an identity, so they stay
 * satisfiable no matter how often they have failed so far. "Failed N times" is
 * the separate repeating-failure signal and must not leak in here.
 *
 * Mode matters, because the contract is a boolean combination:
 *   - `all` dies with its first dead requirement;
 *   - `any` survives while a single requirement is still reachable.
 *
 * Returns undefined when nothing is proven -- the honest answer for "not yet
 * known to be impossible", which is not the same as "possible".
 */
export function provePermanentlyUnsatisfiable(contract, { staleUnitNumbers = [] } = {}) {
  const normalized = sanitizeStepCompletionContract(contract)
  if (normalized.mode === 'semantic_unknown' || normalized.requirements.length === 0) return undefined
  const stale = new Set(
    (Array.isArray(staleUnitNumbers) ? staleUnitNumbers : [staleUnitNumbers])
      .map(value => positiveInteger(value))
      .filter(value => value !== undefined),
  )
  if (stale.size === 0) return undefined

  const dead = normalized.requirements.filter(requirement =>
    IDENTITY_PINNED_REQUIREMENT_KINDS.has(requirement.kind) && stale.has(requirement.unit_number))
  if (dead.length === 0) return undefined
  // `any` needs every branch dead; one live branch keeps the contract reachable.
  if (normalized.mode === 'any' && dead.length !== normalized.requirements.length) return undefined

  const units = [...new Set(dead.map(requirement => requirement.unit_number))].sort((a, b) => a - b)
  return {
    proven: true,
    mode: normalized.mode,
    requirement_ids: dead.map(requirement => requirement.id),
    unit_numbers: units,
    reason: `destroyed exact ${units.length === 1 ? 'identity' : 'identities'} ${units.join(', ')} can never satisfy ${normalized.mode === 'any' ? 'any requirement of' : 'requirement'} ${dead.map(requirement => requirement.id).join(', ')}`,
  }
}

export function conditionFromRequirement(requirement) {
  const normalized = boundedRequirement(requirement, 0)
  if (!normalized) return undefined
  if (!['inventory_count', 'entity_inventory_count', 'entity_exists', 'entity_state'].includes(normalized.kind)) return undefined
  const { id: _requirementId, ...condition } = normalized
  return condition
}

export function makeConditionWait(requirement, {
  id,
  stepId,
  goalId,
  mode = 'completion',
  maxChecks = 900,
  timeoutMs = DEFAULT_CONDITION_TIMEOUT_MS,
  actorId,
  actorEpoch,
  now = Date.now(),
} = {}) {
  const condition = conditionFromRequirement(requirement)
  if (!condition) return undefined
  const lifecycleActorId = positiveInteger(actorId)
  const lifecycleActorEpoch = nonNegativeInteger(actorEpoch)
  return {
    id: clean(id || `condition_${now.toString(36)}`, 100),
    goal_id: clean(goalId, 100),
    step_id: clean(stepId, 80),
    ...(lifecycleActorId !== undefined ? { actor_id: lifecycleActorId } : {}),
    ...(lifecycleActorEpoch !== undefined ? { actor_epoch: lifecycleActorEpoch } : {}),
    mode: mode === 'passive_progress' ? 'passive_progress' : 'completion',
    condition,
    state: 'active',
    checks: 0,
    max_checks: Number.isSafeInteger(maxChecks) ? Math.max(1, Math.min(maxChecks, 7200)) : 900,
    timeout_ms: boundedTimeoutMs(timeoutMs),
    registered_at: now,
    updated_at: now,
  }
}

export function applyConditionObservation(wait, observation, { now = Date.now() } = {}) {
  if (!wait || wait.state !== 'active') return { wait, action: 'stale' }
  const checks = (Number.isSafeInteger(wait.checks) ? wait.checks : 0) + 1
  const base = { ...wait, checks, updated_at: now, last_observation: observation }
  if (observation?.stale === true) return { wait: { ...base, state: 'failed' }, action: 'failed', reason: 'stale_exact_identity' }
  if (observation?.error) return { wait: { ...base, state: 'failed' }, action: 'failed', reason: clean(observation.error, 160) }

  const timedOut = Number.isFinite(wait.registered_at)
    && Number.isSafeInteger(wait.timeout_ms)
    && now - wait.registered_at >= wait.timeout_ms

  if (wait.mode === 'passive_progress') {
    if (timedOut || checks >= wait.max_checks) {
      return { wait: { ...base, state: 'timeout' }, action: 'timeout', reason: 'condition_timeout' }
    }
    if (observation?.progressing === true) return { wait: base, action: 'waiting' }
    return { wait: { ...base, state: 'failed' }, action: 'wake', reason: 'passive_progress_stopped' }
  }

  if (observation?.satisfied === true) return { wait: { ...base, state: 'satisfied' }, action: 'verified' }
  if (timedOut || checks >= wait.max_checks) {
    return { wait: { ...base, state: 'timeout' }, action: 'timeout', reason: 'condition_timeout' }
  }
  if (observation?.progressing === false && observation?.progress_known === true) {
    return { wait: { ...base, state: 'failed' }, action: 'failed', reason: 'condition_unsatisfied_and_not_progressing' }
  }
  return { wait: base, action: 'waiting' }
}
