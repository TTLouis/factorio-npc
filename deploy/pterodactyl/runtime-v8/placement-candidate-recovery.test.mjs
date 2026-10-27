// Run BC B: a supply_entity (boiler coal) followed by a coordinate-free place_entity(lab) in ONE batch. The engine's coordinate-free
// placement searches only the tile ring around the actor and refused with `no_position`. The mod left the admission row
// 'uncertain' (a supply is not a pure submission), the reconciler reported admitted_cancelled / partial_unknown, the unverified
// delivery turned the placement refusal into WORLD_BLOCKED, and the model's later concrete `planPlacement` correction was skipped.
//
// Fixture shape copied (non-secret fields only) from the retained BC trace and native-terminal-effects; the sealed files are not
// read or modified here. Substitution, labelled: ids/ticks are the retained ones; the goal/plan/step ids of the memory-level
// tests are synthetic (goal_1/step_3) because those tests build the board state directly.
//
// Baseline (aedca819): every test that asserts the settlement, the routed recovery or the exhaustion link below FAILS there;
// the ambiguity tests assert behavior the baseline already had and must keep passing (they prove the settlement is not a loophole).
import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory, CORRECTABLE_PLACEMENT_RETRY_BUDGET } from './canonical-task-board-memory.mjs'
import { batchSettlementEvidence, NpcAgentLoop, receiptEvidence } from './npc-agent-loop.mjs'
import {
  buildPendingOperation,
  cancelledBatchPrefix,
  completedPlacementPatch,
  EFFECT,
  operationSignature,
  reconcilePendingOperation,
  reconciliationFacts,
  reconciliationGuidance,
  RECONCILE_VERDICT,
  settledPrefixPatch,
  unresolvedNativeAdmissions,
} from './operation-reconciliation.mjs'
import { conflictingOperation, openSettledFences, operationLedger, OPERATION_LEDGER_LIMIT, recordOperation, settleOperation } from './operation-ledger.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, PLANNING_EVENT, restorePlanningState, serializePlanningState } from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { FakeFactorio, planReply, recordingJev } from './task-loop-fixtures.mjs'

const ACTOR = { actor_id: 8, epoch: 1 }
const SUPPLY = { name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'coal', count: 20 }] } }
const PLACE_LAB = { name: 'place_entity', args: { entity_name: 'lab' } }
const BC_OPS = [SUPPLY, PLACE_LAB]

const refFor = id => ({ batch_id: id, batch_generation: 1, batch_ref: `batch-g1-${id}` })
const NO_POSITION = { operation_id: 115, type: 'placing', accepted: false, completed: false, code: 'no_position', tick: 100797, actor_id: 8, actor_kind: 'standalone_character', force_index: 1, entity_name: 'lab' }

function pendingFor(operations, { id = 140, goalId = 'goal_1', planId, stepId } = {}) {
  return buildPendingOperation({
    requestId: 'req_mvq1gk68_1', operationKey: `req_mvq1gk68_1/batch_${id}`, ordinal: id, protocolVersion: 2, operations,
    goalId, planId, stepId, actor: ACTOR, baseline: { generation: 1, max_batch_id: id - 1, active: null }, now: 1,
  })
}

// The native status after a batch whose failing task is `failedIndex`. The default admission row is exactly what the retained
// mod produced (state 'uncertain', no applied_slot_count) because supply_entity is not a pure submission operation.
function nativeStatus(pending, { failedIndex = 1, queued = pending.operations.map(() => 1), taskTypes, admission = {}, receipt = {}, status = {} } = {}) {
  const id = pending.ordinal
  const ref = refFor(id)
  const types = taskTypes ?? pending.operations.map(operation => (operation.name === 'supply_entity' ? 'moving_items' : 'placing'))
  const taskCount = queued.reduce((sum, count) => sum + count, 0)
  const cancelled = { ...ref, task_count: taskCount, task_types: types, tick: 100797, reason: 'placing:no_position', started_count: failedIndex + 1,
    tasks_started: failedIndex + 1, failed_before_mutation: true, failed_task_index: failedIndex, ...receipt }
  return {
    task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1,
    admission_journal: [{
      operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, actor_id: 8, epoch: 1, ordinal: id,
      operation_count: pending.operations.length, state: 'uncertain', generation: 1, tick: 100796, work_mark: 150, ok: true, error: 'batch_reconciliation_required',
      slots: pending.operations.map((operation, index) => ({ index: index + 1, ok: true, operation: operation.name, batch_refs: [ref], queued_tasks: queued[index] })),
      ...admission,
    }],
    receipt_journal: [{ ...cancelled, state: receipt.state ?? 'cancelled' }],
    last_completed_batch: { batch_id: id - 1, task_count: 1, task_types: ['placing'], tick: 100151 },
    last_cancelled_batch: cancelled,
    basic_operation: { last_result: NO_POSITION, next_operation_id: 116 },
    ...status,
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reconciliation: the shared boundary
// ---------------------------------------------------------------------------------------------------------------------------

test('BC B: the exact receipt settles the supply as completed, the placement as no_effect, per operation', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.reason, 'exact_cancelled_prefix_before_mutation')
  assert.equal(result.basis, 'harness_receipt_derivation')
  assert.equal(result.effect, EFFECT.HAPPENED)
  assert.deepEqual(result.applied_slots, [1])
  assert.deepEqual(result.refused_slots, [2])
  assert.equal(result.unrun_slots, 0)
  assert.deepEqual(result.settlement_operations, [
    { slot: 1, operation: 'supply_entity', disposition: 'completed' },
    { slot: 2, operation: 'place_entity', disposition: 'no_effect' },
  ])
  const facts = reconciliationFacts(result, pending)
  assert.equal(facts.settlement_basis, 'harness_receipt_derivation')
  assert.deepEqual(facts.settlement.map(row => row.disposition), ['completed', 'no_effect'])
  assert.equal(facts.settlement_receipt.failed_task_index, 1)
  assert.equal(facts.settlement_receipt.batch_ref, 'batch-g1-140')
  const guidance = reconciliationGuidance(result, pending)
  assert.match(guidance, /Operations 1 completed before the refusal; do not repeat them/)
  assert.match(guidance, /positive count, which can be less than requested/)
})

test('BC B: a later operation that never started is reported not_started', () => {
  const pending = pendingFor([SUPPLY, PLACE_LAB, { name: 'supply_entity', args: { unit_number: 26, items: [{ item_name: 'coal', count: 5 }] } }])
  const status = nativeStatus(pending, { taskTypes: ['moving_items', 'placing', 'moving_items'] })
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.deepEqual(result.settlement_operations.map(row => row.disposition), ['completed', 'no_effect', 'not_started'])
  assert.equal(result.unrun_slots, 1)
})

test('BC B: a multi-item supply before the refused placement is a completed prefix of that many moving tasks', () => {
  const pending = pendingFor([{ name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'coal', count: 5 }, { item_name: 'wood', count: 2 }] } }, PLACE_LAB])
  const status = nativeStatus(pending, { failedIndex: 2, queued: [2, 1], taskTypes: ['moving_items', 'moving_items', 'placing'] })
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.deepEqual(result.applied_slots, [1])
})

