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

const MAX_SYNTHESIZED_REQUIREMENTS = 4

function requirementFingerprint(raw) {
  const requirement = boundedRequirement(raw, 0)
  if (!requirement) return ''
  if (requirement.kind === 'inventory_count') {
    return `inventory_count|${requirement.item_name}|${requirement.minimum}`
  }
  if (requirement.kind === 'entity_inventory_count') {
    return `entity_inventory_count|${requirement.unit_number}|${requirement.item_name}|${requirement.minimum}`
  }
  if (requirement.kind === 'entity_exists') return `entity_exists|${requirement.unit_number}`
  if (requirement.kind === 'entity_state') return `entity_state|${requirement.unit_number}|${requirement.expected}`
  if (requirement.kind === 'authoritative_operation_receipt') {
    return `authoritative_operation_receipt|${requirement.operation_name}`
  }
  return `runtime_controller_state|${requirement.controller}|${requirement.expected}`
}

function safeGroundedFact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fact = {}
  if (Number.isFinite(value.current)) fact.current = Math.max(0, Math.trunc(value.current))
  if (value.exists !== undefined) fact.exists = value.exists === true
  if (value.working !== undefined) fact.working = value.working === true
  if (value.active !== undefined) fact.active = value.active === true
  if (value.healthy !== undefined) fact.healthy = value.healthy === true
  if (value.controller_live !== undefined) fact.controller_live = value.controller_live === true
  return Object.keys(fact).length > 0 ? fact : undefined
}

function safeEntitySymbol(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const unitNumber = positiveInteger(value.unit_number)
  if (!unitNumber) return undefined
  const symbol = { unit_number: unitNumber }
  const name = clean(value.name, 160)
  const type = clean(value.type, 80)
  const surface = clean(value.surface, 120)
  if (name) symbol.name = name
  if (type) symbol.type = type
  if (surface) symbol.surface = surface
  if (Number.isSafeInteger(value.surface_index)) symbol.surface_index = value.surface_index
  return symbol
}

export function mutationAmountsFromOperations(operations = []) {
  const amounts = []
  const bounded = Array.isArray(operations) ? operations.slice(0, 16) : []
  bounded.forEach((operation, operationIndex) => {
    const name = clean(operation?.name, 100)
    const args = operation?.args
    if (!name || !args || typeof args !== 'object' || Array.isArray(args)) return
    if (positiveInteger(args.count)) {
      amounts.push({
        operation_index: operationIndex,
        operation_name: name,
        field: 'count',
        value: args.count,
        eligible_for_checkpoint: false,
      })
    }
    if (Array.isArray(args.items)) {
      args.items.slice(0, 8).forEach((item, itemIndex) => {
        if (!positiveInteger(item?.count)) return
        amounts.push({
          operation_index: operationIndex,
          operation_name: name,
          field: `items[${itemIndex}].count`,
          value: item.count,
          eligible_for_checkpoint: false,
        })
      })
    }
  })
  return amounts.slice(0, 16)
}

