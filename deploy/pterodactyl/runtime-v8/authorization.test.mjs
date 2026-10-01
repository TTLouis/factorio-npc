import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTION_SCOPE,
  ADMISSION_REFUSAL,
  APPROVAL_REASON,
  ASK_REASON,
  annotateReservedEntities,
  authorizationOf,
  checkGrant,
  checkReplacementAtCommit,
  classifyReplacement,
  entityProtection,
  evaluateOperationAdmission,
  GRANT_REFUSAL,
  MANDATE_KIND,
  REPLACEMENT_DECISION,
  REPLACEMENT_REFUSAL,
  reservedContainerUnitNumbers,
} from './authorization.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  getPlan,
  PLAN_STATUS,
  PLANNING_EVENT,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'

// MW1 (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 2): authorization records, replacement-plan lineage,
// the grant check at commit and at admission, protected assets and reserved supplies. Pure reducer/facade tests: no
// provider, no Factorio, no Jev.

const GOAL_ID = 'goal_mw1'
const ACTOR = { actor_id: 18, actor_epoch: 3 }

const STONE_CONTRACT = {
  mode: 'all',
  requirements: [{ id: 'req_stone', kind: 'inventory_count', item_name: 'stone', minimum: 10 }],
  confidence: 0.9,
}

const STANDING_AUTO = {
  mandate_kind: MANDATE_KIND.STANDING_AUTO,
  mandate_id: GOAL_ID,
  requested_result: { result_key: 'victory:rocket_launch', destination: '' },
  permitted_scope: [ACTION_SCOPE.EXPAND_INFRASTRUCTURE, ACTION_SCOPE.ROUTE_CHANGE, ACTION_SCOPE.RESOURCE_EXPANSION, ACTION_SCOPE.RECOVERY],
  constraints: ['keep the main base layout'],
  actor: ACTOR,
}

const PLAYER_TASK = {
  mandate_kind: MANDATE_KIND.PLAYER_TASK,
  mandate_id: 'task_plates',
  task_id: 'task_plates',
  requested_result: { result_key: 'deliver:iron-plate:100', destination: 'chest:buffer-1' },
  permitted_scope: [ACTION_SCOPE.SUPPORTING_WORK, ACTION_SCOPE.RECOVERY, ACTION_SCOPE.ROUTE_CHANGE],
  actor: ACTOR,
}

const NEW_STEPS = [
  { description: 'Find a second iron patch' },
  { description: 'Mine the new patch and smelt 100 iron plates' },
  { description: 'Deliver the plates to the buffer chest' },
]

function goalState(now = 1000) {
  return applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now,
    goal_id: GOAL_ID,
    owner: 'louis',
    objective: 'deliver 100 iron plates to the buffer chest',
  })
}

function granted(state, grant, { now = 1100, source = 'runtime' } = {}) {
  return applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_GRANTED, source, now, grant })
}

function grantOf(state, grant) {
  return authorizationOf(state).grants.find(item => item.mandate_kind === grant.mandate_kind && item.mandate_id === grant.mandate_id)
}

// A committed two-step plan, step 1 verified complete (verified history), then a structural blocker freezes it.
function blockedState(grant = STANDING_AUTO) {
  let state = granted(goalState(), grant)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1200,
    steps: [
      { description: 'Acquire stone for furnaces', completion_contract: STONE_CONTRACT },
      { description: 'Mine iron ore from the first patch and smelt plates' },
    ],
  })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true }, grant_check: ACTOR })
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: 1400,
    plan_id: plan.plan_id,
    step_id: plan.steps[0].step_id,
    evidence: { source: 'runtime', kind: 'deterministic_verification', ref: 'verified/stone', batch_id: 7, satisfied_requirement_ids: ['req_stone'] },
  })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.STEP_COMPLETED, now: 1500, source: 'runtime', plan_id: plan.plan_id, step_id: plan.steps[0].step_id })
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 1600,
    source: 'runtime',
    plan_id: plan.plan_id,
    reason_code: 'source_depleted',
    detail: 'the first iron patch is exhausted',
  })
}

function request(state, grant, overrides = {}) {
  const held = grantOf(state, grant)
  return {
    type: PLANNING_EVENT.REPLACEMENT_PLAN_REQUESTED,
    source: 'runtime',
    now: 2000,
    plan_id: state.active_plan_id,
    grant: { grant_id: held.grant_id, revision: held.revision },
    current: ACTOR,
    requested_result: held.requested_result,
    action_scope: ACTION_SCOPE.RECOVERY,
    reason: { code: 'source_depleted', detail: 'iron patch exhausted', evidence_refs: ['observation/patch-empty-1'] },
    impacts: {},
    steps: NEW_STEPS,
    ...overrides,
  }
}

const ids = state => state.plans.map(plan => plan.plan_id)

// --- authorization record ---------------------------------------------------

test('MW1: a grant records mandate kind, revision, goal/task, scope, constraints and protected materials', () => {
  const state = granted(goalState(), {
    ...PLAYER_TASK,
    constraints: ['do not touch the red science line'],
    protected_materials: [{ item_name: 'copper-plate' }, { container_unit_number: 900 }],
    protected_assets: { unit_numbers: [501] },
  })
  const grant = grantOf(state, PLAYER_TASK)
  assert.equal(grant.grant_id, 'player_task:task_plates')
  assert.equal(grant.mandate_kind, MANDATE_KIND.PLAYER_TASK)
  assert.equal(grant.revision, 1)
  assert.equal(grant.status, 'active')
  assert.equal(grant.goal_id, GOAL_ID)
  assert.equal(grant.task_id, 'task_plates')
  assert.deepEqual(grant.requested_result, { result_key: 'deliver:iron-plate:100', destination: 'chest:buffer-1' })
  assert.deepEqual(grant.permitted_scope, PLAYER_TASK.permitted_scope)
  assert.deepEqual(grant.constraints, ['do not touch the red science line'])
  assert.deepEqual(grant.protected_materials, [
    { item_name: 'copper-plate', container_unit_number: null },
    { item_name: null, container_unit_number: 900 },
  ])
  assert.deepEqual(grant.protected_assets.unit_numbers, [501])
  assert.deepEqual(grant.actor, ACTOR)
})

