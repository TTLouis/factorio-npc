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

const DEPRECATED_FAMILY_CHOICES = Object.freeze({
  granularity: ['keep', 'split', 'collapse'],
  milestone_transition: ['advance_next', 'replan_project', 'project_complete_candidate'],
})

export function parseDecisionFamily(response, family, fallback) {
  // DEPRECATED_FAMILY_CHOICES is part of the retirement shim at the end of this
  // file. Retired families must degrade rather than throw: npc-agent-loop.mjs
  // still calls this with 'granularity', and throwing there routes the whole
  // decision down the provider-failure path. Delete this fallback with the shim.
  const choices = FAMILY_CHOICES[family] ?? DEPRECATED_FAMILY_CHOICES[family]
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

  const choices = FAMILY_CHOICES.scope_review
  const selected = choiceOf(response, 'scope_review') ?? section.choice ?? section.verdict
  const verdict = choices.includes(selected) ? selected : 'refine'

  const rawReasonCodes = [
    ...asArray(section.reason_codes),
    ...asArray(reasonSection.reason_codes),
    ...asArray(reasonSection.choices),
    ...asArray(response?.answers?.scope_review_reason_codes?.choices),
  ]
  const reason_codes = uniqueBounded(
    rawReasonCodes.map((code) => snakeCode(code)).filter((code) => SCOPE_REVIEW_REASON_CODE_SET.has(code)),
    MAX_REASON_CODES,
  )

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
    recommended_boundary: boundedText(section.recommended_boundary ?? section.recommended_semantic_boundary, 120),
    explanation: boundedText(section.explanation ?? section.notes, 400),
    dropped_authority_fields: droppedAuthorityFields(section, reasonSection, prefixSection, response),
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

// ---------------------------------------------------------------------------
// DEPRECATED HIERARCHY COMPATIBILITY SHIM — SCAFFOLDING, NOT ARCHITECTURE.
//
// docs/NPC_PLANNING_ROADMAP.md retires the granularity / completion /
// milestone_transition decision families: Jev is a pre-commit scope critic and
// has no authority to split, collapse, advance, or complete a plan.
//
// These exports exist for ONE reason: npc-agent-loop.mjs still imports them, so
// removing them outright makes the whole runtime fail at module load. They keep
// the import graph resolvable while the call sites are removed.
//
// DELETE THIS ENTIRE BLOCK at deletion Step 6 (see the integration plan), once
// npc-agent-loop.mjs no longer consumes hierarchy telemetry. Nothing new should
// import from here. If you are adding a caller, you are going the wrong way.
// ---------------------------------------------------------------------------

function parseDeprecatedFamily(response, family, fallback) {
  const choices = DEPRECATED_FAMILY_CHOICES[family]
  const selected = choiceOf(response, family)
  const safeFallback = choices.includes(fallback) ? fallback : choices[0]
  return {
    family,
    decision: choices.includes(selected) ? selected : safeFallback,
    confidence: choiceConfidence(response, family),
    ...providerMetadata(response),
  }
}

/** @deprecated Retired by the planning roadmap. Replaced by scopeReviewQuestions(). */
export function granularityDecisionQuestions() {
  return {
    granularity: {
      type: 'choice',
      instructions: 'DEPRECATED. Judge only whether the current semantic objective is at the right level for bounded planning/execution. Do not invent the decomposition itself; the Main LLM owns how a split is written.',
      criteria: {
        keep: 'The current objective is already a bounded milestone or plan-step-sized problem and can be planned/executed without another hierarchy layer.',
        split: 'The current objective spans multiple independently verifiable capability changes or phases and should be decomposed before direct execution.',
        collapse: 'The current decomposition is unnecessarily fragmented and adjacent work can safely be represented as one coherent semantic objective.',
      },
    },
  }
}

/** @deprecated Retired by the planning roadmap. Milestones no longer exist. */
export function milestoneTransitionDecisionQuestions() {
  return {
    milestone_transition: {
      type: 'choice',
      instructions: 'DEPRECATED. The current milestone has already been authoritatively verified complete by runtime outcome authority. Decide what strategic transition is needed next. Do not claim project completion yourself and do not invent milestone content.',
      criteria: {
        advance_next: 'The first tentative next milestone is still a sensible immediate continuation of the user project from the current world state.',
        replan_project: 'The queued next milestone is missing, stale, poorly scoped, or no longer the best immediate continuation; wake the Main LLM to choose a new bounded milestone.',
        project_complete_candidate: 'The evidence suggests the user-level project goal itself may now be satisfied; wake the Main LLM for grounded final-goal verification rather than completing it here.',
      },
    },
  }
}

/** @deprecated Retired by the planning roadmap. */
export function parseMilestoneTransitionDecision(response) {
  return parseDeprecatedFamily(response, 'milestone_transition', 'replan_project')
}

/** @deprecated Retired by the planning roadmap. Use parseBoundarySteeringTelemetry(). */
export function parseHierarchyTelemetry(response) {
  const granularity = parseDeprecatedFamily(response, 'granularity', 'keep')
  const steering = parseBoundarySteeringTelemetry(response)
  return {
    granularity: granularity.decision,
    granularity_confidence: granularity.confidence,
    ...steering,
  }
}

/** @deprecated Retired by the planning roadmap. Use boundarySteeringGate(). */
export function hierarchyRuntimeGate(hierarchy, { runtimeHealthy = false, boundary = 'completion' } = {}) {
  const granularity = DEPRECATED_FAMILY_CHOICES.granularity.includes(hierarchy?.granularity)
    ? hierarchy.granularity
    : 'keep'
  const gate = boundarySteeringGate(hierarchy, { runtimeHealthy, boundary })
  if (gate.allow_runtime_continuation && granularity !== 'keep') {
    return { allow_runtime_continuation: false, reason: 'granularity_requires_planner', granularity, development: gate.development }
  }
  return {
    ...gate,
    reason: gate.reason === 'steering_requires_planner' ? 'development_requires_planner' : gate.reason,
    granularity,
  }
}
