import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, planReply } from './task-loop-fixtures.mjs'

const stateBytes = readFileSync(new URL('./fixtures/luna-draft-state-2026-10-07.json', import.meta.url))
const replyBytes = readFileSync(new URL('./fixtures/luna-draft-replies-2026-10-07.json', import.meta.url))
const saved = JSON.parse(stateBytes)
const packets = JSON.parse(replyBytes)
const KEY = saved.planning_states[0].key

function fixture({ stateFile = null } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(saved))
  const state = memory.currentPlan(KEY)
  state.status = 'active'
  memory.recordRunResume(KEY, state, 'scripted_fixture_resume')
  const game = new FakeFactorio({ inventory: { 'stone-furnace': 1, 'iron-plate': 8 } })
  game.status.actor_id = 12
  game.status.epoch = 1
  for (const technology of ['electronics', 'steam-power', 'automation-science-pack', 'logistic-science-pack']) game.knownTechnologies.add(technology)
  let reads = 0
  const command = game.command.bind(game)
  game.command = async text => {
    if (text.includes('get_inventory_items')) { reads++; await game.duringRead?.() }
    return command(text)
  }
  const events = []
  let calls = 0
  const agent = new NpcAgentLoop({ rcon: game, memory, stateFile, traceFile: null, decisionTraceFile: null,
    reserve: async () => ({}), completionProtocolVersion: 2,
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, false)
      const block = messages.find(row => row.content.includes('[CONTROL_DECISION_STATE]'))
      assert.match(block.content, /"phase":"draft"/)
      assert.match(block.content, /"toolsEnabled":false/)
      assert.match(block.content, /"targetedReadEligible":false/)
      return planReply({ plan: state.plan, currentStep: 0, operations: [], stepCompletions: agent.controlDecisionState(false).stepCompletions })
    }, onActivity: (event, data) => events.push({ event, data }),
  })
  agent.active = true
  agent.epoch = { ...game.status }
  agent.requestInfo = { memoryKey: KEY }
  agent.traceRequest = { id: 'req_draft_fixture' }
  agent.observationBudgetRemaining = 0
  agent.observationDecisionForced = true
  agent.turnConversation = agent.agentContext.beginRequest(0)
  const context = { generation: agent.generation, attribution: agent.turnConversation, current: game.status, round: 1, recoveryAttempt: 0 }
  const request = () => {
    const control = agent.controlDecisionState(false)
    return planReply({ plan: state.plan, currentStep: state.current_step, operations: [], stepCompletions: control.stepCompletions,
      observationRequest: { scope: 'draft', goalId: control.goalId, planId: control.planId, planVersion: control.planVersion,
        draftRevision: control.draftRevision, tool: 'getInventoryItems', args: {}, rationale: 'Check held machine count before correcting optional draft action.' } })
  }
  return { agent, memory, game, state, events, context, request, counts: () => ({ reads, calls }) }
}

test('retained draft failure packets and world remain byte-identical evidence', async () => {
  assert.equal(createHash('sha256').update(stateBytes).digest('hex'), '4672198fb9935b3020839f324fa6c72b14caf3dbdf6466cb3c2a70b79a237e64')
  assert.equal(createHash('sha256').update(replyBytes).digest('hex'), '2da858552c207d4622c26f09d86407731295e5b0a9557b877f559666ab663dd3')
  const world = fixture()
  const original = packets.find(row => row.content_preview.includes('"observationRequest"'))
  const message = { content: original.content_preview }
  const reply = await world.agent.handleObservationRequest(message, world.context)
  assert.equal(reply.content, message.content, 'refusal retains all original authored fields')
  assert.equal(reply._sglunaObservationRefusal.reason, 'observation_scope_does_not_match_phase')
  assert.throws(() => world.agent.parsePlanMessage(reply), error => error.code === 'observation_request_refused' && error.failureClass === 'plan_category')
  const final = packets.at(-1)
  assert.match(final.content_preview, /BLOCKED:/)
  assert.equal(await world.agent.handleObservationRequest({ content: final.content_preview }, world.context), undefined)
  assert.deepEqual(world.counts(), { reads: 0, calls: 0 })
  assert.equal(world.agent.targetedObservationIdentity().plan.status, 'DRAFT')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
})

