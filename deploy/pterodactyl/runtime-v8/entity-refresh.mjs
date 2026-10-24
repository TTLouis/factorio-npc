import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { claimControllerRecovery } from './controller-liveness.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'
import { machineFacts } from './production-task.mjs'
import { STALE_REPLY_ERROR_CODE } from './agent-context.mjs'

export const REFRESHED_ENTITY_PLAN = Symbol('harness-refreshed-entity-plan')
const phases = new Set(['claimed', 'bound', 'continued', 'settled'])
export function validateRefreshedEntity(raw, { unit, locator, placement, actorId, surfaceIndex, forceIndex }) {
  if (typeof raw !== 'string' || raw.length > 65536) throw new Error('entity_refresh_read_truncated')
  const detail = JSON.parse(raw)
  const entity = detail?.entity
  if (detail.found !== true || detail.actor_id !== actorId || detail.surface_index !== surfaceIndex
    || detail.force_index !== forceIndex || !Number.isSafeInteger(forceIndex) || forceIndex < 1
    || entity?.unit_number !== unit || entity.name !== locator.name
    || !Number.isFinite(entity.position?.x) || !Number.isFinite(entity.position?.y)
    || Math.hypot(entity.position.x - locator.position.x, entity.position.y - locator.position.y) > 0.25
    || (locator.type && entity.type !== locator.type)
    || (entity.last_user && entity.last_user !== placement.placed_last_user)) throw new Error('entity_refresh_identity_unproven')
  return detail
}
export function restoreEntityRefreshClaims(raw) {
  const records = new Map()
  let fault = raw !== undefined && (!Array.isArray(raw) || raw.length > 128)
  for (const row of Array.isArray(raw) ? raw.slice(0, 128) : []) {
    const [key, value] = Array.isArray(row) ? row : []
    let fields, basis
    try { fields = JSON.parse(key); basis = JSON.parse(value?.basis) } catch { /* Refused below. */ }
    if (typeof key !== 'string' || key.length > 1500 || records.has(key)
      || !Array.isArray(fields) || fields.length !== 5 || ![0, 1, 2, 4].every(i => typeof fields[i] === 'string' && fields[i].length > 0 && fields[i].length <= 240)
      || !Number.isSafeInteger(fields[3]) || fields[3] < 1
      || !Array.isArray(basis) || basis.length !== 6 || basis[0] !== fields[1] || basis[1] !== fields[2] || basis[2] !== fields[4]
      || !(basis[3] === null || typeof basis[3] === 'string' && basis[3].length <= 240)
      || !basis.slice(4).every(n => Number.isSafeInteger(n) && n > 0)
      || !Number.isSafeInteger(value?.unit) || value.unit < 1 || !phases.has(value.state)
      || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 240
      || typeof value.basis !== 'string' || value.basis.length > 1500) { fault = true; continue }
    records.set(key, { unit: value.unit, state: value.state, basis: value.basis, requestId: value.requestId })
  }
  return { records, fault }
}
function claimKey(owner) { return JSON.stringify([owner.key, owner.goalId, owner.planId, owner.planVersion, owner.stepId]) }
function actorStamp(agent) { return JSON.stringify([agent.epoch?.session, agent.epoch?.actor_id, agent.epoch?.epoch, agent.epoch?.surface_index]) }
// A historical locator is a hint, never scope authority. Old model-facing
// projections omitted surface_index; only a fresh native deployment/body/entity
// agreement can supply it. An explicit mismatching/invalid scope stays refused.
function refreshSurface(locatorSurface, runtime) {
  if (!Number.isSafeInteger(runtime.surface_index) || runtime.surface_index < 1
    || locatorSurface !== undefined && locatorSurface !== runtime.surface_index) throw new Error('entity_refresh_actor_or_surface_changed')
  return runtime.surface_index
}
function heldWork(agent, owner) {
  const state = agent.memory.currentPlan(owner.key)
  return state?.condition_wait?.state === 'active' || state?.persistent_runtime?.active === true
}
function disposition(agent, action, result) {
  const owner = agent.captureCheckpointOwner()
  const actor = actorStamp(agent)
  const conversation = agent.agentContext.conversationSeq
  return { action, result, owner, current: () => agent.checkpointOwnerCurrent(owner)
    && actorStamp(agent) === actor && agent.agentContext.conversationSeq === conversation }
}
export function collectionIdleFence(agent, owner, fence) {
  const checked = async promise => { const value = await promise; await fence(); return value }
  return async () => {
    const runtime = await fence()
    const status = JSON.parse(await checked(agent.readTaskStatusRaw()))
    const pending = agent.memory.pendingOperations?.(owner.key) ?? []
    const successor = agent.entityRefreshAdmission
    const ownPrepared = pending.length === 1 && successor?.owner === owner && agent.productionAdmission
      && pending[0].operation_key === successor.pendingKey && pending[0].state === 'sent'
      && pending[0].request_id === owner.requestTrace.id && pending[0].goal_id === owner.goalId
      && pending[0].plan_id === owner.planId && pending[0].step_id === owner.stepId
      && pending[0].signature === successor.pendingSignature
      && pending[0].operations.every(op => op.name === 'move_items_exact')
    const journal = status.admission_journal?.records ?? status.admission_journal
    if (pending.length && !ownPrepared || Array.isArray(journal) && journal.some(row => ['uncertain', 'admitting'].includes(row.state))) {
      throw new Error('entity_refresh_native_outcome_uncertain')
    }
    const follow = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
    const crafting = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
    if (runtime.idle !== true || agent.batchInFlight || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0
      || status.active_batch || follow.active !== false || crafting.task_active !== false || !crafting.native_queue
      || Object.keys(crafting.native_queue).length || crafting.persisted_owner || status.actor?.mining_state?.mining) {
      const error = new Error('entity_refresh_native_work_pending')
      error.entityRefreshBusy = true
      throw error
    }
  }
}

