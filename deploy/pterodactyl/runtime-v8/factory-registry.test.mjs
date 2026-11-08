import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createFactoryRegistry, FACTORY_REGISTRY_LIMITS, FactoryRegistryError, findFactoryCellByMember,
  findFactoryCellsByProduct, getFactoryCell, listFactoryCells, observeFactoryCell,
  registerFactoryCell, registerFactoryDependency, restoreFactoryRegistry,
} from './factory-registry.mjs'

function declaration(unit = 1, product = 'declared-product', scope = {}) {
  const surface_index = scope.surface_index ?? 1
  const force_index = scope.force_index ?? 1
  const origin = { source: 'placement_receipt', goal_id: 'historical-goal', plan_id: 'historical-plan', plan_version: 2, semantic_step_id: 'historical-step', request_id: 'historical-request', actor_id: 18, actor_epoch: 3, tick: 100 }
  return {
    surface_index, force_index,
    assignment: { products: [product], purpose: 'Keep the owner-assigned production job', method: 'Use the declared native production process' },
    ports: [
      { port_id: 'product-out', direction: 'output', kind: 'item', resource: product },
      { port_id: 'material-in', direction: 'input', kind: 'item', resource: 'declared-product' },
      { port_id: 'fuel-in', direction: 'input', kind: 'fuel', resource: 'declared-fuel' },
      { port_id: 'power-in', direction: 'input', kind: 'power' },
    ],
    members: [{ unit_number: unit, name: 'fixture-production-entity', position: { x: unit * 3, y: 4 }, surface_index, force_index, provenance: { ...origin, receipt_id: `receipt-${unit}` } }],
    origin,
  }
}

const empty = () => createFactoryRegistry('world-fixture')
const first = () => registerFactoryCell(empty(), declaration())
const dependency = (supplier = { kind: 'external', reference: 'owner material supply' }) => ({ consumer: { cell_id: 'cell-1', port_id: 'material-in' }, supplier, delivery: { kind: 'unknown' } })
const fault = (action, code) => assert.throws(action, error => error instanceof FactoryRegistryError && (!code || error.code === code))

test('registry binds explicitly to a world; only absent legacy data creates empty state', () => {
  assert.deepEqual(restoreFactoryRegistry(undefined, { worldId: 'world-fixture' }), empty())
  for (const invalid of [null, false, {}, [], '', { ...empty(), schema_version: 2 }]) fault(() => restoreFactoryRegistry(invalid))
  fault(() => restoreFactoryRegistry(undefined))
  fault(() => createFactoryRegistry(''))
  fault(() => restoreFactoryRegistry(first(), { worldId: 'other-world' }), 'world_mismatch')
})

test('declarations, observations and read results cannot mutate jobs or historical origin', () => {
  const input = declaration()
  const registry = registerFactoryCell(empty(), input)
  const before = structuredClone(registry)
  input.assignment.products[0] = 'forged-product'
  input.members[0].position.x = 999
  const observed = observeFactoryCell(registry, 'cell-1', { source: 'native_inventory_sample', products: ['incidental-product'], tick: 200, evidence_refs: ['sample-1'] })
  assert.deepEqual(registry, before)
  assert.deepEqual(observed.cells[0].assignment.products, ['declared-product'])
  assert.deepEqual(observed.cells[0].observation.products, ['incidental-product'])
  assert.equal(observed.cells[0].state, 'unverified')
  assert.equal(observed.cells[0].revision, 1)
  assert.equal(observed.revision, 2)
  assert.equal(findFactoryCellsByProduct(observed, 'incidental-product').length, 0)
  assert.equal(findFactoryCellsByProduct(observed, 'declared-product').length, 1)
  const reads = [listFactoryCells(observed)[0], getFactoryCell(observed, 'cell-1'), findFactoryCellsByProduct(observed, 'declared-product')[0]]
  for (const result of reads) {
    result.origin.goal_id = 'current-goal'
    result.assignment.products.push('unexpected')
    result.members[0].provenance.actor_epoch = 999
  }
  assert.deepEqual(observed.cells[0].origin, before.cells[0].origin)
  assert.deepEqual(observed.cells[0].assignment, before.cells[0].assignment)
  assert.equal(observed.cells[0].members[0].provenance.actor_epoch, 3)
  for (const bad of [{ products: [], source: 'test', state: 'verified' }, { products: [], source: 'test', commissioned: true }, { products: [], source: 'test', assignment: {} }]) fault(() => observeFactoryCell(registry, 'cell-1', bad))
  fault(() => observeFactoryCell(registry, 'cell-999', { products: [], source: 'test' }), 'unknown_cell')
})

