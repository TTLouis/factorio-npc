import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_placement_candidate_set, placement_candidates_for_actor } from './placement_candidates'

const small_pole = {
  name: 'small-electric-pole',
  type: 'electric-pole',
  tile_width: 1,
  tile_height: 1,
  supports_direction: false,
  supply_area_distance: 2.5,
  max_wire_distance: 7.5,
}
const lab_prototype = { name: 'lab', type: 'lab', electric_energy_source_prototype: {} }

function entity(unit_number: number, prototype: any, x: number, y: number, half: number, network?: number) {
  return {
    valid: true,
    unit_number,
    name: prototype.name,
    type: prototype.type,
    prototype,
    position: { x, y },
    electric_network_id: network,
    bounding_box: { left_top: { x: x - half, y: y - half }, right_bottom: { x: x + half, y: y + half } },
  }
}

describe('electric-pole placement candidates', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes.entity = { 'small-electric-pole': small_pole }
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 10
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalPrototypes
  })

  function actor_with(world: any[], legal: Array<[number, number]>) {
    return {
      position: { x: 0, y: 0 },
      force: { index: 1 },
      surface: {
        index: 1,
        can_place_entity: ({ position }: any) => legal.some(([x, y]) => x === position.x && y === position.y),
        find_entities_filtered: (filters: any) => world.filter((candidate) => {
          if (filters.type !== undefined && candidate.type !== filters.type) return false
          if (filters.position !== undefined && Math.hypot(candidate.position.x - filters.position.x, candidate.position.y - filters.position.y) > filters.radius) return false
          if (filters.area !== undefined) {
            const [left_top, right_bottom] = filters.area
            const box = candidate.bounding_box
            if (box.right_bottom.x < left_top.x || box.left_top.x > right_bottom.x || box.right_bottom.y < left_top.y || box.left_top.y > right_bottom.y) return false
          }
          return true
        }),
      },
    } as any
  }

  // One powered pole at the origin and an unconnected lab four tiles east of it.
  const world = [entity(11, small_pole, 0.5, 0.5, 0.5, 5), entity(21, lab_prototype, 4.5, 0.5, 1.5)]

  it('reports, per candidate, the poles it could wire to and the consumers its supply area covers', () => {
    const result = placement_candidates_for_actor(actor_with(world, [[3.5, 0.5], [0.5, 5.5]]), {
      entity_name: 'small-electric-pole',
      radius: 8,
      limit: 4,
    }) as any

    expect(result.electric_pole).toEqual({ supply_area_distance: 2.5, max_wire_distance: 7.5 })
    expect(result.ordering).toBe('fewest_clears_then_resource_coverage_then_nearest_to_center')
    expect(result.candidates.map((candidate: any) => candidate.position)).toEqual([{ x: 3.5, y: 0.5 }, { x: 0.5, y: 5.5 }])

    const [beside_lab, away] = result.candidates
    expect(beside_lab.electric.poles_in_wire_reach).toEqual([{ unit_number: 11, name: 'small-electric-pole', position: { x: 0.5, y: 0.5 }, distance: 3, electric_network_id: 5 }])
    expect(beside_lab.electric.would_join_networks).toEqual([5])
    expect(beside_lab.electric.covers_entities).toEqual([{ unit_number: 21, name: 'lab', type: 'lab', position: { x: 4.5, y: 0.5 } }])
    expect(beside_lab.electric.supply_area).toEqual({ left_top: { x: 1, y: -2 }, right_bottom: { x: 6, y: 3 } })
    // 5 tiles from the powered pole, covering nothing: still a valid link, no consumer.
    expect(away.electric).toMatchObject({ poles_in_wire_reach_count: 1, covers_entities: [], covers_entities_count: 0 })
  })

  it('does not persist the live electric read with the stored candidate set', () => {
    const actor = actor_with(world, [[3.5, 0.5]])
    const set = create_placement_candidate_set(actor, { entity_name: 'small-electric-pole', radius: 8 }) as any
    expect(set.candidates[0].electric.covers_entities_count).toBe(1)
    const stored = (globalThis as any).storage.sgluna_placement_candidate_sets[set.candidate_set_id]
    expect(stored.candidates[0].electric).toBeUndefined()
    expect(stored.candidates[0].position).toEqual({ x: 3.5, y: 0.5 })
  })

  it('adds no electric block for entities that are not poles', () => {
    ;(globalThis as any).prototypes.entity = { lab: { name: 'lab', type: 'lab', tile_width: 3, tile_height: 3 } }
    const result = placement_candidates_for_actor(actor_with(world, [[10.5, 10.5]]), { entity_name: 'lab', radius: 12 }) as any
    expect(result.electric_pole).toBeUndefined()
    expect(result.candidates[0].electric).toBeUndefined()
  })
})
