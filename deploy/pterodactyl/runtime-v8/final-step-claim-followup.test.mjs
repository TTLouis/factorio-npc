// A semantic completion claim that closes the last step of a committed plan
// slice, in a reply that also carries operations (live 2026-09-29, DeepSeek
// flash: the request failed with recoverable=false after the claim had been
// applied, the slice-boundary settle never ran and the goal sat idle until the
// player typed "continue"). The operations are not part of any committed plan,
// so they are dropped, not run and not fatal; the slice settles normally.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { GOAL_STATUS } from './planning-state.mjs'
import { FakeFactorio, gather, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const STEP = ['Gather 10 iron ore']
const LONG_GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const FINITE_GOAL = {
  scope: 'finite',
  summary: 'Have 5 iron plates.',
  doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 5 }],
}

function lastConversationMessage(messages) {
  const content = messages.map(message => String(message?.content ?? ''))
  return content.filter(text => !/^\[(?:PLANNING_LOD|DECISION_ENVELOPE)\]/.test(text)).at(-1) ?? ''
}

function harness(game, provider) {
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const prompts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages, ...rest) => {
      calls++
      assert.ok(calls < 10, 'planner loop did not terminate')
      prompts.push(lastConversationMessage(messages))
      return provider(calls, memory)
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'final step claim followup',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    goalDefinitionPolicy: 'required',
    onActivity: (event, data) => events.push({ event, data }),
  })
  return { agent, memory, events, prompts, calls: () => calls }
}

const activeStepId = memory => memory.currentPlan(KEY)?.task_board?.active_step_id

test('a final-step claim with follow-up operations on an unmet long-horizon goal drops them and plans the next slice without a player message', async () => {
  const game = new FakeFactorio()
  const { agent, memory, events, prompts, calls } = harness(game, (call) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: LONG_GOAL, roadmap: SHELF })
    if (call === 2) {
      return planReply({
        chatMessage: 'Iron is mined; restating a longer plan.',
        plan: [...STEP, 'Build a boiler', 'Build a steam engine'],
        currentStep: 0,
        operations: [gather('coal', 10), gather('stone', 5)],
        semanticCompletion: { stepId: activeStepId(memory), rationale: 'The completed gather batch grounds this prose-only step.' },
      })
    }
    return planReply({ chatMessage: 'Next slice.', plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)] })
  })

  await agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'Louis' })
  assert.equal(game.mutations.length, 1)
  game.inventory['iron-ore'] = 10

  const result = await agent.completed()

  assert.equal(calls(), 3, 'the next slice was planned in the same request, with no player message')
  assert.notEqual(result?.failed, true)
  assert.equal(game.mutations.length, 2, 'only the next slice operation was admitted')
  assert.doesNotMatch(game.mutations[1], /coal|stone/)
  assert.match(game.mutations[1], /copper-ore/)
  const drop = events.find(entry => entry.event === 'plan.followup_operations_dropped')
  assert.deepEqual(
    { reason: drop?.data.reason, count: drop?.data.count, operations: drop?.data.operations },
    { reason: 'final_step_closed_by_claim', count: 2, operations: ['gather_resource', 'gather_resource'] },
  )
  assert.ok(events.some(entry => entry.event === 'planning.slice_completion_continuation'))
  assert.equal(events.some(entry => entry.event === 'request.failed'), false)
  assert.match(prompts[2], /slice is verified complete/)
  assert.match(prompts[2], /Your reply that closed the final step also carried 2 operations; the harness did not run them/)
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
})

test('a final-step claim with follow-up operations on a finite goal the game confirms completes the goal and admits nothing', async () => {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 5 } })
  const { agent, memory, events, calls } = harness(game, (call) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: FINITE_GOAL })
    return planReply({
      chatMessage: 'Done, and more.',
      plan: [...STEP, 'Gather coal'],
      currentStep: 0,
      operations: [gather('coal', 10)],
      semanticCompletion: { stepId: activeStepId(memory), rationale: 'The completed gather batch grounds this prose-only step.' },
    })
  })

  await agent.request('have 5 iron plates', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10

  const result = await agent.completed()

  assert.equal(result.goalStatus, 'completed')
  assert.equal(calls(), 2)
  assert.equal(game.mutations.length, 1, 'the dropped operation never reached the game')
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.COMPLETED)
  assert.equal(events.find(entry => entry.event === 'plan.followup_operations_dropped')?.data.count, 1)
  assert.equal(events.some(entry => entry.event === 'request.failed'), false)
})

test('a claim that fails its checks is not a closed step: nothing is dropped and the planner is corrected as before', async () => {
  const game = new FakeFactorio()
  const { agent, events, prompts, calls } = harness(game, (call) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: LONG_GOAL, roadmap: SHELF })
    if (call === 2) {
      return planReply({
        plan: STEP,
        currentStep: 0,
        operations: [gather('coal', 10)],
        semanticCompletion: { stepId: 'step_9', rationale: 'Wrong step.' },
      })
    }
    return planReply({ plan: STEP, currentStep: 0, operations: [gather('iron-ore', 10)] })
  })

  await agent.request('mine iron', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.equal(events.some(entry => entry.event === 'plan.followup_operations_dropped'), false)
  assert.match(prompts[2], /semantic_completion_step_mismatch/)
  assert.equal(calls(), 3)
  // The rejected reply's operation was never admitted; the corrected one was.
  assert.equal(game.mutations.length, 2)
  assert.doesNotMatch(game.mutations[1], /coal/)
})

