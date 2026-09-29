import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { boardPlanAlignment, CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { applyPlanningEvent, getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'

// 3.3 move 5 / 3.8: a step close is decided in the reducer first and the legacy
// board is mirrored from it. These tests are built from the live run of
// 2026-09-29 (finding 7): a plan revised after a structural blocker, whose
// steps the board closed while the reducer stayed on step 1.

const KEY = 'npc:npc-1'
const RUNTIME_VALIDATED = Object.freeze({ passed: true })
const COAL_CONTRACT = Object.freeze({
  mode: 'all',
  requirements: [{ id: 'coal_gathered', kind: 'inventory_count', item_name: 'coal', minimum: 40 }],
  confidence: 0,
  source: 'planner_semantic_checkpoint',
})

function boardOf(steps, activeIndex) {
  return {
    kind: 'task_board_lite',
    goal_id: 'goal_1',
    status: 'active',
    blocker: '',
    pause_reason: '',
    revision: 3,
    event_sequence: 0,
    evidence_sequence: 0,
    active_index: activeIndex,
    active_step_id: steps[activeIndex].id,
    completed_count: steps.filter(step => step.status === 'completed').length,
    total_steps: steps.length,
    steps,
    evidence: [],
    events: [],
    created_at: 1,
    updated_at: 1,
  }
}

function legacyState(taskBoard) {
  return {
    goal_id: 'goal_1',
    owner: 'Louis',
    objective: 'Get steam power going',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: taskBoard.steps.map(step => step.description),
    current_step: taskBoard.active_index,
    revision: 3,
    last_chat_message: '',
    last_operations: [],
    updated_at: 1,
    history: [],
    task_board: taskBoard,
  }
}

function contractProof(stepId, contract = COAL_CONTRACT) {
  return {
    kind: 'verified_world_state',
    ref: `checkpoint/${stepId}`,
    summary: JSON.stringify({
      contract,
      results: contract.requirements.map(requirement => ({ id: requirement.id, kind: requirement.kind, satisfied: true })),
    }),
  }
}

function closeWithContract(memory, stepId, contract = COAL_CONTRACT) {
  return memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'deterministic_completion_contract',
    evidence: [contractProof(stepId, contract)],
    metadata: { scope: 'step' },
  })
}

function closeSemantically(memory, stepId) {
  const ref = `req_1/semantic_fresh_observation/${stepId}`
  return memory.applyOutcomeAuthority(KEY, {
    kind: 'semantic_complete',
    source: 'main_planner',
    reason_code: 'planner_semantic_step_complete',
    evidence: [{ kind: 'verified_world_state', ref, summary: 'The Main LLM made this semantic completion judgment after a fresh observation.' }],
    metadata: { scope: 'step', step_id: stepId, grounding_refs: [ref] },
  })
}

