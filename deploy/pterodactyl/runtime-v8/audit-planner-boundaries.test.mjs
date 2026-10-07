import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'
import { FakeFactorio, deployment } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const INVENTORY_RESEARCH = [
  { id: 'stock', kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 },
  { id: 'research', kind: 'research_completed', technology: 'electronics' },
]

function harness(conditions = INVENTORY_RESEARCH, options = {}) {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 1 } })
  game.researched.add('electronics')
  const memory = new CanonicalTaskBoardMemory()
  memory.recordPlan(KEY, { sender: 'tester', text: 'Complete the bounded audit goal' }, {
    chatMessage: '', plan: ['Inspect goal state'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }],
  })
  memory.defineGoal(KEY, { scope: 'finite', summary: 'Complete the bounded audit goal', doneWhen: conditions })
  assert.ok(memory.goalDefinition(KEY), 'fixture owns a canonical defined goal')
  const events = []
  const agent = new NpcAgentLoop({
    rcon: game, memory, provider: async () => { throw new Error('Unexpected provider') },
    systemPrompt: 'audit fixtures', npcId: 'sgluna', stateFile: null, traceFile: null, decisionTraceFile: null,
    onActivity: (event, data) => events.push({ event, data }), ...options,
  })
  agent.lastMemoryKey = KEY
  agent.requestInfo = { memoryKey: KEY, sender: 'tester', text: 'Complete the bounded audit goal' }
  agent.traceRequest = { id: 'request-audit', usage: { provider_calls: 0 } }
  return { game, memory, agent, events }
}

function changeOnCondition(game, change) {
  const original = game.command.bind(game)
  let fired = false
  game.command = async command => {
    const value = await original(command)
    if (!fired && command.includes('"evaluate_condition"')) { fired = true; change() }
    return value
  }
}

test('goal completion rejects mixed actor evidence while stable actor evidence completes', async () => {
  const stale = harness()
  changeOnCondition(stale.game, () => { stale.game.status = deployment({ actor_id: 19, epoch: 4 }) })
  await assert.rejects(stale.agent.evaluateGoalCompletion(), /goal_evaluation_superseded/)
  assert.equal(stale.memory.planningState(KEY).goal.status, 'active')
  assert.equal(stale.agent.lastGoalEvaluation, undefined)
  assert.equal(stale.game.mutations.length, 0)
  const discarded = stale.events.find(row => row.event === 'goal.evaluation_discarded')
  assert.equal(discarded.data.reason, 'goal_definition_or_actor_lineage_superseded')
  assert.equal(discarded.data.request_id, 'request-audit')

  const stable = harness()
  const evaluation = await stable.agent.evaluateGoalCompletion()
  assert.equal(evaluation.satisfied, true)
  assert.equal(stable.memory.planningState(KEY).goal.status, 'completed')
})

test('old baselines cannot be recorded onto a replacement goal at the same NPC key', async () => {
  const world = harness([{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }])
  world.game.rocketsLaunched = 9
  changeOnCondition(world.game, () => {
    const current = world.memory.planningByNpc.get(KEY)
    world.memory.planningByNpc.set(KEY, { ...current, goal: { ...current.goal, goal_id: 'replacement-goal' } })
  })
  await assert.rejects(world.agent.evaluateGoalCompletion(), /goal_evaluation_superseded/)
  assert.equal(world.memory.goalDefinition(KEY).done_when[0].baseline, undefined)
  assert.equal(world.memory.planningState(KEY).goal.goal_id, 'replacement-goal')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.events.some(row => row.event === 'goal.baselines_recorded'), false)
})

test('satisfaction is fenced after an awaited goal trace against goal, definition and request supersession', async () => {
  for (const kind of ['goal', 'definition', 'generation', 'lineage']) {
    const world = harness()
    const original = world.agent.traceEvent.bind(world.agent)
    world.agent.traceEvent = async (event, ...args) => {
      await original(event, ...args)
      if (event !== 'goal.evaluated') return
      const state = world.memory.planningByNpc.get(KEY)
      if (kind === 'goal') world.memory.planningByNpc.set(KEY, { ...state, goal: { ...state.goal, goal_id: 'new-goal' } })
      if (kind === 'definition') world.memory.planningByNpc.set(KEY, { ...state, goal: { ...state.goal, definition: { ...state.goal.definition, summary: 'Changed result' } } })
      if (kind === 'generation') world.agent.generation++
      if (kind === 'lineage') world.agent.agentContext.lineageSequence++
    }
    await assert.rejects(world.agent.evaluateGoalCompletion(), /goal_evaluation_superseded/, kind)
    assert.equal(world.memory.planningState(KEY).goal.status, 'active', kind)
  }
})

test('finishIfGoalMet rejects a superseded evaluation before closing the legacy board', async () => {
  const world = harness()
  const previous = world.memory.currentPlan(KEY)
  const original = world.agent.evaluateGoalCompletion.bind(world.agent)
  world.agent.evaluateGoalCompletion = async options => {
    const result = await original(options)
    world.game.status = deployment({ actor_id: 19, epoch: 4 })
    return result
  }
  await assert.rejects(world.agent.finishIfGoalMet({ chatMessage: '' }, previous), /goal_evaluation_superseded/)
  assert.equal(world.memory.currentPlan(KEY).status, 'active')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
})

