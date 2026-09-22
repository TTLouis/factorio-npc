import test from 'node:test'
import assert from 'node:assert/strict'

import {
  boundarySteeringGate,
  decisionConfidencePolicy,
  decisionConfidencePolicyCatalog,
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  jevDecisionFamilyChoices,
  jevForbiddenAuthorityFields,
  observationRelevanceFamilies,
  observationRelevancePolicy,
  parseBoundarySteeringTelemetry,
  parseDecisionEnvelope,
  parseDecisionFamily,
  parseSteeringRecommendation,
  reasoningBudgetDecisionQuestions,
  routingDecisionQuestions,
  steeringRecommendationQuestions,
} from './jev-decision-taxonomy.mjs'

const MODULE = './jev-decision-taxonomy.mjs'

test('exposes only the surviving bounded Jev decision families', () => {
  assert.deepEqual(jevDecisionFamilyChoices(), {
    development: ['vertical', 'horizontal', 'maintain', 'recover'],
    routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
    reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
  })
})

test('removed families hold no authority in the canonical contract', async () => {
  const module = await import(MODULE)
  const choices = jevDecisionFamilyChoices()
  for (const family of ['granularity', 'completion', 'milestone_transition', 'scope_review']) {
    assert.equal(Object.prototype.hasOwnProperty.call(choices, family), false, `${family} must not be a family`)
  }
  // completion is fully gone: runtime evidence is the sole completion authority
  // and nothing imports this entry point, so it needed no retirement shim.
  assert.equal(module.completionDecisionQuestions, undefined)
  assert.equal(module.scopeReviewQuestions, undefined)
  assert.equal(module.parseScopeReview, undefined)
  assert.throws(() => parseDecisionFamily({ answers: {} }, 'completion', 'incomplete'), /Unknown Jev decision family/)
  assert.throws(() => parseDecisionFamily({ answers: {} }, 'scope_review', 'refine'), /Unknown Jev decision family/)
})

// TRIPWIRE, now inverted. The retired hierarchy shim at the foot of
// jev-decision-taxonomy.mjs has been deleted (deletion Step 6). These names must
// stay gone: Jev is a cognitive coprocessor with no authority to review,
// split, collapse, advance, or complete a plan. If one of these assertions fails,
// someone has re-added retired hierarchy machinery.
test('retired hierarchy exports are gone', async () => {
  const module = await import(MODULE)
  for (const retired of [
    'granularityDecisionQuestions',
    'milestoneTransitionDecisionQuestions',
    'parseMilestoneTransitionDecision',
    'parseHierarchyTelemetry',
    'hierarchyRuntimeGate',
  ]) {
    assert.equal(module[retired], undefined, `${retired} is retired hierarchy machinery and must not exist`)
  }
  // Retired families no longer degrade — they throw. Nothing calls parseDecisionFamily
  // with these any more, so an unknown family is a programming error, not a fallback.
  assert.throws(() => parseDecisionFamily({ answers: { granularity: { choice: 'split' } } }, 'granularity', 'keep'), /Unknown Jev decision family/)
  assert.throws(() => parseDecisionFamily({ answers: {} }, 'milestone_transition', 'replan_project'), /Unknown Jev decision family/)
})

test('no removed family leaks into the wake envelope questions or parse result', () => {
  const questions = decisionEnvelopeQuestions()
  assert.deepEqual(
    Object.keys(questions).sort(),
    [
      'planning_horizon',
      'reasoning_budget',
      'routing',
      ...observationRelevanceFamilies().map(family => `need_${family}`),
    ].sort(),
  )
  const parsed = parseDecisionEnvelope({ answers: {} })
  for (const key of ['granularity', 'granularity_confidence', 'completion', 'milestone_transition']) {
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, key), false)
  }
})

// --- development, reframed as boundary steering -----------------------------

