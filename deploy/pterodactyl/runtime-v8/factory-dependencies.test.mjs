import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeFactoryDependency, validateFactoryDependencies, factoryConsumers, factoryDependencySummary } from './factory-dependencies.mjs'

const port = (port_id, direction, kind, resource) => ({ port_id, direction, kind, ...(resource === undefined ? {} : { resource }) })
const cell = (n, ports, products = [], extra = {}) => ({
  cell_id: `cell-${n}`, surface_index: 1, force_index: 1,
  assignment: { products, purpose: 'Owner-assigned fixture job', method: 'Read live facts before execution' },
  ports, ...extra,
})
const pair = (kind = 'item', resource = kind === 'power' ? undefined : 'fixture-material', supplierKind = kind) => [
  cell(1, [port('out', 'output', supplierKind, resource)], resource === undefined ? [] : [resource]),
  cell(2, [port('in', 'input', kind, resource)]),
]
const edge = (n = 1, consumer = 2, supplier = 1, extra = {}) => ({
  dependency_id: `dependency-${n}`,
  consumer: { cell_id: `cell-${consumer}`, port_id: 'in' },
  supplier: { kind: 'cell', cell_id: `cell-${supplier}`, port_id: 'out' },
  delivery: { kind: 'unknown' }, ...extra,
})

for (const [kind, resource, supplierKind, delivery] of [
  ['item', 'fixture-material', 'item', 'belt'],
  ['fuel', 'fixture-fuel', 'item', 'inserter'],
  ['fuel', 'fixture-fuel', 'fuel', 'direct'],
  ['fluid', 'fixture-fluid', 'fluid', 'fluid'],
  ['power', undefined, 'power', 'electric'],
]) test(`declares ${supplierKind} to ${kind} without promoting native supply`, () => {
  const cells = pair(kind, resource, supplierKind)
  const before = structuredClone(cells)
  const raw = edge(1, 2, 1, { delivery: { kind: delivery, reference: 'declared-route' }, evidence_refs: ['receipt-reference'] })
  const normalized = normalizeFactoryDependency(raw, cells)
  assert.equal(normalized.state, 'unverified')
  assert.deepEqual(normalized.evidence_refs, ['receipt-reference'])
  assert.deepEqual(cells, before)
  normalized.consumer.port_id = 'mutated'
  normalized.evidence_refs.push('mutated')
  assert.equal(raw.consumer.port_id, 'in')
  assert.deepEqual(raw.evidence_refs, ['receipt-reference'])
})

for (const supplier of [{ kind: 'manual', reference: 'operator-handoff' }, { kind: 'external', reference: 'unresolved-world-boundary' }, { kind: 'unresolved' }]) {
  test(`explicit ${supplier.kind} supplier retains unknown status`, () => {
    const normalized = normalizeFactoryDependency(edge(1, 2, 1, { supplier }), pair())
    assert.deepEqual(normalized.supplier, supplier)
    assert.equal(normalized.state, 'unverified')
  })
}

test('wrong resource, kind, assignment and world scope fail without changing cells', () => {
  for (const mutate of [
    cells => { cells[0].ports[0].resource = 'other'; cells[0].assignment.products = ['other'] },
    cells => { cells[0].ports[0].kind = 'fluid' },
    cells => { cells[0].assignment.products = ['other'] },
    cells => { cells[0].surface_index = 2 },
    cells => { cells[0].force_index = 2 },
    cells => { cells[0].surface_index = Number.NaN },
    cells => { cells[0].force_index = Infinity },
    cells => { cells[0].surface_index = 1.5 },
  ]) {
    const cells = pair(); mutate(cells)
    const before = structuredClone(cells)
    assert.throws(() => normalizeFactoryDependency(edge(), cells), TypeError)
    assert.deepEqual(cells, before)
  }
})

