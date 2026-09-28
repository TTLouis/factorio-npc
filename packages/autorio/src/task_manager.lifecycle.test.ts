import type { ControlledActor } from './actors/types'
import type { PlayerParameters } from './types'
import { describe, expect, it, vi } from 'vitest'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function walking_task(): PlayerParameters {
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: 'iron-chest',
    search_radius: 40,
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: null,
  }
}

function context() {
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 10, y: 5 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_crafting_queue_count: vi.fn(() => 0),
    begin_crafting: vi.fn(() => 1),
  }
  const resolve = vi.fn(() => actor as unknown as ControlledActor)
  return { actor, resolve, manager: new_task_manager(resolve) }
}

const cases: Array<{ name: string, task: PlayerParameters, walking: boolean, mining: boolean, shooting: boolean }> = [
  { name: 'path walking', task: walking_task(), walking: true, mining: false, shooting: false },
  { name: 'direct walking', task: { type: TaskStates.WALKING_DIRECT, target_position: { x: 20, y: 0 } }, walking: true, mining: false, shooting: false },
  { name: 'mining', task: { type: TaskStates.MINING, entity_name: 'iron-ore', count: 10 }, walking: false, mining: true, shooting: false },
  { name: 'attacking', task: { type: TaskStates.ATTACKING, search_radius: 40, target: null }, walking: true, mining: false, shooting: true },
]

describe('task control lifecycle', () => {
  for (const method of ['reset_task_state', 'cancel_task', 'cancel_all_tasks'] as const) {
    it.each(cases)(`${method} releases the controls owned by $name`, ({ task, walking, mining, shooting }) => {
      const { actor, manager } = context()
      manager.add_task({ ...task })
      manager[method]()

      expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
      expect(actor.set_walking_state).toHaveBeenCalledTimes(walking ? 1 : 0)
      expect(actor.set_mining_state).toHaveBeenCalledTimes(mining ? 1 : 0)
      expect(actor.set_shooting_state).toHaveBeenCalledTimes(shooting ? 1 : 0)
      if (walking) {
        expect(actor.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: defines.direction.north })
      }
      if (mining) {
        expect(actor.set_mining_state).toHaveBeenCalledWith({ mining: false })
      }
      if (shooting) {
        expect(actor.set_shooting_state).toHaveBeenCalledWith({ state: defines.shooting.not_shooting, position: actor.position })
      }
    })
  }

  it('stops walking before activating a queued crafting task without starting native crafting itself', () => {
    const { actor, manager } = context()
    manager.add_task(walking_task())
    manager.add_task({ type: TaskStates.CRAFTING, item_name: 'iron-gear-wheel', count: 1, crafted: 0 })
    expect(actor.begin_crafting).not.toHaveBeenCalled()

    manager.reset_task_state()
    expect(actor.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: defines.direction.north })

    manager.next_task()

    expect(manager.player_state().task_state).toBe(TaskStates.CRAFTING)
    expect(manager.player_state().parameters_craft_item).toMatchObject({
      item_name: 'iron-gear-wheel',
      count: 1,
      crafted: 0,
    })
    // Native admission/start belongs to crafting_controller.tick(), which binds
    // identity and owns cancellation/output verification. The task manager only
    // advances logical task order.
    expect(actor.begin_crafting).not.toHaveBeenCalled()
  })

  it('cancel_all_tasks stops the active movement and discards the queued wait', () => {
    const { actor, manager } = context()
    manager.add_task(walking_task())
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 3600 })
    manager.cancel_all_tasks()
    manager.next_task()

    expect(actor.set_walking_state).toHaveBeenCalledTimes(1)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_empty: true, queue_length: 0 })
  })

  it('discards actor-owned work after body loss without resolving or controlling a replacement', () => {
    const { actor, resolve, manager } = context()
    manager.add_task(walking_task())
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 3600 })

    manager.discard_all_tasks_after_actor_loss()

    expect(resolve).not.toHaveBeenCalled()
    expect(actor.set_walking_state).not.toHaveBeenCalled()
    expect(actor.set_mining_state).not.toHaveBeenCalled()
    expect(actor.set_shooting_state).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
    })
  })

  it('does not resolve or spawn an actor for an already-idle reset', () => {
    const { resolve, manager } = context()
    manager.reset_task_state()
    manager.cancel_task()
    manager.cancel_all_tasks()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not stop unrelated human inputs when a hand-crafting task finishes', () => {
    const { actor, manager } = context()
    manager.add_task({ type: TaskStates.CRAFTING, item_name: 'iron-gear-wheel', count: 1, crafted: 0 })
    manager.reset_task_state()
    expect(actor.set_walking_state).not.toHaveBeenCalled()
    expect(actor.set_mining_state).not.toHaveBeenCalled()
    expect(actor.set_shooting_state).not.toHaveBeenCalled()
  })

  it('does not read character properties from an invalid actor', () => {
    const { actor, manager } = context()
    actor.is_valid = false
    Object.defineProperty(actor, 'character', { get: () => { throw new Error('invalid entity access') } })
    manager.add_task(walking_task())
    expect(() => manager.cancel_all_tasks()).not.toThrow()
    expect(actor.set_walking_state).not.toHaveBeenCalled()
    expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
  })

  it('still clears task state when no actor can be resolved', () => {
    const manager = new_task_manager(() => undefined)
    manager.add_task(walking_task())
    expect(() => manager.cancel_all_tasks()).not.toThrow()
    expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
  })
})
