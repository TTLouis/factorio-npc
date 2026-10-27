import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { operationSignature, reconcilePendingOperation, reconciliationFacts, reconciliationGuidance, unresolvedNativeAdmissions } from './operation-reconciliation.mjs'
import { conflictingOperation } from './operation-ledger.mjs'

// Milestone 4 L4: a connected construction layout whose placement batch was cancelled after some of its nodes were built is
// settled by the mod as exact_construction_layout_partial. The runtime re-proves that from the retained admission row and the
// native receipt (one execute_construction_plan slot, one cancelled placement-only receipt, idle queues, node ids that belong to
// the layout and add up to the batch), treats it as an exact terminal partial (partial_known, released, never replayed), and does
// not take the mod's string on trust.

const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8').replace(/^﻿/, ''))
const LAYOUT_ID = 41

// The receipt evidence a sealed row carries (what the mod copies from the journal when it seals).
function sealedCopy(receipt) {
  const { batch_ref, batch_id, batch_generation, state, reason, tick, task_count, tasks_started, started_count, task_types } = receipt
  return structuredClone({ batch_ref, batch_id, batch_generation, state, reason, tick, task_count, tasks_started, started_count, task_types })
}

function fixture() {
  const pending = structuredClone(ay.pending)
  pending.operations = [{ trace_operation_id: 'recovery_mvo6q1lo/op_1', name: 'execute_construction_plan', args: { validation_id: 41, placement_count: 3 }, effect_class: 'place' }]
  pending.state = 'admitted'
  pending.signature = operationSignature([{ name: 'execute_construction_plan', args: { validation_id: 41, placement_count: 3 } }])
  const native = structuredClone(ay.native)
  const row = native.admission_journal[0]
  row.state = 'partial'
  row.signature = pending.signature
  row.ok = false
  row.error = 'exact_construction_layout_partial'
  row.slots[0].operation = 'execute_construction_plan'
  row.slots[0].queued_tasks = 3
  row.layout_id = LAYOUT_ID
  row.placed_node_ids = [`layout-${LAYOUT_ID}:n0`]
  row.not_placed_node_ids = [`layout-${LAYOUT_ID}:n2`, `layout-${LAYOUT_ID}:n1`]
  const receipt = native.receipt_journal[0]
  Object.assign(receipt, { task_count: 3, task_types: ['placing', 'placing', 'placing'], reason: 'test_cancel', started_count: 1, tasks_started: 1 })
  row.layout_receipt = sealedCopy(receipt)
  native.last_cancelled_batch = structuredClone(receipt)
  return { pending, native, actor: structuredClone(ay.actor) }
}

test('an exact cancelled layout batch settles as terminal partial with the exact node ids, released and never replayed', () => {
  const { pending, native, actor } = fixture()
  const result = reconcilePendingOperation(pending, { status: native, actor })
  assert.equal(result.verdict, 'admitted_partial')
  assert.equal(result.effect, 'partial_known')
  assert.equal(result.reason, 'exact_construction_layout_partial')
  assert.equal(result.layout_id, LAYOUT_ID)
  assert.deepEqual(result.placed_node_ids, [`layout-${LAYOUT_ID}:n0`])
  assert.deepEqual(result.not_placed_node_ids, [`layout-${LAYOUT_ID}:n2`, `layout-${LAYOUT_ID}:n1`])

  // The facts and the guidance state what was built and what was not; neither claims success.
  const facts = reconciliationFacts(result, pending)
  assert.equal(facts.recovery_kind, 'layout')
  assert.deepEqual(facts.placed_node_ids, result.placed_node_ids)
  assert.match(reconciliationGuidance(result, pending), /partial work, not batch success/)
  assert.doesNotMatch(reconciliationGuidance(result, pending), /succeeded|completed successfully/)

  // The mod sealed the row as partial, a terminal state: the native journal holds nothing unresolved for it.
  assert.deepEqual(unresolvedNativeAdmissions(native, [pending], actor), [])
  assert.deepEqual(unresolvedNativeAdmissions(native, [], actor), [])

  // The settled partial is not replay authority: the same batch for the same step is refused.
  const closed = { ...pending, ...result }
  assert.equal(conflictingOperation({ operation_ledger: { closed: [closed] } }, {
    planId: pending.plan_id,
    stepId: pending.step_id,
    operations: [{ name: 'execute_construction_plan', args: { validation_id: 41, placement_count: 3 } }],
  }).refuse, true)
})

