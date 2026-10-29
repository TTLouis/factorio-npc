import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { operationIdentity, operationSignature, sanitizePendingOperation, completedOperationReceipt } from './operation-reconciliation.mjs'
import { parseInventoryCounts } from './inventory-facts.mjs'
import { authorizationOf, checkGrant } from './authorization.mjs'
import { STALE_REPLY_ERROR_CODE } from './agent-context.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'

function superseded(reason) { const error = new Error(reason); error.code = STALE_REPLY_ERROR_CODE; return error }

export const STOCK_BARRIER_LIMITS = Object.freeze({ perStep: 2, perGoal: 6, records: 128 })
const LIVE = new Set(['claimed', 'prefix_pending', 'suffix_pending'])
const acquisition = op => ['gather_resource', 'mine_resource_at', 'harvest_product'].includes(op?.name)
  || op?.name === 'move_items_exact' && op.args?.to_entity === false
const consumer = op => op?.name === 'supply_entity' || op?.name === 'move_items_exact' && op.args?.to_entity === true

// A single ordered acquisition/transfer barrier. Never select a convenient
// subset of an arbitrary batch, change quantities, or guess mining products.
export function stockDependencyShape(operations) {
  if (!Array.isArray(operations) || operations.length < 2 || operations.length > 16) return undefined
  const split = operations.findIndex(op => !acquisition(op))
  if (split < 1 || !operations.slice(split).every(consumer)) return undefined
  return { split, signature: operationSignature(operations) }
}

export function restoreStockDependencyBarriers(raw) {
  const records = new Map()
  let fault = raw !== undefined && (!Array.isArray(raw) || raw.length > STOCK_BARRIER_LIMITS.records)
  if (fault) return { records, fault }
  for (const row of Array.isArray(raw) ? raw : []) {
    const [key, claims] = Array.isArray(row) ? row : []
    let scope
    try { scope = JSON.parse(key) } catch { /* Invalid scope is faulted below. */ }
    if (typeof key !== 'string' || key.length > 600 || records.has(key) || !Array.isArray(claims)
      || !Array.isArray(scope) || scope.length !== 2 || scope.some(s => typeof s !== 'string' || !s || s.length > 240) || JSON.stringify(scope) !== key
      || !claims.length || claims.length > STOCK_BARRIER_LIMITS.perGoal) { fault = true; continue }
    const validated = []
    for (const claim of claims) {
      const shape = stockDependencyShape(claim?.operations)
      const strings = ['semantic_step_id', 'goal_id', 'plan_id', 'step_id', 'session']
      const pending = claim?.pending && sanitizePendingOperation(claim.pending)
      const segment = claim?.operations?.slice(claim.state === 'prefix_pending' ? 0 : claim.split,
        claim.state === 'prefix_pending' ? claim.split : undefined)
      if (!shape || shape.split !== claim.split || shape.signature !== claim.signature
        || claim.goal_id !== scope[1]
        || strings.some(field => typeof claim[field] !== 'string' || !claim[field] || claim[field].length > 600)
        || ['actor_id', 'epoch', 'surface_index', 'plan_version'].some(field => !Number.isSafeInteger(claim[field]) || claim[field] < 1)
        || ![...LIVE, 'completed', 'paused'].includes(claim.state)
        || (claim.state.endsWith('_pending') && (!pending || pending.protocol_version !== 2
          || pending.goal_id !== claim.goal_id || pending.plan_id !== claim.plan_id || pending.step_id !== claim.step_id
          || pending.actor?.actor_id !== claim.actor_id || pending.actor?.epoch !== claim.epoch
          || pending.surface_index !== claim.surface_index
          || pending.operations?.length !== segment.length || pending.operations.some((op, i) => op.identity !== operationIdentity(segment[i]))
          || pending.signature !== operationSignature(claim.operations.slice(claim.state === 'prefix_pending' ? 0 : claim.split,
            claim.state === 'prefix_pending' ? claim.split : undefined))))) { fault = true; continue }
      validated.push(structuredClone({ ...claim, ...(pending ? { pending } : {}) }))
    }
    if (validated.filter(c => LIVE.has(c.state)).length > 1
      || validated.some(c => validated.filter(other => other.semantic_step_id === c.semantic_step_id).length > STOCK_BARRIER_LIMITS.perStep)) fault = true
    records.set(key, validated)
  }
  return { records, fault }
}

