import assert from 'node:assert/strict'
import test from 'node:test'

import { liveAgentDebugEvent, taskBoardUiSnapshot } from './supervisor.mjs'

test('live debug bridge retains request, provider, tool, recovery, and actor diagnostics', () => {
  let debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'build power' }, undefined, {
    request_id: 'req-1',
    turn: 1,
    provider_model: 'deepseek-flash',
    actor_id: 18,
    actor_epoch: 3,
  })
  assert.equal(debug.request_id, 'req-1')
  assert.equal(debug.turn, 1)
  assert.equal(debug.provider_model, 'deepseek-flash')
  assert.equal(debug.actor_id, 18)
  assert.equal(debug.actor_epoch, 3)

  debug = liveAgentDebugEvent('provider.request', { round: 4, recovery_attempt: 2 }, debug)
  assert.equal(debug.provider_round, 4)
  assert.equal(debug.recovery_attempt, 2)

  debug = liveAgentDebugEvent('provider.response', {
    round: 4,
    recovery_attempt: 2,
    recovery_kind: 'output_budget_exhaustion',
    latency_ms: 10954,
    usage: {
      input_units: 4982,
      cached_input_units: 4568,
      output_units: 700,
      total_units: 5682,
    },
    provider: {
      model: 'deepseek-flash',
      finish_reason: 'length',
      diagnostic_code: 'provider_output_truncated_empty_content',
      reasoning_effort: 'none',
      reasoning_policy_reason: 'strict_recovery',
      capability_profile: 'deepseek',
      requested_token_field: 'max_tokens',
      requested_output_cap: 1000,
      requested_reasoning_effort: 'none',
      requested_thinking_mode: 'disabled',
      reported_reasoning_tokens: 700,
      usage_complete: true,
      cap_enforcement_anomaly: false,
      response_id: 'resp-round-4',
      response_bytes: 2048,
      tool_call_count: 0,
      content_chars: 0,
      content_utf8_bytes: 0,
      content_non_ascii_chars: 0,
      content_replacement_chars: 0,
      normalized_content_chars: 0,
      structured_content: {
        json_valid: false,
        plan_valid: false,
        error: 'empty\ncontent',
      },
      reasoning_content_chars: 8241,
    },
  }, debug, {
    usage: {
      input_units: 13982,
      cached_input_units: 13568,
      output_units: 2000,
      total_units: 15982,
    },
  })
  assert.equal(debug.provider_latency_ms, 10954)
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')
  assert.equal(debug.provider_capability_profile, 'deepseek')
  assert.equal(debug.requested_token_field, 'max_tokens')
  assert.equal(debug.requested_output_cap, 1000)
  assert.equal(debug.requested_reasoning_effort, 'none')
  assert.equal(debug.requested_thinking_mode, 'disabled')
  assert.equal(debug.reported_reasoning_tokens, 700)
  assert.equal(debug.usage_complete, 1)
  assert.equal(debug.cap_enforcement_anomaly, 0)
  assert.equal(debug.recovery_result, 'response_received')
  assert.equal(debug.response_id, 'resp-round-4')
  assert.equal(debug.response_bytes, 2048)
  assert.equal(debug.tool_call_count, 0)
  assert.equal(debug.content_chars, 0)
  assert.equal(debug.content_utf8_bytes, 0)
  assert.equal(debug.content_non_ascii_chars, 0)
  assert.equal(debug.content_replacement_chars, 0)
  assert.equal(debug.normalized_content_chars, 0)
  assert.deepEqual(debug.structured_content, { json_valid: false, plan_valid: false, error: 'empty content' })
  assert.equal(debug.reasoning_content_chars, 8241)
  assert.equal(debug.input_units, 13982)
  assert.equal(debug.cached_input_units, 13568)
  assert.equal(debug.output_units, 2000)
  assert.equal(debug.total_units, 15982)
  assert.equal(debug.latest_round_provider_round, 4)
  assert.equal(debug.latest_round_input_units, 4982)
  assert.equal(debug.latest_round_cached_input_units, 4568)
  assert.equal(debug.latest_round_output_units, 700)
  assert.equal(debug.latest_round_total_units, 5682)
  assert.match(debug.last_error, /provider_output_truncated_empty_content/)
  assert.match(debug.last_error, /finish=length/)

  // Starting the next provider round must keep the latest completed round's
  // reasoning policy visible until a newer provider.response replaces it.
  debug = liveAgentDebugEvent('provider.request', { round: 5, recovery_attempt: 0 }, debug)
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')
  assert.equal(debug.response_id, 'resp-round-4')
  assert.deepEqual(debug.structured_content, { json_valid: false, plan_valid: false, error: 'empty content' })

  // Tool-driven UI refreshes also preserve the same completed-round policy.
  debug = liveAgentDebugEvent('tool.result', { name: 'getActorStatus' }, debug)
  assert.equal(debug.reasoning_effort, 'none')
  assert.equal(debug.reasoning_policy_reason, 'strict_recovery')
  assert.equal(debug.response_id, 'resp-round-4')
  assert.equal(debug.response_bytes, 2048)
  assert.equal(debug.last_tool, 'getActorStatus')
  assert.equal(debug.last_event, 'tool.result')
})

