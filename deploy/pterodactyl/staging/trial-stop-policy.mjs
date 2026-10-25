import { sprintSpeedValid } from './tick-sprint-policy.mjs'
import { nativeAdmissionJournal } from './native-admission-journal.mjs'
// Read-only policy for the external live-trial runner and its supervisor.
// A recoverable pause reason is diagnostic text, never terminal authority.
export function structuralTerminal(canonical) {
  const plan = canonical?.plans?.find(p => p.plan_id === canonical.active_plan_id)
  if (!plan || !['DRAFT', 'COMMITTED', 'EXECUTING', 'BLOCKED'].includes(plan.status)) return null
  const blocked = plan.status === 'BLOCKED'
  const decision = plan.blocker?.requires_user_decision === true
  if (!blocked && !decision) return null
  return { result: blocked ? 'controller_blocked:canonical_plan' : 'controller_blocked:requires_user_decision',
    evidence: { source: 'canonical_planning_state', reason: blocked ? 'active_plan_blocked' : 'active_plan_requires_user_decision',
      goal_id: canonical.goal?.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
      active_step_id: plan.steps?.[plan.active_step_index]?.step_id, canonical_plan_status: plan.status,
      blocker_kind: plan.blocker?.kind, blocker_reason_code: plan.blocker?.reason_code,
      requires_user_decision: decision, run_paused: canonical.run?.paused === true } }
}