function goalKey(agent) {
  return JSON.stringify([agent.activePlanKey(), agent.memory.planningState?.(agent.activePlanKey())?.goal?.goal_id])
}
export function activeStockDependencyBarrier(agent) {
  return agent.memory.stockDependencyBarriers?.get(goalKey(agent))?.find(c => LIVE.has(c.state))
}

function context(agent, claim) {
  const owner = agent.captureCheckpointOwner()
  const intake = agent.requestAdmissionOwner; const amendment = agent.currentPendingAmendment()
  const actor = JSON.stringify(agent.epoch)
  const grant = agent.memory.currentGoalGrant?.(owner.key)
  const fence = async () => {
    await agent.assertCheckpointOwnerCurrent(owner)
    const held = getActivePlan(agent.memory.planningState?.(owner.key))
    const semanticStep = held?.steps?.[held.active_step_index]?.semantic_step_id
    if (amendment || agent.currentPendingAmendment() !== amendment || agent.requestAdmissionOwner !== intake
      || JSON.stringify(agent.epoch) !== actor || !agent.active || agent.memory.pauseRecord?.(owner.key)?.paused
      || agent.memory.currentPlan?.(owner.key)?.condition_wait?.state === 'active'
      || agent.memory.currentPlan?.(owner.key)?.persistent_runtime?.active === true
      || (claim && (owner.goalId !== claim.goal_id || owner.planId !== claim.plan_id || owner.planVersion !== claim.plan_version
        || owner.stepId !== claim.step_id || semanticStep !== claim.semantic_step_id || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(held?.status)
        || agent.epoch?.actor_id !== claim.actor_id || agent.epoch?.epoch !== claim.epoch
        || agent.epoch?.surface_index !== claim.surface_index || agent.epoch?.session !== claim.session))) throw superseded('stock_dependency_owner_changed')
    if (grant && !checkGrant(authorizationOf(agent.memory.planningState(owner.key)), agent.memory.planningState(owner.key)?.goal,
      { grant_id: grant.grant_id, grant_revision: grant.revision, actor_id: agent.epoch?.actor_id, actor_epoch: agent.epoch?.epoch }).ok) throw superseded('stock_dependency_authority_changed')
  }
  const checked = async promise => { const value = await promise; await fence(); return value }
  const emit = (event, reason, extra = {}) => checked(agent.traceEvent(`stock_dependency.${event}`, {
    request_id: owner.requestTrace?.id, goal_id: owner.goalId, plan_id: owner.planId, plan_version: owner.planVersion,
    step_id: owner.stepId, semantic_step_id: claim?.semantic_step_id, reason, ...extra,
  }, { requestId: owner.requestTrace?.id }))
  const idle = async () => {
    const status = JSON.parse(await checked(agent.readTaskStatusRaw()))
    const follow = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
    const crafting = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
    const journal = nativeAdmissionJournal(status.admission_journal)
    const uncertain = !journal.known || journal.unresolved
    const nativeIdle = status.task_state === 'idle' && status.queue_empty === true && status.queue_length === 0 && !status.active_batch
      && status.actor?.mining_state?.mining !== true && follow.active === false && crafting.task_active === false
      && crafting.native_queue && Object.keys(crafting.native_queue).length === 0 && !crafting.persisted_owner
    return { status, journal, uncertain, nativeIdle, idle: !uncertain && nativeIdle }
  }
  const pause = async reason => {
    await fence()
    if (claim) claim.state = 'paused'
    await checked(agent.persistState({ strict: true }))
    await emit('exhausted', reason, { disposition: 'durable_guard_pause' })
    const state = await agent.pausePersistentPlan(reason, { pause_class: 'guard' }, owner)
    return { stockDependency: 'paused', reason, goalStatus: state?.status, operations: [] }
  }
  return { owner, fence, checked, emit, idle, pause, grant }
}

