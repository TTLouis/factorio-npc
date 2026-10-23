import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { discardContractPrediction, startContractPrediction } from './contract-prediction.mjs'
import { FakeFactorio, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:prediction-fixture'
const gathered = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'coal', minimum: 1 }] }
const placed = { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'boiler', minimum: 1 }] }
const material = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 1 }] }
const descriptions = ['Hold one coal for the bootstrap.', 'Install the boiler at the observed site.']
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function packetOf(messages) {
  const content = messages.find(row => row.role === 'user' && row.content.startsWith('[STEP_CONTRACT_REQUEST]')).content
  return JSON.parse(content.slice(content.indexOf(' {"goal"') + 1))
}
function world({ onContract, onReserve, target = placed, onTrace, onGround, onInventoryRead } = {}) {
  const stepDescriptions = target === material ? [descriptions[0], 'Hold one copper ore for the next production result.'] : descriptions
  const memory = new CanonicalTaskBoardMemory(); const game = new FakeFactorio({ inventory: { boiler: 1 } })
  game.status.connected_players = 0
  const events = []; const contracts = []; const decisions = []; const reserves = []
  const native = game.command.bind(game)
  let scopeReadable = true; let agent
  game.command = async text => {
    if (text.includes('"get_inventory_items"')) await onInventoryRead?.({ agent, game, memory })
    if (text.includes('evaluate_condition') && text.includes('entity_count')) {
      await onGround?.({ agent, game, memory })
      return JSON.stringify(scopeReadable ? { ok: true, kind: 'entity_count', prototype: 'boiler', minimum: 1, current: 0, satisfied: false }
        : { ok: false, error: 'scripted_scope_no_longer_evaluable' })
    }
    return native(text)
  }
  const held = () => getActivePlan(memory.planningState(KEY))
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'prediction-fixture', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null, systemPrompt: 'Deterministic contract prediction lifecycle fixture.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    reserve: async args => { reserves.push(args); await onReserve?.({ agent, game, memory, contracts, reserves }) },
    provider: async (messages, context) => {
      if (context.triggerSource === 'step_contract') {
        const packet = packetOf(messages); const call = { packet, context, messages: structuredClone(messages) }
        contracts.push(call)
        const chosen = await onContract?.({ agent, game, memory, call, contracts, setScopeReadable: value => { scopeReadable = value } })
        return { content: JSON.stringify({ stepId: packet.target.step_id, checkpoint: chosen ?? target }) }
      }
      decisions.push({ context, messages: structuredClone(messages) })
      if (context.role === 'planner') return planReply({ plan: stepDescriptions, currentStep: 0, operations: [],
        goal: { scope: 'long_horizon', summary: 'Produce automatic red science.', doneWhen: [{ kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 1, window_minutes: 1 }] },
        roadmap: [{ id: 'first-capability', intent: 'Make bootstrap infrastructure available.' }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: gathered }, { kind: 'deterministic' }],
        executionGuidance: stepDescriptions.map(description => ({ approach: description, rationale: 'Resolve the next result at an observation boundary.', constraints: [], skillIds: [], materialSupply: null })) })
      const plan = held(); const stepId = plan.steps[plan.active_step_index].step_id
      return planReply({ stepId, operations: plan.active_step_index === 0
        ? [{ name: 'gather_resource', args: { resource_name: 'coal', count: 1, search_radius: 32 } }]
        : target === material ? [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 1, search_radius: 32 } }]
          : [{ name: 'place_entity', args: { entity_name: 'boiler', x: 4, y: 0 } }] })
    } })
  agent.behaviorTrace = { emit: async row => { events.push(row); await onTrace?.({ row, agent, game, memory }) } }
  return { agent, game, memory, events, contracts, decisions, reserves, held, descriptions: stepDescriptions,
    setScopeReadable: value => { scopeReadable = value },
    start: () => agent.request('Build bootstrap infrastructure for automatic red science.', { sender: 'Louis' }),
    close: async () => { game.inventory.coal = 1; return agent.completed() } }
}

