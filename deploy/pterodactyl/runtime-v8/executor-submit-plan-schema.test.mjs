import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { roleSystemPrompt } from './agent-roles.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  CLOSED_CONTROL_PROMPT,
  COMPACT_CONTINUATION_PROMPT,
  EXECUTOR_CLOSED_CONTROL_PROMPT,
  EXECUTOR_COMPACT_CONTINUATION_PROMPT,
} from './provider-base.mjs'
import { normalizeProviderPlanContentDetailed, providerRequest } from './provider.mjs'
import {
  EXECUTOR_CONTROL_FIELDS,
  EXECUTOR_CONTROL_REQUIRED,
  executorControlToolDefinitions,
  executorProviderToolDefinitions,
  plannerControlPayloadFromMessage,
  plannerControlToolDefinitions,
  providerToolDefinitions,
} from './structured-policy.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

// The executor's own submitPlan schema (Haiku live run 2026-10-08: the executor sent stepId in 11 replies and fell back to
// plan/currentStep in 9, because the single submitPlan schema required plan/currentStep and the shared prompt text
// showed them). The planner keeps its schema byte for byte; the executor requires stepId and operations. The harness
// stays tolerant of replies that still carry plan/currentStep.
// Static scenarios: a fake Factorio and scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const config = { base: 'http://proxy.example-tailnet.ts.net:18317/v1', key: 'fixture-key', model: 'executor-fixture', profile: 'local' }
const submitPlanOf = tools => tools.find(tool => tool.function.name === 'submitPlan')
const control = (args, content = '') => ({ content, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(args) } }] })
const OPERATIONS = [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 20, search_radius: 256 } }]

test('the executor submitPlan requires stepId and operations, carries no plan or currentStep, and keeps the tool name', () => {
  const [executor] = executorControlToolDefinitions
  const [planner] = plannerControlToolDefinitions
  assert.equal(executor.function.name, 'submitPlan')
  assert.equal(executor.function.name, planner.function.name)
  assert.deepEqual(executor.function.parameters.required, ['stepId', 'operations'])
  assert.deepEqual(EXECUTOR_CONTROL_REQUIRED, ['stepId', 'operations'])
  assert.equal(executor.function.parameters.additionalProperties, false)
  const advertised = Object.keys(executor.function.parameters.properties)
  assert.deepEqual([...advertised].sort(), [...EXECUTOR_CONTROL_FIELDS].sort())
  for (const absent of ['plan', 'currentStep', 'goal', 'roadmap', 'roadmapNodeIds', 'developmentMode', 'assessmentOnly', 'stepCompletions']) {
    assert.equal(advertised.includes(absent), false, `the executor schema must not advertise ${absent}`)
  }
  // What the executor does use is the planner's own definition of it.
  for (const field of advertised) assert.deepEqual(executor.function.parameters.properties[field], planner.function.parameters.properties[field], field)
  assert.deepEqual(executor.function.parameters.properties.operations, planner.function.parameters.properties.operations)
})

test('the planner submitPlan definition is unchanged and still the one in the shared tool list', () => {
  const planner = submitPlanOf(providerToolDefinitions)
  assert.equal(planner, plannerControlToolDefinitions[0])
  assert.deepEqual(planner.function.parameters.required, ['plan', 'currentStep', 'operations'])
  assert.deepEqual(Object.keys(planner.function.parameters.properties).sort(), ['assessmentOnly', 'chatMessage', 'checkpoint', 'currentStep', 'developmentMode', 'goal', 'observationRequest', 'operations', 'plan', 'roadmap', 'roadmapNodeIds', 'semanticCompletion', 'stepCompletions', 'stepId', 'timeReview'])
  // The executor list is the same observation tools plus its own control tool; nothing else differs.
  const plannerNames = providerToolDefinitions.map(tool => tool.function.name)
  const executorNames = executorProviderToolDefinitions.map(tool => tool.function.name)
  assert.deepEqual(executorNames, plannerNames)
  assert.equal(executorProviderToolDefinitions.filter(tool => tool.function.name === 'submitPlan').length, 1)
  assert.notEqual(submitPlanOf(executorProviderToolDefinitions), planner)
})