export function createGroundedCheckpointSymbolTable(entries = [], { mutationAmounts = [] } = {}) {
  const items = []
  const entities = []
  const quantities = []
  const operations = []
  const controllers = []
  const predicates = []
  const itemByName = new Map()
  const entityByUnit = new Map()
  const quantityByValue = new Map()
  const operationByName = new Map()
  const controllerByName = new Map()
  const predicateByFingerprint = new Map()

  const itemSymbol = (name, fact) => {
    if (!itemByName.has(name)) {
      const symbol = { id: `item_${items.length + 1}`, name }
      if (Number.isFinite(fact?.current)) symbol.current_count = fact.current
      items.push(symbol)
      itemByName.set(name, symbol)
    }
    else if (Number.isFinite(fact?.current)) {
      itemByName.get(name).current_count = fact.current
    }
    return itemByName.get(name)
  }
  const entitySymbol = (unitNumber, entity) => {
    if (!entityByUnit.has(unitNumber)) {
      const safe = safeEntitySymbol({ ...(entity ?? {}), unit_number: unitNumber }) ?? { unit_number: unitNumber }
      const symbol = { id: `entity_${entities.length + 1}`, ...safe }
      entities.push(symbol)
      entityByUnit.set(unitNumber, symbol)
    }
    return entityByUnit.get(unitNumber)
  }
  const quantitySymbol = value => {
    if (!quantityByValue.has(value)) {
      const symbol = { id: `quantity_${quantities.length + 1}`, value, semantic_target: true }
      quantities.push(symbol)
      quantityByValue.set(value, symbol)
    }
    return quantityByValue.get(value)
  }
  const operationSymbol = name => {
    if (!operationByName.has(name)) {
      const symbol = { id: `operation_${operations.length + 1}`, name }
      operations.push(symbol)
      operationByName.set(name, symbol)
    }
    return operationByName.get(name)
  }
  const controllerSymbol = name => {
    if (!controllerByName.has(name)) {
      const symbol = { id: `controller_${controllers.length + 1}`, name }
      controllers.push(symbol)
      controllerByName.set(name, symbol)
    }
    return controllerByName.get(name)
  }

  for (const entry of Array.isArray(entries) ? entries.slice(0, 24) : []) {
    const requirement = boundedRequirement(entry?.requirement, predicates.length)
    if (!requirement) continue
    const fingerprint = requirementFingerprint(requirement)
    if (!fingerprint || predicateByFingerprint.has(fingerprint)) continue
    const fact = safeGroundedFact(entry?.fact)
    const source = clean(entry?.source, 80) || 'runtime_grounded'
    const operands = {}

    if (requirement.kind === 'inventory_count') {
      operands.item = itemSymbol(requirement.item_name, fact).id
      operands.minimum = quantitySymbol(requirement.minimum).id
    }
    else if (requirement.kind === 'entity_inventory_count') {
      operands.entity = entitySymbol(requirement.unit_number, entry?.entity).id
      operands.item = itemSymbol(requirement.item_name, fact).id
      operands.minimum = quantitySymbol(requirement.minimum).id
    }
    else if (requirement.kind === 'entity_exists') {
      operands.entity = entitySymbol(requirement.unit_number, entry?.entity).id
    }
    else if (requirement.kind === 'entity_state') {
      operands.entity = entitySymbol(requirement.unit_number, entry?.entity).id
      operands.expected = requirement.expected
    }
    else if (requirement.kind === 'authoritative_operation_receipt') {
      operands.operation = operationSymbol(requirement.operation_name).id
    }
    else {
      operands.controller = controllerSymbol(requirement.controller).id
      operands.expected = requirement.expected
    }

    const predicate = {
      id: `predicate_${predicates.length + 1}`,
      kind: requirement.kind,
      operands,
      requirement,
      source,
    }
    predicates.push(predicate)
    predicateByFingerprint.set(fingerprint, predicate)
  }

  const safeMutationAmounts = (Array.isArray(mutationAmounts) ? mutationAmounts : []).slice(0, 16).flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const operationName = clean(value.operation_name, 100)
    const field = clean(value.field, 80)
    if (!operationName || !field || !positiveInteger(value.value)) return []
    return [{
      operation_index: nonNegativeInteger(value.operation_index) ?? 0,
      operation_name: operationName,
      field,
      value: value.value,
      eligible_for_checkpoint: false,
    }]
  })

  return {
    schema: 1,
    items,
    entities,
    quantities,
    operations,
    controllers,
    predicates,
    mutation_amounts: safeMutationAmounts,
  }
}

export function validateGroundedCompletionContract(contract, groundedSymbols) {
  const normalized = sanitizeStepCompletionContract(contract)
  if (!completionContractSupported(normalized)) {
    return { accepted: false, reason: 'unsupported_or_malformed_contract', contract: normalized }
  }
  const allowed = new Set(
    (Array.isArray(groundedSymbols?.predicates) ? groundedSymbols.predicates : [])
      .map(predicate => requirementFingerprint(predicate?.requirement))
      .filter(Boolean),
  )
  for (const requirement of normalized.requirements) {
    if (!allowed.has(requirementFingerprint(requirement))) {
      return {
        accepted: false,
        reason: 'unknown_or_ungrounded_predicate',
        requirement_id: requirement.id,
        contract: { mode: 'semantic_unknown', requirements: [], confidence: normalized.confidence ?? 0 },
      }
    }
  }
  return { accepted: true, reason: 'grounded_contract', contract: normalized }
}

