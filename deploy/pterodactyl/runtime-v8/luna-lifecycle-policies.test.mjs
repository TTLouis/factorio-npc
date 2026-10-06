import test from 'node:test'
import assert from 'node:assert/strict'
import { CanonicalTaskBoardMemory, completionFinalizationDecision } from './canonical-task-board-memory.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, PLANNING_EVENT, PLAN_STATUS, restorePlanningState, serializePlanningState, SHELF_NODE_STATUS } from './planning-state.mjs'
import { finalizeCompletedTaskBoundary } from './supervisor.mjs'

const KEY = 'npc:sgluna'
const STONE = { mode: 'all', requirements: [{ id: 'stone', kind: 'inventory_count', item_name: 'stone', minimum: 10 }] }
const request = { sender: 'Louis', text: 'Gather stone and inspect an approach', turnId: 1 }
const proposed = () => ({
  chatMessage: 'Gather then inspect', plan: ['Gather stone', 'Inspect a suitable approach'], currentStep: 0, operations: [{ name: 'gather_resource', args: { resource: 'stone', count: 10 } }],
  stepCompletions: [{ kind: 'deterministic', checkpoint: STONE }, { kind: 'semantic', rationale: 'Selecting an approach requires judgment after observing the site.' }],
})

test('new plan completion policies reach every canonical and projected step and survive restart', () => {
  const memory = new CanonicalTaskBoardMemory()
  const recorded = memory.recordPlan(KEY, request, proposed())
  const before = recorded.state.task_board
  memory.reconcileTaskBoard(KEY, before, proposed(), recorded)
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const canonical = getActivePlan(memory.planningState(KEY))
  assert.equal(canonical.status, PLAN_STATUS.COMMITTED)
  assert.equal(canonical.steps[0].completion_mode, 'deterministic')
  assert.equal(canonical.steps[0].completion_contract.requirements[0].minimum, 10)
  assert.equal(canonical.steps[1].completion_mode, 'semantic')
  assert.match(canonical.steps[1].semantic_rationale, /judgment/)
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  assert.deepEqual(getActivePlan(restored.planningState(KEY)).steps, canonical.steps)
  const board = restored.currentPlan(KEY).task_board
  assert.equal(board.steps[0].completion_mode, 'deterministic')
  assert.equal(board.steps[1].completion_mode, 'semantic')
  assert.equal(board.steps[1].semantic_rationale, canonical.steps[1].semantic_rationale)
})

test('completion policies can change in a draft but not in a committed continuation', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, request, proposed())
  const changed = proposed()
  changed.stepCompletions[0].checkpoint = { ...STONE, requirements: [{ ...STONE.requirements[0], minimum: 20 }] }
  memory.recordPlan(KEY, request, changed, { continuation: true })
  assert.equal(getActivePlan(memory.planningState(KEY)).steps[0].completion_contract.requirements[0].minimum, 20)
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  memory.recordPlan(KEY, request, proposed(), { continuation: true })
  assert.equal(getActivePlan(memory.planningState(KEY)).steps[0].completion_contract.requirements[0].minimum, 20)
  assert.equal(memory.currentPlan(KEY).task_board.steps[0].completion_contract.requirements[0].minimum, 20)
})

test('legacy committed plans retain their contract-free semantic meaning without policy migration', () => {
  const memory = new CanonicalTaskBoardMemory()
  const plan = proposed()
  delete plan.stepCompletions
  memory.recordPlan(KEY, request, plan)
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  for (const step of getActivePlan(restored.planningState(KEY)).steps) {
    assert.equal(step.completion_mode, undefined)
    assert.equal(step.completion_contract, null)
  }
})

test('fresh context recovery is runtime-owned and can be claimed once per goal across slices and restart', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, request, proposed())
  const goalId = memory.planningState(KEY).goal.goal_id
  const before = memory.planningState(KEY)
  assert.equal(applyPlanningEvent(before, { type: PLANNING_EVENT.FRESH_CONTEXT_RECOVERY_CLAIMED, source: 'main_planner', goal_id: goalId }), before)
  assert.equal(applyPlanningEvent(before, { type: PLANNING_EVENT.FRESH_CONTEXT_RECOVERY_CLAIMED, source: 'runtime', goal_id: 'other' }), before)
  assert.equal(memory.claimFreshContextRecovery(KEY, { requestId: 'req_recovery' }), true)
  assert.equal(memory.claimFreshContextRecovery(KEY), false)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.equal(restored.claimFreshContextRecovery(KEY), false)
  const changed = proposed()
  changed.plan = ['Another slice']
  changed.stepCompletions = [{ kind: 'semantic', rationale: 'This requires judgment.' }]
  restored.recordPlan(KEY, request, changed, { continuation: true })
  assert.equal(restored.planningState(KEY).goal.goal_id, goalId)
  assert.equal(restored.claimFreshContextRecovery(KEY), false)
})