test('MW1: revising or revoking a grant bumps its revision; a revoked grant can only come back at a new revision', () => {
  let state = granted(goalState(), STANDING_AUTO)
  const grant = grantOf(state, STANDING_AUTO)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.AUTHORIZATION_REVISED,
    source: 'runtime',
    now: 1200,
    grant_id: grant.grant_id,
    changes: { constraints: ['also keep the oil outpost'] },
    reason: 'player added a constraint',
  })
  assert.equal(grantOf(state, STANDING_AUTO).revision, 2)
  assert.deepEqual(grantOf(state, STANDING_AUTO).constraints, ['also keep the oil outpost'])

  // A revision that changes nothing, or is invalid, does not bump anything.
  const unchanged = applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source: 'runtime', now: 1210, grant_id: grant.grant_id, changes: {} })
  assert.equal(unchanged, state)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source: 'runtime', now: 1210, grant_id: grant.grant_id, changes: { permitted_scope: [] } }), state)

  state = applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 1300, grant_id: grant.grant_id, reason: 'player cancelled auto' })
  const revoked = grantOf(state, STANDING_AUTO)
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revision, 3)
  assert.equal(revoked.revoked_at, 1300)

  // Revoking again, or revising a revoked grant, is a no-op.
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 1310, grant_id: grant.grant_id }), state)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source: 'runtime', now: 1310, grant_id: grant.grant_id, changes: { constraints: ['x'] } }), state)

  // Granting an active grant again is refused; granting after revocation re-activates at the NEXT revision.
  const reactivated = granted(state, STANDING_AUTO, { now: 1400 })
  assert.equal(grantOf(reactivated, STANDING_AUTO).status, 'active')
  assert.equal(grantOf(reactivated, STANDING_AUTO).revision, 4)
  assert.equal(granted(reactivated, STANDING_AUTO, { now: 1500 }), reactivated)
})

test('MW1: only runtime or user authority can grant, revise, revoke or approve; the planner and Jev cannot', () => {
  const base = goalState()
  for (const source of ['main_planner', 'main_llm', 'jev', '', 'server_lifecycle']) {
    assert.equal(granted(base, STANDING_AUTO, { source }), base, `source ${source} must not grant`)
  }
  const state = granted(base, STANDING_AUTO)
  const grant = grantOf(state, STANDING_AUTO)
  for (const source of ['main_planner', 'jev', undefined]) {
    assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source, now: 1200, grant_id: grant.grant_id }), state)
    assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source, now: 1200, grant_id: grant.grant_id, changes: { constraints: ['x'] } }), state)
    assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED, source, now: 1200, approved_by: 'louis', decision: 'approve', reason_codes: ['protected_redesign'] }), state)
  }
  // An approval is the player's answer: runtime authority cannot give one either.
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED, source: 'runtime', now: 1200, approved_by: 'louis', decision: 'approve', reason_codes: ['protected_redesign'] }), state)
  // A grant is bound to the active goal.
  assert.equal(applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.AUTHORIZATION_GRANTED, source: 'runtime', now: 1, grant: STANDING_AUTO }).authorization, undefined)
})

// --- replacement-plan lineage ------------------------------------------------

test('MW1: in-grant expansion replaces a frozen plan, preserves the goal and verified history, and records its lineage', () => {
  const blocked = blockedState(STANDING_AUTO)
  const predecessor = getActivePlan(blocked)
  assert.equal(predecessor.status, PLAN_STATUS.BLOCKED)

  const next = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO, { action_scope: ACTION_SCOPE.RESOURCE_EXPANSION }))
  const successor = getActivePlan(next)
  assert.notEqual(successor.plan_id, predecessor.plan_id)
  assert.equal(successor.status, PLAN_STATUS.DRAFT, 'a replacement still has to pass the commit-time grant check')
  assert.equal(successor.plan_version, predecessor.plan_version + 1)
  assert.equal(successor.derived_from_plan_id, predecessor.plan_id)
  assert.equal(successor.origin, 'authorized_replacement')
  assert.deepEqual(successor.steps.map(step => step.description), NEW_STEPS.map(step => step.description))

  // The lineage: predecessor, the grant id + revision used, and a reason grounded in an observed failure.
  assert.equal(successor.replacement.predecessor_plan_id, predecessor.plan_id)
  assert.equal(successor.replacement.grant_id, 'standing_auto:goal_mw1')
  assert.equal(successor.replacement.grant_revision, 1)
  assert.equal(successor.replacement.action_scope, ACTION_SCOPE.RESOURCE_EXPANSION)
  assert.deepEqual(successor.replacement.reason, { code: 'source_depleted', detail: 'iron patch exhausted', evidence_refs: ['observation/patch-empty-1'] })
  assert.deepEqual(successor.replacement.requested_result, STANDING_AUTO.requested_result)

  // The goal and the requested result are untouched; verified history is preserved, not recomputed.
  assert.equal(next.goal.goal_id, GOAL_ID)
  assert.equal(next.goal.status, 'active')
  assert.equal(next.goal.objective, blocked.goal.objective)
  assert.deepEqual(successor.carried_forward_evidence, [`${predecessor.plan_id}:${predecessor.steps[0].step_id}`])

  // The frozen predecessor is preserved exactly (only its lineage pointer moves).
  const kept = getPlan(next, predecessor.plan_id)
  assert.equal(kept.status, PLAN_STATUS.BLOCKED)
  assert.deepEqual(kept.steps, predecessor.steps)
  assert.deepEqual(kept.execution.step_progress, predecessor.execution.step_progress)
  assert.equal(kept.superseded_by_plan_id, successor.plan_id)
  assert.equal(next.reasoning_epoch, blocked.reasoning_epoch + 1, 'the successor is planned from durable state, not from its predecessor argument')
})

