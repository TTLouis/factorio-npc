import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { buildHandoffPacket } from './handoff-packet.mjs'
import { getActivePlan } from './planning-state.mjs'
import { normalizeExecutionGuidance, normalizePlannerReview } from './role-contracts.mjs'
import { providerRequest } from './provider.mjs'
import { executionOnlyControlToolDefinitions, planningOnlyControlToolDefinitions } from './structured-policy.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const brief = (skillIds = []) => ({ approach: 'Gather the copper needed for the current slice.',
  rationale: 'A small stock requirement does not repay extra setup yet.', constraints: ['Keep the requested quantity.'], skillIds })
const draft = (overrides = {}) => ({ chatMessage: '', plan: ['Gather ten copper ore'], currentStep: 0, operations: [],
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }],
  executionGuidance: [brief()],
  goal: { scope: 'finite', summary: 'Gather ten copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] },
  ...overrides })

function world(script, options = {}) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory, completionProtocolVersion: 3, replacementWake: true,
    provider: answersStepContract(async (messages, context) => {
      calls.push({ messages, context })
      const next = script[calls.length - 1]
      assert.ok(next, `Unexpected provider call ${calls.length}`)
      const reply = typeof next === 'function' ? await next({ agent, game, memory, messages, context }) : next
      return reply.tool_calls ? reply : planReply(reply)
    }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'Scripted role separation fixture.', npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null,
    onActivity: (event, data) => events.push({ event, data }), ...options,
  })
  return { agent, game, memory, calls, events, say: () => agent.request('Gather ten copper ore.', { sender: 'Louis' }),
    plan: () => getActivePlan(memory.planningState(KEY)) }
}

const action = ({ memory }) => ({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id,
  operations: [gather('copper-ore', 10)] })

const submit = args => ({ content: '', tool_calls: [{ id: 'role-contract-submit', type: 'function',
  function: { name: 'submitPlan', arguments: JSON.stringify(args) } }] })

test('submitPlan tool transport carries the planner brief and executor step identity through the real loop', async () => {
  const w = world([submit(draft()), ctx => submit(action(ctx))])
  await w.say()
  assert.equal(w.calls.length, 2)
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief())
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'provider.plan_submission_invalid').length, 0)
})

test('protocol 3 commits planning-only guidance before the executor chooses the first action', async () => {
  let identity
  const w = world([draft(), ctx => {
    assert.equal(ctx.context.role, 'executor')
    assert.equal(ctx.context.completionProtocolVersion, 3)
    assert.equal(ctx.game.mutations.length, 0)
    identity = ctx.agent.controlDecisionState(true)
    assert.deepEqual(identity.executionGuidance, brief())
    const outgoing = ctx.messages.map(row => row.content ?? '').join('\n')
    assert.match(outgoing, /execution_guidance.*Gather the copper/)
    assert.match(outgoing, /ROLE: EXECUTOR/)
    return action(ctx)
  }])
  await w.say()
  assert.equal(w.calls[0].context.role, 'planner')
  assert.equal(w.calls.length, 2)
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief())
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 0)
  const event = w.events.find(row => row.event === 'plan.delegation_committed')
  assert.ok(event.data.request_id)
  assert.equal(event.data.plan_id, identity.planId)
})

test('planner action proposals get a bounded correction before any admission', async () => {
  const w = world([draft({ operations: [gather('copper-ore', 10)] }), draft(), action])
  await w.say()
  assert.equal(w.calls.length, 3)
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'planner', 'executor'])
  assert.equal(w.game.mutations.length, 1)
  const event = w.events.find(row => row.event === 'role.contract_refused')
  assert.equal(event.data.reason, 'planner_cannot_mutate')
  assert.ok(event.data.request_id)
})

test('programmatic planner admission cannot bypass the action prohibition', async () => {
  const w = world([])
  await assert.rejects(w.agent.commitPlan(draft({ operations: [gather('copper-ore', 10)] })), /planner chooses strategy/)
  assert.equal(w.game.mutations.length, 0)
})

test('selecting an unloaded strategy skill is corrected instead of claiming its contents were considered', async () => {
  const w = world([draft({ executionGuidance: [brief(['not-loaded'])] }), draft(), action])
  await w.say()
  assert.equal(w.calls.length, 3)
  assert.equal(w.events.find(row => row.event === 'role.contract_refused').data.reason, 'invalid_execution_guidance')
})

