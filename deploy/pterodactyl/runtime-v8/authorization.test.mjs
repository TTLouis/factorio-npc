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
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
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
const KEY = 'npc:sgluna'
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

// --- the harness facade: trace events with request_id and a reason -----------------

function facade() {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  memory.traceSink = (name, payload) => rows.push({ name, ...payload })
  const find = name => rows.filter(row => row.name === name)
  return { memory, rows, find, last: name => find(name).at(-1) }
}

function seededMemory(grant = STANDING_AUTO) {
  const world = facade()
  world.memory.planningByNpc.set(KEY, blockedState(grant))
  return world
}

test('MW1 trace: grant, revise and revoke emit named events carrying request_id and a reason', () => {
  const world = facade()
  world.memory.planningByNpc.set(KEY, goalState())
  const granted = world.memory.grantAuthorization(KEY, STANDING_AUTO, { requestId: 'req_1', now: 1100 })
  assert.equal(granted.ok, true)
  assert.deepEqual(
    (({ ok, reason, grant_id, grant_revision, request_id }) => ({ ok, reason, grant_id, grant_revision, request_id }))(world.last('authorization.granted')),
    { ok: true, reason: 'granted', grant_id: 'standing_auto:goal_mw1', grant_revision: 1, request_id: 'req_1' },
  )
  assert.equal(world.memory.grantAuthorization(KEY, STANDING_AUTO, { requestId: 'req_2' }).ok, false, 'an active grant is not granted twice')
  assert.equal(world.last('authorization.granted').request_id, 'req_2')
  assert.equal(world.last('authorization.granted').ok, false)

  const revised = world.memory.reviseAuthorization(KEY, granted.grant.grant_id, { constraints: ['x'] }, { requestId: 'req_3', reason: 'player changed it' })
  assert.equal(revised.grant.revision, 2)
  assert.equal(world.last('authorization.revised').request_id, 'req_3')
  assert.equal(world.last('authorization.revised').reason, 'revision_bumped')
  const revoked = world.memory.revokeAuthorization(KEY, granted.grant.grant_id, { requestId: 'req_4', reason: 'auto cancelled' })
  assert.equal(revoked.ok, true)
  assert.equal(world.last('authorization.revoked').reason, 'auto cancelled')
  assert.equal(world.last('authorization.revoked').request_id, 'req_4')

  // The planner/Jev source is refused through the facade too.
  const refused = world.memory.grantAuthorization(KEY, PLAYER_TASK, { requestId: 'req_5', source: 'jev' })
  assert.equal(refused.ok, false)
  assert.equal(world.last('authorization.granted').ok, false)
})

test('MW1 trace: an accepted replacement emits plan.replacement_drafted, then plan.replacement_committed with the grant and reason', () => {
  const world = seededMemory()
  const grant = grantOf(world.memory.planningState(KEY), STANDING_AUTO)
  const result = world.memory.requestReplacementPlan(KEY, request(world.memory.planningState(KEY), STANDING_AUTO), { requestId: 'req_10' })
  assert.equal(result.decision, REPLACEMENT_DECISION.ACCEPT)
  const drafted = world.last('plan.replacement_drafted')
  assert.equal(drafted.request_id, 'req_10')
  assert.equal(drafted.reason, 'within_grant')
  assert.equal(drafted.grant_id, grant.grant_id)
  assert.equal(drafted.grant_revision, 1)
  assert.equal(drafted.reason_code, 'source_depleted')
  assert.deepEqual(drafted.evidence_refs, ['observation/patch-empty-1'])
  assert.equal(drafted.successor_plan_id, getActivePlan(world.memory.planningState(KEY)).plan_id)

  const committed = world.memory.commitReplacementPlan(KEY, { current: ACTOR, requestId: 'req_11', now: 2100 })
  assert.equal(committed.ok, true)
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, PLAN_STATUS.COMMITTED)
  const check = world.find('authorization.grant_checked').at(-1)
  assert.deepEqual([check.stage, check.ok, check.reason, check.request_id], ['commit', true, 'within_grant', 'req_11'])
  const row = world.last('plan.replacement_committed')
  assert.equal(row.request_id, 'req_11')
  assert.equal(row.reason, 'within_grant')
  assert.equal(row.grant_revision, 1)
  assert.equal(row.reason_code, 'source_depleted')
  assert.equal(row.predecessor_plan_id, drafted.plan_id)
})

