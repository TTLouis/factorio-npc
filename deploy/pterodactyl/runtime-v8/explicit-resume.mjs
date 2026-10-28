import { getActivePlan, PLANNING_EVENT, PLAN_STATUS } from './planning-state.mjs'

import { EXPLICIT_RESUME_LIMIT } from './explicit-resume-state.mjs'

const CLASSES = ['operator', 'guard', 'transport', 'model_recoverable']

export function explicitResumeIdentity(memory, key) {
  const state = memory.planningState?.(key)
  const plan = getActivePlan(state)
  const run = state?.run
  if (!run?.paused || !plan || !CLASSES.includes(run.pause_class)) return undefined
  if (![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status)) return undefined
  const step = plan.steps[plan.active_step_index]
  if (!step) return undefined
  return { goal_id: state.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
    step_id: step.step_id, paused_at: run.paused_at, pause_count: run.pause_count, pause_class: run.pause_class, pause_reason: run.pause_reason }
}

// Only the explicit bare-continue intake creates this authority. A classifier,
// automatic wake or model response cannot manufacture it. It remains tied to
// that intake owner across awaits, including its residual C3 handoff repair.
export async function resumeExplicitContinuation(agent, authority, { current, readActor, stage }) {
  if (!authority) return { resumed: false, reason: 'no_explicit_authority' }
  const key = agent.activePlanKey()
  const fence = () => {
    current()
    const state = agent.memory.planningState?.(key)
    const plan = getActivePlan(state)
    if (state?.goal?.goal_id !== authority.goal_id || plan?.plan_id !== authority.plan_id
      || plan.plan_version !== authority.plan_version || plan.steps[plan.active_step_index]?.step_id !== authority.step_id) {
      throw new Error('explicit_resume_identity_changed')
    }
    return state
  }
  let state = fence()
  if (!state.run.paused) return { resumed: false, reason: 'already_running' }
  const refuse = async (reason) => {
    await agent.traceEvent('goal.explicit_resume_refused', { ...authority, actor: authority.actor, stage, reason,
      disposition: 'remain_paused' }, { requestId: authority.request_id })
    fence()
    throw new Error(`explicit_resume_refused:${reason}`)
  }
  const paused = explicitResumeIdentity(agent.memory, key)
  if (!paused || paused.paused_at !== authority.paused_at || paused.pause_count !== authority.pause_count
    || paused.pause_class !== authority.pause_class || paused.pause_reason !== authority.pause_reason) return refuse('pause_identity_changed')
  const unsafe = value => value.run.pending_operation || value.run.condition_wait
    || agent.memory.pendingOperations?.(key)?.length || agent.batchInFlight || agent.pendingInteractionAmendment
  if (unsafe(state)) return refuse('unsettled_or_amended')
  const native = await agent.readInteractionTaskStatus()
  state = fence()
  const actor = await readActor()
  state = fence()
  if (actor.actor_id !== authority.actor.actor_id || actor.epoch !== authority.actor.epoch || actor.session !== authority.actor.session) return refuse('actor_changed')
  if (unsafe(state) || native.status_error || native.task_state !== 'idle' || native.queue_length !== 0 || native.queue_empty !== true) return refuse('native_not_idle')
  if (state.run.explicit_resume_fault) return refuse('durable_allowance_unreadable')
  const before = state.run.explicit_resume
  const samePause = before?.goal_id === authority.goal_id && before.plan_id === authority.plan_id
    && before.step_id === authority.step_id && before.paused_at === authority.paused_at && before.pause_count === authority.pause_count
  const attempts = samePause ? before.attempts : 0
  if (attempts >= EXPLICIT_RESUME_LIMIT) return refuse('durable_allowance_exhausted')
  agent.memory.dispatchPlanningEvent(key, { type: PLANNING_EVENT.EXPLICIT_RESUME_CLAIMED, source: 'runtime',
    ...authority, attempts: attempts + 1, stage, now: Date.now() })
  state = fence()
  if (state.run.explicit_resume?.attempts !== attempts + 1) return refuse('claim_refused')
  await agent.persistState({ strict: true })
  state = fence()
  // Recheck after the durable claim; cancellation, a new pause, partial work or
  // an amendment that arrived during persistence cannot be resumed by this one.
  const fresh = await agent.readInteractionTaskStatus()
  state = fence()
  const freshActor = await readActor()
  state = fence()
  const heldPause = explicitResumeIdentity(agent.memory, key)
  if (!heldPause || heldPause.paused_at !== authority.paused_at || heldPause.pause_count !== authority.pause_count
    || heldPause.pause_class !== authority.pause_class || heldPause.pause_reason !== authority.pause_reason || unsafe(state)
    || fresh.task_state !== 'idle' || fresh.queue_length !== 0 || fresh.queue_empty !== true || fresh.status_error
    || freshActor.actor_id !== authority.actor.actor_id || freshActor.epoch !== authority.actor.epoch
    || freshActor.session !== authority.actor.session) return refuse('fresh_fence_changed')
  const result = agent.memory.resumePausedPlan(key, { reason: 'explicit_user_continue', explicit: true,
    pauseClasses: CLASSES, identity: authority })
  if (!result?.resumed) return refuse(result?.reason ?? 'resume_refused')
  try {
    await agent.persistState({ strict: true })
    fence()
  }
  catch (error) {
    // Never roll back a replacement request or goal. A current failed write
    // returns this exact goal to its original pause; no operation has run.
    try {
      const current = fence()
      if (current.run.paused) throw error
      agent.memory.pausePlan(key, authority.pause_reason || 'explicit_resume_persistence_failed', { pause_class: authority.pause_class })
      await agent.persistState({ strict: true })
    }
    catch {}
    throw error
  }
  await agent.traceEvent('goal.explicit_resume_completed', { ...authority, stage, attempts: attempts + 1,
    native_idle: true, recovery_allowances_reset: false }, { requestId: authority.request_id })
  fence()
  return { resumed: true }
}


// Intake setup can fail after activation but before any executor/native wake.
// Settle only the request that activated this exact goal; preserve user stops
// and replacement work across both the native read and persistence.
export async function settleExplicitResumeFailure(agent, owner, error, readActor) {
  const authority = owner.resumeAuthority
  if (!authority) return
  const key = agent.activePlanKey()
  const eligible = () => {
    const state = agent.memory.planningState(key)
    const plan = getActivePlan(state)
    return agent.requestAdmissionOwner === owner && agent.generation === owner.generation
      && state.goal?.goal_id === authority.goal_id && plan?.plan_id === authority.plan_id
      && plan.plan_version === authority.plan_version && plan.steps[plan.active_step_index]?.step_id === authority.step_id
      && !state.run.paused && !agent.batchInFlight && !agent.memory.pendingOperation?.(key)
      && !state.run.condition_wait && !agent.currentPendingAmendment()
  }
  if (!eligible()) return
  let actor
  try { actor = await readActor() }
  catch { actor = agent.epoch } // loss of native reads cannot strand a locally owned, idle activation
  if (!eligible() || actor.actor_id !== authority.actor.actor_id || actor.epoch !== authority.actor.epoch
    || actor.session !== authority.actor.session) return
  agent.memory.pausePlan(key, 'explicit_resume_setup_failed', { pause_class: 'guard' })
  await agent.persistState({ strict: true })
  if (agent.requestAdmissionOwner !== owner || agent.generation !== owner.generation) return
  await agent.traceEvent('goal.explicit_resume_setup_failed', { ...authority, reason: String(error?.message ?? error).slice(0, 200),
    disposition: 'durable_guard_pause' }, { requestId: authority.request_id })
}
