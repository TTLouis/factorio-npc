import assert from 'node:assert/strict'
import test from 'node:test'

import {
  batchWatermark,
  buildPendingOperation,
  duplicateEffectGuard,
  EFFECT,
  effectClassOf,
  isLostAcknowledgement,
  operationSignature,
  PENDING_STATE,
  reconcilePendingOperation,
  reconciliationGuidance,
  RECONCILE_VERDICT,
  sanitizePendingOperation,
} from './operation-reconciliation.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  PLANNING_EVENT,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'

// MW2b (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3): reconciliation of a batch whose acknowledgement may have
// been lost, against the game's own batch records. Pure tests; the scripted loop scenarios are in
// operation-reconciliation-scenario.test.mjs.

const DELIVERY = [{ name: 'move_items', args: { item_name: 'coal', entity_name: 'wooden-chest', max_count: 5, to_entity: true } }]
const ACTOR = { actor_id: 18, epoch: 3 }

function status(overrides = {}) {
  return {
    task_state: 'idle',
    queue_empty: true,
    queue_length: 0,
    batch_generation: 2,
    ...overrides,
  }
}

function pendingAt(baselineStatus, overrides = {}) {
  return {
    ...buildPendingOperation({
      requestId: 'req_a',
      operations: DELIVERY,
      goalId: 'goal_a',
      planId: 'goal_a_p1',
      stepId: 'goal_a_p1_v1_s1_x',
      actor: ACTOR,
      baseline: batchWatermark(baselineStatus),
      now: 100,
    }),
    ...overrides,
  }
}

test('the operation signature ignores key order and distinguishes arguments', () => {
  const a = operationSignature([{ name: 'move_items', args: { item_name: 'coal', max_count: 5 } }])
  const b = operationSignature([{ name: 'move_items', args: { max_count: 5, item_name: 'coal' } }])
  const c = operationSignature([{ name: 'move_items', args: { max_count: 6, item_name: 'coal' } }])
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(effectClassOf('move_items'), 'delivery')
  assert.equal(effectClassOf('craft_item'), 'craft')
  assert.equal(effectClassOf('place_entity'), 'place')
  assert.equal(effectClassOf('wait'), 'other')
})

test('the batch watermark is the highest batch id the mod reports, with the open batch size', () => {
  const mark = batchWatermark(JSON.stringify(status({
    active_batch: { batch_id: 9, task_count: 2 },
    last_completed_batch: { batch_id: 7, tick: 500 },
    last_cancelled_batch: { batch_id: 8, tick: 400 },
  })))
  assert.equal(mark.max_batch_id, 9)
  assert.deepEqual(mark.active, { batch_id: 9, task_count: 2 })
  assert.equal(mark.generation, 2)
  assert.equal(batchWatermark('not json'), undefined)
  assert.equal(batchWatermark({ status_error: 'x' }), undefined)
  assert.equal(batchWatermark(status()).max_batch_id, 0)
})

test('a lost acknowledgement is reconciled against the batch ids: in flight, completed, cancelled or never admitted', () => {
  const before = status({ last_completed_batch: { batch_id: 4, tick: 100 } })
  const pending = pendingAt(before)

  const inFlight = reconcilePendingOperation(pending, { actor: ACTOR, status: status({ task_state: 'moving_items', queue_length: 1, active_batch: { batch_id: 5, task_count: 1 }, last_completed_batch: { batch_id: 4 } }) })
  assert.equal(inFlight.verdict, RECONCILE_VERDICT.ADMITTED_IN_FLIGHT)
  assert.equal(inFlight.effect, EFFECT.IN_FLIGHT)
  assert.equal(inFlight.batch_id, 5)

  const completed = reconcilePendingOperation(pending, { actor: ACTOR, status: status({ last_completed_batch: { batch_id: 5, tick: 700 } }) })
  assert.equal(completed.verdict, RECONCILE_VERDICT.ADMITTED_COMPLETED)
  assert.equal(completed.effect, EFFECT.HAPPENED)
  assert.equal(completed.batch_id, 5)

  const cancelled = reconcilePendingOperation(pending, { actor: ACTOR, status: status({ last_completed_batch: { batch_id: 4 }, last_cancelled_batch: { batch_id: 5, tick: 710 } }) })
  assert.equal(cancelled.verdict, RECONCILE_VERDICT.ADMITTED_CANCELLED)
  assert.equal(cancelled.effect, EFFECT.PARTIAL_UNKNOWN, 'a cancelled batch may have partly run: never counted as done, never as absent')

  const never = reconcilePendingOperation(pending, { actor: ACTOR, status: before })
  assert.equal(never.verdict, RECONCILE_VERDICT.NOT_ADMITTED)
  assert.equal(never.effect, EFFECT.NOT_HAPPENED)
})