// The live sequence: plan 1 (five steps) closes its first step, a structural
// blocker freezes it, the user picks "revise", and the planner submits a
// replacement that restates the verified first step and adds a coal step.
// Returns the memory after the revised plan is committed.
function reviseAfterBlocker() {
  const memory = new CanonicalTaskBoardMemory()
  const initial = boardOf([
    { id: 'step_1', description: 'Gather iron ore near base (~40).', status: 'completed' },
    { id: 'step_2', description: 'Smelt iron ore into iron plates.', status: 'active' },
    { id: 'step_3', description: 'Verify steam-power research is completed.', status: 'pending' },
    { id: 'step_4', description: 'Craft and place boiler + steam engine.', status: 'pending' },
    { id: 'step_5', description: 'Craft an electric mining drill.', status: 'pending' },
  ], 1)
  memory.planByNpc.set(KEY, legacyState(initial))
  let planning = memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 100, migrated: true })
  planning = memory.commitPlanningPlan(KEY, { now: 110, migrated: true, runtime_validation: RUNTIME_VALIDATED })
  planning = memory.replayLegacyVerifiedPrefix(KEY, memory.planByNpc.get(KEY), planning, { now: 115 })
  memory.planningByNpc.set(KEY, planning)
  memory.applyOutcomeAuthority(KEY, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'transfer_failed:item_missing',
    candidate_blocker: 'transfer_failed:item_missing',
    evidence: [{ kind: 'fresh_world_observation', ref: 'block_1', summary: 'no coal' }],
  })
  memory.recordBlockedChoice(KEY, 'revise', 'Louis', { now: 120 })
  const blockedBoard = memory.currentPlan(KEY).task_board

  const proposed = {
    chatMessage: 'Coal first.',
    plan: [
      'Gather iron ore near base (~40).',
      'Gather 40 coal (ran out of coal).',
      'Fuel the stone furnace and smelt iron plates.',
      'Verify steam-power research is completed.',
      'Craft and place boiler + steam engine.',
      'Craft an electric mining drill.',
    ],
    currentStep: 1,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'gather 40 coal first' }, proposed)
  memory.reconcileTaskBoard(KEY, blockedBoard, proposed, recorded, { previousState: memory.currentPlan(KEY) })
  assert.equal(recorded.userRevisionApproved, true)

  // The checkpoint contract for the coal step arrives while the successor is
  // still a draft: this is the write that rebuilt the reducer draft from the
  // whole board.
  const coalStepId = memory.currentPlan(KEY).task_board.active_step_id
  memory.setStepCompletionContract(KEY, coalStepId, COAL_CONTRACT, { now: 130 })
  memory.commitPlanningPlan(KEY, { now: 140, runtime_validation: RUNTIME_VALIDATED })
  return memory
}

function trackerProgress(memory) {
  const plan = getActivePlan(memory.planningState(KEY))
  return {
    plan,
    completed: plan.steps.filter(step => plan.execution.step_progress[step.step_id]?.status === 'completed').length,
  }
}

test('a revised plan\'s reducer draft holds only its own steps, not the verified prefix the board carries', () => {
  const memory = reviseAfterBlocker()
  const { plan } = trackerProgress(memory)
  const board = memory.currentPlan(KEY).task_board

  assert.equal(plan.plan_version, 2)
  assert.equal(plan.carried_forward_evidence.length, 1)
  assert.equal(board.steps.length, 6)
  assert.equal(plan.steps.length, 5, 'the verified first step is carried, not repeated')
  assert.equal(plan.steps[0].description, 'Gather 40 coal (ran out of coal).')
  assert.deepEqual(plan.steps[0].completion_contract?.requirements?.[0]?.id, 'coal_gathered')
  assert.equal(boardPlanAlignment(board, plan), 1)
  assert.equal(plan.active_step_index, 0)
  assert.equal(board.active_index, 1)
})

test('closing steps on a revised plan advances the reducer and the board together, and survives a restart', () => {
  const memory = reviseAfterBlocker()
  const board = () => memory.currentPlan(KEY).task_board

  const coal = closeWithContract(memory, board().active_step_id)
  assert.equal(coal.decision.accepted, true)
  assert.equal(getActivePlan(memory.planningState(KEY)).active_step_index, 1, 'the coal step, not step 1, was closed')
  assert.equal(board().active_index, 2)

  const fuel = closeSemantically(memory, board().active_step_id)
  assert.equal(fuel.decision.accepted, true)
  const verify = closeSemantically(memory, board().active_step_id)
  assert.equal(verify.decision.accepted, true)

  const { plan, completed } = trackerProgress(memory)
  assert.equal(completed, 3)
  assert.equal(plan.active_step_index, 3)
  assert.equal(board().completed_count, 4, 'carried step 1 plus three closed steps')
  assert.equal(board().active_index, 4)
  assert.equal(plan.status, PLAN_STATUS.EXECUTING)
  assert.equal(plan.execution.step_progress[plan.steps[0].step_id].accepted_evidence[0].ref, `checkpoint/${board().steps[1].id}`)

  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const restoredBoard = restored.currentPlan(KEY).task_board
  const restoredPlan = getActivePlan(restored.planningState(KEY))
  assert.equal(restoredBoard.completed_count, 4, 'the board still shows the closed steps')
  assert.equal(restoredBoard.active_index, 4)
  assert.equal(restoredPlan.active_step_index, 3)
  assert.equal(boardPlanAlignment(restoredBoard, restoredPlan), 1)
  assert.deepEqual(restored.restoreDiagnostics, [])
})

