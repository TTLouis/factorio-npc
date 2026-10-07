import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AgentContext } from './agent-context.mjs'
import { EXECUTOR_ROLE_PROMPT, roleSystemPrompt } from './agent-roles.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { isBareContinuation, NpcAgentLoop, restatedPlanVerdict } from './npc-agent-loop.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, getContextRestages, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { configuration, liveAgentEvent, RUNTIME_RELIABILITY_GUIDANCE, recoverInterruptedAgentPlan, Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

// Delegation U6: the executor. A committed plan slice is executed by a FRESH executor
// conversation (C3) built from a handoff packet plus the executor role suffix; the planner
// conversation is parked, never sees the executor's traffic, and comes back at the slice close.
// Static scenarios: a fake Factorio and scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const REQUEST_TEXT = 'get steam power going and run an electric mining drill on iron ore'
const GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const TWO_STEPS = ['Gather 10 iron ore', 'Gather 10 copper ore']
const EXECUTOR_MARKER_RADIUS = 17 // only the executor's observation asks for this radius

// The planner's first slice: a two-step plan, step 1 closes on the game's inventory.
const plannerSlice = (overrides = {}) => planReply({
  plan: TWO_STEPS,
  currentStep: 0,
  operations: [gather('iron-ore', 10)],
  checkpoint: inventoryCheckpoint('iron-ore', 10),
  goal: GOAL,
  roadmap: SHELF,
  ...overrides,
})
// A second slice authored by the planner after the first closed (one step, no goal/roadmap: those stand).
const plannerNextSlice = () => planReply({
  plan: ['Gather 10 coal'],
  currentStep: 0,
  operations: [gather('coal', 10)],
  checkpoint: inventoryCheckpoint('coal', 10),
})
const observation = (radius = EXECUTOR_MARKER_RADIUS) => ({
  tool_calls: [{ id: `call_exec_${radius}`, index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius }) } }],
})
const executorStep = (overrides = {}) => planReply({ plan: TWO_STEPS, currentStep: 1, operations: [gather('copper-ore', 10)], ...overrides })
const executorClaim = boardStepId => planReply({
  chatMessage: 'Step done.',
  plan: [],
  currentStep: 0,
  operations: [],
  semanticCompletion: { stepId: boardStepId(), rationale: 'The completed gather batch grounds this prose-only step.' },
})

function usageOf(promptTokens) {
  return { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: promptTokens, completion_tokens: 450, total_tokens: promptTokens + 450 } }
}

// The real loop against a fake Factorio. `script[n]` answers provider call n+1: a reply or a function
// (messages, context, world) returning one. `tokens(call, context)` is the prompt-token usage each reply reports.
function harness({ script, models, tokens, agentOptions = {}, connectedPlayers, game: sharedGame, systemPrompt = 'executor wiring test system prompt' } = {}) {
  const game = sharedGame ?? new FakeFactorio()
  if (connectedPlayers !== undefined) game.status = { ...game.status, connected_players: connectedPlayers }
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [], script }
  const inner = async (messages, context) => {
    world.calls.push({ messages: messages.map(message => ({ ...message })), context })
    const call = world.calls.length
    const reply = script[call - 1]
    assert.ok(reply, `unscripted provider call ${call}`)
    const message = typeof reply === 'function' ? await reply(messages, context, world) : { ...reply }
    const promptTokens = tokens?.(call, context)
    if (promptTokens !== undefined && message && typeof message === 'object') Object.defineProperty(message, '_sglunaProvider', { enumerable: false, value: usageOf(promptTokens) })
    return message
  }
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: models ? models.provider(inner) : inner,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt,
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...(models ? { agentRoleConfig: models.config } : {}),
    ...agentOptions,
  })
  world.agent.behaviorTrace = { emit: async (record) => { world.trace.push(record) } }
  world.rows = event => world.trace.filter(record => record.event === event)
  world.say = () => world.agent.request(REQUEST_TEXT, { sender: 'TTLouis' })
  world.boardStepId = () => memory.currentPlan(KEY)?.task_board?.active_step_id
  world.give = (item, count = 10) => { game.inventory[item] = (game.inventory[item] ?? 0) + count }
  world.plan = () => getActivePlan(memory.planningState(KEY))
  return world
}

// Two models resolve by role through the real Session.roleProvider (agent-roles.mjs).
function roleModels(env) {
  const config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: `fixture-key-${'x'.repeat(20)}`, OPENAI_API_BASEURL: 'https://provider.example.test/v1', ...env })
  const requests = []
  return {
    config,
    requests,
    provider: inner => async (messages, context) => {
      const session = new Session({
        root: '/tmp/sgluna-test', app: '/tmp/app', game: '/tmp/game', config, save: 'x', settingsFile: 'x', modDir: 'x', ini: 'x', log: () => {},
        provider: async (request, sentMessages, sentContext) => {
          requests.push({ model: request.model, context: sentContext })
          return inner(sentMessages, sentContext)
        },
      })
      return session.roleProvider(messages, context)
    },
  }
}

const textOf = message => (typeof message?.content === 'string' ? message.content : '')
const stableBlock = messages => messages.find(message => textOf(message).startsWith('[HANDOFF]'))
const stepBlock = messages => messages.find(message => textOf(message).startsWith('--- step block ---'))

// The whole first slice: the planner commits, step 1 closes on the game, the executor observes and submits
// step 2, step 2's batch completes, and the executor claims the final step, which closes the slice and wakes
// the planner (call 5), which authors the next slice (committed, so a second executor starts).
async function runSlice(world) {
  await world.say() // call 1 (planner): plan committed, step 1 admitted, the executor takes over
  world.give('iron-ore')
  await world.agent.completed() // step 1 verified -> the executor (calls 2 and 3): observe, then step 2
  world.give('copper-ore')
  await world.agent.completed() // step 2's batch done; the executor claims the final step (call 4) -> slice close -> planner (call 5)
}

function twoModelSlice({ models, connectedPlayers, tokens, agentOptions } = {}) {
  const script = [
    plannerSlice(),
    observation(),
    executorStep(),
    (_messages, _context, world) => executorClaim(() => world.boardStepId()),
    plannerNextSlice(),
  ]
  return harness({ script, models, connectedPlayers, tokens, agentOptions })
}

// --- C3: the executor at the plan commit -----------------------------------------------------------------

test('C3: the commit hands the slice to a fresh executor built from the packet plus the role suffix, on the executor model, and the planner receives none of its traffic', async () => {
  const models = roleModels({ OPENAI_MODEL: 'planner-model, executor-model' })
  const world = twoModelSlice({ models })
  await runSlice(world)

  assert.equal(world.calls.length, 5, 'planner, executor x3, planner')
  const [plannerCall, observeCall, , , wakeCall] = world.calls
  assert.deepEqual(models.requests.map(request => request.model), ['planner-model', 'executor-model', 'executor-model', 'executor-model', 'planner-model'])
  assert.deepEqual(models.requests.map(request => request.context.role), ['planner', 'executor', 'executor', 'executor', 'planner'])

  // The executor's first request: system + role suffix, the packet's two blocks, and nothing of the planner's conversation.
  const systemMessage = observeCall.messages[0]
  assert.equal(systemMessage.role, 'system')
  assert.equal(textOf(systemMessage), roleSystemPrompt(textOf(plannerCall.messages[0]), 'executor'))
  assert.ok(textOf(systemMessage).endsWith(EXECUTOR_ROLE_PROMPT))
  assert.match(textOf(systemMessage), /execute the committed ACTIVE step only/i)
  assert.match(textOf(systemMessage), /do not author or revise the plan/i)
  const stable = stableBlock(observeCall.messages)
  const step = stepBlock(observeCall.messages)
  assert.ok(stable && step, 'the C3 packet: plan block, then step block')
  assert.match(textOf(step), /^restage: role=executor checkpoint=C3 reason=executor_fresh_at_plan_commit$/m)
  assert.match(textOf(stable), /^step 1: .*Gather 10 iron ore$/m, 'the immutable plan')
  assert.match(textOf(stable), /^step 2: .*Gather 10 copper ore$/m)
  assert.match(textOf(step), /^plan_status: EXECUTING; steps 1:completed 2:active$/m, 'the receipt closed the first step before this continuation')
  assert.match(textOf(step), /^active_step: 2 of 2 .*Gather 10 copper ore/m, 'the packet carries the current committed step')
  assert.doesNotMatch(textOf(step), /^active_step_contract:.*iron-ore/m, 'the previous step contract no longer claims to be active')
  assert.match(textOf(step), /^actor: actor_id=18 actor_kind=standalone_character epoch=3 connected_players=1$/m)
  const plannerOnly = message => textOf(message).startsWith('[CHAT]') || (message.role === 'assistant' && textOf(message).includes('"goal"'))
  assert.equal(observeCall.messages.filter(plannerOnly).length, 0, 'none of the planner earlier messages')
  assert.equal(observeCall.messages.filter(message => message.role === 'assistant').length, 0)

  // Slice close: control returns to the planner, which never saw the executor's traffic.
  const wakeMessages = wakeCall.messages
  assert.equal(textOf(wakeMessages[0]), textOf(plannerCall.messages[0]), 'the planner system prefix, without the executor suffix')
  assert.ok(wakeMessages.some(message => textOf(message).startsWith('[CHAT]')), 'the planner conversation, restored')
  const executorTraffic = wakeMessages.filter(message => JSON.stringify(message).includes(`"radius":${EXECUTOR_MARKER_RADIUS}`)
    || JSON.stringify(message).includes(`call_exec_${EXECUTOR_MARKER_RADIUS}`)
    || message.role === 'tool'
    || textOf(message).startsWith('[HANDOFF]')
    || textOf(message).startsWith('--- step block ---'))
  assert.deepEqual(executorTraffic, [], 'no executor tool call, tool result or packet in the planner conversation')
  const mod = wakeMessages.find(message => textOf(message).startsWith('[MOD] The current immutable plan slice is verified complete'))
  assert.ok(mod, 'the slice-close wake')
  assert.match(textOf(mod), /\[VERIFIED_RESULTS\]/, 'with the harness-built verified results')
  assert.match(textOf(mod), /plan \S+ v1 is COMPLETED; 2\/2 steps verified by the harness/)

  // The trace names every hand-over, with the request id.
  const requestId = world.rows('request.received')[0].request_id
  const restaged = world.rows('context.restaged')
  assert.equal(restaged[0].data.role, 'executor')
  assert.equal(restaged[0].data.checkpoint, 'C3')
  assert.equal(restaged[0].data.reason, 'executor_fresh_at_plan_commit')
  assert.equal(restaged[0].request_id, requestId)
  const [parked] = world.rows('context.planner_parked')
  assert.equal(parked.request_id, requestId)
  assert.equal(parked.data.request_id, requestId)
  assert.equal(parked.data.role, 'planner')
  assert.equal(parked.data.executor_handoff_id, restaged[0].data.handoff_id)
  const [resumed] = world.rows('context.planner_resumed')
  assert.equal(resumed.request_id, requestId)
  assert.equal(resumed.data.request_id, requestId)
  assert.equal(resumed.data.role, 'planner')
  assert.equal(resumed.data.handoff_id, parked.data.handoff_id, 'the same planner conversation comes back')
  assert.equal(resumed.data.from_role, 'executor')
  assert.equal(resumed.data.from_handoff_id, restaged[0].data.handoff_id)
  assert.equal(resumed.data.reason, 'slice_close')
  assert.equal(resumed.data.route, 'next_shelf_slice')

  // The executor's rounds are attributed to it; the planner's to it.
  const requestRows = world.rows('provider.request')
  assert.deepEqual(requestRows.map(row => row.data.role), [undefined, 'executor', 'executor', 'executor', 'planner'])
  assert.deepEqual(requestRows.slice(1, 4).map(row => row.data.handoff_id), Array(3).fill(restaged[0].data.handoff_id))
  assert.equal(requestRows[4].data.handoff_id, parked.data.handoff_id)
  assert.equal(analyzeBehaviorTrace(world.trace).findings.filter(finding => ['restage_loop', 'restage_packet_oversize', 'stale_reply_not_dropped'].includes(finding.signature)).length, 0)
})

