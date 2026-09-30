import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'
import { buildPrefixReport, formatPrefixReport } from './prefix-report.mjs'
import { responsivenessByRequest } from './responsiveness.mjs'
import { DELEGATION_TRACE_ROWS } from './run-check.mjs'

// Groups the prompt trace (provider.request / provider.response /
// provider.response_error) into per-round latency and reasoning-policy
// measurements. Nothing here reads or reports request/response payload text,
// tool arguments, chat content, or auth headers -- only the structural fields
// named in the events themselves (ts, round, recovery_attempt, reasoning
// policy, diagnostic/finish codes, and normalized token counts).

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined
}

function safeText(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseTs(value) {
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function roundKey(row) {
  return `${safeInteger(row?.round) ?? 'na'}|${safeInteger(row?.recovery_attempt) ?? 0}`
}

/**
 * The prompt trace has no request_id (the runtime never passes one into
 * provider() -- see npc-agent-loop.mjs's call site), so a "request" is
 * reconstructed from the only boundary the trace does carry: round resets to
 * 0 at the first round of every new provider request (AGENTS.md / W2a:
 * "only the first round of a request gets the trigger's policy"). The agent
 * loop issues provider calls strictly one at a time, so a round/recovery_attempt
 * pair is never ambiguous while a request is outstanding.
 */
export function analyzeThinkTime(rows) {
  const requests = []
  let current = null
  const pendingByKey = new Map()

  const startRequest = firstRow => {
    current = { started_ts: safeText(firstRow?.ts), rounds: [] }
    requests.push(current)
  }

  const isRequestBoundary = row => safeInteger(row.round) === 0 && (safeInteger(row.recovery_attempt) ?? 0) === 0

  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.event === 'provider.request') {
      // round resets to 0 both at a genuine new request and at an
      // output-budget recovery retry of round 0 (recovery_attempt > 0, same
      // round). Only the true first attempt starts a new request boundary.
      if (current === null || isRequestBoundary(row)) startRequest(row)
      pendingByKey.set(roundKey(row), row)
      continue
    }
    if (row?.event !== 'provider.response' && row?.event !== 'provider.response_error') continue

    const key = roundKey(row)
    const requestRow = pendingByKey.get(key)
    if (requestRow) pendingByKey.delete(key)
    if (current === null) startRequest(requestRow ?? row)

    const requestTs = parseTs(requestRow?.ts)
    const responseTs = parseTs(row.ts)
    const latencyMs = requestTs !== undefined && responseTs !== undefined && responseTs >= requestTs
      ? responseTs - requestTs
      : undefined

    current.rounds.push({
      round: safeInteger(row.round),
      recovery_attempt: safeInteger(row.recovery_attempt) ?? 0,
      event: row.event,
      latency_ms: latencyMs,
      reasoning_effort: safeText(requestRow?.reasoning_effort ?? row.reasoning_effort),
      reasoning_policy_reason: safeText(requestRow?.reasoning_policy_reason ?? row.reasoning_policy_reason),
      trigger_source: safeText(requestRow?.trigger_source),
      diagnostic_code: safeText(row.diagnostic_code),
      finish_reason: row.event === 'provider.response' ? safeText(row.finish_reason) : undefined,
      reasoning_tokens: row.event === 'provider.response' ? safeInteger(row.reported_reasoning_tokens) : undefined,
    })
  }

  return requests
}

function median(sortedValues) {
  if (sortedValues.length === 0) return undefined
  return sortedValues[Math.floor((sortedValues.length - 1) * 0.5)]
}

function latencyStats(rounds) {
  const latencies = rounds.map(round => round.latency_ms).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  return {
    count: rounds.length,
    matched_latency_count: latencies.length,
    p50_latency_ms: median(latencies),
    max_latency_ms: latencies.length > 0 ? latencies[latencies.length - 1] : undefined,
  }
}

function reasoningTokenStats(rounds) {
  const tokens = rounds.map(round => round.reasoning_tokens).filter(value => Number.isFinite(value))
  if (tokens.length === 0) return { reasoning_tokens_total: undefined, reasoning_tokens_sample_count: 0 }
  return {
    reasoning_tokens_total: tokens.reduce((total, value) => total + value, 0),
    reasoning_tokens_sample_count: tokens.length,
  }
}

function lengthFinishCount(rounds) {
  return rounds.filter(round => round.finish_reason === 'length').length
}

function errorCount(rounds) {
  return rounds.filter(round => round.event === 'provider.response_error').length
}

export function summarizeByRequest(requests) {
  return requests.map((request, index) => {
    const slowest = request.rounds.reduce((slowestSoFar, round) => {
      if (!Number.isFinite(round.latency_ms)) return slowestSoFar
      if (!slowestSoFar || round.latency_ms > slowestSoFar.latency_ms) return round
      return slowestSoFar
    }, undefined)
    return {
      request_index: index + 1,
      started_ts: request.started_ts,
      ...latencyStats(request.rounds),
      ...reasoningTokenStats(request.rounds),
      length_finish_count: lengthFinishCount(request.rounds),
      error_count: errorCount(request.rounds),
      slowest_round: slowest
        ? { round: slowest.round, recovery_attempt: slowest.recovery_attempt, latency_ms: slowest.latency_ms, reasoning_effort: slowest.reasoning_effort, reasoning_policy_reason: slowest.reasoning_policy_reason }
        : undefined,
    }
  })
}

