import type { ControlledActor } from './actors/types'
import { get_actor_inventory_items } from './utils/inventory'
import * as rates from './production_rates'
import { is_placed_building_prototype } from './mining_reach'
import { electric_prototype_facts } from './electric_facts'

const MAX_PLACE_ITEMS = 4
const MAX_FLUIDBOX_PROTOTYPES = 8
const MAX_PIPE_CONNECTIONS = 8
const MAX_PIPE_POSITIONS = 4
const MAX_CONNECTION_CATEGORIES = 4
const DEFAULT_DISCOVERY_LIMIT = 6
const MAX_DISCOVERY_LIMIT = 12
const MAX_DISCOVERY_PLACE_ITEMS = 2
const MAX_MINEABLE_PRODUCTS = 8
const MAX_TILE_PROTOTYPES = 2048

type PrototypeDiscoveryCapability = 'mining' | 'crafting' | 'entity-type' | 'harvest'
type PrototypeDiscoveryAvailability = 'force-available' | 'all'
type PrototypeEnergySource = 'burner' | 'electric' | 'heat' | 'fluid' | 'void' | 'none'

export interface PrototypeDiscoveryRequest {
  capability: PrototypeDiscoveryCapability
  resource_name?: string
  resource_category?: string
  crafting_category?: string
  entity_type?: string
  product_name?: string
  energy_source?: PrototypeEnergySource
  availability?: PrototypeDiscoveryAvailability
  limit?: number
}

function sort_strings(values: string[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j] < values[i]) {
        const tmp = values[i]
        values[i] = values[j]
        values[j] = tmp
      }
    }
  }
  return values
}

function dictionary_keys(value: Record<string, unknown> | undefined) {
  const result: string[] = []
  if (!value) return result
  for (const [name] of pairs(value)) result.push(name)
  return sort_strings(result)
}

function bounded_runtime_values(value: any, limit: number) {
  const values: any[] = []
  let count = 0
  if (!value) return { values, count, truncated: false }
  for (const [, entry] of pairs(value as Record<number, any>)) {
    count++
    if (values.length < limit) values.push(entry)
  }
  return { values, count, truncated: count > limit }
}

function sorted_place_item_summaries(prototype: any, limit: number, observe?: (item: any) => void) {
  const values: Array<{ name: string, count: number }> = []
  let count = 0
  const runtime_values = prototype?.items_to_place_this
  if (!runtime_values) return { values, count, truncated: false }

  for (const [, item] of pairs(runtime_values as Record<number, any>)) {
    if (!item || typeof item.name !== 'string') continue
    count++
    if (observe) observe(item)

    const candidate = { name: item.name, count: item.count }
    if (values.length < limit) values.push(candidate)
    else if (limit > 0) {
      let largest = 0
      for (let index = 1; index < values.length; index++) {
        if (values[index].name > values[largest].name) largest = index
      }
      if (candidate.name < values[largest].name) values[largest] = candidate
    }
  }

  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
  return { values, count, truncated: count > limit }
}

function place_items(prototype: any) {
  return sorted_place_item_summaries(prototype, MAX_PLACE_ITEMS).values
}

function position_details(value: any) {
  if (!value || typeof value.x !== 'number' || typeof value.y !== 'number') return undefined
  return { x: value.x, y: value.y }
}

function connection_categories(value: any) {
  if (typeof value === 'string') return { categories: [value], truncated: false }
  const runtime_values = bounded_runtime_values(value, MAX_CONNECTION_CATEGORIES)
  const categories: string[] = []
  for (const category of runtime_values.values) {
    if (typeof category === 'string') categories.push(category)
  }
  return { categories, truncated: runtime_values.truncated }
}

function pipe_connection_details(connection: any) {
  const runtime_positions = bounded_runtime_values(connection?.positions, MAX_PIPE_POSITIONS)
  const positions: Array<{ x: number, y: number }> = []
  for (const raw_position of runtime_positions.values) {
    const position = position_details(raw_position)
    if (position) positions.push(position)
  }
  const categories = connection_categories(connection?.connection_category)
  return {
    connection_type: connection?.connection_type,
    flow_direction: connection?.flow_direction,
    direction: connection?.direction,
    positions,
    positions_truncated: runtime_positions.truncated,
    max_underground_distance: connection?.max_underground_distance,
    connection_categories: categories.categories,
    connection_categories_truncated: categories.truncated,
    linked_connection_id: connection?.linked_connection_id,
    alt_direction: connection?.alt_direction,
    alt_position: position_details(connection?.alt_position),
  }
}