// Each variant removes or contradicts one link of the proof. None may settle; all keep the existing unresolved effect, so the
// classified pause (and the duplicate-effect hold) applies exactly as before the repair.
const AMBIGUOUS = [
  ['no failed_task_index', { receipt: { failed_task_index: undefined } }],
  ['failed_before_mutation false', { receipt: { failed_before_mutation: false } }],
  ['failed_before_mutation missing', { receipt: { failed_before_mutation: undefined } }],
  ['more tasks started than the failed index + 1', { receipt: { tasks_started: 3 } }],
  ['fewer tasks started than the failed index + 1', { receipt: { tasks_started: 1 } }],
  ['started_count below tasks_started', { receipt: { started_count: 1 } }],
  ['tasks_started missing (old receipt)', { receipt: { tasks_started: undefined } }],
  ['failed index 0 but the first task is a delivery, not a placement', { receipt: { failed_task_index: 0, tasks_started: 1 } }],
  ['failed index past the batch', { receipt: { failed_task_index: 2, tasks_started: 3 } }],
  ['receipt names another batch ref', { receipt: { batch_ref: 'batch-g1-9' } }],
  ['receipt names another batch id', { receipt: { batch_id: 9 } }],
  ['receipt names another generation', { receipt: { batch_generation: 2 } }],
  ['receipt task count differs from the queued tasks', { receipt: { task_count: 3 } }],
  ['receipt task types do not match the prefix operation', { receipt: { task_types: ['placing', 'placing'] } }],
  ['receipt reason is not a placing failure', { receipt: { reason: 'moving_items:nothing_moved' } }],
  ['failing task is not a placing task', { receipt: { task_types: ['placing', 'moving_items'] } }],
  ['a refused operation rides on the receipt', { receipt: { refused_count: 1 } }],
  ['refusal rows ride on the receipt', { receipt: { refusals: [{ type: 'moving_items' }] } }],
  ['receipt outcome is set', { receipt: { outcome: 'cancelled' } }],
  ['receipt predates the admission', { receipt: { tick: 100000 } }],
  ['receipt is not a cancellation', { receipt: { state: 'completed' } }],
  ['a slot queued no tracked tasks', { admission: { slots: [{ index: 1, ok: true, operation: 'supply_entity', batch_refs: [refFor(140)] }, { index: 2, ok: true, operation: 'place_entity', batch_refs: [refFor(140)], queued_tasks: 1 }] } }],
  ['a slot belongs to another batch', { admission: { slots: [{ index: 1, ok: true, operation: 'supply_entity', batch_refs: [refFor(139)], queued_tasks: 1 }, { index: 2, ok: true, operation: 'place_entity', batch_refs: [refFor(140)], queued_tasks: 1 }] } }],
  ['a slot operation differs from the pending record', { admission: { slots: [{ index: 1, ok: true, operation: 'craft_item', batch_refs: [refFor(140)], queued_tasks: 1 }, { index: 2, ok: true, operation: 'place_entity', batch_refs: [refFor(140)], queued_tasks: 1 }] } }],
  ['the slots are missing (no journal slot mapping)', { admission: { slots: [] } }],
  ['the journal row is not uncertain/admitted any more', { admission: { state: 'partial' } }],
  ['the receipt journal is empty', { status: { receipt_journal: [] } }],
  ['the native queue is not idle', { status: { task_state: 'moving_items', queue_empty: false, queue_length: 1 } }],
  ['the native generation changed', { status: { batch_generation: 2 } }],
]
for (const [label, variant] of AMBIGUOUS) {
  test(`BC B ambiguity: ${label} does not settle (effect stays partial_unknown)`, () => {
    const pending = pendingFor(BC_OPS)
    const status = nativeStatus(pending, variant)
    const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
    assert.notEqual(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, JSON.stringify(result))
    assert.notEqual(result.effect, EFFECT.HAPPENED)
    assert.notEqual(result.effect, EFFECT.NOT_HAPPENED)
    assert.equal(cancelledBatchPrefix(status.admission_journal[0], status, pending.operations), null)
  })
}

test('BC B ambiguity: a duplicated receipt row for the batch is not one exact receipt', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  status.receipt_journal = [status.receipt_journal[0], { ...status.receipt_journal[0] }]
  assert.notEqual(reconcilePendingOperation(pending, { status, actor: ACTOR }).verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
})

test('BC B baseline shape: with the prefix not provable the batch is still the admitted_cancelled / partial_unknown the run saw', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending, { receipt: { failed_task_index: undefined } })
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.ADMITTED_CANCELLED)
  assert.equal(result.effect, EFFECT.PARTIAL_UNKNOWN)
  assert.equal(result.reason, 'exact_batch_cancelled')
})

test('BC B fences: another actor, epoch, signature or attempt never settles through this rule', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  assert.equal(reconcilePendingOperation(pending, { status, actor: { actor_id: 9, epoch: 1 } }).verdict, RECONCILE_VERDICT.STALE_ACTOR)
  assert.equal(reconcilePendingOperation(pending, { status, actor: { actor_id: 8, epoch: 2 } }).verdict, RECONCILE_VERDICT.STALE_ACTOR)
  const other = { ...pending, signature: operationSignature([SUPPLY]) }
  assert.equal(reconcilePendingOperation(other, { status, actor: ACTOR }).verdict, RECONCILE_VERDICT.UNKNOWN)
  const otherAttempt = { ...pending, attempt_id: 'req_other/batch_140' }
  assert.equal(reconcilePendingOperation(otherAttempt, { status, actor: ACTOR }).verdict, RECONCILE_VERDICT.UNKNOWN)
})

test('BC B: the settled row is terminal for native-liveness consumers only with its exact retained host record; an unsettled one still blocks them', () => {
  const pending = pendingFor(BC_OPS)
  assert.deepEqual(unresolvedNativeAdmissions(nativeStatus(pending), [pending], ACTOR), [])
  const ambiguous = nativeStatus(pending, { receipt: { failed_task_index: undefined } })
  assert.equal(unresolvedNativeAdmissions(ambiguous, [pending], ACTOR).length, 1)
})

// ---------------------------------------------------------------------------------------------------------------------------
// Board routing (canonical memory)
// ---------------------------------------------------------------------------------------------------------------------------

const KEY = 'npc:sgluna'

function boardState({ lastOperations } = {}) {
  const steps = ['Find stone', 'Mine stone', 'Fuel the boiler and place the lab', 'Build power', 'Start research']
  const board = {
    kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '', revision: 3, event_sequence: 0, evidence_sequence: 0,
    active_index: 2, active_step_id: 'step_3', completed_count: 2, total_steps: 5,
    steps: steps.map((description, index) => ({ id: `step_${index + 1}`, description, status: index < 2 ? 'completed' : index === 2 ? 'active' : 'pending' })),
    evidence: [], events: [], created_at: 1, updated_at: 1,
  }
  return {
    goal_id: 'goal_1', owner: 'Louis', objective: 'Power the lab', status: 'active', blocker: '', pause_reason: '', plan: steps, current_step: 2, revision: 3,
    last_chat_message: 'Working', updated_at: 1, history: [], task_board: board, last_mutation_verified: false,
    last_operations: lastOperations ?? BC_OPS.map(operation => `${operation.name} ${JSON.stringify(operation.args)}`),
  }
}

// The failure receipt exactly as taskStatusReceipt records it: runtime settlement of the pending record attached to the evidence.
function failureEvidence(pending, nativeOptions = {}, { settle = true, context = {}, stamp = {} } = {}) {
  const status = nativeStatus(pending, nativeOptions)
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  const settlement = settle ? batchSettlementEvidence({ result, pending }) : undefined
  const evidence = receiptEvidence(JSON.stringify(status), 'failed', { goal_id: 'goal_1', step_id: 'step_3', actor_id: 8, actor_epoch: 1, settlement, ...context })
  return { evidence: { ...evidence, ...stamp }, result, settlement }
}

function memoryWith(state = boardState()) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(KEY, state)
  return memory
}

// A later retry batch: only the coordinate-free placement, whose first task the engine refused (the mod itself proves this one).
function retryEvidence(id) {
  const pending = pendingFor([PLACE_LAB], { id })
  const status = nativeStatus(pending, { failedIndex: 0, queued: [1], taskTypes: ['placing'], receipt: { started_count: 1, tasks_started: 1 },
    admission: { state: 'failed', proven_refusal: true, ok: false, error: 'refused_before_mutation', work_mark: undefined } })
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  const evidence = receiptEvidence(JSON.stringify(status), 'failed', { goal_id: 'goal_1', step_id: 'step_3', actor_id: 8, actor_epoch: 1,
    settlement: batchSettlementEvidence({ result, pending }) })
  return { evidence, pending }
}
const retryState = () => boardState({ lastOperations: [`place_entity ${JSON.stringify(PLACE_LAB.args)}`] })

test('BC B: a settled prefix routes the no_position placement to bounded same-step recovery, not WORLD_BLOCKED', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending)
  const board = memory.recordBoardEvidence(KEY, evidence)
  const state = memory.currentPlan(KEY)
  assert.equal(state.status, 'active')
  assert.equal(state.blocker, '')
  assert.equal(board.status, 'active')
  assert.equal(board.active_step_id, 'step_3')
  assert.equal(board.completed_count, 2)
  assert.equal(board.steps[2].status, 'active')
  const recovery = JSON.parse(board.evidence.at(-1).summary)
  assert.equal(board.evidence.at(-1).kind, 'operation_failure_recoverable')
  assert.equal(recovery.code, 'no_position')
  assert.equal(recovery.failure_class, 'model_correctable_placing_no_position')
  assert.equal(recovery.placement_search, 'actor_local')
  assert.equal(recovery.attempt, 1)
  assert.equal(recovery.retry_budget, CORRECTABLE_PLACEMENT_RETRY_BUDGET)
  assert.deepEqual(recovery.completed_operations, ['supply_entity'])
  assert.equal(recovery.settled_batch_ref, 'batch-g1-140')
  assert.equal(recovery.prefix_settled, true)
  assert.ok(board.evidence.at(-1).summary.length < 1200, 'the recovery record must fit the board evidence bound untruncated')
})

