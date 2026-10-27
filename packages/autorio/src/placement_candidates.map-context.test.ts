import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_placement_candidate_set, placement_candidates_for_actor } from './placement_candidates'

// M3: a placement candidate is fresh authority only where the NPC sees the map now. A footprint touching a fogged or
// never-seen chunk is neither probed against the live world nor returned; it is counted, and the answer then says the
// search was incomplete instead of that no site exists. Each answer carries the map facts it was read against.

const KIT = 'map-context-kit'
const G: any = globalThis

interface Visibility {
  engine_visible?: (chunk: { x: number, y: number }) => boolean
  engine_charted?: (chunk: { x: number, y: number }) => boolean
}

function make_actor(visibility: Visibility = {}, can_place: (args: any) => boolean = () => true) {
  const probes: Array<{ x: number, y: number }> = []
  const actor = {
    is_valid: true,
    position: { x: 0, y: 0 },
    force: {
      index: 1,
      is_chunk_visible: (_surface: any, chunk: { x: number, y: number }) => (visibility.engine_visible ?? (() => true))(chunk),
      is_chunk_charted: (_surface: any, chunk: { x: number, y: number }) => (visibility.engine_charted ?? (() => true))(chunk),
      chart: () => { throw new Error('a candidate read must not chart') },
    },
    status_snapshot: () => ({ actor_id: 5 }),
    get_main_inventory: () => ({ get_item_count: (name: string) => name === KIT ? 1 : 0 }),
    surface: {
      index: 1,
      name: 'nauvis',
      can_place_entity: (args: any) => { probes.push(args.position); return can_place(args) },
      find_entities_filtered: () => [],
      request_to_generate_chunks: () => { throw new Error('a candidate read must not generate chunks') },
    },
  } as any
  return { actor, probes }
}

// The NPC's own knowledge as awareness records it with no connected player: a 5x5 visible window around its chunk, every
// chunk it has seen explored, and an older explored chunk far away.
function knowledge(window: { x: number, y: number }, extra: Array<{ x: number, y: number }> = []) {
  const explored: Record<string, any> = {}
  for (let x = window.x - 2; x <= window.x + 2; x++) {
    for (let y = window.y - 2; y <= window.y + 2; y++) explored[`1:${x}:${y}`] = { surface_index: 1, x, y }
  }
  for (const chunk of extra) explored[`1:${chunk.x}:${chunk.y}`] = { surface_index: 1, x: chunk.x, y: chunk.y }
  return { force_index: 1, explored, visible_surface_index: 1, visible_chunk_x: window.x, visible_chunk_y: window.y, push_queue: [] }
}

