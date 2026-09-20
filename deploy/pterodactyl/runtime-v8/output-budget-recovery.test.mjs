import assert from 'node:assert/strict'
import test from 'node:test'

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

function makeAgent({ provider, rcon = new FakeRcon(), reserve = async () => ({}) } = {}) {
  return new NpcAgentLoop({
    rcon,
    provider,
    reserve,
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'NPC output-budget recovery test prompt',
    stateFile: null,
    traceFile: null,
    maxRecoveryAttempts: 2,
  })
}

test('first tool-capable output-budget exhaustion gets exactly one tool-capable recovery before the existing bounded recovery path', async () => {
  const calls = []
  let reserves = 0
  const agent = makeAgent({
    reserve: async () => { reserves++; return {} },
    provider: async (messages, context) => {
      calls.push({ messages, context })
      if (calls.length <= 2) return exhaustedMessage()
      return planMessage({ chatMessage: 'Recovered through the existing strict-plan path.' })
    },
  })

  const result = await agent.request('inspect the area', { sender: 'TTLouis' })

  assert.equal(result.chatMessage, 'Recovered through the existing strict-plan path.')
  assert.equal(calls.length, 3)
  assert.equal(reserves, 3)

  assert.equal(calls[0].context.allowTools, true)
  assert.equal(calls[0].context.recoveryAttempt, 0)
  assert.equal(calls[0].context.recoveryKind, undefined)

  assert.equal(calls[1].context.allowTools, true)
  assert.equal(calls[1].context.recoveryAttempt, 1)
  assert.equal(calls[1].context.recoveryKind, 'output_budget_exhaustion')
  assert.match(calls[1].messages.at(-1).content, /immediately preceding provider response exhausted its output budget/)
  assert.match(calls[1].messages.at(-1).content, /Tools remain available/)

  assert.equal(calls[2].context.allowTools, false)
  assert.equal(calls[2].context.recoveryAttempt, 1)
  assert.equal(calls[2].context.recoveryKind, undefined)
  const boundedRecoveryContext = calls[2].messages.map(message => message.content ?? '').join('\n')
  assert.match(boundedRecoveryContext, /Tool calls are disabled for recovery/)
  assert.doesNotMatch(boundedRecoveryContext, /immediately preceding provider response exhausted its output budget/)
})

test('output-budget recovery keeps the canonical Task Board at the evidenced step and does not replay the completed mutation', async () => {
  const canonical = ['Wait for the machine cycle', 'Mine ore', 'Verify output']
  const calls = []
  const rcon = new FakeRcon()
  let reserves = 0
  let agent

  agent = makeAgent({
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
  const recovered = await agent.completed()

  assert.equal(recovered.goalStatus, 'blocked')
  assert.deepEqual(recovered.plan, canonical)
  assert.equal(recovered.currentStep, 0)
  assert.equal(recovered.taskBoard.status, 'blocked')
  assert.equal(recovered.taskBoard.active_index, 0)
  assert.equal(recovered.taskBoard.total_steps, 3)
  assert.equal(recovered.taskBoard.evidence.some(item => item.kind === 'deterministic_verification'), false)

  const durable = agent.memory.currentPlan('npc:airi')
  assert.ok(durable)
  assert.equal(durable.status, 'blocked')
  assert.deepEqual(durable.plan, canonical)
  assert.equal(durable.current_step, 0)
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
