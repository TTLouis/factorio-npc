import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { WORLD_REFUSAL_UNCORRECTED_REASON } from './npc-agent-loop.mjs'
import { MODEL_RECOVERABLE_RESUME_LIMITS } from './pause-class.mjs'
import {
  assertStrictBoundary,
  BLOCKED_REPLY,
  collect,
  completeAndReport,
  executorPlan,
  fireResumeTimer,
  KEY,
  observation,
  parseAdmittedOperations,
  PLATES,
  reachRunG,
  recoverySession,
  recoveryWorld,
  ScriptedModel,
  settle,
  stepBlockLines,
} from './recovery-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { deployment, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Unit 17 (composed recovery-loop regressions). Earlier focused recovery tests often stopped at checkpoint acceptance or batch admission,
// or called resume helpers directly with scripted inventory readings. These drive the live failure chain
// (run G -> H -> I, 2026-10-14) through the production scheduling path to a verified completion: a player request, the mod's
// completion line, goal.paused -> considerPauseForAutoResume, the mocked 15 s timer, the fired resume, the restage, the executor's
// batch, the game's receipt and the harness's own verification. The fake game changes only through admitted operations (see
// recovery-loop-fixtures.mjs); the scripted model throws on any call a scenario did not script; zero humans are connected.

const rowsOf = (ctx, name) => ctx.world.named(name)
const indexOfRow = (ctx, predicate, from = 0) => ctx.world.trace.findIndex((row, index) => index >= from && predicate(row))
const isC7Restage = row => row.event === 'context.restaged' && row.data.checkpoint === 'C7'

test('R-scope: a recovery timer inherited from a discarded turn starts a fresh supervised turn and finishes', async (t) => {
  const ctx = await reachRunG(t)
  ctx.model.push('executor', 'scope:observe', observation())
    .push('executor', 'scope:collect', executorPlan([collect(3)]))
  const oldScope = {
    generation: ctx.world.agent.generation - 1,
    lineage: ctx.world.agent.agentContext.lineageSequence,
    requestId: 'discarded_turn',
  }
  await ctx.world.agent.turnScope.run(oldScope, () => fireResumeTimer(ctx))
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-plate'], 12)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.world.named('context.stale_reply_dropped').length, 0)
  const detached = ctx.world.named('recovery.queue_scope_detached').find(row => row.origin_request_id === 'discarded_turn')
  assert.equal(detached.reason, 'supervisor_event_starts_fresh_turn')
  assert.ok(detached.request_id)
  assertStrictBoundary(ctx)
})

