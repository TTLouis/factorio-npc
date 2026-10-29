import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bind_factory_world_id, factory_world_identity, observe_factory_cell } from './factory_cell_observation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

const WORLD = '5db29844-e821-4c04-8329-177b64ef17e2'
const FOREIGN = 'b3161b9b-e637-4cb9-84eb-f0104d4b65f6'
const G = globalThis as any
const originalStorage = G.storage
const originalPrototypes = G.prototypes
let actor: any, machine: any, resource: any, surface: any, request: any, visible: boolean, scan: any
beforeEach(() => {
  G.storage = {}
  G.prototypes = { ...originalPrototypes, entity: { ...originalPrototypes.entity,
    'test-drill': { collision_box: { left_top: { x: -1, y: -1 }, right_bottom: { x: 1, y: 1 } } } } }
  visible = true
  const force = { index: 1, is_chunk_visible: () => visible }
  scan = vi.fn((filter: any) => filter.type === 'resource' ? [resource] : [machine])
  surface = { index: 1, find_entities_filtered: scan }
  resource = { valid: true, type: 'resource', name: 'strange-native-resource', amount: 888, position: { x: 1, y: 0 },
    prototype: { resource_category: 'ore', mineable_properties: { products: [{ type: 'item', name: 'copper-ore', amount: 1 }] } } }
  machine = { valid: true, type: 'mining-drill', name: 'test-drill', unit_number: 7, direction: 0, position: { x: 0, y: 0 },
    surface, force, status: 2, energy: 0, fluidbox: { length: 0 }, drop_position: { x: 0, y: 2 },
    prototype: { mining_drill_radius: 1.5, resource_categories: { ore: true } } }
  actor = { is_valid: true, surface, force, status_snapshot: () => ({ actor_id: 4 }) }
  request = { schema_version: 1, request_id: 'native-test', world_id: WORLD, actor_id: 4, surface_index: 1, force_index: 1,
    members: [{ unit_number: 7, name: 'test-drill', position: { x: 0, y: 0 }, surface_index: 1, force_index: 1 }] }
})
afterEach(() => { G.storage = originalStorage; G.prototypes = originalPrototypes })
const observe = () => observe_factory_cell(actor, request, true) as any

