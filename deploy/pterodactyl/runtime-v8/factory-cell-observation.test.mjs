import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { createFactoryCellObserver, FACTORY_OBSERVATION_LIMITS } from './factory-cell-observation.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

const KEY = 'factory-observer-test'
const WORLD = '1e837e91-4f33-43a2-a3aa-c891ee06ec66'
const OTHER = '1e837e91-4f33-43a2-a3aa-c891ee06ec67'
const clone = value => structuredClone(value)
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code)

function setup({ resource = 'copper-ore', nativeWorld = WORLD } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, { sender: 'owner', text: 'Make copper using the committed method' }, {
    chatMessage: 'Build the assigned production', plan: ['Build assigned cell'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', confidence: 0.9,
      requirements: [{ id: 'stock', kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] } }],
    executionGuidance: [{ approach: 'Direct native feeding', rationale: 'Keep the selected supply method', constraints: [], skillIds: [], materialSupply: { mode: 'direct_feed', resource } }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const context = { surface_index: 1, force_index: 1, actor_id: 24, actor_epoch: 2,
    request_id: 'request-1', session_id: 'session-1', native_idle: true, pending: false, uncertain: false }
  const receipts = new Map(); const events = []; const calls = []
  const w = { memory, context, receipts, events, calls, nativeWorld, tick: 100, hook: undefined, bodyMutate: undefined }
  memory.traceSink = (name, body) => events.push({ name, ...body })
  w.observer = createFactoryCellObserver({ memory, key: KEY,
    readContext: () => ({ world_id: memory.factoryWorldBinding().world_id, ...context }),
    readPlacementReceipt: id => clone(receipts.get(id)), trace: (name, body) => events.push({ name, ...body }),
    callNative: async (method, args) => {
      calls.push({ method, args: clone(args) })
      if (w.hook) await w.hook(method)
      if (method === 'world_identity') return { schema_version: 1, ok: !!w.nativeWorld, code: w.nativeWorld ? 'ok' : 'world_unbound', world_id: w.nativeWorld }
      if (method === 'bind_world_id') { assert.equal(w.nativeWorld, undefined); w.nativeWorld = args; return { schema_version: 1, ok: true, code: 'ok', world_id: args } }
      assert.equal(method, 'observe')
      const drill = args.members[0]; const furnace = args.members[1]
      const value = { ...args, ok: true, code: 'ok', tick: w.tick++, members: [
        { locator: drill, state: 'observed', source_resources: { state: 'known', truncated: false, resources: [
          { name: 'copper-ore', amount: 100, products: [{ type: 'item', name: 'copper-ore', amount: 1 }], products_truncated: false },
        ] }, recipe: { state: 'unsupported', ingredients: [], products: [], truncated: false },
        item_routes: { state: 'known', truncated: false, routes: [{ kind: 'drop', state: 'connected', target: furnace }] } },
        { locator: furnace, state: 'observed', recipe: { state: 'known', name: 'native-copper-recipe', truncated: false,
          ingredients: [{ type: 'item', name: 'copper-ore', amount: 1 }], products: [{ type: 'item', name: 'copper-plate', amount: 1 }] },
        source_resources: { state: 'not_applicable', resources: [], truncated: false } },
      ] }
      return w.bodyMutate ? w.bodyMutate(value) : JSON.stringify(value)
    } })
  return w
}

async function enrolled(options) {
  const w = setup(options)
  await w.observer.initializeWorld()
  const runtime = w.observer.runtime
  const members = [[27, 'burner-mining-drill'], [28, 'stone-furnace']].map(([unit, name]) => {
    const scope = runtime.scope()
    w.memory.recordNpcPlacement(KEY, { unit_number: unit, entity_name: name, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch })
    const member = { unit_number: unit, name, position: { x: unit, y: -4 }, surface_index: 1, force_index: 1,
      provenance: { source: 'npc_placement_receipt', receipt_id: `native/${unit}` } }
    w.receipts.set(member.provenance.receipt_id, { ...scope, receipt_id: member.provenance.receipt_id, unit_number: unit, name, position: member.position })
    return runtime.recordPlacement(member, scope)
  })
  w.cell = runtime.registerCell({ surface_index: 1, force_index: 1,
    assignment: { products: ['copper-plate'], purpose: 'Retain copper production', method: 'Direct feed' },
    members, ports: [{ port_id: 'fuel', direction: 'input', kind: 'fuel', resource: 'coal' }, { port_id: 'out', direction: 'output', kind: 'item', resource: 'copper-plate' }],
    origin: runtime.origin() }, runtime.scope())
  w.request = { cell_id: w.cell.cell_id, binding: { source_unit_number: 27, target_unit_number: 28, product: 'copper-plate' } }
  return w
}

test('native one-time world initialization uses host UUID independent of actor/goal, binds both sides and never overwrites', async () => {
  const w = setup({ nativeWorld: undefined }); w.nativeWorld = undefined
  const id = await w.observer.initializeWorld()
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(w.memory.factoryWorldBinding().world_id, id)
  assert.equal(w.nativeWorld, id)
  assert.equal(w.calls.filter(row => row.method === 'bind_world_id').length, 1)
  await w.observer.initializeWorld()
  assert.equal(w.calls.filter(row => row.method === 'bind_world_id').length, 1)
  w.nativeWorld = OTHER
  await rejected(w.observer.initializeWorld(), 'factory_world_mismatch')
  w.nativeWorld = undefined
  await rejected(w.observer.initializeWorld(), 'factory_world_identity_missing')
  assert.equal(w.calls.filter(row => row.method === 'bind_world_id').length, 1)
})

test('canonical observation retains exact evidence and assignment without changing goal, plan, budgets or registry revision', async () => {
  const w = await enrolled()
  const before = JSON.stringify(w.memory.planningState(KEY)); const board = JSON.stringify(w.memory.currentPlan(KEY))
  const registry = JSON.stringify(w.memory.getFactoryRegistry())
  const result = await w.observer.observe(w.request)
  assert.equal(result.state, 'compatible')
  assert.equal(result.commissioning, 'unverified'); assert.equal(result.throughput, 'unverified')
  assert.equal(result.native.members[0].locator.unit_number, 27)
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), before)
  assert.equal(JSON.stringify(w.memory.currentPlan(KEY)), board)
  assert.equal(JSON.stringify(w.memory.getFactoryRegistry()), registry)
  assert.equal(w.memory.factoryCellObservations()[0].freshness, 'historical')
  result.native.members[0].locator.unit_number = 999
  const listing = w.observer.list(); listing.cells[0].assignment.products[0] = 'iron-plate'
  assert.equal(w.observer.list().cells[0].assignment.products[0], 'copper-plate')
  assert.equal(w.events.find(row => row.name === 'factory_cell.observation_completed').request_id, 'request-1')
})

