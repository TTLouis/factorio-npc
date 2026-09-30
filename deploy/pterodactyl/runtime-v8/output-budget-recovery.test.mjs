import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, normalizedProviderUsage, toolReplySequenceViolation } from './npc-agent-loop.mjs'
import { providerRequest } from './provider.mjs'
import { recoverInterruptedAgentPlan } from './supervisor.mjs'
import {
  STEAM_AUTHORING_OUTPUT_UNITS,
  STEAM_PLAN,
  STEAM_ROUNDS,
  STEAM_SCRIPTED_BLOCKED_ANSWER,
  STEAM_TAIL_OUTPUT_UNITS,
  steamReplayHarness,
} from './steam-run-fixtures.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
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
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(this.status)
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
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
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
  Object.defineProperty(message, '_sglunaProvider', {
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

// U8: the budget handoff (checkpoint C5) restages from a handoff packet. The fresh
// generation reads the system prompt, the packet's plan block and its step block,
// and nothing from the exhausted thread: no assistant or tool message, no [CHAT].
function assertC5Packet(messages, { scope = 'keep_target', kind = 'handoff' } = {}) {
  assert.equal(messages[0].role, 'system')
  assert.match(String(messages[1].content), /^\[HANDOFF\] Rebuilt from durable harness state/)
  assert.match(String(messages[2].content), new RegExp(`^--- step block ---\nrestage: role=planner checkpoint=C5 reason=provider_budget_${kind} scope=${scope}`))
  assert.deepEqual(messages.filter(message => message.role === 'assistant' || message.role === 'tool'), [], 'no exchange of the exhausted thread')
  assert.ok(!messages.some(message => String(message.content ?? '').startsWith('[CHAT]')), 'no request text from the exhausted thread')
  assert.ok(!messages.some(message => String(message.content ?? '').startsWith('[PROVIDER_BUDGET_HANDOFF]')), 'the ad-hoc capsule is gone')
}

function makeAgent({
  provider,
  rcon = new FakeRcon(),
  reserve = async () => ({}),
  interactionDecisionProvider,
  maxProviderOutputUnits,
  maxProviderBudgetHandoffs,
  memory = new CanonicalTaskBoardMemory(),
  onActivity,
} = {}) {
  return new NpcAgentLoop({
    onActivity,
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
  // Round 0 of a new request offers submitPlan and may write the plan, so it
  // keeps the full plan-writing bracket (item 1.3 review fix).
  assert.equal(bodies[0].reasoning_effort, 'max')
  assert.deepEqual(bodies[0].thinking, { type: 'enabled' })
  assert.equal(bodies[0].max_tokens, 40000)
  assert.equal(bodies[1].reasoning_effort, 'none')
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' })
  assert.equal(bodies[1].max_tokens, 3000)
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
      const stateDuringRecovery = agent.memory.currentPlan('npc:sgluna')
      assert.deepEqual(stateDuringRecovery.plan, canonical)
      assert.equal(stateDuringRecovery.task_board.active_index, 0)
      assert.equal(stateDuringRecovery.task_board.total_steps, 3)
      assert.equal(stateDuringRecovery.task_board.evidence.at(-1).kind, 'operation_receipt')
      assert.equal(stateDuringRecovery.task_board.evidence.some(item => item.kind === 'deterministic_verification'), false)
      assert.equal(agent.memory.byNpc.get('npc:sgluna').recent.at(-1).assistant, 'Waiting for one machine cycle.')

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

  const state = agent.memory.currentPlan('npc:sgluna')
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
  const state = agent.memory.currentPlan('npc:sgluna')
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

  const durable = agent.memory.currentPlan('npc:sgluna')
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
      assertC5Packet(messages, { scope: 'keep_target' })
      assert.doesNotMatch(messages[2].content, /reanchor_target/)
      assert.match(messages[2].content, /budget: provider budget generation 2; handoff 1 of 4;/)
      assert.match(messages[2].content, /cause=provider_turn_output_cap_exceeded/)
      assert.match(messages[2].content, /active_step: 1 of 2 .*Wait for the machine cycle/, 'the active step is in the packet')
      const message = planMessage({
        chatMessage: 'Re-anchored the same target with a fresh planner budget.',
        plan: canonical,
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
      Object.defineProperty(message, '_sglunaProvider', {
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
  assert.equal(agent.memory.currentPlan('npc:sgluna').provider_recovery, undefined)
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
      const duringHandoff = agent.memory.currentPlan('npc:sgluna')
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
  const state = agent.memory.currentPlan('npc:sgluna')

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

  const before = setupMemory.currentPlan('npc:sgluna')
  setupMemory.setProviderRecovery('npc:sgluna', {
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
  assert.equal(restoredMemory.currentPlan('npc:sgluna').provider_recovery?.kind, 'budget_handoff')
  assert.equal(restoredMemory.currentPlan('npc:sgluna').provider_recovery?.phase, 'planner_pending')
  assert.equal(restoredMemory.currentPlan('npc:sgluna').provider_recovery?.semantic_scope, 'reanchor_target')

  let resumed = false
  const resumedAgent = makeAgent({
    memory: restoredMemory,
    provider: async (messages, context) => {
      resumed = true
      assert.equal(context.triggerSource, 'post_step_reanchor')
      assertC5Packet(messages, { scope: 'reanchor_target', kind: 'resume' })
      assert.match(messages[2].content, /cause=provider_turn_output_cap_exceeded: generation 1 used 4001 > 4000/, 'the reason code the pause recorded')
      assert.match(messages[2].content, /handoff 1 of 4/)
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
  assert.equal(restoredMemory.currentPlan('npc:sgluna').provider_recovery, undefined)
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
      assertC5Packet(messages)
      assert.match(messages[2].content, /cause=provider_context_window_exceeded/)
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
  assert.equal(agent.memory.currentPlan('npc:sgluna').provider_recovery, undefined)
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
      assertC5Packet(messages)
      assert.match(messages[2].content, /handoff 2 of 4/)
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
  assert.equal(agent.memory.currentPlan('npc:sgluna').provider_recovery, undefined)
})

test('provider budget rollover limit stops recursive fresh generations without creating a world blocker', async () => {
  const canonical = ['Inspect machine state', 'Continue the build']
  const calls = []
  const recoveryRoutes = { count: 0 }
  const events = []
  const agent = makeAgent({
    maxProviderBudgetHandoffs: 1,
    onActivity: (event, data) => events.push({ event, data }),
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
  const state = agent.memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'paused')
  assert.notEqual(state.status, 'blocked')
  assert.equal(state.provider_recovery, undefined)
  // Burner-drill canary attempt 3: the pause wrote no terminal event, so the
  // trace read as a stalled request.
  const ended = events.filter(entry => entry.event === 'request.completed' || entry.event === 'request.failed')
  assert.equal(ended.at(-1)?.data.outcome, 'paused_recoverable')
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
  // The first plan of a new goal has no committed plan yet: the packet carries
  // the admitted goal (the player's request) and says no plan is committed.
  const fresh = calls.at(-1).messages
  assertC5Packet(fresh)
  assert.match(String(fresh[1].content), new RegExp(`^goal: ${request}$`, 'm'), 'the player request survives in the packet goal')
  assert.match(String(fresh[1].content), /^plan: none committed yet$/m)
  assert.match(String(fresh[2].content), /^active_step: none \(no committed plan\)$/m)
  // The capsule has none of the earlier reads, so the fresh generation can
  // observe again (attempt 2 of the canary inherited a closed phase).
  assert.equal(calls.at(-1).context.allowTools, true)
})

test('a budget handoff after loaded skills keeps every tool exchange whole for the fresh generation', async () => {
  // 2026-09-25 live trace (req_muh34c6x_1): a tools-off decision round ended
  // with finish_reason length, the budget handoff replaced the working context
  // with a two-message capsule prefix, and the fresh generation made one read
  // round. Skill context was then inserted at the old three-message base index,
  // i.e. between the assistant tool_calls and its tool replies, and DeepSeek
  // rejected round 1 with HTTP 400 ("insufficient tool messages following
  // tool_calls message"), pausing the goal.
  const factorio = new FakeFactorio({ inventory: { 'burner-mining-drill': 2, coal: 12 } })
  factorio.skills['burner-coal-loop'] = {
    schema_version: 1,
    revision: 1,
    id: 'burner-coal-loop',
    name: 'Burner Coal Loop',
    kind: 'production',
    stage: 'pattern',
    status: 'candidate',
    summary: 'Bootstrap early coal production with a small amount of starter fuel, then arrange fuel-burning miners so mined coal feeds the fuel demand of the loop.',
    preconditions: [{ kind: 'bootstrap', subject: 'starter-fuel', description: 'Enough initial fuel exists to start at least part of the loop.' }],
    topology: { relations: [{ kind: 'direct_item_output', from: 'miner-a', to: 'miner-b', description: 'Orient direct mining output so coal reaches the next miner fuel path.' }] },
    constraints: [{ kind: 'placement', description: 'Every miner must cover coal and its actual output direction must line up with the receiving fuel inventory.', validation: 'unvalidated', evidence_refs: {} }],
    verification: { mode: 'deterministic' },
  }
  const call = (id, index, name, args = {}) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const isHandoff = message => String(message.content ?? '').startsWith('[HANDOFF]')
  const calls = []
  const agent = makeAgent({
    rcon: factorio,
    interactionDecisionProvider: recordingJev(),
    provider: async (messages, context) => {
      calls.push({ messages: messages.map(message => ({ ...message })), context })
      if (calls.length === 1) {
        return {
          content: 'I will load the coal loop pattern and check my state.',
          tool_calls: [
            call('call_00_skill0000000000000001', 0, 'getSkillDetails', { id: 'burner-coal-loop' }),
            call('call_01_status000000000000001', 1, 'getActorStatus'),
            call('call_02_inventory00000000001', 2, 'getInventoryItems'),
          ],
        }
      }
      if (!messages.some(isHandoff)) return exhaustedMessage()
      if (!messages.some(message => message.role === 'tool')) {
        return {
          content: 'I\'ll verify arrival at the coal patch and scan the local area.',
          tool_calls: [
            call('call_00_E8h5iZhFPzJ8JJMJGZM60759', 0, 'getActorStatus'),
            call('call_01_0g5jmVutTdLcqYDngS7P9402', 1, 'getNearbyEntities', { radius: 32, name: 'coal' }),
            call('call_02_L2dnUpaxZcchVoFnvvMT3018', 2, 'getInventoryItems'),
          ],
        }
      }
      return planReply({
        chatMessage: 'Placing the first burner drill on coal.',
        plan: ['Place two burner drills that feed each other on coal', 'Verify the loop stays fueled'],
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      })
    },
  })

  await agent.request('now also automate coal production with only burner miner', { sender: 'TTLouis' })

  const fresh = calls.filter(entry => entry.messages.some(isHandoff))
  assert.equal(fresh.length, 2, 'the fresh generation makes one read round and one decision round')
  assert.equal(fresh[0].context.triggerSource, 'recovery_continue_low')
  for (const [index, entry] of calls.entries()) {
    assert.equal(toolReplySequenceViolation(entry.messages), undefined, `provider call ${index + 1} split a tool exchange`)
  }
  // The loaded skill still reaches both fresh rounds, in the fixed prefix.
  for (const entry of fresh) {
    const skillAt = entry.messages.findIndex(message => String(message.content ?? '').startsWith('[SKILL_CONTEXT]'))
    const firstTurn = entry.messages.findIndex(message => message.role === 'assistant' || message.role === 'tool')
    assert.ok(skillAt > 0, 'skill context is sent')
    assert.ok(firstTurn < 0 || skillAt < firstTurn, 'skill context precedes the first model turn')
  }
  assert.equal(factorio.mutations.length, 1)
  assert.equal(agent.memory.currentPlan('npc:sgluna').status, 'active')
})

test('a staged amendment cannot push skill context into the middle of a tool exchange', () => {
  const agent = makeAgent({ provider: async () => { throw new Error('no provider call in this assembly test') } })
  agent.baseMessages = [
    { role: 'system', content: 'NPC output-budget recovery test prompt' },
    { role: 'user', content: '[CHAT] TTLouis: build a burner coal loop' },
  ]
  agent.messages = [
    ...agent.baseMessages.map(message => ({ ...message })),
    { role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_00_a', type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_00_a', content: '{}' },
  ]
  agent.recordLoadedSkillToolResult('getSkillDetails', { id: 'burner-coal-loop' }, JSON.stringify({ id: 'burner-coal-loop', name: 'Burner Coal Loop' }))
  // A compatible amendment grows the base for the next continuation only.
  agent.baseMessages.push({ role: 'user', content: '[CHAT] TTLouis: use the patch to the west' })

  const messages = agent.providerMessages()
  assert.equal(toolReplySequenceViolation(messages), undefined)
  assert.match(messages[2].content, /^\[SKILL_CONTEXT\]/)
})

// ---------------------------------------------------------------------------
// Static scenario, item 1.5: the 2026-09-26 steam run replayed from its
// recorded replies (steam-run-fixtures.mjs), through request()/completed()/
// failed(). One request carried the whole goal on one budget generation and
// died at provider_turn_output_cap_exceeded with the plan silently blocked.
// ---------------------------------------------------------------------------

function sumOutput(rounds) {
  return rounds.reduce((total, round) => total + round.usage.output, 0)
}

// Live, step 2 alone spent 64,407 output units over many more cycles than the
// fixture keeps; the fixture keeps its last 20,941. To make one step overrun
// its own budget with that slice, the cap drops to 20,000 once step 1 has
// closed (authoring ran under the live 100,000).
const STEP_OVERRUN_CAP = 20000

async function replayToCapDuringBlockedPlan(world) {
  await world.request()
  await world.closeStep1()
  world.agent.maxProviderOutputUnits = STEP_OVERRUN_CAP
  return world.failSupplyBatch()
}

test('steam replay: a verified step close rolls the output budget generation, so the request survives what killed it live', async () => {
  // The replay carries the recorded authoring rounds plus the last recorded
  // cycle: 42,915 + 20,941 = 63,856 output units in one request. Against a
  // 60,000 cap that is the live failure in miniature (107,322 > 100,000):
  // one generation for the whole request fails, one per step does not.
  const cap = 60000
  assert.equal(sumOutput(STEAM_ROUNDS.filter(round => round.phase === 'authoring')), STEAM_AUTHORING_OUTPUT_UNITS)
  assert.equal(sumOutput(STEAM_ROUNDS.filter(round => round.phase !== 'authoring')), STEAM_TAIL_OUTPUT_UNITS)
  assert.ok(STEAM_AUTHORING_OUTPUT_UNITS + STEAM_TAIL_OUTPUT_UNITS > cap)

  const world = steamReplayHarness({ maxProviderOutputUnits: cap, extraRounds: [STEAM_SCRIPTED_BLOCKED_ANSWER] })
  const first = await world.request()
  assert.equal(first.goalStatus, 'active')
  assert.equal(world.calls.length, 4)
  const requestId = world.trace.find(record => record.event === 'request.received')?.request_id
  assert.match(requestId, /^req_/)
  assert.equal(world.agent.providerBudgetGeneration, 1)
  assert.equal(world.agent.providerBudgetGenerationOutputUnits, STEAM_AUTHORING_OUTPUT_UNITS)

  await world.closeStep1()
  const rolled = world.events('budget.generation_rolled')
  assert.equal(rolled.length, 1, JSON.stringify(world.trace.map(record => record.event)))
  assert.equal(rolled[0].request_id, requestId)
  assert.equal(rolled[0].data.reason, 'step_closed')
  assert.equal(rolled[0].data.source, 'deterministic_completion_contract')
  assert.equal(rolled[0].data.previous_generation, 1)
  assert.equal(rolled[0].data.generation, 2)
  assert.equal(rolled[0].data.previous_generation_output_units, STEAM_AUTHORING_OUTPUT_UNITS)
  assert.equal(rolled[0].data.completed_count, 1)
  assert.equal(rolled[0].data.output_cap, cap)
  // The roll is recorded before the next planner round is sent.
  const stepVerified = world.events('step.verified')[0]
  const nextRequest = world.events('provider.request').find(record => record.seq > rolled[0].seq)
  assert.ok(stepVerified.seq < rolled[0].seq)
  assert.ok(nextRequest, 'the step-2 planner round follows the roll')

  await world.failSupplyBatch()
  const state = world.memory.currentPlan('npc:sgluna')
  assert.equal(world.events('budget.output_units_exceeded').length, 0)
  assert.equal(world.events('request.failed').length, 0)
  assert.equal(world.events('budget.cap_reached').length, 0)
  assert.equal(world.agent.providerBudgetGeneration, 2)
  assert.equal(
    world.agent.providerBudgetGenerationOutputUnits,
    STEAM_TAIL_OUTPUT_UNITS + STEAM_SCRIPTED_BLOCKED_ANSWER.usage.output,
  )
  // The request as a whole spent more than the cap; no generation did.
  const requestOutput = world.events('provider.response')
    .filter(record => record.request_id === requestId)
    .reduce((total, record) => total + record.data.usage.output_units, 0)
  assert.equal(requestOutput, STEAM_AUTHORING_OUTPUT_UNITS + STEAM_TAIL_OUTPUT_UNITS + STEAM_SCRIPTED_BLOCKED_ANSWER.usage.output)
  assert.ok(requestOutput > cap)
  assert.equal(Math.max(...world.events('provider.response').map(record => record.data.turn_output_units)) <= cap, true)
  assert.equal(state.blocker, 'transfer_failed:nothing_moved')
})


const RESUME_LINE = 'Press Resume or say continue to retry from the verified task state.'

test('steam replay: a budget stop on a blocked plan keeps it BLOCKED, names both causes, and Resume gets the blocked reply with no work admitted', async () => {
  // Step 2 overruns its own generation while the plan is blocked on
  // transfer_failed:nothing_moved -- where the live run stopped silently.
  const cap = STEP_OVERRUN_CAP
  let intent = 'new_goal'
  const world = steamReplayHarness({ routedIntent: () => intent })
  const result = await replayToCapDuringBlockedPlan(world)
  const requestId = world.events('request.received')[0].request_id

  assert.equal(world.calls.length, STEAM_ROUNDS.length)
  assert.equal(world.events('budget.output_units_exceeded').length, 1)
  assert.equal(world.events('request.failed').length, 0, 'the cap no longer ends as request.failed recoverable=false')

  // One chat line, naming the blocker and the budget stop, asking for the
  // same decision the blocked reply asks for (no Resume promise).
  assert.equal(result.chatMessage, 'I stopped: the model used its whole output budget for this step (20,941 of 20,000 units), and the plan is blocked on transfer_failed:nothing_moved. Continuing unchanged would hit the same blocker. Tell me how to revise it (for example a different route or target), or cancel it.')
  assert.equal(result.goalStatus, 'blocked')
  assert.equal(result.budgetCause, 'provider_turn_output_cap_exceeded')
  const state = world.memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'blocked', 'a blocked plan is never relabelled paused')
  assert.equal(state.blocker, 'transfer_failed:nothing_moved')
  assert.equal(state.pause_reason, '')
  assert.equal(world.memory.planningState('npc:sgluna').plans.at(-1).status, 'BLOCKED')
  assert.equal(world.agent.active, false)

  const reached = world.events('budget.cap_reached')
  assert.equal(reached.length, 1)
  assert.equal(reached[0].request_id, requestId)
  assert.equal(reached[0].data.budget_cause, 'provider_turn_output_cap_exceeded')
  assert.equal(reached[0].data.source, 'plan_not_active')
  assert.equal(reached[0].data.previous_status, 'blocked')
  assert.equal(reached[0].data.goal_status, 'blocked')
  assert.equal(reached[0].data.next_action, 'revise_or_cancel')
  assert.equal(reached[0].data.blocker, 'transfer_failed:nothing_moved')
  assert.equal(reached[0].data.generation_output_units, STEAM_TAIL_OUTPUT_UNITS)
  assert.equal(reached[0].data.output_cap, cap)
  assert.equal(world.events('goal.paused').length, 0)
  const completed = world.events('request.completed').at(-1)
  assert.equal(completed.data.outcome, 'blocked_budget_stop')
  assert.equal(completed.data.budget_cause, 'provider_turn_output_cap_exceeded')
  assert.equal(completed.data.chat_message, result.chatMessage)

  // Resume ("continue", routed as continue_current) gets the existing blocked
  // reply: no planner call, no work admitted, no revise choice recorded.
  intent = 'continue_current'
  const callsBefore = world.calls.length
  const mutationsBefore = world.game.mutations.length
  const resumed = await world.agent.request('continue', { sender: 'TTLouis' })
  assert.match(resumed.chatMessage, /^The current plan is blocked.*Continuing unchanged would hit the same blocker\. Tell me how to revise it/)
  assert.equal(resumed.goalStatus, 'blocked')
  assert.equal(world.calls.length, callsBefore)
  assert.equal(world.game.mutations.length, mutationsBefore)
  assert.equal(world.memory.currentPlan('npc:sgluna').status, 'blocked')
  assert.equal(world.memory.planningState('npc:sgluna').plans.at(-1).blocker?.user_choice, undefined)
})

test('a budget pause on an ACTIVE plan still resumes normally with Resume', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  let resumed = false
  const rcon = new FakeRcon()
  const over = () => {
    const message = planMessage({ chatMessage: 'Thinking long.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 3500, total_tokens: 3600 } },
    })
    return message
  }
  let calls = 0
  const agent = makeAgent({
    rcon,
    maxProviderOutputUnits: 3000,
    maxProviderBudgetHandoffs: 1,
    provider: async () => {
      calls++
      if (calls === 1 || resumed) {
        return planMessage({ chatMessage: 'Waiting.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
      }
      return over()
    },
  })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }

  await agent.request('run the bounded cycle', { sender: 'TTLouis' })
  const paused = await agent.completed()
  assert.equal(paused.goalStatus, 'paused')
  assert.ok(paused.chatMessage.endsWith(RESUME_LINE), paused.chatMessage)
  assert.equal(agent.memory.currentPlan('npc:sgluna').status, 'paused')
  const pausedEvent = trace.filter(record => record.event === 'goal.paused')
  assert.equal(pausedEvent.length, 1)

  resumed = true
  const mutationsBefore = rcon.mutations.length
  const result = await agent.request('continue', { sender: 'TTLouis' })
  assert.equal(result.goalStatus, 'active')
  assert.equal(agent.memory.currentPlan('npc:sgluna').status, 'active')
  assert.equal(rcon.mutations.length, mutationsBefore + 1, 'Resume admits work again')
})

// A runaway request: many cheap step closes, each on a fresh step budget, so
// the per-step cap never trips. The request-wide ceiling (5 x the per-turn
// cap, no new setting) stops it with a visible pause.
function runawayHarness() {
  const ores = ['iron-ore', 'copper-ore', 'coal', 'stone']
  const steps = Array.from({ length: 16 }, (_, index) => `Mine 10 ${ores[index % ores.length]} (batch ${index + 1})`)
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: 0, trace: [] }
  const withUsage = (message, output) => {
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 3000, completion_tokens: output, total_tokens: 3000 + output } },
    })
    return message
  }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    maxProviderOutputUnits: 1000,
    provider: async () => {
      world.calls++
      assert.ok(world.calls < 40, 'runaway was not stopped')
      const board = memory.currentPlan('npc:sgluna')?.task_board
      if (!board) {
        return withUsage(planReply({ plan: steps, operations: [gather(ores[0], 10)], checkpoint: inventoryCheckpoint(ores[0], 10) }), 480)
      }
      const index = board.active_index
      const step = board.steps[index]
      const verified = (board.evidence ?? []).some(item => item?.step_id === step.id && item?.kind === 'deterministic_verification')
      if (index >= 1 && verified) {
        return withUsage(planReply({
          plan: steps,
          currentStep: index + 1,
          operations: [gather(ores[(index + 1) % ores.length], 10)],
          semanticCompletion: { stepId: step.id, rationale: 'The completed batch grounds this prose-only step.' },
        }), 480)
      }
      return withUsage(planReply({ plan: steps, currentStep: index, operations: [gather(ores[index % ores.length], 10)] }), 480)
    },
    systemPrompt: 'request output ceiling test',
    stateFile: null,
    traceFile: null,
  })
  world.agent.behaviorTrace = { emit: async record => { world.trace.push(record) } }
  world.events = name => world.trace.filter(record => record.event === name)
  world.finishUntilPaused = async () => {
    let result
    for (let batch = 0; batch < 24; batch++) {
      const board = memory.currentPlan('npc:sgluna').task_board
      const resource = ores[board.active_index % ores.length]
      game.inventory[resource] = (game.inventory[resource] ?? 0) + 10
      result = await world.agent.completed()
      if (result?.goalStatus === 'paused') break
    }
    return result
  }
  return world
}

function assertCeilingPause(world, result, requestId) {
  assert.equal(result?.goalStatus, 'paused')
  assert.equal(world.events('budget.output_units_exceeded').length, 0, 'no single step overran its budget')
  assert.ok(world.events('budget.generation_rolled').length >= 3, 'the steps closed on fresh budgets')
  const exceeded = world.events('budget.request_ceiling_exceeded')
  assert.equal(exceeded.length, 1)
  assert.equal(exceeded[0].request_id, requestId)
  assert.equal(exceeded[0].data.request_output_ceiling, 5000)
  assert.equal(exceeded[0].data.request_output_units, 5280, '11 calls x 480 = 5,280 > 5,000')
  assert.match(result.chatMessage, /^I paused this goal: this request used its whole output allowance \(5,280 of 5,000 units across \d+ step budgets\)\. /)
  assert.ok(result.chatMessage.endsWith(RESUME_LINE))
  const state = world.memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause_reason, 'request_output_ceiling: 5,280 > 5,000 output units')
  const paused = world.events('goal.paused')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].request_id, requestId)
  assert.equal(paused[0].data.cause, 'request_output_ceiling')
  const completed = world.events('request.completed').at(-1)
  assert.equal(completed.data.outcome, 'paused_request_output_ceiling')
  assert.equal(completed.data.reason, 'request_output_ceiling')
  assert.equal(world.events('request.failed').length, 0)
}

test('a runaway of cheap step closes hits the request-wide output ceiling and pauses visibly', async () => {
  const world = runawayHarness()
  await world.agent.request('mine a long list of ore batches', { sender: 'TTLouis' })
  const requestId = world.events('request.received')[0].request_id
  const result = await world.finishUntilPaused()
  assertCeilingPause(world, result, requestId)
  assert.equal(world.calls, 11)
})

test('a supervisor recovery run carries a usage summary, so the request ceiling applies to it too', async () => {
  const world = runawayHarness()
  await world.agent.request('mine a long list of ore batches', { sender: 'TTLouis' })
  assert.equal(world.calls, 1)

  // A runtime restart: the supervisor's recovery opens its own trace request
  // ({ id, seq } only) and runs the planner without request().
  const recovery = await recoverInterruptedAgentPlan(world.agent, 'runtime_restart', { restart: 1 })
  assert.equal(recovery.recovered, true)
  const started = world.events('runtime.recovery_started')
  assert.equal(started.length, 1)
  const recoveryId = started[0].request_id
  assert.match(recoveryId, /^recovery_/)
  assert.equal(typeof world.agent.traceRequest?.usage?.output_units, 'number')

  const result = await world.finishUntilPaused()
  // The chat request's first call is not counted: 11 recovery calls reach 5,280.
  assertCeilingPause(world, result, recoveryId)
  assert.equal(world.calls, 12)
})

// U5: the ceiling is per plan slice. A long goal that keeps closing small
// slices (author a slice, verify it, claim it, plan the next) accumulates a
// request-wide total far past 5 x the per-turn cap without any slice being big.
const SLICE_GOAL = {
  scope: 'long_horizon',
  summary: 'Launch one rocket from this save.',
  doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }],
}
const SLICE_SHELF = [
  { id: 'node_power', intent: 'steam power running' },
  { id: 'node_drill', intent: 'an electric mining drill on iron ore', depends_on: ['node_power'] },
]
const SLICE_CALL_UNITS = 450

