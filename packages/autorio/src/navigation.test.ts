import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_navigation_controller } from './navigation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function make_context() {
  let next_request_id = 100
  const position = { x: 0, y: 0 }
  const target = {
    valid: true,
    name: 'steel-chest',
    unit_number: 88,
    position: { x: 20, y: 0 },
  }
  const character_prototype = {
    collision_box: [[-0.2, -0.2], [0.2, 0.2]],
    collision_mask: {
      layers: { player: true, train: true, is_object: true },
      consider_tile_transitions: true,
    },
  }
  const character = {
    valid: true,
    name: 'character',
    position,
    prototype: character_prototype,
  }
  const surface = {
    find_entities_filtered: vi.fn(() => [target] as any[]),
    find_non_colliding_position: vi.fn(() => ({ x: 6, y: 0 })),
    get_tile: vi.fn(() => ({ name: 'grass-1' })),
    request_path: vi.fn(() => ++next_request_id),
  }
  const actor = {
    is_valid: true,
    character,
    position,
    surface,
    force: { index: 1 },
    status_snapshot: vi.fn(() => ({
      actor_id: 1,
      kind: 'standalone_character',
      valid: true,
      name: 'AIRI',
      position,
      has_character: true,
    })),
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_navigation_controller(resolve, manager)
  return { actor, character, character_prototype, position, target, surface, resolve, manager, controller }
}

