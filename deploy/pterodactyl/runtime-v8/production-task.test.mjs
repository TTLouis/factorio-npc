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
import { pauseStrandedPlanAfterRequestError } from './supervisor.mjs'
import { plannerControlPayloadFromMessage, executionOnlyControlToolDefinitions } from './structured-policy.mjs'
import { installProductionFactoryFixture } from './bg-production-binding-fixtures.mjs'
import { registerFactoryCell } from './factory-registry.mjs'

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

function world({ inject = 0, onRead, furnace = false, losePlate = false, iron = false, fuelFacts = false, lostAck, provider, priorPlacement = false, dormantOutput = false, manualBootstrap = false, manualGoalScope = 'long_horizon' } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const fixture = structuredClone(iron ? an.iron_memory : an.memory)
  if (manualBootstrap) {
    // BJ's public W6/W18 shape; identities/geometry use this existing native fixture.
    const state = fixture.planning_states.find(row => row.key === an.key).state
    const plan = getActivePlan(state); const step = plan.steps[plan.active_step_index]
    step.description = 'Smelt and collect ten copper plates and verify electronics.'
    step.completion_contract = { mode: 'all', confidence: 0, requirements: [
      { id: 'plates', kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 },
      { id: 'electronics', kind: 'research_completed', technology: 'electronics' },
    ] }
    step.execution_guidance = { approach: 'Supply the exact retained furnace for the finite bootstrap.', rationale: 'The committed manual method enables later automation.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: 'copper-ore' } }
    if (manualGoalScope === 'finite') state.goal.definition = { ...state.goal.definition, scope: 'finite', done_when: structuredClone(step.completion_contract.requirements) }
    const legacy = fixture.plans.find(row => row.key === an.key).state
    legacy.plan[legacy.current_step] = step.description
    const boardStep = legacy.task_board.steps[legacy.task_board.active_index]
    boardStep.description = step.description; boardStep.completion_contract = structuredClone(step.completion_contract)
  }
  memory.restore(fixture)
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
  if (manualBootstrap) {
    game.inventory = { 'copper-ore': 10, 'copper-plate': 0, coal: 5 }
    game.knownTechnologies.add('electronics')
  }
  const machine = { unit_number: 45, name: 'stone-furnace', type: 'furnace', energy_source: 'burner', status_name: 'no_fuel', working: false,
    position: { x: 18, y: 109 }, crafting_progress: 0, inventories: [1, 2, 3].map(index => ({ index, items: [] })), inventories_truncated: false, inventory_items_truncated: false }
  if (iron) Object.assign(machine, { unit_number: 44, position: { x: -44, y: 59 }, recipe: 'iron-plate' })
  const drill = { ...structuredClone(machine), unit_number: 43, name: 'burner-mining-drill', type: 'mining-drill', position: { x: -43, y: 61 },
    spatial: { item_io: { drop_target: { unit_number: 44 } } } }
  let producedIron = 0; let producedCopper = 0
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
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { actor_id: 18, valid: true, kind: 'standalone_character' }, surface_index: 1, force_index: 1 })
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
      return JSON.stringify(recipe ? { found: true, truncated: false, recipes: [{ ...recipe,
        ingredients: recipe.ingredients.map(row => ({ type: 'item', ...row })), products: recipe.products.map(row => ({ type: 'item', ...row })) }], ...(fuelFacts ? { burner_fuels: burnerFuels } : {}),
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
  agent = new NpcAgentLoop({ allowEphemeralSkillHandoff: true, rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (messages, context) => { providers.push(context); if (provider) return provider(messages, context); throw new Error(`No model repair permitted in AN production replay: ${JSON.stringify({ inventory: game.inventory, events: events.slice(-10).map(row => ({ event: row.event, data: row.data })) })}`) } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: an.key,
    requestInfo: { memoryKey: an.key, turnId: 1, sender: '<server>', text: 'Continue the committed steam kit' }, traceRequest: { id: 'run-an-production' } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => events.push(row) }
  const locator = entity => ({ unit_number: entity.unit_number, name: entity.name, position: entity.position, surface_index: 1, force_index: 1 })
  const factory = installProductionFactoryFixture({ agent, memory, game, key: an.key, plan: held,
    step: () => held().steps[priorPlacement ? 0 : held().active_step_index], machines: new Map((iron ? [drill, machine] : [machine]).map(row => [row.unit_number, row])), recipes,
    projectMember: row => {
      row.fuel_item_facts.items = burnerFuels.items.map(({ name, category, fuel_value }) => ({ name, category, fuel_value }))
      if (!iron) return row
      if (row.locator.unit_number === drill.unit_number) {
        row.recipe = { state: 'unsupported', truncated: false, ingredients: [], products: [] }
        row.progress_facts = { products_finished: { state: 'not_applicable' }, crafting_progress: { state: 'not_applicable' } }
        row.source_resources = { state: 'known', truncated: false, resources: [{ name: 'iron-ore', products_truncated: false, products: [{ type: 'item', name: 'iron-ore' }] }] }
        row.item_routes = { state: 'known', truncated: false, routes: [{ kind: 'drop', state: 'connected', target: locator(machine) }] }
        row.endpoint_facts.item_drop = row.item_routes
      } else {
        row.progress_facts.products_finished = { state: 'known', value: producedIron }
        row.incoming_item_facts = { schema_version: 1, tick: 1000 + game.batchId, state: 'known', coverage: 'complete', truncated: false, unresolved: false,
          producers: [{ relation: 'mining_drop', state: 'connected', producer: locator(drill) }] }
      }
      return row
    } })
  if (furnace || iron) factory.retain(machine)
  if (iron) {
    const members = [drill, machine].map(entity => ({ ...locator(entity), provenance: { source: 'npc_placement_receipt', receipt_id: factory.retain(entity).receipt_id } }))
    // Explicit synthetic retained assignment: the historical plan alone does not
    // authorize adoption of a drill or a furnace as a new production supplier.
    memory.restore({ ...memory.snapshot(), factory_registry: registerFactoryCell(memory.getFactoryRegistry(), {
      surface_index: 1, force_index: 1, assignment: { products: ['iron-plate'], purpose: 'Retain the synthetic iron supplier', method: 'direct_feed' },
      members, ports: [{ port_id: 'output', kind: 'item', direction: 'output', resource: 'iron-plate' }], origin: { source: 'synthetic_fixture' } }) })
  }
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
    if (op === 'wait') game.lastBasicResult = { type: 'waiting', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18,
      accepted: true, completed: true, code: 'completed' }
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
      else { machine.inventories[1].items = [{ name: 'copper-ore', count: 1 }]; machine.recipe = 'copper-plate'; machine.working = true; machine.status_name = 'working'; game.inventory['copper-ore']-- }
    }
    if (op === 'wait') { machine.inventories[1].items = []; machine.inventories[2].items = [{ name: 'copper-plate', count: 1 }]; machine.working = false; machine.status_name = 'no_ingredients'; if (dormantOutput) delete machine.recipe; if (manualBootstrap && ++producedCopper >= 10) game.researched.add('electronics') }
    if (op === 'move_items_exact') { machine.inventories[2].items = []; game.inventory['copper-plate']++ }
  }
  const intent = iron ? { targets: [{ item_name: 'iron-plate', count: 58 }], producers: [{ recipe_name: 'iron-plate', unit_number: 44 }],
    feeders: [{ unit_number: 43, output_unit_number: 44 }], fuel: { item_name: 'coal', count: 16 } }
    : { ...poles, ...(furnace ? { producers: [{ recipe_name: 'copper-plate', unit_number: 45 }], fuel: { item_name: 'coal', count: 2 } } : {}) }
  const start = () => agent.commitPlan({ chatMessage: '', stepId: held().steps[held().active_step_index].step_id, plan: [], currentStep: 0, operations: [], productionTask: intent })
  return { agent, game, memory, held, start, intent, ops, events, providers, machine, drill, preflights: () => preflights }
}

