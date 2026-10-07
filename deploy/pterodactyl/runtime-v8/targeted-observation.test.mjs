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

const saved = JSON.parse(readFileSync(new URL('./fixtures/luna-furnace-state-2026-10-07.json', import.meta.url), 'utf8'))
const packets = readFileSync(new URL('./fixtures/luna-furnace-closed-2026-10-07.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse)
const KEY = saved.planning_states[0].key

function fixture({ stateFile = null, provider } = {}) {
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
        inventories: [{ id: 'source', contents: [] }, { id: 'fuel', contents: [{ name: 'coal', count: 4 }] }],
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
      assert.ok(messages.some(message => String(message.content).includes('"unit_number":12')))
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
    assert.match(reply.content, /BLOCKED:/)
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
    assert.match((await world.agent.handleObservationRequest(world.request(), world.context)).content, /claim_not_persisted/)
    assert.equal(world.game.entityReads, 0)
    const used = fixture()
    used.agent.actionOmissionObservationUsed = true
    assert.match((await used.agent.handleObservationRequest(used.request(), used.context)).content, /already_used/)
    assert.equal(used.game.entityReads, 0)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('busy runtime and unresolved operation ownership forbid targeted reads', async () => {
  for (const pending of [false, true]) {
    const world = fixture()
    if (pending) world.memory.pendingOperation = () => ({ state: 'recorded' })
    else { world.game.taskState = 'mining'; world.game.queueLength = 1 }
    const reply = await world.agent.handleObservationRequest(world.request(), world.context)
    assert.match(reply.content, /runtime_not_idle/)
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
    assert.match((await world.agent.handleObservationRequest(world.request(), world.context)).content, /targeted_allowance_already_used/)
    const restarted = fixture({ stateFile })
    await restarted.agent.loadPersistentState()
    assert.match((await restarted.agent.handleObservationRequest(restarted.request(), restarted.context)).content, /targeted_allowance_already_used/)
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

test('only a new authoritative operation receipt renews the allowance within one step', async () => {
  const world = fixture()
  await world.agent.handleObservationRequest(world.request(), world.context)
  world.agent.resetObservationDecisionState()
  const held = world.agent.targetedObservationIdentity()
  held.plan.execution.receipts[held.step.step_id].push({ kind: 'deterministic_verification', ref: 'unrelated-assessment' })
  assert.match((await world.agent.handleObservationRequest(world.request(), world.context)).content, /already_used/)
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
