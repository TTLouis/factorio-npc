import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { structuralTerminal, quiesceAndSave, waitForStop, stopStateConfirmed } from './runner-terminal.mjs';

const fixture = JSON.parse(await fs.readFile(new URL('./run-s-blocked-observer-fixture.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture.canonical);
const receiptScope = { run_id: 'red-automation-live-2026-10-16v', trace_source: 'isolated_supervisor_behavior_trace', trace_path: '/data/logs/sgluna-behavior.jsonl' };
const actualT = JSON.parse(await fs.readFile(new URL('./run-t-stop-observer-fixture.json', import.meta.url), 'utf8'));

test('actual Run S BLOCKED/paused:false stops with the true structural cause', () => {
  const canonical = fresh();
  assert.equal(canonical.plans[0].status, 'BLOCKED');
  assert.equal(canonical.run.paused, false);
  const terminal = structuralTerminal(canonical);
  assert.equal(terminal.result, 'controller_blocked:canonical_plan');
  assert.deepEqual(terminal.evidence, {
    source: 'canonical_planning_state', reason: 'active_plan_blocked',
    goal_id: fixture.canonical.goal.goal_id,
    plan_id: canonical.plans[0].plan_id, plan_version: canonical.plans[0].plan_version,
    active_step_id: canonical.plans[0].steps[canonical.plans[0].active_step_index].step_id,
    canonical_plan_status: 'BLOCKED', blocker_kind: 'structural',
    blocker_reason_code: 'transfer_failed:no_target', requires_user_decision: true, run_paused: false,
  });
  assert.deepEqual(canonical, fixture.canonical, 'observation must not mutate canonical state');
});

test('explicit user decision also stops an executing plan independently of run.paused', () => {
  const canonical = fresh();
  canonical.plans[0].status = 'EXECUTING';
  assert.equal(structuralTerminal(canonical).result, 'controller_blocked:requires_user_decision');
  canonical.plans[0].blocker.requires_user_decision = false;
  assert.equal(structuralTerminal(canonical), null);
  canonical.plans[0].blocker.requires_user_decision = 'true';
  assert.equal(structuralTerminal(canonical), null);
});

test('BLOCKED itself is terminal even without a user-decision flag', () => {
  const canonical = fresh();
  delete canonical.plans[0].blocker;
  assert.equal(structuralTerminal(canonical).result, 'controller_blocked:canonical_plan');
});

test('healthy running and model/transport/operator pauses remain on their existing paths', () => {
  for (const status of ['DRAFT', 'COMMITTED', 'EXECUTING']) {
    for (const pause_class of ['', 'model_recoverable', 'transport', 'operator', 'guard']) {
      const canonical = fresh();
      canonical.plans[0].status = status;
      canonical.plans[0].blocker = null;
      canonical.run = { paused: pause_class !== '', pause_class };
      assert.equal(structuralTerminal(canonical), null);
    }
  }
});

test('completed measurement candidates and retired/historical blockers do not stop', () => {
  for (const status of ['COMPLETED', 'SUPERSEDED', 'CANCELLED', 'REJECTED']) {
    const canonical = fresh();
    canonical.plans[0].status = status;
    canonical.goal.status = 'completed';
    assert.equal(structuralTerminal(canonical), null, `stale blocker on ${status}`);
  }
  const canonical = fresh();
  canonical.plans.push({ plan_id: 'healthy-active', status: 'EXECUTING' });
  canonical.active_plan_id = 'healthy-active';
  assert.equal(structuralTerminal(canonical), null);
  canonical.active_plan_id = 'missing-active';
  assert.equal(structuralTerminal(canonical), null);
  assert.equal(structuralTerminal(undefined), null);
});

test('actual S terminal state fences AI, persists structural reason, then saves once without usage flags', async () => {
  const terminal = structuralTerminal(fresh());
  const calls = [];
  let persisted;
  await quiesceAndSave({
    rcon: { command: async command => calls.push(command) },
    confirmStopped: async () => ({ confirmed: true }),
    recordResult: async () => { persisted = JSON.parse(JSON.stringify({ result: terminal.result, terminal_evidence: terminal.evidence })); calls.push('result.persisted'); },
    saveName: 'red-automation-v-checkpoint',
    waitForSave: async () => calls.push('save.confirmed'),
  });
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'result.persisted', '/server-save red-automation-v-checkpoint', 'save.confirmed']);
  assert.equal(persisted.terminal_evidence.blocker_reason_code, 'transfer_failed:no_target');
  assert.equal(persisted.terminal_evidence.run_paused, false);
  assert.equal(persisted.result, 'controller_blocked:canonical_plan');
  assert.doesNotMatch(JSON.stringify(persisted), /weekly_hard_floor|usage.floor|stop-at-hard-floor/);
});

test('RCON acknowledgement does not allow result/save while supervisor stop confirmation is pending', async () => {
  let stopped;
  const fence = new Promise(resolve => { stopped = resolve; });
  const calls = [];
  const pending = quiesceAndSave({
    rcon: { command: async command => { calls.push(command); } },
    confirmStopped: async () => { calls.push('confirmation.pending'); await fence; return { confirmed: true }; },
    recordResult: async () => calls.push('result.persisted'),
    saveName: 'red-automation-v-checkpoint',
    waitForSave: async () => calls.push('save.confirmed'),
  });
  await Promise.resolve(); await Promise.resolve();
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'confirmation.pending']);
  stopped();
  await pending;
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'confirmation.pending', 'result.persisted', '/server-save red-automation-v-checkpoint', 'save.confirmed']);
});

