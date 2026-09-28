import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_orientation_runtime } from './orientation_runtime'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture() {
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface: { index: 1, find_entities_filtered: vi.fn(() => []) },
    force: { index: 1 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    status_snapshot: () => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      position: { x: 0, y: 0 },
    }),
  } as unknown as ControlledActor
  const get_actor = () => actor
  const manager = new_task_manager(get_actor)
  const controller = new_basic_operation_controller(get_actor, manager)
  const runtime = new_orientation_runtime(manager, controller)
  return { actor, manager, controller, runtime }
}

describe('placed entity orientation runtime', () => {
  const originalLookup = (globalThis as any).game.get_entity_by_unit_number

  beforeEach(() => {
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 100
  })

  afterEach(() => {
    ;(globalThis as any).game.get_entity_by_unit_number = originalLookup
  })

  it('rotates one exact local entity and records the resulting direction', () => {
    const f = fixture()
    const entity: any = {
      valid: true,
      name: 'burner-mining-drill',
      unit_number: 543,
      position: { x: 2, y: 0 },
      direction: 0,
      supports_direction: true,
      rotatable: true,
      surface: { index: 1 },
      force: { index: 1 },
    }
    entity.rotate = vi.fn(({ reverse }: { reverse: boolean }) => {
      expect(reverse).toBe(false)
      entity.direction = 4
      return true
    })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => entity)

    expect(f.controller.submit_rotate_exact(543)).toEqual([true, 'Task started'])
    expect(f.manager.player_state().task_state).toBe(TaskStates.ROTATING)

    const result = f.runtime.state_rotating(f.actor)

    expect(result[0]).toBe(true)
    expect(entity.rotate).toHaveBeenCalledWith({ reverse: false })
    expect(f.manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({
      type: TaskStates.ROTATING,
      target_unit_number: 543,
      reverse: false,
      previous_direction: 0,
      direction: 4,
      completed: true,
      code: 'completed',
    })
  })

  it('fails closed when Factorio says the exact entity is not rotatable', () => {
    const f = fixture()
    const entity: any = {
      valid: true,
      name: 'entity-that-cannot-rotate',
      unit_number: 544,
      position: { x: 2, y: 0 },
      direction: 0,
      supports_direction: true,
      rotatable: false,
      surface: { index: 1 },
      force: { index: 1 },
      rotate: vi.fn(),
    }
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => entity)

    expect(f.controller.submit_rotate_exact(544, true)).toEqual([true, 'Task started'])
    const result = f.runtime.state_rotating(f.actor)

    expect(result[0]).toBe(false)
    expect(entity.rotate).not.toHaveBeenCalled()
    expect(f.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
    expect(f.controller.status().last_result).toMatchObject({
      target_unit_number: 544,
      reverse: true,
      code: 'not_rotatable',
      completed: false,
    })
  })
})
