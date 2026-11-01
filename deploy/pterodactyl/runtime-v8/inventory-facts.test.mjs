import assert from 'node:assert/strict'
import test from 'node:test'

import { parseInventoryCounts as handoffInventoryCounts } from './handoff-packet.mjs'
import { parseInventoryCounts } from './inventory-facts.mjs'

// tools.ts prints serpent.block(get_actor_inventory_items(actor)); inventory.ts maps
// each get_contents row to name/count, dropping quality but retaining duplicate names.
const NATIVE = '{\n  {\n    count = 14,\n    name = "iron-plate"\n  },\n  {\n    count = 1,\n    name = "boiler"\n  }\n}'

test('native Serpent inventory and supported JSON arrays return the same complete counts', () => {
  const expected = [['iron-plate', 14], ['boiler', 1]]
  assert.deepEqual([...parseInventoryCounts(NATIVE)], expected)
  assert.deepEqual([...parseInventoryCounts(JSON.stringify(expected.map(([name, count]) => ({ name, count }))))], expected)
  assert.deepEqual([...parseInventoryCounts('{ { name = "coal", count = 0 } }')], [['coal', 0]])
  for (const empty of ['{}', '{ \n }', '[]']) assert.equal(parseInventoryCounts(empty)?.size, 0)
})

test('quality rows whose native projection shares a name sum without losing safe integer precision', () => {
  assert.deepEqual([...parseInventoryCounts('{ { count = 3, name = "coal" }, { count = 2, name = "coal" } }')], [['coal', 5]])
  assert.deepEqual([...parseInventoryCounts('[{"name":"coal","count":3,"quality":"normal"},{"name":"coal","count":2,"quality":"uncommon"}]')], [['coal', 5]])
  assert.equal(parseInventoryCounts('[{"name":"coal","count":9007199254740991},{"name":"coal","count":1}]'), undefined)
})

for (const raw of [
  '', 'no controlled actor', 'no controlled actor\n{}', 'Error: {}',
  '{"error":"read_failed"}', '{"ok":false}', '{"found":false}', '{"items":[]}',
  '[null]', '[{}]', '[[]]', '[{"name":"coal"}]', '[{"name":"coal","count":"1"}]',
  '[{"name":"coal","count":-1}]', '[{"name":"coal","count":1.5}]',
  '[{"name":"coal","count":9007199254740992}]', '[{"name":"bad name","count":1}]',
  '[{"name":"coal","count":1},{"error":"partial"}]',
  '{ { count = 1, name = "coal" }',
  '{ { count = 1, name = "coal" }, { name = "iron-plate" } }',
  '{ { count = 1.5, name = "coal" } }',
  '{ { count = 1e3, name = "coal" } }',
  '{ { count = 1, name = "coal", error = "partial" } }',
  '{ { count = 1, name = "coal" } }\nError: read_failed',
  '{ { count = 9007199254740991, name = "coal" }, { count = 1, name = "coal" } }',
]) {
  test(`inventory fails closed for incomplete or invalid output: ${JSON.stringify(raw)}`, () => {
    assert.equal(parseInventoryCounts(raw), undefined)
  })
}

test('the historical handoff export is the shared parser and retains item-name bounds', () => {
  assert.equal(handoffInventoryCounts, parseInventoryCounts)
  const item = 'a'.repeat(100)
  assert.deepEqual([...parseInventoryCounts(JSON.stringify([{ name: item, count: 1 }]))], [[item, 1]])
  assert.equal(parseInventoryCounts(JSON.stringify([{ name: `${item}a`, count: 1 }])), undefined)
  assert.equal(parseInventoryCounts(undefined), undefined)
  assert.equal(parseInventoryCounts({}), undefined)
})
