import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { operationSignature, reconcilePendingOperation, reconciliationFacts, reconciliationGuidance, terminalLinePlacementPartial, unresolvedNativeAdmissions } from './operation-reconciliation.mjs'

// External-harness place_line: a line whose placement batch stopped at a refused tile (or was cancelled) is sealed by the mod
// as exact_line_placement_partial. The runtime re-proves it from the retained admission row and the native receipt: one
// place_line slot, one cancelled all-placing receipt, idle queues, and placed + missing indexes forming a prefix no longer than
// the tasks started, with the rest never placed. Anything else is not taken on trust.

const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8').replace(/^﻿/, ''))
const ARGS = { entity_name: 'transport-belt', x: 2.5, y: -3.5, direction: 4, line_direction: 4, count: 4, spacing: 1 }

function sealedCopy(receipt) {
  const { batch_ref, batch_id, batch_generation, state, reason, tick, task_count, tasks_started, started_count, task_types } = receipt
  return structuredClone({ batch_ref, batch_id, batch_generation, state, reason, tick, task_count, tasks_started, started_count, task_types })
}

function fixture() {
  const pending = structuredClone(ay.pending)
  pending.operations = [{ trace_operation_id: 'external/line', name: 'place_line', args: { ...ARGS }, effect_class: 'place' }]
  pending.state = 'admitted'
  pending.signature = operationSignature([{ name: 'place_line', args: { ...ARGS } }])
  const native = structuredClone(ay.native)
  const row = native.admission_journal[0]
  Object.assign(row, { state: 'partial', signature: pending.signature, ok: false, error: 'exact_line_placement_partial' })
  row.slots[0].operation = 'place_line'
  row.slots[0].queued_tasks = 4
  const receipt = native.receipt_journal[0]
  Object.assign(receipt, { task_count: 4, task_types: ['placing', 'placing', 'placing', 'placing'], reason: 'placement_footprint_occupied', started_count: 3, tasks_started: 3 })
  row.line_placement = {
    line_id: 2, entity_name: 'transport-belt', count: 4,
    placed: [0, 1].map(index => ({ index, unit_number: 70 + index, position: { x: 2.5 + index, y: -3.5 }, direction: 4 })),
    missing_indexes: {}, not_placed_indexes: [2, 3],
    refusal: { index: 2, code: 'placement_footprint_occupied', blockers: [{ name: 'item-on-ground', type: 'item-entity', item: 'iron-plate', position: { x: 4.5, y: -3.5 } }] },
    receipt: sealedCopy(receipt),
  }
  return { pending, native, actor: structuredClone(ay.actor) }
}

test('a line stopped at a refused tile settles as an exact terminal partial with the placed prefix and the first refusal', () => {
  const { pending, native, actor } = fixture()
  const result = reconcilePendingOperation(pending, { status: native, actor })
  assert.equal(result.verdict, 'admitted_partial')
  assert.equal(result.effect, 'partial_known')
  assert.equal(result.reason, 'exact_line_placement_partial')
  assert.equal(result.recovery_kind, 'line')
  assert.deepEqual(result.placed_indexes, [0, 1])
  assert.deepEqual(result.not_placed_indexes, [2, 3])
  assert.deepEqual(result.placed.map(entity => entity.unit_number), [70, 71])
  assert.equal(result.refusal.index, 2)
  assert.equal(result.refusal.blockers[0].item, 'iron-plate')
  assert.equal(result.receipt_source, 'journal')
  const facts = reconciliationFacts(result, pending)
  assert.equal(facts.recovery_kind, 'line')
  assert.deepEqual(facts.placed_indexes, [0, 1])
  assert.doesNotMatch(reconciliationGuidance(result, pending), /succeeded|completed successfully/)
  assert.deepEqual(unresolvedNativeAdmissions(native, [pending], actor), [])
})

test('the sealed row alone proves the partial once the journal receipt has rolled out, if it agrees', () => {
  const { pending, native, actor } = fixture()
  native.receipt_journal = []
  assert.equal(reconcilePendingOperation(pending, { status: native, actor }).receipt_source, 'sealed_row')
  native.admission_journal[0].line_placement.receipt.task_types = ['placing', 'placing', 'placing', 'crafting']
  assert.notEqual(reconcilePendingOperation(pending, { status: native, actor }).reason, 'exact_line_placement_partial')
})

for (const [name, mutate] of [
  ['a gap in the placed prefix', f => { f.native.admission_journal[0].line_placement.placed[1].index = 2; f.native.admission_journal[0].line_placement.not_placed_indexes = [1, 3] }],
  ['more placed than tasks started', f => { Object.assign(f.native.receipt_journal[0], { tasks_started: 1, started_count: 1 }); f.native.admission_journal[0].line_placement.receipt = sealedCopy(f.native.receipt_journal[0]) }],
  ['not-placed indexes that do not complete the line', f => { f.native.admission_journal[0].line_placement.not_placed_indexes = [3] }],
  ['a completed rather than cancelled receipt', f => { f.native.receipt_journal[0].state = 'completed'; f.native.admission_journal[0].line_placement.receipt.state = 'completed' }],
  ['a non-placing task in the batch', f => { f.native.receipt_journal[0].task_types[3] = 'walking'; f.native.admission_journal[0].line_placement.receipt.task_types[3] = 'walking' }],
  ['a sealed receipt that disagrees with the journal', f => { f.native.admission_journal[0].line_placement.receipt.tasks_started = 2 }],
  ['another operation in the slot', f => { f.native.admission_journal[0].slots[0].operation = 'place_entity' }],
  ['a busy native queue', f => { f.native.queue_length = 1 }],
  ['a newer batch generation', f => { f.native.batch_generation += 1 }],
  ['a count that differs from the queued tasks', f => { f.native.admission_journal[0].line_placement.count = 5 }],
  ['a placed entity without a unit number', f => { delete f.native.admission_journal[0].line_placement.placed[0].unit_number }],
]) {
  test(`a line partial is not proven with ${name}`, () => {
    const f = fixture()
    mutate(f)
    assert.equal(terminalLinePlacementPartial(f.native.admission_journal[0], f.native, f.pending), null)
    assert.notEqual(reconcilePendingOperation(f.pending, { status: f.native, actor: f.actor }).reason, 'exact_line_placement_partial')
  })
}