test('one model in OPENAI_MODEL: both roles resolve to it, and the executor is still its own conversation with role executor', async () => {
  const models = roleModels({ OPENAI_MODEL: 'flash-model' })
  const world = twoModelSlice({ models })
  await runSlice(world)

  assert.deepEqual([...new Set(models.requests.map(request => request.model))], ['flash-model'], 'every round runs on the single model')
  const [plannerCall, observeCall, , , wakeCall] = world.calls
  // Once delegation is active the role is named on the provider call (the U4 rule), so the executor rounds carry it.
  assert.deepEqual(models.requests.map(request => request.context.role), [undefined, 'executor', 'executor', 'executor', 'planner'])
  assert.equal(textOf(observeCall.messages[0]), roleSystemPrompt(textOf(plannerCall.messages[0]), 'executor'), 'a separate context: its own system suffix and packet')
  assert.ok(stableBlock(observeCall.messages))
  assert.equal(observeCall.messages.some(message => textOf(message).startsWith('[CHAT]')), false)
  assert.equal(textOf(wakeCall.messages[0]), textOf(plannerCall.messages[0]))
  assert.notEqual(world.rows('context.restaged')[0].data.handoff_id, world.rows('context.planner_parked')[0].data.handoff_id, 'two conversations, two handoff ids')
})

test('zero connected humans is a valid operating state for the whole delegated slice', async () => {
  const world = twoModelSlice({ connectedPlayers: 0 })
  await runSlice(world)
  assert.equal(world.calls.length, 5)
  assert.match(textOf(stepBlock(world.calls[1].messages)), /^actor: actor_id=18 actor_kind=standalone_character epoch=3 connected_players=0$/m)
  assert.equal(world.rows('context.planner_resumed').length, 1)
  assert.equal(world.game.mutations.length, 3, 'both steps of slice 1 and the first step of slice 2 admitted with nobody connected')
})

test('the plan block of the packet is byte-identical across the executor rounds of one slice, and the planner acts again afterwards', async () => {
  const world = twoModelSlice({})
  await runSlice(world)
  const first = world.calls[1].messages
  const later = world.calls[3].messages // the same executor conversation, after step 1 closed
  assert.equal(textOf(stableBlock(first)), textOf(stableBlock(later)))
  const state = world.memory.planningState(KEY)
  const c3 = getContextRestages(state).filter(item => item.role === 'executor' && item.checkpoint === 'C3')
  assert.equal(c3.length, 2, 'one executor per committed slice')
  assert.equal(state.plans.find(item => item.plan_id === c3[0].plan_id).status, PLAN_STATUS.COMPLETED, 'the first slice is closed')
  assert.equal(world.plan().plan_id, c3[1].plan_id, 'the planner committed the next slice, which has its own executor')
  assert.notEqual(c3[0].handoff_id, c3[1].handoff_id)
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.rows('context.planner_resumed').length, 1)
  assert.equal(world.rows('context.planner_parked').length, 2, 'the planner is parked again for the second slice')
})

// --- the plan contract of the executor ---------------------------------------------------------------------

test('an executor submitPlan with changed steps, goal and roadmap leaves the committed plan and the Plan Tracker unchanged, and is traced', async () => {
  const world = harness({
    script: [
      plannerSlice(),
      () => planReply({
        chatMessage: 'I rewrote the plan.',
        plan: ['Build a whole factory', 'Launch a rocket'],
        currentStep: 1,
        operations: [gather('iron-ore', 4)],
        goal: { scope: 'finite', summary: 'Something else.', doneWhen: [{ id: 'x', kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] },
        roadmap: [{ id: 'n_other', intent: 'a different shelf' }],
        developmentMode: 'horizontal',
      }),
    ],
  })
  await world.say()
  const before = world.memory.planningState(KEY)
  const planBefore = getActivePlan(before)
  const trackerBefore = JSON.stringify({ ...world.memory.planningTrackerView(KEY), advisory_planner_focus_step_id: undefined })
  const mutationsBefore = world.game.mutations.length
  const executorHandoff = world.agent.agentContext.handoffId

  world.give('iron-ore', 2) // not enough for the contract: the step stays open and the executor is asked again
  await world.agent.completed()

  const after = world.memory.planningState(KEY)
  const planAfter = getActivePlan(after)
  assert.equal(planAfter.plan_id, planBefore.plan_id)
  assert.equal(planAfter.plan_version, planBefore.plan_version)
  assert.deepEqual(planAfter.steps, planBefore.steps, 'the committed steps and their order')
  assert.equal(planAfter.active_step_index, planBefore.active_step_index)
  const withoutFocus = view => JSON.stringify({ ...view, advisory_planner_focus_step_id: undefined })
  assert.equal(withoutFocus(world.memory.planningTrackerView(KEY)), trackerBefore, 'the Plan Tracker')
  assert.ok([null, planBefore.steps[0].step_id].includes(world.memory.planningTrackerView(KEY).advisory_planner_focus_step_id), 'the advisory focus (recorded, never acted on) stays on the committed active step')
  assert.deepEqual(after.goal.definition, before.goal.definition, 'scope and doneWhen')
  assert.deepEqual(after.roadmap, before.roadmap, 'the roadmap shelf')
  assert.equal(after.steering?.current_mode, before.steering?.current_mode)
  assert.equal(world.game.mutations.length, mutationsBefore + 1, 'the operations for the committed step still went through admission')

  const [ignored] = world.rows('executor.plan_semantics_ignored')
  assert.ok(ignored, 'executor.plan_semantics_ignored was written')
  assert.equal(ignored.request_id, world.rows('request.received')[0].request_id)
  assert.equal(ignored.data.request_id, ignored.request_id)
  assert.equal(ignored.data.role, 'executor')
  assert.equal(ignored.data.handoff_id, executorHandoff)
  assert.equal(ignored.data.plan_id, planBefore.plan_id)
  assert.match(ignored.data.reason, /steps_changed/)
  assert.match(ignored.data.reason, /goal_definition_changed/)
  assert.match(ignored.data.reason, /roadmap_is_planner_authority/)
  assert.match(ignored.data.reason, /development_mode_is_planner_authority/)
  assert.deepEqual(ignored.data.ignored_fields, ['plan', 'goal', 'roadmap', 'developmentMode'])
})

test('an executor that restates the committed plan, or only the remaining steps, is not flagged; a reorder is', async () => {
  assert.equal(restatedPlanVerdict(['a', 'b', 'c'], ['a', 'b', 'c']), 'unchanged')
  assert.equal(restatedPlanVerdict(['b', 'c'], ['a', 'b', 'c']), 'unchanged', 'a restated suffix')
  assert.equal(restatedPlanVerdict(['c', 'a'], ['a', 'b', 'c']), 'order_changed')
  assert.equal(restatedPlanVerdict(['a', 'x'], ['a', 'b', 'c']), 'steps_changed')
  assert.equal(restatedPlanVerdict(['a', 'b', 'c', 'd'], ['a', 'b', 'c']), 'steps_changed')

  const world = harness({ script: [plannerSlice(), () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] })] })
  await world.say()
  world.give('iron-ore', 2)
  await world.agent.completed()
  assert.equal(world.rows('executor.plan_semantics_ignored').length, 0, 'the restated committed plan changes nothing and says nothing')
})

test('the planner own submitPlan is untouched by the executor contract: the first slice carries the goal and the shelf', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const state = world.memory.planningState(KEY)
  assert.equal(state.goal.definition.scope, 'long_horizon')
  assert.equal(state.roadmap.nodes.length, 2)
  assert.equal(world.rows('executor.plan_semantics_ignored').length, 0)
})

// --- the executor's hard-limit restage at a step close (C8) ------------------------------------------------

function deferred() {
  const gate = {}
  gate.promise = new Promise((resolve, reject) => {
    gate.resolve = resolve
    gate.reject = reject
  })
  return gate
}

// An executor round reports `executorTokens` of prompt while the step is still open; step 1 then closes on the game.
function hardLimitWorld({ executorTokens, softLimit = { planner: 1_000_000, executor: 3500 }, systemPrompt }) {
  const world = harness({
    ...(systemPrompt ? { systemPrompt } : {}),
    script: [
      plannerSlice(),
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }), // the executor, step 1 still open
      () => executorStep(), // the executor after step 1 closed
      (_messages, _context, self) => executorClaim(() => self.boardStepId()),
      () => plannerNextSlice(),
    ],
    tokens: (call, context) => (context.role === 'executor' ? (typeof executorTokens === 'function' ? executorTokens(call, world) : executorTokens) : 1000),
    agentOptions: softLimit ? { restageSoftLimitTokens: softLimit } : {},
  })
  world.run = async () => {
    await world.say()
    world.give('iron-ore', 2) // the contract wants 10: the step stays open, the executor is asked (call 2)
    await world.agent.completed()
    world.give('iron-ore', 8) // now 10: step 1 verified inside the slice
    await world.agent.completed() // the step close (C8 when past the hard limit), then the executor's next round (call 3)
    world.give('copper-ore')
    await world.agent.completed() // step 2's batch done: the executor claims the final step (call 4) -> slice close -> planner (call 5)
  }
  return world
}

test('C8: past the hard limit (2x soft) an executor is restaged fresh at the next STEP close, with a byte-identical plan block, and not again at the slice close', async () => {
  const world = hardLimitWorld({ executorTokens: 8000 }) // soft 3500, hard 7000
  await world.run()

  const rows = world.rows('context.restaged')
  assert.deepEqual(rows.map(row => `${row.data.role}:${row.data.checkpoint}`), ['executor:C3', 'executor:C8', 'executor:C3'], 'C3, C8 at the step close, and the next slice\'s C3; no restage at the slice close')
  const c8 = rows[1]
  assert.equal(c8.data.reason, 'context_over_hard_limit_at_step_close')
  assert.equal(c8.data.soft_limit_tokens, 3500)
  assert.equal(c8.request_id, world.rows('request.received')[0].request_id)
  assert.notEqual(c8.data.handoff_id, rows[0].data.handoff_id)
  const decisions = world.rows('context.step_close_decision')
  assert.equal(decisions[0].data.restage, true)
  assert.equal(decisions[0].data.checkpoint, 'C8')
  assert.equal(decisions[0].data.size_tokens, 8000, 'the provider-reported prompt tokens of the executor round')
  assert.equal(decisions[0].data.hard_limit_tokens, 7000)
  assert.equal(decisions[0].data.closed_steps, 1)
  assert.equal(decisions[0].request_id, decisions[0].data.request_id)

  // The executor request after the C8 restage holds only the fresh packet: same system prefix, byte-identical plan block, new step block.
  const before = world.calls[1].messages // executor round before the close
  const after = world.calls[2].messages // executor round after the C8 restage
  assert.equal(textOf(after[0]), textOf(before[0]))
  assert.equal(textOf(stableBlock(after)), textOf(stableBlock(before)), 'the plan-level block is the cache prefix and does not move')
  assert.notEqual(textOf(stepBlock(after)), textOf(stepBlock(before)))
  assert.match(textOf(stepBlock(after)), /^restage: role=executor checkpoint=C8 reason=context_over_hard_limit_at_step_close$/m)
  assert.match(textOf(stepBlock(after)), /^plan_status: EXECUTING; steps 1:completed 2:active$/m, 'the closed step is in the packet')
  assert.equal(after.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'none of the earlier executor exchanges')
  assert.equal(after.some(message => textOf(message).startsWith('[CHAT]')), false)
  // The plan and tracker did not move because of the restage.
  const state = world.memory.planningState(KEY)
  assert.equal(getContextRestages(state).filter(item => item.checkpoint === 'C8').length, 1)
  assert.equal(world.rows('context.planner_resumed').length, 1, 'and the planner still came back at the slice close')
  assert.equal(world.rows('context.restaged').some(row => row.data.checkpoint === 'C1'), false)
})

