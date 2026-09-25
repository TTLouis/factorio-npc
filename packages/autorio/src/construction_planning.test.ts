import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { local_spatial_observation, plan_placement, select_navigation_escape_point } from './construction_planning'

function fixture() {
  const actorCharacter: any = {
    valid: true,
    name: 'character',
    type: 'character',
    unit_number: 1,
    position: { x: 0.5, y: 0.5 },
    bounding_box: { left_top: { x: 0.2, y: 0.2 }, right_bottom: { x: 0.8, y: 0.8 } },
    force: { name: 'player' },
  }
  const cliff: any = {
    valid: true,
    name: 'cliff',
    type: 'cliff',
    position: { x: 2.5, y: 0.5 },
    bounding_box: { left_top: { x: 2, y: 0 }, right_bottom: { x: 3, y: 1 } },
    force: { name: 'neutral' },
  }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    find_entities_filtered: vi.fn((args: any) => args.area ? [actorCharacter, cliff] : [cliff]),
    get_tile: vi.fn((x: number, y: number) => ({ name: x === -1 && y === 0 ? 'water' : 'grass-1' })),
    can_place_entity: vi.fn((args: any) => args.position.x >= 1.5 && args.position.y >= -1.5),
    find_non_colliding_position: vi.fn((_name: string, desired: any) => desired.x < 0 ? undefined : desired),
  }
  const actor = {
    is_valid: true,
    character: actorCharacter,
    position: actorCharacter.position,
    surface,
    force: { index: 1, name: 'player' },
  } as unknown as ControlledActor
  return { actor, surface, actorCharacter, cliff }
}

beforeEach(() => {
  ;(globalThis as any).game.tick = 120
  ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    type: 'assembling-machine',
    tile_width: 3,
    tile_height: 3,
    collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
    selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
  }
  ;(globalThis as any).prototypes.entity['burner-mining-drill'] = {
    type: 'mining-drill',
    tile_width: 2,
    tile_height: 2,
    collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
    selection_box: { left_top: { x: -1, y: -1 }, right_bottom: { x: 1, y: 1 } },
    mining_drill_radius: 1.49,
  }
})

describe('shared local spatial observation', () => {
  it('reports bounded terrain, structures and the NPC footprint', () => {
    const { actor } = fixture()
    const result: any = local_spatial_observation(actor, { position: { x: 0.5, y: 0.5 }, half_size: 4, requested_entity_name: 'assembling-machine-1' })
    expect(result).toMatchObject({
      ok: true,
      tick: 120,
      size: { width: 8, height: 8 },
      actor: { position: { x: 0.5, y: 0.5 } },
      requested_entity: {
        name: 'assembling-machine-1',
        exists: true,
        physical_footprint: {
          tile_width: 3,
          tile_height: 3,
        },
      },
      entity_count: 2,
    })
    expect(result.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'character', category: 'character', is_npc: true }),
      expect.objectContaining({ name: 'cliff', category: 'cliff' }),
    ]))
    expect(result.blocking_terrain.tiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'water', position: { x: -1, y: 0 } }),
    ]))
    expect(result.terrain_tiles).toMatchObject({
      tile_count: 64,
      type_count: 2,
      encoding: 'row_runs_inclusive',
      runs_truncated: false,
    })
    expect(result.terrain_tiles.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'grass-1', count: 63 }),
      expect.objectContaining({ name: 'water', count: 1, kind: 'water' }),
    ]))
    expect(result.terrain_tiles.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ y: 0, x_start: -1, x_end: -1, name: 'water', kind: 'water' }),
    ]))
  })

  it('keeps a mining drill physical footprint separate from its mining working area', () => {
    const { actor } = fixture()
    const result: any = local_spatial_observation(actor, {
      position: { x: 0.5, y: 0.5 },
      half_size: 4,
      requested_entity_name: 'burner-mining-drill',
    })

    expect(result.requested_entity).toMatchObject({
      name: 'burner-mining-drill',
      type: 'mining-drill',
      physical_footprint: {
        tile_width: 2,
        tile_height: 2,
        collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
      },
      working_area: { kind: 'mining', radius: 1.49 },
    })
  })

  it('chooses a deterministic valid side-biased placement and exposes rejected collision causes', () => {
    const { actor } = fixture()
    const result: any = plan_placement(actor, {
      entity_name: 'assembling-machine-1',
      position: { x: 0.5, y: 0.5 },
      side: 'east',
      search_radius: 4,
      max_candidates: 3,
      reserve_input: true,
      reserve_output: true,
      reserve_power: true,
      extension_direction: 'east',
    })
    expect(result.ok).toBe(true)
    expect(result.best.position.x).toBeGreaterThanOrEqual(1.5)
    expect(result.candidates.length).toBeLessThanOrEqual(3)
    expect(result.prototype).toMatchObject({
      physical_footprint: { tile_width: 3, tile_height: 3 },
    })
    expect(result.corridors).toMatchObject({ input: { reserved: true }, output: { reserved: true }, power: { reserved: true } })
    expect(result.rejected.length).toBeGreaterThan(0)
  })

  it('plans even-sized entities on whole-coordinate centers and returns their footprint', () => {
    const { actor } = fixture()
    const result: any = plan_placement(actor, {
      entity_name: 'burner-mining-drill',
      position: { x: 0.5, y: 0.5 },
      side: 'east',
      search_radius: 4,
      max_candidates: 4,
    })

    expect(result.ok).toBe(true)
    for (const candidate of result.candidates) {
      expect(Number.isInteger(candidate.position.x)).toBe(true)
      expect(Number.isInteger(candidate.position.y)).toBe(true)
      expect(candidate.footprint).toMatchObject({
        tile_width: 2,
        tile_height: 2,
        grid: { x_offset: 0, y_offset: 0 },
      })
    }
  })

  it('reuses the same collision-aware backend to select a local navigation escape point', () => {
    const { actor } = fixture()
    const result: any = select_navigation_escape_point(actor, { x: 20, y: 0 }, 6)
    expect(result.ok).toBe(true)
    expect(result.best.position.x).toBeGreaterThanOrEqual(0)
    expect(result.spatial_observation.ok).toBe(true)
  })
})