test('R-GHI: run G, H and I through the scheduled resume reach a verified completion, with the same goal and plan throughout', async (t) => {
  const ctx = await reachRunG(t)
  const { game, model, world, session, chat } = ctx
  const { memory } = world
  const identity = (() => {
    const { goal_id: goalId, plan_id: planId, plan_version: planVersion, step_id: stepId } = memory.autoResumeAllowance(KEY)
    return { goal_id: goalId, plan_id: planId, plan_version: planVersion, step_id: stepId }
  })()

  // --- run G: the mixed-ore batch is refused before admission, corrected once, refused again ----------------------------------------
  assert.deepEqual(model.labels, [
    'planner:observe', 'planner:load-furnace', 'executor:observe', 'executor:collect-ready-plates',
    'executor:observe-again', 'executor:mixed-ore-batch', 'executor:mixed-ore-batch-again',
  ])
  assert.deepEqual(game.preflights.filter(entry => entry.result.ok === false).map(entry => [entry.name, entry.result.code]),
    [['supply_entity', 'supply_missing'], ['supply_entity', 'supply_missing']], 'the game refused the batch both times; the loop reads the one-slot conflict out of that answer')
  const [correction, ...extraCorrections] = rowsOf(ctx, 'operations.preflight_recoverable')
  assert.equal(extraCorrections.length, 0, 'one correction turn only')
  assert.equal(correction.failure_class, 'world_correction_supply_destination_conflict')
  assert.equal(rowsOf(ctx, 'operations.preflight_rejected')[0].reason, WORLD_REFUSAL_UNCORRECTED_REASON)
  assert.equal(game.sent.length, ctx.worldBeforeRefusal.sent, 'the refused batch never reached the game')
  assert.equal(game.effects.length, ctx.worldBeforeRefusal.effects)
  assert.deepEqual(game.worldTotals(), ctx.worldBeforeRefusal.totals, 'a refused batch changed nothing in the world')
  const pausedG = memory.pauseRecord(KEY)
  assert.deepEqual([pausedG.paused, pausedG.pause_class], [true, 'model_recoverable'])
  assert.match(pausedG.pause_reason, new RegExp(WORLD_REFUSAL_UNCORRECTED_REASON))
  // The pause queued its own resume decision through the agent's goal.paused activity: nothing in this test called the supervisor.
  const [scheduledG, ...laterScheduled] = rowsOf(ctx, 'recovery.auto_resume_scheduled')
  assert.equal(laterScheduled.length, 0)
  assert.deepEqual([scheduledG.attempt, scheduledG.limit, scheduledG.goal_attempt, scheduledG.goal_limit, scheduledG.delay_ms], [1, 2, 1, 6, 15_000])
  assert.deepEqual([scheduledG.actor_id, scheduledG.actor_epoch, scheduledG.goal_id, scheduledG.plan_id, scheduledG.plan_version, scheduledG.step_id],
    [18, 3, identity.goal_id, identity.plan_id, identity.plan_version, identity.step_id])
  assert.ok(session.modelResume.timer, 'the resume is waiting on its timer')
  assert.equal(rowsOf(ctx, 'recovery.auto_resume_started').length, 0, 'nothing resumed before the timer fired')

  // --- run H: the resumed executor answers a checkpoint with no operation, then makes an unverified BLOCKED claim -----------------------
  const duringH = []
  model
    .push('executor', 'h:checkpoint-only', () => {
      const plan = memory.currentPlan(KEY)
      duringH.push({ status: plan.status, board: plan.task_board.status, runPaused: memory.pauseRecord(KEY).paused, pauseClass: memory.pauseRecord(KEY).pause_class })
      return executorPlan([], { checkpoint: PLATES })
    })
    .push('executor', 'h:blocked-claim', BLOCKED_REPLY(), 2)
    .push('executor', 'i:collect-machine-output', (messages) => {
      const planning = memory.planningState(KEY)
      ctx.atI = {
        packet: stepBlockLines(messages),
        plans: planning.plans.map(plan => [plan.plan_id, plan.plan_version]),
        goalId: planning.goal.goal_id,
        status: memory.currentPlan(KEY).status,
        allowance: memory.autoResumeAllowance(KEY),
        inventory: { ...game.inventory },
        furnace: JSON.parse(JSON.stringify(game.furnace)),
      }
      return executorPlan([collect(3)])
    })
  await fireResumeTimer(ctx)

  assert.deepEqual(model.labels.slice(7), ['h:checkpoint-only', 'h:blocked-claim', 'h:blocked-claim'])
  assert.deepEqual(duringH, [{ status: 'active', board: 'active', runPaused: false, pauseClass: '' }], 'the plan and board were active when the restaged executor answered')
  assert.equal(rowsOf(ctx, 'recovery.harness_state_fault').length, 0)
  const failedMessages = rowsOf(ctx, 'request.failed').map(row => row.message ?? '').concat(rowsOf(ctx, 'goal.paused').map(row => row.pause_reason ?? ''))
  assert.equal(failedMessages.some(message => /checkpoint_requires_active_step/.test(message)), false, 'the checkpoint-only answer was not refused as a harness-state fault')
  assert.equal(game.sent.length, ctx.worldBeforeRefusal.sent, 'run H admitted nothing')
  const pausedH = memory.pauseRecord(KEY)
  assert.deepEqual([pausedH.paused, pausedH.pause_class], [true, 'model_recoverable'])
  assert.match(pausedH.pause_reason, /unverified_blocker_recovery_exhausted/)
  assert.deepEqual(rowsOf(ctx, 'recovery.auto_resume_scheduled').map(row => [row.attempt, row.goal_attempt]), [[1, 1], [2, 2]])
  assert.equal(rowsOf(ctx, 'recovery.auto_resume_exhausted').length, 0)
  assert.deepEqual([memory.autoResumeAllowance(KEY).step_attempts, memory.autoResumeAllowance(KEY).goal_attempts], [1, 1], 'one attempt counted per fire')

  // --- run I: the same world, with the furnace output in the packet; the executor collects it -------------------------------------------
  await fireResumeTimer(ctx)
  assert.equal(model.labels.at(-1), 'i:collect-machine-output')
  const residual = ctx.atI.packet.find(line => line.startsWith('residual_needs'))
  assert.match(residual, /copper-plate required=10 held=9 in_machine_output=3@stone-furnace unit=26 missing_after_machine=0/)
  assert.doesNotMatch(residual, /copper-ore required=/, 'no copper ore is demanded: the furnace output covers the shortfall')
  assert.equal(ctx.atI.packet.some(line => line.startsWith('raw_leaf_acquisition')), false, 'no copper-ore acquisition row')
  assert.match(ctx.atI.packet.find(line => line.startsWith('placed_machines')), /stone-furnace unit=26 \[FRESH as_of=tick:\d+,epoch:3\] working=false machine_fuel=\{coal:4\} machine_source=empty machine_output=\{copper-plate:3\}/)
  assert.match(ctx.atI.packet.find(line => line.startsWith('held_counts')), /copper-plate=9/)
  // The world the packet describes came from admitted operations and smelting time: 12 ore -> 12 plates, 9 collected, 3 in the furnace.
  assert.deepEqual(ctx.atI.inventory, { coal: 5, 'iron-ore': 20, 'copper-plate': 9 })
  assert.deepEqual(ctx.atI.furnace.output, { 'copper-plate': 3 })
  assert.deepEqual(game.effects.map(effect => [effect.operation, effect.item, effect.moved]), [['supply_entity', 'coal', 5], ['supply_entity', 'copper-ore', 12], ['move_items_exact', 'copper-plate', 9]])
  // No silent replan: the goal and the one plan are the ones the run started with.
  assert.deepEqual(ctx.atI.plans, [[identity.plan_id, identity.plan_version]])
  assert.equal(ctx.atI.goalId, identity.goal_id)
  assert.equal(ctx.atI.status, 'active')
  // Two automatic attempts, inside the 2 per step and 6 per goal limits, each counted once.
  assert.deepEqual([ctx.atI.allowance.step_attempts, ctx.atI.allowance.goal_attempts], [2, 2])
  assert.ok(ctx.atI.allowance.step_attempts <= MODEL_RECOVERABLE_RESUME_LIMITS.per_step && ctx.atI.allowance.goal_attempts <= MODEL_RECOVERABLE_RESUME_LIMITS.per_goal)

  // The executor's collection reached the game as a real, attributed, admitted batch: request id of the recovery, this actor and epoch.
  const started = rowsOf(ctx, 'recovery.auto_resume_started')
  assert.equal(started.length, 2)
  assert.equal(new Set(started.map(row => row.request_id)).size, 2)
  assert.deepEqual(started.map(row => [row.attempt, row.step_attempt, row.goal_attempt]), [[1, 1, 1], [2, 2, 2]])
  assert.deepEqual(game.sent.map(batch => batch.operations.map(operation => operation.name)), [['supply_entity'], ['move_items_exact'], ['move_items_exact']])
  assert.deepEqual(game.sent.at(-1).operations, [collect(3)])
  const lastAdmission = game.admissions.at(-1)
  assert.deepEqual([lastAdmission.actor_id, lastAdmission.epoch], [18, 3])
  assert.ok(lastAdmission.operation_key.startsWith(`${started[1].request_id}/`), 'the batch belongs to the second automatic resume')
  assert.ok(game.admissions.every(admission => admission.actor_id === 18 && admission.epoch === 3 && admission.generation === 1))

  await completeAndReport(ctx)

  // --- verified completion: the world predicate, then the harness's own state ----------------------------------------------------------
  assert.equal(game.inventory['copper-plate'], 12)
  assert.ok(game.inventory['copper-plate'] >= 10)
  assert.deepEqual(game.furnace.output, {})
  assert.equal(game.worldTotals()['copper-plate'], 12, 'twelve ore became twelve plates; nothing was created')
  assert.equal(game.worldTotals()['copper-ore'] ?? 0, 0)
  const verifiedAt = indexOfRow(ctx, row => row.event === 'step.verified')
  assert.ok(verifiedAt > indexOfRow(ctx, row => row.event === 'recovery.auto_resume_started' && row.data.attempt === 2), 'the step closed after the second resume')
  const [verified] = rowsOf(ctx, 'step.verified')
  assert.equal(verified.source, 'deterministic_completion_contract')
  assert.equal(verified.task_board.status, 'completed')
  const evaluated = rowsOf(ctx, 'goal.evaluated').at(-1)
  assert.equal(evaluated.satisfied, true)
  assert.deepEqual(evaluated.results.map(result => [result.kind, result.satisfied, result.current]), [['inventory_count', true, 12]])
  const completion = rowsOf(ctx, 'outcome.validated').find(row => row.kind === 'verified_complete')
  assert.equal(completion.reason_code, 'verified_final_step')
  assert.equal(memory.currentPlan(KEY), undefined, 'the finished plan was finalized and cleared')
  assert.equal(memory.planningState(KEY).goal, null)
  assert.match(chat.at(-1), /The requested goal is verified complete/)

  // --- the trace tells the same story ------------------------------------------------------------------------------------------------
  const restages = world.trace.filter(isC7Restage)
  assert.equal(restages.length, 2)
  for (const row of started) {
    const resumedAt = indexOfRow(ctx, entry => entry.event === 'recovery.auto_resume_plan_resumed' && entry.data.request_id === row.request_id)
    const restagedAt = indexOfRow(ctx, entry => isC7Restage(entry) && entry.data.reason.startsWith('recovery:auto_resume_after_model_recoverable_pause'), resumedAt)
    assert.ok(resumedAt > -1 && restagedAt > resumedAt, `the plan was active again before the executor was restaged (${row.request_id})`)
    const scheduledAt = indexOfRow(ctx, entry => entry.event === 'recovery.auto_resume_scheduled' && entry.data.attempt === row.attempt)
    assert.ok(scheduledAt > -1 && scheduledAt < resumedAt)
  }
  for (const name of ['recovery.auto_resume_scheduled', 'recovery.auto_resume_started', 'recovery.auto_resume_plan_resumed']) {
    for (const row of rowsOf(ctx, name)) {
      assert.equal(row.goal_id, identity.goal_id, name)
      if (row.plan_id) assert.deepEqual([row.plan_id, row.plan_version], [identity.plan_id, identity.plan_version], name)
    }
  }
  const signatures = analyzeBehaviorTrace(world.trace).findings.map(finding => finding.signature)
  for (const forbidden of ['harness_state_fault', 'silent_blocked_stall', 'model_recoverable_pause_not_resumed', 'auto_resume_exhausted']) {
    assert.equal(signatures.includes(forbidden), false, `run-check flagged ${forbidden}: ${signatures.join(', ')}`)
  }
  assertStrictBoundary(ctx)
})

