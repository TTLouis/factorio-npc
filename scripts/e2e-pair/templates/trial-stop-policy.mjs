import { sprintSpeedValid } from './tick-sprint-policy.mjs'
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
  goalId, actorId, native, constructionLimitMs = 45 * 60000, hardFloorReached = false, speedPolicy = { profile: 'normal' } }) {
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
  if (run?.paused !== true) return finish('continue', 'controller_running')
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
