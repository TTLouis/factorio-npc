// Jev decision contract.
//
// Authority model (docs/NPC_PLANNING_ROADMAP.md sections 1.3, 4 and 11):
//   - The user owns the goal.
//   - The Main LLM authors plans.
//   - Jev critiques a DRAFT plan before commit and may advise on steering at a
//     planning boundary. It never authors, rewrites, reorders or replaces plan
//     steps, and it has no completion vote.
//   - The runtime owns world truth, admission and completion evidence.
//
// Removed in this revision (deliberately, do not re-add here):
//   - `granularity`         -> replaced by the pre-commit scope review family.
//   - `completion`          -> runtime evidence is the sole completion authority.
//   - `milestone_transition`-> the milestone hierarchy no longer exists.

const FAMILY_CHOICES = Object.freeze({
  development: ['vertical', 'horizontal', 'maintain', 'recover'],
  routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
  reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
  scope_review: ['actionable', 'refine', 'needs_grounding', 'needs_user_clarification'],
})

const SCOPE_REVIEW_REASON_CODES = Object.freeze([
  'too_broad',
  'horizon_too_long',
  'step_too_vague',
  'mixed_outcomes',
  'missing_dependency',
  'completion_not_observable',
  'unsupported_completion_contract',
  'assumption_not_grounded',
  'bad_checkpoint_boundary',
])

const SCOPE_REVIEW_REASON_CODE_SET = new Set(SCOPE_REVIEW_REASON_CODES)

const PLANNING_HORIZONS = new Set(['immediate', 'checkpoint', 'subgoal', 'strategic'])

// Fields a provider might emit that would give Jev planning authority. They are
// never read into a parsed result; they are only reported for telemetry so the
// runtime can see that a provider attempted to overreach.
const FORBIDDEN_AUTHORITY_FIELDS = Object.freeze([
  'steps',
  'plan',
  'plan_steps',
  'new_plan',
  'draft',
  'draft_steps',
  'replacement_steps',
  'revised_steps',
  'rewritten_plan',
  'operations',
  'operation',
  'actions',
  'commands',
  'completion',
  'completion_contract',
  'step_contracts',
  'roadmap',
  'shelf',
  'shelf_nodes',
])

// --- one dominant development mode per slice (roadmap 4.5) -----------------
//
// A committed slice should have ONE dominant development direction. Small
// supporting work from the opposite direction is legal when it is what makes
// the slice executable at all; a draft that substantially mixes both
// directions is a scope smell and goes back to the Main LLM for a cleaner
// boundary. These two named thresholds are the whole rule.
const MIXED_DIRECTION_MINORITY_MAX_SHARE = 0.25
const MIXED_DIRECTION_MAX_SUPPORTING_STEPS = 2

const MAX_REASON_CODES = 8
const MAX_PROBLEM_STEPS = 16
const MAX_SHELF_NODES = 5
const MAX_ACTIONABLE_PREFIX = 64
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/

const CONFIDENCE_LABELS = Object.freeze({
  none: 0,
  very_low: 0.1,
  low: 0.25,
  medium: 0.6,
  moderate: 0.6,
  high: 0.9,
  very_high: 0.97,
  certain: 1,
})

function clampConfidence(value) {
  if (typeof value === 'string') {
    const label = CONFIDENCE_LABELS[value.trim().toLowerCase()]
    return typeof label === 'number' ? label : 0
  }
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0
}

function boundedInteger(value, fallback = 0, maximum = 8) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.round(value)))
    : fallback
}

function choiceOf(response, key) {
  return response?.answers?.[key]?.choice
}

function choiceConfidence(response, key) {
  return clampConfidence(response?.answers?.[key]?.confidence)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value, maximum) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > maximum ? trimmed.slice(0, maximum) : trimmed
}

function snakeCode(value, maximum = 48) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-z0-9_]{1,64}$/.test(trimmed)) return undefined
  return trimmed.length > maximum ? trimmed.slice(0, maximum) : trimmed
}

