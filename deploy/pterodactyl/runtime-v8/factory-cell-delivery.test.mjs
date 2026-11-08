import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFactoryDelivery, factoryInputCoverage } from './factory-cell-delivery.mjs'
import { factoryNativeOutput } from './factory-cell-use.mjs'
import { factoryMetadataDigest as digest } from './factory-dependencies.mjs'

function fixture() {
  const member = unit => ({ unit_number: unit, name: `synthetic-${unit}`, position: { x: unit, y: 1 }, surface_index: 1, force_index: 1 })
  const cells = [1, 2].map(index => {
    const locator = member(index)
    const binding = { port_id: index === 1 ? 'out' : 'in', member: locator, endpoint: { kind: 'inventory', inventory_index: index }, state: 'unverified' }
    return { cell_id: `cell-${index}`, revision: 2, members: [locator], assignment: { products: ['synthetic-iron'] },
      ports: [{ port_id: binding.port_id, direction: index === 1 ? 'output' : 'input', kind: 'item', resource: 'synthetic-iron' }],
      port_bindings: [binding], metadata_history: [{ revision: 2, port_bindings: [structuredClone(binding)] }] }
  })
  const native = new Map(cells.map((cell, index) => [cell.cell_id, { members: [{ locator: cell.members[0], state: 'observed',
    recipe: { state: 'known', products: [{ type: 'item', name: 'synthetic-iron' }] },
    endpoint_facts: { schema_version: 1, inventories: { state: 'known', endpoints: [{ state: 'known', inventory_index: index + 1,
      roles: { state: 'known', values: [index === 0 ? 'output' : 'input'] } }] } },
    item_routes: { state: 'known', routes: [{ state: 'connected', kind: 'drop', target: cells[1].members[0] }] } }] }]))
  const dependency = { dependency_id: 'dependency-1', consumer: { cell_id: 'cell-2', port_id: 'in' }, supplier: { kind: 'cell', cell_id: 'cell-1', port_id: 'out' },
    delivery: { kind: 'direct' }, endpoint_bindings: Object.fromEntries(['supplier', 'consumer'].map((key, index) => [key, { cell_revision: 2, binding_digest: digest(cells[index].port_bindings[0]) }])) }
  return { cells, native, dependency, read: () => validateFactoryDelivery({ cells }, dependency, native, factoryNativeOutput) }
}

test('exact matched supplier and endpoints establish configured route, never delivered material from stored metadata', () => {
  const w = fixture(); const result = w.read()
  assert.equal(result.state, 'configured'); assert.equal(result.supplier_job, 'matched'); assert.equal(result.commissioning, 'unverified')
  w.cells[0].revision++
  assert.equal(w.read().state, 'configured', 'additive revision does not obsolete an unchanged exact endpoint')
  w.cells[0].port_bindings[0].endpoint.inventory_index++
  assert.equal(w.read().state, 'unverified')
})
test('wrong assigned material, removed member, unknown endpoint and manual/external/unresolved suppliers refuse automated delivery', () => {
  const wrong = fixture(); wrong.cells[0].ports[0].resource = 'synthetic-copper'; wrong.native.get('cell-1').members[0].recipe.products[0].name = 'synthetic-copper'
  assert.equal(wrong.read().state, 'mismatch')
  const removed = fixture(); removed.cells[0].members = []; assert.equal(removed.read().state, 'unverified')
  const unknown = fixture(); unknown.native.get('cell-2').members[0].endpoint_facts.inventories.state = 'unknown'; assert.equal(unknown.read().state, 'unverified')
  for (const kind of ['manual', 'external', 'unresolved']) {
    const w = fixture(); w.dependency.supplier = { kind }
    assert.equal(w.read().code, `supplier_${kind}`); assert.equal(w.read().state, 'unverified')
  }
})
test('cyclic declarations and empty graphs cannot establish delivered service or independence', () => {
  const w = fixture(); const cell = w.cells[1]
  const native = { members: [{ locator: cell.members[0], input_requirements: { material: { state: 'known', inputs: [{ kind: 'item', name: 'synthetic-iron' }] },
    fluid: { state: 'not_applicable', required: false }, fuel: { state: 'not_applicable', required: false }, power: { state: 'not_applicable', required: false } } }] }
  assert.equal(factoryInputCoverage(cell, native, []).state, 'incomplete')
  const cycle = [w.dependency, { ...w.dependency, dependency_id: 'dependency-2', consumer: w.dependency.supplier, supplier: { ...w.dependency.consumer, kind: 'cell' } }]
  const result = factoryInputCoverage(cell, native, cycle)
  assert.equal(result.state, 'declared'); assert.equal(result.commissioning, 'unverified'); assert.equal(result.independence, 'unverified')
  assert.equal(factoryInputCoverage(cell, { members: [] }, []).independence, 'not_established_by_empty_declarations')
})

test('input coverage binds each native member and normalizes electricity to power only', () => {
  const w = fixture(); const cell = w.cells[1]
  cell.ports[0] = { port_id: 'in', direction: 'input', kind: 'power' }
  cell.port_bindings[0].endpoint = { kind: 'electric_service' }
  const facts = { material: { state: 'not_applicable', required: false }, fluid: { state: 'not_applicable', required: false },
    fuel: { state: 'not_applicable', required: false }, power: { state: 'known', inputs: [{ kind: 'electricity' }] } }
  const first = { locator: cell.members[0], input_requirements: facts }
  const other = { locator: { ...cell.members[0], unit_number: 99 }, input_requirements: facts }
  const coverage = factoryInputCoverage(cell, { members: [first, other] }, [w.dependency])
  assert.equal(coverage.rows[0].state, 'declared')
  assert.equal(coverage.rows[1].state, 'unresolved', 'one member endpoint cannot cover another member')
  assert.equal(coverage.state, 'incomplete')
  first.input_requirements = { ...facts, power: { state: 'known', inputs: [{ kind: 'heat' }] } }
  assert.equal(factoryInputCoverage(cell, { members: [first] }, [w.dependency]).state, 'incomplete')
})
