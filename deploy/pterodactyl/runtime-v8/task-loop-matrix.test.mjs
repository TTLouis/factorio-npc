// Whole-loop regressions: each test drives the real NpcAgentLoop through
// request() / completed() the way the supervisor does, against a fake Factorio
// speaking the real RCON protocol and a Jev answering in the live provider
// shape. Reducer tests prove transitions; these prove the loop reaches them.
import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const KEY = 'npc:airi'
const RESOURCES = ['iron-ore', 'copper-ore', 'coal']
const STEPS = ['Mine 10 iron ore', 'Mine 10 copper ore', 'Mine 10 coal']
const REFINE = { overrides: { scope_review: { choice: 'refine', confidence: 0.8 }, scope_review_reason_codes: { choice: 'too_broad' } } }

function harness({ game = new FakeFactorio(), jev: jevScript, systemPrompt = 'task loop matrix', observe } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, intent: 'new_goal', plannerCalls: 0, jevScript }
  world.jev = recordingJev(async (state, questions, call) => {
    if (questions.intent) return { overrides: { intent: { choice: world.intent, confidence: 0.9 } } }
    return world.jevScript?.(state, questions, call)
  })
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      world.plannerCalls++
      assert.ok(world.plannerCalls < 20, 'planner loop did not terminate')
      if (observe && world.plannerCalls === 1) return observe()
      const step = memory.currentPlan(KEY)?.current_step ?? 0
      const resource = RESOURCES[Math.min(step, 2)]
      return planReply({
        plan: STEPS,
        currentStep: step,
        operations: [gather(resource, 10)],
        checkpoint: inventoryCheckpoint(resource, 10),
      })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: 'ok' }) }),
    interactionDecisionProvider: world.jev,
    scopeReviewDecisionProvider: world.jev,
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
  world.finish = resource => {
    game.inventory[resource] = (game.inventory[resource] ?? 0) + 10
    return world.agent.completed()
  }
  world.reducerPlan = () => getActivePlan(memory.planningState(KEY))
  world.scopeReviews = () => world.jev.callsWith('scope_review').length
  return world
}

async function runToCompletion(world) {
  let result
  for (const resource of RESOURCES) result = await world.finish(resource)
  return result
}

test('a committed multi-step plan runs to verified completion without Jev correctness review', async () => {
  const world = harness()
  const first = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.equal(first.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.scopeReviews(), 0, 'plan commit must not ask Jev to approve the draft')

  const last = await runToCompletion(world)
  assert.equal(last.goalStatus, 'completed')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMPLETED)
  assert.equal(world.game.mutations.length, 3)
  assert.equal(world.scopeReviews(), 0)
  const planning = world.memory.planningState(KEY)
  assert.equal(planning.goal.status, 'completed', 'a finite goal told "verified complete" must be satisfied in the reducer too')
  assert.equal(planning.goal.satisfaction?.source, 'runtime')
})

test('a first-draft commit yields exactly one plan record', async () => {
  const world = harness()
  await world.say('gather 10 iron ore', 'new_goal')
  const planning = world.memory.planningState(KEY)
  assert.equal(planning.plans.length, 1, 'checkpoint discovery must not mint a throwaway superseded draft')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.ok(world.reducerPlan().steps[0].completion_contract, 'the refreshed contract still lands on the committed plan')
})

test('continue after a finished goal does not invent a goal named "continue"', async () => {
  const world = harness()
  await world.say('semi-automate iron and copper plates', 'new_goal')
  await runToCompletion(world)
  const plannerCalls = world.plannerCalls

  const reply = await world.say('continue', 'continue_current')
  assert.equal(reply.routedOnly, true)
  assert.match(reply.chatMessage, /no current goal/)
  assert.equal(world.plannerCalls, plannerCalls)
  assert.notEqual(world.memory.currentPlan(KEY)?.objective, 'continue')
})

test('a hostile Jev scope-review answer is outside plan-commit authority', async () => {
  const world = harness({ jev: (_state, questions) => (questions.scope_review ? REFINE : undefined) })
  const first = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.equal(first.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.scopeReviews(), 0, 'scope review is not on the live commit path')

  const last = await runToCompletion(world)
  assert.equal(last.goalStatus, 'completed')
  assert.equal(world.scopeReviews(), 0)
})