function uniqueBounded(values, limit) {
  const out = []
  for (const value of values) {
    if (value === undefined) continue
    if (out.includes(value)) continue
    out.push(value)
    if (out.length >= limit) break
  }
  return out
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

// Collects the section payload for a non-choice Jev answer. Providers are
// inconsistent about nesting, so accept both `answers.<key>` and a top-level
// `<key>` object, preferring the answers slot.
function sectionOf(response, key) {
  const fromAnswers = isPlainObject(response?.answers?.[key]) ? response.answers[key] : undefined
  const fromRoot = isPlainObject(response?.[key]) ? response[key] : undefined
  if (fromAnswers && fromRoot) return { ...fromRoot, ...fromAnswers }
  return fromAnswers ?? fromRoot ?? {}
}

function droppedAuthorityFields(...sources) {
  const found = []
  for (const source of sources) {
    if (!isPlainObject(source)) continue
    for (const field of FORBIDDEN_AUTHORITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field) && !found.includes(field)) {
        found.push(field)
      }
    }
  }
  return found
}

function providerMetadata(response) {
  return {
    model: typeof response?.model === 'string' ? response.model : undefined,
    provider: typeof response?.provider === 'string' ? response.provider : undefined,
    usage: isPlainObject(response?.usage) ? response.usage : undefined,
  }
}

export function jevDecisionFamilyChoices() {
  return FAMILY_CHOICES
}

export function jevScopeReviewReasonCodes() {
  return SCOPE_REVIEW_REASON_CODES
}

export function jevForbiddenAuthorityFields() {
  return FORBIDDEN_AUTHORITY_FIELDS
}

export function developmentDecisionQuestions() {
  return {
    development: {
      type: 'choice',
      instructions:
        'Boundary steering only. Classify the intent of the next plan slice relative to the USER GOAL and the current critical path. This is advisory planning context evaluated at a planning boundary; it does not author, mutate, or replace any committed plan. Do not equate technology with vertical or factory expansion with horizontal; classify by why the work is needed.',
      criteria: {
        vertical: 'Advance the goal critical path by unlocking a required capability or removing a prerequisite blocker. Extra production can be vertical when insufficient capacity is itself the current blocker.',
        horizontal: 'Strengthen an already-available capability for sustained or future demand: capacity, redundancy, logistics, coverage, buffers, resource access, throughput, or reliability, when the current critical path is already viable.',
        maintain: 'The current plan and capability are valid; continue ordinary execution or deterministic passive progress without strategic redirection.',
        recover: 'The world invalidated the current plan/capability and the immediate need is to restore a valid state, such as after death, destruction, stale identity, lost power, exhausted access, or another invalidating change.',
      },
    },
  }
}

export function routingDecisionQuestions() {
  return {
    routing: {
      type: 'choice',
      instructions: 'Decide whether the Main LLM must wake now. Prefer runtime continuation/wait when deterministic work is already healthy and no new strategy is required.',
      criteria: {
        wait_runtime: 'An already-started deterministic process is healthy and the runtime should wait for its condition/checkpoint without waking the Main LLM.',
        continue_runtime: 'The next bounded continuation is already parameterized and can proceed through deterministic runtime control without new strategic reasoning.',
        wake_planner: 'New semantic reasoning, decomposition, strategy, or replanning is required before safe useful progress can continue.',
      },
    },
  }
}

export function reasoningBudgetDecisionQuestions() {
  return {
    reasoning_budget: {
      type: 'choice',
      instructions: 'Choose the semantic reasoning budget for the NEXT Main LLM decision only. Do not scale budget merely because the overall user goal is long; base it on the complexity and uncertainty of the immediate decision.',
      criteria: {
        micro: 'The next decision is nearly determined by grounded state and needs minimal reasoning.',
        normal: 'The next decision is ordinary bounded planning with limited dependencies and branching.',
        deep: 'The next decision has substantial dependency depth, uncertainty, branching, or conflicting world state and merits stronger reasoning.',
        strategic: 'The next decision changes project direction, performs major decomposition, or chooses among consequential long-horizon alternatives.',
      },
    },
  }
}