test('C8: below the hard limit there is no restage at a step close, however far past the soft limit', async () => {
  const world = hardLimitWorld({ executorTokens: 4500, softLimit: { planner: 1_000_000, executor: 4000 } }) // the receipt-refreshed packet stays below hard 8000
  await world.run()

  assert.deepEqual(world.rows('context.restaged').map(row => `${row.data.role}:${row.data.checkpoint}`), ['executor:C3', 'executor:C3'], 'only the two plan commits')
  const [decision] = world.rows('context.step_close_decision')
  assert.equal(decision.data.restage, false)
  assert.equal(decision.data.reason, 'no_restage_needed')
  assert.ok(decision.data.size_tokens > 4000 && decision.data.size_tokens <= 8000, `past soft, not past hard: ${decision.data.size_tokens}`)
  assert.equal(decision.data.soft_limit_tokens, 4000)
  // One conversation carried the slice: the executor round after the close still holds its own earlier exchange.
  assert.equal(world.calls[2].messages.some(message => textOf(message).startsWith('[MOD] Autorio operation batch completed')), true)
  assert.equal(textOf(stepBlock(world.calls[2].messages)), '', 'the closed step block is superseded without restaging')
  assert.ok(world.calls[2].messages.some(message => textOf(message).includes('[PLANNING_STATE]')))
  const superseded = world.rows('context.handoff_step_superseded').at(-1)
  assert.equal(superseded.data.reason, 'current_planning_state_replaces_old_handoff_step')
  assert.ok(superseded.data.request_id)
  assert.equal(world.rows('context.planner_resumed').length, 1)
})

// The default limits with the REAL system prompt (prompt.md + the runtime guidance), where the size logic matters.
const REAL_PROMPT_FILE = fileURLToPath(new URL('../../../packages/agent/src/llm/prompt.md', import.meta.url))
const realSystemPrompt = async () => `${await fsp.readFile(REAL_PROMPT_FILE, 'utf8')}

${RUNTIME_RELIABILITY_GUIDANCE}`

test('C8 with the real system prompt and the default limits: a normal executor slice is never restaged, one past twice its prefix-aware soft limit is restaged at the step close', async () => {
  const systemPrompt = await realSystemPrompt()
  const prefix = Math.ceil(systemPrompt.length / 4)
  // Reported prompt tokens: the real prefix, about 8k tokens of tool schemas the loop does not see, and the growth.
  const normal = hardLimitWorld({ systemPrompt, softLimit: null, executorTokens: () => prefix + 8000 + 3000 })
  await normal.run()
  const soft = normal.agent.restageSoftLimitTokens('executor')
  assert.ok(soft > prefix + 8000, `the default soft limit is prefix-aware (${soft} tokens for a ${prefix}-token prompt)`)
  assert.deepEqual(normal.rows('context.restaged').map(row => row.data.checkpoint), ['C3', 'C3'], 'a normal slice: only the plan commits')
  assert.equal(normal.rows('context.step_close_decision')[0].data.restage, false)
  assert.equal(normal.rows('context.step_close_decision')[0].data.hard_limit_tokens, 2 * soft)

  const heavy = hardLimitWorld({ systemPrompt, softLimit: null, executorTokens: (_call, world) => 2 * world.agent.restageSoftLimitTokens('executor') + 2000 })
  await heavy.run()
  assert.deepEqual(heavy.rows('context.restaged').map(row => row.data.checkpoint), ['C3', 'C8', 'C3'])
  assert.equal(heavy.rows('context.restaged')[1].data.reason, 'context_over_hard_limit_at_step_close')
  assert.equal(heavy.rows('context.step_close_decision')[0].data.size_tokens, 2 * soft + 2000)
})

// --- one conversation acts at a time -------------------------------------------------------------------------

test('a late reply from the dropped executor after the slice closed is dropped and traced; nothing of it is admitted and the planner conversation is intact', async () => {
  const gate = deferred()
  const STALE = 'STALE-EXECUTOR-REPLY'
  const world = harness({
    script: [
      plannerSlice(),
      () => gate.promise, // the executor's round, in flight
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }), // the re-drive on the conversation now in place
    ],
  })
  await world.say()
  world.give('iron-ore', 2)
  const pending = world.agent.completed() // continuation -> the executor round (call 2), held
  for (let spin = 0; spin < 500 && world.calls.length < 2; spin++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(world.calls.length, 2)
  const { agentContext } = world.agent
  const executorHandoff = agentContext.handoffId
  const plannerHandoff = agentContext.parkedPlanner.handoffId
  const mutationsBefore = world.game.mutations.length

  // The slice closes while that round is out (the unguarded path a race would take): control returns to the planner.
  agentContext.resumePlanner()
  gate.resolve(planReply({ chatMessage: STALE, plan: TWO_STEPS, currentStep: 0, operations: [gather('coal', 99)] }))
  await pending

  const [dropped] = world.rows('context.stale_reply_dropped')
  assert.ok(dropped, 'the drop is traced')
  assert.equal(dropped.request_id, world.rows('request.received')[0].request_id)
  assert.deepEqual(dropped.data, { role: 'executor', handoff_id: executorHandoff, active_handoff_id: plannerHandoff, reason: 'handoff_superseded' })
  assert.ok(!world.game.mutations.slice(mutationsBefore).some(text => text.includes('coal')), 'the stale reply reached no admission')
  assert.equal(world.game.mutations.length, mutationsBefore + 1, 'only the re-driven reply was admitted')
  assert.ok(!JSON.stringify(world.agent.messages).includes(STALE), 'and it is not in the conversation that acts')
  assert.equal(world.agent.agentContext.role, 'planner')
  assert.equal(world.calls[2].messages.some(message => textOf(message).startsWith('[HANDOFF]')), false, 'the re-drive read the planner conversation, not the executor packet')
  assert.equal(world.rows('context.stale_reply_redriven').length, 1)
  const staleResponse = world.rows('provider.response')[1]
  assert.equal(staleResponse.data.handoff_id, executorHandoff, 'the stale response row is attributed so the drop can be paired')
  assert.equal(staleResponse.data.role, 'executor')
  assert.equal(analyzeBehaviorTrace(world.trace).findings.filter(finding => finding.signature === 'stale_reply_not_dropped').length, 0)
})

test('the return to the planner is refused while a round is in flight: the wake proceeds on the conversation it has and traces why', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  assert.equal(world.agent.agentContext.role, 'executor')
  world.agent.providerCallsByGeneration.set(world.agent.generation, 1) // a round of the current generation is open
  const result = await world.agent.returnControlToPlanner({ route: 'next_shelf_slice', planningState: world.memory.planningState(KEY) })
  world.agent.providerCallsByGeneration.delete(world.agent.generation)
  assert.deepEqual(result, { returned: false, reason: 'round_in_flight' })
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.agent.agentContext.hasParkedPlanner, true)
  const [refused] = world.rows('context.planner_resume_refused')
  assert.equal(refused.data.reason, 'round_in_flight')
  assert.equal(refused.data.request_id, refused.request_id)
  assert.ok(refused.request_id)
})

// --- C6: ordinary bounded recovery is executor-shaped --------------------------------------------------------

test('C6: bounded recovery keeps the committed step with a fresh executor context from a packet: no user interruption, the plan and the parked planner untouched', async () => {
  const recoveryJev = recordingJev(async (state, questions) => {
    if (questions.recovery_semantics) {
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          recovery_semantics: { type: 'choice', choice: 'semantic_replan', confidence: 0.95 },
          one_observation_can_resolve: { type: 'noul', noul: 0.1 },
        },
        usage: { input_tokens: 60, output_tokens: 6, cost: 0 },
      }
    }
    return undefined
  })
  const world = harness({
    script: [
      plannerSlice(),
      () => observation(), // executor work before the failure: it must not survive the C6 restage
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }),
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }), // the recovery round
    ],
    agentOptions: { interactionDecisionProvider: recoveryJev, steeringDecisionProvider: recoveryJev },
  })
  await world.say()
  world.give('iron-ore', 2)
  await world.agent.completed() // calls 2 and 3: the executor observes, then resubmits step 1
  assert.equal(world.calls.length, 3)
  assert.ok(world.agent.messages.some(message => message.role === 'tool'), 'the executor conversation holds an earlier exchange')
  const before = world.memory.planningState(KEY)
  const planBefore = getActivePlan(before)
  const c3Stable = textOf(world.agent.baseMessages[1])
  const plannerHandoff = world.agent.agentContext.parkedPlanner.handoffId
  const c3Handoff = world.agent.agentContext.handoffId

  // A failure the recovery router hands to a planner-class wake (Jev: semantic replan): a bounded recovery of the committed step.
  const result = await world.agent.recoverPlan(world.agent.generation, new Error('strategy invalidated by fresh evidence'), 1)

  assert.equal(result.goalStatus, 'active', 'no pause, no question to the user')
  const [row] = world.rows('context.restaged').filter(item => item.data.checkpoint === 'C6')
  assert.ok(row, 'a C6 restage')
  assert.equal(row.data.role, 'executor')
  assert.match(row.data.reason, /^bounded_recovery route=wake_planner cause=strategy invalidated by fresh evidence$/)
  assert.equal(row.request_id, world.rows('request.received')[0].request_id)
  assert.notEqual(row.data.handoff_id, c3Handoff)
  const call = world.calls.at(-1)
  assert.equal(call.context.role, 'executor')
  assert.equal(textOf(call.messages[0]), roleSystemPrompt(textOf(world.calls[0].messages[0]), 'executor'))
  assert.equal(textOf(stableBlock(call.messages)), c3Stable, 'the plan block is the same as the C3 executor had')
  assert.match(textOf(stepBlock(call.messages)), /^restage: role=executor checkpoint=C6 reason=bounded_recovery route=wake_planner/m)
  assert.ok(call.messages.some(message => textOf(message).startsWith('[RECOVERY_ROUTE] Jev selected wake_planner')), 'the recovery instruction follows the packet')
  assert.equal(call.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'none of the earlier executor exchanges')
  const planAfter = getActivePlan(world.memory.planningState(KEY))
  assert.deepEqual(planAfter.steps, planBefore.steps)
  assert.equal(planAfter.plan_id, planBefore.plan_id)
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.agent.agentContext.parkedPlanner.handoffId, plannerHandoff, 'the planner conversation is still parked, untouched')
  assert.equal(world.rows('request.completed').filter(item => item.data.outcome === 'asked_user').length, 0)
})

test('C6: a recovery that is still authoring the first plan stays on the planner conversation (nothing is committed for an executor to carry)', async () => {
  const recoveryJev = recordingJev(async (_state, questions) => (questions.recovery_semantics
    ? { model: 'jev-latest', provider: 'TypeSafe', answers: { recovery_semantics: { type: 'choice', choice: 'semantic_replan', confidence: 0.95 }, one_observation_can_resolve: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }
    : undefined))
  const world = harness({
    script: [
      () => { throw Object.assign(new Error('Provider HTTP 400 nonsense'), { code: 'x' }) },
    ],
    agentOptions: { interactionDecisionProvider: recoveryJev, steeringDecisionProvider: recoveryJev },
  })
  await assert.rejects(world.say())
  assert.equal(world.rows('context.restaged').length, 0)
  assert.equal(world.agent.agentContext.role, 'planner')
})

// --- C7: restart with an active plan restages as the executor, with the new epoch --------------------------

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sgluna-exec-')), 'state.json')
}