test('development is reframed as advisory boundary steering against the user goal', () => {
  const question = developmentDecisionQuestions().development
  assert.equal(question.type, 'choice')
  assert.match(question.instructions, /Boundary steering only/i)
  assert.match(question.instructions, /USER GOAL/)
  assert.match(question.instructions, /critical path/i)
  assert.match(question.instructions, /advisory/i)
  assert.match(question.instructions, /does not author, mutate, or replace any committed plan/i)
  assert.doesNotMatch(question.instructions, /milestone/i)
  // existing well-tuned criteria wording is preserved
  assert.match(question.instructions, /Do not equate technology with vertical or factory expansion with horizontal/i)
  assert.match(question.criteria.vertical, /critical path/i)
  assert.match(question.criteria.vertical, /Extra production can be vertical/i)
  assert.match(question.criteria.horizontal, /already-available capability/i)
  assert.match(question.criteria.horizontal, /critical path is already viable/i)
  assert.match(question.criteria.maintain, /without strategic redirection/i)
  assert.match(question.criteria.recover, /invalidated/i)
  for (const text of Object.values(question.criteria)) {
    assert.doesNotMatch(text, /milestone/i)
  }
})

test('M10 decision confidence policy never converts confidence into authority', () => {
  const catalog = decisionConfidencePolicyCatalog()
  assert.deepEqual(Object.keys(catalog), ['continue_runtime', 'observe', 'wake_planner', 'ask_user'])
  assert.equal(catalog.continue_runtime.deterministic_guard, 'authoritative_active_runtime')
  assert.equal(catalog.observe.deterministic_guard, 'observation_admission')
  assert.equal(catalog.wake_planner.deterministic_guard, 'main_llm_authority')
  assert.equal(catalog.ask_user.deterministic_guard, 'authoritative_user_boundary')
  for (const policy of Object.values(catalog)) assert.equal(policy.confidence_can_authorize, false)
  assert.equal(decisionConfidencePolicy('ask_user').numeric_threshold_status, 'not_applicable')
  assert.equal(decisionConfidencePolicy('wait_runtime').route, 'continue_runtime')
  assert.equal(decisionConfidencePolicy('continue_current').route, 'continue_runtime')
  assert.equal(decisionConfidencePolicy('targeted_observation').route, 'observe')
  assert.equal(decisionConfidencePolicy('replan').route, 'wake_planner')
  assert.throws(() => decisionConfidencePolicy('complete_goal'), /Unknown canonical decision route/)
})

test('M10 observation confidence policy records the existing bounded-read baseline explicitly', () => {
  assert.deepEqual(observationRelevancePolicy(), {
    probability_threshold: 0.5,
    max_selected_families: 4,
    confidence_role: 'bounded_read_relevance_only',
    calibration_status: 'existing_m7_baseline_pending_phase9_measurement',
  })
})

test('routing and reasoning budget questions are preserved and non-planning', () => {
  const routing = routingDecisionQuestions().routing
  assert.equal(routing.type, 'choice')
  assert.deepEqual(Object.keys(routing.criteria), ['wait_runtime', 'continue_runtime', 'wake_planner'])
  assert.match(routing.instructions, /whether the Main LLM must wake now/i)

  const reasoning = reasoningBudgetDecisionQuestions().reasoning_budget
  assert.equal(reasoning.type, 'choice')
  assert.deepEqual(Object.keys(reasoning.criteria), ['micro', 'normal', 'deep', 'strategic'])
  assert.match(reasoning.instructions, /Do not scale budget merely because the overall user goal is long/i)
  assert.doesNotMatch(reasoning.criteria.strategic, /milestone/i)
})

// --- envelope ---------------------------------------------------------------

