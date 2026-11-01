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
} = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

class ExactTargetRcon {
  constructor() {
    this.commands = []
    this.mutations = []
    this.nearby = { actor_position: { x: 0, y: 0 }, entities: [] }
    this.preflightByUnit = new Map()
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
    }
  }

  completedStatus(batchId, taskTypes, basicResult = undefined) {
    this.operationStatus = {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      actor: {
        actor_id: 18,
        position: { x: 0, y: 0 },
      },
      last_completed_batch: {
        batch_id: batchId,
        task_count: taskTypes.length,
        task_types: taskTypes,
        tick: 200 + batchId,
      },
      ...(basicResult ? { basic_operation: { last_result: basicResult } } : {}),
    }
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify(this.operationStatus)
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const match = text.match(/unit_number[^0-9]*(\d+)/)
      const unitNumber = match ? Number(match[1]) : undefined
      if (unitNumber !== undefined && this.preflightByUnit.has(unitNumber)) {
        return JSON.stringify(this.preflightByUnit.get(unitNumber))
      }
      return JSON.stringify({ ok: true })
    }
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

test('same-goal live observed exact id is executable', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 8, y: 1 }, distance: 8.1 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'same goal exact identity test',
    provider: async (_messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
    },
  })

  const result = await agent.request('act on the furnace I just observed', { sender: 'tester' })
  assert.equal(result.operations[0].name, 'mine_entity_exact')
  assert.equal(result.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 1)
})

test('placement completion receipt binds the created entity for an immediate exact follow-up without re-observation', async () => {
  const rcon = new ExactTargetRcon()
  rcon.preflightByUnit.set(77, {
    ok: true,
    operation: 'supply_entity',
    field: 'unit_number',
    identity: 77,
  })

  const canonicalPlan = ['Place a furnace', 'Load the placed furnace']
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'placement receipt exact identity handoff test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return planMessage([{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 3, y: 0 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }

      const text = messages.map(message => String(message.content ?? '')).join('\n')
      assert.match(text, /placed_unit_number["']?\s*:\s*77/i)
      return planMessage([{
        name: 'supply_entity',
        args: {
          unit_number: 77,
          items: [
            { item_name: 'iron-ore', count: 5 },
            { item_name: 'coal', count: 1 },
          ],
        },
      }], {
        plan: canonicalPlan,
        currentStep: 1,
      })
    },
  })

  const placed = await agent.request('place a furnace and load it', { sender: 'tester' })
  assert.equal(placed.operations[0].name, 'place_entity')
  assert.equal(rcon.mutations.length, 1)

  rcon.completedStatus(1, ['placing'], {
    operation_id: 1,
    type: 'placing',
    accepted: true,
    completed: true,
    code: 'completed',
    tick: 201,
    actor_id: 18,
    force_index: 1,
    entity_name: 'stone-furnace',
    requested_position: { x: 3, y: 0 },
    placed_unit_number: 77,
    placed_entity_type: 'furnace',
    placed_position: { x: 3, y: 0 },
    placed_surface_index: 1,
    placed_direction: 0,
  })
  const follow = await agent.completed()

  assert.equal(calls, 2)
  assert.equal(follow.operations[0].name, 'supply_entity')
  assert.equal(follow.operations[0].args.unit_number, 77)
  assert.equal(rcon.mutations.length, 2)
  assert.match(rcon.mutations[1], /supply_entity',77/)
  assert.equal(rcon.commands.some(command => command.includes('get_nearby_entities')), false)
})

