import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyConditionObservation,
  evaluateCompletionContract,
  makeConditionWait,
  provePermanentlyUnsatisfiable,
  sanitizeStepCompletionContract,
} from './step-completion.mjs'

test('unsupported, mixed, truncated, or malformed completion semantics fail closed', () => {
  assert.equal(sanitizeStepCompletionContract({ mode: 'all', requirements: [{ kind: 'natural_language', predicate: 'looks done' }] }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [
      { id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
      { id: 'guess', kind: 'natural_language', predicate: 'looks done' },
    ],
  }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'javascript',
    requirements: [{ id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 }],
  }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: Array.from({ length: 9 }, (_, index) => ({ id: `item_${index}`, kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 })),
  }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [
      { id: 'same', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
      { id: 'same', kind: 'inventory_count', item_name: 'copper-plate', minimum: 9 },
    ],
  }).mode, 'semantic_unknown')
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ id: 'receipt', kind: 'authoritative_operation_receipt' }],
  }).mode, 'semantic_unknown')
})

test('inventory completion requires grounded count truth', () => {
  const contract = sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 }],
  })
  assert.equal(evaluateCompletionContract(contract, {
    plates: { kind: 'inventory_count', item_name: 'iron-plate', current: 0, summary: 'iron-plate=0' },
  }).satisfied, false)
  assert.equal(evaluateCompletionContract(contract, {
    plates: { kind: 'inventory_count', item_name: 'iron-plate', current: 9, summary: 'iron-plate=9' },
  }).satisfied, true)
  assert.equal(evaluateCompletionContract(contract, {
    plates: { kind: 'inventory_count', item_name: 'copper-plate', current: 99, satisfied: true },
  }).satisfied, false)
})

test('entity inventory completion requires exact live identity', () => {
  assert.equal(sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ kind: 'entity_inventory_count', item_name: 'iron-plate', minimum: 9 }],
  }).mode, 'semantic_unknown')
  const contract = sanitizeStepCompletionContract({
    mode: 'all',
    requirements: [{ id: 'furnace', kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 9 }],
  })
  assert.equal(contract.requirements[0].unit_number, 582)
  assert.equal(evaluateCompletionContract(contract, {
    furnace: { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', current: 9, stale: false },
  }).satisfied, true)
  assert.equal(evaluateCompletionContract(contract, {
    furnace: { kind: 'entity_inventory_count', unit_number: 583, item_name: 'iron-plate', current: 99, stale: false },
  }).satisfied, false)
  assert.equal(evaluateCompletionContract(contract, {
    furnace: { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', current: 99, stale: true },
  }).satisfied, false)
})

test('passive progress wait stays active while machine progresses and wakes when it stops', () => {
  const wait = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { mode: 'passive_progress', goalId: 'goal_1', stepId: 'step_2', maxChecks: 10 },
  )
  const active = applyConditionObservation(wait, { satisfied: true, progressing: true, progress_known: true })
  assert.equal(active.action, 'waiting')
  assert.equal(active.wait.state, 'active')
  const stopped = applyConditionObservation(active.wait, { satisfied: false, progressing: false, progress_known: true })
  assert.equal(stopped.action, 'wake')
  assert.equal(stopped.wait.state, 'failed')
})

test('completion wait verifies once and duplicate observations are stale after satisfaction', () => {
  const wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    { goalId: 'goal_1', stepId: 'step_2', maxChecks: 10 },
  )
  const verified = applyConditionObservation(wait, { satisfied: true, summary: 'iron-plate=10' })
  assert.equal(verified.action, 'verified')
  assert.equal(applyConditionObservation(verified.wait, { satisfied: true }).action, 'stale')
})

test('timeout and exact-identity loss never fake completion', () => {
  const wait = makeConditionWait(
    { kind: 'entity_inventory_count', unit_number: 582, item_name: 'iron-plate', minimum: 9 },
    { maxChecks: 1 },
  )
  const timed = applyConditionObservation(wait, { satisfied: false, progressing: true })
  assert.equal(timed.action, 'timeout')
  assert.notEqual(timed.wait.state, 'satisfied')

  const stale = applyConditionObservation(wait, { stale: true })
  assert.equal(stale.action, 'failed')
  assert.equal(stale.reason, 'stale_exact_identity')
})