test('the reducer refuses a step close it cannot verify, and the board does not move', () => {
  const memory = new CanonicalTaskBoardMemory()
  const contracted = boardOf([
    { id: 'step_1', description: 'Gather coal', status: 'active', completion_contract: COAL_CONTRACT },
    { id: 'step_2', description: 'Build furnace', status: 'pending' },
  ], 0)
  memory.planByNpc.set(KEY, legacyState(contracted))
  memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 100 })
  memory.commitPlanningPlan(KEY, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  // The board loses the contract the reducer froze at commit: the two now
  // disagree on whether the step needs a deterministic proof.
  const state = memory.planByNpc.get(KEY)
  state.task_board = { ...state.task_board, steps: state.task_board.steps.map(step => ({ ...step, completion_contract: undefined })) }

  const claim = closeSemantically(memory, 'step_1')

  assert.equal(claim.decision.accepted, false)
  assert.equal(claim.decision.rejection_reason, 'reducer_declined_step_close')
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 0)
  assert.equal(memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(trackerProgress(memory).completed, 0)
})

test('a blocked plan stays blocked: no step close unfreezes it', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(KEY, legacyState(boardOf([
    { id: 'step_1', description: 'Gather coal', status: 'active' },
    { id: 'step_2', description: 'Build furnace', status: 'pending' },
  ], 0)))
  memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 100 })
  memory.commitPlanningPlan(KEY, { now: 110, runtime_validation: RUNTIME_VALIDATED })
  memory.applyOutcomeAuthority(KEY, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'path_blocked',
    candidate_blocker: 'path_blocked',
    evidence: [{ kind: 'fresh_world_observation', ref: 'block_1', summary: 'blocked' }],
  })
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)

  const closed = memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'late_verification',
    evidence: [{ kind: 'verified_world_state', ref: 'checkpoint/step_1', summary: '{}' }],
    metadata: { scope: 'step' },
  })

  assert.equal(closed.decision.accepted, false)
  assert.equal(closed.decision.rejection_reason, 'plan_blocked')
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)
  assert.equal(memory.currentPlan(KEY).status, 'blocked')
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 0)
})

test('the Main LLM cannot advance the tracker except through a grounded semantic claim on an uncontracted step', () => {
  const memory = reviseAfterBlocker()
  const stepId = memory.currentPlan(KEY).task_board.active_step_id
  // The coal step has a deterministic contract, so a planner claim is barred.
  const claim = closeSemantically(memory, stepId)
  assert.equal(claim.decision.accepted, false)
  assert.equal(claim.decision.rejection_reason, 'reducer_declined_step_close')
  assert.equal(trackerProgress(memory).completed, 0)
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 1)
})

test('a sync never moves the board backwards, and lifts a board that trails the reducer', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(KEY, legacyState(boardOf([
    { id: 'step_1', description: 'Gather coal', status: 'active' },
    { id: 'step_2', description: 'Build furnace', status: 'pending' },
    { id: 'step_3', description: 'Craft drill', status: 'pending' },
  ], 0)))
  memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 100 })
  memory.commitPlanningPlan(KEY, { now: 110, runtime_validation: RUNTIME_VALIDATED })

  // The reducer is ahead: the board trails and is lifted to it.
  let planning = memory.planningState(KEY)
  const first = getActivePlan(planning).steps[0].step_id
  planning = applyPlanningEvent(planning, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: 120,
    plan_id: getActivePlan(planning).plan_id,
    step_id: first,
    evidence: { source: 'runtime', kind: 'outcome_authority', ref: 'proof_1', contract_satisfied: true },
  })
  planning = applyPlanningEvent(planning, {
    type: PLANNING_EVENT.STEP_COMPLETED,
    now: 121,
    source: 'runtime',
    plan_id: getActivePlan(planning).plan_id,
    step_id: first,
  })
  memory.planningByNpc.set(KEY, planning)
  memory.syncPlanningState(KEY)
  assert.equal(memory.currentPlan(KEY).task_board.completed_count, 1)
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 1)

  // The board is ahead: a sync leaves it where it is.
  const state = memory.planByNpc.get(KEY)
  state.task_board = boardOf([
    { id: 'step_1', description: 'Gather coal', status: 'completed' },
    { id: 'step_2', description: 'Build furnace', status: 'completed' },
    { id: 'step_3', description: 'Craft drill', status: 'active' },
  ], 2)
  memory.syncPlanningState(KEY, state)
  assert.equal(memory.currentPlan(KEY).task_board.completed_count, 2)
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 2)
})

