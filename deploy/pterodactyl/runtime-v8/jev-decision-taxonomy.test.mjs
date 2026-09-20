import test from 'node:test'
import assert from 'node:assert/strict'

import {
  boundarySteeringGate,
  classifySliceDirection,
  mixedDirectionThresholds,
  decisionEnvelopeQuestions,
  developmentDecisionQuestions,
  jevDecisionFamilyChoices,
  jevForbiddenAuthorityFields,
  jevScopeReviewReasonCodes,
  parseBoundarySteeringTelemetry,
  parseDecisionEnvelope,
  parseDecisionFamily,
  parseScopeReview,
  parseSteeringRecommendation,
  reasoningBudgetDecisionQuestions,
  routingDecisionQuestions,
  scopeReviewQuestions,
  steeringRecommendationQuestions,
} from './jev-decision-taxonomy.mjs'

const MODULE = './jev-decision-taxonomy.mjs'

test('exposes only the surviving bounded Jev decision families', () => {
  assert.deepEqual(jevDecisionFamilyChoices(), {
    development: ['vertical', 'horizontal', 'maintain', 'recover'],
    routing: ['wait_runtime', 'continue_runtime', 'wake_planner'],
    reasoning_budget: ['micro', 'normal', 'deep', 'strategic'],
    scope_review: ['actionable', 'refine', 'needs_grounding', 'needs_user_clarification'],
  })
})

test('removed families hold no authority in the canonical contract', async () => {
  const module = await import(MODULE)
  const choices = jevDecisionFamilyChoices()
  for (const family of ['granularity', 'completion', 'milestone_transition']) {
    assert.equal(Object.prototype.hasOwnProperty.call(choices, family), false, `${family} must not be a family`)
  }
  // completion is fully gone: runtime evidence is the sole completion authority
  // and nothing imports this entry point, so it needed no retirement shim.
  assert.equal(module.completionDecisionQuestions, undefined)
  assert.throws(() => parseDecisionFamily({ answers: {} }, 'completion', 'incomplete'), /Unknown Jev decision family/)
})

// TRIPWIRE, now inverted. The retired hierarchy shim at the foot of
// jev-decision-taxonomy.mjs has been deleted (deletion Step 6). These names must
// stay gone: Jev is a pre-commit scope critic with no authority to split,
// collapse, advance, or complete a plan. If one of these assertions fails,
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
    assert.equal(parseScopeReview(hostile).verdict, 'refine')
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

// --- pre-commit scope review ------------------------------------------------

test('scope review question set is criticism-only and enumerates the roadmap codes', () => {
  const questions = scopeReviewQuestions()
  assert.equal(questions.scope_review.type, 'choice')
  assert.deepEqual(Object.keys(questions.scope_review.criteria), [
    'actionable',
    'refine',
    'needs_grounding',
    'needs_user_clarification',
  ])
  assert.match(questions.scope_review.instructions, /critic, not a planner/i)
  assert.match(questions.scope_review.instructions, /do not write, rewrite, reorder, or supply plan steps/i)
  assert.match(questions.scope_review.instructions, /no fixed maximum step count/i)
  assert.deepEqual(Object.keys(questions.scope_review_reason_codes.criteria), jevScopeReviewReasonCodes())
  assert.equal(questions.actionable_prefix.type, 'score')
  assert.match(questions.actionable_prefix.instructions, /Do not supply replacement steps/i)
})