test('ports must be existing exact input/output references; item to fuel only is allowed', () => {
  for (const mutate of [
    raw => { raw.consumer.cell_id = 'cell-9' },
    raw => { raw.supplier.cell_id = 'cell-9' },
    raw => { raw.consumer.port_id = 'missing' },
    raw => { raw.supplier.port_id = 'missing' },
    raw => { raw.consumer = { cell_id: 'cell-1', port_id: 'out' } },
    raw => { raw.supplier = { kind: 'cell', cell_id: 'cell-2', port_id: 'in' } },
  ]) {
    const raw = edge(); mutate(raw)
    assert.throws(() => normalizeFactoryDependency(raw, pair()), TypeError)
  }
  assert.throws(() => normalizeFactoryDependency(edge(), pair('item', 'fixture-fuel', 'fuel')), /resource types differ/)
  const cells = pair('power', 'fake-electricity')
  assert.throws(() => normalizeFactoryDependency(edge(), cells), /cannot declare a commodity/)
})

test('delivery declarations respect port types and cannot carry capacity claims', () => {
  for (const [cells, delivery] of [[pair(), 'electric'], [pair(), 'fluid'], [pair('fluid', 'fixture-fluid'), 'belt'], [pair('fluid', 'fixture-fluid'), 'inserter']]) {
    assert.throws(() => normalizeFactoryDependency(edge(1, 2, 1, { delivery: { kind: delivery } }), cells), /incompatible/)
  }
  assert.throws(() => normalizeFactoryDependency(edge(1, 2, 1, { delivery: { kind: 'belt', capacity: 10 } }), pair()), /unsupported field/)
})

test('duplicate IDs and exact consumer-supplier edges are rejected atomically', () => {
  const cells = pair(); cells.push(cell(3, [port('out', 'output', 'item', 'fixture-material')], ['fixture-material']))
  assert.throws(() => validateFactoryDependencies([edge(), edge()], cells), /duplicate dependency ID/)
  assert.throws(() => validateFactoryDependencies([edge(), edge(2)], cells), /duplicate consumer and supplier edge/)
  assert.throws(() => validateFactoryDependencies([edge(), edge(2, 2, 1, { delivery: { kind: 'belt' }, evidence_refs: ['new-evidence'] })], cells), /duplicate consumer and supplier edge/)
  const external = edge(1, 2, 1, { supplier: { kind: 'external', reference: 'boundary' } })
  assert.throws(() => validateFactoryDependencies([external, { ...external, dependency_id: 'dependency-2' }], cells), /duplicate consumer and supplier edge/)
})

test('distinct declared suppliers can converge on one input and survive roundtrip and reverse queries', () => {
  const cells = pair(); cells.push(cell(3, [port('out', 'output', 'item', 'fixture-material')], ['fixture-material']))
  const raw = [edge(), edge(2, 2, 3),
    edge(3, 2, 1, { supplier: { kind: 'external', reference: 'boundary' } }),
    edge(4, 2, 1, { supplier: { kind: 'manual', reference: 'operator-handoff' } }),
    edge(5, 2, 1, { supplier: { kind: 'unresolved' } })]
  const deps = validateFactoryDependencies(raw, cells)
  assert.deepEqual(validateFactoryDependencies(JSON.parse(JSON.stringify(deps)), cells), deps)
  assert.deepEqual(factoryConsumers(deps, 'cell-1').direct_consumer_ids, ['cell-2'])
  assert.deepEqual(factoryConsumers(deps, 'cell-3').direct_consumer_ids, ['cell-2'])
  assert.equal(factoryDependencySummary(cells, deps, 'cell-2').inbound.length, 5)
  assert.ok(deps.every(dep => dep.state === 'unverified'))
})

test('reciprocal fuel loops and shared infrastructure have finite explicit impact', () => {
  const cells = [1, 2, 3, 4].map(n => cell(n, [port('in', 'input', 'fuel', 'fixture-fuel'), port('out', 'output', 'item', 'fixture-fuel')], ['fixture-fuel']))
  const deps = validateFactoryDependencies([edge(1, 2, 1), edge(2, 1, 2), edge(3, 3, 2), edge(4, 4, 1)], cells)
  const result = factoryConsumers(deps, 'cell-1')
  assert.equal(result.basis, 'declared_dependencies')
  assert.equal(result.state, 'unverified')
  assert.deepEqual(result.direct_consumer_ids, ['cell-2', 'cell-4'])
  assert.deepEqual(result.transitive_consumer_ids, ['cell-2', 'cell-3', 'cell-4'])
  assert.deepEqual(result.dependencies.map(dep => dep.dependency_id), ['dependency-1', 'dependency-4'])
  result.dependencies[0].consumer.cell_id = 'cell-999'
  assert.equal(deps[0].consumer.cell_id, 'cell-2')
  const summary = factoryDependencySummary(cells, deps, 'cell-1')
  assert.deepEqual(summary.inbound.map(dep => dep.dependency_id), ['dependency-2'])
  assert.deepEqual(summary.outbound.map(dep => dep.dependency_id), ['dependency-1', 'dependency-4'])
  summary.inbound[0].supplier.port_id = 'changed'
  assert.equal(deps[1].supplier.port_id, 'out')
})

