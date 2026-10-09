import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'
import {
  analyzeBehaviorTrace,
  DELEGATION_TRACE_ROWS,
  formatCheckReport,
  PACKET_OVERSIZE_MAX_CHARS,
  RESTAGE_LOOP_MIN_COUNT,
  runCheck,
  UsageError,
} from './run-check.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, 'fixtures', 'run-check')

async function loadFixtureRows(name) {
  const text = await fsp.readFile(path.join(fixturesDir, name), 'utf8')
  const { rows, errors } = parseJsonl(text)
  assert.equal(errors.length, 0, `fixture ${name} should parse cleanly`)
  return rows
}

test('retained Luna research handoff pause reports missing coverage, without labeling every research pause a context failure', async () => {
  const rows = await loadFixtureRows('luna-research-handoff-paused.jsonl')
  const findings = analyzeBehaviorTrace(rows).findings.filter(row => row.signature === 'executor_research_facts_missing')
  assert.equal(findings.length, 1)
  assert.match(findings[0].detail, /legacy.*electronics.*steam-power/)
  const covered = rows.map(row => row.event === 'context.executor_facts_carried'
    ? { ...row, data: { ...row.data, research_paths: 2, missing_research: [] } } : row)
  assert.equal(analyzeBehaviorTrace(covered).findings.filter(row => row.signature === 'executor_research_facts_missing').length, 0)
})

function findingsFor(result, signature) {
  return result.findings.filter(f => f.signature === signature)
}

test('retained Luna semantic contract dead end is diagnosed without changing its recorded failure', async () => {
  const { result, parse_errors: errors } = await runCheck({ behaviorFile: path.join(fixturesDir, 'luna-semantic-contract-dead-end.jsonl') })
  assert.equal(errors.length, 0)
  assert.equal(result.row_count, 85)
  assert.equal(result.request_count, 1)
  assert.equal(result.findings.length, 1)
  const [finding] = findingsFor(result, 'semantic_contract_dead_end')
  assert.equal(finding.request_id, 'req_muxsvx42_1')
  assert.equal(finding.count, 1)
  assert.equal(finding.first_ts, '2026-10-07T07:43:37.699Z')
  assert.match(finding.detail, /plan_id=goal_088r72h_1_p3 step_id=goal_088r72h_1_p3_v1_s1_1xd3iiq/)
  assert.match(finding.detail, /reason_code=semantic_step_cannot_mutate.*pause_reason=recoverable_provider_failure:provider_reported_blocker/)
  assert.match(formatCheckReport(result), /\[semantic_contract_dead_end\] request_id=req_muxsvx42_1/)
  const rows = await loadFixtureRows('luna-semantic-contract-dead-end.jsonl')
  const terminal = rows.at(-1)
  assert.equal(terminal.data.outcome, 'recoverable_provider_failure')
  assert.equal(terminal.data.task_board.status, 'paused')
  assert.equal(terminal.data.task_board.completed_count, 0)
  assert.equal(rows.find(row => row.event === 'request.time_split').data.batches, 0)
})