test('MW1 trace: a stale grant is refused at commit and at admission with plan.replacement_refused / authorization.stale_refused', () => {
  const world = seededMemory()
  world.memory.requestReplacementPlan(KEY, request(world.memory.planningState(KEY), STANDING_AUTO), { requestId: 'req_20' })
  // The actor epoch moved after the replacement was authored (death, restart, replacement).
  const atCommit = world.memory.commitReplacementPlan(KEY, { current: { actor_id: 18, actor_epoch: 4 }, requestId: 'req_21', now: 2100 })
  assert.equal(atCommit.ok, false)
  assert.equal(atCommit.reason, GRANT_REFUSAL.ACTOR_EPOCH_CHANGED)
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, PLAN_STATUS.DRAFT)
  assert.deepEqual(
    (({ ok, reason, stage, request_id }) => ({ ok, reason, stage, request_id }))(world.find('authorization.grant_checked').at(-1)),
    { ok: false, reason: GRANT_REFUSAL.ACTOR_EPOCH_CHANGED, stage: 'commit', request_id: 'req_21' },
  )
  assert.equal(world.last('plan.replacement_refused').reason, GRANT_REFUSAL.ACTOR_EPOCH_CHANGED)
  assert.equal(world.last('plan.replacement_refused').request_id, 'req_21')
  assert.equal(world.last('authorization.stale_refused').stage, 'commit')
  assert.equal(authorizationOf(world.memory.planningState(KEY)).refusals.at(-1).stage, 'commit')

  // The same draft commits once the harness presents the real actor; then admission re-checks the grant.
  assert.equal(world.memory.commitReplacementPlan(KEY, { current: ACTOR, requestId: 'req_22', now: 2200 }).ok, true)
  const operations = [{ name: 'gather_resource', args: { resource_name: 'iron-ore', count: 10, search_radius: 32 } }]
  assert.equal(world.memory.checkOperationAdmission(KEY, { operations, preflight: [{ ok: true }], actor: ACTOR }, { requestId: 'req_23' }).ok, true)
  assert.deepEqual(
    (({ stage, ok, reason, request_id }) => ({ stage, ok, reason, request_id }))(world.find('authorization.grant_checked').at(-1)),
    { stage: 'admission', ok: true, reason: 'within_grant', request_id: 'req_23' },
  )
  world.memory.revokeAuthorization(KEY, 'standing_auto:goal_mw1', { requestId: 'req_24', reason: 'player cancelled' })
  const refused = world.memory.checkOperationAdmission(KEY, { operations, preflight: [{ ok: true }], actor: ACTOR }, { requestId: 'req_25' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, ADMISSION_REFUSAL.AUTHORIZATION_STALE)
  assert.equal(refused.reason, GRANT_REFUSAL.GRANT_REVOKED)
  const stale = world.last('authorization.stale_refused')
  assert.deepEqual([stale.stage, stale.reason, stale.request_id], ['admission', GRANT_REFUSAL.GRANT_REVOKED, 'req_25'])
  assert.equal(world.find('authorization.grant_checked').at(-1).ok, false)

  // A stale grant at request time is refused too, with the same named events.
  const early = seededMemory()
  const authored = request(early.memory.planningState(KEY), STANDING_AUTO)
  early.memory.revokeAuthorization(KEY, 'standing_auto:goal_mw1', { requestId: 'req_26a', reason: 'player cancelled' })
  const staleRequest = early.memory.requestReplacementPlan(KEY, authored, { requestId: 'req_26' })
  assert.equal(staleRequest.decision, REPLACEMENT_DECISION.REFUSE)
  assert.equal(staleRequest.reason, GRANT_REFUSAL.GRANT_REVOKED)
  assert.deepEqual(
    (({ stage, reason, request_id }) => ({ stage, reason, request_id }))(early.last('authorization.stale_refused')),
    { stage: 'replacement', reason: GRANT_REFUSAL.GRANT_REVOKED, request_id: 'req_26' },
  )
  assert.equal(early.last('plan.replacement_refused').request_id, 'req_26')
  assert.equal(early.memory.planningState(KEY).active_plan_id, early.memory.planningState(KEY).plans[0].plan_id, 'no successor was created')
})

