import assert from 'node:assert/strict'
import test from 'node:test'
import { bg, bgRecipes, bgWorld } from './bg-production-binding-fixtures.mjs'
import { continueProductionTask, prepareProductionTask } from './production-task-runtime.mjs'
import { advanceProductionTask, createProductionTask, normalizeProductionIntent, PRODUCTION_LIMITS, restoreProductionTask } from './production-task.mjs'
import { recoverySession } from './recovery-loop-fixtures.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'

const repaired = w => w.events.filter(row => row.event === 'production.recovery' && row.data.mechanism === 'exact_producer_binding')
// Original BG p11 has an exact verified gather receipt (batch53, evidence seq3).
const originalReceiptKey = '3:53:batch_53'
async function finish(w, providerCount = 0) {
  const { session } = recoverySession(w, { actorId: 24, epoch: 1 })
  for (let i = 0; i < 12 && w.memory.currentPlan(bg.key).status !== 'completed'; i++) {
    session.onGameLine('[AUTORIO] All operations completed'); await session.eventQueue
  }
  assert.equal(w.game.inventory['automation-science-pack'], 10, JSON.stringify(w.events.slice(-8)))
  assert.equal(w.memory.currentPlan(bg.key).status, 'completed')
  assert.equal(w.providers.length, providerCount)
  const count = w.ops.length
  session.onGameLine('[AUTORIO] All operations completed'); await session.eventQueue
  assert.equal(w.ops.length, count, 'duplicate terminal callback cannot replay production or setup')
  assert.equal(w.providers.length, providerCount)
}

test('BG exact tap150 target-only payload still reproduces the original pure controller unbound reason', () => {
  assert.deepEqual(bg.reply.productionTask, { targets: [{ item_name: 'automation-science-pack', count: 10 }] })
  const task = createProductionTask({ intent: bg.reply.productionTask, owner: bg.task.owner, actor_id: 24, epoch: 1 })
  const result = advanceProductionTask(task, { owner: task.owner, actor_id: 24, epoch: 1, native_idle: true, pending: false,
    fresh: true, recipes: bgRecipes, machines: [], inventory: JSON.parse(bg.task.last_fingerprint).held })
  assert.equal(result.reason, 'production_producer_unbound:copper-plate')
  assert.equal(result.task.transitions, 0)
})

test('BG tap150 shared admission binds only the new safe fixture furnace and completes the original ten-pack checkpoint', async () => {
  const w = bgWorld(); const original = structuredClone(w.plan().steps)
  await w.start()
  assert.ok(w.events.some(row => row.event === 'production.admission_repaired' && row.data.reason === 'production_producer_unbound'), JSON.stringify(w.events.slice(-10)))
  assert.equal([...w.memory.productionTasks.values()][0].intent.producers[0].unit_number, 60)
  await finish(w)
  assert.deepEqual(w.plan().steps, original)
})

test('BG injected old record: one durable exact binding resumes through real supervisor receipts to ten science packs', async () => {
  const w = bgWorld(); const original = structuredClone(w.plan().steps)
  const originalTask = w.residual()
  await continueProductionTask(w.agent)
  const task = [...w.memory.productionTasks.values()][0]
  assert.deepEqual(task.intent, originalTask.intent)
  assert.deepEqual(task.producer_bindings, [{ recipe_name: 'copper-plate', unit_number: 60 }], JSON.stringify(w.events.slice(-6)))
  assert.equal(task.recoveries, 1)
  assert.deepEqual(repaired(w).map(row => row.data.outcome), ['reconcile'])
  assert.equal(w.ops[0], 'supply_entity')
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.deepEqual([...restored.productionTasks.values()][0].producer_bindings, task.producer_bindings)
  await finish(w)
  assert.deepEqual(w.plan().steps, original)
})

test('BG historical preserved drill49 to furnace50 route is not automatic producer authority', async () => {
  const w = bgWorld({ safe: false, provider: async () => ({ content: JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, ...bg.reply }) }) }); w.residual()
  await continueProductionTask(w.agent)
  assert.ok(w.events.some(row => row.event === 'request.completed' && row.data.outcome === 'blocked_before_mutation'))
  assert.equal(w.memory.pauseRecord(bg.key).pause_reason, 'blocked_decision:production_producer_unbound')
  assert.equal(w.memory.pauseRecord(bg.key).pause_class, 'guard')
  assert.equal(repaired(w)[0]?.data.outcome, 'setup_required')
  assert.deepEqual(w.ops, [])
})

