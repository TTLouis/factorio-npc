import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { getActivePlan } from './planning-state.mjs'
import { providerRequest } from './provider.mjs'
import { configuration, Session } from './supervisor.mjs'
import { MODEL_RECOVERABLE_RESUME_LIMITS } from './pause-class.mjs'
import { FurnaceFactorio, ScriptedModel, recoveryWorld, recoverySession, settle, fireResumeTimer, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/run-q-first-furnace.json', import.meta.url)))
const badReply = JSON.parse(captured.responses.find(row => row.content_chars > 0).preview)
const STEP = captured.committed_steps[0].description
const CHECKPOINT = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'electronics' }] }
const GOAL = { scope: 'finite', summary: 'Smelt ten new copper plates and unlock electronics', doneWhen: [
  { kind: 'research_completed', technology: 'electronics' }, { kind: 'items_produced', item_name: 'copper-plate', minimum: 10 },
] }

// Only admitted placement creates the machine; only supplied ore and fuel can
// produce plates. No test assigns the requested output or research result.
class HeldFurnaceGame extends FurnaceFactorio {
  constructor() {
    super({ inventory: { 'burner-mining-drill': 1, 'stone-furnace': 1, 'iron-plate': 8, coal: 10, 'copper-ore': 10 } })
    this.placed = false
    this.inventoryReads = 0
  }
  nearbySnapshot() { return this.placed ? super.nearbySnapshot() : { actor_position: { x: 0, y: 0 }, entities: [] } }
  entityRead() { return this.placed ? super.entityRead() : { found: false } }
  furnacePreflight(text) {
    if (text.includes("'place_entity'")) {
      assert.match(text, /\['entity_name'\]='stone-furnace'/)
      assert.equal(this.placed, false)
      return { ok: this.inventory['stone-furnace'] === 1 }
    }
    return super.furnacePreflight(text)
  }
  async command(text) {
    if (text.includes('"research_path"')) return JSON.stringify({ ok: true, target: 'electronics', nodes: [{
      name: 'electronics', researched: this.researched.has('electronics'), mode: 'trigger',
      research_trigger: { type: 'craft-item', item: 'copper-plate', count: 10 },
    }] })
    if (text.includes('"get_inventory_items"')) this.inventoryReads++
    const result = await super.command(text)
    if (this.pendingBatch?.operations[0]?.name === 'place_entity') this.lastTaskTypes = ['placing']
    return result
  }
  completeBatch() {
    if (this.pendingBatch?.operations[0]?.name === 'place_entity') {
      assert.equal(this.pendingBatch.operations.length, 1, 'no dependent exact mutation before new identity')
      assert.equal(this.placed, false, 'no placement replay')
      assert.equal(this.inventory['stone-furnace'], 1)
      delete this.inventory['stone-furnace']
      this.placed = true
      this.effects.push({ operation: 'place_entity', item: 'stone-furnace', moved: 1 })
    }
    return super.completeBatch()
  }
  smelt(count) {
    assert.ok(this.placed)
    const done = super.smelt(count)
    this.produced['copper-plate'] = (this.produced['copper-plate'] ?? 0) + done
    if (this.produced['copper-plate'] >= 10) this.researched.add('electronics')
    return done
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new HeldFurnaceGame(); const model = new ScriptedModel(); const wire = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only',
    OPENAI_API_BASEURL: 'https://proxy.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      wire.push({ body, context })
      const reply = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...reply } }],
        usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 } }), { status: 200 })
    },
  })
  const world = recoveryWorld({ game, model, agentRoleConfig: bridge.config,
    roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  const { session, chat, logs } = recoverySession(world)
  const ctx = { t, game, model, wire, world, session, chat, logs }
  ctx.stepId = () => getActivePlan(world.memory.planningState(KEY)).steps[0].step_id
  ctx.action = operations => planReply({ chatMessage: '', stepId: ctx.stepId(), operations })
  ctx.bad = () => ({ content: JSON.stringify({ ...badReply, stepId: ctx.stepId() }) })
  ctx.start = async () => {
    assert.equal(session.queuePlayerRequest('TTLouis', 'Smelt ten new copper plates and unlock electronics'), true)
    await settle(session)
  }
  ctx.planner = () => planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: CHECKPOINT,
    stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }], goal: GOAL })
  // Close the ordinary phase through its real four-read budget before testing
  // the separate closed-round allowance. An open typed read now stays normal.
  ctx.normalReads = () => ({ content: null, tool_calls: [
    ['getActorStatus', {}], ['getInventoryItems', {}],
    ['getNearbyEntities', { radius: 16, limit: 40 }], ['getResearchStatus', {}],
  ].map(([name, args], index) => ({ id: `q-normal-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
  ctx.targeted = () => planReply({ stepId: ctx.stepId(), operations: [], observationRequest: {
    stepId: ctx.stepId(), tool: 'getInventoryItems', args: {}, rationale: 'Need held furnace, ore and fuel before choosing the next operation.',
  } })
  return ctx
}

function control(messages) {
  const text = messages.findLast(row => String(row.content).startsWith('[CONTROL_DECISION_STATE]')).content
  return JSON.parse(text.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
}
function assertClosed(ctx, messages) {
  const state = control(messages)
  assert.equal(state.toolsEnabled, false)
  assert.equal(state.targetedReadEligible, false)
  assert.equal(state.targetedAllowanceUsed, true)
  assert.deepEqual(state.operationSubmission, { channel: 'assistant_json', validation: 'required', grantsAuthority: false })
  const body = ctx.wire.at(-1).body
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.model, 'gpt-6-luna')
  const text = messages.map(row => row.content).join('\n')
  assert.match(text, /Tool closure does not disable gameplay-operation proposals/)
  assert.match(text, /place_entity \{entity_name\} needs neither coordinates nor an existing unit_number/)
  assert.match(text, /after its receipt, obtain a fresh live unit_number/)
  assert.match(text, /normal parsing, preflight and admission still apply/)
}

test('Run Q: C7 resume, one ordinary typed inventory read, closed JSON placement, fresh identity and smelting finish the unchanged goal', async t => {
  const ctx = fixture(t); const { model, world, game } = ctx
  let beforeInventory, unit
  model.push('planner', 'sol:commit', ctx.planner)
    .push('executor', 'luna:captured-unverified-blocker', ctx.bad, 2)
    // A genuine no-action reply enters the existing bounded omission repair;
    // C7 itself starts an ordinary open observation phase.
    .push('executor', 'luna:C7-no-action-enters-repair', () => ctx.action([]))
    .push('executor', 'luna:C7-ordinary-typed-inventory', messages => {
      const state = control(messages)
      assert.equal(state.toolsEnabled, true)
      assert.equal(state.targetedReadEligible, false)
      assert.equal(state.targetedAllowanceUsed, false)
      beforeInventory = game.inventoryReads
      return ctx.targeted()
    })
    .push('executor', 'luna:closed-place-held-furnace', messages => {
      assertClosed(ctx, messages)
      assert.equal(game.inventoryReads, beforeInventory + 1)
      // C7's existing action-omission repair closes after exactly one ordinary
      // read. Its used flag is shared guidance; the closed-read ledger is not
      // consumed by the open JSON observationRequest transport.
      assert.equal(world.agent.actionOmissionObservationUsed, true)
      assert.equal(world.agent.actionOmissionForceNoTools, true)
      assert.equal(world.agent.closedRoundObservationUsed, false)
      assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
      assert.equal(game.placed, false)
      assert.equal(world.memory.planningState(KEY).goal.status, 'active')
      return ctx.action([{ name: 'place_entity', args: { entity_name: 'stone-furnace' } }])
    })
    .push('executor', 'luna:observe-new-furnace', () => ({ content: null, tool_calls: [
      { id: 'fresh-furnace', type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', radius: 16 }) } },
    ] }))
    .push('executor', 'luna:supply-fresh-furnace', messages => {
      const observed = JSON.parse(messages.findLast(row => row.role === 'tool').content)
      unit = observed.entity.unit_number
      assert.ok(unit > 0)
      return ctx.action([{ name: 'supply_entity', args: { unit_number: unit,
        items: [{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 10 }] } }])
    })
  await ctx.start()
  assert.equal(game.sent.length, 0, 'unsupported captured blocker admitted nothing')
  assert.ok(ctx.session.modelResume?.timer)
  const committed = getActivePlan(world.memory.planningState(KEY))
  const identity = { planId: committed.plan_id, version: committed.plan_version, stepId: committed.steps[0].step_id, contract: structuredClone(committed.steps[0].completion_contract) }
  await fireResumeTimer(ctx)
  assert.ok(world.trace.some(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7'))
  assert.equal(game.sent.length, 1, JSON.stringify({ violations: model.violations, remaining: model.remaining,
    logs: world.agentLogs.slice(-8), observations: world.trace.filter(row => /observation|action_omission|provider.error/.test(row.event)).slice(-8) }))
  assert.equal(game.placed, false, 'admission alone is not native completion')
  await completeAndReport(ctx)
  assert.equal(game.placed, true)
  assert.equal(game.sent.length, 2)
  assert.equal(game.sent[1].operations[0].args.unit_number, unit)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active', 'placement and supply admission cannot satisfy electronics')
  const after = getActivePlan(world.memory.planningState(KEY))
  assert.equal(after.plan_id, identity.planId)
  assert.equal(after.plan_version, identity.version)
  assert.equal(after.steps[0].step_id, identity.stepId)
  assert.deepEqual(after.steps[0].completion_contract, identity.contract)
  await completeAndReport(ctx, { smelt: 10 })
  assert.equal(game.furnace.output['copper-plate'], 10)
  assert.equal(game.produced['copper-plate'], 10)
  assert.ok(game.researched.has('electronics'))
  assert.equal(game.inventory['copper-ore'], undefined)
  assert.equal(game.inventory.coal, 5)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(world.named('goal.evaluated').at(-1).results.map(row => [row.kind, row.satisfied]), [['research_completed', true], ['items_produced', true]])
  assert.equal(world.named('step.verified').at(-1).source, 'deterministic_completion_contract')
  assert.equal(world.named('step.verified').at(-1).task_board.status, 'completed')
  assert.equal(world.memory.currentPlan(KEY), undefined, 'verified final goal is finalized')
  assert.equal(world.memory.planningState(KEY).goal, null)
  assert.equal(world.named('observation.targeted_granted').length, 0)
  assert.equal(world.memory.targetedObservationLedger?.size ?? 0, 0)
  const ordinaryRead = world.named('observation.normal_from_control')
  assert.equal(ordinaryRead.length, 1)
  assert.ok(ordinaryRead[0].request_id)
  assert.equal(ordinaryRead[0].reason, 'normal_tools_available_use_existing_observation_budget')
  assert.equal(ordinaryRead[0].tool, 'getInventoryItems')
  const repairRead = world.named('recovery.action_omission_observation_complete')
  assert.equal(repairRead.length, 1)
  assert.equal(repairRead[0].observation, 'getInventoryItems')
  assert.equal(repairRead[0].tools_enabled_next_round, false)
  assert.equal(world.named('recovery.auto_resume_started').length, 1)
  const closed = world.named('control.decision_state').filter(row => !row.tools_enabled && row.operation_submission?.channel === 'assistant_json')
  assert.ok(closed.length > 0)
  for (const row of closed) {
    assert.ok(row.request_id)
    assert.equal(row.reason, 'guidance_matches_effective_tools_and_canonical_phase')
    assert.equal(row.operation_submission.validation, 'required')
    assert.equal(row.operation_submission.grantsAuthority, false)
  }
  assert.equal(ctx.wire[0].body.model, 'gpt-6.1-sol')
  assert.deepEqual(model.violations, [])
  assert.deepEqual(model.remaining, [])
  assert.deepEqual(game.unknown, [])
  assert.equal(game.sent.length, 2, 'placement and supply never replayed')
})

test('Run Q exact blocker remains rejected and two step resumes cannot create a machine or waive the checkpoint', async t => {
  const ctx = fixture(t); const { model, game, world } = ctx
  assert.match(badReply.chatMessage, /tools are closed so I cannot place it/)
  model.push('planner', 'sol:commit', ctx.planner).push('executor', 'luna:captured-blocker', ctx.bad, 4)
  await ctx.start()
  await fireResumeTimer(ctx)
  await fireResumeTimer(ctx)
  assert.equal(ctx.session.modelResume, null)
  assert.ok(world.named('recovery.auto_resume_exhausted').length > 0)
  assert.deepEqual(MODEL_RECOVERABLE_RESUME_LIMITS, { per_step: 2, per_goal: 6 })
  assert.equal(world.memory.autoResumeAllowance(KEY).step_attempts, 2)
  assert.equal(world.memory.autoResumeAllowance(KEY).goal_attempts, 2)
  assert.equal(game.sent.length, 0)
  assert.equal(game.placed, false)
  assert.equal(game.produced['copper-plate'], undefined)
  assert.equal(world.memory.planningState(KEY).goal.status, 'active')
  assert.ok(world.trace.some(row => JSON.stringify(row).includes('world_blocked_without_authoritative_evidence')))
  assert.deepEqual(model.violations, [])
  assert.deepEqual(model.remaining, [])
})

for (const boundary of ['stop', 'epoch']) test(`Run Q closed proposal after ${boundary} cannot reach admission`, async t => {
  const ctx = fixture(t); const { model, world, game } = ctx
  let boundaryReached = false
  model.push('planner', 'sol:commit', ctx.planner)
    .push('executor', 'luna:close-normal-budget', ctx.normalReads)
    .push('executor', 'luna:targeted', ctx.targeted)
    .push('executor', 'luna:stale-closed-placement', async messages => {
      assertClosed(ctx, messages)
      boundaryReached = true
      const reply = ctx.action([{ name: 'place_entity', args: { entity_name: 'stone-furnace' } }])
      if (boundary === 'stop') world.agent.cancel('fixture_stop')
      else game.status.epoch++
      return reply
    })
  await ctx.start()
  assert.equal(boundaryReached, true, 'the cancellation fence must be exercised after a valid closed wire request')
  assert.equal(game.sent.length, 0)
  assert.equal(game.placed, false)
  assert.equal(game.inventory['stone-furnace'], 1)
  assert.notEqual(world.memory.planningState(KEY).goal.status, 'completed')
  assert.deepEqual(model.violations, [])
  assert.deepEqual(model.remaining, [])
})
