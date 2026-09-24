import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  evaluateGoalDefinition,
  formatGoalStatus,
  formatSliceProgressNote,
  goalUiView,
  formatGoalUnderstanding,
  GOAL_SCOPE,
  goalConditionCommand,
  GoalDefinitionError,
  restoreGoalDefinition,
  sanitizeGoalDefinition,
} from './goal-definition.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
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
  // The rocket counter counts from goal start, so the first read supplies its baseline.
  assert.deepEqual(evaluation.baselines, { rocket: 0 })
  const stored = restoreGoalDefinition({
    ...definition,
    done_when: definition.done_when.map(condition => condition.id === 'rocket' ? { ...condition, baseline: 0 } : condition),
  })

  game.researched.add('automation')
  game.rocketsLaunched = 1
  evaluation = await evaluateGoalDefinition(stored, command)
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
  assert.ok(lines.some(line => line.includes('1 rocket launched from now on')))
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
  assert.match(prompts[1], /0\/1 goal conditions met; still unmet: rocket \(currently 0 since the goal started\)/)

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

test('counters count from goal start: a save that already launched rockets is not done yet', async () => {
  const game = new FakeFactorio()
  game.rocketsLaunched = 3
  const command = text => game.command(text)
  // A baseline the planner tries to supply is ignored; only the game sets it.
  const definition = sanitizeGoalDefinition({
    scope: 'long_horizon',
    summary: 'Launch a rocket.',
    doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1, baseline: 0 }],
  })
  assert.equal(definition.done_when[0].count_from, 'goal_start')
  assert.equal(definition.done_when[0].baseline, undefined)

  const first = await evaluateGoalDefinition(definition, command)
  assert.equal(first.satisfied, false)
  assert.equal(first.results[0].needs_baseline, true)
  assert.deepEqual(first.baselines, { rocket: 3 })

  const stored = restoreGoalDefinition({ ...definition, done_when: [{ ...definition.done_when[0], baseline: 3 }] })
  assert.equal((await evaluateGoalDefinition(stored, command)).satisfied, false)
  game.rocketsLaunched = 4
  const after = await evaluateGoalDefinition(stored, command)
  assert.equal(after.satisfied, true)
  assert.equal(after.results[0].baseline, 3)
  // The mod request never carries harness-only fields.
  assert.doesNotMatch(goalConditionCommand(stored.done_when[0]), /baseline|count_from/)
})

test('save_start counts the lifetime total and needs no baseline', async () => {
  const game = new FakeFactorio()
  game.rocketsLaunched = 1
  const definition = sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'Make sure this save has launched a rocket.',
    doneWhen: [{ kind: 'rockets_launched', minimum: 1, countFrom: 'save_start' }],
  })
  const evaluation = await evaluateGoalDefinition(definition, text => game.command(text))
  assert.equal(evaluation.satisfied, true)
  assert.deepEqual(evaluation.baselines, {})
  assert.match(formatGoalUnderstanding(definition).join('\n'), /launched in this save/)
  assert.throws(() => sanitizeGoalDefinition({
    scope: 'finite',
    summary: 'x',
    doneWhen: [{ kind: 'rockets_launched', minimum: 1, countFrom: 'yesterday' }],
  }), /countFrom/)
})

test('a rocket goal on a save that already launched rockets needs a new launch, and the baseline survives a restart', async () => {
  const game = new FakeFactorio()
  game.rocketsLaunched = 2
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    if (calls === 1) {
      return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF })
    }
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })

  await agent.request('launch a rocket', { sender: 'Louis' })
  assert.equal(memory.goalDefinition(KEY).done_when[0].baseline, 2)

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.equal(restored.goalDefinition(KEY).done_when[0].baseline, 2)

  game.inventory['iron-ore'] = 10
  await agent.completed()
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)

  game.inventory.coal = 10
  game.rocketsLaunched = 3
  const done = await agent.completed()
  assert.equal(done.goalStatus, 'completed')
})

test('"status" answers from durable state and the game without a model call or cancelling auto-resume', async () => {
  const game = new FakeFactorio()
  game.rocketsLaunched = 2
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    return planReply({ plan: ['Gather 10 iron ore', 'Gather 10 coal'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: ROCKET_GOAL, roadmap: SHELF })
  })
  await agent.request('launch a rocket', { sender: 'Louis' })
  assert.equal(calls, 1)

  const printed = []
  const session = Object.create(Session.prototype)
  const pendingResume = { timer: 1 }
  Object.assign(session, {
    npcName: 'AIRI',
    agent,
    rcon: game,
    autoResume: pendingResume,
    printChat: async line => { printed.push(line) },
    queueEvent: () => { throw new Error('status must not queue behind the running turn') },
    log: () => {},
  })
  assert.equal(session.queuePlayerRequest('Louis', 'status'), true)
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(calls, 1, 'no model call')
  assert.equal(session.autoResume, pendingResume, 'a pending auto-resume survives')
  assert.match(printed[0], /Goal:.*Launch one rocket from this save\. — in progress/)
  assert.ok(printed.some(line => line.includes('○ 1 rocket launched from now on — 0/1')), printed.join('\n'))
  assert.ok(printed.some(line => /This slice: 0\/2 steps verified; now: Gather 10 iron ore/.test(line)), printed.join('\n'))
  assert.ok(printed.some(line => /Roadmap: 0\/3 milestones realized; next: reliable iron and copper smelting/.test(line)), printed.join('\n'))

  game.rocketsLaunched = 3
  printed.length = 0
  await session.reportGoalStatus()
  assert.ok(printed.some(line => line.includes('✓ 1 rocket launched from now on — 1/1')), printed.join('\n'))
})

