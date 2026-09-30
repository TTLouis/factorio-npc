import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { makeConditionWait } from './step-completion.mjs'
import { pauseChatLine } from './supervisor.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  GOAL_STATUS,
  PLAN_STATUS,
  PLANNING_EVENT,
  restorePlanningState,
  RUN_STATE_LIMITS,
  serializePlanningState,
} from './planning-state.mjs'

const KEY = 'npc:sgluna'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class PlanningRcon {
  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","goal_progress_facts"')) {
      return JSON.stringify({ ok: true, rockets_launched: 0, researched_technologies: 0, enabled_technologies: 200, milestones: [] })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

function proposedPlan(steps, currentStep = 0, operations = [{ name: 'wait', args: { ticks: 1 } }]) {
  return { chatMessage: 'Working.', plan: steps, currentStep, operations }
}

// --- move 1: goal admission through the reducer ---------------------------

test('new_goal admits the goal through GOAL_ACCEPTED with no steering provider, and legacy takes the reducer id', async () => {
  const memory = new CanonicalTaskBoardMemory()
  let goalSeenByPlanner
  const agent = new NpcAgentLoop({
    rcon: new PlanningRcon(),
    memory,
    provider: async () => {
      goalSeenByPlanner = memory.planningState(KEY)?.goal
      return {
        content: JSON.stringify({
          chatMessage: 'Starting.',
          plan: ['Wait a moment'],
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        }),
      }
    },
    systemPrompt: 'goal admission without steering provider',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  assert.equal(agent.steeringDecisionProvider ?? null, null, 'this test must run without a steering provider')

  await agent.request('build an early factory', { sender: 'Louis' })

  assert.equal(goalSeenByPlanner?.status, GOAL_STATUS.ACTIVE, 'the reducer holds the goal before the first planner turn')
  const reducerGoal = memory.planningState(KEY).goal
  assert.equal(reducerGoal.objective, 'build an early factory')
  assert.equal(reducerGoal.owner, 'Louis')
  assert.equal(memory.currentPlan(KEY).goal_id, reducerGoal.goal_id, 'legacy record takes the reducer goal id')
  assert.match(reducerGoal.goal_id, /^goal_[0-9a-z]{7}_\d+$/, 'the id is the reducer-minted shape, not the legacy time-based one')
})

test('admitPlanningGoal lets the reducer mint the goal id', () => {
  const memory = new CanonicalTaskBoardMemory()
  const planning = memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Make iron plates', now: 1000 })
  assert.match(planning.goal.goal_id, /^goal_[0-9a-z]{7}_\d+$/)
  const pinned = new CanonicalTaskBoardMemory().admitPlanningGoal(KEY, {
    owner: 'Louis',
    objective: 'Make iron plates',
    goalId: 'goal_pinned',
    now: 1000,
  })
  assert.equal(pinned.goal.goal_id, 'goal_pinned')
})

test('recordPlan does not mint a legacy goal id: the reducer admits the goal first', () => {
  const memory = new CanonicalTaskBoardMemory()
  const result = memory.recordPlan(KEY, { sender: 'Louis', text: 'Make iron plates' }, proposedPlan(['Mine ore', 'Smelt ore']))
  assert.ok(result.state)
  const reducerGoal = memory.planningState(KEY).goal
  assert.equal(result.state.goal_id, reducerGoal.goal_id)
  assert.match(reducerGoal.goal_id, /^goal_[0-9a-z]{7}_\d+$/)
  assert.equal(reducerGoal.owner, 'Louis')
  assert.equal(reducerGoal.status, GOAL_STATUS.ACTIVE)
})

test('beginActionOmissionRecovery takes the reducer goal id instead of minting one', () => {
  const memory = new CanonicalTaskBoardMemory()
  const state = memory.beginActionOmissionRecovery(KEY, { sender: 'Louis', text: 'Craft a furnace' }, { plan: ['Craft the furnace'], chatMessage: 'Crafting.' })
  assert.ok(state)
  assert.equal(state.admission_status, 'action_omission_repair')
  const reducerGoal = memory.planningState(KEY).goal
  assert.equal(state.goal_id, reducerGoal.goal_id)
  assert.match(reducerGoal.goal_id, /^goal_[0-9a-z]{7}_\d+$/)
  assert.equal(reducerGoal.objective, 'Craft a furnace')
})

test('beginActionOmissionRecovery keeps working when the reducer refuses an empty objective', () => {
  const memory = new CanonicalTaskBoardMemory()
  const state = memory.beginActionOmissionRecovery(KEY, { sender: 'Louis', text: '' }, { plan: ['Craft the furnace'] })
  assert.ok(state, 'the standalone fallback id keeps the legacy record valid')
  assert.equal(memory.planningState(KEY), undefined, 'no reducer goal is invented for an empty objective')
})

test('a cancelled goal is replaced by a fresh reducer goal, not silently reused', () => {
  const memory = new CanonicalTaskBoardMemory()
  const first = memory.recordPlan(KEY, { sender: 'Louis', text: 'Make iron plates' }, proposedPlan(['Mine ore']))
  memory.commitPlanningPlan(KEY, { now: 5, runtime_validation: { passed: true } })
  const firstGoalId = first.state.goal_id
  memory.terminatePlan(KEY)
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.CANCELLED)
  const second = memory.recordPlan(KEY, { sender: 'Louis', text: 'Make copper plates' }, proposedPlan(['Mine copper']))
  assert.notEqual(second.state.goal_id, firstGoalId)
  assert.equal(memory.planningState(KEY).goal.goal_id, second.state.goal_id)
  assert.equal(memory.planningState(KEY).goal.objective, 'Make copper plates')
})

test('GOAL_ACCEPTED without a supplied id mints a deterministic id', () => {
  const event = { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1234, owner: 'Louis', objective: 'Make iron plates' }
  const a = applyPlanningEvent(createEmptyPlanningState(), event)
  const b = applyPlanningEvent(createEmptyPlanningState(), event)
  assert.equal(a.goal.goal_id, b.goal.goal_id)
})

// --- move 3: run-state events ----------------------------------------------

function startCommittedPlan(memory, key = KEY, text = 'Build early automation') {
  const request = { sender: 'Louis', text }
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, request, plan)
  memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(key, { now: 100, runtime_validation: { passed: true } })
  return { request, plan, state: memory.currentPlan(key) }
}

function block(memory, key = KEY) {
  return memory.applyOutcomeAuthority(key, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'operation_preflight_failed:missing_dependency',
    candidate_blocker: 'operation_preflight_failed:missing_dependency',
    evidence: [{
      kind: 'operation_preflight_blocker',
      ref: 'preflight_missing_dependency',
      summary: 'Required dependency cannot be satisfied by the committed route.',
    }],
  }).state
}

