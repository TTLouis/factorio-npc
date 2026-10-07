import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { PLAN_STATUS } from './planning-state.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { executorFactsRefreshMessage, EXECUTOR_FACT_LIMITS } from './handoff-packet.mjs'

const KEY = 'npc:sgluna'
const capturedResearch = JSON.parse(readFileSync(new URL('./fixtures/luna-research-handoff-2026-10-06.json', import.meta.url), 'utf8'))
const copper = inventoryCheckpoint('copper-ore', 10)
const research = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'automation' }] }
const goal = { scope: 'finite', summary: 'Gather ten copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }

function draft(overrides = {}) {
  return { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)], goal,
    stepCompletions: [{ kind: 'deterministic', checkpoint: copper }], ...overrides }
}

function harness(provider, game = new FakeFactorio(), options = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const calls = []
  const agent = new NpcAgentLoop({
    rcon: game, memory, completionProtocolVersion: 2,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      assert.ok(calls.length < 9, 'bounded fixture provider calls')
      const reply = planReply(await provider(calls.length, memory))
      if (options.fixtureOutputTokens) Object.defineProperty(reply, '_sglunaProvider', {
        value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: {
          prompt_tokens: 100, completion_tokens: options.fixtureOutputTokens,
          total_tokens: 100 + options.fixtureOutputTokens,
        } },
      })
      return reply
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'Strict Luna controller fixture.', stateFile: null, traceFile: null, decisionTraceFile: null, npcId: 'sgluna',
    onActivity: (event, data) => events.push({ event, data }),
    ...options,
  })
  return { agent, memory, game, calls, events }
}

function researchWorld({ fail = false, changeActor = false } = {}) {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 8 } })
  for (const node of capturedResearch.researchPath.nodes) game.knownTechnologies.add(node.name)
  const original = game.command.bind(game)
  game.researchReads = []
  game.command = async command => {
    if (!command.includes('"research_path"')) return original(command)
    const target = /research_path",['"]([^'"]+)['"]/.exec(command)?.[1]
    game.researchReads.push(target)
    if (changeActor) { game.status.actor_id += 1; game.status.epoch += 1 }
    if (fail) return '{}'
    const node = capturedResearch.researchPath.nodes.find(entry => entry.name === target)
    return JSON.stringify({ ok: true, target, node_count: 1, nodes: [node] })
  }
  return game
}

test('the retained research blocker still pauses truthfully after the repaired handoff', async () => {
  const world = harness(call => call === 1 ? capturedResearch.planner : {
    plan: capturedResearch.planner.plan, currentStep: 0, operations: [], chatMessage: capturedResearch.blocker,
  }, researchWorld())
  await world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.memory.currentPlan(KEY).status, 'paused')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
})

test('a fresh executor receives current research triggers, relevant counts and a bounded new observation decision', async () => {
  const world = harness(call => {
    if (call === 1) {
      world.agent.observationBudgetOverride = 3
      world.agent.planningHorizonOverride = 'subgoal'
      world.agent.observationBudgetRemaining = 0
      world.agent.observationRelevanceOverride = ['research_state']
      world.agent.observationDecisionForced = true
      return capturedResearch.planner
    }
    const packet = world.calls[1].map(row => row.content ?? '').join('\n')
    assert.match(packet, /research_trigger.*copper-plate.*10/)
    assert.match(packet, /research_trigger.*iron-plate.*50/)
    assert.match(packet, /iron-plate=8/)
    assert.match(packet, /copper-plate=0/)
    assert.match(packet, /observation_budget_remaining=4/)
    assert.equal(world.agent.observationDecisionForced, false)
    assert.equal(world.agent.observationRelevanceOverride, null)
    assert.equal(world.agent.providerBudgetGeneration, 1)
    assert.equal(world.agent.providerBudgetGenerationOutputUnits, 100)
    assert.equal(world.game.admissions.length, 0)
    return { plan: capturedResearch.planner.plan, currentStep: 0, operations: [gather('copper-ore', 10)] }
  }, researchWorld(), { fixtureOutputTokens: 100 })
  await world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' })
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.agent.providerBudgetGenerationOutputUnits, 200)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  const facts = world.events.find(row => row.event === 'context.executor_facts_carried')
  assert.equal(facts.data.research_paths, 2)
  assert.deepEqual(facts.data.missing_research, [])
  const decision = world.events.find(row => row.event === 'context.executor_observation_started')
  assert.ok(decision.data.request_id)
  assert.equal(decision.data.previous_remaining, 0)
  assert.equal(decision.data.reason, 'new_executor_decision_at_commit')
})