test('planner draft fact read preserves declarations and admits corrected no-action proposal without committing gameplay', async () => {
  const world = fixture()
  const before = structuredClone(world.memory.planningState(KEY))
  const reply = await world.agent.handleObservationRequest(world.request(), world.context)
  const parsed = world.agent.parsePlanMessage(reply)
  assert.deepEqual(parsed.operations, [])
  assert.equal(parsed.stepCompletions.length, 4)
  assert.deepEqual(world.memory.planningState(KEY), before)
  assert.equal(world.game.mutations.length, 0)
  assert.equal(world.counts().calls, 1)
  const grant = world.events.find(row => row.event === 'observation.targeted_granted')
  assert.equal(grant.data.reason, 'one_missing_fact_read_at_draft_authoring_boundary')
  assert.equal(grant.data.scope, 'draft')
  assert.ok(grant.data.request_id)
  const control = world.events.find(row => row.event === 'control.decision_state')
  assert.equal(control.data.tools_enabled, false)
  assert.equal(control.data.reason, 'guidance_matches_effective_tools_and_canonical_phase')
  assert.ok(control.data.request_id)
})

test('draft read rejects stale identities, executor ownership, mixed gameplay and rewritten declarations', async () => {
  for (const change of ['goalId', 'planId', 'planVersion', 'draftRevision', 'executor', 'operation', 'contract', 'completion']) {
    const world = fixture()
    const message = world.request()
    const intent = JSON.parse(message.content)
    if (['goalId', 'planId'].includes(change)) intent.observationRequest[change] += '_old'
    if (['planVersion', 'draftRevision'].includes(change)) intent.observationRequest[change]++
    if (change === 'executor') world.agent.agentContext.role = 'executor'
    if (change === 'operation') intent.operations.push({ name: 'wait', args: { ticks: 1 } })
    if (change === 'contract') intent.stepCompletions[0].checkpoint.requirements[0].technology = 'automation'
    if (change === 'completion') intent.semanticCompletion = { stepId: world.agent.targetedObservationIdentity().data.stepId, rationale: 'close' }
    message.content = JSON.stringify(intent)
    const reply = await world.agent.handleObservationRequest(message, world.context)
    assert.equal(reply.content, message.content)
    assert.ok(reply._sglunaObservationRefusal)
    assert.deepEqual(world.counts(), { reads: 0, calls: 0 })
    assert.equal(world.game.mutations.length, 0)
  }
})

test('read refusal uses bounded category correction, retains draft contracts and continues through planner commitment to executor', async () => {
  const world = fixture()
  world.agent.recordRequirementsFacts({ tick: 42, research: { electronics: {
    trigger: { type: 'craft-item', item: 'copper-plate', count: 1 },
    trigger_crafting: { item: 'copper-plate', recipes: [{ recipe: 'copper-plate', enabled: true, categories: ['smelting'],
      hand_craftable: false, hand_craftable_reason: 'category_unsupported', craftable_now_count: 18,
      machines: [{ entity: 'stone-furnace', item: 'stone-furnace', status: 'craftable' }] }] },
  } } })
  const command = world.game.command.bind(world.game)
  world.game.command = async text => {
    if (text.includes('research_path')) return JSON.stringify({ ok: true, target: 'electronics', nodes: [{
      name: 'electronics', researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item: 'copper-plate', count: 1 },
    }] })
    return command(text)
  }
  let calls = 0
  world.agent.provider = async (messages, context) => {
    calls++
    if (calls === 1) {
      const request = world.request()
      const intent = JSON.parse(request.content)
      intent.observationRequest.draftRevision--
      return planReply(intent)
    }
    if (calls === 2) {
      const correction = messages.findLast(row => row.content.startsWith('[HARNESS]'))
      assert.match(correction.content, /observation_request_refused/)
      assert.match(correction.content, /stepCompletions/)
      assert.doesNotMatch(correction.content, /missing_step_completions/)
      assert.equal(world.agent.agentContext.role, 'planner')
      return planReply({ plan: world.state.plan, currentStep: 0, operations: [], stepCompletions: world.agent.controlDecisionState(false).stepCompletions })
    }
    assert.equal(calls, 3)
    assert.equal(context.role, 'executor', messages.at(-1).content)
    assert.equal(world.agent.targetedObservationIdentity().plan.status, 'COMMITTED')
    const packet = messages.find(row => row.content.includes('research_path (authoritative getResearchPath'))
    assert.ok(packet, 'fresh C3 carries bounded research facts')
    assert.match(packet.content, /"source":"goal_requirements","state":"historical"/)
    assert.match(packet.content, /"tick":42/)
    assert.match(packet.content, /"hand_craftable":false/)
    assert.match(packet.content, /"entity":"stone-furnace"/)
    assert.doesNotMatch(packet.content, /craftable_now_count/)
    return planReply({ plan: world.state.plan, currentStep: 0,
      operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 10, search_radius: 32 } }] })
  }
  const result = await world.agent.runTurn(world.agent.generation)
  assert.equal(calls, 3)
  assert.equal(result.operations[0].name, 'gather_resource')
  assert.equal(world.game.mutations.length, 1)
  assert.equal(world.agent.targetedObservationIdentity().plan.steps[0].completion_contract.requirements[0].technology, 'electronics')
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.equal(world.events.some(row => row.event === 'observation.targeted_refused' && row.data.reason === 'stale_plan_or_step'), true)
  const handoff = world.events.find(row => row.event === 'context.trigger_crafting_handoff')
  assert.equal(handoff.data.reason, 'trigger_capabilities_preserved_as_history_with_unknowns_explicit')
  assert.equal(handoff.data.historical_count, 1)
  assert.ok(handoff.data.request_id)
})

