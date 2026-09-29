import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'
import { analyzeBehaviorTrace, formatCheckReport, runCheck, UsageError } from './run-check.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, 'fixtures', 'run-check')

async function loadFixtureRows(name) {
  const text = await fsp.readFile(path.join(fixturesDir, name), 'utf8')
  const { rows, errors } = parseJsonl(text)
  assert.equal(errors.length, 0, `fixture ${name} should parse cleanly`)
  return rows
}

function findingsFor(result, signature) {
  return result.findings.filter(f => f.signature === signature)
}

// --- real-log fixtures (trimmed from data/logs/sgluna-behavior.jsonl) -----

test('observation_phase_closed loop is detected from repeated recovery.classified retries (qwen round, req_muixboqf_1)', async () => {
  const rows = await loadFixtureRows('qwen-observation-phase-closed-loop.jsonl')
  const result = analyzeBehaviorTrace(rows)

  const loop = findingsFor(result, 'observation_phase_closed_loop')
  assert.equal(loop.length, 1)
  assert.equal(loop[0].request_id, 'req_muixboqf_1')
  assert.equal(loop[0].count, 4)
  assert.equal(loop[0].first_ts, '2026-09-26T21:53:30.828Z')

  // The same request also ends blocked_before_mutation with zero cached input --
  // real trace, so this exercises three signatures off one fixture.
  assert.equal(findingsFor(result, 'blocked_before_mutation').length, 1)
  const zeroCached = findingsFor(result, 'zero_cached_input')
  assert.equal(zeroCached.length, 1)
  assert.match(zeroCached[0].detail, /input_units=98611, cached_input_units=0/)
})

test('invalid_tool_batch repeated is detected from recovery.classified retries (qwen round, req_muizw6hg_2)', async () => {
  const rows = await loadFixtureRows('qwen-invalid-tool-batch-repeated.jsonl')
  const result = analyzeBehaviorTrace(rows)

  const invalidBatch = findingsFor(result, 'invalid_tool_batch_repeated')
  assert.equal(invalidBatch.length, 1)
  assert.equal(invalidBatch[0].request_id, 'req_muizw6hg_2')
  assert.equal(invalidBatch[0].count, 3)

  // This request also hit the observation-phase-closed loop before failing.
  assert.equal(findingsFor(result, 'observation_phase_closed_loop').length, 1)
  assert.equal(findingsFor(result, 'blocked_before_mutation').length, 1)
})

test('provider_turn_output_cap_exceeded and no_chat_reply are detected from the steam run tail (req_muhsihjg_1)', async () => {
  const rows = await loadFixtureRows('steam-run-provider-output-cap.jsonl')
  const result = analyzeBehaviorTrace(rows)

  const cap = findingsFor(result, 'provider_turn_output_cap_exceeded')
  assert.equal(cap.length, 1)
  assert.equal(cap[0].request_id, 'req_muhsihjg_1')
  assert.equal(cap[0].count, 2) // provider.error + request.failed both carry the message
  assert.equal(cap[0].first_ts, '2026-09-26T03:26:59.377Z')

  // request.failed never carries a chat_message field -- the player got nothing.
  const noChat = findingsFor(result, 'no_chat_reply')
  assert.equal(noChat.length, 1)
  assert.equal(noChat[0].request_id, 'req_muhsihjg_1')
  assert.match(noChat[0].detail, /request\.failed carries no chat_message field/)
})

test('clean step progress (real log, plan.persisted -> step.verified) produces no findings', async () => {
  const rows = await loadFixtureRows('steam-run-clean-step-progress.jsonl')
  const result = analyzeBehaviorTrace(rows)
  assert.deepEqual(result.findings, [])
  assert.equal(result.request_count, 1)
})

// --- synthetic fixtures (real log has no example of these two states) -----

test('SYNTHETIC: a goal paused with no chat line is detected', async () => {
  const rows = await loadFixtureRows('synthetic-goal-paused-no-chat.jsonl')
  const result = analyzeBehaviorTrace(rows)

  const paused = findingsFor(result, 'goal_paused_no_chat')
  assert.equal(paused.length, 1)
  assert.equal(paused[0].request_id, 'req_synth_pause_1')
  assert.match(paused[0].detail, /transient_provider_failure_retries_exhausted/)
})

test('SYNTHETIC: a stale step (tracker behind the batch) is detected', async () => {
  const rows = await loadFixtureRows('synthetic-stale-step-tracker-behind-batch.jsonl')
  const result = analyzeBehaviorTrace(rows)

  const stale = findingsFor(result, 'stale_step_tracker_behind_batch')
  assert.equal(stale.length, 1)
  assert.equal(stale[0].request_id, 'req_synth_stale_1')
  assert.match(stale[0].detail, /step_1.*batch_id=2/)
})

test('the same step/batch shape does NOT flag once the step is marked completed (regression guard, real log)', async () => {
  // steam-run-clean-step-progress.jsonl is the fixed sequence: factorio.status
  // reports batch_id=1 while step_1 is active, then step.verified both marks
  // step_1 completed and records deterministic_verification evidence for
  // batch_id=1 before the request moves on to step_2. This is the exact
  // ordering the comment at npc-agent-loop.mjs:5101-5103 describes fixing.
  const rows = await loadFixtureRows('steam-run-clean-step-progress.jsonl')
  const result = analyzeBehaviorTrace(rows)
  assert.equal(findingsFor(result, 'stale_step_tracker_behind_batch').length, 0)
})

