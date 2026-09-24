import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  evaluateGoalDefinition,
  formatGoalUnderstanding,
  GOAL_SCOPE,
  goalConditionCommand,
  GoalDefinitionError,
  restoreGoalDefinition,
  sanitizeGoalDefinition,
} from './goal-definition.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, GOAL_STATUS, PLAN_STATUS } from './planning-state.mjs'
import { Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const ROCKET_GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_smelting', intent: 'reliable iron and copper smelting' },
  { id: 'node_science', intent: 'automated red and green science', depends_on: ['node_smelting'] },
  { id: 'node_rocket', intent: 'a rocket has been launched', depends_on: ['node_science'] },
]

// --- pure module ---------------------------------------------------------

test('a goal definition is validated into game-checkable conditions', () => {
  const definition = sanitizeGoalDefinition({
    scope: 'long_horizon',
    summary: '  Launch   one rocket. ',
    doneWhen: [
      { kind: 'rockets_launched', minimum: 1 },
      { id: 'silo', kind: 'research_completed', technology: 'rocket-silo' },
      { kind: 'items_produced', item_name: 'rocket-part', minimum: 50 },
      { kind: 'space_location_unlocked', name: 'vulcanus' },
    ],
  })
  assert.equal(definition.scope, GOAL_SCOPE.LONG_HORIZON)
  assert.equal(definition.summary, 'Launch one rocket.')
  assert.deepEqual(definition.done_when.map(condition => condition.id), ['done_1', 'silo', 'done_3', 'done_4'])
  // Stored shape round-trips.
  assert.deepEqual(restoreGoalDefinition({ ...definition, source: 'main_planner', defined_at: 5 }).done_when, definition.done_when)
})

test('malformed goal definitions are rejected with a message the model can act on', () => {
  const bad = [
    [{ scope: 'forever', summary: 'x', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] }, /goal.scope/],
    [{ scope: 'finite', summary: '', doneWhen: [{ kind: 'rockets_launched', minimum: 1 }] }, /goal.summary/],
    [{ scope: 'finite', summary: 'x', doneWhen: [] }, /at least one game-checkable condition/],
    [{ scope: 'finite', summary: 'x', doneWhen: [{ kind: 'vibes' }] }, /kind must be one of/],
    [{ scope: 'finite', summary: 'x', doneWhen: [{ kind: 'research_completed', technology: 'Rocket Silo' }] }, /exact Factorio internal name/],
    [{ scope: 'finite', summary: 'x', doneWhen: [{ kind: 'rockets_launched', minimum: 0 }] }, /positive integer/],
  ]
  for (const [raw, message] of bad) {
    assert.throws(() => sanitizeGoalDefinition(raw), error => error instanceof GoalDefinitionError && message.test(error.message))
  }
  assert.equal(restoreGoalDefinition({ scope: 'bogus' }), undefined)
})

test('conditions are read from the game; unreadable conditions never count as met', async () => {
  const game = new FakeFactorio()
  const definition = sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'Research automation and launch a rocket.',
    doneWhen: [
      { id: 'auto', kind: 'research_completed', technology: 'automation' },
      { id: 'rocket', kind: 'rockets_launched', minimum: 1 },
    ],
  })
  const command = text => game.command(text)
  let evaluation = await evaluateGoalDefinition(definition, command)
  assert.equal(evaluation.satisfied, false)

  game.researched.add('automation')
  game.rocketsLaunched = 1
  evaluation = await evaluateGoalDefinition(definition, command)
  assert.equal(evaluation.satisfied, true)
  assert.equal(evaluation.results.find(result => result.id === 'rocket').current, 1)

  const broken = await evaluateGoalDefinition(definition, async () => { throw new Error('rcon down') })
  assert.equal(broken.satisfied, false)
  assert.match(broken.results[0].error, /rcon down/)
  assert.match(goalConditionCommand(definition.done_when[0]), /remote\.call\("autorio_tools","evaluate_condition",request\)/)
})

test('the in-game understanding message states scope, checks and roadmap', () => {
  const lines = formatGoalUnderstanding(sanitizeGoalDefinition(ROCKET_GOAL), {
    objective: '发射火箭',
    roadmap: SHELF,
  })
  assert.match(lines[0], /Goal understood:.*Launch one rocket from this save\./)
  assert.ok(lines.some(line => line.includes('Your words: "发射火箭"')))
  assert.ok(lines.some(line => /long-horizon/.test(line)))
  assert.ok(lines.some(line => line.includes('at least 1 rocket launched')))
  assert.ok(lines.some(line => line.startsWith('  Roadmap: reliable iron and copper smelting → ')))
})

