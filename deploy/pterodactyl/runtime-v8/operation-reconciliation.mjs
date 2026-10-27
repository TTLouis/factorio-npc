// MW2b operation reconciliation (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3: "No blind replay of a command whose
// acknowledgement was lost, and no uncertain operation counted as successful").
//
// Pure helpers for each outstanding operation batch. The runtime records a PENDING record
// before it sends a batch (what was sent, for which plan and step, by which actor and epoch, and where the mod's batch counter
// stood), and settles it when the batch's receipt arrives. If the acknowledgement is lost, or the process restarts, the record
// is still there: the runtime asks the mod what really happened, using exactly the correlation the mod already exposes (batch
// ids and the batch generation in `autorio_operations.status`, plus the actor id and epoch), BEFORE it issues anything again.
//
// No I/O and no clock here. The reducer stores the campaign ledger; the agent loop reads the
// status and traces the verdict.

import { createHash } from 'node:crypto'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { strictTaskTypesForOperation } from './step-completion.mjs'

export const PENDING_OPERATION_LIMITS = Object.freeze({
  operations: 16,
  // The mod admission journal accepts at most 192 characters (operation_admission.ts).
  operation_key: 192,
  ref: 200,
  reason: 300,
})

// Operation names whose effect on the world is not safe to repeat blindly.
const DELIVERY_OPERATIONS = new Set(['move_items', 'move_items_exact', 'move_items_with_player', 'supply_entity'])
const CRAFT_OPERATIONS = new Set(['craft_item'])
const PLACE_OPERATIONS = new Set(['place_entity', 'place_candidate', 'execute_construction_plan'])
const WORLD_OPERATIONS = new Set(['prepare_pump_site', 'mine_entity', 'mine_entity_exact', 'clear_area', 'rotate_entity', 'rotate_entity_exact', 'set_machine_recipe', 'equip_weapon', 'equip_ammo', 'equip_armor'])

export function effectClassOf(name) {
  if (DELIVERY_OPERATIONS.has(name)) return 'delivery'
  if (CRAFT_OPERATIONS.has(name)) return 'craft'
  if (PLACE_OPERATIONS.has(name)) return 'place'
  if (WORLD_OPERATIONS.has(name)) return 'world'
  return ['wait', 'walk_to_entity', 'walk_to_position', 'walk_to_player', 'follow_player', 'stop_follow', 'cancel_all_tasks'].includes(name) ? 'other' : 'world'
}

function effectScopes(operation) {
  if (effectClassOf(operation?.name) === 'other') return []
  const args = operation?.args ?? {}
  const scopes = []
  for (const key of ['unit_number', 'target_unit_number']) if (Number.isSafeInteger(args[key])) scopes.push(`entity:${args[key]}`)
  for (const key of ['item_name', 'entity_name', 'recipe_name']) if (typeof args[key] === 'string') scopes.push(`item:${args[key]}`)
  const position = args.position ?? args.target_position
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) scopes.push(`position:${position.x}:${position.y}`)
  // Only item transfers have a grounded material identity in the operation
  // arguments. Mining/placement/prototype aliases need engine-derived material
  // scopes; an exact entity ID alone cannot establish inventory independence.
  if (scopes.length === 0 || !['move_items', 'move_items_exact'].includes(operation?.name)) scopes.push('*')
  return scopes
}

// The one refusal and operation the receipt derivation covers: a coordinate-free place_entity. The mod emits `no_position`
// only from its own ring search for a placement that carried no position (basic_operation_runtime.ts `!task.position`), so the
// code itself proves the coordinate-free shape. Every other placing refusal (a preservation guard's
// placement_candidate_unavailable, not_placeable, a place_candidate) keeps the mod's own, conservative admission verdict.
const DERIVED_SETTLEMENT_REASON = 'placing:no_position'
const DERIVED_SETTLEMENT_OPERATION = 'place_entity'
// Operations whose completed receipt proves the corrected placement of a settled prefix recovery landed.
export const PLACEMENT_FENCE_CLOSING_OPERATIONS = new Set(['place_entity', 'place_candidate'])

// The receipt task types an operation queued, for the operations whose every task has strict runtime completion semantics
// (step-completion.mjs STRICT_TASKS_BY_OPERATION). Operations that queue a variable number of identical tasks are sized by
// what the admission slot recorded; anything else is undefined, which keeps the batch unproven.
function strictQueuedTaskTypes(name, queued) {
  if (name === 'supply_entity') return Array.from({ length: queued }, () => 'moving_items')
  if (name === 'execute_construction_plan') return Array.from({ length: queued }, () => 'placing')
  const types = strictTaskTypesForOperation({ name, args: {} })
  return Array.isArray(types) && types.length === queued ? types : undefined
}

/**
 * Per-operation settlement of ONE batch that the engine cancelled when a placement task refused before it created anything,
 * derived by the harness from the native receipt and the admission slots. The mod's own admission verdict
 * (provenRefusal / operation_admission.ts) stays conservative for prefixes that are not pure submissions (a supply_entity
 * before a placement leaves the row 'uncertain'); this re-derives the same conclusion from facts the receipt records:
 *   - tasks of one batch are queued in operation order and run strictly one after another (task_manager next_task activates
 *     the next task only from complete()/refuse() of the previous one, or from the batch closing), so a task that began
 *     was preceded by the completion of every earlier task;
 *   - the receipt names the failing task (failed_task_index, set only when it is the task running now) and that it changed
 *     nothing (failed_before_mutation), and tasks_started proves no later task began;
 *   - no refused (skipped) operations ride on the receipt, so no earlier task was skipped instead of completed.
 * Every link is re-checked: one admission row, one batch ref, queued tasks accounting for the whole receipt, the failing task
 * is a placing task and the first (only) task of its slot, and each earlier slot's receipt tasks have the strict task types
 * of its operation. Anything else returns null and the batch keeps its unresolved effect.
 *
 * With no earlier slot (failed_task_index 0: the placement is the first task) the prefix is empty, the placement is no_effect and
 * every later operation is not_started; nothing of the batch happened.
 *
 * A completed earlier task means the engine finished it, not that a requested quantity moved in full: a supply_entity task
 * completes when a positive count was inserted, possibly fewer than requested. The settlement says "completed", never "exact".
 */
