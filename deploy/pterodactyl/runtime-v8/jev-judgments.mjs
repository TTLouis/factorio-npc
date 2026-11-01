// Jev judgment ledger with promotion gates (delegation unit U11, design note
// NPC_DELEGATION_DESIGN_2026-09-29.md section 7 "Owner decisions, 2026-09-30").
//
// Pure module: no I/O, no clock, no env. Every function takes a ledger and
// returns a new one. The runtime keeps the ledger in its own durable state (the
// memory snapshot, next to but NOT inside the planning reducer) and traces every
// change; nothing here can author a plan, advance the Plan Tracker or declare
// completion.
//
// A judgment is one thing Jev selected, ranked or routed, recorded with the
// alternative and later SCORED AGAINST THE OUTCOME (did the agent take the same
// next step, did the step verify, did the fresh agent actually use the facts Jev
// chose), not only against the LLM.
//
// Stages per family, computed from the ledger alone (no setting anywhere):
//   shadow     trace only; nothing Jev says changes behavior
//   advisory   Jev may ADD to a packet or ORDER a list; never remove, never pick
//   deciding   Jev may act on its own (skip a wake)
// Promotion needs scored judgments at >= 90% agreement: >= 30 for advisory,
// >= 60 for deciding. Tracing goes on after promotion. A family whose rolling
// agreement (the last 60 scored judgments since its last demotion) falls below
// 90% is demoted to shadow automatically and must earn its way back with fresh
// evidence. Each family also has a hard cap (what its consumer code supports):
// the stage it has EARNED may be higher than the stage it is allowed to USE.

export const JUDGMENT_STAGES = Object.freeze(['shadow', 'advisory', 'deciding'])

export const JUDGMENT_FAMILIES = Object.freeze({
  // Step close inside a slice: the next committed step is clear, so the executor
  // continues directly (no targeted-observation wake). Acts on its own when deciding.
  c4_next_step: Object.freeze({ cap: 'deciding', acts_alone: true, channels: Object.freeze(['jev_calls', 'rounds', 'tokens']) }),
  // Observation families Jev thinks a fresh conversation needs. Advisory only adds facts to the packet.
  observation_families: Object.freeze({ cap: 'advisory', acts_alone: false, channels: Object.freeze(['calls']) }),
  // Ranking of the complete shelf-candidate set at a shelf pickup. Advisory only orders the packet's candidates.
  shelf_ranking: Object.freeze({ cap: 'advisory', acts_alone: false, channels: Object.freeze([]) }),
  // Skill card order: stays in shadow (owner, 2026-09-28); scored so the evidence exists.
  skill_order: Object.freeze({ cap: 'shadow', acts_alone: false, channels: Object.freeze([]) }),
})

export const JUDGMENT_PROMOTION = Object.freeze({
  advisoryMinScored: 30,
  decidingMinScored: 60,
  minAgreement: 0.9, // agreed / scored over the rolling window, compared in integers: agreed * 10 >= scored * 9
  window: 60,
})

// The channels a saving is counted in. `rounds` and `tokens` are LLM provider rounds and their input+output units
// (observation-tool rounds before the first admitted operation: never the round that authors operations); `calls` are
// fact/lookup calls a packet replaced; `jev_calls` are Jev decision calls that were not made (the post-step gate and
// the planner-shape call: not LLM wakes). `wakes` is kept for old ledgers and is never written by C4: the executor
// still wakes on every route.
export const SAVING_CHANNELS = Object.freeze(['wakes', 'rounds', 'tokens', 'calls', 'jev_calls'])

// A family that has this many scored judgments and has saved nothing in any channel is flagged in the
// report for removal. Removal is the owner's call; nothing here removes anything.
export const REMOVAL_REVIEW_MIN_SCORED = 30

const PENDING_LIMIT = 64
const RECENT_LIMIT = 20
const SAMPLE_LIMIT = 20
const COUNTER_MAX = 1_000_000_000

export function isJudgmentFamily(family) {
  return typeof family === 'string' && Object.hasOwn(JUDGMENT_FAMILIES, family)
}