test('BC B: the settled transfer is no longer an unverified intent for that batch, only for that batch', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending)
  memory.recordBoardEvidence(KEY, evidence)
  // A different batch with the identical operations has no settlement of its own, so the transfer in it stays unverified.
  const second = pendingFor(BC_OPS, { id: 141 })
  const status = nativeStatus(second, { receipt: { failed_task_index: undefined } })
  const unproven = receiptEvidence(JSON.stringify(status), 'failed', { goal_id: 'goal_1', step_id: 'step_3', actor_id: 8, actor_epoch: 1 })
  memory.recordBoardEvidence(KEY, unproven)
  const state = memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:no_position')
})

test('BC B ambiguity at the board: no settlement means the original classified pause, with the transfer still unverified', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending, {}, { settle: false })
  memory.recordBoardEvidence(KEY, evidence)
  const state = memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:no_position')
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_failure_recoverable'), false)
})

// Each tampered binding must refuse to route even though the receipt itself says no_position with a settlement attached.
const TAMPERED = [
  ['another batch ref', s => ({ ...s, batch_ref: 'batch-g1-9' })],
  ['another batch id', s => ({ ...s, batch_id: 9 })],
  ['another generation', s => ({ ...s, batch_generation: 2 })],
  ['another goal', s => ({ ...s, goal_id: 'goal_other' })],
  ['another actor', s => ({ ...s, actor_id: 9 })],
  ['another epoch', s => ({ ...s, actor_epoch: 2 })],
  ['another signature', s => ({ ...s, signature: operationSignature([SUPPLY]) })],
  ['another plan stamp', s => ({ ...s, plan_id: 'plan_other' })],
  ['another step stamp', s => ({ ...s, step_id: 'step_other' })],
  ['a different verdict', s => ({ ...s, verdict: 'admitted_cancelled' })],
  ['an unknown basis', s => ({ ...s, basis: 'model_claim' })],
  ['no disposition for the failed placement', s => ({ ...s, operations: s.operations.map(row => ({ ...row, disposition: 'completed' })) })],
  ['the supply marked as the refused operation', s => ({ ...s, operations: [{ ...s.operations[0], disposition: 'no_effect' }, { ...s.operations[1], disposition: 'not_started' }], applied_slots: [], refused_slots: [1] })],
  ['operations out of order', s => ({ ...s, operations: [s.operations[1], s.operations[0]] })],
  ['slot lists disagreeing with the dispositions', s => ({ ...s, applied_slots: [] })],
  ['a missing operation row', s => ({ ...s, operations: s.operations.slice(0, 1) })],
]
for (const [label, tamper] of TAMPERED) {
  test(`BC B fence: a settlement with ${label} is not accepted by the board`, () => {
    const pending = pendingFor(BC_OPS)
    const memory = memoryWith()
    const { evidence, settlement } = failureEvidence(pending)
    const receipt = JSON.parse(evidence.summary)
    receipt.settlement = tamper(settlement)
    memory.recordBoardEvidence(KEY, { ...evidence, summary: JSON.stringify(receipt) })
    const state = memory.currentPlan(KEY)
    assert.equal(state.status, 'blocked', label)
    assert.equal(state.blocker, 'placement_failed:no_position')
    assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_failure_recoverable'), false)
  })
}

test('BC B fence: stamped evidence for a plan or step other than the settled one does not route', () => {
  const pending = pendingFor(BC_OPS, { planId: 'plan_a', stepId: 'plan_a_s3' })
  const memory = memoryWith()
  // The receipt was stamped at admission with a different plan than the one the settlement was proven for.
  const { evidence } = failureEvidence(pending, {}, { stamp: { plan_id: 'plan_b', step_id: 'plan_b_s3' } })
  memory.recordBoardEvidence(KEY, evidence)
  assert.equal(memory.currentPlan(KEY).status, 'blocked')
})

test('BC B fence: the entity of the settled placement must be the one that was refused', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending, { status: { basic_operation: { last_result: { ...NO_POSITION, entity_name: 'boiler' } } } })
  memory.recordBoardEvidence(KEY, evidence)
  assert.equal(memory.currentPlan(KEY).status, 'blocked')
})

test('BC B: the settlement is not a general license; other placement codes and non-placement failures keep their classification', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending, { status: { basic_operation: { last_result: { ...NO_POSITION, code: 'item_missing' } } } })
  memory.recordBoardEvidence(KEY, evidence)
  const state = memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:item_missing')
})

test('BC B: the same receipt re-delivered is one attempt, with or without its settlement (the pending record is gone the second time)', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending)
  memory.recordBoardEvidence(KEY, evidence)
  memory.recordBoardEvidence(KEY, evidence)
  // Replay after settlement cleared the pending record: no settlement is attached, yet the board already holds the recovery.
  const replay = failureEvidence(pending, {}, { settle: false }).evidence
  memory.recordBoardEvidence(KEY, replay)
  const state = memory.currentPlan(KEY)
  assert.equal(state.status, 'active')
  assert.equal(state.task_board.evidence.filter(item => item.kind === 'operation_failure_recoverable').length, 1)
})

test('BC B: attempts 1 and 2 recover, the third refusal blocks as placement_failed:no_position and links every attempt', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const candidates = []
  const original = memory.applyOutcomeAuthority.bind(memory)
  memory.applyOutcomeAuthority = (key, candidate, options) => { candidates.push(candidate); return original(key, candidate, options) }

  memory.recordBoardEvidence(KEY, failureEvidence(pending).evidence)
  assert.equal(memory.currentPlan(KEY).status, 'active')

  memory.planByNpc.get(KEY).last_operations = retryState().last_operations
  memory.recordBoardEvidence(KEY, retryEvidence(141).evidence)
  const second = memory.currentPlan(KEY)
  assert.equal(second.status, 'active')
  assert.equal(JSON.parse(second.task_board.evidence.at(-1).summary).attempt, 2)
  assert.deepEqual(JSON.parse(second.task_board.evidence.at(-1).summary).completed_operations, [])

  memory.recordBoardEvidence(KEY, retryEvidence(142).evidence)
  const exhausted = memory.currentPlan(KEY)
  assert.equal(exhausted.status, 'blocked')
  assert.equal(exhausted.blocker, 'placement_failed:no_position')
  assert.equal(exhausted.task_board.active_step_id, 'step_3')
  assert.equal(exhausted.task_board.completed_count, 2)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].reason_code, 'placement_failed:no_position')
  const refs = candidates[0].evidence.map(item => item.ref)
  assert.ok(refs.includes('batch-g1-142'), refs.join())
  assert.ok(refs.includes('batch-g1-141') && refs.includes('batch-g1-140'), `prior attempts must be linked: ${refs.join()}`)
})

test('BC B: the streak, the settlement and the single count survive persistence', () => {
  const pending = pendingFor(BC_OPS)
  const memory = memoryWith()
  const { evidence } = failureEvidence(pending)
  memory.recordBoardEvidence(KEY, evidence)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  const before = restored.currentPlan(KEY)
  assert.equal(before.status, 'active')
  assert.equal(before.task_board.evidence.filter(item => item.kind === 'operation_failure_recoverable').length, 1)
  // The same receipt after a restart (no pending record any more) is not a new attempt and not a blocker.
  restored.recordBoardEvidence(KEY, failureEvidence(pending, {}, { settle: false }).evidence)
  const after = restored.currentPlan(KEY)
  assert.equal(after.status, 'active')
  assert.equal(after.task_board.evidence.filter(item => item.kind === 'operation_failure_recoverable').length, 1)
  // The next refusal continues the persisted streak (attempt 2), then the budget blocks.
  restored.planByNpc.get(KEY).last_operations = retryState().last_operations
  restored.recordBoardEvidence(KEY, retryEvidence(141).evidence)
  assert.equal(JSON.parse(restored.currentPlan(KEY).task_board.evidence.at(-1).summary).attempt, 2)
  restored.recordBoardEvidence(KEY, retryEvidence(142).evidence)
  assert.equal(restored.currentPlan(KEY).blocker, 'placement_failed:no_position')
})

// ---------------------------------------------------------------------------------------------------------------------------
// The real agent loop: failed() -> taskStatusReceipt -> settlement -> board -> continuation -> next admitted batch
// ---------------------------------------------------------------------------------------------------------------------------

