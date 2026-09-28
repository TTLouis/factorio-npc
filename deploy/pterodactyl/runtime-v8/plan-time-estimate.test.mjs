import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyOperation,
  formatDuration,
  isLongEstimate,
  OVERRUN_FACTOR,
  parseRateAnswer,
  PlanTimeEstimator,
  PlanTiming,
  STEP_LONG_SECONDS,
} from './plan-time-estimate.mjs'
import {
  productionEstimateAnswer,
  STEAM_PLAN,
  STEAM_ROUNDS,
  STEAM_STEP1_INVENTORY,
  steamReplayHarness,
  TimedSteamFactorio,
} from './steam-run-fixtures.mjs'
import { plannerControlPayloadFromMessage } from './structured-policy.mjs'
import { liveAgentDebugEvent, taskBoardUiSnapshot } from './supervisor.mjs'

// A fake game that answers only the production estimate, with the mod's
// arithmetic over base-game prototypes (steam-run-fixtures.mjs).
function estimateGame() {
  const commands = []
  return {
    commands,
    async command(text) {
      commands.push(text)
      if (text.includes('"autorio_knowledge","production_estimate"')) return JSON.stringify(productionEstimateAnswer(text))
      return '{}'
    },
  }
}

const gatherOp = (resource, count, radius = 512) => ({ name: 'gather_resource', args: { resource_name: resource, count, search_radius: radius } })
const STEP1_OPERATIONS = Object.entries(STEAM_STEP1_INVENTORY).map(([resource, count]) => gatherOp(resource, count))

test('the four-op 390-ore hand-mining batch estimates 13 min on the actor lane from game rates (regression 7)', async () => {
  const game = estimateGame()
  const estimate = await new PlanTimeEstimator().estimateOperations(game, STEP1_OPERATIONS, { actorId: 15, epoch: 1 })
  // 390 ore x (mining_time 1 / character mining speed 0.5) = 780 s.
  assert.equal(estimate.expected_seconds, 780)
  assert.equal(formatDuration(estimate.expected_seconds), '13.0 min')
  assert.equal(estimate.lane, 'actor')
  assert.equal(estimate.single_lane, true)
  assert.equal(estimate.complete, true)
  assert.deepEqual(estimate.excluded, ['walking', 'placement', 'transfer'])
  assert.match(estimate.basis, /production_estimate/)
  assert.equal(estimate.widest_search_radius, 512)
  assert.deepEqual(estimate.operations.map(item => [item.target, item.count, item.seconds, item.seconds_per_unit]), [
    ['coal', 80, 160, 2],
    ['stone', 60, 120, 2],
    ['iron-ore', 180, 360, 2],
    ['copper-ore', 70, 140, 2],
  ])
  // One game read per distinct resource, cached per actor and epoch.
  assert.equal(game.commands.length, 4)
  await new PlanTimeEstimator().estimateOperations(game, STEP1_OPERATIONS, { actorId: 15, epoch: 1 })
  const estimator = new PlanTimeEstimator()
  await estimator.estimateOperations(game, STEP1_OPERATIONS, { actorId: 15, epoch: 1 })
  await estimator.estimateOperations(game, STEP1_OPERATIONS, { actorId: 15, epoch: 1 })
  assert.equal(game.commands.length, 12)

  const trigger = isLongEstimate(estimate)
  assert.equal(trigger.long, true)
  assert.equal(trigger.reason, 'step_over_threshold')
  assert.equal(trigger.threshold_seconds, STEP_LONG_SECONDS)
})

test('a 10-ore batch is 20 s and does not trip the long-plan trigger', async () => {
  const estimate = await new PlanTimeEstimator().estimateOperations(estimateGame(), [gatherOp('iron-ore', 10, 32)])
  assert.equal(estimate.expected_seconds, 20)
  assert.equal(isLongEstimate(estimate).long, false)
  assert.equal(estimate.widest_search_radius, 32)
})

test('a rate the game does not give is unknown, never invented', async () => {
  const silent = { async command() { return '{}' } }
  const estimate = await new PlanTimeEstimator().estimateOperations(silent, STEP1_OPERATIONS)
  assert.equal(estimate.expected_seconds, undefined)
  assert.equal(estimate.unknown_operations, 4)
  assert.match(estimate.basis, /^unknown/)
  assert.equal(isLongEstimate(estimate).long, false)

  const failing = { async command() { throw new Error('rcon down') } }
  const failed = await new PlanTimeEstimator().estimateOperations(failing, [gatherOp('coal', 500)])
  assert.equal(failed.expected_seconds, undefined)

  // Unknown operation kinds and a missing resource stay unknown; waits are
  // exact; walks and quick actions are not timed.
  const mixed = await new PlanTimeEstimator().estimateOperations(estimateGame(), [
    { name: 'mine_entity', args: { entity_name: 'rock-big', count: 3 } },
    gatherOp('uranium-ore', 10),
    { name: 'wait', args: { ticks: 600 } },
    { name: 'walk_to_position', args: { x: 1, y: 2 } },
    { name: 'place_entity', args: { entity_name: 'stone-furnace', x: 1, y: 1 } },
  ])
  assert.equal(mixed.expected_seconds, 10)
  assert.equal(mixed.unknown_operations, 2)
  assert.equal(mixed.lower_bound, true)
  assert.deepEqual(mixed.operations.map(item => item.kind), ['unknown', 'unknown', 'wait', 'walk', 'quick'])
})