// The persisted state of the live run: the board holds four closed steps while
// the reducer's revised plan sits on its second step.
function liveSnapshot(mutate) {
  const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/revised-plan-progress-lag.snapshot.json', import.meta.url), 'utf8'))
  mutate?.(snapshot)
  return snapshot
}

test('live snapshot: restore lifts the reducer to the board\'s verified steps and never regresses the board', () => {
  const before = getActivePlan(liveSnapshotPlanning(liveSnapshot()))
  assert.equal(before.active_step_index, 1, 'the fixture is the lagging state')

  const memory = new CanonicalTaskBoardMemory()
  memory.restore(liveSnapshot())
  const board = memory.currentPlan(KEY).task_board
  const plan = getActivePlan(memory.planningState(KEY))

  assert.equal(board.completed_count, 4)
  assert.equal(board.active_index, 4)
  assert.equal(plan.active_step_index, 4, 'the reducer converged forward to the board')
  const completed = plan.steps.filter(step => plan.execution.step_progress[step.step_id]?.status === 'completed')
  assert.equal(completed.length, 4)
  const coal = plan.execution.step_progress[plan.steps[1].step_id]
  assert.equal(coal.accepted_evidence.at(-1).ref, 'checkpoint/step_2_r10', 'closed on the board\'s deterministic checkpoint proof')
  assert.equal(memory.planningTrackerView(KEY).verified_completed_step_ids.length, 4)
  assert.equal(plan.status, PLAN_STATUS.EXECUTING)
  assert.deepEqual(memory.restoreDiagnostics, [])
})

test('live snapshot: a step the board closed without provable evidence is left and traced, and the board keeps its progress', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(liveSnapshot((snapshot) => {
    const board = snapshot.plans[0].state.task_board
    // Drop the fresh-observation claims that closed the two semantic steps.
    board.evidence = board.evidence.filter(item => !String(item.ref).includes('semantic_fresh_observation'))
  }))
  const board = memory.currentPlan(KEY).task_board
  const plan = getActivePlan(memory.planningState(KEY))

  assert.equal(board.completed_count, 4, 'the board is not regressed to the reducer')
  assert.equal(board.active_index, 4)
  assert.equal(plan.active_step_index, 2, 'only the contract-verified coal step could be replayed')
  assert.equal(memory.restoreDiagnostics.length, 1)
  assert.equal(memory.restoreDiagnostics[0].code, 'board_completed_step_unverified')
  assert.equal(memory.restoreDiagnostics[0].board_step_id, 'step_3_r10')
})

test('live snapshot: the disagreement does not let a close on the wrong step through', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(liveSnapshot((snapshot) => {
    snapshot.plans[0].state.task_board.evidence = []
  }))
  const plan = getActivePlan(memory.planningState(KEY))
  assert.equal(plan.active_step_index, 1)
  // Board is on step_4 while the plan is on its coal step: the reducer cannot
  // vouch for a close made on the board's own step, so it records nothing and
  // the disagreement is returned for tracing.
  const result = memory.applyOutcomeAuthority(KEY, {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'deterministic_completion_contract',
    evidence: [{ kind: 'verified_world_state', ref: 'checkpoint/step_4', summary: '{}' }],
    metadata: { scope: 'step' },
  })
  assert.equal(result.decision.accepted, true)
  assert.equal(result.progressDisagreement.code, 'plan_behind_board')
  assert.equal(getActivePlan(memory.planningState(KEY)).active_step_index, 1, 'the reducer did not close a step for evidence gathered elsewhere')
})

// The reducer state exactly as persisted: restore without the board, so no
// board-driven convergence runs.
function liveSnapshotPlanning(snapshot) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore({ ...snapshot, plans: [] })
  return memory.planningState(KEY)
}
