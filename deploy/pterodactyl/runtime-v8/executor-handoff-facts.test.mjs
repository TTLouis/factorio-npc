import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { parseGoalRequirements } from './goal-requirements.mjs'
import { EXECUTOR_FACT_LIMITS, executorFactsRefreshMessage } from './handoff-packet.mjs'
import { NpcAgentLoop, requiresMachineFacts } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { deployment, FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

// Repair unit D2 (docs/validation/LUNA_AUTONOMY_FAILURE_ANALYSIS_2026-10-05.md section 4). A fresh executor context
// used to hold the plan, the contract and the receipt, but not the recipe reads or the inventory read the planner had
// made, so it returned the remaining plan with zero operations. These scenarios script the model (no provider) against
// a fake Factorio that answers the live shapes: getRecipeDetails as JSON, getInventoryItems as the serpent block the
// game prints, inventory_count conditions as JSON.

const KEY = 'npc:sgluna'
const REQUEST_TEXT = 'research logistic science in a lab'
const GOAL = {
  scope: 'long_horizon',
  summary: 'Research logistic science.',
  doneWhen: [{ id: 'research', kind: 'research_completed', technology: 'logistic-science-pack' }],
}
const SHELF = [{ id: 'node_lab', intent: 'a lab running' }, { id: 'node_science', intent: 'logistic science researched', depends_on: ['node_lab'] }]
const STEPS = ['Craft 10 electronic circuits for the lab', 'Craft the lab']

const detail = (name, ingredients, products, machines, { energy = 0.5, categories = ['crafting'] } = {}) => ({
  name,
  enabled: true,
  requested_crafts: 1,
  craftable_now_count: 0,
  craftable_now: false,
  inventory_overlay: {},
  bootstrap: { dependencies: [], first_unresolved: null },
  hidden: false,
  energy,
  categories,
  hand_craftable_category: true,
  ingredients: ingredients.map(([item, amount]) => ({ type: 'item', name: item, amount })),
  products: products.map(([item, amount]) => ({ type: 'item', name: item, amount })),
  crafting_machine_count: machines.length,
  crafting_machines: machines.map(machine => ({ name: machine, type: 'assembling-machine', crafting_speed: 0.5, seconds_per_craft: 1 })),
  crafting_machines_truncated: false,
})
const RECIPES = {
  lab: detail('lab', [['electronic-circuit', 10], ['iron-gear-wheel', 10], ['transport-belt', 4]], [['lab', 1]], ['assembling-machine-1', 'assembling-machine-2']),
  'electronic-circuit': detail('electronic-circuit', [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]], ['assembling-machine-1']),
  'copper-cable': detail('copper-cable', [['copper-plate', 1]], [['copper-cable', 2]], ['assembling-machine-1']),
  'iron-gear-wheel': detail('iron-gear-wheel', [['iron-plate', 2]], [['iron-gear-wheel', 1]], ['assembling-machine-1']),
  'transport-belt': detail('transport-belt', [['iron-plate', 1], ['iron-gear-wheel', 1]], [['transport-belt', 2]], ['assembling-machine-1']),
}

const MINED_FROM = { 'iron-ore': ['iron-ore'], 'copper-ore': ['copper-ore'] }

// The live engine prints the inventory as a serpent block, recipe details as JSON.
const serpent = inventory => `{\n${Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => `  {\n    count = ${count},\n    name = "${name}"\n  }`).join(',\n')}\n}`

function liveGame({ inventory = {}, recipes = {}, fuels, researchNodes } = {}) {
  const game = new FakeFactorio({ inventory })
  const table = { ...RECIPES, ...recipes }
  // Unit 8: the mod's top-level burner_fuels answer (present when a listed crafting machine burns fuel) and getResearchPath nodes.
  game.burnerFuels = fuels
  game.researchNodes = researchNodes
  game.researchReads = []
  game.sourceReads = []
  game.recipeReads = []
  game.onRecipeRead = undefined
  game.conditionReads = []
  game.fluidReads = []
  // Unit 9: prototype details (placing items), live entity counts, technology progress, lab discovery, harvest sources.
  game.protos = {}
  game.placed = {}
  game.technologies = {}
  game.labs = undefined
  game.minedFrom = {}
  game.harvestedFrom = {}
  game.entityTypes = {}
  game.prototypeReads = []
  game.entityCountReads = []
  game.technologyReads = []
  game.labReads = 0
  game.failDetails = new Set()
  game.stateCounts = {} // "prototype:state" -> count of placed entities in that state
  game.failPlacedFor = new Set() // prototypes whose minimum-1 (placed count) reads fail
  game.failConditionReads = false
  game.onConditionRead = undefined
  const base = game.command.bind(game)
  game.command = async (text) => {
    if (text.includes('"autorio_discovery","find_entities"')) {
      const resource = /"find_entities",'([^']+)'/.exec(text)?.[1]
      game.sourceReads.push(resource)
      game.onSourceRead?.(game, resource)
      return JSON.stringify(game.sourceAnswer ?? sourceAnswer(resource, game.entityTypes[resource]))
    }
    if (text.includes('"autorio_prototypes","details"')) {
      const name = /"details",'([^']+)'/.exec(text)?.[1]
      game.prototypeReads.push(name)
      const items = game.failDetails.has(name) ? undefined : game.protos[name]
      // The mod's prototype_details shape: an entity prototype with its placing items (entity_details place_items).
      return JSON.stringify(items ? { found: true, query: name, entity: { name, type: 'x', place_items: items.map(([item, count]) => ({ name: item, count })) } }
        : { found: false, query: name, error: 'prototype not found as item, fluid, or entity' })
    }
    if (text.includes('"autorio_research","technology"')) {
      const name = /"technology",'([^']+)'/.exec(text)?.[1]
      game.technologyReads.push(name)
      return JSON.stringify(game.technologies[name] ?? { found: false, error: 'unknown_technology' })
    }
    if (text.includes('"autorio_prototypes","discover"')) {
      game.labReads += 1
      return JSON.stringify(game.labs ?? { ok: false, error: { code: 'INVALID_REQUEST', message: 'no controlled actor' } })
    }
    if (text.includes('"evaluate_condition"') && text.includes('"kind":"entity_count"')) {
      const request = JSON.parse(/json_to_table\('(\{.*\})'\)/.exec(text)[1])
      game.entityCountReads.push(request)
      if (!(request.prototype in game.protos)) return JSON.stringify({ ok: false, error: 'unknown_entity', prototype: request.prototype })
      if (request.minimum === 1 && game.failPlacedFor.has(request.prototype)) return JSON.stringify({ ok: false, error: 'engine_query_failed' })
      const current = request.state ? (game.stateCounts[`${request.prototype}:${request.state}`] ?? 0) : (game.placed[request.prototype] ?? 0)
      return JSON.stringify({ ok: true, kind: 'entity_count', prototype: request.prototype, minimum: request.minimum, current, found: current, truncated: false, satisfied: current >= request.minimum, ...(request.state ? { state: request.state } : {}), tick: 900, progress_known: false })
    }
    if (text.includes('"get_inventory_items"')) return serpent(game.inventory)
    if (text.includes('"research_path"') && game.researchNodes) {
      const target = /research_path",['"]([^'"]+)['"]/.exec(text)?.[1]
      game.researchReads.push(target)
      const node = game.researchNodes.find(entry => entry.name === target)
      return JSON.stringify(node ? { ok: true, target, node_count: 1, nodes: [node] } : { ok: false, error: 'unknown_technology' })
    }
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      game.recipeReads.push(name)
      game.onRecipeRead?.(game, name)
      // The exact shape of the mod's answer for a name no recipe makes (knowledge.ts recipe_details_for_actor): the code is
      // declared; mined_from is present only for an item a resource yields.
      const mined = game.minedFrom[name] ?? MINED_FROM[name]
      const harvested = game.harvestedFrom[name]
      return JSON.stringify(table[name]
        ? { found: true, query: name, truncated: false, recipes: [table[name]], ...(mined ? { mined_from: mined } : {}), ...(harvested ? { harvested_from: harvested } : {}),
            ...(game.burnerFuels && table[name].crafting_machines.some(machine => machine.energy_source === 'burner') ? { burner_fuels: game.burnerFuels } : {}) }
        : { found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name', ...(mined ? { mined_from: mined } : {}), ...(harvested ? { harvested_from: harvested } : {}) })
    }
    if (text.includes('"get_fluid_source_tiles"')) {
      // The far read finds water; a small radius around the actor finds none (the native answer for an empty local search).
      const radius = Number(/search_radius=(\d+)/.exec(text)?.[1] ?? 128)
      game.fluidReads.push(radius)
      return JSON.stringify(radius === 128 ? WATER_FAR : { ...WATER_FAR, search_radius: radius, samples: [], returned_count: 0 })
    }
    if (text.includes('"evaluate_condition"') && text.includes('inventory_count')) {
      game.conditionReads.push(/"item_name"\s*:\s*"([^"]+)"/.exec(text)?.[1])
      game.onConditionRead?.(game)
      if (game.failConditionReads) throw new Error('rcon transport closed')
    }
    return base(text)
  }
  return game
}

const read = (name, args = {}, id = name) => ({ id: `call_${id}`, index: 0, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const readsRound = () => ({
  tool_calls: [
    read('getRecipeDetails', { item_or_recipe: 'lab', requested_count: 1 }, 'lab'),
    read('getRecipeDetails', { item_or_recipe: 'electronic-circuit', requested_count: 10 }, 'circuit'),
    read('getRecipeDetails', { item_or_recipe: 'copper-cable', requested_count: 30 }, 'cable'),
    read('getInventoryItems', {}, 'inventory'),
  ].map((call, index) => ({ ...call, index })),
})
const plannerCommit = () => planReply({
  plan: STEPS,
  currentStep: 0,
  operations: [gather('copper-plate', 10)],
  checkpoint: inventoryCheckpoint('electronic-circuit', 10),
  goal: GOAL,
  roadmap: SHELF,
})
const executorGather = count => () => planReply({ plan: STEPS, currentStep: 0, operations: [gather('copper-plate', count)] })
const executorNothing = () => planReply({ plan: STEPS, currentStep: 0, operations: [] })

const textOf = message => (typeof message?.content === 'string' ? message.content : '')
const stepBlock = messages => messages.find(message => textOf(message).startsWith('--- step block ---'))
const lineOf = (messages, prefix) => textOf(stepBlock(messages)).split('\n').find(line => line.startsWith(prefix))

function harness({ game, script, agentOptions = {} }) {
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [], intent: 'new_goal' } // the route the next chat message takes
  const provider = async (messages, context) => {
    world.calls.push({ messages: messages.map(message => ({ ...message })), context })
    const reply = script[world.calls.length - 1]
    assert.ok(reply, `unscripted provider call ${world.calls.length}: ${JSON.stringify(world.trace.slice(-8))}`)
    return typeof reply === 'function' ? reply(messages, context, world) : { ...reply }
  }
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: world.intent, confidence: 0.9 } } }
    if (questions.recovery_semantics) {
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          recovery_semantics: { type: 'choice', choice: 'semantic_replan', confidence: 0.95 },
          one_observation_can_resolve: { type: 'noul', noul: 0.1 },
        },
        usage: { input_tokens: 60, output_tokens: 6, cost: 0 },
      }
    }
    return undefined
  })
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: world.intent, queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'executor handoff facts test system prompt',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...agentOptions,
  })
  world.agent.behaviorTrace = { emit: async (record) => { world.trace.push(record) } }
  world.rows = event => world.trace.filter(record => record.event === event)
  world.say = () => world.agent.request(REQUEST_TEXT, { sender: 'TTLouis' })
  world.give = (item, count) => { game.inventory[item] = (game.inventory[item] ?? 0) + count }
  world.requestId = () => world.rows('request.received')[0].request_id
  return world
}

// The live shape: the planner reads the lab recipe, the recipes under it and the inventory, then commits a plan whose
// first batch gathers copper plates (the harness hands the slice to an executor at the commit).
async function plannerCollectedTenCopper({ inventory, receipt = true } = {}) {
  const world = harness({
    game: liveGame({ inventory }),
    script: [readsRound(), plannerCommit(), executorGather(5)],
  })
  await world.say()
  assert.equal(world.calls.length, 2, 'planner reads, then commits')
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, 'COMMITTED')
  world.give('copper-plate', 10) // the batch gathered ten plates
  // The harness reads the batch receipt when the game reports the batch done (completed() / failed()): until then the batch is in flight.
  if (receipt) await world.agent.taskStatusReceipt()
  return world
}

const restageToFreshExecutor = (world, checkpoint = 'C7') => world.agent.restageBetweenTurns({
  checkpoint,
  role: 'executor',
  reason: 'recovery:test',
  actor: world.agent.epoch,
  requestId: world.requestId(),
})

test('D2 live shape: after the planner read the lab recipe and collected ten copper plates, a fresh executor starts with the recipe record, refreshed counts and the residual copper', async () => {
  const world = await plannerCollectedTenCopper()
  const c3 = world.rows('context.restaged').find(row => row.data.checkpoint === 'C3')
  assert.ok(c3, 'the commit handed the slice to an executor')

  // The failure shape: a fresh conversation replaces the one that held the planner's reads.
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.equal(world.agent.agentContext.role, 'executor')
  assert.equal(world.agent.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'none of the earlier reads survive in the conversation itself')

  const step = textOf(stepBlock(world.agent.messages))
  // Stable recipe facts, tagged with where they came from.
  const lab = step.split('\n').find(line => line.startsWith('recipe_fact lab '))
  assert.match(lab, /^recipe_fact lab \(stable recipe data, source=getRecipeDetails, as_of=epoch:3\): applicability=unknown \| categories=crafting \| energy=0\.5 \| ingredients=10 electronic-circuit \+ 10 iron-gear-wheel \+ 4 transport-belt \| products=1 lab \| machines=assembling-machine-1,assembling-machine-2$/)
  assert.match(step, /^recipe_fact electronic-circuit .*ingredients=1 iron-plate \+ 3 copper-cable \| products=1 electronic-circuit/m)
  assert.match(step, /^recipe_fact copper-cable .*ingredients=1 copper-plate \| products=2 copper-cable/m)
  // Counts re-read now, not the planner's older ones.
  assert.match(step, /^held_counts \(fresh live read of the actor inventory, as_of=tick:601,epoch:3\): .*copper-plate=10/m)
  assert.doesNotMatch(step, /held_counts_STALE/)
  // Residual needs: ten circuits need 30 cable = 15 crafts (the recipe yields 2) = 15 plates; ten are held, so five more are missing.
  const residual = step.split('\n').find(line => line.startsWith('residual_needs'))
  assert.match(residual, /for the step contract electronic-circuit>=10/)
  assert.match(residual, /electronic-circuit required=10 held=0 missing=10 crafts=10 via electronic-circuit/)
  assert.match(residual, /copper-cable required=30 held=0 missing=30 crafts=15 via copper-cable/)
  assert.match(residual, /copper-plate required=15 held=10 missing=5/)
  // Authority: the committed step, its contract and the latest receipt are in the packet; history is labelled.
  assert.match(step, /^authority: active_step=\S+ \(committed plan\) contract=all \(committed\) latest_receipt=.*entity_ids_in_receipts_and_snapshots=historical_observations$/m)
  assert.match(step, /^active_step_contract: all: inventory_count electronic-circuit>=10$/m)
  assert.match(step, /^active_step: 1 of 2 /m)

  // The facts are traced with the request id, the handoff id, counts and a reason.
  const row = world.rows('context.executor_facts_carried').find(item => item.data.checkpoint === 'C7')
  assert.ok(row, 'context.executor_facts_carried was traced')
  assert.equal(row.request_id, world.requestId())
  assert.equal(row.data.request_id, world.requestId())
  assert.equal(row.data.handoff_id, result.handoff_id)
  assert.equal(row.data.role, 'executor')
  assert.equal(row.data.recipe_facts, 3)
  assert.ok(row.data.fresh_items >= 4, 'the contract item, the recipe ingredients and the copper plates were re-read')
  assert.equal(row.data.stale_items, 0)
  assert.equal(row.data.residual_needs, 4)
  assert.equal(row.data.refresh, 'ok')
  assert.equal(row.data.reads_failed, 0)
  assert.equal(row.data.reason, 'executor_context_rebuilt_without_the_prior_conversation_reads')
  assert.ok(world.game.conditionReads.includes('copper-plate'), 'the count was read from the live game')
})