test('BJ manual bootstrap raw supply enters finite production under the unchanged long-horizon goal', async () => {
  const w = world({ furnace: true, priorPlacement: true, dormantOutput: true, manualBootstrap: true, fuelFacts: true })
  assert.equal(w.memory.planningState(an.key).goal.definition.scope, 'long_horizon')
  const step = w.held().steps[w.held().active_step_index]
  w.agent.recordLiveEntityToolResult('getEntityStatus', await w.game.command(w.agent.observationToolCommand('getEntityStatus', { unit_number: 45 })))
  await w.agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, stepId: step.step_id,
    operations: [{ name: 'supply_entity', args: { unit_number: 45, items: [{ item_name: 'copper-ore', count: 10 }, { item_name: 'coal', count: 5 }] } }] })
  assert.equal(w.memory.getFactoryRegistry().cells.length, 1)
  assert.equal(w.providers.length, 0)
})

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

for (const limit of ['transitions', 'deadline', 'stalled']) {
  test(`fulfilled stock cannot bypass or renew the ${limit} limit while waiting for direct delivery`, async () => {
    const w = world({ iron: true })
    w.game.inventory['iron-plate'] = 58
    w.game.onMutation = () => {} // Explicit residual: native wait drains but production makes no progress.
    await w.start()
    const [key, task] = [...w.memory.productionTasks.entries()][0]
    assert.equal(task.status, 'active', 'stock alone cannot persist completed production')
    assert.deepEqual(w.ops, []) // This override deliberately does not record fake gameplay effects.
    assert.equal(w.game.mutations.length, 1)
    const expired = { ...task,
      ...(limit === 'transitions' ? { transitions: PRODUCTION_LIMITS.transitions } : {}),
      ...(limit === 'deadline' ? { deadline_at: Date.now() - 1 } : {}),
      ...(limit === 'stalled' ? { last_progress_at: Date.now() - PRODUCTION_LIMITS.stalled_ms - 1 } : {}) }
    w.memory.productionTasks.set(key, expired)
    await w.agent.completed()
    assert.equal(w.game.mutations.length, 1, 'exhaustion cannot submit another wait')
    assert.equal(w.memory.productionTasks.get(key).status, 'paused')
    assert.equal(w.memory.productionTasks.get(key).deadline_at, expired.deadline_at)
    assert.equal(w.providers.length, 0)
  })
}

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

