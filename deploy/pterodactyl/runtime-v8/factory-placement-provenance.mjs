import { completedOperationReceipt } from './operation-reconciliation.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'

export const FACTORY_PLACEMENT_LIMIT = 512
const fail = code => { throw new FactoryRegistryError(code, code) }
const positive = n => Number.isSafeInteger(n) && n > 0
const integer = n => Number.isSafeInteger(n) && n >= 0
const token = s => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(s)
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)
const copy = value => structuredClone(value)
const FIELDS = ['receipt_id', 'world_id', 'surface_index', 'force_index', 'actor_id', 'actor_epoch', 'request_id', 'goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id', 'operation_key', 'operation_id', 'batch_ref', 'batch_id', 'batch_generation', 'unit_number', 'name', 'position', 'tick']

function receipt(raw, worldId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== FIELDS.length
    || Object.keys(raw).some(key => !FIELDS.includes(key))) fail('factory_placement_schema_invalid')
  for (const key of ['receipt_id', 'request_id', 'goal_id', 'plan_id', 'step_id', 'semantic_step_id', 'operation_key', 'name']) if (!token(raw[key])) fail('factory_placement_schema_invalid')
  for (const key of ['surface_index', 'force_index', 'actor_id', 'plan_version', 'operation_id', 'batch_id', 'batch_generation', 'unit_number']) if (!positive(raw[key])) fail('factory_placement_schema_invalid')
  if (!integer(raw.actor_epoch) || !integer(raw.tick) || !uuid(raw.world_id) || raw.world_id !== worldId
    || raw.batch_ref !== `batch-g${raw.batch_generation}-${raw.batch_id}`
    || raw.receipt_id !== `${raw.world_id}/${raw.batch_ref}/${raw.operation_id}`
    || !raw.position || Object.keys(raw.position).length !== 2 || !['x', 'y'].every(k => Number.isFinite(raw.position[k]) && Math.abs(raw.position[k]) <= Number.MAX_SAFE_INTEGER)) fail('factory_placement_schema_invalid')
  return Object.fromEntries(FIELDS.map(key => [key, copy(raw[key])]))
}

// Capture before the native await/settlement. Never attribute a polled old result
// to the current mutable plan or request. Legacy/closed receipts are not adopted.
export function captureFactoryPlacementContext(memory, key, epoch) {
  const binding = memory.factoryWorldBinding?.()
  const state = memory.planningState?.(key)
  if (!uuid(binding?.world_id) || state?.goal?.status !== 'active' || state?.run?.paused) return undefined
  const candidates = (memory.pendingOperations?.(key) ?? []).flatMap(pending => {
    const plan = state.plans?.find(row => row.plan_id === pending.plan_id && row.goal_id === pending.goal_id)
    const step = plan?.steps?.find(row => row.step_id === pending.step_id)
    if (!step || !['COMMITTED', 'EXECUTING'].includes(plan.status) || pending.goal_id !== state.goal.goal_id
      || pending.actor?.actor_id !== epoch?.actor_id || pending.actor?.epoch !== epoch?.epoch
      || pending.protocol_version !== 2 || pending.operations?.length !== 1
      || !['place_entity', 'place_candidate'].includes(pending.operations[0].name)) return []
    return [{ pending: copy(pending), plan_version: plan.plan_version, semantic_step_id: step.semantic_step_id ?? step.step_id }]
  })
  return { world_id: binding.world_id, generation: binding.generation, actor: { actor_id: epoch?.actor_id, epoch: epoch?.epoch }, candidates }
}

