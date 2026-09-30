import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  STEAM_AUTHORING_OUTPUT_UNITS,
  STEAM_SCRIPTED_BLOCKED_ANSWER,
  steamReplayHarness,
} from './steam-run-fixtures.mjs'
import { liveAgentDebugEvent, Session } from './supervisor.mjs'
import { buildRunRecord, formatRunRecord, generateThinkTimeReport, parsePriceTable } from './think-time-report.mjs'
import { formatUnits, UsageLedger } from './usage-ledger.mjs'

// The steam run replayed through the real loop and provider stack (recorded
// usage per round), then read back the way the run record reads a live
// sgluna-behavior.jsonl.
async function steamRunTrace({ promptTraceFile = null, ledger } = {}) {
  const world = steamReplayHarness({ transport: 'http', promptTraceFile, extraRounds: [STEAM_SCRIPTED_BLOCKED_ANSWER] })
  if (ledger) world.agent.usageLedger = ledger
  await world.request()
  await world.closeStep1()
  await world.failSupplyBatch()
  return world
}

const sum = (rounds, pick) => rounds.reduce((total, round) => total + pick(round), 0)

test('run record: spend by round type, per goal and per verified step, from the steam replay trace', async () => {
  const world = await steamRunTrace()
  const record = buildRunRecord(world.trace)
  const played = world.calls.map(call => call.round)

  assert.equal(record.requests, 1)
  assert.equal(record.totals.rounds, played.length)
  assert.equal(record.totals.output_units, sum(played, round => round.usage.output))
  assert.equal(record.totals.input_units, sum(played, round => round.usage.input))
  assert.equal(record.totals.cached_input_units, sum(played, round => round.usage.cached))
  assert.equal(record.totals.reasoning_output_units, sum(played, round => round.usage.reasoning))
  assert.equal(record.totals.verified_steps, 1)
  assert.equal(record.totals.output_units_per_verified_step, record.totals.output_units)

  // The steam doc's "spend by round type" table, now from the trace.
  const authoring = record.by_round_type.find(row => row.reasoning_policy_reason === 'plan_authoring')
  assert.equal(authoring.rounds, 4)
  assert.equal(authoring.output_units, STEAM_AUTHORING_OUTPUT_UNITS)
  const authoringRounds = played.slice(0, 4)
  assert.equal(authoring.cached_input_share, Math.round(sum(authoringRounds, round => round.usage.cached) / sum(authoringRounds, round => round.usage.input) * 1000) / 1000)
  assert.equal(authoring.cache_miss_input_share, Math.round((1 - sum(authoringRounds, round => round.usage.cached) / sum(authoringRounds, round => round.usage.input)) * 1000) / 1000)
  assert.equal(sum(record.by_round_type, row => row.rounds), played.length)
  assert.equal(sum(record.by_effort, row => row.output_units), record.totals.output_units)
  assert.equal(record.by_effort.find(row => row.reasoning_effort === 'max').output_units, STEAM_AUTHORING_OUTPUT_UNITS)

  // One goal, which owns every round: the authoring rounds ran before the
  // goal existed and join it once its plan is persisted in the trace.
  assert.equal(record.by_goal.length, 1)
  assert.equal(record.by_goal[0].verified_steps, 1)
  assert.equal(record.by_goal[0].rounds, played.length)
  assert.equal(record.by_goal[0].output_units, record.totals.output_units)
  assert.equal(record.by_goal[0].output_units_per_verified_step, record.totals.output_units)
  const step1 = record.by_step.find(row => row.step_id === 'step_1')
  const step2 = record.by_step.find(row => row.step_id === 'step_2')
  assert.equal(step1, undefined, 'no round ran while step 1 was active: authoring came first, step 1 closed on its contract')
  assert.equal(step2.verified, false)
  assert.equal(step2.rounds, played.length - 4)

  // Spend that bought no world change.
  const reads = played.filter(round => Array.isArray(round.reads) && round.reads.length > 0)
  assert.equal(record.no_world_change.observation_only_rounds.rounds, reads.length)
  assert.equal(record.no_world_change.observation_only_rounds.output_units, sum(reads, round => round.usage.output))
  // In this replay the plan is blocked only by the final BLOCKED answer (the
  // board is first traced as blocked with it), so no round ran after it.
  assert.equal(world.memory.currentPlan('npc:sgluna').status, 'blocked')
  assert.equal(record.no_world_change.rounds_after_plan_blocked.rounds, 0)
  assert.equal(record.no_world_change.invalid_plan_submissions.count, 0)

  // Verbosity: the first plan and the BLOCKED answer carried a line, the
  // supply plan none.
  assert.deepEqual([record.verbosity.plans_with_chat, record.verbosity.plans], [2, 3])
  assert.equal(record.verbosity.responses, played.length)

  // Time split per request, from the runtime's own request.time_split when the
  // request ended (here it is still open: the blocked answer ends it).
  const request = record.by_request[0]
  assert.ok(['request.time_split', 'reconstructed'].includes(request.time.source))
  assert.equal(request.time.walking, 'inside_actor_busy')

  const text = formatRunRecord(record)
  assert.match(text, /^SGLuna run record/)
  assert.match(text, /Spend by round type/)
  assert.match(text, /- plan_authoring: 4 rounds/)
  assert.match(text, /Spend with no world change:/)
  assert.match(text, /prices: none given \(units only/)
  assert.match(text, /Time estimates \(2\.6\):/)
})

test('run record with a price file: cached input at its own rate, cost per verified step', async () => {
  const world = await steamRunTrace()
  const prices = parsePriceTable({ 'currency': 'USD', 'deepseek-flash': { input: 0.28, cached_input: 0.028, output: 0.42 } })
  const record = buildRunRecord(world.trace, { prices })
  const played = world.calls.map(call => call.round)
  const expected = (sum(played, round => round.usage.input - round.usage.cached) * 0.28
    + sum(played, round => round.usage.cached) * 0.028
    + sum(played, round => round.usage.output) * 0.42) / 1_000_000
  assert.ok(Math.abs(record.totals.cost - expected) < 1e-6)
  assert.ok(Math.abs(record.totals.cost_per_verified_step - expected) < 1e-6)
  assert.equal(record.totals.unpriced_rounds, undefined)
  assert.match(formatRunRecord(record), /prices: USD per 1,000,000 units for deepseek-flash/)

  // An unknown model is left unpriced and says so; no rate is guessed.
  const other = buildRunRecord(world.trace, { prices: parsePriceTable({ 'some-other-model': { input: 1, cached_input: 1, output: 1 } }) })
  assert.equal(other.totals.unpriced_rounds, played.length)
  assert.equal(other.totals.cost, 0)
  assert.throws(() => parsePriceTable({ 'deepseek-flash': { input: 0.28, output: 0.42 } }), /cached_input/)
  assert.throws(() => parsePriceTable({ currency: 'USD' }), /names no model/)
})

test('one command: the report reads the prompt trace and the behavior trace next to it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-run-record-'))
  try {
    const promptTraceFile = path.join(dir, 'sgluna-prompts.jsonl')
    const world = await steamRunTrace({ promptTraceFile })
    await fsp.writeFile(path.join(dir, 'sgluna-behavior.jsonl'), `${world.trace.map(row => JSON.stringify(row)).join('\n')}\n`)
    await fsp.writeFile(path.join(dir, 'prices.json'), JSON.stringify({ currency: 'USD', '*': { input: 1, cached_input: 0.1, output: 2 } }))
    const result = await generateThinkTimeReport({ promptFile: promptTraceFile, pricesFile: path.join(dir, 'prices.json') })
    assert.equal(result.behavior_file, path.join(dir, 'sgluna-behavior.jsonl'))
    assert.equal(result.report.overall.count, world.calls.length)
    assert.equal(result.run_record.totals.rounds, world.calls.length)
    assert.ok(result.run_record.totals.cost > 0)

    const missing = await generateThinkTimeReport({ promptFile: promptTraceFile, behaviorFile: path.join(dir, 'absent.jsonl') })
    assert.equal(missing.run_record, undefined)
  }
  finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('a synthetic trace: invalid plans, recovery rounds, duplicate reads and the reconstructed time split', () => {
  const at = seconds => new Date(Date.parse('2026-09-28T10:00:00Z') + seconds * 1000).toISOString()
  const response = (ts, output, extra = {}) => ({ ts: at(ts), request_id: 'req_1', event: 'provider.response', data: { latency_ms: 5000, usage: { input_units: 1000, cached_input_units: 400, output_units: output, usage_complete: true }, provider: { reasoning_policy_reason: 'ordinary_planning', reasoning_effort: 'high', model: 'm' }, ...extra } })
  const rows = [
    { ts: at(0), request_id: 'req_1', event: 'request.received', data: {} },
    response(5, 100, { has_tool_calls: true }),
    { ts: at(5), request_id: 'req_1', event: 'tool.call', data: { name: 'getInventoryItems', cached: false } },
    { ts: at(5), request_id: 'req_1', event: 'tool.call', data: { name: 'getInventoryItems', cached: true } },
    response(10, 200),
    { ts: at(10), request_id: 'req_1', event: 'provider.plan_submission_invalid', data: {} },
    response(15, 50, { recovery_attempt: 1, provider: { reasoning_policy_reason: 'strict_recovery', reasoning_effort: 'none', model: 'm' } }),
    { ts: at(15), request_id: 'req_2', event: 'plan.persisted', data: { goal_id: 'goal_2', task_board: { goal_id: 'goal_2', active_step_id: 'step_1', status: 'blocked' } } },
    { ts: at(15), request_id: 'req_2', event: 'provider.response', data: { latency_ms: 38600, usage: { input_units: 31360, cached_input_units: 30336, output_units: 7376 }, provider: { reasoning_policy_reason: 'ordinary_replan', reasoning_effort: 'high', model: 'm' } } },
    { ts: at(15), request_id: 'req_1', event: 'plan.accepted', data: { chat_message: '' } },
    { ts: at(15), request_id: 'req_1', event: 'plan.persisted', data: { goal_id: 'goal_1', task_board: { goal_id: 'goal_1', active_step_id: 'step_1', status: 'active' } } },
    { ts: at(16), request_id: 'req_1', event: 'operations.ack', data: {} },
    { ts: at(76), request_id: 'req_1', event: 'factorio.completed_signal', data: {} },
    { ts: at(77), request_id: 'req_1', event: 'step.verified', data: { active_step_id: 'step_1' } },
    { ts: at(80), request_id: 'req_1', event: 'request.completed', data: { chat_message: 'Done.', outcome: 'no_operations' } },
  ]
  const record = buildRunRecord(rows)
  assert.equal(record.no_world_change.observation_only_rounds.rounds, 1)
  assert.equal(record.no_world_change.duplicate_tool_calls, 1)
  assert.equal(record.no_world_change.invalid_plan_submissions.count, 1)
  assert.equal(record.no_world_change.invalid_plan_submissions.output_units, 200)
  assert.equal(record.no_world_change.recovery_rounds.rounds, 1)
  assert.equal(record.no_world_change.recovery_rounds.output_units, 50)
  assert.equal(record.no_world_change.rounds_after_plan_blocked.rounds, 1)
  assert.equal(record.no_world_change.rounds_after_plan_blocked.output_units, 7376)
  assert.equal(record.requests, 2)
  assert.equal(record.by_request[0].time.source, 'reconstructed')
  assert.equal(record.by_request[0].time.wall_ms, 80_000)
  assert.equal(record.by_request[0].time.think_ms, 15_000)
  assert.equal(record.by_request[0].time.actor_busy_ms, 60_000)
  assert.equal(record.by_request[0].time.idle_ms, 5_000)
  assert.deepEqual([record.verbosity.completed_with_chat, record.verbosity.completed], [1, 1])
  assert.deepEqual([record.verbosity.tool_call_responses, record.verbosity.plans_with_chat], [1, 0])
})

