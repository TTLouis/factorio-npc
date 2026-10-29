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
export function bgWorld({ safe = true, onRead, provider, onTrace, directFeed = false } = {}) {
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
    if (text.includes('"autorio_actor","status"')) return JSON.stringify({ actor: { actor_id: 24 }, surface_index: 1, force_index: 1 })
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",'([^']+)'/.exec(text)?.[1]
      const recipe = bgRecipes.find(row => row.name === name)
      return JSON.stringify(recipe ? { found: true, truncated: false, recipes: [recipe], burner_fuels: { truncated: false, items: [
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
  const add = (entity = furnace) => {
    machines.set(entity.unit_number, entity)
    memory.recordNpcPlacement(bg.key, { unit_number: entity.unit_number, entity_name: entity.name, actor_id: 24, actor_epoch: 1 })
    agent.recordLiveEntityObservation({ ...entity, surface_index: 1 }, undefined, 'placement_receipt', { surface_index: 1 })
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
  return { agent, memory, game, events, ops, providers, furnace, machines, add, start, residual, plan, step, preserved }
}