export function restoredCollectionFence(agent, task, owner) {
  const stamp = actorStamp(agent)
  const conversation = agent.agentContext.conversationSeq
  const surfaces = task.intent.producers.map(row => agent.exactTargetLocator(row.unit_number)?.surface_index)
  owner.surfaceIndex = surfaces[0]
  let forceIndex
  const identity = () => {
    agent.assertCheckpointOwnerIdentity(owner)
    if (actorStamp(agent) !== stamp || agent.agentContext.conversationSeq !== conversation || agent.currentPendingAmendment()) {
      const error = new Error('Collection continuation cancelled or superseded')
      error.code = STALE_REPLY_ERROR_CODE
      throw error
    }
  }
  const fence = async () => {
    identity()
    await agent.assertCheckpointOwnerCurrent(owner)
    identity()
    if (heldWork(agent, owner)) {
      const error = new Error('existing_wait_or_controller')
      error.entityRefreshBusy = true
      throw error
    }
    const runtime = await deploymentStatus(agent.rcon, { requireAllowed: true })
    identity()
    if (runtime.actor_id !== task.actor_id || runtime.epoch !== task.epoch
      || surfaces.some(surface => refreshSurface(surface, runtime) !== runtime.surface_index)) throw new Error('collection_actor_or_surface_changed')
    owner.surfaceIndex = refreshSurface(owner.surfaceIndex, runtime)
    const body = JSON.parse(await agent.rcon.command(agent.observationToolCommand('getActorStatus', {})))
    identity()
    if (body.actor?.actor_id !== task.actor_id || body.surface_index !== runtime.surface_index
      || !Number.isSafeInteger(body.force_index) || body.force_index < 1
      || (forceIndex !== undefined && body.force_index !== forceIndex)) throw new Error('collection_body_scope_changed')
    forceIndex = body.force_index
    return runtime
  }
  return { owner, fence, idleFence: collectionIdleFence(agent, owner, fence) }
}

