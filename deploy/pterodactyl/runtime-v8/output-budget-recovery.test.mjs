import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, normalizedProviderUsage } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'

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
    this.batchId = 0
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(this.status)
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: {
          batch_id: this.batchId,
          task_count: 1,
          task_types: ['waiting'],
          tick: 500 + this.batchId,
        },
        basic_operation: { last_result: { operation_id: this.batchId, code: 'completed', completed: true } },
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

function planMessage({ chatMessage = '', plan = [], currentStep = 0, operations = [] } = {}) {
  return { content: JSON.stringify({ chatMessage, plan, currentStep, operations }) }
}

function exhaustedMessage() {
  const message = { content: '' }
  Object.defineProperty(message, '_airiProvider', {
    enumerable: false,
    value: {
      diagnostic_code: 'provider_output_budget_exhausted',
      output_budget_exhausted: true,
      finish_reason: 'length',
      content_chars: 0,
      tool_call_count: 0,
      reasoning_content_chars: 2000,
      usage: { prompt_tokens: 100, completion_tokens: 2000, total_tokens: 2100 },
    },
  })
  return message
}

function makeAgent({
  provider,
  rcon = new FakeRcon(),
  reserve = async () => ({}),
  interactionDecisionProvider,
  maxProviderOutputUnits,
  maxProviderBudgetHandoffs,
  memory = new CanonicalTaskBoardMemory(),
} = {}) {
  return new NpcAgentLoop({
    rcon,
    provider,
    reserve,
    interactionDecisionProvider,
    maxProviderOutputUnits,
    maxProviderBudgetHandoffs,
    memory,
    systemPrompt: 'NPC output-budget recovery test prompt',
    stateFile: null,
    traceFile: null,
    maxRecoveryAttempts: 2,
  })
}

test('provider-budget exhaustion uses one compact retry per generation and respects the fresh-generation handoff limit', async () => {
  const calls = []
  const rcon = new FakeRcon()
  let reserves = 0
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const agent = makeAgent({
    rcon,
    reserve: async () => { reserves++; return {} },
    maxProviderBudgetHandoffs: 1,
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Waiting first.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }
      return exhaustedMessage()
    },
  })

  await agent.request('run the bounded recovery check', { sender: 'TTLouis' })
  assert.equal(rcon.mutations.length, 1)
  const result = await agent.completed()

  assert.equal(calls.length, 5)
  assert.equal(reserves, 5)
  assert.equal(calls[1].context.recoveryKind, undefined)
  assert.equal(calls[2].context.recoveryAttempt, 1)
  assert.equal(calls[2].context.recoveryKind, 'output_budget_exhaustion')
  assert.equal(calls[3].context.triggerSource, 'recovery_continue_low')
  assert.equal(calls[4].context.recoveryAttempt, 1)
  assert.equal(calls[4].context.recoveryKind, 'output_budget_exhaustion')
  assert.match(calls[4].messages.at(-1).content, /immediately preceding provider response exhausted its output budget/)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(rcon.mutations.length, 1)
  assert.equal(rcon.mutations.filter(text => text.includes("'wait'")).length, 1)
})

