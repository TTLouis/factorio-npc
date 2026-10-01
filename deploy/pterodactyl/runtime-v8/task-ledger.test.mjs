import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_SCOPE, authorizationOf, MANDATE_KIND } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  applyPlanningEvent,
  classifyTaskInterruption,
  classifyTaskResume,
  createEmptyPlanningState,
  getActivePlan,
  PLAN_STATUS,
  PLANNING_EVENT,
  reasoningEpochOf,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'
import {
  mostRecentResumable,
  restoreTaskLedger,
  taskAging,
  taskLedgerOf,
  taskLedgerView,
  TASK_AGING,
  TASK_INTERRUPTION,
  TASK_LEDGER_LIMITS,
  TASK_LEDGER_REFUSAL,
  TASK_STATUS,
} from './task-ledger.mjs'

// MW2 (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3): the durable task ledger. Reducer, persistence and
// memory-facade tests: no provider, no Factorio, no Jev.

const KEY = 'npc:sgluna'
const ACTOR = { actor_id: 18, actor_epoch: 3 }
const STONE_CONTRACT = {
  mode: 'all',
  requirements: [{ id: 'req_stone', kind: 'inventory_count', item_name: 'stone', minimum: 10 }],
  confidence: 0.9,
}

const PLAYER_TASK = {
  mandate_kind: MANDATE_KIND.PLAYER_TASK,
  mandate_id: 'task_plates',
  task_id: 'task_plates',
  requested_result: { result_key: 'deliver:iron-plate:100', destination: 'chest:buffer-1' },
  permitted_scope: [ACTION_SCOPE.SUPPORTING_WORK, ACTION_SCOPE.RECOVERY],
  actor: ACTOR,
}

function goalState(goalId = 'goal_plates', objective = 'deliver 100 iron plates to the buffer chest', now = 1000) {
  return applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now,
    goal_id: goalId,
    owner: 'louis',
    objective,
  })
}

// A committed two-step plan with step 1 verified complete (verified history) and a receipt recorded.
function progressedState({ goalId = 'goal_plates', grant } = {}) {
  let state = goalState(goalId)
  if (grant) state = applyPlanningEvent(state, { type: PLANNING_EVENT.AUTHORIZATION_GRANTED, source: 'runtime', now: 1100, grant })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1200,
    steps: [
      { description: 'Acquire stone for furnaces', completion_contract: STONE_CONTRACT },
      { description: 'Mine iron ore and smelt plates' },
    ],
  })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true }, grant_check: ACTOR })
  const plan = getActivePlan(state)
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now: 1400,
    plan_id: plan.plan_id,
    step_id: plan.steps[0].step_id,
    evidence: { source: 'runtime', kind: 'deterministic_verification', ref: 'batch_7', batch_id: 7, satisfied_requirement_ids: ['req_stone'] },
  })
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.STEP_COMPLETED, now: 1500, source: 'runtime', plan_id: plan.plan_id, step_id: plan.steps[0].step_id })
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED,
    now: 1550,
    source: 'runtime',
    goal_id: goalId,
    kind: 'operation_receipt',
    ref: 'batch_8',
    summary: JSON.stringify({ outcome: 'completed', task_types: ['mining'], batch_id: 8 }),
  })
}

function interrupt(state, overrides = {}) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.TASK_INTERRUPTED,
    source: 'runtime',
    now: 2000,
    request_id: 'req_new_goal',
    interrupted_by: { kind: 'new_goal', sender: 'louis' },
    game_tick: 10_000,
    actor: { actor_id: 18, epoch: 3 },
    ...overrides,
  })
}

function ledgerTask(state, goalId = 'goal_plates') {
  return taskLedgerOf(state).tasks.find(task => task.goal_id === goalId)
}