export function summarizeByPolicyReason(requests) {
  const byReason = new Map()
  for (const request of requests) {
    for (const round of request.rounds) {
      const reason = round.reasoning_policy_reason ?? 'unknown'
      if (!byReason.has(reason)) byReason.set(reason, [])
      byReason.get(reason).push(round)
    }
  }
  return [...byReason.entries()]
    .map(([reason, rounds]) => ({
      reasoning_policy_reason: reason,
      ...latencyStats(rounds),
      ...reasoningTokenStats(rounds),
      length_finish_count: lengthFinishCount(rounds),
      error_count: errorCount(rounds),
    }))
    .sort((a, b) => b.count - a.count)
}

export function summarizeOverall(requests) {
  const allRounds = requests.flatMap(request => request.rounds)
  return {
    request_count: requests.length,
    ...latencyStats(allRounds),
    ...reasoningTokenStats(allRounds),
    length_finish_count: lengthFinishCount(allRounds),
    error_count: errorCount(allRounds),
  }
}

export function buildThinkTimeReport(rows) {
  const requests = analyzeThinkTime(rows)
  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    overall: summarizeOverall(requests),
    by_request: summarizeByRequest(requests),
    by_policy_reason: summarizeByPolicyReason(requests),
  }
}

function seconds(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms / 100) / 10}s` : '—'
}

function printable(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

export function formatThinkTimeReport(report) {
  const lines = [
    'SGLuna think-time report',
    `requests: ${report.overall.request_count} · rounds: ${report.overall.count} (matched latency ${report.overall.matched_latency_count}) · finish=length: ${report.overall.length_finish_count} · errors: ${report.overall.error_count}`,
    `overall p50: ${seconds(report.overall.p50_latency_ms)} · max: ${seconds(report.overall.max_latency_ms)}`,
    '',
    'By policy reason (reasoning_policy_reason):',
  ]
  for (const row of report.by_policy_reason) {
    lines.push(`- ${row.reasoning_policy_reason}: ${row.count} rounds · p50 ${seconds(row.p50_latency_ms)} · max ${seconds(row.max_latency_ms)} · reasoning tokens ${printable(row.reasoning_tokens_total)} (n=${row.reasoning_tokens_sample_count}) · finish=length ${row.length_finish_count} · errors ${row.error_count}`)
  }
  lines.push('', 'By request (round=0 resets the boundary; no request_id is traced today):')
  for (const row of report.by_request) {
    const slowest = row.slowest_round
      ? `slowest ${seconds(row.slowest_round.latency_ms)} (round ${row.slowest_round.round}, ${printable(row.slowest_round.reasoning_effort)}/${printable(row.slowest_round.reasoning_policy_reason)})`
      : 'slowest —'
    lines.push(`- #${row.request_index} @ ${printable(row.started_ts)}: ${row.count} rounds · p50 ${seconds(row.p50_latency_ms)} · max ${seconds(row.max_latency_ms)} · ${slowest} · finish=length ${row.length_finish_count} · errors ${row.error_count}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Run record (work plan item 2.7, W2d): the counters the 2026-09-26 steam run
// needed one-off scripts for, computed from the behavior trace
// (sgluna-behavior.jsonl) alone:
//  - spend by round type and by effort, cache-miss share per round type;
//  - spend per request, per goal and per step, and per verified step;
//  - spend that bought no world change: observation-only rounds, recovery
//    rounds, invalid plan submissions, rounds after the plan was blocked, and
//    duplicate tool calls;
//  - chat verbosity (the steam run's "DeepSeek chat verbosity" table);
//  - the time split per request (think, actor busy, idle) and the harness
//    time estimates next to what was measured (2.6).
// Money only with a price file (--prices): no rate is configured or guessed
// anywhere. Like the rest of this file, nothing reads payload text; chat is
// counted, never copied.

const USAGE_KEYS = ['input_units', 'cached_input_units', 'cache_miss_input_units', 'output_units', 'reasoning_output_units', 'visible_output_units']
const RUN_TERMINAL_EVENTS = new Set(['request.completed', 'request.failed', 'request.cancelled', 'request.superseded'])
const RUN_BUSY_END_EVENTS = new Set(['factorio.completed_signal', 'factorio.error_continuation', 'factorio.completion_continuation', 'factorio.event_coalesced', 'post_step.routed'])
const PLAN_EVENTS = new Set(['provider.plan_submission', 'plan.accepted', 'provider.plan_submission_salvaged'])

function usageInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function emptySpend() {
  return { rounds: 0, input_units: 0, cached_input_units: 0, cache_miss_input_units: 0, output_units: 0, reasoning_output_units: 0, visible_output_units: 0, cost: 0, unpriced_rounds: 0 }
}

function addSpend(target, round) {
  target.rounds++
  for (const key of USAGE_KEYS) target[key] += round.usage[key]
  if (Number.isFinite(round.cost)) target.cost += round.cost
  else target.unpriced_rounds++
}