test('an unavailable Jev scope-review provider cannot delay deterministic plan commit', async () => {
  const world = harness({
    jev: (_state, questions) => {
      if (questions.scope_review) throw new Error('decision provider budget exhausted')
    },
  })
  const first = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(first.goalStatus, 'active')
  assert.equal(first.operations.length, 1)
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.plannerCalls, 1)
  assert.equal(world.scopeReviews(), 0, 'the unavailable correctness reviewer is never called')
})

test('Jev scope criticism cannot pause or block a preflight-valid task', async () => {
  const world = harness({ jev: (_state, questions) => (questions.scope_review ? REFINE : undefined) })
  const result = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.memory.currentPlan(KEY).pause_reason, '')
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.scopeReviews(), 0)
})

test('a misnamed prototype gets one correction turn instead of freezing the plan', async () => {
  let rejections = 1
  const game = new FakeFactorio({
    preflight: () => (rejections-- > 0 ? { ok: false, code: 'unknown_prototype', operation: 'gather_resource' } : { ok: true }),
  })
  const world = harness({ game })
  const result = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(result.goalStatus, 'active')
  assert.equal(world.plannerCalls, 2)
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(game.mutations.length, 1)
})

test('a blocked plan explains itself on continue and a chat amendment revises it', async () => {
  let reject = true
  const game = new FakeFactorio({
    preflight: () => (reject ? { ok: false, code: 'unknown_prototype', operation: 'gather_resource' } : { ok: true }),
  })
  const world = harness({ game })
  const blocked = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.equal(blocked.goalStatus, 'blocked')
  assert.match(blocked.chatMessage, /^\[Plan blocked\]/)
  const blockedPlan = world.reducerPlan()
  assert.equal(blockedPlan.status, PLAN_STATUS.BLOCKED)

  reject = false
  const plannerCallsBefore = world.plannerCalls
  const explained = await world.say('continue', 'continue_current')
  assert.equal(explained.routedOnly, true)
  assert.match(explained.chatMessage, /blocked/)
  assert.equal(world.plannerCalls, plannerCallsBefore, 'a bare continue on a frozen plan must not wake the planner')

  const revised = await world.say('try again with a different route', 'amend_current')
  assert.equal(revised.goalStatus, 'active')
  const successor = world.reducerPlan()
  assert.equal(successor.status, PLAN_STATUS.COMMITTED)
  assert.equal(successor.derived_from_plan_id, blockedPlan.plan_id)
  assert.equal(game.mutations.length, 1)
})

test('large observations do not summon a pre-commit Jev correctness packet', async () => {
  const game = new FakeFactorio()
  const baseCommand = game.command.bind(game)
  game.command = async (text) => {
    const raw = await baseCommand(text)
    return raw === '{}' ? JSON.stringify({ items: 'x'.repeat(9000) }) : raw
  }
  const packets = []
  const world = harness({
    game,
    systemPrompt: 'P'.repeat(30000),
    jev: (state, questions) => {
      if (questions.scope_review) packets.push(state)
    },
    observe: () => ({
      content: '',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } },
      ],
    }),
  })
  const result = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(result.goalStatus, 'active')
  assert.equal(game.mutations.length, 1)
  assert.deepEqual(packets, [])
  assert.equal(world.scopeReviews(), 0)
})

function uncheckpointedGather(game) {
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) => (questions.intent
    ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    : undefined))
  let plannerCalls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    // The live planner often submits a gather with no checkpoint at all.
    provider: async () => {
      plannerCalls++
      return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  return { agent, memory, plannerCalls: () => plannerCalls }
}

test('an uncheckpointed gather closes on the grounded inventory delta, not a model claim', async () => {
  const game = new FakeFactorio({ inventory: { coal: 3 } })
  const run = uncheckpointedGather(game)
  await run.agent.request('gather 10 coal, nothing else', { sender: 'Louis' })
  game.inventory.coal = 13
  const done = await run.agent.completed()
  assert.equal(done.goalStatus, 'completed')
  assert.equal(run.plannerCalls(), 1, 'the runtime closes the goal without asking the planner')
})