// Two provider calls per slice (author, then the claim that closes it), each
// charged SLICE_CALL_UNITS against a 1,000-unit per-turn cap (ceiling 5,000).
function sliceHarness() {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const world = { game, memory, calls: 0, trace: [], slicesAuthored: 0 }
  const withUsage = (message) => {
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 3000, completion_tokens: SLICE_CALL_UNITS, total_tokens: 3000 + SLICE_CALL_UNITS } },
    })
    return message
  }
  world.agent = new NpcAgentLoop({
    rcon: game,
    memory,
    maxProviderOutputUnits: 1000,
    maxContinuations: 64, // one continuation per closed slice; the default 10 is unrelated to the ceiling
    provider: async () => {
      world.calls++
      assert.ok(world.calls < 60, 'slice loop did not terminate')
      if (world.calls % 2 === 1) {
        world.slicesAuthored++
        return withUsage(planReply({
          plan: [`Gather 10 iron ore (slice ${world.slicesAuthored})`],
          operations: [gather('iron-ore', 10)],
          ...(world.slicesAuthored === 1 ? { goal: SLICE_GOAL, roadmap: SLICE_SHELF } : {}),
        }))
      }
      return withUsage(planReply({
        chatMessage: 'Slice mined.',
        plan: [],
        currentStep: 0,
        operations: [],
        semanticCompletion: { stepId: memory.currentPlan('npc:sgluna')?.task_board?.active_step_id, rationale: 'The completed gather batch grounds this prose-only step.' },
      }))
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'slice ceiling test',
    goalDefinitionPolicy: 'required',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  world.agent.behaviorTrace = { emit: async record => { world.trace.push(record) } }
  world.events = name => world.trace.filter(record => record.event === name)
  // Mine one more batch; verification closes the slice and the planner is
  // woken for the next one inside the same request.
  world.closeSlice = async () => {
    game.inventory['iron-ore'] = (game.inventory['iron-ore'] ?? 0) + 10
    return world.agent.completed()
  }
  return world
}

test('a long goal whose total output crosses 5x the cap over several slices never pauses while every slice stays under it', async () => {
  const world = sliceHarness()
  await world.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  let result
  for (let slice = 0; slice < 6; slice++) result = await world.closeSlice()

  const aggregate = world.agent.traceRequest.usage.output_units
  const ceiling = world.agent.requestOutputCeiling()
  assert.equal(ceiling, 5000)
  assert.ok(aggregate > ceiling, `the aggregate ${aggregate} is past the ceiling ${ceiling}, where the old request-wide check paused`)
  assert.notEqual(result?.goalStatus, 'paused')
  assert.equal(world.events('budget.request_ceiling_exceeded').length, 0)
  assert.equal(world.events('goal.paused').length, 0)
  assert.equal(world.events('request.failed').length, 0)
  assert.equal(world.memory.currentPlan('npc:sgluna').status, 'active')

  // Each slice close reset the baseline to the aggregate of that moment.
  const resets = world.events('budget.slice_baseline_reset')
  assert.equal(resets.length, world.events('planning.slice_completion_continuation').length)
  assert.equal(resets.length, 6)
  let expectedBaseline = 0
  for (const reset of resets) {
    assert.equal(reset.data.previous_slice_output_baseline, expectedBaseline)
    assert.ok(reset.data.slice_output_units <= 2 * SLICE_CALL_UNITS, 'a slice is an author call and a claim call')
    assert.equal(reset.data.aggregate_output_units, reset.data.slice_output_baseline)
    assert.ok(reset.data.slice_output_baseline > expectedBaseline || expectedBaseline === 0)
    expectedBaseline = reset.data.slice_output_baseline
  }
  assert.equal(world.agent.traceRequest.slice_output_baseline, expectedBaseline)
  // The provider.response row keeps its shape: request_output_units stays the aggregate.
  const responses = world.events('provider.response')
  assert.equal(responses.at(-1).data.request_output_units, aggregate)
  assert.equal(responses.some(record => 'slice_output_baseline' in record.data), false)
})

test('the baseline moves at a slice close only, never at a step close inside a slice', async () => {
  // The runaway request is one 16-step plan: every step close rolls the step
  // budget generation, but no slice ever closes, so the baseline never moves.
  const world = runawayHarness()
  await world.agent.request('mine a long list of ore batches', { sender: 'TTLouis' })
  await world.finishUntilPaused()
  assert.ok(world.events('budget.generation_rolled').length >= 3, 'steps closed inside the slice')
  assert.equal(world.events('budget.slice_baseline_reset').length, 0)
  assert.ok(world.events('provider.response').length >= 11)
  assert.equal(world.agent.traceRequest?.slice_output_baseline ?? 0, 0)

  // Slice harness: the baseline changes once per slice close and by nothing else.
  const slices = sliceHarness()
  await slices.agent.request('get steam power going and run an electric mining drill on iron ore', { sender: 'TTLouis' })
  assert.equal(slices.agent.traceRequest.slice_output_baseline ?? 0, 0, 'authoring the first slice moves nothing')
  const seen = []
  for (let close = 1; close <= 3; close++) {
    await slices.closeSlice()
    seen.push(slices.agent.traceRequest.slice_output_baseline)
    assert.equal(slices.events('budget.slice_baseline_reset').length, close)
  }
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b))
  assert.equal(new Set(seen).size, 3, 'each slice close moved the baseline')
})