test('BH copper source cannot satisfy active iron direct_feed guidance, even while exact copper assignment persists', async () => {
  const w = await enrolled({ resource: 'iron-ore' })
  const result = await w.observer.observe(w.request)
  assert.equal(result.state, 'mismatch')
  assert.ok(result.checks.some(row => row.code === 'mining_source_resource_mismatch'))
  assert.deepEqual(w.memory.getFactoryRegistry().cells[0].assignment.products, ['copper-plate'])
  const wrongJob = await w.observer.observe({ ...w.request, binding: { ...w.request.binding, product: 'iron-plate' } })
  assert.ok(wrongJob.checks.some(row => row.code === 'assigned_product_mismatch'))
})

test('native modded resource entity and actual mined item need not share names or vanilla recipe assumptions', async () => {
  const w = await enrolled({ resource: 'alien-vein' })
  w.bodyMutate = body => {
    body.members[0].source_resources.resources[0].name = 'alien-vein'
    body.members[0].source_resources.resources[0].products[0].name = 'alien-chunk'
    body.members[1].recipe.name = 'alternative-native-smelting'
    body.members[1].recipe.ingredients[0].name = 'alien-chunk'
    return body
  }
  assert.equal((await w.observer.observe(w.request)).state, 'compatible')
})

for (const [label, mutate, state, code] of [
  ['wrong recipe input', body => { body.members[1].recipe.ingredients[0].name = 'iron-ore' }, 'mismatch', 'target_recipe_input_mismatch'],
  ['wrong target route', body => { body.members[0].item_routes.routes[0].target = { ...body.members[1].locator, unit_number: 999 } }, 'mismatch', 'direct_feed_route_mismatch'],
  ['invisible resource', body => { body.members[0].source_resources.state = 'unknown' }, 'unverified', 'mining_source_unknown'],
  ['clipped resources', body => { body.members[0].source_resources.truncated = true }, 'unverified', 'mining_source_unknown'],
  ['clipped products', body => { body.members[0].source_resources.resources[0].products_truncated = true }, 'unverified', 'mining_products_unknown'],
  ['dormant furnace', body => { body.members[1].recipe.state = 'none' }, 'unverified', 'target_recipe_unknown'],
  ['unknown route', body => { body.members[0].item_routes.routes[0].state = 'unknown' }, 'unverified', 'direct_feed_route_unknown'],
  ['missing member', body => { body.members[0].state = 'unknown' }, 'unverified', 'binding_member_unverified'],
]) test(`factory observation distinguishes ${label}`, async () => {
  const w = await enrolled(); w.bodyMutate = body => { mutate(body); return body }
  const result = await w.observer.observe(w.request)
  assert.equal(result.state, state)
  assert.ok(result.checks.some(row => row.code === code))
})