export function cancelledBatchPrefix(admission, status, pendingOperations) {
  if (!isRecord(admission) || !['admitted', 'uncertain'].includes(admission.state) || !isRecord(status) || status.status_error || status.error) return null
  if (status.task_state !== 'idle' || status.queue_length !== 0 || status.active_batch) return null
  const slots = admission.slots
  if (!Array.isArray(slots) || slots.length < 1 || slots.length !== admission.operation_count || admission.generation !== status.batch_generation) return null
  if (Array.isArray(pendingOperations) && (pendingOperations.length !== slots.length
    || pendingOperations.some((operation, index) => operation?.name !== slots[index]?.operation))) return null
  const ref = slots[0]?.batch_refs?.[0]
  if (!isRecord(ref) || !Number.isSafeInteger(ref.batch_id) || ref.batch_id < 1 || ref.batch_generation !== admission.generation
    || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return null
  const starts = []
  let queued = 0
  for (const [index, slot] of slots.entries()) {
    if (!isRecord(slot) || slot.index !== index + 1 || slot.ok !== true || typeof slot.operation !== 'string'
      || !Number.isSafeInteger(slot.queued_tasks) || slot.queued_tasks < 1 || slot.queued_tasks > 64
      || !Array.isArray(slot.batch_refs) || slot.batch_refs.length !== 1
      || slot.batch_refs[0]?.batch_id !== ref.batch_id || slot.batch_refs[0].batch_generation !== ref.batch_generation
      || slot.batch_refs[0].batch_ref !== ref.batch_ref) return null
    starts.push(queued)
    queued += slot.queued_tasks
  }
  if (!Array.isArray(status.receipt_journal)) return null
  const rows = status.receipt_journal.filter(row => isRecord(row) && (row.batch_ref === ref.batch_ref
    || row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation))
  if (rows.length !== 1) return null
  const receipt = rows[0]
  const failed = receipt.failed_task_index
  if (receipt.batch_ref !== ref.batch_ref || receipt.batch_id !== ref.batch_id || receipt.batch_generation !== ref.batch_generation
    || receipt.state !== 'cancelled' || receipt.failed_before_mutation !== true || receipt.task_count !== queued
    || receipt.outcome !== undefined || receipt.refused_count !== undefined || (Array.isArray(receipt.refusals) && receipt.refusals.length > 0)
    || !Array.isArray(receipt.task_types) || receipt.task_types.length !== queued
    || !Number.isSafeInteger(failed) || failed < 0 || failed >= queued || receipt.tasks_started !== failed + 1
    || !Number.isSafeInteger(receipt.started_count) || receipt.started_count < receipt.tasks_started
    || !Number.isSafeInteger(receipt.tick) || !Number.isSafeInteger(admission.tick) || receipt.tick < admission.tick
    || receipt.task_types[failed] !== 'placing' || receipt.reason !== DERIVED_SETTLEMENT_REASON) return null
  const position = starts.indexOf(failed)
  if (position < 0 || slots[position].operation !== DERIVED_SETTLEMENT_OPERATION || slots[position].queued_tasks !== 1) return null
  for (let index = 0; index < position; index++) {
    const expected = strictQueuedTaskTypes(slots[index].operation, slots[index].queued_tasks)
    if (!expected || expected.some((type, offset) => receipt.task_types[starts[index] + offset] !== type)) return null
  }
  return {
    applied_slots: slots.slice(0, position).map(slot => slot.index),
    refused_slots: [slots[position].index],
    refusal_codes: [text(receipt.reason, 80)].filter(Boolean),
    unrun_slots: slots.length - position - 1,
    basis: 'harness_receipt_derivation',
    receipt: {
      batch_id: ref.batch_id, batch_generation: ref.batch_generation, batch_ref: ref.batch_ref, reason: text(receipt.reason, 80),
      task_count: receipt.task_count, failed_task_index: failed, tasks_started: receipt.tasks_started,
      started_count: receipt.started_count, tick: receipt.tick,
    },
  }
}

// Per-operation dispositions of a settled refusal, for the trace and for the receipt evidence the board keeps.
//   completed    its tasks ran to completion before the refusal (a delivery moved a positive, possibly partial, count)
//   no_effect    the refused operation changed nothing
//   not_started  its tasks never began
export function settlementRows(operations, refusal) {
  const applied = new Set(refusal?.applied_slots ?? [])
  const refused = new Set(refusal?.refused_slots ?? [])
  return (Array.isArray(operations) ? operations : []).map((operation, index) => ({
    slot: index + 1,
    operation: text(operation?.name ?? operation?.operation, 80),
    disposition: applied.has(index + 1) ? 'completed' : refused.has(index + 1) ? 'no_effect' : 'not_started',
  }))
}

// ---------------------------------------------------------------------------------------------------------------------------
// Settled-prefix replay fence (Run BC B, iteration 2)
//
// A completed prefix that the harness settled from the native receipt must not be delivered again while the refused placement
// is still being recovered: the pending record is archived as a closed ledger record that carries the per-slot canonical
// operation identities, and operation-ledger.mjs refuses any batch in the same plan/step that repeats one of them.
// ---------------------------------------------------------------------------------------------------------------------------
export const SETTLED_PREFIX_KIND = 'completed_prefix_placement_refused'

/** Canonical identity of ONE operation: the same name + canonical-args digest the batch signature is built from. */
export function operationIdentity(operation) {
  return operationSignature([{ name: operation?.name, args: operation?.args ?? {} }])
}

/**
 * Item-delivery keys of one operation, independent of the count and of which tool carried it. A partial delivery (fewer items
 * moved than requested) is still a completed delivery, so the fence has to cover "the same transfer with another count".
 * Only transfers with an exact entity target have a grounded identity; anything else yields no keys (identity still applies).
 */
export function deliveryKeys(operation) {
  const args = operation?.args
  if (!DELIVERY_OPERATIONS.has(operation?.name) || !isRecord(args)) return []
  const unit = Number.isSafeInteger(args.unit_number) ? args.unit_number : Number.isSafeInteger(args.target_unit_number) ? args.target_unit_number : undefined
  if (unit === undefined) return []
  const direction = operation.name === 'supply_entity' || args.to_entity !== false ? 'to_entity' : 'from_entity'
  const items = Array.isArray(args.items) ? args.items.map(item => item?.item_name) : [args.item_name]
  return [...new Set(items.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 120))]
    .slice(0, 8).map(item => `delivery|${direction}|${unit}|${item}`)
}

/**
 * The record fields to persist on the pending record just before the reconciler's derived settlement closes it, so the closed
 * ledger entry carries what happened: effect partial_known, the verdict, and the completed slots' identities. Null unless the
 * settlement was derived from the native receipt AND at least one earlier operation completed (an empty prefix needs no fence).
 */
export function settledPrefixPatch(pending, result) {
  if (result?.verdict !== RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION || result.basis !== 'harness_receipt_derivation'
    || result.reason !== 'exact_cancelled_prefix_before_mutation' || !Array.isArray(result.applied_slots) || result.applied_slots.length < 1
    || typeof result.receipt?.batch_ref !== 'string' || result.refused_slots?.length !== 1) return null
  const completed = []
  for (const slot of result.applied_slots) {
    const operation = pending?.operations?.[slot - 1]
    if (!operation) return null
    completed.push({ slot, operation: text(operation.name, 80), identity: typeof operation.identity === 'string' ? operation.identity : null,
      delivery_keys: Array.isArray(operation.delivery_keys) ? operation.delivery_keys : [] })
  }
  return {
    effect: EFFECT.PARTIAL_KNOWN, verdict: result.verdict, reason: result.reason, batch_id: result.receipt.batch_id ?? null,
    settlement: {
      kind: SETTLED_PREFIX_KIND, basis: result.basis, batch_ref: result.receipt.batch_ref, refused_slot: result.refused_slots[0],
      refusal_codes: (result.refusal_codes ?? []).slice(0, 4).map(code => text(code, 80)),
      completed, identity_complete: completed.every(item => item.identity),
    },
  }
}

/** The record fields that mark a batch as completed (exact receipts) and containing a placement; closes an open settled-prefix fence. */
export function completedPlacementPatch(pending, result) {
  if (result?.verdict !== RECONCILE_VERDICT.ADMITTED_COMPLETED || !(pending?.operations ?? []).some(operation => PLACEMENT_FENCE_CLOSING_OPERATIONS.has(operation.name))) return null
  return { effect: EFFECT.HAPPENED, verdict: result.verdict, reason: result.reason ?? '', batch_id: Number.isSafeInteger(result.batch_id) ? result.batch_id : null }
}

/** Does this closed record's completed placement close an earlier settled-prefix fence of the same goal, plan and step? */
export function closesSettledPrefix(later, fence) {
  return Boolean(later && fence) && later.verdict === RECONCILE_VERDICT.ADMITTED_COMPLETED
    && later.goal_id === fence.goal_id && later.plan_id === fence.plan_id && later.step_id === fence.step_id
    && (later.operations ?? []).some(operation => PLACEMENT_FENCE_CLOSING_OPERATIONS.has(operation.name))
}

