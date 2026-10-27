import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { compileQuantities } from './quantity-compiler.mjs'
import { claimMaterials, materialAvailability, materialOwnerKey } from './material-ledger.mjs'
import { advanceProductionTask, bindProductionFuelSource, createProductionTask, normalizeProductionIntent, PRODUCTION_LIMITS, recoverProductionTask, restoreProductionTask } from './production-task.mjs'
import { continueProductionTask, pruneClosedProductionRecords } from './production-task-runtime.mjs'
import { chooseBurnerFuel, fuelAllowanceCount, repairTargets } from './production-repair.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { pinLegacyFixtureSkillContext, FakeFactorio } from './task-loop-fixtures.mjs'
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

function world({ inject = 0, onRead, furnace = false, losePlate = false, iron = false, fuelFacts = false, lostAck, provider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(structuredClone(iron ? an.iron_memory : an.memory))
  pinLegacyFixtureSkillContext(memory)
  const held = () => getActivePlan(memory.planningState(an.key))
  const game = new FakeFactorio({ inventory: { wood: 1, 'copper-plate': 1, coal: 10, lab: 1, 'offshore-pump': 1, boiler: 1, 'steam-engine': 1, pipe: 10 } })
  Object.assign(game.status, { actor_id: 18, epoch: 1, connected_players: 0, surface_index: 1 })
  const events = []; const providers = []; const ops = []; const recipes = structuredClone(an.recipes)
  if (iron) {
    recipes.splice(0, recipes.length, { name: 'iron-plate', enabled: true, hand_craftable_category: false, energy: 3.2,
      ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1 }], crafting_machines: [{ name: 'stone-furnace' }] })
    game.inventory = { 'iron-plate': 8, coal: 16 }
    game.knownTechnologies.add('steam-power')
  }
  // Native burner facts (vanilla 2.0 prototypes): what recipe_details and
  // mining_details report for the AN iron machines and accepted fuels.
  const burnerFacts = watts => ({ energy_source: 'burner', energy_watts: watts, burner_effectivity: 1, fuel_categories: ['chemical'] })
  const burnerFuels = { categories: ['chemical'], items: [
    { name: 'coal', category: 'chemical', fuel_value: 4e6, mined_from: ['coal'], harvested_from: [] },
    { name: 'solid-fuel', category: 'chemical', fuel_value: 12e6, mined_from: [], harvested_from: [] },
    { name: 'wood', category: 'chemical', fuel_value: 2e6, mined_from: [], harvested_from: ['tree-01'] }] }
  if (fuelFacts) recipes[0].crafting_machines = [{ name: 'stone-furnace', ...burnerFacts(90000) }]
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
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ actor: { actor_id: 18 }, surface_index: 1, force_index: 1 })
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
      return JSON.stringify(recipe ? { found: true, truncated: false, recipes: [recipe], ...(fuelFacts ? { burner_fuels: burnerFuels } : {}),
        ...(name === 'copper-cable' ? { harvested_from: ['fulgoran-ruin-big'] } : {}) } : { found: false, code: 'no_recipe', mined_from: [], harvested_from: [] })
    }
    if (fuelFacts && text.includes('"mining_details"')) {
      const name = /"mining_details",'([^']+)'/.exec(text)?.[1]
      return JSON.stringify(name === 'iron-ore' ? { found: true, resources: [{ name: 'iron-ore', drills: [{ name: 'burner-mining-drill', ...burnerFacts(150000) }] }] } : { found: false })
    }
    if (text.includes('"autorio_crafting","status"')) return JSON.stringify({ task_active: false, native_queue: [] })
    if (text.includes('"get_entity_status"')) return JSON.stringify({ found: true, actor_id: 18, surface_index: 1, force_index: 1,
      entity: iron && text.includes(',43)') ? drill : machine, observation_mode: 'full' })
    return native(text)
  }
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (messages, context) => { providers.push(context); if (provider) return provider(messages, context); throw new Error(`No model repair permitted in AN production replay: ${JSON.stringify({ inventory: game.inventory, events: events.slice(-10).map(row => ({ event: row.event, data: row.data })) })}`) } })
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
  return { agent, game, memory, held, start, intent, ops, events, providers, machine, drill, preflights: () => preflights }
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