const STEPS = ['Fuel the boiler and place the lab next to the steam engine', 'Verify the lab is powered']

function loopWorld({ operationsFor }) {
  const game = new FakeFactorio({ inventory: { coal: 60, lab: 2 } })
  game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'boiler', type: 'boiler', unit_number: 25, position: { x: 48, y: 14.5 }, distance: 8 }] }
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  const trace = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages) => {
      prompts.push(messages.map(message => String(message.content ?? '')).join('\n'))
      // Exact entity ids are executable only after a live observation in the request: the first model call observes the boiler.
      if (prompts.length === 1) return { content: null, tool_calls: [{ id: 'observe', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 64, name: 'boiler', limit: 4 }) } }] }
      return planReply({ plan: STEPS, currentStep: 0, operations: operationsFor(prompts.length - 1) })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'placement candidate recovery',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }
  // What the retained mod does: a supply before the refused placement leaves the admission row 'uncertain'.
  const markUncertain = () => {
    // Fixture clock substitution: FakeFactorio stamps receipts 600 + batch id but admissions at its game tick; the retained run had admission tick < receipt tick.
    for (const record of game.admissions) Object.assign(record, { state: 'uncertain', error: 'batch_reconciliation_required', ok: true, proven_refusal: undefined, applied_slot_count: undefined, tick: (game.cancelledBatch?.tick ?? 600) - 1 })
  }
  return { game, memory, agent, prompts, trace, markUncertain, plan: () => getActivePlan(memory.planningState(KEY)) }
}

const SUPPLY_OP = { name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'coal', count: 20 }] } }
const RETRY_PLACE = { name: 'place_entity', args: { entity_name: 'lab', x: 45.5, y: 17.5 } }

test('BC B loop: supply + coordinate-free place, no_position -> settled prefix, same-step recovery, the concrete placement is admitted', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [SUPPLY_OP, PLACE_LAB] : [RETRY_PLACE]) })
  await world.agent.request('fuel the boiler and place a lab', { sender: 'Louis' })
  const committed = structuredClone(world.plan())
  const stepId = world.memory.currentPlan(KEY).task_board.active_step_id
  assert.deepEqual(world.game.lastTaskTypes, ['moving_items', 'placing'])
  assert.equal(world.game.mutations.length, 1)

  const reason = world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 1 })
  world.markUncertain()
  await world.agent.failed(reason)

  const state = world.memory.currentPlan(KEY)
  assert.equal(state.status, 'active', `blocker=${state.blocker}`)
  assert.equal(state.blocker, '')
  // Committed plan and step unchanged.
  assert.equal(world.plan().plan_id, committed.plan_id)
  assert.equal(world.plan().version, committed.version)
  assert.deepEqual(world.plan().steps.map(step => step.description), committed.steps.map(step => step.description))
  assert.equal(state.task_board.active_step_id, stepId)
  assert.equal(state.task_board.completed_count, 0)
  // The per-operation settlement and its evidence are traced with request identity.
  const reconciled = world.trace.find(record => record.event === 'operation.reconciled' && record.data.verdict === 'refused_before_mutation')
  assert.ok(reconciled?.data.request_id)
  assert.equal(reconciled.data.reason, 'exact_cancelled_prefix_before_mutation')
  assert.equal(reconciled.data.settled, true)
  assert.equal(reconciled.data.settlement_basis, 'harness_receipt_derivation')
  assert.deepEqual(reconciled.data.settlement.map(row => [row.operation, row.disposition]), [['supply_entity', 'completed'], ['place_entity', 'no_effect']])
  assert.equal(reconciled.data.settlement_receipt.failed_task_index, 1)
  assert.ok(reconciled.data.plan_id && reconciled.data.step_id)
  const routed = world.trace.find(record => record.event === 'operations.execution_recoverable')
  assert.equal(routed?.data.code, 'no_position')
  assert.equal(routed.data.attempt, 1)
  assert.equal(routed.data.retry_budget, CORRECTABLE_PLACEMENT_RETRY_BUDGET)
  assert.deepEqual(routed.data.completed_operations, ['supply_entity'])
  assert.equal(routed.data.reason, 'settled_batch_placement_refused_before_mutation')
  assert.equal(world.trace.some(record => record.event === 'operation.uncertainty_blocked'), false)
  assert.equal(world.trace.some(record => record.event === 'operations.skipped' && record.data.reason === 'plan_blocked_awaiting_user'), false)
  // The pending record is settled; the unresolved-effect hold is gone and the native row no longer counts as unresolved.
  assert.equal(world.memory.pendingOperations(KEY).some(record => record.ordinal === 1), false)
  // The model is told the facts: which operation completed, that only the placement remains, and how the native search works.
  const retryPrompt = world.prompts.at(-1)
  assert.match(retryPrompt, /1\. supply_entity/)
  assert.match(retryPrompt, /do not repeat them/)
  assert.match(retryPrompt, /only searches the tile ring right around where the NPC stands/)
  assert.match(retryPrompt, /Only the placement remains/)
  assert.match(retryPrompt, /getPlacementCandidates/)
  assert.match(retryPrompt, /Attempt 1 of 2/)
  // The concrete correction is admitted for the same step, and the supply is not replayed.
  assert.equal(world.game.mutations.length, 2)
  assert.deepEqual(world.game.lastTaskTypes, ['placing'])
  assert.doesNotMatch(world.game.mutations[1], /supply_entity/)
})

test('BC B loop ambiguity: without the failing-task index the batch stays unresolved, the plan pauses and nothing is replayed', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [SUPPLY_OP, PLACE_LAB] : [RETRY_PLACE]) })
  await world.agent.request('fuel the boiler and place a lab', { sender: 'Louis' })
  const reason = world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 1 })
  delete world.game.cancelledBatch.failed_task_index
  world.markUncertain()
  await world.agent.failed(reason)

  const state = world.memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:no_position')
  assert.equal(world.trace.some(record => record.event === 'operation.reconciled' && record.data.verdict === 'refused_before_mutation'), false)
  const held = world.memory.pendingOperation(KEY)
  assert.ok(held, 'the unproven batch stays held')
  assert.equal(held.effect, EFFECT.PARTIAL_UNKNOWN)
  assert.equal(world.trace.some(record => record.event === 'operations.execution_recoverable'), false)
  // No corrected batch and no replay of the supply were admitted.
  assert.equal(world.game.mutations.length, 1)
})

test('BC B loop exhaustion: repeated coordinate-free refusals use the durable budget, then block as placement_failed:no_position', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [SUPPLY_OP, PLACE_LAB] : [PLACE_LAB]) })
  await world.agent.request('fuel the boiler and place a lab', { sender: 'Louis' })
  const committed = structuredClone(world.plan())

  world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 1 })
  world.markUncertain()
  await world.agent.failed('placing:no_position')
  assert.equal(world.memory.currentPlan(KEY).status, 'active')
  assert.equal(world.game.mutations.length, 2)

  world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' })
  await world.agent.failed('placing:no_position')
  const second = world.memory.currentPlan(KEY)
  assert.equal(second.status, 'active', `blocker=${second.blocker}`)
  assert.equal(JSON.parse(second.task_board.evidence.filter(item => item.kind === 'operation_failure_recoverable').at(-1).summary).attempt, 2)
  assert.equal(world.game.mutations.length, 3)

  world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' })
  await world.agent.failed('placing:no_position')
  const exhausted = world.memory.currentPlan(KEY)
  assert.equal(exhausted.status, 'blocked')
  assert.equal(exhausted.blocker, 'placement_failed:no_position')
  assert.equal(world.plan().plan_id, committed.plan_id)
  assert.equal(world.game.mutations.length, 3)
})

// ---------------------------------------------------------------------------------------------------------------------------
// Diagnostics: the behavior-trace checker sees the original terminal shape as a stall and the corrected one as healthy
// ---------------------------------------------------------------------------------------------------------------------------

