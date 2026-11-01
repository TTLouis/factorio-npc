import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FurnaceFactorio, recoveryWorld, recoverySession, ScriptedModel, settle, completeAndReport, assertStrictBoundary, KEY, FURNACE_UNIT } from './recovery-loop-fixtures.mjs'
import { inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

// Native craft admission checks inventory NOW; queued transfers have not run.
// This scoped fake refuses the exact Run K batch synchronously, instead of
// treating a successful enqueue as a successful craft.
class CraftFactorio extends FurnaceFactorio {
  constructor({ copper = 0 } = {}) {
    super({ inventory: { 'iron-gear-wheel': 1, ...(copper ? { 'copper-plate': copper } : {}) }, furnace: { output: { 'copper-plate': 1 } } })
    this.preflight = text => text.includes("'craft_item'")
      ? { ok: (this.inventory['copper-plate'] ?? 0) >= 1, operation: 'craft_item', code: 'bootstrap_dependency_unresolved', craftable_now_count: this.inventory['copper-plate'] ?? 0 }
      : this.furnacePreflight(text)
  }
  async command(text) {
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      if (name === 'automation-science-pack') return JSON.stringify({ found: true, query: name, truncated: false, recipes: [{
        name, enabled: true, allow_intermediates: true, allow_as_intermediate: true, hidden: false,
        energy: 5, categories: ['crafting'], hand_craftable_category: true,
        ingredients: [{ type: 'item', name: 'copper-plate', amount: 1 }, { type: 'item', name: 'iron-gear-wheel', amount: 1 }],
        products: [{ type: 'item', name, amount: 1 }], crafting_machine_count: 0, crafting_machines: [], crafting_machines_truncated: false,
      }] })
    }
    if (text.includes('local ok,result=pcall') && text.includes('"authorize"') && text.includes("'craft_item'")) {
      if ((this.inventory['copper-plate'] ?? 0) < 1) {
        assert.ok(text.includes("'move_items_exact'"), 'this fixture models the precise Run K accepted prefix')
        const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]
        const encoded = /"begin",helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(text)[1]
        const identity = JSON.parse(JSON.parse(encoded))
        const batch_id = ++this.batchId
        const refs = [{ batch_id, batch_generation: this.generation, batch_ref: `batch-g${this.generation}-${batch_id}` }]
        const record = { ...identity, generation: this.generation, state: 'uncertain', slots: [
          { index: 1, ok: true, operation: 'move_items_exact', batch_refs: refs },
          { index: 2, ok: false, operation: 'craft_item', mutation_unknown: false, refused_before_mutation: true, refusal_code: 'Not enough ingredients', batch_refs: [] },
        ] }
        this.admissions.push(record)
        this.pendingBatch = { batch_id, operations: [collect] }
        this.sent.push(this.pendingBatch)
        this.mutations.push(text)
        this.lastTaskTypes = ['moving_items']; this.taskState = 'moving_items'; this.queueLength = 1
        return `${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 2: Not enough ingredients', prefix: [[true, 'Task started']], admission: record })}`
      }
    }
    const answer = await super.command(text)
    if (this.pendingBatch?.operations.some(op => op.name === 'craft_item')) {
      this.lastTaskTypes = this.pendingBatch.operations.map(op => op.name === 'craft_item' ? 'crafting' : 'moving_items')
      this.taskState = this.lastTaskTypes[0]
    }
    return answer
  }
  completeBatch() {
    const craft = this.pendingBatch?.operations.find(op => op.name === 'craft_item')
    const batch = super.completeBatch()
    if (craft) {
      assert.ok(this.inventory['copper-plate'] >= 1 && this.inventory['iron-gear-wheel'] >= 1)
      this.inventory['copper-plate'] -= 1
      this.inventory['iron-gear-wheel'] -= 1
      this.inventory['automation-science-pack'] = (this.inventory['automation-science-pack'] ?? 0) + 1
      this.produced['automation-science-pack'] = (this.produced['automation-science-pack'] ?? 0) + 1
      this.lastBasicResult.type = 'crafting'
    }
    return batch
  }
}
const collect = { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: FURNACE_UNIT, max_count: 1, to_entity: false } }
const craft = { name: 'craft_item', args: { item_name: 'automation-science-pack', count: 1 } }
const reply = (operations, initial = false) => planReply({ plan: ['Craft one red science pack'], currentStep: 0, operations,
  stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('automation-science-pack', 1) }],
  ...(initial ? { checkpoint: inventoryCheckpoint('automation-science-pack', 1),
    stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('automation-science-pack', 1) }],
    goal: { scope: 'finite', summary: 'Hold one red science pack', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 }] } } : {}),
})
const observe = { content: null, tool_calls: [{ id: 'furnace', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17 }) } }] }

