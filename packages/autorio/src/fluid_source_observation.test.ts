import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fluid_source_observation, get_recent_fluid_source_observation } from './fluid_source_observation'

describe('native fluid-bearing tile observation', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes
  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes = { fluid: { 'modded-fluid': {} }, tile: {
      'alien-liquid-tile': { fluid: { name: 'modded-fluid' } }, dry: {}, other: { fluid: { name: 'other-fluid' } },
    } }
    ;(globalThis as any).game.tick = 123
    ;(globalThis as any).storage = {}
  })
  afterEach(() => { (globalThis as any).pairs = originalPairs; (globalThis as any).prototypes = originalPrototypes })
  function fixture(count = 1) {
    const surface = { index: 7, is_chunk_generated: vi.fn(() => true), find_tiles_filtered: vi.fn((args: any) => args.has_hidden_tile ? [] :
      Array.from({ length: Math.min(count, args.limit) }, (_, index) => ({ name: 'alien-liquid-tile', position: { x: index, y: 1 },
        prototype: { fluid: { name: 'modded-fluid' } }, surface: { index: 7 } }))) }
    const actor = { is_valid: true, position: { x: 0, y: 0 }, surface, force: { index: 2 }, status_snapshot: () => ({ actor_id: 41 }), get_main_inventory: vi.fn() } as any
    return { actor, surface }
  }
  it('derives modded source names and bounds every native query, without reading inventory or granting geometry', () => {
    const { actor, surface } = fixture(9)
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid' })
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith({ name: ['alien-liquid-tile'], position: { x: 0, y: 0 }, radius: 128, limit: 257 })
    expect(actor.get_main_inventory).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, surface_index: 7, observed_tick: 123, returned_count: 8, truncated: true, ordering: 'nearest_first',
      coverage: 'generated_bounding_square', coverage_complete: true, checked_chunks: 81, generated_chunk_count: 81, ungenerated_chunk_count: 0, ungenerated_chunks: [], empty_result_is_conclusive: true })
    expect((result as any).samples).toHaveLength(8)
    expect((result as any).samples[0]).toEqual({ name: 'alien-liquid-tile', fluid_name: 'modded-fluid', position: { x: 0, y: 1 }, surface_index: 7, distance: 1 })
    expect((result as any).candidates).toBeUndefined()
  })
  it('refuses missing bodies, invalid fluids/bounds and incomplete coverage before tile search', () => {
    const { actor, surface } = fixture()
    expect(fluid_source_observation(undefined, { fluid_name: 'modded-fluid' })).toMatchObject({ code: 'no_actor' })
    expect(fluid_source_observation(actor, { fluid_name: 'unknown' })).toMatchObject({ code: 'unknown_fluid' })
    for (const search_radius of [0, -1, 257, 1.5, Infinity, Number.NaN]) expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', search_radius })).toMatchObject({ code: 'invalid_fluid_source_bounds' })
    for (const limit of [0, 9, 1.5]) expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', limit })).toMatchObject({ code: 'invalid_fluid_source_bounds' })
    surface.is_chunk_generated.mockReturnValue(false)
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ ok: false, code: 'fluid_source_search_unexplored', coverage: 'none', coverage_complete: false,
      checked_chunks: 81, generated_chunk_count: 0, ungenerated_chunk_count: 81, ungenerated_chunks_truncated: true })
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
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith(expect.objectContaining({ radius: 256, limit: 257 }))
  })
  it('still returns the samples from generated terrain when some chunks of the square are not generated, and reports which', () => {
    const { actor, surface } = fixture()
    // Chunks (0,0) and (1,0) are ungenerated; the rest of the 9x9 chunk square is.
    surface.is_chunk_generated.mockImplementation(({ x, y }: any) => !(y === 0 && (x === 0 || x === 1)))
    // Native order is not distance order, and one tile lies in an ungenerated chunk.
    const native = [{ x: -70, y: 0 }, { x: 40, y: 5 }, { x: -50, y: -2 }, { x: 20, y: 40 }]
    surface.find_tiles_filtered.mockImplementation((args: any) => args.has_hidden_tile ? [] : native.map(position => ({ name: 'alien-liquid-tile', position, prototype: { fluid: { name: 'modded-fluid' } }, surface: { index: 7 } })) as any)
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid' }) as any
    expect(result).toMatchObject({ ok: true, coverage: 'generated_bounding_square', coverage_complete: false, checked_chunks: 81, generated_chunk_count: 79, ungenerated_chunk_count: 2,
      empty_result_is_conclusive: false, ordering: 'nearest_first', returned_count: 3, truncated: false })
    expect(result.ungenerated_chunks).toEqual([{ x: 0, y: 0, center: { x: 16, y: 16 } }, { x: 1, y: 0, center: { x: 48, y: 16 } }])
    expect(result.ungenerated_chunks_truncated).toBe(false)
    expect(result.samples.map((sample: any) => sample.position)).toEqual([{ x: 20, y: 40 }, { x: -50, y: -2 }, { x: -70, y: 0 }])
    expect(result.samples.map((sample: any) => sample.distance)).toEqual([44.7, 50, 70])
  })
  it('names the nearest ungenerated chunks within a bounded list and labels a truncated native scan', () => {
    const { actor, surface } = fixture(300)
    surface.is_chunk_generated.mockImplementation(({ x, y }: any) => (x + y) % 2 === 0)
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid', limit: 2 }) as any
    expect(result).toMatchObject({ ok: true, coverage_complete: false, scan_truncated: true, scanned_tile_limit: 256, empty_result_is_conclusive: false, truncated: true,
      ordering: 'nearest_first_among_scanned_tiles', returned_count: 2 })
    expect(result.ungenerated_chunks).toHaveLength(8)
    expect(result.ungenerated_chunks_truncated).toBe(true)
    const distances = result.ungenerated_chunks.map((chunk: any) => (chunk.center.x - 0) ** 2 + (chunk.center.y - 0) ** 2)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith(expect.objectContaining({ limit: 257 }))
  })
  it('separates removable native hidden-water hints from visible fluid and candidate authority', () => {
    const { actor, surface } = fixture(0)
    const tiles = (globalThis as any).prototypes.tile
    tiles.landfill = { mineable_properties: { minable: true } }
    tiles.foundation = { mineable_properties: { minable: true }, is_foundation: true }
    tiles.concrete = { mineable_properties: { minable: true } }
    tiles.locked = { mineable_properties: { minable: false } }
    const hidden = (name: string, x: number, hidden_tile: string, double_hidden_tile?: string) => ({ name, position: { x, y: 0 },
      surface: { index: 7 }, prototype: tiles[name], hidden_tile, double_hidden_tile })
    surface.find_tiles_filtered.mockImplementation((args: any) => args.has_hidden_tile ? [
      hidden('landfill', 8, 'alien-liquid-tile'), hidden('concrete', 3, 'foundation', 'alien-liquid-tile'),
      hidden('locked', 1, 'alien-liquid-tile'), hidden('landfill', 2, 'dry'), hidden('landfill', 4, 'other'),
    ] : [])
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid' }) as any
    expect(result.samples).toEqual([])
    expect(result.covered_fluid_hints).toEqual([
      { name: 'concrete', fluid_name: 'modded-fluid', position: { x: 3, y: 0 }, surface_index: 7, distance: 3,
        hidden_tile: 'foundation', double_hidden_tile: 'alien-liquid-tile', removal_layers: 2, cover_minable: true, requires_terrain_removal: true, placement_authority: false },
      { name: 'landfill', fluid_name: 'modded-fluid', position: { x: 8, y: 0 }, surface_index: 7, distance: 8,
        hidden_tile: 'alien-liquid-tile', removal_layers: 1, cover_minable: true, requires_terrain_removal: true, placement_authority: false },
    ])
    expect(result).toMatchObject({ covered_returned_count: 2, covered_scan_truncated: false, covered_empty_result_is_conclusive: true,
      covered_hint_requires_native_mining_validation: true })
    expect(result.candidates).toBeUndefined()
    expect(surface.find_tiles_filtered).toHaveBeenCalledWith({ position: { x: 0, y: 0 }, radius: 128, has_hidden_tile: true, limit: 257 })
  })
  it('bounds covered scanning separately and reports uncertain absence on truncation or partial generation', () => {
    const { actor, surface } = fixture(0)
    surface.find_tiles_filtered.mockImplementation((args: any) => args.has_hidden_tile ? Array.from({ length: 257 }, (_, x) => ({
      name: 'dry', position: { x, y: 0 }, surface: { index: 7 }, prototype: {},
    })) : [])
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid' })).toMatchObject({ samples: [], covered_fluid_hints: [],
      covered_scan_truncated: true, covered_empty_result_is_conclusive: false, covered_truncated: true,
      covered_ordering: 'nearest_first_among_scanned_tiles' })
  })
  it('scopes recent successful facts to actor, force, surface and native tick TTL; invalid reads never refresh them', () => {
    const { actor, surface } = fixture()
    const result = fluid_source_observation(actor, { fluid_name: 'modded-fluid' })
    expect(get_recent_fluid_source_observation(actor, 'modded-fluid')).toBe(result)
    expect(get_recent_fluid_source_observation({ ...actor, status_snapshot: () => ({ actor_id: 42 }) }, 'modded-fluid')).toBeUndefined()
    expect(get_recent_fluid_source_observation({ ...actor, force: { index: 3 } }, 'modded-fluid')).toBeUndefined()
    expect(get_recent_fluid_source_observation({ ...actor, surface: { ...surface, index: 8 } }, 'modded-fluid')).toBeUndefined()
    expect(get_recent_fluid_source_observation({ ...actor, status_snapshot: () => ({}) }, 'modded-fluid')).toBeUndefined()
    expect(get_recent_fluid_source_observation(actor, 'other-fluid')).toBeUndefined()
    ;(globalThis as any).game.tick = 3723
    expect(get_recent_fluid_source_observation(actor, 'modded-fluid')).toBe(result)
    expect(fluid_source_observation(actor, { fluid_name: 'modded-fluid', search_radius: 257 })).toMatchObject({ ok: false })
    ;(globalThis as any).game.tick = 3724
    expect(get_recent_fluid_source_observation(actor, 'modded-fluid')).toBeUndefined()
    ;(globalThis as any).game.tick = 122
    expect(get_recent_fluid_source_observation(actor, 'modded-fluid')).toBeUndefined()
  })
  it('keeps at most sixteen recent identities and replaces only the matching fact', () => {
    const { actor } = fixture()
    for (let actor_id = 1; actor_id <= 17; actor_id++) fluid_source_observation({ ...actor, status_snapshot: () => ({ actor_id }) }, { fluid_name: 'modded-fluid' })
    expect((globalThis as any).storage.sgluna_recent_fluid_reads).toHaveLength(16)
    expect(get_recent_fluid_source_observation({ ...actor, status_snapshot: () => ({ actor_id: 1 }) }, 'modded-fluid')).toBeUndefined()
    fluid_source_observation({ ...actor, status_snapshot: () => ({ actor_id: 17 }) }, { fluid_name: 'modded-fluid' })
    expect((globalThis as any).storage.sgluna_recent_fluid_reads).toHaveLength(16)
  })
})
