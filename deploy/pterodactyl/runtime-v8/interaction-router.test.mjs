import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop, interactionRuntimeHealthy, parseInteractionRoute } from './npc-agent-loop.mjs'

function deployment() {
  return {
    revision: 'airi-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activePlan() {
  return {
    goal_id: 'goal_existing',
    owner: 'tester',
    objective: 'build a continuous early iron production line',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['clear the area', 'place production'],
    current_step: 1,
    revision: 1,
    last_chat_message: 'Building.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_existing',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 1,
      total_steps: 2,
      active_index: 1,
      active_step_id: 'step_2',
      steps: [
        { id: 'step_1', description: 'clear the area', status: 'completed' },
        { id: 'step_2', description: 'place production', status: 'active' },
      ],
      evidence: [],
    },
  }
}

class RouterRcon {
  constructor({ running = true } = {}) {
    this.running = running
    this.commands = []
    this.cancelCount = 0
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify(this.running
        ? { task_state: 'placing', queue_empty: false, queue_length: 4, current_task: { type: 'placing', entity_name: 'machine-x' } }
        : { task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('cancel_all_tasks')) {
      this.cancelCount++
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true]] })}`
    }
    if (text.includes('AIRI_RESULT_') && text.includes('autorio_operations')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({ ok: true, result: [[true, 'Task started']] })}`
    }
    return '{}'
  }
}

function agentFor(intent, {
  running = true,
  withPlan = true,
  queueConflict = intent === 'amend_current',
  decisionIntent,
  decisionGranularity = 'keep',
  decisionConflictProbability = 0.2,
  decisionError,
  decisionTraceFile = null,
  routerError,
} = {}) {
  const memory = new CanonicalTaskBoardMemory()
  if (withPlan) memory.planByNpc.set('npc:airi', activePlan())
  const rcon = new RouterRcon({ running })
  const calls = []
  const decisionCalls = []
  const mockProvider = async (_messages, context) => {
    calls.push(context)
    if (context.interactionRouter) {
      assert.equal(context.allowTools, false)
      assert.equal(context.triggerSource, 'interaction_router')
      if (routerError) throw new Error(routerError)
      return { content: JSON.stringify({ intent, queue_conflict: intent === 'amend_current' ? queueConflict : false, reply: intent === 'chat_only' ? 'Hello from the side router.' : '' }) }
    }
    return {
      content: JSON.stringify({
        chatMessage: 'Replanned current work.',
        plan: ['continue the updated production goal'],
        currentStep: 0,
        operations: [{ name: 'wait', args: { ticks: 1 } }],
      }),
    }
  }
  const interactionDecisionProvider = decisionIntent || decisionError
    ? async (state, questions, context) => {
        decisionCalls.push({ state, questions, context })
        if (decisionError) throw new Error(decisionError)
        const probabilities = Object.fromEntries(Object.keys(questions.intent.criteria).map(key => [key, key === decisionIntent ? 0.95 : 0.01]))
        return {
          model: 'jev-latest',
          provider: 'TypeSafe',
          answers: {
            intent: {
              type: 'choice',
              choice: decisionIntent,
              probabilities,
              confidence: 0.91,
            },
            queue_conflict: {
              type: 'noul',
              noul: decisionConflictProbability,
            },
            reasoning_budget: { type: 'choice', choice: decisionGranularity === 'split' ? 'strategic' : 'normal', confidence: 0.85 },
            planning_horizon: { type: 'choice', choice: decisionGranularity === 'split' ? 'strategic' : 'checkpoint', confidence: 0.84 },
            observation_budget: { type: 'score', score: decisionGranularity === 'split' ? 3 : 1, confidence: 0.83 },
          },
          usage: {
            input_tokens: 120,
            output_tokens: 20,
            cost: 0.00000504,
          },
        }
      }
    : undefined

  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'main planner',
    npcId: 'airi',
    provider: mockProvider,
    interactionProvider: mockProvider,
    interactionDecisionProvider,
    traceFile: null,
    decisionTraceFile,
  })
  if (running && withPlan) {
    agent.active = true
    agent.epoch = deployment()
    agent.lastMemoryKey = 'npc:airi'
    agent.baseMessages = [
      { role: 'system', content: agent.systemPrompt },
      { role: 'user', content: memory.planContext('npc:airi') },
      { role: 'user', content: '[CHAT] tester: build a continuous early iron production line' },
    ]
    agent.messages = agent.baseMessages.map(message => ({ ...message }))
    agent.requestInfo = { memoryKey: 'npc:airi', turnId: 1, sender: 'tester', text: 'build a continuous early iron production line' }
  }
  return { agent, memory, rcon, calls, decisionCalls }
}

