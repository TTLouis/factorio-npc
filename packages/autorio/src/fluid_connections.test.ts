import { expect, it } from 'vitest'
import { fluid_connection_state } from './fluid_connections'

function endpoint(segment: number | undefined, fluid?: string): any {
  return { valid: true, fluids_count: 1, surface: { index: 1 },
    has_fluid_segment: () => segment !== undefined,
    get_fluid_segment_id: () => { if (segment === undefined) throw new Error('not a segment'); return segment },
    get_fluid_segment_filter: () => undefined,
    get_fluid_segment_fluid: () => fluid ? { name: fluid } : undefined,
    get_fluid_filter: () => fluid ? { name: fluid } : undefined,
    get_fluid: () => fluid ? { name: fluid } : undefined }
}
it('refuses geometric neighbours separated by native mixing prevention', () => {
  const water = endpoint(1, 'water'); const steam = endpoint(2, 'steam')
  expect(fluid_connection_state(water, 1, { target: steam, target_fluidbox_index: 1 } as any)).toBe('separate')
  expect(fluid_connection_state(water, 1, { target: endpoint(1, 'water'), target_fluidbox_index: 1 } as any)).toBe('joined')
})
it('allows a constrained directional output without reading unavailable segment properties', () => {
  const boiler = endpoint(undefined, 'steam'); const pipe = endpoint(3)
  pipe.get_fluid_box_pipe_connections = () => [{ target: boiler, target_fluidbox_index: 1 }]
  expect(fluid_connection_state(boiler, 1, { target: pipe, target_fluidbox_index: 1 } as any)).toBe('joined')
  pipe.get_fluid_segment_fluid = () => ({ name: 'water' })
  expect(fluid_connection_state(boiler, 1, { target: pipe, target_fluidbox_index: 1 } as any)).toBe('separate')
})
it('retains unknown when native telemetry cannot prove a connected hydraulic edge', () => {
  const source = endpoint(1); const target = endpoint(2)
  target.has_fluid_segment = () => { throw new Error('unavailable') }
  expect(fluid_connection_state(source, 1, { target, target_fluidbox_index: 1 } as any)).toBe('unknown')
})