test('interrupting the running task moves it into the ledger with progress, destination, authorization and reason', () => {
  const running = progressedState({ grant: PLAYER_TASK })
  const planBefore = getActivePlan(running)
  const state = interrupt(running)

  assert.equal(state.goal, null, 'a task is never both running and parked')
  assert.equal(getActivePlan(state), undefined)
  const task = ledgerTask(state)
  assert.equal(task.status, TASK_STATUS.INTERRUPTED)
  assert.equal(task.task_id, 'task:goal_plates')
  assert.equal(task.objective, 'deliver 100 iron plates to the buffer chest')
  assert.equal(task.requested_result.destination.description, 'chest:buffer-1')
  assert.equal(task.requested_result.result_key, 'deliver:iron-plate:100')
  assert.equal(task.authorization.grant_id, 'player_task:task_plates')
  assert.equal(task.authorization.grant_revision, 1)
  assert.equal(task.mandate_kind, MANDATE_KIND.PLAYER_TASK)
  assert.equal(task.temporary, true)
  assert.equal(task.progress.plan_id, planBefore.plan_id)
  assert.equal(task.progress.steps_total, 2)
  assert.equal(task.progress.steps_completed, 1)
  assert.deepEqual(task.progress.completed_step_ids, [planBefore.steps[0].step_id])
  assert.equal(task.progress.active_step_index, 1)
  assert.ok(task.progress.receipt_refs.includes('batch_8'))
  assert.equal(task.interruption.reason_code, TASK_INTERRUPTION.NEW_GOAL)
  assert.equal(task.interruption.state_at_interruption, 'active')
  assert.equal(task.interruption.interrupted_by.sender, 'louis')
  assert.equal(task.interruption.request_id, 'req_new_goal')
  assert.equal(task.interruption.game_tick, 10_000)
  assert.deepEqual(task.interruption.actor, { actor_id: 18, epoch: 3 })
  assert.ok(task.checkpoint, 'a started task holds a checkpoint to resume from')
  assert.ok(reasoningEpochOf(state) > reasoningEpochOf(running), 'the planner context is rebuilt from durable state')
})

test('a task interrupted before its first committed plan is kept as pending (nothing verified to lose)', () => {
  const state = interrupt(goalState())
  const task = ledgerTask(state)
  assert.equal(task.status, TASK_STATUS.PENDING)
  assert.equal(task.checkpoint, null)
  assert.equal(task.progress, null)
})

test('only runtime or user authority may interrupt, and only the running task', () => {
  const running = progressedState()
  for (const source of ['main_planner', 'jev', 'planner', undefined]) {
    assert.equal(interrupt(running, { source }), running, `${source} cannot interrupt`)
    assert.equal(classifyTaskInterruption(running, { source }).reason, TASK_LEDGER_REFUSAL.UNAUTHORIZED_SOURCE)
  }
  assert.equal(classifyTaskInterruption(createEmptyPlanningState(), { source: 'runtime' }).reason, TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK)
  // An event stamped for another goal is stale work and fails closed.
  assert.equal(classifyTaskInterruption(running, { source: 'runtime', goal_id: 'goal_other' }).reason, TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK)
  assert.notEqual(interrupt(running, { source: 'user' }), running)
})

test('the reason is derived from the stopped state: a blocked or paused task is recorded as such and is not auto-runnable', () => {
  const blocked = (() => {
    const state = progressedState()
    const plan = getActivePlan(state)
    return applyPlanningEvent(state, {
      type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED,
      now: 1600,
      source: 'runtime',
      plan_id: plan.plan_id,
      reason_code: 'resource_depleted',
      detail: 'no iron nearby',
    })
  })()
  const blockedTask = ledgerTask(interrupt(blocked))
  assert.equal(blockedTask.interruption.reason_code, TASK_INTERRUPTION.BLOCKER)
  assert.equal(blockedTask.interruption.state_at_interruption, 'blocked')

  const paused = applyPlanningEvent(progressedState(), { type: PLANNING_EVENT.RUN_PAUSED, source: 'user', now: 1600, goal_id: 'goal_plates', reason: 'player_pause' })
  const pausedState = interrupt(paused)
  const pausedTask = ledgerTask(pausedState)
  assert.equal(pausedTask.interruption.reason_code, TASK_INTERRUPTION.PAUSE)
  assert.equal(mostRecentResumable(taskLedgerOf(pausedState)), undefined, 'a player pause is never auto-resumed')
  assert.equal(taskLedgerView(taskLedgerOf(pausedState), { now: 3000 })[0].runnable, false)
})

