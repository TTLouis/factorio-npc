import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { construction_plan_preflight, execute_validated_construction_plan, resume_construction_layout, validate_construction_execution_plan } from './construction_execution'
import { construction_layout_status, create_layout_record, record_layout_node_placed } from './construction_layout'
import { placement_footprint } from './placement_geometry'
import { new_operation_admission, pinned_operation_batch_refs } from './operation_admission'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

// Milestone 4, acceptance L2 and L3: a layout with typed connections is proved before anything is built (planning status kept
// apart from execution eligibility), executed in a deterministic dependency order, and every placed node is bound to a
// receipt whose connections are verified against the actual entities. Engine facts only: prototype `type`, the inserter and
// drill vectors, the pole supply area, and the entities' own pickup/drop targets and electric network ids.

type Pos = { x: number, y: number }

const MASK = { layers: { object: true, item: true } }
// Native item interfaces: an entity's inventories are indexes 1..count (its get_inventory), a prototype's are the indexes its
// get_inventory_size answers; nothing here has a transport line.
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
  'test-chest': prototype('test-chest', 'container', [1, 1], 0.4, {}, 1),
  'test-inserter': prototype('test-inserter', 'inserter', [1, 1], 0.15, {
    inserter_pickup_position: { x: 0, y: -1 },
    inserter_drop_position: { x: 0, y: 1.2 },
    electric_energy_source_prototype: {},
  }),
  'test-pole': prototype('test-pole', 'electric-pole', [1, 1], 0.15, { supply_area_distance: 2.5, max_wire_distance: 7.5 }),
  'test-lab': prototype('test-lab', 'lab', [3, 3], 1.2, { electric_energy_source_prototype: {} }, 2),
  // 2.0 returns the output vector in array form.
  'test-drill': prototype('test-drill', 'mining-drill', [2, 2], 0.9, { vector_to_place_result: [-0.5, -1.3], electric_energy_source_prototype: {} }),
  'test-pipe': prototype('test-pipe', 'pipe', [1, 1], 0.4),
  'test-bare-inserter': prototype('test-bare-inserter', 'inserter', [1, 1], 0.15),
  // No inventory and no transport line: standing on an inserter's point does not make it that inserter's endpoint.
  'test-wall': prototype('test-wall', 'wall', [1, 1], 0.29),
  // An inventory the engine forbids inserters to take from.
  'test-locked-chest': prototype('test-locked-chest', 'container', [1, 1], 0.4, { flags: { 'no-automated-item-removal': true } }, 1),
}
const HELD = { 'test-chest': 3, 'test-inserter': 1, 'test-pole': 1, 'test-lab': 1, 'test-drill': 1, 'test-pipe': 2, 'test-bare-inserter': 1, 'test-wall': 1, 'test-locked-chest': 1 }

const BOILER_UNIT = 500
const EXISTING_PROTOTYPE = { name: 'test-boiler', type: 'boiler', electric_energy_source_prototype: undefined, get_inventory_size: (index: number) => index === 1 ? 1 : undefined }

// A chest at (0.5,-0.5), an inserter at (0.5,0.5) facing north (pickup (0.5,-0.5), drop (0.5,1.7)) and an existing boiler.
const SRC = { entity_name: 'test-chest', x: 0.5, y: -0.5, slot: 'src' }
const INS = { entity_name: 'test-inserter', x: 0.5, y: 0.5, direction: 0, slot: 'ins' }
const FEED = { kind: 'inserter' as const, inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { unit_number: BOILER_UNIT } }
const LAB_AT = { entity_name: 'test-lab', x: 4.5, y: 0.5, direction: 0, slot: 'lab' }
const POLE_AT = { entity_name: 'test-pole', x: 7.5, y: 0.5, direction: 0, slot: 'pole' }
const WIRE = { kind: 'power' as const, pole: { slot: 'pole' }, consumer: { slot: 'lab' } }
// A drill at (2,2) facing north outputs at (1.5,0.7); a chest at (1.5,0.5) contains that point.
const DRILL_AT = { entity_name: 'test-drill', x: 2, y: 2, direction: 0, slot: 'drill' }
const RECEIVER_AT = { entity_name: 'test-chest', x: 1.5, y: 0.5, slot: 'receiver' }
const OUTPUT = { kind: 'drill_output' as const, drill: { slot: 'drill' }, receiver: { slot: 'receiver' } }

