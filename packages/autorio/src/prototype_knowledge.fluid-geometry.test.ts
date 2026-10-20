import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prototype_details } from './prototype_knowledge'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

function runtimeCollection<T>(values: T[]) {
  const result: Record<number, T> = {}
  for (let index = 0; index < values.length; index++) result[index + 1] = values[index]
  return result
}

describe('prototype fluid connection geometry', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
    const boiler = {
      name: 'boiler',
      type: 'boiler',
      is_building: true,
      tile_width: 3,
      tile_height: 2,
      collision_box: {},
      selection_box: {},
      items_to_place_this: [{ name: 'boiler', count: 1 }],
      fluidbox_prototypes: [
        {
          index: 1,
          production_type: 'input-output',
          filter: { name: 'water' },
          pipe_connections: [
            {
              connection_type: 'normal',
              flow_direction: 'input-output',
              direction: 12,
              positions: [
                { x: -2, y: 0.5 },
                { x: -0.5, y: -2 },
                { x: 2, y: -0.5 },
                { x: 0.5, y: 2 },
              ],
              connection_category: ['default'],
            },
          ],
        },
      ],
    }

    ;(globalThis as any).prototypes = {
      entity: { boiler },
      item: { boiler: { name: 'boiler', stack_size: 50, place_result: boiler } },
      fluid: {},
    }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes = originalPrototypes
  })

  it('exposes bounded Factorio-native pipe connection geometry without inventing world connectivity', () => {
    const result = prototype_details('boiler') as any
    expect(result.entity.fluidboxes).toHaveLength(1)
    expect(result.entity.fluidboxes[0]).toMatchObject({
      index: 1,
      production_type: 'input-output',
      filter: 'water',
      pipe_connection_count: 1,
      pipe_connections_truncated: false,
      pipe_connections: [
        {
          connection_type: 'normal',
          flow_direction: 'input-output',
          direction: 12,
          positions: [
            { x: -2, y: 0.5 },
            { x: -0.5, y: -2 },
            { x: 2, y: -0.5 },
            { x: 0.5, y: 2 },
          ],
          positions_truncated: false,
          connection_categories: ['default'],
          connection_categories_truncated: false,
        },
      ],
    })
  })

  it('reads runtime-shaped fluidbox, connection, position, and category collections without JS array methods or length', () => {
    const boiler = (globalThis as any).prototypes.entity.boiler
    boiler.items_to_place_this = runtimeCollection([{ name: 'boiler', count: 1 }])
    boiler.fluidbox_prototypes = runtimeCollection([
      {
        index: 1,
        production_type: 'input-output',
        filter: { name: 'water' },
        pipe_connections: runtimeCollection([
          {
            connection_type: 'normal',
            flow_direction: 'input-output',
            direction: 12,
            positions: runtimeCollection([
              { x: -2, y: 0.5 },
              { x: -0.5, y: -2 },
              { x: 2, y: -0.5 },
              { x: 0.5, y: 2 },
              { x: 99, y: 99 },
            ]),
            connection_category: runtimeCollection(['default', 'water', 'steam', 'modded', 'overflow']),
          },
        ]),
      },
    ])

    const result = prototype_details('boiler') as any
    expect(result.entity.place_items).toEqual([{ name: 'boiler', count: 1 }])
    expect(result.entity.fluidboxes).toHaveLength(1)
    expect(result.entity.fluidboxes[0]).toMatchObject({
      pipe_connection_count: 1,
      pipe_connections_truncated: false,
      pipe_connections: [{
        positions: [
          { x: -2, y: 0.5 },
          { x: -0.5, y: -2 },
          { x: 2, y: -0.5 },
          { x: 0.5, y: 2 },
        ],
        positions_truncated: true,
        connection_categories: ['default', 'water', 'steam', 'modded'],
        connection_categories_truncated: true,
      }],
    })
  })

  it('bounds pathological modded pipe connection counts instead of dumping prototype state', () => {
    const fluidbox = (globalThis as any).prototypes.entity.boiler.fluidbox_prototypes[0]
    fluidbox.pipe_connections = Array.from({ length: 20 }, (_, index) => ({
      connection_type: 'normal',
      flow_direction: 'input-output',
      direction: 0,
      positions: [{ x: index, y: -1 }],
      connection_category: ['default'],
    }))

    const result = prototype_details('boiler') as any
    expect(result.entity.fluidboxes[0].pipe_connection_count).toBe(20)
    expect(result.entity.fluidboxes[0].pipe_connections_truncated).toBe(true)
    expect(result.entity.fluidboxes[0].pipe_connections).toHaveLength(8)
  })

  // AB-3: an offshore pump's fluidbox has no filter; what it produces is a property of the tile it sits on.
  describe('native fluid_io field', () => {
    function addPump(filter?: string) {
      const prototypes = (globalThis as any).prototypes
      const pump = { name: 'pump-x', type: 'offshore-pump', is_building: true, tile_width: 1, tile_height: 2, collision_box: {}, selection_box: {},
        items_to_place_this: [{ name: 'pump-x', count: 1 }],
        fluidbox_prototypes: [{ index: 1, production_type: 'output', ...(filter ? { filter: { name: filter } } : {}), pipe_connections: [] }] }
      prototypes.entity['pump-x'] = pump
      prototypes.item['pump-x'] = { name: 'pump-x', stack_size: 50, place_result: pump }
      prototypes.tile = { sea: { fluid: { name: 'water' } }, 'deep-sea': { fluid: { name: 'water' } }, magma: { fluid: { name: 'lava' } }, grass: {} }
    }

    it('names the fluid of a filtered fluidbox with its port, and nothing for an unfiltered non-pump entity', () => {
      const result = prototype_details('boiler') as any
      expect(result.entity.fluid_io).toEqual([{ fluid: 'water', production_type: 'input-output', fluidbox_index: 1, source: 'fluidbox_filter' }])
      expect(result.entity.fluid_io_truncated).toBe(false)
      ;(globalThis as any).prototypes.entity.boiler.fluidbox_prototypes[0].filter = undefined
      expect((prototype_details('boiler') as any).entity.fluid_io).toEqual([])
    })

    it('derives an unfiltered offshore pump output from the fluids of the tile prototypes, once per fluid and sorted', () => {
      addPump()
      const result = prototype_details('pump-x') as any
      expect(result.entity.fluidboxes[0].filter).toBeUndefined()
      expect(result.entity.fluid_io).toEqual([
        { fluid: 'lava', production_type: 'output', fluidbox_index: 1, source: 'tile_fluid' },
        { fluid: 'water', production_type: 'output', fluidbox_index: 1, source: 'tile_fluid' },
      ])
      expect(result.entity.fluid_io_truncated).toBe(false)
    })

    it('trusts a pump fluidbox filter over the tiles, and reports an unreadable tile catalog as truncated', () => {
      addPump('steam')
      expect((prototype_details('pump-x') as any).entity.fluid_io).toEqual([{ fluid: 'steam', production_type: 'output', fluidbox_index: 1, source: 'fluidbox_filter' }])
      addPump()
      ;(globalThis as any).prototypes.tile = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`dry-${index}`, {}]))
      expect((prototype_details('pump-x') as any).entity).toMatchObject({ fluid_io: [], fluid_io_truncated: true })
    })
  })
})