test('cross-layer provider bodies switch high reasoning exhaustion to one no-reasoning recovery that succeeds', async () => {
  const bodies = []
  let httpCalls = 0
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    httpCalls++
    if (httpCalls === 1) {
      return new Response(JSON.stringify({
        id: 'budget-hit',
        model: 'deepseek-flash',
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'r'.repeat(2048) } }],
        usage: { prompt_tokens: 100, completion_tokens: 4000, total_tokens: 4100, completion_tokens_details: { reasoning_tokens: 4000 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      id: 'budget-recovered',
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        chatMessage: 'Recovered with a bounded executable plan.',
        plan: ['Wait once'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, completion_tokens_details: { reasoning_tokens: 0 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const provider = (messages, context) => providerRequest({
    base: 'https://gateway.example/v1',
    key: 'test-key',
    model: 'deepseek-flash',
    profile: 'deepseek',
    timeoutMs: 5000,
  }, messages, { ...context, fetchImpl })

  const agent = makeAgent({ provider })
  const result = await agent.request('plan one safe step', { sender: 'TTLouis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0].reasoning_effort, 'high')
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' })
  assert.equal(bodies[0].max_tokens, 4000)
  assert.equal(bodies[1].reasoning_effort, 'none')
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' })
  assert.equal(bodies[1].max_tokens, 1000)
})

test('usage normalization keeps unknown distinct and separates cached/reasoning/visible output', () => {
  assert.deepEqual(normalizedProviderUsage({
    prompt_tokens: 1000,
    completion_tokens: 500,
    total_tokens: 1500,
    prompt_tokens_details: { cached_tokens: 700 },
    completion_tokens_details: { reasoning_tokens: 400 },
  }), {
    input_units: 1000,
    cached_input_units: 700,
    cache_miss_input_units: 300,
    output_units: 500,
    visible_output_units: 100,
    reasoning_output_units: 400,
    total_units: 1500,
    usage_complete: true,
  })
  const malformed = normalizedProviderUsage({
    prompt_tokens: 10.5,
    completion_tokens: -1,
    total_tokens: Number.MAX_SAFE_INTEGER + 10,
    prompt_tokens_details: { cached_tokens: 99 },
  })
  assert.equal(malformed.input_units, undefined)
  assert.equal(malformed.output_units, undefined)
  assert.equal(malformed.total_units, undefined)
  assert.equal(malformed.usage_complete, false)
})

test('output-budget recovery keeps the canonical Task Board at the evidenced step and does not replay the completed mutation', async () => {
  const canonical = ['Wait for the machine cycle', 'Mine ore', 'Verify output']
  const calls = []
  const rcon = new FakeRcon()
  let reserves = 0
  const agent = makeAgent({
    rcon,
    reserve: async () => { reserves++; return {} },
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Waiting for one machine cycle.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }
      if (calls.length === 2) return exhaustedMessage()

      assert.equal(context.recoveryKind, 'output_budget_exhaustion')
      assert.equal(context.allowTools, true)
      const stateDuringRecovery = agent.memory.currentPlan('npc:airi')
      assert.deepEqual(stateDuringRecovery.plan, canonical)
      assert.equal(stateDuringRecovery.task_board.active_index, 0)
      assert.equal(stateDuringRecovery.task_board.total_steps, 3)
      assert.equal(stateDuringRecovery.task_board.evidence.at(-1).kind, 'operation_receipt')
      assert.equal(stateDuringRecovery.task_board.evidence.some(item => item.kind === 'deterministic_verification'), false)
      assert.equal(agent.memory.byNpc.get('npc:airi').recent.at(-1).assistant, 'Waiting for one machine cycle.')

      return planMessage({
        chatMessage: 'I will mine the ore next.',
        plan: ['Mine ore'],
        currentStep: 0,
        operations: [{ name: 'mine_entity', args: { entity_name: 'iron-ore', count: 1 } }],
      })
    },
  })

  const first = await agent.request('run the three-step production check', { sender: 'TTLouis' })
  assert.equal(first.taskBoard.active_index, 0)
  assert.equal(rcon.mutations.length, 1)

  const continued = await agent.completed()

  assert.equal(calls.length, 3)
  assert.equal(reserves, 3)
  assert.equal(continued.goalStatus, 'active')
  assert.deepEqual(continued.plan, canonical)
  assert.equal(continued.currentStep, 0)
  assert.equal(continued.taskBoard.active_index, 0)
  assert.equal(continued.taskBoard.active_step_id, 'step_1')
  assert.equal(continued.taskBoard.total_steps, 3)
  assert.equal(continued.taskBoard.evidence.some(item => item.kind === 'deterministic_verification'), false)

  assert.equal(rcon.mutations.length, 2)
  assert.equal(rcon.mutations.filter(text => text.includes("'wait'")).length, 1)
  assert.equal(rcon.mutations.filter(text => text.includes("'mine_entity'")).length, 1)
  assert.equal(agent.traceRequest.usage.provider_calls, 3)
  assert.equal(agent.messages.some(message => String(message.content ?? '').includes('immediately preceding provider response exhausted its output budget')), false)
})

test('output-budget recovery with no fresh evidence does not invent a durable world blocker', async () => {
  const canonical = ['Inspect the crash-site wreck', 'Build the coal bootstrap', 'Verify coal']
  const calls = []
  const rcon = new FakeRcon()
  const agent = makeAgent({
    rcon,
    provider: async (_messages, context) => {
      calls.push(context)
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Checking the crash-site wreck before committing to a bootstrap plan.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        })
      }
      if (calls.length === 2) return exhaustedMessage()
      assert.equal(context.allowTools, true)
      assert.equal(context.recoveryKind, 'output_budget_exhaustion')
      return planMessage({
        chatMessage: 'I still need a grounded next action.',
        plan: canonical,
        currentStep: 0,
        operations: [],
      })
    },
  })

  await agent.request('build a small working coal production setup', { sender: 'TTLouis' })

  await assert.rejects(
    agent.completed(),
    /provider_output_budget_exhausted: bounded output-budget recovery produced no fresh world evidence/i,
  )

  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.task_board.status, 'active')
  assert.equal(state.task_board.active_index, 0)
  assert.deepEqual(state.plan, canonical)
  assert.notEqual(state.blocker, 'output_budget_recovery_no_operation')
  assert.notEqual(state.task_board.blocker, 'output_budget_recovery_no_operation')
})

test('output-budget recovery rejects replay of a completed mutation before admission and falls through the bounded recovery path', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const calls = []
  const rcon = new FakeRcon()
  const agent = makeAgent({
    rcon,
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Waiting first.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }
      if (calls.length === 2) return exhaustedMessage()
      if (calls.length === 3) {
        assert.equal(context.allowTools, true)
        assert.equal(context.recoveryKind, 'output_budget_exhaustion')
        return planMessage({
          chatMessage: 'I will wait again.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }

      assert.equal(context.allowTools, false)
      assert.equal(context.recoveryKind, undefined)
      const boundedRecoveryContext = messages.map(message => message.content ?? '').join('\n')
      assert.match(boundedRecoveryContext, /attempted to replay a completed world mutation/)
      return planMessage({
        chatMessage: 'I will not replay the completed wait.',
        plan: canonical,
        currentStep: 0,
        operations: [],
      })
    },
  })

  await agent.request('run the safe two-step check', { sender: 'TTLouis' })
  assert.equal(rcon.mutations.length, 1)

  await assert.rejects(
    agent.completed(),
    /Provider strict recovery could not safely resolve remaining canonical work/i,
  )

  assert.equal(calls.length, 4)
  assert.equal(rcon.mutations.length, 1)
  assert.equal(rcon.mutations.filter(text => text.includes("'wait'")).length, 1)
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'active')
  assert.equal(state.task_board.status, 'active')
  assert.equal(state.task_board.active_index, 0)
  assert.deepEqual(state.plan, canonical)
  assert.notEqual(state.blocker, 'provider_reported_blocker')
  assert.notEqual(state.blocker, 'recovery_no_operation')
})