test('C7: a restart with an active plan restages as the EXECUTOR with the new epoch; the slice close then builds a FRESH planner from a packet (no parked context survived)', async () => {
  const file = stateFile()
  const game = new FakeFactorio()
  const oneStepSlice = () => plannerSlice({ plan: ['Gather 10 iron ore'], roadmap: SHELF })
  const first = harness({ game, script: [oneStepSlice()], agentOptions: { stateFile: file } })
  await first.say()
  await first.agent.persistQueue

  game.status = { ...game.status, epoch: 4 } // the server came back under a new epoch
  const second = harness({
    game,
    script: [
      () => planReply({ plan: ['Gather 10 iron ore'], currentStep: 0, operations: [gather('iron-ore', 10)] }), // the recovered executor
      () => plannerNextSlice(), // the planner built at the slice close
    ],
    agentOptions: { stateFile: file },
  })
  await second.agent.loadPersistentState()
  const recovery = await recoverInterruptedAgentPlan(second.agent, 'runtime_restart', {})
  assert.equal(recovery.recovered, true)

  const [row] = second.rows('context.restaged')
  assert.equal(row.data.role, 'executor')
  assert.equal(row.data.checkpoint, 'C7')
  assert.match(row.request_id, /^recovery_/)
  assert.match(textOf(stepBlock(second.calls[0].messages)), /^actor: actor_id=18 actor_kind=standalone_character epoch=4 connected_players=1$/m, 'the fresh actor snapshot with the NEW epoch')
  assert.match(textOf(stepBlock(second.calls[0].messages)), /^restage: role=executor checkpoint=C7 reason=recovery:runtime_restart$/m)
  assert.equal(second.calls[0].context.role, 'executor')
  assert.equal(second.agent.agentContext.hasParkedPlanner, false, 'the recovery scaffolding of the restarted lineage is not kept as a planner conversation')

  // The slice closes: the planner is built fresh from a packet (C2: a shelf node is picked up), then briefed with the verified results.
  world_give(game, 'iron-ore', 10)
  await second.agent.completed()
  const restages = second.rows('context.restaged')
  assert.deepEqual(restages.map(item => `${item.data.role}:${item.data.checkpoint}`), ['executor:C7', 'planner:C2', 'executor:C3'])
  assert.equal(restages[1].data.reason, 'planner_fresh_at_slice_close_no_parked_context')
  const wake = second.calls[1].messages
  assert.equal(textOf(wake[0]), textOf(second.calls[0].messages[0]).replace(`\n\n${EXECUTOR_ROLE_PROMPT}`, ''), 'the planner system prefix')
  assert.match(textOf(stepBlock(wake)), /^restage: role=planner checkpoint=C2 reason=planner_fresh_at_slice_close_no_parked_context$/m)
  assert.ok(wake.some(message => textOf(message).startsWith('[MOD] The current immutable plan slice is verified complete') && textOf(message).includes('[VERIFIED_RESULTS]')))
  assert.equal(wake.some(message => textOf(message).startsWith('[HARNESS] Runtime recovery')), false, 'the executor recovery instruction is not in the planner conversation')
  assert.equal(second.rows('context.planner_resumed').length, 0, 'nothing was parked to resume')
})

function world_give(game, item, count) {
  game.inventory[item] = (game.inventory[item] ?? 0) + count
}

// --- AgentContext parking ----------------------------------------------------------------------------------

test('AgentContext parks the planner at an executor restage, keeps its size counter, and resumes it whole; a fresh planner or a new lineage drops it', () => {
  const context = new AgentContext({ config: { models: ['planner-model', 'executor-model'], base: 'https://p.test/v1', key: 'k' } })
  context.baseMessages = [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: '[CHAT] Louis: go' }]
  context.messages = [...context.baseMessages, { role: 'assistant', content: 'plan' }]
  const grown = context.beginRequest(40000)
  context.observeReply(grown, { input_units: 12000 })
  const plannerHandoff = context.handoffId
  const plannerRequestBeforePark = context.beginRequest(1000)
  const packet = (id, checkpoint = 'C3', role = 'executor') => ({
    stableText: '[HANDOFF] stable', volatileText: '--- step block ---', handoff_id: id, hash: 'h', chars: 20, estimated_tokens: 5,
    event: { role, checkpoint, reason: 'r' },
  })

  context.restage({ checkpoint: 'C3', reason: 'r', packet: packet('ho_exec_one'), parkPlanner: true })
  assert.equal(context.role, 'executor')
  assert.equal(context.hasParkedPlanner, true)
  assert.equal(context.parkedPlanner.handoffId, plannerHandoff)
  assert.equal(context.sizeTokens, 0, 'the executor starts with its own size counter')
  // An executor-to-executor restage leaves the parked planner alone.
  context.restage({ checkpoint: 'C8', reason: 'r', packet: packet('ho_exec_two', 'C8'), parkPlanner: true })
  assert.equal(context.parkedPlanner.handoffId, plannerHandoff)
  const executorRequest = context.beginRequest(500)

  const resumed = context.resumePlanner()
  assert.equal(context.isStale(plannerRequestBeforePark), true, 'a planner reply from before it was parked is stale: only one conversation acts')
  assert.equal(resumed.role, 'planner')
  assert.equal(resumed.handoff_id, plannerHandoff)
  assert.equal(resumed.dropped_executor.handoff_id, 'ho_exec_two')
  assert.equal(context.role, 'planner')
  assert.deepEqual(context.messages.map(message => message.content), ['SYSTEM', '[CHAT] Louis: go', 'plan'], 'the planner conversation, untouched')
  assert.equal(context.sizeTokens, 12000, 'the planner size counter comes back: executor traffic never counted against it')
  assert.equal(context.hasParkedPlanner, false)
  assert.equal(context.isStale(executorRequest), true, 'a reply still in flight for the dropped executor is stale')
  assert.equal(context.resumePlanner(), undefined, 'nothing parked')

  // A restage as the planner (a fresh planner from a packet) replaces whatever was parked; a new lineage starts with none.
  context.restage({ checkpoint: 'C3', reason: 'r', packet: packet('ho_exec_three'), parkPlanner: true })
  assert.equal(context.hasParkedPlanner, true)
  context.restage({ checkpoint: 'C1', reason: 'r', packet: packet('ho_planner_fresh', 'C1', 'planner') })
  assert.equal(context.hasParkedPlanner, false)
  context.restage({ checkpoint: 'C3', reason: 'r', packet: packet('ho_exec_four'), parkPlanner: true })
  context.beginLineage()
  assert.equal(context.hasParkedPlanner, false)
  assert.equal(context.role, 'planner')
})

// --- U8 carry-overs -----------------------------------------------------------------------------------------------

const contextWindowError = () => Object.assign(new Error('provider_context_window_exceeded: Provider HTTP 400 reported context/input token limit exhaustion'), { code: 'provider_context_window_exceeded', failureClass: 'provider_budget' })
const budgetJev = () => recordingJev(async (state) => (state?.contract === 'recovery_route'
  ? {
      model: 'jev-latest',
      provider: 'TypeSafe',
      answers: {
        failure_class: { type: 'choice', choice: 'provider_budget', confidence: 0.99 },
        next_recovery: { type: 'choice', choice: 'wake_planner', confidence: 0.97 },
      },
      usage: { input_tokens: 30, output_tokens: 6, cost: 0 },
    }
  : undefined))

test('5a: the recovery a failed turn triggers (runGuardedTurn catch) runs under the turn scope, so a reset that outlives it is dropped before admission', async () => {
  const jev = budgetJev()
  const world = harness({
    script: [
      plannerSlice(),
      () => { throw contextWindowError() }, // the executor's continuation round hits the context window: a terminal budget failure
      () => planReply({ chatMessage: 'STALE-RECOVERY-REPLY', plan: TWO_STEPS, currentStep: 0, operations: [gather('coal', 77)] }),
    ],
    agentOptions: { interactionDecisionProvider: jev, steeringDecisionProvider: jev },
  })
  await world.say()
  world.give('iron-ore', 2)
  const { agent } = world
  const scopes = []
  const originalRestage = agent.restageInTurn.bind(agent)
  const generationAtStart = agent.generation
  const lineageAtStart = agent.agentContext.lineageSequence
  let resetAfterRestage = false
  agent.restageInTurn = async (args) => {
    scopes.push({ checkpoint: args.checkpoint, scope: agent.turnScope.getStore() })
    const result = await originalRestage(args)
    if (!resetAfterRestage) {
      resetAfterRestage = true
      // The request is superseded while its recovery is between the handoff and its next round: a new lineage is running.
      agent.reset()
      agent.active = true
      agent.epoch = { ...world.game.status }
    }
    return result
  }
  const mutationsBefore = world.game.mutations.length

  await assert.rejects(agent.completed(), /cancelled|superseded/)

  const c5 = scopes.find(item => item.checkpoint === 'C5')
  assert.ok(c5, 'the budget handoff of the recovery ran')
  assert.ok(c5.scope, 'the recovery runs under a turn scope (before the fix it ran outside any runTurn)')
  assert.equal(c5.scope.lineage, lineageAtStart)
  assert.equal(c5.scope.generation, generationAtStart)
  assert.equal(world.game.mutations.length, mutationsBefore, 'the reply of the superseded recovery was dropped before admission')
  assert.ok(!world.game.mutations.some(text => text.includes('coal')))
  const [dropped] = world.rows('context.stale_reply_dropped')
  assert.ok(dropped, 'and the drop is traced')
  assert.equal(dropped.data.reason, 'handoff_superseded')
  assert.ok(dropped.request_id)
})

// The output-budget retry sets the in-flight marker; what happens to it when the retry's reply turns out stale depends on WHAT outlived it.
async function outputBudgetRetryWorld() {
  const gate = deferred()
  const exhausted = () => {
    const message = { content: '' }
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'provider_output_budget_exhausted', output_budget_exhausted: true, finish_reason: 'length', content_chars: 0, tool_call_count: 0, usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 } },
    })
    return message
  }
  const world = harness({
    script: [
      plannerSlice(),
      exhausted, // the executor's continuation round exhausts its output budget: one compact retry
      () => gate.promise, // the retry, in flight
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }),
    ],
  })
  await world.say()
  world.give('iron-ore', 2)
  const pending = world.agent.completed()
  pending.catch(() => {})
  for (let spin = 0; spin < 500 && world.calls.length < 3; spin++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(world.calls.length, 3, 'the retry is in flight')
  assert.equal(world.memory.currentPlan(KEY).provider_recovery?.phase, 'in_flight', 'the marker is set for the fail-closed restart path')
  return { world, gate, pending }
}

test('5b: a stale turn superseded by a reset leaves the in-flight recovery marker for the fail-closed restart path, and writes nothing', async () => {
  const { world, gate, pending } = await outputBudgetRetryWorld()
  const persistCalls = []
  const persist = world.agent.persistState.bind(world.agent)
  world.agent.persistState = async () => { persistCalls.push(1); return persist() }

  world.agent.cancel('actor_replaced_stale_turn') // a reset: the lineage this turn belongs to is gone
  const persistsAfterReset = persistCalls.length
  gate.resolve(planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('coal', 5)] }))
  await assert.rejects(pending, /cancelled|superseded/)

  assert.deepEqual(world.memory.currentPlan(KEY).provider_recovery && { kind: world.memory.currentPlan(KEY).provider_recovery.kind, phase: world.memory.currentPlan(KEY).provider_recovery.phase }, { kind: 'output_budget_exhaustion', phase: 'in_flight' }, 'the marker is still there')
  assert.equal(persistCalls.length, persistsAfterReset, 'the stale turn persisted nothing')
  const [kept] = world.rows('provider.output_budget_recovery_marker_kept')
  assert.ok(kept, 'the decision is traced')
  assert.equal(kept.data.reason, 'turn_superseded_by_reset')
  assert.equal(kept.data.stale_kind, 'superseded')
  assert.equal(kept.data.request_id, kept.request_id)
  assert.ok(kept.request_id)
})

test('5b: a stale retry of a restage (the same lineage moved on) still clears the marker, because the retry never ran for the active conversation', async () => {
  const { world, gate, pending } = await outputBudgetRetryWorld()
  const packet = world.agent.buildRestagePacket({ checkpoint: 'C8', role: 'executor', reason: 'forced', actor: world.agent.epoch })
  world.agent.agentContext.restage({ checkpoint: 'C8', reason: 'forced', packet, prefixMessages: world.agent.rolePrefixMessages('executor') }) // the unguarded path a race would take
  gate.resolve(planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('coal', 5)] }))
  await pending

  assert.equal(world.memory.currentPlan(KEY).provider_recovery, undefined, 'cleared')
  assert.equal(world.rows('provider.output_budget_recovery_marker_kept').length, 0)
  assert.equal(world.rows('context.stale_reply_dropped').length, 1)
})