const nativeIdle = () => ({ actor_id: 3, crafting_queue: [], operations: { task_state: 'idle', queue_empty: true, queue_length: 0, follow: { active: false }, actor: { mining_state: { mining: false } } } });
const stoppedState = () => {
  const canonical = fresh();
  canonical.run = { paused: true, pause_class: 'operator', pause_reason: 'user_stop', paused_at: 1000 };
  return { planning_states: [{ state: canonical }] };
};

test('confirmation requires fresh durable operator pause, canceled intake and native idle under the same goal/actor', () => {
  const input = { state: stoppedState(), native: nativeIdle(), issuedAt: 1000, goalId: fixture.canonical.goal.goal_id, actorId: 3 };
  assert.equal(stopStateConfirmed(input), true);
  for (const edit of [
    x => x.state.planning_states[0].state.run.paused = false,
    x => x.state.planning_states[0].state.run.pause_class = 'model_recoverable',
    x => x.state.planning_states[0].state.run.pause_reason = 'other',
    x => x.state.planning_states[0].state.run.paused_at = 999,
    x => x.state.intake_retry = { attempt: 1 },
    x => x.goalId = 'replacement-goal',
    x => x.native.actor_id = 4,
    x => x.native.operations.task_state = 'working',
    x => x.native.operations.queue_length = 1,
    x => x.native.operations.queue_empty = false,
    x => x.native.crafting_queue = [{}],
    x => x.native.operations.follow.active = true,
    x => x.native.operations.actor.mining_state.mining = true,
  ]) { const changed = structuredClone(input); edit(changed); assert.equal(stopStateConfirmed(changed), false); }
});

test('read-only poll waits for actual fresh stop state after acknowledgement', async () => {
  let tick = 1000, reads = 0;
  const proof = await waitForStop({
    readState: async () => { reads++; return reads === 1 ? { planning_states: [{ state: fresh() }], intake_retry: { attempt: 1 } } : stoppedState(); },
    readNative: async () => nativeIdle(), issuedAt: 1000, goalId: fixture.canonical.goal.goal_id, actorId: 3,
    now: () => tick, sleep: async ms => { tick += ms; }, pollMs: 10, timeoutMs: 100,
  });
  assert.equal(reads, 2);
  assert.equal(proof.operator_paused_at, 1000);
  assert.equal(proof.intake_retry_cleared, true);
  assert.equal(proof.confirmed_at, 1010);
});

test('stop timeout records safe incompleteness and never writes success or checkpoint', async () => {
  let tick = 1000;
  const calls = [];
  let failure;
  await assert.rejects(quiesceAndSave({
    rcon: { command: async command => calls.push(command) },
    now: () => tick,
    confirmStopped: ({ issuedAt }) => waitForStop({ readState: async () => ({ planning_states: [{ state: fresh() }] }), readNative: async () => nativeIdle(), issuedAt,
      goalId: fixture.canonical.goal.goal_id, actorId: 3, now: () => tick, sleep: async ms => { tick += ms; }, pollMs: 10, timeoutMs: 20 }),
    recordResult: async () => calls.push('success.persisted'), saveName: 'red-automation-v-checkpoint', waitForSave: async () => calls.push('save.confirmed'),
    onIncomplete: async value => { failure = value; calls.push('incomplete.persisted'); },
  }), { code: 'stop_confirmation_timeout' });
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'incomplete.persisted']);
  assert.equal(failure.result, 'stop_confirmation_incomplete');
});

