import type { LuaEntity, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { inspect_charted_entity, is_position_charted, is_position_visible, query_charted_entities, set_charted_machine_recipe } from './map_remote'

function make_surface(index = 1, name = 'nauvis') {
  return {
    index,
    name,
    valid: true,
    find_entities_filtered: vi.fn(() => []),
  } as unknown as LuaSurface
}

function make_actor(surface: LuaSurface, charted: Set<string>, visible: Set<string> = charted) {
  const force = {
    index: 1,
    name: 'player',
    recipes: {},
    is_chunk_charted: vi.fn((_surface: LuaSurface, chunk: { x: number, y: number }) => charted.has(`${chunk.x},${chunk.y}`)),
    is_chunk_visible: vi.fn((_surface: LuaSurface, chunk: { x: number, y: number }) => visible.has(`${chunk.x},${chunk.y}`)),
  }
  return {
    is_valid: true,
    surface,
    force,
    position: { x: 0, y: 0 },
    status_snapshot: () => ({ kind: 'standalone_character', valid: true, name: 'AIRI', position: { x: 0, y: 0 }, has_character: true }),
  } as unknown as ControlledActor
}

function empty_inventory() {
  return { is_empty: vi.fn(() => true) }
}

function make_entity(surface: LuaSurface, overrides: Partial<LuaEntity> = {}) {
  const entity = {
    valid: true,
    name: 'assembling-machine-1',
    type: 'assembling-machine',
    position: { x: 10, y: 10 },
    surface,
    force: { index: 1, name: 'player' },
    unit_number: 42,
    direction: 0,
    health: 300,
    operable: true,
    prototype: { crafting_categories: { crafting: true } },
    get_recipe: vi.fn(() => [undefined, 0.15]),
    set_recipe: vi.fn(() => []),
    is_crafting: vi.fn(() => false),
    get_fluid_count: vi.fn(() => 0),
    get_inventory: vi.fn(() => empty_inventory()),
    ...overrides,
  }
  return entity as unknown as LuaEntity
}

beforeEach(() => {
  ;(globalThis as any).game.get_surface = vi.fn()
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn()
  ;(globalThis as any).game.tick = 1234
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {}
})

describe('map-first remote control', () => {
  it('separates explored chart state from current Remote View visibility', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0', '-1,0']), new Set(['0,0']))

    expect(is_position_charted(actor, surface, { x: 1, y: 1 })).toBe(true)
    expect(is_position_visible(actor, surface, { x: 1, y: 1 })).toBe(true)
    expect(is_position_charted(actor, surface, { x: -1, y: 1 })).toBe(true)
    expect(is_position_visible(actor, surface, { x: -1, y: 1 })).toBe(false)
  })

  it('refuses map queries when none of the requested chunks are charted', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set())
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = query_charted_entities(actor, 1, 256, 256, 16, 8)

    expect(result).toMatchObject({
      ok: false,
      code: 'area_uncharted',
      entities: [],
      charted_chunks: 0,
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('does not read live entities from charted chunks that are currently fogged', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']), new Set())
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = query_charted_entities(actor, 1, 16, 16, 8, 8)

    expect(result).toMatchObject({
      ok: false,
      code: 'area_not_visible',
      charted_chunks: 1,
      visible_chunks: 0,
      entities: [],
    })
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('queries only visible chunk intersections and de-duplicates cross-boundary entities', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0', '1,0']), new Set(['0,0', '1,0']))
    const entity = make_entity(surface, { position: { x: 31.5, y: 8 }, unit_number: 1 })
    ;(surface.find_entities_filtered as any).mockReturnValue([entity])
    ;(globalThis as any).game.get_surface.mockReturnValue(surface)

    const result = query_charted_entities(actor, 1, 32, 8, 24, 8, 'assembling-machine-1')

    expect(result.ok).toBe(true)
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].unit_number).toBe(1)
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(2)
  })

  it('refuses exact entity inspection for charted but currently invisible entities', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']), new Set())
    const entity = make_entity(surface)
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    expect(inspect_charted_entity(actor, 42)).toEqual({
      ok: false,
      code: 'area_not_visible',
      unit_number: 42,
    })
  })

  it('sets an enabled compatible machine recipe remotely without physical-distance checks', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    ;(actor.force.recipes as any)['electronic-circuit'] = {
      name: 'electronic-circuit',
      enabled: true,
      category: 'crafting', additional_categories: [],
    }
    const entity = make_entity(surface)
    let recipe: { name: string } | undefined
    ;(entity.get_recipe as any).mockImplementation(() => [recipe, 0.15])
    ;(entity.set_recipe as any).mockImplementation((name: string) => {
      recipe = { name }
      return []
    })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = set_charted_machine_recipe(actor, 42, 'electronic-circuit')

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      code: 'completed',
      execution_mode: 'remote',
      unit_number: 42,
      recipe_name: 'electronic-circuit',
      removed_item_count: 0,
    })
    expect(entity.set_recipe).toHaveBeenCalledWith('electronic-circuit')
  })

  it('rejects a recipe change before Lua can displace recipe-dependent machine contents', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    ;(actor.force.recipes as any)['electronic-circuit'] = {
      name: 'electronic-circuit',
      enabled: true,
      category: 'crafting', additional_categories: [],
    }
    const entity = make_entity(surface, {
      get_inventory: vi.fn(() => ({ is_empty: vi.fn(() => false) }) as any),
    })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = set_charted_machine_recipe(actor, 42, 'electronic-circuit')

    expect(result).toMatchObject({
      accepted: false,
      completed: false,
      code: 'recipe_change_unsafe',
      execution_mode: 'remote',
    })
    expect(entity.set_recipe).not.toHaveBeenCalled()
  })

  it('treats a verified recipe mutation as success even if set_recipe returns an empty array', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    ;(actor.force.recipes as any)['electronic-circuit'] = {
      name: 'electronic-circuit',
      enabled: true,
      category: 'crafting', additional_categories: [],
    }
    const entity = make_entity(surface)
    let recipe: { name: string } | undefined
    ;(entity.get_recipe as any).mockImplementation(() => [recipe, 0.15])
    ;(entity.set_recipe as any).mockImplementation((name: string) => {
      recipe = { name }
      return []
    })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    expect(set_charted_machine_recipe(actor, 42, 'electronic-circuit')).toMatchObject({
      accepted: true,
      completed: true,
      code: 'completed',
      removed_item_count: 0,
    })
  })

  it('keeps remote mutations inside the owning force', () => {
    const surface = make_surface()
    const actor = make_actor(surface, new Set(['0,0']))
    const entity = make_entity(surface, { force: { index: 2, name: 'enemy' } as any })
    ;(globalThis as any).game.get_entity_by_unit_number.mockReturnValue(entity)

    const result = set_charted_machine_recipe(actor, 42, 'anything')

    expect(result).toMatchObject({
      accepted: false,
      completed: false,
      code: 'wrong_force',
      execution_mode: 'remote',
    })
    expect(entity.set_recipe).not.toHaveBeenCalled()
  })
})