describe('placement candidates and map knowledge (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game
  const originalEntityPrototypes = G.prototypes.entity

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 4321 }
    G.prototypes.item[KIT] = {}
    G.prototypes.entity = { 'map-crate': { name: 'map-crate', type: 'container', tile_width: 1, tile_height: 1, supports_direction: false, items_to_place_this: [{ name: KIT, count: 1 }] } }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
    G.prototypes.entity = originalEntityPrototypes
    delete G.prototypes.item[KIT]
  })

  it('returns only footprints in visible chunks, never probes the fogged ones, and reports the search incomplete', () => {
    // Chunk x=0 (tiles 0..31) is visible; chunk x=1 is charted but fogged.
    const { actor, probes } = make_actor({ engine_visible: chunk => chunk.x <= 0 })
    const result = placement_candidates_for_actor(actor, { entity_name: 'map-crate', center: { x: 30, y: 10 }, radius: 6, limit: 8 }) as any
    expect(result.ok).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const candidate of result.candidates) expect(candidate.position.x).toBeLessThan(32)
    for (const position of probes) expect(position.x).toBeLessThan(32)
    expect(result.search_completeness.not_visible_rejected_count).toBeGreaterThan(0)
    expect(result.search_completeness.complete).toBe(false)
    expect(result.search_completeness.reason).toBe('area_not_fully_visible')
    expect(result.spatial_status).toBe('candidates_found')
    const coverage = result.map_context.evaluated_area_coverage
    expect(coverage.visible_chunks).toBeGreaterThan(0)
    expect(coverage.fogged_chunks).toBeGreaterThan(0)
    expect(coverage.uncharted_chunks).toBe(0)
  })

  it('says search_incomplete, never none_in_verified_scope, when the whole area is unseen', () => {
    const { actor, probes } = make_actor({ engine_visible: () => false, engine_charted: () => false })
    const result = placement_candidates_for_actor(actor, { entity_name: 'map-crate', center: { x: 200, y: 200 }, radius: 4 }) as any
    expect(result.candidates).toEqual([])
    expect(probes).toEqual([])
    expect(result.spatial_status).toBe('search_incomplete')
    expect(result.search_completeness.reason).toBe('area_not_fully_visible')
    expect(result.execution_eligibility).toBe('no_candidate')
    expect(result.map_context.evaluated_area_coverage.uncharted_chunks).toBe(result.map_context.evaluated_area_coverage.total_chunks)
  })

  it('keeps an explored but fogged area out of the candidates: an old observation is not a fresh site', () => {
    // No connected player: the engine charts and sees nothing. The NPC explored chunk (6, 6) earlier and now stands at chunk (0, 0).
    G.storage.sgluna_map_knowledge = knowledge({ x: 0, y: 0 }, [{ x: 6, y: 6 }])
    const { actor, probes } = make_actor({ engine_visible: () => false, engine_charted: () => false })
    const result = placement_candidates_for_actor(actor, { entity_name: 'map-crate', center: { x: 208, y: 208 }, radius: 4 }) as any
    expect(result.candidates).toEqual([])
    expect(probes).toEqual([])
    expect(result.spatial_status).toBe('search_incomplete')
    const coverage = result.map_context.evaluated_area_coverage
    expect(coverage.charted_chunks).toBe(coverage.total_chunks)
    expect(coverage.fogged_chunks).toBe(coverage.total_chunks)
    expect(coverage.visible_chunks).toBe(0)
  })

  it('finds candidates with zero connected players from the NPC visible window alone', () => {
    G.storage.sgluna_map_knowledge = knowledge({ x: 0, y: 0 }, [{ x: 6, y: 6 }])
    const { actor } = make_actor({ engine_visible: () => false, engine_charted: () => false })
    const result = placement_candidates_for_actor(actor, { entity_name: 'map-crate', center: { x: 0, y: 0 }, radius: 3 }) as any
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.search_completeness.complete).toBe(true)
    expect(result.search_completeness.not_visible_rejected_count).toBe(0)
    expect(result.spatial_status).toBe('candidates_found')
    expect(result.map_context).toMatchObject({
      source: 'npc_map_knowledge',
      observed_tick: 4321,
      surface_index: 1,
      surface_name: 'nauvis',
      candidate_authority: 'currently_visible_chunks_only',
      visible_window: { surface_index: 1, chunk: { x: 0, y: 0 }, chunk_radius: 2 },
      explored_chunks: 26,
    })
    const coverage = result.map_context.evaluated_area_coverage
    expect(coverage.visible_chunks).toBe(coverage.total_chunks)
    expect(coverage.fogged_chunks).toBe(0)
  })

  it('reports the evaluated area after the region filter, with a region in a fogged chunk incomplete rather than empty', () => {
    G.storage.sgluna_map_knowledge = knowledge({ x: 0, y: 0 }, [{ x: 6, y: 6 }])
    const { actor } = make_actor({ engine_visible: () => false, engine_charted: () => false })
    const result = placement_candidates_for_actor(actor, { entity_name: 'map-crate', region: { shape: 'circle', center: { x: 208, y: 208 }, radius: 3 } }) as any
    expect(result.candidates).toEqual([])
    expect(result.spatial_status).toBe('search_incomplete')
    const area = result.map_context.evaluated_area
    expect(area.left_top.x).toBeGreaterThanOrEqual(204)
    expect(area.right_bottom.x).toBeLessThanOrEqual(212)
  })

  it('keeps the map context on the stored-set answer the model reads, with the same tick as the set', () => {
    const { actor } = make_actor()
    const result = create_placement_candidate_set(actor, { entity_name: 'map-crate', center: { x: 0, y: 0 }, radius: 2 }) as any
    expect(result.ok).toBe(true)
    expect(result.map_context.observed_tick).toBe(result.generated_tick)
    expect(result.map_context.surface_index).toBe(1)
  })
})
