// BK's original wrong-target operation and current stock, with declared synthetic
// live recipes. No stored recipe or engine production claim: the native canary
// obtains those facts from Factorio. The lifecycle fixture isolates the active
// stock step; it does not reconstruct or rewrite the sealed historical plan.
import assert from 'node:assert/strict'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { registerFactoryCell } from './factory-registry.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'

export const ASSIGNED_KEY = 'npc:assigned-review'
export const ASSIGNED_OBJECTIVE = 'Obtain the remaining stock for the requested factory without changing assigned producer jobs.'
export const ASSIGNED_CHECKPOINT = { mode: 'all', requirements: [
  { kind: 'inventory_count', item_name: 'iron-plate', minimum: 50 },
  { kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 },
] }
export const BK_WRONG_INPUT = { name: 'supply_entity', args: { unit_number: 36, items: [{ item_name: 'iron-ore', count: 28 }, { item_name: 'coal', count: 6 }] } }
export const assignedGuidance = () => ({ approach: 'Use the existing furnace to obtain the required stock, preserving furnace 36.',
  rationale: 'Collect useful output and make only the remaining inventory deficit.', constraints: ['Preserve existing assigned producers.'], skillIds: [],
  materialSupply: { mode: 'manual_bootstrap', resource: 'iron-ore' } })

export function assignedReviewFixture(stateFile, { onTrace, onProvider, onCommand, bypassCommitPrevention = false, repeatWrong = false,
  operationForm = 'supply_entity', submissionForm = 'json', matchingFirst = false, alterProposal } = {}) {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 22, 'copper-plate': 0, 'iron-ore': 28, 'copper-ore': 1, coal: 16 } })
  game.status.connected_players = 0
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(game.factoryWorldId)
  let registry = memory.getFactoryRegistry()
  const members = []
  for (const [index, material] of ['copper', 'iron'].entries()) {
    const locator = { unit_number: 36 + index, name: 'stone-furnace', position: { x: index ? 40 : 5, y: index ? -23 : -29 }, surface_index: 1, force_index: 1 }
    game.factoryMembers.set(locator.unit_number, { locator, state: 'observed', type: 'furnace',
      burner_fuel_requirement: { state: 'known', required: true, fuel_categories: ['synthetic-fuel'], truncated: false },
      fuel_item_facts: { state: 'known', coverage: 'complete', truncated: false, items: [{ name: 'coal', category: 'synthetic-fuel', fuel_value: 1 }] },
      recipe: { state: 'known', name: `synthetic-${material}`, truncated: false, ingredients: [{ type: 'item', name: `${material}-ore` }], products: [{ type: 'item', name: `${material}-plate` }] },
      source_resources: { state: 'not_applicable', truncated: false, resources: [] } })
    registry = registerFactoryCell(registry, { surface_index: 1, force_index: 1,
      assignment: { products: [`${material}-plate`], purpose: `Dedicated synthetic ${material} fixture`, method: `native_recipe:synthetic-${material}` },
      members: [{ ...locator, provenance: { source: 'declared_synthetic_fixture' } }],
      ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: `${material}-plate` }], origin: { source: 'declared_synthetic_fixture' } })
    members.push(locator)
  }
  memory.restore({ ...memory.snapshot(), factory_registry: registry })
  game.nearby.entities = members.map(row => ({ ...row, type: 'furnace' }))
  const originalCommand = game.command.bind(game)
  game.command = async text => { await onCommand?.(text, w); return originalCommand(text) }
  const events = []; const replies = []; let plannerCalls = 0; let executorCalls = 0
  class ResidualMissLoop extends NpcAgentLoop {
    async commitPlan(plan) {
      if (bypassCommitPrevention && !this.fixtureMissInjected && plan.operations?.some(row => row.args?.unit_number === 36)) {
        this.fixtureMissInjected = true
        await this.traceEvent('fixture.assigned_commit_prevention_bypassed', { destination: 'actual_shared_pre_send' })
        await this.recordPendingOperationBeforeSend(plan.operations, this.epoch, [])
        throw new Error('Residual fixture crossed the shared pre-send fence; transport forbidden')
      }
      return super.commitPlan(plan)
    }
  }
  const agent = new ResidualMissLoop({ memory, rcon: game, stateFile, traceFile: null, decisionTraceFile: null,
    npcId: 'assigned-review', completionProtocolVersion: 3, jevCheckpoints: false, replacementWake: true,
    systemPrompt: 'Deterministic assigned-producer advisory review fixture.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      const override = await onProvider?.(context, w)
      if (override) return override
      let reply
      if (context.role === 'planner') {
        plannerCalls++; assert.ok(plannerCalls <= 2, 'only one bounded advisory review: ' + JSON.stringify(events.filter(row => /refus|fail|recover|invalid/.test(row.event))))
        reply = plannerCalls === 1 ? planReply({ plan: ['Use the existing furnace to obtain at least 50 iron plates and one copper plate'], operations: [],
          goal: { scope: 'long_horizon', summary: ASSIGNED_OBJECTIVE, doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 100 }] },
          stepCompletions: [{ kind: 'deterministic', checkpoint: ASSIGNED_CHECKPOINT }], executionGuidance: [assignedGuidance()] })
          : planReply({ plan: ['Use the existing furnace to obtain at least 50 iron plates and one copper plate'], operations: [], chatMessage: 'Retain the stock checkpoint and all assigned jobs. Observe the registered iron producer 37 and propose only a compatible operation; preserve copper producer 36.' })
      } else {
        executorCalls++; assert.ok(executorCalls <= 4, 'bounded original and post-review executor: ' + JSON.stringify(messages.slice(-4)))
        if ([1, 3].includes(executorCalls)) reply = { content: '', tool_calls: [{ id: `discover-assigned-${executorCalls}`, type: 'function', function: {
          name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 64, limit: 16 }) } }] }
        else {
          const operation = operationForm === 'move_items_exact' ? { name: 'move_items_exact', args: { unit_number: 36, item_name: 'iron-ore', max_count: 28, to_entity: true } } : structuredClone(BK_WRONG_INPUT)
          operation.args.unit_number = !matchingFirst && (executorCalls === 2 || repeatWrong) ? 36 : 37
          const payload = { stepId: getActivePlan(memory.planningState(ASSIGNED_KEY)).steps[0].step_id, operations: [operation], checkpoint: ASSIGNED_CHECKPOINT }
          if (operationForm === 'productionTask' && executorCalls === 2) {
            payload.operations = []; delete payload.checkpoint
            payload.productionTask = { targets: ASSIGNED_CHECKPOINT.requirements.map(row => ({ item_name: row.item_name, count: row.minimum })),
              producers: [{ unit_number: 36, recipe_name: 'synthetic-iron' }], fuel: { item_name: 'coal', count: 6 } }
          }
          await alterProposal?.(payload, w)
          reply = submissionForm === 'submitPlan' ? { content: '', tool_calls: [{ id: `submit-${executorCalls}`, type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(payload) } }] } : planReply(payload)
        }
      }
      replies.push({ role: context.role, messages: structuredClone(messages), reply: structuredClone(reply) }); return reply
    }) })
  agent.behaviorTrace = { emit: async row => { events.push(row); await onTrace?.(row, w) } }
  const w = { game, memory, agent, events, replies, registry, plannerCalls: () => plannerCalls, executorCalls: () => executorCalls }
  return w
}
