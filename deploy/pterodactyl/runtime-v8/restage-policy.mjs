// Restage policy (delegation plan 3.5, owner answers 12a, 2026-09-29).
//
// Pure decisions about WHEN a conversation is discarded and rebuilt from a
// handoff packet. Unwired: nothing calls this yet.
//
// Owner rules:
//  - The planner's context is long-lived. It restages only under the size rule.
//  - The executor gets a fresh context at every plan commit (C3).
//  - Size rule, measured in TOKENS: once a context passes the soft limit it
//    restages at the NEXT SLICE close (C1). Past the hard limit (2x soft) it
//    restages at the NEXT STEP close (C8, the size safety net), so one long
//    slice cannot grow without bound.
//  - The size counter is monotonic since the last restage: compaction folds
//    old messages and shrinks the next prompt, but it must not hide growth.
//  - The request output ceiling resets per slice.
//
// Checkpoints are the reducer's (CONTEXT_RESTAGE_CHECKPOINTS). Mapping to the
// design note table (section 4):
//   plan_commit + executor        -> C3  slice committed, fresh plan agent
//   slice_close, size >= soft     -> C1  slice/plan closed
//   step_close,  size >= hard     -> C8  size/turn safety net at a step close
//   slice_close, size >= hard     -> C1  (a slice close is also a step close)
// "Past the limit" means strictly greater than it.

import { CONTEXT_RESTAGE_CHECKPOINTS, CONTEXT_RESTAGE_ROLES } from './planning-state.mjs'

export const RESTAGE_BOUNDARY = Object.freeze({
  PLAN_COMMIT: 'plan_commit',
  STEP_CLOSE: 'step_close',
  SLICE_CLOSE: 'slice_close',
})

export const RESTAGE_CHECKPOINT = Object.freeze({
  SLICE_CLOSED: 'C1',
  SLICE_COMMITTED: 'C3',
  SIZE_SAFETY_NET: 'C8',
})

// The checkpoint constants above must be ones the reducer accepts.
for (const checkpoint of Object.values(RESTAGE_CHECKPOINT)) {
  if (!CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint)) throw new Error(`restage-policy: unknown reducer checkpoint ${checkpoint}`)
}

export const RESTAGE_REASON = Object.freeze({
  EXECUTOR_FRESH_AT_COMMIT: 'executor_fresh_at_plan_commit',
  SOFT_LIMIT_AT_SLICE_CLOSE: 'context_over_soft_limit_at_slice_close',
  HARD_LIMIT_AT_SLICE_CLOSE: 'context_over_hard_limit_at_slice_close',
  HARD_LIMIT_AT_STEP_CLOSE: 'context_over_hard_limit_at_step_close',
  NONE: 'no_restage_needed',
})

function tokenCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * @param {object} args
 * @param {'planner'|'executor'} args.role the context being asked about
 * @param {'plan_commit'|'step_close'|'slice_close'} args.boundary the boundary just reached
 * @param {number} args.contextTokens monotonic size counter (see contextSizeState)
 * @param {number} args.softLimitTokens
 * @param {number} [args.hardLimitTokens] defaults to 2 x softLimitTokens
 * @returns {{ restage: boolean, checkpoint: string|null, reason: string }}
 */