test('D2 live shape: the first executor request after a recovery restage carries the facts, and its scripted gather is admitted', async () => {
  const world = await plannerCollectedTenCopper()
  const result = await world.agent.recoverPlan(world.agent.generation, new Error('strategy invalidated by fresh evidence'), 1)
  assert.equal(result.goalStatus, 'active', 'no pause, no question to the user')

  const call = world.calls.at(-1)
  assert.equal(call.context.role, 'executor')
  const step = textOf(stepBlock(call.messages))
  assert.match(step, /^restage: role=executor checkpoint=C6 reason=bounded_recovery route=wake_planner/m)
  assert.match(step, /^recipe_fact lab /m)
  assert.match(step, /^held_counts \(fresh live read .*copper-plate=10/m)
  assert.match(step, /copper-plate required=15 held=10 missing=5/)
  assert.equal(call.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'none of the earlier exchanges')
  // The scripted executor reply submitted a next action (the missing five plates) and the harness admitted it.
  assert.equal(world.calls.length, 3)
  const acks = world.rows('operations.ack')
  assert.ok(acks.length >= 2, 'the planner batch and the executor batch were both acknowledged')
  assert.equal(acks.at(-1).data.operations[0].name, 'gather_resource')
  assert.equal(acks.at(-1).data.operations[0].args.count, 5)
  assert.ok(world.game.mutations.length >= 2)
  assert.equal(world.rows('context.executor_facts_carried').filter(row => row.data.checkpoint === 'C6').length, 1)
})

test('D2: an executor that still returns zero operations twice keeps the existing truthful failure, not an invented completion', async () => {
  const world = harness({
    game: liveGame(),
    script: [readsRound(), plannerCommit(), executorNothing, executorNothing],
  })
  await world.say()
  world.give('copper-plate', 10)
  // The checkpoint (circuits) is not met, so the executor is asked; it returns the remaining plan with no operation, twice.
  await assert.rejects(world.agent.completed(), /provider_action_omission_repair_failed/)
  assert.equal(world.calls.length, 4, 'one ordinary round and the one bounded act-or-block repair, then the failure')
  const executorRequests = world.calls.slice(2)
  assert.ok(executorRequests.every(request => request.context.role === 'executor'))
  for (const request of executorRequests) {
    const step = textOf(stepBlock(request.messages))
    assert.match(step, /^recipe_fact lab /m, 'the recipe facts were in front of the executor when it returned nothing')
    assert.doesNotMatch(step, /counts_deferred/, 'the completed receipt replaces the deferred-count marker')
    assert.match(step, /^held_counts .*copper-plate=10/m, 'the current step block carries refreshed live inventory')
    // The receipt landed before this request: the counts the packet could not carry arrive with the continuation, read then.
    const refreshed = request.messages.map(textOf).find(text => text.includes('[HARNESS] Executor facts refreshed after the batch receipt landed'))
    assert.ok(refreshed, 'the continuation carries the refreshed facts')
    assert.match(refreshed, /held_counts \(fresh live read of the actor inventory, as_of=tick:601,epoch:3\): .*copper-plate=10/)
    assert.match(refreshed, /copper-plate required=15 held=10 missing=5/)
  }
  assert.equal(world.rows('recovery.action_omission_failed').length, 1)
  const state = world.memory.currentPlan(KEY)
  assert.notEqual(state.status, 'completed')
  assert.equal(getActivePlan(world.memory.planningState(KEY)).active_step_index, 0, 'the step did not move')
})

test('D2: counts the live read could not refresh are carried marked stale with the tick they date from, never as current', async () => {
  const world = await plannerCollectedTenCopper({ inventory: { 'copper-plate': 4, 'iron-plate': 7 } })
  world.agent.noteWorldMutation() // the batch receipt the harness read after the gather: what the planner observed predates it
  world.game.failConditionReads = true // every refresh read fails
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, 'a failed read is not a refusal')

  const step = textOf(stepBlock(world.agent.messages))
  assert.doesNotMatch(step, /^held_counts \(fresh/m, 'nothing is presented as fresh')
  const stale = step.split('\n').find(line => line.startsWith('held_counts_STALE'))
  assert.ok(stale, 'the older values are carried')
  assert.match(stale, /NOT current/)
  assert.match(stale, /copper-plate=4 \(observed epoch:3, fresh_read_failed,predates_latest_batch\)/)
  assert.match(stale, /iron-plate=7 \(observed epoch:3, fresh_read_failed,predates_latest_batch\)/)
  assert.doesNotMatch(step, /copper-plate=10/, 'the unread live count never appears')
  assert.doesNotMatch(step, /^residual_needs/m, 'no residual is derived from stale or missing counts')
  assert.match(step, /^recipe_fact lab /m, 'stable recipe facts do not depend on the read')

  const row = world.rows('context.executor_facts_carried').find(item => item.data.checkpoint === 'C7')
  assert.ok(row.data.stale_items >= 2)
  assert.equal(row.data.fresh_items, 0)
  assert.equal(row.data.residual_needs, 0)
  assert.match(row.data.residual_omitted_reason, /^held_unknown:/)
  assert.equal(row.data.refresh, 'failed')
  assert.ok(row.data.reads_failed >= 1)
})

test('D2: an actor or epoch change during the restage refresh refuses the restage and changes nothing', async () => {
  const world = await plannerCollectedTenCopper()
  const before = { handoff: world.agent.agentContext.handoffId, seq: world.agent.agentContext.conversationSeq, messages: world.agent.messages.length }
  const carriedBefore = world.rows('context.executor_facts_carried').length
  const restagedBefore = world.rows('context.restaged').length
  // The epoch moves while the counts are being read (an actor replacement).
  world.game.onConditionRead = (game) => { game.status = deployment({ epoch: 4 }) }
  const result = await restageToFreshExecutor(world)
  assert.deepEqual(result, { restaged: false, reason: 'actor_changed_during_handoff_refresh' })
  assert.equal(world.agent.agentContext.handoffId, before.handoff, 'the conversation was not swapped')
  assert.equal(world.agent.agentContext.conversationSeq, before.seq)
  assert.equal(world.rows('context.restaged').length, restagedBefore)
  assert.equal(world.rows('context.executor_facts_carried').length, carriedBefore, 'nothing read under the old epoch briefs a conversation')
  const refused = world.rows('context.restage_refused').at(-1)
  assert.equal(refused.data.reason, 'actor_changed_during_handoff_refresh')
  assert.equal(refused.data.checkpoint, 'C7')
  assert.equal(refused.request_id, world.requestId())

  // And when the change happened before the first read, no read is spent at all.
  const world2 = await plannerCollectedTenCopper()
  const fenced = world2.agent.epoch
  world2.game.status = deployment({ actor_id: 19, epoch: 4 })
  const reads = world2.game.conditionReads.length
  const refusedBefore = await world2.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:test', actor: fenced, requestId: world2.requestId() })
  assert.deepEqual(refusedBefore, { restaged: false, reason: 'actor_changed_before_handoff_refresh' })
  assert.equal(world2.game.conditionReads.length, reads)
})

test('D2: the checkpoint machine is re-read fresh through the existing fresh-machine path, and a failed read is carried stale', async () => {
  const world = harness({
    game: liveGame(),
    script: [
      // four reads fit one observation round: the furnace first, then the recipes
      { tool_calls: [read('getNearbyEntities', { radius: 16 }, 'nearby'), ...readsRound().tool_calls.slice(0, 3)].map((call, index) => ({ ...call, index })) },
      planReply({
        plan: ['Smelt 10 copper plates', 'Craft the lab'],
        currentStep: 0,
        operations: [gather('copper-ore', 10)],
        checkpoint: { mode: 'all', requirements: [{ id: 'plates', kind: 'entity_inventory_count', item_name: 'copper-plate', unit_number: 55, minimum: 10 }] },
        goal: GOAL,
        roadmap: SHELF,
      }),
    ],
  })
  const reads = []
  const baseCommand = world.game.command
  world.game.command = async (text) => {
    if (text.includes('"evaluate_condition"') && text.includes('entity_inventory_count')) {
      reads.push('condition')
      return JSON.stringify({ ok: true, kind: 'entity_inventory_count', satisfied: false, current: 3, minimum: 10, unit_number: 55, progressing: true, progress_known: true, entity_status: 1 })
    }
    if (text.includes('"get_entity_status"') || text.includes('get_entity_status')) {
      reads.push('status')
      return JSON.stringify({ found: true, entity: { unit_number: 55, name: 'stone-furnace', type: 'furnace', recipe: 'copper-plate', inventories: [{ index: 2, items: [{ name: 'copper-ore', count: 4 }] }, { index: 3, items: [{ name: 'copper-plate', count: 3 }] }] } })
    }
    return baseCommand(text)
  }
  // The planner saw the furnace in its reads (its exact id is a live observation of this loop).
  world.game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 55, position: { x: 3, y: 3 }, distance: 4.2, status: 1, working: true }] }
  await world.say()
  await world.agent.taskStatusReceipt() // the batch finished: nothing is in flight
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const step = textOf(stepBlock(world.agent.messages))
  const machine = step.split('\n').find(line => line.startsWith('checkpoint_machine'))
  assert.match(machine, /^checkpoint_machine \(fresh live read, as_of=tick:601,epoch:3\): \{"unit_number":55,"name":"stone-furnace"/)
  assert.match(machine, /"checkpoint":\{"item_name":"copper-plate","minimum":10,"current":3,"satisfied":false\}/)
  const history = step.split('\n').find(line => line.startsWith('historical_entities'))
  assert.match(history, /^historical_entities \(earlier observations, NOT current exact targets; ids withheld\): stone-furnace x1/)
  assert.doesNotMatch(history, /55/, 'exact ids are withheld from the history record')
  assert.ok(reads.includes('condition'))

  // A failed machine read falls back to the last observation, labelled stale.
  world.game.command = async (text) => {
    if (text.includes('"evaluate_condition"') && text.includes('entity_inventory_count')) throw new Error('rcon transport closed')
    return baseCommand(text)
  }
  const again = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:again', actor: world.agent.epoch, requestId: world.requestId() })
  assert.equal(again.restaged, true, JSON.stringify(again))
  const staleLine = lineOf(world.agent.messages, 'checkpoint_machine')
  assert.match(staleLine, /^checkpoint_machine_STALE \(earlier observation as_of=tick:601,epoch:3, NOT current; fresh_read_failed\)/)
})

test('D2: a planner restage carries none of the executor facts', async () => {
  const world = await plannerCollectedTenCopper()
  const planner = world.agent.buildRestagePacket({ checkpoint: 'C1', role: 'planner', reason: 'x' })
  assert.doesNotMatch(planner.text, /recipe_fact|held_counts|residual_needs|authority:/)
  assert.equal(planner.executor_facts, undefined)
})

test('D2 B1: at the plan commit the batch is still in flight, so the C3 packet defers counts, machine and residual and says so', async () => {
  const world = await plannerCollectedTenCopper({ receipt: false })
  // The planner committed "gather ten copper plates"; the game is still gathering. A read now would say 0 and be confidently wrong.
  const step = textOf(stepBlock(world.agent.messages))
  assert.match(step, /^restage: role=executor checkpoint=C3 /m)
  assert.match(step, /^counts_deferred=batch_in_flight /m)
  assert.doesNotMatch(step, /^held_counts/m)
  assert.doesNotMatch(step, /^checkpoint_machine/m)
  assert.doesNotMatch(step, /^residual_needs/m)
  assert.match(step, /^recipe_fact lab /m, 'recipe facts do not depend on the world and stay')
  assert.match(step, /^authority: active_step=/m, 'authority stays')
  const row = world.rows('context.executor_facts_carried').find(item => item.data.checkpoint === 'C3')
  assert.equal(row.data.reads_attempted, 0, 'no count was read while the batch was in flight')
  assert.equal(row.data.fresh_items, 0)
  assert.equal(row.data.residual_needs, 0)
  assert.equal(row.data.residual_omitted_reason, 'batch_in_flight')
  assert.equal(row.data.refresh, 'deferred')
  assert.equal(world.agent.pendingExecutorFactsRefresh?.handoff_id, row.data.handoff_id, 'the deferred half is armed for this handoff')
})

test('D2 B1: after the batch receipt lands the executor first continuation carries the fresh counts and residual, once', async () => {
  const world = harness({
    game: liveGame(),
    script: [readsRound(), plannerCommit(), executorGather(5), executorGather(5)],
  })
  await world.say()
  const stablePlan = world.agent.messages.map(textOf).find(text => text.startsWith('[HANDOFF]'))
  const handoffId = world.agent.agentContext.handoffId
  const conversationSeq = world.agent.agentContext.conversationSeq
  assert.ok(stablePlan, 'the committed plan prefix exists before the receipt')
  assert.match(textOf(stepBlock(world.agent.messages)), /counts_deferred=batch_in_flight/)
  world.give('copper-plate', 10) // the batch gathered ten plates
  await world.agent.completed() // receipt read -> the executor continues (call 3)
  assert.equal(world.calls.length, 3)
  const request = world.calls[2]
  assert.equal(request.context.role, 'executor')
  const currentStep = textOf(stepBlock(request.messages))
  assert.doesNotMatch(currentStep, /counts_deferred/, 'the volatile step block no longer claims that the completed batch is in flight')
  assert.match(currentStep, /^held_counts .*copper-plate=10/m)
  assert.match(currentStep, /^receipt #[0-9]+ operation_receipt batch_1: outcome=completed; task_state=idle/m)
  assert.match(currentStep, /^authority: .*latest_receipt=#[0-9]+ deterministic_verification batch_1 \(this step\)/m, 'the current step block names the receipt that just landed')
  assert.equal(request.messages.map(textOf).find(text => text.startsWith('[HANDOFF]')), stablePlan, 'the stable plan prefix remains byte-identical')
  assert.equal(world.agent.agentContext.handoffId, handoffId)
  assert.equal(world.agent.agentContext.conversationSeq, conversationSeq)
  const refreshed = request.messages.map(textOf).filter(text => text.includes('[HARNESS] Executor facts refreshed after the batch receipt landed'))
  assert.equal(refreshed.length, 1)
  assert.match(refreshed[0], /held_counts \(fresh live read of the actor inventory, as_of=tick:601,epoch:3\): .*copper-plate=10/)
  assert.match(refreshed[0], /copper-plate required=15 held=10 missing=5/)
  assert.ok(request.messages.map(textOf).some(text => text.startsWith('[MOD] Autorio operation batch completed')), 'it rides the receipt continuation')
  const row = world.rows('context.executor_facts_refreshed_after_batch')[0]
  assert.ok(row)
  assert.equal(row.request_id, world.requestId())
  assert.equal(row.data.handoff_id, world.agent.agentContext.handoffId)
  assert.ok(row.data.fresh_items >= 4)
  assert.equal(row.data.stale_items, 0)
  assert.equal(row.data.residual_needs, 4)
  assert.equal(row.data.reason, 'batch_receipt_landed_after_deferred_handoff_counts')
  assert.equal(world.agent.pendingExecutorFactsRefresh, null, 'consumed')

  // The scripted gather of five plates was admitted; its receipt must not repeat the refresh.
  world.give('copper-plate', 5)
  await world.agent.completed()
  assert.equal(world.rows('context.executor_facts_refreshed_after_batch').length, 1, 'once per deferred handoff')
  const lastContinuation = world.calls[3].messages.map(textOf).filter(text => text.startsWith('[MOD] Autorio operation batch completed')).at(-1)
  assert.ok(lastContinuation, 'the second receipt continued the executor')
  assert.ok(!lastContinuation.includes('Executor facts refreshed'), 'the second receipt carries no second refresh')
})

test('D2 B1: a refresh whose handoff was replaced, or whose actor changed, is skipped and traced, and never briefs the new conversation', async () => {
  const replaced = harness({ game: liveGame(), script: [readsRound(), plannerCommit(), executorGather(5)] })
  await replaced.say()
  assert.ok(replaced.agent.pendingExecutorFactsRefresh)
  replaced.agent.pendingExecutorFactsRefresh = { ...replaced.agent.pendingExecutorFactsRefresh, handoff_id: 'ho_other' }
  replaced.give('copper-plate', 10)
  await replaced.agent.completed()
  assert.equal(replaced.rows('context.executor_facts_refreshed_after_batch').length, 0)
  assert.equal(replaced.rows('context.executor_facts_refresh_skipped')[0].data.reason, 'handoff_replaced')

  const moved = harness({ game: liveGame(), script: [readsRound(), plannerCommit(), executorGather(5)] })
  await moved.say()
  moved.game.onConditionRead = (game) => { game.status = deployment({ epoch: 4 }) }
  moved.give('copper-plate', 10)
  await moved.agent.taskStatusReceipt() // the batch finished
  const text = await moved.agent.executorFactsRefreshText().catch(error => error)
  assert.equal(text, undefined, 'no message when the actor changed during the reads')
  assert.equal(moved.rows('context.executor_facts_refresh_skipped').at(-1).data.reason, 'actor_changed_during_handoff_refresh')
})

test('D2 N1/N2: a restage the guard will refuse spends no reads, and a goal that stopped being restageable during the reads refuses it', async () => {
  const guarded = await plannerCollectedTenCopper()
  const reads = guarded.game.conditionReads.length
  // A turn token the caller does not hold: round_open, refused before any read.
  guarded.agent.turnConversation = { stale: 'token' }
  const refused = await guarded.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:test', actor: guarded.agent.epoch, requestId: guarded.requestId() })
  guarded.agent.turnConversation = null
  assert.equal(refused.restaged, false)
  assert.equal(guarded.game.conditionReads.length, reads, 'no read was spent on a refused restage')

  const world = await plannerCollectedTenCopper()
  world.game.onConditionRead = () => {
    // The goal is paused by the time the reads return.
    const state = world.memory.currentPlan(KEY)
    world.memory.planningState(KEY).goal.status = 'paused'
    void state
  }
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, false)
  assert.equal(result.reason, 'goal_not_active')
  assert.equal(world.rows('context.restage_refused').at(-1).data.reason, 'goal_not_active')
})

test('D2: requiresMachineFacts flags a recipe cut at eight ingredients, and the carried recipe is incomplete', () => {
  const ingredients = Array.from({ length: 10 }, (_, index) => ({ type: 'item', name: `part-${index}`, amount: 1 }))
  const facts = requiresMachineFacts({ code: 'requires_machine', identity: 'big-thing', recipe: { name: 'big-thing', categories: ['crafting'], energy: 1, ingredients, products: [{ type: 'item', name: 'big-thing', amount: 1 }] }, machines: { candidates: [{ name: 'assembling-machine-1' }] } })
  assert.equal(facts.recipe.ingredients.length, 8)
  assert.equal(facts.recipe.ingredients_truncated, true)
  assert.equal(facts.recipe.products_truncated, false)
})

test('D2: a send the game provably never saw leaves nothing in flight, and the next executor restage reads counts', async () => {
  const world = harness({ game: liveGame(), script: [readsRound(), plannerCommit(), plannerCommit()] })
  world.game.beginRefusal = 'stale_actor_epoch' // the mod admission journal refuses the first batch before recording anything
  await assert.rejects(world.say())
  assert.equal(world.rows('operation.not_sent').length, 1, 'the attempt was settled as never sent')
  assert.equal(world.agent.batchInFlight, false, 'a send that never happened is not in flight')
  assert.equal(world.agent.batchInFlightBeforeSend, undefined)

  // An earlier batch that really is in flight stays in flight when a later send is refused.
  world.agent.batchInFlight = true
  world.agent.batchInFlightBeforeSend = true
  await world.agent.settleUnsentOperation({ operation_key: 'op_none', request_id: 'req_x' }, KEY, 'rejected_before_transport').catch(() => {})
  assert.equal(world.agent.batchInFlight, true)
  world.agent.batchInFlight = false

  // The next executor restage reads counts instead of printing a deferral.
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch })
  if (gathered?.facts) {
    assert.equal(gathered.meta.counts_deferred, undefined)
    assert.notEqual(gathered.meta.refresh, 'deferred')
  }
})

