import { deploymentStatus } from './supervisor-adapter.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { parseInventoryCounts } from './handoff-packet.mjs'
import { materialOwnerKey } from './material-ledger.mjs'
import { normalizeCounts, recipeForItem } from './quantity-compiler.mjs'
import { restoredCollectionFence, validateRefreshedEntity } from './entity-refresh.mjs'
import { advanceProductionTask, bindProductionFuelSource, createProductionTask, finiteInventoryTargets, machineFacts, normalizeProductionIntent, productionScopeMatches, productionScopeMismatch, PRODUCTION_LIMITS, PRODUCTION_RESOURCE_BINDINGS_MAX, recoverProductionTask, restoreProductionTask } from './production-task.mjs'
import { chooseBurnerFuel, fuelAllowanceCount, repairTargets } from './production-repair.mjs'

export const PRODUCTION_RECORD_LIMIT = 128
export function restoreProductionRecords(rows) {
  const records = new Map()
  let fault = false
  if (rows === undefined) return { records, fault }
  if (!Array.isArray(rows) || rows.length > PRODUCTION_RECORD_LIMIT) return { records, fault: true }
  for (const row of rows) {
    try {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || records.has(row[0])) throw new Error('invalid_production_record')
      const task = restoreProductionTask(row[1])
      if (!row[0].endsWith(`/${materialOwnerKey(task.owner)}`)) throw new Error('production_record_owner_mismatch')
      records.set(row[0], task)
    } catch { fault = true }
  }
  return { records, fault }
}
function scope(agent) {
  const owner = agent.captureCheckpointOwner()
  const plan = getActivePlan(agent.memory.planningState?.(owner.key))
  return { owner, plan, step: plan?.steps?.[plan.active_step_index], materialOwner: {
    goal_id: owner.goalId, plan_id: owner.planId, plan_version: owner.planVersion, step_id: owner.stepId,
  } }
}
function recordKey(s) { return `${s.owner.key}/${materialOwnerKey(s.materialOwner)}` }
function protectedStock(step, intent) {
  const counts = new Map()
  for (const row of step.completion_contract?.requirements ?? []) {
    if (row.kind === 'inventory_count' && !intent.targets.some(target => target.item_name === row.item_name)) counts.set(row.item_name, Math.max(counts.get(row.item_name) ?? 0, row.minimum))
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)))
}
async function checked(agent, owner, promise) {
  const value = await promise
  await agent.assertCheckpointOwnerCurrent(owner)
  return value
}
async function store(agent, owner, key, task) {
  await agent.assertCheckpointOwnerCurrent(owner)
  agent.memory.productionTasks.set(key, task)
  await checked(agent, owner, agent.persistState({ strict: true }))
}
async function pause(agent, owner, reason) {
  await checked(agent, owner, agent.traceEvent('production.paused', { reason, plan_id: owner.planId, step_id: owner.stepId }))
  await agent.assertCheckpointOwnerCurrent(owner)
  const state = await agent.pausePersistentPlan(reason, { pause_class: 'guard' }, owner)
  return { production: 'paused', reason, goalStatus: state?.status, operations: [] }
}
export function pruneClosedProductionRecords(memory) {
  let removed = 0
  for (const [key, task] of memory.productionTasks ?? []) {
    const suffix = `/${materialOwnerKey(task.owner)}`
    const planning = memory.planningState?.(key.slice(0, -suffix.length))
    const plan = planning?.plans?.find(row => row.plan_id === task.owner.plan_id && row.plan_version === task.owner.plan_version)
    // Only authoritative completed step progress retires a budget. Missing
    // history, interrupted work and terminal failures remain durable.
    if (planning?.goal?.goal_id === task.owner.goal_id && plan?.execution?.step_progress?.[task.owner.step_id]?.status === 'completed') {
      memory.productionTasks.delete(key)
      removed++
    }
  }
  return removed
}
function pending(agent, key) {
  return (agent.memory.pendingOperations?.(key) ?? [agent.memory.pendingOperation?.(key)].filter(Boolean))
    .some(row => !['verified', 'not_admitted', 'settled', 'completed'].includes(row.state))
}

