import { factoryMetadataDigest as digest } from './factory-dependencies.mjs'

const windows = new WeakMap()
const electricWindows = new WeakMap()
const known = value => value?.state === 'known' && value.truncated !== true
const nativeList = value => Array.isArray(value) ? value : value && typeof value === 'object' && Object.keys(value).length === 0 ? [] : undefined
const exact = (a, b) => a?.unit_number === b?.unit_number && a?.name === b?.name && a?.surface_index === b?.surface_index
  && a?.force_index === b?.force_index && a?.position?.x === b?.position?.x && a?.position?.y === b?.position?.y
const unknown = code => ({ state: 'unverified', code })
function inputSample(row, resource) {
  const input = row?.inventories?.filter(inventory => inventory.role === 'input')
  if (input?.length !== 1 || !known(input[0]) || !Number.isSafeInteger(input[0].index)) return undefined
  const items = nativeList(input[0].items)
  if (!items || items.some(item => typeof item.name !== 'string' || typeof item.quality !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0)) return undefined
  const selected = row.endpoint_facts?.recipe_selection?.quality
  if (!known(selected) || typeof selected.name !== 'string') return undefined
  const count = items.filter(item => item.name === resource && item.quality === selected.name).reduce((sum, item) => sum + item.count, 0)
  return { index: input[0].index, quality: selected.name, count }
}

/** Two fresh controller-owned frames prove only bounded attributed delivery.
 * A gauge, stock already present, elapsed time, or shared network is insufficient. */
export function observeDirectFactoryDelivery(memory, { scope, cell, native, source, target, resource, mutation, connectedPlayers }) {
  const interrupted = code => { windows.delete(memory); return unknown(code) }
  const producer = native.members.find(row => exact(row.locator, source))
  const consumer = native.members.find(row => exact(row.locator, target))
  const cut = consumer?.incoming_item_facts
  const direct = producer?.item_routes
  if (connectedPlayers !== 0 || !known(cut) || cut.schema_version !== 1 || cut.coverage !== 'complete' || cut.unresolved !== false
    || cut.tick !== native.tick || !Array.isArray(cut.producers) || cut.producers.length !== 1
    || cut.producers[0].relation !== 'mining_drop' || cut.producers[0].state !== 'connected' || !exact(cut.producers[0].producer, source)
    || !known(direct) || direct.routes?.length !== 1 || direct.routes[0].state !== 'connected' || !exact(direct.routes[0].target, target)) return interrupted('direct_incoming_cut_unverified')
  const inventory = inputSample(consumer, resource)
  const recipe = consumer.recipe
  if (!inventory || !known(recipe) || !recipe.ingredients?.some(input => input.type === 'item' && input.name === resource)) return interrupted('direct_receiver_endpoint_unverified')
  const key = digest({ world_id: scope.world_id, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch, session_id: scope.session_id,
    request_id: scope.request_id, goal_id: scope.goal_id, plan_id: scope.plan_id, semantic_step_id: scope.semantic_step_id,
    registry_generation: memory.factoryWorldBinding().generation, cell_id: cell.cell_id, revision: cell.revision, physical_revision: cell.physical_revision ?? 0,
    source, target, resource, mutation, recipe, inventory_index: inventory.index, quality: inventory.quality, cut: cut.producers })
  let entries = windows.get(memory)
  if (!entries) { entries = new Map(); windows.set(memory, entries) }
  const sample = { tick: native.tick, count: inventory.count, cycles: consumer.progress_facts?.products_finished,
    progress: consumer.progress_facts?.crafting_progress }
  const previous = entries.get(key)
  if (!previous) {
    if (entries.size >= 64) entries.delete(entries.keys().next().value)
    entries.set(key, structuredClone(sample)); return unknown('direct_delivery_window_started')
  }
  if (!Number.isSafeInteger(sample.tick) || sample.tick <= previous.tick) return unknown('direct_delivery_window_no_new_tick')
  const increase = sample.count - previous.count
  const consumed = previous.count === 0 && known(previous.progress) && previous.progress.value === 0
    && known(previous.cycles) && known(sample.cycles) && Number.isSafeInteger(previous.cycles.value) && Number.isSafeInteger(sample.cycles.value)
    && sample.cycles.value > previous.cycles.value
  if (increase <= 0 && !consumed) return unknown('direct_delivery_window_no_attributed_progress')
  return { state: 'delivered', code: 'exclusive_direct_delivery_window', supplier: source.unit_number, consumer: target.unit_number,
    resource, quality: inventory.quality, from_tick: previous.tick, to_tick: sample.tick, scope: 'bounded_observed_window',
    basis: increase > 0 ? 'exact_receiver_inventory_increased' : 'empty_receiver_started_and_completed_native_crafting',
    ...(increase > 0 ? { observed_inventory_increase: increase } : { observed_crafting_cycles: sample.cycles.value - previous.cycles.value }),
    continuous_supply: 'unverified', whole_cell_commissioning: 'unverified' }
}

