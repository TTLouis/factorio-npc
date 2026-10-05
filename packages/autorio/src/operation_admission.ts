import type { ControlledActor } from './actors/types'
import type { TaskBatchIdentity, TaskBatchReceipt } from './task_manager'

export const ADMISSION_LIMITS = { unresolved: 64, history: 64, slots: 16, refs: 16 }
export interface OperationCorrelation {
  operation_key: string
  attempt_id: string
  actor_id: number
  epoch: number
  signature: string
  ordinal: number
  operation_count: number
}
export interface AdmissionSlot {
  index: number
  ok: boolean
  result?: string | number | boolean
  error?: string
  /** True unless the mod proved the refusal happened before any change (see PURE_SUBMIT_OPERATIONS). */
  mutation_unknown?: boolean
  /** The operation returned a refusal from validation that provably changed nothing and queued no task. */
  refused_before_mutation?: boolean
  refusal_code?: string
  operation?: string
  batch_refs: TaskBatchIdentity[]
}
/** Fields the harness supplies for a slot; the mod, not the harness, decides what a refusal proves. */
export type AdmissionSlotInput = Omit<AdmissionSlot, 'index' | 'refused_before_mutation' | 'refusal_code'> & {
  /** The operation returned a refusal (false or a false-first tuple) instead of throwing. */
  refused?: boolean
}
export interface OperationAdmission extends OperationCorrelation {
  state: 'admitting' | 'admitted' | 'uncertain' | 'completed' | 'failed' | 'not_admitted'
  generation: number
  tick: number
  slots: AdmissionSlot[]
  ok?: boolean
  error?: string
  /** Task-queue witness (task_manager tasks_added) after the last recorded slot. */
  work_mark?: number
  /**
   * Terminal and exact: every non-ok slot was refused before any change and no
   * slot queued work, or the engine cancelled the batch's first task before it
   * changed anything. The ok slots (if any) completed synchronously; operations
   * after the refusal never ran.
   */
  proven_refusal?: boolean
}
// Operations whose submission validates, then either queues a task or returns a
// refusal without touching the world. A refusal from any other operation
// (equip, research, follow, composite plans, ...) may follow a partial change.
export const PURE_SUBMIT_OPERATIONS = [
  'place_entity', 'mine_entity', 'mine_entity_exact', 'mine_resource_at', 'rotate_entity', 'move_items', 'move_items_exact',
  'move_items_with_player', 'set_machine_recipe', 'launch_rocket', 'wait', 'craft_item',
]
declare const storage: { sgluna_operation_admissions?: OperationAdmission[], sgluna_operation_admission_high_water?: number }

export function admission_unresolved(record: OperationAdmission) {
  return record.state === 'admitting' || record.state === 'admitted' || record.state === 'uncertain'
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 9007199254740990 && value === math.floor(value)
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}
function correlation(raw: OperationCorrelation) {
  return raw && text(raw.operation_key, 192) && text(raw.attempt_id, 128) && text(raw.signature, 256)
    && integer(raw.actor_id) && integer(raw.epoch)
    && integer(raw.ordinal) && integer(raw.operation_count) && raw.operation_count <= ADMISSION_LIMITS.slots
}
function journal() {
  if (!storage.sgluna_operation_admissions) storage.sgluna_operation_admissions = []
  return storage.sgluna_operation_admissions
}
export function pinned_operation_batch_refs() {
  const refs: string[] = []
  for (const record of journal()) {
    if (!admission_unresolved(record)) continue
    for (const slot of record.slots) for (const ref of slot.batch_refs) refs.push(ref.batch_ref)
  }
  return refs
}
function trim_history() {
  const records = journal()
  let terminal = records.filter(record => !admission_unresolved(record)).length
  for (let index = 0; index < records.length && terminal > ADMISSION_LIMITS.history;) {
    if (!admission_unresolved(records[index])) {
      records.splice(index, 1)
      terminal--
    }
    else index++
  }
}

