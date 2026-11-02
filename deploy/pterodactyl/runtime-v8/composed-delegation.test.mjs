import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
//                            item_output_position; a furnace whose footprint covers that drop point) and submits both in ONE batch
//                            of two placing tasks. The mod keeps one exact placement result per batch, so a direct-feed step cannot
//                            take custody of the first machine: the batch is refused before any native read or send as a
//                            model-correctable argument (within the bounded correction budget), and the executor places the drill,
//                            then the furnace, each alone, through the held-item preflight, the batch stock ledger and admission.
//                            Run AE: spilled ore lies on the furnace footprint; the candidate lists it as ground_items and the
//                            build picks it up. Run AF: the receipt carries ground_items_picked_up, the actor inventory gains
//                            the ore, and the next executor turn is shown that receipt.
//   3  step close            The step closes on its entity_count checkpoint (a live count, never the receipt). The executor context
//                            is past its hard limit, so the close hands the next step to a FRESH executor (C8, the size safety
//                            net), and the step-2 contract is bound just in time. Run AE: the fresh topology record names the
//                            drill's unit and drop target.
//   4  planner review        Run AB/AC/AF: the executor asks for plannerReview. The planner review round really runs
//                            (planner.review_round once; a planner-role provider call carrying [EXECUTOR_REVIEW]); its reply is
//                            a contract draft, never an action; the unchanged step goes back to the executor with the notes. That
//                            executor was restaged at the step close (C8) and has done nothing since, so the handback folds into
//                            that restage (context.restage_folded): the C8 conversation resumes with the notes, no second packet.
//   5  second review, resume Runs AD-AF: the executor asks for review of the same step again. There is no second planner round: the
//                            goal takes a model_recoverable pause, the supervisor schedules the bounded auto-resume (X-1), the
//                            timer fires, a C7 restage hands the step to a fresh executor, which acts (fuel, collect). The plate
//                            count is met, but the direct-feed step closes only on an attributed delivery window: two native
//                            frames with no other operation between them. The collection restarted that window, so the close is
//                            declined without a pause and the executor is told so; its wait-only batch supplies the second frame.
//                            That window is inconclusive (the furnace started it holding ore and finished more crafts than it
//                            received), so it rebases on its newer frame and the close is declined again; a second wait, from an
//                            empty idle furnace, proves delivery, and the goal is verified by the harness (goal.evaluated satisfied).
// Gates at the end: no dangling context reference (f36e837c), no silent stall, no unresumed model_recoverable pause, one review
// round, a strict boundary. The C7 packet must carry the step contract, held counts and placed machines (U4), and the planner's review
// notes (X-1b, a90c3d52). A protocol 3 packet and its topology block share 6,000 characters and the packet limit follows the block's real
// size; this run's C7 packet was ~3,850 characters under a fixed 4,050 window, so the assertions failed first when a plan or receipt grew.
//
// A second test runs the same scenario with the furnace placement refused by the game (Run Z batch 21 / Run AA): the drill is
// already built, the furnace is refused with the mod's native no-mutation proof, the refusal is settled as a fact, and the
// corrected batch places the furnace alone over the spilled ore (Run AF).
//
// No finding is expected. Step 2 used to show one restage_loop (C8, then C3 for the review handback, then C7 for the resume, no
// progress between them); the handback folds into the C8 restage now, so step 2 restages twice (C8, C7) and the gates pin that.