function stageRank(stage) {
  return Math.max(0, JUDGMENT_STAGES.indexOf(stage))
}

function emptySaving() {
  return Object.fromEntries(SAVING_CHANNELS.map(channel => [channel, 0]))
}

function emptyFamily() {
  return {
    stage: 'shadow', // the EARNED stage; effectiveStage() applies the family cap
    scored: 0,
    agreed: 0,
    evidence: 0, // scored judgments since the last demotion (promotions count from here)
    window: [], // 1 = agreed, 0 = disagreed; the last JUDGMENT_PROMOTION.window since the last demotion
    promotions: 0,
    demotions: 0,
    unscored: 0, // judgments abandoned before an outcome existed; never counted as agreement
    would_save: emptySaving(), // what shadow and advisory judgments would have saved
    saved: emptySaving(), // what a judgment that acted on its own saved
    samples: [], // recent per-judgment token baselines (c4: observation-round tokens of the wake that ran)
    recent: [], // the last RECENT_LIMIT scored judgments, summarized
  }
}

export function emptyLedger() {
  const families = {}
  for (const family of Object.keys(JUDGMENT_FAMILIES)) families[family] = emptyFamily()
  return { version: 1, seq: 0, families, pending: {} }
}

function clampCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, COUNTER_MAX) : 0
}

function windowStats(state) {
  const length = state.window.length
  const agreed = state.window.reduce((total, bit) => total + (bit === 1 ? 1 : 0), 0)
  return { length, agreed, meets: length > 0 && agreed * 10 >= length * 9 }
}

// The stage the family has earned, whatever its cap.
export function earnedStage(ledger, family) {
  return ledger?.families?.[family]?.stage ?? 'shadow'
}

// The stage its consumer code may use: the earned stage, never above the family cap.
export function effectiveStage(ledger, family) {
  if (!isJudgmentFamily(family)) return 'shadow'
  const cap = JUDGMENT_FAMILIES[family].cap
  const earned = earnedStage(ledger, family)
  return stageRank(earned) > stageRank(cap) ? cap : earned
}

export function familyAgreement(ledger, family) {
  const state = ledger?.families?.[family]
  if (!state) return undefined
  const stats = windowStats(state)
  return stats.length > 0 ? stats.agreed / stats.length : undefined
}

// One step of the stage machine. Returns the transition, or undefined when the stage stands.
function nextTransition(state) {
  const stats = windowStats(state)
  const agreement = stats.length > 0 ? Math.round(stats.agreed / stats.length * 1000) / 1000 : undefined
  if (state.stage !== 'shadow' && !stats.meets) {
    return {
      to: 'shadow',
      direction: 'demoted',
      reason: `rolling_agreement_below_threshold: ${stats.agreed}/${stats.length} agreed in the last ${stats.length} scored judgments (need >= ${JUDGMENT_PROMOTION.minAgreement * 100}%)`,
      agreement,
    }
  }
  if (state.stage === 'shadow' && state.evidence >= JUDGMENT_PROMOTION.advisoryMinScored && stats.meets) {
    return {
      to: 'advisory',
      direction: 'promoted',
      reason: `evidence_met: ${stats.agreed}/${stats.length} agreed over ${state.evidence} scored judgments (need >= ${JUDGMENT_PROMOTION.advisoryMinScored} at >= ${JUDGMENT_PROMOTION.minAgreement * 100}%)`,
      agreement,
    }
  }
  if (state.stage === 'advisory' && state.evidence >= JUDGMENT_PROMOTION.decidingMinScored && stats.meets) {
    return {
      to: 'deciding',
      direction: 'promoted',
      reason: `evidence_met: ${stats.agreed}/${stats.length} agreed over ${state.evidence} scored judgments (need >= ${JUDGMENT_PROMOTION.decidingMinScored} at >= ${JUDGMENT_PROMOTION.minAgreement * 100}%)`,
      agreement,
    }
  }
  return undefined
}

// The highest stage the recorded evidence supports (used to validate a persisted ledger).
function supportedStage(state) {
  const stats = windowStats(state)
  if (!stats.meets) return 'shadow'
  if (state.evidence >= JUDGMENT_PROMOTION.decidingMinScored) return 'deciding'
  if (state.evidence >= JUDGMENT_PROMOTION.advisoryMinScored) return 'advisory'
  return 'shadow'
}

