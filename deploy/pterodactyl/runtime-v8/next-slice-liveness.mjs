import { classifyRequestFailure, PAUSE_CLASS } from './pause-class.mjs'
import { completedSliceAnchor } from './next-slice-state.mjs'
import { deploymentStatus } from './supervisor-adapter.mjs'
import { preservationFailure } from './contract-obligations.mjs'

export function nextSliceOwner(agent) {
  return { generation: agent.generation, lineage: agent.agentContext?.lineageSequence, trace: agent.traceRequest,
    admission: agent.requestAdmissionOwner, amendment: agent.pendingInteractionAmendment,
    actor: agent.epoch ? { ...agent.epoch } : null,
    goal: agent.memory.planningState?.(agent.activePlanKey())?.goal?.goal_id,
    boundary: completedSliceAnchor(agent.memory.planningState?.(agent.activePlanKey()))?.boundary_key }
}
export function ownsNextSlice(agent, owner) {
  return agent.generation === owner.generation && agent.agentContext?.lineageSequence === owner.lineage
    && agent.traceRequest === owner.trace && agent.requestAdmissionOwner === owner.admission
    && agent.pendingInteractionAmendment === owner.amendment
    && agent.memory.planningState?.(agent.activePlanKey())?.goal?.goal_id === owner.goal
    && completedSliceAnchor(agent.memory.planningState?.(agent.activePlanKey()))?.boundary_key === owner.boundary
    && (!owner.validate || owner.validate())
    && agent.epoch?.actor_id === owner.actor?.actor_id && agent.epoch?.epoch === owner.actor?.epoch
}
function assertOwner(agent, owner) {
  if (!ownsNextSlice(agent, owner)) throw new Error('Next-slice transition cancelled or superseded')
}
export async function registerNextSlice(agent, { reason = 'verified_slice_complete', phase = 'pending', owner = nextSliceOwner(agent) } = {}) {
  assertOwner(agent, owner)
  const key = agent.activePlanKey()
  const anchor = completedSliceAnchor(agent.memory.planningState?.(key))
  if (!anchor) return undefined
  const held = agent.memory.nextSliceEpisode?.(key)
  if (held?.boundary_key === anchor.boundary_key) return held
  const episode = agent.memory.recordNextSliceTransition?.(key, { phase, reason,
    owner: { request_id: owner.trace?.id, actor_id: owner.actor?.actor_id, epoch: owner.actor?.epoch } })
  if (!episode) return undefined
  await agent.persistState({ strict: true })
  assertOwner(agent, owner)
  await agent.traceEvent('planning.next_slice_owned', { ...anchor, phase, reason, request_id: owner.trace?.id }, { requestId: owner.trace?.id })
  assertOwner(agent, owner)
  return episode
}

// Positive ownership comes from live workers/queues, never from agent.active.
export function nextSliceControlView(session, now = Date.now(), { inspecting = false, withinEvent = false } = {}) {
  const agent = session.agent
  const key = agent?.activePlanKey?.()
  const planning = key ? agent.memory.planningState?.(key) : undefined
  const anchor = completedSliceAnchor(planning)
  const actor = agent?.epoch ?? session.currentActorCorrelation?.() ?? {}
  const counts = { worker: (agent?.controllerBusyCount ?? 0) + (agent?.turnDepth ?? 0),
    provider: [...(agent?.providerCallsByGeneration?.values?.() ?? [])].reduce((sum, n) => sum + n, 0),
    queued: session.controllerQueuedEvents ?? 0,
    event: Math.max(0, (session.controllerEventRunning ?? 0) - (withinEvent ? 1 : 0)),
    probe: !inspecting && session.nextSliceLivenessRunning ? 1 : 0,
    condition: agent?.memory.currentPlan?.(key)?.condition_wait?.state === 'active' || session.conditionPollRunning ? 1 : 0,
    intake: agent?.requestAdmissionOwner ? 1 : 0,
    wake: session.modelResume || session.autoResume || session.intakeRetry ? 1 : 0,
    contract: agent?.stepContractsInFlight?.size ?? 0 }
  return { schema: 1, observed_at: now, actor_id: actor.actor_id, epoch: actor.epoch,
    goal_id: planning?.goal?.goal_id, request_id: agent?.traceRequest?.id,
    generation: agent?.generation, boundary_key: anchor?.boundary_key,
    unsettled: (agent?.memory.pendingOperations?.(key)?.length ?? 0) > 0 || Boolean(agent?.batchInFlight),
    episode: planning?.run?.next_slice ?? null, run_paused: planning?.run?.paused === true,
    ownership: counts, owned: Object.values(counts).some(n => n > 0),
    applicable: Boolean(anchor && planning?.goal?.status === 'active') }
}