test('reason code vocabulary matches roadmap section 11 exactly', () => {
  assert.deepEqual(jevScopeReviewReasonCodes(), [
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
  assert.throws(() => jevScopeReviewReasonCodes().push('anything'))
})

test('parses the representative refine response from roadmap 5.2', () => {
  const parsed = parseScopeReview({
    answers: {
      scope_review: {
        choice: 'refine',
        confidence: 0.8,
        reason_codes: ['horizon_too_long', 'step_too_vague'],
        actionable_prefix: 3,
        problem_steps: ['draft_step_4'],
        recommended_boundary: 'first_stable_smelting_checkpoint',
        explanation: 'Stop at stable smelting; the tail assumes oil that does not exist yet.',
      },
    },
    model: 'jev-scope',
    provider: 'jev',
  }, { draftStepCount: 6 })

  assert.deepEqual(parsed, {
    family: 'scope_review',
    verdict: 'refine',
    confidence: 0.8,
    reason_codes: ['horizon_too_long', 'step_too_vague'],
    problem_steps: ['draft_step_4'],
    actionable_prefix: 3,
    recommended_boundary: 'first_stable_smelting_checkpoint',
    explanation: 'Stop at stable smelting; the tail assumes oil that does not exist yet.',
    dominant_direction: undefined,
    mixed_direction: false,
    supporting_work_allowed: false,
    direction_detail: classifySliceDirection([]),
    dropped_authority_fields: [],
    model: 'jev-scope',
    provider: 'jev',
    usage: undefined,
  })
})

test('scope review accepts a verdict alias and a top-level section', () => {
  const parsed = parseScopeReview({ scope_review: { verdict: 'needs_user_clarification', confidence: 'high' } })
  assert.equal(parsed.verdict, 'needs_user_clarification')
  assert.equal(parsed.confidence, 0.9)
})

test('scope review falls back to refine and drops unknown reason codes', () => {
  const parsed = parseScopeReview({
    answers: {
      scope_review: {
        choice: 'ship_it',
        confidence: 'wildly confident',
        reason_codes: ['too_broad', 'TOO_BROAD', 'make_it_better', 42, null, { code: 'x' }, 'bad-code'],
        problem_steps: ['ok_step', 'not ok step', '<script>', 7, {}],
      },
    },
  })
  assert.equal(parsed.verdict, 'refine')
  assert.equal(parsed.confidence, 0)
  assert.deepEqual(parsed.reason_codes, ['too_broad'])
  assert.deepEqual(parsed.problem_steps, ['ok_step', '7'])
  assert.equal(parsed.recommended_boundary, undefined)
  assert.equal(parsed.explanation, undefined)
})

test('actionable_prefix is bounded by the draft step count and never negative', () => {
  const at = (value, opts) => parseScopeReview({ answers: { scope_review: { choice: 'refine', actionable_prefix: value } } }, opts).actionable_prefix
  assert.equal(at(3, { draftStepCount: 6 }), 3)
  assert.equal(at(9, { draftStepCount: 6 }), 6)
  assert.equal(at(-4, { draftStepCount: 6 }), 0)
  assert.equal(at(2.6, { draftStepCount: 6 }), 3)
  assert.equal(at(5, { draftStepCount: 0 }), 0)
  assert.equal(at(1e9, {}), 64)
  assert.equal(at('three', { draftStepCount: 6 }), 0)
  assert.equal(at(Number.NaN, { draftStepCount: 6 }), 0)
  assert.equal(at(Number.POSITIVE_INFINITY, { draftStepCount: 6 }), 0)
  assert.equal(at(3, { draftStepCount: 'six' }), 3)
  assert.equal(at(3, { draftStepCount: -2 }), 0)
})

test('scope review truncates unbounded free text', () => {
  const parsed = parseScopeReview({
    answers: {
      scope_review: {
        choice: 'refine',
        recommended_boundary: 'b'.repeat(500),
        explanation: 'e'.repeat(5000),
      },
    },
  })
  assert.equal(parsed.recommended_boundary.length, 120)
  assert.equal(parsed.explanation.length, 400)
})

test('scope review caps list sizes so a provider cannot flood the planner', () => {
  const parsed = parseScopeReview({
    answers: {
      scope_review: {
        choice: 'refine',
        reason_codes: jevScopeReviewReasonCodes(),
        problem_steps: Array.from({ length: 50 }, (_, i) => `step_${i}`),
      },
    },
  })
  assert.equal(parsed.reason_codes.length, 8)
  assert.equal(parsed.problem_steps.length, 16)
})

// --- dropped authority guarantees ------------------------------------------

test('Jev cannot return replacement plan steps, contracts, or operations', () => {
  const hostile = {
    answers: {
      scope_review: {
        choice: 'refine',
        reason_codes: ['too_broad'],
        actionable_prefix: 2,
        // authority overreach the provider must never be able to exercise
        steps: [{ step_id: 'x', description: 'mine coal' }],
        plan_steps: [{ step_id: 'y' }],
        replacement_steps: [{ step_id: 'z' }],
        new_plan: { version: 9 },
        operations: [{ name: 'place_entity', args: { entity: 'stone-furnace' } }],
        actions: ['walk'],
        completion: { kind: 'inventory_at_least', item: 'stone', count: 10 },
        completion_contract: { kind: 'entity_configured_and_operational' },
        shelf_nodes: ['roadmap_hacked'],
      },
    },
  }
  const parsed = parseScopeReview(hostile, { draftStepCount: 4 })

  assert.deepEqual(Object.keys(parsed).sort(), [
    'actionable_prefix',
    'confidence',
    'direction_detail',
    'dominant_direction',
    'dropped_authority_fields',
    'explanation',
    'family',
    'mixed_direction',
    'model',
    'problem_steps',
    'provider',
    'recommended_boundary',
    'reason_codes',
    'supporting_work_allowed',
    'usage',
    'verdict',
  ].sort())

  const serialized = JSON.stringify(parsed)
  assert.doesNotMatch(serialized, /place_entity|stone-furnace|mine coal|roadmap_hacked/)
  for (const field of ['steps', 'plan_steps', 'replacement_steps', 'new_plan', 'operations', 'actions', 'completion', 'completion_contract', 'shelf_nodes']) {
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, field), false, `${field} must be dropped`)
    assert.ok(parsed.dropped_authority_fields.includes(field), `${field} should be reported as dropped`)
  }
  // the legitimate criticism still survives
  assert.equal(parsed.verdict, 'refine')
  assert.equal(parsed.actionable_prefix, 2)
  assert.deepEqual(parsed.reason_codes, ['too_broad'])
})

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