test('failed mandatory research reads remain explicit and cannot manufacture research completion', async () => {
  const world = harness(call => {
    if (call === 1) return capturedResearch.planner
    assert.match(world.calls[1].map(row => row.content ?? '').join('\n'), /"state":"unavailable"/)
    return { plan: capturedResearch.planner.plan, currentStep: 0, operations: [], chatMessage: capturedResearch.blocker }
  }, researchWorld({ fail: true }))
  await world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' })
  const facts = world.events.find(row => row.event === 'context.executor_facts_carried')
  assert.equal(facts.data.research_paths, 0)
  assert.deepEqual(facts.data.missing_research, ['electronics', 'steam-power'])
  assert.equal(world.game.researchReads.length, 2)
  assert.equal(world.game.admissions.length, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
})

test('an actor change during research handoff refuses all executor admissions', async () => {
  const world = harness(() => capturedResearch.planner, researchWorld({ changeActor: true }))
  await assert.rejects(world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' }), /actor|epoch changed|superseded/i)
  assert.equal(world.calls.length, 1)
  assert.equal(world.game.admissions.length, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.ok(world.events.some(row => row.event === 'context.restage_refused' && /actor/.test(row.data.reason)))
})

test('restored committed research subjects rebuild facts without conversation caches', async () => {
  const world = harness(call => call === 1 ? capturedResearch.planner : {
    plan: capturedResearch.planner.plan, currentStep: 0, operations: [], chatMessage: capturedResearch.blocker,
  }, researchWorld())
  await world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' })
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(world.memory.snapshot())
  const restarted = new NpcAgentLoop({ rcon: world.game, memory: restored, provider: async () => assert.fail('restored fact gathering must not wake a model'), stateFile: null, traceFile: null, decisionTraceFile: null, npcId: 'sgluna' })
  restarted.epoch = world.agent.epoch
  const state = restored.planningState(KEY)
  const result = await restarted.gatherExecutorHandoffFacts({ state, actor: restarted.epoch })
  assert.equal(result.facts.research.filter(path => path.state === 'fresh').length, 2)
  assert.equal(restarted.handoffRecipeFacts.size, 0)
  assert.equal(world.game.researchReads.length, 4)
  assert.equal(restored.planningState(KEY).active_plan_id, world.memory.planningState(KEY).active_plan_id)
  assert.equal(restored.currentPlan(KEY).task_board.completed_count, 0)
})

test('research reads defer behind in-flight work, refresh after settlement, and obey subject scan limits', async () => {
  const world = harness(call => call === 1 ? capturedResearch.planner : {
    plan: capturedResearch.planner.plan, currentStep: 0, operations: [], chatMessage: capturedResearch.blocker,
  }, researchWorld())
  await world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' })
  const state = world.memory.planningState(KEY)
  const before = world.game.researchReads.length
  const deferred = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, runtime: { idle: false } })
  assert.equal(world.game.researchReads.length, before)
  assert.equal(deferred.facts.counts.deferred, 'batch_in_flight')
  assert.ok(deferred.facts.research.every(path => path.state === 'deferred'))
  const refreshed = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, mode: 'refresh' })
  assert.match(executorFactsRefreshMessage(refreshed.facts), /research_trigger.*copper-plate/)
  assert.equal(world.game.researchReads.length, before + 2)
  const oversized = structuredClone(state)
  const plan = oversized.plans.find(plan => plan.plan_id === oversized.active_plan_id)
  plan.steps[0].completion_contract.requirements = ['electronics', 'steam-power', 'automation-science-pack', 'logistic-science-pack', 'automation']
    .map(technology => ({ kind: 'research_completed', technology }))
  const limitBefore = world.game.researchReads.length
  const limited = await world.agent.gatherExecutorHandoffFacts({ state: oversized, actor: world.agent.epoch })
  assert.equal(world.game.researchReads.length - limitBefore, EXECUTOR_FACT_LIMITS.researchTargets)
  assert.equal(limited.facts.research.at(-1).reason, 'research_target_limit')
  assert.ok(limited.facts.counts.items.length <= 12)
})

