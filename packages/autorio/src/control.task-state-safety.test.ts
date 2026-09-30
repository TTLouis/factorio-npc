import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime_dispatch_has_handler, task_manager } from './control'
import { SUPPORTED_RUNTIME_TASK_STATES } from './task_state_runtime'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

function connect_controlled_player() {
  const player = {
    valid: true,
    index: 1,
    name: 'SGLuna',
    character: { valid: true },
    position: { x: 0, y: 0 },
    surface: {
      index: 1,
      find_entities_filtered: vi.fn(() => []),
    },
    force: { index: 1 },
    walking_state: { walking: true, direction: defines.direction.east },
    mining_state: { mining: true },
    shooting_state: { state: defines.shooting.shooting_selected, position: { x: 1, y: 0 } },
    crafting_queue: [],
    get_craftable_count: vi.fn(() => 0),
    begin_crafting: vi.fn(() => 0),
    cancel_crafting: vi.fn(),
  }
  ;(globalThis as any).game.connected_players = [player]
  return player
}

function owned_wait(remaining_ticks: number) {
  return {
    type: TaskStates.WAITING,
    owner_actor_id: 1,
    owner_actor_kind: 'connected_player',
    owner_force_index: 1,
    remaining_ticks,
    requested_ticks: remaining_ticks,
  } as const
}

beforeEach(() => {
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).game.tick = 200
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).storage.sgluna_actor_mode = 'player'
  task_manager.cancel_all_tasks()
})

describe('control runtime task-state safety', () => {
  it('has an actual dispatcher entry for every supported runtime state', () => {
    for (const state of SUPPORTED_RUNTIME_TASK_STATES) {
      expect(runtime_dispatch_has_handler(state)).toBe(true)
    }
  })

  it('dispatches a normal supported WAITING state to its existing controller', () => {
    connect_controlled_player()
    task_manager.add_task(owned_wait(0))

    get_handler('on_tick')({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(task_manager.get_status_snapshot().last_completed_batch).toMatchObject({
      task_count: 1,
      task_types: [TaskStates.WAITING],
    })
  })

  it('fails a corrupted live state once, cancels dependent work, stops controls, and settles idle', () => {
    const player = connect_controlled_player()
    task_manager.add_task(owned_wait(120))
    task_manager.add_task(owned_wait(240))

    task_manager.player_state.task_state = 'restored_legacy_state' as TaskStates

    const on_tick = get_handler('on_tick')
    on_tick({})

    expect(task_manager.get_status_snapshot()).toMatchObject({
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      active_batch: undefined,
      last_cancelled_batch: {
        task_count: 2,
        reason: 'unsupported_task_state:restored_legacy_state',
      },
    })
    expect(player.walking_state).toEqual({ walking: false, direction: defines.direction.north })
    expect(player.mining_state).toEqual({ mining: false })
    expect(player.shooting_state).toEqual({ state: defines.shooting.not_shooting, position: player.position })

    const errors_after_first_tick = (globalThis as any).log.mock.calls
      .filter((call: unknown[]) => String(call[0]).includes('ERROR unsupported task state')).length
    expect(errors_after_first_tick).toBe(1)

    on_tick({})

    const errors_after_second_tick = (globalThis as any).log.mock.calls
      .filter((call: unknown[]) => String(call[0]).includes('ERROR unsupported task state')).length
    expect(errors_after_second_tick).toBe(1)
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
  })
})
