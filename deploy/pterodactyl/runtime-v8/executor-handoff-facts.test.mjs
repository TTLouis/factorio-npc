import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
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
}

// The live engine prints the inventory as a serpent block, recipe details as JSON.
const serpent = inventory => `{\n${Object.entries(inventory).filter(([, count]) => count > 0).map(([name, count]) => `  {\n    count = ${count},\n    name = "${name}"\n  }`).join(',\n')}\n}`

function liveGame({ inventory = {} } = {}) {
  const game = new FakeFactorio({ inventory })
  game.conditionReads = []
  game.failConditionReads = false
  game.onConditionRead = undefined
  const base = game.command.bind(game)
  game.command = async (text) => {
    if (text.includes('"get_inventory_items"')) return serpent(game.inventory)
    if (text.includes('"recipe_details"')) {
      const name = /"recipe_details",['"]([a-z0-9-]+)['"]/.exec(text)?.[1]
      return JSON.stringify(RECIPES[name] ? { found: true, query: name, truncated: false, recipes: [RECIPES[name]] } : { found: false, query: name })
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

function harness({ game, script }) {
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: [], trace: [] }
  const provider = async (messages, context) => {
    world.calls.push({ messages: messages.map(message => ({ ...message })), context })
    const reply = script[world.calls.length - 1]
    assert.ok(reply, `unscripted provider call ${world.calls.length}`)
    return typeof reply === 'function' ? reply(messages, context, world) : { ...reply }
  }
  const jev = recordingJev(async (_state, questions) => {
    if (questions.intent) return { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } }
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
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'executor handoff facts test system prompt',
    goalDefinitionPolicy: 'required',
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
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
async function plannerCollectedTenCopper({ inventory } = {}) {
  const world = harness({
    game: liveGame({ inventory }),
    script: [readsRound(), plannerCommit(), executorGather(5)],
  })
  await world.say()
  assert.equal(world.calls.length, 2, 'planner reads, then commits')
  assert.equal(getActivePlan(world.memory.planningState(KEY)).status, 'COMMITTED')
  world.give('copper-plate', 10) // the batch gathered ten plates
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
  assert.match(lab, /^recipe_fact lab \(stable recipe data, source=getRecipeDetails, as_of=epoch:3\): categories=crafting \| energy=0\.5 \| ingredients=10 electronic-circuit \+ 10 iron-gear-wheel \+ 4 transport-belt \| products=1 lab \| machines=assembling-machine-1,assembling-machine-2$/)
  assert.match(step, /^recipe_fact electronic-circuit .*ingredients=1 iron-plate \+ 3 copper-cable \| products=1 electronic-circuit/m)
  assert.match(step, /^recipe_fact copper-cable .*ingredients=1 copper-plate \| products=2 copper-cable/m)
  // Counts re-read now, not the planner's older ones.
  assert.match(step, /^held_counts \(fresh live read of the actor inventory, as_of=epoch:3\): .*copper-plate=10/m)
  assert.doesNotMatch(step, /held_counts_STALE/)
  // Residual needs: ten circuits need 30 cable = 15 crafts (the recipe yields 2) = 15 plates; ten are held, so five more are missing.
  const residual = step.split('\n').find(line => line.startsWith('residual_needs'))
  assert.match(residual, /for the step contract electronic-circuit>=10/)
  assert.match(residual, /electronic-circuit required=10 held=0 missing=10 crafts=10 via electronic-circuit/)
  assert.match(residual, /copper-cable required=30 held=0 missing=30 crafts=15 via copper-cable/)
  assert.match(residual, /copper-plate required=15 held=10 missing=5/)
  // Authority: the committed step, its contract and the latest receipt are in the packet; history is labelled.
  assert.match(step, /^authority: active_step=\S+ \(committed plan\) contract=all \(committed\) latest_receipt=.*entity_ids_in_receipts_and_snapshots=historical_observations current_exact_targets=only_from_a_fresh_observation$/m)
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
  assert.match(textOf(stepBlock(executorRequests[0].messages)), /^recipe_fact lab /m, 'the facts were in front of the executor when it returned nothing')
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
  const result = await restageToFreshExecutor(world)
  assert.equal(result.restaged, true, JSON.stringify(result))
  const step = textOf(stepBlock(world.agent.messages))
  const machine = step.split('\n').find(line => line.startsWith('checkpoint_machine'))
  assert.match(machine, /^checkpoint_machine \(fresh live read, as_of=epoch:3\): \{"unit_number":55,"name":"stone-furnace"/)
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
  assert.match(staleLine, /^checkpoint_machine_STALE \(earlier observation as_of=epoch:3, NOT current; fresh_read_failed\)/)
})

test('D2: a planner restage carries none of the executor facts', async () => {
  const world = await plannerCollectedTenCopper()
  const planner = world.agent.buildRestagePacket({ checkpoint: 'C1', role: 'planner', reason: 'x' })
  assert.doesNotMatch(planner.text, /recipe_fact|held_counts|residual_needs|authority:/)
  assert.equal(planner.executor_facts, undefined)
})
