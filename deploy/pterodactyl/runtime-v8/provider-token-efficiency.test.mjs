import test from 'node:test'
import assert from 'node:assert/strict'

import {
  compactCompletionMessages,
  compactCompletionTools,
  compactPlanStateContent,
  providerRequest,
} from './provider.mjs'
import { providerToolDefinitions, toolDefinitions } from './structured-policy.mjs'

function fakeProviderResponse() {
  return new Response(JSON.stringify({
    id: 'resp-test',
    model: 'test-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const config = {
  base: 'https://provider.example/v1',
  key: 'test-key',
  model: 'test-model',
  timeoutMs: 5000,
}

test('successful operation completion uses compact context and bounded fallback output budget', async () => {
  let body
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body)
    return fakeProviderResponse()
  }
  const planState = {
    goal_id: 'goal_1',
    owner: 'TTLouis',
    objective: 'collect starter resources',
    status: 'active',
    plan: ['collect iron', 'collect coal', 'craft'],
    current_step: 1,
    current_step_text: 'collect coal',
    revision: 4,
    last_operations: ['gather_resource {"resource_name":"iron-ore","count":20,"search_radius":256}'],
    history: Array.from({ length: 20 }, (_, index) => ({ revision: index, chat: 'old history '.repeat(50) })),
    last_chat_message: 'old verbose chat '.repeat(100),
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_1',
      status: 'active',
      revision: 4,
      completed_count: 1,
      total_steps: 3,
      active_index: 1,
      active_step_id: 'step_2',
      steps: [
        { id: 'step_1', description: 'collect iron', status: 'completed' },
        { id: 'step_2', description: 'collect coal', status: 'active' },
        { id: 'step_3', description: 'craft', status: 'pending' },
      ],
      evidence: [
        { kind: 'deterministic_verification', ref: 'batch_1', summary: '{"verdict":"verified_complete"}' },
      ],
      events: Array.from({ length: 20 }, (_, index) => ({ type: 'old_event', index })),
    },
  }
  const memory = `[MEMORY] ${'old dialogue '.repeat(500)}\n[PLAN_STATE] Harness-owned durable goal/plan state.\n${JSON.stringify(planState)}`
  const receipt = {
    task_state: 'idle',
    queue_empty: true,
    queue_length: 0,
    last_completed_batch: { batch_id: 1, task_count: 2, task_types: ['walking_to_entity', 'mining'], tick: 100 },
    actor: { huge: 'unused actor snapshot '.repeat(100) },
    basic_operation: { last_result: { completed: true, code: 'completed', requested_count: 20 } },
  }

  await providerRequest(config, [
    { role: 'system', content: 'FULL SYSTEM PROMPT '.repeat(500) },
    { role: 'user', content: memory },
    { role: 'user', content: '[CHAT] TTLouis: collect starter resources' },
    { role: 'assistant', content: '{"chatMessage":"working","plan":["collect iron","collect coal","craft"],"currentStep":0,"operations":[{"name":"gather_resource","args":{"resource_name":"iron-ore","count":20,"search_radius":256}}]}' },
    { role: 'user', content: `[MOD] Autorio operation batch completed. Detailed task receipt: ${JSON.stringify(receipt)}` },
  ], { fetchImpl, allowTools: true, recoveryAttempt: 0 })

  assert.equal(body.max_tokens, 8000)
  assert.notEqual(body.messages[0].content, 'FULL SYSTEM PROMPT '.repeat(500))
  assert.match(body.messages[0].content, /Token-efficient continuation rules/)
  assert.match(body.messages[0].content, /deterministic_verification/)
  assert.equal(body.tools.length, providerToolDefinitions.length)
  assert.ok(body.tools.every(tool => !tool.function?.description || tool.function.description.length <= 120))

  const compactMemory = body.messages[1].content
  assert.match(compactMemory, /^\[PLAN_STATE\] Compact legacy compatibility state/)
  assert.match(compactMemory, /collect starter resources/)
  assert.match(compactMemory, /deterministic_verification/)
  assert.doesNotMatch(compactMemory, /old history/)
  assert.doesNotMatch(compactMemory, /old verbose chat/)
  assert.doesNotMatch(compactMemory, /old_event/)
  assert.ok(compactMemory.length < memory.length / 3)

  const compactReceipt = body.messages.at(-1).content
  assert.match(compactReceipt, /Compact task receipt/)
  assert.match(compactReceipt, /last_completed_batch/)
  assert.match(compactReceipt, /requested_count/)
  assert.doesNotMatch(compactReceipt, /unused actor snapshot/)
})

