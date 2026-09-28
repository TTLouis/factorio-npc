import { describe, expect, it } from 'vitest'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

// A client joining a running multiplayer game loads `storage` from the save but
// runs control.lua fresh. Creating a second task manager over the same storage
// models that peer: it must see exactly the server's task state, otherwise the
// next task transition desyncs the client.
describe('task manager state persistence', () => {
  it('shares task state with a freshly created manager over the same storage', () => {
    const server = new_task_manager(() => undefined)
    server.add_task({ type: TaskStates.WAITING, remaining_ticks: 120 })
    server.add_task({ type: TaskStates.WAITING, remaining_ticks: 60 })

    const joining_peer = new_task_manager(() => undefined)

    expect(joining_peer.player_state().task_state).toBe(TaskStates.WAITING)
    expect(joining_peer.get_status_snapshot()).toEqual(server.get_status_snapshot())
    expect(joining_peer.get_status_snapshot().active_batch?.batch_id).toBe(1)
  })

  it('keeps batch numbering continuous for a freshly created manager', () => {
    const server = new_task_manager(() => undefined)
    server.add_task({ type: TaskStates.WAITING, remaining_ticks: 1 })
    server.cancel_all_tasks('test')

    const joining_peer = new_task_manager(() => undefined)
    joining_peer.add_task({ type: TaskStates.WAITING, remaining_ticks: 1 })

    expect(joining_peer.get_status_snapshot().active_batch?.batch_id).toBe(2)
    expect(joining_peer.get_status_snapshot().last_cancelled_batch?.batch_id).toBe(1)
  })
})
