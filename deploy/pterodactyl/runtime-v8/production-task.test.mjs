import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { compileQuantities } from './quantity-compiler.mjs'
import { claimMaterials, materialAvailability } from './material-ledger.mjs'
import { advanceProductionTask, createProductionTask, PRODUCTION_LIMITS, recoverProductionTask, restoreProductionTask } from './production-task.mjs'
import { continueProductionTask, pruneClosedProductionRecords } from './production-task-runtime.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'
import { recoverySession } from './recovery-loop-fixtures.mjs'
import { plannerControlPayloadFromMessage, executionOnlyControlToolDefinitions } from './structured-policy.mjs'

const an = JSON.parse(await fs.readFile(new URL('./fixtures/run-an-production.json', import.meta.url), 'utf8'))
const owner = { goal_id: 'goal', plan_id: 'plan', plan_version: 1, step_id: 'step' }
const poles = { targets: [{ item_name: 'small-electric-pole', count: 2 }] }
const base = { owner, actor_id: 18, epoch: 1, native_idle: true, pending: false, fresh: true, recipes: an.recipes, machines: [] }

test('exact AN two poles compile from native per-craft yields without the recorded false copper shortage', () => {
  assert.equal(an.refusal.requested_count, 2)
  assert.equal(an.refusal.craftable_now_count, 1)
  assert.equal(an.refusal.bootstrap.inventory_overlay.ingredients[0].held, 1)
  const bill = compileQuantities({ ...poles, recipes: an.recipes, inventory: { wood: 1, 'copper-plate': 1 } })
  assert.deepEqual(bill.nodes.map(row => [row.name, row.crafts, row.produced_items]), [['copper-cable', 1, 2], ['small-electric-pole', 1, 2]])
  assert.deepEqual(bill.acquisition, [])
})

test('shared intermediates, surplus, held final reserves and other reservations are allocated once', () => {
  const targets = [...poles.targets, { item_name: 'copper-plate', count: 1 }]
  const bill = compileQuantities({ targets, recipes: an.recipes, inventory: { wood: 1, 'copper-plate': 1 } })
  assert.deepEqual(bill.acquisition, [{ item_name: 'copper-plate', count: 1 }])
  let ledger = claimMaterials(undefined, { owner: { ...owner, step_id: 'other' }, items: [{ item_name: 'copper-plate', count: 1 }] })
  ledger = claimMaterials(ledger, { owner, items: poles.targets, kind: 'forecast' })
  const stock = materialAvailability(ledger, { owner, inventory: { 'copper-plate': 1 }, fresh: true, pending: [{ item_name: 'copper-plate', count: 9 }] })
  assert.equal(stock.available['copper-plate'], 0)
  assert.equal(stock.in_flight['copper-plate'], 9)
  assert.equal(stock.forecast['small-electric-pole'], 2)
  assert.throws(() => materialAvailability(ledger, { owner, inventory: {}, fresh: false }), /not_fresh/)
})

test('ambiguous, cyclic, truncated and nondeterministic recipe data cannot authorize crafting', () => {
  for (const recipes of [[...an.recipes, { ...an.recipes[0], name: 'alternative-poles' }],
    [{ ...an.recipes[0], ingredients: [{ name: 'small-electric-pole', amount: 1 }] }],
    [{ ...an.recipes[0], products: [{ name: 'small-electric-pole', amount: 2, probability: 0.5 }] }]]) {
    assert.throws(() => compileQuantities({ ...poles, recipes, inventory: {} }))
  }
})

test('unconfigured assemblers cannot receive production materials and a running final furnace craft has finite wait proof', () => {
  const recipe = { ...an.recipes[1], crafting_machines: [{ name: 'assembling-machine-1' }] }
  const task = createProductionTask({ intent: { targets: [{ item_name: 'copper-cable', count: 2 }], producers: [{ recipe_name: 'copper-cable', unit_number: 42 }] }, owner, actor_id: 18, epoch: 1 })
  const machine = { unit_number: 42, name: 'assembling-machine-1', type: 'assembling-machine', input: {}, output: {}, fuel: {}, working: false }
  assert.equal(advanceProductionTask(task, { ...base, recipes: [recipe], inventory: { 'copper-plate': 1 }, machines: [machine] }).reason, 'production_machine_unconfigured')
  recipe.crafting_machines = [{ name: 'stone-furnace' }]
  Object.assign(machine, { name: 'stone-furnace', type: 'furnace', recipe: 'copper-cable', progress: 0.5, working: true })
  const result = advanceProductionTask(task, { ...base, recipes: [recipe], inventory: {}, machines: [machine] })
  assert.deepEqual(result.operation, { name: 'wait', args: { ticks: 120 } })
})

