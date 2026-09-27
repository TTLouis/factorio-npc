import assert from 'node:assert/strict'
import test from 'node:test'

import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import { contractCheckedJev } from './task-loop-fixtures.mjs'

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

class JevOnlyRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.nearby = {
      actor_position: { x: 0, y: 0 },
      entities: [
        { name: 'stone-furnace', type: 'furnace', unit_number: 101, position: { x: 4, y: 0 }, distance: 4 },
        { name: 'assembling-machine-1', type: 'assembling-machine', unit_number: 202, position: { x: 9, y: 1 }, distance: 9.05 },
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

function projectionAnswer(choice, confidence, candidateCount = 2) {
  const keys = [
    ...Array.from({ length: candidateCount }, (_, index) => `candidate_${index + 1}`),
    'need_observation',
    'wake_planner',
    'ask_user',
  ]
  const remaining = Math.max(0, 1 - confidence)
  const other = keys.length > 1 ? remaining / (keys.length - 1) : 0
  return {
    answers: {
      projection_action: {
        type: 'choice',
        choice,
        probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? confidence : other])),
        confidence,
      },
    },
    provider: 'fixture-jev',
    model: 'fixture-jev-only',
  }
}

function makeAgent(rcon, decisionProvider) {
  let mainLlmCalls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'JEV-only integration test',
    reasoningMode: 'jev_only',
    goalDefinitionPolicy: 'optional',
    provider: async () => {
      mainLlmCalls++
      throw new Error('Main LLM must never be called in JEV-only mode')
    },
    operationProjectionDecisionProvider: contractCheckedJev(decisionProvider),
  })
  return { agent, mainLlmCalls: () => mainLlmCalls }
}

test('JEV-only selects a complete grounded navigation candidate and preserves normal preflight', async () => {
  const rcon = new JevOnlyRcon()
  const decisions = []
  const { agent, mainLlmCalls } = makeAgent(rcon, async (state, questions) => {
    decisions.push({ state, questions })
    assert.equal(state.contract, 'jev_only_action_selection')
    assert.equal(state.mode, 'navigation_mvp')
    assert.equal(state.message, 'go to the assembling machine')
    assert.deepEqual(Object.keys(questions.projection_action.criteria), [
      'candidate_1',
      'candidate_2',
      'need_observation',
      'wake_planner',
      'ask_user',
    ])
    return projectionAnswer('candidate_2', 0.95)
  })

  const result = await agent.request('go to the assembling machine', { sender: 'tester' })

  assert.equal(mainLlmCalls(), 0)
  assert.equal(decisions.length, 1)
  assert.equal(result.operations.length, 1)
  assert.equal(result.operations[0].name, 'walk_to_entity_exact')
  assert.equal(result.operations[0].args.unit_number, 202)
  assert.equal(result.operations[0].args.reach_distance, 2.5)
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /walk_to_entity_exact',202,2\.5/)
  assert.ok(rcon.commands.some(command => command.includes('autorio_preflight')))
})

test('JEV-only low confidence fails closed instead of waking the Main LLM', async () => {
  const rcon = new JevOnlyRcon()
  const { agent, mainLlmCalls } = makeAgent(rcon, async () => projectionAnswer('candidate_1', 0.6))

  const result = await agent.request('go to a nearby machine', { sender: 'tester' })

  assert.equal(mainLlmCalls(), 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.goalStatus, 'unsupported')
  assert.equal(result.blocker.class, 'jev_only_unsupported_decision_space')
  assert.match(result.blocker.reason, /confidence|wake_planner/i)
  assert.equal(rcon.mutations.length, 0)
})

test('JEV-only provider failure fails closed with no mutation and no Main-LLM fallback', async () => {
  const rcon = new JevOnlyRcon()
  const { agent, mainLlmCalls } = makeAgent(rcon, async () => {
    throw new Error('fixture Jev unavailable')
  })

  const result = await agent.request('go somewhere useful', { sender: 'tester' })

  assert.equal(mainLlmCalls(), 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.goalStatus, 'unsupported')
  assert.match(result.blocker.reason, /JEV action selection failed/i)
  assert.equal(rcon.mutations.length, 0)
})

test('JEV-only with no authoritative entity candidates stops without inventing a target', async () => {
  const rcon = new JevOnlyRcon()
  rcon.nearby.entities = []
  let jevCalls = 0
  const { agent, mainLlmCalls } = makeAgent(rcon, async () => {
    jevCalls++
    return projectionAnswer('need_observation', 0.9, 0)
  })

  const result = await agent.request('go to the thing I mean', { sender: 'tester' })

  assert.equal(mainLlmCalls(), 0)
  assert.equal(jevCalls, 0)
  assert.equal(result.operations.length, 0)
  assert.match(result.blocker.reason, /no nearby entity/i)
  assert.equal(rcon.mutations.length, 0)
})