function spendView(spend, { priced }) {
  const view = {
    rounds: spend.rounds,
    input_units: spend.input_units,
    cached_input_units: spend.cached_input_units,
    cache_miss_input_units: spend.cache_miss_input_units,
    cached_input_share: spend.input_units > 0 ? Math.round(spend.cached_input_units / spend.input_units * 1000) / 1000 : undefined,
    cache_miss_input_share: spend.input_units > 0 ? Math.round(spend.cache_miss_input_units / spend.input_units * 1000) / 1000 : undefined,
    output_units: spend.output_units,
    reasoning_output_units: spend.reasoning_output_units,
    visible_output_units: spend.visible_output_units,
    output_units_per_round: spend.rounds > 0 ? Math.round(spend.output_units / spend.rounds) : undefined,
    input_units_per_round: spend.rounds > 0 ? Math.round(spend.input_units / spend.rounds) : undefined,
    cache_miss_input_units_per_round: spend.rounds > 0 ? Math.round(spend.cache_miss_input_units / spend.rounds) : undefined,
  }
  if (priced) {
    view.cost = Math.round(spend.cost * 1_000_000) / 1_000_000
    if (spend.unpriced_rounds > 0) view.unpriced_rounds = spend.unpriced_rounds
  }
  return view
}

function roundUsage(usage) {
  const input = usageInteger(usage?.input_units)
  const cached = usageInteger(usage?.cached_input_units)
  const miss = Number.isSafeInteger(usage?.cache_miss_input_units) ? usage.cache_miss_input_units : Math.max(0, input - cached)
  const output = usageInteger(usage?.output_units)
  const reasoning = usageInteger(usage?.reasoning_output_units)
  const visible = Number.isSafeInteger(usage?.visible_output_units) ? usage.visible_output_units : Math.max(0, output - reasoning)
  return { input_units: input, cached_input_units: cached, cache_miss_input_units: miss, output_units: output, reasoning_output_units: reasoning, visible_output_units: visible }
}

// Price file: { "currency": "USD", "<model>" or "*": { "input", "cached_input",
// "output" } } in currency per 1,000,000 units. Cached input is its own rate.
export function parsePriceTable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('price file must be a JSON object')
  const currency = typeof value.currency === 'string' ? value.currency.slice(0, 12) : 'price units'
  const models = {}
  for (const [model, rates] of Object.entries(value)) {
    if (model === 'currency') continue
    for (const key of ['input', 'cached_input', 'output']) {
      if (!(typeof rates?.[key] === 'number' && Number.isFinite(rates[key]) && rates[key] >= 0)) {
        throw new Error(`price for ${model} needs a non-negative ${key} (per 1,000,000 units)`)
      }
    }
    models[model] = { input: rates.input, cached_input: rates.cached_input, output: rates.output }
  }
  if (Object.keys(models).length === 0) throw new Error('price file names no model')
  return { currency, models }
}

function roundCost(prices, model, usage) {
  if (!prices) return undefined
  const rates = prices.models[model] ?? prices.models['*']
  if (!rates) return undefined
  return (usage.cache_miss_input_units * rates.input + usage.cached_input_units * rates.cached_input + usage.output_units * rates.output) / 1_000_000
}

function sortedRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])]
    .map((row, index) => ({ row, index, ms: parseTs(row?.ts) ?? 0 }))
    .sort((a, b) => a.ms - b.ms || (safeInteger(a.row?.seq) ?? 0) - (safeInteger(b.row?.seq) ?? 0) || a.index - b.index)
    .map(entry => entry.row)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function share(part, whole) {
  return whole > 0 ? Math.round(part / whole * 1000) / 1000 : undefined
}