// Run AZ (2026-10-26) production admission. Lane A sent an intermediate
// (iron-gear-wheel 10) for a science-pack step; lane B bound a burner drill and
// furnace without a fuel allowance. Both reply shapes are replayed on the AN
// world, whose committed contracts and burner machines are real recorded state.
const activeStepId = w => w.held().steps[w.held().active_step_index].step_id
const productionReply = (w, productionTask) => ({ content: JSON.stringify({ chatMessage: '', stepId: activeStepId(w), operations: [], productionTask }) })
const intermediate = { targets: [{ item_name: 'copper-cable', count: 2 }] }
function scripted(options, replies) {
  const w = world({ ...options, provider: async () => {
    const next = replies(w).shift()
    if (!next) throw new Error('script exhausted')
    return next
  } })
  w.agent.messages = []; w.agent.baseMessages = []
  return w
}
const failed = w => w.events.filter(row => row.event === 'request.failed')

const repaired = w => w.events.filter(row => row.event === 'production.admission_repaired').map(row => row.data)
const repairMessage = w => w.agent.messages.find(row => row.role === 'user' && row.content.startsWith('[HARNESS] The harness repaired your productionTask'))?.content

test('AZ lane A: an intermediate production target is repaired to the only unmet committed target and reported, with no second reply', async () => {
  let script
  const w = scripted({}, w => script ??= [productionReply(w, intermediate)])
  await w.agent.runTurn()
  assert.deepEqual(repaired(w).map(row => [row.reason, row.rule, row.step_id]), [['production_scope_mismatch', 'only_unmet_committed_target', activeStepId(w)]])
  assert.match(repairMessage(w), /targets set to small-electric-pole 2 from the committed checkpoint, its only target not yet held \(not in it: copper-cable 2\) \(refused as production_scope_mismatch\)/)
  assert.ok(w.agent.messages.some(row => row.role === 'assistant' && JSON.parse(row.content).productionTask?.targets?.[0]?.item_name === 'copper-cable'), 'the model sees its own intent before the repair')
  assert.equal(w.events.some(row => row.event === 'recovery.classified' && row.data.reason_code === 'production_scope_mismatch'), false)
  assert.equal(w.providers.length, 1)
  assert.deepEqual(failed(w), [])
  assert.deepEqual(w.ops, ['craft_item'])
  await w.agent.completed()
  assert.deepEqual(w.ops, ['craft_item', 'craft_item'])
  await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed')
  assert.equal(w.game.inventory['small-electric-pole'], 2)
})

test('AZ lane A residual: a scope refusal past the parse screen is repaired in commitPlan, spends the step repair and continues', async () => {
  const w = scripted({}, () => [])
  await w.agent.commitPlan({ chatMessage: '', stepId: activeStepId(w), plan: [], currentStep: 0, operations: [], productionTask: intermediate })
  assert.deepEqual(repaired(w).map(row => row.reason), ['production_scope_mismatch'])
  assert.ok(repairMessage(w))
  assert.equal(w.providers.length, 0)
  assert.deepEqual(failed(w), [])
  assert.deepEqual(w.ops, ['craft_item'])
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual([...restored.productionRepairLedger.entries()], [[w.agent.productionRepairKey('production_scope_mismatch'), 1]])
  await w.agent.completed()
  await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed')
})