// Called synchronously inside the ordinary durable prepare-before-send seam.
export function bindStockDependencyAdmission(agent, pending) {
  const admission = agent.stockDependencyAdmission
  if (!admission) return
  const { claim, segment } = admission
  const expected = claim.operations.slice(segment === 'prefix' ? 0 : claim.split, segment === 'prefix' ? claim.split : undefined)
  if (!pending || pending.signature !== operationSignature(expected) || pending.goal_id !== claim.goal_id
    || pending.plan_id !== claim.plan_id || pending.step_id !== claim.step_id) throw new Error('stock_dependency_admission_mismatch')
  claim.pending = structuredClone(pending)
  claim.state = `${segment}_pending`
}

async function admit(agent, claim, segment, ctx) {
  await ctx.fence()
  if (!(await ctx.idle()).idle || (agent.memory.pendingOperations?.(ctx.owner.key) ?? []).length) return ctx.pause('stock_dependency_native_busy')
  const admission = { claim, segment, fence: ctx.fence, idleFence: async () => {
    await ctx.fence()
    if (!(await ctx.idle()).idle) throw new Error('stock_dependency_native_busy')
  } }
  const previous = agent.stockDependencyAdmission
  agent.stockDependencyAdmission = admission
  try {
    return await agent.commitPlan({ chatMessage: '', stepId: claim.step_id, plan: [], currentStep: 0,
      operations: structuredClone(claim.operations.slice(segment === 'prefix' ? 0 : claim.split, segment === 'prefix' ? claim.split : undefined)) })
  } catch (error) {
    if (error.stockDependencyNotAdmitted) return ctx.pause(`stock_dependency_${segment}_preflight_${error.preflight?.code ?? 'unknown'}`)
    throw error
  } finally { if (agent.stockDependencyAdmission === admission) agent.stockDependencyAdmission = previous }
}

export async function startStockDependencyBarrier(agent, proposed, originalError, { residual = false } = {}) {
  if (agent.stockDependencyAdmission || agent.productionAdmission || agent.gatherAdmission
    || !['batch_stock_unverified_dependency', 'supply_missing'].includes(originalError?.preflight?.code)) return undefined
  const shape = stockDependencyShape(proposed.operations)
  const planning = agent.memory.planningState?.(agent.activePlanKey()); const plan = getActivePlan(planning)
  const step = plan?.steps?.[plan.active_step_index]
  if (!shape || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status)
    || !step?.semantic_step_id || proposed.stepId !== step.step_id) return undefined
  const ctx = context(agent)
  await ctx.fence()
  if (!ctx.grant) return ctx.pause('stock_dependency_authority_unproven')
  if (agent.memory.stockDependencyBarrierFault) return ctx.pause('stock_dependency_ledger_unreadable')
  if (activeStockDependencyBarrier(agent)) return ctx.pause('stock_dependency_already_active')
  if (agent.batchInFlight || (agent.memory.pendingOperations?.(ctx.owner.key) ?? []).length || !(await ctx.idle()).idle) return ctx.pause('stock_dependency_unresolved_work')
  // Re-run the shared ledger independently of the first refusal. Missing native
  // facts, another refusal, or an injected early-check miss cannot authorize a split.
  let proof
  try { await ctx.checked(agent.preflightOperations(proposed.operations)) }
  catch (error) { await ctx.fence(); proof = error }
  if (proof?.preflight?.code !== 'batch_stock_unverified_dependency' || proof.preflight.operation_index < shape.split
    || proof.preflightResults?.length !== proposed.operations.length
    || proof.preflightResults.slice(0, shape.split).some(fact => fact?.ok !== true)) return undefined
  const authority = agent.memory.checkOperationAdmission?.(ctx.owner.key, { operations: proposed.operations,
    preflight: proof.preflightResults, actor: { actor_id: agent.epoch.actor_id, actor_epoch: agent.epoch.epoch } }, { requestId: ctx.owner.requestTrace?.id })
  if (authority?.ok !== true || await ctx.checked(agent.checkpointStockExtractionConflict(proposed.operations))) return ctx.pause('stock_dependency_authority_unproven')
  agent.memory.stockDependencyBarriers ??= new Map()
  const key = goalKey(agent); const ledger = agent.memory.stockDependencyBarriers.get(key) ?? []
  if (ledger.length >= STOCK_BARRIER_LIMITS.perGoal || ledger.filter(c => c.semantic_step_id === step.semantic_step_id).length >= STOCK_BARRIER_LIMITS.perStep
    || (!agent.memory.stockDependencyBarriers.has(key) && agent.memory.stockDependencyBarriers.size >= STOCK_BARRIER_LIMITS.records)) return ctx.pause('stock_dependency_limit_exhausted')
  const claim = { semantic_step_id: step.semantic_step_id, goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
    step_id: step.step_id, actor_id: agent.epoch.actor_id, epoch: agent.epoch.epoch, surface_index: agent.epoch.surface_index,
    session: agent.epoch.session, operations: structuredClone(proposed.operations), ...shape, state: 'claimed' }
  agent.memory.stockDependencyBarriers.set(key, [...ledger, claim])
  await ctx.checked(agent.persistState({ strict: true }))
  if (residual) await ctx.emit('residual_detected', 'early_barrier_missed', { disposition: 'fresh_shared_preflight_reconciliation' })
  await ctx.emit('barrier_staged', 'unverified_acquisition_dependency', { original_operations: claim.operations, split: claim.split,
    semantic_step_id: claim.semantic_step_id,
    attempt: ledger.filter(c => c.semantic_step_id === step.semantic_step_id).length + 1, limit: STOCK_BARRIER_LIMITS.perStep,
    disposition: 'ordered_prefix_then_exact_receipt_then_fresh_suffix', preflight: proof.preflight })
  return admit(agent, claim, 'prefix', context(agent, claim))
}

