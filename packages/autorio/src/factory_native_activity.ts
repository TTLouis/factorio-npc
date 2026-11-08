import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { area_known_visible } from './map_knowledge'
import { find_world_entities, is_npc_vision_entity } from './npc_vision'
import { vector_xy } from './placement_geometry'

interface Fact { state: string, code?: string, [key: string]: unknown }
const unknown = (code: string): Fact => ({ state: 'unknown', code })
const finite = (v: unknown): v is number => typeof v === 'number' && v === v && v >= 0 && v < math.huge
function number_fact(read: () => unknown, basis: string, whole = false): Fact {
  const result = protected_read(() => ({ value: read() }))
  if (!result) return { state: 'error', code: `${basis}_unreadable` }
  if (result.value === undefined) return unknown(`${basis}_unavailable`)
  if (!finite(result.value) || result.value > 9007199254740991 || whole && math.floor(result.value) !== result.value) return unknown(`${basis}_malformed`)
  return { state: 'known', value: result.value, basis }
}
export function factory_native_progress(entity: LuaEntity) {
  const crafter = ['assembling-machine', 'furnace', 'rocket-silo'].includes(entity.type)
  const products_finished = crafter ? number_fact(() => entity.products_finished, 'native_completed_crafting_cycles', true) : { state: 'not_applicable', code: 'not_a_native_crafter' }
  const crafting_progress = crafter ? number_fact(() => entity.crafting_progress, 'native_crafting_progress_gauge') : { state: 'not_applicable' }
  const mining_progress = entity.type === 'mining-drill' ? number_fact(() => entity.mining_progress, 'native_mining_progress_gauge') : { state: 'not_applicable' }
  const energy_generated_last_tick = entity.type === 'generator' ? number_fact(() => entity.energy_generated_last_tick, 'native_last_tick_energy_sample') : { state: 'not_applicable' }
  let electricity_production: Fact = { state: 'not_applicable', code: 'not_a_native_generator' }
  if (entity.type === 'generator') {
    const maximum = number_fact(() => entity.prototype.get_max_energy_production(entity.quality), 'native_generator_prototype')
    electricity_production = maximum.state === 'known' ? { state: 'known', producer: (maximum.value as number) > 0,
      maximum_energy_production: maximum.value, basis: maximum.basis } : maximum
  }
  return { schema_version: 1, tick: game.tick, identity_scope: 'enclosing_exact_member', products_finished, crafting_progress, mining_progress,
    energy_generated_last_tick, electricity_production,
    coverage: { supply: 'unverified', delivery: 'unverified', automation: 'unverified', commissioning: 'unverified' } }
}

// Prototype membership only: accepting a fuel does not establish a supplier.
// Both iteration and output are bounded; a partial set cannot exclude an item.
export function factory_native_fuels(requirement: { state: string, fuel_categories: string[] }) {
  const items: Array<{ name: string, category: string, fuel_value: number }> = []
  const base = { items, basis: 'native_item_fuel_categories', supply: 'unverified' }
  if (requirement.state === 'not_applicable') return { ...base, state: 'not_applicable', coverage: 'complete', truncated: false }
  if (requirement.state !== 'known') return { ...base, state: 'unknown', coverage: 'partial', truncated: false, code: 'burner_categories_unknown' }
  const read = protected_read(() => {
    let scanned = 0
    for (const [name, prototype] of pairs(prototypes.item)) {
      if (scanned++ >= 2048) return { ...base, state: 'unknown', coverage: 'partial', truncated: true, code: 'fuel_prototypes_truncated' }
      const categories = prototype.fuel_categories
      if (categories === undefined) continue
      if (categories.length > 32 || categories.some(category => typeof category !== 'string' || !category || category.length > 160)) return { ...base, state: 'unknown', coverage: 'partial', truncated: categories.length > 32, code: 'item_fuel_categories_unbounded' }
      const category = categories.find(category => requirement.fuel_categories.includes(category))
      if (category === undefined) continue
      const value = prototype.fuel_value
      if (!finite(value) || value <= 0) continue
      if (items.length >= 64 || name.length > 200) return { ...base, state: 'unknown', coverage: 'partial', truncated: true, code: 'fuel_items_truncated' }
      items.push({ name, category, fuel_value: value })
    }
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return { ...base, state: 'known', coverage: 'complete', truncated: false }
  })
  return read ?? { ...base, state: 'error', coverage: 'partial', truncated: false, code: 'fuel_prototypes_unreadable' }
}

