import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { product_probability } from './production_rates'
import { fluid_connection_state } from './fluid_connections'
import { protected_read } from './electric_facts'
import { inspect_removal, removal_inventory } from './entity_removal_receipt'
import { factory_input_requirements } from './factory_input_requirements'
import { factory_native_endpoints, factory_selected_quality } from './factory_native_endpoints'
import { factory_native_item_topology, factory_native_fuels, factory_native_progress } from './factory_native_activity'
import { factory_native_power_component } from './factory_native_power'
import { recipe_applicability } from './knowledge'
import { crafting_categories_support_recipe } from './recipe_categories'
import { area_known_visible } from './map_knowledge'
import { find_world_entities, is_npc_vision_entity } from './npc_vision'
import { rotate_cardinal, vector_xy } from './placement_geometry'
import { area_around, belt_link_area, entity_area, pipe_link_area, point_area, seen_link, seen_now } from './visible_reads'

// Internal host observation only. No assignment, commissioning or gameplay authority.
export const FACTORY_CELL_LIMITS = { members: 32, resources: 64, products: 24, inventory_items: 24, fluid_storages: 16, connections: 16, fuel_categories: 32, fuel_category_name: 160 }
export const FACTORY_STARTUP_LIMITS = { scanned_recipes: 4096, candidates: 16, categories: 32, surface_conditions: 32 }
interface Point { x: number, y: number }
export interface FactoryMemberLocator { unit_number: number, name: string, position: Point, surface_index: number, force_index: number }
export interface FactoryCellRequest {
  schema_version: 1
  request_id: string
  world_id: string
  actor_id: number
  surface_index: number
  force_index: number
  members: FactoryMemberLocator[]
}
declare const storage: { sgluna_factory_world_id?: string }

