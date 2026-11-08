import assert from 'node:assert/strict'
import test from 'node:test'
import { bgWorld, bg } from './bg-production-binding-fixtures.mjs'
import { continueProductionTask } from './production-task-runtime.mjs'
import { recoverySession } from './recovery-loop-fixtures.mjs'
import { activeStockDependencyBarrier } from './bg-stock-dependency.mjs'

test('producer setup acquires missing fuel through the stock barrier then resumes the immutable original production task', async () => {
  const setup = [
    [{ name: 'gather_resource', args: { resource_name: 'stone', count: 5, search_radius: 64 } }],
    [{ name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }],
    [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 60, y: -60 } }],
    [{ name: 'gather_resource', args: { resource_name: 'coal', count: 3, search_radius: 64 } },
      { name: 'supply_entity', args: { unit_number: 60, items: [{ item_name: 'coal', count: 1 }] } }],
  ]
  const taskSnapshots = []
  const w = bgWorld({ safe: false, onTrace: ({ memory }) => {
    for (const task of memory.productionTasks?.values() ?? []) taskSnapshots.push(structuredClone(task))
  }, provider: async () => {
    const operations = setup.shift(); assert.ok(operations, 'unexpected extra setup proposal')
    return { content: JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, stepId: bg.reply.stepId, operations }) }
  } })
  w.game.inventory.coal = 0
  // Native-protocol substitutes include stock facts and correlated completed
  // receipts; the generic production fixture only needs placement witnesses.
  const ordinaryCommand = w.game.command.bind(w.game); const receipts = []
  w.game.command = async text => {
    if (text.includes('autorio_preflight') && text.includes('supply_entity')) {
      const items = [...text.matchAll(/\{\['count'\]=(\d+),\['item_name'\]='([^']+)'\}/g)].map(([, count, item_name]) => ({
        item_name, requested: Number(count), source_count: w.game.inventory[item_name] ?? 0, destination_accepts: 100,
        expected_moved: Math.min(Number(count), w.game.inventory[item_name] ?? 0), status: (w.game.inventory[item_name] ?? 0) >= Number(count) ? 'ok' : 'supply_missing',
      }))
      const ok = items.length > 0 && items.every(row => row.source_count >= row.requested)
      return JSON.stringify({ ok, ...(!ok ? { code: 'supply_missing' } : {}), operation: 'supply_entity',
        target: { unit_number: 60, name: 'stone-furnace' }, transfer: { direction: 'to_entity', items, total_expected_moved: items.reduce((n, row) => n + row.expected_moved, 0) } })
    }
    const raw = await ordinaryCommand(text)
    if (!text.includes('autorio_operations","status')) return raw
    const status = JSON.parse(raw)
    if (status.last_completed_batch) {
      Object.assign(status.last_completed_batch, { batch_generation: 1, batch_ref: `batch-g1-${w.game.batchId}` })
      if (!receipts.some(row => row.batch_id === w.game.batchId)) receipts.push({ ...status.last_completed_batch, state: 'completed' })
    }
    status.receipt_journal = receipts
    return JSON.stringify(status)
  }
  const ordinaryMutation = w.game.onMutation
  w.game.onMutation = text => {
    if (text.includes("'gather_resource','coal'")) {
      w.ops.push('gather_resource'); w.game.inventory.coal += 3
      return
    }
    ordinaryMutation(text)
  }
  const original = w.residual(); const steps = structuredClone(w.plan().steps); const preserved = structuredClone(w.preserved)
  await continueProductionTask(w.agent)
  const { session } = recoverySession(w, { actorId: 24, epoch: 1 })
  for (let i = 0; i < 18 && w.memory.currentPlan(bg.key).status !== 'completed'; i++) {
    session.onGameLine('[AUTORIO] All operations completed'); await session.eventQueue
  }
  assert.equal(w.game.inventory['automation-science-pack'], 10, JSON.stringify({ ops: w.ops, inventory: w.game.inventory, tasks: [...w.memory.productionTasks.values()], relevant: w.events.filter(row => row.event.startsWith('stock_dependency.') || row.event.startsWith('production.')) }))
  assert.equal(w.memory.currentPlan(bg.key).status, 'completed')
  assert.equal(w.providers.length, 4)
  assert.equal(w.events.filter(row => row.event === 'stock_dependency.barrier_staged').length, 1)
  assert.equal(w.events.filter(row => row.event === 'stock_dependency.completed').length, 1)
  assert.equal(activeStockDependencyBarrier(w.agent), undefined)
  assert.deepEqual(w.plan().steps, steps)
  assert.deepEqual(w.preserved, preserved)
  assert.ok(taskSnapshots.length > 0)
  for (const task of taskSnapshots) assert.deepEqual(task.intent, original.intent)
  assert.equal(Math.max(...taskSnapshots.map(task => task.recoveries)), 2)
  assert.equal(w.memory.productionTasks.size, 0, 'verified step completion prunes the completed controller record')
})