test('a repeated gap after the step repair is spent goes back to the executor, bounded, durable and ending in a visible guard pause', async () => {
  const seen = []
  const w = scripted({}, w => { seen.push(...w.agent.messages.filter(row => row.role === 'user').map(row => row.content)); return [productionReply(w, intermediate)] })
  w.memory.productionRepairLedger = new Map([[w.agent.productionRepairKey('production_scope_mismatch'), 1]])
  // Deliberately bypass the parse screen so every refusal reaches commitPlan.
  w.agent.parsePlanMessageChecked = async message => w.agent.parsePlanMessage(message)
  const result = await w.agent.commitPlan({ chatMessage: '', stepId: activeStepId(w), plan: [], currentStep: 0, operations: [], productionTask: intermediate })
  assert.deepEqual(repaired(w), [])
  assert.equal(result.goalStatus, 'paused')
  assert.equal(w.providers.length, 2)
  assert.deepEqual(w.events.filter(row => row.event === 'production.admission_correction').map(row => row.data.attempt), [1, 2])
  assert.ok(seen.some(content => /productionTask refused \(production_scope_mismatch\).*Nothing ran/.test(content)), JSON.stringify(seen))
  assert.equal(w.events.find(row => row.event === 'production.admission_exhausted')?.data.attempts, 2)
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.equal(w.events.find(row => row.event === 'request.completed')?.data.outcome, 'production_admission_exhausted')
  assert.deepEqual(w.ops, [])
  assert.equal(w.memory.productionTasks?.size ?? 0, 0, 'a refused intent never becomes durable authority')
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual([...restored.productionAdmissionLedger.values()], [2])
})

