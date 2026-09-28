import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_composite_operation_controller } from './composite_operations'
import { new_navigation_controller } from './navigation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture() {
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const basic = new_basic_operation_controller(get_actor, manager)
  const navigation = new_navigation_controller(get_actor, manager)
  const composite = new_composite_operation_controller(navigation, basic, manager)
  return { actor, manager, basic, navigation, composite }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['iron-ore'] = { type: 'resource' }
  ;(globalThis as any).prototypes.entity.coal = { type: 'resource' }
  ;(globalThis as any).prototypes.entity['tree-01'] = { type: 'tree' }
})

describe('composite resource gathering', () => {
  it('queues one navigation task followed by mining in the same deterministic batch', () => {
    const f = fixture()

    expect(f.composite.gather_resource('iron-ore', 20, 512)).toEqual([true, 'Resource gathering task started'])
    expect(f.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(f.manager.player_state().parameters_walk_to_entity).toMatchObject({
      entity_name: 'iron-ore',
      search_radius: 512,
      owner_actor_id: 42,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
      active_batch: {
        task_count: 2,
        task_types: [TaskStates.WALKING_TO_ENTITY, TaskStates.MINING],
      },
    })
  })

  it('keeps multiple known resource gathers in one batch so they need one completion continuation', () => {
    const f = fixture()

    expect(f.composite.gather_resource('iron-ore', 20, 512)[0]).toBe(true)
    expect(f.composite.gather_resource('coal', 10, 512)[0]).toBe(true)

    expect(f.manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.WALKING_TO_ENTITY,
      queue_length: 3,
      queued_task_types: [TaskStates.MINING, TaskStates.WALKING_TO_ENTITY, TaskStates.MINING],
      active_batch: {
        task_count: 4,
        task_types: [
          TaskStates.WALKING_TO_ENTITY,
          TaskStates.MINING,
          TaskStates.WALKING_TO_ENTITY,
          TaskStates.MINING,
        ],
      },
    })
  })

  it('rejects non-resource entities before creating any work', () => {
    const f = fixture()

    expect(f.composite.gather_resource('tree-01', 1, 256)[0]).toBe(false)
    expect(f.manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_length: 0,
      queue_empty: true,
      active_batch: undefined,
    })
  })
})

describe('composite exact entity supply', () => {
  it('queues multiple item loads to one exact unit number in one batch', () => {
    const f = fixture()

    expect(f.composite.supply_entity(104, [
      { item_name: 'coal', count: 10 },
      { item_name: 'iron-ore', count: 10 },
    ])).toEqual([true, 'Exact entity supply task started'])

    expect(f.manager.player_state().task_state).toBe(TaskStates.MOVING_ITEMS)
    expect(f.manager.player_state().parameters_move_items).toMatchObject({
      item_name: 'coal',
      target_unit_number: 104,
      max_count: 10,
      to_entity: true,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MOVING_ITEMS],
      active_batch: {
        task_count: 2,
        task_types: [TaskStates.MOVING_ITEMS, TaskStates.MOVING_ITEMS],
      },
    })
  })

  it('rejects duplicate items before creating any work', () => {
    const f = fixture()

    expect(f.composite.supply_entity(104, [
      { item_name: 'coal', count: 5 },
      { item_name: 'coal', count: 5 },
    ])[0]).toBe(false)
    expect(f.manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_length: 0,
      queue_empty: true,
      active_batch: undefined,
    })
  })
})