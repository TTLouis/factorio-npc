import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'

function deployment() {
  return {
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
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
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
          operation: 'gather_resource',
          field: 'resource_name',
          identity: 'tree-02-red',
          expected_type: 'resource',
          observed_type: 'tree',
        })
      }
      return JSON.stringify({ ok: true })
    }
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
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

  const state = memory.currentPlan('npc:airi')
  assert.equal(state.status, 'blocked')
  assert.equal(state.admission_status, 'admission_failed')
  assert.equal(state.task_board.status, 'blocked')
  assert.equal(state.task_board.active_index, 0)
  assert.equal(memory.byNpc.get('npc:airi').recent.length, 1)
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
  assert.equal(memory.currentPlan('npc:airi').status, 'blocked')
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

  const state = memory.currentPlan('npc:airi')
  assert.ok(state)
  assert.equal(state.status, 'blocked')
  assert.equal(state.admission_status, 'admission_failed')
  assert.equal(state.plan[0], 'Perform deterministic step')
  assert.equal(state.current_step, 0)
  assert.equal(state.task_board.status, 'blocked')
  assert.equal(state.task_board.completed_count, 0)
  assert.equal(state.task_board.steps[0].status, 'blocked')
  assert.equal(memory.byNpc.get('npc:airi').recent.length, 1)
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
  assert.equal(memory.currentPlan('npc:airi').admission_status, 'admitted')
  assert.equal(memory.currentPlan('npc:airi').task_board.completed_count, 0)
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
  assert.equal(memory.currentPlan('npc:airi').admission_status, 'admitted')
})