// Inject the finite registration miss after admission, using the real retained
// placement and controller. Synthetic native facts remain in this fixture.
function missingFactoryRegistration() {
  const w = world({ furnace: true, priorPlacement: true })
  const o = w.agent.captureCheckpointOwner()
  const owner = { goal_id: o.goalId, plan_id: o.planId, plan_version: o.planVersion, step_id: o.stepId }
  const protected_stock = Object.fromEntries(w.held().steps[w.held().active_step_index].completion_contract.requirements
    .filter(row => row.kind === 'inventory_count' && !w.intent.targets.some(target => target.item_name === row.item_name))
    .map(row => [row.item_name, row.minimum]).sort(([a], [b]) => a.localeCompare(b)))
  const receipt = w.memory.snapshot().factory_placement_receipts[0]
  assert.notEqual(receipt.step_id, owner.step_id)
  assert.equal(w.held().execution.step_progress[receipt.step_id].status, 'completed')
  const task = createProductionTask({ intent: w.intent, owner, actor_id: 18, epoch: 1, protected_stock })
  w.memory.productionTasks.set(`${o.key}/${materialOwnerKey(owner)}`, task)
  return { ...w, task }
}
const enrollmentEvents = w => w.events.filter(row => row.event.startsWith('factory_cell.enrollment_recovery_'))
test('BI residual registration miss automatically continues through real runTurn and completed receipts without a model', async () => {
  const w = missingFactoryRegistration()
  const before = structuredClone(w.task.intent); const steps = structuredClone(w.held().steps)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  await w.agent.runTurn()
  assert.deepEqual(enrollmentEvents(w).map(row => row.event), ['factory_cell.enrollment_recovery_started', 'factory_cell.enrollment_recovery_completed'])
  assert.equal(enrollmentEvents(w)[0].data.used, 1)
  assert.equal(enrollmentEvents(w)[0].data.limit, 3)
  assert.deepEqual(w.ops, ['supply_entity'])
  for (let i = 0; i < 12 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed')
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.ops.includes('place_entity'), false)
  assert.equal(w.providers.length, 0)
  assert.deepEqual(w.task.intent, before); assert.deepEqual(w.held().steps, steps)
  assert.equal(enrollmentEvents(w).length, 2)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.deepEqual(restored.snapshot().factory_use_recovery, w.memory.snapshot().factory_use_recovery)
})

test('BI residual allowance survives restart and explicitly exhausts before metadata or native action', async () => {
  const w = missingFactoryRegistration()
  for (let i = 0; i < 3; i++) w.memory.consumeFactoryUseRecovery(an.key, { kind: 'prior_factory_recovery', i }, {
    request_id: `prior-${i}`, plan_id: w.task.owner.plan_id, code: 'prior_miss', evidence_digest: 'a'.repeat(64),
  })
  const snapshot = w.memory.snapshot(); w.memory.restore(JSON.parse(JSON.stringify(snapshot)))
  let failure
  await assert.rejects(w.agent.runTurn(), error => { failure = error; return error.code === 'factory_cell_recovery_exhausted' && error.pause_class === 'guard' })
  const paused = await pauseStrandedPlanAfterRequestError({ agent: w.agent, currentPlanState: () => w.memory.currentPlan(an.key) }, failure)
  assert.equal(paused.status, 'paused')
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.match(paused.pause_reason, /^factory_cell_recovery_exhausted:/)
  assert.equal(enrollmentEvents(w).find(row => row.event.endsWith('_exhausted')).data.used, 3)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
  assert.deepEqual(w.memory.snapshot().factory_use_recovery, snapshot.factory_use_recovery)
})

