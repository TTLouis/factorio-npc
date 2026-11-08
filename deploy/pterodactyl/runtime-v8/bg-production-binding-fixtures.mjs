import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio, pinLegacyFixtureSkillContext } from './task-loop-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import { createProductionTask } from './production-task.mjs'
import { materialOwnerKey } from './material-ledger.mjs'

export const bg = JSON.parse(readFileSync(new URL('./fixtures/run-bg-production-binding.json', import.meta.url), 'utf8'))
// Explicit SCRIPTED complete native data for lifecycle tests, not a stored game
// guide or a reconstruction of missing terminal response bodies. The real engine
// lane reads its own recipes. Original payload/plan/held stock remain unchanged.
export const bgRecipes = [
  { name: 'automation-science-pack', enabled: true, hand_craftable_category: true, energy: 5,
    ingredients: [{ name: 'copper-plate', amount: 1 }, { name: 'iron-gear-wheel', amount: 1 }], products: [{ name: 'automation-science-pack', amount: 1 }], crafting_machines: [] },
  { name: 'iron-gear-wheel', enabled: true, hand_craftable_category: true, energy: 0.5,
    ingredients: [{ name: 'iron-plate', amount: 2 }], products: [{ name: 'iron-gear-wheel', amount: 1 }], crafting_machines: [] },
  { name: 'copper-plate', enabled: true, hand_craftable_category: false, energy: 3.2,
    ingredients: [{ name: 'copper-ore', amount: 1 }], products: [{ name: 'copper-plate', amount: 1 }],
    crafting_machines: [{ name: 'stone-furnace', energy_source: 'burner', energy_watts: 90000, burner_effectivity: 1, fuel_categories: ['chemical'] }] },
  { name: 'stone-furnace', enabled: true, hand_craftable_category: true, energy: 0.5,
    ingredients: [{ name: 'stone', amount: 5 }], products: [{ name: 'stone-furnace', amount: 1 }], crafting_machines: [] },
]

