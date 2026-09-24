import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decisionEnvelopeQuestions,
  observationRelevanceFamilies,
  observationRelevanceQuestions,
  parseObservationRelevance,
} from './jev-decision-taxonomy.mjs'
import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import {
  observationToolFamilies,
  observationToolFamily,
  observationToolFamilyCatalog,
  toolDefinitions,
} from './structured-policy.mjs'

test('M7 observation relevance uses parallel Noul questions instead of an integer budget question', () => {
  const families = observationRelevanceFamilies()
  const questions = observationRelevanceQuestions()
  assert.equal(families.length, 11)
  assert.deepEqual(Object.keys(questions), families.map(family => `need_${family}`))
  for (const [id, question] of Object.entries(questions)) {
    assert.equal(question.type, 'noul', id)
    assert.deepEqual(Object.keys(question.criteria), ['true', 'false'])
    assert.match(JSON.stringify(question.instructions), /do not invent/i)
  }

  const envelope = decisionEnvelopeQuestions()
  assert.equal(Object.hasOwn(envelope, 'observation_budget'), false)
  for (const family of families) assert.equal(envelope[`need_${family}`].type, 'noul')
})

test('M7 typed relevance is thresholded and capped in deterministic code', () => {
  const response = {
    answers: {
      need_inventory_equipment: { type: 'noul', noul: 0.94 },
      need_nearby_world: { type: 'noul', noul: 0.82 },
      need_recipe_production: { type: 'noul', noul: 0.71 },
      need_research_state: { type: 'noul', noul: 0.66 },
      need_entity_status: { type: 'noul', noul: 0.61 },
      need_runtime_status: { type: 'noul', noul: 0.2 },
    },
  }
  const parsed = parseObservationRelevance(response)
  assert.equal(parsed.source, 'typed_relevance')
  assert.equal(parsed.threshold, 0.5)
  assert.equal(parsed.signal_count, 6)
  assert.deepEqual(parsed.selected_families, [
    'inventory_equipment',
    'nearby_world',
    'recipe_production',
    'research_state',
  ])
  assert.equal(parsed.budget, 4)
  assert.equal(parsed.probabilities.entity_status, 0.61)
  assert.equal(parsed.probabilities.runtime_status, 0.2)
})

test('legacy integer observation budget is parse-only compatibility and is not emitted as a question', () => {
  const parsed = parseObservationRelevance({
    answers: {
      observation_budget: { type: 'score', score: 3.6 },
    },
  })
  assert.equal(parsed.source, 'legacy_score_compat')
  assert.equal(parsed.budget, 4)
  assert.deepEqual(parsed.selected_families, [])
  assert.equal(Object.hasOwn(decisionEnvelopeQuestions(), 'observation_budget'), false)
})

test('every deterministic observation tool belongs to exactly one typed relevance family', () => {
  const families = observationToolFamilies()
  assert.deepEqual(families, observationRelevanceFamilies())
  const catalog = observationToolFamilyCatalog()
  const names = toolDefinitions.map(tool => tool.function.name)

  assert.deepEqual(Object.keys(catalog).sort(), [...names].sort())
  for (const name of names) {
    assert.ok(families.includes(observationToolFamily(name)), name)
  }

  assert.equal(observationToolFamily('getInventoryItems'), 'inventory_equipment')
  assert.equal(observationToolFamily('getNearbyEntities'), 'nearby_world')
  assert.equal(observationToolFamily('getEntityStatus'), 'entity_status')
  assert.equal(observationToolFamily('getResearchPath'), 'research_state')
  assert.equal(observationToolFamily('getPlacementCandidates'), 'placement_candidates')
  assert.equal(observationToolFamily('validateConstructionPlan'), 'construction_state')
})


class ObservationSelectionRcon {
  constructor() {
    this.commands = []
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) {
      return JSON.stringify({
        revision: 'airi-deploy-v8-npc-staging',
        session: '0123456789abcdef0123456789abcdef',
        mode: 'npc',
        actor_id: 18,
        actor_kind: 'standalone_character',
        connected_players: 0,
        allowed: true,
        idle: true,
        epoch: 3,
        actor_interface: true,
        operations: true,
        tools: true,
      })
    }
    if (text.includes('remote.call("autorio_tools","get_inventory_items"')) return JSON.stringify({ items: [{ name: 'iron-plate', count: 4 }] })
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify({ actor_position: { x: 0, y: 0 }, entities: [] })
    return '{}'
  }
}

