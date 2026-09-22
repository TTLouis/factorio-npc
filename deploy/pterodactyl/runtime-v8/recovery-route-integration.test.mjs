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
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activeState({ finalProof = false } = {}) {
  const steps = finalProof
    ? [{ id: 'step_1', description: 'Verify the result', status: 'active' }]
    : [
        { id: 'step_1', description: 'Perform the step', status: 'active' },
        { id: 'step_2', description: 'Verify the result', status: 'pending' },
      ]
  return {
    goal_id: 'goal_recovery',
    owner: 'tester',
    objective: 'perform a bounded recovery test',
    status: 'active',
    admission_status: undefined,
    blocker: '',
    pause_reason: '',
    plan: steps.map(step => step.description),
    current_step: 0,
    revision: 1,
    last_chat_message: '',
    last_operations: [],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: finalProof,
    last_verified_batch_id: finalProof ? 9 : undefined,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_recovery',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 1,
      completed_count: 0,
      total_steps: steps.length,
      active_index: 0,
      active_step_id: 'step_1',
      steps,
      evidence: finalProof
        ? [{
            id: 'evidence_1',
            kind: 'deterministic_verification',
            ref: 'batch_9',
            summary: JSON.stringify({ verdict: 'verified_complete' }),
            step_id: 'step_1',
            at: Date.now(),
          }]
        : [],
      events: [],
    },
  }
}

class RecoveryRcon {
  constructor({ taskState = 'idle', queueLength = 0 } = {}) {
    this.taskState = taskState
    this.queueLength = queueLength
    this.mutations = []
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: this.taskState,
        queue_empty: this.queueLength === 0,
        queue_length: this.queueLength,
      })
    }
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify({ active: false, healthy: false, controller_live: false, state: 'idle' })
    }
    if (text.includes('remote.call("autorio_preflight","operation"')) return JSON.stringify({ ok: true })
    if (text.includes('local ok,result=pcall')) {
      const marker = text.match(/AIRI_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const count = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

function decisionResponse(route, failureClass = 'unknown') {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      failure_class: { type: 'choice', choice: failureClass, confidence: 0.9 },
      next_recovery: { type: 'choice', choice: route, confidence: 0.95 },
    },
    usage: { input_tokens: 90, output_tokens: 10, cost: 0.0000042 },
  }
}

function planMessage() {
  return {
    content: JSON.stringify({
      chatMessage: 'Resume with one bounded action.',
      plan: ['Perform the step', 'Verify the result'],
      currentStep: 0,
      operations: [{ name: 'wait', args: { ticks: 1 } }],
    }),
  }
}

function makeAgent({
  route = 'wake_planner',
  failureClass = 'unknown',
  taskState = 'idle',
  queueLength = 0,
  finalProof = false,
  decisionProvider,
  provider,
} = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', activeState({ finalProof }))
  const mainCalls = []
  const decisionCalls = []
  const agent = new NpcAgentLoop({
    rcon: new RecoveryRcon({ taskState, queueLength }),
    memory,
    npcId: 'airi',
    systemPrompt: 'recovery router test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    interactionDecisionProvider: decisionProvider ?? (async (state, questions) => {
      decisionCalls.push({ state, questions })
      return decisionResponse(route, failureClass)
    }),
    provider: provider ?? (async (_messages, options) => {
      mainCalls.push(options)
      return planMessage()
    }),
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:airi'
  agent.requestInfo = {
    memoryKey: 'npc:airi',
    turnId: 1,
    sender: 'tester',
    text: 'perform a bounded recovery test',
  }
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: '[CHAT] tester: perform a bounded recovery test' },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  return { agent, memory, mainCalls, decisionCalls }
}