test('goal ledger: authoring rounds join the goal, a verified step counts, the warning fires once with a chat line', async () => {
  const ledger = new UsageLedger({ warningOutputUnits: 50000 })
  const world = await steamRunTrace({ ledger })
  const played = world.calls.map(call => call.round)
  const goalId = world.memory.currentPlan('npc:sgluna').goal_id
  const summary = ledger.goalSummary(goalId)
  assert.equal(summary.output_units, sum(played, round => round.usage.output), 'authoring rounds joined the goal when it was persisted')
  assert.equal(summary.provider_calls, played.length)
  assert.equal(summary.requests, 1)
  assert.equal(summary.verified_steps, 1)

  const warnings = world.events('budget.goal_warning')
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].data.goal_id, goalId)
  assert.equal(warnings[0].data.threshold_output_units, 50000)
  assert.ok(warnings[0].data.output_units >= 50000)
  assert.equal(warnings[0].data.next_action, 'continue')
  assert.match(warnings[0].data.chat_message, /^Heads-up: this goal has used \d+k model output units so far/)
  assert.match(warnings[0].request_id, /^req_/)

  const fields = ledger.debugFields(goalId)
  assert.match(fields.goal_spend, /^out \d+k · in \d+k \(\d+% cached\) · \d+ calls · 1 verified · \d+k out per verified step · warns at 50k out$/)
  assert.equal(new UsageLedger({ outputCap: 100000 }).warningOutputUnits(), 300000)
  assert.equal(formatUnits(1_011_980), '1M')
  assert.equal(formatUnits(107_322), '107k')
})

