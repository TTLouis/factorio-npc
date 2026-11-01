import type { ControlledActor } from './actors/types'
import type { PlayerParameters } from './types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_TASK_STATE_CONTRACT_COMPLETE,
  SUPPORTED_RUNTIME_TASK_STATES,
  is_runtime_task_state,
} from './task_state_runtime'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function controlled_actor() {
  return {
    is_valid: true,
    character: { valid: true },
    position: { x: 0, y: 0 },
    set_walking_state: vi.fn(),
    set_mining_state: vi.fn(),
    set_shooting_state: vi.fn(),
    get_crafting_queue_count: vi.fn(() => 0),
  } as unknown as ControlledActor
}

beforeEach(() => {
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.print = vi.fn()
  ;(globalThis as any).log = vi.fn()
})

describe('task runtime supported-state contract', () => {
  it('covers every non-IDLE TaskStates member exactly and excludes removed legacy states', () => {
    const enum_states = Object.values(TaskStates)
      .filter(state => state !== TaskStates.IDLE)
      .sort()

    expect(RUNTIME_TASK_STATE_CONTRACT_COMPLETE).toBe(true)
    expect([...SUPPORTED_RUNTIME_TASK_STATES].sort()).toEqual(enum_states)
    for (const state of SUPPORTED_RUNTIME_TASK_STATES) {
      expect(is_runtime_task_state(state)).toBe(true)
    }
    expect(Object.values(TaskStates)).not.toContain('placing_in_chest')
    expect(Object.values(TaskStates)).not.toContain('picking_up')
  })

  it('rejects an unsupported queued task as a batch failure instead of activating it', () => {
    const actor = controlled_actor()
    const manager = new_task_manager(() => actor)

    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 30,
      requested_ticks: 30,
    })
    manager.add_task({
      type: 'future_unsupported_task_state',
    } as unknown as PlayerParameters)
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
      requested_ticks: 60,
    })

    manager.reset_task_state()
    manager.next_task()

    const status = manager.get_status_snapshot()
    expect(status.task_state).toBe(TaskStates.IDLE)
    expect(status.queue_empty).toBe(true)
    expect(status.queue_length).toBe(0)
    expect(status.active_batch).toBeUndefined()
    expect(status.last_completed_batch).toBeUndefined()
    expect(status.last_cancelled_batch).toMatchObject({
      task_count: 3,
      reason: 'unsupported_task_state:future_unsupported_task_state',
    })
    expect(actor.set_walking_state).toHaveBeenCalledWith({ walking: false, direction: defines.direction.north })
    expect(actor.set_mining_state).toHaveBeenCalledWith({ mining: false })
    expect(actor.set_shooting_state).toHaveBeenCalledWith({ state: defines.shooting.not_shooting, position: actor.position })
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('ERROR unsupported task state'))
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('queued_task_count=1'))
    expect((globalThis as any).log).toHaveBeenCalledWith(expect.stringContaining('reason=unsupported_task_state:future_unsupported_task_state'))
  })
})
