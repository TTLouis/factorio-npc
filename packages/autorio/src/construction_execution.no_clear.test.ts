import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { construction_plan_preflight, execute_validated_construction_plan, validate_construction_execution_plan } from './construction_execution'
import { placement_footprint } from './placement_geometry'
import { new_task_manager } from './task_manager'

// Run BC A/C review R1-2: the fluid-preservation witness for a validated local construction plan promises a placement-only
// effect. That promise has to hold when the placing task RUNS, not only when the plan was evaluated: a tree, rock or ground
// item that appears between queueing and execution must fail the task before any mutation, never be mined or picked up.

type Pos = { x: number, y: number }
type Box = { left_top: Pos, right_bottom: Pos }

const LAB = {
  name: 'lab',
  type: 'lab',
  tile_width: 3,
  tile_height: 3,
  collision_box: { left_top: { x: -1.2, y: -1.2 }, right_bottom: { x: 1.2, y: 1.2 } },
  selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'lab', count: 1 }],
}
const POLE = {
  name: 'small-electric-pole',
  type: 'electric-pole',
  tile_width: 1,
  tile_height: 1,
  collision_box: { left_top: { x: -0.15, y: -0.15 }, right_bottom: { x: 0.15, y: 0.15 } },
  selection_box: { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'small-electric-pole', count: 1 }],
}
const LAB_AT = { x: 4.5, y: 0.5 }
const POLE_AT = { x: 7.5, y: 0.5 }
const NEUTRAL = { index: 3, name: 'neutral' }
const MASK = { layers: { object: true } }
const STATUS = { working: 1, normal: 2, no_ingredients: 3 }

function inside(box: Box, position: Pos) {
  return position.x > box.left_top.x && position.x < box.right_bottom.x && position.y > box.left_top.y && position.y < box.right_bottom.y
}

let next_unit = 500
function entity(fields: Record<string, any>): any {
  const value: any = { valid: true, unit_number: next_unit++, force: { index: 1, name: 'player' }, minable: true, surface: { index: 1 }, ...fields }
  value.destroy = vi.fn(() => { value.valid = false })
  value.mine = vi.fn(({ inventory }: any) => {
    for (const product of value.prototype?.mineable_properties?.products ?? []) inventory.insert({ name: product.name, count: product.amount ?? product.amount_max })
    value.valid = false
    return true
  })
  return value
}
function tree(position: Pos) {
  return entity({ name: 'tree-01', type: 'tree', position, force: NEUTRAL,
    prototype: { type: 'tree', is_building: false, is_entity_with_owner: false, items_to_place_this: [], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 0.55, products: [{ type: 'item', name: 'wood', amount: 4 }] } } })
}
function rock(position: Pos) {
  return entity({ name: 'rock-big', type: 'simple-entity', position, force: NEUTRAL,
    prototype: { type: 'simple-entity', is_building: true, is_entity_with_owner: false, items_to_place_this: [], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 2, products: [{ type: 'item', name: 'stone', amount_min: 20, amount_max: 50 }] } } })
}
function chest(position: Pos) {
  return entity({ name: 'wooden-chest', type: 'container', position, status: undefined, last_user: undefined,
    prototype: { type: 'container', is_building: true, is_entity_with_owner: true, items_to_place_this: [{ name: 'wooden-chest', count: 1 }], collision_mask: MASK,
      mineable_properties: { minable: true, mining_time: 0.2, products: [{ type: 'item', name: 'wooden-chest', amount: 1 }] } },
    get_max_inventory_index: () => 1, get_inventory: () => ({ is_empty: () => true }), fluidbox: [] })
}
function ground_item(name: string, count: number, position: Pos) {
  return entity({ name: 'item-on-ground', type: 'item-entity', position, prototype: { collision_mask: { layers: { item: true } } },
    stack: { valid_for_read: true, name, count, quality: { name: 'normal' } } })
}