function world({ inject = 0, onRead, furnace = false, losePlate = false, iron = false, lostAck } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(iron ? an.iron_memory : an.memory))
  const held = () => getActivePlan(memory.planningState(an.key))
  const game = new FakeFactorio({ inventory: { wood: 1, 'copper-plate': 1, coal: 10, lab: 1, 'offshore-pump': 1, boiler: 1, 'steam-engine': 1, pipe: 10 } })
  Object.assign(game.status, { actor_id: 18, epoch: 1, connected_players: 0 })
  const events = []; const providers = []; const ops = []; const recipes = structuredClone(an.recipes)
  if (iron) {
    recipes.splice(0, recipes.length, { name: 'iron-plate', enabled: true, hand_craftable_category: false, energy: 3.2,
      ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1 }], crafting_machines: [{ name: 'stone-furnace' }] })
    game.inventory = { 'iron-plate': 8, coal: 16 }
    game.knownTechnologies.add('steam-power')
  }
  if (furnace) {
    recipes.push({ name: 'copper-plate', enabled: true, hand_craftable_category: false, energy: 3.2,
      ingredients: [{ name: 'copper-ore', amount: 1 }], products: [{ name: 'copper-plate', amount: 1 }], crafting_machines: [{ name: 'stone-furnace' }] })
    game.inventory['copper-plate'] = losePlate ? 1 : 0
    game.inventory['copper-ore'] = 1
    game.inventory.coal = 11 // Ten are protected by the AN kit checkpoint.
  }
  const machine = { unit_number: 45, name: 'stone-furnace', type: 'furnace', energy_source: 'burner', status_name: 'no_fuel', working: false,
    position: { x: 18, y: 109 }, inventories: [1, 2, 3].map(index => ({ index, items: [] })), inventories_truncated: false, inventory_items_truncated: false }
  if (iron) Object.assign(machine, { unit_number: 44, position: { x: -44, y: 59 }, recipe: 'iron-plate' })
  const drill = { ...structuredClone(machine), unit_number: 43, name: 'burner-mining-drill', type: 'mining-drill', position: { x: -43, y: 61 },
    spatial: { item_io: { drop_target: { unit_number: 44 } } } }
  let producedIron = 0
  const native = game.command.bind(game)
  const admissionJournal = game.admissionJournal.bind(game)
  game.admissionJournal = () => {
    const records = game.admissions
    // The shared fixture refreshes records with a batch_id. An explicit native
    // absence resolution has no batch to refresh and must retain its verdict.
    const absent = records.filter(row => row.state === 'not_admitted')
    game.admissions = records.filter(row => row.state !== 'not_admitted')
    try { return [...admissionJournal(), ...absent] }
    finally { game.admissions = records }
  }
  let agent; let preflights = 0
  game.preflight = text => {
    preflights++
    if (losePlate && text.includes('craft_item') && text.includes('copper-cable')) {
      losePlate = false
      game.inventory['copper-plate'] = 0
      const refusal = structuredClone(an.refusal)
      Object.assign(refusal, { requested_count: 1, craftable_now_count: 0 })
      refusal.bootstrap.requested_crafts = 1
      refusal.bootstrap.inventory_overlay.ingredients[0] = { type: 'item', name: 'copper-plate', required: 1, held: 0, missing: 1, status: 'needs_acquisition/processing' }
      return refusal
    }
    if (text.includes('craft_item') && text.includes('copper-cable') && /\['count'\]=2/.test(text)) return structuredClone(an.refusal)
    return { ok: true }
  }
  game.command = async text => {
    await onRead?.({ agent, memory, game, text })
    if (lostAck && text.includes('local ok,result=pcall') && text.includes('"authorize"')) {
      const mode = lostAck
      lostAck = undefined
      if (mode === 'admitted') { await native(text); game.taskState = 'crafting'; game.queueLength = 1 }
      if (mode === 'not_admitted') {
        const encoded = /"begin",helpers\.json_to_table\(("(?:\\.|[^"\\])*")\)/.exec(text)?.[1]
        assert.ok(encoded)
        const identity = JSON.parse(JSON.parse(encoded))
        game.admissions.push({ ...identity, generation: game.generation ?? 1, state: 'not_admitted', slots: [] })
      }
      return '{}'
    }
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",'([^']+)'/.exec(text)?.[1]
      const recipe = recipes.find(row => row.name === name)
      return JSON.stringify(recipe ? { found: true, truncated: false, recipes: [recipe],
        ...(name === 'copper-cable' ? { harvested_from: ['fulgoran-ruin-big'] } : {}) } : { found: false, code: 'no_recipe', mined_from: [], harvested_from: [] })
    }
    if (text.includes('"get_entity_status"')) return JSON.stringify({ found: true, entity: iron && text.includes(',43)') ? drill : machine, observation_mode: 'full' })
    return native(text)
  }
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (_messages, context) => { providers.push(context); throw new Error(`No model repair permitted in AN production replay: ${JSON.stringify({ inventory: game.inventory, events: events.slice(-10).map(row => ({ event: row.event, data: row.data })) })}`) } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: an.key,
    requestInfo: { memoryKey: an.key, turnId: 1, sender: '<server>', text: 'Continue the committed steam kit' }, traceRequest: { id: 'run-an-production' } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => events.push(row) }
  const commit = agent.commitPlan.bind(agent)
  agent.commitPlan = plan => {
    if (agent.productionAdmission && inject > 0 && plan.operations?.[0]?.name === 'craft_item' && plan.operations[0].args.item_name === 'copper-cable') {
      inject--
      // Deliberate residual compiler miss: submit the exact AN count=2 request
      // through real admission. The native preflight, not this hook, refuses it.
      plan = structuredClone(plan)
      plan.operations[0].args.count = 2
    }
    return commit(plan)
  }
  const settle = agent.settleCompletedStepState.bind(agent)
  agent.settleCompletedStepState = async (state, options) => {
    const result = await settle(state, { ...options, allowContinuation: false })
    return result ?? (state?.status === 'completed' ? { sliceComplete: true, goalStatus: memory.planningState(an.key).goal.status } : undefined)
  }
  game.onMutation = text => {
    const op = /remote\.call\('autorio_operations','([a-z_]+)'/.exec(text)?.[1]
    ops.push(op)
    if (iron) {
      if (op === 'supply_entity') {
        const target = text.includes("'supply_entity',43,") ? drill : machine
        target.inventories[0].items = [{ name: 'coal', count: 1 }]
        Object.assign(target, { working: true, status_name: 'working' })
        game.inventory.coal--
        game.lastBasicResult = { type: 'moving_items', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18,
          accepted: true, completed: true, code: 'completed', target_unit_number: target.unit_number, moved_count: 1, item_name: 'coal', to_entity: true }
      }
      if (op === 'wait') {
        machine.inventories[2].items = [{ name: 'iron-plate', count: 7 }]
        producedIron += 7
        if (producedIron >= 50) game.researched.add('steam-power')
      }
      if (op === 'move_items_exact') {
        const count = Number(/'move_items_exact','iron-plate',44,(\d+),false/.exec(text)?.[1])
        assert.ok(count > 0 && count <= 7)
        machine.inventories[2].items[0].count -= count
        game.inventory['iron-plate'] += count
        game.lastBasicResult = { type: 'moving_items', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18,
          accepted: true, completed: true, code: 'completed', target_unit_number: 44, moved_count: count, item_name: 'iron-plate', to_entity: false }
      }
      return
    }
    if (op === 'craft_item') {
      const item = /'craft_item','([^']+)'/.exec(text)?.[1]
      const recipe = recipes.find(row => row.name === item)
      assert.ok(recipe, text)
      for (const input of recipe.ingredients) { assert.ok(game.inventory[input.name] >= input.amount); game.inventory[input.name] -= input.amount }
      game.inventory[recipe.products[0].name] = (game.inventory[recipe.products[0].name] ?? 0) + recipe.products[0].amount
    }
    if (op === 'supply_entity') {
      if (text.includes("item_name='coal'")) { machine.inventories[0].items = [{ name: 'coal', count: 1 }]; machine.status_name = 'no_ingredients'; game.inventory.coal-- }
      else { machine.inventories[1].items = [{ name: 'copper-ore', count: 1 }]; machine.working = true; machine.status_name = 'working'; game.inventory['copper-ore']-- }
    }
    if (op === 'wait') { machine.inventories[1].items = []; machine.inventories[2].items = [{ name: 'copper-plate', count: 1 }]; machine.working = false; machine.status_name = 'no_ingredients' }
    if (op === 'move_items_exact') { machine.inventories[2].items = []; game.inventory['copper-plate']++ }
  }
  const intent = iron ? { targets: [{ item_name: 'iron-plate', count: 58 }], producers: [{ recipe_name: 'iron-plate', unit_number: 44 }],
    feeders: [{ unit_number: 43, output_unit_number: 44 }], fuel: { item_name: 'coal', count: 16 } }
    : { ...poles, ...(furnace ? { producers: [{ recipe_name: 'copper-plate', unit_number: 45 }], fuel: { item_name: 'coal', count: 2 } } : {}) }
  const start = () => agent.commitPlan({ chatMessage: '', stepId: held().steps[held().active_step_index].step_id, plan: [], currentStep: 0, operations: [], productionTask: intent })
  return { agent, game, memory, held, start, intent, ops, events, providers, machine, preflights: () => preflights }
}