test('the ledger survives a new goal, a context drop and serialize/restore, and a goalless state restores with it', () => {
  const parked = interrupt(progressedState({ grant: PLAYER_TASK }))
  const next = applyPlanningEvent(parked, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 3000, goal_id: 'goal_coal', owner: 'louis', objective: 'give me 5 coal' })
  assert.equal(next.goal.goal_id, 'goal_coal')
  assert.equal(taskLedgerOf(next).tasks.length, 1, 'a new goal never drops a parked task')

  const wire = JSON.parse(JSON.stringify(serializePlanningState(next)))
  const restored = restorePlanningState(wire)
  assert.equal(restored.goal.goal_id, 'goal_coal')
  assert.deepEqual(taskLedgerOf(restored).tasks.map(task => task.task_id), ['task:goal_plates'])
  assert.deepEqual(ledgerTask(restored).progress, ledgerTask(next).progress)

  // Goalless: only the ledger exists (the running task finished and its context was cleared, or the process restarted).
  const goalless = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(parked))))
  assert.equal(goalless.goal, null)
  assert.equal(ledgerTask(goalless).interruption.reason_code, TASK_INTERRUPTION.NEW_GOAL)
  assert.ok(ledgerTask(goalless).checkpoint, 'the checkpoint survives the restart')
  // A state that never saw the ledger serializes exactly as before.
  assert.equal('task_ledger' in serializePlanningState(progressedState()), false)
})

test('resume restores the committed plan, verified progress and receipts exactly as they stopped', () => {
  const running = progressedState({ grant: PLAYER_TASK })
  const planBefore = getActivePlan(running)
  const parked = interrupt(running)
  const cleared = applyPlanningEvent(applyPlanningEvent(parked, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 3000, goal_id: 'goal_coal', owner: 'louis', objective: 'give me 5 coal' }), {
    type: PLANNING_EVENT.GOAL_SATISFIED, now: 3100, source: 'user', evidence_refs: ['x'],
  })
  // The interrupting task finished and its context was cleared: the state is goalless again, ledger intact.
  const goalless = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState({ ...createEmptyPlanningState(), task_ledger: taskLedgerOf(cleared) }))))

  const resumed = applyPlanningEvent(goalless, { type: PLANNING_EVENT.TASK_RESUMED, source: 'runtime', now: 4000, request_id: 'req_resume' })
  assert.equal(resumed.goal.goal_id, 'goal_plates')
  assert.equal(resumed.goal.status, 'active')
  const plan = getActivePlan(resumed)
  assert.equal(plan.plan_id, planBefore.plan_id)
  assert.equal(plan.status, PLAN_STATUS.EXECUTING, 'the plan comes back in the status it stopped in')
  assert.equal(plan.active_step_index, 1, 'resumes at the step where it stopped, not the beginning')
  assert.equal(plan.execution.step_progress[plan.steps[0].step_id].status, 'completed', 'verified steps are not redone')
  assert.equal(plan.execution.step_progress[plan.steps[0].step_id].accepted_evidence.length, 1)
  assert.ok(Object.values(plan.execution.receipts).flat().some(item => item.ref === 'batch_8'), 'the receipt ledger comes back')
  assert.equal(authorizationOf(resumed).grants[0].grant_id, 'player_task:task_plates', 'the authorization link comes back with the task')
  assert.equal(taskLedgerOf(resumed).tasks.length, 0)
  assert.deepEqual(taskLedgerOf(resumed).closed.map(item => [item.task_id, item.status]), [['task:goal_plates', 'resumed']])
  assert.ok(reasoningEpochOf(resumed) > reasoningEpochOf(goalless))
})

test('resume refuses while another task is running, keeps live world facts, and clears what described the stopped world', () => {
  let state = progressedState()
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.CONDITION_WAIT_RECORDED, source: 'runtime', now: 1600, goal_id: 'goal_plates', wait: { id: 'wait_1', state: 'active' } })
  const parked = interrupt(state)
  // A different task is running now.
  const other = applyPlanningEvent(parked, { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 3000, goal_id: 'goal_coal', owner: 'louis', objective: 'give me 5 coal' })
  assert.equal(applyPlanningEvent(other, { type: PLANNING_EVENT.TASK_RESUMED, source: 'runtime', now: 3100 }), other)
  assert.equal(classifyTaskResume(other, { source: 'runtime' }).reason, TASK_LEDGER_REFUSAL.ANOTHER_TASK_ACTIVE)

  // A reservation made while the task was parked is a live world fact; the checkpoint must not clobber it.
  const withReservation = applyPlanningEvent({ ...parked, goal: null }, {
    type: PLANNING_EVENT.RESERVATION_RECORDED, source: 'user', now: 3200, reservation: { unit_number: 901, entity_name: 'wooden-chest', position: { x: 1, y: 2 } },
  })
  const resumed = applyPlanningEvent(withReservation, { type: PLANNING_EVENT.TASK_RESUMED, source: 'runtime', now: 3300 })
  assert.equal(resumed.goal.goal_id, 'goal_plates')
  assert.equal(authorizationOf(resumed).world.reservations.length, authorizationOf(withReservation).world.reservations.length)
  assert.equal(resumed.run?.condition_wait ?? null, null, 'a condition wait described the world while it was stopped')
})

