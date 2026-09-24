import test from 'node:test'
import assert from 'node:assert/strict'

import { steeringRecommendationQuestions } from './jev-decision-taxonomy.mjs'

import {
  applyPlanningEvent,
  createEmptyPlanningState,
  DEADLOCK_EVIDENCE_STALL_BATCHES,
  DEADLOCK_REPEATED_FAILURE_LIMIT,
  DEADLOCK_SIGNAL_KIND,
  evaluateDeadlockSignals,
  getActivePlan,
  getActiveStep,
  getPlan,
  lineageOf,
  PLAN_STATUS,
  PLANNING_EVENT,
  planTrackerView,
  PROSE_ONLY_STEP_OPERATION_CEILING,
  restorePlanningState,
  sanitizeShelfNode,
  SHELF_FORBIDDEN_EXECUTABLE_FIELDS,
  SHELF_REFINEMENT_MAX_FANOUT,
  shelfNodeReadiness,
  shelfRefinementCandidates,
  nearestShelfRefinementTarget,
  evaluateSteeringTransition,
  isSafeSteeringBoundary,
  STEERING_BOUNDARY,
  STEERING_HOLD_REASON,
  STEERING_HYSTERESIS,
  STEERING_PRESSURE_EVIDENCE,
  STEERING_PRESSURE_VOCABULARY,
  askableSteeringPressures,
  steeringContextForDraft,
  steeringRecord,
  serializePlanningState,
  SHELF_NODE_STATUS,
  MAX_RETAINED_PLANS,
} from './planning-state.mjs'

// --- fixtures ---------------------------------------------------------------

const GROUNDED_CONTRACT = {
  mode: 'all',
  requirements: [
    { id: 'req_stone', kind: 'inventory_count', item_name: 'stone', minimum: 10 },
  ],
  confidence: 0.9,
}

const ANY_CONTRACT = {
  mode: 'any',
  requirements: [
    { id: 'req_furnace', kind: 'entity_exists', unit_number: 582 },
    { id: 'req_receipt', kind: 'authoritative_operation_receipt', operation_name: 'place_entity' },
  ],
  confidence: 0.6,
}

function goalState(now = 1000) {
  return applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now,
    owner: 'louis',
    objective: 'Build toward a rocket-capable factory',
    constraints: ['do not remove player buildings'],
  })
}

function shelved(state, now = 1100) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now,
    reason: 'initial shelf',
    nodes: [
      { id: 'roadmap_early_smelting', intent: 'establish reliable early iron and copper smelting', status: 'ready_to_refine' },
      { id: 'roadmap_automation', intent: 'automation and red science', development_hint: 'vertical' },
    ],
  })
}

function drafted(state, { now = 1200, steps, nodeIds = ['roadmap_early_smelting'] } = {}) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now,
    development_mode: 'vertical',
    roadmap_node_ids: nodeIds,
    steps: steps ?? [
      { description: 'Acquire enough stone for two furnaces', completion_contract: GROUNDED_CONTRACT },
      { description: 'Establish the first iron smelting furnace', completion_contract: ANY_CONTRACT },
    ],
  })
}

function committed(state, { now = 1300 } = {}) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now,
    runtime_validation: { passed: true },
  })
}

function committedFixture(options = {}) {
  return committed(drafted(shelved(goalState()), options), options)
}

function runtimeEvidence(state, { ref, requirementIds, now = 1400, stepId }) {
  const plan = getActivePlan(state)
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now,
    plan_id: plan.plan_id,
    step_id: stepId ?? plan.steps[plan.active_step_index].step_id,
    evidence: {
      source: 'runtime',
      kind: 'deterministic_verification',
      ref,
      batch_id: 7,
      satisfied_requirement_ids: requirementIds ?? [],
    },
  })
}

function completeActiveStep(state, { now = 1500 } = {}) {
  const plan = getActivePlan(state)
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_COMPLETED,
    now,
    source: 'runtime',
    plan_id: plan.plan_id,
    step_id: plan.steps[plan.active_step_index].step_id,
  })
}

// --- data model -------------------------------------------------------------

test('GOAL_ACCEPTED creates a durable versioned goal with explicit constraints', () => {
  const state = goalState()
  assert.equal(state.goal.owner, 'louis')
  assert.equal(state.goal.status, 'active')
  assert.deepEqual(state.goal.constraints, ['do not remove player buildings'])
  assert.equal(state.goal.created_at, 1000)
  assert.equal(state.goal.updated_at, 1000)
  assert.ok(state.goal.goal_id)
  assert.equal(state.plans.length, 0)
})

test('roadmap shelf stores nodes with lineage and preserves dropped nodes as invalidated', () => {
  const first = shelved(goalState())
  assert.equal(first.roadmap.revision_index, 1)
  assert.equal(first.roadmap.derived_from_revision_id, null)
  assert.equal(first.roadmap.nodes.length, 2)

  const second = applyPlanningEvent(first, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1150,
    reason: 'oil found, automation deferred',
    nodes: [{ id: 'roadmap_early_smelting', intent: 'establish reliable early iron and copper smelting', status: 'ready_to_refine' }],
  })
  assert.equal(second.roadmap.revision_index, 2)
  assert.equal(second.roadmap.derived_from_revision_id, first.roadmap.roadmap_revision_id)
  const dropped = second.roadmap.nodes.find(node => node.id === 'roadmap_automation')
  assert.equal(dropped.status, SHELF_NODE_STATUS.INVALIDATED)
  assert.equal(dropped.revision_reason, 'oil found, automation deferred')
  assert.equal(second.roadmap_history[0].roadmap_revision_id, first.roadmap.roadmap_revision_id)
})

test('reasoning epochs reset only on durable reasoning-boundary transitions and survive restore', () => {
  let state = goalState(1000)
  assert.equal(state.reasoning_epoch, 1)
  assert.deepEqual(state.last_reasoning_reset, {
    epoch: 1,
    at: 1000,
    event_type: PLANNING_EVENT.GOAL_ACCEPTED,
    reason: 'new_goal',
  })

  state = shelved(state, 1100)
  assert.equal(state.reasoning_epoch, 2)
  assert.equal(state.last_reasoning_reset.event_type, PLANNING_EVENT.ROADMAP_REVISED)

  const draft = drafted(state, { now: 1200 })
  assert.equal(draft.reasoning_epoch, 2, 'creating an ordinary draft must not discard fresh reasoning')

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(draft))))
  assert.equal(restored.reasoning_epoch, 2)
  assert.deepEqual(restored.last_reasoning_reset, draft.last_reasoning_reset)

  const nextGoal = applyPlanningEvent(restored, {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now: 1300,
    owner: 'louis',
    objective: 'Build a second furnace',
  })
  assert.equal(nextGoal.reasoning_epoch, 3, 'a replacement goal invalidates accumulated reasoning')
  assert.equal(nextGoal.last_reasoning_reset.reason, 'new_goal')
})

test('continuous capability frontiers advance deterministically but never latch or complete the goal', () => {
  let state = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1100,
    reason: 'introduce sustained iron frontier',
    nodes: [{
      id: 'roadmap_sustained_iron',
      intent: 'Maintain sustained iron plate output',
      status: 'ready_to_refine',
      capability_frontier: {
        id: 'frontier_sustained_iron',
        intent: 'Sustain iron plate output beyond a one-off checkpoint.',
        continuous: true,
        recognition: [
          { id: 'throughput', description: 'Measured throughput meets the target.' },
          { id: 'stability', description: 'Output remains stable across the sample.' },
        ],
      },
    }],
  })
  state = drafted(state, {
    now: 1200,
    nodeIds: ['roadmap_sustained_iron'],
    steps: [{ description: 'Measure sustained iron output', completion_contract: GROUNDED_CONTRACT }],
  })
  state = committed(state, { now: 1300 })
  state = runtimeEvidence(state, { ref: 'batch_1', requirementIds: ['req_stone'], now: 1400 })
  state = completeActiveStep(state, { now: 1500 })
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLAN_COMPLETED,
    now: 1600,
    source: 'runtime',
    plan_id: plan.plan_id,
    verified_results: ['60 iron plates per minute for one minute'],
    satisfied_recognition_ids: ['stability', 'throughput', 'unknown_fabricated_id'],
  })

  const frontier = state.roadmap.nodes[0].capability_frontier
  assert.equal(frontier.continuous, true)
  assert.equal(frontier.status, 'partially_reached')
  assert.deepEqual(frontier.satisfied_recognition_ids, ['stability', 'throughput'])
  assert.equal(frontier.reached_at, null)
  assert.equal(state.goal.status, 'active')

  const restored = restorePlanningState(serializePlanningState(state))
  assert.deepEqual(restored.roadmap.nodes[0].capability_frontier, frontier)
})

test('shelf nodes are non-executable: no operations survive sanitization', () => {
  const node = sanitizeShelfNode({
    id: 'n1',
    intent: 'place furnaces',
    operations: [{ name: 'place_entity', args: { x: 1 } }],
    completion_contract: GROUNDED_CONTRACT,
    steps: ['do the thing'],
    development_hint: 'horizontal',
  })
  assert.equal(node.development_hint, 'horizontal')
  assert.equal(node.operations, undefined)
  assert.equal(node.completion_contract, undefined)
  assert.equal(node.steps, undefined)
})

test('the module exposes no API that turns a shelf node into operations or steps', async () => {
  const api = await import('./planning-state.mjs')
  const forbidden = Object.keys(api).filter(name => /executeShelf|shelfToSteps|shelfToPlan|realizeShelf|operationsFrom/i.test(name))
  assert.deepEqual(forbidden, [])
})

