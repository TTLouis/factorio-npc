import test from 'node:test'
import assert from 'node:assert/strict'
import { observeDirectFactoryDelivery, observeElectricFactoryDelivery } from './factory-cell-delivery-window.mjs'

const clone = value => structuredClone(value)
function fixture() {
  const source = { unit_number: 11, name: 'synthetic-drill', surface_index: 1, force_index: 1, position: { x: 1, y: 1 } }
  const target = { unit_number: 12, name: 'synthetic-crafter', surface_index: 1, force_index: 1, position: { x: 2, y: 1 } }
  const memory = { factoryWorldBinding: () => ({ generation: 0 }) }
  const args = { scope: { world_id: 'synthetic-world', actor_id: 1, actor_epoch: 2, session_id: 'session', request_id: 'request', goal_id: 'goal', plan_id: 'plan', semantic_step_id: 'step' },
    cell: { cell_id: 'cell-1', revision: 1 }, source, target, resource: 'synthetic-resource', mutation: 0, connectedPlayers: 0,
    native: { tick: 10, members: [{ locator: source, item_routes: { state: 'known', routes: [{ kind: 'drop', state: 'connected', target }] } },
      { locator: target, incoming_item_facts: { schema_version: 1, tick: 10, state: 'known', coverage: 'complete', truncated: false, unresolved: false,
        producers: [{ relation: 'mining_drop', state: 'connected', producer: source }] },
      recipe: { state: 'known', name: 'synthetic-recipe', ingredients: [{ type: 'item', name: 'synthetic-resource' }] },
      inventories: [{ role: 'input', index: 1, state: 'known', truncated: false, items: [] }],
      endpoint_facts: { recipe_selection: { quality: { state: 'known', name: 'normal' } } },
      progress_facts: { products_finished: { state: 'known', value: 0 }, crafting_progress: { state: 'known', value: 0 } } }] } }
  const next = () => { args.native.tick++; args.native.members[1].incoming_item_facts.tick = args.native.tick }
  return { memory, args, next, read: () => observeDirectFactoryDelivery(memory, args) }
}
test('sole exact native incoming producer plus increasing receiver inventory proves only bounded attributed delivery', () => {
  const w = fixture(); assert.equal(w.read().state, 'unverified')
  w.next(); w.args.native.members[1].inventories[0].items = [{ name: 'synthetic-resource', quality: 'normal', count: 2 }]
  const result = w.read(); assert.equal(result.state, 'delivered'); assert.equal(result.observed_inventory_increase, 2)
  assert.equal(result.continuous_supply, 'unverified'); assert.equal(result.whole_cell_commissioning, 'unverified')
})

function electricFixture() {
  const w = fixture()
  const producer = { locator: w.args.source, progress_facts: { electricity_production: { state: 'known', producer: true } } }
  const receiver = { locator: w.args.target, recipe: { state: 'known', name: 'synthetic-recipe' } }
  const component = { schema_version: 1, tick: 10, state: 'known', coverage: 'complete', truncated: false, unresolved: false, electric_network_id: 7,
    members: [{ ...producer.locator, role: 'producer', maximum_energy_production: { state: 'known', value: 100 }, energy: { state: 'known', value: 20 } },
      { ...receiver.locator, role: 'consumer', maximum_energy_production: { state: 'not_applicable' }, energy: { state: 'known', value: 0 } },
      { ...producer.locator, unit_number: 13, name: 'synthetic-pole', role: 'pole', maximum_energy_production: { state: 'not_applicable' }, energy: { state: 'not_applicable' } }],
    wire_edges: [{ from_unit_number: 13, to_unit_number: 14, from_connector: 1, to_connector: 1 }] }
  producer.electric_component_facts = clone(component); receiver.electric_component_facts = clone(component)
  const args = { scope: w.args.scope, supplier: { cell_id: 'cell-1', revision: 1 }, consumer: { cell_id: 'cell-2', revision: 1 }, producer, receiver, tick: 10, mutation: 0, connectedPlayers: 0 }
  return { args, read: () => observeElectricFactoryDelivery(w.memory, args), next: () => {
    args.tick++; producer.electric_component_facts.tick++; receiver.electric_component_facts.tick++
    receiver.electric_component_facts.members[1].energy.value++
  } }
}
test('complete stable single-source native electric component and consumer energy increase prove bounded service', () => {
  const w = electricFixture(); assert.equal(w.read().state, 'unverified'); w.next()
  const result = w.read(); assert.equal(result.state, 'delivered'); assert.equal(result.observed_energy_increase, 1)
  assert.equal(result.continuous_supply, 'unverified')
})
test('electric network IDs, stored energy, unknown sources, partial coverage and changed ownership do not prove service', () => {
  for (const mutate of [
    w => { w.args.producer.electric_component_facts.coverage = 'partial' },
    w => { for (const row of [w.args.producer, w.args.receiver]) row.electric_component_facts.members[2].role = 'storage' },
    w => { for (const row of [w.args.producer, w.args.receiver]) row.electric_component_facts.members[2].role = 'unknown' },
    w => { w.args.producer.progress_facts.electricity_production.state = 'unknown' },
    w => { w.args.scope.request_id = 'replacement' },
    w => { w.args.supplier.physical_revision = 1 },
    w => { w.args.mutation++ },
    w => { w.args.connectedPlayers = 1 },
    w => { w.args.receiver.electric_component_facts.wire_edges[0].to_unit_number = 15 },
  ]) {
    const w = electricFixture(); w.read(); w.next(); mutate(w); assert.equal(w.read().state, 'unverified')
  }
  const stocked = electricFixture(); stocked.args.receiver.electric_component_facts.members[1].energy.value = 9
  stocked.read(); stocked.args.tick++; assert.equal(stocked.read().state, 'unverified')
})
test('empty receiver and zero initial craft progress allow exact completed cycle to prove delivery without an invented item ratio', () => {
  const w = fixture(); w.read(); w.next(); w.args.native.members[1].progress_facts.products_finished.value = 1
  const result = w.read(); assert.equal(result.state, 'delivered'); assert.equal(result.observed_crafting_cycles, 1)
  assert.equal(result.observed_inventory_increase, undefined)
})
test('stocked buffers, in-progress craft, gauges, unknown incoming cuts and other suppliers cannot commission delivery', () => {
  for (const mutate of [
    w => { w.args.native.members[1].inventories[0].items = [{ name: 'synthetic-resource', quality: 'normal', count: 9 }] },
    w => { w.args.native.members[1].progress_facts.crafting_progress.value = 0.9 },
    w => { w.args.native.members[1].incoming_item_facts.coverage = 'partial' },
    w => { w.args.native.members[1].incoming_item_facts.producers.push({ relation: 'inserter_drop', state: 'connected', producer: { ...w.args.source, unit_number: 99 } }) },
  ]) {
    const w = fixture(); mutate(w); w.read(); w.next(); w.args.native.members[1].progress_facts.products_finished.value++
    assert.equal(w.read().state, 'unverified')
  }
})
test('owner, physical revision, recipe, mutation or process generation change starts a fresh window', () => {
  for (const mutate of [w => { w.args.scope.request_id = 'new' }, w => { w.args.cell.physical_revision = 1 }, w => { w.args.native.members[1].recipe.name = 'other' },
    w => { w.args.mutation++ }, w => { w.memory.factoryWorldBinding = () => ({ generation: 1 }) }]) {
    const w = fixture(); w.read(); w.next(); mutate(w)
    w.args.native.members[1].inventories[0].items = [{ name: 'synthetic-resource', quality: 'normal', count: 2 }]
    assert.equal(w.read().state, 'unverified')
    const restarted = fixture(); restarted.args = clone(w.args)
    assert.equal(observeDirectFactoryDelivery(restarted.memory, restarted.args).state, 'unverified')
  }
})