test('resume authority and runnable rules: planner/Jev cannot resume; only an explicit user resume may continue a paused or blocked task', () => {
  const paused = applyPlanningEvent(progressedState(), { type: PLANNING_EVENT.RUN_PAUSED, source: 'user', now: 1600, goal_id: 'goal_plates', reason: 'player_pause' })
  const parked = interrupt(paused)
  assert.equal(classifyTaskResume(parked, { source: 'main_planner' }).reason, TASK_LEDGER_REFUSAL.UNAUTHORIZED_SOURCE)
  assert.equal(classifyTaskResume(parked, { source: 'runtime' }).reason, TASK_LEDGER_REFUSAL.NOTHING_TO_RESUME)
  assert.equal(classifyTaskResume(parked, { source: 'runtime', task_id: 'task:goal_plates' }).reason, TASK_LEDGER_REFUSAL.TASK_NOT_RESUMABLE)
  assert.equal(classifyTaskResume(parked, { source: 'runtime', task_id: 'task:nope' }).reason, TASK_LEDGER_REFUSAL.TASK_NOT_FOUND)
  const explicit = applyPlanningEvent(parked, { type: PLANNING_EVENT.TASK_RESUMED, source: 'user', task_id: 'task:goal_plates', now: 3000 })
  assert.equal(explicit.goal.goal_id, 'goal_plates')
  assert.equal(explicit.run.paused, false)
})

test('a checkpoint that cannot be restored refuses the resume and leaves the ledger as it was', () => {
  const parked = interrupt(progressedState())
  const broken = {
    ...parked,
    task_ledger: {
      ...taskLedgerOf(parked),
      tasks: taskLedgerOf(parked).tasks.map(task => ({ ...task, checkpoint: { planning: { goal: null }, legacy: null } })),
    },
  }
  const verdict = classifyTaskResume(broken, { source: 'runtime', task_id: 'task:goal_plates' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, TASK_LEDGER_REFUSAL.CHECKPOINT_UNRESTORABLE)
  assert.equal(applyPlanningEvent(broken, { type: PLANNING_EVENT.TASK_RESUMED, source: 'runtime', task_id: 'task:goal_plates', now: 3000 }), broken)
})

test('an oversize checkpoint is dropped visibly: the task is kept but is not runnable', () => {
  const huge = restoreTaskLedger({
    tasks: [{
      goal_id: 'goal_big',
      objective: 'big task',
      status: TASK_STATUS.INTERRUPTED,
      interruption: { reason_code: 'new_goal', at: 1 },
      checkpoint: { planning: { goal: { goal_id: 'goal_big', blob: 'x'.repeat(TASK_LEDGER_LIMITS.checkpointChars + 10) } }, legacy: null },
    }],
  })
  assert.equal(huge.tasks.length, 1)
  assert.equal(huge.tasks[0].checkpoint, null)
  assert.equal(huge.tasks[0].checkpoint_dropped, true)
  assert.equal(mostRecentResumable(huge), undefined)
})

test('a queued (accepted, not started) task starts as a fresh goal under its own id when resumed', () => {
  const queued = applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.TASK_QUEUED, source: 'runtime', now: 500, goal_id: 'goal_later', owner: 'ana', objective: 'craft 20 gears', destination: { description: 'chest east of spawn', position: { x: 12, y: -3 } },
  })
  const task = ledgerTask(queued, 'goal_later')
  assert.equal(task.status, TASK_STATUS.PENDING)
  assert.deepEqual(task.requested_result.destination.position, { x: 12, y: -3 })
  assert.equal(applyPlanningEvent(queued, { type: PLANNING_EVENT.TASK_QUEUED, source: 'main_planner', now: 501, objective: 'x' }), queued)
  assert.equal(classifyTaskResume(queued, { source: 'runtime' }).reason, TASK_LEDGER_REFUSAL.NOTHING_TO_RESUME, 'a queued task is started by an explicit pick, not by the interrupted-resume rule')
  const started = applyPlanningEvent(queued, { type: PLANNING_EVENT.TASK_RESUMED, source: 'runtime', task_id: 'task:goal_later', now: 600 })
  assert.equal(started.goal.goal_id, 'goal_later')
  assert.equal(started.goal.objective, 'craft 20 gears')
  assert.equal(taskLedgerOf(started).tasks.length, 0)
})