test('the inventory delta is relative to what was already held', async () => {
  const game = new FakeFactorio({ inventory: { coal: 3 } })
  const run = uncheckpointedGather(game)
  await run.agent.request('gather 10 coal, nothing else', { sender: 'Louis' })
  // Receipt completes, but only 9 new coal actually arrived.
  game.inventory.coal = 12
  await run.agent.completed()
  const state = run.memory.currentPlan(KEY)
  assert.notEqual(state?.status, 'completed')
  assert.equal(state?.task_board?.completed_count ?? 0, 0)
})

test('a malformed submitPlan tool call is recovered, not a fatal request failure', async () => {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) => (questions.intent
    ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    : undefined))
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
          tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submitPlan', arguments: '{"chatMessage":"Gathering","plan":["Gather 10 coal"],"currentStep":0,"operations":[{"name":"gather_resource","args":{"resource_name":"coal","count":10' } }],
        }
      }
      return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
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

test('harvest_product gets the same grounded inventory delta as gather_resource', async () => {
  const game = new FakeFactorio({ inventory: { wood: 2 } })
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) => (questions.intent
    ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => planReply({
      plan: ['Gather 6 wood'],
      operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 6, search_radius: 32 } }],
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  await agent.request('gather 6 wood, nothing else', { sender: 'Louis' })
  const board = memory.currentPlan(KEY).task_board
  const contract = board.steps[0].completion_contract
  assert.deepEqual(contract?.requirements?.map(r => [r.kind, r.item_name, r.minimum]), [['inventory_count', 'wood', 8]])
})

async function keptOpenGather(compoundProbability) {
  const game = new FakeFactorio({ inventory: { 'iron-ore': 0 } })
  const memory = new CanonicalTaskBoardMemory()
  // Live Jev: picked the grounded delta but forecast keep_step_open, then
  // rated the completed receipt progress_only at 0.2.
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.receipt_scope) return { overrides: { receipt_scope: { choice: 'progress_only', confidence: 0.2 } } }
    if (questions.checkpoint_boundary) {
      return { overrides: {
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.88 },
        compound_step: { noul: compoundProbability },
      } }
    }
  })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      return planReply({ plan: ['Gather 4 iron ore'], operations: [gather('iron-ore', 4)] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  await agent.request('gather 4 iron ore, nothing else', { sender: 'Louis' })
  game.inventory['iron-ore'] = 4
  let result
  try { result = await agent.completed() }
  catch (error) { result = { error } }
  return { result, calls, memory }
}

test('a non-compound step Jev kept open still closes on its met world-state contract', async () => {
  const { result, calls } = await keptOpenGather(0.37)
  assert.equal(result.goalStatus, 'completed')
  assert.equal(calls, 1)
})

test('a step Jev judged compound stays open even when its partial contract is met', async () => {
  const { result, memory } = await keptOpenGather(0.8)
  assert.notEqual(result?.goalStatus, 'completed')
  assert.equal(memory.currentPlan(KEY)?.task_board?.completed_count ?? 0, 0)
})

test('a submitPlan cut off inside its optional checkpoint keeps the complete plan', async () => {
  const game = new FakeFactorio({ inventory: { wood: 0 } })
  const memory = new CanonicalTaskBoardMemory()
  const jev = recordingJev(async (_state, questions) => (questions.intent
    ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    : undefined))
  const events = []
  let calls = 0
  // Exact live deepseek signature: clean finish, stops at `"checkpoint"::`.
  const truncated = '{"chatMessage": "Harvesting wood", "plan": ["Harvest 3 wood"], "currentStep": 0, "operations": [{"name": "harvest_product", "args": {"product_name": "wood", "count": 3, "search_radius": 256}}], "checkpoint"::'
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      return { content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submitPlan', arguments: truncated } }] }
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
    onActivity: event => events.push(event),
  })
  const result = await agent.request('harvest exactly 3 wood, that is the only task', { sender: 'Louis' })
  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1, 'the salvaged plan needs no recovery round')
  assert.equal(game.mutations.length, 1)
  assert.ok(events.includes('provider.plan_submission_salvaged'))
  game.inventory.wood = 3
  const done = await agent.completed()
  assert.equal(done.goalStatus, 'completed')
})

