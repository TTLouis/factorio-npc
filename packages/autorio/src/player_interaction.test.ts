import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function inventoryWith(count: number) {
  const stack = { count }
  return {
    stack,
    find_item_stack: vi.fn(() => stack.count > 0 ? [stack, 1] : [undefined, undefined]),
    get_item_count: vi.fn(() => stack.count),
    can_insert: vi.fn(() => true),
    insert: vi.fn(({ count: amount }: { count: number }) => amount),
    remove: vi.fn(({ count: amount }: { count: number }) => {
      const removed = Math.min(stack.count, amount)
      stack.count -= removed
      return removed
    }),
  }
}

function context(actorCount = 10, playerCount = 0) {
  const actorInventory = inventoryWith(actorCount)
  const playerInventory = inventoryWith(playerCount)
  const actor = {
    is_valid: true,
    character: { valid: true },
    force: { index: 1 },
    surface: { index: 1 },
    position: { x: 0, y: 0 },
    get_main_inventory: vi.fn(() => actorInventory),
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    status_snapshot: vi.fn(() => ({
      actor_id: 18,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'AIRI',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const player = {
    valid: true,
    connected: true,
    character: { valid: true },
    surface: { index: 1 },
    position: { x: 2, y: 0 },
    get_main_inventory: vi.fn(() => playerInventory),
  }
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_basic_operation_controller(resolve, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  ;(globalThis as any).game.get_player = vi.fn((name: string) => name === 'TTLouis' ? player : undefined)
  return { actor, player, actorInventory, playerInventory, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
})

describe('standalone NPC player item interaction', () => {
  it('queues a player transfer with actor ownership and exact player identity', () => {
    const c = context()
    expect(c.controller.submit_player_move('stone', 'TTLouis', 10, true)[0]).toBe(true)
    expect(c.manager.player_state.task_state).toBe(TaskStates.MOVING_ITEMS)
    expect(c.manager.player_state.parameters_move_items).toMatchObject({
      owner_actor_id: 18,
      player_name: 'TTLouis',
      item_name: 'stone',
      max_count: 10,
      to_player: true,
    })
  })

  it('moves items from AIRI to a nearby connected player and completes the queued task', () => {
    const c = context(10, 0)
    c.controller.submit_player_move('stone', 'TTLouis', 10, true)

    expect(c.runtime.state_moving_items(c.actor)).toBe(10)
    expect(c.playerInventory.insert).toHaveBeenCalledWith({ name: 'stone', count: 10 })
    expect(c.actorInventory.remove).toHaveBeenCalledWith({ name: 'stone', count: 10 })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      player_name: 'TTLouis',
      item_name: 'stone',
      moved_count: 10,
      to_player: true,
    })
  })

  it('moves items from a nearby player into AIRI inventory', () => {
    const c = context(0, 7)
    c.controller.submit_player_move('iron-plate', 'TTLouis', 5, false)

    expect(c.runtime.state_moving_items(c.actor)).toBe(5)
    expect(c.playerInventory.remove).toHaveBeenCalledWith({ name: 'iron-plate', count: 5 })
    expect(c.actorInventory.insert).toHaveBeenCalledWith({ name: 'iron-plate', count: 5 })
    expect(c.controller.status().last_result).toMatchObject({ code: 'completed', moved_count: 5, to_player: false })
  })

  it('fails closed when the player is too far away', () => {
    const c = context(10, 0)
    c.player.position.x = 20
    c.controller.submit_player_move('stone', 'TTLouis', 10, true)

    expect(c.runtime.state_moving_items(c.actor)).toBe(0)
    expect(c.controller.status().last_result).toMatchObject({ code: 'too_far', accepted: false, completed: false })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})