export function trialStopDecision({ canonical, events = [], startedAt, now, pausedSince = null,
  goalId, actorId, native, controller, constructionLimitMs = 45 * 60000, hardFloorReached = false, speedPolicy = { profile: 'normal' } }) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt
    || ![45 * 60000, 60 * 60000].includes(constructionLimitMs)) throw new Error('Invalid trial clock or approved construction cap')
  const finish = (action, reason, result = null, evidence = {}, since = null) => ({
    action, reason, result, pausedSince: since,
    evidence: { event: 'trial.stop_classified', source: 'authoritative_trial_stop_policy', reason,
      goal_id: goalId, actor_id: actorId, observed_at: now, ...evidence },
  })
  if (native && (native.actor_id !== actorId || !sprintSpeedValid(native, { ...speedPolicy, now }) || native.humans !== 0)) {
    return finish('stop', 'native_trial_invariant_changed', 'trial_invariant_changed')
  }
  if (goalId && canonical?.goal?.goal_id && canonical.goal.goal_id !== goalId) {
    return finish('stop', 'goal_identity_changed', 'goal_identity_changed')
  }
  const structural = structuralTerminal(canonical)
  if (structural) return finish('stop', structural.evidence.reason, structural.result, structural.evidence)
  if (hardFloorReached) return finish('stop', 'weekly_remaining_floor_reached', 'weekly_hard_floor')
  if (now - startedAt >= constructionLimitMs) return finish('stop', 'construction_wall_limit_reached',
    `construction_wall_limit_${constructionLimitMs / 60000}_minutes`)

  const run = canonical?.run
  if (run?.paused !== true) {
    const predecessor = canonical?.plans?.findLast(plan => plan.status === 'COMPLETED')
    const later = canonical?.plans?.slice((canonical?.plans?.indexOf(predecessor) ?? -1) + 1) ?? []
    const step = predecessor?.steps?.at(-1)
    const boundary = canonical?.goal?.status === 'active' && step
      && !later.some(plan => ['COMMITTED', 'EXECUTING', 'BLOCKED'].includes(plan.status))
      && predecessor.steps.every(item => predecessor.execution?.step_progress?.[item.step_id]?.status === 'completed')
      ? `next_slice|${goalId}|${predecessor.plan_id}|${predecessor.plan_version}|${step.step_id}` : undefined
    if (!boundary) return finish('continue', 'controller_running')
    const fresh = controller?.schema === 1 && controller.ready === true && controller.stopping === false && typeof controller.instance_id === 'string'
      && controller.goal_id === goalId && controller.actor_id === actorId && controller.epoch === native?.epoch
      && controller.boundary_key === boundary && controller.applicable === true
      && controller.run_paused === false && Number.isFinite(controller.observed_at)
      && controller.observed_at <= now && now - controller.observed_at <= 10000
    if (!fresh) return finish('wait', 'next_slice_controller_ownership_unknown')
    const counts = controller.ownership
    const validCounts = counts && ['worker', 'provider', 'queued', 'event', 'condition', 'intake', 'wake', 'contract'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    if (!validCounts) return finish('wait', 'next_slice_controller_ownership_unknown')
    if (controller.unsettled === true) return finish('wait', 'next_slice_pending_native_reconciliation')
    if (Object.values(counts).some(value => value > 0)) return finish('continue', 'next_slice_work_owned', null, { ownership: counts })
    const operations = native?.operations
    const craft = native?.crafting_status
    const follow = native?.follow
    const known = typeof operations?.task_state === 'string' && Number.isSafeInteger(operations.queue_length)
      && typeof operations.queue_empty === 'boolean' && typeof craft?.task_active === 'boolean'
      && craft.native_queue && typeof follow?.active === 'boolean'
    const journal = nativeAdmissionJournal(operations?.admission_journal)
    if (!journal.known) return finish('wait', 'next_slice_native_ownership_unknown')
    if (journal.unresolved) return finish('wait', 'next_slice_native_admission_unsettled')
    if (!known) return finish('wait', 'next_slice_native_ownership_unknown')
    const busy = operations.task_state !== 'idle' || operations.queue_length !== 0 || operations.queue_empty !== true
      || Boolean(operations.active_batch) || craft.task_active || Object.keys(craft.native_queue).length > 0
      || Boolean(craft.persisted_owner) || follow.active || operations.actor?.mining_state?.mining

    if (busy) return finish('continue', 'next_slice_native_work_owned')
    const ack = controller.settlement
    const settled = ack?.schema === 1 && ack.native_reconciled === true && ack.instance_id === controller.instance_id && ack.boundary_key === boundary
      && ack.goal_id === goalId && ack.actor_id === actorId && ack.epoch === native.epoch
      && Number.isFinite(ack.settled_at) && ack.settled_at >= ack.requested_at && ack.settled_at <= controller.observed_at
      && now - ack.settled_at <= 30000
    if (settled) return finish('stop', 'confirmed_next_slice_owner_missing_after_settlement', 'controller_orphaned_after_runtime_settlement', { settlement: ack, ownership: counts })
    return { ...finish('request_settlement', 'next_slice_runtime_settlement_required'),
      request: { schema: 1, request_id: `${controller.instance_id}:${now}`, instance_id: controller.instance_id,
        goal_id: goalId, actor_id: actorId, epoch: native.epoch, boundary_key: boundary, requested_at: now } }
  }
  if (!['model_recoverable', 'transport'].includes(run.pause_class)) {
    return finish('stop', 'nonresumable_controller_pause', `controller_paused:${run.pause_class || 'unclassified'}`)
  }
  const plan = canonical.plans?.find(p => p.plan_id === canonical.active_plan_id)
  const stepId = plan?.steps?.[plan.active_step_index]?.step_id
  const scoped = events.filter(e => {
    const at = Date.parse(e.ts ?? e.timestamp)
    const d = e.data
    return Number.isFinite(at) && at >= startedAt && at <= now && d?.goal_id === canonical.goal?.goal_id
      && (e.actor_id == null || e.actor_id === actorId) && (d.actor_id == null || d.actor_id === actorId)
  })
  const exhausted = scoped.findLast(e => e.event === 'recovery.auto_resume_exhausted'
    && e.data?.plan_id === plan?.plan_id && e.data?.plan_version === plan?.plan_version && e.data?.step_id === stepId
    && (!Number.isFinite(run.paused_at) || Date.parse(e.ts ?? e.timestamp) >= run.paused_at)
    && !scoped.some(later => later.event === 'recovery.auto_resume_plan_resumed'
      && Date.parse(later.ts ?? later.timestamp) > Date.parse(e.ts ?? e.timestamp)))
  if (exhausted) return finish('stop', 'current_automatic_recovery_exhausted', 'auto_resume_exhausted', {
    request_id: exhausted.request_id, exhaustion_event: exhausted,
  })
  // Start from durable current-pause time when available; otherwise retain the
  // first observed time. A running observation clears the watcher completely.
  const since = Number.isFinite(run.paused_at) && run.paused_at >= startedAt && run.paused_at <= now
    ? run.paused_at : Number.isFinite(pausedSince) && pausedSince >= startedAt && pausedSince <= now ? pausedSince : now
  if (now - since >= 10 * 60000) return finish('stop', 'recoverable_pause_timeout',
    `controller_paused_not_resumed:${run.pause_class}`, {}, since)
  return finish('wait', 'bounded_automatic_recovery_pending', null, { pause_class: run.pause_class }, since)
}

// Supervisors must re-read current state immediately before an automatic stop.
// A parent hint or old diagnostic snapshot cannot bypass this classification.
export async function stopTrialIfTerminal({ readCurrent, stop, policy }) {
  const current = await readCurrent()
  let decision = trialStopDecision({ ...policy, ...current })
  if (decision.action === 'stop') {
    decision = trialStopDecision({ ...policy, ...await readCurrent() })
    if (decision.action === 'stop') await stop(decision)
  }
  return decision
}