// --- helpers shared by the scenarios below --------------------------------------------------------------------------------------------

// Runs H: the resumed executor makes a checkpoint-only answer and an unverified BLOCKED claim, and the plan pauses again.
async function runH(ctx) {
  ctx.model
    .push('executor', 'h:checkpoint-only', () => executorPlan([], { checkpoint: PLATES }))
    .push('executor', 'h:blocked-claim', BLOCKED_REPLY(), 2)
  await fireResumeTimer(ctx)
  assert.equal(ctx.world.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
}

// What survives a restart: the durable allowance, the pause, the plan identity and the receipts of the verified prefix.
function durableFacts(ctx) {
  const { memory } = ctx.world
  const planning = memory.planningState(KEY)
  const pause = memory.pauseRecord(KEY)
  return {
    allowance: memory.autoResumeAllowance(KEY),
    pause: { paused: pause.paused, pause_class: pause.pause_class, pause_reason: pause.pause_reason, goal_id: pause.goal_id },
    plans: planning.plans.map(plan => [plan.plan_id, plan.plan_version]),
    goalId: planning.goal.goal_id,
    receipts: (memory.currentPlan(KEY).task_board.evidence ?? []).filter(item => item.kind === 'operation_receipt').map(item => item.ref),
  }
}

// The process dies: its timers and every in-memory object go with it. A new process builds new instances from the state file.
function restartProcess(ctx, model) {
  ctx.session.stopping = true
  ctx.t.mock.timers.reset()
  ctx.t.mock.timers.enable({ apis: ['setTimeout'] })
  const world = recoveryWorld({ game: ctx.game, model, stateFile: ctx.stateFile })
  const { session, chat, logs } = recoverySession(world)
  return { ...ctx, model, world, session, chat, logs }
}

const tempStateFile = async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-recovery-loop-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}))
  return path.join(dir, 'npc-state.json')
}

