import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'
import { StepReadLedger, stepReadKey } from './unchanged-fact-reads.mjs'

// Proposal P1 of the 2026-10-20 delegation regression ledger: a harness swap (a C7
// auto-resume, a C8 step-close restage) drops the tool results the step's executor
// already held, so re-reading them only re-establishes what the harness dropped.
// The first re-read of each signature after a swap costs no observation budget.
// The read still runs live; a repeat, a new signature or another step is charged.

const KEY = 'npc:sgluna'
const PLAN = ['Mine 10 iron ore', 'Mine 10 copper ore']
const firstPlan = () => planReply({ plan: PLAN, currentStep: 0, operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) })
const secondPlan = () => planReply({ plan: PLAN, currentStep: 1, operations: [gather('copper-ore', 10)] })

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const actorStatus = id => call(id, 'getActorStatus')
const research = id => call(id, 'getResearchStatus')
const nearby = (id, radius) => call(id, 'getNearbyEntities', { radius })

function loopHarness(replies) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const trace = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages, context) => {
      calls.push({ messages, context })
      const reply = replies[calls.length - 1]
      assert.ok(reply, `unscripted provider call ${calls.length}`)
      return reply
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'swap re-read budget system prompt',
    executorHandoff: false, // the test restages by hand, on one lineage
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const world = { game, memory, agent, calls, trace }
  let now = 5000
  // A C7/C8-style restage: the executor conversation is replaced by a new packet's.
  world.restage = (checkpoint = 'C7') => agent.restageContext({
    checkpoint,
    reason: 'test_swap',
    packet: buildHandoffPacket({ planningState: memory.planningState(KEY), role: 'executor', checkpoint, reason: 'test_swap', now: (now += 1000) }),
  })
  // One decision: a fresh budget, then the model's reads.
  world.decide = async (budget, ...tools) => {
    agent.observationBudgetOverride = budget
    agent.observationBudgetRemaining = budget
    agent.observationDecisionForced = false
    await agent.handleToolBatch({ tool_calls: tools })
  }
  world.callRow = id => trace.find(row => row.event === 'tool.call' && row.data.tool_call_id === id)
  return world
}

async function executorWorld() {
  const world = loopHarness([firstPlan(), secondPlan()])
  await world.agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  assert.equal((await world.restage('C3')).restaged, true)
  return world
}

test('after a swap the executor re-reads what the step held without spending budget, and still has its full budget for new reads', async () => {
  const world = await executorWorld()
  await world.decide(4, actorStatus('x1'), research('y1'))
  assert.equal(world.agent.observationBudgetRemaining, 2, 'the first reads are new observation')
  assert.equal(world.callRow('x1').data.reestablished_read, undefined)

  assert.equal((await world.restage('C7')).restaged, true)
  assert.equal(world.agent.toolCache.size, 0, 'the swap dropped the tool results')
  await world.decide(2, actorStatus('x2'), research('y2'))
  assert.equal(world.agent.observationBudgetRemaining, 2, 'the re-reads cost nothing')
  for (const id of ['x2', 'y2']) {
    assert.equal(world.callRow(id).data.reestablished_read, true)
    assert.equal(world.callRow(id).data.cached, false, 'a live read, not a cached answer')
  }
  const results = world.agent.messages.filter(message => message.role === 'tool')
  assert.deepEqual(results.map(message => message.tool_call_id), ['x2', 'y2'])
  assert.ok(results.every(message => !message.content.includes('Duplicate observation suppressed')))

  await world.agent.handleToolBatch({ tool_calls: [nearby('z', 11), nearby('w', 12)] })
  assert.equal(world.agent.observationBudgetRemaining, 0, 'two new signatures spend the full budget')
  assert.equal(world.callRow('z').data.reestablished_read, undefined)
  assert.equal(world.callRow('w').data.reestablished_read, undefined)
})

test('a re-established read is still screened for relevance: free of the budget, not of the families Jev selected', async () => {
  const world = await executorWorld()
  await world.decide(4, nearby('a1', 9), nearby('b1', 10))
  await world.restage('C7')

  world.agent.observationRelevanceOverride = ['research_state']
  await world.decide(2, nearby('a2', 9), nearby('b2', 10))
  const admission = world.trace.filter(row => row.event === 'observation.partial_admission').at(-1)
  assert.equal(admission?.data.deferred_by_relevance_count, 1, 'the second unselected discovery read is deferred as a fresh one would be')
  assert.equal(world.callRow('b2'), undefined)
  assert.equal(world.agent.observationBudgetRemaining, 2, 'the admitted re-read still costs nothing')
})

