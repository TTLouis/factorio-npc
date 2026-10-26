import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'
import { unresolvedNativeAdmissions } from './operation-reconciliation.mjs'

export const CONTROLLER_LIVENESS = Object.freeze({ idleMs: 20000, probeMs: 10000, perStep: 2, perGoal: 6, records: 128 })

function identityKey(key, length) {
  if (typeof key !== 'string' || key.length > 600) return false
  try {
    const fields = JSON.parse(key)
    return Array.isArray(fields) && fields.length === length && fields.every((field, i) =>
      length === 3 && i === 1 ? Number.isSafeInteger(field) && field > 0 : typeof field === 'string' && field.length > 0)
  } catch { return false }
}

export function restoreControllerRecoveries(raw) {
  const records = new Map()
  let fault = raw !== undefined && !Array.isArray(raw)
  for (const row of Array.isArray(raw) ? raw : []) {
    const [key, record] = Array.isArray(row) ? row : []
    if (!identityKey(key, 2) || key.length > 500 || !record || records.has(key)
      || !Number.isFinite(record.last_at) || record.last_at < 0
      || !Number.isSafeInteger(record.attempts) || record.attempts < 1 || record.attempts > CONTROLLER_LIVENESS.perGoal
      || !Array.isArray(record.steps) || record.steps.length > CONTROLLER_LIVENESS.perGoal
      || !record.steps.every(s => s && identityKey(s.key, 3)
        && Number.isSafeInteger(s.attempts) && s.attempts > 0 && s.attempts <= CONTROLLER_LIVENESS.perStep)
      || new Set(record.steps.map(s => s.key)).size !== record.steps.length
      || record.steps.reduce((sum, s) => sum + s.attempts, 0) !== record.attempts
      || records.size >= CONTROLLER_LIVENESS.records) { fault = true; continue }
    records.set(key, structuredClone(record))
  }
  return { records, fault }
}

function scope(session) {
  const agent = session.agent
  if (!agent || !session.ready || session.stopping || session.controllerLivenessRunning
    || (session.controllerQueuedEvents ?? 0) > 0 || (agent.controllerBusyCount ?? 0) > 0
    || (agent.turnDepth ?? 0) > 0 || agent.stepContractsInFlight?.size || agent.currentPendingAmendment?.()) return undefined
  const key = agent.activePlanKey()
  const planning = agent.memory.planningState?.(key)
  const plan = getActivePlan(planning)
  const state = agent.memory.currentPlan?.(key)
  if (planning?.goal?.status !== 'active' || planning.run?.paused || agent.memory.pauseRecord?.(key)?.paused
    || state?.status !== 'active' || state.condition_wait?.state === 'active'
    || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan?.status)) return undefined
  const owner = agent.captureCheckpointOwner()
  if (!owner.stepId || !agent.epoch) return undefined
  return { agent, owner, plan, cancel: session.cancelGeneration,
    stamp: JSON.stringify([owner.key, owner.goalId, owner.planId, owner.planVersion, owner.stepId,
      owner.generation, owner.lineage, owner.requestTrace?.id, agent.epoch.actor_id, agent.epoch.epoch]) }
}

function current(session, s) {
  return !session.stopping && session.agent === s.agent && session.cancelGeneration === s.cancel
    && (session.controllerQueuedEvents ?? 0) === 0 && (s.agent.controllerBusyCount ?? 0) === 0
    && (s.agent.turnDepth ?? 0) === 0 && !s.agent.stepContractsInFlight?.size
    && s.agent.checkpointOwnerCurrent(s.owner) && !s.agent.currentPendingAmendment?.()
    && !s.agent.memory.pauseRecord?.(s.owner.key)?.paused
}

async function emit(session, s, event, reason, extra = {}) {
  await s.agent.traceEvent(`controller.${event}`, { request_id: s.owner.requestTrace?.id,
    goal_id: s.owner.goalId, plan_id: s.owner.planId, plan_version: s.owner.planVersion,
    step_id: s.owner.stepId, reason, ...extra }, { requestId: s.owner.requestTrace?.id })
}

