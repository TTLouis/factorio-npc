import assert from 'node:assert/strict'
import test from 'node:test'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { getActivePlan } from './planning-state.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { transferSupplyRecoveryCount } from './npc-agent-loop.mjs'
import { conflictingOperation } from './operation-ledger.mjs'
import { operationSignature, reconcilePendingOperation } from './operation-reconciliation.mjs'
import { FurnaceFactorio, ScriptedModel, recoveryWorld, recoverySession, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { planReply } from './task-loop-fixtures.mjs'

const STEP = 'Gather and smelt 5 additional copper ore to hold 15 copper plates'
const CHECKPOINT = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] }
const extract = (item, count) => ({ name: 'move_items_exact', args: { unit_number: 49, item_name: item, max_count: count, to_entity: false } })
const supply = items => ({ name: 'supply_entity', args: { unit_number: 49, items } })
const ORIGINAL = [extract('iron-ore', 7), extract('iron-plate', 17), supply([{ item_name: 'copper-ore', count: 5 }, { item_name: 'coal', count: 5 }])]
const REPAIR = [extract('iron-plate', 1), supply([{ item_name: 'copper-ore', count: 5 }])]
const observe = () => ({ content: null, tool_calls: [{ id: 'fresh-furnace', type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', radius: 8 }) } }] })

// Native physics is independently exercised by the run-x-transfer engine lane.
// This fixture models its reserved iron craft and exact four-task receipt.
class PartialFurnace extends FurnaceFactorio {
  constructor() {
    super({ inventory: { 'copper-plate': 10, 'copper-ore': 10, coal: 5 },
      furnace: { unit_number: 49, source: { 'iron-ore': 7 }, output: { 'iron-plate': 17 } } })
    this.receiptOverride = null
  }
  collectPreflight(args) {
    if (args.item_name === 'iron-ore' && args.to_entity === false) return { ok: true }
    return super.collectPreflight(args)
  }
  furnacePreflight(text) {
    if (this.sent.length === 0 && text.includes("'supply_entity'")) return { ok: true }
    return super.furnacePreflight(text)
  }
  async command(text) {
    if (this.failCapture && text.includes('"sgluna_deployment","status"')) throw new Error('fixture actor status unavailable')
    const answer = await super.command(text)
    if (text.includes('local ok,result=pcall') && text.includes('"authorize"') && this.pendingBatch) {
      const record = this.admissions.at(-1)
      record.slots.forEach((slot, index) => { slot.operation = this.pendingBatch.operations[index].name })
    }
    if (text.includes('"autorio_operations","status"') && this.receiptOverride) return JSON.stringify(this.receiptOverride(JSON.parse(answer)))
    return answer
  }
  completeBatch() {
    if (this.sent.length !== 1) return super.completeBatch()
    const batch = this.pendingBatch
    assert.deepEqual(batch.operations, ORIGINAL)
    this.inventory['iron-ore'] = 7; this.inventory['iron-plate'] = 17; this.inventory.coal -= 5
    this.furnace.source = {}; this.furnace.output = { 'iron-plate': 1 }; this.furnace.fuel = { coal: 4 }
    this.effects.push(...ORIGINAL.slice(0, 2).map(operation => ({ operation: operation.name, item: operation.args.item_name, moved: operation.args.max_count })), { operation: 'supply_entity', item: 'coal', moved: 5 })
    const ref = { batch_id: batch.batch_id, batch_generation: 1, batch_ref: `batch-g1-${batch.batch_id}` }
    this.cancelledBatch = { ...ref, task_count: 4, task_types: Array.from({ length: 4 }, () => 'moving_items'), started_count: 4,
      completed_count: 3, refused_count: 1, outcome: 'refused', tick: 700,
      reason: 'moving_items:nothing_moved:target_rejects_item', refusals: [{ operation_id: 21, type: 'moving_items', code: 'nothing_moved', cause: 'target_rejects_item', item_name: 'copper-ore', target_unit_number: 49, held_count: 10, tick: 699 }] }
    this.receipts.push({ ...this.cancelledBatch, state: 'cancelled' })
    this.lastBasicResult = { operation_id: 21, type: 'moving_items', accepted: false, completed: false, code: 'nothing_moved', tick: 700,
      actor_id: this.status.actor_id, item_name: 'copper-ore', target_unit_number: 49, requested_count: 5, moved_count: 0, to_entity: true, held_count: 10 }
    this.pendingBatch = null; this.taskState = 'idle'; this.queueLength = 0
    return batch
  }
}

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new PartialFurnace(); const model = new ScriptedModel(); const wire = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://proxy.example.test/v1', AI_API_METHOD: 'cli-proxy', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); wire.push({ body, context })
    const reply = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...reply } }], usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 } }), { status: 200 })
  } })
  const world = recoveryWorld({ game, model, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  const { session, logs } = recoverySession(world)
  const ctx = { game, model, world, session, logs, wire }
  ctx.action = (operations, extra = {}) => ({ content: JSON.stringify({ chatMessage: 'Use the observed counts to finish the current copper step.', stepId: world.memory.currentPlan(KEY).task_board.active_step_id, operations, ...extra }) })
  ctx.start = async () => {
    model.push('planner', 'sol:commit', planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: CHECKPOINT,
      stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }],
      goal: { scope: 'finite', summary: STEP, doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] } }))
      .push('executor', 'luna:bind-target', observe())
      .push('executor', 'luna:original', () => planReply({ plan: [STEP], stepId: world.memory.currentPlan(KEY).task_board.active_step_id, operations: ORIGINAL }))
    session.queuePlayerRequest('TTLouis', STEP); await settle(session)
    assert.equal(game.sent.length, 1, JSON.stringify({ logs, violations: model.violations, calls: model.calls.map(row => ({ label: row.label, tail: row.messages.slice(-2) })), trace: world.trace.map(row => ({ event: row.event, data: row.data })) }))
  }
  ctx.fail = async () => { game.completeBatch(); session.lastErrorAt = 0; session.onGameLine('[AUTORIO] [ERROR] moving_items failed: nothing_moved; cause=target_rejects_item'); await settle(session) }
  return ctx
}
function healthy(ctx) {
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.model.remaining, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.logs.filter(line => /listener failed|follow-up failed/.test(line)), [])
}

