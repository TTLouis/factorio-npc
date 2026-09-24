import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { sanitizeGoalDefinition } from './goal-definition.mjs'
import {
  compareGoalReading,
  formatGoalReadingNote,
  goalProgressFactsCommand,
  goalReadingQuestions,
  parseGoalProgressFacts,
  parseGoalReading,
} from './goal-reading.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { Session } from './supervisor.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const FINITE_ROCKET = {
  scope: 'finite',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_science', intent: 'automated red and green science' },
  { id: 'node_rocket', intent: 'a rocket has been launched', depends_on: ['node_science'] },
]

function reading(overrides = {}) {
  return { scope: 'long_horizon', scope_confidence: 0.9, family: 'rocket_launch', family_confidence: 0.9, ...overrides }
}

// --- pure module ---------------------------------------------------------

test('the harness compares readings in code; Jev only counts when confident', () => {
  const rocket = sanitizeGoalDefinition({ ...FINITE_ROCKET, scope: 'long_horizon' })
  assert.equal(compareGoalReading(reading(), rocket).verdict, 'agree')
  assert.equal(compareGoalReading(reading({ scope: 'unclear', family: 'other' }), rocket).verdict, 'no_opinion')
  assert.equal(compareGoalReading(reading({ scope: 'finite', scope_confidence: 0.4, family_confidence: 0.3 }), rocket).verdict, 'no_opinion')

  const scope = compareGoalReading(reading(), sanitizeGoalDefinition(FINITE_ROCKET), {
    facts: { researched_technologies: 1, enabled_technologies: 200, milestones_researched: { automation: true }, rockets_launched: 0 },
  })
  assert.equal(scope.verdict, 'scope_mismatch')
  assert.match(scope.hints[0], /classified this goal as long_horizon, but goal.scope is finite/)
  assert.match(scope.hints[0], /1\/200 technologies researched; milestones done: automation; 0 rockets launched/)

  const research = sanitizeGoalDefinition({ scope: 'long_horizon', summary: 'x', doneWhen: [{ kind: 'research_completed', technology: 'rocket-silo' }] })
  const family = compareGoalReading(reading(), research)
  assert.equal(family.verdict, 'family_mismatch')
  assert.match(family.hints[0], /no rockets_launched condition/)
  // build/gather/other are too open to pin to a condition kind.
  assert.equal(compareGoalReading(reading({ family: 'build' }), research).verdict, 'agree')
})

test('Jev answers and save facts are parsed defensively', () => {
  assert.equal(parseGoalReading({ answers: {} }), undefined)
  assert.deepEqual(parseGoalReading({
    answers: {
      goal_scope: { choice: 'finite', confidence: 0.8 },
      goal_family: { choice: 'nonsense', confidence: 1 },
      goal_measurable: { noul: 0.7 },
    },
  }), { scope: 'finite', scope_confidence: 0.8, family: 'other', family_confidence: 0, measurable_probability: 0.7 })

  assert.equal(parseGoalProgressFacts('Unknown interface: goal_progress_facts'), undefined)
  assert.equal(parseGoalProgressFacts('{"ok":false,"error":"no_actor"}'), undefined)
  const facts = parseGoalProgressFacts('{"ok":true,"rockets_launched":0,"researched_technologies":3,"enabled_technologies":190,"milestones":[],"space_age":true}')
  assert.deepEqual(facts.milestones_researched, {}, 'an empty Lua table arrives as []')
  assert.equal(facts.space_age, true)
  assert.match(goalProgressFactsCommand(), /remote\.call\("autorio_tools","goal_progress_facts",request\)/)
  assert.deepEqual(Object.keys(goalReadingQuestions()), ['goal_scope', 'goal_family', 'goal_measurable'])
})

test('the in-game note appears only when the second reading was used', () => {
  assert.equal(formatGoalReadingNote(undefined), undefined)
  assert.equal(formatGoalReadingNote({ verdict: 'agree', after_challenge: false }), undefined)
  assert.match(formatGoalReadingNote({ verdict: 'agree', after_challenge: true }), /revised after an independent second reading/)
  assert.match(formatGoalReadingNote({ verdict: 'scope_mismatch', after_challenge: true, jev_scope: 'long_horizon', jev_family: 'rocket_launch' }), /suggested long-horizon \/ rocket launch; the planner kept/)
})

// --- whole loop ----------------------------------------------------------

function agentWith(game, memory, provider, jev, extra = {}) {
  return new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionDecisionProvider: jev,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'goal reading',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    goalDefinitionPolicy: 'required',
    ...extra,
  })
}

function goalJev(answers) {
  return recordingJev((_state, questions) => (questions.goal_scope ? { overrides: answers } : undefined))
}

const plannerPlan = goal => planReply({
  plan: ['Gather 10 iron ore'],
  operations: [gather('iron-ore', 10)],
  checkpoint: inventoryCheckpoint('iron-ore', 10),
  goal,
})

