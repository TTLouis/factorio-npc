// An explicit semantic completion claim the reducer (or the plan/board
// agreement) refuses is a correctable planner message, not a failed request.
// A disagreement that pauses the goal is visible: a chat line with the resume
// hint and a trace event, never silence.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, gather, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const STEPS = ['Gather 10 iron ore', 'Build a boiler']

function harness(game, provider) {
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const prompts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages) => {
      calls++
      assert.ok(calls < 10, 'planner loop did not terminate')
      prompts.push(String(messages.at(-1)?.content ?? ''))
      return provider(calls, memory)
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'semantic claim refusal',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    onActivity: (event, data) => events.push({ event, data }),
  })
  return { agent, memory, events, prompts, calls: () => calls }
}

// The reducer declines every semantic claim (the memory's own decision is
// replaced so the loop's handling is what is under test).
function declineClaims(memory, { pause = false } = {}) {
  const original = memory.applyOutcomeAuthority.bind(memory)
  memory.applyOutcomeAuthority = (key, candidate, options) => {
    if (candidate?.kind !== 'semantic_complete') return original(key, candidate, options)
    const state = pause ? memory.pausePlan(key, 'plan_board_disagreement:plan_behind_board') : memory.currentPlan(key)
    return {
      state,
      decision: { accepted: false, rejection_reason: pause ? 'plan_board_disagreement' : 'reducer_declined_step_close', ...(pause ? { paused: true } : {}) },
      changed: pause,
      ...(pause ? { progressDisagreement: { code: 'plan_behind_board', plan_id: 'p', board_step_id: 'step_1' } } : {}),
    }
  }
}

const claim = memory => ({
  chatMessage: 'Iron is mined.',
  plan: STEPS,
  currentStep: 0,
  operations: [gather('coal', 10)],
  semanticCompletion: { stepId: memory.currentPlan(KEY)?.task_board?.active_step_id, rationale: 'The completed gather batch grounds this prose-only step.' },
})

test('a claim the reducer declines goes back to the planner as a correctable message and the request does not fail', async () => {
  const game = new FakeFactorio()
  const { agent, memory, events, prompts, calls } = harness(game, (call, mem) => {
    if (call === 1) return planReply({ plan: STEPS, operations: [gather('iron-ore', 10)] })
    if (call === 2) return planReply(claim(mem))
    return planReply({ chatMessage: 'Still mining.', plan: STEPS, currentStep: 0, operations: [gather('iron-ore', 10)] })
  })
  await agent.request('mine iron then build a boiler', { sender: 'Louis' })
  declineClaims(memory)
  game.inventory['iron-ore'] = 10

  await agent.completed()

  assert.equal(calls(), 3)
  assert.equal(events.some(entry => entry.event === 'request.failed'), false)
  assert.ok(events.some(entry => entry.event === 'step.semantic_completion_declined'))
  assert.match(prompts[2], /was not applied \(reducer_declined_step_close\)/)
  assert.equal(memory.currentPlan(KEY).task_board.active_index, 0, 'the step stays open')
  assert.equal(game.mutations.length, 2, 'the declined reply admitted nothing; the corrected one ran')
  assert.doesNotMatch(game.mutations[1], /coal/)
})

test('a plan/board disagreement that pauses the goal ends the request with a visible chat line and a trace', async () => {
  const game = new FakeFactorio()
  const { agent, memory, events, calls } = harness(game, (call, mem) => {
    if (call === 1) return planReply({ plan: STEPS, operations: [gather('iron-ore', 10)] })
    return planReply(claim(mem))
  })
  await agent.request('mine iron then build a boiler', { sender: 'Louis' })
  declineClaims(memory, { pause: true })
  game.inventory['iron-ore'] = 10

  const result = await agent.completed()

  assert.equal(calls(), 2, 'no further planner turn after the pause')
  assert.equal(result.goalStatus, 'paused')
  assert.match(result.chatMessage, /disagree about which step is active/)
  assert.match(result.chatMessage, /Resume|continue/)
  assert.equal(memory.currentPlan(KEY).status, 'paused')
  assert.ok(events.some(entry => entry.event === 'step.progress_disagreement_paused'))
  assert.equal(events.some(entry => entry.event === 'request.failed'), false)
})