// Only raw native responses are used here. Model-visible clipped summaries and
// cached inventory overlays cannot supply executable stock or recipe yields.
async function factsFor(agent, s, task, status) {
  const read = async (tool, args) => {
    const raw = String(await checked(agent, s.owner, agent.rcon.command(agent.observationToolCommand(tool, args))))
    if (raw.length > 200000) throw new Error('production_read_truncated')
    await checked(agent, s.owner, agent.traceEvent('production.read', { tool, args, chars: raw.length, plan_id: s.owner.planId, step_id: s.owner.stepId }))
    return raw
  }
  const inventoryRaw = await read('getInventoryItems', {})
  const inventory = parseInventoryCounts(inventoryRaw)
  if (!inventory) throw new Error('production_inventory_unreadable')
  const recipes = []; const queue = task.intent.targets.map(row => row.item_name); const seen = new Set()
  while (queue.length) {
    const item = queue.shift()
    if (seen.has(item)) continue
    if (seen.size >= PRODUCTION_LIMITS.recipe_reads) throw new Error('production_recipe_read_limit')
    seen.add(item)
    const detail = JSON.parse(await read('getRecipeDetails', { item_or_recipe: item, requested_count: 1 }))
    if (detail.truncated === true || detail.recipes?.some(row => row.crafting_machines_truncated === true)) throw new Error('production_recipe_incomplete')
    // Natural resources outrank recycling recipes. A craftable item can also
    // occur in remote salvage (cable in Fulgoran ruins); that does not turn its
    // enabled canonical recipe into an acquisition leaf on this surface.
    const canonical = detail.recipes?.find(row => row.name === item)
    if (detail.mined_from?.length || (detail.harvested_from?.length && canonical?.enabled !== true)) continue
    if (detail.found === false && detail.code === 'no_recipe') continue
    if (detail.found !== true || !Array.isArray(detail.recipes)) throw new Error('production_recipe_unreadable')
    const candidates = canonical ? [canonical] : detail.recipes
    const recipe = recipeForItem(candidates, item)
    if (!recipe) throw new Error('production_recipe_unreadable')
    const raw = candidates.find(row => row.name === recipe.name)
    if (!recipes.some(row => row.name === raw.name)) recipes.push(raw)
    queue.push(...recipe.ingredients.map(row => row.item_name))
  }
  const machines = []
  for (const unit_number of new Set([...task.intent.producers, ...task.intent.feeders].map(row => row.unit_number))) {
    const raw = await read('getEntityStatus', { unit_number })
    const locator = agent.exactTargetLocator?.(unit_number)
    const placement = agent.memory.authorizationState?.(s.owner.key)?.world?.npc_placements?.find(row => row.unit_number === unit_number)
    if (task.collection_only || locator?.position && Number.isSafeInteger(locator.surface_index) && placement) {
      // A restored collection successor may carry an old incomplete locator.
      // Missing historical scope must never disable the native identity checks.
      if (task.collection_only && (!locator?.name || !locator.position || !placement
        || placement.actor_id !== status.actor_id || placement.actor_epoch !== status.epoch
        || placement.entity_name !== locator.name
        || locator.surface_index !== undefined && locator.surface_index !== status.surface_index)) throw new Error('production_collection_identity_unproven')
      const body = JSON.parse(await read('getActorStatus', {}))
      if (body.actor?.actor_id !== status.actor_id || body.surface_index !== status.surface_index) throw new Error('production_body_scope_changed')
      validateRefreshedEntity(raw, { unit: unit_number, locator, placement, actorId: status.actor_id,
        surfaceIndex: body.surface_index, forceIndex: body.force_index })
    }
    const detail = JSON.parse(raw)
    if (detail.found !== true || detail.entity?.unit_number !== unit_number) throw new Error('production_machine_identity_missing')
    agent.recordLiveEntityToolResult('getEntityStatus', raw)
    machines.push(machineFacts(detail.entity))
  }
  return { owner: s.materialOwner, actor_id: status.actor_id, epoch: status.epoch, native_idle: true, pending: false,
    fresh: true, inventory: normalizeCounts(Object.fromEntries(inventory)), recipes, machines }
}

