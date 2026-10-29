import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { stockWorld, original, KEY } from './bg-stock-fixtures.mjs'
import { activeStockDependencyBarrier, continueStockDependencyBarrier, restoreStockDependencyBarriers, stockDependencyShape } from './bg-stock-dependency.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'

for (const initial of [0, 1]) test(`BG original ${original[initial].tap}: one acquisition prefix then unchanged suffix without another model reply`, async () => {
  const w = stockWorld({ initial }); await w.start()
  assert.equal(w.game.mutations.length, 1, JSON.stringify(w.rows.slice(-6)))
  assert.ok(w.game.mutations[0].includes("'gather_resource'"))
  assert.ok(!w.game.mutations[0].includes("'supply_entity'"))
  const steps = structuredClone(w.held().steps); const calls = w.calls.length
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 2, JSON.stringify(w.rows.slice(-8)))
  assert.ok(w.game.mutations[1].includes("'supply_entity'"))
  assert.equal(w.calls.length, calls)
  assert.deepEqual(w.held().steps, steps)
  assert.equal(activeStockDependencyBarrier(w.agent).state, 'suffix_pending')
  await w.agent.taskStatusReceipt()
  await continueStockDependencyBarrier(w.agent)
  assert.equal(activeStockDependencyBarrier(w.agent), undefined)
  assert.equal(w.rows.filter(r => r.event === 'stock_dependency.completed').length, 1)
})

test('shape rejects arbitrary interleaved/mutating lists', () => {
  assert.equal(stockDependencyShape([original[1].operations[0], { name: 'mine_entity', args: {} }, original[1].operations[1]]), undefined)
})

test('snapshot retains active prefix with original ordered proposal and monotonic claims', async () => {
  const w = stockWorld(); await w.start()
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.equal(restored.stockDependencyBarrierFault, false)
  assert.deepEqual(restored.stockDependencyBarriers, w.memory.stockDependencyBarriers)
  const raw = structuredClone([...restored.stockDependencyBarriers]); raw[0][1][0].split++
  assert.equal(restoreStockDependencyBarriers(raw).fault, true)
  assert.equal(restored.currentPlan(KEY).status, 'active')
})

test('injected early barrier miss reaches real argument fallback and automatic native callback continuation', () => {
  const hook = `import {registerHooks} from 'node:module';registerHooks({load(url,context,next){const r=next(url,context);if(!url.endsWith('/npc-agent-loop.mjs'))return r;const needle='const stockBarrier = await startStockDependencyBarrier(this, { ...plan, stepId: miningStepId }, error)';if(!String(r.source).includes(needle))return r;return {...r,source:String(r.source).replace(needle,'const stockBarrier = undefined // injected early barrier miss')};}})`
  const driver = `import assert from 'node:assert/strict';import {stockWorld} from ${JSON.stringify(new URL('./bg-stock-fixtures.mjs', import.meta.url).href)};const w=stockWorld();await w.start();assert.equal(w.game.mutations.length,1);assert.equal(w.rows.filter(r=>r.event==='stock_dependency.residual_detected').length,1);const n=w.calls.length;await w.agent.completed();assert.equal(w.game.mutations.length,2);assert.equal(w.calls.length,n);assert.equal(w.memory.planningState('npc:bg-stock').goal.argument_corrections.claims.length,0);console.log('residual composed continuation passed');`
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, '--input-type=module', '-e', driver], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('restart after prefix receipt settlement resumes only original suffix and duplicate callback cannot replay it', async () => {
  const w = stockWorld(); await w.start(); await w.agent.taskStatusReceipt()
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot()); w.agent.memory = restored
  await w.agent.runTurn()
  assert.equal(w.game.mutations.length, 2)
  await w.agent.taskStatusReceipt(); await continueStockDependencyBarrier(w.agent)
  await continueStockDependencyBarrier(w.agent)
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.calls.length, 3)
})