test('old task unit id cannot leak into a new human request', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 8, y: 1 }, distance: 8.1 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'request scoped exact identity test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('observe-first', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      if (calls === 2) return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
      if (calls === 3) {
        const durableContext = messages.map(message => String(message.content ?? '')).join('\n')
        assert.doesNotMatch(durableContext, /unit_number["']?\s*:\s*289/i)
        assert.doesNotMatch(durableContext, /\bunit\s+289\b/i)
        assert.match(durableContext, /entity_references/)
        assert.match(durableContext, /target_locator/)
        assert.match(durableContext, /"name":"stone-furnace"/)
        assert.match(durableContext, /"position":\{"x":8,"y":1\}/)
        return planMessage([{ name: 'walk_to_entity_exact', args: { unit_number: 289, reach_distance: 2.5 } }])
      }
      if (calls === 4) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /not bound by a live observation in this active request/i)
        assert.match(text, /walk_to_position/i)
        assert.match(text, /absolute position \(8, 1\)/i)
        return planMessage([{ name: 'walk_to_position', args: { x: 8, y: 1, reach_distance: 2 } }])
      }
      if (calls === 5) {
        return { content: null, tool_calls: [toolCall('observe-replacement', 'getNearbyEntities', { radius: 16, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 417 } }])
    },
  })

  const first = await agent.request('act on the observed furnace', { sender: 'tester' })
  assert.equal(first.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 1)

  const second = await agent.request('new task involving that furnace', { sender: 'tester' })
  assert.equal(second.operations[0].name, 'walk_to_position')
  assert.deepEqual(second.operations[0].args, { x: 8, y: 1, reach_distance: 2 })
  assert.equal(calls, 4)
  assert.equal(rcon.mutations.length, 2)
  assert.doesNotMatch(rcon.mutations[1], /walk_to_entity_exact',289/)

  rcon.nearby = {
    actor_position: { x: 7, y: 1 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 417, position: { x: 8, y: 1 }, distance: 1 }],
  }
  rcon.completedStatus(2, ['walking_direct'])
  const rebound = await agent.completed()

  assert.equal(rebound.operations[0].name, 'mine_entity_exact')
  assert.equal(rebound.operations[0].args.unit_number, 417)
  assert.equal(calls, 6)
  assert.equal(rcon.mutations.length, 3)
  assert.match(rcon.mutations[2], /mine_entity_exact',417/)
  assert.doesNotMatch(rcon.mutations[2], /mine_entity_exact',289/)
})

test('stale exact id is rejected before admission and replacement is rebound after coordinate return', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 60, position: { x: 10, y: 4 }, distance: 10.8 }],
  }
  rcon.preflightByUnit.set(60, {
    ok: false,
    code: 'stale_exact_target',
    operation: 'mine_entity_exact',
    field: 'unit_number',
    identity: 60,
    last_observed: {
      unit_number: 60,
      name: 'stone-furnace',
      surface_index: 1,
      force_index: 1,
      position: { x: 10, y: 4 },
      observed_tick: 100,
    },
  })

  let calls = 0
  const canonicalPlan = ['Return to known location', 'Bind and act on current entity']
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'stale exact identity recovery test',
    provider: async (messages, context) => {
      calls++
      assert.equal(context.allowTools, true)
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('old-furnace', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      if (calls === 2) {
        return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 60 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }
      if (calls === 3) {
        const text = messages.map(message => String(message.content ?? '')).join('\n')
        assert.match(text, /deterministic preflight rejected it before Autorio admission/i)
        assert.match(text, /\(10, 4\)/)
        return planMessage([{ name: 'walk_to_position', args: { x: 10, y: 4, reach_distance: 2 } }], {
          plan: canonicalPlan,
          currentStep: 0,
        })
      }
      if (calls === 4) {
        return { content: null, tool_calls: [toolCall('replacement-furnace', 'getNearbyEntities', { radius: 16, name: 'stone-furnace', limit: 4 })] }
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }], {
        plan: canonicalPlan,
        currentStep: 1,
      })
    },
  })

  const approach = await agent.request('return to that furnace location and act on the current furnace there', { sender: 'tester' })
  assert.equal(approach.operations[0].name, 'walk_to_position')
  assert.equal(rcon.mutations.length, 1)
  assert.doesNotMatch(rcon.mutations[0], /mine_entity_exact',60/)

  rcon.nearby = {
    actor_position: { x: 9, y: 4 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 289, position: { x: 10, y: 4 }, distance: 1 }],
  }
  rcon.preflightByUnit.set(289, {
    ok: true,
    operation: 'mine_entity_exact',
    field: 'unit_number',
    identity: 289,
  })
  rcon.completedStatus(1, ['walking_direct'])
  const rebound = await agent.completed()

  assert.equal(rebound.operations[0].name, 'mine_entity_exact')
  assert.equal(rebound.operations[0].args.unit_number, 289)
  assert.equal(rcon.mutations.length, 2)
  assert.match(rcon.mutations[1], /mine_entity_exact',289/)
  assert.doesNotMatch(rcon.mutations[1], /mine_entity_exact',60/)
})