test('step ids are stable and not merely positional', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const [first, second] = plan.steps
  assert.notEqual(first.step_id, second.step_id)
  assert.ok(first.step_id.startsWith(plan.plan_id))
  // The id embeds a content fingerprint, so a different plan slice with the same
  // ordinal never reuses the same step id.
  const other = committed(drafted(shelved(goalState(9000)), {
    now: 9200,
    steps: [{ description: 'Acquire enough stone for two furnaces', completion_contract: GROUNDED_CONTRACT }],
  }), { now: 9300 })
  assert.notEqual(getActivePlan(other).steps[0].step_id, first.step_id)
  assert.equal(first.step_id.includes('step_1'), false)
})

test('completion contracts are optional; prose-only steps are flagged reduced confidence', () => {
  const state = committedFixture({
    steps: [
      { description: 'Acquire enough stone', completion_contract: GROUNDED_CONTRACT },
      { description: 'Scout a good smelting location' },
      { description: 'Something with a garbage contract', completion_contract: { mode: 'nonsense', requirements: [] } },
    ],
  })
  const [grounded, prose, garbage] = getActivePlan(state).steps
  assert.equal(grounded.reduced_confidence, false)
  assert.equal(grounded.completion_confidence, 'grounded')
  assert.deepEqual(grounded.completion_contract.requirements[0].item_name, 'stone')
  assert.equal(prose.completion_contract, null)
  assert.equal(prose.reduced_confidence, true)
  assert.equal(prose.completion_confidence, 'reduced')
  // An unsupported contract degrades to prose-only rather than blocking commit.
  assert.equal(garbage.completion_contract, null)
  assert.equal(garbage.reduced_confidence, true)
})

test('all six grounded predicate kinds are accepted in committed contracts', () => {
  const kinds = [
    { id: 'a', kind: 'inventory_count', item_name: 'stone', minimum: 10 },
    { id: 'b', kind: 'entity_inventory_count', unit_number: 582, item_name: 'coal', minimum: 5 },
    { id: 'c', kind: 'entity_exists', unit_number: 582 },
    { id: 'd', kind: 'entity_state', unit_number: 582, expected: 'working' },
    { id: 'e', kind: 'authoritative_operation_receipt', operation_name: 'place_entity' },
    { id: 'f', kind: 'runtime_controller_state', controller: 'autorio', expected: 'active' },
  ]
  const state = committedFixture({
    steps: [{ description: 'everything at once', completion_contract: { mode: 'all', requirements: kinds, confidence: 1 } }],
  })
  const contract = getActivePlan(state).steps[0].completion_contract
  assert.equal(contract.requirements.length, 6)
  assert.deepEqual(contract.requirements.map(item => item.kind), kinds.map(item => item.kind))
})

// --- lifecycle & commit gate -------------------------------------------------

test('lifecycle reaches COMMITTED when deterministic runtime validation passes', () => {
  const draft = drafted(shelved(goalState()))
  assert.equal(getActivePlan(draft).status, PLAN_STATUS.DRAFT)

  const noValidation = applyPlanningEvent(draft, {
    type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: false },
  })
  assert.equal(getActivePlan(noValidation).status, PLAN_STATUS.DRAFT)

  const ok = committed(draft)
  assert.equal(getActivePlan(ok).status, PLAN_STATUS.COMMITTED)
  assert.equal(getActivePlan(ok).committed_at, 1300)
})

test('commit needs no user approval in the normal path', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  assert.equal(plan.status, PLAN_STATUS.COMMITTED)
  assert.equal(plan.origin, 'main_llm_draft')
  assert.equal(plan.lifecycle.at(-1).reason, 'auto_commit_runtime_validated')
  // Nothing in the log records a user approval for this transition.
  assert.equal(state.log.some(entry => entry.type === PLANNING_EVENT.USER_REVISION_APPROVED), false)
})

// --- immutability of committed content ---------------------------------------

test('committed steps cannot be mutated by a caller (frozen, not merely cloned)', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  assert.ok(Object.isFrozen(plan.steps))
  assert.ok(Object.isFrozen(plan.steps[0]))
  assert.ok(Object.isFrozen(plan.steps[0].completion_contract))
  assert.throws(() => { plan.steps[0].description = 'hijacked' }, TypeError)
  assert.throws(() => { plan.steps.push({ description: 'extra step' }) }, TypeError)
  assert.throws(() => { plan.steps.reverse() }, TypeError)
  assert.throws(() => { plan.steps[0].completion_contract.requirements[0].minimum = 1 }, TypeError)
  assert.throws(() => { plan.steps[0].completion_contract.requirements.pop() }, TypeError)
  assert.equal(plan.steps[0].description, 'Acquire enough stone for two furnaces')
  assert.equal(plan.steps.length, 2)
})

test('ordering and completion meaning survive continued execution events', () => {
  let state = committedFixture()
  const before = serializePlanningState(state).plans[0].steps
  state = runtimeEvidence(state, { ref: 'batch_7', requirementIds: ['req_stone'] })
  state = completeActiveStep(state)
  state = runtimeEvidence(state, { ref: 'batch_8', requirementIds: ['req_furnace'], now: 1600 })
  const after = serializePlanningState(state).plans[0].steps
  assert.deepEqual(after, before)
})

test('planner focus is advisory and cannot advance the tracker', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLANNER_FOCUS_PROPOSED,
    now: 1400,
    plan_id: plan.plan_id,
    step_id: plan.steps[1].step_id,
    source: 'main_llm',
  })
  const view = planTrackerView(state)
  assert.equal(view.active_step_index, 0)
  assert.equal(view.active_step_id, plan.steps[0].step_id)
  assert.equal(view.advisory_planner_focus_step_id, plan.steps[1].step_id)
  assert.deepEqual(view.verified_completed_step_ids, [])
})

test('planner-sourced evidence and completion are rejected', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const stepId = plan.steps[0].step_id
  const withPlannerEvidence = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: 1400,
    plan_id: plan.plan_id,
    step_id: stepId,
    evidence: { source: 'main_llm', kind: 'model_claim', ref: 'llm_1', satisfied_requirement_ids: ['req_stone'] },
  })
  assert.equal(withPlannerEvidence, state)

  const plannerCompletion = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_COMPLETED, now: 1400, source: 'main_llm', plan_id: plan.plan_id, step_id: stepId,
  })
  assert.equal(plannerCompletion, state)
})

test('jev output cannot advance the tracker', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const stepId = plan.steps[0].step_id
  for (const event of [
    { type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED, now: 1400, plan_id: plan.plan_id, step_id: stepId, evidence: { source: 'jev', kind: 'jev_advisory_claim', ref: 'jev_1', satisfied_requirement_ids: ['req_stone'] } },
    { type: PLANNING_EVENT.STEP_COMPLETED, now: 1401, source: 'jev', plan_id: plan.plan_id, step_id: stepId },
    { type: PLANNING_EVENT.PLAN_COMPLETED, now: 1402, source: 'jev', plan_id: plan.plan_id },
    { type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 1403, source: 'jev', plan_id: plan.plan_id, reason_code: 'jev_says_so' },
    { type: PLANNING_EVENT.PLAN_SUPERSEDED, now: 1404, source: 'jev', plan_id: plan.plan_id },
    { type: PLANNING_EVENT.PLAN_CANCELLED, now: 1405, source: 'jev', plan_id: plan.plan_id },
  ]) {
    assert.equal(applyPlanningEvent(state, event), state, `jev must not be able to apply ${event.type}`)
  }
})

test('runtime evidence for a non-active step does not advance the tracker', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const skipAhead = runtimeEvidence(state, {
    ref: 'batch_9', requirementIds: ['req_furnace'], stepId: plan.steps[1].step_id,
  })
  assert.equal(skipAhead, state)
})

test('only evidence satisfying the committed contract completes a grounded step', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  // Accepted runtime evidence that does not satisfy the contract.
  state = runtimeEvidence(state, { ref: 'batch_1', requirementIds: ['unrelated_req'] })
  assert.equal(getActivePlan(state).execution.step_progress[plan.steps[0].step_id].contract_satisfied, false)
  const premature = completeActiveStep(state)
  assert.equal(premature, state)

  state = runtimeEvidence(state, { ref: 'batch_2', requirementIds: ['req_stone'], now: 1450 })
  assert.equal(getActivePlan(state).execution.step_progress[plan.steps[0].step_id].contract_satisfied, true)
  state = completeActiveStep(state)
  assert.equal(getActivePlan(state).active_step_index, 1)
  assert.deepEqual(planTrackerView(state).verified_completed_step_ids, [plan.steps[0].step_id])
})

test('an any-mode contract is satisfied by one matching requirement', () => {
  let state = committedFixture()
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  state = completeActiveStep(state)
  state = runtimeEvidence(state, { ref: 'b2', requirementIds: ['req_receipt'], now: 1600 })
  const plan = getActivePlan(state)
  assert.equal(plan.execution.step_progress[plan.steps[1].step_id].contract_satisfied, true)
})

test('a prose-only step needs accepted runtime evidence before it may advance', () => {
  let state = committedFixture({ steps: [{ description: 'Scout a smelting location' }, { description: 'Second thing' }] })
  const plan = getActivePlan(state)
  assert.equal(completeActiveStep(state), state)
  state = runtimeEvidence(state, { ref: 'batch_scout' })
  state = completeActiveStep(state)
  assert.equal(getActivePlan(state).active_step_index, 1)
  assert.deepEqual(planTrackerView(state).verified_completed_step_ids, [plan.steps[0].step_id])
})

test('first accepted evidence moves COMMITTED to EXECUTING', () => {
  const state = runtimeEvidence(committedFixture(), { ref: 'batch_x', requirementIds: [] })
  assert.equal(getActivePlan(state).status, PLAN_STATUS.EXECUTING)
})