test('MW1: player-task recovery toward the same requested result is accepted under the player-task grant', () => {
  const blocked = blockedState(PLAYER_TASK)
  const verdict = classifyReplacement(blocked, request(blocked, PLAYER_TASK, {
    action_scope: ACTION_SCOPE.SUPPORTING_WORK,
    reason: { code: 'furnace_destroyed', detail: 'the NPC furnace was destroyed by biters', evidence_refs: ['observation/furnace-gone'] },
  }))
  assert.equal(verdict.decision, REPLACEMENT_DECISION.ACCEPT)
  assert.equal(verdict.mandate_kind, MANDATE_KIND.PLAYER_TASK)

  const next = applyPlanningEvent(blocked, request(blocked, PLAYER_TASK, { action_scope: ACTION_SCOPE.SUPPORTING_WORK }))
  const successor = getActivePlan(next)
  assert.equal(successor.replacement.grant_id, 'player_task:task_plates')
  assert.equal(successor.replacement.mandate_kind, MANDATE_KIND.PLAYER_TASK)
  assert.equal(successor.replacement.requested_result.destination, 'chest:buffer-1')
})

test('MW1: a changed outcome or destination asks, never replaces, and leaves the old plan frozen', () => {
  const blocked = blockedState(PLAYER_TASK)
  const before = getActivePlan(blocked)
  const cases = [
    [ASK_REASON.OUTCOME_CHANGED, { result_key: 'deliver:copper-plate:100', destination: 'chest:buffer-1' }],
    [ASK_REASON.DESTINATION_CHANGED, { result_key: 'deliver:iron-plate:100', destination: 'chest:somewhere-else' }],
  ]
  for (const [reason, requestedResult] of cases) {
    const verdict = classifyReplacement(blocked, request(blocked, PLAYER_TASK, { requested_result: requestedResult }))
    assert.equal(verdict.decision, REPLACEMENT_DECISION.ASK, reason)
    assert.equal(verdict.reason, reason)
    assert.equal(verdict.approvable, false, 'a different request is the user revision path, not a grant approval')

    const next = applyPlanningEvent(blocked, request(blocked, PLAYER_TASK, { requested_result: requestedResult }))
    assert.deepEqual(ids(next), ids(blocked), 'no successor plan exists while the question is pending')
    assert.equal(next.active_plan_id, blocked.active_plan_id)
    assert.equal(getActivePlan(next).status, PLAN_STATUS.BLOCKED)
    assert.deepEqual(getActivePlan(next).steps, before.steps)
    const question = authorizationOf(next).questions.at(-1)
    assert.equal(question.status, 'pending')
    assert.deepEqual(question.reason_codes, [reason])
    assert.equal(question.plan_id, before.plan_id)
  }
  // Asking twice about the same thing does not pile up duplicate questions.
  const once = applyPlanningEvent(blocked, request(blocked, PLAYER_TASK, { requested_result: cases[0][1] }))
  const twice = applyPlanningEvent(once, request(once, PLAYER_TASK, { requested_result: cases[0][1], now: 2100 }))
  assert.equal(authorizationOf(twice).questions.length, 1)
})

test('MW1: redesigning player-built structures asks; an approval clears exactly the approved subjects', () => {
  const blocked = blockedState(STANDING_AUTO)
  const redesign = { impacts: { player_built_unit_numbers: [501, 502] } }
  const verdict = classifyReplacement(blocked, request(blocked, STANDING_AUTO, redesign))
  assert.equal(verdict.decision, REPLACEMENT_DECISION.ASK)
  assert.deepEqual(verdict.reason_codes, [ASK_REASON.PROTECTED_REDESIGN])
  assert.deepEqual(verdict.subjects[ASK_REASON.PROTECTED_REDESIGN], [501, 502])
  assert.equal(verdict.approvable, true)

  const asked = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO, redesign))
  assert.deepEqual(ids(asked), ids(blocked), 'the committed plan is not changed while the question is pending')
  const question = authorizationOf(asked).questions.at(-1)
  assert.deepEqual(question.subjects, [501, 502])

  // Only the user can answer; an approval for one structure does not clear the other.
  const partial = applyPlanningEvent(asked, {
    type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED,
    source: 'user',
    now: 2100,
    question_id: question.question_id,
    decision: 'approve',
    approved_by: 'louis',
    reason_codes: [ASK_REASON.PROTECTED_REDESIGN],
    subjects: [501],
  })
  const partialApproval = authorizationOf(partial).approvals.at(-1)
  assert.equal(authorizationOf(partial).questions[0].status, 'answered')
  const stillAsks = classifyReplacement(partial, request(partial, STANDING_AUTO, { ...redesign, approval_id: partialApproval.approval_id }))
  assert.equal(stillAsks.decision, REPLACEMENT_DECISION.ASK)
  assert.deepEqual(stillAsks.subjects[ASK_REASON.PROTECTED_REDESIGN], [502])

  // A denial never clears anything.
  const denied = applyPlanningEvent(asked, {
    type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED,
    source: 'user',
    now: 2100,
    decision: 'deny',
    approved_by: 'louis',
    reason_codes: [ASK_REASON.PROTECTED_REDESIGN],
    subjects: [501, 502],
    plan_id: blocked.active_plan_id,
  })
  assert.equal(classifyReplacement(denied, request(denied, STANDING_AUTO, { ...redesign, approval_id: authorizationOf(denied).approvals.at(-1).approval_id })).decision, REPLACEMENT_DECISION.ASK)

  const approved = applyPlanningEvent(asked, {
    type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED,
    source: 'user',
    now: 2100,
    question_id: question.question_id,
    decision: 'approve',
    approved_by: 'louis',
    reason_codes: [ASK_REASON.PROTECTED_REDESIGN],
  })
  const approvalId = authorizationOf(approved).approvals.at(-1).approval_id
  const next = applyPlanningEvent(approved, request(approved, STANDING_AUTO, { ...redesign, approval_id: approvalId }))
  assert.equal(getActivePlan(next).status, PLAN_STATUS.DRAFT)
  assert.equal(getActivePlan(next).replacement.approval_id, approvalId)
  assert.equal(authorizationOf(next).approvals.find(item => item.approval_id === approvalId).consumed, true, 'an approval is spent once')
})