// The fluids the tile prototypes carry: what an entity that pumps from the tile it sits on can produce.
function tile_fluid_names() {
  const names: string[] = []
  const seen: Record<string, boolean> = {}
  let scanned = 0
  for (const [, tile] of pairs(prototypes.tile ?? {})) {
    scanned += 1
    if (scanned > MAX_TILE_PROTOTYPES) return { names: [] as string[], truncated: true }
    const fluid_name = tile?.fluid?.name
    if (typeof fluid_name === 'string' && !seen[fluid_name]) {
      seen[fluid_name] = true
      names.push(fluid_name)
    }
  }
  return { names: sort_strings(names), truncated: false }
}

/** Every fluid an entity prototype takes in or gives out by its fluidboxes (filters, and the tile fluids of a tile-fed pump), sorted and unique. */
export function fluid_io_names(prototype: any) {
  const names: string[] = []
  const seen: Record<string, boolean> = {}
  for (const entry of fluidbox_details(prototype).fluid_io) {
    const listed: string[] = []
    if (typeof entry.fluid === 'string') listed.push(entry.fluid)
    for (const option of (entry.fluid_options as string[] | undefined) ?? []) listed.push(option)
    for (const name of listed) {
      if (!seen[name]) {
        seen[name] = true
        names.push(name)
      }
    }
  }
  return sort_strings(names)
}

function fluidbox_details(prototype: any) {
  const runtime_fluidboxes = bounded_runtime_values(prototype?.fluidbox_prototypes, MAX_FLUIDBOX_PROTOTYPES)
  const fluidboxes: Array<Record<string, unknown>> = []
  // Which fluids the entity takes in or gives out, per port. A fluidbox filter names the fluid itself. An offshore pump's
  // output box has no filter: it yields the fluid of the tile under its intake, so the tile prototypes' fluids are the
  // OPTIONS of that port (one of them, depending on where the pump stands), never several products. The set is not capped.
  const fluid_io: Array<{ fluid?: string, fluid_options?: string[], production_type: unknown, fluidbox_index: unknown, source: string }> = []
  let fluid_io_truncated = false
  let tile_fluids: ReturnType<typeof tile_fluid_names> | undefined

  for (const fluidbox of runtime_fluidboxes.values) {
    const runtime_connections = bounded_runtime_values(fluidbox?.pipe_connections, MAX_PIPE_CONNECTIONS)
    const pipe_connections: Array<Record<string, unknown>> = []
    for (const connection of runtime_connections.values) pipe_connections.push(pipe_connection_details(connection))
    fluidboxes.push({
      index: fluidbox.index,
      production_type: fluidbox.production_type,
      filter: fluidbox.filter?.name,
      minimum_temperature: fluidbox.minimum_temperature,
      maximum_temperature: fluidbox.maximum_temperature,
      pipe_connection_count: runtime_connections.count,
      pipe_connections_truncated: runtime_connections.truncated,
      pipe_connections,
    })
    if (fluidbox.filter?.name !== undefined) {
      fluid_io.push({ fluid: fluidbox.filter.name, production_type: fluidbox.production_type, fluidbox_index: fluidbox.index, source: 'fluidbox_filter' })
    } else if (prototype.type === 'offshore-pump' && fluidbox.production_type === 'output') {
      tile_fluids = tile_fluids ?? tile_fluid_names()
      if (tile_fluids.truncated) fluid_io_truncated = true
      if (tile_fluids.names.length > 0) {
        fluid_io.push({ production_type: fluidbox.production_type, fluidbox_index: fluidbox.index, source: 'tile_fluid', fluid_options: tile_fluids.names })
      }
    }
  }

  return {
    truncated: runtime_fluidboxes.truncated,
    fluidboxes,
    fluid_io,
    fluid_io_truncated: fluid_io_truncated || runtime_fluidboxes.truncated,
  }
}

function mineable_product_summaries(prototype: any, limit: number = MAX_MINEABLE_PRODUCTS) {
  const values: Array<Record<string, unknown>> = []
  let count = 0
  const products = prototype?.mineable_properties?.products
  if (!products) return { values, count, truncated: false }

  for (const [, product] of pairs(products as Record<number, any>)) {
    if (!product || typeof product.name !== 'string') continue
    count++
    if (values.length >= limit) continue
    values.push({
      type: product.type,
      name: product.name,
      amount: product.amount,
      amount_min: product.amount_min,
      amount_max: product.amount_max,
      probability: product.probability,
    })
  }

  return { values, count, truncated: count > limit }
}

