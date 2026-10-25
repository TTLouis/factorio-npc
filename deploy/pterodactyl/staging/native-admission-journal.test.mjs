import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeAdmissionJournal } from './native-admission-journal.mjs'

const record = state => ({ operation_key: 'request/batch_1', attempt_id: 'attempt_1', signature: 'a'.repeat(64),
  ordinal: 1, actor_id: 18, epoch: 3, generation: 1, operation_count: 1, tick: 1000, state, slots: state === 'completed' ? [{ index: 1, ok: true, batch_refs: [] }] : [] })
test('actual direct journal array and explicit present Lua-empty object have one bounded reader', () => {
  for (const raw of [[], {}]) {
    const result = nativeAdmissionJournal(raw)
    assert.equal(result.known, true)
    assert.equal(result.unresolved, false)
    assert.equal(result.identity, '[]')
  }
  for (const state of ['admitting', 'admitted', 'uncertain']) {
    const result = nativeAdmissionJournal([record(state)])
    assert.equal(result.known, true)
    assert.equal(result.unresolved, true)
  }
  const settled = nativeAdmissionJournal([{ ...record('completed'), slots: [{ index: 1, ok: true, batch_refs: {} }] }])
  assert.equal(settled.known, true)
  assert.equal(settled.unresolved, false)
})
test('missing, malformed, nested-record and oversized journals are unknown rather than empty', () => {
  for (const raw of [undefined, null, false, '', { records: [] }, { not_empty: true }, [null], [{}],
    [{ ...record('completed'), signature: '' }], [record('unknown')], Array.from({ length: 129 }, () => record('completed')),
    [record('completed'), record('completed')], [{ ...record('completed'), slots: [{ index: 1, ok: true }] }], [{ ...record('completed'), slots: {} }]]) {
    assert.equal(nativeAdmissionJournal(raw).known, false)
  }
})
test('journal owner/state consistency changes independently from the task watermark', () => {
  const first = nativeAdmissionJournal([record('completed')])
  for (const changed of [{ state: 'uncertain' }, { attempt_id: 'attempt_2' }, { signature: 'b'.repeat(64) }, { ordinal: 2 }]) {
    assert.notEqual(nativeAdmissionJournal([{ ...record('completed'), ...changed }]).identity, first.identity)
  }
})
