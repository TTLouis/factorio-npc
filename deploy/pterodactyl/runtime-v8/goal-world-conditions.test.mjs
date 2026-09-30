// World-state goal conditions (plan 3.7): entity_working,
// electric_network_satisfied and production_rate, from the planner's
// definition through the game read to goal completion.

import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  describeUnmetGoalResult,
  evaluateGoalDefinition,
  goalConditionCommand,
  GoalDefinitionError,
  goalUiView,
  needsGoalBaseline,
  restoreGoalDefinition,
  sanitizeGoalDefinition,
} from './goal-definition.mjs'
import { compareGoalReading } from './goal-reading.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
import { plannerControlToolDefinitions } from './structured-policy.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const STEAM_GOAL = {
  scope: 'finite',
  summary: 'Get steam power going and run an electric mining drill on iron ore.',
  doneWhen: [
    { id: 'powered', kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill' },
    { id: 'drill', kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 1 },
  ],
}
const NO_WAIT = { sleep: async () => {} }

function lastConversationMessage(messages) {
  const content = messages.map(message => String(message?.content ?? ''))
  return content.filter(text => !/^\[(?:PLANNING_LOD|DECISION_ENVELOPE)\]/.test(text)).at(-1) ?? ''
}

function agentWith(game, memory, provider, extra = {}) {
  return new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'goal definition',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    goalDefinitionPolicy: 'required',
    ...extra,
  })
}

test('running and rate conditions are validated with bounded fields and defaults', () => {
  const definition = sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'Power a drill and make iron plates.',
    doneWhen: [
      { kind: 'entity_working', entity_name: 'electric-mining-drill' },
      { kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill', minimum: 2 },
      { kind: 'production_rate', item_name: 'iron-plate', per_minute: 37.504 },
      { kind: 'production_rate', item_name: 'iron-ore', per_minute: 30, window_minutes: 10 },
    ],
  })
  assert.deepEqual(definition.done_when, [
    { id: 'done_1', kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 1 },
    { id: 'done_2', kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill', minimum: 2 },
    { id: 'done_3', kind: 'production_rate', item_name: 'iron-plate', per_minute: 37.5, window_minutes: 1 },
    { id: 'done_4', kind: 'production_rate', item_name: 'iron-ore', per_minute: 30, window_minutes: 10 },
  ])
  // None of them is a counter: no baseline is ever needed or recorded.
  assert.equal(definition.done_when.some(needsGoalBaseline), false)
  // The mod request carries exactly the condition's own fields.
  assert.match(goalConditionCommand(definition.done_when[2]), /"kind":"production_rate","item_name":"iron-plate","per_minute":37.5,"window_minutes":1/)
  assert.deepEqual(restoreGoalDefinition({ ...definition, source: 'main_planner', defined_at: 1 }).done_when, definition.done_when)

  const bad = [
    [{ kind: 'entity_working', minimum: 1 }, /entity_working needs the field "entity_name"/],
    [{ kind: 'entity_working', entity_name: 'Electric Drill' }, /exact Factorio internal name/],
    [{ kind: 'electric_network_satisfied', entity_name: 'lamp', minimum: 0 }, /whole number of entities/],
    [{ kind: 'production_rate', item_name: 'iron-plate' }, /per_minute must be a positive number/],
    [{ kind: 'production_rate', item_name: 'iron-plate', per_minute: -3 }, /per_minute/],
    [{ kind: 'production_rate', item_name: 'iron-plate', per_minute: 3, window_minutes: 5 }, /window_minutes must be 1 or 10/],
  ]
  for (const [condition, message] of bad) {
    assert.throws(() => sanitizeGoalDefinition({ scope: 'finite', summary: 'x', doneWhen: [condition] }),
      error => error instanceof GoalDefinitionError && message.test(error.message), JSON.stringify(condition))
  }
})

test('a running condition is sampled until a majority agrees; one flicker does not decide it', async () => {
  const definition = sanitizeGoalDefinition({ scope: 'finite', summary: 'Run a drill.', doneWhen: [STEAM_GOAL.doneWhen[1]] })
  const run = async (readings, options = NO_WAIT) => {
    const game = new FakeFactorio()
    game.worldReadings['entity_working:electric-mining-drill'] = readings.map(satisfied => ({ satisfied, current: satisfied ? 1 : 0 }))
    const sent = []
    const evaluation = await evaluateGoalDefinition(definition, (text) => {
      sent.push(text)
      return game.command(text)
    }, options)
    return { evaluation, reads: sent.length }
  }

  let { evaluation, reads } = await run([true, false, true])
  assert.equal(evaluation.satisfied, true)
  assert.deepEqual(evaluation.results[0].samples, [true, false, true])
  assert.equal(reads, 3)

  ;({ evaluation, reads } = await run([false, true, false]))
  assert.equal(evaluation.satisfied, false)
  assert.equal(reads, 3)

  // Two agreeing reads settle it without a third.
  ;({ evaluation, reads } = await run([false, false, true]))
  assert.equal(evaluation.satisfied, false)
  assert.equal(reads, 2)
  ;({ evaluation, reads } = await run([true, true, false]))
  assert.equal(evaluation.satisfied, true)
  assert.equal(reads, 2)

  // Status views read once.
  ;({ evaluation, reads } = await run([true, false, false], { samples: 1 }))
  assert.equal(evaluation.satisfied, true)
  assert.equal(evaluation.results[0].samples, undefined)
  assert.equal(reads, 1)

  // The reads wait between each other.
  const waits = []
  await run([true, false, true], { sleep: async (ms) => { waits.push(ms) } })
  assert.deepEqual(waits, [1000, 1000])
})