function addSaving(target, saving) {
  for (const channel of SAVING_CHANNELS) {
    target[channel] = Math.min(COUNTER_MAX, target[channel] + clampCount(saving?.[channel]))
  }
}

/**
 * Record a judgment as pending. Returns { ledger, judgment } or undefined when the family is unknown.
 * `input`: family, request_id, goal_id, plan_id, step_id, handoff_id, checkpoint, jev_choice, jev_confidence,
 * alternative (what the deterministic code or the LLM would do/did), detail (bounded facts), acted (true when
 * the judgment changed behavior), saving_estimate ({rounds,tokens,calls,jev_calls}). `salt` keeps ids distinct across restarts.
 */
export function recordJudgment(ledger, input, { salt = '' } = {}) {
  if (!isJudgmentFamily(input?.family)) return undefined
  const next = structuredClone(ledger)
  const seq = next.seq + 1
  next.seq = seq
  const stage = effectiveStage(next, input.family)
  const judgment = {
    judgment_id: `jdg_${salt ? `${salt}_` : ''}${seq.toString(36)}`,
    family: input.family,
    request_id: typeof input.request_id === 'string' ? input.request_id : undefined,
    goal_id: typeof input.goal_id === 'string' ? input.goal_id : undefined,
    plan_id: typeof input.plan_id === 'string' ? input.plan_id : undefined,
    step_id: typeof input.step_id === 'string' ? input.step_id : undefined,
    handoff_id: typeof input.handoff_id === 'string' ? input.handoff_id : undefined,
    checkpoint: typeof input.checkpoint === 'string' ? input.checkpoint : undefined,
    jev_choice: input.jev_choice,
    jev_confidence: Number.isFinite(input.jev_confidence) ? input.jev_confidence : undefined,
    alternative: input.alternative,
    detail: input.detail,
    stage,
    acted: input.acted === true && stage !== 'shadow',
    saving_estimate: input.saving_estimate,
  }
  next.pending[judgment.judgment_id] = judgment
  const ids = Object.keys(next.pending)
  while (ids.length > PENDING_LIMIT) {
    const evicted = ids.shift()
    const family = next.pending[evicted]?.family
    delete next.pending[evicted]
    if (family && next.families[family]) next.families[family].unscored = clampCount(next.families[family].unscored + 1)
  }
  return { ledger: next, judgment }
}

/** A judgment's effect reached its consumer (e.g. an advisory order reached a packet): it is `acted` from now on. */
export function markJudgmentActed(ledger, judgmentId) {
  const pending = ledger?.pending?.[judgmentId]
  if (!pending || pending.stage === 'shadow' || pending.acted === true) return undefined
  const next = structuredClone(ledger)
  next.pending[judgmentId].acted = true
  return next
}

export function pendingJudgment(ledger, judgmentId) {
  return ledger?.pending?.[judgmentId]
}

/**
 * Score a pending judgment against its outcome.
 * `result`: { agreed: boolean, outcome: object (bounded facts), saving?: {rounds,tokens,calls,jev_calls}, token_sample?: number }
 * Returns { ledger, scored, transitions } (transitions: zero or more stage changes, each with from/to, direction,
 * reason, agreement, evidence and the effective stages before and after).
 */