test('draft rewrite, restage and restart do not replenish its persisted allowance', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'luna-draft-'))
  try {
    const stateFile = path.join(dir, 'state.json')
    const world = fixture({ stateFile })
    await world.agent.handleObservationRequest(world.request(), world.context)
    world.agent.resetObservationDecisionState()
    const held = world.agent.targetedObservationIdentity().plan
    held.plan_id += '_revision'
    world.memory.planningState(KEY).active_plan_id = held.plan_id
    held.plan_version++
    held.updated_at++
    const refusal = await world.agent.handleObservationRequest(world.request(), world.context)
    assert.equal(refusal._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
    const restarted = fixture({ stateFile })
    await restarted.agent.loadPersistentState()
    restarted.state.status = 'active'
    assert.equal((await restarted.agent.handleObservationRequest(restarted.request(), restarted.context))._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
    assert.equal(restarted.counts().reads, 0)
  } finally { await fsp.rm(dir, { recursive: true, force: true }) }
})

test('draft revision and handoff changes during native read discard facts before publication', async () => {
  for (const change of ['revision', 'handoff']) {
    const world = fixture()
    world.game.duringRead = () => {
      if (change === 'revision') world.agent.targetedObservationIdentity().plan.updated_at++
      else world.agent.agentContext.conversationSeq++
    }
    await assert.rejects(world.agent.handleObservationRequest(world.request(), world.context), /superseded|stale/i)
    assert.equal(world.counts().calls, 0)
    assert.equal(world.agent.messages.some(row => row.role === 'tool'), false)
    assert.equal(world.agent.toolCache.size, 0)
  }
})

test('supersession while control guidance is traced sends no old input or usage into the newer conversation', async () => {
  const world = fixture()
  const trace = world.agent.traceEvent.bind(world.agent)
  const newerAttribution = { seq: 999, lineage: 999 }
  const newerRequest = { id: 'req_newer', usage: { provider_calls: 0, tool_calls: 0 } }
  world.agent.traceEvent = async (event, ...args) => {
    await trace(event, ...args)
    if (event === 'control.decision_state') {
      world.agent.agentContext.conversationSeq++
      world.agent.generation++
      world.agent.turnConversation = newerAttribution
      world.agent.traceRequest = newerRequest
      world.agent.messages = [{ role: 'user', content: 'newer conversation' }]
    }
  }
  await assert.rejects(world.agent.callProviderRound(world.context.current, world.context.generation, { round: 1, allowTools: false }), /superseded|stale/i)
  assert.equal(world.counts().calls, 0)
  assert.equal(world.agent.turnConversation, newerAttribution)
  assert.equal(world.agent.traceRequest, newerRequest)
  assert.deepEqual(newerRequest.usage, { provider_calls: 0, tool_calls: 0 })
  assert.deepEqual(world.agent.messages, [{ role: 'user', content: 'newer conversation' }])
})
