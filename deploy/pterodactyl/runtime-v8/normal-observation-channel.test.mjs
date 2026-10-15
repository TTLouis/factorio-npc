import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FurnaceFactorio, ScriptedModel, recoveryWorld, recoverySession, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { FakeFactorio, planReply, contractCheckedJev } from './task-loop-fixtures.mjs'

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/run-t-normal-observation.json', import.meta.url)))
const saved = JSON.parse(await fs.readFile(new URL('./fixtures/luna-furnace-state-2026-10-07.json', import.meta.url)))
const STEP = 'Craft a lab and unlock automation science packs'
const CHECKPOINT = { mode: 'all', requirements: [
  { kind: 'inventory_count', item_name: 'lab', minimum: 1 },
  { kind: 'research_completed', technology: 'automation-science-pack' },
] }
const tool = (name, args = {}) => ({ content: null, tool_calls: [{ id: `normal-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const submit = intent => ({ content: null, tool_calls: [{ id: 'control-submit', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(intent) } }] })

test('Run T capture proves an open research control consumed the closed allowance before a valid terminal omission', () => {
  assert.equal(captured.open_request.allow_tools, true)
  assert.equal(captured.open_request.request_id, 'recovery_mva43z4o')
  assert.equal(captured.response.tool_call_count, 1)
  assert.equal(captured.response.content_preview, '')
  const grant = captured.boundary_events.find(row => row.event === 'observation.targeted_granted')
  assert.equal(grant.data.tool, 'getResearchStatus')
  assert.equal(grant.data.observation_budget_remaining, 1)
  assert.ok(captured.boundary_events.some(row => row.event === 'provider.plan_submission' && row.data.source === 'submitPlan'))
  assert.ok(captured.boundary_events.some(row => row.event === 'provider.request' && row.data.allow_tools === false))
  assert.ok(captured.boundary_events.some(row => row.event === 'tool.result' && row.data.output.includes('"force_index":1')))
  assert.equal(JSON.parse(captured.terminal_reply).operations.length, 0)
  assert.match(JSON.parse(captured.terminal_reply).chatMessage, /^BLOCKED:/)
  assert.equal(captured.auto_resume.goal_total, 6)
  assert.equal(captured.exhausted[0].data.goal_limit, 6)
  assert.equal(captured.native_final.red_produced_count, 0)
})

// A declared post-bootstrap lab fixture, not a claim that the full factory is
// proven. World effects arise only from admitted operations and smelting time.
// The real-engine companion verifies native recursive crafting and research.
class LabGame extends FurnaceFactorio {
  constructor() {
    super({ connectedPlayers: 0, inventory: { 'iron-plate': 62, 'copper-plate': 10, 'iron-gear-wheel': 10 },
      furnace: { unit_number: 3, output: { 'iron-plate': 52 }, source: { 'copper-ore': 5 }, fuel: { coal: 7 } } })
    this.knownTechnologies.add('automation-science-pack')
    this.researched.add('electronics'); this.researched.add('steam-power')
    this.researchReads = 0
  }
  async command(text) {
    if (text.includes('"autorio_research","status"')) {
      this.researchReads++
      return JSON.stringify({ force: 'player', force_index: 1, research_enabled: true, queue: {}, queue_length: 0, recent_requests: {}, follow_through: {} })
    }
    const answer = await super.command(text)
    if (this.pendingBatch && text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      for (const operation of this.pendingBatch.operations) if (operation.name === 'craft_item') {
        const match = /^'([^']+)',(\d+)\)/.exec(operation.args.raw)
        assert.ok(match); operation.args = { item_name: match[1], count: Number(match[2]) }
      }
      this.lastTaskTypes = this.pendingBatch.operations.flatMap(operation => operation.name === 'craft_item' ? ['crafting'] : operation.name === 'wait' ? ['waiting'] : ['moving_items'])
    }
    return answer
  }
  smelt(count) {
    // Native furnace output slots cannot mix plate kinds, regardless of space.
    if ((this.furnace.output['iron-plate'] ?? 0) > 0 && (this.furnace.source['copper-ore'] ?? 0) > 0) return 0
    const done = super.smelt(count)
    this.produced['copper-plate'] = (this.produced['copper-plate'] ?? 0) + done
    return done
  }
  completeBatch() {
    const craft = this.pendingBatch.operations.find(operation => operation.name === 'craft_item')
    if (craft) {
      assert.deepEqual(craft.args, { item_name: 'lab', count: 1 })
      // Lab: ten circuits (15 Cu + 10 Fe), ten held gears, four belts
      // (two crafts, two additional gears = 4 Fe, and 2 Fe).
      assert.ok(this.inventory['iron-plate'] >= 16)
      assert.ok(this.inventory['copper-plate'] >= 15)
      assert.ok(this.inventory['iron-gear-wheel'] >= 10)
      this.inventory['iron-plate'] -= 16; this.inventory['copper-plate'] -= 15; this.inventory['iron-gear-wheel'] -= 10
      this.inventory.lab = (this.inventory.lab ?? 0) + 1
      this.researched.add('automation-science-pack')
      this.effects.push({ batch_id: this.pendingBatch.batch_id, operation: 'craft_item', item: 'lab', crafted: 1 })
    }
    return super.completeBatch()
  }
}

function fullFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new LabGame(), model = new ScriptedModel(), wire = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://proxy.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); wire.push({ body, context })
      const reply = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...reply } }], usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 } }), { status: 200 })
    } })
  const world = recoveryWorld({ game, model, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  const { session, logs } = recoverySession(world)
  const intent = (operations = []) => ({ chatMessage: '', stepId: world.agent.targetedObservationIdentity().data.stepId, operations })
  const read = (name, args = {}) => submit({ ...intent(), observationRequest: { stepId: intent().stepId, tool: name, args, rationale: 'Read the explicitly selected current prerequisite fact.' } })
  return { game, model, wire, world, session, logs, intent, read }
}

test('Run T full loop: open redundant research read stays cached; model clears iron, collects five smelted copper and crafts a lab on the same step', async t => {
  const ctx = fullFixture(t), { game, model, world, session } = ctx
  assert.equal(game.smelt(5), 0, 'mixed iron output really blocks the copper input')
  let before, resumeLedger, closedLedger
  model.push('planner', 'sol:lab-prerequisite', planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: CHECKPOINT,
    stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }],
    goal: { scope: 'finite', summary: STEP, doneWhen: CHECKPOINT.requirements } }))
    .push('executor', 'luna:ordinary-research', () => {
      before = structuredClone(getActivePlan(world.memory.planningState(KEY)))
      world.memory.planningState(KEY).run.auto_resume = { ...structuredClone(captured.auto_resume), goal_id: world.memory.planningState(KEY).goal.goal_id }
      resumeLedger = structuredClone(world.memory.planningState(KEY).run.auto_resume)
      closedLedger = [...(world.memory.targetedObservationLedger ?? new Map())]
      return tool('getResearchStatus')
    })
    .push('executor', 'luna:open-typed-research', (_messages, context) => {
      assert.equal(context.allowTools, true)
      assert.equal(world.agent.controlDecisionState(true).targetedReadEligible, false)
      assert.equal(game.researchReads, 1)
      return ctx.read('getResearchStatus')
    })
    .push('executor', 'luna:fresh-furnace', (_messages, context) => {
      assert.equal(context.allowTools, true, 'duplicate ordinary read does not prematurely close normal tools')
      assert.equal(game.researchReads, 1, 'normal cache survives the typed alias')
      assert.equal(world.agent.closedRoundObservationUsed, false)
      assert.deepEqual([...(world.memory.targetedObservationLedger ?? new Map())], closedLedger)
      return tool('getEntityStatus', { name: 'stone-furnace', radius: 20 })
    })
    .push('executor', 'luna:clear-iron-output', messages => {
      const fact = JSON.parse(messages.findLast(row => row.role === 'tool').content).entity
      assert.equal(fact.unit_number, 3)
      const output = fact.inventories.find(row => row.index === 3).items.find(row => row.name === 'iron-plate')
      assert.equal(output.count, 52)
      assert.equal(game.furnace.output['iron-plate'], 52)
      return submit(ctx.intent([{ name: 'move_items_exact', args: { item_name: output.name, unit_number: fact.unit_number, max_count: output.count, to_entity: false } }]))
    })
  assert.equal(session.queuePlayerRequest('TTLouis', STEP), true)
  await settle(session)
  assert.equal(game.sent.length, 1, JSON.stringify({ calls: model.labels, violations: model.violations, logs: ctx.logs, trace: world.trace.slice(-8) }))
  assert.ok(game.pendingBatch, JSON.stringify({ calls: model.labels, violations: model.violations, logs: ctx.logs, trace: world.trace.slice(-15) }))
  model.push('executor', 'luna:post-receipt-furnace', tool('getEntityStatus', { unit_number: 3 }))
    .push('executor', 'luna:collect-actual-copper', messages => {
      const fact = JSON.parse(messages.findLast(row => row.role === 'tool').content).entity
      const output = fact.inventories.find(row => row.index === 3).items.find(row => row.name === 'copper-plate')
      assert.equal(fact.unit_number, 3); assert.equal(output.count, 5)
      return submit(ctx.intent([{ name: 'move_items_exact', args: { item_name: output.name, unit_number: fact.unit_number, max_count: output.count, to_entity: false } }]))
    })
  await completeAndReport(ctx, { smelt: 5 })
  assert.equal(game.produced['copper-plate'], 5)
  assert.equal(game.inventory['copper-plate'], 10, 'collection is still queued')
  assert.ok(game.pendingBatch, JSON.stringify({ calls: model.labels, violations: model.violations, logs: ctx.logs, agentLogs: world.agentLogs, trace: world.trace.slice(-18) }))
  model.push('executor', 'luna:craft-lab', () => submit(ctx.intent([{ name: 'craft_item', args: { item_name: 'lab', count: 1 } }])))
  await completeAndReport(ctx)
  assert.equal(game.inventory['copper-plate'], 15)
  const after = getActivePlan(world.memory.planningState(KEY))
  assert.equal(after.plan_id, before.plan_id); assert.equal(after.plan_version, before.plan_version)
  assert.equal(after.steps[0].step_id, before.steps[0].step_id)
  assert.deepEqual(after.steps[0].completion_contract, before.steps[0].completion_contract)
  assert.deepEqual(world.memory.planningState(KEY).run.auto_resume, resumeLedger, 'no seventh resume or allowance reset')
  await completeAndReport(ctx)
  assert.equal(game.inventory.lab, 1); assert.equal(game.inventory['copper-plate'], undefined)
  assert.equal(game.researched.has('automation-science-pack'), true)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(world.named('observation.targeted_granted'), [])
  const [trace] = world.named('observation.normal_from_control')
  assert.ok(trace.request_id); assert.equal(trace.reason, 'normal_tools_available_use_existing_observation_budget')
  assert.equal(trace.tool, 'getResearchStatus')
  assert.equal(ctx.wire[0].body.model, 'gpt-6.1-sol')
  assert.ok(ctx.wire.slice(1).every(row => row.body.model === 'gpt-6-luna'))
  assert.deepEqual(model.violations, []); assert.deepEqual(model.remaining, [])
  assert.deepEqual(world.named('request.failed'), [])
  assert.equal(game.status.connected_players, 0)
  assert.equal(game.pendingBatch, null); assert.equal(game.queueLength, 0)
})

function focusedFixture() {
  const memory = new CanonicalTaskBoardMemory(); memory.restore(structuredClone(saved))
  const key = saved.planning_states[0].key, state = memory.currentPlan(key)
  state.status = 'active'; memory.recordRunResume(key, state, 'scripted_fixture_resume')
  const game = new FakeFactorio({ inventory: { 'iron-plate': 8 } })
  game.status.actor_id = 6; game.status.epoch = 1
  let reads = 0
  const original = game.command.bind(game)
  game.command = async text => {
    if (text.includes('"get_inventory_items"')) { reads++; await game.duringRead?.(); if (game.readError) throw new Error('declared fixture read failure') }
    return original(text)
  }
  const events = [], agent = new NpcAgentLoop({ rcon: game, memory, traceFile: null, decisionTraceFile: null,
    provider: async () => planReply({ plan: state.plan, currentStep: state.current_step, operations: [{ name: 'wait', args: { ticks: 1 } }] }),
    onActivity: (event, data) => events.push({ event, data }), completionProtocolVersion: 2, jevCheckpoints: false })
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: key }; agent.traceRequest = { id: 'req_normal_observation_fixture' }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.observationBudgetRemaining = 3; agent.observationDecisionForced = false
  const context = { generation: agent.generation, attribution: agent.turnConversation, current: game.status, round: 0, recoveryAttempt: 0, allowTools: true }
  const request = () => ({ content: JSON.stringify({ plan: state.plan, currentStep: state.current_step, operations: [], observationRequest: {
    stepId: agent.targetedObservationIdentity().data.stepId, tool: 'getInventoryItems', args: {}, rationale: 'Need exact held ingredients.' } }) })
  return { agent, memory, game, events, context, request, reads: () => reads }
}

async function ordinary(world, alias = true) {
  const message = alias ? await world.agent.handleObservationRequest(world.request(), world.context) : tool('getInventoryItems')
  assert.equal(message._sglunaObservationRefusal, undefined)
  await world.agent.handleToolBatch(message)
  return message
}

for (const mode of ['fresh', 'cached', 'excluded-family', 'exhausted-open-tier', 'forced-closed-budget']) test(`normal typed observation has ordinary tool budget/cache semantics: ${mode}`, async () => {
  const alias = focusedFixture(), direct = focusedFixture()
  for (const world of [alias, direct]) {
    if (mode === 'cached') await ordinary(world, false)
    if (mode === 'excluded-family') world.agent.observationRelevanceOverride = ['recipe_production']
    if (mode === 'exhausted-open-tier' || mode === 'forced-closed-budget') world.agent.observationBudgetRemaining = 0
    if (mode === 'forced-closed-budget') world.agent.observationDecisionForced = true
  }
  await ordinary(alias); await ordinary(direct, false)
  assert.equal(alias.reads(), direct.reads())
  assert.equal(alias.agent.observationBudgetRemaining, direct.agent.observationBudgetRemaining)
  assert.equal(alias.agent.observationDecisionForced, direct.agent.observationDecisionForced)
  assert.equal(alias.agent.toolCache.size, direct.agent.toolCache.size)
  assert.equal(alias.agent.closedRoundObservationUsed, false)
  assert.equal(alias.memory.targetedObservationLedger?.size ?? 0, 0)
  assert.equal(alias.game.mutations.length, 0)
  if (mode === 'forced-closed-budget') assert.equal(alias.reads(), 0)
})

test('consumed closed allowance does not deny an open normal fact or renew the closed allowance', async () => {
  const world = focusedFixture(), identity = world.agent.targetedObservationIdentity()
  world.agent.closedRoundObservationUsed = true
  world.memory.targetedObservationLedger = new Map([[identity.ledgerKey, identity.basis]])
  await ordinary(world)
  assert.equal(world.reads(), 1)
  assert.equal(world.agent.closedRoundObservationUsed, true)
  assert.equal(world.memory.targetedObservationLedger.get(identity.ledgerKey), identity.basis)
  const refused = await world.agent.handleObservationRequest(world.request(), { ...world.context, allowTools: false })
  assert.match(refused._sglunaObservationRefusal.reason, /already_used/)
  assert.equal(world.reads(), 1)
})

test('open alias in action omission recovery obeys its existing one-read bound', async () => {
  const world = focusedFixture()
  world.agent.actionOmissionRepairActive = true
  await ordinary(world)
  assert.equal(world.agent.actionOmissionObservationUsed, true)
  assert.equal(world.agent.actionOmissionForceNoTools, true)
  await ordinary(world)
  assert.equal(world.reads(), 1)
  assert.equal(world.agent.closedRoundObservationUsed, false)
  assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
  assert.ok(world.events.some(row => row.event === 'recovery.action_omission_observation_complete'))
})

for (const repeatedMissingFact of [false, true]) test(`recoverPlan targeted_observation executes one fact then a closed action despite ${repeatedMissingFact ? 'a Jev provider that would repeatedly request missing_fact' : 'a resolved missing fact'}`, async () => {
  const world = focusedFixture(), providerCalls = [], decisions = []
  world.agent.interactionDecisionProvider = contractCheckedJev(async (state, questions) => {
    decisions.push({ state, questions })
    return { model: 'jev-latest', provider: 'TypeSafe', answers: {
      recovery_semantics: { type: 'choice', choice: decisions.length === 1 || repeatedMissingFact ? 'missing_fact' : 'unclear', confidence: 0.95 },
      one_observation_can_resolve: { type: 'noul', noul: decisions.length === 1 || repeatedMissingFact ? 0.95 : 0.05 },
    }, usage: { input_tokens: 60, output_tokens: 6, cost: 0.00000252 } }
  })
  world.agent.provider = async (_messages, context) => {
    providerCalls.push(context)
    if (providerCalls.length === 1) { assert.equal(context.allowTools, true); return world.request() }
    assert.equal(context.allowTools, false, JSON.stringify({ calls: providerCalls, decisions, events: world.events.slice(-16) }))
    assert.equal(world.agent.actionOmissionObservationUsed, true, 'C6 restaging does not renew the route allowance')
    assert.equal(world.agent.actionOmissionForceNoTools, true)
    assert.equal(world.agent.observationBudgetRemaining, 2, 'the ordinary fact spent one of the original three slots')
    const state = world.memory.currentPlan(saved.planning_states[0].key)
    return planReply({ plan: state.plan, currentStep: state.current_step, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  }
  const result = await world.agent.recoverPlan(world.agent.generation, new Error('one targeted observation is missing'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(world.events.filter(row => row.event === 'tool.call' && row.data.name === 'getInventoryItems').length, 1, 'one model-selected fact; C6 handoff baseline refreshes remain separately owned')
  assert.equal(providerCalls.length, 2)
  assert.equal(decisions.length, 1, 'the spent allowance bypasses further semantic judgments deterministically')
  assert.ok(world.events.some(row => row.event === 'recovery.routed' && row.data.applied_route === 'targeted_observation'))
  assert.ok(world.events.some(row => row.event === 'recovery.routed' && row.data.applied_route === 'wake_planner'
    && row.data.fallback_reason === 'targeted_observation_budget_exhausted' && row.data.decision_called === false))
  assert.ok(world.events.some(row => row.event === 'context.restaged' && row.data.checkpoint === 'C6'))
  assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
  assert.equal(world.agent.closedRoundObservationUsed, false)
})

for (const invalid of ['mixed', 'stale-step', 'ungrounded']) test(`open typed request retains strict control validation: ${invalid}`, async () => {
  const world = focusedFixture(), message = world.request(), intent = JSON.parse(message.content)
  if (invalid === 'mixed') intent.operations = [{ name: 'wait', args: { ticks: 1 } }]
  if (invalid === 'stale-step') intent.observationRequest.stepId = 'obsolete-step'
  if (invalid === 'ungrounded') { intent.observationRequest.tool = 'getEntityStatus'; intent.observationRequest.args = { unit_number: 999 } }
  message.content = JSON.stringify(intent)
  const refused = await world.agent.handleObservationRequest(message, world.context)
  assert.ok(refused._sglunaObservationRefusal)
  assert.equal(world.reads(), 0); assert.equal(world.game.mutations.length, 0)
  assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
})

for (const boundary of ['actor-before', 'epoch-before', 'cancel-before', 'actor-during', 'epoch-during', 'cancel-during', 'read-failure']) test(`open alias retains ordinary safety boundary: ${boundary}`, async () => {
  const world = focusedFixture()
  if (boundary === 'actor-before') world.game.status.actor_id++
  if (boundary === 'epoch-before') world.game.status.epoch++
  if (boundary === 'cancel-before') world.agent.generation++
  if (boundary === 'actor-during') world.game.duringRead = () => { world.game.status.actor_id++ }
  if (boundary === 'epoch-during') world.game.duringRead = () => { world.game.status.epoch++ }
  if (boundary === 'cancel-during') world.game.duringRead = () => { world.agent.cancel('user_stop_immediate') }
  if (boundary === 'read-failure') world.game.readError = true
  await assert.rejects(ordinary(world), /actor|epoch|cancel|superseded|stale|declared fixture read failure/i)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.agent.toolCache.size, 0, 'failed and stale facts cannot enter the cache')
  assert.equal(world.agent.closedRoundObservationUsed, false)
  assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
})