test('one prediction starts after native admission, changes no conversation/contract, then binds once at the verified next boundary', async () => {
  const gate = deferred(); const entered = deferred()
  const w = world({ onContract: async ({ call }) => {
    assert.equal(call.packet.assumed_outcome.assumed_satisfied, true)
    entered.resolve()
    await gate.promise
  } })
  await w.start()
  await entered.promise
  const first = structuredClone(w.held().steps[0]); const messages = structuredClone(w.agent.messages)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.held().steps[1].completion_contract, null)
  startContractPrediction(w.agent)
  startContractPrediction(w.agent)
  assert.equal(w.contracts.length, 1, 'additional admitted batches/wakes cannot create parallel predictions')
  gate.resolve()
  await w.agent.contractPrediction.flight
  assert.deepEqual(w.agent.messages, messages, 'prediction is a side exchange')
  assert.equal(w.held().steps[1].completion_contract, null, 'an authored prediction is not committed')
  await w.close()
  assert.equal(w.contracts.length, 1)
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.held().steps[1].contract_binding.binding, 'prediction')
  assert.deepEqual(w.held().steps[0], first)
  assert.equal(w.game.mutations.length, 2, 'ordinary executor continues after the verified close')
  assert.equal(w.memory.planningState(KEY).goal.status, 'active', 'the build outline cannot declare sustained red production')
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_bound' && row.data.step_id === w.held().steps[1].step_id))
})

test('a material-only prediction is discarded and a fresh JIT contract is authored without changing the step intent', async () => {
  const w = world({ target: material })
  await w.start()
  await w.agent.contractPrediction.flight
  await w.close()
  assert.equal(w.contracts.length, 2)
  assert.equal(w.contracts[0].packet.assumed_outcome.assumed_satisfied, true)
  assert.equal(w.contracts[1].packet.assumed_outcome, undefined)
  assert.equal(w.contracts[1].packet.facts.inventory.coal, 1)
  assert.equal(w.held().steps[1].description, w.descriptions[1])
  assert.equal(w.held().steps[1].contract_binding.binding, 'just_in_time')
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_discarded' && row.data.reason === 'material_count_needs_fresh_state'))
})

test('changed native grounding invalidates the held prediction; JIT fallback can choose a newly grounded contract', async () => {
  const w = world({ onContract: ({ contracts, setScopeReadable }) => {
    if (contracts.length > 1) { setScopeReadable(true); return { mode: 'all', requirements: [...placed.requirements, ...material.requirements] } }
  } })
  await w.start()
  await w.agent.contractPrediction.flight
  w.setScopeReadable(false)
  await w.close()
  assert.equal(w.contracts.length, 2)
  assert.equal(w.held().steps[1].contract_binding.binding, 'just_in_time')
  assert.equal(w.held().steps[1].completion_contract.requirements.length, 2)
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_discarded' && row.data.reason === 'fresh_validation_scripted_scope_no_longer_evaluable'))
  assert.equal(w.game.mutations.length, 2)
})

for (const change of ['actor', 'goal', 'version', 'request', 'cancel']) {
  test(`a ${change} change while prediction is in flight cannot bind or admit a new action`, async () => {
    const entered = deferred(); const release = deferred()
    const w = world({ onContract: async ({ call }) => {
      entered.resolve()
      await Promise.race([release.promise, new Promise(resolve => call.context.signal.addEventListener('abort', resolve, { once: true }))])
    } })
    await w.start()
    await entered.promise
    const prediction = w.agent.contractPrediction
    if (change === 'actor') w.game.status.epoch++
    if (change === 'goal') w.memory.planningState(KEY).goal.goal_id = 'replacement-goal'
    if (change === 'version') w.held().plan_version++
    if (change === 'request') w.agent.traceRequest = { id: 'replacement-request', usage: {} }
    if (change === 'cancel') w.agent.cancel('user_stop')
    release.resolve()
    await prediction.flight
    if (change !== 'cancel') {
      try { await w.close() } catch (error) { assert.match(error.message, /epoch|superseded|cancelled/i) }
    }
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.contracts.length, 1)
    assert.equal(w.held().steps[1].completion_contract, null)
    assert.equal(w.events.some(row => row.event === 'plan.contract_prediction_bound'), false)
    assert.equal(w.memory.pauseRecord(KEY).paused, false, 'old prediction cannot pause replacement work')
    if (change === 'request') assert.deepEqual(w.agent.traceRequest.usage, {}, 'the old side-call response cannot charge replacement request usage')
  })
}

test('owner replacement during prediction reservation prevents a provider request and spends no replacement allowance', async () => {
  const w = world({ onReserve: ({ agent }) => {
    if (!agent.contractPrediction) return
    agent.traceRequest = { id: 'new-owner-after-reserve', usage: {} }
  } })
  await w.start()
  const record = w.agent.contractPrediction
  await record.flight
  assert.equal(w.contracts.length, 0)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.held().steps[1].completion_contract, null)
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_discarded'))
})