// Bound the entire surface, never a guessed inserter/miner reach radius. This
// deliberately supports ordinary inventory interfaces only. Belts cannot access
// these inventories without a drill, inserter or loader, all enumerated here.
export const FACTORY_CONSUMER_LIMITS = { candidates: 128, drop_candidates: 16 }
const TRANSPORT_TYPES = ['inserter', 'mining-drill', 'transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt']
interface Consumer { relation: string, state: 'connected' | 'potential', consumer: Record<string, unknown> }
interface Producer { relation: string, state: 'connected' | 'potential', producer: Record<string, unknown> }
function locator(entity: LuaEntity) {
  return { unit_number: entity.unit_number, name: entity.name, type: entity.type,
    position: { x: entity.position.x, y: entity.position.y }, surface_index: entity.surface.index, force_index: entity.force.index }
}
function visible(actor: ControlledActor, entity: LuaEntity) {
  return area_known_visible(actor.force, entity.surface, entity.bounding_box)
}
function inside(position: { x: number, y: number }, entity: LuaEntity) {
  const box = entity.bounding_box
  return position.x >= box.left_top.x && position.x <= box.right_bottom.x && position.y >= box.left_top.y && position.y <= box.right_bottom.y
}
// With custom vectors disabled, the native engine ignores pickup/drop overrides
// (2.0.77 probe). Use live prototype vector lengths and footprint margins to
// exclude a hidden ordinary inserter without reading or exposing its endpoints.
function hidden_inserter_unrelated(candidate: LuaEntity, entity: LuaEntity) {
  if (candidate.type !== 'inserter' || candidate.prototype.allow_custom_vectors !== false) return false
  const pickup = vector_xy(candidate.prototype.inserter_pickup_position)
  const drop = vector_xy(candidate.prototype.inserter_drop_position)
  const box = candidate.prototype.collision_box
  if (!pickup || !drop || !box) return false
  const margin = math.max(math.abs(box.left_top.x), math.abs(box.left_top.y), math.abs(box.right_bottom.x), math.abs(box.right_bottom.y))
  if (!finite(margin)) return false
  const bound = math.max(math.abs(pickup.x) + math.abs(pickup.y), math.abs(drop.x) + math.abs(drop.y)) + margin
  const target = entity.bounding_box
  return candidate.position.x + bound < target.left_top.x || candidate.position.x - bound > target.right_bottom.x
    || candidate.position.y + bound < target.left_top.y || candidate.position.y - bound > target.right_bottom.y
}
export function factory_native_item_topology(actor: ControlledActor, entity: LuaEntity) {
  const consumers: Consumer[] = []
  const producers: Producer[] = []
  const common = { schema_version: 1, tick: game.tick, identity_scope: 'enclosing_exact_member' }
  let outgoing: string | undefined, incoming: string | undefined
  let truncated = false
  let incoming_truncated = false
  let scanned = 0
  function result(state = 'unknown') {
    const status = (code: string | undefined, capped: boolean) => ({ state: code ? state : 'known', coverage: code ? 'partial' : 'complete', truncated: capped,
      unresolved: !!code, code, scanned_candidates: scanned })
    return { consumer_facts: { ...common, scope: 'direct_native_item_consumers', consumers, ...status(outgoing, truncated) },
      incoming_item_facts: { ...common, scope: 'direct_native_item_producers', producers, ...status(incoming, incoming_truncated) } }
  }
  const read = protected_read(() => {
    if (!['container', 'furnace', 'mining-drill'].includes(entity.type)) outgoing = 'consumer_source_interface_unsupported'
    if (!['container', 'furnace', 'mining-drill', 'assembling-machine'].includes(entity.type)) incoming = 'incoming_inventory_interface_unsupported'
    if (entity.prototype.electric_energy_source_prototype !== undefined || entity.prototype.heat_energy_source_prototype !== undefined
      || entity.prototype.heat_buffer_prototype !== undefined || entity.fluids_count !== 0) outgoing ??= 'consumer_shared_service_unsupported'
    if (outgoing && incoming) return result()
    const candidates = find_world_entities(entity.surface, { type: TRANSPORT_TYPES as any, limit: FACTORY_CONSUMER_LIMITS.candidates + 1 })
    scanned = math.min(candidates.length, FACTORY_CONSUMER_LIMITS.candidates)
    if (candidates.length > FACTORY_CONSUMER_LIMITS.candidates) { truncated = true; incoming_truncated = true; outgoing ??= 'consumer_candidates_truncated'; incoming ??= 'incoming_candidates_truncated'; return result() }
    function add(candidate: LuaEntity, relation: string, state: 'connected' | 'potential') {
      if (!candidate.valid || !visible(actor, candidate) || candidate.unit_number === undefined) { outgoing ??= 'consumer_identity_or_visibility_unknown'; return }
      if (!consumers.some(row => row.consumer.unit_number === candidate.unit_number && row.relation === relation)) consumers.push({ relation, state, consumer: locator(candidate) })
      if (state === 'potential') outgoing ??= 'consumer_dormant_endpoint_possible'
    }
    function producer(candidate: LuaEntity, relation: string, state: 'connected' | 'potential') {
      if (!candidate.valid || !visible(actor, candidate) || candidate.unit_number === undefined) { incoming ??= 'incoming_identity_or_visibility_unknown'; return }
      if (!producers.some(row => row.producer.unit_number === candidate.unit_number && row.relation === relation)) producers.push({ relation, state, producer: locator(candidate) })
      if (state === 'potential') incoming ??= 'incoming_dormant_endpoint_possible'
    }
    for (const candidate of candidates) {
      if (!candidate.valid) { outgoing ??= 'consumer_candidate_invalid'; incoming ??= 'incoming_candidate_invalid'; continue }
      // Native container/furnace/drill/assembler are not belt-connectable.
      // Loader inventory interfaces are handled separately, including empty ones.
      if (!['inserter', 'mining-drill', 'loader', 'loader-1x1'].includes(candidate.type)) continue
      if (candidate === entity) continue
      if (!visible(actor, candidate)) {
        if (hidden_inserter_unrelated(candidate, entity)) continue
        if (candidate.type !== 'mining-drill') outgoing ??= 'consumer_candidate_not_visible'
        incoming ??= 'incoming_candidate_not_visible'; continue
      }
      if (candidate.type === 'inserter') {
        const position = candidate.pickup_position
        if (!area_known_visible(actor.force, entity.surface, { left_top: position, right_bottom: position })) outgoing ??= 'consumer_pickup_not_visible'
        else {
          const target = candidate.pickup_target
          if (target?.valid && target.unit_number === entity.unit_number) add(candidate, 'inserter_pickup', 'connected')
          else if (inside(position, entity)) add(candidate, 'inserter_pickup', 'potential')
          else if (target !== undefined && !target.valid) outgoing ??= 'consumer_endpoint_invalid'
        }
      }
      if (candidate.type === 'inserter' || candidate.type === 'mining-drill') {
        const position = candidate.drop_position
        if (!position) incoming ??= 'incoming_drop_position_unknown'
        else if (!area_known_visible(actor.force, entity.surface, { left_top: position, right_bottom: position })) incoming ??= 'incoming_drop_not_visible'
        else {
          const target = candidate.drop_target
          if (target?.valid && target.unit_number === entity.unit_number) producer(candidate, candidate.type === 'inserter' ? 'inserter_drop' : 'mining_drop', 'connected')
          else if (inside(position, entity)) producer(candidate, candidate.type === 'inserter' ? 'inserter_drop' : 'mining_drop', 'potential')
          else if (target !== undefined && !target.valid) incoming ??= 'incoming_endpoint_invalid'
        }
      }
      if (candidate.type === 'loader' || candidate.type === 'loader-1x1') {
        const target = candidate.loader_container
        const mode = candidate.loader_type
        if (target !== undefined && !target.valid) { outgoing ??= 'consumer_loader_endpoint_invalid'; incoming ??= 'incoming_loader_endpoint_invalid' }
        else if (target?.unit_number === entity.unit_number) {
          if (mode === 'output') add(candidate, 'loader_output', 'connected')
          else if (mode === 'input') producer(candidate, 'loader_input', 'connected')
          else { outgoing ??= 'consumer_loader_mode_unknown'; incoming ??= 'incoming_loader_mode_unknown' }
        }
      }
    }
    if (entity.type === 'mining-drill') {
      const position = entity.drop_position
      if (!position) { outgoing ??= 'consumer_drop_position_unknown'; return result() }
      if (!area_known_visible(actor.force, entity.surface, { left_top: position, right_bottom: position })) { outgoing ??= 'consumer_drop_not_visible'; return result() }
      const target = entity.drop_target
      if (target?.valid) add(target, 'mining_drop', 'connected')
      else {
        const receivers = find_world_entities(entity.surface, { position, limit: FACTORY_CONSUMER_LIMITS.drop_candidates + 1 })
        if (receivers.length > FACTORY_CONSUMER_LIMITS.drop_candidates) { outgoing ??= 'consumer_drop_candidates_truncated'; truncated = true; return result() }
        for (const receiver of receivers) {
          if (!receiver.valid || receiver === entity || is_npc_vision_entity(receiver)) continue
          if (!visible(actor, receiver)) { outgoing ??= 'consumer_drop_candidate_not_visible'; continue }
          if (receiver.type !== 'resource' && (receiver.prototype.is_entity_with_owner || receiver.get_max_inventory_index() > 0)) add(receiver, 'mining_drop', 'potential')
        }
      }
    }
    return result()
  })
  if (read) return read
  outgoing = 'consumer_native_read_failed'; incoming = 'incoming_native_read_failed'
  return result('error')
}
export function factory_native_consumers(actor: ControlledActor, entity: LuaEntity) {
  return factory_native_item_topology(actor, entity).consumer_facts
}