test('dependency declaration remains unverified rather than fabricated disconnected without port member bindings', async () => {
  const w = await enrolled()
  w.observer.runtime.registerDependency({ consumer: { cell_id: w.cell.cell_id, port_id: 'fuel' }, supplier: { kind: 'unresolved' }, delivery: { kind: 'unknown' } }, w.observer.runtime.scope())
  const result = await w.observer.observe(w.request)
  assert.deepEqual(result.dependencies, [{ dependency_id: 'dependency-1', state: 'unverified', code: 'dependency_supplier_unresolved' }])
  assert.equal(result.state, 'compatible') // compatibility is not commissioning/dependency satisfaction
})

for (const [field, value] of [['request_id', 'next-request'], ['session_id', 'next-session'], ['actor_id', 25], ['actor_epoch', 3], ['world_id', OTHER], ['surface_index', 2], ['force_index', 2]]) {
  test(`observation rejects ${field} ownership changes across native await and emits correlated refusal`, async () => {
    const w = await enrolled()
    w.hook = method => { if (method === 'observe') w.context[field] = value }
    await rejected(w.observer.observe(w.request), 'factory_observation_owner_stale')
    assert.deepEqual(w.memory.factoryCellObservations(), [])
    const event = w.events.find(row => row.name === 'factory_cell.observation_refused')
    assert.equal(event.request_id, 'request-1'); assert.equal(event.code, 'factory_observation_owner_stale')
  })
}

for (const [field, value] of [['native_idle', false], ['pending', true], ['uncertain', true]]) {
  test(`observation fences ${field} both before and after native await`, async () => {
    const w = await enrolled(); const reads = w.calls.length
    w.context[field] = value
    await rejected(w.observer.observe(w.request), 'factory_runtime_not_idle')
    assert.equal(w.calls.length, reads)
    w.context[field] = !value
    w.hook = method => { if (method === 'observe') w.context[field] = value }
    await rejected(w.observer.observe(w.request), 'factory_runtime_not_idle')
    assert.deepEqual(w.memory.factoryCellObservations(), [])
  })
}

