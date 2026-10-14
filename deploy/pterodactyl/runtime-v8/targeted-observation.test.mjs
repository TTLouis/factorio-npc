import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, planReply } from './task-loop-fixtures.mjs'
import { normalizeObservationRequest, restoreObservationLedger } from './targeted-observation.mjs'
import { plannerControlPayloadFromMessage } from './structured-policy.mjs'

const saved = JSON.parse(readFileSync(new URL('./fixtures/luna-furnace-state-2026-10-07.json', import.meta.url), 'utf8'))
const packets = readFileSync(new URL('./fixtures/luna-furnace-closed-2026-10-07.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
const KEY = saved.planning_states[0].key

function fixture({ stateFile = null, provider, resource = false } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(saved))
  const state = memory.currentPlan(KEY)
  // Corrected reply fixtures resume the captured goal; committed contracts and
  // its verified prefix are retained. No captured packet or saved file is edited.
  state.status = 'active'
  memory.recordRunResume(KEY, state, 'scripted_fixture_resume')
  const game = new FakeFactorio({ inventory: { 'iron-ore': 50, 'iron-plate': 8 } })
  game.status.actor_id = 6
  game.status.epoch = 1
  game.entityReads = 0
  const original = game.command.bind(game)
  game.command = async text => {
    if (text.includes('"get_entity_status"')) {
      assert.match(text, /nil,nil,12\)/, 'reads the exact observed unit, not a nearest-name substitute')
      game.entityReads++
      await game.duringEntityRead?.()
      return JSON.stringify({ found: true, entity: { unit_number: 12, name: 'stone-furnace', type: 'furnace',
        position: { x: 82, y: -1 }, working: false, status: 18,
        inventories: [{ index: 1, items: [] }, { index: 2, items: [{ name: 'coal', quality: 'normal', count: 4 }] }],
      } })
    }
    return original(text)
  }
  const events = []
  let calls = 0
  let reservations = 0
  const agent = new NpcAgentLoop({ rcon: game, memory, stateFile, traceFile: null, decisionTraceFile: null,
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, false)
      assert.ok(messages.some(message => String(message.content).includes(resource ? '"name":"copper-ore"' : '"unit_number":12')))
      return planReply(provider ? await provider(calls, agent) : { plan: state.plan, currentStep: state.current_step,
        operations: [{ name: 'supply_entity', args: { unit_number: 12, items: [{ item_name: 'iron-ore', count: 50 }] } }] })
    }, reserve: async () => { reservations++; return {} },
    onActivity: (event, data) => events.push({ event, data }), completionProtocolVersion: 2,
  })
  agent.active = true
  agent.epoch = { ...game.status }
  agent.requestInfo = { memoryKey: KEY }
  agent.traceRequest = { id: 'req_targeted_fixture' }
  agent.observationBudgetRemaining = 0
  agent.observationDecisionForced = true
  agent.observationRelevanceOverride = ['recipe_production']
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.recordLiveEntityObservation({ unit_number: 12, name: 'stone-furnace', type: 'furnace', position: { x: 82, y: -1 } }, undefined, 'retained_nearby')
  const context = { generation: agent.generation, attribution: agent.turnConversation, current: game.status,
    round: 1, recoveryAttempt: 0 }
  const request = overrides => ({ content: JSON.stringify({ plan: state.plan, currentStep: state.current_step,
    operations: [], observationRequest: { stepId: agent.targetedObservationIdentity().data.stepId,
      tool: 'getEntityStatus', args: { unit_number: 12 }, rationale: 'Need current input, output and fuel before reusing the observed machine.' }, ...overrides }) })
  return { agent, memory, game, state, events, context, request, counts: () => ({ calls, reservations }) }
}

