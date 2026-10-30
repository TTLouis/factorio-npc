import { factoryMetadataDigest } from './factory-dependencies.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan } from './planning-state.mjs'
import { readFactoryCellIntent, factoryCellIntentSignature } from './factory-cell-intent.mjs'
import { validateFactoryCellObservation, validateFactoryMiningSource } from './factory-cell-observation.mjs'
import { prepareFactoryCellHost } from './factory-cell-tools.mjs'
import { factoryLifecycleOperation } from './factory-cell-lifecycle-runtime.mjs'
import { validateFactoryDelivery, factoryInputCoverage } from './factory-cell-delivery.mjs'
import { observeDirectFactoryDelivery, observeElectricFactoryDelivery } from './factory-cell-delivery-window.mjs'
import { operationSignature } from './operation-reconciliation.mjs'
import { enrollImplicitDirectFeed } from './factory-cell-enrollment.mjs'

// Host capabilities are intentionally ephemeral. Serialized declarations and
// old native observations cannot authorize the next process's operations.
const certificates = new WeakMap()
const operationCertificates = new WeakMap()
const failures = new WeakMap()
const startupRecipes = new WeakMap()
export const factoryUseFailureWitness = error => failures.get(error?.cause ?? error)
// A close that holds only the first frame of an attributed delivery window
// (every non-wait batch restarts it, and an inconclusive window rebases on its
// newer frame) has not refuted delivery: an ordinary native wait supplies the
// second frame. Any other miss stays a guard failure.
const PENDING_DELIVERY_WINDOW = new Set(['direct_delivery_window_started', 'direct_delivery_window_no_new_tick', 'direct_delivery_window_rebased'])
export const factoryDeliveryWindowPending = error => error?.code === 'factory_cell_delivery_unverified'
  && error.details?.phase === 'close' && PENDING_DELIVERY_WINDOW.has(error.details.selected?.delivery?.observation?.code)
const fail = (code, details) => { const error = new FactoryRegistryError(code, code); error.details = details; throw error }
const clone = value => structuredClone(value)
const known = value => value?.state === 'known' && value.truncated !== true
const nativeList = value => Array.isArray(value) ? value : value && typeof value === 'object' && Object.keys(value).length === 0 ? [] : undefined
const producerRecipe = row => known(row?.recipe) ? row.recipe : startupRecipes.get(row)

export function factoryDirectFeedRecipe(row, products) {
  const accepts = recipe => Array.isArray(recipe?.ingredients) && products.every(product => recipe.ingredients.some(item => item.type === 'item' && item.name === product))
  if (known(row?.recipe)) return accepts(row.recipe) ? row.recipe : undefined
  const candidates = row?.startup_recipe_candidates
  if (row?.state !== 'observed' || row.type !== 'furnace' || row.recipe?.state !== 'none'
    || candidates?.schema_version !== 1 || !known(candidates) || candidates.coverage !== 'complete'
    || candidates.selection !== 'unselected' || candidates.basis !== 'enabled_native_recipe_category_and_surface'
    || !Array.isArray(candidates.candidates) || candidates.candidates.length > 16
    || !Array.isArray(row.inventories) || !['input', 'output'].every(role => {
      const inventory = row.inventories.filter(item => item.role === role)
      return inventory.length === 1 && known(inventory[0]) && nativeList(inventory[0].items)?.length === 0
    }) || !known(row.progress_facts?.crafting_progress) || row.progress_facts.crafting_progress.value !== 0) return undefined
  const matches = candidates.candidates.filter(accepts)
  if (matches.length !== 1 || matches[0].applicability?.state !== 'available') return undefined
  const capability = { ...clone(matches[0]), state: 'known', truncated: false, basis: candidates.basis }
  startupRecipes.set(row, capability)
  return capability
}

