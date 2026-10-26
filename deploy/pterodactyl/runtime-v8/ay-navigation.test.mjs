import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { reconcilePendingOperation, unresolvedNativeAdmissions, reconciliationGuidance } from './operation-reconciliation.mjs'
import { conflictingOperation } from './operation-ledger.mjs'

export const ay = JSON.parse(fs.readFileSync(new URL('./fixtures/ay-navigation.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))

test('AY exact retained navigation journal settles terminal partial movement without destination success or replay', () => {
  const result = reconcilePendingOperation(ay.pending, { status: ay.native, actor: ay.actor })
  assert.equal(result.reason, 'exact_terminal_navigation_cancelled')
  assert.equal(result.effect, 'partial_known')
  assert.equal(result.verdict, 'admitted_partial')
  assert.match(reconciliationGuidance(result, ay.pending), /destination is not verified/)
  assert.deepEqual(unresolvedNativeAdmissions(ay.native, [ay.pending], ay.actor), [])
  assert.equal(unresolvedNativeAdmissions(ay.native, [], ay.actor).length, 1)
  assert.equal(conflictingOperation({ operation_ledger: { closed: [{ ...ay.pending, ...result }] } }, {
    planId: ay.pending.plan_id, stepId: ay.pending.step_id,
    operations: [{ name: 'walk_to_position', args: { x: -119, y: 2, reach_distance: 0.75 } }],
  }).refuse, true)
})

test('native partial bookkeeping uses the same exact proof; original action remains non-replayable', () => {
  const status = structuredClone(ay.native)
  Object.assign(status.admission_journal[0], { state: 'partial', ok: false, error: 'exact_terminal_navigation_cancelled' })
  assert.equal(reconcilePendingOperation(ay.pending, { status, actor: ay.actor }).reason, 'exact_terminal_navigation_cancelled')
  status.receipt_journal = []
  assert.notEqual(reconcilePendingOperation(ay.pending, { status, actor: ay.actor }).reason, 'exact_terminal_navigation_cancelled')
})

for (const [name, mutate] of [
  ['actor', (s, p, a) => { a.actor_id++ }],
  ['epoch', (s, p, a) => { a.epoch++ }],
  ['generation', s => { s.batch_generation++ }],
  ['signature', (s, p) => { p.signature = 'wrong' }],
  ['attempt', (s, p) => { p.attempt_id = 'wrong' }],
  ['ordinal', (s, p) => { p.ordinal++ }],
  ['busy', s => { s.task_state = 'mining' }],
  ['queue', s => { s.queue_length = 1 }],
  ['active batch', s => { s.active_batch = s.last_cancelled_batch }],
  ['mixed task', s => { s.receipt_journal[0].task_types[0] = 'mining' }],
  ['mixed operation', s => { s.admission_journal[0].slots[0].operation = 'place_entity' }],
  ['receipt missing', s => { s.receipt_journal = [] }],
  ['bad ref', s => { s.receipt_journal[0].batch_ref = 'wrong' }],
  ['unreadable', s => { s.status_error = 'unavailable' }],
  ['contradictory queue', s => { s.queue_empty = false }],
  ['started accounting', s => { s.receipt_journal[0].tasks_started = 0 }],
  ['unknown error', s => { s.admission_journal[0].error = 'unknown_mutation' }],
  ['duplicate admission', s => { s.admission_journal.push(structuredClone(s.admission_journal[0])) }],
  ['non-array receipts', s => { s.receipt_journal = {} }],
  ['duplicate receipt', s => { s.receipt_journal.push(structuredClone(s.receipt_journal[0])) }],
  ['conflicting receipt ref', s => { s.receipt_journal.push({ ...s.receipt_journal[0], batch_id: 102 }) }],
]) test(`AY terminal navigation fences ${name}, including a restored closed record`, () => {
  const s = structuredClone(ay.native); const p = structuredClone(ay.pending); const a = structuredClone(ay.actor)
  mutate(s, p, a)
  assert.notEqual(reconcilePendingOperation(p, { status: s, actor: a }).reason, 'exact_terminal_navigation_cancelled')
  assert.equal(unresolvedNativeAdmissions(s, [p], a).length, 1)
})

for (const raw of [undefined, null, 'clipped', { records: 'bad' }, [{ state: 'uncertain' }]]) {
  test(`unknown journal stays unresolved: ${JSON.stringify(raw)}`, () => {
    assert.equal(unresolvedNativeAdmissions({ ...ay.native, admission_journal: raw }, [ay.pending], ay.actor).length, 1)
  })
}