export async function refreshExactEntity(agent, unit, source) {
  if (agent.liveObservedExactTarget(unit)) return undefined
  if (agent.completionProtocolVersion < 3 || agent.agentContext.role !== 'executor' || !agent.active
    || !agent.requestInfo || !agent.epoch || agent.currentPendingAmendment()
    || agent.memory.pauseRecord?.(agent.activePlanKey())?.paused) return undefined
  const owner = agent.captureCheckpointOwner()
  const planning = agent.memory.planningState(owner.key)
  const plan = getActivePlan(planning)
  const locator = agent.exactTargetLocator(unit)
  const placement = agent.memory.authorizationState?.(owner.key)?.world?.npc_placements?.find(row => row.unit_number === unit)
  // A name, a model's number, or an unrelated goal's old target cannot launch a
  // probe. Automatic renewal is limited to this NPC's recorded placement.
  if (!owner.requestTrace?.id || planning?.goal?.status !== 'active' || planning.run?.paused || agent.memory.currentPlan(owner.key)?.status !== 'active'
    || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status)
    || !locator?.name
    || !Number.isFinite(locator.position?.x) || !Number.isFinite(locator.position?.y)
    || placement?.actor_id !== agent.epoch.actor_id || placement?.actor_epoch !== agent.epoch.epoch
    || placement.entity_name !== locator.name) return undefined
  const actor = actorStamp(agent)
  const conversation = agent.agentContext.conversationSeq
  let forceIndex
  let idleRequired = false
  owner.surfaceIndex = locator.surface_index
  const identity = () => {
    agent.assertCheckpointOwnerIdentity(owner)
    if (actorStamp(agent) !== actor || agent.agentContext.conversationSeq !== conversation
      || agent.currentPendingAmendment() || agent.memory.pauseRecord?.(owner.key)?.paused || heldWork(agent, owner)) {
      const error = new Error('Entity refresh cancelled or superseded')
      error.code = STALE_REPLY_ERROR_CODE
      throw error
    }
  }
  const fence = async () => {
    identity()
    await agent.assertCheckpointOwnerCurrent(owner)
    identity()
    const runtime = await deploymentStatus(agent.rcon, { requireAllowed: true })
    identity()
    if (runtime.actor_id !== agent.epoch.actor_id || runtime.epoch !== agent.epoch.epoch) throw new Error('entity_refresh_actor_or_surface_changed')
    owner.surfaceIndex = refreshSurface(owner.surfaceIndex, runtime)
    if (idleRequired && runtime.idle !== true) {
      const error = new Error('entity_refresh_native_work_pending')
      error.entityRefreshBusy = true
      throw error
    }
    const body = JSON.parse(await agent.rcon.command(agent.observationToolCommand('getActorStatus', {})))
    identity()
    if (body.actor?.actor_id !== agent.epoch.actor_id || body.surface_index !== owner.surfaceIndex
      || !Number.isSafeInteger(body.force_index) || body.force_index < 1
      || (forceIndex !== undefined && body.force_index !== forceIndex)) throw new Error('entity_refresh_body_scope_changed')
    forceIndex = body.force_index
    return runtime
  }
  const checked = async promise => { const value = await promise; await fence(); return value }
  const idleFence = collectionIdleFence(agent, owner, fence)
  const persist = async () => {
    try { await checked(agent.persistState({ strict: true })) }
    catch (error) { error.entityRefreshPersistence = true; throw error }
  }
  const emit = (event, reason, extra = {}) => checked(agent.traceEvent(`entity.${event}`, {
    request_id: owner.requestTrace?.id, goal_id: owner.goalId, plan_id: owner.planId,
    plan_version: owner.planVersion, step_id: owner.stepId, unit_number: unit, source, reason, ...extra,
  }, { requestId: owner.requestTrace?.id }))
  const pause = async reason => {
    await emit('refresh_exhausted', reason, { disposition: 'durable_guard_pause' })
    await fence()
    const state = await agent.pausePersistentPlan(reason, { pause_class: 'guard' }, owner)
    return disposition(agent, 'paused', { entityRefresh: 'paused', reason, goalStatus: state?.status, operations: [] })
  }
  const defer = reason => disposition(agent, 'deferred', { entityRefresh: 'deferred', reason, operations: [] })
  if (heldWork(agent, owner)) return defer('existing_wait_or_controller')
  if (agent.entityRefreshFlight) return defer('refresh_in_flight')
  agent.entityRefreshFlight = true
  try {
    await fence()
    const status = JSON.parse(await checked(agent.readTaskStatusRaw()))
    if (agent.batchInFlight || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch) {
      return defer('native_work_pending')
    }
    const journal = status.admission_journal?.records ?? status.admission_journal
    if (agent.memory.pendingOperation?.(owner.key) || Array.isArray(journal) && journal.some(row => ['uncertain', 'admitting'].includes(row.state))) {
      return pause('entity_refresh_native_outcome_uncertain')
    }
    const follow = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
    const crafting = JSON.parse(await checked(agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
    if (follow.active !== false || crafting.task_active !== false || !crafting.native_queue
      || Object.keys(crafting.native_queue).length || crafting.persisted_owner || status.actor?.mining_state?.mining) {
      return defer('native_controller_work')
    }
    idleRequired = true
    await emit('refresh_detected', 'request_binding_missing', { disposition: 'read_only_identity_reconciliation' })
    const initial = agent.targetedObservationIdentity()
    const ledger = agent.memory.targetedObservationLedger ??= new Map()
    const claims = agent.memory.entityRefreshClaims ??= new Map()
    const key = claimKey(owner)
    if (agent.memory.entityRefreshFault) return pause('entity_refresh_ledger_unreadable')
    if (ledger.get(initial.ledgerKey) === initial.basis || claims.get(key)?.basis === initial.basis
      || agent.closedRoundObservationUsed || agent.actionOmissionObservationUsed) return pause('entity_refresh_allowance_exhausted')
    if (claims.size >= 128 && !claims.has(key)) return pause('entity_refresh_ledger_full')
    const allowance = claimControllerRecovery(agent.memory, owner)
    if (allowance.reason) return pause(allowance.reason)
    const claim = { unit, state: 'claimed', basis: initial.basis, requestId: owner.requestTrace.id }
    claims.set(key, claim)
    ledger.set(initial.ledgerKey, initial.basis)
    agent.closedRoundObservationUsed = true
    await persist()
    let detail
    const tool = { id: `entity_refresh_${unit}`, type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ unit_number: unit }) } }
    const prepared = agent.prepareToolBatch({ tool_calls: [tool] })
    Object.defineProperty(prepared, '_sglunaTargetedRecovery', { value: true })
    Object.defineProperty(prepared[0], '_sglunaReadFence', { value: idleFence })
    Object.defineProperty(prepared[0], '_sglunaValidateRaw', { value: raw => {
      identity()
      detail = validateRefreshedEntity(raw, { unit, locator, placement, actorId: agent.epoch.actor_id,
        surfaceIndex: owner.surfaceIndex, forceIndex })
      // Native getEntityStatus enforces actor-body force/surface on both direct
      // and hinted lookup paths. Its actor-correlated top-level proof is required.
    } })
    agent.toolCache.delete(prepared[0].signature)
    await checked(agent.handleToolBatch({ content: '', tool_calls: [tool] }, prepared))
    if (!detail || !agent.liveObservedExactTarget(unit)) return pause('entity_refresh_binding_not_published')
    claim.state = 'bound'
    await persist()
    await emit('refresh_bound', 'same_native_entity_verified', { disposition: 'reconcile_before_new_intent', ...allowance })
    await idleFence()
    return { action: 'bound', unit, detail, owner, fence, idleFence, claim, key,
      current: () => agent.checkpointOwnerCurrent(owner) && actorStamp(agent) === actor && agent.agentContext.conversationSeq === conversation }
  } catch (error) {
    identity() // Superseded work must not pause or write replacement state.
    if (error.entityRefreshPersistence) throw error
    agent.liveEntityObservations.delete(`unit:${unit}`)
    if (error.entityRefreshBusy) return defer(error.message)
    await fence()
    return pause(`entity_refresh_failed:${String(error.message).slice(0, 120)}`)
  } finally { agent.entityRefreshFlight = false }
}