export function decideRestage({ role, boundary, contextTokens, softLimitTokens, hardLimitTokens } = {}) {
  if (!CONTEXT_RESTAGE_ROLES.includes(role)) throw new RangeError(`restage role must be one of ${CONTEXT_RESTAGE_ROLES.join(', ')}`)
  if (!Object.values(RESTAGE_BOUNDARY).includes(boundary)) throw new RangeError(`restage boundary must be one of ${Object.values(RESTAGE_BOUNDARY).join(', ')}`)
  if (!Number.isFinite(softLimitTokens) || softLimitTokens <= 0) throw new RangeError('softLimitTokens must be a positive number')
  const hard = hardLimitTokens === undefined ? 2 * softLimitTokens : hardLimitTokens
  if (!Number.isFinite(hard) || hard < softLimitTokens) throw new RangeError('hardLimitTokens must be a number not below softLimitTokens')
  const size = tokenCount(contextTokens)

  if (boundary === RESTAGE_BOUNDARY.PLAN_COMMIT) {
    // Executors are always fresh at a commit. The planner is not: a plan
    // commit is neither a slice close nor a step close, so its size waits for
    // the next of those.
    return role === 'executor'
      ? { restage: true, checkpoint: RESTAGE_CHECKPOINT.SLICE_COMMITTED, reason: RESTAGE_REASON.EXECUTOR_FRESH_AT_COMMIT }
      : { restage: false, checkpoint: null, reason: RESTAGE_REASON.NONE }
  }
  if (boundary === RESTAGE_BOUNDARY.SLICE_CLOSE) {
    if (size > hard) return { restage: true, checkpoint: RESTAGE_CHECKPOINT.SLICE_CLOSED, reason: RESTAGE_REASON.HARD_LIMIT_AT_SLICE_CLOSE }
    if (size > softLimitTokens) return { restage: true, checkpoint: RESTAGE_CHECKPOINT.SLICE_CLOSED, reason: RESTAGE_REASON.SOFT_LIMIT_AT_SLICE_CLOSE }
    return { restage: false, checkpoint: null, reason: RESTAGE_REASON.NONE }
  }
  // step_close
  if (size > hard) return { restage: true, checkpoint: RESTAGE_CHECKPOINT.SIZE_SAFETY_NET, reason: RESTAGE_REASON.HARD_LIMIT_AT_STEP_CLOSE }
  return { restage: false, checkpoint: null, reason: RESTAGE_REASON.NONE }
}

// --- monotonic size counter ------------------------------------------------------------
//
// One per conversation context; replace it with a fresh one at every restage.
// Growth is the larger of the provider-reported input tokens of the latest
// request and an estimate from the chars appended so far (ceil(chars / 4)),
// and never falls back: a compaction fold that shrinks the next prompt does not
// reset the counter.

export function estimateTokensFromChars(chars) {
  return Math.ceil(tokenCount(chars) / 4)
}

export function contextSizeState() {
  return Object.freeze({ appendedChars: 0, tokens: 0 })
}

/**
 * @param {{appendedChars:number,tokens:number}} state
 * @param {object} [observation]
 * @param {number} [observation.appendedChars] chars added to the context since the last observation
 * @param {number} [observation.providerInputTokens] provider-reported prompt tokens of the latest request
 */
export function observeContextSize(state, { appendedChars = 0, providerInputTokens } = {}) {
  const previous = state ?? contextSizeState()
  const chars = previous.appendedChars + tokenCount(appendedChars)
  const tokens = Math.max(previous.tokens, estimateTokensFromChars(chars), tokenCount(providerInputTokens))
  return Object.freeze({ appendedChars: chars, tokens })
}

// --- per-slice output ceiling ------------------------------------------------------------
//
// The request-wide ceiling (npc-agent-loop.mjs requestOutputCeiling(), 5 x the
// per-turn cap) compares `traceRequest.usage.output_units`, a counter that
// only grows across the whole request, with that ceiling. Per slice, keep the
// same counter and compare only what the slice added:
//   used = aggregate - baseline
// The caller resets the baseline (resetSliceBaseline) when a slice starts and
// passes its existing `requestOutputCeiling()` as the ceiling.

/** Baseline record for a slice that starts when the request-wide counter reads `aggregateOutputUnits`. */
export function resetSliceBaseline(aggregateOutputUnits) {
  return Number.isSafeInteger(aggregateOutputUnits) && aggregateOutputUnits >= 0 ? aggregateOutputUnits : 0
}

/**
 * Output units the current slice has used. An aggregate below the baseline
 * means the request-wide counter itself restarted, so the aggregate is the
 * slice's usage. Undefined when the aggregate is not a usable counter.
 */
export function sliceOutputUsed(aggregateOutputUnits, baseline = 0) {
  if (!Number.isSafeInteger(aggregateOutputUnits) || aggregateOutputUnits < 0) return undefined
  const base = resetSliceBaseline(baseline)
  return aggregateOutputUnits >= base ? aggregateOutputUnits - base : aggregateOutputUnits
}

/** { used, ceiling, remaining, exceeded } for one slice; `exceeded` matches the loop's strict `>` test. */
export function sliceCeilingState({ aggregateOutputUnits, baseline = 0, ceiling } = {}) {
  const used = sliceOutputUsed(aggregateOutputUnits, baseline)
  const hasCeiling = Number.isFinite(ceiling) && ceiling > 0
  return {
    used,
    ceiling: hasCeiling ? ceiling : undefined,
    remaining: used !== undefined && hasCeiling ? Math.max(0, ceiling - used) : undefined,
    exceeded: used !== undefined && hasCeiling && used > ceiling,
  }
}