function goalState(objective = 'Make iron plates') {
  return applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now: 10,
    goal_id: 'goal_run',
    owner: 'Louis',
    objective,
  })
}

function withDraftCommitted(state) {
  const drafted = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    steps: [{ description: 'Mine ore' }, { description: 'Smelt ore' }],
  })
  return applyPlanningEvent(drafted, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now: 30,
    plan_id: getActivePlan(drafted).plan_id,
    runtime_validation: { passed: true },
  })
}

function planShape(state) {
  const plan = getActivePlan(state)
  return JSON.stringify({
    plans: state.plans,
    active_plan_id: state.active_plan_id,
    active_step_index: plan.active_step_index,
    status: plan.status,
    blocker: plan.blocker,
    goal: state.goal,
    roadmap: state.roadmap,
  })
}

function waitFor(goalId, overrides = {}) {
  return makeConditionWait(
    { kind: 'entity_state', unit_number: 582, expected: 'working' },
    { goalId, stepId: 'step_1', actorId: 18, actorEpoch: 3, mode: 'passive_progress', ...overrides },
  )
}

test('RUN_PAUSED then RUN_RESUMED leaves plan, step, blocker and approval state untouched', () => {
  const committed = withDraftCommitted(goalState())
  const before = planShape(committed)
  const paused = applyPlanningEvent(committed, { type: PLANNING_EVENT.RUN_PAUSED, now: 40, source: 'runtime', reason: 'user_stop' })
  assert.equal(paused.run.paused, true)
  assert.equal(planShape(paused), before, 'pausing does not touch plans')
  const resumed = applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_RESUMED, now: 50, source: 'runtime', reason: 'plan_recorded' })
  assert.equal(resumed.run.paused, false)
  assert.equal(resumed.run.pause_reason, '')
  assert.equal(resumed.run.pause_count, 1)
  assert.equal(planShape(resumed), before, 'a pause -> resume round trip changes no plan semantics')
})

test('a BLOCKED plan stays BLOCKED, with the same blocker, across pause and resume', () => {
  const committed = withDraftCommitted(goalState())
  const plan = getActivePlan(committed)
  const blocked = applyPlanningEvent(committed, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 40,
    source: 'runtime',
    plan_id: plan.plan_id,
    reason_code: 'missing_dependency',
    evidence_refs: ['ref_a'],
    detail: 'no route',
  })
  assert.equal(getActivePlan(blocked).status, PLAN_STATUS.BLOCKED)
  const before = planShape(blocked)
  const paused = applyPlanningEvent(blocked, { type: PLANNING_EVENT.RUN_PAUSED, now: 50, source: 'user', reason: 'user_stop' })
  const resumed = applyPlanningEvent(paused, { type: PLANNING_EVENT.RUN_RESUMED, now: 60, source: 'user' })
  assert.equal(planShape(paused), before)
  assert.equal(planShape(resumed), before)
  assert.equal(getActivePlan(resumed).status, PLAN_STATUS.BLOCKED)
})

test('pause keeps the reason text and its provider_transient prefix, and derives a bounded reason code', () => {
  const state = goalState()
  const reason = 'provider_transient: Hourly provider request budget reached'
  const paused = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason })
  assert.equal(paused.run.pause_reason, reason)
  assert.equal(paused.run.pause_code, 'provider_transient')
  assert.ok(paused.run.pause_reason.startsWith('provider_transient:'))
  const long = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason: `request_failed: ${'x'.repeat(2000)}` })
  assert.equal(long.run.pause_reason.length, 300)
  assert.equal(long.run.pause_code, 'request_failed')
  const explicit = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason: 'anything', reason_code: 'budget_cap' })
  assert.equal(explicit.run.pause_code, 'budget_cap')
})

