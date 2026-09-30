import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
import { analyzeBehaviorTrace, DELEGATION_TRACE_ROWS } from './run-check.mjs'
import { recoverInterruptedAgentPlan, Session, shouldRecoverInterruptedPlan } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Hand-trace regressions for a long goal interrupted mid-slice or between
// slices: restart, provider failure, and shutdown.

const KEY = 'npc:sgluna'
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sgluna-slice-')), 'state.json')
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
    npcId: 'sgluna',
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
  const { agent } = await restart(game, file, provider)
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

// --- U8: C7 (restart, actor replaced, death) rebuilds the conversation from a handoff packet ---

const twoStep = ['Gather 10 iron ore', 'Gather 10 copper ore']
const twoStepReply = (operations = [gather('iron-ore', 10)]) => planReply({
  plan: twoStep,
  operations,
  checkpoint: inventoryCheckpoint('iron-ore', 10),
  goal: ROCKET_GOAL,
  roadmap: SHELF,
})

// A first turn that reads a realistically large nearby-entities result (200
// entities, tens of KB) before it plans, so the discarded conversation is big and
// the rebuilt one is visibly small.
function bigWorld(game) {
  game.nearby = {
    actor_position: { x: 12.5, y: -30.25 },
    entities: Array.from({ length: 200 }, (_, index) => ({ name: index % 2 ? 'iron-ore' : 'coal', unit_number: 5000 + index, position: { x: index * 1.5, y: -index }, amount: 500 + index })),
  }
  return game
}
const readNearby = { tool_calls: [{ id: 'call_nearby_0000000000000001', index: 0, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32 }) } }] }

function traced(agent) {
  const trace = []
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  trace.rows = event => trace.filter(record => record.event === event)
  return trace
}

async function firstRun(game, file, provider) {
  const first = agentWith(game, new CanonicalTaskBoardMemory(), provider, { file })
  await first.request('launch a rocket', { sender: 'Louis' })
  await first.persistQueue
  return first
}

function conversationText(messages) {
  return messages.map(message => String(message.content ?? '')).join('\n')
}

function assertPacketOnly(messages, { checkpoint = 'C7' } = {}) {
  assert.equal(messages[0].role, 'system')
  assert.match(String(messages[1].content), /^\[HANDOFF\] Rebuilt from durable harness state/)
  assert.match(String(messages[2].content), new RegExp(`^--- step block ---\nrestage: role=planner checkpoint=${checkpoint} reason=recovery:`))
  assert.deepEqual(messages.filter(message => message.role === 'assistant' || message.role === 'tool'), [], 'no exchange of the earlier conversation')
  assert.ok(!messages.some(message => /^\[(CHAT|MEMORY|PLAN_STATE)\]/.test(String(message.content ?? ''))), 'no earlier transcript, dialogue memory or legacy plan dump')
}

test('C7: a restart rebuilds the conversation from a packet (persisted plan, fresh actor and epoch), traced as one context.restaged row', async () => {
  const game = bigWorld(new FakeFactorio())
  const file = stateFile()
  const seen = []
  let calls = 0
  const provider = async (messages) => {
    calls++
    seen.push(messages.map(message => ({ ...message })))
    if (calls === 1) return readNearby
    if (calls === 2) return twoStepReply()
    return planReply({ plan: twoStep, currentStep: 0, operations: [gather('iron-ore', 4)], checkpoint: inventoryCheckpoint('iron-ore', 12) })
  }
  const first = await firstRun(game, file, provider)
  const systemChars = String(first.messages[0].content).length
  const before = conversationText(first.messages).length - systemChars
  assert.ok(before > 8000, `the earlier conversation is realistically large (${before} chars)`)

  game.status = { ...game.status, epoch: 4 } // the server came back under a new epoch
  const { agent, memory } = await restart(game, file, provider)
  const trace = traced(agent)
  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})
  assert.equal(recovery.recovered, true)
  assert.equal(calls, 3)

  const messages = seen[2]
  assertPacketOnly(messages)
  const packet = conversationText(messages)
  assert.match(packet, /^goal: launch a rocket$/m, 'the persisted goal')
  assert.match(packet, /^step 1: .* \| Gather 10 iron ore$/m, 'the persisted plan')
  assert.match(packet, /^step 2: .* \| Gather 10 copper ore$/m)
  assert.match(packet, /^done_when rocket: /m)
  assert.match(packet, /^actor: actor_id=18 actor_kind=standalone_character epoch=4 connected_players=1$/m, 'the fresh actor snapshot with the NEW epoch')
  assert.match(packet, /^active_step: 1 of 2 /m)
  assert.match(packet, /^active_step_contract: all: inventory_count iron-ore>=10$/m, 'the committed contract')
  assert.match(packet, /^\[HARNESS\] Runtime recovery after runtime_restart\./m, 'the step-level recovery instruction follows the packet')
  const rebuilt = packet.length - systemChars
  assert.ok(rebuilt < before / 3, `the rebuilt conversation (${rebuilt}) is far smaller than the old one (${before}), system prompt excluded`)

  const [row] = trace.rows('context.restaged')
  assert.ok(row, 'one context.restaged row')
  assert.equal(trace.rows('context.restaged').length, 1)
  assert.equal(row.data.checkpoint, 'C7')
  assert.equal(row.data.role, 'planner')
  assert.match(row.data.handoff_id, /^ho_[0-9a-f]{12}$/)
  assert.match(row.request_id, /^recovery_/, 'the row belongs to the recovery request')
  assert.equal(row.data.reason, 'recovery:runtime_restart')
  assert.equal(row.data.plan_id, memory.planningState(KEY).active_plan_id)
  assert.equal(memory.planningState(KEY).context_restages.at(-1).handoff_id, row.data.handoff_id)
  assert.equal(trace.rows('context.restage_refused').length, 0)
  for (const key of Object.keys(DELEGATION_TRACE_ROWS.examples.restaged.data).filter(name => name !== 'soft_limit_tokens')) {
    assert.ok(Object.hasOwn(row.data, key), `the row carries ${key}`)
  }
  const delegation = ['restage_loop', 'restage_packet_oversize', 'stale_reply_not_dropped']
  assert.deepEqual(analyzeBehaviorTrace(trace).findings.filter(finding => delegation.includes(finding.signature)), [])
  // Nothing about plan semantics moved: the committed contract is kept.
  assert.equal(memory.currentPlan(KEY).task_board.steps[0].completion_contract.requirements[0].minimum, 10)
})