export async function continueStockDependencyBarrier(agent) {
  if (agent.stockDependencyAdmission) return undefined
  const claim = activeStockDependencyBarrier(agent)
  if (agent.memory.stockDependencyBarrierFault && agent.active) return context(agent, claim).pause('stock_dependency_ledger_unreadable')
  if (!claim) return undefined
  const ctx = context(agent, claim)
  await ctx.fence()
  if (agent.memory.stockDependencyBarrierFault) return ctx.pause('stock_dependency_ledger_unreadable')
  if (!claim.pending || claim.state === 'claimed') return ctx.pause('stock_dependency_interrupted_before_admission')
  const { status, journal, idle, nativeIdle, uncertain } = await ctx.idle()
  const open = journal.records.filter(row => ['admitted', 'admitting', 'uncertain'].includes(row.state))
  if (!nativeIdle && journal.known && open.length === 1 && open[0].state === 'admitted'
    && open[0].operation_key === claim.pending.operation_key && open[0].signature === claim.pending.signature
    && open[0].actor_id === claim.actor_id && open[0].epoch === claim.epoch) return { stockDependency: 'waiting', operations: [], reason: 'owned_native_callback_pending' }
  if (uncertain) return ctx.pause('stock_dependency_native_outcome_uncertain')
  if (!idle) return ctx.pause('stock_dependency_unowned_native_work')
  const receipt = completedOperationReceipt(claim.pending, { status, actor: agent.epoch })
  if (!receipt) return ctx.pause('stock_dependency_receipt_unproven')
  await ctx.checked(agent.settleOutstandingOperation(JSON.stringify(status), claim.pending.operation_key))
  if ((agent.memory.pendingOperations?.(ctx.owner.key) ?? []).length) return ctx.pause('stock_dependency_effect_unresolved')
  agent.batchInFlight = false
  if (claim.state === 'suffix_pending') {
    claim.state = 'completed'
    await ctx.checked(agent.persistState({ strict: true }))
    await ctx.emit('completed', 'exact_suffix_receipt', { operation_key: claim.pending.operation_key, batch_ref: receipt.batch_ref,
      disposition: 'ordinary_checkpoint_validation', plan_changed: false })
    return undefined
  }
  const raw = await ctx.checked(agent.rcon.command(agent.observationToolCommand('getInventoryItems', {})))
  const inventory = parseInventoryCounts(String(raw))
  if (!inventory) return ctx.pause('stock_dependency_inventory_unreadable')
  await ctx.emit('prefix_settled', 'exact_acquisition_receipt_and_fresh_stock', { operation_key: claim.pending.operation_key,
    batch_ref: receipt.batch_ref, inventory: Object.fromEntries(inventory), disposition: 'revalidate_unchanged_suffix' })
  // The suffix's normal admission performs fresh stock/target/preservation
  // checks. A positive gather receipt alone never supplies a guessed item yield.
  return admit(agent, claim, 'suffix', ctx)
}
