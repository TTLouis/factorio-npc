import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { buildHandoffPacket, HANDOFF_PACKET_LIMITS } from './handoff-packet.mjs'
import {
  applyShelfRanking,
  ADVISORY_WAIT_MS,
  c4Questions,
  C4_MIN_CONFIDENCE,
  nextStepClarity,
  OBSERVATION_RESTAGE_CHECKPOINTS,
  PACKET_FACT_CHARS,
  parseC4Choice,
  parseShelfRanking,
  shelfRankingQuestions,
} from './jev-checkpoints.mjs'
import { effectiveStage, emptyLedger, recordJudgment, restoreLedger, scoreC4Judgment, scoreJudgment, serializeLedger, summarizeLedger } from './jev-judgments.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { recoverInterruptedAgentPlan } from './supervisor.mjs'
import { DECISION_PROVIDER_DEFAULTS, normalizeDecisionProviderRequest } from './provider.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'
import { analyzeBehaviorTrace, formatCheckReport, JEV_TRACE_ROWS } from './run-check.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'
import { buildRunRecord, formatRunRecord } from './think-time-report.mjs'

// U11: Jev at the delegation checkpoints. Static scenarios: scripted model replies, a scripted Jev decision
// provider in the live response shape, a fake Factorio. Nothing here calls a provider.

const KEY = 'npc:sgluna'
const REQUEST_TEXT = 'get steam power going and run an electric mining drill on iron ore'
const GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore' },
  { id: 'node_lab', intent: 'a lab researching automation' },
]
const SHELF_SEVEN = Array.from({ length: 7 }, (_, index) => ({ id: `n${index + 1}`, intent: `shelf intent number ${index + 1}`, why_it_matters: `why ${index + 1} matters` }))
const TWO_STEPS = ['Gather 10 iron ore', 'Gather 10 copper ore']
const COPPER_CONTRACT = inventoryCheckpoint('copper-ore', 10)
const U11_CONTRACTS = new Set(['c4_next_step_route', 'restage_observation_families', 'shelf_ranking'])

const plannerSlice = (overrides = {}) => planReply({
  plan: TWO_STEPS,
  currentStep: 0,
  operations: [gather('iron-ore', 10)],
  checkpoint: inventoryCheckpoint('iron-ore', 10),
  goal: GOAL,
  roadmap: SHELF,
  ...overrides,
})
const oneStepSlice = (overrides = {}) => plannerSlice({ plan: ['Gather 10 iron ore'], ...overrides })
const plannerNextSlice = (overrides = {}) => planReply({
  plan: ['Gather 10 coal'],
  currentStep: 0,
  operations: [gather('coal', 10)],
  checkpoint: inventoryCheckpoint('coal', 10),
  ...overrides,
})
const observation = () => ({
  tool_calls: [{ id: 'call_exec_obs', index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }],
})
const executorStep = (overrides = {}) => planReply({ plan: TWO_STEPS, currentStep: 1, operations: [gather('copper-ore', 10)], checkpoint: COPPER_CONTRACT, ...overrides })

function usageOf(promptTokens, completionTokens = 450) {
  return { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }
}

// Jev in the live provider shape. `answers[id]` is an answer object or a function (state, questions) returning one
// (or undefined to keep the fixture default). Every request is checked against the live request limits by
// recordingJev, exactly as the other Jev fixtures are.
function scriptedJev(answers = {}, { onCall, throwFor } = {}) {
  return recordingJev(async (state, questions, call, context) => {
    await onCall?.(state, questions, call, context)
    if (throwFor?.(state, questions)) throw new Error('Decision provider timed out after 5000 ms')
    const overrides = {}
    for (const [id, answer] of Object.entries(answers)) {
      if (!questions[id]) continue
      const value = typeof answer === 'function' ? answer(state, questions) : answer
      if (value !== undefined) overrides[id] = value
    }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  })
}

const directAnswer = { choice: 'direct_to_executor', confidence: 0.9 }
const groundAnswer = { choice: 'ground_first', confidence: 0.9 }
const restageOnly = answer => (state) => (state?.contract === 'restage_observation_families' ? answer : undefined)
const u11Calls = jev => jev.calls.filter(call => U11_CONTRACTS.has(call.state?.contract))
const otherCalls = jev => jev.calls.filter(call => !U11_CONTRACTS.has(call.state?.contract))

function harness({ script, jev = scriptedJev({ next_step_route: directAnswer }), tokens, agentOptions = {}, game: sharedGame, stateFile = null, memory: sharedMemory, noJev = false, settle = true } = {}) {
  const game = sharedGame ?? new FakeFactorio()
  const memory = sharedMemory ?? new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [], script, jev }
  world.provider = async (messages, context) => {
    world.calls.push({ messages: messages.map(message => ({ ...message })), context })
    const call = world.calls.length
    const reply = script[call - 1]
    assert.ok(reply, `unscripted provider call ${call}`)
    const message = typeof reply === 'function' ? await reply(messages, context, world) : { ...reply }
    const promptTokens = tokens?.(call, context)
    if (promptTokens !== undefined && message && typeof message === 'object') Object.defineProperty(message, '_sglunaProvider', { enumerable: false, value: usageOf(promptTokens) })
    return message
  }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: world.provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    ...(noJev ? {} : { interactionDecisionProvider: jev, steeringDecisionProvider: jev }),
    systemPrompt: 'jev checkpoints test system prompt',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...agentOptions,
  })
  world.agent.behaviorTrace = { emit: async (record) => { world.trace.push(record) } }
  // Shadow judgments are never awaited by the loop. A test that reads their rows lets them settle after each entry point
  // (`settle: false` leaves the agent exactly as the loop runs it, for the timing tests).
  world.settle = () => world.agent.jev.idle()
  if (settle) {
    for (const name of ['request', 'completed', 'failed']) {
      const original = world.agent[name].bind(world.agent)
      world.agent[name] = async (...args) => {
        try { return await original(...args) }
        finally { await world.agent.jev.idle() }
      }
    }
  }
  world.rows = event => world.trace.filter(record => record.event === event)
  world.say = () => world.agent.request(REQUEST_TEXT, { sender: 'TTLouis' })
  world.give = (item, count = 10) => { game.inventory[item] = (game.inventory[item] ?? 0) + count }
  world.plan = () => getActivePlan(memory.planningState(KEY))
  world.ledger = () => world.agent.jev.ledger
  return world
}

// The committed plan's second step gets a deterministic completion contract, on the board and in the reducer
// (what a planner that proposed a contract for every step before the commit would have produced).
function contractSecondStep(world, contract = COPPER_CONTRACT) {
  const board = world.memory.planByNpc.get(KEY).task_board
  board.steps[1] = { ...board.steps[1], completion_contract: structuredClone(contract), completion_contract_at: Date.now() }
  const state = structuredClone(world.memory.planningState(KEY))
  getActivePlan(state).steps[1].completion_contract = structuredClone(contract)
  world.memory.planningByNpc.set(KEY, state)
}

// Force a family to a stage by restoring a ledger whose evidence supports it: no shortcut around the gates.
function forcedLedger(family, stage, { samples = [] } = {}) {
  const saved = serializeLedger(emptyLedger())
  const scored = stage === 'deciding' ? 60 : stage === 'advisory' ? 30 : 0
  saved.families[family] = { ...saved.families[family], stage, scored, agreed: scored, evidence: scored, window: Array.from({ length: scored }, () => 1), samples }
  const restored = restoreLedger(saved)
  assert.deepEqual(restored.clamped, [], 'the forced stage is supported by its evidence')
  assert.equal(effectiveStage(restored.ledger, family), stage)
  return restored.ledger
}

const forceStage = (world, family, stage, options) => { world.memory.jevLedger = forcedLedger(family, stage, options) }

// Ids, timestamps and handoff ids are the only nondeterministic parts of a run.
function normalize(value) {
  return JSON.stringify(value)
    .replace(/(?<!\d)1[6-9]\d{11}(?!\d)/g, '<epoch_ms>')
    .replace(/\breq_[a-z0-9]+_\d+/g, '<req>')
    .replace(/\bgoal_[a-z0-9]{4,10}_\d+/g, '<goal>')
    .replace(/(?<=_s\d+_)[a-z0-9]{4,10}(?![a-z0-9])/g, '<sid>')
    .replace(/\bho_[0-9a-f]{12}\b/g, '<ho>')
    .replace(/\bdecision_[a-z0-9_]+/g, '<decision>')
}

const textOf = message => (typeof message?.content === 'string' ? message.content : '')
const stepBlock = messages => messages.find(message => textOf(message).startsWith('--- step block ---'))
const stableBlock = messages => messages.find(message => textOf(message).startsWith('[HANDOFF]'))
const isU11Row = record => record.event.startsWith('jev.') || record.event.startsWith('c4.')

// Step 1 closes on the game; the executor wakes for step 2; step 2 closes on the game; the slice closes.
async function runSliceWithContractedStep2(world) {
  await world.say() // the planner commits (call 1) and the executor takes over
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed() // step 1 verified -> C4 -> the executor wakes
  world.give('copper-ore')
  await world.agent.completed() // step 2 verified by the gate -> the slice closes -> the planner wakes
}

const SLICE_TOKENS = call => 1000 * call // the provider reports prompt tokens per call; completion is 450

// ---------------------------------------------------------------------------------------------------------------
// Deterministic clearness of the next committed step (pure)
// ---------------------------------------------------------------------------------------------------------------

function planningWithTwoSteps({ secondContract = COPPER_CONTRACT, closeFirst = true, goalStatus = 'active' } = {}) {
  const at = 1_700_000_000_000
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: at, goal_id: 'goal_c4', owner: 'tester', objective: 'gather plates' })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: at,
    origin: 'live_task_board',
    roadmap_node_ids: [],
    steps: [
      { description: 'Gather 10 iron ore', completion_contract: inventoryCheckpoint('iron-ore', 10) },
      { description: 'Gather 10 copper ore', ...(secondContract ? { completion_contract: secondContract } : {}) },
    ],
  })
  const planId = getActivePlan(state).plan_id
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: at, plan_id: planId, runtime_validation: { passed: true } })
  if (closeFirst) {
    const first = getActivePlan(state).steps[0]
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
      now: at,
      plan_id: planId,
      step_id: first.step_id,
      evidence: { source: 'runtime_receipt', kind: 'legacy_board_verified_evidence', ref: 'batch_1', satisfied_requirement_ids: ['iron-ore_target'] },
    })
    state = applyPlanningEvent(state, { type: PLANNING_EVENT.STEP_COMPLETED, now: at, source: 'runtime', plan_id: planId, step_id: first.step_id })
  }
  if (goalStatus !== 'active') state = { ...state, goal: { ...state.goal, status: goalStatus } }
  return state
}

const RECEIPT = { view: { last_completed_batch: { batch_id: 7 } }, providerStatus: {} }

test('nextStepClarity: clear only when every deterministic check holds (contract, receipts, no blocker, no amendment, a step just closed)', () => {
  const clear = nextStepClarity({ planningState: planningWithTwoSteps(), receipt: RECEIPT })
  assert.equal(clear.clear, true, clear.failed_checks.join(','))
  assert.deepEqual(clear.failed_checks, [])
  assert.deepEqual(clear.evidence, { contract_specified: true, facts_in_receipts: true, no_blocker: true, no_pending_amendment: true, no_runtime_work: true, entities_named: 0 })
  assert.equal(clear.next_step.index, 1)
  assert.equal(clear.next_step.contract, 'all: inventory_count copper-ore>=10')
  assert.deepEqual(clear.next_step.requirement_kinds, ['inventory_count'])
  assert.equal(clear.closed_count, 1)
  assert.equal(clear.total_steps, 2)

  const failing = (overrides, expected) => {
    const result = nextStepClarity({ planningState: planningWithTwoSteps(), receipt: RECEIPT, ...overrides })
    assert.equal(result.clear, false, JSON.stringify(overrides))
    assert.ok(result.failed_checks.includes(expected), `${expected} in ${result.failed_checks}`)
    return result
  }
  failing({ pendingAmendment: true }, 'pending_amendment')
  failing({ receipt: { view: {}, providerStatus: {} } }, 'no_completion_receipt')
  failing({ boundary: 'failure' }, 'not_a_completion_boundary')
  failing({ runtime: { runtimeHealthy: true, runtimeReason: 'condition_wait_active' } }, 'authoritative_runtime_active')
  failing({ board: { blocker: 'no water in reach' } }, 'blocker_or_pause_on_board')
  failing({ board: { pause_reason: 'user_pause' } }, 'blocker_or_pause_on_board')
  assert.ok(nextStepClarity({ planningState: planningWithTwoSteps({ goalStatus: 'paused' }), receipt: RECEIPT }).failed_checks.includes('goal_not_active'))
  assert.ok(nextStepClarity({ planningState: planningWithTwoSteps({ secondContract: null }), receipt: RECEIPT }).failed_checks.includes('contract_not_fully_specified'))
  assert.ok(nextStepClarity({ planningState: planningWithTwoSteps({ secondContract: { mode: 'semantic_unknown', requirements: [] } }), receipt: RECEIPT }).failed_checks.includes('contract_not_fully_specified'))
  assert.ok(nextStepClarity({ planningState: planningWithTwoSteps({ closeFirst: false }), receipt: RECEIPT }).failed_checks.includes('no_step_closed_just_before'), 'nothing closed: this is not a step close')
  assert.ok(nextStepClarity({ planningState: undefined, receipt: RECEIPT }).failed_checks.includes('goal_not_active'))
  assert.equal(nextStepClarity({ planningState: undefined, receipt: RECEIPT }).clear, false)
})

test('nextStepClarity: a contract that names entities is clear only when those entities are in the plan receipts', () => {
  const named = { mode: 'all', requirements: [{ id: 'furnace_working', kind: 'entity_state', unit_number: 4242, expected: 'working' }] }
  const unknown = nextStepClarity({ planningState: planningWithTwoSteps({ secondContract: named }), receipt: RECEIPT })
  assert.equal(unknown.clear, false)
  assert.ok(unknown.failed_checks.includes('named_entity_not_in_receipts'))
  assert.equal(unknown.evidence.entities_named, 1)
  assert.equal(unknown.evidence.facts_in_receipts, false)
  // The summary the model-facing state carries never contains the unit number.
  assert.equal(JSON.stringify(unknown.next_step).includes('4242'), false)
})

// ---------------------------------------------------------------------------------------------------------------
// Questions and parsers
// ---------------------------------------------------------------------------------------------------------------