export async function nextSliceNativeState(agent, owner, expectedActor = owner.expectedActor ?? owner.actor) {
  const native = await deploymentStatus(agent.rcon, { requireAllowed: true })
  assertOwner(agent, owner)
  if (expectedActor && (native.actor_id !== expectedActor.actor_id || native.epoch !== expectedActor.epoch)) throw new Error('Next-slice actor changed')
  const raw = await agent.readTaskStatusRaw()
  assertOwner(agent, owner)
  const status = JSON.parse(String(raw))
  const crafting = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getCraftingStatus', {}))))
  assertOwner(agent, owner)
  const follow = JSON.parse(String(await agent.rcon.command(agent.observationToolCommand('getFollowStatus', {}))))
  assertOwner(agent, owner)
  const finalNative = await deploymentStatus(agent.rcon, { requireAllowed: true })
  assertOwner(agent, owner)
  if (native.actor_id !== finalNative.actor_id || native.epoch !== finalNative.epoch
    || native.last_batch_id !== finalNative.last_batch_id || native.last_batch_seq !== finalNative.last_batch_seq) throw new Error('Next-slice native ownership changed')
  const unknown = typeof status.task_state !== 'string' || !Number.isSafeInteger(status.queue_length)
    || typeof status.queue_empty !== 'boolean' || typeof crafting.task_active !== 'boolean'
    || !crafting.native_queue || typeof follow.active !== 'boolean'
  const pending = agent.memory.pendingOperations?.(agent.activePlanKey()) ?? (agent.memory.pendingOperation?.(agent.activePlanKey()) ? [agent.memory.pendingOperation(agent.activePlanKey())] : [])
  const uncertain = pending.length > 0 || agent.batchInFlight || status.admission_journal?.records?.some(row => ['admitting', 'uncertain'].includes(row.state))
  const busy = finalNative.idle !== true || native.idle !== true || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0
    || Boolean(status.active_batch) || crafting.task_active || Object.keys(crafting.native_queue ?? {}).length > 0
    || Boolean(crafting.persisted_owner) || follow.active || status.actor?.mining_state?.mining
  return { native: finalNative, status, unknown, uncertain, busy }
}

