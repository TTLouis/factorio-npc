import assert from 'node:assert/strict'
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
  PLATES,
  reachRunG,
  stepBlockLines,
} from './recovery-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'

// Unit 17 (composed recovery-loop regressions). Every earlier recovery test stopped early (a checkpoint accepted, a batch admitted),
// called Session.runModelRecoverableResume directly, and set the inventory to the expected answer. These drive the live failure chain
// (run G -> H -> I, 2026-10-14) through the production scheduling path to a verified completion: a player request, the mod's
// completion line, goal.paused -> considerPauseForAutoResume, the mocked 15 s timer, the fired resume, the restage, the executor's
// batch, the game's receipt and the harness's own verification. The fake game changes only through admitted operations (see
// recovery-loop-fixtures.mjs); the scripted model throws on any call a scenario did not script; zero humans are connected.

const rowsOf = (ctx, name) => ctx.world.named(name)
const indexOfRow = (ctx, predicate, from = 0) => ctx.world.trace.findIndex((row, index) => index >= from && predicate(row))
const isC7Restage = row => row.event === 'context.restaged' && row.data.checkpoint === 'C7'

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