export function observeElectricFactoryDelivery(memory, { scope, supplier, consumer, producer, receiver, tick, mutation, connectedPlayers }) {
  const interrupted = code => { electricWindows.delete(memory); return unknown(code) }
  const left = producer?.electric_component_facts; const right = receiver?.electric_component_facts
  const complete = value => known(value) && value.schema_version === 1 && Number.isSafeInteger(value.tick) && value.tick <= tick && tick - value.tick <= 120 && value.coverage === 'complete'
    && value.unresolved === false && Array.isArray(value.members) && value.members.length > 0 && value.members.length <= 64
    && Array.isArray(value.wire_edges) && value.wire_edges.length <= 128
  if (connectedPlayers !== 0 || !complete(left) || !complete(right)) return interrupted('electric_component_incomplete')
  const topology = value => ({ members: value.members.map(({ energy, ...member }) => member).sort((a, b) => a.unit_number - b.unit_number),
    wire_edges: [...value.wire_edges].sort((a, b) => digest(a).localeCompare(digest(b))) })
  const component = topology(left)
  if (digest(component) !== digest(topology(right)) || left.electric_network_id !== right.electric_network_id
    || new Set(left.members.map(member => member.unit_number)).size !== left.members.length
    || left.members.some(member => !['producer', 'consumer', 'pole'].includes(member.role))) return interrupted('electric_component_not_closed')
  const sources = left.members.filter(member => member.role === 'producer')
  const target = right.members.find(member => exact(member, receiver.locator))
  if (sources.length !== 1 || !exact(sources[0], producer.locator) || !known(sources[0].maximum_energy_production)
    || !Number.isFinite(sources[0].maximum_energy_production.value) || !(sources[0].maximum_energy_production.value > 0)
    || target?.role !== 'consumer' || !known(target.energy) || !Number.isFinite(target.energy.value) || !(target.energy.value >= 0)
    || !known(producer.progress_facts?.electricity_production) || producer.progress_facts.electricity_production.producer !== true) return interrupted('electric_supplier_or_consumer_unverified')
  const key = digest({ world_id: scope.world_id, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch, session_id: scope.session_id,
    request_id: scope.request_id, goal_id: scope.goal_id, plan_id: scope.plan_id, semantic_step_id: scope.semantic_step_id,
    generation: memory.factoryWorldBinding().generation, supplier: [supplier.cell_id, supplier.revision, supplier.physical_revision ?? 0],
    consumer: [consumer.cell_id, consumer.revision, consumer.physical_revision ?? 0], producer: producer.locator, receiver: receiver.locator,
    recipe: receiver.recipe ?? null, topology: component, mutation })
  let entries = electricWindows.get(memory)
  if (!entries) { entries = new Map(); electricWindows.set(memory, entries) }
  const prior = entries.get(key)
  if (!prior) {
    if (entries.size >= 64) entries.delete(entries.keys().next().value)
    entries.set(key, { tick, energy: target.energy.value }); return unknown('electric_delivery_window_started')
  }
  if (!Number.isSafeInteger(tick) || tick <= prior.tick || target.energy.value <= prior.energy) return unknown('electric_delivery_window_no_attributed_progress')
  return { state: 'delivered', code: 'closed_component_energy_delivery_window', from_tick: prior.tick, to_tick: tick,
    supplier: producer.locator.unit_number, consumer: receiver.locator.unit_number, observed_energy_increase: target.energy.value - prior.energy,
    basis: 'sole_capable_producer_in_complete_stable_native_component', scope: 'bounded_observed_window', continuous_supply: 'unverified', whole_cell_commissioning: 'unverified' }
}
