import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'

// Real bug (owner correction, superseding the earlier DSML diagnosis):
// data/logs/sgluna-behavior.jsonl, the provider.response just before the
// first observation_phase_closed retry (2026-09-26T21:53:30Z) shows
// `has_tool_calls: true` (npc-agent-loop.mjs:5683, `message.tool_calls !==
// undefined`) with `tool_call_count: 0` and `finish_reason: "stop"`, and
// content that is a valid decision JSON (chatMessage/plan/currentStep with
// two move_items_exact operations). LM Studio's OpenAI-compatible server
// returns `tool_calls: []` (or null) on a plain content reply instead of
// omitting the key. Every `!== undefined` guard then reads it as a real
// tool call, even though no DSML markup was ever involved.

const config = {
  base: 'https://api.example.test/v1',
  key: 'test-key-1234',
  model: 'test-model',
}
const messages = [{ role: 'user', content: 'hello' }]

function rawFetch(rawMessage, finishReason = 'stop') {
  return async () => new Response(JSON.stringify({
    id: 'resp-empty-tool-calls',
    model: 'test-model',
    choices: [{ finish_reason: finishReason, message: { role: 'assistant', ...rawMessage } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

// The recorded content shape (trimmed to a realistic size, not the full
// 1187 chars): chatMessage, plan, currentStep, two move_items_exact ops.
const RECORDED_DECISION_CONTENT = JSON.stringify({
  chatMessage: '',
  plan: ['Move ore into the furnaces', 'Smelt into plates'],
  currentStep: 0,
  operations: [
    { name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: 582, max_count: 20, to_entity: true } },
    { name: 'move_items_exact', args: { item_name: 'copper-ore', unit_number: 583, max_count: 20, to_entity: true } },
  ],
})

test('an empty tool_calls array on a plain content reply is normalized to undefined', async () => {
  const message = await providerRequest(config, messages, {
    fetchImpl: rawFetch({ content: RECORDED_DECISION_CONTENT, tool_calls: [] }),
    allowTools: false,
  })
  assert.equal(message.tool_calls, undefined)
  assert.equal(message._airiProvider.empty_tool_calls_normalized, true)
  assert.equal(message._airiProvider.tool_call_count, 0)
  assert.equal(JSON.parse(message.content).operations.length, 2)
})

test('a null tool_calls on a plain content reply is normalized to undefined', async () => {
  const message = await providerRequest(config, messages, {
    fetchImpl: rawFetch({ content: RECORDED_DECISION_CONTENT, tool_calls: null }),
    allowTools: false,
  })
  assert.equal(message.tool_calls, undefined)
  assert.equal(message._airiProvider.empty_tool_calls_normalized, true)
})

test('a real (non-empty) tool_calls array is left untouched and not flagged as normalized', async () => {
  const message = await providerRequest(config, messages, {
    fetchImpl: rawFetch({
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'getInventory', arguments: '{}' } }],
    }),
    allowTools: true,
  })
  assert.equal(Array.isArray(message.tool_calls), true)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message._airiProvider.empty_tool_calls_normalized, false)
})

test('an absent tool_calls key is not flagged as normalized (nothing to normalize)', async () => {
  const message = await providerRequest(config, messages, {
    fetchImpl: rawFetch({ content: '{}' }),
    allowTools: false,
  })
  assert.equal(message._airiProvider.empty_tool_calls_normalized, false)
})

// --- Loop-level replay: the real runTurn, tools-off round, through the
// real providerRequest (not a hand-built JS message). ---

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.mutations = []
    this.batchId = 0
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      return JSON.stringify({
        actor_position: { x: 0, y: 0 },
        entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 582, position: { x: 4, y: 0 } }],
      })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: {
          batch_id: this.batchId,
          task_count: 1,
          task_types: ['mining'],
          tick: 400 + this.batchId,
        },
        basic_operation: { last_result: { operation_id: this.batchId, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      this.batchId++
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

test('a plain LM-Studio decision with tool_calls:[] on the action-omission-repair no-tools round is processed, not read as a phantom observation', async t => {
  const plan = ['Mine fuel', 'Load the furnace']
  let call = 0
  const provider = async (loopMessages, context) => {
    call++
    if (context.allowTools === false) {
      // This is the forced no-tools decision round the real bug hit. Route
      // through the real providerRequest with a raw fetch mock, exactly as
      // supervisor.mjs wires it in production, so the normalization fix in
      // provider-base.mjs is actually exercised end to end.
      return providerRequest(config, loopMessages, {
        ...context,
        fetchImpl: rawFetch({
          content: JSON.stringify({
            // The action-omission act-or-block contract requires either an
            // executable operation or an explicit BLOCKED: reason when
            // operations is empty; a bare confirmation with no operations
            // is invalid regardless of the tool_calls bug, so use the
            // explicit-blocker shape to isolate what this test checks.
            chatMessage: 'BLOCKED: the furnace already has enough ore; no further transfer is needed.',
            plan,
            currentStep: 1,
            operations: [],
          }),
          tool_calls: [],
        }),
      })
    }
    if (call === 1) {
      return planMessage({
        chatMessage: 'Mining fuel first.',
        plan,
        currentStep: 0,
        operations: [{ name: 'mine_entity', args: { entity_name: 'coal', count: 5 } }],
      })
    }
    if (call === 2) {
      // A no-op continuation after a verified mutation trips
      // finiteNoOperationPressure and starts the action-omission repair
      // (npc-agent-loop.mjs beginActionOmissionRepair).
      return planMessage({ chatMessage: 'Loading the furnace next.', plan, currentStep: 1, operations: [] })
    }
    if (call === 3) {
      // The repair's "act" round: one targeted observation. allowTools is
      // still true here; actionOmissionForceNoTools flips only after this
      // one admitted observation resolves.
      return {
        content: null,
        tool_calls: [{
          id: 'observe-furnace',
          type: 'function',
          function: {
            name: 'getNearbyEntities',
            arguments: JSON.stringify({ radius: 16, name: 'stone-furnace', limit: 4 }),
          },
        }],
      }
    }
    throw new Error(`unexpected extra provider call ${call}`)
  }

  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider,
    systemPrompt: 'NPC empty-tool-calls normalization test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  await agent.request('prepare the furnace', { sender: 'TTLouis' })
  const result = await agent.completed()

  // Processed as the genuine BLOCKED: decision it was, not discarded as a
  // rejected phantom observation (which would have thrown
  // provider_action_omission_repair_failed or replaced chatMessage with the
  // canned "Action-omission repair attempted another observation..." text,
  // per npc-agent-loop.mjs's recovery.action_omission_observation_rejected
  // branch, keyed off the same `tool_calls !== undefined` test this fix
  // addresses).
  assert.match(result.chatMessage, /furnace already has enough ore/)
  assert.doesNotMatch(result.chatMessage, /attempted another observation/)
})
