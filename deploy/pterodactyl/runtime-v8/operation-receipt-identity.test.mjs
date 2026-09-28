import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CanonicalTaskBoardMemory, operationRefusalCause } from './canonical-task-board-memory.mjs'
import { correlateBasicOperationResult, NpcAgentLoop, receiptEvidence } from './npc-agent-loop.mjs'
import { FakeFactorio, planReply, recordingJev } from './task-loop-fixtures.mjs'

test('operation receipt evidence prefers restart-safe batch_ref and preserves identity diagnostics', () => {
  const evidence = receiptEvidence(JSON.stringify({
    task_state: 'idle',
    queue_length: 0,
    last_completed_batch: {
      batch_id: 42,
      batch_generation: 7,
      batch_ref: 'batch-g7-42',
      task_count: 2,
      task_types: ['placing', 'waiting'],
      tick: 900,
    },
  }), 'completed')

  assert.equal(evidence.ref, 'batch-g7-42')
  const summary = JSON.parse(evidence.summary)
  assert.equal(summary.batch_id, 42)
  assert.equal(summary.batch_generation, 7)
  assert.equal(summary.batch_ref, 'batch-g7-42')
})

test('operation receipt evidence keeps the legacy numeric fallback without inventing a generation', () => {
  const evidence = receiptEvidence(JSON.stringify({
    task_state: 'idle',
    queue_length: 0,
    last_completed_batch: {
      batch_id: 5,
      task_count: 1,
      task_types: ['mining'],
      tick: 901,
    },
  }), 'completed')

  assert.equal(evidence.ref, 'batch_5')
  const summary = JSON.parse(evidence.summary)
  assert.equal(summary.batch_id, 5)
  assert.equal(summary.batch_generation, undefined)
  assert.equal(summary.batch_ref, undefined)
})

test('stale basic operation result is quarantined when its type and tick belong to an older batch', () => {
  const evidence = receiptEvidence(JSON.stringify({
    task_state: 'idle',
    queue_length: 0,
    last_completed_batch: {
      batch_id: 12,
      task_count: 1,
      task_types: ['harvesting'],
      tick: 112865,
    },
    basic_operation: {
      last_result: {
        operation_id: 9,
        type: 'mining',
        accepted: true,
        completed: true,
        code: 'completed',
        tick: 112275,
        actor_id: 27,
        entity_name: 'coal',
      },
    },
  }), 'completed', { actor_id: 27, actor_epoch: 3, goal_id: 'goal_1', step_id: 'step_1' })

  const summary = JSON.parse(evidence.summary)
  assert.equal(summary.basic_operation, undefined)
  assert.equal(summary.stale_operation_result.code, 'stale_operation_result')
  assert.deepEqual(summary.stale_operation_result.reasons, ['task_type_mismatch', 'tick_mismatch'])
  assert.deepEqual(summary.correlation, {
    goal_id: 'goal_1',
    step_id: 'step_1',
    actor_id: 27,
    actor_epoch: 3,
  })
})

test('current basic operation result is retained only when batch type tick and actor correlate', () => {
  const correlated = correlateBasicOperationResult(
    { task_types: ['mining'], tick: 112275 },
    { operation_id: 9, type: 'mining', tick: 112275, actor_id: 27, completed: true, code: 'completed' },
    { actorId: 27 },
  )
  assert.equal(correlated.stale, undefined)
  assert.equal(correlated.result.operation_id, 9)
  assert.equal(correlated.result.actor_id, 27)
  assert.equal(correlated.result.tick, 112275)
})

test('result from a replaced actor is quarantined even when task type and tick match', () => {
  const correlated = correlateBasicOperationResult(
    { task_types: ['placing'], tick: 900 },
    { operation_id: 7, type: 'placing', tick: 900, actor_id: 26 },
    { actorId: 27 },
  )
  assert.equal(correlated.result, undefined)
  assert.deepEqual(correlated.stale.reasons, ['actor_mismatch'])
})

test('missing tick or actor identity fails closed instead of correlating an ambiguous result', () => {
  const correlated = correlateBasicOperationResult(
    { task_types: ['mining'], tick: 900 },
    { operation_id: 8, type: 'mining' },
    { actorId: 27 },
  )
  assert.equal(correlated.result, undefined)
  assert.deepEqual(correlated.stale.reasons, ['missing_tick_identity', 'missing_actor_identity'])
})