test('a single slice that goes over the ceiling still pauses visibly after earlier slices closed, and reports its slice figures', async () => {
  const world = runawayHarness()
  await world.agent.request('mine a long list of ore batches', { sender: 'TTLouis' })
  // An earlier slice of this request closed at 480 units (the request's first call).
  assert.equal(world.agent.traceRequest.usage.output_units, 480)
  world.agent.traceRequest.slice_output_baseline = 480
  const result = await world.finishUntilPaused()

  assert.equal(result?.goalStatus, 'paused')
  const exceeded = world.events('budget.request_ceiling_exceeded')
  assert.equal(exceeded.length, 1)
  assert.equal(exceeded[0].data.request_output_ceiling, 5000, 'the ceiling value is unchanged')
  assert.equal(exceeded[0].data.request_output_units, 5280, 'the slice used 11 calls x 480 = 5,280 > 5,000')
  assert.equal(exceeded[0].data.aggregate_output_units, 5760)
  assert.equal(exceeded[0].data.slice_output_baseline, 480)
  assert.equal(world.calls, 12, 'the request-wide check would have paused a call earlier, at 11')
  assert.match(result.chatMessage, /^I paused this goal: this request used its whole output allowance for the current plan slice \(5,280 of 5,000 units across \d+ step budgets; 5,760 in all\)\. /)
  assert.ok(result.chatMessage.endsWith(RESUME_LINE))
  const state = world.memory.currentPlan('npc:sgluna')
  assert.equal(state.status, 'paused')
  assert.equal(state.pause_reason, 'request_output_ceiling: 5,280 > 5,000 output units')
  const capReached = world.events('budget.cap_reached').at(-1)
  assert.equal(capReached.data.request_output_units, 5280)
  assert.equal(capReached.data.aggregate_output_units, 5760)
  assert.equal(capReached.data.slice_output_baseline, 480)
  assert.equal(world.events('goal.paused')[0].data.cause, 'request_output_ceiling')
  assert.equal(world.events('request.completed').at(-1).data.outcome, 'paused_request_output_ceiling')
})