test('a superseded C3 handoff cannot replenish a newer lineage observation allowance', async () => {
  const world = harness(() => capturedResearch.planner, researchWorld())
  const original = world.agent.jev.afterRestage.bind(world.agent.jev)
  world.agent.jev.afterRestage = async (prepared, result) => {
    await original(prepared, result)
    if (result.restaged) {
      world.agent.reset()
      world.agent.observationBudgetOverride = 1
      world.agent.observationBudgetRemaining = 1
      world.agent.observationRelevanceOverride = ['inventory']
      world.agent.observationDecisionForced = true
    }
  }
  await assert.rejects(world.agent.request(capturedResearch.planner.goal.summary, { sender: 'Louis' }), /superseded|no longer active|actor|epoch/i)
  assert.equal(world.agent.observationBudgetRemaining, 1)
  assert.equal(world.agent.observationBudgetOverride, 1)
  assert.deepEqual(world.agent.observationRelevanceOverride, ['inventory'])
  assert.equal(world.agent.observationDecisionForced, true)
  assert.equal(world.game.admissions.length, 0)
  assert.equal(world.events.filter(row => row.event === 'context.executor_observation_started').length, 0)
})

test('protocol 2 corrects missing or misaligned draft declarations before admitting any gameplay batch', async () => {
  for (const stepCompletions of [undefined, []]) {
    const world = harness(call => draft(call === 1 ? { stepCompletions } : {}))
    await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
    assert.equal(world.calls.length, 2)
    assert.equal(world.game.mutations.length, 1)
    assert.match(world.calls[1].map(message => message.content ?? '').join('\n'), /stepCompletions/)
    assert.equal(world.memory.currentPlan(KEY).status, 'active')
  }
})

test('semantic assessments cannot admit world mutations, and a corrected deterministic draft can', async () => {
  const world = harness(call => draft(call === 1 ? { stepCompletions: [{ kind: 'semantic', rationale: 'Assess the copper patch.' }] } : {}))
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 1)
  assert.match(world.calls[1].map(message => message.content ?? '').join('\n'), /semantic_step_cannot_mutate|permit observations only/)
})

test('an initial observation-only draft commits without gameplay and requires grounded completion', async () => {
  const steps = ['Assess the copper patch', 'Gather ten copper ore']
  let committedStepId
  const world = harness((call, memory) => {
    if (call === 1) return draft({ plan: steps, operations: [], stepCompletions: [
      { kind: 'semantic', rationale: 'Assess the available copper patch from observations.' },
      { kind: 'deterministic', checkpoint: copper },
    ] })
    const planning = memory.planningState(KEY)
    const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
    committedStepId = held.steps[held.active_step_index].step_id
    assert.equal(held.status, PLAN_STATUS.COMMITTED)
    assert.equal(world.game.mutations.length, 0)
    return { plan: steps, currentStep: 0, operations: [], chatMessage: 'BLOCKED: A fresh patch observation is still needed.' }
  })
  await world.agent.request('Assess the copper patch and gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2, JSON.stringify({ state: world.memory.planningState(KEY), events: world.events.map(row => row.event) }))
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_assessment_committed').length, 1)
  assert.match(world.calls[1].map(message => message.content ?? '').join('\n'), new RegExp(committedStepId))
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.events.filter(row => row.event === 'recovery.action_omission_failed').length, 0)
})

test('an active legacy checkpoint conflicting with the declared outcome is corrected before admission', async () => {
  const world = harness(call => draft(call === 1 ? { checkpoint: inventoryCheckpoint('copper-ore', 11) } : {}))
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 1)
  assert.match(world.calls[1].map(message => message.content ?? '').join('\n'), /checkpoint disagrees with stepCompletions/)
})

test('a completed gathering batch closes its inventory predicate while unmet research stays active', async () => {
  const steps = ['Gather ten copper ore', 'Research automation']
  const world = harness(call => call === 1
    ? draft({ plan: steps, goal: { scope: 'finite', summary: 'Gather copper and research automation.', doneWhen: [{ kind: 'research_completed', technology: 'automation' }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: copper }, { kind: 'deterministic', checkpoint: research }] })
    : { plan: steps, currentStep: 1, operations: [{ name: 'research_technology', args: { technology_name: 'automation' } }] })
  await world.agent.request('Gather ten copper ore and research automation.', { sender: 'Louis' })
  world.game.inventory['copper-ore'] = 10
  await world.agent.completed()
  const state = world.memory.currentPlan(KEY)
  assert.equal(state.task_board.completed_count, 1)
  assert.equal(state.task_board.active_index, 1)
  assert.equal(state.status, 'active')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.game.researched.has('automation'), false)
  assert.equal(world.game.mutations.length, 2)
})

test('research checkpoint completion requires authoritative researched state, not request admission', async () => {
  const world = harness(() => draft())
  assert.equal((await world.agent.evaluateWorldStateCheckpoint({ contract: research })).satisfied, false)
  world.game.researched.add('automation')
  assert.equal((await world.agent.evaluateWorldStateCheckpoint({ contract: research })).satisfied, true)
  world.game.researched.delete('automation')
  assert.equal((await world.agent.evaluateWorldStateCheckpoint({ contract: research })).satisfied, false)
})

