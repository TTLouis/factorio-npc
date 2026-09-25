import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compact_spatial_summary } from './spatial_semantics'

function luaPairs(value: Record<string, unknown>) {
  return Object.entries(value)
}

describe('compact spatial semantics', () => {
  const originalPairs = (globalThis as any).pairs

  beforeEach(() => {
    ;(globalThis as any).pairs = luaPairs
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
  })

  it('omits spatial data for entities without relevant runtime geometry', () => {
    const chest = {
      valid: true,
      name: 'iron-chest',
      type: 'container',
      unit_number: 10,
      position: { x: 1, y: 2 },
      fluids_count: 0,
      fluidbox: { length: 0 },
    } as any

    expect(compact_spatial_summary(chest)).toBeUndefined()
  })

  it('reports mining-drill output from runtime geometry', () => {
    const chest = {
      valid: true,
      name: 'iron-chest',
      type: 'container',
      unit_number: 11,
      position: { x: 4, y: 5 },
    }
    const drill = {
      valid: true,
      name: 'modded-miner',
      type: 'mining-drill',
      unit_number: 12,
      position: { x: 4, y: 4 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      drop_position: { x: 4, y: 5 },
      drop_target: chest,
    } as any

    expect(compact_spatial_summary(drill)).toEqual({
      item_io: {
        drop_position: { x: 4, y: 5 },
        drop_target: {
          name: 'iron-chest',
          type: 'container',
          unit_number: 11,
          position: { x: 4, y: 5 },
        },
      },
    })
  })

  it('reports live directional resource coverage for a modded mining drill', () => {
    const resource = {
      valid: true,
      name: 'modded-ore',
      type: 'resource',
      amount: 2400,
      prototype: { resource_category: 'modded-ore-category' },
    }
    let observedArea: any
    const drill = {
      valid: true,
      name: 'offset-modded-miner',
      type: 'mining-drill',
      unit_number: 13,
      position: { x: 10, y: 20 },
      direction: 4,
      fluids_count: 0,
      fluidbox: { length: 0 },
      drop_position: { x: 12, y: 20 },
      drop_target: undefined,
      prototype: {
        mining_drill_radius: 1.5,
        radius_visualisation_specification: { offset: { x: 0, y: -2 } },
        resource_categories: { 'modded-ore-category': true },
      },
      surface: {
        find_entities_filtered: ({ area }: any) => {
          observedArea = area
          return [resource]
        },
      },
    } as any

    const result = compact_spatial_summary(drill) as any
    expect(result.item_io.drop_position).toEqual({ x: 12, y: 20 })
    expect(result.mining).toEqual({
      radius: 1.5,
      search_center: { x: 12, y: 20 },
      resource_coverage: [{ name: 'modded-ore', entities: 1, amount: 2400 }],
      resource_types_truncated: false,
    })
    expect(observedArea).toEqual([
      { x: 10.5, y: 18.5 },
      { x: 13.5, y: 21.5 },
    ])
  })

  it('reports inserter pickup/drop targets from the placed runtime entity', () => {
    const source = {
      valid: true,
      name: 'transport-belt',
      type: 'transport-belt',
      unit_number: 20,
      position: { x: 0, y: 0 },
    }
    const destination = {
      valid: true,
      name: 'assembling-machine-1',
      type: 'assembling-machine',
      unit_number: 21,
      position: { x: 2, y: 0 },
    }
    const inserter = {
      valid: true,
      name: 'fast-inserter',
      type: 'inserter',
      unit_number: 22,
      position: { x: 1, y: 0 },
      fluids_count: 0,
      fluidbox: { length: 0 },
      pickup_position: { x: 0, y: 0 },
      drop_position: { x: 2, y: 0 },
      pickup_target: source,
      drop_target: destination,
    } as any

    expect(compact_spatial_summary(inserter)).toEqual({
      item_io: {
        pickup_position: { x: 0, y: 0 },
        drop_position: { x: 2, y: 0 },
        pickup_target: expect.objectContaining({ unit_number: 20, name: 'transport-belt' }),
        drop_target: expect.objectContaining({ unit_number: 21, name: 'assembling-machine-1' }),
      },
    })
  })

  it('reports fluid ports for any entity exposing LuaFluidBox connections', () => {
    const pipe = {
      valid: true,
      name: 'modded-pipe',
      type: 'pipe',
      unit_number: 30,
      position: { x: 8, y: 9 },
    }
    const fluidbox = {
      length: 2,
      get_prototype: (index: number) => index === 1
        ? { index: 1, production_type: 'input', filter: { name: 'water' } }
        : { index: 2, production_type: 'output' },
      get_pipe_connections: (index: number) => index === 1
        ? [{
            flow_direction: 'input',
            connection_type: 'normal',
            position: { x: 5, y: 6 },
            target_position: { x: 4, y: 6 },
          }]
        : [{
            flow_direction: 'output',
            connection_type: 'normal',
            position: { x: 7, y: 6 },
            target_position: { x: 8, y: 6 },
            target: { owner: pipe },
            target_fluidbox_index: 1,
          }],
    }
    const entity = {
      valid: true,
      name: 'modded-fluid-machine',
      type: 'assembling-machine',
      unit_number: 31,
      position: { x: 6, y: 6 },
      fluids_count: 2,
      fluidbox,
    } as any

    const result = compact_spatial_summary(entity) as any
    expect(result.item_io).toBeUndefined()
    expect(result.fluid.fluidbox_count).toBe(2)
    expect(result.fluid.storages).toHaveLength(2)
    expect(result.fluid.storages[0]).toMatchObject({
      index: 1,
      prototypes: [{ index: 1, production_type: 'input', filter: 'water' }],
      connections: [{
        flow_direction: 'input',
        position: { x: 5, y: 6 },
        target_position: { x: 4, y: 6 },
      }],
    })
    expect(result.fluid.storages[1].connections[0]).toMatchObject({
      flow_direction: 'output',
      target: { name: 'modded-pipe', unit_number: 30 },
      target_fluidbox_index: 1,
    })
  })
})