test('every field the executor schema advertises is accepted by the parser, and the bare stepId reply binds with the legacy-shaped plan fields', () => {
  const sample = {
    chatMessage: 'x',
    stepId: 'step_3',
    observationRequest: { stepId: 'step_3', tool: 'getInventoryItems', args: {}, rationale: 'Need current inventory.' },
    operations: OPERATIONS,
    checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 20 }] },
    semanticCompletion: { stepId: 'step_3', rationale: 'The completed receipt grounds this.' },
    timeReview: { decision: 'keep_serial', reason: 'x' },
  }
  for (const field of EXECUTOR_CONTROL_FIELDS) {
    assert.ok(Object.hasOwn(sample, field), `no sample for advertised field ${field}`)
    assert.doesNotThrow(() => plannerControlPayloadFromMessage(control({ stepId: 'step_3', operations: [], [field]: sample[field] })), field)
  }
  const bare = plannerControlPayloadFromMessage(control({ stepId: 'step_3', operations: OPERATIONS }))
  assert.deepEqual({ plan: bare.plan, currentStep: bare.currentStep, stepId: bare.stepId, operations: bare.operations }, { plan: [], currentStep: 0, stepId: 'step_3', operations: OPERATIONS })
  // The schema's two required fields are all a reply needs, including a zero-operation completion claim.
  const claim = plannerControlPayloadFromMessage(control({ stepId: 'step_3', operations: [], semanticCompletion: sample.semanticCompletion }))
  assert.deepEqual({ plan: claim.plan, currentStep: claim.currentStep, operations: claim.operations, semanticCompletion: claim.semanticCompletion }, { plan: [], currentStep: 0, operations: [], semanticCompletion: sample.semanticCompletion })
})

test('the legacy plan/currentStep shape still parses for a reply of either role', () => {
  const legacy = plannerControlPayloadFromMessage(control({ chatMessage: '', plan: ['a', 'b'], currentStep: 1, operations: OPERATIONS }))
  assert.deepEqual({ plan: legacy.plan, currentStep: legacy.currentStep, stepId: legacy.stepId }, { plan: ['a', 'b'], currentStep: 1, stepId: undefined })
  const both = plannerControlPayloadFromMessage(control({ plan: ['a'], currentStep: 0, operations: [], stepId: 'step_1' }))
  assert.deepEqual({ plan: both.plan, currentStep: both.currentStep, stepId: both.stepId }, { plan: ['a'], currentStep: 0, stepId: 'step_1' })
})

