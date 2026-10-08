import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonl } from './debug-report.mjs'
import { HANDOFF_PACKET_LIMITS } from './handoff-packet.mjs'
import { CONTEXT_RESTAGE_CHECKPOINTS, CONTEXT_RESTAGE_ROLES } from './planning-state.mjs'
import { estimateTokensFromChars } from './restage-policy.mjs'

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
// - semantic_contract_dead_end: a delegated semantic assessment rejects a
//   mutation (`recovery.classified.reason_code=semantic_step_cannot_mutate`)
//   and the same executor ends in a provider_reported_blocker pause without
//   admission, receipt or step progress. Reads plan.delegation_committed,
//   context.restaged, provider.response, goal.paused and request.completed
//   from npc-agent-loop.mjs; diagnoses the correlated outcome, not prose intent.
// - stale_step_tracker_behind_batch: a step stays active while a
//   `factorio.status` event (npc-agent-loop.mjs:5104-5108,
//   `data.task_status.last_completed_batch.batch_id`) reports a batch that
//   never shows up in that step's `operation_receipt`/`deterministic_verification`
//   evidence (batch id embedded in the evidence `summary` JSON written at
//   canonical-task-board-memory.mjs:1594-1603) before the request ends. This
//   is the exact regression the comment at npc-agent-loop.mjs:5101-5103 names
//   ("leave Plan Tracker one step behind"); the check re-detects it if it
//   ever comes back.

// - restage_loop, restage_packet_oversize, stale_reply_not_dropped: delegation
//   (plan item U9, design note NPC_DELEGATION_DESIGN_2026-09-29.md sections 4
//   and 10). They read the trace rows the restage emitter (U4) is expected to
//   write; see DELEGATION_TRACE_ROWS below for the exact shapes. Nothing emits
//   them yet, so on every current trace these three signatures find nothing.

// - jev_family_demoted, jev_deciding_skip_unverified: Jev at the delegation checkpoints (unit U11, design
//   note sections 7 and 12f). They read the judgment-ledger rows (JEV_TRACE_ROWS below): a judgment family whose
//   rolling agreement fell under 90% and was demoted to shadow, and a judgment that ACTED (a deciding route
//   that skipped a wake) whose outcome disagreed, meaning the step it skipped the wake for did not verify on
//   its first batch.

const LOOP_MIN_COUNT = 2

/**
 * Trace rows the U11 judgment ledger writes (jev-checkpoints.mjs). Every one carries `request_id` (envelope and
 * `data.request_id`) and a `reason`, except jev.stage_clamped_on_restore, which is written at restore with no
 * request open.
 *
 * - `jev.judgment_recorded`: family, judgment_id, stage (shadow | advisory | deciding), acted (the judgment changed
 *   behavior), jev_choice, jev_confidence, alternative (what the deterministic code or the LLM does instead),
 *   goal_id, plan_id, step_id, checkpoint, saving_estimate.
 * - `jev.judgment_scored`: the outcome scored it. agreed, acted, realized (a saving that really happened, not a
 *   would-have), saving {wakes, tokens, calls}, outcome {...bounded facts}, stage (the family's stage after this
 *   judgment), scored_total, rolling_agreement, ledger {scored, agreement, stage, would_save, saved,
 *   removal_candidate}.
 * - `jev.stage_changed`: family, from, to, direction (promoted | demoted), reason, agreement, evidence.
 * - `jev.judgment_skipped` (Jev unavailable, fell back, or degraded: never counted as agreement) and
 *   `jev.judgment_unscored` (abandoned before an outcome).
 * - `c4.next_step_clear`, `c4.route_applied` (mode shadow | deciding), `c4.wake_measured` (tokens of the wake that ran).
 */
export const JEV_TRACE_ROWS = Object.freeze({
  events: Object.freeze({
    recorded: 'jev.judgment_recorded',
    scored: 'jev.judgment_scored',
    stageChanged: 'jev.stage_changed',
    skipped: 'jev.judgment_skipped',
    unscored: 'jev.judgment_unscored',
    clamped: 'jev.stage_clamped_on_restore',
    c4Clear: 'c4.next_step_clear',
    c4Route: 'c4.route_applied',
    c4Wake: 'c4.wake_measured',
  }),
  c4Family: 'c4_next_step',
})