test('force-only native research remains evaluable during the existing no-body death gap', async () => {
  const world = harness([INVENTORY_RESEARCH[1]])
  world.game.status = deployment({ actor_id: undefined, actor_kind: undefined, allowed: false })
  assert.equal((await world.agent.evaluateGoalCompletion()).satisfied, true)
  assert.equal(world.memory.planningState(KEY).goal.status, 'completed')
  const actorBound = harness()
  actorBound.game.status = { ...world.game.status }
  await assert.rejects(actorBound.agent.evaluateGoalCompletion(), /identity_unverifiable/)
  assert.equal(actorBound.memory.planningState(KEY).goal.status, 'active')
})

const submitted = JSON.stringify({
  chatMessage: '', plan: ['Gather iron'], currentStep: 0,
  operations: [{ name: 'gather_resource', args: { resource: 'iron-ore', count: 1 } }],
})

function adapter(argumentsText, finish = 'content_filter') {
  return (messages, options) => providerRequest({
    base: 'https://fixture.invalid/v1', key: 'fixture-only', model: 'gpt-6-luna', profile: 'generic',
  }, messages, {
    ...options,
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'audit-response', model: 'gpt-6-luna',
      choices: [{ finish_reason: finish, message: { role: 'assistant', content: '', tool_calls: [{
        id: 'submit-audit', type: 'function', function: { name: 'submitPlan', arguments: argumentsText },
      }] } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
}

test('real adapter filtered valid and salvageable submitPlan replies produce no executable plan', async () => {
  for (const args of [submitted, submitted.slice(0, -1) + ',"checkpoint"::']) {
    const world = harness(INVENTORY_RESEARCH, { provider: adapter(args), reserve: async () => ({}) })
    world.agent.active = true
    world.agent.epoch = world.game.status
    world.agent.messages = [{ role: 'system', content: 'audit fixtures' }, { role: 'user', content: '[CHAT] tester: gather iron' }]
    await assert.rejects(world.agent.callProvider(world.game.status, world.agent.generation, { round: 0, allowTools: true }), error => error.code === 'provider_safety_blocked')
    assert.equal(world.game.mutations.length, 0)
    assert.equal(world.events.some(row => row.event === 'provider.plan_submission' || row.event === 'provider.plan_submission_salvaged'), false)
    const refusal = world.events.find(row => row.event === 'provider.fatal_response_rejected')
    assert.equal(refusal.data.reason, 'provider_safety_blocked')
    assert.equal(refusal.data.request_id, 'request-audit')
  }
})

test('normalizing an unfiltered adapter submitPlan retains non-enumerable provider diagnostics', async () => {
  const world = harness(INVENTORY_RESEARCH, { provider: adapter(submitted, 'stop'), reserve: async () => ({}) })
  world.agent.active = true
  world.agent.epoch = world.game.status
  world.agent.messages = [{ role: 'system', content: 'audit fixtures' }, { role: 'user', content: '[CHAT] tester: gather iron' }]
  const result = await world.agent.callProvider(world.game.status, world.agent.generation, { round: 0, allowTools: true })
  assert.equal(result._sglunaProvider.finish_reason, 'stop')
  assert.equal(Object.getOwnPropertyDescriptor(result, '_sglunaProvider').enumerable, false)
  assert.deepEqual(JSON.parse(result.content).operations, JSON.parse(submitted).operations)
})

function typedRoute(confidence = 0.99) {
  return { provider: 'TypeSafe', model: 'jev-fixture', answers: {
    intent: { type: 'choice', choice: 'status_query', confidence, probabilities: { status_query: confidence } },
    queue_conflict: { type: 'noul', noul: 0.01 },
  } }
}

test('typed-only routing uses no main reservation, including exhausted main quota', async () => {
  const world = harness(INVENTORY_RESEARCH, { interactionDecisionProvider: async () => typedRoute() })
  let reserves = 0
  world.agent.reserve = async () => { reserves++; throw new Error('main quota exhausted') }
  world.agent.interactionProvider = async () => { throw new Error('Unexpected language fallback') }
  const decisions = []
  world.agent.decisionTraceEvent = async (event, data) => decisions.push({ event, data })
  const result = await world.agent.classifyInteraction('status?', 'tester', { task_state: 'idle' }, world.memory.currentPlan(KEY))
  assert.equal(result.route_source, 'jev')
  assert.equal(reserves, 0)
  const applied = decisions.find(row => row.event === 'decision.route_applied')
  assert.equal(applied.data.reason, 'typed_route_without_main_provider')
  assert.equal(applied.data.request_id, 'request-audit')
})

test('ambiguous typed interaction reserves exactly once immediately before main fallback', async () => {
  const order = []
  const world = harness(INVENTORY_RESEARCH, {
    interactionDecisionProvider: async () => { order.push('jev'); return typedRoute(0.2) },
    reserve: async () => { order.push('reserve'); return {} },
    interactionProvider: async () => { order.push('main'); return { content: '{"intent":"status_query","queue_conflict":false,"reply":""}' } },
  })
  const result = await world.agent.classifyInteraction('status?', 'tester', { task_state: 'idle' }, world.memory.currentPlan(KEY))
  assert.equal(result.route_source, 'interaction_router')
  assert.deepEqual(order, ['jev', 'reserve', 'main'])
  const event = world.events.find(row => row.event === 'interaction.main_provider_reserved')
  assert.equal(event.data.request_id, 'request-audit')
  assert.equal(event.data.reason, 'language_router_fallback')
})