test('R-restart: a restart after the second pause keeps the attempt count and the verified prefix, replays nothing, and finishes on the next timer', async (t) => {
  const stateFile = await tempStateFile(t)
  const ctx = await reachRunG(t, { stateFile })
  await runH(ctx)
  const before = durableFacts(ctx)
  const sentBefore = ctx.game.sent.map(batch => batch.operations)
  assert.deepEqual([before.allowance.step_attempts, before.allowance.goal_attempts], [1, 1])
  assert.deepEqual(before.receipts, ['batch-g1-1', 'batch-g1-2'])
  assert.ok(ctx.session.modelResume.timer, 'attempt 2 was waiting on its timer when the process died')

  const model = new ScriptedModel()
  const restarted = restartProcess(ctx, model)
  model.push('executor', 'i:observe', (messages) => {
      ctx.atI = { packet: stepBlockLines(messages), allowance: restarted.world.memory.autoResumeAllowance(KEY) }
      return observation()
    })
    .push('executor', 'i:collect-machine-output', () => executorPlan([collect(3)]))
  // The first process wrote nothing more after it died: the second reads the file the first left.
  await restarted.world.agent.loadPersistentState()
  assert.deepEqual(durableFacts(restarted), before, 'the allowance, the pause, the plan identity and the verified prefix came back from disk')
  assert.equal(restarted.session.modelResume, null, 'the in-memory timer died with the process')

  // The startup branch: a persisted model_recoverable pause is handed to the same decision the goal.paused activity uses.
  assert.equal(restarted.session.queueStartupRecovery(restarted.session.currentPlanState()), 'consider_pause')
  await settle(restarted.session)
  const [scheduled, ...more] = restarted.world.named('recovery.auto_resume_scheduled')
  assert.equal(more.length, 0)
  assert.deepEqual([scheduled.attempt, scheduled.goal_attempt], [2, 2], 'attempt 2 of 2, not a fresh attempt 1')
  assert.equal(restarted.world.named('recovery.auto_resume_started').length, 0)
  assert.equal(model.calls.length, 0, 'a restart alone wakes no model')

  await fireResumeTimer(restarted)
  assert.equal(model.calls.length, 2)
  assert.deepEqual([ctx.atI.allowance.step_attempts, ctx.atI.allowance.goal_attempts], [2, 2], 'the persisted count continued: one more attempt, counted once')
  const [started] = restarted.world.named('recovery.auto_resume_started')
  assert.deepEqual([started.attempt, started.step_attempt, started.goal_attempt], [2, 2, 2])
  const resumedAt = restarted.world.trace.findIndex(row => row.event === 'recovery.auto_resume_plan_resumed')
  const restagedAt = restarted.world.trace.findIndex(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7')
  assert.ok(resumedAt > -1 && restagedAt > resumedAt, 'the plan was active again before the executor was restaged')

  // Nothing is replayed: the batches the first process sent are not sent again; the restarted run adds exactly the collection.
  assert.deepEqual(ctx.game.sent.slice(0, sentBefore.length).map(batch => batch.operations), sentBefore)
  assert.deepEqual(ctx.game.sent.slice(sentBefore.length).map(batch => batch.operations), [[collect(3)]])
  assert.equal(ctx.game.admissions.at(-1).operation_key.startsWith(`${started.request_id}/`), true)

  await completeAndReport(restarted)
  assert.equal(ctx.game.inventory['copper-plate'], 12)
  assert.equal(restarted.world.named('step.verified')[0].source, 'deterministic_completion_contract')
  assert.equal(restarted.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(restarted.world.named('outcome.validated').find(row => row.kind === 'verified_complete').reason_code, 'verified_final_step')
  assert.equal(restarted.world.memory.currentPlan(KEY), undefined)
  assert.match(restarted.chat.at(-1), /The requested goal is verified complete/)
  const signatures = analyzeBehaviorTrace(restarted.world.trace).findings.map(finding => finding.signature)
  for (const forbidden of ['harness_state_fault', 'silent_blocked_stall', 'model_recoverable_pause_not_resumed']) assert.equal(signatures.includes(forbidden), false, forbidden)
  assertStrictBoundary(restarted)
  assert.deepEqual(ctx.model.remaining, [])
  assert.deepEqual(ctx.model.violations, [])
})

// --- cancellation: a pending resume yields to whoever took over ------------------------------------------------------------------------------

const deferred = () => {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

const executorCalls = ctx => ctx.model.calls.filter(call => call.role === 'executor').length
const c7Count = ctx => ctx.world.trace.filter(isC7Restage).length

function cancellationSnapshot(ctx) {
  return {
    sent: ctx.game.sent.length,
    effects: ctx.game.effects.length,
    totals: ctx.game.worldTotals(),
    executorCalls: executorCalls(ctx),
    c7: c7Count(ctx),
    allowance: ctx.world.memory.autoResumeAllowance(KEY),
  }
}

// The timer is the only thing that can start a resume. After the takeover it must do nothing: no attempt counted, no plan reactivated,
// no executor restaged or asked, nothing sent to the game.
function assertNothingResumed(ctx, before) {
  assert.equal(ctx.world.named('recovery.auto_resume_started').length, 0)
  assert.equal(ctx.world.named('recovery.auto_resume_plan_resumed').length, 0)
  assert.equal(c7Count(ctx), before.c7, 'no executor was restaged')
  assert.equal(executorCalls(ctx), before.executorCalls, 'no executor call was made')
  assert.equal(ctx.game.sent.length, before.sent, 'nothing was admitted')
  assert.equal(ctx.game.effects.length, before.effects)
  assert.deepEqual(ctx.game.worldTotals(), before.totals, 'the world did not change')
  assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, before.allowance.goal_attempts, 'no attempt was counted')
  assert.equal(ctx.session.modelResume, null)
}

const takeovers = [
  {
    name: 'a player stop',
    act: ctx => ctx.session.queuePlayerRequest('TTLouis', 'stop'),
    reason: 'player_request',
    check(ctx) {
      assert.deepEqual([ctx.world.memory.pauseRecord(KEY).pause_class, ctx.world.memory.pauseRecord(KEY).pause_reason], ['operator', 'user_stop'])
      assert.equal(ctx.game.cancels.length, 1, 'the stop cancelled queued game work')
    },
  },
  {
    name: 'a UI pause',
    act: ctx => ctx.session.queueUiControl({ action: 'pause', player_index: 1, player_name: 'TTLouis' }),
    reason: 'ui_pause',
    check(ctx) {
      assert.deepEqual([ctx.world.memory.pauseRecord(KEY).pause_class, ctx.world.memory.pauseRecord(KEY).pause_reason], ['operator', 'ui_pause'])
    },
  },
]
for (const takeover of takeovers) {
  test(`R-cancel: ${takeover.name} while a resume timer is pending cancels it, and the timer does nothing`, async (t) => {
    const ctx = await reachRunG(t)
    assert.ok(ctx.session.modelResume.timer)
    const before = cancellationSnapshot(ctx)
    assert.equal(takeover.act(ctx), true)
    await settle(ctx.session)
    // The pending timer is cleared synchronously by the takeover; letting mock time pass proves nothing is left to fire.
    ctx.t.mock.timers.tick(60_000)
    await settle(ctx.session)
    const [cancelled, ...extra] = ctx.world.named('recovery.auto_resume_cancelled')
    assert.equal(extra.length, 0)
    assert.equal(cancelled.reason, takeover.reason)
    assert.equal(cancelled.attempt, 1)
    assertNothingResumed(ctx, before)
    takeover.check(ctx)
    assert.equal(ctx.world.memory.currentPlan(KEY).status, 'paused', 'the operator pause stands')
    assert.equal(ctx.world.named('recovery.auto_resume_scheduled').length, 1, 'nothing was scheduled behind the takeover')
    assertStrictBoundary(ctx)
  })
}

test('R-cancel: a new player goal while a resume timer is pending cancels it; the new goal stands and the old plan is not resumed', async (t) => {
  const ctx = await reachRunG(t)
  const old = ctx.world.memory.autoResumeAllowance(KEY)
  const before = cancellationSnapshot(ctx)
  const stones = inventoryCheckpoint('stone', 10)
  ctx.model.push('planner', 'planner:new-goal', planReply({
    plan: ['Gather 10 stone'],
    currentStep: 0,
    operations: [gather('stone', 10)],
    checkpoint: stones,
    goal: { scope: 'finite', summary: 'Have 10 stone.', doneWhen: [{ kind: 'inventory_count', item_name: 'stone', minimum: 10 }] },
    stepCompletions: [{ kind: 'deterministic', checkpoint: stones }],
  }))
  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'forget that and gather ten stone'), true)
  await settle(ctx.session)
  ctx.t.mock.timers.tick(60_000)
  await settle(ctx.session)

  assert.equal(ctx.world.named('recovery.auto_resume_cancelled').at(0).reason, 'player_request')
  assert.equal(ctx.world.named('recovery.auto_resume_started').length, 0)
  assert.equal(ctx.world.named('recovery.auto_resume_plan_resumed').length, 0)
  assert.equal(c7Count(ctx), before.c7)
  assert.equal(executorCalls(ctx), before.executorCalls, 'the old plan executor was never restaged')
  const planning = ctx.world.memory.planningState(KEY)
  assert.notEqual(planning.goal.goal_id, old.goal_id, 'the new goal stands')
  assert.equal(planning.goal.objective, 'forget that and gather ten stone')
  assert.equal(ctx.world.memory.pauseRecord(KEY).paused, false)
  assert.equal(ctx.session.modelResume, null)
  // The only new batch is the new goal's own gather, under the new goal's request and not a recovery request.
  assert.equal(ctx.game.sent.length, before.sent + 1)
  assert.deepEqual(ctx.game.sent.at(-1).operations.map(operation => operation.name), ['gather_resource'])
  assert.equal(ctx.game.admissions.at(-1).operation_key.startsWith('recovery_'), false)
  assert.equal(ctx.game.effects.length, before.effects, 'nothing in the world moved yet')
  assert.deepEqual(ctx.game.worldTotals(), before.totals)
  assert.equal(ctx.world.named('recovery.auto_resume_scheduled').length, 1)
  assertStrictBoundary(ctx)
})

