import type { ControlledActor } from './actors/types'
import { describe, expect, it, vi } from 'vitest'
import { navigation_position_preflight } from './navigation_position_preflight'

function fixture() {
  const mask = { layers: { player: true } }
  const character = { valid: true, name: 'character', prototype: {
    collision_box: { left_top: { x: -0.2, y: -0.2 }, right_bottom: { x: 0.2, y: 0.2 } }, collision_mask: mask } }
  const furnace = { valid: true, name: 'modded-furnace', type: 'furnace', direction: 0, unit_number: 25,
    position: { x: 16, y: -96 }, prototype: { collision_mask: mask },
    bounding_box: { left_top: { x: 15.3, y: -96.7 }, right_bottom: { x: 16.7, y: -95.3 } } }
  const scan = vi.fn(() => [furnace])
  // By default the goal tile is plain ground and the engine finds a place to stand right at the goal.
  const find = vi.fn((_name: string, center: { x: number, y: number }, _radius?: number, _precision?: number) => ({ x: center.x, y: center.y }) as { x: number, y: number } | undefined)
  const get_tile = vi.fn((_x: number, _y: number) => ({ name: 'grass-1', prototype: { collision_mask: { layers: { ground_tile: true } } as { layers: Record<string, boolean> } | undefined } }))
  const can_place = vi.fn((_args: { name: string, position: { x: number, y: number }, force: unknown }) => true)
  const surface = { find_entities_filtered: scan, find_non_colliding_position: find, get_tile, can_place_entity: can_place }
  const actor = { is_valid: true, character, surface, force: { index: 1 } } as unknown as ControlledActor
  return { actor, character, furnace, scan, find, get_tile, can_place }
}

it('refuses a goal circle entirely inside a furnace/character collision expansion', () => {
  const f = fixture()
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 0.75 }))
    .toMatchObject({ ok: false, code: 'navigation_position_inside_furnace_collision', obstacle: { unit_number: 25 } })
  expect(f.scan).toHaveBeenCalledWith({ position: { x: 16, y: -96 }, radius: 16, type: 'furnace', limit: 64 })
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 1 })).toMatchObject({ ok: true })
  expect(navigation_position_preflight(f.actor, { x: 17.25, y: -96, reach_distance: 0.75 })).toMatchObject({ ok: true })
})

it('does not invent obstruction proofs for noncolliding, invalid or diagonally rotated targets', () => {
  const f = fixture(); const args = { x: 16, y: -96 }
  f.furnace.prototype.collision_mask = { layers: { object: true } } as any
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.prototype.collision_mask = f.character.prototype.collision_mask
  f.furnace.direction = 2
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.direction = 0; f.furnace.valid = false
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
  f.furnace.valid = true; f.furnace.bounding_box.left_top.x = Number.NaN
  expect(navigation_position_preflight(f.actor, args)).toMatchObject({ ok: true })
})

it('validates actor, finite position and native reach bounds before scanning', () => {
  const f = fixture()
  for (const args of [{ x: Number.NaN, y: 0 }, { x: 0, y: Infinity }, { x: 0, y: 0, reach_distance: 0.1 }, { x: 0, y: 0, reach_distance: 65 }]) {
    expect(navigation_position_preflight(f.actor, args).ok).toBe(false)
  }
  expect(navigation_position_preflight(undefined, { x: 0, y: 0 }).ok).toBe(false)
  expect(f.scan).not.toHaveBeenCalled()
})

it('defers mask self-exemption even across differently named prototypes', () => {
  const f = fixture()
  Object.assign(f.character.prototype.collision_mask, { not_colliding_with_itself: true })
  expect(f.character.name).not.toBe(f.furnace.name)
  expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 0.75 })).toMatchObject({ ok: true })
})

it('does not infer collision from empty character or furnace boxes', () => {
  const emptyCharacter = fixture()
  emptyCharacter.character.prototype.collision_box = { left_top: { x: 0, y: 0 }, right_bottom: { x: 0, y: 0 } }
  expect(navigation_position_preflight(emptyCharacter.actor, { x: 16, y: -96, reach_distance: 0.25 })).toMatchObject({ ok: true })
  const emptyFurnace = fixture()
  emptyFurnace.character.prototype.collision_box = { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } }
  emptyFurnace.furnace.bounding_box = { left_top: { x: 16, y: -96 }, right_bottom: { x: 16, y: -96 } }
  expect(navigation_position_preflight(emptyFurnace.actor, { x: 16, y: -96, reach_distance: 0.25 })).toMatchObject({ ok: true })
})

