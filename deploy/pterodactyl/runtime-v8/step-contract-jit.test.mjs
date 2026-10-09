import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE, PLANNER_ROLE } from './agent-roles.mjs'
import { STALE_REPLY_ERROR_CODE } from './agent-context.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { COMPACT_CONTINUATION_PROMPT, CLOSED_CONTROL_PROMPT, EXECUTOR_CLOSED_CONTROL_PROMPT, EXECUTOR_COMPACT_CONTINUATION_PROMPT } from './provider-base.mjs'
import { STEP_CONTRACT_MARKER } from './luna-step-contracts.mjs'
import { FakeFactorio, gather, planReply, recordingJev } from './task-loop-fixtures.mjs'

// Step contracts bind just in time (docs/NPC_PLANNING_ROADMAP.md, "One-step contract prediction"): a slice commits its step
// intents and the first step's checkpoint, and the planner authors each later step's checkpoint in a side call when that step is
// about to start. Static scenarios: a fake Factorio and scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [{ id: 'node_start', intent: 'iron and copper plates in hand' }]
const STEPS = [
  'Gather 10 iron ore',
  'Place the stone furnace, fuel it, and smelt at least 50 iron plates total',
  'Hand-mine copper ore and smelt at least 20 copper plates',
]
const checkpoint = (item, minimum) => ({ mode: 'all', requirements: [{ id: 'requirement_1', kind: 'inventory_count', item_name: item, minimum }] })
const IRON_ORE = checkpoint('iron-ore', 10)
const IRON_PLATE = checkpoint('iron-plate', 50)
const COPPER_PLATE = checkpoint('copper-plate', 20)
const DECLARED = new Map([[STEPS[0], IRON_ORE], [STEPS[1], IRON_PLATE], [STEPS[2], COPPER_PLATE]])

const LATER_BARE = [{ kind: 'deterministic', checkpoint: IRON_ORE }, { kind: 'deterministic' }, { kind: 'deterministic' }]
const ALL_CHECKPOINTS = [{ kind: 'deterministic', checkpoint: IRON_ORE }, { kind: 'deterministic', checkpoint: IRON_PLATE }, { kind: 'deterministic', checkpoint: COPPER_PLATE }]

function plannerCommit(extra = {}) {
  return planReply({
    plan: STEPS,
    currentStep: 0,
    operations: [gather('iron-ore', 10)],
    stepCompletions: LATER_BARE,
    goal: GOAL,
    roadmap: SHELF,
    ...extra,
  })
}

// The packet is the first user message of the exchange (a correction, if any, follows it).
const packetOf = (call) => {
  const text = String(call.messages.find(message => message.role === 'user' && String(message.content).startsWith(STEP_CONTRACT_MARKER)).content)
  return JSON.parse(text.slice(text.indexOf(' {"goal"') + 1))
}
const contractReply = (call, checkpointValue) => ({ content: JSON.stringify({ stepId: packetOf(call).target.step_id, checkpoint: checkpointValue }) })
// The checkpoint the scenario declared for the step the call is about.
const declaredFor = call => DECLARED.get(packetOf(call).target.description)
const answerDeclared = call => contractReply(call, declaredFor(call))

// The real loop against a fake Factorio. `script` holds the replies of the ordinary planner/executor calls, in order;
// `contracts` holds the replies of the step contract calls (a function of the call, a reply, or an Error to throw).
function harness({ script, contracts = [], agentOptions = {} } = {}) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const contractCalls = []
  const trace = []
  const reserves = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages, context) => {
      if (context?.triggerSource === 'step_contract') {
        const call = { messages: messages.map(message => ({ ...message })), context, order: trace.length }
        contractCalls.push(call)
        const entry = contracts[contractCalls.length - 1] ?? answerDeclared
        const reply = typeof entry === 'function' ? await entry(call, world) : entry
        if (reply instanceof Error) throw reply
        return reply
      }
      calls.push(messages.map(message => ({ ...message })))
      const entry = script[calls.length - 1]
      assert.ok(entry, `unscripted provider call ${calls.length}`)
      const next = typeof entry === 'function' ? entry(world) : entry
      return { ...next }
    },
    reserve: async (request) => { reserves.push(request) },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'step contract test system prompt',
    goalDefinitionPolicy: 'required',
    completionProtocolVersion: 2,
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...agentOptions,
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const world = {
    agent,
    game,
    memory,
    calls,
    contractCalls,
    trace,
    reserves,
    rows: event => trace.filter(record => record.event === event),
    tracker: () => getActivePlan(memory.planningState(KEY)),
    board: () => memory.currentPlan(KEY),
    // The planner commits the slice; the harness runs it to the point where step 1's batch is admitted.
    async commit() {
      return agent.request('get iron and copper plates', { sender: 'TTLouis' })
    },
    // Step 1's checkpoint is met: the harness closes step 1 on the receipt, binds step 2's contract and wakes the executor.
    async closeStepOne() {
      await world.commit()
      game.inventory['iron-ore'] = 10
      return agent.completed()
    },
  }
  return world
}