// --- roadmap 4.5: one dominant development mode per committed slice ----------

test('the scope review asks for per-step direction relative to the critical path', () => {
  const questions = scopeReviewQuestions()
  assert.equal(questions.step_directions.type, 'multi_choice')
  assert.match(questions.step_directions.instructions, /relative to the current critical path rather than the surface action/i)
  assert.match(questions.step_directions.instructions, /DESCRIBES the draft/)
  assert.deepEqual(Object.keys(questions.step_directions.criteria), ['vertical', 'horizontal', 'maintain', 'recover'])
  // Tripwire, not an omission: Jev is never asked whether a mixture is
  // inseparable. That was an unverifiable model claim suppressing the §4.5
  // finding; the boundary call belongs to the Main LLM.
  assert.equal(questions.mixed_direction_inseparable, undefined)
})

test('mixed-direction classification uses named thresholds, not magic numbers', () => {
  const thresholds = mixedDirectionThresholds()
  assert.equal(thresholds.minority_max_share, 0.25)
  assert.equal(thresholds.max_supporting_steps, 2)

  // No directional information at all is not a smell.
  const silent = classifySliceDirection([])
  assert.equal(silent.mixed_direction, false)
  assert.equal(silent.dominant_direction, undefined)

  // Small supporting work from the other direction: the minimum extra power a
  // vertical oil slice needs (roadmap 4.5) stays committable.
  const supporting = classifySliceDirection(['vertical', 'vertical', 'vertical', 'horizontal'])
  assert.equal(supporting.dominant_direction, 'vertical')
  assert.equal(supporting.minority_direction, 'horizontal')
  assert.equal(supporting.supporting_work_allowed, true)
  assert.equal(supporting.mixed_direction, false)

  // A slice pulling substantially both ways is a scope smell.
  const smell = classifySliceDirection(['vertical', 'horizontal', 'horizontal', 'vertical'])
  assert.equal(smell.mixed_direction, true)
  assert.equal(smell.minority_share, 0.5)

  // ...and no second argument can talk it out of that.
  const claimed = classifySliceDirection(['vertical', 'horizontal', 'horizontal', 'vertical'], { inseparable: true })
  assert.equal(claimed.mixed_direction, true)
  assert.equal(claimed.inseparable_claimed, undefined)

  // maintain/recover steps are not directions and do not create a mixture.
  const undirected = classifySliceDirection(['vertical', 'maintain', 'recover', 'vertical'])
  assert.equal(undirected.mixed_direction, false)
  assert.equal(undirected.directional_step_count, 2)
})

