import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create_map_remote_interface, map_crop_around } from './map_remote'
import { knowledge_revision, map_crop, map_knowledge_summary, observe_window, pull_engine_chart } from './map_knowledge'

// M3 map crop and knowledge revision. The crop is a bounded picture of what the NPC knows, read from its own knowledge record
// (storage.sgluna_map_knowledge) and the engine's chart/visibility flags only. It names no entities and changes nothing.
// Pre-change (41a77583) none of map_crop, knowledge_revision, map_crop_around or the autorio_map.crop remote exist: every
// test here fails there with "... is not a function" (or a missing `revision` field on the summary).

const G: any = globalThis

interface FakeForceOptions {
  index?: number
  engine_visible?: (chunk: { x: number, y: number }) => boolean
  engine_charted?: (chunk: { x: number, y: number }) => boolean
}

// A force whose chart() and surface whose chunk generation throw: a crop must never reach either.
function read_only_force(options: FakeForceOptions = {}) {
  return {
    index: options.index ?? 1,
    is_chunk_visible: (_surface: unknown, chunk: { x: number, y: number }) => (options.engine_visible ?? (() => false))(chunk),
    is_chunk_charted: (_surface: unknown, chunk: { x: number, y: number }) => (options.engine_charted ?? (() => false))(chunk),
    chart: () => { throw new Error('a map crop must not chart') },
  } as any
}

function read_only_surface(index = 1, name = 'nauvis') {
  return {
    index,
    name,
    valid: true,
    request_to_generate_chunks: () => { throw new Error('a map crop must not generate chunks') },
    find_entities_filtered: () => { throw new Error('a map crop must not scan entities') },
    get_chunks: () => { throw new Error('a map crop must not enumerate engine chunks') },
  } as any
}

function window_knowledge(window: { x: number, y: number }, extra: Array<{ x: number, y: number, surface_index?: number }> = [], revision?: number) {
  const explored: Record<string, any> = {}
  for (let x = window.x - 2; x <= window.x + 2; x++) {
    for (let y = window.y - 2; y <= window.y + 2; y++) explored[`1:${x}:${y}`] = { surface_index: 1, x, y }
  }
  for (const chunk of extra) {
    const surface_index = chunk.surface_index ?? 1
    explored[`${surface_index}:${chunk.x}:${chunk.y}`] = { surface_index, x: chunk.x, y: chunk.y }
  }
  const knowledge: any = { force_index: 1, explored, visible_surface_index: 1, visible_chunk_x: window.x, visible_chunk_y: window.y, push_queue: [] }
  if (revision !== undefined) knowledge.revision = revision
  return knowledge
}