test('recorded AN excessive cable intent is refused by the unchanged native preflight boundary', async () => {
  const w = world()
  await w.agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0,
    stepId: w.held().steps[2].step_id, operations: [{ name: 'craft_item', args: { item_name: 'copper-cable', count: 2 } }] }).catch(error => assert.match(error.message, /No model repair permitted/))
  assert.ok(w.events.some(row => row.data?.preflight?.code === an.refusal.code), JSON.stringify(w.events.slice(-10)))
  assert.equal(w.game.mutations.length, 0)
  assert.ok(w.memory.pauseRecord(an.key).paused || w.providers.length === 1, 'the old executable-intent seam does not self-correct the item/craft-unit mistake')
})

test('real AN loop compiles two one-craft batches and closes only the actual inventory contract', async () => {
  const w = world()
  const original = structuredClone(w.held().steps)
  await w.start()
  assert.deepEqual(w.ops, ['craft_item'])
  await w.agent.completed()
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed')
  assert.deepEqual(w.held().steps, original)
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.memory.planningState(an.key).goal.status, 'active', 'kit completion cannot prove automatic red output')
  assert.equal(w.providers.length, 0)
})

test('the real supervisor handles distinct production completions at the same wall-clock instant and coalesces only receipt identity', async () => {
  const w = world()
  await w.start()
  const { session, logs } = recoverySession(w, { actorId: 18, epoch: 1 })
  const originalNow = Date.now
  const instant = originalNow()
  Date.now = () => instant
  try {
    session.onGameLine('[AUTORIO] All operations completed')
    await session.eventQueue
    assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
    session.onGameLine('[AUTORIO] All operations completed')
    await session.eventQueue
    assert.equal(w.memory.currentPlan(an.key).status, 'completed')
    session.onGameLine('[AUTORIO] All operations completed')
    await session.eventQueue
  } finally { Date.now = originalNow }
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  assert.equal(w.providers.length, 0)
  assert.deepEqual(logs.filter(row => /failed|error/i.test(row)), [])
})