for (const withGrant of [true, false]) {
  test(`BG original preserved route: bounded setup gathers, crafts, places and fuels a new producer through exact receipts then automatically makes ten packs (grant=${withGrant})`, async () => {
    const setup = [
      { name: 'gather_resource', args: { resource_name: 'stone', count: 5, search_radius: 64 } },
      { name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } },
      { name: 'place_entity', args: { entity_name: 'stone-furnace', x: 60, y: -60 } },
      { name: 'supply_entity', args: { unit_number: 60, items: [{ item_name: 'coal', count: 1 }] } },
    ]
    const w = bgWorld({ safe: false, provider: async () => {
      const operation = setup.shift(); assert.ok(operation, 'unexpected extra model request')
      return { content: JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, stepId: bg.reply.stepId, operations: [operation] }) }
    } })
    if (!withGrant) {
      // Native04's original player-request plan has no authorization record and
      // no replacement lineage. Placement receipts establish ownership later.
      delete w.memory.planningState(bg.key).authorization
      assert.equal(w.memory.currentGoalGrant(bg.key), undefined)
      assert.equal(w.plan().replacement, undefined)
    }
    const steps = structuredClone(w.plan().steps); const preserved = structuredClone(w.preserved)
    const original = w.residual()
    await continueProductionTask(w.agent)
    assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
    assert.ok([...w.memory.productionTasks.values()][0].producer_wait)
    assert.deepEqual(w.ops, ['gather_resource'])
    await w.agent.completed()
    const progressed = [...w.memory.productionTasks.values()][0]
    assert.equal(progressed.recoveries, 1)
    w.memory.restore(w.memory.snapshot())
    assert.deepEqual([...w.memory.productionTasks.values()][0].producer_wait, progressed.producer_wait)
    await finish(w, 4)
    assert.deepEqual(w.plan().steps, steps)
    assert.deepEqual(w.preserved, preserved)
    assert.deepEqual(original.intent, normalizeProductionIntent(bg.reply.productionTask))
    const bindings = repaired(w).filter(row => row.data.outcome === 'reconcile')
    assert.equal(bindings.length, 1)
    assert.deepEqual(bindings[0].data.bindings, [{ recipe_name: 'copper-plate', unit_number: 60 }])
    assert.equal(bindings[0].data.recovery, 2)
    assert.deepEqual(w.ops.slice(0, 4), ['gather_resource', 'craft_item', 'place_entity', 'supply_entity'])
  })
}

test('BG replacement missing its required grant is an explicit authority refusal, not a stale provider retry', async () => {
  const w = bgWorld()
  w.plan().replacement = { grant_id: 'missing', grant_revision: 1 }
  w.residual()
  const result = await continueProductionTask(w.agent)
  assert.match(result.reason, /production_producer_unbound/)
  assert.equal(w.providers.length, 0)
  assert.deepEqual(w.ops, [])
  assert.ok(repaired(w).some(row => row.data.detail === 'production_binding_authority_unproven'), JSON.stringify(repaired(w)))
})

for (const fault of ['ambiguous', 'recipe', 'occupied', 'identity', 'ownership', 'preservation', 'direct_feed', 'native_journal', 'native_craft', 'unreadable', 'missing_progress', 'missing_truncation', 'missing_energy', 'missing_status']) {
  test(`BG automatic binding fails closed for ${fault}`, async () => {
    const w = bgWorld({ directFeed: fault === 'direct_feed', provider: async () => ({ content: JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, ...bg.reply }) }) })
    if (fault === 'ambiguous') w.add({ ...structuredClone(w.furnace), unit_number: 61, position: { x: 62, y: -60 } })
    if (fault === 'recipe') w.furnace.recipe = 'iron-plate'
    if (fault === 'occupied') w.furnace.inventories[1].items = [{ name: 'iron-ore', count: 1 }]
    if (fault === 'identity') w.furnace.position.x += 1
    if (fault === 'ownership') w.furnace.last_user = 'human-owner'
    if (fault === 'preservation') w.preserved[0].item_io.drop_target = null
    if (fault === 'native_journal') w.game.admissionJournal = () => undefined
    if (fault === 'native_craft') w.game.craftingStatus = { task_active: true, native_queue: { 1: {} } }
    if (fault === 'unreadable') w.furnace.inventory_items_truncated = true
    if (fault === 'missing_progress') delete w.furnace.crafting_progress
    if (fault === 'missing_truncation') delete w.furnace.inventories_truncated
    if (fault === 'missing_energy') delete w.furnace.energy_source
    if (fault === 'missing_status') delete w.furnace.status_name
    w.residual()
    const result = await continueProductionTask(w.agent)
    const setup = ['recipe', 'occupied', 'direct_feed'].includes(fault)
    if (setup) assert.equal(w.memory.pauseRecord(bg.key).pause_reason, 'blocked_decision:production_producer_unbound')
    else assert.equal(result.reason, 'production_producer_unbound:copper-plate', JSON.stringify(w.events.slice(-6)))
    assert.deepEqual(w.ops, [])
    assert.equal([...w.memory.productionTasks.values()][0].recoveries, setup ? 1 : 0)
    assert.equal(repaired(w)[0]?.data.outcome, setup ? 'setup_required' : 'unproven')
  })
}