async function pause(session, s, reason) {
  if (!current(session, s)) return { action: 'stale' }
  await s.agent.assertCheckpointOwnerCurrent(s.owner)
  if (!current(session, s)) return { action: 'stale' }
  await s.agent.pausePersistentPlan(reason, { pause_class: 'guard' }, s.owner)
  // pausePersistentPlan intentionally cancels this owner. Never clear a newer trace.
  const heldTrace = s.agent.traceRequest
  if (heldTrace !== s.owner.requestTrace || session.cancelGeneration !== s.cancel) return { action: 'stale' }
  const pausedOwner = s.agent.captureCheckpointOwner()
  await emit(session, s, 'recovery_exhausted', reason, { disposition: 'durable_guard_pause' })
  if (s.agent.traceRequest !== heldTrace || !s.agent.checkpointOwnerCurrent(pausedOwner)) return { action: 'stale' }
  const data = s.agent.goalPausedTrace('controller_liveness')
  if (data) await s.agent.traceEvent('goal.paused', data, { requestId: heldTrace?.id })
  if (s.agent.traceRequest !== heldTrace || !s.agent.checkpointOwnerCurrent(pausedOwner)) return { action: 'stale' }
  await session.printChat('I paused this goal because its controller could not safely continue automatically. Resume or say continue to retry from verified state.')
  return { action: 'paused', reason }
}

export function claimControllerRecovery(memory, owner, now = Date.now()) {
  if (memory.controllerRecoveryFault) return { reason: 'controller_recovery_ledger_unreadable' }
  memory.controllerRecoveries ??= new Map()
  const key = JSON.stringify([owner.key, owner.goalId])
  const stepKey = JSON.stringify([owner.planId, owner.planVersion, owner.stepId])
  const held = memory.controllerRecoveries.get(key) ?? { attempts: 0, steps: [] }
  const step = held.steps.find(row => row.key === stepKey)
  if (held.attempts >= CONTROLLER_LIVENESS.perGoal || (step?.attempts ?? 0) >= CONTROLLER_LIVENESS.perStep) return { reason: 'controller_recovery_exhausted' }
  if (!memory.controllerRecoveries.has(key) && memory.controllerRecoveries.size >= CONTROLLER_LIVENESS.records) return { reason: 'controller_recovery_ledger_full' }
  const next = { attempts: held.attempts + 1, last_at: now,
    steps: [...held.steps.filter(row => row.key !== stepKey), { key: stepKey, attempts: (step?.attempts ?? 0) + 1 }] }
  memory.controllerRecoveries.set(key, next)
  return { attempt: next.attempts, step_attempt: (step?.attempts ?? 0) + 1 }
}