test('operations that joined an already-open batch (no new batch id) are still recognised as admitted', () => {
  const open = status({ task_state: 'mining', queue_length: 1, active_batch: { batch_id: 6, task_count: 1 } })
  const pending = pendingAt(open)
  const grown = status({ task_state: 'mining', queue_length: 2, active_batch: { batch_id: 6, task_count: 2 } })
  const verdict = reconcilePendingOperation(pending, { actor: ACTOR, status: grown })
  assert.equal(verdict.verdict, RECONCILE_VERDICT.ADMITTED_IN_FLIGHT)
  assert.equal(verdict.reason, 'joined_open_batch')
  assert.equal(reconcilePendingOperation(pending, { actor: ACTOR, status: open }).verdict, RECONCILE_VERDICT.NOT_ADMITTED)
})

test('stale work fails safely: a replaced actor, a changed epoch or a reloaded mod is never counted as success or as absent', () => {
  const pending = pendingAt(status())
  const replaced = reconcilePendingOperation(pending, { actor: { actor_id: 19, epoch: 3 }, status: status() })
  assert.equal(replaced.verdict, RECONCILE_VERDICT.STALE_ACTOR)
  assert.equal(replaced.reason, 'actor_replaced')
  assert.equal(replaced.effect, EFFECT.UNKNOWN)
  const epoch = reconcilePendingOperation(pending, { actor: { actor_id: 18, epoch: 4 }, status: status() })
  assert.equal(epoch.reason, 'actor_epoch_changed')
  const reloaded = reconcilePendingOperation(pending, { actor: ACTOR, status: status({ batch_generation: 3 }) })
  assert.equal(reloaded.verdict, RECONCILE_VERDICT.GENERATION_CHANGED)
  assert.equal(reloaded.effect, EFFECT.UNKNOWN)
  assert.equal(reconcilePendingOperation(pending, { actor: ACTOR, status: undefined }).reason, 'status_unreadable')
  assert.equal(reconcilePendingOperation({ ...pending, baseline: null }, { actor: ACTOR, status: status() }).reason, 'no_baseline')
})

test('the duplicate guard refuses an identical delivery/craft/placement for the same step until the effect is proven absent', () => {
  const pending = { ...pendingAt(status()), effect: EFFECT.UNKNOWN, state: PENDING_STATE.UNRECONCILED }
  const same = duplicateEffectGuard(pending, { operations: DELIVERY, planId: 'goal_a_p1', stepId: 'goal_a_p1_v1_s1_x' })
  assert.equal(same.refuse, true)
  assert.deepEqual(same.effect_classes, ['delivery'])
  assert.equal(duplicateEffectGuard(pending, { operations: [{ ...DELIVERY[0], args: { ...DELIVERY[0].args, max_count: 4 } }], planId: 'goal_a_p1', stepId: 'goal_a_p1_v1_s1_x' }).refuse, false, 'a changed batch is allowed')
  assert.equal(duplicateEffectGuard(pending, { operations: DELIVERY, planId: 'goal_a_p1', stepId: 'another_step' }).refuse, false, 'another step is allowed')
  assert.equal(duplicateEffectGuard(pending, { operations: DELIVERY, planId: 'goal_a_p2', stepId: 'goal_a_p1_v1_s1_x' }).refuse, false, 'a replaced plan is allowed')
  assert.equal(duplicateEffectGuard({ ...pending, effect: EFFECT.NOT_HAPPENED }, { operations: DELIVERY, planId: 'goal_a_p1', stepId: 'goal_a_p1_v1_s1_x' }).refuse, false)
  assert.equal(duplicateEffectGuard(null, { operations: DELIVERY }).refuse, false)
  const waits = [{ name: 'wait', args: { ticks: 60 } }]
  const waitPending = { ...buildPendingOperation({ requestId: 'req_w', operations: waits, goalId: 'g', planId: 'p', stepId: 's', actor: ACTOR, baseline: null, now: 1 }), effect: EFFECT.UNKNOWN }
  assert.equal(duplicateEffectGuard(waitPending, { operations: waits, planId: 'p', stepId: 's' }).refuse, false, 'waits and walks are idempotent enough to leave to the planner')
})

