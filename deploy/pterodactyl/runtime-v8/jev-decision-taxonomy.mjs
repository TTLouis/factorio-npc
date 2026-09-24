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

const OBSERVATION_RELEVANCE_POLICY = Object.freeze({
  probability_threshold: 0.5,
  max_selected_families: 4,
  confidence_role: 'bounded_read_relevance_only',
  calibration_status: 'existing_m7_baseline_pending_phase9_measurement',
})

const OBSERVATION_RELEVANCE_THRESHOLD = OBSERVATION_RELEVANCE_POLICY.probability_threshold
const OBSERVATION_RELEVANCE_MAX_SELECTED = OBSERVATION_RELEVANCE_POLICY.max_selected_families

const DECISION_CONFIDENCE_POLICY = Object.freeze({
  continue_runtime: Object.freeze({
    confidence_role: 'telemetry_only',
    deterministic_guard: 'authoritative_active_runtime',
    confidence_can_authorize: false,
    numeric_threshold_status: 'pending_phase9_e2e',
  }),
  observe: Object.freeze({
    confidence_role: 'permissive_bounded_read',
    deterministic_guard: 'observation_admission',
    confidence_can_authorize: false,
    numeric_threshold_status: 'pending_phase9_e2e',
  }),
  wake_planner: Object.freeze({
    confidence_role: 'safe_reasoning_fallback',
    deterministic_guard: 'main_llm_authority',
    confidence_can_authorize: false,
    numeric_threshold_status: 'not_required',
  }),
  ask_user: Object.freeze({
    confidence_role: 'never_sufficient_for_user_authority',
    deterministic_guard: 'authoritative_user_boundary',
    confidence_can_authorize: false,
    numeric_threshold_status: 'not_applicable',
  }),
})

const DECISION_CONFIDENCE_POLICY_ALIASES = Object.freeze({
  wait_runtime: 'continue_runtime',
  continue_current: 'continue_runtime',
  targeted_observation: 'observe',
  reanchor_plan: 'wake_planner',
  replan: 'wake_planner',
  fallback_planner: 'wake_planner',
})

const TYPED_STATE_BOTTLENECKS = Object.freeze([
  'none_known',
  'materials',
  'power',
  'logistics',
  'production',
  'research',
  'spatial',
  'safety',
  'runtime_health',
  'information',
])

const TYPED_STATE_READINESS_CRITERIA = Object.freeze([
  'No grounded route is visible from the supplied evidence.',
  'Important grounded prerequisites or facts are still missing.',
  'Some useful grounded progress exists, but material uncertainty or dependency work remains.',
  'The supplied evidence supports a concrete next planner decision with limited uncertainty.',
  'The supplied evidence strongly grounds the next planner decision and its immediate dependencies.',
])

const TYPED_STATE_RISK_CRITERIA = Object.freeze([
  'Low semantic risk: the next planner decision is well bounded and easily reversible.',
  'Guarded semantic risk: mistakes are recoverable but could waste noticeable work.',
  'High semantic risk: the next planner decision has material branching, cost, or recovery burden.',
  'Critical semantic risk: the next planner decision could cause substantial irreversible or user-authority impact.',
])

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

export function observationRelevancePolicy() {
  return { ...OBSERVATION_RELEVANCE_POLICY }
}

export function decisionConfidencePolicy(route) {
  const canonicalRoute = Object.hasOwn(DECISION_CONFIDENCE_POLICY, route)
    ? route
    : DECISION_CONFIDENCE_POLICY_ALIASES[route]
  if (!canonicalRoute) throw new Error(`Unknown canonical decision route: ${route}`)
  return { route: canonicalRoute, ...DECISION_CONFIDENCE_POLICY[canonicalRoute] }
}

