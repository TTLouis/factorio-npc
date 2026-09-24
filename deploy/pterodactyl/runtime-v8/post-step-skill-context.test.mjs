import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { observationRelevanceFamilies, typedStateDistillationQuestions } from './jev-decision-taxonomy.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'

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
    objective: 'build an early burner coal loop',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['place and start the loop', 'verify it stays fueled'],
    current_step: 0,
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
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'place and start the loop', status: 'active' },
        { id: 'step_2', description: 'verify it stays fueled', status: 'pending' },
      ],
      evidence: [],
    },
  }
}

class TestRcon {
  constructor({ followHealthy = false } = {}) {
    this.followHealthy = followHealthy
  }

  async command(text) {
    if (text.includes('remote.call("airi_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) {
      return JSON.stringify(this.followHealthy
        ? {
            active: true,
            healthy: true,
            controller_live: true,
            state: 'following',
            target_player: 'tester',
            current_distance: 4,
            desired_distance: 4,
          }
        : { active: false, healthy: false, controller_live: false })
    }
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({
        task_state: 'idle',
        queue_empty: true,
        queue_length: 0,
        last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['placing'], tick: 1234 },
      })
    }
    return '{}'
  }
}

function decisionResponse(route) {
  const canonicalRoute = {
    continue_current: 'continue_runtime',
    wait_runtime: 'continue_runtime',
    targeted_observation: 'observe',
    reanchor_plan: 'wake_planner',
    replan: 'wake_planner',
    fallback_planner: 'wake_planner',
  }[route] ?? route
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      route: {
        type: 'choice',
        choice: canonicalRoute,
        probabilities: {
          continue_runtime: canonicalRoute === 'continue_runtime' ? 0.9 : 0.03,
          observe: canonicalRoute === 'observe' ? 0.9 : 0.03,
          wake_planner: canonicalRoute === 'wake_planner' ? 0.9 : 0.03,
          ask_user: canonicalRoute === 'ask_user' ? 0.9 : 0.03,
        },
        confidence: 0.9,
      },
      state_bottleneck: {
        type: 'choice',
        choice: 'logistics',
        probabilities: { none_known: 0.02, materials: 0.03, power: 0.03, logistics: 0.72, production: 0.05, research: 0.03, spatial: 0.03, safety: 0.02, runtime_health: 0.02, information: 0.05 },
        confidence: 0.82,
      },
      state_readiness: { type: 'score', score: 2.6, confidence: 0.78 },
      state_risk: { type: 'score', score: 1.2, confidence: 0.74 },
      state_evidence_conflict: { type: 'noul', noul: 0.18 },
    },
    usage: { input_tokens: 80, output_tokens: 8, cost: 0.00000336 },
  }
}

