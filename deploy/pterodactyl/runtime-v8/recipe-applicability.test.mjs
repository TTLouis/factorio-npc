import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { recipeFactsFromDetails, recipeFactLine, deriveResidualNeeds } from './handoff-packet.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { deployment, FakeFactorio } from './task-loop-fixtures.mjs'

const applicable = { state: 'available', reason: 'surface_conditions_satisfied', surface_bound: true, surface_index: 1 }
const unavailable = { ...applicable, state: 'unavailable', reason: 'surface_condition_mismatch' }
const recipe = (name, applicability, enabled = true) => ({ name, enabled, applicability, categories: ['crafting'],
  energy: 0.5, ingredients: [{ name: 'iron-plate', type: 'item', amount: 2 }],
  products: [{ name: 'widget', type: 'item', amount: 1 }], crafting_machines: [{ name: 'assembling-machine-1' }] })
const details = recipes => ({ found: true, query: 'widget', truncated: false, recipes })

function harness() {
  const game = new FakeFactorio()
  const loop = new NpcAgentLoop({ rcon: game, memory: new CanonicalTaskBoardMemory(),
    provider: async () => { throw new Error('no provider in deterministic recipe regression') },
    systemPrompt: 'fixture', npcId: 'sgluna', stateFile: null, traceFile: null, decisionTraceFile: null })
  loop.epoch = deployment()
  const rows = []
  loop.behaviorTrace = { emit: async row => { rows.push(row) } }
  loop.traceRequest = { id: 'request_recipe_surface' }
  const record = recipes => loop.recordHandoffToolFacts('getRecipeDetails', JSON.stringify(details(recipes)), { item_or_recipe: 'widget' })
  return { game, loop, rows, record }
}

test('native recipe filter rejects only proven unavailable routes and keeps locked/unknown dependencies explicit', () => {
  const facts = recipeFactsFromDetails(details([
    recipe('alien-widget', unavailable), recipe('widget', { state: 'available', reason: 'no_surface_conditions', surface_bound: false }, false),
    recipe('unknown-widget', undefined), recipe('malformed-proof', { state: 'unavailable' }),
  ]))
  assert.deepEqual(facts.map(fact => fact.name), ['widget', 'unknown-widget', 'malformed-proof'])
  assert.match(recipeFactLine(facts[0]), /locked \(planning dependency\)/)
  assert.match(recipeFactLine(facts[1]), /applicability=unknown/)
  const hidden = recipeFactsFromDetails(details([{ ...recipe('hidden-widget', undefined, false), hidden: true,
    hidden_from_player_crafting: true, hand_craftable_category: false }]))[0]
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.hidden_from_player_crafting, true)
  assert.equal(hidden.hand_craftable_category, false)
  const permissions = recipeFactsFromDetails(details([{ ...recipe('permissions', undefined), allow_as_intermediate: false, allow_intermediates: true }]))[0]
  assert.equal(permissions.allow_as_intermediate, false)
  assert.equal(permissions.allow_intermediates, true)
  assert.equal(hidden.allow_as_intermediate, undefined)
  assert.equal(deriveResidualNeeds({ roots: [{ item: 'widget', count: 2 }], recipes: [facts[0]], held: new Map([['widget', 0], ['iron-plate', 0]]) }).ok, true)
})

test('exact-query ingestion evicts previously eligible routes and traces correlated exclusion; mismatch cannot poison cache', async () => {
  const { loop, record, rows } = harness()
  record([recipe('widget', applicable)])
  assert.equal(loop.handoffRecipeFacts.has('widget'), true)
  loop.recordHandoffToolFacts('getRecipeDetails', JSON.stringify(details([recipe('widget', unavailable)])), { item_or_recipe: 'other' })
  assert.equal(loop.handoffRecipeFacts.has('widget'), true)
  record([recipe('widget', unavailable)])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loop.handoffRecipeFacts.has('widget'), false)
  assert.equal(loop.handoffRecipeQueries.has('widget'), true)
  const event = rows.find(row => row.event === 'context.recipe_applicability')
  assert.equal(event.data.request_id, 'request_recipe_surface')
  assert.equal(event.data.reason, 'native_surface_condition_mismatch')
  assert.deepEqual(event.data.excluded, ['widget'])
})

const state = { active_plan_id: 'p1', plans: [{ plan_id: 'p1', active_step_index: 0, steps: [{ completion_contract: {
  mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'widget', minimum: 1 }],
} }] }] }

test('handoff refreshes surface-bound eligibility after actor replacement and same-epoch surface changes', async () => {
  for (const changedActor of [false, true]) {
    const { loop, game, record, rows } = harness()
    record([recipe('widget', applicable)])
    if (changedActor) loop.epoch = game.status = deployment({ actor_id: 22, epoch: 4 })
    const base = game.command.bind(game)
    const reads = []
    game.command = async command => {
      if (command.includes('"recipe_details"')) {
        reads.push(command)
        return JSON.stringify(details([recipe('widget', { ...unavailable, surface_index: 2 })]))
      }
      return base(command)
    }
    const result = await loop.gatherExecutorHandoffFacts({ state, actor: loop.epoch, requestId: 'handoff_new_surface' })
    assert.ok(result, 'handoff facts gathered')
    assert.equal(reads.length, 1)
    assert.equal(result.facts?.recipes?.length ?? 0, 0)
    assert.equal(loop.handoffRecipeFacts.has('widget'), false)
    const expired = rows.find(row => row.data.reason === 'surface_evidence_requires_refresh')
    assert.equal(expired.data.request_id, 'handoff_new_surface')
    assert.deepEqual(expired.data.expired, ['widget'])
  }
})

test('a failed or deferred refresh cannot resurrect cached surface eligibility', async () => {
  for (const inFlight of [false, true]) {
    const { loop, game, record } = harness()
    record([recipe('widget', applicable)])
    const base = game.command.bind(game)
    game.command = async command => {
      if (command.includes('"recipe_details"')) throw new Error('read failed')
      return base(command)
    }
    loop.batchInFlight = inFlight
    const result = await loop.gatherExecutorHandoffFacts({ state, actor: loop.epoch })
    assert.ok(result)
    assert.equal(result.facts?.recipes?.length ?? 0, 0)
    assert.equal(loop.handoffRecipeFacts.has('widget'), false)
  }
})
