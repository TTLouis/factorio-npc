import assert from 'node:assert/strict'
import test from 'node:test'

import { checkpointWaitRequirement, conditionEta, MARGIN_SECONDS, OVERRUN_FACTOR, safeWaitSchedule, scheduleWait } from './production-wait.mjs'
import { makeConditionWait } from './step-completion.mjs'

const now = 1_000_000

function completionWait() {
  return makeConditionWait(
    { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 },
    { goalId: 'goal', stepId: 'step_1', actorId: 18, actorEpoch: 3, now },
  )
}

test('reads a compact machine expectation from a condition observation and nothing else', () => {
  assert.deepEqual(conditionEta({
    eta: { recipe: 'iron-plate', seconds_per_craft: 3.2, crafts_needed: 10, seconds_to_target: 30.44, seconds_until_idle: 32, limited_by: 'fuel', basis: 'long text' },
  }), { recipe: 'iron-plate', seconds_to_target: 30.4, seconds_until_idle: 32, seconds_per_craft: 3.2, crafts_needed: 10, limited_by: 'fuel' })
  assert.equal(conditionEta({}), undefined)
  assert.equal(conditionEta({ eta: { seconds_to_target: -1 } }), undefined)
  assert.equal(conditionEta({ eta: { seconds_to_target: 'soon' } }), undefined)
  assert.equal(conditionEta({ eta: { seconds_to_target: 4, limited_by: 'guess' } }).limited_by, undefined)
})

test('a completion wait takes its deadline from the machine: expected x 1.5 + margin, once', () => {
  // 10 plates at 3.2 s each on a stone furnace.
  const first = scheduleWait(completionWait(), { seconds_to_target: 32 }, { now: now + 4000 })
  assert.equal(first.scheduled, true)
  assert.equal(first.wait.expected_seconds, 32)
  assert.equal(first.wait.expected_finish_at, now + 4000 + 32_000)
  // 4 s already waited + 32 x 1.5 + 30 s.
  assert.equal(first.wait.timeout_ms, 4000 + (32 * OVERRUN_FACTOR + MARGIN_SECONDS) * 1000)
  assert.ok(first.wait.max_checks * 2000 >= first.wait.timeout_ms, 'the check budget must not end the wait first')

  // Later polls refresh the expected finish but never move the deadline.
  const later = scheduleWait(first.wait, { seconds_to_target: 100 }, { now: now + 10_000 })
  assert.equal(later.scheduled, false)
  assert.equal(later.wait.timeout_ms, first.wait.timeout_ms)
  assert.equal(later.wait.expected_seconds, 100)
})

test('long machine jobs extend the default check budget instead of timing out at 30 minutes', () => {
  const scheduled = scheduleWait(completionWait(), { seconds_to_target: 3600 }, { now })
  assert.equal(scheduled.wait.timeout_ms, (3600 * 1.5 + 30) * 1000)
  assert.ok(scheduled.wait.max_checks > 900)
  const capped = scheduleWait(completionWait(), { seconds_to_target: 100_000 }, { now })
  assert.equal(capped.wait.timeout_ms, 2 * 60 * 60 * 1000)
  assert.equal(capped.wait.max_checks, 3602)
})

test('a passive wait may be lengthened by game data but never cut below its default bound', () => {
  const passive = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { goalId: 'goal', stepId: 'step_1', actorId: 18, actorEpoch: 3, mode: 'passive_progress', now },
  )
  // One loaded ore: a fed furnace outlives it, and a stop wakes the planner anyway.
  const short = scheduleWait(passive, { seconds_until_idle: 3.2, seconds_to_target: 1 }, { now })
  assert.equal(short.wait.expected_seconds, 3.2)
  assert.equal(short.wait.timeout_ms, passive.timeout_ms)
  const long = scheduleWait(passive, { seconds_until_idle: 3000 }, { now })
  assert.equal(long.wait.timeout_ms, (3000 * 1.5 + 30) * 1000)
})

test('without a game-data expectation nothing is scheduled or guessed', () => {
  const wait = completionWait()
  const result = scheduleWait(wait, undefined, { now })
  assert.equal(result.scheduled, false)
  assert.equal(result.wait, wait)
  // A passive expectation does not schedule a completion wait.
  assert.equal(scheduleWait(wait, { seconds_until_idle: 30 }, { now }).scheduled, false)
})

test('persisted schedules keep only bounded fields', () => {
  assert.deepEqual(safeWaitSchedule({ expected_seconds: 12.34, expected_finish_at: 5, eta_scheduled_at: 4, eta_limited_by: 'inputs', other: 1 }), {
    expected_seconds: 12.3,
    expected_finish_at: 5,
    eta_scheduled_at: 4,
    eta_limited_by: 'inputs',
  })
  assert.deepEqual(safeWaitSchedule({ eta_limited_by: 'vibes', expected_seconds: -1 }), {})
})

test('only a single machine-output checkpoint on a working machine becomes a completion wait', () => {
  const working = unit => unit === 582
  const one = { mode: 'all', requirements: [{ id: 'plates', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 10 }] }
  assert.equal(checkpointWaitRequirement(one, working), one.requirements[0])
  assert.equal(checkpointWaitRequirement(one, () => false), undefined)
  assert.equal(checkpointWaitRequirement({ mode: 'all', requirements: [...one.requirements, { kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }, working), undefined)
  assert.equal(checkpointWaitRequirement({ mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }, working), undefined)
  assert.equal(checkpointWaitRequirement(undefined, working), undefined)
})