for (const fault of ['persist', 'cancel', 'actor', 'epoch', 'goal', 'plan', 'step', 'request', 'amendment', 'native_busy', 'uncertain']) test(`BI residual ${fault} during durable allowance never publishes or continues`, async () => {
  const w = missingFactoryRegistration()
  const persist = w.agent.persistState.bind(w.agent)
  w.agent.persistState = async options => {
    if (w.memory.snapshot().factory_use_recovery.records.length) {
      if (fault === 'persist') throw new Error('injected_disk_failure')
      if (fault === 'cancel') w.agent.active = false
      if (fault === 'actor') w.agent.epoch = { ...w.agent.epoch, actor_id: 999 }
      if (fault === 'epoch') w.agent.epoch = { ...w.agent.epoch, epoch: 999 }
      if (fault === 'plan') w.held().plan_version++
      if (fault === 'request') { w.agent.requestAdmissionOwner = { replaced: true }; w.agent.traceRequest = { id: 'replacement-request', seq: 0 } }
      if (fault === 'amendment') w.agent.currentPendingAmendment = () => ({ pending: true })
      if (fault === 'uncertain') w.game.admissions.push({ state: 'unknown', operation_key: 'unsettled', actor_id: 18, epoch: 1 })
      if (fault === 'goal') w.memory.planningState(an.key).goal.goal_id = 'superseded-goal'
      if (fault === 'step') w.held().active_step_index--
      if (fault === 'native_busy') { w.game.taskState = 'working'; w.game.queueLength = 1 }
    }
    return persist(options)
  }
  await assert.rejects(w.agent.runTurn())
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
  assert.equal(enrollmentEvents(w).some(row => row.event.endsWith('_completed')), false)
  const failed = enrollmentEvents(w).find(row => row.event.endsWith('_failed'))
  assert.equal(failed.request_id, 'run-an-production', 'late failure belongs to the original owner')
  assert.equal(w.memory.snapshot().factory_use_recovery.records[0].attempts.length, 1)
})

test('BI residual duplicate wake cannot renew a durably claimed attempt after interrupted correction', async () => {
  const w = missingFactoryRegistration()
  const trace = w.agent.traceEvent.bind(w.agent)
  w.agent.traceEvent = async (event, data) => { await trace(event, data); if (event === 'factory_cell.enrollment_recovery_started') throw new Error('injected interruption after durable claim') }
  await assert.rejects(w.agent.runTurn(), /injected interruption/)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  const saved = JSON.parse(JSON.stringify(w.memory.snapshot()))
  w.memory.restore(saved); w.agent.traceEvent = trace
  await assert.rejects(w.agent.runTurn(), { code: 'factory_cell_recovery_exhausted' })
  const event = enrollmentEvents(w).find(row => row.event.endsWith('_exhausted'))
  assert.equal(event.data.duplicate, true); assert.equal(event.data.used, 1)
  assert.deepEqual(w.memory.snapshot().factory_use_recovery, saved.factory_use_recovery)
  assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
})

// Native canary01 event280: completed furnace cycle has no selected recipe,
// empty input, one copper plate in output, zero crafting progress. Keep that
// actual native shape, rather than pretending a selected recipe survives.
test('native dormant output completes real collection and subsequent controller work without replay or provider', async () => {
  const w = world({ furnace: true, priorPlacement: true, dormantOutput: true })
  const before = structuredClone(w.held().steps)
  await w.start()
  for (let i = 0; i < 12 && w.memory.currentPlan(an.key).status !== 'completed'; i++) await w.agent.completed()
  assert.equal(w.memory.currentPlan(an.key).status, 'completed')
  assert.equal(w.game.inventory['small-electric-pole'], 2)
  assert.equal(w.machine.recipe, undefined, 'native observation is never rewritten as an active recipe')
  assert.equal(w.ops.filter(name => name === 'move_items_exact').length, 1)
  assert.equal(w.ops.filter(name => name === 'supply_entity').length, 2)
  assert.equal(w.ops.filter(name => name === 'wait').length, 1)
  assert.equal(w.ops.includes('place_entity'), false)
  assert.equal(w.providers.length, 0)
  assert.deepEqual(w.held().steps, before)
  assert.ok(w.events.some(row => row.event === 'factory_cell.dormant_output_recipe_evidence' && row.data.commissioning === 'unverified'))
})