test('MW1 trace: asks raise plan.replacement_question_raised and leave the old plan frozen', () => {
  const world = seededMemory(PLAYER_TASK)
  const before = world.memory.planningState(KEY)
  const result = world.memory.requestReplacementPlan(KEY, request(before, PLAYER_TASK, { requested_result: { result_key: 'deliver:iron-plate:200', destination: 'chest:buffer-1' } }), { requestId: 'req_30' })
  assert.equal(result.decision, REPLACEMENT_DECISION.ASK)
  const row = world.last('plan.replacement_question_raised')
  assert.equal(row.request_id, 'req_30')
  assert.equal(row.reason, ASK_REASON.OUTCOME_CHANGED)
  assert.equal(row.approvable, false)
  assert.equal(row.old_plan_frozen, true)
  assert.ok(row.question_id)
  assert.equal(world.memory.planningState(KEY).active_plan_id, before.active_plan_id)
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)

  // Redesign of a player-built structure asks, and the user's approval (not the planner's) lets it proceed.
  const redesign = world.memory.requestReplacementPlan(KEY, request(world.memory.planningState(KEY), PLAYER_TASK, { impacts: { player_built_unit_numbers: [501] } }), { requestId: 'req_31' })
  assert.equal(redesign.decision, REPLACEMENT_DECISION.ASK)
  assert.deepEqual(world.last('plan.replacement_question_raised').reason_codes, [ASK_REASON.PROTECTED_REDESIGN])
  const bySource = world.memory.recordAuthorizationApproval(KEY, { question_id: redesign.question.question_id, decision: 'approve', approved_by: 'louis', reason_codes: [ASK_REASON.PROTECTED_REDESIGN] }, { requestId: 'req_32', source: 'jev' })
  assert.equal(bySource.ok, false)
  assert.equal(world.last('authorization.approval_recorded').ok, false)
  const approved = world.memory.recordAuthorizationApproval(KEY, { question_id: redesign.question.question_id, decision: 'approve', approved_by: 'louis', reason_codes: [ASK_REASON.PROTECTED_REDESIGN] }, { requestId: 'req_33' })
  assert.equal(approved.ok, true)
  assert.deepEqual([world.last('authorization.approval_recorded').reason, world.last('authorization.approval_recorded').request_id], ['approve', 'req_33'])
  const proceed = world.memory.requestReplacementPlan(KEY, request(world.memory.planningState(KEY), PLAYER_TASK, { impacts: { player_built_unit_numbers: [501] }, approval_id: approved.approval.approval_id }), { requestId: 'req_34' })
  assert.equal(proceed.decision, REPLACEMENT_DECISION.ACCEPT)
  assert.equal(world.last('plan.replacement_drafted').request_id, 'req_34')
})