test('empty recovery content cannot retire an active canonical Task Board without evidence', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result', 'Finish']
  const replies = [
    planMessage({
      chatMessage: 'Waiting first.',
      plan: canonical,
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 60 } }],
    }),
    exhaustedMessage(),
    planMessage({
      chatMessage: 'Everything is done.',
      plan: [],
      currentStep: 0,
      operations: [],
    }),
  ]
  const agent = makeAgent({ provider: async () => replies.shift() })

  await agent.request('finish this safely', { sender: 'TTLouis' })
  await assert.rejects(
    agent.completed(),
    /provider_output_budget_exhausted: bounded output-budget recovery produced no fresh world evidence/i,
  )

  const durable = agent.memory.currentPlan('npc:airi')
  assert.ok(durable)
  assert.equal(durable.status, 'active')
  assert.deepEqual(durable.plan, canonical.slice(0, 2))
  assert.equal(durable.current_step, 0)
  assert.equal(durable.task_board.status, 'active')
  assert.equal(durable.task_board.active_index, 0)
  assert.equal(durable.task_board.total_steps, 2)
  assert.equal(durable.task_board.evidence.some(item => item.kind === 'deterministic_verification'), false)
  assert.notEqual(durable.blocker, 'output_budget_recovery_no_operation')
})

