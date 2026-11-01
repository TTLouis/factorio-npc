export { structuralTerminal } from './trial-stop-policy.mjs';
import { idle } from './automation-proof.mjs';

function stopBoundary({ state, native, receipts = [], receiptScope, issuedAt, goalId, actorId, requirePairedReceipts = false }) {
  if (!state || state.intake_retry != null || !actorId || native?.actor_id !== actorId || !idle(native)) return null;
  const canonical = state?.planning_states?.find(p => p.state?.goal?.goal_id === goalId)?.state;
  const run = canonical?.run;
  if (!requirePairedReceipts && goalId && run?.paused === true && run.pause_class === 'operator'
    && run.pause_reason === 'user_stop' && Number.isFinite(run.paused_at) && run.paused_at >= issuedAt
  ) return { boundary: 'durable_operator_pause', operator_paused_at: run.paused_at };
  if (!receiptScope?.run_id || receiptScope.trace_source !== 'isolated_supervisor_behavior_trace'
    || receiptScope.trace_path !== '/data/logs/sgluna-behavior.jsonl') return null;
  // A previous model pause or completion can already have cleared agent.epoch.
  // Missing actor stamps are bound by this isolated trace and native actor;
  // an explicit different actor is never accepted.
  const fresh = e => (e.actor_id == null || e.actor_id === actorId)
    && (e.data?.actor_id == null || e.data.actor_id === actorId)
    && Number.isFinite(Date.parse(e.ts)) && Date.parse(e.ts) >= issuedAt;
  const receipt = receipts.find(e => fresh(e) && e.event === 'request.cancelled' && e.data?.reason === 'user_stop_immediate');
  if (goalId && run?.paused === true && run.pause_class === 'operator' && run.pause_reason === 'user_stop' && receipt) {
    // RUN_PAUSED intentionally preserves paused_at when a model-paused goal is
    // stopped. Require both fresh supervisor events, not the old timestamp.
    const paused = receipts.find(e => fresh(e) && e.event === 'goal.paused'
      && e.data?.goal_id === goalId && e.data?.cause === 'user_stop' && e.data?.pause_class === 'operator'
      && Date.parse(e.ts) >= Date.parse(receipt.ts));
    if (paused) return { boundary: 'fresh_supervisor_cancel_and_same_goal_operator_pause',
      operator_paused_at: run.paused_at, stop_receipt: receipt, operator_pause_receipt: paused, receipt_scope: receiptScope };
  }
  if (requirePairedReceipts) return null;
  // Completion clears the goal/plan; intake may fail before one exists. Do not
  // mistake absent state + idle for proof that the supervisor handled our stop.
  if (state.planning_states?.some(p => p.state?.goal)) return null;
  return receipt ? { boundary: 'fresh_supervisor_cancel_receipt_no_goal', stop_receipt: {
    event: receipt.event, reason: receipt.data.reason, ts: receipt.ts, actor_id: receipt.actor_id, epoch: receipt.epoch,
  }, receipt_scope: receiptScope } : null;
}

export function stopStateConfirmed(input) {
  return Boolean(stopBoundary(input));
}

export async function waitForStop({ readState, readNative, readStopReceipts = async () => [], receiptScope, issuedAt, goalId, actorId, requirePairedReceipts = false,
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
    const boundary = stopBoundary({ state, native, receipts, receiptScope, issuedAt, goalId, actorId, requirePairedReceipts });
    if (now() <= deadline && boundary) {
      return { submitted_at: issuedAt, confirmed_at: now(), ...boundary,
        goal_id: goalId, actor_id: actorId, intake_retry_cleared: true, native_task_state: native.operations.task_state,
        native_queue_length: native.operations.queue_length, native_crafting_queue_empty: true };
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export async function issueAndConfirmStrictStop({ rcon, readState, readNative, readStopReceipts, receiptScope,
  goalId, actorId, timeoutMs, now = Date.now, sleep }) {
  const issuedAt = now();
  await rcon.command('/silent-command if remote.interfaces.sgluna_tick_sprint then local g=remote.call("sgluna_tick_sprint","status");if g.binding then local s=remote.call("sgluna_tick_sprint","seal","strict_stop_or_measurement");assert(s.speed==1 and not s.lease) end end');
  await rcon.command('!luna stop');
  const confirmation = await waitForStop({ readState, readNative, readStopReceipts, receiptScope,
    issuedAt, goalId, actorId, requirePairedReceipts: true, timeoutMs, now, sleep });
  const [state, native, receipts] = await Promise.all([readState(), readNative(), readStopReceipts()]);
  if (!stopStateConfirmed({ state, native, receipts, receiptScope, issuedAt, goalId, actorId, requirePairedReceipts: true })) {
    throw Object.assign(new Error('Strict stop became invalid after confirmation'), { code: 'stop_confirmation_race' });
  }
  return { ...confirmation, revalidated_at: now() };
}

// RCON acknowledgement is not supervisor cancellation. Require read-only proof.
export async function quiesceAndSave({ rcon, confirmStopped, recordResult, saveName, waitForSave,
  onIncomplete = async () => {}, now = Date.now }) {
  const issuedAt = now();
  let confirmation;
  try {
    await rcon.command('/silent-command if remote.interfaces.sgluna_tick_sprint then local g=remote.call("sgluna_tick_sprint","status");if g.binding then local s=remote.call("sgluna_tick_sprint","seal","strict_stop_or_measurement");assert(s.speed==1 and not s.lease) end end');
    await rcon.command('!luna stop');
    confirmation = await confirmStopped({ issuedAt });
  } catch (error) {
    await onIncomplete({ result: 'stop_confirmation_incomplete', submitted_at: issuedAt,
      code: error?.code ?? 'stop_confirmation_failed', message: error?.message ?? String(error) });
    throw error;
  }
  await recordResult(confirmation);
  const saveRequestedAt = now();
  await rcon.command(`/server-save ${saveName}`);
  await waitForSave({ saveRequestedAt });
}
