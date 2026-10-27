import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { create_placement_candidate_set, execute_placement_candidate, normalize_region, placement_candidate_preflight, placement_candidates_for_actor } from './placement_candidates'

// Run BC C: the executor read drill candidates with radius 8 and saw a ranked top 8 outside the six-tile area the
// step had committed to, so it concluded the area was infeasible although a legal spot stood 2.9 tiles from the
// anchor. The request now carries the committed area as a hard region, applied to the snapped entity centre
// before ranking and truncation, and the answer says what was and was not verified.

const KIT = 'region-test-kit'
const G: any = globalThis

function crate_prototype(kit_count = 1) {
  return { name: 'region-crate', type: 'container', tile_width: 1, tile_height: 1, supports_direction: false,
    items_to_place_this: [{ name: KIT, count: kit_count }] }
}
function drill_prototype() {
  return { name: 'region-drill', type: 'mining-drill', tile_width: 3, tile_height: 3, mining_drill_radius: 1.5,
    resource_categories: { solid: true }, items_to_place_this: [{ name: KIT, count: 1 }] }
}

interface ActorOptions {
  can_place?: (args: any) => boolean
  // Resource entities returned for a mining search centred on this point.
  resource_count?: (center: { x: number, y: number }) => number
  held?: number
}

function make_actor(options: ActorOptions = {}) {
  const resource_count = options.resource_count ?? (() => 0)
  const resources = (area: any) => {
    const count = resource_count({ x: (area[0].x + area[1].x) / 2, y: (area[0].y + area[1].y) / 2 })
    return Array.from({ length: count }, () => ({ valid: true, name: 'region-ore', type: 'resource', amount: 100, prototype: { resource_category: 'solid' } }))
  }
  return {
    is_valid: true,
    position: { x: 0, y: 0 },
    force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
    status_snapshot: () => ({ actor_id: 5 }),
    get_main_inventory: () => ({ get_item_count: (name: string) => name === KIT ? (options.held ?? 1) : 0 }),
    surface: {
      index: 1,
      can_place_entity: options.can_place ?? (() => true),
      find_entities_filtered: (filters: any) => filters.type === 'resource' ? resources(filters.area) : [],
    },
  } as any
}

