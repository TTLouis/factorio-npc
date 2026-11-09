import assert from 'node:assert/strict'
import test from 'node:test'

import { measureWindow } from './measure-window.mjs'

// Fake RCON: snapshot reads, then arm, then one status poll that shows the lease ended.
function fakeRcon({ before, after, armed = { ok: true } }) {
  const calls = []
  let reads = 0
  return {
    calls,
    async command(text) {
      calls.push(text)
      if (text.includes('"arm"')) return JSON.stringify({ ...armed, lease: armed.ok ? { measurement_id: 'unit-window-1' } : undefined })
      if (text.includes('(function() local g=')) return JSON.stringify(reads++ === 0 ? before : after)
      return JSON.stringify({ lease: null })
    },
  }
}

const guard = { actor_id: 7, epoch: 3 }
const work = { task_state: 'idle', queue_length: 0, active: false }

test('rates use the interval the statistics cover, not only the lease', async () => {
  // Lease of 3600 ticks; the snapshots sit 120 ticks outside it (polling at 1x). 62 plates over 3720 ticks is 60 per minute (62 over the lease alone would read 62).
  const before = { tick: 1000, speed: 1, humans: 0, guard, work, measurement: {}, items: { 'iron-plate': { produced: 0, consumed: 0 } }, fluids: {}, researched: [], research: { queue: [] }, actor_inventory: [] }
  const after = { tick: 4720, speed: 1, humans: 0, guard, work, items: { 'iron-plate': { produced: 62, consumed: 0 } }, fluids: {}, researched: [], research: { queue: [] }, actor_inventory: [],
    measurement: { last: { measurement_id: 'unit-window-1', reason: 'window_complete', start_tick: 1010, end_tick: 4610, restored_tick: 4610, actual_ticks: 3600, native_checks: 3600 } } }
  const rcon = fakeRcon({ before, after })
  const result = await measureWindow({ rcon, speed: 8, ticks: 3600, measurementId: 'unit-window-1', sleep: async () => {} })
  assert.equal(result.valid_window, true)
  assert.equal(result.native.actual_ticks, 3600)
  assert.deepEqual(result.rate_interval, { from_tick: 1000, to_tick: 4720, ticks: 3720, outside_lease_ticks: 120 })
  assert.equal(result.items['iron-plate'].produced_per_minute, 60)
})

test('a window that is not ready is never armed', async () => {
  const before = { tick: 1, speed: 1, humans: 1, guard, work, measurement: {}, items: {}, fluids: {}, researched: [], research: { queue: [] }, actor_inventory: [] }
  const rcon = fakeRcon({ before, after: before })
  const result = await measureWindow({ rcon, ticks: 600, measurementId: 'unit-window-2', sleep: async () => {} })
  assert.equal(result.code, 'measurement_not_ready')
  assert.ok(!rcon.calls.some(text => text.includes('"arm"')))
})