test('interaction route parser is strict and runtime health uses authoritative task state', () => {
  assert.deepEqual(parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":false,"reply":""}' }), { intent: 'status_query', queue_conflict: false, reply: '' })
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":false,"reply":"","operations":[]}' }))
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"bogus","queue_conflict":false,"reply":""}' }))
  assert.throws(() => parseInteractionRoute({ content: '{"intent":"status_query","queue_conflict":true,"reply":""}' }))
  assert.equal(interactionRuntimeHealthy({ task_state: 'placing', queue_length: 0 }), true)
  assert.equal(interactionRuntimeHealthy({ task_state: 'idle', queue_length: 0 }), false)
  assert.equal(interactionRuntimeHealthy({ task_state: 'IDLE', queue_length: 0 }), false)
  assert.equal(interactionRuntimeHealthy({ task_state: '  Idle  ', queue_length: 0 }), false)
})

test('constructor initializes routed lifecycle without requiring an intent variable in scope', () => {
  const memory = new CanonicalTaskBoardMemory()
  const mockProvider = async () => ({ content: '{"chatMessage":"","plan":[],"currentStep":0,"operations":[]}' })
  const agent = new NpcAgentLoop({
    rcon: new RouterRcon({ running: false }),
    memory,
    systemPrompt: 'constructor regression',
    npcId: 'airi',
    provider: mockProvider,
    interactionProvider: mockProvider,
    traceFile: null,
    stateFile: null,
  })

  assert.equal(agent.requestLifecycle, 'new_goal')
  assert.equal(agent.pendingInteractionAmendment, null)
})

test('Jev shadow disagreement is observed without changing the active interaction route', async () => {
  const { agent, rcon, calls, decisionCalls } = agentFor('status_query', { decisionIntent: 'new_goal' })
  const result = await agent.request('what are you doing?', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(decisionCalls.length, 1)
  assert.equal(decisionCalls[0].state.message, 'what are you doing?')
  assert.equal(decisionCalls[0].questions.intent.type, 'choice')
  assert.equal(decisionCalls[0].questions.queue_conflict.type, 'noul')
  assert.equal(decisionCalls[0].questions.reasoning_budget.type, 'choice')
  assert.equal(decisionCalls[0].questions.planning_horizon.type, 'choice')
  assert.equal(decisionCalls[0].questions.observation_budget.type, 'score')
  assert.ok(decisionCalls[0].context.signal instanceof AbortSignal)
  assert.equal(rcon.cancelCount, 0)
})


test('Jev shadow writes a dedicated decision lifecycle trace without copying the player message', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-jev-trace-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const decisionTraceFile = path.join(dir, 'decision.jsonl')
  const { agent } = agentFor('status_query', { decisionIntent: 'new_goal', decisionTraceFile })

  await agent.request('what are you doing?', { sender: 'tester' })
  const events = (await fsp.readFile(decisionTraceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

  assert.deepEqual(events.map(event => event.event), ['decision.request', 'decision.response', 'decision.route_applied'])
  assert.equal(events[0].data.contract, 'interaction_route')
  assert.equal(events[0].data.mode, 'shadow')
  assert.equal(events[0].data.message_chars, 'what are you doing?'.length)
  assert.equal(events[0].data.message, undefined)
  assert.deepEqual(events[0].data.question_ids, ['intent', 'queue_conflict', 'reasoning_budget', 'planning_horizon', 'observation_budget'])
  assert.equal(events[1].data.intent, 'new_goal')
  assert.equal(events[1].data.input_units, 120)
  assert.equal(events[1].data.output_units, 20)
  assert.equal(events[2].data.active_source, 'interaction_router')
  assert.equal(events[2].data.active_intent, 'status_query')
  assert.equal(events[2].data.shadow_intent, 'new_goal')
  assert.equal(events[2].data.agreement, false)
})

test('Jev shadow provider failure records fallback while the existing router remains authoritative', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-jev-fallback-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const decisionTraceFile = path.join(dir, 'decision.jsonl')
  const { agent } = agentFor('status_query', { decisionError: 'temporary Jev outage', decisionTraceFile })

  const result = await agent.request('status?', { sender: 'tester' })
  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)

  const events = (await fsp.readFile(decisionTraceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.event), ['decision.request', 'decision.fallback', 'decision.route_applied'])
  assert.equal(events[1].data.fallback_target, 'interaction_router')
  assert.match(events[1].data.reason, /temporary Jev outage/)
  assert.equal(events[2].data.active_intent, 'status_query')
  assert.equal(events[2].data.shadow_available, false)
})

test('idle no-plan status query is classified, reaches Jev shadow, and skips the main planner', async () => {
  const { agent, memory, rcon, calls, decisionCalls } = agentFor('status_query', {
    running: false,
    withPlan: false,
    decisionIntent: 'new_goal',
  })

  const result = await agent.request('What are you doing right now?', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].interactionRouter, true)
  assert.equal(decisionCalls.length, 1)
  assert.equal(decisionCalls[0].state.current_goal, null)
  assert.equal(decisionCalls[0].state.runtime.task_state, 'idle')
  assert.equal(decisionCalls[0].state.runtime.queue_length, 0)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(Boolean(memory.currentPlan('npc:airi')), false)
})

