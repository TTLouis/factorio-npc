import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'

function deployment(actorId = 18, epoch = 3) {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: actorId,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.mutations = []
    this.batchId = 1
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, kind: 'standalone_character' } })
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: {
          batch_id: this.batchId,
          task_count: 1,
          task_types: ['placing'],
          tick: 100 + this.batchId,
        },
        basic_operation: { last_result: { operation_id: 9, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function toolMessage() {
  return {
    content: null,
    tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }],
  }
}

// The planner authors each placement's receipt as its deterministic
// checkpoint; runtime closes the step on it without a second AI judge.
function placementReceiptCheckpoint() {
  return { mode: 'all', requirements: [{ id: 'placed', kind: 'authoritative_operation_receipt', operation_name: 'place_entity' }] }
}

function planMessage(operations, chatMessage = 'Working.', checkpoint) {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Perform bounded step'] : [],
      currentStep: 0,
      operations,
      ...(checkpoint ? { checkpoint } : {}),
    }),
  }
}

function withProviderUsage(message, usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 80 },
}) {
  Object.defineProperty(message, '_airiProvider', {
    configurable: true,
    enumerable: false,
    value: {
      response_id: 'resp-test',
      model: 'test-model',
      finish_reason: 'stop',
      usage,
    },
  })
  return message
}

function completionAndContinueDecision(state) {
  if (state?.contract === 'step_completion_contract') {
    return {
      model: 'jev-test',
      provider: 'TypeSafe',
      answers: {
        contract: {
          type: 'choice',
          choice: 'candidate_1',
          confidence: 0.99,
          probabilities: { candidate_1: 0.99, semantic_unknown: 0.01 },
        },
        compound_step: { type: 'noul', noul: 0.01 },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
    }
  }
  if (state?.reason === 'post_step_planner_gate') {
    return {
      model: 'jev-test',
      provider: 'TypeSafe',
      answers: {
        route: {
          type: 'choice',
          choice: 'continue_current',
          confidence: 0.99,
          probabilities: { continue_current: 0.99 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
    }
  }
  throw new Error('unexpected decision contract')
}

function truncatedProviderMessage(responseId) {
  const message = { content: '' }
  Object.defineProperty(message, '_airiProvider', {
    configurable: true,
    enumerable: false,
    value: {
      response_id: responseId,
      model: 'test-model',
      finish_reason: 'length',
      diagnostic_code: 'provider_output_truncated_empty_content',
      usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
      response_bytes: 512,
      content_chars: 0,
      content_utf8_bytes: 0,
      content_non_ascii_chars: 0,
      content_replacement_chars: 0,
      normalized_content_chars: 0,
      reasoning_content_chars: 8400,
      tool_call_count: 0,
      structured_content: { json_valid: false, plan_valid: false, error: 'empty content' },
      content_preview: '',
    },
  })
  return message
}

test('behavior trace correlates request through verification, records usage, and redacts secrets', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-behavior-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'airi-behavior.jsonl')
  const replies = [
    toolMessage(),
    planMessage([{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 4 } }], 'Working.', placementReceiptCheckpoint()),
  ]
  let budgetCount = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => withProviderUsage(replies.shift()),
    reserve: async () => ({ count: ++budgetCount, token: 'budget-secret-token' }),
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'NPC test prompt',
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    traceFile,
  })

  await agent.request('inspect Bearer abcdefghijklmnop then place one furnace', { sender: 'TTLouis' })
  await agent.completed()

  const raw = await fsp.readFile(traceFile, 'utf8')
  const rows = raw.trim().split('\n').map(JSON.parse)
  const events = rows.map(row => row.event)
  for (const event of [
    'request.received',
    'actor.bound',
    'budget.reserved',
    'provider.request',
    'provider.response',
    'tool.call',
    'tool.result',
    'plan.accepted',
    'operations.ack',
    'factorio.completed_signal',
    'factorio.status',
    'request.completed',
  ]) assert.ok(events.includes(event), `missing ${event}`)

  assert.equal(new Set(rows.map(row => row.request_id)).size, 1)
  assert.doesNotMatch(raw, /budget-secret-token/)
  assert.doesNotMatch(raw, /Bearer abcdefghijklmnop/)
  assert.match(raw, /\[REDACTED\]/)
  assert.match(raw, /operation_id\\?":9/)

  const responses = rows.filter(row => row.event === 'provider.response')
  assert.equal(responses.length, 2)
  assert.deepEqual(responses[0].data.usage, {
    input_units: 100,
    cached_input_units: 80,
    cache_miss_input_units: 20,
    output_units: 20,
    total_units: 120,
    usage_complete: true,
  })
  const toolResultChars = rows
    .filter(row => row.event === 'tool.result')
    .reduce((total, row) => total + row.data.output_chars, 0)
  const completed = rows.find(row => row.event === 'request.completed')
  assert.deepEqual(completed.data.usage, {
    provider_calls: 2,
    input_units: 200,
    cached_input_units: 160,
    cache_miss_input_units: 40,
    output_units: 40,
    visible_output_units: 0,
    reasoning_output_units: 0,
    total_units: 240,
    usage_complete: true,
    usage_incomplete_calls: 0,
    tool_calls: 1,
    duplicate_tool_calls: 0,
    tool_result_chars: toolResultChars,
    coalesced_runtime_events: 0,
  })
})

