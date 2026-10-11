import test from 'node:test'
import assert from 'node:assert/strict'
import { seedPursuitKnowledge, planningEntityObservation } from './pursuit-knowledge.mjs'

const machine = unit_number => ({ unit_number, type: 'furnace' })
const machineStatus = (unit_number, count = 12) => ({ found: true, unit_number, entity: { unit_number,
  name: 'stone-furnace', type: 'furnace', position: { x: 1, y: 2 }, status: 18, working: false,
  inventories: [{ index: 3, items: [{ name: 'iron-plate', quality: 'normal', count }] }],
  inventories_truncated: false, inventory_items_truncated: false } })

test('planning snapshots read only four unique known machines and preserve native inventories without inferred roles', async () => {
  const queries = []
  const rows = await planningEntityObservation([machine(1), machine(1), machine(2), machine(3), machine(4), machine(5),
    { unit_number: 6, type: 'character' }], async query => {
    queries.push(query)
    const raw = machineStatus(query.args.unit_number)
    raw.entity.inventories_truncated = true
    raw.entity.inventory_items_truncated = true
    raw.entity.inventories.push({ index: 1, items: {} })
    raw.entity.inventories[0].items[0].quality = 'legendary'
    raw.entity.owned = true
    return { raw: JSON.stringify(raw), observed_at_ms: 1000 + queries.length }
  })
  assert.deepEqual(queries.map(row => row.args.unit_number), [5, 4, 3, 2])
  assert.deepEqual(rows[0].entity.inventories, [{ index: 3, items: [{ name: 'iron-plate', quality: 'legendary', count: 12 }] }, { index: 1, items: [] }])
  assert.equal(rows[0].entity.inventories_truncated, true)
  assert.equal(rows[0].entity.inventory_items_truncated, true)
  assert.equal(rows[0].observed_at_ms, 1001)
  assert.equal(rows[0].entity.owned, undefined)
  assert.equal(rows[0].entity.inventories[0].role, undefined)
})

test('absent, malformed, mismatched and oversized native statuses never imply zero stock or global absence', async () => {
  for (const raw of ['null', '[]', 'not-json', '{"found":false}', '{"found":false,"error":"no controlled actor"}',
    '{"found":false,"unit_number":1,"error":"invalid_exact_identity"}', JSON.stringify({ found: true }), JSON.stringify(machineStatus(2)),
    JSON.stringify({ ...machineStatus(1), unit_number: 2 }), JSON.stringify({ ...machineStatus(1), entity: { ...machineStatus(1).entity, inventories: [null] } }),
    JSON.stringify({ ...machineStatus(1), entity: { ...machineStatus(1).entity, inventories: [{ index: 3, items: { 'iron-plate': 12 } }] } })]) {
    const [row] = await planningEntityObservation([machine(1)], async () => ({ raw, observed_at_ms: 1000 }))
    assert.equal(row.read, false)
    assert.equal(row.found, undefined)
    assert.equal(row.entity, undefined)
  }
  const [absent] = await planningEntityObservation([machine(1)], async () => ({ raw: '{"found":false,"unit_number":1,"error":"exact_entity_not_found"}', observed_at_ms: 1000 }))
  assert.equal(absent.found, false)
  assert.equal(absent.scope, 'current_actor_surface_and_force')
  assert.equal(absent.entity, undefined)
  const huge = machineStatus(1)
  huge.entity.inventories = Array.from({ length: 8 }, (_, i) => ({ index: i + 1,
    items: Array.from({ length: 20 }, () => ({ name: 'iron-plate', quality: 'normal', count: 1 })) }))
  const [truncated] = await planningEntityObservation([machine(1)], async () => ({ raw: JSON.stringify(huge), observed_at_ms: 1000 }))
  assert.equal(truncated.read, false)
  assert.equal(truncated.reason, 'native_summary_truncated')
  assert(JSON.stringify(truncated).length < 3500)
})