test('a residual wrong close source discards the assumption and safely continues with a fresh JIT contract', async () => {
  const w = world()
  await w.start()
  await w.agent.contractPrediction.flight
  const bind = w.agent.bindActiveStepContract.bind(w.agent)
  // Inject a misreported source after a real native receipt has been verified;
  // it cannot convert an assumed completion route into binding authority.
  w.agent.bindActiveStepContract = args => bind({ ...args, closedBy: 'semantic_completion' })
  await w.close()
  assert.equal(w.contracts.length, 2)
  assert.equal(w.held().steps[1].contract_binding.binding, 'just_in_time')
  assert.equal(w.game.mutations.length, 2)
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_discarded' && row.data.reason === 'assumed_outcome_not_verified'))
})

test('replacement during prediction-discard trace cannot start a JIT fallback or pause the replacement', async () => {
  const w = world({ target: material, onTrace: ({ row, agent }) => {
    if (row.event === 'plan.contract_prediction_discarded' && row.data.reason === 'material_count_needs_fresh_state') {
      agent.traceRequest = { id: 'replacement-during-disposition', usage: {} }
    }
  } })
  await w.start()
  await w.agent.contractPrediction.flight
  await assert.rejects(w.close(), /superseded|cancelled/i)
  assert.equal(w.contracts.length, 1)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.held().steps[1].completion_contract, null)
  assert.equal(w.memory.pauseRecord(KEY).paused, false)
})

for (const change of ['request', 'native_epoch']) {
  test(`${change} replacement during fresh prediction grounding cannot bind, call JIT or pause replacement work`, async () => {
    let armed = false
    const w = world({ onGround: ({ agent, game }) => {
      if (!armed) return
      armed = false
      if (change === 'request') agent.traceRequest = { id: 'new-owner-during-grounding', usage: {} }
      else game.status.epoch++
    } })
    await w.start()
    await w.agent.contractPrediction.flight
    armed = true
    await assert.rejects(w.close(), /superseded|cancelled|epoch/i)
    assert.equal(w.contracts.length, 1)
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.held().steps[1].completion_contract, null)
    assert.equal(w.memory.pauseRecord(KEY).paused, false)
  })
}

test('discarding a prediction aborts only its own side call, preserving an unrelated controller', async () => {
  const entered = deferred()
  const w = world({ onContract: async ({ call }) => {
    entered.resolve()
    await new Promise(resolve => call.context.signal.addEventListener('abort', resolve, { once: true }))
  } })
  await w.start()
  await entered.promise
  const unrelated = new AbortController()
  w.agent.stepContractAborts.add(unrelated)
  await discardContractPrediction(w.agent, 'fixture_discard')
  assert.equal(unrelated.signal.aborted, false)
  assert.equal(w.agent.stepContractAborts.has(unrelated), true)
  w.agent.stepContractAborts.delete(unrelated)
  assert.equal(w.agent.contractPrediction, null)
})

test('cancellation during speculative fact collection cannot write handoff caches or call a provider for replacement work', async () => {
  const entered = deferred(); const release = deferred()
  let intercepted = false
  const w = world({ onInventoryRead: async ({ agent }) => {
    if (!agent.contractPrediction || intercepted) return
    intercepted = true
    entered.resolve()
    await release.promise
  } })
  await w.start()
  await entered.promise
  const record = w.agent.contractPrediction
  let cacheWrites = 0
  const recordFacts = w.agent.recordHandoffToolFacts.bind(w.agent)
  w.agent.recordHandoffToolFacts = (...args) => { cacheWrites++; return recordFacts(...args) }
  w.agent.cancel('user_stop')
  release.resolve()
  await record.flight
  assert.equal(w.contracts.length, 0)
  assert.equal(cacheWrites, 0)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.held().steps[1].completion_contract, null)
})

test('failed native callback discards and aborts the speculative contract before ordinary failure recovery', async () => {
  const entered = deferred()
  const w = world({ onContract: async ({ call }) => {
    entered.resolve()
    await new Promise(resolve => call.context.signal.addEventListener('abort', resolve, { once: true }))
  } })
  await w.start()
  await entered.promise
  // Fail after the actual prediction cleanup seam, before unrelated scripted
  // failure-strategy calls. The real failed() callback owns the discard.
  w.agent.taskStatusReceipt = async () => { throw new Error('stop_after_prediction_failure_cleanup') }
  await assert.rejects(w.agent.failed('scripted_native_batch_failed'), /stop_after_prediction_failure_cleanup/)
  assert.equal(w.agent.contractPrediction, null)
  assert.equal(w.contracts.length, 1)
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_discarded' && row.data.reason === 'native_step_failed'))
})