test('the supervisor shows the goal spend and announces the warning once', async () => {
  const debug = liveAgentDebugEvent('provider.response', { latency_ms: 10 }, {}, { spend: { goal_spend: 'out 107k · in 905k (68% cached) · 37 calls · 1 verified' } })
  assert.equal(debug.goal_spend, 'out 107k · in 905k (68% cached) · 37 calls · 1 verified')
  const printed = []
  const session = Object.create(Session.prototype)
  Object.assign(session, { printChat: async line => { printed.push(line) }, log: () => {} })
  const data = { goal_id: 'goal_1', threshold_output_units: 300000, chat_message: 'Heads-up: this goal has used 300k model output units so far.' }
  session.announceGoalBudgetWarning(data)
  session.announceGoalBudgetWarning(data)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(printed, ['Heads-up: this goal has used 300k model output units so far.'])
})

// Review fix: a new goal issued while the old one is still live (active,
// paused or blocked) never charges its authoring rounds to the old goal.
test('a new-goal request charges its authoring rounds to the new goal, never to the old live one', () => {
  const ledger = new UsageLedger({ warningOutputUnits: 1000 })
  const round = output => ({ usage: { input_units: 100, cached_input_units: 0, output_units: output, usage_complete: true } })
  // The old goal is live and has spent a little.
  ledger.observe('request.received', { interaction_intent: 'continue_current' }, { requestId: 'req_old' })
  ledger.observe('provider.response', round(200), { requestId: 'req_old', goalId: 'goal_old' })
  // A new goal while goal_old is still the live (paused) state.
  const events = []
  const observe = (event, data, goalId) => events.push(...ledger.observe(event, data, { requestId: 'req_new', goalId, stepGoalId: goalId }).after)
  observe('request.received', { interaction_intent: 'new_goal' }, 'goal_old')
  observe('provider.response', round(700), 'goal_old')
  observe('provider.response', round(600), 'goal_old')
  assert.equal(ledger.goalSummary('goal_old').output_units, 200, 'the old goal is not charged')
  assert.equal(events.length, 0, 'no warning against the old goal')
  observe('plan.persisted', { goal_id: 'goal_new' }, 'goal_new')
  assert.equal(ledger.goalSummary('goal_new').output_units, 1300)
  assert.equal(ledger.goalSummary('goal_old').output_units, 200)
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'budget.goal_warning')
  assert.equal(events[0][1].goal_id, 'goal_new')
  // Later rounds of the same request go to the new goal directly.
  observe('provider.response', round(50), 'goal_new')
  assert.equal(ledger.goalSummary('goal_new').output_units, 1350)

  // The run record applies the same rule to a trace.
  const at = seconds => new Date(Date.parse('2026-09-28T10:00:00Z') + seconds * 1000).toISOString()
  const oldBoard = { goal_id: 'goal_old', active_step_id: 'step_2', status: 'paused' }
  const response = (ts, id, output) => ({ ts: at(ts), request_id: id, event: 'provider.response', data: { usage: { input_units: 100, cached_input_units: 0, output_units: output } } })
  const record = buildRunRecord([
    { ts: at(0), request_id: 'req_new', event: 'request.received', data: { interaction_intent: 'new_goal' } },
    { ts: at(1), request_id: 'req_new', event: 'factorio.status', data: { task_board: oldBoard } },
    response(2, 'req_new', 700),
    { ts: at(3), request_id: 'req_new', event: 'plan.persisted', data: { goal_id: 'goal_new', task_board: { goal_id: 'goal_new', active_step_id: 'step_1', status: 'active' } } },
    response(4, 'req_new', 50),
  ])
  assert.deepEqual(record.by_goal.map(row => [row.goal_id, row.output_units]), [['goal_new', 750]])
})