test('new goal origin is history and never transfers or erases an existing production assignment', () => {
  const prior = first()
  const next = declaration(2, 'new-product')
  next.origin.goal_id = 'new-goal'
  next.origin.plan_id = 'new-plan'
  next.origin.actor_epoch = 4
  const current = registerFactoryCell(prior, next)
  assert.deepEqual(current.cells[0], prior.cells[0])
  assert.equal(current.cells[1].cell_id, 'cell-2')
  assert.equal(current.next_cell_id, 3)
  assert.equal(current.revision, 2)
  const restored = restoreFactoryRegistry(JSON.parse(JSON.stringify(current)), { worldId: 'world-fixture' })
  assert.deepEqual(restored, current)
  restored.cells[0].members[0].position.x = 0
  assert.equal(current.cells[0].members[0].position.x, 3)
})

test('exact scoped membership lookup refuses underspecified and stale aliases', () => {
  const registry = first()
  const locator = { world_id: 'world-fixture', surface_index: 1, force_index: 1, unit_number: 1 }
  assert.equal(findFactoryCellByMember(registry, locator).cell_id, 'cell-1')
  for (const field of ['world_id', 'surface_index', 'force_index', 'unit_number']) {
    const partial = { ...locator }
    delete partial[field]
    fault(() => findFactoryCellByMember(registry, partial))
  }
  for (const mismatch of [{ world_id: 'other-world' }, { surface_index: 2 }, { force_index: 2 }, { unit_number: 2 }, { name: 'different' }, { position: { x: 0, y: 4 } }]) assert.equal(findFactoryCellByMember(registry, { ...locator, ...mismatch }), null)
  const match = findFactoryCellByMember(registry, locator)
  match.assignment.products.length = 0
  assert.equal(registry.cells[0].assignment.products.length, 1)
})

test('exclusive membership rejects duplicate native unit, duplicate locator and cross-scope relabeling', () => {
  const registry = first()
  fault(() => registerFactoryCell(registry, declaration(1, 'other-product')), 'duplicate_assignment')
  fault(() => registerFactoryCell(registry, declaration(1, 'other-product', { surface_index: 2 })), 'duplicate_assignment')
  const duplicateLocator = declaration(2)
  duplicateLocator.members[0].position = { ...registry.cells[0].members[0].position }
  fault(() => registerFactoryCell(registry, duplicateLocator), 'duplicate_assignment')
  const mismatch = declaration(2)
  mismatch.members[0].force_index = 2
  fault(() => registerFactoryCell(registry, mismatch), 'scope_mismatch')
  const repeatedMember = declaration()
  repeatedMember.members.push(structuredClone(repeatedMember.members[0]))
  fault(() => registerFactoryCell(empty(), repeatedMember), 'duplicate_assignment')
  assert.deepEqual(registry, first())
})