test('idle settlement closes an already satisfied committed inventory checkpoint without another provider call', async () => {
  const world = harness(() => draft())
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.deepEqual(await world.agent.settleIdleStepCheckpoint(), { closed: false, reason: 'operation_batch_in_flight' }, 'unsettled admission cannot close')
  world.game.inventory['copper-ore'] = 10
  await world.agent.taskStatusReceipt()
  const before = world.calls.length
  const result = await world.agent.settleIdleStepCheckpoint()
  assert.equal(result.closed, true)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1)
  assert.equal(world.calls.length, before)
  assert.equal(world.game.mutations.length, 1)
})

test('idle settlement refuses an actor epoch change during its live predicate read', async () => {
  const world = harness(() => draft())
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  world.game.inventory['copper-ore'] = 10
  await world.agent.taskStatusReceipt()
  const command = world.game.command.bind(world.game)
  world.game.command = async text => {
    const result = await command(text)
    if (text.includes('evaluate_condition')) world.game.status.epoch += 1
    return result
  }
  await assert.rejects(world.agent.settleIdleStepCheckpoint(), /actor_changed|epoch changed/i)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.game.mutations.length, 1)
})

test('ordinary no-action repair gets at most one durable fresh-context recovery before truthful failure', async () => {
  const steps = ['Gather twenty copper ore']
  const world = harness(call => call === 1
    ? draft({ plan: steps, goal: { scope: 'finite', summary: 'Gather twenty copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 20 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-ore', 20) }] })
    : { plan: steps, currentStep: 0, operations: [], chatMessage: 'Unable to choose the next action.' })
  await world.agent.request('Gather twenty copper ore.', { sender: 'Louis' })
  world.game.inventory['copper-ore'] = 10
  await assert.rejects(world.agent.completed(), /provider_action_omission_repair_failed/)
  assert.equal(world.events.filter(row => row.event === 'recovery.fresh_context_started').length, 1)
  assert.equal(world.memory.planningState(KEY).goal.fresh_context_recovery_used, true)
  assert.equal(world.memory.claimFreshContextRecovery(KEY, { requestId: 'a_later_request' }), false)
  const before = world.calls.length
  assert.deepEqual(await world.agent.tryFreshContextActionRecovery(), { attempted: false })
  assert.equal(world.calls.length, before)
  assert.equal(world.game.mutations.length, 1)
  assert.notEqual(world.memory.currentPlan(KEY).status, 'completed')
})

test('strict executor index ownership distinguishes repeated descriptions from an exact active suffix', async () => {
  const world = harness(() => draft({ plan: ['Gather copper', 'Gather copper'], stepCompletions: [
    { kind: 'deterministic', checkpoint: copper }, { kind: 'deterministic', checkpoint: copper },
  ] }))
  await world.agent.request('Gather copper in two measured stages.', { sender: 'Louis' })
  const planning = world.memory.planningState(KEY)
  const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
  // Model a later admitted step whose prose happens to match the completed step.
  held.active_step_index = 1
  const operations = [gather('copper-ore', 10)]
  await assert.rejects(world.agent.enforceExecutorContract({ plan: ['Gather copper', 'Gather copper'], currentStep: 0, operations }),
    error => error.code === 'executor_stale_step')
  await world.agent.enforceExecutorContract({ plan: ['Gather copper'], currentStep: 0, operations })
  await assert.rejects(world.agent.enforceExecutorContract({ plan: [], currentStep: 0, operations }),
    error => error.code === 'executor_stale_step')
  assert.equal(world.game.mutations.length, 1, 'neither ownership check executes gameplay')
})

