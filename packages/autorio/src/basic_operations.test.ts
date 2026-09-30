import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function context() {
  let actor_id = 18
  const actor = {
    is_valid: true,
    character: { valid: true },
    force: { index: 1 },
    position: { x: 0, y: 0 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    status_snapshot: vi.fn(() => ({
      actor_id,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'SGLuna',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_basic_operation_controller(resolve, manager)
  return {
    actor,
    resolve,
    manager,
    controller,
    set actor_id(value: number) { actor_id = value },
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('basic operation ownership and receipts', () => {
  it('binds mining to actor identity and assigns a monotonic operation id', () => {
    const c = context()

    expect(c.controller.submit_mining('iron-ore', 3)).toBe(true)
    expect(c.manager.player_state.parameters_mine_entity).toMatchObject({
      operation_id: 1,
      owner_actor_id: 18,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      requested_count: 3,
      count: 3,
    })
    expect(c.controller.status().last_result).toMatchObject({
      operation_id: 1,
      type: TaskStates.MINING,
      accepted: true,
      completed: false,
      code: 'queued',
      actor_id: 18,
    })

    c.manager.cancel_all_tasks()
    expect(c.controller.submit_wait(60)[0]).toBe(true)
    expect(c.manager.player_state.parameters_waiting?.operation_id).toBe(2)
  })

  it('queues precise placement position and direction with an auditable receipt', () => {
    const c = context()

    expect(c.controller.submit_placement('assembling-machine-1', 4.5, -2, 6)).toBe(true)
    expect(c.manager.player_state.parameters_place_entity).toMatchObject({
      operation_id: 1,
      owner_actor_id: 18,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      entity_name: 'assembling-machine-1',
      position: { x: 4.5, y: -2 },
      direction: 6,
    })
    expect(c.controller.status().last_result).toMatchObject({
      code: 'queued',
      accepted: true,
      requested_position: { x: 4.5, y: -2 },
      direction: 6,
    })
  })

  it('queues exact entity transfer identity and records it in the receipt', () => {
    const c = context()

    expect(c.controller.submit_move_exact('firearm-magazine', 4242, 25, true)).toEqual([true, 'Task started'])
    expect(c.manager.player_state.parameters_move_items).toMatchObject({
      operation_id: 1,
      owner_actor_id: 18,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      item_name: 'firearm-magazine',
      target_unit_number: 4242,
      max_count: 25,
      to_entity: true,
    })
    expect(c.controller.status().last_result).toMatchObject({
      code: 'queued',
      accepted: true,
      target_unit_number: 4242,
      item_name: 'firearm-magazine',
      to_entity: true,
    })
  })

  it('queues exact machine recipe configuration and records the target identity', () => {
    const c = context()

    expect(c.controller.submit_set_recipe_exact(4242, 'iron-gear-wheel')).toEqual([true, 'Task started'])
    expect(c.manager.player_state.parameters_set_recipe).toMatchObject({
      operation_id: 1,
      owner_actor_id: 18,
      owner_actor_kind: 'standalone_character',
      owner_force_index: 1,
      target_unit_number: 4242,
      recipe_name: 'iron-gear-wheel',
    })
    expect(c.controller.status().last_result).toMatchObject({
      code: 'queued',
      accepted: true,
      type: TaskStates.SETTING_RECIPE,
      target_unit_number: 4242,
      recipe_name: 'iron-gear-wheel',
    })
  })

  it('rejects malformed precise placement before queueing work', () => {
    const c = context()

    expect(c.controller.submit_placement('steel-chest', 1, undefined, 0)).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_position')
    expect(c.controller.submit_placement('steel-chest', 1, 1, 16)).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_direction')
    expect(c.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
  })

  it('rejects invalid bounded inputs before queueing work', () => {
    const c = context()

    expect(c.controller.submit_mining('iron-ore', 0)).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_count')
    expect(c.controller.submit_move('iron-plate', 'steel-chest', 0, true)[0]).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_max_count')
    expect(c.controller.submit_move_exact('iron-plate', 0, 1, true)[0]).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_unit_number')
    expect(c.controller.submit_set_recipe_exact(0, 'iron-gear-wheel')[0]).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_unit_number')
    expect(c.controller.submit_set_recipe_exact(42, '')[0]).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_recipe')
    expect(c.controller.submit_wait(360001)[0]).toBe(false)
    expect(c.controller.status().last_result?.code).toBe('invalid_ticks')
    expect(c.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
  })

  it('detects actor replacement before deferred work can execute', () => {
    const c = context()
    c.controller.submit_placement('steel-chest')
    const task = c.manager.player_state.parameters_place_entity
    expect(task).toBeDefined()
    if (!task) throw new Error('placement task missing')

    expect(c.controller.identity_matches(c.actor, task)).toBe(true)
    c.actor_id = 42
    expect(c.controller.identity_matches(c.actor, task)).toBe(false)
  })

  it('completion records an exact result and advances to dependent work', () => {
    const c = context()
    c.controller.submit_wait(60)
    c.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 30 })
    const first = c.manager.player_state.parameters_waiting
    expect(first).toBeDefined()
    if (!first) throw new Error('wait task missing')

    ;(globalThis as any).game.tick = 160
    c.controller.complete(c.actor, first)

    expect(c.controller.status().last_result).toMatchObject({
      operation_id: 1,
      type: TaskStates.WAITING,
      accepted: true,
      completed: true,
      code: 'completed',
      actor_id: 18,
      requested_ticks: 60,
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.WAITING)
  })

  it('explicit failure cancels dependent work and keeps the failure receipt authoritative', () => {
    const c = context()
    c.controller.submit_mining('iron-ore', 2)
    c.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 300 })
    const task = c.manager.player_state.parameters_mine_entity
    expect(task).toBeDefined()
    if (!task) throw new Error('mining task missing')

    c.controller.fail(c.actor, task, 'no_target')

    expect(c.manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
    })
    expect(c.controller.status().last_result).toMatchObject({
      operation_id: 1,
      code: 'no_target',
      accepted: false,
      completed: false,
      actor_id: 18,
    })
  })

  it('manual cancellation records cancelled for the bound operation', () => {
    const c = context()
    c.controller.submit_wait(600)

    c.manager.cancel_all_tasks()

    expect(c.controller.status().last_result).toMatchObject({
      operation_id: 1,
      type: TaskStates.WAITING,
      code: 'cancelled',
      accepted: false,
      completed: false,
      actor_id: 18,
    })
  })
})
