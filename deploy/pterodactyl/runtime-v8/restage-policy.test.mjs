import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contextSizeState,
  decideRestage,
  estimateTokensFromChars,
  observeContextSize,
  RESTAGE_BOUNDARY,
  RESTAGE_CHECKPOINT,
  RESTAGE_REASON,
  resetSliceBaseline,
  sliceCeilingState,
  sliceOutputUsed,
} from './restage-policy.mjs'
import { CONTEXT_RESTAGE_CHECKPOINTS } from './planning-state.mjs'

const SOFT = 100_000
const HARD = 200_000
const decide = (role, boundary, contextTokens) => decideRestage({ role, boundary, contextTokens, softLimitTokens: SOFT })

test('decision table: below the soft limit never restages at step or slice close', () => {
  for (const role of ['planner', 'executor']) {
    for (const boundary of ['step_close', 'slice_close']) {
      for (const tokens of [0, 1, SOFT - 1, SOFT]) {
        assert.deepEqual(decide(role, boundary, tokens), { restage: false, checkpoint: null, reason: RESTAGE_REASON.NONE }, `${role} ${boundary} ${tokens}`)
      }
    }
  }
})

test('decision table: past soft, a step close does not restage', () => {
  for (const role of ['planner', 'executor']) {
    assert.equal(decide(role, 'step_close', SOFT + 1).restage, false)
    assert.equal(decide(role, 'step_close', HARD).restage, false, 'the hard limit itself is not past it')
  }
})

test('decision table: past soft, the next slice close restages at C1', () => {
  for (const role of ['planner', 'executor']) {
    const decision = decide(role, 'slice_close', SOFT + 1)
    assert.deepEqual(decision, { restage: true, checkpoint: 'C1', reason: RESTAGE_REASON.SOFT_LIMIT_AT_SLICE_CLOSE })
  }
})

test('decision table: past hard, the next step close restages at C8', () => {
  for (const role of ['planner', 'executor']) {
    assert.deepEqual(decide(role, 'step_close', HARD + 1), { restage: true, checkpoint: 'C8', reason: RESTAGE_REASON.HARD_LIMIT_AT_STEP_CLOSE })
    assert.deepEqual(decide(role, 'slice_close', HARD + 1), { restage: true, checkpoint: 'C1', reason: RESTAGE_REASON.HARD_LIMIT_AT_SLICE_CLOSE })
  }
})

test('decision table: the executor is always fresh at a plan commit, the planner never is', () => {
  for (const tokens of [0, SOFT + 1, HARD + 1]) {
    assert.deepEqual(decide('executor', 'plan_commit', tokens), { restage: true, checkpoint: 'C3', reason: RESTAGE_REASON.EXECUTOR_FRESH_AT_COMMIT })
    assert.deepEqual(decide('planner', 'plan_commit', tokens), { restage: false, checkpoint: null, reason: RESTAGE_REASON.NONE })
  }
})

test('the hard limit defaults to twice the soft limit and can be set explicitly', () => {
  assert.equal(decideRestage({ role: 'executor', boundary: 'step_close', contextTokens: 2 * SOFT, softLimitTokens: SOFT }).restage, false)
  assert.equal(decideRestage({ role: 'executor', boundary: 'step_close', contextTokens: 2 * SOFT + 1, softLimitTokens: SOFT }).restage, true)
  assert.equal(decideRestage({ role: 'executor', boundary: 'step_close', contextTokens: 150, softLimitTokens: 100, hardLimitTokens: 120 }).restage, true)
})

test('every checkpoint the policy names is one the reducer accepts', () => {
  for (const checkpoint of Object.values(RESTAGE_CHECKPOINT)) assert.ok(CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint))
  assert.deepEqual(Object.values(RESTAGE_BOUNDARY).sort(), ['plan_commit', 'slice_close', 'step_close'])
})

