import assert from 'node:assert/strict'
import test from 'node:test'
import { stockWorld, original } from './bg-stock-fixtures.mjs'
import { ao, aoWorld } from './run-ao-fixture.mjs'

test('historical AO replay keeps original inputs separate from synthetic factory evidence', async () => {
  const historical = structuredClone(ao)
  const w = await aoWorld()
  assert.deepEqual(ao, historical)
  const cell = w.memory.getFactoryRegistry().cells[0]
  assert.equal(cell.origin.source, 'synthetic_fixture')
  const member = cell.members[0]
  assert.equal(member.unit_number, 44)
  const receipt = w.memory.factoryPlacementReceipt(member.provenance.receipt_id)
  assert.equal(receipt.request_id, 'synthetic-historical-placement')
  assert.equal(receipt.world_id, w.game.factoryWorldId)
  assert.equal(w.game.factoryObservations.length > 0, true)
  assert.equal(w.game.mutations.length, 1)
  await w.close()
})

test('original BG iron supply is refused against a copper-only assigned native job', async () => {
  const historical = structuredClone(original)
  // Model the actual incompatible job separately from the dual-output
  // synthetic capability used to isolate stock-barrier lifecycle behavior.
  const w = stockWorld({ factoryCapability: { products: ['copper-plate'], ingredients: ['copper-ore'] } })
  await assert.rejects(w.start(), { failure_code: 'factory_cell_input_unproven' })
  assert.equal(w.game.mutations.length, 0, 'the entire original proposal remains unsent')
  assert.deepEqual(original, historical)
})

test('synthetic historical assignment and receipt cannot authorize a missing native member', async () => {
  const w = stockWorld({ initial: 1 })
  w.game.factoryMembers.delete(26)
  await assert.rejects(w.start(), { failure_code: 'factory_cell_resolution_required' })
  assert.equal(w.game.mutations.length, 0)
})