test('BC B checker: the original blocked terminal is a silent stall finding; the corrected settled-and-recovered stream is not', () => {
  const rid = 'req_mvq1gk68_1'
  const row = (event, data, seq) => ({ schema: 1, ts: `2026-10-27T02:27:${String(8 + seq).padStart(2, '0')}.000Z`, seq, event, request_id: rid, turn: 22, actor_id: 8, epoch: 1, data })
  const reconciledOriginal = row('operation.reconciled', { request_id: rid, trigger: 'receipt', operation_key: `${rid}/batch_140`, verdict: 'admitted_cancelled',
    effect: 'partial_unknown', reason: 'exact_batch_cancelled', operations: ['supply_entity', 'place_entity'], effect_classes: ['delivery', 'place'], settled: false }, 1)
  const original = [reconciledOriginal, row('request.completed', { outcome: 'blocked_no_operation',
    task_board: { kind: 'task_board_lite', goal_id: 'goal_185vxgi_1', status: 'blocked', blocker: 'placement_failed:no_position', active_step_id: 'step_4' } }, 2)]
  const stalls = rows => analyzeBehaviorTrace(rows).findings.filter(finding => finding.signature === 'silent_blocked_stall')
  assert.equal(stalls(original).length, 1)

  const pending = pendingFor(BC_OPS)
  const result = reconcilePendingOperation(pending, { status: nativeStatus(pending), actor: ACTOR })
  const corrected = [
    row('operation.reconciled', { request_id: rid, trigger: 'receipt', ...reconciliationFacts(result, pending), settled: true, plan_id: 'goal_185vxgi_1_p7', step_id: 'step_4' }, 1),
    row('operations.execution_recoverable', { failure_class: 'model_correctable_placing_no_position', attempt: 1, retry_budget: 2, code: 'no_position',
      settled_batch_ref: 'batch-g1-140', completed_operations: ['supply_entity'], reason: 'settled_batch_placement_refused_before_mutation' }, 2),
    row('request.completed', { outcome: 'operations_admitted', chat_message: 'Placing the lab at a candidate position.', task_board: { kind: 'task_board_lite', goal_id: 'goal_185vxgi_1', status: 'active', blocker: '', active_step_id: 'step_4' } }, 3),
  ]
  assert.equal(stalls(corrected).length, 0)
  assert.equal(analyzeBehaviorTrace(corrected).findings.length, 0, JSON.stringify(analyzeBehaviorTrace(corrected).findings))
})

// ---------------------------------------------------------------------------------------------------------------------------
// Placement-FIRST batches: the refused coordinate-free placement is the first task (failed_task_index 0)
// ---------------------------------------------------------------------------------------------------------------------------

const FIRST_OPS = [PLACE_LAB, SUPPLY]
const firstStatus = (pending, extra = {}) => nativeStatus(pending, {
  failedIndex: 0, taskTypes: pending.operations.map(operation => (operation.name === 'supply_entity' ? 'moving_items' : 'placing')),
  ...extra, receipt: { started_count: 1, tasks_started: 1, ...extra.receipt },
})

test('placement-first: a single place_entity batch whose first task was refused settles as no_effect with an empty prefix', () => {
  const pending = pendingFor([PLACE_LAB])
  const status = nativeStatus(pending, { failedIndex: 0, queued: [1], taskTypes: ['placing'], receipt: { started_count: 1, tasks_started: 1 } })
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.reason, 'exact_cancelled_prefix_before_mutation')
  assert.equal(result.effect, EFFECT.NOT_HAPPENED)
  assert.deepEqual(result.applied_slots, [])
  assert.deepEqual(result.settlement_operations, [{ slot: 1, operation: 'place_entity', disposition: 'no_effect' }])
})

test('placement-first: later operations that never started are not_started and nothing of the batch happened', () => {
  const pending = pendingFor(FIRST_OPS)
  const result = reconcilePendingOperation(pending, { status: firstStatus(pending), actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(result.effect, EFFECT.NOT_HAPPENED)
  assert.deepEqual(result.settlement_operations.map(row => row.disposition), ['no_effect', 'not_started'])
  assert.equal(result.unrun_slots, 1)
  assert.deepEqual(unresolvedNativeAdmissions(firstStatus(pending), [pending], ACTOR), [])
})

const FIRST_AMBIGUOUS = [
  ['a later task also started', { receipt: { tasks_started: 2, started_count: 2 } }],
  ['failed_before_mutation missing', { receipt: { failed_before_mutation: undefined } }],
  ['failed_task_index missing', { receipt: { failed_task_index: undefined } }],
  ['tasks_started missing (old receipt)', { receipt: { tasks_started: undefined } }],
  ['the failing task is not a placing task', { receipt: { task_types: ['moving_items', 'moving_items'] } }],
  ['a refusal rides on the receipt', { receipt: { refused_count: 1 } }],
  ['another batch ref', { receipt: { batch_ref: 'batch-g1-9' } }],
  ['a slot has no queued_tasks', { admission: { slots: [{ index: 1, ok: true, operation: 'place_entity', batch_refs: [refFor(140)] }, { index: 2, ok: true, operation: 'supply_entity', batch_refs: [refFor(140)], queued_tasks: 1 }] } }],
]
for (const [label, variant] of FIRST_AMBIGUOUS) {
  test(`placement-first ambiguity: ${label} does not settle`, () => {
    const pending = pendingFor(FIRST_OPS)
    const status = firstStatus(pending, variant)
    const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
    assert.notEqual(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, JSON.stringify(result))
    assert.notEqual(result.effect, EFFECT.NOT_HAPPENED)
    assert.equal(unresolvedNativeAdmissions(status, [], ACTOR).length, 1)
  })
}

test('placement-first ambiguity: a busy native queue does not settle', () => {
  const pending = pendingFor(FIRST_OPS)
  const status = firstStatus(pending, { status: { task_state: 'placing', queue_length: 1, queue_empty: false } })
  assert.notEqual(reconcilePendingOperation(pending, { status, actor: ACTOR }).verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
})

function firstEvidence(id, pendingOptions) {
  const pending = pendingFor(FIRST_OPS, { id, ...pendingOptions })
  const status = firstStatus(pending)
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.equal(result.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  return receiptEvidence(JSON.stringify(status), 'failed', { goal_id: 'goal_1', step_id: 'step_3', actor_id: 8, actor_epoch: 1,
    settlement: batchSettlementEvidence({ result, pending }) })
}
const firstState = () => boardState({ lastOperations: FIRST_OPS.map(operation => `${operation.name} ${JSON.stringify(operation.args)}`) })

test('placement-first board: routes to bounded recovery with an empty prefix; the third refusal blocks and links every attempt', () => {
  const memory = memoryWith(firstState())
  const candidates = []
  const original = memory.applyOutcomeAuthority.bind(memory)
  memory.applyOutcomeAuthority = (key, candidate, options) => { candidates.push(candidate); return original(key, candidate, options) }
  memory.recordBoardEvidence(KEY, firstEvidence(140))
  let state = memory.currentPlan(KEY)
  assert.equal(state.status, 'active')
  const first = JSON.parse(state.task_board.evidence.at(-1).summary)
  assert.equal(first.attempt, 1)
  assert.deepEqual(first.completed_operations, [])
  assert.equal(first.unrun_operations, 1)
  memory.recordBoardEvidence(KEY, firstEvidence(140)) // the same receipt again is not another attempt
  memory.recordBoardEvidence(KEY, firstEvidence(141))
  state = memory.currentPlan(KEY)
  assert.equal(state.status, 'active')
  assert.equal(JSON.parse(state.task_board.evidence.at(-1).summary).attempt, 2)
  memory.recordBoardEvidence(KEY, firstEvidence(142))
  state = memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'placement_failed:no_position')
  assert.equal(state.task_board.completed_count, 2)
  const refs = candidates[0].evidence.map(item => item.ref)
  assert.ok(['batch-g1-140', 'batch-g1-141', 'batch-g1-142'].every(ref => refs.includes(ref)), refs.join())
})

test('placement-first board fences: an unsettled or tampered placement-first receipt keeps the classified pause', () => {
  const pending = pendingFor(FIRST_OPS)
  const status = firstStatus(pending)
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  const settlement = batchSettlementEvidence({ result, pending })
  const make = tampered => {
    const evidence = receiptEvidence(JSON.stringify(status), 'failed', { goal_id: 'goal_1', step_id: 'step_3', actor_id: 8, actor_epoch: 1, settlement: tampered })
    const memory = memoryWith(firstState())
    memory.recordBoardEvidence(KEY, evidence)
    return memory.currentPlan(KEY)
  }
  for (const tampered of [undefined, { ...settlement, signature: operationSignature([PLACE_LAB]) }, { ...settlement, actor_epoch: 2 }, { ...settlement, batch_ref: 'batch-g1-9' },
    { ...settlement, operations: settlement.operations.map(row => ({ ...row, disposition: 'completed' })) }]) {
    const state = make(tampered)
    // The later supply never ran, so with no settlement the transfer intent stays unverified and the plan pauses.
    assert.equal(state.status, 'blocked')
    assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_failure_recoverable'), false)
  }
})

test('placement-first loop: place + supply with the placement refused first settles, recovers in the same step and re-admits both', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [PLACE_LAB, SUPPLY_OP] : [RETRY_PLACE, SUPPLY_OP]) })
  await world.agent.request('place a lab and fuel the boiler', { sender: 'Louis' })
  const committed = structuredClone(world.plan())
  assert.deepEqual(world.game.lastTaskTypes, ['placing', 'moving_items'])
  const reason = world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 0 })
  world.markUncertain()
  await world.agent.failed(reason)

  const state = world.memory.currentPlan(KEY)
  assert.equal(state.status, 'active', `blocker=${state.blocker}`)
  assert.equal(world.plan().plan_id, committed.plan_id)
  const reconciled = world.trace.find(record => record.event === 'operation.reconciled' && record.data.verdict === 'refused_before_mutation')
  assert.equal(reconciled.data.reason, 'exact_cancelled_prefix_before_mutation')
  assert.equal(reconciled.data.effect, 'not_happened')
  assert.deepEqual(reconciled.data.settlement.map(row => row.disposition), ['no_effect', 'not_started'])
  const routed = world.trace.find(record => record.event === 'operations.execution_recoverable')
  assert.equal(routed.data.attempt, 1)
  assert.deepEqual(routed.data.completed_operations, [])
  assert.equal(world.memory.pendingOperations(KEY).some(record => record.ordinal === 1), false)
  assert.match(world.prompts.at(-1), /first task of the batch, so nothing in the batch took effect/)
  assert.match(world.prompts.at(-1), /Attempt 1 of 2/)
  assert.equal(world.game.mutations.length, 2)
  assert.deepEqual(world.game.lastTaskTypes, ['placing', 'moving_items'])
})