test('cached recovery observation does not count as fresh world evidence', async () => {
  const agent = makeAgent({ provider: async () => planMessage() })
  agent.active = true
  agent.epoch = deployment()
  agent.messages = []
  agent.outputBudgetRecoveryGuard = {
    goal_id: 'goal_test',
    world_evidence_observed: false,
    fresh_tool_evidence: false,
    completed_operations: ['wait {"ticks":60}'],
  }

  const message = {
    content: null,
    tool_calls: [{
      id: 'cached-actor-status',
      type: 'function',
      function: { name: 'getActorStatus', arguments: '{}' },
    }],
  }
  const prepared = agent.prepareToolBatch(message)
  agent.toolCache.set(prepared[0].signature, '{"actor":{"actor_id":18}}')

  await agent.handleToolBatch(message, prepared)

  assert.equal(agent.outputBudgetRecoveryGuard.world_evidence_observed, false)
  assert.equal(agent.outputBudgetRecoveryGuard.fresh_tool_evidence, false)
  assert.match(agent.messages.at(-1).content, /Duplicate observation suppressed/)
})

test('runtime-static prototype cache does not count as fresh world evidence', async () => {
  const agent = makeAgent({ provider: async () => planMessage() })
  agent.active = true
  agent.epoch = deployment()
  agent.messages = []
  agent.outputBudgetRecoveryGuard = {
    goal_id: 'goal_test',
    world_evidence_observed: false,
    fresh_tool_evidence: false,
    completed_operations: ['wait {"ticks":60}'],
  }

  const message = {
    content: null,
    tool_calls: [{
      id: 'static-prototype',
      type: 'function',
      function: { name: 'getPrototypeDetails', arguments: '{"name":"stone-furnace"}' },
    }],
  }
  const prepared = agent.prepareToolBatch(message)
  agent.staticPrototypeCache.set(prepared[0].signature, {
    name: 'stone-furnace',
    raw: '{"name":"stone-furnace"}',
    facts: { name: 'stone-furnace' },
  })

  await agent.handleToolBatch(message, prepared)

  assert.equal(agent.outputBudgetRecoveryGuard.world_evidence_observed, false)
  assert.equal(agent.outputBudgetRecoveryGuard.fresh_tool_evidence, false)
})

test('fresh observation still cannot authorize replay of an already completed mutation', () => {
  const agent = makeAgent({ provider: async () => planMessage() })
  agent.outputBudgetRecoveryGuard = {
    goal_id: 'goal_test',
    world_evidence_observed: true,
    fresh_tool_evidence: true,
    completed_operations: ['wait {"ticks":60}'],
  }

  assert.throws(() => agent.parsePlanMessage(planMessage({
    chatMessage: 'Observed the live world; I will repeat the completed wait.',
    plan: ['Inspect the result'],
    currentStep: 0,
    operations: [{ name: 'wait', args: { ticks: 60 } }],
  })), /attempted to replay a completed world mutation/)
})


test('each independent provider decision gets one bounded output-budget recovery in the same request', async () => {
  const calls = []
  const agent = makeAgent({
    provider: async (_messages, context) => {
      calls.push(context)
      if (calls.length === 1 || calls.length === 3) return exhaustedMessage()
      return planMessage({ chatMessage: 'Recovered.', plan: [], currentStep: 0, operations: [] })
    },
  })
  agent.active = true
  agent.epoch = deployment()
  agent.messages = [{ role: 'user', content: '[CHAT] tester: continue' }]

  const current = deployment()
  const first = await agent.callProvider(current, agent.generation, { round: 0, allowTools: true, recoveryAttempt: 0 })
  const second = await agent.callProvider(current, agent.generation, { round: 1, allowTools: true, recoveryAttempt: 0 })

  assert.equal(first.content.includes('Recovered.'), true)
  assert.equal(second.content.includes('Recovered.'), true)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(call => call.recoveryKind), [
    undefined,
    'output_budget_exhaustion',
    undefined,
    'output_budget_exhaustion',
  ])
})