test('MW1 trace: protected, reserved and player-inventory refusals emit admission.* events with request_id and reason', () => {
  const world = seededMemory()
  world.memory.recordReservation(KEY, { unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' }, { requestId: 'req_40', now: 1700 })
  assert.deepEqual([world.last('reservation.recorded').ok, world.last('reservation.recorded').reason, world.last('reservation.recorded').request_id], [true, 'reserved', 'req_40'])
  assert.equal(world.memory.recordReservation(KEY, { unit_number: 900 }, { requestId: 'req_41' }).ok, false)
  assert.equal(world.last('reservation.recorded').reason, 'already_reserved')

  const run = (operations, preflight, requestId) => world.memory.checkOperationAdmission(KEY, { operations, preflight: preflight ?? operations.map(() => ({ ok: true })), actor: ACTOR }, { requestId })

  const protectedRefusal = run([{ name: 'mine_entity_exact', args: { unit_number: 501 } }], [{ ok: true, target: { unit_number: 501, last_user: { name: 'louis', index: 1 } } }], 'req_42')
  assert.equal(protectedRefusal.code, ADMISSION_REFUSAL.PROTECTED_ENTITY)
  const protectedRow = world.last('admission.protected_refused')
  assert.deepEqual([protectedRow.reason, protectedRow.unit_number, protectedRow.operation, protectedRow.last_user, protectedRow.request_id], ['human_last_user', 501, 'mine_entity_exact', 'louis', 'req_42'])

  run([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }], undefined, 'req_43')
  const reservedRow = world.last('admission.reserved_refused')
  assert.deepEqual([reservedRow.reason, reservedRow.unit_number, reservedRow.request_id], ['container_is_reserved', 900, 'req_43'])

  run([{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'louis', max_count: 5, to_player: false } }], undefined, 'req_44')
  const playerRow = world.last('admission.player_inventory_refused')
  assert.deepEqual([playerRow.reason, playerRow.request_id], ['player_inventories_are_never_available', 'req_44'])

  world.memory.releaseReservation(KEY, { unit_number: 900, released_by: 'louis' }, { requestId: 'req_45' })
  assert.deepEqual([world.last('reservation.released').ok, world.last('reservation.released').reason, world.last('reservation.released').request_id], [true, 'released', 'req_45'])
  assert.equal(world.memory.releaseReservation(KEY, { unit_number: 900 }, { requestId: 'req_46' }).ok, false)
  assert.equal(world.last('reservation.released').reason, 'not_reserved')
  assert.equal(run([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }], undefined, 'req_47').ok, true)
})

test('MW1 trace: NPC placement receipts are recorded once per entity and drive protection', () => {
  const world = facade()
  world.memory.planningByNpc.set(KEY, granted(goalState(), STANDING_AUTO))
  world.memory.recordNpcPlacement(KEY, { unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 }, { requestId: 'req_50' })
  world.memory.recordNpcPlacement(KEY, { unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 }, { requestId: 'req_51' })
  assert.equal(world.find('placement.npc_recorded').length, 1, 'the same receipt read on every status poll is not a new fact')
  assert.deepEqual([world.last('placement.npc_recorded').request_id, world.last('placement.npc_recorded').reason], ['req_50', 'placement_receipt'])
  assert.equal(world.memory.protectedEntityStatus(KEY, { unit_number: 20 }).protected, false)
  assert.equal(world.memory.protectedEntityStatus(KEY, { unit_number: 20, last_user: { name: 'louis' } }).reason, 'human_changed_npc_placement')
})

