import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { getActivePlan } from './planning-state.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { transferSupplyRecoveryCount } from './npc-agent-loop.mjs'
import { FurnaceFactorio, ScriptedModel, recoveryWorld, recoverySession, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/run-s-target-reacquisition.json', import.meta.url)))
const LEGACY = captured.events.findLast(row => row.event === 'operations.preflight_ok').data.operations.map(({ name, args }) => ({ name, args }))
const STEP = 'Smelt ten copper plates in the placed furnace and unlock electronics'
const CHECKPOINT = { mode: 'all', requirements: [{ id: 'electronics', kind: 'research_completed', technology: 'electronics' }] }
const GOAL = { scope: 'finite', summary: STEP, doneWhen: [
  { kind: 'research_completed', technology: 'electronics' }, { kind: 'items_produced', item_name: 'copper-plate', minimum: 10 },
] }
const WALK = { name: 'walk_to_position', args: { x: 11, y: -62 } }
const tool = (name, args = {}) => ({ content: null, tool_calls: [{ id: `fresh-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })

test('captured Run S distinguishes local absence, actual pending uncertainty and the runner terminal-state gap', () => {
  const status = captured.events.findLast(row => row.event === 'factorio.status').data.task_status
  assert.equal(status.last_cancelled_batch.reason, 'moving_items:no_target')
  assert.equal(status.last_cancelled_batch.failed_before_mutation, undefined)
  assert.deepEqual(status.basic_operation.last_result, {
    operation_id: 4, type: 'moving_items', accepted: false, completed: false, code: 'no_target', tick: 14515,
    actor_id: 3, actor_kind: 'standalone_character', force_index: 1, entity_name: 'stone-furnace',
    item_name: 'copper-ore', requested_count: 10, to_entity: true,
  })
  const reconciliation = captured.events.findLast(row => row.event === 'operation.reconciled').data
  assert.equal(reconciliation.verdict, 'admitted_cancelled'); assert.equal(reconciliation.effect, 'partial_unknown')
  assert.equal(reconciliation.settled, false)
  assert.equal(captured.canonical_plan_before_operator_stop.status, 'BLOCKED')
  assert.equal(captured.canonical_run_before_operator_stop.paused, false)
})

class RemoteFurnaceGame extends FurnaceFactorio {
  constructor({ proof = true, prefix = false } = {}) {
    super({ inventory: { 'iron-plate': 8, coal: 10, 'copper-ore': 10 }, furnace: { unit_number: 10, position: { x: 11, y: -62 } } })
    this.position = { x: 6.5390625, y: -101.4140625 }
    this.proof = proof; this.prefix = prefix; this.destroyed = false
    this.receiptOverride = undefined
  }
  nearbySnapshot() {
    const distance = Math.hypot(this.position.x - 11, this.position.y + 62)
    return { actor_position: this.position, entities: distance <= 20 && !this.destroyed
      ? [{ ...this.targetFacts(), type: 'furnace', distance }] : [] }
  }
  entityRead() { return this.nearbySnapshot().entities.length ? { ...super.entityRead(), actor_position: this.position } : { found: false } }
  async command(text) {
    if (text.includes('"research_path"')) return JSON.stringify({ ok: true, target: 'electronics', nodes: [{ name: 'electronics', researched: this.researched.has('electronics'), mode: 'trigger', research_trigger: { type: 'craft-item', item: 'copper-plate', count: 10 } }] })
    const answer = await super.command(text)
    if (text.includes('"autorio_operations","status"') && this.receiptOverride) return JSON.stringify(this.receiptOverride(JSON.parse(answer)))
    if (this.pendingBatch && text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      this.pendingBatch.operations = this.pendingBatch.operations.map(operation => {
        if (operation.name === 'move_items') {
          const match = /^'([^']+)','([^']+)',(\d+),(true|false)\)/.exec(operation.args.raw)
          assert.ok(match)
          return { name: operation.name, args: { item_name: match[1], entity_name: match[2], max_count: Number(match[3]), to_entity: match[4] === 'true' } }
        }
        if (operation.name === 'walk_to_position') {
          const match = /^(-?[\d.]+),(-?[\d.]+)/.exec(operation.args.raw)
          assert.ok(match)
          return { name: 'walk_to_position', args: { x: Number(match[1]), y: Number(match[2]) } }
        }
        return operation
      })
      this.sent.at(-1).operations = this.pendingBatch.operations
      this.lastTaskTypes = this.pendingBatch.operations.flatMap(operation => operation.name === 'move_items' ? ['moving_items']
        : operation.name === 'walk_to_position' ? ['walking_direct']
          : operation.name === 'supply_entity' ? operation.args.items.map(() => 'moving_items') : ['waiting'])
    }
    return answer
  }
  completeBatch() {
    const batch = this.pendingBatch
    if (batch.operations.some(operation => operation.name === 'move_items')) {
      // Native legacy lookup has no candidate within reach. No output or
      // inventory is assigned; the tail never executes.
      const failed = batch.operations.find(operation => operation.name === 'move_items')
      for (const prefix of batch.operations.slice(0, batch.operations.indexOf(failed))) {
        assert.equal(prefix.name, 'walk_to_position')
        this.position = structuredClone(prefix.args)
        this.effects.push({ batch_id: batch.batch_id, operation: prefix.name, position: this.position })
      }
      this.failLastBatch({ type: 'moving_items', code: 'no_target', accepted: false, completed: false,
        entity_name: failed.args.entity_name, item_name: failed.args.item_name,
        requested_count: failed.args.max_count, to_entity: failed.args.to_entity })
      this.cancelledBatch.started_count = this.prefix ? 2 : 1
      if (this.proof) this.cancelledBatch.failed_before_mutation = true
      this.receipts.push({ ...this.cancelledBatch, state: 'cancelled' })
      this.pendingBatch = null
      return batch
    }
    if (batch.operations[0].name === 'walk_to_position') this.position = structuredClone(batch.operations[0].args)
    return super.completeBatch()
  }
  smelt(count) {
    const done = super.smelt(count)
    this.produced['copper-plate'] = (this.produced['copper-plate'] ?? 0) + done
    if (this.produced['copper-plate'] >= 10) this.researched.add('electronics')
    return done
  }
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new RemoteFurnaceGame(options); const model = new ScriptedModel(); const wire = []
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
  const ctx = { game, model, world, session, logs, wire }
  ctx.action = operations => planReply({ stepId: world.memory.currentPlan(KEY)?.task_board.active_step_id, operations })
  ctx.start = async () => {
    const initial = game.prefix ? [{ name: 'walk_to_position', args: { x: 8.5390625, y: -101.4140625 } }, ...LEGACY] : LEGACY
    model.push('planner', 'sol:commit', planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: CHECKPOINT, stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }], goal: GOAL }))
      .push('executor', 'luna:actual-run-S-legacy-transfer', () => ctx.action(initial))
    assert.equal(session.queuePlayerRequest('TTLouis', STEP), true)
    await settle(session)
    assert.equal(game.sent.length, 1)
    assert.deepEqual(game.sent[0].operations, initial)
  }
  ctx.fail = async () => {
    game.completeBatch()
    session.lastErrorAt = 0
    session.onGameLine('[AUTORIO] [ERROR] moving_items failed: no_target; dependent operations cancelled')
    await settle(session)
  }
  return ctx
}
function healthy(ctx) {
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.model.remaining, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.logs.filter(line => /listener failed|follow-up failed/.test(line)), [])
}
function assertRecovery(ctx, messages) {
  const text = messages.map(row => String(row.content)).join('\n')
  assert.match(text, /within interaction reach \(no_target\)/)
  assert.match(text, /Historical coordinates are travel guidance only/)
  assert.match(text, /Do not replay that batch or its cancelled tail/)
  assert.equal(ctx.world.memory.currentPlan(KEY).status, 'active')
  assert.equal(transferSupplyRecoveryCount(ctx.world.memory.currentPlan(KEY).task_board), 1)
}

test('Run S full loop: correlated first-task miss, model travel, fresh target/counts, exact supply and ten native-style copper finish the same step', async t => {
  const ctx = fixture(t); const { game, model, world } = ctx
  await ctx.start()
  const before = structuredClone(getActivePlan(world.memory.planningState(KEY)))
  model.push('executor', 'luna:choose-travel', messages => {
    assertRecovery(ctx, messages)
    assert.equal(game.position.y, -101.4140625, 'no automatic walk')
    assert.equal(game.inventory['copper-ore'], 10); assert.equal(game.inventory.coal, 10)
    return ctx.action([WALK])
  }).push('executor', 'luna:fresh-target', tool('getEntityStatus', { name: 'stone-furnace', radius: 20 }))
    .push('executor', 'luna:fresh-inventory', () => planReply({
      stepId: world.memory.currentPlan(KEY).task_board.active_step_id, operations: [], observationRequest: {
        stepId: world.memory.currentPlan(KEY).task_board.active_step_id, tool: 'getInventoryItems', args: {},
        rationale: 'Check held counts after reacquiring the actual furnace before exact delivery.',
      },
    }))
    .push('executor', 'luna:exact-delivery', messages => {
      const read = messages.map(row => String(row.content)).join('\n')
      assert.match(read, /"unit_number":10/)
      assert.match(read, /copper-ore/)
      return ctx.action([{ name: 'supply_entity', args: { unit_number: 10, items: [{ item_name: 'copper-ore', count: 10 }, { item_name: 'coal', count: 10 }] } }])
    })
  await ctx.fail()
  assert.equal(game.sent.length, 2)
  assert.deepEqual(game.sent[1].operations, [WALK])
  assert.ok(world.named('operation.reconciled').some(row => row.verdict === 'refused_before_mutation' && row.effect === 'not_happened'))
  await completeAndReport(ctx)
  assert.equal(game.sent.length, 3, JSON.stringify({ calls: model.labels, violations: model.violations, logs: ctx.logs, agentLogs: world.agentLogs, trace: world.trace.slice(-12) }))
  const after = getActivePlan(world.memory.planningState(KEY))
  assert.equal(after.plan_id, before.plan_id); assert.equal(after.plan_version, before.plan_version)
  assert.equal(after.steps[0].step_id, before.steps[0].step_id)
  assert.deepEqual(after.steps[0].completion_contract, before.steps[0].completion_contract)
  await completeAndReport(ctx, { smelt: 10 })
  assert.equal(game.produced['copper-plate'], 10); assert.equal(game.furnace.output['copper-plate'], 10)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  const [trace] = world.named('transfer.target_recovery')
  assert.ok(trace.request_id); assert.ok(trace.operation_key)
  assert.equal(trace.reason, 'correlated_legacy_transfer_local_target_absent')
  assert.equal(trace.attempt, 1); assert.equal(trace.retry_budget, 2)
  assert.equal(ctx.wire[0].body.model, 'gpt-6.1-sol')
  assert.ok(ctx.wire.slice(1).every(row => row.body.model === 'gpt-6-luna'))
  healthy(ctx)
})

for (const mode of ['historical-unproved', 'completed-prefix']) test(`Run S ${mode}: location recovery preserves uncertainty and duplicate guard`, async t => {
  const ctx = fixture(t, { proof: mode !== 'historical-unproved', prefix: mode === 'completed-prefix' }); const { model, world, game } = ctx
  await ctx.start()
  model.push('executor', 'luna:choose-travel', messages => { assertRecovery(ctx, messages); return ctx.action([WALK]) })
  await ctx.fail()
  if (mode === 'completed-prefix') {
    assert.equal(game.position.x, 8.5390625, 'the successful movement prefix changed the world before the failure')
    assert.equal(game.effects[0].operation, 'walk_to_position')
    assert.equal(game.cancelledBatch.started_count, 2)
  }
  const pending = world.memory.pendingOperations(KEY).find(row => row.operations.some(operation => operation.name === 'move_items'))
  assert.equal(pending.effect, 'partial_unknown'); assert.equal(pending.verdict, 'admitted_cancelled')
  const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
  assert.equal(restored.pendingOperations(KEY).find(row => row.operation_key === pending.operation_key).effect, 'partial_unknown')
  assert.equal(transferSupplyRecoveryCount(restored.currentPlan(KEY).task_board), 1)
  assert.equal(restored.checkDuplicateEffect(KEY, { operations: LEGACY }).refuse, true)
  assert.equal(restored.checkDuplicateEffect(KEY, { operations: [{ name: 'supply_entity', args: { unit_number: 10, items: [{ item_name: 'copper-ore', count: 10 }] } }] }).refuse, true)
  assert.equal(game.inventory['copper-ore'], 10); assert.deepEqual(game.furnace.source, {})
  assert.equal(game.sent.length, 2, 'only failed original and separately selected travel were admitted')
  healthy(ctx)
})

for (const mode of ['wrong-tick', 'wrong-actor', 'wrong-epoch', 'wrong-signature', 'wrong-batch', 'wrong-item', 'missing-accepted', 'exact-target', 'player', 'destroyed-target']) test(`local transfer recovery fails closed: ${mode}`, async t => {
  const ctx = fixture(t); const { game, world } = ctx
  await ctx.start()
  game.completeBatch()
  game.receiptOverride = status => {
    const b = status.basic_operation.last_result
    if (mode === 'wrong-tick') b.tick++
    if (mode === 'wrong-actor') b.actor_id++
    if (mode === 'wrong-epoch') game.status.epoch++
    if (mode === 'wrong-signature') status.admission_journal[0].signature = 'forged'
    if (mode === 'wrong-batch') status.last_cancelled_batch.batch_id++
    if (mode === 'wrong-item') b.item_name = 'iron-ore'
    if (mode === 'missing-accepted') delete b.accepted
    if (mode === 'exact-target') b.target_unit_number = 10
    if (mode === 'player') b.player_name = 'TTLouis'
    if (mode === 'destroyed-target') { b.code = 'target_gone'; status.last_cancelled_batch.reason = 'moving_items:target_gone' }
    return status
  }
  world.agent.planUpdateReason = 'failure'
  await world.agent.taskStatusReceipt()
  assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 0)
  assert.equal(world.memory.currentPlan(KEY).status, 'blocked')
  assert.equal(game.sent.length, 1)
})

test('local target recovery spends the existing persistent two-attempt supply allowance, then blocks without a third mutation', async t => {
  const ctx = fixture(t); const { game, model, world } = ctx
  await ctx.start()
  model.push('executor', 'luna:retry-local-selection', () => ctx.action(LEGACY), 2)
  await ctx.fail()
  assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 1)
  await ctx.fail()
  assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 2)
  game.completeBatch()
  world.agent.planUpdateReason = 'failure'
  await world.agent.taskStatusReceipt()
  assert.equal(world.memory.currentPlan(KEY).status, 'blocked')
  assert.equal(world.memory.currentPlan(KEY).blocker, 'transfer_failed:no_target')
  assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 2)
  assert.equal(game.sent.length, 3, 'the third failed admission exhausts recovery; no further mutation')
  assert.deepEqual(world.named('transfer.target_recovery').map(row => row.attempt), [1, 2])
  healthy(ctx)
})

for (const boundary of ['stop', 'epoch']) test(`local target recovery proposal fenced after ${boundary}`, async t => {
  const ctx = fixture(t); const { model, game, world } = ctx
  await ctx.start()
  let reached = false
  model.push('executor', 'luna:stale-travel-proposal', messages => {
    assertRecovery(ctx, messages); reached = true
    const reply = ctx.action([WALK])
    if (boundary === 'stop') world.agent.cancel('fixture_stop')
    else game.status.epoch++
    return reply
  })
  await ctx.fail()
  assert.equal(reached, true)
  assert.equal(game.sent.length, 1)
  assert.equal(game.position.y, -101.4140625)
  assert.equal(game.produced['copper-plate'], undefined)
  assert.deepEqual(model.violations, []); assert.deepEqual(model.remaining, [])
})
