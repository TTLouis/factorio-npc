// MW2 scripted scenario (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 3): the real NpcAgentLoop against a fake
// Factorio and scripted model replies. A 3-step request is interrupted by a second request, the second request is
// verified complete, and the first resumes from the durable ledger at the step where it stopped, with its destination
// and authorization link, across a supervisor-style restart. Nothing here calls a provider.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_SCOPE, MANDATE_KIND } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { recoverInterruptedAgentPlan, resumeInterruptedTaskAfterCompletion } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const STEPS = ['Mine 10 iron ore', 'Mine 10 copper ore', 'Mine 10 coal']
const ACTOR = { actor_id: 18, actor_epoch: 3 }

function harness({ memory = new CanonicalTaskBoardMemory(), game = new FakeFactorio() } = {}) {
  const world = { game, memory, intent: 'new_goal', calls: [] }
  world.jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: world.intent, confidence: 0.9 } } } : undefined)
  const rows = []
  const provider = async (messages) => {
    const objective = memory.currentPlan(KEY)?.objective ?? ''
    const board = memory.currentPlan(KEY)?.task_board
    const index = Number.isSafeInteger(board?.active_index) ? board.active_index : 0
    world.calls.push({ objective, index })
    if (/coal to Louis/.test(objective) || (!board && world.nextGoal === 'coal')) {
      return planReply({ plan: ['Mine 5 coal for Louis'], operations: [gather('coal', 5)], checkpoint: inventoryCheckpoint('coal', 5) })
    }
    if (!board) {
      return planReply({ plan: STEPS, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) })
    }
    return planReply({
      plan: STEPS,
      currentStep: index,
      operations: [gather(['iron-ore', 'copper-ore', 'coal'][Math.min(index, 2)], 10)],
    })
  }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: world.jev,
    steeringDecisionProvider: world.jev,
    systemPrompt: 'task ledger scenario',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  world.agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  world.rows = rows
  world.named = name => rows.filter(row => row.event === name).map(row => ({ ...(row.data ?? {}), request_id: row.request_id ?? row.data?.request_id }))
  world.say = (text, intent) => {
    world.intent = intent
    return world.agent.request(text, { sender: 'Louis' })
  }
  world.finish = (resource, count = 10) => {
    game.inventory[resource] = (game.inventory[resource] ?? 0) + count
    return world.agent.completed()
  }
  return world
}

test('interrupt, run another task to completion, resume at the stopped step with destination and authorization, then survive a restart', async () => {
  const world = harness()
  await world.say('mine 10 iron, copper, and coal for the buffer chest', 'new_goal')
  const goalA = world.memory.currentPlan(KEY).goal_id
  // The standing mandate this request runs under names a destination (MW1 grant); the ledger must keep it.
  const granted = world.memory.grantAuthorization(KEY, {
    mandate_kind: MANDATE_KIND.PLAYER_TASK,
    mandate_id: 'task_ore',
    task_id: 'task_ore',
    requested_result: { result_key: 'deliver:ore:30', destination: 'chest:buffer-1' },
    permitted_scope: [ACTION_SCOPE.SUPPORTING_WORK, ACTION_SCOPE.RECOVERY],
    actor: ACTOR,
  }, { requestId: 'req_grant' })
  assert.equal(granted.ok, true)

  await world.finish('iron-ore')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1, 'step 1 is verified')
  const mutationsBeforeInterrupt = world.game.mutations.length
  const trackerBefore = getActivePlan(world.memory.planningState(KEY))
  assert.equal(trackerBefore.active_step_index, 1)

  // A second request displaces it.
  world.nextGoal = 'coal'
  await world.say('please bring coal to Louis', 'new_goal')
  const interrupted = world.named('task_ledger.interrupted')
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0].reason, 'new_goal')
  assert.equal(interrupted[0].task_id, `task:${goalA}`)
  assert.ok(interrupted[0].request_id, 'the trace carries the id of the request that interrupted it')
  assert.equal(interrupted[0].progress.steps_completed, 1)
  assert.equal(interrupted[0].destination.description, 'chest:buffer-1')
  assert.equal(interrupted[0].authorization.grant_id, 'player_task:task_ore')
  assert.equal(world.named('request.received').at(-1).request_id, interrupted[0].request_id, 'ledger trace and the new request share one request id')
  assert.notEqual(world.memory.currentPlan(KEY).goal_id, goalA)
  assert.equal(world.memory.taskLedger(KEY).tasks.length, 1)

  // The interrupting task is verified complete.
  const done = await world.finish('coal', 5)
  assert.equal(done.goalStatus, 'completed')

  // Restart in the middle: persist, rebuild the memory from the snapshot, and carry on from the restored ledger.
  const wire = JSON.parse(JSON.stringify(world.memory.snapshot()))
  const restoredMemory = new CanonicalTaskBoardMemory()
  restoredMemory.restore(wire)
  assert.equal(restoredMemory.taskLedger(KEY).tasks.length, 1, 'the ledger survives the restart')
  const restarted = harness({ memory: restoredMemory, game: world.game })
  assert.equal(restarted.named('task_ledger.restored').length, 0, 'restore ran before the new loop installed its trace sink')

  // The supervisor's completion boundary resumes the interrupted task, then queues the ordinary recovery.
  await restarted.agent.finalizeCompletedTaskContext()
  const queued = []
  const session = {
    agent: restarted.agent,
    syncTaskBoardUi: async () => {},
    queueEvent: fn => queued.push(fn),
    recoverInterruptedPlan: (reason, details) => recoverInterruptedAgentPlan(restarted.agent, reason, details),
  }
  const resumed = await resumeInterruptedTaskAfterCompletion(session)
  assert.equal(resumed.ok, true)
  const resumedRow = restarted.named('task_ledger.resumed')[0]
  assert.equal(resumedRow.reason, 'interrupting_task_completed')
  assert.equal(resumedRow.steps_completed, 1)
  assert.equal(resumedRow.active_step_index, 1)
  assert.equal(resumedRow.destination.description, 'chest:buffer-1')
  assert.ok(resumedRow.request_id)

  // Verified progress and destination are intact; the verified step is not redone.
  const state = restarted.memory.currentPlan(KEY)
  assert.equal(state.goal_id, goalA)
  assert.equal(state.task_board.completed_count, 1)
  const plan = getActivePlan(restarted.memory.planningState(KEY))
  assert.equal(plan.active_step_index, 1)
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status))
  assert.equal(restarted.memory.authorizationState(KEY).grants[0].grant_id, 'player_task:task_ore')
  assert.equal(restarted.game.mutations.length, mutationsBeforeInterrupt + 1, 'resuming issued nothing by itself (only the coal task ran in between)')

  // The queued recovery re-observes and continues at the stopped step; it never replays iron.
  assert.equal(queued.length, 1)
  const before = restarted.game.mutations.length
  await queued[0]()
  const recovered = restarted.game.mutations.slice(before)
  assert.ok(recovered.length >= 1)
  assert.ok(recovered.every(text => !text.includes('iron-ore')), 'the verified iron step is not issued again')
  assert.ok(recovered.some(text => text.includes('copper-ore')), 'work continues at the copper step')
  assert.equal(restarted.memory.taskLedger(KEY).tasks.length, 0)
})