export const PENDING_STATE = Object.freeze({
  // Written before the batch was sent: the outcome is unknown.
  SENT: 'sent',
  // The game acknowledged the batch: it was admitted; only the completion receipt is outstanding.
  ACKNOWLEDGED: 'acknowledged',
  // The acknowledgement was lost and reconciliation could not prove what happened.
  UNRECONCILED: 'unreconciled',
  // Reconciliation proved the batch reached the game (in flight, completed or cancelled).
  ADMITTED: 'admitted',
})

export const RECONCILE_VERDICT = Object.freeze({
  ADMITTED_IN_FLIGHT: 'admitted_in_flight',
  ADMITTED_COMPLETED: 'admitted_completed',
  ADMITTED_PARTIAL: 'admitted_partial',
  ADMITTED_CANCELLED: 'admitted_cancelled',
  NOT_ADMITTED: 'not_admitted',
  // The mod proved each refused operation changed nothing (a validation refusal, or the engine refusing the batch's
  // first task before it created anything). Operations that completed synchronously before it did happen.
  REFUSED_BEFORE_MUTATION: 'refused_before_mutation',
  STALE_ACTOR: 'stale_actor',
  GENERATION_CHANGED: 'generation_changed',
  UNKNOWN: 'unknown',
})

// What the world may look like after each verdict. `happened` and `in_flight` mean the effect is real or on its way;
// `unknown` and `partial_unknown` mean it may be; only `not_happened` allows the same operation to be issued again.
export const EFFECT = Object.freeze({
  HAPPENED: 'happened',
  IN_FLIGHT: 'in_flight',
  PARTIAL_UNKNOWN: 'partial_unknown',
  PARTIAL_KNOWN: 'partial_known',
  UNKNOWN: 'unknown',
  NOT_HAPPENED: 'not_happened',
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value, max = 200) {
  const cleaned = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

// The full canonical batch is bound to its admission with a collision-resistant digest.
export function operationSignature(operations) {
  const source = canonicalJson((Array.isArray(operations) ? operations : []).map(operation => ({ name: operation?.name, args: operation?.args ?? {} })))
  return createHash('sha256').update(source).digest('hex')
}

/**
 * Where the mod's batch counter stood, from a raw or parsed `autorio_operations.status`. `max_batch_id` is the highest
 * batch id any of the three batch records carries (the counter itself is persisted in the save and never decreases);
 * `active` carries the open batch's id and task count, because a new operation joins an open batch instead of creating one.
 */
export function batchWatermark(rawStatus) {
  let status = rawStatus
  if (typeof rawStatus === 'string') {
    try { status = JSON.parse(rawStatus) }
    catch { return undefined }
  }
  if (!isRecord(status) || status.status_error || status.error) return undefined
  const ids = []
  const take = (batch) => {
    if (isRecord(batch) && Number.isSafeInteger(batch.batch_id)) ids.push(batch.batch_id)
  }
  take(status.active_batch)
  take(status.last_completed_batch)
  take(status.last_cancelled_batch)
  const active = isRecord(status.active_batch) && Number.isSafeInteger(status.active_batch.batch_id)
    ? {
        batch_id: status.active_batch.batch_id,
        task_count: Number.isSafeInteger(status.active_batch.task_count) ? status.active_batch.task_count : 0,
      }
    : null
  const completed = isRecord(status.last_completed_batch) && Number.isSafeInteger(status.last_completed_batch.batch_id)
    ? { batch_id: status.last_completed_batch.batch_id, tick: Number.isFinite(status.last_completed_batch.tick) ? status.last_completed_batch.tick : null }
    : null
  const cancelled = isRecord(status.last_cancelled_batch) && Number.isSafeInteger(status.last_cancelled_batch.batch_id)
    ? { batch_id: status.last_cancelled_batch.batch_id, tick: Number.isFinite(status.last_cancelled_batch.tick) ? status.last_cancelled_batch.tick : null }
    : null
  return {
    generation: Number.isSafeInteger(status.batch_generation) ? status.batch_generation : null,
    max_batch_id: ids.length > 0 ? Math.max(...ids) : 0,
    active,
    completed,
    cancelled,
    queue_length: Number.isSafeInteger(status.queue_length) ? status.queue_length : null,
    idle: typeof status.task_state === 'string' ? status.task_state.trim().toLowerCase() === 'idle' : null,
  }
}

/** The durable record written before a batch is sent. `baseline` is `batchWatermark` of the status read just before. */
export function buildPendingOperation({ requestId, operationKey, attemptId, ordinal, protocolVersion, operations, goalId, planId, stepId, actor, baseline, now, surfaceIndex } = {}) {
  const list = (Array.isArray(operations) ? operations : []).slice(0, PENDING_OPERATION_LIMITS.operations)
  return {
    operation_key: text(operationKey ?? `${requestId ?? 'request'}/batch`, PENDING_OPERATION_LIMITS.operation_key),
    request_id: text(requestId, 120),
    attempt_id: text(attemptId ?? operationKey ?? `${requestId ?? 'request'}/batch`, 200),
    protocol_version: protocolVersion === 2 ? 2 : 1,
    ...(Number.isSafeInteger(surfaceIndex) && surfaceIndex > 0 ? { surface_index: surfaceIndex } : {}),
    ordinal: Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : null,
    scopes: [...new Set(list.flatMap(effectScopes))],
    state: PENDING_STATE.SENT,
    goal_id: text(goalId, 120) || null,
    plan_id: text(planId, PENDING_OPERATION_LIMITS.ref) || null,
    step_id: text(stepId, PENDING_OPERATION_LIMITS.ref) || null,
    actor: {
      actor_id: Number.isSafeInteger(actor?.actor_id) ? actor.actor_id : null,
      epoch: Number.isSafeInteger(actor?.epoch) ? actor.epoch : null,
    },
    signature: operationSignature(list),
    operations: list.map((operation, index) => ({
      trace_operation_id: text(operation?.trace_operation_id ?? `${requestId ?? 'request'}/op_${index + 1}`, PENDING_OPERATION_LIMITS.ref),
      name: text(operation?.name, 80),
      ...(['gather_resource', 'mine_resource_at'].includes(operation?.name) && isRecord(operation.args) ? { args: { ...operation.args } } : {}),
      // The operation's canonical identity (name + canonical args digest) and its item-delivery keys: all that survives of the
      // arguments, kept so a settled completed prefix can fence a replay of these exact slots (operation-ledger.mjs).
      identity: operationIdentity(operation),
      ...(deliveryKeys(operation).length > 0 ? { delivery_keys: deliveryKeys(operation) } : {}),
      effect_class: effectClassOf(operation?.name),
    })),
    baseline: baseline ?? null,
    effect: EFFECT.UNKNOWN,
    verdict: null,
    reason: '',
    sent_at: Number.isFinite(now) ? now : 0,
  }
}

/**
 * Exact proof from the mod's journal that an admission's refused operations changed nothing. Two shapes, both set by the mod
 * (never by the harness):
 *   - synchronous: state `failed`, no slot carries batch refs, and every non-ok slot is `refused_before_mutation` with
 *     `mutation_unknown === false`. The ok slots completed synchronously; operations after the refusal never ran.
 *   - engine-refused: state `failed`, every slot is ok with batch refs, and every referenced receipt is a cancellation whose
 *     first task refused before any change (`started_count === 1`, `failed_before_mutation`). No task had any effect.
 *   - engine-refused after a prefix: state `failed` with `applied_slot_count`, one batch holding exactly the tasks the slots
 *     queued, and a cancellation proof naming the failing task as the first task of slot applied_slot_count + 1
 *     (`failed_task_index`, `tasks_started`). Earlier slots completed; later ones never began. Re-derived here, not trusted.
 * Anything else (a thrown error, an unknown operation, queued work in flight, a reload) is not proof.
 */
export function provenRefusal(admission, status) {
  if (admission?.state !== 'failed' || admission.proven_refusal !== true) return null
  const slots = Array.isArray(admission.slots) ? admission.slots : []
  if (slots.length === 0) return null
  const refs = slots.flatMap(slot => Array.isArray(slot?.batch_refs) ? slot.batch_refs : [])
  if (refs.length === 0) {
    if (!slots.every(slot => slot?.ok === true || (slot?.refused_before_mutation === true && slot?.mutation_unknown === false))) return null
    const refused = slots.filter(slot => slot.ok !== true)
    if (refused.length === 0) return null
    return { applied_slots: slots.filter(slot => slot.ok === true).map(slot => slot.index), refused_slots: refused.map(slot => slot.index),
      refusal_codes: refused.map(slot => text(slot.refusal_code, 80)).filter(Boolean).slice(0, 4), unrun_slots: Math.max(0, (admission.operation_count ?? slots.length) - slots.length) }
  }
  const receipts = Array.isArray(status?.receipt_journal) ? status.receipt_journal : []
  if (!slots.every(slot => slot?.ok === true && Array.isArray(slot.batch_refs) && slot.batch_refs.length > 0)) return null
  if (admission.applied_slot_count !== undefined) return cancelledSlotPrefix(admission, slots, receipts)
  const proven = refs.every(ref => receipts.some(receipt => receipt?.batch_ref === ref.batch_ref && receipt.batch_id === ref.batch_id
    && receipt.batch_generation === ref.batch_generation && receipt.state === 'cancelled' && receipt.started_count === 1
    && receipt.failed_before_mutation === true))
  if (!proven) return null
  return { applied_slots: [], refused_slots: slots.map(slot => slot.index), refusal_codes: [text(receipts.find(receipt => receipt?.batch_ref === refs[0].batch_ref)?.reason, 80)].filter(Boolean),
    unrun_slots: 0 }
}

function cancelledSlotPrefix(admission, slots, receipts) {
  const applied = admission.applied_slot_count
  if (!Number.isSafeInteger(applied) || applied < 0 || applied >= slots.length || slots.length !== admission.operation_count) return null
  const ref = slots[0].batch_refs[0]
  if (!slots.every(slot => slot.batch_refs.length === 1 && slot.batch_refs[0]?.batch_ref === ref?.batch_ref
    && slot.batch_refs[0].batch_id === ref.batch_id && slot.batch_refs[0].batch_generation === ref.batch_generation
    && Number.isSafeInteger(slot.queued_tasks) && slot.queued_tasks >= 1)) return null
  const receipt = receipts.find(entry => entry?.batch_ref === ref.batch_ref && entry.batch_id === ref.batch_id
    && entry.batch_generation === ref.batch_generation)
  const queued = slots.reduce((sum, slot) => sum + slot.queued_tasks, 0)
  const failed = slots.slice(0, applied).reduce((sum, slot) => sum + slot.queued_tasks, 0)
  if (receipt?.state !== 'cancelled' || receipt.failed_before_mutation !== true || receipt.task_count !== queued
    || receipt.refused_count !== undefined || (Array.isArray(receipt.refusals) && receipt.refusals.length > 0)
    || receipt.failed_task_index !== failed || receipt.tasks_started !== failed + 1) return null
  return { applied_slots: slots.slice(0, applied).map(slot => slot.index), refused_slots: [slots[applied].index],
    refusal_codes: [text(receipt.reason, 80)].filter(Boolean), unrun_slots: slots.length - applied - 1 }
}

// A restart can change live generation without invalidating already sealed work.
// Require the complete per-slot witness for that exception: terminal text alone,
// unrelated watermarks or receipts from a different generation prove nothing.
function historicalCompletionProven(admission, status) {
  if (admission.state !== 'completed' || !Number.isSafeInteger(admission.generation) || admission.generation < 1) return false
  const slots = admission.slots
  if (!Array.isArray(slots) || slots.length !== admission.operation_count
    || !slots.every((slot, index) => slot?.index === index + 1 && slot.ok === true && Array.isArray(slot.batch_refs))) return false
  const receipts = Array.isArray(status?.receipt_journal) ? status.receipt_journal : []
  return slots.every(slot => slot.batch_refs.every(ref => Number.isSafeInteger(ref?.batch_id) && ref.batch_id > 0
    && ref.batch_generation === admission.generation && ref.batch_ref === `batch-g${ref.batch_generation}-${ref.batch_id}`
    && receipts.some(receipt => receipt?.batch_ref === ref.batch_ref && receipt.batch_id === ref.batch_id
      && receipt.batch_generation === ref.batch_generation && receipt.state === 'completed'
      && receipt.outcome !== 'refused' && receipt.outcome !== 'cancelled')))
}

// Select evidence, never synthesize it from an admission verdict or a live
// watermark. The shared semantic verifier consumes one complete native batch;
// admissions spanning several batches cannot be represented by that contract.
export function completedOperationReceipt(pending, { status, actor } = {}) {
  if (typeof status === 'string') { try { status = JSON.parse(status) } catch { return undefined } }
  if (pending?.protocol_version !== 2
    || reconcilePendingOperation(pending, { status, actor }).verdict !== RECONCILE_VERDICT.ADMITTED_COMPLETED) return undefined
  const records = status?.admission_journal?.records ?? status?.admission_journal
  const admission = Array.isArray(records) ? records.find(record => record.operation_key === pending.operation_key) : undefined
  if (!admission || !historicalCompletionProven(admission, status)
    || !admission.slots.every(slot => slot.batch_refs.length > 0)) return undefined
  const refs = admission.slots.flatMap(slot => slot.batch_refs)
  const first = refs[0]
  if (!first || !refs.every(ref => ref.batch_id === first.batch_id && ref.batch_generation === first.batch_generation
    && ref.batch_ref === first.batch_ref)) return undefined
  return status.receipt_journal.find(receipt => receipt.batch_id === first.batch_id
    && receipt.batch_generation === first.batch_generation && receipt.batch_ref === first.batch_ref)
}

// A drained transfer batch can contain successful tasks and no-movement
// refusals. Unlike cancellation, its exact receipt accounts for EVERY task.
// This proves a partial effect, never whole-batch success or permission to replay.
function terminalTransferRefusal(admission, status, pending) {
  if (!['admitted', 'uncertain', 'failed', 'partial'].includes(admission.state) || status.task_state !== 'idle' || status.queue_length !== 0
    || status.active_batch || !Array.isArray(status.receipt_journal)
    || !pending.operations.every(op => ['move_items', 'move_items_exact', 'supply_entity'].includes(op.name))) return null
  const slots = admission.slots
  if (!Array.isArray(slots) || slots.length !== admission.operation_count
    || !slots.every((slot, index) => slot?.index === index + 1 && slot.ok === true
      && slot.operation === pending.operations[index]?.name && DELIVERY_OPERATIONS.has(slot.operation)
      && Array.isArray(slot.batch_refs) && slot.batch_refs.length > 0 && slot.batch_refs.length <= 16)) return null
  const refs = slots.flatMap(slot => slot.batch_refs)
  const receipts = []
  for (const ref of refs) {
    if (!Number.isSafeInteger(ref?.batch_id) || ref.batch_id < 1 || ref.batch_generation !== admission.generation
      || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return null
    const receipt = (status.receipt_journal ?? []).find(row => row.batch_id === ref.batch_id
      && row.batch_generation === ref.batch_generation && row.batch_ref === ref.batch_ref)
    if (!receipt) return null
    if (!receipts.includes(receipt)) receipts.push(receipt)
  }
  let completed = 0; let refused = 0
  for (const receipt of receipts) {
    if (!Number.isSafeInteger(receipt.task_count) || receipt.task_count < 1 || receipt.task_count > 64
      || !Number.isSafeInteger(receipt.tick) || receipt.tick < 0
      || receipt.started_count !== receipt.task_count || !Array.isArray(receipt.task_types)
      || receipt.task_types.length !== receipt.task_count || !receipt.task_types.every(type => type === 'moving_items')) return null
    if (receipt.state === 'completed' && !receipt.outcome) { completed += receipt.task_count; continue }
    if (receipt.state !== 'cancelled' || receipt.outcome !== 'refused'
      || !Number.isSafeInteger(receipt.completed_count) || receipt.completed_count < 0
      || !Number.isSafeInteger(receipt.refused_count) || receipt.refused_count < 1
      || receipt.completed_count + receipt.refused_count !== receipt.task_count
      || !Array.isArray(receipt.refusals) || receipt.refusals.length !== receipt.refused_count
      || new Set(receipt.refusals.map(row => row.operation_id)).size !== receipt.refused_count
      || !receipt.refusals.every(row => row?.type === 'moving_items' && row.code === 'nothing_moved'
        && row.cause === 'target_rejects_item' && Number.isSafeInteger(row.operation_id) && row.operation_id > 0
        && Number.isSafeInteger(row.target_unit_number) && row.target_unit_number > 0 && Number.isSafeInteger(row.held_count) && row.held_count > 0
        && Number.isSafeInteger(row.tick) && row.tick >= 0 && row.tick <= receipt.tick)) return null
    completed += receipt.completed_count; refused += receipt.refused_count
  }
  return refused > 0 ? { completed_tasks: completed, refused_tasks: refused, batch_id: refs[0].batch_id } : null
}

/**
 * Decide what happened to a pending batch from the mod's current status and the current actor. Pure; the caller traces it.
 *
 *   stale_actor          the actor id or epoch changed: the old body's queue died with it. The effect cannot be assumed.
 *   generation_changed   live execution was invalidated by restart; unfinished work remains unknown. A complete exact
 *                        historical journal witness can still prove terminal completion, never authorize replay.
 *   admitted_*           a batch newer than the baseline exists (or the open batch grew): the game took the batch.
 *   not_admitted         nothing newer exists and nothing is queued: the batch never reached the game; reissuing is safe.
 *   unknown              the status could not be read or has no baseline to compare with.
 */
export function terminalGatherCancellation(admission, status, pending) {
  const slots = admission?.slots
  if (!['admitted', 'uncertain', 'partial'].includes(admission?.state) || status?.status_error || status?.error
    || status?.task_state !== 'idle' || status.queue_length !== 0 || status.active_batch
    || admission.generation !== status.batch_generation || !Array.isArray(slots) || !slots.length
    || slots.length !== admission.operation_count || slots.length !== pending.operations.length) return null
  const ref = slots[0]?.batch_refs?.[0]
  if (!ref || !Number.isSafeInteger(ref.batch_id) || ref.batch_id < 1 || ref.batch_generation !== admission.generation
    || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return null
  const types = slots.flatMap(slot => slot.operation === 'gather_resource' ? ['walking_to_entity', 'mining'] : ['mining'])
  if (!slots.every((slot, i) => slot.index === i + 1 && slot.ok === true && ['gather_resource', 'mine_resource_at'].includes(slot.operation)
    && pending.operations[i].name === slot.operation && slot.queued_tasks === (slot.operation === 'gather_resource' ? 2 : 1) && slot.batch_refs?.length === 1
    && slot.batch_refs[0].batch_id === ref.batch_id && slot.batch_refs[0].batch_generation === ref.batch_generation
    && slot.batch_refs[0].batch_ref === ref.batch_ref)) return null
  const receipt = status.receipt_journal?.find(r => r.batch_id === ref.batch_id && r.batch_generation === ref.batch_generation && r.batch_ref === ref.batch_ref)
  if (!receipt || receipt.state !== 'cancelled' || receipt.task_count !== types.length
    || !Array.isArray(receipt.task_types) || receipt.task_types.length !== receipt.task_count
    || !receipt.task_types.every((type, i) => type === types[i])
    || !Number.isSafeInteger(receipt.tick) || receipt.tick < admission.tick
    || !/^mining:(?:mining_rejected|no_target)$/.test(receipt.reason ?? '')
    || receipt.outcome || receipt.refused_count || receipt.refusals?.length) return null
  return { batch_id: ref.batch_id, batch_ref: ref.batch_ref, receipt_tick: receipt.tick, recovery_kind: 'gather' }
}

// A failed walk can change position (and clear obstacles). Only a complete exact
// navigation-only terminal witness releases its outstanding-work hold;
// this is terminal partial movement, never proof of reaching the destination.
function terminalNavigationCancellation(admission, status, pending) {
  const slots = admission.slots
  if (!['admitted', 'uncertain', 'partial'].includes(admission.state) || status?.status_error || status?.error
    || !nativeAdmissionJournal(status.admission_journal?.records ?? status.admission_journal).known
    || !(admission.ok === true && (!admission.error || admission.error === 'batch_reconciliation_required')
      || admission.state === 'partial' && admission.ok === false && admission.error === 'exact_terminal_navigation_cancelled')
    || status.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch
    || !Array.isArray(slots) || slots.length !== pending.operations.length || !slots.length) return null
  const ref = slots[0]?.batch_refs?.[0]
  if (!ref || !Number.isSafeInteger(ref.batch_id) || ref.batch_id < 1 || ref.batch_generation !== admission.generation
    || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return null
  if (!slots.every((slot, i) => slot.index === i + 1 && slot.ok === true
    && ['walk_to_position', 'walk_to_entity'].includes(slot.operation) && slot.operation === pending.operations[i].name
    && slot.queued_tasks === 1 && slot.batch_refs?.length === 1
    && slot.batch_refs[0].batch_id === ref.batch_id && slot.batch_refs[0].batch_generation === ref.batch_generation
    && slot.batch_refs[0].batch_ref === ref.batch_ref)) return null
  if (!Array.isArray(status.receipt_journal) || !status.receipt_journal.every(isRecord)) return null
  const matches = status.receipt_journal.filter(row => row.batch_ref === ref.batch_ref
    || row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation)
  if (matches.length !== 1) return null
  const receipt = matches[0]
  if (!receipt || receipt.state !== 'cancelled' || receipt.reason !== 'navigation_unreachable'
    || receipt.batch_id !== ref.batch_id || receipt.batch_generation !== ref.batch_generation || receipt.batch_ref !== ref.batch_ref
    || receipt.task_count !== slots.length || !Array.isArray(receipt.task_types)
    || receipt.task_types.length !== slots.length || !receipt.task_types.every(type => type === 'walking_to_entity')
    || !Number.isSafeInteger(receipt.tasks_started) || receipt.tasks_started < 1 || receipt.tasks_started > receipt.task_count
    || !Number.isSafeInteger(receipt.started_count) || receipt.started_count < receipt.tasks_started
    || !Number.isSafeInteger(admission.tick) || !Number.isSafeInteger(receipt.tick) || receipt.tick < admission.tick
    || receipt.outcome || receipt.refused_count || receipt.refusals?.length) return null
  return { batch_id: ref.batch_id, batch_ref: ref.batch_ref, receipt_tick: receipt.tick, recovery_kind: 'navigation' }
}

// An uncertain native admission is still blocking unless the host retained its
// exact identity and the same terminal rule can be re-proven from fresh journals.
// Native data alone never clears a row: the retained record (pending or closed, same operation key and signature) must
// reconcile against the live actor to one of the exact terminal verdicts below. reconcilePendingOperation re-checks attempt,
// signature and actor/epoch lineage against the row and requires an idle queue, so a mismatched or busy state stays unresolved.
const EXACT_TERMINAL_ADMISSION_REASONS = new Set(['exact_terminal_navigation_cancelled', 'exact_cancelled_prefix_before_mutation'])
export function unresolvedNativeAdmissions(status, records = [], actor) {
  const journal = status?.admission_journal?.records ?? status?.admission_journal
  if (!nativeAdmissionJournal(journal).known) return [{ reason: 'native_admission_journal_unreadable' }]
  return Array.isArray(journal) ? journal.filter(row => ['uncertain', 'admitting', 'admitted'].includes(row.state)
    && !records.some(record => record.operation_key === row.operation_key && record.signature === row.signature
      && EXACT_TERMINAL_ADMISSION_REASONS.has(reconcilePendingOperation(record, { status, actor }).reason))) : []
}

export function reconcilePendingOperation(pending, { status, actor } = {}) {
  if (typeof status === 'string') { try { status = JSON.parse(status) } catch { status = null } }
  const lineage = pending?.actor ?? {}
  if (pending?.protocol_version === 2 && (!Number.isSafeInteger(lineage.actor_id) || !Number.isSafeInteger(lineage.epoch)
    || !Number.isSafeInteger(actor?.actor_id) || !Number.isSafeInteger(actor?.epoch))) {
    return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'actor_lineage_missing' }
  }
  const staleActor = Number.isSafeInteger(lineage.actor_id) && Number.isSafeInteger(actor?.actor_id) && lineage.actor_id !== actor.actor_id
    ? { verdict: RECONCILE_VERDICT.STALE_ACTOR, effect: EFFECT.UNKNOWN, reason: 'actor_replaced', pending_actor_id: lineage.actor_id, actor_id: actor.actor_id }
    : Number.isSafeInteger(lineage.epoch) && Number.isSafeInteger(actor?.epoch) && lineage.epoch !== actor.epoch
      ? { verdict: RECONCILE_VERDICT.STALE_ACTOR, effect: EFFECT.UNKNOWN, reason: 'actor_epoch_changed', pending_epoch: lineage.epoch, epoch: actor.epoch } : null
  if (staleActor && pending?.protocol_version !== 2) return staleActor
  if (pending?.protocol_version === 2) {
    const records = status?.admission_journal?.records ?? status?.admission_journal ?? []
    const admission = Array.isArray(records) ? records.find(record => record.operation_key === pending.operation_key) : undefined
    if (!admission) return staleActor ?? { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'exact_admission_missing' }
    if (admission.attempt_id !== pending.attempt_id || admission.signature !== pending.signature || admission.actor_id !== lineage.actor_id || admission.epoch !== lineage.epoch) {
      return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'admission_lineage_mismatch' }
    }
    if (!Number.isSafeInteger(pending.ordinal) || pending.ordinal !== admission.ordinal || admission.operation_count !== pending.operations.length) {
      return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'operation_identity_incomplete' }
    }
    const batchId = admission.slots?.[0]?.batch_refs?.[0]?.batch_id
    if (Number.isSafeInteger(status?.batch_generation) && admission.generation !== status.batch_generation
      && historicalCompletionProven(admission, status)) {
      return { verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, effect: EFFECT.HAPPENED,
        reason: 'exact_historical_receipts_completed', batch_id: batchId }
    }
    if (!Number.isSafeInteger(admission.generation) || !Number.isSafeInteger(status?.batch_generation)
      || admission.generation !== status.batch_generation) {
      return staleActor ?? { verdict: RECONCILE_VERDICT.GENERATION_CHANGED, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'admission_generation_changed' }
    }
    // Exact refusal evidence is historical and needs no live actor: nothing refused changed anything.
    const refusal = provenRefusal(admission, status)
    if (refusal) {
      return { verdict: RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, effect: refusal.applied_slots.length > 0 ? EFFECT.HAPPENED : EFFECT.NOT_HAPPENED,
        reason: 'exact_refusal_before_mutation', basis: 'native_admission_journal',
        ...(batchId !== undefined && admission.slots?.[0]?.batch_refs?.[0]?.batch_ref ? { receipt: { batch_id: batchId, batch_generation: admission.generation, batch_ref: admission.slots[0].batch_refs[0].batch_ref } } : {}),
        settlement_operations: settlementRows(pending.operations, refusal), ...refusal }
    }
    if (admission.state === 'completed') return { verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, effect: EFFECT.HAPPENED, reason: 'exact_receipts_completed', batch_id: batchId }
    // A sealed exact receipt describes historical work by its original actor.
    // Unfinished work from an old actor is never resumed or assumed complete.
    if (staleActor) return staleActor
    // The mod leaves a batch whose prefix is not a pure submission (a supply before a placement) 'uncertain'. The exact
    // receipt still proves which operations completed, so settle it per operation instead of holding the whole batch.
    const prefix = cancelledBatchPrefix(admission, status, pending.operations)
    if (prefix) {
      return { verdict: RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, effect: prefix.applied_slots.length > 0 ? EFFECT.HAPPENED : EFFECT.NOT_HAPPENED, reason: 'exact_cancelled_prefix_before_mutation',
        settlement_operations: settlementRows(pending.operations, prefix), ...prefix }
    }
    const navigation = terminalNavigationCancellation(admission, status, pending)
    if (navigation) return { verdict: RECONCILE_VERDICT.ADMITTED_PARTIAL, effect: EFFECT.PARTIAL_KNOWN,
      reason: 'exact_terminal_navigation_cancelled', ...navigation }
    const gather = terminalGatherCancellation(admission, status, pending)
    if (gather) return { verdict: RECONCILE_VERDICT.ADMITTED_PARTIAL, effect: EFFECT.PARTIAL_KNOWN,
      reason: 'exact_terminal_gather_cancelled', ...gather }
    const partial = terminalTransferRefusal(admission, status, pending)
    if (partial) return { verdict: RECONCILE_VERDICT.ADMITTED_PARTIAL, effect: EFFECT.PARTIAL_KNOWN,
      reason: 'exact_terminal_transfer_refusal', ...partial }
    if (admission.state === 'admitted') return { verdict: RECONCILE_VERDICT.ADMITTED_IN_FLIGHT, effect: EFFECT.IN_FLIGHT, reason: 'exact_admission_in_flight', batch_id: batchId }
    if (admission.state === 'not_admitted') return { verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: EFFECT.NOT_HAPPENED, reason: 'exact_admission_proven_absent' }
    const refs = (admission.slots ?? []).flatMap(slot => slot.batch_refs ?? [])
    if (refs.some(ref => (Array.isArray(status?.receipt_journal) ? status.receipt_journal : []).some(receipt => receipt?.batch_ref === ref.batch_ref && receipt.state === 'cancelled'))) {
      return { verdict: RECONCILE_VERDICT.ADMITTED_CANCELLED, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'exact_batch_cancelled' }
    }
    if (Number.isSafeInteger(admission.generation) && Number.isSafeInteger(status?.batch_generation) && admission.generation !== status.batch_generation) {
      return { verdict: RECONCILE_VERDICT.GENERATION_CHANGED, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'mod_reloaded' }
    }
    return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'exact_admission_unsettled' }
  }
  const now = batchWatermark(status)
  const baseline = pending?.baseline
  if (!now) return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'status_unreadable' }
  if (!isRecord(baseline)) return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'no_baseline' }
  if (Number.isSafeInteger(baseline.generation) && Number.isSafeInteger(now.generation) && baseline.generation !== now.generation) {
    return { verdict: RECONCILE_VERDICT.GENERATION_CHANGED, effect: EFFECT.UNKNOWN, reason: 'mod_reloaded', baseline_generation: baseline.generation, generation: now.generation }
  }
  const sent = pending.operations?.length ?? 0
  // A batch that was already open when we sent: the operations joined it without a new id.
  const extended = baseline.active && now.active
    && now.active.batch_id === baseline.active.batch_id
    && now.active.task_count > baseline.active.task_count
  if (now.max_batch_id > (baseline.max_batch_id ?? 0) || extended) {
    if (now.active && (now.active.batch_id > (baseline.max_batch_id ?? 0) || extended)) {
      return { verdict: RECONCILE_VERDICT.ADMITTED_IN_FLIGHT, effect: EFFECT.IN_FLIGHT, reason: extended ? 'joined_open_batch' : 'new_batch_active', batch_id: now.active.batch_id, sent_operations: sent }
    }
    if (now.completed && now.completed.batch_id > (baseline.max_batch_id ?? 0)) {
      return { verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, effect: EFFECT.HAPPENED, reason: 'new_batch_completed', batch_id: now.completed.batch_id, tick: now.completed.tick, sent_operations: sent }
    }
    if (now.cancelled && now.cancelled.batch_id > (baseline.max_batch_id ?? 0)) {
      return { verdict: RECONCILE_VERDICT.ADMITTED_CANCELLED, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'new_batch_cancelled', batch_id: now.cancelled.batch_id, tick: now.cancelled.tick, sent_operations: sent }
    }
  }
  // A legacy record has no exact journal entry. If the batch it joined was already open when it was sent, that batch finishing
  // moves no watermark, so "nothing newer" is indistinguishable from "joined and completed". Never read that as absent.
  if (pending.legacy === true && baseline.active !== null) {
    return { verdict: RECONCILE_VERDICT.UNKNOWN, effect: EFFECT.UNKNOWN, reason: 'legacy_baseline_open_batch' }
  }
  if (now.idle === true && now.queue_length === 0) {
    return { verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: EFFECT.NOT_HAPPENED, reason: 'no_batch_since_send' }
  }
  // Work is running but none of it is newer than the baseline: older work, so the unacknowledged batch was not admitted.
  return { verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: EFFECT.NOT_HAPPENED, reason: 'only_older_work_running' }
}

