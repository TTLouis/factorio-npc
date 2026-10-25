// Observer policy only. Canonical plan authority, never model text or history.
export function structuralTerminal(canonical) {
  const plan = Array.isArray(canonical?.plans)
    ? canonical.plans.find(p => p.plan_id === canonical.active_plan_id)
    : undefined;
  if (!plan) return null;
  const liveStatuses = ['DRAFT', 'COMMITTED', 'EXECUTING', 'BLOCKED'];
  if (!liveStatuses.includes(plan.status)) return null;
  const blocked = plan.status === 'BLOCKED';
  const requiresDecision = plan.blocker?.requires_user_decision === true;
  if (!blocked && !requiresDecision) return null;
  return {
    result: blocked ? 'controller_blocked:canonical_plan' : 'controller_blocked:requires_user_decision',
    evidence: {
      source: 'canonical_planning_state',
      reason: blocked ? 'active_plan_blocked' : 'active_plan_requires_user_decision',
      goal_id: canonical.goal?.goal_id,
      plan_id: plan.plan_id,
      plan_version: plan.plan_version,
      active_step_id: plan.steps?.[plan.active_step_index]?.step_id,
      canonical_plan_status: plan.status,
      blocker_kind: plan.blocker?.kind,
      blocker_reason_code: plan.blocker?.reason_code,
      requires_user_decision: requiresDecision,
      run_paused: canonical.run?.paused === true,
    },
  };
}

import { idle } from './automation-proof.mjs';

function stopBoundary({ state, native, receipts = [], receiptScope, issuedAt, goalId, actorId }) {
  if (!state || state.intake_retry != null || !actorId || native?.actor_id !== actorId || !idle(native)) return null;
  const canonical = state?.planning_states?.find(p => p.state?.goal?.goal_id === goalId)?.state;
  const run = canonical?.run;
  if (goalId && run?.paused === true && run.pause_class === 'operator'
    && run.pause_reason === 'user_stop' && Number.isFinite(run.paused_at) && run.paused_at >= issuedAt
  ) return { boundary: 'durable_operator_pause', operator_paused_at: run.paused_at };
  // Completion clears the goal/plan; intake may fail before one exists. Do not
  // mistake absent state + idle for proof that the supervisor handled our stop.
  if (state.planning_states?.some(p => p.state?.goal)) return null;
  if (!receiptScope?.run_id || receiptScope.trace_source !== 'isolated_supervisor_behavior_trace'
    || receiptScope.trace_path !== '/data/logs/sgluna-behavior.jsonl') return null;
  const receipt = receipts.find(e => e.event === 'request.cancelled' && e.data?.reason === 'user_stop_immediate'
    // Real completion clears agent.epoch, so the emitted stop receipt has no
    // actor stamp. Its isolated-run trace provenance and fresh native actor bind
    // that path; an explicit different actor is always rejected.
    && (e.actor_id == null || e.actor_id === actorId) && Number.isFinite(Date.parse(e.ts)) && Date.parse(e.ts) >= issuedAt);
  return receipt ? { boundary: 'fresh_supervisor_cancel_receipt_no_goal', stop_receipt: {
    event: receipt.event, reason: receipt.data.reason, ts: receipt.ts, actor_id: receipt.actor_id, epoch: receipt.epoch,
  }, receipt_scope: receiptScope } : null;
}

export function stopStateConfirmed(input) {
  return Boolean(stopBoundary(input));
}

export async function waitForStop({ readState, readNative, readStopReceipts = async () => [], receiptScope, issuedAt, goalId, actorId,
  timeoutMs = 30000, pollMs = 250, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw Object.assign(new Error('Operator pause/native idle were not confirmed before the stop deadline'), { code: 'stop_confirmation_timeout' });
    let timer;
    let state, native, receipts;
    try {
      [state, native, receipts] = await Promise.race([
        Promise.all([readState(), readNative(), readStopReceipts()]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Stop-state read exceeded the confirmation deadline'), { code: 'stop_confirmation_timeout' })), remaining); }),
      ]);
    } finally { clearTimeout(timer); }
    const boundary = stopBoundary({ state, native, receipts, receiptScope, issuedAt, goalId, actorId });
    if (now() <= deadline && boundary) {
      return { submitted_at: issuedAt, confirmed_at: now(), ...boundary,
        goal_id: goalId, actor_id: actorId, intake_retry_cleared: true, native_task_state: native.operations.task_state,
        native_queue_length: native.operations.queue_length, native_crafting_queue_empty: true };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

// RCON acknowledgement is not supervisor cancellation. Require read-only proof.
export async function quiesceAndSave({ rcon, confirmStopped, recordResult, saveName, waitForSave,
  onIncomplete = async () => {}, now = Date.now }) {
  const issuedAt = now();
  let confirmation;
  try {
    await rcon.command('!luna stop');
    confirmation = await confirmStopped({ issuedAt });
  } catch (error) {
    await onIncomplete({ result: 'stop_confirmation_incomplete', submitted_at: issuedAt,
      code: error?.code ?? 'stop_confirmation_failed', message: error?.message ?? String(error) });
    throw error;
  }
  await recordResult(confirmation);
  await rcon.command(`/server-save ${saveName}`);
  await waitForSave();
}
