import test from 'node:test'
import assert from 'node:assert/strict'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 1,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

class FakeRcon {
  constructor() {
    this.status = deployment()
    this.commands = []
    this.mutations = []
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18 } })
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return 'tool-output'
  }
}

function planMessage() {
  return {
    content: JSON.stringify({
      chatMessage: 'Proceeding.',
      plan: ['Wait'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
  }
}

test('malformed tool arguments are rejected before RCON and may be repaired', async () => {
  const rcon = new FakeRcon()
  const seen = []
  let call = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async messages => {
      seen.push(messages)
      call++
      if (call === 1) {
        return {
          content: null,
          tool_calls: [{
            id: 'bad-json',
            type: 'function',
            function: { name: 'getActorStatus', arguments: '{not-json' },
          }],
        }
      }
      if (call === 2) {
        return {
          content: null,
          tool_calls: [{
            id: 'good-json',
            type: 'function',
            function: { name: 'getActorStatus', arguments: '{}' },
          }],
        }
      }
      return planMessage()
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('inspect then act', { sender: 'TTLouis' })
  assert.equal(result.operations[0].name, 'wait')
  assert.ok(seen[1].some(message => String(message.content).includes('Tool-validation failure (1/3')))
  const actorReads = rcon.commands.filter(command => command.includes('remote.call("autorio_actor","status")'))
  assert.equal(actorReads.length, 1)
})

test('mutation operations called as tools are steered into the strict operations plan', async () => {
  const rcon = new FakeRcon()
  const seen = []
  let call = 0
  const agent = new NpcAgentLoop({
    rcon,
    provider: async messages => {
      seen.push(messages)
      call++
      if (call === 1) {
        return {
          content: null,
          tool_calls: [{
            id: 'wrong-surface',
            type: 'function',
            function: {
              name: 'move_items_exact',
              arguments: JSON.stringify({ item_name: 'iron-ore', unit_number: 582, max_count: 20, to_entity: true }),
            },
          }],
        }
      }
      return {
        content: JSON.stringify({
          chatMessage: 'Loading the observed furnace.',
          plan: ['Load furnace'],
          currentStep: 0,
          operations: [{ name: 'move_items_exact', args: { item_name: 'iron-ore', unit_number: 582, max_count: 20, to_entity: true } }],
        }),
      }
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('load the furnace', { sender: 'TTLouis' })
  assert.equal(call, 2)
  assert.equal(result.operations[0].name, 'move_items_exact')
  assert.equal(rcon.mutations.length, 1)
  const repair = seen[1].map(message => String(message.content ?? '')).join('\n')
  assert.match(repair, /approved world-mutation operation/i)
  assert.match(repair, /strict-JSON operations array/i)
})

test('unapproved tools exhaust bounded tool-validation repair without disabling tools or mutating', async () => {
  const rcon = new FakeRcon()
  const contexts = []
  let call = 0
  const agent = new NpcAgentLoop({
    rcon,
    maxToolValidationRetries: 3,
    provider: async (_messages, context) => {
      contexts.push(context)
      call++
      return {
        content: null,
        tool_calls: [{
          id: `bad-${call}`,
          type: 'function',
          function: { name: 'notApproved', arguments: '{}' },
        }],
      }
    },
    systemPrompt: 'NPC test prompt',
  })

  const result = await agent.request('do something unsupported', { sender: 'TTLouis' })
  assert.equal(result.operations.length, 0)
  assert.equal(result.blocked, true)
  assert.equal(result.blocker.class, 'tool_validation')
  assert.equal(contexts.length, 4)
  assert.equal(contexts.every(context => context.allowTools === true), true)
  assert.equal(rcon.mutations.length, 0)
})