test('MW1: consuming reserved supplies asks; releasing the reservation lets the replacement through', () => {
  let blocked = blockedState(STANDING_AUTO)
  blocked = applyPlanningEvent(blocked, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1650, unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' })
  const spendReserved = { impacts: { consumed_container_unit_numbers: [900, 901] } }
  const verdict = classifyReplacement(blocked, request(blocked, STANDING_AUTO, spendReserved))
  assert.equal(verdict.decision, REPLACEMENT_DECISION.ASK)
  assert.deepEqual(verdict.reason_codes, [ASK_REASON.RESERVED_SUPPLIES])
  assert.deepEqual(verdict.subjects[ASK_REASON.RESERVED_SUPPLIES], [900], 'only the reserved container is the problem; shared storage 901 is available')
  assert.equal(applyPlanningEvent(blocked, request(blocked, STANDING_AUTO, spendReserved)).active_plan_id, blocked.active_plan_id)

  // Shared factory storage that is NOT reserved is available by default.
  assert.equal(classifyReplacement(blocked, request(blocked, STANDING_AUTO, { impacts: { consumed_container_unit_numbers: [901] } })).decision, REPLACEMENT_DECISION.ACCEPT)

  const released = applyPlanningEvent(blocked, { type: PLANNING_EVENT.RESERVATION_RELEASED, source: 'user', now: 1700, unit_number: 900, released_by: 'louis' })
  assert.equal(classifyReplacement(released, request(released, STANDING_AUTO, spendReserved)).decision, REPLACEMENT_DECISION.ACCEPT)

  // A grant can also name protected materials (an item or a container) that no replacement may spend.
  const withProtected = blockedState({ ...STANDING_AUTO, protected_materials: [{ item_name: 'copper-plate' }] })
  const items = classifyReplacement(withProtected, request(withProtected, STANDING_AUTO, { impacts: { consumed_items: ['copper-plate', 'iron-plate'] } }))
  assert.equal(items.decision, REPLACEMENT_DECISION.ASK)
  assert.deepEqual(items.subjects[ASK_REASON.RESERVED_SUPPLIES], ['copper-plate'])
})

test('MW1: an action outside the grant scope, or a crossed player constraint, asks', () => {
  const blocked = blockedState(PLAYER_TASK)
  const scope = classifyReplacement(blocked, request(blocked, PLAYER_TASK, { action_scope: ACTION_SCOPE.EXPAND_INFRASTRUCTURE }))
  assert.equal(scope.decision, REPLACEMENT_DECISION.ASK)
  assert.equal(scope.reason, ASK_REASON.SCOPE_NOT_GRANTED)
  const missingScope = classifyReplacement(blocked, request(blocked, PLAYER_TASK, { action_scope: undefined }))
  assert.equal(missingScope.reason, ASK_REASON.SCOPE_NOT_GRANTED)
  const constraint = classifyReplacement(blocked, request(blocked, PLAYER_TASK, { impacts: { touched_constraints: ['do not touch the red science line'] } }))
  assert.equal(constraint.decision, REPLACEMENT_DECISION.ASK)
  assert.equal(constraint.reason, ASK_REASON.CONSTRAINT_CROSSED)
})

test('MW1: a replacement needs a blocked predecessor, a grounded reason, steps and runtime authority', () => {
  const blocked = blockedState(STANDING_AUTO)
  const refused = (state, overrides) => classifyReplacement(state, request(state, STANDING_AUTO, overrides))
  assert.equal(refused(blocked, { reason: { code: 'source_depleted', evidence_refs: [] } }).reason, REPLACEMENT_REFUSAL.REASON_NOT_GROUNDED)
  assert.equal(refused(blocked, { reason: { code: '', evidence_refs: ['obs/x'] } }).reason, REPLACEMENT_REFUSAL.REASON_NOT_GROUNDED)
  assert.equal(refused(blocked, { steps: [] }).reason, REPLACEMENT_REFUSAL.STEPS_EMPTY)
  assert.equal(refused(blocked, { plan_id: 'no_such_plan' }).reason, REPLACEMENT_REFUSAL.PREDECESSOR_NOT_FOUND)
  assert.equal(classifyReplacement(blocked, { grant: undefined }).reason, REPLACEMENT_REFUSAL.INVALID_REQUEST)

  // A healthy committed plan is not replaced: only a structural blocker opens the door.
  let healthy = granted(goalState(), STANDING_AUTO)
  healthy = applyPlanningEvent(healthy, { type: PLANNING_EVENT.DRAFT_CREATED, now: 1200, steps: [{ description: 'Mine iron' }] })
  healthy = applyPlanningEvent(healthy, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true }, grant_check: ACTOR })
  assert.equal(classifyReplacement(healthy, request(healthy, STANDING_AUTO)).reason, REPLACEMENT_REFUSAL.PREDECESSOR_NOT_BLOCKED)
  assert.equal(applyPlanningEvent(healthy, request(healthy, STANDING_AUTO)).active_plan_id, healthy.active_plan_id)

  // The planner and Jev cannot invoke the transition; the existing user-revision path is unchanged.
  for (const source of ['main_planner', 'jev', 'user', undefined]) {
    assert.equal(applyPlanningEvent(blocked, request(blocked, STANDING_AUTO, { source })), blocked, `source ${source}`)
  }
})

