import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { productionEstimateAnswer } from './steam-run-fixtures.mjs'
import { contractCheckedJev } from './task-loop-fixtures.mjs'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
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
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
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
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      this.mutations.push(text)
      const count = [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

function decisionResponse(semantic = 'unclear', observationProbability = 0.1) {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      recovery_semantics: { type: 'choice', choice: semantic, confidence: 0.95 },
      one_observation_can_resolve: { type: 'noul', noul: observationProbability },
    },
    usage: { input_tokens: 60, output_tokens: 6, cost: 0.00000252 },
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
  semantic = 'unclear',
  observationProbability = 0.1,
  taskState = 'idle',
  queueLength = 0,
  finalProof = false,
  decisionProvider,
  provider,
  rcon,
} = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:sgluna', activeState({ finalProof }))
  const mainCalls = []
  const decisionCalls = []
  const agent = new NpcAgentLoop({
    rcon: rcon ?? new RecoveryRcon({ taskState, queueLength }),
    memory,
    npcId: 'sgluna',
    systemPrompt: 'recovery router test',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    // These tests count the recovery router's own Jev calls; U11's restage judgments (jev-checkpoints.mjs) have their own tests.
    jevCheckpoints: false,
    interactionDecisionProvider: contractCheckedJev(decisionProvider ?? (async (state, questions) => {
      decisionCalls.push({ state, questions })
      return decisionResponse(semantic, observationProbability)
    })),
    provider: provider ?? (async (_messages, options) => {
      mainCalls.push(options)
      return planMessage()
    }),
  })
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:sgluna'
  agent.requestInfo = {
    memoryKey: 'npc:sgluna',
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

test('M11D authoritative active runtime bypasses Jev and the Main planner', async () => {
  const active = makeAgent({ taskState: 'mining', queueLength: 1 })
  const result = await active.agent.recoverPlan(active.agent.generation, new Error('provider timeout'), 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(active.mainCalls.length, 0)
  assert.equal(active.decisionCalls.length, 0)
})

test('M11D provider-format recovery bypasses Jev and uses strict/base recovery', async () => {
  const { agent, mainCalls, decisionCalls } = makeAgent({ taskState: 'idle', queueLength: 0 })
  const result = await agent.recoverPlan(agent.generation, new Error('invalid provider JSON'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(mainCalls.length, 1)
  assert.ok(mainCalls[0].recoveryAttempt >= 1)
  assert.equal(decisionCalls.length, 0)
})

test('recovery never promotes a final batch receipt into semantic or goal completion', async () => {
  const { agent, memory, mainCalls, decisionCalls } = makeAgent({ finalProof: true })
  const traces = []
  agent.traceRequest = { id: 'run_ag_recovery' }
  agent.traceEvent = async (type, data) => { traces.push({ type, ...data }) }
  const result = await agent.recoverPlan(agent.generation, new Error('invalid provider JSON'), 1)
  assert.notEqual(result.goalStatus, 'completed')
  assert.equal(memory.currentPlan('npc:sgluna').task_board.completed_count, 0)
  assert.equal(mainCalls.length, 1)
  assert.equal(decisionCalls.length, 0)
  assert.ok(traces.some(event => event.type === 'recovery.batch_proof_not_goal_completion'
    && event.request_id === 'run_ag_recovery'
    && event.reason === 'batch_receipt_does_not_prove_semantic_completion'))
})

test('Run AG same-step supply receipt leaves the committed iron and research contract open during recovery', async () => {
  const { agent, memory } = makeAgent({ finalProof: true, taskState: 'mining', queueLength: 1 })
  const key = 'npc:sgluna'
  const state = memory.planByNpc.get(key)
  const step = state.task_board.steps[0]
  step.description = 'Produce 58 iron plates and research steam power'
  step.completion_contract = {
    mode: 'all', source: 'main_planner', requirements: [
      { id: 'iron_total', kind: 'inventory_count', item_name: 'iron-plate', minimum: 58 },
      { id: 'steam', kind: 'research_completed', technology: 'steam-power' },
    ],
  }
  state.plan = [step.description]
  const proof = state.task_board.evidence[0]
  proof.summary = JSON.stringify({
    verdict: 'verified_complete', batch_id: 13, operations: ['supply_entity'], task_types: ['moving_items'],
    semantics: 'Every operation in this batch has strict runtime completion semantics; the completed batch receipt therefore proves the current step action finished without a model guess.',
  })
  proof.ref = 'batch_13'
  memory.ensurePlanningDraft(key, state, { now: 100, migrated: true })
  memory.commitPlanningPlan(key, { now: 110, migrated: true, runtime_validation: { passed: true } })
  const before = structuredClone(memory.planningState(key))
  const result = await agent.recoverPlan(agent.generation, new Error('duplicate observation budget exhausted'), 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(agent.active, true)
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
  assert.deepEqual(memory.planningState(key), before)
  assert.equal(memory.currentPlan(key).task_board.steps[0].status, 'active')
})
test('M11D ambiguous semantic replan uses Jev and high planner reasoning', async () => {
  const { agent, mainCalls, decisionCalls } = makeAgent({ semantic: 'semantic_replan' })
  const result = await agent.recoverPlan(agent.generation, new Error('strategy invalidated by fresh evidence'), 1)
  assert.equal(result.operations.length, 1)
  assert.equal(mainCalls.length, 1)
  assert.equal(mainCalls[0].triggerSource, 'recovery_replan_high')
  assert.equal(decisionCalls.length, 1)
  assert.deepEqual(Object.keys(decisionCalls[0].questions), ['recovery_semantics', 'one_observation_can_resolve'])
})

test('M11D ambiguous missing fact may buy exactly one bounded observation', async () => {
  const { agent, decisionCalls } = makeAgent({ semantic: 'missing_fact', observationProbability: 0.9 })
  const routed = await agent.routeRecoveryDecision(new Error('one targeted observation is missing'), 2)
  assert.equal(routed.route, 'targeted_observation')
  assert.equal(routed.failure_class, 'missing_fact')
  assert.equal(decisionCalls.length, 1)
})

test('M11D exhausted observation budget bypasses Jev for a known missing-fact failure', async () => {
  const { agent, decisionCalls } = makeAgent({ semantic: 'missing_fact', observationProbability: 0.9 })
  agent.observationBudgetRemaining = 0
  const routed = await agent.routeRecoveryDecision(new Error('one targeted observation is missing'), 2)
  assert.equal(routed.route, 'wake_planner')
  assert.equal(routed.decision_called, false)
  assert.equal(decisionCalls.length, 0)
})

test('duplicate ambiguous recovery event coalesces the Jev call', async () => {
  const { agent, decisionCalls } = makeAgent({ semantic: 'semantic_replan' })
  const reason = new Error('semantic strategy dependency changed')
  const first = await agent.routeRecoveryDecision(reason, 2)
  const second = await agent.routeRecoveryDecision(reason, 2)
  assert.equal(first.route, 'wake_planner')
  assert.equal(second.route, 'wake_planner')
  assert.equal(second.duplicate, true)
  assert.equal(decisionCalls.length, 1)
})

test('ambiguous recovery Jev cancellation cannot apply a stale decision', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { agent } = makeAgent({
    decisionProvider: async () => {
      await pending
      return decisionResponse('semantic_replan', 0.1)
    },
  })
  const routing = agent.routeRecoveryDecision(new Error('semantic strategy failure'), 1)
  agent.cancel('new_task')
  release()
  await assert.rejects(routing, /cancelled|superseded/i)
})


// 2.6 review fix: a Jev wake_planner recovery that returns a long hand-mining
// draft commits it; the time review never holds a draft inside a recovery.
test('a wake_planner recovery with a long hand-mining draft commits without a time review hold', async () => {
  class TimedRecoveryRcon extends RecoveryRcon {
    async command(text) {
      if (text.includes('"autorio_knowledge","production_estimate"')) return JSON.stringify(productionEstimateAnswer(text))
      return super.command(text)
    }
  }
  const rcon = new TimedRecoveryRcon()
  const longDraft = {
    content: JSON.stringify({
      chatMessage: '',
      plan: ['Perform the step', 'Verify the result'],
      currentStep: 0,
      operations: [
        { name: 'gather_resource', args: { resource_name: 'iron-ore', count: 180, search_radius: 64 } },
        { name: 'gather_resource', args: { resource_name: 'coal', count: 80, search_radius: 64 } },
      ],
    }),
  }
  const { agent, mainCalls, decisionCalls } = makeAgent({ semantic: 'semantic_replan', rcon, provider: async (_messages, options) => {
    mainCalls.push(options)
    return longDraft
  } })
  const trace = []
  agent.behaviorTrace = { emit: async record => { trace.push(record) } }
  agent.traceRequest = { id: 'req_recovery', seq: 0, usage: {} }
  const result = await agent.recoverPlan(agent.generation, new Error('strategy invalidated by fresh evidence'), 1)
  assert.equal(decisionCalls.length, 1)
  assert.equal(mainCalls.length, 1, 'no extra planner turn for a review')
  assert.equal(mainCalls[0].triggerSource, 'recovery_replan_high')
  assert.equal(result.operations.length, 2)
  assert.equal(rcon.mutations.length, 1)
  assert.equal(trace.filter(record => record.event === 'plan.time_review_requested').length, 0)
  const estimate = trace.find(record => record.event === 'plan.time_estimate')
  assert.equal(estimate.data.step_expected_seconds, 520)
  assert.equal(estimate.data.long, true)
  assert.equal(estimate.data.review, 'skipped_recovery_round')
  assert.equal(agent.recoveryCommitDepth, 0)
})
