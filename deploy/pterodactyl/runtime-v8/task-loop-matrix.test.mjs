// Whole-loop regressions for the current authority model.
//
// These drive the real NpcAgentLoop through request()/completed() against a
// fake Factorio. Jev is present only for bounded routing/budget decisions; it
// is never asked to review plan correctness, operation/step relation, or
// completion semantics.
import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const RESOURCES = ['iron-ore', 'copper-ore', 'coal']
const STEPS = ['Mine 10 iron ore', 'Mine 10 copper ore', 'Mine 10 coal']

function stepHasVerification(memory, stepId) {
  const board = memory.currentPlan(KEY)?.task_board
  return (board?.evidence ?? []).some(item =>
    item?.step_id === stepId && item?.kind === 'deterministic_verification')
}

function harness({ game = new FakeFactorio(), systemPrompt = 'task loop matrix', provider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, intent: 'new_goal', plannerCalls: 0 }

  world.jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: world.intent, confidence: 0.9 } } }
    return undefined
  })

  const defaultProvider = async () => {
    world.plannerCalls++
    assert.ok(world.plannerCalls < 20, 'planner loop did not terminate')

    const board = memory.currentPlan(KEY)?.task_board
    const activeIndex = Number.isSafeInteger(board?.active_index) ? board.active_index : 0
    const activeStep = board?.steps?.[activeIndex]
    const activeId = activeStep?.id

    if (!board) {
      return planReply({
        plan: STEPS,
        currentStep: 0,
        operations: [gather('iron-ore', 10)],
        checkpoint: inventoryCheckpoint('iron-ore', 10),
      })
    }

    if (activeIndex === 1) {
      if (activeId && stepHasVerification(memory, activeId)) {
        return planReply({
          plan: STEPS,
          currentStep: 2,
          operations: [gather('coal', 10)],
          semanticCompletion: {
            stepId: activeId,
            rationale: 'The completed copper batch is authoritative runtime grounding for this prose-only step.',
          },
        })
      }
      return planReply({
        plan: STEPS,
        currentStep: 1,
        operations: [gather('copper-ore', 10)],
      })
    }

    if (activeIndex === 2 && activeId && stepHasVerification(memory, activeId)) {
      return planReply({
        chatMessage: 'The final prose-only step is complete.',
        plan: [],
        currentStep: 0,
        operations: [],
        semanticCompletion: {
          stepId: activeId,
          rationale: 'The completed coal batch is authoritative runtime grounding for this prose-only step.',
        },
      })
    }

    const resource = RESOURCES[Math.min(activeIndex, RESOURCES.length - 1)]
    return planReply({
      plan: STEPS,
      currentStep: activeIndex,
      operations: [gather(resource, 10)],
    })
  }

  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: provider
      ? async (...args) => {
          world.plannerCalls++
          return provider(...args)
        }
      : defaultProvider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: world.jev,
    steeringDecisionProvider: world.jev,
    systemPrompt,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  world.say = (text, intent) => {
    world.intent = intent
    return world.agent.request(text, { sender: 'Louis' })
  }
  world.finish = (resource, count = 10) => {
    game.inventory[resource] = (game.inventory[resource] ?? 0) + count
    return world.agent.completed()
  }
  world.reducerPlan = () => getActivePlan(memory.planningState(KEY))
  return world
}

test('multi-step task completes without any Jev correctness question family', async () => {
  const world = harness()
  const first = await world.say('mine 10 iron, copper, and coal', 'new_goal')

  assert.equal(first.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.game.mutations.length, 1)

  await world.finish('iron-ore')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1)
  assert.equal(world.game.mutations.length, 2)

  await world.finish('copper-ore')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 2)
  assert.equal(world.game.mutations.length, 3)

  const done = await world.finish('coal')
  assert.equal(done.goalStatus, 'completed')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMPLETED)

  const forbiddenQuestions = new Set([
    'scope_review',
    'step_relation',
    'checkpoint_boundary',
    'receipt_scope',
    'compound_step',
    'contract',
    'synthesis_mode',
  ])
  for (const call of world.jev.calls) {
    for (const key of call.keys) {
      assert.equal(forbiddenQuestions.has(key), false, `retired Jev correctness question was called: ${key}`)
    }
  }
})

