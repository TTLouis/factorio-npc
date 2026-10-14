import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'

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

function planMessage(operations, chatMessage = 'Working.') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: ['Perform deterministic step'],
      currentStep: 0,
      operations,
    }),
  }
}

class RuntimeRcon {
  constructor({ batchFailure } = {}) {
    this.commands = []
    this.mutations = []
    this.batchFailure = batchFailure
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_inventory_items")')) {
      return JSON.stringify({ items: [{ name: 'iron-ore', count: 5 }, { name: 'coal', count: 5 }] })
    }
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      return JSON.stringify({
        actor_position: { x: 0, y: 0 },
        entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 582, position: { x: 2, y: 0 } }],
      })
    }
    if (text.includes('remote.call("autorio_navigation","status")')) {
      return JSON.stringify({ state: 'idle', target: null, last_result: 'arrived' })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      if (text.includes("'craft_item'") && text.includes("'iron-mining-drill'")) {
        return JSON.stringify({
          ok: false,
          code: 'unknown_recipe',
          refusal_class: 'argument',
          operation: 'craft_item',
          field: 'item_name',
          identity: 'iron-mining-drill',
          expected: 'force recipe',
        })
      }
      if (text.includes("'gather_resource'") && text.includes("'tree-02-red'")) {
        return JSON.stringify({
          ok: false,
          code: 'invalid_target_kind',
          refusal_class: 'argument',
          operation: 'gather_resource',
          field: 'resource_name',
          identity: 'tree-02-red',
          expected_type: 'resource',
          observed_type: 'tree',
        })
      }
      return JSON.stringify({ ok: true })
    }
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      if (this.batchFailure) {
        return `${marker}${JSON.stringify({ ok: false, result: this.batchFailure })}`
      }
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

test('tools-disabled recovery cannot turn an unresolved identity into a craft mutation', async () => {
  const rcon = new RuntimeRcon()
  const memory = new NpcDialogueMemory()
  const contexts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (_messages, context) => {
      contexts.push(context)
      calls++
      if (context.allowTools === false) {
        return planMessage([{ name: 'craft_item', args: { item_name: 'iron-mining-drill', count: 1 } }], 'Trying a remembered identity.')
      }
      return {
        content: JSON.stringify({
          chatMessage: 'bad',
          plan: ['Need a recipe'],
          currentStep: 0,
          operations: [{ name: 'craft_item', args: { item_name: 'iron-mining-drill', count: 0 } }],
        }),
      }
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('establish early resources', { sender: 'tester' })
  // malformed draft, tools-disabled recovery (unknown_recipe), one bounded
  // tools-enabled naming-correction turn that repeats the malformed draft, and
  // its recovery repeating the same unknown recipe, which then freezes.
  assert.equal(calls, 4)
  assert.equal(contexts[1].allowTools, false)
  assert.equal(result.blocker.code, 'unknown_recipe')
  assert.equal(rcon.mutations.length, 0)

  // The terminal blocked end also pauses the run (guard class, blocked_<code>), so the stop is visible and no timer resumes it.
  const state = memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause_reason, 'blocked_unknown_recipe')
  assert.equal(state.pause_class, 'guard')
  assert.equal(state.admission_status, 'admission_failed')
  assert.equal(state.task_board.status, 'paused')
  assert.equal(state.task_board.active_index, 0)
  assert.equal(memory.byNpc.get('npc:sgluna').recent.length, 1)
})

test('gather_resource tree identity is rejected deterministically before mutation', async () => {
  const rcon = new RuntimeRcon()
  const memory = new NpcDialogueMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => planMessage([
      { name: 'gather_resource', args: { resource_name: 'tree-02-red', count: 4, search_radius: 64 } },
    ]),
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('gather nearby resources', { sender: 'tester' })
  assert.equal(result.blocker.code, 'invalid_target_kind')
  assert.equal(result.blocker.expected_type, 'resource')
  assert.equal(result.blocker.observed_type, 'tree')
  assert.equal(rcon.mutations.length, 0)
  const state = memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause_reason, 'blocked_invalid_target_kind')
  assert.equal(state.pause_class, 'guard')
})