test('a no-operations final-step claim on an unmet defined goal plans the next slice instead of ending the request idle', async () => {
  const game = new FakeFactorio()
  const { agent, events, prompts, calls } = harness(game, (call, memory) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: LONG_GOAL, roadmap: SHELF })
    if (call === 2) {
      return planReply({
        chatMessage: 'Iron is mined.',
        plan: [],
        currentStep: 0,
        operations: [],
        semanticCompletion: { stepId: activeStepId(memory), rationale: 'The completed gather batch grounds this prose-only step.' },
      })
    }
    return planReply({ chatMessage: 'Next slice.', plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)] })
  })

  await agent.request('mine iron', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.equal(calls(), 3)
  assert.equal(game.mutations.length, 2)
  assert.match(game.mutations[1], /copper-ore/)
  assert.equal(events.some(entry => entry.event === 'plan.followup_operations_dropped'), false)
  assert.doesNotMatch(prompts[2], /also carried/)
  assert.ok(events.some(entry => entry.event === 'planning.slice_completion_continuation'))
})

test('a final-step claim with follow-up operations on a finite goal the game reports unmet plans the next slice', async () => {
  const game = new FakeFactorio()
  const { agent, memory, events, prompts, calls } = harness(game, (call, mem) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: FINITE_GOAL })
    if (call === 2) {
      return planReply({
        plan: [...STEP, 'Smelt plates'],
        currentStep: 0,
        operations: [gather('coal', 10)],
        semanticCompletion: { stepId: activeStepId(mem), rationale: 'The completed gather batch grounds this prose-only step.' },
      })
    }
    return planReply({ plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)] })
  })

  await agent.request('have 5 iron plates', { sender: 'Louis' })
  game.inventory['iron-ore'] = 10
  await agent.completed()

  assert.equal(calls(), 3)
  assert.equal(game.mutations.length, 2)
  assert.doesNotMatch(game.mutations[1], /coal/)
  assert.equal(events.find(entry => entry.event === 'plan.followup_operations_dropped')?.data.count, 1)
  assert.match(prompts[2], /still unmet/)
  assert.equal(memory.planningState(KEY).goal.status, GOAL_STATUS.ACTIVE)
})

test('when nothing settles the slice after a drop, the restated plan and roadmap are not persisted and the player is told why', async () => {
  const game = new FakeFactorio()
  const { agent, memory, calls } = harness(game, (call, mem) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: LONG_GOAL, roadmap: SHELF })
    return planReply({
      chatMessage: 'Restating.',
      plan: [...STEP, 'Build a boiler', 'Build a steam engine'],
      currentStep: 0,
      operations: [gather('coal', 10)],
      roadmap: [{ id: 'node_other', intent: 'something else entirely' }],
      semanticCompletion: { stepId: activeStepId(mem), rationale: 'The completed gather batch grounds this prose-only step.' },
    })
  })

  await agent.request('mine iron', { sender: 'Louis' })
  const rosterBefore = memory.planningState(KEY).roadmap.nodes.map(node => node.id)
  agent.settleCompletedStepState = async () => undefined
  game.inventory['iron-ore'] = 10
  const result = await agent.completed()

  assert.equal(calls(), 2)
  assert.equal(game.mutations.length, 1, 'the dropped operation never reached the game')
  assert.deepEqual(memory.currentPlan(KEY).task_board.steps.map(step => step.description), STEP, 'the committed slice was not replaced by the restated plan')
  assert.notEqual(memory.currentPlan(KEY).plan?.length, 3)
  assert.deepEqual(memory.planningState(KEY).roadmap.nodes.map(node => node.id), rosterBefore)
  assert.match(result.chatMessage, /the harness did not run it/)
})

test('chained in-turn slice continuations are capped per run and the goal pauses visibly', async () => {
  const game = new FakeFactorio()
  const { agent, memory, events } = harness(game, (call) => {
    if (call === 1) return planReply({ plan: STEP, operations: [gather('iron-ore', 10)], goal: LONG_GOAL, roadmap: SHELF })
    return planReply({ plan: ['Gather 20 copper ore'], operations: [gather('copper-ore', 20)] })
  })

  await agent.request('mine iron', { sender: 'Louis' })
  for (let i = 0; i < 3; i++) await agent.continueFromModMessage('[MOD] chained', 'test.chain', { withinTurn: true })
  await assert.rejects(
    agent.continueFromModMessage('[MOD] chained', 'test.chain', { withinTurn: true }),
    /Slice continuation chain limit reached \(3\)/,
  )

  assert.ok(events.some(entry => entry.event === 'plan.slice_continuation_chain_limit'))
  assert.equal(memory.currentPlan(KEY).status, 'paused')
  assert.match(memory.currentPlan(KEY).pause_reason, /slice_continuation_chain_limit_3/)
})