test('D2: a reset clears the in-flight flag and the pending refresh, and the next executor restage reads counts', async () => {
  const world = await plannerCollectedTenCopper({ receipt: false })
  assert.equal(world.agent.batchInFlight, true, 'the planner batch is in flight')
  assert.ok(world.agent.pendingExecutorFactsRefresh)
  const actor = world.agent.epoch
  world.agent.reset() // actor replacement, death and a new request all go through reset()
  assert.equal(world.agent.batchInFlight, false)
  assert.equal(world.agent.pendingExecutorFactsRefresh, null)
  const reads = world.game.conditionReads.length
  const result = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:after_reset', actor, requestId: world.requestId() })
  assert.equal(result.restaged, true, JSON.stringify(result))
  const step = textOf(stepBlock(world.agent.messages))
  assert.doesNotMatch(step, /counts_deferred/)
  assert.match(step, /^held_counts \(fresh live read .*copper-plate=10/m)
  assert.ok(world.game.conditionReads.length > reads, 'counts were read')
})

test('D2: a deferred refresh whose actor or epoch changed since the handoff is skipped with actor_changed_since_handoff', async () => {
  const world = await plannerCollectedTenCopper({ receipt: false })
  assert.equal(world.agent.pendingExecutorFactsRefresh.epoch, 3)
  await world.agent.taskStatusReceipt() // the batch finished
  world.agent.epoch = deployment({ epoch: 4 }) // the live read would match this epoch; the handoff was taken under epoch 3
  const reads = world.game.conditionReads.length
  const text = await world.agent.executorFactsRefreshText()
  assert.equal(text, undefined)
  assert.equal(world.game.conditionReads.length, reads, 'nothing was read for the wrong actor')
  assert.equal(world.rows('context.executor_facts_refresh_skipped').at(-1).data.reason, 'actor_changed_since_handoff')
  assert.equal(world.agent.pendingExecutorFactsRefresh, null, 'consumed')

  const otherActor = await plannerCollectedTenCopper({ receipt: false })
  await otherActor.agent.taskStatusReceipt()
  otherActor.agent.epoch = deployment({ actor_id: 19 })
  assert.equal(await otherActor.agent.executorFactsRefreshText(), undefined)
  assert.equal(otherActor.rows('context.executor_facts_refresh_skipped').at(-1).data.reason, 'actor_changed_since_handoff')
})

test('D2: the C8 step-close restage passes the runtime the last receipt showed, so the in-flight check does not rest on the flag alone', async () => {
  const world = await plannerCollectedTenCopper()
  assert.equal(world.agent.lastRuntimeView().idle, true, 'the receipt showed an idle game')
  world.agent.lastTaskStatusView = { task_state: 'running', queue_length: 2, queue_empty: false }
  assert.deepEqual(world.agent.lastRuntimeView(), { task_state: 'running', queue_length: 2, idle: false })
  world.agent.lastTaskStatusView = null
  assert.equal(world.agent.lastRuntimeView(), undefined)

  // The boundary hands it to the restage.
  world.agent.lastTaskStatusView = { task_state: 'running', queue_length: 2, queue_empty: false }
  const plan = getActivePlan(world.memory.planningState(KEY))
  world.agent.executorStepMark = { plan_id: plan.plan_id, closed: -1 }
  let seen
  world.agent.restageBetweenTurns = async (args) => { seen = args; return { restaged: false, reason: 'test' } }
  world.agent.restageSoftLimitTokens = () => 1
  world.agent.agentContext.size = { appendedChars: 0, tokens: 100 } // far past the hard limit
  await world.agent.executorStepCloseBoundary({ withinTurn: false })
  assert.equal(seen?.checkpoint, 'C8')
  assert.deepEqual(seen.runtime, { task_state: 'running', queue_length: 2, idle: false })

  // And the gather defers on that runtime even with the harness flag clear.
  world.agent.batchInFlight = false
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch, runtime: seen.runtime })
  assert.equal(gathered.meta.counts_deferred, 'batch_in_flight')
})

// --- Unit 3a: historical fluid-source hints ---------------------------------------------------------------------------

const WATER_FAR = {
  ok: true, fluid_name: 'water', actor_position: { x: 0, y: 0 }, surface_index: 1, observed_tick: 77, search_radius: 128,
  coverage: 'generated_bounding_square', checked_chunks: 81, matching_tile_prototypes: 2,
  samples: [{ name: 'water', fluid_name: 'water', position: { x: 22, y: 8 }, surface_index: 1 }, { name: 'water', fluid_name: 'water', position: { x: -82, y: -19 }, surface_index: 1 }],
  returned_count: 2, truncated: false, ordering: 'native_samples_not_nearest',
}
const fluidRound = () => ({
  tool_calls: [
    read('getFluidSourceTiles', { fluid_name: 'water' }, 'water_far'),
    read('getFluidSourceTiles', { fluid_name: 'water', search_radius: 16 }, 'water_local'),
  ].map((call, index) => ({ ...call, index })),
})

test('3a: water seen by an earlier read and then an empty local read: the restage packet still lists the anchors as historical, and the carry is traced', async () => {
  const world = harness({ game: liveGame(), script: [fluidRound(), readsRound(), plannerCommit(), executorGather(5)] })
  await world.say()
  assert.deepEqual(world.game.fluidReads, [128, 16], 'the far read found water, the local read found none')
  assert.deepEqual([...world.agent.handoffFluidHints.keys()], ['1:22:8', '1:-82:-19'], 'the empty local read erased nothing')
  world.give('copper-plate', 10)
  await world.agent.taskStatusReceipt()
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.equal(world.agent.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length, 0, 'the reads themselves are gone from the conversation')

  const line = lineOf(world.agent.messages, 'fluid_source_hints')
  assert.match(line, /^fluid_source_hints \(HISTORICAL: positions where native fluid tiles were observed earlier, newest first; NOT current, not nearest, not a reachable or legal placement; re-check with getFluidSourceTiles before placing anything\): /)
  assert.match(line, /water:water@\(-82,-19\) surface=1 observed tick:77,epoch:3 \| water:water@\(22,8\) surface=1 observed tick:77,epoch:3$/)

  const row = world.rows('context.fluid_source_hints_carried').find(item => item.data.checkpoint === 'C7')
  assert.ok(row, 'context.fluid_source_hints_carried was traced')
  assert.equal(row.request_id, world.requestId())
  assert.equal(row.data.request_id, world.requestId())
  assert.equal(row.data.handoff_id, result.handoff_id)
  assert.equal(row.data.reason, 'historical_native_tile_locations_only')
  assert.equal(row.data.retained, 2)
  assert.equal(row.data.known, 2)
  assert.equal(row.data.dropped_for_size, false)
  assert.ok(world.rows('context.fluid_source_hints_carried').some(item => item.data.checkpoint === 'C3'), 'the commit handoff carried them too')
  assert.equal(world.rows('context.executor_facts_carried').find(item => item.data.checkpoint === 'C7').data.dropped_for_size.includes('fluid_source_hints'), false)

  // The per-request observation reset keeps them (water is world data); only the goal boundary clears them.
  world.agent.resetHandoffObservations()
  assert.equal(world.agent.handoffFluidHints.size, 2)
  world.agent.resetHandoffFluidHints()
  assert.equal(world.agent.handoffFluidHints.size, 0)
  // The next restage carries none and traces none.
  const carried = world.rows('context.fluid_source_hints_carried').length
  const again = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:after_reset', actor: world.agent.epoch, requestId: world.requestId() })
  assert.equal(again.restaged, true, JSON.stringify(again))
  assert.doesNotMatch(textOf(stepBlock(world.agent.messages)), /fluid_source_hints/)
  assert.equal(world.rows('context.fluid_source_hints_carried').length, carried)
})

test('3a: anchors outlive a chat amendment and a "continue" in the same goal, and end when a new goal starts', async () => {
  for (const intent of ['amend_current', 'continue_current']) {
    const world = harness({ game: liveGame(), script: [fluidRound(), readsRound(), plannerCommit(), executorGather(5), executorGather(5), executorGather(5), executorGather(5)] })
    await world.say()
    assert.equal(world.agent.handoffFluidHints.size, 2, 'the planner read found water')
    const goalId = world.memory.planningState(KEY).goal.goal_id
    let resets = 0
    const baseReset = world.agent.resetHandoffObservations.bind(world.agent)
    world.agent.resetHandoffObservations = () => { resets += 1; baseReset() }
    world.intent = intent
    world.give('copper-plate', 10)
    await world.agent.taskStatusReceipt()
    await world.agent.request('please also keep an eye on the water', { sender: 'TTLouis' }).catch(() => {})
    assert.ok(resets >= 1, `${intent}: the chat message went through request()'s per-request observation reset`)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId, `${intent}: still the same goal`)
    assert.equal(world.agent.handoffFluidHints.size, 2, `${intent}: the water anchors survived the chat message`)
    await world.agent.taskStatusReceipt().catch(() => {})
    const result = await restageToFreshExecutor(world)
    assert.equal(result.restaged, true, JSON.stringify(result))
    assert.match(lineOf(world.agent.messages, 'fluid_source_hints'), /water:water@\(22,8\) surface=1/)
  }

  const fresh = harness({ game: liveGame(), script: [fluidRound(), readsRound(), plannerCommit(), executorGather(5), plannerCommit(), executorGather(5)] })
  await fresh.say()
  assert.equal(fresh.agent.handoffFluidHints.size, 2)
  fresh.intent = 'new_goal'
  await fresh.agent.request('make iron plates instead', { sender: 'TTLouis' }).catch(() => {})
  assert.equal(fresh.agent.handoffFluidHints.size, 0, 'a new goal starts without the last goal\'s anchors')
})

test('3a: the anchors come from the tool-result text the model itself received, so a wrapper around the answer would stop them', async () => {
  const world = harness({ game: liveGame(), script: [fluidRound(), readsRound(), plannerCommit(), executorGather(5)] })
  await world.say()
  const toolMessages = world.calls[1].messages.filter(message => message.role === 'tool')
  const farMessage = toolMessages.find(message => message.tool_call_id === 'call_water_far')
  assert.deepEqual(JSON.parse(farMessage.content), WATER_FAR, 'the model was handed the raw mod answer')
  assert.deepEqual([...world.agent.handoffFluidHints.keys()], ['1:22:8', '1:-82:-19'], 'and the very same text became the anchors')
  // The empty local answer reached the model too and added nothing.
  assert.equal(JSON.parse(toolMessages.find(message => message.tool_call_id === 'call_water_local').content).returned_count, 0)
})

test('3a: a size-dropped hint record is traced as dropped, not silently missing', async () => {
  const world = await plannerCollectedTenCopper()
  world.agent.recordHandoffToolFacts('getFluidSourceTiles', JSON.stringify(WATER_FAR), { fluid_name: 'water' })
  assert.equal(world.agent.handoffFluidHints.size, 2)
  // The packet drops whole records when over its limit (handoff-packet.test.mjs); the loop reports it instead of going silent.
  const packet = { executor_facts: { recipe_facts: 3, fluid_source_hints: 0 }, dropped: ['fluid_source_hints'] }
  await world.agent.traceExecutorFactsCarried({ packet, restaged: { handoff_id: 'ho_dropped' }, checkpoint: 'C7', requestId: world.requestId(), meta: {} })
  const row = world.rows('context.fluid_source_hints_carried').find(item => item.data.checkpoint === 'C7')
  assert.equal(row.data.retained, 0)
  assert.equal(row.data.known, 2)
  assert.equal(row.data.dropped_for_size, true)
  assert.equal(row.data.reason, 'historical_native_tile_locations_only')
})

test('3a: only a well-formed answer to the request that was made reaches the cache', async () => {
  const world = await plannerCollectedTenCopper()
  const record = (answer, args) => world.agent.recordHandoffToolFacts('getFluidSourceTiles', typeof answer === 'string' ? answer : JSON.stringify(answer), args)
  const request = { fluid_name: 'water' }
  for (const [answer, args] of [
    ['not json', request],
    [{ ...WATER_FAR, ok: false, code: 'fluid_source_search_unexplored' }, request],
    [{ ...WATER_FAR, search_radius: 64 }, request], // a radius the request did not make
    [WATER_FAR, { fluid_name: 'steam' }], // another fluid than asked
    [WATER_FAR, undefined], // no request to check the answer against
    [{ ...WATER_FAR, returned_count: 3 }, request],
    [{ ...WATER_FAR, samples: [{ ...WATER_FAR.samples[0], surface_index: 2 }, WATER_FAR.samples[1]] }, request],
    [{ ...WATER_FAR, padding: 'x'.repeat(5000) }, request],
  ]) record(answer, args)
  assert.equal(world.agent.handoffFluidHints.size, 0)
  record(WATER_FAR, request)
  assert.equal(world.agent.handoffFluidHints.size, 2)
  record({ ...WATER_FAR, samples: [], returned_count: 0 }, request)
  record('not json', request)
  assert.equal(world.agent.handoffFluidHints.size, 2, 'an empty or failed read never erases anchors')
})