export async function continueEntityRefresh(agent, refreshed) {
  if (refreshed.action !== 'bound') return refreshed.result
  await refreshed.idleFence()
  const plan = getActivePlan(agent.memory.planningState(refreshed.owner.key))
  const contract = plan.steps[plan.active_step_index].completion_contract
  let machine
  try { machine = machineFacts(refreshed.detail.entity) } catch { /* A read can rebind without authorizing stock collection. */ }
  const targets = contract?.mode === 'all' && machine && ['furnace', 'assembling-machine'].includes(machine.type)
    ? (contract.requirements ?? []).filter(row => row.kind === 'inventory_count' && (machine.output[row.item_name] ?? 0) >= row.minimum)
      .map(row => ({ item_name: row.item_name, count: row.minimum })) : []
  // The established finite-production controller rereads actor inventory,
  // recipes and machine stock, collects existing output first and validates the
  // ordinary checkpoint. No old supply/mine/configuration proposal is replayed.
  if (targets.length) {
    const previous = agent.entityRefreshAdmission
    agent.entityRefreshAdmission = refreshed
    try {
      return await agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, stepId: refreshed.owner.stepId, operations: [],
        productionTask: { targets, producers: targets.map(row => ({ recipe_name: row.item_name, unit_number: refreshed.unit })) } })
    } finally { if (agent.entityRefreshAdmission === refreshed) agent.entityRefreshAdmission = previous }
  }
  await agent.traceEvent('entity.refresh_decision_wake', { request_id: refreshed.owner.requestTrace?.id,
    goal_id: refreshed.owner.goalId, plan_id: refreshed.owner.planId, step_id: refreshed.owner.stepId,
    unit_number: refreshed.unit, reason: 'fresh_binding_requires_ordinary_decision', disposition: 'ordinary_decision' })
  await refreshed.fence()
  agent.messages.push({ role: 'user', content: '[HARNESS] The previous exact proposal was not admitted. The harness refreshed its same native target; current machine facts are above. Reconcile current stock and choose the remaining committed work. No operation was replayed and no completion was granted.' })
  const previousWake = agent.entityRefreshDecisionWake
  agent.entityRefreshDecisionWake = refreshed
  try {
    const result = await agent.runTurn()
    if (refreshed.current() && agent.active) {
      refreshed.claim.state = 'continued'
      await agent.persistState({ strict: true })
      await refreshed.fence()
    }
    return result
  } finally { if (agent.entityRefreshDecisionWake === refreshed) agent.entityRefreshDecisionWake = previousWake }
}

