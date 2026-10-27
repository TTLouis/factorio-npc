import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validate_construction_execution_plan } from './construction_execution'
import { overlaps } from './construction_layout'
import { propose_construction_layout } from './construction_proposal'
import { placement_footprint } from './placement_geometry'
import { planned_placement_footprint } from './placement_preflight'

// Milestone 4, acceptance L6: a fixed placement is carried unchanged into every alternative, a zoned one is chosen only inside
// its zone, and a proposal is read-only: nothing is stored, built or reserved, and the only route to execution stays
// validate_construction_plan with one returned alternative as a fully fixed plan.

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

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

const POLE_READS = { count: 0 }
const POLE = prototype('test-pole', 'electric-pole', [1, 1], 0.15, { max_wire_distance: 7.5, supports_direction: false })
Object.defineProperty(POLE, 'supply_area_distance', { get: () => { POLE_READS.count++; return 2.5 }, enumerable: true })

const PROTOTYPES: Record<string, any> = {
  'test-chest': prototype('test-chest', 'container', [1, 1], 0.4, { supports_direction: false }, 1),
  'test-inserter': prototype('test-inserter', 'inserter', [1, 1], 0.15, {
    inserter_pickup_position: { x: 0, y: -1 },
    inserter_drop_position: { x: 0, y: 1.2 },
    electric_energy_source_prototype: {},
  }),
  'test-pole': POLE,
  'test-lab': prototype('test-lab', 'lab', [3, 3], 1.2, { electric_energy_source_prototype: {}, supports_direction: false }, 2),
  'test-wall': prototype('test-wall', 'wall', [1, 1], 0.29),
}

const BOILER_UNIT = 500
const BOILER_AT = { x: 0.5, y: 2 }
const BOILER_HALF = { x: 1.49, y: 0.99 }
const BOILER_PROTOTYPE = { name: 'test-boiler', type: 'boiler', electric_energy_source_prototype: undefined, get_inventory_size: (index: number) => index === 1 ? 1 : undefined }

