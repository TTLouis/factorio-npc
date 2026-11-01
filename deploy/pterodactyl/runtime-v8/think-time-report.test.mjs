import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeThinkTime, buildThinkTimeReport, formatThinkTimeReport, summarizeByPolicyReason, summarizeByRequest, summarizeOverall } from './think-time-report.mjs'

// Field shapes below mirror a real sgluna-prompts.jsonl (2026-09-25 live
// trace): no request_id is ever traced (npc-agent-loop.mjs never passes
// options.requestId into provider()), so a request boundary is round
// resetting to 0. This fixture reproduces two such requests: the first a
// three-round plan_authoring request whose middle round is the slowest, the
// second a shorter request that hits an output-budget recovery (a
// provider.response with finish_reason "length" followed by a same-round
// recovery attempt) and then a transport error on its next round.
function fixtureRows() {
  return [
    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:00:00.000Z', round: 0, recovery_attempt: 0, trigger_source: 'new_goal', reasoning_effort: 'max', reasoning_policy_reason: 'plan_authoring' },
    { schema: 1, event: 'provider.response', ts: '2026-09-25T15:00:20.000Z', round: 0, recovery_attempt: 0, finish_reason: 'tool_calls', diagnostic_code: 'ok', reasoning_effort: 'max', reasoning_policy_reason: 'plan_authoring', reported_reasoning_tokens: 900 },
    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:00:20.500Z', round: 1, recovery_attempt: 0, trigger_source: 'recovery', reasoning_effort: 'max', reasoning_policy_reason: 'plan_authoring' },
    { schema: 1, event: 'provider.response', ts: '2026-09-25T15:01:30.500Z', round: 1, recovery_attempt: 0, finish_reason: 'tool_calls', diagnostic_code: 'ok', reasoning_effort: 'max', reasoning_policy_reason: 'plan_authoring', reported_reasoning_tokens: 8051 },
    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:01:31.000Z', round: 2, recovery_attempt: 0, trigger_source: 'recovery', reasoning_effort: 'high', reasoning_policy_reason: 'ordinary_planning' },
    { schema: 1, event: 'provider.response', ts: '2026-09-25T15:01:45.000Z', round: 2, recovery_attempt: 0, finish_reason: 'tool_calls', diagnostic_code: 'ok', reasoning_effort: 'high', reasoning_policy_reason: 'ordinary_planning', reported_reasoning_tokens: 300 },

    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:05:00.000Z', round: 0, recovery_attempt: 0, trigger_source: 'completion', reasoning_effort: 'low', reasoning_policy_reason: 'deterministic_completion' },
    { schema: 1, event: 'provider.response', ts: '2026-09-25T15:05:15.000Z', round: 0, recovery_attempt: 0, finish_reason: 'length', diagnostic_code: 'provider_output_budget_exhausted', reasoning_effort: 'low', reasoning_policy_reason: 'deterministic_completion' },
    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:05:15.100Z', round: 0, recovery_attempt: 1, trigger_source: 'recovery', reasoning_effort: 'none', reasoning_policy_reason: 'output_budget_recovery' },
    { schema: 1, event: 'provider.response', ts: '2026-09-25T15:05:16.600Z', round: 0, recovery_attempt: 1, finish_reason: 'stop', diagnostic_code: 'ok', reasoning_effort: 'none', reasoning_policy_reason: 'output_budget_recovery' },
    { schema: 1, event: 'provider.request', ts: '2026-09-25T15:05:17.000Z', round: 1, recovery_attempt: 0, trigger_source: 'recovery', reasoning_effort: 'high', reasoning_policy_reason: 'ordinary_planning' },
    { schema: 1, event: 'provider.response_error', ts: '2026-09-25T15:05:17.700Z', round: 1, recovery_attempt: 0, diagnostic_code: 'provider_http_error', http_status: 400, reasoning_effort: 'high', reasoning_policy_reason: 'ordinary_planning' },
  ]
}

test('analyzeThinkTime splits the trace into requests at each round-0 reset', () => {
  const requests = analyzeThinkTime(fixtureRows())
  assert.equal(requests.length, 2)
  assert.equal(requests[0].rounds.length, 3)
  assert.equal(requests[1].rounds.length, 3)
  assert.equal(requests[0].started_ts, '2026-09-25T15:00:00.000Z')
  assert.equal(requests[1].started_ts, '2026-09-25T15:05:00.000Z')
})