test('a second re-read of the same signature after the same swap is charged', async () => {
  const world = await executorWorld()
  await world.decide(4, actorStatus('x1'))
  await world.restage('C8')

  await world.decide(3, actorStatus('x2'))
  assert.equal(world.agent.observationBudgetRemaining, 3, 'the first re-read is free')
  // A continuation empties the per-decision tool cache but is not a new swap.
  world.agent.toolCache.clear()
  await world.agent.handleToolBatch({ tool_calls: [actorStatus('x3')] })
  assert.equal(world.agent.observationBudgetRemaining, 2)
  assert.equal(world.callRow('x3').data.reestablished_read, undefined)
})

test('a read never made before the swap is charged', async () => {
  const world = await executorWorld()
  await world.decide(4, actorStatus('x1'))
  await world.restage('C7')

  await world.decide(3, research('y2'), nearby('z2', 9))
  assert.equal(world.agent.observationBudgetRemaining, 1)
  assert.equal(world.callRow('y2').data.reestablished_read, undefined)
  assert.equal(world.callRow('z2').data.reestablished_read, undefined)
})

test('a read made under an earlier step is charged after the swap', async () => {
  const world = await executorWorld()
  await world.decide(4, actorStatus('x1'))
  world.game.inventory['iron-ore'] = 10
  await world.agent.completed() // step 1 verifies; copper is the active step now
  await world.restage('C8')

  await world.decide(3, actorStatus('x2'))
  assert.equal(world.agent.observationBudgetRemaining, 2)
  assert.equal(world.callRow('x2').data.reestablished_read, undefined)
})

test('a planner conversation is not an executor\'s held result', async () => {
  const world = loopHarness([firstPlan()])
  await world.agent.request('mine 10 iron then 10 copper', { sender: 'Louis' })
  await world.decide(4, actorStatus('p1'))
  assert.equal(world.agent.observationBudgetRemaining, 3)
  await world.restage('C3')
  await world.decide(3, actorStatus('x1'))
  assert.equal(world.agent.observationBudgetRemaining, 2)
  assert.equal(world.callRow('x1').data.reestablished_read, undefined)
})

const EPOCH = { mode: 'npc', actor_kind: 'standalone_character', actor_id: 18, epoch: 3, session: 'aaaa' }
const PLAN_ONE = { plan_id: 'plan_1', plan_version: 1 }
const STEP_ONE = { step_id: 'step_1' }

test('the step identity separates step, plan version, actor, epoch and session', () => {
  const key = stepReadKey(EPOCH, PLAN_ONE, STEP_ONE)
  assert.equal(typeof key, 'string')
  assert.equal(stepReadKey({ ...EPOCH }, { ...PLAN_ONE }, { ...STEP_ONE }), key)
  for (const other of [
    stepReadKey(EPOCH, PLAN_ONE, { step_id: 'step_2' }),
    stepReadKey(EPOCH, { ...PLAN_ONE, plan_version: 2 }, STEP_ONE),
    stepReadKey(EPOCH, { ...PLAN_ONE, plan_id: 'plan_2' }, STEP_ONE),
    stepReadKey({ ...EPOCH, actor_id: 19 }, PLAN_ONE, STEP_ONE),
    stepReadKey({ ...EPOCH, epoch: 4 }, PLAN_ONE, STEP_ONE),
    stepReadKey({ ...EPOCH, session: 'bbbb' }, PLAN_ONE, STEP_ONE),
  ]) assert.notEqual(other, key)
  assert.equal(stepReadKey(undefined, PLAN_ONE, STEP_ONE), undefined)
  assert.equal(stepReadKey(EPOCH, PLAN_ONE, undefined), undefined)
})

test('the ledger frees a read once per swap, bounded by steps and reads', () => {
  const ledger = new StepReadLedger({ stepLimit: 2, readLimit: 2 })
  assert.equal(ledger.isReestablishing('s1', 'a', 2), false, 'never delivered')
  ledger.recordDelivered('s1', 'a', 1)
  assert.equal(ledger.isReestablishing('s1', 'a', 1), false, 'the conversation that holds it')
  assert.equal(ledger.isReestablishing('s1', 'a', 2), true, 'a later conversation')
  ledger.recordDelivered('s1', 'a', 2)
  assert.equal(ledger.isReestablishing('s1', 'a', 2), false, 'served once for that swap')
  assert.equal(ledger.isReestablishing('s2', 'a', 2), false, 'another step')

  ledger.recordDelivered('s1', 'b', 2)
  ledger.recordDelivered('s1', 'c', 2)
  assert.equal(ledger.isReestablishing('s1', 'a', 3), false, 'the oldest read fell out of the bound')
  ledger.recordDelivered('s2', 'a', 2)
  ledger.recordDelivered('s3', 'a', 2)
  assert.equal(ledger.isReestablishing('s1', 'c', 3), false, 'the oldest step fell out of the bound')
  assert.equal(ledger.isReestablishing('s3', 'a', 3), true)
})