export function buildRunRecord(behaviorRows, { prices } = {}) {
  const priced = Boolean(prices)
  const rows = sortedRows(behaviorRows)
  const rounds = []
  const requests = new Map()
  const verified = []
  const duplicateToolCalls = { count: 0 }
  const invalidSubmissions = []
  const verbosity = { plans: 0, plans_with_chat: 0, tool_call_responses: 0, tool_call_responses_with_content: 0, responses: 0, responses_with_content: 0, completed: 0, completed_with_chat: 0 }
  const estimates = []
  const measured = []
  const reviews = []
  const goalWarnings = []
  const restages = []
  let staleRepliesDropped = 0

  // Role and handoff id are the delegation trace fields (DELEGATION_TRACE_ROWS
  // in run-check.mjs). Rows from before delegation carry neither, so a request
  // without them gets no role or handoff key anywhere in the record.
  const noteConversation = (request, role, handoffId) => {
    if (role && !request.roles.includes(role)) request.roles.push(role)
    if (handoffId && !request.handoff_ids.includes(handoffId)) request.handoff_ids.push(handoffId)
  }

  const requestState = id => {
    if (!requests.has(id)) {
      requests.set(id, { request_id: id, started_ts: undefined, ended_ts: undefined, outcome: undefined, goal_id: undefined, step_id: undefined, blocked: false, last_round: undefined, busy_since: undefined, busy_ms: 0, think_ms: 0, time_split: undefined, verified_steps: 0, unattributed: [], new_goal: false, roles: [], handoff_ids: [], restages: 0 })
    }
    return requests.get(id)
  }

  for (const row of rows) {
    const id = typeof row?.request_id === 'string' && row.request_id ? row.request_id : undefined
    if (!id) continue
    const request = requestState(id)
    const data = row.data && typeof row.data === 'object' ? row.data : {}
    const ms = parseTs(row.ts)
    request.started_ts ??= safeText(row.ts)
    // A request that starts a new goal charges nothing to the goal live
    // before it: its rounds stay unattributed until its first plan is saved.
    if (row.event === 'request.received' && data.interaction_intent === 'new_goal') request.new_goal = true
    if (row.event === 'plan.persisted') request.new_goal = false
    const board = data.task_board && typeof data.task_board === 'object' ? data.task_board : undefined
    if (!request.new_goal && board) {
      request.goal_id = safeText(board.goal_id) ?? request.goal_id
      request.step_id = safeText(board.active_step_id) ?? request.step_id
      request.blocked = board.status === 'blocked'
    }
    else if (!request.new_goal && safeText(data.goal_id)) request.goal_id = data.goal_id
    // Rounds that ran before the goal existed (authoring a new goal) belong
    // to the goal their request goes on to persist; they have no step.
    if (request.goal_id && request.unattributed.length > 0) {
      for (const round of request.unattributed) round.goal_id = request.goal_id
      request.unattributed = []
    }
    const event = row.event

    if (event === 'provider.response') {
      const usage = roundUsage(data.usage)
      const model = safeText(data.provider?.model)
      const round = {
        request_id: id,
        goal_id: request.goal_id,
        step_id: request.step_id,
        reasoning_policy_reason: safeText(data.provider?.reasoning_policy_reason) ?? 'unknown',
        reasoning_effort: safeText(data.provider?.reasoning_effort) ?? 'unknown',
        model,
        role: safeText(data.role),
        handoff_id: safeText(data.handoff_id),
        latency_ms: Number.isFinite(data.latency_ms) ? data.latency_ms : undefined,
        recovery: (safeInteger(data.recovery_attempt) ?? 0) > 0 || /recovery/.test(safeText(data.provider?.reasoning_policy_reason) ?? ''),
        after_blocked: request.blocked,
        tools: 0,
        plan: false,
        invalid: false,
        usage,
        cost: roundCost(prices, model ?? '', usage),
      }
      rounds.push(round)
      noteConversation(request, round.role, round.handoff_id)
      if (!round.goal_id) request.unattributed.push(round)
      request.last_round = round
      if (Number.isFinite(round.latency_ms)) request.think_ms += round.latency_ms
      verbosity.responses++
      const contentChars = safeInteger(data.content_chars) ?? 0
      if (contentChars > 0) verbosity.responses_with_content++
      if (data.has_tool_calls === true) {
        verbosity.tool_call_responses++
        if (contentChars > 0) verbosity.tool_call_responses_with_content++
      }
      continue
    }
    if (event === DELEGATION_TRACE_ROWS.events.restaged) {
      const role = safeText(data.role)
      noteConversation(request, role, safeText(data.handoff_id))
      request.restages++
      restages.push({
        request_id: id,
        role,
        checkpoint: safeText(data.checkpoint),
        packet_chars: Number.isFinite(data.packet_chars) ? data.packet_chars : undefined,
        packet_estimated_tokens: Number.isFinite(data.packet_estimated_tokens) ? data.packet_estimated_tokens : undefined,
      })
    }
    if (event === DELEGATION_TRACE_ROWS.events.staleReplyDropped) staleRepliesDropped++
    if (event === 'tool.call') {
      if (request.last_round) request.last_round.tools++
      if (data.cached === true) duplicateToolCalls.count++
    }
    if (PLAN_EVENTS.has(event) && request.last_round) request.last_round.plan = true
    if (event === 'provider.plan_submission_invalid') {
      if (request.last_round) request.last_round.invalid = true
      invalidSubmissions.push({ request_id: id, ts: safeText(row.ts), round_output_units: request.last_round?.usage.output_units })
    }
    if (event === 'plan.accepted') {
      verbosity.plans++
      if (nonEmptyText(data.chat_message)) verbosity.plans_with_chat++
    }
    if (event === 'operations.ack' && request.busy_since === undefined && ms !== undefined) request.busy_since = ms
    const statusIdle = event === 'factorio.status' && (data.task_status?.queue_empty === true || data.task_status?.task_state === 'idle')
    if (request.busy_since !== undefined && ms !== undefined && (RUN_BUSY_END_EVENTS.has(event) || statusIdle || RUN_TERMINAL_EVENTS.has(event))) {
      request.busy_ms += Math.max(0, ms - request.busy_since)
      request.busy_since = undefined
    }
    if (event === 'step.verified' || event === 'step.semantic_completed') {
      request.verified_steps++
      verified.push({ request_id: id, goal_id: request.goal_id, step_id: safeText(data.active_step_id) ?? request.step_id })
    }
    if (event === 'plan.time_estimate') estimates.push({ request_id: id, goal_id: safeText(data.goal_id), step_id: safeText(data.step_id), step_expected_seconds: data.step_expected_seconds, long: data.long === true, review: safeText(data.review) })
    if (event === 'step.time_measured') measured.push({ request_id: id, goal_id: safeText(data.goal_id), step_id: safeText(data.step_id), expected_seconds: data.expected_seconds, elapsed_wall_seconds: data.elapsed_wall_seconds, ratio: data.ratio })
    if (event === 'plan.time_review_requested') reviews.push({ request_id: id, kind: 'requested', expected_seconds: data.expected_seconds, trigger: safeText(data.trigger) })
    if (event === 'plan.time_review_answered') reviews.push({ request_id: id, kind: 'answered', decision: safeText(data.decision), operations_revised: data.operations_revised === true, unprompted: data.unprompted === true })
    if (event === 'budget.goal_warning') goalWarnings.push({ request_id: id, goal_id: safeText(data.goal_id), output_units: data.output_units, threshold_output_units: data.threshold_output_units })
    if (event === 'request.time_split') request.time_split = data
    if (RUN_TERMINAL_EVENTS.has(event)) {
      request.ended_ts = safeText(row.ts)
      request.outcome = safeText(data.outcome) ?? event
      if (event === 'request.completed') {
        verbosity.completed++
        if (nonEmptyText(data.chat_message)) verbosity.completed_with_chat++
      }
    }
  }

  const totals = emptySpend()
  const byType = new Map()
  const byEffort = new Map()
  const byGoal = new Map()
  const byStep = new Map()
  const byRequest = new Map()
  const byRole = new Map()
  const waste = { observation_only: emptySpend(), recovery: emptySpend(), invalid_plan_submission: emptySpend(), after_blocked: emptySpend() }
  const latencies = new Map()
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, emptySpend())
    return map.get(key)
  }
  for (const round of rounds) {
    addSpend(totals, round)
    addSpend(bucket(byType, round.reasoning_policy_reason), round)
    addSpend(bucket(byEffort, round.reasoning_effort), round)
    addSpend(bucket(byRequest, round.request_id), round)
    if (round.role) addSpend(bucket(byRole, round.role), round)
    if (round.goal_id) addSpend(bucket(byGoal, round.goal_id), round)
    if (round.goal_id && round.step_id) addSpend(bucket(byStep, `${round.goal_id}|${round.step_id}`), round)
    if (round.tools > 0 && !round.plan && !round.invalid) addSpend(waste.observation_only, round)
    if (round.recovery) addSpend(waste.recovery, round)
    if (round.invalid) addSpend(waste.invalid_plan_submission, round)
    if (round.after_blocked) addSpend(waste.after_blocked, round)
    if (Number.isFinite(round.latency_ms)) {
      if (!latencies.has(round.reasoning_policy_reason)) latencies.set(round.reasoning_policy_reason, [])
      latencies.get(round.reasoning_policy_reason).push(round.latency_ms)
    }
  }
  const verifiedCount = verified.length
  const verifiedByGoal = new Map()
  const verifiedSteps = new Set()
  for (const item of verified) {
    if (item.goal_id) verifiedByGoal.set(item.goal_id, (verifiedByGoal.get(item.goal_id) ?? 0) + 1)
    if (item.goal_id && item.step_id) verifiedSteps.add(`${item.goal_id}|${item.step_id}`)
  }
  const perVerified = (spend, count) => count > 0
    ? { output_units_per_verified_step: Math.round(spend.output_units / count), total_units_per_verified_step: Math.round((spend.input_units + spend.output_units) / count), ...(priced ? { cost_per_verified_step: Math.round(spend.cost / count * 1_000_000) / 1_000_000 } : {}) }
    : {}

  const responsiveness = responsivenessByRequest(rows)
  const firstChat = [...responsiveness.values()].map(item => item.first_chat_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const firstAction = [...responsiveness.values()].map(item => item.first_action_ms).filter(Number.isFinite).sort((a, b) => a - b)
  const record = {
    schema: 1,
    requests: requests.size,
    totals: { ...spendView(totals, { priced }), reasoning_output_share: share(totals.reasoning_output_units, totals.output_units), verified_steps: verifiedCount, ...perVerified(totals, verifiedCount) },
    by_round_type: [...byType.entries()].map(([reason, spend]) => {
      const sorted = (latencies.get(reason) ?? []).sort((a, b) => a - b)
      return {
        reasoning_policy_reason: reason,
        ...spendView(spend, { priced }),
        output_share: share(spend.output_units, totals.output_units),
        p50_latency_ms: median(sorted),
        max_latency_ms: sorted.length > 0 ? sorted[sorted.length - 1] : undefined,
      }
    }).sort((a, b) => b.output_units - a.output_units),
    by_effort: [...byEffort.entries()].map(([effort, spend]) => ({ reasoning_effort: effort, rounds: spend.rounds, output_units: spend.output_units, output_share: share(spend.output_units, totals.output_units) }))
      .sort((a, b) => b.output_units - a.output_units),
    by_request: [...requests.values()].map((request) => {
      const spend = byRequest.get(request.request_id) ?? emptySpend()
      const started = parseTs(request.started_ts)
      const ended = parseTs(request.ended_ts)
      const wall = request.time_split?.wall_ms ?? (started !== undefined && ended !== undefined ? ended - started : undefined)
      const think = request.time_split?.think_ms ?? request.think_ms
      const busy = request.time_split?.actor_busy_ms ?? request.busy_ms
      return {
        request_id: request.request_id,
        started_ts: request.started_ts,
        outcome: request.outcome ?? 'open',
        goal_id: request.goal_id,
        verified_steps: request.verified_steps,
        ...(request.roles.length > 0 ? { roles: request.roles } : {}),
        ...(request.handoff_ids.length > 0 ? { handoff_ids: request.handoff_ids } : {}),
        ...(request.restages > 0 ? { restages: request.restages } : {}),
        ...spendView(spend, { priced }),
        time: {
          source: request.time_split ? 'request.time_split' : 'reconstructed',
          wall_ms: wall,
          think_ms: think,
          actor_busy_ms: busy,
          idle_ms: Number.isFinite(wall) ? Math.max(0, wall - think - busy) : undefined,
          idle_share: Number.isFinite(wall) && wall > 0 ? Math.round(Math.max(0, wall - think - busy) / wall * 1000) / 1000 : undefined,
          walking: 'inside_actor_busy',
        },
        // 2.10: what the player felt, from the player's request to the first
        // chat line and to the first admitted action.
        responsiveness: responsiveness.get(request.request_id),
      }
    }),
    by_goal: [...byGoal.entries()].map(([goalId, spend]) => ({
      goal_id: goalId,
      requests: new Set(rounds.filter(round => round.goal_id === goalId).map(round => round.request_id)).size,
      verified_steps: verifiedByGoal.get(goalId) ?? 0,
      ...spendView(spend, { priced }),
      ...perVerified(spend, verifiedByGoal.get(goalId) ?? 0),
    })),
    by_step: [...byStep.entries()].map(([key, spend]) => {
      const [goalId, stepId] = key.split('|')
      const estimate = [...estimates].reverse().find(item => item.goal_id === goalId && item.step_id === stepId)
      const time = measured.find(item => item.goal_id === goalId && item.step_id === stepId)
      return {
        goal_id: goalId,
        step_id: stepId,
        verified: verifiedSteps.has(key),
        ...spendView(spend, { priced }),
        expected_seconds: estimate?.step_expected_seconds,
        elapsed_wall_seconds: time?.elapsed_wall_seconds,
      }
    }),
    no_world_change: {
      observation_only_rounds: spendView(waste.observation_only, { priced }),
      recovery_rounds: spendView(waste.recovery, { priced }),
      invalid_plan_submissions: { count: invalidSubmissions.length, ...spendView(waste.invalid_plan_submission, { priced }) },
      rounds_after_plan_blocked: spendView(waste.after_blocked, { priced }),
      duplicate_tool_calls: duplicateToolCalls.count,
    },
    verbosity,
    time: { estimates, measured, reviews, goal_warnings: goalWarnings },
    responsiveness: {
      requests: responsiveness.size,
      acknowledged: [...responsiveness.values()].filter(item => Number.isFinite(item.acknowledged_ms)).length,
      p50_first_chat_ms: median(firstChat),
      max_first_chat_ms: firstChat.length > 0 ? firstChat[firstChat.length - 1] : undefined,
      p50_first_action_ms: median(firstAction),
      max_first_action_ms: firstAction.length > 0 ? firstAction[firstAction.length - 1] : undefined,
    },
    prices: priced ? { currency: prices.currency, models: Object.keys(prices.models) } : undefined,
  }
  // Delegation (U9): only present when the trace carries role or restage rows.
  if (byRole.size > 0) {
    record.by_role = [...byRole.entries()]
      .map(([role, spend]) => ({ role, ...spendView(spend, { priced }), output_share: share(spend.output_units, totals.output_units) }))
      .sort((a, b) => b.output_units - a.output_units || (a.role < b.role ? -1 : 1))
  }
  const restageSummary = summarizeRestages(restages, staleRepliesDropped)
  if (restageSummary) record.restages = restageSummary
  return record
}