// --- Unit 3b: the harness closes the recipe chain under the step's inventory roots ------------------------------------

// A lab root whose recipes nobody read: the planner commits "have a lab" straight away, so the cache is empty.
const labRootPlan = () => planReply({
  plan: STEPS,
  currentStep: 0,
  operations: [gather('iron-ore', 5)],
  checkpoint: inventoryCheckpoint('lab', 1),
  goal: GOAL,
  roadmap: SHELF,
})
const labWorld = (extra = {}) => harness({ game: liveGame(extra.gameOptions), script: [...(extra.script ?? []), labRootPlan(), executorGather(5)] })

test('3b: an empty recipe cache and a lab root: the harness reads the recipe chain itself, so the residual has crafts instead of a one-row raw leaf', async () => {
  const world = labWorld()
  await world.say()
  // At the commit the planner batch is in flight: the executor sees this packet after it ends, so nothing is read.
  assert.equal(world.agent.batchInFlight, true)
  assert.deepEqual(world.game.recipeReads, [])
  assert.equal(world.rows('context.recipe_closure_prefetched').length, 0)
  assert.equal(world.agent.handoffRecipeFacts.size, 0)

  await world.agent.taskStatusReceipt() // the batch finished
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  // Breadth first from the root: the lab, its three ingredients, then what those need; raw plates have no recipe.
  assert.deepEqual(world.game.recipeReads, ['lab', 'electronic-circuit', 'iron-gear-wheel', 'transport-belt', 'iron-plate', 'copper-cable', 'copper-plate'])
  assert.deepEqual([...world.agent.handoffRecipeFacts.keys()].sort(), ['copper-cable', 'electronic-circuit', 'iron-gear-wheel', 'lab', 'transport-belt'])
  const step = textOf(stepBlock(world.agent.messages))
  assert.match(step, /^recipe_fact lab .*ingredients=10 electronic-circuit \+ 10 iron-gear-wheel \+ 4 transport-belt/m)
  assert.match(step, /^recipe_fact electronic-circuit /m)
  const residual = step.split('\n').find(line => line.startsWith('residual_needs'))
  assert.match(residual, /for the step contract lab>=1/)
  assert.match(residual, /lab required=1 held=0 missing=1 crafts=1 via lab/)
  assert.match(residual, /electronic-circuit required=10 held=0 missing=10 crafts=10 via electronic-circuit/)

  const row = world.rows('context.recipe_closure_prefetched')[0]
  assert.ok(row, 'context.recipe_closure_prefetched was traced')
  assert.equal(row.request_id, world.requestId())
  assert.equal(row.data.request_id, world.requestId())
  assert.deepEqual({ reads: row.data.reads, found: row.data.found, unreadable: row.data.unreadable, no_recipe: row.data.no_recipe, truncated: row.data.truncated }, { reads: 7, found: 5, unreadable: 0, no_recipe: 2, truncated: false })
  assert.deepEqual(row.data.roots, ['lab'])
  assert.ok(world.rows('context.executor_facts_carried').find(item => item.data.checkpoint === 'C7').data.reads_attempted >= 7, 'the prefetch reads are counted with the other handoff reads')
  assert.equal(row.data.reason, 'step_roots_without_cached_recipe_facts')

  // Cached recipes (and the two raw items the game has no recipe for) are not read again at the next restage.
  const reads = world.game.recipeReads.length
  const again = await restageToFreshExecutor(world)
  assert.equal(again.restaged, true, JSON.stringify(again))
  assert.equal(world.game.recipeReads.length, reads)
  assert.equal(world.rows('context.recipe_closure_prefetched').length, 1)
})

// The flake this pins (about 1 run in 6): a handoff id hashed goal, plan, role, checkpoint, the millisecond clock and the packet text, so two
// restages of unchanged state in one millisecond got one id and the second was refused as a reused id (restage_error). The clock is frozen here.
test('two restages of unchanged state in the same millisecond get distinct handoff ids and both land', async () => {
  const world = labWorld()
  await world.say()
  await world.agent.taskStatusReceipt()
  const realNow = Date.now
  const frozen = realNow.call(Date)
  Date.now = () => frozen
  try {
    const first = await restageToFreshExecutor(world)
    const second = await restageToFreshExecutor(world)
    assert.equal(first.restaged, true, JSON.stringify(first))
    assert.equal(second.restaged, true, JSON.stringify(second))
    assert.notEqual(first.handoff_id, second.handoff_id)
    assert.equal(world.rows('context.restage_error').length, 0)
  }
  finally {
    Date.now = realNow
  }
})

test('3b: a root recipe the model already read is not read again; only the missing links are', async () => {
  const world = labWorld({ script: [{ tool_calls: [{ ...read('getRecipeDetails', { item_or_recipe: 'lab', requested_count: 1 }, 'lab'), index: 0 }] }] })
  await world.say()
  assert.deepEqual(world.game.recipeReads, ['lab'], 'the model read the lab itself')
  await world.agent.taskStatusReceipt()
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.deepEqual(world.game.recipeReads.slice(1), ['electronic-circuit', 'iron-gear-wheel', 'transport-belt', 'iron-plate', 'copper-cable', 'copper-plate'])
  assert.equal(world.rows('context.recipe_closure_prefetched')[0].data.reads, 6)
})

test('3b: at most eight recipe reads per handoff, and the cut is reported', async () => {
  const parts = Array.from({ length: 8 }, (_, index) => `part-${index}`)
  const recipes = {
    'mega-thing': detail('mega-thing', parts.map(part => [part, 1]), [['mega-thing', 1]], ['assembling-machine-1']),
    ...Object.fromEntries(parts.map((part, index) => [part, detail(part, [[`raw-${index}`, 1]], [[part, 1]], ['assembling-machine-1'])])),
  }
  const world = harness({
    game: liveGame({ recipes }),
    script: [planReply({ plan: STEPS, currentStep: 0, operations: [gather('iron-ore', 5)], checkpoint: inventoryCheckpoint('mega-thing', 1), goal: GOAL, roadmap: SHELF }), executorGather(5)],
  })
  await world.say()
  await world.agent.taskStatusReceipt()
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.deepEqual(world.game.recipeReads, ['mega-thing', ...parts.slice(0, 7)])
  const row = world.rows('context.recipe_closure_prefetched')[0]
  assert.deepEqual({ reads: row.data.reads, found: row.data.found, truncated: row.data.truncated }, { reads: 8, found: 8, truncated: true })
})

test('3b: no recipe reads while a batch is in flight, however the in-flight state is known', async () => {
  const world = labWorld()
  await world.say()
  await world.agent.taskStatusReceipt()
  for (const [flag, runtime] of [[true, undefined], [false, { idle: false }], [false, { queue_length: 2 }]]) {
    world.agent.batchInFlight = flag
    const gathered = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch, runtime })
    assert.equal(gathered.meta.counts_deferred, 'batch_in_flight')
    assert.equal(gathered.meta.recipe_prefetch, undefined)
  }
  assert.deepEqual(world.game.recipeReads, [])
  assert.equal(world.agent.handoffRecipeFacts.size, 0)
  // The deferred half of the handoff reads counts only, never recipes.
  world.agent.batchInFlight = false
  const refresh = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch, mode: 'refresh' })
  assert.equal(refresh.meta.recipe_prefetch, undefined)
  assert.deepEqual(world.game.recipeReads, [])
})

test('3b: an actor or epoch change refuses the restage, and what the prefetch read does not stay in the cache', async () => {
  const during = labWorld()
  await during.say()
  await during.agent.taskStatusReceipt()
  during.game.onRecipeRead = (game) => { game.status = deployment({ epoch: 4 }) } // the actor is replaced while recipes are being read
  const carriedBefore = during.rows('context.executor_facts_carried').length
  const refused = await restageToFreshExecutor(during)
  assert.deepEqual(refused, { restaged: false, reason: 'actor_changed_during_handoff_refresh' })
  assert.equal(during.agent.handoffRecipeFacts.size, 0, 'nothing read under the old epoch stays')
  assert.equal(during.rows('context.executor_facts_carried').length, carriedBefore)
  assert.equal(during.rows('context.recipe_closure_prefetched').length, 0)
  assert.equal(during.rows('context.restage_refused').at(-1).data.reason, 'actor_changed_during_handoff_refresh')
  assert.ok(during.rows('context.restage_refused').at(-1).data.reads_attempted >= 1, 'a refusal still reports the reads it spent')

  // A change before the first read spends no read at all.
  const before = labWorld()
  await before.say()
  await before.agent.taskStatusReceipt()
  const fenced = before.agent.epoch
  before.game.status = deployment({ actor_id: 19, epoch: 4 })
  const reads = before.game.recipeReads.length
  const refusedBefore = await before.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:test', actor: fenced, requestId: before.requestId() })
  assert.deepEqual(refusedBefore, { restaged: false, reason: 'actor_changed_before_handoff_refresh' })
  assert.equal(before.game.recipeReads.length, reads)
  assert.equal(before.agent.handoffRecipeFacts.size, 0)
})

test('3b: an unreadable recipe answer is counted, not cached, and does not stop the restage', async () => {
  const world = labWorld()
  await world.say()
  await world.agent.taskStatusReceipt()
  const base = world.game.command
  world.game.command = async (text) => {
    if (/recipe_details.*transport-belt/.test(text)) throw new Error('rcon transport closed')
    return base(text)
  }
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const row = world.rows('context.recipe_closure_prefetched')[0]
  assert.equal(row.data.unreadable, 1)
  assert.ok(!world.agent.handoffRecipeFacts.has('transport-belt'))
  assert.equal(world.agent.handoffNoRecipeItems.has('transport-belt'), false, 'a failed read is not "no recipe"')
})

test('3b: the mod\'s no_recipe answer (with its mining sources) is remembered and never re-read; any other found:false answer is a failed read', async () => {
  const recipes = { 'widget-root': detail('widget-root', [['iron-ore', 2], ['unlisted-thing', 1]], [['widget-root', 1]], ['assembling-machine-1']) }
  const world = harness({
    game: liveGame({ recipes }),
    script: [planReply({ plan: STEPS, currentStep: 0, operations: [gather('iron-ore', 5)], checkpoint: inventoryCheckpoint('widget-root', 1), goal: GOAL, roadmap: SHELF }), executorGather(5)],
  })
  await world.say()
  await world.agent.taskStatusReceipt()
  const base = world.game.command
  world.game.command = async (text) => {
    // The remote interface's answer when the actor is gone: found:false with an error and no recipe code.
    if (/recipe_details.*unlisted-thing/.test(text)) {
      world.game.recipeReads.push('unlisted-thing')
      return JSON.stringify({ found: false, query: 'unlisted-thing', error: 'no controlled actor' })
    }
    return base(text)
  }
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.deepEqual(world.game.recipeReads, ['widget-root', 'iron-ore', 'unlisted-thing'])
  assert.deepEqual([...world.agent.handoffNoRecipeItems], ['iron-ore'], 'only the declared no_recipe answer is remembered')
  const row = world.rows('context.recipe_closure_prefetched')[0]
  assert.deepEqual({ reads: row.data.reads, found: row.data.found, no_recipe: row.data.no_recipe, unreadable: row.data.unreadable }, { reads: 3, found: 1, no_recipe: 1, unreadable: 1 })
  // The raw item is not read again; the failed read is retried.
  const again = await restageToFreshExecutor(world)
  assert.equal(again.restaged, true, JSON.stringify(again))
  assert.deepEqual(world.game.recipeReads.slice(3), ['unlisted-thing'])
})


// Run C: the local scan was empty; native discovery can locate copper without another model call.
function sourceAnswer(resource = 'copper-ore', type = 'resource') {
  return { found: true, name: resource, actor_position: { x: 0, y: 0 }, searched_radius: 193, max_radius: 1024,
    matched_count: 1, returned_count: 1, truncated: false,
    entities: [{ name: resource, type, position: { x: 192.5, y: 8.5 }, distance: 192.688868386, ...(type === 'resource' ? { amount: 2200 } : {}), force: 'neutral' }] }
}
async function rawCopperWorld() {
  const recycling = detail('copper-ore-recycling', [['copper-ore', 1]], [['copper-ore', 1]], ['recycler'], { categories: ['recycling'] })
  recycling.products[0].probability = 0.25
  recycling.inventory_overlay = { diagnostics: 'native recipe detail '.repeat(180) }
  const world = harness({ game: liveGame({ inventory: { 'burner-mining-drill': 1, 'stone-furnace': 1, 'iron-plate': 8 }, recipes: {
    'copper-plate': detail('copper-plate', [['copper-ore', 1]], [['copper-plate', 1]], ['stone-furnace'], { categories: ['smelting'], energy: 3.2 }),
    'copper-ore': recycling,
  } }), script: [planReply({ plan: ['Produce 10 copper plates'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-plate', 10) }], goal: GOAL, roadmap: SHELF }), planReply({ plan: ['Produce 10 copper plates'], currentStep: 0, operations: [gather('copper-ore', 10)] })], agentOptions: { completionProtocolVersion: 2 } })
  await world.say()
  return world
}

test('6 run C: copper acquisition is carried before executor observations; raw recycling does not expand the closure', async () => {
  const world = await rawCopperWorld()
  const step = textOf(stepBlock(world.agent.messages))
  assert.match(step, /copper-ore missing=10 raw: mined_from=copper-ore/)
  assert.match(step, /nearest=\(192.5,8.5\) distance=192.7/)
  assert.match(step, /reach\/path unverified/)
  assert.doesNotMatch(step, /recycling|asteroid/)
  assert.deepEqual(world.game.recipeReads, ['copper-plate', 'copper-ore'])
  assert.deepEqual(world.game.sourceReads, ['copper-ore'])
  const trace = world.rows('context.raw_leaf_acquisition')[0]
  assert.equal(trace.request_id, world.requestId())
  assert.equal(trace.data.request_id, world.requestId())
  assert.equal(trace.data.reason, 'missing_raw_materials_with_native_mining_sources')
  assert.equal(trace.data.found, 1)
  assert.equal(trace.data.reads, 1)
})

test('6: absence and read failure stay distinct; locations are refreshed, never cached', async () => {
  const world = await rawCopperWorld()
  world.agent.batchInFlight = false
  world.game.sourceAnswer = { ...sourceAnswer(), found: false, searched_radius: 1024, matched_count: 0, returned_count: 0, entities: [] }
  await restageToFreshExecutor(world)
  assert.match(lineOf(world.agent.messages, 'raw_leaf_acquisition'), /nearest=none_within_1024/)
  world.game.sourceAnswer = { ok: false, error: 'no controlled actor' }
  await restageToFreshExecutor(world)
  assert.match(lineOf(world.agent.messages, 'raw_leaf_acquisition'), /nearest=read_failed/)
  assert.doesNotMatch(lineOf(world.agent.messages, 'raw_leaf_acquisition'), /192.5|none_within/)
  assert.equal(world.rows('context.raw_leaf_acquisition').at(-1).data.failed, 1)
})

test('6: a source search crossing an actor epoch refuses the restage and carries no location', async () => {
  const world = await rawCopperWorld()
  world.agent.batchInFlight = false
  world.game.onSourceRead = game => { game.status = deployment({ epoch: 4 }) }
  const carried = world.rows('context.raw_leaf_acquisition').length
  assert.deepEqual(await restageToFreshExecutor(world), { restaged: false, reason: 'actor_changed_during_handoff_refresh' })
  assert.equal(world.rows('context.raw_leaf_acquisition').length, carried)
})

test('6: recipe-prefetch fence rollback restores raw leaves and the no-recipe memo', async () => {
  const world = labWorld()
  await world.say()
  await world.agent.taskStatusReceipt()
  world.game.onRecipeRead = (game, name) => { if (name === 'iron-plate') game.status = deployment({ epoch: 4 }) }
  assert.equal((await restageToFreshExecutor(world)).restaged, false)
  assert.equal(world.agent.handoffRawLeaves.size, 0)
  assert.equal(world.agent.handoffNoRecipeItems.size, 0)
})


test('6: a collateral crushing product cannot suppress the exact copper mining query', async () => {
  const world = await plannerCollectedTenCopper()
  const crushing = detail('advanced-metallic-asteroid-crushing', [['metallic-asteroid-chunk', 1]], [['iron-ore', 20], ['copper-ore', 10]], ['crusher'])
  world.agent.recordHandoffToolFacts('getRecipeDetails', JSON.stringify({ found: true, query: 'iron-ore', mined_from: ['iron-ore'], recipes: [crushing] }), { item_or_recipe: 'iron-ore' })
  assert.equal(world.agent.handoffRawLeaves.has('copper-ore'), false)
  await world.agent.prefetchRecipeClosure({ roots: [{ item: 'copper-ore', count: 10 }], fence: world.agent.epoch })
  assert.equal(world.game.recipeReads.at(-1), 'copper-ore')
  assert.deepEqual(world.agent.handoffRawLeaves.get('copper-ore').mined_from, ['copper-ore'])
})


test('6: at most three distinct resource searches per handoff; held and in-flight raw leaves spend none', async () => {
  const world = await rawCopperWorld()
  world.agent.batchInFlight = false
  const state = structuredClone(world.memory.planningState(KEY))
  const held = getActivePlan(state)
  const ores = ['copper-ore', 'iron-ore', 'stone', 'coal']
  held.steps[held.active_step_index].completion_contract = { mode: 'all', requirements: ores.map(item => ({ kind: 'inventory_count', item_name: item, minimum: 10 })) }
  for (const item of ores) world.agent.handoffRawLeaves.set(item, { item, mined_from: [item] })
  const before = world.game.sourceReads.length
  const result = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch })
  assert.equal(world.game.sourceReads.length - before, 3)
  const unread = result.facts.residual.rows.filter(row => row.raw?.sources[0].state === 'not_read')
  assert.equal(unread.length, 1)
  assert.ok(!world.game.sourceReads.slice(before).includes(unread[0].item))
  const count = world.game.sourceReads.length
  await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, runtime: { idle: false } })
  assert.equal(world.game.sourceReads.length, count)
  for (const item of ores) world.game.inventory[item] = 10
  await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch })
  assert.equal(world.game.sourceReads.length, count)
})