test('two verified acquisition episodes on one semantic step retain separate durable bounded claims; third visibly exhausts after restore', async () => {
  const w = stockWorld({ initial: 1 }); await w.start()
  const key = [...w.memory.stockDependencyBarriers.keys()][0]
  for (let episode = 0; episode < 2; episode++) {
    await w.agent.completed(); await w.agent.taskStatusReceipt(); await continueStockDependencyBarrier(w.agent)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(w.agent.memory.snapshot()); w.agent.memory = restored
    w.game.inventory['iron-ore'] = 42; delete w.game.inventory.coal
    const result = await w.agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, stepId: w.held().steps[0].step_id, operations: original[1].operations })
    if (episode === 1) assert.equal(result.reason, 'stock_dependency_limit_exhausted')
  }
  assert.equal(w.game.mutations.length, 4)
  assert.equal(w.agent.memory.stockDependencyBarriers.get(key).length, 2)
  assert.equal(w.agent.memory.currentPlan(KEY).status, 'paused')
  assert.equal(w.rows.filter(r => r.event === 'stock_dependency.exhausted').at(-1).data.reason, 'stock_dependency_limit_exhausted')
})

for (const fault of ['missing', 'partial', 'wrong_actor', 'unreadable_inventory', 'no_yield', 'uncertain_journal']) {
  test(`prefix ${fault} never authorizes suffix or another model call`, async () => {
    let armed = false
    const w = stockWorld({ initial: 1, noYield: fault === 'no_yield', read: ({ text, game }) => {
      if (!armed) return undefined
      if (fault === 'unreadable_inventory' && text.includes('get_inventory_items')) return 'unreadable inventory'
      if (text.includes('autorio_operations","status') && ['missing', 'uncertain_journal'].includes(fault)) return {
        task_state: 'idle', queue_empty: true, queue_length: 0, admission_journal: fault === 'uncertain_journal' ? [{ state: 'uncertain' }] : [], receipt_journal: [] }
      if (fault === 'wrong_actor') game.status.actor_id = 99
    } })
    await w.start(); const calls = w.calls.length
    if (fault === 'partial') w.game.failLastBatch({ type: 'mining', code: 'resource_depleted' })
    armed = true
    try { await w.agent.completed() } catch (error) { assert.match(String(error), /epoch changed|stock_dependency|cancelled|superseded/i) }
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.calls.length, calls)
    if (fault !== 'wrong_actor') assert.equal(w.agent.memory.currentPlan(KEY).status, 'paused')
  })
}

for (const seam of ['persist', 'trace']) for (const fault of ['amendment', 'intake', 'cancel', 'epoch', 'busy', 'crafting', 'revoked']) {
  test(`${fault} during staged barrier ${seam} cannot send a prefix or wake a replacement`, async () => {
    let injected = false; let callsAtInjection
    const inject = ({ agent, memory, game }) => {
      if (injected || !activeStockDependencyBarrier(agent)) return
      injected = true; callsAtInjection = w.calls.length
      if (fault === 'amendment') agent.pendingInteractionAmendment = { text: 'Hold pending amendment', sender: 'Louis' }
      if (fault === 'intake') agent.requestAdmissionOwner = { replacement: true }
      if (fault === 'cancel') agent.active = false
      if (fault === 'epoch') game.status.epoch++
      if (fault === 'busy') { game.taskState = 'working'; game.queueLength = 1 }
      if (fault === 'crafting') game.craftingStatus = { task_active: true, native_queue: { 1: { recipe: 'fixture' } } }
      if (fault === 'revoked') memory.currentGoalGrant(KEY).status = 'revoked'
    }
    const w = stockWorld(seam === 'persist' ? { persist: inject } : { trace: data => { if (data.row.event === 'stock_dependency.barrier_staged') inject(data) } })
    try { await w.start() } catch (error) { assert.match(String(error), /stock_dependency|epoch changed|cancelled|superseded|provider_stale_reply_after_restage/i) }
    assert.equal(injected, true); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.calls.length, callsAtInjection)
  })
}