test('a substantially mixed draft cannot be reported as actionable', () => {
  const parsed = parseScopeReview({
    answers: {
      scope_review: {
        choice: 'actionable',
        confidence: 0.9,
        step_directions: ['vertical', 'horizontal', 'horizontal', 'vertical'],
      },
    },
  }, { draftStepCount: 4 })

  assert.equal(parsed.verdict, 'refine', 'a scope smell goes back for a cleaner boundary')
  assert.ok(parsed.reason_codes.includes('mixed_outcomes'), 'the existing reason code carries the finding')
  assert.equal(parsed.mixed_direction, true)
  assert.equal(parsed.dominant_direction, 'vertical')
  assert.equal(parsed.supporting_work_allowed, false)
})

test('a claimed inseparable mixture no longer buys its way out; supporting work still does', () => {
  // An even vertical/horizontal split is a 50% minority share -- well past the
  // tolerance. It used to pass review purely because the flag said so, which is
  // the whole reason the flag is gone. It is sent back however loudly the
  // provider insists the mixture cannot be cut.
  for (const directions of [['vertical', 'horizontal'], ['vertical', 'horizontal', 'horizontal', 'vertical']]) {
    const insisted = parseScopeReview({
      answers: {
        scope_review: { choice: 'actionable', step_directions: directions },
        mixed_direction_inseparable: { choice: 'yes' },
      },
    }, { draftStepCount: directions.length })
    assert.equal(insisted.verdict, 'refine')
    assert.equal(insisted.mixed_direction, true)
    assert.ok(insisted.reason_codes.includes('mixed_outcomes'))
  }

  const supporting = parseScopeReview({
    answers: {
      scope_review: { choice: 'actionable' },
      step_directions: { choices: ['vertical', 'vertical', 'vertical', 'horizontal'] },
    },
  }, { draftStepCount: 4 })
  assert.equal(supporting.verdict, 'actionable')
  assert.equal(supporting.supporting_work_allowed, true)
  assert.deepEqual(supporting.reason_codes, [])
})

// --- roadmap 4.9: steering review and scope review are separate questions ----

test('steering review and scope review stay separate questions', () => {
  const scope = parseScopeReview({
    answers: { scope_review: { choice: 'refine', step_directions: ['vertical', 'horizontal', 'horizontal'] } },
  }, { draftStepCount: 3 })
  const steering = parseSteeringRecommendation({
    answers: { steering: { choice: 'horizontal', confidence: 'high' } },
    steering: {
      reason_codes: ['frontier_reached', 'power_margin_low'],
      critical_path_summary: 'stabilize oil throughput before blue science',
      candidate_shelf_nodes: ['roadmap_oil_stabilization'],
    },
  })

  // Scope review answers "is this slice committable?" and never recommends a mode.
  for (const steeringKey of ['recommended_mode', 'critical_path_summary', 'candidate_shelf_nodes']) {
    assert.equal(Object.prototype.hasOwnProperty.call(scope, steeringKey), false, `${steeringKey} belongs to steering review`)
  }
  // Steering answers "what kind of development next?" and never judges the draft.
  for (const scopeKey of ['verdict', 'actionable_prefix', 'problem_steps', 'recommended_boundary', 'mixed_direction']) {
    assert.equal(Object.prototype.hasOwnProperty.call(steering, scopeKey), false, `${scopeKey} belongs to scope review`)
  }
  assert.equal(scope.family, 'scope_review')
  assert.equal(steering.family, 'steering')
  assert.equal(steering.recommended_mode, 'horizontal')
  // The descriptive §4.5 finding is about the draft in hand, not the next slice.
  assert.equal(scope.dominant_direction, 'horizontal')
})