for (const [name, change] of [
  ['an actor change', { actor_id: 19 }],
  ['an epoch change', { epoch: 4 }],
]) {
  test(`R-cancel: ${name} before the timer fires cancels the resume at fire time: no executor, no activation, no mutation`, async (t) => {
    const ctx = await reachRunG(t)
    const before = cancellationSnapshot(ctx)
    ctx.game.status = deployment({ ...ctx.game.status, ...change })
    await fireResumeTimer(ctx)
    const [cancelled, ...extra] = ctx.world.named('recovery.auto_resume_cancelled')
    assert.equal(extra.length, 0)
    assert.equal(cancelled.reason, change.actor_id ? 'actor_changed' : 'epoch_changed')
    assert.deepEqual([cancelled.actor_id, cancelled.actor_epoch], [18, 3], 'the trace names what the resume was scheduled under')
    assertNothingResumed(ctx, before)
    const pause = ctx.world.memory.pauseRecord(KEY)
    assert.deepEqual([pause.paused, pause.pause_class], [true, 'model_recoverable'], 'the pause is untouched; a person or the lifecycle recovery owns it now')
    assert.equal(ctx.world.named('recovery.auto_resume_scheduled').length, 1)
    assertStrictBoundary(ctx)
  })
}

test('R-cancel: a stop that lands while the fired resume waits on the executor model reaches the game with nothing, and the stop stands', async (t) => {
  const ctx = await reachRunG(t)
  const before = cancellationSnapshot(ctx)
  const gate = deferred()
  let reached = false
  ctx.model.push('executor', 'executor:gated', async () => {
    reached = true
    await gate.promise
    return executorPlan([collect(3)])
  })
  ctx.t.mock.timers.tick(15_000)
  for (let spin = 0; spin < 400; spin++) {
    if (reached) break
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(reached, true, 'the restaged executor is waiting on the model')
  assert.equal(ctx.world.named('recovery.auto_resume_plan_resumed').length, 1)
  assert.equal(ctx.world.memory.currentPlan(KEY).status, 'active')
  assert.equal(ctx.session.modelResume.token.cancelled, false)

  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'stop'), true)
  gate.open()
  await settle(ctx.session)

  assert.equal(ctx.game.sent.length, before.sent, 'the answer that arrived after the stop never reached the game')
  assert.equal(ctx.game.pendingBatch, null)
  assert.deepEqual(ctx.game.worldTotals(), before.totals)
  assert.equal(ctx.world.memory.currentPlan(KEY).status, 'paused')
  assert.deepEqual([ctx.world.memory.pauseRecord(KEY).pause_class, ctx.world.memory.pauseRecord(KEY).pause_reason], ['operator', 'user_stop'])
  assert.equal(ctx.session.modelResume, null, 'no new automatic resume was scheduled behind the stop')
  assert.equal(ctx.world.named('recovery.auto_resume_scheduled').length, 1)
  assertStrictBoundary(ctx)
})

