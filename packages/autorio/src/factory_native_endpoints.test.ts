import { describe, expect, it, vi } from 'vitest'
import { factory_native_endpoints, factory_selected_quality } from './factory_native_endpoints'

const raises = () => { throw new Error('synthetic getter failure') }
function entity() {
  return { type: 'assembling-machine', prototype: {}, get_max_inventory_index: () => 0, get_inventory: () => undefined,
    fluids_count: 0, valid: true, has_fluid_segment: () => false, get_fluid: () => undefined, get_fluid_filter: () => undefined, electric_network_id: undefined } as any
}
const facts = (member: any, inventories: any[] = [], routes: any = { state: 'not_applicable', routes: [], truncated: false }, recipe: any = { state: 'none' }) => factory_native_endpoints(member, inventories, routes, recipe) as any

describe('bounded native endpoint facts', () => {
  it('uses successful inventory indexes and already observed roles; nil indexes are absent', () => {
    const member = entity()
    member.get_max_inventory_index = () => 3
    member.get_inventory = (index: number) => index === 2 ? { valid: true, index: 2, length: 1, supports_filters: () => false } : undefined
    const result = facts(member, [{ state: 'known', role: 'input', index: 2 }])
    expect(result.inventories).toEqual({ state: 'known', truncated: false, endpoints: [{ state: 'known', endpoint_kind: 'inventory', inventory_index: 2,
      size: 1, roles: { state: 'known', values: ['input'], code: undefined }, filters: { state: 'not_applicable', slots: [], truncated: false } }] })
    expect(facts(member).inventories.endpoints[0].roles).toMatchObject({ state: 'unknown', values: [] })
  })

  it('distinguishes getter exceptions, nil, inconsistent native identity and partial enumeration', () => {
    const member = entity()
    member.get_max_inventory_index = () => 3
    member.get_inventory = (index: number) => { if (index === 1) return raises(); return index === 2 ? { valid: true, index: 3, length: 1 } : undefined }
    expect(facts(member).inventories).toMatchObject({ state: 'error', endpoints: [
      { inventory_index: 1, state: 'error', code: 'inventory_unreadable' }, { inventory_index: 2, state: 'unknown', code: 'inventory_identity_malformed' },
    ] })
    member.get_max_inventory_index = raises
    expect(facts(member).inventories.code).toBe('inventory_endpoints_unreadable')
    expect(facts(member).fluidboxes).toMatchObject({ state: 'known', endpoints: [] })
  })

  it('bounds index and slot work before any excessive reads and preserves successful empty filters', () => {
    const member = entity()
    member.get_max_inventory_index = () => 33
    member.get_inventory = vi.fn()
    expect(facts(member).inventories).toMatchObject({ state: 'unknown', truncated: true })
    expect(member.get_inventory).not.toHaveBeenCalled()
    member.get_max_inventory_index = () => 1
    const inventory = { valid: true, index: 1, length: 65, supports_filters: () => true, get_filter: vi.fn(() => undefined) }
    member.get_inventory = () => inventory
    expect(facts(member).inventories.endpoints[0].filters).toMatchObject({ state: 'unknown', truncated: true })
    expect(inventory.get_filter).not.toHaveBeenCalled()
    inventory.length = 1
    expect(facts(member).inventories.endpoints[0].filters).toEqual({ state: 'known', slots: [{ slot: 1, state: 'known', filter: 'none' }], truncated: false })
    inventory.get_filter = vi.fn(raises)
    expect(facts(member).inventories.endpoints[0].filters).toMatchObject({ state: 'error', slots: [{ state: 'error', code: 'inventory_filter_unreadable' }] })
  })

  it('preserves merged prototype indexes separately from the runtime fluidbox and current filter', () => {
    const member = entity()
    Object.assign(member, { fluids_count: 1, get_fluid_box_prototype: () => [{ index: 3, production_type: 'output' }, { index: 4, production_type: 'output' }],
      get_fluid_filter: () => ({ name: 'native-fluid', minimum_temperature: 12, maximum_temperature: 34 }), get_fluid: () => ({ name: 'native-fluid' }) })
    const row = facts(member).fluidboxes.endpoints[0]
    expect(row).toMatchObject({ state: 'known', fluidbox_index: 1, prototypes: { state: 'known', definitions: [
      { prototype_index: 3, production_type: 'output' }, { prototype_index: 4, production_type: 'output' },
    ] }, filter: { state: 'known', filter: { name: 'native-fluid' } },
    locked_fluid: { state: 'known', locked: true, name: 'native-fluid' }, recipe_association: { state: 'unknown' } })
    member.get_fluid_filter = () => undefined
    member.get_fluid = () => undefined
    expect(facts(member).fluidboxes.endpoints[0]).toMatchObject({ filter: { state: 'known', filter: 'none' }, locked_fluid: { state: 'known', locked: false } })
  })

  it('reports fresh native item filter selectors without evaluating quality compatibility or defaulting missing quality', () => {
    const member = entity()
    let filter: any = { name: 'native-fuel', quality: 'native-quality', comparator: '=' }
    member.get_max_inventory_index = () => 1
    member.get_inventory = () => ({ valid: true, index: 1, length: 1, supports_filters: () => true, get_filter: () => filter })
    const selector = () => facts(member).inventories.endpoints[0].filters.slots[0]
    expect(selector()).toEqual({ slot: 1, state: 'known', filter })
    filter = { name: 'other-native-fuel', quality: 'other-quality', comparator: '>' }
    expect(selector().filter).toEqual(filter)
    filter = { name: 'native-fuel', comparator: '=' }
    expect(selector()).toMatchObject({ state: 'unknown', code: 'inventory_filter_malformed' })
    filter = { name: 'x'.repeat(161), quality: 'native-quality', comparator: '=' }
    expect(selector()).toMatchObject({ state: 'unknown', truncated: true })
  })

  it('keeps fluid subdomain errors independent and stops truncated enumeration', () => {
    const member = entity()
    Object.assign(member, { fluids_count: 1, get_fluid_box_prototype: () => ({ index: 1, production_type: 'input', filter: { name: 'native-fluid' } }),
      get_fluid_filter: raises, get_fluid: () => ({ name: 'native-fluid' }) })
    expect(facts(member).fluidboxes.endpoints[0]).toMatchObject({ prototypes: { state: 'known' }, filter: { state: 'error' }, locked_fluid: { state: 'unknown' } })
    member.get_fluid_filter = () => ({ name: 'x'.repeat(161) })
    expect(facts(member).fluidboxes.endpoints[0].filter).toMatchObject({ state: 'unknown', code: 'fluid_filter_truncated', truncated: true })
    member.get_fluid_box_prototype = () => ({ index: 1, production_type: 'input', filter: { name: 'x'.repeat(161) } })
    expect(facts(member).fluidboxes.endpoints[0].prototypes.definitions[0].filter).toMatchObject({ state: 'unknown', code: 'fluid_filter_truncated', truncated: true })
    member.get_fluid_filter = () => undefined
    member.get_fluid = () => ({ name: 'x'.repeat(161) })
    expect(facts(member).fluidboxes.endpoints[0].locked_fluid).toMatchObject({ state: 'unknown', code: 'locked_fluid_truncated', truncated: true })
    member.get_fluid = () => ({ name: '' })
    expect(facts(member).fluidboxes.endpoints[0].locked_fluid).toMatchObject({ state: 'unknown', code: 'locked_fluid_malformed', truncated: false })
    member.get_fluid = raises
    expect(facts(member).fluidboxes.endpoints[0].locked_fluid).toMatchObject({ state: 'unknown', code: 'locked_fluid_unavailable', truncated: false })
    member.get_fluid_box_prototype = () => Array.from({ length: 17 }, (_, i) => ({ index: i + 1, production_type: 'input' }))
    expect(facts(member).fluidboxes.endpoints[0].prototypes).toMatchObject({ state: 'unknown', truncated: true })
    member.fluids_count = 17
    member.get_fluid_box_prototype = vi.fn()
    expect(facts(member).fluidboxes).toMatchObject({ state: 'unknown', truncated: true })
    expect(member.get_fluid_box_prototype).not.toHaveBeenCalled()
  })

  it('reuses the visibility-fenced drop route without discovering or inventing a target inventory', () => {
    const member = entity()
    member.type = 'mining-drill'
    Object.defineProperty(member, 'drop_target', { get: raises })
    const route = { kind: 'drop', position: { x: 0, y: 1 }, state: 'connected', target: { unit_number: 77 } }
    expect(facts(member, [], { state: 'known', routes: [route], truncated: false }).item_drop).toEqual({ state: 'known', endpoint_kind: 'item_drop', routes: [route], target_inventory: 'unverified' })
    expect(facts(member, [], { state: 'known', routes: [{ ...route, state: 'unknown', target: undefined }], truncated: false }).item_drop).toMatchObject({ state: 'unknown' })
    expect(facts(member, [], { state: 'unknown', routes: [], truncated: false }).item_drop).toMatchObject({ state: 'unknown' })
    expect(facts(member, [], { state: 'known', routes: [route], truncated: true }).item_drop).toMatchObject({ state: 'unknown', truncated: true })
    expect(facts(member, [], { state: 'unknown', code: 'item_routes_unreadable', routes: [], truncated: false }).item_drop).toMatchObject({ state: 'error', code: 'item_drop_route_unreadable' })
    const pickup = { kind: 'pickup', state: 'connected', target: { unit_number: 88 } }
    member.type = 'inserter'
    expect(facts(member, [], { state: 'known', routes: [pickup, route], truncated: false }).item_drop.routes).toEqual([route])
  })

  it('separates electricity, heat, and ephemeral network evidence without a supply claim', () => {
    const member = entity()
    member.prototype = { electric_energy_source_prototype: { usage_priority: 'secondary-input' }, heat_energy_source_prototype: {}, heat_buffer_prototype: {} }
    member.electric_network_id = 9
    expect(facts(member).services).toMatchObject({ electricity: { state: 'known', endpoint_kind: 'electricity', usage_priority: 'secondary-input' },
      heat: { state: 'known', endpoint_kind: 'heat', input_source: { present: true }, buffer: { present: true } },
      electric_network: { state: 'known', electric_network_id: 9, stable_endpoint: false }, supply: 'unverified' })
    Object.defineProperty(member.prototype, 'electric_energy_source_prototype', { get: raises })
    expect(facts(member).services).toMatchObject({ electricity: { state: 'error' }, heat: { state: 'known' } })
    member.prototype = {}
    member.type = 'electric-pole'
    expect(facts(member).services.electricity).toMatchObject({ state: 'known', pole: true })
  })

  it('reads the actual selected quality without normal defaults or compatibility inference', () => {
    expect(factory_selected_quality({ name: 'synthetic-quality' })).toEqual({ state: 'known', name: 'synthetic-quality' })
    expect(factory_selected_quality(undefined)).toMatchObject({ state: 'unknown', code: 'selected_quality_unavailable' })
    expect(factory_selected_quality(Object.defineProperty({}, 'name', { get: raises }))).toMatchObject({ state: 'error', code: 'selected_quality_unreadable' })
    expect(factory_selected_quality({ name: 'x'.repeat(161) })).toMatchObject({ state: 'unknown', truncated: true })
    const member = entity()
    const selected = facts(member, [], undefined, { state: 'known', name: 'native-process', selected_quality: { state: 'known', name: 'synthetic-quality' } })
    expect(selected.recipe_selection).toMatchObject({ state: 'known', recipe: 'native-process', quality: { name: 'synthetic-quality' } })
    expect(selected.coverage).toMatchObject({ state: 'partial', quality_compatibility: 'unverified', supplier: 'unverified', delivery: 'unverified' })
    expect(facts(member).recipe_selection).toMatchObject({ state: 'unknown', code: 'current_recipe_unset' })
    expect(facts(member, [], undefined, { state: 'unsupported' }).recipe_selection).toEqual({ state: 'not_applicable' })
    expect(facts(member, [], undefined, { state: 'unknown', code: 'recipe_unreadable' }).recipe_selection).toMatchObject({ state: 'error', code: 'current_recipe_unreadable' })
  })

  it('retains native read errors separately from malformed, unsupported and absent services', () => {
    const member = entity()
    Object.defineProperty(member.prototype, 'heat_energy_source_prototype', { get: raises, configurable: true })
    Object.defineProperty(member, 'electric_network_id', { get: raises })
    expect(facts(member).services).toMatchObject({ electricity: { state: 'not_applicable' },
      heat: { state: 'error', input_source: { state: 'error', code: 'native_service_unreadable' }, buffer: { state: 'known', present: false } },
      electric_network: { state: 'error', code: 'electric_network_unreadable' } })
    Object.defineProperty(member.prototype, 'heat_energy_source_prototype', { value: false })
    expect(facts(member).services.heat).toMatchObject({ state: 'unknown', input_source: { state: 'unknown', code: 'native_service_malformed' } })
    Object.assign(member, { fluids_count: 1, get_fluid_box_prototype: raises, get_fluid_filter: () => undefined, get_fluid: () => undefined })
    expect(facts(member).fluidboxes.endpoints[0]).toMatchObject({ prototypes: { state: 'error', code: 'fluidbox_prototypes_unreadable' },
      filter: { state: 'known', filter: 'none' }, locked_fluid: { state: 'known', locked: false } })
  })
})