test('semantic contract diagnostic requires same request, actor, handoff, commit and terminal pause', async () => {
  const original = await loadFixtureRows('luna-semantic-contract-dead-end.jsonl')
  const controls = [
    ['unrelated refusal request', rows => { rows.find(row => row.data?.reason_code === 'semantic_step_cannot_mutate').request_id = 'req_other' }],
    ['unrelated pause request', rows => { rows.find(row => row.event === 'goal.paused').request_id = 'req_other' }],
    ['unrelated commit request', rows => { rows.find(row => row.event === 'plan.delegation_committed').request_id = 'req_other' }],
    ['replacement actor', rows => { rows.find(row => row.data?.reason_code === 'semantic_step_cannot_mutate').actor_id = 4 }],
    ['replacement epoch', rows => { rows.find(row => row.data?.reason_code === 'semantic_step_cannot_mutate').epoch = 3 }],
    ['other committed plan', rows => { rows.find(row => row.event === 'context.restaged').data.plan_id = 'plan_other' }],
    ['other immutable step', rows => { rows.find(row => row.event === 'context.restaged').data.step_id = 'step_other' }],
    ['other executor handoff', rows => { rows.find(row => row.seq === 62).data.handoff_id = 'ho_other' }],
    ['planner refusal', rows => { rows.find(row => row.seq === 62).data.role = 'planner' }],
    ['different refusal', rows => { rows.find(row => row.data?.reason_code === 'semantic_step_cannot_mutate').data.reason_code = 'invalid_tool_batch' }],
    ['different pause cause', rows => { rows.at(-1).data.task_board.pause_reason = 'generation_cap' }],
    ['other paused goal', rows => { rows.find(row => row.event === 'goal.paused').data.goal_id = 'goal_other' }],
    ['other paused board step', rows => { rows.find(row => row.event === 'goal.paused').data.active_step_id = 'step_2' }],
    ['no terminal pause', rows => { rows.at(-1).data.task_board.status = 'active' }],
    ['incomplete trace', rows => { rows.pop() }],
    ['subsequent committed successor', rows => { rows.splice(-1, 0, { ...rows.find(row => row.event === 'plan.delegation_committed'), seq: 84.5, ts: rows.at(-1).ts, data: { plan_id: 'successor', step_id: 'successor_step' } }) }],
  ]
  for (const [label, change] of controls) {
    const rows = structuredClone(original)
    change(rows)
    assert.deepEqual(findingsFor(analyzeBehaviorTrace(rows), 'semantic_contract_dead_end'), [], label)
  }
  // Content text is not evidence for this detector, even when misleading.
  const noProse = structuredClone(original)
  for (const row of noProse) {
    if (row.data?.chat_message) row.data.chat_message = 'Assessment complete.'
    if (row.data?.reason) row.data.reason = 'Unrelated prose.'
    for (const step of row.data?.task_board?.steps ?? []) {
      step.description = 'Observe only'
      step.semantic_rationale = 'A legitimate assessment'
    }
  }
  assert.equal(findingsFor(analyzeBehaviorTrace(noProse), 'semantic_contract_dead_end').length, 1)
})

test('semantic contract diagnostic preserves assessment closure and actual corrected gameplay continuation', async () => {
  const original = await loadFixtureRows('luna-semantic-contract-dead-end.jsonl')
  const clean = await loadFixtureRows('steam-run-clean-step-progress.jsonl')
  const cleanProgress = clean.filter(row => ['operations.admit', 'operations.ack', 'factorio.status', 'step.verified'].includes(row.event))
    .filter(row => row.event !== 'factorio.status' || row.data?.task_status?.last_completed_batch?.batch_id > 0)
  assert.ok(cleanProgress.some(row => row.event === 'operations.admit'))
  assert.ok(cleanProgress.some(row => row.event === 'operations.ack'))
  assert.ok(cleanProgress.some(row => row.event === 'factorio.status'))
  assert.ok(cleanProgress.some(row => row.event === 'step.verified'))
  const continuation = cleanProgress.map((row, index) => ({ ...row, request_id: 'req_muxsvx42_1', actor_id: 3, epoch: 2,
    ts: '2026-10-07T07:43:44.550Z', seq: 100 + index }))
  // Each actual progress signal disproves the narrow "before gameplay" dead end,
  // even if a later, independent reason pauses this same request.
  for (const row of continuation) {
    assert.deepEqual(findingsFor(analyzeBehaviorTrace([...original, row]), 'semantic_contract_dead_end'), [], row.event)
    assert.equal(findingsFor(analyzeBehaviorTrace([...original, { ...row, request_id: 'req_other' }]), 'semantic_contract_dead_end').length, 1, `${row.event} in another request`)
  }
  const continued = structuredClone(original).filter(row => row.event !== 'goal.paused')
  continued.at(-1).data.outcome = 'step_completed'
  continued.at(-1).data.task_board.status = 'active'
  continued.at(-1).data.task_board.pause_reason = ''
  continued.at(-1).data.task_board.completed_count = 1
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...continued, ...continuation]), 'semantic_contract_dead_end'), [])
  const assessment = { ...continuation[0], event: 'step.semantic_completed', data: { active_step_id: 'step_1', source: 'main_planner', grounding_refs: ['tool:researchStatus'], rationale: 'Verified bounded assessment' } }
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...original, assessment]), 'semantic_contract_dead_end'), [])
})

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