const messages = [
  { role: 'system', content: roleSystemPrompt('You are SGLuna.', 'executor') },
  { role: 'user', content: '[HANDOFF] One committed gathering step.' },
  { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {"last_completed_batch":{"batch_id":1},"basic_operation":{"last_result":{"code":"completed"}}}' },
  { role: 'user', content: '[HARNESS] Decide on the committed step from its completed receipt.' },
]
// A batch-completion continuation: the completed receipt is the last user message, so the round is compact.
const compactMessages = messages.slice(0, 3)
const echo = captured => async (_url, options) => {
  captured.push(JSON.parse(options.body))
  return new Response(JSON.stringify({ id: 'fixture', model: config.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }))
}

async function withTrace(run) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-executor-schema-'))
  try {
    const traceFile = path.join(dir, 'prompts.jsonl')
    await run(traceFile)
    return (await fsp.readFile(traceFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  }
  finally { await fsp.rm(dir, { recursive: true, force: true }) }
}

test('provider request: the executor round sends the executor schema, the planner round sends the planner schema, and the executor round is traced with its request id and reason', async () => {
  const executorBodies = []
  const plannerBodies = []
  const executorTrace = await withTrace(async (traceFile) => {
    await providerRequest(config, compactMessages, { allowTools: true, role: 'executor', triggerSource: 'failure', fetchImpl: echo(executorBodies), promptTraceFile: traceFile, requestId: 'req_executor_schema' })
  })
  const plannerTrace = await withTrace(async (traceFile) => {
    await providerRequest(config, compactMessages, { allowTools: true, role: 'planner', triggerSource: 'failure', fetchImpl: echo(plannerBodies), promptTraceFile: traceFile, requestId: 'req_planner_schema' })
  })
  const unnamed = []
  await providerRequest(config, compactMessages, { allowTools: true, triggerSource: 'failure', fetchImpl: echo(unnamed), promptTraceFile: null })

  const executorSchema = submitPlanOf(executorBodies[0].tools).function.parameters
  assert.deepEqual(executorSchema.required, ['stepId', 'operations'])
  assert.equal('plan' in executorSchema.properties || 'currentStep' in executorSchema.properties, false)
  for (const body of [plannerBodies[0], unnamed[0]]) {
    assert.deepEqual(submitPlanOf(body.tools).function.parameters.required, ['plan', 'currentStep', 'operations'])
  }
  assert.deepEqual(plannerBodies[0].tools, unnamed[0].tools, 'a named planner round is the unnamed (pre-roles) request')
  assert.equal(executorBodies[0].tools.length, plannerBodies[0].tools.length)

  const [contract] = executorTrace.filter(row => row.event === 'provider.executor_control_contract')
  assert.equal(contract.request_id, 'req_executor_schema')
  assert.equal(contract.reason, 'executor_submit_plan_requires_step_id')
  assert.equal(contract.role, 'executor')
  assert.deepEqual(contract.submit_plan_required, ['stepId', 'operations'])
  assert.equal(contract.prompt_variant, 'executor_compact_continuation')
  assert.equal(plannerTrace.some(row => row.event === 'provider.executor_control_contract'), false)
})

test('provider request: the executor-facing prompts no longer carry the plan/currentStep answer shape or example; the planner prompts are untouched', async () => {
  // Compact continuation (a completed batch): the shared answer-shape sentences.
  const compact = []
  await providerRequest(config, compactMessages, { allowTools: true, role: 'executor', triggerSource: 'failure', fetchImpl: echo(compact), promptTraceFile: null })
  assert.equal(compact[0].messages[0].content.startsWith(EXECUTOR_COMPACT_CONTINUATION_PROMPT), true)
  assert.doesNotMatch(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /currentStep/)
  assert.doesNotMatch(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /\{plan:\["observable step"\]/)
  assert.match(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /Answer with one submitPlan call when tool calls are enabled: \{stepId,operations:\[\{name,args\}\]\} plus the applicable completion fields, where stepId is the active step id from \[CONTROL_DECISION_STATE\]\./)
  assert.match(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /If the whole goal is verified complete, return operations:\[\] and a short completion chatMessage\./)

  // Closed control (tools off): the JSON-object contract and its example shape.
  const closed = []
  await providerRequest(config, messages, { allowTools: false, role: 'executor', triggerSource: 'failure', fetchImpl: echo(closed), promptTraceFile: null })
  const closedText = closed[0].messages.map(message => message.content).join('\n')
  assert.ok(closedText.includes(EXECUTOR_CLOSED_CONTROL_PROMPT))
  assert.equal(closedText.includes(CLOSED_CONTROL_PROMPT), false)
  assert.doesNotMatch(EXECUTOR_CLOSED_CONTROL_PROMPT, /currentStep/)
  assert.doesNotMatch(EXECUTOR_CLOSED_CONTROL_PROMPT, /"plan":\["<committed step>"\]/)
  assert.ok(EXECUTOR_CLOSED_CONTROL_PROMPT.includes('Example shape (replace placeholders): {"chatMessage":"","stepId":"<exact active step id>","operations":[],"semanticCompletion":{"stepId":"<exact active step id>","rationale":"<grounded judgment>"}}.'))
  assert.match(EXECUTOR_CLOSED_CONTROL_PROMPT, /operations:\[\] is valid/)

  // The planner keeps the shared text.
  const planner = []
  await providerRequest(config, compactMessages, { allowTools: true, role: 'planner', triggerSource: 'failure', fetchImpl: echo(planner), promptTraceFile: null })
  assert.equal(planner[0].messages[0].content.startsWith(COMPACT_CONTINUATION_PROMPT), true)
  assert.match(COMPACT_CONTINUATION_PROMPT, /\{plan:\["observable step"\],currentStep,operations:\[\{name,args\}\]\}/)
  assert.match(CLOSED_CONTROL_PROMPT, /"plan":\["<committed step>"\],"currentStep":0/)
  const plannerClosed = []
  await providerRequest(config, messages, { allowTools: false, role: 'planner', triggerSource: 'failure', fetchImpl: echo(plannerClosed), promptTraceFile: null })
  assert.ok(plannerClosed[0].messages.map(message => message.content).join('\n').includes(CLOSED_CONTROL_PROMPT))
})

// --- the loop: an executor on the new schema --------------------------------------------------------------

const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [{ id: 'node_power', intent: 'steam power running' }, { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] }]
const FINITE_GOAL = { scope: 'finite', summary: 'Have 5 iron plates.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 5 }] }
const TWO_STEPS = ['Gather 10 iron ore', 'Gather 10 copper ore']

function harness(script, { inventory } = {}) {
  const game = new FakeFactorio({ inventory })
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [] }
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (providerMessages, context) => {
      world.calls.push({ messages: providerMessages.map(message => ({ ...message })), context })
      const reply = script[world.calls.length - 1]
      assert.ok(reply, `unscripted provider call ${world.calls.length}`)
      return typeof reply === 'function' ? reply(world) : { ...reply }
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'executor submit plan schema test system prompt',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  world.agent.behaviorTrace = { emit: async (record) => { world.trace.push(record) } }
  world.rows = event => world.trace.filter(record => record.event === event)
  world.stepId = () => memory.currentPlan(KEY)?.task_board?.active_step_id
  world.say = text => world.agent.request(text, { sender: 'TTLouis' })
  return world
}

// The executor's reply on the new schema: no plan, no currentStep.
const stepReply = (world, extra) => ({ content: JSON.stringify({ chatMessage: '', stepId: world.stepId(), operations: [gather('copper-ore', 10)], ...extra }) })
const claimReply = (world, extra) => ({ content: JSON.stringify({ chatMessage: 'Step done.', stepId: world.stepId(), operations: [], semanticCompletion: { stepId: world.stepId(), rationale: 'The completed gather batch grounds this prose-only step.' }, ...extra }) })
const plannerSlice = () => planReply({ plan: TWO_STEPS, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: GOAL, roadmap: SHELF })

test('a delegated slice on the new schema: every executor reply binds by step id, none uses the legacy index rule, and the final zero-operation claim closes the slice', async () => {
  const world = harness([
    plannerSlice(),
    w => stepReply(w),
    w => claimReply(w),
    planReply({ plan: ['Gather 10 coal'], currentStep: 0, operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) }),
  ])
  await world.say('get steam power going and run an electric mining drill on iron ore')
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed() // step 1 verified -> the executor submits step 2 by id
  world.game.inventory['copper-ore'] = 10
  await world.agent.completed() // the executor's {stepId, operations: [], semanticCompletion} closes the final step -> the planner authors the next slice

  assert.equal(world.calls.length, 4)
  assert.equal(world.calls[1].context.role, 'executor')
  assert.equal(world.calls[3].context.role, 'planner', 'the unmet goal returns the slice to the planner')
  assert.equal(world.rows('executor.step_bound').length, 2)
  assert.equal(world.rows('executor.legacy_step_index_used').length, 0)
  assert.equal(world.rows('executor.stale_step_rejected').length, 0)
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.game.mutations.length, 3, 'planner batch, executor batch and the next slice batch; the zero-operation claim admitted nothing')
})

test('the same slice with legacy-shaped executor replies (plan and currentStep, no stepId) still runs and traces the legacy index rule', async () => {
  const world = harness([
    plannerSlice(),
    planReply({ plan: TWO_STEPS, currentStep: 1, operations: [gather('copper-ore', 10)] }),
    w => planReply({ chatMessage: 'Step done.', plan: [], currentStep: 0, operations: [], semanticCompletion: { stepId: w.stepId(), rationale: 'The completed gather batch grounds this prose-only step.' } }),
    planReply({ plan: ['Gather 10 coal'], currentStep: 0, operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) }),
  ])
  await world.say('get steam power going and run an electric mining drill on iron ore')
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  world.game.inventory['copper-ore'] = 10
  await world.agent.completed()

  assert.equal(world.calls.length, 4)
  assert.equal(world.rows('executor.legacy_step_index_used').length, 2)
  assert.equal(world.rows('executor.step_bound').length, 0)
  assert.equal(world.rows('request.failed').length, 0)
})