// --- delegation observability (U9): role, handoff_id and restage summary ------------------
//
// Two requests from the middle of a long goal at realistic sizes (input in
// the tens of thousands of units, cache hits above 90 percent once the prefix
// is warm). `delegationRows({ delegated: true })` adds the U4 fields
// (DELEGATION_TRACE_ROWS in run-check.mjs) to the very same rows.

const T0 = Date.parse('2026-09-29T10:00:00Z')
const stamp = seconds => new Date(T0 + seconds * 1000).toISOString()

function delegationRows({ delegated }) {
  const response = (ts, requestId, usage, { latency, reason, effort, tools = false, who }) => ({
    ts: stamp(ts),
    request_id: requestId,
    event: 'provider.response',
    data: {
      latency_ms: latency,
      has_tool_calls: tools,
      content_chars: tools ? 0 : 240,
      usage: { input_units: usage[0], cached_input_units: usage[1], output_units: usage[2], reasoning_output_units: usage[3], usage_complete: true },
      provider: { reasoning_policy_reason: reason, reasoning_effort: effort, model: 'deepseek-flash' },
      ...(delegated ? { role: who[0], handoff_id: who[1] } : {}),
    },
  })
  const restaged = (ts, requestId, data) => (delegated
    ? [{ ts: stamp(ts), request_id: requestId, event: 'context.restaged', data }]
    : [])
  const board = (goalId, stepId) => ({ goal_id: goalId, active_step_id: stepId, status: 'active' })
  return [
    { ts: stamp(0), request_id: 'req_a_1', event: 'request.received', data: { interaction_intent: 'new_goal' } },
    response(20, 'req_a_1', [21_408, 18_944, 9_120, 8_400], { latency: 20_000, reason: 'plan_authoring', effort: 'max', who: ['planner', 'ho_plan_1'] }),
    { ts: stamp(21), request_id: 'req_a_1', event: 'plan.accepted', data: { chat_message: 'Plan: mine ore, smelt plates, craft drills.' } },
    { ts: stamp(21), request_id: 'req_a_1', event: 'plan.persisted', data: { goal_id: 'goal_1', task_board: board('goal_1', 'step_1') } },
    ...restaged(21, 'req_a_1', { role: 'executor', checkpoint: 'C3', handoff_id: 'ho_exec_1', packet_hash: '9f2c41d07a3be518', packet_chars: 3412, packet_estimated_tokens: 853, previous_context_chars: 88_120, reason: 'executor_fresh_at_plan_commit', plan_id: 'plan_1', step_id: 'step_1' }),
    { ts: stamp(22), request_id: 'req_a_1', event: 'operations.ack', data: {} },
    response(34, 'req_a_1', [23_871, 22_016, 1204, 800], { latency: 6000, reason: 'same_goal_continue', effort: 'low', tools: true, who: ['executor', 'ho_exec_1'] }),
    { ts: stamp(34), request_id: 'req_a_1', event: 'tool.call', data: { name: 'getInventoryItems', cached: false } },
    { ts: stamp(82), request_id: 'req_a_1', event: 'factorio.completed_signal', data: {} },
    { ts: stamp(83), request_id: 'req_a_1', event: 'step.verified', data: { active_step_id: 'step_1' } },
    response(95, 'req_a_1', [25_112, 23_808, 2016, 1100], { latency: 9000, reason: 'same_goal_continue', effort: 'low', who: ['executor', 'ho_exec_1'] }),
    { ts: stamp(96), request_id: 'req_a_1', event: 'request.completed', data: { chat_message: 'Ore mined.', outcome: 'no_operations' } },
    { ts: stamp(200), request_id: 'req_b_1', event: 'request.received', data: { interaction_intent: 'continue_current' } },
    { ts: stamp(201), request_id: 'req_b_1', event: 'factorio.status', data: { task_board: board('goal_1', 'step_2') } },
    ...restaged(202, 'req_b_1', { role: 'planner', checkpoint: 'C1', handoff_id: 'ho_plan_2', packet_hash: 'c40de17b95a2f6e8', packet_chars: 5704, packet_estimated_tokens: 1426, previous_context_chars: 412_880, reason: 'context_over_soft_limit_at_slice_close', plan_id: 'plan_1' }),
    ...restaged(203, 'req_b_1', { role: 'executor', checkpoint: 'C3', handoff_id: 'ho_exec_2', packet_hash: '1b77e0a9c6d24f03', packet_chars: 3968, packet_estimated_tokens: 992, previous_context_chars: 104_552, reason: 'executor_fresh_at_plan_commit', plan_id: 'plan_2', step_id: 'step_2' }),
    response(215, 'req_b_1', [26_540, 25_088, 1890, 900], { latency: 14_000, reason: 'same_goal_continue', effort: 'low', tools: true, who: ['executor', 'ho_exec_2'] }),
    { ts: stamp(216), request_id: 'req_b_1', event: 'request.completed', data: { chat_message: 'Smelting started.', outcome: 'no_operations' } },
  ]
}