for (const fault of ['request', 'amendment', 'actor', 'cancel', 'intake']) {
  test(`BG ${fault} during candidate read cannot bind, spend, pause replacement or send`, async () => {
    let changed = false
    const w = bgWorld({ onRead: ({ agent, text }) => {
      if (!changed && text.includes('"get_entity_status"') && text.includes(',60)')) {
        changed = true
        if (fault === 'request') agent.traceRequest = { id: 'replacement' }
        if (fault === 'amendment') agent.currentPendingAmendment = () => ({ id: 'amended' })
        if (fault === 'actor') agent.epoch.epoch++
        if (fault === 'cancel') agent.active = false
        if (fault === 'intake') agent.requestAdmissionOwner = { id: 'replacement' }
      }
    } })
    w.residual()
    await assert.rejects(continueProductionTask(w.agent))
    assert.equal(changed, true)
    assert.deepEqual(w.ops, [])
    assert.equal([...w.memory.productionTasks.values()][0].recoveries, 0)
    assert.equal(w.memory.pauseRecord(bg.key)?.paused, false)
  })
}

test('BG residual recovery trace cancellation is fenced before durable binding or native admission', async () => {
  const w = bgWorld({ onTrace: ({ agent, row }) => {
    if (row.event === 'production.recovery' && row.data.mechanism === 'exact_producer_binding') agent.currentPendingAmendment = () => ({ id: 'new' })
  } })
  w.residual(); await assert.rejects(continueProductionTask(w.agent))
  assert.deepEqual(w.ops, [])
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 0)
})

test('BG exhaustion is visible and survives restore and resubmission without another mutation', async () => {
  const w = bgWorld(); w.residual({ recoveries: PRODUCTION_LIMITS.recoveries })
  const result = await continueProductionTask(w.agent)
  assert.equal(result.reason, 'production_recovery_exhausted')
  const snapshot = w.memory.snapshot(); w.memory.restore(snapshot)
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, PRODUCTION_LIMITS.recoveries)
  assert.equal(restoreProductionTask([...w.memory.productionTasks.values()][0]).pause_reason, 'production_recovery_exhausted')
  assert.deepEqual(w.ops, [])
})

test('BG ordinary admission without safe binding returns its bounded correction before creating a record', async () => {
  const w = bgWorld({ safe: false })
  await assert.rejects(prepareProductionTask(w.agent, { ...bg.reply, chatMessage: '' }), error => error.productionAdmissionRefused && error.code === 'production_producer_unbound')
  assert.equal(w.memory.productionTasks.size, 0)
  assert.deepEqual(w.ops, [])
})

test('BG original payload normalization never invents bindings', () => {
  assert.deepEqual(normalizeProductionIntent(bg.reply.productionTask), bg.task.intent)
})

test('BG waiting setup keeps one durable claim through restore and has an explicit no-progress terminal boundary', async () => {
  const w = bgWorld({ safe: false })
  w.residual({ recoveries: 1, producer_wait: { after_batch: originalReceiptKey, reason: 'production_binding_no_eligible_producer' } })
  const before = [...w.memory.productionTasks.values()][0]
  assert.equal(before.recoveries, 1)
  w.memory.restore(w.memory.snapshot())
  assert.deepEqual([...w.memory.productionTasks.values()][0].producer_wait, before.producer_wait)
  const now = Date.now
  Date.now = () => before.last_progress_at + PRODUCTION_LIMITS.stalled_ms
  try {
    const result = await continueProductionTask(w.agent)
    assert.equal(result.reason, 'production_no_progress')
  } finally { Date.now = now }
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
  assert.equal(w.providers.length, 0)
})