for (const { label, operation, code } of [
  { label: 'a reach inside a furnace collision box', code: 'navigation_position_inside_furnace_collision',
    operation: { name: 'walk_to_position', args: { x: 2, y: 0, reach_distance: 0.75 } } },
  // The candidate set expired or the spot stopped being placeable: re-fetching candidates is the correction.
  { label: 'an expired placement candidate', code: 'placement_candidate_unavailable',
    operation: { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } } },
  { label: 'a product no natural source yields', code: 'no_natural_harvest_source',
    operation: { name: 'harvest_product', args: { product_name: 'stone-furnace', count: 1, search_radius: 64 } } },
]) test(`${label} is an argument error: one bounded correction turn, then admission`, async () => {
  const rcon = new RuntimeRcon()
  const command = rcon.command.bind(rcon)
  rcon.command = async text => /autorio_preflight['"],['"]operation/.test(text) && text.includes(`'${operation.name}'`)
    ? JSON.stringify({ ok: false, code, refusal_class: 'argument', operation: operation.name })
    : command(text)
  const memory = new NpcDialogueMemory()
  const replies = [
    planMessage([operation]),
    planMessage([{ name: 'wait', args: { ticks: 60 } }]),
  ]
  const harness = []
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async messages => {
      harness.push(...messages.filter(message => message.role === 'user' && message.content.startsWith('[HARNESS]')).map(message => message.content))
      return replies.shift() ?? planMessage([{ name: 'wait', args: { ticks: 60 } }])
    },
    systemPrompt: 'NPC test prompt',
  })
  const traced = []
  const trace = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => {
    traced.push({ event, data, request_id: agent.traceRequest?.id })
    return trace(event, data)
  }

  await agent.request('do the next thing', { sender: 'tester' })
  assert.ok(harness.some(content => content.includes(`rejected operation 1 (${operation.name})`) && content.includes(`code ${code}`)))
  const recoverable = traced.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].data.failure_class, `model_correctable_${code}`)
  assert.equal(recoverable[0].data.refusal_class, 'argument', 'the trace row names the class the producer declared')
  assert.equal(recoverable[0].data.retry, 1)
  assert.ok(recoverable[0].request_id, 'the recoverable trace row carries request_id')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], new RegExp(operation.name))
  assert.notEqual(memory.currentPlan('npc:sgluna').status, 'blocked')
})

test('first batch admission failure preserves canonical plan, conversation, and Factorio error without replay', async () => {
  const underlying = 'autorio operation 1 failed: deterministic Factorio failure'
  const rcon = new RuntimeRcon({ batchFailure: underlying })
  const memory = new NpcDialogueMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => planMessage([{ name: 'wait', args: { ticks: 60 } }], 'Starting the first step.'),
    systemPrompt: 'NPC test prompt',
  })

  await assert.rejects(
    () => agent.request('keep a durable first-turn plan', { sender: 'tester' }),
    /not replayed because earlier operations may have produced side effects.*deterministic Factorio failure/i,
  )
  assert.equal(rcon.mutations.length, 1)

  const state = memory.currentPlan('npc:sgluna')
  assert.ok(state)
  assert.equal(state.status, 'blocked')
  assert.equal(state.admission_status, 'admission_failed')
  assert.equal(state.plan[0], 'Perform deterministic step')
  assert.equal(state.current_step, 0)
  assert.equal(state.task_board.status, 'blocked')
  assert.equal(state.task_board.completed_count, 0)
  assert.equal(state.task_board.steps[0].status, 'blocked')
  assert.equal(memory.byNpc.get('npc:sgluna').recent.length, 1)
  const evidence = state.task_board.evidence.find(item => item.kind === 'operation_admission_failure')
  assert.ok(evidence)
  assert.match(evidence.summary, /deterministic Factorio failure/)
  assert.match(evidence.summary, /"no_replay":true/)
})