/** The named §4.5 thresholds, exposed so callers and tests share one source. */
export function mixedDirectionThresholds() {
  return {
    minority_max_share: MIXED_DIRECTION_MINORITY_MAX_SHARE,
    max_supporting_steps: MIXED_DIRECTION_MAX_SUPPORTING_STEPS,
  }
}

/**
 * Detect the §4.5 scope smell from per-step development directions.
 *
 * This is a DESCRIPTION of the draft in front of Jev ("what direction is this
 * slice actually pulling in?"), not a recommendation about the next slice.
 * The steering question — "what kind of development next?" — is answered
 * separately by `parseSteeringRecommendation` (roadmap 4.9).
 *
 * `inseparable` is Jev's escape hatch for the genuinely inseparable case:
 * it downgrades the finding to a note instead of a scope smell.
 */
export function classifySliceDirection(stepDirections, { inseparable = false } = {}) {
  const classified = asArray(stepDirections)
    .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : undefined))
    .filter((value) => FAMILY_CHOICES.development.includes(value))
  const counts = { vertical: 0, horizontal: 0, maintain: 0, recover: 0 }
  for (const direction of classified) counts[direction] += 1
  const directional = counts.vertical + counts.horizontal
  const base = {
    classified_step_count: classified.length,
    directional_step_count: directional,
    counts,
    inseparable_claimed: inseparable === true,
    ...mixedDirectionThresholds(),
  }
  if (directional === 0) {
    return { ...base, dominant_direction: undefined, minority_direction: undefined, minority_step_count: 0, minority_share: 0, mixed_direction: false, supporting_work_allowed: false }
  }
  const dominant = counts.vertical >= counts.horizontal ? 'vertical' : 'horizontal'
  const minority = dominant === 'vertical' ? 'horizontal' : 'vertical'
  const minorityCount = counts[minority]
  const minorityShare = minorityCount / directional
  const withinTolerance = minorityCount <= MIXED_DIRECTION_MAX_SUPPORTING_STEPS
    && minorityShare <= MIXED_DIRECTION_MINORITY_MAX_SHARE
  return {
    ...base,
    dominant_direction: dominant,
    minority_direction: minorityCount > 0 ? minority : undefined,
    minority_step_count: minorityCount,
    minority_share: minorityShare,
    supporting_work_allowed: minorityCount > 0 && withinTolerance,
    mixed_direction: minorityCount > 0 && !withinTolerance && inseparable !== true,
  }
}