test('analyzeThinkTime matches request/response pairs by round and recovery_attempt and computes latency', () => {
  const requests = analyzeThinkTime(fixtureRows())
  const [round0, round1, round2] = requests[0].rounds
  assert.equal(round0.latency_ms, 20000)
  assert.equal(round1.latency_ms, 70000)
  assert.equal(round2.latency_ms, 14000)
  assert.equal(round1.reasoning_tokens, 8051)

  const secondRequest = requests[1].rounds
  // Same round (0), two recovery attempts: the exhausted attempt and its
  // low-effort recovery retry are both distinct provider calls.
  assert.equal(secondRequest[0].recovery_attempt, 0)
  assert.equal(secondRequest[0].finish_reason, 'length')
  assert.equal(secondRequest[1].recovery_attempt, 1)
  assert.equal(secondRequest[1].latency_ms, 1500)
  // The transport error round has no finish_reason but is still measured.
  assert.equal(secondRequest[2].event, 'provider.response_error')
  assert.equal(secondRequest[2].finish_reason, undefined)
  assert.equal(secondRequest[2].latency_ms, 700)
})

test('summarizeByRequest reports rounds, p50/max latency, reasoning tokens, and the slowest round', () => {
  const requests = analyzeThinkTime(fixtureRows())
  const summary = summarizeByRequest(requests)
  assert.equal(summary.length, 2)

  const first = summary[0]
  assert.equal(first.count, 3)
  assert.equal(first.matched_latency_count, 3)
  // Latencies: 20000, 70000, 14000 -> sorted [14000, 20000, 70000] -> p50 = 20000
  assert.equal(first.p50_latency_ms, 20000)
  assert.equal(first.max_latency_ms, 70000)
  assert.equal(first.reasoning_tokens_total, 900 + 8051 + 300)
  assert.equal(first.length_finish_count, 0)
  assert.equal(first.error_count, 0)
  assert.equal(first.slowest_round.round, 1)
  assert.equal(first.slowest_round.latency_ms, 70000)
  assert.equal(first.slowest_round.reasoning_effort, 'max')
  assert.equal(first.slowest_round.reasoning_policy_reason, 'plan_authoring')

  const second = summary[1]
  assert.equal(second.count, 3)
  assert.equal(second.length_finish_count, 1)
  assert.equal(second.error_count, 1)
})

test('summarizeByPolicyReason groups every round across requests by reasoning_policy_reason', () => {
  const requests = analyzeThinkTime(fixtureRows())
  const byReason = summarizeByPolicyReason(requests)
  const byName = Object.fromEntries(byReason.map(row => [row.reasoning_policy_reason, row]))

  assert.equal(byName.plan_authoring.count, 2)
  assert.equal(byName.plan_authoring.max_latency_ms, 70000)
  assert.equal(byName.plan_authoring.reasoning_tokens_total, 900 + 8051)

  // ordinary_planning appears once in each request (round 2 of the first,
  // round 1 of the second, which errored).
  assert.equal(byName.ordinary_planning.count, 2)
  assert.equal(byName.ordinary_planning.error_count, 1)
  assert.equal(byName.ordinary_planning.matched_latency_count, 2)

  assert.equal(byName.deterministic_completion.count, 1)
  assert.equal(byName.deterministic_completion.length_finish_count, 1)

  assert.equal(byName.output_budget_recovery.count, 1)
  assert.equal(byName.output_budget_recovery.max_latency_ms, 1500)
})

test('summarizeOverall aggregates every round in the trace', () => {
  const requests = analyzeThinkTime(fixtureRows())
  const overall = summarizeOverall(requests)
  assert.equal(overall.request_count, 2)
  assert.equal(overall.count, 6)
  assert.equal(overall.length_finish_count, 1)
  assert.equal(overall.error_count, 1)
})

test('buildThinkTimeReport and formatThinkTimeReport produce a readable summary without leaking payload/content fields', () => {
  const report = buildThinkTimeReport(fixtureRows())
  assert.equal(report.overall.request_count, 2)
  assert.ok(Array.isArray(report.by_request))
  assert.ok(Array.isArray(report.by_policy_reason))

  const text = formatThinkTimeReport(report)
  assert.match(text, /SGLuna think-time report/)
  assert.match(text, /plan_authoring/)
  assert.match(text, /requests: 2/)
  // Never surface prompt/response payload or content text in the summary.
  assert.doesNotMatch(text, /payload/i)
  assert.doesNotMatch(text, /content_preview/i)
})

test('a trace with no request/response pairing still reports safely', () => {
  const report = buildThinkTimeReport([
    { event: 'provider.response', ts: '2026-09-25T15:00:01.000Z', round: 3, recovery_attempt: 0, finish_reason: 'tool_calls', reasoning_policy_reason: 'ordinary_planning' },
  ])
  assert.equal(report.overall.request_count, 1)
  assert.equal(report.overall.count, 1)
  assert.equal(report.overall.matched_latency_count, 0)
  assert.equal(report.overall.p50_latency_ms, undefined)
})