export function scoreJudgment(ledger, judgmentId, result) {
  const pending = ledger?.pending?.[judgmentId]
  if (!pending) return undefined
  const next = structuredClone(ledger)
  delete next.pending[judgmentId]
  const state = next.families[pending.family]
  const agreed = result?.agreed === true
  state.scored = clampCount(state.scored + 1)
  state.agreed = clampCount(state.agreed + (agreed ? 1 : 0))
  state.evidence = clampCount(state.evidence + 1)
  state.window.push(agreed ? 1 : 0)
  if (state.window.length > JUDGMENT_PROMOTION.window) state.window.splice(0, state.window.length - JUDGMENT_PROMOTION.window)
  // A saving that came with a failed outcome is not a saving.
  if (agreed && result?.saving) addSaving(pending.acted ? state.saved : state.would_save, result.saving)
  if (Number.isFinite(result?.token_sample) && result.token_sample >= 0) {
    state.samples.push(Math.round(result.token_sample))
    if (state.samples.length > SAMPLE_LIMIT) state.samples.splice(0, state.samples.length - SAMPLE_LIMIT)
  }
  const scored = {
    ...pending,
    agreed,
    outcome: result?.outcome,
    scored_seq: state.scored,
  }
  state.recent.push({
    judgment_id: pending.judgment_id,
    request_id: pending.request_id,
    step_id: pending.step_id,
    jev_choice: typeof pending.jev_choice === 'string' ? pending.jev_choice : undefined,
    agreed,
    stage: pending.stage,
    acted: pending.acted,
  })
  if (state.recent.length > RECENT_LIMIT) state.recent.splice(0, state.recent.length - RECENT_LIMIT)

  const transitions = []
  for (let guard = 0; guard < 3; guard++) {
    const before = state.stage
    const effectiveBefore = effectiveStage(next, pending.family)
    const transition = nextTransition(state)
    if (!transition) break
    state.stage = transition.to
    if (transition.direction === 'promoted') state.promotions = clampCount(state.promotions + 1)
    else {
      state.demotions = clampCount(state.demotions + 1)
      // Fresh evidence is required to come back: nothing from before the demotion counts.
      state.window = []
      state.evidence = 0
    }
    transitions.push({
      family: pending.family,
      from: before,
      to: transition.to,
      direction: transition.direction,
      reason: transition.reason,
      agreement: transition.agreement,
      evidence: state.evidence,
      scored_total: state.scored,
      effective_from: effectiveBefore,
      effective_to: effectiveStage(next, pending.family),
      cap: JUDGMENT_FAMILIES[pending.family].cap,
    })
  }
  return { ledger: next, scored, transitions }
}