test('AZ lane B without readable fuel facts: burner bindings without a fuel allowance stay a parse correction, and the corrected intent fuels them', async () => {
  let script
  const unfueled = w => { const { fuel: _fuel, ...rest } = w.intent; return rest }
  const w = scripted({ iron: true }, w => script ??= [productionReply(w, unfueled(w)), productionReply(w, w.intent)])
  await w.agent.runTurn()
  const refusal = w.events.find(row => row.event === 'recovery.classified' && row.data.reason_code === 'production_fuel_allowance_missing')
  assert.ok(refusal, JSON.stringify(w.events.slice(-6)))
  assert.match(refusal.data.reason, /44 stone-furnace, 43 burner-mining-drill/)
  assert.ok(w.events.some(row => row.event === 'production.read' && row.data.phase === 'admission'))
  assert.deepEqual(failed(w), [])
  assert.equal(w.providers.length, 2)
  for (let i = 0; i < 22 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed', JSON.stringify(w.events.slice(-8)))
  assert.equal(w.game.inventory['iron-plate'], 58)
  assert.equal(w.ops.filter(name => name === 'supply_entity').length, 2)
})

const unfueledIntent = w => { const { fuel: _fuel, ...rest } = w.intent; return rest }
const runIron = async w => {
  for (let i = 0; i < 22 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed', JSON.stringify(w.events.slice(-8)))
  assert.equal(w.game.inventory['iron-plate'], 58)
}

test('AZ lane B: the only held accepted fuel is set from native burner facts with a time-bounded cap, without asking the model', async () => {
  let script
  const w = scripted({ iron: true, fuelFacts: true }, w => script ??= [productionReply(w, unfueledIntent(w))])
  await w.agent.runTurn()
  // furnace 90 kW and drill 150 kW for 1800 s on 4 MJ coal: 41 + 68.
  assert.deepEqual(repaired(w).map(row => [row.reason, row.rule]), [['production_fuel_allowance_missing', 'the only accepted fuel held']])
  assert.match(repairMessage(w), /fuel set to coal with cap 109 \(the only accepted fuel held\) for the bound burner machines 44 stone-furnace, 43 burner-mining-drill, which burn chemical fuel/)
  assert.match(repairMessage(w), /Added resource coal via gather_resource/)
  const record = [...w.memory.productionTasks.values()][0]
  assert.deepEqual(record.intent.fuel, { item_name: 'coal', count: 109 })
  assert.deepEqual(record.intent.resources, [{ item_name: 'coal', method: 'gather_resource' }])
  assert.equal(w.providers.length, 1)
  assert.deepEqual(failed(w), [])
  await runIron(w)
  assert.equal(w.ops.filter(name => name === 'supply_entity').length, 2)
})

test('the harness picks the cheapest held fuel unless the executor wrote a usable burner_fuel default, which persists and is shown back', async () => {
  const cheapest = scripted({ iron: true, fuelFacts: true }, w => [productionReply(w, unfueledIntent(w))])
  cheapest.game.inventory.wood = 5
  await cheapest.agent.runTurn()
  assert.match(repairMessage(cheapest), /fuel set to wood with cap 216 \(the cheapest of the held accepted fuels coal, wood\)/)

  let script
  const w = scripted({ iron: true, fuelFacts: true }, w => script ??= [{ content: JSON.stringify({ chatMessage: '', stepId: activeStepId(w), operations: [], productionTask: unfueledIntent(w), defaults: { burner_fuel: 'coal' } }) }])
  w.game.inventory.wood = 5
  await w.agent.runTurn()
  assert.deepEqual(repaired(w).map(row => row.rule), ['your default burner_fuel'])
  assert.deepEqual([...w.memory.productionTasks.values()][0].intent.fuel, { item_name: 'coal', count: 109 })
  assert.deepEqual(w.events.find(row => row.event === 'harness.defaults_set')?.data.defaults, { burner_fuel: 'coal' })
  const key = w.agent.activePlanKey()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual(restored.harnessDefaults.get(key), { burner_fuel: 'coal' })
  const packet = w.agent.buildRestagePacket({ checkpoint: 'C3', role: 'executor', reason: 'x' })
  assert.match(packet.text, /harness_defaults \(written by you with defaults:\{\.\.\.\}; applied when a productionTask leaves them out and the game accepts them\): burner_fuel=coal/)
  assert.doesNotMatch(w.agent.buildRestagePacket({ checkpoint: 'C1', role: 'planner', reason: 'x' }).text, /harness_defaults/)
  assert.equal(executionOnlyControlToolDefinitions[0].function.parameters.properties.defaults.properties.burner_fuel.type, 'string')
})

test('a default the machines cannot use is ignored and named, and an invalid defaults object is a bounded correction', async () => {
  let script
  const w = scripted({ iron: true, fuelFacts: true }, w => script ??= [
    { content: JSON.stringify({ chatMessage: '', stepId: activeStepId(w), operations: [], productionTask: unfueledIntent(w), defaults: { burner_fuel: 'coal', belt_speed: 'fast' } }) },
    { content: JSON.stringify({ chatMessage: '', stepId: activeStepId(w), operations: [], productionTask: unfueledIntent(w), defaults: { burner_fuel: 'solid-fuel' } }) }])
  await w.agent.runTurn()
  assert.ok(w.events.some(row => row.event === 'recovery.classified' && row.data.reason_code === 'invalid_defaults'), JSON.stringify(w.events.slice(-6)))
  assert.equal(w.providers.length, 2)
  // solid-fuel is accepted but has no natural source and none is held.
  assert.match(repairMessage(w), /fuel set to coal with cap 109 \(the only accepted fuel held; your default burner_fuel solid-fuel is not an accepted fuel these machines can get\)/)
  assert.deepEqual(w.memory.harnessDefaults.get(w.agent.activePlanKey()), { burner_fuel: 'solid-fuel' }, 'the default stays the model\'s to change')
})

test('target repair keeps named committed items at committed counts and otherwise needs exactly one unmet committed target', () => {
  const contract = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'small-electric-pole', minimum: 2 }, { kind: 'inventory_count', item_name: 'lab', minimum: 1 }] }
  const intent = targets => ({ targets, producers: [], resources: [], feeders: [] })
  assert.deepEqual(repairTargets(intent([{ item_name: 'lab', count: 3 }, { item_name: 'copper-cable', count: 2 }]), contract).targets, [{ item_name: 'lab', count: 1 }])
  assert.equal(repairTargets(intent([{ item_name: 'copper-cable', count: 2 }]), contract, { lab: 1 }).targets[0].item_name, 'small-electric-pole')
  assert.equal(repairTargets(intent([{ item_name: 'copper-cable', count: 2 }]), contract, {}), undefined, "two unmet committed targets stay the executor's choice")
  assert.equal(repairTargets(intent([{ item_name: 'copper-cable', count: 2 }]), contract, undefined), undefined, 'an unreadable inventory is not a fact')
  assert.equal(repairTargets(intent([{ item_name: 'copper-cable', count: 2 }]), { mode: 'any', requirements: contract.requirements }, { lab: 1 }), undefined)
})