test('status with no goal tells the player how to start one', () => {
  assert.deepEqual(formatGoalStatus({}), ['No goal yet. Tell me what to do with !airi <goal>.'])
  const lines = formatGoalStatus({
    goal: { status: 'active', objective: 'launch a rocket', definition: sanitizeGoalDefinition(ROCKET_GOAL) },
    legacyStatus: 'paused',
  })
  assert.match(lines[0], /— paused$/)
  assert.ok(lines.includes('  Done when (the game could not be read just now):'))
  assert.equal(lines.at(-1), '  Say continue to resume.')
})

test('a verified slice with the goal still open prints one progress line, once', async () => {
  const evaluation = {
    satisfied: false,
    results: [
      { id: 'silo', kind: 'research_completed', satisfied: true },
      { id: 'rocket', kind: 'rockets_launched', satisfied: false, current: 3, baseline: 3 },
    ],
  }
  assert.equal(
    formatSliceProgressNote(evaluation),
    'Slice done. Goal: 1/2 goal conditions met; still to do: rocket (currently 0 since the goal started). Planning the next slice.',
  )
  assert.equal(formatSliceProgressNote({ ...evaluation, satisfied: true }), undefined, 'completion has its own message')

  const printed = []
  const session = Object.create(Session.prototype)
  Object.assign(session, { printChat: async (line) => { printed.push(line) }, log: () => {} })
  session.announceSliceProgress(evaluation)
  session.announceSliceProgress(evaluation)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(printed.length, 1, 'a re-evaluated unchanged boundary is announced once')
})

test('the console Goal card gets each check with its progress, re-read from the game at most every 30 s', async () => {
  const game = new FakeFactorio()
  game.rocketsLaunched = 2
  const memory = new CanonicalTaskBoardMemory()
  const agent = agentWith(game, memory, async () => planReply({
    plan: ['Gather 10 iron ore'],
    operations: [gather('iron-ore', 10)],
    checkpoint: inventoryCheckpoint('iron-ore', 10),
    goal: { ...ROCKET_GOAL, doneWhen: [{ id: 'silo', kind: 'research_completed', technology: 'rocket-silo' }, ...ROCKET_GOAL.doneWhen] },
    roadmap: SHELF,
  }))
  await agent.request('launch a rocket', { sender: 'Louis' })

  const reads = []
  const rcon = { command: async (text) => { if (text.includes('evaluate_condition')) reads.push(text); return game.command(text) } }
  const session = Object.create(Session.prototype)
  Object.assign(session, { agent, rcon, log: () => {} })

  game.researched.add('rocket-silo')
  const first = await session.goalUiView(1_000)
  assert.deepEqual(first, {
    summary: 'Launch one rocket from this save.',
    defined: true,
    read: true,
    met: 1,
    total: 2,
    checks: [
      { text: 'research "rocket-silo" is completed', met: true, progress: 'done' },
      { text: '1 rocket launched from now on', met: false, progress: '0/1' },
    ],
    checked_at: 1_000,
  })
  const readsAfterFirst = reads.length

  game.rocketsLaunched = 3
  const cached = await session.goalUiView(20_000)
  assert.equal(reads.length, readsAfterFirst, 'no game read inside the refresh window')
  assert.equal(cached.met, 1)

  const refreshed = await session.goalUiView(32_000)
  assert.ok(reads.length > readsAfterFirst)
  assert.equal(refreshed.met, 2)
  assert.equal(refreshed.checks[1].progress, '1/1')

  // And a sync carries the card to the mod.
  const written = []
  Object.assign(session, {
    goalUiCache: undefined,
    currentPlanState: () => memory.currentPlan(KEY),
    restoreTaskBoardUiConversation: async () => {},
    ensureUiConversationForState: () => {},
    liveAgentStatus: () => ({ phase: 'executing', detail: '', activity: [], conversation: [] }),
    currentPlanTrackerView: () => memory.planningTrackerView(KEY),
    writeTaskBoardUi: async (command) => { written.push(command); return true },
  })
  await session.syncTaskBoardUi()
  assert.match(written.at(-1), /set_snapshot/)
  assert.match(written.at(-1), /1 rocket launched from now on/)
})

test('the Goal card still shows the goal when its checks could not be read', () => {
  const goal = { status: 'active', objective: 'launch a rocket', definition: sanitizeGoalDefinition(ROCKET_GOAL) }
  const view = goalUiView(goal, undefined)
  assert.equal(view.read, false)
  assert.equal(view.met, 0)
  assert.equal(view.checks[0].progress, 'not read')
  assert.equal(goalUiView({ status: 'completed' }, undefined), undefined)
  assert.equal(goalUiView({ status: 'active', objective: 'follow me' }, undefined).defined, false)
})
