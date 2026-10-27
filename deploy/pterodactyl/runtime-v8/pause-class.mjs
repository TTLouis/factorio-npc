// Pause classes: what kind of recovery a paused goal gets, declared once by whoever CREATES the pause.
//
// The class travels on the durable run state (`run.pause_class`, `run.pause_subkind`, written by the planning reducer's RUN_PAUSED
// event) so a restart still knows what a pause meant. The supervisor's automatic resume keys on the class and on nothing else:
//   transport          the provider could not be reached or answered with a temporary condition. Waiting fixes it. Subkinds:
//                      budget | rate_limited | server_error | timeout | transport. Backs off and resumes (supervisor.mjs).
//   model_recoverable  the model answered but produced no usable action (action omission exhausted, an unverified blocker rejected,
//                      output budget exhausted without evidence, a second advisory review of one step). A FRESH executor restage
//                      with a rebuilt handoff packet can fix it.
//                      Resumes a bounded number of times (MODEL_RECOVERABLE_RESUME_LIMITS) through interrupted-plan recovery.
//   authority          a person must decide: a question, permission, reserved supplies, a structural blocker that froze the plan.
//   operator           an explicit stop or pause by a person (chat stop, UI pause or follow, terminate).
//   system             the runtime paused itself around a lifecycle event (server stop, actor or session change). These have their
//                      own lifecycle recovery (startup, actor replacement); the auto-resume timer never fires for them.
//   guard              a runtime guard, ceiling or unexplained failure that stopped on purpose (continuation caps, output ceilings,
//                      step identity exhaustion, an unusable goal definition or step contract, a plain request failure). It needs a
//                      player's Resume. Fail closed: widening this to auto-resume is a design decision, not a default.
//
// A pause with a missing or unknown class is not guessed at. It never auto-resumes, and the caller reports it
// (recovery.pause_unclassified) so the producer that forgot to declare a class gets fixed.

export const PAUSE_CLASS = Object.freeze({
  TRANSPORT: 'transport',
  MODEL_RECOVERABLE: 'model_recoverable',
  AUTHORITY: 'authority',
  OPERATOR: 'operator',
  SYSTEM: 'system',
  GUARD: 'guard',
})
export const PAUSE_CLASSES = Object.freeze(Object.values(PAUSE_CLASS))

export const TRANSPORT_SUBKIND = Object.freeze({
  BUDGET: 'budget',
  RATE_LIMITED: 'rate_limited',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  TRANSPORT: 'transport',
})
export const TRANSPORT_SUBKINDS = Object.freeze(Object.values(TRANSPORT_SUBKIND))

// The pause reasons of the runtime's own lifecycle (a graceful server stop, an actor or session replacement). They are class
// system and have their own recovery (startup, actor replacement); that recovery resumes them like an automatic resume does.
export function isLifecycleRecoveryReason(reason) {
  const text = String(reason ?? '')
  return text === 'npc_identity_or_session_changed' || text === 'actor_replaced' || text.startsWith('server_stop_')
}

// Only these classes are ever resumed without a person.
export const AUTO_RESUMABLE_PAUSE_CLASSES = Object.freeze([PAUSE_CLASS.TRANSPORT, PAUSE_CLASS.MODEL_RECOVERABLE])

// owner-delegated 2026-10-13: model_recoverable pauses resume automatically at most this many times, counted in durable plan state.
//   per_step  per step identity (goal_id + plan_id + plan version + step_id), reset only by verified world progress for that step
//             (a batch receipt lands in the step's receipt ledger, or the step verifies and the identity moves on). An admission
//             alone does not count.
//   per_goal  per goal_id in total. Never reset by progress; a new goal starts again at zero.
// Whichever is reached first leaves the plan paused with a UI line (recovery.auto_resume_exhausted, limit_kind step | goal).
export const MODEL_RECOVERABLE_RESUME_LIMITS = Object.freeze({ per_step: 2, per_goal: 6 })

// The wait before a model_recoverable resume fires. No backoff curve: the cause is not load, and the attempts are few.
export const MODEL_RECOVERABLE_RESUME_DELAY_MS = 15_000

export function isPauseClass(value) {
  return typeof value === 'string' && PAUSE_CLASSES.includes(value)
}