test('the C4 question is one bounded choice with two routes and no authority over plans, steps or completion', () => {
  const questions = c4Questions()
  assert.deepEqual(Object.keys(questions), ['next_step_route'])
  assert.deepEqual(Object.keys(questions.next_step_route.criteria).sort(), ['direct_to_executor', 'ground_first'])
  assert.match(JSON.stringify(questions.next_step_route.instructions), /never change or replace the committed step, never judge completion/)
  assert.deepEqual(parseC4Choice({ answers: { next_step_route: { type: 'choice', choice: 'direct_to_executor', confidence: 0.83, probabilities: { direct_to_executor: 0.83, ground_first: 0.17 } } } }), { choice: 'direct_to_executor', confidence: 0.83, probabilities: { direct_to_executor: 0.83, ground_first: 0.17 } })
  assert.equal(parseC4Choice({ answers: { next_step_route: { choice: 'replan', confidence: 0.9 } } }), undefined, 'an unknown route is refused')
  assert.equal(parseC4Choice({ answers: {} }), undefined)
  assert.equal(parseC4Choice(undefined), undefined)
  assert.equal(parseC4Choice({ answers: { next_step_route: { choice: 'ground_first', confidence: 7 } } }).confidence, 1, 'confidence is clamped')
  assert.equal(parseC4Choice({ answers: { next_step_route: { choice: 'ground_first' } } }).confidence, 0)
})

test('the shelf ranking question lists the COMPLETE candidate set with positional keys; the parser never drops or adds a candidate', () => {
  const candidates = Array.from({ length: 7 }, (_, index) => ({ node_id: `n${index + 1}`, intent: `intent ${index + 1}`, why_it_matters: 'w', status: 'ready_to_refine', depends_on: [], verified_results: [] }))
  const questions = shelfRankingQuestions(candidates)
  assert.deepEqual(Object.keys(questions.shelf_ranking.criteria), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'])
  assert.match(questions.shelf_ranking.criteria.c3, /^n3: intent 3/)
  const parsed = parseShelfRanking({ answers: { shelf_ranking: { choice: 'c6', confidence: 0.8, probabilities: { c1: 0.05, c2: 0.05, c3: 0.2, c4: 0.05, c5: 0.05, c6: 0.5, c7: 0.1 } } } }, candidates)
  assert.deepEqual(parsed.ordered.map(candidate => candidate.node_id), ['n6', 'n3', 'n7', 'n1', 'n2', 'n4', 'n5'])
  assert.equal(parsed.ordered.length, candidates.length)
  assert.equal(parseShelfRanking({ answers: { shelf_ranking: { choice: 'c9', confidence: 1 } } }, candidates), undefined)
  assert.equal(parseShelfRanking({ answers: {} }, candidates), undefined)
  // applyShelfRanking: a candidate the ranking lacks keeps its place after the ranked ones; none is ever dropped.
  const partial = applyShelfRanking(candidates, [candidates[4], candidates[1]])
  assert.deepEqual(partial.map(candidate => candidate.node_id), ['n5', 'n2', 'n1', 'n3', 'n4', 'n6', 'n7'])
})

// ---------------------------------------------------------------------------------------------------------------
// C4 in shadow: nothing changes; the judgment is recorded next to the gate and scored against the outcome
// ---------------------------------------------------------------------------------------------------------------

test('shadow C4: identical LLM requests, identical trace sequence and identical gate calls as a run without these judgments, apart from the new judgment rows', async () => {
  const script = () => [oneStepSlice({ plan: TWO_STEPS }), observation(), executorStep(), plannerNextSlice({ roadmapNodeIds: ['node_drill'] })]
  const off = harness({ script: script(), tokens: SLICE_TOKENS, agentOptions: { jevCheckpoints: false } })
  await runSliceWithContractedStep2(off)
  const on = harness({ script: script(), tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(on)

  assert.equal(on.calls.length, 4)
  assert.deepEqual(on.calls.map(call => normalize(call.messages)), off.calls.map(call => normalize(call.messages)), 'the model received exactly the same messages')
  assert.deepEqual(on.calls.map(call => normalize({ trigger: call.context.triggerSource, tools: call.context.allowTools, role: call.context.role })), off.calls.map(call => normalize({ trigger: call.context.triggerSource, tools: call.context.allowTools, role: call.context.role })))
  assert.deepEqual(on.trace.filter(record => !isU11Row(record)).map(record => record.event), off.trace.map(record => record.event), 'the same behavior rows in the same order')
  assert.ok(on.trace.some(isU11Row), 'and the judgment rows exist')
  assert.equal(off.trace.some(isU11Row), false)
  assert.equal(off.jev.calls.some(call => U11_CONTRACTS.has(call.state?.contract)), false)
  // Jev's own gate calls are the same, in the same order; the judgments add calls of their own contracts.
  assert.deepEqual(otherCalls(on.jev).map(call => call.keys), off.jev.calls.map(call => call.keys))
  assert.deepEqual(u11Calls(on.jev).map(call => call.state.contract).sort(), ['c4_next_step_route', 'restage_observation_families', 'restage_observation_families', 'shelf_ranking'].sort())
  // The shadow judgments stay out of the Jev health window: the health summary a run reports is unchanged.
  assert.deepEqual(on.agent.jevHealth, off.agent.jevHealth)
  // The same reducer state: nothing the judgments did touched the plan or the tracker.
  assert.equal(normalize(getActivePlan(on.memory.planningState(KEY)).execution.step_progress).length > 0, true)
  assert.deepEqual(normalize(on.memory.planningState(KEY).roadmap), normalize(off.memory.planningState(KEY).roadmap))
  assert.equal(on.memory.planningState(KEY).reasoning_epoch, off.memory.planningState(KEY).reasoning_epoch)
})

test('shadow C4: the judgment is recorded with its request id, ids, choice, confidence, the alternative and a reason, and scored against the outcome when the step verifies', async () => {
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  const requestId = world.rows('request.received')[0].request_id

  const [clear] = world.rows('c4.next_step_clear')
  assert.equal(clear.request_id, requestId)
  assert.equal(clear.data.request_id, requestId)
  assert.equal(clear.data.clear, true)
  assert.equal(clear.data.reason, 'all_deterministic_checks_hold')

  const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'c4_next_step')
  assert.equal(recorded.request_id, requestId)
  assert.equal(recorded.data.request_id, requestId)
  assert.equal(recorded.data.stage, 'shadow')
  assert.equal(recorded.data.acted, false)
  assert.equal(recorded.data.jev_choice, 'direct_to_executor')
  assert.equal(recorded.data.jev_confidence, 0.9)
  assert.equal(recorded.data.checkpoint, 'C4')
  assert.equal(recorded.data.reason, 'shadow_no_behavior_change')
  assert.equal(recorded.data.alternative.kind, 'targeted_observation_wake')
  assert.ok(recorded.data.goal_id && recorded.data.plan_id && recorded.data.step_id)
  assert.equal(recorded.data.step_id, getActivePlan(world.memory.planningState(KEY))?.steps?.[1]?.step_id ?? recorded.data.step_id)

  const applied = world.rows('c4.route_applied')[0]
  assert.equal(applied.data.mode, 'shadow')
  assert.equal(applied.data.reason, 'shadow_no_behavior_change')
  assert.equal(applied.data.would_route, 'continue_current_without_observation_wake')
  assert.equal(applied.data.applied_route, 'fallback_planner', 'the gate still chose as it always does')
  assert.equal(applied.request_id, requestId)

  const measured = world.rows('c4.wake_measured')[0]
  assert.equal(measured.data.mode, 'shadow')
  assert.equal(measured.request_id, requestId)
  assert.equal(measured.data.request_id, requestId)
  assert.equal(measured.data.reason, 'the_wake_that_ran_under_the_current_gate_route')
  assert.equal(measured.data.fresh_lookups, 1)
  assert.deepEqual(measured.data.lookup_families, ['nearby_world'])
  assert.equal(measured.data.rounds, 2, 'the observation round and the round that submitted step 2')
  // Tokens are the provider-reported input plus output of each round: call 2 (the observation) and call 3.
  assert.equal(measured.data.wake_tokens, (2000 + 450) + (3000 + 450))
  assert.equal(measured.data.observation_round_tokens, 2000 + 450, 'only the round that ran a lookup is observation spend')
  assert.equal(measured.data.observation_rounds, 1, 'only the round that called an observation tool')
  assert.equal(measured.data.gate_jev_calls, 2, 'the gate and the planner-shape call the gate route really made')

  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.request_id, requestId)
  assert.equal(scored.data.judgment_id, recorded.data.judgment_id)
  // ONE outcome label: the wake looked something up, so observation WAS needed and `direct_to_executor` disagrees. The
  // label is final as soon as a lookup happened, so it is scored at the wake's end, whatever the step does next.
  assert.equal(scored.data.agreed, false, 'the wake made a lookup: observation was needed')
  assert.equal(scored.data.reason, 'outcome_differs_from_the_judgment')
  assert.equal(scored.data.outcome.observation_needed, true)
  assert.equal(scored.data.outcome.fresh_lookups, 1)
  assert.equal(scored.data.realized, false)
  assert.equal(scored.data.saving, undefined, 'a disagreement saves nothing')
  assert.equal(scored.data.ledger.would_save.tokens, 0)
  assert.equal(scored.data.stage, 'shadow')
  const order = world.trace.map(record => record.event)
  assert.ok(order.indexOf('jev.judgment_scored', order.indexOf('c4.wake_measured')) < order.lastIndexOf('step.verified'), 'scored at the wake, before the step verified')
  // The ledger keeps the shadow baseline for the tokens a direct route could skip, for the deciding stage.
  assert.deepEqual(world.ledger().families.c4_next_step.samples, [], 'no median baseline any more: nothing books a saving from wakes that needed observation')
})

test('shadow C4: a wake that made no lookup and verified on its first batch is the one case where direct_to_executor agrees', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, true)
  assert.equal(scored.data.outcome.observation_needed, false)
  assert.equal(scored.data.outcome.fresh_lookups, 0)
  assert.equal(scored.data.outcome.verified_first_try, true)
  const order = world.trace.map(record => record.event)
  assert.ok(order.lastIndexOf('step.verified') < order.indexOf('jev.judgment_scored'), 'a clean first batch is scored only once the gate verified the step')
})

test('an always-direct Jev cannot reach deciding on wakes that looked things up, and a ground_first Jev is right on the same wakes', async () => {
  // 30 wakes that each made a lookup: direct disagrees every time, ground_first agrees every time.
  const scoreAll = (choice) => {
    let ledger = emptyLedger()
    for (let index = 0; index < 60; index++) {
      const recorded = recordJudgment(ledger, { family: 'c4_next_step', request_id: 'req_a', jev_choice: choice })
      const result = scoreC4Judgment({ choice, fresh_lookups: 1, verified: true, first_try: true })
      ledger = scoreJudgment(recorded.ledger, recorded.judgment.judgment_id, { ...result, outcome: {} }).ledger
    }
    return ledger
  }
  const direct = scoreAll('direct_to_executor')
  assert.equal(effectiveStage(direct, 'c4_next_step'), 'shadow')
  assert.equal(summarizeLedger(direct).find(family => family.family === 'c4_next_step').agreed, 0)
  assert.equal(effectiveStage(scoreAll('ground_first'), 'c4_next_step'), 'deciding', 'the same wakes promote a Jev that was right')
  // And through the loop: one wake with a lookup scores the always-direct answer as a disagreement.
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  assert.equal(world.ledger().families.c4_next_step.agreed, 0)
})

test('shadow C4: when the next step is not clear (no contract yet) Jev is not asked, nothing is recorded and the route is exactly the gate\'s', async () => {
  const jev = scriptedJev({ next_step_route: directAnswer })
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], jev, tokens: SLICE_TOKENS })
  await world.say()
  world.give('iron-ore')
  await world.agent.completed() // no contractSecondStep: step 2 is prose-only
  const [clear] = world.rows('c4.next_step_clear')
  assert.equal(clear.data.clear, false)
  assert.match(clear.data.reason, /contract_not_fully_specified/)
  assert.equal(jev.calls.some(call => call.state?.contract === 'c4_next_step_route'), false)
  assert.equal(world.rows('jev.judgment_recorded').some(row => row.data.family === 'c4_next_step'), false)
  assert.equal(world.rows('c4.route_applied').length, 0)
})

// ---------------------------------------------------------------------------------------------------------------
// C4 deciding (forced in the tests): the wake is skipped and the executor continues directly
// ---------------------------------------------------------------------------------------------------------------

test('deciding C4: the post-step gate, the planner-shape call and the observation wake are skipped and the executor continues on the next step; only the completion gate closes steps', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  forceStage(world, 'c4_next_step', 'deciding', { samples: [2400, 2600] })
  const closes = []
  const applyStepClose = world.agent.applyStepClose.bind(world.agent)
  world.agent.applyStepClose = async (trigger, args) => { closes.push({ trigger, step: args.step.id }); return applyStepClose(trigger, args) }
  let atWake
  world.script[1] = async () => {
    // The provider call of the skipped wake: the tracker still points at the step the gate just activated.
    atWake = { active: world.plan().active_step_index, closed: world.trace.filter(record => record.event === 'step.verified').length, closes: closes.length, latestBatch: world.agent.latestCompletedBatchId, admittedBatch: world.game.batchId }
    return executorStep()
  }

  await runSliceWithContractedStep2(world)
  const requestId = world.rows('request.received')[0].request_id

  assert.equal(world.calls.length, 3, 'planner, executor (no observation round), planner: one fewer model call than the shadow run')
  assert.deepEqual({ active: atWake.active, closed: atWake.closed, closes: atWake.closes }, { active: 1, closed: 1, closes: 1 }, 'the gate had closed step 1 before the wake; nothing else advanced the tracker')
  assert.equal(atWake.latestBatch, atWake.admittedBatch, 'the direct path keeps latestCompletedBatchId current, as the post-step gate does')
  assert.equal(world.jev.calls.filter(call => call.keys.includes('route')).length, 0, 'the post-step gate was not called')
  assert.equal(world.jev.calls.filter(call => call.keys.includes('state_bottleneck')).length, 0, 'the planner-shape call was not made')
  assert.equal(world.jev.calls.filter(call => call.keys.includes('next_step_route')).length, 1)
  const applied = world.rows('c4.route_applied')[0]
  assert.equal(applied.request_id, requestId)
  assert.equal(applied.data.mode, 'deciding')
  assert.equal(applied.data.applied_route, 'continue_current')
  assert.deepEqual(applied.data.skipped, ['post_step_gate', 'planner_shape', 'targeted_observation'])
  assert.equal(applied.data.reason, 'family_deciding_and_next_step_clear')
  const wake = world.rows('planner.wake').find(row => row.data.source === 'c4_next_step_clear')
  assert.equal(wake.data.route, 'continue_current')
  assert.equal(world.rows('post_step.routed').length, 0)
  // The executor's wake round: the continue trigger with a zero observation budget, no observation phase.
  const round = world.rows('provider.request')[1]
  assert.equal(round.data.trigger_source, 'post_step_continue')
  assert.equal(round.data.observation_budget, 0)
  assert.equal(world.rows('observation.tier_admitted').length + world.rows('tool.call').length, 0)
  // Only the completion gate closed steps: one close per step, both from the deterministic contract.
  assert.deepEqual(closes.map(close => close.trigger), ['batch_receipt', 'batch_receipt'])
  const order = world.trace.map(record => record.event)
  assert.ok(order.indexOf('step.verified') < order.indexOf('c4.route_applied') && order.indexOf('c4.route_applied') < order.lastIndexOf('step.verified'))
  assert.equal(world.rows('outcome.validated')[0].data.kind, 'plan_slice_completed', 'the slice closed through the normal gate')

  // Scored like any judgment. The realized saving is what was provably not done: the post-step gate call and the planner-shape call.
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.acted, true)
  assert.equal(scored.data.realized, true)
  assert.equal(scored.data.reason, 'outcome_matches_the_judgment')
  assert.equal(scored.data.agreed, true)
  assert.equal(scored.data.recorded_stage, 'deciding')
  assert.deepEqual(scored.data.saving, { jev_calls: 2 })
  assert.equal(scored.data.ledger.saved.jev_calls, 2)
  assert.equal(scored.data.ledger.saved.tokens, 0, 'no LLM tokens are claimed: the executor still wakes and the skipped rounds did not run')
  assert.equal(scored.data.ledger.saved.rounds, 0)
  assert.equal(scored.data.ledger.saved.wakes, 0, 'the executor still wakes: not a saved wake')
  assert.equal(world.rows('c4.wake_measured')[0].data.mode, 'deciding')
  assert.equal(world.rows('c4.wake_measured')[0].data.reason, 'executor_continued_directly')
  // A deciding judgment is recorded as acting and as not shadow.
  const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'c4_next_step')
  assert.equal(recorded.data.acted, true)
  assert.equal(recorded.data.shadow, false)
  assert.equal(recorded.data.reason, 'deciding_stage_direct_to_executor')
  assert.deepEqual(recorded.data.saving_estimate, { jev_calls: 2 })
})