for (const phase of ['persist', 'trace', 'admission_trace']) {
  test(`BG setup ${phase} supersession retains spent allowance but cannot wake an executor`, async () => {
    const w = bgWorld({ safe: false, onTrace: ({ agent, row }) => {
      if (phase === 'trace' && row.event === 'production.binding_setup_required'
        || phase === 'admission_trace' && row.event === 'production.admission_correction') agent.currentPendingAmendment = () => ({ id: 'replacement' })
    } })
    w.residual()
    if (phase === 'persist') {
      const persist = w.agent.persistState.bind(w.agent)
      w.agent.persistState = async options => {
        await persist(options)
        if ([...w.memory.productionTasks.values()][0].producer_wait) w.agent.currentPendingAmendment = () => ({ id: 'replacement' })
      }
    }
    await assert.rejects(continueProductionTask(w.agent))
    assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
    assert.deepEqual(w.ops, [])
    assert.equal(w.providers.length, 0)
    assert.equal(w.memory.pauseRecord(bg.key)?.paused, false)
  })
}

test('BG admission binding report supersession cannot create a production record', async () => {
  const w = bgWorld({ onTrace: ({ agent, row }) => {
    if (row.event === 'production.admission_repaired') agent.currentPendingAmendment = () => ({ id: 'replacement' })
  } })
  await assert.rejects(w.start())
  assert.equal(w.memory.productionTasks.size, 0)
  assert.deepEqual(w.ops, [])
  assert.equal(w.providers.length, 0)
})

for (const fault of ['amendment', 'intake']) {
  test(`BG restored waiting timeout fences ${fault} during its first ownership read`, async () => {
    let armed = false; let changed = false
    const w = bgWorld({ safe: false, onRead: ({ agent, text }) => {
      if (armed && !changed && text.includes('"sgluna_deployment","status"')) {
        changed = true
        if (fault === 'amendment') agent.currentPendingAmendment = () => ({ id: 'newer' })
        else agent.requestAdmissionOwner = { id: 'newer' }
      }
    } })
    const task = w.residual({ recoveries: 1, producer_wait: { after_batch: originalReceiptKey, reason: 'production_binding_no_eligible_producer' } })
    w.memory.restore(w.memory.snapshot())
    const before = JSON.stringify([...w.memory.productionTasks])
    const now = Date.now; Date.now = () => task.deadline_at
    armed = true
    try { await assert.rejects(continueProductionTask(w.agent)) } finally { Date.now = now }
    assert.equal(changed, true)
    assert.equal(JSON.stringify([...w.memory.productionTasks]), before)
    assert.equal(w.memory.pauseRecord(bg.key).paused, false)
    assert.deepEqual(w.ops, [])
  })
}

test('BG waiting deadline remains absolute across restored controller state', async () => {
  const w = bgWorld({ safe: false })
  const task = w.residual({ recoveries: 1, producer_wait: { after_batch: originalReceiptKey, reason: 'production_binding_no_eligible_producer' } })
  w.memory.restore(w.memory.snapshot())
  const now = Date.now; Date.now = () => task.deadline_at
  try { assert.equal((await continueProductionTask(w.agent)).reason, 'production_task_exhausted') } finally { Date.now = now }
  assert.equal([...w.memory.productionTasks.values()][0].deadline_at, task.deadline_at)
  assert.equal(w.providers.length, 0)
})

test('BG grant revocation during candidate read cannot authorize an advisory binding or pause replacement work', async () => {
  let revoked = false
  const w = bgWorld({ onRead: ({ memory, text }) => {
    if (!revoked && text.includes('"get_entity_status"') && text.includes(',60)')) {
      revoked = true
      const planning = memory.planningState(bg.key)
      memory.planningByNpc.set(bg.key, { ...planning, authorization: { ...planning.authorization,
        grants: planning.authorization.grants.map(grant => ({ ...grant, status: 'revoked' })) } })
    }
  } })
  w.residual(); await assert.rejects(continueProductionTask(w.agent))
  assert.equal(revoked, true)
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 0)
  assert.deepEqual(w.ops, [])
  assert.equal(w.memory.pauseRecord(bg.key).paused, false)
})
