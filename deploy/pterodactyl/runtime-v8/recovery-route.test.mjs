import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deterministicRecoveryRoute,
  parseRecoveryDecision,
  recoveryDecisionQuestions,
  recoveryFailureClassHint,
  validateRecoveryRoute,
} from './recovery-route.mjs'

function semanticResponse(semantic, observationProbability = 0.1) {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      recovery_semantics: {
        type: 'choice',
        choice: semantic,
        confidence: 0.91,
        probabilities: {
          missing_fact: semantic === 'missing_fact' ? 0.9 : 0.03,
          semantic_replan: semantic === 'semantic_replan' ? 0.9 : 0.03,
          grounded_world_failure: semantic === 'grounded_world_failure' ? 0.9 : 0.03,
          unclear: semantic === 'unclear' ? 0.9 : 0.03,
        },
      },
      one_observation_can_resolve: { type: 'noul', noul: observationProbability },
    },
    usage: { input_tokens: 60, output_tokens: 6, cost: 0.00000252 },
  }
}

function legacyResponse(route, failure = 'unknown') {
  return {
    answers: {
      failure_class: { type: 'choice', choice: failure, confidence: 0.91 },
      next_recovery: { type: 'choice', choice: route, confidence: 0.93 },
    },
  }
}

test('M11D live Jev recovery asks only ambiguous semantic questions', () => {
  const questions = recoveryDecisionQuestions()
  assert.deepEqual(Object.keys(questions), ['recovery_semantics', 'one_observation_can_resolve'])
  assert.deepEqual(Object.keys(questions.recovery_semantics.criteria), [
    'missing_fact',
    'semantic_replan',
    'grounded_world_failure',
    'unclear',
  ])
  assert.equal(questions.one_observation_can_resolve.type, 'noul')
  assert.doesNotMatch(JSON.stringify(questions), /provider_budget|provider_safety|provider_format|continue_runtime|ask_user/)
})

test('M11D one bounded observation is selected only for missing-fact semantics', () => {
  const observe = parseRecoveryDecision(semanticResponse('missing_fact', 0.9))
  assert.equal(observe.route, 'observe')
  assert.equal(observe.failure_class, 'missing_fact')
  assert.equal(observe.observation_probability, 0.9)

  for (const semantic of ['semantic_replan', 'grounded_world_failure', 'unclear']) {
    const parsed = parseRecoveryDecision(semanticResponse(semantic, 0.99))
    assert.equal(parsed.route, 'wake_planner')
  }
  assert.equal(parseRecoveryDecision(semanticResponse('missing_fact', 0.49)).route, 'wake_planner')
})

test('M11D exact recovery facts are routed deterministically before Jev', () => {
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'provider_format',
    world: { task_state: 'idle', queue_length: 0 },
  }).route, 'wake_planner')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'provider_budget',
    world: { task_state: 'idle', queue_length: 0 },
  }).route, 'wake_planner')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'provider_safety',
    world: { task_state: 'idle', queue_length: 0 },
  }).route, 'pause_recoverable')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'unknown',
    world: { task_state: 'mining', queue_length: 1 },
  }).route, 'wait_runtime')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'unknown',
    world: { task_state: 'idle', queue_length: 0 },
    userDecisionRequired: true,
  }).route, 'ask_user')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'missing_fact',
    world: { task_state: 'idle', queue_length: 0 },
    observationBudgetAvailable: false,
  }).route, 'wake_planner')
  assert.equal(deterministicRecoveryRoute({
    failureClass: 'missing_fact',
    world: { task_state: 'idle', queue_length: 0 },
    observationBudgetAvailable: true,
  }), null)
})

test('failure hint separates deterministic provider failures from ambiguous semantics', () => {
  assert.equal(recoveryFailureClassHint('invalid provider JSON'), 'provider_format')
  assert.equal(recoveryFailureClassHint('finish=length output budget exhausted'), 'provider_budget')
  assert.equal(recoveryFailureClassHint('provider_safety_blocked content_filter'), 'provider_safety')
  assert.equal(recoveryFailureClassHint('one targeted observation is missing'), 'missing_fact')
  assert.equal(recoveryFailureClassHint('strategy dependency changed'), 'semantic_replan')
  assert.equal(recoveryFailureClassHint('unexpected failure'), 'unknown')
})

test('observe remains bounded by deterministic observation admission', () => {
  const decision = parseRecoveryDecision(semanticResponse('missing_fact', 0.9))
  assert.equal(validateRecoveryRoute(decision, { observationBudgetAvailable: true }).route, 'targeted_observation')
  const rejected = validateRecoveryRoute(decision, { observationBudgetAvailable: false })
  assert.equal(rejected.route, 'wake_planner')
  assert.equal(rejected.rejection_reason, 'targeted_observation_budget_exhausted')
})

test('pre-M11D recovery responses remain parser compatibility only', () => {
  assert.equal(parseRecoveryDecision(legacyResponse('wait_runtime', 'runtime_busy')).route, 'continue_runtime')
  assert.equal(parseRecoveryDecision(legacyResponse('targeted_observation', 'missing_fact')).route, 'observe')
  assert.equal(parseRecoveryDecision(legacyResponse('replan_high', 'semantic_replan')).route, 'wake_planner')
  assert.equal(parseRecoveryDecision(legacyResponse('propose_blocker', 'grounded_world_failure')).route, 'ask_user')
  assert.equal(parseRecoveryDecision(legacyResponse('deterministic_close', 'provider_format')).route, 'wake_planner')
  assert.equal(parseRecoveryDecision(legacyResponse('replan_high', 'semantic_replan')).legacy, true)
})