// Exercise C8 from provider-reported context pressure, independent of prompt
// wording/length. The placement reply reports 7,001 input tokens against this
// fixture's unchanged 3,000 soft / 6,000 hard limit.
const EXECUTOR_SOFT_LIMIT_TOKENS = 3000
const contextPressure = reply => ({
  ...reply,
  _sglunaProvider: { usage: { prompt_tokens: 7001, prompt_tokens_details: { cached_tokens: 6000 }, completion_tokens: 1, total_tokens: 7002 } },
})

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
  // Factory enrollment at the step close is durable state, so this run persists like the deployed host.
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'composed-delegation-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const world = recoveryWorld({ game, model, completionProtocolVersion: 3, stateFile: path.join(directory, 'state.json') })
  world.agent.restageSoftLimitOption = { executor: EXECUTOR_SOFT_LIMIT_TOKENS }
  const { memory } = world

  // Inject the retired one-review policy solely to exercise the existing C7
  // supervisor recovery path. The default harness uses durable goal effort.
  const claimReview = memory.claimReviewContinuation.bind(memory)
  const legacyReviewedSteps = new Set()
  memory.claimReviewContinuation = (key, stepId, options) => {
    if (legacyReviewedSteps.has(stepId)) return false
    legacyReviewedSteps.add(stepId)
    return claimReview(key, stepId, options)
  }
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
    .push('executor', 's1:place-drill', (messages) => { observed.singletonPrompt = textOf(messages); return act(memory, [placeCandidate(DRILL_SET)]) })
  // Run Z / AA: the refused-placement variant. The drill is built, the furnace is refused before it creates anything, and the corrected
  // batch places the furnace alone.
  if (refusePrefix) model.push('executor', 's1:place-furnace-refused', () => act(memory, [placeCandidate(FURNACE_SET)]))
  model
    .push('executor', 's1:place-furnace', (messages) => {
      if (refusePrefix) observed.correctionPrompt = textOf(messages)
      return contextPressure(act(memory, [placeCandidate(FURNACE_SET)]))
    })
    .push('executor', 's2:first-review', () => { observed.beforeReview = structuredClone(getActivePlan(memory.planningState(KEY))); return review(memory) })
    .push('planner', 's2:planner-review-round', () => draft({ chatMessage: NOTES, currentStep: 1 }))
    .push('executor', 's2:second-review', () => { observed.afterRound = structuredClone(getActivePlan(memory.planningState(KEY))); return review(memory) })
    .push('executor', 'c7:observe', () => {
      observed.resumed = { status: memory.currentPlan(KEY).status, pause: memory.pauseRecord(KEY).paused, allowance: { ...memory.autoResumeAllowance(KEY) } }
      return toolCall('c7-observe', 'getNearbyEntities', { radius: 24, limit: 40 })
    })
    .push('executor', 'c7:fuel-both-machines', () => act(memory, [supplyCoal(DRILL_UNIT, 5), supplyCoal(FURNACE_UNIT, 3)]))
    .push('executor', 'c7:collect-plates', () => act(memory, [collectPlates(20)]))
    .push('executor', 'c7:wait-for-delivery', (messages) => { observed.deliveryPrompt = textOf(messages); return act(memory, [{ name: 'wait', args: { ticks: 600 } }]) })
    .push('executor', 'c7:wait-again', (messages) => { observed.rebasedPrompt = textOf(messages); return act(memory, [{ name: 'wait', args: { ticks: 600 } }]) })

  // --- 1 + 2: the player request, the planner draft, the executor's reads, its refused two-placement batch, the drill alone -----------
  assert.equal(session.queuePlayerRequest('TTLouis', 'Make twenty copper plates with a burner mining drill feeding a stone furnace'), true)
  await settle(session)
  observed.admitted = { sent: structuredClone(game.sent), preflights: structuredClone(game.preflights), ground: structuredClone(game.ground) }

  // --- the drill is built; the executor places the furnace alone ----------------------------------------------------------------------
  await completeAndReport(ctx)
  observed.furnaceAdmitted = { sent: structuredClone(game.sent), ground: structuredClone(game.ground) }
  if (refusePrefix) {
    const reason = game.failAfterPrefix(0, { type: 'placing', code: 'not_placeable', entity_name: 'stone-furnace' })
    observed.refusal = { reason, cancelled: structuredClone(game.cancelledBatch), drill: structuredClone(game.drill), inventory: { ...game.inventory } }
    session.lastErrorAt = 0
    session.onGameLine(`[AUTORIO] [ERROR] ${reason}`)
    await settle(session)
    observed.corrected = { sent: structuredClone(game.sent), ground: structuredClone(game.ground) }
  }

  // --- the game finishes the furnace placement and reports it; step 1 closes; step 2 starts; the executor reviews twice --------------
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
  // The plates are collected: the count is met, and the attributed delivery window holds only its first frame.
  await completeAndReport(ctx)
  observed.afterCollect = { status: memory.currentPlan(KEY).status, completed: memory.currentPlan(KEY).task_board.completed_count,
    pause: memory.pauseRecord(KEY).paused, plates: game.inventory['copper-plate'] }
  // The wait-only batch runs while the drill keeps feeding the furnace; its completion read is the window's second frame. The furnace
  // started that window holding one ore and finished more crafts than it received, so the window is inconclusive and its newer frame
  // becomes the first frame of the next one.
  game.completeBatch()
  game.advance(10)
  await reportCompletion(ctx)
  observed.afterFirstWait = { status: memory.currentPlan(KEY).status, completed: memory.currentPlan(KEY).task_board.completed_count,
    pause: memory.pauseRecord(KEY).paused }
  // The second wait starts from an empty, idle furnace, so a finished craft can only be smelted from ore the drill delivered.
  game.completeBatch()
  game.advance(10)
  await reportCompletion(ctx)
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

  await t.test('gate: no finding on this healthy run', () => {
    assert.deepEqual(report.findings, [], 'a healthy composed run has no findings')
  })

  // run-check's restage_loop counts restages of one step with no step.verified between them (three or more is a loop). Step 2 used
  // to be restaged three times: C8 the fresh executor at the step close, C3 the executor handed back after the review round, C7 the
  // resume. The handback folds into the C8 restage now, so the step restages twice, for the two reasons that remain, and the detector
  // stays silent. A C3 after the C8, or any other restage of the step, fails here.
  await t.test('gate: step 2 restages twice (C8, C7); the review handback is one folded entry, not a restage', () => {
    assert.deepEqual(rows('context.restaged').map(row => row.data.checkpoint), ['C3', 'C8', 'C7'], 'C3 at the plan commit, then the step close, then the resume')
    assert.equal(rows('context.restage_folded').length, 1, 'exactly one folded handback')
    assert.equal(signatures.filter(signature => signature === 'restage_loop').length, 0)
  })

  await t.test('gate: the planner review round happened exactly once', () => {
    assert.equal(rows('planner.review_round').length, 1)
    assert.equal(calls.filter(call => call.messages.some(message => String(message.content).startsWith('[EXECUTOR_REVIEW]'))).length, 1)
  })

  await t.test('gate: strict boundary (nothing unmodelled in the game, nothing unscripted in the model, no failure logged)', () => {
    assertStrictBoundary(ctx)
  })
}