// --- Unit 8: trigger-research production facts, machine energy and burner fuel -----------------------------------------
//
// Live run E (2026-10-13, GPT-6, fresh world): the step was "Complete electronics trigger by producing 10 copper plates",
// its contract only `research_completed electronics`. The executor packet had no production root (residual derivation
// only knew inventory_count contracts) and nothing said that the stone furnace in the starter kit burns fuel, that the
// actor held none, or how fuel is natively acquired. The scripted answers below are the live shapes: the captured
// electronics node from getResearchPath, the requirements read's trigger_crafting machine options, and the mod's
// getRecipeDetails answer for copper-plate (crafting_machines with energy_source and top-level burner_fuels).

const RESEARCH_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/luna-research-handoff-2026-10-06.json', import.meta.url), 'utf8'))
const ELECTRONICS_NODE = RESEARCH_FIXTURE.researchPath.nodes.find(node => node.name === 'electronics')
const E_STEPS = ['Complete electronics trigger by producing 10 copper plates']
const E_GOAL = { scope: 'long_horizon', summary: 'Research electronics.', doneWhen: [{ id: 'research', kind: 'research_completed', technology: 'electronics' }] }
const E_CONTRACT = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'electronics' }] }

const furnaceMachine = (name, source, extra = {}) => ({
  name, type: 'furnace', placed_by_item: name, crafting_speed: 1, seconds_per_craft: 3.2, crafts_per_second: 0.3125,
  products_per_minute: [{ type: 'item', name: 'copper-plate', per_minute: 18.75 }], energy_source: source, energy_watts: 90000, ...extra,
})
const copperPlateRecipe = (machines = [
  furnaceMachine('electric-furnace', 'electric', { crafting_speed: 2, energy_watts: 180000 }),
  furnaceMachine('steel-furnace', 'burner', { burner_effectivity: 1, fuel_categories: ['chemical'] }),
  furnaceMachine('stone-furnace', 'burner', { burner_effectivity: 1, fuel_categories: ['chemical'] }),
]) => ({
  ...detail('copper-plate', [['copper-ore', 1]], [['copper-plate', 1]], [], { categories: ['smelting'], energy: 3.2 }),
  hand_craftable_category: false,
  crafting_machine_count: machines.length,
  crafting_machines: machines,
})
// The mod's burner_fuels (knowledge.ts): the items the burner categories accept, resource-mined fuels first, then name order.
const BURNER_FUELS = { categories: ['chemical'], matched_count: 3, truncated: false, items: [
  { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
  { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000 },
  { name: 'wood', category: 'chemical', fuel_value: 2000000 },
] }
// goal_requirements as the mod answers it: the stone furnace is craftable now, the others are locked behind research.
const requirementsFor = ({ stone = 'craftable', steel = 'locked', electric = 'locked' } = {}) => ({
  ok: true, tick: 5380, locked: [], unknown: [], machines: [],
  counts: { locked: 0, recipes_walked: 1, unlocked_recipes: 0, raw_items: 0 }, truncated: {},
  research: { electronics: { mode: 'trigger', status: 'ready', requires: [], trigger: { type: 'craft-item', item: 'copper-plate', count: 10 },
    trigger_crafting: { item: 'copper-plate', recipes: [{ recipe: 'copper-plate', enabled: true, categories: ['smelting'], categories_truncated: false,
      hand_craftable: false, hand_craftable_reason: 'category_unsupported', machines_truncated: false, machines: [
        { entity: 'stone-furnace', item: 'stone-furnace', status: stone },
        { entity: 'steel-furnace', item: 'steel-furnace', status: steel, unlocked_by: 'advanced-material-processing' },
        { entity: 'electric-furnace', item: 'electric-furnace', status: electric, unlocked_by: 'advanced-material-processing-2' },
      ] }] } } },
})

const electronicsCommit = () => planReply({
  plan: E_STEPS, currentStep: 0, operations: [], stepCompletions: [{ kind: 'deterministic', checkpoint: E_CONTRACT }], goal: E_GOAL, roadmap: SHELF,
})
const electronicsGather = () => planReply({ plan: E_STEPS, currentStep: 0, operations: [gather('copper-ore', 10)] })
// The executor's tool-call submitPlan (stepId, operations, observationRequest): no plan and no currentStep.
const executorRead = (tool, args, rationale) => (_messages, _context, world) => {
  const stepId = world.agent.targetedObservationIdentity().data.stepId
  return { content: '', tool_calls: [{ id: 'call_read', index: 0, type: 'function', function: { name: 'submitPlan',
    arguments: JSON.stringify({ stepId, operations: [], observationRequest: { stepId, tool, args, rationale } }) } }] }
}

async function runEWorld({ inventory = {}, statuses, fuels = BURNER_FUELS, recipe = copperPlateRecipe(), script, mutate } = {}) {
  const game = liveGame({
    inventory: { 'burner-mining-drill': 1, 'stone-furnace': 1, 'iron-plate': 8, 'copper-ore': 10, ...inventory },
    recipes: { 'copper-plate': recipe },
    fuels,
    researchNodes: [ELECTRONICS_NODE],
  })
  game.requirements = requirementsFor(statuses)
  mutate?.(game)
  const world = harness({ game, script: script ?? [electronicsCommit(), electronicsGather()], agentOptions: { completionProtocolVersion: 2 } })
  // The same production sanitizer the requirements query uses, so its trigger_crafting and machine options reach the cache.
  world.agent.recordRequirementsFacts(parseGoalRequirements(JSON.stringify(game.requirements)))
  await world.say()
  return world
}

const stepLine = (world, prefix) => textOf(stepBlock(world.agent.messages)).split('\n').find(line => line.startsWith(prefix))

test('8 run E: a trigger step carries its production target, the burner fuel requirement, fuel held 0 and the native fuel source, and the executor read is admitted', async () => {
  const world = await runEWorld({ script: [electronicsCommit(),
    executorRead('findLongRangeEntities', { name: 'coal', max_radius: 1024, limit: 1 }, 'The packet names coal as the native fuel source; locate the nearest instance again before committing to a route.'),
    electronicsGather()] })
  const step = textOf(stepBlock(world.agent.messages))

  // B: the contract is only research_completed, yet the packet derives the production root from the live research trigger.
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /for the step contract trigger:copper-platex10;/)
  assert.match(residual, /trigger craft-item copper-plate count=10 for electronics \(counts new crafts; held stock not counted\) held=0 crafts=10 via copper-plate/)
  assert.match(residual, /copper-ore required=10 held=10 missing=0/, 'ingredients still net against held stock')
  assert.deepEqual(world.game.recipeReads, ['copper-plate', 'copper-ore'], 'the trigger root enters the same recipe-closure prefetch')
  assert.deepEqual(world.game.researchReads.slice(0, 1), ['electronics'])

  // C: the machine energy sources, with the held count and the placement fact, and the fuel the burner needs.
  const machines = stepLine(world, 'machine_energy')
  assert.match(machines, /: stone-furnace energy=burner\(fuel_categories=chemical, 90kW\) status=craftable held=1 placed=not_observed \| not_listed: locked=2$/)
  assert.doesNotMatch(machines, /steel-furnace|electric-furnace/)
  const fuel = stepLine(world, 'fuel_needs')
  assert.match(fuel, /^fuel_needs \(burner stone-furnace burn fuel_categories=chemical;/)
  assert.match(fuel, /\): held_fuel=none \| coal fuel_value=4MJ held=0 raw: mined_from=coal \(source observation; reach\/path unverified\) nearest=\(192\.5,8\.5\) distance=192\.7/)
  assert.match(fuel, /solid-fuel fuel_value=12MJ held=0 no_derived_source \| wood fuel_value=2MJ held=0 no_derived_source/)
  assert.doesNotMatch(fuel, /trees and other non-resource sources are not derived/, 'the limitation no longer holds: harvested_from is derived')
  assert.match(fuel, /natural trees and rocks the harvest operation mines for it \(harvested_from\)/)
  assert.equal(world.game.sourceReads[0], 'coal', 'the fuel resource is read with the same nearest-instance path as raw leaves (copper ore is held, so no ore read)')
  assert.doesNotMatch(step, /steel-furnace energy|electric-furnace energy/)

  // D: named traces with the request id and a reason.
  const requestId = world.requestId()
  const derived = world.rows('context.trigger_production_derived')[0]
  assert.equal(derived.data.request_id, requestId)
  assert.deepEqual({ technology: derived.data.technology, item: derived.data.item, count: derived.data.count, held_counted: derived.data.held_counted },
    { technology: 'electronics', item: 'copper-plate', count: 10, held_counted: false })
  assert.equal(derived.data.reason, 'trigger_technology_counts_new_crafts_not_held_stock')
  const carried = world.rows('context.machine_energy_carried')[0]
  assert.equal(carried.data.request_id, requestId)
  assert.deepEqual({ machines: carried.data.machines, burner_count: carried.data.burner_count, fuel_held: carried.data.fuel_held, fuel_sources_read: carried.data.fuel_sources_read, carried: carried.data.carried },
    { machines: ['stone-furnace'], burner_count: 1, fuel_held: false, fuel_sources_read: 1, carried: true })
  assert.ok(carried.data.reason)
  const facts = world.rows('context.executor_facts_carried')[0]
  assert.equal(facts.data.machine_energy, 1)
  assert.equal(facts.data.fuel_needs, 3)
  assert.ok(facts.data.reads_attempted >= 5, 'recipe, research, count and fuel-source reads are counted')

  // A: the executor submitPlan (stepId, operations [], observationRequest, no plan/currentStep) reached the read path.
  assert.equal(world.rows('observation.targeted_refused').length, 0)
  const grant = world.rows('observation.normal_from_control')[0]
  assert.equal(grant.data.request_id, requestId)
  assert.equal(grant.data.tool, 'findLongRangeEntities')
  assert.equal(grant.data.reason, 'normal_tools_available_use_existing_observation_budget')
  assert.equal(world.rows('observation.targeted_granted').length, 0, 'open executor read uses ordinary admission')
  assert.deepEqual(world.game.sourceReads, ['coal', 'coal'])
  assert.equal(world.game.mutations.length, 1, 'only the scripted gather ran; the read changed nothing')
})

test('8 B: held stock of the trigger item is shown but never netted against the trigger count; ingredients net against held stock', async () => {
  const world = await runEWorld({ inventory: { 'copper-plate': 10, 'copper-ore': 4 } })
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /trigger craft-item copper-plate count=10 for electronics \(counts new crafts; held stock not counted\) held=10 crafts=10 via copper-plate/)
  assert.match(residual, /copper-ore required=10 held=4 missing=6/)
  assert.doesNotMatch(residual, /copper-plate required=/, 'the target is not rendered as an inventory row that held stock could satisfy')
  assert.deepEqual(world.game.sourceReads, ['copper-ore', 'coal'], 'missing ore is acquired through the raw-leaf path; fuel shares the same bound')
  assert.match(stepLine(world, 'raw_leaf_acquisition'), /copper-ore missing=6 raw: mined_from=copper-ore/)
  assert.equal(world.rows('context.trigger_production_derived')[0].data.held_counted, false)
})

test('8 C: fuel the actor holds is listed as held and suppresses the acquisition search', async () => {
  const world = await runEWorld({ inventory: { coal: 5 } })
  const fuel = stepLine(world, 'fuel_needs')
  assert.match(fuel, /held_fuel=coal=5 \(acquisition not searched\)/)
  assert.match(fuel, /coal fuel_value=4MJ held=5/)
  assert.doesNotMatch(fuel, /nearest=/)
  assert.deepEqual(world.game.sourceReads, [])
  const carried = world.rows('context.machine_energy_carried')[0]
  assert.deepEqual({ fuel_held: carried.data.fuel_held, fuel_sources_read: carried.data.fuel_sources_read }, { fuel_held: true, fuel_sources_read: 0 })
})

test('8 C: an empty or failed fuel source read stays distinct and is counted; nothing is carried as a location', async () => {
  const none = await runEWorld({ mutate: (game) => { game.sourceAnswer = { found: false, name: 'coal', actor_position: { x: 0, y: 0 }, searched_radius: 1024, max_radius: 1024, matched_count: 0, returned_count: 0, truncated: false, entities: [] } } })
  assert.match(stepLine(none, 'fuel_needs'), /coal fuel_value=4MJ held=0 raw: mined_from=coal \(source observation; reach\/path unverified\) nearest=none_within_1024/)
  const failed = await runEWorld({ mutate: (game) => { game.sourceAnswer = { ok: false, error: 'no controlled actor' } } })
  assert.match(stepLine(failed, 'fuel_needs'), /nearest=read_failed/)
  assert.doesNotMatch(stepLine(failed, 'fuel_needs'), /192\.5|none_within/)
  assert.ok(failed.rows('context.executor_facts_carried')[0].data.reads_failed >= 1)
})

test('8 C: with only an electric machine available there is no fuel row and no fuel read', async () => {
  const world = await runEWorld({ statuses: { stone: 'locked', electric: 'craftable' }, inventory: { 'stone-furnace': 0 } })
  const machines = stepLine(world, 'machine_energy')
  assert.match(machines, /: electric-furnace energy=electric\(180kW\) status=craftable held=0 placed=not_observed \| not_listed: locked=2$/)
  assert.equal(stepLine(world, 'fuel_needs'), undefined)
  assert.deepEqual(world.game.sourceReads, [])
  const carried = world.rows('context.machine_energy_carried')[0]
  assert.deepEqual({ machines: carried.data.machines, burner_count: carried.data.burner_count, fuel_held: carried.data.fuel_held, fuel_sources_read: carried.data.fuel_sources_read },
    { machines: ['electric-furnace'], burner_count: 0, fuel_held: false, fuel_sources_read: 0 })
})

test('8 C: a furnace the harness saw placed is reported as observed history with its count, not as a current target', async () => {
  const world = await runEWorld({ inventory: { 'stone-furnace': 0 }, statuses: { stone: 'locked' }, script: [electronicsCommit(), electronicsGather()] })
  world.agent.recordLiveEntityObservation({ unit_number: 41, name: 'stone-furnace', type: 'furnace', position: { x: 3, y: 4 } }, undefined, 'retained_nearby')
  world.agent.batchInFlight = false
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch })
  const entry = gathered.facts.machine_energy.machines.find(machine => machine.name === 'stone-furnace')
  assert.deepEqual(entry.placed, { observed: true, count: 1, via: 'historical_entities' })
  assert.equal(entry.held, undefined, 'a locked machine item is not counted, so its held count is unknown rather than zero')
  const text = executorFactsRefreshMessage(gathered.facts)
  assert.match(text, /stone-furnace energy=burner\(fuel_categories=chemical, 90kW\) status=locked held=unknown placed=observed\(x1 via historical_entities\)/)
  assert.doesNotMatch(text, /unit_number/)
})