// An empty furnace has no selected recipe until native input arrives. A live
// recipe/capability read permits only that exact receipt-backed startup job.
export async function readFactoryProducerRecipe(agent, access, row, recipeName) {
  if (known(row?.recipe)) {
    if (row.recipe.name !== recipeName) fail('factory_cell_producer_job_mismatch')
    return row.recipe
  }
  const inventories = row?.inventories
  if (row?.state !== 'observed' || row.type !== 'furnace' || row.recipe?.state !== 'none'
    || !Array.isArray(inventories) || !['input', 'output'].every(role => {
      const matches = inventories.filter(item => item.role === role)
      return matches.length === 1 && known(matches[0]) && nativeList(matches[0].items)?.length === 0
    }) || !known(row.progress_facts?.crafting_progress) || row.progress_facts.crafting_progress.value !== 0) fail('factory_cell_producer_job_unknown')
  await access.refresh(); access.fence()
  const raw = String(await agent.rcon.command(agent.observationToolCommand('getRecipeDetails', { item_or_recipe: recipeName, requested_count: 1 })))
  access.fence(); await access.refresh()
  if (raw.length > 262144) fail('factory_cell_recipe_body_limit')
  let detail
  try { detail = JSON.parse(raw) } catch { fail('factory_cell_recipe_unreadable') }
  const matches = detail.recipes?.filter(recipe => recipe.name === recipeName)
  const recipe = matches?.length === 1 && matches[0]
  if (detail.found !== true || detail.truncated === true || !recipe || recipe.enabled !== true || recipe.crafting_machines_truncated === true
    || !Array.isArray(recipe.crafting_machines) || !recipe.crafting_machines.some(machine => machine.name === row.locator.name)
    || !Array.isArray(recipe.products) || !recipe.products.length || recipe.products.length > 32 || !Array.isArray(recipe.ingredients)
    || [...recipe.products, ...recipe.ingredients].some(item => !['item', 'fluid'].includes(item.type) || typeof item.name !== 'string')) fail('factory_cell_recipe_capability_unproven')
  await agent.traceEvent('factory_cell.startup_recipe_evidence', { unit_number: row.locator.unit_number, recipe_name: recipeName, native_response: detail, commissioning: 'unverified' })
  access.fence()
  const capability = { ...clone(recipe), state: 'known', truncated: false, basis: 'fresh_native_empty_furnace_capability' }
  startupRecipes.set(row, capability)
  return capability
}
export const FACTORY_USE_LIMITS = Object.freeze({ candidate_cells: 16, recoveries_per_requirement: 3, records: 256 })

// This authorizes bounded construction, never existing-machine use or delivery.
export function factoryEstablishmentGrant(agent, requirement) {
  const key = agent.activePlanKey(); const state = agent.memory.planningState(key)
  const grant = agent.memory.currentGoalGrant?.(key)
  if (requirement?.kind !== 'direct_feed' || state?.goal?.status !== 'active' || state.run?.paused || !grant
    || !grant.permitted_scope?.includes('expand_infrastructure') || !grant.permitted_scope?.includes('supporting_work')) return undefined
  const ref = { grant_id: grant.grant_id, grant_revision: grant.revision, actor_id: agent.epoch?.actor_id, actor_epoch: agent.epoch?.epoch }
  const check = () => {
    if (agent.memory.planningState(key)?.goal?.goal_id !== state.goal.goal_id
      || agent.memory.planningState(key)?.goal?.status !== 'active' || agent.memory.planningState(key)?.run?.paused
      || !agent.memory.checkAuthorizationGrant(key, ref, { requestId: agent.traceRequest?.id, stage: 'factory_establishment' }).ok) fail('factory_establishment_authority_stale')
  }
  check()
  return check
}
function constructionPairCheckpoint(step) {
  const contract = step?.completion_contract; const rows = contract?.requirements
  if (contract?.mode !== 'all' || !Array.isArray(rows)) return undefined
  const counts = rows.filter(row => row.kind === 'entity_count' && !row.state && row.minimum === 1 && typeof row.prototype === 'string')
  if (counts.length !== 2 || counts[0].prototype === counts[1].prototype || rows.some(row => !counts.includes(row)
    && !(row.kind === 'authoritative_operation_receipt' && ['place_entity', 'place_candidate'].includes(row.operation_name)))) return undefined
  return counts
}
function partialMinerCheckpoint(step) {
  const contract = step?.completion_contract
  const rows = contract?.requirements
  if (contract?.mode !== 'all' || !Array.isArray(rows) || !rows.length) return undefined
  const counts = rows.filter(row => row.kind === 'entity_count' && !row.state && typeof row.prototype === 'string')
  if (!counts.length || !rows.some(row => row.kind === 'authoritative_operation_receipt' && ['place_entity', 'place_candidate'].includes(row.operation_name))
    || rows.some(row => !counts.includes(row) && !(row.kind === 'authoritative_operation_receipt' && ['place_entity', 'place_candidate'].includes(row.operation_name)))) return undefined
  return counts
}
function preparationOnly(requirement, phase, operations, productionIntent) {
  if (requirement?.kind !== 'direct_feed' || productionIntent || !['draft', 'commit', 'activation', 'admission', 'pre_send'].includes(phase)) return false
  return operations.every(operation => {
    if (Number.isSafeInteger(operation.args?.unit_number)) return false
    if (['place_entity', 'place_candidate', 'walk_to_entity'].includes(operation.name)) return true
    if (!['gather_resource', 'craft_item'].includes(operation.name)) return false
    return !['resource_name', 'entity_name', 'item_name', 'product_name'].some(field => operation.args?.[field] === requirement.resource)
  })
}

// The registry can only attribute producers whose native cell facts exist
// (mining sources, recipes, generators). An offshore pump's only source is a
// water tile and no native endpoint projects a pumped-fluid product, so no cell
// can ever contain it. Requiring one would make a plain pump placement step
// permanently unclosable; its working state is proven by its own entity_count
// evaluation. A step that also names boilers or engines keeps those rows.
const UNREGISTERABLE_SOURCE_PROTOTYPES = Object.freeze(new Set(['offshore-pump']))