const manualOptions = { furnace: true, priorPlacement: true, dormantOutput: true, manualBootstrap: true, fuelFacts: true }
const manualRaw = w => ({ chatMessage: '', stepId: activeStepId(w), operations: [
  { name: 'supply_entity', args: { unit_number: 45, items: [{ item_name: 'copper-ore', count: 10 }, { item_name: 'coal', count: 5 }] } },
] })
async function observeManualMachine(w) {
  w.agent.recordLiveEntityToolResult('getEntityStatus', await w.game.command(w.agent.observationToolCommand('getEntityStatus', { unit_number: 45 })))
}
for (const form of ['assistant_json', 'submitPlan']) for (const residual of [false, true]) for (const redundantCheckpoint of [false, true]) for (const manualGoalScope of residual || redundantCheckpoint ? ['long_horizon'] : ['long_horizon', 'finite']) {
  test(`BJ raw ${form} ${residual ? 'residual' : 'prevention'} ${redundantCheckpoint ? 'matching checkpoint' : 'no checkpoint'} completes finite step within ${manualGoalScope} goal without model repair`, async () => {
    let script
    const reply = w => ({ ...manualRaw(w), ...(redundantCheckpoint ? { checkpoint: structuredClone(w.held().steps[w.held().active_step_index].completion_contract) } : {}) })
    const w = scripted({ ...manualOptions, manualGoalScope }, w => script ??= [form === 'assistant_json' ? { content: JSON.stringify(reply(w)) }
      : { tool_calls: [{ id: 'manual-first-supply', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(reply(w)) } }] }])
    await observeManualMachine(w)
    const original = structuredClone(w.held().steps); const goal = structuredClone(w.memory.planningState(an.key).goal.definition)
    const receipts = structuredClone(w.memory.snapshot().factory_placement_receipts)
    if (residual) {
      const normalize = w.agent.normalizeManualBootstrapProduction.bind(w.agent)
      w.agent.normalizeManualBootstrapProduction = (plan, options) => options?.residual ? normalize(plan, options) : plan
    }
    await w.agent.runTurn()
    assert.equal(w.providers.length, 1)
    assert.equal(w.events.filter(row => row.event === 'production.manual_bootstrap_normalized').length, residual ? 0 : 1)
    assert.equal(w.events.filter(row => row.event === 'production.manual_bootstrap_recovery_started').length, residual ? 1 : 0)
    const normalization = w.events.find(row => row.event === `production.manual_bootstrap_${residual ? 'recovery_resolved' : 'normalized'}`).data
    assert.equal(normalization.checkpoint_disposition, redundantCheckpoint ? 'inline_checkpoint_ignored_canonical_retained' : undefined)
    if (redundantCheckpoint) assert.equal(w.agent.contractSignature(normalization.original_checkpoint), w.agent.contractSignature(original.find(step => step.step_id === normalization.step_id).completion_contract))
    try { for (let i = 0; i < 65 && w.held().status !== 'COMPLETED'; i++) await w.agent.completed() }
    catch (error) { error.message += JSON.stringify({ inventory: w.game.inventory, research: [...w.game.researched], events: w.events.slice(-16) }); throw error }
    assert.equal(w.held().status, 'COMPLETED', JSON.stringify({ inventory: w.game.inventory, pause: w.memory.pauseRecord(an.key), events: w.events.slice(-12) }))
    assert.equal(w.game.inventory['copper-plate'], 10); assert.equal(w.game.researched.has('electronics'), true)
    assert.equal(w.memory.planningState(an.key).goal.status, manualGoalScope === 'finite' ? 'completed' : 'active')
    assert.deepEqual(w.memory.planningState(an.key).goal.definition, goal); assert.deepEqual(w.held().steps, original)
    assert.deepEqual(w.memory.snapshot().factory_placement_receipts, receipts)
    assert.equal(w.ops.filter(op => op === 'move_items_exact').length, 10)
    assert.equal(w.ops.includes('place_entity'), false); assert.equal(w.providers.length, 1)
    assert.equal(w.events.filter(row => row.event.startsWith('production.manual_bootstrap_')).length, residual ? 2 : 1, 'controller supply never renormalizes')
  })
}

