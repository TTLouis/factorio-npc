import test from 'node:test'
import assert from 'node:assert/strict'

import {
  liveAgentDebugEvent,
  liveAgentEvent,
  navigationObstaclePolicy,
  pauseStrandedPlanAfterRequestError,
  recoverInterruptedAgentPlan,
  taskBoardUiSnapshot,
} from './supervisor.mjs'

test('natural obstacle clearing defaults on for ordinary new requests', () => {
  assert.deepEqual(navigationObstaclePolicy('去最近的石矿'), {
    shouldUpdate: true,
    clearObstacles: true,
  })
  assert.deepEqual(navigationObstaclePolicy('follow me'), {
    shouldUpdate: true,
    clearObstacles: true,
  })
})

test('explicit requests to preserve trees or rocks disable automatic clearing', () => {
  for (const request of [
    '去石矿，但是不要砍树',
    '跟着我，别挖石头',
    '不要自动清障，绕过去',
    'Follow me but do not clear obstacles',
    "Go there but don't cut trees",
    "Reach the ore but don't mine rocks",
    'Preserve trees while walking there',
  ]) {
    assert.deepEqual(navigationObstaclePolicy(request), {
      shouldUpdate: true,
      clearObstacles: false,
    }, request)
  }
})

test('bare continue preserves the obstacle policy of the durable request', () => {
  for (const request of ['继续', '继续吧', 'resume', 'continue']) {
    assert.equal(navigationObstaclePolicy(request).shouldUpdate, false, request)
  }
})

test('Jev shadow diagnostics survive the following planner request reset and remain separate from planner usage', () => {
  const shadow = {
    intent: 'new_goal',
    intent_confidence: 0.91,
    queue_conflict_probability: 0.17,
    model: 'jev-latest',
    provider: 'TypeSafe',
    usage: { input_tokens: 120, output_tokens: 20, cost: 0.00000504 },
  }

  const routed = liveAgentDebugEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow: shadow,
    decision_shadow_latency_ms: 84,
  })

  assert.equal(routed.decision_provider, 'TypeSafe')
  assert.equal(routed.decision_model, 'jev-latest')
  assert.equal(routed.decision_shadow_intent, 'new_goal')
  assert.equal(routed.decision_active_intent, 'status_query')
  assert.equal(routed.decision_confidence_percent, 91)
  assert.equal(routed.decision_queue_conflict_percent, 17)
  assert.equal(routed.decision_latency_ms, 84)
  assert.equal(routed.decision_input_units, 120)
  assert.equal(routed.decision_output_units, 20)
  assert.equal(routed.decision_cost_micro_usd, 5)

  const next = liveAgentDebugEvent('request.received', {
    sender: 'tester',
    text: 'build something',
  }, routed, {
    provider_model: 'deepseek-chat',
  })

  assert.equal(next.provider_model, 'deepseek-chat')
  assert.equal(next.decision_model, 'jev-latest')
  assert.equal(next.decision_shadow_intent, 'new_goal')
  assert.equal(next.decision_active_intent, 'status_query')

  const activity = liveAgentEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow: shadow,
    decision_shadow_latency_ms: 84,
  })
  assert.equal(activity?.activity?.kind, 'system')
  assert.match(activity?.activity?.text ?? '', /Jev shadow: new_goal/)
  assert.match(activity?.activity?.text ?? '', /active status_query/)
  assert.match(activity?.activity?.text ?? '', /120 in/)
})