test('injected exact AN residual refusal is freshly recompiled and automatically continues through real completed receipts', async () => {
  const w = world({ inject: 1 })
  await w.start()
  await w.agent.completed()
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
  await w.agent.completed()
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.memory.productionTasks.size, 0, 'verified closed steps retire their records without reopening old authority')
  assert.ok(w.events.some(row => row.event === 'production.recovery' && row.data.reason === an.refusal.code && row.data.mechanism === 'fresh_material_recompile'))
  assert.equal(w.providers.length, 0)
})

test('furnace production separates fuel, input, native wait, collection and downstream crafts', async () => {
  const w = world({ furnace: true })
  await w.start()
  for (let i = 0; i < 8 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.deepEqual(w.ops, ['supply_entity', 'supply_entity', 'wait', 'move_items_exact', 'craft_item', 'craft_item'])
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.providers.length, 0)
})

test('an ingredient lost after observation is replaced from actual remaining ore without replaying the refused craft or gathering extra copper', async () => {
  const w = world({ furnace: true, losePlate: true })
  await w.start()
  for (let i = 0; i < 8 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.deepEqual(w.ops, ['supply_entity', 'supply_entity', 'wait', 'move_items_exact', 'craft_item', 'craft_item'])
  assert.equal(w.game.inventory['copper-ore'], 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.events.filter(row => row.event === 'production.recovery').length, 1)
})

test('exact AN iron step retains drill43/furnace44, fuels them once and collects only the remaining 50 plates in separate batches', async () => {
  const w = world({ iron: true })
  const original = structuredClone(w.held().steps)
  await w.start()
  for (let i = 0; i < 22 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed', JSON.stringify(w.events.slice(-8)))
  assert.deepEqual(w.held().steps, original)
  assert.equal(w.game.inventory['iron-plate'], 58)
  assert.equal(w.game.inventory.coal, 14)
  assert.equal(w.ops.filter(name => name === 'supply_entity').length, 2)
  assert.equal(w.ops.filter(name => name === 'move_items_exact').length, 8)
  assert.ok(!w.ops.includes('gather_resource'))
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.planningState(an.key).goal.status, 'active')
})

test('residual exhaustion is durable across restart and cannot be replenished by resubmitting the intent', async () => {
  const w = world({ inject: 10 })
  const result = await w.start()
  assert.equal(result.reason, 'production_recovery_exhausted')
  assert.equal(w.preflights(), PRODUCTION_LIMITS.recoveries + 1)
  const saved = w.memory.snapshot(); const restored = new CanonicalTaskBoardMemory()
  restored.restore(saved)
  const task = [...restored.productionTasks.values()][0]
  assert.equal(task.recoveries, PRODUCTION_LIMITS.recoveries)
  assert.equal(task.status, 'paused')
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(recoverProductionTask(task, 'again').action, 'pause')
})

test('a lost acknowledgment proven not admitted is reconciled then freshly compiled, without a model repair', async () => {
  const w = world({ lostAck: 'not_admitted' })
  try { await w.start() }
  catch (error) { error.message += ` ${JSON.stringify(w.events.filter(row => /operation\.reconciled|operations.admission_failed/.test(row.event)))}`; throw error }
  assert.equal(w.ops.length, 1)
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
  await w.agent.completed()
  await w.agent.completed()
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.providers.length, 0)
})