export function isAutoResumable(pauseClass) {
  return AUTO_RESUMABLE_PAUSE_CLASSES.includes(pauseClass)
}

// { pause_class, pause_subkind, classified } for a durable run record (or any object carrying the two fields). An undeclared record
// reads as 'guard' (no auto-resume) with classified:false so the caller can report it.
export function pauseClassOf(record) {
  const declared = record?.pause_class
  if (!isPauseClass(declared)) return { pause_class: PAUSE_CLASS.GUARD, pause_subkind: '', classified: false }
  const subkind = declared === PAUSE_CLASS.TRANSPORT && TRANSPORT_SUBKINDS.includes(record?.pause_subkind) ? record.pause_subkind : ''
  return { pause_class: declared, pause_subkind: subkind, classified: true }
}

// The class as it is written on trace rows: the declared class, or 'unclassified' (never silently 'guard').
export function pauseClassLabel(record) {
  const { pause_class: pauseClass, classified } = pauseClassOf(record)
  return classified ? pauseClass : 'unclassified'
}

// --- classifying a failed request -------------------------------------------------------------------------------------------
//
// The class of a pause caused by a failed model request is read from the error, most structured source first:
//   1. error.pause_class (+ error.pause_subkind): declared by whoever raised it.
//   2. Provider transport fields the provider layer sets where the failure happens: error.transport_subkind, error.http_status
//      (provider-base.mjs, common.mjs reserveBudget) and Node network codes on error.code / error.cause.code.
//   3. The failure CODE the loop itself prefixes its errors with ("provider_action_omission_repair_failed: ..."): a closed
//      vocabulary of the loop's own codes (REQUEST_FAILURE_CODE_CLASS), not free text.
//   4. LEGACY TEXT: the transport regex below, for errors that were re-wrapped into a plain message before they reached the
//      classifier ("Provider response recovery exhausted after 3 attempts: ... HTTP 503"). It can be deleted once every wrapper
//      forwards the original error's structured fields (staging/npc-agent-loop.mjs recoverPlan is the one that does not yet).

// Undici's fetch rejects with TypeError('fetch failed') and puts the network code on error.cause.code. A DNS failure (ENOTFOUND,
// EAI_AGAIN) is a transport condition: waiting can fix it. UND_ERR_ABORTED is deliberately absent (the loop's own cancellation).
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
])
// Undici's response timeouts are the timeout subkind (as a provider that "timed out after N ms" already is).
const TIMEOUT_ERROR_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const SAFE_CAUSE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/

// The error codes an error carries, outermost first: its own code, its cause's, and the first member of an AggregateError cause
// (undici reports a refused connection to several addresses that way).
function errorCodes(failure) {
  if (!failure || typeof failure !== 'object') return []
  const cause = failure.cause && typeof failure.cause === 'object' ? failure.cause : undefined
  const member = Array.isArray(cause?.errors) ? cause.errors[0] : undefined
  const nested = cause?.cause && typeof cause.cause === 'object' ? cause.cause : undefined
  return [failure.cause_code, failure.code, cause?.code, member?.code, nested?.code].filter(code => typeof code === 'string')
}

// A short, safe token for a trace row (ENOTFOUND, ECONNREFUSED, UND_ERR_SOCKET ...), or undefined. Only a code is read, never an
// error message: a network error's message names the host and URL (getaddrinfo ENOTFOUND <host>).
export function failureCauseCode(failure) {
  const codes = errorCodes(failure).filter(code => SAFE_CAUSE_CODE.test(code))
  return codes.find(code => NETWORK_ERROR_CODES.has(code) || TIMEOUT_ERROR_CODES.has(code)) ?? codes[0]
}

// The bounded transport fields of a failure, for provider.error and request.failed rows:
// { cause_code?, pause_class?: 'transport', transport_subkind? }.
export function transportTraceFields(failure) {
  const causeCode = failureCauseCode(failure)
  const transport = transportFailureOf(failure)
  return {
    ...(causeCode ? { cause_code: causeCode } : {}),
    ...(transport ? { pause_class: PAUSE_CLASS.TRANSPORT, transport_subkind: transport.subkind } : {}),
  }
}