test('the whole goal complete: an executor {stepId, operations: [], semanticCompletion} on a finite goal the game confirms completes the goal and admits nothing', async () => {
  const world = harness([
    planReply({ plan: ['Gather 10 iron ore'], currentStep: 0, operations: [gather('iron-ore', 10)], goal: FINITE_GOAL }),
    w => claimReply(w, { chatMessage: 'The goal is met.' }),
  ], { inventory: { 'iron-plate': 5 } })
  await world.say('have 5 iron plates')
  world.game.inventory['iron-ore'] = 10

  const result = await world.agent.completed()

  assert.equal(world.calls.length, 2)
  assert.equal(world.calls[1].context.role, 'executor')
  assert.equal(result.goalStatus, 'completed')
  assert.equal(world.rows('executor.step_bound').length, 1)
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.game.mutations.length, 1, 'only the planner batch reached the game')
})

// --- review follow-ups: planner-only fields out of the executor wording, and the wrapper form ------------------

test('the executor prompt variants name only fields the executor schema has; the planner prompts keep every planner field', () => {
  for (const prompt of [EXECUTOR_COMPACT_CONTINUATION_PROMPT, EXECUTOR_CLOSED_CONTROL_PROMPT]) {
    assert.doesNotMatch(prompt, /stepCompletions|assessmentOnly|roadmapNodeIds|developmentMode|currentStep/)
    assert.doesNotMatch(prompt, /New (?:execution )?drafts/)
  }
  assert.match(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /checkpoint and semanticCompletion remain allowed\./)
  assert.match(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /Closing observations does not close the control decision\. Root checkpoint is the active-step compatibility form\./)
  assert.match(EXECUTOR_COMPACT_CONTINUATION_PROMPT, /\nresearch_completed \{technology\} is supported, including multiple requirements with mode:"all"\./)
  assert.match(EXECUTOR_CLOSED_CONTROL_PROMPT, /Do not call submitPlan or another tool, and do not omit completion fields merely because tools are closed\.\nUse chatMessage, stepId and operations, plus the applicable checkpoint, semanticCompletion or timeReview\. Research completion uses research_completed/)
  // The planner text is untouched.
  assert.match(COMPACT_CONTINUATION_PROMPT, /checkpoint, semanticCompletion and stepCompletions remain allowed\. Closing observations does not close the control decision\. New drafts include stepCompletions aligned to plan/)
  assert.match(COMPACT_CONTINUATION_PROMPT, /\nEvery step of a new execution draft is deterministic\. For an intentionally observation-only slice, set assessmentOnly:true/)
  assert.match(CLOSED_CONTROL_PROMPT, /New execution drafts require stepCompletions aligned to plan, \{kind:"deterministic",checkpoint:\{mode,requirements\}\} at currentStep and \{kind:"deterministic"\} for each later step; keep committed completion specifications unchanged/)
  assert.match(CLOSED_CONTROL_PROMPT, /assessmentOnly:true with only semantic steps and no operations\. Research completion/)
})

