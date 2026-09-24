import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
import { recoverInterruptedAgentPlan, Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Dry run of a whole Nauvis rocket goal against the fake game, chaining the
// tracks that were hand-traced one at a time: a save that already launched a
// rocket, goal definition with a shelf, slices, a restart mid-slice, a
// provider failure at a slice boundary, the player's status check, research
// completing, and the launch itself. Unit/integration evidence only.

const KEY = 'npc:airi'
const SILO = 301
const ROCKET_GOAL = {
  scope: 'long_horizon',
  summary: 'Launch a rocket from this save.',
  doneWhen: [
    { id: 'silo_research', kind: 'research_completed', technology: 'rocket-silo' },
    { id: 'rocket', kind: 'rockets_launched', minimum: 1 },
  ],
}
const SHELF = [
  { id: 'node_smelting', intent: 'reliable iron and copper smelting' },
  { id: 'node_science', intent: 'automated science up to the rocket silo', depends_on: ['node_smelting'] },
  { id: 'node_rocket', intent: 'a rocket has been launched', depends_on: ['node_science'] },
]

function agentWith(game, memory, provider, file) {
  return new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'rocket dry run',
    stateFile: file,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    goalDefinitionPolicy: 'required',
  })
}

function statusSession(agent, game, printed) {
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    agent,
    rcon: game,
    printChat: async (line) => { printed.push(line) },
    log: () => {},
  })
  return session
}

test('dry run: a Nauvis rocket goal from definition to launch, through a restart and a provider failure', async () => {
  const game = new FakeFactorio()
  // The save already launched a rocket before this goal.
  game.rocketsLaunched = 1
  game.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'rocket-silo', type: 'rocket-silo', unit_number: SILO, position: { x: 6, y: 0 }, distance: 6 }],
  }
  game.onMutation = (text) => {
    if (text.includes(`'launch_rocket',${SILO}`)) game.rocketsLaunched += 1
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airi-rocket-dry-run-')), 'state.json')

  const slices = [
    planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF }),
    // Recovery after the restart restates the committed step and re-issues it.
    planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) }),
    planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) }),
    // The silo's unit number must come from a live observation in this turn.
    { content: null, tool_calls: [{ id: 'observe-silo', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, name: 'rocket-silo', limit: 2 }) } }] },
    planReply({
      plan: ['Launch the ready rocket'],
      operations: [{ name: 'launch_rocket', args: { unit_number: SILO } }],
      checkpoint: { mode: 'all', requirements: [{ id: 'launched', kind: 'authoritative_operation_receipt', operation_name: 'launch_rocket' }] },
    }),
  ]
  const prompts = []
  let providerDown = false
  const provider = async (messages) => {
    if (providerDown) throw new Error('fetch failed')
    prompts.push(messages.map(message => String(message.content)).join('\n'))
    const reply = slices[prompts.length - 1]
    assert.ok(reply, `unexpected planner call ${prompts.length}`)
    return reply
  }

  // Slice 1: the goal is defined and its counter baseline is the save's 1.
  let memory = new CanonicalTaskBoardMemory()
  let agent = agentWith(game, memory, provider, file)
  await agent.request('launch a rocket', { sender: 'Louis' })
  assert.equal(memory.goalDefinition(KEY).done_when.find(c => c.id === 'rocket').baseline, 1)
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE, 'a prior launch does not satisfy "launch a rocket"')

  // The server restarts mid-slice: the committed step, definition, baseline
  // and shelf all come back, and the planner is not asked to redefine.
  await agent.persistQueue
  memory = new CanonicalTaskBoardMemory()
  agent = agentWith(game, memory, provider, file)
  await agent.loadPersistentState()
  assert.equal(memory.goalDefinition(KEY).done_when.find(c => c.id === 'rocket').baseline, 1)
  assert.equal(memory.planningState(KEY).roadmap.nodes.length, 3)
  const recovered = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})
  assert.equal(recovered.recovered, true)
  assert.doesNotMatch(prompts[1], /goal_definition_required/)

  // Slice 1 finishes; the provider is down at the boundary.
  game.inventory['iron-ore'] = 10
  providerDown = true
  await assert.rejects(agent.completed(), /fetch failed/)
  assert.equal(agent.goalAwaitingNextSlice(), true, 'the verified slice waits for its successor, not stranded')

  // The player asks for status while it waits: no model call.
  const printed = []
  await statusSession(agent, game, printed).reportGoalStatus()
  const status = printed.join('\n')
  assert.match(status, /Goal:.*Launch a rocket from this save\./)
  assert.match(status, /○ research "rocket-silo" is completed — not yet/)
  assert.match(status, /○ 1 rocket launched from now on — 0\/1/)

  // The provider recovers; slice 2 is planned from the verified boundary.
  providerDown = false
  const resumed = await recoverInterruptedAgentPlan(agent, 'provider_recovered', {})
  assert.equal(resumed.recovered, true)
  assert.match(prompts[2], /still unmet: silo_research, rocket \(currently 0 since the goal started\)/)

  // Research completes during slice 2; the rocket is still owed.
  game.researched.add('rocket-silo')
  game.inventory.coal = 10
  await agent.completed()
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
  assert.match(prompts[3], /1\/2 goal conditions met; still unmet: rocket/)

  // Slice 3 launches; the goal completes on the game's count, not the step.
  assert.ok(game.mutations.at(-1).includes(`'launch_rocket',${SILO}`))
  const done = await agent.completed()
  assert.equal(done.goalStatus, 'completed')
  const goal = memory.planningState(KEY).goal
  assert.equal(goal.status, GOAL_STATUS.COMPLETED)
  assert.ok(goal.satisfaction.evidence_refs.includes('goal_condition/rocket/2'))
  assert.equal(prompts.length, 5, 'no extra planner turn after the launch')
})