test('8 C: an in-flight batch defers the energy and fuel facts; the refresh after the receipt carries them', async () => {
  const world = await runEWorld()
  const state = world.memory.planningState(KEY)
  const deferred = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, runtime: { idle: false } })
  assert.equal(deferred.facts.machine_energy, undefined)
  assert.equal(deferred.facts.fuel_needs, undefined)
  world.agent.batchInFlight = false
  const announced = world.rows('context.trigger_production_derived').length
  const refreshed = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, mode: 'refresh' })
  assert.equal(world.rows('context.trigger_production_derived').length, announced, 'the refresh does not announce the production root again')
  const text = executorFactsRefreshMessage(refreshed.facts)
  assert.match(text, /^machine_energy /m)
  assert.match(text, /^fuel_needs /m)
  assert.match(text, /^residual_needs .*trigger craft-item copper-plate count=10/m)
})

test('8 C: fuel resource searches share the three-resource bound with raw leaves and report the unread rest', async () => {
  const world = await runEWorld({ inventory: { 'copper-ore': 0 } })
  world.agent.batchInFlight = false
  const state = structuredClone(world.memory.planningState(KEY))
  const held = getActivePlan(state)
  const ores = ['copper-ore', 'iron-ore', 'stone']
  held.steps[held.active_step_index].completion_contract = { mode: 'all', requirements: [
    { kind: 'research_completed', technology: 'electronics' },
    ...ores.map(item => ({ kind: 'inventory_count', item_name: item, minimum: 10 })),
  ] }
  for (const item of ores) world.agent.handoffRawLeaves.set(item, { item, mined_from: [item] })
  world.agent.handoffFuelSources.clear() // a coal location read at C3 would be reused; this scenario is about the bound
  const before = world.game.sourceReads.length
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch })
  assert.equal(world.game.sourceReads.length - before, 3, 'three distinct resources at most, raw leaves first')
  assert.ok(!world.game.sourceReads.slice(before).includes('coal'))
  const coal = gathered.facts.fuel_needs.items.find(item => item.name === 'coal')
  assert.equal(coal.raw.sources[0].state, 'not_read')
  assert.match(executorFactsRefreshMessage(gathered.facts), /coal fuel_value=4MJ held=0 raw: mined_from=coal \(source observation; reach\/path unverified\) nearest=not_read/)
})

test('8: a source read crossing an actor epoch refuses the restage and carries no fuel location', async () => {
  const world = await runEWorld()
  world.agent.batchInFlight = false
  world.agent.handoffFuelSources.clear() // the C3 read of this step and epoch would otherwise be reused: force a new read
  world.game.onSourceRead = game => { game.status = deployment({ epoch: 4 }) }
  const carried = world.rows('context.machine_energy_carried').length
  assert.deepEqual(await restageToFreshExecutor(world), { restaged: false, reason: 'actor_changed_during_handoff_refresh' })
  assert.equal(world.rows('context.machine_energy_carried').length, carried)
})

test('8 C: a refresh in the same step and epoch reuses the fuel location with its own as_of; a failed read is never reused', async () => {
  const world = await runEWorld()
  world.agent.batchInFlight = false
  const state = world.memory.planningState(KEY)
  const reads = world.game.sourceReads.length
  const first = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch })
  const refreshed = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, mode: 'refresh' })
  assert.equal(world.game.sourceReads.length, reads, 'the C3 read of this step and epoch is reused')
  const coalOf = facts => facts.fuel_needs.items.find(item => item.name === 'coal').raw
  assert.equal(coalOf(first.facts).sources[0].state, 'found')
  assert.deepEqual(coalOf(refreshed.facts).as_of, coalOf(first.facts).as_of, 'the reused location keeps the tag of the read it came from')
  assert.match(executorFactsRefreshMessage(refreshed.facts), /nearest=\(192\.5,8\.5\) distance=192\.7/)
  assert.equal(first.meta.machine_energy.fuel_sources_reused, 1)
  assert.equal(first.meta.machine_energy.fuel_sources_read, 0)

  const failing = await runEWorld({ mutate: (game) => { game.sourceAnswer = { ok: false, error: 'no controlled actor' } } })
  failing.agent.batchInFlight = false
  const before = failing.game.sourceReads.length
  failing.game.sourceAnswer = undefined
  const retried = await failing.agent.gatherExecutorHandoffFacts({ state: failing.memory.planningState(KEY), actor: failing.agent.epoch })
  assert.equal(failing.game.sourceReads.length, before + 1, 'the failed read is retried')
  assert.equal(retried.facts.fuel_needs.items.find(item => item.name === 'coal').raw.sources[0].state, 'found')
})

test('8 C: when a fuel count could not be read the held fuel is unknown and no source search is made', async () => {
  const world = await runEWorld({ mutate: (game) => { game.failConditionReads = true } })
  const fuel = stepLine(world, 'fuel_needs')
  assert.match(fuel, /: held_fuel=unknown \(3 of 3 counts unread\) \(acquisition not searched\) \| coal fuel_value=4MJ held=unknown \|/)
  assert.doesNotMatch(fuel, /nearest=/)
  assert.deepEqual(world.game.sourceReads, [])
  assert.match(stepLine(world, 'machine_energy'), /stone-furnace energy=burner\(fuel_categories=chemical, 90kW\) status=craftable held=unknown/)
  const carried = world.rows('context.machine_energy_carried')[0]
  assert.deepEqual({ fuel_held: carried.data.fuel_held, fuel_counts_unread: carried.data.fuel_counts_unread, fuel_sources_read: carried.data.fuel_sources_read },
    { fuel_held: false, fuel_counts_unread: 3, fuel_sources_read: 0 })
})

test('8 C: machine and fuel counts rank after refresh and touched items; what the cap cuts is reported unread, never absent', async () => {
  const world = await runEWorld()
  world.agent.batchInFlight = false
  const state = world.memory.planningState(KEY)
  const crowd = Array.from({ length: 12 }, (_, index) => `filler-item-${index}`)
  const before = world.game.sourceReads.length
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, mode: 'refresh', refreshItems: crowd })
  assert.equal(gathered.meta.read_items.length, 12)
  assert.ok(!gathered.meta.read_items.includes('stone-furnace') && !gathered.meta.read_items.includes('coal'))
  assert.deepEqual(gathered.meta.read_items.slice(0, 2), ['copper-plate', 'copper-ore'], 'the closure still comes first')
  assert.equal(gathered.facts.machine_energy.machines[0].held, undefined)
  assert.equal(gathered.facts.fuel_needs.search, 'unknown_counts')
  const text = executorFactsRefreshMessage(gathered.facts)
  assert.match(text, /stone-furnace energy=burner\(fuel_categories=chemical, 90kW\) status=craftable held=unknown/)
  assert.match(text, /held_fuel=unknown \(3 of 3 counts unread\) \(acquisition not searched\)/)
  assert.equal(world.game.sourceReads.length, before, 'unknown counts start no source search')
  assert.equal(gathered.meta.machine_energy.fuel_counts_unread, 3)
})


// --- Unit 9: build-step bills, science residuals, harvest sources, not-ready triggers -----------------------------------------
//
// Live run F (2026-10-13/14): a steam-power build step (offshore pump, boiler, steam engines, small poles) had a contract with no
// inventory root, so the executor was briefed with no bill; the fixed 12-item count cap would have dropped a 15-item bill anyway.
// The scripted answers are the live shapes: getPrototypeDetails (entity.place_items), the mod's entity_count condition, getTechnology
// (saved_progress), discoverPrototypes (entity-type lab) and getRecipeDetails with harvested_from for a tree-yielded item.

const STEAM_STEPS = ['Build steam power: an offshore pump, a boiler, two steam engines and two small poles']
const STEAM_GOAL = { scope: 'long_horizon', summary: 'Get steam power running.', doneWhen: [{ id: 'power', kind: 'entity_working', entity_name: 'steam-engine', minimum: 1 }] }
const entityCount = (id, prototype, minimum) => ({ id, kind: 'entity_count', prototype, minimum })
const STEAM_CONTRACT = { mode: 'all', requirements: [
  entityCount('pump', 'offshore-pump', 1), entityCount('boiler', 'boiler', 1), entityCount('engine', 'steam-engine', 2), entityCount('poles', 'small-electric-pole', 2),
] }
const STEAM_RECIPES = {
  'offshore-pump': detail('offshore-pump', [['electronic-circuit', 2], ['pipe', 1], ['iron-gear-wheel', 1]], [['offshore-pump', 1]], ['assembling-machine-1']),
  boiler: detail('boiler', [['stone-furnace', 1], ['pipe', 4]], [['boiler', 1]], ['assembling-machine-1']),
  'steam-engine': detail('steam-engine', [['iron-gear-wheel', 8], ['pipe', 5], ['iron-plate', 10]], [['steam-engine', 1]], ['assembling-machine-1']),
  'small-electric-pole': detail('small-electric-pole', [['wood', 1], ['copper-cable', 1]], [['small-electric-pole', 2]], ['assembling-machine-1']),
  pipe: detail('pipe', [['iron-plate', 1]], [['pipe', 1]], ['assembling-machine-1']),
  'stone-furnace': detail('stone-furnace', [['stone', 5]], [['stone-furnace', 1]], ['assembling-machine-1']),
  'iron-plate': detail('iron-plate', [['iron-ore', 1]], [['iron-plate', 1]], ['stone-furnace'], { categories: ['smelting'], energy: 3.2 }),
  'copper-plate': detail('copper-plate', [['copper-ore', 1]], [['copper-plate', 1]], ['stone-furnace'], { categories: ['smelting'], energy: 3.2 }),
}
const STEAM_PROTOS = { 'offshore-pump': [['offshore-pump', 1]], boiler: [['boiler', 1]], 'steam-engine': [['steam-engine', 1]], 'small-electric-pole': [['small-electric-pole', 1]] }
const steamCommit = (contract = STEAM_CONTRACT) => planReply({
  plan: STEAM_STEPS, currentStep: 0, operations: [gather('iron-ore', 25)], stepCompletions: [{ kind: 'deterministic', checkpoint: contract }], goal: STEAM_GOAL, roadmap: SHELF,
})
const steamGather = () => planReply({ plan: STEAM_STEPS, currentStep: 0, operations: [gather('iron-ore', 25)] })

// The planner committed the slice and its batch finished; the executor restage then reads the bill.
async function runSteamWorld({ inventory = { 'iron-plate': 15 }, placed = { 'steam-engine': 1 }, mutate, contract } = {}) {
  const game = liveGame({ inventory, recipes: STEAM_RECIPES })
  game.protos = structuredClone(STEAM_PROTOS)
  game.placed = { ...placed }
  game.harvestedFrom = { wood: ['tree-01', 'tree-02'] }
  game.entityTypes = { 'tree-01': 'tree', 'tree-02': 'tree' }
  game.minedFrom = { stone: ['stone'] }
  mutate?.(game)
  const world = harness({ game, script: [steamCommit(contract), steamGather(), steamGather()], agentOptions: { completionProtocolVersion: 2 } })
  await world.say()
  await world.agent.taskStatusReceipt()
  const restaged = await restageToFreshExecutor(world)
  assert.equal(restaged.restaged, true, JSON.stringify(restaged))
  return world
}

test('9 run F: a steam-power build step carries a bill of the placing items less what is placed, with every count of the 15-item closure read', async () => {
  const world = await runSteamWorld()
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /for the step contract build:offshore-pumpx1,build:boilerx1,build:steam-enginex1,build:small-electric-polex2;/)
  assert.match(residual, /offshore-pump required=1 held=0 missing=1 crafts=1 via offshore-pump \[build offshore-pump: placed=0 of 1, 1 more to place\]/)
  assert.match(residual, /steam-engine required=1 held=0 missing=1 crafts=1 via steam-engine \[build steam-engine: placed=1 of 2, 1 more to place\]/)
  assert.match(residual, /small-electric-pole required=2 held=0 missing=2 crafts=1 via small-electric-pole \[build small-electric-pole: placed=0 of 2, 2 more to place\]/)
  assert.match(residual, /boiler required=1 held=0 missing=1 crafts=1 via boiler \[build boiler: placed=0 of 1, 1 more to place\]/)
  // pipes are shared by the pump (1), the boiler (4) and the engine (5): one row, one craft count.
  assert.match(residual, /pipe required=10 held=0 missing=10 crafts=10 via pipe/)
  assert.match(residual, /iron-plate required=40 held=15 missing=25 crafts=25 via iron-plate/)
  assert.doesNotMatch(residual, /more\)/, 'the whole bill fits the residual bound')
  // Unit 3b reads for a bill are bounded by the bill bound, and the 15-item closure is not cut.
  const prefetch = world.rows('context.recipe_closure_prefetched')[0].data
  assert.equal(prefetch.truncated, false)
  assert.ok(prefetch.reads > EXECUTOR_FACT_LIMITS.recipePrefetchReads, 'more than the ordinary eight recipe reads were allowed for a bill')
  // Every item of the closure has a fresh count: the cap is sized from the closure, past the old fixed twelve.
  const trace = world.rows('context.build_bill_derived').at(-1).data
  assert.ok(trace.items.length > 12, `closure of ${trace.items.length} items`)
  assert.deepEqual(trace.unread, [])
  const held = stepLine(world, 'held_counts')
  for (const item of trace.items) assert.match(held, new RegExp(`${item}=\\d+`), item)
  assert.doesNotMatch(textOf(stepBlock(world.agent.messages)), /too_many_items|NOT derived/)
  assert.deepEqual(world.rows('context.executor_facts_carried').at(-1).data.dropped_for_size, [], 'the bill and its annotations fit the packet')
  // The placing items are prototype data read once; the placed counts are live reads under each requirement's scope.
  assert.deepEqual(world.game.prototypeReads, ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole'])
  // The harness asks for the live count with minimum 1 (it wants the number, not the verdict); authoring asked with the contract's own minimum.
  assert.deepEqual(world.game.entityCountReads.filter(request => request.minimum === 1).slice(-4).map(request => request.prototype), ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole'])
  assert.ok(world.game.entityCountReads.some(request => request.prototype === 'steam-engine' && request.minimum === 2), 'the contract was grounded with its own minimum')
  const reads = world.game.prototypeReads.length
  await restageToFreshExecutor(world)
  assert.equal(world.game.prototypeReads.length, reads, 'the cached placing items are not read again')
})