test('only a failure that may have lost the acknowledgement is reconciled', () => {
  assert.equal(isLostAcknowledgement(new Error('Game command acknowledgement missing; operation batch will not be retried')), true)
  assert.equal(isLostAcknowledgement(new Error('RCON connection closed')), true)
  assert.equal(isLostAcknowledgement(new Error('read ECONNRESET')), true)
  assert.equal(isLostAcknowledgement(Object.assign(new Error('Game command failed'), { factorioError: 'x', operationIndex: 0 })), false, 'the game answered')
  assert.equal(isLostAcknowledgement(new Error('Invalid operation batch')), false, 'rejected before it was sent')
  assert.equal(isLostAcknowledgement(new Error('stale npc actor epoch')), false)
  assert.equal(isLostAcknowledgement(undefined), false)
})

test('the guidance never calls an uncertain effect done', () => {
  const pending = pendingAt(status())
  const unknown = reconciliationGuidance({ verdict: RECONCILE_VERDICT.GENERATION_CHANGED, effect: EFFECT.UNKNOWN, reason: 'mod_reloaded' }, pending)
  assert.match(unknown, /UNKNOWN, not as done and not as absent/)
  assert.match(unknown, /do NOT issue the identical operations again/)
  assert.match(reconciliationGuidance({ verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: EFFECT.NOT_HAPPENED }, pending), /never reached the game/)
  assert.match(reconciliationGuidance({ verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, effect: EFFECT.HAPPENED }, pending), /do NOT issue the same operations again/)
})

test('the reducer stores the pending record for the active goal, refuses a stale goal, clears by key, and persists across restore', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 10, goal_id: 'goal_a', owner: 'louis', objective: 'craft gears' })
  const record = pendingAt(status())
  const stale = applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'runtime', now: 20, goal_id: 'goal_other', operation: record })
  assert.equal(stale.run?.pending_operation ?? null, null)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'main_planner', now: 20, goal_id: 'goal_a', operation: record }), state, 'the planner cannot write it')

  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'runtime', now: 20, goal_id: 'goal_a', operation: record })
  assert.equal(state.run.pending_operation.operation_key, 'req_a/batch')
  assert.equal(state.run.pending_operation.signature, operationSignature(DELIVERY))

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(restored.run.pending_operation, state.run.pending_operation, 'the record survives a restart')

  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'runtime', now: 30, goal_id: 'goal_a', operation: null, operation_key: 'req_older/batch' }), state, 'a late clear for an older batch cannot erase a newer one')
  const cleared = applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'runtime', now: 30, goal_id: 'goal_a', operation: null, operation_key: 'req_a/batch' })
  assert.equal(cleared.run.pending_operation, null)
  assert.equal(sanitizePendingOperation({ operation_key: '' }), null)
})

// Exact refusal evidence from the mod's admission journal (packages/autorio/src/operation_admission.ts).
const PLACE = [{ name: 'place_entity', args: { entity_name: 'burner-mining-drill', x: 11, y: -7 } }]
const EXACT_ACTOR = { actor_id: 18, epoch: 3 }
function exactPending(operations = PLACE) {
  return buildPendingOperation({ requestId: 'req', operationKey: 'req/batch_1', ordinal: 1, protocolVersion: 2, operations, actor: EXACT_ACTOR })
}
function journalFor(pending, extra = {}) {
  return { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, actor_id: 18, epoch: 3,
    ordinal: 1, operation_count: pending.operations.length, generation: 1, state: 'failed', proven_refusal: true, ok: false, slots: [], ...extra }
}
const refusedSlot = (index, error = 'Requested placement is not placeable') => ({ index, ok: false, error, mutation_unknown: false, refused_before_mutation: true, refusal_code: error, batch_refs: [] })
const BATCH_REF = { batch_id: 4, batch_generation: 1, batch_ref: 'batch-g1-4' }
const queuedSlot = index => ({ index, ok: true, batch_refs: [BATCH_REF] })

test('a mod-proven synchronous refusal settles exactly: the refused operation did not happen and may be corrected and re-issued', () => {
  const pending = exactPending()
  const admission = journalFor(pending, { slots: [refusedSlot(1)] })
  const result = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: { batch_generation: 1, admission_journal: [admission] } })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.effect, EFFECT.NOT_HAPPENED)
  assert.equal(result.reason, 'exact_refusal_before_mutation')
  assert.deepEqual(result.refused_slots, [1])
  assert.deepEqual(result.applied_slots, [])
  assert.match(reconciliationGuidance(result, pending), /refused operations 1 before changing anything/)
})