// Item 1.6 (steam-power run 2026-09-26): one refused move no longer cancels
// its independent siblings in the mod; the batch closes as refused with
// reason `<type>:<code>:<cause>` and the refusal receipt (held count, target
// slot contents) republished on the close tick. The cause must reach the
// behavior trace and the plan blocker, not only a bare nothing_moved.
function refusedFurnaceReceipt(game) {
  const tick = 600 + game.batchId
  game.cancelledBatch = {
    batch_id: game.batchId,
    task_count: game.lastTaskTypes.length,
    task_types: game.lastTaskTypes,
    tick,
    reason: 'moving_items:nothing_moved:input_slot_holds_other_item',
    outcome: 'refused',
    refused_count: 1,
    completed_count: game.lastTaskTypes.length - 1,
    refusals: [{ operation_id: 41, type: 'moving_items', code: 'nothing_moved', cause: 'input_slot_holds_other_item', item_name: 'iron-ore', target_unit_number: 55, held_count: 60, tick: tick - 1 }],
  }
  game.lastBasicResult = {
    operation_id: 41,
    type: 'moving_items',
    tick,
    actor_id: game.status.actor_id,
    accepted: false,
    completed: false,
    code: 'nothing_moved',
    item_name: 'iron-ore',
    entity_name: 'stone-furnace',
    requested_count: 20,
    moved_count: 0,
    to_entity: true,
    held_count: 60,
    refusal_cause: 'input_slot_holds_other_item',
    refusal_tick: tick - 1,
    batch_refused_count: 1,
    target_inventories: [
      { unit_number: 55, index: 1, name: 'fuel', role: 'fuel', slot_count: 1, empty_slots: 1, can_insert: false, contents: [] },
      { unit_number: 55, index: 2, name: 'crafter_input', role: 'input', slot_count: 1, empty_slots: 0, can_insert: false, contents: [{ name: 'copper-ore', quality: 'normal', count: 10 }] },
      { unit_number: 55, index: 3, name: 'crafter_output', role: 'output', slot_count: 1, empty_slots: 1, can_insert: false, contents: [] },
    ],
  }
  game.taskState = 'idle'
  game.queueLength = 0
  return 'moving_items refused: nothing_moved; cause=input_slot_holds_other_item item=iron-ore target=55 held=60 requested=20 slots=fuel[empty] crafter_input[copper-ore x10]; 1 of 2 operations refused, 1 completed; independent operations were not cancelled'
}

test('refusal cause is read only from a batch reason that names the same failing operation', () => {
  const basic = { type: 'moving_items', code: 'nothing_moved' }
  assert.equal(operationRefusalCause({ reason: 'moving_items:nothing_moved:input_slot_holds_other_item' }, basic), 'input_slot_holds_other_item')
  assert.equal(operationRefusalCause({ reason: 'moving_items:nothing_moved' }, basic), undefined)
  assert.equal(operationRefusalCause({ reason: 'placing:not_placeable:blocked' }, basic), undefined)
  assert.equal(operationRefusalCause({ reason: 'moving_items:nothing_moved:Bad Cause!' }, basic), undefined)
  assert.equal(operationRefusalCause({ reason: 'moving_items:nothing_moved:target_full' }, undefined), undefined)
})

test('a refused furnace supply reaches the behavior trace and the plan blocker with its cause, held count and slot contents', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-refusal-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const traceFile = path.join(dir, 'behavior.jsonl')
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) => questions.intent
    ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    : undefined)
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => planReply({
      plan: ['Load the furnaces with iron ore and coal'],
      operations: [
        { name: 'move_items', args: { item_name: 'iron-ore', entity_name: 'stone-furnace', max_count: 20, to_entity: true } },
        { name: 'move_items', args: { item_name: 'coal', entity_name: 'stone-furnace', max_count: 5, to_entity: true } },
      ],
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'refusal trace',
    stateFile: null,
    traceFile,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  await agent.request('load the furnaces', { sender: 'Louis' })
  assert.deepEqual(game.lastTaskTypes, ['moving_items', 'moving_items'])

  await agent.failed(refusedFurnaceReceipt(game))

  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const status = rows.filter(row => row.event === 'factorio.status').at(-1)
  assert.ok(status, 'factorio.status was not traced')
  assert.equal(typeof status.request_id, 'string')
  const result = status.data.task_status.basic_operation.last_result
  assert.equal(result.code, 'nothing_moved')
  assert.equal(result.refusal_cause, 'input_slot_holds_other_item')
  assert.equal(result.held_count, 60)
  assert.deepEqual(
    result.target_inventories.find(inventory => inventory.role === 'input').contents,
    [{ name: 'copper-ore', quality: 'normal', count: 10 }],
  )
  assert.equal(status.data.task_status.last_cancelled_batch.reason, 'moving_items:nothing_moved:input_slot_holds_other_item')

  const state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'transfer_failed:nothing_moved:input_slot_holds_other_item')
})
