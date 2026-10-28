import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entity_reference_hint, remember_entity_reference, resolve_visible_entity_reference } from './entity_reference'
import { observe_window } from './map_knowledge'
import { with_refusal_class } from './refusal_classes'
import { create_placement_candidate_set, execute_placement_candidate, placement_candidate_matches, placement_candidate_preflight, placement_candidates_for_actor } from './placement_candidates'

// M3: a live-world read that names facts or grants execution authority covers only the chunks the NPC sees now (its own 5x5
// knowledge window, or the engine's own visibility). An entity the model names in an unseen chunk is `not_visible` whether or
// not it still exists, nothing is scanned there, and its observation hint is not refreshed. A candidate read while visible
// grants nothing once its read area is no longer visible.
// Pre-change (41a77583) resolve_visible_entity_reference does not exist, placement candidates never test visibility again at
// resolution, and anchor / connects_to resolve through resolve_exact_entity. Each test names the assertion that fails there.

const G: any = globalThis

function set_window(chunk_x: number, chunk_y: number, extra_explored: Array<{ x: number, y: number }> = []) {
  const explored: Record<string, any> = {}
  for (let x = chunk_x - 2; x <= chunk_x + 2; x++) {
    for (let y = chunk_y - 2; y <= chunk_y + 2; y++) explored[`1:${x}:${y}`] = { surface_index: 1, x, y }
  }
  for (const chunk of extra_explored) explored[`1:${chunk.x}:${chunk.y}`] = { surface_index: 1, x: chunk.x, y: chunk.y }
  G.storage.sgluna_map_knowledge = { force_index: 1, explored, visible_surface_index: 1, visible_chunk_x: chunk_x, visible_chunk_y: chunk_y, push_queue: [] }
}

function world_entity(unit_number: number, x: number, y: number, fields: Record<string, unknown> = {}) {
  return {
    valid: true,
    unit_number,
    name: 'stone-furnace',
    type: 'furnace',
    position: { x, y },
    bounding_box: { left_top: { x: x - 1, y: y - 1 }, right_bottom: { x: x + 1, y: y + 1 } },
    surface: { index: 1 },
    force: { index: 1 },
    ...fields,
  } as any
}

