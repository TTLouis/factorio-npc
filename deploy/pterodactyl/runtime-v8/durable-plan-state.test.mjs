import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
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
    this.mutations = []
    this.batchId = 6
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      return JSON.stringify({
        actor_position: { x: 0, y: 0 },
        entities: [{ name: 'stone-furnace', type: 'furnace', unit_number: 582, position: { x: 4, y: 0 } }],
      })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: this.batchId, task_count: 1, task_types: ['mining'], tick: 400 + this.batchId },
        basic_operation: { last_result: { operation_id: 9, code: 'completed', completed: true } },
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      this.batchId++
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function planMessage({ chatMessage = 'Working.', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
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

class RejectingTransferRcon extends FakeRcon {
  constructor() {
    super()
    this.transferAdmissionAttempts = 0
  }

  async command(text) {
    if (text.includes('local ok,result=pcall') && text.includes("remote.call('autorio_operations','move_items_exact'")) {
      this.transferAdmissionAttempts++
      if (this.transferAdmissionAttempts === 1) {
        const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
        assert.ok(marker)
        return `${marker}${JSON.stringify({ ok: false, result: 'autorio rejected operation 1: [false,"transfer target rejected"]' })}`
      }
    }
    return super.command(text)
  }
}

test('rejected transfer cannot advance or complete the canonical plan step', async () => {
  const plan = ['Load furnace with ore and fuel', 'Retrieve 20 iron plates']
  let reply = 0
  const agent = new NpcAgentLoop({
    rcon: new RejectingTransferRcon(),
    provider: async () => {
      reply++
      if (reply === 1) {
        return {
          content: null,
          tool_calls: [{
            id: 'observe-furnace',
            type: 'function',
            function: {
              name: 'getNearbyEntities',
              arguments: JSON.stringify({ radius: 16, name: 'stone-furnace', limit: 4 }),
            },
          }],
        }
      }
      if (reply === 2) {
        return planMessage({
          chatMessage: 'Loading the observed furnace.',
          plan,
          currentStep: 0,
          operations: [{
            name: 'move_items_exact',
            args: { item_name: 'iron-ore', unit_number: 582, max_count: 20, to_entity: true },
          }],
        })
      }
      return planMessage({
        chatMessage: 'Trying to advance despite the rejected supply.',
        plan,
        currentStep: 1,
        operations: [],
      })
    },
    systemPrompt: 'NPC transfer truth test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('produce 20 iron plates', { sender: 'TTLouis' }),
    /operation batch was not replayed|operation batch|rejected operation/i,
  )
  const rejectedState = agent.memory.currentPlan('npc:airi')
  assert.equal(rejectedState.status, 'blocked')
  assert.equal(rejectedState.task_board.active_index, 0)
  assert.equal(rejectedState.task_board.completed_count, 0)
  assert.equal(rejectedState.task_board.steps[0].status, 'blocked')
  assert.equal(rejectedState.task_board.blocker, 'operation_admission_failed')

  const attemptedSkip = await agent.request('continue', { sender: 'TTLouis' })
  assert.equal(attemptedSkip.goalStatus, 'blocked')
  assert.equal(attemptedSkip.taskBoard.active_index, 0)
  assert.equal(attemptedSkip.taskBoard.completed_count, 0)
  assert.equal(attemptedSkip.taskBoard.steps[0].status, 'blocked')
  assert.equal(attemptedSkip.taskBoard.blocker, 'operation_admission_failed')
  assert.equal(attemptedSkip.operations.length, 0)
  assert.equal(agent.rcon.transferAdmissionAttempts, 1)
  assert.equal(agent.memory.currentPlan('npc:airi').current_step, 0)
})

test('durable plan survives a new agent instance and empty actions cannot pretend execution continued', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'airi-durable-plan-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const stateFile = path.join(dir, 'npc-state.json')
  const firstReplies = [
    planMessage({
      chatMessage: 'I will mine fuel first.',
      plan: ['Mine fuel', 'Load the furnace'],
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'coal', count: 5 } }],
    }),
    planMessage({
      chatMessage: 'I am going to load the furnace now.',
      plan: ['Mine fuel', 'Load the furnace'],
      currentStep: 1,
      operations: [],
    }),
    planMessage({
      chatMessage: 'I will load the furnace next.',
      plan: ['Mine fuel', 'Load the furnace'],
      currentStep: 1,
      operations: [],
    }),
  ]
  const first = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => firstReplies.shift(),
    systemPrompt: 'NPC test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile,
    traceFile: null,
  })

  const started = await first.request('prepare the furnace', { sender: 'TTLouis' })
  assert.match(started.chatMessage, /^\[Plan 1\/2\] Mine fuel/)
  assert.equal(started.taskBoard.active_step_id, 'step_1')
  assert.equal(first.active, true)

  await assert.rejects(
    first.completed(),
    /provider_action_omission_repair_failed/i,
  )
  const interrupted = first.memory.currentPlan('npc:airi')
  assert.equal(interrupted.status, 'active')
  assert.equal(interrupted.admission_status, 'action_omission_repair')
  assert.equal(interrupted.task_board.active_step_id, 'step_1')
  assert.equal(interrupted.task_board.completed_count, 0)
  assert.equal(first.active, true)

  const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
  assert.equal(saved.plans[0].state.status, 'active')
  assert.equal(saved.plans[0].state.admission_status, 'action_omission_repair')
  assert.notEqual(saved.plans[0].state.blocker, 'action_omission_after_repair')
  assert.equal(saved.plans[0].state.current_step, 0)
  assert.equal(saved.plans[0].state.task_board.total_steps, 2)
  assert.equal(saved.plans[0].state.task_board.completed_count, 0)
  assert.equal(saved.plans[0].state.task_board.evidence.some(item => item.ref === 'batch_7'), true)

  const second = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => {
      throw new Error('durable restart inspection should not need a planner call')
    },
    systemPrompt: 'NPC test prompt',
    memory: new CanonicalTaskBoardMemory(),
    stateFile,
    traceFile: null,
  })
  await second.loadPersistentState()

  const context = second.memory.planContext('npc:airi')
  assert.match(context, /\[RUNTIME_COMPAT_STATE\]/)
  assert.match(context, /\[PLANNING_STATE\]/)
  assert.doesNotMatch(context, /\[PLAN_STATE\]/)
  assert.match(context, /task_board/)
  assert.match(context, /prepare the furnace/)
  assert.match(context, /action_omission_repair/)
  assert.match(context, /Load the furnace/)
})

