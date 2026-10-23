import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { parseInventoryCounts } from './inventory-facts.mjs'
import { operationSignature, reconcilePendingOperation, RECONCILE_VERDICT } from './operation-reconciliation.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'

export const GATHER_RECOVERY_LIMITS = Object.freeze({ perStep: 2, perGoal: 6, records: 128 })

export function restoreGatherRecoveries(raw) {
  const records = new Map()
  let fault = raw !== undefined && (!Array.isArray(raw) || raw.length > GATHER_RECOVERY_LIMITS.records)
  for (const row of Array.isArray(raw) ? raw : []) {
    const [key, value] = Array.isArray(row) ? row : []
    if (typeof key !== 'string' || key.length > 600 || records.has(key) || !Array.isArray(value)
      || value.length > GATHER_RECOVERY_LIMITS.perGoal || !value.every(v => v && typeof v.step === 'string'
        && v.step.length <= 600 && typeof v.operation_key === 'string' && v.operation_key.length <= 192
        && ['claimed', 'admitted', 'satisfied'].includes(v.state))) { fault = true; continue }
    records.set(key, value.map(v => ({ step: v.step, operation_key: v.operation_key, state: v.state })))
  }
  return { records, fault }
}

// This is a terminal inventory-acquisition batch, never an assertion that each
// slot succeeded. Only the fresh committed inventory checkpoint can define its
// remaining demand. No receipt-only replay or mixed-effect settlement is allowed.
export function gatherDeficit(pending, contract, inventory) {
  const operations = pending?.operations
  if (!Array.isArray(operations) || !operations.length || operations.some(op => !['gather_resource', 'mine_resource_at'].includes(op.name) || !op.args)
    || operationSignature(operations) !== pending.signature || contract?.mode !== 'all'
    || !contract.requirements?.length || contract.requirements.some(r => r.kind !== 'inventory_count'
      || !Number.isSafeInteger(r.minimum) || r.minimum < 1) || !inventory) return undefined
  const names = new Set()
  const result = []
  for (const op of operations) {
    const { resource_name, count, search_radius } = op.args
    // Exact inventory item/resource equivalence must be supplied by native
    // mining facts (the caller verifies the prototype's products).
    if (typeof resource_name !== 'string' || names.has(resource_name) || !Number.isSafeInteger(count) || count < 1 || count > 1000
      || (op.name === 'gather_resource' && (!Number.isSafeInteger(search_radius) || search_radius < 1 || search_radius > 4096))
      || (op.name === 'mine_resource_at' && (!Number.isFinite(op.args.x) || !Number.isFinite(op.args.y)))) return undefined
    names.add(resource_name)
    const requirements = contract.requirements.filter(r => r.item_name === resource_name)
    if (!requirements.length) return undefined
    const minimum = Math.max(...requirements.map(r => r.minimum))
    const missing = Math.max(0, minimum - (inventory.get(resource_name) ?? 0))
    if (missing > count) return undefined // Recovery cannot expand the admitted acquisition authority.
    if (missing) result.push({ name: op.name, args: { ...op.args, count: missing } })
  }
  // Preserved stock outside this acquisition (AR's held furnace) must still exist.
  if (contract.requirements.some(r => !names.has(r.item_name) && (inventory.get(r.item_name) ?? 0) < r.minimum)) return undefined
  return result
}