export function factoryStepRequirement(step) {
  const guidance = step?.execution_guidance ?? step
  const intent = readFactoryCellIntent(guidance)
  if (guidance?.materialSupply?.mode === 'direct_feed') return { kind: 'direct_feed', resource: guidance.materialSupply.resource }
  if (intent) return { kind: 'establishment', intent }
  const requirements = step?.completion_contract?.requirements ?? step?.checkpoint?.requirements ?? []
  const producers = requirements.filter(row => row.kind === 'entity_state' && row.expected === 'working'
    || row.kind === 'entity_count' && ['working', 'powered'].includes(row.state) && !UNREGISTERABLE_SOURCE_PROTOTYPES.has(row.prototype))
  if (producers.length) return { kind: 'operating_checkpoint', producers: clone(producers) }
  return undefined
}
const requirementKey = (key, requirement) => `${key}/${factoryMetadataDigest(requirement)}`
const revision = memory => memory.factoryRegistryStatus?.().status === 'initialized' ? memory.getFactoryRegistry().revision : undefined
const physicalRevision = memory => memory.factoryLifecycleRevision?.() ?? 0
function authorize(memory, key, requirement, resolution, owner, fence) {
  let rows = certificates.get(memory)
  if (!rows) { rows = new Map(); certificates.set(memory, rows) }
  rows.set(requirementKey(key, requirement), { requirement: clone(requirement), resolution: clone(resolution), goal_id: owner.goal_id, fence,
    registry_revision: revision(memory), physical_revision: physicalRevision(memory), generation: memory.factoryWorldBinding().generation })
}
function certificateCurrent(record) {
  if (!record || typeof record.fence !== 'function') return false
  try { record.fence(); return true } catch { return false }
}
export function factoryUseDecision(memory, key, step, { close = false } = {}) {
  const requirement = factoryStepRequirement(step)
  if (!requirement) return { ok: true, applicable: false }
  const intent = readFactoryCellIntent(step?.execution_guidance ?? step)
  // A committed establishment is an obligation, not a claim of existing supply.
  // Close has the stronger receipt/native enrollment check in the same facade.
  if (intent && !close) return memory.factoryRegistryStatus?.().status === 'initialized'
    ? { ok: true, kind: 'establishment' } : { ok: false, code: 'factory_enrollment_world_unbound' }
  const record = certificates.get(memory)?.get(requirementKey(key, requirement))
  const state = memory.planningState(key)
  if (!certificateCurrent(record) || record.goal_id !== state?.goal?.goal_id || record.registry_revision !== revision(memory)
    || record.physical_revision !== physicalRevision(memory) || record.generation !== memory.factoryWorldBinding().generation) {
    return { ok: false, code: 'factory_cell_resolution_required', requirement }
  }
  const constructed = record.resolution.kind === 'constructed'
  const partial = record.resolution.kind === 'establishment_partial' || constructed
  if (partial && (!close || !(constructed ? constructionPairCheckpoint(step) : partialMinerCheckpoint(step)) || record.resolution.contract_digest !== factoryMetadataDigest(step.completion_contract))) return { ok: false, code: 'factory_cell_resolution_required', requirement }
  if (close && !intent && requirement.kind === 'direct_feed' && !partial && record.resolution.delivery_ready !== true) return { ok: false, code: 'factory_cell_delivery_unverified', requirement }
  if (close && requirement.kind === 'operating_checkpoint' && record.resolution.operating_ready !== true) return { ok: false, code: 'factory_cell_operating_inputs_unverified', requirement }
  return { ok: true, ...clone(record.resolution) }
}

export function factoryOperationUseDecision(memory, key, operations, { requestId, actor } = {}) {
  if (memory.factoryRegistryStatus?.().status !== 'initialized') return { ok: true }
  const targets = operations?.map(operation => operation.args?.unit_number) ?? []
  if (!memory.getFactoryOperationalRegistry().cells.some(cell => cell.members.some(member => targets.includes(member.unit_number)))) return { ok: true }
  const record = operationCertificates.get(memory)?.get(`${key}/${operationSignature(operations)}`)
  if (!certificateCurrent(record) || record.scope.goal_id !== memory.planningState(key)?.goal?.goal_id || record.scope.request_id !== requestId
    || record.scope.actor_id !== actor?.actor_id || record.scope.actor_epoch !== (actor?.actor_epoch ?? actor?.epoch)
    || record.revision !== revision(memory) || record.physical !== physicalRevision(memory) || record.generation !== memory.factoryWorldBinding().generation) return { ok: false, code: 'factory_cell_operation_resolution_required' }
  return { ok: true }
}