test('compact continuation preserves reducer planning authority in the new two-block context', () => {
  const runtime = {
    goal_id: 'goal_new',
    objective: 'build staged production',
    status: 'active',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_new',
      status: 'active',
      completed_count: 0,
      total_steps: 1,
      active_index: 0,
      steps: [{ id: 'legacy_step', description: 'legacy projection', status: 'active' }],
      evidence: [{ kind: 'deterministic_verification', ref: 'legacy-proof', summary: 'verified' }],
    },
    history: ['drop me'],
  }
  const planning = {
    goal: { goal_id: 'goal_new', objective: 'build staged production', status: 'active' },
    roadmap: {
      roadmap_revision_id: 'roadmap_1',
      revision_index: 1,
      nodes: [{ id: 'node_1', intent: 'Smelting exists.', status: 'ready_to_refine', depends_on: [] }],
    },
    steering: { current_mode: 'horizontal', sequence: 2 },
    plan_tracker: {
      plan_id: 'goal_new_p4',
      plan_version: 2,
      status: 'COMMITTED',
      development_mode: 'horizontal',
      active_step_id: 'p4_s1',
      active_step_index: 0,
      roadmap_node_ids: ['node_1'],
      derived_from_plan_id: 'goal_new_p3',
      steps: [{
        step_id: 'p4_s1',
        description: 'Build support capacity',
        status: 'active',
        completion_contract: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 20 }] },
        evidence_refs: ['proof_1'],
      }],
    },
  }
  const content = `[MEMORY] old dialogue
[RUNTIME_COMPAT_STATE] compatibility only
${JSON.stringify(runtime)}
[PLANNING_STATE] reducer authority
${JSON.stringify(planning)}`

  const compact = compactPlanStateContent(content)
  assert.match(compact, /^\[RUNTIME_COMPAT_STATE\]/)
  assert.match(compact, /\[PLANNING_STATE\]/)
  assert.match(compact, /goal_new_p4/)
  assert.match(compact, /Build support capacity/)
  assert.match(compact, /"current_mode":"horizontal"/)
  assert.doesNotMatch(compact, /drop me/)
  assert.doesNotMatch(compact, /\[MEMORY\]/)
})

test('initial requests and recovery attempts retain the full prompt and full output budget', async () => {
  const bodies = []
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    return fakeProviderResponse()
  }
  const fullPrompt = 'FULL SYSTEM PROMPT '.repeat(100)

  await providerRequest(config, [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: '[CHAT] TTLouis: gather iron' },
  ], { fetchImpl, allowTools: true, recoveryAttempt: 0 })

  await providerRequest(config, [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: '[MOD] Autorio operation batch completed. Detailed task receipt: {}' },
  ], { fetchImpl, allowTools: false, recoveryAttempt: 1 })

  for (const body of bodies) {
    assert.equal(body.max_tokens, 4000)
    assert.equal(body.messages[0].content, fullPrompt)
  }
})

test('compact helpers do not mutate the canonical messages or tool registry', () => {
  const messages = [{ role: 'system', content: 'original' }, { role: 'user', content: 'continuation' }]
  const compactMessages = compactCompletionMessages(messages)
  assert.equal(messages[0].content, 'original')
  assert.notEqual(compactMessages[0].content, 'original')

  const memory = `[MEMORY] old context\n[PLAN_STATE] state\n${JSON.stringify({ objective: 'keep me', history: ['drop me'] })}`
  const compactMemory = compactPlanStateContent(memory)
  assert.match(compactMemory, /keep me/)
  assert.doesNotMatch(compactMemory, /drop me/)

  const firstDescription = toolDefinitions[0]?.function?.description
  const compactTools = compactCompletionTools(toolDefinitions)
  assert.equal(toolDefinitions[0]?.function?.description, firstDescription)
  assert.equal(compactTools.length, toolDefinitions.length)
})