test('placement-first loop exhaustion: three coordinate-free refusals block as placement_failed:no_position', async () => {
  const world = loopWorld({ operationsFor: () => [PLACE_LAB, SUPPLY_OP] })
  await world.agent.request('place a lab and fuel the boiler', { sender: 'Louis' })
  const committed = structuredClone(world.plan())
  for (const expected of ['active', 'active', 'blocked']) {
    world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 0 })
    world.markUncertain()
    await world.agent.failed('placing:no_position')
    assert.equal(world.memory.currentPlan(KEY).status, expected)
  }
  assert.equal(world.memory.currentPlan(KEY).blocker, 'placement_failed:no_position')
  assert.equal(world.plan().plan_id, committed.plan_id)
  assert.equal(world.game.mutations.length, 3)
})

// ---------------------------------------------------------------------------------------------------------------------------
// Repair iteration 2, SELF-1: native data alone never clears an uncertain admission row, and the derivation is scoped to
// `placing:no_position` from a coordinate-free place_entity
// ---------------------------------------------------------------------------------------------------------------------------

const GUARD_REFUSED = { receipt: { reason: 'placing:placement_candidate_unavailable' } }
const CANDIDATE = { name: 'place_candidate', args: { entity_name: 'boiler', x: 1.5, y: 2.5, direction: 0 } }

test('SELF-1: a preservation guard-refused place_candidate row stays unresolved, with or without a host record (native lane entity-observation)', () => {
  for (const [label, operations, options] of [
    ['prefix then candidate', [SUPPLY, CANDIDATE], { failedIndex: 1 }],
    ['candidate alone', [CANDIDATE], { failedIndex: 0, queued: [1], taskTypes: ['placing'], receipt: { started_count: 1, tasks_started: 1 } }],
  ]) {
    const pending = pendingFor(operations)
    const status = nativeStatus(pending, { ...options, receipt: { ...options.receipt, ...GUARD_REFUSED.receipt } })
    assert.equal(cancelledBatchPrefix(status.admission_journal[0], status, pending.operations), null, label)
    assert.notEqual(reconcilePendingOperation(pending, { status, actor: ACTOR }).verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION, label)
    assert.equal(unresolvedNativeAdmissions(status, [], ACTOR).length, 1, `${label}: no record`)
    assert.equal(unresolvedNativeAdmissions(status, [pending], ACTOR).length, 1, `${label}: exact pending record`)
  }
})

test('SELF-1: the derivation is scoped to no_position of a coordinate-free place_entity, not any placing: reason or a place_candidate', () => {
  for (const reason of ['placing:not_placeable', 'placing:placement_candidate_unavailable', 'placing:placement_candidate_required', 'placing:create_failed', 'placing:', 'placing:no_position_extra']) {
    const pending = pendingFor(BC_OPS)
    const status = nativeStatus(pending, { receipt: { reason } })
    assert.equal(cancelledBatchPrefix(status.admission_journal[0], status, pending.operations), null, reason)
    assert.equal(unresolvedNativeAdmissions(status, [pending], ACTOR).length, 1, reason)
  }
  const candidate = pendingFor([SUPPLY, CANDIDATE])
  const status = nativeStatus(candidate, { receipt: { reason: 'placing:no_position' } })
  assert.equal(cancelledBatchPrefix(status.admission_journal[0], status, candidate.operations), null, 'place_candidate never settles through the derivation')
  assert.equal(unresolvedNativeAdmissions(status, [candidate], ACTOR).length, 1)
})

test('SELF-1: a no_position row with no retained host record stays unresolved; a record for another operation does not help', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  assert.equal(unresolvedNativeAdmissions(status, [], ACTOR).length, 1)
  assert.equal(unresolvedNativeAdmissions(status, [{ ...pending, operation_key: 'req_other/batch_9' }], ACTOR).length, 1)
})

test('SELF-1: with the exact retained host record and lineage the row is terminal, whether the record is pending or already closed', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  const result = reconcilePendingOperation(pending, { status, actor: ACTOR })
  assert.deepEqual(unresolvedNativeAdmissions(status, [pending], ACTOR), [])
  const closed = { ...pending, ...settledPrefixPatch(pending, result) }
  assert.equal(closed.effect, EFFECT.PARTIAL_KNOWN)
  assert.deepEqual(unresolvedNativeAdmissions(status, [closed], ACTOR), [], 'the archived settlement record still proves the row terminal')
  // The rest of the journal is judged independently.
  const other = { ...status.admission_journal[0], operation_key: 'req_x/batch_141', ordinal: 141 }
  assert.equal(unresolvedNativeAdmissions({ ...status, admission_journal: [status.admission_journal[0], other] }, [pending], ACTOR).length, 1)
})

test('SELF-1: a mismatched signature, attempt, epoch, actor, operation list or a busy queue leaves the row unresolved', () => {
  const pending = pendingFor(BC_OPS)
  const status = nativeStatus(pending)
  const variants = [
    ['signature', [{ ...pending, signature: operationSignature([SUPPLY]) }], ACTOR],
    ['attempt', [{ ...pending, attempt_id: 'req_other/batch_140' }], ACTOR],
    ['record epoch differs from the row', [{ ...pending, actor: { actor_id: 8, epoch: 2 } }], { actor_id: 8, epoch: 2 }],
    ['record actor differs from the row', [{ ...pending, actor: { actor_id: 9, epoch: 1 } }], { actor_id: 9, epoch: 1 }],
    ['live epoch differs from the record', [pending], { actor_id: 8, epoch: 2 }],
    ['live actor differs from the record', [pending], { actor_id: 9, epoch: 1 }],
    ['no live actor lineage', [pending], undefined],
    ['record operation list differs', [{ ...pending, operations: pending.operations.slice(0, 1) }], ACTOR],
    ['ordinal differs', [{ ...pending, ordinal: 141 }], ACTOR],
  ]
  for (const [label, records, actor] of variants) assert.equal(unresolvedNativeAdmissions(status, records, actor).length, 1, label)
  const busy = nativeStatus(pending, { status: { task_state: 'placing', queue_empty: false, queue_length: 1 } })
  assert.equal(unresolvedNativeAdmissions(busy, [pending], ACTOR).length, 1, 'a busy native queue')
})

// ---------------------------------------------------------------------------------------------------------------------------
// Repair iteration 2, R1-1: a settled completed prefix is fenced against replay while its placement recovery is open
// ---------------------------------------------------------------------------------------------------------------------------

const PLAN = 'plan_1'
const STEP = 'step_3'
const CORRECTED = { name: 'place_entity', args: { entity_name: 'lab', x: 45.5, y: 17.5 } }

