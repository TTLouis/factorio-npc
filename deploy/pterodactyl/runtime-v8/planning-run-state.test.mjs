import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  GOAL_STATUS,
  PLAN_STATUS,
  PLANNING_EVENT,
} from './planning-state.mjs'

const KEY = 'npc:airi'

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

class PlanningRcon {
  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","goal_progress_facts"')) {
      return JSON.stringify({ ok: true, rockets_launched: 0, researched_technologies: 0, enabled_technologies: 200, milestones: [] })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
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
    npcId: 'airi',
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