test('MW1: existing guards are unchanged - a BLOCKED plan still takes no outcome and only a user revision or a grant unfreezes it', () => {
  const blocked = blockedState(STANDING_AUTO)
  const plan = getActivePlan(blocked)
  const attempt = applyPlanningEvent(blocked, { type: PLANNING_EVENT.STEP_COMPLETED, now: 1700, source: 'runtime', plan_id: plan.plan_id, step_id: plan.steps[1].step_id })
  assert.equal(getActivePlan(attempt).status, PLAN_STATUS.BLOCKED)
  assert.equal(attempt.plans.length, blocked.plans.length)
  // No grant: no replacement, even from the runtime.
  const ungranted = (() => {
    let state = goalState()
    state = applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 1200, steps: [{ description: 'Mine iron' }] })
    state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true } })
    return applyPlanningEvent(state, { type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 1400, source: 'runtime', plan_id: state.active_plan_id, reason_code: 'blocked' })
  })()
  const noGrant = classifyReplacement(ungranted, {
    plan_id: ungranted.active_plan_id,
    grant: { grant_id: 'standing_auto:goal_mw1', revision: 1 },
    requested_result: STANDING_AUTO.requested_result,
    action_scope: 'recovery',
    reason: { code: 'x', evidence_refs: ['obs'] },
    steps: NEW_STEPS,
  })
  assert.equal(noGrant.decision, REPLACEMENT_DECISION.REFUSE)
  assert.equal(noGrant.reason, GRANT_REFUSAL.NO_AUTHORIZATION)
  // The user-revision path still works exactly as before, grant or no grant.
  const revised = applyPlanningEvent(ungranted, { type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 1500, source: 'user', approved_by: 'louis', plan_id: ungranted.active_plan_id, steps: [{ description: 'Another patch' }] })
  assert.equal(getActivePlan(revised).origin, 'user_approved_revision')
  assert.equal(getActivePlan(revised).replacement, undefined)
})

// --- stale grants ------------------------------------------------------------

function staleCases(state) {
  const grant = grantOf(state, STANDING_AUTO)
  const revoked = applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 1700, grant_id: grant.grant_id })
  const revised = applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source: 'runtime', now: 1700, grant_id: grant.grant_id, changes: { constraints: ['new constraint'] } })
  const finished = applyPlanningEvent(state, { type: PLANNING_EVENT.GOAL_SATISFIED, now: 1700, source: 'runtime', evidence_refs: ['proof/1'] })
  return [
    [GRANT_REFUSAL.GRANT_REVOKED, revoked, ACTOR],
    [GRANT_REFUSAL.GRANT_REVISION_STALE, revised, ACTOR],
    [GRANT_REFUSAL.GOAL_NOT_ACTIVE, finished, ACTOR],
    [GRANT_REFUSAL.ACTOR_EPOCH_CHANGED, state, { actor_id: 18, actor_epoch: 4 }],
    [GRANT_REFUSAL.ACTOR_REPLACED, state, { actor_id: 19, actor_epoch: 3 }],
    [GRANT_REFUSAL.ACTOR_UNVERIFIED, state, undefined],
  ]
}

test('MW1: a stale grant is refused when a replacement is requested, with a named reason', () => {
  const blocked = blockedState(STANDING_AUTO)
  const held = grantOf(blocked, STANDING_AUTO)
  for (const [reason, state, current] of staleCases(blocked)) {
    // The request carries the revision it was authored under (1), which these states have moved past or invalidated.
    const verdict = classifyReplacement(state, { ...request(blocked, STANDING_AUTO), plan_id: blocked.active_plan_id, current, grant: { grant_id: held.grant_id, revision: held.revision } })
    assert.equal(verdict.decision, REPLACEMENT_DECISION.REFUSE, reason)
    assert.equal(verdict.reason, reason)
    assert.equal(verdict.stale, true)
    const after = applyPlanningEvent(state, { ...request(blocked, STANDING_AUTO), current, grant: { grant_id: held.grant_id, revision: held.revision } })
    assert.equal(after.active_plan_id, state.active_plan_id, `${reason}: no successor`)
    assert.equal(authorizationOf(after).refusals.at(-1).reason, reason)
    assert.equal(authorizationOf(after).refusals.at(-1).stage, 'replacement')
  }
})