describe('resolve_visible_entity_reference (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalLookup = G.game.get_entity_by_unit_number
  const originalTick = G.game.tick

  let lookup: Record<number, any>
  let find: ReturnType<typeof vi.fn>
  let actor: ControlledActor

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game.tick = 500
    lookup = {}
    G.game.get_entity_by_unit_number = (unit_number: number) => lookup[unit_number]
    find = vi.fn(() => [])
    actor = {
      is_valid: true,
      position: { x: 0, y: 0 },
      force: { index: 1, is_chunk_visible: () => false, is_chunk_charted: () => false },
      surface: { index: 1, find_entities_filtered: find },
    } as unknown as ControlledActor
    // The NPC stands at chunk (0, 0): it sees chunks -2..2 on both axes (tiles -64..95).
    set_window(0, 0)
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game.get_entity_by_unit_number = originalLookup
    G.game.tick = originalTick
  })

  it('a remembered entity in a fogged chunk is not_visible whether it still stands or was destroyed, and nothing is scanned', () => {
    // Chunk (6, 6) is outside the window. The NPC saw this furnace there earlier.
    const furnace = world_entity(104, 200.5, 200.5)
    remember_entity_reference(furnace)
    G.game.tick = 900

    // Still standing: the engine finds it through the observation hint, but the NPC does not see that chunk now.
    find.mockReturnValue([furnace])
    expect(resolve_visible_entity_reference(actor, 104, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(resolve_visible_entity_reference(actor, 104, 'map_visible')).toEqual({ code: 'not_visible' })
    // Destroyed: the answer is the same, so the model learns nothing about the unseen chunk either way.
    find.mockReturnValue([])
    expect(resolve_visible_entity_reference(actor, 104, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(find).not.toHaveBeenCalled()
    // The old observation is untouched: not refreshed to the later tick.
    expect(entity_reference_hint(104)).toMatchObject({ observed_tick: 500, position: { x: 200.5, y: 200.5 } })
  })

  it('an entity the engine looks up directly in an unseen chunk is not_visible and its hint is not refreshed', () => {
    const furnace = world_entity(105, 200.5, 200.5)
    lookup[105] = furnace
    // An older hint for the same unit, at the tick it was last observed.
    G.storage.sgluna_entity_reference_hints = { 105: { name: 'stone-furnace', surface_index: 1, force_index: 1, position: { x: 200.5, y: 200.5 }, observed_tick: 5 } }
    G.game.tick = 999

    expect(resolve_visible_entity_reference(actor, 105, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(entity_reference_hint(105)).toMatchObject({ observed_tick: 5 })
    // A unit with no hint gets none from the refused read.
    lookup[106] = world_entity(106, 300.5, 300.5)
    expect(resolve_visible_entity_reference(actor, 106, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(entity_reference_hint(106)).toBeUndefined()
    expect(find).not.toHaveBeenCalled()
  })

  it('an entity whose box reaches one unseen chunk is not_visible even when its centre is seen', () => {
    // Tiles up to x = 95 are seen (chunk 2); the box reaches x = 96 (chunk 3).
    lookup[107] = world_entity(107, 95, 10, { bounding_box: { left_top: { x: 94, y: 9 }, right_bottom: { x: 96.5, y: 11 } } })
    expect(resolve_visible_entity_reference(actor, 107, 'actor_body')).toEqual({ code: 'not_visible' })
    lookup[108] = world_entity(108, 90, 10)
    expect(resolve_visible_entity_reference(actor, 108, 'actor_body')).toMatchObject({ code: 'ok' })
  })

  it('an entity on another surface is wrong_surface, directly and through its hint', () => {
    lookup[110] = world_entity(110, 200.5, 200.5, { surface: { index: 2 } })
    expect(resolve_visible_entity_reference(actor, 110, 'actor_body')).toEqual({ code: 'wrong_surface' })
    expect(resolve_visible_entity_reference(actor, 110, 'map_visible')).toEqual({ code: 'wrong_surface' })
    G.storage.sgluna_entity_reference_hints = { 111: { name: 'stone-furnace', surface_index: 2, force_index: 1, position: { x: 1, y: 1 }, observed_tick: 1 } }
    expect(resolve_visible_entity_reference(actor, 111, 'actor_body')).toEqual({ code: 'wrong_surface' })
    expect(find).not.toHaveBeenCalled()
  })

  it('another force is not_found in actor_body scope but resolves in map_visible scope when seen', () => {
    const wreck = world_entity(112, 10.5, 10.5, { force: { index: 3 } })
    lookup[112] = wreck
    expect(resolve_visible_entity_reference(actor, 112, 'actor_body')).toEqual({ code: 'not_found' })
    expect(resolve_visible_entity_reference(actor, 112, 'map_visible')).toEqual({ entity: wreck, code: 'ok' })
    // By hint as well: the force of the observation decides in actor_body scope.
    G.storage.sgluna_entity_reference_hints = { 113: { name: 'stone-furnace', surface_index: 1, force_index: 3, position: { x: 10.5, y: 10.5 }, observed_tick: 1 } }
    expect(resolve_visible_entity_reference(actor, 113, 'actor_body')).toEqual({ code: 'not_found' })
    expect(find).not.toHaveBeenCalled()
  })

  it('a seen entity resolves ok and its hint is refreshed', () => {
    const furnace = world_entity(114, 20.5, 20.5)
    lookup[114] = furnace
    G.storage.sgluna_entity_reference_hints = { 114: { name: 'stone-furnace', surface_index: 1, force_index: 1, position: { x: 1, y: 1 }, observed_tick: 5 } }
    G.game.tick = 700
    expect(resolve_visible_entity_reference(actor, 114, 'actor_body')).toEqual({ entity: furnace, code: 'ok' })
    expect(entity_reference_hint(114)).toMatchObject({ observed_tick: 700, position: { x: 20.5, y: 20.5 } })
  })

  it('a seen entity found through its hint resolves ok, and a seen but destroyed one is not_found', () => {
    const furnace = world_entity(115, 20.5, 20.5)
    remember_entity_reference(furnace)
    find.mockReturnValue([furnace])
    expect(resolve_visible_entity_reference(actor, 115, 'actor_body')).toEqual({ entity: furnace, code: 'ok' })
    expect(find).toHaveBeenCalledTimes(1)
    find.mockReturnValue([])
    expect(resolve_visible_entity_reference(actor, 115, 'actor_body')).toEqual({ code: 'not_found' })
  })

  it('after the NPC returns, the same destroyed entity is not_found instead of not_visible, and a surviving one is ok', () => {
    const doomed = world_entity(116, 200.5, 200.5)
    const survivor = world_entity(117, 201.5, 200.5)
    remember_entity_reference(doomed)
    remember_entity_reference(survivor)
    // Away: both unseen.
    find.mockImplementation(({ position }: any) => position.x === 201.5 ? [survivor] : [])
    expect(resolve_visible_entity_reference(actor, 116, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(resolve_visible_entity_reference(actor, 117, 'actor_body')).toEqual({ code: 'not_visible' })
    expect(find).not.toHaveBeenCalled()
    // The NPC walks to chunk (6, 6): the site is seen again and the scan may run.
    set_window(6, 6)
    expect(resolve_visible_entity_reference(actor, 116, 'actor_body')).toEqual({ code: 'not_found' })
    expect(resolve_visible_entity_reference(actor, 117, 'actor_body')).toEqual({ entity: survivor, code: 'ok' })
  })

  it('the hidden NPC vision vehicle is never a reference', () => {
    lookup[118] = world_entity(118, 10, 10, { name: 'sgluna-npc-vision' })
    expect(resolve_visible_entity_reference(actor, 118, 'actor_body')).toEqual({ code: 'not_found' })
  })

  it('treats engine-visible chunks as seen with no knowledge record', () => {
    delete G.storage.sgluna_map_knowledge
    ;(actor.force as any).is_chunk_visible = (_surface: unknown, chunk: { x: number, y: number }) => chunk.x === 6 && chunk.y === 6
    lookup[119] = world_entity(119, 200.5, 200.5)
    lookup[120] = world_entity(120, 10.5, 10.5)
    expect(resolve_visible_entity_reference(actor, 119, 'actor_body')).toMatchObject({ code: 'ok' })
    expect(resolve_visible_entity_reference(actor, 120, 'actor_body')).toEqual({ code: 'not_visible' })
  })
})

const KIT = 'visibility-kit'

describe('candidate freshness and anchors (M3)', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game
  const originalEntityPrototypes = G.prototypes.entity

  let probes: Array<{ x: number, y: number }>
  let lookup: Record<number, any>
  let engine_visible: (chunk: { x: number, y: number }) => boolean

  function make_actor() {
    return {
      is_valid: true,
      position: { x: 0, y: 0 },
      force: {
        index: 1,
        is_chunk_visible: (_surface: unknown, chunk: { x: number, y: number }) => engine_visible(chunk),
        is_chunk_charted: () => false,
        chart: () => {},
      },
      status_snapshot: () => ({ actor_id: 5 }),
      get_main_inventory: () => ({ get_item_count: (name: string) => name === KIT ? 1 : 0 }),
      surface: {
        index: 1,
        name: 'nauvis',
        can_place_entity: (args: any) => { probes.push(args.position); return true },
        find_entities_filtered: () => [],
        request_to_generate_chunks: () => { throw new Error('a candidate read must not generate chunks') },
      },
    } as any
  }

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 3000, get_entity_by_unit_number: (unit_number: number) => lookup[unit_number] }
    probes = []
    lookup = {}
    engine_visible = () => false
    G.prototypes.item[KIT] = {}
    G.prototypes.entity = {
      'vis-crate': { name: 'vis-crate', type: 'container', tile_width: 1, tile_height: 1, supports_direction: false, items_to_place_this: [{ name: KIT, count: 1 }] },
      'vis-drill': { name: 'vis-drill', type: 'mining-drill', tile_width: 1, tile_height: 1, supports_direction: false, mining_drill_radius: 2.5, resource_categories: { ore: true }, items_to_place_this: [{ name: KIT, count: 1 }] },
    }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
    G.prototypes.entity = originalEntityPrototypes
    delete G.prototypes.item[KIT]
  })

  // The NPC observes the window around chunk (x, y) the way awareness does with no connected player.
  function observe(actor: any, x: number, y: number) {
    observe_window(actor.force, actor.surface, x, y)
  }

  it('a candidate read while visible is refused with placement_candidate_not_visible, without any probe, once its site is fogged', () => {
    const actor = make_actor()
    observe(actor, 0, 0)
    const set: any = create_placement_candidate_set(actor, { entity_name: 'vis-crate', center: { x: 10.5, y: 10.5 }, radius: 2, limit: 2 })
    expect(set.ok).toBe(true)
    const candidate_id = set.candidates[0].id
    const preflight = () => placement_candidate_preflight(actor, set.candidate_set_id, candidate_id) as any

    // Control: still visible, the candidate is valid (this also holds before the change).
    probes.length = 0
    expect(preflight()).toMatchObject({ ok: true })
    expect(probes.length).toBeGreaterThan(0)

    // The NPC walks away: chunk (0, 0) stays explored but is out of the window. Pre-change: ok is true and can_place_entity runs.
    observe(actor, 10, 10)
    probes.length = 0
    const result = preflight()
    expect(result).toMatchObject({ ok: false, code: 'placement_candidate_unavailable' })
    expect(result.error.startsWith('placement_candidate_not_visible')).toBe(true)
    expect(probes).toEqual([])
    // control.ts passes the place_candidate preflight through with_refusal_class: a stale candidate is an `argument` refusal, the
    // class that routes into the existing one-correction-turn stale-candidate path. Pre-change the preflight is ok:true and
    // carries no refusal class.
    expect(with_refusal_class(result).refusal_class).toBe('argument')

    // Execution is refused the same way and queues nothing.
    const submitted = vi.fn(() => true)
    const executed = execute_placement_candidate(actor, set.candidate_set_id, candidate_id, submitted)
    expect(executed[0]).toBe(false)
    expect(executed[1]).toContain('placement_candidate_not_visible')
    expect(submitted).not.toHaveBeenCalled()
    expect(placement_candidate_matches(actor, { candidate_set_id: set.candidate_set_id, candidate_id }, 'vis-crate', set.candidates[0].position.x, set.candidates[0].position.y, set.candidates[0].direction)).toBe(false)
    expect(probes).toEqual([])

    // Back near the site the same stored candidate is valid again: selection to execution is checked, not remembered.
    observe(actor, 0, 0)
    expect(preflight()).toMatchObject({ ok: true })
  })

  it('refuses on engine visibility alone, with no knowledge record', () => {
    engine_visible = () => true
    const actor = make_actor()
    const set: any = create_placement_candidate_set(actor, { entity_name: 'vis-crate', center: { x: 10.5, y: 10.5 }, radius: 2, limit: 1 })
    expect(set.ok).toBe(true)
    engine_visible = () => false
    probes.length = 0
    const result = placement_candidate_preflight(actor, set.candidate_set_id, set.candidates[0].id) as any
    expect(result).toMatchObject({ ok: false, code: 'placement_candidate_unavailable' })
    expect(result.error).toContain('placement_candidate_not_visible')
    expect(probes).toEqual([])
  })

  it('holds a drill candidate to its mining area: a visible footprint whose mining area reaches an unseen chunk is stale', () => {
    // Everything is visible when the candidate is read: footprint at x = 30.5, mining area to x = 33 (chunk 1).
    engine_visible = () => true
    const actor = make_actor()
    const set: any = create_placement_candidate_set(actor, { entity_name: 'vis-drill', center: { x: 30.5, y: 10.5 }, radius: 1, limit: 8 })
    expect(set.ok).toBe(true)
    const near_edge = set.candidates.find((candidate: any) => candidate.position.x + 2.5 > 32 && candidate.position.x + 0.5 <= 32)
    expect(near_edge).toBeDefined()
    // Only chunk x = 0 stays visible: the footprint is still seen, the mining area is not.
    engine_visible = chunk => chunk.x === 0 && chunk.y === 0
    probes.length = 0
    const result = placement_candidate_preflight(actor, set.candidate_set_id, near_edge.id) as any
    expect(result).toMatchObject({ ok: false, code: 'placement_candidate_unavailable' })
    expect(result.error).toContain('placement_candidate_not_visible')
    expect(probes).toEqual([])
  })

  it('refuses an anchor in a fogged chunk as anchor_not_visible, whether or not it still exists', () => {
    const actor = make_actor()
    observe(actor, 0, 0)
    // Standing in chunk (6, 6), which the NPC no longer sees.
    lookup[40] = world_entity(40, 200.5, 200.5)
    const present: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', anchor: { unit_number: 40 } })
    expect(present).toMatchObject({ ok: false, code: 'anchor_not_visible', unit_number: 40 })

    // A remembered, now destroyed anchor in the same chunk gives the same answer rather than anchor_entity_not_found.
    remember_entity_reference(lookup[40])
    delete lookup[40]
    const destroyed: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', anchor: { unit_number: 40 } })
    expect(destroyed).toMatchObject({ ok: false, code: 'anchor_not_visible' })
    expect(probes).toEqual([])

    // A unit that was never seen stays anchor_entity_not_found.
    expect(placement_candidates_for_actor(actor, { entity_name: 'vis-crate', anchor: { unit_number: 41 } })).toMatchObject({ ok: false, code: 'anchor_entity_not_found' })
  })

  it('accepts an anchor the NPC sees now', () => {
    const actor = make_actor()
    observe(actor, 0, 0)
    lookup[42] = world_entity(42, 10.5, 10.5)
    const result: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', anchor: { unit_number: 42 }, limit: 1 })
    expect(result.ok).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
  })

  it('refuses connects_to in a fogged chunk as connects_to_not_visible, whether or not it still exists', () => {
    const actor = make_actor()
    observe(actor, 0, 0)
    lookup[50] = world_entity(50, 200.5, 200.5)
    const present: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', connects_to: { unit_number: 50 } })
    expect(present).toMatchObject({ ok: false, code: 'connects_to_not_visible', unit_number: 50 })
    remember_entity_reference(lookup[50])
    delete lookup[50]
    expect(placement_candidates_for_actor(actor, { entity_name: 'vis-crate', connects_to: { unit_number: 50 } })).toMatchObject({ ok: false, code: 'connects_to_not_visible' })
    expect(placement_candidates_for_actor(actor, { entity_name: 'vis-crate', connects_to: { unit_number: 51 } })).toMatchObject({ ok: false, code: 'connects_to_entity_not_found' })
    expect(probes).toEqual([])
  })

  it('the map context of a candidate answer carries the revision and a crop around the searched area', () => {
    const actor = make_actor()
    observe(actor, 0, 0)
    const revision = G.storage.sgluna_map_knowledge.revision
    expect(revision).toBeGreaterThan(0)
    const result: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', center: { x: 10.5, y: 10.5 }, radius: 2, limit: 1 })
    expect(result.map_context.revision).toBe(revision)
    expect(result.map_context.crop).toMatchObject({
      source: 'npc_map_knowledge',
      revision,
      observed_tick: 3000,
      radius_chunks: 2,
      center_chunk: { x: 0, y: 0 },
      origin: { chunk: { x: -2, y: -2 }, tile: { x: -64, y: -64 } },
      rows: ['VVVVV', 'VVVVV', 'VVVVV', 'VVVVV', 'VVVVV'],
      counts: { visible: 25, fogged: 0, unknown: 0, total: 25 },
    })
    // Moving the window changes the revision and the picture of the same area.
    observe(actor, 3, 0)
    const later: any = placement_candidates_for_actor(actor, { entity_name: 'vis-crate', center: { x: 10.5, y: 10.5 }, radius: 2, limit: 1 })
    expect(later.map_context.revision).toBeGreaterThan(revision)
    // The window now covers chunks 1..5: chunks -2..0 stay explored but fogged.
    expect(later.map_context.crop.rows[0]).toBe('FFFVV')
  })
})