test('terminal provider budget becomes a deterministic fresh planner generation instead of pausing the project', async () => {
  const calls = []
  const decisions = []
  const rcon = new FakeRcon()
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const agent = makeAgent({
    rcon,
    maxProviderOutputUnits: 3000,
    interactionDecisionProvider: async (state, questions) => {
      decisions.push({ state, questions })
      assert.equal(state.failure.class, 'provider_budget')
      assert.equal(state.task.active_step, canonical[0])
      assert.equal(questions.semantic_scope, undefined)
      assert.deepEqual(Object.keys(questions.next_recovery.criteria), [
        'continue_runtime',
        'observe',
        'wake_planner',
        'ask_user',
      ])
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          failure_class: { type: 'choice', choice: 'provider_budget', confidence: 0.99 },
          next_recovery: { type: 'choice', choice: 'wake_planner', confidence: 0.96 },
        },
        usage: { input_tokens: 40, output_tokens: 8, cost: 0 },
      }
    },
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Waiting first.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }
      if (calls.length === 2 || calls.length === 3) return exhaustedMessage()

      assert.equal(context.triggerSource, 'recovery_continue_low')
      assert.equal(context.recoveryKind, undefined)
      assert.match(messages.at(-1).content, /\[PROVIDER_BUDGET_HANDOFF\]/)
      assert.match(messages.at(-1).content, /keep_target/)
      assert.doesNotMatch(messages.at(-1).content, /reanchor_target/)
      const message = planMessage({
        chatMessage: 'Re-anchored the same target with a fresh planner budget.',
        plan: canonical,
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
      Object.defineProperty(message, '_airiProvider', {
        enumerable: false,
        value: {
          diagnostic_code: 'provider_ok',
          output_budget_exhausted: false,
          finish_reason: 'stop',
          usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
        },
      })
      return message
    },
  })

  await agent.request('run a long bounded task without stopping on planner budget rollover', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(decisions.filter(item => item.state?.contract === 'recovery_route').length, 0)
  assert.equal(calls.length, 4)
  assert.equal(result.goalStatus, 'active')
  assert.notEqual(result.goalStatus, 'paused')
  assert.equal(agent.providerBudgetGeneration, 2)
  assert.equal(agent.providerBudgetGenerationOutputUnits, 200)
  assert.equal(agent.traceRequest.usage.output_units, 4200)
  assert.equal(agent.providerBudgetHandoffCount, 1)
  assert.equal(agent.memory.currentPlan('npc:airi').provider_recovery, undefined)
})


test('provider-budget recovery cannot replace the existing committed plan', async () => {
  const calls = []
  let pendingObserved = false
  const canonical = ['Run one bounded machine cycle', 'Inspect the output']
  const agent = makeAgent({
    maxProviderOutputUnits: 3000,
    interactionDecisionProvider: async (state, _questions) => {
      assert.equal(state.failure.class, 'provider_budget')
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          failure_class: { type: 'choice', choice: 'provider_budget', confidence: 0.99 },
          next_recovery: { type: 'choice', choice: 'wake_planner', confidence: 0.97 },
        },
        usage: { input_tokens: 44, output_tokens: 9, cost: 0 },
      }
    },
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Running one bounded cycle first.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 60 } }],
        })
      }
      if (calls.length === 2 || calls.length === 3) return exhaustedMessage()

      assert.equal(context.triggerSource, 'recovery_continue_low')
      const duringHandoff = agent.memory.currentPlan('npc:airi')
      assert.equal(duringHandoff.hierarchy_split_pending, undefined)
      pendingObserved = true

      return {
        content: JSON.stringify({
          chatMessage: 'Continuing with a smaller bounded objective.',
          plan: ['Inspect one machine output cycle'],
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        }),
      }
    },
  })

  await agent.request('run a long task whose current scope may need splitting', { sender: 'TTLouis' })
  const result = await agent.completed()
  const state = agent.memory.currentPlan('npc:airi')

  assert.equal(pendingObserved, true)
  assert.equal(calls.length, 4)
  assert.equal(result.goalStatus, 'active')
  assert.equal(state.task_board.steps[0]?.description, 'Run one bounded machine cycle')
  assert.equal(agent.providerBudgetGeneration, 2)
  assert.equal(agent.providerBudgetHandoffCount, 1)
})


