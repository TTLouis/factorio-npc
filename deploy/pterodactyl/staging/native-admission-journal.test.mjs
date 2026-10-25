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

test('native slot sequence and declared operation count cannot be duplicated, reordered or exceeded', () => {
  const slot = index => ({ index, ok: true, batch_refs: [] })
  for (const malformed of [
    { operation_count: 2, slots: [slot(1), slot(1)] },
    { operation_count: 2, slots: [slot(2), slot(1)] },
    { operation_count: 1, state: 'uncertain', slots: [slot(1), slot(2)] },
    { operation_count: 2, slots: [slot(1), slot(3)] },
  ]) assert.equal(nativeAdmissionJournal([{ ...record('completed'), ...malformed }]).known, false)
})
test('fingerprint fields reject nonprimitive and oversized producer data before serialization', () => {
  const nested = Array.from({ length: 4096 }, () => ({ nested: ['unbounded'] }))
  for (const field of ['operation', 'queued_tasks', 'mutation_unknown', 'refused_before_mutation', 'refusal_code']) {
    for (const value of [{ nested: true }, nested]) {
      const row = record('completed'); row.slots[0][field] = value
      assert.equal(nativeAdmissionJournal([row]).known, false, `slot.${field}`)
    }
  }
  for (const field of ['work_mark', 'ok', 'error', 'proven_refusal', 'applied_slot_count']) {
    for (const value of [{ nested: true }, nested]) assert.equal(nativeAdmissionJournal([{ ...record('completed'), [field]: value }]).known, false, field)
  }
  for (const patch of [{ operation: 'x'.repeat(65) }, { queued_tasks: -1 }, { queued_tasks: 0.5 },
    { queued_tasks: 9007199254740991 }, { mutation_unknown: 1 }, { refused_before_mutation: 'true' }, { refusal_code: 'x'.repeat(129) }]) {
    const row = record('completed'); Object.assign(row.slots[0], patch)
    assert.equal(nativeAdmissionJournal([row]).known, false)
  }
  for (const patch of [{ work_mark: -1 }, { work_mark: 0.5 }, { work_mark: 9007199254740991 }, { ok: 'true' },
    { error: 'x'.repeat(513) }, { proven_refusal: 1 }, { applied_slot_count: 2 }, { applied_slot_count: -1 },
    { operation_key: 'x'.repeat(193) }, { attempt_id: 'x'.repeat(129) }, { signature: 'x'.repeat(257) }]) {
    assert.equal(nativeAdmissionJournal([{ ...record('completed'), ...patch }]).known, false)
  }
})
test('published primitive producer maxima remain valid known proof', () => {
  const row = { ...record('completed'), operation_key: 'k'.repeat(192), attempt_id: 'a'.repeat(128), signature: 's'.repeat(256),
    work_mark: 9007199254740990, ok: true, error: 'e'.repeat(512), proven_refusal: false, applied_slot_count: 1 }
  Object.assign(row.slots[0], { operation: 'o'.repeat(64), queued_tasks: 9007199254740990,
    mutation_unknown: false, refused_before_mutation: true, refusal_code: 'r'.repeat(128) })
  assert.equal(nativeAdmissionJournal([row]).known, true)
})