test('a synchronous prefix that completed before a proven refusal is exact: it happened, the refusal did not', () => {
  const pending = exactPending([{ name: 'equip_weapon', args: { item_name: 'pistol' } }, ...PLACE])
  const admission = journalFor(pending, { slots: [{ index: 1, ok: true, batch_refs: [] }, refusedSlot(2)] })
  const result = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: { batch_generation: 1, admission_journal: [admission] } })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.effect, EFFECT.HAPPENED)
  assert.deepEqual(result.applied_slots, [1])
  assert.deepEqual(result.refused_slots, [2])
  assert.match(reconciliationGuidance(result, pending), /Operations 1 completed before the refusal; do not repeat them/)
})

test('an engine refusal of the first task before any change, with every dependent task unstarted, is exact', () => {
  const pending = exactPending([...PLACE, { name: 'move_items', args: { item_name: 'coal', entity_name: 'burner-mining-drill', max_count: 5, to_entity: true } }])
  const admission = journalFor(pending, { error: 'refused_before_mutation', slots: [queuedSlot(1), queuedSlot(2)] })
  const receipt = { ...BATCH_REF, state: 'cancelled', started_count: 1, failed_before_mutation: true, reason: 'placing:not_placeable', task_count: 2, task_types: ['placing', 'moving_items'], tick: 10 }
  const status = { batch_generation: 1, admission_journal: [admission], receipt_journal: [receipt] }
  const result = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.effect, EFFECT.NOT_HAPPENED)
  // Each missing piece of proof falls back to an unknown effect.
  for (const weaker of [{ started_count: 2 }, { failed_before_mutation: false }, { failed_before_mutation: undefined }, { state: 'uncertain' }, { batch_ref: 'batch-g1-9' }]) {
    const unproven = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: { ...status, receipt_journal: [{ ...receipt, ...weaker }] } })
    assert.notEqual(unproven.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, JSON.stringify(weaker))
    assert.notEqual(unproven.effect, EFFECT.NOT_HAPPENED)
  }
  assert.notEqual(reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: { ...status, receipt_journal: [] } }).verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
})

test('genuinely unknown effects are never read as a refusal', () => {
  const pending = exactPending()
  const two = exactPending([...PLACE, ...PLACE])
  const status = admission => ({ batch_generation: 1, admission_journal: [admission] })
  const unknown = [
    // A thrown error or an unclassified refusal: the mod did not prove it changed nothing.
    journalFor(pending, { state: 'uncertain', proven_refusal: undefined, slots: [{ index: 1, ok: false, mutation_unknown: true, batch_refs: [] }] }),
    // The proof flag without the per-slot proof.
    journalFor(pending, { slots: [{ index: 1, ok: false, mutation_unknown: true, batch_refs: [] }] }),
    journalFor(pending, { slots: [{ index: 1, ok: false, refused_before_mutation: true, batch_refs: [] }] }),
    // A refusal next to queued work still in flight.
    journalFor(two, { slots: [queuedSlot(1), refusedSlot(2)] }),
    // Not terminal, or the proof flag withheld.
    journalFor(pending, { state: 'admitted', slots: [refusedSlot(1)] }),
    journalFor(pending, { proven_refusal: false, slots: [refusedSlot(1)] }),
    journalFor(pending, { slots: [] }),
  ]
  for (const admission of unknown) {
    const result = reconcilePendingOperation(admission.operation_count === 2 ? two : pending, { actor: EXACT_ACTOR, status: status(admission) })
    assert.notEqual(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, JSON.stringify(admission))
    assert.notEqual(result.effect, EFFECT.NOT_HAPPENED, JSON.stringify(admission))
  }
  // A changed mod generation or another attempt's journal entry is still not exact for this record.
  const changed = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: { batch_generation: 2, admission_journal: [journalFor(pending, { slots: [refusedSlot(1)] })] } })
  assert.notEqual(changed.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  const other = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: status(journalFor(pending, { signature: 'other', slots: [refusedSlot(1)] })) })
  assert.equal(other.reason, 'admission_lineage_mismatch')
})