test('Run X full loop: exact terminal partial transfer, fresh furnace read, operation-only repair preserves the committed completion contract and physically finishes copper', async t => {
  const ctx = fixture(t); const { game, model, world } = ctx
  await ctx.start()
  const before = structuredClone(getActivePlan(world.memory.planningState(KEY)))
  let recoveryGuidance = ''
  model.push('executor', 'luna:observe', messages => {
    recoveryGuidance = messages.map(row => String(row.content)).join('\n')
    return observe()
  }).push('executor', 'luna:repair', () => ctx.action(REPAIR, { checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] } }))
    .push('executor', 'luna:collect', () => ctx.action([extract('copper-plate', 5)]))
  await ctx.fail()
  assert.equal(game.sent.length, 2, JSON.stringify({ logs: ctx.logs, violations: model.violations, trace: world.trace.slice(-12) }))
  assert.match(recoveryGuidance, /Do not replay the original batch/)
  assert.deepEqual(game.sent[1].operations, REPAIR)
  const closed = world.memory.planningState(KEY).operation_ledger.closed.find(row => row.verdict === 'admitted_partial')
  assert.equal(closed.effect, 'partial_known')
  assert.equal(world.memory.pendingOperations(KEY).some(row => row.operation_key === closed.operation_key), false)
  assert.equal(world.memory.checkDuplicateEffect(KEY, { operations: ORIGINAL }).refuse, true)
  const after = getActivePlan(world.memory.planningState(KEY))
  assert.equal(after.plan_id, before.plan_id); assert.equal(after.plan_version, before.plan_version)
  assert.deepEqual(after.steps[0].completion_contract, before.steps[0].completion_contract)
  assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 1)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(JSON.stringify(world.memory.snapshot())))
  assert.equal(restored.checkDuplicateEffect(KEY, { operations: ORIGINAL }).refuse, true)
  const planning = restored.planningState(KEY)
  assert.equal(conflictingOperation({ ...planning, run: { ...planning.run, pending_operation: null }, operation_ledger: { ...planning.operation_ledger, records: [] } }, {
    operations: ORIGINAL, planId: before.plan_id, stepId: before.steps[0].step_id,
  }).reason, 'terminal_partial_batch_replay')
  await completeAndReport(ctx, { smelt: 5 })
  await completeAndReport(ctx)
  assert.equal(game.inventory['copper-plate'], 15)
  assert.equal(game.sent.filter(row => operationSignature(row.operations) === operationSignature(ORIGINAL)).length, 1)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.named('transfer.partial_recovery')[0].reason, 'exact_terminal_target_rejection_same_step')
  assert.equal(world.named('operation.reconciled').find(row => row.verdict === 'admitted_partial').completed_tasks, 3)
  assert.equal(ctx.wire[0].body.model, 'gpt-6.1-sol'); assert.ok(ctx.wire.slice(1).every(row => row.body.model === 'gpt-6-luna'))
  healthy(ctx)
})