export async function recoverGatherFailure(agent, { failureBoundary = false } = {}) {
  if (agent.gatherRecoveryFlight || !agent.active || !agent.epoch || agent.currentPendingAmendment()
    || agent.memory.pauseRecord?.(agent.activePlanKey())?.paused) return undefined
  const owner = agent.captureCheckpointOwner()
  const plan = getActivePlan(agent.memory.planningState?.(owner.key))
  const step = plan?.steps?.[plan.active_step_index]
  if (!step || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return undefined
  const goalKey = JSON.stringify([owner.key, owner.goalId])
  const stepKey = JSON.stringify([owner.planId, owner.planVersion, owner.stepId])
  const pending = agent.memory.pendingOperations?.(owner.key) ?? []
  if (!pending.length && agent.memory.gatherRecoveries?.get(goalKey)?.some(r => r.step === stepKey && r.state === 'claimed')) {
    await agent.assertCheckpointOwnerCurrent(owner)
    await agent.traceEvent('gather.recovery_exhausted', { request_id: owner.requestTrace?.id, goal_id: owner.goalId,
      plan_id: owner.planId, step_id: owner.stepId, reason: 'gather_recovery_interrupted', disposition: 'durable_guard_pause' })
    await agent.assertCheckpointOwnerCurrent(owner)
    const state = await agent.pausePersistentPlan('gather_recovery_interrupted', { pause_class: 'guard' }, owner)
    return { gather: 'paused', goalStatus: state?.status, operations: [] }
  }
  if (pending.length !== 1 || pending[0].goal_id !== owner.goalId || pending[0].plan_id !== owner.planId
    || pending[0].step_id !== owner.stepId || !pending[0].operations?.every(op => ['gather_resource', 'mine_resource_at'].includes(op.name))) return undefined
  const held = pending[0]
  if (agent.memory.currentPlan?.(owner.key)?.condition_wait?.state === 'active'
    || agent.memory.currentPlan?.(owner.key)?.persistent_runtime?.active === true) return { gather: 'deferred', reason: 'existing_wait_or_controller', operations: [] }
  const current = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    if (agent.currentPendingAmendment() || agent.memory.pauseRecord?.(owner.key)?.paused) throw new Error('gather_recovery_authority_changed')
    if (agent.memory.currentPlan?.(owner.key)?.condition_wait?.state === 'active'
      || agent.memory.currentPlan?.(owner.key)?.persistent_runtime?.active === true) {
      const error = new Error('gather_recovery_wait_changed')
      error.gatherDeferred = true
      throw error
    }
    if (owner.surfaceIndex !== undefined) {
      const runtime = await deploymentStatus(agent.rcon, { requireAllowed: true })
      agent.assertCheckpointOwnerIdentity(owner)
      if (runtime.surface_index !== owner.surfaceIndex) throw new Error('gather_recovery_surface_changed')
    }
  }
  const checked = async promise => { const value = await promise; await current(); return value }
  const emit = (event, reason, data = {}) => checked(agent.traceEvent(`gather.${event}`, {
    request_id: owner.requestTrace?.id, goal_id: owner.goalId, plan_id: owner.planId,
    plan_version: owner.planVersion, step_id: owner.stepId, operation_key: held.operation_key, reason, ...data,
  }, { requestId: owner.requestTrace?.id }))
  const pause = async reason => {
    await emit('recovery_exhausted', reason, { disposition: 'durable_guard_pause' })
    const state = await agent.pausePersistentPlan(reason, { pause_class: 'guard' }, owner)
    return { gather: 'paused', reason, goalStatus: state?.status, operations: [] }
  }
  agent.gatherRecoveryFlight = true
  try {
    const status = JSON.parse(await checked(agent.readTaskStatusRaw()))
    if (status.task_state !== 'idle' || status.queue_length !== 0 || status.active_batch) return failureBoundary
      ? { gather: 'deferred', reason: 'native_work_pending', operations: [] } : undefined
    const verdict = reconcilePendingOperation(held, { status, actor: agent.epoch })
    if (verdict.verdict !== RECONCILE_VERDICT.ADMITTED_PARTIAL || verdict.reason !== 'exact_terminal_gather_cancelled') return undefined
    const runtime = await checked(deploymentStatus(agent.rcon, { requireAllowed: true }))
    if (!runtime.idle) return undefined
    if (!Number.isSafeInteger(held.surface_index) || held.surface_index !== runtime.surface_index) return pause('gather_recovery_surface_unproven')
    owner.surfaceIndex = runtime.surface_index
    const follow = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
    const crafting = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
    if (follow.active !== false || crafting.task_active !== false || !crafting.native_queue || Object.keys(crafting.native_queue).length
      || crafting.persisted_owner || status.actor?.mining_state?.mining === true) return { gather: 'deferred', reason: 'native_controller_work', operations: [] }
    await emit('residual_detected', verdict.reason, { disposition: 'fresh_inventory_reconciliation' })
    agent.memory.gatherRecoveries ??= new Map()
    const ledger = agent.memory.gatherRecoveries.get(goalKey) ?? []
    if (agent.memory.gatherRecoveryFault) return pause('gather_recovery_ledger_unreadable')
    if (ledger.some(r => r.operation_key === held.operation_key)) return pause('gather_recovery_interrupted')
    if (ledger.length >= GATHER_RECOVERY_LIMITS.perGoal || ledger.filter(r => r.step === stepKey).length >= GATHER_RECOVERY_LIMITS.perStep
      || (!agent.memory.gatherRecoveries.has(goalKey) && agent.memory.gatherRecoveries.size >= GATHER_RECOVERY_LIMITS.records)) return pause('gather_recovery_exhausted')
    const raw = String(await checked(agent.rcon.command(agent.observationToolCommand('getInventoryItems', {}))))
    const inventory = raw.length <= 200000 ? parseInventoryCounts(raw) : undefined
    const operations = gatherDeficit(held, step.completion_contract, inventory)
    if (!operations) return pause('gather_recovery_facts_unproven')
    for (const op of operations) {
      const details = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getMiningDetails', { resource_or_item: op.args.resource_name }))))
      const resource = details.resources?.find(row => row.name === op.args.resource_name)
      const products = resource?.products
      if (details.found !== true || details.truncated !== false || !resource?.hand_mining || resource.infinite !== false || !Array.isArray(products) || products.length !== 1
        || products[0].name !== op.args.resource_name || products[0].type !== 'item'
        || products[0].amount !== 1 || (products[0].independent_probability ?? 1) !== 1 || resource.required_fluid) return pause('gather_recovery_yield_unproven')
    }
    // Recheck idle and the exact sealed receipt after inventory/prototype reads.
    // No cached overlay or admission-only witness can release an effect hold.
    const fresh = JSON.parse(await checked(agent.readTaskStatusRaw()))
    const finalCrafting = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
    if (fresh.follow?.active === true || fresh.actor?.mining_state?.mining === true || finalCrafting.task_active !== false
      || !finalCrafting.native_queue || Object.keys(finalCrafting.native_queue).length || finalCrafting.persisted_owner) return { gather: 'deferred', reason: 'native_controller_work', operations: [] }
    const freshVerdict = reconcilePendingOperation(held, { status: fresh, actor: agent.epoch })
    if (freshVerdict.reason !== verdict.reason || freshVerdict.batch_ref !== verdict.batch_ref
      || freshVerdict.receipt_tick !== verdict.receipt_tick) return pause('gather_recovery_native_changed')
    if (agent.memory.pendingOperations(owner.key).length !== 1
      || agent.memory.pendingOperations(owner.key)[0].operation_key !== held.operation_key) return pause('gather_recovery_pending_changed')
    const claim = { step: stepKey, operation_key: held.operation_key, state: 'claimed' }
    agent.memory.gatherRecoveries.set(goalKey, [...ledger, claim])
    await checked(agent.persistState({ strict: true })) // Charge before clearing or admitting; restart cannot renew it.
    await emit('reconciled', 'fresh_checkpoint_deficit', { inventory: Object.fromEntries(inventory), operations, attempt: ledger.length + 1,
      disposition: operations.length ? 'admit_only_missing_effects' : 'ordinary_checkpoint_validation', plan_changed: false })
    agent.memory.clearPendingOperation(owner.key, { operationKey: held.operation_key })
    await checked(agent.persistState({ strict: true }))
    if (!operations.length) {
      claim.state = 'satisfied'
      await checked(agent.persistState({ strict: true }))
      const fresh = await agent.closeActiveStepOnFreshRead({ previousState: agent.memory.currentPlan(owner.key), trigger: 'gather_reconciled' })
      if (!fresh.closed) return pause('gather_recovery_checkpoint_changed')
      // Starting a fresh read is not settlement. Publish success only after the
      // ordinary evaluator closes this exact checkpoint, including when the
      // unrelated next checkpoint needs a contract and pauses its continuation.
      const completionOwner = fresh.contractPause ? fresh.terminalOwner : fresh.continuationOwner
      const completionOptions = { advanced: !fresh.contractPause }
      agent.assertCheckpointOwnerIdentity(completionOwner, completionOptions)
      await agent.traceEvent('gather.checkpoint_closed', {
        request_id: owner.requestTrace?.id, goal_id: owner.goalId, plan_id: owner.planId,
        plan_version: owner.planVersion, step_id: owner.stepId, operation_key: held.operation_key,
        reason: 'verified_checkpoint_closed', disposition: 'verified_checkpoint_closed',
      }, { requestId: owner.requestTrace?.id })
      agent.assertCheckpointOwnerIdentity(completionOwner, completionOptions)
      if (fresh.contractPause) return fresh.contractPause
      return agent.continueAfterFreshStepClose(fresh, { chatMessage: '', stepId: owner.stepId, plan: [], currentStep: owner.stepIndex, operations: [] }, runtime)
    }
    const previousAdmission = agent.gatherAdmission
    owner.reconciledOperationKey = held.operation_key
    agent.gatherAdmission = owner
    let result
    try { result = await agent.commitPlan({ chatMessage: '', stepId: owner.stepId, plan: [], currentStep: 0, operations }) }
    catch (error) {
      if (!error.gatherNotAdmitted) throw error
      return pause(`gather_recovery_${error.gatherDisposition ?? 'preflight'}_${String(error.preflight.code).slice(0, 100)}`)
    } finally { if (agent.gatherAdmission === owner) agent.gatherAdmission = previousAdmission }
    await current()
    claim.state = 'admitted'
    await checked(agent.persistState({ strict: true }))
    await emit('recovery_continued', 'missing_gather_admitted', { operations, disposition: 'native_callback', plan_changed: false })
    return result
  } catch (error) {
    if (error.gatherDeferred) return { gather: 'deferred', reason: error.message, operations: [] }
    throw error
  } finally { agent.gatherRecoveryFlight = false }
}