test('deciding C4 keeps today\'s route when Jev says ground_first, answers below the confidence floor, or the next step is not clear (Jev can only be more cautious than the checks)', async () => {
  for (const [label, answer, contractStep] of [
    ['ground_first', groundAnswer, true],
    ['low confidence', { choice: 'direct_to_executor', confidence: C4_MIN_CONFIDENCE - 0.05 }, true],
    ['no contract on the next step', directAnswer, false],
  ]) {
    const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], jev: scriptedJev({ next_step_route: answer }), tokens: SLICE_TOKENS })
    forceStage(world, 'c4_next_step', 'deciding')
    await world.say()
    if (contractStep) contractSecondStep(world)
    world.give('iron-ore')
    await world.agent.completed()
    assert.equal(world.rows('c4.route_applied').filter(row => row.data.mode === 'deciding').length, 0, label)
    assert.equal(world.jev.calls.filter(call => call.keys.includes('route')).length, 1, `${label}: the gate ran as always`)
    assert.equal(world.rows('planner.wake').some(row => row.data.source === 'c4_next_step_clear'), false, label)
    assert.ok(world.rows('tool.call').length >= 1, `${label}: the observation wake ran`)
    const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'c4_next_step')
    if (contractStep) assert.equal(recorded.data.acted, false, label)
    else assert.equal(recorded, undefined, label)
  }
})

test('deciding C4: a step that fails after the skipped wake is scored as a disagreement (not verified on its first batch), so the route can demote', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  forceStage(world, 'c4_next_step', 'deciding', { samples: [2500] })
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed() // step 1 closes; the executor continues directly on step 2
  assert.equal(world.rows('c4.route_applied')[0].data.mode, 'deciding')
  await world.agent.failed(world.game.failLastBatch({ type: 'mining', code: 'no_resource' })) // the batch fails: a recovery round runs

  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.acted, true)
  assert.equal(scored.data.agreed, false)
  assert.equal(scored.data.reason, 'outcome_differs_from_the_judgment')
  assert.equal(scored.data.outcome.had_failure_boundary, true)
  assert.equal(scored.data.outcome.step_verified, undefined, 'scored at the failure itself, before the step verified')
  assert.equal(scored.data.outcome.verified_first_try, false)
  assert.equal(scored.data.outcome.observation_needed, true)
  assert.equal(scored.data.saving, undefined, 'a failed outcome saves nothing')
  assert.equal(scored.data.ledger.saved.tokens, 0)
  const scoredCount = world.rows('jev.judgment_scored').length
  const verifiedCount = world.rows('step.verified').length
  world.give('copper-ore')
  await world.agent.completed()
  assert.equal(world.rows('jev.judgment_scored').length, scoredCount, 'the failure was scored before the later wake')
  assert.equal(world.rows('step.verified').length, verifiedCount, 'a missing receipt cannot verify the uncertain retry')
})

test('deciding C4: a direct step that fails and then REPLANS (or whose request completes or fails) is still scored as a disagreement, and the family demotes', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  const saved = serializeLedger(emptyLedger())
  saved.families.c4_next_step = { ...saved.families.c4_next_step, stage: 'deciding', scored: 60, agreed: 54, evidence: 60, window: [...Array.from({ length: 54 }, () => 1), ...Array.from({ length: 6 }, () => 0)], samples: [2500] }
  world.memory.jevLedger = restoreLedger(saved).ledger
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed() // the route goes direct
  assert.equal(world.rows('c4.route_applied')[0].data.mode, 'deciding')
  // The batch fails and the recovery is a replan (Jev's gate answers wake_planner -> replan); the step never verifies.
  world.jev.calls.length = 0
  await world.agent.failed(world.game.failLastBatch({ type: 'mining', code: 'no_resource' }))
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, false, 'scored at the failure: not abandoned by the replan that follows')
  assert.equal(world.rows('jev.judgment_unscored').filter(row => row.data.family === 'c4_next_step').length, 0)
  const [change] = world.rows('jev.stage_changed')
  assert.equal(change.data.direction, 'demoted')
  assert.equal(effectiveStage(world.ledger(), 'c4_next_step'), 'shadow')
  // A request that FAILS or pauses with the step still unverified is a step that failed: a disagreement. One that merely
  // completes leaves nothing to score (a multi-batch step continues in the next request): abandoned, never agreement.
  for (const [ended, agreed] of [['request.failed', false], ['goal.paused', false], ['request.completed', undefined]]) {
    const direct = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
    await direct.say()
    contractSecondStep(direct)
    direct.give('iron-ore')
    await direct.agent.completed() // direct answer, no lookup: the label waits for the step
    assert.equal(direct.rows('jev.judgment_scored').filter(row => row.data.family === 'c4_next_step').length, 0)
    await direct.agent.writeTraceEvent(ended, { outcome: 'x' })
    await direct.settle()
    const after = direct.rows('jev.judgment_scored').find(item => item.data.family === 'c4_next_step')
    if (agreed === undefined) {
      assert.equal(after, undefined, `${ended}: not scored`)
      assert.equal(direct.rows('jev.judgment_unscored').find(item => item.data.family === 'c4_next_step').data.reason, 'request_completed_before_the_step_resolved')
    }
    else {
      assert.equal(after.data.agreed, false, `${ended} with the step unverified`)
      assert.equal(after.data.outcome.had_failure_boundary, true)
    }
  }
  // Only a real cancel abandons outright (covered by the cancellation test).
})

test('a family demoted by its own outcomes is traced with the request id and the reason, and stops acting', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  // 54 of the last 60 agreed: exactly 90%. One disagreement from this judgment drops it below.
  const saved = serializeLedger(emptyLedger())
  saved.families.c4_next_step = { ...saved.families.c4_next_step, stage: 'deciding', scored: 60, agreed: 54, evidence: 60, window: [...Array.from({ length: 54 }, () => 1), ...Array.from({ length: 6 }, () => 0)] }
  const restored = restoreLedger(saved)
  assert.deepEqual(restored.clamped, [])
  world.memory.jevLedger = restored.ledger
  assert.equal(effectiveStage(restored.ledger, 'c4_next_step'), 'deciding')

  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed()
  await world.agent.failed(world.game.failLastBatch({ type: 'mining', code: 'no_resource' }))
  world.give('copper-ore')
  await world.agent.completed()

  const requestId = world.rows('request.received')[0].request_id
  const [change] = world.rows('jev.stage_changed')
  assert.equal(change.request_id, requestId)
  assert.equal(change.data.request_id, requestId)
  assert.equal(change.data.family, 'c4_next_step')
  assert.equal(change.data.direction, 'demoted')
  assert.equal(change.data.from, 'deciding')
  assert.equal(change.data.to, 'shadow')
  assert.match(change.data.reason, /rolling_agreement_below_threshold: 53\/60/)
  assert.equal(effectiveStage(world.ledger(), 'c4_next_step'), 'shadow')
})

// ---------------------------------------------------------------------------------------------------------------
// Jev unavailable: no judgment is recorded as agreement and behavior is exactly today's
// ---------------------------------------------------------------------------------------------------------------

test('Jev fails on the U11 questions: nothing is recorded or scored as agreement, skips are traced with the reason, and the run is otherwise identical', async () => {
  const script = () => [oneStepSlice({ plan: TWO_STEPS }), observation(), executorStep(), plannerNextSlice()]
  const failing = scriptedJev({ next_step_route: directAnswer }, { throwFor: state => U11_CONTRACTS.has(state?.contract) })
  const degraded = harness({ script: script(), jev: failing, tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(degraded)
  const off = harness({ script: script(), tokens: SLICE_TOKENS, agentOptions: { jevCheckpoints: false } })
  await runSliceWithContractedStep2(off)

  assert.deepEqual(degraded.calls.map(call => normalize(call.messages)), off.calls.map(call => normalize(call.messages)))
  assert.deepEqual(degraded.trace.filter(record => !isU11Row(record)).map(record => record.event), off.trace.map(record => record.event))
  const families = summarizeLedger(degraded.ledger())
  assert.ok(families.every(family => family.scored === 0 && family.agreed === 0), 'no judgment counted as agreement')
  assert.equal(degraded.rows('jev.judgment_recorded').length, 0)
  assert.equal(degraded.rows('jev.judgment_scored').length, 0)
  const skipped = degraded.rows('jev.judgment_skipped')
  assert.ok(skipped.length >= 3)
  assert.ok(skipped.every(row => row.data.recorded_as_agreement === false && row.data.reason === 'jev_fallback' && /timed out/.test(row.data.error)))
  assert.deepEqual([...new Set(skipped.map(row => row.data.family))].sort(), ['c4_next_step', 'observation_families', 'shelf_ranking'])
  assert.ok(degraded.rows('jev.judgment_skipped').every(row => typeof row.request_id === 'string'))
})

test('no decision provider at all: not one U11 row is written and the run is today\'s run', async () => {
  const script = () => [oneStepSlice({ plan: TWO_STEPS }), observation(), executorStep(), plannerNextSlice()]
  const world = harness({ script: script(), tokens: SLICE_TOKENS, noJev: true })
  await runSliceWithContractedStep2(world)
  assert.equal(world.trace.some(isU11Row), false)
  assert.equal(world.calls.length, 4)
})

test('a degraded Jev (most calls fell back) gets no judgments asked of it, with the reason traced', async () => {
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  world.agent.jevHealth = { requests: 10, responses: 2, fallbacks: 8, by_contract: {}, by_kind: { timeout: 8 }, last_fallback: null }
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed()
  assert.equal(world.jev.calls.some(call => U11_CONTRACTS.has(call.state?.contract)), false)
  const reasons = world.rows('jev.judgment_skipped').map(row => row.data.reason)
  assert.ok(reasons.length >= 1 && reasons.every(reason => reason === 'jev_health_degraded'))
})

// ---------------------------------------------------------------------------------------------------------------
// Observation families per restage packet
// ---------------------------------------------------------------------------------------------------------------

class FactsFactorio extends FakeFactorio {
  async command(text) {
    if (text.includes('remote.call("autorio_tools","get_inventory_items")')) {
      this.factReads = (this.factReads ?? 0) + 1
      return JSON.stringify({ items: { 'iron-plate': 12, coal: 40 }, unit_number: 555 })
    }
    if (text.includes('remote.call("autorio_research","status")')) {
      this.factReads = (this.factReads ?? 0) + 1
      return JSON.stringify({ researching: null, completed: ['automation'], queue: [] })
    }
    return super.command(text)
  }
}

const FAMILY_ANSWERS = { need_inventory_equipment: { noul: 0.9 }, need_research_state: { noul: 0.8 }, need_nearby_world: { noul: 0.7 }, need_recipe_production: { noul: 0.2 } }
const familyJev = (answers = FAMILY_ANSWERS) => scriptedJev({
  next_step_route: directAnswer,
  ...Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, restageOnly(answer)])),
})

test('shadow observation families: Jev\'s picks are recorded at the restage, compared with the lookups the fresh agent then makes, and the packet is untouched', async () => {
  const script = () => [plannerSlice(), observation(), executorStep(), plannerNextSlice()]
  const world = harness({ script: script(), jev: familyJev(), tokens: SLICE_TOKENS, game: new FactsFactorio() })
  const off = harness({ script: script(), tokens: SLICE_TOKENS, game: new FactsFactorio(), agentOptions: { jevCheckpoints: false } })
  for (const run of [world, off]) {
    await run.say()
    contractSecondStep(run)
    run.give('iron-ore')
    await run.agent.completed()
  }
  const requestId = world.rows('request.received')[0].request_id

  const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'observation_families')
  assert.equal(recorded.request_id, requestId)
  assert.equal(recorded.data.checkpoint, 'C3')
  assert.equal(recorded.data.stage, 'shadow')
  assert.equal(recorded.data.acted, false)
  assert.deepEqual(recorded.data.jev_choice, ['inventory_equipment', 'research_state', 'nearby_world'], 'threshold 0.5, ranked, recipe_production (0.2) excluded')
  assert.equal(recorded.data.reason, 'shadow_no_packet_change')
  const selected = world.rows('jev.observation_families_selected')[0]
  assert.deepEqual(selected.data.selected_families, ['inventory_equipment', 'research_state', 'nearby_world'])
  assert.deepEqual(selected.data.facts_added, [])
  assert.equal(selected.data.request_id, requestId)
  assert.equal(selected.data.reason, 'shadow_compared_with_the_lookups_the_agent_then_makes')

  // The executor's first request carries exactly the packet it would have without the judgment.
  assert.equal(normalize(world.calls[1].messages), normalize(off.calls[1].messages))
  assert.equal(world.game.factReads ?? 0, 0, 'shadow reads no fact')

  // The fresh agent looked up nearby entities (one family) before its first admitted operation: recall 1 (1/1), precision 1/3 -> disagree.
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'observation_families')
  assert.deepEqual(scored.data.outcome.looked_up_families, ['nearby_world'])
  assert.equal(scored.data.outcome.recall, 1)
  assert.equal(scored.data.outcome.precision, 0.333)
  assert.equal(scored.data.outcome.scoring, 'two_sided')
  assert.equal(scored.data.agreed, false)
  assert.equal(scored.request_id, requestId)
})

test('a fresh agent that looks up what Jev picked agrees; shadow saving is the lookups a fact read would have replaced', async () => {
  const jev = familyJev({ need_nearby_world: { noul: 0.9 }, need_inventory_equipment: { noul: 0.7 } })
  const inventoryObservation = () => ({ tool_calls: [{ id: 'call_inv', index: 0, type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] })
  const world = harness({ script: [plannerSlice(), inventoryObservation(), executorStep(), plannerNextSlice()], jev, tokens: SLICE_TOKENS, game: new FactsFactorio() })
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed()
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'observation_families')
  assert.deepEqual(scored.data.outcome.looked_up_families, ['inventory_equipment'])
  assert.equal(scored.data.outcome.recall, 1)
  assert.equal(scored.data.outcome.precision, 0.5)
  assert.equal(scored.data.agreed, true)
  assert.deepEqual(scored.data.saving, { calls: 1 }, 'the inventory read has a parameterless fact read, so the packet could have supplied it')
  assert.equal(world.ledger().families.observation_families.would_save.calls, 1)
})

