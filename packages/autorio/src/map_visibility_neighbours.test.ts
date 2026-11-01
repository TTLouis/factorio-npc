import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nearest_pole_for_unpowered } from './electric_facts'
import { entity_reference_hint, resolve_visible_entity_reference } from './entity_reference'
import { entity_geometry_for_actor, logistics_topology_for_actor, preservation_geometry_for_actor } from './knowledge'
import { inspect_charted_entity } from './map_remote'
import { compact_spatial_summary } from './spatial_semantics'
import { throughput_capacity } from './throughput_capacity'
import { seen_now } from './visible_reads'

// M3, reads behind an entity the NPC sees now (Sol M3C-R1-1, R1-3, R2-1). A seen entity's linked neighbours (inserter and
// drill targets, pipe links), its mining area and its pole search are read only in chunks the NPC sees now; a fogged part is
// marked not visible, never absent, so the answer is the same whether a fogged neighbour still stands. A hint recorded before
// bounds were kept, and a hint on another surface, are checked the same way before any scan. These run the real summary
// helpers. Pre-change (a6923bae) the neighbours, mining area and pole search are read from the fog, a legacy hint and a hint on
// another surface are scanned first.

const G: any = globalThis

// Window (0, 0) sees chunks -2..2, tiles -64..95.99. Chunk 3 (x 96..127) is charted but fogged.
function set_window(chunk_x: number, chunk_y = 0) {
  const explored: Record<string, any> = {}
  for (let x = chunk_x - 2; x <= chunk_x + 3; x++) {
    for (let y = chunk_y - 2; y <= chunk_y + 2; y++) explored[`1:${x}:${y}`] = { surface_index: 1, x, y }
  }
  G.storage.sgluna_map_knowledge = { force_index: 1, explored, visible_surface_index: 1, visible_chunk_x: chunk_x, visible_chunk_y: chunk_y, push_queue: [] }
}

const UNIT = 401
const NEIGHBOUR = 402