test('retained closed furnace reply remains a truthful failure, without inferring a read from blocker prose', async () => {
  const original = packets.at(-1)
  assert.match(original.content_preview, /BLOCKED:/)
  const finalRequest = packets.filter(row => row.event === 'provider.request').at(-1)
  assert.match(JSON.stringify(finalRequest.payload.messages), /previous_recipe_name/)
  const world = fixture()
  const message = { content: original.content_preview }
  assert.equal(await world.agent.handleObservationRequest(message, world.context), undefined)
  assert.equal(world.game.entityReads, 0)
  assert.equal(world.counts().calls, 0)
  assert.equal(saved.plans[0].state.task_board.completed_count, 1)
  assert.equal(saved.planning_states[0].state.goal.status, 'active')
})

test('a corrected explicit missing-fact decision gets one exact live read despite zero normal budget and excluded family', async () => {
  const world = fixture()
  const before = structuredClone(world.memory.planningState(KEY))
  const reply = await world.agent.handleObservationRequest(world.request(), world.context)
  const plan = world.agent.parsePlanMessage(reply)
  assert.equal(plan.operations[0].name, 'supply_entity')
  assert.equal(plan.operations[0].args.unit_number, 12)
  assert.equal(world.game.entityReads, 1)
  assert.deepEqual(world.counts(), { calls: 1, reservations: 1 })
  assert.equal(world.agent.observationBudgetRemaining, 0)
  assert.equal(world.agent.observationDecisionForced, true)
  assert.equal(world.game.mutations.length, 0, 'a read never executes the returned operation')
  assert.deepEqual(world.memory.planningState(KEY), before, 'read does not change committed semantics or progress')
  const grant = world.events.find(row => row.event === 'observation.targeted_granted')
  assert.ok(grant.data.request_id)
  assert.equal(grant.data.reason, 'one_missing_fact_read_at_native_progress_boundary')
})

test('targeted recovery rejects discovery, stale steps, ungrounded units and mixed gameplay/completion declarations', async () => {
  for (const alter of [
    intent => { intent.observationRequest.tool = 'getNearbyEntities'; intent.observationRequest.args = { radius: 32 } },
    intent => { intent.observationRequest.stepId = 'old-step' },
    intent => { intent.observationRequest.args.unit_number = 99 },
    intent => { intent.operations = [{ name: 'wait', args: { ticks: 1 } }] },
    intent => { intent.semanticCompletion = { stepId: intent.observationRequest.stepId, rationale: 'skip it' } },
    intent => { intent.checkpoint = { mode: 'all', requirements: [] } },
  ]) {
    const world = fixture()
    const intent = JSON.parse(world.request().content)
    alter(intent)
    const reply = await world.agent.handleObservationRequest({ content: JSON.stringify(intent) }, world.context)
    assert.equal(reply._sglunaObservationRefusal !== undefined, true)
    assert.throws(() => world.agent.parsePlanMessage(reply), error => error.code === 'observation_request_refused')
    assert.equal(world.game.entityReads, 0)
    assert.equal(world.counts().calls, 0)
    const refusal = world.events.find(row => row.event === 'observation.targeted_refused')
    assert.ok(refusal.data.request_id)
    assert.ok(refusal.data.reason)
  }
})

test('closed provider round admits the typed request and returns the corrected action through normal parsing', async () => {
  const world = fixture()
  const finalProvider = world.agent.provider
  let first = true
  world.agent.provider = async (messages, context) => {
    if (first) { first = false; assert.equal(context.allowTools, false); return world.request() }
    return finalProvider(messages, context)
  }
  const reply = await world.agent.callProvider(world.context.current, world.context.generation, { round: 0, allowTools: false })
  assert.equal(world.agent.parsePlanMessage(reply).operations[0].name, 'supply_entity')
  assert.equal(world.game.entityReads, 1)
  assert.equal(world.counts().reservations, 2, 'both provider decisions use the existing allowance')
  assert.equal(world.game.mutations.length, 0)
})