test('MW1: a replacement commits only while its grant is current; a stale grant is refused at commit and the draft stays uncommitted', () => {
  const blocked = blockedState(STANDING_AUTO)
  const drafted = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO))
  const draft = getActivePlan(drafted)
  const commit = (state, gc) => applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2100, plan_id: state.active_plan_id, runtime_validation: { passed: true }, ...(gc ? { grant_check: gc } : {}) })

  // The positive case first: current grant, same actor and epoch -> commits, and the lineage is frozen with the steps.
  const ok = commit(drafted, ACTOR)
  assert.equal(getActivePlan(ok).status, PLAN_STATUS.COMMITTED)
  assert.equal(Object.isFrozen(getActivePlan(ok).replacement), true)
  assert.equal(getActivePlan(ok).replacement.grant_revision, 1)

  const held = grantOf(drafted, STANDING_AUTO)
  const revoked = applyPlanningEvent(drafted, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 2050, grant_id: held.grant_id })
  const revised = applyPlanningEvent(drafted, { type: PLANNING_EVENT.AUTHORIZATION_REVISED, source: 'runtime', now: 2050, grant_id: held.grant_id, changes: { constraints: ['new'] } })
  const finished = applyPlanningEvent(drafted, { type: PLANNING_EVENT.GOAL_SATISFIED, now: 2050, source: 'runtime', evidence_refs: ['proof/1'] })
  const cases = [
    [GRANT_REFUSAL.GRANT_REVOKED, revoked, ACTOR],
    [GRANT_REFUSAL.GRANT_REVISION_STALE, revised, ACTOR],
    [GRANT_REFUSAL.GOAL_NOT_ACTIVE, finished, ACTOR],
    [GRANT_REFUSAL.ACTOR_EPOCH_CHANGED, drafted, { actor_id: 18, actor_epoch: 4 }],
    [GRANT_REFUSAL.ACTOR_REPLACED, drafted, { actor_id: 19, actor_epoch: 3 }],
    [GRANT_REFUSAL.ACTOR_UNVERIFIED, drafted, undefined],
  ]
  for (const [reason, state, gc] of cases) {
    assert.equal(checkReplacementAtCommit(state, getActivePlan(state), gc).reason, reason)
    const refused = commit(state, gc)
    assert.equal(getActivePlan(refused).status, PLAN_STATUS.DRAFT, `${reason}: the draft must not commit`)
    assert.equal(authorizationOf(refused).refusals.at(-1).reason, reason)
    assert.equal(authorizationOf(refused).refusals.at(-1).stage, 'commit')
    assert.equal(refused.log.at(-1).type, 'REPLACEMENT_COMMIT_REFUSED')
  }

  // The draft that is committed is the draft that was authorized: re-authored steps are refused, identical ones pass.
  const reauthored = applyPlanningEvent(drafted, { type: PLANNING_EVENT.DRAFT_CREATED, now: 2060, steps: [{ description: 'Something the grant never covered' }] })
  assert.equal(getActivePlan(reauthored).replacement.grant_id, held.grant_id, 're-authoring must not shed the grant check')
  const drifted = commit(reauthored, ACTOR)
  assert.equal(getActivePlan(drifted).status, PLAN_STATUS.DRAFT)
  assert.equal(authorizationOf(drifted).refusals.at(-1).reason, REPLACEMENT_REFUSAL.STEPS_CHANGED_SINCE_AUTHORIZATION)
  const same = applyPlanningEvent(drafted, { type: PLANNING_EVENT.DRAFT_CREATED, now: 2060, steps: NEW_STEPS })
  assert.equal(getActivePlan(commit(same, ACTOR)).status, PLAN_STATUS.COMMITTED)
})

test('MW1: a grant that is not bound to an actor does not need the caller to supply one', () => {
  const unbound = { ...STANDING_AUTO, actor: undefined }
  const blocked = blockedState(unbound)
  const drafted = applyPlanningEvent(blocked, request(blocked, unbound, { current: undefined }))
  assert.equal(getActivePlan(drafted).status, PLAN_STATUS.DRAFT)
  const committed = applyPlanningEvent(drafted, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2100, runtime_validation: { passed: true } })
  assert.equal(getActivePlan(committed).status, PLAN_STATUS.COMMITTED)
})

test('MW1: admission re-checks the grant of a replacement plan and refuses a stale one with a named reason', () => {
  const blocked = blockedState(STANDING_AUTO)
  let state = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO))
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2100, runtime_validation: { passed: true }, grant_check: ACTOR })
  assert.equal(getActivePlan(state).status, PLAN_STATUS.COMMITTED)
  const operations = [{ name: 'gather_resource', args: { resource_name: 'iron-ore', count: 10, search_radius: 32 } }]

  assert.deepEqual(evaluateOperationAdmission(state, { operations, preflight: [{ ok: true }], actor: ACTOR }), { ok: true })
  for (const [reason, stale, actor] of staleCases(state)) {
    const verdict = evaluateOperationAdmission(stale, { operations, preflight: [{ ok: true }], actor })
    assert.equal(verdict.ok, false, reason)
    assert.equal(verdict.code, ADMISSION_REFUSAL.AUTHORIZATION_STALE)
    assert.equal(verdict.reason, reason)
    assert.equal(verdict.stage, 'admission')
    assert.equal(verdict.grant_id, 'standing_auto:goal_mw1')
    assert.equal(verdict.grant_revision, 1)
  }
  // A plan that did not come from a replacement is admitted exactly as before, grant or not.
  const ordinary = goalState()
  assert.deepEqual(evaluateOperationAdmission(ordinary, { operations, preflight: [{ ok: true }], actor: ACTOR }), { ok: true })
})

// --- protected assets --------------------------------------------------------

test('MW1: a human last_user marks an entity player-built; NPC placement receipts, unowned entities and the NPC own identity are not', () => {
  let state = granted(goalState(), STANDING_AUTO)
  const auth = () => authorizationOf(state)
  assert.deepEqual(entityProtection(auth(), { unit_number: 10, last_user: { name: 'louis', index: 1 } }), { protected: true, reason: 'human_last_user', last_user: 'louis' })
  // The standalone NPC leaves last_user empty (tests/factorio/runner/last_user_provenance.py): not protected, zero humans needed.
  assert.equal(entityProtection(auth(), { unit_number: 11 }).protected, false)
  assert.equal(entityProtection(auth(), { unit_number: 11, last_user: undefined }).reason, 'no_human_last_user')

  // The NPC's own placement (receipt) whose engine last_user is empty or its own player identity stays unprotected;
  // a different human changing it afterwards makes it protected.
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.NPC_PLACEMENT_RECORDED, source: 'runtime', now: 1200, unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.NPC_PLACEMENT_RECORDED, source: 'runtime', now: 1210, unit_number: 21, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3, placed_last_user: 'sgluna-body' })
  assert.equal(entityProtection(auth(), { unit_number: 20 }).protected, false)
  assert.equal(entityProtection(auth(), { unit_number: 21, last_user: { name: 'sgluna-body' } }).reason, 'npc_placement_receipt')
  assert.deepEqual(entityProtection(auth(), { unit_number: 20, last_user: { name: 'louis' } }), { protected: true, reason: 'human_changed_npc_placement', last_user: 'louis' })

  // An explicit protected unit in the grant is protected whatever the engine says.
  const explicit = granted(goalState(), { ...PLAYER_TASK, protected_assets: { unit_numbers: [77] } })
  assert.equal(entityProtection(authorizationOf(explicit), { unit_number: 77 }, { goalId: GOAL_ID }).reason, 'grant_protected_asset')
})