test('MW1: the memory snapshot round trip (a server restart) keeps grants, lineage, reservations and placements', () => {
  const world = seededMemory()
  world.memory.requestReplacementPlan(KEY, request(world.memory.planningState(KEY), STANDING_AUTO), { requestId: 'req_60' })
  world.memory.recordReservation(KEY, { unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' }, { now: 2100 })
  world.memory.recordNpcPlacement(KEY, { unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 }, { now: 2110 })

  const snapshot = JSON.parse(JSON.stringify(world.memory.snapshot()))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.planningState(KEY)
  assert.equal(grantOf(state, STANDING_AUTO).revision, 1)
  assert.equal(getActivePlan(state).replacement.grant_id, 'standing_auto:goal_mw1')
  assert.equal(authorizationOf(state).world.reservations[0].unit_number, 900)
  assert.equal(authorizationOf(state).world.npc_placements[0].unit_number, 20)
  // The restored draft still commits only under the restored grant.
  const stale = restored.commitReplacementPlan(KEY, { current: { actor_id: 18, actor_epoch: 9 }, now: 2200 })
  assert.equal(stale.ok, false)
  assert.equal(restored.commitReplacementPlan(KEY, { current: ACTOR, now: 2300 }).ok, true)

  // A reservation made before any goal also survives a restart through the facade.
  const early = new CanonicalTaskBoardMemory()
  early.recordReservation(KEY, { unit_number: 5, entity_name: 'iron-chest', reserved_by: 'louis' }, { now: 10 })
  const reloaded = new CanonicalTaskBoardMemory()
  reloaded.restore(JSON.parse(JSON.stringify(early.snapshot())))
  assert.equal(authorizationOf(reloaded.planningState(KEY)).world.reservations[0].unit_number, 5)
})

// --- review fixes -----------------------------------------------------------------

test('MW1: a replacement can only replace the CURRENT blocked plan - never a superseded one, a healthy plan, or a second pending draft', () => {
  // p1 BLOCKED -> the user revises it (p3, committed) -> a late replacement request for p1 is history, not a successor.
  const blocked = blockedState(STANDING_AUTO)
  const p1 = getActivePlan(blocked)
  let state = applyPlanningEvent(blocked, { type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 1700, source: 'user', approved_by: 'louis', plan_id: p1.plan_id, steps: [{ description: 'Mine from a patch the player chose' }] })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1800, runtime_validation: { passed: true } })
  const p3 = getActivePlan(state)
  assert.equal(p3.status, PLAN_STATUS.COMMITTED)
  const stale = request(state, STANDING_AUTO, { plan_id: p1.plan_id })
  const verdict = classifyReplacement(state, stale)
  assert.equal(verdict.decision, REPLACEMENT_DECISION.REFUSE)
  assert.equal(verdict.reason, REPLACEMENT_REFUSAL.PREDECESSOR_ALREADY_REPLACED)
  const after = applyPlanningEvent(state, stale)
  assert.equal(after.active_plan_id, p3.plan_id, 'the healthy active plan is untouched')
  assert.equal(getActivePlan(after).status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(ids(after), ids(state), 'no plan was added')
  assert.equal(getPlan(after, p1.plan_id).superseded_by_plan_id, p3.plan_id)
  assert.equal(authorizationOf(after).refusals.at(-1).reason, REPLACEMENT_REFUSAL.PREDECESSOR_ALREADY_REPLACED)

  // A blocked plan that is simply not the active one is refused as not active.
  const notActive = { ...blocked, active_plan_id: null }
  assert.equal(classifyReplacement(notActive, request(blocked, STANDING_AUTO)).reason, REPLACEMENT_REFUSAL.PREDECESSOR_NOT_ACTIVE)

  // A second request while a replacement draft is already pending is refused, not stacked.
  const drafted = applyPlanningEvent(blocked, request(blocked, STANDING_AUTO))
  const again = classifyReplacement(drafted, request(drafted, STANDING_AUTO, { plan_id: p1.plan_id }))
  assert.equal(again.decision, REPLACEMENT_DECISION.REFUSE)
  assert.ok([REPLACEMENT_REFUSAL.PREDECESSOR_ALREADY_REPLACED, REPLACEMENT_REFUSAL.REPLACEMENT_PENDING].includes(again.reason))
  const pendingOnly = { ...drafted, plans: drafted.plans.map(plan => (plan.plan_id === p1.plan_id ? { ...plan, superseded_by_plan_id: null } : plan)), active_plan_id: p1.plan_id }
  assert.equal(classifyReplacement(pendingOnly, request(pendingOnly, STANDING_AUTO, { plan_id: p1.plan_id })).reason, REPLACEMENT_REFUSAL.REPLACEMENT_PENDING)
  assert.equal(applyPlanningEvent(drafted, request(drafted, STANDING_AUTO, { plan_id: p1.plan_id })).plans.length, drafted.plans.length)
})

test('MW1 interim: protected-entity and player-inventory gates apply only to grant-backed work; reserved exclusion applies to every goal', () => {
  // An ordinary user-requested goal (no grant, no replacement lineage): the player's own request is their approval.
  let ordinary = goalState()
  ordinary = applyPlanningEvent(ordinary, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1200, unit_number: 900, entity_name: 'wooden-chest' })
  const humanBuilt = [{ ok: true, target: { unit_number: 501, last_user: { name: 'louis', index: 1 } } }]
  const check = (state, operations, preflight) => evaluateOperationAdmission(state, { operations, preflight: preflight ?? operations.map(() => ({ ok: true })), actor: ACTOR })
  for (const name of ['mine_entity_exact', 'rotate_entity', 'set_machine_recipe']) {
    assert.deepEqual(check(ordinary, [{ name, args: { unit_number: 501 } }], humanBuilt), { ok: true }, name)
  }
  assert.deepEqual(check(ordinary, [{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'louis', max_count: 5, to_player: false } }]), { ok: true })
  // ...but a reserved container is excluded for everyone, grant or not.
  assert.equal(check(ordinary, [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 5, to_entity: false } }]).code, ADMISSION_REFUSAL.RESERVED_SUPPLY)

  // Grant-backed work is gated: an active grant for the goal, or replacement lineage on the active plan.
  const withGrant = granted(ordinary, STANDING_AUTO)
  assert.equal(check(withGrant, [{ name: 'mine_entity_exact', args: { unit_number: 501 } }], humanBuilt).code, ADMISSION_REFUSAL.PROTECTED_ENTITY)
  assert.equal(check(withGrant, [{ name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'louis', max_count: 5, to_player: false } }]).code, ADMISSION_REFUSAL.PLAYER_INVENTORY)
  const blocked = blockedState(STANDING_AUTO)
  const replacement = applyPlanningEvent(applyPlanningEvent(blocked, request(blocked, STANDING_AUTO)), { type: PLANNING_EVENT.PLAN_COMMITTED, now: 2100, runtime_validation: { passed: true }, grant_check: ACTOR })
  assert.equal(check(replacement, [{ name: 'mine_entity_exact', args: { unit_number: 501 } }], humanBuilt).code, ADMISSION_REFUSAL.PROTECTED_ENTITY)
  // A revoked grant no longer backs ordinary work.
  const revoked = applyPlanningEvent(withGrant, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'runtime', now: 1500, grant_id: 'standing_auto:goal_mw1' })
  assert.deepEqual(check(revoked, [{ name: 'mine_entity_exact', args: { unit_number: 501 } }], humanBuilt), { ok: true })
})

