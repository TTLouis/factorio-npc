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
const WORLD_OPERATIONS = new Set(['mine_entity', 'mine_entity_exact', 'clear_area', 'rotate_entity', 'rotate_entity_exact', 'set_machine_recipe', 'equip_weapon', 'equip_ammo', 'equip_armor'])

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
export function buildPendingOperation({ requestId, operationKey, attemptId, ordinal, protocolVersion, operations, goalId, planId, stepId, actor, baseline, now } = {}) {
  const list = (Array.isArray(operations) ? operations : []).slice(0, PENDING_OPERATION_LIMITS.operations)
  return {
    operation_key: text(operationKey ?? `${requestId ?? 'request'}/batch`, PENDING_OPERATION_LIMITS.operation_key),
    request_id: text(requestId, 120),
    attempt_id: text(attemptId ?? operationKey ?? `${requestId ?? 'request'}/batch`, 200),
    protocol_version: protocolVersion === 2 ? 2 : 1,
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
  const proven = refs.every(ref => receipts.some(receipt => receipt?.batch_ref === ref.batch_ref && receipt.batch_id === ref.batch_id
    && receipt.batch_generation === ref.batch_generation && receipt.state === 'cancelled' && receipt.started_count === 1
    && receipt.failed_before_mutation === true))
  if (!proven) return null
  return { applied_slots: [], refused_slots: slots.map(slot => slot.index), refusal_codes: [text(receipts.find(receipt => receipt?.batch_ref === refs[0].batch_ref)?.reason, 80)].filter(Boolean),
    unrun_slots: 0 }
}

/**
 * Decide what happened to a pending batch from the mod's current status and the current actor. Pure; the caller traces it.
 *
 *   stale_actor          the actor id or epoch changed: the old body's queue died with it. The effect cannot be assumed.
 *   generation_changed   the mod reloaded (restart or save/load): the queue and batch records were lost, so whether the batch
 *                        ran before the save is unknown. Never counted as success, never replayed blindly.
 *   admitted_*           a batch newer than the baseline exists (or the open batch grew): the game took the batch.
 *   not_admitted         nothing newer exists and nothing is queued: the batch never reached the game; reissuing is safe.
 *   unknown              the status could not be read or has no baseline to compare with.
 */
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
    if (!Number.isSafeInteger(admission.generation) || !Number.isSafeInteger(status?.batch_generation)
      || admission.generation !== status.batch_generation) {
      return staleActor ?? { verdict: RECONCILE_VERDICT.GENERATION_CHANGED, effect: EFFECT.PARTIAL_UNKNOWN, reason: 'admission_generation_changed' }
    }
    const batchId = admission.slots?.[0]?.batch_refs?.[0]?.batch_id
    // Exact refusal evidence is historical and needs no live actor: nothing refused changed anything.
    const refusal = provenRefusal(admission, status)
    if (refusal) {
      return { verdict: RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, effect: refusal.applied_slots.length > 0 ? EFFECT.HAPPENED : EFFECT.NOT_HAPPENED,
        reason: 'exact_refusal_before_mutation', ...refusal }
    }
    if (admission.state === 'completed') return { verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, effect: EFFECT.HAPPENED, reason: 'exact_receipts_completed', batch_id: batchId }
    // A sealed exact receipt describes historical work by its original actor.
    // Unfinished work from an old actor is never resumed or assumed complete.
    if (staleActor) return staleActor
    if (admission.state === 'admitted') return { verdict: RECONCILE_VERDICT.ADMITTED_IN_FLIGHT, effect: EFFECT.IN_FLIGHT, reason: 'exact_admission_in_flight', batch_id: batchId }
    if (admission.state === 'not_admitted') return { verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: EFFECT.NOT_HAPPENED, reason: 'exact_admission_proven_absent' }
    const refs = (admission.slots ?? []).flatMap(slot => slot.batch_refs ?? [])
    if (refs.some(ref => (status?.receipt_journal ?? []).some(receipt => receipt.batch_ref === ref.batch_ref && receipt.state === 'cancelled'))) {
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
    ...(result?.verdict === RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION
      ? { applied_slots: result.applied_slots ?? [], refused_slots: result.refused_slots ?? [], refusal_codes: result.refusal_codes ?? [], unrun_slots: result.unrun_slots ?? 0 }
      : {}),
  }
}

/** One sentence for the model: what the game's batch records prove, and what that allows. Never says "succeeded" for an uncertain effect. */
export function reconciliationGuidance(result, pending) {
  const facts = JSON.stringify(reconciliationFacts(result, pending))
  if (result?.verdict === RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION) {
    const applied = (result.applied_slots ?? []).length > 0
      ? ` Operations ${result.applied_slots.join(', ')} completed before the refusal; do not repeat them.`
      : ''
    return `Operation reconciliation (from the game's own admission record): the game refused operations ${(result.refused_slots ?? []).join(', ')} before changing anything, so those did not run and may be corrected and issued again.${applied} Operations after the refusal never started. Facts: ${facts}`
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
  return /acknowledg(e)?ment missing|Invalid Autorio batch acknowledgement|ECONNRESET|ETIMEDOUT|EPIPE|socket|timed out|timeout|RCON|connection (closed|lost)/i.test(message)
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
      effect_class: ['delivery', 'craft', 'place', 'world', 'other'].includes(operation.effect_class) ? operation.effect_class : 'other',
    })),
    baseline,
    effect: effects.includes(raw.effect) ? raw.effect : EFFECT.UNKNOWN,
    verdict: verdicts.includes(raw.verdict) ? raw.verdict : null,
    reason: text(raw.reason, PENDING_OPERATION_LIMITS.reason),
    batch_id: Number.isSafeInteger(raw.batch_id) ? raw.batch_id : null,
    sent_at: Number.isFinite(raw.sent_at) ? raw.sent_at : 0,
    reconciled_at: Number.isFinite(raw.reconciled_at) ? raw.reconciled_at : null,
  }
}