test('MW1: admission refuses removal, rotation, mining and reconfiguration of a protected entity without an approval record', () => {
  let state = granted(goalState(), STANDING_AUTO)
  const preflightFor = lastUser => [{ ok: true, operation: 'x', target: { unit_number: 501, last_user: lastUser } }]
  for (const name of ['mine_entity_exact', 'rotate_entity', 'set_machine_recipe']) {
    const operations = [{ name, args: { unit_number: 501 } }]
    const refused = evaluateOperationAdmission(state, { operations, preflight: preflightFor({ name: 'louis', index: 1 }), actor: ACTOR })
    assert.equal(refused.ok, false, name)
    assert.equal(refused.code, ADMISSION_REFUSAL.PROTECTED_ENTITY)
    assert.equal(refused.reason, 'human_last_user')
    assert.equal(refused.unit_number, 501)
    assert.equal(refused.operation_index, 0)
    // The same operation on an entity nobody (no human) built is admitted: new infrastructure is not blocked.
    assert.deepEqual(evaluateOperationAdmission(state, { operations, preflight: preflightFor(undefined), actor: ACTOR }), { ok: true }, name)
  }

  // The FIRST refused operation is reported, with its index, inside a longer batch.
  const batch = [
    { name: 'walk_to_position', args: { x: 1, y: 2, reach_distance: 1 } },
    { name: 'mine_entity_exact', args: { unit_number: 501 } },
  ]
  const verdict = evaluateOperationAdmission(state, { operations: batch, preflight: [{ ok: true }, ...preflightFor({ name: 'louis' })], actor: ACTOR })
  assert.equal(verdict.operation_index, 1)

  // An approval record for THAT entity (from the user) lets it through; one for another entity does not.
  const approve = subjects => applyPlanningEvent(state, {
    type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED, source: 'user', now: 1300, decision: 'approve', approved_by: 'louis',
    reason_codes: [APPROVAL_REASON.PROTECTED_ENTITY], subjects,
  })
  const operations = [{ name: 'mine_entity_exact', args: { unit_number: 501 } }]
  assert.deepEqual(evaluateOperationAdmission(approve([501]), { operations, preflight: preflightFor({ name: 'louis' }), actor: ACTOR }), { ok: true })
  assert.equal(evaluateOperationAdmission(approve([502]), { operations, preflight: preflightFor({ name: 'louis' }), actor: ACTOR }).code, ADMISSION_REFUSAL.PROTECTED_ENTITY)
  state = approve([501])
  assert.equal(authorizationOf(state).approvals.length, 1)
})

// --- reserved supplies ---------------------------------------------------------

test('MW1: reserved containers are never withdrawn from or mined; a player inventory is never a source; shared storage stays available', () => {
  let state = granted(goalState(), STANDING_AUTO)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1200, unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' })
  const check = operations => evaluateOperationAdmission(state, { operations, preflight: operations.map(() => ({ ok: true })), actor: ACTOR })

  const take = unit => [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: unit, max_count: 50, to_entity: false } }]
  const refused = check(take(900))
  assert.equal(refused.code, ADMISSION_REFUSAL.RESERVED_SUPPLY)
  assert.equal(refused.reason, 'container_is_reserved')
  assert.equal(refused.unit_number, 900)
  // Putting items INTO the reserved chest spends nothing of its contents; the unreserved chest is plain shared storage.
  assert.deepEqual(check([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: true } }]), { ok: true })
  assert.deepEqual(check(take(901)), { ok: true })
  // Mining a reserved chest hands its contents to the NPC, so it is refused as well.
  assert.equal(check([{ name: 'mine_entity_exact', args: { unit_number: 900 } }]).code, ADMISSION_REFUSAL.RESERVED_SUPPLY)

  // A name-based withdrawal cannot say which chest it takes from: refused while a chest of that name is reserved.
  const byName = check([{ name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'wooden-chest', max_count: 5, to_entity: false } }])
  assert.equal(byName.code, ADMISSION_REFUSAL.RESERVED_AMBIGUOUS)
  assert.deepEqual(check([{ name: 'move_items', args: { item_name: 'iron-plate', entity_name: 'iron-chest', max_count: 5, to_entity: false } }]), { ok: true })

  // Player inventories are always excluded as a source (to_player=false takes FROM the player).
  const fromPlayer = check([{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'louis', max_count: 5, to_player: false } }])
  assert.equal(fromPlayer.code, ADMISSION_REFUSAL.PLAYER_INVENTORY)
  assert.deepEqual(check([{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'louis', max_count: 5, to_player: true } }]), { ok: true })

  // The exclusion list for availability queries, and the annotation on observed entities.
  assert.deepEqual(reservedContainerUnitNumbers(authorizationOf(state)), [900])
  assert.deepEqual(
    annotateReservedEntities(authorizationOf(state), [{ unit_number: 900, name: 'wooden-chest' }, { unit_number: 901, name: 'wooden-chest' }]),
    [{ unit_number: 900, name: 'wooden-chest', reserved: true }, { unit_number: 901, name: 'wooden-chest' }],
  )

  // Releasing is explicit and immediate; reserving twice is refused.
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1300, unit_number: 900 }), state)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RELEASED, source: 'user', now: 1400, unit_number: 900, released_by: 'louis' })
  assert.deepEqual(check(take(900)), { ok: true })
  assert.equal(authorizationOf(state).world.reservations[0].status, 'released')
  // Only a user or the runtime can reserve or release; the planner and Jev cannot.
  for (const source of ['main_planner', 'jev', undefined]) {
    assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source, now: 1500, unit_number: 902 }), state)
  }
})

