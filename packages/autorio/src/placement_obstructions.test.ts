import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placement_obstruction_sample } from './placement_obstructions'

describe('bounded native placement obstruction witnesses', () => {
  const originalPairs = (globalThis as any).pairs
  beforeEach(() => { ;(globalThis as any).pairs = Object.entries })
  afterEach(() => { ;(globalThis as any).pairs = originalPairs })
  const proto = { tile_width: 3, tile_height: 5, collision_mask: { layers: { object: true, water_tile: true } } }
  it('reports terrain and colliding entities, excluding disjoint resource masks, with bounded samples', () => {
    const actor: any = { surface: {
      get_tile: (x: number, y: number) => ({ name: 'water', collides_with: (layer: string) => layer === 'water_tile' }),
      find_entities_filtered: () => [
        { valid: true, name: 'pole', type: 'electric-pole', unit_number: 7, position: { x: 0, y: 0 }, prototype: { collision_mask: { layers: { object: true } } } },
        { valid: true, name: 'ore', type: 'resource', prototype: { collision_mask: { layers: { resource: true } } } },
      ],
    } }
    const result = placement_obstruction_sample(actor, proto, { x: 0.5, y: 0.5 }, 0)
    expect(result.terrain_tiles).toHaveLength(4)
    expect(result.entities).toEqual([{ name: 'pole', type: 'electric-pole', unit_number: 7, position: { x: 0, y: 0 }, reason: 'entity_collision_mask_overlap' }])
    expect(result.truncated).toBe(true)
    expect(result.unknown).toBe(false)
  })
  it('does not invent a cause when masks or native diagnostics are unavailable', () => {
    const result = placement_obstruction_sample({ surface: {} } as any, { tile_width: 3, tile_height: 5 }, { x: 0.5, y: 0.5 }, 0)
    expect(result).toMatchObject({ unknown: true, terrain_tiles: [], entities: [] })
  })
})