test('passive progress wait is bounded by checks and elapsed timeout without treating time as completion', () => {
  const byChecks = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { mode: 'passive_progress', goalId: 'goal_1', stepId: 'step_2', maxChecks: 1, timeoutMs: 60000, now: 1000 },
  )
  const checkTimeout = applyConditionObservation(byChecks, {
    satisfied: true,
    progressing: true,
    progress_known: true,
  }, { now: 1500 })
  assert.equal(checkTimeout.action, 'timeout')
  assert.equal(checkTimeout.wait.state, 'timeout')

  const byTime = makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { mode: 'passive_progress', goalId: 'goal_1', stepId: 'step_2', maxChecks: 10, timeoutMs: 1000, now: 1000 },
  )
  const elapsedTimeout = applyConditionObservation(byTime, {
    satisfied: true,
    progressing: true,
    progress_known: true,
  }, { now: 2000 })
  assert.equal(elapsedTimeout.action, 'timeout')
  assert.notEqual(elapsedTimeout.wait.state, 'satisfied')
})

test('condition wait carries bounded lifecycle identity when supplied', () => {
  const wait = makeConditionWait(
    { kind: 'inventory_count', item_name: 'iron-plate', minimum: 9 },
    {
      goalId: 'goal_1',
      stepId: 'step_2',
      actorId: 18,
      actorEpoch: 3,
      timeoutMs: 999999999,
    },
  )
  assert.equal(wait.actor_id, 18)
  assert.equal(wait.actor_epoch, 3)
  assert.ok(wait.timeout_ms <= 2 * 60 * 60 * 1000)
})

test('unsatisfiability is proven only by a destroyed exact identity the contract names', () => {
  const contract = {
    mode: 'all',
    requirements: [
      { id: 'fuel', kind: 'entity_inventory_count', unit_number: 4412, item_name: 'coal', minimum: 5 },
      { id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 20 },
    ],
  }

  const proven = provePermanentlyUnsatisfiable(contract, { staleUnitNumbers: [4412] })
  assert.equal(proven.proven, true)
  assert.deepEqual(proven.requirement_ids, ['fuel'])
  assert.deepEqual(proven.unit_numbers, [4412])

  assert.equal(provePermanentlyUnsatisfiable(contract, { staleUnitNumbers: [] }), undefined)
  assert.equal(provePermanentlyUnsatisfiable(contract, { staleUnitNumbers: [9999] }), undefined,
    'an identity this contract never names proves nothing about it')
})

test('an unpinned requirement can never be proven unsatisfiable however often it failed', () => {
  // `inventory_count`, receipts and controller state are not bound to an entity
  // the world can destroy, so no amount of destruction makes them impossible.
  const unpinned = {
    mode: 'all',
    requirements: [
      { id: 'plates', kind: 'inventory_count', item_name: 'iron-plate', minimum: 20 },
      { id: 'receipt', kind: 'authoritative_operation_receipt', operation_name: 'craft_item' },
      { id: 'controller', kind: 'runtime_controller_state', controller: 'mining', expected: 'idle' },
    ],
  }
  assert.equal(provePermanentlyUnsatisfiable(unpinned, { staleUnitNumbers: [1, 2, 3, 4412] }), undefined)
})

test('any-mode needs every branch dead, all-mode only needs one', () => {
  const requirements = [
    { id: 'a', kind: 'entity_exists', unit_number: 10 },
    { id: 'b', kind: 'entity_state', unit_number: 11, expected: 'working' },
  ]

  assert.equal(provePermanentlyUnsatisfiable({ mode: 'any', requirements }, { staleUnitNumbers: [10] }), undefined,
    'a surviving branch keeps an any-mode contract reachable')
  assert.equal(provePermanentlyUnsatisfiable({ mode: 'any', requirements }, { staleUnitNumbers: [10, 11] }).proven, true)
  assert.equal(provePermanentlyUnsatisfiable({ mode: 'all', requirements }, { staleUnitNumbers: [10] }).proven, true)
})

test('a contract with nothing to falsify is never proven unsatisfiable', () => {
  assert.equal(provePermanentlyUnsatisfiable({ mode: 'semantic_unknown', requirements: [] }, { staleUnitNumbers: [10] }), undefined)
  assert.equal(provePermanentlyUnsatisfiable(undefined, { staleUnitNumbers: [10] }), undefined)
  // A malformed contract sanitizes to semantic_unknown rather than proving anything.
  assert.equal(provePermanentlyUnsatisfiable({ mode: 'all', requirements: [{ id: 'x', kind: 'nonsense' }] }, { staleUnitNumbers: [10] }), undefined)
})
