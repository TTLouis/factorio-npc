import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'

// Scans a sgluna-behavior.jsonl trace for known failure signatures and lists
// them per request_id with a count and first-seen timestamp. This never
// mutates or replays anything -- it is a read-only log check, grounded in
// event names/fields that are really emitted by the runtime (each detector
// below cites the emitter file:line it is reading). Every helper here treats
// the parsed JSONL rows as one already-happened trace, not live game state.
//
// Signature list (plan item 2.11, group H):
// - observation_phase_closed_loop: recovery.classified retries with
//   reason_code 'observation_phase_closed'
//   (npc-agent-loop.mjs:6140-6147 recoveryDiagnostic call site;
//   npc-agent-loop.mjs:6366-6377 recoveryDiagnostic -> traceEvent('recovery.classified', ...)).
// - provider_turn_output_cap_exceeded: the provider budget error thrown at
//   npc-agent-loop.mjs:5703-5706 (`capError.code = 'provider_turn_output_cap_exceeded'`),
//   observed on provider.error/request.failed `data.message`.
// - invalid_tool_batch_repeated: recovery.classified retries with
//   reason_code 'invalid_tool_batch' (same recoveryDiagnostic plumbing as above;
//   the reason code itself comes from the historical
//   staging/npc-agent-loop.mjs:630 ToolValidationError and is still present
//   verbatim in the real trace, e.g. data/logs/sgluna-behavior.jsonl request
//   req_muizw6hg_2).
// - goal_paused_no_chat: a request whose task_board snapshot
//   (`data.task_board.status === 'paused'`, e.g. the shape traced at
//   npc-agent-loop.mjs:4837-4842/4943-4944 `request.completed`/`request.waiting`
//   payloads, and set by CanonicalTaskBoardMemory#pausePlan) never carries a
//   non-empty `data.chat_message` anywhere in the same request -- the silent
//   auto-pause class (pausePersistentPlan() call sites in npc-agent-loop.mjs
//   and supervisor.mjs never call traceEvent or printChat themselves).
// - zero_cached_input: the request's terminal usage summary
//   (`data.usage`, accumulated by accumulateProviderUsage() at
//   npc-agent-loop.mjs:1481-1503 from normalizedProviderUsage() at
//   npc-agent-loop.mjs:1431-1460) has `input_units > 0` and
//   `cached_input_units === 0`.
// - no_chat_reply: the request's terminal event is `request.failed` (which
//   never carries a `chat_message` field -- see the request.failed payload
//   built at npc-agent-loop.mjs:5066 and around) or `request.completed` with
//   an empty/whitespace `data.chat_message`.
// - blocked_before_mutation: `request.completed` with
//   `data.outcome === 'blocked_before_mutation'`
//   (npc-agent-loop.mjs:4836-4842).
// - stale_step_tracker_behind_batch: a step stays active while a
//   `factorio.status` event (npc-agent-loop.mjs:5104-5108,
//   `data.task_status.last_completed_batch.batch_id`) reports a batch that
//   never shows up in that step's `operation_receipt`/`deterministic_verification`
//   evidence (batch id embedded in the evidence `summary` JSON written at
//   canonical-task-board-memory.mjs:1594-1603) before the request ends. This
//   is the exact regression the comment at npc-agent-loop.mjs:5101-5103 names
//   ("leave Plan Tracker one step behind"); the check re-detects it if it
//   ever comes back.

const LOOP_MIN_COUNT = 2

function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function toMs(ts) {
  if (typeof ts !== 'string') return undefined
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : undefined
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Bad/partial rows (a truncated last line, a non-JSON row) are tolerated:
// parseJsonl() already skips them into `errors` instead of throwing, and every
// detector below treats a missing/malformed field as "no evidence", not a crash.
function sortRows(rows) {
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ta = toMs(a.row?.ts) ?? 0
      const tb = toMs(b.row?.ts) ?? 0
      if (ta !== tb) return ta - tb
      const sa = safeInteger(a.row?.seq)
      const sb = safeInteger(b.row?.seq)
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb
      return a.index - b.index
    })
    .map(entry => entry.row)
}