function build() {
  const entities: any[] = []
  const live = () => entities.filter(value => value.valid)
  const in_area = (filters: any) => live().filter(value => (!filters.type || value.type === filters.type) && (!filters.area || inside(filters.area, value.position)))
  const by_name: Record<string, any> = { lab: LAB, 'small-electric-pole': POLE }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
    find_entities_filtered: vi.fn((filters: any) => in_area(filters).slice(0, filters.limit ?? 1000)),
    count_entities_filtered: vi.fn((filters: any) => in_area(filters).length),
    // The script check: anything in the footprint blocks it, ground items included.
    can_place_entity: vi.fn((args: any) => in_area({ area: placement_footprint(by_name[args.name], args.position, args.direction).world_box }).length === 0),
  }
  surface.create_entity = vi.fn((args: any) => ({ valid: true, name: args.name, type: by_name[args.name].type, unit_number: 900 + surface.create_entity.mock.calls.length, position: args.position, direction: 0, surface, force: { index: 1 } }))
  const held: Record<string, number> = { lab: 1, 'small-electric-pole': 1 }
  const inventory: any = {
    held,
    get_contents: vi.fn(() => Object.entries(held).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
    get_item_count: vi.fn((name: string) => held[name] ?? 0),
    remove: vi.fn(({ name, count }: any) => { const removed = Math.min(held[name] ?? 0, count); held[name] = (held[name] ?? 0) - removed; return removed }),
    can_insert: vi.fn(() => true),
    get_insertable_count: vi.fn(() => 100),
    count_empty_stacks: vi.fn(() => 5),
    insert: vi.fn((stack: any) => { held[stack.name] = (held[stack.name] ?? 0) + stack.count; return stack.count }),
  }
  const position = { x: 0, y: 0 }
  const actor = {
    is_valid: true,
    character: { valid: true, name: 'character', type: 'character', position, prototype: { mining_speed: 0.5 }, character_mining_speed_modifier: 0, resource_reach_distance: 20, build_distance: 20 },
    position,
    surface,
    force: { index: 1, name: 'player', manual_mining_speed_modifier: 0 },
    get_main_inventory: () => inventory,
    entity_build_args: () => ({ force: { index: 1 } }),
    status_snapshot: () => ({ actor_id: 42, kind: 'standalone_character', valid: true, has_character: true, position }),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const basic = new_basic_operation_controller(() => actor, manager)
  const runtime = new_basic_operation_runtime(manager, basic)
  return { actor, surface, inventory, held, manager, basic, runtime, entities }
}

function validated_lab_pole() {
  const f = build()
  const validation: any = validate_construction_execution_plan(f.actor, {
    plan_id: 'lab-pole',
    placements: [{ entity_name: 'lab', ...LAB_AT, direction: 0 }, { entity_name: 'small-electric-pole', ...POLE_AT, direction: 0 }],
  })
  expect(validation.ok).toBe(true)
  return { f, id: validation.validation_id as number }
}

describe('validated construction placements refuse clearance at execution time (R1-2)', () => {
  const originalPairs = (globalThis as any).pairs
  const originalEntityPrototypes = (globalThis as any).prototypes.entity
  const originalItemPrototypes = (globalThis as any).prototypes.item
  const originalDefines = (globalThis as any).defines
  const originalGetEntity = (globalThis as any).game.get_entity_by_unit_number

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).prototypes.entity = { lab: LAB, 'small-electric-pole': POLE }
    ;(globalThis as any).prototypes.item = { lab: { stack_size: 10 }, 'small-electric-pole': { stack_size: 50 }, wood: { stack_size: 100 }, stone: { stack_size: 50 }, 'copper-ore': { stack_size: 50 }, 'wooden-chest': { stack_size: 50 } }
    ;(globalThis as any).defines = { ...originalDefines, entity_status: STATUS }
    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
    ;(globalThis as any).prototypes.item = originalItemPrototypes
    ;(globalThis as any).defines = originalDefines
    ;(globalThis as any).game.get_entity_by_unit_number = originalGetEntity
  })

  function expect_refused_untouched(f: ReturnType<typeof build>, blocker: any, cancelled: ReturnType<typeof vi.spyOn>) {
    const before = { ...f.held }
    const result = f.runtime.state_placing(f.actor)
    expect(result?.[0]).toBe(false)
    expect(f.basic.status().last_result).toMatchObject({ code: 'construction_plan_blocked_no_clear', completed: false })
    expect(f.basic.status().last_result?.entities_cleared).toBeUndefined()
    expect(f.basic.status().last_result?.ground_items_picked_up).toBeUndefined()
    expect(cancelled).toHaveBeenCalledWith('placing:construction_plan_blocked_no_clear', expect.objectContaining({ failed_before_mutation: true }))
    expect(blocker.valid).toBe(true)
    expect(blocker.mine).not.toHaveBeenCalled()
    expect(blocker.destroy).not.toHaveBeenCalled()
    expect(f.surface.create_entity).not.toHaveBeenCalled()
    expect(f.inventory.insert).not.toHaveBeenCalled()
    expect(f.inventory.remove).not.toHaveBeenCalled()
    expect(f.held).toEqual(before)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
  }

  it('queues every validated placement with the no-clear mode', () => {
    const { f, id } = validated_lab_pole()
    expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)).toEqual([true, 'Validated construction plan started'])
    const queued = [f.manager.player_state.parameters_place_entity, ...(storage as any).sgluna_task_execution.task_queue].filter(Boolean)
    expect(queued.length).toBe(2)
    for (const task of queued) expect(task.refuse_clearance).toBe(true)
  })

  for (const [label, make, at] of [
    ['a tree', tree, LAB_AT],
    ['a rock', rock, { x: 5, y: 1 }],
    ['a ground item', (position: Pos) => ground_item('copper-ore', 3, position), { x: 4.2, y: 0.4 }],
    ['an idle entity the NPC built', chest, LAB_AT],
  ] as const) {
    it(`refuses ${label} that appears after queueing, before any mutation`, () => {
      const { f, id } = validated_lab_pole()
      expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)[0]).toBe(true)
      const late = (make as (position: Pos) => any)(at)
      f.entities.push(late)
      const cancelled = vi.spyOn(f.manager, 'cancel_all_tasks')
      expect_refused_untouched(f, late, cancelled)
    })
  }

  it('refuses a late blocker under the second placement too, after the first was placed', () => {
    const { f, id } = validated_lab_pole()
    expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)[0]).toBe(true)
    expect(f.runtime.state_placing(f.actor)?.[0]).toBe(true)
    expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
    const late = tree(POLE_AT)
    f.entities.push(late)
    const cancelled = vi.spyOn(f.manager, 'cancel_all_tasks')
    const before = { ...f.held }
    const result = f.runtime.state_placing(f.actor)
    expect(result?.[0]).toBe(false)
    expect(f.basic.status().last_result).toMatchObject({ code: 'construction_plan_blocked_no_clear' })
    expect(cancelled).toHaveBeenCalledWith('placing:construction_plan_blocked_no_clear', expect.objectContaining({ failed_before_mutation: true }))
    expect(late.valid).toBe(true)
    expect(late.mine).not.toHaveBeenCalled()
    expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
    expect(f.held).toEqual(before)
  })

  it('keeps the mode through a save and load of the queued task', () => {
    const { f, id } = validated_lab_pole()
    expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)[0]).toBe(true)
    ;(globalThis as any).storage = JSON.parse(JSON.stringify((globalThis as any).storage))
    const queued = [f.manager.player_state.parameters_place_entity, ...(storage as any).sgluna_task_execution.task_queue].filter(Boolean)
    expect(queued.map((task: any) => task.refuse_clearance)).toEqual([true, true])
    const late = tree(LAB_AT)
    f.entities.push(late)
    expect_refused_untouched(f, late, vi.spyOn(f.manager, 'cancel_all_tasks'))
  })

  it('places normally when nothing blocks (the witness stays truthful for the positive case)', () => {
    const { f, id } = validated_lab_pole()
    expect((construction_plan_preflight(f.actor, id, 2) as any).execution_clearance).toBe('refused')
    expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)[0]).toBe(true)
    expect(f.runtime.state_placing(f.actor)?.[0]).toBe(true)
    expect(f.basic.status().last_result).toMatchObject({ code: 'completed' })
    expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
    expect(f.held.lab).toBe(0)
  })

  it('does not change ordinary placement: a raw submit_placement still mines a late tree and builds', () => {
    const f = build()
    const wood = tree(LAB_AT)
    f.entities.push(wood)
    expect(f.basic.submit_placement('lab', LAB_AT.x, LAB_AT.y, 0)).toBe(true)
    expect(f.manager.player_state.parameters_place_entity?.refuse_clearance).toBeUndefined()
    f.runtime.state_placing(f.actor)
    ;(globalThis as any).game.tick = 100 + 1000
    const result = f.runtime.state_placing(f.actor)
    expect(result?.[0]).toBe(true)
    expect(wood.mine).toHaveBeenCalledTimes(1)
    expect(f.basic.status().last_result).toMatchObject({ code: 'completed', entities_cleared: [{ name: 'tree-01' }] })
    expect(f.surface.create_entity).toHaveBeenCalledTimes(1)
  })
})