function build(held: Record<string, number> = { 'test-chest': 3, 'test-inserter': 3, 'test-pole': 2, 'test-lab': 2 }) {
  const by_unit = new Map<number, any>()
  const blocked: Box[] = [{ left_top: { x: BOILER_AT.x - BOILER_HALF.x, y: BOILER_AT.y - BOILER_HALF.y }, right_bottom: { x: BOILER_AT.x + BOILER_HALF.x, y: BOILER_AT.y + BOILER_HALF.y } }]
  const surface: any = {
    index: 1,
    name: 'nauvis',
    get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
    find_entities_filtered: vi.fn(() => []),
    count_entities_filtered: vi.fn(() => 0),
    can_place_entity: vi.fn((args: any) => {
      const proto = PROTOTYPES[args.name]
      const box = placement_footprint(proto, args.position, args.direction ?? 0).world_box
      return !blocked.some(other => overlaps(box, other))
    }),
    create_entity: vi.fn(),
  }
  const inventory: any = {
    get_contents: vi.fn(() => Object.entries(held).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
    get_item_count: vi.fn((name: string) => held[name] ?? 0),
  }
  const position = { x: 0, y: 0 }
  const actor = {
    is_valid: true,
    character: { valid: true, name: 'character', type: 'character', position, build_distance: 20, resource_reach_distance: 20 },
    position,
    surface,
    force: { index: 1, name: 'player' },
    get_main_inventory: () => inventory,
    status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character', valid: true, has_character: true, position }),
  } as unknown as ControlledActor
  ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => by_unit.get(unit)
  const boiler: any = {
    valid: true,
    name: 'test-boiler',
    type: 'boiler',
    unit_number: BOILER_UNIT,
    position: BOILER_AT,
    direction: 0,
    surface: { index: 1 },
    force: { index: 1 },
    prototype: BOILER_PROTOTYPE,
    bounding_box: blocked[0],
    ...item_interface(1),
  }
  by_unit.set(BOILER_UNIT, boiler)
  return { actor, surface, held, blocked }
}

type World = ReturnType<typeof build>

// An inserter facing north at (x, y) picks up at (x, y - 1) and drops at (x, y + 1.2): the boiler spans y 1.01..2.99.
const FEED = { kind: 'inserter' as const, inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { unit_number: BOILER_UNIT } }
const ZONED_INSERTER = { entity_name: 'test-inserter', slot: 'ins', zone: { center: { x: 0.5, y: 0.5 }, radius: 2 }, directions: [0] }
const ZONED_CHEST = { entity_name: 'test-chest', slot: 'src', zone: { center: { x: 0.5, y: -1.5 }, radius: 3 } }

function propose(f: World, placements: any[], connections: any[] = [FEED], extra: Record<string, unknown> = {}) {
  return propose_construction_layout(f.actor, { placements, connections, ...extra } as any) as any
}

function plain(placement: any) {
  const { fixed: _fixed, zone_distance: _zone_distance, ...rest } = placement
  return rest
}

function distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

describe('bounded layout proposals (milestone 4 L6)', () => {
  const original = {
    pairs: (globalThis as any).pairs,
    entity: (globalThis as any).prototypes.entity,
    item: (globalThis as any).prototypes.item,
    get_entity: (globalThis as any).game.get_entity_by_unit_number,
  }

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { ...PROTOTYPES }
    ;(globalThis as any).prototypes.item = Object.fromEntries(Object.keys(PROTOTYPES).map(name => [name, { stack_size: 50 }]))
    POLE_READS.count = 0
  })

  afterEach(() => {
    ;(globalThis as any).pairs = original.pairs
    ;(globalThis as any).prototypes.entity = original.entity
    ;(globalThis as any).prototypes.item = original.item
    ;(globalThis as any).game.get_entity_by_unit_number = original.get_entity
  })

  describe('alternatives for zoned slots', () => {
    it('returns alternatives that keep the existing boiler, stay in their zones and hold every connection proof', () => {
      const f = build()
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(result.ok).toBe(true)
      expect(result.alternatives.length).toBeGreaterThanOrEqual(1)
      expect(result.fixed_slots).toEqual([])
      expect(result.zoned_slots).toEqual(['ins', 'src'])
      expect(result.budget).toBe(256)
      expect(result.evaluated).toBeLessThanOrEqual(256)
      for (const alternative of result.alternatives) {
        expect(alternative.planning_status).toBe('spatially_valid')
        expect(alternative.execution_eligible).toBe(true)
        expect(alternative.connections).toEqual([expect.objectContaining({ index: 0, kind: 'inserter', virtual_proof: expect.objectContaining({ status: 'proved' }) })])
        const ins = alternative.placements.find((p: any) => p.slot === 'ins')
        const src = alternative.placements.find((p: any) => p.slot === 'src')
        // The inserter faces north: it picks up one tile north of itself, where the chest stands, and drops into the boiler.
        expect(ins).toMatchObject({ entity_name: 'test-inserter', direction: 0, fixed: false })
        expect(src).toMatchObject({ entity_name: 'test-chest', x: ins.x, y: ins.y - 1, fixed: false })
        expect(ins.y + 1.2).toBeGreaterThan(1.01)
        expect(ins.y + 1.2).toBeLessThan(2.99)
        expect(distance(ins, ZONED_INSERTER.zone.center)).toBeLessThanOrEqual(2 + 1e-9)
        expect(distance(src, ZONED_CHEST.zone.center)).toBeLessThanOrEqual(3 + 1e-9)
        expect(ins.zone_distance).toBeCloseTo(distance(ins, ZONED_INSERTER.zone.center), 2)
      }
      expect(result.alternatives.map((a: any) => a.id)).toEqual(result.alternatives.map((_: any, i: number) => `alt-${i + 1}`))
      // Only x = -0.5, 0.5 and 1.5 put the inserter's drop inside the boiler (x -0.99..1.99, y 1.01..2.99).
      const xs = result.alternatives.map((a: any) => a.placements.find((p: any) => p.slot === 'ins').x).sort()
      expect(xs).toEqual([-0.5, 0.5, 1.5])
    })

    it('ranks deterministically: the same request on the same world gives the same result', () => {
      const f = build()
      const first = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST])).toEqual(first)
      // The nearest to the zone centres first.
      const scores = first.alternatives.map((a: any) => a.placements.reduce((sum: number, p: any) => sum + (p.zone_distance ?? 0), 0))
      expect(scores).toEqual([...scores].sort((a: number, b: number) => a - b))
      expect(first.alternatives[0].placements.find((p: any) => p.slot === 'ins')).toMatchObject({ x: 0.5, y: 0.5 })
    })

    it('reports the eligibility blockers of an alternative instead of filtering it out', () => {
      const f = build({ 'test-chest': 3, 'test-inserter': 0 })
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(result.ok).toBe(true)
      for (const alternative of result.alternatives) {
        expect(alternative.planning_status).toBe('spatially_valid')
        expect(alternative.execution_eligible).toBe(false)
        expect(alternative.eligibility_blockers).toEqual([expect.objectContaining({ code: 'ITEMS_MISSING', item_name: 'test-inserter' })])
      }
    })

    it('ranks an alternative that can run now before a nearer one that cannot', () => {
      const f = build()
      // The actor stands 10.4 tiles east: the inserter at x = -0.5 is beyond the 10 tile local reach, the ones at 0.5 and 1.5 are not.
      ;(f.actor as any).position = { x: 10.4, y: 0 }
      const zone = { center: { x: -0.5, y: 0.5 }, radius: 2 }
      const result = propose(f, [{ ...ZONED_INSERTER, zone }, ZONED_CHEST])
      expect(result.ok).toBe(true)
      const inserters = result.alternatives.map((a: any) => a.placements.find((p: any) => p.slot === 'ins'))
      expect(inserters.map((p: any) => p.x)).toEqual([0.5, 1.5, -0.5])
      expect(result.alternatives.map((a: any) => a.execution_eligible)).toEqual([true, true, false])
      // The ineligible one has the smallest zone distance, and is still listed last with its blockers.
      expect(inserters[2].zone_distance).toBe(0)
      expect(result.alternatives[2].eligibility_blockers.every((blocker: any) => blocker.code === 'OUTSIDE_LOCAL_BUILD_REACH')).toBe(true)
    })

    it('caps the alternatives at max_alternatives and rejects a larger cap', () => {
      const f = build()
      const one = propose(f, [ZONED_INSERTER, ZONED_CHEST], [FEED], { max_alternatives: 1 })
      expect(one.alternatives).toHaveLength(1)
      expect(one.alternatives[0].id).toBe('alt-1')
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST], [FEED], { max_alternatives: 5 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST], [FEED], { max_alternatives: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
    })

    it('restricts the facing of a zoned slot to the directions the request names', () => {
      const f = build()
      // A south-facing inserter picks up one tile south of itself and drops one and a fifth north: its drop cannot be the boiler
      // from a cell in this zone, so no alternative exists.
      const result = propose(f, [{ ...ZONED_INSERTER, directions: [8] }, ZONED_CHEST])
      expect(result).toMatchObject({ ok: false, error: { code: 'NO_LAYOUT_ALTERNATIVE' } })
    })
  })

  describe('fixed means fixed', () => {
    it('carries a fixed placement byte-identically, unsnapped and unrotated, in every alternative', () => {
      const f = build()
      // (0.7, 0.4) snaps to the (0.5, 0.5) cell at execution; the proposal must still report 0.7 and 0.4.
      const fixed = { entity_name: 'test-inserter', slot: 'ins', x: 0.7, y: 0.4, direction: 0 }
      const result = propose(f, [fixed, ZONED_CHEST])
      expect(result.ok).toBe(true)
      expect(result.fixed_slots).toEqual(['ins'])
      expect(result.zoned_slots).toEqual(['src'])
      expect(result.alternatives.length).toBeGreaterThanOrEqual(1)
      for (const alternative of result.alternatives) {
        expect(alternative.placements.find((p: any) => p.slot === 'ins')).toStrictEqual({ entity_name: 'test-inserter', slot: 'ins', x: 0.7, y: 0.4, direction: 0, fixed: true })
        expect(alternative.placements.find((p: any) => p.slot === 'src')).toMatchObject({ x: 0.5, y: -0.5, fixed: false })
      }
    })

    it('reports no direction for a fixed placement that gave none', () => {
      const f = build()
      const result = propose(f, [{ entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 0.5 }, ZONED_CHEST])
      expect(result.ok).toBe(true)
      expect(result.alternatives[0].placements.find((p: any) => p.slot === 'ins')).toStrictEqual({ entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 0.5, fixed: true })
    })

    it('refuses a fixed placement that is invalid on its own, with its spatial code and fixed: true, and offers nothing', () => {
      const f = build()
      // (0.5, 1.5) overlaps the boiler.
      const result = propose(f, [{ entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 1.5, direction: 0 }, ZONED_CHEST])
      expect(result).toMatchObject({ ok: false, error: { code: 'WORLD_COLLISION', fixed: true, slot: 'ins', index: 0 } })
      expect(result.alternatives).toBeUndefined()
    })

    it('refuses two fixed placements that overlap each other', () => {
      const f = build()
      const result = propose(f, [
        { entity_name: 'test-chest', slot: 'a', x: 0.5, y: -0.5 },
        { entity_name: 'test-chest', slot: 'b', x: 0.5, y: -0.5 },
        ZONED_INSERTER,
      ], [{ kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'a' }, drop: { slot: 'b' } }])
      expect(result).toMatchObject({ ok: false, error: { code: 'PLANNED_COLLISION', fixed: true, slots: ['a', 'b'] } })
    })

    it('never moves a fixed inserter whose drop misses the boiler: no alternative, not a relocated inserter', () => {
      const f = build()
      // Facing north at x = 5.5 it drops at (5.5, 1.7), outside the boiler. A zoned chest cannot repair that.
      const fixed = { entity_name: 'test-inserter', slot: 'ins', x: 5.5, y: 0.5, direction: 0 }
      const result = propose(f, [fixed, { ...ZONED_CHEST, zone: { center: { x: 5.5, y: -0.5 }, radius: 2 } }])
      expect(result).toMatchObject({ ok: false, error: { code: 'NO_LAYOUT_ALTERNATIVE', budget: 256, budget_exhausted: false } })
      expect(result.error.pruned).toEqual({ 'connection_mismatch:CONNECTION_GEOMETRY_MISMATCH': 1 })
      expect(result.alternatives).toBeUndefined()
      expect(result.placements).toBeUndefined()
    })

    it('never rotates a fixed inserter whose facing is wrong for the boiler', () => {
      const f = build()
      // Facing east it drops to the west of itself: not the boiler below.
      const fixed = { entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 0.5, direction: 4 }
      const result = propose(f, [fixed, ZONED_CHEST])
      expect(result).toMatchObject({ ok: false, error: { code: 'NO_LAYOUT_ALTERNATIVE' } })
    })

    it('prunes a zoned inserter against its fixed drop endpoint before assigning the chest', () => {
      const f = build()
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      // Few evaluations: inserter cells that cannot drop into the boiler never reach the 64 chest candidates.
      expect(result.evaluated).toBeLessThan(128)
    })
  })

  describe('zones and limits', () => {
    it('reports ZONE_EXHAUSTED with the reasons when no cell in a zone passes the native checks', () => {
      const f = build()
      f.surface.can_place_entity.mockImplementation(() => false)
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(result).toMatchObject({ ok: false, error: { code: 'ZONE_EXHAUSTED', slot: 'ins', reasons: { world_collision: expect.any(Number) } } })
      expect(result.error.reasons.world_collision).toBeGreaterThan(0)
      expect(result.alternatives).toBeUndefined()
    })

    it('counts a cell taken by a fixed placement as fixed_collision', () => {
      const f = build()
      const fixed = { entity_name: 'test-wall', slot: 'wall', x: 0.5, y: -0.5 }
      const tiny = { entity_name: 'test-chest', slot: 'src', zone: { center: { x: 0.5, y: -0.5 }, radius: 0.4 } }
      const result = propose(f, [fixed, tiny, { entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 0.5, direction: 0 }])
      expect(result).toMatchObject({ ok: false, error: { code: 'ZONE_EXHAUSTED', slot: 'src', reasons: { fixed_collision: 1 } } })
    })

    it('reports the nearest 64 candidates of an oversized zone and says it truncated', () => {
      const f = build()
      const result = propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, zone: { center: { x: 0.5, y: -2.5 }, radius: 8 } }])
      expect(result.ok).toBe(true)
      expect(result.zone_truncated).toEqual({ src: true })
    })

    it('stops at the evaluation budget and never evaluates more than 256 combinations', () => {
      const f = build()
      // A pole zone and a lab zone too far apart for any pole position to supply any lab position: nothing prunes before the
      // last slot, so every pole × lab combination is a distinct evaluation.
      const placements = [
        { entity_name: 'test-pole', slot: 'pole', zone: { center: { x: 0.5, y: -9.5 }, radius: 4 } },
        { entity_name: 'test-lab', slot: 'lab', zone: { center: { x: 0.5, y: 8.5 }, radius: 4 } },
      ]
      const result = propose(f, placements, [{ kind: 'power', pole: { slot: 'pole' }, consumer: { slot: 'lab' } }])
      expect(result).toMatchObject({ ok: false, error: { code: 'NO_LAYOUT_ALTERNATIVE', evaluated: 256, budget: 256, budget_exhausted: true } })
      expect(POLE_READS.count).toBeGreaterThan(0)
      expect(POLE_READS.count).toBeLessThanOrEqual(256)
      expect(result.error.pruned['connection_mismatch:CONNECTION_GEOMETRY_MISMATCH']).toBeGreaterThan(0)
      expect(result.alternatives).toBeUndefined()
    })

    it('refuses a request over the limits before reading the world', () => {
      const f = build()
      const chests = Array.from({ length: 7 }, (_, i) => ({ entity_name: 'test-chest', slot: `c${i}`, zone: { center: { x: 0.5, y: -4.5 }, radius: 2 } }))
      expect(propose(f, chests, [FEED])).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      const fixed_only = [{ entity_name: 'test-chest', slot: 'src', x: 0.5, y: -0.5 }, { entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 0.5, direction: 0 }]
      expect(propose(f, fixed_only)).toMatchObject({ ok: false, error: { code: 'NO_ZONED_PLACEMENT' } })
      expect(propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, zone: { center: { x: 0.5, y: -1.5 }, radius: 8.01 } }])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 1 } })
      expect(propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, zone: { center: { x: 0.5, y: -1.5 }, radius: 0 } }])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST], [])).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(f.surface.can_place_entity).not.toHaveBeenCalled()
    })

    it('refuses a malformed placement, a repeated slot and a zoned slot with no connection', () => {
      const f = build()
      expect(propose(f, [{ ...ZONED_INSERTER, x: 1, y: 1 }, ZONED_CHEST])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 0 } })
      expect(propose(f, [{ entity_name: 'test-inserter', slot: 'ins' }, ZONED_CHEST])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 0 } })
      expect(propose(f, [{ ...ZONED_INSERTER, directions: [3] }, ZONED_CHEST])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
      expect(propose(f, [{ ...ZONED_INSERTER, directions: [0, 0] }, ZONED_CHEST])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
      expect(propose(f, [{ ...ZONED_INSERTER, direction: 0 }, ZONED_CHEST])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
      expect(propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, slot: 'ins' }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION' } })
      expect(propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, slot: 'BAD SLOT' }])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST, { entity_name: 'test-chest', slot: 'extra', zone: { center: { x: 0.5, y: -4.5 }, radius: 2 } }])).toMatchObject({ ok: false, error: { code: 'ZONED_SLOT_UNCONNECTED', slot: 'extra' } })
      expect(propose(f, [{ ...ZONED_CHEST, directions: [4] }, ZONED_INSERTER])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT' } })
    })

    it('refuses an unknown existing endpoint and an unknown entity before searching', () => {
      const f = build()
      expect(propose(f, [ZONED_INSERTER, ZONED_CHEST], [{ ...FEED, drop: { unit_number: 999 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', unit_number: 999 } })
      expect(propose(f, [ZONED_INSERTER, { ...ZONED_CHEST, entity_name: 'no-such-entity' }])).toMatchObject({ ok: false, error: { code: 'PLACEMENT_ITEM_UNSUPPORTED', slot: 'src' } })
    })
  })

  describe('read-only, and the existing authority route', () => {
    // Two lazily created read caches of the shared spatial checks (an empty reservation list, the observed identity of an
    // endpoint looked up by unit_number) are written by every read of the mod, validation included. Everything else is state.
    function state() {
      const { sgluna_area_reservations: _reservations, sgluna_entity_reference_hints: _hints, ...rest } = (globalThis as any).storage
      return JSON.stringify(rest)
    }

    it('stores no token and no layout record, and leaves an existing validation token unchanged', () => {
      const f = build()
      const validated: any = validate_construction_execution_plan(f.actor, { plan_id: 'earlier', placements: [{ entity_name: 'test-chest', x: 5.5, y: -3.5 }] })
      expect(validated.ok).toBe(true)
      const before = state()
      const token = JSON.stringify((globalThis as any).storage.sgluna_validated_construction_plan)
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toMatchObject({ validation_id: 1, plan_id: 'earlier' })
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(result.ok).toBe(true)
      expect(state()).toBe(before)
      expect(JSON.stringify((globalThis as any).storage.sgluna_validated_construction_plan)).toBe(token)
      expect((globalThis as any).storage.sgluna_next_construction_validation_id).toBe(1)
      expect((globalThis as any).storage.sgluna_construction_layouts).toBeUndefined()
      expect(f.surface.create_entity).not.toHaveBeenCalled()
    })

    it('stores nothing on success or on any kind of refusal when no validation exists', () => {
      const f = build()
      propose(f, [ZONED_INSERTER, ZONED_CHEST])
      propose(f, [{ entity_name: 'test-inserter', slot: 'ins', x: 5.5, y: 0.5, direction: 0 }, ZONED_CHEST])
      propose(f, [{ entity_name: 'test-inserter', slot: 'ins', x: 0.5, y: 1.5, direction: 0 }, ZONED_CHEST])
      propose(f, [ZONED_INSERTER, ZONED_CHEST], [])
      expect(state()).toBe('{}')
    })

    it('gives every alternative back as a fully fixed plan that validates to the same footprints', () => {
      const f = build()
      const result = propose(f, [ZONED_INSERTER, ZONED_CHEST])
      expect(result.alternatives.length).toBeGreaterThanOrEqual(2)
      for (const alternative of result.alternatives) {
        const plan = alternative.placements.map(plain)
        const validated: any = validate_construction_execution_plan(f.actor, { plan_id: alternative.id, placements: plan, connections: [FEED] })
        expect(validated).toMatchObject({ ok: true, planning_status: 'spatially_valid', execution_eligible: true })
        for (let i = 0; i < plan.length; i++) {
          const footprint = planned_placement_footprint(plan[i].entity_name, plan[i].x, plan[i].y, plan[i].direction)!
          expect(validated.placement_geometry[i].planned_position).toEqual({ x: plan[i].x, y: plan[i].y })
          expect(validated.placement_geometry[i].world_collision_box).toEqual(footprint.world_box)
        }
      }
    })

    it('round-trips a fixed placement with an unsnapped position through validation to the same footprint', () => {
      const f = build()
      const fixed = { entity_name: 'test-inserter', slot: 'ins', x: 0.7, y: 0.4, direction: 0 }
      const result = propose(f, [fixed, ZONED_CHEST])
      const alternative = result.alternatives[0]
      const plan = alternative.placements.map(plain)
      expect(plan[0]).toStrictEqual(fixed)
      const validated: any = validate_construction_execution_plan(f.actor, { plan_id: 'round-trip', placements: plan, connections: [FEED] })
      expect(validated).toMatchObject({ ok: true, planning_status: 'spatially_valid' })
      expect(validated.placement_geometry[0].planned_position).toEqual({ x: 0.5, y: 0.5 })
    })
  })
})
