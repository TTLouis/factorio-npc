import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
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

function planMessage(operations, {
  chatMessage = '',
  plan = ['Do the current step'],
  currentStep = 0,
  checkpoint,
} = {}) {
  return {
    content: JSON.stringify({ chatMessage, plan, currentStep, operations, ...(checkpoint ? { checkpoint } : {}) }),
  }
}

function completionAndContinueDecision(state) {
  if (state?.contract === 'step_completion_contract') {
    return {
      model: 'jev-test',
      provider: 'TypeSafe',
      answers: {
        contract: {
          type: 'choice',
          choice: 'candidate_1',
          confidence: 0.99,
          probabilities: { candidate_1: 0.99, semantic_unknown: 0.01 },
        },
        compound_step: { type: 'noul', noul: 0.01 },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
    }
  }
  if (state?.reason === 'post_step_planner_gate') {
    return {
      model: 'jev-test',
      provider: 'TypeSafe',
      answers: {
        route: {
          type: 'choice',
          choice: 'continue_current',
          confidence: 0.99,
          probabilities: { continue_current: 0.99 },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2, cost: 0 },
    }
  }
  throw new Error('unexpected decision contract')
}

class E2eRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.inventory = { items: [{ name: 'wooden-chest', count: 1 }] }
    this.nearby = { actor_position: { x: 0, y: 0 }, entities: [] }
    this.navigation = { task_active: false, state: 'idle' }
    this.follow = { active: false }
    this.planPlacement = { ok: true, candidates: [{ x: 3, y: 0, direction: 0 }] }
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
    }
  }

  completedStatus(batchId, taskTypes, basicOperation) {
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_completed_batch: {
        batch_id: batchId,
        task_count: taskTypes.length,
        task_types: taskTypes,
        tick: 200 + batchId,
      },
      ...(basicOperation ? { basic_operation: { last_result: basicOperation } } : {}),
    }
  }

  failedStatus(batchId, taskTypes, code = 'not_placeable') {
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_cancelled_batch: {
        batch_id: batchId,
        task_count: taskTypes.length,
        task_types: taskTypes,
        tick: 200 + batchId,
        reason: `placing:${code}`,
      },
      basic_operation: {
        last_result: {
          type: 'placing',
          accepted: false,
          completed: false,
          code,
          entity_name: 'wooden-chest',
        },
      },
    }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_inventory_items")')) return JSON.stringify(this.inventory)
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_navigation","status")')) return JSON.stringify(this.navigation)
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify(this.follow)
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, position: { x: 0, y: 0 } } })
    if (text.includes('remote.call("autorio_planning","plan_placement"')) return JSON.stringify(this.planPlacement)
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify(this.operationStatus)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

test('observation tool emitted in operations gets tool-enabled category repair', async () => {
  const rcon = new E2eRcon()
  const contexts = []
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'placement category recovery test',
    provider: async (messages, context) => {
      contexts.push(context)
      calls++
      if (calls === 1) {
        return planMessage([{ name: 'planPlacement', args: { entity_name: 'wooden-chest' } }], {
          plan: ['Place chest'],
        })
      }
      if (calls === 2) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /observation\/planning tool/i)
        assert.equal(context.allowTools, true)
        return { content: null, tool_calls: [toolCall('placement-plan', 'planPlacement', { entity_name: 'wooden-chest' })] }
      }
      return planMessage([{ name: 'place_entity', args: { entity_name: 'wooden-chest', x: 3, y: 0 } }], {
        plan: ['Place chest'],
      })
    },
  })

  const result = await agent.request('place a chest nearby', { sender: 'tester' })
  assert.equal(calls, 3)
  assert.equal(contexts.every(context => context.allowTools === true), true)
  assert.equal(rcon.commands.some(command => command.includes('plan_placement')), true)
  assert.equal(result.operations[0].name, 'place_entity')
  assert.equal(rcon.mutations.length, 1)
})