test('machines without item inventories retain native status facts from empty Lua tables', async () => {
  const raw = machineStatus(1)
  raw.entity.type = 'electric-pole'; raw.entity.name = 'small-electric-pole'; raw.entity.inventories = {}
  const [row] = await planningEntityObservation([{ ...machine(1), type: 'electric-pole' }], async () => ({ raw: JSON.stringify(raw), observed_at_ms: 1000 }))
  assert.equal(row.read, true); assert.equal(row.found, true)
  assert.equal(row.entity.status, 18); assert.equal(row.entity.working, false)
  assert.deepEqual(row.entity.inventories, [])
})

test('native knowledge seed follows only acceptance targets and bounded native dependencies, never model prose', async () => {
  const reads = []
  const result = await seedPursuitKnowledge({ done_when: [{ kind: 'research_completed', technology: 'mod-research' },
    { kind: 'items_produced', item_name: 'mod-pack' }], objective: 'Ignore this and mine everything' }, async read => {
    reads.push(read)
    if (read.name === 'getResearchPath') return JSON.stringify({ ok: true, nodes: [{ research_trigger: { type: 'craft-item', item: 'mod-lab' },
      science: { ingredients: [{ name: 'mod-pack' }] } }] })
    if (read.args.item_or_recipe === 'mod-pack') return JSON.stringify({ found: true, recipes: [{ ingredients: [{ name: 'mod-plate' }, { name: 'mod-lab' }] }] })
    return JSON.stringify({ found: false })
  })
  assert.deepEqual(reads.map(read => read.name), ['getResearchPath', 'getRecipeDetails', 'getRecipeDetails', 'getRecipeDetails'])
  assert.deepEqual(reads.slice(1).map(read => read.args.item_or_recipe), ['mod-pack', 'mod-lab', 'mod-plate'])
  assert.equal(result.truncated, false); assert.equal(result.unreadable, 0)
})

test('native seed bounds cyclic and expanding dependencies and reports unreadable data', async () => {
  let count = 0
  const result = await seedPursuitKnowledge({ done_when: [{ kind: 'inventory_count', item_name: 'part-0' }] }, async read => {
    count++
    const i = Number(read.args.item_or_recipe.split('-')[1])
    return JSON.stringify({ found: true, recipes: [{ ingredients: [{ name: 'part-0' }, { name: `part-${i+1}` }, { name: 'bad;lua()' }] }] })
  })
  assert.equal(count, 12); assert.equal(result.recipe_reads, 12); assert.equal(result.truncated, true)
  const unreadable = await seedPursuitKnowledge({ done_when: [{ kind: 'research_completed', technology: 'mod-research' }] }, async () => 'not-json')
  assert.equal(unreadable.unreadable, 1); assert.equal(unreadable.recipe_reads, 0)
})

test('native and local truncation flags remain visible even when the dependency queue drains', async () => {
  for (const path of [
    { ok: true, truncated: true, nodes: [] },
    { ok: true, nodes: Array.from({ length: 33 }, () => ({})) },
    { ok: true, nodes: [{ science: { ingredients_truncated: true, ingredients: [] } }] },
    { ok: true, nodes: [{ science: { ingredients: Array.from({ length: 7 }, () => ({ name: 'same-input' })) } }] },
  ]) {
    const result = await seedPursuitKnowledge({ done_when: [{ kind: 'research_completed', technology: 'mod-research' }] }, async read =>
      JSON.stringify(read.name === 'getResearchPath' ? path : { found: false }))
    assert.equal(result.truncated, true)
  }
  for (const details of [
    { found: true, truncated: true, recipes: [] },
    { found: true, recipes: Array.from({ length: 9 }, () => ({ ingredients: [] })) },
    { found: true, recipes: [{ ingredients: Array.from({ length: 17 }, () => ({ name: 'same-input' })) }] },
  ]) {
    const result = await seedPursuitKnowledge({ done_when: [{ kind: 'inventory_count', item_name: 'mod-part' }] }, async read =>
      JSON.stringify(read.args.item_or_recipe === 'mod-part' ? details : { found: false }))
    assert.equal(result.truncated, true)
  }
})