// --- whole loop ----------------------------------------------------------

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
    npcId: 'airi',
    goalDefinitionPolicy: 'required',
    ...extra,
  })
}

test('a first plan without a goal definition is asked again once, then accepted and announced', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  const events = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(String(messages.at(-1)?.content ?? ''))
    const base = { plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10) }
    return calls === 1 ? planReply(base) : planReply({ ...base, goal: { ...ROCKET_GOAL, scope: 'finite' } })
  }, { onActivity: (event, data) => events.push({ event, data }) })

  await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.match(prompts[1], /goal_definition_required/)
  assert.equal(game.mutations.length, 1)
  const definition = memory.goalDefinition(KEY)
  assert.equal(definition.summary, 'Launch one rocket from this save.')
  const defined = events.find(entry => entry.event === 'goal.defined')
  assert.equal(defined.data.definition.done_when[0].kind, 'rockets_launched')
  assert.equal(defined.data.objective, 'launch a rocket')
})

test('a second missing definition stops before any mutation and asks the player', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)] })
  })

  const result = await agent.request('do the thing', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.equal(game.mutations.length, 0)
  assert.equal(result.blocked, true)
  assert.match(result.chatMessage, /Please restate the goal and what "done" means/)
})

test('a different goal-definition mistake per retry gets another correction naming the field', async () => {
  // 2026-09-24 cloud trial: the goal was first missing, then used "item" for
  // "item_name"; the second, different mistake stopped the goal.
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(String(messages.at(-1)?.content ?? ''))
    const base = { plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)] }
    if (calls === 1) return planReply(base)
    const condition = calls === 2
      ? { kind: 'inventory_count', item: 'iron-ore', minimum: 10 }
      : { kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }
    return planReply({ ...base, goal: { scope: 'finite', summary: 'Gather 10 iron ore.', doneWhen: [condition] } })
  })

  const result = await agent.request('gather 10 iron ore', { sender: 'Louis' })

  assert.equal(calls, 3)
  assert.match(prompts[2], /inventory_count needs the field "item_name"; it has "item", "minimum"/)
  assert.notEqual(result.blocked, true)
  assert.equal(game.mutations.length, 1)
})

test('stopping to ask the player for a goal ends the request trace', async () => {
  const game = new FakeFactorio()
  const events = []
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () =>
    planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)] }), {
    onActivity: (event, data) => events.push({ event, data }),
  })

  await agent.request('do the thing', { sender: 'Louis' })

  const ended = events.filter(entry => entry.event === 'request.completed' || entry.event === 'request.failed')
  assert.equal(ended.length, 1)
  assert.equal(ended[0].data.outcome, 'blocked_before_mutation')
  assert.equal(ended[0].data.blocker.class, 'goal_definition_needed')
})

test('a long-horizon definition without a Roadmap Shelf is asked again', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(String(messages.at(-1)?.content ?? ''))
    const base = { plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL }
    return planReply(calls === 1 ? base : { ...base, roadmap: SHELF })
  })

  await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.match(prompts[1], /long_horizon_goal_requires_roadmap/)
  assert.equal(memory.planningState(KEY).roadmap.nodes.length, 3)
})

test('finishing a slice does not finish the goal: the game decides, then the goal completes', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const prompts = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(String(messages.at(-1)?.content ?? ''))
    if (calls === 1) {
      return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF })
    }
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })

  await agent.request('launch a rocket', { sender: 'Louis' })

  // Slice 1 finishes but no rocket has flown: the goal stays active and the
  // planner is told exactly what is still unmet.
  game.inventory['iron-ore'] = 10
  const afterFirst = await agent.completed()
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
  assert.notEqual(afterFirst?.goalStatus, 'completed')
  assert.equal(calls, 2)
  assert.match(prompts[1], /0\/1 goal conditions met; still unmet: rocket \(currently 0\)/)

  // Slice 2 finishes after the rocket launched: now the game says it is done.
  game.inventory.coal = 10
  game.rocketsLaunched = 1
  const afterSecond = await agent.completed()
  assert.equal(afterSecond.goalStatus, 'completed')
  assert.match(afterSecond.chatMessage, /the game reports 1\/1 goal conditions met/)
  const goal = memory.planningState(KEY).goal
  assert.equal(goal.status, GOAL_STATUS.COMPLETED)
  assert.equal(goal.satisfaction.source, 'runtime')
  assert.deepEqual(goal.satisfaction.evidence_refs, ['goal_condition/rocket/1'])
})