test('run events are refused from the planner, Jev, another goal, or without an active goal', () => {
  const state = goalState()
  for (const source of ['main_planner', 'jev', 'planner', '', undefined]) {
    const next = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source, reason: 'x' })
    assert.equal(next, state, `source ${String(source)} must not pause the run`)
  }
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', goal_id: 'goal_other', reason: 'x' }), state, 'stale goal id fails closed')
  const empty = createEmptyPlanningState()
  assert.equal(applyPlanningEvent(empty, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason: 'x' }), empty)
  const satisfied = applyPlanningEvent(state, { type: PLANNING_EVENT.GOAL_SATISFIED, now: 25, source: 'user', evidence_refs: ['e1'] })
  assert.equal(applyPlanningEvent(satisfied, { type: PLANNING_EVENT.RUN_PAUSED, now: 30, source: 'runtime', reason: 'x' }), satisfied)
})

test('RUN_RESUMED is a no-op when the run is not paused', () => {
  const state = goalState()
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_RESUMED, now: 20, source: 'runtime' }), state)
})

test('pause clears condition_wait and persistent_runtime but keeps provider_recovery', () => {
  let state = goalState()
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 20, source: 'runtime', wait: waitFor('goal_run') })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED, now: 21, source: 'runtime', runtime: { kind: 'follow', active: true } })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PROVIDER_RECOVERY_RECORDED, now: 22, source: 'runtime', recovery: { kind: 'budget_handoff', phase: 'planner_pending' } })
  assert.ok(state.run.condition_wait && state.run.persistent_runtime && state.run.provider_recovery)
  const paused = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 30, source: 'runtime', reason: 'user_stop' })
  assert.equal(paused.run.condition_wait, null)
  assert.equal(paused.run.persistent_runtime, null)
  assert.equal(paused.run.provider_recovery?.kind, 'budget_handoff')
})

test('a paused run refuses a new condition wait or follow runtime; a wait for another goal is stale', () => {
  const paused = applyPlanningEvent(goalState(), { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason: 'user_stop' })
  assert.equal(applyPlanningEvent(paused, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 21, source: 'runtime', wait: waitFor('goal_run') }), paused)
  assert.equal(applyPlanningEvent(paused, { type: PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED, now: 21, source: 'runtime', runtime: { kind: 'follow' } }), paused)
  const running = goalState()
  assert.equal(applyPlanningEvent(running, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 21, source: 'runtime', wait: waitFor('goal_other') }), running)
})

test('null clears a run record; a clear naming another wait id is ignored', () => {
  let state = applyPlanningEvent(goalState(), { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 20, source: 'runtime', wait: waitFor('goal_run', { id: 'wait_a' }) })
  assert.equal(state.run.condition_wait.id, 'wait_a')
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 21, source: 'runtime', wait: null, wait_id: 'wait_b' }), state)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, now: 22, source: 'runtime', wait: null, wait_id: 'wait_a' })
  assert.equal(state.run.condition_wait, null)
})

test('run records are bounded: long strings, deep nesting and huge lists are capped', () => {
  const huge = {
    kind: 'follow',
    note: 'y'.repeat(50_000),
    many: Array.from({ length: 500 }, (_, index) => index),
    keys: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index])),
    deep: { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } },
    nan: Number.NaN,
    drop: undefined,
  }
  const state = applyPlanningEvent(goalState(), { type: PLANNING_EVENT.PERSISTENT_RUNTIME_RECORDED, now: 20, source: 'runtime', runtime: huge })
  const stored = state.run.persistent_runtime
  assert.equal(stored.note.length, RUN_STATE_LIMITS.valueString)
  assert.equal(stored.many.length, RUN_STATE_LIMITS.valueItems)
  assert.equal(Object.keys(stored.keys).length, RUN_STATE_LIMITS.valueKeys)
  assert.ok(!('drop' in stored))
  assert.equal(JSON.stringify(stored).includes('"h"'), false, 'depth is capped')
  assert.equal(JSON.parse(JSON.stringify(stored)).nan, null)
})

test('run state persists in the snapshot and an old snapshot without it restores to null', () => {
  let state = goalState()
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.RUN_PAUSED, now: 20, source: 'runtime', reason: 'provider_transient: budget' })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PROVIDER_RECOVERY_RECORDED, now: 21, source: 'runtime', recovery: { kind: 'budget_handoff', phase: 'planner_pending' } })
  const serialized = JSON.parse(JSON.stringify(serializePlanningState(state)))
  const restored = restorePlanningState(serialized)
  assert.deepEqual(restored.run, state.run)
  assert.equal(restored.run.paused, true)
  assert.deepEqual(serializePlanningState(restored), serializePlanningState(state))

  const { run: _run, ...old } = serialized
  assert.equal(restorePlanningState(old).run, null, 'a pre-run snapshot restores to no run rather than a fabricated empty one')
})

// --- move 3: memory facade (reducer writes, legacy mirrors) -----------------

test('facade pause: reducer records the run, legacy mirrors it with the transient prefix, plan is unchanged', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory)
  const reducerBefore = planShape(memory.planningState(KEY))
  const legacyBefore = memory.currentPlan(KEY)
  const stepBefore = legacyBefore.task_board.active_index

  const reason = 'provider_transient: Hourly provider request budget reached'
  const paused = memory.pausePlan(KEY, reason)
  assert.equal(paused.status, 'paused')
  assert.equal(paused.pause_reason, reason, 'the legacy mirror keeps the exact text, prefix included')
  const run = memory.planningState(KEY).run
  assert.equal(run.paused, true)
  assert.equal(run.pause_reason, reason)
  assert.equal(run.pause_code, 'provider_transient')
  assert.equal(planShape(memory.planningState(KEY)), reducerBefore)
  assert.equal(paused.task_board.active_index, stepBefore)
})

