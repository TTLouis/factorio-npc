import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { getActivePlan } from './planning-state.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY, assertStrictBoundary } from './recovery-loop-fixtures.mjs'
import { ShorelineGame, POWER_CHECKPOINT, shorelineDecisionScript, decision, finishShoreline, waterRead } from './shoreline-recovery-fixtures.mjs'

const capture = JSON.parse(await fs.readFile(new URL('./fixtures/run-v-shoreline.json', import.meta.url)))
const saved = JSON.parse(await fs.readFile(new URL('./fixtures/luna-furnace-state-2026-10-07.json', import.meta.url)))
const frontier = capture.water.result.ungenerated_chunks[0].center
const walk = { name: 'walk_to_position', args: { ...frontier } }
class RunVGame extends ShorelineGame {
  constructor() {
    super(); this.position = { ...capture.water.result.actor_position }; this.waterReads = 0; this.pumpReads = 0
    this.discoveryCenter = frontier
    this.placementOps = this.placementOps.map((op, i) => ({ ...op, args: { ...op.args, x: frontier.x + i * 3, y: frontier.y - 28 } }))
  }
  fluid(radius) { return this.explored ? super.fluid(radius) : structuredClone(capture.water.result) }
  async command(text) {
    if (text.includes('"get_fluid_source_tiles"')) this.waterReads++
    if (text.includes('"get_placement_candidates"')) this.pumpReads++
    return super.command(text)
  }
}

async function begin(t, { interrupt, repeat = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new RunVGame(); const model = new ScriptedModel(); const wire = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', AI_API_METHOD: 'cli-proxy',
    OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://proxy.example.test/v1', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); wire.push({ body, context })
      const message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 3000, completion_tokens: 150, total_tokens: 3150 } }))
    } })
  const world = recoveryWorld({ game, model, decisionScript: shorelineDecisionScript, agentRoleConfig: bridge.config,
    roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  const ctx = { t, game, model, world, wire, corrections: 0, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  const blocked = () => ({ content: JSON.stringify({ ...JSON.parse(capture.replies[0].reply),
    stepId: getActivePlan(world.memory.planningState(KEY)).steps[0].step_id }) })
  model.push('planner', 'sol:immutable-power-result', decision([], { checkpoint: POWER_CHECKPOINT,
    stepCompletions: [{ kind: 'deterministic', checkpoint: POWER_CHECKPOINT }],
    goal: { scope: 'finite', summary: 'Build powered lab and hold one red pack', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 }] } }))
    .push('executor', 'luna:only-native-water-read', async () => {
      world.memory.planningState(KEY).run.auto_resume = { goal_id: world.memory.planningState(KEY).goal.goal_id, goal_total: 6, steps: [] }
      return waterRead(128)
    }).push('executor', 'luna:exact-run-v-unsupported-blocker', blocked)
  for (let i = 0; i < (repeat ? 3 : 1); i++) model.push('executor', `luna:bounded-correction-${i}`, (messages, context) => {
    assert.ok(messages.some(row => String(row.content).includes('[LOCAL_FLUID_SEARCH_RECOVERY]')), 'expected bounded local-fluid correction')
    assert.equal(game.waterReads, 1); assert.equal(game.pumpReads, 0)
    assert.equal(game.sent.length, 0); assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
    assert.equal(world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
    assert.ok(messages.some(row => String(row.content).includes(String(frontier.x))))
    ctx.corrections++
    if (interrupt === 'stop') world.agent.cancel('fixture_stop')
    if (interrupt === 'epoch') game.status.epoch++
    if (repeat) return blocked()
    assert.equal(wire.at(-1).body.model, 'gpt-6-luna')
    assert.equal(wire.at(-1).body.tool_choice, context.allowTools ? 'auto' : 'none')
    return decision([walk])
  })
  ctx.session.queuePlayerRequest('TTLouis', 'Build powered lab and craft one red pack')
  await settle(ctx.session)
  return ctx
}

test('Run V serialized water-only loop rejects local world blocker, explores native center and verifies powered continuation without a resume', async t => {
  const ctx = await begin(t)
  const rejection = ctx.world.named('recovery.local_fluid_search_blocker_rejected')[0]
  assert.ok(rejection, JSON.stringify({ waterReads: ctx.game.waterReads, labels: ctx.model.labels, remaining: ctx.model.remaining, violations: ctx.model.violations, logs: ctx.logs, trace: ctx.world.trace.filter(row => /tool\.|observation\.|recovery\.|request.failed/.test(row.event)).slice(-12) }))
  assert.equal(rejection.basis, 'water_only'); assert.ok(rejection.request_id)
  assert.equal(rejection.pump_search, undefined)
  assert.equal(rejection.water_search.ungenerated_chunk_count, 9)
  assert.deepEqual(rejection.water_search.exploration_centers, capture.water.result.ungenerated_chunks.map(c => c.center))
  assert.equal(ctx.game.sent.length, 1, JSON.stringify({ logs: ctx.logs, agentLogs: ctx.world.agentLogs, labels: ctx.model.labels })); assert.equal(ctx.game.explored, false, 'admission is not a movement receipt')
  const steps = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  const provide = ctx.model.provide.bind(ctx.model)
  ctx.model.provide = (...args) => {
    assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, 6, 'continuations cannot reset the active campaign allowance')
    return provide(...args)
  }
  await finishShoreline(ctx, { expectedSteps: steps })
  assert.deepEqual(ctx.game.position, frontier)
  assert.equal(ctx.game.waterReads, 2); assert.equal(ctx.game.pumpReads, 1, 'placement discovery occurs only after movement')
  assert.equal(ctx.game.powered, true); assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(ctx.world.named('recovery.auto_resume_started'), [])
  assertStrictBoundary(ctx)
})

