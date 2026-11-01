import assert from 'node:assert/strict'
import test from 'node:test'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import { UnchangedFactReads, unchangedFactScope } from './unchanged-fact-reads.mjs'

// Run Y (2026-10-17) pump step: after every continuation the planner re-read the
// same gear recipe and the same inventory, and those unchanged answers spent the
// Jev budget before the offshore-pump placement read could run.
const RECIPE = JSON.stringify({ found: true, recipe: 'iron-gear-wheel', ingredients: [{ name: 'iron-plate', amount: 2 }], inventory: { 'iron-plate': 4 } })

class FactRcon {
  constructor() {
    this.commands = []
    this.epoch = 3
    this.inventory = [{ name: 'iron-plate', count: 4 }]
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) {
      return JSON.stringify({
        revision: 'sgluna-deploy-v8-npc-staging',
        session: '0123456789abcdef0123456789abcdef',
        mode: 'npc',
        actor_id: 18,
        actor_kind: 'standalone_character',
        connected_players: 0,
        allowed: true,
        idle: true,
        epoch: this.epoch,
        actor_interface: true,
        operations: true,
        tools: true,
      })
    }
    if (text.includes('remote.call("autorio_tools","get_inventory_items"')) {
      this.onInventoryRead?.()
      return JSON.stringify({ items: this.inventory })
    }
    if (text.includes('remote.call("autorio_knowledge","recipe_details"')) return RECIPE
    return '{}'
  }

  reads(fragment) {
    return this.commands.filter(command => command.includes(fragment)).length
  }
}

const call = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } })
const recipeCall = id => call(id, 'getRecipeDetails', '{"item_or_recipe":"iron-gear-wheel"}')
const inventoryCall = id => call(id, 'getInventoryItems')

async function factAgent(budget) {
  const rcon = new FactRcon()
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'unchanged fact read test',
    provider: async () => { throw new Error('planner should not run') },
    traceFile: null,
    stateFile: null,
  })
  agent.active = true
  agent.epoch = await rcon.command('remote.call("sgluna_deployment","status")').then(JSON.parse)
  agent.messages = [{ role: 'system', content: 'test' }]
  agent.observationRelevanceOverride = null
  newDecision(agent, budget)
  return { agent, rcon }
}

// What a continuation does to the observation state: a fresh budget and an
// empty per-decision tool cache.
function newDecision(agent, budget) {
  agent.toolCache.clear()
  agent.observationBudgetOverride = budget
  agent.observationBudgetRemaining = budget
  agent.observationDecisionForced = false
}

const executed = agent => agent.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)

test('repeating an unchanged recipe and inventory after a continuation is read live but spends no budget', async () => {
  const { agent, rcon } = await factAgent(4)
  await agent.handleToolBatch({ tool_calls: [recipeCall('recipe-1'), inventoryCall('inventory-1')] })
  assert.equal(agent.observationBudgetRemaining, 2)

  newDecision(agent, 2)
  await agent.handleToolBatch({ tool_calls: [recipeCall('recipe-2'), inventoryCall('inventory-2')] })
  assert.equal(agent.observationBudgetRemaining, 2)
  assert.equal(agent.observationDecisionForced, false)
  // Still the live game's answer, delivered in full rather than as a duplicate notice.
  assert.equal(rcon.reads('recipe_details'), 2)
  assert.equal(rcon.reads('get_inventory_items'), 2)
  const recipeResult = agent.messages.find(message => message.tool_call_id === 'recipe-2')
  assert.equal(recipeResult.content, RECIPE)
})

test('a placement read is still admitted after the repeated fact reads', async () => {
  const { agent } = await factAgent(2)
  await agent.handleToolBatch({ tool_calls: [recipeCall('recipe-1'), inventoryCall('inventory-1')] })

  newDecision(agent, 1)
  await agent.handleToolBatch({ tool_calls: [recipeCall('recipe-2'), inventoryCall('inventory-2')] })
  await agent.handleToolBatch({ tool_calls: [call('pump', 'getPlacementCandidates', '{"entity_name":"offshore-pump"}')] })
  assert.ok(executed(agent).includes('pump'))
  assert.equal(agent.observationBudgetRemaining, 0)
})