// AB-3 (18ab): the walk targeted a water tile; the pathfinder answered "no path" within milliseconds, four times.
describe('goal on a tile the character collides with', () => {
  const water = { x: 60, y: -36 }
  function tile(name: string, layers: Record<string, boolean> | undefined) {
    return { name, prototype: { collision_mask: layers ? { layers } : undefined } }
  }
  function drowned(f: ReturnType<typeof fixture>, nearest: { x: number, y: number } | null = { x: 59.5, y: -36.5 }) {
    f.scan.mockReturnValue([])
    f.character.prototype.collision_mask.layers = { player: true, water_tile: true, item: true } as any
    f.get_tile.mockReturnValue(tile('deepwater', { water_tile: true, resource: true }))
    f.can_place.mockReturnValue(false)
    f.find.mockReturnValue(nearest ?? undefined)
  }

  it('refuses a goal on a colliding tile with the shared layers and the nearest standing position as correction data', () => {
    const f = fixture(); drowned(f)
    const result = navigation_position_preflight(f.actor, { ...water, reach_distance: 4 }) as any
    expect(result).toMatchObject({ ok: false, operation: 'walk_to_position', code: 'navigation_position_inside_tile_collision',
      position: water, reach_distance: 4, tile: 'deepwater', colliding_layers: ['water_tile'], nearest_walkable_position: { x: 59.5, y: -36.5 },
      nearest_walkable_search_radius: 16 })
    // The tile under the goal point (floor, also for negative coordinates); the correction uses the actor's own character prototype.
    expect(f.get_tile).toHaveBeenCalledWith(60, -36)
    expect(f.can_place).toHaveBeenCalledWith({ name: 'character', position: water, force: { index: 1 } })
    expect(f.find).toHaveBeenCalledWith('character', water, 16, 0.5)
  })

  it('accepts a shoreline tile of a colliding kind when the engine says the character fits there (tile transitions)', () => {
    const f = fixture(); drowned(f)
    f.can_place.mockReturnValue(true)
    expect(navigation_position_preflight(f.actor, { x: 60.5, y: -39.5, reach_distance: 4 })).toEqual({ ok: true, operation: 'walk_to_position' })
    expect(f.get_tile).toHaveBeenCalledWith(60, -40)
    expect(f.find).not.toHaveBeenCalled()
  })

  it('does not depend on the reach: the pathfinder refuses such a goal at any arrival radius', () => {
    const f = fixture(); drowned(f)
    for (const reach_distance of [0.25, 0.75, 2, 4, 64]) {
      expect(navigation_position_preflight(f.actor, { x: 60.5, y: -35.5, reach_distance })).toMatchObject({ ok: false, code: 'navigation_position_inside_tile_collision' })
    }
    expect(f.get_tile).toHaveBeenLastCalledWith(60, -36)
  })

  it('says so when the wider search finds nothing, instead of inventing a position', () => {
    const f = fixture(); drowned(f, null)
    const result = navigation_position_preflight(f.actor, water) as any
    expect(result).toMatchObject({ ok: false, code: 'navigation_position_inside_tile_collision', nearest_walkable_search_radius: 16 })
    expect(result.nearest_walkable_position).toBeUndefined() // absent, not guessed (a Lua nil)
  })

  it('accepts a goal on a tile the character does not collide with, or whose mask is unknown, without searching', () => {
    const f = fixture(); drowned(f)
    f.get_tile.mockReturnValue(tile('grass-1', { ground_tile: true }))
    expect(navigation_position_preflight(f.actor, water)).toEqual({ ok: true, operation: 'walk_to_position' })
    f.get_tile.mockReturnValue(tile('mystery', undefined))
    expect(navigation_position_preflight(f.actor, water)).toEqual({ ok: true, operation: 'walk_to_position' })
    f.get_tile.mockReturnValue(tile('water', { water_tile: true }))
    f.character.prototype.collision_mask.layers = { player: true } as any // a character that can cross water
    expect(navigation_position_preflight(f.actor, water)).toEqual({ ok: true, operation: 'walk_to_position' })
    expect(f.find).not.toHaveBeenCalled()
    expect(f.can_place).not.toHaveBeenCalled() // placement is only asked when the tile itself collides
  })

  it('keeps the furnace proof first and validates arguments before reading any tile', () => {
    const f = fixture(); drowned(f); f.scan.mockReturnValue([f.furnace])
    expect(navigation_position_preflight(f.actor, { x: 16, y: -96, reach_distance: 0.75 })).toMatchObject({ code: 'navigation_position_inside_furnace_collision' })
    f.get_tile.mockClear()
    expect(navigation_position_preflight(f.actor, { x: Number.NaN, y: 0 }).ok).toBe(false)
    expect(f.get_tile).not.toHaveBeenCalled()
  })
})