test('run record: rows without role, handoff_id or restage rows format exactly as before delegation', () => {
  const record = buildRunRecord(delegationRows({ delegated: false }))
  for (const key of ['by_role', 'restages']) assert.equal(key in record, false, `${key} must not appear without delegation fields`)
  for (const row of record.by_request) for (const key of ['roles', 'handoff_ids', 'restages']) assert.equal(key in row, false, `by_request.${key}`)
  // Golden text captured from the formatter before U9 touched it.
  assert.equal(formatRunRecord(record), [
    'SGLuna run record',
    'requests: 2 · provider calls: 4 · verified steps: 1',
    'input 96,931 (89,856 cached, 93%; 7,075 miss) · output 14,230 (11,200 reasoning, 79%)',
    'per verified step: 14,230 output, 111,161 total units',
    'prices: none given (units only; pass --prices <file> for money)',
    '',
    'Spend by round type (reasoning_policy_reason):',
    '- plan_authoring: 1 rounds · in 21,408 (89% cached) · out 9,120 · 9,120 out/round · 64% of output · 21,408 in/round · cache miss 12% · p50 20s · max 20s',
    '- same_goal_continue: 3 rounds · in 75,523 (94% cached) · out 5,110 · 1,703 out/round · 36% of output · 25,174 in/round · cache miss 6% · p50 9s · max 14s',
    '',
    'Output by effort:',
    '- max: 1 rounds · 9,120 (64%)',
    '- low: 3 rounds · 5,110 (36%)',
    '',
    'Spend with no world change:',
    '- observation-only rounds: 1 rounds · in 23,871 (92% cached) · out 1,204',
    '- recovery rounds: 0 rounds · in 0 (— cached) · out 0',
    '- invalid plan submissions: 0 · 0 rounds · in 0 (— cached) · out 0',
    '- rounds after the plan was blocked: 0 rounds · in 0 (— cached) · out 0',
    '- duplicate tool calls: 0',
    '',
    'By goal:',
    '- goal_1: 2 requests · 1 verified · 4 rounds · in 96,931 (93% cached) · out 14,230 · 14,230 out per verified step',
    '',
    'By step (rounds attributed to the step active when they ran):',
    '- goal_1/step_1 (verified): 2 rounds · in 48,983 (94% cached) · out 3,220',
    '- goal_1/step_2: 1 rounds · in 26,540 (95% cached) · out 1,890',
    '',
    'Player-felt responsiveness (2.10): first chat line and first admitted action, from the player request:',
    '- requests: 2 · acknowledged: 0 · first chat p50 16s max 21s · first action p50 22s max 22s',
    '- req_a_1: first chat 21s (plan.accepted) · first planner chat 21s · first action 22s',
    '- req_b_1: first chat 16s (request.completed) · first planner chat 16s · first action —',
    '',
    'By request (time: think / actor busy incl. walking / idle):',
    '- req_a_1 @ 2026-09-29T10:00:00.000Z · no_operations · 1 verified · 3 rounds · in 70,391 (92% cached) · out 12,340 · wall 96s = think 35s + busy 60s + idle 1s (1% idle, reconstructed)',
    '- req_b_1 @ 2026-09-29T10:03:20.000Z · no_operations · 0 verified · 1 rounds · in 26,540 (95% cached) · out 1,890 · wall 16s = think 14s + busy 0s + idle 2s (13% idle, reconstructed)',
    '',
    'Chat verbosity:',
    '- plans with a chat message: 1 of 1',
    '- tool-call responses with assistant content: 0 of 2',
    '- responses with any content: 2 of 4',
    '- request.completed with chat: 2 of 2',
    '',
    'Time estimates (2.6):',
    '- batches estimated: 0 (0 long) · reviews asked: 0 · answered: none',
  ].join('\n'))
})

