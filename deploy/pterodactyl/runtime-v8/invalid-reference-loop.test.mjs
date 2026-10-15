import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FurnaceFactorio, FURNACE_UNIT, recoverySession, ScriptedModel, settle, completeAndReport, assertStrictBoundary, KEY } from './recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, PLANNER_MODEL, EXECUTOR_MODEL } from './invalid-reference-fixtures.mjs'
import { gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { parsePlan } from './structured-policy.mjs'

// The invalid value 0 is REPRESENTATIVE: Run L retained its validation reason,
// but did not log the rejected tool arguments. No claim of an exact replay.
const place = { name: 'place_entity', args: { entity_name: 'stone-furnace', x: 3, y: 3 } }
const supply = unit => ({ name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 10 }] } })
const collect = { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: FURNACE_UNIT, max_count: 10, to_entity: false } }
const observe = { content: null, tool_calls: [{ id: 'furnace', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }] }
const checkpoint = inventoryCheckpoint('copper-plate', 10)
const reply = (operations, initial = false) => planReply({ plan: ['Smelt and collect 10 copper plates'], currentStep: 0, operations,
  ...(initial ? { checkpoint, stepCompletions: [{ kind: 'deterministic', checkpoint }],
    goal: { scope: 'finite', summary: 'Hold 10 copper plates', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] } } : {}),
})

class PlacementFurnace extends FurnaceFactorio {
  constructor() {
    super({ inventory: { 'stone-furnace': 1, coal: 10, 'copper-ore': 10 } })
    this.placed = false
  }
  nearbySnapshot() { return this.placed ? super.nearbySnapshot() : { actor_position: { x: 0, y: 0 }, entities: [] } }
  entityRead() { return this.placed ? super.entityRead() : { found: false } }
  async command(text) {
    const answer = await super.command(text)
    if (this.pendingBatch?.operations.some(op => op.name === 'place_entity')) {
      this.lastTaskTypes = ['placing']; this.taskState = 'placing'
    }
    return answer
  }
  completeBatch() {
    const placing = this.pendingBatch?.operations.some(op => op.name === 'place_entity')
    const batch = super.completeBatch()
    if (placing) {
      assert.equal(this.placed, false); assert.equal(this.inventory['stone-furnace'], 1)
      delete this.inventory['stone-furnace']; this.placed = true
      this.lastBasicResult.type = 'placing'
    }
    return batch
  }
}
async function begin(t, { corrections, ready, stateFile = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new PlacementFurnace()
  const model = new ScriptedModel().push('planner', 'sol-draft', reply([], true))
    .push('executor', 'luna-invalid-reference', reply([place, supply(0)]))
  for (const [label, answer] of corrections ?? [['place-only', reply([place])]]) model.push('executor', label, answer)
  const world = delegatedRecoveryWorld({ game, model, stateFile })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  ready?.(ctx)
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  ctx.session.queuePlayerRequest('TTLouis', 'Smelt and collect ten copper plates')
  await settle(ctx.session)
  return ctx
}

test('Run L two-model loop: invalid batch -> place receipt -> live discovery -> supply/smelt/collect receipts -> verified goal', async t => {
  let ctxBefore
  const ctx = await begin(t, { corrections: [['place-only', (_messages, context) => {
    assert.equal(context.allowTools, true)
    assert.equal(ctxBefore.game.sent.length, 0, 'the valid placement prefix did not run')
    assert.equal(ctxBefore.game.placed, false)
    return reply([place])
  }]], ready: value => { ctxBefore = value } })
  assert.equal(ctx.game.sent.length, 1)
  assert.deepEqual(ctx.game.sent[0].operations.map(op => op.name), ['place_entity'])
  const plan = structuredClone(ctx.world.memory.planningState(KEY))
  const rejected = ctx.world.named('operations.arguments_rejected')
  assert.equal(rejected.length, 1)
  assert.ok(rejected[0].request_id)
  assert.equal(rejected[0].reason, 'deterministic_operation_argument_validation')
  assert.equal(rejected[0].arguments.unit_number, 0)
  assert.equal(rejected[0].operation_index, 1)
  assert.deepEqual(ctx.world.named('recovery.routed'), [], 'Jev never classifies a known argument validation failure')
  ctx.model.push('executor', 'discover-after-placement', observe).push('executor', 'supply-live-furnace', reply([supply(FURNACE_UNIT)]))
  await completeAndReport(ctx)
  assert.equal(ctx.game.placed, true)
  assert.equal(ctx.game.inventory['copper-plate'] ?? 0, 0)
  ctx.model.push('executor', 'collect-real-output', reply([collect]))
  await completeAndReport(ctx, { smelt: 10 })
  assert.equal(ctx.game.furnace.output['copper-plate'], 10)
  assert.equal(ctx.game.inventory['copper-plate'] ?? 0, 0)
  assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, plan.plans.at(-1).steps)
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-plate'], 10)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.world.modelRequests.map(row => row.model), [PLANNER_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL])
  assertStrictBoundary(ctx)
})

