import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

function proposedPlan(steps, currentStep = 0) {
  return {
    chatMessage: 'Working on the durable plan.',
    plan: steps,
    currentStep,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
}

function startCommittedPlan(memory, key = 'npc:airi') {
  const request = { sender: 'Louis', text: 'Build early automation' }
  const plan = proposedPlan(['Gather stone', 'Craft furnace', 'Build power'])
  const recorded = memory.recordPlan(key, request, plan)
  const reconciled = memory.reconcileTaskBoard(key, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(key, { now: 100 })
  return { request, plan, state: reconciled.state }
}

function block(memory, key = 'npc:airi') {
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

test('live planning state survives restart BLOCKED and requires explicit revision before successor', () => {
  const key = 'npc:airi'
  const beforeRestart = new CanonicalTaskBoardMemory()
  startCommittedPlan(beforeRestart, key)
  block(beforeRestart, key)

  const blockedBefore = getActivePlan(beforeRestart.planningState(key))
  assert.equal(blockedBefore.status, PLAN_STATUS.BLOCKED)
  assert.equal(beforeRestart.planningState(key).plans.length, 1)

  const afterRestart = new CanonicalTaskBoardMemory()
  afterRestart.restore(JSON.parse(JSON.stringify(beforeRestart.snapshot())))

  const blockedAfter = getActivePlan(afterRestart.planningState(key))
  assert.equal(blockedAfter.status, PLAN_STATUS.BLOCKED)
  assert.equal(afterRestart.currentPlan(key).status, 'blocked')
  assert.equal(afterRestart.planningState(key).plans.length, 1)
  assert.equal(afterRestart.currentPlan(key).planning.blocked.awaiting_choice, true)

  // A normal provider continuation cannot thaw BLOCKED or replace the suffix.
  const ordinary = proposedPlan(['Gather stone', 'Craft furnace differently', 'Build power'], 1)
  const previousBoard = afterRestart.currentPlan(key).task_board
  const ordinaryRecorded = afterRestart.recordPlan(key, {
    sender: 'Louis',
    text: 'continue',
  }, ordinary, { continuation: true })
  const ordinaryReconciled = afterRestart.reconcileTaskBoard(
    key,
    previousBoard,
    ordinary,
    ordinaryRecorded,
    { previousState: afterRestart.currentPlan(key), allowReplan: false },
  )
  assert.equal(ordinaryReconciled.blockedByHarness, true)
  assert.equal(getActivePlan(afterRestart.planningState(key)).plan_id, blockedAfter.plan_id)
  assert.equal(afterRestart.planningState(key).plans.length, 1)

  // The explicit UI choice records intent only; it still creates no successor.
  afterRestart.recordBlockedChoice(key, 'revise', 'Louis', { now: 200 })
  assert.equal(afterRestart.planningState(key).plans.length, 1)
  assert.equal(getActivePlan(afterRestart.planningState(key)).status, PLAN_STATUS.BLOCKED)

  // The following user-authored revision supplies the actual replacement.
  const revisedPlan = proposedPlan(['Gather stone', 'Use alternate furnace route', 'Build power'], 1)
  const revisedRecorded = afterRestart.recordPlan(key, {
    sender: 'Louis',
    text: 'Use the alternate furnace route instead.',
  }, revisedPlan)
  const revised = afterRestart.reconcileTaskBoard(
    key,
    previousBoard,
    revisedPlan,
    revisedRecorded,
    { previousState: ordinaryReconciled.state, allowReplan: false },
  )
  const successor = getActivePlan(afterRestart.planningState(key))

  assert.equal(revisedRecorded.userRevisionApproved, true)
  assert.equal(successor.status, PLAN_STATUS.DRAFT)
  assert.equal(successor.plan_version, blockedAfter.plan_version + 1)
  assert.equal(successor.derived_from_plan_id, blockedAfter.plan_id)
  assert.equal(afterRestart.planningState(key).plans.length, 2)
  assert.equal(revised.state.status, 'active')
  assert.equal(revised.blockedByHarness, false)
})

test('blocked cancel choice remains frozen until terminate emits PLAN_CANCELLED', () => {
  const key = 'npc:airi'
  const memory = new CanonicalTaskBoardMemory()
  startCommittedPlan(memory, key)
  block(memory, key)

  memory.recordBlockedChoice(key, 'cancel', 'Louis', { now: 300 })
  const stillBlocked = getActivePlan(memory.planningState(key))
  assert.equal(stillBlocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(stillBlocked.blocker.user_choice.choice, 'cancel')
  assert.ok(memory.currentPlan(key), 'cancel choice alone must not destructively clear durable state')

  memory.terminatePlan(key)
  const cancelled = getActivePlan(memory.planningState(key))
  assert.equal(cancelled.status, PLAN_STATUS.CANCELLED)
  assert.equal(memory.currentPlan(key), undefined)
})