export async function correctMiningLocation(agent, proposed, preflight) {
  const op = proposed.operations?.[0]
  const candidate = preflight.resource_correction
  if (agent.miningLocationFlight || op?.name !== 'mine_resource_at' || proposed.operations.length !== 1
    || !['resource_source_not_found', 'resource_source_insufficient'].includes(preflight.code) || !candidate
    || agent.currentPendingAmendment() || agent.memory.pendingOperation?.(agent.activePlanKey())) return undefined
  const owner = agent.captureCheckpointOwner()
  const plan = getActivePlan(agent.memory.planningState?.(owner.key))
  const contract = plan?.steps?.[plan.active_step_index]?.completion_contract
  if (![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status) || proposed.stepId !== owner.stepId
    || contract?.mode !== 'all' || contract.requirements.some(r => r.kind !== 'inventory_count')
    || !contract.requirements.some(r => r.item_name === op.args.resource_name)) return undefined
  const distance = (candidate.position?.x - op.args.x) ** 2 + (candidate.position?.y - op.args.y) ** 2
  if (!(distance > 0 && distance <= 25) || candidate.radius !== 5 || candidate.resource_name !== op.args.resource_name
    || candidate.origin?.x !== op.args.x || candidate.origin?.y !== op.args.y || candidate.amount < op.args.count) return undefined
  const checked = async promise => {
    const value = await promise
    await agent.assertCheckpointOwnerCurrent(owner)
    if (agent.currentPendingAmendment() || agent.memory.pauseRecord?.(owner.key)?.paused) throw new Error('gather_location_authority_changed')
    if (owner.surfaceIndex !== undefined) {
      const runtime = await deploymentStatus(agent.rcon, { requireAllowed: true })
      agent.assertCheckpointOwnerIdentity(owner)
      if (runtime.surface_index !== owner.surfaceIndex) throw new Error('gather_location_surface_changed')
    }
    return value
  }
  const runtime = await checked(deploymentStatus(agent.rcon, { requireAllowed: true }))
  if (!runtime.idle || runtime.surface_index !== candidate.surface_index) return undefined
  owner.surfaceIndex = runtime.surface_index
  const inventory = parseInventoryCounts(String(await checked(agent.rcon.command(agent.observationToolCommand('getInventoryItems', {})))))
  if (!inventory) return undefined
  const requirement = Math.max(...contract.requirements.filter(r => r.item_name === op.args.resource_name).map(r => r.minimum))
  if (op.args.count > requirement - (inventory.get(op.args.resource_name) ?? 0)) return undefined
  const goalKey = JSON.stringify([owner.key, owner.goalId]); const stepKey = JSON.stringify([owner.planId, owner.planVersion, owner.stepId])
  agent.memory.gatherRecoveries ??= new Map()
  const ledger = agent.memory.gatherRecoveries.get(goalKey) ?? []
  if (agent.memory.gatherRecoveryFault || ledger.length >= GATHER_RECOVERY_LIMITS.perGoal
    || ledger.filter(row => row.step === stepKey).length >= GATHER_RECOVERY_LIMITS.perStep
    || (!agent.memory.gatherRecoveries.has(goalKey) && agent.memory.gatherRecoveries.size >= GATHER_RECOVERY_LIMITS.records)) {
    const state = await agent.pausePersistentPlan('gather_location_recovery_exhausted', { pause_class: 'guard' }, owner)
    return { handled: true, result: { goalStatus: state?.status, operations: [] } }
  }
  const claim = { step: stepKey, operation_key: `location:${owner.requestTrace?.id}:${operationSignature([op])}`.slice(0,192), state: 'claimed' }
  agent.memory.gatherRecoveries.set(goalKey, [...ledger, claim])
  await checked(agent.persistState({ strict: true }))
  const corrected = { ...op, args: { ...op.args, x: candidate.position.x, y: candidate.position.y } }
  await checked(agent.traceEvent('mining.location_corrected', { request_id: owner.requestTrace?.id, goal_id: owner.goalId,
    plan_id: owner.planId, step_id: owner.stepId, reason: preflight.code, requested: op.args, corrected: corrected.args,
    radius: 5, disposition: 'ordinary_preflight_and_admission', plan_changed: false }))
  agent.memory.recordBoardEvidence?.(owner.key, { kind: 'mining_location_corrected', ref: claim.operation_key,
    plan_id: owner.planId, step_id: owner.stepId,
    summary: `Position reminder: ${op.args.resource_name} (${op.args.x},${op.args.y}) was off; harness chose (${corrected.args.x},${corrected.args.y}) within 5 tiles. Goal unchanged; refresh positions.` })
  await checked(agent.persistState({ strict: true }))
  agent.messages.push({ role: 'user', content: `[HARNESS] Mining position reminder: the suggested ${op.args.resource_name} position (${op.args.x}, ${op.args.y}) was off. The harness selected the same resource at (${corrected.args.x}, ${corrected.args.y}), within 5 tiles, and owns the remaining native work. This reminder does not establish completion. The committed goal and checkpoint are unchanged; use fresh resource positions next time.` })
  agent.miningLocationFlight = true
  const previousAdmission = agent.gatherAdmission
  agent.gatherAdmission = owner
  try {
    let result
    try { result = await agent.commitPlan({ ...proposed, operations: [corrected] }) }
    catch (error) {
      if (!error.gatherNotAdmitted) throw error
      const state = await agent.pausePersistentPlan(`gather_location_${error.gatherDisposition ?? 'preflight'}_${String(error.preflight.code).slice(0, 100)}`, { pause_class: 'guard' }, owner)
      return { handled: true, result: { goalStatus: state?.status, operations: [] } }
    }
    await agent.assertCheckpointOwnerCurrent(owner)
    claim.state = 'admitted'
    await checked(agent.persistState({ strict: true }))
    return { handled: true, result }
  } finally {
    agent.miningLocationFlight = false
    if (agent.gatherAdmission === owner) agent.gatherAdmission = previousAdmission
  }
}