test('PLAN_COMPLETED requires every step complete and attaches results to shelf lineage', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  const early = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMPLETED, now: 1500, source: 'runtime', plan_id: plan.plan_id })
  assert.equal(early, state)

  state = completeActiveStep(state)
  state = runtimeEvidence(state, { ref: 'b2', requirementIds: ['req_furnace'], now: 1600 })
  state = completeActiveStep(state, { now: 1700 })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLAN_COMPLETED, now: 1800, source: 'runtime', plan_id: plan.plan_id,
    verified_results: ['two stone furnaces smelting iron'],
  })
  assert.equal(getActivePlan(state).status, PLAN_STATUS.COMPLETED)
  const node = state.roadmap.nodes.find(item => item.id === 'roadmap_early_smelting')
  assert.equal(node.status, SHELF_NODE_STATUS.REALIZED)
  assert.deepEqual(node.resolved_by, [plan.plan_id])
  assert.deepEqual(node.verified_results, ['two stone furnaces smelting iron'])
})

// --- deadlock detection -------------------------------------------------------

test('evidence stall signal fires after the configured batch count', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  for (let index = 0; index < DEADLOCK_EVIDENCE_STALL_BATCHES - 1; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1400 + index, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
    })
  }
  assert.equal(evaluateDeadlockSignals(state).deadlocked, false)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1500, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
  })
  const result = evaluateDeadlockSignals(state)
  assert.equal(result.deadlocked, true)
  assert.deepEqual(result.signals.map(signal => signal.kind), [DEADLOCK_SIGNAL_KIND.EVIDENCE_STALL])
  assert.equal(result.step_id, plan.steps[0].step_id)
})

test('accepted evidence resets the evidence stall counter', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  for (let index = 0; index < DEADLOCK_EVIDENCE_STALL_BATCHES; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1400 + index, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
    })
  }
  assert.equal(evaluateDeadlockSignals(state).deadlocked, true)
  state = runtimeEvidence(state, { ref: 'batch_fresh', requirementIds: [], now: 1600 })
  assert.equal(evaluateDeadlockSignals(state).deadlocked, false)
})

test('repeating failure signal fires on the same reason code K times', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  for (let index = 0; index < DEADLOCK_REPEATED_FAILURE_LIMIT; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED,
      now: 1400 + index,
      plan_id: plan.plan_id,
      step_id: plan.steps[0].step_id,
      failure_reason_code: 'path_blocked',
    })
  }
  const signals = evaluateDeadlockSignals(state).signals
  const repeating = signals.find(signal => signal.kind === DEADLOCK_SIGNAL_KIND.REPEATING_FAILURE)
  assert.ok(repeating)
  assert.equal(repeating.reason_code, 'path_blocked')
})

test('distinct failure codes do not trip the repeating failure signal', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  const codes = ['path_blocked', 'out_of_range', 'inventory_full']
  codes.forEach((code, index) => {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED,
      now: 1400 + index,
      plan_id: plan.plan_id,
      step_id: plan.steps[0].step_id,
      failure_reason_code: code,
    })
  })
  assert.equal(evaluateDeadlockSignals(state).signals.some(signal => signal.kind === DEADLOCK_SIGNAL_KIND.REPEATING_FAILURE), false)
})

test('a provably unsatisfiable contract is a deadlock signal, and only runtime may assert it', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const jevAttempt = applyPlanningEvent(state, {
    type: PLANNING_EVENT.CONTRACT_PROVEN_UNSATISFIABLE,
    now: 1400, source: 'jev', plan_id: plan.plan_id, step_id: plan.steps[0].step_id, reason: 'jev thinks so',
  })
  assert.equal(jevAttempt, state)

  const proven = applyPlanningEvent(state, {
    type: PLANNING_EVENT.CONTRACT_PROVEN_UNSATISFIABLE,
    now: 1400,
    source: 'runtime',
    plan_id: plan.plan_id,
    step_id: plan.steps[0].step_id,
    reason: 'stone does not exist in this mod configuration',
    proof_ref: 'prototype_cache',
  })
  const signal = evaluateDeadlockSignals(proven).signals.find(item => item.kind === DEADLOCK_SIGNAL_KIND.UNSATISFIABLE_CONTRACT)
  assert.ok(signal)
  assert.equal(signal.proof_ref, 'prototype_cache')
})

test('prose-only steps are invisible to stall and unsatisfiability but hit the operation ceiling', () => {
  let state = committedFixture({ steps: [{ description: 'Wander around productively' }] })
  const plan = getActivePlan(state)
  const stepId = plan.steps[0].step_id
  for (let index = 0; index < PROSE_ONLY_STEP_OPERATION_CEILING - 1; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1400 + index, plan_id: plan.plan_id, step_id: stepId,
    })
  }
  // Well past the evidence-stall threshold, but that signal needs a contract.
  assert.ok(PROSE_ONLY_STEP_OPERATION_CEILING - 1 > DEADLOCK_EVIDENCE_STALL_BATCHES)
  assert.deepEqual(evaluateDeadlockSignals(state).signals, [])

  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1600, plan_id: plan.plan_id, step_id: stepId,
  })
  const signals = evaluateDeadlockSignals(state).signals
  assert.deepEqual(signals.map(signal => signal.kind), [DEADLOCK_SIGNAL_KIND.PROSE_ONLY_CEILING])
})

test('prose-only steps remain visible to the repeating failure signal', () => {
  let state = committedFixture({ steps: [{ description: 'Wander around productively' }] })
  const plan = getActivePlan(state)
  for (let index = 0; index < DEADLOCK_REPEATED_FAILURE_LIMIT; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED,
      now: 1400 + index,
      plan_id: plan.plan_id,
      step_id: plan.steps[0].step_id,
      failure_reason_code: 'nothing_to_do',
    })
  }
  assert.ok(evaluateDeadlockSignals(state).signals.some(signal => signal.kind === DEADLOCK_SIGNAL_KIND.REPEATING_FAILURE))
})

test('deadlock evaluation is deterministic and configurable', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1400, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
  })
  assert.equal(evaluateDeadlockSignals(state).deadlocked, false)
  assert.equal(evaluateDeadlockSignals(state, { limits: { evidenceStallBatches: 1 } }).deadlocked, true)
  assert.deepEqual(evaluateDeadlockSignals(state), evaluateDeadlockSignals(state))
})

test('a future semantic signal can be added through the evaluator seam without restructuring', () => {
  const state = committedFixture()
  const result = evaluateDeadlockSignals(state, {
    extraEvaluators: [{
      id: 'semantic_deadlock_placeholder',
      evaluate: ({ step }) => ({ kind: 'semantic_deadlock', step_id: step.step_id, detail: 'hypothetical jev signal' }),
    }],
  })
  assert.equal(result.deadlocked, true)
  assert.equal(result.signals[0].kind, 'semantic_deadlock')
  // A throwing evaluator cannot break deterministic evaluation.
  const safe = evaluateDeadlockSignals(state, { extraEvaluators: [{ id: 'bad', evaluate: () => { throw new Error('boom') } }] })
  assert.equal(safe.deadlocked, false)
})

// --- blockers freeze, they do not replan ---------------------------------------

test('DEADLOCK_DETECTED freezes the plan as BLOCKED and never replans', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  const signals = evaluateDeadlockSignals(state, { limits: { evidenceStallBatches: 0 } }).signals
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DEADLOCK_DETECTED, now: 1600, plan_id: plan.plan_id, reason_code: 'evidence_stall', signals,
  })
  const blocked = getActivePlan(state)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker.kind, 'deadlock')
  assert.equal(blocked.blocker.requires_user_decision, true)
  assert.equal(state.plans.length, 1, 'no successor plan may be produced automatically')
  assert.equal(blocked.superseded_by_plan_id, null)
  assert.deepEqual(blocked.steps.map(step => step.description), plan.steps.map(step => step.description))
  // Execution events are inert once blocked.
  assert.equal(runtimeEvidence(state, { ref: 'after_block', requirementIds: ['req_stone'], now: 1700 }), state)
  assert.equal(completeActiveStep(state, { now: 1701 }), state)
})

test('STRUCTURAL_BLOCKER_CONFIRMED freezes the immutable plan with evidence', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 1600,
    source: 'runtime',
    plan_id: plan.plan_id,
    reason_code: 'resource_not_in_scope',
    evidence_refs: ['batch_11'],
    detail: 'no stone within the allowed search radius',
  })
  const blocked = getActivePlan(state)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.deepEqual(blocked.blocker.evidence_refs, ['batch_11'])
  assert.ok(Object.isFrozen(blocked.steps))
  assert.equal(state.plans.length, 1)
})


test('BLOCKED_CHOICE_RECORDED persists explicit user choice without thawing or replanning', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 1600,
    source: 'runtime',
    plan_id: plan.plan_id,
    reason_code: 'resource_not_in_scope',
    evidence_refs: ['batch_11'],
  })

  const ignored = applyPlanningEvent(state, {
    type: PLANNING_EVENT.BLOCKED_CHOICE_RECORDED,
    now: 1650,
    source: 'main_llm',
    approved_by: 'louis',
    choice: 'revise',
  })
  assert.equal(ignored, state, 'only explicit user authority may record a blocked choice')

  const recorded = applyPlanningEvent(state, {
    type: PLANNING_EVENT.BLOCKED_CHOICE_RECORDED,
    now: 1700,
    source: 'user',
    approved_by: 'louis',
    choice: 'revise',
  })
  const blocked = getActivePlan(recorded)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker.user_choice.choice, 'revise')
  assert.equal(blocked.blocker.user_choice.approved_by, 'louis')
  assert.equal(blocked.blocker.user_choice.at, 1700)
  assert.equal(recorded.plans.length, 1, 'recording revise must not create a successor plan')
  assert.equal(blocked.superseded_by_plan_id, null)
  assert.deepEqual(blocked.steps.map(step => step.description), plan.steps.map(step => step.description))
})

// --- successor plans ------------------------------------------------------------

