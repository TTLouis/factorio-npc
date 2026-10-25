// Autorio status publishes the journal ARRAY directly. Factorio encodes a
// present empty Lua array as {}; only that exact empty-object shape is empty.
const states = new Set(['admitting', 'admitted', 'uncertain', 'completed', 'failed', 'partial', 'not_admitted'])
const unresolved = new Set(['admitting', 'admitted', 'uncertain'])
const MAX_NATIVE_INTEGER = 9007199254740990
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
const nonnegative = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_NATIVE_INTEGER
const positive = value => nonnegative(value) && value > 0
const optional = (value, accepts) => value === undefined || accepts(value)
const boolean = value => typeof value === 'boolean'
const boundedString = limit => value => typeof value === 'string' && value.length <= limit
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
    if (!row || !states.has(row.state) || !text(row.operation_key, 192) || !text(row.attempt_id, 128) || !text(row.signature, 256)
      || !positive(row.ordinal) || !positive(row.actor_id) || !positive(row.epoch) || !positive(row.generation)
      || !nonnegative(row.tick) || !positive(row.operation_count) || row.operation_count > 16
      || keys.has(row.operation_key) || !slots || slots.length > row.operation_count
      || row.state === 'completed' && slots.length !== row.operation_count
      || !optional(row.work_mark, nonnegative) || !optional(row.ok, boolean) || !optional(row.error, boundedString(512))
      || !optional(row.proven_refusal, boolean) || !optional(row.applied_slot_count, value => nonnegative(value) && value <= slots.length)) return unknown()
    keys.add(row.operation_key)
    const slotIdentity = []
    for (const [position, slot] of slots.entries()) {
      const refs = list(slot?.batch_refs, 16)
      if (slot?.index !== position + 1 || !boolean(slot.ok) || !refs
        || !optional(slot.operation, boundedString(64)) || !optional(slot.queued_tasks, nonnegative)
        || !optional(slot.mutation_unknown, boolean) || !optional(slot.refused_before_mutation, boolean)
        || !optional(slot.refusal_code, boundedString(128))
        || refs.some(ref => !positive(ref?.batch_id) || !positive(ref.batch_generation) || !text(ref.batch_ref, 96)
          || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`)) return unknown()
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