function build(held: Record<string, number> = { ...HELD }) {
  const by_unit = new Map<number, any>()
  const created: any[] = []
  const hooks = { on_create: (_entity: any) => {} }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
    find_entities_filtered: vi.fn(() => []),
    count_entities_filtered: vi.fn(() => 0),
    can_place_entity: vi.fn(() => true),
  }
  surface.create_entity = vi.fn((args: any) => {
    const proto = PROTOTYPES[args.name]
    const entity: any = {
      valid: true,
      name: args.name,
      type: proto.type,
      unit_number: 900 + created.length + 1,
      position: { x: args.position.x, y: args.position.y },
      direction: args.direction ?? 0,
      surface,
      force: { index: 1 },
      prototype: proto,
      bounding_box: placement_footprint(proto, args.position, args.direction ?? 0).world_box,
      ...item_interface(proto.inventories),
    }
    created.push(entity)
    by_unit.set(entity.unit_number, entity)
    hooks.on_create(entity)
    return entity
  })
  const inventory: any = {
    get_contents: vi.fn(() => Object.entries(held).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
    get_item_count: vi.fn((name: string) => held[name] ?? 0),
    remove: vi.fn(({ name, count }: any) => {
      const removed = Math.min(held[name] ?? 0, count)
      held[name] = (held[name] ?? 0) - removed
      return removed
    }),
  }
  const position = { x: 0, y: 0 }
  const actor = {
    is_valid: true,
    character: { valid: true, name: 'character', type: 'character', position, build_distance: 20, resource_reach_distance: 20 },
    position,
    surface,
    force: { index: 1, name: 'player' },
    get_main_inventory: () => inventory,
    entity_build_args: () => ({ force: { index: 1 } }),
    status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character', valid: true, has_character: true, position }),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const basic = new_basic_operation_controller(() => actor, manager)
  const runtime = new_basic_operation_runtime(manager, basic)
  ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => by_unit.get(unit)
  function existing(unit_number: number, at: Pos, half: { x: number, y: number }, fields: Record<string, any> = {}) {
    const entity: any = {
      valid: true,
      name: 'test-boiler',
      type: 'boiler',
      unit_number,
      position: at,
      direction: 0,
      surface: { index: 1 },
      force: { index: 1 },
      prototype: EXISTING_PROTOTYPE,
      bounding_box: { left_top: { x: at.x - half.x, y: at.y - half.y }, right_bottom: { x: at.x + half.x, y: at.y + half.y } },
      ...item_interface(1),
      ...fields,
    }
    by_unit.set(unit_number, entity)
    return entity
  }
  // The boiler the inserter feeds: 3 wide, 2 tall, spanning y 1.01..2.99.
  const boiler = existing(BOILER_UNIT, { x: 0.5, y: 2 }, { x: 0.99, y: 0.99 })
  return { actor, surface, held, manager, basic, runtime, created, hooks, existing, boiler, by_unit }
}

type World = ReturnType<typeof build>

function validate(f: World, placements: any[], connections?: any[], plan_id = 'layout') {
  return validate_construction_execution_plan(f.actor, { plan_id, placements, connections }) as any
}

function start(f: World, placements: any[], connections: any[]) {
  const validation = validate(f, placements, connections)
  expect(validation).toMatchObject({ ok: true })
  const result = execute_validated_construction_plan(f.actor, validation.validation_id, placements.length, f.basic, f.manager)
  expect(result[0]).toBe(true)
  return { validation, result, layout_id: validation.validation_id as number }
}

function layout(layout_id: number) {
  return (globalThis as any).storage.sgluna_construction_layouts[layout_id]
}

function place_next(f: World) {
  return f.runtime.state_placing(f.actor)
}

describe('connected construction layouts (milestone 4 L2/L3)', () => {
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
  })

  afterEach(() => {
    ;(globalThis as any).pairs = original.pairs
    ;(globalThis as any).prototypes.entity = original.entity
    ;(globalThis as any).prototypes.item = original.item
    ;(globalThis as any).game.get_entity_by_unit_number = original.get_entity
  })

  describe('planning status is separate from execution eligibility (L2)', () => {
    it('reports a spatially valid layout with every short item, and stores no token', () => {
      const f = build({ ...HELD, 'test-chest': 0, 'test-inserter': 0 })
      const result = validate(f, [INS, SRC], [FEED])
      expect(result).toMatchObject({
        ok: false,
        planning_status: 'spatially_valid',
        execution_eligible: false,
        error: { code: 'ITEMS_MISSING', item_name: 'test-chest', required_count: 1, available_count: 0 },
        eligibility_blockers: [
          { code: 'ITEMS_MISSING', item_name: 'test-chest', required_count: 1, available_count: 0 },
          { code: 'ITEMS_MISSING', item_name: 'test-inserter', required_count: 1, available_count: 0 },
        ],
        execution_order: [1, 0],
      })
      // The planning half is still there: geometry and the connection proof.
      expect(result.placement_geometry).toHaveLength(2)
      expect(result.connections[0]).toMatchObject({ index: 0, kind: 'inserter', virtual_proof: { status: 'proved' } })
      expect(result.validation_id).toBeUndefined()
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('lists an out-of-reach node as an unproven route, beside the missing stock, never as a spatial failure', () => {
      const f = build({ ...HELD, 'test-chest': 0 })
      const result = validate(f, [{ entity_name: 'test-chest', x: 30.5, y: 0.5 }])
      expect(result).toMatchObject({ ok: false, planning_status: 'spatially_valid', execution_eligible: false })
      expect(result.eligibility_blockers).toEqual([
        expect.objectContaining({ code: 'ITEMS_MISSING', item_name: 'test-chest' }),
        expect.objectContaining({ code: 'OUTSIDE_LOCAL_BUILD_REACH', index: 0, route: 'unproven', distance: 30.5 }),
      ])
      expect(result.error.code).toBe('ITEMS_MISSING')
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('keeps the old reach error code for a plan whose only problem is reach', () => {
      const f = build()
      const result = validate(f, [{ entity_name: 'test-chest', x: 30.5, y: 0.5 }])
      expect(result).toMatchObject({
        ok: false,
        planning_status: 'spatially_valid',
        error: { code: 'OUTSIDE_LOCAL_BUILD_REACH', index: 0 },
        eligibility_blockers: [expect.objectContaining({ code: 'OUTSIDE_LOCAL_BUILD_REACH' })],
      })
    })

    it('states a fluid connection as unproven with the staging it needs, not as a guessed proof', () => {
      const f = build()
      const pipes = [{ entity_name: 'test-pipe', x: 0.5, y: 0.5, slot: 'a' }, { entity_name: 'test-pipe', x: 1.5, y: 0.5, slot: 'b' }]
      const result = validate(f, pipes, [{ kind: 'fluid', from: { slot: 'a' }, to: { slot: 'b' } }])
      expect(result).toMatchObject({
        ok: false,
        planning_status: 'spatially_valid',
        execution_eligible: false,
        error: { code: 'CONNECTION_UNPROVEN', index: 0, kind: 'fluid' },
      })
      expect(result.eligibility_blockers[0].staged_requirement).toBe('place a, b in its own validated plan, then validate this connection against its observed ports')
      expect(result.connections[0].virtual_proof).toMatchObject({ status: 'unproven' })
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('treats prototype vectors it cannot read as unproven eligibility, not as a mismatch', () => {
      const f = build()
      const bare = { entity_name: 'test-bare-inserter', x: 0.5, y: 0.5, direction: 0, slot: 'ins' }
      const result = validate(f, [SRC, bare], [FEED])
      expect(result).toMatchObject({ ok: false, planning_status: 'spatially_valid', error: { code: 'CONNECTION_UNPROVEN', index: 0 } })
    })

    it('fails a spatially invalid layout first, before stock or reach are looked at', () => {
      const f = build({ ...HELD, 'test-chest': 0 })
      f.surface.can_place_entity.mockReturnValueOnce(false)
      const result = validate(f, [{ entity_name: 'test-chest', x: 30.5, y: 0.5 }])
      expect(result).toMatchObject({ ok: false, planning_status: 'spatially_invalid', execution_eligible: false, error: { code: 'WORLD_COLLISION', index: 0 } })
      expect(result.eligibility_blockers).toBeUndefined()
    })

    it('marks an eligible layout spatially valid and executable, with its order and connection proofs', () => {
      const f = build()
      const result = validate(f, [INS, SRC], [FEED])
      expect(result).toMatchObject({ ok: true, planning_status: 'spatially_valid', execution_eligible: true, execution_order: [1, 0], placement_count: 2 })
      expect(result.connections[0].virtual_proof.pickup_point).toEqual({ x: 0.5, y: -0.5 })
      expect(result.connections[0].virtual_proof.drop_point.y).toBeCloseTo(1.7)
      expect((globalThis as any).storage.sgluna_validated_construction_plan.connections).toHaveLength(1)
    })

    it('leaves a plan without connections exactly as before: plan order, no layout, the plain start message', () => {
      const f = build()
      const placements = [{ entity_name: 'test-chest', x: 0.5, y: -0.5 }, { entity_name: 'test-pole', x: 4.5, y: 0.5 }]
      const validation = validate(f, placements)
      expect(validation).toMatchObject({ ok: true, planning_status: 'spatially_valid', execution_eligible: true, execution_order: [0, 1] })
      expect(validation.connections).toBeUndefined()
      expect(execute_validated_construction_plan(f.actor, validation.validation_id, 2, f.basic, f.manager)).toEqual([true, 'Validated construction plan started'])
      expect((globalThis as any).storage.sgluna_construction_layouts).toBeUndefined()
      expect(f.manager.player_state.parameters_place_entity?.layout_node).toBeUndefined()
    })
  })

  describe('virtual connection proof before placement (L3)', () => {
    it('accepts the inserter oriented from the chest into the existing boiler, and refuses a drop that misses it', () => {
      const f = build()
      expect(validate(f, [SRC, INS], [FEED])).toMatchObject({ ok: true })
      ;(globalThis as any).storage.sgluna_validated_construction_plan = undefined

      // The boiler is not under the drop point (0.5, 1.7): the inserter would drop on the ground.
      f.existing(501, { x: 0.5, y: 4 }, { x: 0.99, y: 0.99 })
      const result = validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 501 } }])
      expect(result).toMatchObject({
        ok: false,
        planning_status: 'spatially_invalid',
        error: { code: 'CONNECTION_GEOMETRY_MISMATCH', index: 0, kind: 'inserter', endpoint_role: 'drop' },
      })
      expect(result.error.predicted.drop_point.y).toBeCloseTo(1.7)
      expect(result.error.endpoint_box.left_top.y).toBeCloseTo(3.01)
      expect(result.validation_id).toBeUndefined()
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('rotates the inserter vectors by the placement direction (facing east picks up at +x and drops at -x)', () => {
      const f = build()
      const east = { ...INS, direction: 4 }
      const result = validate(f, [SRC, east], [FEED])
      expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTION_GEOMETRY_MISMATCH', endpoint_role: 'pickup' } })
      expect(result.error.predicted.pickup_point).toEqual({ x: 1.5, y: 0.5 })
    })

    it('refuses an inserter or drill endpoint without an item interface, existing or planned, before anything is built', () => {
      const f = build()
      // An existing wall exactly where the inserter drops: the geometry holds, the endpoint cannot take items.
      f.existing(600, { x: 0.5, y: 1.7 }, { x: 0.29, y: 0.29 }, { name: 'test-wall', type: 'wall', prototype: PROTOTYPES['test-wall'], ...item_interface(0) })
      const existing = validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 600 } }])
      expect(existing).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', endpoint_role: 'drop' } })
      expect(existing.validation_id).toBeUndefined()
      // A planned wall as the drill's receiver, on the output point.
      const planned = validate(f, [DRILL_AT, { entity_name: 'test-wall', x: 1.5, y: 0.5, slot: 'receiver' }], [OUTPUT])
      expect(planned).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', endpoint_role: 'receiver' } })
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
      // Interfaces that cannot be read are unproven, never assumed.
      f.existing(601, { x: 0.5, y: 1.7 }, { x: 0.29, y: 0.29 }, { get_max_inventory_index: () => { throw new Error('unreadable') }, get_max_transport_line_index: () => { throw new Error('unreadable') } })
      const unreadable = validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 601 } }])
      expect(unreadable).toMatchObject({ ok: false, planning_status: 'spatially_valid', execution_eligible: false })
      expect(unreadable.eligibility_blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONNECTION_UNPROVEN' })]))
    })

    it('honours the native automation flags by direction: no insertion into a pad, no removal from a locked chest', () => {
      const f = build()
      // The boiler's prototype forbids automated insertion (as 2.0.77's cargo-landing-pad does): it cannot be a drop endpoint.
      f.boiler.prototype = { ...EXISTING_PROTOTYPE, flags: { 'no-automated-item-insertion': true } }
      const drop = validate(f, [SRC, INS], [FEED])
      expect(drop).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', endpoint_role: 'drop' } })
      expect(drop.error.message).toContain('no-automated-item-insertion')
      // The same entity may be a pickup endpoint: taking from it is allowed.
      f.existing(700, { x: 0.5, y: -0.5 }, { x: 0.4, y: 0.4 }, { prototype: { ...EXISTING_PROTOTYPE, flags: { 'no-automated-item-insertion': true } } })
      f.boiler.prototype = EXISTING_PROTOTYPE
      expect(validate(f, [INS], [{ ...FEED, pickup: { unit_number: 700 } }])).toMatchObject({ ok: true, execution_eligible: true })
      // A planned chest whose prototype forbids automated removal cannot be a pickup endpoint.
      const locked = validate(f, [{ ...SRC, entity_name: 'test-locked-chest' }, INS], [FEED])
      expect(locked).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', endpoint_role: 'pickup' } })
      expect(locked.error.message).toContain('no-automated-item-removal')
      // Flags that cannot be read are unproven, never assumed permissive.
      f.boiler.prototype = { ...EXISTING_PROTOTYPE, get flags() { throw new Error('unreadable') } }
      const unreadable = validate(f, [SRC, INS], [FEED])
      expect(unreadable).toMatchObject({ ok: false, planning_status: 'spatially_valid', execution_eligible: false })
      expect(unreadable.eligibility_blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONNECTION_UNPROVEN' })]))
    })

    it('refuses an existing endpoint that is not an entity of this surface and force', () => {
      const f = build()
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 12345 } }])).toMatchObject({
        ok: false,
        planning_status: 'spatially_invalid',
        error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', index: 0, role: 'drop', unit_number: 12345 },
      })
      f.existing(502, { x: 0.5, y: 2 }, { x: 0.99, y: 0.99 }, { surface: { index: 2 } })
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 502 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE' } })
      f.existing(503, { x: 0.5, y: 2 }, { x: 0.99, y: 0.99 }, { force: { index: 2 } })
      expect(validate(f, [SRC, INS], [{ ...FEED, drop: { unit_number: 503 } }])).toMatchObject({ ok: false, error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE' } })
    })

    it('proves a pole by its supply area reaching the consumer, and refuses one that is too far', () => {
      const f = build()
      expect(validate(f, [LAB_AT, POLE_AT], [WIRE])).toMatchObject({ ok: true })
      const far = validate(f, [LAB_AT, { ...POLE_AT, x: 9.5 }], [WIRE])
      expect(far).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_GEOMETRY_MISMATCH', index: 0, kind: 'power', endpoint_role: 'consumer' } })
      expect(far.error.predicted.supply_area.left_top.x).toBeCloseTo(7)
    })

    it('refuses a power consumer without an electric energy source', () => {
      const f = build()
      const result = validate(f, [{ ...SRC, x: 4.5, y: 0.5, slot: 'lab' }, POLE_AT], [WIRE])
      expect(result).toMatchObject({ ok: false, error: { code: 'CONNECTION_GEOMETRY_MISMATCH', kind: 'power', endpoint_role: 'consumer' } })
      expect(result.error.message).toContain('no electric energy source')
    })

    it('proves a drill output by the output point lying inside the receiver, and refuses one outside it', () => {
      const f = build()
      const ok = validate(f, [RECEIVER_AT, DRILL_AT], [OUTPUT])
      expect(ok).toMatchObject({ ok: true, execution_order: [1, 0] })
      expect(ok.connections[0].virtual_proof.output_point.x).toBeCloseTo(1.5)
      expect(ok.connections[0].virtual_proof.output_point.y).toBeCloseTo(0.7)
      const outside = validate(f, [{ ...RECEIVER_AT, x: 3.5 }, DRILL_AT], [OUTPUT])
      expect(outside).toMatchObject({ ok: false, planning_status: 'spatially_invalid', error: { code: 'CONNECTION_GEOMETRY_MISMATCH', kind: 'drill_output', endpoint_role: 'receiver' } })
    })

    it('rejects malformed connections by index: unknown slot, wrong role, repeated slot, bad shape, caps', () => {
      const f = build({ ...HELD, 'test-chest': 20 })
      const code = (placements: any[], connections: any[]) => validate(f, placements, connections)
      expect(code([SRC, INS], [{ ...FEED, pickup: { slot: 'nope' } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      // A chest slot used as the inserter, a non-pole as the pole, a non-drill as the drill.
      expect(code([SRC, INS], [{ ...FEED, inserter: { slot: 'src' }, pickup: { slot: 'ins' } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      expect(code([LAB_AT, POLE_AT], [{ ...WIRE, pole: { slot: 'lab' }, consumer: { slot: 'pole' } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      expect(code([RECEIVER_AT, DRILL_AT], [{ ...OUTPUT, drill: { slot: 'receiver' }, receiver: { slot: 'drill' } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      // The second connection is the bad one.
      expect(code([SRC, INS], [FEED, { kind: 'bogus' }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 1 } })
      expect(code([SRC, INS], [{ ...FEED, drop: { slot: 'ins', unit_number: 5 } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      expect(code([SRC, INS], [{ ...FEED, drop: { unit_number: 0 } }])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', index: 0 } })
      expect(code([SRC, { ...INS, slot: 'src' }], [FEED])).toMatchObject({ ok: false, error: { code: 'INVALID_CONNECTION', slot: 'src', placement_index: 1 } })
      expect(code([{ ...SRC, slot: 'Bad Slot' }, INS], [FEED])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 0 } })
      expect(code([{ ...SRC, slot: 'x'.repeat(41) }, INS], [FEED])).toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 0 } })
      expect(code([SRC, INS], new Array(9).fill(FEED))).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      const seven = Array.from({ length: 7 }, (_, index) => ({ entity_name: 'test-chest', x: 0.5 + index, y: -3.5 }))
      expect(code([...seven.slice(0, 4), SRC, INS], [FEED])).toMatchObject({ ok: true })
      expect(code([...seven, SRC, INS], [FEED])).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      // Without connections the old limit still applies, not the layout cap.
      expect(code(seven, [])).toMatchObject({ ok: true })
    })
  })

  describe('deterministic dependency order', () => {
    it('builds the chest before the inserter, the lab before the pole and the drill before its receiver', () => {
      const f = build()
      expect(validate(f, [INS, SRC], [FEED]).execution_order).toEqual([1, 0])
      expect(validate(f, [POLE_AT, LAB_AT], [WIRE]).execution_order).toEqual([1, 0])
      expect(validate(f, [RECEIVER_AT, DRILL_AT], [OUTPUT]).execution_order).toEqual([1, 0])
    })

    it('breaks ties between independent nodes by prototype category, then plan index', () => {
      const f = build()
      // The pole depends on the lab; the inserter on the chest. Listed pole, inserter, chest, lab.
      const placements = [POLE_AT, INS, SRC, LAB_AT]
      const result = validate(f, placements, [FEED, WIRE])
      // Ready first: chest (0) and lab (0) by index (2, 3); then the inserter (1) before the pole (2).
      expect(result.execution_order).toEqual([2, 3, 1, 0])
    })

    it('refuses a dependency cycle as a spatial failure once the geometry holds', () => {
      // Inserters with a fuel inventory (as a burner inserter has) are item endpoints of each other.
      ;(globalThis as any).prototypes.entity['test-inserter'] = { ...PROTOTYPES['test-inserter'], inventories: 1, get_inventory_size: (index: number) => index === 1 ? 1 : undefined }
      const f = build()
      // ins at (0.5,0.5) picks up from (0.5,-0.5), where ins2 stands; ins2 faces south, so it picks up from (0.5,0.5), which is
      // ins, and drops at (0.5,-1.7) into the sink chest. Each inserter is the other's endpoint: neither can be built first.
      const ins2 = { entity_name: 'test-inserter', x: 0.5, y: -0.5, direction: 8, slot: 'ins2' }
      const sink = { entity_name: 'test-chest', x: 0.5, y: -1.5, slot: 'sink' }
      const wires = [
        { kind: 'inserter', inserter: { slot: 'ins2' }, pickup: { slot: 'ins' }, drop: { slot: 'sink' } },
        { kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'ins2' }, drop: { unit_number: BOILER_UNIT } },
      ]
      expect(validate(f, [INS, ins2, sink], wires)).toMatchObject({
        ok: false,
        planning_status: 'spatially_invalid',
        error: { code: 'LAYOUT_DEPENDENCY_CYCLE', indices: [0, 1] },
      })
    })
  })

  describe('execution: queueing and the layout record', () => {
    it('queues the placements in dependency order, each bound to its node, and records the layout', () => {
      const f = build()
      const { result, layout_id } = start(f, [INS, SRC], [FEED])
      expect(result[1]).toBe(`Validated construction plan started (layout_id ${layout_id})`)
      const queued = [f.manager.player_state.parameters_place_entity, ...(globalThis as any).storage.sgluna_task_execution.task_queue].filter(Boolean)
      expect(queued.map((task: any) => [task.entity_name, task.layout_node, task.refuse_clearance])).toEqual([
        ['test-chest', { layout_id, index: 1 }, true],
        ['test-inserter', { layout_id, index: 0 }, true],
      ])
      expect(layout(layout_id)).toMatchObject({
        layout_id,
        plan_id: 'layout',
        actor_id: 42,
        surface_index: 1,
        force_index: 1,
        created_tick: 100,
        state: 'running',
        production: 'not_asserted',
        duplicate_receipts: 0,
        nodes: [
          { node_id: `layout-${layout_id}:n0`, index: 0, slot: 'ins', entity_name: 'test-inserter', position: { x: 0.5, y: 0.5 }, direction: 0, execution_rank: 1, state: 'queued' },
          { node_id: `layout-${layout_id}:n1`, index: 1, slot: 'src', entity_name: 'test-chest', position: { x: 0.5, y: -0.5 }, direction: 0, execution_rank: 0, state: 'queued' },
        ],
        connections: [{ index: 0, kind: 'inserter', state: 'pending', endpoints: { inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { unit_number: BOILER_UNIT } } }],
      })
    })

    it('carries each row\'s execution rank at the witness while keeping plan index order', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      // The plan was consumed by execution; validate again for the witness.
      const again = validate(f, [INS, SRC], [FEED])
      const witness = construction_plan_preflight(f.actor, again.validation_id, 2) as any
      expect(witness.ok).toBe(true)
      expect(witness.construction_placements.map((row: any) => [row.entity_name, row.execution_rank])).toEqual([['test-inserter', 1], ['test-chest', 0]])
      expect(layout(layout_id).state).toBe('running')
    })

    it('never makes an ineligible layout executable: a stored token cannot be forged for a fluid connection', () => {
      const f = build()
      const pipes = [{ entity_name: 'test-pipe', x: 0.5, y: 0.5, slot: 'a' }, { entity_name: 'test-pipe', x: 1.5, y: 0.5, slot: 'b' }]
      ;(globalThis as any).storage.sgluna_validated_construction_plan = {
        validation_id: 7, plan_id: 'forged', actor_id: 42, surface_index: 1, force_index: 1, created_tick: 100, placements: pipes,
        connections: [{ index: 0, kind: 'fluid', endpoints: { from: { slot: 'a' }, to: { slot: 'b' } } }],
      }
      expect(construction_plan_preflight(f.actor, 7, 2)).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'CONNECTION_UNPROVEN' })
      expect(execute_validated_construction_plan(f.actor, 7, 2, f.basic, f.manager)).toEqual([false, 'validated construction plan became stale: CONNECTION_UNPROVEN'])
      expect(f.manager.get_status_snapshot().queue_length).toBe(0)
      expect((globalThis as any).storage.sgluna_construction_layouts).toBeUndefined()
    })
  })

  describe('node receipts (L3 execution)', () => {
    it('binds each placed unit once, verifies the inserter with its native targets and completes without asserting production', () => {
      const f = build()
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_target = f.created.find(other => other.name === 'test-chest')
          entity.drop_target = f.boiler
        }
      }
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'running', nodes: [{ state: 'queued' }, { state: 'placed', unit_number: 901, placed_tick: 100 }] })
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'complete',
        production: 'not_asserted',
        duplicate_receipts: 0,
        nodes: [{ state: 'placed', unit_number: 902 }, { state: 'placed', unit_number: 901 }],
        connections: [{ state: 'verified', observed: { pickup_unit_number: 901, drop_unit_number: BOILER_UNIT } }],
      })
      expect(layout(layout_id).pause_reason).toBeUndefined()
    })

    it('verifies an inserter whose native target fields are not set yet by the one entity on each native point', () => {
      const f = build()
      const pickupPoint = { x: 0.5, y: -0.5 }
      const dropPoint = { x: 0.5, y: 1.7 }
      const at = (filter: any, point: { x: number, y: number }) => filter?.position?.x === point.x && filter.position.y === point.y
      const character = { valid: true, unit_number: 1, type: 'character' }
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_position = pickupPoint
          entity.drop_position = dropPoint
        }
      }
      f.surface.find_entities_filtered.mockImplementation((filter: any) => {
        if (at(filter, pickupPoint)) return [character, f.created.find(other => other.name === 'test-chest')]
        if (at(filter, dropPoint)) return [f.boiler, f.created.find(other => other.name === 'test-inserter')]
        return []
      })
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'complete',
        connections: [{ state: 'verified', observed: { pickup_unit_number: 901, pickup_source: 'item_endpoint_at_point', drop_unit_number: BOILER_UNIT, drop_source: 'item_endpoint_at_point' } }],
      })
    })

    it('does not verify an inserter by its point when two entities stand on it', () => {
      const f = build()
      const dropPoint = { x: 0.5, y: 1.7 }
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_target = f.created.find(other => other.name === 'test-chest')
          entity.drop_position = dropPoint
        }
      }
      f.surface.find_entities_filtered.mockImplementation((filter: any) => filter?.position?.x === dropPoint.x && filter.position.y === dropPoint.y
        ? [f.boiler, { valid: true, unit_number: 4242, type: 'container', prototype: {}, ...item_interface(1) }]
        : [])
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', connections: [{ state: 'mismatch', observed: { drop_source: 'several_item_endpoints_at_point' } }] })
    })

    it('never verifies an inserter by an occupant of its point that has no item interface', () => {
      // The target fields are not set yet and the only entity on the drop point is a wall: occupancy is not a target.
      const f = build()
      const dropPoint = { x: 0.5, y: 1.7 }
      const wall = { valid: true, name: 'test-wall', unit_number: 4343, type: 'wall', ...item_interface(0) }
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_target = f.created.find(other => other.name === 'test-chest')
          entity.drop_position = dropPoint
        }
      }
      f.surface.find_entities_filtered.mockImplementation((filter: any) => filter?.position?.x === dropPoint.x && filter.position.y === dropPoint.y ? [wall] : [])
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'paused',
        connections: [{ state: 'mismatch', observed: { pickup_unit_number: 901, drop_unit_number: undefined, drop_source: 'no_item_endpoint_at_point', drop_ignored: [4343] } }],
      })

      // The same wall beside the boiler on the point is ignored, and the boiler is the one item endpoint there.
      const g = build()
      g.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_target = g.created.find(other => other.name === 'test-chest')
          entity.drop_position = dropPoint
        }
      }
      g.surface.find_entities_filtered.mockImplementation((filter: any) => filter?.position?.x === dropPoint.x && filter.position.y === dropPoint.y ? [wall, g.boiler] : [])
      const second = start(g, [INS, SRC], [FEED])
      expect(place_next(g)?.[0]).toBe(true)
      expect(place_next(g)?.[0]).toBe(true)
      expect(layout(second.layout_id)).toMatchObject({
        state: 'complete',
        connections: [{ state: 'verified', observed: { drop_unit_number: BOILER_UNIT, drop_source: 'item_endpoint_at_point', drop_ignored: [4343] } }],
      })
    })

    it('never verifies an inserter by an occupant of its pickup point that forbids automated removal', () => {
      const f = build()
      const pickupPoint = { x: 0.5, y: -0.5 }
      const locked = { valid: true, name: 'test-locked-chest', unit_number: 4444, type: 'container', prototype: PROTOTYPES['test-locked-chest'], ...item_interface(1) }
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_position = pickupPoint
          entity.drop_target = f.boiler
        }
      }
      f.surface.find_entities_filtered.mockImplementation((filter: any) => filter?.position?.x === pickupPoint.x && filter.position.y === pickupPoint.y ? [locked] : [])
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'paused',
        connections: [{ state: 'mismatch', observed: { pickup_unit_number: undefined, pickup_source: 'no_item_endpoint_at_point', pickup_ignored: [4444], drop_unit_number: BOILER_UNIT } }],
      })
    })

    it('refuses a node, before create_entity and without spending stock, once the actor is on another surface than its layout', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      const before = { ...f.held }
      ;(f.actor as any).surface = { ...f.surface, index: 2 }
      const cancelled = vi.spyOn(f.manager, 'cancel_all_tasks')
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'layout_connection_unproven', completed: false, layout_node: { layout_id, index: 0 } })
      expect(f.basic.status().last_result?.layout_refusal).toContain('belongs to actor 42 on surface 1 and force 1')
      expect(cancelled).toHaveBeenCalledWith('placing:layout_connection_unproven', expect.objectContaining({ failed_before_mutation: true }))
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      expect(f.held).toEqual(before)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', nodes: [{ state: 'queued' }, { state: 'placed' }] })
    })

    it('ignores a second receipt for a placed node, counts it and never rebinds', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      const duplicate: any = { valid: true, name: 'test-chest', unit_number: 777, position: { x: 0.5, y: -0.5 }, surface: f.surface, force: { index: 1 } }
      record_layout_node_placed(f.actor, { layout_id, index: 1 }, duplicate)
      record_layout_node_placed(f.actor, { layout_id, index: 1 }, duplicate)
      expect(layout(layout_id).nodes[1]).toMatchObject({ state: 'placed', unit_number: 901 })
      expect(layout(layout_id).duplicate_receipts).toBe(2)
    })

    it('pauses the layout when a placed inserter does not target its endpoints, and the next node refuses before any mutation', () => {
      const f = build()
      f.hooks.on_create = (entity) => {
        // The engine ended up dropping on the ground: no drop target.
        if (entity.name === 'test-inserter') entity.pickup_target = f.created.find(other => other.name === 'test-chest')
      }
      // The pole is the third node: it follows the inserter (category 2 after 1).
      const pole = { entity_name: 'test-pole', x: 3.5, y: 0.5, slot: 'pole' }
      const { layout_id } = start(f, [INS, SRC, pole], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'paused',
        connections: [{ state: 'mismatch', observed: { pickup_unit_number: 901 } }],
      })
      expect(layout(layout_id).pause_reason).toContain('connection 0 (inserter) does not hold')

      const cancelled = vi.spyOn(f.manager, 'cancel_all_tasks')
      const before = { ...f.held }
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'layout_connection_unproven', completed: false, layout_node: { layout_id, index: 2 } })
      expect(f.basic.status().last_result?.layout_refusal).toContain('is paused')
      expect(cancelled).toHaveBeenCalledWith('placing:layout_connection_unproven', expect.objectContaining({ failed_before_mutation: true }))
      expect(f.surface.create_entity).toHaveBeenCalledTimes(2)
      expect(f.held['test-pole']).toBe(before['test-pole'])
      expect(layout(layout_id).nodes[2].state).toBe('queued')
    })

    it('verifies a pole against its consumer by electric network id', () => {
      for (const [lab_network, pole_network, state] of [[7, 7, 'complete'], [7, 8, 'paused'], [undefined, 7, 'paused']] as const) {
        const f = build()
        f.hooks.on_create = (entity) => {
          if (entity.name === 'test-lab') entity.electric_network_id = lab_network
          if (entity.name === 'test-pole') entity.electric_network_id = pole_network
        }
        const { layout_id } = start(f, [POLE_AT, LAB_AT], [WIRE])
        expect(place_next(f)?.[0]).toBe(true)
        expect(place_next(f)?.[0]).toBe(true)
        expect(layout(layout_id).state).toBe(state)
        expect(layout(layout_id).connections[0].state).toBe(state === 'complete' ? 'verified' : 'mismatch')
        expect(layout(layout_id).production).toBe('not_asserted')
      }
    })

    it('verifies a drill against its receiver by the drill\'s drop target', () => {
      const f = build()
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-drill') entity.drop_position = { x: 1.5, y: 0.7 }
        if (entity.name === 'test-chest') f.created.find(other => other.name === 'test-drill').drop_target = entity
      }
      const { layout_id } = start(f, [RECEIVER_AT, DRILL_AT], [OUTPUT])
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id).state).toBe('running')
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'complete', connections: [{ state: 'verified', observed: { drop_unit_number: 902 } }] })
    })

    it('refuses the receiver, before create_entity, when the placed drill\'s actual output misses it', () => {
      const f = build()
      // The prediction held at validation but the placed drill drops elsewhere.
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-drill') entity.drop_position = { x: 5.5, y: 5.5 }
      }
      const { layout_id } = start(f, [RECEIVER_AT, DRILL_AT], [OUTPUT])
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id).state).toBe('running')
      const cancelled = vi.spyOn(f.manager, 'cancel_all_tasks')
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'layout_connection_unproven', layout_node: { layout_id, index: 0 } })
      expect(f.basic.status().last_result?.layout_refusal).toContain('drill output point is outside the receiver')
      expect(cancelled).toHaveBeenCalledWith('placing:layout_connection_unproven', expect.objectContaining({ failed_before_mutation: true }))
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', connections: [{ state: 'mismatch' }] })
    })

    it('refuses the inserter, before create_entity, when its existing endpoint disappeared after validation', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      f.boiler.valid = false
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'layout_connection_unproven' })
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      expect(layout(layout_id)).toMatchObject({ state: 'paused' })
    })

    it('refuses the inserter, before create_entity, when the placed chest is not under its pickup point', () => {
      const f = build()
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-chest') entity.bounding_box = { left_top: { x: 5.1, y: -0.4 }, right_bottom: { x: 5.9, y: 0.4 } }
      }
      const { layout_id } = start(f, [INS, SRC], [FEED])
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'layout_connection_unproven', layout_node: { layout_id, index: 0 } })
      expect(f.basic.status().last_result?.layout_refusal).toContain('inserter pickup point is outside the pickup endpoint')
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      expect(layout(layout_id).connections[0]).toMatchObject({ state: 'mismatch' })
    })

    it('pauses the layout when one of its nodes fails for any other reason, keeping that reason', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      f.surface.can_place_entity.mockReturnValue(false)
      expect(place_next(f)?.[0]).toBe(false)
      expect(f.basic.status().last_result).toMatchObject({ code: 'construction_plan_blocked_no_clear' })
      expect(layout(layout_id)).toMatchObject({ state: 'paused', pause_reason: 'node 1 failed: construction_plan_blocked_no_clear' })
    })

    it('does not leave a record or a queue behind when admission of a placement fails', () => {
      const f = build()
      const validation = validate(f, [INS, SRC], [FEED])
      const submit = vi.spyOn(f.basic, 'submit_placement').mockReturnValueOnce(true).mockReturnValueOnce(false)
      expect(execute_validated_construction_plan(f.actor, validation.validation_id, 2, f.basic, f.manager)).toEqual([false, 'unable to queue placement 2'])
      // Both submissions were bound to their nodes, in dependency order (the chest, plan index 1, first).
      expect(submit.mock.calls.map(call => [call[0], call[7]])).toEqual([
        ['test-chest', { refuse_clearance: true, layout_node: { layout_id: validation.validation_id, index: 1 } }],
        ['test-inserter', { refuse_clearance: true, layout_node: { layout_id: validation.validation_id, index: 0 } }],
      ])
      expect((globalThis as any).storage.sgluna_construction_layouts?.[validation.validation_id]).toBeUndefined()
    })
  })

  describe('layout records', () => {
    it('serves the stored record read-only through construction_layout_status', () => {
      const f = build()
      const { layout_id } = start(f, [INS, SRC], [FEED])
      const before = JSON.stringify((globalThis as any).storage)
      expect(construction_layout_status(layout_id)).toMatchObject({ ok: true, layout: { layout_id, state: 'running', production: 'not_asserted' } })
      expect(construction_layout_status(layout_id + 1)).toMatchObject({ ok: false, error: { code: 'LAYOUT_UNAVAILABLE' } })
      expect(construction_layout_status('1')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(construction_layout_status(0)).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })
      expect(JSON.stringify((globalThis as any).storage)).toBe(before)
    })

    it('keeps at most 32 records, dropping the oldest complete ones first', () => {
      const f = build()
      const record = (layout_id: number, state: 'running' | 'complete' | 'paused') => {
        const created = create_layout_record({
          layout_id,
          plan_id: `p${layout_id}`,
          actor_id: 42,
          surface_index: 1,
          force_index: 1,
          placements: [{ entity_name: 'test-chest', x: 0.5, y: 0.5 }],
          footprints: [{ position: { x: 0.5, y: 0.5 }, direction: 0 }],
          execution_order: [0],
          connections: [],
        })
        created.state = state
      }
      record(1, 'paused')
      for (let id = 2; id <= 32; id++) record(id, 'complete')
      expect(Object.keys((globalThis as any).storage.sgluna_construction_layouts)).toHaveLength(32)
      record(33, 'running')
      const ids = Object.keys((globalThis as any).storage.sgluna_construction_layouts).map(Number).sort((a, b) => a - b)
      expect(ids).toHaveLength(32)
      // The paused record 1 survives while complete ones exist; the oldest complete (2) went.
      expect(ids[0]).toBe(1)
      expect(ids).not.toContain(2)
      expect(ids).toContain(33)

      // Nothing complete left: the oldest record of any state goes, so the table still stays bounded.
      for (const id of ids) (globalThis as any).storage.sgluna_construction_layouts[id].state = 'running'
      record(34, 'running')
      const after = Object.keys((globalThis as any).storage.sgluna_construction_layouts).map(Number)
      expect(after).toHaveLength(32)
      expect(after).not.toContain(1)
    })
  })

  // Milestone 4, acceptance L4 and L5: an execution that ends early is settled node by node, only the proven remainder is
  // validated and built (on the same record, within a fixed allowance), and an expired or superseded token never reaches or
  // erases what was admitted.
  describe('settling and resuming an interrupted layout (milestone 4 L4/L5)', () => {
    // A chest feeds an inserter that drops into a second chest. Dependency order: src, dst, ins (plan indices 0, 2, 1).
    const DST = { entity_name: 'test-chest', x: 0.5, y: 1.5, slot: 'dst' }
    const CHAIN = { kind: 'inserter' as const, inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { slot: 'dst' } }
    const PLAN = [SRC, INS, DST]

    function wire(f: World) {
      f.hooks.on_create = (entity) => {
        if (entity.name === 'test-inserter') {
          entity.pickup_target = f.created.find(other => other.name === 'test-chest' && other.position.y === -0.5)
          entity.drop_target = f.created.find(other => other.name === 'test-chest' && other.position.y === 1.5)
        }
      }
    }

    // Executes the plan, builds its first node, then the engine cancels everything that is queued.
    function interrupted(f: World) {
      wire(f)
      const started = start(f, PLAN, [CHAIN])
      expect(place_next(f)?.[0]).toBe(true)
      f.manager.cancel_all_tasks('test_cancel')
      return started
    }

    function resume(f: World, layout_id: number) {
      return resume_construction_layout(f.actor, layout_id) as any
    }

    function execute(f: World, validation: any) {
      return execute_validated_construction_plan(f.actor, validation.validation_id, validation.placement_count, f.basic, f.manager)
    }

    function stored() {
      return JSON.stringify((globalThis as any).storage.sgluna_construction_layouts)
    }

    it('settles an interrupted layout, keeps the placed node and resumes only the proven remainder on the same record', () => {
      const f = build()
      wire(f)
      const { layout_id } = start(f, PLAN, [CHAIN])
      expect(layout(layout_id)).toMatchObject({ state: 'running', executions_used: 1, executions_max: 3, executions: [{ number: 1, queued_nodes: [0, 2, 1] }] })
      expect(layout(layout_id).executions[0].batch_ref).toBeDefined()
      // Its placement tasks are still the open batch: nothing is settled and nothing may resume.
      expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({ ok: true, layout: { state: 'running', nodes: [{ state: 'queued' }, { state: 'queued' }, { state: 'queued' }] } })
      expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_EXECUTION_PENDING' } })

      expect(place_next(f)?.[0]).toBe(true)
      f.manager.cancel_all_tasks('test_cancel')
      const status: any = construction_layout_status(layout_id, { actor: f.actor })
      expect(status.layout).toMatchObject({
        state: 'paused',
        pause_reason: 'remainder_unplaced',
        nodes: [{ state: 'placed', unit_number: 901 }, { state: 'not_placed' }, { state: 'not_placed' }],
        executions: [{ settled: { placed: [0], not_placed: [2, 1] } }],
      })
      // Reading again settles nothing new.
      const settled_json = stored()
      construction_layout_status(layout_id, { actor: f.actor })
      expect(stored()).toBe(settled_json)

      const submit = vi.spyOn(f.basic, 'submit_placement')
      const validation = resume(f, layout_id)
      expect(validation).toMatchObject({
        ok: true,
        layout_id,
        placement_count: 2,
        executions_used: 1,
        retained: [{ node_id: `layout-${layout_id}:n0`, entity_name: 'test-chest', unit_number: 901 }],
        remainder: [`layout-${layout_id}:n2`, `layout-${layout_id}:n1`],
        placements: [{ entity_name: 'test-chest', x: 0.5, y: 1.5, slot: 'dst' }, { entity_name: 'test-inserter', x: 0.5, y: 0.5, direction: 0, slot: 'ins' }],
      })
      // The placed chest is an existing endpoint of the connection now, by its unit_number; validating leaves the record alone.
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toMatchObject({
        resume_layout_id: layout_id,
        resume_node_indices: [2, 1],
        connections: [{ kind: 'inserter', endpoints: { inserter: { slot: 'ins' }, pickup: { unit_number: 901 }, drop: { slot: 'dst' } } }],
      })
      expect(stored()).toBe(settled_json)
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)

      expect(execute(f, validation)).toEqual([true, `Validated construction plan started (layout_id ${layout_id})`])
      // The same record continues: one more execution, the original node indices, and the retained node is never queued again.
      expect(Object.keys((globalThis as any).storage.sgluna_construction_layouts)).toEqual([String(layout_id)])
      expect(submit.mock.calls.map(call => [call[0], call[7]])).toEqual([
        ['test-chest', { refuse_clearance: true, layout_node: { layout_id, index: 2 } }],
        ['test-inserter', { refuse_clearance: true, layout_node: { layout_id, index: 1 } }],
      ])
      expect(layout(layout_id)).toMatchObject({
        state: 'running',
        executions_used: 2,
        executions: [{ number: 1 }, { number: 2, queued_nodes: [2, 1] }],
        nodes: [{ state: 'placed', unit_number: 901 }, { state: 'queued' }, { state: 'queued' }],
      })
      expect(layout(layout_id).executions[1].batch_ref).toBeDefined()
      expect(layout(layout_id).pause_reason).toBeUndefined()

      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({
        state: 'complete',
        connections: [{ state: 'verified' }],
        nodes: [{ state: 'placed', unit_number: 901 }, { state: 'placed', unit_number: 903 }, { state: 'placed', unit_number: 902 }],
      })
      // Node 1 was built once; stock was spent once per node.
      expect(f.created.filter(entity => entity.name === 'test-chest' && entity.position.y === -0.5)).toHaveLength(1)
      expect(f.surface.create_entity).toHaveBeenCalledTimes(3)
      expect(f.held['test-chest']).toBe(1)
      expect(f.held['test-inserter']).toBe(0)
      expect(layout(layout_id).production).toBe('not_asserted')
    })

    it('settles a layout cancelled before any node was built and resumes all of it', () => {
      const f = build()
      wire(f)
      const { layout_id } = start(f, PLAN, [CHAIN])
      f.manager.cancel_all_tasks('test_cancel')
      const validation = resume(f, layout_id)
      expect(validation).toMatchObject({ ok: true, placement_count: 3, retained: [], remainder: [`layout-${layout_id}:n0`, `layout-${layout_id}:n2`, `layout-${layout_id}:n1`] })
      expect(execute(f, validation)[0]).toBe(true)
      for (let i = 0; i < 3; i++) expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'complete', executions_used: 2 })
    })

    it('settles when another batch is open, not only when its own was cancelled', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      f.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 600 })
      expect(f.manager.get_status_snapshot().active_batch).toBeDefined()
      expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({ layout: { state: 'paused', nodes: [{ state: 'placed' }, { state: 'not_placed' }, { state: 'not_placed' }] } })
    })

    it('settles after a restart: the record survives, the queue and the old batch generation do not', () => {
      const f = build()
      wire(f)
      const { layout_id } = start(f, PLAN, [CHAIN])
      expect(place_next(f)?.[0]).toBe(true)
      expect(f.manager.reconcile_startup('restart-2')).toMatchObject({ ok: true, reconciled: true })
      expect(f.manager.get_status_snapshot().active_batch).toBeUndefined()
      expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({
        layout: { state: 'paused', pause_reason: 'remainder_unplaced', nodes: [{ state: 'placed', unit_number: 901 }, { state: 'not_placed' }, { state: 'not_placed' }] },
      })
      const validation = resume(f, layout_id)
      expect(validation).toMatchObject({ ok: true, placement_count: 2 })
      expect(execute(f, validation)[0]).toBe(true)
      expect(layout(layout_id).executions[1]).toMatchObject({ number: 2, batch_generation: 2 })
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'complete', nodes: [{ unit_number: 901 }, { state: 'placed' }, { state: 'placed' }] })
    })

    it('spends a fixed allowance of three executions and refuses the fourth', () => {
      const f = build()
      wire(f)
      const { layout_id } = start(f, PLAN, [CHAIN])
      f.manager.cancel_all_tasks('test_cancel')
      for (const used of [2, 3]) {
        const validation = resume(f, layout_id)
        expect(validation).toMatchObject({ ok: true, placement_count: 3, executions_used: used - 1, executions_max: 3 })
        expect(execute(f, validation)[0]).toBe(true)
        expect(layout(layout_id)).toMatchObject({ executions_used: used, executions_max: 3, state: 'running' })
        f.manager.cancel_all_tasks('test_cancel')
      }
      construction_layout_status(layout_id, { actor: f.actor })
      const before = stored()
      expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_ALLOWANCE_EXHAUSTED' } })
      expect(stored()).toBe(before)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', executions_used: 3, executions_max: 3 })
      expect(f.surface.create_entity).not.toHaveBeenCalled()
    })

    it('refuses a token whose layout used its allowance after it was validated', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      const validation = resume(f, layout_id)
      expect(validation.ok).toBe(true)
      layout(layout_id).executions_used = 3
      expect(construction_plan_preflight(f.actor, validation.validation_id, validation.placement_count)).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'LAYOUT_ALLOWANCE_EXHAUSTED' })
      const before = stored()
      expect(execute(f, validation)).toEqual([false, expect.stringContaining('LAYOUT_ALLOWANCE_EXHAUSTED')])
      expect(stored()).toBe(before)
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('never replays a completed node that was removed: the resume is refused and nothing is rebuilt', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      f.by_unit.get(901).valid = false
      expect(resume(f, layout_id)).toMatchObject({ ok: false, layout_state: 'paused', error: { code: 'LAYOUT_COMPLETED_NODE_MISSING' } })
      expect(layout(layout_id)).toMatchObject({
        state: 'paused',
        nodes: [{ state: 'missing', unit_number: 901 }, { state: 'not_placed' }, { state: 'not_placed' }],
      })
      expect(layout(layout_id).pause_reason).toContain('completed_node_missing')
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      // A late receipt for the missing node does not rebind it.
      const late: any = { valid: true, name: 'test-chest', unit_number: 4000, position: { x: 0.5, y: -0.5 }, surface: f.surface, force: { index: 1 } }
      record_layout_node_placed(f.actor, { layout_id, index: 0 }, late)
      expect(layout(layout_id).nodes[0]).toMatchObject({ state: 'missing', unit_number: 901 })
    })

    it('refuses a token when a completed node disappears after the remainder was validated', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      const validation = resume(f, layout_id)
      expect(validation.ok).toBe(true)
      f.by_unit.get(901).valid = false
      expect(execute(f, validation)).toEqual([false, expect.stringContaining('LAYOUT_COMPLETED_NODE_MISSING')])
      // The record keeps the completed node, now marked missing, and the not-placed remainder: nothing is erased.
      expect(layout(layout_id)).toMatchObject({ executions_used: 1, nodes: [{ state: 'missing', unit_number: 901 }, { state: 'not_placed' }, { state: 'not_placed' }] })
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
    })

    it('refuses to resume an unknown, foreign, complete or mismatched layout', () => {
      const f = build()
      expect(resume(f, 999)).toMatchObject({ ok: false, error: { code: 'LAYOUT_UNAVAILABLE' } })
      expect(resume_construction_layout(f.actor, '1')).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } })

      // Another actor or surface never resumes it, and the refusal settles nothing.
      const { layout_id } = interrupted(f)
      const before = stored()
      const snapshot = (f.actor as any).status_snapshot
      ;(f.actor as any).status_snapshot = () => ({ ...snapshot(), actor_id: 43 })
      expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_SCOPE_MISMATCH' } })
      ;(f.actor as any).status_snapshot = snapshot
      ;(f.actor as any).surface = { ...f.surface, index: 2 }
      expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_SCOPE_MISMATCH' } })
      ;(f.actor as any).surface = f.surface
      expect(stored()).toBe(before)

      const done = build()
      wire(done)
      const finished = start(done, PLAN, [CHAIN])
      for (let i = 0; i < 3; i++) expect(place_next(done)?.[0]).toBe(true)
      expect(layout(finished.layout_id).state).toBe('complete')
      expect(resume(done, finished.layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_COMPLETE' } })

      // Every node placed but the inserter does not target its endpoints: the connection does not hold, and nothing replays.
      const bad = build()
      const mismatched = start(bad, PLAN, [CHAIN])
      for (let i = 0; i < 3; i++) expect(place_next(bad)?.[0]).toBe(true)
      expect(layout(mismatched.layout_id)).toMatchObject({ state: 'paused', connections: [{ state: 'mismatch' }] })
      expect(resume(bad, mismatched.layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_CONNECTION_MISMATCH' } })
      expect(bad.surface.create_entity).toHaveBeenCalledTimes(3)
    })

    it('reports a remainder it cannot run now as eligibility blockers and stores no token', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      f.held['test-inserter'] = 0
      const blocked = resume(f, layout_id)
      expect(blocked).toMatchObject({
        ok: false,
        layout_id,
        planning_status: 'spatially_valid',
        execution_eligible: false,
        eligibility_blockers: [{ code: 'ITEMS_MISSING', item_name: 'test-inserter' }],
        retained: [{ unit_number: 901 }],
        remainder: [`layout-${layout_id}:n2`, `layout-${layout_id}:n1`],
      })
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
      expect(layout(layout_id).executions_used).toBe(1)
    })

    it('rejects an expired token before admission and leaves the partially completed layout intact', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      const validation = resume(f, layout_id)
      const before = stored()
      ;(globalThis as any).game.tick += 3601
      expect(construction_plan_preflight(f.actor, validation.validation_id, validation.placement_count)).toMatchObject({ ok: false, code: 'construction_plan_expired' })
      expect(execute(f, validation)).toEqual([false, 'validated construction plan expired; validate the live world again'])
      // Completed nodes and their receipts stay; the remainder needs a fresh validation of the remainder only.
      expect(stored()).toBe(before)
      expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      const fresh = resume(f, layout_id)
      expect(fresh).toMatchObject({ ok: true, placement_count: 2 })
      expect(execute(f, fresh)[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id)).toMatchObject({ state: 'complete', nodes: [{ unit_number: 901 }, { state: 'placed' }, { state: 'placed' }] })
    })

    it('rejects a superseded resume token, and a newer validation of another plan never alters the layout record', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      const first = resume(f, layout_id)
      const second = resume(f, layout_id)
      expect(second.validation_id).toBeGreaterThan(first.validation_id)
      const before = stored()
      expect(execute(f, first)).toEqual([false, 'validated construction plan is unavailable or superseded'])
      expect(stored()).toBe(before)

      // An unrelated plan validated meanwhile replaces the stored token and touches no layout.
      const other = validate(f, [{ entity_name: 'test-chest', x: 6.5, y: 6.5 }], undefined, 'unrelated')
      expect(other.ok).toBe(true)
      expect(stored()).toBe(before)
      expect(execute(f, second)).toEqual([false, 'validated construction plan is unavailable or superseded'])
      expect(stored()).toBe(before)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', nodes: [{ state: 'placed', unit_number: 901 }, { state: 'not_placed' }, { state: 'not_placed' }] })

      // The remainder is validated again and still completes the original layout.
      const third = resume(f, layout_id)
      expect(execute(f, third)[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id).state).toBe('complete')
    })

    it('restores a resumed layout to paused when its placements cannot be queued', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      const validation = resume(f, layout_id)
      const before = stored()
      vi.spyOn(f.basic, 'submit_placement').mockReturnValueOnce(true).mockReturnValueOnce(false)
      expect(execute(f, validation)).toEqual([false, 'unable to queue placement 2'])
      expect(stored()).toBe(before)
      expect(layout(layout_id)).toMatchObject({ state: 'paused', pause_reason: 'remainder_unplaced', executions_used: 1 })
      expect(layout(layout_id).executions).toHaveLength(1)
      expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    })

    it('counts a second receipt for a node bound after a resume, and never binds a node whose execution ended', () => {
      const f = build()
      const { layout_id } = interrupted(f)
      // A receipt for a node that was settled as not placed is stale: it neither binds nor changes the node.
      construction_layout_status(layout_id, { actor: f.actor })
      const stale: any = { valid: true, name: 'test-inserter', unit_number: 5000, position: { x: 0.5, y: 0.5 }, surface: f.surface, force: { index: 1 } }
      record_layout_node_placed(f.actor, { layout_id, index: 1 }, stale)
      expect(layout(layout_id).nodes[1]).toMatchObject({ state: 'not_placed' })
      expect(layout(layout_id).nodes[1].unit_number).toBeUndefined()
      expect(layout(layout_id).duplicate_receipts).toBe(1)

      expect(execute(f, resume(f, layout_id))[0]).toBe(true)
      expect(place_next(f)?.[0]).toBe(true)
      const duplicate: any = { valid: true, name: 'test-chest', unit_number: 777, position: { x: 0.5, y: 1.5 }, surface: f.surface, force: { index: 1 } }
      record_layout_node_placed(f.actor, { layout_id, index: 2 }, duplicate)
      record_layout_node_placed(f.actor, { layout_id, index: 0 }, duplicate)
      expect(layout(layout_id).nodes[2]).toMatchObject({ state: 'placed', unit_number: 902 })
      expect(layout(layout_id).nodes[0]).toMatchObject({ state: 'placed', unit_number: 901 })
      expect(layout(layout_id).duplicate_receipts).toBe(3)
      expect(place_next(f)?.[0]).toBe(true)
      expect(layout(layout_id).state).toBe('complete')
    })

    // Milestone 4 L4, retained parts: what a pause leaves standing is read again before the layout resumes or completes.
    describe('retained nodes and verified connections', () => {
      // The chest, inserter and second chest of CHAIN, powered by a pole that is built last.
      const POLE = { entity_name: 'test-pole', x: 2.5, y: 0.5, slot: 'pole' }
      const POWER = { kind: 'power' as const, pole: { slot: 'pole' }, consumer: { slot: 'ins' } }
      const LAYOUT = [SRC, INS, DST, POLE]

      function powered(f: World) {
        f.hooks.on_create = (entity) => {
          if (entity.name === 'test-inserter') {
            entity.pickup_target = f.created.find(other => other.name === 'test-chest' && other.position.y === -0.5)
            entity.drop_target = f.created.find(other => other.name === 'test-chest' && other.position.y === 1.5)
            entity.electric_network_id = 7
          }
          if (entity.name === 'test-pole') entity.electric_network_id = 7
        }
      }

      // The item connection is built and verified; the engine cancels before the power pole.
      function cancelled_before_pole(f: World) {
        powered(f)
        const started = start(f, LAYOUT, [CHAIN, POWER])
        for (let i = 0; i < 3; i++) expect(place_next(f)?.[0]).toBe(true)
        f.manager.cancel_all_tasks('test_cancel')
        expect(layout(started.layout_id)).toMatchObject({ connections: [{ state: 'verified' }, { state: 'pending' }] })
        const inserter = f.created.find(entity => entity.name === 'test-inserter')
        return { ...started, inserter }
      }

      it('records what each placed entity reported when it was bound', () => {
        const f = build()
        const { layout_id } = cancelled_before_pole(f)
        const reported = layout(layout_id).nodes.filter((node: any) => node.state === 'placed').map((node: any) => [node.slot, node.placed_position, node.placed_direction])
        expect(reported).toEqual([
          ['src', { x: 0.5, y: -0.5 }, 0], ['ins', { x: 0.5, y: 0.5 }, 0], ['dst', { x: 0.5, y: 1.5 }, 0],
        ])
      })

      it('pauses and refuses a resume when a retained inserter was turned during the pause, and resumes once it is restored', () => {
        const f = build()
        const { layout_id, inserter } = cancelled_before_pole(f)
        inserter.direction = 8
        const status: any = construction_layout_status(layout_id, { actor: f.actor })
        expect(status.layout).toMatchObject({ state: 'paused', pause_reason: `retained_node_changed: layout-${layout_id}:n1`, retained_problem: `retained_node_changed: layout-${layout_id}:n1` })
        expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_RETAINED_NODE_CHANGED' } })
        expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
        expect(f.surface.create_entity).toHaveBeenCalledTimes(3)
        expect(layout(layout_id).nodes[1]).toMatchObject({ state: 'placed', unit_number: 903 })

        // Restored as it was built, the retained part holds again and only the pole remains.
        inserter.direction = 0
        const validation = resume(f, layout_id)
        expect(validation).toMatchObject({ ok: true, placement_count: 1, remainder: [`layout-${layout_id}:n3`] })
        expect(layout(layout_id)).toMatchObject({ state: 'paused', pause_reason: 'remainder_unplaced' })
        expect(layout(layout_id).retained_problem).toBeUndefined()
        expect(execute(f, validation)[0]).toBe(true)
        expect(place_next(f)?.[0]).toBe(true)
        expect(layout(layout_id)).toMatchObject({ state: 'complete', connections: [{ state: 'verified' }, { state: 'verified' }] })
        expect(f.surface.create_entity).toHaveBeenCalledTimes(4)
      })

      it('pauses and refuses a resume when a retained node moved or became another prototype', () => {
        const moved = build()
        const first = cancelled_before_pole(moved)
        moved.created.find(entity => entity.name === 'test-chest').position = { x: 3.5, y: -0.5 }
        expect(resume(moved, first.layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_RETAINED_NODE_CHANGED' } })
        expect(layout(first.layout_id).pause_reason).toBe(`retained_node_changed: layout-${first.layout_id}:n0`)

        const renamed = build()
        const second = cancelled_before_pole(renamed)
        renamed.created.find(entity => entity.name === 'test-chest').name = 'test-locked-chest'
        expect(resume(renamed, second.layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_RETAINED_NODE_CHANGED' } })
        expect(renamed.surface.create_entity).toHaveBeenCalledTimes(3)
      })

      it('pauses and refuses a resume when a verified connection no longer holds on the retained entities', () => {
        const f = build()
        const { layout_id, inserter } = cancelled_before_pole(f)
        const target = inserter.pickup_target
        inserter.pickup_target = undefined
        const status: any = construction_layout_status(layout_id, { actor: f.actor })
        expect(status.layout.state).toBe('paused')
        expect(status.layout.pause_reason).toContain('connection_no_longer_verified: 0 (inserter)')
        expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_CONNECTION_NO_LONGER_VERIFIED' } })
        expect(f.surface.create_entity).toHaveBeenCalledTimes(3)
        inserter.pickup_target = target
        expect(resume(f, layout_id)).toMatchObject({ ok: true, placement_count: 1 })
      })

      it('refuses a token whose retained inserter was turned after the remainder was validated', () => {
        const f = build()
        const { layout_id, inserter } = cancelled_before_pole(f)
        const validation = resume(f, layout_id)
        expect(validation.ok).toBe(true)
        inserter.direction = 12
        expect(execute(f, validation)).toEqual([false, expect.stringContaining('LAYOUT_RETAINED_NODE_CHANGED')])
        expect(f.surface.create_entity).toHaveBeenCalledTimes(3)
        expect(layout(layout_id)).toMatchObject({ state: 'paused', executions_used: 1 })
      })

      it('never completes a layout whose retained node was changed while its last node was being built', () => {
        const f = build()
        const { layout_id, inserter } = cancelled_before_pole(f)
        expect(execute(f, resume(f, layout_id))[0]).toBe(true)
        inserter.direction = 4
        expect(place_next(f)?.[0]).toBe(true)
        expect(layout(layout_id)).toMatchObject({ state: 'paused', retained_problem: `retained_node_changed: layout-${layout_id}:n1` })
        expect(layout(layout_id).nodes[3]).toMatchObject({ state: 'placed' })
        expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_RETAINED_NODE_CHANGED' } })
        // Restored, the settlement lifts its own pause and the layout completes: nothing was rebuilt.
        inserter.direction = 0
        expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({ layout: { state: 'complete' } })
        expect(f.surface.create_entity).toHaveBeenCalledTimes(4)
      })
    })

    describe('admission settlement', () => {
      const KEY = 'request/execute'
      const identity = { operation_key: KEY, attempt_id: 'attempt-1', actor_id: 42, epoch: 3, signature: 'sig-1', ordinal: 1, operation_count: 1 }

      beforeEach(() => {
        ;(globalThis as any).log = vi.fn()
        ;(globalThis as any).remote = { interfaces: { sgluna_deployment: { authorize: true } }, call: vi.fn((_name: string, _method: string, epoch: number) => epoch === 3) }
      })

      function admitted(f: World) {
        wire(f)
        const admission = new_operation_admission(() => f.actor, () => f.manager.get_status_snapshot() as any)
        expect(admission.begin(identity).ok).toBe(true)
        const started = start(f, PLAN, [CHAIN])
        const active: any = f.manager.get_status_snapshot().active_batch
        const ref = { batch_id: active.batch_id, batch_generation: active.batch_generation, batch_ref: active.batch_ref }
        expect(admission.slot(KEY, 1, { ok: true, operation: 'execute_construction_plan', batch_refs: [ref] }).ok).toBe(true)
        expect(admission.finish(KEY, { ok: true }).record?.state).toBe('admitted')
        return { admission, layout_id: started.layout_id }
      }

      it('settles a cancelled layout execution as partial with the exact placed and unplaced node ids, never completed', () => {
        const f = build()
        const { admission, layout_id } = admitted(f)
        expect(admission.status().records[0].state).toBe('admitted')
        expect(place_next(f)?.[0]).toBe(true)
        f.manager.cancel_all_tasks('test_cancel')
        expect(admission.status().records[0]).toMatchObject({
          state: 'partial',
          ok: false,
          error: 'exact_construction_layout_partial',
          layout_id,
          placed_node_ids: [`layout-${layout_id}:n0`],
          not_placed_node_ids: [`layout-${layout_id}:n2`, `layout-${layout_id}:n1`],
        })
        // Settlement closes the record's execution; the layout then reads as paused with its remainder.
        expect(layout(layout_id)).toMatchObject({ executions: [{ settled: { placed: [0], not_placed: [2, 1] } }] })
        expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({ layout: { state: 'paused', pause_reason: 'remainder_unplaced' } })

        // The partial classification was sealed when the closing receipt was retained, so it outlives that receipt.
        expect((globalThis as any).storage.sgluna_operation_admissions[0]).toMatchObject({ state: 'partial', error: 'exact_construction_layout_partial', layout_id })
        expect(pinned_operation_batch_refs()).toEqual([])
        ;(globalThis as any).storage.sgluna_task_receipt_journal.length = 0
        expect(admission.status().records[0]).toMatchObject({ state: 'partial', placed_node_ids: ['layout-1:n0'] })
        expect(admission.status().records[0].layout_receipt).toMatchObject({ state: 'cancelled', reason: 'test_cancel', task_count: 3, task_types: ['placing', 'placing', 'placing'], batch_generation: 1 })
      })

      it('completes the admission only when the batch really completed with every node placed', () => {
        const f = build()
        const { admission, layout_id } = admitted(f)
        for (let i = 0; i < 3; i++) expect(place_next(f)?.[0]).toBe(true)
        expect(layout(layout_id).state).toBe('complete')
        expect(admission.status().records[0]).toMatchObject({ state: 'completed' })
      })

      // The row a restart seals, as the runtime reconciler is given it (construction-layout-partial.test.mjs carries the same
      // literal for its historical case).
      const RESTART_ROW = {
        state: 'partial',
        ok: false,
        error: 'exact_construction_layout_partial',
        generation: 1,
        layout_id: 1,
        placed_node_ids: ['layout-1:n0'],
        not_placed_node_ids: ['layout-1:n2', 'layout-1:n1'],
        layout_receipt: { batch_ref: 'batch-g1-1', batch_id: 1, batch_generation: 1, state: 'uncertain', reason: 'save_load_unfinished', tick: 100, task_count: 3, task_types: ['placing', 'placing', 'placing'] },
      }
      const SECOND = { operation_key: 'request/resume', attempt_id: 'attempt-2', actor_id: 42, epoch: 3, signature: 'sig-2', ordinal: 2, operation_count: 1 }

      it('settles an admission across a restart from durable node evidence, then runs only a freshly validated remainder through admission', () => {
        const f = build()
        const { admission, layout_id } = admitted(f)
        expect(place_next(f)?.[0]).toBe(true)
        // The save is loaded with the batch unfinished: startup retires it as an uncertain receipt and advances the generation.
        expect(f.manager.reconcile_startup('restart-2')).toMatchObject({ ok: true, reconciled: true, batch_generation: 2 })
        expect(f.manager.get_status_snapshot().receipt_journal[0]).toMatchObject({ state: 'uncertain', reason: 'save_load_unfinished', batch_generation: 1 })
        expect(admission.status().records[0]).toMatchObject(RESTART_ROW)
        expect(admission.status().records[0].layout_receipt).toEqual(RESTART_ROW.layout_receipt)
        expect(admission.status().records[0].missing_node_ids).toBeUndefined()

        // The next admission reconciles the journal and seals the row; it is no longer unresolved.
        expect(admission.begin(SECOND).ok).toBe(true)
        expect((globalThis as any).storage.sgluna_operation_admissions[0]).toMatchObject(RESTART_ROW)
        expect(layout(layout_id)).toMatchObject({ executions: [{ settled: { placed: [0], not_placed: [2, 1] } }] })

        // Only a freshly validated remainder runs: the chest built before the restart is retained, never rebuilt.
        const validation = resume(f, layout_id)
        expect(validation).toMatchObject({ ok: true, placement_count: 2, retained: [{ unit_number: 901 }] })
        expect(execute(f, validation)[0]).toBe(true)
        const active: any = f.manager.get_status_snapshot().active_batch
        expect(active.batch_generation).toBe(2)
        expect(admission.slot(SECOND.operation_key, 1, { ok: true, operation: 'execute_construction_plan', batch_refs: [{ batch_id: active.batch_id, batch_generation: 2, batch_ref: active.batch_ref }] }).ok).toBe(true)
        expect(admission.finish(SECOND.operation_key, { ok: true }).record?.state).toBe('admitted')
        expect(place_next(f)?.[0]).toBe(true)
        expect(place_next(f)?.[0]).toBe(true)
        expect(layout(layout_id)).toMatchObject({ state: 'complete', executions_used: 2, nodes: [{ state: 'placed', unit_number: 901 }, { state: 'placed' }, { state: 'placed' }] })
        expect(f.created.filter(entity => entity.name === 'test-chest' && entity.position.y === -0.5)).toHaveLength(1)
        expect(f.surface.create_entity).toHaveBeenCalledTimes(3)
        expect(admission.status().records.map(row => row.state)).toEqual(['partial', 'completed'])
      })

      it('keeps the restart evidence in the sealed row after the journal evicts the retired receipt', () => {
        const f = build()
        const { admission } = admitted(f)
        expect(place_next(f)?.[0]).toBe(true)
        f.manager.reconcile_startup('restart-2')
        expect(admission.begin(SECOND).ok).toBe(true)
        ;(globalThis as any).storage.sgluna_task_receipt_journal.length = 0
        expect(admission.status().records[0]).toMatchObject(RESTART_ROW)
        expect((globalThis as any).storage.sgluna_operation_admissions[0].layout_receipt).toEqual(RESTART_ROW.layout_receipt)
      })

      it('reports a node whose entity is gone after the restart as missing, pauses the layout and never resumes it', () => {
        const f = build()
        const { admission, layout_id } = admitted(f)
        expect(place_next(f)?.[0]).toBe(true)
        f.manager.reconcile_startup('restart-2')
        f.by_unit.get(901).valid = false
        const original = (globalThis as any).game.get_surface
        ;(globalThis as any).game.get_surface = () => f.surface
        try {
          expect(admission.status().records[0]).toMatchObject({ state: 'partial', placed_node_ids: [], missing_node_ids: [`layout-${layout_id}:n0`], not_placed_node_ids: [`layout-${layout_id}:n2`, `layout-${layout_id}:n1`] })
        }
        finally {
          ;(globalThis as any).game.get_surface = original
        }
        expect(layout(layout_id).nodes[0]).toMatchObject({ state: 'missing', unit_number: 901 })
        expect(construction_layout_status(layout_id, { actor: f.actor })).toMatchObject({ layout: { state: 'paused' } })
        expect(resume(f, layout_id)).toMatchObject({ ok: false, error: { code: 'LAYOUT_COMPLETED_NODE_MISSING' } })
        expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
      })

      it('does not settle a retired receipt of the current generation or for another reason', () => {
        for (const mutate of [
          (receipt: any) => { receipt.state = 'uncertain'; receipt.reason = 'save_load_unfinished' },
          (receipt: any) => { receipt.state = 'uncertain'; receipt.reason = 'something_else' },
        ]) {
          ;(globalThis as any).storage = {}
          const f = build()
          const { admission, layout_id } = admitted(f)
          expect(place_next(f)?.[0]).toBe(true)
          f.manager.cancel_all_tasks('test_cancel')
          const row = (globalThis as any).storage.sgluna_operation_admissions[0]
          Object.assign(row, { state: 'admitted', ok: true, error: undefined, layout_id: undefined, placed_node_ids: undefined, not_placed_node_ids: undefined, layout_receipt: undefined })
          layout(layout_id).executions[0].settled = undefined
          mutate((globalThis as any).storage.sgluna_task_receipt_journal[0])
          expect(admission.status().records[0].state).not.toBe('partial')
          expect(layout(layout_id).executions[0].settled).toBeUndefined()
        }
      })

      it.each([
        ['another operation', () => { (globalThis as any).storage.sgluna_operation_admissions[0].slots[0].operation = 'place_entity' }],
        ['another generation', () => { (globalThis as any).storage.sgluna_operation_admissions[0].generation += 1 }],
        ['an unusable actor identity', () => { (globalThis as any).storage.sgluna_operation_admissions[0].actor_id = 0 }],
        ['a queued task count that differs from the receipt', () => { (globalThis as any).storage.sgluna_operation_admissions[0].slots[0].queued_tasks += 1 }],
        ['a receipt that is not a cancellation', () => { (globalThis as any).storage.sgluna_task_receipt_journal[0].state = 'uncertain' }],
        ['a non-placement task', () => { (globalThis as any).storage.sgluna_task_receipt_journal[0].task_types[0] = 'mining' }],
        ['a refused task', () => { (globalThis as any).storage.sgluna_task_receipt_journal[0].refused_count = 1 }],
        ['a receipt of another batch', () => { (globalThis as any).storage.sgluna_task_receipt_journal[0].batch_ref = 'batch-g1-99' }],
        ['a receipt older than the admission', () => { (globalThis as any).storage.sgluna_task_receipt_journal[0].tick = 1 }],
        ['a layout of another batch', () => { Object.values<any>((globalThis as any).storage.sgluna_construction_layouts)[0].executions[0].batch_ref = 'batch-g1-99' }],
        ['a layout of another actor', () => { Object.values<any>((globalThis as any).storage.sgluna_construction_layouts)[0].actor_id = 7 }],
        ['an execution that queued another number of nodes', () => { Object.values<any>((globalThis as any).storage.sgluna_construction_layouts)[0].executions[0].queued_nodes.pop() }],
        ['two layouts claiming the same batch', () => {
          const layouts = (globalThis as any).storage.sgluna_construction_layouts
          const original = Object.values<any>(layouts)[0]
          layouts[9999] = { ...original, layout_id: 9999 }
        }],
      ])('leaves the admission unsettled for %s', (_name, mutate) => {
        const f = build()
        const { admission, layout_id } = admitted(f)
        expect(place_next(f)?.[0]).toBe(true)
        f.manager.cancel_all_tasks('test_cancel')
        // Retaining the closing receipt already sealed the partial; take the seal off to judge the evidence again.
        const row = (globalThis as any).storage.sgluna_operation_admissions[0]
        expect(row.state).toBe('partial')
        Object.assign(row, { state: 'admitted', ok: true, error: undefined, layout_id: undefined, placed_node_ids: undefined, not_placed_node_ids: undefined })
        layout(layout_id).executions[0].settled = undefined
        mutate()
        expect(admission.status().records[0].state).not.toBe('partial')
        // Nothing was settled on the strength of a link that did not hold.
        expect(layout(layout_id)?.executions?.[0]?.settled).toBeUndefined()
      })
    })
  })
})
