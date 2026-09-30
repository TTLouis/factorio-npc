import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentContext } from './agent-context.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, getContextRestages, PLANNING_EVENT, shelfRefinementCandidates } from './planning-state.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { configuration, Session } from './supervisor.mjs'
import { PlanTiming } from './plan-time-estimate.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { buildVerifiedResults, VERIFIED_RESULTS_HEADER } from './verified-results.mjs'

// Delegation U7: planner wiring. The planner conversation is restaged at a slice
// close (C1) or a shelf pickup (C2) only under the token size rule, and always
// receives one harness-built verified-results message. Static scenarios: a fake
// Factorio and scripted replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const FINITE_GOAL = { ...GOAL, scope: 'finite' }
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const REQUEST_TEXT = 'get steam power going and run an electric mining drill on iron ore'

// A slice is two provider calls: author it, then the claim that closes it. The
// provider reports `tokens(callNumber)` prompt tokens (undefined: no usage at all).
function plannerHarness({ shelf = true, tokens = call => call * 3000, softLimit, models, deterministic = false, extraOptions = {} } = {}) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [], slicesAuthored: 0, snapshots: [] }
  const withUsage = (message, call) => {
    const promptTokens = tokens(call)
    if (promptTokens !== undefined) {
      Object.defineProperty(message, '_sglunaProvider', {
        enumerable: false,
        value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: promptTokens, completion_tokens: 450, total_tokens: promptTokens + 450 } },
      })
    }
    return message
  }
  const provider = async (messages, context) => {
    world.calls.push({ messages: messages.map(message => ({ ...message })), context })
    const call = world.calls.length
    assert.ok(call < 40, 'planner loop did not terminate')
    world.snapshots.push(memory.planningState(KEY))
    if (deterministic || call % 2 === 1) {
      world.slicesAuthored++
      return withUsage(planReply({
        plan: [`Gather 10 iron ore (slice ${world.slicesAuthored})`],
        operations: [gather('iron-ore', 10)],
        // Deterministic mode: the game's inventory closes the step, so the slice
        // closes from the completion signal, outside any model turn.
        ...(deterministic ? { checkpoint: inventoryCheckpoint('iron-ore', 10 * world.slicesAuthored) } : {}),
        ...(world.slicesAuthored === 1 ? { goal: shelf ? GOAL : FINITE_GOAL, ...(shelf ? { roadmap: SHELF } : {}) } : {}),
      }), call)
    }
    return withUsage(planReply({
      chatMessage: 'Slice mined.',
      plan: [],
      currentStep: 0,
      operations: [],
      semanticCompletion: { stepId: memory.currentPlan(KEY)?.task_board?.active_step_id, rationale: 'The completed gather batch grounds this prose-only step.' },
    }), call)
  }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    maxProviderOutputUnits: 100000,
    maxContinuations: 64,
    provider: models ? models.provider(provider) : provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'planner wiring test',
    goalDefinitionPolicy: 'required',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...(softLimit !== undefined ? { restageSoftLimitTokens: softLimit } : {}),
    ...extraOptions,
  })
  world.agent.behaviorTrace = { emit: async record => { world.trace.push(record) } }
  world.rows = name => world.trace.filter(record => record.event === name)
  // The reducer state just before each CONTEXT_RESTAGED event is applied.
  world.beforeRestage = []
  const dispatch = memory.dispatchPlanningEvent.bind(memory)
  memory.dispatchPlanningEvent = (key, event) => {
    if (event?.type === PLANNING_EVENT.CONTEXT_RESTAGED) world.beforeRestage.push(memory.planningState(key))
    return dispatch(key, event)
  }
  world.say = () => world.agent.request(REQUEST_TEXT, { sender: 'TTLouis' })
  world.closeSlice = async () => {
    game.inventory['iron-ore'] = (game.inventory['iron-ore'] ?? 0) + 10
    return world.agent.completed()
  }
  return world
}