test('advisory observation families only ADD: harness-read facts and one hint line join the packet, every other packet line is byte-identical, and the facts are bounded and sanitized', async () => {
  const script = () => [plannerSlice(), executorStep(), plannerNextSlice()]
  const base = harness({ script: script(), jev: familyJev(), tokens: SLICE_TOKENS, game: new FactsFactorio() })
  await base.say()
  const advisory = harness({ script: script(), jev: familyJev(), tokens: SLICE_TOKENS, game: new FactsFactorio() })
  forceStage(advisory, 'observation_families', 'advisory')
  await advisory.say()
  contractSecondStep(base)
  contractSecondStep(advisory)
  for (const run of [base, advisory]) {
    run.give('iron-ore')
    await run.agent.completed()
  }

  const basePacket = stepBlock(base.calls[1].messages)
  const packet = stepBlock(advisory.calls[1].messages)
  const baseLines = textOf(basePacket).split('\n').map(line => normalize(line))
  const lines = textOf(packet).split('\n')
  const added = lines.filter(line => !baseLines.includes(normalize(line)))
  assert.deepEqual(baseLines.filter(line => !lines.map(item => normalize(item)).includes(line)), [], 'nothing the packet carried was removed or changed')
  assert.ok(added.length >= 3 && added.every(line => line.startsWith('jev_fact')), `only jev_fact lines were added: ${added.join(' | ')}`)
  assert.equal(normalize(textOf(stableBlock(advisory.calls[1].messages))), normalize(textOf(stableBlock(base.calls[1].messages))), 'the plan block (the cache prefix) is byte-identical')
  assert.ok(lines.some(line => /^jev_fact\[inventory_equipment\] \(harness read at this restage, selected by Jev; advisory, verify before acting\): \{"items":\{"iron-plate":12,"coal":40\}\}$/.test(line)), 'the fact is the sanitized harness read: no unit number')
  assert.equal(textOf(packet).includes('555'), false)
  assert.ok(lines.some(line => line.startsWith('jev_fact[research_state]')))
  assert.ok(lines.some(line => line === 'jev_fact_hint (Jev, advisory): lookups likely useful here: nearby_world'), 'a family with no parameterless read is a hint, not a fact')
  for (const line of added.filter(item => item.startsWith('jev_fact['))) assert.ok(line.slice(line.indexOf('): ') + 3).length <= PACKET_FACT_CHARS)
  assert.ok(added.length <= HANDOFF_PACKET_LIMITS.jevFacts + 1)
  assert.equal(advisory.game.factReads, 2, 'two harness fact reads (inventory, research); fact reads are ungated')
  const recorded = advisory.rows('jev.judgment_recorded').find(row => row.data.family === 'observation_families')
  assert.equal(recorded.data.stage, 'advisory')
  assert.equal(recorded.data.acted, true)
  assert.equal(recorded.data.reason, 'advisory_facts_added_to_packet')
  assert.deepEqual(advisory.rows('jev.observation_families_selected')[0].data.facts_added, ['inventory_equipment', 'research_state'])
  assert.deepEqual(advisory.rows('jev.observation_families_selected')[0].data.hints_added, ['nearby_world'])
  // The plan, the tracker and the mandatory facts are as they were.
  assert.equal(advisory.memory.planningState(KEY).reasoning_epoch, base.memory.planningState(KEY).reasoning_epoch)
})

test('an advisory packet over its size limit drops Jev\'s additions first and never a mandatory record', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1_700_000_000_000, goal_id: 'goal_pk', owner: 'tester', objective: 'gather plates' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 1_700_000_000_000, origin: 'live_task_board', roadmap_node_ids: [], steps: [{ description: 'Gather 10 iron ore', completion_contract: inventoryCheckpoint('iron-ore', 10) }] })
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RUNTIME_VALIDATED, now: 1_700_000_000_000, plan_id: plan.plan_id, runtime_validation: { passed: true } })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1_700_000_000_000, plan_id: plan.plan_id })
  // A note, a budget line and a runtime line are droppable records too: Jev's additions must go before any of them.
  const args = { planningState: state, role: 'executor', checkpoint: 'C3', reason: 'executor_fresh_at_plan_commit', note: 'the ending conversation left this note', budget: 'effort low', runtime: { task_state: 'idle', queue_length: 0, idle: true }, actor: { actor_id: 18, actor_kind: 'standalone_character', epoch: 3, connected_players: 0 }, now: 1_700_000_000_000 }
  const plain = buildHandoffPacket(args)
  const facts = [{ family: 'inventory_equipment', text: 'x'.repeat(900) }, { family: 'research_state', text: '{"completed":["automation"]}' }]
  const withFacts = buildHandoffPacket({ ...args, jevFacts: facts, jevHints: ['nearby_world'] })
  assert.ok(withFacts.text.length > plain.text.length)
  assert.equal(withFacts.stableText, plain.stableText)
  assert.deepEqual(withFacts.dropped, [])
  const cappedFact = withFacts.text.split('\n').find(line => line.startsWith('jev_fact[inventory_equipment]'))
  assert.ok(cappedFact.length < 420, 'a fact is cut to its bound, never passed whole')
  // A limit only the plain packet fits: the additions are the first thing dropped, everything else stays.
  const tight = buildHandoffPacket({ ...args, jevFacts: facts, jevHints: ['nearby_world'], limits: { maxChars: plain.text.length } })
  assert.equal(tight.over_limit, false)
  assert.deepEqual(tight.dropped.sort(), ['jev_fact_0', 'jev_fact_1', 'jev_fact_hint'].sort())
  assert.equal(tight.text, plain.text, 'with the additions dropped the packet is byte-identical to the plain one')
  assert.match(tight.text, /note \(UNVERIFIED/, 'the note outlived the additions')
  assert.match(tight.text, /budget: effort low/)
  // More facts than the bound are never admitted.
  const many = buildHandoffPacket({ ...args, jevFacts: Array.from({ length: 9 }, (_, index) => ({ family: `f${index}`, text: 'ok' })) })
  assert.equal(many.text.split('\n').filter(line => line.startsWith('jev_fact[')).length, HANDOFF_PACKET_LIMITS.jevFacts)
})

test('observation families are judged at C1, C2, C3, C4, C6 and C8 and at no other checkpoint; C5 and C7 and a prebuilt packet ask Jev nothing', async () => {
  assert.deepEqual([...OBSERVATION_RESTAGE_CHECKPOINTS], ['C1', 'C2', 'C3', 'C4', 'C6', 'C8'])
  const world = harness({ script: [plannerSlice()], jev: familyJev() })
  await world.say()
  const before = world.jev.calls.length
  const planningState = world.memory.planningState(KEY)
  for (const checkpoint of ['C5', 'C7']) assert.equal(await world.agent.jev.prepareRestage({ checkpoint, role: 'executor', planningState, reason: 'x' }), undefined)
  // Shadow: preparing asks nothing and waits for nothing; the call starts once the restage has landed.
  for (const checkpoint of OBSERVATION_RESTAGE_CHECKPOINTS) {
    const beforeThis = world.jev.calls.length
    const prepared = await world.agent.jev.prepareRestage({ checkpoint, role: 'executor', planningState, reason: 'x', requestId: 'req_x' })
    assert.equal(prepared.shadow, true, checkpoint)
    assert.equal(world.jev.calls.length, beforeThis, `${checkpoint}: nothing asked before the restage landed`)
    await world.agent.jev.afterRestage(prepared, { restaged: true, handoff_id: `ho_${checkpoint}` })
    await world.settle()
  }
  assert.equal(world.jev.calls.length, before + OBSERVATION_RESTAGE_CHECKPOINTS.length)
  const recorded = world.rows('jev.judgment_recorded').filter(row => row.data.family === 'observation_families' && /^C[1-8]$/.test(row.data.checkpoint ?? ''))
  assert.deepEqual(recorded.map(row => row.data.checkpoint).slice(-OBSERVATION_RESTAGE_CHECKPOINTS.length), [...OBSERVATION_RESTAGE_CHECKPOINTS])
})

test('a restage that is refused never burns a Jev call in shadow, and abandons the judgment of an advisory one instead of scoring it', async () => {
  const world = harness({ script: [plannerSlice()], jev: familyJev() })
  await world.say()
  const planningState = world.memory.planningState(KEY)
  const before = world.jev.calls.length
  const shadow = await world.agent.jev.prepareRestage({ checkpoint: 'C4', role: 'executor', planningState, reason: 'x', requestId: 'req_x' })
  await world.agent.jev.afterRestage(shadow, { restaged: false, reason: 'round_in_flight' })
  await world.settle()
  assert.equal(world.jev.calls.length, before, 'a refused restage costs no call')
  assert.equal(world.rows('jev.judgment_recorded').filter(row => row.data.family === 'observation_families' && row.data.checkpoint === 'C4').length, 0)

  forceStage(world, 'observation_families', 'advisory')
  const scoredBefore = summarizeLedger(world.ledger()).find(family => family.family === 'observation_families').scored
  const advisory = await world.agent.jev.prepareRestage({ checkpoint: 'C4', role: 'executor', planningState, reason: 'x', requestId: 'req_x' })
  assert.ok(advisory.judgment_id)
  await world.agent.jev.afterRestage(advisory, { restaged: false, reason: 'round_in_flight' })
  const unscored = world.rows('jev.judgment_unscored').at(-1)
  assert.equal(unscored.data.judgment_id, advisory.judgment_id)
  assert.match(unscored.data.reason, /restage_not_applied: round_in_flight/)
  assert.equal(unscored.data.recorded_as_agreement, false)
  assert.equal(unscored.data.request_id, 'req_x')
  assert.equal(summarizeLedger(world.ledger()).find(family => family.family === 'observation_families').scored, scoredBefore, 'nothing was scored')
})

// ---------------------------------------------------------------------------------------------------------------
// Shelf ranking at C2
// ---------------------------------------------------------------------------------------------------------------

const PLANNER_TOKENS = (_call, context) => (context.role === 'executor' ? 500 : 6000)
const plannerRestage = { restageSoftLimitTokens: { planner: 5000, executor: 1_000_000 } }

// Jev ranks the seven nodes n7, n3, n1, n2, n4, n5, n6.
const rankingAnswer = {
  choice: 'c7',
  confidence: 0.9,
  probabilities: { c1: 0.1, c2: 0.08, c3: 0.2, c4: 0.06, c5: 0.06, c6: 0.05, c7: 0.45 },
}

async function shelfSlices({ jev, picked, options = {}, stage } = {}) {
  const world = harness({
    script: [
      oneStepSlice({ roadmap: SHELF_SEVEN }),
      plannerNextSlice({ roadmapNodeIds: [picked] }),
      plannerNextSlice({ plan: ['Gather 10 stone'], operations: [gather('stone', 10)], checkpoint: inventoryCheckpoint('stone', 10) }),
    ],
    jev,
    tokens: PLANNER_TOKENS,
    agentOptions: { ...plannerRestage, ...options },
  })
  if (stage) forceStage(world, 'shelf_ranking', stage)
  await world.say()
  world.give('iron-ore')
  await world.agent.completed() // slice 1 verified: Jev ranks, the planner (restaged at C2) picks a node
  world.give('coal')
  await world.agent.completed() // slice 2 (the picked node) verified: the ranking is scored
  return world
}

test('shadow shelf ranking: the complete set is ranked, the packet keeps the deterministic order, and the ranking is scored against the node the planner picked and whether its slice verified', async () => {
  const agreeing = await shelfSlices({ jev: scriptedJev({ shelf_ranking: rankingAnswer }), picked: 'n7' })
  const requestId = agreeing.rows('request.received')[0].request_id
  const question = agreeing.jev.calls.find(call => call.state?.contract === 'shelf_ranking')
  assert.equal(question.state.candidate_count, 7, 'the complete ready set, not the five the packet shows')

  const recorded = agreeing.rows('jev.judgment_recorded').find(row => row.data.family === 'shelf_ranking')
  assert.equal(recorded.request_id, requestId)
  assert.equal(recorded.data.checkpoint, 'C2')
  assert.equal(recorded.data.stage, 'shadow')
  assert.equal(recorded.data.acted, false)
  assert.equal(recorded.data.jev_choice, 'n7')
  assert.deepEqual(recorded.data.detail.ranked, ['n7', 'n3', 'n1', 'n2', 'n4', 'n5', 'n6'])
  assert.deepEqual(recorded.data.alternative, { kind: 'deterministic_order', first: 'n1' })

  // The planner restaged at C2 (past its soft limit) and its packet lists the deterministic first five.
  const candidateLines = textOf(stepBlock(agreeing.calls[1].messages)).split('\n').filter(line => line.startsWith('shelf_candidate '))
  assert.deepEqual(candidateLines.map(line => /^shelf_candidate \d: (n\d)/.exec(line)[1]), ['n1', 'n2', 'n3', 'n4', 'n5'])
  assert.equal(agreeing.rows('jev.shelf_ranking_applied').length, 0)

  // The planner refined n7 and that slice verified: Jev's first pick, verified.
  const scored = agreeing.rows('jev.judgment_scored').find(row => row.data.family === 'shelf_ranking')
  assert.equal(scored.data.agreed, true)
  assert.deepEqual({ picked: scored.data.outcome.picked, ranked_first: scored.data.outcome.ranked_first, picked_rank: scored.data.outcome.picked_rank, slice_verified: scored.data.outcome.slice_verified }, { picked: 'n7', ranked_first: 'n7', picked_rank: 1, slice_verified: true })
  assert.equal(scored.request_id, requestId)

  // A planner that picks anything else disagrees, and its rank in Jev's list is recorded.
  const other = await shelfSlices({ jev: scriptedJev({ shelf_ranking: rankingAnswer }), picked: 'n3' })
  const otherScored = other.rows('jev.judgment_scored').find(row => row.data.family === 'shelf_ranking')
  assert.equal(otherScored.data.agreed, false)
  assert.equal(otherScored.data.outcome.picked_rank, 2)
})