describe('map_crop (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 777 }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
  })

  it('draws V for the knowledge window, F for explored-only chunks and U for unknown ones, north to south and west to east', () => {
    // Window (0,0) is 5x5 (-2..2); (3,0) was explored earlier and is now outside the window; (-4,-4) is far away.
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: -4, y: -4 }], 5)
    const crop = map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 3)

    expect(crop.rows).toEqual([
      'UUUUUUU', // y = -3
      'UVVVVVU', // y = -2
      'UVVVVVU',
      'UVVVVVF', // y = 0: x = 3 is explored but fogged
      'UVVVVVU',
      'UVVVVVU', // y = 2
      'UUUUUUU', // y = 3
    ])
    expect(crop.legend).toContain('V visible now')
    expect(crop.source).toBe('npc_map_knowledge')
    expect(crop.chunk_size).toBe(32)
    expect(crop.center_chunk).toEqual({ x: 0, y: 0 })
    expect(crop.radius_chunks).toBe(3)
    expect(crop.surface_index).toBe(1)
    expect(crop.surface_name).toBe('nauvis')
    expect(crop.force_index).toBe(1)
  })

  it('counts visible, fogged and unknown chunks so that they sum to the total', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: -4, y: -4 }], 5)
    const crop = map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 3)

    expect(crop.counts).toEqual({ visible: 25, fogged: 1, unknown: 23, total: 49 })
    expect(crop.counts.visible + crop.counts.fogged + crop.counts.unknown).toBe(crop.counts.total)
    expect(crop.counts.total).toBe(crop.rows.length * crop.rows[0].length)
    // The same sum holds for a crop of every legal radius, centred away from the window.
    for (const radius of [1, 2, 3, 4]) {
      const other = map_crop(read_only_force(), read_only_surface(), { x: 2, y: 1 }, radius)
      expect(other.counts.total).toBe((2 * radius + 1) ** 2)
      expect(other.counts.visible + other.counts.fogged + other.counts.unknown).toBe(other.counts.total)
      expect(other.rows).toHaveLength(2 * radius + 1)
      for (const row of other.rows) expect(row).toHaveLength(2 * radius + 1)
    }
  })

  it('reports the crop origin as chunk and tile coordinates, including negative chunks', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [], 1)
    const crop = map_crop(read_only_force(), read_only_surface(), { x: -2, y: 5 }, 3)

    expect(crop.origin).toEqual({ chunk: { x: -5, y: 2 }, tile: { x: -160, y: 64 } })
    // Row i, column j is chunk (origin.x + j, origin.y + i): chunk (-2, 2) is row 0, column 3 and lies in the window.
    expect(crop.rows[0][3]).toBe('V')
    expect(crop.rows[0][0]).toBe('U')
  })

  it('stamps the crop with the knowledge revision and the game tick it was read at', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [], 12)
    const crop = map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 1)
    expect(crop.revision).toBe(12)
    expect(crop.observed_tick).toBe(777)
    G.game.tick = 9000
    expect(map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 1).observed_tick).toBe(9000)
  })

  it('reads a knowledge record saved before the revision counter as revision 0', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 })
    expect(G.storage.sgluna_map_knowledge.revision).toBeUndefined()
    expect(map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 1).revision).toBe(0)
    expect(knowledge_revision(read_only_force())).toBe(0)
    expect(map_knowledge_summary(read_only_force()).revision).toBe(0)
  })

  it('reads revision 0 and an all-unknown picture when the NPC has no knowledge record at all', () => {
    const crop = map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 2)
    expect(crop.revision).toBe(0)
    expect(crop.counts).toEqual({ visible: 0, fogged: 0, unknown: 25, total: 25 })
    expect(crop.visible_window).toBeUndefined()
    expect(crop.explored_record).toEqual({ chunks_on_surface: 0, outside_crop: 0, chunk_bounds: undefined })
    expect(map_knowledge_summary(read_only_force())).toEqual({ explored_chunks: 0, push_queue: 0, revision: 0 })
  })

  it('treats a knowledge record of another force as no knowledge', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [], 3)
    const crop = map_crop(read_only_force({ index: 2 }), read_only_surface(), { x: 0, y: 0 }, 1)
    expect(crop.rows).toEqual(['UUU', 'UUU', 'UUU'])
    expect(crop.revision).toBe(0)
  })

  it('shows engine-visible chunks as V and engine-charted chunks as F even without a knowledge record', () => {
    const force = read_only_force({
      engine_visible: chunk => chunk.x === 0 && chunk.y === 0,
      engine_charted: chunk => chunk.x === 1 && chunk.y === 0,
    })
    const crop = map_crop(force, read_only_surface(), { x: 0, y: 0 }, 1)
    expect(crop.rows).toEqual(['UUU', 'UVF', 'UUU'])
    expect(crop.counts).toEqual({ visible: 1, fogged: 1, unknown: 7, total: 9 })
  })

  it('does not show the window of another surface as visible, and does not count its chunks', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [{ x: 40, y: 40, surface_index: 2 }], 2)
    // The crop reads surface 2, where only one chunk was explored and the NPC window is not.
    const crop = map_crop(read_only_force(), read_only_surface(2, 'platform'), { x: 40, y: 40 }, 1)
    expect(crop.surface_index).toBe(2)
    expect(crop.rows).toEqual(['UUU', 'UFU', 'UUU'])
    expect(crop.visible_window).toBeUndefined()
    expect(crop.explored_record.chunks_on_surface).toBe(1)
    expect(crop.explored_record.outside_crop).toBe(0)
  })

  it('reports the visible window and how much of the explored record lies outside the crop', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: -4, y: -4 }, { x: 9, y: 9 }, { x: 7, y: 7, surface_index: 2 }], 5)
    const crop = map_crop(read_only_force(), read_only_surface(), { x: 0, y: 0 }, 3)

    expect(crop.visible_window).toEqual({ chunk: { x: 0, y: 0 }, chunk_radius: 2 })
    // 25 window chunks + 3 extras on surface 1 (the surface 2 chunk is not this surface's record).
    expect(crop.explored_record.chunks_on_surface).toBe(28)
    // (-4,-4) and (9,9) are outside radius 3; (3,0) is inside.
    expect(crop.explored_record.outside_crop).toBe(2)
    expect(crop.explored_record.chunk_bounds).toEqual({ min: { x: -4, y: -4 }, max: { x: 9, y: 9 } })
  })

  it('is read-only: it never charts, generates or scans, and leaves the knowledge record untouched', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [{ x: 3, y: 0 }], 4)
    const before = JSON.stringify(G.storage)
    // force.chart, surface.request_to_generate_chunks, find_entities_filtered and get_chunks all throw in these fakes.
    expect(() => map_crop(read_only_force(), read_only_surface(), { x: 1, y: 1 }, 4)).not.toThrow()
    expect(JSON.stringify(G.storage)).toBe(before)
  })
})