export function deriveFactoryPlacementReceipt(status, context) {
  if (!context || !status || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch) return undefined
  const result = status.basic_operation?.last_result
  if (result?.completed !== true || result.accepted !== true || result.code !== 'completed' || result.type !== 'placing'
    || result.actor_kind !== 'standalone_character' || result.actor_id !== context.actor.actor_id
    || result.placed_world_id !== context.world_id || result.placed_last_user != null) return undefined
  const matches = context.candidates.flatMap(({ pending, plan_version, semantic_step_id }) => {
    const batch = completedOperationReceipt(pending, { status, actor: context.actor })
    const last = status.last_completed_batch
    const journal = status.admission_journal?.records ?? status.admission_journal
    const admission = Array.isArray(journal) && journal.find(row => row.operation_key === pending.operation_key)
    if (!batch || !last || batch.state !== 'completed' || batch.outcome || batch.refused_count || batch.refusals?.length
      || batch.task_count !== 1 || batch.task_types?.length !== 1 || batch.task_types[0] !== 'placing'
      || admission?.slots?.length !== 1 || admission.slots[0].operation !== pending.operations[0].name || admission.slots[0].queued_tasks !== 1
      || pending.operations[0].placed_entity !== result.entity_name || pending.surface_index !== result.placed_surface_index
      || ['batch_id', 'batch_generation', 'batch_ref'].some(field => result[`placed_${field}`] !== batch[field] || last[field] !== batch[field])
      || result.tick !== batch.tick || last.tick !== batch.tick || admission.generation !== status.batch_generation) return []
    try {
      return [receipt({ receipt_id: `${context.world_id}/${batch.batch_ref}/${result.operation_id}`, world_id: context.world_id,
        surface_index: result.placed_surface_index, force_index: result.placed_force_index, actor_id: pending.actor.actor_id, actor_epoch: pending.actor.epoch,
        request_id: pending.request_id, goal_id: pending.goal_id, plan_id: pending.plan_id, plan_version, step_id: pending.step_id, semantic_step_id,
        operation_key: pending.operation_key, operation_id: result.operation_id, batch_ref: batch.batch_ref, batch_id: batch.batch_id, batch_generation: batch.batch_generation,
        unit_number: result.placed_unit_number, name: result.entity_name, position: result.placed_position, tick: result.tick }, context.world_id)]
    }
    catch { return [] }
  })
  return matches.length === 1 ? matches[0] : undefined
}

// Append-only, private historical evidence. A capacity refusal retains all old
// facts; corruption/conflicting identities disables lookup durably. Neither case
// erases assignments or grants permission to adopt an unrecorded machine.
export class FactoryPlacementStore {
  #rows = []
  #fault
  invalidatePersistence() { this.#fault ??= 'factory_placement_persistence_failed' }
  read(id) { if (this.#fault) fail('factory_placement_store_fault'); return copy(this.#rows.find(row => row.receipt_id === id)) }
  snapshot() { return { ...(this.#rows.length ? { factory_placement_receipts: copy(this.#rows) } : {}), ...(this.#fault ? { factory_placement_fault: this.#fault } : {}) } }
  record(raw, worldId) {
    if (this.#fault) fail('factory_placement_store_fault')
    const next = receipt(raw, worldId)
    const prior = this.#rows.find(row => row.receipt_id === next.receipt_id || row.world_id === next.world_id && row.unit_number === next.unit_number)
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(next)) { this.#fault = 'factory_placement_identity_conflict'; fail(this.#fault) }
      return { status: 'duplicate', receipt: copy(prior) }
    }
    if (this.#rows.length >= FACTORY_PLACEMENT_LIMIT) fail('factory_placement_capacity')
    this.#rows.push(next)
    return { status: 'recorded', receipt: copy(next) }
  }
  restore(snapshot, worldId) {
    if (this.#fault) return
    try {
      if (Object.hasOwn(snapshot, 'factory_placement_fault')) fail('factory_placement_persisted_fault')
      const raw = snapshot.factory_placement_receipts
      if (raw === undefined) { if (this.#rows.length) fail('factory_placement_history_rewritten'); return }
      if (!Array.isArray(raw) || raw.length > FACTORY_PLACEMENT_LIMIT) fail('factory_placement_schema_invalid')
      const restored = new FactoryPlacementStore()
      for (const row of raw) if (restored.record(row, worldId).status !== 'recorded') fail('factory_placement_duplicate')
      for (const old of this.#rows) if (JSON.stringify(restored.read(old.receipt_id)) !== JSON.stringify(old)) fail('factory_placement_history_rewritten')
      this.#rows = restored.#rows
    }
    catch (error) { this.#fault = error.code ?? 'factory_placement_restore_failed' }
  }
}