test('advisory shelf ranking orders the packet\'s candidates from the ranked complete set; the planner still chooses; nothing is added or dropped', async () => {
  const world = await shelfSlices({ jev: scriptedJev({ shelf_ranking: rankingAnswer }), picked: 'n1', stage: 'advisory' })
  const candidateLines = textOf(stepBlock(world.calls[1].messages)).split('\n').filter(line => line.startsWith('shelf_candidate '))
  assert.deepEqual(candidateLines.map(line => /^shelf_candidate \d: (n\d)/.exec(line)[1]), ['n7', 'n3', 'n1', 'n2', 'n4'], 'Jev\'s top five of the complete seven, in its order')
  const applied = world.rows('jev.shelf_ranking_applied')[0]
  assert.equal(applied.data.stage, 'advisory')
  assert.equal(applied.data.ranked_first, 'n7')
  assert.equal(applied.request_id, world.rows('request.received')[0].request_id)
  assert.equal(applied.data.request_id, applied.request_id)
  assert.equal(applied.data.deterministic_first, 'n1')
  assert.match(applied.data.reason, /only_the_planner_still_chooses/)
  // Recorded before anything reached the packet (acted false); acted only once the ordering did.
  const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'shelf_ranking')
  assert.equal(recorded.data.acted, false)
  assert.equal(recorded.data.reason, 'advisory_ranking_ready_for_the_packet')
  const order = world.trace.map(record => record.event)
  assert.ok(order.indexOf('jev.judgment_recorded') < order.indexOf('jev.shelf_ranking_applied'))
  // The planner chose n1, not Jev's first: Jev never picks for it, and the plan it committed names its own node.
  const accepted = world.rows('plan.accepted').find(row => Array.isArray(row.data.roadmap_node_ids))
  assert.deepEqual(accepted.data.roadmap_node_ids, ['n1'])
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'shelf_ranking')
  assert.equal(scored.data.agreed, false)
  assert.equal(scored.data.acted, true)
  // The reducer's shelf is what the planner authored: untouched by the ranking.
  assert.equal(world.memory.planningState(KEY).roadmap.nodes.length, 7)
})

test('shelf ranking needs at least two candidates and a shelf pickup: one ready node or another route asks Jev nothing', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const planning = world.memory.planningState(KEY)
  const one = await world.agent.jev.rankShelf({ route: 'next_shelf_slice', planningState: planning, candidates: [{ node_id: 'a', intent: 'x', status: 'ready_to_refine' }] })
  assert.equal(one.applied, false)
  const route = await world.agent.jev.rankShelf({ route: 'active_goal_after_plan_completion', planningState: planning, candidates: [{ node_id: 'a', intent: 'x', status: 'ready_to_refine' }, { node_id: 'b', intent: 'y', status: 'ready_to_refine' }] })
  assert.equal(route.applied, false)
  assert.equal(world.jev.calls.some(call => call.state?.contract === 'shelf_ranking'), false)
})

// ---------------------------------------------------------------------------------------------------------------
// Persistence across a restart (the runtime's own durable state, not the planning reducer)
// ---------------------------------------------------------------------------------------------------------------

test('the ledger survives a restart: stages, counts and agreement come back from the durable state, and it is not part of the planning reducer', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-jev-ledger-'))
  const stateFile = path.join(dir, 'sgluna-state.json')
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS, stateFile })
  forceStage(world, 'c4_next_step', 'deciding', { samples: [2500] })
  // The forced stage is the starting ledger; a real judgment scored through the loop persists it.
  world.script[1] = executorStep()
  await runSliceWithContractedStep2(world)
  await world.agent.persistQueue
  const before = summarizeLedger(world.ledger())
  assert.equal(before.find(family => family.family === 'c4_next_step').scored, 61)
  assert.equal(before.find(family => family.family === 'c4_next_step').stage, 'deciding')

  const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.ok(raw.jev_judgment_ledger, 'the ledger is in the durable state file')
  assert.equal(JSON.stringify(raw.planning_states).includes('jev_judgment_ledger'), false, 'and not inside the planning reducer')
  assert.equal('pending' in raw.jev_judgment_ledger, false)

  const restarted = harness({ script: [], tokens: SLICE_TOKENS, stateFile, memory: new CanonicalTaskBoardMemory() })
  await restarted.agent.loadPersistentState()
  assert.deepEqual(summarizeLedger(restarted.ledger()), before)
  assert.equal(effectiveStage(restarted.ledger(), 'c4_next_step'), 'deciding', 'a promoted family is still promoted after the restart')
  // Every family that never scored a judgment starts in shadow, and a missing ledger means all shadow.
  const fresh = harness({ script: [], stateFile: path.join(dir, 'absent.json') })
  await fresh.agent.loadPersistentState()
  assert.ok(summarizeLedger(fresh.ledger()).every(family => family.stage === 'shadow' && family.scored === 0))
})

test('a persisted stage the evidence does not support is clamped on restore and traced', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-jev-ledger-'))
  const stateFile = path.join(dir, 'sgluna-state.json')
  const source = new CanonicalTaskBoardMemory()
  const forged = serializeLedger(emptyLedger())
  forged.families.c4_next_step.stage = 'deciding'
  source.jevLedger = restoreLedger(forged).ledger
  await fsp.writeFile(stateFile, JSON.stringify({ ...source.snapshot(), jev_judgment_ledger: forged }))
  const restarted = harness({ script: [], stateFile })
  await restarted.agent.loadPersistentState()
  assert.equal(effectiveStage(restarted.ledger(), 'c4_next_step'), 'shadow')
  const [clamp] = restarted.rows('jev.stage_clamped_on_restore')
  assert.equal(clamp.data.family, 'c4_next_step')
  assert.equal(clamp.data.from, 'deciding')
  assert.equal(clamp.data.to, 'shadow')
  assert.match(clamp.data.reason, /not_supported_by_the_recorded_evidence/)
})

// ---------------------------------------------------------------------------------------------------------------
// Skill card order (shadow) goes through the same ledger
// ---------------------------------------------------------------------------------------------------------------

const STEAM_CARDS = [
  { id: 'steam-power-bootstrap', name: 'Steam Power Bootstrap', status: 'candidate', summary: 'Bring up steam power.', produces: ['electric-power'], needs: [], matched: ['steam'], score: 9 },
  { id: 'starter-mining-belt-output', name: 'Starter Mining Belt Output', status: 'candidate', summary: 'A starter mining row.', produces: ['mined-resource'], needs: [], matched: ['text:power'], score: 2 },
]

class SkillFactorio extends FakeFactorio {
  constructor() {
    super()
    this.skills['steam-power-bootstrap'] = { id: 'steam-power-bootstrap', name: 'Steam Power Bootstrap', revision: 2, status: 'candidate', stage: 'pattern', summary: 'Starter steam power.' }
    this.skills['starter-mining-belt-output'] = { id: 'starter-mining-belt-output', name: 'Starter Mining Belt Output', revision: 1, status: 'candidate', stage: 'pattern', summary: 'A mining row.' }
  }

  async command(text) {
    if (text.includes('remote.call("autorio_skills","offer"')) return JSON.stringify({ ok: true, cards: STEAM_CARDS })
    return super.command(text)
  }
}

