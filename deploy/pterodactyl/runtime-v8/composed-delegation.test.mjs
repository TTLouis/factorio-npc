import assert from 'node:assert/strict'
import test from 'node:test'

import { DRILL_OUTPUT, DRILL_SET, DRILL_UNIT, DrillFurnaceFactorio, FURNACE_SET, GROUND_ORE } from './composed-delegation-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import {
  assertStrictBoundary, completeAndReport, det, fireResumeTimer, FURNACE_UNIT, KEY, recoverySession, recoveryWorld, reportCompletion, ScriptedModel, settle,
} from './recovery-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Composed delegation scenario (live Runs Z through AF, 2026-10-18/19).
//
// Each of those runs died at a different delegation seam, and each fix was proven only by a focused test. This is one scripted run
// that crosses every seam through the production entry points, so a regression at any of them shows up in one place. The real
// NpcAgentLoop (completion protocol 3: the planner authors no operations), the real Session (player request, the mod's completion
// line, goal.paused -> considerPauseForAutoResume, the mocked 15 s timer -> runModelRecoverableResume), the real event queue and
// the real behavior trace. Only the model (ScriptedModel throws on any call that is not scripted) and the game
// (DrillFurnaceFactorio: its world changes only through admitted operations and advance()) are fakes. Zero humans are connected.
//
// One finite goal, "have 20 copper plates from a burner drill feeding a furnace", two steps:
//   1  planner draft         Protocol 3. The planner drafts both steps, their checkpoints and execution guidance (direct feed) and
//                            no operations (plan.delegation_committed: validated_plan_without_initial_batch). The executor is
//                            restaged fresh at commit (C3).
//   2  placement             Run Z batch 21 / Run AA: the executor reads placement candidates (drill over the copper patch with its
//                            item_output_position; a furnace whose footprint covers that drop point) and places both in ONE batch
//                            of two placing tasks, through the held-item preflight, the batch stock ledger and admission.
//                            Run AE: spilled ore lies on the furnace footprint; the candidate lists it as ground_items and the
//                            build picks it up. Run AF: the receipt carries ground_items_picked_up, the actor inventory gains
//                            the ore, and the next executor turn is shown that receipt.
//   3  step close            The step closes on its entity_count checkpoint (a live count, never the receipt). The executor context
//                            is past its hard limit, so the close hands the next step to a FRESH executor (C8, the size safety
//                            net), and the step-2 contract is bound just in time. Run AE: the fresh topology record names the
//                            drill's unit and drop target.
//   4  planner review        Run AB/AC/AF: the executor asks for plannerReview. The planner review round really runs
//                            (planner.review_round once; a planner-role provider call carrying [EXECUTOR_REVIEW]); its reply is
//                            a contract draft, never an action; the unchanged step goes back to an executor with the notes.
//   5  second review, resume Runs AD-AF: the executor asks for review of the same step again. There is no second planner round: the
//                            goal takes a model_recoverable pause, the supervisor schedules the bounded auto-resume (X-1), the
//                            timer fires, a C7 restage hands the step to a fresh executor, which acts (fuel, wait, collect); the
//                            goal completes and is verified by the harness (goal.evaluated satisfied).
// Gates at the end: no dangling context reference (f36e837c), no silent stall, no unresumed model_recoverable pause, one review
// round, a strict boundary. The C7 packet must carry the step contract, held counts and placed machines (U4), and the planner's review
// notes (X-1b, a90c3d52). A protocol 3 packet and its topology block share 6,000 characters and the packet limit follows the block's real
// size; this run's C7 packet was ~3,850 characters under a fixed 4,050 window, so the assertions failed first when a plan or receipt grew.
//
// A second test runs the same scenario with the first placement batch refused after its first task (Run Z batch 21 / Run AA): the
// drill is built, the furnace is refused with the mod's native no-mutation proof, the settled prefix is stated as a fact, and the
// corrected batch places the furnace alone over the spilled ore (Run AF).
//
// One finding is expected: run-check's restage_loop, for step 2's C8 + C3 + C7 restages with no progress between them. That is
// the price of one review round plus one resume, and the detector reports it as a cost signal; the gates pin its exact shape.

