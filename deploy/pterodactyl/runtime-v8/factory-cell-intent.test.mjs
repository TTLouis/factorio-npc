import assert from 'node:assert/strict'
import test from 'node:test'
import { committedFactoryCellIntent, FACTORY_CELL_INTENT_SCHEMA, factoryCellIntentPreserved, factoryCellIntentSignature, normalizeFactoryCellIntent, readFactoryCellIntent } from './factory-cell-intent.mjs'
import { normalizeExecutionGuidance, storedExecutionGuidance } from './role-contracts.mjs'
import { validatesAgainstSchema } from './control-json-repair.mjs'
import { executionOnlyControlToolDefinitions, planningOnlyControlToolDefinitions } from './structured-policy.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, PLAN_STATUS, PLANNING_EVENT, restorePlanningState, serializePlanningState } from './planning-state.mjs'

const intent = () => ({ kind: 'direct_feed', product: 'fixture-output', sourceEntity: 'fixture-miner', targetEntity: 'fixture-receiver', purpose: 'Supply the accepted output.' })
const supply = () => ({ mode: 'direct_feed', resource: 'fixture-resource' })
const brief = () => ({ approach: 'Build the assigned pair.', rationale: 'Keep the accepted supply job.', constraints: [], skillIds: [], materialSupply: supply(), cellIntent: intent() })
const contract = { mode: 'all', requirements: [{ id: 'stock', kind: 'inventory_count', item_name: 'fixture-output', minimum: 1 }] }
const step = () => ({ description: 'Establish the assigned pair.', semantic_step_id: 'semantic-cell', completion_mode: 'deterministic', completion_contract: contract, execution_guidance: brief() })
const invalid = { code: 'factory_cell_intent_invalid' }
const commit = state => applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 3, runtime_validation: { passed: true } })
function drafted(steps = [step()]) {
  const state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1, owner: 'owner', objective: 'Establish the requested supply.' })
  return applyPlanningEvent(state, { type: PLANNING_EVENT.DRAFT_CREATED, now: 2, steps })
}

test('planner schema advertises bounded optional intent only to the planner; legacy briefs stay absent', () => {
  const schema = planningOnlyControlToolDefinitions[0].function.parameters.properties.executionGuidance.items
  assert.deepEqual(schema.properties.cellIntent, FACTORY_CELL_INTENT_SCHEMA)
  assert.equal(schema.required.includes('cellIntent'), false)
  assert.equal(validatesAgainstSchema(brief(), schema), true)
  const legacy = brief()
  delete legacy.cellIntent
  assert.equal(validatesAgainstSchema(legacy, schema), true)
  assert.deepEqual(normalizeExecutionGuidance([legacy], 1), [legacy])
  assert.deepEqual(storedExecutionGuidance(legacy), legacy)
  assert.equal(readFactoryCellIntent(legacy), null)
  assert.equal(factoryCellIntentSignature(legacy), null)
  assert.equal(readFactoryCellIntent({ ...legacy, cellIntent: null }), null)
  assert.equal(executionOnlyControlToolDefinitions[0].function.parameters.properties.executionGuidance, undefined)
})

test('normalizer rejects malformed explicit intent without sanitizing away its meaning', () => {
  const malformed = [false, [], 'direct_feed', {}, { ...intent(), kind: 'conversion' },
    { ...intent(), product: '' }, { ...intent(), product: 'wrong item' }, { ...intent(), product: 'x'.repeat(81) },
    { ...intent(), sourceEntity: 'x'.repeat(81) }, { ...intent(), targetEntity: 'native.call()' },
    { ...intent(), targetEntity: intent().sourceEntity }, { ...intent(), purpose: '' },
    { ...intent(), purpose: '   ' }, { ...intent(), purpose: ' leading' }, { ...intent(), purpose: 'trailing ' },
    { ...intent(), purpose: 'x'.repeat(241) }, { ...intent(), purpose: 'bad\ncontrol' },
    { ...intent(), worldUuid: 'model-world' }, { ...intent(), unit_number: 7 },
    JSON.parse('{"kind":"direct_feed","product":"fixture-output","sourceEntity":"fixture-miner","targetEntity":"fixture-receiver","purpose":"job","__proto__":{}}')]
  for (const value of malformed) {
    assert.throws(() => normalizeFactoryCellIntent(value, supply()), invalid)
    assert.throws(() => normalizeExecutionGuidance([{ ...brief(), cellIntent: value }], 1))
  }
  for (const value of [undefined, null, {}, { mode: 'manual_bootstrap', resource: 'fixture-resource' },
    { mode: 'direct_feed', resource: '' }, { ...supply(), override: true }]) {
    assert.throws(() => normalizeFactoryCellIntent(intent(), value), invalid)
  }
  for (const value of malformed.filter(value => value?.targetEntity !== value?.sourceEntity && value?.purpose !== '   ')) {
    assert.equal(validatesAgainstSchema(value, FACTORY_CELL_INTENT_SCHEMA), false, JSON.stringify(value))
  }
})

test('canonical signature includes every immutable intent field and the explicit resource', () => {
  const before = brief()
  const signature = factoryCellIntentSignature(before)
  assert.match(signature, /^[a-f0-9]{64}$/)
  const reordered = { ...before, cellIntent: Object.fromEntries(Object.entries(before.cellIntent).reverse()), materialSupply: { resource: supply().resource, mode: 'direct_feed' } }
  assert.equal(factoryCellIntentSignature(reordered), signature)
  for (const field of ['product', 'sourceEntity', 'targetEntity', 'purpose']) {
    const changed = structuredClone(before)
    changed.cellIntent[field] += '-changed'
    assert.notEqual(factoryCellIntentSignature(changed), signature)
  }
  assert.notEqual(factoryCellIntentSignature({ ...before, materialSupply: { ...supply(), resource: 'other-resource' } }), signature)
  const normalized = normalizeFactoryCellIntent(before.cellIntent, before.materialSupply)
  normalized.purpose = 'Mutated copy'
  assert.equal(before.cellIntent.purpose, intent().purpose)
})