test('only USER_REVISION_APPROVED produces plan_version + 1 with lineage', () => {
  let state = committedFixture()
  const predecessor = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 1600, source: 'runtime', plan_id: predecessor.plan_id, reason_code: 'blocked',
  })

  // Neither Jev nor the planner can produce the successor.
  for (const source of ['jev', 'main_llm', 'runtime', undefined]) {
    const attempt = applyPlanningEvent(state, {
      type: PLANNING_EVENT.USER_REVISION_APPROVED,
      now: 1700,
      source,
      approved_by: 'louis',
      plan_id: predecessor.plan_id,
      steps: [{ description: 'Buy stone from a different patch' }],
    })
    assert.equal(attempt, state, `source ${source} must not produce a successor`)
  }
  // Even user authority needs an explicit approver identity.
  assert.equal(applyPlanningEvent(state, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 1700, source: 'user', plan_id: predecessor.plan_id,
    steps: [{ description: 'x' }],
  }), state)

  const revised = applyPlanningEvent(state, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED,
    now: 1700,
    source: 'user',
    approved_by: 'louis',
    plan_id: predecessor.plan_id,
    steps: [{ description: 'Mine a different stone patch', completion_contract: GROUNDED_CONTRACT }],
  })
  const successor = getActivePlan(revised)
  assert.equal(successor.plan_version, predecessor.plan_version + 1)
  assert.equal(successor.derived_from_plan_id, predecessor.plan_id)
  assert.equal(successor.status, PLAN_STATUS.DRAFT)
  assert.notEqual(successor.plan_id, predecessor.plan_id)

  const preserved = getPlan(revised, predecessor.plan_id)
  assert.equal(preserved.status, PLAN_STATUS.BLOCKED, 'the blocked predecessor is preserved, not edited in place')
  assert.equal(preserved.superseded_by_plan_id, successor.plan_id)
  assert.deepEqual(preserved.steps.map(step => step.description), predecessor.steps.map(step => step.description))
})

test('pre-commit draft replacement preserves user-approved successor lineage', () => {
  let state = committedFixture()
  const predecessor = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 1600,
    source: 'runtime',
    plan_id: predecessor.plan_id,
    reason_code: 'blocked',
  })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED,
    now: 1700,
    source: 'user',
    approved_by: 'louis',
    plan_id: predecessor.plan_id,
    steps: [{ description: 'Mine a different stone patch' }],
  })
  const approved = getActivePlan(state)
  assert.equal(approved.plan_version, predecessor.plan_version + 1)
  assert.equal(approved.derived_from_plan_id, predecessor.plan_id)

  const refreshed = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1750,
    origin: 'checkpoint_contract_refresh',
    roadmap_node_ids: approved.roadmap_node_ids,
    development_mode: approved.development_mode,
    steps: [{ description: 'Mine a different stone patch', completion_contract: GROUNDED_CONTRACT }],
  })
  const replacement = getActivePlan(refreshed)

  // A contract refresh edits the unreviewed draft in place: same identity, no
  // throwaway superseded record, lineage untouched.
  assert.equal(replacement.plan_id, approved.plan_id)
  assert.equal(refreshed.plans.length, state.plans.length)
  assert.equal(replacement.plan_version, approved.plan_version)
  assert.equal(replacement.derived_from_plan_id, predecessor.plan_id)
  assert.deepEqual(replacement.carried_forward_evidence, approved.carried_forward_evidence)
  assert.ok(replacement.steps[0].completion_contract)
})

test('a user revision carries forward verified completed work as evidence references', () => {
  let state = committedFixture()
  const predecessor = getActivePlan(state)
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  state = completeActiveStep(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 1600, source: 'runtime', plan_id: predecessor.plan_id, reason_code: 'blocked',
  })
  const revised = applyPlanningEvent(state, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED,
    now: 1700, source: 'user', approved_by: 'louis', plan_id: predecessor.plan_id,
    steps: [{ description: 'Place the furnace somewhere else' }],
  })
  assert.deepEqual(getActivePlan(revised).carried_forward_evidence, [`${predecessor.plan_id}:${predecessor.steps[0].step_id}`])
})

test('explicit user steering may supersede an executing plan at any time', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  assert.equal(getActivePlan(state).status, PLAN_STATUS.EXECUTING)
  const steered = applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLAN_SUPERSEDED, now: 1600, source: 'user_steering', plan_id: plan.plan_id, reason: 'user changed priority',
  })
  const superseded = getPlan(steered, plan.plan_id)
  assert.equal(superseded.status, PLAN_STATUS.SUPERSEDED)
  assert.deepEqual(superseded.steps.map(step => step.description), plan.steps.map(step => step.description))
  // A user-steered supersede is also a legitimate base for a revision.
  const revised = applyPlanningEvent(steered, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 1700, source: 'user', approved_by: 'louis', plan_id: plan.plan_id,
    steps: [{ description: 'New user-chosen direction' }],
  })
  assert.equal(getActivePlan(revised).plan_version, 2)
})

test('a new draft supersedes an uncommitted draft but never a committed plan', () => {
  const firstDraft = drafted(shelved(goalState()))
  const firstPlanId = getActivePlan(firstDraft).plan_id
  const secondDraft = drafted(firstDraft, { now: 1250, steps: [{ description: 'Different approach' }] })
  assert.equal(getPlan(secondDraft, firstPlanId).status, PLAN_STATUS.SUPERSEDED)
  assert.equal(getPlan(secondDraft, firstPlanId).superseded_by_plan_id, getActivePlan(secondDraft).plan_id)

  const committedState = committed(secondDraft, { now: 1300 })
  const committedPlanId = getActivePlan(committedState).plan_id
  const laterDraft = drafted(committedState, { now: 1400, steps: [{ description: 'Sneaky replan' }] })
  assert.equal(getPlan(laterDraft, committedPlanId).status, PLAN_STATUS.COMMITTED)
  assert.equal(getPlan(laterDraft, committedPlanId).superseded_by_plan_id, null)
})

// --- reducer purity and totality -------------------------------------------------

test('applyPlanningEvent is total: unknown and malformed events return state unchanged', () => {
  const state = committedFixture()
  const inputs = [
    undefined,
    null,
    'STEP_COMPLETED',
    42,
    [],
    {},
    { type: 'NOT_A_REAL_EVENT', now: 1 },
    { type: PLANNING_EVENT.STEP_COMPLETED },
    { type: PLANNING_EVENT.STEP_COMPLETED, now: Number.NaN, source: 'runtime' },
    { type: PLANNING_EVENT.PLAN_COMMITTED, now: 'soon', runtime_validation: { passed: true } },
    { type: PLANNING_EVENT.DRAFT_CREATED, now: 2000, steps: [] },
    { type: PLANNING_EVENT.DRAFT_CREATED, now: 2000, steps: 'not an array' },
    { type: PLANNING_EVENT.STEP_COMPLETED, now: 2000, source: 'runtime', plan_id: 'nope', step_id: 'nope' },
  ]
  for (const event of inputs) {
    assert.doesNotThrow(() => applyPlanningEvent(state, event))
    assert.equal(applyPlanningEvent(state, event), state, `event ${JSON.stringify(event)} must be inert`)
  }
  // Also total over a missing state.
  assert.doesNotThrow(() => applyPlanningEvent(undefined, { type: PLANNING_EVENT.STEP_COMPLETED, now: 1, source: 'runtime' }))
})

test('applyPlanningEvent is pure: it does not mutate the input state and is time-injected', () => {
  const state = committedFixture()
  const snapshot = JSON.stringify(serializePlanningState(state))
  const event = {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: 1400,
    plan_id: getActivePlan(state).plan_id,
    step_id: getActivePlan(state).steps[0].step_id,
    evidence: { source: 'runtime', kind: 'deterministic_verification', ref: 'b1', satisfied_requirement_ids: ['req_stone'] },
  }
  const a = applyPlanningEvent(state, event)
  const b = applyPlanningEvent(state, event)
  assert.equal(JSON.stringify(serializePlanningState(state)), snapshot, 'input state must be untouched')
  assert.deepEqual(serializePlanningState(a), serializePlanningState(b), 'same state + same event => same result')
  assert.notEqual(a, state)
  // Timestamps come only from the event.
  assert.equal(getActivePlan(a).updated_at, 1400)
  assert.equal(a.updated_at, 1400)
})