test('cell declarations reject supplied identities, authority claims, missing provenance and incoherent ports', () => {
  for (const bad of [
    { ...declaration(), cell_id: 'cell-50' },
    { ...declaration(), revision: 2 },
    { ...declaration(), state: 'verified' },
    { ...declaration(), origin: { source: 'test', authorized: true } },
    { ...declaration(), members: [] },
    { ...declaration(), assignment: { ...declaration().assignment, products: [] } },
  ]) fault(() => registerFactoryCell(empty(), bad))
  const missingProvenance = declaration()
  delete missingProvenance.members[0].provenance
  fault(() => registerFactoryCell(empty(), missingProvenance))
  const duplicatePort = declaration()
  duplicatePort.ports.push({ ...duplicatePort.ports[0] })
  fault(() => registerFactoryCell(empty(), duplicatePort), 'duplicate_port')
  const unassignedOutput = declaration()
  unassignedOutput.ports[0].resource = 'not-assigned'
  fault(() => registerFactoryCell(empty(), unassignedOutput), 'assignment_mismatch')
})

test('dependency reducer allocates durable IDs, preserves defensive data and rejects dangling edges', () => {
  const base = first()
  const input = dependency()
  const connected = registerFactoryDependency(base, input)
  assert.equal(connected.dependencies[0].dependency_id, 'dependency-1')
  assert.equal(connected.dependencies[0].state, 'unverified')
  assert.equal(connected.next_dependency_id, 2)
  assert.equal(connected.revision, 2)
  assert.equal(base.dependencies.length, 0)
  input.supplier.reference = 'changed'
  assert.equal(connected.dependencies[0].supplier.reference, 'owner material supply')
  fault(() => registerFactoryDependency(connected, dependency()))
  fault(() => registerFactoryDependency(base, { ...dependency(), dependency_id: 'dependency-99' }))
  fault(() => registerFactoryDependency(base, { ...dependency(), consumer: { cell_id: 'cell-999', port_id: 'material-in' } }), 'invalid_dependency')
  fault(() => registerFactoryDependency(base, { ...dependency(), consumer: { cell_id: 'cell-1', port_id: 'absent' } }), 'invalid_dependency')
  fault(() => registerFactoryDependency(base, dependency({ kind: 'cell', cell_id: 'cell-999', port_id: 'product-out' })), 'invalid_dependency')
  assert.deepEqual(restoreFactoryRegistry(JSON.parse(JSON.stringify(connected))), connected)
})

test('cross-cell declared dependency cycles are representable without claiming readiness', () => {
  let state = registerFactoryCell(first(), declaration(2))
  state = registerFactoryDependency(state, dependency({ kind: 'cell', cell_id: 'cell-2', port_id: 'product-out' }))
  state = registerFactoryDependency(state, { ...dependency({ kind: 'cell', cell_id: 'cell-1', port_id: 'product-out' }), consumer: { cell_id: 'cell-2', port_id: 'material-in' } })
  assert.equal(state.dependencies.length, 2)
  assert.ok(state.dependencies.every(value => value.state === 'unverified'))
  assert.deepEqual(restoreFactoryRegistry(state), state)
})

test('power-only cells declare a service without inventing a material product', () => {
  const power = declaration(2)
  power.assignment.products = []
  power.ports = [{ port_id: 'electric-out', direction: 'output', kind: 'power' }]
  let state = registerFactoryCell(first(), power)
  state = registerFactoryDependency(state, { consumer: { cell_id: 'cell-1', port_id: 'power-in' }, supplier: { kind: 'cell', cell_id: 'cell-2', port_id: 'electric-out' }, delivery: { kind: 'electric' } })
  state = registerFactoryDependency(state, { consumer: { cell_id: 'cell-1', port_id: 'power-in' }, supplier: { kind: 'external', reference: 'owner power supply' }, delivery: { kind: 'electric' } })
  assert.deepEqual(state.cells[1].assignment.products, [])
  assert.equal(state.dependencies.length, 2)
  assert.deepEqual(restoreFactoryRegistry(JSON.parse(JSON.stringify(state))), state)
  const noJob = declaration(3)
  noJob.assignment.products = []
  noJob.ports = [{ port_id: 'electric-in', direction: 'input', kind: 'power' }]
  fault(() => registerFactoryCell(state, noJob), 'assignment_mismatch')
})

