import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { executorFactsRefreshMessage, EXECUTOR_FACT_LIMITS } from './handoff-packet.mjs'

const KEY = 'npc:sgluna'
const capturedResearch = JSON.parse(readFileSync(new URL('./fixtures/luna-research-handoff-2026-10-06.json', import.meta.url), 'utf8'))
const capturedSemantic = JSON.parse(readFileSync(new URL('./fixtures/luna-semantic-contract-2026-10-07.json', import.meta.url), 'utf8'))
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
    provider: answersStepContract(async (messages) => {
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
    }),
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
  // A semantic declaration with operations in an execution draft is refused as a semantic step in an execution plan.
  assert.match(world.calls[1].map(message => message.content ?? '').join('\n'), /semantic_step_in_execution_plan/)
  const refused = world.events.filter(row => row.event === 'plan.semantic_step_refused')
  assert.equal(refused.length, 1)
  assert.deepEqual(refused[0].data.semantic_step_indexes, [0])
})

test('an initial observation-only draft commits without gameplay and requires grounded completion', async () => {
  // Observation-only drafts are all-semantic with assessmentOnly:true; a semantic step beside a deterministic one is
  // refused in a new execution draft (see the semantic_step_in_execution_plan tests below).
  const steps = ['Assess the copper patch', 'Confirm the patch can supply ten copper ore']
  let committedStepId
  const world = harness((call, memory) => {
    if (call === 1) return draft({ plan: steps, operations: [], assessmentOnly: true, stepCompletions: [
      { kind: 'semantic', rationale: 'Assess the available copper patch from observations.' },
      { kind: 'semantic', rationale: 'Confirm the patch size from observations.' },
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

// Haiku live run C (docs/validation/LUNA_HAIKU_LIVE_2026-10-08C.md): the planner committed a semantic "smelt" step between two
// deterministic ones; the executor could not act on it and the goal paused. Execution slices now declare only
// deterministic checkpoints, so that draft is refused before anything is committed or admitted.
const runCSteps = ['Mine 100 iron ore', 'Smelt the mined iron ore and the held copper ore into plates for 75 automation-science-packs', 'Craft 75 automation-science-packs']
const runCGoal = { scope: 'finite', summary: 'Craft 75 automation science packs.', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 75 }] }
const ironOre100 = inventoryCheckpoint('iron-ore', 100)
const packs75 = inventoryCheckpoint('automation-science-pack', 75)

test('a mixed deterministic and semantic execution draft is refused with semantic_step_in_execution_plan and an all-deterministic redraft commits', async () => {
  const mixed = draft({ plan: runCSteps, goal: runCGoal, operations: [gather('iron-ore', 100)], stepCompletions: [
    { kind: 'deterministic', checkpoint: ironOre100 },
    { kind: 'semantic', rationale: 'Smelting is judged from the held plates once the ore is mined.' },
    { kind: 'deterministic', checkpoint: packs75 },
  ] })
  const corrected = draft({ plan: runCSteps, goal: runCGoal, operations: [gather('iron-ore', 100)], stepCompletions: [
    { kind: 'deterministic', checkpoint: ironOre100 },
    { kind: 'deterministic', checkpoint: inventoryCheckpoint('iron-plate', 100) },
    { kind: 'deterministic', checkpoint: packs75 },
  ] })
  const world = harness(call => {
    if (call === 1) return mixed
    // The refusal commits nothing and admits nothing.
    assert.equal(world.game.admissions.length, 0)
    assert.equal(world.game.mutations.length, 0)
    assert.ok(!world.memory.planningState(KEY)?.plans?.some(plan => plan.status === PLAN_STATUS.COMMITTED))
    return corrected
  })
  await world.agent.request('Craft 75 automation science packs.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  // The refusal reaches the planner as the repair message, with the facts and nothing more.
  const repair = world.calls[1].map(message => message.content ?? '').join('\n')
  assert.match(repair, /semantic_step_in_execution_plan: execution plans declare only deterministic checkpoints, one per step, naming the step's world result\. Semantic declarations are accepted only with assessmentOnly:true \(no operations\)\. No contract has been committed\./)
  const refused = world.events.filter(row => row.event === 'plan.semantic_step_refused')
  assert.equal(refused.length, 1)
  assert.ok(refused[0].data.request_id)
  assert.equal(refused[0].data.reason, 'execution_plan_declares_only_deterministic_checkpoints')
  assert.equal(refused[0].data.step_count, 3)
  assert.deepEqual(refused[0].data.semantic_step_indexes, [1])
  assert.deepEqual(refused[0].data.semantic_step_descriptions, [runCSteps[1]])
  assert.equal(world.events.filter(row => row.event === 'plan.completion_declarations_rejected').length, 0)
  // The corrected draft commits with every step deterministic and admits its batch.
  assert.equal(world.game.mutations.length, 1)
  const planning = world.memory.planningState(KEY)
  const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
  assert.equal(held.status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(held.steps.map(step => step.completion_mode), ['deterministic', 'deterministic', 'deterministic'])
  assert.equal(world.memory.currentPlan(KEY).status, 'active')
})

test('assessmentOnly keeps its all-semantic no-operation slice, still refuses operations, and an unmarked all-semantic draft keeps its own code', async () => {
  const steps = ['Assess the copper patch']
  const semantic = [{ kind: 'semantic', rationale: 'Assess the available copper patch from observations.' }]
  const assessed = harness((call, memory) => call === 1
    ? draft({ plan: steps, operations: [], assessmentOnly: true, stepCompletions: semantic })
    : { plan: steps, currentStep: 0, operations: [], chatMessage: 'BLOCKED: A fresh patch observation is still needed.' })
  await assessed.agent.request('Assess the copper patch.', { sender: 'Louis' })
  assert.equal(assessed.events.filter(row => row.event === 'plan.semantic_assessment_committed').length, 1)
  assert.equal(assessed.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
  assert.equal(assessed.game.mutations.length, 0)

  const withOperations = harness(call => call === 1 ? draft({ plan: steps, assessmentOnly: true, stepCompletions: semantic }) : draft())
  await withOperations.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(withOperations.events.find(row => row.event === 'plan.completion_declarations_rejected').data.reason, 'assessment_only_conflicts_with_execution')
  assert.equal(withOperations.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
  assert.equal(withOperations.game.mutations.length, 1)

  const unmarked = harness(call => call === 1 ? draft({ plan: steps, operations: [], stepCompletions: semantic }) : draft())
  await unmarked.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  assert.equal(unmarked.events.find(row => row.event === 'plan.completion_declarations_rejected').data.reason, 'execution_plan_has_no_world_checkpoint')
  assert.equal(unmarked.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
})

test('a committed plan that already carries a semantic step still accepts a grounded executor semanticCompletion close', async () => {
  const steps = ['Assess the copper patch', 'Gather ten copper ore']
  const stepCompletions = [
    { kind: 'semantic', rationale: 'Assess the available copper patch from observations.' },
    { kind: 'deterministic', checkpoint: copper },
  ]
  const world = harness(() => draft())
  // A saved game: the plan was committed before the rule existed, so it is frozen with a semantic first step.
  const proposal = { chatMessage: '', plan: steps, currentStep: 0, operations: [], stepCompletions }
  const recorded = world.memory.recordPlan(KEY, { sender: 'Louis', text: 'Assess the copper patch and gather ten copper ore.', turnId: 1 }, proposal, { validatedSemanticAdmission: true })
  world.memory.reconcileTaskBoard(KEY, recorded.state.task_board, proposal, recorded)
  world.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const planning = world.memory.planningState(KEY)
  const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
  assert.equal(held.status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(held.steps.map(step => step.completion_mode), ['semantic', 'deterministic'])
  world.agent.requestInfo = { memoryKey: KEY }
  world.agent.freshObservationSinceContinuation = true
  const stepId = world.memory.currentPlan(KEY).task_board.active_step_id
  const close = { chatMessage: '', plan: steps, currentStep: 0, operations: [], stepCompletions,
    semanticCompletion: { stepId, rationale: 'The fresh patch observation shows enough copper ore.' } }
  await world.agent.validateStepCompletionDeclarations(close) // the frozen branch: no semantic_step_in_execution_plan
  const closed = await world.agent.applySemanticCompletionClaim(close, world.memory.currentPlan(KEY))
  assert.equal(closed.applied, true)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1)
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
  // The frozen rule is unchanged: a world-changing batch on the semantic step is still refused as before.
  const mutatingWorld = harness(() => draft())
  mutatingWorld.memory.restore(capturedSemantic.committedMemory)
  mutatingWorld.agent.requestInfo = { memoryKey: capturedSemantic.committedMemory.planning_states[0].key }
  await assert.rejects(mutatingWorld.agent.validateStepCompletionDeclarations(capturedSemantic.executor), /observations only/)
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

test('the retained assessment-only execution draft is refused before commitment without manufacturing contracts', async () => {
  const world = harness(() => capturedSemantic.planner, researchWorld())
  await world.agent.request(capturedSemantic.planner.goal.summary, { sender: 'Louis' })
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.game.admissions.length, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_assessment_committed').length, 0)
  const rejected = world.events.filter(row => row.event === 'plan.completion_declarations_rejected')
  assert.ok(rejected.length > 0)
  assert.ok(rejected.every(row => row.data.request_id && row.data.reason === 'execution_plan_has_no_world_checkpoint'))
  // An all-semantic no-operation execution draft keeps its own, clearer code ahead of the semantic-step rule.
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
  assert.match(world.calls[1].map(row => row.content ?? '').join('\n'), /research_completed.*mode:"all"/)
  assert.ok(!world.memory.planningState(KEY)?.plans?.some(plan => plan.status === PLAN_STATUS.COMMITTED))
})

test('corrected scripted declarations commit future research outcomes and allow bounded copper gathering', async () => {
  const world = harness(call => {
    if (call === 1) return capturedSemantic.planner
    if (call === 2) {
      assert.equal(world.game.admissions.length, 0)
      return { ...capturedSemantic.planner, stepCompletions: capturedSemantic.executor.stepCompletions }
    }
    const planning = world.memory.planningState(KEY)
    const held = planning.plans.find(plan => plan.plan_id === planning.active_plan_id)
    assert.ok(held.steps.every(step => step.completion_mode === 'deterministic'))
    assert.equal(held.steps[0].completion_contract.requirements.length, 2)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
    return capturedSemantic.executor
  }, researchWorld())
  await world.agent.request(capturedSemantic.planner.goal.summary, { sender: 'Louis' })
  assert.equal(world.calls.length, 3)
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 1)
  assert.equal(world.game.mutations.length, 1)
  assert.match(world.game.mutations[0], /gather_resource/)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
})

test('an explicitly assessment-only slice stays with the planner and cannot admit a mutation', async () => {
  const world = harness(call => call === 1 ? draft({ plan: ['Assess available supplies'], operations: [],
    assessmentOnly: true, stepCompletions: [{ kind: 'semantic', rationale: 'Assess inventory from fresh observations.' }] })
    : { plan: ['Assess available supplies'], currentStep: 0, operations: [], chatMessage: 'BLOCKED: Supply assessment needs a fresh observation.' })
  await world.agent.request('Assess available supplies.', { sender: 'Louis' })
  assert.equal(world.calls.length, 2)
  assert.equal(world.agent.agentContext.role, 'planner')
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.delegation_committed').length, 0)
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_assessment_committed').length, 1)
})

test('the assessment-only marker cannot conceal deterministic work or gameplay operations', async () => {
  for (const first of [draft({ assessmentOnly: true, operations: [] }), draft({ assessmentOnly: true,
    stepCompletions: [{ kind: 'semantic', rationale: 'Assess inventory.' }] })]) {
    const world = harness(call => call === 1 ? first : draft())
    await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
    assert.equal(world.calls.length, 2)
    assert.equal(world.game.mutations.length, 1)
    const rejected = world.events.find(row => row.event === 'plan.completion_declarations_rejected')
    assert.equal(rejected.data.reason, 'assessment_only_conflicts_with_execution')
    assert.ok(rejected.data.request_id)
  }
})

test('restoring the recorded committed assessment never rewrites its contracts or accepts executor mutations', async () => {
  const world = harness(() => capturedSemantic.executor)
  world.memory.restore(capturedSemantic.committedMemory)
  const recordedKey = capturedSemantic.committedMemory.planning_states[0].key
  world.agent.requestInfo = { memoryKey: recordedKey }
  const before = structuredClone(world.memory.planningState(recordedKey))
  await assert.rejects(world.agent.validateStepCompletionDeclarations(capturedSemantic.executor), /observations only/)
  assert.deepEqual(world.memory.planningState(recordedKey), before)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.calls.length, 0)
})

test('assessment intent requires a boolean on the JSON control boundary', () => {
  const world = harness(() => draft())
  for (const assessmentOnly of ['true', 1, null, {}]) {
    assert.throws(() => world.agent.parsePlanMessage(planReply(draft({ assessmentOnly }))),
      error => error.code === 'invalid_assessment_only')
  }
  for (const assessmentOnly of [true, false]) {
    assert.equal(world.agent.parsePlanMessage(planReply(draft({ assessmentOnly }))).assessmentOnly, assessmentOnly)
  }
})

test('the planner system prompt says execution plans declare deterministic checkpoints and semantic declarations belong to assessmentOnly plans', async () => {
  const world = harness(() => draft())
  await world.agent.request('Gather ten copper ore.', { sender: 'Louis' })
  const system = world.calls[0].filter(message => message.role === 'system').map(message => message.content ?? '').join('\n')
  assert.match(system, /\{kind:"deterministic",checkpoint:\{mode:"all",requirements:\[\.\.\.\]\}\} for the step at currentStep of an execution plan and \{kind:"deterministic"\} with no checkpoint for each later step, whose checkpoint the harness asks you for when that step is about to start; \{kind:"semantic",rationale:"\.\.\."\} only in an assessmentOnly:true plan\. You choose the intended outcome/)
  assert.match(system, /Semantic declarations belong only to assessmentOnly:true plans; unknown current measurements are not a reason to downgrade an intended world result to an assessment\./)
  assert.doesNotMatch(system, /for world-changing steps or waits|for observation\/assessment only|Reserve semantic declarations/)
})

test('a committed [semantic, deterministic] plan closes the semantic step and admits the next step\'s operations; the same reply aimed at the semantic step is refused', async () => {
  const steps = ['Assess the copper patch', 'Gather ten copper ore']
  const stepCompletions = [
    { kind: 'semantic', rationale: 'Assess the available copper patch from observations.' },
    { kind: 'deterministic', checkpoint: copper },
  ]
  const world = harness(() => draft())
  const proposal = { chatMessage: '', plan: steps, currentStep: 0, operations: [], stepCompletions }
  const recorded = world.memory.recordPlan(KEY, { sender: 'Louis', text: 'Assess the copper patch and gather ten copper ore.', turnId: 1 }, proposal, { validatedSemanticAdmission: true })
  world.memory.reconcileTaskBoard(KEY, recorded.state.task_board, proposal, recorded)
  world.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  world.agent.requestInfo = { memoryKey: KEY }
  world.agent.freshObservationSinceContinuation = true
  // The declared-transition check compares the Plan Tracker step id; the claim check accepts it as well as the board id.
  const trackerPlan = getActivePlan(world.memory.planningState(KEY))
  const stepId = trackerPlan.steps[trackerPlan.active_step_index].step_id
  const reply = overrides => ({ chatMessage: '', plan: steps, currentStep: 1, operations: [gather('copper-ore', 10)], stepCompletions,
    semanticCompletion: { stepId, rationale: 'The fresh patch observation shows enough copper ore.' }, ...overrides })

  // Aimed at the semantic step itself, the same operations are refused and nothing changes.
  await assert.rejects(world.agent.validateStepCompletionDeclarations(reply({ currentStep: 0 })), error => error.code === 'semantic_step_cannot_mutate')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.game.mutations.length, 0)

  // The declared transition (claim on step 0, currentStep 1, operations for step 1) passes the frozen-branch check and closes step 0.
  await world.agent.validateStepCompletionDeclarations(reply())
  const closed = await world.agent.applySemanticCompletionClaim(reply(), world.memory.currentPlan(KEY))
  assert.equal(closed.applied, true)
  const board = world.memory.currentPlan(KEY).task_board
  assert.equal(board.completed_count, 1)
  assert.equal(board.steps[board.active_index].description, steps[1])
  // With the semantic step closed, the operations are no longer aimed at a semantic step, so the check passes on their own.
  await world.agent.validateStepCompletionDeclarations(reply({ semanticCompletion: undefined }))
  assert.equal(world.events.filter(row => row.event === 'plan.semantic_step_refused').length, 0)
})

test('the declared semantic-to-deterministic transition on a committed plan admits the next step\'s operations through commitPlan', async () => {
  const steps = ['Assess the copper patch', 'Gather ten copper ore']
  const stepCompletions = [
    { kind: 'semantic', rationale: 'Assess the available copper patch from observations.' },
    { kind: 'deterministic', checkpoint: copper },
  ]
  const world = harness(() => draft())
  const proposal = { chatMessage: '', plan: steps, currentStep: 0, operations: [], stepCompletions }
  const recorded = world.memory.recordPlan(KEY, { sender: 'Louis', text: 'Assess the copper patch and gather ten copper ore.', turnId: 1 }, proposal, { validatedSemanticAdmission: true })
  world.memory.reconcileTaskBoard(KEY, recorded.state.task_board, proposal, recorded)
  world.memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  world.agent.requestInfo = { memoryKey: KEY, sender: 'Louis', text: 'Assess the copper patch and gather ten copper ore.', turnId: 1 }
  world.agent.epoch = await world.agent.captureEpoch()
  world.agent.active = true
  world.agent.freshObservationSinceContinuation = true
  const trackerPlan = getActivePlan(world.memory.planningState(KEY))
  const stepId = trackerPlan.steps[trackerPlan.active_step_index].step_id
  const reply = planReply({ plan: steps, currentStep: 1, operations: [gather('copper-ore', 10)], stepCompletions,
    semanticCompletion: { stepId, rationale: 'The fresh patch observation shows enough copper ore.' } })
  await world.agent.commitPlan(world.agent.parsePlanMessage(reply))
  assert.equal(world.game.mutations.length, 1)
  assert.match(world.game.mutations[0], /gather_resource/)
  const board = world.memory.currentPlan(KEY).task_board
  assert.equal(board.completed_count, 1)
  assert.equal(board.steps[board.active_index].description, steps[1])
})