/**
 * Trace rows the delegation emitter (U4) must write so run-check and the run
 * record (think-time-report.mjs) can read them. `row` is the envelope every
 * behavior row already has: { schema, ts, seq, event, request_id, turn,
 * actor_id, epoch, data }. A row without a request_id is ignored by every
 * detector here, like every other detector in this file.
 *
 * - `context.restaged`: one row per restage, written when the fresh
 *   conversation is created. `role`/`checkpoint` are the reducer's
 *   (CONTEXT_RESTAGE_ROLES / CONTEXT_RESTAGE_CHECKPOINTS). `handoff_id`,
 *   `packet_hash`, `packet_chars` come straight from buildHandoffPacket().
 *   `packet_estimated_tokens` is the packet's estimated_tokens.
 *   `plan_id`/`step_id` are the active plan and step at the restage (step_id
 *   may be absent when no step is active). `soft_limit_tokens` is the optional
 *   restage-policy soft limit that applied to this role.
 * - `provider.request`, `provider.response`, `provider.error` (existing
 *   events): gain `data.role` and `data.handoff_id` naming the conversation
 *   that issued the round. Both fields, or neither (today's rows).
 * - `context.stale_reply_dropped`: written when a reply from a discarded
 *   conversation (handoff_id no longer active for its role, or actor epoch
 *   changed) is dropped instead of applied. `handoff_id` and `role` are the
 *   stale reply's; `active_handoff_id` is the current one for that role.
 *   It may be written before or after the stale provider.response row, but in
 *   the same request_id.
 * - `context.restage_refused`: written when restageContext declines (a provider
 *   round is in flight or open, the packet's plan is not the active plan, the
 *   reducer refused the event). `reason` is the machine code; no detector
 *   reads it yet, it is for the record. Like `context.restaged`, a row written
 *   while no request is open has no request_id unless the caller passes one,
 *   and every detector here ignores such a row.
 * - Step progress rows that reset the restage-loop count are the existing
 *   `step.verified` and `step.semantic_completed`.
 */
export const DELEGATION_TRACE_ROWS = Object.freeze({
  events: Object.freeze({
    restaged: 'context.restaged',
    staleReplyDropped: 'context.stale_reply_dropped',
    restageRefused: 'context.restage_refused',
    replyEvents: Object.freeze(['provider.response', 'provider.error']),
    progressEvents: Object.freeze(['step.verified', 'step.semantic_completed']),
  }),
  examples: Object.freeze({
    restaged: Object.freeze({
      event: 'context.restaged',
      request_id: 'req_x_1',
      data: Object.freeze({
        role: 'executor',
        checkpoint: 'C3',
        handoff_id: 'ho_0123456789ab',
        packet_hash: '9f2c41d07a3be518',
        packet_chars: 3412,
        packet_estimated_tokens: 853,
        previous_context_chars: 88120,
        reason: 'executor_fresh_at_plan_commit',
        plan_id: 'plan_1',
        step_id: 'step_1',
        soft_limit_tokens: 100000,
      }),
    }),
    restageRefused: Object.freeze({
      event: 'context.restage_refused',
      request_id: 'req_x_1',
      data: Object.freeze({ role: 'executor', checkpoint: 'C3', handoff_id: 'ho_0123456789ab', reason: 'round_in_flight' }),
    }),
    providerReply: Object.freeze({
      event: 'provider.response',
      request_id: 'req_x_1',
      data: Object.freeze({ role: 'executor', handoff_id: 'ho_0123456789ab' }),
    }),
    staleReplyDropped: Object.freeze({
      event: 'context.stale_reply_dropped',
      request_id: 'req_x_1',
      data: Object.freeze({ role: 'executor', handoff_id: 'ho_stale00000ab', active_handoff_id: 'ho_0123456789ab', reason: 'handoff_superseded' }),
    }),
  }),
})

/**
 * Restage loop: this many `context.restaged` rows for the same role, plan and
 * step with no step.verified / step.semantic_completed between them. Three,
 * not two: C5 legitimately restages the same step once after a generation-cap
 * pause and a Resume can add one more; a third with nothing verified is a loop.
 */