function groundedSynthesisQuestions(groundedSymbols) {
  const predicates = Array.isArray(groundedSymbols?.predicates)
    ? groundedSymbols.predicates.slice(0, 8)
    : []
  if (predicates.length === 0) return {}

  const criteria = {
    use_candidate: 'Keep one supplied candidate contract unchanged when it already expresses the correct semantic boundary.',
    semantic_unknown: 'No safe contract can be formed from the grounded predicates. Keep completion authority closed.',
    all: 'Compose an ALL contract from selected grounded predicate symbols.',
    any: 'Compose an ANY contract only when any one selected grounded predicate is independently sufficient for the whole step.',
  }
  const predicateCriteria = {
    none: 'Leave this synthesis slot unused.',
  }
  for (const predicate of predicates) {
    predicateCriteria[predicate.id] = `Use only this runtime-grounded predicate: ${JSON.stringify({
      kind: predicate.kind,
      operands: predicate.operands,
      source: predicate.source,
    })}`
  }

  const questions = {
    synthesis_mode: {
      type: 'choice',
      instructions: 'Normalize or synthesize the semantic checkpoint using only the supplied grounded predicate symbols. Operation mutation amounts are not semantic targets and must never be promoted into checkpoint quantities.',
      criteria,
    },
  }
  const slotCount = Math.min(MAX_SYNTHESIZED_REQUIREMENTS, predicates.length)
  for (let index = 0; index < slotCount; index++) {
    questions[`synthesis_requirement_${index + 1}`] = {
      type: 'choice',
      instructions: `Select grounded predicate slot ${index + 1}. Never invent a symbol, item, entity identity, quantity, operation, controller, or predicate kind.`,
      criteria: predicateCriteria,
    }
  }
  return questions
}

export function parseGroundedCheckpointSynthesis(response, groundedSymbols) {
  const answer = response?.answers?.synthesis_mode
  const mode = answer?.choice
  const confidence = typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence)
    ? Math.max(0, Math.min(1, answer.confidence))
    : 0
  if (!mode || mode === 'use_candidate') return { used: false }
  if (mode === 'semantic_unknown') {
    return {
      used: true,
      contract: { mode: 'semantic_unknown', requirements: [], confidence },
      reason: 'semantic_unknown',
    }
  }
  if (!['all', 'any'].includes(mode)) {
    return {
      used: true,
      contract: { mode: 'semantic_unknown', requirements: [], confidence },
      reason: 'unsupported_synthesis_mode',
    }
  }

  const predicates = Array.isArray(groundedSymbols?.predicates)
    ? groundedSymbols.predicates.slice(0, 8)
    : []
  const predicateById = new Map(predicates.map(predicate => [predicate.id, predicate]))
  const selected = []
  const seen = new Set()
  for (let index = 0; index < MAX_SYNTHESIZED_REQUIREMENTS; index++) {
    const choice = response?.answers?.[`synthesis_requirement_${index + 1}`]?.choice
    if (!choice || choice === 'none') continue
    const predicate = predicateById.get(choice)
    if (!predicate) {
      return {
        used: true,
        contract: { mode: 'semantic_unknown', requirements: [], confidence },
        reason: 'unknown_grounded_symbol',
        symbol: clean(choice, 80),
      }
    }
    if (seen.has(predicate.id)) continue
    seen.add(predicate.id)
    selected.push(predicate)
  }
  if (selected.length === 0) {
    return {
      used: true,
      contract: { mode: 'semantic_unknown', requirements: [], confidence },
      reason: 'no_grounded_predicates_selected',
    }
  }

  const contract = sanitizeStepCompletionContract({
    mode,
    source: 'jev_grounded_synthesis',
    confidence,
    requirements: selected.map((predicate, index) => ({
      ...predicate.requirement,
      id: `synth_${index + 1}`,
    })),
  })
  const validated = validateGroundedCompletionContract(contract, groundedSymbols)
  return validated.accepted
    ? { used: true, contract: validated.contract, reason: 'grounded_synthesis' }
    : {
        used: true,
        contract: { mode: 'semantic_unknown', requirements: [], confidence },
        reason: validated.reason,
      }
}


const RECEIPT_SAFE_OPERATION_NAMES = new Set([
  'walk_to_entity',
  'walk_to_entity_exact',
  'walk_to_player',
  'mine_entity',
  'mine_entity_exact',
  'gather_resource',
  'harvest_product',
  'clear_construction_area',
  'place_entity',
  'place_candidate',
  'execute_construction_plan',
  'move_items',
  'move_items_exact',
  'move_items_with_player',
  'supply_entity',
  'set_machine_recipe',
  'craft_item',
  'attack_nearest_enemy',
  'clear_enemy_area',
])