async function skillScenario({ pick, loads }) {
  const trace = []
  const skillJev = recordingJev(async (_state, questions) => (questions.skill_choice ? { overrides: { skill_choice: { choice: pick, confidence: 0.9 } } } : undefined))
  let call = 0
  const agent = new NpcAgentLoop({
    rcon: new SkillFactorio(),
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'skill order scenario',
    npcId: 'sgluna',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    skillDecisionProvider: skillJev,
    provider: async () => {
      call++
      if (call === 1 && loads) return { content: 'Loading.', tool_calls: [{ index: 0, id: 'call_00_skill0000000000000001', type: 'function', function: { name: 'getSkillDetails', arguments: JSON.stringify({ id: loads }) } }] }
      return planReply({ plan: ['Build a starter steam power chain', 'Check the generator runs'], operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  await agent.request('Get steam power running so we have electricity', { sender: 'Louis' })
  await agent.skillChoicePending
  return { agent, trace, rows: event => trace.filter(record => record.event === event) }
}

test('skill order in shadow: Jev\'s pick is recorded in the ledger and scored against what the agent actually loaded; the stage never leaves shadow', async () => {
  const used = await skillScenario({ pick: 'steam-power-bootstrap', loads: 'steam-power-bootstrap' })
  const recorded = used.rows('jev.judgment_recorded').find(row => row.data.family === 'skill_order')
  assert.equal(recorded.data.stage, 'shadow')
  assert.equal(recorded.data.acted, false)
  assert.equal(recorded.data.jev_choice, 'steam-power-bootstrap')
  assert.equal(recorded.data.reason, 'shadow_skill_order_never_reaches_the_prompt')
  assert.equal(recorded.data.alternative.top, 'steam-power-bootstrap')
  assert.ok(recorded.request_id)
  const scored = used.rows('jev.judgment_scored').find(row => row.data.family === 'skill_order')
  assert.equal(scored.data.agreed, true)
  assert.deepEqual(scored.data.outcome.loaded_skills, ['steam-power-bootstrap'])
  assert.equal(scored.data.stage, 'shadow')

  const ignored = await skillScenario({ pick: 'starter-mining-belt-output', loads: 'steam-power-bootstrap' })
  assert.equal(ignored.rows('jev.judgment_scored').find(row => row.data.family === 'skill_order').data.agreed, false, 'the agent loaded a different skill')
  const none = await skillScenario({ pick: 'starter-mining-belt-output', loads: undefined })
  assert.equal(none.rows('jev.judgment_scored').find(row => row.data.family === 'skill_order').data.agreed, false, 'Jev picked a skill the agent never loaded')
  const skip = await skillScenario({ pick: 'none', loads: undefined })
  assert.equal(skip.rows('jev.judgment_scored').find(row => row.data.family === 'skill_order').data.agreed, true, 'none agrees with loading nothing')

  // Even with the evidence for a higher stage, skill order is never allowed above shadow.
  const capped = restoreLedger({ ...serializeLedger(emptyLedger()), families: { ...serializeLedger(emptyLedger()).families, skill_order: { ...serializeLedger(emptyLedger()).families.skill_order, stage: 'advisory', scored: 30, agreed: 30, evidence: 30, window: Array.from({ length: 30 }, () => 1) } } }).ledger
  assert.equal(effectiveStage(capped, 'skill_order'), 'shadow')
})

// ---------------------------------------------------------------------------------------------------------------
// The run record and the run-check read the judgment rows
// ---------------------------------------------------------------------------------------------------------------

async function shadowRun() {
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  return world
}

async function decidingRun() {
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  forceStage(world, 'c4_next_step', 'deciding', { samples: [2400, 2600] })
  await runSliceWithContractedStep2(world)
  return world
}

const familyOf = (record, name) => record.jev.by_family.find(row => row.family === name)

test('run record: a shadow run reports judgments per family, agreement, stage and the wakes and tokens that would have been saved, and nothing realized', async () => {
  const world = await shadowRun()
  const record = buildRunRecord(world.trace)
  const c4 = familyOf(record, 'c4_next_step')
  // The wake looked something up, so observation was needed and the direct answer disagrees (and would save nothing).
  assert.deepEqual({ stage: c4.stage, recorded: c4.recorded, scored: c4.scored, agreed: c4.agreed, agreement: c4.agreement, acted: c4.acted }, { stage: 'shadow', recorded: 1, scored: 1, agreed: 0, agreement: 0, acted: 0 })
  const none = { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 0 }
  assert.deepEqual(c4.would_save, none)
  assert.deepEqual(c4.saved, none)
  assert.equal(c4.ledger.scored, 1)
  assert.equal(c4.removal_candidate, false)
  // Every family that judged appears, in the ledger's order, with its own counts.
  assert.deepEqual(record.jev.by_family.map(row => row.family), ['c4_next_step', 'observation_families', 'shelf_ranking'])
  assert.equal(familyOf(record, 'observation_families').recorded, 2, 'two restages (the two committed slices)')
  assert.deepEqual(record.jev.savings.saved, none)
  assert.equal(record.jev.savings.would_save.tokens, 0)
  assert.equal(record.jev.savings.would_save.jev_calls, 0)
  assert.equal(record.jev.c4.observation_round_tokens, 2450, 'what the shadow wake spent on its observation round: information, not a saving')
  assert.equal(record.jev.c4.observation_rounds, 1)
  assert.equal(record.jev.c4.gate_jev_calls, 2)
  assert.equal(record.jev.llm.provider_calls, record.totals.rounds, 'the success metric sits next to what the run spent')
  assert.equal(record.jev.llm.input_units, record.totals.input_units)
  assert.equal(record.jev.llm.output_units, record.totals.output_units)
  assert.equal(record.jev.c4.wakes_measured, 1)
  assert.equal(record.jev.c4.shadow_routes, 1)
  assert.equal(record.jev.c4.deciding_routes, 0)
  assert.deepEqual(record.jev.stage_changes, [])
  const text = formatRunRecord(record)
  assert.match(text, /Jev judgments at the delegation checkpoints \(U11\):/)
  assert.match(text, /- c4_next_step: stage shadow · 1 judged, 1 scored, 0 agreed \(0%\), 0 unscored · promoted 0, demoted 0 · saved 0 LLM rounds \(0 tokens\), 0 lookup calls, 0 Jev calls · would have saved 0 LLM rounds \(0 tokens\), 0 lookup calls, 0 Jev calls/)
  assert.match(text, /- saved this run: 0 LLM rounds \(0 tokens\), 0 lookup calls, 0 Jev calls \(LLM spend: .* in, .* out, 4 calls\) · would have saved: 0 LLM rounds \(0 tokens\), 0 lookup calls, 0 Jev calls/)
  assert.match(text, /- C4 wakes measured: 1 \(observation rounds 1, 2,450 tokens, not a saving; the gate's Jev calls 2; shadow routes 1, deciding routes 0\)/)
})

test('run record: a deciding run reports the realized saving; a trace without judgment rows has no Jev section and formats as before', async () => {
  const world = await decidingRun()
  const record = buildRunRecord(world.trace)
  const c4 = familyOf(record, 'c4_next_step')
  assert.equal(c4.stage, 'deciding')
  assert.equal(c4.acted, 1)
  assert.deepEqual(c4.saved, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 2 })
  assert.deepEqual(c4.would_save, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 0 })
  assert.deepEqual(record.jev.savings.saved, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 2 })
  assert.equal(record.jev.c4.deciding_routes, 1)
  assert.match(formatRunRecord(record), /- saved this run: 0 LLM rounds \(0 tokens\), 0 lookup calls, 2 Jev calls/)

  const off = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS, agentOptions: { jevCheckpoints: false } })
  await runSliceWithContractedStep2(off)
  const plain = buildRunRecord(off.trace)
  assert.equal(plain.jev, undefined)
  assert.doesNotMatch(formatRunRecord(plain), /Jev judgments/)
})

test('run record: promotions and demotions in the trace, the skip reasons and the removal flag are reported', () => {
  const row = (event, data, index) => ({ schema: 1, ts: `2026-09-30T10:00:${String(index).padStart(2, '0')}.000Z`, seq: index, event, request_id: 'req_a_1', data })
  const rows = [
    row('provider.response', { usage: { input_units: 1000, output_units: 100, usage_complete: true }, provider: { model: 'm' } }, 1),
    row('jev.judgment_scored', { family: 'shelf_ranking', agreed: true, acted: false, realized: false, stage: 'advisory', earned_stage: 'advisory', ledger: { scored: 30, agreement: 0.9, stage: 'advisory', removal_candidate: true } }, 2),
    row('jev.stage_changed', { family: 'shelf_ranking', from: 'shadow', to: 'advisory', direction: 'promoted', effective_to: 'advisory', reason: 'evidence_met: 30/30' }, 3),
    row('jev.stage_changed', { family: 'c4_next_step', from: 'deciding', to: 'shadow', direction: 'demoted', effective_to: 'shadow', reason: 'rolling_agreement_below_threshold: 53/60' }, 4),
    row('jev.judgment_skipped', { family: 'c4_next_step', reason: 'jev_fallback' }, 5),
    row('jev.judgment_skipped', { family: 'c4_next_step', reason: 'jev_fallback' }, 6),
    row('jev.judgment_unscored', { family: 'skill_order', reason: 'superseded' }, 7),
  ]
  const record = buildRunRecord(rows)
  assert.deepEqual(record.jev.skipped, { jev_fallback: 2 })
  assert.deepEqual(record.jev.removal_candidates, ['shelf_ranking'])
  assert.equal(familyOf(record, 'shelf_ranking').promotions, 1)
  assert.equal(familyOf(record, 'c4_next_step').demotions, 1)
  assert.equal(familyOf(record, 'c4_next_step').stage, 'shadow')
  assert.equal(familyOf(record, 'skill_order').unscored, 1)
  assert.deepEqual(record.jev.stage_changes.map(change => `${change.family} ${change.direction} ${change.from}->${change.to}`), ['shelf_ranking promoted shadow->advisory', 'c4_next_step demoted deciding->shadow'])
  const text = formatRunRecord(record)
  assert.match(text, /FLAGGED FOR REMOVAL: no measured saving \(the owner decides\)/)
  assert.match(text, /stage change: c4_next_step demoted deciding -> shadow \(req_a_1\): rolling_agreement_below_threshold: 53\/60/)
  assert.match(text, /judgments skipped \(never counted as agreement\): jev_fallback 2/)
})

test('run-check: a demoted family and a deciding route whose skipped step failed to verify are found per request; shadow and healthy deciding runs are clean', async () => {
  // Healthy runs: nothing to report.
  for (const world of [await shadowRun(), await decidingRun()]) {
    const findings = analyzeBehaviorTrace(world.trace).findings.filter(finding => finding.signature.startsWith('jev_'))
    assert.deepEqual(findings, [])
  }

  // The deciding route skipped the wake, the step failed on its first batch, and the family was demoted.
  const world = harness({ script: [plannerSlice(), executorStep(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  const saved = serializeLedger(emptyLedger())
  saved.families.c4_next_step = { ...saved.families.c4_next_step, stage: 'deciding', scored: 60, agreed: 54, evidence: 60, window: [...Array.from({ length: 54 }, () => 1), ...Array.from({ length: 6 }, () => 0)] }
  world.memory.jevLedger = restoreLedger(saved).ledger
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed()
  await world.agent.failed(world.game.failLastBatch({ type: 'mining', code: 'no_resource' }))
  world.give('copper-ore')
  await world.agent.completed()
  const requestId = world.rows('request.received')[0].request_id

  const result = analyzeBehaviorTrace(world.trace)
  const skipped = result.findings.filter(finding => finding.signature === 'jev_deciding_skip_unverified')
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].request_id, requestId)
  assert.equal(skipped[0].count, 1)
  assert.match(skipped[0].detail, /deciding route skipped the wake for jdg_.* but the step did not verify on its first batch \(verified=undefined, failure_boundary=true\)/)
  const demoted = result.findings.filter(finding => finding.signature === 'jev_family_demoted')
  assert.equal(demoted.length, 1)
  assert.equal(demoted[0].request_id, requestId)
  assert.match(demoted[0].detail, /c4_next_step demoted deciding -> shadow: rolling_agreement_below_threshold: 53\/60/)
  assert.match(formatCheckReport(result), /\[jev_deciding_skip_unverified\] request_id=.* :: deciding route skipped the wake/)
  assert.match(formatCheckReport(result), /\[jev_family_demoted\]/)
  assert.equal(JEV_TRACE_ROWS.events.stageChanged, 'jev.stage_changed')

  // A disagreement that did NOT act (shadow) is not a deciding skip.
  const synthetic = [{ schema: 1, ts: '2026-09-30T10:00:00.000Z', seq: 1, event: 'jev.judgment_scored', request_id: 'req_s_1', data: { family: 'c4_next_step', acted: false, agreed: false, outcome: { step_verified: false } } }]
  assert.deepEqual(analyzeBehaviorTrace(synthetic).findings.filter(finding => finding.signature === 'jev_deciding_skip_unverified'), [])
})

// ---------------------------------------------------------------------------------------------------------------
// Bounds, ungated fact reads, cancellation
// ---------------------------------------------------------------------------------------------------------------

test('every U11 Jev request stays inside the live decision-provider limits, even with the largest shelf the ranking may carry', () => {
  const live = { ...DECISION_PROVIDER_DEFAULTS, key: 'fixture-contract-check' }
  const candidates = Array.from({ length: 32 }, (_, index) => ({
    node_id: `node_${index + 1}`,
    intent: `intent ${index + 1} `.padEnd(400, 'x'),
    why_it_matters: 'why '.padEnd(300, 'y'),
    status: 'ready_to_refine',
    depends_on: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    verified_results: ['r1'.padEnd(200, 'z'), 'r2', 'r3', 'r4'],
  }))
  const questions = shelfRankingQuestions(candidates)
  const { serialized } = normalizeDecisionProviderRequest(live, { contract: 'shelf_ranking', goal: { goal_id: 'g', objective: 'o'.repeat(300) }, candidate_count: 32 }, questions)
  assert.ok(serialized.length <= live.maxInputChars, `${serialized.length} chars`)
  assert.ok(Object.keys(questions.shelf_ranking.criteria).every(key => /^c\d+$/.test(key)))
  assert.doesNotThrow(() => normalizeDecisionProviderRequest(live, { contract: 'c4_next_step_route' }, c4Questions()))
})

test('deciding C4 keeps fact reads ungated: a read the executor asks for in the direct wake is still admitted, then the round must decide', async () => {
  const inventoryObservation = () => ({ tool_calls: [{ id: 'call_inv', index: 0, type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] })
  const world = harness({ script: [plannerSlice(), inventoryObservation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS, game: new FactsFactorio() })
  forceStage(world, 'c4_next_step', 'deciding', { samples: [2500] })
  await runSliceWithContractedStep2(world)
  assert.equal(world.rows('c4.route_applied')[0].data.mode, 'deciding')
  assert.equal(world.game.factReads, 1, 'the inventory read ran')
  assert.deepEqual(world.rows('observation.tier_admitted')[0].data.tools, [{ tool: 'getInventoryItems', tier: 'fact' }])
  const measured = world.rows('c4.wake_measured')[0]
  assert.equal(measured.data.fresh_lookups, 1)
  assert.equal(measured.data.observation_rounds, 1, 'the fact read is an observation round')
  // The agent still chose to look something up, so observation WAS needed: the direct answer disagrees and saves nothing.
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, false)
  assert.equal(scored.data.saving, undefined)
})

test('cancelling a request aborts an in-flight U11 Jev call and abandons the judgments still waiting for an outcome; nothing counts as agreement', async () => {
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await world.say()
  contractSecondStep(world)
  forceStage(world, 'observation_families', 'advisory') // the stage that waits for Jev's answer
  const scoredBefore = summarizeLedger(world.ledger()).find(family => family.family === 'observation_families').scored

  // 1. A call in flight when the request is cancelled: the provider that never answers is aborted and nothing is recorded.
  let inFlight
  const reachedJev = new Promise((resolve) => { inFlight = resolve })
  world.agent.interactionDecisionProvider = async (_state, _questions, context) => new Promise((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error('Decision provider request cancelled')), { once: true })
    inFlight()
  })
  const pending = world.agent.jev.prepareRestage({ checkpoint: 'C3', role: 'executor', planningState: world.memory.planningState(KEY), reason: 'x', requestId: 'req_x' })
  await reachedJev // the call is now in flight
  world.agent.cancel('test_cancel')
  assert.equal(await pending, undefined)
  assert.equal(summarizeLedger(world.ledger()).find(family => family.family === 'observation_families').scored, scoredBefore)
  assert.ok(world.rows('jev.judgment_skipped').some(row => row.data.family === 'observation_families' && row.data.reason === 'jev_fallback'))

  // 2. A judgment waiting for its outcome when the request is cancelled is abandoned, never scored.
  const second = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await second.say()
  contractSecondStep(second)
  second.give('iron-ore')
  await second.agent.completed() // step 1 closed, the direct wake ran with no lookup: the C4 judgment waits for step 2 to verify
  assert.equal(second.rows('jev.judgment_scored').filter(row => row.data.family === 'c4_next_step').length, 0)
  second.agent.cancel('user_stop')
  const unscored = second.rows('jev.judgment_unscored').find(row => row.data.family === 'c4_next_step')
  assert.equal(unscored.data.reason, 'request_cancelled_before_an_outcome')
  assert.equal(unscored.data.recorded_as_agreement, false)
  assert.equal(summarizeLedger(second.ledger()).find(family => family.family === 'c4_next_step').scored, 0)
  assert.equal(summarizeLedger(second.ledger()).find(family => family.family === 'c4_next_step').unscored, 1)
})

test('a step that verified while the wake was still running is scored the moment the wake ends', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const jev = world.agent.jev
  const judgment = await jev.record({ family: 'c4_next_step', request_id: 'req_w', step_id: 'step_x', plan_id: 'plan_x', jev_choice: 'direct_to_executor', jev_confidence: 0.9, alternative: { kind: 'test' }, reason: 'test' })
  jev.track({ kind: 'c4', judgment_id: judgment.judgment_id, request_id: 'req_w', plan_id: 'plan_x', step_id: 'step_x', choice: 'direct_to_executor', acted: false, had_failure: false, verified: true })
  jev.beginWake({ key: judgment.judgment_id })
  assert.equal(world.rows('jev.judgment_scored').length, 0, 'not scoreable before the wake is measured')
  await jev.endWake({ key: judgment.judgment_id })
  const [scored] = world.rows('jev.judgment_scored')
  assert.equal(scored.data.judgment_id, judgment.judgment_id)
  assert.equal(scored.data.agreed, true)
})

// ---------------------------------------------------------------------------------------------------------------
// Review fixes: the runtime's own wait checks come before any judgment (blocker 1)
// ---------------------------------------------------------------------------------------------------------------

class FollowFactorio extends FakeFactorio {
  async command(text) {
    if (this.follow && text.includes('remote.call("autorio_follow","status")')) return JSON.stringify(this.follow)
    return super.command(text)
  }
}

const GATE_WAITS = {
  route: { choice: 'continue_runtime', confidence: 0.9 },
  development: { choice: 'maintain', confidence: 0.9 },
  next_step_route: directAnswer,
}

// Step 1 closes while the runtime already owns work; the family is deciding and Jev says direct. The route must be exactly
// the one a run with U11 off takes: the post-step gate's own wait checks decide.
async function decidingWithRuntimeWork({ prepare, deciding = true }) {
  const run = async (agentOptions) => {
    const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev: scriptedJev(GATE_WAITS), tokens: SLICE_TOKENS, game: new FollowFactorio(), agentOptions })
    if (deciding && agentOptions?.jevCheckpoints !== false) forceStage(world, 'c4_next_step', 'deciding', { samples: [2500] })
    await world.say()
    contractSecondStep(world)
    await prepare(world)
    world.give('iron-ore')
    world.result = await world.agent.completed()
    return world
  }
  return { on: await run({}), off: await run({ jevCheckpoints: false }) }
}

for (const [label, reason, prepare] of [
  ['an active condition wait', 'condition_wait_active', (world) => {
    world.agent.validateConditionWaitHealth = async () => ({ healthy: true, action: 'wait', wait: { wait_id: 'wait_research_x', condition: { kind: 'research' } } })
  }],
  ['persistent runtime work (a healthy follow controller)', 'persistent_controller_active', (world) => {
    world.game.follow = { active: true, healthy: true, controller_live: true, state: 'following', target_player: 'tester', current_distance: 4, desired_distance: 4 }
  }],
  ['autorio queued work', 'autorio_active_work', (world) => {
    // The gate verifies the step from the batch receipt the runtime recorded (an idle read); the status the boundary then
    // carries shows more work queued behind it.
    const receipt = world.agent.taskStatusReceipt.bind(world.agent)
    world.agent.taskStatusReceipt = async () => {
      const result = await receipt()
      return { ...result, view: { ...result.view, task_state: 'crafting', queue_length: 2 }, providerStatus: { ...result.providerStatus, task_state: 'crafting', queue_length: 2 } }
    }
  }],
]) {
  test(`deciding C4 with ${label}: no judgment is asked or applied, the step is not clear, and the route is wait_runtime exactly as with U11 off`, async () => {
    const { on, off } = await decidingWithRuntimeWork({ prepare })
    assert.equal(off.rows('step.verified').length, 1, 'the step really closed: this is a C4 boundary')
    assert.equal(on.rows('step.verified').length, 1)
    const [clear] = on.rows('c4.next_step_clear')
    assert.equal(clear.data.clear, false)
    assert.ok(clear.data.failed_checks.includes('authoritative_runtime_active'))
    assert.equal(clear.data.runtime_reason, reason)
    assert.match(clear.data.reason, /^not_clear: .*authoritative_runtime_active/)
    assert.equal(clear.data.evidence.no_runtime_work, false)
    assert.equal(clear.request_id, on.rows('request.received')[0].request_id)
    assert.equal(on.jev.calls.some(call => call.state?.contract === 'c4_next_step_route'), false, 'no Jev call')
    assert.equal(on.rows('jev.judgment_recorded').some(row => row.data.family === 'c4_next_step'), false)
    assert.equal(on.rows('c4.route_applied').length, 0)
    // The route is the gate's, identical to a run without these judgments: wait_runtime, no model woken.
    assert.equal(off.result, null)
    assert.equal(on.result, null)
    assert.equal(on.calls.length, off.calls.length)
    assert.deepEqual(on.rows('post_step.routed').map(row => [row.data.route, row.data.applied_route]), off.rows('post_step.routed').map(row => [row.data.route, row.data.applied_route]))
    assert.equal(on.rows('planner.skipped').length, off.rows('planner.skipped').length)
    assert.equal(on.agent.latestCompletedBatchId, off.agent.latestCompletedBatchId)
    assert.equal(on.agent.latestCompletedBatchId, on.game.batchId)
  })
}

test('with no decision provider an active condition wait is wait_runtime and U11 writes nothing (the behaviour the deciding path must not bypass)', async () => {
  const world = harness({ script: [plannerSlice(), executorStep()], tokens: SLICE_TOKENS, noJev: true })
  await world.say()
  contractSecondStep(world)
  world.agent.validateConditionWaitHealth = async () => ({ healthy: true, action: 'wait', wait: { wait_id: 'w' } })
  world.give('iron-ore')
  assert.equal(await world.agent.completed(), null)
  assert.equal(world.trace.some(isU11Row), false)
  assert.equal(world.calls.length, 1)
})