test('the active brief persists through restart, isolates selected skills and cannot be rewritten by an executor', async () => {
  const w = world([({ agent }) => {
    agent.loadedSkillContext.set('selected', { id: 'selected', marker: 'SELECTED-DETAILS' })
    agent.loadedSkillContext.set('other', { id: 'other', marker: 'UNRELATED-ALTERNATIVE' })
    return draft({ executionGuidance: [brief(['selected'])] })
  }, ctx => {
    const context = ctx.agent.skillContext()
    assert.match(context, /SELECTED-DETAILS/)
    assert.doesNotMatch(context, /UNRELATED-ALTERNATIVE/)
    assert.equal(ctx.agent.roundTailBlocks().some(block => block.startsWith('[SKILL_OFFERS]')), false)
    return { ...action(ctx), plan: ['A different strategy'], executionGuidance: [brief(['other'])] }
  }])
  await w.say()
  assert.deepEqual(w.plan().steps[0].execution_guidance, brief(['selected']))
  assert.ok(w.events.some(row => row.event === 'executor.plan_semantics_ignored' && row.data.ignored_fields.includes('executionGuidance')))
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual(getActivePlan(restored.planningState(KEY)).steps[0].execution_guidance, brief(['selected']))
  const packet = buildHandoffPacket({ planningState: restored.planningState(KEY), role: 'executor', checkpoint: 'C6' })
  assert.match(packet.text, /execution_guidance.*selected/)
})

for (const reason of ['approach_infeasible', 'scope_change', 'local_recovery_exhausted']) {
  test(`executor ${reason} returns to planner without manufacturing blocker evidence or resetting allowance`, async () => {
    let before
    const w = world([draft(), ({ memory }) => {
      before = memory.planningState(KEY)
      return { stepId: getActivePlan(before).steps[0].step_id, operations: [], plannerReview: { reason, rationale: 'A strategic decision is needed.' } }
    }])
    const result = await w.say()
    assert.equal(result.blocker.class, 'planner_review_required')
    assert.equal(w.calls.length, 2, 'no automatic unbounded review/retry cycle')
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.agent.agentContext.role, 'planner')
    assert.ok(w.agent.messages.some(row => String(row.content).startsWith('[EXECUTOR_REVIEW]') && row.content.includes(reason)))
    assert.match(JSON.stringify(w.memory.snapshot()), /Executor advisory; unverified/)
    assert.equal(w.memory.currentPlan(KEY).status, 'paused')
    assert.notEqual(w.plan().status, 'BLOCKED', 'model claim is not world proof')
    assert.equal(w.plan().plan_id, getActivePlan(before).plan_id)
    assert.deepEqual(w.plan().steps, getActivePlan(before).steps)
    assert.equal(w.memory.planningState(KEY).goal.fresh_context_recovery_used, before.goal.fresh_context_recovery_used)
    assert.equal(w.agent.providerBudgetGeneration, 1)
    assert.ok(w.events.find(row => row.event === 'executor.planner_review_requested').data.request_id)
    assert.equal(w.events.filter(row => row.event === 'plan.replacement_wake').length, 0)
  })
}

test('a stale executor review cannot pause or change a current step', async () => {
  const w = world([draft(), () => ({ stepId: 'obsolete-step', operations: [], plannerReview: { reason: 'scope_change', rationale: 'Wrong step.' } }), action])
  await w.say()
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
  assert.ok(w.events.some(row => row.event === 'executor.stale_step_rejected'))
})

test('a planner consulted during a healthy committed slice returns the immutable brief to execution', async () => {
  const w = world([draft(), action, draft({ plan: ['A tempting different strategy'], executionGuidance: [brief()] }), action])
  await w.say()
  const original = structuredClone(w.plan().steps)
  const returned = await w.agent.returnControlToPlanner({ route: 'user_amendment', reason: 'user_amendment', withinTurn: false })
  assert.equal(returned.returned, true)
  w.game.taskState = 'idle'
  w.game.queueLength = 0
  await w.agent.continueFromModMessage('[HARNESS] Review the current committed approach.', 'amend_current')
  assert.deepEqual(w.plan().steps, original)
  assert.deepEqual(w.calls.map(call => call.context.role), ['planner', 'executor', 'planner', 'executor'])
  assert.ok(w.events.some(row => row.event === 'planner.committed_slice_returned' && row.data.request_id))
})