test('canonical task board prevents model plan-length drift from resetting visible progress', async () => {
  const canonical = ['Observe area', 'Mine ore', 'Place machine', 'Load machine', 'Verify output']
  const replies = [
    planMessage({
      chatMessage: 'Starting.',
      plan: canonical,
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
    }),
    planMessage({
      chatMessage: 'Continuing the same step.',
      plan: ['Observe area', 'Extra thought', 'Mine ore', 'Place machine', 'Load machine', 'Verify output', 'Another thought'],
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
    }),
    planMessage({
      chatMessage: 'Advancing to construction.',
      plan: canonical,
      currentStep: 2,
      operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
    }),
  ]
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => replies.shift(),
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  const first = await agent.request('build a small line', { sender: 'TTLouis' })
  assert.match(first.chatMessage, /^\[Plan 1\/5\] Observe area/)
  assert.equal(first.taskBoard.total_steps, 5)

  const second = await agent.completed()
  assert.match(second.chatMessage, /^\[Plan 1\/5\] Observe area/)
  assert.equal(second.plan.length, 5)
  assert.equal(second.taskBoard.total_steps, 5)
  assert.equal(second.taskBoard.revision >= first.taskBoard.revision, true)

  const third = await agent.completed()
  assert.match(third.chatMessage, /^\[Plan 1\/5\] Observe area/)
  assert.equal(third.taskBoard.completed_count, 0)
  assert.equal(third.taskBoard.active_step_id, 'step_1')
  assert.equal(third.taskBoard.proposed_focus_step_id, 'step_3')
})

test('Autorio errors feed detailed receipt back without silently replacing the committed suffix', async () => {
  const replies = [
    planMessage({
      chatMessage: 'Mining iron.',
      plan: ['Mine iron', 'Return to furnace'],
      currentStep: 0,
      operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 5 } }],
    }),
    planMessage({
      chatMessage: 'The patch failed, I will search again.',
      plan: ['Find another iron patch', 'Mine iron', 'Return to furnace'],
      currentStep: 0,
      operations: [{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 256 } }],
    }),
  ]
  const observed = []
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async messages => {
      observed.push(messages)
      return replies.shift()
    },
    systemPrompt: 'NPC test prompt',
    stateFile: null,
    traceFile: null,
  })

  await agent.request('get some iron', { sender: 'TTLouis' })
  const replanned = await agent.failed('mining failed: no_target; dependent operations cancelled')

  assert.equal(replanned.operations[0].name, 'walk_to_entity')
  assert.equal(replanned.taskBoard.steps[0].description, 'Mine iron')
  assert.equal(replanned.taskBoard.steps[1].description, 'Return to furnace')
  assert.equal(replanned.taskBoard.evidence.some(item => item.kind === 'operation_error_receipt'), true)
  assert.equal(agent.active, true)
  const continuation = observed[1].map(message => message.content ?? '').join('\n')
  assert.match(continuation, /\[MOD\] Autorio operation error:/)
  assert.match(continuation, /no_target/)
  assert.match(continuation, /last_completed_batch/)
})