test('facade resume: recording a plan with operations resumes the run and mirrors it back', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { request, plan } = startCommittedPlan(memory)
  memory.pausePlan(KEY, 'user_stop')
  assert.equal(memory.planningState(KEY).run.paused, true)
  const shapeWhilePaused = planShape(memory.planningState(KEY))

  const recorded = memory.recordPlan(KEY, request, plan, { continuation: true })
  assert.equal(recorded.state.status, 'active')
  assert.equal(recorded.state.pause_reason, '')
  const run = memory.planningState(KEY).run
  assert.equal(run.paused, false)
  assert.equal(run.pause_count, 1)
  assert.equal(run.pause_reason, '')
  assert.equal(planShape(memory.planningState(KEY)), shapeWhilePaused, 'resume does not change plan semantics')
})

test('facade pause on a BLOCKED plan: reducer and legacy both stay blocked, the pause is recorded', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory)
  block(memory)
  const planBefore = getActivePlan(memory.planningState(KEY))
  assert.equal(planBefore.status, PLAN_STATUS.BLOCKED)
  const shapeBefore = planShape(memory.planningState(KEY))

  const after = memory.pausePlan(KEY, 'user_stop')
  assert.equal(after.status, 'blocked', 'the legacy record must not drift from BLOCKED to paused')
  assert.match(after.blocker, /missing_dependency/)
  assert.equal(memory.planningState(KEY).run.paused, true)
  assert.equal(planShape(memory.planningState(KEY)), shapeBefore)
  assert.equal(getActivePlan(memory.planningState(KEY)).status, PLAN_STATUS.BLOCKED)
})

test('facade condition wait: register, update and clear go through the reducer and mirror to legacy', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { state } = startCommittedPlan(memory)
  const stepId = state.task_board.active_step_id
  const wait = waitFor(state.goal_id, { stepId })
  const registered = memory.registerConditionWait(KEY, wait)
  assert.equal(registered.condition_wait.id, wait.id)
  const reducerWait = memory.planningState(KEY).run.condition_wait
  assert.equal(reducerWait.id, wait.id)
  assert.deepEqual(registered.condition_wait, reducerWait, 'legacy mirrors the reducer value')
  assert.notEqual(registered.condition_wait, reducerWait, 'the mirror is a copy, not shared state')

  const polled = { ...wait, checks: 3, updated_at: wait.updated_at + 5 }
  memory.updateConditionWait(KEY, polled)
  assert.equal(memory.planningState(KEY).run.condition_wait.checks, 3)
  assert.equal(memory.currentPlan(KEY).condition_wait.checks, 3)

  memory.updateConditionWait(KEY, { ...polled, state: 'verified' })
  assert.equal(memory.planningState(KEY).run.condition_wait, null)
  assert.equal(memory.currentPlan(KEY).condition_wait, undefined)

  memory.registerConditionWait(KEY, wait)
  memory.clearConditionWait(KEY, 'wrong_id')
  assert.ok(memory.planningState(KEY).run.condition_wait, 'a clear naming another wait is ignored')
  memory.clearConditionWait(KEY, wait.id)
  assert.equal(memory.planningState(KEY).run.condition_wait, null)
})

test('facade pause clears the wait in both stores', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { state } = startCommittedPlan(memory)
  memory.registerConditionWait(KEY, waitFor(state.goal_id, { stepId: state.task_board.active_step_id }))
  assert.ok(memory.planningState(KEY).run.condition_wait)
  memory.pausePlan(KEY, 'user_stop')
  assert.equal(memory.planningState(KEY).run.condition_wait, null)
  assert.equal(memory.currentPlan(KEY).condition_wait, undefined)
})

test('facade provider recovery: budget handoff is reducer-owned and survives pause', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory)
  const set = memory.setProviderRecovery(KEY, { kind: 'budget_handoff', semantic_scope: 'keep_target', route: 'wake_planner', reason: 'cap' })
  assert.equal(set.provider_recovery.kind, 'budget_handoff')
  assert.equal(memory.planningState(KEY).run.provider_recovery.kind, 'budget_handoff')
  memory.pausePlan(KEY, 'provider_transient: cap')
  assert.equal(memory.planningState(KEY).run.provider_recovery.kind, 'budget_handoff')
  assert.equal(memory.currentPlan(KEY).provider_recovery.kind, 'budget_handoff')
  memory.setProviderRecovery(KEY, undefined)
  assert.equal(memory.planningState(KEY).run.provider_recovery, null)
  assert.equal(memory.currentPlan(KEY).provider_recovery, undefined)
})

test('facade persistent runtime: a healthy follow runtime is recorded through the reducer', () => {
  const memory = new CanonicalTaskBoardMemory()
  const request = { sender: 'Louis', text: 'follow me' }
  const runtime = { kind: 'follow', active: true, healthy: true, controller_live: true, state: 'following', target_player: 'Louis' }
  const result = memory.recordPlan(KEY, request, { chatMessage: 'Following.', plan: ['Follow Louis'], currentStep: 0, operations: [] }, { persistentRuntime: runtime })
  assert.equal(result.persistentRuntimeActive, true)
  assert.equal(memory.planningState(KEY).run.persistent_runtime.target_player, 'Louis')
  assert.deepEqual(result.state.persistent_runtime, memory.planningState(KEY).run.persistent_runtime)
})

