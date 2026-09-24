import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { placement_candidates_for_actor } from './placement_candidates'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

describe('placement candidate spatial behavior', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
  })

  it('attaches current modded prototype fluid-port geometry to orientation candidates', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-fluid-machine': {
        name: 'modded-fluid-machine',
        type: 'assembling-machine',
        tile_width: 3,
        tile_height: 3,
        fluidbox_prototypes: [{
          index: 1,
          production_type: 'input',
          filter: { name: 'modded-acid' },
          pipe_connections: [{
            flow_direction: 'input',
            connection_type: 'normal',
            positions: [
              { x: 0, y: -2 },
              { x: 2, y: 0 },
              { x: 0, y: 2 },
              { x: -2, y: 0 },
            ],
          }],
        }],
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: ({ position }: any) => position.x === 0.5 && position.y === 0.5,
        find_entities_filtered: () => [],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'modded-fluid-machine',
      radius: 1,
      limit: 4,
    }) as any

    expect(result.candidates).toHaveLength(4)
    expect(result.candidates.map((candidate: any) => candidate.fluid_ports[0].position)).toEqual([
      { x: 0.5, y: -1.5 },
      { x: 2.5, y: 0.5 },
      { x: 0.5, y: 2.5 },
      { x: -1.5, y: 0.5 },
    ])
  })

  it('prefers distinct positions for ordinary entities instead of spending the candidate budget on equivalent rotations', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-container': {
        name: 'modded-container',
        type: 'container',
        tile_width: 1,
        tile_height: 1,
      },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: () => true,
        find_entities_filtered: () => [],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'modded-container',
      radius: 2,
      limit: 5,
    }) as any

    const positions = new Set(result.candidates.map((candidate: any) => `${candidate.position.x},${candidate.position.y}`))
    expect(result.candidates).toHaveLength(5)
    expect(positions.size).toBe(5)
  })

  it('uses native live placeability as the hard terrain/shoreline constraint without entity-name rules', () => {
    ;(globalThis as any).prototypes.entity = {
      'modded-shore-extractor': {
        name: 'modded-shore-extractor',
        type: 'pump',
        tile_width: 1,
        tile_height: 1,
        fluidbox_prototypes: [{
          index: 1,
          production_type: 'output',
          pipe_connections: [{ positions: [{ x: 0, y: 1 }] }],
        }],
      },
    }
    const actor = {
      position: { x: 10, y: 10 },
      force: { index: 1 },
      surface: {
        can_place_entity: ({ position, direction }: any) => position.x === 11.5 && position.y === 10.5 && direction === 4,
        find_entities_filtered: () => [],
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'modded-shore-extractor',
      center: { x: 10, y: 10 },
      radius: 2,
      limit: 5,
    }) as any

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      position: { x: 11.5, y: 10.5 },
      direction: 4,
    })
  })

  it('rotates a modded mining search offset before evaluating target-resource coverage', () => {
    ;(globalThis as any).prototypes.entity = {
      'offset-miner': {
        name: 'offset-miner',
        type: 'mining-drill',
        tile_width: 1,
        tile_height: 1,
        mining_drill_radius: 0.75,
        radius_visualisation_specification: { offset: { x: 0, y: -2 } },
        resource_categories: { ore: true },
      },
    }
    const ore = {
      valid: true,
      name: 'offset-ore',
      type: 'resource',
      amount: 500,
      prototype: { resource_category: 'ore' },
    }
    const actor = {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        can_place_entity: ({ position }: any) => position.x === 0.5 && position.y === 0.5,
        find_entities_filtered: ({ area }: any) => {
          const centerX = (area[0].x + area[1].x) / 2
          return centerX > 1 ? [ore] : []
        },
      },
    } as any

    const result = placement_candidates_for_actor(actor, {
      entity_name: 'offset-miner',
      center: { x: 0, y: 0 },
      radius: 1,
      target_resource: 'offset-ore',
      limit: 8,
    }) as any

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      position: { x: 0.5, y: 0.5 },
      direction: 4,
      resource_coverage: [{ name: 'offset-ore', entities: 1, amount: 500 }],
    })
  })
})