test('normal successful operation admission remains waiting with an active durable plan', async () => {
  const rcon = new RuntimeRcon()
  const memory = new NpcDialogueMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => planMessage([{ name: 'wait', args: { ticks: 60 } }]),
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('wait once', { sender: 'tester' })
  assert.equal(rcon.mutations.length, 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(memory.currentPlan('npc:sgluna').admission_status, 'admitted')
  assert.equal(memory.currentPlan('npc:sgluna').task_board.completed_count, 0)
})


test('repeated cached and irrelevant observations recover into an executable plan from existing evidence', async () => {
  const rcon = new RuntimeRcon()
  const memory = new NpcDialogueMemory()
  const calls = []

  const toolCall = (id, name, args = {}) => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  })

  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (messages, context) => {
      calls.push({ messages, context })
      const call = calls.length

      if (call === 1) {
        return {
          content: null,
          tool_calls: [toolCall('inventory-1', 'getInventoryItems')],
        }
      }

      if (call === 2) {
        return {
          content: null,
          tool_calls: [
            toolCall('inventory-2', 'getInventoryItems'),
            toolCall('nearby-1', 'getNearbyEntities', { radius: 16, type: 'furnace', limit: 8 }),
          ],
        }
      }

      if (call === 3) {
        const steering = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(steering, /do not switch to a different read-only observation merely to avoid the duplicate guard/)
        assert.match(steering, /stone-furnace/)
        assert.match(steering, /unit_number/)
        return {
          content: null,
          tool_calls: [
            toolCall('inventory-3', 'getInventoryItems'),
            toolCall('navigation-1', 'getNavigationStatus'),
          ],
        }
      }

      assert.equal(context.allowTools, false)
      const recovery = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(recovery, /Observation retries are exhausted/)
      assert.match(recovery, /Reuse the deterministic observations already collected/)
      assert.match(recovery, /stone-furnace/)
      assert.match(recovery, /iron-ore/)
      return planMessage([
        { name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: 582, max_count: 5, to_entity: true } },
      ], 'Loading five iron ore into the nearby furnace.')
    },
    systemPrompt: 'NPC observation-loop recovery test prompt',
  })

  const result = await agent.request('produce 5 iron plates using the existing nearby infrastructure', { sender: 'tester' })

  assert.equal(calls.length, 4)
  assert.equal(calls[0].context.allowTools, true)
  assert.equal(calls[1].context.allowTools, true)
  assert.equal(calls[2].context.allowTools, true)
  assert.equal(calls[3].context.allowTools, false)
  assert.equal(result.operations.length, 1)
  assert.equal(result.operations[0].name, 'move_items_exact')
  assert.deepEqual(result.operations[0].args, { item_name: 'iron-ore', unit_number: 582, max_count: 5, to_entity: true })
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /move_items_exact/)
  assert.equal(memory.currentPlan('npc:sgluna').admission_status, 'admitted')
})

// --- the recovery path follows the producer's declared refusal_class, never a list of codes ------------------------------------

const GATHER = { name: 'gather_resource', args: { resource_name: 'iron-ore', count: 4, search_radius: 64 } }

async function runWithMockRefusal(refusal, operation = GATHER) {
  const rcon = new RuntimeRcon()
  const command = rcon.command.bind(rcon)
  rcon.command = async text => /autorio_preflight['"],['"]operation/.test(text) && text.includes(`'${operation.name}'`)
    ? JSON.stringify({ ok: false, operation: operation.name, ...refusal })
    : command(text)
  const memory = new NpcDialogueMemory()
  const replies = [
    planMessage([operation]),
    planMessage([{ name: 'wait', args: { ticks: 60 } }]),
  ]
  const harness = []
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async messages => {
      harness.push(...messages.filter(message => message.role === 'user' && message.content.startsWith('[HARNESS]')).map(message => message.content))
      return replies.shift() ?? planMessage([{ name: 'wait', args: { ticks: 60 } }])
    },
    systemPrompt: 'NPC test prompt',
  })
  const traced = []
  const trace = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => {
    traced.push({ event, data, request_id: agent.traceRequest?.id })
    return trace(event, data)
  }
  const result = await agent.request('gather some ore', { sender: 'tester' })
  return { rcon, memory, harness, traced, result }
}

test('a code nobody listed anywhere gets the correction turn because its producer declared it an argument error', async () => {
  const { harness, traced, rcon } = await runWithMockRefusal({ code: 'brand_new_mod_code', refusal_class: 'argument' })
  assert.ok(harness.some(content => content.includes('code brand_new_mod_code') && content.includes('naming/argument error')))
  const recoverable = traced.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].data.failure_class, 'model_correctable_brand_new_mod_code')
  assert.equal(recoverable[0].data.refusal_class, 'argument')
  assert.equal(traced.filter(row => row.event === 'operations.preflight_unclassified').length, 0)
  assert.equal(rcon.mutations.length, 1)
})