// Exact output endpoints are derived from a fresh native reply. A network ID,
// stored inventory or declared product is not a production/flow proof.
export function factoryNativeOutput(row, port) {
  if (row?.state !== 'observed' || row.endpoint_facts?.schema_version !== 1) return undefined
  if (port.kind === 'power') {
    return row.progress_facts?.electricity_production?.state === 'known' && row.progress_facts.electricity_production.producer === true
      ? { kind: 'electricity', member: clone(row.locator), capability: clone(row.progress_facts.electricity_production) } : undefined
  }
  const recipe = producerRecipe(row)
  const product = known(recipe) && recipe.products?.find(product => product.type === port.kind && product.name === port.resource)
  if (product && port.kind === 'item') {
    const endpoints = row.endpoint_facts.inventories
    const output = known(endpoints) && endpoints.endpoints?.filter(endpoint => known(endpoint) && known(endpoint.roles) && endpoint.roles.values?.includes('output'))
    if (output?.length === 1) return { kind: 'inventory', member: clone(row.locator), inventory_index: output[0].inventory_index,
      resource: port.resource, quality: row.endpoint_facts.recipe_selection?.quality ?? { state: 'unknown' } }
  }
  if (port.kind === 'item' && validateFactoryMiningSource(row, port.resource).state === 'compatible') {
    const drop = row.endpoint_facts.item_drop
    if (known(drop) && drop.routes?.length === 1 && drop.routes[0].state === 'connected') return { kind: 'item_drop', member: clone(row.locator),
      target: clone(drop.routes[0].target), resource: port.resource }
  }
  if (product && port.kind === 'fluid') {
    const boxes = row.endpoint_facts.fluidboxes
    const output = known(boxes) && boxes.endpoints?.filter(endpoint => known(endpoint) && known(endpoint.recipe_association)
      && endpoint.recipe_association.direction === 'output' && endpoint.recipe_association.resource === port.resource)
    if (output?.length === 1) return { kind: 'fluidbox', member: clone(row.locator), fluidbox_index: output[0].fluidbox_index, resource: port.resource }
  }
  return undefined
}

function matchingDirectFeed(registry, cell, native, requirement) {
  const rows = native.members
  for (const source of rows) {
    if (validateFactoryMiningSource(source, requirement.resource).state !== 'compatible') continue
    const routes = source.item_routes
    const drops = known(routes) && routes.routes?.filter(route => route.kind === 'drop' && route.state === 'connected')
    if (drops?.length !== 1) continue
    const target = cell.members.find(member => member.unit_number === drops[0].target?.unit_number)
    if (!target) continue
    const targetRow = rows.find(row => row.locator.unit_number === target.unit_number)
    const mined = validateFactoryMiningSource(source, requirement.resource)
    const startup = targetRow?.recipe?.state === 'none' && factoryDirectFeedRecipe(targetRow, mined.products)
    if (startup && mined.item_only && source.item_routes.truncated === false && cell.members.length === 2
      && ['name', 'surface_index', 'force_index'].every(field => drops[0].target[field] === target[field])
      && drops[0].target.position?.x === target.position.x && drops[0].target.position?.y === target.position.y
      && cell.assignment.products.every(product => startup.products?.some(row => row.type === 'item' && row.name === product))
      && cell.ports.filter(port => port.direction === 'output').every(port => factoryNativeOutput(targetRow, port))) {
      return { source: clone(source.locator), target: clone(target), delivery: { state: 'configured', kind: 'direct' }, commissioning: 'unverified', startup: true }
    }
    const binding = { source_unit_number: source.locator.unit_number, target_unit_number: target.unit_number }
    const validation = validateFactoryCellObservation({ registry, cell, native, binding, materialSupply: { mode: 'direct_feed', resource: requirement.resource } })
    if (validation.state === 'compatible') return { source: clone(source.locator), target: clone(target), delivery: { state: 'configured', kind: 'direct' }, commissioning: 'unverified' }
  }
  return undefined
}

function validateAssignedOperations(cell, native, operations) {
  for (const operation of operations.filter(op => cell.members.some(member => member.unit_number === op.args?.unit_number))) {
    const row = native.members.find(row => row.locator.unit_number === operation.args.unit_number)
    if (operation.name === 'move_items_exact' && operation.args.to_entity === false) {
      const port = cell.ports.find(port => port.direction === 'output' && port.resource === operation.args.item_name)
      if (!port || !factoryNativeOutput(row, port)) fail('factory_cell_withdrawal_not_output', { cell_id: cell.cell_id })
    }
    if (operation.name === 'supply_entity' || operation.name === 'move_items_exact' && operation.args.to_entity === true) {
      const supplied = operation.name === 'supply_entity' ? operation.args.items?.map(item => item.item_name) : [operation.args.item_name]
      const materials = producerRecipe(row)?.ingredients?.filter(item => item.type === 'item').map(item => item.name) ?? []
      const fuel = row?.burner_fuel_requirement
      const fuelItems = row?.fuel_item_facts
      // Exact live item categories establish suitability. Neither a
      // burner's existence nor a model fuel label permits another ore.
      if (!supplied?.length || supplied.some(item => !materials.includes(item) && !(known(fuel) && fuel.required === true
        && known(fuelItems) && fuelItems.items?.some(candidate => candidate.name === item && candidate.fuel_value > 0 && fuel.fuel_categories.includes(candidate.category))))) {
        fail('factory_cell_input_unproven', { cell_id: cell.cell_id, unit_number: operation.args.unit_number })
      }
    }
  }
}