// --- since filtering --------------------------------------------------

test('[since] drops findings whose contributing rows are entirely before the cutoff', async () => {
  const rows = await loadFixtureRows('qwen-observation-phase-closed-loop.jsonl')
  const withoutSince = analyzeBehaviorTrace(rows)
  assert.equal(findingsFor(withoutSince, 'observation_phase_closed_loop').length, 1)

  // All four observation_phase_closed retries happen before 21:54:20Z; the
  // terminal request.completed (blocked_before_mutation / zero_cached_input)
  // happens at 21:54:26Z, after the cutoff.
  const sinceResult = analyzeBehaviorTrace(rows, { since: '2026-09-26T21:54:20.000Z' })
  assert.equal(findingsFor(sinceResult, 'observation_phase_closed_loop').length, 0)
  assert.equal(findingsFor(sinceResult, 'blocked_before_mutation').length, 1)
  assert.equal(findingsFor(sinceResult, 'zero_cached_input').length, 1)
  assert.equal(sinceResult.since, '2026-09-26T21:54:20.000Z')
})

test('an unparseable since value raises UsageError', () => {
  assert.throws(() => analyzeBehaviorTrace([], { since: 'not-a-timestamp' }), UsageError)
})

// --- malformed input tolerance -----------------------------------------

test('malformed JSONL lines are tolerated (counted, not thrown)', () => {
  const text = [
    JSON.stringify({ schema: 1, ts: '2026-09-27T00:00:00.000Z', seq: 1, event: 'request.received', request_id: 'req_bad_1', turn: 1, data: {} }),
    '{not valid json',
    JSON.stringify({ schema: 1, ts: '2026-09-27T00:00:01.000Z', seq: 2, event: 'request.completed', request_id: 'req_bad_1', turn: 1, data: { outcome: 'ok', chat_message: 'done' } }),
    '',
  ].join('\n')
  const { rows, errors } = parseJsonl(text)
  assert.equal(errors.length, 1)
  assert.doesNotThrow(() => analyzeBehaviorTrace(rows))
  const result = analyzeBehaviorTrace(rows)
  assert.equal(result.findings.length, 0)
  assert.equal(result.row_count, 2)
})

test('rows with no request_id are ignored instead of crashing the grouping', () => {
  const rows = [{ schema: 1, ts: '2026-09-27T00:00:00.000Z', seq: 1, event: 'interaction.routed', data: {} }]
  const result = analyzeBehaviorTrace(rows)
  assert.equal(result.request_count, 0)
  assert.deepEqual(result.findings, [])
})

// --- formatting ----------------------------------------------------------

test('formatCheckReport prints a clean message when there are no findings', () => {
  const text = formatCheckReport({ findings: [], request_count: 3, row_count: 40 })
  assert.match(text, /No known failure signatures found\./)
})

test('formatCheckReport lists each finding with signature, request_id, count and first_ts', () => {
  const text = formatCheckReport({
    findings: [{ signature: 'blocked_before_mutation', label: 'blocked_before_mutation', request_id: 'req_x', count: 1, first_ts: '2026-09-27T00:00:00.000Z', detail: 'because reasons' }],
    request_count: 1,
    row_count: 5,
  })
  assert.match(text, /\[blocked_before_mutation\] request_id=req_x count=1 first_ts=2026-09-27T00:00:00\.000Z :: because reasons/)
})

// --- file-reading wrapper (runCheck) -------------------------------------

test('runCheck reads a fixture file end to end and reports parse errors separately from findings', async () => {
  const { result, parse_errors: parseErrors } = await runCheck({ behaviorFile: path.join(fixturesDir, 'synthetic-stale-step-tracker-behind-batch.jsonl') })
  assert.equal(parseErrors.length, 0)
  assert.equal(findingsFor(result, 'stale_step_tracker_behind_batch').length, 1)
})

test('runCheck throws UsageError for a missing file (maps to exit code 2 in the CLI)', async () => {
  await assert.rejects(
    () => runCheck({ behaviorFile: path.join(fixturesDir, 'does-not-exist.jsonl') }),
    UsageError,
  )
})

test('no_chat_reply: a request.failed answered by chat.request_failed_reported is not flagged, a silent one is', () => {
  const failed = { ts: '2026-09-29T10:00:00.000Z', seq: 5, event: 'request.failed', request_id: 'req_a_1', data: { message: 'boom' } }
  const reported = { ts: '2026-09-29T10:00:01.000Z', seq: 6, event: 'chat.request_failed_reported', request_id: 'req_a_1', data: { chat_line_length: 20, resume_hint_included: false } }
  assert.equal(findingsFor(analyzeBehaviorTrace([failed, reported]), 'no_chat_reply').length, 0)
  assert.equal(findingsFor(analyzeBehaviorTrace([failed]), 'no_chat_reply').length, 1)
  assert.equal(findingsFor(analyzeBehaviorTrace([failed, { ...reported, request_id: 'req_b_1' }]), 'no_chat_reply').length, 1)
})