// The step 2 reply the executor sends once its contract is bound: a batch for step 2, bound by the step id.
const executorStepTwo = world => ({ content: JSON.stringify({ chatMessage: '', stepId: world.tracker().steps[1].step_id, operations: [gather('iron-ore', 50)] }) })

const textOf = message => (typeof message?.content === 'string' ? message.content : '')
const harnessMessagesOf = messages => messages.map(textOf).filter(text => text.startsWith('[HARNESS]'))

// --- draft acceptance ---------------------------------------------------------------------------------------------

test('a draft that sends a checkpoint for every step commits only the first; the rest are deferred, traced once with the reason', async () => {
  const world = harness({ script: [plannerCommit({ stepCompletions: ALL_CHECKPOINTS })] })
  await world.commit()
  assert.deepEqual(world.tracker().steps.map(step => step.contract_status), ['bound', 'pending', 'pending'])
  assert.equal(world.tracker().steps[0].completion_contract.requirements[0].item_name, 'iron-ore')
  assert.equal(world.tracker().steps[1].completion_contract, null, 'a checkpoint sent for a later step is discarded, not committed')
  const rows = world.rows('plan.later_contracts_deferred')
  assert.equal(rows.length, 1, 'traced once per draft although validation runs at several call sites')
  assert.equal(rows[0].data.reason, 'contracts_bound_when_each_step_activates')
  assert.equal(rows[0].data.step_count, 2)
  assert.equal(rows[0].data.discarded_checkpoints, 2)
  assert.ok(rows[0].data.request_id)
  assert.equal(world.contractCalls.length, 0, 'nothing is asked for before the step starts')
})

test('a draft that declares later steps as bare deterministic entries commits the same way, with nothing discarded', async () => {
  const world = harness({ script: [plannerCommit()] })
  await world.commit()
  assert.equal(world.tracker().status, PLAN_STATUS.COMMITTED === world.tracker().status ? PLAN_STATUS.COMMITTED : PLAN_STATUS.EXECUTING)
  assert.deepEqual(world.tracker().steps.map(step => step.contract_status), ['bound', 'pending', 'pending'])
  const [row] = world.rows('plan.later_contracts_deferred')
  assert.equal(row.data.step_count, 2)
  assert.equal(row.data.discarded_checkpoints, 0)
  assert.deepEqual(world.board().task_board.steps.map(step => step.contract_status), ['bound', 'pending', 'pending'])
  assert.equal(world.board().task_board.steps[1].completion_contract, null)
})

test('the step at currentStep must carry its checkpoint: a draft without it is refused with missing_active_step_checkpoint and corrected', async () => {
  const bare = [{ kind: 'deterministic' }, { kind: 'deterministic' }, { kind: 'deterministic' }]
  const world = harness({ script: [plannerCommit({ stepCompletions: bare }), plannerCommit()] })
  await world.commit()
  const [rejected] = world.rows('plan.completion_declarations_rejected')
  assert.equal(rejected.data.reason, 'missing_active_step_checkpoint')
  assert.ok(rejected.data.request_id)
  assert.equal(world.calls.length, 2, 'the planner corrects its draft once')
  assert.match(harnessMessagesOf(world.calls[1]).join('\n'), /missing_active_step_checkpoint/)
  assert.equal(world.tracker().steps[0].contract_status, 'bound')
  assert.equal(world.game.mutations.length, 1, 'only the corrected draft reached the game')
})

test('an assessmentOnly draft is unchanged: semantic steps only, no deferral, no contract call', async () => {
  const semantic = [{ kind: 'semantic', rationale: 'Assess the iron patch from observations.' }, { kind: 'semantic', rationale: 'Assess the copper patch from observations.' }]
  const world = harness({ script: [planReply({ plan: STEPS.slice(0, 2), currentStep: 0, operations: [], assessmentOnly: true, stepCompletions: semantic, goal: GOAL, roadmap: SHELF })] })
  const parsed = world.agent.parsePlanMessage(planReply({ plan: STEPS.slice(0, 2), currentStep: 0, operations: [], assessmentOnly: true, stepCompletions: semantic, goal: GOAL, roadmap: SHELF }))
  assert.deepEqual(parsed.stepCompletions, semantic)
  assert.equal(parsed.laterContractsDeferred, undefined)
  await world.commit()
  assert.equal(world.rows('plan.later_contracts_deferred').length, 0)
  assert.equal(world.rows('plan.completion_declarations_rejected').length, 0)
  assert.equal(world.contractCalls.length, 0)
})

