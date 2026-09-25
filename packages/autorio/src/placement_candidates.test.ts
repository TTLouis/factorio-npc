import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placement_candidates_for_actor } from './placement_candidates'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

describe('placement candidates', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
  })

  it('uses live can_place_entity and does not depend on vanilla prototype names', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-building': {
        name: 'modded-building',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: ({ position }: any) => position.x === 1.5 && position.y === 0.5,
        find_entities_filtered: () => [],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'modded-building',
      center: { x: 0, y: 0 },
      radius: 2,
      limit: 3,
    }) as any

    expect(result.ok).toBe(true)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      id: 'candidate-1',
      position: { x: 1.5, y: 0.5 },
    })
  })

  it('rejects mining candidates that do not cover the requested live resource', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-miner': {
        name: 'modded-miner',
        type: 'mining-drill',
        tile_width: 3,
        tile_height: 3,
        mining_drill_radius: 1.5,
        resource_categories: { 'modded-solid': true },
      },
    }

    const stone = {
      valid: true,
      name: 'modded-stone',
      type: 'resource',
      amount: 800,
      prototype: { resource_category: 'modded-solid' },
    }
    const iron = {
      valid: true,
      name: 'modded-iron',
      type: 'resource',
      amount: 900,
      prototype: { resource_category: 'modded-solid' },
    }

    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: () => true,
        find_entities_filtered: ({ area }: any) => {
          const centerX = (area[0].x + area[1].x) / 2
          if (centerX < 0) return [iron]
          if (centerX > 0) return [stone]
          return []
        },
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'modded-miner',
      center: { x: 0, y: 0 },
      radius: 1,
      target_resource: 'modded-stone',
      limit: 8,
    }) as any

    expect(result.ok).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) {
      expect(candidate.position.x).toBeGreaterThan(0)
      expect(candidate.resource_coverage).toEqual([
        { name: 'modded-stone', entities: 1, amount: 800 },
      ])
    }
  })

  it('prefers stronger live resource coverage before distance', () => {
    ;(globalThis as any).prototypes.entity = {
      'wide-modded-miner': {
        name: 'wide-modded-miner',
        type: 'mining-drill',
        tile_width: 3,
        tile_height: 3,
        mining_drill_radius: 2,
        resource_categories: { ore: true },
      },
    }

    function resource(name: string, amount: number) {
      return {
        valid: true,
        name,
        type: 'resource',
        amount,
        prototype: { resource_category: 'ore' },
      }
    }

    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: () => true,
        find_entities_filtered: ({ area }: any) => {
          const centerX = (area[0].x + area[1].x) / 2
          if (centerX > 0) return [resource('rich-ore', 5000), resource('rich-ore', 4000)]
          if (centerX === 0.5) return [resource('rich-ore', 100)]
          return [resource('rich-ore', 50)]
        },
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'wide-modded-miner',
      center: { x: 0, y: 0 },
      radius: 2,
      target_resource: 'rich-ore',
      limit: 1,
    }) as any

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].resource_coverage[0]).toEqual({
      name: 'rich-ore',
      entities: 2,
      amount: 9000,
    })
  })

  it('returns no target-resource candidate when live category compatibility rejects it', () => {
    ;(globalThis as any).prototypes.entity = {
      'solid-only-miner': {
        name: 'solid-only-miner',
        type: 'mining-drill',
        tile_width: 3,
        tile_height: 3,
        mining_drill_radius: 2,
        resource_categories: { solid: true },
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: () => true,
        find_entities_filtered: () => [{
          valid: true,
          name: 'liquid-resource',
          type: 'resource',
          amount: 10000,
          prototype: { resource_category: 'liquid' },
        }],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'solid-only-miner',
      radius: 1,
      target_resource: 'liquid-resource',
    }) as any

    expect(result.ok).toBe(true)
    expect(result.candidates).toEqual([])
  })

  it('returns only placements whose footprint covers a requested point, such as a drill output', () => {
    // Burner-drill canary: the furnace must sit on the drill's output tile.
    ;(globalThis as any).prototypes.entity = {
      'modded-furnace': { name: 'modded-furnace', type: 'furnace', tile_width: 2, tile_height: 2 },
      'modded-chest': { name: 'modded-chest', type: 'container', tile_width: 1, tile_height: 2 },
    }
    const actor = {
      position: { x: 20, y: 20 },
      force: { index: 1 },
      surface: {
        can_place_entity: () => true,
        find_entities_filtered: () => [],
      },
    } as any
    const output = { x: 0.3, y: -1.3 }

    const furnaces = placement_candidates_for_actor(actor, {
      entity_name: 'modded-furnace',
      covers_position: output,
      limit: 8,
    }) as any
    expect(furnaces.ok).toBe(true)
    expect(furnaces.center).toEqual(output)
    expect(furnaces.legal_candidate_count).toBeGreaterThan(0)
    for (const candidate of furnaces.candidates) {
      expect(Math.abs(candidate.position.x - output.x)).toBeLessThan(1)
      expect(Math.abs(candidate.position.y - output.y)).toBeLessThan(1)
    }

    // A rotated 1x2 entity covers the point only with its extents swapped.
    const chests = placement_candidates_for_actor(actor, {
      entity_name: 'modded-chest',
      covers_position: output,
      limit: 8,
    }) as any
    for (const candidate of chests.candidates) {
      const rotated = candidate.direction === 4 || candidate.direction === 12
      expect(Math.abs(candidate.position.x - output.x)).toBeLessThan(rotated ? 1 : 0.5)
      expect(Math.abs(candidate.position.y - output.y)).toBeLessThan(rotated ? 0.5 : 1)
    }
  })

  it('uses rotation-aware center grids and returns each candidate footprint', () => {
    ;(globalThis as any).prototypes.entity = {
      'rect-machine': {
        name: 'rect-machine',
        type: 'assembling-machine',
        tile_width: 1,
        tile_height: 2,
        collision_box: {
          left_top: { x: -0.4, y: -0.9 },
          right_bottom: { x: 0.4, y: 0.9 },
        },
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: ({ position, direction }: any) => (
          (direction === 0 && position.x === 0.5 && position.y === 0)
          || (direction === 4 && position.x === 0 && position.y === 0.5)
        ),
        find_entities_filtered: () => [],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'rect-machine',
      center: { x: 0, y: 0 },
      radius: 1,
      limit: 4,
    }) as any

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        position: { x: 0.5, y: 0 },
        direction: 0,
        footprint: expect.objectContaining({
          tile_width: 1,
          tile_height: 2,
          grid: { x_offset: 0.5, y_offset: 0 },
        }),
      }),
      expect.objectContaining({
        position: { x: 0, y: 0.5 },
        direction: 4,
        footprint: expect.objectContaining({
          tile_width: 2,
          tile_height: 1,
          grid: { x_offset: 0, y_offset: 0.5 },
        }),
      }),
    ]))
  })

  it('reads only fields that Factorio 2.0 entity prototypes have', () => {
    // Burner-drill canary attempt 4: every live call failed with
    // "LuaEntityPrototype doesn't contain key rotatable". Factorio objects
    // raise on unknown keys; these are the fields confirmed on 2.0.77.
    const fields: Record<string, unknown> = {
      name: 'stone-furnace',
      type: 'furnace',
      tile_width: 2,
      tile_height: 2,
      supports_direction: true,
      flags: {},
      vector_to_place_result: undefined,
      fluidbox_prototypes: [],
      mining_drill_radius: undefined,
      resource_categories: undefined,
      radius_visualisation_specification: undefined,
    }
    const strictPrototype = new Proxy(fields, {
      get(target, key) {
        if (typeof key === 'string' && !(key in target)) throw new Error(`LuaEntityPrototype doesn't contain key ${key}.`)
        return (target as any)[key]
      },
    })
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': strictPrototype }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: { can_place_entity: () => true, find_entities_filtered: () => [] },
    } as any

    const result = placement_candidates_for_actor(actor, { entity_name: 'stone-furnace', radius: 2, limit: 3 }) as any
    expect(result.ok).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
  })

  it('reads a drill output vector in the array form Factorio 2.0 returns', () => {
    // 2.0.77 returns vector_to_place_result as {-0.5, -1.3}, not {x, y}; the
    // candidate lost its item_output_position until both forms were accepted.
    ;(globalThis as any).prototypes.entity = {
      'modded-drill': {
        name: 'modded-drill',
        type: 'mining-drill',
        tile_width: 2,
        tile_height: 2,
        supports_direction: true,
        flags: {},
        vector_to_place_result: [-0.5, -1.3],
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: { can_place_entity: ({ position, direction }: any) => position.x === 0 && position.y === 0 && direction === 0, find_entities_filtered: () => [] },
    } as any

    const result = placement_candidates_for_actor(actor, { entity_name: 'modded-drill', radius: 1, limit: 1 }) as any
    expect(result.candidates[0].item_output_position).toEqual({ x: -0.5, y: -1.3 })
  })
})