test('busy native prefix remains owned and awaits its receipt; no provider or semantic close', async () => {
  const w = stockWorld(); await w.start(); const calls = w.calls.length
  const journal = w.game.admissionJournal.bind(w.game)
  w.game.admissionJournal = () => journal().map(row => ({ ...row, state: w.game.taskState === 'working' ? 'admitted' : row.state }))
  w.game.taskState = 'working'; w.game.queueLength = 1
  const waiting = await w.agent.runTurn()
  assert.equal(waiting.stockDependency, 'waiting'); assert.equal(w.calls.length, calls)
  assert.equal(w.game.mutations.length, 1); assert.equal(w.held().active_step_index, 0)
  w.game.taskState = 'idle'; w.game.queueLength = 0
  await w.agent.completed(); assert.equal(w.game.mutations.length, 2)
})

for (const fault of ['amendment', 'intake', 'epoch', 'cancel']) test(`suffix receipt trace ${fault} cannot send or adopt newer work`, async () => {
  let injected = false
  const w = stockWorld({ trace: ({ row, agent, game }) => {
    if (row.event !== 'stock_dependency.prefix_settled' || injected) return
    injected = true
    if (fault === 'amendment') agent.pendingInteractionAmendment = { sender: 'Louis', text: 'New instruction' }
    if (fault === 'intake') agent.requestAdmissionOwner = { replacement: true }
    if (fault === 'epoch') game.status.epoch++
    if (fault === 'cancel') agent.active = false
  } })
  await w.start(); const calls = w.calls.length
  await assert.rejects(w.agent.completed(), /stock_dependency|epoch changed|cancelled|superseded/i)
  assert.equal(injected, true); assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, calls)
  assert.equal(activeStockDependencyBarrier(w.agent).state, 'prefix_pending')
})

test('foreign native work after exact prefix completion pauses visibly instead of waiting for an unowned callback', async () => {
  const w = stockWorld(); await w.start()
  w.game.craftingStatus = { task_active: false, native_queue: { 1: { recipe: 'fixture' } } }
  const result = await w.agent.runTurn()
  assert.equal(result.reason, 'stock_dependency_unowned_native_work')
  assert.equal(w.game.mutations.length, 1); assert.equal(w.memory.currentPlan(KEY).status, 'paused')
})

for (const seam of ['persist', 'admission_trace']) test(`suffix ${seam} busy race keeps exact unsent receipt and never retries prefix`, async () => {
  let injected = false
  const inject = ({ agent, game }) => {
    if (injected || activeStockDependencyBarrier(agent)?.state !== 'suffix_pending') return
    injected = true; game.taskState = 'working'; game.queueLength = 1
  }
  const w = stockWorld(seam === 'persist' ? { persist: inject } : { trace: data => { if (data.row.event === 'operations.admit') inject(data) } })
  await w.start()
  await assert.rejects(w.agent.completed(), /stock_dependency_native_busy/)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.ok(w.rows.some(r => r.event === 'operation.not_sent'))
})

for (const fault of ['amendment', 'actor', 'epoch', 'session', 'surface', 'active']) test(`${fault} during the inner persistent-pause load cannot pause newer work`, async () => {
  const w = stockWorld({ noYield: true }); await w.start()
  let armed = false; let injected = false
  const pause = w.agent.pausePersistentPlan.bind(w.agent)
  w.agent.pausePersistentPlan = (...args) => { armed = true; return pause(...args) }
  const load = w.agent.loadPersistentState.bind(w.agent)
  w.agent.loadPersistentState = async (...args) => {
    await load(...args)
    if (armed && !injected) {
      injected = true
      if (fault === 'amendment') w.agent.pendingInteractionAmendment = { sender: 'Louis', text: 'New amended instruction' }
      if (fault === 'actor') w.agent.epoch.actor_id++
      if (fault === 'epoch') w.agent.epoch.epoch++
      if (fault === 'session') w.agent.epoch.session = 'replacement-session'
      if (fault === 'surface') w.agent.epoch.surface_index++
      if (fault === 'active') w.agent.active = false
    }
  }
  const calls = w.calls.length
  await assert.rejects(w.agent.completed(), /Guard pause cancelled or superseded by amendment/)
  assert.equal(injected, true); assert.equal(w.memory.currentPlan(KEY).status, 'active')
  assert.equal(w.agent.active, fault !== 'active'); assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, calls)
  if (fault === 'amendment') assert.equal(w.agent.currentPendingAmendment().text, 'New amended instruction')
})

