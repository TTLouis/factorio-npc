const STRICT_TASKS_BY_OPERATION = new Map([
  ['walk_to_entity', ['walking_to_entity']],
  ['walk_to_entity_exact', ['walking_to_entity']],
  ['walk_to_player', ['walking_to_entity']],
  ['mine_entity', ['mining']],
  ['mine_entity_exact', ['mining']],
  ['gather_resource', ['walking_to_entity', 'mining']],
  ['harvest_product', ['harvesting']],
  ['clear_construction_area', ['clearing_area']],
  ['place_entity', ['placing']],
  ['move_items', ['moving_items']],
  ['move_items_exact', ['moving_items']],
  ['move_items_with_player', ['moving_items']],
  ['set_machine_recipe', ['setting_recipe']],
  ['launch_rocket', ['launching_rocket']],
  ['craft_item', ['crafting']],
  ['attack_nearest_enemy', ['attacking']],
  ['clear_enemy_area', ['attacking']],
])

export function strictTaskTypesForOperation(operation) {
  if (operation.name === 'supply_entity') {
    const items = operation.args?.items
    if (!Array.isArray(items) || items.length < 1 || items.length > 8) return undefined
    return Array.from({ length: items.length }, () => 'moving_items')
  }
  if (operation.name === 'execute_construction_plan') {
    const count = operation.args?.placement_count
    if (!Number.isSafeInteger(count) || count < 1 || count > 16) return undefined
    return Array.from({ length: count }, () => 'placing')
  }
  return STRICT_TASKS_BY_OPERATION.get(operation.name)
}