test('a hanging native read cannot extend the stop confirmation deadline', async () => {
  await assert.rejects(waitForStop({ readState: async () => stoppedState(), readNative: () => new Promise(() => {}), issuedAt: 1000,
    goalId: fixture.canonical.goal.goal_id, actorId: 3, timeoutMs: 10 }), { code: 'stop_confirmation_timeout' });
});

test('completed goal cleared from memory needs a fresh supervisor cancel receipt before save', async () => {
  const state = { planning_states: [] };
  const receipt = { event: 'request.cancelled', ts: new Date(1001).toISOString(), actor_id: 3, epoch: 1, data: { reason: 'user_stop_immediate' } };
  const input = { state, native: nativeIdle(), issuedAt: 1000, goalId: fixture.canonical.goal.goal_id, actorId: 3, receipts: [receipt], receiptScope };
  assert.equal(stopStateConfirmed({ ...input, receipts: [] }), false);
  assert.equal(stopStateConfirmed(input), true);
  for (const edit of [
    x => x.receipts[0].ts = new Date(999).toISOString(),
    x => x.receipts[0].actor_id = 4,
    x => x.receipts[0].data.reason = 'other_cancel',
    x => x.state.intake_retry = { attempt: 1 },
    x => x.state.planning_states = [{ state: fresh() }],
    x => x.native.operations.queue_length = 1,
  ]) { const changed = structuredClone(input); edit(changed); assert.equal(stopStateConfirmed(changed), false); }
  let tick = 1000, reads = 0;
  const calls = [];
  let savedProof;
  await quiesceAndSave({
    rcon: { command: async command => calls.push(command) }, now: () => tick,
    confirmStopped: ({ issuedAt }) => waitForStop({ readState: async () => state, readNative: async () => nativeIdle(),
      readStopReceipts: async () => (++reads === 1 ? [] : [receipt]), receiptScope, issuedAt, goalId: input.goalId, actorId: 3,
      now: () => tick, sleep: async ms => { tick += ms; }, pollMs: 10, timeoutMs: 100 }),
    recordResult: async proof => { savedProof = proof; calls.push('result.persisted'); }, saveName: 'red-automation-v-checkpoint', waitForSave: async () => calls.push('save.confirmed'),
  });
  assert.equal(reads, 2);
  assert.equal(savedProof.boundary, 'fresh_supervisor_cancel_receipt_no_goal');
  assert.equal(savedProof.stop_receipt.reason, 'user_stop_immediate');
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'result.persisted', '/server-save red-automation-v-checkpoint', 'save.confirmed']);
});

test('intake before goal admission can confirm only after retry is cleared and the stop receipt arrives', () => {
  const input = { state: { planning_states: [], intake_retry: { attempt: 1 } }, native: nativeIdle(), issuedAt: 1000,
    actorId: 3, receiptScope, receipts: [{ event: 'request.cancelled', ts: new Date(1001).toISOString(), actor_id: 3, data: { reason: 'user_stop_immediate' } }] };
  assert.equal(stopStateConfirmed(input), false);
  delete input.state.intake_retry;
  assert.equal(stopStateConfirmed(input), true);
  input.receipts = [];
  assert.equal(stopStateConfirmed(input), false);
});

