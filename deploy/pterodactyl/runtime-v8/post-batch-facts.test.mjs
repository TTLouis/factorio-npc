import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE, PLANNER_ROLE } from './agent-roles.mjs'
import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import { POST_BATCH_FACT_CHARS, POST_BATCH_FACTS_PREFIX, postBatchFamilyReads, postBatchReadAnswers, postBatchStepKey, StepFactWorkingSet } from './post-batch-facts.mjs'
import { lastUserOutsideTail } from './prompt-prefix.mjs'

const COMPLETION = '[MOD] Autorio operation batch completed: placed offshore-pump'

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
  agent.messages.push({ role: 'user', content: COMPLETION })
  const history = agent.messages.length
  agent.deliverPostBatchFacts(bundle)
  // A tail block, not history: the [MOD] receipt stays the instruction this round answers.
  assert.equal(agent.messages.length, history)
  const sent = agent.providerMessages()
  const facts = sent.at(-2)
  assert.ok(facts.content.startsWith(POST_BATCH_FACTS_PREFIX))
  assert.match(facts.content, /getRecipeDetails \{"item_or_recipe":"boiler","requested_count":1\} => /)
  assert.equal(sent.at(-1).content, COMPLETION)
  assert.equal(lastUserOutsideTail(sent).content, COMPLETION)
  // Harness reads are not the decision's own observation.
  assert.equal(agent.freshObservationSinceContinuation, false)

  // If the model asks again anyway, it is an unchanged fact: answered live, no budget spent.
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump-again', 'offshore-pump'), call('inventory-again', 'getInventoryItems')] })
  assert.equal(agent.observationBudgetRemaining, 1)
  assert.equal(agent.observationDecisionForced, false)
})

test('the facts drop out of the prompt once a batch is sent, the step changes, or the next receipt has none', async () => {
  const { agent } = await executorAgent()
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump', 'offshore-pump')] })
  const bundle = await agent.postBatchFactBundle('continue_current')
  const shown = () => agent.providerMessages().some(message => String(message.content).startsWith(POST_BATCH_FACTS_PREFIX))
  agent.deliverPostBatchFacts(bundle)
  assert.equal(shown(), true)
  // Still shown after the model's own tool round, and round detection still finds the receipt.
  agent.messages.push({ role: 'user', content: COMPLETION })
  agent.messages.push({ role: 'assistant', content: '', tool_calls: [call('look', 'getResearchStatus')] })
  agent.messages.push({ role: 'tool', tool_call_id: 'look', content: '{}' })
  assert.equal(shown(), true)
  assert.equal(lastUserOutsideTail(agent.providerMessages()).content, COMPLETION)

  agent.setStep('connect-steam-power')
  assert.equal(shown(), false)
  agent.setStep('place-offshore-pump')
  assert.equal(shown(), true)
  agent.agentContext.role = PLANNER_ROLE
  assert.equal(shown(), false, 'a planner on the same plan and step never sees the executor\'s facts')
  agent.agentContext.role = EXECUTOR_ROLE
  assert.equal(shown(), true)
  agent.deliverPostBatchFacts(undefined)
  assert.equal(shown(), false)

  // A batch sent since the read hides them for good, even once its receipt clears the in-flight flag
  // and before the next continuation replaces them.
  agent.deliverPostBatchFacts(bundle)
  agent.noteWorldMutation({ sent: true })
  assert.equal(shown(), false)
  agent.noteWorldMutation()
  agent.batchInFlight = false
  assert.equal(shown(), false)
  // A bundle read before a mutation is never held.
  agent.deliverPostBatchFacts(bundle)
  assert.equal(agent.postBatchFacts, undefined)

  // A reset (cancel, new request) drops them.
  agent.deliverPostBatchFacts(await agent.postBatchFactBundle('continue_current'))
  assert.equal(shown(), true)
  agent.reset()
  assert.equal(agent.postBatchFacts, undefined)
})

test('the real step key follows the active plan step and the actor epoch', async () => {
  const { agent } = await executorAgent()
  delete agent.postBatchStepKey
  let plan = { plan_id: 'plan-1', active_step_index: 0, steps: [{ step_id: 'place-offshore-pump' }] }
  agent.memory.planningState = () => ({ plans: [plan], active_plan_id: plan.plan_id })
  assert.equal(agent.postBatchStepKey(),postBatchStepKey('npc:standalone_character:18:3', 'plan-1', 'place-offshore-pump'))
  agent.deliverPostBatchFacts(await agent.postBatchFactBundle('continue_current'))
  assert.ok(agent.postBatchFactsText().startsWith(POST_BATCH_FACTS_PREFIX))
  plan = { ...plan, active_step_index: 1, steps: [...plan.steps, { step_id: 'connect-steam-power' }] }
  assert.equal(agent.postBatchFactsText(), '')
  plan = { ...plan, active_step_index: 0 }
  agent.epoch = { ...agent.epoch, epoch: 4 }
  assert.equal(agent.postBatchFactsText(), '', 'a replaced actor never sees the old actor\'s facts')
})

