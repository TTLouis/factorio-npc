import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import { protected_read } from './electric_facts'

// Software bounds. Endpoint facts identify current native slots/services, not
// commissioned ports, compatible suppliers, sustained supply or authority.
export const FACTORY_ENDPOINT_LIMITS = { inventories: 32, slots: 64, fluidboxes: 16, definitions: 16, name: 160 }
interface Fact { state: string, code?: string, truncated?: boolean, [key: string]: unknown }
const unknown = (code: string, truncated = false): Fact => ({ state: 'unknown', code, truncated })
const unreadable = (code: string): Fact => ({ state: 'error', code, truncated: false })
function finite(value: unknown): value is number { return typeof value === 'number' && value === value && value !== math.huge && value !== -math.huge }
function integer(value: unknown): value is number { return finite(value) && value >= 0 && math.floor(value) === value }
function name(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= FACTORY_ENDPOINT_LIMITS.name }
function long_name(value: unknown): boolean { return typeof value === 'string' && value.length > FACTORY_ENDPOINT_LIMITS.name }
function native_type(value: unknown): string { return typeof value }
function record(value: unknown): value is Record<string, any> {
  const kind = native_type(value)
  return value !== null && (kind === 'object' || kind === 'table' || kind === 'userdata')
}

export function factory_selected_quality(value: unknown): Fact {
  const result = protected_read(() => {
    if (value === undefined) return unknown('selected_quality_unavailable')
    if (record(value) && long_name(value.name)) return unknown('selected_quality_truncated', true)
    if (!record(value) || !name(value.name)) return unknown('selected_quality_malformed')
    return { state: 'known', name: value.name }
  })
  return result ?? unreadable('selected_quality_unreadable')
}

function slot_filters(inventory: LuaInventory): Fact {
  const result = protected_read(() => {
    const supports = inventory.supports_filters()
    if (supports === false) return { state: 'not_applicable', slots: [], truncated: false }
    if (supports !== true) return unknown('inventory_filter_support_malformed')
    const size = inventory.length
    if (!integer(size)) return unknown('inventory_size_malformed')
    if (size > FACTORY_ENDPOINT_LIMITS.slots) return unknown('inventory_filters_truncated', true)
    const slots: Array<Record<string, unknown>> = []
    for (let slot = 1; slot <= size; slot++) {
      const read = protected_read(() => ({ value: inventory.get_filter(slot) }))
      if (!read) { slots.push({ slot, ...unreadable('inventory_filter_unreadable') }); continue }
      if (read.value === undefined) { slots.push({ slot, state: 'known', filter: 'none' }); continue }
      const selector = protected_read(() => {
        const value: unknown = read.value
        if (!record(value)) return unknown('inventory_filter_malformed')
        for (const key of ['name', 'quality', 'comparator']) {
          if (long_name(value[key])) return unknown('inventory_filter_truncated', true)
          if (!name(value[key])) return unknown('inventory_filter_malformed')
        }
        // Observe the exact selector; do not evaluate its quality comparator.
        return { state: 'known', filter: { name: value.name, quality: value.quality, comparator: value.comparator } }
      }) ?? unreadable('inventory_filter_unreadable')
      slots.push({ slot, ...selector })
    }
    return { state: slots.some(slot => slot.state === 'error') ? 'error' : slots.some(slot => slot.state === 'unknown') ? 'unknown' : 'known', slots, truncated: slots.some(slot => slot.truncated === true) }
  })
  return result ?? unreadable('inventory_filters_unreadable')
}