function agentForRoute(route, { followHealthy = false, decisionProvider } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:airi', activePlan())
  const events = []
  const agent = new NpcAgentLoop({
    rcon: new TestRcon({ followHealthy }),
    memory,
    systemPrompt: 'main planner',
    npcId: 'airi',
    provider: async () => { throw new Error('main planner should not run in this focused router test') },
    interactionDecisionProvider: decisionProvider ?? (async () => decisionResponse(route)),
    traceFile: null,
    decisionTraceFile: null,
    stateFile: null,
    onActivity: (event, data) => events.push({ event, data }),
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:airi'
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: '[CHAT] tester: build an early burner coal loop' },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = {
    memoryKey: 'npc:airi',
    turnId: 1,
    sender: 'tester',
    text: 'build an early burner coal loop',
  }
  return { agent, memory, events }
}

test('findSkills remains discovery-only while getSkillDetails creates task-local Skill Context', async () => {
  const { agent } = agentForRoute('fallback_planner')
  const discovery = JSON.stringify({
    ok: true,
    results: [{ id: 'burner-coal-loop', name: 'Burner Coal Loop', summary: 'search metadata only' }],
  })
  assert.equal(agent.recordLoadedSkillToolResult('findSkills', { query: 'coal loop' }, discovery), false)
  assert.equal(agent.skillContext(), '')

  const skill = {
    schema_version: 1,
    revision: 1,
    id: 'burner-coal-loop',
    name: 'Burner Coal Loop',
    kind: 'production',
    stage: 'pattern',
    status: 'candidate',
    summary: 'Bootstrap coal production with starter fuel and a self-feeding miner loop.',
    preconditions: [{ kind: 'bootstrap', subject: 'starter-fuel', description: 'Starter fuel is available.' }],
    topology: { relations: [{ kind: 'direct_item_output', from: 'miner-a', to: 'miner-b', description: 'Feed the next miner.' }] },
    constraints: [{ kind: 'placement', description: 'Verify actual output direction and resource coverage.' }],
    parameters: [{ name: 'miner_count', description: 'Choose from live patch geometry.', required: false, default_value: 2 }],
    verification: { mode: 'deterministic' },
  }
  assert.ok(agent.recordLoadedSkillToolResult('getSkillDetails', { id: 'burner-coal-loop' }, JSON.stringify(skill)))

  let context = agent.skillContext()
  assert.match(context, /^\[SKILL_CONTEXT\]/)
  assert.match(context, /burner-coal-loop/)
  assert.match(context, /Verify actual output direction/)

  agent.messages.push({ role: 'assistant', content: JSON.stringify({ chatMessage: '', plan: ['verify'], currentStep: 0, operations: [] }) })
  agent.prepareContinuationContext()
  context = agent.skillContext()
  assert.match(context, /^\[SKILL_CONTEXT\]/)
  assert.match(context, /burner-coal-loop/)

  await agent.pausePersistentPlan('ui_pause')
  assert.match(agent.skillContext(), /^\[SKILL_CONTEXT\]/)

  agent.cancel('user_stop_immediate')
  assert.match(agent.skillContext(), /^\[SKILL_CONTEXT\]/)

  agent.cancel('ui_terminate')
  assert.equal(agent.skillContext(), '')
})

test('M9 post-step wake_planner maps to the high-reasoning planner trigger', async () => {
  const { agent } = agentForRoute('wake_planner')
  agent.taskStatusReceipt = async () => ({
    raw: '{}',
    view: { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
    providerStatus: { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
  })
  agent.continueFromModMessage = async () => ({ triggerSource: agent.reasoningTriggerSource })
  const result = await agent.completed()
  assert.equal(result.triggerSource, 'post_step_replan')
  assert.equal(agent.reasoningTriggerSource, null)
})

test('wait_runtime skips the planner for active Autorio work or a healthy persistent controller, but never strands idle work', async () => {
  const activeAutorio = agentForRoute('wait_runtime', { followHealthy: false })
  const activeRoute = await activeAutorio.agent.routePostStepDecision({
    view: { task_state: 'crafting', queue_empty: false, queue_length: 1 },
    providerStatus: { task_state: 'crafting', queue_empty: false, queue_length: 1 },
  })
  assert.equal(activeRoute.route, 'wait_runtime')
  assert.equal(activeRoute.runtime_reason, 'autorio_active_work')
  assert.ok(activeAutorio.events.some(entry => entry.event === 'planner.skipped'))

  const healthyFollow = agentForRoute('wait_runtime', { followHealthy: true })
  const followRoute = await healthyFollow.agent.routePostStepDecision({
    view: { task_state: 'idle', queue_empty: true, queue_length: 0 },
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(followRoute.route, 'wait_runtime')
  assert.equal(followRoute.runtime_reason, 'persistent_controller_active')

  const idle = agentForRoute('wait_runtime', { followHealthy: false })
  const idleRoute = await idle.agent.routePostStepDecision({
    view: { task_state: 'idle', queue_empty: true, queue_length: 0 },
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(idleRoute.route, 'fallback_planner')
  assert.equal(idleRoute.fallback_reason, 'continue_runtime_without_authoritative_active_runtime')
  assert.ok(idle.events.some(entry => entry.event === 'planner.wake'))
})

test('failure boundaries also use the active Jev gate and map semantic replans to high reasoning', async () => {
  const { agent } = agentForRoute('replan')
  agent.taskStatusReceipt = async () => ({
    raw: '{}',
    view: { task_state: 'idle', queue_empty: true, queue_length: 0, last_cancelled_batch: { batch_id: 8 } },
    providerStatus: { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_cancelled_batch: { batch_id: 8 } },
  })
  agent.continueFromModMessage = async () => ({ triggerSource: agent.reasoningTriggerSource })
  const result = await agent.failed('grounded placement failure')
  assert.equal(result.triggerSource, 'post_step_replan')
  assert.equal(agent.reasoningTriggerSource, null)
})

test('post-step Jev receives a bounded grounded gate state instead of dialogue history', async () => {
  const calls = []
  const { agent } = agentForRoute('continue_current', {
    decisionProvider: async (state, questions) => {
      calls.push({ state, questions })
      return decisionResponse('continue_current')
    },
  })
  agent.recordLoadedSkillToolResult('getSkillDetails', { id: 'burner-coal-loop' }, JSON.stringify({
    id: 'burner-coal-loop',
    name: 'Burner Coal Loop',
    summary: 'Use live geometry before placement.',
  }))
  await agent.routePostStepDecision({
    view: {
      task_state: 'idle',
      queue_empty: true,
      queue_length: 0,
      last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['placing'] },
      basic_operation: { last_result: { completed: true, placed_unit_number: 99 } },
    },
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })

  // No authoritative runtime is active, so the planner wakes: one small gate
  // call, then one planner-shape call over the same bounded state.
  assert.equal(calls.length, 2)
  const [captured, shape] = calls
  assert.equal(captured.state.reason, 'post_step_planner_gate')
  assert.equal(captured.state.goal.goal_id, 'goal_existing')
  assert.equal(captured.state.task_board.active_index, 0)
  assert.equal(captured.state.autorio.last_completed_batch.batch_id, 7)
  assert.equal(captured.state.autorio.latest_basic_operation_result.completed, true)
  assert.equal(captured.state.autorio.latest_basic_operation_result.placed_unit_number, undefined)
  assert.equal(captured.state.skills[0].id, 'burner-coal-loop')
  assert.equal(Object.prototype.hasOwnProperty.call(captured.state, 'dialogue'), false)
  assert.deepEqual(Object.keys(captured.questions), ['route', 'development'])
  assert.equal(shape.state, captured.state)
  assert.deepEqual(Object.keys(shape.questions), [
    'reasoning_budget',
    'planning_horizon',
    ...observationRelevanceFamilies().map(family => `need_${family}`),
    ...Object.keys(typedStateDistillationQuestions()),
  ])
  assert.deepEqual(Object.keys(captured.questions.route.criteria), [
    'continue_runtime',
    'observe',
    'wake_planner',
    'ask_user',
  ])
})

test('a boundary where healthy runtime continues buys only the gate questions', async () => {
  const calls = []
  const { agent, events } = agentForRoute('wait_runtime', {
    followHealthy: true,
    decisionProvider: async (state, questions) => {
      calls.push(Object.keys(questions))
      return decisionResponse('wait_runtime')
    },
  })
  const routed = await agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })

  assert.equal(routed.route, 'wait_runtime')
  assert.deepEqual(calls, [['route', 'development']])
  assert.equal(routed.steering.reasoning_budget, undefined)
  const posted = events.find(entry => entry.event === 'post_step.routed')
  assert.equal(posted.data.decision.planner_shape_called, false)
})

test('a failed planner-shape call still wakes the planner, only without Jev shaping', async () => {
  const { agent } = agentForRoute('replan', {
    decisionProvider: async (_state, questions) => {
      if (questions.route) return decisionResponse('replan')
      throw new Error('Decision provider timed out after 5000 ms')
    },
  })
  const routed = await agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })

  assert.equal(routed.route, 'replan')
  assert.equal(routed.decision_called, true)
  assert.equal(routed.steering.reasoning_budget, undefined)
  assert.equal(routed.steering.planning_horizon, undefined)
  assert.equal(agent.jevHealth.by_contract.post_step_planner_shape.fallbacks, 1)
  assert.deepEqual(agent.jevHealth.by_kind, { timeout: 1 })
})

test('M9 post-step observe route wakes the planner with the bounded observation path', async () => {
  const { agent } = agentForRoute('targeted_observation')
  agent.taskStatusReceipt = async () => ({
    raw: '{}',
    view: { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
    providerStatus: { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
  })
  agent.continueFromModMessage = async () => ({ triggerSource: agent.reasoningTriggerSource })
  const result = await agent.completed()
  assert.equal(result.triggerSource, 'post_step_observe')
})

test('M11E typed state remains experimental telemetry and is not injected into Main-LLM context', async () => {
  const { agent, events } = agentForRoute('continue_current')
  agent.taskStatusReceipt = async () => ({
    raw: '{}',
    view: { task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
    providerStatus: { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 7 } },
  })
  let continuation
  agent.continueFromModMessage = async message => {
    continuation = message
    return { message }
  }

  await agent.completed()

  assert.match(continuation, /^\[MOD\] Autorio operation batch completed/)
  assert.doesNotMatch(continuation, /\[JEV_TYPED_STATE\]|bottleneck=logistics|readiness_score=/)

  const routed = events.find(entry => entry.event === 'post_step.routed')
  assert.ok(routed)
  assert.equal(routed.data.decision.typed_state_experimental, true)
  assert.equal(routed.data.decision.typed_state_context_injected, false)
  assert.equal(routed.data.decision.steering.typed_state_mode, 'experimental_trace_only')
  assert.equal(routed.data.decision.steering.typed_state.bottleneck, 'logistics')
  assert.equal(routed.data.decision.steering.typed_state.readiness_score, 2.6)
  assert.deepEqual(routed.data.decision.steering.typed_state.provenance, ['task_board', 'autorio_status'])
})

test('invalid Jev post-step output fails open to the planner', async () => {
  const { agent, events } = agentForRoute('continue_current', {
    decisionProvider: async () => ({ model: 'jev-latest', provider: 'TypeSafe', answers: {} }),
  })
  const routed = await agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  assert.equal(routed.route, 'fallback_planner')
  assert.match(routed.error, /invalid post-step route/)
  assert.ok(events.some(entry => entry.event === 'planner.wake'))
})

test('cancellation aborts an in-flight Jev post-step decision and cannot wake a stale planner', async () => {
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const { agent, events } = agentForRoute('continue_current', {
    decisionProvider: async (_state, _questions, context) => new Promise((resolve, reject) => {
      startedResolve()
      context.signal.addEventListener('abort', () => reject(new Error('Decision provider request cancelled')), { once: true })
    }),
  })

  const routing = agent.routePostStepDecision({
    providerStatus: { task_state: 'idle', queue_empty: true, queue_length: 0 },
  })
  await started
  agent.cancel('test_cancel')
  await assert.rejects(routing, /Model turn was cancelled or superseded/)
  assert.equal(events.some(entry => entry.event === 'planner.wake'), false)
})