test('scope review diagnostics expose exact unavailable stage and reset on the next request', () => {
  let debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'new_goal',
    decision_shadow_latency_ms: 12,
    decision_shadow: {
      provider: 'TypeSafe', model: 'jev-1.13.0', intent: 'new_goal', intent_confidence: 0.9,
      queue_conflict_probability: 0, usage: { input_tokens: 50, output_tokens: 5 },
    },
  })
  debug = liveAgentDebugEvent('request.received', {}, debug, { request_id: 'req-a' })
  debug = liveAgentDebugEvent('planning.scope_review_failed', {
    failure_stage: 'parse', failure_kind: 'parse_schema', reason: 'scope_review answer was missing',
    review_packet_version: 2, grounding_observation_count: 4, live_entity_count: 3, deterministic_preflight_count: 1,
  }, debug)
  assert.equal(debug.decision_scope_review, 'unavailable')
  assert.equal(debug.decision_scope_review_reason_codes, 'jev_scope_review_unavailable')
  assert.equal(debug.decision_scope_review_failure_stage, 'parse_schema')
  assert.equal(debug.decision_scope_review_failure_reason, 'scope_review answer was missing')
  assert.equal(debug.decision_scope_review_packet_version, 2)
  assert.equal(debug.decision_scope_review_grounding_observations, 4)
  assert.equal(debug.decision_scope_review_live_entities, 3)
  assert.equal(debug.decision_scope_review_preflight_count, 1)
  assert.match(debug.decision_error, /Jev scope review unavailable/)
  const calls = debug.decision_calls_total
  debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'new_goal',
    decision_shadow_latency_ms: 10,
    decision_shadow: {
      provider: 'TypeSafe', model: 'jev-1.13.0', intent: 'new_goal', intent_confidence: 0.95,
      queue_conflict_probability: 0, usage: { input_tokens: 40, output_tokens: 4 },
    },
  }, debug)
  debug = liveAgentDebugEvent('request.received', {}, debug, { request_id: 'req-b' })
  assert.equal(debug.decision_scope_review, '')
  assert.equal(debug.decision_scope_review_failure_stage, '')
  assert.equal(debug.decision_scope_review_failure_reason, '')
  assert.equal(debug.decision_error, '')
  assert.equal(debug.decision_shadow_intent, 'new_goal')
  assert.equal(debug.decision_calls_total, calls + 1)
  debug = liveAgentDebugEvent('planning.scope_review', {
    verdict: 'actionable', confidence: 0.88, reason_codes: [], actionable_prefix: 3,
    review_packet_version: 2, grounding_observation_count: 5, live_entity_count: 2, deterministic_preflight_count: 1,
  }, debug)
  assert.equal(debug.decision_scope_review, 'actionable')
  assert.equal(debug.decision_scope_review_confidence_percent, 88)
  assert.equal(debug.decision_scope_review_actionable_prefix, 3)
  assert.equal(debug.decision_scope_review_failure_reason, '')
})