export function scopeReviewQuestions() {
  return {
    scope_review: {
      type: 'choice',
      instructions:
        'Pre-commit scope review of a DRAFT plan authored by the Main LLM. Judge only whether the draft is concrete, bounded and grounded enough to commit. You are a critic, not a planner: do not write, rewrite, reorder, or supply plan steps, completion contracts, or operations. There is no fixed maximum step count; judge semantic scope, observability of completion, bounded dependency uncertainty, and whether the slice ends at a meaningful re-observation checkpoint.',
      criteria: {
        actionable: 'The draft is concrete, bounded, grounded in verified world state, and each step has one observable semantic outcome; it can go to runtime contract validation.',
        refine: 'The draft is workable in direction but must be re-authored more narrowly or more precisely by the Main LLM, for example because it is too broad, reaches too far ahead, mixes outcomes, or ends at a poor checkpoint.',
        needs_grounding: 'The draft depends on world facts, dependencies, or completion conditions that are not currently verified; targeted observation or a supported completion contract is required before it can be judged committable.',
        needs_user_clarification: 'The draft cannot be bounded without user authority because the goal interpretation, constraints, or acceptable outcome are genuinely ambiguous. Ask the user rather than fabricating precision.',
      },
    },
    scope_review_reason_codes: {
      type: 'multi_choice',
      instructions: 'Select every reason code that applies to the draft. Return an empty list when the verdict is actionable. Do not invent new codes.',
      criteria: {
        too_broad: 'The slice covers substantially more than one bounded semantic objective.',
        horizon_too_long: 'The draft plans further ahead than the currently known world can support without likely invalidation.',
        step_too_vague: 'At least one step does not say concretely enough what must be done to choose an action now.',
        mixed_outcomes: 'A single step (or the slice) mixes multiple independent semantic outcomes or substantially mixes development directions.',
        missing_dependency: 'An obvious prerequisite capability, resource, or technology is not accounted for.',
        completion_not_observable: 'A step has no observable condition by which completion could be recognised.',
        unsupported_completion_contract: 'A step completion condition cannot be expressed by supported grounded predicates.',
        assumption_not_grounded: 'The draft assumes world facts that verified state does not establish.',
        bad_checkpoint_boundary: 'The slice ends somewhere that is not a useful re-observation or replanning checkpoint.',
      },
    },
    step_directions: {
      type: 'multi_choice',
      instructions:
        'For each draft step in order, classify the development direction that step pulls in, relative to the current critical path rather than the surface action. Use one entry per step. This DESCRIBES the draft; it is not a recommendation about what the next slice should be.',
      criteria: developmentDecisionQuestions().development.criteria,
    },
    mixed_direction_inseparable: {
      type: 'choice',
      instructions:
        'Only if the draft mixes both development directions: is the mixture genuinely inseparable, meaning the supporting work from the other direction is what makes this slice executable at all?',
      criteria: {
        yes: 'The opposite-direction work cannot be cut without making the slice unexecutable.',
        no: 'The slice could end at a cleaner boundary with one dominant direction.',
      },
    },
    actionable_prefix: {
      type: 'score',
      instructions:
        'How many leading draft steps are already committable as written. 0 means none. Use this to point at an earlier, better boundary; the deferred tail stays on the Roadmap Shelf and the Main LLM authors the next draft. Do not supply replacement steps.',
      criteria: ['count of leading draft steps that are already committable'],
    },
  }
}

export function steeringRecommendationQuestions() {
  return {
    ...developmentDecisionQuestions(),
    steering: {
      type: 'choice',
      instructions:
        'Advisory boundary steering recommendation. Return the recommended development mode for the NEXT plan slice, bounded reason codes, a one-line critical path summary, and up to five candidate Roadmap Shelf node ids to refine next. You may not author the next plan, mutate the shelf, choose operations, change a committed plan, or override explicit user priorities.',
      criteria: developmentDecisionQuestions().development.criteria,
    },
  }
}

export function decisionEnvelopeQuestions() {
  return {
    ...routingDecisionQuestions(),
    ...reasoningBudgetDecisionQuestions(),
    planning_horizon: {
      type: 'choice',
      instructions: 'Choose how far the Main LLM should plan on this wake. Use the shortest horizon that can resolve the current semantic problem.',
      criteria: {
        immediate: 'Plan only the next concrete action or tightly bounded step.',
        checkpoint: 'Plan far enough to reach the active verification checkpoint.',
        subgoal: 'Plan enough work to resolve the current bounded plan slice.',
        strategic: 'Plan or revise overall goal direction and which shelf node to refine next.',
      },
    },
    observation_budget: {
      type: 'score',
      instructions: 'Maximum count of independent targeted read-only observations justified before the planner must act, block truthfully, or return for another control decision. Choose the exact integer allowance from 0 through 8. Use 0 when current grounded evidence is enough. Runtime will clamp and enforce this budget.',
      criteria: [
        '0 additional targeted observations',
        '1 additional targeted observation',
        '2 additional targeted observations',
        '3 additional targeted observations',
        '4 additional targeted observations',
        '5 additional targeted observations',
        '6 additional targeted observations',
        '7 additional targeted observations',
        '8 additional targeted observations',
      ],
    },
  }
}

export function parseDecisionFamily(response, family, fallback) {
  const choices = FAMILY_CHOICES[family]
  if (!choices) throw new Error(`Unknown Jev decision family: ${family}`)
  const selected = choiceOf(response, family)
  const safeFallback = choices.includes(fallback) ? fallback : choices[0]
  return {
    family,
    decision: choices.includes(selected) ? selected : safeFallback,
    confidence: choiceConfidence(response, family),
    ...providerMetadata(response),
  }
}