test('a run record for another goal is refused: stale work after a replacement fails safely', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { state } = startCommittedPlan(memory)
  const staleWait = waitFor('goal_from_a_replaced_goal', { stepId: state.task_board.active_step_id })
  assert.equal(memory.registerConditionWait(KEY, staleWait), undefined, 'the legacy goal check rejects it')
  assert.equal(memory.planningState(KEY).run?.condition_wait ?? null, null)
})

test('old snapshot without run state: the run is derived once from the legacy record', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { state } = startCommittedPlan(memory)
  memory.registerConditionWait(KEY, waitFor(state.goal_id, { stepId: state.task_board.active_step_id }))
  memory.setProviderRecovery(KEY, { kind: 'budget_handoff', semantic_scope: 'keep_target', route: 'wake_planner', reason: 'cap' })
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  assert.ok(snapshot.planning_states[0].state.run, 'a new snapshot carries the run')
  delete snapshot.planning_states[0].state.run

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const run = restored.planningState(KEY).run
  assert.ok(run, 'derived from the legacy fields')
  assert.equal(run.condition_wait.id, restored.currentPlan(KEY).condition_wait.id)
  assert.equal(run.provider_recovery.kind, 'budget_handoff')
  assert.equal(run.paused, false)
  assert.equal(restored.currentPlan(KEY).condition_wait.state, 'active', 'legacy readers still see the wait')
})

test('old snapshot of a paused goal: the pause and its transient prefix are seeded from legacy', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory)
  const reason = 'provider_transient: Hourly provider request budget reached'
  memory.pausePlan(KEY, reason)
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  delete snapshot.planning_states[0].state.run

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const run = restored.planningState(KEY).run
  assert.equal(run.paused, true)
  assert.equal(run.pause_reason, reason)
  assert.equal(run.pause_code, 'provider_transient')
  assert.equal(restored.currentPlan(KEY).status, 'paused')
  assert.equal(restored.currentPlan(KEY).pause_reason, reason)
})

// --- move 4: locators and stale identities ---------------------------------

function locatorEntry(unit, name = 'steel-chest', at = 1) {
  return { unit_number: unit, operation_name: 'move_items_exact', locator: { name, position: { x: unit, y: 0 }, role: 'Perform current action' }, recorded_at: at }
}

test('LOCATORS_RECORDED: durable operations replace, audit appends and is capped, stale identities union', () => {
  let state = goalState()
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.LOCATORS_RECORDED,
    now: 20,
    source: 'runtime',
    durable_last_operations: [{ name: 'move_items_exact', target_locator: { name: 'steel-chest' } }],
    exact_target_audit: [locatorEntry(1)],
    stale_unit_numbers: [7, 8],
  })
  assert.equal(state.run.locators.durable_last_operations.length, 1)
  assert.deepEqual(state.run.stale_exact_identities, [7, 8])

  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.LOCATORS_RECORDED,
    now: 21,
    source: 'runtime',
    durable_last_operations: [],
    exact_target_audit: [locatorEntry(2)],
    stale_unit_numbers: [8, 9, -1, 1.5, 'x'],
  })
  assert.deepEqual(state.run.locators.durable_last_operations, [], 'durable operations are replaced, not appended')
  assert.deepEqual(state.run.locators.exact_target_audit.map(entry => entry.unit_number), [1, 2], 'the audit appends')
  assert.deepEqual(state.run.stale_exact_identities, [7, 8, 9], 'a set: deduped, invalid ids dropped')

  const many = Array.from({ length: 80 }, (_, index) => locatorEntry(100 + index))
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.LOCATORS_RECORDED, now: 22, source: 'runtime', exact_target_audit: many })
  assert.equal(state.run.locators.exact_target_audit.length, RUN_STATE_LIMITS.exactTargetAudit)
  assert.equal(state.run.locators.exact_target_audit.at(-1).unit_number, 179, 'the newest entries are kept')

  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.LOCATORS_RECORDED,
    now: 23,
    source: 'runtime',
    exact_target_audit: [locatorEntry(5)],
    exact_target_audit_mode: 'replace',
  })
  assert.deepEqual(state.run.locators.exact_target_audit.map(entry => entry.unit_number), [5])
})

