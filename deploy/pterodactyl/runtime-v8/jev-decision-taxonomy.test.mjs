import test from 'node:test'
import assert from 'node:assert/strict'

import {
  boundarySteeringGate,
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  jevDecisionFamilyChoices,
  jevForbiddenAuthorityFields,
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
  assert.deepEqual(Object.keys(questions).sort(), [
    'observation_budget',
    'planning_horizon',
    'reasoning_budget',
    'routing',
  ])
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

test('decision envelope separates wake routing, reasoning, horizon, and observation allowance', () => {
  const questions = decisionEnvelopeQuestions()
  assert.equal(questions.routing.type, 'choice')
  assert.equal(questions.reasoning_budget.type, 'choice')
  assert.equal(questions.planning_horizon.type, 'choice')
  assert.equal(questions.observation_budget.type, 'score')
  assert.equal(questions.observation_budget.criteria.length, 9)
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
      steering: {
        recommended_mode: 'horizontal',
        confidence: 'high',
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

test('parses the roadmap 4.7 steering recommendation shape', () => {
  const parsed = parseSteeringRecommendation({
    answers: {
      steering: {
        recommended_mode: 'horizontal',
        confidence: 'high',
        reason_codes: ['frontier_reached', 'capacity_below_next_frontier_need', 'power_margin_low'],
        critical_path_summary: 'stabilize oil throughput before blue science',
        candidate_shelf_nodes: ['roadmap_oil_stabilization', 'roadmap_power_margin'],
      },
    },
    model: 'jev-steer',
    provider: 'jev',
    usage: { tokens: 12 },
  })
  assert.deepEqual(parsed, {
    family: 'steering',
    recommended_mode: 'horizontal',
    confidence: 0.9,
    reason_codes: ['frontier_reached', 'capacity_below_next_frontier_need', 'power_margin_low'],
    critical_path_summary: 'stabilize oil throughput before blue science',
    candidate_shelf_nodes: ['roadmap_oil_stabilization', 'roadmap_power_margin'],
    dropped_authority_fields: [],
    model: 'jev-steer',
    provider: 'jev',
    usage: { tokens: 12 },
  })
})

test('steering recommendation bounds, sanitizes and falls back safely', () => {
  const parsed = parseSteeringRecommendation({
    answers: {
      steering: {
        recommended_mode: 'sideways',
        confidence: 2,
        reason_codes: ['ok_code', 'Bad Code', '', 7, 'ok_code', 'a'.repeat(200), 'b_1', 'c_2', 'd_3', 'e_4', 'f_5', 'g_6', 'h_7', 'i_8'],
        critical_path_summary: 's'.repeat(900),
        candidate_shelf_nodes: ['roadmap_a', 'roadmap b', 'roadmap_a', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
      },
    },
  })
  assert.equal(parsed.recommended_mode, 'maintain')
  assert.equal(parsed.confidence, 1)
  assert.equal(parsed.reason_codes.length, 8)
  assert.ok(!parsed.reason_codes.includes('Bad Code'))
  assert.equal(parsed.critical_path_summary.length, 200)
  assert.deepEqual(parsed.candidate_shelf_nodes, ['roadmap_a', 'n1', 'n2', 'n3', 'n4'])
})

test('steering recommendation falls back to the development answer when no steering section exists', () => {
  const parsed = parseSteeringRecommendation({ answers: { development: { choice: 'recover', confidence: 0.5 } } })
  assert.equal(parsed.recommended_mode, 'recover')
  assert.equal(parsed.confidence, 0.5)
  assert.deepEqual(parsed.reason_codes, [])
  assert.equal(parsed.critical_path_summary, undefined)
})

test('steering question set is advisory and lists the four modes', () => {
  const questions = steeringRecommendationQuestions()
  assert.deepEqual(Object.keys(questions).sort(), ['development', 'steering'])
  assert.match(questions.steering.instructions, /advisory/i)
  assert.match(questions.steering.instructions, /may not author the next plan/i)
  assert.match(questions.steering.instructions, /mutate the shelf/i)
  assert.deepEqual(Object.keys(questions.steering.criteria), ['vertical', 'horizontal', 'maintain', 'recover'])
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