test('live debug bridge drops malformed second-layer metrics instead of reusing stale round data', () => {
  let debug = liveAgentDebugEvent('provider.response', {
    round: 1,
    provider: {
      model: 'test-model',
      response_id: 'resp-valid',
      response_bytes: 100,
      tool_call_count: 1,
      content_utf8_bytes: 50,
      content_non_ascii_chars: 2,
      content_replacement_chars: 0,
      normalized_content_chars: 48,
      structured_content: { json_valid: true, plan_valid: true },
    },
  })

  debug = liveAgentDebugEvent('provider.response', {
    round: 2,
    provider: {
      model: 'test-model',
      response_id: { raw: 'not a string' },
      response_bytes: -1,
      tool_call_count: 1.5,
      content_utf8_bytes: Number.NaN,
      content_non_ascii_chars: Number.POSITIVE_INFINITY,
      content_replacement_chars: -2,
      normalized_content_chars: 2.25,
      structured_content: { json_valid: 'yes', plan_valid: 1, error: { raw: 'not text' } },
    },
  }, debug)

  assert.equal(debug.response_id, undefined)
  assert.equal(debug.response_bytes, undefined)
  assert.equal(debug.tool_call_count, undefined)
  assert.equal(debug.content_utf8_bytes, undefined)
  assert.equal(debug.content_non_ascii_chars, undefined)
  assert.equal(debug.content_replacement_chars, undefined)
  assert.equal(debug.normalized_content_chars, undefined)
  assert.equal(debug.structured_content, undefined)
})

test('Jev economics accumulate across interactions and planner attribution stays explicit', () => {
  let debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow_latency_ms: 80,
    decision_shadow: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      intent: 'status_query',
      intent_confidence: 0.93,
      queue_conflict_probability: 0.02,
      usage: { input_tokens: 120, output_tokens: 10, cost: 0.00000504 },
    },
  })

  debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'amend_current',
    decision_shadow_latency_ms: 95,
    decision_shadow: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      intent: 'new_goal',
      intent_confidence: 0.71,
      queue_conflict_probability: 0.44,
      usage: { input_tokens: 180, output_tokens: 12, cost: 0.00000756 },
    },
  }, debug)

  assert.equal(debug.decision_calls_total, 2)
  assert.equal(debug.decision_input_units_total, 300)
  assert.equal(debug.decision_output_units_total, 22)
  assert.equal(debug.decision_cost_micro_usd_total, 13)
  assert.equal(debug.decision_shadow_matches_total, 1)
  assert.equal(debug.decision_shadow_mismatches_total, 1)
  assert.equal(debug.decision_planner_skips_total, 0)
  assert.equal(debug.decision_planner_wakes_total, 0)

  debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'new task' }, debug, {
    request_id: 'req-jev-next',
  })
  assert.equal(debug.decision_calls_total, 2)
  assert.equal(debug.decision_input_units_total, 300)
  assert.equal(debug.decision_cost_micro_usd_total, 13)

  debug = liveAgentDebugEvent('planner.skipped', { source: 'decision_provider' }, debug)
  debug = liveAgentDebugEvent('planner.wake', { source: 'decision_provider' }, debug)
  assert.equal(debug.decision_planner_skips_total, 1)
  assert.equal(debug.decision_planner_wakes_total, 1)
})

test('request cumulative usage stays separate from the latest completed provider round', () => {
  let debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'multi-round request' }, undefined, {
    request_id: 'req-multi',
    usage: {
      input_units: 0,
      cached_input_units: 0,
      output_units: 0,
      total_units: 0,
    },
  })

  debug = liveAgentDebugEvent('provider.response', {
    round: 0,
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
    provider: { model: 'test-model', finish_reason: 'tool_calls' },
  }, debug, {
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
  })
  assert.equal(debug.input_units, 100)
  assert.equal(debug.cached_input_units, 80)
  assert.equal(debug.output_units, 10)
  assert.equal(debug.total_units, 110)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_input_units, 100)
  assert.equal(debug.latest_round_cached_input_units, 80)
  assert.equal(debug.latest_round_output_units, 10)
  assert.equal(debug.latest_round_total_units, 110)

  // Starting another provider call keeps the previous completed round visible;
  // it does not fabricate usage for the in-flight round.
  debug = liveAgentDebugEvent('provider.request', { round: 1 }, debug, {
    usage: {
      input_units: 100,
      cached_input_units: 80,
      output_units: 10,
      total_units: 110,
    },
  })
  assert.equal(debug.provider_round, 1)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_total_units, 110)

  debug = liveAgentDebugEvent('provider.response', {
    round: 1,
    usage: {
      input_units: 120,
      cached_input_units: 90,
      output_units: 20,
      total_units: 140,
    },
    provider: { model: 'test-model', finish_reason: 'stop' },
  }, debug, {
    usage: {
      input_units: 220,
      cached_input_units: 170,
      output_units: 30,
      total_units: 250,
    },
  })

  // Cached input is already included in input. Neither the per-round nor
  // cumulative total adds cached tokens a second time.
  assert.equal(debug.input_units, 220)
  assert.equal(debug.cached_input_units, 170)
  assert.ok(debug.cached_input_units <= debug.input_units)
  assert.equal(debug.output_units, 30)
  assert.equal(debug.total_units, 250)
  assert.equal(debug.total_units, debug.input_units + debug.output_units)
  assert.equal(debug.latest_round_provider_round, 1)
  assert.equal(debug.latest_round_input_units, 120)
  assert.equal(debug.latest_round_cached_input_units, 90)
  assert.ok(debug.latest_round_cached_input_units <= debug.latest_round_input_units)
  assert.equal(debug.latest_round_output_units, 20)
  assert.equal(debug.latest_round_total_units, 140)
  assert.equal(debug.latest_round_total_units, debug.latest_round_input_units + debug.latest_round_output_units)
})