test('a first-draft deterministic checkpoint commits without creating throwaway plan revisions', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined)
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      checkpoint: inventoryCheckpoint('iron-ore', 10),
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  await agent.request('gather 10 iron ore', { sender: 'Louis' })
  const planning = memory.planningState(KEY)
  assert.equal(planning.plans.length, 1)
  assert.equal(getActivePlan(planning).status, PLAN_STATUS.COMMITTED)
  assert.equal(getActivePlan(planning).steps[0].completion_contract.requirements[0].minimum, 10)
})

test('continue after a finished goal does not invent a goal named continue', async () => {
  const world = harness()
  await world.say('mine 10 iron, copper, and coal', 'new_goal')
  await world.finish('iron-ore')
  await world.finish('copper-ore')
  await world.finish('coal')

  const plannerCalls = world.plannerCalls
  const reply = await world.say('continue', 'continue_current')
  assert.equal(reply.routedOnly, true)
  assert.match(reply.chatMessage, /no current goal/i)
  assert.equal(world.plannerCalls, plannerCalls)
  assert.notEqual(world.memory.currentPlan(KEY)?.objective, 'continue')
})

test('a misnamed prototype gets one deterministic correction turn instead of a Jev review loop', async () => {
  let rejections = 1
  const game = new FakeFactorio({
    preflight: () => (rejections-- > 0
      ? { ok: false, code: 'unknown_prototype', operation: 'gather_resource' }
      : { ok: true }),
  })
  const world = harness({
    game,
    provider: async () => planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      checkpoint: inventoryCheckpoint('iron-ore', 10),
    }),
  })

  const result = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.plannerCalls, 2)
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(game.mutations.length, 1)
})

test('a deterministically blocked plan explains itself and requires user revision', async () => {
  let reject = true
  const game = new FakeFactorio({
    preflight: () => (reject
      ? { ok: false, code: 'unknown_prototype', operation: 'gather_resource' }
      : { ok: true }),
  })
  const world = harness({
    game,
    provider: async () => planReply({
      plan: ['Gather 10 iron ore'],
      operations: [gather('iron-ore', 10)],
      checkpoint: inventoryCheckpoint('iron-ore', 10),
    }),
  })

  const blocked = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(blocked.goalStatus, 'blocked')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.BLOCKED)

  const callsBefore = world.plannerCalls
  const explained = await world.say('continue', 'continue_current')
  assert.equal(explained.routedOnly, true)
  assert.match(explained.chatMessage, /blocked/i)
  assert.equal(world.plannerCalls, callsBefore)

  reject = false
  const revised = await world.say('try again with the corrected route', 'amend_current')
  assert.equal(revised.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(game.mutations.length, 1)
})

test('a malformed submitPlan tool call is recovered rather than becoming a fatal request', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined)
  const events = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) {
        return {
          content: '',
          tool_calls: [{
            id: 'p1',
            type: 'function',
            function: {
              name: 'submitPlan',
              arguments: '{"chatMessage":"Gathering","plan":["Gather 10 coal"],"currentStep":0,"operations":[{"name":"gather_resource","args":{"resource_name":"coal","count":10',
            },
          }],
        }
      }
      return planReply({
        plan: ['Gather 10 coal'],
        operations: [gather('coal', 10)],
        checkpoint: inventoryCheckpoint('coal', 10),
      })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    onActivity: event => events.push(event),
  })

  const result = await agent.request('gather 10 coal', { sender: 'Louis' })
  assert.equal(result.goalStatus, 'active')
  assert.equal(game.mutations.length, 1)
  assert.ok(events.includes('provider.plan_submission_invalid'))
})