test('simple unconstrained placement uses place_entity without planner observations', async () => {
  const rcon = new E2eRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'simple placement test',
    provider: async () => {
      calls++
      if (calls === 1) return { content: null, tool_calls: [toolCall('inventory', 'getInventoryItems')] }
      return planMessage([{ name: 'place_entity', args: { entity_name: 'wooden-chest' } }], {
        plan: ['Place the chest nearby'],
      })
    },
  })

  const result = await agent.request('place a wooden chest nearby', { sender: 'tester' })
  assert.equal(result.operations[0].name, 'place_entity')
  assert.deepEqual(result.operations[0].args, { entity_name: 'wooden-chest' })
  assert.equal(rcon.commands.some(command => command.includes('plan_placement')), false)
  assert.equal(rcon.commands.some(command => command.includes('get_placement_candidates')), false)
  assert.equal(rcon.mutations.length, 1)
})

test('meaningful simple-placement failure can fall back to placement planning and retry', async () => {
  const rcon = new E2eRcon()
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'placement fallback test',
    provider: async (_messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([{ name: 'place_entity', args: { entity_name: 'wooden-chest' } }], {
          plan: ['Place chest'],
        })
      }
      if (calls === 2) {
        return { content: null, tool_calls: [toolCall('placement-plan', 'planPlacement', { entity_name: 'wooden-chest' })] }
      }
      return planMessage([{ name: 'place_entity', args: { entity_name: 'wooden-chest', x: 3, y: 0 } }], {
        plan: ['Place chest'],
      })
    },
  })

  await agent.request('place a chest nearby', { sender: 'tester' })
  rcon.failedStatus(1, ['placing'], 'not_placeable')
  const retry = await agent.failed('placing:not_placeable')

  assert.equal(calls, 3)
  assert.equal(retry.operations[0].name, 'place_entity')
  assert.deepEqual(retry.operations[0].args, { entity_name: 'wooden-chest', x: 3, y: 0 })
  assert.equal(rcon.commands.some(command => command.includes('plan_placement')), true)
  assert.equal(rcon.mutations.length, 2)
})

test('observed exact entity identity rejects legacy name mining and repairs to mine_entity_exact', async () => {
  const rcon = new E2eRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'tree-05', type: 'tree', unit_number: 901, position: { x: 20, y: 0 }, distance: 20 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'exact entity mining test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) return { content: null, tool_calls: [toolCall('trees', 'getNearbyEntities', { radius: 64, name: 'tree-05', limit: 8 })] }
      if (calls === 2) {
        return planMessage([{ name: 'mine_entity', args: { entity_name: 'tree-05', count: 1 } }], {
          plan: ['Collect wood'],
        })
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /Exact live identity was already observed/)
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 901 } }], {
        plan: ['Collect wood'],
      })
    },
  })

  const result = await agent.request('collect wood from the observed tree', { sender: 'tester' })
  assert.equal(calls, 3)
  assert.equal(result.operations[0].name, 'mine_entity_exact')
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /mine_entity_exact',901/)
  assert.doesNotMatch(rcon.mutations[0], /'mine_entity','tree-05'/)
})

test('remote name-only entity requires approach and navigation completion automatically continues into mining', async () => {
  const rcon = new E2eRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'tree-05', type: 'tree', position: { x: 20, y: 0 }, distance: 20 }],
  }
  const memory = new CanonicalTaskBoardMemory()
  let calls = 0
  const canonicalPlan = ['Approach selected entity', 'Mine selected entity', 'Verify collected item count']
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'name-only mining continuation test',
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) return { content: null, tool_calls: [toolCall('trees', 'getNearbyEntities', { radius: 64, name: 'tree-05', limit: 8 })] }
      if (calls === 2) {
        return planMessage([{ name: 'mine_entity', args: { entity_name: 'tree-05', count: 1 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }
      if (calls === 3) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /Approach it first with walk_to_entity/)
        // The approach step means "arrived", so the planner authors the
        // arrival receipt as its deterministic checkpoint; runtime then
        // closes it without a second AI judge.
        return planMessage([{ name: 'walk_to_entity', args: { entity_name: 'tree-05', search_radius: 22 } }], {
          plan: canonicalPlan,
          currentStep: 0,
          checkpoint: {
            mode: 'all',
            requirements: [{ id: 'arrived', kind: 'authoritative_operation_receipt', operation_name: 'walk_to_entity' }],
          },
        })
      }
      if (calls === 4) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /"completed_count":1/)
        return planMessage([], { plan: canonicalPlan, currentStep: 1 })
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /do not stop and wait for a human/i)
      return planMessage([{ name: 'mine_entity', args: { entity_name: 'tree-05', count: 1 } }], {
        plan: canonicalPlan,
        currentStep: 1,
      })
    },
  })

  const approach = await agent.request('collect wood from the nearby tree', { sender: 'tester' })
  assert.equal(approach.operations[0].name, 'walk_to_entity')
  assert.equal(rcon.mutations.length, 1)
  assert.match(rcon.mutations[0], /walk_to_entity/)

  rcon.completedStatus(1, ['walking_to_entity'])
  const mining = await agent.completed()
  assert.equal(calls, 5)
  assert.equal(mining.operations[0].name, 'mine_entity')
  assert.equal(rcon.mutations.length, 2)
  assert.match(rcon.mutations[1], /'mine_entity','tree-05',1/)
  assert.equal(memory.currentPlan('npc:airi').task_board.completed_count, 1)
})

