import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'

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

export async function generateThinkTimeReport({ promptFile } = {}) {
  const filename = promptFile ? path.resolve(promptFile) : path.resolve(process.cwd(), 'logs', 'sgluna-prompts.jsonl')
  const { rows, errors } = await readPromptTrace(filename)
  return {
    report: buildThinkTimeReport(rows),
    parse_errors: errors,
    file: filename,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const positionals = args.filter(arg => arg !== '--json')
  const result = await generateThinkTimeReport({ promptFile: positionals[0] })
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(formatThinkTimeReport(result.report))
    if (result.parse_errors.length > 0) console.log(`\nJSONL parse warnings: ${result.parse_errors.length}`)
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(error => {
  console.error(`SGLuna think-time report failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