const modMessages = messages => messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('[MOD] The current immutable plan slice is verified complete'))

// --- verified-results message -------------------------------------------------------------

test('an unmet-doneWhen slice close wakes the planner with the verified-results message and no raw tool traffic', async () => {
  const world = plannerHarness({ softLimit: 1_000_000 })
  await world.say()
  // The harness's time record of the step (estimate from game rates, wall clock at the close).
  const stepId = getActivePlan(world.memory.planningState(KEY)).steps[0].step_id
  world.agent.planTiming.steps.set('fixture', { goal_id: 'g', step_id: stepId, step_index: 0, started_at: 0, closed: true, timed: true, expected_seconds: 45, elapsed_wall_seconds: 52 })
  await world.closeSlice()

  assert.ok(world.calls.length >= 3, 'the planner was woken for the next slice')
  const wake = modMessages(world.calls[2].messages)
  assert.equal(wake.length, 1, 'exactly one slice-close message')
  const text = wake[0].content
  assert.ok(text.includes(VERIFIED_RESULTS_HEADER))
  assert.equal(text.split('[VERIFIED_RESULTS]').length - 1, 1, 'one verified-results block')

  // Reducer evidence and receipts of the closed plan.
  const plan = getActivePlan(world.snapshots[2])
  const step = plan.steps[0]
  assert.ok(plan.execution.step_progress[step.step_id].accepted_evidence.length > 0, 'the closed step has accepted evidence')
  for (const item of plan.execution.step_progress[step.step_id].accepted_evidence) assert.ok(text.includes(item.ref), `evidence ref ${item.ref}`)
  const receipts = plan.execution.receipts[step.step_id]
  assert.ok(receipts.length > 0, 'the reducer ledger holds receipts for the step')
  assert.ok(text.includes(`receipt ${receipts.at(-1).kind} ${receipts.at(-1).ref}`))
  assert.match(text, /plan \S+ v1 is COMPLETED; 1\/1 steps verified by the harness/)
  // Goal progress per doneWhen, and the goal is never declared done.
  assert.match(text, /goal progress \(read from the game at this slice close\): 0\/1 doneWhen conditions met/)
  assert.match(text, /doneWhen unmet: .*rocket.* - /)
  assert.match(text, /this message never claims the goal is done/)
  assert.doesNotMatch(text, /goal is (?:verified )?complete/i)
  // Time: harness estimate against wall clock.
  assert.match(text, /step 1 time: estimated 45 s, measured 52 s/)
  assert.match(text, /time: estimated 45 s over 1\/1 steps with a game-rate estimate; measured 52 s over 1\/1 steps/)
  // No raw traffic: no tool calls, tool results or task board dump.
  assert.doesNotMatch(text, /tool_calls|getActorStatus|"task_board"|gather_resource/)
  assert.equal(world.game.inventory['iron-ore'], 10)
})

test('the verified-results builder reads reducer state and the explicit records only, never the task board', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: 'goal_vr', owner: 'louis', objective: 'Run a drill',
  })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.GOAL_DEFINED, now: 11, source: 'main_planner', goal_id: 'goal_vr',
    definition: { scope: 'long_horizon', summary: 'Run a drill.', doneWhen: [{ id: 'plates', kind: 'items_produced', item_name: 'iron-plate', minimum: 100 }] },
  })
  const guarded = { ...state }
  Object.defineProperty(guarded, 'task_board', { enumerable: true, get() { throw new Error('the task board was read') } })
  const result = buildVerifiedResults({ planningState: guarded })
  assert.match(result.text, /^\[VERIFIED_RESULTS\]/)
  assert.match(result.text, /no plan is recorded for this slice/)
  assert.match(result.text, /the game could not be read just now/)
  assert.equal(result.over_limit, false)
  // Same input, same bytes.
  assert.equal(buildVerifiedResults({ planningState: guarded }).text, result.text)
})