test('composed delegation with injected legacy review cap: planner draft, direct-feed placement with ground pickup, fresh executor, planner review, second review, auto-resume, verified goal', async (t) => {
  const ctx = await runScenario(t)
  const { game, model, world, chat, rows, data, observed } = ctx
  const calls = model.calls
  const callAt = label => calls.find(call => call.label === label)

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

  await t.test('2 placement: the two-placement batch is refused before admission, each machine is placed alone, and the ground ore is picked up', () => {
    assert.deepEqual(game.candidateReads.map(read => [read.entity_name, read.args.target_resource ?? null, read.args.covers_position ?? null]),
      [['burner-mining-drill', 'copper-ore', null], ['stone-furnace', null, DRILL_OUTPUT]])
    assert.equal(data('observation.placement_candidates_observed').length, 2)
    // The mod keeps only the last placement result of a batch, so the first machine of a two-placement batch could not be enrolled
    // from an exact receipt. The harness refuses that batch before anything is sent and gives the executor one correction turn.
    const [refused, ...moreRefused] = data('operations.preflight_recoverable')
    assert.equal(moreRefused.length, 0)
    assert.deepEqual([refused.failure_class, refused.preflight.code, refused.preflight.refusal_class, refused.preflight.placements, refused.preflight.operations],
      ['model_correctable_factory_direct_feed_single_placement_required', 'factory_direct_feed_single_placement_required', 'argument', 2, 2])
    assert.equal(rows('operations.preflight_rejected').length, 0)
    assert.match(observed.singletonPrompt, /Refused before admission \(factory_direct_feed_single_placement_required\); no operation from this batch ran/)
    assert.match(observed.singletonPrompt, /one placement per batch/)
    assert.deepEqual(observed.admitted.sent.map(batch => batch.operations.map(operation => [operation.name, operation.args.candidate_set_id])),
      [[['place_candidate', DRILL_SET]]], 'nothing from the refused batch was sent; the corrected batch is the drill alone')
    assert.deepEqual(observed.admitted.preflights.map(entry => [entry.name, entry.result.ok]), [['place_candidate', true]])
    assert.deepEqual(observed.furnaceAdmitted.sent.map(batch => batch.operations.map(operation => operation.args.candidate_set_id)), [[DRILL_SET], [FURNACE_SET]])
    assert.deepEqual(observed.admitted.ground, [GROUND_ORE], 'the ore was still on the ground when the drill was admitted')
    assert.deepEqual(observed.furnaceAdmitted.ground, [GROUND_ORE], 'and when the furnace was admitted')
    // Run AE / AF: the furnace placement picked the ore up; the actor holds it and the ground is clear.
    assert.deepEqual(game.placements.map(placed => [placed.entity_name, placed.picked_up.reduce((sum, item) => sum + item.count, 0)]), [['burner-mining-drill', 0], ['stone-furnace', 4]])
    assert.deepEqual(game.ground, [])
    assert.equal(game.inventory['copper-ore'], 4)
    assert.equal(observed.step2Start.inventory['stone-furnace'], 2)
    assert.equal(observed.step2Start.inventory['burner-mining-drill'], 1)
    assert.deepEqual(observed.step2Start.receipt.ground_items_picked_up, [GROUND_ORE])
    assert.deepEqual([observed.step2Start.receipt.entity_name, observed.step2Start.receipt.placed_batch_id], ['stone-furnace', 2], 'an exact single-placement receipt')
    assert.equal(rows('placement.npc_recorded').length >= 1, true)
    // The next executor turn is shown the receipt with the pickup in it.
    const afterBatch = callAt('s2:first-review').messages.filter(message => message.role === 'user' && String(message.content).startsWith('[MOD]')).map(message => message.content).join('\n')
    assert.match(afterBatch, /"ground_items_picked_up":\[\{"name":"copper-ore","count":4/)
  })

  await t.test('3 step close: the live entity count closes step 1 and the next step starts with a fresh executor', () => {
    const counts = rows('step.entity_count_checked').map(row => row.data)
    assert.deepEqual(counts.slice(-2).map(row => [row.prototype, row.authoritative, row.current, row.satisfied]), [['burner-mining-drill', true, 1, true], ['stone-furnace', true, 1, true]])
    assert.deepEqual(data('step.completion_checked').map(row => row.status), ['waiting', 'verified', 'waiting', 'verified'],
      'step 1 waits after the drill alone and closes after the furnace; step 2 waits, then closes on the delivery window')
    assert.deepEqual(data('step.verified').map(row => row.active_step_id), ['step_1', 'step_2'], 'step 1 here, step 2 at the end of the run')
    assert.equal(data('step.verified')[0].task_board.steps[0].status, 'completed')
    assert.equal(data('plan.contract_bound_just_in_time').length, 1, 'the step-2 contract was authored when the step started')
    const [decision] = data('context.step_close_decision')
    assert.deepEqual([decision.restage, decision.checkpoint, decision.reason], [true, 'C8', 'context_over_hard_limit_at_step_close'])
    const stepTwo = observed.plan.steps[1].step_id
    const fresh = data('context.restaged').find(row => row.checkpoint === 'C8')
    assert.deepEqual([fresh.role, fresh.step_id], ['executor', stepTwo])
    // The step-2 executor's first provider call was built from the packet, not carried from step 1.
    const messages = callAt('s2:first-review').messages
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
    assert.deepEqual([round.reason, round.bound, round.authority], ['local_recovery_exhausted', 'durable_goal_no_progress_effort', 'advisory_only'])
    assert.equal(round.step_id, observed.plan.steps[1].step_id)
    const plannerCalls = calls.filter(call => call.role === 'planner')
    assert.equal(plannerCalls.length, 2, 'the draft and the review round; nothing else woke the planner')
    const reviewCall = plannerCalls.find(call => call.messages.some(message => String(message.content).startsWith('[EXECUTOR_REVIEW]')))
    assert.ok(reviewCall, 'a planner-role provider call carried [EXECUTOR_REVIEW]')
    assert.match(textOf(reviewCall.messages), new RegExp(RATIONALE.slice(0, 60)))
    assert.match(textOf(reviewCall.messages), /Revise the working plan within the unchanged user grant|Review the structured refusal and current facts/)
    assert.equal(reviewCall.context.allowTools, true)
    // The planner's reply was a contract draft with no operation: it cannot change the committed step, and the step goes back.
    const [returned, ...extra] = data('planner.committed_slice_returned')
    assert.equal(extra.length, 0)
    assert.equal(returned.reason, 'review_round_returned_same_step')

    assert.deepEqual(observed.afterRound.steps, observed.beforeReview.steps, 'the review round cannot change the committed steps')
    assert.equal(observed.afterRound.plan_id, observed.beforeReview.plan_id)
    const back = callAt('s2:second-review')
    assert.equal(back.role, 'executor')
    assert.equal(textOf(back.messages).split('fuel the drill with 5 coal').length - 1, 1, 'the handed-back executor sees the planner notes once')
    // The handback is folded into the step-close restage: the executor that asked for the review resumes with its C8 packet (the
    // step-close facts) and the notes in that packet's own record (the step block is rewritten in place), instead of a second restage that
    // rebuilds the same packet. The notes ride in baseMessages, so a later continuation keeps them.
    assert.match(textOf(back.messages), /restage: role=executor checkpoint=C8/)
    assert.doesNotMatch(textOf(back.messages), /restage: role=executor checkpoint=C3/)
    assert.match(textOf(back.messages), /planner_review_notes[^\n]*fuel the drill with 5 coal/, 'the notes ride the packet record')
    assert.equal(back.messages.filter(message => String(message.content).startsWith('[PLANNER_REVIEW_NOTES]')).length, 0, 'no second copy as a message')
    assert.equal(back.messages.at(-1).role, 'user', 'the review request is answered by a user turn')
    assert.match(textOf(back.messages), /fresh_topology: /, 'the step-close topology record is still in the conversation')
    assert.equal(back.messages.filter(message => message.role === 'assistant').length, 1, 'the executor review request is the only earlier executor turn')
    const [folded, ...moreFolded] = data('context.restage_folded')
    assert.equal(moreFolded.length, 0)
    const c8 = data('context.restaged').find(row => row.checkpoint === 'C8')
    assert.deepEqual([folded.role, folded.checkpoint, folded.folded_from, folded.reason], ['executor', 'C8', 'C3', 'review_handback_at_step_close'])
    assert.equal(folded.handoff_id, c8.handoff_id, 'the folded entry is the C8 conversation, resumed')
    assert.equal(folded.step_id, round.step_id)
    assert.ok(folded.request_id)
    assert.equal(folded.notes_chars, NOTES.length)
    assert.deepEqual([folded.facts_refreshed, folded.step_block_rewritten], [true, true], 'the live facts were read again and the step block rewritten')
    assert.equal(data('lifecycle.entered').filter(row => row.event === 'restage' && row.folded_from === 'C3').length, 1, 'the folded entry went through the lifecycle table')
    assert.equal(data('lifecycle.refused').length, 0)
    assert.equal(rows('context.planner_resumed')[0].data.executor_kept, true, 'the planner return kept the C8 executor for the handback')
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
    const topologyChars = lineStarting(callAt('c7:observe').messages, 'fresh_topology: ').length
    assert.ok(c7.packet_chars + 1 + topologyChars <= 6000, `the protocol 3 packet and its topology block fit 6,000 characters (${c7.packet_chars} + ${topologyChars})`)
    assert.doesNotMatch(lineStarting(callAt('c7:observe').messages, 'fresh_topology: '), /size_limit/, 'the C7 request sent the topology block, not the size stub')
    assert.deepEqual(data('context.topology_trimmed'), [], 'no request trimmed or omitted its topology block')
    assert.deepEqual(calls.map(call => call.label), [
      'planner:draft', 's1:read-drill-candidates', 's1:read-furnace-candidates', 's1:place-drill-and-furnace', 's1:place-drill', 's1:place-furnace',
      's2:first-review', 's2:planner-review-round', 's2:second-review', 'c7:observe', 'c7:fuel-both-machines', 'c7:collect-plates',
      'c7:wait-for-delivery', 'c7:wait-again',
    ])
    assert.equal(callAt('c7:observe').context.triggerSource, 'recovery')
    // The restaged executor acted on the same step: both machines fuelled in one batch, then the plates collected, then two waits.
    const [, , fuelBatch, collectBatch, ...waits] = game.sent
    assert.deepEqual(waits.map(batch => batch.operations.map(operation => operation.name)), [['wait'], ['wait']])
    assert.deepEqual(data('operations.admit').slice(-2).map(row => row.operations.map(operation => [operation.name, operation.args.ticks])), [[['wait', 600]], [['wait', 600]]])
    assert.deepEqual(fuelBatch.operations.map(operation => [operation.name, operation.args.unit_number, operation.args.items[0].count]), [['supply_entity', DRILL_UNIT, 5], ['supply_entity', FURNACE_UNIT, 3]])
    assert.deepEqual(collectBatch.operations.map(operation => [operation.name, operation.args.item_name, operation.args.max_count, operation.args.to_entity]), [['move_items_exact', 'copper-plate', 20, false]])
    assert.ok((observed.afterFuel.drill.fuel.coal ?? 0) < 5, 'the drill burned coal while it mined')
    assert.ok(observed.afterFuel.drill.mined >= 25, `the drill mined ore into the furnace (${observed.afterFuel.drill.mined})`)
    assert.ok(game.inventory['copper-plate'] >= 20, `the actor holds the plates (${game.inventory['copper-plate']})`)
    // The plate count was met at the collect, but a direct-feed step closes only on an attributed delivery window: two native frames with
    // no other operation between them. The collect's frame starts the window; the first wait's window is inconclusive (the furnace began
    // it holding ore and finished more crafts than it received) and rebases; the second wait, from an empty idle furnace, proves delivery.
    // Every miss declined the close without a pause and told the executor that a wait completes it.
    assert.deepEqual([observed.afterCollect.status, observed.afterCollect.completed, observed.afterCollect.pause], ['active', 1, false])
    assert.deepEqual([observed.afterFirstWait.status, observed.afterFirstWait.completed, observed.afterFirstWait.pause], ['active', 1, false])
    assert.deepEqual(data('step.close_declined').filter(row => row.reason === 'factory_cell_delivery_unverified').map(row => [row.trigger, row.observation]), [
      ['batch_receipt', 'direct_delivery_window_started'], ['fresh_read_checkpoint_met_before_wait', 'direct_delivery_window_no_new_tick'],
      ['fresh_read_delivery_window_wait', 'direct_delivery_window_rebased'], ['fresh_read_checkpoint_met_before_wait', 'direct_delivery_window_no_new_tick']])
    assert.equal(rows('factory_cell.enrollment_close_refused').length, 0, 'no delivery miss reached the guard pause')
    for (const prompt of [observed.deliveryPrompt, observed.rebasedPrompt]) assert.match(prompt, /closes only when two native frames, with no other operation between them/)
    const delivered = data('factory_cell.use_resolved').filter(row => row.phase === 'close').map(row => JSON.stringify(row))
      .filter(text => text.includes('"code":"exclusive_direct_delivery_window"'))
    assert.equal(delivered.length, 1, 'one close carried attributed delivery')
    assert.match(delivered[0], /"basis":"empty_receiver_started_and_completed_native_crafting"/)
    assert.match(delivered[0], /"continuous_supply":"unverified"/)
    assert.equal(data('goal.evaluated').at(-1).satisfied, true)
    const [validated] = data('outcome.validated').slice(-1)
    assert.deepEqual([validated.kind, validated.source, validated.reason_code, validated.task_board.status, validated.task_board.completed_count], ['verified_complete', 'step_completion_gate', 'verified_final_step', 'completed', 2])
    assert.deepEqual([observed.resumed.status, observed.resumed.pause], ['active', false], 'the resume reactivated the goal before the executor was restaged')
    assert.deepEqual([observed.resumed.allowance.step_attempts, observed.resumed.allowance.goal_attempts], [1, 1], 'one resume counted against the step and the goal caps')
  })

  // --- the C7 packet (the restaged executor's first provider messages) ---------------------------------------------------------------
  const c7Messages = callAt('c7:observe').messages

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
test('composed delegation with injected legacy review cap, Z/AA prefix: a refused second placement settles with the built drill applied and only the furnace is placed again', async (t) => {
  const ctx = await runScenario(t, { refusePrefix: true })
  const { game, data, rows, observed } = ctx

  await t.test('the game proved the refusal and the harness settled the prefix as a fact', () => {
    assert.equal(observed.refusal.cancelled.failed_before_mutation, true, 'the mod claims the refused placement changed nothing')
    assert.equal(observed.refusal.cancelled.failed_task_index, 0, "the furnace is its batch's only task")
    assert.equal(observed.refusal.drill.placed, true, 'the drill was built by its own earlier batch')
    const [reconciled, ...more] = data('operation.reconciled').filter(row => row.verdict === 'refused_before_mutation')
    assert.equal(more.length, 0)
    assert.deepEqual([reconciled.effect, reconciled.applied_slots, reconciled.refused_slots, reconciled.refusal_codes, reconciled.settled], ['not_happened', [], [1], ['placing:not_placeable'], true])
    assert.equal(rows('operation.uncertainty_blocked').length, 0, 'a proven refusal does not hold the step')
    assert.match(observed.correctionPrompt, /Autorio operation error: placing:not_placeable/)
    assert.match(observed.correctionPrompt, /"last_cancelled_batch":\{"batch_id":2,"task_count":1,"task_types":\["placing"\]/)
  })

  await t.test('only the furnace is placed again, over the spilled ore, and the drill is never placed twice', () => {
    assert.deepEqual(game.sent.map(batch => batch.operations.map(operation => operation.args.candidate_set_id ?? operation.args.unit_number ?? operation.name)),
      [[DRILL_SET], [FURNACE_SET], [FURNACE_SET], [DRILL_UNIT, FURNACE_UNIT], [FURNACE_UNIT], ['wait'], ['wait']])
    assert.deepEqual(game.placements.map(placed => [placed.batch_id, placed.entity_name, placed.picked_up.length]), [[1, 'burner-mining-drill', 0], [3, 'stone-furnace', 1]])
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