function filterSince(rows, sinceMs) {
  if (sinceMs === undefined) return rows
  return rows.filter((row) => {
    const ms = toMs(row?.ts)
    return ms === undefined || ms >= sinceMs
  })
}

function groupByRequestId(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = nonEmptyString(row?.request_id)
    if (!id) continue
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(row)
  }
  return map
}

function firstTsOf(rows) {
  for (const row of rows) {
    const ts = nonEmptyString(row?.ts)
    if (ts) return ts
  }
  return undefined
}

// --- individual detectors -------------------------------------------------
// Each returns a finding ({ count, first_ts, detail }) or undefined.

function detectReasonCodeLoop(rows, reasonCode) {
  const matches = rows.filter(row => row?.event === 'recovery.classified' && row?.data?.reason_code === reasonCode)
  if (matches.length < LOOP_MIN_COUNT) return undefined
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: `reason_code=${reasonCode} retried ${matches.length} times (retry_limit seen: ${matches.map(m => m?.data?.retry_limit).find(v => v !== undefined) ?? 'n/a'})`,
  }
}

function detectProviderTurnOutputCapExceeded(rows) {
  const pattern = /provider_turn_output_cap_exceeded/
  const matches = rows.filter(row =>
    (row?.event === 'provider.error' || row?.event === 'request.failed')
    && typeof row?.data?.message === 'string'
    && pattern.test(row.data.message))
  if (matches.length === 0) return undefined
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: matches[0]?.data?.message ?? 'provider_turn_output_cap_exceeded',
  }
}

function detectBlockedBeforeMutation(rows) {
  const matches = rows.filter(row => row?.event === 'request.completed' && row?.data?.outcome === 'blocked_before_mutation')
  if (matches.length === 0) return undefined
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: nonEmptyString(matches[0]?.data?.blocker?.reason) ?? 'blocked_before_mutation',
  }
}

function terminalEvent(rows) {
  // Walk from the end: the last request.completed/request.failed row is the
  // one true terminal outcome for this request (request.superseded/.cancelled
  // are not terminal outcomes in this sense -- the request kept going or was
  // replaced, it did not finish).
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row?.event === 'request.completed' || row?.event === 'request.failed') return row
  }
  return undefined
}

function detectZeroCachedInput(rows) {
  const terminal = terminalEvent(rows)
  const usage = terminal?.data?.usage
  if (!isPlainObject(usage)) return undefined
  const input = safeInteger(usage.input_units)
  const cached = safeInteger(usage.cached_input_units)
  if (input === undefined || cached === undefined) return undefined
  if (!(input > 0 && cached === 0)) return undefined
  return {
    count: 1,
    first_ts: nonEmptyString(terminal?.ts),
    detail: `${terminal.event}: input_units=${input}, cached_input_units=0`,
  }
}

function detectNoChatReply(rows) {
  const terminal = terminalEvent(rows)
  if (!terminal) return undefined
  if (terminal.event === 'request.failed') {
    return {
      count: 1,
      first_ts: nonEmptyString(terminal?.ts),
      detail: 'request.failed carries no chat_message field',
    }
  }
  if (terminal.event === 'request.completed' && !nonEmptyString(terminal?.data?.chat_message)) {
    return {
      count: 1,
      first_ts: nonEmptyString(terminal?.ts),
      detail: 'request.completed with an empty chat_message',
    }
  }
  return undefined
}

function detectGoalPausedNoChat(rows) {
  const pausedRows = rows.filter(row => row?.data?.task_board?.status === 'paused')
  if (pausedRows.length === 0) return undefined
  const hasChat = rows.some(row => nonEmptyString(row?.data?.chat_message))
  if (hasChat) return undefined
  return {
    count: pausedRows.length,
    first_ts: firstTsOf(pausedRows),
    detail: nonEmptyString(pausedRows[0]?.data?.task_board?.pause_reason) ?? 'task_board.status=paused with no chat_message anywhere in the request',
  }
}