function finite(value: unknown): value is number {
  return typeof value === 'number' && value === value && value !== math.huge && value !== -math.huge
}
function positive_integer(value: unknown): value is number { return finite(value) && value > 0 && math.floor(value) === value }
function point(value: any): value is Point { return typeof value === 'object' && value !== null && finite(value.x) && finite(value.y) }
function member_name(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 }
function uuid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 36) return false
  for (let i = 0; i < value.length; i++) {
    if ([8, 13, 18, 23].includes(i)) { if (value[i] !== '-') return false }
    else if (!'0123456789abcdef'.includes(value[i])) return false
  }
  return value[14] === '4' && '89ab'.includes(value[19])
}
export function factory_world_identity() {
  const world_id = storage.sgluna_factory_world_id
  return { schema_version: 1, ok: uuid(world_id), code: world_id === undefined ? 'world_unbound' : uuid(world_id) ? 'ok' : 'world_identity_corrupt', world_id }
}
export function bind_factory_world_id(candidate: string) {
  if (!uuid(candidate)) return { schema_version: 1, ok: false, code: 'invalid_world_id' }
  const existing = factory_world_identity()
  if (existing.code !== 'world_unbound') return existing.ok && existing.world_id === candidate ? existing : { ...existing, ok: false, code: existing.ok ? 'world_identity_mismatch' : existing.code }
  storage.sgluna_factory_world_id = candidate
  return factory_world_identity()
}
function identity(entity: LuaEntity) {
  return { unit_number: entity.unit_number, name: entity.name, type: entity.type, position: { x: entity.position.x, y: entity.position.y },
    surface_index: entity.surface.index, force_index: entity.force.index, direction: entity.direction, mirrored: entity.mirroring, box: entity_area(entity) }
}
function valid_locator(value: any): value is FactoryMemberLocator {
  return typeof value === 'object' && value !== null && positive_integer(value.unit_number) && member_name(value.name)
    && point(value.position) && positive_integer(value.surface_index) && positive_integer(value.force_index)
}
function exact_entity(actor: ControlledActor, locator: FactoryMemberLocator) {
  if (locator.surface_index !== actor.surface.index || locator.force_index !== actor.force.index) return { code: 'scope_mismatch' }
  const prototype = prototypes.entity[locator.name]
  if (!prototype) return { code: 'prototype_unknown' }
  const box = prototype.collision_box
  const reach = math.max(math.abs(box.left_top.x), math.abs(box.left_top.y), math.abs(box.right_bottom.x), math.abs(box.right_bottom.y), 0.25)
  if (!finite(reach) || reach > 64) return { code: 'unsupported_footprint' }
  if (!area_known_visible(actor.force, actor.surface, area_around(locator.position, reach))) return { code: 'member_not_visible' }
  const candidates = find_world_entities(actor.surface, { position: locator.position, radius: 0.25, name: locator.name, force: actor.force, limit: 9 })
  if (candidates.length > 8) return { code: 'identity_scan_truncated' }
  for (const entity of candidates) {
    if (!entity.valid || is_npc_vision_entity(entity) || entity.unit_number !== locator.unit_number || entity.name !== locator.name
      || entity.position.x !== locator.position.x || entity.position.y !== locator.position.y
      || entity.surface.index !== locator.surface_index || entity.force.index !== locator.force_index) continue
    if (!area_known_visible(actor.force, actor.surface, entity_area(entity))) return { code: 'member_not_visible' }
    return { code: 'ok', entity }
  }
  return { code: 'member_not_found' }
}
function products(raw: any) {
  const result: Array<Record<string, unknown>> = []
  let truncated = false
  for (const value of raw ?? []) {
    if (result.length >= FACTORY_CELL_LIMITS.products) { truncated = true; break }
    result.push({ type: value.type, name: value.name, amount: value.amount, amount_min: value.amount_min, amount_max: value.amount_max, probability: product_probability(value), independent_probability: value.independent_probability, shared_probability: value.shared_probability })
  }
  return { values: result, truncated }
}
function recipe(entity: LuaEntity) {
  if (!['assembling-machine', 'furnace', 'rocket-silo'].includes(entity.type)) return { state: 'unsupported', ingredients: [], products: [], truncated: false }
  const [current, quality] = entity.get_recipe()
  if (!current) return { state: 'none', ingredients: [], products: [], truncated: false }
  const inputs = products(current.ingredients); const outputs = products(current.products)
  return { state: 'known', name: current.name, selected_quality: factory_selected_quality(quality), ingredients: inputs.values, products: outputs.values, truncated: inputs.truncated || outputs.truncated }
}
function startup_recipe_candidates(actor: ControlledActor, entity: LuaEntity, current: { state: string },
  held: Array<{ role?: string, state: string, truncated: boolean, items: Array<Record<string, unknown>> }>, budget: { scanned: number, candidates: number }) {
  const candidates: Array<Record<string, unknown>> = []
  const base = { schema_version: 1, tick: game.tick, basis: 'enabled_native_recipe_category_and_surface', limit_scope: 'observation_request', selection: 'unselected', commissioning: 'unverified' }
  let scanned_recipes = 0
  const result = (state: string, coverage: string, code: string, truncated = false) => ({ ...base, state, coverage, code, truncated,
    scanned_recipes, candidates, multiplicity: candidates.length > 1 ? 'multiple' : candidates.length === 1 ? 'single' : 'none' })
  if (entity.type !== 'furnace' || current.state === 'known') return result('not_applicable', 'complete', 'not_an_empty_unselected_furnace')
  if (current.state !== 'none') return result('unknown', 'partial', 'startup_selected_recipe_unreadable')
  try {
    if (!finite(entity.crafting_progress) || entity.status === undefined) return result('unknown', 'partial', 'startup_activity_unreadable')
    if (entity.crafting_progress !== 0 || entity.status === defines.entity_status.working) return result('not_applicable', 'complete', 'startup_process_active')
    for (const role of ['input', 'output']) {
      const matches = held.filter(row => row.role === role)
      if (matches.length !== 1 || matches[0].state !== 'known' || matches[0].truncated) return result('unknown', 'partial', 'startup_inventory_unreadable')
      if (matches[0].items.length !== 0) return result('not_applicable', 'complete', 'startup_inventory_not_empty')
    }
    const fluidboxes = entity.fluids_count
    if (!finite(fluidboxes) || fluidboxes < 0 || fluidboxes > FACTORY_CELL_LIMITS.fluid_storages) return result('unknown', 'partial', 'startup_fluidboxes_unbounded')
    for (let i = 1; i <= fluidboxes; i++) if (entity.get_fluid(i) !== undefined) return result('not_applicable', 'complete', 'startup_fluid_present')
    const supported = entity.prototype.crafting_categories
    if (!supported) return result('unknown', 'partial', 'startup_categories_unavailable')
    let category_count = 0
    for (const [name, allowed] of pairs(supported)) {
      category_count++
      if (category_count > FACTORY_STARTUP_LIMITS.categories) return result('unknown', 'partial', 'startup_categories_truncated', true)
      if (!member_name(name) || typeof allowed !== 'boolean') return result('unknown', 'partial', 'startup_categories_invalid')
    }
    if (!actor.force.recipes) return result('unknown', 'partial', 'startup_recipes_unavailable')
    let unresolved: string | undefined
    for (const [, candidate] of pairs(actor.force.recipes)) {
      scanned_recipes++
      budget.scanned++
      if (budget.scanned > FACTORY_STARTUP_LIMITS.scanned_recipes) return result('unknown', 'partial', 'startup_recipe_scan_truncated', true)
      if (candidate.enabled === false) continue
      if (candidate.enabled !== true) { unresolved ??= 'startup_recipe_enablement_unknown'; continue }
      const categories: readonly string[] | undefined = candidate.categories
      if (categories && categories.length > FACTORY_STARTUP_LIMITS.categories) return result('unknown', 'partial', 'startup_recipe_categories_truncated', true)
      if (!categories || categories.length === 0 || categories.some(value => !member_name(value))) { unresolved ??= 'startup_recipe_categories_unknown'; continue }
      if (!crafting_categories_support_recipe(supported, candidate)) continue
      const conditions = candidate.prototype?.surface_conditions
      if (conditions && conditions.length > FACTORY_STARTUP_LIMITS.surface_conditions) return result('unknown', 'partial', 'startup_surface_conditions_truncated', true)
      const applicability = recipe_applicability(actor, candidate)
      if (applicability.state === 'unavailable') continue
      if (applicability.state !== 'available') { unresolved ??= 'startup_recipe_applicability_unknown'; continue }
      if (!candidate.ingredients || !candidate.products || !member_name(candidate.name)) { unresolved ??= 'startup_recipe_details_unknown'; continue }
      const inputs = products(candidate.ingredients); const outputs = products(candidate.products)
      if (inputs.truncated || outputs.truncated) return result('unknown', 'partial', 'startup_recipe_details_truncated', true)
      if (!outputs.values.length || [...inputs.values, ...outputs.values].some(row => !['item', 'fluid'].includes(row.type as string) || !member_name(row.name))) {
        unresolved ??= 'startup_recipe_details_unknown'; continue
      }
      if (budget.candidates >= FACTORY_STARTUP_LIMITS.candidates) return result('unknown', 'partial', 'startup_candidates_truncated', true)
      candidates.push({ name: candidate.name, ingredients: inputs.values, products: outputs.values, applicability })
      budget.candidates++
    }
    candidates.sort((left, right) => (left.name as string) < (right.name as string) ? -1 : (left.name as string) > (right.name as string) ? 1 : 0)
    return unresolved ? result('unknown', 'partial', unresolved) : result('known', 'complete', 'ok')
  }
  catch { return result('error', 'partial', 'startup_recipe_getter_failed') }
}
function inventory(inventory: LuaInventory | undefined, role: string) {
  if (!inventory || !inventory.valid) return { role, state: 'unavailable', items: [], truncated: false }
  const items: Array<Record<string, unknown>> = []
  let truncated = false
  for (const value of inventory.get_contents()) {
    if (items.length >= FACTORY_CELL_LIMITS.inventory_items) { truncated = true; break }
    items.push({ name: value.name, count: value.count, quality: value.quality })
  }
  return { role, state: 'known', index: protected_read(() => inventory.index), items, truncated }
}
function inventories(entity: LuaEntity) {
  const result = []
  if (['assembling-machine', 'rocket-silo'].includes(entity.type)) {
    result.push(inventory(entity.get_inventory(defines.inventory.crafter_input), 'input'))
    result.push(inventory(entity.get_inventory(defines.inventory.crafter_output), 'output'))
  }
  if (entity.type === 'furnace') {
    result.push(inventory(entity.get_inventory(defines.inventory.crafter_input), 'input'))
    result.push(inventory(entity.get_inventory(defines.inventory.crafter_output), 'output'))
  }
  if (['container', 'logistic-container', 'infinity-container'].includes(entity.type)) result.push(inventory(entity.get_inventory(defines.inventory.chest), 'storage'))
  const burner = entity.burner
  if (burner) result.push(inventory(burner.inventory, 'fuel'))
  return result
}
function removal_readiness(actor: ControlledActor, entity: LuaEntity) {
  const base = { schema_version: 1, tick: game.tick, scope: 'exact_building_only', recovery_capacity: 'unknown' }
  const read = protected_read(() => {
    if (entity.prototype.is_building !== true) return { ...base, state: 'refused', code: 'removal_building_required' }
    const inventory = actor.get_main_inventory()
    if (!inventory?.valid) return { ...base, state: 'unknown', code: 'removal_actor_inventory_unavailable' }
    const inspected = inspect_removal(entity, inventory)
    if (inspected.ok) return { ...base, state: 'known', code: 'ok', recovery_capacity: 'verified', snapshot: inspected.snapshot, actor_inventory: inspected.actor }
    const refusal = ['removal_not_minable', 'removal_target_working', 'removal_process_in_flight', 'removal_contents_domain_unsupported',
      'removal_fluid_present', 'removal_item_unsupported', 'removal_products_unsupported', 'removal_inventory_full'].includes(inspected.code)
    return { ...base, state: refusal ? 'refused' : 'unknown', code: inspected.code }
  })
  return read ?? { ...base, state: 'unknown', code: 'removal_readiness_unreadable' }
}
// Keep typeof separate from the comparison: TSTL rewrites a direct object
// comparison as a table-only test, but native LuaObjects can be userdata.
function native_value_type(value: unknown): string { return typeof value }
function native_record(value: unknown): value is Record<string, unknown> {
  const kind = native_value_type(value)
  return value !== null && (kind === 'object' || kind === 'table' || kind === 'userdata')
}
function burner_fuel_requirement(entity: LuaEntity) {
  const base = { scope: 'burner_fuel_only', supply: 'unverified', delivery: 'unverified', external_source: 'unverified' }
  const unknown = (required: true | 'unknown', code: string, truncated = false) => ({ ...base,
    state: 'unknown', required, fuel_categories: [] as string[], truncated, code })
  // The wrapper distinguishes successful nil (no native burner) from a raised
  // getter. Do not use the convenience prototype projection's empty fallback.
  const read = protected_read(() => ({ burner: entity.prototype.burner_prototype }))
  if (!read) return unknown('unknown', 'burner_prototype_unreadable')
  if (read.burner === undefined) return { ...base, state: 'not_applicable', required: false, fuel_categories: [], truncated: false }
  if (!native_record(read.burner)) return unknown('unknown', 'burner_prototype_malformed')
  const categories = protected_read(() => {
    const raw: unknown = read.burner!.fuel_categories
    if (!native_record(raw)) return unknown(true, 'fuel_categories_malformed')
    // Empty Lua tables represent an empty dictionary too; a nonempty sequence
    // cannot be the native string-keyed category dictionary.
    if (Array.isArray(raw) && raw.length > 0) return unknown(true, 'fuel_categories_malformed')
    const values: string[] = []
    let entries = 0
    // Iterate the native boolean dictionary directly: bound work as well as
    // output. Never turn an incomplete set into evidence that fuel is absent.
    for (const name in raw) {
      if (entries >= FACTORY_CELL_LIMITS.fuel_categories) return unknown(true, 'fuel_categories_truncated', true)
      entries++
      if (typeof name !== 'string' || name.length === 0) return unknown(true, 'fuel_categories_malformed')
      if (name.length > FACTORY_CELL_LIMITS.fuel_category_name) return unknown(true, 'fuel_category_name_truncated', true)
      const accepted = (raw as Record<string, unknown>)[name]
      if (typeof accepted !== 'boolean') return unknown(true, 'fuel_categories_malformed')
      if (accepted) values.push(name)
    }
    values.sort()
    return { ...base, state: 'known', required: true, fuel_categories: values, truncated: false }
  })
  return categories ?? unknown(true, 'fuel_categories_unreadable')
}
function source_resources(actor: ControlledActor, entity: LuaEntity) {
  const empty = { resources: [], truncated: false }
  if (entity.type !== 'mining-drill') return { ...empty, state: 'not_applicable' }
  const prototype = entity.prototype
  const radius = prototype.mining_drill_radius
  if (!finite(radius) || radius <= 0 || radius > 32 || ![0, 4, 8, 12].includes(entity.direction)) return { ...empty, state: 'unknown', code: 'unsupported_mining_geometry' }
  const local_offset = vector_xy(prototype.radius_visualisation_specification?.offset) ?? { x: 0, y: 0 }
  const offset = rotate_cardinal({ x: entity.mirroring ? -local_offset.x : local_offset.x, y: local_offset.y }, entity.direction)
  const center = { x: entity.position.x + offset.x, y: entity.position.y + offset.y }
  const area = area_around(center, radius)
  if (!area_known_visible(actor.force, entity.surface, area)) return { ...empty, state: 'unknown', code: 'resource_area_not_visible' }
  const matches = find_world_entities(entity.surface, { area, type: 'resource', limit: FACTORY_CELL_LIMITS.resources + 1 })
  const resources = []
  let unknown = false
  for (const resource of matches.slice(0, FACTORY_CELL_LIMITS.resources)) {
    if (!resource.valid || resource.type !== 'resource') continue
    if (!area_known_visible(actor.force, entity.surface, entity_area(resource))) { unknown = true; continue }
    const category = resource.prototype.resource_category
    if (category === undefined || prototype.resource_categories === undefined) { unknown = true; continue }
    if (prototype.resource_categories[category] !== true) continue
    const mineable = resource.prototype.mineable_properties
    if (!mineable?.products) { unknown = true; continue }
    const yields = products(mineable.products)
    const fluid_read = protected_read(() => ({ required_fluid: mineable.required_fluid, fluid_amount: mineable.fluid_amount }))
    resources.push({ name: resource.name, position: { x: resource.position.x, y: resource.position.y }, amount: resource.amount,
      mining_fluid: fluid_read ? { state: 'known', ...fluid_read } : { state: 'unknown', code: 'mining_fluid_unreadable' },
      category, products: yields.values, products_truncated: yields.truncated })
  }
  return { state: unknown ? 'unknown' : 'known', code: unknown ? 'resource_products_unavailable' : undefined,
    radius, search_center: center, area, resources, truncated: matches.length > FACTORY_CELL_LIMITS.resources }
}
function item_routes(actor: ControlledActor, entity: LuaEntity) {
  const seen = seen_now(actor.force, entity.surface)
  const routes: Array<Record<string, unknown>> = []
  function add(kind: string, position: Point | undefined, read: () => LuaEntity | undefined, local_geometry = true) {
    const link = seen_link(seen, position ? point_area(position) : undefined, read)
    const target = link.seen ? link.entity : undefined
    // Drill/inserter endpoints are geometry of the visible source. A belt
    // neighbour's position belongs to that neighbour: expose it only inside
    // the exact target identity after its complete bounds pass visibility.
    routes.push({ kind, position: local_geometry ? position : undefined, state: !link.seen ? 'unknown' : target?.valid ? 'connected' : 'disconnected',
      code: !link.seen ? 'route_not_visible' : undefined, target: target?.valid ? identity(target) : undefined })
  }
  if (entity.type === 'inserter') add('pickup', entity.pickup_position, () => entity.pickup_target)
  if (entity.type === 'inserter' || entity.type === 'mining-drill') add('drop', entity.drop_position, () => entity.drop_target)
  let truncated = false
  if (['transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt'].includes(entity.type)) {
    const area = belt_link_area(entity)
    if (!area || !seen(area)) return { state: 'unknown', code: 'belt_route_not_visible_or_unbounded', routes, truncated: false }
    for (const kind of ['inputs', 'outputs'] as const) {
      const neighbours = entity.belt_neighbours[kind]
      truncated = truncated || neighbours.length > FACTORY_CELL_LIMITS.connections
      for (const target of neighbours.slice(0, FACTORY_CELL_LIMITS.connections)) add(kind === 'inputs' ? 'belt_input' : 'belt_output', target.position, () => target, false)
    }
    return { state: 'known', routes, truncated }
  }
  return { state: routes.length > 0 ? 'known' : 'not_applicable', routes, truncated }
}
function fluids(actor: ControlledActor, entity: LuaEntity) {
  const storages = []
  let unresolved: string | undefined
  const fluidbox = entity
  const seen = seen_now(actor.force, entity.surface)
  for (let index = 1; index <= math.min(fluidbox.fluids_count, FACTORY_CELL_LIMITS.fluid_storages); index++) {
    const raw = (fluidbox.get_fluid_box_pipe_connections(index) ?? [])
    const connections = []
    for (const connection of raw.slice(0, FACTORY_CELL_LIMITS.connections)) {
      const link = seen_link(seen, pipe_link_area(entity, connection, index), () => connection.target)
      const hydraulic_state = link.seen ? fluid_connection_state(entity, index, connection) : 'unknown'
      if (hydraulic_state === 'separate') unresolved ??= 'fluid_segments_separate'
      if (hydraulic_state === 'unknown') unresolved ??= link.seen ? 'fluid_connection_unproven' : 'fluid_route_not_visible'
      connections.push({ state: hydraulic_state === 'joined' ? 'connected' : hydraulic_state === 'open' ? 'disconnected' : 'unknown',
        hydraulic_state, geometric_connected: link.seen ? connection.target !== undefined : undefined,
        code: hydraulic_state === 'separate' ? 'fluid_segments_separate' : hydraulic_state === 'unknown' ? 'fluid_connection_unproven' : undefined,
        target: link.seen && link.entity?.valid ? identity(link.entity) : undefined,
        target_fluidbox_index: link.seen ? connection.target_fluidbox_index : undefined,
        connection_type: connection.connection_type, flow_direction: connection.flow_direction })
    }
    storages.push({ index, current_fluid: entity.get_fluid(index), capacity: fluidbox.get_fluid_capacity(index), connections_truncated: raw.length > FACTORY_CELL_LIMITS.connections, connections })
  }
  return { state: unresolved ? 'unknown' : 'known', code: unresolved, storages, truncated: fluidbox.fluids_count > FACTORY_CELL_LIMITS.fluid_storages }
}
export function observe_factory_cell(actor: ControlledActor | undefined, request: FactoryCellRequest, idle: boolean) {
  const world = factory_world_identity()
  const base = { schema_version: 1, world_id: world.world_id, request_id: request?.request_id, tick: game.tick }
  const refuse = (code: string) => ({ ...base, ok: false, code })
  if (!world.ok) return refuse(world.code)
  if (!request || request.schema_version !== 1 || typeof request.request_id !== 'string' || request.request_id.length < 1 || request.request_id.length > 160
    || !positive_integer(request.actor_id) || !positive_integer(request.surface_index) || !positive_integer(request.force_index)
    || !Array.isArray(request.members) || request.members.length < 1 || request.members.length > FACTORY_CELL_LIMITS.members) return refuse('invalid_request')
  if (request.world_id !== world.world_id) return refuse('world_identity_mismatch')
  if (!actor || !actor.is_valid || actor.status_snapshot().actor_id !== request.actor_id) return refuse('actor_identity_mismatch')
  if (request.surface_index !== actor.surface.index || request.force_index !== actor.force.index) return refuse('scope_mismatch')
  if (!idle) return refuse('native_busy')
  const seen: Record<number, boolean> = {}
  for (const locator of request.members) {
    if (!valid_locator(locator) || seen[locator.unit_number]) return refuse('invalid_members')
    seen[locator.unit_number] = true
  }
  const startup_budget = { scanned: 0, candidates: 0 }
  const members = request.members.map(locator => {
    const resolved = protected_read(() => exact_entity(actor, locator)) ?? { code: 'member_identity_unreadable' }
    if (!resolved.entity) return { locator, state: 'unknown', code: resolved.code,
      absence_facts: resolved.code === 'member_not_found' ? { state: 'known', coverage: 'complete', scope: 'exact_locator', absent: true, truncated: false } : undefined }
    const entity = resolved.entity
    const energy = protected_read(() => entity.energy)
    const network = protected_read(() => entity.electric_network_id)
    const burner = burner_fuel_requirement(entity)
    const resources = protected_read(() => source_resources(actor, entity)) ?? { state: 'unknown', code: 'source_resources_unreadable', resources: [], truncated: false }
    const current_recipe = protected_read(() => recipe(entity)) ?? { state: 'unknown', code: 'recipe_unreadable', ingredients: [], products: [], truncated: false }
    const current_inventories = protected_read(() => inventories(entity)) ?? [{ state: 'unknown', code: 'inventories_unreadable', items: [], truncated: false }]
    const routes = protected_read(() => item_routes(actor, entity)) ?? { state: 'unknown', code: 'item_routes_unreadable', routes: [], truncated: false }
    return { locator, state: 'observed', ...identity(entity), status: entity.status,
      recipe: current_recipe, inventories: current_inventories,
      last_user_facts: { state: 'known', last_user: entity.last_user ? { name: entity.last_user.name } : null },
      startup_recipe_candidates: startup_recipe_candidates(actor, entity, current_recipe, current_inventories, startup_budget),
      burner_fuel_requirement: burner, input_requirements: factory_input_requirements(entity, burner, resources),
      fuel_item_facts: factory_native_fuels(burner),
      endpoint_facts: factory_native_endpoints(entity, current_inventories, routes, current_recipe),
      progress_facts: factory_native_progress(entity), ...factory_native_item_topology(actor, entity),
      electric_component_facts: factory_native_power_component(actor, entity),
      removal_readiness: removal_readiness(actor, entity),
      source_resources: resources,
      item_routes: routes,
      fluids: protected_read(() => fluids(actor, entity)) ?? { state: 'unknown', code: 'fluids_unreadable', storages: [], truncated: false },
      power: { state: energy === undefined && network === undefined ? 'unknown' : 'known', energy, electric_network_id: network } }
  })
  const actor_inventory = protected_read(() => {
    if (!remote.interfaces.sgluna_deployment?.status) return { state: 'unknown', code: 'actor_inventory_owner_unavailable' }
    const deployment: any = remote.call('sgluna_deployment', 'status')
    const session: unknown = deployment.session
    if (deployment.allowed !== true || deployment.actor_id !== request.actor_id || !positive_integer(deployment.epoch)
      || typeof session !== 'string' || session.length < 1 || session.length > 240) return { state: 'unknown', code: 'actor_inventory_owner_unverified' }
    const binding = { world_id: world.world_id, actor_id: request.actor_id, epoch: deployment.epoch, session, request_id: request.request_id, tick: game.tick }
    const got = protected_read(() => ({ inventory: actor.get_main_inventory() }))
    if (!got) return { state: 'error', code: 'actor_inventory_getter_failed', binding }
    if (!got.inventory?.valid) return { state: 'unknown', code: 'actor_inventory_unavailable', binding }
    const observed = protected_read(() => removal_inventory(got.inventory!))
    return observed ? { state: 'known', items: observed.items, binding } : { state: 'unknown', code: 'actor_inventory_unreadable_or_unsupported', binding }
  }) ?? { state: 'error', code: 'actor_inventory_owner_unreadable' }
  return { ...base, ok: true, code: 'ok', actor_id: request.actor_id, surface_index: request.surface_index, force_index: request.force_index, members, actor_inventory }
}
export function create_factory_cell_remote_interface(get_actor: () => ControlledActor | undefined, is_idle: () => boolean) {
  remote.add_interface('sgluna_factory', {
    world_identity: () => factory_world_identity(),
    bind_world_id: (candidate: string) => bind_factory_world_id(candidate),
    observe: (request: FactoryCellRequest) => observe_factory_cell(get_actor(), request, is_idle()),
  })
}
