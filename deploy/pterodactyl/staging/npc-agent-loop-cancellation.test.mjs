import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop } from './npc-agent-loop.mjs'

function status(overrides = {}) {
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
    ...overrides,
  }
}

class StatusRcon {
  constructor(value = status()) {
    this.status = value
    this.commands = []
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    throw new Error(`unexpected RCON command: ${text}`)
  }
}

test('cancellation during provider budget reservation never leaks a missing-epoch error or calls the provider', async () => {
  const rcon = new StatusRcon()
  let providerCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    systemPrompt: 'NPC test prompt',
    provider: async () => {
      providerCalls++
      throw new Error('provider must not be called after cancellation')
    },
    reserve: async () => agent.cancel(),
  })

  await assert.rejects(
    () => agent.request('do a task', { sender: 'TTLouis' }),
    error => {
      assert.match(error.message, /Model turn was cancelled or superseded/)
      assert.doesNotMatch(error.message, /No active NPC actor epoch/)
      return true
    },
  )
  assert.equal(providerCalls, 0)
  assert.equal(agent.active, false)
})

test('an unauthorized deployment fails before provider work begins', async () => {
  const rcon = new StatusRcon(status({ allowed: false }))
  let providerCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    systemPrompt: 'NPC test prompt',
    provider: async () => {
      providerCalls++
      return null
    },
  })

  await assert.rejects(() => agent.request('do a task'), /NPC deployment session is not authorized/)
  assert.equal(providerCalls, 0)
  assert.equal(agent.active, false)
})