test('a restart, restore or recovery run never inherits a stale or negative slice baseline', async () => {
  const agent = makeAgent({ provider: async () => { throw new Error('no provider call in this test') } })
  // A supervisor recovery request has no baseline at all: it starts at 0.
  agent.traceRequest = { id: 'recovery_1', seq: 0 }
  assert.equal(agent.sliceOutputCeiling().baseline, 0)
  assert.equal(agent.sliceOutputCeiling().used, 0)

  // A baseline left over from a longer counter, with the aggregate now lower
  // (restart/restore): re-baselined to 0, never negative.
  agent.traceRequest = { id: 'recovery_2', seq: 0, usage: { output_units: 700 }, slice_output_baseline: 9000 }
  const view = agent.sliceOutputCeiling()
  assert.equal(view.baseline, 0)
  assert.equal(view.used, 700)
  assert.equal(view.exceeded, false)

  // A junk baseline is treated as 0.
  agent.traceRequest = { id: 'recovery_3', seq: 0, usage: { output_units: 700 }, slice_output_baseline: -25 }
  assert.equal(agent.sliceOutputCeiling().used, 700)

  // A slice close records the aggregate, never a negative, and restarts the count.
  await agent.closeOutputSlice('next_shelf_slice')
  assert.equal(agent.traceRequest.slice_output_baseline, 700)
  assert.equal(agent.sliceOutputCeiling().used, 0)
  // With no request there is nothing to reset and nothing throws.
  agent.traceRequest = null
  await agent.closeOutputSlice('next_shelf_slice')
  assert.equal(agent.sliceOutputCeiling().used, undefined)

})

