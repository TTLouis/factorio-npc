import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'

// Synthetic native rows and products, not a recipe guide or engine proof.
const KEY = 'npc:block-startup'
const INTENT = { kind: 'production_block', purpose: 'Keep the explicit bootstrap assignment',
  members: [{ role: 'producer', entity: 'stone-furnace' }], outputs: [{ role: 'producer', kind: 'item', resource: 'iron-plate' }] }
const recipe = { name: 'iron-plate', applicability: { state: 'available' }, enabled: true, hand_craftable_category: false, energy: 1,
  ingredients: [{ type: 'item', name: 'iron-ore', amount: 1 }], products: [{ type: 'item', name: 'iron-plate', amount: 1 }],
  crafting_machines_truncated: false, crafting_machines: [{ name: 'stone-furnace', energy_source: 'burner', energy_watts: 1, burner_effectivity: 1, fuel_categories: ['synthetic'] }] }
function loopFixture(stateFile, { residual = false, onTrace } = {}) {
  const game = new FakeFactorio({ inventory: { 'stone-furnace': 1, 'iron-ore': 1, coal: 4 } })
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(game.factoryWorldId)
  const locator = { unit_number: 37, name: 'stone-furnace', position: { x: 63, y: 80 }, surface_index: 1, force_index: 1 }
  const machine = { ...locator, type: 'furnace', crafting_progress: 0, working: false, status_name: 'no_fuel', energy_source: 'burner',
    inventories: [1, 2, 3].map(index => ({ index, items: [] })), inventories_truncated: false, inventory_items_truncated: false }
  let placed = false; let planner = 0; let executor = 0
  const events = []; const issued = []; const ops = []
  const evaluate = game.evaluateGoalCondition.bind(game)
  game.evaluateGoalCondition = request => request.kind === 'entity_count' ? { ok: true, kind: 'entity_count', prototype: request.prototype, current: placed ? 1 : 0, minimum: request.minimum, satisfied: placed, found: placed ? 1 : 0, truncated: false } : evaluate(request)
  const native = game.command.bind(game)
  game.command = async text => {
    if (text.includes('recipe_details')) {
      const name = /recipe_details["'],["']([^"']+)/.exec(text)?.[1]
      return JSON.stringify(name === recipe.name ? { found: true, truncated: false, recipes: [recipe], burner_fuels: { items: [{ name: 'coal', category: 'synthetic', fuel_value: 10 }] } }
        : { found: true, truncated: false, recipes: [], mined_from: [name] })
    }
    if (text.includes('get_entity_status')) return JSON.stringify({ found: placed, actor_id: game.status.actor_id, surface_index: 1, force_index: 1, entity: machine })
    if (text.includes('count_entities')) return JSON.stringify({ count: placed ? 1 : 0, found: placed ? 1 : 0, truncated: false })
    if (text.includes("'sgluna_factory','observe'")) {
      const row = { locator, state: 'observed', type: 'furnace',
        recipe: machine.recipe ? { ...recipe, state: 'known', truncated: false } : { state: 'none', truncated: false, ingredients: [], products: [] },
        startup_recipe_candidates: { schema_version: 1, state: 'known', truncated: false, coverage: 'complete', selection: 'unselected',
          basis: 'enabled_native_recipe_category_and_surface', candidates: [{ ...recipe, applicability: { state: 'available' } }] },
        inventories: machine.inventories.map(value => ({ ...value, state: 'known', truncated: false, role: ['fuel', 'input', 'output'][value.index - 1] })),
        progress_facts: { crafting_progress: { state: 'known', value: 0 } },
        burner_fuel_requirement: { state: 'known', required: true, truncated: false, fuel_categories: ['synthetic'] },
        fuel_item_facts: { state: 'known', coverage: 'complete', truncated: false, items: [{ name: 'coal', category: 'synthetic', fuel_value: 10 }] },
        endpoint_facts: { schema_version: 1, inventories: { state: 'known', truncated: false, endpoints: [{ state: 'known', inventory_index: 3, roles: { state: 'known', values: ['output'] } }] } } }
      if (machine.inventories.some(value => [2, 3].includes(value.index) && value.items.length)) {
        row.startup_recipe_candidates = { ...row.startup_recipe_candidates, state: 'not_applicable', code: 'startup_inventory_not_empty', candidates: {} }
      }
      game.factoryMembers.set(37, row)
    }
    return native(text)
  }
  game.onMutation = text => {
    const op = /remote.call\('autorio_operations','([a-z_]+)'/.exec(text)?.[1]; ops.push(op)
    const base = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: game.status.actor_id, accepted: true, completed: true, code: 'completed' }
    if (op === 'place_entity') {
      assert.equal(placed, false); placed = true; game.inventory['stone-furnace']--
      game.nearby.entities = [machine]
      game.lastBasicResult = { ...base, type: 'placing', entity_name: locator.name, placed_unit_number: 37, placed_position: locator.position, placed_surface_index: 1 }
    } else if (op === 'supply_entity') {
      if (text.includes("item_name='coal'")) { machine.inventories[0].items = [{ name: 'coal', count: 1 }]; game.inventory.coal--; machine.status_name = 'no_ingredients' }
      else { machine.inventories[1].items = [{ name: 'iron-ore', count: 1 }]; game.inventory['iron-ore']--; machine.recipe = recipe.name; machine.working = true; machine.status_name = 'working' }
    } else if (op === 'wait') {
      machine.inventories[1].items = []; machine.inventories[2].items = [{ name: 'iron-plate', count: 1 }]; delete machine.recipe; machine.working = false; machine.status_name = 'no_ingredients'
      game.lastBasicResult = { ...base, type: 'waiting' }
    } else if (op === 'move_items_exact') {
      machine.inventories[2].items = []; game.inventory['iron-plate'] = 1
      game.lastBasicResult = { ...base, type: 'moving_items', target_unit_number: 37, item_name: 'iron-plate', moved_count: 1, to_entity: false }
    } else throw new Error('Unexpected fixture operation ' + op)
  }
  const agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'block-startup', stateFile, traceFile: null, decisionTraceFile: null,
    completionProtocolVersion: 3, replacementWake: true, jevCheckpoints: false, systemPrompt: 'Offline synthetic production-block lifecycle.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      let reply
      if (context.role === 'planner') {
        assert.ok(++planner <= 2, 'Only initial goal grounding may repeat')
        reply = planReply({ plan: ['Place the held furnace for the declared iron output', 'Produce and collect the finite iron output'], operations: [],
          goal: { scope: 'long_horizon', summary: 'Build an automated factory; bootstrap the declared finite iron output first.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 100 }] },
          executionGuidance: [{ approach: 'Place, then observe the exact member for later supply.', rationale: 'Presence is not production.', constraints: [], skillIds: [], materialSupply: null, cellIntent: INTENT },
            { approach: 'Use current native facts to supply and collect the exact assigned output.', rationale: 'Finite bootstrap.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: 'iron-ore' } }],
          stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 1 }] } },
            { kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] } }] })
      } else {
        assert.ok(++executor <= 2, 'No corrective provider request: ' + JSON.stringify(events.slice(-6)))
        const plan = getActivePlan(memory.planningState(KEY)); const step = plan.steps[plan.active_step_index]
        reply = plan.active_step_index === 0 ? planReply({ stepId: step.step_id, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 62.5, y: 79.5 } }] })
          : planReply({ stepId: step.step_id, operations: [], productionTask: { targets: [{ item_name: 'iron-plate', count: 1 }],
            producers: [{ unit_number: 37, recipe_name: recipe.name }], fuel: { item_name: 'coal', count: 4 } } })
      }
      issued.push({ role: context.role, reply }); return reply
    }) })
  agent.behaviorTrace = { emit: async row => { events.push(row); await onTrace?.(row, w) } }
  const close = agent.ensureFactoryCellClose.bind(agent)
  agent.ensureFactoryCellClose = async owner => {
    if (residual && !agent.fixtureMiss) { agent.fixtureMiss = true; throw new FactoryRegistryError('factory_enrollment_native_unverified') }
    return close(owner)
  }
  const settle = agent.settleCompletedStepState.bind(agent)
  agent.settleCompletedStepState = async (state, options) => await settle(state, { ...options, allowContinuation: false })
    ?? (state?.status === 'completed' ? { sliceComplete: true } : undefined)
  const w = { agent, game, memory, events, issued, ops, machine, planner: () => planner, executor: () => executor }
  return w
}
for (const residual of [false, true]) test(`BL actual loop ${residual ? 'residual' : 'prevention'} closes explicit placement then finite supply/collection`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'block-startup-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const w = loopFixture(path.join(dir, 'state.json'), { residual })
  await w.agent.request('Place the furnace then bootstrap iron for the later factory.', { sender: 'owner' })
  const plan = () => getActivePlan(w.memory.planningState(KEY))
  const original = structuredClone(plan().steps)
  try { for (let i = 0; i < 30 && plan().status !== 'COMPLETED'; i++) await w.agent.completed() }
  catch (error) { error.message += JSON.stringify({ ops: w.ops, machine: w.machine, detail: error.cause?.details, last: w.events.filter(row => /production.execute|factory_cell.tool_refused/.test(row.event)).slice(-4) }); throw error }
  assert.equal(plan().status, 'COMPLETED', JSON.stringify(w.events.slice(-10)))
  assert.equal(w.game.inventory['iron-plate'], 1); assert.equal(w.executor(), 2)
  assert.deepEqual(plan().steps[0], original[0])
  const bound = plan().steps[1]; const pending = original[1]
  assert.equal(pending.contract_status, 'pending'); assert.equal(bound.contract_status, 'bound')
  assert.equal(bound.contract_binding.binding, 'just_in_time')
  assert.deepEqual(bound.completion_contract.requirements.map(({ id, ...row }) => row), [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }])
  const withoutBinding = step => Object.fromEntries(Object.entries(step).filter(([key]) => !['completion_contract', 'contract_status', 'completion_confidence', 'contract_binding'].includes(key)))
  assert.deepEqual(withoutBinding(bound), withoutBinding(pending)); assert.equal(w.memory.planningState(KEY).goal.status, 'active')
  assert.equal(w.ops.filter(op => op === 'place_entity').length, 1)
  const cell = w.memory.getFactoryRegistry().cells[0]; assert.equal(cell.assignment.method, 'production_block')
  assert.equal(cell.enrollment.semantic_step_id, (original[0].semantic_step_id ?? original[0].step_id))
  assert.equal(w.events.filter(row => row.event === 'factory_cell.block_startup_recovery_started').length, residual ? 1 : 0)
  assert.equal(w.events.filter(row => row.event === 'factory_cell.block_startup_recovery_completed').length, residual ? 1 : 0)
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(persisted.factory_registry, w.memory.snapshot().factory_registry)
  if (residual) assert.equal(persisted.factory_use_recovery.records[0].attempts.length, 1)
})

