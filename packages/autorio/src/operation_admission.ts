import type { ControlledActor } from './actors/types'
import type { LayoutRecord } from './construction_layout_record'
import type { TaskBatchIdentity, TaskBatchReceipt } from './task_manager'
import { node_ids, settle_execution } from './construction_layout_record'
import { resolve_recorded_entity } from './entity_reference'

export const ADMISSION_LIMITS = { unresolved: 64, history: 64, slots: 16, refs: 16 }
export interface FluidPreservationOwner {
  goal_id: string
  plan_id: string
  plan_version: number
  step_id: string
  semantic_step_id: string
  actor_id: number
  actor_epoch: number
  session: string
}
export interface FluidQueuedBinding extends TaskBatchIdentity {
  operation_key: string
  attempt_id: string
  signature: string
  ordinal: number
  owner: FluidPreservationOwner
}
export interface OperationCorrelation {
  operation_key: string
  attempt_id: string
  actor_id: number
  epoch: number
  signature: string
  ordinal: number
  operation_count: number
  surface_index?: number
  fluid_preservation?: FluidPreservationOwner
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
  /** Tasks this slot added to the task queue (the tasks_added witness across the call). */
  queued_tasks?: number
}
/** Fields the harness supplies for a slot; the mod, not the harness, decides what a refusal proves. */
export type AdmissionSlotInput = Omit<AdmissionSlot, 'index' | 'refused_before_mutation' | 'refusal_code'> & {
  /** The operation returned a refusal (false or a false-first tuple) instead of throwing. */
  refused?: boolean
}
export interface OperationAdmission extends OperationCorrelation {
  state: 'admitting' | 'admitted' | 'uncertain' | 'completed' | 'failed' | 'partial' | 'not_admitted'
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
  /**
   * With proven_refusal from a cancelled batch: slots 1..applied_slot_count
   * ran to completion before the refusing task of the next slot.
   */
  applied_slot_count?: number
  /**
   * With state partial and error exact_construction_layout_partial: the construction layout whose execution this admission
   * queued, and which of that execution's nodes were placed and which were not when its batch closed unfinished.
   */
  layout_id?: number
  placed_node_ids?: string[]
  not_placed_node_ids?: string[]
  /** Nodes of that execution that were bound to an entity which can no longer be read. */
  missing_node_ids?: string[]
  /**
   * The exact receipt evidence the layout settlement rests on, kept with the sealed record: the journal evicts receipts once
   * the record stops pinning them, and a restart retires an unfinished batch as an uncertain receipt.
   */
  layout_receipt?: {
    batch_ref: string
    batch_id: number
    batch_generation: number
    state?: string
    reason?: string
    tick: number
    task_count: number
    tasks_started?: number
    started_count?: number
    task_types: string[]
  }
}
// Operations whose submission validates, then either queues a task or returns a
// refusal without touching the world. A refusal from any other operation
// (equip, research, follow, composite plans, ...) may follow a partial change.
export const PURE_SUBMIT_OPERATIONS = [
  'place_entity', 'mine_entity', 'mine_entity_exact', 'mine_resource_at', 'rotate_entity', 'move_items', 'move_items_exact',
  'move_items_with_player', 'set_machine_recipe', 'launch_rocket', 'wait', 'craft_item',
  'harvest_product',
]
// supply_entity's successful submission only queues submit_move_exact calls.
// Its failed submission can cancel a prefix, so it is deliberately NOT added
// to PURE_SUBMIT_OPERATIONS or the pre-mutation-refusal proof above.
const DELIVERY_OPERATIONS = ['move_items', 'move_items_exact', 'supply_entity']
declare const storage: { sgluna_operation_admissions?: OperationAdmission[], sgluna_operation_admission_high_water?: number,
  sgluna_task_receipt_journal?: TaskBatchReceipt[], sgluna_task_batch_generation?: number,
  sgluna_construction_layouts?: Record<number, LayoutRecord> }

