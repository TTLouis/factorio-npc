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

function planMessage(operations, chatMessage = 'continue bootstrap') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: ['Bootstrap missing dependency', 'Craft requested downstream item'],
      currentStep: 0,
      operations,
    }),
  }
}

class BootstrapRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.preflightCalls = 0
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      this.preflightCalls++
      if (text.includes("'craft_item'") || text.includes('"craft_item"')) {
        return JSON.stringify({
          ok: false,
          code: 'bootstrap_dependency_unresolved',
          operation: 'craft_item',
          field: 'item_name',
          identity: 'gear-x',
          recipe_name: 'gear-x',
          requested_count: 3,
          craftable_now_count: 0,
          bootstrap: {
            requested_crafts: 3,
            craftable_now_count: 0,
            craftable_now: false,
            inventory_overlay: {
              outputs: [{ type: 'item', name: 'gear-x', required: 3, held: 0 }],
              ingredients: [{ type: 'item', name: 'plate-x', required: 6, held: 0, missing: 6, status: 'needs_acquisition/processing' }],
              machine_dependency: {
                required: 1,
                held: 4,
                status: 'already_satisfied',
                satisfaction_scope: 'inventory_acquisition',
                placed_instance_required: true,
                candidates: [{ name: 'furnace-x', held_count: 4, place_items: [{ name: 'furnace-x', count: 1 }] }],
              },
            },
            dependencies: [],
            first_unresolved: {
              type: 'item',
              name: 'plate-x',
              required: 6,
              held: 0,
              missing: 6,
              status: 'needs_acquisition/processing',
              resolution: {
                kind: 'processing',
                recipe_name: 'plate-x',
                categories: ['smelting'],
                crafts_needed: 6,
              },
              machine_dependency: {
                required: 1,
                held: 4,
                status: 'already_satisfied',
                satisfaction_scope: 'inventory_acquisition',
                placed_instance_required: true,
              },
            },
          },
        })
      }
      return JSON.stringify({ ok: true, operation: 'supply_entity' })
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

test('uncraftable downstream craft is replanned to first bootstrap dependency before mutation admission', async () => {
  const rcon = new BootstrapRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'bootstrap dependency regression',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([{ name: 'craft_item', args: { item_name: 'gear-x', count: 3 } }], 'First process plate-x, then craft gears')
      }

      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /Deterministic craft preflight rejected the requested craft before Autorio admission/)
      assert.match(text, /"name":"plate-x"/)
      assert.match(text, /"kind":"processing"/)
      assert.match(text, /"held":4/)
      assert.match(text, /already_satisfied/)
      assert.match(text, /satisfaction_scope":"inventory_acquisition"/)
      assert.match(text, /placed_instance_required":true/)
      assert.match(text, /Never invent a unit_number/)
      assert.match(text, /satisfaction_scope=placed_instance means a compatible machine is already placed/)
      assert.match(text, /not by itself proof that it is fueled, powered or supplied/)
      return planMessage([{
        name: 'place_entity',
        args: { entity_name: 'furnace-x' },
      }], 'Place the already-held processing machine before supplying it')
    },
  })

  const result = await agent.request('build the early production chain', { sender: 'tester' })

  assert.equal(calls, 2)
  assert.equal(result.operations[0].name, 'place_entity')
  assert.deepEqual(result.operations[0].args, { entity_name: 'furnace-x' })
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /craft_item/)
  assert.doesNotMatch(rcon.mutations[0], /supply_entity/)
  assert.match(rcon.mutations[0], /place_entity/)
})