test('a lost acknowledgment proven admitted stays pending until its receipt; no extra craft is replayed', async () => {
  const w = world({ lostAck: 'admitted' })
  await w.start()
  assert.equal(w.ops.length, 1)
  await continueProductionTask(w.agent)
  assert.equal(w.ops.length, 1)
  w.game.taskState = 'idle'; w.game.queueLength = 0
  await w.agent.completed()
  await w.agent.completed()
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  assert.equal(w.providers.length, 0)
})

test('a missing exact admission record stays uncertain and cannot be treated as proof of absence', async () => {
  const w = world({ lostAck: 'unknown' })
  await assert.rejects(w.start(), /acknowledgement missing/)
  assert.equal(w.ops.length, 0)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pendingOperation(an.key).state, 'unreconciled')
  await continueProductionTask(w.agent)
  assert.equal(w.ops.length, 0)
  assert.equal(w.memory.pendingOperation(an.key).state, 'unreconciled')
})

test('a failure callback with authoritatively completed native work advances the fresh deficit instead of replaying the completed craft', async () => {
  const w = world()
  await w.start()
  await w.agent.failed('late native completion error')
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  assert.equal([...w.memory.productionTasks.values()][0].recoveries, 1)
  await w.agent.completed()
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.providers.length, 0)
})

test('a partial native failure with uncertain effects pauses without issuing a replacement craft', async () => {
  const w = world()
  await w.start()
  w.game.failLastBatch({ type: 'crafting', code: 'interrupted', completed: false, accepted: true })
  const result = await w.agent.failed('crafting:interrupted')
  assert.equal(result.reason, 'production_native_outcome_uncertain')
  assert.equal(w.ops.length, 1)
  assert.equal(w.providers.length, 0)
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
})