// 5c: the silent stall. An active goal a restart finds with no plan at all.
async function goalAdmittedNoPlan() {
  const file = stateFile()
  const game = new FakeFactorio()
  const first = harness({ game, script: [() => { throw new Error('fetch failed') }], agentOptions: { stateFile: file } })
  await assert.rejects(first.say(), /fetch failed/)
  await first.agent.persistQueue
  const planning = first.memory.planningState(KEY)
  assert.equal(planning.goal.status, 'active', 'the goal was admitted before the first plan')
  assert.equal(planning.plans.length, 0)
  assert.equal(first.memory.currentPlan(KEY), undefined)
  return { file, game, goalId: planning.goal.goal_id, objective: planning.goal.objective }
}

function chatSession(agent) {
  const chat = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent, npcId: 'sgluna', stopping: false, autoResume: null, log: () => {}, eventQueue: Promise.resolve(),
    printChat: async (message) => { chat.push(message) },
    currentPlanState: () => agent.memory.currentPlan(KEY),
    syncTaskBoardUi: async () => {},
  })
  return { session, chat }
}

test('5c: a restart with an active goal that never got a plan pauses it visibly, says Resume re-drives it, wakes no model, and traces a reason and a request id', async () => {
  const { file, game, goalId } = await goalAdmittedNoPlan()
  const second = harness({ game, script: [], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  const { session, chat } = chatSession(second.agent)

  assert.equal(session.startupGoalNoticeKind(), 'before_first_plan')
  assert.equal(session.queueStartupGoalNotice(), true)
  await session.eventQueue

  assert.equal(second.calls.length, 0, 'no model was woken')
  const planning = second.memory.planningState(KEY)
  assert.equal(planning.goal.goal_id, goalId, 'the same goal')
  assert.equal(planning.goal.status, 'active', 'still the player\'s goal')
  assert.equal(planning.run.paused, true, 'the run is paused')
  assert.equal(planning.run.pause_reason, 'runtime_restart_before_first_plan')
  assert.equal(chat.length, 1)
  assert.match(chat[0], /paused it and did not wake the planner/)
  assert.match(chat[0], /Resume|continue/)
  const [row] = second.rows('runtime.goal_without_plan')
  assert.equal(row.data.reason, 'runtime_restart_before_first_plan')
  assert.match(row.request_id, /^recovery_/)
  assert.equal(row.data.request_id, row.request_id)
  assert.equal(row.data.goal_id, goalId)
  assert.equal(row.data.model_woken, false)
  assert.equal(row.data.paused, true)
  // The pause survives another restart quietly (it is paused: nothing more to announce), and the plain no-plan notice for a goal WITH plans is unchanged.
  await second.agent.persistQueue
  assert.equal(session.startupGoalNoticeKind(), undefined)
})

test('5c: Resume on that pause re-drives the same goal from its own objective (the first plan of the goal), and a bare continue never becomes a new goal', async () => {
  const { file, game, goalId, objective } = await goalAdmittedNoPlan()
  const second = harness({ game, script: [() => plannerSlice()], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  const { session } = chatSession(second.agent)
  await session.announceStartupGoal('before_first_plan')
  assert.equal(second.memory.planningState(KEY).run.paused, true)

  await second.agent.request('continue', { sender: 'TTLouis' })

  assert.equal(second.calls.length, 1, 'the planner was woken by the player\'s Resume, and only then')
  assert.ok(second.calls[0].messages.some(message => textOf(message) === `[CHAT] TTLouis: ${objective}`), 'from the goal text, not from the word continue')
  assert.equal(second.calls[0].messages.some(message => textOf(message) === '[CHAT] TTLouis: continue'), false)
  const planning = second.memory.planningState(KEY)
  assert.equal(planning.goal.goal_id, goalId, 'the same goal, not a new one')
  assert.equal(planning.run.paused, false)
  assert.ok(getActivePlan(planning), 'the goal now has its first plan')
  const [redriven] = second.rows('goal.redriven_after_restart')
  assert.equal(redriven.data.goal_id, goalId)
  assert.equal(redriven.data.reason, 'runtime_restart_before_first_plan')
  assert.ok(redriven.request_id)
})

test('5c: a goal with plans but none active keeps its own notice, and a healthy or paused goal gets none', async () => {
  const { file, game } = await goalAdmittedNoPlan()
  const second = harness({ game, script: [], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  const { session, chat } = chatSession(second.agent)
  await session.announceStartupGoal('no_active_plan')
  assert.match(chat[0], /no active plan to resume, so I am not waking the planner/)
  assert.equal(second.calls.length, 0)
  const [row] = second.rows('runtime.goal_without_plan')
  assert.equal(row.data.reason, 'runtime_restart_no_active_plan')
  assert.match(row.request_id, /^recovery_/)
  assert.equal(row.data.request_id, row.request_id)
})

test('5d: a trace writer that throws (even before it returns a promise) cannot abort a restage helper or a recovery', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const { agent } = world
  const original = agent.traceEvent.bind(agent)
  agent.traceEvent = (event, ...rest) => {
    if (event === 'context.restage_error' || event === 'context.restage_persist_failed') throw new Error('trace writer down') // synchronous
    return original(event, ...rest)
  }
  agent.buildRestagePacket = () => { throw new Error('packet builder failed') }
  const result = await agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'x' })
  assert.deepEqual(result, { restaged: false, reason: 'restage_error' }, 'a typed result, not an exception')

  // The supervisor side: the recovery still runs on the conversation the loop built.
  const file = stateFile()
  const game = new FakeFactorio()
  const first = harness({ game, script: [plannerSlice()], agentOptions: { stateFile: file } })
  await first.say()
  await first.agent.persistQueue
  const second = harness({ game, script: [() => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] })], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  const trace = second.agent.traceEvent.bind(second.agent)
  second.agent.buildRestagePacket = () => { throw new Error('packet builder failed') }
  second.agent.traceEvent = (event, ...rest) => {
    if (event === 'runtime.recovery_restage_fallback' || event === 'context.restage_error') throw new Error('trace writer down')
    return trace(event, ...rest)
  }
  const recovery = await recoverInterruptedAgentPlan(second.agent, 'runtime_restart', {})
  assert.equal(recovery.recovered, true, 'the recovery still ran')
  assert.equal(second.calls.length, 1)
})

test('5e: a trace failure after a restage swapped the conversation still persists the reducer state, and is reported as its own failure', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const { agent } = world
  const persisted = []
  const persist = agent.persistState.bind(agent)
  agent.persistState = async () => { persisted.push(getContextRestages(world.memory.planningState(KEY)).length); return persist() }
  const original = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, ...rest) => {
    if (event === 'context.restaged') throw new Error('trace disk full')
    return original(event, ...rest)
  }
  const restagesBefore = getContextRestages(world.memory.planningState(KEY)).length

  const result = await agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: agent.epoch })

  assert.equal(result.restaged, true, 'the swap happened, so the restage is not reported as a failure')
  assert.equal(persisted.length, 1, 'persistState ran although the trace write failed')
  assert.equal(persisted[0], restagesBefore + 1, 'and it saw the CONTEXT_RESTAGED entry')
  const [failure] = world.rows('context.restage_persist_failed')
  assert.equal(failure.data.step, 'trace')
  assert.match(failure.data.message, /trace disk full/)
  assert.equal(failure.data.checkpoint, 'C8')
  assert.ok(failure.request_id)
})

test('5f: the turn_superseded refusal rows carry the request id even when the request was cleared by the reset', async () => {
  // The executor's return to the planner.
  const executor = harness({
    script: [
      plannerSlice({ plan: ['Gather 10 iron ore'] }),
    ],
  })
  await executor.say()
  const requestId = executor.rows('request.received')[0].request_id
  const original = executor.agent.assertCurrent.bind(executor.agent)
  executor.agent.assertCurrent = async () => {
    executor.agent.traceRequest = null // the actor replacement cancelled the request: nothing names it any more
    throw new Error('NPC actor epoch changed; stale model turn cancelled')
  }
  await assert.rejects(executor.agent.returnControlToPlanner({ route: 'next_shelf_slice', planningState: executor.memory.planningState(KEY), requestId }), /epoch changed/)
  executor.agent.assertCurrent = original
  const [refused] = executor.rows('context.planner_resume_refused').length > 0 ? executor.rows('context.planner_resume_refused') : [undefined]
  assert.equal(refused.data.reason, 'turn_superseded')
  assert.equal(refused.request_id, requestId)
  assert.equal(refused.data.request_id, requestId)

  // The planner's own slice-close restage (no executor): the request id is taken before the awaits.
  const planner = harness({
    script: [
      plannerSlice({ plan: ['Gather 10 iron ore'], checkpoint: inventoryCheckpoint('iron-ore', 10) }),
    ],
    tokens: () => 6000,
    agentOptions: { executorHandoff: false, restageSoftLimitTokens: 5000 },
  })
  await planner.say()
  const plannerRequestId = planner.rows('request.received')[0].request_id
  const wake = planner.agent.planSliceCloseWake.bind(planner.agent)
  planner.agent.planSliceCloseWake = async (args) => {
    const check = planner.agent.assertCurrent
    planner.agent.assertCurrent = async () => {
      planner.agent.traceRequest = null // the request is gone by the time the wake refuses
      throw new Error('NPC actor epoch changed; stale model turn cancelled')
    }
    try { return await wake(args) }
    finally { planner.agent.assertCurrent = check }
  }
  planner.give('iron-ore')
  await assert.rejects(planner.agent.completed(), /epoch changed|cancelled|superseded/)
  const [plannerRefused] = planner.rows('context.restage_refused')
  assert.equal(plannerRefused.data.reason, 'turn_superseded')
  assert.equal(plannerRefused.request_id, plannerRequestId, 'named by the request it belongs to')
})

test('5g: a stale drop names the conversation the reply came from (its own attribution), not the turn scope of its first round; an in-turn restage refreshes the scope', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const { agent } = world
  const executorAttribution = { role: 'executor', handoffId: 'ho_reply_own_attribution', lineage: agent.agentContext.lineageSequence, seq: agent.agentContext.conversationSeq }
  const staleScope = { lineage: agent.agentContext.lineageSequence - 1, generation: agent.generation, role: 'planner', handoffId: 'ho_scope_of_first_round', requestId: 'req_scope' }

  await assert.rejects(agent.turnScope.run(staleScope, () => agent.dropIfStale(executorAttribution)), (error) => {
    assert.equal(error.code, 'stale_handoff_reply')
    return true
  })
  const [row] = world.rows('context.stale_reply_dropped')
  assert.equal(row.data.role, 'executor')
  assert.equal(row.data.handoff_id, 'ho_reply_own_attribution')
  assert.equal(row.request_id, world.rows('request.received')[0].request_id, 'the open request')
  agent.traceRequest = null
  await assert.rejects(agent.turnScope.run(staleScope, () => agent.dropIfStale(executorAttribution)))
  assert.equal(world.rows('context.stale_reply_dropped')[1].request_id, 'req_scope', 'with no open request, the turn scope names it')
  world.trace.length = 0
  // Without an attribution (no round has run) the scope's own is used.
  await assert.rejects(agent.turnScope.run(staleScope, () => agent.dropIfStale(null)))
  assert.equal(world.rows('context.stale_reply_dropped')[0].data.handoff_id, 'ho_scope_of_first_round')

  // An in-turn restage refreshes the running turn's scope to the conversation now in place.
  const scope = { lineage: agent.agentContext.lineageSequence, generation: agent.generation, role: 'planner', handoffId: 'ho_before', requestId: 'req_scope' }
  const restaged = await agent.turnScope.run(scope, () => agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'scope refresh', actor: agent.epoch }))
  assert.equal(restaged.restaged, true)
  assert.equal(scope.role, 'executor')
  assert.equal(scope.handoffId, restaged.handoff_id)
})

// --- the slice close from the completion signal, and the unmet-goal continuation ------------------------------