test('the reducer source contains no wall-clock or I/O calls', async () => {
  const fs = await import('node:fs/promises')
  const url = await import('node:url')
  const raw = await fs.readFile(url.fileURLToPath(new URL('./planning-state.mjs', import.meta.url)), 'utf8')
  // Strip comments: prose may legitimately mention what the module must not do.
  const source = raw
    .split(/\r?\n/)
    .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join(' ')
  // Word-boundary anchored: a naive substring scan for 'fs.' also matches
  // innocent identifiers such as `evidenceRefs.length`.
  const forbidden = [
    /\bDate\s*\.\s*now\s*\(/,
    /\bnew\s+Date\s*\(/,
    /\bMath\s*\.\s*random\s*\(/,
    /\bprocess\s*\.\s*env\b/,
    /(?:^|[^A-Za-z0-9_$])fs\s*\./,
    /\bawait\s/,
    /\brequire\s*\(/,
    /\bimport\s*\(/,
  ]
  for (const pattern of forbidden) {
    assert.equal(pattern.test(source), false, `planning-state.mjs must not contain ${pattern}`)
  }
})

test('mutating an event object after dispatch cannot reach stored state', () => {
  const base = drafted(shelved(goalState()))
  const event = {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1250,
    development_mode: 'vertical',
    roadmap_node_ids: ['roadmap_early_smelting'],
    steps: [{ description: 'Original description', completion_contract: GROUNDED_CONTRACT }],
  }
  const state = applyPlanningEvent(base, event)
  event.steps[0].description = 'Mutated after the fact'
  event.roadmap_node_ids.push('injected_node')
  assert.equal(getActivePlan(state).steps[0].description, 'Original description')
  assert.deepEqual(getActivePlan(state).roadmap_node_ids, ['roadmap_early_smelting'])
})

// --- persistence and lineage -------------------------------------------------------

test('serialize/restore round-trips full lineage: goal -> revision -> node -> plan/version -> step', () => {
  let state = committedFixture()
  const predecessor = getActivePlan(state)
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  state = completeActiveStep(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 1600, source: 'runtime', plan_id: predecessor.plan_id, reason_code: 'blocked',
  })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED,
    now: 1700, source: 'user', approved_by: 'louis', plan_id: predecessor.plan_id,
    steps: [{ description: 'Mine a different stone patch', completion_contract: GROUNDED_CONTRACT }],
  })

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(serializePlanningState(restored), serializePlanningState(state))

  assert.equal(restored.goal.goal_id, state.goal.goal_id)
  assert.equal(restored.roadmap.roadmap_revision_id, state.roadmap.roadmap_revision_id)
  const restoredPredecessor = getPlan(restored, predecessor.plan_id)
  assert.equal(restoredPredecessor.status, PLAN_STATUS.BLOCKED)
  assert.equal(restoredPredecessor.roadmap_revision_id, state.roadmap.roadmap_revision_id)
  assert.deepEqual(restoredPredecessor.roadmap_node_ids, ['roadmap_early_smelting'])
  assert.deepEqual(restoredPredecessor.steps.map(step => step.step_id), predecessor.steps.map(step => step.step_id))
  assert.equal(restoredPredecessor.execution.step_progress[predecessor.steps[0].step_id].status, 'completed')
  assert.equal(restoredPredecessor.execution.step_progress[predecessor.steps[0].step_id].accepted_evidence[0].ref, 'b1')

  const lineage = lineageOf(restored)
  assert.equal(lineage.goal_id, state.goal.goal_id)
  assert.equal(lineage.plan_version, 2)
  assert.equal(lineage.derived_from_plan_id, predecessor.plan_id)
  assert.deepEqual(lineage.shelf_node_intents, ['establish reliable early iron and copper smelting'])
})

test('restored committed plans are frozen again', () => {
  const state = committedFixture()
  const restored = restorePlanningState(serializePlanningState(state))
  const plan = getActivePlan(restored)
  assert.equal(plan.status, PLAN_STATUS.COMMITTED)
  assert.ok(Object.isFrozen(plan.steps))
  assert.throws(() => { plan.steps[0].description = 'hijacked on restart' }, TypeError)
  assert.throws(() => { plan.steps.push({ description: 'extra' }) }, TypeError)
})

test('restore of a draft leaves it editable through new drafts only', () => {
  const restored = restorePlanningState(serializePlanningState(drafted(shelved(goalState()))))
  const plan = getActivePlan(restored)
  assert.equal(plan.status, PLAN_STATUS.DRAFT)
  assert.equal(Object.isFrozen(plan.steps), false)
  const recommitted = committed(restored, { now: 5000 })
  assert.equal(getActivePlan(recommitted).status, PLAN_STATUS.COMMITTED)
})

test('restore is total over junk input', () => {
  for (const junk of [undefined, null, 42, 'nope', [], {}, { goal: {} }, { goal: { goal_id: 'g' }, plans: 'bad' }]) {
    assert.doesNotThrow(() => restorePlanningState(junk))
  }
  assert.deepEqual(restorePlanningState(undefined), createEmptyPlanningState())
})

test('deadlock state survives a restore round-trip', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  for (let index = 0; index < DEADLOCK_EVIDENCE_STALL_BATCHES; index += 1) {
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.OPERATION_BATCH_ATTEMPTED, now: 1400 + index, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
      failure_reason_code: 'path_blocked',
    })
  }
  const restored = restorePlanningState(serializePlanningState(state))
  assert.deepEqual(evaluateDeadlockSignals(restored), evaluateDeadlockSignals(state))
})

// --- views ------------------------------------------------------------------------

test('plan tracker view is a deep-frozen read-only projection', () => {
  const state = committedFixture()
  const view = planTrackerView(state)
  assert.equal(view.kind, 'plan_tracker_view')
  assert.ok(Object.isFrozen(view))
  assert.throws(() => { view.active_step_index = 5 }, TypeError)
  assert.throws(() => { view.steps[0].description = 'x' }, TypeError)
  assert.equal(getActivePlan(state).active_step_index, 0)
  assert.equal(view.steps[0].completion_confidence, 'grounded')
  assert.equal(view.plan_version, 1)
  assert.equal(view.roadmap_shelf.length, 2)
  assert.equal(view.roadmap_shelf[0].id, 'roadmap_early_smelting')
  assert.equal(view.roadmap_shelf[0].linked, true)
  assert.equal(view.roadmap_shelf[1].linked, false)
  assert.throws(() => { view.roadmap_shelf[0].intent = 'x' }, TypeError)
})

test('getActiveStep tracks authoritative progress only', () => {
  let state = committedFixture()
  const plan = getActivePlan(state)
  assert.equal(getActiveStep(state).step_id, plan.steps[0].step_id)
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  assert.equal(getActiveStep(state).step_id, plan.steps[0].step_id)
  state = completeActiveStep(state)
  assert.equal(getActiveStep(state).step_id, plan.steps[1].step_id)
})

test('an empty state produces an empty tracker view without throwing', () => {
  const view = planTrackerView(createEmptyPlanningState())
  assert.equal(view.plan_id, null)
  assert.deepEqual(view.steps, [])
  assert.deepEqual(view.roadmap_shelf, [])
  assert.equal(lineageOf(createEmptyPlanningState()), undefined)
})

// --- phase 5: LOD roadmap shelf progressive refinement -----------------------

function dependentShelf(state, now = 1100) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now,
    reason: 'initial shelf',
    nodes: [
      { id: 'node_smelting', intent: 'establish reliable early iron and copper smelting' },
      {
        id: 'node_science',
        intent: 'automation and red science',
        depends_on: ['node_smelting'],
        development_hint: 'vertical',
        // Deliberate overreach: an author ASSERTING the node is already done.
        status: 'realized',
      },
    ],
  })
}

function completeSlice(state, { nodeIds, now, mode = 'vertical', results = ['verified world result'], steps, recognitionIds } = {}) {
  let next = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now,
    development_mode: mode,
    roadmap_node_ids: nodeIds,
    steps: steps ?? [{ description: 'resolve the slice', completion_contract: GROUNDED_CONTRACT }],
  })
  next = committed(next, { now: now + 10 })
  const plan = getActivePlan(next)
  next = runtimeEvidence(next, { ref: `ev_${plan.plan_id}`, requirementIds: ['req_stone'], now: now + 20 })
  next = completeActiveStep(next, { now: now + 30 })
  return applyPlanningEvent(next, {
    type: PLANNING_EVENT.PLAN_COMPLETED,
    now: now + 40,
    source: 'runtime',
    plan_id: plan.plan_id,
    verified_results: results,
    satisfied_recognition_ids: recognitionIds,
  })
}

test('shelf node readiness is grounded in verified dependency realization, not in an asserted status', () => {
  const state = dependentShelf(goalState())
  const science = state.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(science.status, SHELF_NODE_STATUS.TENTATIVE, 'an asserted realization must be discarded')

  const readiness = shelfNodeReadiness(state.roadmap, 'node_science')
  assert.equal(readiness.ready, false)
  assert.deepEqual(readiness.blocked_by, [{
    node_id: 'node_smelting',
    reason: 'dependency_has_no_verified_evidence',
    status: SHELF_NODE_STATUS.READY_TO_REFINE,
  }])

  // The dependency-free node IS ready: nothing on the shelf says otherwise.
  const smelting = state.roadmap.nodes.find(node => node.id === 'node_smelting')
  assert.equal(smelting.status, SHELF_NODE_STATUS.READY_TO_REFINE)
  assert.equal(smelting.ready_since, 1100)
  assert.equal(nearestShelfRefinementTarget(state).node_id, 'node_smelting')
})

test('a completed plan attaches verified results and then unblocks the nearest useful node', () => {
  const before = dependentShelf(goalState())
  const state = completeSlice(before, { nodeIds: ['node_smelting'], now: 1200, results: ['two furnaces smelting iron'] })

  const smelting = state.roadmap.nodes.find(node => node.id === 'node_smelting')
  assert.equal(smelting.status, SHELF_NODE_STATUS.REALIZED)
  assert.deepEqual(smelting.verified_results, ['two furnaces smelting iron'])
  assert.equal(smelting.resolved_by.length, 1, 'lineage links the plan that resolved the node')

  const science = state.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(science.status, SHELF_NODE_STATUS.READY_TO_REFINE, 'the shelf guides the NEXT round')
  assert.equal(shelfNodeReadiness(state.roadmap, 'node_science').ready, true)

  // Realized work leaves the candidate set; the next useful node takes its place.
  const target = nearestShelfRefinementTarget(state)
  assert.equal(target.node_id, 'node_science')
  assert.equal(target.development_hint, 'vertical', 'the coarse hint travels with the guidance')
})

