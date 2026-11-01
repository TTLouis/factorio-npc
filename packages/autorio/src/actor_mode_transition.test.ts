import type { ControlledActor } from './actors/types'
import { get_actor_mode, register_actor_mode_transition_handler, set_actor_mode } from './actors/actor_controller'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fake_actor(kind: 'connected_player' | 'standalone_character', id: number) {
  return {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    force: { index: 1 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_crafting_queue_count: vi.fn(() => 0),
    status_snapshot: vi.fn(() => ({
      actor_id: id,
      kind,
      valid: true,
      has_character: true,
      name: kind === 'connected_player' ? 'Louis' : 'SGLuna',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).storage = { sgluna_actor_mode: 'player' }
  ;(globalThis as any).game = { print: vi.fn() }
  register_actor_mode_transition_handler(undefined)
})

describe('actor mode transitions are ownership boundaries', () => {
  it('stops and discards player-owned work before selecting the npc actor', () => {
    const player = fake_actor('connected_player', 1)
    const npc = fake_actor('standalone_character', 42)
    const resolve = vi.fn(() => get_actor_mode() === 'player' ? player : npc)
    const manager = new_task_manager(resolve)

    manager.add_task({
      type: TaskStates.WALKING_DIRECT,
      target_position: { x: 20, y: 0 },
    })
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 600 })

    set_actor_mode('npc')

    expect(get_actor_mode()).toBe('npc')
    expect(player.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: defines.direction.north })
    expect(npc.set_walking_state).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
    })
    // Cleanup must resolve while the old mode is still active. If mode were
    // changed first, this call would return the NPC and stop the wrong body.
    expect(resolve).toHaveReturnedWith(player)
  })

  it('stops and discards npc-owned work before selecting a connected player', () => {
    ;(globalThis as any).storage.sgluna_actor_mode = 'npc'
    const player = fake_actor('connected_player', 1)
    const npc = fake_actor('standalone_character', 42)
    const resolve = vi.fn(() => get_actor_mode() === 'npc' ? npc : player)
    const manager = new_task_manager(resolve)

    manager.add_task({
      type: TaskStates.MINING,
      entity_name: 'iron-ore',
      count: 3,
    })
    manager.add_task({ type: TaskStates.WAITING, remaining_ticks: 600 })

    set_actor_mode('player')

    expect(get_actor_mode()).toBe('player')
    expect(npc.set_mining_state).toHaveBeenCalledWith({ mining: false })
    expect(player.set_mining_state).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
    })
    expect(resolve).toHaveReturnedWith(npc)
  })

  it('does not resolve an actor merely to change mode when no work exists', () => {
    const resolve = vi.fn(() => fake_actor('connected_player', 1))
    new_task_manager(resolve)

    set_actor_mode('npc')

    expect(get_actor_mode()).toBe('npc')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not invoke transition cleanup when setting the existing mode again', () => {
    const handler = vi.fn()
    register_actor_mode_transition_handler(handler)

    set_actor_mode('player')

    expect(handler).not.toHaveBeenCalled()
  })
})