// Harness-state invariants (unit 14): errors the harness raises when ITS OWN state is inconsistent (a checkpoint submitted while the
// plan is not active, a contract that did not read back after it was written). They are not model behaviour and not a guard that
// stopped on purpose, so they are never a model_recoverable or guard pause: they pause as `system`, with the code as the cause, and
// run-check reports them as a harness fault.
export const HARNESS_STATE_FAULT_CODES = Object.freeze(['checkpoint_requires_active_step', 'deterministic_checkpoint_failed_to_persist'])

// The harness-state fault code a failure carries (its message starts with the code, bare or as a "code: detail" prefix), or undefined.
export function harnessStateFaultCode(failure) {
  const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : String(failure?.message ?? '')
  const text = message.trim()
  return HARNESS_STATE_FAULT_CODES.find(code => text.startsWith(code) && !/[a-z0-9_]/.test(text.charAt(code.length)))
}

export const REQUEST_FAILURE_CODE_CLASS = Object.freeze({
  checkpoint_requires_active_step: PAUSE_CLASS.SYSTEM,
  deterministic_checkpoint_failed_to_persist: PAUSE_CLASS.SYSTEM,
  provider_action_omission_repair_failed: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_output_budget_exhausted: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_output_budget_recovery_exhausted: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_semantic_alignment_failed: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_recovery_exhausted: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_context_window_exceeded: PAUSE_CLASS.MODEL_RECOVERABLE,
  provider_turn_output_cap_exceeded: PAUSE_CLASS.GUARD,
  request_output_ceiling: PAUSE_CLASS.GUARD,
  request_failed: PAUSE_CLASS.GUARD,
})

function subkindFromHttpStatus(status) {
  if (status === 429) return TRANSPORT_SUBKIND.RATE_LIMITED
  if (Number.isSafeInteger(status) && status >= 500 && status <= 599) return TRANSPORT_SUBKIND.SERVER_ERROR
  return undefined
}

const MODEL_BUDGET_TEXT = /provider_context_window_exceeded|provider_output_budget|finish=length/i

// Legacy text fallback. Model-behaviour failures are excluded on purpose: waiting does not fix them.
export function transportSubkindFromText(message) {
  const text = String(message ?? '')
  if (MODEL_BUDGET_TEXT.test(text)) return undefined
  if (/Hourly provider request budget reached/i.test(text)) return TRANSPORT_SUBKIND.BUDGET
  if (/\bHTTP 429\b/.test(text)) return TRANSPORT_SUBKIND.RATE_LIMITED
  if (/\bHTTP 5\d\d\b/.test(text)) return TRANSPORT_SUBKIND.SERVER_ERROR
  if (/Provider timed out|\btimed out after \d+ ?ms/i.test(text)) return TRANSPORT_SUBKIND.TIMEOUT
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(text)) return TRANSPORT_SUBKIND.TRANSPORT
  return undefined
}

// The class of one of the loop's own failure/pause codes (REQUEST_FAILURE_CODE_CLASS); an unknown code fails closed to 'guard'.
export function pauseClassForCode(code) {
  return REQUEST_FAILURE_CODE_CLASS[String(code ?? '')] ?? PAUSE_CLASS.GUARD
}

function failureMessage(failure) {
  if (failure instanceof Error) return failure.message
  if (typeof failure === 'string') return failure
  return String(failure?.message ?? '')
}

// { subkind, source } for a transport condition, or undefined. `source` names the layer that decided:
// 'declared' | 'structured' | 'legacy_text'.
export function transportFailureOf(failure) {
  // Context-window and output-budget failures are never transport, whatever status or text accompanies them: waiting does not fix them.
  if (failure && typeof failure === 'object'
    && (failure.code === 'provider_context_window_exceeded' || failure.failureClass === 'provider_budget')) return undefined
  if (MODEL_BUDGET_TEXT.test(failureMessage(failure))) return undefined
  if (failure && typeof failure === 'object') {
    if (failure.pause_class === PAUSE_CLASS.TRANSPORT && TRANSPORT_SUBKINDS.includes(failure.pause_subkind)) {
      return { subkind: failure.pause_subkind, source: 'declared' }
    }
    if (TRANSPORT_SUBKINDS.includes(failure.transport_subkind)) return { subkind: failure.transport_subkind, source: 'structured' }
    const fromStatus = subkindFromHttpStatus(failure.http_status)
    if (fromStatus) return { subkind: fromStatus, source: 'structured' }
    const codes = errorCodes(failure)
    if (codes.some(code => TIMEOUT_ERROR_CODES.has(code))) return { subkind: TRANSPORT_SUBKIND.TIMEOUT, source: 'structured' }
    if (codes.some(code => NETWORK_ERROR_CODES.has(code))) return { subkind: TRANSPORT_SUBKIND.TRANSPORT, source: 'structured' }
  }
  const fromText = transportSubkindFromText(failureMessage(failure))
  return fromText ? { subkind: fromText, source: 'legacy_text' } : undefined
}