// --- delegation signatures (U9): restage loop, oversize packet, stale reply -----------------
//
// Row shapes are DELEGATION_TRACE_ROWS (run-check.mjs); nothing emits them
// yet, so these fixtures are built from that contract. The base trace is a
// mid-run slice at realistic sizes: two requests, a planner and executors
// restaged at a slice close and at plan commit, replies tagged with the
// handoff that issued them, step progress between the restages.

const D0 = Date.parse('2026-09-29T11:00:00Z')
let deltaSeq = 0

function drow(seconds, event, requestId, data = {}) {
  deltaSeq += 1
  return { schema: 1, ts: new Date(D0 + seconds * 1000).toISOString(), seq: deltaSeq, event, request_id: requestId, turn: 1, actor_id: 15, epoch: 1, data }
}

function restaged(seconds, requestId, { role = 'executor', checkpoint = 'C3', handoffId, planId = 'plan_1', stepId = 'step_1', chars = 3412, tokens, reason = 'executor_fresh_at_plan_commit', softLimitTokens } = {}) {
  return drow(seconds, 'context.restaged', requestId, {
    role,
    checkpoint,
    handoff_id: handoffId,
    packet_hash: '9f2c41d07a3be518',
    packet_chars: chars,
    packet_estimated_tokens: tokens ?? Math.ceil(chars / 4),
    previous_context_chars: 88_120,
    reason,
    plan_id: planId,
    ...(stepId ? { step_id: stepId } : {}),
    ...(softLimitTokens ? { soft_limit_tokens: softLimitTokens } : {}),
  })
}

function reply(seconds, requestId, { role, handoffId, event = 'provider.response' }) {
  return drow(seconds, event, requestId, {
    round: 1,
    latency_ms: 9000,
    has_tool_calls: true,
    usage: { input_units: 24_871, cached_input_units: 23_040, output_units: 1204, usage_complete: true },
    provider: { reasoning_policy_reason: 'same_goal_continue', reasoning_effort: 'low', model: 'deepseek-flash' },
    ...(role ? { role, handoff_id: handoffId } : {}),
  })
}

const verified = (seconds, requestId, stepId) => drow(seconds, 'step.verified', requestId, { active_step_id: stepId })