test('a world-class refusal gets the world-correction message, not the argument one, even when its code is one the model could once correct', async () => {
  const { harness, traced, result } = await runWithMockRefusal({ code: 'invalid_resource_count', refusal_class: 'world' })
  assert.equal(harness.filter(content => content.includes('naming/argument error')).length, 0)
  assert.equal(harness.filter(content => content.includes('was refused before admission: invalid_resource_count')).length, 1)
  const recoverable = traced.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].data.failure_class, 'world_correction_invalid_resource_count')
  assert.equal(recoverable[0].data.refusal_class, 'world')
  assert.equal(traced.filter(row => row.event === 'operations.preflight_unclassified').length, 0)
  assert.equal(traced.filter(row => row.event === 'operations.preflight_rejected').length, 0, 'the correction turn did not end the request')
  assert.equal(result.operations[0].name, 'wait', 'the corrected batch was admitted')
})

test('an authority-class refusal gets the authorization message and one retry', async () => {
  const { harness, traced, rcon } = await runWithMockRefusal({ code: 'brand_new_protection_code', refusal_class: 'authority' })
  assert.ok(harness.some(content => content.includes('code brand_new_protection_code') && content.includes('belongs to a player')))
  const recoverable = traced.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].data.failure_class, 'authorization_brand_new_protection_code')
  assert.equal(recoverable[0].data.refusal_class, 'authority')
  assert.equal(rcon.mutations.length, 1)
})

for (const [label, refusal] of [
  ['no refusal_class at all', { code: 'unknown_prototype' }],
  ['an unknown refusal_class', { code: 'unknown_prototype', refusal_class: 'someday' }],
]) test(`${label} fails closed to the world path and is traced as unclassified with request_id, code and reason`, async () => {
  const { harness, traced, result } = await runWithMockRefusal(refusal)
  assert.equal(harness.filter(content => content.includes('naming/argument error')).length, 0, 'no correction turn is guessed')
  assert.equal(traced.filter(row => row.event === 'operations.preflight_recoverable').length, 0)
  const unclassified = traced.filter(row => row.event === 'operations.preflight_unclassified')
  assert.equal(unclassified.length, 1)
  assert.ok(unclassified[0].data.request_id, 'request_id is on the row')
  assert.equal(unclassified[0].data.request_id, unclassified[0].request_id)
  assert.equal(unclassified[0].data.code, 'unknown_prototype')
  assert.match(unclassified[0].data.reason, /no_valid_class/)
  const rejected = traced.filter(row => row.event === 'operations.preflight_rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].data.refusal_class, 'unclassified')
  assert.ok(traced.findIndex(row => row.event === 'operations.preflight_unclassified') < traced.findIndex(row => row.event === 'operations.preflight_rejected'))
  assert.equal(result.blocker.code, 'unknown_prototype')
  assert.equal(traced.find(row => row.event === 'request.completed').data.outcome, 'blocked_preflight')
})

// A wrong technology name is a naming error like an unknown recipe (integrator decision): it reaches the argument path, never the
// research-prerequisite path, even though the operation is research_technology.
for (const code of ['unknown_technology', 'invalid_name']) test(`${code} on research_technology gets one bounded argument correction turn`, async () => {
  const { harness, traced, rcon, memory } = await runWithMockRefusal(
    { code, refusal_class: 'argument', technology: 'automatoin' },
    { name: 'research_technology', args: { technology_name: 'automatoin' } },
  )
  const recoverable = traced.filter(row => row.event === 'operations.preflight_recoverable')
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].data.failure_class, `model_correctable_${code}`)
  assert.equal(recoverable[0].data.refusal_class, 'argument')
  assert.equal(recoverable[0].data.retry, 1)
  assert.ok(recoverable[0].request_id, 'the recoverable row carries request_id')
  assert.equal(recoverable[0].data.preflight.code, code)
  assert.equal(recoverable[0].data.preflight.operation_index, 0)
  assert.ok(harness.some(content => content.includes(`code ${code}`) && content.includes('naming/argument error')))
  assert.equal(harness.filter(content => content.includes('research')  && content.includes('prerequisite')).length, 0, 'not the research prerequisite message')
  assert.equal(traced.filter(row => String(row.data?.failure_class ?? '').startsWith('research_')).length, 0)
  assert.equal(traced.filter(row => row.event === 'operations.preflight_unclassified').length, 0)
  assert.equal(traced.filter(row => row.event === 'operations.preflight_rejected').length, 0)
  assert.equal(rcon.mutations.length, 1)
  assert.notEqual(memory.currentPlan('npc:sgluna').status, 'blocked')
})
