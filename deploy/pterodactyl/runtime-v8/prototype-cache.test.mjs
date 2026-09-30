import test from 'node:test'
import assert from 'node:assert/strict'

import { NpcAgentLoop } from '../staging/npc-agent-loop.mjs'

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

class FakeRcon {
  constructor() {
    this.prototypeReads = 0
    this.mutations = 0
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_prototypes","details"')) {
      this.prototypeReads++
      return JSON.stringify({
        found: true,
        query: 'assembling-machine-1',
        item: { name: 'assembling-machine-1', stack_size: 50, place_result: 'assembling-machine-1' },
        entity: {
          name: 'assembling-machine-1',
          type: 'assembling-machine',
          is_building: true,
          tile_width: 3,
          tile_height: 3,
          collision_box: { left_top: { x: -1.2, y: -1.2 }, right_bottom: { x: 1.2, y: 1.2 } },
          selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
          place_items: [{ name: 'assembling-machine-1', count: 1 }],
          fluidboxes: [{
            index: 1,
            production_type: 'input-output',
            pipe_connection_count: 1,
            pipe_connections_truncated: false,
            pipe_connections: [{
              connection_type: 'normal',
              flow_direction: 'input-output',
              direction: 4,
              positions: [{ x: 1.5, y: 0 }],
              positions_truncated: false,
              connection_categories: ['default'],
              connection_categories_truncated: false,
            }],
          }],
          fluidboxes_truncated: false,
          crafting: { speed: 0.5, categories: ['crafting'], ingredient_count: 2, energy_usage: 75000 },
        },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      this.mutations++
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return 'tool-output'
  }
}

function prototypeTool(id) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: 'getPrototypeDetails', arguments: '{"name":"assembling-machine-1"}' },
    }],
  }
}

function planMessage(operations, chatMessage = '') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Build with known assembler geometry'] : [],
      currentStep: 0,
      operations,
    }),
  }
}

test('static prototype facts survive continuation as a compact baseline and repeated reads skip RCON', async () => {
  const rcon = new FakeRcon()
  const providerInputs = []
  const replies = [
    prototypeTool('prototype-first'),
    planMessage([{ name: 'wait', args: { ticks: 1 } }], 'Start.'),
    prototypeTool('prototype-repeat'),
    planMessage([], 'Done.'),
  ]
  const agent = new NpcAgentLoop({
    rcon,
    systemPrompt: 'NPC test prompt',
    provider: async messages => {
      providerInputs.push(messages.map(message => ({ ...message })))
      return replies.shift()
    },
  })

  await agent.request('inspect assembler then wait', { sender: 'TTLouis' })
  assert.equal(rcon.prototypeReads, 1)
  assert.equal(agent.active, true)

  const final = await agent.completed()
  assert.equal(final.chatMessage, 'Done.')
  assert.equal(rcon.prototypeReads, 1)

  const continuationStart = providerInputs[2].map(message => String(message.content ?? '')).join('\n')
  assert.match(continuationStart, /\[STATIC_PROTOTYPE_CACHE\]/)
  assert.match(continuationStart, /assembling-machine-1/)
  assert.match(continuationStart, /collision_box/)
  assert.match(continuationStart, /pipe_connections/)

  const afterRepeat = providerInputs[3].find(message => message.role === 'tool' && message.tool_call_id === 'prototype-repeat')
  assert.ok(afterRepeat)
  const repeated = JSON.parse(afterRepeat.content)
  assert.equal(repeated.observation_mode, 'unchanged')
  assert.equal(repeated.source, 'runtime_static_prototype_cache')
  assert.equal(repeated.reference, 'prototype:assembling-machine-1')
  assert.ok(afterRepeat.content.length < 260)
})