function inventory_endpoints(entity: LuaEntity, observed: any[]): Fact {
  const result = protected_read(() => {
    const max = entity.get_max_inventory_index()
    if (!integer(max)) return unknown('inventory_bound_malformed')
    if (max > FACTORY_ENDPOINT_LIMITS.inventories) return unknown('inventory_endpoints_truncated', true)
    const endpoints: Array<Record<string, unknown>> = []
    let incomplete = false
    let failed = false
    for (let index = 1; index <= max; index++) {
      const read = protected_read(() => ({ inventory: entity.get_inventory(index) }))
      if (!read) { failed = true; endpoints.push({ inventory_index: index, ...unreadable('inventory_unreadable') }); continue }
      const inventory = read.inventory
      if (inventory === undefined) continue
      const entry = protected_read(() => {
        if (!inventory.valid || inventory.index !== index || !integer(inventory.length)) return { inventory_index: index, ...unknown('inventory_identity_malformed') }
        const roles = observed.filter(row => row.state === 'known' && row.index === index).map(row => row.role)
        const filters = slot_filters(inventory)
        return { state: 'known', endpoint_kind: 'inventory', inventory_index: index, size: inventory.length,
          roles: { state: roles.length > 0 ? 'known' : 'unknown', values: roles, code: roles.length > 0 ? undefined : 'inventory_role_unclassified' }, filters }
      }) ?? { inventory_index: index, ...unreadable('inventory_identity_unreadable') }
      if (entry.state === 'unknown') incomplete = true
      if (entry.state === 'error') failed = true
      endpoints.push(entry)
    }
    return { state: failed ? 'error' : incomplete ? 'unknown' : 'known', endpoints, truncated: false }
  })
  return result ?? unreadable('inventory_endpoints_unreadable')
}

function fluid_filter(read_filter: () => unknown, temperatures = true): Fact {
  const result = protected_read(() => {
    const value = read_filter()
    if (value === undefined) return { state: 'known', filter: 'none' }
    if (record(value) && long_name(value.name)) return unknown('fluid_filter_truncated', true)
    if (!record(value) || !name(value.name)) return unknown('fluid_filter_malformed')
    const filter: Record<string, unknown> = { name: value.name }
    for (const key of temperatures ? ['minimum_temperature', 'maximum_temperature'] : []) {
      if (value[key] !== undefined) {
        if (!finite(value[key])) return unknown('fluid_filter_temperature_malformed')
        filter[key] = value[key]
      }
    }
    return { state: 'known', filter }
  })
  return result ?? unreadable('fluid_filter_unreadable')
}

function fluid_definitions(entity: LuaEntity, index: number): Fact {
  const result = protected_read(() => {
    const raw: unknown = entity.fluidbox.get_prototype(index)
    if (!record(raw)) return unknown('fluidbox_prototypes_malformed')
    const definitions: Array<Record<string, unknown>> = []
    const values: Record<string, any> = raw.production_type !== undefined ? { single: raw } : raw
    for (const key in values) {
      if (definitions.length >= FACTORY_ENDPOINT_LIMITS.definitions) return unknown('fluidbox_prototypes_truncated', true)
      const value = values[key]
      if (!record(value) || !integer(value.index) || value.index < 1 || !['input', 'output', 'input-output', 'none'].includes(value.production_type)) return unknown('fluidbox_prototype_malformed')
      const filter = fluid_filter(() => value.filter, false)
      definitions.push({ prototype_index: value.index, production_type: value.production_type, filter })
    }
    if (definitions.length === 0) return unknown('fluidbox_prototypes_empty')
    return { state: 'known', definitions, truncated: false }
  })
  return result ?? unreadable('fluidbox_prototypes_unreadable')
}

function fluid_endpoints(entity: LuaEntity): Fact {
  const result = protected_read(() => {
    const fluidbox = entity.fluidbox
    const count = fluidbox.length
    if (!integer(count)) return unknown('fluidbox_bound_malformed')
    if (count > FACTORY_ENDPOINT_LIMITS.fluidboxes) return unknown('fluidbox_endpoints_truncated', true)
    const endpoints: Array<Record<string, unknown>> = []
    for (let index = 1; index <= count; index++) {
      const locked = protected_read(() => {
        const value = fluidbox.get_locked_fluid(index)
        if (long_name(value)) return unknown('locked_fluid_truncated', true)
        return value === undefined ? { state: 'known', locked: false } : name(value) ? { state: 'known', locked: true, name: value } : unknown('locked_fluid_malformed')
      }) ?? unreadable('locked_fluid_unreadable')
      endpoints.push({ state: 'known', endpoint_kind: 'fluidbox', fluidbox_index: index,
        prototypes: fluid_definitions(entity, index), filter: fluid_filter(() => fluidbox.get_filter(index)), locked_fluid: locked,
        recipe_association: unknown('recipe_endpoint_association_unverified') })
    }
    return { state: 'known', endpoints, truncated: false }
  })
  return result ?? unreadable('fluidbox_endpoints_unreadable')
}