const EXPLICIT_SEMANTIC_CHECKPOINT_OPERATIONS = new Set([
  'gather_resource',
  'harvest_product',
  'craft_item',
  'mine_entity',
  'mine_entity_exact',
  'mine_resource_at',
  'supply_entity',
  'move_items',
  'move_items_exact',
  'move_items_with_player',
])

export function requiresExplicitSemanticCheckpoint(operations = []) {
  const bounded = Array.isArray(operations) ? operations.slice(0, 16) : []
  return bounded.some(operation => EXPLICIT_SEMANTIC_CHECKPOINT_OPERATIONS.has(clean(operation?.name, 100)))
}

function operationReceiptRequirement(operation, index) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined
  const name = clean(operation.name, 100)
  if (!RECEIPT_SAFE_OPERATION_NAMES.has(name) || EXPLICIT_SEMANTIC_CHECKPOINT_OPERATIONS.has(name)) return undefined
  return { id: `receipt_${index + 1}`, kind: 'authoritative_operation_receipt', operation_name: name }
}

export function completionCandidatesFromOperations(operations = []) {
  const bounded = Array.isArray(operations) ? operations.slice(0, 8) : []
  // Quantity/delta operations do not imply an absolute semantic outcome. For
  // example gather_resource(count=40) may be used when the actor already holds
  // 62 stone and the step means "have at least 100 stone". Synthesizing
  // inventory_count >= 40 would be a false checkpoint, and an operation receipt
  // would only prove that the action ran, not that the semantic target is true.
  // These operations therefore require an explicit planner semantic checkpoint
  // that Jev judges and runtime verifies.
  if (requiresExplicitSemanticCheckpoint(bounded)) return []

  const receiptRequirements = bounded.map(operationReceiptRequirement).filter(Boolean)
  if (receiptRequirements.length === 0) return []
  return [{
    mode: 'all',
    source: 'operation_receipt',
    requirements: receiptRequirements,
  }]
}

const STEP_RELATIONS = new Set([
  'advances_current',
  'prerequisite_for_current',
  'belongs_to_later_step',
  'replan_needed',
  'unrelated',
])

export function stepRelationAllowsAdmission(relation) {
  return relation === 'advances_current' || relation === 'prerequisite_for_current'
}

export function stepCheckpointDecisionQuestions(candidates = [], groundedSymbols) {
  const base = stepCompletionDecisionQuestions(candidates)
  return {
    ...base,
    ...groundedSynthesisQuestions(groundedSymbols),
    step_relation: {
      type: 'choice',
      instructions: 'Judge the semantic relationship between the proposed operation batch and the currently active canonical step. This is an admission/alignment judgment, not completion verification. Do not infer that an earlier step is complete merely because a later-step operation was proposed.',
      criteria: {
        advances_current: 'The batch directly advances the active canonical step.',
        prerequisite_for_current: 'The batch is a necessary prerequisite or enabling action for the active canonical step and belongs inside that step.',
        belongs_to_later_step: 'The batch belongs to a later canonical step rather than the active one. The planner/task board must be re-anchored before this batch may execute.',
        replan_needed: 'The relationship cannot be represented safely by the current step/plan; wake the planner to realign or split the plan before admission.',
        unrelated: 'The batch does not materially advance or enable the active canonical step and should not be admitted under it.',
      },
    },
    checkpoint_boundary: {
      type: 'choice',
      instructions: 'Judge the semantic boundary before execution. Decide whether the proposed operation batch lands on a useful deterministic checkpoint for this canonical step, whether the step should remain open after the batch, or whether the semantic step should be split/replanned before treating this batch as its completion boundary.',
      criteria: {
        checkpoint_here: 'The supplied grounded contract is a good checkpoint for this semantic step. Runtime may close the step only after the contract is deterministically satisfied.',
        keep_step_open: 'The operation batch is useful progress, but it is not a sufficient semantic boundary. Keep the current canonical step open after the batch.',
        split_recommended: 'The canonical step is too compound or ambiguous for the proposed batch/contract boundary. Recommend a planner replan/split rather than pretending this batch closes the step.',
      },
    },
  }
}