test('dry run: a launch before the rocket is built tells the planner how many parts the silo still needs', async () => {
  const game = new FakeFactorio()
  game.researched.add('rocket-silo')
  game.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'rocket-silo', type: 'rocket-silo', unit_number: SILO, position: { x: 6, y: 0 }, distance: 6 }],
  }
  const replies = [
    { content: null, tool_calls: [{ id: 'observe-silo', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, name: 'rocket-silo', limit: 2 }) } }] },
    planReply({
      plan: ['Launch the rocket'],
      operations: [{ name: 'launch_rocket', args: { unit_number: SILO } }],
      checkpoint: { mode: 'all', requirements: [{ id: 'launched', kind: 'authoritative_operation_receipt', operation_name: 'launch_rocket' }] },
      goal: ROCKET_GOAL,
      roadmap: SHELF,
    }),
    planReply({ plan: ['Launch the rocket'], operations: [gather('iron-ore', 10)] }),
  ]
  const prompts = []
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async (messages) => {
    prompts.push(messages.map(message => String(message.content)).join('\n'))
    return replies[prompts.length - 1]
  }, null)

  await agent.request('launch a rocket', { sender: 'Louis' })
  assert.ok(game.mutations.at(-1).includes(`'launch_rocket',${SILO}`))

  game.lastBasicResult = {
    operation_id: game.batchId,
    type: 'launching_rocket',
    accepted: false,
    completed: false,
    code: 'rocket_not_ready',
    target_unit_number: SILO,
    rocket_parts: 12,
    rocket_parts_required: 50,
    tick: 600 + game.batchId,
  }
  await agent.failed('[AUTORIO] [ERROR] launching_rocket failed: rocket_not_ready; dependent operations cancelled')

  const failurePrompt = prompts.at(-1)
  assert.match(failurePrompt, /rocket_not_ready/)
  assert.match(failurePrompt, /"rocket_parts":12/)
  assert.match(failurePrompt, /"rocket_parts_required":50/)
})

test('dry run: the NPC dies mid-slice; the goal, its baseline and the committed step survive the new body', async () => {
  const game = new FakeFactorio()
  const replies = [
    planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF }),
    // After respawn the planner re-issues the same committed step.
    planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) }),
    planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) }),
  ]
  const prompts = []
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, async (messages) => {
    prompts.push(messages.map(message => String(message.content)).join('\n'))
    const reply = replies[prompts.length - 1]
    assert.ok(reply, `unexpected planner call ${prompts.length}`)
    return reply
  }, null)
  await agent.request('launch a rocket', { sender: 'Louis' })
  const definitionBefore = memory.goalDefinition(KEY)

  // The body dies and respawns empty-handed as a new actor.
  game.status = { ...game.status, actor_id: 42, epoch: 4 }
  const recovered = await recoverInterruptedAgentPlan(agent, 'actor_replaced', {
    previous_actor_id: 18,
    replacement_actor_id: 42,
    inventory_policy: 'no_transfer',
  })
  assert.equal(recovered.recovered, true)
  assert.equal(prompts.length, 2)
  assert.deepEqual(memory.goalDefinition(KEY), definitionBefore, 'definition and baseline unchanged')
  assert.deepEqual(memory.currentPlan(KEY).task_board.steps.map(step => step.description), ['Gather 10 iron ore'])

  game.inventory['iron-ore'] = 10
  await agent.completed()
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
  assert.equal(prompts.length, 3, 'the next slice is planned on the new body')

  game.inventory.coal = 10
  game.researched.add('rocket-silo')
  game.rocketsLaunched = 1
  const done = await agent.completed()
  assert.equal(done.goalStatus, 'completed')
})