test('legacy records reconcile by the batch baseline when it applies, and carry no exact proof otherwise', () => {
  const baseline = { generation: 1, max_batch_id: 7, active: null }
  const legacy = { ...buildPendingOperation({ requestId: 'old', operationKey: 'old/batch', protocolVersion: 1, operations: DELIVERY, baseline }), legacy: true }
  const idle = { task_state: 'idle', queue_length: 0, batch_generation: 1 }
  assert.equal(reconcilePendingOperation(legacy, { status: { ...idle, last_completed_batch: { batch_id: 7 } } }).verdict, RECONCILE_VERDICT.NOT_ADMITTED)
  assert.equal(reconcilePendingOperation(legacy, { status: { ...idle, last_completed_batch: { batch_id: 8 } } }).verdict, RECONCILE_VERDICT.ADMITTED_COMPLETED)
  assert.equal(reconcilePendingOperation(legacy, { status: { ...idle, batch_generation: 2 } }).verdict, RECONCILE_VERDICT.GENERATION_CHANGED)
  assert.equal(reconcilePendingOperation({ ...legacy, baseline: null }, { status: idle }).reason, 'no_baseline')
  // A batch that was already open when the record was sent may have been joined and completed with no watermark moving:
  // absence is not provable. Positive evidence still counts, and a non-legacy baseline record keeps the old verdict.
  const joined = { ...legacy, baseline: { generation: 1, max_batch_id: 7, active: { batch_id: 7, task_count: 1 } } }
  const afterJoin = reconcilePendingOperation(joined, { status: { ...idle, last_completed_batch: { batch_id: 7 } } })
  assert.equal(afterJoin.verdict, RECONCILE_VERDICT.UNKNOWN)
  assert.equal(afterJoin.effect, EFFECT.UNKNOWN)
  assert.equal(afterJoin.reason, 'legacy_baseline_open_batch')
  assert.equal(reconcilePendingOperation({ ...joined, legacy: undefined }, { status: { ...idle, last_completed_batch: { batch_id: 7 } } }).verdict, RECONCILE_VERDICT.NOT_ADMITTED)
  assert.equal(reconcilePendingOperation(joined, { status: { ...idle, last_completed_batch: { batch_id: 8 } } }).verdict, RECONCILE_VERDICT.ADMITTED_COMPLETED)
  // Until it is settled a legacy record still guards every conflicting effect.
  assert.equal(duplicateEffectGuard({ ...legacy, scopes: ['*'], effect: EFFECT.UNKNOWN }, { operations: [{ name: 'craft_item', args: { item_name: 'iron-plate' } }] }).refuse, true)
})

test('restart accepts only a complete correlated historical completion witness', () => {
  const pending = exactPending([...PLACE, ...PLACE])
  const admission = journalFor(pending, { state: 'completed', proven_refusal: undefined,
    slots: [queuedSlot(1), { index: 2, ok: true, batch_refs: [] }] })
  const receipt = { ...BATCH_REF, state: 'completed', task_count: 1, task_types: ['placing'], tick: 90 }
  const status = { batch_generation: 2, admission_journal: [admission], receipt_journal: [receipt] }
  const result = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status })
  assert.equal(result.effect, EFFECT.HAPPENED)
  assert.equal(result.reason, 'exact_historical_receipts_completed')
  assert.equal(reconcilePendingOperation(pending, { actor: { actor_id: 99, epoch: 9 }, status }).effect, EFFECT.HAPPENED,
    'sealed original-actor work is historical evidence, not replacement-actor execution')
  const mutations = [
    { admission: { signature: 'wrong' } }, { admission: { attempt_id: 'wrong' } },
    { admission: { ordinal: 99 } }, { admission: { operation_count: 1 } },
    { admission: { actor_id: 99 } }, { admission: { epoch: 99 } },
    { admission: { generation: 3 } }, { admission: { generation: null } },
    { admission: { slots: [] } }, { admission: { slots: [queuedSlot(2), admission.slots[1]] } },
    { admission: { slots: [{ ...queuedSlot(1), ok: false }, admission.slots[1]] } },
    { admission: { state: 'admitted' } }, { admission: { state: 'uncertain' } },
    { receipts: [] }, { receipt: { batch_id: 99 } }, { receipt: { batch_generation: 2 } },
    { receipt: { batch_ref: 'batch-g1-99' } }, { receipt: { state: 'cancelled' } },
    { receipt: { state: 'uncertain' } }, { receipt: { outcome: 'refused' } },
  ]
  for (const mutation of mutations) {
    const weaker = { ...status, admission_journal: [{ ...admission, ...mutation.admission }],
      receipt_journal: mutation.receipts ?? [{ ...receipt, ...mutation.receipt }] }
    const held = reconcilePendingOperation(pending, { actor: EXACT_ACTOR, status: weaker })
    assert.notEqual(held.effect, EFFECT.HAPPENED, JSON.stringify(mutation))
    assert.notEqual(held.effect, EFFECT.NOT_HAPPENED, JSON.stringify(mutation))
  }
  assert.equal(reconcilePendingOperation(pending, { actor: {}, status }).effect, EFFECT.UNKNOWN)
})