// Owner decision 2026-10-08: execution slices declare only deterministic checkpoints; semantic declarations belong to an
// assessmentOnly slice. The planner wording says so; the executor variants are byte-identical to before the change.
test('planner prompts and the stepCompletions schema say execution plans declare only deterministic checkpoints; executor variants are unchanged', () => {
  const stepCompletions = plannerControlToolDefinitions[0].function.parameters.properties.stepCompletions
  // Step contracts are bound when each step is about to start (2026-10-09): the currentStep entry carries its checkpoint, later entries do not.
  assert.match(stepCompletions.description, /In an execution plan the entry at currentStep carries its deterministic checkpoint; later entries are \{kind:"deterministic"\} and their checkpoints are requested when each step is about to start\. Semantic declarations are accepted only with assessmentOnly:true\.$/)
  assert.doesNotMatch(stepCompletions.description, /World-changing steps require|observation\/assessment only/)
  assert.equal(stepCompletions.items.oneOf.length, 2, 'assessmentOnly still needs the semantic item')
  assert.deepEqual(stepCompletions.items.oneOf[0].required, ['kind'], 'a later step declares {kind:"deterministic"} with no checkpoint')
  assert.ok(stepCompletions.items.oneOf[0].properties.checkpoint, 'the checkpoint stays a declared property of the deterministic item')
  assert.match(COMPACT_CONTINUATION_PROMPT, /the currentStep entry is \{kind:"deterministic",checkpoint:\{mode,requirements\}\} and later entries are \{kind:"deterministic"\}; \{kind:"semantic",rationale:"\.\.\."\} entries only with assessmentOnly:true\. Luna authors the outcome/)
  assert.doesNotMatch(COMPACT_CONTINUATION_PROMPT, /\} or \{kind:"semantic"/)
  assert.doesNotMatch(CLOSED_CONTROL_PROMPT, /\} or \{kind:"semantic"|at least one deterministic step and stepCompletions/)
  const sha = text => createHash('sha256').update(text).digest('hex')
  // Hashes recorded from the executor variants immediately before the wording change.
  assert.equal(sha(EXECUTOR_COMPACT_CONTINUATION_PROMPT), 'cf609a119e5907e504ab0db36a355e415b8b0a3c940e28a8055ac363ac9b6028')
  assert.equal(sha(EXECUTOR_CLOSED_CONTROL_PROMPT), 'c16eaa752f1089668448e47be9ac44aed134ae1f5768f98d06d658fa06d4cbdc')
})