for (const mode of ['missing-count', 'cancelled-tail', 'wrong-ref', 'wrong-generation', 'wrong-signature', 'wrong-actor', 'wrong-epoch', 'wrong-item', 'wrong-cause', 'non-transfer', 'truncated-refusals', 'slot-operation', 'absent-basic-actor', 'capture-failure']) {
  test(`Run X exact partial proof fails closed: ${mode}`, async t => {
    const ctx = fixture(t); const { game, world } = ctx
    await ctx.start(); game.completeBatch()
    const pending = world.memory.pendingOperations(KEY)[0]
    const raw = JSON.parse(await game.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))'))
    const admission = raw.admission_journal[0]; const receipt = raw.receipt_journal[0]
    if (mode === 'missing-count') delete receipt.completed_count
    if (mode === 'cancelled-tail') receipt.started_count--
    if (mode === 'wrong-ref') receipt.batch_ref = 'batch-g1-999'
    if (mode === 'wrong-generation') raw.batch_generation++
    if (mode === 'wrong-signature') admission.signature = 'wrong'
    if (mode === 'wrong-actor') game.status.actor_id++
    if (mode === 'wrong-epoch') game.status.epoch++
    if (mode === 'wrong-item') raw.basic_operation.last_result.item_name = 'coal'
    if (mode === 'wrong-cause') receipt.refusals[0].cause = 'unknown'
    if (mode === 'non-transfer') receipt.task_types[0] = 'crafting'
    if (mode === 'truncated-refusals') receipt.refusals = []
    if (mode === 'slot-operation') admission.slots[0].operation = 'equip_weapon'
    if (mode === 'absent-basic-actor') { delete raw.basic_operation; game.status.actor_id++ }
    if (mode === 'capture-failure') { delete raw.basic_operation; game.failCapture = true }
    if (!['wrong-item', 'capture-failure'].includes(mode)) assert.notEqual(reconcilePendingOperation(pending, { status: raw, actor: game.status }).verdict, 'admitted_partial')
    game.receiptOverride = () => raw
    world.agent.planUpdateReason = 'failure'; await world.agent.taskStatusReceipt()
    assert.equal(transferSupplyRecoveryCount(world.memory.currentPlan(KEY).task_board), 0)
    assert.equal(game.sent.length, 1)
    if (mode !== 'wrong-item') assert.equal(world.memory.checkDuplicateEffect(KEY, { operations: REPAIR }).refuse, true)
  })
}

test('Run X blocked continuation is rejected by canonical authority, never treated as a new completion draft', async t => {
  const ctx = fixture(t); const { game, model, world } = ctx
  await ctx.start()
  game.receiptOverride = raw => { for (const receipt of raw.receipt_journal) delete receipt.completed_count; return raw }
  model.push('executor', 'luna:blocked-continuation', () => ctx.action(REPAIR, { checkpoint: CHECKPOINT }))
  await ctx.fail()
  assert.equal(game.sent.length, 1)
  assert.equal(world.memory.currentPlan(KEY).status, 'blocked')
  assert.deepEqual(world.named('request.failed'), [])
  assert.equal(world.named('plan.completion_declarations_preserved')[0].reason, 'canonical_plan_blocked')
  assert.ok(world.named('operations.skipped').some(row => row.reason === 'plan_blocked_awaiting_user'))
  healthy(ctx)
})