test('starting a new request resets cumulative and latest-round debug usage', () => {
  const previous = {
    request_id: 'old-request',
    input_units: 220,
    cached_input_units: 170,
    output_units: 30,
    total_units: 250,
    latest_round_provider_round: 1,
    latest_round_input_units: 120,
    latest_round_cached_input_units: 90,
    latest_round_output_units: 20,
    latest_round_total_units: 140,
    response_id: 'old-response',
    response_bytes: 4096,
    tool_call_count: 2,
    structured_content: { json_valid: true, plan_valid: false, error: 'old schema error' },
    reasoning_effort: 'max',
    reasoning_policy_reason: 'repeated_failure',
  }

  const debug = liveAgentDebugEvent('request.received', { sender: 'TTLouis', text: 'new request' }, previous, {
    request_id: 'new-request',
    usage: {
      input_units: 0,
      cached_input_units: 0,
      output_units: 0,
      total_units: 0,
    },
  })

  assert.equal(debug.request_id, 'new-request')
  assert.equal(debug.input_units, 0)
  assert.equal(debug.cached_input_units, 0)
  assert.equal(debug.output_units, 0)
  assert.equal(debug.total_units, 0)
  assert.equal(debug.latest_round_provider_round, 0)
  assert.equal(debug.latest_round_input_units, 0)
  assert.equal(debug.latest_round_cached_input_units, 0)
  assert.equal(debug.latest_round_output_units, 0)
  assert.equal(debug.latest_round_total_units, 0)
  assert.equal(debug.response_id, undefined)
  assert.equal(debug.response_bytes, undefined)
  assert.equal(debug.tool_call_count, undefined)
  assert.equal(debug.structured_content, undefined)
  assert.equal(debug.reasoning_effort, '')
  assert.equal(debug.reasoning_policy_reason, '')
})