for (const fence of ['busy', 'pending', 'actor', 'goal', 'version', 'step', 'stop']) {
  test(`production automatic continuation respects ${fence} fence`, async () => {
    let armed = false
    const w = world({ onRead: ({ game, memory, text, agent }) => {
      if (!armed || !text.includes('"get_inventory_items"')) return
      armed = false
      if (fence === 'actor') game.status.epoch++
      if (fence === 'goal') memory.planningState(an.key).goal.goal_id = 'replacement'
      if (fence === 'version') w.held().plan_version++
      if (fence === 'step') w.held().active_step_index--
      if (fence === 'stop') agent.cancel('user_stop')
    } })
    await w.start()
    await w.agent.taskStatusReceipt()
    if (fence === 'busy') { w.game.status.idle = false; w.game.taskState = 'crafting'; w.game.queueLength = 1 }
    if (fence === 'pending') w.memory.pendingOperations = () => [{ state: 'unreconciled' }]
    armed = true
    try { await continueProductionTask(w.agent) } catch (error) { assert.match(error.message, /epoch|superseded|cancelled/i) }
    assert.equal(w.ops.length, 1)
    assert.equal(w.providers.length, 0)
    if (fence !== 'stop') assert.equal(w.memory.pauseRecord(an.key).paused, false, 'stale work cannot pause another owner')
  })
}

test('malformed durable allowance is fenced instead of reset; deadlines and counters are not executor inputs', () => {
  const task = createProductionTask({ intent: poles, owner, actor_id: 18, epoch: 1, now: 1000 })
  assert.throws(() => restoreProductionTask({ ...task, recoveries: 100 }))
  const memory = new CanonicalTaskBoardMemory()
  memory.restore({ ...an.memory, production_tasks: [['bad', { ...task, recoveries: 100 }]] })
  assert.equal(memory.productionRestoreFault, true)
  assert.equal(advanceProductionTask(task, { ...base, inventory: {} }, task.deadline_at).reason, 'production_task_exhausted')
  const schema = executionOnlyControlToolDefinitions[0].function.parameters.properties.productionTask
  assert.equal(schema.additionalProperties, false)
  const message = { tool_calls: [{ type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify({ stepId: 'step', operations: [], productionTask: { ...poles, recoveries: 0 } }) } }] }
  assert.throws(() => plannerControlPayloadFromMessage(message), /invalid_production_intent/)
})

test('a paused production decision cannot pause or cancel a replacement during state loading', async () => {
  const w = world({ inject: 10 })
  const load = w.agent.loadPersistentState.bind(w.agent)
  w.agent.loadPersistentState = async () => {
    await load()
    if ([...w.memory.productionTasks?.values() ?? []].some(task => task.status === 'paused')) {
      w.memory.planningState(an.key).goal.goal_id = 'replacement-during-pause'
    }
  }
  await assert.rejects(w.start(), /superseded|cancelled/i)
  assert.equal(w.memory.pauseRecord(an.key).paused, false)
  assert.equal(w.agent.active, true)
  assert.equal(w.game.mutations.length, 0)
})

test('only proven closed steps compact durable records; interrupted/exhausted work keeps its limits', () => {
  const w = world()
  const plan = w.held(); const previous = plan.steps[0]
  const priorOwner = { goal_id: w.memory.planningState(an.key).goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: previous.step_id }
  const task = createProductionTask({ intent: poles, owner: priorOwner, actor_id: 18, epoch: 1 })
  const previousKey = `${an.key}/${JSON.stringify([priorOwner.goal_id, priorOwner.plan_id, priorOwner.plan_version, priorOwner.step_id])}`
  const openOwner = { ...priorOwner, step_id: plan.steps[2].step_id }
  const openKey = `${an.key}/${JSON.stringify([openOwner.goal_id, openOwner.plan_id, openOwner.plan_version, openOwner.step_id])}`
  w.memory.productionTasks = new Map([[previousKey, task], [openKey, { ...task, owner: openOwner, status: 'paused', recoveries: 3 }]])
  assert.equal(pruneClosedProductionRecords(w.memory), 1)
  assert.equal(w.memory.productionTasks.get(openKey).recoveries, 3)
  assert.equal(pruneClosedProductionRecords(w.memory), 0)
})