export function admission_unresolved(record: OperationAdmission) {
  return record.state === 'admitting' || record.state === 'admitted' || record.state === 'uncertain'
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 9007199254740990 && value === math.floor(value)
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}
const fluid_owner_fields: (keyof FluidPreservationOwner)[] = ['goal_id', 'plan_id', 'plan_version', 'step_id', 'semantic_step_id', 'actor_id', 'actor_epoch', 'session']
export function valid_fluid_owner(raw: any): raw is FluidPreservationOwner {
  return !!raw && typeof raw === 'object' && Object.keys(raw).length === fluid_owner_fields.length
    && Object.keys(raw).every(key => fluid_owner_fields.includes(key as keyof FluidPreservationOwner))
    && ['goal_id', 'plan_id', 'step_id', 'semantic_step_id', 'session'].every(key => text(raw[key], 240))
    && integer(raw.plan_version) && integer(raw.actor_id) && integer(raw.actor_epoch)
}
export function same_fluid_owner(left: any, right: any) {
  return valid_fluid_owner(left) && valid_fluid_owner(right) && fluid_owner_fields.every(key => left[key] === right[key])
}
export function current_fluid_owner(actor: ControlledActor, owner: FluidPreservationOwner) {
  if (!valid_fluid_owner(owner) || !actor.is_valid || actor.status_snapshot().actor_id !== owner.actor_id
    || !remote.interfaces.sgluna_deployment?.status || !remote.interfaces.sgluna_deployment?.authorize) return false
  const current: any = remote.call('sgluna_deployment', 'status')
  return current.allowed === true && current.actor_id === owner.actor_id && current.epoch === owner.actor_epoch
    && current.session === owner.session && remote.call('sgluna_deployment', 'authorize', owner.actor_epoch) === true
}
// This capability exists only during begin→slot→finish in one native callback.
// Module state deliberately disappears on load; journal history alone cannot
// resurrect a previously admitting operation as a current caller.
let current_admitting_key: string | undefined
export function current_fluid_admission(actor: ControlledActor, key: string, signature: string, owner: FluidPreservationOwner) {
  const record = journal().find(row => row.operation_key === key)
  return current_admitting_key === key && record?.state === 'admitting' && record.operation_count === 1
    && record.signature === signature && record.actor_id === owner.actor_id && record.epoch === owner.actor_epoch
    && same_fluid_owner(record.fluid_preservation, owner) && current_fluid_owner(actor, owner) ? record : undefined
}
export function queued_fluid_admission(actor: ControlledActor, binding: FluidQueuedBinding, status: any) {
  const record = journal().find(row => row.operation_key === binding?.operation_key)
  return !!record && record.state === 'admitted' && record.operation_count === 1 && record.attempt_id === binding.attempt_id
    && record.signature === binding.signature && same_fluid_owner(record.fluid_preservation, binding.owner)
    && record.ordinal === binding.ordinal
    && current_fluid_owner(actor, binding.owner) && record.generation === binding.batch_generation
    && status.active_batch?.batch_id === binding.batch_id && status.active_batch.batch_generation === binding.batch_generation
    && status.active_batch.batch_ref === binding.batch_ref && record.slots.length === 1
    && record.slots[0].operation === 'place_candidate' && record.slots[0].ok === true
    && record.slots[0].batch_refs.length === 1 && record.slots[0].batch_refs[0].batch_id === binding.batch_id
    && record.slots[0].batch_refs[0].batch_generation === binding.batch_generation
    && record.slots[0].batch_refs[0].batch_ref === binding.batch_ref
}
function correlation(raw: OperationCorrelation) {
  return raw && text(raw.operation_key, 192) && text(raw.attempt_id, 128) && text(raw.signature, 256)
    && integer(raw.actor_id) && integer(raw.epoch)
    && integer(raw.ordinal) && integer(raw.operation_count) && raw.operation_count <= ADMISSION_LIMITS.slots
    && (raw.fluid_preservation === undefined || valid_fluid_owner(raw.fluid_preservation)
      && raw.fluid_preservation.actor_id === raw.actor_id && raw.fluid_preservation.actor_epoch === raw.epoch)
}
function journal() {
  if (!storage.sgluna_operation_admissions) storage.sgluna_operation_admissions = []
  return storage.sgluna_operation_admissions
}
// A drained refused batch accounts for every task; a cancelled tail does not.
// This closes only the native admission ledger, never verifies the step, claims
// whole-batch success or authorizes replay. The runtime separately checks its
// exact signature, current actor/epoch and idle state before allowing recovery.
function terminal_transfer_refusal(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  if (!['admitted', 'uncertain'].includes(record.state) || !integer(record.generation)
    || record.generation !== status.batch_generation || !integer(record.operation_count)
    || record.operation_count > ADMISSION_LIMITS.slots || record.slots.length !== record.operation_count) return false
  const refs: TaskBatchIdentity[] = []
  for (let index = 0; index < record.slots.length; index++) {
    const slot = record.slots[index]
    if (!slot || slot.index !== index + 1 || slot.ok !== true || slot.operation === undefined
      || !DELIVERY_OPERATIONS.includes(slot.operation) || !Array.isArray(slot.batch_refs)
      || slot.batch_refs.length === 0 || slot.batch_refs.length > ADMISSION_LIMITS.refs) return false
    for (const ref of slot.batch_refs) {
      if (!ref || !integer(ref.batch_id) || ref.batch_generation !== record.generation
        || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return false
      if (!refs.some(previous => previous.batch_ref === ref.batch_ref)) refs.push(ref)
    }
  }
  if (refs.length === 0 || refs.length > ADMISSION_LIMITS.refs) return false
  let refused = 0
  for (const ref of refs) {
    const receipt = status.receipt_journal.find(row => row.batch_id === ref.batch_id
      && row.batch_generation === ref.batch_generation && row.batch_ref === ref.batch_ref)
    if (!receipt || !integer(receipt.task_count) || receipt.task_count > 64 || receipt.started_count !== receipt.task_count
      || typeof receipt.tick !== 'number' || receipt.tick < 0 || receipt.tick > 9007199254740990 || receipt.tick !== math.floor(receipt.tick)
      || !Array.isArray(receipt.task_types) || receipt.task_types.length !== receipt.task_count
      || !receipt.task_types.every(type => type === 'moving_items')) return false
    if (receipt.state === 'completed' && receipt.outcome === undefined) continue
    if (receipt.state !== 'cancelled' || receipt.outcome !== 'refused'
      || typeof receipt.completed_count !== 'number' || receipt.completed_count < 0
      || receipt.completed_count !== math.floor(receipt.completed_count) || !integer(receipt.refused_count)
      || receipt.completed_count + receipt.refused_count !== receipt.task_count
      || !Array.isArray(receipt.refusals) || receipt.refusals.length !== receipt.refused_count) return false
    const ids: number[] = []
    for (const refusal of receipt.refusals) {
      if (!refusal || refusal.type !== 'moving_items' || refusal.code !== 'nothing_moved'
        || refusal.cause !== 'target_rejects_item' || !integer(refusal.operation_id)
        || !integer(refusal.target_unit_number) || !integer(refusal.held_count)
        || typeof refusal.tick !== 'number' || refusal.tick < 0 || refusal.tick > receipt.tick
        || refusal.tick !== math.floor(refusal.tick) || ids.includes(refusal.operation_id)) return false
      ids.push(refusal.operation_id)
    }
    refused += receipt.refused_count
  }
  return refused > 0
}
export function pinned_operation_batch_refs() {
  const refs: string[] = []
  const status = { receipt_journal: storage.sgluna_task_receipt_journal ?? [], batch_generation: storage.sgluna_task_batch_generation ?? 1 }
  for (const stored of storage.sgluna_operation_admissions ?? []) {
    const record = reconcile_record(stored, status)
    // Unpinning permits receipt eviction. Preserve this terminal decision before
    // releasing its only witness, even when no later admission refresh occurs.
    if (record.state === 'partial' && (record.error === 'exact_terminal_navigation_cancelled' || record.error === 'exact_construction_layout_partial')) Object.assign(stored, record)
    if (!admission_unresolved(record)) continue
    for (const slot of record.slots) for (const ref of slot.batch_refs) refs.push(ref.batch_ref)
  }
  return refs
}

/**
 * The number of leading slots that completed when the engine cancelled this
 * admission's batch at the first task of the next slot, before that task
 * changed anything; undefined unless every link is exact. Requires one batch
 * holding exactly the tasks these slots queued (so task indexes map to slots),
 * every slot having queued work (a slot that queued nothing acted at
 * submission, whatever its position), no refusals inside it, a placement-style failure proof naming the failing
 * task, and that task being the first one its slot queued. Tasks run in queue
 * order and a cancellation stops the rest, so earlier slots completed and
 * later ones never began.
 */
function cancelled_slot_prefix(record: OperationAdmission, receipt_for: (ref: TaskBatchIdentity) => TaskBatchReceipt | undefined) {
  const ref = record.slots.flatMap(slot => slot.batch_refs)[0]
  if (!ref) return undefined
  let queued = 0
  for (const slot of record.slots) {
    if (!slot.ok || slot.operation === undefined || !PURE_SUBMIT_OPERATIONS.includes(slot.operation)) return undefined
    const tasks = slot.queued_tasks
    if (typeof tasks !== 'number' || tasks < 1 || tasks !== math.floor(tasks) || slot.batch_refs.length !== 1) return undefined
    const own = slot.batch_refs[0]
    if (own.batch_ref !== ref.batch_ref || own.batch_id !== ref.batch_id || own.batch_generation !== ref.batch_generation) return undefined
    queued += tasks
  }
  const receipt = receipt_for(ref)
  if (receipt?.state !== 'cancelled' || receipt.failed_before_mutation !== true || receipt.task_count !== queued
    || receipt.refused_count !== undefined || (receipt.refusals?.length ?? 0) > 0) return undefined
  const failed = receipt.failed_task_index
  if (typeof failed !== 'number' || failed < 0 || failed >= queued || receipt.tasks_started !== failed + 1) return undefined
  let first = 0
  for (let position = 0; position < record.slots.length; position++) {
    if (first === failed) return position
    first += record.slots[position].queued_tasks!
    if (first > failed) return undefined
  }
  return undefined
}

function reconcile_record(stored: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  const record = { ...stored }
  if (!admission_unresolved(record)) return record
  const refs = record.slots.flatMap(slot => slot.batch_refs)
  // Mapping missing receipts creates nil holes in Lua arrays. Iterate the
  // dense reference list so absent evidence cannot make every() vacuously true.
  const receipt_for = (ref: TaskBatchIdentity) => status.receipt_journal.find(receipt => receipt.batch_ref === ref.batch_ref
    && receipt.batch_id === ref.batch_id && receipt.batch_generation === ref.batch_generation)
  if (record.state === 'admitted' && refs.length > 0 && refs.every(ref => receipt_for(ref)?.state === 'completed')) {
    record.state = 'completed'
  }
  else if (record.state === 'admitted' && refs.length > 0
    && record.slots.every(slot => slot.ok && slot.batch_refs.length > 0 && slot.operation !== undefined && PURE_SUBMIT_OPERATIONS.includes(slot.operation))
    && refs.every(ref => {
      const receipt = receipt_for(ref)
      return receipt?.state === 'cancelled' && receipt.started_count === 1 && receipt.failed_before_mutation === true
    })) {
    record.state = 'failed'
    record.ok = false
    record.proven_refusal = true
    record.error = 'refused_before_mutation'
  }
  else if (record.state === 'admitted' && refs.length > 0) {
    const applied = cancelled_slot_prefix(record, receipt_for)
    if (applied !== undefined) {
      record.state = 'failed'
      record.ok = false
      record.proven_refusal = true
      record.applied_slot_count = applied
      record.error = 'refused_before_mutation'
    }
  }
  if (admission_unresolved(record) && terminal_transfer_refusal(record, status)) {
    record.state = 'partial'
    record.ok = false
    record.error = 'exact_terminal_transfer_refusal'
  }
  else if (admission_unresolved(record) && terminal_gather_cancellation(record, status)) {
    record.state = 'partial'
    record.ok = false
    record.error = 'exact_terminal_gather_cancelled'
  }
  else if (admission_unresolved(record) && terminal_navigation_cancellation(record, status)) {
    record.state = 'partial'
    record.ok = false
    record.error = 'exact_terminal_navigation_cancelled'
  }
  else if (admission_unresolved(record) && apply_construction_layout_settlement(record, status)) {
    record.state = 'partial'
    record.ok = false
    record.error = 'exact_construction_layout_partial'
  }
  else if (admission_unresolved(record) && (record.generation !== status.batch_generation || refs.some(ref => {
    const receipt = receipt_for(ref)
    return receipt !== undefined && receipt.state !== 'completed'
  }))) {
    record.state = 'uncertain'
    record.error = 'batch_reconciliation_required'
  }
  return record
}

// Exact navigation-only cancellation is terminal partial movement (including
// possible obstacle clearing), never destination success or replay authority.
export function terminal_navigation_cancellation(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  if (record.generation !== status.batch_generation || !integer(record.actor_id) || !integer(record.epoch)
    || record.slots.length !== record.operation_count || !record.slots.length) return false
  const ref = record.slots[0]?.batch_refs[0]
  if (!ref || !integer(ref.batch_id) || ref.batch_generation !== record.generation || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return false
  for (let index = 0; index < record.slots.length; index++) {
    const slot = record.slots[index]
    if (!slot.ok || slot.index !== index + 1 || !['walk_to_position', 'walk_to_entity'].includes(slot.operation ?? '')
      || slot.queued_tasks !== 1 || slot.batch_refs.length !== 1 || slot.batch_refs[0].batch_id !== ref.batch_id
      || slot.batch_refs[0].batch_generation !== ref.batch_generation || slot.batch_refs[0].batch_ref !== ref.batch_ref) return false
  }
  if (!Array.isArray(status.receipt_journal)) return false
  const matches = status.receipt_journal.filter(row => row.batch_ref === ref.batch_ref
    || row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation)
  if (matches.length !== 1) return false
  const receipt = matches[0]
  return receipt.batch_ref === ref.batch_ref && receipt.batch_id === ref.batch_id && receipt.batch_generation === ref.batch_generation
    && receipt.state === 'cancelled' && receipt.reason === 'navigation_unreachable' && receipt.task_count === record.slots.length
    && receipt.task_types.length === receipt.task_count && receipt.task_types.every(type => type === 'walking_to_entity')
    && integer(receipt.tasks_started) && receipt.tasks_started <= receipt.task_count
    && integer(receipt.started_count) && receipt.started_count >= receipt.tasks_started && receipt.tick >= record.tick
    && receipt.outcome === undefined && !receipt.refused_count && !(receipt.refusals?.length)
}

// A cancelled gather-only batch has no hidden delivery/crafting/building tail.
// It may have mined a partial amount. This closes its native admission only;
// fresh inventory and the unchanged checkpoint still own demand and recovery.
export function terminal_gather_cancellation(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  if (record.generation !== status.batch_generation || record.slots.length !== record.operation_count || !record.slots.length) return false
  const ref = record.slots[0]?.batch_refs[0]
  if (!ref || !integer(ref.batch_id) || ref.batch_generation !== record.generation || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return false
  const types: string[] = []
  for (let index = 0; index < record.slots.length; index++) {
    const slot = record.slots[index]
    if (!slot.ok || slot.index !== index + 1 || !['gather_resource', 'mine_resource_at'].includes(slot.operation ?? '')
      || slot.batch_refs.length !== 1 || slot.batch_refs[0].batch_id !== ref.batch_id
      || slot.batch_refs[0].batch_generation !== ref.batch_generation || slot.batch_refs[0].batch_ref !== ref.batch_ref) return false
    if (slot.operation === 'gather_resource') types.push('walking_to_entity')
    types.push('mining')
    if (slot.queued_tasks !== (slot.operation === 'gather_resource' ? 2 : 1)) return false
  }
  const receipt = status.receipt_journal.find(row => row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation && row.batch_ref === ref.batch_ref)
  return receipt?.state === 'cancelled' && receipt.task_count === types.length && receipt.task_types.length === types.length
    && receipt.task_types.every((type, index) => type === types[index]) && receipt.tick >= record.tick
    && (receipt.reason === 'mining:mining_rejected' || receipt.reason === 'mining:no_target')
    && receipt.outcome === undefined && !receipt.refused_count && !(receipt.refusals?.length)
}
// A single execute_construction_plan admission whose placement batch ended unfinished, matched to the construction layout that
// execution built by the exact batch identity it was queued under. The layout's execution is settled from its durable node
// evidence (a node bound to an entity that can still be read is placed; one still queued was never built; a bound node whose
// entity is gone is missing) and the admission reports which nodes were which: a partial layout, never completion and never
// replay authority. The batch ended unfinished when its receipt is cancelled, or, after a restart, when the retained receipt of
// a batch of an earlier generation says the save was loaded with it unfinished (startup retires the whole queue, so nothing of
// that batch can still run). Undefined unless every link is exact: generation, actor, one slot with one batch reference, one
// receipt for it with only placement tasks (as many as the slot queued and the execution recorded), no refusals, and exactly
// one layout whose execution carries that batch identity under the same actor and surface. `receipt` is the exact evidence
// the settlement rests on; the sealed admission keeps a copy so it outlives the journal's receipt.
export function terminal_construction_layout_settlement(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  if (!integer(record.generation) || !integer(status.batch_generation) || record.generation > status.batch_generation
    || !integer(record.actor_id) || !integer(record.epoch) || record.operation_count !== 1 || record.slots.length !== 1) return undefined
  const slot = record.slots[0]
  if (!slot.ok || slot.index !== 1 || slot.operation !== 'execute_construction_plan' || !integer(slot.queued_tasks)
    || slot.batch_refs.length !== 1) return undefined
  const ref = slot.batch_refs[0]
  if (!integer(ref.batch_id) || ref.batch_generation !== record.generation || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return undefined
  if (!Array.isArray(status.receipt_journal)) return undefined
  const matches = status.receipt_journal.filter(row => row.batch_ref === ref.batch_ref
    || row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation)
  if (matches.length !== 1) return undefined
  const receipt = matches[0]
  const retired = receipt.state === 'uncertain' && receipt.reason === 'save_load_unfinished' && receipt.batch_generation < status.batch_generation
  if (receipt.batch_ref !== ref.batch_ref || receipt.batch_id !== ref.batch_id || receipt.batch_generation !== ref.batch_generation
    || (receipt.state !== 'cancelled' && !retired) || receipt.task_count !== slot.queued_tasks
    || !Array.isArray(receipt.task_types) || receipt.task_types.length !== receipt.task_count
    || !receipt.task_types.every(type => type === 'placing')
    || (receipt.state === 'cancelled' && (!integer(receipt.tasks_started) || receipt.tasks_started > receipt.task_count
      || !integer(receipt.started_count) || receipt.started_count < receipt.tasks_started))
    || typeof receipt.tick !== 'number' || receipt.tick < record.tick
    || receipt.outcome !== undefined || receipt.refused_count || (receipt.refusals?.length ?? 0) > 0) return undefined
  let layout: LayoutRecord | undefined
  for (const key in storage.sgluna_construction_layouts ?? {}) {
    const candidate = storage.sgluna_construction_layouts![key as unknown as number]
    const execution = candidate.executions?.[candidate.executions.length - 1]
    if (execution?.batch_ref !== ref.batch_ref || execution.batch_id !== ref.batch_id || execution.batch_generation !== ref.batch_generation) continue
    if (layout !== undefined) return undefined
    layout = candidate
  }
  if (layout === undefined || layout.actor_id !== record.actor_id
    || (record.surface_index !== undefined && layout.surface_index !== record.surface_index)) return undefined
  const execution = layout.executions[layout.executions.length - 1]
  if (execution.queued_nodes.length !== slot.queued_tasks) return undefined
  const surface_index = layout.surface_index
  const force_index = layout.force_index
  const settled = settle_execution(layout, execution, receipt.tick, (node) => {
    const entity = node.unit_number === undefined ? undefined : resolve_recorded_entity(node.unit_number, surface_index, force_index)
    return entity === undefined ? undefined : { name: entity.name, position: { x: entity.position.x, y: entity.position.y }, direction: entity.direction }
  })
  return {
    layout_id: layout.layout_id,
    placed_node_ids: node_ids(layout, settled.placed),
    not_placed_node_ids: node_ids(layout, settled.not_placed),
    missing_node_ids: node_ids(layout, settled.missing ?? []),
    layout_receipt: {
      batch_ref: receipt.batch_ref, batch_id: receipt.batch_id, batch_generation: receipt.batch_generation, state: receipt.state,
      reason: typeof receipt.reason === 'string' ? receipt.reason.slice(0, 128) : undefined, tick: receipt.tick,
      task_count: receipt.task_count, tasks_started: receipt.tasks_started, started_count: receipt.started_count, task_types: receipt.task_types.slice(0, 64),
    },
  }
}

function apply_construction_layout_settlement(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }) {
  const settlement = terminal_construction_layout_settlement(record, status)
  if (settlement === undefined) return false
  record.layout_id = settlement.layout_id
  record.placed_node_ids = settlement.placed_node_ids
  record.not_placed_node_ids = settlement.not_placed_node_ids
  record.missing_node_ids = settlement.missing_node_ids.length > 0 ? settlement.missing_node_ids : undefined
  record.layout_receipt = settlement.layout_receipt
  return true
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
  function refresh(persist = true) {
    const status = task_status()
    // Observation derives terminal state from receipts without changing the
    // admission ledger. Admission mutations commit the same reconciliation.
    const records = persist ? journal() : (storage.sgluna_operation_admissions ?? []).map(record => ({ ...record }))
    for (const record of records) {
      const derived = reconcile_record(record, status)
      if (persist && derived.state === 'failed' && record.state !== 'failed') {
        log(`[AUTORIO] operation.admission.refused request_id=${record.operation_key.split('/')[0]} operation_key=${record.operation_key} reason=engine_refused_first_task`)
      }
      if (persist && derived.state === 'partial' && record.state !== 'partial') {
        log(`[AUTORIO] operation.admission.partial request_id=${record.operation_key.split('/')[0]} operation_key=${record.operation_key} reason=${derived.error}`)
      }
      Object.assign(record, derived)
    }
    if (persist) trim_history()
    return records
  }
  function begin(raw: OperationCorrelation) {
    current_admitting_key = undefined
    if (!correlation(raw)) return { ok: false, error: 'invalid_correlation' }
    if (!authorized(raw)) return { ok: false, error: 'stale_actor_epoch' }
    if (raw.fluid_preservation && !current_fluid_owner(actor_provider()!, raw.fluid_preservation)) return { ok: false, error: 'stale_fluid_owner' }
    if (raw.surface_index !== undefined && (!integer(raw.surface_index) || actor_provider()?.surface.index !== raw.surface_index)) return { ok: false, error: 'stale_actor_surface' }
    refresh()
    const previous = find(raw.operation_key)
    if (previous) {
      if (previous.attempt_id !== raw.attempt_id || previous.signature !== raw.signature || previous.actor_id !== raw.actor_id || previous.epoch !== raw.epoch
        || previous.ordinal !== raw.ordinal || previous.operation_count !== raw.operation_count
        || (previous.fluid_preservation !== undefined || raw.fluid_preservation !== undefined) && !same_fluid_owner(previous.fluid_preservation, raw.fluid_preservation)) {
        return { ok: false, error: 'operation_key_conflict' }
      }
      return { ok: true, duplicate: true, record: previous }
    }
    if (raw.ordinal <= (storage.sgluna_operation_admission_high_water ?? 0)) return { ok: false, error: 'expired_operation_ordinal' }
    if (journal().filter(admission_unresolved).length >= ADMISSION_LIMITS.unresolved) return { ok: false, error: 'admission_journal_full' }
    const record: OperationAdmission = {
      operation_key: raw.operation_key, attempt_id: raw.attempt_id, actor_id: raw.actor_id, epoch: raw.epoch, signature: raw.signature,
      ordinal: raw.ordinal, operation_count: raw.operation_count,
      ...(raw.surface_index !== undefined ? { surface_index: raw.surface_index } : {}),
      ...(raw.fluid_preservation !== undefined ? { fluid_preservation: { ...raw.fluid_preservation } } : {}),
      state: 'admitting', generation: task_status().batch_generation, tick: game.tick, slots: [],
      work_mark: task_status().tasks_added,
    }
    journal().push(record)
    current_admitting_key = raw.operation_key
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
    const queued_tasks = raw.ok && typeof tasks_added === 'number' && typeof record.work_mark === 'number' && tasks_added >= record.work_mark
      ? tasks_added - record.work_mark : undefined
    record.work_mark = tasks_added
    const error = typeof raw.error === 'string' ? raw.error.slice(0, 512) : undefined
    record.slots.push({
      index, ok: raw.ok, result, operation: typeof raw.operation === 'string' ? raw.operation.slice(0, 64) : undefined,
      mutation_unknown: raw.ok ? undefined : !refused,
      // The queue did not grow, so any open batch the harness saw belongs to earlier work.
      refused_before_mutation: refused ? true : undefined, refusal_code: refused ? (error ?? 'rejected').slice(0, 128) : undefined,
      error, batch_refs: refused ? [] : refs, queued_tasks,
    })
    return { ok: true, record }
  }
  function finish(key: string, raw: { ok: boolean, error?: string }) {
    if (current_admitting_key === key) current_admitting_key = undefined
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
  return { begin, slot, finish, resolve, leave: (key: string) => {
    if (current_admitting_key === key) current_admitting_key = undefined
    return true
  }, status: (key?: string) => {
    const records = refresh(false)
    return { records: key ? records.filter(record => record.operation_key === key) : records,
      limits: ADMISSION_LIMITS, high_water: storage.sgluna_operation_admission_high_water ?? 0 }
  } }
}