test('cancelling a parked task closes it for good; a full ledger evicts the oldest visibly', () => {
  const parked = interrupt(progressedState())
  const cancelled = applyPlanningEvent(parked, { type: PLANNING_EVENT.TASK_CANCELLED, source: 'user', task_id: 'task:goal_plates', reason: 'player_cancelled', now: 2500 })
  assert.equal(taskLedgerOf(cancelled).tasks.length, 0)
  assert.equal(taskLedgerOf(cancelled).closed.at(-1).status, 'cancelled')
  assert.equal(applyPlanningEvent(parked, { type: PLANNING_EVENT.TASK_CANCELLED, source: 'main_planner', task_id: 'task:goal_plates', now: 2500 }), parked)

  let state = createEmptyPlanningState()
  for (let index = 0; index < TASK_LEDGER_LIMITS.open + 2; index++) {
    state = applyPlanningEvent(state, { type: PLANNING_EVENT.TASK_QUEUED, source: 'runtime', now: 100 + index, goal_id: `goal_${index}`, objective: `task ${index}`, request_id: `req_${index}` })
  }
  const ledger = taskLedgerOf(state)
  assert.equal(ledger.tasks.length, TASK_LEDGER_LIMITS.open)
  assert.deepEqual(ledger.closed.filter(item => item.status === 'evicted').map(item => item.goal_id), ['goal_0', 'goal_1'])
})

test('resume order is most recent first and aging is recorded data (15 game-minutes), never an action', () => {
  let state = createEmptyPlanningState()
  for (const [goalId, tick] of [['goal_old', 1000], ['goal_new', 5000]]) {
    const running = progressedState({ goalId })
    state = { ...running, task_ledger: taskLedgerOf(state) }
    state = interrupt(state, { game_tick: tick, now: 2000 + tick })
  }
  assert.equal(mostRecentResumable(taskLedgerOf(state)).goal_id, 'goal_new')
  const view = taskLedgerView(taskLedgerOf(state), { now: 9000, gameTick: 5000 + TASK_AGING.resurfaceGameTicks })
  assert.deepEqual(view.map(item => item.goal_id), ['goal_new', 'goal_old'])
  assert.equal(view[0].aging.clock, 'game_ticks')
  assert.equal(view[0].aging.due, true)
  assert.equal(taskAging(ledgerTask(state, 'goal_new'), { now: 5000, gameTick: 5100 }).due, false)
  assert.equal(taskAging(ledgerTask(state, 'goal_new'), { now: 2000 + 5000 + 15 * 60 * 1000 }).clock, 'wall_ms')
})

// --- memory facade -----------------------------------------------------------------

function startCommitted(memory, text = 'Build early automation') {
  const plan = { chatMessage: 'Working.', plan: ['Gather stone', 'Craft furnace', 'Build power'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] }
  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text }, plan)
  memory.reconcileTaskBoard(KEY, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(KEY, { now: 100, runtime_validation: { passed: true } })
  return memory.currentPlan(KEY)
}

function tracedMemory() {
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  memory.traceSink = (name, payload) => rows.push({ name, payload })
  return { memory, rows, named: name => rows.filter(row => row.name === name) }
}

