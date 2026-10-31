// Declared synthetic native facts for composed recovery tests. No game recipe,
// throughput or engine claim; the separate Factorio driver reads those live.
import assert from 'node:assert/strict'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { registerFactoryCell } from './factory-registry.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'

export const RECOVERY_KEY = 'npc:factory-recovery'
export const RECOVERY_OBJECTIVE = 'Produce iron for the requested factory while keeping the dedicated copper production intact.'
export const RECOVERY_CHECKPOINT = { mode: 'all', requirements: [{ id: 'iron-stock', kind: 'inventory_count', item_name: 'iron-plate', minimum: 10 }] }
export const recoveryGuidance = () => ({ approach: 'Use the dedicated iron supplier and preserve the copper job.',
  rationale: 'Only fresh native assigned input and output facts establish compatible use.', constraints: [], skillIds: [],
  materialSupply: { mode: 'direct_feed', resource: 'iron-ore' } })

export function recoveryFixture(stateFile, { onTrace, onProvider, onCommand, bypassCommitPrevention = false } = {}) {
  const game = new FakeFactorio({ inventory: { coal: 10 } }); game.status.connected_players = 0
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(game.factoryWorldId)
  let registry = memory.getFactoryRegistry()
  const members = []
  for (const [index, material] of ['copper', 'iron'].entries()) {
    const source = { unit_number: 38 + index * 100, name: 'burner-mining-drill', position: { x: index * 8, y: 2 }, surface_index: 1, force_index: 1 }
    const target = { ...source, unit_number: source.unit_number + 1, name: 'stone-furnace', position: { x: source.position.x, y: 4 } }
    const fuel = { burner_fuel_requirement: { state: 'known', required: true, fuel_categories: ['synthetic-fuel'], truncated: false },
      fuel_item_facts: { state: 'known', coverage: 'complete', truncated: false, items: [{ name: 'coal', category: 'synthetic-fuel', fuel_value: 1 }] } }
    game.factoryMembers.set(source.unit_number, { locator: source, state: 'observed', type: 'mining-drill', ...fuel, recipe: { state: 'unsupported' },
      source_resources: { state: 'known', truncated: false, resources: [{ name: `${material}-ore`, products_truncated: false, products: [{ type: 'item', name: `${material}-ore` }] }] },
      item_routes: { state: 'known', truncated: false, routes: [{ kind: 'drop', state: 'connected', target }] } })
    game.factoryMembers.set(target.unit_number, { locator: target, state: 'observed', type: 'furnace', ...fuel,
      recipe: { state: 'known', name: `synthetic-${material}`, truncated: false, ingredients: [{ type: 'item', name: `${material}-ore` }], products: [{ type: 'item', name: `${material}-plate` }] },
      source_resources: { state: 'not_applicable', truncated: false, resources: [] } })
    registry = registerFactoryCell(registry, { surface_index: 1, force_index: 1,
      assignment: { products: [`${material}-plate`], purpose: `Dedicated synthetic ${material} fixture`, method: 'direct_feed' },
      members: [source, target].map(row => ({ ...row, provenance: { source: 'declared_synthetic_fixture' } })),
      ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: `${material}-plate` }], origin: { source: 'declared_synthetic_fixture' } })
    members.push(source, target)
  }
  memory.restore({ ...memory.snapshot(), factory_registry: registry })
  game.nearby.entities = members.map(row => ({ ...row, type: row.name === 'stone-furnace' ? 'furnace' : 'mining-drill' }))
  const originalCommand = game.command.bind(game)
  game.command = async text => { await onCommand?.(text, w); return originalCommand(text) }
  const events = []; const replies = []; let plannerCalls = 0; let executorCalls = 0
  class ResidualMissLoop extends NpcAgentLoop {
    async commitPlan(plan) {
      if (bypassCommitPrevention && !this.fixtureMissInjected && plan.operations?.some(row => row.name === 'supply_entity' && row.args.unit_number === 38)) {
        this.fixtureMissInjected = true
        await this.traceEvent('fixture.factory_commit_prevention_bypassed', { scope: 'isolated_test_only', destination: 'actual_shared_pre_send' })
        await this.recordPendingOperationBeforeSend(plan.operations, this.epoch, [])
        throw new Error('Residual fixture unexpectedly passed the shared pre-send fence; transport forbidden')
      }
      return super.commitPlan(plan)
    }
  }
  const agent = new ResidualMissLoop({ memory, rcon: game, stateFile, traceFile: null, decisionTraceFile: null,
    npcId: 'factory-recovery', completionProtocolVersion: 3, jevCheckpoints: false, replacementWake: true,
    systemPrompt: 'Deterministic factory recovery fixture.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      await onProvider?.(context, w)
      let reply
      if (context.role === 'planner') {
        plannerCalls++; assert.ok(plannerCalls <= 2, 'bounded scripted replacement')
        reply = planReply({ plan: [plannerCalls === 1 ? 'Produce iron using the existing pair' : 'Produce iron using the correctly assigned iron pair'], operations: [],
          ...(plannerCalls === 1 ? { goal: { scope: 'finite', summary: RECOVERY_OBJECTIVE, doneWhen: RECOVERY_CHECKPOINT.requirements } } : {}),
          stepCompletions: [{ kind: 'deterministic', checkpoint: RECOVERY_CHECKPOINT }], executionGuidance: [recoveryGuidance()] })
      } else {
        executorCalls++; assert.ok(executorCalls <= 4, 'bounded scripted executor')
        if ([1, 3].includes(executorCalls)) reply = { content: '', tool_calls: [{ id: 'discover-dedicated-iron', type: 'function', function: {
          name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, limit: 16 }) } }] }
        else reply = planReply({ stepId: getActivePlan(memory.planningState(RECOVERY_KEY)).steps[0].step_id,
          operations: [{ name: 'supply_entity', args: { unit_number: executorCalls === 2 ? 38 : 138, items: [{ item_name: 'coal', count: 1 }] } }] })
      }
      replies.push({ role: context.role, messages: structuredClone(messages), reply: structuredClone(reply) }); return reply
    }) })
  agent.behaviorTrace = { emit: async row => { events.push(row); await onTrace?.(row, w) } }
  const w = { game, memory, agent, events, replies, registry, plannerCalls: () => plannerCalls, executorCalls: () => executorCalls }
  return w
}
