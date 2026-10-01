import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { diagnoseDsmlRejection } from './dsml-tool-calls.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { normalizeProviderPlanContentDetailed, providerCapabilityProfile, providerRequest } from './provider.mjs'

// Live run 2026-10-01 (OpenRouter, deepseek/deepseek-v4-flash, request req_mup8oayz_1,
// trigger post_step_observe). The decide round (tools closed, tool list removed) wrote a
// call as malformed DSML text; three recovery rounds then returned a complete plan in a
// code fence (one after a prose paragraph) with the submitPlan arguments nested inside
// the plan object. All four were rejected as provider_content_invalid_json and the goal
// paused with provider_recovery_exhausted. The four contents are the verbatim replies.

const FIXTURE = JSON.parse(await fsp.readFile(new URL('./fixtures/openrouter-deepseek-closed-round-2026-10-01.json', import.meta.url), 'utf8'))
const [MALFORMED_DSML, PROSE_THEN_FENCE, FENCE_ONE, FENCE_TWO] = FIXTURE.rounds.map(round => round.content)
const STEP_ID = FIXTURE.step_id
// The live markup used a tool_calls container (not the calls container the strict parser reads) AND wrote
// the arguments as nested invoke elements; both are named, neither is repaired.
const NAMED_REJECTION = 'unrecognized_tag_tool_calls+invoke_nested_in_invoke'

const DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash'
const openRouter = (model = DEEPSEEK_MODEL, extra = {}) => ({
  base: 'https://openrouter.ai/api/v1',
  key: 'test-key-1234',
  model,
  timeoutMs: 5000,
  ...extra,
})