/**
 * Would issuing `operations` now repeat an effect that may already have happened? Refuses an IDENTICAL batch (same operations
 * and arguments) for the same plan step while the earlier one is unsettled and its effect is not proven absent. A changed
 * batch, another step, a replaced plan or a proven `not_happened` is allowed.
 */
export function duplicateEffectGuard(pending, { operations, planId, stepId } = {}) {
  if (!isRecord(pending)) return { refuse: false }
  if (pending.effect === EFFECT.NOT_HAPPENED) return { refuse: false }
  if (pending.protocol_version === 2 || pending.legacy === true) {
    const proposed = (Array.isArray(operations) ? operations : []).flatMap(effectScopes)
    const held = pending.scopes ?? ['*']
    if (held.length === 0) return { refuse: false }
    if (proposed.length === 0 || !(held.includes('*') || proposed.includes('*') || proposed.some(scope => held.includes(scope)))) return { refuse: false }
    return { refuse: true, reason: 'unresolved_operation_scope_conflict', operation_key: pending.operation_key,
      effect: pending.effect, verdict: pending.verdict ?? null, state: pending.state,
      effect_classes: [...new Set((pending.operations ?? []).map(item => item.effect_class))], batch_id: pending.batch_id ?? null }
  }
  if (pending.plan_id && planId && pending.plan_id !== planId) return { refuse: false }
  if (pending.step_id && stepId && pending.step_id !== stepId) return { refuse: false }
  if (pending.signature !== operationSignature(operations)) return { refuse: false }
  const classes = [...new Set((pending.operations ?? []).map(operation => operation.effect_class))]
  // Only effects that are not safe to repeat: waits, walks and gathering are idempotent enough to leave to the planner.
  if (!classes.some(effectClass => effectClass !== 'other')) return { refuse: false }
  return {
    refuse: true,
    reason: 'identical_batch_effect_not_proven_absent',
    operation_key: pending.operation_key,
    effect: pending.effect,
    verdict: pending.verdict ?? null,
    state: pending.state,
    effect_classes: classes,
    batch_id: pending.batch_id ?? null,
  }
}