test('M7 live admission executes selected fresh observation families and defers unselected families', async () => {
  const rcon = new ObservationSelectionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed observation admission test',
    provider: async () => { throw new Error('planner should not run') },
    traceFile: null,
    stateFile: null,
  })
  agent.active = true
  agent.epoch = {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
  agent.messages = [{ role: 'system', content: 'test' }]
  agent.observationBudgetOverride = 2
  agent.observationBudgetRemaining = 2
  agent.observationRelevanceOverride = ['inventory_equipment']

  await agent.handleToolBatch({
    tool_calls: [
      {
        id: 'inventory',
        type: 'function',
        function: { name: 'getInventoryItems', arguments: '{}' },
      },
      {
        id: 'nearby',
        type: 'function',
        function: { name: 'getNearbyEntities', arguments: '{"radius":20}' },
      },
    ],
  })

  assert.equal(rcon.commands.some(command => command.includes('get_inventory_items')), true)
  assert.equal(rcon.commands.some(command => command.includes('get_nearby_entities')), false)
  assert.equal(agent.observationBudgetRemaining, 1)
  assert.equal(agent.messages.filter(message => message.role === 'tool').length, 1)
})

test('M7 cached observations remain reusable even when their family is not currently selected', async () => {
  const rcon = new ObservationSelectionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed observation cache test',
    provider: async () => { throw new Error('planner should not run') },
    traceFile: null,
    stateFile: null,
  })
  agent.active = true
  agent.epoch = {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
  agent.messages = [{ role: 'system', content: 'test' }]
  agent.observationBudgetOverride = 2
  agent.observationBudgetRemaining = 2
  agent.observationRelevanceOverride = null

  const request = {
    tool_calls: [{
      id: 'nearby-first',
      type: 'function',
      function: { name: 'getNearbyEntities', arguments: '{"radius":20}' },
    }],
  }
  await agent.handleToolBatch(request)
  const afterFirst = rcon.commands.filter(command => command.includes('get_nearby_entities')).length

  agent.observationRelevanceOverride = ['inventory_equipment']
  await agent.handleToolBatch({
    tool_calls: [{
      id: 'nearby-again',
      type: 'function',
      function: { name: 'getNearbyEntities', arguments: '{"radius":20}' },
    }],
  })

  assert.equal(rcon.commands.filter(command => command.includes('get_nearby_entities')).length, afterFirst)
})

test('reads that can prove the active step bypass an exhausted Jev observation budget', async () => {
  // Jev budget and relevance as observed in the 2026-09-24 cloud trial.
  async function run(planStatus) {
    const rcon = new ObservationSelectionRcon()
    const memory = new NpcDialogueMemory()
    const agent = new NpcAgentLoop({
      rcon,
      memory,
      systemPrompt: 'completion proof admission test',
      provider: async () => { throw new Error('planner should not run') },
      traceFile: null,
      stateFile: null,
    })
    agent.active = true
    agent.epoch = await rcon.command('remote.call("airi_deployment","status")').then(JSON.parse)
    agent.lastMemoryKey = 'npc:airi'
    if (planStatus) {
      memory.planByNpc.set('npc:airi', {
        goal_id: 'goal_trial',
        status: planStatus,
        task_board: {
          active_index: 0,
          steps: [{ id: 'step_1', description: 'Hand-craft 1 stone furnace', status: 'active' }],
        },
      })
    }
    agent.messages = [{ role: 'system', content: 'test' }]
    agent.observationBudgetOverride = 0
    agent.observationBudgetRemaining = 0
    agent.observationRelevanceOverride = []

    await agent.handleToolBatch({
      tool_calls: [
        { id: 'crafting', type: 'function', function: { name: 'getCraftingStatus', arguments: '{}' } },
        { id: 'inventory', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } },
        { id: 'nearby', type: 'function', function: { name: 'getNearbyEntities', arguments: '{"radius":20}' } },
      ],
    })
    return {
      executed: agent.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
      nearbyRead: rcon.commands.some(command => command.includes('get_nearby_entities')),
      budget: agent.observationBudgetRemaining,
    }
  }

  assert.deepEqual(await run('active'), { executed: ['crafting', 'inventory'], nearbyRead: false, budget: 0 })
  assert.deepEqual(await run(undefined), { executed: [], nearbyRead: false, budget: 0 })
})
