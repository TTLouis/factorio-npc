import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_navigation_controller } from './navigation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function waypoint(x: number, y = 0) { return { position: { x, y }, needs_destroy_to_reach: false } }

function fixture() {
  let requestId = 10
  const position = { x: 0, y: 0 }
  const target: any = { valid: true, name: 'steel-chest', unit_number: 80, position: { x: 20, y: 0 } }
  const character: any = {
    valid: true, name: 'character', unit_number: 1, position,
    prototype: { collision_box: [[-0.2, -0.2], [0.2, 0.2]], collision_mask: { layers: { player: true } } },
  }
  const surface: any = {
    index: 1, name: 'nauvis',
    find_entities_filtered: vi.fn((args: any) => args.area ? [] : [target]),
    get_tile: vi.fn(() => ({ name: 'water' })),
    find_non_colliding_position: vi.fn((_name: string, desired: any) => ({ x: desired.x, y: desired.y + 2 })),
    request_path: vi.fn(() => ++requestId),
  }
  const actor = {
    is_valid: true, character, position, surface, force: { index: 1 },
    status_snapshot: () => ({ actor_id: 1, kind: 'standalone_character', valid: true, has_character: true, position }),
    set_walking_state: vi.fn(),
  } as unknown as ControlledActor
  const manager = new_task_manager(() => actor)
  const controller = new_navigation_controller(() => actor, manager)
  return { actor, position, target, surface, manager, controller }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('physical navigation recovery', () => {
  it('detects physical no-displacement substantially before the old ten-second timeout', () => {
    const f = fixture()
    f.controller.submit('steel-chest', 40)
    f.controller.tick(f.actor)
    const task = f.manager.player_state().parameters_walk_to_entity!
    f.controller.on_path_finished({ id: task.path_request_id!, path: [waypoint(18)], try_again_later: false } as any)

    ;(globalThis as any).game.tick = 30
    f.controller.tick(f.actor)
    ;(globalThis as any).game.tick = 60
    f.controller.tick(f.actor)
    ;(globalThis as any).game.tick = 90
    f.controller.tick(f.actor)

    expect(f.surface.request_path).toHaveBeenCalledTimes(2)
    expect((f.manager.player_state().parameters_walk_to_entity as any).last_recovery_reason).toBe('physical_stuck')
  })

  it('escalates repeated path failure to a local spatial escape point before the final attempt', () => {
    const f = fixture()
    f.controller.submit('steel-chest', 40)
    f.controller.tick(f.actor)
    let task: any = f.manager.player_state().parameters_walk_to_entity
    f.controller.on_path_finished({ id: task.path_request_id, path: undefined, try_again_later: false } as any)
    ;(globalThis as any).game.tick = 30
    f.controller.tick(f.actor)
    task = f.manager.player_state().parameters_walk_to_entity
    f.controller.on_path_finished({ id: task.path_request_id, path: undefined, try_again_later: false } as any)
    ;(globalThis as any).game.tick = 60
    f.controller.tick(f.actor)

    task = f.manager.player_state().parameters_walk_to_entity as any
    expect(task.recovery_position).toBeDefined()
    expect(task.recovery_stage).toBe('escape')
    expect(task.last_spatial_observation).toMatchObject({ ok: true })
    expect(f.surface.request_path.mock.calls[2][0].goal).toEqual(task.recovery_position)
  })

  it('becomes explicitly blocked after bounded recovery failure', () => {
    const f = fixture()
    f.controller.submit('steel-chest', 40)
    f.manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 100 })
    f.controller.tick(f.actor)

    for (let attempt = 1; attempt <= 4; attempt++) {
      const task: any = f.manager.player_state().parameters_walk_to_entity
      expect(task).toBeDefined()
      f.controller.on_path_finished({ id: task.path_request_id, path: undefined, try_again_later: false } as any)
      if (attempt < 4) {
        ;(globalThis as any).game.tick += 30
        f.controller.tick(f.actor)
      }
    }

    expect(f.manager.player_state().task_state).toBe(TaskStates.IDLE)
    expect(f.controller.status()).toMatchObject({ state: 'blocked', blocked_reason: 'unreachable', last_result: { code: 'unreachable' } })
  })
})