/** The bounded facts of a reconciliation, for a trace row and for the recovery message. */
export function reconciliationFacts(result, pending) {
  return {
    operation_key: pending?.operation_key ?? null,
    verdict: result?.verdict ?? null,
    effect: result?.effect ?? null,
    reason: result?.reason ?? null,
    batch_id: result?.batch_id ?? null,
    operations: (pending?.operations ?? []).map(operation => operation.name),
    effect_classes: [...new Set((pending?.operations ?? []).map(operation => operation.effect_class))],
    ...(['gather', 'navigation'].includes(result?.recovery_kind) ? { recovery_kind: result.recovery_kind, receipt_tick: result.receipt_tick, batch_ref: result.batch_ref } : {}),
    ...(result?.verdict === RECONCILE_VERDICT.ADMITTED_PARTIAL && !['gather', 'navigation'].includes(result?.recovery_kind)
      ? { completed_tasks: result.completed_tasks, refused_tasks: result.refused_tasks } : {}),
    ...(result?.verdict === RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION
      ? { applied_slots: result.applied_slots ?? [], refused_slots: result.refused_slots ?? [], refusal_codes: result.refusal_codes ?? [], unrun_slots: result.unrun_slots ?? 0,
          ...(result.basis ? { settlement_basis: result.basis, settlement: result.settlement_operations ?? [], ...(result.receipt ? { settlement_receipt: result.receipt } : {}) } : {}) }
      : {}),
  }
}