test('only the step executor can write harness defaults', async () => {
  const w = world()
  w.agent.agentContext.beginLineage('planner')
  await assert.rejects(async () => w.agent.parsePlanMessage({ content: JSON.stringify({ chatMessage: '', plan: [], currentStep: 0, operations: [], defaults: { burner_fuel: 'coal' } }) }),
    error => error.code === 'invalid_defaults' && /written by the step executor/.test(error.message))
})

test('burner fuel choice and cap follow the native facts only', () => {
  const coal = { name: 'coal', category: 'chemical', fuel_value: 4e6, mined_from: ['coal'] }
  const wood = { name: 'wood', category: 'chemical', fuel_value: 2e6, harvested_from: ['tree-01'] }
  const solid = { name: 'solid-fuel', category: 'chemical', fuel_value: 12e6, mined_from: [], harvested_from: [] }
  const fuels = [coal, solid, wood]
  assert.equal(chooseBurnerFuel({ fuels, held: { coal: 3, 'solid-fuel': 2, wood: 1 } }).fuel, wood, 'natural before crafted, then least energy')
  assert.equal(chooseBurnerFuel({ fuels, held: { 'solid-fuel': 2 } }).rule, 'the only accepted fuel held')
  assert.equal(chooseBurnerFuel({ fuels, held: { coal: 3, 'solid-fuel': 2 }, preferred: 'solid-fuel' }).rule, 'your default burner_fuel')
  assert.deepEqual(chooseBurnerFuel({ fuels, held: {}, preferred: 'uranium-fuel-cell' }), { ignored: 'uranium-fuel-cell' }, 'two natural fuels and none held stays the model\'s call')
  assert.equal(chooseBurnerFuel({ fuels: [coal, solid], held: {} }).rule, 'the only accepted fuel with a natural source')
  assert.equal(chooseBurnerFuel({ fuels: [coal], held: {}, preferred: 'coal' }).rule, 'your default burner_fuel')
  const burners = [{ energy_watts: 90000, burner_effectivity: 1 }, { energy_watts: 150000, burner_effectivity: 1 }]
  assert.equal(fuelAllowanceCount(burners, coal), 109)
  assert.equal(fuelAllowanceCount(burners, solid, 2), 2, 'a crafted fuel is capped at what is held')
  assert.equal(fuelAllowanceCount([{ energy_watts: 1, burner_effectivity: 1 }], coal), 1)
  assert.equal(fuelAllowanceCount([{ energy_watts: 90000, burner_effectivity: 0.5 }], coal), 81)
})

test('a production record predating the fuel rule keeps its immutable intent and halts naming the missing grant', async () => {
  const w = world({ iron: true })
  const { fuel: _fuel, ...unfueled } = w.intent
  const o = w.agent.captureCheckpointOwner()
  const owner = { goal_id: o.goalId, plan_id: o.planId, plan_version: o.planVersion, step_id: o.stepId }
  w.memory.productionTasks = new Map([[`${o.key}/${materialOwnerKey(owner)}`, createProductionTask({ intent: unfueled, owner, actor_id: 18, epoch: 1 })]])
  const result = await w.agent.commitPlan({ chatMessage: '', stepId: o.stepId, plan: [], currentStep: 0, operations: [], productionTask: unfueled })
  assert.equal(result.reason, 'production_fuel_allowance_missing')
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.deepEqual(w.ops, [])
  assert.equal(w.providers.length, 0)
})

