import assert from 'node:assert/strict'
import test from 'node:test'

import { NpcAgentLoop } from './npc-agent-loop.mjs'

const status = {
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

function rcon() {
  return {
    async command(text) {
      if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(status)
      return 'ok'
    },
  }
}

test('provider failure clears active request state', async () => {
  const agent = new NpcAgentLoop({
    rcon: rcon(),
    systemPrompt: 'NPC test prompt',
    provider: async () => { throw new Error('provider failed') },
  })

  await assert.rejects(() => agent.request('test'), /provider failed/)
  assert.equal(agent.active, false)
})

test('cancel aborts the in-flight provider request', async () => {
  let started
  const providerStarted = new Promise(resolve => { started = resolve })
  let providerSignal
  const agent = new NpcAgentLoop({
    rcon: rcon(),
    systemPrompt: 'NPC test prompt',
    provider: async (_messages, { signal }) => {
      providerSignal = signal
      started()
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true })
      })
    },
  })

  const pending = agent.request('test')
  await providerStarted
  agent.cancel()
  await assert.rejects(() => pending, /provider aborted/)
  assert.equal(providerSignal.aborted, true)
  assert.equal(agent.active, false)
})