/**
 * Pre-commit scope review (roadmap section 11).
 *
 * Returns ONLY criticism. Any provider-supplied plan steps, operations, or
 * completion contracts are dropped and reported in `dropped_authority_fields`.
 */
export function parseScopeReview(response, { draftStepCount } = {}) {
  const section = sectionOf(response, 'scope_review')
  const reasonSection = sectionOf(response, 'scope_review_reason_codes')
  const prefixSection = sectionOf(response, 'actionable_prefix')

  const directionSection = sectionOf(response, 'step_directions')
  const inseparableSection = sectionOf(response, 'mixed_direction_inseparable')

  const choices = FAMILY_CHOICES.scope_review
  const selected = choiceOf(response, 'scope_review') ?? section.choice ?? section.verdict
  let verdict = choices.includes(selected) ? selected : 'refine'

  // Roadmap 4.5: one dominant development mode per committed slice.
  const inseparableAnswer = choiceOf(response, 'mixed_direction_inseparable')
    ?? inseparableSection.choice
    ?? section.mixed_direction_inseparable
  const direction = classifySliceDirection(
    [
      ...asArray(section.step_directions),
      ...asArray(directionSection.choices),
      ...asArray(directionSection.step_directions),
      ...asArray(response?.answers?.step_directions?.choices),
    ],
    { inseparable: inseparableAnswer === 'yes' || inseparableAnswer === true },
  )

  const rawReasonCodes = [
    ...asArray(section.reason_codes),
    ...asArray(reasonSection.reason_codes),
    ...asArray(reasonSection.choices),
    ...asArray(response?.answers?.scope_review_reason_codes?.choices),
  ]
  const reason_codes = uniqueBounded(
    [
      ...rawReasonCodes.map((code) => snakeCode(code)).filter((code) => SCOPE_REVIEW_REASON_CODE_SET.has(code)),
      // A substantially mixed-direction slice IS `mixed_outcomes`; the code is
      // added deterministically so the finding cannot be reported without it.
      ...(direction.mixed_direction ? ['mixed_outcomes'] : []),
    ],
    MAX_REASON_CODES,
  )
  // A mixed slice is not committable as written: send it back for a cleaner
  // boundary. Every other verdict (needs_grounding, needs_user_clarification)
  // is a stronger objection and is left alone.
  if (direction.mixed_direction && verdict === 'actionable') verdict = 'refine'

  const rawProblemSteps = [
    ...asArray(section.problem_steps),
    ...asArray(section.problem_step_ids),
    ...asArray(section.problem_step_indices),
  ]
  const problem_steps = uniqueBounded(
    rawProblemSteps
      .map((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value))
        if (typeof value !== 'string') return undefined
        const trimmed = value.trim()
        return ID_PATTERN.test(trimmed) ? trimmed : undefined
      })
      .filter((value) => value !== undefined),
    MAX_PROBLEM_STEPS,
  )

  const prefixMaximum = typeof draftStepCount === 'number' && Number.isFinite(draftStepCount)
    ? Math.max(0, Math.min(MAX_ACTIONABLE_PREFIX, Math.trunc(draftStepCount)))
    : MAX_ACTIONABLE_PREFIX
  const rawPrefix = section.actionable_prefix
    ?? prefixSection.score
    ?? prefixSection.number
    ?? prefixSection.actionable_prefix
  const actionable_prefix = boundedInteger(rawPrefix, 0, prefixMaximum)

  return {
    family: 'scope_review',
    verdict,
    confidence: clampConfidence(
      response?.answers?.scope_review?.confidence ?? section.confidence,
    ),
    reason_codes,
    problem_steps,
    actionable_prefix,
    // Descriptive §4.5 finding about THIS draft. Deliberately not a mode
    // recommendation: steering review is a separate question (roadmap 4.9).
    dominant_direction: direction.dominant_direction,
    mixed_direction: direction.mixed_direction,
    supporting_work_allowed: direction.supporting_work_allowed,
    direction_detail: direction,
    recommended_boundary: boundedText(section.recommended_boundary ?? section.recommended_semantic_boundary, 120),
    explanation: boundedText(section.explanation ?? section.notes, 400),
    dropped_authority_fields: droppedAuthorityFields(section, reasonSection, prefixSection, directionSection, response),
    ...providerMetadata(response),
  }
}

