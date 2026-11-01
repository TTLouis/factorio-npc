import { describe, expect, it } from 'vitest'

import { sanitize_task_board_ui_snapshot, stamp_activity_times } from './task_board_ui'

function snapshot(activity: Array<{ id?: string, kind: string, text: string, timestamp?: string }>) {
  return sanitize_task_board_ui_snapshot({
    goal_id: '',
    objective: '',
    status: 'idle',
    blocker: '',
    pause_reason: '',
    completed_count: 0,
    total_steps: 0,
    active_index: 0,
    steps: [],
    activity,
    wanted_items: [],
    agent: { phase: 'idle', detail: '' },
  })!
}

describe('task board activity timestamps', () => {
  it('preserves the first-seen time for the same event identity', () => {
    const first = stamp_activity_times(snapshot([
      { id: 'live_1', kind: 'observation', text: 'Tool getActorStatus' },
    ]), undefined, 60)

    const heartbeat = stamp_activity_times(snapshot([
      { id: 'live_1', kind: 'observation', text: 'Tool getActorStatus' },
    ]), first, 180)

    expect(first.activity[0]).toMatchObject({ id: 'live_1', timestamp: '00:00:01' })
    expect(heartbeat.activity[0]).toMatchObject({ id: 'live_1', timestamp: '00:00:01' })
  })

  it('keeps the first-seen time of a derived entry that falls out of the window and comes back', () => {
    const storage = (globalThis as any).storage
    storage.sgluna_task_board_activity_history = [
      { kind: 'result', text: 'Verified batch 26 complete (craft_item)', timestamp: '00:00:01' },
      { kind: 'action', text: 'mine_resource {}', timestamp: '00:00:02' },
      { kind: 'action', text: 'mine_resource {}', timestamp: '00:00:03' },
    ]
    try {
      // The previous snapshot no longer holds any of these entries.
      const returned = stamp_activity_times(snapshot([
        { kind: 'result', text: 'Verified batch 26 complete (craft_item)' },
        { kind: 'action', text: 'mine_resource {}' },
        { kind: 'action', text: 'mine_resource {}' },
        { kind: 'action', text: 'mine_resource {}' },
      ]), snapshot([]), 600)
      expect(returned.activity.map(entry => entry.timestamp)).toEqual(['00:00:01', '00:00:03', '00:00:02', '00:00:10'])
    }
    finally {
      delete storage.sgluna_task_board_activity_history
    }
  })

  it('gives repeated text a new time when its event identity changes', () => {
    const first = stamp_activity_times(snapshot([
      { id: 'live_1', kind: 'observation', text: 'Tool getActorStatus' },
    ]), undefined, 60)

    const second = stamp_activity_times(snapshot([
      { id: 'live_1', kind: 'observation', text: 'Tool getActorStatus' },
      { id: 'live_2', kind: 'observation', text: 'Tool getActorStatus' },
    ]), first, 180)

    expect(second.activity).toEqual([
      { id: 'live_1', kind: 'observation', text: 'Tool getActorStatus', timestamp: '00:00:01' },
      { id: 'live_2', kind: 'observation', text: 'Tool getActorStatus', timestamp: '00:00:03' },
    ])
  })
})
