import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { check_single_placement, construction_plan_preflight, execute_validated_construction_plan, validate_construction_execution_plan } from './construction_execution'
import { layout_node_precheck } from './construction_layout'
import { propose_construction_layout } from './construction_proposal'
import { find_construction_sites } from './construction_site_planning'
import { local_spatial_observation } from './construction_planning'
import { remember_entity_reference } from './entity_reference'
import { with_refusal_class } from './refusal_classes'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

// M3 for construction: validation grants execution authority, so a footprint, an anchor, a connection endpoint or a search site
// in a chunk the NPC does not see now is refused without being probed; and a plan validated while its site was visible is
// refused again at preflight and execution once the site is fogged. Missing entities in seen chunks keep their old errors.
// Pre-change (41a77583) none of these gates exist: every "fogged" case there is accepted (ok:true) or probed. Each test names
// the first assertion that fails there.

const G: any = globalThis

const MASK = { layers: { object: true, item: true } }

function item_interface(count: number) {
  return {
    get_max_inventory_index: () => count,
    get_inventory: (index: number) => index >= 1 && index <= count ? { valid: true } : undefined,
    get_max_transport_line_index: () => 0,
  }
}

function prototype(name: string, type: string, tile: [number, number], half: number, extra: Record<string, any> = {}, inventories = 0) {
  return {
    inventories,
    get_inventory_size: (index: number) => index >= 1 && index <= inventories ? 16 : undefined,
    name,
    type,
    tile_width: tile[0],
    tile_height: tile[1],
    collision_box: { left_top: { x: -half, y: -half }, right_bottom: { x: half, y: half } },
    selection_box: { left_top: { x: -half, y: -half }, right_bottom: { x: half, y: half } },
    collision_mask: MASK,
    items_to_place_this: [{ name, count: 1 }],
    ...extra,
  }
}

const PROTOTYPES: Record<string, any> = {
  'stone-furnace': prototype('stone-furnace', 'furnace', [2, 2], 0.7),
  'test-chest': prototype('test-chest', 'container', [1, 1], 0.4, { supports_direction: false }, 1),
  'test-inserter': prototype('test-inserter', 'inserter', [1, 1], 0.15, {
    inserter_pickup_position: { x: 0, y: -1 },
    inserter_drop_position: { x: 0, y: 1.2 },
    electric_energy_source_prototype: {},
  }),
}
const BOILER_PROTOTYPE = { name: 'test-boiler', type: 'boiler', electric_energy_source_prototype: undefined, get_inventory_size: (index: number) => index === 1 ? 1 : undefined }

// The existing boiler straddles the chunk row boundary y = 32 (box y 31.01..32.99, x -0.49..1.49). The inserter at (0.5, 30.5)
// facing north picks up from the chest at (0.5, 29.5) and drops at (0.5, 31.7), inside the boiler. Both planned placements lie
// in chunk row 0; the boiler also reaches chunk row 1, which the tests fog.
const BOILER_UNIT = 500
const BOILER_AT = { x: 0.5, y: 32 }
const SRC = { entity_name: 'test-chest', x: 0.5, y: 29.5, slot: 'src' }
const INS = { entity_name: 'test-inserter', x: 0.5, y: 30.5, direction: 0, slot: 'ins' }
const FEED = { kind: 'inserter' as const, inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { unit_number: BOILER_UNIT } }

const ALL_VISIBLE = () => true
// Chunk row 0 and the chunk columns up to x = 0 are seen; everything else is fogged.
const ONLY_ROW_ZERO = (chunk: { x: number, y: number }) => chunk.y <= 0
const ONLY_COLUMN_ZERO = (chunk: { x: number, y: number }) => chunk.x <= 0