test('a slice that closes from the completion signal (outside any turn) resumes the parked planner between turns, with the verified results', async () => {
  const world = harness({
    script: [
      plannerSlice({ plan: ['Gather 10 iron ore'] }),
      () => plannerNextSlice(),
    ],
  })
  await world.say()
  const plannerHandoff = world.agent.agentContext.parkedPlanner.handoffId
  world.give('iron-ore') // the game satisfies the only step's contract: the harness closes the slice, no model turn involved
  assert.equal(world.agent.turnConversation, null, 'no turn holds the conversation')
  await world.agent.completed()

  assert.equal(world.calls.length, 2, 'one planner wake, no executor round in between')
  const [resumed] = world.rows('context.planner_resumed')
  assert.equal(resumed.data.handoff_id, plannerHandoff)
  assert.equal(resumed.data.route, 'next_shelf_slice')
  assert.equal(world.calls[1].context.role, 'planner')
  const wake = world.calls[1].messages
  assert.ok(wake.some(message => textOf(message).startsWith('[MOD] The current immutable plan slice is verified complete') && textOf(message).includes('[VERIFIED_RESULTS]')))
  assert.equal(wake.some(message => textOf(message).startsWith('[HANDOFF]')), false, 'the planner conversation, not a packet')
  assert.equal(world.rows('context.restage_refused').length, 0)
  assert.equal(world.agent.agentContext.role, 'executor', 'and the slice it authored is executed by a fresh executor')
})

test('an unmet goal after the executor\'s final claim hands the next slice to the planner conversation, which never sees the executor\'s reply', async () => {
  const world = harness({
    script: [
      // No checkpoint: the only step is prose-only, closed by the executor's claim.
      plannerSlice({ plan: ['Gather 10 iron ore'], checkpoint: undefined }),
      () => planReply({ chatMessage: 'EXECUTOR-FINAL-REPLY', plan: [], currentStep: 0, operations: [] }),
      () => plannerNextSlice(),
    ],
  })
  await world.say()
  world.give('iron-ore')
  await world.agent.completed()

  assert.equal(world.calls.length, 3)
  const wake = world.calls[2]
  assert.equal(wake.context.role, 'planner', 'the next slice is authored by the planner')
  assert.ok(wake.messages.some(message => textOf(message).startsWith('[CHAT]')), 'the planner conversation')
  assert.equal(JSON.stringify(wake.messages).includes('EXECUTOR-FINAL-REPLY'), false, 'without the executor\'s reply')
  assert.ok(wake.messages.some(message => textOf(message).startsWith('[HARNESS] The plan is finished, but the game reports')))
  const [resumed] = world.rows('context.planner_resumed')
  assert.equal(resumed.data.route, 'unmet_goal_after_plan')
  assert.equal(resumed.data.reason, 'slice_close_unmet_goal')
  assert.equal(resumed.request_id, world.rows('request.received')[0].request_id)
})

// =====================================================================================================
// U6 review fixes: reasoning epoch, the executor never authors, amendments belong to the planner, nits
// =====================================================================================================

const oneStepSlice = (overrides = {}) => plannerSlice({ plan: ['Gather 10 iron ore'], ...overrides })
const executorResubmit = () => planReply({ plan: ['Gather 10 iron ore'], currentStep: 0, operations: [gather('iron-ore', 4)] })

// --- blocker: a reasoning-epoch rebuild must not wipe the executor's packet ---------------------------------

test('blocker: a second goal in the same process keeps its executor packet and role suffix across the first continuation', async () => {
  const world = harness({
    script: [
      () => oneStepSlice({ goal: { ...GOAL, scope: 'finite' }, roadmap: undefined }), // goal A: no shelf, so its epoch is lower than B's
      () => plannerSlice({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10), goal: { ...GOAL, summary: 'Goal B.' }, roadmap: [{ id: 'b1', intent: 'goal B first node' }] }), // goal B, a revised shelf
      () => planReply({ plan: ['Gather 10 coal'], currentStep: 0, operations: [gather('coal', 4)] }), // the executor of B, after its first continuation
    ],
  })
  await world.say()
  const epochA = world.memory.planningReasoningEpoch(KEY)
  assert.equal(world.agent.planningReasoningEpochSeen.get(KEY), epochA, 'the C3 restage recorded the epoch it was built at')

  await world.agent.request('build a coal supply instead', { sender: 'TTLouis' }) // goal B: GOAL_ACCEPTED and ROADMAP_REVISED bump the epoch
  const epochB = world.memory.planningReasoningEpoch(KEY)
  assert.notEqual(epochB, epochA, 'the reducer epoch moved')
  assert.equal(world.agent.agentContext.role, 'executor')
  const packetBase = world.agent.baseMessages.map(message => ({ ...message }))
  assert.equal(world.agent.planningReasoningEpochSeen.get(KEY), epochB, 'and the loop has seen it')

  world.give('coal', 2)
  await world.agent.completed() // the first continuation of B's executor

  const call = world.calls.at(-1)
  assert.equal(call.context.role, 'executor')
  assert.equal(textOf(call.messages[0]), roleSystemPrompt(textOf(world.calls[0].messages[0]), 'executor'), 'the executor role suffix survived')
  assert.equal(textOf(stableBlock(call.messages)), textOf(packetBase[1]), 'and so did the C3 packet')
  assert.equal(call.messages.some(message => textOf(message).startsWith('[CHAT]')), false, 'no planner-shaped rebuild')
  assert.equal(world.rows('planning.reasoning_epoch_reset').length, 0)
})

test('blocker: an epoch bump in the middle of a slice keeps the executor, drops the parked planner, and the slice close builds a fresh planner from a packet', async () => {
  const world = harness({ script: [() => oneStepSlice(), () => executorResubmit(), () => plannerNextSlice()] })
  await world.say()
  assert.equal(world.agent.agentContext.hasParkedPlanner, true)
  const executorHandoff = world.agent.agentContext.handoffId
  const epoch = world.memory.planningReasoningEpoch(KEY)
  // A reasoning-epoch bump from outside the executor (the shelf moved, a plan was set aside): the reducer signal itself.
  world.memory.planningByNpc.set(KEY, { ...world.memory.planningState(KEY), reasoning_epoch: epoch + 1 })
  assert.notEqual(world.memory.planningReasoningEpoch(KEY), epoch)

  world.give('iron-ore', 2)
  await world.agent.completed() // continuation while the executor acts: the epoch check runs

  const [moved] = world.rows('executor.reasoning_epoch_moved')
  assert.ok(moved, 'the decision is traced')
  assert.equal(moved.request_id, world.rows('request.received')[0].request_id)
  assert.equal(moved.data.request_id, moved.request_id)
  assert.equal(moved.data.role, 'executor')
  assert.equal(moved.data.handoff_id, executorHandoff)
  assert.equal(moved.data.parked_planner_dropped, true)
  assert.equal(moved.data.reason, 'executor_keeps_packet_across_reasoning_epoch_bump')
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.agent.agentContext.handoffId, executorHandoff, 'the same executor conversation')
  assert.equal(world.agent.agentContext.hasParkedPlanner, false)
  const executorCall = world.calls.at(-1)
  assert.ok(stableBlock(executorCall.messages), 'the packet is intact')
  assert.ok(textOf(executorCall.messages[0]).endsWith(EXECUTOR_ROLE_PROMPT))

  world.give('iron-ore', 8)
  await world.agent.completed() // the slice closes
  const restages = world.rows('context.restaged').map(row => `${row.data.role}:${row.data.checkpoint}`)
  assert.deepEqual(restages.slice(0, 2), ['executor:C3', 'planner:C2'], 'nothing was parked, so a fresh planner was built from a packet')
  assert.equal(world.rows('context.planner_resumed').length, 0)
  const wake = world.calls.at(-1).messages
  assert.ok(stableBlock(wake), 'and the planner packet survived its first continuation (the restage recorded the epoch)')
  assert.equal(wake.some(message => textOf(message).startsWith('[CHAT]')), false)
})

// --- issue 2: the executor never authors a slice --------------------------------------------------------------

test('issue 2: a refused return to the planner is retried once at the boundary, and a second refusal ends the request visibly without waking the executor', async () => {
  const world = harness({ script: [() => oneStepSlice()] })
  await world.say()
  const { agent } = world
  const real = agent.returnControlToPlanner.bind(agent)
  const attempts = []
  agent.returnControlToPlanner = async (args) => { attempts.push(args.reason); return { returned: false, reason: 'round_in_flight' } }
  const callsBefore = world.calls.length

  world.give('iron-ore')
  const result = await agent.completed() // the slice closes from the completion signal

  assert.deepEqual(attempts, ['slice_close', 'slice_close'], 'one try and one retry')
  assert.equal(world.calls.length, callsBefore, 'no model was woken: the executor did not author the next slice')
  const requestId = world.rows('request.received')[0].request_id
  const [retried] = world.rows('context.planner_resume_retried')
  assert.equal(retried.request_id, requestId)
  assert.equal(retried.data.reason, 'round_in_flight')
  const [deferred] = world.rows('executor.slice_wake_deferred')
  assert.equal(deferred.request_id, requestId)
  assert.equal(deferred.data.request_id, requestId)
  assert.equal(deferred.data.reason, 'round_in_flight')
  assert.equal(deferred.data.model_woken, false)
  assert.equal(deferred.data.route, 'next_shelf_slice')
  assert.match(result.chatMessage, /could not hand the goal back to the planner \(round_in_flight\).*Resume/)
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.rows('request.completed').at(-1).data.outcome, 'slice_close_planner_unavailable')
  assert.equal(agent.active, false)
  agent.returnControlToPlanner = real
})

test('issue 2: a refusal that clears at the retry hands the slice to the planner as usual', async () => {
  const world = harness({ script: [() => oneStepSlice(), () => plannerNextSlice()] })
  await world.say()
  const { agent } = world
  const real = agent.returnControlToPlanner.bind(agent)
  let first = true
  agent.returnControlToPlanner = async (args) => {
    if (first) { first = false; return { returned: false, reason: 'round_in_flight' } }
    return real(args)
  }
  world.give('iron-ore')
  await agent.completed()
  assert.equal(world.rows('context.planner_resume_retried').length, 1)
  assert.equal(world.rows('context.planner_resumed').length, 1)
  assert.equal(world.rows('executor.slice_wake_deferred').length, 0)
  assert.equal(world.calls.at(-1).context.role, 'planner')
})

test('issue 2: a failed fresh-planner restage (nothing parked after a restart) wakes no model either', async () => {
  const file = stateFile()
  const game = new FakeFactorio()
  const first = harness({ game, script: [() => oneStepSlice()], agentOptions: { stateFile: file } })
  await first.say()
  await first.agent.persistQueue
  const second = harness({ game, script: [executorResubmit], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  await recoverInterruptedAgentPlan(second.agent, 'runtime_restart', {})
  assert.equal(second.calls.length, 1)
  second.agent.buildRestagePacket = () => { throw new Error('packet builder failed') } // the planner cannot be rebuilt

  second.give('iron-ore')
  const result = await second.agent.completed()

  assert.equal(second.calls.length, 1, 'no executor round authored a slice')
  const [failed] = second.rows('context.planner_resume_failed')
  assert.equal(failed.data.reason, 'restage_error')
  assert.ok(failed.request_id)
  const [deferred] = second.rows('executor.slice_wake_deferred')
  assert.equal(deferred.data.reason, 'restage_error')
  assert.ok(deferred.request_id)
  assert.match(result.chatMessage, /Resume/)
  assert.equal(second.memory.planningState(KEY).goal.status, 'active', 'the goal stays active between slices')
})

test('issue 2: an executor reply while no plan is committed is ignored whatever the plan status: nothing is drafted, committed or admitted, and no model is woken', async () => {
  const world = harness({ script: [() => oneStepSlice()] })
  await world.say()
  const { agent } = world
  agent.returnControlToPlanner = async () => ({ returned: false, reason: 'round_in_flight' })
  world.give('iron-ore')
  await agent.completed() // the slice is COMPLETED and the executor is still the active conversation
  assert.equal(world.plan().status, PLAN_STATUS.COMPLETED)
  assert.equal(agent.agentContext.role, 'executor')
  agent.active = true
  agent.traceRequest = { id: 'req_executor_authoring', seq: 0, usage: {} }
  const plansBefore = world.memory.planningState(KEY).plans.length
  const mutationsBefore = world.game.mutations.length

  const result = await agent.commitPlan({ chatMessage: '', plan: ['Author my own slice'], currentStep: 0, operations: [gather('coal', 9)], roadmapNodeIds: ['node_power'] })

  const [ignored] = world.rows('executor.plan_semantics_ignored')
  assert.ok(ignored)
  assert.equal(ignored.data.reason, 'executor_cannot_author_plan:plan_status_COMPLETED')
  assert.equal(ignored.data.role, 'executor')
  assert.ok(ignored.request_id)
  assert.equal(world.memory.planningState(KEY).plans.length, plansBefore, 'no draft was created')
  assert.equal(world.game.mutations.length, mutationsBefore, 'no operation was admitted')
  assert.match(result.chatMessage, /executor_cannot_author_plan/)
  assert.equal(world.rows('executor.slice_wake_deferred').at(-1).data.reason, 'executor_cannot_author_plan')
})

// --- issue 3: a deferred user amendment belongs to the planner ------------------------------------------------

function amendmentWorld(script) {
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'amend_current', confidence: 0.95 } } } : undefined))
  const world = harness({
    script,
    agentOptions: {
      interactionProvider: async () => ({ content: JSON.stringify({ intent: 'amend_current', queue_conflict: false, reply: '' }) }),
      interactionDecisionProvider: jev,
      steeringDecisionProvider: jev,
    },
  })
  world.game.taskState = 'mining' // Autorio is working: the amendment is compatible with the running batch
  world.game.queueLength = 1
  return world
}

