import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRecoveryDecision,
  recoveryDecisionQuestions,
  recoveryFailureClassHint,
  validateRecoveryRoute,
} from './recovery-route.mjs'

function response(route, failure = 'unknown') {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      failure_class: { type: 'choice', choice: failure, confidence: 0.91 },
      next_recovery: { type: 'choice', choice: route, confidence: 0.93 },
    },
    usage: { input_tokens: 90, output_tokens: 10, cost: 0.0000042 },
  }
}

test('M9 recovery contract exposes only canonical control-plane routes', () => {
  const questions = recoveryDecisionQuestions()
  assert.deepEqual(Object.keys(questions), ['failure_class', 'next_recovery'])
  assert.deepEqual(Object.keys(questions.next_recovery.criteria), [
    'continue_runtime',
    'observe',
    'wake_planner',
    'ask_user',
  ])
  assert.doesNotMatch(JSON.stringify(questions), /deterministic_close|propose_blocker|replan_high|retry_compact/)
  const parsed = parseRecoveryDecision(response('wake_planner', 'provider_format'))
  assert.equal(parsed.failure_class, 'provider_format')
  assert.equal(parsed.route, 'wake_planner')
  assert.equal(parsed.confidence, 0.93)
})

test('failure hint separates provider control-plane failures from world/reasoning failures', () => {
  assert.equal(recoveryFailureClassHint('invalid provider JSON'), 'provider_format')
  assert.equal(recoveryFailureClassHint('finish=length output budget exhausted'), 'provider_budget')
  assert.equal(recoveryFailureClassHint('provider_safety_blocked content_filter'), 'provider_safety')
  assert.equal(recoveryFailureClassHint('one targeted observation is missing'), 'missing_fact')
  assert.equal(recoveryFailureClassHint('strategy dependency changed'), 'semantic_replan')
  assert.equal(recoveryFailureClassHint('unexpected failure'), 'unknown')
})

test('continue_runtime requires authoritative active runtime', () => {
  const decision = parseRecoveryDecision(response('continue_runtime', 'runtime_busy'))
  const active = validateRecoveryRoute(decision, {
    world: { task_state: 'mining', queue_length: 1 },
  })
  assert.equal(active.route, 'wait_runtime')
  assert.equal(active.rejection_reason, '')

  const idle = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
  })
  assert.equal(idle.route, 'wake_planner')
  assert.equal(idle.rejection_reason, 'continue_runtime_without_authoritative_active_runtime')
})

test('observe is bounded by deterministic observation admission', () => {
  const decision = parseRecoveryDecision(response('observe', 'missing_fact'))
  assert.equal(validateRecoveryRoute(decision, { observationBudgetAvailable: true }).route, 'targeted_observation')
  const rejected = validateRecoveryRoute(decision, { observationBudgetAvailable: false })
  assert.equal(rejected.route, 'wake_planner')
  assert.equal(rejected.rejection_reason, 'targeted_observation_budget_exhausted')
})

test('ask_user requires an already-authoritative user lifecycle boundary', () => {
  const decision = parseRecoveryDecision(response('ask_user', 'grounded_world_failure'))
  const rejected = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    userDecisionRequired: false,
  })
  assert.equal(rejected.route, 'wake_planner')
  assert.equal(rejected.rejection_reason, 'ask_user_without_authoritative_user_boundary')

  const accepted = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    userDecisionRequired: true,
  })
  assert.equal(accepted.route, 'ask_user')
})

test('provider safety failures cannot re-enter ordinary provider routes', () => {
  for (const route of ['observe', 'wake_planner']) {
    const decision = parseRecoveryDecision(response(route, 'provider_safety'))
    const validated = validateRecoveryRoute(decision, {
      world: { task_state: 'idle', queue_length: 0 },
      failureClassHint: 'provider_safety',
    })
    assert.equal(validated.route, 'pause_recoverable')
    assert.equal(validated.rejection_reason, 'provider_safety_is_terminal_for_main_provider')
  }
})

test('legacy recovery route names parse only into canonical non-authoritative routes', () => {
  assert.equal(parseRecoveryDecision(response('wait_runtime', 'runtime_busy')).route, 'continue_runtime')
  assert.equal(parseRecoveryDecision(response('targeted_observation', 'missing_fact')).route, 'observe')
  assert.equal(parseRecoveryDecision(response('replan_high', 'semantic_replan')).route, 'wake_planner')
  assert.equal(parseRecoveryDecision(response('propose_blocker', 'grounded_world_failure')).route, 'ask_user')
  assert.equal(parseRecoveryDecision(response('deterministic_close', 'provider_format')).route, 'wake_planner')
})