export const RESTAGE_LOOP_MIN_COUNT = 3

/**
 * Oversize packet. restage-policy.mjs exports the size counter helpers but no
 * default soft limit (the limit is a parameter of decideRestage), and it
 * measures context growth in provider tokens while the packet reports
 * characters. So a packet is oversize when either (a) its characters exceed
 * HANDOFF_PACKET_LIMITS.maxChars (the builder's own bound; mandatory records
 * alone can push past it), or (b) the row names the role's `soft_limit_tokens`
 * and the packet's tokens exceed it, where packet tokens are
 * `packet_estimated_tokens`, else estimateTokensFromChars(packet_chars) (the
 * same ceil(chars / 4) the size counter uses). A packet larger than the soft
 * limit makes the fresh conversation start over the limit and restage again at
 * the next boundary.
 */
export const PACKET_OVERSIZE_MAX_CHARS = HANDOFF_PACKET_LIMITS.maxChars

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

// A terminal research step whose executor packet lacked research coverage. Legacy packets without the new
// metadata are explicitly distinguished; this finding identifies missing evidence, not the cause of every pause.
function detectExecutorResearchFactsMissing(rows) {
  const terminal = rows.find(row => row.event === 'request.completed'
    && row.data?.task_board?.status === 'paused'
    && row.data?.task_board?.pause_reason?.includes('provider_reported_blocker'))
  if (!terminal) return undefined
  const board = terminal.data.task_board
  const step = board.steps?.[board.active_index ?? 0]
  const subjects = step?.completion_contract?.requirements?.filter(requirement => requirement.kind === 'research_completed').map(requirement => requirement.technology) ?? []
  if (!subjects.length) return undefined
  const carried = rows.filter(row => row.event === 'context.executor_facts_carried').at(-1)
  if (!carried) return undefined
  const missing = carried.data?.missing_research
  if (Array.isArray(missing) && missing.length === 0 && carried.data?.research_paths > 0) return undefined
  return { count: 1, first_ts: carried.ts, detail: Array.isArray(missing)
    ? `research step paused with unavailable executor facts: ${missing.join(', ')}`
    : `legacy executor packet has no research coverage metadata for: ${subjects.join(', ')}` }
}