// Explicit synthetic native/retained-receipt adapter for controller tests. It
// does not infer qualification from old NPC placement rows or edit the plan.
export function installProductionFactoryFixture({ agent, memory, game, plan, step, machines, recipes, projectMember = row => row }) {
  const world = '226a063b-b2ac-4ec1-a6c4-a4d9ac7a747a'
  memory.initializeFactoryRegistry(world)
  const writes = []
  agent.stateFile = '/synthetic/production-factory-state'
  agent.persistState = async () => { writes.push(memory.snapshot()) }
  const command = game.command.bind(game)
  game.command = async text => {
    if (text.includes("'sgluna_factory','world_identity'")) return JSON.stringify({ schema_version: 1, ok: true, code: 'ok', world_id: world })
    if (!text.includes("'sgluna_factory','observe'")) {
      const result = await command(text)
      // The shared legacy fake omits these native exact-batch identity fields.
      // Supply them from the same fake engine generation, not from host intent.
      if (result.startsWith('{') && (text.includes('"status"') || text.includes('next_slice_ownership'))) {
        const body = JSON.parse(result)
        const status = body.operations ?? body
        if (status.last_completed_batch) {
          const last = status.last_completed_batch
          last.batch_generation = status.batch_generation
          last.batch_ref = `batch-g${status.batch_generation}-${last.batch_id}`
          status.receipt_journal.push({ ...last, state: 'completed' })
          return JSON.stringify(body)
        }
      }
      return result
    }
    const request = JSON.parse(text.match(/helpers\.json_to_table\('(.+)'\)/)[1])
    return JSON.stringify({ ...request, ok: true, code: 'ok', tick: 1000 + game.batchId, members: request.members.map(locator => {
      const entity = machines.get(locator.unit_number)
      if (!entity) return { locator, state: 'unknown', code: 'member_not_found' }
      const selected = recipes.find(recipe => recipe.name === entity.recipe)
      const typed = rows => rows.map(row => ({ type: 'item', ...row }))
      return projectMember({ ...locator, locator, state: 'observed', type: entity.type,
        recipe: selected ? { state: 'known', name: selected.name, truncated: false, ingredients: typed(selected.ingredients), products: typed(selected.products) }
          : { state: 'none', truncated: false, ingredients: [], products: [] },
        inventories: entity.inventories.map(inventory => ({ state: 'known', truncated: false, index: inventory.index,
          role: inventory.index === 1 ? 'fuel' : inventory.index === 2 ? 'input' : 'output', items: structuredClone(inventory.items) })),
        progress_facts: { crafting_progress: { state: 'known', value: entity.crafting_progress } },
        source_resources: { state: 'not_applicable', resources: [], truncated: false },
        burner_fuel_requirement: { state: 'known', required: true, fuel_categories: ['chemical'], truncated: false },
        fuel_item_facts: { state: 'known', coverage: 'complete', truncated: false, items: [{ name: 'coal', category: 'chemical', fuel_value: 4e6 }] },
        endpoint_facts: { schema_version: 1, inventories: { state: 'known', truncated: false, endpoints: entity.inventories.map(inventory => ({
          state: 'known', inventory_index: inventory.index, roles: { state: 'known', values: [inventory.index === 1 ? 'fuel' : inventory.index === 2 ? 'input' : 'output'] } })) },
        recipe_selection: { state: selected ? 'known' : 'not_applicable', quality: { state: 'known', name: 'normal' } } } }, entity)
    }) })
  }
  const retain = entity => {
    const p = plan(); const s = step(); const n = 10000 + entity.unit_number
    const receipt = { receipt_id: `${world}/batch-g1-${n}/${n}`, world_id: world, surface_index: 1, force_index: 1,
      actor_id: agent.epoch.actor_id, actor_epoch: agent.epoch.epoch, request_id: `synthetic-placement-${n}`, goal_id: p.goal_id,
      plan_id: p.plan_id, plan_version: p.plan_version, step_id: s.step_id, semantic_step_id: s.semantic_step_id ?? s.step_id,
      operation_key: `synthetic-placement-${n}`, operation_id: n, batch_ref: `batch-g1-${n}`, batch_id: n, batch_generation: 1,
      unit_number: entity.unit_number, name: entity.name, position: structuredClone(entity.position), tick: n }
    memory.recordFactoryPlacementReceipt(receipt, memory.factoryWorldBinding().generation)
    return receipt
  }
  return { world, retain, writes }
}

