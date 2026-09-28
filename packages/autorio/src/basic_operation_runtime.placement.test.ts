import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture() {
  const item = { valid_for_read: true, count: 2 }
  const inventory: any = []
  inventory.find_item_stack = vi.fn(() => [item, 1])

  const surface = {
    find_non_colliding_position: vi.fn(() => ({ x: 1, y: 0 })),
    can_place_entity: vi.fn(() => true),
    create_entity: vi.fn(() => ({ valid: true, unit_number: 77 })),
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface,
    force: { index: 1 },
    get_main_inventory: () => inventory,
    entity_build_args: () => ({ force: { index: 1 } }),
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
  const runtime = new_basic_operation_runtime(manager, controller)
  return { actor, item, surface, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.entity['steel-chest'] = {
    items_to_place_this: [{ name: 'steel-chest', count: 1 }],
  }
})

describe('precise placement runtime', () => {
  it('places at the exact local coordinate with the requested direction', () => {
    const f = fixture()
    expect(f.controller.submit_placement('steel-chest', 4.5, -2, 6)).toBe(true)

    const result = f.runtime.state_placing(f.actor)

    expect(result?.[0]).toBe(true)
    expect(f.surface.find_non_colliding_position).not.toHaveBeenCalled()
    expect(f.surface.can_place_entity).toHaveBeenCalledWith({
      name: 'steel-chest',
      position: { x: 4.5, y: -2 },
      direction: 6,
      force: f.actor.force,
    })
    expect(f.surface.create_entity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'steel-chest',
      position: { x: 4.5, y: -2 },
      direction: 6,
      raise_built: true,
    }))
    expect(f.item.count).toBe(1)
    expect(f.manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      requested_position: { x: 4.5, y: -2 },
      direction: 6,
    })
  })

  it('fails closed when Factorio reports that the requested position is blocked', () => {
    const f = fixture()
    f.surface.can_place_entity.mockReturnValue(false)
    expect(f.controller.submit_placement('steel-chest', 1.5, 0.5, 4)).toBe(true)

    const result = f.runtime.state_placing(f.actor)

    expect(result?.[0]).toBe(false)
    expect(f.surface.can_place_entity).toHaveBeenCalledWith({
      name: 'steel-chest',
      position: { x: 1.5, y: 0.5 },
      direction: 4,
      force: f.actor.force,
    })
    expect(f.surface.create_entity).not.toHaveBeenCalled()
    expect(f.item.count).toBe(2)
    expect(f.manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({
      code: 'not_placeable',
      accepted: false,
      completed: false,
      requested_position: { x: 1.5, y: 0.5 },
      direction: 4,
    })
  })

  it('fails closed instead of remotely placing outside the local build radius', () => {
    const f = fixture()
    expect(f.controller.submit_placement('steel-chest', 10.01, 0, 2)).toBe(true)

    const result = f.runtime.state_placing(f.actor)

    expect(result?.[0]).toBe(false)
    expect(f.surface.can_place_entity).not.toHaveBeenCalled()
    expect(f.surface.create_entity).not.toHaveBeenCalled()
    expect(f.item.count).toBe(2)
    expect(f.manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status().last_result).toMatchObject({
      code: 'too_far',
      accepted: false,
      completed: false,
      requested_position: { x: 10.01, y: 0 },
      direction: 2,
    })
  })
})