test('MW1: mining by name is refused while a container of that name is reserved; other names are untouched', () => {
  let state = applyPlanningEvent(goalState(), { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 1200, unit_number: 900, entity_name: 'wooden-chest' })
  const mine = name => evaluateOperationAdmission(state, { operations: [{ name: 'mine_entity', args: { entity_name: name, count: 1 } }], preflight: [{ ok: true }], actor: ACTOR })
  const refused = mine('wooden-chest')
  assert.equal(refused.code, ADMISSION_REFUSAL.RESERVED_AMBIGUOUS)
  assert.equal(refused.reason, 'name_based_mining_while_a_container_of_that_name_is_reserved')
  assert.deepEqual(mine('iron-chest'), { ok: true })
  assert.deepEqual(mine('tree-01'), { ok: true })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RELEASED, source: 'user', now: 1300, unit_number: 900 })
  assert.deepEqual(mine('wooden-chest'), { ok: true })
})

test('MW1: grants, approvals and reservations are consent - user, human or the harness; user_steering is not', () => {
  const base = goalState()
  assert.equal(granted(base, STANDING_AUTO, { source: 'user_steering' }), base)
  assert.notEqual(granted(base, STANDING_AUTO, { source: 'human' }), base)
  const state = granted(base, STANDING_AUTO)
  const approval = source => applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_APPROVAL_RECORDED, source, now: 1200, approved_by: 'louis', decision: 'approve', reason_codes: ['protected_redesign'] })
  assert.equal(approval('user_steering'), state)
  assert.notEqual(approval('human'), state)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user_steering', now: 1200, unit_number: 9 }), state)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_REVOKED, source: 'user_steering', now: 1200, grant_id: 'standing_auto:goal_mw1' }), state)
})