describe('reads behind an entity the NPC sees now (M3)', () => {
  const original = {
    pairs: G.pairs,
    storage: G.storage,
    lookup: G.game.get_entity_by_unit_number,
    get_surface: G.game.get_surface,
    tick: G.game.tick,
    prototypes: G.prototypes,
  }

  let force: any
  let surface: any
  let find: ReturnType<typeof vi.fn>
  let lookup: Record<number, any>
  let actor: ControlledActor
  // Whether the neighbour in the fogged chunk still stands, and how often it was read.
  let neighbour: { standing: boolean, reads: number }

  beforeEach(() => {
    G.pairs = Object.entries
    G.storage = {}
    G.game.tick = 500
    G.prototypes = { item: {}, entity: { 'fast-inserter': { name: 'fast-inserter', type: 'inserter', bulk: false } } }
    lookup = {}
    G.game.get_entity_by_unit_number = (unit: number) => lookup[unit]
    neighbour = { standing: true, reads: 0 }
    find = vi.fn(() => [])
    force = { index: 1, name: 'player', is_chunk_visible: () => false, is_chunk_charted: () => false }
    surface = { index: 1, name: 'nauvis', valid: true, find_entities_filtered: find }
    G.game.get_surface = (index: number) => index === 1 ? surface : undefined
    actor = {
      is_valid: true,
      position: { x: 0, y: 0 },
      force,
      surface,
      status_snapshot: () => ({ actor_id: 9, kind: 'standalone_character' }),
    } as unknown as ControlledActor
    set_window(0)
  })

  afterEach(() => {
    G.pairs = original.pairs
    G.storage = original.storage
    G.game.get_entity_by_unit_number = original.lookup
    G.game.get_surface = original.get_surface
    G.game.tick = original.tick
    G.prototypes = original.prototypes
  })

  const seen = () => seen_now(force, surface)

  function base(name: string, type: string, unit_number: number, at: { x: number, y: number }, half = 0.4) {
    return {
      valid: true,
      name,
      type,
      unit_number,
      position: { ...at },
      direction: 0,
      surface,
      force,
      fluids_count: 0,
      fluidbox: { length: 0 },
      bounding_box: { left_top: { x: at.x - half, y: at.y - half }, right_bottom: { x: at.x + half, y: at.y + half } },
    }
  }

  // A chest the engine links at `at`, read through a counting getter so a read of it shows.
  function linked_chest(at: { x: number, y: number }) {
    const chest = base('wooden-chest', 'container', NEIGHBOUR, at)
    return () => {
      neighbour.reads += 1
      return neighbour.standing ? chest : undefined
    }
  }

  // An inserter at x whose drop position is one tile east and pickup one tile west.
  function inserter_at(x: number) {
    const at = { x, y: 10.5 }
    const pickup = base('iron-chest', 'container', 403, { x: x - 1, y: 10.5 })
    const drop = linked_chest({ x: x + 1, y: 10.5 })
    const entity: any = {
      ...base('fast-inserter', 'inserter', UNIT, at),
      active: true,
      held_stack: { valid_for_read: false, count: 0 },
      inserter_stack_size_override: 0,
      inserter_target_pickup_count: 4,
      pickup_from_left_lane: true,
      pickup_from_right_lane: true,
      pickup_position: { x: x - 1, y: 10.5 },
      drop_position: { x: x + 1, y: 10.5 },
      pickup_target: pickup,
    }
    Object.defineProperty(entity, 'drop_target', { get: drop, configurable: true })
    lookup[UNIT] = entity
    return entity
  }

  describe('inserter pickup and drop targets', () => {
    // The inserter at x = 94.5 is seen (chunk 2); its drop position 95.5 is seen too, but the chest there is not when it
    // reaches 96 (chunk 3). At x = 95.5 the drop position itself (96.5) is in chunk 3.
    it('marks a drop target in an unseen chunk not visible without reading it, standing or destroyed', () => {
      const inserter = inserter_at(95.5)
      const standing: any = compact_spatial_summary(inserter, seen())
      neighbour.standing = false
      const destroyed: any = compact_spatial_summary(inserter, seen())
      expect(standing.item_io.drop_target).toEqual({ not_visible: true })
      expect(standing.item_io.pickup_target).toMatchObject({ unit_number: 403 })
      expect(destroyed).toEqual(standing)
      expect(neighbour.reads).toBe(0)
    })

    it('reads the drop target once its chunk is seen, and a destroyed one is absent', () => {
      const inserter = inserter_at(95.5)
      set_window(1)
      expect((compact_spatial_summary(inserter, seen()) as any).item_io.drop_target).toMatchObject({ unit_number: NEIGHBOUR })
      neighbour.standing = false
      expect((compact_spatial_summary(inserter, seen()) as any).item_io.drop_target).toBeUndefined()
    })

    it('marks a target whose drop position is seen but whose box reaches an unseen chunk not visible', () => {
      const inserter = inserter_at(94.5)
      // The chest at 95.5 spans 95.1..95.9: wholly seen. A wider one reaching 96.2 is not.
      expect((compact_spatial_summary(inserter, seen()) as any).item_io.drop_target).toMatchObject({ unit_number: NEIGHBOUR })
      const wide = base('steel-chest', 'container', NEIGHBOUR, { x: 95.5, y: 10.5 }, 0.7)
      Object.defineProperty(inserter, 'drop_target', { get: () => wide })
      expect((compact_spatial_summary(inserter, seen()) as any).item_io.drop_target).toEqual({ not_visible: true })
    })

    it('geometry and inserter capacity give the same not-visible target, standing or destroyed, and preservation is unproven', () => {
      inserter_at(95.5)
      const geometry: any = entity_geometry_for_actor(actor, UNIT)
      const capacity: any = throughput_capacity(actor, { kind: 'inserter_instance', unit_number: UNIT })
      const preservation = preservation_geometry_for_actor(actor, UNIT)
      neighbour.standing = false
      expect(geometry.found).toBe(true)
      expect(geometry.item_io.drop_target).toEqual({ not_visible: true })
      expect(geometry.item_io.pickup_target).toMatchObject({ unit_number: 403 })
      expect(capacity.ok).toBe(true)
      expect(capacity.drop_target).toEqual({ not_visible: true })
      expect(preservation).toBeUndefined()
      expect(entity_geometry_for_actor(actor, UNIT)).toEqual(geometry)
      expect(throughput_capacity(actor, { kind: 'inserter_instance', unit_number: UNIT })).toEqual(capacity)
      expect(neighbour.reads).toBe(0)
      // Seen: the same reads name the chest, and preservation can be proven again.
      neighbour.standing = true
      set_window(1)
      expect((entity_geometry_for_actor(actor, UNIT) as any).item_io.drop_target).toMatchObject({ unit_number: NEIGHBOUR })
      expect((throughput_capacity(actor, { kind: 'inserter_instance', unit_number: UNIT }) as any).drop_target).toMatchObject({ unit_number: NEIGHBOUR })
      expect(preservation_geometry_for_actor(actor, UNIT)).toMatchObject({ found: true })
    })
  })

  describe('pipe links', () => {
    // A pipe whose single connection links east to `target_position`, to a neighbour that answers its reciprocal link.
    function pipe_at(x: number, connection_type: 'normal' | 'underground' | 'linked', target_x: number, reach = 10) {
      const entity: any = {
        ...base('pipe', 'pipe', UNIT, { x, y: 10.5 }),
        fluids_count: 1,
        get_fluid: () => undefined,
      }
      const other: any = { ...base('pipe', 'pipe', NEIGHBOUR, { x: target_x, y: 10.5 }) }
      other.fluidbox = { length: 1, get_pipe_connections: () => [{ target: { owner: entity }, target_fluidbox_index: 1 }] }
      entity.fluidbox = {
        length: 1,
        get_capacity: () => 100,
        get_prototype: () => ({ production_type: 'input-output', pipe_connections: [{ connection_type, max_underground_distance: reach }] }),
        get_pipe_connections: () => {
          const standing = neighbour.standing
          return [{
            position: { x: x + 0.5, y: 10.5 },
            target_position: { x: target_x, y: 10.5 },
            flow_direction: 'input-output',
            connection_type,
            get target() {
              neighbour.reads += 1
              return standing ? { owner: other } : undefined
            },
            target_fluidbox_index: standing ? 1 : undefined,
          }]
        },
      }
      lookup[UNIT] = entity
      return entity
    }

    it('marks a normal link into an unseen chunk not visible, standing or destroyed', () => {
      const pipe = pipe_at(95.5, 'normal', 96.5)
      const standing: any = compact_spatial_summary(pipe, seen())
      const geometry: any = entity_geometry_for_actor(actor, UNIT)
      neighbour.standing = false
      expect(standing.fluid.storages[0].connections[0]).toEqual({
        connection_index: 1,
        position: { x: 96, y: 10.5 },
        flow_direction: 'input-output',
        connection_type: 'normal',
        target_position: { x: 96.5, y: 10.5 },
        target_not_visible: true,
      })
      expect(geometry.fluid_storages[0].pipe_connections[0]).toMatchObject({ target_not_visible: true })
      expect(geometry.fluid_storages[0].pipe_connections[0].connected).toBeUndefined()
      expect(compact_spatial_summary(pipe, seen())).toEqual(standing)
      expect(entity_geometry_for_actor(actor, UNIT)).toEqual(geometry)
      expect(neighbour.reads).toBe(0)
    })

    it('marks an underground link not visible when its reach meets an unseen chunk', () => {
      // At x = 88.5 the 12 tile reach goes to 100.9 (chunk 3), though the far end named here (93.5) is seen.
      const pipe = pipe_at(88.5, 'underground', 93.5)
      expect((compact_spatial_summary(pipe, seen()) as any).fluid.storages[0].connections[0].target_not_visible).toBe(true)
      expect(neighbour.reads).toBe(0)
    })

    it('reads a link, its target and the reciprocal once seen', () => {
      const pipe = pipe_at(40.5, 'underground', 45.5)
      const connection = (compact_spatial_summary(pipe, seen()) as any).fluid.storages[0].connections[0]
      expect(connection).toMatchObject({ target: { unit_number: NEIGHBOUR }, reciprocal: true, target_fluidbox_index: 1 })
      expect(connection.target_not_visible).toBeUndefined()
      const linked: any = entity_geometry_for_actor(actor, UNIT)
      expect(linked.fluid_storages[0].pipe_connections[0]).toMatchObject({ connected: true, target_valid: true, target: { unit_number: NEIGHBOUR } })
    })

    it('bounds long underground links from native definitions before summary, geometry or topology target reads', () => {
      const pipe = pipe_at(80.5, 'underground', 110.5, 30)
      const summary: any = compact_spatial_summary(pipe, seen())
      const geometry = entity_geometry_for_actor(actor, UNIT)
      const topology = logistics_topology_for_actor(actor, UNIT)
      expect(summary.fluid.storages[0].connections[0].target_not_visible).toBe(true)
      expect((geometry as any).fluid_storages[0].pipe_connections[0].target_not_visible).toBe(true)
      expect(topology).toMatchObject({ found: false, code: 'area_not_visible' })
      neighbour.standing = false
      expect(compact_spatial_summary(pipe, seen())).toEqual(summary)
      expect(entity_geometry_for_actor(actor, UNIT)).toEqual(geometry)
      expect(logistics_topology_for_actor(actor, UNIT)).toEqual(topology)
      expect(neighbour.reads).toBe(0)
      set_window(1)
      neighbour.standing = true
      expect((compact_spatial_summary(pipe, seen()) as any).fluid.storages[0].connections[0].target.unit_number).toBe(NEIGHBOUR)
      expect((logistics_topology_for_actor(actor, UNIT) as any).relations[0].neighbour.unit_number).toBe(NEIGHBOUR)
      neighbour.standing = false
      expect((logistics_topology_for_actor(actor, UNIT) as any).relations).toEqual([])
    })

    it('includes all merged fluidbox definitions, including runtime-shaped connection collections', () => {
      const pipe = pipe_at(80.5, 'underground', 110.5)
      pipe.fluidbox.get_prototype = () => [
        { production_type: 'input-output', pipe_connections: { 1: { connection_type: 'underground', max_underground_distance: 10 } } },
        { production_type: 'input-output', pipe_connections: { 1: { connection_type: 'underground', max_underground_distance: 30 } } },
      ]
      expect((entity_geometry_for_actor(actor, UNIT) as any).fluid_storages[0].pipe_connections[0].target_not_visible).toBe(true)
      expect(neighbour.reads).toBe(0)
    })

    it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 4097])('refuses unknown or invalid native underground reach %s before a target read', reach => {
      const pipe = pipe_at(40.5, 'underground', 45.5)
      pipe.fluidbox.get_prototype = () => ({ production_type: 'input-output', pipe_connections: [{ connection_type: 'underground', max_underground_distance: reach }] })
      expect((compact_spatial_summary(pipe, seen()) as any).fluid.storages[0].connections[0].target_not_visible).toBe(true)
      expect(logistics_topology_for_actor(actor, UNIT)).toMatchObject({ found: false, code: 'area_not_visible' })
      expect(neighbour.reads).toBe(0)
    })

    it('refuses script-linked pipes even when the local area is visible, but retains unrestricted reconciliation', () => {
      const pipe = pipe_at(40.5, 'linked', 110.5)
      const result = compact_spatial_summary(pipe, seen())
      neighbour.standing = false
      expect(compact_spatial_summary(pipe, seen())).toEqual(result)
      expect(neighbour.reads).toBe(0)
      neighbour.standing = true
      expect((compact_spatial_summary(pipe) as any).fluid.storages[0].connections[0].target.unit_number).toBe(NEIGHBOUR)
    })
  })

  describe('topology endpoint visibility', () => {
    function custom_inserter() {
      const entity = inserter_at(80.5)
      entity.prototype = { allow_custom_vectors: true }
      entity.drop_position = { x: 110.5, y: 10.5 }
      Object.defineProperty(entity, 'drop_target', { get: linked_chest(entity.drop_position), configurable: true })
      return entity
    }

    it('checks custom pickup/drop positions before reading an inserter route, with a visible control', () => {
      const entity = custom_inserter()
      const result = logistics_topology_for_actor(actor, UNIT)
      expect(result).toMatchObject({ found: false, code: 'area_not_visible' })
      neighbour.standing = false
      expect(logistics_topology_for_actor(actor, UNIT)).toEqual(result)
      expect(neighbour.reads).toBe(0)
      set_window(1)
      neighbour.standing = true
      expect((logistics_topology_for_actor(actor, UNIT) as any).relations[0].to.unit_number).toBe(NEIGHBOUR)
      expect((compact_spatial_summary(entity, seen()) as any).item_io.drop_target.unit_number).toBe(NEIGHBOUR)
    })

    it('checks a nearby inserter route before testing whether it touches the center', () => {
      const inserter = custom_inserter()
      const center = { ...base('wooden-chest', 'container', 410, { x: 78.5, y: 10.5 }) }
      lookup[410] = center
      find.mockReturnValue([inserter] as never)
      const result = logistics_topology_for_actor(actor, 410)
      neighbour.standing = false
      expect(logistics_topology_for_actor(actor, 410)).toEqual(result)
      expect(result).toMatchObject({ found: false, code: 'area_not_visible' })
      expect(neighbour.reads).toBe(0)
      set_window(1)
      inserter.pickup_target = center
      neighbour.standing = true
      expect((logistics_topology_for_actor(actor, 410) as any).relations[0].to.unit_number).toBe(NEIGHBOUR)
    })

    it('checks every belt neighbour box before serializing it', () => {
      const belt = { ...base('transport-belt', 'transport-belt', UNIT, { x: 80.5, y: 10.5 }),
        belt_neighbours: { inputs: [], outputs: [base('wide-belt', 'transport-belt', NEIGHBOUR, { x: 82.5, y: 10.5 }, 14)] } }
      lookup[UNIT] = belt
      expect(logistics_topology_for_actor(actor, UNIT)).toMatchObject({ found: false, code: 'area_not_visible' })
      set_window(1)
      expect((logistics_topology_for_actor(actor, UNIT) as any).relations[0].to.unit_number).toBe(NEIGHBOUR)
    })

    it('never reads unbounded script-linked belt neighbours', () => {
      const belt = { ...base('linked-belt', 'linked-belt', UNIT, { x: 80.5, y: 10.5 }),
        get belt_neighbours() { neighbour.reads++; return { inputs: [], outputs: [] } } }
      lookup[UNIT] = belt
      expect(logistics_topology_for_actor(actor, UNIT)).toMatchObject({ found: false, code: 'area_not_visible' })
      expect(neighbour.reads).toBe(0)
    })
  })

  describe('mining area', () => {
    function drill_at(x: number) {
      const drill: any = {
        ...base('electric-mining-drill', 'mining-drill', UNIT, { x, y: 10.5 }, 1.4),
        prototype: { mining_drill_radius: 2.49, resource_categories: { basic_solid: true } },
        drop_position: { x, y: 8.5 },
        drop_target: undefined,
      }
      return drill
    }

    it('does not scan a mining area that reaches an unseen chunk', () => {
      const result: any = compact_spatial_summary(drill_at(94.5), seen())
      expect(result.mining).toEqual({ radius: 2.49, search_center: { x: 94.5, y: 10.5 }, not_visible: true })
      expect(find).not.toHaveBeenCalled()
    })

    it('scans a mining area that is wholly seen', () => {
      find.mockImplementation(() => [{ valid: true, name: 'iron-ore', type: 'resource', amount: 50, prototype: { resource_category: 'basic_solid' } }])
      const result: any = compact_spatial_summary(drill_at(40.5), seen())
      expect(result.mining.resource_coverage).toEqual([{ name: 'iron-ore', entities: 1, amount: 50 }])
      expect(find).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource' }))
    })
  })

  describe('pole search for an unpowered entity', () => {
    const at = (x: number) => base('assembling-machine-2', 'assembling-machine', UNIT, { x, y: 10.5 }, 1.4) as any

    it('searches the full radius when it is seen, as a harness read always does', () => {
      expect(nearest_pole_for_unpowered(at(10.5), seen())).toEqual({ search_radius: 64, poles_found: 0 })
      expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'electric-pole', radius: 64 }))
      expect(nearest_pole_for_unpowered(at(80.5))).toEqual({ search_radius: 64, poles_found: 0 })
    })

    it('shrinks the radius to what is seen and says so', () => {
      // At x = 80.5: 32 tiles reach 112.5 and 16 reach 96.5 (chunk 3); 8 reach 88.5.
      expect(nearest_pole_for_unpowered(at(80.5), seen())).toEqual({ search_radius: 8, poles_found: 0, search_radius_limited_by_visibility: true })
      expect(find).toHaveBeenCalledTimes(1)
      expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'electric-pole', radius: 8 }))
    })

    it('searches nothing when not even the smallest radius is seen', () => {
      expect(nearest_pole_for_unpowered(at(94.5), seen())).toEqual({ search_radius: 0, search_area_not_visible: true })
      expect(find).not.toHaveBeenCalled()
    })
  })

  describe('a hint recorded before bounds were kept (Sol M3C-R1-3)', () => {
    // An assembling machine at x = 95.5: its centre is seen, its 3x3 collision box reaches 96.7 (chunk 3).
    const LEGACY = 'assembling-machine-1'

    function legacy_hint(name = LEGACY) {
      G.storage.sgluna_entity_reference_hints = {
        [UNIT]: { name, surface_index: 1, force_index: 1, position: { x: 95.5, y: 10.5 }, observed_tick: 500 },
      }
      G.prototypes.entity[LEGACY] = { name: LEGACY, collision_box: { left_top: { x: -1.2, y: -1.2 }, right_bottom: { x: 1.2, y: 1.2 } } }
      const machine = base(LEGACY, 'assembling-machine', UNIT, { x: 95.5, y: 10.5 }, 1.5)
      find.mockImplementation(() => neighbour.standing ? [machine] : [])
      G.game.tick = 900
      return machine
    }

    it('is not_visible without a scan or a refresh, standing or destroyed', () => {
      legacy_hint()
      const standing = resolve_visible_entity_reference(actor, UNIT, 'map_visible')
      neighbour.standing = false
      const destroyed = resolve_visible_entity_reference(actor, UNIT, 'map_visible')
      expect(standing).toEqual({ code: 'not_visible' })
      expect(destroyed).toEqual(standing)
      expect(find).not.toHaveBeenCalled()
      expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 500 })
      expect(entity_reference_hint(UNIT)?.box).toBeUndefined()
    })

    it('resolves once the prototype bounds are seen and records the observed box', () => {
      const machine = legacy_hint()
      set_window(1)
      expect(resolve_visible_entity_reference(actor, UNIT, 'map_visible')).toEqual({ code: 'ok', entity: machine })
      expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 900, box: machine.bounding_box })
    })

    it('is not found without a scan when no prototype carries the name any more', () => {
      legacy_hint('removed-modded-machine')
      expect(resolve_visible_entity_reference(actor, UNIT, 'map_visible')).toEqual({ code: 'not_found' })
      expect(find).not.toHaveBeenCalled()
    })
  })

  describe('map inspection of an entity on another surface (Sol M3C-R2-1)', () => {
    let other: any
    let other_find: ReturnType<typeof vi.fn>
    let charted: boolean

    beforeEach(() => {
      other_find = vi.fn(() => [])
      other = { index: 2, name: 'vulcanus', valid: true, find_entities_filtered: other_find }
      G.game.get_surface = (index: number) => index === 1 ? surface : index === 2 ? other : undefined
      charted = true
      force.is_chunk_charted = (s: any) => s.index === 2 && charted
      const machine = { ...base('assembling-machine-1', 'assembling-machine', UNIT, { x: 10.5, y: 10.5 }, 1.5), surface: other, get_recipe: () => [undefined] }
      other_find.mockImplementation(() => neighbour.standing ? [machine] : [])
      G.storage.sgluna_entity_reference_hints = {
        [UNIT]: { name: 'assembling-machine-1', surface_index: 2, force_index: 1, position: { x: 10.5, y: 10.5 }, box: machine.bounding_box, observed_tick: 500 },
      }
      G.game.tick = 900
    })

    it('is area_not_visible without a scan or a refresh, standing or destroyed', () => {
      const standing = inspect_charted_entity(actor, UNIT)
      neighbour.standing = false
      expect(standing).toEqual({ ok: false, code: 'area_not_visible', unit_number: UNIT })
      expect(inspect_charted_entity(actor, UNIT)).toEqual(standing)
      expect(other_find).not.toHaveBeenCalled()
      expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 500 })
    })

    it('is area_uncharted from the hint when that chunk was never charted', () => {
      charted = false
      expect(inspect_charted_entity(actor, UNIT)).toEqual({ ok: false, code: 'area_uncharted', unit_number: UNIT })
      neighbour.standing = false
      expect(inspect_charted_entity(actor, UNIT)).toEqual({ ok: false, code: 'area_uncharted', unit_number: UNIT })
      expect(other_find).not.toHaveBeenCalled()
    })

    it('reads the entity when that surface shows it now, and a destroyed one is not found', () => {
      force.is_chunk_visible = (s: any) => s.index === 2
      expect(inspect_charted_entity(actor, UNIT)).toMatchObject({ ok: true, entity: { unit_number: UNIT } })
      neighbour.standing = false
      expect(inspect_charted_entity(actor, UNIT)).toEqual({ ok: false, code: 'entity_not_found', unit_number: UNIT })
    })
  })
})