test('schema validation rejects accessors and hidden data without evaluating supplied getters', () => {
  let called = false
  const accessor = declaration()
  Object.defineProperty(accessor, 'assignment', { enumerable: true, get() { called = true; throw new Error('Getter evaluated') } })
  fault(() => registerFactoryCell(empty(), accessor), 'invalid_schema')
  assert.equal(called, false)
  const hidden = declaration()
  Object.defineProperty(hidden, 'proof', { value: 'verified', enumerable: false })
  fault(() => registerFactoryCell(empty(), hidden), 'invalid_schema')
  const symbol = declaration()
  symbol[Symbol('proof')] = 'verified'
  fault(() => registerFactoryCell(empty(), symbol), 'invalid_schema')
  const extraArrayField = declaration()
  extraArrayField.members.extra = true
  fault(() => registerFactoryCell(empty(), extraArrayField), 'invalid_schema')
  const arrayAccessor = declaration()
  Object.defineProperty(arrayAccessor.members, '0', { enumerable: true, get() { called = true; throw new Error('Getter evaluated') } })
  fault(() => registerFactoryCell(empty(), arrayAccessor), 'invalid_schema')
  assert.equal(called, false)
})

test('whole-registry restore rejects corruption instead of silently evicting or clearing assets', () => {
  const base = registerFactoryDependency(first(), dependency())
  const corruptions = [
    value => { value.cells.push(structuredClone(value.cells[0])) },
    value => { value.cells[0].members[0].position.x = Infinity },
    value => { value.cells[0].members[0].provenance.actor_epoch = -1 },
    value => { value.cells[0].cell_id = 'cell-01' },
    value => { value.cells[0].cell_id = 'cell-9007199254740992' },
    value => { value.cells[0].revision = 2 },
    value => { value.cells[0].state = 'commissioned' },
    value => { value.next_cell_id = 1 },
    value => { value.next_dependency_id = 1 },
    value => { value.next_cell_id = 100 },
    value => { value.revision = 1 },
    value => { value.revision = Number.MAX_SAFE_INTEGER + 1 },
    value => { value.dependencies[0].consumer.cell_id = 'cell-999' },
    value => { value.dependencies[0].dependency_id = 'dependency-0' },
    value => { value.dependencies.push(structuredClone(value.dependencies[0])) },
    value => { value.dependencies[0].state = 'verified' },
    value => { value.cells[0].assignment.products.push('declared-product') },
    value => { value.cells = [undefined]; delete value.cells[0] },
  ]
  for (const corrupt of corruptions) {
    const candidate = structuredClone(base)
    corrupt(candidate)
    fault(() => restoreFactoryRegistry(candidate))
  }
  assert.deepEqual(base, registerFactoryDependency(first(), dependency()))
})

test('bounded capacity and arithmetic exhaustion fail without deleting prior state', () => {
  const oversized = declaration()
  oversized.members = Array.from({ length: FACTORY_REGISTRY_LIMITS.members + 1 }, (_, index) => declaration(index + 1).members[0])
  fault(() => registerFactoryCell(empty(), oversized))
  const registry = first()
  registry.revision = Number.MAX_SAFE_INTEGER
  fault(() => observeFactoryCell(registry, 'cell-1', { products: [], source: 'test' }), 'counter_exhausted')
  fault(() => registerFactoryCell(registry, declaration(2)), 'counter_exhausted')
  const counter = empty()
  counter.revision = Number.MAX_SAFE_INTEGER - 1
  counter.next_cell_id = Number.MAX_SAFE_INTEGER
  fault(() => registerFactoryCell(counter, declaration()), 'counter_exhausted')
  const reserved = { ...first(), next_cell_id: 9, revision: 8 }
  const allocated = registerFactoryCell(reserved, declaration(2))
  assert.equal(allocated.cells[1].cell_id, 'cell-9', 'reserved identities are never reused')
  assert.equal(allocated.next_cell_id, 10)
})
