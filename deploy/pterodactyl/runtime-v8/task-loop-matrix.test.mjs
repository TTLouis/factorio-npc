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

test('a committed multi-step plan runs to verified completion with one pre-commit scope review', async () => {
  const world = harness()
  const first = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.equal(first.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)

  const last = await runToCompletion(world)
  assert.equal(last.goalStatus, 'completed')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMPLETED)
  assert.equal(world.game.mutations.length, 3)
  assert.equal(world.scopeReviews(), 1, 'later batches fulfil the committed plan and are not re-reviewed')
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

test('a Jev refusal after commit cannot halt the frozen plan', async () => {
  // Commit the first draft under an actionable review, then make Jev hostile.
  const world = harness()
  await world.say('semi-automate iron and copper plates', 'new_goal')
  world.jevScript = (_state, questions) => (questions.scope_review ? REFINE : undefined)

  const last = await runToCompletion(world)
  assert.equal(last.goalStatus, 'completed')
  assert.equal(world.scopeReviews(), 1)
})

test('an unavailable Jev scope review is retried, then the draft commits on runtime validation', async () => {
  const world = harness({
    jev: (_state, questions) => {
      if (questions.scope_review) throw new Error('decision provider budget exhausted')
    },
  })
  const first = await world.say('gather 10 iron ore', 'new_goal')
  assert.equal(first.goalStatus, 'active')
  assert.equal(first.operations.length, 1)
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.plannerCalls, 1, 'unavailability must not spend the semantic refinement budget')
  assert.equal(world.scopeReviews(), 2, 'one retry before degrading')
})

test('refinement exhaustion pauses the plan visibly and continue resumes it', async () => {
  const world = harness({ jev: (_state, questions) => (questions.scope_review ? REFINE : undefined) })
  const stuck = await world.say('semi-automate iron and copper plates', 'new_goal')
  assert.match(stuck.chatMessage, /Plan needs clarification/)
  assert.equal(stuck.goalStatus, 'paused', 'the board must not show a running step while nothing runs')
  assert.equal(world.memory.currentPlan(KEY).pause_reason, 'jev_refinement_budget_exhausted')
  assert.equal(world.game.mutations.length, 0)

  world.jevScript = undefined
  const resumed = await world.say('continue', 'continue_current')
  assert.equal(resumed.goalStatus, 'active')
  assert.equal(world.reducerPlan().status, PLAN_STATUS.COMMITTED)
  assert.equal(world.game.mutations.length, 1)
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

test('large observations still reach the Jev grounding packet after context compaction', async () => {
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
      if (questions.scope_review) packets.push(state.grounding.recent_observations.map(item => item.tool))
    },
    observe: () => ({
      content: '',
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } },
        { id: 't2', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } },
      ],
    }),
  })
  await world.say('gather 10 iron ore', 'new_goal')
  assert.deepEqual(packets, [['getInventoryItems', 'getActorStatus']])
})