const circle = (x: number, y: number, radius: number) => ({ shape: 'circle' as const, center: { x, y }, radius })
const box = (left: number, top: number, right: number, bottom: number) => ({ shape: 'box' as const, left_top: { x: left, y: top }, right_bottom: { x: right, y: bottom } })
const distance = (a: { x: number, y: number }, b: { x: number, y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('placement candidate regions', () => {
  const originalPairs = G.pairs
  const originalStorage = G.storage
  const originalGame = G.game
  const originalEntityPrototypes = G.prototypes.entity

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game = { tick: 100 }
    G.prototypes.item[KIT] = {}
    G.prototypes.entity = { 'region-crate': crate_prototype(), 'region-drill': drill_prototype() }
  })

  afterEach(() => {
    G.pairs = originalPairs
    G.storage = originalStorage
    G.game = originalGame
    G.prototypes.entity = originalEntityPrototypes
    delete G.prototypes.item[KIT]
  })

  describe('C1: the committed area outranks a better-ranked outside', () => {
    // Legal drill sites: a whole band east of the area (richer in ore, so it ranks first) and one site inside the
    // six-tile circle 2.83 tiles from its centre.
    const INSIDE = { x: 2.5, y: 2.5 }
    function bc_actor() {
      return make_actor({
        can_place: ({ position }: any) => position.x >= 4.5 || (position.x === INSIDE.x && position.y === INSIDE.y),
        resource_count: center => center.x >= 4 ? 6 : 1,
      })
    }

    it('returns the inside candidate and nothing outside when the region is given', () => {
      const result = placement_candidates_for_actor(bc_actor(), { entity_name: 'region-drill', center: { x: 0.5, y: 0.5 }, radius: 5, limit: 8,
        region: circle(0.5, 0.5, 3) }) as any
      expect(result.ok).toBe(true)
      expect(result.candidates.length).toBeGreaterThan(0)
      for (const candidate of result.candidates) {
        expect(candidate.position).toEqual(INSIDE)
        expect(candidate.in_region).toBe(true)
        expect(distance(candidate.position, { x: 0.5, y: 0.5 })).toBeLessThanOrEqual(3)
      }
      expect(result.spatial_status).toBe('candidates_found')
      expect(result.search_completeness).toMatchObject({ complete: true, search_shape: 'square_rings' })
      expect(result.search_completeness.region_rejected_count).toBeGreaterThan(0)
      expect(result.search_completeness.returned_count).toBe(result.returned_candidate_count)
      expect(result.region).toEqual(circle(0.5, 0.5, 3))
      expect(result.region_semantics).toBe('entity_center')
    })

    it('without a region the old ranking still returns only the outside candidates (the original failure mode)', () => {
      const result = placement_candidates_for_actor(bc_actor(), { entity_name: 'region-drill', center: { x: 0.5, y: 0.5 }, radius: 5, limit: 8 }) as any
      expect(result.candidates.length).toBeGreaterThanOrEqual(6)
      for (const candidate of result.candidates) expect(candidate.position.x).toBeGreaterThanOrEqual(4.5)
      expect(result.candidates.some((candidate: any) => candidate.position.x === INSIDE.x)).toBe(false)
      expect(result.region).toBeUndefined()
      expect(result.region_semantics).toBeUndefined()
      expect(result.candidates[0].in_region).toBeUndefined()
      expect(result.search_completeness.region_rejected_count).toBe(0)
    })

    it('does not let a smaller model radius shrink the search of the region, and defaults the centre to the region', () => {
      const result = placement_candidates_for_actor(bc_actor(), { entity_name: 'region-drill', radius: 1, limit: 8, region: circle(0.5, 0.5, 3) }) as any
      expect(result.candidates.map((candidate: any) => candidate.position)).toEqual([INSIDE])
      expect(result.center).toEqual({ x: 0.5, y: 0.5 })
      // reach 3 + one tile of snapping + the 3x3 footprint half extent 1.5, rounded up to whole rings
      expect(result.search_completeness).toMatchObject({ search_center: { x: 0.5, y: 0.5 }, search_radius: 5 })
      expect(result.radius).toBe(5)
    })
  })

  describe('C2: shapes, boundaries and the other filters', () => {
    it('keeps a box boundary inclusive on every side, with negative coordinates', () => {
      const result = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', limit: 8, region: box(-3.5, -1.5, -1.5, -0.5) }) as any
      const positions = result.candidates.map((candidate: any) => `${candidate.position.x},${candidate.position.y}`).sort()
      expect(positions).toEqual(['-1.5,-0.5', '-1.5,-1.5', '-2.5,-0.5', '-2.5,-1.5', '-3.5,-0.5', '-3.5,-1.5'])
      expect(result.legal_candidate_count).toBe(6)
      expect(result.center).toEqual({ x: -2.5, y: -1 })
      // A box that starts just inside the old edge drops the boundary column.
      const inner = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', limit: 8, region: box(-3.4, -1.5, -1.5, -0.5) }) as any
      expect(inner.candidates.map((candidate: any) => candidate.position.x).sort()).toEqual([-1.5, -1.5, -2.5, -2.5])
    })

    it('keeps a circle boundary inclusive and excludes the sites just past it, around a negative centre', () => {
      const center = { x: -10.5, y: -20.5 }
      const on_ring = (position: any) => {
        const reach = Math.hypot(position.x - center.x, position.y - center.y)
        return reach >= 4.9 && reach <= 5.2
      }
      const result = placement_candidates_for_actor(make_actor({ can_place: ({ position }: any) => on_ring(position) }),
        { entity_name: 'region-crate', limit: 8, region: circle(center.x, center.y, 5) }) as any
      // The 12 lattice points at exactly 5 (3-4-5, 5-0) are in; the 8 points at 5.10 are legal but outside.
      expect(result.legal_candidate_count).toBe(12)
      for (const candidate of result.candidates) expect(distance(candidate.position, center)).toBe(5)
      expect(result.search_completeness.region_rejected_count).toBeGreaterThanOrEqual(8)
    })

    it('still enforces resource coverage together with the region', () => {
      const result = placement_candidates_for_actor(make_actor({ resource_count: center => center.x < 2 ? 2 : 0 }),
        { entity_name: 'region-drill', target_resource: 'region-ore', limit: 8, region: circle(0.5, 0.5, 4) }) as any
      expect(result.candidates.length).toBeGreaterThan(0)
      for (const candidate of result.candidates) {
        expect(candidate.position.x).toBeLessThanOrEqual(1.5)
        expect(candidate.resource_coverage).toEqual([{ name: 'region-ore', entities: 2, amount: 200 }])
        expect(distance(candidate.position, { x: 0.5, y: 0.5 })).toBeLessThanOrEqual(4)
      }
      // The uncovered sites inside the circle are dropped by the resource filter, the ones outside by the region.
      expect(result.search_completeness.region_rejected_count).toBeGreaterThan(0)
    })

    it('still enforces the covers_position filter together with the region', () => {
      const covers = { x: 0.5, y: 0.5 }
      const result = placement_candidates_for_actor(make_actor(), { entity_name: 'region-drill', covers_position: covers, limit: 8, region: circle(2.5, 0.5, 1) }) as any
      expect(result.candidates.length).toBeGreaterThan(0)
      for (const candidate of result.candidates) {
        expect(distance(candidate.position, { x: 2.5, y: 0.5 })).toBeLessThanOrEqual(1)
        expect(Math.abs(candidate.position.x - covers.x)).toBeLessThan(1.5)
        expect(Math.abs(candidate.position.y - covers.y)).toBeLessThan(1.5)
      }
    })

    it('filters connects_to footprints by the region as well', () => {
      // A 3x2 boiler (water ports at both ends of its south row) joining the water port of a live pump.
      const turned = (offset: { x: number, y: number }) => [0, 1, 2, 3].map(quarter => {
        const { x, y } = offset
        return quarter === 0 ? { x, y } : quarter === 1 ? { x: -y, y: x } : quarter === 2 ? { x: -x, y: -y } : { x: y, y: -x }
      })
      const connection = (direction: number, offset: { x: number, y: number }, flow_direction: string) => ({ connection_type: 'normal', flow_direction, direction, positions: turned(offset) })
      G.prototypes.entity = { boiler: { name: 'boiler', type: 'boiler', tile_width: 3, tile_height: 2, items_to_place_this: [{ name: KIT, count: 1 }],
        fluidbox_prototypes: [
          { index: 1, volume: 200, production_type: 'input-output', filter: { name: 'water' }, pipe_connections: [connection(12, { x: -1, y: 0.5 }, 'input-output'), connection(4, { x: 1, y: 0.5 }, 'input-output')] },
          { index: 2, volume: 200, production_type: 'output', filter: { name: 'steam' }, pipe_connections: [connection(0, { x: 0, y: -0.5 }, 'output')] },
        ] } }
      const live = {
        valid: true, unit_number: 100, name: 'offshore-pump', position: { x: 0, y: 0 }, surface: { index: 1 }, force: { index: 1 },
        fluidbox: { length: 1,
          get_pipe_connections: () => [{ connection_type: 'normal', flow_direction: 'output', position: { x: 8.5, y: 20.5 }, target_position: { x: 9.5, y: 20.5 }, target: undefined }],
          get_prototype: (index: number) => ({ index, production_type: 'input-output', filter: { name: 'water' } }) },
      }
      const previous = G.game.get_entity_by_unit_number
      G.game.get_entity_by_unit_number = (unit: number) => unit === 100 ? live : undefined
      try {
        const baseline = placement_candidates_for_actor(make_actor(), { entity_name: 'boiler', connects_to: { unit_number: 100 }, limit: 8 }) as any
        expect(baseline.ok).toBe(true)
        expect(baseline.candidates.length).toBeGreaterThan(0)
        const wanted = baseline.candidates[0].position
        const inside = placement_candidates_for_actor(make_actor(), { entity_name: 'boiler', connects_to: { unit_number: 100 }, limit: 8, region: circle(wanted.x, wanted.y, 0.5) }) as any
        expect(inside.candidates.length).toBeGreaterThan(0)
        for (const candidate of inside.candidates) {
          expect(candidate.position).toEqual(wanted)
          expect(candidate.connects_to).toMatchObject({ unit_number: 100 })
          expect(candidate.in_region).toBe(true)
        }
        expect(inside.search_completeness).toMatchObject({ complete: true, search_shape: 'solved_join_footprints' })
        const elsewhere = placement_candidates_for_actor(make_actor(), { entity_name: 'boiler', connects_to: { unit_number: 100 }, limit: 8, region: circle(wanted.x + 50, wanted.y, 3) }) as any
        expect(elsewhere.candidates).toEqual([])
        expect(elsewhere.spatial_status).toBe('none_in_verified_scope')
        expect(elsewhere.search_completeness.region_rejected_count).toBeGreaterThan(0)
      }
      finally { G.game.get_entity_by_unit_number = previous }
    })
  })

  describe('C4: bounded search and honest status', () => {
    it('reports a region larger than the search limit as incomplete, still returning what it found', () => {
      const result = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', limit: 4, region: circle(0.5, 0.5, 30) }) as any
      expect(result.candidates.length).toBe(4)
      expect(result.spatial_status).toBe('candidates_found')
      expect(result.search_completeness).toMatchObject({ complete: false, reason: 'region_exceeds_search_limit', search_radius: 24 })
      expect(result.radius).toBe(24)
      // Not a runtime limit: the legacy flag keeps meaning that one of those was hit.
      expect(result.candidates_may_be_incomplete).toBeUndefined()
      for (const candidate of result.candidates) expect(distance(candidate.position, { x: 0.5, y: 0.5 })).toBeLessThanOrEqual(30)
    })

    it('reports search_incomplete, not none, when an oversize region held nothing in the part that was searched', () => {
      const result = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', center: { x: 0.5, y: 0.5 }, limit: 4, region: circle(500.5, 0.5, 30) }) as any
      expect(result.candidates).toEqual([])
      expect(result.spatial_status).toBe('search_incomplete')
      expect(result.search_completeness).toMatchObject({ complete: false, reason: 'region_exceeds_search_limit', legal_candidate_count: 0, returned_count: 0 })
      expect(result.execution_eligibility).toBe('no_candidate')
    })

    it('names the oversize region first and still carries a runtime limit in the legacy fields', () => {
      const result = placement_candidates_for_actor(make_actor({ can_place: () => false }), { entity_name: 'region-crate', limit: 4, region: circle(0.5, 0.5, 30) }) as any
      expect(result.spatial_status).toBe('search_incomplete')
      expect(result.search_completeness).toMatchObject({ complete: false, reason: 'region_exceeds_search_limit' })
      expect(result).toMatchObject({ candidates_may_be_incomplete: true, candidates_incomplete_reason: 'clearance_check_limit' })
    })

    it('reports the clearance probe limit with the right reason, beside found candidates', () => {
      // 24 x 24 positions in the box, only the centre legal; the centre is probed first, then the budget runs out.
      const result = placement_candidates_for_actor(make_actor({ can_place: ({ position }: any) => position.x === 0.5 && position.y === 0.5 }),
        { entity_name: 'region-crate', limit: 4, region: box(-10.5, -10.5, 12.5, 12.5) }) as any
      expect(result.candidates.map((candidate: any) => candidate.position)).toEqual([{ x: 0.5, y: 0.5 }])
      expect(result.clearance_probes).toBe(400)
      expect(result).toMatchObject({ candidates_may_be_incomplete: true, candidates_incomplete_reason: 'clearance_check_limit', spatial_status: 'candidates_found' })
      expect(result.search_completeness).toMatchObject({ complete: false, reason: 'clearance_check_limit' })
    })

    it('reports search_incomplete when the clearance budget ran out before anything legal was found', () => {
      const result = placement_candidates_for_actor(make_actor({ can_place: () => false }), { entity_name: 'region-crate', limit: 4, region: box(-10.5, -10.5, 12.5, 12.5) }) as any
      expect(result.candidates).toEqual([])
      expect(result.spatial_status).toBe('search_incomplete')
      expect(result.search_completeness).toMatchObject({ complete: false, reason: 'clearance_check_limit' })
    })

    it('says none_in_verified_scope when the whole region was evaluated and nothing is legal', () => {
      const result = placement_candidates_for_actor(make_actor({ can_place: () => false }), { entity_name: 'region-crate', limit: 4, region: box(-1.5, -1.5, 1.5, 1.5) }) as any
      expect(result.ok).toBe(true)
      expect(result.candidates).toEqual([])
      expect(result.spatial_status).toBe('none_in_verified_scope')
      expect(result.search_completeness).toMatchObject({ complete: true, legal_candidate_count: 0, returned_count: 0 })
      expect(result.search_completeness.region_rejected_count).toBeGreaterThan(0)
      expect(result.candidates_may_be_incomplete).toBeUndefined()
      expect(result.execution_eligibility).toBe('no_candidate')
    })
  })

  describe('stock', () => {
    it('lists candidates but marks them a stock shortfall when the placement item is not held', () => {
      const result = placement_candidates_for_actor(make_actor({ held: 0 }), { entity_name: 'region-crate', limit: 2, region: box(-1.5, -1.5, 1.5, 1.5) }) as any
      expect(result.candidates.length).toBe(2)
      expect(result.material_status).toEqual({ status: 'stock_shortfall', item_name: KIT, held_count: 0, required_count: 1 })
      expect(result.execution_eligibility).toBe('stock_shortfall')
      expect(result.spatial_status).toBe('candidates_found')
    })

    it('marks them eligible when the item is held, and reports the full count a placement needs', () => {
      const held = placement_candidates_for_actor(make_actor({ held: 1 }), { entity_name: 'region-crate', limit: 2, region: box(-1.5, -1.5, 1.5, 1.5) }) as any
      expect(held.material_status).toEqual({ status: 'held', item_name: KIT, held_count: 1, required_count: 1 })
      expect(held.execution_eligibility).toBe('eligible')
      G.prototypes.entity = { 'region-crate': crate_prototype(2) }
      const short = placement_candidates_for_actor(make_actor({ held: 1 }), { entity_name: 'region-crate', limit: 2, region: box(-1.5, -1.5, 1.5, 1.5) }) as any
      expect(short.material_status).toEqual({ status: 'stock_shortfall', item_name: KIT, held_count: 1, required_count: 2 })
      expect(short.execution_eligibility).toBe('stock_shortfall')
    })

    it('reports unknown material, not a shortfall, when the prototype names no single placement item', () => {
      G.prototypes.entity = { 'region-crate': { ...crate_prototype(), items_to_place_this: [] } }
      const result = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', limit: 2, region: box(-1.5, -1.5, 1.5, 1.5) }) as any
      expect(result.material_status.status).toBe('unknown')
      expect(result.execution_eligibility).toBe('material_unknown')
    })

    it('keeps the status fields when no region was requested', () => {
      const result = placement_candidates_for_actor(make_actor({ held: 0 }), { entity_name: 'region-crate', center: { x: 0.5, y: 0.5 }, radius: 1, limit: 2 }) as any
      expect(result).toMatchObject({ spatial_status: 'candidates_found', execution_eligibility: 'stock_shortfall',
        search_completeness: { complete: true, search_radius: 1, region_rejected_count: 0 } })
    })
  })

  describe('execution', () => {
    function generated(region = box(-1.5, -1.5, 1.5, 1.5)) {
      const actor = make_actor()
      const set = create_placement_candidate_set(actor, { entity_name: 'region-crate', limit: 3, region }) as any
      return { actor, set }
    }

    it('stores the region on the set and re-checks it: a forged set holding an outside candidate is refused', () => {
      const { actor, set } = generated()
      const stored = G.storage.sgluna_placement_candidate_sets[set.candidate_set_id]
      expect(stored.region).toEqual(box(-1.5, -1.5, 1.5, 1.5))
      const submit: any[] = []
      expect(execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', (...args: any[]) => { submit.push(args); return true })[0]).toBe(true)
      expect(submit.length).toBe(1)

      // Move the stored region away from where the candidates stand.
      stored.region = box(100, 100, 102, 102)
      submit.length = 0
      const refused = execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', (...args: any[]) => { submit.push(args); return true })
      expect(refused[0]).toBe(false)
      expect(refused[1]).toContain('placement_candidate_outside_region')
      expect(submit).toEqual([])
      expect(placement_candidate_preflight(actor, set.candidate_set_id, 'candidate-1')).toMatchObject({ ok: false, code: 'placement_candidate_outside_region' })
    })

    it('re-checks a circle region at the boundary the same way', () => {
      const { actor, set } = generated(circle(0.5, 0.5, 2))
      const stored = G.storage.sgluna_placement_candidate_sets[set.candidate_set_id]
      const candidate = stored.candidates[0]
      stored.region = circle(candidate.position.x, candidate.position.y, 0.0000001)
      expect(placement_candidate_preflight(actor, set.candidate_set_id, candidate.id)).toMatchObject({ ok: true })
      stored.region = circle(candidate.position.x + 1, candidate.position.y, 0.5)
      expect(placement_candidate_preflight(actor, set.candidate_set_id, candidate.id)).toMatchObject({ ok: false, code: 'placement_candidate_outside_region' })
    })

    it('has the preflight return the stored position, direction and region', () => {
      const { actor, set } = generated(circle(0.5, 0.5, 2))
      const candidate = set.candidates[0]
      const preflight = placement_candidate_preflight(actor, set.candidate_set_id, candidate.id) as any
      expect(preflight).toMatchObject({ ok: true, placement_item: { entity_name: 'region-crate', item_name: KIT },
        candidate_position: candidate.position, candidate_direction: candidate.direction, candidate_region: circle(0.5, 0.5, 2) })
    })

    it('returns the candidate position even when the placement item is missing, and no region when none was stored', () => {
      const actor = make_actor({ held: 0 })
      const set = create_placement_candidate_set(actor, { entity_name: 'region-crate', center: { x: 0.5, y: 0.5 }, radius: 1, limit: 1 }) as any
      const preflight = placement_candidate_preflight(actor, set.candidate_set_id, 'candidate-1') as any
      expect(preflight).toMatchObject({ ok: false, code: 'placement_item_missing', candidate_position: set.candidates[0].position, candidate_direction: 0 })
      expect(preflight.candidate_region).toBeUndefined()
    })
  })

  describe('validation', () => {
    const malformed: Array<[string, any]> = [
      ['not an object', 5],
      ['missing shape', { center: { x: 0, y: 0 }, radius: 3 }],
      ['unknown shape', { shape: 'ellipse', center: { x: 0, y: 0 }, radius: 3 }],
      ['circle without center', { shape: 'circle', radius: 3 }],
      ['circle with non-numeric center', { shape: 'circle', center: { x: '0', y: 0 }, radius: 3 }],
      ['circle with zero radius', circle(0, 0, 0)],
      ['circle with negative radius', circle(0, 0, -1)],
      ['circle with radius above 256', circle(0, 0, 257)],
      ['circle with non-finite radius', circle(0, 0, Number.NaN)],
      ['circle with infinite center', circle(Number.POSITIVE_INFINITY, 0, 3)],
      ['box with inverted x', box(2, 0, 1, 1)],
      ['box with inverted y', box(0, 2, 1, 1)],
      ['box wider than 512', box(0, 0, 513, 1)],
      ['box taller than 512', box(0, 0, 1, 513)],
      ['box without a corner', { shape: 'box', left_top: { x: 0, y: 0 } }],
    ]

    for (const [label, region] of malformed) {
      it(`rejects ${label}`, () => {
        expect(normalize_region(region).ok).toBe(false)
        const result = create_placement_candidate_set(make_actor(), { entity_name: 'region-crate', region }) as any
        expect(result).toMatchObject({ ok: false, code: 'invalid_region', entity_name: 'region-crate' })
        expect(typeof result.error).toBe('string')
        expect(G.storage.sgluna_placement_candidate_sets ?? {}).toEqual({})
      })
    }

    it('accepts the documented maxima and a degenerate box, and returns a normalized copy', () => {
      expect(normalize_region(circle(-5, 5, 256)).ok).toBe(true)
      expect(normalize_region(box(-256, -256, 256, 256)).ok).toBe(true)
      const point = normalize_region({ shape: 'box', left_top: { x: 1.5, y: 2.5 }, right_bottom: { x: 1.5, y: 2.5 }, extra: 'dropped' }) as any
      expect(point).toEqual({ ok: true, region: box(1.5, 2.5, 1.5, 2.5) })
      const only = placement_candidates_for_actor(make_actor(), { entity_name: 'region-crate', limit: 8, region: box(1.5, 2.5, 1.5, 2.5) }) as any
      expect(only.candidates.map((candidate: any) => candidate.position)).toEqual([{ x: 1.5, y: 2.5 }])
    })
  })
})
