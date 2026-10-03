import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('task manager status snapshot', () => {
  it('reports idle state without exposing runtime objects', () => {
    const manager = new_task_manager(() => undefined)

    expect(manager.get_status_snapshot()).toEqual({
      receipt_journal: [],
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: undefined,
      batch_generation: 1,
      active_batch: undefined,
      last_completed_batch: undefined,
      last_cancelled_batch: undefined,
    })
  })

  it('reports the current task, queued task types, and active batch receipt', () => {
    const manager = new_task_manager(() => undefined)

    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 120,
    })
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
    })

    expect(manager.get_status_snapshot()).toEqual({
      receipt_journal: [],
      task_state: TaskStates.WAITING,
      queue_empty: false,
      queue_length: 1,
      queued_task_types: [TaskStates.WAITING],
      current_task: {
        type: TaskStates.WAITING,
        remaining_ticks: 120,
      },
      batch_generation: 1,
      active_batch: {
        batch_id: 1,
        batch_generation: 1,
        batch_ref: 'batch-g1-1',
        task_count: 2,
        task_types: [TaskStates.WAITING, TaskStates.WAITING],
      },
      last_completed_batch: undefined,
      last_cancelled_batch: undefined,
    })
  })

  it('reports crafting progress supplied by the crafting controller without starting native crafting itself', () => {
    const begin_crafting = vi.fn(() => 2)
    const get_crafting_queue_count = vi.fn(() => 2)
    const actor = {
      begin_crafting,
      get_crafting_queue_count,
    } as unknown as ControlledActor
    const manager = new_task_manager(() => actor)

    manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 2,
      crafted: 0,
    })

    // The task manager owns ordering/status only. Native admission/start is
    // performed later by crafting_controller.tick(). Simulate the controller's
    // bounded progress fields to verify the status snapshot contract.
    const task = manager.player_state.parameters_craft_item
    expect(task).toBeDefined()
    if (!task) {
      throw new Error('crafting task was not activated')
    }
    task.started = 2
    task.owns_native_queue = true

    expect(begin_crafting).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toEqual({
      receipt_journal: [],
      task_state: TaskStates.CRAFTING,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: {
        type: TaskStates.CRAFTING,
        item_name: 'iron-gear-wheel',
        count: 2,
        crafted: 0,
        started: 2,
        owns_native_queue: true,
        queued_crafts: 2,
      },
      batch_generation: 1,
      active_batch: {
        batch_id: 1,
        batch_generation: 1,
        batch_ref: 'batch-g1-1',
        task_count: 1,
        task_types: [TaskStates.CRAFTING],
      },
      last_completed_batch: undefined,
      last_cancelled_batch: undefined,
    })
  })

  it('leaves native craft admission failure to the crafting controller instead of silently ending the task', () => {
    const actor = {
      begin_crafting: vi.fn(() => 0),
      get_crafting_queue_count: vi.fn(() => 0),
    } as unknown as ControlledActor
    const manager = new_task_manager(() => actor)

    manager.add_task({
      type: TaskStates.CRAFTING,
      item_name: 'iron-gear-wheel',
      count: 2,
      crafted: 0,
    })

    expect(actor.begin_crafting).not.toHaveBeenCalled()
    expect(manager.get_status_snapshot()).toEqual({
      receipt_journal: [],
      task_state: TaskStates.CRAFTING,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: {
        type: TaskStates.CRAFTING,
        item_name: 'iron-gear-wheel',
        count: 2,
        crafted: 0,
        started: undefined,
        owns_native_queue: false,
        queued_crafts: 0,
      },
      batch_generation: 1,
      active_batch: {
        batch_id: 1,
        batch_generation: 1,
        batch_ref: 'batch-g1-1',
        task_count: 1,
        task_types: [TaskStates.CRAFTING],
      },
      last_completed_batch: undefined,
      last_cancelled_batch: undefined,
    })
  })

  it('clears current and queued task status when all tasks are cancelled while retaining the cancellation receipt', () => {
    const manager = new_task_manager(() => undefined)

    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 120,
    })
    manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: 60,
    })
    manager.cancel_all_tasks()

    expect(manager.get_status_snapshot()).toEqual({
      receipt_journal: [{
        batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1',
        task_count: 2, task_types: [TaskStates.WAITING, TaskStates.WAITING],
        tick: 0, reason: 'cancelled', state: 'cancelled',
      }],
      task_state: TaskStates.IDLE,
      queue_empty: true,
      queue_length: 0,
      queued_task_types: [],
      current_task: undefined,
      batch_generation: 1,
      active_batch: undefined,
      last_completed_batch: undefined,
      last_cancelled_batch: {
        batch_id: 1,
        batch_generation: 1,
        batch_ref: 'batch-g1-1',
        task_count: 2,
        task_types: [TaskStates.WAITING, TaskStates.WAITING],
        tick: 0,
        reason: 'cancelled',
      },
    })
  })
})