import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

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

function entity(unitNumber, name, x, y, extra = {}) {
  return {
    name,
    type: extra.type ?? 'assembling-machine',
    position: { x, y },
    force: 'player',
    ...(unitNumber === undefined ? {} : { unit_number: unitNumber }),
    direction: extra.direction ?? 0,
    supports_direction: true,
    rotatable: true,
    ...(extra.amount === undefined ? {} : { amount: extra.amount }),
    ...(extra.spatial === undefined ? {} : { spatial: extra.spatial }),
  }
}

function nearbySnapshot(entities, { truncated = false, actorPosition = { x: 0, y: 0 }, matchedCount = entities.length } = {}) {
  return {
    actor_position: actorPosition,
    radius: 20,
    entities,
    matched_count: matchedCount,
    returned_count: entities.length,
    truncated,
  }
}

class FakeRcon {
  constructor(snapshots) {
    this.snapshots = snapshots
    this.nearbyReads = 0
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      const snapshot = this.snapshots[Math.min(this.nearbyReads, this.snapshots.length - 1)]
      this.nearbyReads++
      return JSON.stringify(snapshot)
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'IDLE',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: 9, task_count: 1, task_types: ['waiting'], tick: 120 },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function nearbyTool(id) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: { name: 'getNearbyEntities', arguments: '{"radius":20,"limit":20}' },
    }],
  }
}

function planMessage(operations, chatMessage = '') {
  return {
    content: JSON.stringify({
      chatMessage,
      plan: operations.length ? ['Observe local area'] : [],
      currentStep: 0,
      operations,
    }),
  }
}

function toolResult(messages, id) {
  return messages.find(message => message.role === 'tool' && message.tool_call_id === id)
}

async function runTwoObservations(snapshots) {
  const rcon = new FakeRcon(snapshots)
  const providerInputs = []
  const replies = [
    nearbyTool('nearby-first'),
    planMessage([{ name: 'wait', args: { ticks: 1 } }], 'Wait once.'),
    nearbyTool('nearby-second'),
    planMessage([], 'Done.'),
  ]
  const agent = new NpcAgentLoop({
    rcon,
    systemPrompt: 'NPC test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
    provider: async messages => {
      providerInputs.push(messages.map(message => ({ ...message })))
      return replies.shift()
    },
  })

  await agent.request('observe the nearby area twice', { sender: 'TTLouis' })
  assert.equal(rcon.nearbyReads, 1)
  const final = await agent.completed()
  assert.equal(final.chatMessage, '[Plan complete] Done.')
  assert.equal(rcon.nearbyReads, 2)
  return { providerInputs, rcon }
}

test('getNearbyEntities treats return-order churn as unchanged after a second live read', async () => {
  const assembler = entity(101, 'assembling-machine-1', 4.5, 2.5)
  const ore = entity(undefined, 'iron-ore', -3, 5, { type: 'resource', amount: 1000 })
  const { providerInputs, rcon } = await runTwoObservations([
    nearbySnapshot([assembler, ore]),
    nearbySnapshot([ore, assembler]),
  ])

  assert.equal(rcon.nearbyReads, 2)
  const first = JSON.parse(toolResult(providerInputs[1], 'nearby-first').content)
  assert.equal(first.observation_mode, 'full')
  assert.equal(first.entities.length, 2)
  assert.deepEqual(first.entities.map(item => item.reference), [
    'entity-fallback:iron-ore:resource:-3:5',
    'entity:101',
  ])

  const continuation = providerInputs[2].map(message => String(message.content ?? '')).join('\n')
  assert.match(continuation, /\[NEARBY_ENTITIES_BASELINE\]/)
  assert.match(continuation, /may now be stale/)
  assert.match(continuation, /entity:101/)

  const second = JSON.parse(toolResult(providerInputs[3], 'nearby-second').content)
  assert.equal(second.observation_mode, 'unchanged')
  assert.deepEqual(second.query, { radius: 20, limit: 20 })
})

test('getNearbyEntities returns canonical added removed and changed sets', async () => {
  const first = nearbySnapshot([
    entity(101, 'assembling-machine-1', 4.5, 2.5, { direction: 0 }),
    entity(102, 'transport-belt', 6.5, 2.5, { type: 'transport-belt', direction: 4 }),
  ])
  const second = nearbySnapshot([
    entity(103, 'inserter', 5.5, 3.5, { type: 'inserter', direction: 0 }),
    entity(101, 'assembling-machine-1', 4.5, 2.5, { direction: 4 }),
  ])
  const { providerInputs } = await runTwoObservations([first, second])

  const diff = JSON.parse(toolResult(providerInputs[3], 'nearby-second').content)
  assert.equal(diff.observation_mode, 'diff')
  assert.deepEqual(diff.added.map(item => item.reference), ['entity:103'])
  assert.deepEqual(diff.removed.map(item => item.reference), ['entity:102'])
  assert.deepEqual(diff.changed.map(item => item.reference), ['entity:101'])
  assert.equal(diff.changed[0].changes.direction, 4)
  assert.equal(diff.changed[0].changes.name, undefined)
})

test('getNearbyEntities preserves spatial semantics in full snapshots and diffs', async () => {
  const firstSpatial = {
    item_io: {
      drop_position: { x: 4.5, y: 5.5 },
    },
    mining: {
      search_center: { x: 4.5, y: 4.5 },
      radius: 1.5,
      resources: [{ name: 'modded-ore', entities: 6, amount: 6000 }],
    },
  }
  const secondSpatial = {
    ...firstSpatial,
    item_io: {
      drop_position: { x: 5.5, y: 4.5 },
      drop_target: {
        name: 'modded-chest',
        type: 'container',
        unit_number: 202,
        position: { x: 5.5, y: 4.5 },
      },
    },
    mining: {
      ...firstSpatial.mining,
      resources: [{ name: 'modded-ore', entities: 5, amount: 5100 }],
    },
  }

  const { providerInputs } = await runTwoObservations([
    nearbySnapshot([entity(201, 'modded-miner', 4.5, 4.5, { type: 'mining-drill', spatial: firstSpatial })]),
    nearbySnapshot([entity(201, 'modded-miner', 4.5, 4.5, { type: 'mining-drill', spatial: secondSpatial })]),
  ])

  const first = JSON.parse(toolResult(providerInputs[1], 'nearby-first').content)
  assert.deepEqual(first.entities[0].spatial, firstSpatial)

  const second = JSON.parse(toolResult(providerInputs[3], 'nearby-second').content)
  assert.equal(second.observation_mode, 'diff')
  assert.deepEqual(second.changed[0].changes.spatial, secondSpatial)

  const continuation = providerInputs[2].map(message => String(message.content ?? '')).join('\n')
  assert.match(continuation, /modded-ore/)
  assert.match(continuation, /drop_position/)
})

test('getNearbyEntities refuses to diff truncated scans', async () => {
  const { providerInputs } = await runTwoObservations([
    nearbySnapshot([
      entity(101, 'assembling-machine-1', 4.5, 2.5),
      entity(102, 'transport-belt', 6.5, 2.5, { type: 'transport-belt' }),
    ]),
    nearbySnapshot([
      entity(101, 'assembling-machine-1', 4.5, 2.5),
    ], { truncated: true, matchedCount: 7 }),
  ])

  const second = JSON.parse(toolResult(providerInputs[3], 'nearby-second').content)
  assert.equal(second.observation_mode, 'full')
  assert.equal(second.diff_unsafe_reason, 'truncated_scan')
  assert.equal(second.truncated, true)
  assert.equal(second.matched_count, 7)
  assert.equal(second.entities.length, 1)
})
