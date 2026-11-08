import fs from 'node:fs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'
import { operationSignature } from './operation-reconciliation.mjs'
import { registerFactoryCell } from './factory-registry.mjs'

// Explicit synthetic evidence for historical controller replays which predate
// factory assignments. These are scripted capabilities, not recovered native
// facts, recipe mechanics, or a migration of the frozen historical fixture.
export function installHistoricalFactorySupplement(memory, game, entity, { products, ingredients }) {
  const world = game.factoryWorldId
  const locator = { unit_number: entity.unit_number, name: entity.name, position: structuredClone(entity.position), surface_index: 1, force_index: 1 }
  const n = 10000 + entity.unit_number
  const receipt = { receipt_id: `${world}/batch-g1-${n}/${n}`, world_id: world, ...locator,
    actor_id: game.status.actor_id, actor_epoch: game.status.epoch, request_id: 'synthetic-historical-placement',
    goal_id: 'synthetic-historical-goal', plan_id: 'synthetic-historical-plan', plan_version: 1,
    step_id: 'synthetic-historical-step', semantic_step_id: 'synthetic-historical-step',
    operation_key: `synthetic-placement-${n}`, operation_id: n, batch_ref: `batch-g1-${n}`, batch_id: n, batch_generation: 1, tick: 1 }
  const registry = registerFactoryCell(memory.initializeFactoryRegistry(world), {
    surface_index: 1, force_index: 1,
    assignment: { products, purpose: 'Synthetic controller replay capability; not historical game evidence', method: 'synthetic_controller_fixture' },
    members: [{ ...locator, provenance: { source: 'synthetic_fixture', receipt_id: receipt.receipt_id } }],
    ports: products.map((resource, index) => ({ port_id: `output-${index}`, direction: 'output', kind: 'item', resource })),
    origin: { source: 'synthetic_fixture' },
  })
  memory.restore({ ...memory.snapshot(), factory_registry: registry })
  memory.recordFactoryPlacementReceipt(receipt, memory.factoryWorldBinding().generation)
  game.factoryMembers.set(entity.unit_number, { locator, state: 'observed', type: entity.type,
    recipe: { state: 'known', truncated: false, name: 'synthetic-controller-replay',
      ingredients: ingredients.map(name => ({ type: 'item', name })), products: products.map(name => ({ type: 'item', name })) },
    burner_fuel_requirement: { state: 'known', required: true, fuel_categories: ['synthetic-fixture-fuel'], truncated: false },
    fuel_item_facts: { state: 'known', truncated: false, items: [{ name: 'coal', category: 'synthetic-fixture-fuel', fuel_value: 1 }] },
    endpoint_facts: { schema_version: 1, inventories: { state: 'known', truncated: false, endpoints: [
      { state: 'known', inventory_index: 3, roles: { state: 'known', values: ['output'] } },
    ] }, recipe_selection: { quality: { state: 'known', name: 'normal' } } },
  })
}