for (const interrupt of ['stop', 'epoch']) test(`Run V ${interrupt} fences the pending water-only correction`, async t => {
  const ctx = await begin(t, { interrupt })
  assert.equal(ctx.corrections, 1, 'the interruption must occur inside the exploration correction')
  assert.equal(ctx.game.sent.length, 0); assert.equal(ctx.game.explored, false)
  assert.equal(ctx.game.waterReads, 1); assert.equal(ctx.game.pumpReads, 0)
  assert.deepEqual(ctx.model.remaining, [], JSON.stringify({ logs: ctx.logs, labels: ctx.model.labels })); assert.deepEqual(ctx.model.violations, [])
})

test('repeated water-only blockers use the existing category cap, never additional reads or goal resumes', async t => {
  const ctx = await begin(t, { repeat: true })
  assert.equal(ctx.world.named('recovery.classified').at(-1).retry_limit, 3)
  assert.equal(ctx.game.sent.length, 0); assert.equal(ctx.game.waterReads, 1); assert.equal(ctx.game.pumpReads, 0)
  assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
  assert.deepEqual(ctx.world.named('recovery.auto_resume_started'), [])
  assert.deepEqual(ctx.model.remaining, []); assert.deepEqual(ctx.model.violations, [])
})

function boundary() {
  const memory = new CanonicalTaskBoardMemory(); memory.restore(structuredClone(saved))
  const key = saved.planning_states[0].key; const state = memory.currentPlan(key)
  state.status = 'active'; memory.recordRunResume(key, state, 'fixture_resume')
  const game = new RunVGame()
  const agent = new NpcAgentLoop({ rcon: game, memory, traceFile: null, decisionTraceFile: null, reserve: async () => ({}), provider: async () => { throw Error('no provider expected') } })
  agent.active = true; agent.epoch = { ...game.status }; agent.requestInfo = { memoryKey: key }; agent.traceRequest = { id: 'req-v' }
  const events = []; agent.behaviorTrace = { emit: async row => events.push(row) }
  agent.recordHandoffToolFacts('getFluidSourceTiles', JSON.stringify(capture.water.result), capture.water.args)
  return { agent, memory, key, events }
}

test('water-only correction requires fresh exact native scope and no pending or uncertain effects', async () => {
  for (const change of ['valid', 'old', 'future', 'requestId', 'goalId', 'planId', 'stepId', 'actorId', 'epoch', 'seq', 'absent', 'pending', 'uncertain', 'batch']) {
    const ctx = boundary(); const row = ctx.agent.localFluidSearchObservation
    if (change === 'old') row.scope.at -= 120001
    else if (change === 'future') row.scope.at += 120001
    else if (change === 'absent') ctx.agent.localFluidSearchObservation = undefined
    else if (change === 'pending') ctx.memory.pendingOperation = () => ({ state: 'admitted' })
    else if (change === 'uncertain') ctx.memory.currentPlan(ctx.key).admission_status = 'admission_failed'
    else if (change === 'batch') ctx.agent.batchInFlight = true
    else if (change !== 'valid') row.scope[change] = 'other'
    const check = () => ctx.agent.validateLocalFluidSearchBlocker({ operations: [], chatMessage: 'BLOCKED: No legal shoreline.' })
    if (change === 'valid') await assert.rejects(check, /LOCAL_FLUID_SEARCH_RECOVERY/)
    else await assert.doesNotReject(check, change)
    assert.equal(ctx.events.length, change === 'valid' ? 1 : 0)
  }
})

test('malformed, conclusive and positive water cannot become negative exploration facts; a foreign pump is omitted', async () => {
  for (const patch of [{ coverage_complete: true }, { returned_count: 1, samples: [{ position: frontier }] },
    { empty_result_is_conclusive: true }, { ungenerated_chunks: [] }]) {
    const ctx = boundary()
    ctx.agent.recordHandoffToolFacts('getFluidSourceTiles', JSON.stringify({ ...capture.water.result, ...patch }), capture.water.args)
    await ctx.agent.validateLocalFluidSearchBlocker({ operations: [], chatMessage: 'BLOCKED: Water absent.' })
    assert.equal(ctx.events.length, 0)
  }
  const ctx = boundary()
  ctx.agent.localPumpSearchObservation = { scope: structuredClone(ctx.agent.localFluidSearchObservation.scope),
    fact: { center: { x: 999, y: 999 }, legal_candidate_count: 0 } }
  await assert.rejects(() => ctx.agent.validateLocalFluidSearchBlocker({ operations: [], chatMessage: 'BLOCKED: Water absent.' }), /LOCAL_FLUID_SEARCH_RECOVERY/)
  assert.equal(ctx.events[0].data.pump_search, undefined)
  assert.equal(ctx.events[0].data.basis, 'water_only')
})