test('a missing fuel allowance and a spent one are distinct durable halts', () => {
  const recipe = { name: 'iron-plate', enabled: true, hand_craftable_category: false, energy: 3.2,
    ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1 }], crafting_machines: [{ name: 'stone-furnace' }] }
  const burner = { energy_source: 'burner', status_name: 'no_fuel', working: false, input: {}, output: {}, fuel: {}, progress: null }
  const facts = { ...base, recipes: [recipe], inventory: { 'iron-plate': 8 }, machines: [
    { ...burner, unit_number: 43, name: 'burner-mining-drill', type: 'mining-drill', drop_target: 44 },
    { ...burner, unit_number: 44, name: 'stone-furnace', type: 'furnace', recipe: 'iron-plate' },
  ] }
  const intent = { targets: [{ item_name: 'iron-plate', count: 58 }], producers: [{ recipe_name: 'iron-plate', unit_number: 44 }], feeders: [{ unit_number: 43, output_unit_number: 44 }] }
  assert.equal(advanceProductionTask(createProductionTask({ intent, owner, actor_id: 18, epoch: 1 }), facts).reason, 'production_fuel_allowance_missing')
  const spent = { ...createProductionTask({ intent: { ...intent, fuel: { item_name: 'coal', count: 1 } }, owner, actor_id: 18, epoch: 1 }), fuel_used: 1 }
  assert.equal(advanceProductionTask(spent, facts).reason, 'production_fuel_allowance_exhausted')
})

test('the parse screen leaves a stale stepId to the step-identity correction', async () => {
  const w = world()
  const other = w.held().steps.find(step => step.step_id !== activeStepId(w)).step_id
  const plan = await w.agent.parsePlanMessageChecked({ content: JSON.stringify({ chatMessage: '', stepId: other, operations: [], productionTask: intermediate }) })
  assert.equal(plan.stepId, other)
  assert.deepEqual(w.events.filter(row => row.event === 'production.read'), [])
})

// Run BB lane A: the executor sent fuel {coal, 3} with only an iron-ore binding. A cap is not stock; admission must
// prove a way to fetch the fuel it may spend, and a record that still lacks one is repaired once, durably, or pauses.
const overCap = (w, count) => ({ ...w.intent, fuel: { item_name: 'coal', count } })
const fuelRecord = (w, intent, extra = {}) => {
  const o = w.agent.captureCheckpointOwner()
  const owner = { goal_id: o.goalId, plan_id: o.planId, plan_version: o.planVersion, step_id: o.stepId }
  w.memory.productionTasks = new Map([[`${o.key}/${materialOwnerKey(owner)}`, { ...createProductionTask({ intent, owner, actor_id: 18, epoch: 1 }), ...extra }]])
  return () => w.agent.commitPlan({ chatMessage: '', stepId: o.stepId, plan: [], currentStep: 0, operations: [], productionTask: intent })
}

test('Run BB lane A: an explicit fuel cap above held stock without a fuel binding is given the native fuel source before admission', async () => {
  let script
  const w = scripted({ iron: true, fuelFacts: true }, w => script ??= [productionReply(w, overCap(w, 40))])
  await w.agent.runTurn()
  assert.deepEqual(repaired(w).map(row => [row.reason, row.rule]), [['production_fuel_source_unbound', 'the native source of the allowance fuel']])
  assert.match(repairMessage(w), /Added resource coal via gather_resource so your fuel allowance coal 40 can be met; you hold less than that and the bound burner machines 44 stone-furnace, 43 burner-mining-drill accept it/)
  const record = [...w.memory.productionTasks.values()][0]
  assert.deepEqual(record.intent.fuel, { item_name: 'coal', count: 40 }, 'the executor cap is unchanged')
  assert.deepEqual(record.intent.resources, [{ item_name: 'coal', method: 'gather_resource' }])
  assert.equal(w.providers.length, 1)
  assert.deepEqual(failed(w), [])
  await runIron(w)
})

