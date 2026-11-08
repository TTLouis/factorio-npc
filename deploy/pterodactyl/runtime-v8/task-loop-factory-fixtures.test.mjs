import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeFactorio } from './task-loop-fixtures.mjs'
import { buildPendingOperation } from './operation-reconciliation.mjs'
import { deriveFactoryPlacementReceipt } from './factory-placement-provenance.mjs'

const statusCommand = '/silent-command remote.call("autorio_operations","status")'
const observe = request => `/silent-command remote.call('sgluna_factory','observe',helpers.json_to_table('${JSON.stringify(request)}'))`

test('synthetic native actor and world facts follow mutable engine owner, not requested identity', async () => {
  const game = new FakeFactorio()
  Object.assign(game.status, { actor_id: 42, surface_index: 2, force_index: 3 })
  const actor = JSON.parse(await game.command('remote.call("autorio_actor","status")'))
  assert.equal(actor.actor.actor_id, 42); assert.equal(actor.surface_index, 2); assert.equal(actor.force_index, 3)
  const request = { schema_version: 1, world_id: game.factoryWorldId, actor_id: 18, surface_index: 2, force_index: 3, members: [] }
  assert.equal(JSON.parse(await game.command(observe(request))).ok, false)
  request.actor_id = 42
  assert.equal(JSON.parse(await game.command(observe(request))).ok, true)
})

test('factory observation requires exact scripted native member; capability is never inferred', async () => {
  const game = new FakeFactorio()
  const locator = { unit_number: 7, name: 'synthetic-machine', position: { x: 1, y: 2 }, surface_index: 1, force_index: 1 }
  const request = { schema_version: 1, world_id: game.factoryWorldId, actor_id: 18, surface_index: 1, force_index: 1, members: [locator] }
  assert.equal(JSON.parse(await game.command(observe(request))).members[0].state, 'unknown')
  game.factoryMembers.set(7, { locator, state: 'observed', recipe: { state: 'unsupported' } })
  const row = JSON.parse(await game.command(observe(request))).members[0]
  assert.equal(row.state, 'observed'); assert.equal(row.recipe.state, 'unsupported')
  request.members = [{ ...locator, position: { x: 9, y: 2 } }]
  assert.equal(JSON.parse(await game.command(observe(request))).members[0].state, 'unknown')
})

test('new exact scripted placement yields correlated provenance, but stale or missing custody never does', async () => {
  const game = new FakeFactorio()
  const operation = { name: 'place_entity', args: { entity_name: 'synthetic-machine', x: 1, y: 2 } }
  const pending = buildPendingOperation({ requestId: 'placement-request', ordinal: 1, protocolVersion: 2, actor: { actor_id: 18, epoch: 3 },
    goalId: 'goal', planId: 'plan', stepId: 'step', surfaceIndex: 1, baseline: { generation: 1, max_batch_id: 0 }, operations: [operation] })
  const identity = { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
    actor_id: 18, epoch: 3, ordinal: 1, operation_count: 1 }
  game.onMutation = () => {
    game.lastBasicResult = { operation_id: 1, tick: 601, actor_id: 18, type: 'placing', code: 'completed', accepted: true, completed: true,
      entity_name: 'synthetic-machine', placed_unit_number: 7, placed_position: { x: 1, y: 2 }, placed_surface_index: 1 }
  }
  await game.command(`local ok,result=pcall "authorize" "begin",helpers.json_to_table(${JSON.stringify(JSON.stringify(identity))}) return remote.call('autorio_operations','place_entity') SGLUNA_RESULT_aaaaaaaaaaaaaaaaaaaaaaaa:`)
  const context = { world_id: game.factoryWorldId, actor: { actor_id: 18, epoch: 3 }, candidates: [{ pending, plan_version: 1, semantic_step_id: 'semantic' }] }
  const status = JSON.parse(await game.command(statusCommand))
  assert.equal(deriveFactoryPlacementReceipt(status, context)?.unit_number, 7)
  delete game.lastBasicResult.placed_world_id
  assert.equal(deriveFactoryPlacementReceipt(JSON.parse(await game.command(statusCommand)), context), undefined, 'polling cannot refill missing custody')
  assert.equal(deriveFactoryPlacementReceipt(status, { ...context, actor: { actor_id: 99, epoch: 3 } }), undefined)
  assert.equal(deriveFactoryPlacementReceipt(status, { ...context, candidates: [{ pending: { ...pending, signature: 'b'.repeat(64) }, plan_version: 1, semantic_step_id: 'semantic' }] }), undefined)
})

test('base native receipt journal does not overwrite a derived engine completed-batch history', async () => {
  const game = new FakeFactorio()
  const history = [{ batch_id: 99 }]
  game.completedBatches = history
  game.batchId = 1
  game.lastTaskTypes = ['gathering']
  const status = JSON.parse(await game.command(statusCommand))
  assert.equal(game.completedBatches, history)
  assert.deepEqual(history, [{ batch_id: 99 }])
  assert.equal(status.receipt_journal.length, 1)
  assert.equal(status.receipt_journal[0].batch_id, 1)
})

test('synthetic native journal retains bounded exact cancellation history without repairing damaged receipts', async () => {
  const game = new FakeFactorio()
  game.lastTaskTypes = ['placing']
  for (let batch = 1; batch <= 65; batch++) {
    game.batchId = batch
    game.failLastBatch({ type: 'placing', code: 'no_position' }, undefined, { failedTaskIndex: 0 })
    if (batch === 64) delete game.cancelledBatch.failed_task_index
    if (batch === 65) game.cancelledBatch.batch_ref = 'mismatched-ref'
  }
  const status = JSON.parse(await game.command(statusCommand))
  assert.equal(status.receipt_journal.length, 64)
  assert.equal(status.receipt_journal[0].batch_id, 2)
  assert.equal(status.receipt_journal.find(row => row.batch_id === 64).failed_task_index, undefined)
  assert.equal(status.receipt_journal.find(row => row.batch_id === 65).batch_ref, 'mismatched-ref')
  assert.ok(status.receipt_journal.every(row => row.state === 'cancelled'))
})