export function decisionConfidencePolicyCatalog() {
  return Object.fromEntries(
    Object.keys(DECISION_CONFIDENCE_POLICY).map(route => [route, decisionConfidencePolicy(route)]),
  )
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

export function typedStateDistillationQuestions() {
  return {
    state_bottleneck: {
      type: 'choice',
      instructions: {
        task: 'Classify the dominant semantic bottleneck visible in the supplied authoritative state for the NEXT Main LLM decision.',
        rules: [
          'Choose only from the supplied categories.',
          'Do not invent an unobserved world fact.',
          'This is advisory context only and never completion, admission, or plan authority.',
        ],
      },
      criteria: {
        none_known: 'No single dominant bottleneck is supported by the supplied evidence.',
        materials: 'Item, resource, fuel, or ingredient availability is the dominant constraint.',
        power: 'Electrical or other energy availability/capacity is the dominant constraint.',
        logistics: 'Movement, transport, insertion, routing, or buffering is the dominant constraint.',
        production: 'Machine capability, recipe execution, throughput, or production topology is the dominant constraint.',
        research: 'Technology prerequisites, research eligibility, or research progress is the dominant constraint.',
        spatial: 'Placement, geometry, reachability, target location, or construction-space feasibility is the dominant constraint.',
        safety: 'Combat, hostile pressure, survivability, or another safety concern is the dominant constraint.',
        runtime_health: 'A running controller, task, condition wait, or runtime lifecycle issue is the dominant constraint.',
        information: 'The dominant constraint is missing or conflicting authoritative evidence rather than a known world capability.',
      },
    },
    state_readiness: {
      type: 'score',
      instructions: {
        task: 'Score how ready the supplied authoritative state is for the NEXT Main LLM decision.',
        rules: [
          'Judge grounding/readiness only, not whether a plan is correct.',
          'Do not infer facts absent from the supplied state.',
          'The score is advisory context and cannot admit operations or close steps.',
        ],
      },
      criteria: [...TYPED_STATE_READINESS_CRITERIA],
    },
    state_risk: {
      type: 'score',
      instructions: {
        task: 'Score the semantic consequence/risk of choosing the next planner direction from the supplied evidence.',
        rules: [
          'Risk is advisory and does not grant or revoke permission.',
          'Deterministic safety, preflight, and user authority remain separate.',
        ],
      },
      criteria: [...TYPED_STATE_RISK_CRITERIA],
    },
    state_evidence_conflict: {
      type: 'noul',
      instructions: {
        task: 'Does the supplied authoritative state contain material evidence that conflicts or points in incompatible directions for the next planner decision?',
        rules: [
          'Judge only the supplied evidence.',
          'Do not create a conflict from missing information alone.',
          'This probability is advisory context, not world truth or a blocker.',
        ],
      },
      criteria: {
        true: 'Two or more supplied authoritative signals materially conflict for the next planner decision.',
        false: 'The supplied authoritative signals are mutually compatible, or no material conflict is visible.',
      },
    },
  }
}

export function typedStateProvenance(state) {
  const sources = []
  if (state?.task_board && typeof state.task_board === 'object') sources.push('task_board')
  if (state?.autorio && typeof state.autorio === 'object') sources.push('autorio_status')
  if (Array.isArray(state?.deterministic_evidence) && state.deterministic_evidence.length > 0) {
    sources.push(`deterministic_evidence:${Math.min(4, state.deterministic_evidence.length)}`)
  }
  if (state?.dependency_context && typeof state.dependency_context === 'object') sources.push('dependency_context')
  if (Array.isArray(state?.skills) && state.skills.length > 0) sources.push(`skill_context:${Math.min(8, state.skills.length)}`)
  if (state?.persistent_runtime && typeof state.persistent_runtime === 'object') sources.push('persistent_runtime')
  if (state?.condition_wait && typeof state.condition_wait === 'object') sources.push('condition_wait')
  if (typeof state?.failure === 'string' && state.failure.length > 0) sources.push('failure')
  return sources
}

function boundedScoreAnswer(response, key, maximum) {
  const answer = response?.answers?.[key]
  const score = answer?.score
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= maximum
    ? {
        score,
        confidence: clampConfidence(answer?.confidence),
      }
    : undefined
}

export function parseTypedStateDistillation(response, { provenance = [] } = {}) {
  const bottleneckAnswer = response?.answers?.state_bottleneck
  const rawBottleneck = bottleneckAnswer?.choice
  const bottleneck = TYPED_STATE_BOTTLENECKS.includes(rawBottleneck) ? rawBottleneck : undefined
  const readiness = boundedScoreAnswer(response, 'state_readiness', TYPED_STATE_READINESS_CRITERIA.length - 1)
  const risk = boundedScoreAnswer(response, 'state_risk', TYPED_STATE_RISK_CRITERIA.length - 1)
  const rawConflict = response?.answers?.state_evidence_conflict?.noul
  const evidenceConflictProbability = typeof rawConflict === 'number' && Number.isFinite(rawConflict) && rawConflict >= 0 && rawConflict <= 1
    ? rawConflict
    : undefined
  const safeProvenance = uniqueBounded(
    asArray(provenance)
      .map(value => (typeof value === 'string' && /^[a-z0-9_:-]{1,80}$/i.test(value) ? value : undefined))
      .filter(value => value !== undefined),
    12,
  )
  const available = bottleneck !== undefined
    || readiness !== undefined
    || risk !== undefined
    || evidenceConflictProbability !== undefined

  return {
    available,
    bottleneck,
    bottleneck_confidence: bottleneck === undefined ? 0 : clampConfidence(bottleneckAnswer?.confidence),
    readiness_score: readiness?.score,
    readiness_confidence: readiness?.confidence ?? 0,
    risk_score: risk?.score,
    risk_confidence: risk?.confidence ?? 0,
    evidence_conflict_probability: evidenceConflictProbability,
    provenance: safeProvenance,
  }
}

function fixedDecimal(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'unknown'
}

export function renderTypedStateContext(distillation) {
  if (!distillation?.available) return ''
  const provenance = Array.isArray(distillation.provenance) && distillation.provenance.length > 0
    ? distillation.provenance.join(',')
    : 'none'
  return [
    '[JEV_TYPED_STATE]',
    'Advisory typed semantic features derived from the authoritative evidence listed below. These are not world truth, completion evidence, plan authority, operation admission, or user authority.',
    `bottleneck=${distillation.bottleneck ?? 'unknown'} confidence=${fixedDecimal(distillation.bottleneck_confidence)}`,
    `readiness_score=${fixedDecimal(distillation.readiness_score)}/4 confidence=${fixedDecimal(distillation.readiness_confidence)}`,
    `risk_score=${fixedDecimal(distillation.risk_score)}/3 confidence=${fixedDecimal(distillation.risk_confidence)}`,
    `evidence_conflict_probability=${fixedDecimal(distillation.evidence_conflict_probability)}`,
    `provenance=${provenance}`,
    '[/JEV_TYPED_STATE]',
  ].join('\n')
}

function normalizedSteeringPressureEntries(raw) {
  const out = []
  const seen = new Set()
  const source = isPlainObject(raw) ? raw : {}
  for (const direction of ['vertical', 'horizontal']) {
    for (const value of asArray(source[direction])) {
      const code = snakeCode(value)
      if (!code || seen.has(code)) continue
      seen.add(code)
      out.push({ direction, code })
      if (out.length >= 24) return out
    }
  }
  return out
}

function normalizedSteeringShelfCandidates(raw) {
  const out = []
  const seen = new Set()
  for (const value of asArray(raw)) {
    const source = isPlainObject(value) ? value : { id: value }
    const id = boundedText(source.id, 120)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      intent: boundedText(source.intent, 400),
      status: boundedText(source.status, 80),
      development_hint: boundedText(source.development_hint, 40),
    })
    if (out.length >= 24) break
  }
  return out
}