test('Run BB lane A without readable fuel facts: the unbound explicit cap is a bounded executor correction naming held stock', async () => {
  let script
  const w = scripted({ iron: true }, w => script ??= [productionReply(w, overCap(w, 40)), productionReply(w, w.intent)])
  await w.agent.runTurn()
  const refusal = w.events.find(row => row.event === 'recovery.classified' && row.data.reason_code === 'production_fuel_source_unbound')
  assert.ok(refusal, JSON.stringify(w.events.slice(-6)))
  assert.match(refusal.data.reason, /fuel allowance coal 40 for 44 stone-furnace, 43 burner-mining-drill is a cap, not stock: you hold 16 and resources has no coal binding/)
  assert.deepEqual(repaired(w), [])
  assert.equal(w.providers.length, 2)
  assert.deepEqual(failed(w), [])
  await runIron(w)
})

test('Run BB lane A residual: an admitted record with no way to fetch its fuel gets one durable native source, spends a recovery and gathers', async () => {
  const w = world({ iron: true, fuelFacts: true })
  w.game.inventory.coal = 0
  const intent = { ...w.intent, resources: [{ item_name: 'iron-ore', method: 'gather_resource' }], fuel: { item_name: 'coal', count: 3 } }
  await fuelRecord(w, intent)()
  const recovery = w.events.find(row => row.event === 'production.recovery' && row.data.mechanism === 'fuel_source_binding')
  assert.deepEqual([recovery?.data.reason, recovery?.data.outcome, recovery?.data.binding], ['production_resource_unbound:coal', 'reconcile', { item_name: 'coal', method: 'gather_resource' }])
  const record = [...w.memory.productionTasks.values()][0]
  assert.deepEqual(record.intent, normalizeProductionIntent(intent), 'the immutable intent is untouched')
  assert.deepEqual([record.fuel_source, record.recoveries], [{ item_name: 'coal', method: 'gather_resource' }, 1])
  const gather = w.events.find(row => row.event === 'production.execute')?.data.operation
  assert.deepEqual([gather?.name, gather?.args.resource_name, gather?.args.count], ['gather_resource', 'coal', 1])
  assert.equal(w.memory.pauseRecord(an.key)?.paused ?? false, false)
  assert.deepEqual(restoreProductionTask(JSON.parse(JSON.stringify(record))).fuel_source, record.fuel_source, 'the source survives a restart')
  assert.equal(w.providers.length, 0)
})

test('Run BB lane A residual without readable fuel facts keeps the visible guard pause and sends nothing', async () => {
  const w = world({ iron: true })
  w.game.inventory.coal = 0
  const result = await fuelRecord(w, overCap(w, 3))()
  assert.equal(result.reason, 'production_resource_unbound:coal')
  assert.equal(w.events.find(row => row.event === 'production.recovery' && row.data.mechanism === 'fuel_source_binding')?.data.outcome, 'unproven')
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.deepEqual(w.ops, [])
  assert.equal([...w.memory.productionTasks.values()][0].fuel_source, undefined)
})

test('a residual fuel source is bounded by the recovery limit, set once, and only for the allowance fuel', async () => {
  const intent = { targets: [{ item_name: 'iron-plate', count: 58 }], producers: [{ recipe_name: 'iron-plate', unit_number: 44 }], fuel: { item_name: 'coal', count: 3 } }
  const task = createProductionTask({ intent, owner, actor_id: 18, epoch: 1 })
  const coal = { item_name: 'coal', method: 'gather_resource' }
  assert.equal(bindProductionFuelSource({ ...task, recoveries: PRODUCTION_LIMITS.recoveries }, coal).reason, 'production_recovery_exhausted')
  const bound = bindProductionFuelSource(task, coal)
  assert.equal(bound.action, 'reconcile')
  assert.equal(bindProductionFuelSource(bound.task, coal).reason, 'production_fuel_source_unrepairable')
  assert.throws(() => bindProductionFuelSource(task, { item_name: 'wood', method: 'harvest_product' }), /invalid_production_fuel_source/)
  assert.throws(() => restoreProductionTask({ ...bound.task, fuel_source: { item_name: 'iron-ore', method: 'gather_resource' } }), /invalid_production_fuel_source/)
  const w = world({ iron: true, fuelFacts: true })
  w.game.inventory.coal = 0
  const exhausted = await fuelRecord(w, overCap(w, 3), { recoveries: PRODUCTION_LIMITS.recoveries })()
  assert.equal(exhausted.reason, 'production_recovery_exhausted')
  assert.deepEqual(w.ops, [])
})