test('budget handoff survives memory restore and resumes from the compact handoff capsule', async () => {
  const setupMemory = new CanonicalTaskBoardMemory()
  const setupAgent = makeAgent({
    memory: setupMemory,
    provider: async () => planMessage({
      chatMessage: 'Establishing the durable target.',
      plan: ['Inspect the result'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
  })
  await setupAgent.request('establish one durable target', { sender: 'TTLouis' })

  const before = setupMemory.currentPlan('npc:airi')
  setupMemory.setProviderRecovery('npc:airi', {
    kind: 'budget_handoff',
    phase: 'planner_pending',
    goal_id: before.goal_id,
    step_id: before.task_board.active_step_id,
    semantic_scope: 'reanchor_target',
    route: 'continue_low',
    reason: 'provider_turn_output_cap_exceeded: generation 1 used 4001 > 4000',
    budget_generation: 2,
    handoff_count: 1,
    started_at: 12345,
  })

  const restoredMemory = new CanonicalTaskBoardMemory()
  restoredMemory.restore(setupMemory.snapshot())
  assert.equal(restoredMemory.currentPlan('npc:airi').provider_recovery?.kind, 'budget_handoff')
  assert.equal(restoredMemory.currentPlan('npc:airi').provider_recovery?.phase, 'planner_pending')
  assert.equal(restoredMemory.currentPlan('npc:airi').provider_recovery?.semantic_scope, 'reanchor_target')

  let resumed = false
  const resumedAgent = makeAgent({
    memory: restoredMemory,
    provider: async (messages, context) => {
      resumed = true
      assert.equal(context.triggerSource, 'post_step_reanchor')
      const joined = messages.map(message => message.content ?? '').join('\n')
      assert.match(joined, /\[PROVIDER_BUDGET_HANDOFF\]/)
      assert.match(joined, /reanchor_target/)
      return planMessage({
        chatMessage: 'Resumed the same durable target after restart.',
        plan: ['Inspect the result'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
  })

  const result = await resumedAgent.request('continue current work', { sender: 'TTLouis' })

  assert.equal(resumed, true)
  assert.equal(result.goalStatus, 'active')
  assert.equal(resumedAgent.providerBudgetGeneration, 2)
  assert.equal(resumedAgent.providerBudgetHandoffCount, 1)
  assert.equal(restoredMemory.currentPlan('npc:airi').provider_recovery, undefined)
})


test('context-window exhaustion enters the same deterministic planner-budget handoff without pausing canonical work', async () => {
  const canonical = ['Inspect the current machine state', 'Continue the build']
  const calls = []
  let recoveryRoutes = 0
  const agent = makeAgent({
    interactionDecisionProvider: async (state, _questions) => {
      if (state?.contract === 'recovery_route') {
        recoveryRoutes++
        assert.equal(state.failure.class, 'provider_budget')
        return {
          model: 'jev-latest',
          provider: 'TypeSafe',
          answers: {
            failure_class: { type: 'choice', choice: 'provider_budget', confidence: 0.99 },
            next_recovery: { type: 'choice', choice: 'wake_planner', confidence: 0.97 },
          },
          usage: { input_tokens: 30, output_tokens: 6, cost: 0 },
        }
      }
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          contract: { type: 'choice', choice: 'semantic_unknown', confidence: 0.8 },
          compound_step: { type: 'noul', noul: 0.2 },
          step_relation: { type: 'choice', choice: 'advances_current', confidence: 0.9 },
          checkpoint_boundary: { type: 'choice', choice: 'keep_step_open', confidence: 0.9 },
          completion: { type: 'choice', choice: 'progress', confidence: 0.9 },
          next_route: { type: 'choice', choice: 'wake_planner', confidence: 0.9 },
          development: { type: 'choice', choice: 'maintain', confidence: 0.9 },
          reasoning_budget: { type: 'choice', choice: 'normal', confidence: 0.9 },
          planning_horizon: { type: 'choice', choice: 'checkpoint', confidence: 0.9 },
          observation_budget: { type: 'score', score: 0.25, confidence: 0.9 },
        },
        usage: { input_tokens: 20, output_tokens: 5, cost: 0 },
      }
    },
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Start with one bounded wait.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        })
      }
      if (calls.length === 2) {
        const error = new Error('provider_context_window_exceeded: Provider HTTP 400 reported context/input token limit exhaustion')
        error.code = 'provider_context_window_exceeded'
        error.failureClass = 'provider_budget'
        throw error
      }
      assert.equal(context.triggerSource, 'recovery_continue_low')
      assert.match(messages.map(message => message.content ?? '').join('\n'), /\[PROVIDER_BUDGET_HANDOFF\]/)
      return planMessage({
        chatMessage: 'Continued from the same canonical target with a fresh context budget.',
        plan: canonical,
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
  })

  await agent.request('run a context rollover test', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(recoveryRoutes, 0)
  assert.equal(result.goalStatus, 'active')
  assert.notEqual(result.goalStatus, 'paused')
  assert.equal(agent.providerBudgetGeneration, 2)
  assert.equal(agent.providerBudgetHandoffCount, 1)
  assert.equal(agent.memory.currentPlan('npc:airi').provider_recovery, undefined)
})


function rolloverDecisionProvider(counter) {
  return async (state) => {
    if (state?.contract === 'recovery_route') {
      counter.count++
      return {
        model: 'jev-latest',
        provider: 'TypeSafe',
        answers: {
          failure_class: { type: 'choice', choice: 'provider_budget', confidence: 0.99 },
          next_recovery: { type: 'choice', choice: 'wake_planner', confidence: 0.97 },
        },
        usage: { input_tokens: 30, output_tokens: 6, cost: 0 },
      }
    }
    return {
      model: 'jev-latest',
      provider: 'TypeSafe',
      answers: {
        contract: { type: 'choice', choice: 'semantic_unknown', confidence: 0.8 },
        compound_step: { type: 'noul', noul: 0.2 },
        step_relation: { type: 'choice', choice: 'advances_current', confidence: 0.9 },
        checkpoint_boundary: { type: 'choice', choice: 'keep_step_open', confidence: 0.9 },
        completion: { type: 'choice', choice: 'progress', confidence: 0.9 },
        route: { type: 'choice', choice: 'replan', confidence: 0.9 },
        next_route: { type: 'choice', choice: 'wake_planner', confidence: 0.9 },
        development: { type: 'choice', choice: 'maintain', confidence: 0.9 },
        reasoning_budget: { type: 'choice', choice: 'normal', confidence: 0.9 },
        planning_horizon: { type: 'choice', choice: 'checkpoint', confidence: 0.9 },
        observation_budget: { type: 'score', score: 0.25, confidence: 0.9 },
      },
      usage: { input_tokens: 20, output_tokens: 5, cost: 0 },
    }
  }
}

function contextWindowError() {
  const error = new Error('provider_context_window_exceeded: Provider HTTP 400 reported context/input token limit exhaustion')
  error.code = 'provider_context_window_exceeded'
  error.failureClass = 'provider_budget'
  return error
}

test('fresh planner generations can roll over provider budget more than once in one long-lived request', async () => {
  const canonical = ['Inspect machine state', 'Continue the build']
  const calls = []
  const recoveryRoutes = { count: 0 }
  const agent = makeAgent({
    interactionDecisionProvider: rolloverDecisionProvider(recoveryRoutes),
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Start one bounded runtime action.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        })
      }
      if (calls.length === 2 || calls.length === 3) throw contextWindowError()
      assert.equal(context.triggerSource, 'recovery_continue_low')
      assert.match(messages.map(message => message.content ?? '').join('\n'), /\[PROVIDER_BUDGET_HANDOFF\]/)
      return planMessage({
        chatMessage: 'Continued after the second planner budget rollover.',
        plan: canonical,
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
  })

  await agent.request('exercise repeated planner budget rollover', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(recoveryRoutes.count, 0)
  assert.equal(calls.length, 4)
  assert.equal(result.goalStatus, 'active')
  assert.equal(agent.providerBudgetGeneration, 3)
  assert.equal(agent.providerBudgetHandoffCount, 2)
  assert.equal(agent.memory.currentPlan('npc:airi').provider_recovery, undefined)
})

test('provider budget rollover limit stops recursive fresh generations without creating a world blocker', async () => {
  const canonical = ['Inspect machine state', 'Continue the build']
  const calls = []
  const recoveryRoutes = { count: 0 }
  const agent = makeAgent({
    maxProviderBudgetHandoffs: 1,
    interactionDecisionProvider: rolloverDecisionProvider(recoveryRoutes),
    provider: async () => {
      calls.push(calls.length + 1)
      if (calls.length === 1) {
        return planMessage({
          chatMessage: 'Start one bounded runtime action.',
          plan: canonical,
          currentStep: 0,
          operations: [{ name: 'wait', args: { ticks: 1 } }],
        })
      }
      throw contextWindowError()
    },
  })

  await agent.request('exercise bounded planner budget rollover', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(recoveryRoutes.count, 0)
  assert.equal(calls.length, 3)
  assert.equal(agent.providerBudgetGeneration, 2)
  assert.equal(agent.providerBudgetHandoffCount, 1)
  assert.equal(result.goalStatus, 'paused')
  const state = agent.memory.currentPlan('npc:airi')
  assert.equal(state.status, 'paused')
  assert.notEqual(state.status, 'blocked')
  assert.equal(state.provider_recovery, undefined)
})

test('a budget handoff on the first turn of a new goal keeps the player request', async () => {
  // 2026-09-24 cloud trial: the planner spent the new-goal read budget, the
  // tools-off decision turn exhausted its output budget before any plan was
  // stored, and the handoff capsule had goal: null, so the fresh generation
  // answered that it had nothing to do and the goal was dropped.
  const calls = []
  const request = 'build a burner mining drill on iron ore that feeds a stone furnace'
  const read = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } })
  const agent = makeAgent({
    interactionDecisionProvider: async (_state, questions) => ({
      model: 'jev-latest',
      provider: 'TypeSafe',
      answers: questions.intent
        ? {
            intent: { type: 'choice', choice: 'new_goal', confidence: 0.99, probabilities: { new_goal: 0.99 } },
            queue_conflict: { type: 'noul', noul: 0 },
          }
        : {},
    }),
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length === 1) {
        return { tool_calls: [read('a', 'getActorStatus'), read('b', 'getInventoryItems'), read('c', 'getTaskStatus')] }
      }
      if (calls.length === 2) return exhaustedMessage()
      return planMessage({
        chatMessage: 'Starting.',
        plan: ['Gather stone for a furnace'],
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
  })

  await agent.request(request, { sender: 'TTLouis' })

  assert.equal(calls[1].context.allowTools, false)
  const handoff = calls.at(-1).messages.map(message => String(message.content ?? ''))
    .find(content => content.startsWith('[PROVIDER_BUDGET_HANDOFF]'))
  assert.ok(handoff, 'the fresh generation receives the handoff capsule')
  const capsule = JSON.parse(handoff.slice(handoff.indexOf('{')))
  assert.deepEqual(capsule.player_request, { sender: 'TTLouis', text: request })
  // The capsule has none of the earlier reads, so the fresh generation can
  // observe again (attempt 2 of the canary inherited a closed phase).
  assert.equal(calls.at(-1).context.allowTools, true)
})