const SUPPORTED_REQUIREMENT_KINDS = new Set([
  'inventory_count',
  'research_completed',
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

function integerValue(value) {
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value)
  return value
}

// Live planners write "at least N" several ways: minimum, count or min_count,
// optionally with comparison/op/comparator ">=" (sgluna-prompts 2026-09-21).
// Every such checkpoint was rejected, leaving steps prose-only. Normalize only
// forms whose meaning is unambiguous; an exact or upper bound stays unsupported.
function minimumFromAliases(raw) {
  const comparator = String(raw.comparison ?? raw.comparator ?? raw.op ?? raw.operator ?? '>=').trim().toLowerCase()
  const amount = integerValue(raw.minimum ?? raw.min_count ?? raw.min ?? raw.at_least ?? raw.count)
  if (['>=', '≥', 'gte', 'at_least', 'at least'].includes(comparator)) return positiveInteger(amount)
  if (['>', 'gt'].includes(comparator)) {
    const bound = nonNegativeInteger(amount)
    return bound === undefined ? undefined : positiveInteger(bound + 1)
  }
  return undefined
}

function boundedRequirement(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const kind = String(raw.kind ?? '')
  if (!SUPPORTED_REQUIREMENT_KINDS.has(kind)) return undefined
  const id = clean(raw.id || `requirement_${index + 1}`, 80)
  if (!id) return undefined

  if (kind === 'inventory_count') {
    const minimum = minimumFromAliases(raw)
    const itemName = clean(raw.item_name ?? raw.item, 160)
    if (!minimum || !itemName) return undefined
    return { id, kind, item_name: itemName, minimum }
  }

  if (kind === 'research_completed') {
    const technology = clean(raw.technology, 160)
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(technology)) return undefined
    return { id, kind, technology }
  }

  if (kind === 'entity_inventory_count') {
    const unitNumber = positiveInteger(integerValue(raw.unit_number))
    const minimum = minimumFromAliases(raw)
    const itemName = clean(raw.item_name ?? raw.item, 160)
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
    const operationName = clean(raw.operation_name ?? raw.operation, 100)
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

// New declarations must be provable by the same policy as the receipt verifier.
// Keep legacy sanitization lossless: historical contracts are not rewritten.
export function authoredCompletionContractSupported(contract) {
  const normalized = sanitizeStepCompletionContract(contract)
  return completionContractSupported(normalized) && normalized.requirements.every(requirement =>
    requirement.kind !== 'authoritative_operation_receipt'
    || STRICT_TASKS_BY_OPERATION.has(requirement.operation_name)
    || ['supply_entity', 'execute_construction_plan'].includes(requirement.operation_name))
}

function evaluateRequirementFact(requirement, fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { satisfied: false, missing: true }
  if (fact.kind !== requirement.kind) return { satisfied: false, mismatched: true }
  if (requirement.kind === 'inventory_count') {
    return { satisfied: fact.item_name === requirement.item_name && Number.isFinite(fact.current) && fact.current >= requirement.minimum }
  }
  if (requirement.kind === 'research_completed') {
    return { satisfied: fact.authoritative === true && fact.stale !== true && fact.technology === requirement.technology && fact.satisfied === true }
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

// Does one operation of a batch remove the stock (or the entity) that a world-state requirement needs?
// Exact identity only: the same unit_number and, for stock, the same item name. An extraction is a
// move_items_exact that takes from the entity (to_entity === false); mine_entity_exact removes the entity
// together with its contents. Anything else (other machines, other items, name-based operations) is not a match.
function operationRemovesRequirementStock(operation, requirement) {
  const args = operation?.args
  if (!args || typeof args !== 'object') return undefined
  const unitNumber = positiveInteger(integerValue(args.unit_number))
  if (unitNumber === undefined || unitNumber !== requirement.unit_number) return undefined
  if (operation.name === 'mine_entity_exact') return 'removes_entity'
  if (operation.name === 'move_items_exact'
    && requirement.kind === 'entity_inventory_count'
    && args.to_entity === false
    && args.item_name === requirement.item_name) return 'extracts_item'
  return undefined
}

/**
 * Find requirements of a checkpoint contract that the same batch of operations would undo: an
 * entity_inventory_count whose stock a move_items_exact takes out of that entity, or any identity-pinned
 * requirement (entity_inventory_count, entity_exists, entity_state) whose entity a mine_entity_exact removes.
 * Returns undefined when nothing conflicts, otherwise { requirement_id, requirement_kind, unit_number,
 * item_name?, minimum?, operation_index, operation, effect, conflicts }, naming the first conflict (the
 * earliest operation) and listing every conflicting requirement/operation pair in `conflicts`.
 *
 * Mode matters: an `all` contract is unsatisfiable as soon as one requirement is undone; an `any` contract is
 * only unsatisfiable when every requirement is undone. Nothing here reads prose or rewrites the contract.
 */
export function checkpointBatchContradiction(contract, operations) {
  const normalized = sanitizeStepCompletionContract(contract)
  if (normalized.mode === 'semantic_unknown' || !Array.isArray(operations) || operations.length === 0) return undefined
  const conflicts = []
  const conflicted = new Set()
  for (const requirement of normalized.requirements) {
    if (!IDENTITY_PINNED_REQUIREMENT_KINDS.has(requirement.kind)) continue
    for (let index = 0; index < operations.length; index++) {
      const effect = operationRemovesRequirementStock(operations[index], requirement)
      if (!effect) continue
      conflicted.add(requirement.id)
      conflicts.push({
        requirement_id: requirement.id,
        requirement_kind: requirement.kind,
        unit_number: requirement.unit_number,
        ...(requirement.item_name ? { item_name: requirement.item_name } : {}),
        ...(requirement.minimum ? { minimum: requirement.minimum } : {}),
        operation_index: index,
        operation: operations[index].name,
        effect,
      })
      break
    }
  }
  if (conflicts.length === 0) return undefined
  if (normalized.mode === 'any' && conflicted.size < normalized.requirements.length) return undefined
  const first = [...conflicts].sort((a, b) => a.operation_index - b.operation_index)[0]
  return { ...first, conflicts }
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