function parseEvidenceBatchId(evidence) {
  if (!isPlainObject(evidence) || typeof evidence.summary !== 'string') return undefined
  if (evidence.kind !== 'operation_receipt' && evidence.kind !== 'deterministic_verification') return undefined
  try {
    const parsed = JSON.parse(evidence.summary)
    return safeInteger(parsed?.batch_id)
  }
  catch {
    return undefined
  }
}

function detectStaleStepTrackerBehindBatch(rows) {
  let activeStepId
  // step_id -> Set(batch_id) reported by factorio.status while that step was
  // active, and not yet matched by evidence recorded against that same step.
  const pendingByStep = new Map()
  const firstSeenTsByStep = new Map()
  const stepStatusById = new Map()

  const resolve = (stepId, batchId) => {
    const set = pendingByStep.get(stepId)
    if (set) set.delete(batchId)
  }

  for (const row of rows) {
    if (row?.event === 'factorio.status') {
      const batchId = safeInteger(row?.data?.task_status?.last_completed_batch?.batch_id)
      if (batchId !== undefined && activeStepId !== undefined) {
        if (!pendingByStep.has(activeStepId)) pendingByStep.set(activeStepId, new Set())
        pendingByStep.get(activeStepId).add(batchId)
        const key = `${activeStepId}:${batchId}`
        if (!firstSeenTsByStep.has(key)) firstSeenTsByStep.set(key, nonEmptyString(row?.ts))
      }
    }

    const board = row?.data?.task_board
    if (isPlainObject(board) && Array.isArray(board.steps)) {
      activeStepId = nonEmptyString(board.active_step_id) ?? activeStepId
      for (const step of board.steps) {
        if (!isPlainObject(step) || typeof step.id !== 'string') continue
        stepStatusById.set(step.id, step.status)
        if (step.status === 'completed') pendingByStep.delete(step.id)
      }
      for (const evidence of Array.isArray(board.evidence) ? board.evidence : []) {
        const stepId = nonEmptyString(evidence?.step_id)
        const batchId = parseEvidenceBatchId(evidence)
        if (stepId && batchId !== undefined) resolve(stepId, batchId)
      }
    }
  }

  const stale = []
  for (const [stepId, batchSet] of pendingByStep) {
    if (batchSet.size === 0) continue
    if (stepStatusById.get(stepId) === 'completed') continue
    for (const batchId of batchSet) {
      stale.push({ stepId, batchId, ts: firstSeenTsByStep.get(`${stepId}:${batchId}`) })
    }
  }
  if (stale.length === 0) return undefined
  stale.sort((a, b) => (toMs(a.ts) ?? 0) - (toMs(b.ts) ?? 0))
  return {
    count: stale.length,
    first_ts: stale[0]?.ts,
    detail: `step ${stale[0]?.stepId} still active/unverified after factorio.status reported completed batch_id=${stale[0]?.batchId}`,
  }
}

const SIGNATURES = [
  {
    id: 'observation_phase_closed_loop',
    label: 'observation_phase_closed loop',
    detect: rows => detectReasonCodeLoop(rows, 'observation_phase_closed'),
  },
  {
    id: 'provider_turn_output_cap_exceeded',
    label: 'provider_turn_output_cap_exceeded',
    detect: detectProviderTurnOutputCapExceeded,
  },
  {
    id: 'invalid_tool_batch_repeated',
    label: 'invalid_tool_batch repeated',
    detect: rows => detectReasonCodeLoop(rows, 'invalid_tool_batch'),
  },
  {
    id: 'goal_paused_no_chat',
    label: 'goal paused with no chat line',
    detect: detectGoalPausedNoChat,
  },
  {
    id: 'zero_cached_input',
    label: 'zero cached input across a request',
    detect: detectZeroCachedInput,
  },
  {
    id: 'no_chat_reply',
    label: 'request with no chat reply',
    detect: detectNoChatReply,
  },
  {
    id: 'blocked_before_mutation',
    label: 'blocked_before_mutation',
    detect: detectBlockedBeforeMutation,
  },
  {
    id: 'stale_step_tracker_behind_batch',
    label: 'stale step (tracker behind the batch)',
    detect: detectStaleStepTrackerBehindBatch,
  },
]