test('a provider response with no usage is charged its requested output cap, toward the cap and the ceiling', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const noUsage = () => {
    const message = planMessage({ chatMessage: 'Waiting.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'ok', finish_reason: 'stop', requested_output_cap: 2000 },
    })
    return message
  }
  const agent = makeAgent({ maxProviderOutputUnits: 3000, provider: async () => noUsage() })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }

  await agent.request('run the bounded cycle', { sender: 'TTLouis' })
  const requestId = trace.find(record => record.event === 'request.received').request_id
  assert.equal(agent.providerBudgetGenerationOutputUnits, 2000)
  assert.equal(agent.traceRequest.usage.output_units, 2000)
  assert.equal(agent.traceRequest.usage.usage_complete, false)

  // The second unreported call brings the generation to 4,000 > 3,000.
  await agent.completed()
  const estimated = trace.filter(record => record.event === 'budget.usage_estimated')
  assert.equal(estimated.length, 1, 'traced once per request')
  assert.equal(estimated[0].request_id, requestId)
  assert.equal(estimated[0].data.estimated_output_units, 2000)
  assert.equal(estimated[0].data.estimate_source, 'requested_output_cap')
  const exceeded = trace.filter(record => record.event === 'budget.output_units_exceeded')
  assert.equal(exceeded[0]?.data.output_units, 4000)
})