export function bgWorld({ safe = true, onRead, provider, onTrace, directFeed = false, receiptBacked = true } = {}) {
  const raw = structuredClone(bg.memory)
  raw.dialogue = []
  // Reopen only the terminal fixture's run/controller flags for an offline
  // replay. This does not modify its committed plan, proof or historical files.
  Object.assign(raw.plans[0].state, { status: 'active', blocker: '', pause_reason: '' })
  raw.plans[0].state.task_board.status = 'active'
  Object.assign(raw.planning_states[0].state.run, { paused: false, pause_reason: null, pause_code: null, pause_class: null })
  raw.planning_states[0].state.goal.status = 'active'
  if (directFeed) raw.planning_states[0].state.plans[0].steps[0].execution_guidance.materialSupply = { mode: 'direct_feed', resource: 'copper-ore' }
  const memory = new CanonicalTaskBoardMemory(); memory.restore(raw); pinLegacyFixtureSkillContext(memory)
  const plan = () => getActivePlan(memory.planningState(bg.key))
  const step = () => plan().steps[plan().active_step_index]
  const game = new FakeFactorio({ inventory: JSON.parse(bg.task.last_fingerprint).held })
  Object.assign(game.status, { actor_id: 24, epoch: 1, connected_players: 0, surface_index: 1 })
  const events = []; const ops = []; const providers = []
  const preserved = structuredClone(step().obligation_proof.preserved)
  const furnace = { unit_number: 60, name: 'stone-furnace', type: 'furnace', position: { x: 60, y: -60 }, direction: 0,
    energy_source: 'burner', status_name: 'no_ingredients', working: false, crafting_progress: 0, crafting_speed: 1,
    inventories: [{ index: 1, items: [{ name: 'coal', count: 1 }] }, { index: 2, items: [] }, { index: 3, items: [] }], inventories_truncated: false, inventory_items_truncated: false }
  const machines = new Map([[60, furnace]])
  if (!safe) { machines.delete(60); furnace.inventories[0].items = []; furnace.status_name = 'no_fuel' }
  let agent
  const native = game.command.bind(game)
  game.command = async text => {
    await onRead?.({ agent, memory, game, text, machines })
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ mode: 'npc', actor: { actor_id: 24, valid: true, kind: 'standalone_character' }, surface_index: 1, force_index: 1 })
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",'([^']+)'/.exec(text)?.[1]
      const recipe = bgRecipes.find(row => row.name === name)
      return JSON.stringify(recipe ? { found: true, truncated: false, recipes: [{ ...recipe,
        ingredients: recipe.ingredients.map(row => ({ type: 'item', ...row })), products: recipe.products.map(row => ({ type: 'item', ...row })) }], burner_fuels: { truncated: false, items: [
        { name: 'coal', category: 'chemical', fuel_value: 4e6, mined_from: ['coal'], harvested_from: [] }] } }
        : { found: false, code: 'no_recipe', mined_from: [], harvested_from: [] })
    }
    if (text.includes('"entity_geometry"')) {
      const unit = Number(/,(\d+)\)/.exec(text)?.[1]); const row = preserved.find(row => row.entity.unit_number === unit)
      return JSON.stringify(row ? { found: true, ...row, fluid_box_count: 0, actor_surface_index: 1, actor_force_index: 1 } : { found: false })
    }
    if (text.includes('"get_entity_status"')) {
      const unit = Number(/,(\d+)\)/.exec(text)?.[1]); const entity = machines.get(unit) ?? preserved.find(row => row.entity.unit_number === unit)?.entity
      return JSON.stringify(entity ? { found: true, actor_id: 24, surface_index: 1, force_index: 1, entity, observation_mode: 'full' } : { found: false })
    }
    return native(text)
  }
  agent = new NpcAgentLoop({ allowEphemeralSkillHandoff: true, rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (messages, context) => { providers.push(context); if (provider) return provider(messages, context); throw new Error(`No model correction in BG replay: ${JSON.stringify(events.slice(-5))}`) } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: bg.key,
    requestInfo: { memoryKey: bg.key, turnId: 1, sender: '<server>', text: 'Continue the committed science bootstrap' }, traceRequest: { id: 'bg-producer-replay' } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => { events.push(row); await onTrace?.({ agent, memory, game, row }) } }
  const settle = agent.settleCompletedStepState.bind(agent)
  agent.settleCompletedStepState = async (state, options) => {
    const result = await settle(state, { ...options, allowContinuation: false })
    return result ?? (state?.status === 'completed' ? { sliceComplete: true } : undefined)
  }
  const factory = installProductionFactoryFixture({ agent, memory, game, key: bg.key, plan, step, machines, recipes: bgRecipes })
  const add = (entity = furnace) => {
    machines.set(entity.unit_number, entity)
    memory.recordNpcPlacement(bg.key, { unit_number: entity.unit_number, entity_name: entity.name, actor_id: 24, actor_epoch: 1 })
    agent.recordLiveEntityObservation({ ...entity, surface_index: 1 }, undefined, 'placement_receipt', { surface_index: 1 })
    if (receiptBacked) factory.retain(entity)
  }
  if (safe) add()
  game.onMutation = text => {
    const op = /remote\.call\('autorio_operations','([a-z_]+)'/.exec(text)?.[1]; ops.push(op)
    if (op === 'supply_entity') {
      assert.ok(text.includes("'supply_entity',60,"), text)
      const count = Number(/count=(\d+)/.exec(text)?.[1]); assert.ok(count > 0, text)
      if (text.includes("item_name='coal'")) {
        assert.ok(game.inventory.coal >= count); game.inventory.coal -= count
        furnace.inventories[0].items = [{ name: 'coal', count }]; furnace.status_name = 'no_ingredients'
        game.lastBasicResult = { type: 'moving_items', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 24,
          accepted: true, completed: true, code: 'completed', target_unit_number: 60, moved_count: count, item_name: 'coal', to_entity: true }
        return
      }
      assert.ok(game.inventory['copper-ore'] >= count)
      game.inventory['copper-ore'] -= count; furnace.inventories[1].items = [{ name: 'copper-ore', count }]
      Object.assign(furnace, { recipe: 'copper-plate', working: true, status_name: 'working' })
    }
    if (op === 'wait') {
      furnace.inventories[2].items = [{ name: 'copper-plate', count: furnace.inventories[1].items[0].count }]
      furnace.inventories[1].items = []; Object.assign(furnace, { working: false, status_name: 'no_ingredients' })
    }
    if (op === 'move_items_exact') {
      const count = Number(/'move_items_exact','copper-plate',60,(\d+),false/.exec(text)?.[1]); assert.ok(count > 0, text)
      furnace.inventories[2].items[0].count -= count; game.inventory['copper-plate'] = (game.inventory['copper-plate'] ?? 0) + count
      game.lastBasicResult = { type: 'moving_items', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 24,
        accepted: true, completed: true, code: 'completed', target_unit_number: 60, moved_count: count, item_name: 'copper-plate', to_entity: false }
    }
    if (op === 'craft_item') {
      const [, name, n] = /'craft_item','([^']+)',(\d+)/.exec(text) ?? []; const count = Number(n)
      const recipe = bgRecipes.find(row => row.name === name); assert.ok(recipe && count > 0, text)
      for (const input of recipe.ingredients) { assert.ok(game.inventory[input.name] >= input.amount * count); game.inventory[input.name] -= input.amount * count }
      game.inventory[name] = (game.inventory[name] ?? 0) + recipe.products[0].amount * count
    }
    if (op === 'gather_resource') game.inventory.stone = (game.inventory.stone ?? 0) + 5
    if (op === 'place_entity') {
      assert.equal(game.inventory['stone-furnace'], 1)
      game.inventory['stone-furnace']--; machines.set(60, furnace)
      game.lastBasicResult = { type: 'placing', operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 24,
        accepted: true, completed: true, code: 'completed', placed_unit_number: 60, entity_name: 'stone-furnace',
        actor_kind: 'standalone_character', placed_world_id: factory.world, placed_last_user: undefined, placed_force_index: 1,
        placed_batch_id: game.batchId, placed_batch_generation: game.generation ?? 1, placed_batch_ref: `batch-g${game.generation ?? 1}-${game.batchId}`,
        placed_entity_type: 'furnace', placed_position: furnace.position, placed_surface_index: 1, placed_direction: 0 }
    }
  }
  game.preflight = () => ({ ok: true, preservation_clears_count: 0,
    planned_footprint: { position: furnace.position, tile_box: { left_top: { x: 59, y: -61 }, right_bottom: { x: 61, y: -59 } } } })
  const start = () => agent.commitPlan({ chatMessage: '', plan: [], currentStep: 0, ...structuredClone(bg.reply) })
  const residual = (extra = {}) => {
    const owner = { goal_id: plan().goal_id, plan_id: plan().plan_id, plan_version: plan().plan_version, step_id: step().step_id }
    const task = { ...createProductionTask({ intent: bg.reply.productionTask, owner, actor_id: 24, epoch: 1 }), ...extra }
    memory.productionTasks = new Map([[`${bg.key}/${materialOwnerKey(owner)}`, task]])
    return task
  }
  return { agent, memory, game, events, ops, providers, furnace, machines, add, start, residual, plan, step, preserved, factory }
}
