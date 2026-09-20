import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
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

class RejectingPreflightRcon {
  constructor() {
    this.mutations = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      return JSON.stringify({
        ok: false,
        code: 'missing_runtime_capability',
        operation: 'craft_item',
        detail: 'required deterministic capability is unavailable',
      })
    }
    if (text.includes('local ok,result=pcall')) {
      this.mutations.push(text)
      throw new Error('mutation must not be admitted after failed preflight')
    }
    return '{}'
  }
}

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

test('live coordinator turns deterministic preflight rejection into reducer BLOCKED with no mutation', async () => {
  const rcon = new RejectingPreflightRcon()
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => ({
      content: JSON.stringify({
        chatMessage: 'Crafting the first furnace.',
        plan: ['Craft the first furnace', 'Place the furnace'],
        currentStep: 0,
        operations: [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
      }),
    }),
    systemPrompt: 'planning preflight integration test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  const result = await agent.request('build the first furnace', { sender: 'Louis' })
  const planning = memory.planningState('npc:airi')
  const blocked = getActivePlan(planning)

  assert.equal(result.goalStatus, 'blocked')
  assert.equal(result.operations.length, 0)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(blocked.blocker.reason_code, 'operation_preflight_failed:missing_runtime_capability')
  assert.equal(blocked.blocker.evidence_refs.length, 1)
  assert.equal(planning.plans.length, 1, 'preflight failure must freeze rather than auto-create a suffix plan')
})

test('live planning state survives restart BLOCKED and requires explicit revision before successor', () => {
  const key = 'npc:airi'
  const beforeRestart = new CanonicalTaskBoardMemory()
  startCommittedPlan(beforeRestart, key)
  block(beforeRestart, key)

  const blockedBefore = getActivePlan(beforeRestart.planningState(key))
  const blockedEpoch = beforeRestart.planningReasoningEpoch(key)
  assert.equal(blockedBefore.status, PLAN_STATUS.BLOCKED)
  assert.equal(beforeRestart.planningState(key).plans.length, 1)

  const afterRestart = new CanonicalTaskBoardMemory()
  afterRestart.restore(JSON.parse(JSON.stringify(beforeRestart.snapshot())))

  const blockedAfter = getActivePlan(afterRestart.planningState(key))
  assert.equal(blockedAfter.status, PLAN_STATUS.BLOCKED)
  assert.equal(afterRestart.currentPlan(key).status, 'blocked')
  assert.equal(afterRestart.planningState(key).plans.length, 1)
  assert.equal(afterRestart.currentPlan(key).planning.blocked.awaiting_choice, true)
  assert.equal(afterRestart.planningReasoningEpoch(key), blockedEpoch, 'restart must preserve the reducer reasoning epoch')

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
  assert.ok(afterRestart.planningReasoningEpoch(key) > blockedEpoch, 'user-approved successor must invalidate predecessor reasoning')
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

test('real state-file restart preserves BLOCKED, successor lineage, and reasoning epoch', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-planning-restart-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const stateFile = path.join(root, 'npc-state.json')
  const key = 'npc:airi'
  const makeAgent = () => new NpcAgentLoop({
    rcon: { command: async () => '{}' },
    provider: async () => { throw new Error('provider must not run in persistence test') },
    systemPrompt: 'planning persistence integration test',
    stateFile,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    memory: new CanonicalTaskBoardMemory(),
  })

  const first = makeAgent()
  startCommittedPlan(first.memory, key)
  block(first.memory, key)
  const blocked = getActivePlan(first.memory.planningState(key))
  const blockedEpoch = first.memory.planningReasoningEpoch(key)
  assert.equal(blocked.status, PLAN_STATUS.BLOCKED)
  await first.persistState()

  const restarted = makeAgent()
  await restarted.loadPersistentState()
  const restoredBlocked = getActivePlan(restarted.memory.planningState(key))
  assert.equal(restoredBlocked.status, PLAN_STATUS.BLOCKED)
  assert.equal(restoredBlocked.plan_id, blocked.plan_id)
  assert.equal(restarted.memory.planningReasoningEpoch(key), blockedEpoch)
  assert.equal(restarted.memory.currentPlan(key).planning.blocked.awaiting_choice, true)

  restarted.memory.recordBlockedChoice(key, 'revise', 'Louis', { now: 400 })
  const revisedPlan = proposedPlan(['Gather stone', 'Use alternate furnace route', 'Build power'], 1)
  const previousBoard = restarted.memory.currentPlan(key).task_board
  const recorded = restarted.memory.recordPlan(key, {
    sender: 'Louis',
    text: 'Use the alternate furnace route instead.',
  }, revisedPlan)
  restarted.memory.reconcileTaskBoard(
    key,
    previousBoard,
    revisedPlan,
    recorded,
    { previousState: restarted.memory.currentPlan(key), allowReplan: false },
  )
  const successor = getActivePlan(restarted.memory.planningState(key))
  const successorEpoch = restarted.memory.planningReasoningEpoch(key)
  assert.equal(recorded.userRevisionApproved, true)
  assert.equal(successor.derived_from_plan_id, blocked.plan_id)
  assert.equal(successor.plan_version, blocked.plan_version + 1)
  assert.ok(successorEpoch > blockedEpoch)
  await restarted.persistState()

  const restartedAgain = makeAgent()
  await restartedAgain.loadPersistentState()
  const restoredSuccessor = getActivePlan(restartedAgain.memory.planningState(key))
  assert.equal(restoredSuccessor.plan_id, successor.plan_id)
  assert.equal(restoredSuccessor.derived_from_plan_id, blocked.plan_id)
  assert.equal(restartedAgain.memory.planningReasoningEpoch(key), successorEpoch)
})