test('a changed inventory is new observation and spends budget', async () => {
  const { agent, rcon } = await factAgent(4)
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-1')] })

  newDecision(agent, 2)
  rcon.inventory = [{ name: 'iron-plate', count: 2 }, { name: 'iron-gear-wheel', count: 1 }]
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-2')] })
  assert.equal(agent.observationBudgetRemaining, 1)
})

test('a read that is never delivered is not remembered', async () => {
  const { agent, rcon } = await factAgent(2)
  // The actor is replaced while the inventory is being read.
  rcon.onInventoryRead = () => { rcon.epoch = 4 }
  await assert.rejects(agent.handleToolBatch({ tool_calls: [inventoryCall('stale')] }), /epoch changed/)
  assert.deepEqual(executed(agent), [])
  assert.equal(agent.unchangedFactReads?.delivered.size ?? 0, 0, 'nothing remembered (B1: an actor change starts a new conversation)')
})

test('the closed observation phase does not read facts at all', async () => {
  const { agent, rcon } = await factAgent(2)
  agent.observationDecisionForced = true
  agent.observationBudgetRemaining = 0
  await agent.handleToolBatch({ tool_calls: [inventoryCall('refused')] })
  assert.deepEqual(executed(agent), [])
  assert.equal(rcon.reads('get_inventory_items'), 0)
})

test('an unchanged read is still fresh evidence and is admitted on an empty budget', async () => {
  const { agent } = await factAgent(2)
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-1')] })

  newDecision(agent, 0)
  agent.freshObservationSinceContinuation = false
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-2')] })
  assert.ok(executed(agent).includes('inventory-2'))
  assert.equal(agent.freshObservationSinceContinuation, true)
  assert.equal(agent.observationBudgetRemaining, 0)
  assert.equal(agent.observationDecisionForced, false)
})

test('the same fact twice in one batch is read once', async () => {
  const { agent, rcon } = await factAgent(4)
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-a'), inventoryCall('inventory-b')] })
  assert.equal(rcon.reads('get_inventory_items'), 1)
  assert.deepEqual(executed(agent), ['inventory-a', 'inventory-b'])
})

test('a new actor epoch does not reuse answers delivered to the previous one', async () => {
  const { agent, rcon } = await factAgent(4)
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-1')] })

  rcon.epoch = 4
  agent.epoch = { ...agent.epoch, epoch: 4 }
  newDecision(agent, 2)
  await agent.handleToolBatch({ tool_calls: [inventoryCall('inventory-2')] })
  assert.equal(agent.observationBudgetRemaining, 1)
})

test('unchanged-fact memory is scoped, exact and bounded', () => {
  assert.equal(unchangedFactScope(undefined), undefined)
  assert.equal(unchangedFactScope({ mode: 'npc', actor_kind: 'standalone_character', epoch: 3 }), undefined)
  const scope = unchangedFactScope({ mode: 'npc', actor_kind: 'standalone_character', actor_id: 18, epoch: 3 })
  assert.equal(scope, 'npc:standalone_character:18:3')

  const reads = new UnchangedFactReads({ limit: 2 })
  assert.equal(reads.isUnchanged(scope, 'a', 'x'), false)
  reads.recordDelivered(scope, 'a', 'x')
  assert.equal(reads.isUnchanged(scope, 'a', 'x'), true)
  assert.equal(reads.isUnchanged(scope, 'a', 'y'), false)
  assert.equal(reads.isUnchanged(undefined, 'a', 'x'), false)
  reads.recordDelivered(undefined, 'b', 'x')
  assert.equal(reads.delivered.size, 1)

  reads.recordDelivered(scope, 'b', 'x')
  reads.recordDelivered(scope, 'a', 'x')
  reads.recordDelivered(scope, 'c', 'x')
  assert.equal(reads.isUnchanged(scope, 'b', 'x'), false)
  assert.equal(reads.isUnchanged(scope, 'a', 'x'), true)
  assert.equal(reads.isUnchanged(scope, 'c', 'x'), true)
})
