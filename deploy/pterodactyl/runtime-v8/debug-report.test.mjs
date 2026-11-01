import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFailureReport, formatFailureReport, parseJsonl } from './debug-report.mjs'

test('debug report correlates final failure with provider and prompt diagnostics', () => {
  const behavior = [
    {
      schema: 1,
      ts: '2026-09-17T04:00:00.000Z',
      seq: 1,
      event: 'request.received',
      request_id: 'req-test',
      turn: 1,
      data: { sender: 'TTLouis', text: '测试中文任务' },
    },
    {
      schema: 1,
      ts: '2026-09-17T04:00:01.000Z',
      seq: 2,
      event: 'provider.response',
      request_id: 'req-test',
      turn: 1,
      actor_id: 27,
      epoch: 84,
      data: {
        kind: 'response',
        round: 6,
        recovery_attempt: 3,
        latency_ms: 10639,
        provider: {
          response_id: 'resp-final',
          model: 'deepseek-flash',
          finish_reason: 'length',
          diagnostic_code: 'provider_output_truncated_empty_content',
          response_bytes: 512,
          content_chars: 0,
          content_utf8_bytes: 0,
          content_non_ascii_chars: 0,
          content_replacement_chars: 0,
          normalized_content_chars: 0,
          reasoning_content_chars: 8400,
          tool_call_count: 0,
          structured_content: { json_valid: false, plan_valid: false, error: 'empty content' },
        },
      },
    },
    {
      schema: 1,
      ts: '2026-09-17T04:00:02.000Z',
      seq: 3,
      event: 'request.failed',
      request_id: 'req-test',
      turn: 1,
      data: {
        stage: 'runtime',
        message: 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON',
        failure_snapshot: {
          stage: 'runtime',
          message: 'Provider response recovery exhausted after 3 attempts: Invalid provider content JSON',
          request_id: 'req-test',
          turn: 1,
          actor_id: 27,
          epoch: 84,
          provider: {
            kind: 'response',
            round: 6,
            recovery_attempt: 3,
            latency_ms: 10639,
            provider: {
              response_id: 'resp-final',
              model: 'deepseek-flash',
              finish_reason: 'length',
              diagnostic_code: 'provider_output_truncated_empty_content',
              content_chars: 0,
              content_utf8_bytes: 0,
              content_non_ascii_chars: 0,
              content_replacement_chars: 0,
              reasoning_content_chars: 8400,
              tool_call_count: 0,
              structured_content: { json_valid: false, plan_valid: false, error: 'empty content' },
            },
          },
          recovery: { reason: 'Invalid provider content JSON', round_base: 3, attempt: 3 },
          last_tool: { phase: 'result', name: 'getEntityGeometry', output_chars: 941 },
          plan: { goal_id: 'goal-1', status: 'active', current_step: 2, current_step_text: '搭建产线' },
          usage: { provider_calls: 7, input_units: 116194, output_units: 10708, total_units: 126902 },
        },
      },
    },
  ]
  const prompts = [
    {
      schema: 1,
      event: 'provider.request',
      ts: '2026-09-17T04:00:00.500Z',
      request_id: 'req-test',
      round: 6,
      recovery_attempt: 3,
      allow_tools: false,
      trigger_source: 'recovery',
      stats: { body_chars: 52000, message_count: 9, message_chars: 51000, tool_count: 0, tool_schema_chars: 0 },
    },
    {
      schema: 1,
      event: 'provider.response',
      ts: '2026-09-17T04:00:01.000Z',
      request_id: 'req-test',
      round: 6,
      recovery_attempt: 3,
      diagnostic_code: 'provider_output_truncated_empty_content',
      finish_reason: 'length',
      content_chars: 0,
      reasoning_content_chars: 8400,
    },
  ]

  const report = buildFailureReport(behavior, prompts)
  assert.equal(report.request.request_id, 'req-test')
  assert.equal(report.request.actor_id, 27)
  assert.equal(report.provider.model, 'deepseek-flash')
  assert.equal(report.provider.round, 6)
  assert.equal(report.provider.recovery_attempt, 3)
  assert.equal(report.provider.diagnostic_code, 'provider_output_truncated_empty_content')
  assert.equal(report.provider.finish_reason, 'length')
  assert.equal(report.provider.content_chars, 0)
  assert.equal(report.provider.reasoning_content_chars, 8400)
  assert.equal(report.provider.structured_content.json_valid, false)
  assert.equal(report.last_tool.name, 'getEntityGeometry')
  assert.equal(report.prompt_request.stats.message_count, 9)
  assert.ok(report.diagnosis_hints.some(hint => /output budget/i.test(hint)))
  assert.ok(report.diagnosis_hints.some(hint => /recovery was exhausted/i.test(hint)))

  const text = formatFailureReport(report)
  assert.match(text, /provider_output_truncated_empty_content/)
  assert.match(text, /reasoning_chars=8400/)
  assert.match(text, /getEntityGeometry/)
})

test('debug report flags UTF-8 replacement evidence separately from JSON failure', () => {
  const behavior = [{
    event: 'request.failed',
    request_id: 'req-utf8',
    data: {
      message: 'Invalid provider content JSON',
      failure_snapshot: {
        request_id: 'req-utf8',
        provider: {
          round: 1,
          provider: {
            model: 'test-model',
            finish_reason: 'stop',
            diagnostic_code: 'ok',
            content_chars: 120,
            content_utf8_bytes: 150,
            content_non_ascii_chars: 12,
            content_replacement_chars: 2,
            reasoning_content_chars: 0,
            tool_call_count: 0,
            structured_content: { json_valid: false, plan_valid: false, error: 'Unexpected token' },
          },
        },
      },
    },
  }]

  const report = buildFailureReport(behavior, [])
  assert.equal(report.provider.content_replacement_chars, 2)
  assert.ok(report.diagnosis_hints.some(hint => /UTF-8 replacement/i.test(hint)))
  assert.ok(report.diagnosis_hints.some(hint => /not valid JSON/i.test(hint)))
})

test('JSONL parser keeps good rows and reports malformed lines without throwing', () => {
  const parsed = parseJsonl('{"event":"one"}\nnot-json\n{"event":"two"}\n')
  assert.deepEqual(parsed.rows.map(row => row.event), ['one', 'two'])
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.errors[0].line, 2)
})