function mineable_details(prototype: any) {
  const properties = prototype?.mineable_properties
  if (!properties) return undefined
  const products = mineable_product_summaries(prototype)
  return {
    mining_time: properties.mining_time,
    required_fluid: properties.required_fluid,
    fluid_amount: properties.fluid_amount,
    products: products.values,
    products_truncated: products.truncated,
  }
}

function yields_item_product(prototype: any, product_name: string) {
  const products = prototype?.mineable_properties?.products
  if (!products) return false
  for (const [, product] of pairs(products as Record<number, any>)) {
    if (product?.type === 'item' && product.name === product_name) return true
  }
  return false
}

// Harvest sources are map-generated trees and rocks only (rocks are is_building, but
// have no owner or placing item). Any other entity that
// merely yields the product when mined (a furnace, a chest, a belt) is a
// player- or NPC-built asset and must never be a harvest target.
export function natural_harvest_source_names(product_name: string) {
  const names: string[] = []
  if (!prototypes.item[product_name]) return names
  for (const [name, prototype] of pairs(prototypes.entity)) {
    if (!prototype || (prototype.type !== 'tree' && prototype.type !== 'simple-entity') || is_placed_building_prototype(prototype)) continue
    if (yields_item_product(prototype, product_name)) names.push(name)
  }
  return sort_strings(names)
}

function entity_details(prototype: any) {
  if (!prototype) return undefined
  const fluidboxes = fluidbox_details(prototype)
  const result: Record<string, unknown> = {
    name: prototype.name,
    type: prototype.type,
    is_building: prototype.is_building,
    energy_source: energy_source_kind(prototype),
    tile_width: prototype.tile_width,
    tile_height: prototype.tile_height,
    collision_box: prototype.collision_box,
    selection_box: prototype.selection_box,
    place_items: place_items(prototype),
    fluidboxes: fluidboxes.fluidboxes,
    fluidboxes_truncated: fluidboxes.truncated,
    // Native: the fluids this entity takes in or gives out, from fluidbox filters or (offshore pumps) the tile prototypes.
    fluid_io: fluidboxes.fluid_io,
    fluid_io_truncated: fluidboxes.fluid_io_truncated,
  }

  const mineable = mineable_details(prototype)
  if (mineable) result.mineable = mineable

  // Electric and fluid-throughput facts straight from the prototype: pole supply
  // area and wire reach, power in watts, burner fuel categories, pump and steam rates.
  const electric = electric_prototype_facts(prototype)
  for (const key in electric) result[key] = electric[key]

  if (prototype.crafting_categories) {
    result.crafting = {
      speed: rates.crafting_speed_of(prototype),
      categories: dictionary_keys(prototype.crafting_categories),
      ingredient_count: prototype.ingredient_count,
      energy_usage: prototype.energy_usage,
    }
  }
  if (prototype.type === 'mining-drill') {
    result.mining = {
      speed: prototype.mining_speed,
      radius: prototype.mining_drill_radius,
      resource_categories: dictionary_keys(prototype.resource_categories),
      energy_usage: prototype.energy_usage,
      vector_to_place_result: position_details(prototype.vector_to_place_result),
    }
  }
  if (prototype.belt_speed !== undefined) {
    result.belt = {
      speed: prototype.belt_speed,
      max_underground_distance: prototype.max_underground_distance,
    }
  }
  if (prototype.type === 'inserter') {
    result.inserter = {
      pickup_position: prototype.inserter_pickup_position,
      drop_position: prototype.inserter_drop_position,
      allow_custom_vectors: prototype.allow_custom_vectors,
      bulk: prototype.bulk,
      max_belt_stack_size: prototype.inserter_max_belt_stack_size,
      energy_usage: prototype.energy_usage,
    }
  }

  return result
}

function item_details(prototype: any) {
  if (!prototype) return undefined
  return {
    name: prototype.name,
    stack_size: prototype.stack_size,
    place_result: prototype.place_result?.name,
    fuel_category: prototype.fuel_category,
    fuel_value: prototype.fuel_value,
    burnt_result: prototype.burnt_result?.name,
  }
}