function cleanDelegatedTrace() {
  return [
    drow(0, 'request.received', 'req_d_1', { interaction_intent: 'new_goal' }),
    restaged(1, 'req_d_1', { role: 'planner', checkpoint: 'C1', handoffId: 'ho_plan_a', chars: 5704, reason: 'context_over_soft_limit_at_slice_close', stepId: undefined, softLimitTokens: 100_000 }),
    reply(20, 'req_d_1', { role: 'planner', handoffId: 'ho_plan_a' }),
    restaged(22, 'req_d_1', { handoffId: 'ho_exec_a', stepId: 'step_1', softLimitTokens: 100_000 }),
    reply(30, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' }),
    verified(80, 'req_d_1', 'step_1'),
    reply(90, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' }),
    drow(95, 'request.completed', 'req_d_1', { outcome: 'no_operations', chat_message: 'Step 1 done.' }),
    drow(200, 'request.received', 'req_d_2', { interaction_intent: 'continue_current' }),
    restaged(201, 'req_d_2', { handoffId: 'ho_exec_b', stepId: 'step_2', softLimitTokens: 100_000 }),
    reply(215, 'req_d_2', { role: 'executor', handoffId: 'ho_exec_b' }),
    verified(260, 'req_d_2', 'step_2'),
    drow(262, 'request.completed', 'req_d_2', { outcome: 'no_operations', chat_message: 'Step 2 done.' }),
  ]
}

const DELEGATION_SIGNATURES = ['restage_loop', 'restage_packet_oversize', 'stale_reply_not_dropped']
const delegationFindings = result => result.findings.filter(f => DELEGATION_SIGNATURES.includes(f.signature))

test('delegation: a healthy restaged run raises none of the three delegation signatures', () => {
  const result = analyzeBehaviorTrace(cleanDelegatedTrace())
  assert.deepEqual(delegationFindings(result), [])
  assert.equal(result.request_count, 2)
})

test('delegation: rows from before delegation (no role, handoff_id or restage rows) raise none of them', async () => {
  for (const name of ['steam-run-clean-step-progress.jsonl', 'qwen-observation-phase-closed-loop.jsonl', 'steam-run-provider-output-cap.jsonl']) {
    assert.deepEqual(delegationFindings(analyzeBehaviorTrace(await loadFixtureRows(name))), [], name)
  }
})

test('delegation: restage_loop fires on the third restage of one role and step with nothing verified between', () => {
  const rows = [
    ...cleanDelegatedTrace().slice(0, 4),
    drow(30, 'provider.error', 'req_d_1', { message: 'provider_turn_output_cap_exceeded', role: 'executor', handoff_id: 'ho_exec_a' }),
    restaged(31, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_exec_a2', stepId: 'step_1', reason: 'generation_cap' }),
    restaged(60, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_exec_a3', stepId: 'step_1', reason: 'generation_cap' }),
    // The loop straddles two requests, like a Resume after a ceiling pause would.
    drow(70, 'request.completed', 'req_d_1', { outcome: 'paused', chat_message: 'Paused.' }),
    drow(100, 'request.received', 'req_d_2', { interaction_intent: 'continue_current' }),
    restaged(101, 'req_d_2', { checkpoint: 'C5', handoffId: 'ho_exec_a4', stepId: 'step_1', reason: 'generation_cap' }),
  ]
  const loops = findingsFor(analyzeBehaviorTrace(rows), 'restage_loop')
  assert.equal(loops.length, 1)
  assert.equal(loops[0].request_id, 'req_d_1')
  assert.equal(loops[0].count, 4)
  assert.equal(loops[0].first_ts, '2026-09-29T11:00:22.000Z')
  assert.match(loops[0].detail, /executor restaged 4 times for plan plan_1 step step_1 with no step verified in between \(checkpoints C3,C5,C5,C5; loop threshold 3\)/)
  assert.equal(RESTAGE_LOOP_MIN_COUNT, 3)
})

test('delegation: restage_loop does not fire below the threshold, after progress, or across different steps or roles', () => {
  const loopRows = (extra = []) => [
    restaged(22, 'req_d_1', { handoffId: 'ho_e1', stepId: 'step_1' }),
    restaged(31, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_e2', stepId: 'step_1' }),
    ...extra,
  ]
  // Two restages: below the threshold of three.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(loopRows()), 'restage_loop'), [])
  // A third restage after a step was verified starts a new count.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(loopRows([
    verified(40, 'req_d_1', 'step_1'),
    restaged(50, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_e3', stepId: 'step_1' }),
  ])), 'restage_loop'), [])
  // step.semantic_completed is progress too.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(loopRows([
    drow(40, 'step.semantic_completed', 'req_d_1', { active_step_id: 'step_1' }),
    restaged(50, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_e3', stepId: 'step_1' }),
  ])), 'restage_loop'), [])
  // The third restage is for another step, or another role: not the same loop.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(loopRows([restaged(50, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_e3', stepId: 'step_2' })])), 'restage_loop'), [])
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(loopRows([restaged(50, 'req_d_1', { role: 'planner', checkpoint: 'C1', handoffId: 'ho_p1', stepId: 'step_1' })])), 'restage_loop'), [])
})