function changeManualFixtureStep(w, change) {
  const snapshot = w.memory.snapshot()
  const state = snapshot.planning_states.find(row => row.key === an.key).state
  const plan = getActivePlan(state); change(plan.steps[plan.active_step_index])
  w.memory.restore(snapshot)
}
for (const residual of [false, true]) for (const change of ['unbound', 'unsupported canonical', 'semantic']) test(`BJ raw checkpoint ${change} refuses ${residual ? 'residual' : 'prevention'} without authority or effects`, async () => {
  const w = world(manualOptions); const p = manualRaw(w)
  p.checkpoint = structuredClone(w.held().steps[w.held().active_step_index].completion_contract)
  if (change === 'unbound') changeManualFixtureStep(w, step => { delete step.completion_contract })
  if (change === 'unsupported canonical') changeManualFixtureStep(w, step => { step.completion_contract.requirements = [{ kind: 'unproven_predicate' }] })
  if (change === 'semantic') p.semanticCompletion = { stepId: p.stepId, summary: 'claim without proof' }
  const before = w.memory.snapshot(); const original = structuredClone(p)
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(p, { residual }), /canonical_contract_unproven|scope_unproven/)
  assert.deepEqual(p, original); assert.deepEqual(w.memory.snapshot(), before); assert.deepEqual(w.ops, [])
  assert.equal(w.providers.length, 0); assert.equal(w.events.some(row => row.event.startsWith('production.manual_bootstrap_')), false)
})
for (const [name, change, expected] of [
  ['mixed operations', (w, p) => p.operations.push({ name: 'wait', args: { ticks: 30 } }), /mixed_operations/],
  ['wrong step', (w, p) => { p.stepId = w.held().steps[0].step_id }, /scope_unproven/],
  ['missing finite output', w => changeManualFixtureStep(w, step => { step.completion_contract.requirements = [{ kind: 'research_completed', technology: 'electronics' }] }), /finite_target_required/],
  ['wrong resource', w => changeManualFixtureStep(w, step => { step.execution_guidance.materialSupply.resource = 'iron-ore' }), /recipe_unmatched/],
  ['foreign producer', (w, p) => { p.operations[0].args.unit_number = 999 }, /placement_unproven/],
  ['mixed material', (w, p) => p.operations[0].args.items.push({ item_name: 'iron-ore', count: 1 }), /fuel_unproven/],
  ['missing selected material', (w, p) => { p.operations[0].args.items = [{ item_name: 'coal', count: 5 }] }, /resource_mismatch/],
  ['state file missing', w => { w.agent.stateFile = null }, /persistence_unavailable/],
  ['pending native batch', w => { w.agent.batchInFlight = true }, /not_idle/],
  ['cancelled owner', w => { w.agent.active = false }, /cancelled|superseded|stale/i],
  ['wrong placement plan', w => { const snapshot = w.memory.snapshot(); snapshot.factory_placement_receipts[0].plan_id = 'foreign-plan'; w.memory.restore(snapshot) }, /factory_placement_store_fault/],
]) test(`BJ manual normalization refuses ${name} without metadata or native effects`, async () => {
  const w = world(manualOptions); const p = manualRaw(w); change(w, p)
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(p), expected)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0); assert.deepEqual(w.ops, [])
  assert.equal(w.memory.snapshot().factory_use_recovery.records.length, 0)
})
for (const change of ['ambiguous', 'truncated', 'unknown', 'wrong machine']) test(`BJ manual normalization refuses ${change} live recipe evidence`, async () => {
  const w = world(manualOptions); const command = w.game.command
  w.game.command = async text => {
    const raw = await command(text)
    if (!text.includes('"recipe_details"')) return raw
    const detail = JSON.parse(raw)
    if (change === 'ambiguous') detail.recipes.push({ ...detail.recipes[0], name: 'alternative-live-recipe' })
    if (change === 'truncated') detail.truncated = true
    if (change === 'unknown') return '{}'
    if (change === 'wrong machine') detail.recipes[0].crafting_machines = [{ name: 'different-machine' }]
    return JSON.stringify(detail)
  }
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w)), /recipe_(ambiguous|unknown|unmatched)/)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0); assert.deepEqual(w.ops, [])
})
for (const change of ['actor', 'epoch', 'goal', 'request', 'conversation', 'role', 'cancel']) test(`BJ manual normalization fences ${change} change across native recipe await`, async () => {
  let fired = false
  const w = world({ ...manualOptions, onRead: ({ agent, memory, text }) => {
    if (fired || !text.includes('"recipe_details"')) return
    fired = true
    if (change === 'actor') agent.epoch.actor_id++
    if (change === 'epoch') agent.epoch.epoch++
    if (change === 'goal') memory.planningState(an.key).goal.goal_id = 'replacement-goal'
    if (change === 'request') agent.traceRequest = { id: 'replacement-request' }
    if (change === 'conversation') agent.agentContext.conversationSeq++
    if (change === 'role') agent.agentContext.role = 'planner'
    if (change === 'cancel') agent.active = false
  } })
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w)))
  assert.equal(fired, true); assert.equal(w.memory.getFactoryRegistry().cells.length, 0); assert.deepEqual(w.ops, [])
  assert.equal(w.memory.snapshot().factory_use_recovery.records.length, 0)
})
test('BJ manual residual persistence failure cannot publish a producer or send supply', async () => {
  const w = world(manualOptions)
  w.agent.persistState = async () => { throw new Error('injected durable save failure') }
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w), { residual: true }), /injected durable save failure/)
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0); assert.deepEqual(w.ops, [])
  assert.equal(w.events.some(row => row.event === 'production.manual_bootstrap_recovery_resolved'), false)
})
test('BJ manual residual allowance survives restart and visibly exhausts without replay', async () => {
  const w = world(manualOptions)
  for (let i = 0; i < 3; i++) {
    w.agent.traceRequest = { id: `manual-residual-${i}` }
    await w.agent.normalizeManualBootstrapProduction(manualRaw(w), { residual: true })
    const snapshot = JSON.parse(JSON.stringify(w.memory.snapshot()))
    w.memory.restore(snapshot)
    assert.deepEqual(w.memory.snapshot().factory_use_recovery, snapshot.factory_use_recovery)
  }
  w.agent.traceRequest = { id: 'manual-residual-exhausted' }
  let failure
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w), { residual: true }), error => {
    failure = error; return error.code === 'factory_cell_manual_bootstrap_recovery_exhausted' && error.pause_class === 'guard'
  })
  await pauseStrandedPlanAfterRequestError({ agent: w.agent, currentPlanState: () => w.memory.currentPlan(an.key) }, failure)
  assert.equal(w.memory.pauseRecord(an.key).pause_class, 'guard')
  assert.equal(w.events.find(row => row.event === 'production.manual_bootstrap_recovery_exhausted').data.used, 3)
  assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
})