/**
 * Bounded advisory steering recommendation (roadmap section 4.7).
 */
export function parseSteeringRecommendation(response) {
  const section = sectionOf(response, 'steering')
  const modes = FAMILY_CHOICES.development
  const rawMode = choiceOf(response, 'steering')
    ?? section.recommended_mode
    ?? section.choice
    ?? choiceOf(response, 'development')
  const recommended_mode = modes.includes(rawMode) ? rawMode : 'maintain'

  const reason_codes = uniqueBounded(
    asArray(section.reason_codes).map((code) => snakeCode(code)).filter((code) => code !== undefined),
    MAX_REASON_CODES,
  )

  const candidate_shelf_nodes = uniqueBounded(
    asArray(section.candidate_shelf_nodes)
      .map((value) => (typeof value === 'string' && ID_PATTERN.test(value.trim()) ? value.trim() : undefined))
      .filter((value) => value !== undefined),
    MAX_SHELF_NODES,
  )

  return {
    family: 'steering',
    recommended_mode,
    confidence: clampConfidence(
      section.confidence ?? response?.answers?.steering?.confidence ?? response?.answers?.development?.confidence,
    ),
    reason_codes,
    critical_path_summary: boundedText(section.critical_path_summary, 200),
    candidate_shelf_nodes,
    dropped_authority_fields: droppedAuthorityFields(section, response),
    ...providerMetadata(response),
  }
}

/**
 * Non-planning telemetry: advisory steering mode plus wake/budget shaping.
 * Replaces the old `parseHierarchyTelemetry`; there is no hierarchy any more.
 */
export function parseBoundarySteeringTelemetry(response) {
  const development = parseDecisionFamily(response, 'development', 'maintain')
  const reasoning = parseDecisionFamily(response, 'reasoning_budget', 'normal')
  const horizon = choiceOf(response, 'planning_horizon')
  return {
    development: development.decision,
    development_confidence: development.confidence,
    reasoning_budget: reasoning.decision,
    reasoning_confidence: reasoning.confidence,
    planning_horizon: PLANNING_HORIZONS.has(horizon) ? horizon : 'checkpoint',
    observation_budget: boundedInteger(
      response?.answers?.observation_budget?.score ?? response?.answers?.observation_budget?.number,
      0,
      8,
    ),
  }
}

export function parseDecisionEnvelope(response) {
  const routing = parseDecisionFamily(response, 'routing', 'wake_planner')
  const steering = parseBoundarySteeringTelemetry(response)
  return {
    routing: routing.decision,
    routing_confidence: routing.confidence,
    ...steering,
    model: routing.model,
    provider: routing.provider,
    usage: routing.usage,
  }
}

/**
 * Boundary gate. Replaces `hierarchyRuntimeGate`: with the hierarchy (and its
 * `granularity` vote) removed, the only remaining question is whether advisory
 * steering says the current direction still holds while an authoritative
 * runtime is healthy at a completion boundary.
 */
export function boundarySteeringGate(steering, { runtimeHealthy = false, boundary = 'completion' } = {}) {
  const development = FAMILY_CHOICES.development.includes(steering?.development)
    ? steering.development
    : 'maintain'
  if (boundary !== 'completion') {
    return { allow_runtime_continuation: false, reason: 'non_completion_boundary', development }
  }
  if (runtimeHealthy !== true) {
    return { allow_runtime_continuation: false, reason: 'no_authoritative_active_runtime', development }
  }
  if (development !== 'maintain') {
    return { allow_runtime_continuation: false, reason: 'steering_requires_planner', development }
  }
  return { allow_runtime_continuation: true, reason: 'maintain_with_authoritative_runtime', development }
}