test('9 run F: the build bill trace names the prototypes, roots, items, what is unread and a reason, with the request id', async () => {
  const world = await runSteamWorld()
  const rows = world.rows('context.build_bill_derived')
  assert.ok(rows.length >= 1)
  const data = rows.at(-1).data
  assert.equal(data.request_id, world.requestId())
  assert.deepEqual(data.prototypes, ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole'])
  assert.deepEqual(data.roots.map(root => [root.item, root.count, root.prototype, root.remaining]),
    [['offshore-pump', 1, 'offshore-pump', 1], ['boiler', 1, 'boiler', 1], ['steam-engine', 1, 'steam-engine', 1], ['small-electric-pole', 2, 'small-electric-pole', 2]])
  assert.deepEqual(data.placed.find(row => row.prototype === 'steam-engine'), { prototype: 'steam-engine', placed: 1, minimum: 2 })
  assert.deepEqual(data.unread, [])
  assert.deepEqual(data.unresolved, [])
  assert.equal(data.reason, 'build_step_entity_count_converted_to_placing_item_bill')
})

test('9: a prototype nothing places, and a failed read, are named as unresolved and never guessed into the bill', async () => {
  const world = await runSteamWorld({ mutate: (game) => { game.protos['offshore-pump'] = []; game.failDetails.add('boiler') } })
  const residual = stepLine(world, 'residual_needs')
  assert.doesNotMatch(residual, /offshore-pump required|boiler required/)
  assert.match(residual, /build_unresolved \(no placing item derived, not in this bill\): offshore-pump:no_placing_item,boiler:prototype_read_failed$/)
  const data = world.rows('context.build_bill_derived').at(-1).data
  assert.deepEqual(data.unresolved, [{ prototype: 'offshore-pump', reason: 'no_placing_item' }, { prototype: 'boiler', reason: 'prototype_read_failed' }])
  // A read failure is not stable: it is retried at the next handoff. A prototype with no placing item is stable and is remembered.
  assert.equal(world.agent.handoffPlacingItems.has('boiler'), false)
  assert.equal(world.agent.handoffPlacingItems.get('offshore-pump').unresolved, 'no_placing_item')
})

test('9: a build step whose entities are all placed has no bill, and says why', async () => {
  const world = await runSteamWorld({ placed: { 'offshore-pump': 1, boiler: 1, 'steam-engine': 2, 'small-electric-pole': 2 } })
  assert.equal(stepLine(world, 'residual_needs'), undefined)
  assert.equal(world.rows('context.executor_facts_carried').at(-1).data.residual_omitted_reason, 'build_requirements_already_met')
})

test('9: a closure past the count bound states the residual as not derived and lists the unread items, never dropping it silently', async () => {
  const parts = Array.from({ length: 8 }, (_, index) => `part-${index}`)
  const subs = part => Array.from({ length: 4 }, (_, index) => `${part}-sub-${index}`)
  const recipes = {
    'big-thing': detail('big-thing', parts.map(part => [part, 1]), [['big-thing', 1]], ['assembling-machine-1']),
    ...Object.fromEntries(parts.map(part => [part, detail(part, subs(part).map(sub => [sub, 1]), [[part, 1]], ['assembling-machine-1'])])),
  }
  const world = harness({
    game: liveGame({ recipes }),
    script: [planReply({ plan: STEPS, currentStep: 0, operations: [gather('iron-ore', 5)], checkpoint: inventoryCheckpoint('big-thing', 1), goal: GOAL, roadmap: SHELF }), executorGather(5)],
  })
  await world.say()
  await world.agent.taskStatusReceipt()
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const line = stepLine(world, 'residual_needs')
  assert.match(line, /^residual_needs \(NOT derived, too_many_items: the step closure has \d+ items, more than the 32 counts the harness reads; unread: /)
  assert.match(line, /part-\d-sub-\d/)
  assert.equal(world.rows('context.executor_facts_carried').at(-1).data.residual_omitted_reason, 'too_many_items')
  assert.equal(world.game.conditionReads.filter(item => item !== undefined).length >= 32, true, 'the bounded 32 counts were read')
})

test('9 run G: a science research step carries the packs of its unit cost less the live research progress, the lab as consumer and its energy source', async () => {
  const pack = detail('automation-science-pack', [['copper-plate', 1], ['iron-gear-wheel', 1]], [['automation-science-pack', 1]], ['assembling-machine-1'], { energy: 5 })
  const node = { name: 'logistic-science-pack', researched: false, mode: 'science', status: 'ready', prerequisites: [], unresolved_prerequisites: [],
    science: { count: 75, energy: 5, ingredients: [{ name: 'automation-science-pack', amount: 1 }], ingredients_truncated: false } }
  const contract = { mode: 'all', requirements: [{ id: 'research', kind: 'research_completed', technology: 'logistic-science-pack' }] }
  const run = async ({ progress, labs = true } = {}) => {
    const game = liveGame({ inventory: { 'copper-plate': 10 }, recipes: { 'automation-science-pack': pack }, researchNodes: [node] })
    game.knownTechnologies.add('logistic-science-pack')
    if (progress !== undefined) game.technologies['logistic-science-pack'] = { found: true, name: 'logistic-science-pack', researched: false, saved_progress: progress, progress, is_current_research: false }
    if (labs) game.labs = { ok: true, query: { capability: 'entity-type', entity_type: 'lab', availability: 'force-available', limit: 4 }, matched_count: 1, available_count: 1, returned_count: 1, truncated: false,
      candidates: [{ name: 'lab', type: 'lab', energy_source: 'electric', place_items: [{ name: 'lab', count: 1 }], force_available: true, enabled_recipe: 'lab', held_count: 1 }] }
    game.inventory.lab = 1
    const world = harness({ game, script: [planReply({ plan: ['Research logistic science'], currentStep: 0, operations: [gather('iron-ore', 5)], stepCompletions: [{ kind: 'deterministic', checkpoint: contract }], goal: GOAL, roadmap: SHELF }), executorGather(5)], agentOptions: { completionProtocolVersion: 2 } })
    await world.say()
    await world.agent.taskStatusReceipt()
    assert.equal((await restageToFreshExecutor(world)).restaged, true)
    return world
  }

  const known = await run({ progress: 0.2 })
  const residual = stepLine(known, 'residual_needs')
  assert.match(residual, /for the step contract science:automation-science-packx60;/)
  assert.match(residual, /automation-science-pack required=60 held=0 missing=60 crafts=60 via automation-science-pack \[science logistic-science-pack: 60 of 75 units x1 per unit, research progress 20% netted; consumed by lab\]/)
  assert.match(residual, /copper-plate required=60 held=10 missing=50/)
  assert.match(residual, /iron-gear-wheel required=60/)
  const machines = stepLine(known, 'machine_energy')
  assert.match(machines, /lab energy=electric status=craftable held=1 placed=not_observed consumes=research_packs/)
  const derived = known.rows('context.science_residual_derived')[0].data
  assert.equal(derived.request_id, known.requestId())
  assert.deepEqual({ technology: derived.technology, units: derived.units, remaining_units: derived.remaining_units, packs: derived.packs, progress_known: derived.progress_known, progress: derived.progress, labs: derived.labs },
    { technology: 'logistic-science-pack', units: 75, remaining_units: 60, packs: [{ item: 'automation-science-pack', count: 60 }], progress_known: true, progress: 0.2, labs: ['lab'] })
  assert.match(derived.reason, /research_progress/)

  // Unknown progress is stated and not netted: the whole 75 units are the need, and no lab read is invented.
  const unknown = await run({ labs: false })
  const unknownResidual = stepLine(unknown, 'residual_needs')
  assert.match(unknownResidual, /automation-science-pack required=75 held=0 missing=75 crafts=75 via automation-science-pack \[science logistic-science-pack: 75 of 75 units x1 per unit, research progress unknown, not netted; consumed by labs \(none listed\)\]/)
  const unknownTrace = unknown.rows('context.science_residual_derived')[0].data
  assert.deepEqual({ progress_known: unknownTrace.progress_known, remaining_units: unknownTrace.remaining_units, labs_read: unknownTrace.labs_read }, { progress_known: false, remaining_units: 75, labs_read: false })
  assert.equal(stepLine(unknown, 'machine_energy'), undefined)
})

test('9 run H: a wood leaf is acquired from a tree; the nearest instance is read like a mining source and the executor read is admitted', async () => {
  const world = await runSteamWorld({ inventory: { 'copper-plate': 10, 'iron-plate': 0 }, placed: {}, contract: { mode: 'all', requirements: [entityCount('poles', 'small-electric-pole', 2)] } })
  const acquisition = stepLine(world, 'raw_leaf_acquisition')
  assert.match(acquisition, /wood missing=1 harvest: harvested_from=tree-01,tree-02 \(source observation; reach\/path unverified\) nearest@tree-01=\(192\.5,8\.5\) distance@tree-01=192\.7 nearest@tree-02=\(192\.5,8\.5\) distance@tree-02=192\.7 as_of=/)
  assert.ok(world.game.sourceReads.includes('tree-01') && world.game.sourceReads.includes('tree-02'))
  assert.ok(world.game.sourceReads.length <= 3, 'harvest reads share the three-source bound')
  const carried = world.rows('context.harvest_sources_carried').at(-1).data
  assert.equal(carried.request_id, world.requestId())
  assert.deepEqual({ items: carried.items, sources: carried.sources, found: carried.found, failed: carried.failed, operation: carried.operation }, { items: ['wood'], sources: ['tree-01', 'tree-02'], found: 2, failed: 0, operation: 'harvest_product' })
  assert.equal(carried.reason, 'natural_trees_and_rocks_the_harvest_operation_mines')
  // The same names are eligible for the one-read allowance, exactly like a mining resource.
  assert.ok(world.agent.targetedResourceSearchNames().includes('tree-01'))
})

test('9 run H: a harvest source read must answer with a non-resource entity of that name, and a miss stays distinct from a failure', async () => {
  const none = await runSteamWorld({ inventory: { 'copper-plate': 10, 'iron-plate': 0 }, placed: {}, contract: { mode: 'all', requirements: [entityCount('poles', 'small-electric-pole', 2)] },
    mutate: (game) => { game.sourceAnswer = { found: false, name: 'tree-01', actor_position: { x: 0, y: 0 }, searched_radius: 1024, max_radius: 1024, matched_count: 0, returned_count: 0, truncated: false, entities: [] } } })
  assert.match(stepLine(none, 'raw_leaf_acquisition'), /nearest@tree-01=none_within_1024/)
  const wrongType = await runSteamWorld({ inventory: { 'copper-plate': 10, 'iron-plate': 0 }, placed: {}, contract: { mode: 'all', requirements: [entityCount('poles', 'small-electric-pole', 2)] },
    mutate: (game) => { game.entityTypes = { 'tree-01': 'resource', 'tree-02': 'resource' } } })
  assert.match(stepLine(wrongType, 'raw_leaf_acquisition'), /nearest@tree-01=read_failed/, 'a resource answer is not a harvest source')
  assert.equal(wrongType.rows('context.harvest_sources_carried').at(-1).data.failed, 2)
})

test('9 run H: a fuel with a tree source is a harvest candidate with the same bounded nearest read', async () => {
  const world = await runEWorld({ fuels: { categories: ['chemical'], matched_count: 3, truncated: false, items: [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000, harvested_from: ['tree-01'] },
    { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000 },
  ] }, mutate: (game) => { game.entityTypes = { 'tree-01': 'tree' } } })
  const fuel = stepLine(world, 'fuel_needs')
  assert.match(fuel, /wood fuel_value=2MJ held=0 harvest: harvested_from=tree-01 \(source observation; reach\/path unverified\) nearest=\(192\.5,8\.5\) distance=192\.7/)
  assert.match(fuel, /coal fuel_value=4MJ held=0 raw: mined_from=coal/)
  assert.match(fuel, /solid-fuel fuel_value=12MJ held=0 no_derived_source/)
  assert.deepEqual(world.game.sourceReads.slice(0, 2), ['coal', 'tree-01'])
  assert.equal(world.rows('context.harvest_sources_carried').at(-1).data.fuel_items[0], 'wood')
  assert.ok(world.agent.targetedResourceSearchNames().includes('tree-01'))
})

test('9 G8: a trigger whose prerequisites are unresolved says crafts now are not credited, instead of presenting the craft as productive', async () => {
  const blocked = { ...ELECTRONICS_NODE, status: 'blocked_by_prerequisites', prerequisites: ['automation'], unresolved_prerequisites: ['automation'] }
  const world = await runEWorld({ mutate: (game) => { game.researchNodes = [blocked] } })
  const research = stepLine(world, 'research_path')
  assert.match(research, /"credited_only_after_prerequisites":true/)
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /trigger craft-item copper-plate count=10 for electronics \(not ready: prerequisites automation unresolved; crafts now are not credited; held stock not counted\)/)
  assert.doesNotMatch(residual, /counts new crafts/)
  assert.match(residual, /tech_status=blocked_by_prerequisites/)
  // A ready trigger (all prerequisites researched) is unchanged and carries no such fact.
  const ready = await runEWorld()
  assert.doesNotMatch(stepLine(ready, 'research_path'), /credited_only_after_prerequisites/)
  assert.match(stepLine(ready, 'residual_needs'), /\(counts new crafts; held stock not counted\)/)
})


// --- Unit 9 review fixes ----------------------------------------------------------------------------------------------------

async function runScienceWorld({ technology, labs = true } = {}) {
  const pack = detail('automation-science-pack', [['copper-plate', 1], ['iron-gear-wheel', 1]], [['automation-science-pack', 1]], ['assembling-machine-1'], { energy: 5 })
  const node = { name: 'logistic-science-pack', researched: false, mode: 'science', status: 'ready', prerequisites: [], unresolved_prerequisites: [],
    science: { count: 75, energy: 5, ingredients: [{ name: 'automation-science-pack', amount: 1 }], ingredients_truncated: false } }
  const contract = { mode: 'all', requirements: [{ id: 'research', kind: 'research_completed', technology: 'logistic-science-pack' }] }
  const game = liveGame({ inventory: { 'copper-plate': 10, lab: 1 }, recipes: { 'automation-science-pack': pack }, researchNodes: [node] })
  game.knownTechnologies.add('logistic-science-pack')
  if (technology) game.technologies['logistic-science-pack'] = { found: true, name: 'logistic-science-pack', researched: false, ...technology }
  if (labs) game.labs = { ok: true, query: { capability: 'entity-type', entity_type: 'lab', availability: 'force-available', limit: 4 }, candidates: [{ name: 'lab', type: 'lab', energy_source: 'electric', place_items: [{ name: 'lab', count: 1 }], force_available: true, enabled_recipe: 'lab', held_count: 1 }] }
  const world = harness({ game, script: [planReply({ plan: ['Research logistic science'], currentStep: 0, operations: [gather('iron-ore', 5)], stepCompletions: [{ kind: 'deterministic', checkpoint: contract }], goal: GOAL, roadmap: SHELF }), executorGather(5)], agentOptions: { completionProtocolVersion: 2 } })
  await world.say()
  await world.agent.taskStatusReceipt()
  assert.equal((await restageToFreshExecutor(world)).restaged, true)
  return world
}

test('9 review: the active research is netted from the force progress, not from saved_progress; a missing progress stays unknown', async () => {
  // The step's technology is the current research at 60%; saved_progress belongs to a technology that is not current and reads 0.
  const current = await runScienceWorld({ technology: { is_current_research: true, progress: 0.6, saved_progress: 0 } })
  assert.match(stepLine(current, 'residual_needs'), /automation-science-pack required=30 held=0 missing=30 crafts=30 via automation-science-pack \[science logistic-science-pack: 30 of 75 units x1 per unit, research progress 60% netted; consumed by lab\]/)
  const derived = current.rows('context.science_residual_derived')[0].data
  assert.deepEqual({ remaining_units: derived.remaining_units, progress: derived.progress, progress_known: derived.progress_known }, { remaining_units: 30, progress: 0.6, progress_known: true })
  // An answer carrying only saved_progress (an older mod, or no progress field) is not trusted: unknown, not netted.
  const legacy = await runScienceWorld({ technology: { saved_progress: 0.5 } })
  assert.match(stepLine(legacy, 'residual_needs'), /75 of 75 units x1 per unit, research progress unknown, not netted/)
  const garbage = await runScienceWorld({ technology: { progress: 'half', saved_progress: 0.5 } })
  assert.match(stepLine(garbage, 'residual_needs'), /research progress unknown, not netted/)
})

test('9 review: a state-scoped build counts what stands without the state filter, and the state count is a separate read fact', async () => {
  // One steam engine stands but is not powered; the step asks for one powered engine.
  const contract = { mode: 'all', requirements: [{ id: 'engine', kind: 'entity_count', prototype: 'steam-engine', minimum: 1, state: 'powered' }, entityCount('pump', 'offshore-pump', 1)] }
  const world = await runSteamWorld({ contract, placed: { 'steam-engine': 1, 'offshore-pump': 1 }, mutate: (game) => { game.stateCounts['steam-engine:powered'] = 0; game.stateCounts['offshore-pump:powered'] = 0 } })
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /\(nothing left to acquire for the step contract builds; entities standing, state counts read now\) \| build_state \(read fact, not netted\): steam-engine placed=1 powered=0 of 1, 0 more to place$/)
  assert.doesNotMatch(residual, /steam-engine required|pipe|iron-gear-wheel/, 'a standing engine adds no second engine\'s items to the bill')
  // The harness read the placed count with no state filter, and the state count with it.
  const reads = world.game.entityCountReads.filter(request => request.prototype === 'steam-engine')
  assert.ok(reads.some(request => request.state === undefined && request.minimum === 1))
  assert.ok(reads.some(request => request.state === 'powered' && request.minimum === 1))
  const data = world.rows('context.build_bill_derived').at(-1).data
  assert.deepEqual(data.placed.find(row => row.prototype === 'steam-engine'), { prototype: 'steam-engine', placed: 1, minimum: 1, state: 'powered', state_count: 0 })
  assert.deepEqual(data.roots, [])
  // With more to place, the state fact rides on the row.
  const more = await runSteamWorld({ contract: { mode: 'all', requirements: [{ id: 'engine', kind: 'entity_count', prototype: 'steam-engine', minimum: 3, state: 'powered' }] }, placed: { 'steam-engine': 1 }, mutate: (game) => { game.stateCounts['steam-engine:powered'] = 0 } })
  assert.match(stepLine(more, 'residual_needs'), /steam-engine required=2 .* \[build steam-engine: placed=1 powered=0 of 3, 2 more to place\]/)
})