describe('knowledge revision (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 10 }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
  })

  function charting_force(index = 1) {
    return { index, chart: vi.fn(), is_chunk_visible: () => false, is_chunk_charted: () => false } as any
  }

  it('bumps when observe_window first records a window, and not when it is called again at the same chunk', () => {
    const force = charting_force()
    const surface = { index: 1 } as any
    expect(knowledge_revision(force)).toBe(0)
    observe_window(force, surface, 0, 0)
    const first = knowledge_revision(force)
    expect(first).toBeGreaterThan(0)
    observe_window(force, surface, 0, 0)
    observe_window(force, surface, 0, 0)
    expect(knowledge_revision(force)).toBe(first)
    expect(map_knowledge_summary(force).revision).toBe(first)
  })

  it('bumps when the window moves to another chunk, and again when it moves back over explored chunks', () => {
    const force = charting_force()
    const surface = { index: 1 } as any
    observe_window(force, surface, 0, 0)
    const at_origin = knowledge_revision(force)
    observe_window(force, surface, 1, 0)
    const moved = knowledge_revision(force)
    expect(moved).toBeGreaterThan(at_origin)
    // Moving back explores nothing new but the visible window changed, so what the NPC sees now changed.
    observe_window(force, surface, 0, 0)
    expect(knowledge_revision(force)).toBeGreaterThan(moved)
  })

  it('bumps when the window moves to another surface at the same chunk coordinates', () => {
    const force = charting_force()
    observe_window(force, { index: 1 } as any, 0, 0)
    const before = knowledge_revision(force)
    observe_window(force, { index: 2 } as any, 0, 0)
    expect(knowledge_revision(force)).toBeGreaterThan(before)
  })

  it('bumps when a window exploring a new chunk is recorded over an existing record that lacks it', () => {
    const force = charting_force()
    const surface = { index: 1 } as any
    // A record from before the revision counter: window already at (0,0), only the centre chunk explored.
    G.storage.sgluna_map_knowledge = {
      force_index: 1,
      explored: { '1:0:0': { surface_index: 1, x: 0, y: 0 } },
      visible_surface_index: 1,
      visible_chunk_x: 0,
      visible_chunk_y: 0,
      push_queue: [],
    }
    expect(knowledge_revision(force)).toBe(0)
    observe_window(force, surface, 0, 0)
    expect(knowledge_revision(force)).toBe(1)
    observe_window(force, surface, 0, 0)
    expect(knowledge_revision(force)).toBe(1)
  })

  function engine_surface(chunks: Array<{ x: number, y: number }>) {
    return { index: 1, get_chunks: () => chunks } as any
  }

  it('pull_engine_chart bumps the revision only when it adds explored chunks', () => {
    const chunks = [{ x: 10, y: 10 }, { x: 11, y: 10 }]
    const surface = engine_surface(chunks)
    const force = charting_force()
    force.is_chunk_charted = (_surface: unknown, chunk: { x: number, y: number }) => chunk.x === 10
    G.storage.sgluna_map_knowledge = { force_index: 1, explored: {}, push_queue: [], revision: 7 }

    expect(pull_engine_chart(force, surface)).toBe(1)
    expect(knowledge_revision(force)).toBe(8)
    // Nothing new to add: no bump.
    expect(pull_engine_chart(force, surface)).toBe(0)
    expect(knowledge_revision(force)).toBe(8)
    // The engine charts another chunk: bump once.
    force.is_chunk_charted = () => true
    expect(pull_engine_chart(force, surface)).toBe(1)
    expect(knowledge_revision(force)).toBe(9)
  })

  it('pull_engine_chart on an engine that charted nothing does not bump a fresh record', () => {
    const force = charting_force()
    expect(pull_engine_chart(force, engine_surface([{ x: 1, y: 1 }]))).toBe(0)
    expect(knowledge_revision(force)).toBe(0)
  })

  it('exposes the revision to the crop that reads the same knowledge', () => {
    const force = charting_force()
    const surface = { index: 1, name: 'nauvis' } as any
    observe_window(force, surface, 0, 0)
    expect(map_crop(force, surface, { x: 0, y: 0 }, 1).revision).toBe(knowledge_revision(force))
    observe_window(force, surface, 4, 4)
    expect(map_crop(force, surface, { x: 4, y: 4 }, 1).revision).toBe(knowledge_revision(force))
  })
})