async function begin(t, { copper = 0, correction, ready, stateFile = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new CraftFactorio({ copper })
  const model = new ScriptedModel().push('planner', 'observe', observe).push('planner', 'run-k', reply([collect, craft], true))
  if (!copper) model.push('planner', 'collect-only', correction ?? reply([collect]))
  const world = recoveryWorld({ game, model, stateFile })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  ready?.(ctx)
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  ctx.session.queuePlayerRequest('TTLouis', 'Craft one red science pack')
  await settle(ctx.session)
  return ctx
}

test('Run K: refuse queued transfer/craft before mutation -> collect receipt -> craft receipt -> verified goal', async t => {
  const ctx = await begin(t)
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.game.sent.map(batch => batch.operations.map(op => op.name)), [['move_items_exact']], JSON.stringify({ calls: ctx.model.labels, violations: ctx.model.violations, logs: ctx.logs, trace: ctx.world.trace.slice(-15) }))
  assert.equal(ctx.game.inventory['copper-plate'] ?? 0, 0)
  assert.equal(ctx.game.furnace.output['copper-plate'], 1)
  const before = structuredClone(ctx.world.memory.planningState(KEY))
  const rejected = ctx.world.named('craft.preflight_receipt_required')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason, 'craft_requires_settled_inventory')
  assert.ok(rejected[0].request_id)
  ctx.model.push('executor', 'craft-after-receipt', reply([craft]))
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-plate'], 1)
  assert.deepEqual(ctx.world.named('request.failed'), [], JSON.stringify({ calls: ctx.model.labels, trace: ctx.world.trace.slice(-15) }))
  assert.equal(ctx.game.inventory['automation-science-pack'] ?? 0, 0)
  assert.equal(ctx.world.memory.planningState(KEY).goal.goal_id, before.goal.goal_id)
  assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, before.plans.at(-1).steps)
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['automation-science-pack'], 1)
  assert.equal(ctx.game.produced['automation-science-pack'], 1)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.game.sent.length, 2)
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assertStrictBoundary(ctx)
})

test('Run K positive: copper already held permits the transfer/craft batch', async t => {
  const ctx = await begin(t, { copper: 1 })
  assert.equal(ctx.game.sent.length, 1)
  assert.deepEqual(ctx.world.named('craft.preflight_receipt_required'), [])
  ctx.game.completeBatch()
  assert.equal(ctx.game.inventory['automation-science-pack'], 1)
  assert.equal(ctx.game.inventory['copper-plate'], 1)
  assertStrictBoundary(ctx)
})

test('Run K repeated mixed batch pauses within the existing correction cap without admitting a prefix', async t => {
  const ctx = await begin(t, { correction: reply([collect, craft], true) })
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.game.inventory['copper-plate'] ?? 0, 0)
  assert.equal(ctx.game.furnace.output['copper-plate'], 1)
  assert.equal(ctx.world.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
  assert.equal(ctx.world.named('operations.preflight_recoverable').length, 1)
  assert.equal(ctx.world.named('craft.preflight_receipt_required').length, 2)
  assertStrictBoundary(ctx)
})

test('Run K lost collection ack + process/mod restart settles the prefix and crafts once without replay', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'queued-craft-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'state.json')
  const original = await begin(t, { stateFile, ready: ctx => { ctx.game.dropAckOnce = true } })
  assert.equal(original.game.sent.length, 1)
  original.game.completeBatch() // native effect happens; both ack and completion signal were lost
  original.game.reloadMod()
  original.session.stopping = true
  original.session.clearAutoResume()
  const model = new ScriptedModel().push('executor', 'restart-craft', reply([craft]))
  const world = recoveryWorld({ game: original.game, model, stateFile })
  const ctx = { t, game: original.game, world, model, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  await world.agent.loadPersistentState()
  ctx.session.queueStartupRecovery(ctx.session.currentPlanState())
  await settle(ctx.session)
  assert.equal(world.named('operation.recovery_settled').at(-1)?.reason, 'restart_exact_completed_receipt')
  assert.deepEqual(ctx.game.sent.map(batch => batch.operations.map(op => op.name)), [['move_items_exact'], ['craft_item']])
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['automation-science-pack'], 1)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assertStrictBoundary(ctx)
})

for (const change of ['stop', 'epoch']) test(`Run K ${change}: change during correction prevents acquisition and craft dispatch`, async t => {
  let ctx, announce, release
  const started = new Promise(resolve => { announce = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const pending = begin(t, { ready: value => { ctx = value }, correction: async () => { announce(); await waiting; return reply([collect]) } })
  await started
  if (change === 'stop') ctx.session.queuePlayerRequest('TTLouis', 'stop')
  else ctx.game.status.epoch += 1
  release()
  await pending
  await settle(ctx.session)
  assert.equal(ctx.game.inventory['automation-science-pack'] ?? 0, 0)
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.game.pendingBatch, null)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*(?:cancelled|superseded|epoch changed)/i] })
})