test('an empty node list is the empty object Factorio encodes, and nothing else', () => {
  const { pending, native, actor } = fixture()
  const row = native.admission_journal[0]
  Object.assign(row, { placed_node_ids: {}, not_placed_node_ids: [`layout-${LAYOUT_ID}:n0`, `layout-${LAYOUT_ID}:n2`, `layout-${LAYOUT_ID}:n1`] })
  const none = reconcilePendingOperation(pending, { status: native, actor })
  assert.equal(none.reason, 'exact_construction_layout_partial')
  assert.deepEqual(none.placed_node_ids, [])
  row.placed_node_ids = { 0: 'x' }
  assert.notEqual(reconcilePendingOperation(pending, { status: native, actor }).reason, 'exact_construction_layout_partial')
})

for (const [name, mutate] of [
  ['actor', (s, p, a) => { a.actor_id++ }],
  ['epoch', (s, p, a) => { a.epoch++ }],
  ['generation', s => { s.batch_generation++ }],
  ['signature', (s, p) => { p.signature = 'wrong' }],
  ['attempt', (s, p) => { p.attempt_id = 'wrong' }],
  ['ordinal', (s, p) => { p.ordinal++ }],
  ['busy', s => { s.task_state = 'placing' }],
  ['queue', s => { s.queue_length = 1 }],
  ['contradictory queue', s => { s.queue_empty = false }],
  ['active batch', s => { s.active_batch = s.last_cancelled_batch }],
  ['unsealed admission', s => { s.admission_journal[0].state = 'uncertain'; s.admission_journal[0].error = 'batch_reconciliation_required'; s.admission_journal[0].ok = true }],
  ['a different partial reason', s => { s.admission_journal[0].error = 'exact_terminal_navigation_cancelled' }],
  ['an ok partial', s => { s.admission_journal[0].ok = true }],
  ['another operation', (s, p) => { s.admission_journal[0].slots[0].operation = 'place_entity'; p.operations[0].name = 'place_entity' }],
  ['a pending operation of another name', (s, p) => { p.operations[0].name = 'place_candidate' }],
  ['two slots', (s, p) => { s.admission_journal[0].operation_count = 2; p.operations.push({ ...p.operations[0] }); s.admission_journal[0].slots.push({ ...s.admission_journal[0].slots[0], index: 2 }) }],
  ['a queued count that differs from the receipt', s => { s.admission_journal[0].slots[0].queued_tasks = 2 }],
  ['a receipt that is not a cancellation', s => { s.receipt_journal[0].state = 'completed' }],
  ['a mixed task type', s => { s.receipt_journal[0].task_types[1] = 'mining' }],
  ['a receipt older than the admission', s => { s.receipt_journal[0].tick = 1 }],
  ['no started task', s => { s.receipt_journal[0].tasks_started = 0 }],
  ['a refused task', s => { s.receipt_journal[0].refused_count = 1 }],
  ['an outcome on the receipt', s => { s.receipt_journal[0].outcome = 'cancelled' }],
  ['a bad batch ref', s => { s.receipt_journal[0].batch_ref = 'wrong' }],
  ['a duplicate receipt', s => { s.receipt_journal.push(structuredClone(s.receipt_journal[0])) }],
  ['a conflicting receipt id', s => { s.receipt_journal.push({ ...s.receipt_journal[0], batch_ref: 'batch-g1-9' }) }],
  ['non-array receipts', s => { s.receipt_journal = {} }],
  ['unreadable status', s => { s.status_error = 'unavailable' }],
  ['a duplicate admission', s => { s.admission_journal.push(structuredClone(s.admission_journal[0])) }],
  ['no layout id', s => { delete s.admission_journal[0].layout_id }],
  ['a zero layout id', s => { s.admission_journal[0].layout_id = 0 }],
  ['a node of another layout', s => { s.admission_journal[0].placed_node_ids = ['layout-7:n0'] }],
  ['a node id that is not a node', s => { s.admission_journal[0].placed_node_ids = [`layout-${LAYOUT_ID}:nx`] }],
  ['a node counted twice', s => { s.admission_journal[0].not_placed_node_ids = [`layout-${LAYOUT_ID}:n0`, `layout-${LAYOUT_ID}:n1`] }],
  ['nodes that do not add up to the batch', s => { s.admission_journal[0].not_placed_node_ids = [`layout-${LAYOUT_ID}:n2`] }],
  ['no placed list', s => { delete s.admission_journal[0].placed_node_ids }],
  ['a string for the node list', s => { s.admission_journal[0].not_placed_node_ids = 'all' }],
]) {
  test(`exact layout partial fences ${name}, including a restored closed record`, () => {
    const f = fixture()
    mutate(f.native, f.pending, f.actor)
    assert.notEqual(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).reason, 'exact_construction_layout_partial')
  })
}