test('a continuous frontier dependency satisfies once evidence exists, because it never latches', () => {
  let state = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1100,
    reason: 'sustained iron gates the next tier',
    nodes: [
      {
        id: 'node_sustained_iron',
        intent: 'sustain iron plate output',
        capability_frontier: {
          continuous: true,
          recognition: [{ id: 'throughput', description: 'measured throughput meets target' }],
        },
      },
      { id: 'node_next_tier', intent: 'reach the next science tier', depends_on: ['node_sustained_iron'] },
    ],
  })
  assert.equal(shelfNodeReadiness(state.roadmap, 'node_next_tier').ready, false)

  state = completeSlice(state, { nodeIds: ['node_sustained_iron'], now: 1200, recognitionIds: ['throughput'] })
  const iron = state.roadmap.nodes.find(node => node.id === 'node_sustained_iron')
  assert.equal(iron.status, SHELF_NODE_STATUS.PARTIALLY_REALIZED, 'a continuous frontier never latches to realized')
  assert.equal(shelfNodeReadiness(state.roadmap, 'node_next_tier').ready, true)
  // The open-ended node stays refinable itself, and stays first in line.
  assert.equal(nearestShelfRefinementTarget(state).node_id, 'node_sustained_iron')
})

test('only explicit user direction or grounded verified world change may revise the roadmap', () => {
  const base = dependentShelf(goalState())
  const nodes = [{ id: 'node_smelting', intent: 'a different long-horizon direction entirely' }]

  for (const source of [undefined, 'jev', 'main_llm', 'planner', 'runtime']) {
    const attempt = applyPlanningEvent(base, {
      type: PLANNING_EVENT.ROADMAP_REVISED,
      now: 1300,
      source,
      reason: 'planner preference',
      nodes,
    })
    assert.equal(attempt, base, `${source ?? 'no source'} must not be able to move long-horizon guidance`)
  }

  // Runtime authority alone is not enough: a world change must be evidenced.
  const grounded = applyPlanningEvent(base, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    now: 1300,
    source: 'runtime',
    reason: 'the ore patch the guidance assumed is exhausted',
    evidence_refs: ['receipt_ore_patch_depleted'],
    nodes,
  })
  assert.equal(grounded.roadmap.authority, 'verified_world_change')
  assert.deepEqual(grounded.roadmap.evidence_refs, ['receipt_ore_patch_depleted'])
  assert.equal(grounded.roadmap.revision_index, 2)

  const byUser = applyPlanningEvent(base, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    now: 1300,
    source: 'user',
    reason: 'I want to go for oil first',
    nodes,
  })
  assert.equal(byUser.roadmap.authority, 'user')
  // Lineage survives either way: the dropped node is preserved, not erased.
  const dropped = byUser.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(dropped.status, SHELF_NODE_STATUS.INVALIDATED)
  assert.equal(dropped.revision_reason, 'I want to go for oil first')
})

test('refinement cannot smuggle a step-by-step mega-plan onto the shelf', () => {
  const base = dependentShelf(goalState())
  const children = Array.from({ length: SHELF_REFINEMENT_MAX_FANOUT + 5 }, (item, index) => ({
    id: `node_micro_${index}`,
    intent: `micro step ${index}`,
    derived_from_node_id: 'node_smelting',
  }))
  const revised = applyPlanningEvent(base, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1300,
    reason: 'refine smelting',
    nodes: [...base.roadmap.nodes, ...children],
  })
  // Everything the refinement proposed is remembered -- the cap governs what
  // becomes refinable, not what survives.
  const micro = revised.roadmap.nodes.filter(node => node.id.startsWith('node_micro_'))
  assert.equal(micro.length, SHELF_REFINEMENT_MAX_FANOUT + 5)

  const refinable = micro.filter(node => node.deferred_by_fanout !== true)
  assert.equal(refinable.length, SHELF_REFINEMENT_MAX_FANOUT)
  assert.equal(revised.roadmap.deferred_for_coarseness.node_ids.length, 5)
  assert.equal(revised.roadmap.deferred_for_coarseness.max_fanout, SHELF_REFINEMENT_MAX_FANOUT)

  // Deferred nodes stay tentative: parked guidance is not a refinement queue.
  const deferred = micro.filter(node => node.deferred_by_fanout === true)
  assert.equal(deferred.length, 5)
  for (const node of deferred) assert.equal(node.status, SHELF_NODE_STATUS.TENTATIVE)

  // And restating them does not launder the deferral away.
  const restated = applyPlanningEvent(revised, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1400,
    reason: 'restate',
    nodes: revised.roadmap.nodes,
  })
  const stillDeferred = restated.roadmap.nodes.filter(node => node.deferred_by_fanout === true)
  assert.equal(stillDeferred.length, 5)
  for (const node of stillDeferred) assert.equal(node.status, SHELF_NODE_STATUS.TENTATIVE)

  // Survives persistence.
  const roundTripped = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(restated))))
  assert.equal(roundTripped.roadmap.nodes.filter(node => node.deferred_by_fanout === true).length, 5)
  assert.equal(roundTripped.roadmap.deferred_for_coarseness.node_ids.length, 5)
})

test('a ready node is demoted when the world stops satisfying its dependencies', () => {
  // node_science depends on node_smelting; completing the smelting slice is
  // what makes it refinable in the first place.
  const state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  const ready = state.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(ready.status, SHELF_NODE_STATUS.READY_TO_REFINE)
  assert.ok(Number.isFinite(ready.ready_since), 'it took its place in the queue when the slice completed')

  // Dropping the dependency it stood on demotes it. Nothing about the node
  // itself changed -- it is restated verbatim.
  const dropped = applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1300,
    reason: 'smelting approach abandoned',
    nodes: state.roadmap.nodes.filter(node => node.id !== 'node_smelting'),
  })
  const afterDrop = dropped.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(afterDrop.status, SHELF_NODE_STATUS.TENTATIVE, 'readiness rested on a premise the shelf no longer holds')
  assert.equal(afterDrop.ready_since, null, 'an unready node holds no place in the refinement queue')
  assert.equal(afterDrop.demoted_at, 1300)
  assert.equal(shelfRefinementCandidates(dropped).some(node => node.node_id === 'node_science'), false)
})

test('demotion is a reading of the shelf, not a verdict on the node', () => {
  const state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  const withNewDependency = nodes => nodes.map(node => (node.id === 'node_science'
    ? { ...node, depends_on: [...node.depends_on, 'node_oil'] }
    : node))

  // A revision declares a NEW prerequisite that nothing has satisfied yet.
  const blocked = applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1300,
    reason: 'red science needs oil after all',
    nodes: [...withNewDependency(state.roadmap.nodes), { id: 'node_oil', intent: 'reach basic oil processing' }],
  })
  assert.equal(blocked.roadmap.nodes.find(node => node.id === 'node_science').status, SHELF_NODE_STATUS.TENTATIVE)

  // Withdrawing that prerequisite makes it refinable again, with a fresh
  // standing in the queue rather than the one it used to hold.
  const unblocked = applyPlanningEvent(blocked, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1400,
    reason: 'oil is not on the critical path for red science',
    nodes: blocked.roadmap.nodes.map(node => (node.id === 'node_science'
      ? { ...node, depends_on: node.depends_on.filter(id => id !== 'node_oil') }
      : node)),
  })
  const repromoted = unblocked.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(repromoted.status, SHELF_NODE_STATUS.READY_TO_REFINE)
  assert.equal(repromoted.ready_since, 1400)
})

test('demotion stops at the bottom rung: verified rungs are never walked back', () => {
  // node_science reaches REALIZED through a verified plan result, then loses
  // its dependency. Evidence does not stop having happened.
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  state = completeSlice(state, { nodeIds: ['node_science'], now: 1300 })
  const realized = state.roadmap.nodes.find(node => node.id === 'node_science')
  assert.ok([SHELF_NODE_STATUS.REALIZED, SHELF_NODE_STATUS.PARTIALLY_REALIZED].includes(realized.status))

  const revised = applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1400,
    reason: 'smelting approach abandoned',
    nodes: state.roadmap.nodes.filter(node => node.id !== 'node_smelting'),
  })
  const after = revised.roadmap.nodes.find(node => node.id === 'node_science')
  assert.equal(after.status, realized.status)
  assert.equal(after.demoted_at, undefined)
})

test('a fan-out deferral is released when a sibling stops occupying the budget', () => {
  const base = dependentShelf(goalState())
  const children = Array.from({ length: SHELF_REFINEMENT_MAX_FANOUT + 2 }, (item, index) => ({
    id: `node_micro_${index}`,
    intent: `micro step ${index}`,
    derived_from_node_id: 'node_smelting',
  }))
  const revised = applyPlanningEvent(base, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1300,
    reason: 'refine smelting',
    nodes: [...base.roadmap.nodes, ...children],
  })
  const deferredIds = revised.roadmap.nodes.filter(node => node.deferred_by_fanout === true).map(node => node.id)
  assert.deepEqual(deferredIds, ['node_micro_4', 'node_micro_5'])

  // Parentage survives a restatement: this used to be overwritten with the
  // node's own id, which silently orphaned every child from its parent.
  const restated = applyPlanningEvent(revised, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1350,
    reason: 'restate',
    nodes: revised.roadmap.nodes,
  })
  for (const node of restated.roadmap.nodes.filter(item => item.id.startsWith('node_micro_'))) {
    assert.equal(node.derived_from_node_id, 'node_smelting', `${node.id} kept its parent`)
  }

  // Invalidating two occupying siblings frees exactly two slots, and the
  // longest-parked deferred children take them in shelf order.
  const freed = applyPlanningEvent(restated, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: 1400,
    reason: 'two micro steps turned out to be unnecessary',
    nodes: restated.roadmap.nodes.filter(node => node.id !== 'node_micro_0' && node.id !== 'node_micro_1'),
  })
  assert.deepEqual(freed.roadmap.nodes.filter(node => node.deferred_by_fanout === true).map(node => node.id), [])
  for (const id of deferredIds) {
    const node = freed.roadmap.nodes.find(item => item.id === id)
    assert.equal(node.deferred_by_fanout, undefined, `${id} is refinable once a slot opened`)
    assert.equal(node.status, SHELF_NODE_STATUS.READY_TO_REFINE)
  }
})

