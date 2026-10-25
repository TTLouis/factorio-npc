// Autorio status publishes the journal ARRAY directly. Factorio encodes a
// present empty Lua array as {}; only that exact empty-object shape is empty.
const states = new Set(['admitting', 'admitted', 'uncertain', 'completed', 'failed', 'partial', 'not_admitted'])
const unresolved = new Set(['admitting', 'admitted', 'uncertain'])
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200
const positive = value => Number.isSafeInteger(value) && value > 0
const emptyObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
const list = (value, limit) => emptyObject(value) ? [] : Array.isArray(value) && value.length <= limit ? value : undefined

export function nativeAdmissionJournal(raw) {
  const rows = list(raw, 128)
  const unknown = () => ({ known: false, unresolved: true, identity: undefined, records: [] })
  if (!rows) return unknown()
  const keys = new Set()
  const records = []
  for (const row of rows) {
    const slots = list(row?.slots, 16)
    if (!row || !states.has(row.state) || !text(row.operation_key) || !text(row.attempt_id) || !text(row.signature)
      || !positive(row.ordinal) || !positive(row.actor_id) || !positive(row.epoch) || !positive(row.generation)
      || !Number.isSafeInteger(row.tick) || row.tick < 0 || !positive(row.operation_count) || row.operation_count > 16
      || keys.has(row.operation_key) || !slots || row.state === 'completed' && slots.length !== row.operation_count) return unknown()
    keys.add(row.operation_key)
    const slotIdentity = []
    for (const slot of slots) {
      const refs = list(slot?.batch_refs, 16)
      if (!positive(slot?.index) || slot.index > 16 || typeof slot.ok !== 'boolean' || !refs
        || refs.some(ref => !positive(ref?.batch_id) || !positive(ref.batch_generation) || !text(ref.batch_ref))) return unknown()
      slotIdentity.push([slot.index, slot.ok, slot.operation, slot.queued_tasks, slot.mutation_unknown,
        slot.refused_before_mutation, slot.refusal_code, refs.map(ref => [ref.batch_id, ref.batch_generation, ref.batch_ref])])
    }
    records.push({ operation_key: row.operation_key, attempt_id: row.attempt_id, signature: row.signature,
      ordinal: row.ordinal, actor_id: row.actor_id, epoch: row.epoch, generation: row.generation,
      operation_count: row.operation_count, state: row.state, tick: row.tick,
      work_mark: row.work_mark, ok: row.ok, error: row.error, proven_refusal: row.proven_refusal,
      applied_slot_count: row.applied_slot_count, slots: slotIdentity })
  }
  records.sort((a, b) => a.operation_key.localeCompare(b.operation_key))
  return { known: true, unresolved: records.some(row => unresolved.has(row.state)), identity: JSON.stringify(records), records }
}