test('hand crafting uses the recipe energy over hand crafting speed and is a lower bound', async () => {
  const estimate = await new PlanTimeEstimator().estimateOperations(estimateGame(), [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 6 } }])
  assert.equal(estimate.expected_seconds, 3)
  assert.equal(estimate.lower_bound, true)
  assert.equal(estimate.operations[0].bound, 'lower')
  // A craft the mod resolved as mining (no hand recipe) is not a craft rate.
  assert.equal(parseRateAnswer('hand_craft', productionEstimateAnswer("target='coal',count=1,steps={{item='coal',resource='coal'}}")), undefined)
  assert.equal(classifyOperation({ name: 'craft_item', args: { count: 2 } }).kind, 'unknown')
})

test('submitPlan carries timeReview through the control tool', () => {
  const payload = plannerControlPayloadFromMessage({
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: {
        name: 'submitPlan',
        arguments: JSON.stringify({ plan: ['mine'], currentStep: 0, operations: [], timeReview: { decision: 'keep_serial', reason: 'nothing to build machines from yet' } }),
      },
    }],
  })
  assert.deepEqual(payload.timeReview, { decision: 'keep_serial', reason: 'nothing to build machines from yet' })
})

function reviewRounds({ answer, beforeSubmit } = {}) {
  const [a0, a1, a2, a3, ...tail] = STEAM_ROUNDS
  return [
    a0,
    a1,
    beforeSubmit ?? a2,
    a3,
    ...(answer ? [answer] : []),
    ...tail,
  ]
}

const KEEP_SERIAL_ANSWER = {
  id: 'time_review_answer', phase: 'authoring', scripted: true,
  usage: { output: 900, reasoning: 700, input: 27900, cached: 26000 }, reasoning_chars: 2800,
  submitPlan: {
    chatMessage: '',
    plan: STEAM_PLAN,
    currentStep: 0,
    operations: STEP1_OPERATIONS,
    checkpoint: STEAM_ROUNDS[3].submitPlan.checkpoint,
    timeReview: { decision: 'keep_serial', reason: 'no drill or furnace can be built before this ore is mined' },
  },
}

test('steam replay: the 390-ore step gets one time review before it runs, and the kept draft runs with its reason traced (regressions 7 and 8)', async () => {
  const world = steamReplayHarness({ rounds: reviewRounds({ answer: KEEP_SERIAL_ANSWER }), game: new TimedSteamFactorio() })
  const result = await world.request()
  assert.equal(result.goalStatus, 'active')

  const requested = world.events('plan.time_review_requested')
  assert.equal(requested.length, 1, 'one review round per plan revision')
  assert.equal(requested[0].data.expected_seconds, 780)
  assert.equal(requested[0].data.trigger, 'step_over_threshold')
  assert.equal(requested[0].data.lane, 'actor')
  assert.equal(requested[0].data.estimate_tool_called, false)
  assert.match(requested[0].request_id, /^req_/)

  // The review reached the model in the next round, right after its held
  // draft, and carries the estimate; nothing ran before it.
  const reviewCall = world.calls[4]
  assert.equal(reviewCall.round.id, 'time_review_answer')
  const index = reviewCall.messages.findIndex(message => message.role === 'user' && String(message.content).startsWith('[HARNESS] Time review'))
  assert.ok(index > 0)
  assert.equal(reviewCall.messages[index - 1].role, 'assistant')
  assert.deepEqual(JSON.parse(reviewCall.messages[index - 1].content).operations, STEP1_OPERATIONS)
  const last = reviewCall.messages[index]
  assert.match(last.content, /about 13\.0 min of serial work on the NPC's own lane/)
  assert.match(last.content, /made no estimateProductionTime or getMiningDetails call/)
  assert.match(last.content, /search_radius is 512 tiles/)
  assert.doesNotMatch(last.content, /burner|furnace lane/, 'mechanics only, no build order')

  const answered = world.events('plan.time_review_answered')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.decision, 'keep_serial')
  assert.equal(answered[0].data.reason, 'no drill or furnace can be built before this ore is mined')
  assert.equal(answered[0].data.operations_revised, false)

  // Only the answered draft was accepted and admitted.
  assert.equal(world.events('plan.accepted').length, 1)
  assert.equal(world.game.mutations.length, 1)
  const estimate = world.events('plan.time_estimate')
  assert.equal(estimate.length, 1)
  assert.equal(estimate[0].data.step_expected_seconds, 780)
  assert.equal(estimate[0].data.step_id, 'step_1')
  assert.equal(estimate[0].data.long, true)
  assert.equal(estimate[0].data.review, 'answered')
  const ackSeq = world.events('operations.ack')[0].seq
  assert.ok(estimate[0].seq > ackSeq)

  // The step closes on its contract; the measured time is recorded next to
  // the estimate.
  await world.closeStep1()
  const measured = world.events('step.time_measured')
  assert.equal(measured.length, 1)
  assert.equal(measured[0].data.step_id, 'step_1')
  assert.equal(measured[0].data.expected_seconds, 780)
  assert.equal(measured[0].data.hand_mined_items, 390)
  assert.ok(Number.isFinite(measured[0].data.elapsed_wall_seconds))
  // The step-2 supply batch has no hand work: no estimate, no review.
  assert.equal(world.events('plan.time_review_requested').length, 1)
})

