import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { preservationGeometry } from './contract-obligations.mjs'
import { fluidPreservationMutationUnsafe } from './contract-obligation-runtime.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/run-bf-preservation.json', import.meta.url)))
test('BF A original eleven-operation proposal conflicts with its recorded item endpoint', () => {
  const operations = JSON.parse(fixture.a_reply.tool_calls[0].function.arguments).operations
  assert.equal(fluidPreservationMutationUnsafe(fixture.a_step.obligation_proof, operations), true)
})
test('BF B ordinary chest capture supports exact identity without preserving changing stock', () => {
  // Original type/unit from BF; missing implicit native payload is substituted
  // explicitly with a complete unchanged scope/geometry, not asserted historical.
  const raw = { found: true, entity: { unit_number: 30, name: 'wooden-chest', type: 'container', direction: 0,
    position: { x: 0.5, y: 0.5 } }, actor_id: 18, actor_surface_index: 1, actor_force_index: 1,
    surface_index: 1, force_index: 1, fluid_box_count: 0, fluid_storages_truncated: false }
  assert.equal(preservationGeometry(raw, 30).entity.unit_number, 30)
})