function build(held: Record<string, number> = { 'stone-furnace': 4, 'test-chest': 3, 'test-inserter': 2 }) {
  const state = { visible: ALL_VISIBLE as (chunk: { x: number, y: number }) => boolean }
  const by_unit = new Map<number, any>()
  const position = { x: 0.5, y: 25 }
  const character: any = { valid: true, name: 'character', type: 'character', position, bounding_box: { left_top: { x: -0.3, y: -0.3 }, right_bottom: { x: 0.3, y: 0.3 } }, force: { name: 'player' } }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    get_tile: vi.fn(() => ({ name: 'grass-1', collides_with: () => false })),
    find_entities_filtered: vi.fn(() => [character]),
    count_entities_filtered: vi.fn(() => 0),
    can_place_entity: vi.fn(() => true),
  }
  const inventory: any = {
    get_contents: vi.fn(() => Object.entries(held).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
    get_item_count: vi.fn((name: string) => held[name] ?? 0),
  }
  const actor = {
    is_valid: true,
    character,
    position,
    surface,
    force: {
      index: 1,
      name: 'player',
      is_chunk_visible: (_surface: unknown, chunk: { x: number, y: number }) => state.visible(chunk),
      is_chunk_charted: () => true,
    },
    get_main_inventory: () => inventory,
    status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character', valid: true, has_character: true, name: 'SGLuna', position }),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const basic = new_basic_operation_controller(() => actor, manager)
  G.game.get_entity_by_unit_number = (unit: number) => by_unit.get(unit)
  function existing(unit_number: number, at: { x: number, y: number }, half: { x: number, y: number }, fields: Record<string, any> = {}) {
    const entity: any = {
      valid: true,
      name: 'test-boiler',
      type: 'boiler',
      unit_number,
      position: at,
      direction: 0,
      surface: { index: 1 },
      force: { index: 1 },
      prototype: BOILER_PROTOTYPE,
      bounding_box: { left_top: { x: at.x - half.x, y: at.y - half.y }, right_bottom: { x: at.x + half.x, y: at.y + half.y } },
      ...item_interface(1),
      ...fields,
    }
    by_unit.set(unit_number, entity)
    return entity
  }
  const boiler = existing(BOILER_UNIT, BOILER_AT, { x: 0.99, y: 0.99 })
  return { actor, surface, state, manager, basic, existing, boiler, by_unit }
}

type World = ReturnType<typeof build>

function validate(f: World, placements: any[], connections?: any[]) {
  return validate_construction_execution_plan(f.actor, { plan_id: 'm3', placements, connections }) as any
}

describe('construction visibility authority (M3)', () => {
  const original = {
    pairs: G.pairs,
    entity: G.prototypes.entity,
    item: G.prototypes.item,
    get_entity: G.game.get_entity_by_unit_number,
    tick: G.game.tick,
  }

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game.tick = 100
    G.prototypes.entity = { ...PROTOTYPES }
    G.prototypes.item = Object.fromEntries(Object.keys(PROTOTYPES).map(name => [name, { stack_size: 50 }]))
  })

  afterEach(() => {
    G.pairs = original.pairs
    G.prototypes.entity = original.entity
    G.prototypes.item = original.item
    G.game.get_entity_by_unit_number = original.get_entity
    G.game.tick = original.tick
  })

  describe('single placements and plans', () => {
    it('validation refuses a footprint in a fogged chunk as NOT_VISIBLE, without a probe or a token', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      // The NPC stands beside the site, so only visibility can refuse it (the build reach is satisfied).
      Object.assign(f.actor.position, { x: 200, y: 12 })
      const result = validate(f, [{ entity_name: 'stone-furnace', x: 200, y: 10 }])
      // Pre-change: ok is true and can_place_entity ran.
      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_VISIBLE', index: 0 } })
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
      expect(G.storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('holds the whole footprint to visible chunks: a furnace straddling the chunk edge is refused, one inside it is accepted', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      // A 2x2 furnace at x = 32 stands on tiles 31..33 and reaches chunk 1.
      const straddling = check_single_placement(f.actor, { entity_name: 'stone-furnace', x: 32, y: 10 }, 0, false)
      expect(straddling).toMatchObject({ ok: false, error: { code: 'NOT_VISIBLE', index: 0 } })
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
      expect(check_single_placement(f.actor, { entity_name: 'stone-furnace', x: 30, y: 10 }, 0, false)).toMatchObject({ ok: true })
      expect(f.surface.can_place_entity).toHaveBeenCalledTimes(1)
    })

    it('a plan validated while visible is stale (NOT_VISIBLE) at preflight and execution once the site is fogged', () => {
      const f = build()
      const validation = validate(f, [{ entity_name: 'stone-furnace', x: 2, y: 28 }])
      expect(validation).toMatchObject({ ok: true })
      // The fogging happens inside the 3600-tick validity window: the refusal is staleness, not expiry.
      expect(G.game.tick - validation.created_tick).toBeLessThan(3600)
      const control = construction_plan_preflight(f.actor, validation.validation_id, 1)
      expect(control).toMatchObject({ ok: true })

      f.state.visible = () => false
      G.game.tick = validation.created_tick + 600
      f.surface.can_place_entity.mockClear()
      // Pre-change: ok is true.
      const stale: any = construction_plan_preflight(f.actor, validation.validation_id, 1)
      expect(stale).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'NOT_VISIBLE' })
      expect(with_refusal_class(stale).refusal_class).toBe('world')
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()

      const executed = execute_validated_construction_plan(f.actor, validation.validation_id, 1, f.basic, f.manager)
      expect(executed).toEqual([false, 'validated construction plan became stale: NOT_VISIBLE'])
      expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
    })

    it('a plan validated while visible still executes when the site is still visible at execution', () => {
      const f = build()
      const validation = validate(f, [{ entity_name: 'stone-furnace', x: 2, y: 28 }])
      expect(execute_validated_construction_plan(f.actor, validation.validation_id, 1, f.basic, f.manager)).toEqual([true, 'Validated construction plan started'])
    })
  })

  describe('local spatial observation', () => {
    it('refuses an area reaching an unseen chunk as area_not_visible, before any entity scan', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      const far: any = local_spatial_observation(f.actor, { position: { x: 200, y: 10 }, half_size: 4 })
      // Pre-change: ok is true and find_entities_filtered ran.
      expect(far.ok).toBe(false)
      expect(far.error.startsWith('area_not_visible')).toBe(true)
      expect(far.coverage).toMatchObject({ visible_chunks: 0, fogged_chunks: far.coverage.total_chunks })
      expect(far.bounds).toEqual({ left_top: { x: 196, y: 6 }, right_bottom: { x: 204, y: 14 } })
      expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
      expect(f.surface.get_tile).not.toHaveBeenCalled()

      // Half seen is not seen: the area reaches chunk 1.
      const edge: any = local_spatial_observation(f.actor, { position: { x: 30, y: 10 }, half_size: 4 })
      expect(edge.ok).toBe(false)
      expect(edge.coverage.visibility_partial).toBe(true)
      expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
    })

    it('reads a seen area as before', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      expect(local_spatial_observation(f.actor, { position: { x: 10, y: 10 }, half_size: 4 })).toMatchObject({ ok: true, tick: 100 })
      expect(f.surface.find_entities_filtered).toHaveBeenCalled()
    })

    it('refuses an anchor in a fogged chunk, whether or not it exists, and keeps anchor not found for an unknown unit', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      f.existing(70, { x: 200.5, y: 10.5 }, { x: 1, y: 1 })
      const present: any = local_spatial_observation(f.actor, { anchor_unit_number: 70, half_size: 4 })
      expect(present).toMatchObject({ ok: false })
      expect(present.error).toContain('does not see now')
      remember_entity_reference(f.by_unit.get(70))
      f.by_unit.delete(70)
      expect((local_spatial_observation(f.actor, { anchor_unit_number: 70 }) as any).error).toContain('does not see now')
      expect(local_spatial_observation(f.actor, { anchor_unit_number: 71 })).toEqual({ ok: false, error: 'anchor entity not found' })
      expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
    })
  })

  describe('construction site search', () => {
    function search(f: World, position: { x: number, y: number }, extra: Record<string, unknown> = {}) {
      return find_construction_sites(f.actor, { width: 4, height: 4, position, search_radius: 8, max_candidates: 4, ...extra }) as any
    }

    it('counts sites that reach unseen chunks as not_visible, never inspects them, and reports the search incomplete', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      G.storage.sgluna_map_knowledge = { force_index: 1, explored: {}, push_queue: [], revision: 9 }
      const result = search(f, { x: 30, y: 10 })
      expect(result.ok).toBe(true)
      expect(result.rejection_summary.not_visible).toBeGreaterThan(0)
      expect(result.search_complete).toBe(false)
      for (const candidate of result.candidates) expect(candidate.bounds.right_bottom.x).toBeLessThanOrEqual(32)
      expect(f.surface.find_entities_filtered).toHaveBeenCalled()
      for (const [filters] of f.surface.find_entities_filtered.mock.calls) expect(filters.area.right_bottom.x).toBeLessThanOrEqual(32)
      expect(result.map_context).toEqual({ source: 'npc_map_knowledge', observed_tick: 100, revision: 9, site_authority: 'currently_visible_chunks_only' })
    })

    it('answers SEARCH_INCOMPLETE_NOT_VISIBLE rather than NO_CLEAR_SITE when nothing the search reaches is visible', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      const result = search(f, { x: 200, y: 10 })
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('SEARCH_INCOMPLETE_NOT_VISIBLE')
      expect(result.candidates).toEqual([])
      expect(result.rejection_summary.not_visible).toBe(result.evaluated_count)
      expect(result.evaluated_count).toBeGreaterThan(0)
      expect(result.search_complete).toBe(false)
      expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
      expect(f.surface.get_tile).not.toHaveBeenCalled()
    })

    it('a fully visible search is complete and carries revision 0 without a knowledge record', () => {
      const f = build()
      const result = search(f, { x: 10, y: 10 })
      expect(result.ok).toBe(true)
      expect(result.rejection_summary.not_visible).toBe(0)
      expect(result.search_complete).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.map_context).toMatchObject({ revision: 0, observed_tick: 100 })
    })

    it('refuses an anchor in a fogged chunk as ANCHOR_NOT_VISIBLE and keeps INVALID_ANCHOR for an unknown unit', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      f.existing(72, { x: 200.5, y: 10.5 }, { x: 1, y: 1 })
      expect(search(f, { x: 0, y: 0 }, { position: undefined, anchor_unit_number: 72 })).toMatchObject({ ok: false, error: { code: 'ANCHOR_NOT_VISIBLE' } })
      expect(search(f, { x: 0, y: 0 }, { position: undefined, anchor_unit_number: 73 })).toMatchObject({ ok: false, error: { code: 'INVALID_ANCHOR' } })
      expect(f.surface.find_entities_filtered).not.toHaveBeenCalled()
    })
  })

  describe('existing connection endpoints', () => {
    it('control: with every chunk visible the layout validates', () => {
      const f = build()
      expect(validate(f, [SRC, INS], [FEED])).toMatchObject({ ok: true, execution_eligible: true })
    })

    it('an existing endpoint reaching a fogged chunk is CONNECTION_ENDPOINT_NOT_VISIBLE even though the placements are seen', () => {
      const f = build()
      f.state.visible = ONLY_ROW_ZERO
      const result = validate(f, [SRC, INS], [FEED])
      // Pre-change: ok is true (the boiler is resolved and proved).
      expect(result).toMatchObject({
        ok: false,
        planning_status: 'spatially_invalid',
        error: { code: 'CONNECTION_ENDPOINT_NOT_VISIBLE', index: 0, kind: 'inserter', role: 'drop', unit_number: BOILER_UNIT },
      })
    })

    it('the same fogged endpoint is not_visible whether it still stands or was destroyed; once seen again a destroyed one is UNAVAILABLE', () => {
      const f = build()
      remember_entity_reference(f.boiler)
      f.by_unit.delete(BOILER_UNIT)
      f.state.visible = ONLY_ROW_ZERO
      expect(validate(f, [SRC, INS], [FEED])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_NOT_VISIBLE', unit_number: BOILER_UNIT } })
      f.state.visible = ALL_VISIBLE
      expect(validate(f, [SRC, INS], [FEED])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', unit_number: BOILER_UNIT } })
    })

    it('a missing endpoint in a seen chunk, or one on another surface, stays CONNECTION_ENDPOINT_UNAVAILABLE', () => {
      const f = build()
      f.state.visible = ONLY_ROW_ZERO
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 12345 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', role: 'drop', unit_number: 12345 } })
      // On another surface the surface decides before visibility: it is not this surface's entity, fogged or not.
      f.existing(502, BOILER_AT, { x: 0.99, y: 0.99 }, { surface: { index: 2 } })
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 502 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE' } })
      // Another force in a seen chunk is not this actor's entity.
      f.existing(503, { x: 0.5, y: 20 }, { x: 0.99, y: 0.99 }, { force: { index: 2 } })
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 503 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE' } })
    })

    it('a layout proposal refuses a fogged existing endpoint the same way, and keeps UNAVAILABLE for a missing seen one', () => {
      const f = build()
      // The chest is fixed; the inserter is zoned around its spot (a proposal needs one zoned placement).
      const placements = [{ ...SRC }, { entity_name: 'test-inserter', slot: 'ins', zone: { center: { x: 0.5, y: 30.5 }, radius: 1 }, directions: [0] }]
      expect(propose_construction_layout(f.actor, { placements, connections: [FEED] } as any)).toMatchObject({ ok: true })
      f.state.visible = ONLY_ROW_ZERO
      expect(propose_construction_layout(f.actor, { placements, connections: [FEED] } as any)).toMatchObject({
        ok: false,
        error: { code: 'CONNECTION_ENDPOINT_NOT_VISIBLE', role: 'drop', unit_number: BOILER_UNIT },
      })
      expect(propose_construction_layout(f.actor, { placements, connections: [{ ...FEED, drop: { unit_number: 999 } }] } as any)).toMatchObject({
        ok: false,
        error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', unit_number: 999 },
      })
    })
  })

  // M3C-R1-4: the precheck the placing runtime runs just before create_entity derives fresh connection authority from the
  // pending existing endpoints. Validation saw the boiler; if its chunk is fogged before the inserter is created, the precheck
  // refuses without reading it, whether it still stands or not, and a destroyed one seen again is no longer an entity.
  // Pre-change (10d746a8) the precheck resolved the endpoint without a visibility check and returned undefined (proceed).
  describe('layout node precheck before creation', () => {
    function queued_layout(f: World) {
      const validation = validate(f, [SRC, INS], [FEED])
      expect(validation).toMatchObject({ ok: true, execution_eligible: true })
      const started = execute_validated_construction_plan(f.actor, validation.validation_id, 2, f.basic, f.manager)
      expect(started[0]).toBe(true)
      const layout_id = Number(/layout_id (\d+)/.exec(started[1])![1])
      const record = G.storage.sgluna_construction_layouts[layout_id]
      const node = record.nodes.find((value: any) => value.entity_name === 'test-inserter')
      expect(node.state).toBe('queued')
      return { record, node, check: () => layout_node_precheck(f.actor, { layout_id: record.layout_id, index: node.index }, 'test-inserter', node.position, node.direction) }
    }

    it('control: with the endpoint still seen the precheck lets the inserter be created', () => {
      const f = build()
      const { check } = queued_layout(f)
      expect(check()).toBeUndefined()
    })

    it('refuses before creation once the endpoint is fogged, standing or destroyed, without reading it or pausing the layout', () => {
      const f = build()
      const { record, check } = queued_layout(f)
      remember_entity_reference(f.boiler)
      f.state.visible = ONLY_ROW_ZERO
      const lookup = vi.fn((unit: number) => f.by_unit.get(unit))
      G.game.get_entity_by_unit_number = lookup
      const standing = check()
      expect(standing).toBe(`connection 0: drop ${BOILER_UNIT} is in a chunk the NPC does not see now; observe it again from nearby`)
      f.by_unit.delete(BOILER_UNIT)
      expect(check()).toBe(standing)
      expect(record.state).not.toBe('paused')
      // Seen again, the destroyed boiler is simply gone.
      f.state.visible = ALL_VISIBLE
      expect(check()).toBe(`connection 0: drop ${BOILER_UNIT} is no longer an existing entity of this surface and force`)
    })
  })

  describe('layout proposals', () => {
    // Three zoned slots wired inserter-to-chest around one point: chest (x, y - 1) -> inserter (x, y) -> chest (x, y + 1).
    function zoned_feed(x: number, y: number) {
      const zone = (cy: number) => ({ center: { x, y: cy }, radius: 1.5 })
      return {
        placements: [
          { entity_name: 'test-chest', slot: 'src', zone: zone(y - 1) },
          { entity_name: 'test-inserter', slot: 'ins', zone: zone(y), directions: [0] },
          { entity_name: 'test-chest', slot: 'dst', zone: zone(y + 1) },
        ],
        connections: [{ kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { slot: 'dst' } }],
      }
    }

    it('refuses a fixed placement in a fogged chunk as NOT_VISIBLE', () => {
      const f = build()
      f.state.visible = () => false
      const placements = [{ ...SRC }, { entity_name: 'test-inserter', slot: 'ins', zone: { center: { x: 0.5, y: 30.5 }, radius: 1 }, directions: [0] }]
      const result: any = propose_construction_layout(f.actor, { placements, connections: [FEED] } as any)
      expect(result).toMatchObject({ ok: false, error: { code: 'NOT_VISIBLE', fixed: true, slot: 'src' } })
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
    })

    it('offers zone candidates only in visible chunks', () => {
      const f = build()
      Object.assign(f.actor.position, { x: 30, y: 10 })
      f.state.visible = ONLY_COLUMN_ZERO
      // The zones sit on the chunk edge x = 32: centres at x >= 32 are fogged and a footprint reaching x = 32 is refused.
      const result: any = propose_construction_layout(f.actor, zoned_feed(31.5, 10.5) as any)
      expect(result.ok).toBe(true)
      expect(result.alternatives.length).toBeGreaterThan(0)
      for (const alternative of result.alternatives) {
        for (const placement of alternative.placements) expect(placement.x).toBeLessThan(32)
      }
      expect(f.surface.can_place_entity).toHaveBeenCalled()
      for (const [args] of f.surface.can_place_entity.mock.calls) expect(args.position.x).toBeLessThan(32)
    })

    it('says a fully fogged zone is exhausted by not_visible, and probes nothing', () => {
      const f = build()
      f.state.visible = ONLY_COLUMN_ZERO
      const result: any = propose_construction_layout(f.actor, zoned_feed(200.5, 10.5) as any)
      expect(result).toMatchObject({ ok: false, error: { code: 'ZONE_EXHAUSTED' } })
      expect(result.error.reasons.not_visible).toBeGreaterThan(0)
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
    })
  })
})