test('a submitPlan wrapper in content whose nested object names the step (no plan array) unwraps and binds like a bare stepId reply', async () => {
  const wrapped = JSON.stringify({ submitPlan: { chatMessage: '', stepId: 'step_3', operations: [] } })
  const result = normalizeProviderPlanContentDetailed(wrapped)
  assert.equal(result.refused, undefined)
  assert.deepEqual(JSON.parse(result.content), { chatMessage: '', stepId: 'step_3', operations: [] })
  // Still refused without a plan array or a step id, or with a blank id.
  for (const nested of [{ chatMessage: '', operations: [] }, { chatMessage: '', stepId: '  ', operations: [] }, { chatMessage: '', stepId: 7, operations: [] }]) {
    assert.equal(normalizeProviderPlanContentDetailed(JSON.stringify({ submitPlan: nested })).refused, 'submit_plan_wrapper_not_a_plan')
  }

  // And the loop binds it: the executor's wrapped reply is read as the bound step reply.
  const world = harness([
    plannerSlice(),
    // The provider layer unwraps the content before the loop reads it (the stub stands in for the wire).
    w => ({ content: normalizeProviderPlanContentDetailed(JSON.stringify({ submitPlan: { chatMessage: '', stepId: w.stepId(), operations: [gather('copper-ore', 10)] } })).content }),
  ])
  await world.say('get steam power going and run an electric mining drill on iron ore')
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed()
  assert.equal(world.rows('executor.step_bound').length, 1)
  assert.equal(world.rows('request.failed').length, 0)
})
