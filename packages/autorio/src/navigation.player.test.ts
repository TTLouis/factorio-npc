import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_navigation_controller } from './navigation'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function context() {
  let nextRequestId = 10
  const position = { x: 0, y: 0 }
  const npcCharacter = {
    valid: true,
    name: 'character',
    unit_number: 18,
    position,
    prototype: {
      collision_box: [[-0.2, -0.2], [0.2, 0.2]],
      collision_mask: { layers: { player: true } },
    },
  }
  const playerCharacter = {
    valid: true,
    name: 'character',
    unit_number: 99,
    position: { x: 30, y: 5 },
  }
  const surface = {
    index: 1,
    find_entities_filtered: vi.fn(() => [npcCharacter]),
    find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
    request_path: vi.fn(() => ++nextRequestId),
  }
  const actor = {
    is_valid: true,
    character: npcCharacter,
    position,
    surface,
    force: { index: 1 },
    status_snapshot: vi.fn(() => ({ actor_id: 18, kind: 'standalone_character', valid: true, has_character: true })),
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
  } as unknown as ControlledActor
  const player = {
    valid: true,
    connected: true,
    character: playerCharacter,
    surface: { index: 1 },
    position: playerCharacter.position,
  }
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_navigation_controller(resolve, manager)
  ;(globalThis as any).game.get_player = vi.fn((name: string) => name === 'TTLouis' ? player : undefined)
  return { actor, player, playerCharacter, surface, manager, controller }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 0
})

describe('finite navigation to an exact player', () => {
  it('binds the requested player character instead of the nearest generic character entity', () => {
    const c = context()
    expect(c.controller.submit_player('TTLouis')[0]).toBe(true)
    c.controller.tick(c.actor)

    expect(c.manager.player_state().task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(c.manager.player_state().parameters_walk_to_entity).toMatchObject({
      target_player_name: 'TTLouis',
      target_unit_number: 99,
      target_position: { x: 30, y: 5 },
    })
    expect(c.surface.find_entities_filtered).not.toHaveBeenCalled()
    expect(c.surface.request_path).toHaveBeenCalledWith(expect.objectContaining({ goal: { x: 30, y: 5 } }))
  })

  it('rejects unavailable or cross-surface players without queueing movement', () => {
    const c = context()
    ;(globalThis as any).game.get_player = vi.fn(() => undefined)
    expect(c.controller.submit_player('Missing')[0]).toBe(false)
    expect(c.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })

    const c2 = context()
    c2.player.surface.index = 2
    expect(c2.controller.submit_player('TTLouis')[0]).toBe(false)
    expect(c2.manager.get_status_snapshot()).toMatchObject({ task_state: TaskStates.IDLE, queue_length: 0 })
  })
})