// Called from the serialized supervisor queue. agent.active / request.waiting
// alone are not work. The queue, owned calls, native status and durable wait are.
export async function inspectControllerLiveness(session, { now = Date.now() } = {}) {
  const s = scope(session)
  if (!s) { session.controllerIdleCandidate = undefined; return { action: 'healthy' } }
  const held = session.controllerIdleCandidate
  if (!held || held.stamp !== s.stamp || held.trace !== s.owner.requestTrace) {
    session.controllerIdleCandidate = { stamp: s.stamp, trace: s.owner.requestTrace, since: now }
    return { action: 'observing' }
  }
  if (now - held.since < CONTROLLER_LIVENESS.idleMs
    || now - (session.controllerLastProbeAt ?? -Infinity) < CONTROLLER_LIVENESS.probeMs) return { action: 'observing' }
  session.controllerLastProbeAt = now
  session.controllerLivenessRunning = true
  try {
    const native = await deploymentStatus(s.agent.rcon, { requireAllowed: true })
    if (!current(session, s)) return { action: 'stale' }
    if (native.actor_id !== s.agent.epoch.actor_id || native.epoch !== s.agent.epoch.epoch) return { action: 'stale' }
    const text = await s.agent.readTaskStatusRaw()
    if (!current(session, s)) return { action: 'stale' }
    const persistent = await s.agent.persistentRuntimeStatus({ strict: true })
    if (!current(session, s)) return { action: 'stale' }
    let status
    try { status = JSON.parse(text) } catch {}
    const idle = native.idle === true && status?.task_state === 'idle' && status.queue_empty === true && status.queue_length === 0
      && !persistent?.active
    await emit(session, s, 'liveness_checked', idle ? 'native_idle_without_owned_wake' : 'native_busy_or_unreadable', {
      native_reads: 3, native_idle: idle, observed_idle_ms: now - held.since, native_batch_id: status?.last_completed_batch?.batch_id })
    if (!current(session, s)) return { action: 'stale' }
    if (!idle) return { action: 'deferred' }
    // Residual missed receipt: use the ordinary owned settlement before deciding
    // that a terminal navigation row means native work is still uncertain.
    await s.agent.settleOutstandingOperation(text, undefined, { actor: native, requestId: s.owner.requestTrace?.id, receiptOwner: s.owner })
    if (!current(session, s)) return { action: 'stale' }
    const planning = s.agent.memory.planningState?.(s.owner.key)
    const records = [...(planning?.operation_ledger?.records ?? []), ...(planning?.operation_ledger?.closed ?? [])]
    if (s.agent.memory.pendingOperation?.(s.owner.key) || s.agent.batchInFlight
      || unresolvedNativeAdmissions(status, records, native).length) {
      return pause(session, s, 'controller_native_outcome_uncertain')
    }
    await emit(session, s, 'idle_detected', 'unpaused_idle_controller', { observed_idle_ms: now - held.since })
    if (!current(session, s)) return { action: 'stale' }
    const allowance = claimControllerRecovery(s.agent.memory, s.owner, now)
    if (allowance.reason) return pause(session, s, allowance.reason)
    // Expenditure precedes any restage, model call or mutation, and survives the
    // recovery's intentional new request/generation and a process restart.
    await s.agent.persistState({ strict: true })
    if (!current(session, s)) return { action: 'stale' }
    await s.agent.assertCheckpointOwnerCurrent(s.owner)
    await emit(session, s, 'recovery_started', 'unpaused_idle_controller', { ...allowance, mechanism: 'authoritative_reconcile_and_resume' })
    if (!current(session, s)) return { action: 'stale' }
    await s.agent.assertCheckpointOwnerCurrent(s.owner)
    const sequence = session.controllerProgressSequence ?? 0
    const result = await session.recoverInterruptedPlan('unpaused_idle_controller', allowance, {
      expectedActor: { actor_id: s.agent.epoch.actor_id, epoch: s.agent.epoch.epoch },
      isCancelled: () => session.stopping || session.agent !== s.agent || session.cancelGeneration !== s.cancel
        || s.agent.memory.planningState?.(s.owner.key)?.goal?.goal_id !== s.owner.goalId,
    })
    if (session.stopping || session.agent !== s.agent || session.cancelGeneration !== s.cancel
      || s.agent.memory.planningState?.(s.owner.key)?.goal?.goal_id !== s.owner.goalId) return { action: 'stale' }
    const after = s.agent.memory.planningState?.(s.owner.key)
    const progressed = (session.controllerProgressSequence ?? 0) > sequence || after?.goal?.status === 'completed'
      || s.agent.memory.currentPlan?.(s.owner.key)?.condition_wait?.state === 'active'
    await emit(session, s, progressed ? 'recovery_completed' : 'recovery_failed', progressed ? 'verified_next_transition' : 'no_verified_next_transition', {
      ...allowance, mechanism: 'authoritative_reconcile_and_resume', disposition: progressed ? 'continued' : 'bounded_retry_or_pause' })
    session.controllerIdleCandidate = undefined
    return { action: progressed ? 'recovered' : 'retry', result }
  }
  catch (error) {
    if (current(session, s)) await emit(session, s, 'liveness_deferred', 'authoritative_state_unavailable', { detail: String(error.message).slice(0, 200) })
    return { action: 'deferred' }
  }
  finally { session.controllerLivenessRunning = false }
}