test('decision envelope separates wake routing, reasoning, horizon, and typed observation relevance', () => {
  const questions = decisionEnvelopeQuestions()
  assert.equal(questions.routing.type, 'choice')
  assert.equal(questions.reasoning_budget.type, 'choice')
  assert.equal(questions.planning_horizon.type, 'choice')
  assert.equal(questions.observation_budget, undefined)
  for (const family of observationRelevanceFamilies()) {
    assert.equal(questions[`need_${family}`].type, 'noul')
  }
  assert.doesNotMatch(questions.planning_horizon.criteria.subgoal, /milestone/i)
})

test('parses valid decisions and clamps confidence and observation budget', () => {
  const response = {
    answers: {
      development: { choice: 'vertical', confidence: 1.4 },
      routing: { choice: 'wake_planner', confidence: 0.82 },
      reasoning_budget: { choice: 'deep', confidence: 0.71 },
      planning_horizon: { choice: 'subgoal' },
      observation_budget: { score: 20 },
    },
    model: 'jev-test',
    provider: 'jev',
  }
  assert.deepEqual(parseDecisionFamily(response, 'development', 'maintain'), {
    family: 'development',
    decision: 'vertical',
    confidence: 1,
    model: 'jev-test',
    provider: 'jev',
    usage: undefined,
  })
  assert.deepEqual(parseDecisionEnvelope(response), {
    routing: 'wake_planner',
    routing_confidence: 0.82,
    development: 'vertical',
    development_confidence: 1,
    reasoning_budget: 'deep',
    reasoning_confidence: 0.71,
    planning_horizon: 'subgoal',
    observation_budget: 8,
    model: 'jev-test',
    provider: 'jev',
    usage: undefined,
  })
})

test('uses conservative fallbacks for invalid Jev output', () => {
  const response = {
    answers: {
      routing: { choice: 'teleport' },
      reasoning_budget: { choice: 'infinite' },
      planning_horizon: { choice: 'whole_game' },
      observation_budget: { score: -3 },
    },
  }
  assert.equal(parseDecisionFamily(response, 'development', 'maintain').decision, 'maintain')
  assert.deepEqual(parseDecisionEnvelope(response), {
    routing: 'wake_planner',
    routing_confidence: 0,
    development: 'maintain',
    development_confidence: 0,
    reasoning_budget: 'normal',
    reasoning_confidence: 0,
    planning_horizon: 'checkpoint',
    observation_budget: 0,
    model: undefined,
    provider: undefined,
    usage: undefined,
  })
})

test('parsers survive hostile and malformed provider output', () => {
  for (const hostile of [undefined, null, 'nope', 42, [], { answers: null }, { answers: [] }, { answers: { development: 'vertical' } }]) {
    assert.equal(parseDecisionFamily(hostile, 'development', 'maintain').decision, 'maintain')
    assert.equal(parseDecisionEnvelope(hostile).routing, 'wake_planner')
    assert.equal(parseSteeringRecommendation(hostile).recommended_mode, 'maintain')
    assert.equal(parseBoundarySteeringTelemetry(hostile).planning_horizon, 'checkpoint')
  }
})

test('boundary steering telemetry stays independent from routing authority', () => {
  assert.deepEqual(
    parseBoundarySteeringTelemetry({
      answers: {
        routing: { choice: 'continue_runtime', confidence: 1 },
        development: { choice: 'horizontal', confidence: 0.84 },
        reasoning_budget: { choice: 'strategic', confidence: 0.77 },
        planning_horizon: { choice: 'strategic' },
        observation_budget: { score: 4 },
      },
    }),
    {
      development: 'horizontal',
      development_confidence: 0.84,
      reasoning_budget: 'strategic',
      reasoning_confidence: 0.77,
      planning_horizon: 'strategic',
      observation_budget: 4,
    },
  )
})

test('observation budget rounds fractional score output instead of collapsing to zero', () => {
  assert.equal(parseBoundarySteeringTelemetry({ answers: { observation_budget: { score: 3.6 } } }).observation_budget, 4)
  assert.equal(parseBoundarySteeringTelemetry({ answers: { observation_budget: { number: 2 } } }).observation_budget, 2)
  assert.equal(parseBoundarySteeringTelemetry({ answers: { observation_budget: { score: 'five' } } }).observation_budget, 0)
})

