// Jev cognitive-coprocessor decision contract.
//
// Authority model (docs/NPC_JEV_COPROCESSOR_ARCHITECTURE.md):
//   - The user owns the goal.
//   - The Main LLM owns semantic planning and intent.
//   - The deterministic runtime owns world truth, admission, safety and
//     deterministic completion.
//   - Jev only shapes bounded routing, reasoning effort, typed observation
//     relevance and advisory strategic steering. Jev is never a correctness reviewer.

const FAMILY_CHOICES = Object.freeze({
  development: ['vertical', 'horizontal', 'maintain', 'recover'],
  routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
  reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
})

const PLANNING_HORIZONS = new Set(['immediate', 'checkpoint', 'subgoal', 'strategic'])

const OBSERVATION_RELEVANCE = Object.freeze({
  runtime_status: 'Read actor/task/controller status only when current runtime state can change the next planner decision.',
  inventory_equipment: 'Read inventory or equipment only when owned items, ammo, armor, or equipped state can change the next planner decision.',
  recipe_production: 'Read recipe or production-solver state only when crafting/production dependencies can change the next planner decision.',
  prototype_knowledge: 'Read prototypes or reusable skill knowledge only when static capability knowledge is missing and material to the next planner decision.',
  player_state: 'Read human-player state only when a named player position/availability is material to the next planner decision.',
  nearby_world: 'Read nearby or long-range entities/resources/enemies only when spatial world discovery is material to the next planner decision.',
  entity_status: 'Read exact entity status, geometry, or local spatial detail only when a known entity must be inspected before acting.',
  logistics_transport: 'Read logistics topology, transport capacity, or measured throughput only when transport behavior/capacity is material to the next planner decision.',
  research_state: 'Read technologies, research status, or dependency paths only when research eligibility/progress is material to the next planner decision.',
  placement_candidates: 'Read deterministic placement candidates or placement plans only when the next planner decision requires choosing where an entity can validly go.',
  construction_state: 'Read construction sites, construction-plan validation, or construction-intent inspection only when construction feasibility is material to the next planner decision.',
})

const OBSERVATION_RELEVANCE_THRESHOLD = 0.5
const OBSERVATION_RELEVANCE_MAX_SELECTED = 4

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
const MAX_SHELF_NODES = 5
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

export function observationRelevanceFamilies() {
  return Object.keys(OBSERVATION_RELEVANCE)
}

export function observationRelevanceQuestions() {
  return Object.fromEntries(
    Object.entries(OBSERVATION_RELEVANCE).map(([family, description]) => [
      `need_${family}`,
      {
        type: 'noul',
        instructions: {
          task: 'Estimate whether this deterministic observation family is useful before the NEXT Main LLM decision.',
          family,
          rules: [
            'Judge relevance only; do not invent the observation result.',
            'Prefer false when current grounded evidence is already sufficient.',
            'A true/high value is advisory. Code still applies caps, caching, and deterministic tool validation.',
          ],
        },
        criteria: {
          true: description,
          false: 'Current grounded evidence is sufficient for this family, or this family is not material to the next planner decision.',
        },
      },
    ]),
  )
}

export function parseObservationRelevance(response, {
  threshold = OBSERVATION_RELEVANCE_THRESHOLD,
  maxSelected = OBSERVATION_RELEVANCE_MAX_SELECTED,
} = {}) {
  const boundedThreshold = typeof threshold === 'number' && Number.isFinite(threshold)
    ? Math.max(0, Math.min(1, threshold))
    : OBSERVATION_RELEVANCE_THRESHOLD
  const boundedMax = Number.isSafeInteger(maxSelected)
    ? Math.max(1, Math.min(8, maxSelected))
    : OBSERVATION_RELEVANCE_MAX_SELECTED

  const probabilities = {}
  let signalCount = 0
  const ranked = []
  for (const family of observationRelevanceFamilies()) {
    const raw = response?.answers?.[`need_${family}`]?.noul
    const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    const probability = valid ? raw : 0
    probabilities[family] = probability
    if (valid) {
      signalCount++
      ranked.push({ family, probability })
    }
  }

  if (signalCount === 0) {
    const legacyAnswer = response?.answers?.observation_budget
    const legacyBudget = boundedInteger(legacyAnswer?.score ?? legacyAnswer?.number, 0, 8)
    return {
      source: legacyAnswer ? 'legacy_score_compat' : 'none',
      threshold: boundedThreshold,
      probabilities,
      selected_families: [],
      signal_count: 0,
      budget: legacyBudget,
    }
  }

  ranked.sort((left, right) => right.probability - left.probability || left.family.localeCompare(right.family))
  const selected = ranked
    .filter(entry => entry.probability >= boundedThreshold)
    .slice(0, boundedMax)
    .map(entry => entry.family)

  return {
    source: 'typed_relevance',
    threshold: boundedThreshold,
    probabilities,
    selected_families: selected,
    signal_count: signalCount,
    budget: selected.length,
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
    ...observationRelevanceQuestions(),
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
  const observation = parseObservationRelevance(response)
  return {
    development: development.decision,
    development_confidence: development.confidence,
    reasoning_budget: reasoning.decision,
    reasoning_confidence: reasoning.confidence,
    planning_horizon: PLANNING_HORIZONS.has(horizon) ? horizon : 'checkpoint',
    observation_relevance: observation,
    // Compatibility field for the existing bounded admission machinery. This
    // value is now derived by code from typed relevance, never asked as an
    // integer/Score question in the live TypeSafe contract.
    observation_budget: observation.budget,
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