test('a request ceiling hit with no plan state still ends in a visible pause line and goal.paused', async () => {
  const agent = makeAgent({ provider: async () => { throw new Error('no provider call in this test') } })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }
  agent.traceRequest = { id: 'req_ceiling_no_plan', seq: 0 }
  agent.active = true
  agent.runTurn = async () => {
    const error = new Error('request_output_ceiling: request used 5200 > 5000 output units across 3 budget generation(s)')
    error.code = 'request_output_ceiling'
    throw error
  }
  assert.equal(agent.memory.currentPlan('npc:sgluna'), undefined)
  const result = await agent.runGuarded()

  assert.ok(result.chatMessage.startsWith('I paused this goal: this request used its whole output allowance'))
  assert.ok(result.chatMessage.endsWith(RESUME_LINE))
  assert.equal(result.goalStatus, 'paused')
  const paused = trace.filter(record => record.event === 'goal.paused')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].request_id, 'req_ceiling_no_plan')
  assert.equal(paused[0].data.cause, 'request_output_ceiling')
  assert.equal(paused[0].data.plan_status, 'none')
  assert.equal(trace.filter(record => record.event === 'request.completed').at(-1).data.outcome, 'paused_request_output_ceiling')
  assert.equal(trace.some(record => record.event === 'request.failed'), false)
})

test('a supervisor recovery run never carries revision authority over a BLOCKED plan', async () => {
  // A lingering 'revise' choice (recorded earlier, never followed by the
  // player's revision) must not let recovery's sender=owner, text=objective
  // commit an unapproved plan version.
  const agent = makeAgent({
    provider: async () => planMessage({ chatMessage: '', plan: ['Only step'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] }),
  })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }
  await agent.request('wait for one cycle', { sender: 'TTLouis' })
  const key = 'npc:sgluna'
  agent.memory.blockRemainingPlan(key, {
    blocker: 'transfer_failed:nothing_moved',
    reason: 'furnace refused the item',
    evidenceKind: 'operation_error_receipt',
  })
  agent.memory.recordBlockedChoice(key, 'revise', 'TTLouis', { now: Date.now() })
  const before = agent.memory.planningState(key).plans.at(-1)
  assert.equal(before.status, 'BLOCKED')

  // What the supervisor's recovery sets up, then a plan submission.
  agent.requestInfo = { memoryKey: key, turnId: 99, sender: 'TTLouis', text: 'wait for one cycle' }
  agent.traceRequest = { id: 'recovery_test', seq: 0 }
  const info = await agent.revisionSafeRequestInfo()
  assert.equal(info.sender, undefined)
  assert.equal(info.text, undefined)
  const withheld = trace.filter(record => record.event === 'planning.revision_authority_withheld')
  assert.equal(withheld.length, 1)
  assert.equal(withheld[0].request_id, 'recovery_test')
  assert.equal(withheld[0].data.user_choice, 'revise')

  // A player chat request keeps its authority.
  agent.requestInfo = { ...agent.requestInfo, origin: 'chat' }
  assert.equal((await agent.revisionSafeRequestInfo()).sender, 'TTLouis')
})