test('request failure snapshot wins over transient debug state and remains displayable', () => {
  let debug = liveAgentDebugEvent('request.failed', {
    message: 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON',
    failure_snapshot: {
      request_id: 'req-final',
      turn: 1,
      actor_id: 27,
      epoch: 84,
      provider: {
        round: 6,
        recovery_attempt: 3,
        latency_ms: 10639,
        provider: {
          model: 'deepseek-flash',
          finish_reason: 'length',
          diagnostic_code: 'provider_output_truncated_empty_content',
          response_id: 'resp-final',
          response_bytes: 3333,
          tool_call_count: 0,
          content_chars: 0,
          content_utf8_bytes: 0,
          content_non_ascii_chars: 0,
          content_replacement_chars: 0,
          normalized_content_chars: 0,
          structured_content: { json_valid: false, plan_valid: false, error: 'empty content' },
          reasoning_content_chars: 9172,
        },
      },
      recovery: { attempt: 3 },
      last_tool: { phase: 'result', name: 'getEntityGeometry' },
      usage: {
        input_units: 116194,
        cached_input_units: 99328,
        output_units: 10708,
        total_units: 126902,
      },
    },
  }, {
    request_id: 'stale',
    provider_round: 1,
    last_tool: 'oldTool',
  })

  assert.equal(debug.request_id, 'req-final')
  assert.equal(debug.provider_round, 6)
  assert.equal(debug.recovery_attempt, 3)
  assert.equal(debug.provider_model, 'deepseek-flash')
  assert.equal(debug.provider_latency_ms, 10639)
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.response_id, 'resp-final')
  assert.equal(debug.response_bytes, 3333)
  assert.equal(debug.tool_call_count, 0)
  assert.equal(debug.content_chars, 0)
  assert.equal(debug.content_utf8_bytes, 0)
  assert.equal(debug.normalized_content_chars, 0)
  assert.deepEqual(debug.structured_content, { json_valid: false, plan_valid: false, error: 'empty content' })
  assert.equal(debug.reasoning_content_chars, 9172)
  assert.equal(debug.last_tool, 'getEntityGeometry')
  assert.equal(debug.actor_id, 27)
  assert.equal(debug.actor_epoch, 84)
  assert.equal(debug.total_units, 126902)
  assert.match(debug.last_error, /recovery exhausted after 3 attempts/i)

  // Heartbeats/status refreshes must not erase the frozen failure diagnostics.
  debug = liveAgentDebugEvent('factorio.status', { observation_mode: 'unchanged' }, debug)
  assert.equal(debug.request_id, 'req-final')
  assert.equal(debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(debug.provider_finish_reason, 'length')
  assert.equal(debug.response_id, 'resp-final')
  assert.equal(debug.response_bytes, 3333)
  assert.deepEqual(debug.structured_content, { json_valid: false, plan_valid: false, error: 'empty content' })
  assert.equal(debug.reasoning_content_chars, 9172)
  assert.equal(debug.last_error, 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON')
})

test('task board UI snapshot includes live debug diagnostics', () => {
  const state = {
    goal_id: 'goal-1',
    objective: 'build a burner miner line',
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal-1',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: 1,
      active_index: 0,
      steps: [{ id: 'step-1', description: 'place miner', status: 'active' }],
    },
    last_operations: [],
  }
  const live = {
    phase: 'error',
    detail: 'Request failed',
    activity: [{ kind: 'blocker', text: 'Request failed' }],
    debug: {
      request_id: 'req-1',
      turn: 1,
      provider_model: 'deepseek-flash',
      provider_round: 6,
      provider_latency_ms: 10000,
      provider_diagnostic_code: 'provider_output_truncated_empty_content',
      provider_finish_reason: 'length',
      reasoning_effort: 'max',
      reasoning_policy_reason: 'repeated_failure',
      response_id: 'resp-ui',
      response_bytes: 7654,
      tool_call_count: 1,
      content_chars: 0,
      content_utf8_bytes: 42,
      content_non_ascii_chars: 9,
      content_replacement_chars: 1,
      normalized_content_chars: 38,
      structured_content: { json_valid: true, plan_valid: false, error: 'missing plan' },
      reasoning_content_chars: 8123,
      input_units: 100,
      cached_input_units: 80,
      output_units: 20,
      total_units: 120,
      latest_round_provider_round: 5,
      latest_round_input_units: 30,
      latest_round_cached_input_units: 20,
      latest_round_output_units: 5,
      latest_round_total_units: 35,
      last_tool: 'getActorStatus',
      last_event: 'request.failed',
      recovery_attempt: 3,
      last_error: 'Invalid provider content JSON',
      actor_id: 18,
      actor_epoch: 3,
    },
  }

  const snapshot = taskBoardUiSnapshot(state, live)
  assert.equal(snapshot.debug.request_id, 'req-1')
  assert.equal(snapshot.debug.provider_round, 6)
  assert.equal(snapshot.debug.provider_diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(snapshot.debug.provider_finish_reason, 'length')
  assert.equal(snapshot.debug.reasoning_effort, 'max')
  assert.equal(snapshot.debug.reasoning_policy_reason, 'repeated_failure')
  assert.equal(snapshot.debug.response_id, 'resp-ui')
  assert.equal(snapshot.debug.response_bytes, 7654)
  assert.equal(snapshot.debug.tool_call_count, 1)
  assert.equal(snapshot.debug.content_chars, 0)
  assert.equal(snapshot.debug.content_utf8_bytes, 42)
  assert.equal(snapshot.debug.content_non_ascii_chars, 9)
  assert.equal(snapshot.debug.content_replacement_chars, 1)
  assert.equal(snapshot.debug.normalized_content_chars, 38)
  assert.deepEqual(snapshot.debug.structured_content, { json_valid: true, plan_valid: false, error: 'missing plan' })
  assert.equal(snapshot.debug.reasoning_content_chars, 8123)
  assert.equal(snapshot.debug.input_units, 100)
  assert.equal(snapshot.debug.cached_input_units, 80)
  assert.equal(snapshot.debug.latest_round_provider_round, 5)
  assert.equal(snapshot.debug.latest_round_input_units, 30)
  assert.equal(snapshot.debug.latest_round_cached_input_units, 20)
  assert.equal(snapshot.debug.latest_round_output_units, 5)
  assert.equal(snapshot.debug.latest_round_total_units, 35)
  assert.equal(snapshot.debug.recovery_attempt, 3)
  assert.equal(snapshot.debug.last_event, 'request.failed')
})


test('active Jev post-step routing is tracked separately from interaction shadow routing', () => {
  let debug = liveAgentDebugEvent('interaction.routed', {
    intent: 'status_query',
    decision_shadow_latency_ms: 80,
    decision_shadow: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      intent: 'status_query',
      intent_confidence: 0.93,
      queue_conflict_probability: 0.02,
      usage: { input_tokens: 120, output_tokens: 10, cost: 0.00000504 },
    },
  })

  debug = liveAgentDebugEvent('post_step.routed', {
    mode: 'active',
    route: 'wait_runtime',
    applied_route: 'fallback_planner',
    fallback_reason: 'wait_runtime_without_authoritative_healthy_persistent_runtime',
    decision_latency_ms: 44,
    decision: {
      provider: 'TypeSafe',
      model: 'jev-latest',
      route: 'wait_runtime',
      confidence: 0.88,
      usage: { input_tokens: 90, output_tokens: 8, cost: 0.00000378 },
    },
  }, debug)

  assert.equal(debug.decision_shadow_intent, 'status_query')
  assert.equal(debug.decision_active_intent, 'status_query')
  assert.equal(debug.decision_post_step_route, 'wait_runtime')
  assert.equal(debug.decision_post_step_applied_route, 'fallback_planner')
  assert.equal(debug.decision_post_step_confidence_percent, 88)
  assert.equal(debug.decision_post_step_latency_ms, 44)
  assert.match(debug.decision_post_step_fallback, /wait_runtime_without/)
  assert.equal(debug.decision_calls_total, 2)
  assert.equal(debug.decision_input_units_total, 210)
  assert.equal(debug.decision_output_units_total, 18)
  assert.equal(debug.decision_post_step_calls_total, 1)

  debug = liveAgentDebugEvent('planner.wake', { source: 'decision_provider', route: 'fallback_planner' }, debug)
  assert.equal(debug.decision_planner_wakes_total, 1)
  assert.equal(debug.decision_planner_continue_low_wakes_total, 0)
  assert.equal(debug.decision_planner_replan_high_wakes_total, 0)
  assert.equal(debug.decision_planner_fallback_wakes_total, 1)
})


test('task board UI omits retired project hierarchy while preserving plan steps', () => {
  const state = {
    goal_id: 'goal-rocket',
    objective: 'Launch a rocket',
    project_board: {
      kind: 'project_board_v1',
      project_id: 'goal-rocket',
      title: 'Launch a rocket',
      status: 'active',
      current_milestone: { id: 'bootstrap', title: 'Establish burner production', status: 'active', completion_summary: 'Stable early production exists.' },
      next_milestones: [{ id: 'automation', title: 'Reach Automation', status: 'tentative' }],
      development_direction: 'vertical',
      revision: 2,
      updated_at: 123,
    },
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal-rocket',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: 1,
      active_index: 0,
      steps: [{ id: 'step-1', description: 'Gather stone for the first furnaces', status: 'active' }],
    },
  }
  const snapshot = taskBoardUiSnapshot(state, { phase: 'thinking', activity: [], debug: {} })
  assert.equal(snapshot.project, undefined)
  assert.equal(snapshot.steps[0].description, 'Gather stone for the first furnaces')
})
