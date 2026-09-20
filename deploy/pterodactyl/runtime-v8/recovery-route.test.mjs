import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRecoveryDecision,
  recoveryDecisionQuestions,
  recoveryFailureClassHint,
  validateRecoveryRoute,
} from './recovery-route.mjs'

function response(route, failure = 'unknown', semanticScope = 'keep_target') {
  return {
    model: 'jev-latest',
    provider: 'TypeSafe',
    answers: {
      failure_class: { type: 'choice', choice: failure, confidence: 0.91 },
      next_recovery: { type: 'choice', choice: route, confidence: 0.93 },
      semantic_scope: { type: 'choice', choice: semanticScope, confidence: 0.92 },
      world_failure_supported: { type: 'noul', noul: 0.1 },
      need_fresh_observation: { type: 'noul', noul: 0.2 },
      need_semantic_replan: { type: 'noul', noul: 0.3 },
    },
    usage: { input_tokens: 90, output_tokens: 10, cost: 0.0000042 },
  }
}

test('recovery_route contract is bounded and exposes all required routing questions', () => {
  assert.deepEqual(Object.keys(recoveryDecisionQuestions()), [
    'failure_class',
    'next_recovery',
    'semantic_scope',
    'world_failure_supported',
    'need_fresh_observation',
    'need_semantic_replan',
  ])
  const parsed = parseRecoveryDecision(response('retry_compact', 'provider_format'))
  assert.equal(parsed.failure_class, 'provider_format')
  assert.equal(parsed.route, 'retry_compact')
  assert.equal(parsed.semantic_scope, 'keep_target')
  assert.equal(parsed.confidence, 0.93)
})

test('failure hint separates provider format and budget failures from world failure', () => {
  assert.equal(recoveryFailureClassHint('invalid provider JSON'), 'provider_format')
  assert.equal(recoveryFailureClassHint('finish=length output budget exhausted'), 'provider_budget')
  assert.equal(recoveryFailureClassHint('provider_output_budget_recovery_exhausted'), 'provider_budget')
  assert.equal(recoveryFailureClassHint('provider_turn_output_cap_exceeded: generation 2 used 4001 > 4000'), 'provider_budget')
  assert.equal(recoveryFailureClassHint('provider_safety_blocked content_filter'), 'provider_safety')
  assert.equal(recoveryFailureClassHint('one targeted observation is missing'), 'missing_fact')
  assert.equal(recoveryFailureClassHint('unexpected failure'), 'unknown')
})

test('wait_runtime is rejected for idle queue zero and becomes recoverable pause', () => {
  const validated = validateRecoveryRoute(parseRecoveryDecision(response('wait_runtime', 'runtime_busy')), {
    world: { task_state: 'idle', queue_length: 0 },
  })
  assert.equal(validated.route, 'pause_recoverable')
  assert.equal(validated.rejection_reason, 'wait_runtime_without_authoritative_active_runtime')
})

test('wait_runtime remains valid while authoritative world work is active', () => {
  const validated = validateRecoveryRoute(parseRecoveryDecision(response('wait_runtime', 'runtime_busy')), {
    world: { task_state: 'mining', queue_length: 1 },
  })
  assert.equal(validated.route, 'wait_runtime')
  assert.equal(validated.rejection_reason, '')
})

test('deterministic_close requires independent completion proof', () => {
  const decision = parseRecoveryDecision(response('deterministic_close', 'provider_format'))
  assert.equal(validateRecoveryRoute(decision, { finalCompletionProven: false }).route, 'fallback_runtime')
  assert.equal(validateRecoveryRoute(decision, { finalCompletionProven: true }).route, 'deterministic_close')
})

test('blocker proposal requires authoritative blocker evidence', () => {
  const decision = parseRecoveryDecision(response('propose_blocker', 'grounded_world_failure'))
  const rejected = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    evidence: [{ kind: 'provider_blocker', summary: 'model claim only' }],
  })
  assert.equal(rejected.route, 'pause_recoverable')
  assert.equal(rejected.rejection_reason, 'blocker_proposal_without_authoritative_evidence')

  const accepted = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    evidence: [{ kind: 'operation_error_receipt', summary: 'authoritative Autorio failure' }],
  })
  assert.equal(accepted.route, 'propose_blocker')
})

test('targeted observation is bounded to one admission', () => {
  const decision = parseRecoveryDecision(response('targeted_observation', 'missing_fact'))
  assert.equal(validateRecoveryRoute(decision, { observationBudgetAvailable: true }).route, 'targeted_observation')
  const rejected = validateRecoveryRoute(decision, { observationBudgetAvailable: false })
  assert.equal(rejected.route, 'fallback_runtime')
  assert.equal(rejected.rejection_reason, 'targeted_observation_budget_exhausted')
})


test('provider control-plane failures cannot route to propose_blocker even with blocker evidence', () => {
  const decision = parseRecoveryDecision(response('propose_blocker', 'provider_format'))
  const validated = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    failureClassHint: 'provider_format',
    evidence: [{ kind: 'operation_preflight_blocker', summary: 'unrelated world evidence' }],
  })
  assert.equal(validated.route, 'pause_recoverable')
  assert.equal(validated.rejection_reason, 'provider_failure_cannot_be_world_blocker')
})

test('propose_blocker requires grounded-world-failure classification as well as evidence', () => {
  const decision = parseRecoveryDecision(response('propose_blocker', 'semantic_replan'))
  const validated = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    evidence: [{ kind: 'operation_error_receipt', summary: 'authoritative receipt' }],
  })
  assert.equal(validated.route, 'pause_recoverable')
  assert.equal(validated.rejection_reason, 'blocker_proposal_requires_grounded_world_failure')
})

test('provider safety failures cannot re-enter ordinary main-provider retry routes', () => {
  const decision = parseRecoveryDecision(response('retry_compact', 'provider_safety'))
  const validated = validateRecoveryRoute(decision, {
    world: { task_state: 'idle', queue_length: 0 },
    failureClassHint: 'provider_safety',
  })
  assert.equal(validated.route, 'pause_recoverable')
  assert.equal(validated.rejection_reason, 'provider_safety_is_terminal_for_main_provider')
})


test('provider-budget semantic scope can request a target re-anchor or milestone split without implying completion', () => {
  assert.equal(parseRecoveryDecision(response('continue_low', 'provider_budget', 'reanchor_target')).semantic_scope, 'reanchor_target')
  assert.equal(parseRecoveryDecision(response('replan_high', 'provider_budget', 'split_milestone')).semantic_scope, 'keep_target', 'retired hierarchy scope must fail closed to non-writing recovery')
})