test('stepCompletions before currentStep (a carried prefix) are left as sent and only later entries are deferred', () => {
  const world = harness({ script: [] })
  const reply = planReply({
    plan: STEPS, currentStep: 1, operations: [], goal: GOAL, roadmap: SHELF,
    stepCompletions: [{ kind: 'deterministic', checkpoint: IRON_ORE }, { kind: 'deterministic', checkpoint: IRON_PLATE }, { kind: 'deterministic', checkpoint: COPPER_PLATE }],
  })
  const parsed = world.agent.parsePlanMessage(reply)
  assert.equal(parsed.currentStep, 1)
  assert.deepEqual(parsed.stepCompletions.map(entry => Boolean(entry.checkpoint)), [true, true, false])
  assert.deepEqual(parsed.laterContractsDeferred, { step_count: 1, discarded_checkpoints: 1 })
})

// A saved three-step draft for the restate tests: step 1 carries its checkpoint, the rest are intents.
function draftWorld() {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  let providerCalls = 0
  memory.planByNpc.set(KEY, {
    goal_id: 'goal_draft', owner: 'tester', objective: 'get iron and copper plates', status: 'active', blocker: '', pause_reason: '',
    plan: STEPS, current_step: 0, revision: 1, last_chat_message: '', last_operations: [], durable_last_operations: [], exact_target_audit: [],
    updated_at: Date.now(), history: [],
    task_board: {
      kind: 'task_board_lite', goal_id: 'goal_draft', status: 'active', blocker: '', pause_reason: '', revision: 1, completed_count: 0, total_steps: 3,
      active_index: 0, active_step_id: 'step_1', proposed_focus_index: 0, proposed_focus_step_id: 'step_1',
      steps: STEPS.map((description, index) => ({ id: `step_${index + 1}`, description, status: index === 0 ? 'active' : 'pending' })),
      evidence: [], events: [],
    },
  })
  memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 1, stepCompletions: LATER_BARE })
  const agent = new NpcAgentLoop({ rcon: game, memory, stateFile: null, traceFile: null, decisionTraceFile: null, reserve: async () => ({}), completionProtocolVersion: 2, provider: async () => { providerCalls++; return planReply({ plan: STEPS, currentStep: 0, operations: [] }) } })
  const trace = []
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  agent.active = true
  agent.epoch = { ...game.status }
  agent.requestInfo = { memoryKey: KEY }
  agent.traceRequest = { id: 'req_draft_restate' }
  agent.observationBudgetRemaining = 0
  agent.observationDecisionForced = true
  agent.turnConversation = agent.agentContext.beginRequest(0)
  const context = { generation: agent.generation, attribution: agent.turnConversation, current: game.status, round: 1, recoveryAttempt: 0 }
  const request = (stepCompletions) => {
    const control = agent.controlDecisionState(false)
    return planReply({ plan: control.plan, currentStep: control.currentStep, operations: [], stepCompletions,
      observationRequest: { scope: 'draft', goalId: control.goalId, planId: control.planId, planVersion: control.planVersion,
        draftRevision: control.draftRevision, tool: 'getInventoryItems', args: {}, rationale: 'Check held counts before correcting the draft.' } })
  }
  return { agent, memory, game, trace, context, request, providerCalls: () => providerCalls }
}

test('the draft state restated to the model shows a pending step as {kind:"deterministic"}, and a read-only restate of it is accepted', async () => {
  const world = draftWorld()
  const draft = getActivePlan(world.memory.planningState(KEY))
  assert.equal(draft.status, PLAN_STATUS.DRAFT)
  assert.deepEqual(draft.steps.map(step => step.contract_status), ['bound', 'pending', 'pending'])
  const state = world.agent.controlDecisionState(false)
  assert.equal(state.phase, 'draft')
  assert.deepEqual(state.stepCompletions, [{ kind: 'deterministic', checkpoint: draft.steps[0].completion_contract }, { kind: 'deterministic' }, { kind: 'deterministic' }])
  // Restating exactly that is a read, not an edit.
  const accepted = await world.agent.handleObservationRequest(world.request(state.stepCompletions), world.context)
  assert.equal(accepted?._sglunaObservationRefusal, undefined)
  assert.equal(world.providerCalls(), 1, 'the read went through and the model was asked to continue from it')
})

test('a read that smuggles a checkpoint into a pending step is an edit and is refused', async () => {
  const world = draftWorld()
  const state = world.agent.controlDecisionState(false)
  const smuggled = state.stepCompletions.map((entry, index) => (index === 1 ? { kind: 'deterministic', checkpoint: IRON_PLATE } : entry))
  const refused = await world.agent.handleObservationRequest(world.request(smuggled), world.context)
  assert.equal(refused._sglunaObservationRefusal.reason, 'read_cannot_edit_or_complete_plan')
  assert.equal(world.providerCalls(), 0)
})

