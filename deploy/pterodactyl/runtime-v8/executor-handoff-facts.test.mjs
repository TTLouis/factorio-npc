import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { parseGoalRequirements } from './goal-requirements.mjs'
import { executorFactsRefreshMessage } from './handoff-packet.mjs'
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
  game.failConditionReads = false
  game.onConditionRead = undefined
  const base = game.command.bind(game)
  game.command = async (text) => {
    if (text.includes('"autorio_discovery","find_entities"')) {
      const resource = /"find_entities",'([^']+)'/.exec(text)?.[1]
      game.sourceReads.push(resource)
      game.onSourceRead?.(game, resource)
      return JSON.stringify(game.sourceAnswer ?? sourceAnswer(resource))
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
      const mined = MINED_FROM[name]
      return JSON.stringify(table[name]
        ? { found: true, query: name, truncated: false, recipes: [table[name]], ...(mined ? { mined_from: mined } : {}),
            ...(game.burnerFuels && table[name].crafting_machines.some(machine => machine.energy_source === 'burner') ? { burner_fuels: game.burnerFuels } : {}) }
        : { found: false, query: name, code: 'no_recipe', error: 'no recipe produces this item/fluid and no recipe has this name', ...(mined ? { mined_from: mined } : {}) })
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
    assert.match(refreshed, /held_counts \(fresh live read of the actor inventory, as_of=tick:601,epoch:3\): .*copper-plate=10/m)
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
function sourceAnswer(resource = 'copper-ore') {
  return { found: true, name: resource, actor_position: { x: 0, y: 0 }, searched_radius: 193, max_radius: 1024,
    matched_count: 1, returned_count: 1, truncated: false,
    entities: [{ name: resource, type: 'resource', position: { x: 192.5, y: 8.5 }, distance: 192.688868386, amount: 2200, force: 'neutral' }] }
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
  assert.match(fuel, /solid-fuel fuel_value=12MJ held=0 no_resource_source \| wood fuel_value=2MJ held=0 no_resource_source/)
  assert.match(fuel, /non-resource sources such as trees are not derived/)
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
  const grant = world.rows('observation.targeted_granted')[0]
  assert.equal(grant.data.request_id, requestId)
  assert.equal(grant.data.tool, 'findLongRangeEntities')
  assert.equal(world.rows('observation.targeted_resource_search')[0].data.resource, 'coal')
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
  const refreshed = await world.agent.gatherExecutorHandoffFacts({ state, actor: world.agent.epoch, mode: 'refresh' })
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
  world.game.onSourceRead = game => { game.status = deployment({ epoch: 4 }) }
  const carried = world.rows('context.machine_energy_carried').length
  assert.deepEqual(await restageToFreshExecutor(world), { restaged: false, reason: 'actor_changed_during_handoff_refresh' })
  assert.equal(world.rows('context.machine_energy_carried').length, carried)
})
