import assert from 'node:assert/strict'
import test from 'node:test'

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

function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function planMessage(operation) {
  return {
    content: JSON.stringify({
      chatMessage: 'Walking to the requested furnace.',
      plan: ['Walk to the requested furnace'],
      currentStep: 0,
      operations: [operation],
    }),
  }
}

class ProjectionRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [
        { name: 'stone-furnace', type: 'furnace', unit_number: 101, position: { x: 4, y: 0 }, distance: 4 },
        { name: 'stone-furnace', type: 'furnace', unit_number: 202, position: { x: 9, y: 1 }, distance: 9.05 },
      ],
    }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function projectionAnswer(choice, confidence) {
  const remaining = Math.max(0, 1 - confidence)
  const other = remaining / 4
  return {
    answers: {
      projection_action: {
        type: 'choice',
        choice,
        probabilities: {
          candidate_1: choice === 'candidate_1' ? confidence : other,
          candidate_2: choice === 'candidate_2' ? confidence : other,
          need_observation: other,
          wake_planner: other,
          ask_user: other,
        },
        confidence,
      },
    },
    provider: 'fixture-jev',
    model: 'fixture-live-shape',
  }
}

test('live low-risk projection exactifies ambiguous observed name navigation before normal preflight', async () => {
  const rcon = new ProjectionRcon()
  let plannerCalls = 0
  const projectionCalls = []
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed projection live integration test',
    provider: async (_messages, context) => {
      plannerCalls++
      assert.equal(context.allowTools, true)
      if (plannerCalls === 1) {
        return {
          content: null,
          tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 32, name: 'stone-furnace', limit: 4 })],
        }
      }
      return planMessage({
        name: 'walk_to_entity',
        args: { entity_name: 'stone-furnace', search_radius: 32 },
      })
    },
    operationProjectionDecisionProvider: async (state, questions) => {
      projectionCalls.push({ state, questions })
      assert.equal(state.contract, 'typed_operation_projection')
      assert.equal(state.mode, 'active_low_risk_navigation_exactification')
      assert.deepEqual(Object.keys(questions), ['projection_action'])
      assert.deepEqual(Object.keys(questions.projection_action.criteria), [
        'candidate_1',
        'candidate_2',
        'need_observation',
        'wake_planner',
        'ask_user',
      ])
      return projectionAnswer('candidate_2', 0.95)
    },
  })

  const result = await agent.request('walk to the farther observed stone furnace', { sender: 'tester' })

  assert.equal(projectionCalls.length, 1)
  assert.equal(result.operations[0].name, 'walk_to_entity_exact')
  assert.equal(result.operations[0].args.unit_number, 202)
  assert.equal(result.operations[0].args.reach_distance, 2.5)
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /walk_to_entity_exact',202,2\.5/)
  assert.ok(rcon.commands.some(command => command.includes('autorio_preflight')))
})

test('low-confidence projection preserves the Main-LLM navigation operation', async () => {
  const rcon = new ProjectionRcon()
  let plannerCalls = 0
  let projectionCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed projection confidence fallback test',
    provider: async () => {
      plannerCalls++
      if (plannerCalls === 1) {
        return {
          content: null,
          tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 32, name: 'stone-furnace', limit: 4 })],
        }
      }
      return planMessage({
        name: 'walk_to_entity',
        args: { entity_name: 'stone-furnace', search_radius: 32 },
      })
    },
    operationProjectionDecisionProvider: async () => {
      projectionCalls++
      return projectionAnswer('candidate_2', 0.6)
    },
  })

  const result = await agent.request('walk to a stone furnace', { sender: 'tester' })

  assert.equal(projectionCalls, 1)
  assert.equal(result.operations[0].name, 'walk_to_entity')
  assert.deepEqual(result.operations[0].args, { entity_name: 'stone-furnace', search_radius: 32 })
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /walk_to_entity','stone-furnace',32/)
  assert.doesNotMatch(rcon.mutations[0], /walk_to_entity_exact/)
})

test('projection provider failure cannot block an already-valid low-risk Main-LLM operation', async () => {
  const rcon = new ProjectionRcon()
  let plannerCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed projection provider failure fallback test',
    provider: async () => {
      plannerCalls++
      if (plannerCalls === 1) {
        return {
          content: null,
          tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 32, name: 'stone-furnace', limit: 4 })],
        }
      }
      return planMessage({
        name: 'walk_to_entity',
        args: { entity_name: 'stone-furnace', search_radius: 32 },
      })
    },
    operationProjectionDecisionProvider: async () => {
      throw new Error('fixture decision provider unavailable')
    },
  })

  const result = await agent.request('walk to a stone furnace', { sender: 'tester' })

  assert.equal(result.operations[0].name, 'walk_to_entity')
  assert.equal(rcon.mutations.length, 1)
})

test('one observed exact target does not spend a Jev projection call', async () => {
  const rcon = new ProjectionRcon()
  rcon.nearby.entities = [rcon.nearby.entities[0]]
  let plannerCalls = 0
  let projectionCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'typed projection deterministic bypass test',
    provider: async () => {
      plannerCalls++
      if (plannerCalls === 1) {
        return {
          content: null,
          tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 32, name: 'stone-furnace', limit: 4 })],
        }
      }
      return planMessage({
        name: 'walk_to_entity',
        args: { entity_name: 'stone-furnace', search_radius: 32 },
      })
    },
    operationProjectionDecisionProvider: async () => {
      projectionCalls++
      return projectionAnswer('candidate_1', 0.99)
    },
  })

  const result = await agent.request('walk to the observed stone furnace', { sender: 'tester' })

  assert.equal(projectionCalls, 0)
  assert.equal(result.operations[0].name, 'walk_to_entity')
  assert.equal(rcon.mutations.length, 1)
})