test('deciding C4: work the runtime takes on DURING Jev\'s answer, or an amendment staged during it, keeps the route the gate\'s (the late checks only make it more cautious)', async () => {
  for (const [label, hook, reason] of [
    ['runtime work', (world) => { world.game.taskState = 'mining'; world.game.queueLength = 1 }, 'authoritative_runtime_active'],
    ['an amendment', (world) => { world.agent.pendingInteractionAmendment = { sender: 'TTLouis', text: 'use the lake to the north' }; world.agent.pendingAmendmentConversationSeq = world.agent.agentContext.conversationSeq }, 'amendment_staged_during_the_jev_call'],
  ]) {
    let world
    const jev = scriptedJev({ next_step_route: directAnswer }, { onCall: (state) => { if (state?.contract === 'c4_next_step_route') hook(world) } })
    world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], jev, tokens: SLICE_TOKENS })
    forceStage(world, 'c4_next_step', 'deciding', { samples: [2500] })
    await world.say()
    contractSecondStep(world)
    world.give('iron-ore')
    await world.agent.completed()
    const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'c4_next_step')
    assert.equal(recorded.data.acted, false, label)
    assert.equal(recorded.data.reason, `route_unchanged_${reason}`, label)
    assert.equal(recorded.data.detail.late_check.startsWith(reason), true)
    assert.equal(world.rows('c4.route_applied').some(row => row.data.mode === 'deciding'), false, `${label}: no direct route`)
    assert.equal(world.rows('planner.wake').some(row => row.data.source === 'c4_next_step_clear'), false, label)
    assert.equal(world.rows('c4.route_applied').find(row => row.data.mode === 'route_unchanged').data.reason, 'route_unchanged_low_confidence_or_ground_first_or_late_check')
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Review fixes: shadow is a timing no-op; stages that need the answer ask after the guard and wait a bounded time
// ---------------------------------------------------------------------------------------------------------------

test('a shadow Jev that never answers in time leaves provider-call order, messages, restage outcomes and the trace sequence identical to Jev off; late answers are discarded, not recorded', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = scriptedJev({ next_step_route: directAnswer, shelf_ranking: rankingAnswer }, { onCall: async (state) => { if (U11_CONTRACTS.has(state?.contract)) await gate } })
  const script = () => [oneStepSlice({ plan: TWO_STEPS, roadmap: SHELF_SEVEN }), observation(), executorStep(), plannerNextSlice({ roadmapNodeIds: ['n7'] })]
  const off = harness({ script: script(), tokens: PLANNER_TOKENS, agentOptions: { jevCheckpoints: false, ...plannerRestage } })
  await runSliceWithContractedStep2(off)
  const on = harness({ script: script(), jev: slow, tokens: PLANNER_TOKENS, settle: false, agentOptions: plannerRestage })
  let closeStartedAt
  let wakeStartedAt
  const completed = on.agent.completed.bind(on.agent)
  on.agent.completed = async (...args) => { closeStartedAt ??= Date.now(); return completed(...args) }
  const observed = on.script[1]
  on.script[1] = async () => { wakeStartedAt = Date.now(); return observed }
  await runSliceWithContractedStep2(on) // every U11 call is still waiting: nothing on the critical path waited for it
  assert.ok(wakeStartedAt - closeStartedAt < ADVISORY_WAIT_MS / 2, `the executor's wake began ${wakeStartedAt - closeStartedAt} ms after the step close: it did not wait for Jev`)

  assert.ok(slow.calls.filter(call => U11_CONTRACTS.has(call.state?.contract)).length >= 3, 'the shadow calls were started')
  assert.equal(on.rows('jev.judgment_recorded').length, 0, `none has answered: ${JSON.stringify(on.rows('jev.judgment_recorded').map(row => row.data.family))}`)
  assert.deepEqual(on.calls.map(call => normalize(call.messages)), off.calls.map(call => normalize(call.messages)), 'identical provider requests in identical order')
  assert.deepEqual(on.trace.filter(record => !isU11Row(record)).map(record => record.event), off.trace.map(record => record.event), 'identical behavior rows')
  assert.deepEqual(on.rows('context.restaged').map(row => `${row.data.role}:${row.data.checkpoint}`), off.rows('context.restaged').map(row => `${row.data.role}:${row.data.checkpoint}`), 'identical restage outcomes')
  assert.equal(on.rows('context.restage_refused').length, off.rows('context.restage_refused').length)

  release()
  await on.settle()
  // The turn, the conversation and the step moved on while Jev thought: every answer is discarded and traced, none recorded.
  // Only the restage still in force (the last executor, whose window is open and whose conversation is current) may record.
  assert.deepEqual(on.rows('jev.judgment_recorded').map(row => [row.data.family, row.data.checkpoint]), [['observation_families', 'C3']])
  assert.equal(on.rows('jev.judgment_recorded').some(row => ['c4_next_step', 'shelf_ranking'].includes(row.data.family)), false)
  const discarded = on.rows('jev.judgment_skipped').filter(row => row.data.reason === 'answer_discarded_stale')
  assert.ok(discarded.length >= 2, `late answers discarded: ${discarded.length}`)
  assert.ok(discarded.every(row => row.data.recorded_as_agreement === false && typeof row.request_id === 'string'))
  assert.ok(summarizeLedger(on.ledger()).every(family => family.scored === 0 && family.agreed === 0))
})


test('advisory observation families: a round that starts during the wait is caught by the guard after it (the restage is refused, nothing is swapped, the judgment is abandoned); a guard that refuses beforehand spends no call', async () => {
  let world
  world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev: scriptedJev({ next_step_route: directAnswer, ...Object.fromEntries(Object.entries(FAMILY_ANSWERS).map(([id, answer]) => [id, restageOnly(answer)])) }, { onCall: (state) => { if (state?.contract === 'restage_observation_families' && world?.armed) world.agent.providerCallsByGeneration.set(world.agent.generation, 1) } }), tokens: SLICE_TOKENS, game: new FactsFactorio() })
  await world.say() // C3 happens here (shadow stage: nothing waits)
  forceStage(world, 'observation_families', 'advisory')
  const planning = world.memory.planningState(KEY)
  const callsBefore = world.jev.calls.length

  // A chat turn starts a provider round while the restage waits for Jev.
  world.armed = true
  const refused = await world.agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: world.agent.epoch, planningState: planning })
  world.agent.providerCallsByGeneration.delete(world.agent.generation)
  world.armed = false
  assert.equal(refused.restaged, false)
  assert.equal(refused.reason, 'round_in_flight', 'the guard ran after the await')
  assert.equal(world.jev.calls.length, callsBefore + 1, 'the call was made once the guard had passed')
  const row = world.rows('context.restage_refused').at(-1)
  assert.equal(row.data.reason, 'round_in_flight')
  assert.equal(world.agent.agentContext.role, 'executor')
  const unscored = world.rows('jev.judgment_unscored').at(-1)
  assert.match(unscored.data.reason, /restage_not_applied: round_in_flight/)

  // A round already in flight BEFORE the wait: the restage would be refused, so no call is spent on it.
  world.agent.providerCallsByGeneration.set(world.agent.generation, 1)
  const callsNow = world.jev.calls.length
  const early = await world.agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: world.agent.epoch, planningState: planning })
  world.agent.providerCallsByGeneration.delete(world.agent.generation)
  assert.equal(early.restaged, false)
  assert.equal(world.jev.calls.length, callsNow, 'never burn a call on a restage that will be refused')
})

test('an advisory wait is bounded: a Jev that does not answer in time leaves the packet as it was and the restage proceeds', async () => {
  const hang = scriptedJev({ next_step_route: directAnswer }, { onCall: async (state) => { if (state?.contract === 'restage_observation_families') await new Promise(() => {}) } })
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev: hang, tokens: SLICE_TOKENS, settle: false })
  await world.say()
  forceStage(world, 'observation_families', 'advisory')
  world.agent.jev.waitMs = 25
  const started = Date.now()
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: world.agent.epoch })
  assert.equal(result.restaged, true, 'the restage did not wait for Jev')
  assert.ok(Date.now() - started < 2000)
  assert.equal(JSON.stringify(world.agent.messages).includes('jev_fact'), false)
  const skipped = world.rows('jev.judgment_skipped').find(row => row.data.family === 'observation_families')
  assert.equal(skipped.data.reason, 'jev_fallback')
  assert.match(skipped.data.error, /bounded wait/)
})

// ---------------------------------------------------------------------------------------------------------------
// Review nits
// ---------------------------------------------------------------------------------------------------------------

test('nit a: the ledger persist is deferred past the trace write, coalesced, and a failed write is caught (no unhandled rejection, no delay for callers)', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  let writes = 0
  world.agent.persistState = () => { writes++; return Promise.reject(new Error('disk full')) }
  const jev = world.agent.jev
  jev.persist()
  jev.persist()
  jev.persist()
  assert.equal(writes, 0, 'nothing is snapshotted synchronously inside the trace write')
  await jev.flushPersist()
  assert.equal(writes, 1, 'one write for the burst')
  await new Promise(resolve => setImmediate(resolve)) // a rejection nobody handles would fail the run here
  // scoreNow inside observe() only schedules the write.
  writes = 0
  const recorded = await jev.record({ family: 'skill_order', request_id: 'req_p', jev_choice: 'none', reason: 'test' })
  jev.scoreNow(recorded.judgment_id, { agreed: true, outcome: {} })
  assert.equal(writes, 0)
  await jev.idle()
  assert.equal(writes, 1)
})

test('nit b: U11 decision.response rows carry the same usage and cost fields as the gate\'s rows', async () => {
  const base = scriptedJev({ next_step_route: directAnswer })
  const withUsage = Object.assign(async (...args) => ({ ...(await base(...args)), usage: { input_tokens: 120, output_tokens: 9, cost: 0.0000042 } }), { calls: base.calls, callsWith: base.callsWith })
  const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], jev: withUsage, tokens: SLICE_TOKENS })
  const decisions = []
  const original = world.agent.decisionTraceEvent.bind(world.agent)
  world.agent.decisionTraceEvent = (event, data) => { decisions.push({ event, data }); return original(event, data) }
  await runSliceWithContractedStep2(world)
  const responses = decisions.filter(item => item.event === 'decision.response')
  const u11 = responses.filter(item => U11_CONTRACTS.has(item.data.contract))
  const gate = responses.find(item => item.data.contract === 'post_step_planner_gate')
  assert.ok(u11.length >= 3 && gate)
  for (const item of u11) {
    assert.deepEqual({ input_units: item.data.input_units, output_units: item.data.output_units, cost_usd: item.data.cost_usd }, { input_units: 120, output_units: 9, cost_usd: 0.0000042 }, item.data.contract)
    for (const key of ['input_units', 'output_units', 'cost_usd', 'latency_ms', 'provider', 'model']) assert.ok(key in gate.data && key in item.data, `${key} is on both the gate row and the U11 row`)
  }
})

test('nit c: a shelf ranking whose picked slice FAILS (blocked, superseded or cancelled) is scored as a disagreement, not left waiting', async () => {
  const world = harness({
    script: [oneStepSlice({ roadmap: SHELF_SEVEN }), plannerNextSlice({ roadmapNodeIds: ['n7'] })],
    jev: scriptedJev({ shelf_ranking: rankingAnswer }),
    tokens: PLANNER_TOKENS,
    agentOptions: plannerRestage,
  })
  await world.say()
  world.give('iron-ore')
  await world.agent.completed() // the planner picks n7
  assert.equal(world.rows('jev.judgment_scored').filter(row => row.data.family === 'shelf_ranking').length, 0, 'the slice has not finished')
  const state = structuredClone(world.memory.planningState(KEY))
  getActivePlan(state).status = PLAN_STATUS.BLOCKED
  world.memory.planningByNpc.set(KEY, state)
  await world.agent.writeTraceEvent('request.failed', { message: 'blocked' })
  await world.settle()
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'shelf_ranking')
  assert.equal(scored.data.agreed, false)
  assert.equal(scored.data.outcome.slice_verified, false)
  assert.equal(scored.data.outcome.slice_status, 'BLOCKED')
  assert.equal(scored.data.outcome.picked, 'n7')
})

test('nit d: a fresh agent that looked nothing up is not agreement; the judgment is left unscored with the reason', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev: familyJev({}), tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  const obs = summarizeLedger(world.ledger()).find(family => family.family === 'observation_families')
  assert.equal(obs.agreed, 0)
  assert.equal(obs.scored, 0, 'never counted')
  assert.ok(obs.unscored >= 1)
  const unscored = world.rows('jev.judgment_unscored').find(row => row.data.family === 'observation_families')
  assert.equal(unscored.data.reason, 'no_lookups_made_nothing_to_compare')
  assert.equal(unscored.data.recorded_as_agreement, false)
})

test('nit e: an advisory shelf ranking is acted only when the ordering reached a packet; a pickup with no restage records it without acting', async () => {
  const world = await shelfSlices({ jev: scriptedJev({ shelf_ranking: rankingAnswer }), picked: 'n7', stage: 'advisory', options: { restageSoftLimitTokens: { planner: 1_000_000, executor: 1_000_000 } } })
  assert.equal(world.rows('context.restaged').filter(row => row.data.role === 'planner').length, 0, 'no planner packet was built')
  assert.equal(world.rows('jev.shelf_ranking_applied').length, 0)
  const recorded = world.rows('jev.judgment_recorded').find(row => row.data.family === 'shelf_ranking')
  assert.equal(recorded.data.acted, false)
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'shelf_ranking')
  assert.equal(scored.data.acted, false, 'it never reached the planner')
  assert.equal(scored.data.realized, false)
  // No packet to order, so the wait was never spent: the answer was not awaited on the critical path.
  assert.equal(world.jev.calls.filter(call => call.state?.contract === 'shelf_ranking').length, 2, 'asked at both pickups')
})

// ---------------------------------------------------------------------------------------------------------------
// Review nit f: C6 and C7 with U11 ON
// ---------------------------------------------------------------------------------------------------------------

function c6Jev() {
  return recordingJev(async (state, questions) => {
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
    return questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined
  })
}

async function c6Run(agentOptions) {
  const jev = c6Jev()
  const world = harness({
    script: [
      plannerSlice(),
      () => observation(),
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }),
      () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] }),
    ],
    jev,
    agentOptions,
  })
  await world.say()
  world.give('iron-ore', 2)
  await world.agent.completed()
  const result = await world.agent.recoverPlan(world.agent.generation, new Error('strategy invalidated by fresh evidence'), 1)
  await world.settle()
  world.result = result
  return world
}

test('C6 with U11 on: bounded recovery still restages a fresh executor silently, its packet is identical to a run with U11 off, and the restage is judged (shadow) without changing it', async () => {
  const on = await c6Run({})
  const off = await c6Run({ jevCheckpoints: false })
  assert.equal(on.result.goalStatus, 'active')
  const row = on.rows('context.restaged').find(item => item.data.checkpoint === 'C6')
  assert.ok(row, 'a C6 restage')
  assert.equal(row.data.role, 'executor')
  assert.equal(on.rows('request.completed').filter(item => item.data.outcome === 'asked_user').length, 0, 'no user interruption')
  assert.equal(normalize(on.calls.at(-1).messages), normalize(off.calls.at(-1).messages), 'the recovery round receives the same packet')
  assert.deepEqual(on.calls.map(call => normalize(call.messages)), off.calls.map(call => normalize(call.messages)))
  // The C6 restage was judged: one call with its checkpoint, recorded after the restage landed.
  const asked = on.jev.calls.filter(call => call.state?.contract === 'restage_observation_families' && call.state.checkpoint === 'C6')
  assert.equal(asked.length, 1)
  const judged = on.rows('jev.judgment_recorded').find(item => item.data.family === 'observation_families' && item.data.checkpoint === 'C6')
  assert.ok(judged)
  assert.equal(judged.data.stage, 'shadow')
  assert.equal(judged.data.acted, false)
  assert.equal(off.jev.calls.some(call => call.state?.contract === 'restage_observation_families'), false)
})