test('reverse query does not claim registered existence; summary rejects stale references', () => {
  assert.deepEqual(factoryConsumers([], 'cell-1').transitive_consumer_ids, [])
  assert.throws(() => factoryDependencySummary(pair(), [], 'cell-3'), /does not exist/)
  const cells = pair(); cells[0].ports = []
  assert.throws(() => factoryDependencySummary(cells, [edge()], 'cell-2'), /port does not exist/)
  assert.throws(() => factoryDependencySummary(pair().slice(1), [edge()], 'cell-2'), /cell does not exist/)
})

test('malformed, sparse, accessor, unbounded and claimed verified data fail closed', () => {
  // Extending length intentionally leaves absent indices, not undefined values.
  const emptySlot = []; emptySlot.length = 1
  const middleHole = [edge()]; middleHole.length = 2; middleHole.push(edge(2))
  assert.equal(Object.hasOwn(emptySlot, 0), false)
  assert.equal(Object.hasOwn(middleHole, 1), false)
  const malformed = [
    null, [], { ...edge(), state: 'verified' }, { ...edge(), state: 'supplied' }, { ...edge(), state: undefined },
    { ...edge(), assigned_job: 'new job' }, { ...edge(), dependency_id: 'dependency-01' },
    { ...edge(), dependency_id: 'dependency-9007199254740992' },
    { ...edge(), consumer: { cell_id: 'cell-2', port_id: ' in' } },
    { ...edge(), supplier: { kind: 'unresolved', reference: 'hidden supplier' } },
    { ...edge(), supplier: { kind: 'cell', cell_id: 'cell-1', port_id: 'out', reference: 'extra' } },
    { ...edge(), supplier: { kind: 'external', reference: '' } },
    { ...edge(), supplier: { kind: 'external', reference: 'x'.repeat(1025) } },
    { ...edge(), evidence_refs: emptySlot }, { ...edge(), evidence_refs: ['same', 'same'] },
    { ...edge(), evidence_refs: ['x'.repeat(513)] },
    { ...edge(), evidence_refs: Array.from({ length: 33 }, (_, i) => `ref-${i}`) },
    JSON.parse('{"__proto__":{},"dependency_id":"dependency-1"}'),
    Object.assign(Object.create({ inherited: true }), edge()),
  ]
  const accessor = edge(); Object.defineProperty(accessor, 'state', { get() { throw new Error('must not invoke accessor') }, enumerable: true }); malformed.push(accessor)
  for (const raw of malformed) assert.throws(() => normalizeFactoryDependency(raw, pair()), TypeError)
  for (const raw of [emptySlot, middleHole, Object.assign([edge()], { extra: 1 }), Array.from({ length: 4097 }, () => edge())]) {
    assert.throws(() => validateFactoryDependencies(raw, pair()), TypeError)
    assert.throws(() => factoryConsumers(raw, 'cell-1'), TypeError)
  }
  const cells = pair(); cells[0].ports = emptySlot
  assert.throws(() => normalizeFactoryDependency(edge(), cells), TypeError)
  assert.throws(() => normalizeFactoryDependency(edge(), [...pair(), pair()[0]]), /duplicate cell ID/)
  const duplicatePorts = pair(); duplicatePorts[0].ports.push({ ...duplicatePorts[0].ports[0] })
  assert.throws(() => normalizeFactoryDependency(edge(), duplicatePorts), /duplicate port ID/)
})

test('prototype-like port names are exact safe map keys, not object properties', () => {
  const cells = pair(); cells[0].ports[0].port_id = '__proto__'; cells[1].ports[0].port_id = 'constructor'
  const raw = edge(); raw.supplier.port_id = '__proto__'; raw.consumer.port_id = 'constructor'
  assert.equal(normalizeFactoryDependency(raw, cells).consumer.port_id, 'constructor')
})