// --- dropped authority guarantees ------------------------------------------

test('steering recommendation cannot smuggle plan authority either', () => {
  const parsed = parseSteeringRecommendation({
    answers: {
      development: {
        choice: 'horizontal',
        confidence: 0.9,
        plan: { steps: ['do the thing'] },
        operations: [{ name: 'craft' }],
      },
    },
  })
  assert.equal(parsed.recommended_mode, 'horizontal')
  assert.deepEqual(parsed.dropped_authority_fields, ['plan', 'operations'])
  assert.doesNotMatch(JSON.stringify(parsed), /do the thing|craft/)
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'plan'), false)
})

test('forbidden authority field list covers step and operation shapes', () => {
  const fields = jevForbiddenAuthorityFields()
  for (const field of ['steps', 'plan', 'plan_steps', 'operations', 'completion', 'shelf']) {
    assert.ok(fields.includes(field))
  }
  assert.throws(() => jevForbiddenAuthorityFields().push('nope'))
})

// --- steering recommendation -------------------------------------------------

const STEERING_TEST_PRESSURE = {
  vertical: ['frontier_reached', 'capability_absent'],
  horizontal: ['power_margin_low', 'logistics_bottleneck'],
}

const STEERING_TEST_SHELF = [
  { id: 'roadmap_oil_stabilization', intent: 'stabilize oil throughput', status: 'ready_to_refine', development_hint: 'horizontal' },
  { id: 'roadmap_power_margin', intent: 'increase power margin', status: 'ready_to_refine', development_hint: 'horizontal' },
]

test('M11B steering is composed only from actual Choice and Noul answers', () => {
  const parsed = parseSteeringRecommendation({
    answers: {
      development: { choice: 'horizontal', confidence: 0.9 },
      pressure_frontier_reached: { type: 'noul', noul: 0.22 },
      pressure_capability_absent: { type: 'noul', noul: 0.18 },
      pressure_power_margin_low: { type: 'noul', noul: 0.94 },
      pressure_logistics_bottleneck: { type: 'noul', noul: 0.71 },
      next_shelf_node: { choice: 'node_1', confidence: 0.82 },
    },
    model: 'jev-steer',
    provider: 'jev',
    usage: { tokens: 12 },
  }, {
    candidateShelfNodes: STEERING_TEST_SHELF,
    pressureVocabulary: STEERING_TEST_PRESSURE,
  })

  assert.equal(parsed.recommended_mode, 'horizontal')
  assert.equal(parsed.confidence, 0.9)
  assert.deepEqual(parsed.reason_codes, ['power_margin_low', 'logistics_bottleneck'])
  assert.deepEqual(parsed.candidate_shelf_nodes, ['roadmap_oil_stabilization'])
  assert.equal(parsed.pressure_probabilities.power_margin_low, 0.94)
  assert.equal(parsed.pressure_threshold, 0.5)
  assert.equal(parsed.shelf_node_confidence, 0.82)
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'critical_path_summary'), false)
  assert.deepEqual(parsed.dropped_authority_fields, [])
  assert.equal(parsed.model, 'jev-steer')
  assert.equal(parsed.provider, 'jev')
})