export function new_operation_admission(
  actor_provider: () => ControlledActor | undefined,
  task_status: () => { batch_generation: number, receipt_journal: TaskBatchReceipt[], tasks_added?: number },
) {
  function authorized(raw: OperationCorrelation) {
    const actor = actor_provider()
    if (!actor || !actor.is_valid || !actor.character?.valid || actor.status_snapshot().actor_id !== raw.actor_id) return false
    return remote.interfaces.sgluna_deployment?.authorize !== undefined
      && remote.call('sgluna_deployment', 'authorize', raw.epoch) === true
  }
  function find(key: string) { return journal().find(record => record.operation_key === key) }
  function refresh() {
    const status = task_status()
    for (const record of journal()) {
      if (!admission_unresolved(record)) continue
      const refs = record.slots.flatMap(slot => slot.batch_refs)
      const receipts = refs.map(ref => status.receipt_journal.find(receipt => receipt.batch_ref === ref.batch_ref
        && receipt.batch_id === ref.batch_id && receipt.batch_generation === ref.batch_generation))
      if (record.state === 'admitted' && refs.length > 0 && receipts.every(receipt => receipt?.state === 'completed')) {
        record.state = 'completed'
      }
      else if (record.state === 'admitted' && refs.length > 0 && record.slots.every(slot => slot.ok && slot.batch_refs.length > 0)
        && receipts.every(receipt => receipt?.state === 'cancelled' && receipt.started_count === 1 && receipt.failed_before_mutation === true)) {
        // The engine refused the batch's first task before it changed anything and
        // discarded the rest unstarted: no task of this admission had any effect.
        record.state = 'failed'
        record.ok = false
        record.proven_refusal = true
        record.error = 'refused_before_mutation'
        log(`[AUTORIO] operation.admission.refused request_id=${record.operation_key.split('/')[0]} operation_key=${record.operation_key} reason=engine_refused_first_task`)
      }
      else if (record.generation !== status.batch_generation || receipts.some(receipt => receipt && receipt.state !== 'completed')) {
        record.state = 'uncertain'
        record.error = 'batch_reconciliation_required'
      }
    }
    trim_history()
  }
  function begin(raw: OperationCorrelation) {
    if (!correlation(raw)) return { ok: false, error: 'invalid_correlation' }
    if (!authorized(raw)) return { ok: false, error: 'stale_actor_epoch' }
    refresh()
    const previous = find(raw.operation_key)
    if (previous) {
      if (previous.attempt_id !== raw.attempt_id || previous.signature !== raw.signature || previous.actor_id !== raw.actor_id || previous.epoch !== raw.epoch
        || previous.ordinal !== raw.ordinal || previous.operation_count !== raw.operation_count) {
        return { ok: false, error: 'operation_key_conflict' }
      }
      return { ok: true, duplicate: true, record: previous }
    }
    if (raw.ordinal <= (storage.sgluna_operation_admission_high_water ?? 0)) return { ok: false, error: 'expired_operation_ordinal' }
    if (journal().filter(admission_unresolved).length >= ADMISSION_LIMITS.unresolved) return { ok: false, error: 'admission_journal_full' }
    const record: OperationAdmission = {
      operation_key: raw.operation_key, attempt_id: raw.attempt_id, actor_id: raw.actor_id, epoch: raw.epoch, signature: raw.signature,
      ordinal: raw.ordinal, operation_count: raw.operation_count,
      state: 'admitting', generation: task_status().batch_generation, tick: game.tick, slots: [],
      work_mark: task_status().tasks_added,
    }
    journal().push(record)
    storage.sgluna_operation_admission_high_water = raw.ordinal
    log(`[AUTORIO] operation.admission.recorded request_id=${raw.operation_key.split('/')[0]} operation_key=${raw.operation_key} reason=admitting`)
    return { ok: true, record }
  }
  function slot(key: string, index: number, raw: AdmissionSlotInput) {
    refresh()
    const record = find(key)
    if (!record || !authorized(record)) return { ok: false, error: 'stale_actor_epoch' }
    if (record.state !== 'admitting' || index !== record.slots.length + 1 || index > record.operation_count
      || !raw || typeof raw.ok !== 'boolean' || !Array.isArray(raw.batch_refs) || raw.batch_refs.length > ADMISSION_LIMITS.refs) {
      return { ok: false, error: 'invalid_slot' }
    }
    const refs: TaskBatchIdentity[] = []
    for (const ref of raw.batch_refs) {
      if (!ref || !integer(ref.batch_id) || !integer(ref.batch_generation) || !text(ref.batch_ref, 96)
        || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return { ok: false, error: 'invalid_batch_ref' }
      refs.push({ batch_id: ref.batch_id, batch_generation: ref.batch_generation, batch_ref: ref.batch_ref })
    }
    const all_refs = record.slots.flatMap(slot => slot.batch_refs).map(ref => ref.batch_ref)
    for (const ref of refs) if (!all_refs.includes(ref.batch_ref)) all_refs.push(ref.batch_ref)
    if (all_refs.length > ADMISSION_LIMITS.refs) return { ok: false, error: 'batch_ref_limit' }
    const result = typeof raw.result === 'string' ? raw.result.slice(0, 512)
      : typeof raw.result === 'number' && raw.result === raw.result && Math.abs(raw.result) <= 9007199254740990 ? raw.result
        : typeof raw.result === 'boolean' ? raw.result : undefined
    // A refusal is proven pre-mutation only when it was returned (not thrown) by a
    // validate-then-queue operation and the task queue did not grow across the call.
    const tasks_added = task_status().tasks_added
    const refused = !raw.ok && raw.refused === true && typeof raw.operation === 'string'
      && PURE_SUBMIT_OPERATIONS.includes(raw.operation)
      && typeof tasks_added === 'number' && tasks_added === record.work_mark
    record.work_mark = tasks_added
    const error = typeof raw.error === 'string' ? raw.error.slice(0, 512) : undefined
    record.slots.push({
      index, ok: raw.ok, result, operation: typeof raw.operation === 'string' ? raw.operation.slice(0, 64) : undefined,
      mutation_unknown: raw.ok ? undefined : !refused,
      // The queue did not grow, so any open batch the harness saw belongs to earlier work.
      refused_before_mutation: refused ? true : undefined, refusal_code: refused ? (error ?? 'rejected').slice(0, 128) : undefined,
      error, batch_refs: refused ? [] : refs,
    })
    return { ok: true, record }
  }
  function finish(key: string, raw: { ok: boolean, error?: string }) {
    refresh()
    const record = find(key)
    if (!record || !authorized(record)) return { ok: false, error: 'stale_actor_epoch' }
    if (record.state !== 'admitting' || record.slots.length === 0 || !raw || typeof raw.ok !== 'boolean') return { ok: false, error: 'invalid_finish' }
    if (raw.ok && record.slots.length !== record.operation_count) return { ok: false, error: 'incomplete_admission' }
    const refs = record.slots.flatMap(slot => slot.batch_refs)
    record.ok = raw.ok
    record.error = typeof raw.error === 'string' ? raw.error.slice(0, 512) : undefined
    const refused_exactly = !raw.ok && refs.length === 0
      && record.slots.every(slot => slot.ok || (slot.refused_before_mutation === true && slot.mutation_unknown === false))
    record.state = raw.ok && record.slots.every(slot => slot.ok)
      ? refs.length > 0 ? 'admitted' : 'completed'
      : refused_exactly ? 'failed' : 'uncertain'
    if (refused_exactly) {
      record.proven_refusal = true
      log(`[AUTORIO] operation.admission.refused request_id=${key.split('/')[0]} operation_key=${key} reason=refused_before_mutation`)
    }
    refresh()
    return { ok: true, record }
  }
  // Settlement is harness authority, never a model tool. Actor replacement may
  // settle an old record using current guard authority and its original identity.
  function resolve(key: string, raw: { actor_id: number, epoch: number, attempt_id: string, signature: string, outcome: 'completed' | 'not_admitted' }) {
    const record = find(key)
    if (!record || !raw || !authorized({ ...record, actor_id: raw.actor_id, epoch: raw.epoch })) return { ok: false, error: 'stale_actor_epoch' }
    if (raw.attempt_id !== record.attempt_id || raw.signature !== record.signature
      || (raw.outcome !== 'completed' && raw.outcome !== 'not_admitted')) return { ok: false, error: 'invalid_resolution' }
    record.state = raw.outcome
    log(`[AUTORIO] operation.admission.resolved request_id=${key.split('/')[0]} operation_key=${key} reason=${raw.outcome}`)
    trim_history()
    return { ok: true, record }
  }
  return { begin, slot, finish, resolve, status: (key?: string) => { refresh(); return { records: key ? journal().filter(record => record.operation_key === key) : journal(), limits: ADMISSION_LIMITS, high_water: storage.sgluna_operation_admission_high_water ?? 0 } } }
}
