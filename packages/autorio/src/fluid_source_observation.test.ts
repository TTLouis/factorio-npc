import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fluid_source_observation } from './fluid_source_observation'

describe('native fluid-bearing tile observation', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes
  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes = { fluid: { 'modded-fluid': {} }, tile: {
      'alien-liquid-tile': { fluid: { name: 'modded-fluid' } }, dry: {}, other: { fluid: { name: 'other-fluid' } },
    } }
    ;(globalThis as any).game.tick = 123
  })
  afterEach(() => { (globalThis as any).pairs = originalPairs; (globalThis as any).prototypes = originalPrototypes })
  function fixture(count = 1) {
    const surface = { index: 7, is_chunk_generated: vi.fn(() => true), find_tiles_filtered: vi.fn((args: any) =>
      Array.from({ length: Math.min(count, args.limit) }, (_, index) => ({ name: 'alien-liquid-tile', position: { x: index, y: 1 },
        prototype: { fluid: { name: 'modded-fluid' } }, surface: { index: 7 } }))) }
    const actor = { is_valid: true, position: { x: 0, y: 0 }, surface, get_main_inventory: vi.fn() } as any
    return { actor, surface }
  }
  it('derives modded source names and bounds every native query, without reading inventory or granting geometry', () => {
    const { actor, surface } = fixture(9)
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid' })
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith({ name: ['alien-liquid-tile'], position: { x: 0, y: 0 }, radius: 128, limit: 9 })
    expect(surface.is_chunk_generated).toHaveBeenCalledTimes(81)
    expect(actor.get_main_inventory).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, surface_index: 7, observed_tick: 123, returned_count: 8, truncated: true, ordering: 'native_samples_not_nearest' })
    expect((result as any).samples).toHaveLength(8)
    expect((result as any).samples[0]).toEqual({ name: 'alien-liquid-tile', fluid_name: 'modded-fluid', position: { x: 0, y: 1 }, surface_index: 7 })
    expect((result as any).candidates).toBeUndefined()
  })
  it('refuses missing bodies, invalid fluids/bounds and incomplete coverage before tile search', () => {
    const { actor, surface } = fixture()
    expect(fluid_source_observation(undefined, { fluid_name: 'modded-fluid' })).toMatchObject({ code: 'no_actor' })
    expect(fluid_source_observation(actor, { fluid_name: 'unknown' })).toMatchObject({ code: 'unknown_fluid' })
    for (const search_radius of [0, -1, 257, 1.5, Infinity, NaN]) expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', search_radius })).toMatchObject({ code: 'invalid_fluid_source_bounds' })
    for (const limit of [0, 9, 1.5]) expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', limit })).toMatchObject({ code: 'invalid_fluid_source_bounds' })
    surface.is_chunk_generated.mockReturnValue(false)
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ ok: false, code: 'fluid_source_search_unexplored', coverage: 'incomplete' })
    expect(surface.find_tiles_filtered).not.toHaveBeenCalled()
  })
  it('reports incomplete catalogs instead of false absence and rejects wrong-surface or wrong-fluid results', () => {
    const { actor, surface } = fixture()
    const nativePrototypes = (globalThis as any).prototypes
    nativePrototypes.tile = Object.fromEntries(Array.from({ length: 2049 }, (_, i) => [`dry-${i}`, {}]))
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ ok: false, code: 'fluid_tile_catalog_incomplete' })
    expect(surface.find_tiles_filtered).not.toHaveBeenCalled()
    nativePrototypes.tile = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`liquid-${i}`, { fluid: { name: 'modded-fluid' } }]))
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ ok: false, code: 'fluid_tile_catalog_incomplete' })
    nativePrototypes.tile = { liquid: { fluid: { name: 'modded-fluid' } } }
    for (const [surface_index, fluid_name] of [[8, 'modded-fluid'], [7, 'other-fluid']] as const) {
      surface.find_tiles_filtered.mockReturnValue([{ name: 'liquid', position: { x: 0, y: 0 }, surface: { index: surface_index }, prototype: { fluid: { name: fluid_name } } }] as any)
      expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ ok: false, code: 'fluid_source_result_unreadable' })
    }
  })
  it('bounds maximum chunk checks and distinguishes complete empty results from truncation', () => {
    const { actor, surface } = fixture(0)
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', search_radius: 256 })).toMatchObject({ ok: true, checked_chunks: 289, returned_count: 0, truncated: false })
    expect(surface.is_chunk_generated).toHaveBeenCalledTimes(289)
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith(expect.objectContaining({ radius: 256, limit: 9 }))
  })
})
