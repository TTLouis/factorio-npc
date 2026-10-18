import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE, PLANNER_ROLE } from './agent-roles.mjs'
import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import { POST_BATCH_FACT_CHARS, POST_BATCH_FACTS_PREFIX, postBatchStepKey, StepFactWorkingSet } from './post-batch-facts.mjs'

// Run Y (2026-10-17) pump step shapes: after each batch the executor's next round only
// re-read its inventory and the recipes it had already looked up for the step.
const recipe = (name, filler = 0) => JSON.stringify({ found: true, recipe: name, ingredients: [{ name: 'iron-plate', amount: 2 }], note: 'x'.repeat(filler) })

class BundleRcon {
  constructor() {
    this.commands = []
    this.epoch = 3
    this.inventory = [{ name: 'iron-plate', count: 4 }]
    this.recipeFiller = 0
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
    if (text.includes('remote.call("autorio_tools","get_inventory_items"')) return JSON.stringify({ items: this.inventory })
    const match = /recipe_details",'([a-z-]+)'/.exec(text)
    if (match) return recipe(match[1], this.recipeFiller)
    return '{}'
  }

  reads(fragment) {
    return this.commands.filter(command => command.includes(fragment)).length
  }
}

const call = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } })
const recipeCall = (id, item) => call(id, 'getRecipeDetails', JSON.stringify({ item_or_recipe: item, requested_count: 1 }))

async function executorAgent() {
  const rcon = new BundleRcon()
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'post-batch facts test',
    provider: async () => { throw new Error('planner should not run') },
    traceFile: null,
    stateFile: null,
  })
  agent.active = true
  agent.epoch = await rcon.command('remote.call("sgluna_deployment","status")').then(JSON.parse)
  agent.messages = [{ role: 'system', content: 'test' }]
  agent.agentContext.role = EXECUTOR_ROLE
  let step = 'place-offshore-pump'
  agent.postBatchStepKey = () => postBatchStepKey('npc:standalone_character:18:3', 'plan-1', step)
  agent.setStep = next => { step = next }
  newDecision(agent, 4)
  return { agent, rcon }
}

// What a continuation does to the observation state.
function newDecision(agent, budget) {
  agent.toolCache.clear()
  agent.observationBudgetOverride = budget
  agent.observationBudgetRemaining = budget
  agent.observationDecisionForced = false
  agent.freshObservationSinceContinuation = false
}

test('after a batch the executor gets its inventory and the step recipes it already read, read live in one go', async () => {
  const { agent, rcon } = await executorAgent()
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump', 'offshore-pump'), recipeCall('boiler', 'boiler')] })

  rcon.inventory = [{ name: 'iron-plate', count: 1 }, { name: 'offshore-pump', count: 1 }]
  const before = rcon.commands.length
  const bundle = await agent.postBatchFactBundle('targeted_observation')
  assert.deepEqual(bundle.reads.map(read => [read.name, read.args.item_or_recipe]), [
    ['getInventoryItems', undefined],
    ['getRecipeDetails', 'boiler'],
    ['getRecipeDetails', 'offshore-pump'],
  ])
  // Live: the bundle carries the inventory as it is now, not as the model last saw it.
  assert.match(bundle.reads[0].output, /"offshore-pump"/)
  assert.match(bundle.reads[1].output, /"recipe":"boiler"/)
  assert.equal(rcon.commands.slice(before).filter(command => !command.includes('sgluna_deployment')).length, 3)

  newDecision(agent, 1)
  agent.deliverPostBatchFacts(bundle)
  const delivered = agent.messages.at(-1)
  assert.equal(delivered.role, 'user')
  assert.ok(delivered.content.startsWith(POST_BATCH_FACTS_PREFIX))
  assert.match(delivered.content, /getRecipeDetails \{"item_or_recipe":"boiler","requested_count":1\} => /)
  assert.equal(agent.freshObservationSinceContinuation, true)

  // If the model asks again anyway, it is an unchanged fact: answered live, no budget spent.
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump-again', 'offshore-pump'), call('inventory-again', 'getInventoryItems')] })
  assert.equal(agent.observationBudgetRemaining, 1)
  assert.equal(agent.observationDecisionForced, false)
})

test('recipes read for an earlier step are not predicted for the next one', async () => {
  const { agent } = await executorAgent()
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump', 'offshore-pump')] })
  agent.setStep('connect-steam-power')
  const bundle = await agent.postBatchFactBundle('continue_current')
  assert.deepEqual(bundle.reads.map(read => read.name), ['getInventoryItems'])
})

test('only an executor continuing or observing on its step gets the bundle', async () => {
  const { agent, rcon } = await executorAgent()
  const before = rcon.commands.length
  assert.equal(await agent.postBatchFactBundle('replan'), undefined)
  assert.equal(await agent.postBatchFactBundle('reanchor_plan'), undefined)
  agent.batchInFlight = true
  assert.equal(await agent.postBatchFactBundle('continue_current'), undefined)
  agent.batchInFlight = false
  agent.agentContext.role = PLANNER_ROLE
  assert.equal(await agent.postBatchFactBundle('continue_current'), undefined)
  assert.equal(rcon.commands.length, before)
})

test('the bundle stays within its size budget and says what it left out', async () => {
  const { agent, rcon } = await executorAgent()
  rcon.recipeFiller = Math.floor(POST_BATCH_FACT_CHARS / 2)
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump', 'offshore-pump'), recipeCall('boiler', 'boiler'), recipeCall('engine', 'steam-engine')] })
  const traced = []
  agent.traceEvent = async (event, data) => { traced.push({ event, data }) }
  const bundle = await agent.postBatchFactBundle('targeted_observation')
  const chars = bundle.reads.reduce((total, read) => total + read.output.length, 0)
  assert.ok(chars <= POST_BATCH_FACT_CHARS)
  assert.equal(bundle.reads[0].name, 'getInventoryItems')
  const row = traced.find(item => item.event === 'observation.post_batch_facts')
  assert.equal(row.data.chars, chars)
  assert.ok(row.data.skipped.some(item => item.reason === 'size'))
})

test('an actor replaced during the bundle cancels the continuation instead of delivering stale facts', async () => {
  const { agent, rcon } = await executorAgent()
  const original = rcon.command.bind(rcon)
  rcon.command = async text => {
    const output = await original(text)
    if (text.includes('get_inventory_items')) rcon.epoch = 4
    return output
  }
  await assert.rejects(agent.postBatchFactBundle('continue_current'), /epoch changed/)
})

test('the step working set is most recent first, deduplicated and bounded', () => {
  const set = new StepFactWorkingSet({ recipeLimit: 2 })
  assert.equal(postBatchStepKey(undefined, 'p', 's'), undefined)
  assert.equal(postBatchStepKey('scope', 'p', ''), undefined)
  const key = postBatchStepKey('scope', 'p', 's')
  set.noteRecipe(key, { item_or_recipe: 'a' }, 'sig-a')
  set.noteRecipe(key, { item_or_recipe: 'b' }, 'sig-b')
  set.noteRecipe(key, { item_or_recipe: 'a' }, 'sig-a')
  set.noteRecipe(key, { item_or_recipe: 'c' }, 'sig-c')
  assert.deepEqual(set.recipes(key).map(entry => entry.signature), ['sig-c', 'sig-a'])
  set.noteRecipe(undefined, { item_or_recipe: 'd' }, 'sig-d')
  assert.equal(set.steps.size, 1)
})