test('MW1: reservations and NPC placements survive a new goal, clearTaskContext, retireCompletedPlan and terminatePlan', () => {
  const seed = () => {
    const memory = new CanonicalTaskBoardMemory()
    memory.planningByNpc.set(KEY, goalState())
    memory.recordReservation(KEY, { unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' }, { now: 1200 })
    memory.recordNpcPlacement(KEY, { unit_number: 20, entity_name: 'stone-furnace', actor_id: 18, actor_epoch: 3 }, { now: 1210 })
    memory.grantAuthorization(KEY, STANDING_AUTO, { now: 1220 })
    return memory
  }
  const worldOf = (memory) => {
    const state = memory.planningState(KEY)
    return { reservations: authorizationOf(state).world.reservations.map(item => item.unit_number), placements: authorizationOf(state).world.npc_placements.map(item => item.unit_number), goal: state.goal ?? null, grants: authorizationOf(state).grants.length }
  }

  const cleared = seed()
  cleared.planByNpc.set(KEY, { goal_id: GOAL_ID, status: 'active' })
  cleared.clearTaskContext(KEY)
  assert.deepEqual(worldOf(cleared), { reservations: [900], placements: [20], goal: null, grants: 0 }, 'the goal and its grants go; the world facts stay')
  // The kept state is goalless but works as the base of the next goal, which inherits the facts.
  const next = cleared.admitPlanningGoal(KEY, { owner: 'louis', objective: 'a brand new goal', now: 3000 })
  assert.equal(authorizationOf(next).world.reservations[0].unit_number, 900)
  assert.equal(authorizationOf(next).grants.length, 0)

  // Without any world facts the planning state is simply deleted, exactly as before.
  const plain = new CanonicalTaskBoardMemory()
  plain.planningByNpc.set(KEY, goalState())
  plain.clearTaskContext(KEY)
  assert.equal(plain.planningState(KEY), undefined)

  const retired = seed()
  retired.planByNpc.set(KEY, { goal_id: GOAL_ID, status: 'completed' })
  assert.equal(retired.retireCompletedPlan(KEY).goal_id, GOAL_ID, 'a completed projection does not retire the active canonical goal')
  retired.recordGoalSatisfaction(KEY, { source: 'runtime', evidenceRefs: ['goal/verified'], rationale: 'Separate canonical acceptance proof.' })
  assert.equal(retired.retireCompletedPlan(KEY), undefined)
  assert.deepEqual(worldOf(retired), { reservations: [900], placements: [20], goal: null, grants: 0 })

  const terminated = seed()
  terminated.planByNpc.set(KEY, { goal_id: GOAL_ID, status: 'active', task_board: undefined })
  terminated.terminatePlan(KEY)
  assert.equal(authorizationOf(terminated.planningState(KEY)).world.reservations[0].unit_number, 900)
})

test('MW1: restore merges goalless world facts into a goal state a legacy migration created for the same key', () => {
  const source = new CanonicalTaskBoardMemory()
  source.planningByNpc.set(KEY, goalState())
  source.recordReservation(KEY, { unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' }, { now: 1200 })
  source.recordNpcPlacement(KEY, { unit_number: 20, entity_name: 'stone-furnace' }, { now: 1210 })
  const snapshot = JSON.parse(JSON.stringify(source.snapshot()))
  // The reducer state in the snapshot lost its goal (an older snapshot), while the legacy board still holds the plan.
  snapshot.planning_states[0].state.goal = null
  snapshot.plans = [{
    key: KEY,
    state: {
      goal_id: GOAL_ID,
      owner: 'louis',
      objective: 'deliver 100 iron plates to the buffer chest',
      status: 'active',
      plan: ['Mine iron ore'],
      current_step: 0,
      updated_at: 1300,
    },
  }]
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const state = restored.planningState(KEY)
  assert.ok(state.goal, 'the legacy migration did create a goal state for this key')
  assert.equal(authorizationOf(state).world.reservations[0].unit_number, 900, 'the world facts were not lost to the migrated goal state')
  assert.equal(authorizationOf(state).world.npc_placements[0].unit_number, 20)
})
