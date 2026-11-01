import { describe, expect, it } from 'vitest'
import { candidate_fluid_ports } from './placement_spatial_features'

describe('placement spatial features', () => {
  it('derives absolute fluid ports from a modded prototype for each cardinal direction', () => {
    const prototype = {
      name: 'modded-fluid-machine',
      fluidbox_prototypes: [
        {
          index: 1,
          production_type: 'input',
          filter: { name: 'modded-acid' },
          pipe_connections: [
            {
              flow_direction: 'input',
              connection_type: 'normal',
              direction: 0,
              positions: [
                { x: 0, y: -2 },
                { x: 2, y: 0 },
                { x: 0, y: 2 },
                { x: -2, y: 0 },
              ],
            },
          ],
        },
      ],
    }

    expect(candidate_fluid_ports(prototype, { x: 10, y: 20 }, 0)).toEqual([
      expect.objectContaining({
        storage_index: 1,
        connection_index: 1,
        production_type: 'input',
        filter: 'modded-acid',
        position: { x: 10, y: 18 },
        direction: 0,
      }),
    ])
    expect(candidate_fluid_ports(prototype, { x: 10, y: 20 }, 4)?.[0]).toMatchObject({
      position: { x: 12, y: 20 },
      direction: 4,
    })
    expect(candidate_fluid_ports(prototype, { x: 10, y: 20 }, 8)?.[0]).toMatchObject({
      position: { x: 10, y: 22 },
      direction: 8,
    })
    expect(candidate_fluid_ports(prototype, { x: 10, y: 20 }, 12)?.[0]).toMatchObject({
      position: { x: 8, y: 20 },
      direction: 12,
    })
  })

  it('omits fluid features for prototypes without fluidbox connections', () => {
    expect(candidate_fluid_ports({ name: 'plain-container' }, { x: 1, y: 2 }, 0)).toBeUndefined()
  })

  it('bounds the returned fluid ports for large modded machines', () => {
    const fluidbox_prototypes = []
    for (let index = 0; index < 24; index++) {
      fluidbox_prototypes.push({
        index: index + 1,
        production_type: 'input-output',
        pipe_connections: [{ positions: [{ x: index, y: 0 }] }],
      })
    }

    const result = candidate_fluid_ports({ fluidbox_prototypes }, { x: 0, y: 0 }, 0)
    expect(result).toHaveLength(16)
  })
})