test('the verified-results message is bounded: over the limit whole records drop, receipts first', async () => {
  const world = plannerHarness({ softLimit: 1_000_000 })
  await world.say()
  await world.closeSlice()
  const state = world.snapshots[2]
  const full = buildVerifiedResults({ planningState: state })
  const small = buildVerifiedResults({ planningState: state, limits: { maxChars: full.chars - 5 } })
  assert.ok(small.dropped.length > 0)
  assert.ok(small.dropped[0].startsWith('receipt_'), 'receipts drop before evidence refs')
  assert.ok(small.chars < full.chars)
  assert.match(small.text, /doneWhen unmet/, 'goal progress is never dropped')
  assert.match(small.text, /step 1 \S+ completed/, 'step lines are never dropped')
})

test('the timing record keeps the measured wall clock at a step close, and closedStepTimes reports estimate and measurement', () => {
  let now = 1000
  const timing = new PlanTiming({ now: () => now })
  timing.steps.set('g|s1', { goal_id: 'g', step_id: 's1', step_index: 0, started_at: 1000, actor_id: 'a', epoch: 1, expected_seconds: 45, timed: true, closed: false, batches: 1, hand_mined_items: 0, lower_bound: false })
  now = 53_000
  timing.closeStep({ active_step_id: 's1' }, { actorId: 'a', epoch: 1 }, now)
  assert.deepEqual(timing.closedStepTimes(['s1', 's2']), [
    { step_id: 's1', expected_seconds: 45, machine_wait_seconds: undefined, elapsed_wall_seconds: 52 },
    { step_id: 's2' },
  ])
})

// --- the size rule ------------------------------------------------------------------------

test('below the soft limit there is no restage: the history is left as is and the wake still carries the verified results', async () => {
  const world = plannerHarness({ softLimit: 100_000 })
  await world.say()
  await world.closeSlice()

  assert.equal(world.rows('context.restaged').length, 0)
  assert.equal(world.rows('context.restage_refused').length, 0)
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 0)
  assert.equal(world.agent.agentContext.restageCount, 0)
  const next = world.calls[2].messages
  assert.ok(next.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')), 'the original request is still in the conversation')
  assert.ok(!next.some(message => typeof message.content === 'string' && message.content.startsWith('[HANDOFF]')))
  assert.equal(modMessages(next).length, 1)
  assert.match(modMessages(next)[0].content, /\[VERIFIED_RESULTS\]/)
  // Unrestaged planner rounds carry no role or handoff attribution: unchanged from before U7.
  assert.equal(Object.hasOwn(world.calls[2].context, 'role'), false)
  assert.equal(Object.hasOwn(world.rows('provider.request').at(-1).data, 'handoff_id'), false)
})

