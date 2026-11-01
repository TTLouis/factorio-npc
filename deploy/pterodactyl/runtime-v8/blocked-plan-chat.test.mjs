import assert from 'node:assert/strict'
import test from 'node:test'

import { planProgress } from './npc-agent-loop.mjs'

// Live DeepSeek run 2026-09-29, finding 4: a plan blocked on
// transfer_failed:item_missing ended with an empty chat line.
const blocked = {
  state: {
    status: 'blocked',
    blocker: 'transfer_failed:item_missing',
    task_board: {
      status: 'blocked',
      active_index: 1,
      completed_count: 1,
      steps: [
        { id: 'step_1', description: 'Gather iron ore', status: 'completed' },
        { id: 'step_2', description: 'Smelt iron plates', status: 'blocked' },
      ],
    },
  },
}

test('a blocked plan with an empty model reply tells the player the blocker and the choices', () => {
  const line = planProgress({ chatMessage: '', operations: [] }, blocked)
  assert.match(line, /^\[Plan blocked\] /)
  assert.match(line, /transfer failed item missing/)
  assert.match(line, /Revise or Cancel/)
  assert.match(line, /say in chat what to change/)
})

test('a blocked plan keeps the model\'s own words, tagged, without a second explanation', () => {
  const line = planProgress({ chatMessage: 'I ran out of coal for the furnace.', operations: [] }, blocked)
  assert.equal(line, '[Plan blocked] I ran out of coal for the furnace.')
})

test('a plan the harness blocked gets the same line', () => {
  const line = planProgress({ chatMessage: '', operations: [] }, { ...blocked, state: { ...blocked.state, status: 'active' }, blockedByHarness: true })
  assert.match(line, /^\[Plan blocked\] .*Revise or Cancel/)
})