const ledgerEvent = (state, event) => applyPlanningEvent(state, { type: PLANNING_EVENT.PENDING_OPERATION_RECORDED, source: 'runtime', goal_id: 'goal_1', now: 2, ...event })
const acceptGoal = () => applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, goal_id: 'goal_1', owner: 'Louis', objective: 'power the lab', now: 1 })
// The runtime's close sequence (settleOutstandingOperation): patch the pending record with its closure, then clear it.
function closeBatch(state, pending, patch) {
  let next = ledgerEvent(state, { operation: pending })
  if (patch) next = ledgerEvent(next, { operation: { ...pending, ...patch } })
  return ledgerEvent(next, { operation: null, operation_key: pending.operation_key })
}
function settledState({ id = 140, planId = PLAN, stepId = STEP, base = acceptGoal() } = {}) {
  const pending = pendingFor(BC_OPS, { id, planId, stepId })
  const result = reconcilePendingOperation(pending, { status: nativeStatus(pending), actor: ACTOR })
  const patch = settledPrefixPatch(pending, result)
  return { state: closeBatch(base, pending, patch), pending, result, patch }
}
const verdict = (state, operations, ids = {}) => conflictingOperation(state, { operations, planId: PLAN, stepId: STEP, ...ids })
const COMPLETED = { verdict: RECONCILE_VERDICT.ADMITTED_COMPLETED, reason: 'exact_receipts_completed' }
function completeBatch(state, operations, { id, stepId = STEP, planId = PLAN } = {}) {
  const pending = pendingFor(operations, { id, planId, stepId })
  return closeBatch(state, pending, completedPlacementPatch(pending, { ...COMPLETED, batch_id: id }))
}

test('R1-1: the derived settlement is persisted on the closed ledger record: partial_known, plan and step, per-slot canonical identities', () => {
  const { state, pending, patch } = settledState()
  assert.equal(state.operation_ledger.records.length, 0)
  const [closed] = state.operation_ledger.closed
  assert.equal(closed.operation_key, pending.operation_key)
  assert.equal(closed.effect, EFFECT.PARTIAL_KNOWN)
  assert.equal(closed.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(closed.plan_id, PLAN)
  assert.equal(closed.step_id, STEP)
  assert.equal(closed.signature, operationSignature(BC_OPS))
  assert.equal(closed.settlement.kind, 'completed_prefix_placement_refused')
  assert.equal(closed.settlement.refused_slot, 2)
  assert.deepEqual(closed.settlement.refusal_codes, ['placing:no_position'])
  assert.deepEqual(closed.settlement.completed, [{ slot: 1, operation: 'supply_entity', identity: operationSignature([SUPPLY]), delivery_keys: ['delivery|to_entity|25|coal'] }])
  assert.equal(closed.settlement.identity_complete, true)
  assert.deepEqual(patch.settlement.completed, closed.settlement.completed)
  // An empty prefix (placement first) has nothing to fence and no settlement.
  const first = pendingFor([PLACE_LAB, SUPPLY], { planId: PLAN, stepId: STEP })
  const firstResult = reconcilePendingOperation(first, { status: firstStatus(first), actor: ACTOR })
  assert.equal(firstResult.verdict, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION)
  assert.equal(settledPrefixPatch(first, firstResult), null)
})

test('R1-1: a repeated prefix with changed placement coordinates is refused, the identical full batch is refused, a placement-only reply is admitted', () => {
  const { state } = settledState()
  const repeated = verdict(state, [SUPPLY, CORRECTED])
  assert.equal(repeated.refuse, true)
  assert.equal(repeated.reason, 'settled_prefix_operation_replay')
  assert.equal(repeated.settled.completed_slot, 1)
  assert.equal(repeated.settled.replayed_operation, 'supply_entity')
  assert.equal(repeated.settled.match, 'identical_operation')
  assert.equal(repeated.settled.batch_ref, 'batch-g1-140')
  assert.equal(repeated.settled.only_placement_remains, true)
  assert.notEqual(operationSignature([SUPPLY, CORRECTED]), operationSignature(BC_OPS), 'the changed-coordinates batch has another whole-batch signature (the old fence cannot see it)')
  assert.equal(verdict(state, BC_OPS).refuse, true)
  assert.equal(verdict(state, BC_OPS).reason, 'settled_prefix_operation_replay')
  assert.equal(verdict(state, [CORRECTED, SUPPLY]).refuse, true, 'order does not matter')
  assert.equal(verdict(state, [CORRECTED]).refuse, false)
  assert.equal(verdict(state, [PLACE_LAB]).refuse, false)
  assert.equal(verdict(state, [{ name: 'place_candidate', args: { entity_name: 'lab', x: 1.5, y: 2.5, direction: 0 } }]).refuse, false)
})

test('R1-1: a partial delivery still fences the same delivery with another count; a different unit, item or direction is not blocked', () => {
  const { state } = settledState()
  const moreCoal = { name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'coal', count: 5 }] } }
  assert.equal(verdict(state, [moreCoal]).refuse, true)
  assert.equal(verdict(state, [moreCoal]).settled.match, 'same_delivery_target_and_item')
  const multi = { name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'iron-plate', count: 5 }, { item_name: 'coal', count: 3 }] } }
  assert.equal(verdict(state, [multi]).refuse, true)
  assert.equal(verdict(state, [{ name: 'move_items_exact', args: { unit_number: 25, item_name: 'coal', max_count: 4, to_entity: true } }]).refuse, true, 'another tool, same delivery')
  assert.equal(verdict(state, [{ name: 'supply_entity', args: { unit_number: 26, items: [{ item_name: 'coal', count: 20 }] } }]).refuse, false, 'another unit')
  assert.equal(verdict(state, [{ name: 'supply_entity', args: { unit_number: 25, items: [{ item_name: 'iron-plate', count: 20 }] } }]).refuse, false, 'another item')
  assert.equal(verdict(state, [{ name: 'move_items_exact', args: { unit_number: 25, item_name: 'coal', max_count: 4, to_entity: false } }]).refuse, false, 'taking coal out is another effect')
  assert.equal(verdict(state, [{ name: 'craft_item', args: { item_name: 'coal', count: 1 } }]).refuse, false)
})

test('R1-1: the fence closes when a later batch of the same step containing the placement completes, and only then', () => {
  const { state } = settledState()
  // A refused corrected placement, a completed batch without a placement, and a completed placement in another step do not close it.
  const refusedAgain = closeBatch(state, pendingFor([CORRECTED], { id: 141, planId: PLAN, stepId: STEP }), null)
  assert.equal(verdict(refusedAgain, [SUPPLY]).refuse, true)
  const gear = { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 2 } }
  assert.equal(completedPlacementPatch(pendingFor([gear], { id: 142, planId: PLAN, stepId: STEP }), COMPLETED), null)
  assert.equal(verdict(completeBatch(refusedAgain, [gear], { id: 142 }), [SUPPLY]).refuse, true)
  assert.equal(verdict(completeBatch(refusedAgain, [CORRECTED], { id: 143, stepId: 'step_4' }), [SUPPLY]).refuse, true, 'another step')
  assert.equal(verdict(completeBatch(refusedAgain, [CORRECTED], { id: 144, planId: 'plan_2' }), [SUPPLY]).refuse, true, 'another plan')
  assert.equal(completedPlacementPatch(pendingFor([CORRECTED], { id: 145 }), { verdict: RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION }), null)
  // The corrected placement (with another delivery in the same batch) completes: the fence is closed, ordinary operations resume.
  const done = completeBatch(refusedAgain, [CORRECTED, { name: 'supply_entity', args: { unit_number: 26, items: [{ item_name: 'coal', count: 3 }] } }], { id: 146 })
  assert.equal(openSettledFences(operationLedger(done.operation_ledger).closed, PLAN, STEP).length, 0)
  assert.equal(verdict(done, [SUPPLY]).refuse, false)
  assert.equal(verdict(done, [SUPPLY, CORRECTED]).refuse, false)
  // A completed placement that PRECEDES the settlement (an older batch) cannot pre-close it.
  const older = completeBatch(acceptGoal(), [CORRECTED], { id: 130 })
  const { state: later } = settledState({ id: 140, base: older })
  assert.equal(verdict(later, [SUPPLY]).refuse, true)
})