for (const fault of ['exhausted', 'strict persistence']) test(`BL real residual close ${fault} has no executor continuation or supply`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'block-startup-fault-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const w = loopFixture(path.join(dir, 'state.json'), { residual: true })
  await w.agent.request('Place the furnace then bootstrap iron for the later factory.', { sender: 'owner' })
  const plan = getActivePlan(w.memory.planningState(KEY)); const original = structuredClone(plan.steps)
  if (fault === 'exhausted') {
    for (let i = 0; i < 3; i++) w.memory.consumeFactoryUseRecovery(KEY, { previous: i }, {
      request_id: 'previous-' + i, plan_id: plan.plan_id, code: 'prior_recovery', evidence_digest: 'a'.repeat(64) })
    await w.agent.persistState({ strict: true })
    w.memory.restore(JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8')))
  } else {
    const persist = w.agent.persistState.bind(w.agent)
    w.agent.persistState = options => w.memory.snapshot().factory_use_recovery.records.length ? Promise.reject(new Error('injected claim persistence failure')) : persist(options)
  }
  await assert.rejects(w.agent.completed(), fault === 'exhausted' ? error => error.code === 'factory_cell_recovery_exhausted' && error.pause_class === 'guard' : /claim persistence failure/)
  assert.equal(w.executor(), 1); assert.deepEqual(w.ops, ['place_entity'])
  assert.equal(w.memory.getFactoryRegistry().cells.length, 0)
  assert.deepEqual(getActivePlan(w.memory.planningState(KEY)).steps, original)
  assert.equal(w.events.some(row => row.event === 'factory_cell.block_startup_recovery_completed'), false)
  if (fault === 'exhausted') assert.equal(w.events.find(row => row.event === 'factory_cell.block_startup_recovery_exhausted').data.used, 3)
})
