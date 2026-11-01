import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { FurnaceFactorio, ScriptedModel, recoverySession, settle, fireResumeTimer, completeAndReport, assertStrictBoundary, KEY, FURNACE_UNIT } from './recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, PLANNER_MODEL, EXECUTOR_MODEL } from './invalid-reference-fixtures.mjs'
import { inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/run-n-missing-baseline.json', import.meta.url)))
const recipes = {
  'iron-gear-wheel': { ingredients: { 'iron-plate': 2 }, yield: 1 },
  'copper-cable': { ingredients: { 'copper-plate': 1 }, yield: 2 },
  'electronic-circuit': { ingredients: { 'iron-plate': 1, 'copper-cable': 3 }, yield: 1 },
  'transport-belt': { ingredients: { 'iron-plate': 1, 'iron-gear-wheel': 1 }, yield: 2 },
  lab: { ingredients: { 'iron-gear-wheel': 10, 'electronic-circuit': 10, 'transport-belt': 4 }, yield: 1 },
}
function craft(inventory, name, count) {
  const recipe = recipes[name]
  assert.ok(recipe, `no recipe for ${name}`)
  for (const [item, amount] of Object.entries(recipe.ingredients)) {
    const needed = amount * count
    const shortage = needed - (inventory[item] ?? 0)
    if (shortage > 0) { assert.ok(recipes[item], `missing leaf ${item}`); craft(inventory, item, Math.ceil(shortage / recipes[item].yield)) }
    inventory[item] -= needed
  }
  inventory[name] = (inventory[name] ?? 0) + count * recipe.yield
}
class RunNFactorio extends FurnaceFactorio {
  constructor() {
    super({ inventory: { coal: 10, 'copper-ore': 10, 'iron-plate': 16, 'iron-gear-wheel': 10, 'copper-cable': 20 },
      furnace: { fuel: { coal: 2 }, output: { 'iron-plate': 44 }, energy_kj: 100 } })
    this.preflight = text => text.includes("'craft_item'") ? { ok: true, operation: 'craft_item', craftable_now_count: 1 } : this.furnacePreflight(text)
  }
  async command(text) {
    if (text.includes('"recipe_details"') && text.includes('lab')) {
      const possible = (this.inventory['copper-plate'] ?? 0) >= 5
      return JSON.stringify({ ...captured.recipe, recipes: [{ ...captured.recipe.recipes[0], craftable_now: possible,
        craftable_now_count: possible ? 1 : 0, ...(possible ? { bootstrap: { dependencies: [], first_unresolved: null } } : {}) }] })
    }
    const result = await super.command(text)
    if (this.pendingBatch?.operations.some(op => op.name === 'craft_item')) {
      this.lastTaskTypes = ['crafting']; this.taskState = 'crafting'
    }
    return result
  }
  completeBatch() {
    const crafts = this.pendingBatch?.operations.some(op => op.name === 'craft_item')
    const result = super.completeBatch()
    if (crafts) {
      craft(this.inventory, 'lab', 1)
      this.produced.lab = (this.produced.lab ?? 0) + 1
      this.lastBasicResult.type = 'crafting'
    }
    return result
  }
}
const checkpoint = inventoryCheckpoint('lab', 1)
const reply = (operations = [], extra = {}) => planReply({ plan: ['Craft the lab from the furnace and held stock'], currentStep: 0,
  operations, checkpoint, stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
let nextRead = 0
const observe = () => ({ content: null, tool_calls: [
  ['getEntityStatus', { name: 'stone-furnace', radius: 16 }], ['getNearbyEntities', { radius: 16, limit: 20 }],
].map(([name, args]) => ({ id: `baseline-${++nextRead}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
const answers = messages => messages.filter(m => m.role === 'tool').slice(-2).map(m => JSON.parse(m.content))
function full(messages) {
  const [entity, nearby] = answers(messages)
  assert.equal(entity.observation_mode, 'full', 'a rebuilt context must get a full live furnace snapshot')
  assert.equal(nearby.observation_mode, 'full', 'a rebuilt context must get a full nearby snapshot')
  assert.equal(entity.entity.unit_number, FURNACE_UNIT)
  assert.ok(nearby.entities.some(e => e.unit_number === FURNACE_UNIT))
}
const diagnostic = ctx => JSON.stringify({ labels: ctx.model.labels, violations: ctx.model.violations, logs: ctx.logs,
  last: ctx.world.trace.slice(-12).map(row => ({ event: row.event, data: row.data })) })
const collect = (item_name, max_count) => ({ name: 'move_items_exact', args: { unit_number: FURNACE_UNIT, item_name, max_count, to_entity: false } })
async function begin(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new RunNFactorio()
  const model = new ScriptedModel()
    .push('planner', 'sol:lab-checkpoint', reply([], { goal: { scope: 'finite', summary: 'Hold one crafted lab', doneWhen: [{ kind: 'inventory_count', item_name: 'lab', minimum: 1 }] } }))
    .push('executor', 'luna:initial-reads', observe())
    .push('executor', 'luna:exact-run-n-blocker', messages => { full(messages); assert.equal(captured.entity_status.observation_mode, 'unchanged'); return reply([], { chatMessage: `BLOCKED: ${captured.blocker}` }) })
    .push('executor', 'luna:C5-closed-act-or-block', (_messages, context) => {
      assert.equal(context.allowTools, false, 'fresh-context correction cannot reopen spent observations')
      return reply([], { chatMessage: `BLOCKED: ${captured.blocker}` })
    })
  const world = delegatedRecoveryWorld({ game, model })
  const ctx = { t, game, model, world, ...recoverySession(world) }
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume() })
  ctx.session.queuePlayerRequest('TTLouis', 'Craft one lab from the plates in this furnace and held ingredients')
  await settle(ctx.session)
  assert.deepEqual(model.violations, [])
  assert.ok(ctx.session.modelResume, 'real pause scheduling owns the pending recovery timer')
  assert.equal(game.sent.length, 0, 'unsupported blocker and refused supplies do not dispatch gameplay')
  return ctx
}
test('Run N full loop: closed C5 recovery -> C7 full machine facts -> clear output -> smelt copper -> craft lab -> verified goal', async t => {
  const ctx = await begin(t)
  const goalId = ctx.world.memory.planningState(KEY).goal.goal_id
  const steps = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1).steps)
  ctx.model.push('executor', 'luna:C7-reads', observe())
    .push('executor', 'luna:C7-full-baseline-and-clear', messages => {
      full(messages)
      assert.deepEqual(ctx.world.memory.planningState(KEY).plans.at(-1).steps, steps)
      return reply([collect('iron-plate', 44)])
    })
    .push('executor', 'luna:feed-copper-after-clear', reply([{ name: 'supply_entity', args: { unit_number: FURNACE_UNIT, items: [{ item_name: 'copper-ore', count: 5 }] } }]))
    .push('executor', 'luna:collect-processed-copper', reply([collect('copper-plate', 5)]))
    .push('executor', 'luna:craft-lab', reply([{ name: 'craft_item', args: { item_name: 'lab', count: 1 } }]))
  await fireResumeTimer(ctx)
  assert.equal(ctx.world.memory.planningState(KEY).goal.goal_id, goalId)
  assert.ok(ctx.game.pendingBatch, diagnostic(ctx))
  await completeAndReport(ctx)
  assert.equal(ctx.game.furnace.output['iron-plate'] ?? 0, 0)
  await completeAndReport(ctx, { smelt: 5 })
  assert.equal(ctx.game.furnace.output['copper-plate'], 5)
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory['copper-plate'], 5)
  await completeAndReport(ctx)
  assert.equal(ctx.game.inventory.lab, 1)
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.world.named('recovery.auto_resume_started').length, 1)
  assert.ok(ctx.world.trace.some(row => row.event === 'context.restaged' && row.data.checkpoint === 'C5'))
  assert.ok(ctx.world.trace.some(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7'))
  const rebased = ctx.world.named('observation.baseline_rebased')
  assert.ok(rebased.length >= 2)
  assert.ok(rebased.every(row => row.request_id && row.reason === 'current_conversation_has_no_delivered_baseline'))
  assert.equal(ctx.game.sent.length, 4)
  assert.equal(ctx.world.modelRequests[0].model, PLANNER_MODEL)
  assert.ok(ctx.world.modelRequests.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assertStrictBoundary(ctx)
})
for (const change of ['stop', 'epoch']) test(`Run N ${change} fences a rebuilt-context reply before output collection`, async t => {
  const ctx = await begin(t)
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  ctx.model.push('executor', 'luna:C7-reads', observe())
    .push('executor', 'luna:pending-collection', async messages => { full(messages); entered(); await pending; return reply([collect('iron-plate', 44)]) })
  const running = fireResumeTimer(ctx)
  assert.equal(await Promise.race([started.then(() => true), running.then(() => false)]), true, diagnostic(ctx))
  if (change === 'stop') ctx.session.queuePlayerRequest('TTLouis', 'stop')
  else ctx.game.status.epoch++
  release(); await running; await settle(ctx.session)
  assert.equal(ctx.game.sent.length, 0)
  assert.equal(ctx.game.furnace.output['iron-plate'], 44)
  assertStrictBoundary(ctx, { allowedLogs: [/follow-up failed:.*(?:cancelled|superseded|epoch changed)/i] })
})