function native_presence(read: () => unknown): Fact {
  const result = protected_read(() => {
    const value = read()
    if (value === undefined) return { state: 'known', present: false }
    return record(value) ? { state: 'known', present: true } : unknown('native_service_malformed')
  })
  return result ?? unreadable('native_service_unreadable')
}

function service_endpoints(entity: LuaEntity) {
  const electric = protected_read(() => {
    const source = entity.prototype.electric_energy_source_prototype
    if (source === undefined && entity.type !== 'electric-pole') return { state: 'not_applicable' }
    if (source !== undefined && (!record(source) || !name(source.usage_priority))) return unknown('electric_service_malformed')
    return { state: 'known', endpoint_kind: 'electricity', usage_priority: source?.usage_priority, pole: entity.type === 'electric-pole' }
  }) ?? unreadable('electric_service_unreadable')
  const network = protected_read(() => {
    const value = entity.electric_network_id
    if (value === undefined) return { state: 'known', present: false }
    return integer(value) && value > 0 ? { state: 'known', present: true, electric_network_id: value } : unknown('electric_network_malformed')
  }) ?? unreadable('electric_network_unreadable')
  const heat_source = native_presence(() => entity.prototype.heat_energy_source_prototype)
  const heat_buffer = native_presence(() => entity.prototype.heat_buffer_prototype)
  const heat = { state: heat_source.state === 'error' || heat_buffer.state === 'error' ? 'error'
    : heat_source.state === 'unknown' || heat_buffer.state === 'unknown' ? 'unknown'
    : heat_source.present === true || heat_buffer.present === true ? 'known' : 'not_applicable', endpoint_kind: 'heat', input_source: heat_source, buffer: heat_buffer }
  return { electricity: electric, heat, electric_network: { ...network, scope: 'current_observation_only', stable_endpoint: false }, supply: 'unverified' }
}

function drop_endpoint(entity: LuaEntity, routes: any): Fact {
  if (!['mining-drill', 'inserter'].includes(entity.type)) return { state: 'not_applicable' }
  if (routes.code === 'item_routes_unreadable') return unreadable('item_drop_route_unreadable')
  if (routes.state !== 'known' || routes.truncated !== false) return unknown('item_drop_route_unknown', routes.truncated === true)
  // Preserve the array type at this boundary so TSTL emits __TS__ArrayFilter,
  // not a call to a nonexistent native Lua table :filter method.
  const observed_routes: any[] = routes.routes
  const drops = observed_routes.filter(route => route.kind === 'drop')
  if (drops.length !== 1) return unknown('item_drop_route_unavailable')
  return { state: drops[0].state === 'unknown' ? 'unknown' : 'known', endpoint_kind: 'item_drop', routes: drops, target_inventory: 'unverified' }
}

export function factory_native_endpoints(entity: LuaEntity, observed_inventories: any[], routes: any, recipe: any) {
  const item_drop = drop_endpoint(entity, routes)
  const selection = recipe.state === 'known' ? { state: 'known', recipe: recipe.name, quality: recipe.selected_quality }
    : recipe.state === 'unsupported' ? { state: 'not_applicable' }
      : recipe.code === 'recipe_unreadable' ? unreadable('current_recipe_unreadable') : unknown('current_recipe_unset')
  return { schema_version: 1, identity_scope: 'enclosing_exact_member', inventories: inventory_endpoints(entity, observed_inventories),
    item_drop, fluidboxes: fluid_endpoints(entity), services: service_endpoints(entity), recipe_selection: selection,
    coverage: { state: 'partial', scope: 'current_native_endpoint_facts', quality_compatibility: 'unverified', recipe_endpoint_association: 'unverified',
      supplier: 'unverified', delivery: 'unverified', automation: 'unverified' } }
}