test('above the soft limit at a slice close with no shelf node to pick up, the planner restages at C1: the next request holds only the packet and the plan is untouched', async () => {
  const world = plannerHarness({ shelf: false, softLimit: 5000 })
  await world.say()
  await world.closeSlice()

  const [row] = world.rows('context.restaged')
  assert.ok(row, 'a context.restaged row was written')
  assert.equal(row.data.role, 'planner')
  assert.equal(row.data.checkpoint, 'C1')
  assert.equal(row.data.reason, 'context_over_soft_limit_at_slice_close')
  assert.equal(row.data.soft_limit_tokens, 5000)
  assert.ok(row.request_id, 'the row carries the request id the detectors group by')
  assert.equal(world.rows('context.restage_refused').length, 0)

  const restages = getContextRestages(world.memory.planningState(KEY))
  assert.equal(restages.length, 1)
  assert.equal(restages[0].checkpoint, 'C1')
  assert.equal(restages[0].role, 'planner')
  assert.equal(restages[0].handoff_id, row.data.handoff_id)

  // The request after the wake starts with the system prefix and the packet, and
  // holds none of the earlier conversation.
  const { messages, context } = world.calls[2]
  assert.equal(messages[0].content, world.calls[0].messages[0].content, 'the system prefix is unchanged')
  assert.match(messages[1].content, /^\[HANDOFF\] /)
  assert.match(messages[2].content, /^--- step block ---/)
  assert.ok(messages[2].content.includes('restage: role=planner checkpoint=C1'))
  assert.ok(!messages.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')), 'the old request text is gone')
  assert.ok(!messages.some(message => message.role === 'assistant'), 'no earlier assistant reply is carried')
  assert.equal(modMessages(messages).length, 1, 'the wake still carries the verified-results message')
  assert.match(modMessages(messages)[0].content, /\[VERIFIED_RESULTS\]/)
  assert.equal(context.role, 'planner', 'once restaged, the provider is told which role this conversation runs as')
  assert.equal(world.rows('provider.request').at(-1).data.handoff_id, row.data.handoff_id)

  // Plan, tracker and reasoning epoch are untouched by the restage: only the restage ledger moved.
  assert.equal(world.beforeRestage.length, 1)
  const before = world.beforeRestage[0]
  const after = world.snapshots[2]
  assert.deepEqual({ ...after, context_restages: before.context_restages }, before)
  assert.equal(after.reasoning_epoch, before.reasoning_epoch)
  assert.equal(after.active_plan_id, before.active_plan_id)
  assert.equal(getActivePlan(after).active_step_index, getActivePlan(before).active_step_index)
  assert.equal(getActivePlan(after).status, getActivePlan(before).status)
})

test('a C2 restage at shelf pickup carries the shelf candidates in the packet', async () => {
  const world = plannerHarness({ shelf: true, softLimit: 5000 })
  await world.say()
  await world.closeSlice()

  const [row] = world.rows('context.restaged')
  assert.ok(row)
  assert.equal(row.data.checkpoint, 'C2')
  assert.equal(row.data.role, 'planner')
  const candidates = shelfRefinementCandidates(world.beforeRestage[0], { limit: 5 })
  assert.ok(candidates.length > 0, 'the shelf has a node to pick up')
  const { messages } = world.calls[2]
  const packetText = `${messages[1].content}\n${messages[2].content}`
  assert.ok(messages[2].content.includes('restage: role=planner checkpoint=C2'))
  candidates.forEach((candidate, index) => {
    assert.ok(packetText.includes(`shelf_candidate ${index + 1}: ${candidate.node_id} [${candidate.status}]: ${candidate.intent}`), `candidate ${candidate.node_id}`)
  })
  assert.ok(!messages.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')))
  assert.equal(modMessages(messages).length, 1)
})

test('shelf candidates ride the packet step block only: the stable plan block is byte-identical, and over the limit they drop after receipts and before the roadmap node', async () => {
  const world = plannerHarness({ softLimit: 1_000_000 })
  await world.say()
  const state = world.memory.planningState(KEY)
  const candidates = shelfRefinementCandidates(state, { limit: 5 })
  assert.ok(candidates.length > 0)
  const args = { planningState: state, role: 'planner', checkpoint: 'C2', reason: 'r', now: 5000 }
  const plain = buildHandoffPacket(args)
  const withShelf = buildHandoffPacket({ ...args, shelfCandidates: candidates })
  assert.equal(withShelf.stableText, plain.stableText, 'the cache prefix does not move')
  assert.ok(!plain.volatileText.includes('shelf_candidate'))
  assert.ok(withShelf.volatileText.includes('shelf_candidate 1: '))
  assert.notEqual(withShelf.hash, plain.hash)
  assert.equal(buildHandoffPacket({ ...args, shelfCandidates: candidates }).text, withShelf.text, 'same input, same bytes')

  const squeezed = buildHandoffPacket({ ...args, shelfCandidates: candidates, budget: 'effort low', limits: { maxChars: withShelf.chars - 3 } })
  assert.ok(squeezed.dropped.length > 0)
  const firstShelf = squeezed.dropped.findIndex(key => key.startsWith('shelf_candidate_'))
  assert.ok(firstShelf >= 0)
  assert.ok(squeezed.dropped.indexOf('budget') < firstShelf, 'budget goes before the shelf candidates')
  assert.ok(!squeezed.dropped.includes('roadmap_node') || squeezed.dropped.indexOf('roadmap_node') > firstShelf)
})

test('the hard limit is 2x the soft limit: a slice close past either limit restages, and the reason names which', async () => {
  // 7,000 tokens is past soft (5,000) and below hard (10,000): still a slice-close restage.
  const world = plannerHarness({ shelf: false, softLimit: 5000, tokens: call => call * 3500 })
  await world.say()
  await world.closeSlice()
  assert.equal(world.rows('context.restaged').length, 1)
  assert.equal(world.rows('context.restaged')[0].data.reason, 'context_over_soft_limit_at_slice_close')

  // Past the hard limit at a slice close: same checkpoint, hard-limit reason.
  const hard = plannerHarness({ shelf: false, softLimit: 2000, tokens: call => call * 3000 })
  await hard.say()
  await hard.closeSlice()
  assert.equal(hard.rows('context.restaged')[0].data.reason, 'context_over_hard_limit_at_slice_close')
})

test('provider-reported input tokens drive the size; chars/4 is the fallback before the first reply', async () => {
  // Reported: 6,000 tokens for a small conversation. chars/4 alone (a few hundred tokens) would not restage.
  const reported = plannerHarness({ shelf: false, softLimit: 5000, tokens: call => call * 3000 })
  await reported.say()
  assert.ok(reported.agent.agentContext.sizeTokens >= 3000, 'the first reply reported 3,000 input tokens')
  assert.ok(reported.agent.agentContext.sizeTokens < 5000)
  await reported.closeSlice()
  assert.equal(reported.rows('context.restaged').length, 1)
  const chars = reported.rows('provider.request')[0].data.message_chars
  assert.ok(Math.ceil(chars / 4) < 5000, `chars/4 of the first request (${Math.ceil(chars / 4)}) is below the limit`)

  // No usage at all: the size is the chars/4 estimate of what was sent.
  const estimated = plannerHarness({ shelf: false, softLimit: 100, tokens: () => undefined })
  await estimated.say()
  const firstChars = estimated.rows('provider.request')[0].data.message_chars
  assert.equal(estimated.agent.agentContext.sizeTokens, Math.ceil(firstChars / 4), 'no reply usage yet: chars/4')
  await estimated.closeSlice()
  assert.equal(estimated.rows('context.restaged').length, 1, 'chars/4 alone passed the soft limit')

  // And with a soft limit above both, neither restages.
  const quiet = plannerHarness({ shelf: false, softLimit: 1_000_000, tokens: () => undefined })
  await quiet.say()
  await quiet.closeSlice()
  assert.equal(quiet.rows('context.restaged').length, 0)
})

test('the soft limit defaults to the working-context ceiling in tokens and follows it; an explicit option wins per role', () => {
  const world = plannerHarness()
  const agent = world.agent
  assert.equal(agent.restageSoftLimitTokens('planner'), Math.ceil(agent.maxWorkingChars / 4))
  agent.applyContextWindowCeiling(1_000_000, 'provider_response')
  assert.equal(agent.restageSoftLimitTokens('planner'), Math.ceil(agent.maxWorkingChars / 4))
  assert.equal(agent.restageSoftLimitTokens('planner'), 375_000)
  const perRole = plannerHarness({ extraOptions: { restageSoftLimitTokens: { planner: 1234 } } }).agent
  assert.equal(perRole.restageSoftLimitTokens('planner'), 1234)
  assert.equal(perRole.restageSoftLimitTokens('executor'), Math.ceil(perRole.maxWorkingChars / 4), 'a role with no explicit limit keeps the default')
})

// --- the seam contract --------------------------------------------------------------------

test('a restage that cannot happen now (a turn is open, no token) is retried at the next slice close, never an error', async () => {
  const world = plannerHarness({ shelf: false, softLimit: 5000 })
  await world.say()
  const state = world.memory.planningState(KEY)
  world.agent.agentContext.beginRequest(80_000) // the size counter is past the soft limit
  // Another async flow holds a turn: the wake path passes no safePoint.
  world.agent.turnConversation = world.agent.agentContext.beginRequest(1)
  const refused = await world.agent.planSliceCloseWake({ route: 'next_shelf_slice', planningState: state, withinTurn: false })
  assert.equal(refused.restaged, false)
  assert.match(refused.verifiedResults, /^\[VERIFIED_RESULTS\]/)
  assert.deepEqual(world.rows('context.restage_refused').map(row => row.data.reason), ['round_open'])
  assert.equal(world.rows('context.restaged').length, 0)

  // The next boundary, with the turn closed: it restages.
  world.agent.turnConversation = null
  const retried = await world.agent.planSliceCloseWake({ route: 'next_shelf_slice', planningState: world.memory.planningState(KEY), withinTurn: false })
  assert.equal(retried.restaged, true)
  assert.equal(world.rows('context.restaged').length, 1)
})

test('a slice that closes from the completion signal (outside any turn) restages with no safePoint, and the wake proceeds on the packet', async () => {
  const world = plannerHarness({ shelf: true, softLimit: 5000, deterministic: true, tokens: () => 6000 })
  const args = []
  const original = world.agent.restageContext.bind(world.agent)
  world.agent.restageContext = async (call) => { args.push(call); return original(call) }
  await world.say()
  assert.equal(world.calls.length, 1)
  await world.closeSlice() // completed(): the gather is verified by the inventory checkpoint, no planner claim
  assert.equal(world.calls.length, 2, 'the planner was woken for the next slice')
  assert.equal(args.length, 1)
  assert.equal(args[0].safePoint, undefined, 'no token outside a turn')
  const [row] = world.rows('context.restaged')
  assert.equal(row.data.checkpoint, 'C2')
  const { messages } = world.calls[1]
  assert.match(messages[1].content, /^\[HANDOFF\] /)
  assert.ok(!messages.some(message => typeof message.content === 'string' && message.content.startsWith('[CHAT]')))
  assert.match(modMessages(messages)[0].content, /\[VERIFIED_RESULTS\]/)
  assert.equal(world.rows('context.restage_refused').length, 0)
})

test('an in-turn slice close presents the turn token through restageAtTurnBoundary, and the completion-signal wake passes none', async () => {
  const world = plannerHarness({ shelf: false, softLimit: 5000 })
  const seen = []
  const original = world.agent.restageContext.bind(world.agent)
  world.agent.restageContext = async (args) => {
    seen.push({ safePoint: args.safePoint, token: world.agent.turnToken })
    return original(args)
  }
  await world.say()
  await world.closeSlice()
  // The claim that closes the slice is an in-turn reply: the wake ran inside the turn.
  assert.equal(seen.length, 1)
  assert.ok(seen[0].safePoint, 'a token was presented')
  assert.strictEqual(seen[0].safePoint, seen[0].token, 'the running turn\'s own token')
  assert.equal(world.rows('context.restaged').length, 1)
  assert.equal(world.rows('context.restage_refused').length, 0)
  assert.notEqual(seen[0].safePoint, true)

  // Outside a turn the helper passes nothing (a token with no open turn would be refused).
  const outside = plannerHarness({ shelf: false, softLimit: 5000 })
  await outside.say()
  const args = []
  const spy = outside.agent.restageContext.bind(outside.agent)
  outside.agent.restageContext = async (call) => { args.push(call); return spy(call) }
  const state = outside.memory.planningState(KEY)
  const packet = buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C1', reason: 'r', now: 5000 })
  const result = await outside.agent.restageAtTurnBoundary({ checkpoint: 'C1', reason: 'r', packet })
  assert.equal(args[0].safePoint, undefined)
  assert.equal(result.restaged, true)
})

test('a restaged planner lineage restages again at a later slice close and never keeps growing', async () => {
  const world = plannerHarness({ shelf: false, softLimit: 5000, tokens: call => 6000 })
  await world.say()
  await world.closeSlice()
  await world.closeSlice()
  const handoffs = world.rows('context.restaged').map(row => row.data.handoff_id)
  assert.equal(handoffs.length, 2)
  assert.equal(new Set(handoffs).size, 2, 'every restage is its own conversation')
  assert.equal(getContextRestages(world.memory.planningState(KEY)).length, 2)
})

// --- roles ----------------------------------------------------------------------------------

function baseEnv(overrides = {}) {
  return {
    SGLUNA_ACTOR_MODE: 'npc',
    OPENAI_API_KEY: `fixture-key-${'x'.repeat(20)}`,
    OPENAI_MODEL: 'flash-model',
    OPENAI_API_BASEURL: 'https://provider.example.test/v1',
    ...overrides,
  }
}

// The loop's provider goes through the real Session.roleProvider, so the model a
// planner round runs on is the one agent-roles resolves for the context's role.
function roleModels(env) {
  const config = configuration({}, baseEnv(env))
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

test('a config with no second model runs every planner round on models[0], and sends the pre-U7 context', async () => {
  const models = roleModels({ OPENAI_MODEL: 'flash-model' })
  const world = plannerHarness({ softLimit: 1_000_000, models, extraOptions: { agentRoleConfig: models.config } })
  await world.say()
  await world.closeSlice()
  assert.ok(models.requests.length >= 3)
  assert.deepEqual([...new Set(models.requests.map(request => request.model))], ['flash-model'])
  // Single-model: naming the role would change nothing, so it is not sent (byte-identical requests).
  for (const request of models.requests) assert.equal(Object.hasOwn(request.context, 'role'), false)
})

test('a two-model config sends every planner round with role planner, so it runs on models[0]', async () => {
  const models = roleModels({ OPENAI_MODEL: 'draft-model, exec-model' })
  const world = plannerHarness({ softLimit: 1_000_000, models, extraOptions: { agentRoleConfig: models.config } })
  await world.say()
  await world.closeSlice()
  assert.ok(models.requests.length >= 3)
  assert.deepEqual([...new Set(models.requests.map(request => request.model))], ['draft-model'])
  for (const request of models.requests) assert.equal(request.context.role, 'planner')
  // A planner restage keeps it on the planner model.
  const restaging = roleModels({ OPENAI_MODEL: 'draft-model, exec-model' })
  const restaged = plannerHarness({ shelf: false, softLimit: 5000, models: restaging, extraOptions: { agentRoleConfig: restaging.config } })
  await restaged.say()
  await restaged.closeSlice()
  assert.equal(restaged.rows('context.restaged').length, 1)
  assert.deepEqual([...new Set(restaging.requests.map(request => request.model))], ['draft-model'])
  assert.equal(restaging.requests.at(-1).context.role, 'planner')
})

test('rolesDiffer is false with one model and true with two', () => {
  assert.equal(new AgentContext({ config: configuration({}, baseEnv()) }).rolesDiffer, false)
  assert.equal(new AgentContext({ config: configuration({}, baseEnv({ OPENAI_MODEL: 'a,b' })) }).rolesDiffer, true)
  assert.equal(new AgentContext({ config: configuration({}, baseEnv({ OPENAI_MODEL: 'a,a' })) }).rolesDiffer, false)
  assert.equal(new AgentContext().rolesDiffer, false)
})