test('an observed interruption discards old delivery baseline even when exact topology later returns', () => {
  const direct = fixture(); direct.read(); direct.next()
  direct.args.native.members[1].incoming_item_facts.coverage = 'partial'; direct.read(); direct.next()
  direct.args.native.members[1].incoming_item_facts.coverage = 'complete'
  direct.args.native.members[1].inventories[0].items = [{ name: 'synthetic-resource', quality: 'normal', count: 10 }]
  assert.equal(direct.read().state, 'unverified')
  const electric = electricFixture(); electric.read(); electric.next()
  electric.args.producer.electric_component_facts.coverage = 'partial'; electric.read(); electric.next()
  electric.args.producer.electric_component_facts.coverage = 'complete'
  assert.equal(electric.read().state, 'unverified')
})

test('a working consumer whose arrivals the arithmetic cannot attribute rebases the window; it never proves delivery by itself', () => {
  const stock = (w, count) => { w.args.native.members[1].inventories[0].items = count ? [{ name: 'synthetic-resource', quality: 'normal', count }] : [] }
  // The consumer began the window holding stock and finished more crafts than that stock: inconclusive, so the newer frame is the baseline.
  const drained = fixture(); stock(drained, 1); drained.read(); drained.next(); stock(drained, 0)
  drained.args.native.members[1].progress_facts.products_finished.value = 3
  assert.deepEqual(drained.read(), { state: 'unverified', code: 'direct_delivery_window_rebased' })
  // From that empty, idle baseline one more finished craft can only be smelted from a delivery.
  drained.next(); drained.args.native.members[1].progress_facts.products_finished.value = 4
  const proven = drained.read()
  assert.deepEqual([proven.state, proven.basis, proven.from_tick, proven.to_tick], ['delivered', 'empty_receiver_started_and_completed_native_crafting', 11, 12])
  // A craft running at the newer frame is native activity too.
  const running = fixture(); running.read(); running.next(); running.args.native.members[1].progress_facts.crafting_progress.value = 0.5
  assert.equal(running.read().code, 'direct_delivery_window_rebased')
  // An idle consumer whose input did not grow received nothing that counts, and its baseline is kept.
  const idle = fixture(); stock(idle, 2); idle.read(); idle.next()
  assert.equal(idle.read().code, 'direct_delivery_window_no_attributed_progress')
  idle.next(); stock(idle, 3)
  assert.equal(idle.read().observed_inventory_increase, 1, 'the kept baseline still proves a later increase')
  // A consumer that only drains its own stock, with no supplier, is never credited: each window rebases until it is empty and idle.
  const draining = fixture(); stock(draining, 3); draining.read()
  for (const left of [2, 1, 0]) {
    draining.next(); stock(draining, left); draining.args.native.members[1].progress_facts.products_finished.value++
    assert.equal(draining.read().code, 'direct_delivery_window_rebased')
  }
  draining.next(); assert.equal(draining.read().code, 'direct_delivery_window_no_attributed_progress')
})