test('a terminal budget failure after the budget handoff recovery also pauses visibly instead of failing silently', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const calls = []
  const events = []
  const agent = makeAgent({
    maxProviderOutputUnits: 3000,
    onActivity: (event, data) => events.push({ event, data }),
    provider: async () => {
      calls.push(calls.length + 1)
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
  // The recovery route itself throws a terminal budget error.
  agent.recoverPlan = async () => {
    const error = new Error('provider_output_budget_recovery_exhausted: fresh generation also spent its budget')
    throw error
  }
  await agent.request('run the bounded recovery check', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(result.goalStatus, 'paused')
  assert.match(result.chatMessage, /^I paused this goal: the model request ran out of budget \(provider_output_budget_recovery_exhausted\)\. Press Resume/)
  const paused = events.filter(entry => entry.event === 'budget.cap_reached')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].data.source, 'budget_recovery_failed')
  assert.equal(paused[0].data.previous_status, 'active')
  assert.equal(events.some(entry => entry.event === 'request.failed'), false)
  assert.equal(agent.memory.currentPlan('npc:sgluna').status, 'paused')
})

// ---------------------------------------------------------------------------
// 1.9 hook: the working-context compaction ceiling follows the provider
// profile's declared context window; profiles without one keep 28 / 40,000.
// ---------------------------------------------------------------------------

function ceilingAgent({ providerConfig, provider, rcon = new FakeRcon() } = {}) {
  const trace = []
  const agent = new NpcAgentLoop({
    rcon,
    provider: provider ?? (async () => planMessage({
      chatMessage: 'Waiting.',
      plan: ['Wait once'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    })),
    providerConfig,
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'compaction ceiling test prompt',
    stateFile: null,
    traceFile: null,
  })
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }
  return { agent, trace }
}

function toolExchange(id, chars) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'getActorStatus', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content: 'x'.repeat(chars) },
  ]
}

test('the local profile context window scales the compaction ceiling, and the choice is traced with the request_id', async () => {
  const local = { profile: 'local', model: 'qwen3-coder-30b-a3b-instruct', base: 'http://host.docker.internal:1234/v1', key: 'fixture-local' }
  const { agent, trace } = ceilingAgent({ providerConfig: local })
  assert.equal(agent.maxWorkingChars, 98304)
  assert.equal(agent.maxWorkingMessages, 64)

  await agent.request('wait once', { sender: 'TTLouis' })
  const requestId = trace.find(record => record.event === 'request.received').request_id
  const ceiling = trace.filter(record => record.event === 'compaction.ceiling')
  assert.equal(ceiling.length, 1, 'one ceiling event per request')
  assert.equal(ceiling[0].request_id, requestId)
  assert.deepEqual(ceiling[0].data, {
    reason: 'provider_call',
    source: 'provider_profile',
    context_window: 65536,
    max_working_chars: 98304,
    max_working_messages: 64,
    default_working_chars: 40000,
    default_working_messages: 28,
  })

  // Profiles that declare no window keep today's fixed ceiling.
  for (const providerConfig of [undefined, { profile: 'deepseek', model: 'deepseek-flash', base: 'https://api.deepseek.com/v1' }]) {
    const plain = ceilingAgent({ providerConfig })
    assert.equal(plain.agent.maxWorkingChars, 40000)
    assert.equal(plain.agent.maxWorkingMessages, 28)
    await plain.agent.request('wait once', { sender: 'TTLouis' })
    const event = plain.trace.find(record => record.event === 'compaction.ceiling')
    assert.equal(event.data.source, 'default')
    assert.equal(event.data.context_window, undefined)
    assert.equal(event.data.max_working_chars, 40000)
  }
})