for (const change of ['stop', 'epoch']) test(`Run L ${change} during argument correction admits no batch`, async t => {
  let ctx, announce, release
  const started = new Promise(resolve => { announce = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const running = begin(t, { ready: value => { ctx = value }, corrections: [['pending', async () => {
    announce(); await waiting; return reply([place])
  }]] })
  await started
  if (change === 'stop') ctx.session.queuePlayerRequest('TTLouis', 'stop')
  else ctx.game.status.epoch += 1
  release(); await running; await settle(ctx.session)
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.game.placed, false)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*(?:cancelled|superseded|epoch changed)/i] })
})

test('Run L repeated invalid reference consumes the existing category cap without dispatch or generic recovery', async t => {
  const ctx = await begin(t, { corrections: Array.from({ length: 3 }, (_, i) => [`invalid-${i}`, reply([place, supply(0)])]) })
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.world.named('operations.arguments_rejected').length, 4)
  assert.deepEqual(ctx.world.named('recovery.routed'), [])
  assert.equal(ctx.world.named('recovery.classified').at(-1).retry_limit, 3)
  assertStrictBoundary(ctx)
})

test('Run L lost placement ack + restart resumes Luna on the same committed plan and never places twice', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'invalid-reference-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'state.json')
  const first = await begin(t, { stateFile, ready: ctx => { ctx.game.dropAckOnce = true } })
  const goalId = first.world.memory.planningState(KEY).goal.goal_id
  first.game.completeBatch()
  first.game.reloadMod()
  first.session.stopping = true; first.session.clearAutoResume()
  const model = new ScriptedModel().push('executor', 'restart-discover', observe)
    .push('executor', 'restart-supply', reply([supply(FURNACE_UNIT)]))
    .push('executor', 'restart-collect', reply([collect]))
  const world = delegatedRecoveryWorld({ game: first.game, model, stateFile })
  const ctx = { t, game: first.game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  await world.agent.loadPersistentState()
  ctx.session.queueStartupRecovery(ctx.session.currentPlanState())
  await settle(ctx.session)
  assert.equal(world.named('operation.recovery_settled').at(-1)?.reason, 'restart_exact_completed_receipt')
  assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
  assert.deepEqual(ctx.game.sent.map(batch => batch.operations.map(op => op.name)), [['place_entity'], ['supply_entity']])
  await completeAndReport(ctx, { smelt: 10 })
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-plate'], 10)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(world.modelRequests.map(row => row.model), [EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL])
  assertStrictBoundary(ctx)
})

test('argument diagnostics retain numeric references but omit arbitrary strings and unknown keys', () => {
  assert.throws(() => parsePlan({ chatMessage: '', plan: ['Supply'], currentStep: 0, operations: [{
    name: 'supply_entity', args: { unit_number: 0, items: [{ item_name: 'sk-secret-arbitrary-string', count: 1 }] },
  }] }), error => {
    assert.equal(error.code, 'invalid_operation_arguments')
    assert.equal(error.details.arguments.unit_number, 0)
    assert.doesNotMatch(JSON.stringify(error.details), /sk-secret|private-endpoint|secret/)
    return true
  })
  assert.throws(() => parsePlan({ chatMessage: '', plan: ['Supply'], currentStep: 0, operations: [{
    name: 'supply_entity', args: { unit_number: 0, items: [{ item_name: 'coal', count: 1 }], secret: 'private-endpoint-and-key' },
  }] }), error => error.code === undefined && /Unexpected argument/.test(error.message))
})

