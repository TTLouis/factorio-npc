import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { construction_plan_preflight, execute_validated_construction_plan, validate_construction_execution_plan } from './construction_execution'
import { construction_layout_status, create_layout_record, record_layout_node_placed } from './construction_layout'
import { placement_footprint } from './placement_geometry'
import { new_task_manager } from './task_manager'

// Milestone 4, acceptance L2 and L3: a layout with typed connections is proved before anything is built (planning status kept
// apart from execution eligibility), executed in a deterministic dependency order, and every placed node is bound to a
// receipt whose connections are verified against the actual entities. Engine facts only: prototype `type`, the inserter and
// drill vectors, the pole supply area, and the entities' own pickup/drop targets and electric network ids.

type Pos = { x: number, y: number }

const MASK = { layers: { object: true, item: true } }
function prototype(name: string, type: string, tile: [number, number], half: number, extra: Record<string, any> = {}) {
  return {
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
  'test-chest': prototype('test-chest', 'container', [1, 1], 0.4),
  'test-inserter': prototype('test-inserter', 'inserter', [1, 1], 0.15, {
    inserter_pickup_position: { x: 0, y: -1 },
    inserter_drop_position: { x: 0, y: 1.2 },
    electric_energy_source_prototype: {},
  }),
  'test-pole': prototype('test-pole', 'electric-pole', [1, 1], 0.15, { supply_area_distance: 2.5, max_wire_distance: 7.5 }),
  'test-lab': prototype('test-lab', 'lab', [3, 3], 1.2, { electric_energy_source_prototype: {} }),
  // 2.0 returns the output vector in array form.
  'test-drill': prototype('test-drill', 'mining-drill', [2, 2], 0.9, { vector_to_place_result: [-0.5, -1.3], electric_energy_source_prototype: {} }),
  'test-pipe': prototype('test-pipe', 'pipe', [1, 1], 0.4),
  'test-bare-inserter': prototype('test-bare-inserter', 'inserter', [1, 1], 0.15),
}
const HELD = { 'test-chest': 3, 'test-inserter': 1, 'test-pole': 1, 'test-lab': 1, 'test-drill': 1, 'test-pipe': 2, 'test-bare-inserter': 1 }

const BOILER_UNIT = 500
const EXISTING_PROTOTYPE = { name: 'test-boiler', type: 'boiler', electric_energy_source_prototype: undefined }

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
})
