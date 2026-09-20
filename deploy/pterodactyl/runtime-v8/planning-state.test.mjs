import test from 'node:test'
import assert from 'node:assert/strict'

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
  serializePlanningState,
  SHELF_NODE_STATUS,
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
    jev_verdict: 'actionable',
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

test('lifecycle reaches COMMITTED only when jev is actionable and runtime validation passes', () => {
  const draft = drafted(shelved(goalState()))
  assert.equal(getActivePlan(draft).status, PLAN_STATUS.DRAFT)

  const noVerdict = applyPlanningEvent(draft, {
    type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true },
  })
  assert.equal(getActivePlan(noVerdict).status, PLAN_STATUS.DRAFT)

  const noValidation = applyPlanningEvent(draft, {
    type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, jev_verdict: 'actionable', runtime_validation: { passed: false },
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
  assert.equal(plan.lifecycle.at(-1).reason, 'auto_commit_actionable_and_validated')
  // Nothing in the log records a user approval for this transition.
  assert.equal(state.log.some(entry => entry.type === PLANNING_EVENT.USER_REVISION_APPROVED), false)
})

test('JEV_REFINEMENT_REQUESTED shelves the deferred tail instead of dropping it', () => {
  const draft = drafted(shelved(goalState()), {
    steps: [
      { description: 'Acquire stone', completion_contract: GROUNDED_CONTRACT },
      { description: 'Build first furnace' },
      { description: 'Build a full red science complex' },
      { description: 'Launch a rocket' },
    ],
  })
  const plan = getActivePlan(draft)
  const refined = applyPlanningEvent(draft, {
    type: PLANNING_EVENT.JEV_REFINEMENT_REQUESTED,
    now: 1250,
    plan_id: plan.plan_id,
    verdict: 'refine',
    reason_codes: ['horizon_too_long', 'step_too_vague'],
    actionable_prefix: 2,
    problem_step_ids: [plan.steps[2].step_id],
    recommended_boundary: 'first_stable_smelting_checkpoint',
  })
  const intents = refined.roadmap.nodes.map(node => node.intent)
  assert.ok(intents.includes('Build a full red science complex'))
  assert.ok(intents.includes('Launch a rocket'))
  const tailNode = refined.roadmap.nodes.find(node => node.intent === 'Launch a rocket')
  assert.equal(tailNode.status, SHELF_NODE_STATUS.TENTATIVE)
  assert.ok(tailNode.why_it_matters.includes(plan.plan_id))
  assert.equal(refined.roadmap.reason, 'deferred_tail_from_jev_refine')
  // Original shelf nodes survive the revision.
  assert.ok(intents.includes('establish reliable early iron and copper smelting'))
  const after = getActivePlan(refined)
  assert.equal(after.status, PLAN_STATUS.DRAFT)
  assert.equal(after.jev_review.refinement_count, 1)
  assert.deepEqual(after.jev_review.last_reason_codes, ['horizon_too_long', 'step_too_vague'])
})

test('jev cannot request refinement of a committed plan', () => {
  const state = committedFixture()
  const plan = getActivePlan(state)
  const attempted = applyPlanningEvent(state, {
    type: PLANNING_EVENT.JEV_REFINEMENT_REQUESTED,
    now: 1400,
    plan_id: plan.plan_id,
    actionable_prefix: 1,
    reason_codes: ['too_broad'],
  })
  assert.equal(attempted, state)
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
    { type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED, now: 1400, plan_id: plan.plan_id, step_id: stepId, evidence: { source: 'jev', kind: 'jev_verdict', ref: 'jev_1', satisfied_requirement_ids: ['req_stone'] } },
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
    { type: PLANNING_EVENT.PLAN_COMMITTED, now: 'soon', jev_verdict: 'actionable', runtime_validation: { passed: true } },
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
    .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join(' ')
  for (const forbidden of ['Date.now(', 'new Date(', 'Math.random(', 'process.env', 'fs.', 'await ']) {
    assert.equal(source.includes(forbidden), false, `planning-state.mjs must not contain ${forbidden}`)
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
  assert.equal(lineageOf(createEmptyPlanningState()), undefined)
})