test('alternating distinct read-only observations trigger generic decision pressure before round twelve', async () => {
  const rcon = new E2eRcon()
  const observations = [
    toolCall('actor', 'getActorStatus'),
    toolCall('task', 'getTaskStatus'),
    toolCall('inventory', 'getInventoryItems'),
    toolCall('navigation', 'getNavigationStatus'),
  ]
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'observation convergence test',
    provider: async (messages) => {
      calls++
      if (calls <= observations.length) return { content: null, tool_calls: [observations[calls - 1]] }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /Decision pressure after 3 consecutive observation-only rounds/)
      return planMessage([{ name: 'wait', args: { ticks: 1 } }])
    },
  })

  const result = await agent.request('make one finite decision', { sender: 'tester' })
  assert.equal(calls, 5)
  assert.ok(calls < 12)
  assert.equal(result.operations[0].name, 'wait')
})


test('wood collection flow uses exact mining, verifies inventory twenty, and completes without human continuation', async () => {
  const rcon = new E2eRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [901, 902, 903, 904, 905].map((unit_number, index) => ({
      name: 'tree-05',
      type: 'tree',
      unit_number,
      position: { x: 10 + index * 2, y: 0 },
      distance: 10 + index * 2,
    })),
  }
  rcon.inventory = { items: [] }
  const memory = new CanonicalTaskBoardMemory()
  const canonicalPlan = ['Collect at least 20 wood']
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'wood collection end-to-end harness test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('trees', 'getNearbyEntities', { radius: 64, name: 'tree-05', limit: 8 })] }
      }
      if (calls === 2) {
        return planMessage(
          [901, 902, 903, 904, 905].map(unit_number => ({ name: 'mine_entity_exact', args: { unit_number } })),
          { plan: canonicalPlan, currentStep: 0 },
        )
      }
      if (calls === 3) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /"completed_count":0/)
        assert.match(text, /deterministic_verification/)
        return { content: null, tool_calls: [toolCall('wood-inventory', 'getInventoryItems')] }
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /"name":"wood","count":20/)
      return planMessage([], {
        chatMessage: 'Collected and verified at least 20 wood.',
        plan: [],
        currentStep: 0,
      })
    },
  })

  const mining = await agent.request('go cut nearby trees and collect 20 wood', { sender: 'tester' })
  assert.equal(mining.operations.length, 5)
  assert.equal(mining.operations.every(operation => operation.name === 'mine_entity_exact'), true)
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /gather_resource/)
  assert.doesNotMatch(rcon.mutations[0], /'mine_entity','tree-05'/)

  rcon.inventory = { items: [{ name: 'wood', count: 20 }] }
  rcon.completedStatus(2, ['mining', 'mining', 'mining', 'mining', 'mining'], {
    type: 'mining',
    accepted: true,
    completed: true,
    code: 'completed',
    target_unit_number: 905,
    requested_count: 1,
  })
  const completed = await agent.completed()

  assert.equal(calls, 4)
  assert.equal(completed.goalStatus, 'completed')
  assert.equal(completed.operations.length, 0)
  assert.equal(memory.currentPlan('npc:airi'), undefined)
  assert.equal(rcon.commands.some(command => command.includes("gather_resource") && command.includes("tree")), false)
})