test('C7: with zero connected humans the recovery still restages and runs (a standalone actor needs no player)', async () => {
  const game = new FakeFactorio()
  game.status = { ...game.status, connected_players: 0 }
  const file = stateFile()
  const seen = []
  let calls = 0
  const provider = async (messages) => {
    calls++
    seen.push(messages.map(message => ({ ...message })))
    return calls === 1 ? twoStepReply() : planReply({ plan: twoStep, currentStep: 0, operations: [gather('iron-ore', 10)] })
  }
  await firstRun(game, file, provider)
  const { agent } = await restart(game, file, provider)
  const trace = traced(agent)

  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})

  assert.equal(recovery.recovered, true)
  assert.equal(calls, 2)
  assertPacketOnly(seen[1])
  assert.match(String(seen[1][2].content), /^actor: actor_id=18 actor_kind=standalone_character epoch=3 connected_players=0$/m)
  assert.equal(trace.rows('context.restaged').length, 1)
  assert.equal(game.mutations.length, 2, 'the recovery admitted work with nobody connected')
})

test('C7: an actor replacement rebuilds from a packet with the replacement actor and epoch, and the late reply of the old epoch is dropped', async () => {
  const game = bigWorld(new FakeFactorio())
  const file = stateFile()
  const seen = []
  let calls = 0
  let release
  const STALE = 'STALE-OLD-EPOCH-REPLY'
  const provider = async (messages) => {
    calls++
    seen.push(messages.map(message => ({ ...message })))
    if (calls === 1) return readNearby
    if (calls === 2) return twoStepReply()
    if (calls === 3) return new Promise((resolve) => { release = resolve }) // the old turn: a provider call still in flight when the body dies
    return planReply({ plan: twoStep, currentStep: 0, operations: [gather('iron-ore', 10)] })
  }
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), provider, { file })
  const trace = traced(agent)
  await agent.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  const oldTurn = agent.completed().then(() => 'admitted', error => `dropped: ${error.message}`) // step 1 done: the planner is asked what is next (call 3, held)
  for (let spin = 0; spin < 500 && calls < 3; spin++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 3, 'the old turn has a provider call in flight')
  assert.equal(agent.providerCallsInFlight, 1, 'and it is still open when the recovery restages')
  const mutationsBefore = game.mutations.length

  // The body dies: the mod recovers a replacement actor under a new epoch.
  game.status = { ...game.status, actor_id: 19, epoch: 4 }
  agent.cancel('actor_replaced_stale_turn')
  const recovery = await recoverInterruptedAgentPlan(agent, 'actor_replaced', { previous_actor_id: 18, replacement_actor_id: 19, inventory_policy: 'no_transfer' })
  assert.equal(recovery.recovered, true)
  assert.equal(calls, 4)
  assertPacketOnly(seen[3])
  const packet = conversationText(seen[3])
  assert.match(packet, /^actor: actor_id=19 actor_kind=standalone_character epoch=4 connected_players=1$/m, 'the replacement actor and the new epoch')
  assert.doesNotMatch(packet, /^actor: actor_id=18/m, 'not the dead body')
  assert.match(packet, /previous_actor_id":18,"replacement_actor_id":19/, 'the recovery instruction names the replacement')
  const [row] = trace.rows('context.restaged')
  assert.equal(row.data.checkpoint, 'C7')
  assert.equal(row.data.reason, 'recovery:actor_replaced')
  assert.equal(trace.rows('context.restage_refused').length, 0, 'a round of the discarded lineage does not block the restage')

  // The reply of the old epoch finally arrives. It belongs to a discarded turn: nothing is admitted or appended.
  release(planReply({ chatMessage: STALE, plan: twoStep, currentStep: 0, operations: [gather('coal', 99)] }))
  assert.match(await oldTurn, /^dropped: .*(cancelled|superseded|epoch changed)/)
  assert.ok(!game.mutations.slice(mutationsBefore).some(text => text.includes('coal')), 'the old reply reached no admission')
  assert.ok(!JSON.stringify(agent.messages).includes(STALE), 'and is not in the rebuilt conversation')
  assert.equal(agent.agentContext.restageCount, 1)
  assert.equal(agent.active, true, 'the rebuilt turn was not cancelled by the late reply')
})