// --- zero connected humans -------------------------------------------------------

test('MW1: zero connected humans is still a valid operating state - nothing in the grant, replacement or admission path needs a player', () => {
  const blocked = blockedState(STANDING_AUTO)
  const drafted = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO))
  const committed = applyPlanningEvent(drafted, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2100, runtime_validation: { passed: true }, grant_check: ACTOR })
  assert.equal(getActivePlan(committed).status, PLAN_STATUS.COMMITTED)
  // Every entity the NPC works with reports no human last_user; every operation is admitted.
  const operations = [{ name: 'mine_entity_exact', args: { unit_number: 300 } }, { name: 'place_entity', args: { entity_name: 'stone-furnace' } }]
  assert.deepEqual(evaluateOperationAdmission(committed, { operations, preflight: [{ ok: true, target: { unit_number: 300 } }, { ok: true }], actor: ACTOR }), { ok: true })
  assert.equal(JSON.stringify(serializePlanningState(committed)).includes('connected_players'), false)
})

// --- restart -----------------------------------------------------------------

test('MW1: grants, lineage, questions, approvals, reservations and NPC placements survive serialize/restore (restart)', () => {
  let state = blockedState(STANDING_AUTO)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1650, unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis', position: { x: 4, y: 5 }, surface_index: 1 })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.NPC_PLACEMENT_RECORDED, source: 'runtime', now: 1660, unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 })
  const asked = applyPlanningEvent(state, request(state, STANDING_AUTO, { impacts: { player_built_unit_numbers: [501] } }))
  const answered = applyPlanningEvent(asked, { type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED, source: 'user', now: 2100, question_id: authorizationOf(asked).questions[0].question_id, decision: 'approve', approved_by: 'louis', reason_codes: [ASK_REASON.PROTECTED_REDESIGN] })
  const drafted = applyPlanningEvent(answered, request(answered, STANDING_AUTO, { now: 2200 }))

  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(drafted))))
  assert.deepEqual(authorizationOf(restored), authorizationOf(drafted))
  const plan = getActivePlan(restored)
  assert.deepEqual(plan.replacement, getActivePlan(drafted).replacement)
  assert.equal(plan.replacement.grant_revision, 1)
  assert.equal(grantOf(restored, STANDING_AUTO).revision, 1)
  assert.equal(authorizationOf(restored).world.reservations[0].unit_number, 900)
  assert.equal(authorizationOf(restored).world.npc_placements[0].unit_number, 20)

  // After the restart the grant check still works: the restored draft commits under the restored grant...
  const committed = applyPlanningEvent(restored, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2300, runtime_validation: { passed: true }, grant_check: ACTOR })
  assert.equal(getActivePlan(committed).status, PLAN_STATUS.COMMITTED)
  assert.equal(Object.isFrozen(getActivePlan(committed).replacement), true)
  // ...a restored committed replacement is frozen again, and a revoked grant is still revoked.
  const restoredCommitted = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(committed))))
  assert.equal(Object.isFrozen(getActivePlan(restoredCommitted).replacement), true)
  const revoked = applyPlanningEvent(restoredCommitted, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 2400, grant_id: 'standing_auto:goal_mw1' })
  const afterRestart = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(revoked))))
  assert.equal(evaluateOperationAdmission(afterRestart, { operations: [], preflight: [], actor: ACTOR }).reason, GRANT_REFUSAL.GRANT_REVOKED)

  // A state that never saw authorization serializes without the field and restores without it.
  const plain = goalState()
  assert.equal('authorization' in serializePlanningState(plain), false)
  assert.equal('authorization' in restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(plain)))), false)
})

test('MW1: world facts outlive a goal and a goalless restart; the old goal grants, questions and approvals do not', () => {
  let state = blockedState(STANDING_AUTO)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1650, unit_number: 900, entity_name: 'wooden-chest' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.NPC_PLACEMENT_RECORDED, source: 'runtime', now: 1660, unit_number: 20, entity_name: 'stone-furnace' })
  const next = applyPlanningEvent(state, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 3000, goal_id: 'goal_next', owner: 'louis', objective: 'something else entirely' })
  assert.equal(authorizationOf(next).grants.length, 0)
  assert.equal(authorizationOf(next).world.reservations[0].unit_number, 900)
  assert.equal(authorizationOf(next).world.npc_placements[0].unit_number, 20)
  // The previous goal's grant cannot authorize anything for the new one.
  const stale = checkGrant(authorizationOf(next), next.goal, { grant_id: 'standing_auto:goal_mw1', grant_revision: 1, ...ACTOR })
  assert.equal(stale.reason, GRANT_REFUSAL.NO_AUTHORIZATION)

  // A reservation made before any goal exists is a world fact and is restored without a goal.
  const goalless = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 10, unit_number: 5, entity_name: 'iron-chest' })
  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(goalless))))
  assert.equal(restored.goal, null)
  assert.equal(authorizationOf(restored).world.reservations[0].unit_number, 5)
  // ...and the next goal inherits it.
  const adopted = applyPlanningEvent(restored, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 20, goal_id: 'g', owner: 'louis', objective: 'a goal' })
  assert.equal(authorizationOf(adopted).world.reservations[0].unit_number, 5)
})