function contentFetch(content, captured) {
  return async (_url, options) => {
    captured?.push(JSON.parse(options.body))
    return new Response(JSON.stringify({
      id: 'resp-openrouter-closed',
      model: DEEPSEEK_MODEL,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 9000, completion_tokens: 400, total_tokens: 9400 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

const history = [
  { role: 'system', content: 'You are SGLuna.' },
  { role: 'user', content: '[CHAT] TTLouis: get the red science automated' },
  { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {"task_state":"IDLE","queue_empty":true}' },
]

// A mid-request history (an operation error), where the open and closed rounds share one full-planner prefix.
const prefixHistory = [
  { role: 'system', content: 'You are SGLuna.' },
  { role: 'user', content: '[CHAT] TTLouis: get the red science automated' },
  { role: 'assistant', content: 'plan' },
  { role: 'user', content: '[MOD] Autorio operation error: placement refused' },
]

async function closedRound(content, { history: roundHistory = history, config = openRouter(), trigger = 'post_step_observe', round = 1, recoveryAttempt = 0 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-openrouter-closed-'))
  const promptTraceFile = path.join(dir, 'sgluna-prompts.jsonl')
  const captured = []
  const message = await providerRequest(config, roundHistory, {
    fetchImpl: contentFetch(content, captured),
    allowTools: false,
    triggerSource: trigger,
    round,
    recoveryAttempt,
    requestId: 'req_mup8oayz_1',
    epoch: 3,
    actorId: 18,
    promptTraceFile,
  })
  const events = (await fsp.readFile(promptTraceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  await fsp.rm(dir, { recursive: true, force: true })
  return { message, events, body: captured[0] }
}

test('fixtures are the realistic live replies, not toy strings', () => {
  assert.equal(FIXTURE.rounds.length, 4)
  assert.equal(MALFORMED_DSML.length, 216)
  assert.ok(MALFORMED_DSML.startsWith('<｜DSML｜tool_calls>'))
  assert.ok(PROSE_THEN_FENCE.length > 1300 && !PROSE_THEN_FENCE.startsWith('```'))
  assert.ok(FENCE_ONE.startsWith('```json') && FENCE_ONE.endsWith('```'))
  assert.equal(FENCE_ONE, FENCE_TWO)
})

test('openrouter profile with a deepseek-family model keeps the tool list on closed rounds', () => {
  for (const model of [DEEPSEEK_MODEL, 'deepseek/deepseek-chat-v3.1']) {
    const capability = providerCapabilityProfile(openRouter(model))
    assert.equal(capability.id, 'openrouter')
    assert.equal(capability.model_family, 'deepseek')
    assert.equal(capability.tools_kept_when_closed, true, model)
  }
})

test('openrouter profile for other model families still drops the tool list on closed rounds', async () => {
  for (const model of ['openai/gpt-5.1', 'anthropic/claude-opus-4.5', 'x-ai/grok-4', 'google/gemini-3-pro', 'meta-llama/llama-4']) {
    assert.equal(providerCapabilityProfile(openRouter(model)).tools_kept_when_closed, false, model)
    const { body } = await closedRound('{}', { config: openRouter(model) })
    assert.equal(body.tools, undefined, model)
    assert.equal(body.tool_choice, undefined, model)
  }
})

test('a deepseek closed round on openrouter sends the same tool block with tool_choice none in the OpenRouter body shape', async () => {
  const open = []
  await providerRequest(openRouter(), prefixHistory, { fetchImpl: contentFetch('{}', open), allowTools: true, triggerSource: 'failure', promptTraceFile: null })
  const { body: closed } = await closedRound('{}', { history: prefixHistory, trigger: 'failure' })
  assert.equal(open[0].tool_choice, 'auto')
  assert.equal(closed.tool_choice, 'none')
  assert.ok(Array.isArray(closed.tools) && closed.tools.length > 0)
  assert.equal(JSON.stringify(closed.tools), JSON.stringify(open[0].tools), 'identical block keeps the prompt prefix cache flat')
  assert.equal(closed.model, DEEPSEEK_MODEL)
  assert.equal(typeof closed.reasoning, 'object', 'OpenRouter reasoning field, not the vendor-native thinking field')
  assert.equal(closed.thinking, undefined)
  assert.equal(closed.reasoning_effort, undefined)
  assert.ok(closed.max_tokens > 0)
  assert.equal(closed.max_completion_tokens, undefined)
})

test('the interaction router never gets tools, even on a deepseek model behind openrouter', async () => {
  const captured = []
  await providerRequest(openRouter(), history, {
    fetchImpl: contentFetch('{}', captured),
    allowTools: false,
    interactionRouter: true,
    triggerSource: 'interaction_router',
    promptTraceFile: null,
  })
  assert.equal(captured[0].tools, undefined)
  assert.equal(captured[0].tool_choice, undefined)
})

test('prose then a fenced JSON plan with the plan nested in submitPlan is accepted as plan content and traced', async () => {
  const { message, events } = await closedRound(PROSE_THEN_FENCE, { recoveryAttempt: 1 })
  const plan = JSON.parse(message.content)
  assert.equal(plan.submitPlan, undefined, 'the wrapper is unwrapped, not forwarded')
  assert.deepEqual(plan.operations, [])
  assert.equal(plan.plan.length, 4)
  assert.equal(plan.currentStep, 0)
  assert.equal(plan.semanticCompletion.stepId, STEP_ID)
  assert.match(plan.semanticCompletion.rationale, /Inventory confirms/)
  assert.equal(message._sglunaProvider.diagnostic_code, 'ok')
  assert.equal(message._sglunaProvider.structured_content.plan_valid, true)
  const named = events.find(event => event.event === 'provider.plan_content_unwrapped')
  assert.ok(named)
  assert.equal(named.request_id, 'req_mup8oayz_1')
  assert.equal(named.reason, 'submit_plan_member_unwrapped')
  assert.equal(named.source, 'embedded')
})

test('a fenced JSON plan with the plan nested in submitPlan is accepted; the nested semanticCompletion wins', async () => {
  for (const content of [FENCE_ONE, FENCE_TWO]) {
    const { message, events } = await closedRound(content, { recoveryAttempt: 2 })
    const plan = JSON.parse(message.content)
    assert.equal(plan.submitPlan, undefined)
    assert.equal(plan.semanticCompletion.stepId, STEP_ID)
    assert.match(plan.semanticCompletion.rationale, /Batch receipt proves gather operations completed/)
    assert.equal(message._sglunaProvider.diagnostic_code, 'ok')
    assert.equal(message._sglunaProvider.plan_content_source, 'fence')
    assert.equal(message._sglunaProvider.plan_content_submit_plan_unwrapped, true)
    const named = events.find(event => event.event === 'provider.plan_content_unwrapped')
    assert.equal(named?.request_id, 'req_mup8oayz_1')
    assert.equal(named?.source, 'fence')
  }
})

test('a fenced plan that carries plan-surface extensions without any wrapper is accepted too', () => {
  const object = { chatMessage: '', plan: ['a', 'b'], currentStep: 0, operations: [], semanticCompletion: { stepId: 's1', rationale: 'done' }, developmentMode: 'vertical' }
  const detailed = normalizeProviderPlanContentDetailed(`Done.\n\`\`\`json\n${JSON.stringify(object, null, 2)}\n\`\`\``)
  assert.equal(detailed.source, 'embedded')
  assert.equal(detailed.submit_plan_unwrapped, false)
  assert.deepEqual(JSON.parse(detailed.content), object)
  const fenced = normalizeProviderPlanContentDetailed(`\`\`\`json\n${JSON.stringify(object)}\n\`\`\``)
  assert.equal(fenced.source, 'fence')
})

test('an ambiguous submitPlan wrapper is refused with a named reason and the content is left unchanged', async () => {
  const nested = { plan: ['a', 'b'], currentStep: 1, operations: [] }
  const cases = [
    ['submit_plan_wrapper_conflict', { chatMessage: '', plan: ['x'], currentStep: 0, operations: [], submitPlan: nested }],
    ['submit_plan_wrapper_unknown_members', { chatMessage: '', note: 'hi', submitPlan: nested }],
    ['submit_plan_wrapper_not_a_plan', { chatMessage: '', plan: ['a'], currentStep: 0, operations: [], submitPlan: { operations: [] } }],
    ['submit_plan_wrapper_nested_twice', { chatMessage: '', submitPlan: { ...nested, submitPlan: nested } }],
  ]
  for (const [reason, object] of cases) {
    const raw = `\`\`\`json\n${JSON.stringify(object)}\n\`\`\``
    const { message, events } = await closedRound(raw)
    assert.equal(message.content, raw, reason)
    assert.equal(message._sglunaProvider.plan_content_refused_reason, reason)
    const named = events.find(event => event.event === 'provider.plan_content_refused')
    assert.equal(named?.reason, reason)
    assert.equal(named?.request_id, 'req_mup8oayz_1')
    assert.equal(events.some(event => event.event === 'provider.plan_content_unwrapped'), false, reason)
  }
})

test('malformed DSML (arguments written as nested invoke elements) is rejected with a named reason, not guessed at', async () => {
  assert.equal(diagnoseDsmlRejection(MALFORMED_DSML), NAMED_REJECTION)
  const { message, events } = await closedRound(MALFORMED_DSML)
  assert.equal(message.content, MALFORMED_DSML, 'content is not repaired')
  assert.equal(message.tool_calls, undefined, 'no tool call is invented from malformed markup')
  assert.equal(message._sglunaProvider.diagnostic_code, 'provider_content_invalid_json')
  assert.equal(message._sglunaProvider.dsml_recovery, 'rejected_malformed')
  assert.equal(message._sglunaProvider.dsml_rejected_reason, NAMED_REJECTION)
  const named = events.find(event => event.event === 'provider.dsml_rejected')
  assert.ok(named)
  assert.equal(named.reason, NAMED_REJECTION)
  assert.equal(named.request_id, 'req_mup8oayz_1')
  assert.equal(named.round, 1)
})

test('valid DSML is not reported as rejected and non-DSML text carries no DSML reason', async () => {
  assert.equal(diagnoseDsmlRejection('no markup here'), undefined)
  assert.equal(diagnoseDsmlRejection('<｜DSML｜calls>\n<｜DSML｜invoke name="getInventoryItems">\n</｜DSML｜invoke>\n</｜DSML｜calls>'), undefined)
  assert.equal(diagnoseDsmlRejection('<｜DSML｜tool_calls>\n<｜DSML｜invoke name="getInventoryItems">\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'), 'unrecognized_tag_tool_calls', 'an unknown container is named, never accepted')
  const { message } = await closedRound('Plain prose without a plan.')
  assert.equal(message._sglunaProvider.dsml_rejected_reason, undefined)
  assert.equal(message._sglunaProvider.dsml_recovery, undefined)
})

// --- Loop level: the same replies through the real NpcAgentLoop recovery ---

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    return '{}'
  }
}

function activePlan() {
  const plan = [
    'Gather iron ore, copper ore, stone, and coal for initial smelting and hand-crafted materials.',
    'Smelt plates using stone furnaces, then craft iron gear wheels and hand-craft the first automation science packs.',
    'Research automation technology using the hand-crafted science packs.',
    'Craft an assembling machine, place it, and set it up to automate red science production with belt-fed materials.',
  ]
  return {
    goal_id: 'goal_16t14uo_1',
    owner: 'TTLouis',
    objective: 'automate red science',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan,
    current_step: 0,
    revision: 1,
    last_chat_message: '',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_16t14uo_1',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: plan.length,
      active_index: 0,
      active_step_id: STEP_ID,
      steps: plan.map((description, index) => ({ id: index === 0 ? STEP_ID : `step_${index + 1}`, description, status: index === 0 ? 'active' : 'pending' })),
      evidence: [],
    },
  }
}

function agentWithScriptedProvider(contents, { promptTraceFile } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const state = activePlan()
  memory.planByNpc.set('npc:sgluna', state)
  // The goal's plan is committed, as it is when a post_step_observe turn closes a step.
  memory.ensurePlanningDraft('npc:sgluna', state, { now: 100, migrated: true })
  memory.commitPlanningPlan('npc:sgluna', { now: 110, migrated: true, runtime_validation: { passed: true } })
  const queue = [...contents]
  const providerCalls = []
  const provider = async (loopMessages, context) => {
    providerCalls.push(context)
    const content = queue.shift()
    if (content === undefined) throw new Error('scripted provider ran out of replies')
    return providerRequest(openRouter(), loopMessages, {
      ...context,
      fetchImpl: contentFetch(content),
      promptTraceFile,
    })
  }
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory,
    systemPrompt: 'main planner',
    npcId: 'sgluna',
    provider,
    traceFile: null,
    decisionTraceFile: null,
    stateFile: null,
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:sgluna'
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: '[CHAT] TTLouis: automate red science' },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = { memoryKey: 'npc:sgluna', turnId: 1, sender: 'TTLouis', text: 'automate red science' }
  // Round 0 of the post_step_observe turn made its read-only observation calls before the closed round.
  agent.freshObservationSinceContinuation = true
  return { agent, memory, providerCalls, queue }
}

async function providerMessage(content, options) {
  return (await closedRound(content, options)).message
}

test('the loop parses the unwrapped live plan, lifting the nested semanticCompletion onto the committed active step', async () => {
  const { agent } = agentWithScriptedProvider([])
  for (const content of [PROSE_THEN_FENCE, FENCE_ONE]) {
    const plan = agent.parsePlanMessage(await providerMessage(content))
    assert.equal(plan.plan.length, 4)
    assert.equal(plan.currentStep, 0)
    assert.deepEqual(plan.operations, [])
    assert.equal(plan.semanticCompletion.stepId, STEP_ID)
  }
})

test('the loop names why a refused wrapper or malformed DSML was rejected, with the exact expected shape', async () => {
  const { agent } = agentWithScriptedProvider([])
  const dsml = await providerMessage(MALFORMED_DSML)
  assert.throws(() => agent.parsePlanMessage(dsml), error => error.code === 'dsml_malformed'
    && error.message.includes(NAMED_REJECTION)
    && /"chatMessage":"","plan":\[/.test(error.message))
  const conflict = await providerMessage(`\`\`\`json\n${JSON.stringify({ chatMessage: '', plan: ['x'], currentStep: 0, operations: [], submitPlan: { plan: ['y'], currentStep: 0, operations: [] } })}\n\`\`\``)
  assert.throws(() => agent.parsePlanMessage(conflict), error => error.code === 'plan_content_refused' && /submit_plan_wrapper_conflict/.test(error.message))
})

test('scripted post_step_observe closed round: malformed DSML then the fenced plan now commits instead of exhausting recovery', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-openrouter-scenario-'))
  const promptTraceFile = path.join(dir, 'sgluna-prompts.jsonl')
  try {
    // The live replies in order: decide round, then the first recovery round. Once its plan closes the
    // step the loop runs a follow-on turn (scripted next); the remaining live recovery replies are never reached.
    const followOn = JSON.stringify({ chatMessage: 'BLOCKED: scripted follow-on turn ends here.', plan: activePlan().plan, currentStep: 1, operations: [] })
    const { agent, memory, providerCalls, queue } = agentWithScriptedProvider([MALFORMED_DSML, PROSE_THEN_FENCE, followOn, FENCE_ONE, FENCE_TWO], { promptTraceFile })
    const first = await agent.callProvider(await agent.assertCurrent(), agent.generation, { round: 1, allowTools: false, recoveryAttempt: 0 })
    assert.throws(() => agent.parsePlanMessage(first), error => error.code === 'dsml_malformed')
    const result = await agent.recoverPlan(agent.generation, new Error(`dsml_malformed: ${NAMED_REJECTION}`), 2)
    assert.ok(result, 'recovery did not exhaust')
    const board = memory.currentPlan('npc:sgluna').task_board
    assert.equal(board.completed_count, 1, 'the nested semanticCompletion closed the grounded active step')
    assert.equal(board.steps[0].status, 'completed')
    assert.equal(board.active_step_id, 'step_2')
    assert.ok(providerCalls.slice(0, 2).every(call => call.allowTools === false))
    assert.deepEqual(queue, [FENCE_ONE, FENCE_TWO], 'the first recovery reply was enough; recovery attempts 2 and 3 were never requested')
    const events = (await fsp.readFile(promptTraceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert.ok(events.some(event => event.event === 'provider.dsml_rejected' && event.reason === NAMED_REJECTION))
    assert.ok(events.some(event => event.event === 'provider.plan_content_unwrapped' && event.reason === 'submit_plan_member_unwrapped'))
  }
  finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