test('duplicate completion receipts do not spend another provider call, while a new batch still does', async () => {
  const rcon = new FakeRcon()
  const replies = [
    {
      content: JSON.stringify({
        chatMessage: 'Place the first furnace.',
        plan: ['Place first furnace', 'Place second furnace'],
        currentStep: 0,
        operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 4 } }],
        checkpoint: placementReceiptCheckpoint(),
      }),
    },
    {
      content: JSON.stringify({
        chatMessage: 'Place the second furnace.',
        plan: ['Place first furnace', 'Place second furnace'],
        currentStep: 1,
        operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 6, y: 4 } }],
      }),
    },
    // Step 2 is prose-only once the plan is committed, so the planner closes
    // it with an explicit final completion claim after its receipt.
    {
      content: JSON.stringify({
        chatMessage: 'Both furnaces are placed.',
        plan: [],
        currentStep: 0,
        operations: [],
      }),
    },
  ]
  let providerCalls = 0
  const activity = []
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      providerCalls++
      return replies.shift()
    },
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'NPC test prompt',
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    traceFile: null,
    onActivity: (event, data) => activity.push({ event, data }),
  })

  await agent.request('place two furnaces', { sender: 'TTLouis' })
  assert.equal(providerCalls, 1)

  await agent.completed()
  assert.equal(providerCalls, 2)
  assert.equal(agent.active, true)

  const duplicate = await agent.completed()
  assert.equal(duplicate, null)
  assert.equal(providerCalls, 2)
  assert.ok(activity.some(entry => entry.event === 'factorio.event_coalesced' && entry.data.kind === 'completion'))

  rcon.batchId = 2
  const closed = await agent.completed()
  assert.equal(providerCalls, 3)
  assert.equal(closed.goalStatus, 'completed')
  assert.equal(agent.active, false)
})

test('provider response metadata is available to tracing without changing assistant JSON', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    id: 'resp_123',
    model: 'test-model-v2',
    usage: { prompt_tokens: 12, completion_tokens: 4 },
    choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  const message = await providerRequest({
    base: 'https://api.example.test/v1',
    key: 'test-key-1234',
    model: 'test-model',
  }, [{ role: 'user', content: 'hello' }], { fetchImpl, allowTools: false })

  assert.equal(message._airiProvider.response_id, 'resp_123')
  assert.equal(message._airiProvider.model, 'test-model-v2')
  assert.equal(message._airiProvider.finish_reason, 'stop')
  assert.deepEqual(message._airiProvider.usage, { prompt_tokens: 12, completion_tokens: 4 })
  assert.equal(message._airiProvider.diagnostic_code, 'provider_content_schema_invalid')
  assert.equal(message._airiProvider.content_chars, 2)
  assert.equal(message._airiProvider.content_utf8_bytes, 2)
  assert.equal(message._airiProvider.reasoning_content_chars, 0)
  assert.equal(message._airiProvider.tool_call_count, 0)
  assert.deepEqual(message._airiProvider.message_keys, ['content'])
  assert.deepEqual(message._airiProvider.structured_content, {
    json_valid: true,
    plan_valid: false,
    error: 'Invalid chatMessage',
  })
  assert.equal(Object.keys(message).includes('_airiProvider'), false)
  assert.equal(JSON.stringify(message), '{"content":"{}"}')
})

test('request failure freezes the final provider diagnostics and last tool into one snapshot', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-failure-snapshot-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'airi-behavior.jsonl')
  let providerCalls = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => {
      providerCalls++
      if (providerCalls === 1) return toolMessage()
      return truncatedProviderMessage(`resp-truncated-${providerCalls}`)
    },
    systemPrompt: 'NPC test prompt',
    traceFile,
  })

  await assert.rejects(
    agent.request('inspect once, then answer', { sender: 'TTLouis' }),
    /Invalid provider content JSON|recovery exhausted/i,
  )

  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const failed = rows.findLast(row => row.event === 'request.failed')
  assert.ok(failed)
  assert.equal(failed.data.stage, 'runtime')
  assert.equal(failed.data.failure_snapshot.provider.kind, 'response')
  assert.equal(failed.data.failure_snapshot.provider.recovery_attempt, 3)
  assert.equal(failed.data.failure_snapshot.provider.provider.finish_reason, 'length')
  assert.equal(failed.data.failure_snapshot.provider.provider.diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(failed.data.failure_snapshot.provider.provider.content_chars, 0)
  assert.equal(failed.data.failure_snapshot.provider.provider.reasoning_content_chars, 8400)
  assert.deepEqual(failed.data.failure_snapshot.provider.provider.structured_content, {
    json_valid: false,
    plan_valid: false,
    error: 'empty content',
  })
  assert.equal(failed.data.failure_snapshot.recovery.attempt, 3)
  assert.match(failed.data.failure_snapshot.recovery.reason, /Invalid provider content JSON/i)
  assert.equal(failed.data.failure_snapshot.last_tool.phase, 'result')
  assert.equal(failed.data.failure_snapshot.last_tool.name, 'getActorStatus')
  assert.ok(failed.data.failure_snapshot.last_tool.output_chars > 0)
  // Actor identity is still available from the correlated actor.bound event.
  // The next UI-bridge change will freeze it directly into the failure card.
  const actorBound = rows.find(row => row.event === 'actor.bound')
  assert.equal(actorBound?.data?.actor_id, 18)
  assert.equal(actorBound?.data?.epoch, 3)
})
