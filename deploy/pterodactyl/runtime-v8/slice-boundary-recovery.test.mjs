import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
import { recoverInterruptedAgentPlan, Session, shouldRecoverInterruptedPlan } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Hand-trace regressions for a long goal interrupted mid-slice or between
// slices: restart, provider failure, and shutdown.

const KEY = 'npc:airi'
const ROCKET_GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_science', intent: 'automated science' },
  { id: 'node_rocket', intent: 'a rocket has been launched', depends_on: ['node_science'] },
]

function stateFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airi-slice-')), 'state.json')
}

function agentWith(game, memory, provider, { file = null, intent = () => 'new_goal' } = {}) {
  return new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: intent(), queue_conflict: false, reply: '' }) }),
    systemPrompt: 'slice boundary',
    stateFile: file,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    goalDefinitionPolicy: 'required',
  })
}

async function restart(game, file, provider) {
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, provider, { file })
  await agent.loadPersistentState()
  return { agent, memory }
}

const firstSlice = planReply({
  plan: ['Gather 10 iron ore'],
  operations: [gather('iron-ore', 10)],
  checkpoint: inventoryCheckpoint('iron-ore', 10),
  goal: ROCKET_GOAL,
  roadmap: SHELF,
})
const nextSlice = planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })

test('restart mid-slice restores the goal definition and shelf and continues the committed step', async () => {
  const game = new FakeFactorio()
  const file = stateFile()
  const prompts = []
  let calls = 0
  const provider = async messages => {
    calls++
    prompts.push(messages.map(message => String(message.content)).join('\n'))
    if (calls === 1) {
      return planReply({ plan: ['Gather 10 iron ore', 'Gather 10 copper ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF })
    }
    // A real planner often restates the checkpoint with a new minimum after
    // re-observing; the committed contract must win without killing recovery.
    return planReply({ plan: ['Gather 10 iron ore', 'Gather 10 copper ore'], operations: [gather('iron-ore', 4)], checkpoint: inventoryCheckpoint('iron-ore', 12) })
  }
  const first = agentWith(game, new CanonicalTaskBoardMemory(), provider, { file })
  await first.request('launch a rocket', { sender: 'Louis' })
  await first.persistQueue

  const { agent, memory } = await restart(game, file, provider)
  const planning = memory.planningState(KEY)
  assert.equal(planning.goal.definition.done_when[0].kind, 'rockets_launched')
  assert.equal(planning.roadmap.nodes.length, 2)

  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})
  assert.equal(recovery.recovered, true)
  assert.equal(calls, 2)
  assert.doesNotMatch(prompts[1], /goal_definition_required/, 'a restored goal is not asked to redefine itself')
  assert.equal(game.mutations.length, 2)
  const board = memory.currentPlan(KEY).task_board
  assert.equal(board.steps[0].completion_contract.requirements[0].minimum, 10, 'committed checkpoint kept')
})

test('restart between slices re-checks the game and plans the next slice', async () => {
  const game = new FakeFactorio()
  const file = stateFile()
  let providerDown = false
  let calls = 0
  const provider = async () => {
    calls++
    if (calls === 1) return firstSlice
    if (providerDown) throw new Error('fetch failed')
    return nextSlice
  }
  const first = agentWith(game, new CanonicalTaskBoardMemory(), provider, { file })
  await first.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  providerDown = true
  await assert.rejects(first.completed(), /fetch failed/)
  await first.persistQueue

  providerDown = false
  const { agent, memory } = await restart(game, file, provider)
  assert.equal(memory.currentPlan(KEY).status, 'completed')
  assert.equal(agent.goalAwaitingNextSlice(), true)
  assert.equal(shouldRecoverInterruptedPlan(memory.currentPlan(KEY)), false, 'a plain completed plan is not recoverable')
  assert.equal(shouldRecoverInterruptedPlan(memory.currentPlan(KEY), { awaitingNextSlice: true }), true)

  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})
  assert.equal(recovery.recovered, true)
  assert.deepEqual(memory.currentPlan(KEY).task_board.steps.map(step => step.description), ['Gather 10 coal'])
  assert.match(game.mutations.at(-1), /coal/)
})

test('if the goal was met while the server was down, recovery completes it instead of planning more', async () => {
  const game = new FakeFactorio()
  const file = stateFile()
  let providerDown = false
  let calls = 0
  const provider = async () => {
    calls++
    if (calls === 1) return firstSlice
    if (providerDown) throw new Error('fetch failed')
    return nextSlice
  }
  const first = agentWith(game, new CanonicalTaskBoardMemory(), provider, { file })
  await first.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  providerDown = true
  await assert.rejects(first.completed(), /fetch failed/)
  await first.persistQueue

  game.rocketsLaunched = 1
  const callsBefore = calls
  const { agent, memory } = await restart(game, file, provider)
  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})
  assert.equal(recovery.result.goalStatus, 'completed')
  assert.equal(calls, callsBefore, 'no planner call needed')
  assert.match(recovery.result.chatMessage, /the game reports 1\/1 goal conditions met/)
  assert.equal(agent.goalAwaitingNextSlice(), false, 'nothing left to resume')
})

test('a player "continue" between slices resumes the goal', async () => {
  const game = new FakeFactorio()
  let intent = 'new_goal'
  let providerDown = false
  let calls = 0
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, async () => {
    calls++
    if (calls === 1) return firstSlice
    if (providerDown) throw new Error('fetch failed')
    return nextSlice
  }, { intent: () => intent })
  await agent.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  providerDown = true
  await assert.rejects(agent.completed(), /fetch failed/)

  providerDown = false
  intent = 'continue_current'
  const result = await agent.request('continue', { sender: 'Louis' })
  assert.deepEqual(result.plan, ['Gather 10 coal'])
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
})

function stubSession(agent) {
  const chat = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    agent,
    stopping: false,
    autoResume: null,
    log: () => {},
    printChat: async message => { chat.push(message) },
    currentPlanState: () => agent.memory.currentPlan(KEY),
    syncTaskBoardUi: async () => {},
  })
  return { session, chat }
}

test('a provider failure on the next-slice planner call schedules an automatic resume', async () => {
  const game = new FakeFactorio()
  let calls = 0
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () => {
    calls++
    if (calls === 1) return firstSlice
    throw new Error('Hourly provider request budget reached')
  })
  await agent.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await assert.rejects(agent.completed(), /Hourly provider request budget reached/)

  const { session, chat } = stubSession(agent)
  session.eventQueue = Promise.resolve()
  session.queueEvent(() => { throw new Error('Hourly provider request budget reached') }, { reportError: true })
  await session.eventQueue
  assert.equal(session.autoResume?.kind, 'budget')
  assert.ok(chat.some(line => /Resuming automatically/.test(line)))
  assert.equal(agent.memory.currentPlan(KEY).status, 'completed', 'nothing is paused between slices')
  session.clearAutoResume()
})

test('shutdown between slices does not pause the verified slice', async () => {
  const game = new FakeFactorio()
  let calls = 0
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () => {
    calls++
    if (calls === 1) return firstSlice
    throw new Error('fetch failed')
  })
  await agent.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await assert.rejects(agent.completed(), /fetch failed/)
  agent.active = true // the planner call was in flight when the stop arrived

  const { session } = stubSession(agent)
  Object.assign(session, { config: { stopMs: 1000 }, gameChild: null, rcon: null })
  await session.stop('signal').catch(() => {})
  assert.equal(agent.memory.currentPlan(KEY).status, 'completed')
  assert.equal(agent.goalAwaitingNextSlice(), true)
})