test('restored legacy durable memory sanitizes historical exact ids while preserving semantic location', () => {
  const memory = new NpcDialogueMemory()
  memory.restore({
    version: 1,
    dialogue: [{
      key: 'npc:sgluna',
      summary: 'tester: return to unit 991337 | SGLuna: remembered target | actions: mine_entity_exact {"unit_number":991337}',
      recent: [{
        id: 7,
        sender: 'tester',
        user: 'continue with unit 991337',
        assistant: 'I will use target_unit_number=991337',
        actions: 'move_items_exact {"item_name":"iron-ore","unit_number":991337,"max_count":10,"to_entity":true}',
      }],
    }],
    plans: [{
      key: 'npc:sgluna',
      state: {
        goal_id: 'goal_legacy',
        owner: 'tester',
        objective: 'return to unit 991337 at the known furnace',
        status: 'blocked',
        admission_status: 'admission_failed',
        blocker: 'Exact entity target unit 991337 is stale',
        pause_reason: 'paused after unit_number=991337 was rejected',
        plan: ['Return to unit 991337', 'Load the furnace'],
        current_step: 0,
        revision: 4,
        last_chat_message: 'Target unit 991337 needs recovery',
        last_operations: ['move_items_exact {"item_name":"iron-ore","unit_number":991337,"max_count":10,"to_entity":true}'],
        history: [{
          revision: 3,
          status: 'active',
          current_step: 0,
          step: 'Walk back to unit 991337',
          chat: 'using unit_number=991337',
        }],
        task_board: {
          kind: 'task_board_lite',
          goal_id: 'goal_legacy',
          status: 'blocked',
          blocker: 'target unit 991337 is stale',
          pause_reason: 'unit_number=991337 failed',
          revision: 4,
          active_index: 0,
          steps: [
            { id: 'step_1', description: 'Return to unit 991337', status: 'blocked', revision: 1 },
            { id: 'step_2', description: 'Load the furnace', status: 'pending', revision: 1 },
          ],
          evidence: [{
            id: 'e1',
            kind: 'operation_preflight_rejection',
            summary: JSON.stringify({
              code: 'stale_exact_target',
              identity: 991337,
              last_observed: {
                unit_number: 991337,
                name: 'stone-furnace',
                surface_index: 1,
                position: { x: 120.5, y: -42.5 },
              },
              basic_operation: {
                target_unit_number: 991337,
                entity_name: 'stone-furnace',
              },
            }),
            ref: 'legacy/unit_991337/stale',
            at: 1,
          }],
          events: [{
            seq: 1,
            type: 'blocked',
            at: 1,
            revision: 4,
            from_step: 'unit 991337',
            to_step: 'recover location',
          }],
          created_at: 1,
          updated_at: 2,
        },
        updated_at: 2,
      },
    }],
  })

  const raw = memory.currentPlan('npc:sgluna')
  assert.match(raw.last_operations[0], /991337/)
  assert.match(raw.task_board.evidence[0].summary, /991337/)
  assert.match(memory.snapshot().dialogue[0].summary, /991337/)

  const context = memory.context('npc:sgluna')
  assert.match(context, /entity_references/)
  assert.match(context, /stone-furnace/)
  assert.match(context, /120\.5/)
  assert.match(context, /-42\.5/)
  assert.doesNotMatch(context, /991337/)
  assert.doesNotMatch(context, /"unit_number"\s*:\s*991337/)
  assert.doesNotMatch(context, /"target_unit_number"\s*:\s*991337/)
})

test('repeating the same stale durable exact id stops after one corrective retry without mutating canonical state', async () => {
  const rcon = new ExactTargetRcon()
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 331, position: { x: 12, y: -3 }, distance: 12.4 }],
  }
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon,
    memory: new NpcDialogueMemory(),
    systemPrompt: 'repeat stale exact identity test',
    provider: async (messages) => {
      calls++
      if (calls === 1) {
        return { content: null, tool_calls: [toolCall('observe-old', 'getNearbyEntities', { radius: 64, name: 'stone-furnace', limit: 4 })] }
      }
      if (calls === 2) {
        return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 331 } }], {
          plan: ['Act on the furnace'],
        })
      }
      const text = messages.map(message => String(message.content ?? '')).join('\n')
      if (calls === 3) {
        assert.doesNotMatch(text, /unit_number["']?\s*:\s*331/i)
        assert.match(text, /"position":\{"x":12,"y":-3\}/)
      }
      if (calls === 4) {
        assert.match(text, /Do not resubmit the rejected id/i)
        assert.match(text, /absolute position \(12, -3\)/i)
      }
      return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 331 } }], {
        plan: ['Act on the furnace'],
      })
    },
  })

  const first = await agent.request('act on the observed furnace', { sender: 'tester' })
  assert.equal(first.operations[0].args.unit_number, 331)
  const before = agent.memory.currentPlan('npc:sgluna')
  assert.equal(rcon.mutations.length, 1)

  const second = await agent.request('continue at that furnace', { sender: 'tester' })
  assert.equal(second.blocked, true)
  assert.equal(second.blocker.class, 'plan_category')
  assert.match(second.blocker.reason, /already rejected in this active request/i)
  assert.equal(calls, 4)
  assert.equal(rcon.mutations.length, 1)

  const after = agent.memory.currentPlan('npc:sgluna')
  assert.equal(after.goal_id, before.goal_id)
  assert.equal(after.revision, before.revision)
  assert.deepEqual(after.last_operations, before.last_operations)
})