// Refusals raised before any production record, ledger claim or native work
// exists. The executor can correct each one by resubmitting; nothing ran.
function admissionRefusal(agent, code, message) {
  const error = agent.roleContractError(code, message)
  error.productionAdmissionRefused = true
  return error
}
function isActiveStep(agent, s, stepId) {
  return [s.owner.stepId, agent.memory.currentPlan?.(s.owner.key)?.task_board?.active_step_id].includes(stepId)
}
// Admission reads decide only whether to refuse or repair; a failed read is
// treated as unknown, never as a fact.
async function admissionRead(agent, s, tool, args) {
  let raw
  try { raw = String(await agent.rcon.command(agent.observationToolCommand(tool, args))) }
  catch { raw = '' }
  await checked(agent, s.owner, agent.traceEvent('production.read', { tool, args, chars: raw.length,
    phase: 'admission', plan_id: s.owner.planId, step_id: s.owner.stepId }))
  return raw
}
async function admissionJson(agent, s, tool, args) {
  try { return JSON.parse(await admissionRead(agent, s, tool, args)) }
  catch { return undefined }
}
// A burner machine the task keeps running can only be refuelled from the
// intent's fuel allowance. Unreadable identities are left to the runtime's
// exact identity checks instead of being guessed here. A repair needs the
// complete set (`complete`): one unreadable bound machine leaves it undefined.
async function burnerBindings(agent, s, intent, { complete = false } = {}) {
  const burners = []
  for (const unit_number of new Set([...intent.producers, ...intent.feeders].map(row => row.unit_number))) {
    const detail = await admissionJson(agent, s, 'getEntityStatus', { unit_number })
    const read = detail?.found === true && detail.entity?.unit_number === unit_number && typeof detail.entity.energy_source === 'string'
    if (!read && complete) return undefined
    if (read && detail.entity.energy_source === 'burner') burners.push({ unit_number, name: detail.entity.name })
  }
  return burners
}
const burnerList = burners => burners.map(row => `${row.unit_number} ${row.name}`).join(', ')
// Each bound burner's draw and accepted fuel categories, from the native recipe
// (producer) or mining (feeder drill) facts that list its prototype, and the
// complete fuel list a recipe read names. Undefined when any of it is missing.
async function burnerFuelFacts(agent, s, intent, burners) {
  const details = new Map(); let fuels
  const recipe = async name => {
    if (!details.has(name)) {
      const detail = await admissionJson(agent, s, 'getRecipeDetails', { item_or_recipe: name, requested_count: 1 })
      details.set(name, detail?.found === true ? detail : undefined)
      // The mod lists every accepted fuel; a list an older mod cut short is not the whole choice.
      if (Array.isArray(detail?.burner_fuels?.items) && detail.burner_fuels.truncated !== true) fuels ??= detail.burner_fuels.items
    }
    return details.get(name)?.recipes?.find(row => row.name === name)
  }
  const facts = []
  for (const burner of burners) {
    const producer = intent.producers.find(row => row.unit_number === burner.unit_number)
    let machine = producer && (await recipe(producer.recipe_name))?.crafting_machines?.find(row => row.name === burner.name)
    const feeder = intent.feeders.find(row => row.unit_number === burner.unit_number)
    const output = feeder && intent.producers.find(row => row.unit_number === feeder.output_unit_number)
    for (const input of !machine && output ? (await recipe(output.recipe_name))?.ingredients ?? [] : []) {
      const mining = await admissionJson(agent, s, 'getMiningDetails', { resource_or_item: input.name })
      machine = mining?.found === true ? mining.resources?.flatMap(row => row.drills ?? []).find(row => row.name === burner.name) : undefined
      if (machine) break
    }
    if (machine?.energy_source !== 'burner' || !(machine.energy_watts > 0) || !Array.isArray(machine.fuel_categories)) return undefined
    facts.push({ ...burner, energy_watts: machine.energy_watts, burner_effectivity: machine.burner_effectivity, fuel_categories: machine.fuel_categories })
  }
  return fuels && { burners: facts, fuels: fuels.filter(fuel => fuel.fuel_value > 0 && facts.every(row => row.fuel_categories.includes(fuel.category))) }
}
// The resource binding that lets a task fetch more of an accepted fuel, from the fuel's native natural source. None
// when the game names no source, the intent is at its binding limit, or the fuel is the direct-feed step's resource.
function fuelSourceBinding(s, intent, fuel) {
  const method = fuel.mined_from?.length ? 'gather_resource' : fuel.harvested_from?.length ? 'harvest_product' : undefined
  const supply = s.step.execution_guidance?.materialSupply
  if (!method || intent.resources.some(row => row.item_name === fuel.name) || intent.resources.length >= PRODUCTION_RESOURCE_BINDINGS_MAX
    || (supply?.mode === 'direct_feed' && supply.resource === fuel.name)) return undefined
  return { item_name: fuel.name, method }
}
const PRODUCTION_REPAIRS = {
  production_scope_mismatch: async (agent, s, intent) => {
    const named = intent.targets.some(row => finiteInventoryTargets(s.step.completion_contract).has(row.item_name))
    const inventory = named ? undefined : parseInventoryCounts(await admissionRead(agent, s, 'getInventoryItems', {}))
    const repaired = repairTargets(intent, s.step.completion_contract, inventory && Object.fromEntries(inventory))
    return repaired && { intent: { ...intent, targets: repaired.targets }, rule: repaired.rule, note: repaired.note }
  },
  production_fuel_allowance_missing: async (agent, s, intent, defaults) => {
    const burners = await burnerBindings(agent, s, intent, { complete: true })
    const facts = burners?.length ? await burnerFuelFacts(agent, s, intent, burners) : undefined
    const inventory = facts && parseInventoryCounts(await admissionRead(agent, s, 'getInventoryItems', {}))
    if (!inventory) return undefined
    const held = Object.fromEntries(inventory)
    const choice = chooseBurnerFuel({ fuels: facts.fuels, held, preferred: defaults?.burner_fuel })
    if (!choice.fuel) return undefined
    const fuel = choice.fuel
    const bound = intent.resources.some(row => row.item_name === fuel.name)
    const bind = bound ? undefined : fuelSourceBinding(s, intent, fuel)
    // A fuel the task cannot bind a source for (binding limit, a direct-feed step's own resource) comes from held
    // stock only, so its cap is what is held.
    const count = Math.min(fuelAllowanceCount(facts.burners, fuel, held[fuel.name] ?? 0), bound || bind ? Infinity : held[fuel.name] ?? 0)
    if (!(count > 0)) return undefined
    const categories = [...new Set(facts.burners.flatMap(row => row.fuel_categories))].join('+')
    return { intent: { ...intent, resources: bind ? [...intent.resources, bind] : intent.resources, fuel: { item_name: fuel.name, count } },
      rule: choice.rule, note: `fuel set to ${fuel.name} with cap ${count} (${choice.rule}${choice.ignored ? `; your default burner_fuel ${choice.ignored} is not an accepted fuel these machines can get` : ''}) for the bound burner machines ${burnerList(facts.burners)}, which burn ${categories} fuel. The cap covers every bound burner at full draw for the task's ${PRODUCTION_LIMITS.duration_ms / 60000}-minute limit${bound || bind ? '' : ', within the held stock because the task cannot bind a source for it'}; one item goes in only when a machine runs out${bind ? `. Added resource ${fuel.name} via ${bind.method} so the task can fetch more` : ''}` }
  },
  // Run BB lane A: an explicit allowance above held stock with no way to fetch more. The binding is added only for a
  // fuel the bound burners accept and the game names a natural source for; targets and cap stay the executor's.
  production_fuel_source_unbound: async (agent, s, intent) => {
    const burners = await burnerBindings(agent, s, intent, { complete: true })
    const facts = burners?.length ? await burnerFuelFacts(agent, s, intent, burners) : undefined
    const fuel = facts?.fuels.find(row => row.name === intent.fuel?.item_name)
    const bind = fuel && fuelSourceBinding(s, intent, fuel)
    return bind && { intent: { ...intent, resources: [...intent.resources, bind] }, rule: 'the native source of the allowance fuel',
      note: `Added resource ${fuel.name} via ${bind.method} so your fuel allowance ${fuel.name} ${intent.fuel.count} can be met; you hold less than that and the bound burner machines ${burnerList(facts.burners)} accept it` }
  },
}
// One admission rule for both seams: the executor parse refuses an intent the
// active committed step cannot admit as a bounded correction, and
// startProductionTask re-checks it before creating durable authority.
export async function admitProductionIntent(agent, plan, { collectionOnly = false } = {}) {
  const s = scope(agent)
  if (agent.completionProtocolVersion < 3 || agent.agentContext.role !== 'executor' || !isActiveStep(agent, s, plan.stepId)
    || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(s.plan?.status) || plan.operations?.length !== 0
    || plan.semanticCompletion || plan.checkpoint || plan.plannerReview) throw admissionRefusal(agent, 'invalid_production_task', 'productionTask requires the committed executor step, empty operations and no completion/review claim')
  let intent
  try { intent = normalizeProductionIntent(plan.productionTask) }
  catch (cause) { throw admissionRefusal(agent, 'invalid_production_task', cause.message) }
  if (!productionScopeMatches(intent, s.step.completion_contract)) throw admissionRefusal(agent, 'production_scope_mismatch', productionScopeMismatch(intent, s.step.completion_contract))
  const supply = s.step.execution_guidance?.materialSupply
  if (supply?.mode === 'direct_feed' && intent.resources.some(row => row.item_name === supply.resource)) throw admissionRefusal(agent, 'production_supply_drift', 'Direct-feed steps cannot acquire their ore by hand')
  // An existing record is immutable and keeps its own allowance; it is checked
  // for identity below instead of being refused for a rule it predates.
  if (!collectionOnly && !agent.memory.productionTasks?.has(recordKey(s))) {
    const burners = await burnerBindings(agent, s, intent)
    if (burners.length && !intent.fuel) throw admissionRefusal(agent, 'production_fuel_allowance_missing', `Bound burner machines can only be refuelled from a fuel allowance {item_name, count}, which this intent omits: ${burnerList(burners)}`)
    // An allowance is a spending cap, not stock: fuel beyond what is held needs a binding to fetch it (Run BB lane A).
    const fuel = intent.fuel
    if (burners.length && !intent.resources.some(row => row.item_name === fuel.item_name)) {
      const inventory = parseInventoryCounts(await admissionRead(agent, s, 'getInventoryItems', {}))
      const held = inventory ? Object.fromEntries(inventory)[fuel.item_name] ?? 0 : 0
      const direct = supply?.mode === 'direct_feed' && supply.resource === fuel.item_name
      if (held < fuel.count) throw admissionRefusal(agent, 'production_fuel_source_unbound', `The fuel allowance ${fuel.item_name} ${fuel.count} for ${burnerList(burners)} is a cap, not stock: ${inventory ? `you hold ${held}` : 'held stock is unreadable'} and resources has no ${fuel.item_name} binding to fetch more. ${direct ? `This direct-feed step cannot acquire ${fuel.item_name} by hand, so lower the cap to what is held or choose another accepted fuel` : `Add resources {item_name: "${fuel.item_name}", method} or lower the cap to what is held`}`)
    }
  }
  return { s, intent }
}
// Admission with harness repairs: a refusal the table can answer from the
// committed step and fresh game facts is repaired and admitted again. Each
// reason is repaired at most once per reply and only while `repairable` allows;
// anything else stays the refusal the executor corrects.
export async function prepareProductionTask(agent, plan, { collectionOnly = false, defaults = {}, repairable = () => true } = {}) {
  const repairs = []
  let current = plan
  for (;;) {
    try {
      await admitProductionIntent(agent, current, { collectionOnly })
      return { plan: current, repairs }
    } catch (error) {
      const repair = Object.hasOwn(PRODUCTION_REPAIRS, error?.code ?? '') ? PRODUCTION_REPAIRS[error.code] : undefined
      if (collectionOnly || error?.productionAdmissionRefused !== true || !repair || repairs.some(row => row.code === error.code) || !repairable(error.code)) throw error
      const repaired = await repair(agent, scope(agent), normalizeProductionIntent(current.productionTask), defaults)
      if (!repaired) throw error
      repairs.push({ code: error.code, rule: repaired.rule, note: repaired.note })
      current = { ...current, productionTask: repaired.intent }
    }
  }
}
// Parse-time screen for the executor reply. A stepId naming another step is
// left to commitPlan's step-identity correction, which says which step is active.
export async function screenProductionTask(agent, plan, options) {
  const s = scope(agent)
  if (!s.step || !isActiveStep(agent, s, plan.stepId)) return undefined
  return prepareProductionTask(agent, plan, options)
}