test('issue 3: an amendment during an executor slice returns control to the planner and is staged in the planner conversation, never the executor\'s', async () => {
  const world = amendmentWorld([() => oneStepSlice(), () => executorResubmit(), () => executorResubmit()])
  await world.say()
  const { agent } = world
  const plannerHandoff = agent.agentContext.parkedPlanner.handoffId
  const executorHandoff = agent.agentContext.handoffId

  const result = await agent.request('also make it fast', { sender: 'TTLouis' })

  assert.equal(result.amendmentDeferred, true)
  assert.equal(agent.agentContext.role, 'planner', 'the executor was dropped')
  assert.equal(agent.agentContext.handoffId, plannerHandoff)
  const [resumed] = world.rows('context.planner_resumed')
  assert.equal(resumed.data.reason, 'user_amendment')
  assert.equal(resumed.data.route, 'amend_current')
  assert.equal(resumed.data.from_handoff_id, executorHandoff)
  assert.ok(resumed.request_id)
  assert.equal(agent.baseMessages.some(message => textOf(message) === '[CHAT] TTLouis: also make it fast'), true, 'the text is in the planner conversation')
  assert.ok(agent.pendingInteractionAmendment)
  assert.equal(agent.pendingAmendmentConversationSeq, agent.agentContext.conversationSeq)

  // The next boundary wakes the planner with the amendment; the executor never sees it.
  world.game.taskState = 'idle'
  world.game.queueLength = 0
  world.give('iron-ore', 2)
  await agent.completed()
  const call = world.calls.at(-1)
  assert.equal(call.context.role, 'planner')
  assert.equal(call.messages.some(message => textOf(message) === '[CHAT] TTLouis: also make it fast'), true)
  assert.equal(world.calls.some(item => item.context.role === 'executor' && JSON.stringify(item.messages).includes('also make it fast')), false)
})

test('issue 3: when the planner cannot be reached the amendment is not deferred to the executor', async () => {
  const world = amendmentWorld([() => oneStepSlice()])
  await world.say()
  const { agent } = world
  agent.returnControlToPlanner = async () => ({ returned: false, reason: 'round_in_flight' })
  const staged = await agent.stageCompatibleAmendment('TTLouis', 'also make it fast')
  assert.equal(staged, false)
  assert.equal(agent.pendingInteractionAmendment, null)
  assert.equal(agent.baseMessages.some(message => textOf(message).includes('also make it fast')), false, 'not in the executor conversation')
  const [row] = world.rows('amendment.not_deferred')
  assert.equal(row.data.reason, 'planner_not_reachable:round_in_flight')
  assert.ok(row.request_id)
})

test('issue 3: the amendment flag dies with the conversation that holds its text (restage, reset), and the executor contract has no bypass', async () => {
  const world = amendmentWorld([() => oneStepSlice()])
  await world.say()
  const { agent } = world
  assert.equal(await agent.stageCompatibleAmendment('TTLouis', 'also make it fast'), true)
  assert.ok(agent.currentPendingAmendment())

  const restaged = await agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: agent.epoch }) // an executor restage drops the staged text (the executor never holds it)
  assert.equal(restaged.restaged, true)
  assert.equal(agent.currentPendingAmendment(), null, 'the flag went with the text')
  assert.equal(agent.pendingInteractionAmendment, null)
  const [cleared] = world.rows('amendment.flag_cleared')
  assert.equal(cleared.data.reason, 'conversation_holding_the_amendment_text_was_replaced')
  assert.ok(cleared.request_id)
  const [dropped] = world.rows('amendment.dropped')
  assert.match(dropped.data.chat_message, /also make it fast.*not applied.*send it again/)
  assert.equal(dropped.data.reason, 'conversation_holding_the_amendment_text_was_replaced')
  assert.equal(dropped.data.request_id, cleared.request_id)

  // A flag from an older conversation, then a reset.
  agent.pendingInteractionAmendment = { sender: 'TTLouis', text: 'stale' }
  agent.pendingAmendmentConversationSeq = agent.agentContext.conversationSeq
  agent.reset()
  assert.equal(agent.pendingInteractionAmendment, null, 'a new request cannot inherit it')
  assert.equal(world.rows('amendment.dropped').at(-1).data.reason, 'reset_discarded_the_conversation_holding_the_text', 'and the player is told it was dropped')

  // The executor never gets the bypass: with a flag set while the executor acts, a changed plan is still ignored.
  const exec = harness({ script: [() => oneStepSlice(), () => planReply({ plan: ['Something else'], currentStep: 0, operations: [gather('iron-ore', 4)] })] })
  await exec.say()
  exec.agent.pendingInteractionAmendment = { sender: 'TTLouis', text: 'go' }
  exec.give('iron-ore', 2)
  await exec.agent.completed()
  assert.match(exec.rows('executor.plan_semantics_ignored')[0].data.reason, /steps_changed/)
})

// --- nits ------------------------------------------------------------------------------------------------------

test('nit a: a rebuild while the role is executor uses the executor system prompt (the C5 capsule fallback and the epoch rebuild)', async () => {
  const world = harness({ script: [() => oneStepSlice()] })
  await world.say()
  assert.equal(textOf(world.agent.rolePrefixMessages('executor')[0]), roleSystemPrompt(world.agent.systemPrompt, 'executor'))
  const source = fs.readFileSync(fileURLToPath(new URL('./npc-agent-loop.mjs', import.meta.url)), 'utf8')
  assert.equal(source.includes("{ role: 'system', content: this.systemPrompt }"), false, 'no rebuild hard-codes the planner system prompt')
})