test('a draft revised in answer to the review is not reviewed again, and the revision is traced', async () => {
  const revised = {
    ...KEEP_SERIAL_ANSWER,
    submitPlan: {
      ...KEEP_SERIAL_ANSWER.submitPlan,
      operations: [gatherOp('coal', 60), gatherOp('stone', 60), gatherOp('iron-ore', 120)],
      timeReview: undefined,
    },
  }
  const world = steamReplayHarness({ rounds: reviewRounds({ answer: revised }), game: new TimedSteamFactorio() })
  await world.request()
  assert.equal(world.events('plan.time_review_requested').length, 1)
  const answered = world.events('plan.time_review_answered')
  assert.equal(answered.length, 1)
  assert.equal(answered[0].data.decision, 'revised_without_reason')
  assert.equal(answered[0].data.operations_revised, true)
  assert.equal(answered[0].data.expected_seconds_before, 780)
  assert.equal(answered[0].data.expected_seconds_after, 480)
  assert.equal(world.game.mutations.length, 1)
})

test('a plan written after an estimate tool call runs without a review round (regression 8 negative)', async () => {
  const estimated = {
    ...STEAM_ROUNDS[2],
    reads: [{ name: 'estimateProductionTime', args: { target: 'iron-ore', count: 180, steps: [{ item: 'iron-ore' }] } }],
  }
  const world = steamReplayHarness({ rounds: reviewRounds({ beforeSubmit: estimated }), game: new TimedSteamFactorio() })
  await world.request()
  assert.equal(world.events('plan.time_review_requested').length, 0)
  assert.equal(world.calls.length, 4)
  const estimate = world.events('plan.time_estimate')
  assert.equal(estimate.length, 1)
  assert.equal(estimate[0].data.long, true)
  assert.equal(estimate[0].data.review, 'skipped_estimate_tool_called')
})

test('a short hand-mining step runs without a review', async () => {
  const small = { ...STEAM_ROUNDS[3], submitPlan: { ...STEAM_ROUNDS[3].submitPlan, operations: [gatherOp('iron-ore', 10, 32)], checkpoint: undefined } }
  const [a0, a1, a2] = STEAM_ROUNDS
  const world = steamReplayHarness({ rounds: [a0, a1, a2, small], game: new TimedSteamFactorio() })
  await world.request()
  assert.equal(world.events('plan.time_review_requested').length, 0)
  const estimate = world.events('plan.time_estimate')
  assert.equal(estimate[0].data.step_expected_seconds, 20)
  assert.equal(estimate[0].data.long, false)
  assert.equal(estimate[0].data.review, 'below_threshold')
})

test('a world without game rates runs as before and says the estimate is unknown', async () => {
  const world = steamReplayHarness()
  await world.request()
  assert.equal(world.events('plan.time_review_requested').length, 0)
  assert.equal(world.calls.length, 4)
  const estimate = world.events('plan.time_estimate')
  assert.equal(estimate.length, 1)
  assert.equal(estimate[0].data.step_expected_seconds, undefined)
  assert.equal(estimate[0].data.unknown_operations, 4)
  assert.equal(estimate[0].data.review, 'no_game_rate')
})