test('LOCATORS_RECORDED is bounded, drops malformed entries, and is refused from the planner or for another goal', () => {
  const state = goalState()
  const huge = applyPlanningEvent(state, {
    type: PLANNING_EVENT.LOCATORS_RECORDED,
    now: 20,
    source: 'runtime',
    exact_target_audit: [
      { unit_number: 'nope', locator: {} },
      null,
      { unit_number: 3, operation_name: 'o'.repeat(500), locator: { name: 'n'.repeat(9000) } },
    ],
    durable_last_operations: Array.from({ length: 100 }, (_, index) => ({ name: `op${index}` })),
    stale_unit_numbers: Array.from({ length: 400 }, (_, index) => index + 1),
  })
  assert.equal(huge.run.locators.exact_target_audit.length, 1)
  assert.equal(huge.run.locators.exact_target_audit[0].operation_name.length, 100)
  assert.equal(huge.run.locators.exact_target_audit[0].locator.name.length, RUN_STATE_LIMITS.valueString)
  assert.equal(huge.run.locators.durable_last_operations.length, RUN_STATE_LIMITS.durableOperations)
  assert.equal(huge.run.stale_exact_identities.length, RUN_STATE_LIMITS.staleIdentities)
  assert.equal(huge.run.stale_exact_identities.at(-1), 400)

  const event = { type: PLANNING_EVENT.LOCATORS_RECORDED, now: 20, exact_target_audit: [locatorEntry(1)], stale_unit_numbers: [1] }
  assert.equal(applyPlanningEvent(state, { ...event, source: 'main_planner' }), state)
  assert.equal(applyPlanningEvent(state, { ...event, source: 'jev' }), state)
  assert.equal(applyPlanningEvent(state, { ...event, source: 'runtime', goal_id: 'goal_other' }), state)
  assert.equal(applyPlanningEvent(state, { type: PLANNING_EVENT.LOCATORS_RECORDED, now: 20, source: 'runtime' }), state, 'an empty event changes nothing')
})

test('locators and stale identities survive snapshot and restore in the reducer', () => {
  let state = goalState()
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.LOCATORS_RECORDED,
    now: 20,
    source: 'runtime',
    durable_last_operations: [{ name: 'move_items_exact', target_locator: { name: 'steel-chest', position: { x: 3, y: 0 } } }],
    exact_target_audit: [locatorEntry(11)],
    stale_unit_numbers: [4412, 4413],
  })
  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(restored.run.locators, state.run.locators)
  assert.deepEqual(restored.run.stale_exact_identities, [4412, 4413])
})

test('facade recordPlan routes locators through the reducer and mirrors them to legacy', () => {
  const memory = new CanonicalTaskBoardMemory()
  const request = { sender: 'Louis', text: 'Move plates into the chest' }
  const durable = [{ name: 'move_items_exact', target_locator: { name: 'steel-chest', position: { x: 3, y: 0 } } }]
  const first = memory.recordPlan(KEY, request, proposedPlan(['Move plates']), {
    durableOperations: durable,
    exactTargetAudit: [locatorEntry(11)],
  })
  const locators = memory.planningState(KEY).run.locators
  assert.equal(locators.durable_last_operations[0].name, 'move_items_exact')
  assert.deepEqual(locators.exact_target_audit.map(entry => entry.unit_number), [11])
  assert.deepEqual(first.state.durable_last_operations, locators.durable_last_operations, 'legacy mirrors the reducer')
  assert.deepEqual(first.state.exact_target_audit, locators.exact_target_audit)
  assert.notEqual(first.state.exact_target_audit, locators.exact_target_audit, 'a copy, not shared')

  const second = memory.recordPlan(KEY, request, proposedPlan(['Move plates']), {
    continuation: true,
    exactTargetAudit: [locatorEntry(12)],
  })
  assert.deepEqual(memory.planningState(KEY).run.locators.exact_target_audit.map(entry => entry.unit_number), [11, 12])
  assert.deepEqual(second.state.exact_target_audit.map(entry => entry.unit_number), [11, 12])
  assert.deepEqual(second.state.durable_last_operations, [], 'a batch with no operations clears the durable list, as before')
  assert.match(memory.planContext(KEY), /steel-chest/, 'the model-facing entity references still come from the mirrored record')
})

test('facade carries a pre-reducer legacy audit over once instead of dropping it', () => {
  const memory = new CanonicalTaskBoardMemory()
  const request = { sender: 'Louis', text: 'Move plates into the chest' }
  memory.recordPlan(KEY, request, proposedPlan(['Move plates']))
  memory.currentPlan(KEY).exact_target_audit = [locatorEntry(21)]
  memory.recordPlan(KEY, request, proposedPlan(['Move plates']), { continuation: true, exactTargetAudit: [locatorEntry(22)] })
  assert.deepEqual(memory.planningState(KEY).run.locators.exact_target_audit.map(entry => entry.unit_number), [21, 22])
})

test('old snapshot: locators are derived once from the legacy record', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, { sender: 'Louis', text: 'Move plates' }, proposedPlan(['Move plates']), {
    durableOperations: [{ name: 'move_items_exact', target_locator: { name: 'steel-chest' } }],
    exactTargetAudit: [locatorEntry(31)],
  })
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  delete snapshot.planning_states[0].state.run

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const locators = restored.planningState(KEY).run.locators
  assert.deepEqual(locators.exact_target_audit.map(entry => entry.unit_number), [31])
  assert.equal(locators.durable_last_operations[0].name, 'move_items_exact')
  assert.equal(restored.currentPlan(KEY).exact_target_audit[0].unit_number, 31, 'legacy readers still see it')
})

test('locators survive a snapshot round trip through the reducer', () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, { sender: 'Louis', text: 'Move plates' }, proposedPlan(['Move plates']), {
    durableOperations: [{ name: 'move_items_exact', target_locator: { name: 'steel-chest' } }],
    exactTargetAudit: [locatorEntry(41)],
  })
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  assert.deepEqual(restored.planningState(KEY).run.locators, memory.planningState(KEY).run.locators)
  assert.deepEqual(restored.currentPlan(KEY).exact_target_audit.map(entry => entry.unit_number), [41])
})