export function parseStepCheckpointDecision(response, candidates = [], groundedSymbols) {
  const normalized = parseStepCompletionDecision(response, candidates)
  const synthesis = parseGroundedCheckpointSynthesis(response, groundedSymbols)
  const boundary = response?.answers?.checkpoint_boundary?.choice
  const relation = response?.answers?.step_relation?.choice
  return {
    ...normalized,
    contract: synthesis.used ? synthesis.contract : normalized.contract,
    synthesis_used: synthesis.used === true,
    synthesis_reason: synthesis.reason,
    synthesis_symbol: synthesis.symbol,
    relation: STEP_RELATIONS.has(relation) ? relation : 'replan_needed',
    boundary: ['checkpoint_here', 'keep_step_open', 'split_recommended'].includes(boundary)
      ? boundary
      : 'keep_step_open',
  }
}

export function stepCompletionDecisionQuestions(candidates = []) {
  const normalized = candidates
    .slice(0, 8)
    .map((candidate, index) => ({
      id: `candidate_${index + 1}`,
      contract: sanitizeStepCompletionContract(candidate),
    }))
    .filter(entry => completionContractSupported(entry.contract))
  const criteria = {
    semantic_unknown: 'No supplied grounded contract safely proves this semantic step complete. Runtime must require explicit verification.',
  }
  for (const entry of normalized) {
    criteria[entry.id] = `Use this runtime-supported grounded completion contract: ${JSON.stringify(entry.contract)}`
  }
  if (Object.keys(criteria).length === 1) {
    criteria.runtime_supported_unknown = 'The runtime supports completion contracts, but no bounded grounded candidate was supplied for this step.'
  }
  return {
    contract: {
      type: 'choice',
      instructions: 'Choose which supplied grounded facts would prove the semantic step complete. You are normalizing semantics only; you do not verify that the facts are currently true.',
      criteria,
    },
    compound_step: {
      type: 'noul',
      instructions: 'Is this semantic step compound enough that one simple requirement would be unsafe as sole completion proof?',
    },
  }
}

export function parseStepCompletionDecision(response, candidates = []) {
  const choice = response?.answers?.contract?.choice
  const confidence = typeof response?.answers?.contract?.confidence === 'number'
    ? Math.max(0, Math.min(1, response.answers.contract.confidence))
    : 0
  const compound = typeof response?.answers?.compound_step?.noul === 'number'
    ? Math.max(0, Math.min(1, response.answers.compound_step.noul))
    : undefined
  if (!choice || choice === 'semantic_unknown' || choice === 'runtime_supported_unknown') {
    return { contract: { mode: 'semantic_unknown', requirements: [], confidence }, compound_probability: compound }
  }
  const match = /^candidate_([1-8])$/.exec(choice)
  if (!match) return { contract: { mode: 'semantic_unknown', requirements: [], confidence }, compound_probability: compound }
  const selected = sanitizeStepCompletionContract(candidates[Number(match[1]) - 1])
  return {
    contract: { ...selected, confidence },
    compound_probability: compound,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
}

export function receiptCompletionDecisionQuestions() {
  return {
    receipt_scope: {
      type: 'choice',
      instructions: 'Normalize the semantic scope of the already-completed authoritative operation batch against the currently active canonical step. Do not judge whether the batch really ran; runtime has already verified that separately. Choose complete_current_step only when completing exactly the listed operations is sufficient to satisfy the whole active step as written. A prerequisite, partial amount, compound step, later-step action, or ambiguous wording must not close the step.',
      criteria: {
        complete_current_step: 'The completed operation batch fully satisfies the active canonical step as written; no additional world action or observation is part of that step.',
        progress_only: 'The completed batch is useful progress or a prerequisite, but the active step still includes additional action, quantity, verification, configuration, or outcome.',
        semantic_unknown: 'The supplied descriptions are ambiguous or insufficient to determine whether the completed batch covers the whole active step.',
      },
    },
  }
}

export function parseReceiptCompletionDecision(response) {
  const answer = response?.answers?.receipt_scope
  const choice = answer?.choice
  const confidence = typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence)
    ? Math.max(0, Math.min(1, answer.confidence))
    : 0
  return {
    choice: ['complete_current_step', 'progress_only', 'semantic_unknown'].includes(choice)
      ? choice
      : 'semantic_unknown',
    confidence,
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: response?.usage && typeof response.usage === 'object' ? response.usage : undefined,
  }
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
