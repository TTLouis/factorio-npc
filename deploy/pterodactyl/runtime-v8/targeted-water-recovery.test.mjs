import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { executorProviderToolDefinitions } from './structured-policy.mjs'
import { normalizeObservationRequest } from './targeted-observation.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY, assertStrictBoundary } from './recovery-loop-fixtures.mjs'
import { ShorelineGame, POWER_CHECKPOINT, shorelineDecisionScript, search, decision, walk, finishShoreline, RUN_M_SEARCHES } from './shoreline-recovery-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/run-r-shoreline.json', import.meta.url)))
const saved = JSON.parse(await fs.readFile(new URL('./fixtures/luna-furnace-state-2026-10-07.json', import.meta.url)))
const malformed = JSON.parse(captured.provider_replies.find(row => row.content_preview?.includes('"entity_exists"')).content_preview)
const blocked = JSON.parse(captured.provider_replies.findLast(row => row.content_preview?.includes('BLOCKED:')).content_preview)
const WATER = { tool: 'getFluidSourceTiles', args: { fluid_name: 'water', search_radius: 256, limit: 8 } }
const control = messages => JSON.parse(messages.findLast(row => String(row.content).startsWith('[CONTROL_DECISION_STATE]')).content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))

class WaterGame extends ShorelineGame {
  constructor() { super(); this.waterReads = 0 }
  async command(text) {
    if (text.includes('"get_fluid_source_tiles"')) { this.waterReads++; await this.duringWater?.() }
    return super.command(text)
  }
}