function fluid_details(prototype: any) {
  if (!prototype) return undefined
  return {
    name: prototype.name,
    default_temperature: prototype.default_temperature,
    max_temperature: prototype.max_temperature,
    heat_capacity: prototype.heat_capacity,
    fuel_value: prototype.fuel_value,
  }
}


export function energy_source_kind(prototype: any): PrototypeEnergySource {
  if (prototype?.burner_prototype) return 'burner'
  if (prototype?.electric_energy_source_prototype) return 'electric'
  if (prototype?.heat_energy_source_prototype) return 'heat'
  if (prototype?.fluid_energy_source_prototype) return 'fluid'
  if (prototype?.void_energy_source_prototype) return 'void'
  return 'none'
}

function enabled_item_recipes(actor: ControlledActor) {
  const result: Record<string, string> = {}
  for (const [recipe_name, recipe] of pairs(actor.force.recipes)) {
    if (!recipe || recipe.enabled !== true || recipe.hidden === true) continue
    for (const [, product] of pairs((recipe.products ?? {}) as Record<number, any>)) {
      if (product?.type !== 'item' || typeof product?.name !== 'string') continue
      const existing = result[product.name]
      if (!existing || recipe_name < existing) result[product.name] = recipe_name
    }
  }
  return result
}

function inventory_counts(actor: ControlledActor) {
  const result: Record<string, number> = {}
  for (const item of get_actor_inventory_items(actor)) result[item.name] = item.count
  return result
}

function discovery_limit(value: number | undefined) {
  if (value === undefined) return DEFAULT_DISCOVERY_LIMIT
  if (typeof value !== 'number' || value !== value || math.floor(value) !== value || value < 1 || value > MAX_DISCOVERY_LIMIT) return undefined
  return value
}

function discovery_error(request: PrototypeDiscoveryRequest, code: 'INVALID_REQUEST' | 'LIMIT_EXCEEDED', message: string, extra: Record<string, unknown> = {}) {
  return { ok: false, query: request, error: { code, message }, ...extra }
}

function discovery_candidates(request: PrototypeDiscoveryRequest) {
  let inferred_resource_category: string | undefined
  let matches: Record<string, any> = {}

  if (request.capability === 'mining') {
    const has_resource_name = typeof request.resource_name === 'string' && request.resource_name.length > 0
    const has_resource_category = typeof request.resource_category === 'string' && request.resource_category.length > 0
    if (has_resource_name === has_resource_category) {
      return { error: 'mining discovery requires exactly one of resource_name or resource_category' }
    }
    if (has_resource_name) {
      const resource = prototypes.entity[request.resource_name as string]
      if (!resource || resource.type !== 'resource' || !resource.resource_category) {
        return { error: 'resource_name must identify a current-game resource prototype' }
      }
      inferred_resource_category = resource.resource_category
    }
    else {
      inferred_resource_category = request.resource_category
      if (!inferred_resource_category || !prototypes.resource_category[inferred_resource_category]) {
        return { error: 'resource_category must identify a current-game resource category' }
      }
    }

    const drills = prototypes.get_entity_filtered([{ filter: 'type', type: 'mining-drill' }])
    for (const [name, prototype] of pairs(drills)) {
      if (prototype.resource_categories?.[inferred_resource_category] === true) matches[name] = prototype
    }
  }
  else if (request.capability === 'crafting') {
    if (!request.crafting_category || !prototypes.recipe_category[request.crafting_category]) {
      return { error: 'crafting discovery requires a current-game crafting_category' }
    }
    matches = prototypes.get_entity_filtered([{ filter: 'crafting-category', crafting_category: request.crafting_category }])
  }
  else if (request.capability === 'entity-type') {
    if (!request.entity_type) return { error: 'entity-type discovery requires entity_type' }
    matches = prototypes.get_entity_filtered([{ filter: 'type', type: request.entity_type }])
  }
  else if (request.capability === 'harvest') {
    if (!request.product_name || !prototypes.item[request.product_name]) {
      return { error: 'harvest discovery requires a current-game item product_name' }
    }
    for (const name of natural_harvest_source_names(request.product_name)) matches[name] = prototypes.entity[name]
  }
  else {
    return { error: 'unsupported discovery capability' }
  }

  const values: Array<{ name: string, prototype: any }> = []
  for (const [name, prototype] of pairs(matches)) {
    if (request.energy_source && energy_source_kind(prototype) !== request.energy_source) continue
    values.push({ name, prototype })
  }
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
  return { values, inferred_resource_category }
}