export function analyzeBehaviorTrace(rows, { since } = {}) {
  const sinceMs = typeof since === 'string' && since.length > 0 ? toMs(since) : undefined
  if (typeof since === 'string' && since.length > 0 && sinceMs === undefined) {
    throw new UsageError(`--since value is not a parseable timestamp: ${since}`)
  }
  const sorted = sortRows(Array.isArray(rows) ? rows : [])
  const scoped = filterSince(sorted, sinceMs)
  const byRequest = groupByRequestId(scoped)

  const findings = []
  for (const [requestId, requestRows] of byRequest) {
    for (const signature of SIGNATURES) {
      const finding = signature.detect(requestRows)
      if (!finding) continue
      findings.push({
        signature: signature.id,
        label: signature.label,
        request_id: requestId,
        count: finding.count,
        first_ts: finding.first_ts,
        detail: finding.detail,
      })
    }
  }
  findings.sort((a, b) => {
    const ta = toMs(a.first_ts) ?? 0
    const tb = toMs(b.first_ts) ?? 0
    if (ta !== tb) return ta - tb
    if (a.request_id !== b.request_id) return a.request_id < b.request_id ? -1 : 1
    return a.signature < b.signature ? -1 : (a.signature > b.signature ? 1 : 0)
  })

  return {
    findings,
    request_count: byRequest.size,
    row_count: scoped.length,
    since: sinceMs !== undefined ? new Date(sinceMs).toISOString() : undefined,
  }
}

export class UsageError extends Error {}

function printable(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value)
}

export function formatCheckReport(result, { parseErrorCount = 0 } = {}) {
  const lines = [
    'SGLuna run-check',
    `requests scanned: ${result.request_count} · rows scanned: ${result.row_count}${result.since ? ` · since ${result.since}` : ''}`,
  ]
  if (result.findings.length === 0) {
    lines.push('', 'No known failure signatures found.')
  }
  else {
    lines.push('', `${result.findings.length} finding(s):`)
    for (const finding of result.findings) {
      lines.push(`- [${finding.signature}] request_id=${finding.request_id} count=${finding.count} first_ts=${printable(finding.first_ts)} :: ${finding.detail}`)
    }
  }
  if (parseErrorCount > 0) lines.push('', `JSONL parse warnings: ${parseErrorCount} (bad lines were skipped, not treated as failures)`)
  return lines.join('\n')
}

export async function runCheck({ behaviorFile, since } = {}) {
  const fsp = await import('node:fs/promises')
  const filename = path.resolve(behaviorFile)
  let text
  try {
    text = await fsp.readFile(filename, 'utf8')
  }
  catch (error) {
    if (error?.code === 'ENOENT') throw new UsageError(`behavior trace not found: ${filename}`)
    throw error
  }
  const { rows, errors } = parseJsonl(text)
  const result = analyzeBehaviorTrace(rows, { since })
  return { result, parse_errors: errors, file: filename }
}

function parseArgs(argv) {
  const json = argv.includes('--json')
  const positionals = argv.filter(arg => arg !== '--json')
  if (positionals.length < 1 || positionals.length > 2) {
    throw new UsageError('usage: run-check.mjs <behavior.jsonl> [since] [--json]')
  }
  return { behaviorFile: positionals[0], since: positionals[1], json }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  }
  catch (error) {
    console.error(error instanceof UsageError ? error.message : String(error))
    process.exitCode = 2
    return
  }

  let outcome
  try {
    outcome = await runCheck({ behaviorFile: args.behaviorFile, since: args.since })
  }
  catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    console.error(`SGLuna run-check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }

  if (args.json) {
    console.log(JSON.stringify({ ...outcome.result, parse_errors: outcome.parse_errors, file: outcome.file }, null, 2))
  }
  else {
    console.log(formatCheckReport(outcome.result, { parseErrorCount: outcome.parse_errors.length }))
  }
  process.exitCode = outcome.result.findings.length > 0 ? 1 : 0
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((error) => {
    console.error(`SGLuna run-check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  })
}