export const KEY = 'npc:bg-stock'
export const original = JSON.parse(fs.readFileSync(new URL('./fixtures/bg-stock-original.json', import.meta.url)))
export function stockWorld({ trace, read, persist, initial = 0, noYield = false, spentArgument = false, operations = original[initial].operations,
  factoryCapability = { products: ['copper-plate', 'iron-plate'], ingredients: ['iron-ore'] } } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio({ inventory: initial ? { 'iron-ore': 42 } : { coal: 3 } })
  Object.assign(game.status, { connected_players: 0, surface_index: 1, force_index: 1 })
  game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ unit_number: 26, name: 'stone-furnace', type: 'furnace', position: { x: 1, y: 0 } }] }
  // tap14 withdraws copper then supplies iron to the same furnace. A real
  // copper-only assignment would reject that job change. The dual-output test
  // capability isolates the stock barrier while preserving the issued list.
  installHistoricalFactorySupplement(memory, game, game.nearby.entities[0], factoryCapability)
  const native = game.command.bind(game)
  const rows = []; const calls = []; const receipts = []
  let agent
  let observed = false
  game.command = async text => {
    const changed = await read?.({ text, agent, game, memory })
    if (changed !== undefined) return typeof changed === 'string' ? changed : JSON.stringify(changed)
    if (text.includes('autorio_preflight') && text.includes('supply_entity')) {
      const items = [...text.matchAll(/\{\['count'\]=(\d+),\['item_name'\]='([^']+)'\}/g)].map(([, count, item_name]) => ({ item_name, requested: Number(count), source_count: game.inventory[item_name] ?? 0,
        destination_accepts: 100, expected_moved: Math.min(Number(count), game.inventory[item_name] ?? 0), status: game.inventory[item_name] > 0 ? 'ok' : 'supply_missing' }))
      return JSON.stringify({ ok: items.length > 0 && items.every(i => i.source_count > 0), code: 'supply_missing', operation: 'supply_entity',
        target: { unit_number: 26, name: 'stone-furnace' }, transfer: { direction: 'to_entity', items } })
    }
    if (text.includes('autorio_preflight') && text.includes('move_items_exact')) return JSON.stringify({ ok: true, operation: 'move_items_exact',
      target: { unit_number: 26, name: 'stone-furnace' }, transfer: { direction: 'from_entity', items: [{ item_name: 'copper-plate', requested: 10, source_count: 10, destination_accepts: 100, expected_moved: 10 }] } })
    if (text.includes('autorio_operations","status')) {
      const status = JSON.parse(await native(text))
      if (status.last_completed_batch) {
        Object.assign(status.last_completed_batch, { batch_generation: 1, batch_ref: `batch-g1-${game.batchId}` })
        if (!receipts.some(r => r.batch_id === game.batchId)) receipts.push({ ...status.last_completed_batch, state: 'completed' })
      }
      status.receipt_journal = status.last_cancelled_batch ? [{ ...status.last_cancelled_batch, state: 'cancelled' }] : receipts
      return JSON.stringify(status)
    }
    return native(text)
  }
  game.onMutation = text => {
    const activeOperations = agent.stockDependencyAdmission?.claim.operations ?? operations
    if (text.includes("'gather_resource'")) {
      // Rendered mutation positional arguments: derive the exact issued list
      // from the prepared ledger, never reconstruct another model proposal.
      for (const op of activeOperations.filter(op => text.includes(`'${op.name}'`))) {
        if (op.name === 'gather_resource' && !noYield) game.inventory[op.args.resource_name] = (game.inventory[op.args.resource_name] ?? 0) + op.args.count
        if (op.name === 'move_items_exact') game.inventory[op.args.item_name] = (game.inventory[op.args.item_name] ?? 0) + op.args.max_count
      }
    }
    if (text.includes("'supply_entity'")) {
      for (const op of activeOperations.filter(op => text.includes(`'${op.name}'`))) for (const item of op.args.items ?? []) game.inventory[item.item_name] -= Math.min(item.count, game.inventory[item.item_name] ?? 0)
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18, type: 'moving_items', accepted: true,
        completed: true, code: 'completed', target_unit_number: 26, to_entity: true, moved_count: 1 }
    }
  }
  const obligations = { outcome: { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'electronics' }] }, preserve: [] }
  agent = new NpcAgentLoop({ memory, rcon: game, npcId: 'bg-stock', completionProtocolVersion: 3, requireTypedObligations: true, replacementWake: true,
    stateFile: null, traceFile: null, decisionTraceFile: null, systemPrompt: 'Offline stock barrier fixture.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      calls.push(context.role)
      if (context.role === 'planner') return planReply({ plan: ['Bootstrap research with the existing furnace.'], operations: [],
        goal: { scope: 'long_horizon', summary: 'Bootstrap research.', doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 999 }] },
        roadmap: [{ id: 'research', intent: 'Bootstrap research.' }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: obligations.outcome, obligations }],
        executionGuidance: [{ approach: 'Use the existing furnace.', rationale: 'Bootstrap production.', constraints: [], skillIds: [], materialSupply: null }] })
      const held = getActivePlan(memory.planningState(KEY))
      if (!observed) {
        observed = true
        return { content: '', tool_calls: [{ id: 'stock-nearby', type: 'function', function: {
          name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 16 }) } }] }
      }
      if (spentArgument && !memory.planningState(KEY).goal.argument_corrections.claims.length) {
        // Fixture substitution for the earlier tap14->tap15 correction and
        // intervening native progress: spend its real durable reducer claim,
        // preserving the exact original reason/operation, before replaying tap24.
        const step = held.steps[held.active_step_index]; const grant = memory.currentGoalGrant(KEY)
        const claimed = memory.claimArgumentCorrection(KEY, { goal_id: held.goal_id, plan_id: held.plan_id, plan_version: held.plan_version,
          step_id: step.step_id, semantic_step_id: step.semantic_step_id, request_id: 'original-tap14-fixture',
          reason: 'batch_stock_unverified_dependency', operation_signature: operationSignature(original[0].operations),
          operation_index: 2, operation_name: 'supply_entity', grant_id: grant.grant_id, grant_revision: grant.revision,
          actor_id: game.status.actor_id, actor_epoch: game.status.epoch, request_consumed: 0 })
        if (!claimed) throw new Error('Could not install original durable claim fixture')
        await agent.persistState({ strict: true })
      }
      return planReply({ stepId: held.steps[held.active_step_index].step_id, operations })
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row); await trace?.({ row, agent, memory, game }) } }
  const persistOriginal = agent.persistState.bind(agent)
  agent.persistState = async options => { await persistOriginal(options); await persist?.({ options, agent, game, memory }) }
  return { agent, memory, game, rows, calls, receipts, held: () => getActivePlan(memory.planningState(KEY)),
    start: () => agent.request('Bootstrap research.', { sender: 'Louis' }) }
}