test('a stale actor reply cannot request review or send a first action', async () => {
  const w = world([draft(), ({ game, memory }) => {
    game.status.epoch += 1
    return { stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [],
      plannerReview: { reason: 'approach_infeasible', rationale: 'This reply belongs to the old actor epoch.' } }
  }])
  await assert.rejects(w.say(), /epoch|superseded|cancelled/i)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
})

test('briefs are bounded and sanitize historical exact entity identifiers', () => {
  const normalized = normalizeExecutionGuidance([{ ...brief(), approach: 'Use unit_number=1234 after observing it.' }], 1)
  assert.doesNotMatch(normalized[0].approach, /1234/)
  assert.throws(() => normalizeExecutionGuidance([], 1))
  assert.throws(() => normalizeExecutionGuidance([{ ...brief(), approach: 'x'.repeat(201) }], 1))
  assert.throws(() => normalizePlannerReview({ reason: 'replace_plan', rationale: 'Ignore authority.' }))
})

test('protocol 3 schemas keep strategy fields with the planner and gameplay operations with the executor', () => {
  const planner = planningOnlyControlToolDefinitions[0].function.parameters.properties
  const executor = executionOnlyControlToolDefinitions[0].function.parameters.properties
  assert.equal(planner.operations.maxItems, 0)
  assert.ok(planner.executionGuidance)
  assert.equal(executor.executionGuidance, undefined)
  assert.equal(executor.plan, undefined)
  assert.equal(executor.goal, undefined)
  assert.equal(executor.operations.maxItems, 16)
  assert.ok(executor.plannerReview)
})

test('provider sends planning-only contract on ordinary, closed and compact protocol 3 rounds', async () => {
  const config = { base: 'https://fixture.example.test/v1', key: 'fixture-key', model: 'fixture', profile: 'local' }
  for (const allowTools of [true, false]) {
    for (const compact of [true, false]) {
      let sent
      await providerRequest(config, [{ role: 'system', content: 'Fixture system' }, { role: 'user', content: compact
        ? '[MOD] Autorio operation batch completed.' : '[CHAT] Louis: gather copper' }], {
        role: 'planner', completionProtocolVersion: 3, allowTools, promptTraceFile: null,
        fetchImpl: async (_url, options) => {
          sent = JSON.parse(options.body)
          return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }))
        },
      })
      assert.match(sent.messages.filter(row => row.role === 'system').map(row => row.content).join('\n'), /ROLE: PLANNER/)
      if (sent.tools) assert.equal(sent.tools.find(tool => tool.function.name === 'submitPlan').function.parameters.properties.operations.maxItems, 0)
      else assert.equal(allowTools, false, 'a profile may omit tools only on the closed round')
    }
  }
})

test('a deterministic step close refreshes both the focused brief and the selected skill details', async () => {
  const w = world([({ agent }) => {
    agent.loadedSkillContext.set('copper', { id: 'copper', marker: 'COPPER-STRATEGY' })
    agent.loadedSkillContext.set('iron', { id: 'iron', marker: 'IRON-STRATEGY' })
    return draft({ plan: ['Gather ten copper ore', 'Gather ten iron ore'],
      goal: { scope: 'finite', summary: 'Gather copper and iron.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 10) }, { kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-ore', 10) }],
      executionGuidance: [brief(['copper']), { ...brief(['iron']), approach: 'Gather iron for the next build.' }],
    })
  }, action, ({ agent, memory, messages }) => {
    const held = getActivePlan(memory.planningState(KEY))
    assert.equal(held.active_step_index, 1)
    assert.equal(agent.controlDecisionState(true).executionGuidance.approach, 'Gather iron for the next build.')
    const skills = messages.find(row => String(row.content).startsWith('[SKILL_CONTEXT]')).content
    assert.match(skills, /IRON-STRATEGY/)
    assert.doesNotMatch(skills, /COPPER-STRATEGY/)
    return { stepId: held.steps[1].step_id, operations: [gather('iron-ore', 10)] }
  }])
  await w.say()
  w.game.inventory['copper-ore'] = 10
  await w.agent.completed()
  assert.equal(w.calls.length, 3)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 1)
})
