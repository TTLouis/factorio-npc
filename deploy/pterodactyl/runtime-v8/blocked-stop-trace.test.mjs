import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPendingOperation, EFFECT } from './operation-reconciliation.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { FurnaceFactorio, KEY, recoverySession, recoveryWorld, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'

// Run X's failed request had already reset the conversation and actor epoch.
// These exercise the real chat stop -> Session queue -> durable pause -> trace
// -> native cancellation path, with an already BLOCKED immutable plan.
async function blockedWorld() {
  let decisionCalls = 0
  const model = new ScriptedModel()
  const world = recoveryWorld({
    game: new FurnaceFactorio({ inventory: { 'copper-ore': 10 } }),
    model,
    decisionScript: () => { decisionCalls++; throw new Error('Stop must not ask Jev') },
  })
  const { memory, agent } = world
  const plan = {
    chatMessage: 'Finish copper smelting, then build power.',
    plan: ['Smelt copper to hold fifteen plates', 'Build steam power'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
  const recorded = memory.recordPlan(KEY, { sender: 'TTLouis', text: 'Automate red science' }, plan)
  memory.reconcileTaskBoard(KEY, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(KEY, { now: 100, runtime_validation: { passed: true } })
  const held = getActivePlan(memory.planningState(KEY))
  const pending = buildPendingOperation({
    requestId: 'run_x_failed_request',
    goalId: recorded.state.goal_id,
    planId: held.plan_id,
    stepId: held.steps[held.active_step_index].step_id,
    actor: { actor_id: 18, epoch: 3 },
    operations: [{ name: 'supply_entity', args: { unit_number: 26, items: [{ item_name: 'copper-ore', count: 5 }] } }],
    now: 200,
  })
  assert.ok(memory.recordPendingOperation(KEY, { ...pending, effect: EFFECT.PARTIAL_UNKNOWN }))
  memory.applyOutcomeAuthority(KEY, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'transfer_failed:nothing_moved:target_rejects_item',
    candidate_blocker: 'transfer_failed:nothing_moved:target_rejects_item',
    evidence: [{ kind: 'operation_error_receipt', ref: 'batch-g1-20', summary: 'Three transfers completed; copper transfer refused by the furnace.' }],
  })
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)
  assert.equal(memory.pauseRecord(KEY).paused, false)
  agent.traceRequest = { id: 'run_x_failed_request', seq: 0 }
  await agent.traceEvent('request.failed', { message: 'missing_step_completions', recoverable: false })
  agent.traceRequest = null
  agent.reset()
  const sessionContext = recoverySession(world)
  return { ...world, ...sessionContext, decisionCalls: () => decisionCalls }
}

function immutableBoundary(ctx) {
  const planning = ctx.memory.planningState(KEY)
  return structuredClone({ goal: planning.goal, plan: getActivePlan(planning), pending: ctx.memory.pendingOperation(KEY) })
}

async function stopThroughChat(ctx) {
  const start = ctx.trace.length
  const issuedAt = Date.now()
  // The native !luna parser hands Session the stripped control word.
  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'stop'), true)
  await settle(ctx.session)
  const rows = ctx.trace.slice(start)
  const cancel = rows.find(row => row.event === 'request.cancelled' && row.data.reason === 'user_stop_immediate')
  const paused = rows.find(row => row.event === 'goal.paused')
  assert.ok(cancel, 'actual fresh supervisor cancellation is required')
  assert.ok(paused, 'actual same-goal operator pause trace is required even when the plan stays BLOCKED')
  assert.ok(Date.parse(cancel.ts) >= issuedAt)
  assert.ok(Date.parse(paused.ts) >= Date.parse(cancel.ts))
  assert.equal(paused.data.goal_id, ctx.memory.planningState(KEY).goal.goal_id)
  assert.equal(paused.data.request_id, 'run_x_failed_request')
  assert.equal(paused.request_id, 'run_x_failed_request')
  assert.equal(paused.data.cause, 'user_stop')
  assert.equal(paused.data.pause_reason, 'user_stop')
  assert.equal(paused.data.pause_class, PAUSE_CLASS.OPERATOR)
  assert.equal(paused.data.source, 'pause_persistent_plan')
  assert.equal(rows.filter(row => row.event === 'goal.paused').length, 1)
  return { cancel, paused }
}

test('Run X full-loop blocked stop produces the strict fresh cancellation/pause pair without changing plan or uncertain effects', async () => {
  const ctx = await blockedWorld()
  const before = immutableBoundary(ctx)
  assert.equal(ctx.agent.epoch, null, 'the failed request already reset execution identity')
  assert.equal(ctx.trace.filter(row => row.event === 'goal.paused').length, 0, 'BLOCKED alone is not a pause')
  await stopThroughChat(ctx)
  assert.deepEqual(immutableBoundary(ctx), before)
  assert.equal(ctx.memory.currentPlan(KEY).status, 'blocked')
  const run = ctx.memory.planningState(KEY).run
  assert.equal(run.paused, true)
  assert.equal(run.pause_class, PAUSE_CLASS.OPERATOR)
  assert.equal(run.pause_reason, 'user_stop')
  assert.equal(ctx.memory.pendingOperation(KEY).effect, EFFECT.PARTIAL_UNKNOWN)
  assert.equal(ctx.game.taskState, 'idle')
  assert.equal(ctx.game.queueLength, 0)
  assert.equal(ctx.game.cancels.length, 1)
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.model.calls.length, 0)
  assert.equal(ctx.decisionCalls(), 0)
  assert.equal(ctx.session.modelResume, null)
  assert.deepEqual(ctx.game.unknown, [])
})

test('a repeated explicit stop emits another fresh pair while preserving the original durable pause timestamp', async () => {
  const ctx = await blockedWorld()
  await stopThroughChat(ctx)
  const run = structuredClone(ctx.memory.planningState(KEY).run)
  const before = immutableBoundary(ctx)
  await stopThroughChat(ctx)
  assert.deepEqual(immutableBoundary(ctx), before)
  assert.equal(ctx.memory.planningState(KEY).run.paused_at, run.paused_at)
  assert.equal(ctx.memory.planningState(KEY).run.pause_count, run.pause_count)
  assert.equal(ctx.trace.filter(row => row.event === 'goal.paused').length, 2)
  assert.equal(ctx.game.cancels.length, 2)
  assert.equal(ctx.model.calls.length, 0)
  assert.equal(ctx.decisionCalls(), 0)
})

test('pause tracing refuses unpaused canonical truth and a pause record for another goal', async () => {
  const ctx = await blockedWorld()
  assert.equal(ctx.agent.goalPausedTrace('no_pause'), undefined)
  const goal = ctx.memory.planningState(KEY).goal.goal_id
  ctx.memory.pauseRecord = () => ({ paused: true, pause_reason: 'user_stop', pause_class: PAUSE_CLASS.OPERATOR, goal_id: `${goal}_stale` })
  assert.equal(ctx.agent.goalPausedTrace('stale_goal'), undefined)
  ctx.memory.pauseRecord = () => ({ paused: false, pause_reason: 'user_stop', pause_class: PAUSE_CLASS.OPERATOR, goal_id: goal })
  ctx.memory.planByNpc.get(KEY).status = 'paused' // stale legacy projection cannot invent a durable pause
  assert.equal(ctx.agent.goalPausedTrace('stale_legacy'), undefined)
})