test('a submitPlan cut off inside its optional checkpoint keeps the complete operation plan', async () => {
  const game = new FakeFactorio({ inventory: { wood: 0 } })
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined)
  const events = []
  let calls = 0
  const truncated = '{"chatMessage":"Harvesting wood","plan":["Harvest 3 wood"],"currentStep":0,"operations":[{"name":"harvest_product","args":{"product_name":"wood","count":3,"search_radius":256}}],"checkpoint"::'
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      return { content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submitPlan', arguments: truncated } }] }
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    onActivity: event => events.push(event),
  })

  const result = await agent.request('harvest exactly 3 wood', { sender: 'Louis' })
  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1)
  assert.equal(game.mutations.length, 1)
  assert.ok(events.includes('provider.plan_submission_salvaged'))
})

test('an unmet deterministic checkpoint cannot be replaced by a semantic completion claim', async () => {
  const game = new FakeFactorio({ inventory: { 'iron-ore': 0 } })
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) =>
    questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined)
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planReply({
          plan: ['Gather 10 iron ore'],
          operations: [gather('iron-ore', 10)],
          checkpoint: inventoryCheckpoint('iron-ore', 10),
        })
      }
      const stepId = memory.currentPlan(KEY)?.task_board?.active_step_id
      return planReply({
        chatMessage: 'Claim complete.',
        plan: [],
        operations: [],
        semanticCompletion: { stepId, rationale: 'Attempted semantic bypass.' },
      })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })

  await agent.request('gather 10 iron ore', { sender: 'Louis' })
  game.inventory['iron-ore'] = 5
  await assert.rejects(agent.completed(), /semantic_completion_cannot_bypass_deterministic_contract/)
  assert.equal(memory.currentPlan(KEY).task_board.completed_count, 0)
})

test('moving on to the next step with its operations closes a grounded prose-only step', async () => {
  // The 2026-09-24 cloud trial shape: the planner advanced currentStep with the
  // next step's operation but never sent the explicit semanticCompletion.
  const steps = ['Mine 10 stone', 'Mine 10 coal', 'Verify 10 stone and 10 coal are held']
  const world = harness({
    provider: async () => {
      const board = world.memory.currentPlan(KEY)?.task_board
      if (!board) return planReply({ plan: steps, currentStep: 0, operations: [gather('stone', 10)] })
      // The later, still-proposed step is reworded, as in the trial.
      return planReply({ plan: [...steps.slice(0, 2), 'Verify the coal is held'], currentStep: 1, operations: [gather('coal', 10)] })
    },
  })
  await world.say('mine 10 stone, then 10 coal', 'new_goal')
  assert.equal(world.memory.currentPlan(KEY).task_board.active_index, 0)

  await world.finish('stone')
  const board = world.memory.currentPlan(KEY).task_board
  assert.equal(board.completed_count, 1)
  assert.equal(board.active_step_id, 'step_2')
  assert.equal(world.reducerPlan().active_step_index, 1)
  assert.equal(world.game.mutations.length, 2)
})

test('a new-goal planning turn is told to plan at outline level; a continuation is not', async () => {
  // 2026-09-24 burner-drill canary: strategic effort spent the whole 8,000-unit
  // output cap reasoning through every later step before emitting a plan.
  const seen = []
  const world = harness({
    provider: async messages => {
      seen.push(messages.some(message => String(message.content ?? '').startsWith('[PLANNING_LOD]')))
      const board = world.memory.currentPlan(KEY)?.task_board
      if (!board) return planReply({ plan: ['Mine 10 stone', 'Mine 10 coal'], operations: [gather('stone', 10)] })
      return planReply({ plan: ['Mine 10 stone', 'Mine 10 coal'], currentStep: 1, operations: [gather('coal', 10)] })
    },
  })
  await world.say('mine 10 stone, then 10 coal', 'new_goal')
  await world.finish('stone')

  assert.deepEqual(seen, [true, false])
})