test('Jev reads the goal blind, with save facts, in the existing planner-shape request', async () => {
  const game = new FakeFactorio()
  game.researched.add('automation')
  const jev = goalJev({ goal_scope: { choice: 'finite', confidence: 0.9 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } })
  let calls = 0
  const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () => {
    calls++
    return plannerPlan(FINITE_ROCKET)
  }, jev)

  await agent.request('launch a rocket', { sender: 'Louis' })

  const goalCalls = jev.callsWith('goal_scope')
  assert.equal(goalCalls.length, 1, 'no extra Jev request: the questions ride on planner shape')
  assert.ok(goalCalls[0].keys.includes('reasoning_budget'))
  const { state } = goalCalls[0]
  assert.equal(state.message, 'launch a rocket')
  assert.equal(state.save_progress.milestones_researched.automation, true)
  assert.equal(state.save_progress.rockets_launched, 0)
  assert.doesNotMatch(JSON.stringify(state), /Launch one rocket from this save/, 'Jev never sees the planner\'s answer')
  assert.equal(calls, 1, 'agreement costs nothing')
})

test('a confident disagreement costs one retry; the planner then has the last word', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = goalJev({ goal_scope: { choice: 'long_horizon', confidence: 0.85 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } })
  const prompts = []
  const events = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(messages.map(message => String(message?.content ?? '')).join('\n'))
    return plannerPlan(FINITE_ROCKET)
  }, jev, { onActivity: (event, data) => events.push({ event, data }) })

  await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.match(prompts[1], /goal_reading_disagreement/)
  assert.match(prompts[1], /classified this goal as long_horizon, but goal.scope is finite/)
  assert.match(prompts[1], /asked only once/)
  assert.equal(game.mutations.length, 1, 'kept definition is accepted, not blocked')
  assert.equal(memory.goalDefinition(KEY).scope, 'finite')
  const defined = events.find(entry => entry.event === 'goal.defined')
  assert.equal(defined.data.jev_goal_reading.after_challenge, true)
  assert.equal(defined.data.jev_goal_reading.verdict, 'scope_mismatch')
  assert.equal(defined.data.jev_goal_reading.jev_scope, 'long_horizon')
})

test('the planner may revise after the challenge; a long-horizon revision still needs its shelf', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = goalJev({ goal_scope: { choice: 'long_horizon', confidence: 0.85 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } })
  let calls = 0
  const agent = agentWith(game, memory, async () => {
    calls++
    return calls === 1
      ? plannerPlan(FINITE_ROCKET)
      : planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: { ...FINITE_ROCKET, scope: 'long_horizon' }, roadmap: SHELF })
  }, jev)

  await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.equal(memory.goalDefinition(KEY).scope, 'long_horizon')
  assert.equal(memory.planningState(KEY).roadmap.nodes.length, 2)
})

test('Jev failures, low confidence and an older mod all fail open to the planner', async () => {
  for (const [name, jev, setup] of [
    ['jev error', recordingJev((_state, questions) => { if (questions.goal_scope) throw new Error('HTTP 503') }), () => {}],
    ['low confidence', goalJev({ goal_scope: { choice: 'long_horizon', confidence: 0.4 }, goal_family: { choice: 'research', confidence: 0.5 } }), () => {}],
    ['older mod', goalJev({ goal_scope: { choice: 'unclear', confidence: 0.9 } }), game => { game.progressFactsAvailable = false }],
  ]) {
    const game = new FakeFactorio()
    setup(game)
    let calls = 0
    const agent = agentWith(game, new CanonicalTaskBoardMemory(), async () => {
      calls++
      return plannerPlan(FINITE_ROCKET)
    }, jev)
    await agent.request('launch a rocket', { sender: 'Louis' })
    assert.equal(calls, 1, name)
    assert.equal(game.mutations.length, 1, name)
    if (name === 'older mod') assert.equal(jev.callsWith('goal_scope')[0].state.save_progress, null)
  }
})

test('continuing slices of a defined goal are never re-challenged', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = goalJev({ goal_scope: { choice: 'long_horizon', confidence: 0.9 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } })
  const prompts = []
  let calls = 0
  const agent = agentWith(game, memory, async messages => {
    calls++
    prompts.push(messages.map(message => String(message?.content ?? '')).join('\n'))
    if (calls === 1) return planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal: { ...FINITE_ROCKET, scope: 'long_horizon' }, roadmap: SHELF })
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  }, jev)

  await agent.request('launch a rocket', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.equal(calls, 2)
  assert.ok(prompts.every(prompt => !/goal_reading_disagreement/.test(prompt)))
})

test('the supervisor adds the double-check line to the in-game goal message', async () => {
  const printed = []
  const session = Object.create(Session.prototype)
  Object.assign(session, {
    npcName: 'AIRI',
    printChat: async line => { printed.push(line) },
    appendUiConversation: () => {},
    log: () => {},
  })
  session.announceGoalUnderstanding({
    objective: 'launch a rocket',
    definition: sanitizeGoalDefinition(FINITE_ROCKET),
    jev_goal_reading: { verdict: 'scope_mismatch', after_challenge: true, jev_scope: 'long_horizon', jev_family: 'rocket_launch' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(printed.at(-1), /Double-checked: an independent reading suggested long-horizon/)
})