test('in-game task board snapshot is a projection of canonical durable state', () => {
  const state = {
    objective: '爬科技树',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_1',
      status: 'blocked',
      blocker: 'provider_recovery_exhausted',
      pause_reason: '',
      completed_count: 2,
      total_steps: 5,
      active_index: 2,
      steps: [
        { id: 'step_1', description: '找石头', status: 'completed' },
        { id: 'step_2', description: '挖石头', status: 'completed' },
        { id: 'step_3', description: '触发蒸汽动力', status: 'blocked' },
        { id: 'step_4', description: '建立蒸汽电力', status: 'pending' },
        { id: 'step_5', description: '开始实验室研究', status: 'pending' },
      ],
    },
  }
  const snapshot = taskBoardUiSnapshot(state)
  assert.equal(snapshot.goal_id, 'goal_1')
  assert.equal(snapshot.objective, '爬科技树')
  assert.equal(snapshot.project, undefined)
  assert.equal(snapshot.status, 'blocked')
  assert.equal(snapshot.blocker, 'provider_recovery_exhausted')
  assert.equal(snapshot.blocker_summary, 'AIRI could not get a usable model response after retrying.')
  assert.equal(snapshot.pause_reason, '')
  assert.equal(snapshot.pause_summary, '')
  assert.equal(snapshot.completed_count, 2)
  assert.equal(snapshot.total_steps, 5)
  assert.equal(snapshot.active_index, 2)
  assert.deepEqual(snapshot.steps, state.task_board.steps)
  assert.deepEqual(snapshot.activity, [])
  assert.deepEqual(snapshot.wanted_items, [])
  assert.equal(snapshot.conversation_id, '')
  assert.deepEqual(snapshot.conversation, [])
  assert.deepEqual(snapshot.agent, { phase: 'idle', detail: '' })

  // Debug telemetry is additive. Assert stable defaults for the public contract
  // without freezing every newly-added diagnostic key.
  assert.equal(snapshot.debug.request_id, '')
  assert.equal(snapshot.debug.provider_model, '')
  assert.equal(snapshot.debug.decision_model, '')
  assert.equal(snapshot.debug.decision_scope_review, '')
  assert.equal(snapshot.debug.decision_scope_review_reason_codes, '')
  assert.equal(snapshot.debug.decision_scope_review_actionable_prefix, 0)
  assert.equal(snapshot.debug.decision_development, '')
  assert.equal(snapshot.debug.decision_steering, '')
  // Retired with the milestone hierarchy; must not reappear.
  assert.equal('decision_granularity' in snapshot.debug, false)
  assert.equal('decision_milestone_transition' in snapshot.debug, false)
  assert.equal('decision_hierarchy_action' in snapshot.debug, false)
  assert.equal(snapshot.debug.step_relation, '')
  assert.equal(snapshot.debug.step_checkpoint_boundary, '')
  assert.equal(snapshot.debug.step_admission_alignment, '')
  assert.equal(snapshot.debug.last_error, '')
  assert.equal(snapshot.debug.actor_id, 0)
  assert.equal(snapshot.debug.actor_epoch, 0)
})


// Behaviour change (planning refactor): leftover structural-transition markers no
// longer suppress auto-pause. An ACTIVE plan stranded by a provider failure while
// Autorio is idle pauses like any other, so the player gets a visible signal
// instead of a silently-preserved "transaction".
test('a stranded plan carrying legacy structural markers is paused after an idle request failure', async () => {
  const state = {
    status: 'active',
    hierarchy_split_pending: {
      kind: 'split_current_milestone',
      reason_code: 'hierarchy_split_requested',
    },
    milestone_transition_pending: true,
    milestone_plan_pending: true,
  }
  let pauses = 0
  let pauseReason = ''
  let synced
  const session = {
    currentPlanState: () => state,
    syncTaskBoardUi: async (value) => { synced = value },
    agent: {
      readInteractionTaskStatus: async () => ({ task_state: 'idle', queue_length: 0 }),
      pausePersistentPlan: async (reason) => {
        pauses++
        pauseReason = reason
        return { status: 'paused' }
      },
    },
  }

  const paused = await pauseStrandedPlanAfterRequestError(session, 'synthetic planner failure')
  assert.deepEqual(paused, { status: 'paused' })
  assert.equal(pauses, 1)
  assert.match(pauseReason, /^request_failed: synthetic planner failure$/)
  assert.deepEqual(synced, { status: 'paused' })
})