test('BJ manual normalization refuses a replacement plan without its required grant', async () => {
  const w = world(manualOptions)
  w.held().replacement = { grant_id: 'missing-grant', grant_revision: 1 }
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w)), /authority_unproven/)
  assert.deepEqual(w.ops, []); assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
})
for (const edge of ['native busy', 'uncertain journal', 'foreign world']) test(`BJ manual normalization refuses ${edge}`, async () => {
  const w = world(manualOptions)
  if (edge === 'foreign world') {
    const command = w.game.command
    w.game.command = async text => text.includes("'sgluna_factory','world_identity'")
      ? JSON.stringify({ schema_version: 1, ok: true, code: 'ok', world_id: '4c4d1254-2433-45ea-98f2-2e6d97d6cbd9' }) : command(text)
  } else {
    const read = w.agent.readTaskStatusRaw.bind(w.agent)
    w.agent.readTaskStatusRaw = async () => {
      const status = JSON.parse(await read())
      if (edge === 'native busy') Object.assign(status, { task_state: 'working', queue_length: 1, queue_empty: false })
      else status.admission_journal = null
      return JSON.stringify(status)
    }
  }
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w)), /factory_/)
  assert.deepEqual(w.ops, []); assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
})
for (const boundary of ['persist', 'trace']) test(`BJ manual residual fences cancellation during ${boundary} and cannot renew spent allowance`, async () => {
  const w = world(manualOptions); const original = w.agent[boundary === 'persist' ? 'persistState' : 'traceEvent'].bind(w.agent)
  const method = boundary === 'persist' ? 'persistState' : 'traceEvent'
  w.agent[method] = async (...args) => {
    const result = await original(...args)
    if (boundary === 'persist' || args[0] === 'production.manual_bootstrap_recovery_started') w.agent.active = false
    return result
  }
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w), { residual: true }))
  assert.deepEqual(w.ops, []); assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  const snapshot = JSON.parse(JSON.stringify(w.memory.snapshot()))
  assert.equal(snapshot.factory_use_recovery.records[0].attempts.length, 1)
  w.memory.restore(snapshot); w.agent.active = true; w.agent[method] = original
  await assert.rejects(w.agent.normalizeManualBootstrapProduction(manualRaw(w), { residual: true }), /recovery_exhausted/)
  const exhausted = w.events.find(row => row.event === 'production.manual_bootstrap_recovery_exhausted')
  assert.equal(exhausted.data.duplicate, true); assert.equal(exhausted.data.used, 1)
  assert.deepEqual(w.memory.snapshot().factory_use_recovery, snapshot.factory_use_recovery)
  assert.deepEqual(w.ops, [])
})