test('an unpersisted claim and an already consumed repair allowance cannot execute a read', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'luna-claim-'))
  try {
    const stateFile = path.join(dir, 'state.json')
    await fsp.writeFile(stateFile, '{}')
    const world = fixture({ stateFile })
    world.agent.persistState = async () => {}
    assert.match((await world.agent.handleObservationRequest(world.request(), world.context))._sglunaObservationRefusal.reason, /claim_not_persisted/)
    assert.equal(world.game.entityReads, 0)
    const used = fixture()
    used.agent.actionOmissionObservationUsed = true
    assert.match((await used.agent.handleObservationRequest(used.request(), used.context))._sglunaObservationRefusal.reason, /already_used/)
    assert.equal(used.game.entityReads, 0)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('busy runtime and unresolved operation ownership forbid targeted reads', async () => {
  for (const pending of [false, true]) {
    const world = fixture()
    if (pending) world.memory.pendingOperation = () => ({ state: 'recorded' })
    else { world.game.taskState = 'mining'; world.game.queueLength = 1 }
    const reply = await world.agent.handleObservationRequest(world.request(), world.context)
    assert.match(reply._sglunaObservationRefusal.reason, /runtime_not_idle/)
    assert.equal(world.game.entityReads, 0)
  }
})

test('restage and restart cannot renew the read allowance at the same native receipt boundary', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'luna-targeted-'))
  try {
    const stateFile = path.join(dir, 'state.json')
    const world = fixture({ stateFile })
    await world.agent.handleObservationRequest(world.request(), world.context)
    world.agent.resetObservationDecisionState()
    assert.match((await world.agent.handleObservationRequest(world.request(), world.context))._sglunaObservationRefusal.reason, /targeted_allowance_already_used/)
    const restarted = fixture({ stateFile })
    await restarted.agent.loadPersistentState()
    assert.match((await restarted.agent.handleObservationRequest(restarted.request(), restarted.context))._sglunaObservationRefusal.reason, /targeted_allowance_already_used/)
    assert.equal(restarted.game.entityReads, 0)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('actor, goal, step and handoff changes during a read discard its result and prevent the final provider call', async () => {
  for (const change of ['actor', 'goal', 'step', 'handoff']) {
    const world = fixture()
    world.game.duringEntityRead = () => {
      if (change === 'actor') world.game.status.epoch++
      if (change === 'goal') world.memory.planningState(KEY).goal.status = 'completed'
      if (change === 'step') world.memory.planningState(KEY).plans.at(-1).active_step_index++
      if (change === 'handoff') world.agent.agentContext.conversationSeq++
    }
    await assert.rejects(world.agent.handleObservationRequest(world.request(), world.context), /epoch changed|cancelled|superseded|stale/i)
    assert.equal(world.counts().calls, 0)
    assert.equal(world.game.mutations.length, 0)
    assert.ok(!world.agent.messages.some(row => row.role === 'tool'), 'stale facts are never published')
    assert.equal(world.agent.toolCache.size, 0, 'stale facts are never cached')
  }
})

test('supersession during post-read diagnostics or result tracing cannot write into the newer context', async () => {
  for (const boundary of ['diagnostic', 'tool.call', 'tool.result']) {
    const world = fixture()
    world.agent.observationDecisionForced = false
    const replace = () => {
      world.agent.agentContext.conversationSeq++
      world.agent.messages = [{ role: 'user', content: 'newer context' }]
      world.agent.liveEntityObservations.clear()
      world.agent.handoffInventoryObservations.clear()
      world.agent.toolCache.clear()
      world.agent.freshObservationSinceContinuation = false
      world.agent.observationDecisionForced = false
      world.agent.actionOmissionObservationUsed = false
    }
    if (boundary === 'diagnostic') world.agent.recoveryDiagnostic = async () => replace()
    else {
      const trace = world.agent.traceEvent.bind(world.agent)
      world.agent.traceEvent = async (event, ...args) => {
        await trace(event, ...args)
        if (event === boundary) replace()
      }
    }
    await assert.rejects(world.agent.handleObservationRequest(world.request(), world.context), /cancelled|superseded|stale/i)
    assert.deepEqual(world.agent.messages, [{ role: 'user', content: 'newer context' }])
    assert.equal(world.agent.liveEntityObservations.size, 0)
    assert.equal(world.agent.handoffInventoryObservations.size, 0)
    assert.equal(world.agent.toolCache.size, 0)
    assert.equal(world.agent.freshObservationSinceContinuation, false)
    assert.equal(world.agent.observationDecisionForced, false)
    assert.equal(world.agent.actionOmissionObservationUsed, false)
    assert.equal(world.counts().calls, 0)
  }
})

test('only a new authoritative operation receipt renews the allowance within one step', async () => {
  const world = fixture()
  await world.agent.handleObservationRequest(world.request(), world.context)
  world.agent.resetObservationDecisionState()
  const held = world.agent.targetedObservationIdentity()
  held.plan.execution.receipts[held.step.step_id].push({ kind: 'deterministic_verification', ref: 'unrelated-assessment' })
  assert.match((await world.agent.handleObservationRequest(world.request(), world.context))._sglunaObservationRefusal.reason, /already_used/)
  held.plan.execution.receipts[held.step.step_id].push({ kind: 'operation_receipt', ref: 'batch-g1-8' })
  await world.agent.handleObservationRequest(world.request(), world.context)
  assert.equal(world.game.entityReads, 2)
})

test('superseded handoff step facts are absent from provider input while committed plan and current state remain', () => {
  const world = fixture()
  const stepId = world.agent.targetedObservationIdentity().data.stepId
  world.agent.messages.push({ role: 'user', content: '[HANDOFF]\n--- plan block (stable while this plan runs) ---\ncommitted plan' },
    { role: 'user', content: '--- step block ---\nactive_step: 1 of 4 previous_step | electronics\nold inventory facts' })
  const messages = world.agent.providerMessages()
  assert.ok(messages.some(row => row.content.includes('committed plan')))
  assert.ok(!messages.some(row => row.content.includes('previous_step')))
  assert.equal(world.agent.pendingSupersededHandoffTrace.current_step_id, stepId)
})

test('targeted control cannot accidentally enter direct plan commitment and ledger restore is bounded', () => {
  const world = fixture()
  assert.throws(() => world.agent.parsePlanMessage(world.request()), error => error.code === 'observation_request_not_processed')
  assert.throws(() => normalizeObservationRequest({ stepId: 's', tool: 'getEntityStatus', args: { name: 'stone-furnace' }, rationale: 'look' }), /unit_number/)
  assert.equal(restoreObservationLedger([['k', 'not-json'], ['k', '[]'], null]).size, 0)
})

function resourceFixture(options = {}) {
  const world = fixture({ ...options, resource: true })
  const original = world.game.command.bind(world.game)
  world.game.resourceReads = 0
  world.game.command = async command => {
    if (command.includes('"autorio_discovery","find_entities"')) {
      world.game.resourceReads++
      await world.game.duringResourceRead?.()
      return JSON.stringify({ name: 'copper-ore', max_radius: 1024, searched_radius: 128,
        found: true, matched_count: 1, returned_count: 1,
        entities: [{ name: 'copper-ore', type: 'resource', position: { x: 96, y: 0 }, distance: 96 }] })
    }
    return original(command)
  }
  world.agent.recordHandoffToolFacts('getRecipeDetails', JSON.stringify({
    query: 'copper-ore', found: false, code: 'no_recipe', mined_from: ['copper-ore'], recipes: [],
  }), { item_or_recipe: 'copper-ore' })
  const intent = JSON.parse(world.request().content)
  intent.observationRequest = { stepId: world.agent.targetedObservationIdentity().data.stepId,
    tool: 'findLongRangeEntities', args: { name: 'copper-ore', max_radius: 1024, limit: 1 },
    rationale: 'The nearby resource scan is empty; locate the native copper mining source.' }
  world.resourceRequest = { content: JSON.stringify(intent) }
  return world
}

test('run C four-read shape leaves one durable native-grounded resource search, without reopening tools', async () => {
  const world = resourceFixture()
  const before = structuredClone(world.memory.planningState(KEY))
  world.agent.observationBudgetRemaining = 4
  world.agent.observationDecisionForced = false
  world.agent.observationRelevanceOverride = null
  // Same read sequence as LUNA_GPT6_PROXY_LIVE_RUN_C_2026-10-13.md.
  for (const [index, [name, args]] of [
    ['getInventoryItems', {}], ['getNearbyEntities', { radius: 32, type: 'resource' }],
    ['getNearbyEntities', { radius: 16, name: 'stone-furnace' }], ['getRecipeDetails', { item_or_recipe: 'copper-plate' }],
  ].entries()) await world.agent.handleToolBatch({ tool_calls: [{ id: `run_c_${index}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] })
  assert.equal(world.agent.observationBudgetRemaining, 0)
  assert.equal(world.agent.observationDecisionForced, true)
  assert.deepEqual(world.agent.controlDecisionState(false).resourceSearchNames, ['copper-ore'])
  await world.agent.handleObservationRequest(world.resourceRequest, world.context)
  assert.equal(world.game.resourceReads, 1)
  assert.equal(world.agent.observationBudgetRemaining, 0)
  assert.equal(world.agent.observationDecisionForced, true)
  assert.equal(world.game.mutations.length, 0)
  assert.deepEqual(world.memory.planningState(KEY), before)
  const trace = world.events.find(row => row.event === 'observation.targeted_resource_search')
  assert.equal(trace.data.request_id, 'req_targeted_fixture')
  assert.equal(trace.data.reason, 'native_source_location_missing_with_normal_observations_closed')
  assert.equal(trace.data.limit, 1)
  assert.match((await world.agent.handleObservationRequest(world.request(), world.context))._sglunaObservationRefusal.reason, /already_used/)
  world.agent.resetObservationDecisionState()
  assert.match((await world.agent.handleObservationRequest(world.resourceRequest, world.context))._sglunaObservationRefusal.reason, /already_used/)
})

test('resource recovery refuses guessed names, broad searches and hidden extra arguments before reading', async () => {
  for (const args of [
    { name: 'iron-ore', max_radius: 1024, limit: 1 },
    { name: 'copper-ore', max_radius: 1025, limit: 1 },
    { name: 'copper-ore', max_radius: 1024, limit: 2 },
    { name: 'copper-ore', max_radius: 1024, limit: 1, type: 'resource' },
    { max_radius: 1024, limit: 1 },
  ]) {
    const world = resourceFixture()
    const intent = JSON.parse(world.resourceRequest.content)
    intent.observationRequest.args = args
    const result = await world.agent.handleObservationRequest({ content: JSON.stringify(intent) }, world.context)
    assert.ok(result._sglunaObservationRefusal)
    assert.equal(world.game.resourceReads, 0)
    assert.equal(world.counts().calls, 0)
  }
})

test('resource search consumes the persisted allowance and actor replacement cannot publish its location', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'luna-resource-'))
  try {
    const stateFile = path.join(dir, 'state.json')
    const world = resourceFixture({ stateFile })
    world.game.duringResourceRead = () => { world.game.status.epoch++ }
    await assert.rejects(world.agent.handleObservationRequest(world.resourceRequest, world.context), /epoch changed|cancelled|superseded|stale/i)
    assert.equal(world.counts().calls, 0)
    assert.equal(world.agent.toolCache.size, 0)
    assert.ok(!world.agent.messages.some(row => row.role === 'tool'))
    const restarted = resourceFixture({ stateFile })
    await restarted.agent.loadPersistentState()
    assert.match((await restarted.agent.handleObservationRequest(restarted.resourceRequest, restarted.context))._sglunaObservationRefusal.reason, /already_used/)
    assert.equal(restarted.game.resourceReads, 0)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

// --- Unit 8 A: the executor's targeted read ---------------------------------------------------------------------------
// Live run E (2026-10-13): the executor's submitPlan carries stepId and operations, and no plan or currentStep (the parser
// fills [] and 0). The committed-phase check compared those fillers with the planner's plan, and its key list lacked
// stepId, so both targeted reads were refused as stale_plan_or_step although executor.step_bound matched the step.

// The exact control decision the harness builds from the executor's submitPlan tool call (provider.plan_submission).
function executorSubmission(world, args = {}, requestOverrides = {}) {
  const stepId = world.agent.targetedObservationIdentity().data.stepId
  const message = { content: '', tool_calls: [{ id: 'call_live', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify({
    stepId,
    operations: [],
    observationRequest: { stepId, tool: 'getEntityStatus', args: { unit_number: 12 },
      rationale: 'Need the furnace identity and its fuel and input quantities before acting.', ...requestOverrides },
    ...args,
  }) } }] }
  return { content: JSON.stringify(plannerControlPayloadFromMessage(message)) }
}

function executorFixture(options) {
  const world = fixture(options)
  world.agent.agentContext.role = 'executor'
  return world
}

test('8 A: the live executor submitPlan shape (stepId, operations [], no plan or currentStep) is admitted to the targeted read', async () => {
  const world = executorFixture()
  const message = executorSubmission(world)
  const intent = JSON.parse(message.content)
  assert.deepEqual(intent.plan, [], 'the parser fills the plan with []')
  assert.equal(intent.currentStep, 0, 'and the step index with 0, which is the shape live run E had refused')
  assert.equal(intent.stepId, world.agent.targetedObservationIdentity().data.stepId)
  const before = structuredClone(world.memory.planningState(KEY))
  const reply = await world.agent.handleObservationRequest(message, world.context)
  assert.equal(reply._sglunaObservationRefusal, undefined)
  assert.equal(world.agent.parsePlanMessage(reply).operations[0].name, 'supply_entity')
  assert.equal(world.game.entityReads, 1, 'the exact observed unit was read')
  assert.deepEqual(world.counts(), { calls: 1, reservations: 1 })
  assert.equal(world.game.mutations.length, 0, 'a read never executes the returned operation')
  assert.deepEqual(world.memory.planningState(KEY), before, 'the read changes no committed semantics or progress')
  assert.equal(world.events.some(row => row.event === 'observation.targeted_refused'), false)
  const grant = world.events.find(row => row.event === 'observation.targeted_granted')
  assert.equal(grant.data.request_id, 'req_targeted_fixture')
  assert.equal(grant.data.step_id, world.agent.targetedObservationIdentity().data.stepId)
  assert.equal(grant.data.reason, 'one_missing_fact_read_at_native_progress_boundary')
  // The one-allowance ledger is unchanged: a second executor read at the same boundary is refused.
  const again = await world.agent.handleObservationRequest(executorSubmission(world), world.context)
  assert.equal(again._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
  assert.equal(world.game.entityReads, 1)
})

test('8 A: an executor read still refuses another step, a stale supplied plan, edits, completions, extra keys and ungrounded units', async () => {
  const cases = [
    ['stale_plan_or_step', world => executorSubmission(world, { stepId: 'goal_old_p1_v1_s1_x' })],
    ['stale_plan_or_step', world => executorSubmission(world, {}, { stepId: 'goal_old_p1_v1_s1_x' })],
    // A reply that does supply a plan is still compared with the committed plan.
    ['stale_plan_or_step', world => executorSubmission(world, { plan: ['a different committed step'], currentStep: 0 })],
    ['read_cannot_edit_or_complete_plan', world => executorSubmission(world, { operations: [{ name: 'wait', args: { ticks: 1 } }] })],
    ['read_cannot_edit_or_complete_plan', world => executorSubmission(world, { semanticCompletion: { stepId: world.agent.targetedObservationIdentity().data.stepId, rationale: 'close it' } })],
    ['read_cannot_edit_or_complete_plan', world => executorSubmission(world, { checkpoint: { mode: 'all', requirements: [] } })],
    ['entity_not_grounded', world => executorSubmission(world, {}, { args: { unit_number: 99 } })],
  ]
  for (const [reason, build] of cases) {
    const world = executorFixture()
    const reply = await world.agent.handleObservationRequest(build(world), world.context)
    assert.equal(reply._sglunaObservationRefusal.reason, reason, reason)
    assert.equal(world.game.entityReads, 0)
    assert.equal(world.counts().calls, 0)
    const refusal = world.events.find(row => row.event === 'observation.targeted_refused')
    assert.equal(refusal.data.reason, reason)
    assert.ok(refusal.data.request_id)
  }
})

test('8 A: planner and draft requests keep the plan/currentStep comparison and refuse a stepId key', async () => {
  // A planner (the fixture default) that sends the executor's fillers is stale; the stepId key is not a planner key.
  const stale = fixture()
  const staleReply = await stale.agent.handleObservationRequest(executorSubmission(stale), stale.context)
  assert.equal(staleReply._sglunaObservationRefusal.reason, 'stale_plan_or_step')
  const stepKey = fixture()
  const intent = JSON.parse(stepKey.request().content)
  intent.stepId = stepKey.agent.targetedObservationIdentity().data.stepId
  const keyReply = await stepKey.agent.handleObservationRequest({ content: JSON.stringify(intent) }, stepKey.context)
  assert.equal(keyReply._sglunaObservationRefusal.reason, 'read_cannot_edit_or_complete_plan')
  // An executor request without a stepId is the legacy shape: its supplied plan and currentStep are compared as before.
  const legacy = executorFixture()
  const legacyIntent = JSON.parse(legacy.request().content)
  const ok = await legacy.agent.handleObservationRequest({ content: JSON.stringify(legacyIntent) }, legacy.context)
  assert.equal(ok._sglunaObservationRefusal, undefined)
  const staleLegacy = executorFixture()
  legacyIntent.currentStep += 1
  const staleReply2 = await staleLegacy.agent.handleObservationRequest({ content: JSON.stringify(legacyIntent) }, staleLegacy.context)
  assert.equal(staleReply2._sglunaObservationRefusal.reason, 'stale_plan_or_step')
  for (const world of [stale, stepKey, staleLegacy]) assert.equal(world.game.entityReads, 0)
})

test('8 C: the resources that yield a burner fuel become eligible exact names for the targeted resource search', () => {
  const world = executorFixture()
  assert.deepEqual(world.agent.controlDecisionState(false).resourceSearchNames, [])
  world.agent.recordHandoffToolFacts('getRecipeDetails', JSON.stringify({ found: true, query: 'copper-plate', truncated: false, recipes: [{
    name: 'copper-plate', enabled: true, energy: 3.2, categories: ['smelting'], hand_craftable_category: false,
    ingredients: [{ type: 'item', name: 'copper-ore', amount: 1 }], products: [{ type: 'item', name: 'copper-plate', amount: 1 }],
    crafting_machines: [{ name: 'stone-furnace', type: 'furnace', energy_source: 'burner', fuel_categories: ['chemical'], energy_watts: 90000, placed_by_item: 'stone-furnace' }],
  }],
  burner_fuels: { categories: ['chemical'], matched_count: 2, truncated: false, items: [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000 },
  ] } }), { item_or_recipe: 'copper-plate' })
  assert.deepEqual(world.agent.controlDecisionState(false).resourceSearchNames, ['coal'])
})
