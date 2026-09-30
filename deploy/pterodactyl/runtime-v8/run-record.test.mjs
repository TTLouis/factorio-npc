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