test('9 review: an unread placed count is left out of the bill and named, never guessed as the whole minimum', async () => {
  const world = await runSteamWorld({ mutate: (game) => { game.failPlacedFor.add('steam-engine') } })
  const residual = stepLine(world, 'residual_needs')
  assert.doesNotMatch(residual, /steam-engine required|more to place: unknown/)
  assert.match(residual, /build_unresolved \(no placing item derived, not in this bill\): steam-engine:placed_count_unread$/)
  assert.match(residual, /offshore-pump required=1 .*\[build offshore-pump: placed=0 of 1, 1 more to place\]/, 'the readable builds keep their bill')
  assert.deepEqual(world.rows('context.build_bill_derived').at(-1).data.unresolved, [{ prototype: 'steam-engine', reason: 'placed_count_unread' }])
})

test('9 review G8: a disabled trigger technology is not credited either, read from the same research node', async () => {
  const disabled = { ...ELECTRONICS_NODE, status: 'disabled', enabled: false, unresolved_prerequisites: [] }
  const world = await runEWorld({ mutate: (game) => { game.researchNodes = [disabled] } })
  assert.match(stepLine(world, 'research_path'), /"enabled":false/)
  assert.match(stepLine(world, 'residual_needs'), /trigger craft-item copper-plate count=10 for electronics \(not ready: technology disabled; crafts now are not credited; held stock not counted\)/)
  const both = await runEWorld({ mutate: (game) => { game.researchNodes = [{ ...disabled, unresolved_prerequisites: ['automation'] }] } })
  assert.match(stepLine(both, 'residual_needs'), /\(not ready: prerequisites automation unresolved, technology disabled; crafts now are not credited; held stock not counted\)/)
  const enabled = await runEWorld()
  assert.doesNotMatch(stepLine(enabled, 'research_path'), /"enabled":false/)
})

// Unit 14 (run H, 2026-10-14). The restaged executor said "no furnace fuel is available" and "the furnace is configured for copper plates"
// while stone furnace 26 held 9 coal, 5 copper ore and 4 copper plates. The packet carried the ACTOR's stock (fuel_held=false) and the
// furnace only as a kind name in historical_entities, so a placed machine's own fuel, source and output were not facts the model had.
const FURNACE_26 = { found: true, entity: { unit_number: 26, name: 'stone-furnace', type: 'furnace', recipe: 'copper-plate', inventories: [
  { index: 1, items: [{ name: 'coal', count: 9 }] },
  { index: 2, items: [{ name: 'copper-ore', count: 5 }] },
  { index: 3, items: [{ name: 'copper-plate', count: 4 }] },
  { index: 4, items: [] },
] } }

async function furnaceWorld({ statusRead = 'matched', inventory = { 'iron-ore': 42, 'iron-plate': 8 }, recipes, furnace = FURNACE_26 } = {}) {
  // The actor holds 42 iron ore, 8 iron plates and no coal (run H); the step contract is an inventory count, not a machine requirement.
  const world = harness({
    game: liveGame({ inventory, recipes }),
    script: [
      { tool_calls: [read('getNearbyEntities', { radius: 16 }, 'nearby'), ...readsRound().tool_calls.slice(0, 3)].map((call, index) => ({ ...call, index })) },
      planReply({ plan: ['Smelt 10 copper plates', 'Craft the lab'], currentStep: 0, operations: [gather('copper-ore', 10)], checkpoint: inventoryCheckpoint('copper-plate', 10), goal: GOAL, roadmap: SHELF }),
    ],
  })
  const baseCommand = world.game.command
  world.statusReads = 0
  world.game.command = async (text) => {
    if (text.includes('"evaluate_condition"') && text.includes('entity_state')) {
      return JSON.stringify({ ok: true, kind: 'entity_state', satisfied: false, progressing: false, progress_known: true, entity_status: 8, unit_number: 26 })
    }
    if (text.includes('get_entity_status')) {
      world.statusReads += 1
      if (statusRead === 'fail') throw new Error('rcon transport closed')
      return JSON.stringify(furnace)
    }
    return baseCommand(text)
  }
  world.game.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 26, position: { x: 3, y: 3 }, distance: 4.2, status: 8, working: false, last_user: 'TTLouis' }] }
  await world.say()
  await world.agent.taskStatusReceipt()
  return world
}

test('unit 14: a placed furnace\'s own fuel, source and output are carried as fresh facts, labelled apart from the actor\'s held stock', async () => {
  const world = await furnaceWorld()
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const line = lineOf(world.agent.messages, 'placed_machines')
  assert.match(line, /^placed_machines \(crafting machines seen in an earlier nearby scan or read, not necessarily built by SGLuna or still standing; machine_fuel, machine_source and machine_output are the MACHINE's own inventories, NOT the actor's held items in held_counts and fuel_needs; FRESH = live read now, STALE = earlier observation\): /)
  assert.match(line, /stone-furnace unit=26 \[FRESH as_of=tick:\d+,epoch:3\] working=false machine_fuel=\{coal:9\} machine_source=\{copper-ore:5\} machine_output=\{copper-plate:4\} source_item_types=1 last_user=TTLouis$/)
  assert.doesNotMatch(line, /iron-ore|iron-plate/, 'the actor\'s stock is a different record (held_counts)')
  // The actor's own stock stays where it was: iron ore, no coal.
  const held = lineOf(world.agent.messages, 'held_counts ')
  assert.match(held, /iron-plate=8|copper-plate=0|iron-ore=42/)
  assert.doesNotMatch(held, /coal=[1-9]/)

  // Counted in the trace, with the request and handoff ids and a reason.
  const [carried] = world.rows('context.placed_machines_carried')
  assert.deepEqual({ candidates: carried.data.candidates, fresh: carried.data.fresh, stale: carried.data.stale, unread: carried.data.unread, carried: carried.data.carried, dropped: carried.data.dropped_for_size },
    { candidates: 1, fresh: 1, stale: 0, unread: 0, carried: 1, dropped: false })
  assert.equal(carried.data.request_id, world.requestId())
  assert.equal(carried.data.handoff_id, result.handoff_id)
  assert.equal(carried.data.reason, 'placed_machine_own_inventories_kept_distinct_from_actor_held_items')
  const facts = world.rows('context.executor_facts_carried').at(-1)
  assert.equal(facts.data.placed_machines, 1)
  // The ambiguous actor-only flag now says whose it is.
  for (const row of world.rows('context.machine_energy_carried')) assert.equal(row.data.fuel_held_scope, 'actor_inventory')
})

test('unit 14: a placed furnace the actor cannot read now is carried from its last observation, labelled stale, never as fresh', async () => {
  const world = await furnaceWorld()
  await restageToFreshExecutor(world) // the fresh read also records the inventories this observation will carry
  const baseCommand = world.game.command
  world.game.command = async (text) => {
    if (text.includes('get_entity_status')) throw new Error('rcon transport closed')
    return baseCommand(text)
  }
  const again = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:again', actor: world.agent.epoch, requestId: world.requestId() })
  assert.equal(again.restaged, true, JSON.stringify(again))
  const line = lineOf(world.agent.messages, 'placed_machines')
  assert.match(line, /stone-furnace unit=26 \[STALE observed tick:\d+,epoch:3, NOT current; inventory_read_failed\] working=false machine_fuel=\{coal:9\} machine_source=\{copper-ore:5\} machine_output=\{copper-plate:4\}/)
  assert.doesNotMatch(line, /\[FRESH/)
  const [, stale] = world.rows('context.placed_machines_carried')
  assert.deepEqual({ fresh: stale.data.fresh, stale: stale.data.stale, carried: stale.data.carried }, { fresh: 0, stale: 1, carried: 1 })
})

test('unit 14: a placed machine whose inventories were never read is counted as unread and not invented', async () => {
  const world = await furnaceWorld({ statusRead: 'fail' })
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  assert.equal(lineOf(world.agent.messages, 'placed_machines'), undefined)
  const [carried] = world.rows('context.placed_machines_carried')
  assert.deepEqual({ candidates: carried.data.candidates, fresh: carried.data.fresh, stale: carried.data.stale, unread: carried.data.unread, carried: carried.data.carried },
    { candidates: 1, fresh: 0, stale: 0, unread: 1, carried: 0 })
})

test('unit 14: a read that fails to match a placed machine keeps the old observation\'s own tick, seq and epoch, and the stale label is dated by them', async () => {
  const world = await furnaceWorld()
  await restageToFreshExecutor(world) // a fresh read recorded the inventories and dated them
  const unit = () => world.agent.liveEntityObservations.get('unit:26')
  assert.equal(unit().observed_epoch, 3)
  unit().observed_epoch = 2 // the observation was taken under an earlier epoch than the one the actor is in now
  const dated = { observed_tick: unit().observed_tick, observed_seq: unit().observed_seq, observed_epoch: unit().observed_epoch }
  // Time passes: a batch lands (the world moved on), the game tick advances, and the actor can no longer read the machine's inventories.
  world.agent.worldMutationSeq += 5
  world.agent.lastTaskStatusView = { ...(world.agent.lastTaskStatusView ?? {}), last_completed_batch: { ...(world.agent.lastTaskStatusView?.last_completed_batch ?? {}), tick: (dated.observed_tick ?? 0) + 3000 } }
  const baseCommand = world.game.command
  world.game.command = async (text) => {
    if (text.includes('get_entity_status')) return JSON.stringify({ found: true, entity: { ...FURNACE_26.entity, unit_number: 99 } }) // the nearest furnace is another unit
    return baseCommand(text)
  }
  const gathered = await world.agent.gatherExecutorHandoffFacts({ state: world.memory.planningState(KEY), actor: world.agent.epoch })
  assert.deepEqual({ tick: unit().observed_tick, seq: unit().observed_seq, epoch: unit().observed_epoch, inventories: JSON.stringify(unit().inventories) },
    { tick: dated.observed_tick, seq: dated.observed_seq, epoch: dated.observed_epoch, inventories: JSON.stringify(FURNACE_26.entity.inventories) })
  const [entry] = gathered.facts.placed_machines
  assert.equal(entry.state, 'stale')
  assert.equal(entry.reason, 'inventory_nearest_is_other_unit')
  assert.deepEqual({ tick: entry.as_of.tick, epoch: entry.as_of.epoch }, { tick: dated.observed_tick, epoch: 2 }, 'dated by the observation, not by the current epoch 3')
})

// Unit 15 (run I, 2026-10-14). The step contract was `inventory_count copper-plate>=10`, the actor held 9 plates and stone furnace 13's OWN
// output held 3. The residual ignored the machine stock, said one more copper ore had to be mined and smelted, and the executor looped on
// "need one more ore" for six automatic resumes. Machine output read FRESH now is collectable stock toward the shortfall; the row keeps the
// actor's held count and names the machine, because the contract counts the actor inventory.
const furnaceEntity = ({ unit = 13, fuel = [{ name: 'coal', count: 9 }], source = [], output = [] } = {}) => ({ found: true, entity: { unit_number: unit, name: 'stone-furnace', type: 'furnace', recipe: 'copper-plate', inventories: [
  { index: 1, items: fuel },
  { index: 2, items: source },
  { index: 3, items: output },
  { index: 4, items: [] },
] } })

const runIWorld = ({ held = 9, output = 3, ...options } = {}) => furnaceWorld({
  inventory: { 'copper-plate': held },
  recipes: { 'copper-plate': copperPlateRecipe() },
  furnace: furnaceEntity({ unit: 26, output: output > 0 ? [{ name: 'copper-plate', count: output }] : [] }),
  ...options,
})

test('unit 15 run I: a fresh furnace output that covers the shortfall leaves no crafts, no ore demand and no raw-leaf row, and names the machine', async () => {
  const world = await runIWorld({ held: 9, output: 3 })
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /^residual_needs \(derived from recipe_fact and fresh held_counts and FRESH placed_machines output reads for the step contract copper-plate>=10; shared stock counted once; in_machine_output is stock inside a machine, not held, and the step contract counts the actor inventory; it is counted from FRESH reads only, never from a STALE observation; move_items_exact to_entity=false transfers machine contents to the actor\): /)
  assert.match(residual, /copper-plate required=10 held=9 in_machine_output=3@stone-furnace unit=26 missing_after_machine=0 crafts=0 via copper-plate/)
  assert.doesNotMatch(residual, /copper-ore required=/, 'no ore is demanded: the machine output covers the shortfall')
  assert.equal(stepLine(world, 'raw_leaf_acquisition'), undefined, 'no copper-ore acquisition row')
  // The actor's own count is unchanged: the plates in the furnace are not held.
  assert.match(stepLine(world, 'held_counts'), /copper-plate=9/)
  assert.match(stepLine(world, 'placed_machines'), /stone-furnace unit=26 \[FRESH as_of=tick:\d+,epoch:3\] .*machine_output=\{copper-plate:3\}/)

  // Traced with the request and handoff ids, the rows credited and a reason.
  const credited = world.rows('context.residual_machine_stock_credited')
  assert.equal(credited.length, 1)
  assert.equal(credited[0].data.request_id, world.requestId())
  assert.equal(credited[0].data.handoff_id, result.handoff_id)
  assert.equal(credited[0].data.reason, 'fresh_machine_output_counted_toward_residual')
  assert.deepEqual(credited[0].data.items, [{ item: 'copper-plate', required: 10, held: 9, missing_before_machine: 1, missing_after_machine: 0, machines: [{ name: 'stone-furnace', unit_number: 26, count: 3 }] }])
  const facts = world.rows('context.executor_facts_carried').at(-1)
  assert.equal(facts.data.residual_machine_stock_credited, 1)
})

test('unit 15: a stale furnace observation is never credited toward the residual', async () => {
  const world = await runIWorld({ held: 9, output: 3 })
  await restageToFreshExecutor(world) // a fresh read records the furnace inventories
  const baseCommand = world.game.command
  world.game.command = async (text) => {
    if (text.includes('get_entity_status')) throw new Error('rcon transport closed')
    return baseCommand(text)
  }
  const again = await world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:again', actor: world.agent.epoch, requestId: world.requestId() })
  assert.equal(again.restaged, true, JSON.stringify(again))
  assert.match(stepLine(world, 'placed_machines'), /\[STALE observed/)
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /copper-plate required=10 held=9 missing=1 crafts=1 via copper-plate/)
  assert.match(residual, /copper-ore required=1 held=0 missing=1/)
  assert.doesNotMatch(residual, /in_machine_output|FRESH placed_machines/)
  assert.match(stepLine(world, 'raw_leaf_acquisition'), /^raw_leaf_acquisition: copper-ore missing=1 raw: mined_from=copper-ore/)
  assert.equal(world.rows('context.residual_machine_stock_credited').length, 1, 'only the fresh restage credited machine stock')
  assert.equal(world.rows('context.executor_facts_carried').at(-1).data.residual_machine_stock_credited, 0)
})

test('unit 15: machine output that covers only part of the shortfall is credited and the rest is still demanded', async () => {
  const world = await runIWorld({ held: 5, output: 3 })
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const residual = stepLine(world, 'residual_needs')
  assert.match(residual, /copper-plate required=10 held=5 in_machine_output=3@stone-furnace unit=26 missing_after_machine=2 crafts=2 via copper-plate/)
  assert.match(residual, /copper-ore required=2 held=0 missing=2/)
  assert.match(stepLine(world, 'raw_leaf_acquisition'), /^raw_leaf_acquisition: copper-ore missing=2 raw: mined_from=copper-ore/)
  const [credited] = world.rows('context.residual_machine_stock_credited')
  assert.deepEqual({ before: credited.data.items[0].missing_before_machine, after: credited.data.items[0].missing_after_machine }, { before: 5, after: 2 })
})

test('unit 15: a furnace with an empty output changes nothing and traces no credit', async () => {
  const world = await runIWorld({ held: 9, output: 0 })
  await restageToFreshExecutor(world)
  assert.match(stepLine(world, 'residual_needs'), /copper-plate required=10 held=9 missing=1 crafts=1 via copper-plate/)
  assert.equal(world.rows('context.residual_machine_stock_credited').length, 0)
})