// The failure code in a message: the loop's own "code: detail" prefix, or (legacy text) the two un-prefixed wordings it also raised.
function failureCode(message) {
  const text = String(message ?? '')
  return /^\s*([a-z][a-z0-9_]{2,80})\s*:/.exec(text)?.[1]
    ?? (/provider_output_budget_exhausted|finish=length|output budget/i.test(text) ? 'provider_output_budget_exhausted' : undefined)
    ?? (/^Provider response recovery exhausted after \d+ attempts/i.test(text) ? 'provider_recovery_exhausted' : undefined)
    ?? (/provider_(?:action_omission_repair_failed|semantic_alignment_failed)/i.exec(text)?.[0]?.toLowerCase())
}

// The pause a failed request produces: { pause_class, pause_subkind, code, source }. Never throws; anything it cannot place is a
// 'guard' pause (stopped, needs a player's Resume) with code request_failed.
export function classifyRequestFailure(failure) {
  const transport = transportFailureOf(failure)
  if (transport) return { pause_class: PAUSE_CLASS.TRANSPORT, pause_subkind: transport.subkind, code: 'provider_transient', source: transport.source }
  const declared = failure && typeof failure === 'object' ? failure.pause_class : undefined
  const code = failureCode(failureMessage(failure)) ?? 'request_failed'
  // A harness guard that names its own code (PreservationProofError.failure_code) keeps it: the pause reads as that guard, not as a
  // generic request failure and never as a provider one.
  const guardCode = failure && typeof failure === 'object' && typeof failure.failure_code === 'string' && SAFE_FAILURE_CODE.test(failure.failure_code) ? failure.failure_code : undefined
  if (guardCode && isPauseClass(declared)) return { pause_class: declared, pause_subkind: '', code: guardCode, source: 'guard_code' }
  if (isPauseClass(declared)) return { pause_class: declared, pause_subkind: '', code, source: 'declared' }
  const fault = harnessStateFaultCode(failure)
  if (fault) return { pause_class: PAUSE_CLASS.SYSTEM, pause_subkind: '', code: fault, source: 'harness_state_fault' }
  const byCode = REQUEST_FAILURE_CODE_CLASS[code]
  if (byCode) return { pause_class: byCode, pause_subkind: '', code, source: 'failure_code' }
  return { pause_class: PAUSE_CLASS.GUARD, pause_subkind: '', code: 'request_failed', source: 'fallback' }
}

const SAFE_FAILURE_CODE = /^[a-z][a-z0-9_]{2,80}$/

// Whether a pause came from the provider/request layer (the goal.paused trace's provider_failure). Decided from the pause's declared
// class and the failure CODE that prefixes its reason, never from a text search of the reason: a harness guard's detail text may
// mention "provider" or "request_failed" without the provider having failed. `request_failed` itself is the unplaced fallback.
export function isProviderFailurePause(record, reason) {
  if (pauseClassOf(record).pause_class === PAUSE_CLASS.TRANSPORT) return true
  const code = String(reason ?? record?.pause_reason ?? '').split(':')[0].trim()
  return code === 'request_failed' || code === 'recoverable_provider_failure' || code.startsWith('provider_')
}

// Stamp a class on an error where it is raised.
export function declarePauseClass(error, pauseClass, pauseSubkind = '') {
  if (error && typeof error === 'object') {
    error.pause_class = pauseClass
    if (pauseSubkind) error.pause_subkind = pauseSubkind
  }
  return error
}