function currentStep(agent) {
  const key = agent.activePlanKey(); const state = agent.memory.planningState?.(key); const plan = getActivePlan(state)
  if (plan) return plan.steps[plan.active_step_index]
  const legacy = agent.memory.currentPlan?.(key)
  return legacy?.task_board?.steps?.[legacy.task_board.active_index] ?? { execution_guidance: legacy?.execution_guidance?.[legacy.current_step] }
}

/** Mandatory host resolver. Absence of a model cell field cannot disable a
 * typed requirement. Every call observes again under the existing native-idle,
 * owner and registry fences; it never changes the goal or committed plan. */
export async function reconcileFactoryCellUse(agent, { step = currentStep(agent), phase = 'activation', operations = [], productionIntent, productionProposal = false, readOnly = false } = {}) {
  if (operations.length && factoryLifecycleOperation(agent, operations)) return { ok: true, kind: 'physical_transaction' }
  const machineTypes = new Set(['furnace', 'assembling-machine', 'mining-drill', 'lab', 'generator', 'boiler', 'rocket-silo'])
  const machineOperations = operations.filter(operation => operation.name === 'set_machine_recipe'
    || ['supply_entity', 'move_items_exact'].includes(operation.name) && machineTypes.has(agent.liveObservedExactTarget?.(operation.args?.unit_number)?.type))
  const requirement = factoryStepRequirement(step) ?? (machineOperations.length ? { kind: 'producer_operation',
    producers: machineOperations.map(operation => ({ unit_number: operation.args.unit_number })) } : undefined)
  const intent = readFactoryCellIntent(step?.execution_guidance ?? step)
  const registryStatus = agent.memory.factoryRegistryStatus?.()
  const targets = [...new Set([...operations.map(op => op.args?.unit_number), ...(productionIntent?.producers ?? []).map(row => row.unit_number),
    ...(requirement?.producers ?? []).map(row => row.unit_number)].filter(Number.isSafeInteger))]
  const registry = registryStatus?.status === 'initialized' ? agent.memory.getFactoryOperationalRegistry() : undefined
  const assignedTargets = registry?.cells.filter(cell => cell.members.some(member => targets.includes(member.unit_number))) ?? []
  if (!registryStatus && operations.some(operation => ['set_machine_recipe', 'supply_entity', 'move_items_exact'].includes(operation.name))) fail('factory_cell_canonical_backend_required', { phase })
  if (!requirement && !assignedTargets.length && !productionIntent?.producers?.length) return { ok: true, kind: 'manual', applicable: false }
  if (readOnly) return { ok: true, kind: 'review', unresolved: true }
  if (productionProposal && !requirement && !assignedTargets.length) return { ok: true, kind: 'pending_production_admission', unresolved: true }
  const preparation = Boolean(registryStatus) && !intent && !assignedTargets.length && preparationOnly(requirement, phase, operations, productionIntent)
  if (registryStatus?.status !== 'initialized' && !preparation) fail(intent ? 'factory_enrollment_world_unbound' : 'factory_cell_world_unbound', { phase, requirement })
  const partial = phase === 'close' && !intent && !productionIntent && !operations.length && requirement?.kind === 'direct_feed' && partialMinerCheckpoint(step)
  if (!partial && !intent && requirement?.kind === 'direct_feed' && !preparation && registryStatus?.status === 'initialized') {
    await enrollImplicitDirectFeed(agent, requirement, { targets })
  }
  const existingIntent = intent && registry?.cells.some(cell => cell.enrollment?.goal_id === agent.memory.planningState(agent.activePlanKey())?.goal?.goal_id
    && cell.enrollment.intent_signature === factoryCellIntentSignature(step.execution_guidance ?? step))
  if (intent && !existingIntent && phase !== 'close' && !assignedTargets.length) return { ok: true, kind: 'establishment', required: clone(requirement) }
  return prepareFactoryCellHost(agent, async (observer, access) => {
    const scope = observer.runtime.readScope()
    if (partial) {
      observer.runtime.scope()
      const receipts = agent.memory.factoryPlacementReceipts({ world_id: scope.world_id, goal_id: scope.goal_id, semantic_step_id: scope.semantic_step_id })
        .filter(receipt => receipt.plan_id === scope.plan_id && receipt.plan_version === scope.plan_version && receipt.step_id === scope.step_id)
      if (!receipts.length || receipts.length > 32 || partial.some(row => !receipts.some(receipt => receipt.name === row.prototype))
        || receipts.some(receipt => !partial.some(row => row.prototype === receipt.name))) fail('factory_partial_placement_receipt_required')
      const members = receipts.map(receipt => observer.runtime.recordPlacement({ unit_number: receipt.unit_number, name: receipt.name,
        position: receipt.position, surface_index: receipt.surface_index, force_index: receipt.force_index, provenance: { receipt_id: receipt.receipt_id } }, scope))
      const observed = await observer.observeCandidate({ surface_index: scope.surface_index, force_index: scope.force_index,
        assignment: { products: [requirement.resource], purpose: 'Verify staged miner placement', method: 'partial_establishment_read' }, members, ports: [], origin: observer.runtime.origin() })
      access.fence()
      if (observed.native.members.length !== members.length || observed.native.members.some(row => row.type !== 'mining-drill'
        || validateFactoryMiningSource(row, requirement.resource).state !== 'compatible')) fail('factory_partial_miner_native_unverified')
      const resolution = { kind: 'establishment_partial', contract_digest: factoryMetadataDigest(step.completion_contract),
        receipt_ids: receipts.map(receipt => receipt.receipt_id), commissioning: 'unverified', delivery_ready: false }
      await agent.traceEvent('factory_cell.partial_establishment_verified', { ...scope, phase, resolution })
      access.fence()
      authorize(agent.memory, agent.activePlanKey(), requirement, resolution, scope, access.fence)
      return { ok: true, ...resolution }
    }
    const snapshot = agent.memory.getFactoryOperationalRegistry?.() ?? agent.memory.getFactoryRegistry()
    const candidates = ['direct_feed', 'operating_checkpoint'].includes(requirement?.kind) ? snapshot.cells : requirement?.kind === 'establishment'
      ? snapshot.cells.filter(cell => cell.enrollment?.goal_id === scope.goal_id && cell.enrollment?.intent_signature === factoryCellIntentSignature(step.execution_guidance ?? step)) : assignedTargets
    if (candidates.length > FACTORY_USE_LIMITS.candidate_cells) fail('factory_cell_resolution_capacity', { phase })
    let selected
    const evidence = []
    const nativeByCell = new Map()
    const accepted = new Set()
    const unresolved = (code, details) => {
      const error = new FactoryRegistryError(code, code); error.details = details
      if (requirement && evidence.every(row => ['compatible', 'mismatch'].includes(row.state))) failures.set(error, {
        code, scope: clone(scope), requirement: clone(requirement), evidence: clone(evidence), ...clone(details),
        registry_revision: snapshot.revision, physical_revision: physicalRevision(agent.memory),
      })
      throw error
    }
    for (const cell of candidates) {
      if (['retired', 'degraded'].includes(cell.lifecycle_state)) continue
      const observed = await observer.observe({ cell_id: cell.cell_id })
      access.fence()
      nativeByCell.set(cell.cell_id, observed.native)
      evidence.push({ cell_id: cell.cell_id, tick: observed.native.tick, state: observed.state })
      let startup = false
      if (cell.assignment.method.startsWith('native_recipe:') && cell.members.length === 1 && cell.members[0].provenance?.receipt_id) {
        const recipeName = cell.assignment.method.slice('native_recipe:'.length)
        const row = observed.native.members[0]
        await readFactoryProducerRecipe(agent, access, row, recipeName)
        startup = row.recipe?.state === 'none' && cell.ports.filter(port => port.direction === 'output').every(port => factoryNativeOutput(row, port))
      }
      if (requirement?.kind === 'direct_feed') {
        const match = matchingDirectFeed(snapshot, cell, observed.native, requirement)
        if (match) {
          validateAssignedOperations(cell, observed.native, operations)
          const delivery = observeDirectFactoryDelivery(agent.memory, { scope, cell, native: observed.native, source: match.source, target: match.target,
            resource: requirement.resource, mutation: agent.factoryDeliveryMutationSeq ?? 0, connectedPlayers: access.readContext().connected_players })
          selected = { kind: 'existing', cell_id: cell.cell_id, cell_revision: cell.revision, physical_revision: cell.physical_revision ?? 0, ...match,
            delivery: delivery.state === 'delivered' ? delivery : { ...match.delivery, observation: delivery }, commissioning: 'unverified' }; break
        }
      }
      else {
        if (observed.state !== 'compatible' && !startup) continue
        if (requirement?.kind === 'operating_checkpoint' && !requirement.producers.some(producer => cell.members.some(member =>
          producer.unit_number === member.unit_number || producer.prototype === member.name))) continue
        // A finite producer must retain its cell's product, exact member and
        // output endpoint. Manual inputs remain manual; they do not commission.
        for (const producer of productionIntent?.producers ?? []) {
          if (!cell.members.some(member => member.unit_number === producer.unit_number)) continue
          const row = observed.native.members.find(row => row.locator.unit_number === producer.unit_number)
          if (producerRecipe(row)?.name !== producer.recipe_name || !known(producerRecipe(row))) fail('factory_cell_producer_job_mismatch', { cell_id: cell.cell_id, unit_number: producer.unit_number })
          const outputs = cell.ports.filter(port => port.direction === 'output').map(port => factoryNativeOutput(row, port)).filter(Boolean)
          if (!outputs.length) fail('factory_cell_producer_output_unknown', { cell_id: cell.cell_id, unit_number: producer.unit_number })
        }
        validateAssignedOperations(cell, observed.native, operations)
        selected = { kind: 'existing', cell_id: cell.cell_id, cell_revision: cell.revision, commissioning: 'unverified', delivery: { state: 'manual_or_unverified' } }
        accepted.add(cell.cell_id)
      }
    }
    if (requirement?.kind === 'operating_checkpoint') {
      for (const producer of requirement.producers) {
        const matches = candidates.filter(cell => evidence.some(row => row.cell_id === cell.cell_id && row.state === 'compatible'))
          .flatMap(cell => cell.members).filter(member => producer.unit_number === member.unit_number || producer.prototype === member.name)
        if (matches.length < (producer.minimum ?? 1)) unresolved('factory_cell_checkpoint_unassigned', { phase })
      }
    }
    if (!productionProposal && productionIntent?.producers?.some(producer => !snapshot.cells.some(cell => cell.members.some(member => member.unit_number === producer.unit_number)))) {
      fail('factory_cell_producer_unassigned', { phase })
    }
    if (!selected && preparation) {
      const checkGrant = factoryEstablishmentGrant(agent, requirement)
      const committed = currentStep(agent)
      const plan = getActivePlan(agent.memory.planningState(agent.activePlanKey()))
      const sameRequirement = factoryMetadataDigest(factoryStepRequirement(committed) ?? null) === factoryMetadataDigest(requirement)
      if (checkGrant && (!['COMMITTED', 'EXECUTING'].includes(plan?.status) || sameRequirement)) {
        const resolution = { kind: 'establishment', resource: requirement.resource, delivery_ready: false, commissioning: 'unverified' }
        const fence = () => { access.fence(); checkGrant() }
        await agent.traceEvent('factory_cell.establishment_resolved', { ...scope, phase, requirement, resolution }); fence()
        authorize(agent.memory, agent.activePlanKey(), requirement, resolution, scope, fence)
        return resolution
      }
    }
    if (!selected) unresolved('factory_cell_resolution_required', { phase, disposition: 'needs_authorized_establishment_or_matching_supplier' })
    if (requirement?.kind === 'direct_feed' && assignedTargets.some(cell => cell.cell_id !== selected.cell_id)) unresolved('factory_cell_assigned_job_mismatch', { phase, required: requirement.resource, selected })
    if (requirement?.kind !== 'direct_feed' && assignedTargets.some(cell => !accepted.has(cell.cell_id))) unresolved('factory_cell_assigned_job_unverified', { phase })
    // Observe each supplier at most once. Cycles are retained as cycles and do
    // not become independent merely because traversal has already visited them.
    const queue = [...new Set([selected.cell_id, ...accepted])]
    for (let index = 0; index < queue.length; index++) {
      for (const dep of snapshot.dependencies.filter(dep => dep.consumer.cell_id === queue[index] && dep.supplier.kind === 'cell')) {
        if (!queue.includes(dep.supplier.cell_id)) queue.push(dep.supplier.cell_id)
      }
      if (queue.length > FACTORY_USE_LIMITS.candidate_cells) fail('factory_cell_resolution_capacity', { phase })
      if (!nativeByCell.has(queue[index])) {
        const observed = await observer.observe({ cell_id: queue[index] }); access.fence()
        nativeByCell.set(queue[index], observed.native)
      }
    }
    const dependencies = snapshot.dependencies.filter(dep => queue.includes(dep.consumer.cell_id))
    const delivery = dependencies.map(dep => validateFactoryDelivery(snapshot, dep, nativeByCell, factoryNativeOutput))
    for (const [index, dependency] of dependencies.entries()) {
      if (dependency.delivery.kind !== 'electric' || delivery[index].supplier_job !== 'matched') continue
      const supplier = snapshot.cells.find(cell => cell.cell_id === dependency.supplier.cell_id)
      const consumer = snapshot.cells.find(cell => cell.cell_id === dependency.consumer.cell_id)
      const source = supplier.port_bindings.find(binding => binding.port_id === dependency.supplier.port_id).member
      const target = consumer.port_bindings.find(binding => binding.port_id === dependency.consumer.port_id).member
      const sourceNative = nativeByCell.get(supplier.cell_id); const targetNative = nativeByCell.get(consumer.cell_id)
      const window = observeElectricFactoryDelivery(agent.memory, { scope, supplier, consumer,
        producer: sourceNative.members.find(row => row.locator.unit_number === source.unit_number), receiver: targetNative.members.find(row => row.locator.unit_number === target.unit_number),
        tick: Math.max(sourceNative.tick, targetNative.tick), mutation: agent.factoryDeliveryMutationSeq ?? 0, connectedPlayers: access.readContext().connected_players })
      delivery[index] = { ...delivery[index], delivery: window, ...(window.state === 'delivered' ? { state: 'delivered', code: window.code } : {}) }
    }
    for (const producer of productionIntent?.producers ?? []) {
      const cell = snapshot.cells.find(cell => cell.members.some(member => member.unit_number === producer.unit_number))
      if (!cell && productionProposal) continue
      const row = nativeByCell.get(cell?.cell_id)?.members.find(row => row.locator.unit_number === producer.unit_number)
      if (producerRecipe(row)?.name !== producer.recipe_name || !known(producerRecipe(row))
        || !cell.ports.some(port => port.direction === 'output' && factoryNativeOutput(row, port))) fail('factory_cell_producer_job_mismatch', { unit_number: producer.unit_number })
    }
    const usedCells = [...new Set([selected.cell_id, ...accepted])]
    selected.cells = usedCells.map(cell_id => ({ cell_id, inputs: factoryInputCoverage(snapshot.cells.find(cell => cell.cell_id === cell_id),
      nativeByCell.get(cell_id), dependencies.filter(dep => dep.consumer.cell_id === cell_id)) }))
    selected.inputs = selected.cells.find(cell => cell.cell_id === selected.cell_id).inputs
    selected.dependencies = delivery
    selected.operating_ready = selected.cells.every(cell => cell.inputs.state === 'declared'
      && cell.inputs.rows.every(row => row.dependency_ids?.length)) && delivery.every(row => row.state === 'delivered')
    let constructionGrant
    const counts = phase === 'close' && !intent && !productionIntent && !operations.length && requirement?.kind === 'direct_feed' && constructionPairCheckpoint(step)
    const activeTask = () => [...(agent.memory.productionTasks?.values() ?? [])].some(task => task.owner?.goal_id === scope.goal_id && task.owner?.step_id === scope.step_id && !['complete', 'cancelled'].includes(task.status))
    if (counts && !activeTask()) {
      const cell = snapshot.cells.find(row => row.cell_id === selected.cell_id)
      const receipts = agent.memory.factoryPlacementReceipts({ world_id: scope.world_id, goal_id: scope.goal_id, semantic_step_id: scope.semantic_step_id })
      if (cell.members.length !== 2 || counts.some(count => !cell.members.some(member => member.name === count.prototype))
        || cell.members.some(member => !receipts.some(receipt => receipt.receipt_id === member.provenance?.receipt_id && receipt.plan_id === scope.plan_id
          && receipt.plan_version === scope.plan_version && receipt.step_id === scope.step_id && receipt.unit_number === member.unit_number))) fail('factory_construction_placement_receipt_required')
      const rows = nativeByCell.get(cell.cell_id).members
      if (rows.find(row => row.locator.unit_number === selected.source?.unit_number)?.type !== 'mining-drill'
        || rows.find(row => row.locator.unit_number === selected.target?.unit_number)?.type !== 'furnace') fail('factory_construction_pair_unverified')
      constructionGrant = factoryEstablishmentGrant(agent, requirement)
      if (!constructionGrant) fail('factory_establishment_authority_missing')
      selected.kind = 'constructed'; selected.contract_digest = factoryMetadataDigest(step.completion_contract)
    }
    selected.delivery_required = !intent && requirement?.kind === 'direct_feed' && selected.kind !== 'constructed'
    selected.delivery_ready = selected.kind === 'constructed' ? false : selected.delivery.state === 'delivered'
    if (delivery.some(row => row.state === 'mismatch')) unresolved('factory_cell_supplier_job_mismatch', { phase, selected })
    if (delivery.some(row => row.supplier === 'unresolved' || row.supplier === 'cell' && row.supplier_job !== 'matched')) {
      unresolved('factory_cell_supplier_unverified', { phase, selected })
    }
    // Finite manual/startup work is not an operating-service claim. Closing an
    // operating checkpoint requires every used cell's live input coverage and
    // attributed delivery; configured endpoints or stock cannot substitute.
    if (phase === 'close' && requirement?.kind === 'operating_checkpoint' && !selected.operating_ready) fail('factory_cell_operating_inputs_unverified', { phase, selected })
    if (phase === 'close' && selected.delivery_required && !selected.delivery_ready) fail('factory_cell_delivery_unverified', { phase, selected })
    await agent.traceEvent('factory_cell.use_resolved', { ...scope, phase, requirement, resolution: selected, evidence })
    access.fence()
    const finalFence = () => {
      access.fence(); constructionGrant?.()
      if (selected.kind === 'constructed' && activeTask()) fail('factory_cell_delivery_unverified')
    }
    finalFence()
    if (requirement) authorize(agent.memory, agent.activePlanKey(), requirement, selected, scope, finalFence)
    if (operations.length) {
      let records = operationCertificates.get(agent.memory)
      if (!records) { records = new Map(); operationCertificates.set(agent.memory, records) }
      if (records.size >= 64) records.delete(records.keys().next().value)
      records.set(`${agent.activePlanKey()}/${operationSignature(operations)}`, { scope: clone(scope), fence: access.fence, revision: revision(agent.memory),
        physical: physicalRevision(agent.memory), generation: agent.memory.factoryWorldBinding().generation })
    }
    return { ok: true, ...selected }
  }).execute().catch(error => {
    certificates.delete(agent.memory); operationCertificates.delete(agent.memory)
    throw error
  })
}