export async function startProductionTask(agent, plan, { collectionOnly = false } = {}) {
  const { s, intent } = await admitProductionIntent(agent, plan, { collectionOnly })
  agent.memory.productionTasks ??= new Map()
  pruneClosedProductionRecords(agent.memory)
  if (agent.memory.productionRestoreFault) return pause(agent, s.owner, 'production_ledger_unreadable')
  const key = recordKey(s)
  const previous = agent.memory.productionTasks.get(key)
  if (previous && JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw admissionRefusal(agent, 'production_intent_immutable', 'An admitted production intent cannot change its targets, bindings or fuel allowance')
  if (previous && (previous.collection_only === true) !== collectionOnly) throw admissionRefusal(agent, 'production_intent_immutable', 'A harness collection continuation cannot change production authority')
  if (!previous) {
    if (agent.memory.productionTasks.size >= PRODUCTION_RECORD_LIMIT) return pause(agent, s.owner, 'production_ledger_exhausted')
    const status = await checked(agent, s.owner, deploymentStatus(agent.rcon, { requireAllowed: true }))
    const protected_stock = protectedStock(s.step, intent)
    await store(agent, s.owner, key, createProductionTask({ intent, owner: s.materialOwner, actor_id: status.actor_id, epoch: status.epoch, protected_stock, collectionOnly }))
    await checked(agent, s.owner, agent.traceEvent('production.started', { plan_id: s.owner.planId, step_id: s.owner.stepId, intent }))
  }
  if (agent.entityRefreshAdmission) {
    await agent.entityRefreshAdmission.fence()
    agent.entityRefreshAdmission.claim.state = 'continued' // The durable responsible controller now exists.
    await checked(agent, s.owner, agent.persistState({ strict: true }))
  }
  const result = await continueProductionTask(agent)
  return result === undefined ? agent.runTurn() : result
}

// The fuel source for a residual unbound-fuel halt, from the same native burner and fuel facts admission uses.
// Undefined when any fact is unreadable or the fuel has no source the task may bind.
async function residualFuelSource(agent, s, task) {
  const burners = await burnerBindings(agent, s, task.intent, { complete: true })
  const facts = burners?.length ? await burnerFuelFacts(agent, s, task.intent, burners) : undefined
  const fuel = facts?.fuels.find(row => row.name === task.intent.fuel.item_name)
  return fuel && fuelSourceBinding(s, task.intent, fuel)
}

export async function recoverProductionFailure(agent) {
  if (!agent.active || agent.currentPendingAmendment()) return undefined
  const s = scope(agent)
  if (!s.step) return undefined
  const key = recordKey(s); const task = agent.memory.productionTasks?.get(key)
  if (!task || task.status !== 'active') return undefined
  const status = await checked(agent, s.owner, deploymentStatus(agent.rcon, { requireAllowed: true }))
  if (!status.idle) return { production: 'deferred', reason: 'native_work_pending', operations: [] }
  if (pending(agent, s.owner.key)) {
    const paused = { ...task, status: 'paused', pause_reason: 'production_native_outcome_uncertain' }
    await store(agent, s.owner, key, paused)
    return pause(agent, s.owner, paused.pause_reason)
  }
  // taskStatusReceipt has settled the exact operation journal. Only now may a
  // failed/partial batch be replaced by a fresh deficit, never replayed.
  const recovery = recoverProductionTask(task, 'settled_native_failure')
  await store(agent, s.owner, key, recovery.task)
  await checked(agent, s.owner, agent.traceEvent('production.recovery', { plan_id: s.owner.planId, step_id: s.owner.stepId,
    reason: 'settled_native_failure', mechanism: 'fresh_material_recompile', recovery: recovery.task.recoveries, outcome: recovery.action }))
  return recovery.action === 'pause' ? pause(agent, s.owner, recovery.reason) : continueProductionTask(agent)
}

// Invoked by ordinary executor wakes and real completed() receipts. Each native
// batch ends this call; no timer, second actor or hidden gameplay loop is added.
export async function continueProductionTask(agent) {
  if (agent.productionAdmission || !agent.active || agent.agentContext.role !== 'executor'
    || agent.currentPendingAmendment() || agent.memory.pauseRecord?.(agent.activePlanKey())?.paused) return undefined
  const s = scope(agent)
  if (!s.step || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(s.plan?.status)) return undefined
  const key = recordKey(s)
  let task = agent.memory.productionTasks?.get(key)
  if (!task || task.status === 'complete') return undefined
  if (agent.memory.productionRestoreFault) return pause(agent, s.owner, 'production_ledger_unreadable')
  if (JSON.stringify(task.protected_stock) !== JSON.stringify(protectedStock(s.step, task.intent))) return pause(agent, s.owner, 'production_checkpoint_reservation_changed')
  if (task.status === 'paused') return pause(agent, s.owner, task.pause_reason)
  if (agent.productionFlight) return { production: 'deferred', reason: 'production_transition_in_flight', operations: [] }
  const previousRefresh = agent.entityRefreshAdmission
  if (task.collection_only && !previousRefresh) agent.entityRefreshAdmission = restoredCollectionFence(agent, task, s.owner)
  const installedRefresh = agent.entityRefreshAdmission
  agent.productionFlight = true
  try {
    for (;;) {
      await agent.assertCheckpointOwnerCurrent(s.owner)
      const status = await checked(agent, s.owner, deploymentStatus(agent.rcon, { requireAllowed: true }))
      if (status.actor_id !== task.actor_id || status.epoch !== task.epoch) return pause(agent, s.owner, 'production_actor_changed')
      if (!status.idle || pending(agent, s.owner.key) || agent.batchInFlight) return { production: 'deferred', reason: 'native_or_uncertain_work_pending', operations: [] }
      if (task.collection_only) await agent.entityRefreshAdmission.idleFence()
      let result
      try { result = advanceProductionTask(task, await factsFor(agent, s, task, status)) }
      catch (error) {
        await agent.assertCheckpointOwnerCurrent(s.owner)
        result = { action: 'pause', reason: error.message, task: { ...task, status: 'paused', pause_reason: error.message } }
      }
      if (result.action === 'pause' && !task.collection_only && !task.fuel_source && result.reason === `production_resource_unbound:${task.intent.fuel?.item_name}`) {
        // Nothing ran for this halt, so the record before it is reconciled; the next pass recompiles from fresh facts.
        const binding = await residualFuelSource(agent, s, task)
        const repair = binding ? bindProductionFuelSource(task, binding) : undefined
        await checked(agent, s.owner, agent.traceEvent('production.recovery', { plan_id: s.owner.planId, step_id: s.owner.stepId,
          reason: result.reason, mechanism: 'fuel_source_binding', binding, recovery: repair?.task.recoveries ?? task.recoveries,
          outcome: repair?.action ?? 'unproven' }))
        if (repair?.action === 'reconcile') {
          task = repair.task
          await store(agent, s.owner, key, task)
          continue
        }
        if (repair) result = repair
      }
      task = result.task
      await store(agent, s.owner, key, task)
      await checked(agent, s.owner, agent.traceEvent(`production.${result.action}`, { plan_id: s.owner.planId, step_id: s.owner.stepId,
        reason: result.reason, transitions: task.transitions, recoveries: task.recoveries, bill: result.bill, operation: result.operation }))
      if (result.action === 'complete') return undefined // Ordinary fresh checkpoint validation still owns step/goal completion.
      if (result.action === 'pause') return pause(agent, s.owner, result.reason)
      if (result.action !== 'execute') return { production: result.action, reason: result.reason, operations: [] }
      agent.productionAdmission = s.owner
      let refusal
      try {
        // Existing executor semantics, authorization, exact identity, preflight,
        // native queue and durable operation reconciliation remain the only path.
        return await agent.commitPlan({ chatMessage: '', stepId: s.owner.stepId, plan: [], currentStep: 0, operations: [result.operation] })
      } catch (error) {
        if (!error.productionNotAdmitted) throw error
        refusal = error.preflight.code
      } finally { agent.productionAdmission = null }
      await agent.assertCheckpointOwnerCurrent(s.owner)
      const recovery = recoverProductionTask(task, refusal)
      task = recovery.task
      await store(agent, s.owner, key, task)
      await checked(agent, s.owner, agent.traceEvent('production.recovery', { plan_id: s.owner.planId, step_id: s.owner.stepId,
        reason: refusal, mechanism: 'fresh_material_recompile', recovery: task.recoveries, outcome: recovery.action }))
      if (recovery.action === 'pause') return pause(agent, s.owner, recovery.reason)
      // No replay: reread authoritative inventory, recipes and exact machines,
      // then compile the remaining demand. Exhaustion survives every restage.
    }
  } catch (error) {
    await agent.assertCheckpointOwnerCurrent(s.owner)
    if (!task.collection_only || !error.entityRefreshBusy) throw error
    await checked(agent, s.owner, agent.traceEvent('production.collection_deferred', { request_id: s.owner.requestTrace?.id,
      goal_id: s.owner.goalId, plan_id: s.owner.planId, step_id: s.owner.stepId, reason: error.message }))
    return { production: 'deferred', reason: error.message, operations: [] }
  } finally {
    agent.productionFlight = false
    if (task.collection_only && agent.entityRefreshAdmission === installedRefresh) agent.entityRefreshAdmission = previousRefresh
  }
}