function staleEvidence(unitNumber, ref) {
  return {
    kind: 'operation_preflight_recoverable',
    ref,
    summary: JSON.stringify({ code: 'stale_exact_target', operation_index: 0, operation: 'move_items_exact', identity: unitNumber, last_observed: { name: 'stone-furnace', position: { x: 12, y: -4 } } }),
  }
}

function committedAnyContract(memory) {
  const plan = proposedPlan(['Refuel the stone furnace', 'Craft gears', 'Build power'])
  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'Keep the furnace fed' }, plan)
  const reconciled = memory.reconcileTaskBoard(KEY, undefined, plan, recorded, { allowReplan: false })
  memory.setStepCompletionContract(KEY, reconciled.state.task_board.steps[0].id, {
    mode: 'any',
    confidence: 0.9,
    requirements: [
      { id: 'furnace_fuel', kind: 'entity_inventory_count', unit_number: 4412, item_name: 'coal', minimum: 5 },
      { id: 'furnace_alive', kind: 'entity_exists', unit_number: 4413 },
    ],
  }, { now: 90 })
  memory.commitPlanningPlan(KEY, { now: 100, runtime_validation: { passed: true } })
}

test('the stale-identity set lives in reducer state and survives a restart mid-proof', () => {
  const memory = new CanonicalTaskBoardMemory()
  committedAnyContract(memory)
  const stepId = getActivePlan(memory.planningState(KEY)).steps[0].step_id

  memory.recordBoardEvidence(KEY, staleEvidence(4412, 'request/stale_a'))
  assert.deepEqual(memory.planningState(KEY).run.stale_exact_identities, [4412])
  assert.equal(getActivePlan(memory.planningState(KEY)).execution.step_progress[stepId].unsatisfiable ?? null, null, 'one dead branch leaves the contract live')
  assert.equal(memory.staleExactIdentitiesByNpc, undefined, 'the side map no longer exists')

  // Restart between the two proofs.
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.deepEqual(restored.planningState(KEY).run.stale_exact_identities, [4412], 'the set survives the snapshot')

  restored.recordBoardEvidence(KEY, staleEvidence(4413, 'request/stale_b'))
  const after = getActivePlan(restored.planningState(KEY))
  assert.ok(after.execution.step_progress[stepId].unsatisfiable, 'the second proof combines with the first across the restart')
  assert.equal(after.status, PLAN_STATUS.BLOCKED)
  assert.deepEqual(restored.planningState(KEY).run.stale_exact_identities, [4412, 4413])
})

test('a fresh goal starts with no stale identities', () => {
  const memory = new CanonicalTaskBoardMemory()
  committedAnyContract(memory)
  memory.recordBoardEvidence(KEY, staleEvidence(4412, 'request/stale_a'))
  assert.equal(memory.planningState(KEY).run.stale_exact_identities.length, 1)
  memory.clearTaskContext(KEY)
  memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Something else', now: 5000 })
  assert.equal(memory.planningState(KEY).run, null)
})

// --- review follow-ups -------------------------------------------------------

test('pause chat line: a blocked plan is not announced as paused, and text says SGLuna', () => {
  const blockedLine = pauseChatLine({ status: 'blocked' })
  assert.match(blockedLine, /blocked and waiting for your Revise or Cancel/)
  assert.doesNotMatch(blockedLine, /Paused the current/)
  const blockedCancel = pauseChatLine({ status: 'blocked' }, { cancelledWork: true })
  assert.match(blockedCancel, /Revise or Cancel/)
  assert.match(blockedCancel, /cancelled active Autorio work/)
  assert.match(pauseChatLine({ status: 'paused' }), /^Paused the current SGLuna plan and stopped active work\./)
  assert.match(pauseChatLine(undefined, { cancelledWork: true }), /^Paused the current SGLuna plan and cancelled active Autorio work\./)
  for (const line of [blockedLine, blockedCancel, pauseChatLine({ status: 'paused' })]) assert.doesNotMatch(line, /AIRI/)
})

test('pausing a blocked plan traces no goal.paused: the legacy record stays blocked', () => {
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({
    rcon: new PlanningRcon(),
    memory,
    provider: async () => ({ content: '{}' }),
    systemPrompt: 'blocked pause trace',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  startCommittedPlan(memory)
  block(memory)
  assert.equal(memory.pausePlan(KEY, 'ui_pause').status, 'blocked')
  assert.equal(agent.goalPausedTrace('ui_pause'), undefined)
})

test('USER_REVISION_APPROVED clears run.paused; plan semantics come only from the revision', () => {
  const committed = withDraftCommitted(goalState())
  const plan = getActivePlan(committed)
  const blocked = applyPlanningEvent(committed, {
    type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
    now: 40,
    source: 'runtime',
    plan_id: plan.plan_id,
    reason_code: 'missing_dependency',
    evidence_refs: ['ref_a'],
    detail: 'no route',
  })
  const paused = applyPlanningEvent(blocked, { type: PLANNING_EVENT.RUN_PAUSED, now: 50, source: 'user', reason: 'ui_pause' })
  assert.equal(paused.run.paused, true)
  const revised = applyPlanningEvent(paused, {
    type: PLANNING_EVENT.USER_REVISION_APPROVED,
    now: 60,
    source: 'user',
    approved_by: 'Louis',
    plan_id: plan.plan_id,
    steps: [{ description: 'Mine ore' }, { description: 'Craft plates' }],
  })
  assert.notEqual(getActivePlan(revised).plan_id, plan.plan_id, 'a successor plan exists')
  assert.equal(revised.run.paused, false)
  assert.equal(revised.run.pause_reason, '')
  assert.equal(revised.run.pause_count, 1)
})

test('facade: block, pause, then a no-operations Revise leaves the run running', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory)
  block(memory)
  memory.pausePlan(KEY, 'ui_pause')
  assert.equal(memory.planningState(KEY).run.paused, true)
  memory.recordBlockedChoice(KEY, 'revise', 'Louis')
  const revision = memory.recordPlan(KEY, { sender: 'Louis', text: 'Mine ore instead' }, { chatMessage: 'Revised.', plan: ['Mine ore', 'Craft plates'], currentStep: 0, operations: [] })
  assert.equal(revision.userRevisionApproved, true)
  assert.equal(memory.planningState(KEY).run.paused, false)
})