test('a declared plan with no first batch delegates to a fresh executor without progress or admission', async () => {
  let planId
  let goalId
  const world = harness((call, memory) => {
    if (call === 1) {
      assert.match(world.calls[0][0].content, /PLANNER DELEGATION/)
      return draft({ operations: [] })
    }
    const planning = memory.planningState(KEY)
    const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
    planId = held.plan_id
    goalId = planning.goal.goal_id
    assert.equal(held.status, PLAN_STATUS.COMMITTED)
    assert.equal(held.runtime_validation.scope, 'completion_contracts')
    assert.equal(held.active_step_index, 0)
    assert.equal(memory.currentPlan(KEY).task_board.completed_count, 0)
    assert.equal(world.game.mutations.length, 0)
    assert.equal(world.game.admissions.length, 0)
    assert.equal(world.agent.agentContext.role, 'executor')
    assert.equal(world.agent.agentContext.hasParkedPlanner, true)
    assert.equal(world.agent.providerBudgetGeneration, 1)
    assert.equal(world.agent.providerBudgetGenerationOutputUnits, 100)
    assert.match(world.calls[1][0].content, /ROLE: EXECUTOR/)
    assert.match(world.calls[1].map(row => row.content ?? '').join('\n'), new RegExp(planId))
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(memory.snapshot())
    const retained = restored.planningState(KEY)
    assert.equal(retained.active_plan_id, planId)
    assert.equal(retained.goal.goal_id, goalId)
    assert.equal(retained.plans.find(plan => plan.plan_id === planId).active_step_index, 0)
    assert.deepEqual(retained.plans.find(plan => plan.plan_id === planId).steps, held.steps)
    return { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)] }
  }, new FakeFactorio(), { fixtureOutputTokens: 100 })
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.memory.planningState(KEY).active_plan_id, planId)
  assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  const trace = world.events.filter(row => row.event === 'plan.delegation_committed')
  assert.equal(trace.length, 1)
  assert.equal(trace[0].data.reason, 'validated_plan_without_initial_batch')
  assert.ok(trace[0].data.request_id)
  assert.equal(world.agent.providerBudgetGeneration, 1)
  assert.equal(world.agent.providerBudgetGenerationOutputUnits, 200)
})

test('planner-only receipt contracts defer action selection but never manufacture a receipt', async () => {
  const receipt = { mode: 'all', requirements: [{ id: 'mined', kind: 'authoritative_operation_receipt', operation_name: 'gather_resource' }] }
  const world = harness(call => call === 1
    ? draft({ operations: [], checkpoint: receipt, stepCompletions: [{ kind: 'deterministic', checkpoint: receipt }] })
    : { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)] })
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 1)
})

test('missing declarations are corrected before a planner-only commitment', async () => {
  const world = harness(call => call === 1 ? draft({ operations: [], stepCompletions: undefined })
    : call === 2 ? draft({ operations: [] })
    : { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)] })
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 3)
  assert.match(world.calls[1].map(row => row.content ?? '').join('\n'), /missing_step_completions/)
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 1)
  assert.equal(world.game.mutations.length, 1)
})

test('a planner-only commitment does not bypass the executor operation preflight', async () => {
  const game = new FakeFactorio({ preflight: () => ({ ok: false, code: 'fixture_refusal', reason: 'No accessible patch.' }) })
  const world = harness(call => call === 1 ? draft({ operations: [] })
    : call === 2 ? { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)] }
    : { plan: ['Gather ten copper ore'], currentStep: 0, operations: [], chatMessage: 'BLOCKED: No accessible patch.' }, game)
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(game.mutations.length, 0)
  assert.equal(game.admissions.length, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.notEqual(world.memory.planningState(KEY).goal.status, 'completed')
  assert.ok(world.events.some(row => row.event.includes('preflight')))
})

test('disabled executor handoff keeps the existing bounded initial action repair', async () => {
  const world = harness(call => draft(call === 1 ? { operations: [] } : {}), new FakeFactorio(), { executorHandoff: false })
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.agent.agentContext.role, 'planner')
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 0)
})

test('failed initial delegation pauses with the committed unfinished goal retained', async () => {
  const world = harness(() => draft({ operations: [] }))
  world.agent.startExecutorAtCommit = async () => ({ restaged: false, reason: 'fixture_handoff_unavailable' })
  const result = await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(world.calls.length, 1)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.currentPlan(KEY).status, 'paused')
  assert.notEqual(world.memory.planningState(KEY).goal.status, 'completed')
  assert.ok(world.memory.planningState(KEY).active_plan_id)
  assert.match(result.chatMessage, /executor handoff failed/)
  const trace = world.events.filter(row => row.event === 'plan.delegation_handoff_failed')
  assert.equal(trace.length, 1)
  assert.equal(trace[0].data.reason, 'executor_handoff_failed:fixture_handoff_unavailable')
  assert.ok(trace[0].data.request_id)
})

test('an actor change after initial delegation refuses executor admission without goal completion', async () => {
  const world = harness(call => {
    if (call === 1) return draft({ operations: [] })
    world.game.status.actor_id += 1
    world.game.status.epoch += 1
    return { plan: ['Gather ten copper ore'], currentStep: 0, operations: [gather('copper-ore', 10)] }
  })
  await assert.rejects(world.agent.request('Gather ten copper ore.', { sender: 'Louis' }), /epoch changed|actor|superseded/i)
  assert.equal(world.calls.length, 2)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.notEqual(world.memory.planningState(KEY).goal.status, 'completed')
})