function tally(values) {
  const counts = {}
  for (const value of values) counts[value ?? 'unknown'] = (counts[value ?? 'unknown'] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function sizeStats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return undefined
  return { count: sorted.length, min: sorted[0], p50: median(sorted), max: sorted[sorted.length - 1], total: sorted.reduce((sum, value) => sum + value, 0) }
}

// Count per checkpoint kind and per role, and the packet sizes (characters and
// estimated tokens) of every context.restaged row; dropped stale replies are
// counted next to them.
function summarizeRestages(items, staleRepliesDropped) {
  if (items.length === 0 && staleRepliesDropped === 0) return undefined
  return {
    count: items.length,
    by_checkpoint: tally(items.map(item => item.checkpoint)),
    by_role: tally(items.map(item => item.role)),
    packet_chars: sizeStats(items.map(item => item.packet_chars)),
    packet_estimated_tokens: sizeStats(items.map(item => item.packet_estimated_tokens)),
    stale_replies_dropped: staleRepliesDropped,
  }
}

// Step durations: seconds below 90 s, minutes above (as the harness shows them).
function duration(secondsValue) {
  if (!Number.isFinite(secondsValue)) return '—'
  return secondsValue < 90 ? `${Math.round(secondsValue)} s` : `${(Math.round(secondsValue / 6) / 10).toFixed(1)} min`
}

function thousands(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—'
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

function money(record, value) {
  return record.prices && Number.isFinite(value) ? ` · ${record.prices.currency} ${value.toFixed(4)}` : ''
}

function spendLine(record, spend) {
  return `${spend.rounds} rounds · in ${thousands(spend.input_units)} (${percent(spend.cached_input_share)} cached) · out ${thousands(spend.output_units)}${money(record, spend.cost)}`
}

export function formatRunRecord(record) {
  const t = record.totals
  const lines = [
    'SGLuna run record',
    `requests: ${record.requests} · provider calls: ${t.rounds} · verified steps: ${t.verified_steps}`,
    `input ${thousands(t.input_units)} (${thousands(t.cached_input_units)} cached, ${percent(t.cached_input_share)}; ${thousands(t.cache_miss_input_units)} miss) · output ${thousands(t.output_units)} (${thousands(t.reasoning_output_units)} reasoning, ${percent(t.reasoning_output_share)})${money(record, t.cost)}`,
    `per verified step: ${t.output_units_per_verified_step !== undefined ? `${thousands(t.output_units_per_verified_step)} output, ${thousands(t.total_units_per_verified_step)} total units${money(record, t.cost_per_verified_step)}` : 'no verified step'}`,
    record.prices ? `prices: ${record.prices.currency} per 1,000,000 units for ${record.prices.models.join(', ')}` : 'prices: none given (units only; pass --prices <file> for money)',
    '',
    'Spend by round type (reasoning_policy_reason):',
  ]
  for (const row of record.by_round_type) {
    lines.push(`- ${row.reasoning_policy_reason}: ${spendLine(record, row)} · ${thousands(row.output_units_per_round)} out/round · ${percent(row.output_share)} of output · ${thousands(row.input_units_per_round)} in/round · cache miss ${percent(row.cache_miss_input_share)} · p50 ${seconds(row.p50_latency_ms)} · max ${seconds(row.max_latency_ms)}`)
  }
  lines.push('', 'Output by effort:')
  for (const row of record.by_effort) lines.push(`- ${row.reasoning_effort}: ${row.rounds} rounds · ${thousands(row.output_units)} (${percent(row.output_share)})`)
  const waste = record.no_world_change
  lines.push('', 'Spend with no world change:')
  lines.push(`- observation-only rounds: ${spendLine(record, waste.observation_only_rounds)}`)
  lines.push(`- recovery rounds: ${spendLine(record, waste.recovery_rounds)}`)
  lines.push(`- invalid plan submissions: ${waste.invalid_plan_submissions.count} · ${spendLine(record, waste.invalid_plan_submissions)}`)
  lines.push(`- rounds after the plan was blocked: ${spendLine(record, waste.rounds_after_plan_blocked)}`)
  lines.push(`- duplicate tool calls: ${waste.duplicate_tool_calls}`)
  lines.push('', 'By goal:')
  if (record.by_goal.length === 0) lines.push('- none')
  for (const row of record.by_goal) {
    lines.push(`- ${row.goal_id}: ${row.requests} requests · ${row.verified_steps} verified · ${spendLine(record, row)}${row.output_units_per_verified_step !== undefined ? ` · ${thousands(row.output_units_per_verified_step)} out per verified step${money(record, row.cost_per_verified_step)}` : ''}`)
  }
  lines.push('', 'By step (rounds attributed to the step active when they ran):')
  if (record.by_step.length === 0) lines.push('- none')
  for (const row of record.by_step) {
    const time = row.expected_seconds !== undefined || row.elapsed_wall_seconds !== undefined
      ? ` · estimate ${duration(row.expected_seconds)} · took ${duration(row.elapsed_wall_seconds)}`
      : ''
    lines.push(`- ${row.goal_id}/${row.step_id}${row.verified ? ' (verified)' : ''}: ${spendLine(record, row)}${time}`)
  }
  const reply = record.responsiveness
  lines.push('', 'Player-felt responsiveness (2.10): first chat line and first admitted action, from the player request:')
  lines.push(`- requests: ${reply.requests} · acknowledged: ${reply.acknowledged} · first chat p50 ${seconds(reply.p50_first_chat_ms)} max ${seconds(reply.max_first_chat_ms)} · first action p50 ${seconds(reply.p50_first_action_ms)} max ${seconds(reply.max_first_action_ms)}`)
  for (const row of record.by_request) {
    const item = row.responsiveness
    if (item) lines.push(`- ${row.request_id}: first chat ${seconds(item.first_chat_ms)} (${printable(item.first_chat_source)}) · first planner chat ${seconds(item.first_planner_chat_ms)} · first action ${seconds(item.first_action_ms)}`)
  }
  lines.push('', 'By request (time: think / actor busy incl. walking / idle):')
  for (const row of record.by_request) {
    const conversation = [
      row.roles ? `role ${row.roles.join('+')}` : undefined,
      row.handoff_ids ? `handoff ${row.handoff_ids.join(', ')}` : undefined,
      row.restages ? `${row.restages} restage${row.restages === 1 ? '' : 's'}` : undefined,
    ].filter(Boolean)
    const conversationText = conversation.length > 0 ? ` · ${conversation.join(' · ')}` : ''
    lines.push(`- ${row.request_id} @ ${printable(row.started_ts)} · ${row.outcome}${conversationText} · ${row.verified_steps} verified · ${spendLine(record, row)} · wall ${seconds(row.time.wall_ms)} = think ${seconds(row.time.think_ms)} + busy ${seconds(row.time.actor_busy_ms)} + idle ${seconds(row.time.idle_ms)} (${percent(row.time.idle_share)} idle, ${row.time.source})`)
  }
  if (record.by_role) {
    lines.push('', 'Spend by conversation role (delegation):')
    for (const row of record.by_role) lines.push(`- ${row.role}: ${spendLine(record, row)} · ${percent(row.output_share)} of output · cache miss ${percent(row.cache_miss_input_share)}`)
  }
  const restaged = record.restages
  if (restaged) {
    const list = tallied => Object.entries(tallied).map(([key, count]) => `${key} ${count}`).join(', ') || 'none'
    const size = (stats, unit) => (stats ? `${unit} min ${thousands(stats.min)} · p50 ${thousands(stats.p50)} · max ${thousands(stats.max)} · total ${thousands(stats.total)}` : `${unit} —`)
    lines.push('', 'Restages (delegation):')
    lines.push(`- restages: ${restaged.count} · by checkpoint: ${list(restaged.by_checkpoint)} · by role: ${list(restaged.by_role)} · stale replies dropped: ${restaged.stale_replies_dropped}`)
    lines.push(`- packet ${size(restaged.packet_chars, 'chars')}`)
    lines.push(`- packet ${size(restaged.packet_estimated_tokens, 'est. tokens')}`)
  }
  const v = record.verbosity
  lines.push('', 'Chat verbosity:')
  lines.push(`- plans with a chat message: ${v.plans_with_chat} of ${v.plans}`)
  lines.push(`- tool-call responses with assistant content: ${v.tool_call_responses_with_content} of ${v.tool_call_responses}`)
  lines.push(`- responses with any content: ${v.responses_with_content} of ${v.responses}`)
  lines.push(`- request.completed with chat: ${v.completed_with_chat} of ${v.completed}`)
  const time = record.time
  lines.push('', 'Time estimates (2.6):')
  lines.push(`- batches estimated: ${time.estimates.length} (${time.estimates.filter(item => item.long).length} long) · reviews asked: ${time.reviews.filter(item => item.kind === 'requested').length} · answered: ${time.reviews.filter(item => item.kind === 'answered').map(item => item.decision).join(', ') || 'none'}`)
  for (const item of time.measured) lines.push(`- ${item.goal_id}/${item.step_id}: estimate ${duration(item.expected_seconds)} · took ${duration(item.elapsed_wall_seconds)} (${printable(item.ratio)}x the estimate; walking and overhead are the difference)`)
  if (time.goal_warnings.length > 0) lines.push(`- goal budget warnings: ${time.goal_warnings.map(item => `${item.goal_id} at ${thousands(item.output_units)} out`).join('; ')}`)
  return lines.join('\n')
}

async function readPromptTrace(filename) {
  const fsp = await import('node:fs/promises')
  try {
    const text = await fsp.readFile(filename, 'utf8')
    return parseJsonl(text)
  }
  catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], errors: [{ file: filename, error: 'not found' }] }
    throw error
  }
}