async function loop(t, { afterWater, afterMalformed, corrections, stateFile = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new WaterGame(), model = new ScriptedModel(), wire = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only',
    OPENAI_API_BASEURL: 'https://proxy.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); wire.push({ body, context })
      const message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 3000, completion_tokens: 150, total_tokens: 3150 } }), { status: 200 })
    },
  })
  const world = recoveryWorld({ game, model, stateFile, decisionScript: shorelineDecisionScript, agentRoleConfig: bridge.config,
    roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  const ctx = { t, game, model, world, wire, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  const stepId = () => getActivePlan(world.memory.planningState(KEY)).steps[0].step_id
  const exactReply = reply => ({ content: JSON.stringify({ ...reply, stepId: stepId() }) })
  model.push('planner', 'sol:commit-powered-lab', decision([], { checkpoint: POWER_CHECKPOINT,
    stepCompletions: [{ kind: 'deterministic', checkpoint: POWER_CHECKPOINT }],
    goal: { scope: 'finite', summary: 'Build powered lab and hold one red pack', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 }] },
  })).push('executor', 'luna:four-normal-reads', async () => {
    const planning = world.memory.planningState(KEY)
    // Prior exhausted campaign history is a fixture input, not a reset or a
    // new recovery grant. The normal targeted fact must work without a resume.
    planning.run.auto_resume = { goal_id: planning.goal.goal_id, goal_total: 6, steps: [] }
    assert.equal(world.memory.claimFreshContextRecovery(KEY, { requestId: 'prior-run-r' }), true)
    await world.agent.persistState()
    return { content: null, tool_calls: [
      ['getActorStatus', {}], ['getInventoryItems', {}], ['getNearbyEntities', { radius: 24, limit: 40 }],
      ['getPlacementCandidates', { entity_name: 'offshore-pump', radius: 24, limit: 4 }],
    ].map(([name, args], i) => ({ id: `run-r-${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }
  }).push('executor', 'luna:captured-malformed-checkpoint', () => exactReply(malformed))
    .push('executor', 'luna:targeted-water-with-tools-closed', async (messages, context) => {
      const state = control(messages)
      assert.equal(context.allowTools, false)
      assert.equal(wire.at(-1).body.tool_choice, 'none')
      assert.equal(state.targetedReadEligible, true); assert.equal(state.targetedAllowanceUsed, false)
      assert.deepEqual(state.targetedWaterSearch, WATER)
      assert.equal(game.waterReads, 0, 'pump-only search must not auto-read water')
      assert.equal(game.sent.length, 0, 'malformed checkpoint batch was refused, not salvaged')
      assert.equal(world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
      await afterMalformed?.(ctx)
      return planReply({ stepId: stepId(), operations: [], observationRequest: { stepId: stepId(), ...WATER,
        rationale: 'Need native water coverage after this exact local pump search found no legal site.' } })
    }).push('executor', 'luna:captured-local-blocker-after-one-water-fact', async (messages, context) => {
      assert.equal(context.allowTools, false)
      assert.equal(game.waterReads, 1)
      const state = control(messages)
      assert.equal(state.targetedAllowanceUsed, true); assert.equal(state.targetedReadEligible, false)
      assert.equal(state.targetedWaterSearch, undefined)
      assert.equal(world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
      const water = JSON.parse(messages.findLast(row => row.role === 'tool').content)
      assert.equal(water.coverage_complete, false)
      assert.ok(water.ungenerated_chunks.some(row => JSON.stringify(row.center) === JSON.stringify(walk.args)))
      await afterWater?.(ctx)
      return exactReply(blocked)
    })
  for (const [label, reply] of corrections ?? [['luna:choose-native-frontier', (messages, context) => {
    assert.equal(context.allowTools, false)
    assert.ok(messages.some(row => row.content?.includes('[LOCAL_FLUID_SEARCH_RECOVERY]')))
    assert.equal(game.sent.length, 0)
    return decision([walk])
  }]]) model.push('executor', label, reply)
  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'Build powered lab and craft one red pack'), true)
  await settle(ctx.session)
  return ctx
}

test('Run R full serialized loop: spent six resumes, pump-only absence, one targeted water fact, native-frontier walk, fresh discovery and verified powered result', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'targeted-water-loop-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'state.json')
  const ctx = await loop(t, { stateFile })
  assert.equal(ctx.game.sent.length, 1, 'only the model-selected walk is admitted')
  assert.equal(ctx.game.explored, false, 'admission is not arrival')
  assert.equal(ctx.game.waterReads, 1)
  const grant = ctx.world.named('observation.targeted_water_search')
  assert.equal(grant.length, 1); assert.ok(grant[0].request_id)
  assert.equal(grant[0].reason, 'fresh_empty_pump_search_needs_water_coverage')
  assert.equal(grant[0].search_radius, 256); assert.equal(grant[0].limit, 8)
  assert.equal(ctx.world.named('observation.targeted_granted').length, 1)
  assert.equal(ctx.world.named('recovery.local_fluid_search_blocker_rejected').length, 1)
  assert.equal(ctx.world.named('recovery.classified').at(-1).retry_limit, 3)
  const held = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  // Every following provider call asserts the durable campaign was never reset.
  const provide = ctx.model.provide.bind(ctx.model)
  ctx.model.provide = async (...args) => {
    assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    assert.equal(persisted.planning_states.find(row => row.key === KEY).state.run.auto_resume.goal_total, 6)
    return provide(...args)
  }
  await finishShoreline(ctx, { expectedSteps: held })
  assert.equal(ctx.game.powered, true)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.world.memory.currentPlan(KEY), undefined)
  assert.deepEqual(ctx.world.named('recovery.auto_resume_started'), [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.equal(ctx.wire[0].body.model, 'gpt-6.1-sol')
  assert.ok(ctx.wire.slice(1).every(row => row.body.model === 'gpt-6-luna'))
  assertStrictBoundary(ctx)
})

// A focused direct boundary for negative provenance/ledger tests. The full loop
// above and the native lane separately prove admission and physical effects.
function boundary({ stateFile = null, pumpArgs, pumpResult } = {}) {
  const memory = new CanonicalTaskBoardMemory(); memory.restore(structuredClone(saved))
  const key = saved.planning_states[0].key, state = memory.currentPlan(key)
  state.status = 'active'; memory.recordRunResume(key, state, 'fixture_resume')
  const game = new WaterGame(); game.status.actor_id = 6; game.status.epoch = 1
  let calls = 0
  const agent = new NpcAgentLoop({ rcon: game, memory, stateFile, traceFile: null, decisionTraceFile: null,
    reserve: async () => ({}), completionProtocolVersion: 2,
    provider: async () => { calls++; return planReply({ plan: state.plan, currentStep: state.current_step, operations: [walk] }) },
  })
  const events = []; agent.behaviorTrace = { emit: async row => { events.push(row) } }
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: key }
  agent.traceRequest = { id: 'req_targeted_water_boundary' }
  agent.observationBudgetRemaining = 0; agent.observationDecisionForced = true
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.recordHandoffToolFacts('getPlacementCandidates', JSON.stringify(pumpResult ?? RUN_M_SEARCHES[1].result),
    pumpArgs ?? { entity_name: 'offshore-pump', radius: 24, limit: 4 })
  const context = { generation: agent.generation, attribution: agent.turnConversation, current: game.status, round: 1, recoveryAttempt: 0 }
  const request = extra => planReply({ plan: state.plan, currentStep: state.current_step, operations: [], observationRequest: {
    stepId: agent.targetedObservationIdentity().data.stepId, ...WATER, rationale: 'Need bounded water coverage after the empty native pump search.', ...extra,
  } })
  return { agent, game, memory, key, context, request, events, calls: () => calls }
}

test('water request grammar and provider schema expose the same bounded water fact', () => {
  const request = { stepId: 'step-current', ...WATER, rationale: 'Water coverage is missing.' }
  assert.deepEqual(normalizeObservationRequest(request), request)
  const schema = executorProviderToolDefinitions.find(row => row.function.name === 'submitPlan').function.parameters.properties.observationRequest
  assert.ok(schema.properties.tool.enum.includes('getFluidSourceTiles'))
  assert.match(schema.description, /SAME one-read allowance/)
  for (const args of [ { ...WATER.args, center: { x: 0, y: 0 } }, { ...WATER.args, fluid_name: 'oil' },
    { ...WATER.args, search_radius: 257 }, { ...WATER.args, search_radius: 0 }, { ...WATER.args, limit: 9 },
    { fluid_name: 'water', search_radius: 256 }, { ...WATER.args, search_radius: 1.5 } ]) {
    assert.throws(() => normalizeObservationRequest({ ...request, args }), /Targeted water coverage/)
  }
  assert.throws(() => normalizeObservationRequest({ ...request, scope: 'draft', goalId: 'g', planId: 'p', planVersion: 1, draftRevision: 0, stepId: undefined }), /Unexpected|Targeted water/)
})

test('water fact refuses absent, forged, stale, off-center and mismatched negative pump provenance without reading', async () => {
  for (const change of ['absent', 'old', 'future', 'request', 'actor', 'epoch', 'goal', 'plan', 'step', 'mutation', 'off-center', 'positive', 'forged-radius', 'malformed']) {
    const world = boundary()
    const row = world.agent.localPumpSearchObservation
    if (change === 'absent') world.agent.localPumpSearchObservation = undefined
    else if (change === 'old') row.scope.at -= 120001
    else if (change === 'future') row.scope.at += 120001
    else if (change === 'mutation') world.agent.noteWorldMutation()
    else if (change === 'off-center') world.agent.recordHandoffToolFacts('getPlacementCandidates', JSON.stringify(RUN_M_SEARCHES[1].result), { entity_name: 'offshore-pump', radius: 24, center: { x: 0, y: 0 } })
    else if (change === 'positive') world.agent.recordHandoffToolFacts('getPlacementCandidates', JSON.stringify({ ...RUN_M_SEARCHES[1].result, legal_candidate_count: 1 }), { entity_name: 'offshore-pump', radius: 24 })
    else if (change === 'forged-radius') world.agent.recordHandoffToolFacts('getPlacementCandidates', JSON.stringify({ ...RUN_M_SEARCHES[1].result, radius: 23 }), { entity_name: 'offshore-pump', radius: 24 })
    else if (change === 'malformed') world.agent.recordHandoffToolFacts('getPlacementCandidates', 'not-json', { entity_name: 'offshore-pump', radius: 24 })
    else row.scope[{ request: 'requestId', actor: 'actorId', epoch: 'epoch', goal: 'goalId', plan: 'planId', step: 'stepId' }[change]] = 'stale'
    assert.equal(world.agent.controlDecisionState(false).targetedWaterSearch, undefined, change)
    const result = await world.agent.handleObservationRequest(world.request(), world.context)
    assert.equal(result._sglunaObservationRefusal.reason, 'water_search_requires_fresh_empty_actor_centered_pump_search', change)
    assert.equal(world.game.waterReads, 0); assert.equal(world.calls(), 0); assert.equal(world.game.sent.length, 0)
  }
})

test('one water fact consumes the same durable ledger; restaging and restart cannot mint another read', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'targeted-water-ledger-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'state.json')
  const world = boundary({ stateFile })
  assert.deepEqual(world.agent.controlDecisionState(false).targetedWaterSearch, WATER)
  const before = structuredClone(world.memory.planningState(world.key))
  const reply = await world.agent.handleObservationRequest(world.request(), world.context)
  assert.equal(reply._sglunaObservationRefusal, undefined)
  assert.equal(world.agent.parsePlanMessage(reply).operations[0].name, 'walk_to_position')
  assert.equal(world.game.waterReads, 1); assert.equal(world.calls(), 1); assert.equal(world.game.sent.length, 0)
  assert.deepEqual(world.memory.planningState(world.key), before)
  assert.equal(world.agent.observationBudgetRemaining, 0)
  assert.equal(world.agent.observationDecisionForced, true)
  assert.equal(world.agent.controlDecisionState(false).targetedWaterSearch, undefined)
  assert.equal((await world.agent.handleObservationRequest(world.request({ tool: 'getInventoryItems', args: {} }), world.context))._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
  world.agent.resetObservationDecisionState()
  assert.equal((await world.agent.handleObservationRequest(world.request(), world.context))._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
  const restarted = boundary({ stateFile }); await restarted.agent.loadPersistentState()
  assert.equal((await restarted.agent.handleObservationRequest(restarted.request(), restarted.context))._sglunaObservationRefusal.reason, 'targeted_allowance_already_used')
  assert.equal(restarted.game.waterReads, 0)
})

for (const change of ['stop', 'epoch', 'request', 'mutation']) test(`water read ${change} fence consumes its allowance and publishes no stale result`, async () => {
  const world = boundary()
  world.game.duringWater = () => {
    if (change === 'stop') world.agent.cancel('fixture_stop')
    else if (change === 'epoch') world.game.status.epoch++
    else if (change === 'request') world.agent.traceRequest.id = 'superseded'
    else world.agent.noteWorldMutation()
  }
  await assert.rejects(world.agent.handleObservationRequest(world.request(), world.context), /cancelled|superseded|epoch changed/i)
  assert.equal(world.game.waterReads, 1); assert.equal(world.calls(), 0)
  assert.equal(world.game.sent.length, 0)
  assert.equal(world.agent.toolCache.size, 0)
  assert.ok(!world.agent.messages.some(row => row.role === 'tool'))
  assert.equal(world.memory.targetedObservationLedger.size, 1, 'interruptions never refund the claim')
})

for (const change of ['stop', 'epoch']) test(`Run R ${change} while choosing the exploration action admits nothing`, async t => {
  let reached = false
  let ctxRef
  const ctx = await loop(t, { corrections: [['pending-explore', async () => {
    reached = true
    if (change === 'stop') ctxRef.world.agent.cancel('fixture_stop')
    else ctxRef.game.status.epoch++
    return decision([walk])
  }]], afterWater: ctx => { ctxRef = ctx } })
  assert.equal(reached, true)
  assert.equal(ctx.game.sent.length, 0); assert.equal(ctx.game.explored, false)
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual(ctx.model.remaining, [])
})

test('repeated Run R local blockers retain the existing category and six-goal caps', async t => {
  const ctx = await loop(t, { corrections: Array.from({ length: 2 }, (_, i) => [`blocked-${i}`, () => decision([], { chatMessage: blocked.chatMessage })]) })
  assert.equal(ctx.world.named('recovery.classified').at(-1).retry_limit, 3)
  assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
  assert.equal(ctx.game.sent.length, 0); assert.equal(ctx.game.waterReads, 1)
  assert.deepEqual(ctx.world.named('recovery.auto_resume_started'), [])
  assert.deepEqual(ctx.model.remaining, []); assert.deepEqual(ctx.model.violations, [])
})