test('facade: interrupt then resume brings back the compatibility board and the committed plan, with named traces carrying request_id and reason', () => {
  const { memory, named } = tracedMemory()
  const legacyBefore = startCommitted(memory)
  const planBefore = getActivePlan(memory.planningState(KEY))
  const boardBefore = JSON.parse(JSON.stringify(legacyBefore.task_board))

  const interrupted = memory.interruptActiveTask(KEY, { interruptedBy: { kind: 'new_goal', sender: 'Louis' }, requestId: 'req_a', gameTick: 777, destination: 'chest:east', now: 5000 })
  assert.equal(interrupted.ok, true)
  assert.equal(named('task_ledger.interrupted').length, 1)
  assert.equal(named('task_ledger.interrupted')[0].payload.request_id, 'req_a')
  assert.equal(named('task_ledger.interrupted')[0].payload.reason, 'new_goal')
  assert.equal(named('task_ledger.interrupted')[0].payload.has_checkpoint, true)
  assert.equal(memory.planningState(KEY).goal, null)

  // The caller clears the legacy context; the ledger survives that.
  memory.clearTaskContext(KEY)
  assert.equal(memory.currentPlan(KEY), undefined)
  assert.equal(memory.taskLedger(KEY).tasks.length, 1)

  const resumed = memory.resumeNextInterruptedTask(KEY, { requestId: 'req_b', now: 6000, gameTick: 999 })
  assert.equal(resumed.ok, true)
  assert.equal(named('task_ledger.resumed')[0].payload.request_id, 'req_b')
  assert.equal(named('task_ledger.resumed')[0].payload.reason, 'most_recent_interrupted_runnable')
  assert.equal(named('task_ledger.resumed')[0].payload.legacy_board_restored, true)
  const legacyAfter = memory.currentPlan(KEY)
  assert.equal(legacyAfter.goal_id, legacyBefore.goal_id)
  assert.equal(legacyAfter.objective, 'Build early automation')
  assert.deepEqual(legacyAfter.task_board.steps.map(step => step.description), boardBefore.steps.map(step => step.description))
  assert.equal(legacyAfter.task_board.completed_count, boardBefore.completed_count)
  assert.equal(getActivePlan(memory.planningState(KEY)).plan_id, planBefore.plan_id)
  assert.equal(memory.taskLedger(KEY).tasks.length, 0)
})

test('facade: refusals are traced by name with request_id, and nothing changes', () => {
  const { memory, named } = tracedMemory()
  assert.equal(memory.interruptActiveTask(KEY, { requestId: 'req_x' }).reason, TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK)
  assert.equal(memory.resumeNextInterruptedTask(KEY, { requestId: 'req_y' }).reason, TASK_LEDGER_REFUSAL.NOTHING_TO_RESUME)
  assert.deepEqual(named('task_ledger.refused').map(row => [row.payload.op, row.payload.reason, row.payload.request_id]), [
    ['interrupt', TASK_LEDGER_REFUSAL.NO_ACTIVE_TASK, 'req_x'],
    ['resume', TASK_LEDGER_REFUSAL.NOTHING_TO_RESUME, 'req_y'],
  ])
  startCommitted(memory)
  assert.equal(memory.resumeTask(KEY, { requestId: 'req_z' }).reason, TASK_LEDGER_REFUSAL.ANOTHER_TASK_ACTIVE)
})

test('facade: snapshot/restore (a supervisor restart) keeps the ledger and a task resumes from the restored one', () => {
  const first = tracedMemory()
  startCommitted(first.memory)
  first.memory.interruptActiveTask(KEY, { requestId: 'req_a', now: 5000 })
  first.memory.clearTaskContext(KEY)
  const wire = JSON.parse(JSON.stringify(first.memory.snapshot()))

  const second = tracedMemory()
  second.memory.restore(wire)
  assert.equal(second.memory.taskLedger(KEY).tasks.length, 1, 'goalless planning state with a ledger survives restore')
  const restoredRows = second.named('task_ledger.restored')
  assert.equal(restoredRows.length, 1)
  assert.equal(restoredRows[0].payload.reason, 'snapshot_restored')
  assert.ok(restoredRows[0].payload.request_id)
  assert.equal(restoredRows[0].payload.tasks[0].has_checkpoint, true)

  const resumed = second.memory.resumeNextInterruptedTask(KEY, { requestId: 'req_after_restart', now: 7000 })
  assert.equal(resumed.ok, true)
  assert.equal(second.memory.currentPlan(KEY).objective, 'Build early automation')
  assert.equal(second.memory.currentPlan(KEY).task_board.steps.length, 3)
})

test('facade: queueing and cancelling a ledger task is traced', () => {
  const { memory, named } = tracedMemory()
  assert.equal(memory.queueTask(KEY, { objective: 'craft 20 gears', owner: 'ana', goalId: 'goal_q', requestId: 'req_q', now: 10 }).ok, true)
  assert.equal(named('task_ledger.queued')[0].payload.request_id, 'req_q')
  assert.equal(memory.cancelLedgerTask(KEY, 'task:goal_q', { reason: 'player_cancelled', requestId: 'req_c', now: 20 }).ok, true)
  assert.equal(named('task_ledger.cancelled')[0].payload.reason, 'player_cancelled')
  assert.equal(memory.cancelLedgerTask(KEY, 'task:goal_q', { requestId: 'req_c2' }).reason, TASK_LEDGER_REFUSAL.TASK_NOT_FOUND)
})