test('idle no-plan chat_only is routed without the main planner and reaches Jev shadow', async () => {
  const { agent, memory, calls, decisionCalls } = agentFor('chat_only', {
    running: false,
    withPlan: false,
    decisionIntent: 'chat_only',
  })

  const result = await agent.request('How are things going?', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'chat_only')
  assert.equal(result.routedOnly, true)
  assert.equal(result.chatMessage, 'Hello from the side router.')
  assert.equal(calls.length, 1)
  assert.equal(decisionCalls.length, 1)
  assert.equal(Boolean(memory.currentPlan('npc:airi')), false)
})

test('idle no-plan real new goal is classified before the main planner runs once', async () => {
  const { agent, rcon, calls, decisionCalls } = agentFor('new_goal', {
    running: false,
    withPlan: false,
    decisionIntent: 'chat_only',
  })

  const result = await agent.request('Build a small coal production setup.', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'new_goal')
  assert.equal(result.routedOnly, false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].interactionRouter, true)
  assert.equal(calls[1].triggerSource, 'new_goal')
  assert.equal(decisionCalls.filter(call => call.questions?.intent).length, 1)
  assert.equal(decisionCalls.filter(call => call.state?.contract === 'step_checkpoint_normalizer').length, 1)
  assert.equal(rcon.cancelCount, 0)
})

test('idle no-plan Jev shadow failure does not alter the active routed interaction', async () => {
  const { agent, memory, rcon, calls, decisionCalls } = agentFor('status_query', {
    running: false,
    withPlan: false,
    decisionError: 'temporary Jev outage',
  })

  const result = await agent.request('What are you doing right now?', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(decisionCalls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(Boolean(memory.currentPlan('npc:airi')), false)
})

test('idle no-plan interaction-router failure keeps the conservative new_goal fallback', async () => {
  const { agent, rcon, calls } = agentFor('status_query', {
    running: false,
    withPlan: false,
    routerError: 'temporary interaction-router outage',
  })

  const result = await agent.request('Build a small coal production setup.', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'new_goal')
  assert.equal(result.routedOnly, false)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].interactionRouter, true)
  assert.equal(calls[1].triggerSource, 'new_goal')
  assert.equal(rcon.cancelCount, 0)
})

test('cancelling the agent aborts an in-flight Jev shadow decision', async () => {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', activePlan())
  const rcon = new RouterRcon({ running: true })

  let decisionSignal
  let routerSignal
  let releaseRouter
  const routerWait = new Promise(resolve => { releaseRouter = resolve })

  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'interaction cancellation test',
    npcId: 'airi',
    provider: async () => {
      throw new Error('main planner should not run')
    },
    interactionProvider: async (_messages, context) => {
      routerSignal = context.signal
      await routerWait
      if (context.signal.aborted) throw new Error('router aborted')
      return { content: JSON.stringify({ intent: 'status_query', queue_conflict: false, reply: '' }) }
    },
    interactionDecisionProvider: async (_state, _questions, context) => {
      decisionSignal = context.signal
      await new Promise((resolve, reject) => {
        if (context.signal.aborted) return reject(new Error('decision aborted'))
        context.signal.addEventListener('abort', () => reject(new Error('decision aborted')), { once: true })
      })
      throw new Error('unreachable')
    },
    traceFile: null,
    stateFile: null,
  })

  const pending = agent.request('status?', { sender: 'tester' })
  for (let index = 0; index < 50; index++) {
    if (decisionSignal && routerSignal) break
    await new Promise(resolve => setTimeout(resolve, 1))
  }

  assert.ok(decisionSignal)
  assert.equal(decisionSignal, routerSignal)
  agent.cancel('test_cancel')
  assert.equal(decisionSignal.aborted, true)
  releaseRouter()

  await pending.catch(() => undefined)
  assert.equal(agent.interactionAbort, null)
})

test('continue_current while Autorio is healthy does not restart the main planner or cancel world work', async () => {
  const { agent, rcon, calls, memory } = agentFor('continue_current')
  const result = await agent.request('你直接继续吧', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'continue_current')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})

test('status_query answers from authoritative task state without a planning cycle', async () => {
  const { agent, rcon, calls } = agentFor('status_query')
  const result = await agent.request('给我汇报一下你那里卡住了', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'status_query')
  assert.equal(result.routedOnly, true)
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.match(result.chatMessage, /placing/)
  assert.match(result.chatMessage, /4 queued tasks/)
})

