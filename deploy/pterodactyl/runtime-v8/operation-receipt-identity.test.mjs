import assert from 'node:assert/strict'
import test from 'node:test'
import { correlateBasicOperationResult, receiptEvidence } from './npc-agent-loop.mjs'

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