test('a finite goal whose checks are unmet after its plan keeps going instead of claiming success', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    if (calls === 1) {
      return planReply({
        plan: ['Research automation'],
        operations: [gather('iron-ore', 10)],
        checkpoint: inventoryCheckpoint('iron-ore', 10),
        goal: { scope: 'finite', summary: 'Research automation.', doneWhen: [{ id: 'auto', kind: 'research_completed', technology: 'automation' }] },
      })
    }
    return planReply({ plan: ['Finish the research'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })

  await agent.request('research automation', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  const result = await agent.completed()

  assert.notEqual(result?.goalStatus, 'completed')
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
  assert.equal(calls, 2, 'the planner was woken for another slice')
})

test('a condition the game cannot recognise pauses the goal and asks the player', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, async () => planReply({
    plan: ['Gather 10 iron ore'],
    operations: [gather('iron-ore', 10)],
    checkpoint: inventoryCheckpoint('iron-ore', 10),
    goal: { scope: 'finite', summary: 'Research the rocket thing.', doneWhen: [{ id: 'typo', kind: 'research_completed', technology: 'rocket-silos' }] },
  }))

  await agent.request('research the rocket thing', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  const result = await agent.completed()

  assert.equal(result.goalStatus, 'paused')
  assert.match(result.chatMessage, /typo: unknown_technology/)
  assert.match(memory.currentPlan(KEY).pause_reason, /^goal_definition_unverifiable: /)
})

test('the supervisor prints the goal understanding in game', async () => {
  const printed = []
  const conversation = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    printChat: async line => { printed.push(line) },
    appendUiConversation: (role, sender, text) => conversation.push({ role, text }),
    log: () => {},
  })
  session.announceGoalUnderstanding({
    objective: 'launch a rocket',
    definition: sanitizeGoalDefinition(ROCKET_GOAL),
    roadmap: SHELF,
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(printed[0], /\[color=0\.4,0\.8,1\]Goal understood:\[\/color\] Launch one rocket from this save\./)
  assert.ok(printed.some(line => line.includes('Done when (checked by the game):')))
  assert.doesNotMatch(conversation[0].text, /\[color/, 'the UI transcript gets plain text')
})

// 2026-09-24 cloud trial (run 5): a planner "done" on the last step ended the
// request as complete without the game ever checking the goal definition.
function doneOnLastStep(game, memory, events) {
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    if (calls === 1) {
      return planReply({
        plan: ['Gather 10 iron ore'],
        operations: [gather('iron-ore', 10)],
        goal: { scope: 'finite', summary: 'Have 5 iron plates.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 5 }] },
      })
    }
    return planReply({ chatMessage: 'Done.', plan: [], currentStep: 0, operations: [] })
  }, { onActivity: (event, data) => events.push({ event, data }) })
  return { agent, calls: () => calls }
}

test('a planner "done" on the last step completes a defined goal when the game confirms it', async () => {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 5 } })
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const { agent } = doneOnLastStep(game, memory, events)
  await agent.request('have 5 iron plates', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10

  const result = await agent.completed()

  assert.equal(result.goalStatus, 'completed')
  assert.ok(events.some(entry => entry.event === 'goal.evaluated' && entry.data.satisfied === true))
})

test('a planner "done" on the last step does not complete a defined goal the game reports unmet', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const { agent, calls } = doneOnLastStep(game, memory, events)
  await agent.request('have 5 iron plates', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10

  const result = await agent.completed()

  // One extra planning turn, then an honest ending with the goal still open.
  assert.equal(calls(), 3)
  assert.equal(result.goalStatus, 'active')
  assert.match(result.chatMessage, /not met yet/)
  const planning = memory.planningState(KEY)
  assert.equal(planning.goal.status, GOAL_STATUS.ACTIVE)
  // The finished slice is not copied into a new active draft.
  assert.equal(getActivePlan(planning).status, PLAN_STATUS.COMPLETED)
})