test('chat_only does not alter current task state and uses only the side-router reply', async () => {
  const { agent, rcon, calls, memory } = agentFor('chat_only')
  const result = await agent.request('辛苦了', { sender: 'tester' })

  assert.equal(result.routedOnly, true)
  assert.equal(result.chatMessage, 'Hello from the side router.')
  assert.equal(calls.length, 1)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(memory.currentPlan('npc:airi')?.status, 'active')
})

test('amend_current cancels remaining Autorio work once, preserves the canonical goal, then replans', async () => {
  const { agent, rcon, calls, memory } = agentFor('amend_current')
  const result = await agent.request('你直接继续吧，不要管周围了', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'amend_current')
  assert.equal(result.routedOnly, false)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'amend_current')
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})

test('compatible same-goal amendment does not cancel an active queue and is deferred to the next main-planner boundary', async () => {
  const { agent, rcon, calls, memory } = agentFor('amend_current', { queueConflict: false })
  const result = await agent.request('继续当前目标，但之后优先把炉子排紧一点', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'amend_current')
  assert.equal(result.routedOnly, true)
  assert.equal(result.amendmentDeferred, true)
  assert.equal(rcon.cancelCount, 0)
  assert.equal(calls.length, 1)
  assert.equal(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')

  const completion = await agent.completed()
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'amend_current')
  assert.equal(completion.interactionIntent, undefined)
})

test('cancel_current uses authoritative cancellation without launching the main planner', async () => {
  const { agent, rcon, calls, memory } = agentFor('cancel_current')
  const result = await agent.request('停下这个任务', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'cancel_current')
  assert.equal(result.routedOnly, true)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 1)
  assert.equal(memory.currentPlan('npc:airi')?.status, 'paused')
})

test('true new_goal clears the previous canonical task context and starts main planning with new_goal routing', async () => {
  const { agent, rcon, calls, memory } = agentFor('new_goal')
  const result = await agent.request('改做一条铜板生产线', { sender: 'tester' })

  assert.equal(result.interactionIntent, 'new_goal')
  assert.equal(result.routedOnly, false)
  assert.equal(rcon.cancelCount, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].triggerSource, 'new_goal')
  assert.notEqual(memory.currentPlan('npc:airi')?.goal_id, 'goal_existing')
})


test('interaction router does not receive historical exact ids from durable goal fields', async () => {
  const memory = new CanonicalTaskBoardMemory()
  const state = activePlan()
  state.objective = 'return to unit 331 and finish the furnace'
  state.task_board.steps[1].description = 'load unit_number=331 at the remembered furnace'
  memory.planByNpc.set('npc:airi', state)

  let routedMessages
  const interactionProvider = async (messages, context) => {
    assert.equal(context.interactionRouter, true)
    routedMessages = messages
    return { content: JSON.stringify({ intent: 'status_query', queue_conflict: false, reply: '' }) }
  }
  const agent = new NpcAgentLoop({
    rcon: new RouterRcon({ running: true }),
    memory,
    systemPrompt: 'interaction durable identity boundary test',
    npcId: 'airi',
    provider: async () => {
      throw new Error('main planner should not run for status_query')
    },
    interactionProvider,
    traceFile: null,
    stateFile: null,
  })

  const result = await agent.request('status?', { sender: 'tester' })
  assert.equal(result.routedOnly, true)
  const contextText = routedMessages.map(message => String(message.content ?? '')).join('\n')
  assert.doesNotMatch(contextText, /331/)
  assert.match(contextText, /historical exact identity \[omitted\]|historical-id-omitted/)
})


test('Jev observation budget is enforced before decision pressure', async () => {
  const { agent } = agentFor('new_goal', { running: false, withPlan: false })
  agent.active = true
  agent.epoch = deployment()
  agent.messages = [{ role: 'system', content: 'budget enforcement test' }]
  agent.observationBudgetOverride = 1
  agent.observationBudgetRemaining = 1

  const first = {
    tool_calls: [{
      id: 'obs-1',
      type: 'function',
      function: { name: 'getActorStatus', arguments: '{}' },
    }],
  }
  await agent.handleToolBatch(first)
  assert.equal(agent.observationBudgetRemaining, 0)
  const firstToolResults = agent.messages.filter(message => message.role === 'tool').length
  assert.equal(firstToolResults, 1)
  assert.match(agent.messages.map(message => String(message.content ?? '')).join('\n'), /observation budget is exhausted/i)

  const second = {
    tool_calls: [{
      id: 'obs-2',
      type: 'function',
      function: { name: 'getTaskStatus', arguments: '{}' },
    }],
  }
  await agent.handleToolBatch(second)
  assert.equal(agent.messages.filter(message => message.role === 'tool').length, firstToolResults)
  assert.equal(agent.observationDecisionForced, true)
  assert.equal(agent.observationBudgetRemaining, 0)
})
