import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOperation, renderOperation } from '../staging/structured-policy.mjs'
import { verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'

test('gather_resource is a bounded approved operation with deterministic defaults', () => {
  const operation = parseOperation({
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20 },
  })

  assert.deepEqual(operation, {
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20, search_radius: 256 },
  })
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','gather_resource','iron-ore',20,256)",
  )
})

test('gather_resource rejects unbounded search radii', () => {
  assert.throws(() => parseOperation({
    name: 'gather_resource',
    args: { resource_name: 'iron-ore', count: 20, search_radius: 4097 },
  }))
})

test('completed gather_resource receipt proves its two internal tasks as one composite operation', () => {
  const state = {
    last_operations: [
      'gather_resource {"resource_name":"iron-ore","count":20,"search_radius":256}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 7,
      task_count: 2,
      task_types: ['walking_to_entity', 'mining'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: true,
    batchId: 7,
    taskTypes: ['walking_to_entity', 'mining'],
    operationNames: ['gather_resource'],
  })
})

test('multiple gather_resource operations can share one receipt and one model continuation', () => {
  const state = {
    last_operations: [
      'gather_resource {"resource_name":"iron-ore","count":20,"search_radius":512}',
      'gather_resource {"resource_name":"coal","count":10,"search_radius":512}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 8,
      task_count: 4,
      task_types: ['walking_to_entity', 'mining', 'walking_to_entity', 'mining'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: true,
    batchId: 8,
    taskTypes: ['walking_to_entity', 'mining', 'walking_to_entity', 'mining'],
    operationNames: ['gather_resource', 'gather_resource'],
  })
})

test('supply_entity is a bounded exact-identity multi-item operation', () => {
  const operation = parseOperation({
    name: 'supply_entity',
    args: {
      unit_number: 104,
      items: [
        { item_name: 'coal', count: 10 },
        { item_name: 'iron-ore', count: 10 },
      ],
    },
  })

  assert.deepEqual(operation, {
    name: 'supply_entity',
    args: {
      unit_number: 104,
      items: [
        { item_name: 'coal', count: 10 },
        { item_name: 'iron-ore', count: 10 },
      ],
    },
  })
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','supply_entity',104,{{item_name='coal',count=10},{item_name='iron-ore',count=10}})",
  )
})

test('supply_entity rejects duplicate items and more than eight item types', () => {
  assert.throws(() => parseOperation({
    name: 'supply_entity',
    args: {
      unit_number: 104,
      items: [
        { item_name: 'coal', count: 5 },
        { item_name: 'coal', count: 5 },
      ],
    },
  }))

  assert.throws(() => parseOperation({
    name: 'supply_entity',
    args: {
      unit_number: 104,
      items: Array.from({ length: 9 }, (_, index) => ({ item_name: `item-${index}`, count: 1 })),
    },
  }))
})

test('completed supply_entity receipt without positive-effect detail remains conservative', () => {
  const state = {
    last_operations: [
      'supply_entity {"unit_number":104,"items":[{"item_name":"coal","count":10},{"item_name":"iron-ore","count":10}]}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 9,
      task_count: 2,
      task_types: ['moving_items', 'moving_items'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: false,
    reason: 'transfer_effect_not_verified',
  })
})