test('the shelf stays non-executable: a node can inform a draft but never become one', () => {
  const node = sanitizeShelfNode({
    id: 'n1',
    intent: 'place furnaces',
    operations: [{ name: 'place_entity' }],
    steps: ['do the thing'],
    completion_contract: GROUNDED_CONTRACT,
    blueprint: { entities: [] },
  })
  for (const field of SHELF_FORBIDDEN_EXECUTABLE_FIELDS) {
    assert.equal(node[field], undefined, `${field} must never live on a shelf node`)
  }
  assert.deepEqual(node.dropped_executable_fields, ['steps', 'operations', 'completion_contract', 'blueprint'])

  // The refinement guidance handed to the Main LLM carries intent and lineage only.
  const state = dependentShelf(goalState())
  const candidate = nearestShelfRefinementTarget(state)
  assert.deepEqual(Object.keys(candidate).sort(), [
    'depends_on', 'development_hint', 'intent', 'node_id', 'ready_since',
    'resolved_by', 'status', 'verified_results', 'why_it_matters',
  ])
  assert.ok(Object.isFrozen(candidate))

  // And there is no transition that turns a ready node into a plan: a draft
  // still needs steps an author wrote, node ids alone produce nothing.
  const empty = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1200,
    development_mode: 'vertical',
    roadmap_node_ids: ['node_smelting'],
    steps: [],
  })
  assert.equal(empty, state)
  assert.equal(empty.plans.length, 0)
})

test('a draft records whether the world had actually unblocked the nodes it claims to refine', () => {
  const state = drafted(dependentShelf(goalState()), { now: 1200, nodeIds: ['node_science', 'node_smelting'] })
  const plan = getActivePlan(state)
  assert.deepEqual(plan.refinement_grounding.ready_node_ids, ['node_smelting'])
  assert.deepEqual(plan.refinement_grounding.not_ready, [
    { node_id: 'node_science', reason: 'dependencies_unsatisfied' },
  ])
  assert.equal(plan.status, PLAN_STATUS.DRAFT, 'recorded, not enforced: the Main LLM authors plans')
})

test('shelf refinement state survives serialize/restore with lineage intact', () => {
  const state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(restored.roadmap.nodes, state.roadmap.nodes)
  assert.equal(restored.roadmap.nodes.find(node => node.id === 'node_smelting').status, SHELF_NODE_STATUS.REALIZED)
  assert.deepEqual(shelfRefinementCandidates(restored), shelfRefinementCandidates(state))
  assert.equal(nearestShelfRefinementTarget(restored).node_id, 'node_science')
})

// --- phase 6: strategic steering at plan boundaries --------------------------

function steer(state, { now, mode, confidence = 0.9, pressure, boundary = STEERING_BOUNDARY.PLAN_COMPLETED, source = 'runtime', ...rest }) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEERING_EVALUATED,
    now,
    source,
    boundary,
    recommended_mode: mode,
    confidence,
    pressure,
    recommended_by: 'jev',
    ...rest,
  })
}

test('steering is admitted at safe boundaries and refused everywhere else', () => {
  const admitted = steer(dependentShelf(goalState()), {
    now: 1150,
    boundary: STEERING_BOUNDARY.GOAL_ADMISSION,
    mode: 'vertical',
    critical_path: 'first smelting capability',
    reason: 'nothing exists yet',
  })
  assert.equal(admitted.steering.current_mode, 'vertical')
  assert.equal(admitted.steering.boundary, STEERING_BOUNDARY.GOAL_ADMISSION)

  // A boundary must be TRUE of durable state, not merely claimed.
  const claimed = steer(dependentShelf(goalState()), { now: 1150, boundary: STEERING_BOUNDARY.PLAN_COMPLETED, mode: 'vertical' })
  assert.equal(claimed.steering, null)
  assert.equal(isSafeSteeringBoundary(claimed, { boundary: STEERING_BOUNDARY.PLAN_COMPLETED }).reason, 'no_completed_plan')

  const unknown = steer(admitted, { now: 1160, boundary: 'whenever_we_feel_like_it', mode: 'horizontal' })
  assert.equal(unknown, admitted)

  // User-only boundaries need user authority.
  const notUser = steer(admitted, { now: 1160, boundary: STEERING_BOUNDARY.USER_PRIORITY_CHANGE, mode: 'horizontal', source: 'runtime' })
  assert.equal(notUser, admitted)
})

test('steering cannot mutate, replace or even touch an executing plan', () => {
  let state = committedFixture()
  state = runtimeEvidence(state, { ref: 'b1', requirementIds: ['req_stone'] })
  assert.equal(getActivePlan(state).status, PLAN_STATUS.EXECUTING)

  for (const boundary of Object.values(STEERING_BOUNDARY)) {
    for (const source of ['runtime', 'user']) {
      const attempt = steer(state, { now: 1500, boundary, mode: 'horizontal', source, confidence: 1, plan_id: getActivePlan(state).plan_id })
      assert.equal(attempt, state, `steering must be refused at ${boundary} while a plan is in flight`)
    }
  }
  assert.equal(state.steering, null)
  assert.equal(isSafeSteeringBoundary(state, { boundary: STEERING_BOUNDARY.PLAN_COMPLETED }).reason, 'plan_in_flight')

  // Even a committed-but-not-yet-executing plan is in flight.
  const committedOnly = committedFixture()
  assert.equal(steer(committedOnly, { now: 1400, mode: 'horizontal' }), committedOnly)
})

test('jev and the main llm cannot write the steering record', () => {
  const state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  for (const source of ['jev', 'main_llm', 'planner', 'model']) {
    const attempt = steer(state, { now: 1400, mode: 'horizontal', source })
    assert.equal(attempt, state, `${source ?? 'no source'} must not be able to write steering`)
  }
  const sourceless = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEERING_EVALUATED,
    now: 1400,
    boundary: STEERING_BOUNDARY.PLAN_COMPLETED,
    recommended_mode: 'horizontal',
  })
  assert.equal(sourceless, state, 'an unattributed steering event writes nothing')

  // Jev's recommendation survives only as provenance under runtime authority.
  const recorded = steer(state, { now: 1400, mode: 'horizontal', confidence: 0.8, pressure: { horizontal: ['power_margin_low'] } })
  assert.equal(recorded.steering.recommendation.recommended_by, 'jev')
  assert.equal(recorded.steering.authority, 'runtime')
})

test('hysteresis permits consecutive same-mode slices without limit', () => {
  assert.equal(STEERING_HYSTERESIS.MAX_CONSECUTIVE_SAME_MODE, null, 'tick-tock is a bias, not a state machine')

  let state = dependentShelf(goalState())
  state = steer(state, { now: 1100, boundary: STEERING_BOUNDARY.GOAL_ADMISSION, mode: 'vertical' })
  let nodeIndex = 0
  for (const at of [1200, 1300, 1400]) {
    nodeIndex += 1
    state = applyPlanningEvent(state, {
      type: PLANNING_EVENT.ROADMAP_REVISED,
      source: 'user',
      now: at - 5,
      reason: 'next coarse node',
      nodes: [...state.roadmap.nodes, { id: `node_frontier_${nodeIndex}`, intent: `frontier ${nodeIndex}` }],
    })
    state = completeSlice(state, { nodeIds: [`node_frontier_${nodeIndex}`], now: at })
    // Vertical again, and justified again: the foundation is already sufficient.
    state = steer(state, { now: at + 50, mode: 'vertical', pressure: { vertical: ['frontier_reached'] } })
    assert.equal(state.steering.current_mode, 'vertical')
    assert.equal(state.steering.hysteresis_applied, false)
  }
  assert.equal(state.steering.consecutive_mode_slices, 4)
  assert.equal(steeringContextForDraft(state).bias, 'horizontal', 'the bias points the other way without forcing anything')
})

test('hysteresis holds the current direction when a flip is weakly grounded', () => {
  const record = {
    current_mode: 'vertical',
    last_directional_mode: 'vertical',
    consecutive_mode_slices: 2,
  }
  const weak = evaluateSteeringTransition(record, {
    mode: 'horizontal',
    confidence: 0.3,
    pressure: { vertical: ['technology_blocked_missing_science'], horizontal: ['power_margin_low'] },
  })
  assert.equal(weak.mode, 'vertical', 'no flip on weak grounds')
  assert.equal(weak.hysteresis_applied, true)
  assert.deepEqual(weak.hold_reasons, [STEERING_HOLD_REASON.LOW_CONFIDENCE, STEERING_HOLD_REASON.INSUFFICIENT_PRESSURE])

  const fresh = evaluateSteeringTransition({ current_mode: 'vertical', last_directional_mode: 'vertical', consecutive_mode_slices: 0 }, {
    mode: 'horizontal',
    confidence: 1,
    pressure: { horizontal: ['power_margin_low', 'throughput_starved'] },
  })
  assert.equal(fresh.mode, 'vertical')
  assert.deepEqual(fresh.hold_reasons, [STEERING_HOLD_REASON.MODE_TOO_NEW])

  // Well grounded: enough confidence, the mode has owned a slice, and the
  // opposite direction carries strictly more grounded pressure.
  const justified = evaluateSteeringTransition(record, {
    mode: 'horizontal',
    confidence: 0.9,
    pressure: { vertical: ['technology_blocked_missing_science'], horizontal: ['power_margin_low', 'throughput_starved'] },
  })
  assert.equal(justified.mode, 'horizontal')
  assert.equal(justified.changed, true)
  assert.equal(justified.hysteresis_applied, false)
  assert.equal(justified.consecutive_mode_slices, 1)

  // recover is exempt; maintain does not disturb the cadence at all.
  assert.equal(evaluateSteeringTransition(record, { mode: 'recover', confidence: 0 }).mode, 'recover')
  const maintained = evaluateSteeringTransition(record, { mode: 'maintain', confidence: 0 })
  assert.equal(maintained.mode, 'maintain')
  assert.equal(maintained.last_directional_mode, 'vertical')
  assert.equal(maintained.consecutive_mode_slices, 2)
})