// --- no replay: a lost acknowledgement never makes the harness send the same effect twice --------------------------------------------

// Runs I with the collection batch's acknowledgement lost on the way back: the game admitted the batch, the harness never heard.
async function runIWithLostAcknowledgement(ctx) {
  ctx.model.push('executor', 'i:collect-machine-output', executorPlan([collect(3)]))
  ctx.game.dropAckOnce = true
  await fireResumeTimer(ctx)
  const [reconciled, ...extra] = ctx.world.named('operation.reconciled')
  assert.equal(extra.length, 0)
  assert.deepEqual([reconciled.trigger, reconciled.verdict, reconciled.effect], ['lost_acknowledgement', 'admitted_in_flight', 'in_flight'])
  assert.equal(ctx.game.sent.length, 3, 'the collection reached the game once')
  assert.equal(ctx.game.pendingBatch.batch_id, 3)
  assert.equal(ctx.world.memory.currentPlan(KEY).status, 'active', 'a lost acknowledgement the game admitted is not a failure')
  assert.equal(ctx.model.calls.at(-1).label, 'i:collect-machine-output')
  assert.equal(ctx.world.memory.pendingOperation(KEY).operation_key.startsWith('recovery_'), true)
}

const collections = ctx => ctx.game.sent.filter(batch => batch.operations.some(operation => operation.name === 'move_items_exact' && operation.args.max_count === 3)).length