test('a context window reported by the real provider stack rescales compaction, which then compacts what the default ceiling kept', async () => {
  // The loop is built without its provider config, as the supervisor builds
  // it today; provider-base reports the local profile's window per response.
  const localSmall = {
    profile: 'local',
    model: 'qwen3-coder-30b-a3b-instruct',
    base: 'http://host.docker.internal:1234/v1',
    key: 'fixture-local',
    contextWindow: 16384,
    timeoutMs: 5000,
  }
  const provider = (messages, context) => providerRequest(localSmall, messages, {
    ...context,
    promptTraceFile: null,
    fetchImpl: async () => new Response(JSON.stringify({
      id: 'local-replay',
      model: localSmall.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        chatMessage: '',
        plan: ['Wait once'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const { agent, trace } = ceilingAgent({ provider })
  await agent.request('wait once', { sender: 'TTLouis' })

  assert.equal(agent.maxWorkingChars, 24576)
  assert.equal(agent.maxWorkingMessages, 17)
  const events = trace.filter(record => record.event === 'compaction.ceiling')
  assert.deepEqual(events.map(record => [record.data.reason, record.data.source, record.data.max_working_chars]), [
    ['provider_call', 'default', 40000],
    ['context_window_reported', 'provider_response', 24576],
  ])
  assert.equal(events[1].data.context_window, 16384)
  assert.equal(events[1].request_id, events[0].request_id)

  // Three 10,000-character read results: under the default ceiling they all
  // stay; under the 16k-window ceiling the oldest is compacted (never the newest).
  const working = [
    { role: 'system', content: 'system' },
    ...toolExchange('a', 10000),
    ...toolExchange('b', 10000),
    ...toolExchange('c', 10000),
  ]
  const plain = ceilingAgent().agent
  plain.baseMessages = [working[0]]
  plain.messages = working.map(message => ({ ...message }))
  plain.compactWorkingContext()
  assert.equal(plain.messages.some(message => String(message.content).startsWith('[OBSERVATIONS COMPACTED]')), false)

  agent.baseMessages = [working[0]]
  agent.messages = working.map(message => ({ ...message }))
  agent.compactWorkingContext()
  const compacted = agent.messages.filter(message => String(message.content).startsWith('[OBSERVATIONS COMPACTED]'))
  assert.equal(compacted.length, 1)
  assert.equal(agent.messages.some(message => message.tool_call_id === 'c'), true, 'the newest exchange is kept')
  assert.equal(agent.messages.reduce((total, message) => total + String(message.content ?? '').length, 0) <= 24576 + 2000, true)
})

// --- U8: the budget handoff (C5) is a restage from a handoff packet -------------------

test('C5: the default handoff limit of 4 holds, every handoff is a restage row, and the fifth failure pauses visibly', async () => {
  const canonical = ['Inspect machine state', 'Continue the build']
  const calls = []
  const trace = []
  const agent = makeAgent({
    interactionDecisionProvider: rolloverDecisionProvider({ count: 0 }),
    provider: async (messages) => {
      calls.push(messages)
      if (calls.length === 1) {
        return planMessage({ chatMessage: 'Start one bounded runtime action.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
      }
      throw contextWindowError()
    },
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }

  await agent.request('exercise the handoff limit', { sender: 'TTLouis' })
  const result = await agent.completed()

  assert.equal(agent.maxProviderBudgetHandoffs, 4)
  assert.equal(agent.providerBudgetHandoffCount, 4)
  assert.equal(calls.length, 6, 'the plan, the failure that started the handoffs, then one round per handoff: no fifth handoff')
  assert.equal(result.goalStatus, 'paused', 'the goal pauses visibly after the limit, it is not blocked')
  assert.equal(agent.memory.currentPlan('npc:sgluna').status, 'paused')
  assert.equal(trace.filter(record => record.event === 'budget.handoff_limit_reached').length, 1)

  const restaged = trace.filter(record => record.event === 'context.restaged')
  assert.equal(restaged.length, 4, 'one restage per handoff')
  const ids = new Set()
  for (const [index, row] of restaged.entries()) {
    assert.equal(row.data.checkpoint, 'C5')
    assert.equal(row.data.role, 'planner', 'the same role as the exhausted conversation')
    assert.match(row.data.handoff_id, /^ho_[0-9a-f]{12}$/)
    assert.ok(row.request_id, 'the row carries the request id')
    assert.match(row.data.reason, /^provider_budget_handoff scope=keep_target cause=/)
    ids.add(row.data.handoff_id)
    assertC5Packet(calls[index + 2])
    assert.match(calls[index + 2][2].content, new RegExp(`handoff ${index + 1} of 4`))
  }
  assert.equal(ids.size, 4, 'each handoff is its own conversation')
  // The reducer's ledger is the durable record; plan semantics did not move.
  const planning = agent.memory.planningState('npc:sgluna')
  assert.deepEqual(planning.context_restages.filter(item => item.checkpoint === 'C5').map(item => item.handoff_id), [...ids])
  assert.equal(planning.reasoning_epoch, 1, 'restage never touches the reasoning epoch (goal acceptance set it)')
})

test('C5: a refused restage falls back to the legacy capsule and says so, so the fresh generation never runs on the exhausted thread', async () => {
  const canonical = ['Inspect machine state', 'Continue the build']
  const calls = []
  const trace = []
  const agent = makeAgent({
    interactionDecisionProvider: rolloverDecisionProvider({ count: 0 }),
    provider: async (messages) => {
      calls.push(messages)
      if (calls.length === 1) return planMessage({ chatMessage: 'One action.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
      if (calls.length === 2) throw contextWindowError()
      return planMessage({ chatMessage: 'Continued.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
    },
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  agent.restageInTurn = async () => ({ restaged: false, reason: 'reducer_rejected_context_restaged' })

  await agent.request('exercise the fallback', { sender: 'TTLouis' })
  await agent.completed()

  assert.equal(calls.length, 3)
  assert.ok(calls[2].some(message => String(message.content ?? '').startsWith('[PROVIDER_BUDGET_HANDOFF]')))
  assert.ok(!calls[2].some(message => message.role === 'assistant' || message.role === 'tool'), 'still none of the exhausted thread')
  const fallback = trace.filter(record => record.event === 'budget.handoff_restage_fallback')
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].data.reason, 'reducer_rejected_context_restaged')
  assert.equal(trace.filter(record => record.event === 'context.restaged').length, 0)
})

test('C5: Resume after the request ceiling restages from a packet, the ceiling pause itself stays visible, and the restage never advances the plan', async () => {
  const canonical = ['Wait for the machine cycle', 'Inspect the result']
  const over = () => {
    const message = planMessage({ chatMessage: 'Thinking long.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
    Object.defineProperty(message, '_sglunaProvider', {
      enumerable: false,
      value: { diagnostic_code: 'ok', finish_reason: 'stop', usage: { prompt_tokens: 100, completion_tokens: 3500, total_tokens: 3600 } },
    })
    return message
  }
  let resumed = false
  const resumeMessages = []
  let calls = 0
  const agent = makeAgent({
    maxProviderOutputUnits: 3000,
    maxProviderBudgetHandoffs: 1,
    provider: async (messages) => {
      calls++
      if (resumed) {
        resumeMessages.push(messages)
        return planMessage({ chatMessage: 'Waiting.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] })
      }
      return calls === 1 ? planMessage({ chatMessage: 'Waiting first.', plan: canonical, currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] }) : over()
    },
  })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }

  await agent.request('run the bounded cycle', { sender: 'TTLouis' })
  const paused = await agent.completed()
  assert.equal(paused.goalStatus, 'paused')
  assert.equal(trace.filter(record => record.event === 'goal.paused').length, 1, 'the pause is visible')
  const before = agent.memory.planningState('npc:sgluna')
  const tracker = before.plans.at(-1).active_step_index

  resumed = true
  const result = await agent.request('continue', { sender: 'TTLouis' })
  assert.equal(result.goalStatus, 'active')
  const restaged = trace.filter(record => record.event === 'context.restaged')
  const resume = restaged.at(-1)
  assert.equal(resume.data.checkpoint, 'C5')
  assert.equal(resume.data.role, 'planner')
  assert.match(resume.data.handoff_id, /^ho_/)
  assert.match(resume.data.reason, /^provider_budget_resume scope=keep_target cause=recoverable_provider_failure:provider_budget/)
  assertC5Packet(resumeMessages[0], { kind: 'resume' })
  assert.match(resumeMessages[0][2].content, /active_step: 1 of 2 .*Wait for the machine cycle/)
  assert.equal(agent.memory.planningState('npc:sgluna').plans.at(-1).active_step_index, tracker, 'the restage did not advance the tracker')
})

test('C5: the request output ceiling still pauses visibly, and Resume after it restages from a packet with the ceiling as the reason code', async () => {
  const world = runawayHarness()
  await world.agent.request('mine a long list of ore batches', { sender: 'TTLouis' })
  const requestId = world.events('request.received')[0].request_id
  const paused = await world.finishUntilPaused()
  assertCeilingPause(world, paused, requestId)
  assert.equal(world.events('context.restaged').length, 0, 'the ceiling pause itself restages nothing: no fresh generation')

  // (The runaway fixture's scripted provider reacts to the resumed board and may pause again; only the restage is asserted.)
  await world.agent.request('continue', { sender: 'TTLouis' })
  const [row] = world.events('context.restaged')
  assert.equal(row.data.checkpoint, 'C5')
  assert.equal(row.data.role, 'planner')
  assert.match(row.data.handoff_id, /^ho_/)
  assert.match(row.data.reason, /^provider_budget_resume scope=keep_target cause=request_output_ceiling/)
  assert.notEqual(row.request_id, requestId, 'the Resume is a new request with a new allowance')
  assert.equal(world.memory.planningState('npc:sgluna').context_restages.at(-1).handoff_id, row.data.handoff_id)
})