test('run record: role and handoff_id ride each request, spend splits by role, restages are summarised', () => {
  const legacy = buildRunRecord(delegationRows({ delegated: false }))
  const record = buildRunRecord(delegationRows({ delegated: true }))

  // The extra fields change nothing that was already counted.
  assert.deepEqual(record.totals, legacy.totals)
  assert.deepEqual(record.by_goal, legacy.by_goal)
  assert.deepEqual(record.by_step, legacy.by_step)

  const [first, second] = record.by_request
  assert.deepEqual(first.roles, ['planner', 'executor'])
  assert.deepEqual(first.handoff_ids, ['ho_plan_1', 'ho_exec_1'])
  assert.equal(first.restages, 1)
  assert.deepEqual(second.roles, ['planner', 'executor'])
  assert.deepEqual(second.handoff_ids, ['ho_plan_2', 'ho_exec_2'])
  assert.equal(second.restages, 2)

  assert.deepEqual(record.by_role.map(row => [row.role, row.rounds, row.input_units, row.output_units]), [
    ['planner', 1, 21_408, 9120],
    ['executor', 3, 75_523, 5110],
  ])
  assert.equal(record.by_role[0].output_share, 0.641)

  assert.equal(record.restages.count, 3)
  assert.deepEqual(record.restages.by_checkpoint, { C1: 1, C3: 2 })
  assert.deepEqual(record.restages.by_role, { executor: 2, planner: 1 })
  assert.deepEqual(record.restages.packet_chars, { count: 3, min: 3412, p50: 3968, max: 5704, total: 13_084 })
  assert.deepEqual(record.restages.packet_estimated_tokens, { count: 3, min: 853, p50: 992, max: 1426, total: 3271 })
  assert.equal(record.restages.stale_replies_dropped, 0)

  const text = formatRunRecord(record)
  assert.match(text, /- req_a_1 @ 2026-09-29T10:00:00\.000Z · no_operations · role planner\+executor · handoff ho_plan_1, ho_exec_1 · 1 restage · 1 verified · 3 rounds/)
  assert.match(text, /- req_b_1 @ 2026-09-29T10:03:20\.000Z · no_operations · role planner\+executor · handoff ho_plan_2, ho_exec_2 · 2 restages · 0 verified · 1 rounds/)
  assert.match(text, /Spend by conversation role \(delegation\):\n- planner: 1 rounds · in 21,408 \(89% cached\) · out 9,120 · 64% of output · cache miss 12%\n- executor: 3 rounds/)
  assert.match(text, /Restages \(delegation\):\n- restages: 3 · by checkpoint: C1 1, C3 2 · by role: executor 2, planner 1 · stale replies dropped: 0\n- packet chars min 3,412 · p50 3,968 · max 5,704 · total 13,084\n- packet est\. tokens min 853 · p50 992 · max 1,426 · total 3,271/)
})

