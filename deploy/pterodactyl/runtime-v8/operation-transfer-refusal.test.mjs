import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPendingOperation, EFFECT, reconcilePendingOperation, RECONCILE_VERDICT } from './operation-reconciliation.mjs'

// This models authoritative native receipts, not simulated transfer physics.
// Two completed tasks plus one proven zero-transfer refusal are known partial
// work, never successful completion or permission to replay the original batch.
const ACTOR = { actor_id: 18, epoch: 3 }
const REF = { batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4' }
function fixture(cause = 'target_rejects_item') {
  const operations = [
    { name: 'move_items_exact', args: { unit_number: 49, item_name: 'fixture-item', max_count: 2, to_entity: false } },
    { name: 'supply_entity', args: { unit_number: 49, items: [{ item_name: 'fixture-item', count: 2 }] } },
  ]
  const pending = buildPendingOperation({ requestId: 'transfer/request', operationKey: 'transfer/operation', ordinal: 1,
    protocolVersion: 2, actor: ACTOR, operations })
  const admission = { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature,
    actor_id: ACTOR.actor_id, epoch: ACTOR.epoch, ordinal: 1, operation_count: 2, generation: 1, tick: 100,
    state: 'admitted', ok: true, slots: operations.map((operation, index) => ({ index: index + 1, operation: operation.name,
      ok: true, queued_tasks: index + 1, batch_refs: [{ ...REF }] })) }
  const receipt = { ...REF, state: 'cancelled', outcome: 'refused', tick: 110, task_count: 3, started_count: 3,
    task_types: ['moving_items', 'moving_items', 'moving_items'], completed_count: 2, refused_count: 1,
    refusals: [{ operation_id: 21, type: 'moving_items', code: 'nothing_moved', cause,
      target_unit_number: 49, held_count: 2, tick: 109 }] }
  const status = { task_state: 'idle', queue_length: 0, batch_generation: 1,
    admission_journal: [admission], receipt_journal: [receipt] }
  return { pending, admission, receipt, status, actor: { ...ACTOR } }
}
function reconcile(f) { return reconcilePendingOperation(f.pending, { actor: f.actor, status: f.status }) }

for (const cause of ['target_rejects_item', 'target_full', 'input_slot_holds_other_item', 'no_input_inventory_for_item']) {
  test(`native transfer refusal ${cause} closes only as known partial work`, () => {
    const f = fixture(cause)
    const result = reconcile(f)
    assert.equal(result.verdict, RECONCILE_VERDICT.ADMITTED_PARTIAL)
    assert.equal(result.effect, EFFECT.PARTIAL_KNOWN)
    assert.equal(result.reason, 'exact_terminal_transfer_refusal')
    assert.equal(result.completed_tasks, 2)
    assert.equal(result.refused_tasks, 1, 'shared batch reference is counted once')
    assert.equal(f.admission.state, 'admitted', 'reconciliation does not mutate native history')
  })
}

for (const [label, mutate] of [
  ['native work still active', f => { f.status.active_batch = { ...REF } }],
  ['cancelled unstarted tail', f => { f.receipt.started_count-- }],
  ['partial accounting', f => { f.receipt.completed_count-- }],
  ['unknown cause', f => { f.receipt.refusals[0].cause = 'unproven' }],
  ['different operation effect', f => { f.receipt.refusals[0].code = 'source_removed_but_not_inserted' }],
  ['no held item witness', f => { f.receipt.refusals[0].held_count = 0 }],
  ['future refusal', f => { f.receipt.refusals[0].tick = 111 }],
  ['different receipt generation', f => { f.receipt.batch_generation++ }],
  ['restarted native generation', f => { f.status.batch_generation++ }],
  ['stale actor epoch', f => { f.actor.epoch++ }],
  ['wrong operation digest', f => { f.admission.signature = 'different' }],
  ['duplicate refusal identity', f => {
    f.receipt.refused_count = 2; f.receipt.completed_count = 1
    f.receipt.refusals.push({ ...f.receipt.refusals[0] })
  }],
]) {
  test(`a target_full label cannot settle ${label}`, () => {
    const f = fixture('target_full'); mutate(f)
    const result = reconcile(f)
    assert.notEqual(result.reason, 'exact_terminal_transfer_refusal')
    assert.notEqual(result.effect, EFFECT.HAPPENED)
    assert.notEqual(result.effect, EFFECT.NOT_HAPPENED)
  })
}