test('C7: a recoverable record the reducer holds no active plan for is never resumed: the goal pauses and the player is told', async () => {
  const game = new FakeFactorio()
  const file = stateFile()
  let calls = 0
  const provider = async () => { calls++; return twoStepReply() }
  await firstRun(game, file, provider)
  const { agent, memory } = await restart(game, file, provider)
  // A torn save: the legacy plan is active but the reducer holds no active plan.
  memory.planningByNpc.set(KEY, { ...memory.planningState(KEY), active_plan_id: null })
  const trace = traced(agent)

  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', {})

  assert.equal(recovery.recovered, false)
  assert.equal(recovery.reason, 'no_active_plan')
  assert.equal(recovery.paused, true)
  assert.equal(calls, 1, 'no model was woken')
  assert.equal(trace.rows('context.restaged').length, 0)
  assert.equal(memory.currentPlan(KEY).status, 'paused')
  assert.match(memory.currentPlan(KEY).pause_reason, /^runtime_recovery_no_active_plan:runtime_restart/)

  // The session turns that into a chat line (its own save, torn the same way).
  const file2 = stateFile()
  await firstRun(game, file2, provider)
  const callsAfterSetup = calls
  const again = await restart(game, file2, provider)
  again.memory.planningByNpc.set(KEY, { ...again.memory.planningState(KEY), active_plan_id: null })
  const { session, chat } = stubSession(again.agent)
  assert.equal(await session.recoverInterruptedPlan('runtime_restart'), null)
  assert.ok(chat.some(line => /no committed plan to resume, so I paused the goal/.test(line)), chat.join('|'))
  assert.equal(calls, callsAfterSetup, 'and no model was woken here either')
})

test('C6: a structural blocker wakes no model: a chat continue, every supervisor recovery and a restart leave the plan frozen with zero provider calls', async () => {
  const game = new FakeFactorio()
  const file = stateFile()
  let calls = 0
  const provider = async () => { calls++; return twoStepReply() }
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, provider, { file })
  await agent.request('launch a rocket', { sender: 'Louis' })
  memory.applyOutcomeAuthority(KEY, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'operation_preflight_failed:missing_dependency',
    candidate_blocker: 'operation_preflight_failed:missing_dependency',
    evidence: [{ kind: 'operation_preflight_blocker', ref: 'preflight_1', summary: 'missing dependency' }],
  })
  await agent.persistState()
  assert.equal(memory.currentPlan(KEY).status, 'blocked')
  const callsWhenBlocked = calls
  const trace = traced(agent)

  // 1. The player says continue: the blocker is explained, nobody is woken.
  const chatAgent = agentWith(game, memory, provider, { intent: () => 'continue_current' })
  const chatTrace = traced(chatAgent)
  const reply = await chatAgent.request('continue', { sender: 'Louis' })
  assert.equal(reply.goalStatus, 'blocked')
  assert.match(reply.chatMessage, /blocked/)
  // 2. A supervisor recovery (restart, actor replaced, auto resume) never touches a blocked plan.
  for (const reason of ['runtime_restart', 'actor_replaced', 'auto_resume_after_transient_provider_failure']) {
    const recovery = await recoverInterruptedAgentPlan(agent, reason, {})
    assert.equal(recovery.recovered, false, reason)
    assert.equal(recovery.reason, 'plan_not_recoverable')
  }
  assert.equal(shouldRecoverInterruptedPlan(memory.currentPlan(KEY)), false)
  // 3. After a restart the frozen plan is still frozen.
  const restarted = await restart(game, file, provider)
  assert.equal(restarted.memory.currentPlan(KEY).status, 'blocked')
  assert.equal((await recoverInterruptedAgentPlan(restarted.agent, 'runtime_restart', {})).recovered, false)

  assert.equal(calls, callsWhenBlocked, 'no provider call while the plan is blocked')
  for (const rows of [trace, chatTrace]) {
    assert.equal(rows.rows('provider.request').length, 0)
    assert.equal(rows.rows('context.restaged').length, 0, 'and nothing restaged')
  }
  assert.equal(memory.currentPlan(KEY).status, 'blocked')
})