test('a row the mod has not sealed as partial stays unresolved: node ids live only in the mod\'s layout record', () => {
  const { pending, native, actor } = fixture()
  Object.assign(native.admission_journal[0], { state: 'uncertain', ok: true, error: 'batch_reconciliation_required' })
  delete native.admission_journal[0].layout_id
  delete native.admission_journal[0].placed_node_ids
  delete native.admission_journal[0].not_placed_node_ids
  assert.notEqual(reconcilePendingOperation(pending, { status: native, actor }).verdict, 'admitted_partial')
  assert.equal(unresolvedNativeAdmissions(native, [pending], actor).length, 1)
})

// The journal evicts a receipt once the sealed record stops pinning it; the sealed row keeps the evidence.
test('after the journal evicts the receipt the sealed row\'s own receipt evidence settles the same partial', () => {
  const { pending, native, actor } = fixture()
  native.receipt_journal = []
  const result = reconcilePendingOperation(pending, { status: native, actor })
  assert.equal(result.verdict, 'admitted_partial')
  assert.equal(result.effect, 'partial_known')
  assert.equal(result.reason, 'exact_construction_layout_partial')
  assert.equal(result.receipt_source, 'sealed_row')
  assert.deepEqual(result.placed_node_ids, [`layout-${LAYOUT_ID}:n0`])
  assert.equal(reconciliationFacts(result, pending).receipt_source, 'sealed_row')
  assert.equal(reconcilePendingOperation(pending, { status: fixture().native, actor }).receipt_source, 'journal')
})

for (const [name, mutate] of [
  ['no receipt copy', row => { delete row.layout_receipt }],
  ['a bare reason string with nothing else', row => { delete row.layout_receipt; delete row.placed_node_ids; delete row.not_placed_node_ids; delete row.layout_id }],
  ['a copy of another batch', row => { row.layout_receipt.batch_ref = 'batch-g1-9' }],
  ['a copy of another batch id', row => { row.layout_receipt.batch_id = 9 }],
  ['a copy of another generation', row => { row.layout_receipt.batch_generation = 2 }],
  ['a copy that was not cancelled', row => { row.layout_receipt.state = 'completed' }],
  ['a copy with another task count', row => { row.layout_receipt.task_count = 2; row.layout_receipt.task_types.pop() }],
  ['a copy with a mixed task type', row => { row.layout_receipt.task_types[2] = 'mining' }],
  ['a copy with no started task', row => { row.layout_receipt.tasks_started = 0 }],
  ['a copy older than the admission', row => { row.layout_receipt.tick = 1 }],
  ['a copy with refusals', row => { row.layout_receipt.refused_count = 1 }],
  ['a copy that is not an object', row => { row.layout_receipt = 'cancelled' }],
  ['a retired copy at the current generation', row => { Object.assign(row.layout_receipt, { state: 'uncertain', reason: 'save_load_unfinished' }) }],
  ['a copy retired for another reason', row => { Object.assign(row.layout_receipt, { state: 'uncertain', reason: 'something_else' }) }],
]) {
  test(`with the journal receipt evicted, a sealed row with ${name} stays unsettled`, () => {
    const f = fixture()
    f.native.receipt_journal = []
    mutate(f.native.admission_journal[0])
    assert.notEqual(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).reason, 'exact_construction_layout_partial')
  })
}

test('a journal receipt that disagrees with the sealed copy is refused', () => {
  for (const mutate of [r => { r.tick += 1 }, r => { r.task_types = ['placing', 'placing', 'mining'] }, r => { r.reason = 'other' }, r => { r.started_count = 5 }]) {
    const f = fixture()
    mutate(f.native.receipt_journal[0])
    assert.notEqual(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).reason, 'exact_construction_layout_partial')
  }
})

