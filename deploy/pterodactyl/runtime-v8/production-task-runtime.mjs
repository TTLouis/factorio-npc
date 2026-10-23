import { deploymentStatus } from './supervisor-adapter.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { parseInventoryCounts } from './handoff-packet.mjs'
import { materialOwnerKey } from './material-ledger.mjs'
import { normalizeCounts, recipeForItem } from './quantity-compiler.mjs'
import { advanceProductionTask, createProductionTask, machineFacts, normalizeProductionIntent, productionScopeMatches, PRODUCTION_LIMITS, recoverProductionTask, restoreProductionTask } from './production-task.mjs'

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
    const detail = JSON.parse(raw)
    if (detail.found !== true || detail.entity?.unit_number !== unit_number) throw new Error('production_machine_identity_missing')
    agent.recordLiveEntityToolResult('getEntityStatus', raw)
    machines.push(machineFacts(detail.entity))
  }
  return { owner: s.materialOwner, actor_id: status.actor_id, epoch: status.epoch, native_idle: true, pending: false,
    fresh: true, inventory: normalizeCounts(Object.fromEntries(inventory)), recipes, machines }
}

export async function startProductionTask(agent, plan) {
  const s = scope(agent)
  if (agent.completionProtocolVersion < 3 || agent.agentContext.role !== 'executor'
    || ![s.owner.stepId, agent.memory.currentPlan?.(s.owner.key)?.task_board?.active_step_id].includes(plan.stepId)
    || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(s.plan?.status) || plan.operations?.length !== 0
    || plan.semanticCompletion || plan.checkpoint || plan.plannerReview) throw agent.roleContractError('invalid_production_task', 'productionTask requires the committed executor step, empty operations and no completion/review claim')
  const intent = normalizeProductionIntent(plan.productionTask)
  if (!productionScopeMatches(intent, s.step.completion_contract)) throw agent.roleContractError('production_scope_mismatch', 'Targets must exactly match finite inventory requirements of this committed step')
  const supply = s.step.execution_guidance?.materialSupply
  if (supply?.mode === 'direct_feed' && intent.resources.some(row => row.item_name === supply.resource)) throw agent.roleContractError('production_supply_drift', 'Direct-feed steps cannot acquire their ore by hand')
  agent.memory.productionTasks ??= new Map()
  pruneClosedProductionRecords(agent.memory)
  if (agent.memory.productionRestoreFault) return pause(agent, s.owner, 'production_ledger_unreadable')
  const key = recordKey(s)
  const previous = agent.memory.productionTasks.get(key)
  if (previous && JSON.stringify(previous.intent) !== JSON.stringify(intent)) throw agent.roleContractError('production_intent_immutable', 'An admitted production intent cannot change its targets, bindings or fuel allowance')
  if (!previous) {
    if (agent.memory.productionTasks.size >= PRODUCTION_RECORD_LIMIT) return pause(agent, s.owner, 'production_ledger_exhausted')
    const status = await checked(agent, s.owner, deploymentStatus(agent.rcon, { requireAllowed: true }))
    const protected_stock = protectedStock(s.step, intent)
    await store(agent, s.owner, key, createProductionTask({ intent, owner: s.materialOwner, actor_id: status.actor_id, epoch: status.epoch, protected_stock }))
    await checked(agent, s.owner, agent.traceEvent('production.started', { plan_id: s.owner.planId, step_id: s.owner.stepId, intent }))
  }
  const result = await continueProductionTask(agent)
  return result === undefined ? agent.runTurn() : result
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
  agent.productionFlight = true
  try {
    for (;;) {
      await agent.assertCheckpointOwnerCurrent(s.owner)
      const status = await checked(agent, s.owner, deploymentStatus(agent.rcon, { requireAllowed: true }))
      if (status.actor_id !== task.actor_id || status.epoch !== task.epoch) return pause(agent, s.owner, 'production_actor_changed')
      if (!status.idle || pending(agent, s.owner.key) || agent.batchInFlight) return { production: 'deferred', reason: 'native_or_uncertain_work_pending', operations: [] }
      let result
      try { result = advanceProductionTask(task, await factsFor(agent, s, task, status)) }
      catch (error) {
        await agent.assertCheckpointOwnerCurrent(s.owner)
        result = { action: 'pause', reason: error.message, task: { ...task, status: 'paused', pause_reason: error.message } }
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
  } finally { agent.productionFlight = false }
}