export async function recoverInterruptedEntityRefresh(agent) {
  if (!agent.active || !agent.epoch || !agent.requestInfo || agent.currentPendingAmendment()
    || agent.memory.pauseRecord?.(agent.activePlanKey())?.paused) return undefined
  const owner = agent.captureCheckpointOwner()
  const claim = agent.memory.entityRefreshClaims?.get(claimKey(owner))
  if (!claim || !['claimed', 'bound'].includes(claim.state) || agent.entityRefreshFlight) return undefined
  if (agent.entityRefreshDecisionWake?.current()) return undefined
  await agent.assertCheckpointOwnerCurrent(owner)
  if (agent.memory.pendingOperation?.(owner.key)) return undefined
  if (claim.state === 'bound' && [...(agent.memory.productionTasks?.values() ?? [])].some(task => task.status === 'active'
    && task.owner.goal_id === owner.goalId && task.owner.plan_id === owner.planId && task.owner.plan_version === owner.planVersion
    && task.owner.step_id === owner.stepId && task.intent.producers.some(row => row.unit_number === claim.unit))) {
    claim.state = 'continued'
    await agent.persistState({ strict: true })
    await agent.assertCheckpointOwnerCurrent(owner)
    return undefined
  }
  await agent.traceEvent('entity.refresh_exhausted', { request_id: owner.requestTrace?.id, goal_id: owner.goalId,
    plan_id: owner.planId, step_id: owner.stepId, unit_number: claim.unit, reason: 'entity_refresh_interrupted', disposition: 'durable_guard_pause' })
  await agent.assertCheckpointOwnerCurrent(owner)
  const state = await agent.pausePersistentPlan('entity_refresh_interrupted', { pause_class: 'guard' }, owner)
  return { entityRefresh: 'paused', goalStatus: state?.status, operations: [] }
}

export async function settleEntityRefreshClaims(agent) {
  const owner = agent.captureCheckpointOwner()
  const actor = actorStamp(agent)
  const current = () => { agent.assertCheckpointOwnerIdentity(owner); if (actorStamp(agent) !== actor) throw new Error('Entity settlement actor superseded') }
  for (const [key, claim] of agent.memory.entityRefreshClaims ?? []) {
    if (!['bound', 'continued'].includes(claim.state)) continue
    const [memoryKey, goalId, planId, version, stepId] = JSON.parse(key)
    if (memoryKey !== owner.key || goalId !== owner.goalId) continue
    const planning = agent.memory.planningState(memoryKey)
    const plan = planning.plans.find(row => row.plan_id === planId && row.plan_version === version)
    if (plan?.execution?.step_progress?.[stepId]?.status !== 'completed') continue
    current()
    claim.state = 'settled'
    await agent.persistState({ strict: true })
    current()
    await agent.traceEvent('entity.refresh_settled', { request_id: claim.requestId, goal_id: goalId, plan_id: planId,
      plan_version: version, step_id: stepId, unit_number: claim.unit, reason: 'ordinary_checkpoint_verified', disposition: 'verified_checkpoint_closed' },
    { requestId: owner.requestTrace?.id })
    current()
  }
}