test('bad role, boundary or limits throw; a missing token count reads as zero', () => {
  assert.throws(() => decideRestage({ role: 'jev', boundary: 'step_close', contextTokens: 1, softLimitTokens: SOFT }), RangeError)
  assert.throws(() => decideRestage({ role: 'planner', boundary: 'turn_close', contextTokens: 1, softLimitTokens: SOFT }), RangeError)
  assert.throws(() => decideRestage({ role: 'planner', boundary: 'step_close', contextTokens: 1 }), RangeError)
  assert.throws(() => decideRestage({ role: 'planner', boundary: 'step_close', contextTokens: 1, softLimitTokens: SOFT, hardLimitTokens: SOFT - 1 }), RangeError)
  assert.equal(decideRestage({ role: 'planner', boundary: 'slice_close', softLimitTokens: SOFT }).restage, false)
  assert.equal(decideRestage({ role: 'planner', boundary: 'slice_close', contextTokens: Number.NaN, softLimitTokens: SOFT }).restage, false)
})

test('the size counter is monotonic: compaction that shrinks the next prompt does not hide growth', () => {
  let state = contextSizeState()
  state = observeContextSize(state, { appendedChars: 4000 })
  assert.equal(state.tokens, estimateTokensFromChars(4000), 'before a provider reply the estimate stands in')
  state = observeContextSize(state, { appendedChars: 400, providerInputTokens: 90_000 })
  assert.equal(state.tokens, 90_000)
  // A compaction fold makes the provider report a smaller prompt.
  state = observeContextSize(state, { appendedChars: 100, providerInputTokens: 30_000 })
  assert.equal(state.tokens, 90_000, 'never falls back')
  state = observeContextSize(state, { providerInputTokens: 95_000 })
  assert.equal(state.tokens, 95_000)
  // The estimate from cumulative appended chars also keeps growing.
  let estimated = contextSizeState()
  for (let i = 0; i < 10; i++) estimated = observeContextSize(estimated, { appendedChars: 40_000 })
  assert.equal(estimated.tokens, 100_000)
  assert.equal(estimateTokensFromChars(9), 3)
  // A restage starts a fresh counter.
  assert.equal(contextSizeState().tokens, 0)
  assert.equal(observeContextSize(undefined, { appendedChars: 8 }).tokens, 2)
})

test('the request output ceiling resets per slice against the request-wide counter', () => {
  const ceiling = 5 * 8000
  // Slice 1 starts at the beginning of the request.
  let baseline = resetSliceBaseline(0)
  assert.equal(sliceOutputUsed(30_000, baseline), 30_000)
  assert.equal(sliceCeilingState({ aggregateOutputUnits: 30_000, baseline, ceiling }).exceeded, false)
  assert.equal(sliceCeilingState({ aggregateOutputUnits: 40_001, baseline, ceiling }).exceeded, true, 'the strict > test of the loop')
  assert.equal(sliceCeilingState({ aggregateOutputUnits: 40_000, baseline, ceiling }).exceeded, false)

  // Slice 2 starts when the aggregate reads 38,000: it gets a full ceiling again.
  baseline = resetSliceBaseline(38_000)
  assert.equal(sliceOutputUsed(38_000, baseline), 0)
  assert.equal(sliceOutputUsed(60_000, baseline), 22_000)
  const state = sliceCeilingState({ aggregateOutputUnits: 60_000, baseline, ceiling })
  assert.deepEqual(state, { used: 22_000, ceiling, remaining: 18_000, exceeded: false })
  assert.equal(sliceCeilingState({ aggregateOutputUnits: 38_000 + 40_001, baseline, ceiling }).exceeded, true)
  // The request-wide comparison would already have tripped at the same reading.
  assert.equal(60_000 > ceiling, true)
})

test('slice ceiling helpers tolerate a missing or restarted counter', () => {
  assert.equal(resetSliceBaseline(undefined), 0)
  assert.equal(resetSliceBaseline(-5), 0)
  assert.equal(resetSliceBaseline(1.5), 0)
  assert.equal(sliceOutputUsed(undefined, 10), undefined)
  assert.equal(sliceOutputUsed(500, 10_000), 500, 'aggregate below baseline means the counter restarted')
  assert.deepEqual(sliceCeilingState({ aggregateOutputUnits: undefined, baseline: 0, ceiling: 100 }), { used: undefined, ceiling: 100, remaining: undefined, exceeded: false })
  assert.equal(sliceCeilingState({ aggregateOutputUnits: 10, baseline: 0 }).exceeded, false)
})