function waypoint(x: number, y = 0) {
  return { position: { x, y }, needs_destroy_to_reach: false }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('bounded navigation controller', () => {
  it('rejects invalid search radii without queueing work', () => {
    const { controller, manager } = make_context()

    expect(controller.submit('steel-chest', 0)).toBe(false)
    expect(controller.submit('steel-chest', 4097)).toBe(false)
    expect(manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
    expect(controller.status().last_result?.code).toBe('invalid_radius')
  })

  it('binds the task to actor identity and starts pathfinding at the real actor position', () => {
    const { actor, character_prototype, controller, manager, surface, position } = make_context()

    expect(controller.submit('steel-chest', 40)).toBe(true)
    controller.tick(actor)

    const task = manager.player_state().parameters_walk_to_entity!
    expect(task.owner_actor_id).toBe(1)
    expect(task.owner_actor_kind).toBe('standalone_character')
    expect(task.owner_force_index).toBe(1)
    expect(task.path_request_id).toBe(101)
    expect(task.calculating_path).toBe(true)
    expect(surface.find_non_colliding_position).not.toHaveBeenCalled()
    expect(surface.request_path).toHaveBeenCalledWith(expect.objectContaining({
      bounding_box: character_prototype.collision_box,
      collision_mask: character_prototype.collision_mask,
      start: { x: position.x, y: position.y },
    }))
    expect(surface.request_path).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale path completion and accepts only the active request id', () => {
    const { actor, controller, manager } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const task = manager.player_state().parameters_walk_to_entity!
    const active_id = task.path_request_id!

    controller.on_path_finished({ id: active_id - 1, path: [waypoint(5)], try_again_later: false } as any)
    expect(task.calculating_path).toBe(true)
    expect(task.path).toBeNull()
    expect(task.path_request_id).toBe(active_id)

    controller.on_path_finished({ id: active_id, path: [waypoint(5), waypoint(18)], try_again_later: false } as any)
    expect(task.calculating_path).toBe(false)
    expect(task.path_request_id).toBeUndefined()
    expect(task.path).toHaveLength(2)
  })

  it('retries an unreachable route from the physical actor position before cancelling dependent work', () => {
    const { actor, controller, manager, surface } = make_context()
    controller.submit('steel-chest', 40)
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 600 })
    controller.tick(actor)

    for (let attempt = 1; attempt <= 4; attempt++) {
      const task = manager.player_state().parameters_walk_to_entity
      expect(task).toBeDefined()
      const request_id = task!.path_request_id!
      controller.on_path_finished({ id: request_id, path: undefined, try_again_later: false } as any)
      if (attempt < 4) {
        expect(manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
        expect(manager.get_status_snapshot().queue_length).toBe(1)
        ;(globalThis as any).game.tick += 30
        controller.tick(actor)
      }
    }

    expect(surface.request_path).toHaveBeenCalledTimes(4)
    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
    })
    expect(controller.status().last_result?.code).toBe('unreachable')
  })

  it('retries a busy pathfinder only a bounded number of times', () => {
    const { actor, controller, manager } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)

    for (let attempt = 1; attempt <= 4; attempt++) {
      const task = manager.player_state().parameters_walk_to_entity
      expect(task).toBeDefined()
      const request_id = task!.path_request_id!
      controller.on_path_finished({ id: request_id, path: undefined, try_again_later: true } as any)
      if (attempt < 4) {
        ;(globalThis as any).game.tick += 30
        controller.tick(actor)
      }
    }

    expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(controller.status().last_result?.code).toBe('path_busy')
  })

  it('replaces a timed-out path request and rejects the late old result', () => {
    const { actor, controller, manager, surface } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const task = manager.player_state().parameters_walk_to_entity!
    const first_id = task.path_request_id!

    ;(globalThis as any).game.tick = 901
    controller.tick(actor)
    const second_id = task.path_request_id!
    expect(second_id).not.toBe(first_id)
    expect(surface.request_path).toHaveBeenCalledTimes(2)

    controller.on_path_finished({ id: first_id, path: [waypoint(18)], try_again_later: false } as any)
    expect(task.path_request_id).toBe(second_id)
    expect(task.path).toBeNull()

    controller.on_path_finished({ id: second_id, path: [waypoint(18)], try_again_later: false } as any)
    expect(task.path).toHaveLength(1)
  })

  it('repaths when a bound target materially moves', () => {
    const { actor, controller, manager, target, surface } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const task = manager.player_state().parameters_walk_to_entity!
    const first_id = task.path_request_id!
    controller.on_path_finished({ id: first_id, path: [waypoint(18)], try_again_later: false } as any)

    target.position.x = 30
    controller.tick(actor)

    expect(surface.request_path).toHaveBeenCalledTimes(2)
    expect(task.target_position).toEqual({ x: 30, y: 0 })
    expect(task.path_request_id).toBeDefined()
  })

  it('bounds repeated no-progress recovery and reports stuck', () => {
    const { actor, controller, manager } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)

    for (let attempt = 1; attempt <= 4; attempt++) {
      const task = manager.player_state().parameters_walk_to_entity
      expect(task).toBeDefined()
      const request_id = task!.path_request_id!
      controller.on_path_finished({ id: request_id, path: [waypoint(18)], try_again_later: false } as any)
      ;(globalThis as any).game.tick += 601
      controller.tick(actor)
      if (attempt < 4) {
        expect(manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
      }
    }

    expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(controller.status().last_result?.code).toBe('stuck')
  })

  it('does not count sideways transport-belt displacement as navigation progress and repaths from the new physical position', () => {
    const { actor, controller, manager, position, surface } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const task = manager.player_state().parameters_walk_to_entity!
    const request_id = task.path_request_id!
    controller.on_path_finished({ id: request_id, path: [waypoint(18)], try_again_later: false } as any)

    // Model passive world motion: AIRI has changed coordinates substantially,
    // but is farther from the current waypoint rather than closer to it.
    position.y = 4
    ;(globalThis as any).game.tick = 601
    controller.tick(actor)

    expect(surface.request_path).toHaveBeenCalledTimes(2)
    expect(task.path_attempts).toBe(2)
    expect(surface.request_path.mock.calls[1]?.[0]).toMatchObject({ start: { x: 0, y: 4 } })
  })

  it('allows transport-belt motion toward the waypoint to count as real progress', () => {
    const { actor, controller, manager, position, surface } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const task = manager.player_state().parameters_walk_to_entity!
    const request_id = task.path_request_id!
    controller.on_path_finished({ id: request_id, path: [waypoint(18)], try_again_later: false } as any)

    // Passive displacement can legitimately help the task. If it materially
    // closes the waypoint distance, it should reset the no-progress timer.
    position.x = 1
    ;(globalThis as any).game.tick = 601
    controller.tick(actor)

    expect(surface.request_path).toHaveBeenCalledTimes(1)
    expect(task.last_progress_tick).toBe(601)
    expect(task.last_waypoint_distance).toBe(17)
  })

  it('reports retry timing and accumulated no-progress time for E2E diagnostics', () => {
    const { actor, controller, manager } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const request_id = manager.player_state().parameters_walk_to_entity!.path_request_id!
    controller.on_path_finished({ id: request_id, path: undefined, try_again_later: false } as any)

    expect(controller.status().path).toMatchObject({
      attempts: 1,
      retry_at_tick: 30,
      stuck_for_ticks: 0,
    })
  })

  it('completes only when the bound target is actually within reach', () => {
    const { actor, controller, manager, position } = make_context()
    controller.submit('steel-chest', 40)
    controller.tick(actor)
    const request_id = manager.player_state().parameters_walk_to_entity!.path_request_id!
    controller.on_path_finished({ id: request_id, path: [waypoint(18)], try_again_later: false } as any)

    position.x = 18
    ;(globalThis as any).game.tick = 20
    controller.tick(actor)

    expect(manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(controller.status().last_result).toMatchObject({ accepted: true, completed: true, code: 'reached' })
  })
})