test('a semantic completion claim on a pending step is refused with semantic_completion_contract_pending', async () => {
  const world = harness({ script: [plannerCommit()], contracts: [new Error('provider down')] })
  await world.commit()
  // Close step 1 on the reducer directly so step 2 is active and still unbound.
  world.memory.recordBoardEvidence(KEY, { kind: 'deterministic_verification', ref: 'proof_1', summary: 'iron ore gathered' })
  world.memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'step_1_verified', metadata: { scope: 'step' },
    evidence: [{ kind: 'deterministic_verification', ref: 'proof_1', summary: 'iron ore gathered' }],
  })
  assert.equal(world.tracker().steps[1].contract_status, 'pending')
  const state = world.board()
  const claim = { stepId: world.tracker().steps[1].step_id, rationale: 'looks done' }
  assert.throws(() => world.agent.semanticCompletionClaimCheck(claim, state), error => error.code === 'semantic_completion_contract_pending')
  const [row] = world.rows('step.semantic_completion_refused')
  assert.equal(row.data.reason, 'semantic_completion_contract_pending')
  assert.ok(row.data.request_id)
})

test('prompt load: the shared and executor prompts carry the step-contract wording and the executor variants name no draft fields', () => {
  assert.match(COMPACT_CONTINUATION_PROMPT, /the currentStep entry is \{kind:"deterministic",checkpoint:\{mode,requirements\}\} and later entries are \{kind:"deterministic"\}/)
  assert.match(CLOSED_CONTROL_PROMPT, /at currentStep and \{kind:"deterministic"\} for each later step/)
  assert.match(COMPACT_CONTINUATION_PROMPT, /\nEvery step of a new execution draft is deterministic\./)
  for (const prompt of [EXECUTOR_COMPACT_CONTINUATION_PROMPT, EXECUTOR_CLOSED_CONTROL_PROMPT]) {
    assert.doesNotMatch(prompt, /stepCompletions|currentStep|later entries/)
  }
  const world = harness({ script: [] })
  const system = world.agent.rolePrefixMessages(PLANNER_ROLE)[0].content
  assert.match(system, /for the step at currentStep of an execution plan and \{kind:"deterministic"\} with no checkpoint for each later step, whose checkpoint the harness asks you for when that step is about to start;/)
  assert.match(system, /a deterministic checkpoint for the first step and \{kind:"deterministic"\} for each later step, whose checkpoint the harness requests when that step is about to start\./)
  assert.doesNotMatch(world.agent.rolePrefixMessages(EXECUTOR_ROLE)[0].content, /stepCompletions aligned with every step, with a deterministic checkpoint for every step/)
})

// --- the step contract call --------------------------------------------------------------------------------------------

// Step 1 is verified on the reducer without going through the loop, which leaves step 2 active and unbound: the state a
// restart between the close and the bind leaves behind, and the state the call is made from.
function closeStepOneOnTheReducer(world) {
  const proof = { kind: 'deterministic_verification', ref: 'proof_1', summary: 'iron ore gathered' }
  world.memory.recordBoardEvidence(KEY, proof)
  const closed = world.memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'step_1_verified', metadata: { scope: 'step' }, evidence: [proof],
  })
  assert.equal(closed.decision.accepted, true)
  assert.equal(world.tracker().steps[1].contract_status, 'pending')
}

const snapshotConversations = agent => JSON.stringify({
  messages: agent.messages,
  base: agent.baseMessages,
  parked: agent.agentContext.parkedPlanner,
  counters: agent.agentContext.counters,
  size: agent.agentContext.size,
  highWater: agent.agentContext.requestCharsHighWater,
  conversationSeq: agent.agentContext.conversationSeq,
  lineage: agent.agentContext.lineageSequence,
  handoffId: agent.agentContext.handoffId,
  restages: agent.agentContext.restageCount,
})