/** One sentence for the model: what the game's batch records prove, and what that allows. Never says "succeeded" for an uncertain effect. */
export function reconciliationGuidance(result, pending) {
  const facts = JSON.stringify(reconciliationFacts(result, pending))
  if (result?.reason === 'exact_terminal_navigation_cancelled') return `Operation reconciliation: the exact navigation-only batch ended unreachable with idle native queues. Movement may have occurred; the destination is not verified. Re-observe current position and the unchanged checkpoint before choosing the next action. Facts: ${facts}`
  if (result?.reason === 'exact_terminal_gather_cancelled') return `Operation reconciliation: the exact gather-only batch terminated with partial acquisition. No slot quantity is assumed complete or absent. Keep the effect hold until the harness reads fresh inventory and computes only the unchanged checkpoint deficit; do not replay the batch. Facts: ${facts}`
  if (result?.verdict === RECONCILE_VERDICT.ADMITTED_PARTIAL) {
    return `Operation reconciliation: the exact native receipt accounts for every transfer task: ${result.completed_tasks} completed and ${result.refused_tasks} refused without moving anything. This is partial work, not batch success. Do not replay the completed prefix or the original batch. Re-observe current inventories and the target, then choose only the missing effects for the same committed step. Facts: ${facts}`
  }
  if (result?.verdict === RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION) {
    const applied = (result.applied_slots ?? []).length > 0
      ? ` Operations ${result.applied_slots.join(', ')} completed before the refusal; do not repeat them.`
      : ''
    const derived = result.basis === 'harness_receipt_derivation'
      ? ' The harness derived this from the exact native batch receipt: the tasks before the refused placement ran to completion in order (a delivery completes once it moved a positive count, which can be less than requested, so read the real contents of the target rather than assuming the full amount), and no later task started.'
      : ''
    return `Operation reconciliation (from the game's own admission record): the game refused operations ${(result.refused_slots ?? []).join(', ')} before changing anything, so those did not run and may be corrected and issued again.${applied} Operations after the refusal never started.${derived} Facts: ${facts}`
  }
  if (result?.effect === EFFECT.NOT_HAPPENED) {
    return `Operation reconciliation (from the game's batch records): the last operation batch never reached the game, so nothing from it ran and it may be issued again. Facts: ${facts}`
  }
  if (result?.effect === EFFECT.HAPPENED || result?.effect === EFFECT.IN_FLIGHT) {
    return `Operation reconciliation (from the game's batch records): the last operation batch DID reach the game (${result.effect}). Its effect has happened or is still running, so do NOT issue the same operations again; verify the world state first and only add what is still missing. Facts: ${facts}`
  }
  return `Operation reconciliation (from the game's batch records): whether the last operation batch ran could not be proven (${result?.reason ?? 'unknown'}). Treat its effect as UNKNOWN, not as done and not as absent: do NOT issue the identical operations again; observe the destination or inventory first and change the request to only what is verifiably missing. Facts: ${facts}`
}