async function laterStepWork(stoneHeld) {
  const game = new FakeFactorio({ inventory: { stone: 0, coal: 0 } })
  const memory = new CanonicalTaskBoardMemory()
  const activeStepText = () => {
    const board = memory.currentPlan(KEY)?.task_board
    return board?.steps?.[board.active_index]?.description ?? ''
  }
  // Live Jev on goal_muarr9vw: stone step rated 0.52 compound and kept open,
  // receipt rated progress_only, then the coal batch classified as later-step
  // work because the board never left the stone step.
  const jev = recordingJev(async (state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.receipt_scope) return { overrides: { receipt_scope: { choice: 'progress_only', confidence: 0.2 } } }
    if (questions.route) return { overrides: { route: { choice: 'reanchor_plan', confidence: 0.8 } } }
    if (questions.checkpoint_boundary) {
      const coalBatch = JSON.stringify(state).includes('"resource_name":"coal"')
      const onStoneStep = /stone/i.test(activeStepText())
      return { overrides: {
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.53 },
        compound_step: { noul: 0.52 },
        step_relation: { choice: coalBatch && onStoneStep ? 'belongs_to_later_step' : 'advances_current', confidence: 0.9 },
      } }
    }
  })
  const plan = ['Gather 5 stone', 'Separately gather 5 coal']
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) return planReply({ plan, operations: [gather('stone', 5)] })
      // The planner correctly judges stone done and moves to coal.
      return planReply({ chatMessage: 'Step 1 complete. Now step 2.', plan, currentStep: 1, operations: [gather('coal', 5)] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  await agent.request('first gather 5 stone, then separately gather 5 coal', { sender: 'Louis' })
  game.inventory.stone = stoneHeld
  let next
  try { next = await agent.completed() }
  catch (error) { next = { error } }
  return { next, memory, game }
}

test('a met active step is closed when the planner and Jev both place new work in the next step', async () => {
  const { next, memory, game } = await laterStepWork(5)
  assert.equal(next.goalStatus, 'active', `stalled: ${next?.chatMessage}`)
  assert.equal(memory.currentPlan(KEY).task_board.completed_count, 1)
  assert.equal(game.mutations.length, 2, 'the coal batch was admitted under the coal step')
})

test('an unmet active step is not closed just because the planner moved on', async () => {
  const { next, memory, game } = await laterStepWork(4)
  assert.notEqual(next?.goalStatus, 'active')
  assert.equal(memory.currentPlan(KEY)?.task_board?.completed_count ?? 0, 0)
  assert.equal(game.mutations.length, 1, 'the coal batch was never admitted under the stone step')
})

// Every step that stays open must say why (step.close_declined).
function recordCloseDeclines(agent) {
  const declines = []
  const trace = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => {
    if (event === 'step.close_declined') declines.push(data)
    return trace(event, data)
  }
  return declines
}

async function plannerSaysDone({ held, compoundProbability = 0.8, route = 'reanchor_plan' }) {
  const game = new FakeFactorio({ inventory: { wood: 0 } })
  const memory = new CanonicalTaskBoardMemory()
  // Live req_mubdxf20_1: Jev kept the wood step open, then the planner
  // correctly reported the goal done with an empty plan and no tool call.
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.receipt_scope) return { overrides: { receipt_scope: { choice: 'progress_only', confidence: 0.2 } } }
    if (questions.route && route) return { overrides: { route: { choice: route, confidence: 0.8 } } }
    if (questions.checkpoint_boundary) {
      return { overrides: {
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.88 },
        compound_step: { noul: compoundProbability },
      } }
    }
  })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planReply({
          plan: ['Harvest 7 wood'],
          operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 7, search_radius: 32 } }],
          checkpoint: inventoryCheckpoint('wood', 7),
        })
      }
      return planReply({ chatMessage: 'Done: wood total is 8 (>= 7). No steps remain.', plan: [], operations: [] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  const declines = recordCloseDeclines(agent)
  await agent.request('harvest 7 wood, that is the only task', { sender: 'Louis' })
  game.inventory.wood = held
  let result
  try { result = await agent.completed() }
  catch (error) { result = { error } }
  return { result, calls, memory, declines }
}

test('a planner "done" is accepted when the kept-open step contract is met in Factorio', async () => {
  const { result, memory } = await plannerSaysDone({ held: 8 })
  assert.equal(result.goalStatus, 'completed', `not closed: ${result?.chatMessage ?? result?.error?.message}`)
  assert.equal(memory.planningState(KEY)?.goal?.status, 'completed', 'the reducer goal is satisfied, not just the board')
})

test('a planner "done" is not accepted while the step contract is unmet', async () => {
  const { result, declines } = await plannerSaysDone({ held: 5 })
  assert.notEqual(result?.goalStatus, 'completed')
  assert.ok(declines.some(item => item.reason === 'target_unmet'), `no traced reason: ${JSON.stringify(declines)}`)
})

test('a planner "done" on a plain completion turn cannot close an unmet quantity goal', async () => {
  const { result, memory, declines } = await plannerSaysDone({ held: 5, route: 'continue_current' })
  assert.notEqual(result?.goalStatus, 'completed', 'closed with 5 of 7 wood')
  assert.ok(declines.some(item => item.reason === 'target_unmet'), `no traced reason: ${JSON.stringify(declines)}`)
  assert.notEqual(memory.planningState(KEY)?.goal?.status, 'completed')
})

test('a planner "done" on a plain completion turn still closes a met quantity goal', async () => {
  const { result } = await plannerSaysDone({ held: 8, route: 'continue_current' })
  assert.equal(result?.goalStatus, 'completed', `not closed: ${result?.chatMessage ?? result?.error?.message}`)
})

async function verifyOnlyStep({ heldAtDone, verifyBoundary = 'checkpoint_here' }) {
  const game = new FakeFactorio({ inventory: { stone: 0 } })
  const memory = new CanonicalTaskBoardMemory()
  // Live req_mubeawua_1: step 1 closed on stone>=6, the plan's step 2 was a
  // work-less "verify" step, and the planner then said done with no tool call.
  const jev = recordingJev(async (state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.checkpoint_boundary && state?.planner_claim) {
      assert.equal(questions.step_relation, undefined, 'a done claim has no batch to relate')
      // Live req_mubf15vp_1 answered `unrelated` for the empty batch.
      return { overrides: {
        checkpoint_boundary: { choice: verifyBoundary, confidence: 0.9 },
        compound_step: { noul: 0.1 },
        step_relation: { choice: 'unrelated', confidence: 0.6 },
      } }
    }
  })
  const plan = ['Gather 6 stone', 'Verify inventory shows 6 stone']
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) return planReply({ plan, operations: [gather('stone', 6)], checkpoint: inventoryCheckpoint('stone', 6) })
      return planReply({ chatMessage: 'Task complete, I hold 6 stone.', plan: [], operations: [] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  const declines = recordCloseDeclines(agent)
  await agent.request('gather 6 stone, that is the only task', { sender: 'Louis' })
  game.inventory.stone = 6
  // Step 1 closes on its receipt/contract and the planner is asked what next.
  const afterGather = { stone: heldAtDone }
  const base = game.command.bind(game)
  game.command = async text => {
    if (text.includes('evaluate_condition') && memory.currentPlan(KEY)?.task_board?.completed_count >= 1) {
      Object.assign(game.inventory, afterGather)
    }
    return base(text)
  }
  let result
  try { result = await agent.completed() }
  catch (error) { result = { error } }
  return { result, memory, jev, declines }
}

test('a work-less verify step closes when Jev maps it to an earlier met target', async () => {
  const { result, memory, jev } = await verifyOnlyStep({ heldAtDone: 6 })
  assert.ok(jev.calls.some(call => call.state?.planner_claim), 'Jev was asked about the verify step')
  assert.equal(result?.goalStatus, 'completed', `not closed: ${result?.chatMessage ?? result?.error?.message}`)
  assert.equal(memory.planningState(KEY)?.goal?.status, 'completed')
})

test('a work-less verify step stays open when the earlier target no longer holds', async () => {
  const { result, declines } = await verifyOnlyStep({ heldAtDone: 5 })
  assert.notEqual(result?.goalStatus, 'completed')
  assert.ok(declines.some(item => item.trigger === 'planner_done' && item.reason === 'target_unmet'),
    `no traced reason: ${JSON.stringify(declines)}`)
})

test('a work-less verify step stays open when Jev does not map an earlier target onto it', async () => {
  const { result, declines } = await verifyOnlyStep({ heldAtDone: 6, verifyBoundary: 'keep_step_open' })
  assert.notEqual(result?.goalStatus, 'completed')
  assert.ok(declines.some(item => item.trigger === 'planner_done' && item.reason === 'mapping_declined'),
    `no traced reason: ${JSON.stringify(declines)}`)
})

async function revisedStepDone({ heldAtDone }) {
  const game = new FakeFactorio({ inventory: { coal: 10 } })
  const memory = new CanonicalTaskBoardMemory()
  // Live req_mubenlbp_1: step_1 kept open on its grounded delta (coal>=15),
  // a refinement reworded the draft step (new id, semantic_unknown
  // checkpoint), then the planner said done holding 15 coal.
  let reviews = 0
  const jev = recordingJev(async (state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.scope_review && ++reviews === 1) return REFINE
    if (questions.receipt_scope) return { overrides: { receipt_scope: { choice: 'progress_only', confidence: 0.2 } } }
    if (questions.route) return { overrides: { route: { choice: 'reanchor_plan', confidence: 0.8 } } }
    if (questions.checkpoint_boundary && state?.planner_claim) {
      return { overrides: { step_relation: { choice: 'unrelated', confidence: 0.6 } } }
    }
    if (questions.checkpoint_boundary && !state?.planner_claim) {
      const revised = /finish/i.test(state?.step?.description ?? '')
      return { overrides: {
        ...(revised ? { contract: { choice: 'semantic_unknown', confidence: 0.9 } } : {}),
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.8 },
        compound_step: { noul: 0.8 },
      } }
    }
  })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) return planReply({ plan: ['Gather 5 coal'], operations: [gather('coal', 5)] })
      if (calls === 2) return planReply({ plan: ['Finish gathering the 5 coal'], operations: [gather('coal', 5)] })
      return planReply({ chatMessage: 'Complete, inventory holds 15 coal.', plan: [], operations: [] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  await agent.request('gather exactly 5 coal, that is the only task', { sender: 'Louis' })
  const first = { chatMessage: 'after refinement' }
  const revisedStepId = memory.currentPlan(KEY)?.task_board?.active_step_id
  game.inventory.coal = heldAtDone
  let result
  try { result = await agent.completed() }
  catch (error) { result = { error } }
  return { first, result, revisedStepId, memory, calls }
}

test('a planner "done" on a reworded step can use the target its replaced revision recorded', async () => {
  const { first, result, revisedStepId, memory } = await revisedStepDone({ heldAtDone: 15 })
  assert.match(revisedStepId ?? '', /_r\d+$/, `the reanchor did not reword the step: ${first?.chatMessage ?? first?.error?.message}`)
  assert.equal(result?.goalStatus, 'completed', `not closed: ${result?.chatMessage ?? result?.error?.message}`)
  assert.equal(memory.planningState(KEY)?.goal?.status, 'completed')
})

test('a reworded step does not close on its replaced revision target when that target is unmet', async () => {
  const { result } = await revisedStepDone({ heldAtDone: 14 })
  assert.notEqual(result?.goalStatus, 'completed')
})

test('retired scope-review grounding cannot reopen the observation budget', async () => {
  const game = new FakeFactorio({ inventory: { 'iron-ore': 13 } })
  const memory = new CanonicalTaskBoardMemory()
  let reviews = 0
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 }, ...(questions.observation_budget ? { observation_budget: { score: 3 } } : {}) } }
    if (questions.observation_budget) return { overrides: { observation_budget: { score: 3 } } }
    if (questions.scope_review) {
      reviews++
      return { overrides: { scope_review: { choice: 'needs_grounding', confidence: 0.4 }, scope_review_reason_codes: { choice: 'assumption_not_grounded' } } }
    }
  })
  const offered = []
  let calls = 0
  const read = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } })
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (_messages, options) => {
      calls++
      offered.push(options?.allowTools)
      assert.ok(calls < 12, 'planner loop did not terminate')
      if (calls === 1) {
        return { content: '', tool_calls: [read('t1', 'getInventoryItems'), read('t2', 'getActorStatus'), read('t3', 'getNearbyEntities')] }
      }
      return planReply({ plan: ['Gather 40 iron ore'], operations: [gather('iron-ore', 40)] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  const result = await agent.request('mine exactly 40 iron ore, that is the only task', { sender: 'Louis' })
  assert.equal(result.goalStatus, 'active')
  assert.equal(reviews, 0)
  assert.equal(game.mutations.length, 1)
  assert.equal(offered.slice(2).some(Boolean), false, 'retired scope review must not grant a fresh observation phase')
})

async function leadingConfirmStep({ redraft }) {
  const game = new FakeFactorio({ inventory: { 'iron-ore': 13 } })
  const memory = new CanonicalTaskBoardMemory()
  const activeStepText = () => {
    const board = memory.currentPlan(KEY)?.task_board
    return board?.steps?.[board.active_index]?.description ?? ''
  }
  // Live req_mubf6mpl_2: the draft led with a work-less "confirm" step and
  // proposed the gather for step 2; Jev placed it in the later step twice.
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.checkpoint_boundary) {
      return { overrides: {
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.7 },
        step_relation: { choice: /confirm/i.test(activeStepText()) ? 'belongs_to_later_step' : 'advances_current', confidence: 0.9 },
      } }
    }
  })
  const messages = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async providerMessages => {
      calls++
      messages.push(providerMessages.map(message => typeof message.content === 'string' ? message.content : '').join(' | '))
      if (calls === 1 || !redraft) {
        return planReply({
          plan: ['Confirm current iron ore held in inventory (13)', 'Mine 27 more iron ore', 'Verify inventory shows 40 iron ore'],
          currentStep: 1,
          operations: [gather('iron-ore', 27)],
        })
      }
      return planReply({ plan: ['Mine 27 more iron ore to hold 40'], currentStep: 0, operations: [gather('iron-ore', 27)] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  let result
  try { result = await agent.request('mine exactly 40 iron ore, that is the only task', { sender: 'Louis' }) }
  catch (error) { result = { error } }
  return { result, game, messages }
}

test('a draft led by a work-less step gets told it can drop that step, and a redraft commits', async () => {
  const { result, game, messages } = await leadingConfirmStep({ redraft: true })
  assert.match(String(messages[1]), /no operation of its own/i)
  assert.equal(game.mutations.length, 1, `redraft not admitted: ${result?.chatMessage ?? result?.error?.message}`)
})

async function lowConfidenceTargetDone({ held }) {
  const game = new FakeFactorio({ inventory: { 'iron-ore': 13 } })
  const memory = new CanonicalTaskBoardMemory()
  // Live goal_mubfl8p6: at admission Jev picked the grounded delta
  // (iron-ore>=53) at 0.32 confidence, so the step recorded semantic_unknown;
  // after the batch the planner said done with nothing left to check.
  const jev = recordingJev(async (state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
    if (questions.receipt_scope) return { overrides: { receipt_scope: { choice: 'progress_only', confidence: 0.35 } } }
    if (questions.route) return { overrides: { route: { choice: 'reanchor_plan', confidence: 0.8 } } }
    if (questions.checkpoint_boundary && !state?.planner_claim) {
      return { overrides: {
        contract: { choice: 'candidate_1', confidence: 0.32 },
        checkpoint_boundary: { choice: 'keep_step_open', confidence: 0.56 },
        compound_step: { noul: 0.54 },
      } }
    }
  })
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) return planReply({ plan: ['Mine 40 iron ore from the nearest patch'], operations: [gather('iron-ore', 40)] })
      return planReply({ chatMessage: 'Mining complete, the 40 iron ore goal is fulfilled.', plan: [], operations: [] })
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    scopeReviewDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'task loop matrix',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'airi',
  })
  await agent.request('mine exactly 40 iron ore, that is the only task', { sender: 'Louis' })
  game.inventory['iron-ore'] = held
  let result
  try { result = await agent.completed() }
  catch (error) { result = { error } }
  return { result, jev }
}

test('a done claim can re-offer the step\'s own target Jev was unsure of before the batch ran', async () => {
  const { result, jev } = await lowConfidenceTargetDone({ held: 53 })
  const claim = jev.calls.find(call => call.state?.planner_claim)
  assert.ok(claim, 'Jev was asked about the done claim')
  assert.equal(result?.goalStatus, 'completed', `not closed: ${result?.chatMessage ?? result?.error?.message}`)
})

test('a re-offered own target still has to hold in Factorio', async () => {
  const { result } = await lowConfidenceTargetDone({ held: 50 })
  assert.notEqual(result?.goalStatus, 'completed')
})