test('registry revision changes, restore and goal supersession across await invalidate result', async () => {
  for (const [change, code] of [
    [w => w.observer.runtime.registerDependency({ consumer: { cell_id: w.cell.cell_id, port_id: 'fuel' }, supplier: { kind: 'manual', reference: 'fuel' }, delivery: { kind: 'manual' } }, w.observer.runtime.scope()), 'factory_registry_revision_stale'],
    [w => w.memory.restore(w.memory.snapshot()), 'factory_runtime_stale'],
    [w => { w.memory.planningState(KEY).goal.status = 'cancelled' }, 'factory_plan_authority_missing'],
  ]) {
    const w = await enrolled(); w.hook = method => { if (method === 'observe') change(w) }
    await rejected(w.observer.observe(w.request), code)
    assert.deepEqual(w.memory.factoryCellObservations(), [])
  }
})

test('concurrent callbacks cannot race a result; sequential re-observation rereads without changing planning allowances', async () => {
  const w = await enrolled(); let release; let entered
  const ready = new Promise(resolve => { entered = resolve })
  w.hook = async method => { if (method === 'observe') { entered(); await new Promise(resolve => { release = resolve }) } }
  const first = w.observer.observe(w.request); await ready
  await rejected(w.observer.observe(w.request), 'factory_observation_in_flight')
  release(); await first
  w.hook = undefined
  const before = JSON.stringify(w.memory.planningState(KEY))
  await w.observer.observe(w.request)
  assert.equal(w.calls.filter(row => row.method === 'observe').length, 2)
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), before)
  assert.equal(w.memory.factoryCellObservations().length, 1)
})

test('save/restore retains only historical summary and exact assignments, requires new native binding and read', async () => {
  const w = await enrolled(); await w.observer.observe(w.request)
  const snapshot = w.memory.snapshot(); w.memory.restore(snapshot)
  assert.equal(w.memory.factoryCellObservations()[0].freshness, 'historical')
  await rejected(w.observer.observe(w.request), 'factory_runtime_stale')
  await w.observer.initializeWorld()
  assert.equal((await w.observer.observe(w.request)).state, 'compatible')
  assert.equal(w.calls.filter(row => row.method === 'observe').length, 2)
  const corrupted = w.memory.snapshot(); corrupted.factory_cell_observations[0].state = 'commissioned'
  w.memory.restore(corrupted)
  assert.equal(w.memory.factoryRegistryStatus().status, 'fault')
})

for (const [label, mutate, code] of [
  ['wrong native world', body => ({ ...body, world_id: OTHER }), 'factory_native_observation_identity_mismatch'],
  ['wrong native actor', body => ({ ...body, actor_id: 99 }), 'factory_native_observation_identity_mismatch'],
  ['wrong native request', body => ({ ...body, request_id: 'old' }), 'factory_native_observation_identity_mismatch'],
  ['duplicate members', body => ({ ...body, members: [body.members[0], body.members[0]] }), 'factory_native_observation_members_mismatch'],
  ['busy native', body => ({ ...body, ok: false, code: 'actor_busy' }), 'actor_busy'],
  ['oversized body', () => 'x'.repeat(FACTORY_OBSERVATION_LIMITS.body_chars + 1), 'factory_observation_body_limit'],
  ['broken JSON', () => '{broken', 'factory_observation_unreadable'],
]) test(`observation rejects ${label} without committing`, async () => {
  const w = await enrolled(); w.bodyMutate = mutate
  await rejected(w.observer.observe(w.request), code)
  assert.deepEqual(w.memory.factoryCellObservations(), [])
})

test('observations cannot manufacture native placement provenance or enroll unknown/player structures', async () => {
  const w = await enrolled()
  await w.observer.observe(w.request)
  const raw = { ...w.cell.members[0], unit_number: 99, provenance: { source: 'npc_placement_receipt', receipt_id: 'native/nonexistent' } }
  assert.throws(() => w.observer.runtime.recordPlacement(raw, w.observer.runtime.scope()), error => error.code === 'factory_placement_unproven')
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
})