/**
 * A failure that may have lost the acknowledgement: the command was sent but no valid acknowledgement came back. A failure the
 * game itself reported (OperationBatchAdmissionError carries `factorioError`) is NOT lost: the game answered. A batch that was
 * rejected before it was sent never reached the game either.
 */
export function isLostAcknowledgement(error) {
  if (!error) return false
  if (Object.hasOwn(error, 'factorioError') || Object.hasOwn(error, 'operationIndex')) return false
  const message = error instanceof Error ? error.message : String(error)
  if (/Invalid deployment epoch|Invalid operation batch|Invalid operation acknowledgement marker/i.test(message)) return false
  if (/stale npc actor epoch|NPC actor epoch changed/i.test(message)) return false
  return /acknowledge?ment missing|Invalid Autorio batch acknowledgement|ECONNRESET|ETIMEDOUT|EPIPE|socket|timed out|timeout|RCON|connection (?:closed|lost)/i.test(message)
}

/** The bounded record the reducer persists (every field checked; unknown fields dropped). */
export function sanitizePendingOperation(raw) {
  if (!isRecord(raw)) return null
  const key = text(raw.operation_key, PENDING_OPERATION_LIMITS.operation_key)
  if (!key) return null
  const states = Object.values(PENDING_STATE)
  const effects = Object.values(EFFECT)
  const verdicts = Object.values(RECONCILE_VERDICT)
  const baseline = isRecord(raw.baseline)
    ? {
        generation: Number.isSafeInteger(raw.baseline.generation) ? raw.baseline.generation : null,
        max_batch_id: Number.isSafeInteger(raw.baseline.max_batch_id) ? raw.baseline.max_batch_id : 0,
        active: isRecord(raw.baseline.active) && Number.isSafeInteger(raw.baseline.active.batch_id)
          ? { batch_id: raw.baseline.active.batch_id, task_count: Number.isSafeInteger(raw.baseline.active.task_count) ? raw.baseline.active.task_count : 0 }
          : null,
      }
    : null
  return {
    operation_key: key,
    request_id: text(raw.request_id, 120),
    attempt_id: text(raw.attempt_id ?? key, 200),
    protocol_version: raw.protocol_version === 2 ? 2 : 1,
    ...(Number.isSafeInteger(raw.surface_index) && raw.surface_index > 0 ? { surface_index: raw.surface_index } : {}),
    ...(raw.legacy === true ? { legacy: true } : {}),
    ordinal: Number.isSafeInteger(raw.ordinal) && raw.ordinal > 0 ? raw.ordinal : null,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter(value => typeof value === 'string').slice(0, 96).map(value => text(value, 240)) : ['*'],
    state: states.includes(raw.state) ? raw.state : PENDING_STATE.SENT,
    goal_id: text(raw.goal_id, 120) || null,
    plan_id: text(raw.plan_id, PENDING_OPERATION_LIMITS.ref) || null,
    step_id: text(raw.step_id, PENDING_OPERATION_LIMITS.ref) || null,
    actor: {
      actor_id: Number.isSafeInteger(raw.actor?.actor_id) ? raw.actor.actor_id : null,
      epoch: Number.isSafeInteger(raw.actor?.epoch) ? raw.actor.epoch : null,
    },
    signature: text(raw.signature, 64),
    operations: (Array.isArray(raw.operations) ? raw.operations : []).slice(0, PENDING_OPERATION_LIMITS.operations).filter(isRecord).map(operation => ({
      trace_operation_id: text(operation.trace_operation_id, PENDING_OPERATION_LIMITS.ref),
      name: text(operation.name, 80),
      ...(['gather_resource', 'mine_resource_at'].includes(operation.name) && isRecord(operation.args) ? { args: {
        resource_name: text(operation.args.resource_name, 200), count: operation.args.count,
        ...(operation.name === 'gather_resource' ? { search_radius: operation.args.search_radius } : { x: operation.args.x, y: operation.args.y }),
      } } : {}),
      ...(typeof operation.identity === 'string' && /^[0-9a-f]{64}$/.test(operation.identity) ? { identity: operation.identity } : {}),
      ...(Array.isArray(operation.delivery_keys) && operation.delivery_keys.length > 0 ? { delivery_keys: sanitizeDeliveryKeys(operation.delivery_keys) } : {}),
      effect_class: ['delivery', 'craft', 'place', 'world', 'other'].includes(operation.effect_class) ? operation.effect_class : 'other',
    })),
    baseline,
    effect: effects.includes(raw.effect) ? raw.effect : EFFECT.UNKNOWN,
    verdict: verdicts.includes(raw.verdict) ? raw.verdict : null,
    reason: text(raw.reason, PENDING_OPERATION_LIMITS.reason),
    batch_id: Number.isSafeInteger(raw.batch_id) ? raw.batch_id : null,
    sent_at: Number.isFinite(raw.sent_at) ? raw.sent_at : 0,
    reconciled_at: Number.isFinite(raw.reconciled_at) ? raw.reconciled_at : null,
    ...(sanitizeSettlement(raw.settlement) ? { settlement: sanitizeSettlement(raw.settlement) } : {}),
  }
}