// Behaviour change (planning refactor): runtime recovery has exactly one shape.
// It never re-anchors, never carries a hierarchy trigger source, and never
// inherits semantic budget overrides from a durable structural marker.
test('interrupted plan recovery always uses the plain runtime-recovery path', async () => {
  const state = {
    goal_id: 'goal_long',
    owner: 'tester',
    objective: 'Reach Automation',
    status: 'active',
    // Legacy markers are inert: they must not steer recovery any more.
    hierarchy_split_pending: {
      kind: 'split_project_goal',
      reasoning_budget: 'strategic',
      planning_horizon: 'strategic',
      observation_budget: 3,
    },
    milestone_plan_pending: true,
  }
  const memory = {
    currentPlan: () => state,
    context: () => '[PLAN_STATE] durable goal',
  }
  const seen = {}
  const agent = {
    npcId: 'airi',
    memory,
    systemPrompt: 'system',
    turnSequence: 0,
    reasoningBudgetOverride: null,
    observationBudgetOverride: null,
    observationBudgetRemaining: null,
    planningHorizonOverride: null,
    loadPersistentState: async () => {},
    cancel: () => {},
    captureEpoch: async () => ({ actor_id: 3, epoch: 8 }),
    traceEvent: async () => {},
    async runGuarded() {
      seen.planUpdateReason = this.planUpdateReason
      seen.reasoningTriggerSource = this.reasoningTriggerSource
      seen.reasoningBudgetOverride = this.reasoningBudgetOverride
      seen.observationBudgetOverride = this.observationBudgetOverride
      seen.observationBudgetRemaining = this.observationBudgetRemaining
      seen.planningHorizonOverride = this.planningHorizonOverride
      seen.message = this.messages.at(-1)?.content
      return { chatMessage: 'recovered' }
    },
  }

  const result = await recoverInterruptedAgentPlan(agent, 'runtime_restart')
  assert.equal(result.recovered, true)
  assert.equal(seen.planUpdateReason, 'recovery')
  assert.equal(seen.reasoningTriggerSource, null)
  // No structural budget inheritance: the overrides stay untouched.
  assert.equal(seen.reasoningBudgetOverride, null)
  assert.equal(seen.observationBudgetOverride, null)
  assert.equal(seen.observationBudgetRemaining, null)
  assert.equal(seen.planningHorizonOverride, null)
  assert.match(seen.message, /^\[HARNESS\] Runtime recovery after runtime_restart\./)
  assert.doesNotMatch(seen.message, /hierarchy|milestone/i)
  assert.equal(agent.reasoningBudgetOverride, null)
  assert.equal(agent.observationBudgetOverride, null)
  assert.equal(agent.observationBudgetRemaining, null)
  assert.equal(agent.planningHorizonOverride, null)
})

test('restart during output-budget recovery fails closed without another planner call or world mutation', async () => {
  const state = {
    goal_id: 'goal_restart',
    objective: 'Build a safe setup',
    status: 'active',
    provider_recovery: {
      kind: 'output_budget_exhaustion',
      phase: 'in_flight',
      goal_id: 'goal_restart',
      step_id: 'step_1',
      started_at: 1234,
    },
    task_board: {
      kind: 'task_board_lite',
      status: 'active',
      active_index: 0,
      steps: [{ id: 'step_1', description: 'Build safely', status: 'active' }],
    },
  }
  let plannerCalls = 0
  let cleared = false
  let persisted = false
  let cancelled = false
  const memory = {
    currentPlan: () => state,
    applyOutcomeAuthority: (_key, candidate) => {
      assert.equal(candidate.kind, 'recoverable_provider_failure')
      assert.equal(candidate.reason_code, 'provider_budget')
      state.status = 'paused'
      state.task_board.status = 'paused'
      return { state, decision: { accepted: true }, changed: true }
    },
    setProviderRecovery: (_key, value) => {
      assert.equal(value, undefined)
      state.provider_recovery = undefined
      cleared = true
    },
  }
  const agent = {
    npcId: 'airi',
    memory,
    loadPersistentState: async () => {},
    readInteractionTaskStatus: async () => ({ task_state: 'idle', queue_length: 0 }),
    persistState: async () => { persisted = true },
    cancel: () => { cancelled = true },
    runGuarded: async () => { plannerCalls++; return {} },
  }

  const result = await recoverInterruptedAgentPlan(agent, 'runtime_restart')
  assert.equal(result.recovered, true)
  assert.equal(result.reason, 'interrupted_output_budget_recovery_fail_closed')
  assert.equal(result.state.status, 'paused')
  assert.equal(plannerCalls, 0)
  assert.equal(cleared, true)
  assert.equal(persisted, true)
  assert.equal(cancelled, true)
})