test('canonical active goal fences a completed legacy slice and contradictory or stale finalization results', async () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, request, proposed())
  const goalId = memory.planningState(KEY).goal.goal_id
  const result = { goalId, taskBoard: { goal_id: goalId, status: 'completed' } }
  const calls = []
  const session = { npcId: 'sgluna', agent: { memory, activePlanKey: () => KEY,
    traceEvent: async (name, data) => calls.push({ name, data }), finalizeCompletedTaskContext: async () => calls.push('clear'),
  }, syncTaskBoardUi: async () => calls.push('sync'), clearTaskBoardUi: async () => calls.push('ui:clear') }
  assert.equal(await finalizeCompletedTaskBoundary(session, result), false)
  assert.deepEqual(calls.map(row => row.name), ['goal.finalization_refused'])
  assert.equal(calls[0].data.reason, 'canonical_goal_not_completed')
  assert.equal(memory.planningState(KEY).goal.goal_id, goalId)
  assert.equal(completionFinalizationDecision(memory, KEY, { ...result, goalStatus: 'completed' }).allowed, false)
  memory.recordGoalSatisfaction(KEY, { source: 'runtime', evidenceRefs: ['research/green'], rationale: 'World verified.' })
  assert.equal(completionFinalizationDecision(memory, KEY, { ...result, goalStatus: 'completed' }).allowed, true)
  assert.equal(completionFinalizationDecision(memory, KEY, { ...result, goalStatus: 'active' }).allowed, false)
  assert.equal(completionFinalizationDecision(memory, KEY, { ...result, goalId: 'stale_goal', goalStatus: 'completed' }).allowed, false)
  assert.equal(completionFinalizationDecision(memory, KEY, { ...result, goalStatus: 'completed', taskBoard: { goal_id: 'stale_goal', status: 'completed' } }).allowed, false)
  assert.equal(completionFinalizationDecision(memory, KEY, undefined).allowed, false)
  assert.equal(completionFinalizationDecision(new CanonicalTaskBoardMemory(), KEY, result).allowed, true)
})

test('unmeasured shelf intent retains partial progress after its smaller linked slice completes', () => {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, source: 'user', goal_id: 'green', objective: 'Unlock green science', now: 1 })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.ROADMAP_REVISED, source: 'user', now: 2, nodes: [
    { id: 'electronics', intent: 'Complete electronics trigger' },
    { id: 'labs', intent: 'Build labs', depends_on: ['electronics'] },
  ] })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 3, roadmap_node_ids: ['electronics'], steps: [{ description: 'Gather ore', completion_contract: STONE }] })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 4, runtime_validation: { passed: true } })
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED, now: 5, plan_id: plan.plan_id, step_id: plan.steps[0].step_id,
    evidence: { source: 'runtime', kind: 'verified_world_state', ref: 'counts/ore', satisfied_requirement_ids: ['stone'] } })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.STEP_COMPLETED, source: 'runtime', now: 6, plan_id: plan.plan_id, step_id: plan.steps[0].step_id })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMPLETED, source: 'runtime', now: 7, plan_id: plan.plan_id, verified_results: ['ten ore gathered'] })
  const node = state.roadmap.nodes.find(entry => entry.id === 'electronics')
  assert.equal(node.status, SHELF_NODE_STATUS.PARTIALLY_REALIZED)
  assert.deepEqual(node.verified_results, ['ten ore gathered'])
  assert.equal(state.roadmap.nodes.find(entry => entry.id === 'labs').status, SHELF_NODE_STATUS.TENTATIVE)
  assert.equal(state.goal.status, 'active')
  assert.deepEqual(restorePlanningState(serializePlanningState(state)).roadmap.nodes, state.roadmap.nodes)
})
