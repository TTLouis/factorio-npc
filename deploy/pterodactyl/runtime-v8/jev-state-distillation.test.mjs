import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseTypedStateDistillation,
  renderTypedStateContext,
  typedStateDistillationQuestions,
  typedStateProvenance,
} from './jev-decision-taxonomy.mjs'

test('M8 state distillation is bounded to Choice Score Score Noul primitives', () => {
  const questions = typedStateDistillationQuestions()
  assert.deepEqual(Object.keys(questions), [
    'state_bottleneck',
    'state_readiness',
    'state_risk',
    'state_evidence_conflict',
  ])
  assert.equal(questions.state_bottleneck.type, 'choice')
  assert.deepEqual(Object.keys(questions.state_bottleneck.criteria), [
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
  assert.equal(questions.state_readiness.type, 'score')
  assert.equal(questions.state_readiness.criteria.length, 5)
  assert.equal(questions.state_risk.type, 'score')
  assert.equal(questions.state_risk.criteria.length, 4)
  assert.equal(questions.state_evidence_conflict.type, 'noul')
  assert.deepEqual(Object.keys(questions.state_evidence_conflict.criteria), ['true', 'false'])
})

test('M8 parser accepts only bounded typed answers and code-owned provenance', () => {
  const parsed = parseTypedStateDistillation({
    answers: {
      state_bottleneck: { choice: 'power', confidence: 0.91 },
      state_readiness: { score: 2.75, confidence: 0.73 },
      state_risk: { score: 1.5, confidence: 0.66 },
      state_evidence_conflict: { noul: 0.24 },
      plan: { steps: ['provider must not own this'] },
    },
    provenance: ['provider_fake_source'],
    completion: true,
  }, {
    provenance: ['task_board', 'autorio_status', 'deterministic_evidence:2', 'bad provenance with spaces'],
  })

  assert.deepEqual(parsed, {
    available: true,
    bottleneck: 'power',
    bottleneck_confidence: 0.91,
    readiness_score: 2.75,
    readiness_confidence: 0.73,
    risk_score: 1.5,
    risk_confidence: 0.66,
    evidence_conflict_probability: 0.24,
    provenance: ['task_board', 'autorio_status', 'deterministic_evidence:2'],
  })
  assert.equal(Object.hasOwn(parsed, 'plan'), false)
  assert.equal(Object.hasOwn(parsed, 'completion'), false)
})

test('M8 provenance is a deterministic inventory of supplied authoritative state sections', () => {
  assert.deepEqual(typedStateProvenance({
    task_board: { active_index: 1 },
    autorio: { task_state: 'idle' },
    deterministic_evidence: [{ ref: 'a' }, { ref: 'b' }],
    dependency_context: { node: 'x' },
    skills: [{ id: 'one' }],
    persistent_runtime: { kind: 'follow' },
    condition_wait: { kind: 'inventory_count' },
    failure: 'placement blocked',
    dialogue: ['must not be provenance'],
  }), [
    'task_board',
    'autorio_status',
    'deterministic_evidence:2',
    'dependency_context',
    'skill_context:1',
    'persistent_runtime',
    'condition_wait',
    'failure',
  ])
})

test('M8 renderer is deterministic advisory context, not generated prose or authority', () => {
  const rendered = renderTypedStateContext({
    available: true,
    bottleneck: 'research',
    bottleneck_confidence: 0.8,
    readiness_score: 1.25,
    readiness_confidence: 0.6,
    risk_score: 2,
    risk_confidence: 0.7,
    evidence_conflict_probability: 0.1,
    provenance: ['task_board', 'autorio_status'],
  })

  assert.match(rendered, /^\[JEV_TYPED_STATE\]/)
  assert.match(rendered, /bottleneck=research confidence=0\.80/)
  assert.match(rendered, /readiness_score=1\.25\/4/)
  assert.match(rendered, /risk_score=2\.00\/3/)
  assert.match(rendered, /provenance=task_board,autorio_status/)
  assert.doesNotMatch(rendered, /steps|operations|completion=true/)
})

test('M8 malformed or absent answers render no synthetic state', () => {
  const parsed = parseTypedStateDistillation({
    answers: {
      state_bottleneck: { choice: 'teleportation' },
      state_readiness: { score: 99, confidence: 1 },
      state_risk: { score: -1, confidence: 1 },
      state_evidence_conflict: { noul: 1.5 },
    },
  }, { provenance: ['task_board'] })
  assert.equal(parsed.available, false)
  assert.equal(renderTypedStateContext(parsed), '')
})