test('actual production completion clears epoch and emits an unstamped stop receipt bound by isolated provenance/native actor', async () => {
  const { NpcAgentLoop } = await import(new URL('/candidate/deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs', import.meta.url));
  const { CanonicalTaskBoardMemory } = await import(new URL('/candidate/deploy/pterodactyl/runtime-v8/canonical-task-board-memory.mjs', import.meta.url));
  const { applyPlanningEvent, PLANNING_EVENT } = await import(new URL('/candidate/deploy/pterodactyl/runtime-v8/planning-state.mjs', import.meta.url));
  const memory = new CanonicalTaskBoardMemory();
  const key = 'npc:sgluna', goalId = 'goal_observer_completed';
  memory.planningByNpc.set(key, applyPlanningEvent(undefined, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1, goal_id: goalId, owner: 'fixture', objective: 'verified observer completion fixture' }));
  memory.recordGoalSatisfaction(key, { source: 'runtime', evidenceRefs: ['fixture/authoritative-completion'], rationale: 'Completion-only fixture; no gameplay inferred.' });
  assert.equal(memory.planningState(key).goal.status, 'completed');
  const agent = new NpcAgentLoop({ memory, npcId: 'sgluna', rcon: { command: async () => { throw Error('unexpected native command'); } },
    provider: async () => { throw Error('unexpected provider call'); }, systemPrompt: 'observer stop receipt test', stateFile: null, traceFile: null, decisionTraceFile: null });
  const rows = [];
  agent.behaviorTrace = { emit: async row => rows.push(row) };
  agent.epoch = { actor_id: 3, epoch: 1 };
  assert.equal(await agent.finalizeCompletedTaskContext({ goalId, goalStatus: 'completed' }), true);
  assert.equal(agent.epoch, null);
  assert.equal(memory.planningState(key)?.goal ?? null, null);
  const issuedAt = Date.now();
  agent.cancel('user_stop_immediate');
  await Promise.resolve();
  const receipt = JSON.parse(JSON.stringify(rows.find(row => row.event === 'request.cancelled' && row.data.reason === 'user_stop_immediate')));
  assert.equal(Object.hasOwn(receipt, 'actor_id'), false, 'use the real finalized trace shape');
  assert.equal(Object.hasOwn(receipt, 'epoch'), false);
  const input = { state: memory.snapshot(), native: nativeIdle(), issuedAt, goalId, actorId: 3, receipts: [receipt], receiptScope };
  assert.equal(stopStateConfirmed(input), true);
  assert.equal(stopStateConfirmed({ ...input, receiptScope: undefined }), false);
  assert.equal(stopStateConfirmed({ ...input, receiptScope: { ...receiptScope, trace_source: 'other_trace' } }), false);
  assert.equal(stopStateConfirmed({ ...input, receipts: [] }), false);
  assert.equal(stopStateConfirmed({ ...input, receipts: [{ ...receipt, ts: new Date(issuedAt - 1).toISOString() }] }), false);
  assert.equal(stopStateConfirmed({ ...input, receipts: [{ ...receipt, actor_id: 4 }] }), false);
  assert.equal(stopStateConfirmed({ ...input, native: { ...nativeIdle(), actor_id: 4 } }), false);
});

test('actual Run T already-paused stop passes only with fresh cancel and same-goal operator-pause traces; original helper fails', async () => {
  const original = await import('./reference/original-runner-terminal.mjs');
  assert.ok(actualT.state.planning_states[0].state.run.paused_at < actualT.issuedAt);
  assert.equal(Object.hasOwn(actualT.receipts[0], 'actor_id'), false);
  assert.equal(original.stopStateConfirmed(actualT), false, 'original-code control reproduces live timeout');
  assert.equal(stopStateConfirmed(actualT), true);
  const proof = await waitForStop({ readState: async () => actualT.state, readNative: async () => actualT.native,
    readStopReceipts: async () => actualT.receipts, receiptScope: actualT.receiptScope,
    issuedAt: actualT.issuedAt, goalId: actualT.goalId, actorId: actualT.actorId });
  assert.equal(proof.boundary, 'fresh_supervisor_cancel_and_same_goal_operator_pause');
  assert.equal(proof.operator_paused_at, actualT.state.planning_states[0].state.run.paused_at);
  assert.equal(proof.stop_receipt.ts, actualT.receipts[0].ts);
  assert.equal(proof.operator_pause_receipt.data.goal_id, actualT.goalId);
});

test('actual Run T trace fallback rejects stale/missing/wrong-goal/wrong-actor or unbound receipts', () => {
  const negatives = [
    x => x.receipts = [],
    x => x.receipts = [x.receipts[0]],
    x => x.receipts = [x.receipts[1]],
    x => x.receipts[0].ts = new Date(x.issuedAt - 1).toISOString(),
    x => x.receipts[1].ts = new Date(x.issuedAt - 1).toISOString(),
    x => x.receipts[1].ts = new Date(x.issuedAt).toISOString(), // pause precedes cancel
    x => x.receipts[0].data.reason = 'other_cancel',
    x => x.receipts[1].data.cause = 'model_pause',
    x => x.receipts[1].data.pause_class = 'model_recoverable',
    x => x.receipts[1].data.goal_id = 'wrong-goal',
    x => x.receipts[0].actor_id = 999,
    x => x.receipts[1].actor_id = 999,
    x => x.receiptScope = undefined,
    x => x.receiptScope.run_id = '',
    x => x.receiptScope.trace_source = 'other_run_trace',
    x => x.receiptScope.trace_path = '/data/logs/unrelated.jsonl',
    x => x.goalId = 'replacement-goal',
  ];
  for (const edit of negatives) { const input = structuredClone(actualT); edit(input); assert.equal(stopStateConfirmed(input), false); }
});