test('the call is a planner-prefix side exchange: one user packet, no tools, and neither conversation nor any counter of it moves', async () => {
  const world = harness({ script: [plannerCommit()] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const before = snapshotConversations(world.agent)
  const generation = world.agent.generation
  const reservesBefore = world.reserves.length

  const ensured = await world.agent.ensureActiveStepContract({ trigger: 'test' })

  assert.equal(ensured.ok, true)
  assert.equal(ensured.bound, true)
  assert.equal(snapshotConversations(world.agent), before, 'planner and executor conversations are exactly as they were')
  assert.equal(world.agent.providerCallsByGeneration.size, 0, 'the call is not a provider round of the loop, so a restage is never refused for it')
  assert.equal(world.agent.generation, generation)
  assert.equal(world.contractCalls.length, 1)
  const [call] = world.contractCalls
  assert.equal(call.context.role, PLANNER_ROLE)
  assert.equal(call.context.allowTools, false)
  assert.equal(call.context.triggerSource, 'step_contract')
  assert.equal(call.context.round, 0)
  assert.equal(call.context.recoveryAttempt, 0)
  assert.equal(call.context.interactionRouter, undefined, 'the prompt cache breakpoints still apply')
  assert.deepEqual(call.context.requestBodyPatch, { max_tokens: 6000, response_format: { type: 'json_object' } })
  assert.equal(call.context.epoch, world.game.status.epoch)
  assert.equal(call.context.actorId, world.game.status.actor_id)
  assert.ok(call.context.requestId)
  assert.equal(call.messages.length, 2)
  assert.deepEqual(call.messages[0], world.agent.rolePrefixMessages(PLANNER_ROLE)[0], 'the planner system prefix, byte for byte')
  assert.equal(call.messages[1].role, 'user')
  assert.ok(call.messages[1].content.startsWith(`${STEP_CONTRACT_MARKER} `))
  const packet = packetOf(call)
  assert.equal(packet.target.step_id, world.tracker().steps[1].step_id)
  assert.equal(packet.target.description, STEPS[1])
  assert.deepEqual(packet.slice.steps.map(step => [step.status, step.contract]), [['completed', 'bound'], ['active', 'pending'], ['pending', 'pending']])
  assert.equal(packet.verified_results.length, 1)
  assert.equal(world.reserves.length, reservesBefore + 1, 'the call reserved provider budget like any other call')
  assert.deepEqual(world.reserves.at(-1), { epoch: world.game.status.epoch, actorId: world.game.status.actor_id })
})

test('the bound contract is on the reducer and the board before anything acts, with its binding recorded and traced with the request id', async () => {
  const world = harness({ script: [plannerCommit()] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  await world.agent.ensureActiveStepContract({ trigger: 'test', closedStepId: 'step_1', closedBy: 'test' })

  const step = world.tracker().steps[1]
  assert.equal(step.contract_status, 'bound')
  assert.equal(step.completion_contract.requirements[0].item_name, 'iron-plate')
  assert.equal(step.contract_binding.binding, 'just_in_time')
  assert.equal(world.board().task_board.steps[1].completion_contract.requirements[0].item_name, 'iron-plate', 'every close path reads the board contract')
  const requested = world.rows('plan.contract_requested')
  const bound = world.rows('plan.contract_bound_just_in_time')
  assert.equal(requested.length, 1)
  assert.equal(bound.length, 1)
  assert.equal(requested[0].data.request_id, bound[0].data.request_id)
  assert.equal(step.contract_binding.request_id, bound[0].data.request_id)
  assert.equal(bound[0].data.plan_id, world.tracker().plan_id)
  assert.equal(bound[0].data.step_id, step.step_id)
  assert.equal(bound[0].data.attempts, 1)
  assert.equal(bound[0].data.reason, 'step_activated_without_contract')
  assert.equal(requested[0].data.trigger, 'test')
  assert.equal(world.rows('plan.contract_call_failed').length, 0)
  // Nothing is asked twice: the step is bound now.
  assert.deepEqual(await world.agent.ensureActiveStepContract({ trigger: 'test' }), { ok: true, skipped: true })
  assert.equal(world.contractCalls.length, 1)
})

test('closing a step on its receipt binds the next contract before the executor acts, and the executor sees it in its planning state', async () => {
  const world = harness({ script: [plannerCommit(), executorStepTwo] })
  await world.closeStepOne()

  assert.equal(world.contractCalls.length, 1)
  assert.equal(world.calls.length, 2, 'the planner and the executor; the contract call is not one of the loop rounds')
  const trace = world.trace
  const boundAt = trace.findIndex(row => row.event === 'plan.contract_bound_just_in_time')
  const verifiedAt = trace.findIndex(row => row.event === 'step.verified')
  const executorRequestAt = trace.findIndex((row, index) => index > boundAt && row.event === 'provider.request')
  assert.ok(verifiedAt > boundAt, 'bound before the close is credited and traced')
  assert.ok(executorRequestAt > boundAt, 'bound before the executor round is requested')
  assert.equal(world.contractCalls[0].order <= boundAt, true)
  const step = world.tracker().steps[1]
  assert.equal(step.contract_status, 'bound')
  const executorText = world.calls[1].map(textOf).join('\n')
  assert.match(executorText, /\[PLANNING_STATE\]/)
  assert.match(executorText, /"contract_status":"bound"/)
  assert.match(executorText, /"item_name":"iron-plate"/)
  assert.equal(world.game.mutations.length, 2, 'the bound executor batch for step 2 was admitted')
  // A fresh executor restage would carry the bound contract as the active step contract.
  const packet = world.agent.buildRestagePacket({ checkpoint: 'C5', role: EXECUTOR_ROLE, reason: 'test', planningState: world.memory.planningState(KEY) })
  assert.match(JSON.stringify(packet), /active_step_contract: all: inventory_count iron-plate>=50/)
})

test('a reply with a trailing comma is repaired deterministically and binds', async () => {
  const withComma = call => ({ content: `${answerDeclared(call).content.slice(0, -1)},}` })
  const world = harness({ script: [plannerCommit()], contracts: [withComma] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const ensured = await world.agent.ensureActiveStepContract({ trigger: 'test' })
  assert.equal(ensured.bound, true)
  assert.equal(world.contractCalls.length, 1, 'no second ask for a syntax slip')
  assert.equal(world.rows('plan.contract_bound_just_in_time')[0].data.attempts, 1)
})

test('an invalid reply gets one bounded correction inside the side exchange and then binds', async () => {
  const unsupported = call => contractReply(call, { mode: 'all', requirements: [{ kind: 'invented_kind' }] })
  const world = harness({ script: [plannerCommit()], contracts: [unsupported, answerDeclared] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const before = snapshotConversations(world.agent)
  const ensured = await world.agent.ensureActiveStepContract({ trigger: 'test' })

  assert.equal(ensured.bound, true)
  assert.equal(world.contractCalls.length, 2)
  const correction = world.contractCalls[1].messages
  assert.equal(correction.length, 4, 'prefix, packet, the rejected reply and the correction')
  assert.equal(correction[2].role, 'assistant')
  assert.match(correction[3].content, /^\[HARNESS\] checkpoint_not_supported:.*; nothing was bound\.$/)
  assert.equal(world.rows('plan.contract_bound_just_in_time')[0].data.attempts, 2)
  assert.deepEqual(world.rows('plan.contract_call_attempt').map(row => row.data.outcome), ['rejected', 'accepted'])
  assert.equal(snapshotConversations(world.agent), before, 'the correction never enters the planner or executor conversation')
  assert.equal(world.reserves.length >= 3, true)
})

test('two invalid replies pause the goal as step_contract_unavailable, after the close was recorded, and say so', async () => {
  const unsupported = call => contractReply(call, { mode: 'all', requirements: [{ kind: 'invented_kind' }] })
  const world = harness({ script: [plannerCommit()], contracts: [unsupported, unsupported] })
  const result = await world.closeStepOne()

  assert.equal(world.contractCalls.length, 2, 'one ask and one bounded correction')
  assert.equal(result.goalStatus, 'paused')
  assert.match(result.chatMessage, /I paused this goal: I could not get a valid completion checkpoint for the next step/)
  assert.match(result.chatMessage, /Press Resume or say continue/)
  assert.equal(world.board().status, 'paused')
  assert.equal(world.board().pause_reason, 'step_contract_unavailable')
  assert.equal(world.tracker().execution.step_progress[world.tracker().steps[0].step_id].status, 'completed', 'the verified close stands')
  assert.equal(world.tracker().steps[1].contract_status, 'pending', 'nothing was bound')
  const [failed] = world.rows('plan.contract_call_failed')
  assert.equal(failed.data.attempts, 2)
  assert.match(failed.data.reason, /checkpoint_not_supported/)
  assert.ok(failed.data.request_id)
  assert.equal(failed.data.step_id, world.tracker().steps[1].step_id)
  assert.equal(world.rows('plan.contract_bound_just_in_time').length, 0)
  assert.equal(world.rows('step.verified').length, 1)
  assert.equal(world.calls.length, 1, 'no executor round for an unbound step')
})

test('a provider error on the contract call pauses the goal the same way', async () => {
  const world = harness({ script: [plannerCommit()], contracts: [new Error('upstream 503')] })
  const result = await world.closeStepOne()
  assert.equal(result.goalStatus, 'paused')
  assert.equal(world.board().pause_reason, 'step_contract_unavailable')
  assert.equal(world.contractCalls.length, 1, 'a transport failure is not retried inside the call')
  assert.match(world.rows('plan.contract_call_failed')[0].data.reason, /provider_error: upstream 503/)
  assert.equal(world.tracker().steps[1].contract_status, 'pending')
})

test('an actor epoch that changes while the call is out binds nothing and fails as a stale turn', async () => {
  const replacedMidCall = async (call, world) => {
    world.game.status = { ...world.game.status, epoch: world.game.status.epoch + 1 }
    return answerDeclared(call)
  }
  const world = harness({ script: [plannerCommit()], contracts: [replacedMidCall] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  await assert.rejects(world.agent.ensureActiveStepContract({ trigger: 'test' }), error => error.code === STALE_REPLY_ERROR_CODE)
  assert.equal(world.tracker().steps[1].contract_status, 'pending')
  assert.equal(world.board().task_board.steps[1].completion_contract, null)
  assert.equal(world.rows('plan.contract_bound_just_in_time').length, 0)
  const [failed] = world.rows('plan.contract_call_failed')
  assert.equal(failed.data.reason, 'stale_actor_or_epoch_changed')
  assert.ok(failed.data.request_id)
})

test('a loop that was reset while the call was out binds nothing either', async () => {
  const resetMidCall = async (call, world) => {
    world.agent.reset()
    return answerDeclared(call)
  }
  const world = harness({ script: [plannerCommit()], contracts: [resetMidCall] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  await assert.rejects(world.agent.ensureActiveStepContract({ trigger: 'test' }))
  assert.equal(world.tracker().steps[1].contract_status, 'pending')
  assert.equal(world.rows('plan.contract_call_failed')[0].data.reason, 'stale_superseded')
})

test('the call is charged to the request: reserve, call count and output units, and never to the generation output cap', async () => {
  const withUsage = (call) => {
    const reply = answerDeclared(call)
    Object.defineProperty(reply, '_sglunaProvider', { value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 900, completion_tokens: 37, total_tokens: 937 } } })
    return reply
  }
  const world = harness({ script: [plannerCommit()], contracts: [withUsage] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const usage = world.agent.traceRequest.usage
  const callsBefore = usage.provider_calls
  const outputBefore = usage.output_units
  const generationBefore = world.agent.providerBudgetGenerationOutputUnits
  const reservesBefore = world.reserves.length

  await world.agent.ensureActiveStepContract({ trigger: 'test' })

  assert.equal(usage.provider_calls, callsBefore + 1)
  assert.equal(usage.output_units, outputBefore + 37)
  assert.equal(usage.input_units >= 900, true)
  assert.equal(world.agent.providerBudgetGenerationOutputUnits, generationBefore, 'the planner generation output cap is untouched')
  assert.equal(world.reserves.length, reservesBefore + 1)
})

test('a pending step in the executor round is bound by the admission backstop: a restart between the close and the bind loses nothing', async () => {
  const world = harness({ script: [plannerCommit(), executorStepTwo] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  assert.equal(world.contractCalls.length, 0, 'the close happened without the bind, as after a restart')
  const reply = { content: JSON.stringify({ chatMessage: '', stepId: world.tracker().steps[1].step_id, operations: [gather('iron-ore', 50)] }) }
  const plan = world.agent.parsePlanMessage(reply)

  await world.agent.commitPlan(plan)

  assert.equal(world.contractCalls.length, 1)
  assert.equal(world.rows('plan.contract_requested')[0].data.trigger, 'admission_backstop')
  assert.equal(world.rows('plan.contract_bound_just_in_time')[0].data.trigger, 'admission_backstop')
  assert.equal(world.tracker().steps[1].contract_status, 'bound')
  const refusal = world.rows('admission.step_contract_pending_refused')
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0].data.reason, 'step_contract_pending')
  assert.ok(refusal[0].data.request_id)
  assert.equal(world.calls.length, 2, 'the model is asked again for the step once its contract is bound')
  const fact = harnessMessagesOf(world.agent.messages).find(text => text.includes('had no completion checkpoint yet'))
  assert.match(fact ?? '', /The harness has now bound its checkpoint: .*iron-plate.*Send the operations for this step again/)
  assert.equal(world.game.mutations.length, 2, 'the resent batch, now under its contract, was admitted')
})

test('a plan that has no committed contract and cannot get one is never admitted: the backstop failure pauses', async () => {
  const world = harness({ script: [plannerCommit(), executorStepTwo], contracts: [new Error('upstream 503')] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const plan = world.agent.parsePlanMessage({ content: JSON.stringify({ chatMessage: '', stepId: world.tracker().steps[1].step_id, operations: [gather('iron-ore', 50)] }) })
  const result = await world.agent.commitPlan(plan)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(world.board().pause_reason, 'step_contract_unavailable')
  assert.equal(world.game.mutations.length, 1, 'nothing was admitted for the unbound step')
})

test('closing the final step asks for nothing', async () => {
  const world = harness({ script: [plannerCommit({ plan: STEPS.slice(0, 1), stepCompletions: [{ kind: 'deterministic', checkpoint: IRON_ORE }] })] })
  await world.commit()
  world.memory.recordBoardEvidence(KEY, { kind: 'deterministic_verification', ref: 'proof_1', summary: 'iron ore gathered' })
  world.memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete', source: 'deterministic_runtime', reason_code: 'step_1_verified', metadata: { scope: 'step' },
    evidence: [{ kind: 'deterministic_verification', ref: 'proof_1', summary: 'iron ore gathered' }],
  })
  assert.equal(world.tracker().status, PLAN_STATUS.COMPLETED)
  assert.deepEqual(await world.agent.ensureActiveStepContract({ trigger: 'test' }), { ok: true, skipped: true })
  assert.equal(world.contractCalls.length, 0)
  assert.equal(world.rows('plan.contract_requested').length, 0)
})

test('trial C replay: step 2 is authored at activation from the fresh count (130 ore held), not the stale count from commit', async () => {
  // At commit the player held nothing, so a contract written then would say "100 iron ore". When step 2 starts the actor holds 130.
  const world = harness({
    script: [plannerCommit({ plan: ['Gather 10 iron ore', 'Mine 100 more iron ore'], stepCompletions: [{ kind: 'deterministic', checkpoint: IRON_ORE }, { kind: 'deterministic', checkpoint: checkpoint('iron-ore', 100) }] }),
      w => ({ content: JSON.stringify({ chatMessage: '', stepId: w.tracker().steps[1].step_id, operations: [gather('iron-ore', 100)] }) })],
    contracts: [call => contractReply(call, checkpoint('iron-ore', packetOf(call).facts.inventory['iron-ore'] + 100))],
  })
  await world.commit()
  assert.equal(world.tracker().steps[1].completion_contract, null, 'the commit-time "100" was never committed')
  world.game.inventory['iron-ore'] = 130
  await world.agent.completed()

  assert.equal(world.contractCalls.length, 1)
  assert.equal(packetOf(world.contractCalls[0]).facts.inventory['iron-ore'], 130, 'the packet carries the count read at activation')
  const bound = world.tracker().steps[1].completion_contract.requirements[0]
  assert.equal(bound.minimum, 230, 'the contract asks for 100 MORE ore on top of what is held now')
  assert.equal(world.board().task_board.steps[1].completion_contract.requirements[0].minimum, 230)
  assert.equal(world.rows('plan.contract_bound_just_in_time').length, 1)
})

// --- what a pending step does and does not allow ---------------------------------------------------------------------

test('a finished batch cannot close a pending step, and the step-stays-open hint is not shown for it', async () => {
  const world = harness({ script: [plannerCommit()] })
  await world.commit()
  closeStepOneOnTheReducer(world)
  const decision = await world.agent.routeStepCompletionDecision({ view: {}, providerStatus: {} })
  assert.equal(decision.verified, false)
  assert.equal(decision.reason, 'step_contract_pending')
  assert.equal(world.rows('step.close_declined').at(-1).data.reason, 'step_contract_pending')
  assert.equal(world.agent.stepStaysOpenHint(world.board()), '', 'the prose-step hint would tell the model to add a checkpoint or claim semantic completion')
})

test('a fresh-read close that cannot bind the next contract still records the close and returns the pause to its caller', async () => {
  const world = harness({ script: [plannerCommit()], contracts: [new Error('upstream 503')] })
  await world.commit()
  world.game.inventory['iron-ore'] = 10
  world.agent.batchInFlight = false
  world.memory.clearPendingOperation?.(KEY)
  const closed = await world.agent.closeActiveStepOnFreshRead({ previousState: world.board(), trigger: 'checkpoint_met_before_batch' })
  assert.equal(closed.closed, true)
  assert.equal(closed.contractPause.goalStatus, 'paused')
  assert.equal(world.board().pause_reason, 'step_contract_unavailable')
  assert.equal(world.tracker().execution.step_progress[world.tracker().steps[0].step_id].status, 'completed')
  assert.equal(world.rows('plan.step_closed_on_fresh_read').length, 1)
  assert.equal(world.rows('plan.contract_call_failed').length, 1)
})

test('a fresh-read close binds the next contract before it returns', async () => {
  const world = harness({ script: [plannerCommit()] })
  await world.commit()
  world.game.inventory['iron-ore'] = 10
  world.agent.batchInFlight = false
  world.memory.clearPendingOperation?.(KEY)
  const closed = await world.agent.closeActiveStepOnFreshRead({ previousState: world.board(), trigger: 'checkpoint_met_before_batch' })
  assert.equal(closed.closed, true)
  assert.equal(closed.contractPause, undefined)
  assert.equal(world.tracker().steps[1].contract_status, 'bound')
  assert.equal(closed.state.task_board.steps[1].completion_contract.requirements[0].item_name, 'iron-plate', 'the state it hands back already carries the bound contract')
  assert.equal(world.rows('plan.contract_requested')[0].data.trigger, 'step_close')
})