for (const mode of ['no-plan', 'draft']) test(`read-only ${mode} inspection reads live native facts without gaining mutation or cache authority`, async () => {
  const w = await enrolled()
  await w.observer.observe(w.request)
  const history = clone(w.memory.factoryCellObservations())
  w.memory.clearTaskContext(KEY)
  if (mode === 'draft') {
    w.memory.recordPlan(KEY, { sender: 'owner', text: 'Inspect existing production before choosing work' }, {
      chatMessage: 'Inspect first', plan: ['Inspect the registered cell'], currentStep: 0, operations: [],
    }, { validatedPlannerAdmission: true })
    assert.equal(getActivePlan(w.memory.planningState(KEY)).status, PLAN_STATUS.DRAFT)
  }
  const planning = JSON.stringify(w.memory.planningState(KEY))
  const board = JSON.stringify(w.memory.currentPlan(KEY))
  const registry = JSON.stringify(w.memory.getFactoryRegistry())
  const beforeReads = w.calls.filter(row => row.method === 'observe').length
  const result = await w.observer.observe({ cell_id: w.cell.cell_id })
  assert.equal(result.state, 'compatible')
  assert.deepEqual(result.cache, { state: 'not_recorded', reason: 'read_only_observation' })
  assert.equal(w.calls.filter(row => row.method === 'observe').length, beforeReads + 1)
  assert.deepEqual(w.memory.factoryCellObservations(), history)
  assert.equal(JSON.stringify(w.memory.planningState(KEY)), planning)
  assert.equal(JSON.stringify(w.memory.currentPlan(KEY)), board)
  assert.equal(JSON.stringify(w.memory.getFactoryRegistry()), registry)
  await rejected(w.observer.observe(w.request), 'factory_plan_authority_missing')
  const readScope = w.observer.runtime.readScope()
  for (const mutate of [
    () => w.observer.runtime.recordObservation(history[0], readScope),
    () => w.observer.runtime.registerCell({}, readScope),
    () => w.observer.runtime.registerDependency({}, readScope),
    () => w.observer.runtime.recordPlacement({}, readScope),
  ]) assert.throws(mutate, error => error.code === 'factory_plan_authority_missing')
  assert.deepEqual(w.memory.factoryCellObservations(), history)
})

test('read-only observation fences plan ownership and registry revision across the native await', async () => {
  for (const [mutate, code] of [
    [w => w.memory.clearTaskContext(KEY), 'factory_runtime_scope_stale'],
    [w => w.memory.restore(w.memory.snapshot()), 'factory_runtime_stale'],
    [w => w.observer.runtime.registerDependency({ consumer: { cell_id: w.cell.cell_id, port_id: 'fuel' }, supplier: { kind: 'manual', reference: 'fuel' }, delivery: { kind: 'manual' } }, w.observer.runtime.scope()), 'factory_registry_revision_stale'],
  ]) {
    const w = await enrolled()
    w.hook = method => { if (method === 'observe') mutate(w) }
    await rejected(w.observer.observe({ cell_id: w.cell.cell_id }), code)
    assert.deepEqual(w.memory.factoryCellObservations(), [])
  }
})

test('list exposes only historical member-center anchor and bounds even when native members are invisible', async () => {
  const w = await enrolled()
  w.bodyMutate = body => ({ ...body, members: body.members.map(row => ({ locator: row.locator, state: 'unknown', code: 'member_not_visible' })) })
  const result = await w.observer.observe({ cell_id: w.cell.cell_id })
  assert.equal(result.state, 'unverified')
  const entry = w.observer.list().cells[0]
  assert.equal(entry.surface_index, 1); assert.equal(entry.force_index, 1)
  assert.deepEqual(entry.location, { state: 'historical_unverified', anchor: { x: 27, y: -4 },
    member_position_bounds: { left_top: { x: 27, y: -4 }, right_bottom: { x: 28, y: -4 } } })
  entry.location.anchor.x = 1000
  entry.location.member_position_bounds.right_bottom.y = 1000
  assert.equal(w.observer.list().cells[0].location.anchor.x, 27)
  assert.equal(w.observer.list().cells[0].location.member_position_bounds.right_bottom.y, -4)
  assert.deepEqual(w.memory.factoryCellObservations(), [])
})