test('R1-1: a step or plan change lifts the fence; the same step keeps it however the placement changes', () => {
  const { state } = settledState()
  assert.equal(verdict(state, [SUPPLY], { stepId: 'step_4' }).refuse, false)
  assert.equal(verdict(state, [SUPPLY], { planId: 'plan_2' }).refuse, false)
  assert.equal(verdict(state, [SUPPLY], { planId: undefined, stepId: undefined }).refuse, false)
  for (const placement of [CORRECTED, { name: 'place_entity', args: { entity_name: 'lab', x: 1.5, y: 1.5 } }, { name: 'place_entity', args: { entity_name: 'steam-engine', x: 9.5, y: 9.5 } },
    { name: 'place_candidate', args: { entity_name: 'lab', x: 3.5, y: 3.5, direction: 4 } }]) {
    assert.equal(verdict(state, [SUPPLY, placement]).refuse, true)
  }
})

test('R1-1: the fence survives persistence (snapshot and restore) before and after it closes', () => {
  const { state } = settledState()
  const restored = restorePlanningState(serializePlanningState(state))
  assert.equal(restored.operation_ledger.closed[0].settlement.completed[0].identity, operationSignature([SUPPLY]))
  assert.equal(verdict(restored, [SUPPLY, CORRECTED]).refuse, true)
  assert.equal(verdict(restored, [CORRECTED]).refuse, false)
  assert.equal(verdict(restored, [SUPPLY], { stepId: 'step_4' }).refuse, false)
  const done = restorePlanningState(serializePlanningState(completeBatch(restored, [CORRECTED], { id: 141 })))
  assert.equal(verdict(done, [SUPPLY]).refuse, false)
  assert.equal(done.operation_ledger.closed.length, 2)
})

test('R1-1: an open fence is never pushed out of the closed window by later unrelated closes; a closed one is', () => {
  const { state } = settledState()
  const gear = index => ({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: index + 1 } })
  let ledger = operationLedger(state.operation_ledger)
  for (let index = 0; index < 80; index++) {
    const other = pendingFor([gear(index)], { id: 200 + index, planId: PLAN, stepId: 'step_9' })
    ledger = settleOperation(recordOperation(ledger, other), other.operation_key)
  }
  assert.ok(ledger.closed.length <= 64 + 8)
  assert.equal(ledger.closed.filter(record => record.settlement).length, 1)
  assert.equal(verdict({ ...state, operation_ledger: ledger }, [SUPPLY]).refuse, true)
  // Once the placement completed, the window may drop both.
  let closedLedger = operationLedger(completeBatch(state, [CORRECTED], { id: 141 }).operation_ledger)
  for (let index = 0; index < 80; index++) {
    const other = pendingFor([gear(index)], { id: 300 + index, planId: PLAN, stepId: 'step_9' })
    closedLedger = settleOperation(recordOperation(closedLedger, other), other.operation_key)
  }
  assert.equal(closedLedger.closed.length, 64)
  assert.equal(verdict({ ...state, operation_ledger: closedLedger }, [SUPPLY]).refuse, false)
  assert.ok(OPERATION_LEDGER_LIMIT >= 64)
})

test('R1-1: a pending record built before the identities existed cannot fence per slot (the whole-batch signature fence remains)', () => {
  const pending = pendingFor(BC_OPS, { planId: PLAN, stepId: STEP })
  const legacy = { ...pending, operations: pending.operations.map(({ identity, delivery_keys, ...rest }) => rest) }
  const result = reconcilePendingOperation(legacy, { status: nativeStatus(pending), actor: ACTOR })
  const patch = settledPrefixPatch(legacy, result)
  assert.equal(patch.settlement.identity_complete, false)
  const state = closeBatch(acceptGoal(), legacy, patch)
  assert.equal(verdict(state, BC_OPS).refuse, true, 'identical full batch still refused by the signature fence')
  assert.equal(verdict(state, [SUPPLY, CORRECTED]).refuse, false)
})

// ---------------------------------------------------------------------------------------------------------------------------
// R1-1 through the real agent loop: the scripted model reply repeats the completed prefix with corrected placement coordinates
// ---------------------------------------------------------------------------------------------------------------------------

const REPEATED_PREFIX = [SUPPLY_OP, { name: 'place_entity', args: { entity_name: 'lab', x: 45.5, y: 17.5 } }]

async function settleAndFail(world) {
  await world.agent.request('fuel the boiler and place a lab', { sender: 'Louis' })
  const reason = world.game.failLastBatch({ type: 'placing', code: 'no_position', entity_name: 'lab' }, undefined, { failedTaskIndex: 1 })
  world.markUncertain()
  await world.agent.failed(reason)
}
const planAndStep = world => {
  const plan = world.plan()
  return { planId: plan.plan_id, stepId: plan.steps[plan.active_step_index].step_id }
}

test('R1-1 loop: a reply that repeats the settled supply with corrected coordinates is refused before admission; only the placement is sent, and the fence closes when it completes', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [SUPPLY_OP, PLACE_LAB] : call === 2 ? REPEATED_PREFIX : [RETRY_PLACE]) })
  await settleAndFail(world)

  // The settled supply is in the durable closed record with its canonical identity, for this plan and step.
  const ids = planAndStep(world)
  const planning = world.memory.planningState(KEY)
  const fences = openSettledFences(planning.operation_ledger.closed, ids.planId, ids.stepId)
  assert.equal(fences.length, 1)
  assert.equal(fences[0].effect, EFFECT.PARTIAL_KNOWN)
  assert.equal(fences[0].settlement.completed[0].identity, operationSignature([SUPPLY_OP]))

  // The model repeated [supply, place(x, y)] (a different whole-batch signature): the harness refused it, with facts,
  // and the supply was NOT sent a second time. Only the later placement-only reply reached the game.
  assert.equal(world.prompts.length, 4)
  assert.equal(world.game.mutations.length, 2, 'the original batch and the placement-only retry; nothing in between')
  assert.doesNotMatch(world.game.mutations[1], /supply_entity/)
  assert.deepEqual(world.game.lastTaskTypes, ['placing'])
  const refusal = world.prompts.at(-1)
  assert.match(refusal, /Refused before admission: nothing from this batch ran/)
  assert.match(refusal, /Operation 1 \(supply_entity\) already completed in an earlier batch of this step \(batch-g1-1;/)
  assert.match(refusal, /1\. supply_entity/)
  assert.match(refusal, /only the placement remains/)
  assert.match(refusal, /"only_placement_remains":true/)
  const recoverable = world.trace.filter(record => record.event === 'operations.preflight_recoverable' && record.data.failure_class === 'duplicate_effect_suppressed')
  assert.equal(recoverable.length, 1, 'counted once under the existing bounded duplicate-effect budget')
  assert.equal(recoverable[0].data.preflight.reason, 'settled_prefix_operation_replay')
  assert.equal(recoverable[0].data.retry_budget, 1)
  assert.equal(world.memory.currentPlan(KEY).status, 'active')

  // While the placement recovery is open, even the identical delivery is fenced; once the corrected placement's receipt is
  // settled as completed the fence is closed and ordinary operations resume.
  assert.equal(conflictingOperation(world.memory.planningState(KEY), { operations: [SUPPLY_OP], ...ids }).refuse, true)
  await world.agent.settleOutstandingOperation(await world.agent.readTaskStatusRaw())
  assert.equal(world.memory.pendingOperations(KEY).length, 0)
  const after = world.memory.planningState(KEY)
  assert.equal(openSettledFences(after.operation_ledger.closed, ids.planId, ids.stepId).length, 0)
  assert.equal(conflictingOperation(after, { operations: [SUPPLY_OP], ...ids }).refuse, false)
  assert.equal(conflictingOperation(after, { operations: [SUPPLY_OP], ...ids, stepId: 'other_step' }).refuse, false)
})

test('R1-1 loop: the refusal is bounded; a model that keeps repeating the prefix ends in the existing classified stop, with no second supply sent', async () => {
  const world = loopWorld({ operationsFor: call => (call === 1 ? [SUPPLY_OP, PLACE_LAB] : REPEATED_PREFIX) })
  await settleAndFail(world)
  assert.equal(world.game.mutations.length, 1, 'the repeated supply never reached the game')
  assert.equal(world.trace.filter(record => record.event === 'operations.preflight_recoverable' && record.data.failure_class === 'duplicate_effect_suppressed').length, 1)
  // The second identical refusal is not retried again: one extra model call, then the existing classified, visible stop.
  assert.equal(world.prompts.length, 4, 'observe, plan, the repeated prefix, the repeated prefix again')
  const state = world.memory.currentPlan(KEY)
  assert.equal(state.status, 'blocked')
  assert.equal(state.blocker, 'operation_preflight_failed:duplicate_effect_suppressed')
  assert.ok(world.trace.some(record => record.event === 'operations.blocked_end_classified'))
  assert.ok(world.trace.some(record => record.event === 'goal.paused'))
})