test('run record: a trace that mixes old rows and delegation rows only annotates the delegated ones; drops are counted', () => {
  const rows = delegationRows({ delegated: true })
  // The first request predates delegation (strip its fields), the second stays delegated.
  const mixed = rows.map((row) => {
    if (row.request_id !== 'req_a_1') return row
    if (row.event === 'context.restaged') return undefined
    if (row.event === 'provider.response') return { ...row, data: { ...row.data, role: undefined, handoff_id: undefined } }
    return row
  }).filter(Boolean)
  mixed.push({ ts: stamp(212), request_id: 'req_b_1', event: 'context.stale_reply_dropped', data: { role: 'executor', handoff_id: 'ho_exec_1', active_handoff_id: 'ho_exec_2', reason: 'handoff_superseded' } })
  const record = buildRunRecord(mixed)
  const [first, second] = record.by_request
  for (const key of ['roles', 'handoff_ids', 'restages']) assert.equal(key in first, false, key)
  assert.deepEqual(second.handoff_ids, ['ho_plan_2', 'ho_exec_2'])
  assert.deepEqual(record.by_role.map(row => [row.role, row.rounds]), [['executor', 1]])
  assert.equal(record.restages.count, 2)
  assert.equal(record.restages.stale_replies_dropped, 1)
  assert.match(formatRunRecord(record), /stale replies dropped: 1/)
})
