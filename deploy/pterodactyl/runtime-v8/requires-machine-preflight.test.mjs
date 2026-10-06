import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop, NpcDialogueMemory, REQUIRES_MACHINE_RETRY_BUDGET, requiresMachineFacts } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
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
}

function planMessage(operations, chatMessage = 'make plates') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: ['Produce iron plates', 'Report the result'],
      currentStep: 0,
      operations,
    }),
  }
}

// What the mod's craft_item preflight returns for a machine-only recipe (shape from bootstrap_planning.ts).
function requiresMachine(overrides = {}) {
  return {
    ok: false,
    code: 'requires_machine',
    operation: 'craft_item',
    field: 'item_name',
    identity: 'plate-x',
    recipe_name: 'plate-x',
    requested_count: 5,
    hand_craftable: false,
    recipe: {
      name: 'plate-x',
      categories: ['smelting'],
      energy: 3.2,
      ingredients: [{ type: 'item', name: 'ore-x', amount: 1, held: 7 }],
      products: [{ type: 'item', name: 'plate-x', amount: 1 }],
    },
    machines: {
      matched_count: 2,
      truncated: false,
      candidates: [
        { name: 'furnace-b', type: 'furnace', held_count: 2, place_items: [{ name: 'furnace-b', count: 1 }] },
        { name: 'furnace-a', type: 'furnace', held_count: 0, place_items: [{ name: 'furnace-a', count: 1 }] },
      ],
      held: [{ name: 'furnace-b', held_count: 2 }],
      placed_count: 1,
      placed_working_count: 0,
      placed_truncated: false,
      placed_search_radius: 128,
      placed: [{ unit_number: 41, name: 'furnace-a', position: { x: 3, y: 4 }, distance: 5, working: false, readiness: 'no_fuel', status_code: 3 }],
    },
    ...overrides,
  }
}

class Rcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.preflights = []
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const craft = text.includes('craft_item')
      this.preflights.push(craft ? 'craft_item' : 'other')
      return JSON.stringify(craft ? requiresMachine() : { ok: true, operation: 'place_entity' })
    }
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function harness(provider) {
  const rcon = new Rcon()
  const rows = []
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'requires_machine regression',
    provider,
  })
  agent.behaviorTrace = { emit: async record => { rows.push(record) } }
  return { rcon, agent, named: name => rows.filter(row => row.event === name).map(row => row.data ?? row) }
}

test('requires_machine is a recoverable fact result: the model gets the live facts, nothing runs, the plan is not frozen, and the trace names it', async () => {
  let calls = 0
  let factMessage
  const { rcon, agent, named } = harness(async (messages, context) => {
    calls++
    assert.equal(context.allowTools, true)
    if (calls === 1) return planMessage([{ name: 'craft_item', args: { item_name: 'plate-x', count: 5 } }])
    factMessage = messages.map(message => String(message.content ?? '')).filter(content => content.startsWith('[HARNESS]')).at(-1)
    return planMessage([{ name: 'place_entity', args: { entity_name: 'furnace-b' } }], 'place a machine')
  })

  const result = await agent.request('make five plate-x', { sender: 'tester' })
  const state = agent.memory.currentPlan('npc:sgluna')

  assert.equal(calls, 2)
  assert.equal(result.operations[0].name, 'place_entity')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /craft_item/)
  assert.match(factMessage, /\[HARNESS\] Deterministic craft preflight did not run operation 1 \(craft_item plate-x\)/)
  assert.match(factMessage, /\["smelting"\]/)
  assert.match(factMessage, /cannot hand-craft/)
  assert.match(factMessage, /not WORLD_BLOCKED/)
  assert.match(factMessage, /"energy":3\.2/)
  assert.match(factMessage, /"held":\[\{"name":"furnace-b","held_count":2\}\]/)
  assert.match(factMessage, /"unit_number":41/)
  assert.match(factMessage, /"readiness":"no_fuel"/)
  assert.match(factMessage, /"status_code":3/)
  assert.match(factMessage, /not by itself proof that it is fueled/)

  assert.notEqual(state.status, 'blocked')
  assert.equal(state.blocker ?? '', '')
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_preflight_blocker'), false)
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_preflight_recoverable' && /requires_machine/.test(item.summary)), true)

  const [row] = named('craft.requires_machine')
  assert.ok(row, 'craft.requires_machine traced')
  assert.ok(row.request_id)
  assert.equal(row.code, 'requires_machine')
  assert.equal(row.reason, 'recipe_made_in_machine_not_hand_craftable')
  assert.equal(row.attempt, 1)
  assert.equal(row.item_name, 'plate-x')
  assert.equal(row.plan_changed, false)
  assert.equal(row.facts.machines.placed[0].readiness, 'no_fuel')
  assert.equal(named('craft.requires_machine_exhausted').length, 0)
  assert.equal(named('operations.preflight_recoverable').some(event => event.failure_class === 'requires_machine'), true)
})

test('repeated requires_machine retries are bounded and pause the request without a blocker or a frozen plan', async () => {
  let calls = 0
  const { rcon, agent, named } = harness(async () => {
    calls++
    return planMessage([{ name: 'craft_item', args: { item_name: 'plate-x', count: 5 } }])
  })

  const result = await agent.request('make five plate-x', { sender: 'tester' })
  const state = agent.memory.currentPlan('npc:sgluna')

  assert.equal(REQUIRES_MACHINE_RETRY_BUDGET, 2)
  assert.equal(calls, REQUIRES_MACHINE_RETRY_BUDGET + 1)
  assert.equal(rcon.mutations.length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.recoverableFailure.reason, 'requires_machine_retry_exhausted')
  assert.equal(state.status, 'paused')
  assert.equal(state.blocker, '')
  assert.equal(state.task_board.evidence.some(item => item.kind === 'operation_preflight_blocker'), false)

  assert.equal(named('craft.requires_machine').length, REQUIRES_MACHINE_RETRY_BUDGET)
  const [exhausted] = named('craft.requires_machine_exhausted')
  assert.ok(exhausted, 'craft.requires_machine_exhausted traced')
  assert.ok(exhausted.request_id)
  assert.equal(exhausted.reason, 'retry_budget_spent_request_paused_without_blocker')
  assert.equal(exhausted.retries_used, REQUIRES_MACHINE_RETRY_BUDGET)
})

test('requiresMachineFacts keeps the facts bounded', () => {
  const many = count => Array.from({ length: count }, (_, i) => ({ name: `m-${i}`, unit_number: i, position: { x: i, y: 0 }, distance: i, working: false, readiness: 'no_fuel', status_code: 3, extra: 'dropped' }))
  const facts = requiresMachineFacts(requiresMachine({
    recipe: { ...requiresMachine().recipe, ingredients: many(20), products: many(20), categories: Array.from({ length: 20 }, (_, i) => `c${i}`) },
    machines: { ...requiresMachine().machines, candidates: many(20), held: many(20), placed: many(20), placed_count: 20, placed_truncated: true },
  }))

  assert.equal(facts.recipe.ingredients.length, 8)
  assert.equal(facts.recipe.products.length, 8)
  assert.equal(facts.recipe.categories.length, 8)
  assert.equal(facts.machines.candidates.length, 8)
  assert.equal(facts.machines.held.length, 8)
  assert.equal(facts.machines.placed.length, 6)
  assert.equal(facts.machines.placed_count, 20)
  assert.equal(facts.machines.placed_truncated, true)
  assert.equal('extra' in facts.machines.placed[0], false)
  assert.ok(JSON.stringify(facts).length < 6000)
})