test('a goal admitted for a legacy record with run state seeds the run, so a later mirror cannot null it', () => {
  const memory = new CanonicalTaskBoardMemory()
  const request = { sender: 'Louis', text: 'Keep watching the furnace' }
  const first = memory.recordPlan(KEY, request, proposedPlan(['Watch furnace']))
  const goalId = first.state.goal_id
  // A record that carries run state the reducer has never seen.
  const legacy = memory.currentPlan(KEY)
  legacy.provider_recovery = { kind: 'budget_handoff', phase: 'planner_pending', goal_id: goalId, step_id: 'step_1', semantic_scope: 'keep_target', route: 'wake_planner', reason: 'cap', budget_generation: 2, handoff_count: 1 }
  legacy.condition_wait = waitFor(goalId, { stepId: 'step_1' })
  memory.planningByNpc.delete(KEY)

  memory.ensurePlanningDraft(KEY, legacy, { now: 50 })
  const run = memory.planningState(KEY).run
  assert.equal(run.provider_recovery.kind, 'budget_handoff')
  assert.equal(run.condition_wait.id, legacy.condition_wait.id)

  // A chat-only continuation (no operations) keeps run state, and its locators
  // write is what used to create the run before it was seeded.
  const after = memory.recordPlan(KEY, request, proposedPlan(['Watch furnace'], 0, []), { continuation: true, exactTargetAudit: [locatorEntry(9)] })
  assert.equal(after.state.provider_recovery?.kind, 'budget_handoff', 'the mirror keeps the legacy recovery')
  assert.ok(after.state.condition_wait, 'the mirror keeps the legacy wait')
  assert.equal(memory.planningState(KEY).run.provider_recovery.kind, 'budget_handoff')
})

test('an orphan goal from a failed request does not capture a later, different request', () => {
  const memory = new CanonicalTaskBoardMemory()
  const orphan = memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Build X', now: 1000 })
  assert.equal(orphan.goal.objective, 'Build X')
  assert.equal(memory.currentPlan(KEY), undefined, 'the request failed before recordPlan: no legacy record, no plan')

  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'Mine iron' }, proposedPlan(['Mine iron ore']))
  const goal = memory.planningState(KEY).goal
  assert.equal(goal.objective, 'Mine iron', 'the reducer goal is the new request, not Build X')
  assert.notEqual(goal.goal_id, orphan.goal.goal_id)
  assert.equal(recorded.state.objective, 'Mine iron')
  assert.equal(recorded.state.goal_id, goal.goal_id)
})

test('admitPlanningGoal re-admits over an orphan with another objective, and reuses it for the same one', () => {
  const memory = new CanonicalTaskBoardMemory()
  const first = memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Build X', now: 1000 })
  const same = memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: '  Build   X ', now: 2000 })
  assert.equal(same.goal.goal_id, first.goal.goal_id, 'the same objective keeps the goal')
  const other = memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Mine iron', now: 3000 })
  assert.notEqual(other.goal.goal_id, first.goal.goal_id)
  assert.equal(other.goal.objective, 'Mine iron')
})

test('a goal with a legacy record or a plan is never treated as an orphan', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { request } = startCommittedPlan(memory)
  const goalId = memory.planningState(KEY).goal.goal_id
  assert.equal(memory.admitPlanningGoal(KEY, { owner: 'Louis', objective: 'Something unrelated', now: 5000 }).goal.goal_id, goalId)
  const amended = memory.recordPlan(KEY, { ...request, text: 'Also build power' }, proposedPlan(['Gather stone', 'Craft furnace', 'Build power']), { continuation: true })
  assert.equal(amended.state.goal_id, goalId)
  assert.equal(memory.planningState(KEY).goal.objective, request.text)
})

test('new snapshot: the run round-trips and the reducer wins over the legacy fields', () => {
  const memory = new CanonicalTaskBoardMemory()
  const { state } = startCommittedPlan(memory)
  memory.registerConditionWait(KEY, waitFor(state.goal_id, { stepId: state.task_board.active_step_id }))
  const before = memory.planningState(KEY).run
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  assert.deepEqual(restored.planningState(KEY).run, before)
  assert.deepEqual(restored.currentPlan(KEY).condition_wait, before.condition_wait)
})