test('actual Run T fresh traces cannot override durable pause/intake/native actor or work guards', () => {
  const negatives = [
    x => x.state.planning_states[0].state.run.paused = false,
    x => x.state.planning_states[0].state.run.pause_class = 'model_recoverable',
    x => x.state.planning_states[0].state.run.pause_reason = 'other',
    x => x.state.intake_retry = { attempt: 1 },
    x => x.native.actor_id = 999,
    x => x.native.operations.task_state = 'working',
    x => x.native.operations.queue_empty = false,
    x => x.native.operations.queue_length = 1,
    x => x.native.crafting_queue = [{}],
    x => x.native.operations.follow.active = true,
    x => x.native.operations.actor.mining_state.mining = true,
  ];
  for (const edit of negatives) { const input = structuredClone(actualT); edit(input); assert.equal(stopStateConfirmed(input), false); }
});

test('RCON ack plus old Run T operator pause remains unsaved until both fresh receipts arrive', async () => {
  const calls = []; let reads = 0, tick = actualT.issuedAt;
  let proof;
  await quiesceAndSave({
    rcon: { command: async command => calls.push(command) }, now: () => tick,
    confirmStopped: ({ issuedAt }) => waitForStop({ issuedAt, goalId: actualT.goalId, actorId: actualT.actorId,
      readState: async () => actualT.state, readNative: async () => actualT.native,
      readStopReceipts: async () => { reads++; assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop']); return reads === 1 ? [] : reads === 2 ? [actualT.receipts[0]] : actualT.receipts; },
      receiptScope: actualT.receiptScope, now: () => tick, sleep: async ms => { tick += ms; }, pollMs: 10, timeoutMs: 100 }),
    recordResult: async value => { proof = value; calls.push('result.persisted'); }, saveName: 'red-automation-v-checkpoint', waitForSave: async () => calls.push('save.confirmed'),
  });
  assert.equal(reads, 3);
  assert.equal(proof.boundary, 'fresh_supervisor_cancel_and_same_goal_operator_pause');
  assert.match(calls[0], /sgluna_tick_sprint.*seal/); assert.deepEqual(calls.slice(1), ['!luna stop', 'result.persisted', '/server-save red-automation-v-checkpoint', 'save.confirmed']);
});

test('actual production model pause then user stop keeps old paused_at, clears epoch and emits the required fresh pair', async () => {
  const { NpcAgentLoop } = await import(new URL('/candidate/deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs', import.meta.url));
  const { CanonicalTaskBoardMemory } = await import(new URL('/candidate/deploy/pterodactyl/runtime-v8/canonical-task-board-memory.mjs', import.meta.url));
  const snapshot = JSON.parse(await fs.readFile(new URL('./reference/run-t-model-paused-production-fixture.json', import.meta.url), 'utf8'));
  const memory = new CanonicalTaskBoardMemory();
  memory.restore(snapshot);
  const key = 'npc:npc-1';
  const priorAt = memory.planningState(key).run.paused_at;
  assert.equal(memory.planningState(key).run.pause_class, 'model_recoverable');
  const agent = new NpcAgentLoop({ memory, npcId: 'npc-1', rcon: { command: async () => { throw Error('unexpected native command'); } },
    provider: async () => { throw Error('unexpected provider call'); }, systemPrompt: 'observer model-pause stop test', stateFile: null, traceFile: null, decisionTraceFile: null });
  const rows = [];
  agent.behaviorTrace = { emit: async row => rows.push(row) };
  agent.epoch = { actor_id: 1, epoch: 1 };
  await agent.pausePersistentPlan('provider_action_omission_repair_failed', { pause_class: 'model_recoverable' });
  assert.equal(agent.epoch, null);
  const issuedAt = Date.now();
  agent.cancel('user_stop_immediate');
  await agent.pausePersistentPlan('user_stop', { pause_class: 'operator' });
  const receipts = JSON.parse(JSON.stringify(rows.filter(e => Date.parse(e.ts) >= issuedAt)));
  const cancelled = receipts.find(e => e.event === 'request.cancelled' && e.data.reason === 'user_stop_immediate');
  const paused = receipts.find(e => e.event === 'goal.paused' && e.data.cause === 'user_stop');
  assert.ok(cancelled && paused);
  assert.equal(Object.hasOwn(cancelled, 'actor_id'), false);
  assert.equal(memory.planningState(key).run.paused_at, priorAt);
  assert.equal(memory.planningState(key).run.pause_class, 'operator');
  assert.equal(stopStateConfirmed({ state: memory.snapshot(), native: actualT.native, issuedAt,
    goalId: actualT.goalId, actorId: 1, receipts, receiptScope }), true);
});