function sanitizeDeliveryKeys(keys) {
  return keys.filter(key => typeof key === 'string' && key.length > 0).slice(0, 8).map(key => text(key, 240))
}

// The settled-prefix settlement carried on a closed record: strictly shaped, bounded, unknown fields dropped.
function sanitizeSettlement(raw) {
  if (!isRecord(raw) || raw.kind !== SETTLED_PREFIX_KIND || !Array.isArray(raw.completed) || raw.completed.length < 1) return undefined
  const completed = raw.completed.slice(0, PENDING_OPERATION_LIMITS.operations).filter(isRecord).map(item => ({
    slot: Number.isSafeInteger(item.slot) && item.slot > 0 ? item.slot : 0,
    operation: text(item.operation, 80),
    identity: typeof item.identity === 'string' && /^[0-9a-f]{64}$/.test(item.identity) ? item.identity : null,
    delivery_keys: Array.isArray(item.delivery_keys) ? sanitizeDeliveryKeys(item.delivery_keys) : [],
  })).filter(item => item.slot > 0 && item.operation)
  if (completed.length < 1) return undefined
  return {
    kind: SETTLED_PREFIX_KIND,
    basis: text(raw.basis, 80),
    batch_ref: text(raw.batch_ref, PENDING_OPERATION_LIMITS.ref),
    refused_slot: Number.isSafeInteger(raw.refused_slot) ? raw.refused_slot : null,
    refusal_codes: Array.isArray(raw.refusal_codes) ? raw.refusal_codes.filter(code => typeof code === 'string').slice(0, 4).map(code => text(code, 80)) : [],
    completed,
    identity_complete: completed.every(item => item.identity),
  }
}