// A restart retires the unfinished batch as an uncertain receipt and advances the generation; the mod then seals the row. The
// row below has the shape the mod's restart test asserts (RESTART_ROW in packages/autorio/src/construction_layout.test.ts).
function restarted() {
  const f = fixture()
  const row = f.native.admission_journal[0]
  const retired = { ...f.native.receipt_journal[0], state: 'uncertain', reason: 'save_load_unfinished' }
  delete retired.tasks_started
  delete retired.started_count
  f.native.receipt_journal = [retired]
  f.native.last_cancelled_batch = undefined
  f.native.batch_generation = 2
  row.layout_receipt = sealedCopy(retired)
  return f
}

test('a restart-retired batch the mod sealed settles as terminal partial, from the journal receipt or the sealed copy', () => {
  const f = restarted()
  const result = reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor })
  assert.equal(result.verdict, 'admitted_partial')
  assert.equal(result.effect, 'partial_known')
  assert.equal(result.reason, 'exact_construction_layout_partial')
  assert.equal(result.receipt_source, 'journal')
  assert.deepEqual(result.not_placed_node_ids, [`layout-${LAYOUT_ID}:n2`, `layout-${LAYOUT_ID}:n1`])
  assert.deepEqual(unresolvedNativeAdmissions(f.native, [f.pending], f.actor), [])
  f.native.receipt_journal = []
  assert.equal(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).receipt_source, 'sealed_row')
  // Not replay authority: the same batch for the same step stays fenced.
  assert.equal(conflictingOperation({ operation_ledger: { closed: [{ ...f.pending, ...result }] } }, {
    planId: f.pending.plan_id, stepId: f.pending.step_id, operations: [{ name: 'execute_construction_plan', args: { validation_id: 41, placement_count: 3 } }],
  }).refuse, true)
})

test('a placed node that is gone after the restart is reported as missing, and the counts must still add up', () => {
  const f = restarted()
  const row = f.native.admission_journal[0]
  row.missing_node_ids = [`layout-${LAYOUT_ID}:n0`]
  row.placed_node_ids = {}
  const result = reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor })
  assert.equal(result.reason, 'exact_construction_layout_partial')
  assert.deepEqual(result.missing_node_ids, [`layout-${LAYOUT_ID}:n0`])
  assert.match(reconciliationGuidance(result, f.pending), /placed and since gone: layout-41:n0/)
  row.missing_node_ids = [`layout-${LAYOUT_ID}:n1`]
  assert.notEqual(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).reason, 'exact_construction_layout_partial')
})

for (const [name, mutate] of [
  ['a changed actor', f => { f.actor.actor_id++ }],
  ['a changed epoch', f => { f.actor.epoch++ }],
  ['a generation that is not older', f => { f.native.batch_generation = 1 }],
  ['an admission from a newer generation', f => { f.native.admission_journal[0].generation = 3; f.native.admission_journal[0].slots[0].batch_refs[0].batch_generation = 3 }],
  ['a receipt that is only uncertain for another reason', f => { f.native.receipt_journal[0].reason = 'other'; f.native.admission_journal[0].layout_receipt.reason = 'other' }],
  ['a row that is not sealed as partial', f => { f.native.admission_journal[0].state = 'uncertain'; f.native.admission_journal[0].error = 'batch_reconciliation_required'; f.native.admission_journal[0].ok = true }],
  ['a busy queue', f => { f.native.queue_length = 1 }],
  ['an active batch', f => { f.native.active_batch = { batch_id: 3 } }],
  ['a non-placement task', f => { f.native.receipt_journal[0].task_types[0] = 'mining'; f.native.admission_journal[0].layout_receipt.task_types[0] = 'mining' }],
  ['a duplicate journal receipt', f => { f.native.receipt_journal.push(structuredClone(f.native.receipt_journal[0])) }],
]) {
  test(`a restart-retired layout batch is fenced by ${name}`, () => {
    const f = restarted()
    mutate(f)
    const result = reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor })
    assert.notEqual(result.reason, 'exact_construction_layout_partial')
    assert.notEqual(result.verdict, 'admitted_partial')
  })
}