// One command for a run record: the prompt trace gives think time per round,
// the behavior trace (by default the sgluna-behavior.jsonl next to it) gives
// spend, waste, verbosity and the time split.
export async function generateThinkTimeReport({ promptFile, behaviorFile, pricesFile } = {}) {
  const filename = promptFile ? path.resolve(promptFile) : path.resolve(process.cwd(), 'logs', 'sgluna-prompts.jsonl')
  const { rows, errors } = await readPromptTrace(filename)
  const behavior = behaviorFile ? path.resolve(behaviorFile) : path.join(path.dirname(filename), 'sgluna-behavior.jsonl')
  const behaviorTrace = await readPromptTrace(behavior)
  let prices
  if (pricesFile) {
    const fsp = await import('node:fs/promises')
    prices = parsePriceTable(JSON.parse(await fsp.readFile(path.resolve(pricesFile), 'utf8')))
  }
  const behaviorFound = !behaviorTrace.errors.some(error => error.error === 'not found')
  return {
    report: buildThinkTimeReport(rows),
    prefix_report: buildPrefixReport(rows),
    run_record: behaviorFound ? buildRunRecord(behaviorTrace.rows, { prices }) : undefined,
    parse_errors: errors,
    behavior_parse_errors: behaviorFound ? behaviorTrace.errors : [],
    file: filename,
    behavior_file: behaviorFound ? behavior : undefined,
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const behaviorFile = optionValue(args, '--behavior')
  const pricesFile = optionValue(args, '--prices')
  const positionals = args.filter((arg, index) => arg !== '--json'
    && !['--behavior', '--prices'].includes(arg)
    && !['--behavior', '--prices'].includes(args[index - 1]))
  const result = await generateThinkTimeReport({ promptFile: positionals[0], behaviorFile, pricesFile })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(formatThinkTimeReport(result.report))
    console.log(`
${formatPrefixReport(result.prefix_report)}`)
    if (result.parse_errors.length > 0) console.log(`\nJSONL parse warnings: ${result.parse_errors.length}`)
    if (result.run_record) {
      console.log(`\n${formatRunRecord(result.run_record)}`)
      if (result.behavior_parse_errors.length > 0) console.log(`\nBehavior JSONL parse warnings: ${result.behavior_parse_errors.length}`)
    }
    else console.log('\nNo behavior trace found (pass --behavior <sgluna-behavior.jsonl> for the run record).')
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(error => {
  console.error(`SGLuna think-time report failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