// Narrow historical contract dead end, not every semantic mutation refusal. The
// board uses its own step ids; the C3 handoff uses immutable reducer step ids.
// Correlate each in its own vocabulary instead of comparing those unlike ids.
function detectSemanticContractDeadEnd(rows) {
  const terminal = terminalEvent(rows)
  const board = terminal?.data?.task_board
  const pauseReason = 'recoverable_provider_failure:provider_reported_blocker'
  if (terminal?.event !== 'request.completed'
    || terminal.data?.outcome !== 'recoverable_provider_failure'
    || board?.status !== 'paused' || board.pause_reason !== pauseReason) return undefined
  const step = Array.isArray(board.steps) ? board.steps.find(step => step?.id === board.active_step_id) : undefined
  if (step?.completion_mode !== 'semantic' || step.completion_contract != null) return undefined

  const terminalIndex = rows.lastIndexOf(terminal)
  const commitIndex = rows.findLastIndex((row, index) => index < terminalIndex
    && row?.event === 'plan.delegation_committed'
    && nonEmptyString(row.data?.plan_id) && nonEmptyString(row.data?.step_id))
  if (commitIndex < 0) return undefined
  const commit = rows[commitIndex]
  // A replacement actor/epoch or malformed ownership must not join this chain.
  if (safeInteger(commit.actor_id) === undefined || safeInteger(commit.epoch) === undefined) return undefined
  const sameOwner = row => row?.actor_id === commit.actor_id && row?.epoch === commit.epoch
  if (!sameOwner(terminal)) return undefined
  const window = rows.slice(commitIndex + 1, terminalIndex).filter(sameOwner)
  const progress = row => (['operations.admit', 'operations.ack'].includes(row.event)
      && Array.isArray(row.data?.operations) && row.data.operations.length > 0)
    || (['step.verified', 'step.semantic_completed'].includes(row.event) && nonEmptyString(row.data?.active_step_id))
    || (row.event === 'factorio.status' && safeInteger(row.data?.task_status?.last_completed_batch?.batch_id) > 0)
    || (row.event === 'request.time_split' && safeInteger(row.data?.batches) > 0)
  if (window.some(progress)) return undefined

  const pausedIndex = window.findLastIndex(row => row.event === 'goal.paused'
    && row.data?.pause_reason === pauseReason
    && row.data?.goal_id === board.goal_id && nonEmptyString(board.goal_id)
    && row.data?.active_step_id === board.active_step_id)
  if (pausedIndex < 0) return undefined
  const rejectedIndex = window.findLastIndex((row, index) => index < pausedIndex
    && row.event === 'recovery.classified' && row.data?.reason_code === 'semantic_step_cannot_mutate')
  if (rejectedIndex < 0) return undefined
  const handoffIndex = window.findLastIndex((row, index) => index < rejectedIndex
    && row.event === 'context.restaged' && row.data?.role === 'executor' && row.data?.checkpoint === 'C3'
    && row.data?.plan_id === commit.data.plan_id && row.data?.step_id === commit.data.step_id
    && nonEmptyString(row.data?.handoff_id))
  if (handoffIndex < 0) return undefined
  const handoffId = window[handoffIndex].data.handoff_id
  const reply = window.slice(handoffIndex + 1, rejectedIndex).findLast(row => row.event === 'provider.response')
  if (reply?.data?.role !== 'executor' || reply.data.handoff_id !== handoffId) return undefined
  return {
    count: 1,
    first_ts: nonEmptyString(window[rejectedIndex].ts),
    detail: `plan_id=${commit.data.plan_id} step_id=${commit.data.step_id}: reason_code=semantic_step_cannot_mutate followed by pause_reason=${pauseReason} without admission, receipt or step progress`,
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
    // The supervisor traces the "Request failed: ..." line it printed to the
    // player after the failure; that counts as the chat reply.
    const failedAt = rows.lastIndexOf(terminal)
    if (rows.slice(failedAt + 1).some(row => row?.event === 'chat.request_failed_reported')) return undefined
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

// A request that ends in request.failed with recoverable=false stops the run with no repair path: the loop reset itself
// and the goal is left for the supervisor's stranded-plan pause. Emitted by runGuardedTurn (npc-agent-loop.mjs).
function detectUnrecoverableRequestFailure(rows) {
  const terminal = terminalEvent(rows)
  if (terminal?.event !== 'request.failed' || terminal?.data?.recoverable !== false) return undefined
  return {
    count: 1,
    first_ts: nonEmptyString(terminal?.ts),
    detail: `request.failed recoverable=false (stage ${nonEmptyString(terminal?.data?.stage) ?? 'n/a'}): ${nonEmptyString(terminal?.data?.message) ?? 'no message'}`,
  }
}

// An executor reply whose operations named a step that is not the committed active one (executor.stale_step_rejected,
// npc-agent-loop.mjs enforceExecutorContract). Each is corrected up to a bounded allowance, so any occurrence is worth seeing.
function detectExecutorStaleStepRejected(rows) {
  const matches = rows.filter(row => row?.event === 'executor.stale_step_rejected')
  if (matches.length === 0) return undefined
  const first = matches[0].data ?? {}
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: `executor operations named a step other than the active one (${nonEmptyString(first.reason) ?? 'stale step'}; incoming index ${first.incoming_step_index ?? 'n/a'}${nonEmptyString(first.incoming_step_id) ? `, id ${first.incoming_step_id}` : ''}; expected ${nonEmptyString(first.expected_step?.stepId) ?? 'n/a'})`,
  }
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

// --- delegation detectors (U9) -----------------------------------------------

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRestageRow(row) {
  return row?.event === DELEGATION_TRACE_ROWS.events.restaged
    && CONTEXT_RESTAGE_ROLES.includes(row?.data?.role)
    && CONTEXT_RESTAGE_CHECKPOINTS.includes(row?.data?.checkpoint)
}

function detectOversizePacket(rows) {
  const over = []
  for (const row of rows) {
    if (!isRestageRow(row)) continue
    const chars = finiteNumber(row.data.packet_chars)
    const tokens = finiteNumber(row.data.packet_estimated_tokens) ?? (chars !== undefined ? estimateTokensFromChars(chars) : undefined)
    const softLimit = finiteNumber(row.data.soft_limit_tokens)
    if (chars !== undefined && chars > PACKET_OVERSIZE_MAX_CHARS) {
      over.push({ row, why: `${chars} chars > ${PACKET_OVERSIZE_MAX_CHARS} char packet limit` })
    }
    else if (tokens !== undefined && softLimit !== undefined && softLimit > 0 && tokens > softLimit) {
      over.push({ row, why: `~${tokens} tokens > ${softLimit} token soft limit` })
    }
  }
  if (over.length === 0) return undefined
  const first = over[0].row.data
  return {
    count: over.length,
    first_ts: firstTsOf(over.map(item => item.row)),
    detail: `${first.role} ${first.checkpoint} packet ${first.handoff_id ?? '(no handoff_id)'}: ${over[0].why}${over.length > 1 ? ` (+${over.length - 1} more)` : ''}`,
  }
}

// Trace-scoped detectors see every request at once: a restage loop and a
// stale reply both cross request boundaries (a plan step outlives a request;
// a discarded conversation's reply can land in the next one). They return an
// array of findings, each carrying its own request_id.

function detectRestageLoops(rows) {
  const progress = new Set(DELEGATION_TRACE_ROWS.events.progressEvents)
  const runs = new Map()
  const findings = []
  const flush = () => {
    for (const run of runs.values()) {
      if (run.count < RESTAGE_LOOP_MIN_COUNT) continue
      findings.push({
        request_id: run.request_id,
        count: run.count,
        first_ts: run.first_ts,
        detail: `${run.role} restaged ${run.count} times for plan ${run.plan_id || '(none)'} step ${run.step_id || '(none)'} with no step verified in between (checkpoints ${run.checkpoints.join(',')}; loop threshold ${RESTAGE_LOOP_MIN_COUNT})`,
      })
    }
    runs.clear()
  }
  for (const row of rows) {
    if (progress.has(row?.event)) {
      flush()
      continue
    }
    if (!isRestageRow(row)) continue
    const { role, plan_id: planId, step_id: stepId, checkpoint } = row.data
    const key = `${role}|${planId ?? ''}|${stepId ?? ''}`
    const run = runs.get(key) ?? { request_id: row.request_id, first_ts: nonEmptyString(row.ts), role, plan_id: planId, step_id: stepId, count: 0, checkpoints: [] }
    run.count++
    run.checkpoints.push(checkpoint)
    runs.set(key, run)
  }
  flush()
  return findings
}

// `all` is every request-bearing row (the active handoff per role is state
// carried across the whole trace); `inScope` is the subset a `since` cutoff
// keeps. A reply is stale when its role already has a restage on record and
// the reply's handoff_id is not the latest one. It is fine only when a
// context.stale_reply_dropped row in the same request names that handoff_id
// and role. A role with no restage yet, or a reply carrying no role or
// handoff_id (today's rows), is never judged.
function detectStaleRepliesNotDropped(all, inScope) {
  const events = DELEGATION_TRACE_ROWS.events
  const inScopeSet = new Set(inScope)
  const dropped = new Set()
  for (const row of all) {
    if (row?.event === events.staleReplyDropped) dropped.add(`${row.request_id}|${row.data?.role}|${row.data?.handoff_id}`)
  }
  const active = new Map()
  const stale = []
  for (const row of all) {
    if (isRestageRow(row)) {
      if (nonEmptyString(row.data.handoff_id)) active.set(row.data.role, row.data.handoff_id)
      continue
    }
    if (!events.replyEvents.includes(row?.event)) continue
    const role = row.data?.role
    const handoffId = nonEmptyString(row.data?.handoff_id)
    const current = active.get(role)
    if (!handoffId || !current || handoffId === current) continue
    if (dropped.has(`${row.request_id}|${role}|${handoffId}`)) continue
    if (inScopeSet.has(row)) stale.push({ row, role, handoffId, current })
  }
  const byRequest = new Map()
  for (const item of stale) {
    if (!byRequest.has(item.row.request_id)) byRequest.set(item.row.request_id, [])
    byRequest.get(item.row.request_id).push(item)
  }
  return [...byRequest.entries()].map(([requestId, items]) => ({
    request_id: requestId,
    count: items.length,
    first_ts: firstTsOf(items.map(item => item.row)),
    detail: `${items[0].role} reply ${items[0].row.event} carries handoff_id=${items[0].handoffId} but the active ${items[0].role} handoff is ${items[0].current}, and no ${DELEGATION_TRACE_ROWS.events.staleReplyDropped} row followed`,
  }))
}

// A judgment family whose rolling agreement dropped under 90% and was demoted to shadow.
function detectJevFamilyDemoted(rows) {
  const matches = rows.filter(row => row?.event === JEV_TRACE_ROWS.events.stageChanged && row?.data?.direction === 'demoted')
  if (matches.length === 0) return undefined
  const first = matches[0].data
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: `${first.family} demoted ${first.from} -> ${first.to}: ${nonEmptyString(first.reason) ?? 'rolling agreement below threshold'}${matches.length > 1 ? ` (+${matches.length - 1} more)` : ''}`,
  }
}

// A deciding C4 judgment skipped a wake and its outcome disagreed: the step did not verify on its first batch.
function detectJevDecidingSkipUnverified(rows) {
  const matches = rows.filter(row => row?.event === JEV_TRACE_ROWS.events.scored
    && row?.data?.family === JEV_TRACE_ROWS.c4Family
    && row?.data?.acted === true
    && row?.data?.agreed === false)
  if (matches.length === 0) return undefined
  const outcome = matches[0].data.outcome ?? {}
  return {
    count: matches.length,
    first_ts: firstTsOf(matches),
    detail: `deciding route skipped the wake for ${nonEmptyString(matches[0].data.judgment_id) ?? 'a judgment'} but the step did not verify on its first batch (verified=${outcome.step_verified}, failure_boundary=${outcome.had_failure_boundary})${matches.length > 1 ? ` (+${matches.length - 1} more)` : ''}`,
  }
}

const SIGNATURES = [
  { id: 'semantic_contract_dead_end', label: 'delegated semantic contract dead end before gameplay', detect: detectSemanticContractDeadEnd },
  { id: 'executor_research_facts_missing', label: 'paused research step lacks executor research facts', detect: detectExecutorResearchFactsMissing },
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
    id: 'request_failed_unrecoverable',
    label: 'request failed with recoverable=false',
    detect: detectUnrecoverableRequestFailure,
  },
  {
    id: 'executor_stale_step_rejected',
    label: 'executor operations rejected for naming a non-active step',
    detect: detectExecutorStaleStepRejected,
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
  {
    id: 'restage_packet_oversize',
    label: 'restage packet over the size limit',
    detect: detectOversizePacket,
  },
  {
    id: 'jev_family_demoted',
    label: 'Jev judgment family demoted (rolling agreement under 90%)',
    detect: detectJevFamilyDemoted,
  },
  {
    id: 'jev_deciding_skip_unverified',
    label: 'Jev deciding route skipped a wake and the step did not verify on its first batch',
    detect: detectJevDecidingSkipUnverified,
  },
]

// Trace-scoped signatures (see the delegation detectors above).
const TRACE_SIGNATURES = [
  {
    id: 'restage_loop',
    label: 'restage loop (no step progress)',
    detect: (all, inScope) => detectRestageLoops(inScope),
  },
  {
    id: 'stale_reply_not_dropped',
    label: 'stale reply from a discarded conversation was not dropped',
    detect: detectStaleRepliesNotDropped,
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
  const withRequest = row => nonEmptyString(row?.request_id) !== undefined
  const allWithRequest = sorted.filter(withRequest)
  const scopedWithRequest = scoped.filter(withRequest)
  for (const signature of TRACE_SIGNATURES) {
    for (const finding of signature.detect(allWithRequest, scopedWithRequest)) {
      findings.push({
        signature: signature.id,
        label: signature.label,
        request_id: finding.request_id,
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