test('C7 with U11 on: recovery after a restart restages from the packet as before and Jev is never asked about it (C7 is not a judged checkpoint)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-jev-c7-'))
  const run = async (agentOptions, file) => {
    const game = new FakeFactorio()
    const first = harness({ script: [plannerSlice()], game, stateFile: file, agentOptions })
    await first.say()
    await first.agent.persistQueue
    const jev = scriptedJev({ next_step_route: directAnswer })
    const second = harness({ script: [() => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 4)] })], game, stateFile: file, jev, agentOptions, memory: new CanonicalTaskBoardMemory() })
    await second.agent.loadPersistentState()
    const recovery = await recoverInterruptedAgentPlan(second.agent, 'runtime_restart', {})
    await second.settle()
    return { second, recovery, jev }
  }
  const on = await run({}, path.join(dir, 'on.json'))
  const off = await run({ jevCheckpoints: false }, path.join(dir, 'off.json'))
  assert.equal(on.recovery.recovered, true)
  const row = on.second.rows('context.restaged').find(item => item.data.checkpoint === 'C7')
  assert.ok(row)
  assert.equal(on.jev.calls.some(call => call.state?.contract === 'restage_observation_families'), false, 'no Jev call for C7')
  assert.equal(on.second.trace.some(record => record.event === 'jev.judgment_recorded' && record.data.checkpoint === 'C7'), false)
  assert.equal(normalize(on.second.calls[0].messages), normalize(off.second.calls[0].messages), 'the recovery packet is identical')
})

// A step that needs several batches: a batch that completes cleanly without closing it is no evidence either way.
async function multiBatchWorld(script) {
  const world = harness({ script, tokens: SLICE_TOKENS })
  await world.say()
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed() // step 1 closes; the wake makes no lookup and submits step 2's first batch
  return world
}

test('nit a: a first batch that completes cleanly without closing a multi-batch step leaves the judgment pending until the step verifies', async () => {
  const world = await multiBatchWorld([plannerSlice(), executorStep(), executorStep(), plannerNextSlice()])
  await world.agent.completed() // the batch completes but only part of the copper is there: the gate does not close step 2
  assert.equal(world.rows('jev.judgment_scored').filter(row => row.data.family === 'c4_next_step').length, 0, 'no evidence either way yet')
  assert.equal(world.rows('jev.judgment_unscored').filter(row => row.data.family === 'c4_next_step').length, 0)
  world.give('copper-ore')
  await world.agent.completed() // the second batch closes it
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, true, 'a step that simply needed two batches still agrees with direct')
  assert.equal(scored.data.outcome.observation_needed, false)
  assert.equal(scored.data.outcome.followup_lookups, 0)
})

test('nit a: a rejected or failed batch, or observation lookups in a later wake of the step, make it needed', async () => {
  // A rejected admission.
  const rejected = await multiBatchWorld([plannerSlice(), executorStep(), executorStep(), plannerNextSlice()])
  await rejected.agent.writeTraceEvent('operations.preflight_rejected', { reason: 'exact target stale' })
  await rejected.settle()
  const first = rejected.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(first.data.agreed, false)
  assert.equal(first.data.outcome.had_failure_boundary, true)
  // Lookups in the next wake of the same unfinished step.
  const looked = await multiBatchWorld([plannerSlice(), executorStep(), observation(), executorStep(), plannerNextSlice()])
  await looked.agent.completed() // partial: the gate continues the step with a new wake, which looks something up
  const second = looked.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(second.data.agreed, false)
  assert.equal(second.data.outcome.followup_lookups, 1)
  assert.equal(second.data.outcome.observation_needed, true)
})

test('a shadow answer that arrives after the fresh agent already acted (same conversation, window closed) is discarded and traced, never recorded', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = scriptedJev({ next_step_route: directAnswer }, { onCall: async (state) => { if (state?.contract === 'restage_observation_families') await gate } })
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev: slow, tokens: SLICE_TOKENS, settle: false })
  await world.say() // C3: the executor starts; Jev's observation call is pending
  contractSecondStep(world)
  world.give('iron-ore')
  await world.agent.completed() // the executor acts: its first operation is admitted and the window closes (no restage happened)
  release()
  await world.settle()
  assert.equal(world.rows('jev.judgment_recorded').some(row => row.data.family === 'observation_families'), false)
  const discarded = world.rows('jev.judgment_skipped').find(row => row.data.family === 'observation_families')
  assert.equal(discarded.data.reason, 'answer_discarded_stale')
  assert.match(discarded.data.detail, /window closed|already acted/)
})

test('advisory observation families: state is read again after the wait, so a plan that became BLOCKED during Jev\'s answer refuses the restage instead of restaging a stale packet', async () => {
  let world
  const jev = scriptedJev({ next_step_route: directAnswer, ...Object.fromEntries(Object.entries(FAMILY_ANSWERS).map(([id, answer]) => [id, restageOnly(answer)])) }, {
    onCall: (state) => {
      if (state?.contract !== 'restage_observation_families' || !world?.armed) return
      const blocked = structuredClone(world.memory.planningState(KEY))
      getActivePlan(blocked).status = PLAN_STATUS.BLOCKED
      world.memory.planningByNpc.set(KEY, blocked)
    },
  })
  world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev, tokens: SLICE_TOKENS, game: new FactsFactorio() })
  await world.say()
  forceStage(world, 'observation_families', 'advisory')
  const before = world.agent.agentContext.handoffId
  world.armed = true
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: world.agent.epoch })
  assert.equal(result.restaged, false)
  assert.equal(result.reason, 'plan_blocked', 'state was read again after the await')
  assert.equal(world.rows('context.restage_refused').at(-1).data.reason, 'plan_blocked')
  assert.equal(world.agent.agentContext.handoffId, before, 'the conversation was not swapped')
  assert.match(world.rows('jev.judgment_unscored').at(-1).data.reason, /restage_not_applied: plan_blocked/)
})

// ---------------------------------------------------------------------------------------------------------------
// The saving metric: only observation-tool rounds before the first operation, and Jev calls as their own channel
// ---------------------------------------------------------------------------------------------------------------

// The shape a live provider answers with: the plan arrives as a submitPlan TOOL CALL (has_tool_calls is true on the round
// that authors operations), not as content.
const asSubmitPlan = reply => ({ content: 'Working on it.', tool_calls: [{ id: `call_submit_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: 'submitPlan', arguments: JSON.parse(reply.content) && reply.content } }] })

test('a correct direct judgment (no lookup, first batch clean) has a NON-zero would-have-saved exactly where a saving exists: the gate and planner-shape Jev calls; no LLM rounds or tokens', async () => {
  const world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(world)
  const scored = world.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, true)
  assert.deepEqual(scored.data.saving, { jev_calls: 2, rounds: 0, tokens: 0 }, 'the two Jev calls the gate route made; the round that authors operations is not a saving')
  assert.equal(scored.data.realized, false)
  assert.equal(scored.data.ledger.would_save.jev_calls, 2)
  assert.equal(scored.data.ledger.removal_candidate, false)
  assert.equal(world.rows('c4.wake_measured')[0].data.gate_jev_calls, 2)
  assert.equal(world.rows('c4.wake_measured')[0].data.observation_rounds, 0)
})

test('live shape (submitPlan tool calls): the round that authors operations is NOT an observation round; only rounds that called an observation tool before the first operation are counted, with their tokens and number', async () => {
  // A wake with one observation round and then the submitPlan round.
  // (the gate's observation budget is wide enough that the observation round does not close the phase before submitPlan)
  const wide = scriptedJev({ next_step_route: directAnswer, need_nearby_world: { noul: 0.9 }, need_entity_status: { noul: 0.9 }, need_inventory_equipment: { noul: 0.9 } })
  const looked = harness({ script: [plannerSlice(), observation(), asSubmitPlan(executorStep()), plannerNextSlice()], jev: wide, tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(looked)
  const wake = looked.rows('c4.wake_measured')[0].data
  assert.equal(wake.rounds, 2)
  assert.equal(wake.observation_rounds, 1, 'the submitPlan round is not one')
  assert.equal(wake.observation_round_tokens, 2000 + 450, 'only the observation round: not the operation round')
  assert.equal(wake.wake_tokens, (2000 + 450) + (3000 + 450))

  // A wake that only submits the plan: no observation round at all, so nothing is claimed for LLM rounds or tokens.
  const direct = harness({ script: [plannerSlice(), asSubmitPlan(executorStep()), plannerNextSlice()], tokens: SLICE_TOKENS })
  await runSliceWithContractedStep2(direct)
  const measured = direct.rows('c4.wake_measured')[0].data
  assert.equal(measured.rounds, 1)
  assert.equal(measured.observation_rounds, 0, 'a tool-call reply that is submitPlan is the round that authors operations')
  assert.equal(measured.observation_round_tokens, 0)
  const scored = direct.rows('jev.judgment_scored').find(row => row.data.family === 'c4_next_step')
  assert.equal(scored.data.agreed, true)
  assert.equal(scored.data.saving.rounds, 0)
  assert.equal(scored.data.saving.tokens, 0, 'the operation round is not counted as saved')
  assert.equal(scored.data.saving.jev_calls, 2)
})

test('observation rounds after the first admitted operation are not counted', async () => {
  const world = harness({ script: [plannerSlice()] })
  await world.say()
  const jev = world.agent.jev
  const tracker = jev.track({ kind: 'c4', judgment_id: undefined, request_id: 'req_o', plan_id: 'plan_o', step_id: 'step_o', acted: false, had_failure: false, followup_lookups: 0 })
  jev.beginWake({ key: tracker.key })
  const round = (tokens, tool) => {
    jev.observe('provider.response', { usage: { input_units: tokens, output_units: 0 }, has_tool_calls: true }, 'req_o')
    if (tool) jev.observe('tool.call', { name: tool }, 'req_o')
  }
  round(100, 'getNearbyEntities') // an observation round before the first operation
  round(200, undefined) // a submitPlan round: a tool call, but not a tool.call row
  jev.observe('operations.ack', { operations: [] }, 'req_o') // the first operation is admitted
  round(400, 'getInventoryItems') // a later round of the same wake: not part of the measurement
  await jev.endWake({ key: tracker.key })
  assert.equal(tracker.measured.observation_rounds, 1)
  assert.equal(tracker.measured.observation_round_tokens, 100)
  assert.equal(tracker.measured.rounds, 3)
})

test('the removal flag does not fire by construction: 30 correct direct judgments that saved the gate calls are not flagged, while a family that really saved nothing is', () => {
  let saving = emptyLedger()
  for (let index = 0; index < 30; index++) {
    const recorded = recordJudgment(saving, { family: 'c4_next_step', request_id: 'req_r', jev_choice: 'direct_to_executor' })
    saving = scoreJudgment(recorded.ledger, recorded.judgment.judgment_id, { agreed: true, saving: { jev_calls: 2, rounds: 0, tokens: 0 }, outcome: {} }).ledger
  }
  const summary = summarizeLedger(saving).find(family => family.family === 'c4_next_step')
  assert.equal(summary.scored, 30)
  assert.deepEqual(summary.would_save, { wakes: 0, rounds: 0, tokens: 0, calls: 0, jev_calls: 60 })
  assert.equal(summary.removal_candidate, false)
  let barren = emptyLedger()
  for (let index = 0; index < 30; index++) {
    const recorded = recordJudgment(barren, { family: 'c4_next_step', request_id: 'req_r', jev_choice: 'direct_to_executor' })
    barren = scoreJudgment(recorded.ledger, recorded.judgment.judgment_id, { agreed: true, saving: { jev_calls: 0, rounds: 0, tokens: 0 }, outcome: {} }).ledger
  }
  assert.equal(summarizeLedger(barren).find(family => family.family === 'c4_next_step').removal_candidate, true, 'only when the correctly defined saving is really zero')
})

// ---------------------------------------------------------------------------------------------------------------
// Nits b and c
// ---------------------------------------------------------------------------------------------------------------

class CountingFollowFactorio extends FakeFactorio {
  async command(text) {
    if (text.includes('remote.call("autorio_follow","status")')) this.followReads = (this.followReads ?? 0) + 1
    return super.command(text)
  }
}

test('nit b: the runtime is inspected once per step close; the post-step gate takes C4\'s inspection instead of reading again', async () => {
  const run = async (agentOptions) => {
    const world = harness({ script: [plannerSlice(), observation(), executorStep(), plannerNextSlice()], tokens: SLICE_TOKENS, game: new CountingFollowFactorio(), agentOptions })
    await world.say()
    contractSecondStep(world)
    world.give('iron-ore')
    const before = world.game.followReads ?? 0
    await world.agent.completed()
    return (world.game.followReads ?? 0) - before
  }
  const off = await run({ jevCheckpoints: false })
  const on = await run({})
  assert.ok(off >= 1)
  assert.equal(on, off, 'no extra RCON read before the gate')
})

test('nit c: the reducer is read again after the advisory wait even when the caller passed its own state: a blocked plan refuses, and a plan that is no longer the one the caller settled means the state moved on', async () => {
  for (const [label, mutate, expected] of [
    ['blocked', (world) => { const next = structuredClone(world.memory.planningState(KEY)); getActivePlan(next).status = PLAN_STATUS.BLOCKED; world.memory.planningByNpc.set(KEY, next) }, 'plan_blocked'],
    ['another plan', (world) => { const next = structuredClone(world.memory.planningState(KEY)); next.active_plan_id = 'plan_someone_else'; world.memory.planningByNpc.set(KEY, next) }, 'state_moved_on_during_jev_wait'],
  ]) {
    let world
    const jev = scriptedJev({ next_step_route: directAnswer }, { onCall: (state) => { if (state?.contract === 'restage_observation_families' && world?.armed) mutate(world) } })
    world = harness({ script: [plannerSlice(), executorStep(), plannerNextSlice()], jev, tokens: SLICE_TOKENS })
    await world.say()
    forceStage(world, 'observation_families', 'advisory')
    const before = world.agent.agentContext.handoffId
    world.armed = true
    const result = await world.agent.restageBetweenTurns({ checkpoint: 'C8', role: 'executor', reason: 'test', actor: world.agent.epoch, planningState: world.memory.planningState(KEY) })
    assert.equal(result.restaged, false, label)
    assert.equal(result.reason, expected, label)
    assert.equal(world.agent.agentContext.handoffId, before, `${label}: the conversation was not swapped`)
    assert.match(world.rows('jev.judgment_unscored').at(-1).data.reason, new RegExp(`restage_not_applied: ${expected}`))
  }
})