test('the tool trace marks a re-read of a shown fact as prefetched', async () => {
  const { agent } = await executorAgent()
  const traced = []
  agent.traceEvent = async (event, data) => { traced.push({ event, data }) }
  agent.deliverPostBatchFacts(await agent.postBatchFactBundle('continue_current'))
  await agent.handleToolBatch({ tool_calls: [call('inventory-again', 'getInventoryItems')] })
  const row = traced.find(item => item.event === 'tool.call' && item.data.name === 'getInventoryItems')
  assert.equal(row?.data.prefetched, true)
  assert.equal(row?.data.unchanged_fact, true)
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

test('family reads come before the step recipes, so a tight size budget drops recipes first', async () => {
  const { agent, rcon } = await executorAgent()
  rcon.recipeFiller = POST_BATCH_FACT_CHARS
  await agent.handleToolBatch({ tool_calls: [recipeCall('pump', 'offshore-pump')] })
  const bundle = await agent.postBatchFactBundle('targeted_observation', { families: ['inventory_equipment', 'research_state'], closeWhenCovered: true })
  assert.deepEqual(bundle.reads.map(read => read.name), ['getInventoryItems', 'getResearchStatus'])
  assert.deepEqual(bundle.reads.map(read => read.family), ['inventory_equipment', 'research_state'])
  assert.deepEqual(bundle.covered, ['inventory_equipment', 'research_state'])
})

test('the read-only phase closes only for the selection the facts were read for, while they are shown', async () => {
  const { agent } = await executorAgent()
  const covered = () => agent.postBatchFactBundle('targeted_observation', { families: ['research_state'], closeWhenCovered: true })

  // Jev's selection for this decision differs from the bundle's: no close.
  agent.observationRelevanceOverride = ['research_state', 'placement_candidates']
  let bundle = await covered()
  agent.deliverPostBatchFacts(bundle)
  await agent.closeObservationPhaseOnCoveredFacts(bundle)
  assert.equal(agent.observationDecisionForced, false)

  // Read before a world mutation: never held, so never closes.
  agent.observationRelevanceOverride = ['research_state']
  bundle = await covered()
  agent.noteWorldMutation()
  agent.deliverPostBatchFacts(bundle)
  await agent.closeObservationPhaseOnCoveredFacts(bundle)
  assert.equal(agent.observationDecisionForced, false)

  // A failure bundle (closeWhenCovered false) carries the facts without closing.
  bundle = await agent.postBatchFactBundle('targeted_observation', { families: ['research_state'] })
  agent.deliverPostBatchFacts(bundle)
  await agent.closeObservationPhaseOnCoveredFacts(bundle)
  assert.equal(agent.observationDecisionForced, false)

  bundle = await covered()
  agent.deliverPostBatchFacts(bundle)
  await agent.closeObservationPhaseOnCoveredFacts(bundle)
  assert.equal(agent.observationDecisionForced, true)
  assert.deepEqual(agent.providerRoundPhase(false, 'post_step_observe'), { phase: 'decide', reason: 'post_batch_facts_cover_selected_families' })
  // A reset or restage starts a new decision: the reason goes with the closed phase.
  agent.resetObservationDecisionState()
  assert.equal(agent.observationDecisionForced, false)
  assert.equal(agent.providerRoundPhase(false, 'post_step_observe').reason, 'tools_off')
})

test('a family read answers only when the game returned the fact', () => {
  assert.equal(postBatchReadAnswers({ name: 'getResearchStatus', args: {}, output: '{"current":null}' }), true)
  assert.equal(postBatchReadAnswers({ name: 'getResearchStatus', args: {}, output: '{"ok":false,"error":"no_force"}' }), false)
  assert.equal(postBatchReadAnswers({ name: 'getResearchStatus', args: {}, output: 'not json' }), false)
  assert.equal(postBatchReadAnswers({ name: 'getEntityStatus', args: { unit_number: 35 }, output: '{"found":true,"entity":{"unit_number":35}}' }), true)
  assert.equal(postBatchReadAnswers({ name: 'getEntityStatus', args: { unit_number: 35 }, output: '{"found":false}' }), false)
  assert.equal(postBatchReadAnswers({ name: 'getEntityStatus', args: { unit_number: 35 }, output: '{"found":true,"entity":{"unit_number":36}}' }), false)
  assert.deepEqual(postBatchFamilyReads(['entity_status', 'recipe_production', 'research_state'], {}).map(read => read.name), ['getResearchStatus'])
  assert.deepEqual(postBatchFamilyReads(['entity_status'], { placedUnitNumber: 35 }), [{ name: 'getEntityStatus', args: { unit_number: 35 }, family: 'entity_status' }])
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