class CraftResultGame extends FurnaceFactorio {
  constructor() {
    super()
    this.preflight = text => text.includes("'craft_item'")
      ? { ok: (this.inventory.stone ?? 0) >= 5, operation: 'craft_item', code: 'bootstrap_dependency_unresolved', identity: 'stone-furnace',
        requested_count: 1, craftable_now_count: (this.inventory.stone ?? 0) >= 5 ? 1 : 0,
        bootstrap: { first_unresolved: { name: 'stone', required: 5, held: this.inventory.stone ?? 0, missing: 5 } } }
      : this.furnacePreflight(text)
  }
  async command(text) {
    if (text.includes('"recipe_details"') && text.includes('stone-furnace')) return JSON.stringify({ found: true, query: 'stone-furnace', truncated: false, recipes: [{
      name: 'stone-furnace', enabled: true, allow_intermediates: true, allow_as_intermediate: true, hidden: false,
      energy: 0.5, categories: ['crafting'], hand_craftable_category: true,
      ingredients: [{ type: 'item', name: 'stone', amount: 5 }], products: [{ type: 'item', name: 'stone-furnace', amount: 1 }],
      crafting_machine_count: 0, crafting_machines: [], crafting_machines_truncated: false,
    }] })
    const answer = await super.command(text)
    if (this.pendingBatch?.operations.some(op => op.name === 'craft_item')) { this.lastTaskTypes = ['crafting']; this.taskState = 'crafting' }
    return answer
  }
  completeBatch() {
    const crafting = this.pendingBatch?.operations.some(op => op.name === 'craft_item')
    const batch = super.completeBatch()
    if (crafting) {
      assert.equal(this.inventory.stone, 5)
      delete this.inventory.stone
      this.inventory['stone-furnace'] = 1
      this.produced['stone-furnace'] = 1
      this.lastBasicResult.type = 'crafting'
    }
    return batch
  }
}
for (const mode of ['ingredient', 'semantic']) test(`Run L checkpoint scope: ${mode} correction cannot replace furnace result; Sol preserves its draft and Luna crafts before completion`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new CraftResultGame()
  const resultCheckpoint = inventoryCheckpoint('stone-furnace', 1)
  const original = operations => planReply({ plan: ['Craft a stone furnace'], currentStep: 0, operations,
    checkpoint: resultCheckpoint, stepCompletions: [{ kind: 'deterministic', checkpoint: resultCheckpoint }],
  })
  const model = new ScriptedModel()
    .push('planner', 'sol-craft-draft', planReply({ ...JSON.parse(original([{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }]).content),
      goal: { scope: 'finite', summary: 'Hold a stone furnace', doneWhen: [{ kind: 'inventory_count', item_name: 'stone-furnace', minimum: 1 }] },
    }))
    .push('planner', 'bad-acquisition-checkpoint', mode === 'semantic' ? planReply({ plan: ['Assess available stone'], currentStep: 0,
      operations: [], assessmentOnly: true, stepCompletions: [{ kind: 'semantic' }],
    }) : planReply({ plan: ['Gather 5 stone', 'Craft a stone furnace'], currentStep: 0,
      operations: [gather('stone', 5)], checkpoint: inventoryCheckpoint('stone', 5),
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('stone', 5) }, { kind: 'deterministic' }],
    }))
    .push('planner', 'preserve-result-acquire-stone', original([gather('stone', 5)]))
    .push('executor', 'luna-craft-real-result', original([{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }]))
  const world = delegatedRecoveryWorld({ game, model })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  ctx.session.queuePlayerRequest('TTLouis', 'Craft a stone furnace')
  await settle(ctx.session)
  const [rejected] = world.named('plan.preflight_checkpoint_change_rejected')
  assert.ok(rejected?.request_id)
  assert.equal(rejected.reason, 'preflight_correction_preserves_result_checkpoint')
  assert.equal(game.sent.length, 1, 'only the correctly scoped acquisition is admitted')
  assert.equal(game.inventory['stone-furnace'] ?? 0, 0)
  await completeAndReport(ctx)
  assert.equal(game.inventory.stone, 5)
  assert.equal(game.inventory['stone-furnace'] ?? 0, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'stone is not the furnace result')
  assert.equal(world.memory.currentPlan(KEY).task_board.steps[0].completion_contract.requirements[0].item_name, 'stone-furnace')
  await completeAndReport(ctx)
  assert.equal(game.inventory['stone-furnace'], 1)
  assert.equal(game.produced['stone-furnace'], 1)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.deepEqual(world.modelRequests.map(row => row.model), [PLANNER_MODEL, PLANNER_MODEL, PLANNER_MODEL, EXECUTOR_MODEL])
  assertStrictBoundary(ctx)
})
