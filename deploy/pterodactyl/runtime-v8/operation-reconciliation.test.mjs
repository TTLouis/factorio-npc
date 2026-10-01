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