describe('persistent native factory world identity', () => {
  it('does not initialize while reading and refuses non-UUID identities', () => {
    expect(factory_world_identity()).toMatchObject({ ok: false, code: 'world_unbound' })
    expect(G.storage).toEqual({})
    expect(bind_factory_world_id('seed-42')).toMatchObject({ ok: false, code: 'invalid_world_id' })
    expect(G.storage).toEqual({})
  })
  it('binds once, resumes the persisted identity and refuses replacement/corrupt state', () => {
    expect(bind_factory_world_id(WORLD)).toMatchObject({ ok: true, world_id: WORLD })
    G.storage = JSON.parse(JSON.stringify(G.storage))
    expect(factory_world_identity()).toMatchObject({ world_id: WORLD })
    expect(bind_factory_world_id(WORLD).ok).toBe(true)
    expect(bind_factory_world_id(FOREIGN)).toMatchObject({ ok: false, code: 'world_identity_mismatch', world_id: WORLD })
    G.storage.sgluna_factory_world_id = 'corrupt'
    expect(bind_factory_world_id(WORLD)).toMatchObject({ ok: false, code: 'world_identity_corrupt' })
    expect(G.storage.sgluna_factory_world_id).toBe('corrupt')
  })
})
describe('bounded native factory cell facts', () => {
  beforeEach(() => { bind_factory_world_id(WORLD) })
  describe('fresh native burner fuel requirements', () => {
    const requirement = () => observe().members[0].burner_fuel_requirement
    beforeEach(() => {
      // This member has no other prototype-dependent projections, so getter
      // faults below exercise precisely the new protected requirement read.
      machine.type = 'simple-entity'
    })
    it('sorts only true native dictionary keys, without supply or automation claims or storage writes', () => {
      machine.prototype.burner_prototype = { fuel_categories: { 'test-z': true, 'test-no': false, 'test-a': true } }
      const before = JSON.stringify(G.storage)
      expect(requirement()).toEqual({ state: 'known', required: true, fuel_categories: ['test-a', 'test-z'], truncated: false,
        scope: 'burner_fuel_only', supply: 'unverified', delivery: 'unverified', external_source: 'unverified' })
      machine.prototype.burner_prototype.fuel_categories = { 'test-fresh': true }
      expect(requirement().fuel_categories).toEqual(['test-fresh'])
      expect(JSON.stringify(G.storage)).toBe(before)
    })
    it('keeps an empty or all-false category set required and distinguishes successful nil', () => {
      for (const fuel_categories of [{}, { 'test-no': false }]) {
        machine.prototype.burner_prototype = { fuel_categories }
        expect(requirement()).toMatchObject({ state: 'known', required: true, fuel_categories: [], truncated: false })
      }
      delete machine.prototype.burner_prototype
      expect(requirement()).toMatchObject({ state: 'not_applicable', required: false, fuel_categories: [], truncated: false })
    })
    it('keeps prototype and burner getter failures unknown instead of treating them as native nil', () => {
      const raises = () => { throw new Error('unreadable native property') }
      Object.defineProperty(machine.prototype, 'burner_prototype', { get: raises })
      expect(requirement()).toMatchObject({ state: 'unknown', required: 'unknown', code: 'burner_prototype_unreadable' })
      Object.defineProperty(machine, 'prototype', { get: raises })
      expect(requirement()).toMatchObject({ state: 'unknown', required: 'unknown', code: 'burner_prototype_unreadable' })
    })
    it('retains required true after category getter or entry reads fail', () => {
      const raises = () => { throw new Error('unreadable category') }
      machine.prototype.burner_prototype = Object.defineProperty({}, 'fuel_categories', { get: raises })
      expect(requirement()).toMatchObject({ state: 'unknown', required: true, code: 'fuel_categories_unreadable' })
      machine.prototype.burner_prototype = { fuel_categories: Object.defineProperty({}, 'test-category', { enumerable: true, get: raises }) }
      expect(requirement()).toMatchObject({ state: 'unknown', required: true, fuel_categories: [], code: 'fuel_categories_unreadable' })
    })
    it('rejects malformed prototypes, category containers and nonboolean entries without inventing absence', () => {
      for (const burner of [false, 3, 'invalid', null, () => ({})]) {
        machine.prototype.burner_prototype = burner
        expect(requirement()).toMatchObject({ state: 'unknown', required: 'unknown', code: 'burner_prototype_malformed' })
      }
      for (const fuel_categories of [undefined, null, false, 3, 'invalid', () => ({}), [true], { '': true }, { 'test-category': 1 }, { 'test-category': 'true' }]) {
        machine.prototype.burner_prototype = { fuel_categories }
        expect(requirement()).toMatchObject({ state: 'unknown', required: true, fuel_categories: [], code: 'fuel_categories_malformed' })
      }
    })
    it('bounds dictionary traversal and name width and marks incomplete sets unknown', () => {
      const fuel_categories = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`test-${i}`, true]))
      machine.prototype.burner_prototype = { fuel_categories }
      expect(requirement()).toMatchObject({ state: 'known', required: true, truncated: false })
      expect(requirement().fuel_categories).toHaveLength(32)
      const overCapRead = vi.fn(() => { throw new Error('must stop before reading the extra value') })
      Object.defineProperty(fuel_categories, 'test-over-cap', { enumerable: true, get: overCapRead })
      expect(requirement()).toMatchObject({ state: 'unknown', required: true, truncated: true, fuel_categories: [], code: 'fuel_categories_truncated' })
      expect(overCapRead).not.toHaveBeenCalled()
      machine.prototype.burner_prototype.fuel_categories = { ['x'.repeat(160)]: true }
      expect(requirement()).toMatchObject({ state: 'known', required: true, truncated: false })
      machine.prototype.burner_prototype.fuel_categories = { ['x'.repeat(161)]: true }
      expect(requirement()).toMatchObject({ state: 'unknown', required: true, truncated: true, fuel_categories: [], code: 'fuel_category_name_truncated' })
    })
    it('does not touch the member prototype for hidden or busy observations or create an actor', () => {
      const read = vi.fn(() => { throw new Error('fenced prototype must not be read') })
      Object.defineProperty(machine, 'prototype', { get: read })
      const before = JSON.stringify(G.storage)
      visible = false
      expect(observe().members[0]).toMatchObject({ state: 'unknown', code: 'member_not_visible' })
      visible = true
      expect(observe_factory_cell(actor, request, false)).toMatchObject({ ok: false, code: 'native_busy' })
      expect(observe_factory_cell(undefined, request, true)).toMatchObject({ ok: false, code: 'actor_identity_mismatch' })
      expect(read).not.toHaveBeenCalled()
      expect(scan).not.toHaveBeenCalled()
      expect(JSON.stringify(G.storage)).toBe(before)
    })
  })
  it('refuses real busy crafting without taking the full snapshot or reconciling its actor', () => {
    const mutatingActorGetter = vi.fn(() => { throw new Error('factory observation cannot reconcile/create the actor') })
    const manager = new_task_manager(mutatingActorGetter)
    const snapshot = vi.spyOn(manager, 'get_status_snapshot')
    const freshStorage = JSON.stringify(G.storage)
    expect(manager.is_idle_for_observation()).toBe(true)
    expect(JSON.stringify(G.storage), 'fresh idle checks do not initialize batch generation or execution storage').toBe(freshStorage)
    manager.initialize()
    manager.player_state.task_state = TaskStates.CRAFTING
    manager.player_state.parameters_craft_item = { type: TaskStates.CRAFTING, item_name: 'iron-plate', count: 1, crafted: 0, started: true } as any
    const craftingStorage = JSON.stringify(G.storage)
    expect(observe_factory_cell(actor, request, manager.is_idle_for_observation())).toMatchObject({ ok: false, code: 'native_busy' })
    expect(snapshot).not.toHaveBeenCalled()
    expect(mutatingActorGetter).not.toHaveBeenCalled()
    expect(JSON.stringify(G.storage)).toBe(craftingStorage)
    expect(scan).not.toHaveBeenCalled()
    manager.player_state.task_state = TaskStates.IDLE
    G.storage.sgluna_task_execution.task_queue.push({ type: TaskStates.WAITING })
    expect(manager.is_idle_for_observation()).toBe(false)
    G.storage.sgluna_task_execution.task_queue.length = 0
    G.storage.sgluna_task_execution.active_batch_id = 1
    expect(manager.is_idle_for_observation()).toBe(false)
    delete G.storage.sgluna_task_execution.active_batch_id
    expect(manager.is_idle_for_observation()).toBe(true)
    expect(snapshot).not.toHaveBeenCalled()
    expect(mutatingActorGetter).not.toHaveBeenCalled()
  })
  it('reads live mineable products rather than assuming a resource name is its product, without storage writes', () => {
    const before = JSON.stringify(G.storage)
    const result = observe()
    expect(result).toMatchObject({ ok: true, request_id: 'native-test', world_id: WORLD, actor_id: 4 })
    expect(result.members[0].source_resources).toMatchObject({ state: 'known', truncated: false,
      resources: [{ name: 'strange-native-resource', products: [{ type: 'item', name: 'copper-ore' }] }] })
    expect(JSON.stringify(G.storage)).toBe(before)
    expect(scan.mock.calls[1][0]).toMatchObject({ limit: 65, area: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } } })
  })
  it('rejects world, actor, scope, busy, malformed and excessive requests before native scans', () => {
    expect(observe_factory_cell(actor, { ...request, world_id: FOREIGN }, true)).toMatchObject({ ok: false, code: 'world_identity_mismatch' })
    expect(observe_factory_cell(actor, { ...request, actor_id: 5 }, true)).toMatchObject({ ok: false, code: 'actor_identity_mismatch' })
    expect(observe_factory_cell(actor, { ...request, force_index: 3 }, true)).toMatchObject({ ok: false, code: 'scope_mismatch' })
    expect(observe_factory_cell(actor, request, false)).toMatchObject({ ok: false, code: 'native_busy' })
    expect(observe_factory_cell(actor, { ...request, members: {} }, true)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(observe_factory_cell(actor, { ...request, members: Array.from({ length: 33 }).fill(request.members[0]) }, true)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(observe_factory_cell(actor, { ...request, members: [request.members[0], request.members[0]] }, true)).toMatchObject({ ok: false, code: 'invalid_members' })
    expect(scan).not.toHaveBeenCalled()
  })
  it('does not scan hidden members or substitute an identical replacement', () => {
    visible = false
    expect(observe().members[0]).toMatchObject({ state: 'unknown', code: 'member_not_visible' })
    expect(scan).not.toHaveBeenCalled()
    visible = true; machine.unit_number = 8
    expect(observe().members[0]).toMatchObject({ state: 'unknown', code: 'member_not_found' })
  })
  it('marks a resource area outside current visibility unknown before scanning it', () => {
    machine.prototype.mining_drill_radius = 32
    actor.force.is_chunk_visible = (_surface: unknown, chunk: any) => chunk.x >= -1 && chunk.x <= 0 && chunk.y >= -1 && chunk.y <= 0
    machine.position = { x: 1, y: 1 }; request.members[0].position = machine.position
    const result = observe().members[0]
    expect(result.state).toBe('observed')
    expect(result.source_resources).toMatchObject({ state: 'unknown', code: 'resource_area_not_visible' })
    expect(scan).toHaveBeenCalledTimes(1)
  })
  it('reports resource and product truncation explicitly and excludes unsupported categories', () => {
    scan.mockImplementation((filter: any) => filter.type === 'resource' ? Array.from({ length: 65 }).fill(resource) : [machine])
    resource.prototype.mineable_properties.products = Array.from({ length: 25 }).fill({ type: 'item', name: 'live-product' })
    const facts = observe().members[0].source_resources
    expect(facts.truncated).toBe(true); expect(facts.resources).toHaveLength(64)
    expect(facts.resources[0].products_truncated).toBe(true); expect(facts.resources[0].products).toHaveLength(24)
    resource.prototype.resource_category = 'other'
    expect(observe().members[0].source_resources.resources).toEqual([])
  })
  it('returns exact native drop targets without treating the route as item delivery', () => {
    const target = { ...machine, name: 'furnace', type: 'furnace', unit_number: 9, position: { x: 0, y: 2 } }
    machine.drop_target = target
    expect(observe().members[0].item_routes).toMatchObject({ state: 'known', routes: [{ kind: 'drop', state: 'connected', target: {
      unit_number: 9, name: 'furnace', surface_index: 1, force_index: 1, position: { x: 0, y: 2 } } }] })
    machine.drop_position = { x: 500, y: 500 }
    actor.force.is_chunk_visible = (_surface: unknown, chunk: any) => math.abs(chunk.x) < 2 && math.abs(chunk.y) < 2
    const read = vi.fn(() => { throw new Error('hidden target must never be read') })
    Object.defineProperty(machine, 'drop_target', { get: read })
    expect(observe().members[0].item_routes.routes[0]).toMatchObject({ state: 'unknown', code: 'route_not_visible' })
    expect(read).not.toHaveBeenCalled()
  })
  it('reads machine recipes and inventory from the engine and bounds each list', () => {
    machine.type = 'assembling-machine'
    machine.get_recipe = () => [{ name: 'native-process', ingredients: [{ type: 'item', name: 'ore', amount: 7 }], products: [{ type: 'fluid', name: 'liquid', amount: 9 }] }]
    machine.get_inventory = () => ({ valid: true, get_contents: () => Array.from({ length: 25 }).fill({ name: 'ore', count: 2, quality: 'normal' }) })
    const row = observe().members[0]
    expect(row.recipe).toMatchObject({ state: 'known', name: 'native-process', products: [{ type: 'fluid', name: 'liquid', amount: 9 }], truncated: false })
    expect(row.inventories[0]).toMatchObject({ role: 'input', state: 'known', truncated: true })
    expect(row.inventories[0].items).toHaveLength(24)
  })
  it('routes protected requirement reads through the real observe boundary and isolates getter failures', () => {
    machine.type = 'assembling-machine'
    machine.get_inventory = () => undefined
    machine.get_recipe = () => [{ name: 'synthetic-live-process', ingredients: [{ type: 'item', name: 'synthetic-feed', amount: 2 }], products: [] }]
    const before = JSON.stringify(G.storage)
    expect(observe().members[0].input_requirements.material).toMatchObject({ state: 'known', inputs: [{ kind: 'item', name: 'synthetic-feed', amount: 2 }] })
    Object.defineProperty(machine.prototype, 'electric_energy_source_prototype', { get: () => { throw new Error('synthetic power getter failure') } })
    const read = observe().members[0]
    expect(read.input_requirements.material.state).toBe('known')
    expect(read.input_requirements.power).toMatchObject({ state: 'unknown', code: 'energy_source_unreadable' })
    machine.get_recipe = () => { throw new Error('synthetic recipe getter failure') }
    expect(observe().members[0]).toMatchObject({ recipe: { state: 'unknown' }, input_requirements: { material: { state: 'unknown', code: 'current_recipe_unreadable' }, fluid: { state: 'unknown' } } })
    expect(JSON.stringify(G.storage)).toBe(before)
    const fencedRead = vi.fn(() => { throw new Error('must not read fenced requirements') })
    machine.get_recipe = fencedRead
    visible = false
    expect(observe().members[0].input_requirements).toBeUndefined()
    visible = true
    expect((observe_factory_cell(actor, request, false) as any).members).toBeUndefined()
    expect((observe_factory_cell(actor, { ...request, world_id: FOREIGN }, true) as any).members).toBeUndefined()
    expect(fencedRead).not.toHaveBeenCalled()
  })
  it('does not disclose hidden or oversized belt neighbour positions or identities', () => {
    machine.type = 'transport-belt'
    actor.force.is_chunk_visible = (_surface: unknown, chunk: any) => chunk.x >= -1 && chunk.x <= 0 && chunk.y >= -1 && chunk.y <= 0
    for (const target of [
      { valid: true, position: { x: 500, y: 500 } },
      { valid: true, position: { x: 1, y: 0 }, bounding_box: { left_top: { x: 0, y: -1 }, right_bottom: { x: 200, y: 1 } } },
    ]) {
      const identityRead = vi.fn(() => { throw new Error('hidden neighbour identity must not be read') })
      Object.defineProperty(target, 'unit_number', { get: identityRead })
      machine.belt_neighbours = { inputs: [], outputs: [target] }
      const routes = observe().members[0].item_routes.routes
      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({ kind: 'belt_output', state: 'unknown', code: 'route_not_visible' })
      expect(routes[0].position).toBeUndefined()
      expect(routes[0].target).toBeUndefined()
      expect(identityRead).not.toHaveBeenCalled()
    }
  })
  it('retains explicit unknown when mining products or geometry cannot be proved', () => {
    resource.prototype.mineable_properties = {}
    expect(observe().members[0].source_resources).toMatchObject({ state: 'unknown', code: 'resource_products_unavailable' })
    machine.prototype.mining_drill_radius = 100
    expect(observe().members[0].source_resources).toMatchObject({ state: 'unknown', code: 'unsupported_mining_geometry' })
  })
})