test('M9 continue_runtime skips the planner only while runtime is authoritatively active', async () => {
  const active = makeAgent({ route: 'continue_runtime', failureClass: 'runtime_busy', taskState: 'mining', queueLength: 1 })
  const result = await active.agent.recoverPlan(active.agent.generation, new Error('provider timeout'), 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(active.mainCalls.length, 0)
  assert.equal(active.decisionCalls.length, 1)

  const idle = makeAgent({ route: 'continue_runtime', failureClass: 'runtime_busy', taskState: 'idle', queueLength: 0 })
  const resumed = await idle.agent.recoverPlan(idle.agent.generation, new Error('provider timeout'), 1)
  assert.equal(resumed.operations.length, 1)
  assert.equal(idle.mainCalls.length, 1)
  assert.equal(idle.mainCalls[0].triggerSource, 'recovery_continue_low')
})

test('M9 deterministic final completion bypasses Jev and the main planner entirely', async () => {
  const { agent, mainCalls, decisionCalls } = makeAgent({
    route: 'wake_planner',
    failureClass: 'provider_format',
    finalProof: true,
  })
  const result = await agent.recoverPlan(agent.generation, new Error('invalid provider JSON'), 1)
  assert.equal(result.goalStatus, 'completed')
  assert.equal(mainCalls.length, 0)
  assert.equal(decisionCalls.length, 0)
})

test('M9 wake_planner uses low reasoning for provider-format recovery', async () => {
  const { agent, mainCalls } = makeAgent({ route: 'wake_planner', failureClass: 'provider_format' })
  const result = await agent.recoverPlan(agent.generation, new Error('invalid provider JSON'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(mainCalls.length, 1)
  assert.equal(mainCalls[0].triggerSource, 'recovery_continue_low')
  assert.equal(mainCalls[0].allowTools, false)
})

test('M9 wake_planner uses high reasoning for semantic recovery', async () => {
  const { agent, mainCalls } = makeAgent({ route: 'wake_planner', failureClass: 'semantic_replan' })
  const result = await agent.recoverPlan(agent.generation, new Error('strategy invalidated by fresh evidence'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(mainCalls.length, 1)
  assert.equal(mainCalls[0].triggerSource, 'recovery_replan_high')
})

test('M9 observe maps to one bounded targeted-observation planner turn', async () => {
  const { agent, decisionCalls } = makeAgent({ route: 'observe', failureClass: 'missing_fact' })
  const routed = await agent.routeRecoveryDecision(new Error('one targeted observation is missing'), 2)
  assert.equal(routed.route, 'targeted_observation')
  assert.deepEqual(Object.keys(decisionCalls[0].questions.next_recovery.criteria), [
    'continue_runtime',
    'observe',
    'wake_planner',
    'ask_user',
  ])
})

test('duplicate recovery event coalesces the Jev call', async () => {
  const { agent, decisionCalls } = makeAgent({ route: 'continue_runtime', failureClass: 'runtime_busy', taskState: 'mining', queueLength: 1 })
  const reason = new Error('provider timeout')
  const first = await agent.routeRecoveryDecision(reason, 2)
  const second = await agent.routeRecoveryDecision(reason, 2)
  assert.equal(first.route, 'wait_runtime')
  assert.equal(second.route, 'wait_runtime')
  assert.equal(second.duplicate, true)
  assert.equal(decisionCalls.length, 1)
})

test('recovery Jev cancellation cannot apply a stale decision', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { agent } = makeAgent({
    decisionProvider: async () => {
      await pending
      return decisionResponse('wake_planner', 'semantic_replan')
    },
  })
  const routing = agent.routeRecoveryDecision(new Error('semantic failure'), 1)
  agent.cancel('new_task')
  release()
  await assert.rejects(routing, /cancelled|superseded/i)
})

test('M9 ask_user cannot manufacture a durable blocker from an active recovery', async () => {
  const { agent, memory, mainCalls } = makeAgent({
    route: 'ask_user',
    failureClass: 'grounded_world_failure',
    taskState: 'idle',
    queueLength: 0,
  })
  const result = await agent.recoverPlan(agent.generation, new Error('provider claims capability missing'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(memory.planByNpc.get('npc:airi').status, 'active')
  assert.equal(memory.planByNpc.get('npc:airi').blocker, '')
  assert.equal(mainCalls.length, 1)
})

test('older world evidence cannot let an M9 recovery routing choice create durable BLOCKED', async () => {
  const { agent, memory, mainCalls } = makeAgent({
    route: 'ask_user',
    failureClass: 'provider_format',
    taskState: 'idle',
    queueLength: 0,
  })
  memory.planByNpc.get('npc:airi').task_board.evidence.push({
    id: 'evidence_prior_world_failure',
    kind: 'operation_preflight_blocker',
    ref: 'old/preflight',
    summary: 'an older deterministic blocker record',
    step_id: 'step_1',
    at: Date.now(),
  })

  const result = await agent.recoverPlan(agent.generation, new Error('Invalid provider content JSON'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(memory.planByNpc.get('npc:airi').status, 'active')
  assert.equal(memory.planByNpc.get('npc:airi').blocker, '')
  assert.equal(mainCalls.length, 1)
})