// The executor soft limit that stands in for a live-sized context: the executor conversation after step 1 is ~7,100 tokens, past the
// hard limit (2 x 3,000), so the verified step close restages the next step (restage-policy C8). With the default limit a
// conversation this small simply continues into the next step.
const EXECUTOR_SOFT_LIMIT_TOKENS = 3000

const toolCall = (id, name, args) => ({ content: '', tool_calls: [{ id, index: 0, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

const S1 = 'Place the burner mining drill on the copper ore patch so its drop point lands on a stone furnace placed over it, then confirm both machines are standing and the drill faces the furnace'
const S2 = 'Fuel the burner mining drill and the stone furnace with coal, wait until the drill has filled the furnace, then collect twenty copper plates from the furnace output into the inventory'
const entityCount = prototype => ({ id: `${prototype}_placed`, kind: 'entity_count', prototype, minimum: 1 })
const CP1 = { mode: 'all', requirements: [entityCount('burner-mining-drill'), entityCount('stone-furnace')] }
const CP2 = inventoryCheckpoint('copper-plate', 20)
const GOAL = { scope: 'finite', summary: 'Have twenty copper plates from a burner mining drill feeding a stone furnace.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 20 }] }
const brief = (approach, rationale, constraints) => ({ approach, rationale, constraints, skillIds: [], materialSupply: { mode: 'direct_feed', resource: 'copper-ore' } })
// Live planner guidance fills its bounds (role-contracts.mjs: approach 200, rationale 240, three constraints of 100 characters).
const GUIDANCE = [
  brief('Read burner drill candidates over the copper patch, then furnace candidates covering the drill item_output_position, and place both with place_candidate in one batch.',
    'The drill output drops straight into the furnace, so no ore passes through the inventory; ore already on the drop tile is picked up by the furnace placement, the way a player build does.',
    ['Keep the drill item_output_position inside the furnace footprint.', 'Use place_candidate with the returned candidate ids, never retyped coordinates.', 'Do not hand-feed copper ore into the furnace; the drill feeds it.']),
  brief('Fuel the drill and the furnace with coal in one batch, let the drill fill the furnace for about two minutes, then collect the finished copper plates from the furnace output until twenty are held.',
    'The drill mines a quarter ore per second and the furnace smelts 0.3125 plates per second, so two minutes cover the fourteen plates still missing after the six held; plates count once in the inventory.',
    ['Supply coal to the drill and to the furnace as two operations with unit numbers from a fresh scan.', 'Collect only copper-plate from the furnace output and never ask for more than it holds.', 'Keep at least ten coal in the inventory for later steps.']),
]
// A protocol 3 planner reply: a plan with its checkpoints and guidance and never an operation.
const draft = (extra = {}) => planReply({ chatMessage: '', plan: [S1, S2], currentStep: 0, operations: [], stepCompletions: [det(CP1), det(CP2)], executionGuidance: GUIDANCE, goal: GOAL, ...extra })

const activeStepId = (memory) => { const plan = getActivePlan(memory.planningState(KEY)); return plan.steps[plan.active_step_index].step_id }
const act = (memory, operations) => planReply({ stepId: activeStepId(memory), operations })
const RATIONALE = 'Both machines are standing but I cannot verify coal for the drill and the furnace together or that the drill output reaches the furnace; this needs a planner decision.'
const review = memory => planReply({ stepId: activeStepId(memory), operations: [], plannerReview: { reason: 'local_recovery_exhausted', rationale: RATIONALE } })
const placeCandidate = set => ({ name: 'place_candidate', args: { candidate_set_id: set, candidate_id: 'candidate-1' } })
const supplyCoal = (unit, count) => ({ name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'coal', count }] } })
const collectPlates = count => ({ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: FURNACE_UNIT, max_count: count, to_entity: false } })
const NOTES = 'Planner notes: fuel the drill with 5 coal and the furnace with 3 coal in one batch, then wait about two minutes for the drill to fill the furnace.'

const textOf = messages => messages.map(message => String(message.content ?? '')).join('\n')
const lineStarting = (messages, prefix) => textOf(messages).split('\n').find(line => line.startsWith(prefix)) ?? ''

async function runScenario(t, { refusePrefix = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new DrillFurnaceFactorio()
  const model = new ScriptedModel()
  const world = recoveryWorld({ game, model, completionProtocolVersion: 3 })
  world.agent.restageSoftLimitOption = { executor: EXECUTOR_SOFT_LIMIT_TOKENS }
  const { memory } = world
  const { session, chat, logs } = recoverySession(world)
  const ctx = { t, game, model, world, session, chat, logs }
  const rows = name => world.trace.filter(row => row.event === name)
  const data = name => rows(name).map(row => row.data)
  const observed = {}

  model
    .push('planner', 'planner:draft', draft())
    .push('executor', 's1:read-drill-candidates', toolCall('s1-drill', 'getPlacementCandidates',
      { entity_name: 'burner-mining-drill', target_resource: 'copper-ore', center: { x: 13.5, y: -5.5 }, radius: 6, limit: 3 }))
    .push('executor', 's1:read-furnace-candidates', toolCall('s1-furnace', 'getPlacementCandidates', { entity_name: 'stone-furnace', covers_position: DRILL_OUTPUT, radius: 4, limit: 3 }))
    .push('executor', 's1:place-drill-and-furnace', () => { observed.plan = structuredClone(getActivePlan(memory.planningState(KEY))); return act(memory, [placeCandidate(DRILL_SET), placeCandidate(FURNACE_SET)]) })
  // Run Z / AA: the refused-prefix variant. The drill (task 1) is built, the furnace (task 2) is refused before it creates anything, and
  // the corrected batch places the furnace alone.
  if (refusePrefix) model.push('executor', 's1:place-furnace-alone', (messages) => { observed.correctionPrompt = textOf(messages); return act(memory, [placeCandidate(FURNACE_SET)]) })
  model
    .push('executor', 's2:first-review', () => { observed.beforeReview = structuredClone(getActivePlan(memory.planningState(KEY))); return review(memory) })
    .push('planner', 's2:planner-review-round', () => draft({ chatMessage: NOTES, currentStep: 1 }))
    .push('executor', 's2:second-review', () => { observed.afterRound = structuredClone(getActivePlan(memory.planningState(KEY))); return review(memory) })
    .push('executor', 'c7:observe', () => {
      observed.resumed = { status: memory.currentPlan(KEY).status, pause: memory.pauseRecord(KEY).paused, allowance: { ...memory.autoResumeAllowance(KEY) } }
      return toolCall('c7-observe', 'getNearbyEntities', { radius: 24, limit: 40 })
    })
    .push('executor', 'c7:fuel-both-machines', () => act(memory, [supplyCoal(DRILL_UNIT, 5), supplyCoal(FURNACE_UNIT, 3)]))
    .push('executor', 'c7:collect-plates', () => act(memory, [collectPlates(20)]))

  // --- 1 + 2: the player request, the planner draft, the executor's reads and its one batch of two placements ---------------------
  assert.equal(session.queuePlayerRequest('TTLouis', 'Make twenty copper plates with a burner mining drill feeding a stone furnace'), true)
  await settle(session)
  observed.admitted = { sent: structuredClone(game.sent), preflights: structuredClone(game.preflights), ground: structuredClone(game.ground) }
  if (refusePrefix) {
    const reason = game.failAfterPrefix(1, { type: 'placing', code: 'not_placeable', entity_name: 'stone-furnace' })
    observed.refusal = { reason, cancelled: structuredClone(game.cancelledBatch), drill: structuredClone(game.drill), inventory: { ...game.inventory } }
    session.lastErrorAt = 0
    session.onGameLine(`[AUTORIO] [ERROR] ${reason}`)
    await settle(session)
    observed.corrected = { sent: structuredClone(game.sent), ground: structuredClone(game.ground) }
  }

  // --- the game finishes the placements and reports it; step 1 closes; step 2 starts; the executor reviews twice -----------------------
  await completeAndReport(ctx)
  observed.step2Start = { placements: structuredClone(game.placements), receipt: structuredClone(game.lastBasicResult), inventory: { ...game.inventory } }

  // --- the second review paused the goal; the supervisor scheduled the resume (nothing here called the supervisor) ------------------
  observed.paused = { record: { ...memory.pauseRecord(KEY) }, status: memory.currentPlan(KEY).status, timer: Boolean(session.modelResume?.timer), chat: [...chat] }
  await fireResumeTimer(ctx)

  // --- the restaged executor fuelled both machines; time passes; it collects; the harness verifies the goal ---------------------------
  game.completeBatch()
  game.advance(120) // the drill mines 30 ore and the furnace smelts them while the executor decides
  await reportCompletion(ctx)
  observed.afterFuel = { drill: structuredClone(game.drill), furnace: structuredClone(game.furnace) }
  await completeAndReport(ctx)
  return { ...ctx, rows, data, observed }
}

// The gates every composed run must hold at its end, over the real behavior trace the run wrote.
async function gates(t, ctx) {
  const { model, world } = ctx
  const calls = model.calls
  const rows = name => world.trace.filter(row => row.event === name)
  const report = analyzeBehaviorTrace(world.trace)
  const signatures = report.findings.map(finding => finding.signature)

  await t.test('gate: no dangling context reference at any provider request', () => {
    assert.equal(rows('provider.request').length, calls.length, 'every provider call was traced')
    assert.equal(signatures.filter(signature => signature === 'dangling_context_reference').length, 0, JSON.stringify(report.findings))
  })

  await t.test('gate: no silent stall and no model_recoverable pause left unresumed', () => {
    assert.equal(signatures.filter(signature => signature === 'silent_blocked_stall').length, 0)
    assert.equal(signatures.filter(signature => signature === 'model_recoverable_pause_not_resumed').length, 0)
    assert.equal(signatures.filter(signature => signature === 'auto_resume_exhausted').length, 0)
  })

  await t.test('gate: no other finding on this healthy run (only the expected restage_loop below)', () => {
    assert.deepEqual(report.findings.filter(finding => finding.signature !== 'restage_loop'), [], 'a healthy composed run has no other findings')
  })

  // run-check's restage_loop counts restages of one step with no step.verified between them. Step 2 is restaged three times, each
  // for its own reason (C8 the fresh executor at the step close, C3 the executor handed back after the review round, C7 the resume),
  // and then verifies. The finding stays: three restages without progress is the cost the detector exists to show. Any other
  // restage of the step, or a second loop, fails here.
  await t.test('gate: the only restage_loop is step 2 (C8, C3, C7)', () => {
    const loops = report.findings.filter(finding => finding.signature === 'restage_loop')
    assert.equal(loops.length, 1, JSON.stringify(loops))
    assert.match(loops[0].detail ?? JSON.stringify(loops[0]), /restaged 3 times .*checkpoints C8,C3,C7;/)
  })

  await t.test('gate: the planner review round happened exactly once', () => {
    assert.equal(rows('planner.review_round').length, 1)
    assert.equal(calls.filter(call => call.messages.some(message => String(message.content).startsWith('[EXECUTOR_REVIEW]'))).length, 1)
  })

  await t.test('gate: strict boundary (nothing unmodelled in the game, nothing unscripted in the model, no failure logged)', () => {
    assertStrictBoundary(ctx)
  })
}

test('composed delegation: planner draft, direct-feed placement with ground pickup, fresh executor, planner review, second review, auto-resume, verified goal', async (t) => {
  const ctx = await runScenario(t)
  const { game, model, world, chat, rows, data, observed } = ctx
  const calls = model.calls

  await t.test('1 planner draft: protocol 3, the planner authors no operation and the executor is restaged fresh at commit', () => {
    assert.equal(world.agent.completionProtocolVersion, 3)
    assert.equal(calls[0].role, 'planner')
    assert.equal(calls[0].context.completionProtocolVersion, 3)
    assert.deepEqual(calls.slice(0, 4).map(call => call.role), ['planner', 'executor', 'executor', 'executor'])
    const [committed] = data('plan.delegation_committed')
    assert.equal(committed.reason, 'validated_plan_without_initial_batch', 'the draft committed with no batch of its own')
    assert.equal(observed.admitted.sent.length, 1, 'only the executor admitted a batch')
    const plan = observed.plan
    assert.equal(plan.steps.length, 2)
    assert.deepEqual(plan.steps.map(step => step.description), [S1, S2])
    assert.equal(plan.steps[0].execution_guidance.materialSupply.mode, 'direct_feed')
    const [first] = data('context.restaged')
    assert.deepEqual([first.role, first.checkpoint, first.reason], ['executor', 'C3', 'executor_fresh_at_plan_commit'])
    assert.equal(data('plan.later_contracts_deferred').length, 1, 'the second step contract is authored when that step starts')
  })

  await t.test('2 placement: both placements are one admitted batch; the ground ore is picked up and the receipt says so', () => {
    assert.deepEqual(game.candidateReads.map(read => [read.entity_name, read.args.target_resource ?? null, read.args.covers_position ?? null]),
      [['burner-mining-drill', 'copper-ore', null], ['stone-furnace', null, DRILL_OUTPUT]])
    assert.equal(data('observation.placement_candidates_observed').length, 2)
    // Run Z batch 21: two placements of one batch go through the held-item preflight and the batch ledger, then are admitted together.
    assert.deepEqual(observed.admitted.sent.map(batch => batch.operations.map(operation => [operation.name, operation.args.candidate_set_id])),
      [[['place_candidate', DRILL_SET], ['place_candidate', FURNACE_SET]]])
    assert.deepEqual(observed.admitted.preflights.map(entry => [entry.name, entry.result.ok]), [['place_candidate', true], ['place_candidate', true]])
    assert.equal(rows('operations.preflight_rejected').length, 0)
    assert.equal(rows('operations.preflight_recoverable').length, 0)
    assert.equal(data('operations.admit').length >= 1, true)
    assert.deepEqual(observed.admitted.ground, [GROUND_ORE], 'the ore was still on the ground when the batch was admitted')
    // Run AE / AF: the furnace placement picked the ore up; the actor holds it and the ground is clear.
    assert.deepEqual(game.placements.map(placed => [placed.entity_name, placed.picked_up.reduce((sum, item) => sum + item.count, 0)]), [['burner-mining-drill', 0], ['stone-furnace', 4]])
    assert.deepEqual(game.ground, [])
    assert.equal(game.inventory['copper-ore'], 4)
    assert.equal(observed.step2Start.inventory['stone-furnace'], 2)
    assert.equal(observed.step2Start.inventory['burner-mining-drill'], 1)
    assert.deepEqual(observed.step2Start.receipt.ground_items_picked_up, [GROUND_ORE])
    assert.equal(rows('placement.npc_recorded').length >= 1, true)
    // The next executor turn is shown the receipt with the pickup in it.
    const afterBatch = calls[4].messages.filter(message => message.role === 'user' && String(message.content).startsWith('[MOD]')).map(message => message.content).join('\n')
    assert.match(afterBatch, /"ground_items_picked_up":\[\{"name":"copper-ore","count":4/)
  })

  await t.test('3 step close: the live entity count closes step 1 and the next step starts with a fresh executor', () => {
    const counts = rows('step.entity_count_checked').map(row => row.data)
    assert.deepEqual(counts.slice(-2).map(row => [row.prototype, row.authoritative, row.current, row.satisfied]), [['burner-mining-drill', true, 1, true], ['stone-furnace', true, 1, true]])
    assert.equal(data('step.completion_checked')[0].status, 'verified')
    assert.deepEqual(data('step.verified').map(row => row.active_step_id), ['step_1', 'step_2'], 'step 1 here, step 2 at the end of the run')
    assert.equal(data('step.verified')[0].task_board.steps[0].status, 'completed')
    assert.equal(data('plan.contract_bound_just_in_time').length, 1, 'the step-2 contract was authored when the step started')
    const [decision] = data('context.step_close_decision')
    assert.deepEqual([decision.restage, decision.checkpoint, decision.reason], [true, 'C8', 'context_over_hard_limit_at_step_close'])
    const stepTwo = observed.plan.steps[1].step_id
    const fresh = data('context.restaged').find(row => row.checkpoint === 'C8')
    assert.deepEqual([fresh.role, fresh.step_id], ['executor', stepTwo])
    // The step-2 executor's first provider call was built from the packet, not carried from step 1.
    const messages = calls[4].messages
    assert.equal(messages.some(message => message.role === 'assistant'), false, 'no earlier executor turn is carried into the fresh conversation')
    assert.match(textOf(messages), /restage: role=executor checkpoint=C8/)
    assert.match(textOf(messages), new RegExp(`active_step: 2 of 2 ${stepTwo}`))
    // Run AE: the fresh topology names the built drill's unit and where its output drops.
    const topology = JSON.parse(lineStarting(messages, 'fresh_topology: ').slice('fresh_topology: '.length))
    assert.equal(topology.state, 'fresh')
    const drill = topology.entities.find(entity => entity.name === 'burner-mining-drill')
    assert.deepEqual([drill.unit_number, drill.drop_position, drill.drop_target], [DRILL_UNIT, DRILL_OUTPUT, { name: 'stone-furnace', unit_number: FURNACE_UNIT }])
  })

  await t.test('4 planner review: the round really runs once, is advisory, and hands the unchanged step back with the notes', () => {
    assert.equal(data('executor.planner_review_requested').length, 2, 'the executor asked twice')
    const [round, ...more] = data('planner.review_round')
    assert.equal(more.length, 0, 'exactly one planner review round for the step')
    assert.deepEqual([round.reason, round.bound, round.authority], ['local_recovery_exhausted', 'one_planner_round_per_step', 'advisory_only'])
    assert.equal(round.step_id, observed.plan.steps[1].step_id)
    const plannerCalls = calls.filter(call => call.role === 'planner')
    assert.equal(plannerCalls.length, 2, 'the draft and the review round; nothing else woke the planner')
    const reviewCall = plannerCalls.find(call => call.messages.some(message => String(message.content).startsWith('[EXECUTOR_REVIEW]')))
    assert.ok(reviewCall, 'a planner-role provider call carried [EXECUTOR_REVIEW]')
    assert.match(textOf(reviewCall.messages), new RegExp(RATIONALE.slice(0, 60)))
    assert.match(textOf(reviewCall.messages), /one planner review round for this step/)
    assert.equal(reviewCall.context.allowTools, true)
    // The planner's reply was a contract draft with no operation: it cannot change the committed step, and the step goes back.
    const [returned, ...extra] = data('planner.committed_slice_returned')
    assert.equal(extra.length, 0)
    assert.equal(returned.reason, 'review_round_returned_same_step')

    assert.deepEqual(observed.afterRound.steps, observed.beforeReview.steps, 'the review round cannot change the committed steps')
    assert.equal(observed.afterRound.plan_id, observed.beforeReview.plan_id)
    const back = calls[6]
    assert.equal(back.role, 'executor')
    assert.equal(textOf(back.messages).split('fuel the drill with 5 coal').length - 1, 1, 'the handed-back executor sees the planner notes once')
    assert.match(textOf(back.messages), /planner_review_notes[^\n]*fuel the drill with 5 coal/, 'notes that fit ride in the packet record')
    assert.equal(back.messages.some(message => String(message.content).startsWith('[EXECUTOR_REVIEW]')), false, 'the planner conversation stays parked')
    assert.equal(back.context.allowTools, true, 'a normal executor, not an action-omission repair round')
    assert.equal(rows('recovery.action_omission_started').length, 0)
    assert.equal(data('recovery.classified').filter(row => row.reason_code === 'finite_goal_continuation_pressure').length, 0, 'no continuation pressure on the planner reply')
  })

  await t.test('5 second review: model_recoverable pause, supervisor-scheduled resume, C7 restage, executor acts, goal verified', () => {
    assert.deepEqual([observed.paused.record.paused, observed.paused.record.pause_class, observed.paused.record.pause_reason], [true, 'model_recoverable', 'executor_review:local_recovery_exhausted'])
    assert.equal(observed.paused.status, 'paused')
    assert.equal(observed.paused.timer, true, 'the pause queued its own resume decision; the timer was pending')
    const [paused, ...laterPauses] = data('goal.paused')
    assert.equal(laterPauses.length, 0)
    assert.deepEqual([paused.cause, paused.pause_class, paused.outcome], ['executor_review', 'model_recoverable', 'planner_review_required'])
    assert.ok(paused.chat_message, 'the pause is visible to the player')
    const [scheduled, ...laterScheduled] = data('recovery.auto_resume_scheduled')
    assert.equal(laterScheduled.length, 0)
    assert.deepEqual([scheduled.attempt, scheduled.limit, scheduled.goal_attempt, scheduled.goal_limit, scheduled.delay_ms], [1, 2, 1, 6, 15_000])
    assert.equal(scheduled.step_id, observed.plan.steps[1].step_id)
    assert.match(chat.join('\n'), /Resuming automatically in 15 s with a fresh context \(attempt 1\/2 for this step, 1\/6 for this goal\)/)
    assert.equal(data('recovery.auto_resume_started').length, 1)
    assert.equal(data('planner.review_round').length, 1, 'the second review did not start another planner round')
    // The restage: a fresh executor from the packet, role executor, checkpoint C7.
    const c7 = data('context.restaged').find(row => row.checkpoint === 'C7')
    assert.ok(c7, 'a C7 context.restaged row')
    assert.equal(c7.role, 'executor')
    assert.equal(c7.step_id, scheduled.step_id)
    assert.match(c7.reason, /auto_resume_after_model_recoverable_pause/)
    // Protocol 3 keeps the packet and the fresh_topology block of the same request inside the same 6,000 characters.
    const topologyChars = lineStarting(calls[7].messages, 'fresh_topology: ').length
    assert.ok(c7.packet_chars + 1 + topologyChars <= 6000, `the protocol 3 packet and its topology block fit 6,000 characters (${c7.packet_chars} + ${topologyChars})`)
    assert.doesNotMatch(lineStarting(calls[7].messages, 'fresh_topology: '), /size_limit/, 'the C7 request sent the topology block, not the size stub')
    assert.deepEqual(data('context.topology_trimmed'), [], 'no request trimmed or omitted its topology block')
    assert.deepEqual(calls.map(call => call.label), [
      'planner:draft', 's1:read-drill-candidates', 's1:read-furnace-candidates', 's1:place-drill-and-furnace',
      's2:first-review', 's2:planner-review-round', 's2:second-review', 'c7:observe', 'c7:fuel-both-machines', 'c7:collect-plates',
    ])
    assert.equal(calls[7].context.triggerSource, 'recovery')
    // The restaged executor acted on the same step: both machines fuelled in one batch, then the plates collected.
    const [, fuelBatch, collectBatch] = game.sent
    assert.deepEqual(fuelBatch.operations.map(operation => [operation.name, operation.args.unit_number, operation.args.items[0].count]), [['supply_entity', DRILL_UNIT, 5], ['supply_entity', FURNACE_UNIT, 3]])
    assert.deepEqual(collectBatch.operations.map(operation => [operation.name, operation.args.item_name, operation.args.max_count, operation.args.to_entity]), [['move_items_exact', 'copper-plate', 20, false]])
    assert.ok((observed.afterFuel.drill.fuel.coal ?? 0) < 5, 'the drill burned coal while it mined')
    assert.ok(observed.afterFuel.drill.mined >= 25, `the drill mined ore into the furnace (${observed.afterFuel.drill.mined})`)
    assert.ok(game.inventory['copper-plate'] >= 20, `the actor holds the plates (${game.inventory['copper-plate']})`)
    assert.equal(data('goal.evaluated').at(-1).satisfied, true)
    const [validated] = data('outcome.validated').slice(-1)
    assert.deepEqual([validated.kind, validated.source, validated.reason_code, validated.task_board.status, validated.task_board.completed_count], ['verified_complete', 'step_completion_gate', 'verified_final_step', 'completed', 2])
    assert.deepEqual([observed.resumed.status, observed.resumed.pause], ['active', false], 'the resume reactivated the goal before the executor was restaged')
    assert.deepEqual([observed.resumed.allowance.step_attempts, observed.resumed.allowance.goal_attempts], [1, 1], 'one resume counted against the step and the goal caps')
  })

  // --- the C7 packet (the restaged executor's first provider messages) ---------------------------------------------------------------
  const c7Messages = calls[7].messages

  await t.test('C7 packet: the restaged executor is told the active step contract', () => {
    assert.match(lineStarting(c7Messages, 'active_step_contract:'), /copper-plate>=20/)
  })

  await t.test('C7 packet: held counts are a fresh read of the actor inventory', () => {
    const held = lineStarting(c7Messages, 'held_counts')
    assert.match(held, /^held_counts \(fresh live read of the actor inventory/)
    assert.match(held, /copper-plate=6/)
  })

  await t.test('C7 packet: the standing furnace is carried with its own inventories', () => {
    assert.match(lineStarting(c7Messages, 'placed_machines'), new RegExp(`stone-furnace unit=${FURNACE_UNIT} \\[FRESH `))
  })

  await t.test('C7 packet: the fresh topology still names the drill and where its output drops (Run AE)', () => {
    const topology = JSON.parse(lineStarting(c7Messages, 'fresh_topology: ').slice('fresh_topology: '.length))
    assert.deepEqual(topology.entities.find(entity => entity.name === 'burner-mining-drill')?.drop_target, { name: 'stone-furnace', unit_number: FURNACE_UNIT })
  })

  // X-1b: the planner's review notes are durable per step and the executor packet carries them, so the executor that finally acts
  // after the C7 restage still has the planner's advice.
  await t.test('C7 packet: the planner review notes reach the restaged executor (X-1b)', () => {
    assert.match(textOf(c7Messages), /fuel the drill with 5 coal/)
  })

  await gates(t, ctx)
})

// Runs Z and AA (batch 21): the same scenario with the first placement batch refused after its first task. The drill (task 1) is built,
// the furnace (task 2) is refused before it creates anything, and the game proves it with the mod's native no-mutation claim. The
// settled prefix is a fact (operation 1 applied, operation 2 refused), the built drill is not placed again, and the corrected batch
// places the furnace alone, picking the spilled ore up. Everything after that is the main scenario.
test('composed delegation, Z/AA prefix: a refused second placement settles with the built drill applied and only the furnace is placed again', async (t) => {
  const ctx = await runScenario(t, { refusePrefix: true })
  const { game, data, rows, observed } = ctx

  await t.test('the game proved the refusal and the harness settled the prefix as a fact', () => {
    assert.equal(observed.refusal.cancelled.failed_before_mutation, true, 'the mod claims the refused placement changed nothing')
    assert.equal(observed.refusal.cancelled.failed_task_index, 1)
    assert.equal(observed.refusal.drill.placed, true, 'the first task of the batch built the drill')
    const [reconciled, ...more] = data('operation.reconciled').filter(row => row.verdict === 'refused_before_mutation')
    assert.equal(more.length, 0)
    assert.deepEqual([reconciled.effect, reconciled.applied_slots, reconciled.refused_slots, reconciled.refusal_codes, reconciled.settled], ['happened', [1], [2], ['placing:not_placeable'], true])
    assert.equal(rows('operation.uncertainty_blocked').length, 0, 'a proven prefix does not hold the step')
    assert.match(observed.correctionPrompt, /refused operations 2 before changing anything[\s\S]*Operations 1 completed before the refusal; do not repeat them/)
  })

  await t.test('only the furnace is placed again, over the spilled ore, and the drill is never placed twice', () => {
    assert.deepEqual(game.sent.map(batch => batch.operations.map(operation => operation.args.candidate_set_id ?? operation.args.unit_number)),
      [[DRILL_SET, FURNACE_SET], [FURNACE_SET], [DRILL_UNIT, FURNACE_UNIT], [FURNACE_UNIT]])
    assert.deepEqual(game.placements.map(placed => [placed.batch_id, placed.entity_name, placed.picked_up.length]), [[1, 'burner-mining-drill', 0], [2, 'stone-furnace', 1]])
    assert.deepEqual(observed.corrected.ground, [GROUND_ORE], 'the ore was still on the ground when the corrected batch was admitted')
    assert.deepEqual(game.ground, [], 'the corrected placement picked it up')
    assert.equal(game.inventory['burner-mining-drill'], 1, 'one of the two held drills was placed')
    assert.equal(game.inventory['stone-furnace'], 2)
    assert.equal(game.inventory['copper-ore'], 4)
  })

  await t.test('the run still reaches a verified goal through the review, the pause and the resume', () => {
    assert.deepEqual(data('step.verified').map(row => row.active_step_id), ['step_1', 'step_2'])
    assert.equal(data('planner.review_round').length, 1)
    assert.equal(data('recovery.auto_resume_scheduled').length, 1)
    assert.equal(data('goal.evaluated').at(-1).satisfied, true)
    assert.equal(data('outcome.validated').at(-1).kind, 'verified_complete')
    assert.ok(game.inventory['copper-plate'] >= 20)
  })

  await gates(t, ctx)
})