describe('map_crop_around and autorio_map.crop (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game
  const originalAddInterface = G.remote.add_interface

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 55 }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
    G.remote.add_interface = originalAddInterface
  })

  function actor_at(x: number, y: number) {
    return { is_valid: true, position: { x, y }, force: read_only_force(), surface: read_only_surface() } as unknown as ControlledActor
  }

  it('refuses a radius that is not an integer from 1 to 4', () => {
    const actor = actor_at(0, 0)
    for (const radius of [0, 5, 2.5, -1, Number.NaN]) {
      expect(map_crop_around(actor, radius)).toEqual({ ok: false, code: 'invalid_radius', max_radius: 4 })
    }
    for (const radius of [1, 2, 3, 4]) expect(map_crop_around(actor, radius)).toMatchObject({ ok: true, code: 'ok' })
  })

  it('refuses x without y and y without x', () => {
    const actor = actor_at(0, 0)
    expect(map_crop_around(actor, 2, 10, undefined)).toEqual({ ok: false, code: 'invalid_position' })
    expect(map_crop_around(actor, 2, undefined, 10)).toEqual({ ok: false, code: 'invalid_position' })
  })

  it('refuses a position that is not a finite number', () => {
    const actor = actor_at(0, 0)
    expect(map_crop_around(actor, 2, Number.NaN, 0)).toMatchObject({ ok: false, code: 'invalid_position' })
    expect(map_crop_around(actor, 2, 0, 2_000_000)).toMatchObject({ ok: false, code: 'invalid_position' })
  })

  it('defaults to radius 3 centred on the chunk the actor stands in', () => {
    const result: any = map_crop_around(actor_at(70, -40))
    expect(result.ok).toBe(true)
    // (70, -40) is chunk (2, -2); radius 3 gives origin chunk (-1, -5).
    expect(result.crop.center_chunk).toEqual({ x: 2, y: -2 })
    expect(result.crop.radius_chunks).toBe(3)
    expect(result.crop.origin).toEqual({ chunk: { x: -1, y: -5 }, tile: { x: -32, y: -160 } })
    expect(result.crop.rows).toHaveLength(7)
  })

  it('floors negative actor positions to the chunk to the west and north', () => {
    const result: any = map_crop_around(actor_at(-0.5, -32), 1)
    expect(result.crop.center_chunk).toEqual({ x: -1, y: -1 })
  })

  it('centres on x/y when both are given', () => {
    const result: any = map_crop_around(actor_at(0, 0), 2, 100, 200)
    expect(result.ok).toBe(true)
    expect(result.crop.center_chunk).toEqual({ x: 3, y: 6 })
    expect(result.crop.origin.chunk).toEqual({ x: 1, y: 4 })
  })

  it('ships the knowledge the actor holds, read-only', () => {
    G.storage.sgluna_map_knowledge = window_knowledge({ x: 0, y: 0 }, [], 6)
    const result: any = map_crop_around(actor_at(16, 16), 2)
    expect(result.crop.rows).toEqual(['VVVVV', 'VVVVV', 'VVVVV', 'VVVVV', 'VVVVV'])
    expect(result.crop.revision).toBe(6)
    expect(result.crop.observed_tick).toBe(55)
  })

  it('serves the crop through the autorio_map remote, and reports no_actor without an actor', () => {
    let remote_interface: any
    G.remote.add_interface = (name: string, functions: any) => {
      if (name === 'autorio_map') remote_interface = functions
    }
    let current: ControlledActor | undefined
    create_map_remote_interface(() => current)
    expect(typeof remote_interface.crop).toBe('function')
    expect(remote_interface.crop()).toEqual({ ok: false, code: 'no_actor' })
    current = { ...actor_at(0, 0), is_valid: false } as unknown as ControlledActor
    expect(remote_interface.crop()).toEqual({ ok: false, code: 'no_actor' })
    current = actor_at(0, 0)
    expect(remote_interface.crop(2)).toMatchObject({ ok: true, crop: { radius_chunks: 2, center_chunk: { x: 0, y: 0 } } })
    expect(remote_interface.crop(9)).toEqual({ ok: false, code: 'invalid_radius', max_radius: 4 })
    expect(remote_interface.crop(2, 5)).toEqual({ ok: false, code: 'invalid_position' })
  })
})