export function steeringRecommendationQuestions({
  candidateShelfNodes = [],
  pressureVocabulary = {},
} = {}) {
  const questions = {
    ...developmentDecisionQuestions(),
  }

  for (const { direction, code } of normalizedSteeringPressureEntries(pressureVocabulary)) {
    questions[`pressure_${code}`] = {
      type: 'noul',
      instructions: {
        task: 'Judge whether the supplied authoritative planning-boundary state supports this specific steering-pressure condition.',
        direction,
        pressure_code: code,
        condition: code.replaceAll('_', ' '),
        rules: [
          'Judge only evidence present in the supplied state.',
          'This is advisory pressure provenance; it cannot create world truth or planning authority.',
          'Return false when the condition is merely plausible but not supported by the supplied state.',
        ],
      },
      criteria: {
        true: { meaning: 'The supplied state supports this named steering-pressure condition.' },
        false: { meaning: 'The supplied state does not support this named steering-pressure condition.' },
      },
    }
  }

  const shelf = normalizedSteeringShelfCandidates(candidateShelfNodes)
  if (shelf.length > 0) {
    const criteria = {
      none: 'No supplied Roadmap Shelf node should be singled out as the next refinement candidate.',
    }
    for (let index = 0; index < shelf.length; index++) {
      const node = shelf[index]
      criteria[`node_${index + 1}`] = {
        node_id: node.id,
        intent: node.intent ?? null,
        status: node.status ?? null,
        development_hint: node.development_hint ?? null,
      }
    }
    questions.next_shelf_node = {
      type: 'choice',
      instructions: {
        task: 'Select at most one supplied Roadmap Shelf node that is the most useful candidate for the NEXT Main-LLM refinement.',
        rules: [
          'Choose only from the supplied candidates or none.',
          'This does not author, mutate, commit, or execute the node.',
          'Prefer none when the supplied state does not justify singling out one candidate.',
        ],
      },
      criteria,
    }
  }

  return questions
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
export function parseSteeringRecommendation(response, {
  candidateShelfNodes = [],
  pressureVocabulary = {},
  pressureThreshold = 0.5,
} = {}) {
  const development = parseDecisionFamily(response, 'development', 'maintain')
  const pressureEntries = normalizedSteeringPressureEntries(pressureVocabulary)
  const threshold = typeof pressureThreshold === 'number' && Number.isFinite(pressureThreshold)
    ? Math.max(0, Math.min(1, pressureThreshold))
    : 0.5
  const pressure_probabilities = {}
  const reason_codes = []

  for (const { code } of pressureEntries) {
    const raw = response?.answers?.[`pressure_${code}`]?.noul
    const valid = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    if (!valid) continue
    pressure_probabilities[code] = raw
    if (raw >= threshold && reason_codes.length < MAX_REASON_CODES) reason_codes.push(code)
  }

  const shelf = normalizedSteeringShelfCandidates(candidateShelfNodes)
  const shelfAnswer = response?.answers?.next_shelf_node
  const selected = typeof shelfAnswer?.choice === 'string' ? shelfAnswer.choice : 'none'
  let candidate_shelf_nodes = []
  const match = /^node_([1-9][0-9]*)$/.exec(selected)
  if (match) {
    const index = Number(match[1]) - 1
    if (index >= 0 && index < shelf.length) candidate_shelf_nodes = [shelf[index].id]
  }

  const legacySection = sectionOf(response, 'steering')
  return {
    family: 'steering',
    recommended_mode: development.decision,
    confidence: development.confidence,
    reason_codes,
    candidate_shelf_nodes,
    pressure_probabilities,
    pressure_threshold: threshold,
    shelf_node_confidence: choiceConfidence(response, 'next_shelf_node'),
    dropped_authority_fields: droppedAuthorityFields(
      response?.answers?.development,
      legacySection,
      response,
    ),
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