test('R-noreplay: a lost acknowledgement whose effect is unknown after a restart stays held: no conflicting dispatch, a visible guard pause', async (t) => {
  const stateFile = await tempStateFile(t)
  const ctx = await reachRunG(t, { stateFile })
  await runH(ctx)
  await runIWithLostAcknowledgement(ctx)

  // The game reloads while the batch is still queued: the queue and its records are gone and nothing proves whether it ran.
  ctx.game.reloadMod()
  assert.equal(ctx.game.inventory['copper-plate'], 9)
  const model = new ScriptedModel()
    .push('executor', 'restart:observe', (messages) => {
      ctx.atRestart = { text: messages.map(message => String(message.content)).join('\n') }
      return observation()
    })
    .push('executor', 'restart:replay-identical-collection', executorPlan([collect(3)]))
    .push('executor', 'restart:replay-changed-collection', executorPlan([collect(2)]))
  const restarted = restartProcess(ctx, model)
  await restarted.world.agent.loadPersistentState()
  assert.equal(restarted.session.queueStartupRecovery(restarted.session.currentPlanState()), 'recover')
  await settle(restarted.session)

  const [reconciled] = restarted.world.named('operation.reconciled')
  assert.deepEqual([reconciled.trigger, reconciled.verdict, reconciled.effect], ['runtime_restart', 'generation_changed', 'partial_unknown'])
  assert.match(ctx.atRestart.text, /UNKNOWN, not as done and not as absent/)
  const suppressed = restarted.world.named('operation.duplicate_suppressed')
  assert.ok(suppressed.length >= 1)
  assert.equal(suppressed[0].reason, 'unresolved_operation_scope_conflict')
  assert.equal(suppressed[0].effect, 'partial_unknown')
  // No conflicting dispatch: neither the identical nor the changed collection reached the game, and the world did not move.
  assert.equal(ctx.game.sent.length, 3)
  assert.equal(collections(ctx), 1)
  assert.equal(ctx.game.pendingBatch, null)
  assert.equal(ctx.game.inventory['copper-plate'], 9)
  assert.equal(ctx.game.worldTotals()['copper-plate'], 12)
  // The end is a visible guard pause that no timer resumes.
  const pause = restarted.world.memory.pauseRecord(KEY)
  assert.deepEqual([pause.paused, pause.pause_class, pause.pause_reason], [true, 'guard', 'blocked_duplicate_effect_suppressed'])
  assert.equal(restarted.session.modelResume, null)
  assert.equal(restarted.world.named('recovery.auto_resume_scheduled').length, 0)
  assert.equal(restarted.world.named('goal.paused').filter(row => row.pause_reason === 'blocked_duplicate_effect_suppressed').length, 1)
  assertStrictBoundary(restarted)
  assert.deepEqual(ctx.model.remaining, [])
})