// Shared normal/error settlement. It never executes a draft or changes the
// completed predecessor. Only a known model failure enters the existing 2/6 wake.
export async function settleNextSliceExit(agent, { failure, reason = 'worker_returned', owner = nextSliceOwner(agent) } = {}) {
  assertOwner(agent, owner)
  const key = agent.activePlanKey()
  const planning = agent.memory.planningState?.(key)
  const episode = planning?.run?.next_slice
  const anchor = completedSliceAnchor(planning)
  if (!anchor) {
    if (episode && episode.phase !== 'committed') {
      agent.memory.recordNextSliceTransition?.(key, { phase: 'committed', boundary_key: episode.boundary_key, reason: 'next_transition_committed' })
      await agent.persistState({ strict: true })
      assertOwner(agent, owner)
    }
    return { action: 'not_applicable' }
  }
  if (planning.run?.paused) return { action: 'paused', pause_class: planning.run.pause_class }
  await registerNextSlice(agent, { owner, reason })
  const reconcile = await agent.reconcileOutstandingOperation?.({ trigger: 'next_slice_settlement', requestId: owner.trace?.id })
  assertOwner(agent, owner)
  let native
  try { native = await nextSliceNativeState(agent, owner) }
  catch (error) { assertOwner(agent, owner); native = { unknown: true, detail: error.message } }
  assertOwner(agent, owner)
  if (native.busy && !native.uncertain && !native.unknown) return { action: 'native_owned' }
  const proofFailure = preservationFailure(failure) ?? preservationFailure(failure?.cause)
  const classified = proofFailure
    ? { pause_class: PAUSE_CLASS.GUARD, code: proofFailure.code }
    : failure ? classifyRequestFailure(failure) : { pause_class: PAUSE_CLASS.MODEL_RECOVERABLE, code: 'next_slice_transition_interrupted' }
  const episodeFault = agent.memory.planningState?.(key)?.run?.next_slice_fault === true
  const unsafe = episodeFault || native.unknown || native.uncertain || reconcile?.verdict === 'uncertain'
  const pauseClass = unsafe ? PAUSE_CLASS.GUARD : classified.pause_class
  const code = episodeFault ? 'next_slice_episode_unreadable' : unsafe ? 'next_slice_native_unproven' : classified.code
  const pauseReason = `${code}: ${String(failure?.message ?? reason).slice(0, 180)}`
  agent.memory.dispatchPlanningEvent?.(key, { type: 'RUN_PAUSED', now: Date.now(), source: 'runtime', goal_id: anchor.goal_id,
    reason: pauseReason, pause_class: pauseClass, pause_subkind: classified.pause_subkind })
  const state = agent.memory.currentPlan?.(key)
  agent.memory.recordNextSliceTransition?.(key, { phase: 'paused', boundary_key: anchor.boundary_key,
    reason: pauseReason, failure_class: pauseClass })
  await agent.persistState({ strict: true })
  assertOwner(agent, owner)
  await agent.traceEvent('planning.next_slice_settled', { ...anchor, reason: code, disposition: 'durable_classified_pause',
    pause_class: pauseClass, preservation_failure: proofFailure, request_id: owner.trace?.id }, { requestId: owner.trace?.id })
  assertOwner(agent, owner)
  const paused = agent.goalPausedTrace('next_slice_settlement')
  if (paused) await agent.traceEvent('goal.paused', paused, { requestId: owner.trace?.id })
  // The pause notification itself queues the supervisor's pause handler. No
  // shared writes follow it; still reject replacement/cancellation provenance.
  assertOwner(agent, { ...owner, validate: undefined })
  return { action: 'paused', state, pause_class: pauseClass, reason: code, native_reconciled: !unsafe }
}

export async function inspectNextSliceLiveness(session, { withinEvent = false, failure } = {}) {
  const before = nextSliceControlView(session, Date.now(), { inspecting: true, withinEvent })
  if (!before.applicable) return { action: 'not_applicable' }
  if (session.stopping || !session.ready || session.nextSliceLivenessRunning || before.owned || session.controllerEventRunning > 1
    || session.agent.currentPendingAmendment?.()) return { action: 'owned' }
  if (before.run_paused) {
    await session.considerPauseForAutoResume?.()
    return { action: 'paused' }
  }
  const agent = session.agent
  const owner = nextSliceOwner(agent)
  const cancel = session.cancelGeneration
  const actor = session.currentActorCorrelation?.()
  owner.expectedActor = actor
  owner.validate = () => {
    const view = nextSliceControlView(session, Date.now(), { inspecting: true, withinEvent })
    const live = session.currentActorCorrelation?.()
    return !session.stopping && session.ready && session.agent === agent && session.cancelGeneration === cancel
      && !view.owned && view.boundary_key === before.boundary_key
      && live?.actor_id === actor?.actor_id && live?.epoch === actor?.epoch
      && !agent.currentPendingAmendment?.()
  }
  session.nextSliceLivenessRunning = true
  try {
    const result = await settleNextSliceExit(agent, { owner, failure, reason: failure ? 'supervisor_event_failed' : 'recognized_authoring_boundary_without_worker' })
    if (session.cancelGeneration !== cancel || !ownsNextSlice(agent, owner)) {
      if (result.action === 'paused' && session.cancelGeneration === cancel && ownsNextSlice(agent, { ...owner, validate: undefined })) return result
      return { action: 'stale' }
    }
    if (result.pause_class === PAUSE_CLASS.MODEL_RECOVERABLE) await session.considerPauseForAutoResume?.()
    return result
  }
  catch (error) {
    return { action: ownsNextSlice(agent, owner) ? 'deferred' : 'stale', reason: error.message }
  }
  finally { session.nextSliceLivenessRunning = false }
}