/** Drop a pending judgment without scoring it (superseded, request ended early, Jev failed). Not agreement. */
export function abandonJudgment(ledger, judgmentId) {
  const pending = ledger?.pending?.[judgmentId]
  if (!pending) return undefined
  const next = structuredClone(ledger)
  delete next.pending[judgmentId]
  next.families[pending.family].unscored = clampCount(next.families[pending.family].unscored + 1)
  return { ledger: next, abandoned: pending }
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** The running baseline a family keeps for its token saving (median of its recent samples). */
export function tokenBaseline(ledger, family) {
  return median(ledger?.families?.[family]?.samples ?? [])
}

export function summarizeFamily(ledger, family) {
  const state = ledger?.families?.[family]
  if (!state) return undefined
  const stats = windowStats(state)
  const savedAny = SAVING_CHANNELS.some(channel => state.saved[channel] > 0 || state.would_save[channel] > 0)
  const removal = state.scored >= REMOVAL_REVIEW_MIN_SCORED && !savedAny
  return {
    family,
    stage: effectiveStage(ledger, family),
    earned_stage: state.stage,
    cap: JUDGMENT_FAMILIES[family].cap,
    judgments: state.scored + state.unscored,
    scored: state.scored,
    agreed: state.agreed,
    agreement: stats.length > 0 ? Math.round(stats.agreed / stats.length * 1000) / 1000 : undefined,
    agreement_total: state.scored > 0 ? Math.round(state.agreed / state.scored * 1000) / 1000 : undefined,
    evidence: state.evidence,
    promotions: state.promotions,
    demotions: state.demotions,
    unscored: state.unscored,
    would_save: { ...state.would_save },
    saved: { ...state.saved },
    removal_candidate: removal,
    ...(removal ? { removal_reason: `no measured saving (LLM rounds or tokens, lookup calls or Jev calls) after ${state.scored} scored judgments; removal is the owner's call` } : {}),
  }
}

export function summarizeLedger(ledger) {
  return Object.keys(JUDGMENT_FAMILIES).map(family => summarizeFamily(ledger, family))
}

// --- persistence (bounded, sanitized; pending judgments are never persisted: their request is gone) ---

export function serializeLedger(ledger) {
  const families = {}
  for (const family of Object.keys(JUDGMENT_FAMILIES)) {
    const state = ledger?.families?.[family] ?? emptyFamily()
    families[family] = {
      stage: state.stage,
      scored: state.scored,
      agreed: state.agreed,
      evidence: state.evidence,
      window: [...state.window],
      promotions: state.promotions,
      demotions: state.demotions,
      unscored: state.unscored,
      would_save: { ...state.would_save },
      saved: { ...state.saved },
      samples: [...state.samples],
      recent: state.recent.map(entry => ({ ...entry })),
    }
  }
  return { version: 1, seq: clampCount(ledger?.seq), families }
}

function restoreSaving(raw) {
  const saving = emptySaving()
  if (raw && typeof raw === 'object') for (const channel of SAVING_CHANNELS) saving[channel] = clampCount(raw[channel])
  return saving
}

/**
 * Restore a persisted ledger. Anything unreadable starts that family in shadow. A persisted stage the recorded
 * evidence does not support (a hand-edited or damaged file) is clamped down, never trusted. Returns
 * { ledger, clamped: [{family, from, to}] }.
 */
export function restoreLedger(raw) {
  const ledger = emptyLedger()
  const clamped = []
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return { ledger, clamped }
  ledger.seq = clampCount(raw.seq)
  for (const family of Object.keys(JUDGMENT_FAMILIES)) {
    const source = raw.families?.[family]
    if (!source || typeof source !== 'object') continue
    const state = emptyFamily()
    state.scored = clampCount(source.scored)
    state.agreed = Math.min(state.scored, clampCount(source.agreed))
    state.evidence = Math.min(state.scored, clampCount(source.evidence))
    state.window = (Array.isArray(source.window) ? source.window : []).slice(-JUDGMENT_PROMOTION.window).map(bit => (bit === 1 ? 1 : 0))
    if (state.window.length > state.evidence) state.window = state.window.slice(state.window.length - state.evidence)
    state.promotions = clampCount(source.promotions)
    state.demotions = clampCount(source.demotions)
    state.unscored = clampCount(source.unscored)
    state.would_save = restoreSaving(source.would_save)
    state.saved = restoreSaving(source.saved)
    state.samples = (Array.isArray(source.samples) ? source.samples : []).filter(value => Number.isFinite(value) && value >= 0).slice(-SAMPLE_LIMIT).map(value => Math.round(value))
    state.recent = (Array.isArray(source.recent) ? source.recent : []).slice(-RECENT_LIMIT).map(entry => ({
      judgment_id: typeof entry?.judgment_id === 'string' ? entry.judgment_id.slice(0, 80) : undefined,
      request_id: typeof entry?.request_id === 'string' ? entry.request_id.slice(0, 80) : undefined,
      step_id: typeof entry?.step_id === 'string' ? entry.step_id.slice(0, 80) : undefined,
      jev_choice: typeof entry?.jev_choice === 'string' ? entry.jev_choice.slice(0, 80) : undefined,
      agreed: entry?.agreed === true,
      stage: JUDGMENT_STAGES.includes(entry?.stage) ? entry.stage : 'shadow',
      acted: entry?.acted === true,
    }))
    const claimed = JUDGMENT_STAGES.includes(source.stage) ? source.stage : 'shadow'
    const supported = supportedStage(state)
    state.stage = stageRank(claimed) > stageRank(supported) ? supported : claimed
    if (state.stage !== claimed) clamped.push({ family, from: claimed, to: state.stage })
    ledger.families[family] = state
  }
  return { ledger, clamped }
}

// --- scorers: pure outcome rules, one per family ---------------------------------------------------------------

/**
 * C4. ONE outcome label, `observation_needed`, scores both answers (mutually exclusive):
 *   observation_needed = the wake made fresh lookups before its first admitted operation
 *                        OR the step did not verify on its first batch (a failure boundary, or the first batch
 *                        completing without the contract satisfied).
 * `direct_to_executor` agrees iff observation was NOT needed; `ground_first` agrees iff it WAS. This errs against
 * `direct`, the safe direction: an always-direct Jev is wrong every time the wake looked anything up or the step
 * needed more than one batch, so it cannot earn promotion on wakes that did observe.
 * A lookup or a failed first batch is final (whatever the request does next); "not needed" needs the step to have
 * verified on its first batch. Undefined while the label is not yet known.
 */
export function c4ObservationNeeded({ fresh_lookups: freshLookups, verified, first_try: firstTry }) {
  if (!Number.isFinite(freshLookups)) return undefined
  if (freshLookups >= 1 || firstTry === false || verified === false) return true
  if (verified === true && firstTry === true) return false
  return undefined
}

export function scoreC4Judgment({ choice, fresh_lookups: freshLookups, verified, first_try: firstTry }) {
  if (choice !== 'direct_to_executor' && choice !== 'ground_first') return undefined
  const needed = c4ObservationNeeded({ fresh_lookups: freshLookups, verified, first_try: firstTry })
  if (needed === undefined) return undefined
  return { agreed: choice === 'direct_to_executor' ? !needed : needed, observation_needed: needed }
}

function unique(list) {
  return [...new Set(list)]
}

/**
 * Observation families. `selected` is what Jev picked (taxonomy threshold 0.5, cap 4); `looked` is the set of
 * families the fresh agent then actually looked up (fresh reads, before its first admitted operation); `provided`
 * is what the packet already supplied (advisory facts), which an agent never looks up.
 *   recall    = share of what the agent looked up that Jev predicted
 *   precision = share of the UNSUPPLIED picks the agent used (a supplied pick cannot be measured); all picks supplied
 *               leaves it neutral
 * agreed = recall >= 0.5 and precision >= 0.5.
 * An agent that looked nothing up is not agreement: with nothing picked either, or with every pick supplied, there is
 * nothing to compare and the result is `neutral` (the caller leaves it unscored); an unsupplied pick the agent never
 * used is a disagreement (Jev over-predicted).
 */
export function scoreObservationFamilies({ selected, looked, provided = [], mode }) {
  const picked = unique(Array.isArray(selected) ? selected : [])
  const used = unique(Array.isArray(looked) ? looked : [])
  const supplied = new Set(Array.isArray(provided) ? provided : [])
  const unsupplied = picked.filter(family => !supplied.has(family))
  const scoring = mode ?? (supplied.size > 0 ? 'with_supplied_facts' : 'two_sided')
  if (used.length === 0 && unsupplied.length === 0) return { agreed: undefined, neutral: true, recall: undefined, precision: undefined, mode: scoring }
  const hits = used.filter(family => picked.includes(family))
  const recall = used.length === 0 ? 1 : hits.length / used.length
  const precision = unsupplied.length === 0 ? 1 : unsupplied.filter(family => used.includes(family)).length / unsupplied.length
  const agreed = recall >= 0.5 && precision >= 0.5
  return { agreed, neutral: false, recall: Math.round(recall * 1000) / 1000, precision: Math.round(precision * 1000) / 1000, mode: scoring }
}

/**
 * Shelf ranking. Jev's top-ranked node against the node the planner actually refined, and whether that slice
 * verified. Agrees only when the planner picked Jev's first and its slice verified. `verified` undefined means
 * the slice has not closed yet (not scoreable).
 */
export function scoreShelfRanking({ ranked, picked, verified }) {
  if (verified === undefined || typeof picked !== 'string' || !Array.isArray(ranked) || ranked.length === 0) return undefined
  const rank = ranked.indexOf(picked) + 1
  return { agreed: ranked[0] === picked && verified === true, picked_rank: rank > 0 ? rank : undefined }
}

/**
 * Skill card order. Jev picked a card (or `none`); the planner committed a plan. The fresh agent used Jev's
 * choice when that skill was loaded (`getSkillDetails`) by the commit. `none` agrees when nothing was loaded.
 */
export function scoreSkillOrder({ pick, loaded }) {
  const held = Array.isArray(loaded) ? loaded : []
  if (pick === 'none') return { agreed: held.length === 0 }
  return { agreed: typeof pick === 'string' && held.includes(pick) }
}