test('a real deterministic draft commits and roundtrips the exact intent without altering the goal', () => {
  const draft = drafted()
  const state = commit(draft)
  const plan = getActivePlan(state)
  assert.equal(plan.status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(state.goal, draft.goal)
  assert.deepEqual(committedFactoryCellIntent(plan.steps[0]), intent())
  assert.equal(Object.isFrozen(plan.steps[0].execution_guidance.cellIntent), true)
  const restored = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(restored.goal, state.goal)
  assert.deepEqual(getActivePlan(restored).steps, plan.steps)
})

test('semantic or corrupted intent cannot enter a new executable draft or commit a restored draft', () => {
  for (const changed of [{ ...step(), completion_mode: 'semantic' },
    { ...step(), execution_guidance: { ...brief(), cellIntent: { ...intent(), injected: true } } }]) {
    assert.equal(getActivePlan(drafted([changed])), undefined)
  }
  const saved = serializePlanningState(drafted())
  saved.plans[0].steps[0].execution_guidance.cellIntent.kind = 'conversion'
  const restored = restorePlanningState(saved)
  assert.equal(commit(restored), restored)
})

test('malformed stored intent preserves original committed guidance and a durable fault across repeated restores', () => {
  const state = commit(drafted())
  for (const corrupt of [guidance => { guidance.cellIntent.product = 42 },
    guidance => { guidance.cellIntent = { ...intent(), extra: true } },
    guidance => { guidance.materialSupply.mode = 'manual_bootstrap' },
    guidance => { guidance.approach = [] },
    guidance => { guidance.cellIntent.purpose = 'x'.repeat(241) }]) {
    const saved = serializePlanningState(state)
    const original = saved.plans[0].steps[0].execution_guidance
    corrupt(original)
    let restored = restorePlanningState(saved)
    for (let iteration = 0; iteration < 2; iteration++) {
      const held = getActivePlan(restored)
      const stored = held.steps[0].execution_guidance
      assert.deepEqual(restored.goal, state.goal)
      assert.equal(held.status, PLAN_STATUS.COMMITTED)
      assert.deepEqual(stored, { ...original, cellIntentFault: invalid })
      assert.throws(() => committedFactoryCellIntent(held.steps[0]), invalid)
      assert.equal(applyPlanningEvent(restored, { type: PLANNING_EVENT.STEP_COMPLETED, now: 5,
        source: 'runtime', plan_id: held.plan_id, step_id: held.steps[0].step_id }), restored)
      restored = restorePlanningState(serializePlanningState(restored))
    }
  }
})

test('a retained restore fault cannot be cleared by replacing its malformed payload with a valid intent', () => {
  const faulted = storedExecutionGuidance({ ...brief(), cellIntent: { ...intent(), unknown: true } })
  faulted.cellIntent = intent()
  const restored = storedExecutionGuidance(faulted)
  assert.deepEqual(restored.cellIntentFault, invalid)
  assert.throws(() => readFactoryCellIntent(restored), invalid)
  assert.throws(() => normalizeExecutionGuidance([restored], 1), /Invalid executionGuidance entry/)
})

test('legacy committed plans and explicit null remain without an enrollment obligation after restore', () => {
  for (const absent of [true, false]) {
    const legacy = step()
    if (absent) delete legacy.execution_guidance.cellIntent
    else legacy.execution_guidance.cellIntent = null
    const original = commit(drafted([legacy]))
    const restored = restorePlanningState(serializePlanningState(original))
    assert.deepEqual(getActivePlan(restored).steps, getActivePlan(original).steps)
    assert.equal(committedFactoryCellIntent(getActivePlan(restored).steps[0]), null)
    assert.equal(Object.hasOwn(getActivePlan(restored).steps[0].execution_guidance, 'cellIntent'), !absent)
  }
})

test('same semantic-step replacement must retain exact intent and selected supply', () => {
  let state = commit(drafted())
  const original = getActivePlan(state)
  state = applyPlanningEvent(state, { type: PLANNING_EVENT.STRUCTURAL_BLOCKER_CONFIRMED, now: 4,
    source: 'runtime', plan_id: original.plan_id, reason_code: 'blocked' })
  for (const change of [next => { delete next.execution_guidance.cellIntent },
    next => { next.execution_guidance.cellIntent.product = 'different-output' },
    next => { next.execution_guidance.materialSupply.resource = 'different-resource' },
    next => { next.execution_guidance.cellIntent.purpose += ' ' }]) {
    const next = structuredClone(original.steps[0])
    change(next)
    assert.equal(factoryCellIntentPreserved(original.steps[0], next), false)
    const successor = applyPlanningEvent(state, { type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 5,
      source: 'user', approved_by: 'owner', plan_id: original.plan_id, steps: [next] })
    assert.notEqual(getActivePlan(successor).plan_id, original.plan_id)
    assert.equal(commit(successor), successor, 'even an approved successor must not silently redefine the same semantic identity')
  }
  const successor = applyPlanningEvent(state, { type: PLANNING_EVENT.USER_REVISION_APPROVED, now: 5,
    source: 'user', approved_by: 'owner', plan_id: original.plan_id, steps: [structuredClone(original.steps[0])] })
  assert.equal(getActivePlan(commit(successor)).status, PLAN_STATUS.COMMITTED)
  assert.deepEqual(state.goal, successor.goal)
})