test('while the long step runs, the planner sees estimate vs elapsed; an overrun is a fact and is traced once', async () => {
  let clock = Date.parse('2026-09-26T02:52:00Z')
  const continueStep = {
    id: 'continue_step_1', phase: 'authoring', scripted: true,
    usage: { output: 600, reasoning: 400, input: 28000, cached: 26000 }, reasoning_chars: 1600,
    content: { chatMessage: '', plan: STEAM_PLAN, currentStep: 0, operations: [gatherOp('iron-ore', 10, 64)] },
  }
  const world = steamReplayHarness({ rounds: [...reviewRounds({ answer: KEEP_SERIAL_ANSWER }).slice(0, 5), continueStep], game: new TimedSteamFactorio() })
  world.agent.planTiming = new PlanTiming({ now: () => clock })
  await world.request()

  // Twenty-two minutes later the batch reports done but the contract is not
  // met yet (1.69x the 13 min estimate).
  clock += 1320 * 1000
  const debug = world.agent.planTiming.debugFields(world.agent.peekPlanState('npc:airi'), { actorId: world.agent.epoch.actor_id, epoch: world.agent.epoch.epoch })
  assert.match(debug.time_estimate, /^step 1: ~13\.0 min hand mining on the NPC lane · running 22\.0 min · OVERRUN · walking excluded$/)
  assert.equal(debug.step_time_index, 0)
  assert.match(debug.step_time_caption, /^~13\.0 min · NPC lane · long, one lane · idle \d+%$/)

  await world.agent.completed()
  const call = world.calls.at(-1)
  assert.equal(call.round.id, 'continue_step_1')
  const block = call.messages.find(message => typeof message.content === 'string' && message.content.startsWith('[TIME_ESTIMATE]'))
  assert.ok(block, 'the continuation carries the time estimate')
  assert.match(block.content, /Active step 1: about 13\.0 min of serial hand mining on the NPC's own lane/)
  assert.match(block.content, /Running for 22\.0 min \(1\.69x the estimate\)/)
  assert.match(block.content, new RegExp(`Overrun: elapsed is above ${OVERRUN_FACTOR}x the estimate`))
  assert.match(block.content, /estimateProductionTime/)
  const overrun = world.events('step.time_overrun')
  assert.equal(overrun.length, 1)
  assert.equal(overrun[0].data.ratio, 1.69)

  // The second batch of the same step adds to the step estimate; the step is
  // not reviewed a second time.
  const estimates = world.events('plan.time_estimate')
  assert.equal(estimates.length, 2)
  assert.equal(estimates[1].data.step_expected_seconds, 800)
  assert.equal(estimates[1].data.review, 'answered')
  assert.equal(world.events('plan.time_review_requested').length, 1)
})

test('each request ends with its think / actor-busy / idle split, before the terminal event', () => {
  let clock = 0
  const timing = new PlanTiming({ now: () => clock })
  const seen = []
  const run = (event, data = {}) => {
    const { before, after } = timing.observe(event, data, { requestId: 'req_1' })
    seen.push(...before.map(([name, payload]) => [name, payload]), [event, data], ...after)
  }
  run('request.received')
  clock = 20_000
  run('provider.response', { latency_ms: 20_000 })
  clock = 21_000
  run('operations.ack', { operations: [] })
  clock = 801_000
  run('factorio.completed_signal')
  clock = 811_000
  run('provider.response', { latency_ms: 9_000 })
  clock = 812_000
  run('request.completed', { outcome: 'no_operations' })
  const split = seen.find(([name]) => name === 'request.time_split')
  assert.deepEqual(seen.map(([name]) => name).slice(-2), ['request.time_split', 'request.completed'])
  assert.equal(split[1].wall_ms, 812_000)
  assert.equal(split[1].think_ms, 29_000)
  assert.equal(split[1].actor_busy_ms, 780_000)
  assert.equal(split[1].idle_ms, 3_000)
  assert.equal(split[1].walking, 'inside_actor_busy')
  assert.equal(split[1].outcome, 'no_operations')
})

test('the Debug window and the task board step show the estimate', () => {
  const time = {
    time_estimate: 'step 1: ~13.0 min hand mining on the NPC lane · running 4.0 min · walking excluded',
    time_split: 'think 4.0 min · actor busy 4.0 min · idle 6 s (1%)',
    step_time_index: 0,
    step_time_caption: '~13.0 min · NPC lane · long, one lane · idle 1%',
  }
  const debug = liveAgentDebugEvent('provider.response', { latency_ms: 10 }, {}, { time })
  assert.equal(debug.time_estimate, time.time_estimate)
  assert.equal(debug.time_split, time.time_split)
  assert.equal(debug.step_time_step, 1)
  const state = {
    goal_id: 'goal_1',
    status: 'active',
    objective: 'steam power',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_1',
      status: 'active',
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      steps: [{ id: 'step_1', description: 'Hand-mine', status: 'active' }, { id: 'step_2', description: 'Smelt', status: 'pending' }],
    },
  }
  const snapshot = taskBoardUiSnapshot(state, { phase: 'executing', debug }, undefined)
  assert.equal(snapshot.steps[0].time, time.step_time_caption)
  assert.equal(snapshot.steps[1].time, undefined)
})