test('M11B steering ignores old generated fields and falls back safely', () => {
  const parsed = parseSteeringRecommendation({
    answers: {
      development: { choice: 'sideways', confidence: 2 },
      steering: {
        recommended_mode: 'vertical',
        reason_codes: ['fabricated_reason'],
        critical_path_summary: 'generated prose that is no longer consumed',
        candidate_shelf_nodes: ['fabricated_node'],
      },
      pressure_power_margin_low: { type: 'noul', noul: 7 },
      next_shelf_node: { choice: 'node_99', confidence: 1 },
    },
  }, {
    candidateShelfNodes: STEERING_TEST_SHELF,
    pressureVocabulary: STEERING_TEST_PRESSURE,
  })

  assert.equal(parsed.recommended_mode, 'maintain')
  assert.equal(parsed.confidence, 1)
  assert.deepEqual(parsed.reason_codes, [])
  assert.deepEqual(parsed.candidate_shelf_nodes, [])
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'critical_path_summary'), false)
  assert.doesNotMatch(JSON.stringify(parsed), /generated prose|fabricated_node|fabricated_reason/)
})

test('steering recommendation still works with only the development head', () => {
  const parsed = parseSteeringRecommendation({ answers: { development: { choice: 'recover', confidence: 0.5 } } })
  assert.equal(parsed.recommended_mode, 'recover')
  assert.equal(parsed.confidence, 0.5)
  assert.deepEqual(parsed.reason_codes, [])
  assert.deepEqual(parsed.candidate_shelf_nodes, [])
})

test('M11B steering questions are independent typed heads over authoritative candidates', () => {
  const questions = steeringRecommendationQuestions({
    candidateShelfNodes: STEERING_TEST_SHELF,
    pressureVocabulary: STEERING_TEST_PRESSURE,
  })
  assert.equal(questions.steering, undefined)
  assert.deepEqual(Object.keys(questions.development.criteria), ['vertical', 'horizontal', 'maintain', 'recover'])
  assert.equal(questions.pressure_frontier_reached.type, 'noul')
  assert.equal(questions.pressure_power_margin_low.type, 'noul')
  assert.equal(questions.next_shelf_node.type, 'choice')
  assert.deepEqual(Object.keys(questions.next_shelf_node.criteria), ['none', 'node_1', 'node_2'])
  assert.equal(questions.next_shelf_node.criteria.node_1.node_id, 'roadmap_oil_stabilization')
  assert.match(JSON.stringify(questions.next_shelf_node.instructions), /does not author/i)
})

// --- boundary gate ----------------------------------------------------------

test('boundary gate only skips the planner for maintain on an authoritative completion runtime', () => {
  assert.deepEqual(
    boundarySteeringGate({ development: 'maintain' }, { runtimeHealthy: true, boundary: 'completion' }),
    { allow_runtime_continuation: true, reason: 'maintain_with_authoritative_runtime', development: 'maintain' },
  )
  assert.deepEqual(
    boundarySteeringGate({ development: 'vertical' }, { runtimeHealthy: true }),
    { allow_runtime_continuation: false, reason: 'steering_requires_planner', development: 'vertical' },
  )
  assert.deepEqual(
    boundarySteeringGate({ development: 'maintain' }, { runtimeHealthy: false }),
    { allow_runtime_continuation: false, reason: 'no_authoritative_active_runtime', development: 'maintain' },
  )
  assert.deepEqual(
    boundarySteeringGate({ development: 'maintain' }, { runtimeHealthy: true, boundary: 'failure' }),
    { allow_runtime_continuation: false, reason: 'non_completion_boundary', development: 'maintain' },
  )
})

test('boundary gate is defensive about garbage steering input', () => {
  for (const garbage of [undefined, null, 'maintain', 7, { development: 'sideways' }, { granularity: 'keep' }]) {
    const gate = boundarySteeringGate(garbage, { runtimeHealthy: true, boundary: 'completion' })
    assert.equal(gate.development, 'maintain')
    assert.equal(gate.allow_runtime_continuation, true)
    assert.equal(Object.prototype.hasOwnProperty.call(gate, 'granularity'), false)
  }
  assert.equal(boundarySteeringGate({ development: 'maintain' }).allow_runtime_continuation, false)
  assert.equal(boundarySteeringGate({ development: 'maintain' }, { runtimeHealthy: 'yes' }).allow_runtime_continuation, false)
})