// A-R1-1: compatibility is proven only for the complete bound set. Machine `unit` reads as absent from its
// `from`-th getEntityStatus read on (1 = every read, 2 = only the repair's reads after the controller's own).
const hideMachine = (w, unit, from) => {
  let reads = 0
  const command = w.game.command
  w.game.command = async text => {
    if (text.includes('"get_entity_status"') && text.includes(`,${unit})`) && ++reads >= from) return JSON.stringify({ found: false })
    return command(text)
  }
}

test('A-R1-1: an unreadable bound producer or feeder blocks the admission fuel-source repair, leaving the executor correction', async () => {
  for (const unit of [43, 44]) {
    let script
    const w = scripted({ iron: true, fuelFacts: true }, w => script ??= [productionReply(w, overCap(w, 40)), productionReply(w, overCap(w, 40))])
    hideMachine(w, unit, 1)
    await w.agent.runTurn().catch(error => assert.match(error.message, /script exhausted/)) // the executor keeps sending the unrepairable cap
    assert.deepEqual(repaired(w), [], `unit ${unit}`)
    assert.ok(w.events.some(row => row.event === 'recovery.classified' && row.data.reason_code === 'production_fuel_source_unbound'), `unit ${unit}`)
    assert.equal(w.memory.productionTasks?.size ?? 0, 0)
    assert.deepEqual(w.ops, [])
  }
})

test('A-R1-1: an unreadable bound producer or feeder during residual recovery sends nothing, spends no recovery and traces unproven', async () => {
  for (const unit of [43, 44]) {
    const w = world({ iron: true, fuelFacts: true })
    w.game.inventory.coal = 0
    hideMachine(w, unit, 2)
    const result = await fuelRecord(w, overCap(w, 3))()
    assert.equal(result.reason, 'production_resource_unbound:coal', `unit ${unit}`)
    assert.equal(w.events.find(row => row.event === 'production.recovery' && row.data.mechanism === 'fuel_source_binding')?.data.outcome, 'unproven')
    const record = [...w.memory.productionTasks.values()][0]
    assert.deepEqual([record.fuel_source, record.recoveries], [undefined, 0])
    assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
    assert.deepEqual(w.ops, [])
  }
})

test('Run BB lane A residual continues through real completed receipts: gathered coal refuels both burners and the step closes', async () => {
  const w = world({ iron: true, fuelFacts: true })
  w.game.inventory.coal = 0
  const mutate = w.game.onMutation
  w.game.onMutation = text => {
    if (text.includes("'autorio_operations','gather_resource'") && text.includes('coal')) w.game.inventory.coal = (w.game.inventory.coal ?? 0) + 1
    return mutate(text)
  }
  const intent = { ...w.intent, resources: [{ item_name: 'iron-ore', method: 'gather_resource' }], fuel: { item_name: 'coal', count: 3 } }
  await fuelRecord(w, intent)()
  await runIron(w)
  assert.deepEqual(w.ops.filter(name => ['gather_resource', 'supply_entity'].includes(name)), ['gather_resource', 'supply_entity', 'gather_resource', 'supply_entity'])
  assert.equal(w.events.filter(row => row.event === 'production.recovery' && row.data.mechanism === 'fuel_source_binding').length, 1, 'the source is bound once')
  assert.deepEqual(failed(w), [])
  assert.equal(w.providers.length, 0)
})