test('a paused game never proves a running condition', async () => {
  const definition = sanitizeGoalDefinition({ scope: 'finite', summary: 'Run a drill.', doneWhen: [STEAM_GOAL.doneWhen[1]] })
  const frozen = JSON.stringify({ ok: true, kind: 'entity_working', satisfied: true, current: 1, tick: 500 })
  const evaluation = await evaluateGoalDefinition(definition, async () => frozen, NO_WAIT)
  assert.equal(evaluation.satisfied, false)
  assert.equal(evaluation.results[0].error, 'game_not_advancing')
})

test('a void rate window is reported to the planner and the player with its cause', async () => {
  const game = new FakeFactorio()
  const definition = sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'Make 30 iron plates a minute.',
    doneWhen: [{ id: 'plates', kind: 'production_rate', item_name: 'iron-plate', per_minute: 30 }],
  })
  game.worldReadings['production_rate:iron-plate'] = [{ satisfied: false, current: 42, void_reason: 'hand_inserted' }]
  const evaluation = await evaluateGoalDefinition(definition, text => game.command(text), NO_WAIT)
  assert.equal(evaluation.satisfied, false)
  assert.equal(evaluation.results[0].void_reason, 'hand_inserted')
  assert.equal(describeUnmetGoalResult(evaluation.results[0]),
    'plates (currently 42/min; window void: something other than fuel put into a machine or chest by hand in the last window)')
  const view = goalUiView({ status: 'active', objective: 'x', definition }, evaluation)
  assert.equal(view.checks[0].text, 'machines produce 30 × iron-plate per minute (last 1 min, hand work excluded)')
  assert.equal(view.checks[0].progress, '42/30 per min (void: hand feeding)')

  game.worldReadings['production_rate:iron-plate'] = [{ satisfied: true, current: 31.5 }]
  const met = await evaluateGoalDefinition(definition, text => game.command(text), NO_WAIT)
  assert.equal(met.satisfied, true)
  assert.equal(met.results[0].current, 31.5)
})

test('Jev\'s produce_items reading accepts a production_rate definition', () => {
  const definition = sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'Make 30 iron plates a minute.',
    doneWhen: [{ kind: 'production_rate', item_name: 'iron-plate', per_minute: 30 }],
  })
  const comparison = compareGoalReading({ family: 'produce_items', family_confidence: 0.9 }, definition)
  assert.notEqual(comparison.verdict, 'family_mismatch')
})

test('a steam power goal completes only once the game reports the drill powered and working (live 2026-09-29)', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  let calls = 0
  const agent = agentWith(game, memory, async (messages) => {
    calls++
    prompts.push(lastConversationMessage(messages))
    if (calls === 1) {
      return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: STEAM_GOAL })
    }
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  }, { goalSampling: NO_WAIT })

  await agent.request('get steam power going and run an electric mining drill', { sender: 'Louis' })
  // The steam engine and the drill may exist, but nothing is powered yet.
  game.worldReadings['electric_network_satisfied:electric-mining-drill'] = [{ satisfied: false, current: 0 }]
  game.worldReadings['entity_working:electric-mining-drill'] = [{ satisfied: false, current: 0 }]
  game.inventory['iron-ore'] = 10
  const first = await agent.completed()
  assert.notEqual(first?.goalStatus, 'completed')
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
  assert.match(prompts[1], /0\/2 goal conditions met; still unmet: powered \(currently 0\), drill \(currently 0\)/)

  // The engine powers the drill: both checks hold in every sample.
  game.worldReadings['electric_network_satisfied:electric-mining-drill'] = [{ satisfied: true, current: 1 }]
  game.worldReadings['entity_working:electric-mining-drill'] = [{ satisfied: true, current: 1 }]
  game.inventory.coal = 10
  const second = await agent.completed()
  assert.equal(second.goalStatus, 'completed')
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.COMPLETED)
})

test('the goal-definition prompt and submitPlan schema teach the running kinds as static text', () => {
  const doneWhen = plannerControlToolDefinitions[0].function.parameters.properties.goal.properties.doneWhen.items
  assert.deepEqual(doneWhen.properties.kind.enum.slice(-3), ['entity_working', 'electric_network_satisfied', 'production_rate'])
  assert.deepEqual(doneWhen.properties.window_minutes.enum, [1, 10])
  assert.equal(doneWhen.properties.per_minute.type, 'number')
  assert.match(doneWhen.properties.kind.description, /never with items_produced/)

  const game = new FakeFactorio()
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () => ({ content: '' }))
  const other = agentWith(new FakeFactorio(), new CanonicalTaskBoardMemory(), async () => ({ content: '' }))
  assert.match(agent.systemPrompt, /is proven by what is running, never by items produced/)
  assert.match(agent.systemPrompt, /"kind":"production_rate","item_name":"iron-plate","per_minute":30,"window_minutes":1/)
  // Same text for every agent: nothing per-goal or per-save in the cached prefix.
  assert.equal(agent.systemPrompt, other.systemPrompt)
})