class ActionOmissionRcon {
  constructor({ followActive = false } = {}) {
    this.status = deployment()
    this.followActive = followActive
    this.mutations = []
    this.observationCalls = 0
    this.batchId = 0
    this.lastTaskTypes = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: this.batchId > 0
          ? { batch_id: this.batchId, task_count: this.lastTaskTypes.length, task_types: this.lastTaskTypes, tick: 600 + this.batchId }
          : undefined,
      })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify(this.followActive
        ? { active: true, healthy: true, controller_live: true, state: 'following', target_player: 'TTLouis' }
        : { active: false, healthy: false, controller_live: false, state: 'idle' })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) {
      this.observationCalls++
      return JSON.stringify({
        actor_position: { x: 0, y: 0 },
        entities: [{ name: 'steel-chest', type: 'container', unit_number: 582, position: { x: 3, y: 0 } }],
      })
    }
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      this.batchId++
      if (text.includes("'place_entity'")) this.lastTaskTypes = ['placing']
      else if (text.includes("'move_items_exact'")) this.lastTaskTypes = ['moving_items']
      else if (text.includes("'mine_entity_exact'")) this.lastTaskTypes = ['mining']
      else this.lastTaskTypes = ['waiting']
      const admissions = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: admissions }, () => [true, 'Task started']) })}`
    }
    return 'tool-output'
  }
}

function toolMessage(id = 'observe-chest', radius = 16) {
  return {
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name: 'getNearbyEntities',
        arguments: JSON.stringify({ radius, name: 'steel-chest', limit: 4 }),
      },
    }],
  }
}

test('normal execution has zero action-omission provider overhead', async () => {
  const calls = []
  const agent = new NpcAgentLoop({
    rcon: new ActionOmissionRcon(),
    provider: async (messages, options) => {
      calls.push({ messages, options })
      return planMessage({
        chatMessage: 'Starting the requested wait.',
        plan: ['Wait once'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
    systemPrompt: 'Action omission normal-path test',
    stateFile: null,
    traceFile: null,
  })

  const result = await agent.request('wait once', { sender: 'TTLouis' })
  assert.equal(result.operations.length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.recoveryAttempt, 0)
  assert.equal(calls[0].options.requestBodyPatch, undefined)
})

test('strict provider recovery cannot turn its no-tools limitation into a durable world blocker', async () => {
  const plan = ['Start smelting', 'Verify at least 20 iron plates']
  let calls = 0
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async (_messages, options) => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'Starting the smelting wait.',
          plan,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        })
      }
      if (calls === 2) return { content: 'this is not valid JSON' }
      assert.equal(options.allowTools, false)
      assert.ok(options.recoveryAttempt >= 1)
      return planMessage({
        chatMessage: 'BLOCKED: I cannot issue another observation during this strict recovery turn, so I cannot confirm the plate count.',
        plan,
        currentStep: 1,
        operations: [],
      })
    },
    systemPrompt: 'Strict recovery blocker truth test',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  const started = await agent.request('smelt and verify plates', { sender: 'TTLouis' })
  assert.equal(started.operations[0].name, 'wait')

  await assert.rejects(
    agent.completed(),
    /strict recovery could not safely resolve remaining canonical work/i,
  )

  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.notEqual(state.blocker, 'provider_reported_blocker')
  assert.notEqual(state.task_board.blocker, 'provider_reported_blocker')
  assert.equal(state.task_board.steps.at(-1).description, 'Verify at least 20 iron plates')
  assert.equal(agent.rcon.mutations.length, 1)
})

test('healthy persistent runtime and explicit truthful blocker do not trigger omission repair', async () => {
  let followCalls = 0
  const followAgent = new NpcAgentLoop({
    rcon: new ActionOmissionRcon({ followActive: true }),
    provider: async () => {
      followCalls++
      return planMessage({
        chatMessage: 'Follow is already running.',
        plan: ['Keep following TTLouis'],
        currentStep: 0,
        operations: [],
      })
    },
    systemPrompt: 'Persistent runtime omission test',
    stateFile: null,
    traceFile: null,
  })
  const following = await followAgent.request('follow me', { sender: 'TTLouis' })
  assert.equal(followCalls, 1)
  assert.equal(following.goalStatus, 'active')
  assert.equal(following.persistentRuntime?.controller_live, true)

  let blockerCalls = 0
  const blockedAgent = new NpcAgentLoop({
    rcon: new ActionOmissionRcon(),
    provider: async () => {
      blockerCalls++
      return planMessage({
        chatMessage: 'BLOCKED: required capability is unavailable in the current runtime.',
        plan: ['Use the unavailable capability'],
        currentStep: 0,
        operations: [],
      })
    },
    systemPrompt: 'Explicit blocker omission test',
    stateFile: null,
    traceFile: null,
  })
  const blocked = await blockedAgent.request('use that capability', { sender: 'TTLouis' })
  assert.equal(blockerCalls, 1)
  assert.equal(blocked.goalStatus, 'paused')
  assert.equal(blocked.taskBoard.blocker, '')
  assert.match(blocked.chatMessage, /recoverable provider failure/i)
  assert.match(blocked.chatMessage, /required capability is unavailable/)
  assert.equal(blockedAgent.rcon.mutations.length, 0)
})

test('completed observation followed by prose-only intent gets exactly one cheap act-or-block repair', async () => {
  const calls = []
  let reply = 0
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (messages, options) => {
      calls.push({ messages, options })
      reply++
      if (reply === 1) return toolMessage()
      if (reply === 2) {
        return planMessage({
          chatMessage: 'I found the chest. I will take the plates and continue.',
          plan: ['Take plates from the observed chest'],
          currentStep: 0,
          operations: [],
        })
      }
      return planMessage({
        chatMessage: 'Taking the plates from the observed chest now.',
        plan: ['Take plates from the observed chest'],
        currentStep: 0,
        operations: [{
          name: 'move_items_exact',
          args: { item_name: 'iron-plate', unit_number: 582, max_count: 10, to_entity: false },
        }],
      })
    },
    systemPrompt: 'Observed-action omission test',
    stateFile: null,
    traceFile: null,
  })

  const result = await agent.request('take ten iron plates from that chest', { sender: 'TTLouis' })
  assert.equal(calls.length, 3)
  assert.equal(rcon.observationCalls, 1)
  assert.equal(result.operations[0].name, 'move_items_exact')
  assert.equal(rcon.mutations.length, 1)
  assert.equal(calls[2].options.recoveryAttempt, 1)
  assert.deepEqual(calls[2].options.requestBodyPatch, { max_tokens: 700 })
  assert.equal(calls[2].options.recoveryKind, undefined)
  const repairContext = calls[2].messages.map(message => message.content ?? '').join('\n')
  assert.match(repairContext, /Finite canonical work remains/)
  assert.match(repairContext, /no executable operation was submitted/)
})

test('repeated prose-only omission fails upward without inventing a durable world blocker', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      calls++
      return planMessage({
        chatMessage: calls === 1 ? 'I will take the items now.' : 'I am about to take the items.',
        plan: ['Take items'],
        currentStep: 0,
        operations: [],
      })
    },
    systemPrompt: 'Repeated omission test',
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('take the items', { sender: 'TTLouis' }),
    /provider_action_omission_repair_failed/i,
  )
  assert.equal(calls, 2)
  assert.equal(rcon.mutations.length, 0)
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.admission_status, 'action_omission_repair')
  assert.notEqual(state.blocker, 'action_omission_after_repair')
  assert.notEqual(state.task_board.blocker, 'action_omission_after_repair')
  assert.equal(state.plan[0], 'Take items')
  assert.equal(state.current_step, 0)
})

test('invalid provider JSON during action-omission repair fails upward without a durable world blocker', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'I will verify the result next.',
          plan: ['Verify the result'],
          currentStep: 0,
          operations: [],
        })
      }
      return { content: 'this is not valid JSON' }
    },
    systemPrompt: 'Invalid omission repair JSON test',
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('verify the result', { sender: 'TTLouis' }),
    /Invalid provider content JSON/i,
  )

  assert.equal(calls, 5)
  assert.equal(rcon.mutations.length, 0)
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.admission_status, 'action_omission_repair')
  assert.notEqual(state.blocker, 'action_omission_after_repair')
  assert.notEqual(state.task_board.blocker, 'action_omission_after_repair')
})

test('one genuinely missing mutable fact gets one targeted observation, then action is required', async () => {
  let calls = 0
  const optionsSeen = []
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (_messages, options) => {
      calls++
      optionsSeen.push(options)
      if (calls === 1) {
        return planMessage({
          chatMessage: 'I need the chest identity before transferring.',
          plan: ['Identify chest', 'Take plates'],
          currentStep: 0,
          operations: [],
        })
      }
      if (calls === 2) return toolMessage('targeted-chest')
      return planMessage({
        chatMessage: 'The missing identity is known; taking the plates now.',
        plan: ['Identify chest', 'Take plates'],
        currentStep: 0,
        operations: [{
          name: 'move_items_exact',
          args: { item_name: 'iron-plate', unit_number: 582, max_count: 5, to_entity: false },
        }],
      })
    },
    systemPrompt: 'One-observation omission test',
    stateFile: null,
    traceFile: null,
  })

  const result = await agent.request('get five plates from the chest', { sender: 'TTLouis' })
  assert.equal(calls, 3)
  assert.equal(rcon.observationCalls, 1)
  assert.equal(optionsSeen[1].allowTools, true)
  assert.equal(optionsSeen[2].allowTools, false)
  assert.equal(result.operations[0].name, 'move_items_exact')
})

test('repair cannot loop on a duplicate or second observation', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'I need one current fact.',
          plan: ['Use observed chest'],
          currentStep: 0,
          operations: [],
        })
      }
      return toolMessage(`observation-${calls}`)
    },
    systemPrompt: 'Observation-loop omission test',
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('use the chest', { sender: 'TTLouis' }),
    /provider_action_omission_repair_failed/i,
  )
  assert.equal(calls, 3)
  assert.equal(rcon.observationCalls, 1)
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.notEqual(state.task_board.blocker, 'action_omission_after_repair')
  assert.equal(rcon.mutations.length, 0)
})

test('omission repair preserves goal id, verified prefix, and active canonical step', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'Placing the first machine.',
          plan: ['Place first machine', 'Continue setup'],
          currentStep: 0,
          operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 5 } }],
        })
      }
      if (calls === 2) {
        return planMessage({
          chatMessage: 'The first placement is verified. I will continue setup.',
          plan: ['Place first machine', 'Continue setup'],
          currentStep: 1,
          operations: [],
        })
      }
      return planMessage({
        chatMessage: 'Continuing setup now.',
        plan: ['Place first machine', 'Continue setup'],
        currentStep: 1,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
    systemPrompt: 'Canonical preservation omission test',
    stateFile: null,
    traceFile: null,
  })

  const first = await agent.request('set up two steps', { sender: 'TTLouis' })
  const goalId = first.goalId
  const proof = {
    kind: 'deterministic_verification',
    ref: 'fixture_verified_step_1',
    summary: 'Fixture proof for the already-verified first canonical step.',
  }
  memory.recordBoardEvidence?.('npc:airi', proof)
  const reduced = memory.applyOutcomeAuthority?.('npc:airi', {
    kind: 'verified_complete',
    source: 'deterministic_runtime',
    reason_code: 'fixture_verified_prefix',
    evidence: [proof],
    metadata: { scope: 'step' },
  })
  assert.equal(reduced?.decision?.accepted, true)
  assert.equal(memory.currentPlan('npc:airi').task_board.completed_count, 1)

  const continued = await agent.request('continue setup', { sender: 'TTLouis' })
  assert.equal(calls, 3)
  assert.equal(continued.goalId, goalId)
  assert.equal(continued.taskBoard.completed_count, 1)
  assert.equal(continued.taskBoard.active_index, 1)
  assert.equal(continued.taskBoard.steps[0].status, 'completed')
  assert.equal(continued.taskBoard.steps[1].description, 'Continue setup')
  assert.equal(continued.operations[0].name, 'wait')
})

test('interrupted omission recovery uses a compact capsule instead of replaying unrelated dialogue', async () => {
  let calls = 0
  const memory = new CanonicalTaskBoardMemory()
  memory.remember('npc:airi', 99, {
    sender: 'Old chat',
    user: 'unrelated ancient chatter that must not be replayed',
    assistant: 'unrelated old answer',
    operations: [],
  })
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'I will do the next action.',
          plan: ['Perform current action'],
          currentStep: 0,
          operations: [],
        })
      }
      throw new Error('simulated provider interruption during omission repair')
    },
    systemPrompt: 'Compact recovery capsule test',
    stateFile: null,
    traceFile: null,
  })

  await assert.rejects(
    agent.request('perform the current action', { sender: 'TTLouis' }),
    /simulated provider interruption/,
  )
  const interrupted = memory.currentPlan('npc:airi')
  assert.equal(interrupted.status, 'active')
  assert.equal(interrupted.admission_status, 'action_omission_repair')
  const goalId = interrupted.goal_id
  interrupted.exact_target_audit = [{
    unit_number: 999,
    operation_name: 'move_items_exact',
    locator: { name: 'steel-chest', position: { x: 3, y: 0 }, role: 'Perform current action' },
    recorded_at: Date.now(),
  }]

  let resumedMessages
  agent.provider = async (messages) => {
    resumedMessages = messages
    return planMessage({
      chatMessage: 'BLOCKED: the required live capability is still unavailable.',
      plan: ['Perform current action'],
      currentStep: 0,
      operations: [],
    })
  }
  const resumed = await agent.request('continue', { sender: 'TTLouis' })
  const context = resumedMessages.map(message => message.content ?? '').join('\n')
  assert.match(context, /\[ACTION_OMISSION_RECOVERY\]/)
  assert.match(context, /"reason":"action_omission_recovery"/)
  assert.doesNotMatch(context, /unrelated ancient chatter/)
  assert.doesNotMatch(context, /Recent dialogue:/)
  assert.doesNotMatch(context, /999/)
  assert.match(context, /historical unit_number values are non-executable/)
  assert.match(context, /remaining_steps/)
  assert.equal(resumed.goalId, goalId)
  assert.equal(resumed.goalStatus, 'paused')
  assert.equal(resumed.taskBoard.blocker, '')
  assert.match(resumed.chatMessage, /recoverable provider failure/i)
  assert.match(resumed.chatMessage, /required live capability is still unavailable/)
  assert.equal(rcon.mutations.length, 0)
})


test('pre-plan observation decision pressure closes tools without manufacturing a recovery attempt', async () => {
  let calls = 0
  const optionsSeen = []
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async (_messages, options) => {
      calls++
      optionsSeen.push(options)
      if (calls <= 4) return toolMessage(`preplan-observe-${calls}`, 15 + calls)
      return planMessage({
        chatMessage: 'Taking the grounded next action now.',
        plan: ['Take the needed plates'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
    systemPrompt: 'Pre-plan observation pressure test',
    stateFile: null,
    traceFile: null,
  })

  const result = await agent.request('inspect the chest and take the needed plates', { sender: 'TTLouis' })
  assert.equal(calls, 5)
  assert.equal(rcon.observationCalls, 4)
  assert.equal(optionsSeen.at(-1).allowTools, false)
  assert.equal(optionsSeen.at(-1).recoveryAttempt, 0)
  assert.equal(optionsSeen.at(-1).requestBodyPatch, undefined)
  assert.equal(result.operations[0].name, 'wait')
})


test('verified completion can close before a trailing control-only Stop step', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const plan = ['Place the requested furnace', 'Stop']
  const agent = new NpcAgentLoop({
    rcon,
    // The receipt proves the placement ran; closing this prose-only step is
    // the Main LLM's judgment, so the planner confirms it on the next turn.
    provider: async () => {
      calls++
      if (calls > 1) {
        return planMessage({ chatMessage: 'The requested furnace is placed.', plan: [], currentStep: 0, operations: [] })
      }
      return planMessage({
        chatMessage: 'Placing the requested furnace.',
        plan,
        currentStep: 0,
        operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 5 } }],
      })
    },
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    systemPrompt: 'Trailing control-only completion regression test',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  const started = await agent.request('place the furnace, then stop', { sender: 'TTLouis' })
  assert.equal(started.operations.length, 1)
  assert.equal(started.taskBoard.total_steps, 1)
  assert.equal(started.taskBoard.steps.some(step => step.description === 'Stop'), false)

  const finished = await agent.completed()
  assert.equal(calls, 2)
  assert.equal(finished.goalStatus, 'completed')
  assert.equal(finished.operations.length, 0)
  assert.equal(agent.memory.currentPlan('npc:airi'), undefined)
  assert.equal(rcon.mutations.length, 1)
})

test('verified completion can close before a trailing Report completion control-only step', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const plan = ['Place the requested furnace', 'Report completion']
  const agent = new NpcAgentLoop({
    rcon,
    // The receipt proves the placement ran; closing this prose-only step is
    // the Main LLM's judgment, so the planner confirms it on the next turn.
    provider: async () => {
      calls++
      if (calls > 1) {
        return planMessage({ chatMessage: 'The requested furnace is placed.', plan: [], currentStep: 0, operations: [] })
      }
      return planMessage({
        chatMessage: 'Placing the requested furnace.',
        plan,
        currentStep: 0,
        operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 5 } }],
      })
    },
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    systemPrompt: 'Trailing report-completion regression test',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  const started = await agent.request('place the furnace, then report completion', { sender: 'TTLouis' })
  assert.equal(started.operations.length, 1)
  assert.equal(started.taskBoard.total_steps, 1)
  assert.equal(started.taskBoard.steps.some(step => step.description === 'Report completion'), false)

  const finished = await agent.completed()
  assert.equal(calls, 2)
  assert.equal(finished.goalStatus, 'completed')
  assert.equal(finished.operations.length, 0)
  assert.equal(agent.memory.currentPlan('npc:airi'), undefined)
  assert.equal(rcon.mutations.length, 1)
})

test('verified final completion is not mistaken for an action omission', async () => {
  let calls = 0
  const rcon = new ActionOmissionRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => {
      calls++
      if (calls === 1) {
        return planMessage({
          chatMessage: 'Placing the requested furnace.',
          plan: ['Place the furnace'],
          currentStep: 0,
          operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 4, y: 5 } }],
        })
      }
      return planMessage({
        chatMessage: 'The requested furnace is placed and verified.',
        plan: [],
        currentStep: 0,
        operations: [],
      })
    },
    systemPrompt: 'Verified final completion omission test',
    interactionDecisionProvider: completionAndContinueDecision,
    decisionTraceFile: null,
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  const started = await agent.request('place one furnace', { sender: 'TTLouis' })
  assert.equal(started.operations[0].name, 'place_entity')
  const finished = await agent.completed()
  assert.equal(calls, 2)
  assert.equal(finished.goalStatus, 'completed')
  assert.equal(rcon.mutations.length, 1)
  assert.equal(finished.operations.length, 0)
  assert.equal(agent.memory.currentPlan('npc:airi'), undefined)
  assert.match(agent.memory.context('npc:airi'), /place one furnace|requested furnace/i)

  await agent.finalizeCompletedTaskContext()
  assert.equal(agent.active, false)
  assert.equal(agent.messages.length, 0)
  assert.equal(agent.baseMessages.length, 0)
  const resetContext = agent.memory.context('npc:airi')
  assert.match(resetContext, /\[RUNTIME_COMPAT_STATE\] No active compatibility task/)
  assert.doesNotMatch(resetContext, /\[PLANNING_STATE\]/)
  assert.doesNotMatch(resetContext, /place one furnace|requested furnace/i)
})


test('strict runtime plan surface rejects retired project hierarchy payloads', () => {
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory: new CanonicalTaskBoardMemory(),
    npcId: 'airi',
    systemPrompt: 'retired project hierarchy parse test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('unused') },
  })
  assert.throws(() => agent.parsePlanMessage({
    content: JSON.stringify({
      chatMessage: 'Starting with burner production.',
      project: {
        currentMilestone: {
          title: 'Establish burner production',
          completionSummary: 'Stable early iron and copper production is available.',
        },
        nextMilestones: [{ title: 'Reach Automation' }],
        developmentDirection: 'vertical',
      },
      plan: ['Gather stone for the first furnaces'],
      currentStep: 0,
      operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 20, search_radius: 256 } }],
    }),
  }), /Unexpected argument/)
})

test('ordinary short-task responses remain backward compatible without project hierarchy', () => {
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory: new CanonicalTaskBoardMemory(),
    npcId: 'airi',
    systemPrompt: 'project hierarchy compatibility test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('unused') },
  })
  const parsed = agent.parsePlanMessage(planMessage({
    chatMessage: 'Gathering stone.',
    plan: ['Gather 20 stone'],
    currentStep: 0,
    operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 20, search_radius: 256 } }],
  }))
  assert.equal(parsed.project, undefined)
  assert.equal(parsed.plan[0], 'Gather 20 stone')
})


test('retired hierarchy trigger labels do not reintroduce a project payload requirement', () => {
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory: new CanonicalTaskBoardMemory(),
    npcId: 'airi',
    systemPrompt: 'retired hierarchy trigger compatibility test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('unused') },
  })

  for (const triggerSource of ['hierarchy_initial_split', 'hierarchy_split', 'hierarchy_replan_project', 'hierarchy_advance']) {
    agent.reasoningTriggerSource = triggerSource
    assert.doesNotThrow(() => agent.parsePlanMessage(planMessage({
      chatMessage: 'Using the strict flat plan surface.',
      plan: ['Do one bounded unit of work'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    })))
  }
})


test('runtime accepts a semantic checkpoint proposal beside the strict plan surface', () => {
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory: new CanonicalTaskBoardMemory(),
    npcId: 'airi',
    systemPrompt: 'semantic checkpoint parse test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('unused') },
  })

  const parsed = agent.parsePlanMessage({
    content: JSON.stringify({
      chatMessage: 'Gathering the remaining stone.',
      checkpoint: {
        mode: 'all',
        requirements: [
          { id: 'stone_total', kind: 'inventory_count', item_name: 'stone', minimum: 100 },
        ],
      },
      plan: ['Ensure I have at least 100 stone'],
      currentStep: 0,
      operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 40, search_radius: 512 } }],
    }),
  })

  assert.equal(parsed.checkpoint.source, 'planner_semantic_checkpoint')
  assert.equal(parsed.checkpoint.requirements[0].minimum, 100)
  assert.equal(parsed.operations[0].args.count, 40)
})

test('runtime rejects unsupported planner checkpoint semantics instead of trusting prose-like predicates', () => {
  const agent = new NpcAgentLoop({
    rcon: new FakeRcon(),
    memory: new CanonicalTaskBoardMemory(),
    npcId: 'airi',
    systemPrompt: 'semantic checkpoint rejection test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    provider: async () => { throw new Error('unused') },
  })

  assert.throws(() => agent.parsePlanMessage({
    content: JSON.stringify({
      chatMessage: 'Looks done.',
      checkpoint: {
        mode: 'all',
        requirements: [{ id: 'guess', kind: 'natural_language', predicate: 'enough stone' }],
      },
      plan: ['Get enough stone'],
      currentStep: 0,
      operations: [{ name: 'gather_resource', args: { resource_name: 'stone', count: 40, search_radius: 512 } }],
    }),
  }), /runtime-supported semantic completion contract/i)
})


test('tool-native submitPlan lets assistant content stay natural language on the normal path', async () => {
  const rcon = new FakeRcon()
  const agent = new NpcAgentLoop({
    rcon,
    provider: async () => ({
      content: 'I am mining one iron ore now.',
      tool_calls: [{
        id: 'submit-plan-1',
        type: 'function',
        function: {
          name: 'submitPlan',
          arguments: JSON.stringify({
            plan: ['Mine one iron ore'],
            currentStep: 0,
            operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
          }),
        },
      }],
    }),
    systemPrompt: 'tool-native planner control test',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })

  const result = await agent.request('mine one iron ore', { sender: 'TTLouis' })

  assert.match(result.chatMessage, /I am mining one iron ore now/)
  assert.deepEqual(result.plan, ['Mine one iron ore'])
  assert.equal(result.operations[0].name, 'mine_entity')
  assert.equal(rcon.mutations.length, 1)
  assert.equal(agent.memory.byNpc.get('npc:airi').recent.at(-1).assistant, 'I am mining one iron ore now.')
})


// These drive the WHOLE live path -- provider tool call, submitPlan parse, plan
// surface, memory adapter, reducer -- because the bug being fixed here was never
// a reducer bug. ROADMAP_REVISED had a correct handler and passing unit tests
// the entire time; nothing in the running agent emitted it, so the Roadmap Shelf
// was empty in production and a reducer-level test stayed green throughout.
// Asserting on `memory.planningState(...).roadmap` is the point: it is non-null
// only if the live path actually reached the reducer.
function roadmapSubmissionAgent(roadmap) {
  return new NpcAgentLoop({
    rcon: new FakeRcon(),
    provider: async () => ({
      content: 'Starting on early smelting.',
      tool_calls: [{
        id: 'submit-plan-roadmap',
        type: 'function',
        function: {
          name: 'submitPlan',
          arguments: JSON.stringify({
            plan: ['Mine one iron ore'],
            currentStep: 0,
            operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
            roadmap,
          }),
        },
      }],
    }),
    systemPrompt: 'roadmap shelf live path test',
    memory: new CanonicalTaskBoardMemory(),
    stateFile: null,
    traceFile: null,
  })
}

test('planner roadmap guidance reaches the Roadmap Shelf through the live path', async () => {
  const agent = roadmapSubmissionAgent([
    { id: 'roadmap_early_smelting', intent: 'establish reliable early iron and copper smelting', why_it_matters: 'everything downstream needs plates' },
    { id: 'roadmap_red_science', intent: 'sustain red science production', depends_on: ['roadmap_early_smelting'] },
  ])

  await agent.request('build toward a rocket-capable factory', { sender: 'TTLouis' })

  const planning = agent.memory.planningState('npc:airi')
  assert.ok(planning?.roadmap, 'the live path must actually populate the shelf, not merely be able to')
  assert.deepEqual(planning.roadmap.nodes.map(node => node.id), ['roadmap_early_smelting', 'roadmap_red_science'])
  assert.equal(planning.roadmap.nodes[0].intent, 'establish reliable early iron and copper smelting')
  assert.deepEqual(planning.roadmap.nodes[1].depends_on, ['roadmap_early_smelting'])
  assert.equal(planning.roadmap.goal_id, planning.goal.goal_id)
  // The Main LLM authored the nodes; what let the shelf move is the user's own
  // objective at LOD 1 -- not the runtime, and not the planner's preference.
  assert.equal(planning.roadmap.authority, 'user')
  // Lineage exists from the first revision onward (roadmap 10).
  assert.equal(planning.roadmap.nodes[0].first_seen_revision_id, planning.roadmap.roadmap_revision_id)
})

test('shelf nodes stay non-executable across the live path', async () => {
  const agent = roadmapSubmissionAgent([{
    id: 'roadmap_smuggled_plan',
    intent: 'establish reliable early iron and copper smelting',
    status: 'realized',
    steps: ['Mine 20 iron ore', 'Craft a stone furnace'],
    operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 20 } }],
  }])

  await agent.request('build toward a rocket-capable factory', { sender: 'TTLouis' })

  const node = agent.memory.planningState('npc:airi')?.roadmap?.nodes?.[0]
  assert.ok(node)
  assert.equal(node.steps, undefined)
  assert.equal(node.operations, undefined)
  assert.equal(JSON.stringify(node).includes('stone furnace'), false)
  // Stripped visibly, not silently: the shelf records that an executable
  // payload was removed, so the attempt is inspectable rather than lost.
  assert.deepEqual(node.dropped_executable_fields, ['steps', 'operations'])
  // The asserted `realized` is discarded: realization rests on verified plan
  // results, and the status the shelf shows is the one readiness derived (the
  // node declares no dependencies, so it is refinable, not done).
  assert.equal(node.status, 'ready_to_refine')
})