test('delegation: restage_packet_oversize fires past the packet character limit and past a named soft limit', () => {
  assert.equal(PACKET_OVERSIZE_MAX_CHARS, 6000)
  const bigPlanner = restaged(1, 'req_d_1', { role: 'planner', checkpoint: 'C1', handoffId: 'ho_plan_big', chars: 7912, reason: 'context_over_soft_limit_at_slice_close' })
  const chars = findingsFor(analyzeBehaviorTrace([bigPlanner]), 'restage_packet_oversize')
  assert.equal(chars.length, 1)
  assert.equal(chars[0].request_id, 'req_d_1')
  assert.match(chars[0].detail, /planner C1 packet ho_plan_big: 7912 chars > 6000 char packet limit/)

  // Under the character bound but over the soft limit the row names: 1,200 chars is ~300 tokens.
  const overSoft = restaged(2, 'req_d_1', { handoffId: 'ho_exec_small', chars: 1200, softLimitTokens: 250 })
  const soft = findingsFor(analyzeBehaviorTrace([overSoft]), 'restage_packet_oversize')
  assert.equal(soft.length, 1)
  assert.match(soft[0].detail, /executor C3 packet ho_exec_small: ~300 tokens > 250 token soft limit/)
  // The token count falls back to ceil(chars / 4) when the row has no estimate.
  const noEstimate = { ...overSoft, data: { ...overSoft.data, packet_estimated_tokens: undefined } }
  assert.equal(findingsFor(analyzeBehaviorTrace([noEstimate]), 'restage_packet_oversize').length, 1)

  // Exactly at either limit is not over it.
  const exact = [
    restaged(3, 'req_d_1', { role: 'planner', checkpoint: 'C1', handoffId: 'ho_plan_exact', chars: 6000 }),
    restaged(4, 'req_d_1', { handoffId: 'ho_exec_exact', chars: 1000, softLimitTokens: 250 }),
  ]
  assert.deepEqual(findingsFor(analyzeBehaviorTrace(exact), 'restage_packet_oversize'), [])
})