test('guard pause accepts equal amendment projections with fresh objects and reordered keys', async () => {
  const w = stockWorld(); await w.start()
  let reads = 0
  w.agent.currentPendingAmendment = () => ++reads % 2
    ? { text: 'New owner direction', sender: 'Louis', id: 'same-amendment' }
    : { id: 'same-amendment', sender: 'Louis', text: 'New owner direction' }
  const calls = w.calls.length
  const result = await w.agent.pausePersistentPlan('fixture_guard_pause', { pause_class: 'guard' }, w.agent.captureCheckpointOwner())
  assert.equal(result.status, 'paused'); assert.equal(w.memory.currentPlan(KEY).status, 'paused')
  assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, calls)
})

for (const field of ['text', 'id']) test(`guard pause rejects in-place amendment ${field} changes inside its load await`, async () => {
  const w = stockWorld(); await w.start()
  const amendment = { text: 'First direction', id: 'first-amendment', sender: 'Louis' }
  w.agent.currentPendingAmendment = () => amendment
  const load = w.agent.loadPersistentState.bind(w.agent)
  w.agent.loadPersistentState = async (...args) => { await load(...args); amendment[field] = 'replacement' }
  const calls = w.calls.length
  await assert.rejects(w.agent.pausePersistentPlan('fixture_guard_pause', { pause_class: 'guard' }, w.agent.captureCheckpointOwner()),
    /Guard pause cancelled or superseded by amendment/)
  assert.equal(w.memory.currentPlan(KEY).status, 'active'); assert.equal(w.agent.active, true)
  assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, calls)
  assert.equal(amendment[field], 'replacement')
})

for (const corrupt of [raw => { raw[0][0] = 'unowned' }, raw => { raw[0][0] = JSON.stringify(['npc:other', 'other-goal']) },
  raw => { raw[0][1][0].pending.signature = 'changed' }, raw => { raw[0][1][0].state = 'not-a-state' }]) {
  test('malformed restore pauses before provider even when active claim was dropped', async () => {
    const w = stockWorld(); await w.start(); const snapshot = w.memory.snapshot(); corrupt(snapshot.stock_dependency_barriers)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(snapshot); w.agent.memory = restored
    assert.equal(restored.stockDependencyBarrierFault, true)
    const calls = w.calls.length; const result = await w.agent.runTurn()
    assert.equal(result.reason, 'stock_dependency_ledger_unreadable')
    assert.equal(w.calls.length, calls); assert.equal(w.game.mutations.length, 1)
  })
}

for (const [label, journal, allowed] of [['native empty Lua object', {}, true], ['nonempty object', { unknown: true }, false],
  ['missing journal', undefined, false], ['malformed row', [{ state: 'completed' }], false]]) {
  test(`shared admission parser: ${label}`, async () => {
    const w = stockWorld({ initial: 1, read: ({ text, game }) => game.batchId === 0 && text.includes('autorio_operations","status')
      ? { task_state: 'idle', queue_empty: true, queue_length: 0, batch_generation: 1, admission_journal: journal, receipt_journal: {} } : undefined })
    await w.start()
    assert.equal(w.game.mutations.length, allowed ? 1 : 0)
    if (allowed) { await w.agent.completed(); assert.equal(w.game.mutations.length, 2) }
    else assert.equal(w.agent.memory.currentPlan(KEY).status, 'paused')
  })
}