// BM W38/W40: inline entity37 or omitted preservation cannot replace canonical
// entity36. The existing isolated fixture uses producer45; contract fields and
// actual caller forms below reproduce BM, with synthetic fresh iron facts.
for (const form of ['submitPlan', 'assistant_json']) test(`BM raw ${form} ignores conflicting echo and keeps canonical iron58 research and entity36`, async () => {
  const w = world(manualOptions)
  changeManualFixtureStep(w, step => {
    step.completion_contract = { mode: 'all', requirements: [
      { id: 'obligation_1', kind: 'inventory_count', item_name: 'iron-plate', minimum: 58 },
      { id: 'obligation_2', kind: 'research_completed', technology: 'steam-power' },
      { id: 'obligation_3', kind: 'entity_exists', unit_number: 36 },
    ] }
    step.execution_guidance.materialSupply.resource = 'iron-ore'
  })
  const native = w.game.command.bind(w.game)
  w.game.command = async text => text.includes('recipe_details') ? JSON.stringify({ found: true, truncated: false, recipes: [{
    name: 'iron-plate', enabled: true, crafting_machines_truncated: false, crafting_machines: [{ name: 'stone-furnace' }],
    ingredients: [{ type: 'item', name: 'iron-ore', amount: 1 }], products: [{ type: 'item', name: 'iron-plate', amount: 1 }],
  }] }) : native(text)
  const canonical = structuredClone(w.held().steps[w.held().active_step_index].completion_contract)
  const raw = { ...manualRaw(w), checkpoint: structuredClone(canonical) }
  raw.operations[0].args.items = [{ item_name: 'iron-ore', count: 50 }, { item_name: 'coal', count: 4 }]
  if (form === 'submitPlan') raw.checkpoint.requirements[2].unit_number = 37
  else raw.checkpoint.requirements.pop()
  const original = structuredClone(raw); const steps = structuredClone(w.held().steps)
  const message = form === 'submitPlan' ? { tool_calls: [{ type: 'function', id: 'bm-echo', function: { name: 'submitPlan', arguments: JSON.stringify(raw) } }] } : { content: JSON.stringify(raw) }
  const payload = form === 'submitPlan' ? plannerControlPayloadFromMessage(message) : JSON.parse(message.content)
  const originalPayload = structuredClone(payload)
  const normalized = await w.agent.normalizeManualBootstrapProduction(payload, { residual: form === 'assistant_json' })
  assert.deepEqual(payload, originalPayload)
  assert.deepEqual(normalized.productionTask.targets, [{ item_name: 'iron-plate', count: 58 }])
  assert.equal(normalized.checkpoint, undefined)
  assert.deepEqual(w.held().steps, steps); assert.deepEqual(raw, original)
  const evidence = w.events.find(row => row.event === `production.manual_bootstrap_${form === 'assistant_json' ? 'recovery_resolved' : 'normalized'}`).data
  assert.deepEqual(evidence.original_checkpoint, JSON.parse(JSON.stringify(original.checkpoint)))
  assert.deepEqual(evidence.canonical_checkpoint, canonical)
  assert.equal(evidence.checkpoint_disposition, 'inline_checkpoint_ignored_canonical_retained')
  assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
})
test('raw echo cannot supply a missing canonical target, even when echo is absent or supplies a valid replacement', async () => {
  for (const echo of [undefined, { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }]) {
    const w = world(manualOptions); const raw = { ...manualRaw(w), ...(echo ? { checkpoint: echo } : {}) }
    changeManualFixtureStep(w, step => { delete step.completion_contract })
    const before = structuredClone(w.memory.snapshot())
    await assert.rejects(w.agent.normalizeManualBootstrapProduction(raw), /canonical_contract_unproven/)
    assert.deepEqual(w.memory.snapshot(), before); assert.deepEqual(w.ops, []); assert.equal(w.providers.length, 0)
  }
})