export function discover_prototypes_for_actor(actor: ControlledActor, request: PrototypeDiscoveryRequest) {
  const limit = discovery_limit(request?.limit)
  if (!request || limit === undefined) {
    return discovery_error(request ?? ({ capability: 'entity-type' } as PrototypeDiscoveryRequest), 'INVALID_REQUEST', `limit must be an integer from 1 to ${MAX_DISCOVERY_LIMIT}`)
  }
  const availability = request.availability ?? 'force-available'
  if (availability !== 'force-available' && availability !== 'all') {
    return discovery_error(request, 'INVALID_REQUEST', 'availability must be force-available or all')
  }

  const discovered = discovery_candidates(request)
  if (discovered.error) return discovery_error(request, 'INVALID_REQUEST', discovered.error)

  const enabled_recipes = enabled_item_recipes(actor)
  const inventory = inventory_counts(actor)
  const available: Array<Record<string, unknown>> = []
  const all = discovered.values ?? []
  const energy_sources: Record<string, boolean> = {}

  for (const { name, prototype } of all) {
    const energy_source = energy_source_kind(prototype)
    energy_sources[energy_source] = true

    if (request.capability === 'harvest') {
      const products = mineable_product_summaries(prototype)
      available.push({
        name,
        type: prototype.type,
        mineable_products: products.values,
        mineable_products_truncated: products.truncated,
      })
      continue
    }

    let held_count = 0
    let enabled_recipe: string | undefined
    const place_item_result = sorted_place_item_summaries(prototype, MAX_DISCOVERY_PLACE_ITEMS, (item) => {
      held_count += inventory[item.name] ?? 0
      const recipe_name = enabled_recipes[item.name]
      if (recipe_name && (!enabled_recipe || recipe_name < enabled_recipe)) enabled_recipe = recipe_name
    })
    const force_available = held_count > 0 || enabled_recipe !== undefined
    if (availability === 'force-available' && !force_available) continue

    const candidate: Record<string, unknown> = {
      name,
      type: prototype.type,
      energy_source,
      place_items: place_item_result.values,
      place_items_truncated: place_item_result.truncated,
      force_available,
    }
    if (held_count > 0) candidate.held_count = held_count
    if (enabled_recipe) candidate.enabled_recipe = enabled_recipe
    if (request.capability === 'mining') {
      candidate.mining_speed = prototype.mining_speed
      candidate.mining_radius = prototype.mining_drill_radius
    }
    else if (request.capability === 'crafting') {
      candidate.crafting_speed = rates.crafting_speed_of(prototype)
    }
    available.push(candidate)
  }

  if (available.length > limit && request.capability !== 'harvest') {
    const sources: string[] = []
    for (const [source] of pairs(energy_sources)) sources.push(source)
    sort_strings(sources)
    return discovery_error(request, 'LIMIT_EXCEEDED', `candidate count ${available.length} exceeds requested limit ${limit}; narrow by energy_source or raise limit up to ${MAX_DISCOVERY_LIMIT}`, {
      matched_count: all.length,
      available_count: available.length,
      max_limit: MAX_DISCOVERY_LIMIT,
      narrowing: { energy_sources: sources },
      inferred_resource_category: discovered.inferred_resource_category,
    })
  }

  const candidates = request.capability === 'harvest' && available.length > limit
    ? available.slice(0, limit)
    : available
  return {
    ok: true,
    query: request,
    inferred_resource_category: discovered.inferred_resource_category,
    matched_count: all.length,
    available_count: available.length,
    returned_count: candidates.length,
    truncated: candidates.length < available.length,
    candidates,
  }
}

export function prototype_details(name: string) {
  const item = prototypes.item[name]
  const fluid = prototypes.fluid[name]
  const direct_entity = prototypes.entity[name]
  const placed_entity = item?.place_result
  const entity = direct_entity ?? placed_entity

  if (!item && !fluid && !entity) {
    return { found: false, query: name, error: 'prototype not found as item, fluid, or entity' }
  }

  return {
    found: true,
    query: name,
    item: item_details(item),
    fluid: fluid_details(fluid),
    entity: entity_details(entity),
  }
}

export function create_prototype_knowledge_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_prototypes', {
    details: (name: string) => prototype_details(name),
    discover: (request: PrototypeDiscoveryRequest) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) return discovery_error(request, 'INVALID_REQUEST', 'controlled actor is unavailable')
      return discover_prototypes_for_actor(actor, request)
    },
  })
}