test('delegation: stale_reply_not_dropped fires on a reply from a discarded handoff with no drop row', () => {
  const rows = [
    ...cleanDelegatedTrace().slice(0, 5),
    // ho_exec_a was replaced at C5 by ho_exec_a2; its late reply arrives and is applied.
    restaged(31, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_exec_a2', stepId: 'step_1', reason: 'generation_cap' }),
    reply(40, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' }),
    reply(41, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a2' }),
    // A stale reply for another handoff shows up in the next request.
    drow(200, 'request.received', 'req_d_2', { interaction_intent: 'continue_current' }),
    reply(210, 'req_d_2', { role: 'executor', handoffId: 'ho_exec_a', event: 'provider.error' }),
  ]
  const stale = findingsFor(analyzeBehaviorTrace(rows), 'stale_reply_not_dropped')
  assert.deepEqual(stale.map(f => [f.request_id, f.count]), [['req_d_1', 1], ['req_d_2', 1]])
  assert.match(stale[0].detail, /executor reply provider\.response carries handoff_id=ho_exec_a but the active executor handoff is ho_exec_a2, and no context\.stale_reply_dropped row followed/)
  assert.equal(stale[0].first_ts, '2026-09-29T11:00:40.000Z')
})

test('delegation: stale_reply_not_dropped stays quiet for dropped, current, untagged and pre-restage replies', () => {
  const restagedAgain = [
    ...cleanDelegatedTrace().slice(0, 5),
    restaged(31, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_exec_a2', stepId: 'step_1', reason: 'generation_cap' }),
  ]
  const stale = reply(40, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' })
  const drop = drow(40, 'context.stale_reply_dropped', 'req_d_1', { role: 'executor', handoff_id: 'ho_exec_a', active_handoff_id: 'ho_exec_a2', reason: 'handoff_superseded' })
  // The stale reply was dropped and traced (drop row before or after the reply row).
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...restagedAgain, stale, drop]), 'stale_reply_not_dropped'), [])
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...restagedAgain, drop, stale]), 'stale_reply_not_dropped'), [])
  // A drop row for a different handoff does not excuse this one.
  const other = { ...drop, data: { ...drop.data, handoff_id: 'ho_other' } }
  assert.equal(findingsFor(analyzeBehaviorTrace([...restagedAgain, stale, other]), 'stale_reply_not_dropped').length, 1)
  // The current handoff, an untagged reply and the planner's own live handoff are fine.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...restagedAgain, reply(40, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a2' })]), 'stale_reply_not_dropped'), [])
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...restagedAgain, reply(40, 'req_d_1', {})]), 'stale_reply_not_dropped'), [])
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([...restagedAgain, reply(40, 'req_d_1', { role: 'planner', handoffId: 'ho_plan_a' })]), 'stale_reply_not_dropped'), [])
  // A reply tagged before the role's first restage is on record cannot be judged.
  assert.deepEqual(findingsFor(analyzeBehaviorTrace([reply(1, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_first' })]), 'stale_reply_not_dropped'), [])
})

test('delegation: the since cutoff hides earlier findings but keeps the active handoff state', () => {
  const rows = [
    ...cleanDelegatedTrace().slice(0, 5),
    restaged(31, 'req_d_1', { checkpoint: 'C5', handoffId: 'ho_exec_a2', stepId: 'step_1', reason: 'generation_cap' }),
    reply(40, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' }),
    reply(120, 'req_d_1', { role: 'executor', handoffId: 'ho_exec_a' }),
  ]
  assert.equal(findingsFor(analyzeBehaviorTrace(rows), 'stale_reply_not_dropped')[0].count, 2)
  // Cutoff after the restage row: the second reply is still judged against ho_exec_a2.
  const since = analyzeBehaviorTrace(rows, { since: '2026-09-29T11:01:00.000Z' })
  assert.equal(findingsFor(since, 'stale_reply_not_dropped')[0].count, 1)
})

test('delegation: the expected row shapes are exported for the emitter and validate against the reducer vocabulary', () => {
  const { restaged: example } = DELEGATION_TRACE_ROWS.examples
  assert.equal(example.event, DELEGATION_TRACE_ROWS.events.restaged)
  assert.ok(['planner', 'executor'].includes(example.data.role))
  assert.match(example.data.checkpoint, /^C[1-8]$/)
  assert.deepEqual(Object.keys(example.data).sort(), ['checkpoint', 'handoff_id', 'packet_chars', 'packet_estimated_tokens', 'packet_hash', 'plan_id', 'previous_context_chars', 'reason', 'role', 'soft_limit_tokens', 'step_id'])
  // The examples are themselves clean under the detectors.
  const rows = [
    { ...example, ts: '2026-09-29T11:00:00.000Z', data: { ...example.data } },
    { ...DELEGATION_TRACE_ROWS.examples.providerReply, ts: '2026-09-29T11:00:05.000Z' },
  ]
  assert.deepEqual(delegationFindings(analyzeBehaviorTrace(rows)), [])
  assert.equal(DELEGATION_TRACE_ROWS.examples.staleReplyDropped.event, DELEGATION_TRACE_ROWS.events.staleReplyDropped)
})

test('delegation: findings print through formatCheckReport like every other signature', () => {
  const rows = [restaged(1, 'req_d_1', { role: 'planner', checkpoint: 'C1', handoffId: 'ho_plan_big', chars: 7912 })]
  const text = formatCheckReport(analyzeBehaviorTrace(rows))
  assert.match(text, /\[restage_packet_oversize\] request_id=req_d_1 count=1 first_ts=2026-09-29T11:00:01\.000Z :: planner C1 packet ho_plan_big/)
})

// --- executor step identity (2026-10-08 Haiku live run) ------------------------------------------

test('executor step identity: a request that ends in request.failed with recoverable=false is reported, and a recoverable one is not', () => {
  const stale = drow(5, 'executor.stale_step_rejected', 'req_id_1', {
    incoming_step_index: 1,
    expected_step: { index: 2, stepId: 'step_3', description: 'Hand-mine copper ore and smelt at least 20 copper plates' },
    operation_count: 1,
    reason: 'step_index_not_the_active_step',
  })
  const failed = recoverable => drow(6, 'request.failed', 'req_id_1', {
    stage: 'runtime',
    message: 'executor_stale_step: choose new operations for the current committed active step',
    recoverable,
  })
  const unrecoverable = analyzeBehaviorTrace([drow(0, 'request.received', 'req_id_1', {}), stale, failed(false)])
  const [finding] = findingsFor(unrecoverable, 'request_failed_unrecoverable')
  assert.equal(finding.request_id, 'req_id_1')
  assert.equal(finding.count, 1)
  assert.match(finding.detail, /recoverable=false \(stage runtime\): executor_stale_step/)
  assert.match(formatCheckReport(unrecoverable), /\[request_failed_unrecoverable\] request_id=req_id_1/)

  const recoverable = analyzeBehaviorTrace([drow(0, 'request.received', 'req_id_2', {}), { ...failed(true), request_id: 'req_id_2' }])
  assert.equal(findingsFor(recoverable, 'request_failed_unrecoverable').length, 0)
  const unmarked = analyzeBehaviorTrace([drow(0, 'request.received', 'req_id_3', {}), { ...failed(undefined), request_id: 'req_id_3' }])
  assert.equal(findingsFor(unmarked, 'request_failed_unrecoverable').length, 0, 'a failure that does not say recoverable=false is not this finding')
})

test('executor step identity: executor.stale_step_rejected events are counted per request', () => {
  const rejected = (seconds, requestId, data = {}) => drow(seconds, 'executor.stale_step_rejected', requestId, {
    incoming_step_index: 1,
    expected_step: { index: 2, stepId: 'step_3' },
    operation_count: 1,
    reason: 'step_index_not_the_active_step',
    ...data,
  })
  const rows = [
    drow(0, 'request.received', 'req_id_4', {}),
    rejected(1, 'req_id_4'),
    rejected(2, 'req_id_4', { incoming_step_id: 'step_2', reason: 'step_id_names_another_step' }),
    drow(3, 'request.completed', 'req_id_4', { chat_message: 'done' }),
    drow(4, 'request.received', 'req_id_5', {}),
    drow(5, 'request.completed', 'req_id_5', { chat_message: 'done' }),
  ]
  const result = analyzeBehaviorTrace(rows)
  const findings = findingsFor(result, 'executor_stale_step_rejected')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].request_id, 'req_id_4')
  assert.equal(findings[0].count, 2)
  assert.match(findings[0].detail, /expected step_3/)
  assert.equal(findingsFor(analyzeBehaviorTrace(rows.slice(4)), 'executor_stale_step_rejected').length, 0)
})

test('executor step identity: executor.step_resolved_by_text is an informational count per request, never a finding', () => {
  const resolved = (seconds, requestId) => drow(seconds, 'executor.step_resolved_by_text', requestId, {
    incoming_step_index: 1,
    step_id: 'step_3',
    active_step_id: 'step_3',
    reason: 'reply_step_text_names_one_committed_step',
  })
  const rows = [
    drow(0, 'request.received', 'req_id_6', {}),
    resolved(1, 'req_id_6'),
    resolved(2, 'req_id_6'),
    drow(3, 'request.completed', 'req_id_6', { chat_message: 'done' }),
    drow(4, 'request.received', 'req_id_7', {}),
    drow(5, 'request.completed', 'req_id_7', { chat_message: 'done' }),
  ]
  const result = analyzeBehaviorTrace(rows)
  assert.deepEqual(result.findings, [])
  assert.equal(result.informational.length, 1)
  const [item] = result.informational
  assert.equal(item.signature, 'executor_step_resolved_by_text')
  assert.equal(item.request_id, 'req_id_6')
  assert.equal(item.count, 2)
  assert.match(item.detail, /resolved by its step text \(incoming index 1; step step_3; active step_3\)/)
  assert.match(formatCheckReport(result), /1 informational \(not findings\):\n- \[executor_step_resolved_by_text\] request_id=req_id_6 count=2/)
  assert.deepEqual(analyzeBehaviorTrace(rows.slice(4)).informational, [])
})

test('an execution draft refused for a semantic step is counted as informational, never as a finding', async () => {
  const { result, parse_errors: errors } = await runCheck({ behaviorFile: path.join(fixturesDir, 'semantic-step-refused.jsonl') })
  assert.equal(errors.length, 0)
  assert.deepEqual(result.findings, [])
  assert.equal(result.informational.length, 1)
  const [item] = result.informational
  assert.equal(item.signature, 'semantic_step_refused')
  assert.equal(item.request_id, 'req_semref_1')
  assert.equal(item.count, 1, 'the commit trace row and its recovery classification are one refusal')
  assert.match(item.detail, /semantic_step_in_execution_plan.*step indexes 1/)
  assert.match(formatCheckReport(result), /No known failure signatures found\.[\s\S]*1 informational \(not findings\):\n- \[semantic_step_refused\] request_id=req_semref_1 count=1/)
  // Without the commit trace row, the recovery classification alone still counts.
  const rows = await loadFixtureRows('semantic-step-refused.jsonl')
  const classifiedOnly = analyzeBehaviorTrace(rows.filter(row => row.event !== 'plan.semantic_step_refused'))
  assert.equal(classifiedOnly.informational[0].count, 1)
  assert.deepEqual(classifiedOnly.findings, [])
  // A trace with no refusal reports nothing informational.
  assert.deepEqual(analyzeBehaviorTrace(rows.filter(row => !/semantic_step/.test(JSON.stringify(row)))).informational, [])
})

test('step contracts: deferred and just-in-time-bound contracts are informational counts per request, never findings', () => {
  const rows = [
    drow(0, 'request.received', 'req_ct_1', {}),
    drow(1, 'plan.later_contracts_deferred', 'req_ct_1', { step_count: 2, discarded_checkpoints: 1, reason: 'contracts_bound_when_each_step_activates' }),
    drow(2, 'plan.contract_bound_just_in_time', 'req_ct_1', { plan_id: 'p1', step_id: 's2', attempts: 1, trigger: 'step_close', reason: 'step_activated_without_contract' }),
    drow(3, 'plan.contract_bound_just_in_time', 'req_ct_1', { plan_id: 'p1', step_id: 's3', attempts: 2, trigger: 'condition_wait', reason: 'step_activated_without_contract' }),
    drow(4, 'request.completed', 'req_ct_1', { chat_message: 'done' }),
    drow(5, 'request.received', 'req_ct_2', {}),
    drow(6, 'request.completed', 'req_ct_2', { chat_message: 'done' }),
  ]
  const result = analyzeBehaviorTrace(rows)
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.informational.map(item => [item.signature, item.request_id, item.count]), [
    ['later_contracts_deferred', 'req_ct_1', 1],
    ['contract_bound_just_in_time', 'req_ct_1', 2],
  ])
  assert.match(result.informational[0].detail, /deferred 2 later step contract\(s\).*1 checkpoint\(s\) sent for later steps were discarded/)
  assert.match(result.informational[1].detail, /bound just in time in 3 planner call\(s\) \(trigger step_close, condition_wait\)/)
  assert.deepEqual(analyzeBehaviorTrace(rows.slice(5)).informational, [])
})

test('step contracts: a contract call that failed and paused the goal is a finding, a stale call that bound nothing is not', () => {
  const failed = (seconds, reason) => drow(seconds, 'plan.contract_call_failed', 'req_ct_3', { plan_id: 'p1', step_id: 's2', trigger: 'step_close', reason, attempts: 2 })
  const rows = [
    drow(0, 'request.received', 'req_ct_3', {}),
    failed(1, 'checkpoint_not_supported:invented_kind'),
    drow(2, 'request.completed', 'req_ct_3', { chat_message: 'I paused this goal: I could not get a valid completion checkpoint', outcome: 'paused_step_contract_unavailable' }),
    drow(3, 'request.received', 'req_ct_4', {}),
    drow(4, 'plan.contract_call_failed', 'req_ct_4', { plan_id: 'p1', step_id: 's2', trigger: 'step_close', reason: 'stale_actor_or_epoch_changed', attempts: 1 }),
    drow(5, 'request.completed', 'req_ct_4', { chat_message: 'done' }),
  ]
  const result = analyzeBehaviorTrace(rows)
  const findings = findingsFor(result, 'step_contract_unavailable')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].request_id, 'req_ct_3')
  assert.equal(findings[0].count, 1)
  assert.match(findings[0].detail, /could not give step s2 a valid contract \(checkpoint_not_supported:invented_kind; attempts 2; trigger step_close\)/)
  assert.equal(findingsFor(analyzeBehaviorTrace(rows.slice(3)), 'step_contract_unavailable').length, 0, 'a stale call is not a pause')
  assert.match(formatCheckReport(result), /\[step_contract_unavailable\] request_id=req_ct_3 count=1/)
})