// Recovery must rebuild its machine facts before the executor answers, even though entity observations died with the process.
test('R-restart: the first packet rediscovers fresh furnace output and completes without demanding more ore', async (t) => {
  const stateFile = await tempStateFile(t)
  const ctx = await reachRunG(t, { stateFile })
  await runH(ctx)
  const model = new ScriptedModel().push('executor', 'i:collect', (messages) => {
    ctx.atI = { packet: stepBlockLines(messages) }
    return executorPlan([collect(3)])
  })
  const restarted = restartProcess(ctx, model)
  await restarted.world.agent.loadPersistentState()
  restarted.session.queueStartupRecovery(restarted.session.currentPlanState())
  await settle(restarted.session)
  await fireResumeTimer(restarted)
  const residual = ctx.atI.packet.find(line => line.startsWith('residual_needs'))
  assert.match(residual, /in_machine_output=3@stone-furnace unit=26 missing_after_machine=0/)
  assert.equal(ctx.atI.packet.some(line => line.startsWith('raw_leaf_acquisition')), false)
  const [discovered] = restarted.world.named('context.recovery_machines_discovered')
  assert.deepEqual([discovered.reason, discovered.machine_count, discovered.actor_id, discovered.actor_epoch], ['fresh_local_scan', 1, 18, 3])
  assert.ok(discovered.request_id)
  await completeAndReport(restarted)
  assert.equal(ctx.game.inventory['copper-plate'], 12)
  assert.equal(restarted.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(restarted.world.memory.currentPlan(KEY), undefined)
  assertStrictBoundary(restarted)
})

test('R-noreplay: a completed collection with a lost acknowledgement is settled after restart and never dispatched twice', async (t) => {
  const stateFile = await tempStateFile(t)
  const ctx = await reachRunG(t, { stateFile })
  await runH(ctx)
  await runIWithLostAcknowledgement(ctx)
  ctx.game.completeBatch() // effect happened, but no completion line reached the first process
  ctx.game.reloadMod()
  const model = new ScriptedModel() // Exact receipts plus a fresh checkpoint need no model replay proposal.
  const restarted = restartProcess(ctx, model)
  await restarted.world.agent.loadPersistentState()
  assert.equal(restarted.session.queueStartupRecovery(restarted.session.currentPlanState()), 'recover')
  await settle(restarted.session)
  const [reconciled] = restarted.world.named('operation.reconciled')
  assert.deepEqual([reconciled.trigger, reconciled.verdict, reconciled.effect], ['runtime_restart', 'admitted_completed', 'happened'])
  assert.equal(restarted.world.named('operation.recovery_settled').at(-1).reason, 'restart_exact_completed_receipt')
  assert.equal(collections(ctx), 1)
  assert.equal(ctx.game.sent.length, 3)
  assert.equal(ctx.game.inventory['copper-plate'], 12)
  assert.equal(restarted.world.named('goal.evaluated').at(-1)?.satisfied, true)
  assert.equal(restarted.world.memory.currentPlan(KEY), undefined)
  assert.equal(model.calls.length, 0)
  assertStrictBoundary(restarted)
})

// The rediscovery read is advisory. A denied read or changed actor can never supply fresh machine stock.
for (const scenario of ['failed_read', 'actor_changed', 'batch_in_flight']) {
  test(`R-discovery: ${scenario} never credits output from an unsafe local scan`, async (t) => {
    const ctx = await reachRunG(t)
    const { agent, memory } = ctx.world
    agent.liveEntityObservations.clear()
    agent.planUpdateReason = 'recovery'
    let scans = 0
    const command = ctx.game.command.bind(ctx.game)
    ctx.game.command = async text => {
      if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
        scans += 1
        if (scenario === 'failed_read') return JSON.stringify({ ok: false, entities: ctx.game.nearbySnapshot().entities })
        if (scenario === 'actor_changed') ctx.game.status.epoch += 1
      }
      return command(text)
    }
    const runtime = scenario === 'batch_in_flight' ? { idle: false, queue_length: 1 } : { idle: true, queue_length: 0 }
    const result = await agent.gatherExecutorHandoffFacts({ state: memory.planningState(KEY), actor: agent.epoch, runtime, checkpoint: 'C7', requestId: 'discovery_boundary' })
    assert.equal(agent.liveEntityObservations.size, 0, 'no unsafe observation was bound')
    if (scenario === 'actor_changed') {
      assert.equal(result.refusal, 'actor_changed_during_handoff_refresh')
      assert.equal(scans, 1)
    }
    else if (scenario === 'batch_in_flight') {
      assert.equal(scans, 0, 'no discovery while native work is running')
      assert.equal(result.facts.placed_machines.length, 0)
      assert.equal(result.facts.residual, undefined)
    }
    else {
      assert.equal(scans, 1)
      assert.equal(result.facts.placed_machines.length, 0)
      assert.equal(ctx.world.named('context.recovery_machines_discovered').at(-1).reason, 'local_scan_unavailable')
      assert.equal(result.facts.residual.rows.find(row => row.item === 'copper-plate').missing, 1)
    }
    assertStrictBoundary(ctx)
  })
}


test('recovery fixture parser keeps known arguments and treats unknown operation names as raw data', () => {
  assert.deepEqual(parseAdmittedOperations("remote.call('autorio_operations','gather_resource','iron-ore',2,32)"), [
    { name: 'gather_resource', args: { resource_name: 'iron-ore', count: 2 } },
  ])
  for (const name of ['constructor', '__proto__', 'unknown']) {
    assert.deepEqual(parseAdmittedOperations(`remote.call('autorio_operations','${name}',1)`), [{ name, args: { raw: '1)' } }])
  }
  assert.deepEqual(parseAdmittedOperations("remote.call('autorio_operations','toString',1)"), [], 'only lowercase operation names are part of the fixture grammar')
})
