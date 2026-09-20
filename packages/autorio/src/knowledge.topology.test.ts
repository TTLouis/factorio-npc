import { afterEach, describe, expect, it } from 'vitest'
import { logistics_topology_for_actor } from './knowledge'

function baseEntity(overrides: Record<string, unknown>) {
  return {
    valid: true,
    direction: 0,
    force: { name: 'player' },
    fluids_count: 0,
    fluidbox: { length: 0 },
    ...overrides,
  }
}

describe('logistics topology knowledge', () => {
  const originalLookup = (globalThis as any).game.get_entity_by_unit_number
  const actor = {
    is_valid: true,
    position: { x: 0, y: 0 },
    surface: { index: 1 },
  } as any

  afterEach(() => {
    ;(globalThis as any).game.get_entity_by_unit_number = originalLookup
  })

  it('returns engine belt inputs and outputs as directed relationships', () => {
    const input = baseEntity({
      name: 'transport-belt', type: 'transport-belt', unit_number: 10, position: { x: 0, y: -1 },
    })
    const output = baseEntity({
      name: 'transport-belt', type: 'transport-belt', unit_number: 12, position: { x: 0, y: 1 },
    })
    const center = baseEntity({
      name: 'transport-belt', type: 'transport-belt', unit_number: 11, position: { x: 0, y: 0 },
      surface: { index: 1, find_entities_filtered: () => [] },
      belt_neighbours: { inputs: [input], outputs: [output] },
    })
    ;(globalThis as any).game.get_entity_by_unit_number = () => center

    const result = logistics_topology_for_actor(actor, 11, 8) as any
    expect(result.found).toBe(true)
    expect(result.center.unit_number).toBe(11)
    expect(result.relations).toEqual([
      expect.objectContaining({
        kind: 'belt_input',
        from: expect.objectContaining({ unit_number: 10 }),
        to: expect.objectContaining({ unit_number: 11 }),
      }),
      expect.objectContaining({
        kind: 'belt_output',
        from: expect.objectContaining({ unit_number: 11 }),
        to: expect.objectContaining({ unit_number: 12 }),
      }),
    ])
  })

  it('derives only inserter routes that actually touch the center entity', () => {
    let receivedFilter: any
    const sourceBelt = baseEntity({
      name: 'transport-belt', type: 'transport-belt', unit_number: 20, position: { x: -2, y: 0 },
    })
    const outputBelt = baseEntity({
      name: 'transport-belt', type: 'transport-belt', unit_number: 21, position: { x: 2, y: 0 },
    })
    const unrelatedChest = baseEntity({
      name: 'steel-chest', type: 'container', unit_number: 99, position: { x: 0, y: 4 },
    })
    let inbound: ReturnType<typeof baseEntity>
    let outbound: ReturnType<typeof baseEntity>
    let unrelated: ReturnType<typeof baseEntity>
    const center = baseEntity({
      name: 'assembling-machine-1', type: 'assembling-machine', unit_number: 30, position: { x: 0, y: 0 },
      surface: {
        index: 1,
        find_entities_filtered: (filter: any) => {
          receivedFilter = filter
          return [inbound, outbound, unrelated]
        },
      },
    })
    inbound = baseEntity({
      name: 'inserter', type: 'inserter', unit_number: 31, position: { x: -1, y: 0 },
      pickup_position: { x: -2, y: 0 }, drop_position: { x: 0, y: 0 },
      pickup_target: sourceBelt, drop_target: center,
    })
    outbound = baseEntity({
      name: 'inserter', type: 'inserter', unit_number: 32, position: { x: 1, y: 0 },
      pickup_position: { x: 0, y: 0 }, drop_position: { x: 2, y: 0 },
      pickup_target: center, drop_target: outputBelt,
    })
    unrelated = baseEntity({
      name: 'inserter', type: 'inserter', unit_number: 33, position: { x: 0, y: 3 },
      pickup_position: { x: 0, y: 3 }, drop_position: { x: 0, y: 4 },
      pickup_target: outputBelt, drop_target: unrelatedChest,
    })
    ;(globalThis as any).game.get_entity_by_unit_number = () => center

    const result = logistics_topology_for_actor(actor, 30, 12) as any
    expect(receivedFilter).toMatchObject({
      position: { x: 0, y: 0 }, radius: 12, type: 'inserter', limit: 64,
    })
    expect(result.relations).toHaveLength(2)
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'item_transfer',
        from: expect.objectContaining({ unit_number: 20 }),
        via: expect.objectContaining({ unit_number: 31 }),
        to: expect.objectContaining({ unit_number: 30 }),
      }),
      expect.objectContaining({
        kind: 'item_transfer',
        from: expect.objectContaining({ unit_number: 30 }),
        via: expect.objectContaining({ unit_number: 32 }),
        to: expect.objectContaining({ unit_number: 21 }),
      }),
    ]))
    expect(result.relations.some((relation: any) => relation.via?.unit_number === 33)).toBe(false)
  })

  it('returns connected fluidbox owners as semantic fluid relationships', () => {
    const pipe = baseEntity({
      name: 'pipe', type: 'pipe', unit_number: 40, position: { x: 3, y: 2 },
    })
    const center = baseEntity({
      name: 'chemical-plant', type: 'assembling-machine', unit_number: 41, position: { x: 2, y: 2 },
      surface: { index: 1, find_entities_filtered: () => [] },
      fluids_count: 1,
      fluidbox: {
        length: 1,
        get_prototype: () => ({ index: 1, production_type: 'output', filter: { name: 'sulfuric-acid' } }),
        get_pipe_connections: () => [{
          flow_direction: 'output',
          connection_type: 'normal',
          position: { x: 3, y: 2 },
          target_position: { x: 4, y: 2 },
          target: { owner: pipe },
          target_fluidbox_index: 1,
        }],
      },
    })
    ;(globalThis as any).game.get_entity_by_unit_number = () => center

    const result = logistics_topology_for_actor(actor, 41, 8) as any
    expect(result.relations).toContainEqual(expect.objectContaining({
      kind: 'fluid_connection',
      center: expect.objectContaining({ unit_number: 41 }),
      neighbour: expect.objectContaining({ unit_number: 40 }),
      fluidbox_index: 1,
      production_types: ['output'],
      flow_direction: 'output',
    }))
  })

  it('fails closed for invalid identity, radius, missing entity, and another surface', () => {
    expect(logistics_topology_for_actor(actor, 0, 8)).toMatchObject({ found: false, error: 'invalid unit_number' })
    expect(logistics_topology_for_actor(actor, 1, 17)).toMatchObject({ found: false, error: 'radius must be an integer from 1 to 16' })
    expect(logistics_topology_for_actor(actor, 1, 1.5)).toMatchObject({ found: false, error: 'radius must be an integer from 1 to 16' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
    expect(logistics_topology_for_actor(actor, 999, 8)).toMatchObject({ found: false, error: 'entity not found' })

    ;(globalThis as any).game.get_entity_by_unit_number = () => ({ valid: true, surface: { index: 2 } })
    expect(logistics_topology_for_actor(actor, 999, 8)).toMatchObject({ found: false, error: 'entity is on another surface' })
  })
})