test('nit c: the startup notice decides at run time and prints only what happened', async () => {
  const { file, game, goalId } = await goalAdmittedNoPlan()
  const second = harness({ game, script: [], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  const { session, chat } = chatSession(second.agent)
  second.agent.pauseGoalWithoutPlan = async () => ({ goal_id: goalId, paused: false })
  await session.announceStartupGoal('before_first_plan')
  assert.equal(chat.length, 1)
  assert.doesNotMatch(chat[0], /paused it/)
  assert.match(chat[0], /could not record a pause/)
  const [row] = second.rows('runtime.goal_without_plan')
  assert.equal(row.data.paused, false)
  assert.equal(row.data.reason, 'pause_not_applied')
  assert.match(row.request_id, /^recovery_/)

  // The kind is read when the queued event RUNS: a goal that moved on in between is not announced.
  const third = harness({ game, script: [], agentOptions: { stateFile: file } })
  await third.agent.loadPersistentState()
  const later = chatSession(third.agent)
  let release
  later.session.eventQueue = new Promise((resolve) => { release = resolve })
  assert.equal(later.session.queueStartupGoalNotice(), true)
  await third.agent.pauseGoalWithoutPlan('runtime_restart_before_first_plan') // paused by something else meanwhile
  release()
  await later.session.eventQueue
  assert.deepEqual(later.chat, [], 'nothing announced for a state that no longer holds')
})

test('nit d: the Resume re-drive accepts the supervisor continuation words in both languages, and only bare ones', async () => {
  for (const text of ['continue', 'Resume.', '继续', '继续吧', '接着做！']) assert.equal(isBareContinuation(text), true, text)
  for (const text of ['continue building a base', '继续造电', 'please continue', '']) assert.equal(isBareContinuation(text), false, text)
  const { file, game, goalId, objective } = await goalAdmittedNoPlan()
  const second = harness({ game, script: [() => plannerSlice()], agentOptions: { stateFile: file } })
  await second.agent.loadPersistentState()
  await chatSession(second.agent).session.announceStartupGoal('before_first_plan')
  await second.agent.request('继续', { sender: 'TTLouis' })
  assert.ok(second.calls[0].messages.some(message => textOf(message) === `[CHAT] TTLouis: ${objective}`))
  assert.equal(second.memory.planningState(KEY).goal.goal_id, goalId)
})

test('nit e: a completed prefix is not a restatement of the remaining steps', async () => {
  const committed = ['a', 'b', 'c']
  assert.equal(restatedPlanVerdict(['a', 'b', 'c'], committed, 2), 'unchanged', 'the whole list')
  assert.equal(restatedPlanVerdict(['c'], committed, 2), 'unchanged', 'the active step')
  assert.equal(restatedPlanVerdict(['b', 'c'], committed, 1), 'unchanged', 'the remaining suffix')
  assert.equal(restatedPlanVerdict(['a'], committed, 2), 'steps_changed', 'a completed prefix')
  assert.equal(restatedPlanVerdict(['a', 'b'], committed, 2), 'steps_changed')
  assert.equal(restatedPlanVerdict(['b'], committed, 2), 'steps_changed')
  const world = harness({ script: [() => plannerSlice(), () => planReply({ plan: ['Gather 10 iron ore'], currentStep: 0, operations: [gather('iron-ore', 4)] })] })
  await world.say()
  world.give('iron-ore', 2)
  await world.agent.completed()
  assert.equal(world.rows('executor.plan_semantics_ignored').length, 0, 'the active step on its own is a restatement at step 1')
})

test('nit f: the contract is what keeps the roadmap and the development mode: a roadmap revise and a steering change from an executor change nothing', async () => {
  const world = harness({
    script: [
      () => plannerSlice(),
      () => planReply({
        plan: TWO_STEPS,
        currentStep: 0,
        operations: [gather('iron-ore', 4)],
        roadmap: [{ id: 'node_power', intent: 'steam power running' }], // omitting node_drill would invalidate it
        developmentMode: 'horizontal',
      }),
    ],
  })
  await world.say()
  const before = world.memory.planningState(KEY)
  world.give('iron-ore', 2)
  await world.agent.completed()
  const after = world.memory.planningState(KEY)
  assert.deepEqual(after.roadmap, before.roadmap, 'the shelf')
  assert.equal(after.roadmap.nodes.find(node => node.id === 'node_drill').status, before.roadmap.nodes.find(node => node.id === 'node_drill').status)
  assert.equal(after.reasoning_epoch, before.reasoning_epoch, 'no epoch bump from an executor roadmap')
  assert.equal(getActivePlan(after).development_mode, getActivePlan(before).development_mode)
  assert.match(world.rows('executor.plan_semantics_ignored')[0].data.reason, /roadmap_is_planner_authority.*development_mode_is_planner_authority/)
})

test('nit f: the U7 soft-limit rule runs on the planner after a resume with the handoff ON: past the soft limit the wake restages the planner (C2 at a shelf pickup)', async () => {
  const world = harness({
    script: [() => oneStepSlice(), () => plannerNextSlice()],
    tokens: (_call, context) => (context.role === 'executor' ? 500 : 6000), // the planner's first round names no role yet
    agentOptions: { restageSoftLimitTokens: { planner: 5000, executor: 1_000_000 } },
  })
  await world.say() // the planner's own round reports 6000 tokens: past its soft limit
  assert.equal(world.agent.agentContext.parkedPlanner.size.tokens >= 6000, true)
  world.give('iron-ore')
  await world.agent.completed() // the only step is verified: the slice closes, the planner resumes, and its own size is past the soft limit

  const restages = world.rows('context.restaged').map(row => `${row.data.role}:${row.data.checkpoint}`)
  assert.deepEqual(restages.slice(0, 2), ['executor:C3', 'planner:C2'], 'resume, then the soft-limit restage of the planner in the same wake')
  assert.equal(world.rows('context.planner_resumed').length, 1)
  const planner = world.rows('context.restaged')[1]
  assert.equal(planner.data.reason, 'context_over_soft_limit_at_slice_close')
  const wake = world.calls.at(-1).messages
  assert.match(textOf(stepBlock(wake)), /^restage: role=planner checkpoint=C2 reason=context_over_soft_limit_at_slice_close$/m)
  assert.ok(wake.some(message => textOf(message).startsWith('[MOD] The current immutable plan slice is verified complete')))
})

test('issue 2: an unmet goal after the executor final claim with no way back to the planner wakes no model, and the executor reply is not turned into a slice', async () => {
  const world = harness({
    script: [
      plannerSlice({ plan: ['Gather 10 iron ore'], checkpoint: undefined }),
      () => planReply({ chatMessage: 'EXECUTOR-FINAL-REPLY', plan: [], currentStep: 0, operations: [] }),
    ],
  })
  await world.say()
  world.agent.returnControlToPlanner = async () => ({ returned: false, reason: 'round_in_flight' })
  world.give('iron-ore')
  const result = await world.agent.completed()

  assert.equal(world.calls.length, 2, 'the executor final claim was the last model call')
  const [deferred] = world.rows('executor.slice_wake_deferred')
  assert.equal(deferred.data.route, 'unmet_goal_after_plan')
  assert.equal(deferred.data.reason, 'round_in_flight')
  assert.equal(deferred.request_id, world.rows('request.received')[0].request_id)
  assert.equal(world.rows('context.planner_resume_retried').length, 1)
  assert.match(result.chatMessage, /Resume/)
  assert.equal(JSON.stringify(world.agent.messages).includes('Author the next plan slice'), false, 'the executor was never asked to author the next slice')
})

// =====================================================================================================
// U6 last round: a staged amendment is never dropped with only a trace
// =====================================================================================================

function amendmentRecoveryWorld(script) {
  const jev = recordingJev(async (_state, questions) => {
    if (questions.recovery_semantics) {
      return { model: 'jev-latest', provider: 'TypeSafe', answers: { recovery_semantics: { type: 'choice', choice: 'semantic_replan', confidence: 0.95 }, one_observation_can_resolve: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0 } }
    }
    return questions.intent ? { overrides: { intent: { choice: 'amend_current', confidence: 0.95 } } } : undefined
  })
  const world = harness({
    script,
    agentOptions: {
      interactionProvider: async () => ({ content: JSON.stringify({ intent: 'amend_current', queue_conflict: false, reply: '' }) }),
      interactionDecisionProvider: jev,
      steeringDecisionProvider: jev,
    },
  })
  world.game.taskState = 'mining'
  world.game.queueLength = 1
  return world
}

test('amendment (a): C6 bounded recovery does not hand off to an executor while an amendment is pending on the planner; it stays on the planner that holds the text', async () => {
  const world = amendmentRecoveryWorld([() => oneStepSlice(), () => executorResubmit()])
  await world.say()
  const { agent } = world
  await agent.request('also make it fast', { sender: 'TTLouis' })
  assert.equal(agent.agentContext.role, 'planner')
  world.game.taskState = 'idle'
  world.game.queueLength = 0

  const result = await agent.recoverPlan(agent.generation, new Error('strategy invalidated by fresh evidence'), 1)

  assert.equal(result.goalStatus, 'active')
  assert.equal(world.rows('context.restaged').filter(row => row.data.checkpoint === 'C6').length, 0, 'no C6 executor restage')
  assert.equal(agent.agentContext.role, 'planner')
  const [skipped] = world.rows('executor.recovery_handoff_skipped')
  assert.equal(skipped.data.reason, 'user_amendment_pending_on_planner')
  assert.equal(skipped.data.request_id, skipped.request_id)
  assert.ok(skipped.request_id)
  assert.ok(agent.currentPendingAmendment(), 'the flag is alive')
  assert.equal(agent.baseMessages.some(message => textOf(message) === '[CHAT] TTLouis: also make it fast'), true, 'and the planner conversation still holds the text')
  assert.equal(world.calls.at(-1).context.role, 'planner', 'the recovery round ran on the planner')
  assert.equal(world.rows('amendment.dropped').length, 0)
})

test('amendment (b): a planner restage carries the pending amendment in its packet (mandatory, bounded, sanitized, labelled) and keeps the flag alive', async () => {
  const world = amendmentWorld([() => oneStepSlice()])
  await world.say()
  const { agent } = world
  const text = `also make it fast ${'very '.repeat(300)}unit_number 4711`
  assert.equal(await agent.stageCompatibleAmendment('TTLouis', text), true)

  const restaged = await agent.restageBetweenTurns({ checkpoint: 'C5', role: 'planner', reason: 'provider_budget_handoff', actor: agent.epoch })

  assert.equal(restaged.restaged, true)
  const packet = textOf(agent.baseMessages[2])
  assert.match(packet, /^user_amendment \(from TTLouis; user steering, NOT yet applied; apply it at this planner boundary, never as the executor\): also make it fast/m)
  const line = packet.split('\n').find(item => item.startsWith('user_amendment'))
  assert.ok(line.length < 700, `bounded (${line.length})`)
  assert.equal(packet.includes('4711'), false, 'sanitized like every durable text: no unit number')
  assert.ok(agent.currentPendingAmendment(), 'the flag followed the text into the new conversation')
  assert.equal(world.rows('amendment.dropped').length, 0)
  const [carried] = world.rows('amendment.carried_in_packet')
  assert.equal(carried.data.checkpoint, 'C5')
  assert.ok(carried.request_id)
})

test('amendment (b): the packet never drops the amendment record for size, and without one says so', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: 'goal_am', owner: 'louis', objective: 'Run a drill' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.GOAL_DEFINED, now: 11, source: 'main_planner', goal_id: 'goal_am', definition: { scope: 'long_horizon', summary: 'Run a drill.', doneWhen: [{ id: 'p', kind: 'items_produced', item_name: 'iron-plate', minimum: 100 }] } })
  const amendment = { sender: 'TTLouis', text: 'make it fast' }
  const small = buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C5', amendment, limits: { maxChars: 10 } })
  assert.equal(small.amendment_included, true)
  assert.match(small.text, /user_amendment/)
  assert.equal(small.dropped.includes('user_amendment'), false)
  assert.equal(small.over_limit, true, 'the mandatory records alone are over the tiny limit: reported, not dropped')
  assert.equal(buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C5' }).amendment_included, false)
})

test('amendment (b): a C5 budget handoff in the planner role keeps the amendment (through the real recovery path)', async () => {
  const budget = budgetJev()
  const amendJev = recordingJev(async (state, questions, call, context) => {
    if (state?.contract === 'recovery_route') return budget(state, questions, context)
    return questions.intent ? { overrides: { intent: { choice: 'amend_current', confidence: 0.95 } } } : undefined
  })
  const world = harness({
    script: [() => plannerSlice(), () => { throw contextWindowError() }, () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] })],
    agentOptions: {
      interactionProvider: async () => ({ content: JSON.stringify({ intent: 'amend_current', queue_conflict: false, reply: '' }) }),
      interactionDecisionProvider: amendJev,
      steeringDecisionProvider: amendJev,
    },
  })
  world.game.taskState = 'mining'
  world.game.queueLength = 1
  await world.say()
  await world.agent.request('also make it fast', { sender: 'TTLouis' })
  world.game.taskState = 'idle'
  world.game.queueLength = 0
  world.give('iron-ore', 2)
  await world.agent.completed() // the planner round hits the context window: the C5 handoff restages the planner

  const c5 = world.rows('context.restaged').find(row => row.data.checkpoint === 'C5')
  assert.ok(c5)
  assert.equal(c5.data.role, 'planner')
  const last = world.calls.at(-1).messages
  assert.ok(last.some(message => textOf(message).includes('user_amendment (from TTLouis')), 'the fresh generation holds the amendment')
  assert.equal(world.rows('amendment.dropped').length, 0)
})

test('amendment (c): the supervisor prints the drop notice, and only when there is a line', async () => {
  const { session, chat } = chatSession({ memory: { planningState: () => undefined }, traceRequest: null })
  session.announceAmendmentDropped({ chat_message: 'Your change "x" was not applied. Please send it again.' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(chat, ['Your change "x" was not applied. Please send it again.'])
  session.announceAmendmentDropped({})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(chat.length, 1, 'nothing to say without a line')
})

test('amendment (c): the supervisor activity hook routes amendment.dropped to the chat line', () => {
  const printed = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    announceAmendmentDropped: data => printed.push(data.chat_message),
    responsivenessTracker: () => ({ observe() {}, debugText: () => '' }),
    agentLive: { debug: {}, activity: [], conversation: [] },
    config: {},
    agentTimeDebugFields: () => ({}),
    agentSpendDebugFields: () => ({}),
    requestTaskBoardUiSync() {},
    agent: { traceRequest: null, epoch: null },
    lastStatus: {},
  })
  try { session.onAgentActivity('amendment.dropped', { chat_message: 'Please send it again.' }) }
  catch {} // the rest of the hook is UI bookkeeping this stub does not model
  assert.deepEqual(printed, ['Please send it again.'])
})

// --- nits ------------------------------------------------------------------------------------------------------

test('nit: round_open inside a turn is not retried (the token cannot change); it goes straight to the deferred path', async () => {
  const world = harness({ script: [() => oneStepSlice()] })
  await world.say()
  const attempts = []
  world.agent.returnControlToPlanner = async () => { attempts.push(1); return { returned: false, reason: 'round_open' } }
  world.give('iron-ore')
  await world.agent.completed()
  assert.equal(attempts.length, 1)
  assert.equal(world.rows('context.planner_resume_retried').length, 0)
  assert.equal(world.rows('executor.slice_wake_deferred')[0].data.reason, 'round_open')
})

test('nit: a deferred slice wake persists the state and tells the UI the goal is waiting (not only a completed slice)', async () => {
  const world = harness({ script: [() => oneStepSlice()] })
  await world.say()
  let persisted = 0
  const persist = world.agent.persistState.bind(world.agent)
  world.agent.persistState = async () => { persisted++; return persist() }
  const end = world.agent.endSliceWithoutPlanner.bind(world.agent)
  let persistedInEnd = 0
  world.agent.endSliceWithoutPlanner = async (args) => { const before = persisted; const result = await end(args); persistedInEnd = persisted - before; return result }
  const activity = []
  world.agent.onActivity = (event, data) => activity.push({ event, data })
  world.agent.returnControlToPlanner = async () => ({ returned: false, reason: 'round_in_flight' })
  world.give('iron-ore')
  await world.agent.completed()

  assert.ok(persistedInEnd >= 1, 'endSliceWithoutPlanner persisted the state')
  const events = activity.map(item => item.event)
  assert.ok(events.indexOf('executor.slice_wake_deferred') > events.indexOf('request.completed'), 'the waiting marker is the last word, after the idle of request.completed')
  const update = liveAgentEvent('executor.slice_wake_deferred', activity.find(item => item.event === 'executor.slice_wake_deferred').data)
  assert.equal(update.phase, 'waiting')
  assert.match(update.detail, /waiting for Resume/)
})