test('explicit user priority outranks any steering recommendation', () => {
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  state = steer(state, {
    now: 1400,
    boundary: STEERING_BOUNDARY.USER_PRIORITY_CHANGE,
    source: 'user',
    approved_by: 'louis',
    user_priority_mode: 'horizontal',
    mode: 'vertical',
    confidence: 1,
  })
  assert.equal(state.steering.current_mode, 'horizontal')
  assert.equal(state.steering.forced_by_user, true)
  assert.deepEqual(state.steering.hold_reasons, [STEERING_HOLD_REASON.USER_PRIORITY_LOCKED])

  // A later well-grounded recommendation still cannot override the user.
  const pushed = steer(state, {
    now: 1500,
    mode: 'vertical',
    confidence: 1,
    pressure: { vertical: ['frontier_reached', 'capability_absent', 'required_item_uncraftable'] },
  })
  assert.equal(pushed.steering.current_mode, 'horizontal')
  assert.equal(pushed.steering.recommendation.recommended_mode, 'vertical', 'the advice is still recorded, just not obeyed')

  const cleared = applyPlanningEvent(pushed, {
    type: PLANNING_EVENT.STEERING_EVALUATED,
    now: 1600,
    source: 'user',
    approved_by: 'louis',
    boundary: STEERING_BOUNDARY.USER_PRIORITY_CHANGE,
    clear_user_priority: true,
    recommended_mode: 'vertical',
    confidence: 1,
    pressure: { vertical: ['frontier_reached', 'capability_absent'] },
  })
  assert.equal(cleared.steering.user_priority, null)
  assert.equal(cleared.steering.current_mode, 'vertical')
})

test('steering context reaches the main llm before it drafts, as advice only', () => {
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  state = steer(state, {
    now: 1400,
    mode: 'horizontal',
    confidence: 0.9,
    reason: 'smelting exists but cannot sustain the next tier',
    critical_path: 'stable iron throughput',
    pressure: { vertical: ['technology_blocked_missing_science'], horizontal: ['throughput_starved', 'power_margin_low'] },
    candidate_shelf_nodes: ['node_science', 'fabricated_node'],
  })

  const context = steeringContextForDraft(state)
  assert.equal(context.advisory, true)
  assert.equal(context.execution_authority, false)
  assert.equal(context.current_mode, 'horizontal')
  assert.equal(context.previous_mode, null)
  assert.equal(context.critical_path, 'stable iron throughput')
  assert.deepEqual(context.pressure.horizontal, ['throughput_starved', 'power_margin_low'])
  assert.equal(context.refinement_candidates[0].node_id, 'node_science')
  assert.ok(Object.isFrozen(context))
  assert.deepEqual(
    state.steering.recommendation.candidate_shelf_nodes,
    ['node_science'],
    'a candidate node id that is not on the shelf is discarded',
  )

  // The draft records which advice it was written under; it is not bound by it.
  const drafting = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1500,
    development_mode: 'vertical',
    roadmap_node_ids: ['node_science'],
    steps: [{ description: 'push to red science anyway', completion_contract: GROUNDED_CONTRACT }],
  })
  const plan = getActivePlan(drafting)
  assert.equal(plan.development_mode, 'vertical')
  assert.deepEqual(plan.steering_at_draft, {
    mode: 'horizontal',
    steering_sequence: 1,
    critical_path: 'stable iron throughput',
    diverges_from_steering: true,
  })
  assert.equal(drafting.steering.current_mode, 'horizontal', 'drafting does not rewrite steering')
})

test('the steering record survives serialize/restore with its hysteresis lineage', () => {
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  state = steer(state, { now: 1400, mode: 'vertical', pressure: { vertical: ['frontier_reached'] } })
  state = steer(state, { now: 1450, mode: 'vertical', pressure: { vertical: ['capability_absent'] } })

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(restored.steering, state.steering)
  assert.equal(restored.steering.consecutive_mode_slices, 2)
  assert.equal(restored.steering.history.length, 2)
  assert.deepEqual(steeringRecord(restored), steeringRecord(state))
  assert.ok(Object.isFrozen(steeringRecord(restored)))

  // A hand-edited snapshot cannot inject an unknown mode or a bogus cadence.
  const snapshot = JSON.parse(JSON.stringify(serializePlanningState(state)))
  const tampered = restorePlanningState({
    ...snapshot,
    steering: { ...snapshot.steering, current_mode: 'sideways', consecutive_mode_slices: -9 },
  })
  assert.equal(tampered.steering, null)
})

test('steering pressure is a closed grounded vocabulary, not prose', () => {
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  state = steer(state, {
    now: 1400,
    mode: 'horizontal',
    pressure: {
      horizontal: ['Power margin low', 'the base feels a bit slow', 'power_margin_low'],
      vertical: ['frontier_reached', 'vibes'],
    },
  })

  // Recognised codes survive, case-normalised and deduplicated.
  assert.deepEqual(state.steering.pressure.horizontal, ['power_margin_low'])
  assert.deepEqual(state.steering.pressure.vertical, ['frontier_reached'])

  // Prose is dropped rather than stored -- but visibly, so a caller that
  // invented a justification can see it did not count toward the mode. Note
  // 'Power margin low' is prose too: the code is `power_margin_low`, and a
  // near-miss is not quietly repaired into a match.
  assert.deepEqual(
    [...state.steering.dropped_pressure].sort(),
    ['power margin low', 'the base feels a bit slow', 'vibes'],
  )

  // A code from the other direction's vocabulary is not a free pass.
  const crossed = steer(state, {
    now: 1500,
    mode: 'horizontal',
    pressure: { horizontal: ['frontier_reached'] },
  })
  assert.deepEqual(crossed.steering.pressure.horizontal, [])
  assert.deepEqual(crossed.steering.dropped_pressure, ['frontier_reached'])

  // The vocabulary itself: disjoint, non-empty, and snake_case throughout, so
  // a direction can never be satisfied by a code that also means its opposite.
  const { vertical, horizontal } = STEERING_PRESSURE_VOCABULARY
  assert.ok(vertical.length > 0 && horizontal.length > 0)
  for (const code of [...vertical, ...horizontal]) assert.match(code, /^[a-z][a-z0-9_]*$/)
  assert.deepEqual(vertical.filter(code => horizontal.includes(code)), [])
})

test('a plan completion boundary is where steering and the next shelf round meet', () => {
  let state = completeSlice(dependentShelf(goalState()), { nodeIds: ['node_smelting'], now: 1200 })
  const plansBefore = state.plans
  state = steer(state, {
    now: 1400,
    mode: 'horizontal',
    pressure: { horizontal: ['throughput_starved'] },
    plan_id: plansBefore[0].plan_id,
  })
  assert.equal(state.plans, plansBefore, 'a steering evaluation touches no plan at all')
  assert.equal(state.steering.last_plan_id, plansBefore[0].plan_id)
  assert.equal(state.steering.history[0].boundary, STEERING_BOUNDARY.PLAN_COMPLETED)
  // Shelf refinement and steering answer different questions at the same boundary.
  assert.equal(nearestShelfRefinementTarget(state).node_id, 'node_science')
})

test('a long goal keeps its active plan and newest history across the plan cap and a restart', () => {
  // A rocket-length goal commits far more plan slices than the retention cap.
  let state = shelved(goalState())
  const total = MAX_RETAINED_PLANS + 16
  for (let index = 0; index < total; index++) state = drafted(state, { now: 2000 + index })
  state = committed(state, { now: 9000 })

  const active = getActivePlan(state)
  assert.ok(active, 'the newest plan stays active')
  assert.equal(state.plans.length, MAX_RETAINED_PLANS)
  assert.equal(state.plans.at(-1).plan_id, active.plan_id)

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.equal(restored.active_plan_id, active.plan_id, 'restart must not drop the active plan')
  assert.equal(getActivePlan(restored).status, PLAN_STATUS.COMMITTED)

  // Rolling logs keep the newest entries rather than freezing at the oldest.
  assert.ok(state.log.length <= 256)
  assert.equal(state.log.at(-1).type, PLANNING_EVENT.PLAN_COMMITTED)
  assert.equal(restored.log.at(-1).type, PLANNING_EVENT.PLAN_COMMITTED)
})

test('Jev is asked only the steering pressures that the supplied state has facts for', () => {
  // Every code carries a definition and the facts that could show it.
  const { vertical, horizontal } = STEERING_PRESSURE_VOCABULARY
  assert.deepEqual(Object.keys(STEERING_PRESSURE_EVIDENCE).sort(), [...vertical, ...horizontal].sort())

  // A fresh goal on an empty map: no roadmap and no save facts, so nothing
  // (for example machine_idle_no_input) can be asked.
  assert.deepEqual(askableSteeringPressures({ roadmap: null, save_progress: null }), { horizontal: [], vertical: [] })

  const withFacts = askableSteeringPressures({
    roadmap: { nodes: [{ id: 'node_1' }] },
    save_progress: { researched_technologies: 3 },
  })
  assert.deepEqual(withFacts, {
    horizontal: [],
    vertical: ['frontier_reached', 'capability_absent', 'shelf_node_ready_to_refine', 'goal_requires_new_capability'],
  })

  const questions = steeringRecommendationQuestions({
    pressureVocabulary: withFacts,
    pressureDefinitions: { capability_absent: STEERING_PRESSURE_EVIDENCE.capability_absent.definition },
  })
  assert.equal(questions.pressure_machine_idle_no_input, undefined)
  assert.equal(questions.pressure_capability_absent.instructions.condition, STEERING_PRESSURE_EVIDENCE.capability_absent.definition)
})
