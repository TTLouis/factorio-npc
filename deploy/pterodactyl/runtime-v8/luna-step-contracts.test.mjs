import assert from 'node:assert/strict'
import test from 'node:test'

import { completionContractSignature, normalizeStepCompletions } from './luna-step-contracts.mjs'

const inventory = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }

test('step completion declarations remain aligned to authored descriptions and do not mutate the draft', () => {
  const values = [{ kind: 'deterministic', checkpoint: inventory }, { kind: 'semantic', rationale: '  Assess the observed site constraints.  ' }]
  const before = JSON.stringify(values)
  const result = normalizeStepCompletions(['Gather copper', 'Assess a site'], values)
  assert.equal(result[0].kind, 'deterministic')
  assert.equal(result[0].checkpoint.requirements[0].item_name, 'copper-ore')
  assert.equal(result[0].checkpoint.requirements[0].minimum, 10)
  assert.deepEqual(result[1], { kind: 'semantic', rationale: 'Assess the observed site constraints.' })
  assert.equal(JSON.stringify(values), before)
})

test('every new plan step requires exactly one explicit declaration', () => {
  for (const values of [undefined, null, {}, [], [{ kind: 'semantic', rationale: 'Assess' }, { kind: 'semantic', rationale: 'Extra' }]]) {
    assert.throws(() => normalizeStepCompletions(['One step'], values), /exactly one completion declaration per plan step/)
  }
  assert.deepEqual(normalizeStepCompletions([], []), [])
})

test('unsupported or malformed deterministic predicates are not silently downgraded to prose', () => {
  for (const checkpoint of [undefined, {}, { mode: 'all', requirements: [] }, { mode: 'all', requirements: [{ kind: 'invented_kind' }] }]) {
    assert.throws(() => normalizeStepCompletions(['Gather copper'], [{ kind: 'deterministic', checkpoint }]), /requires a supported checkpoint/)
  }
})

test('research completion remains a world-state predicate rather than an accepted request receipt', () => {
  const checkpoint = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'logistic-science-pack' }] }
  const result = normalizeStepCompletions(['Complete logistic research'], [{ kind: 'deterministic', checkpoint }])
  assert.equal(result[0].checkpoint.requirements[0].kind, 'research_completed')
  assert.equal(result[0].checkpoint.requirements[0].technology, 'logistic-science-pack')
})

test('new receipt declarations reject operations requiring world verification and preserve assessment-only declarations', () => {
  for (const operation_name of ['wait', 'research_technology']) {
    const checkpoint = { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name }] }
    assert.throws(() => normalizeStepCompletions(['Execute action'], [{ kind: 'deterministic', checkpoint }]), /requires a supported checkpoint/)
  }
  const checkpoint = { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name: 'craft_item' }] }
  assert.equal(normalizeStepCompletions(['Craft an item'], [{ kind: 'deterministic', checkpoint }])[0].checkpoint.requirements[0].operation_name, 'craft_item')
  assert.deepEqual(normalizeStepCompletions(['Assess current observations'], [{ kind: 'semantic', rationale: 'Assess fresh authoritative observations without operations.' }]),
    [{ kind: 'semantic', rationale: 'Assess fresh authoritative observations without operations.' }])
})

test('semantic assessments require an explicit nonempty rationale, not a completion guess', () => {
  for (const value of [null, 'done', { kind: 'semantic' }, { kind: 'semantic', rationale: '' }, { kind: 'semantic', rationale: '  ' }, { kind: 'semantic', rationale: 1 }, { kind: 'automatic', rationale: 'Assume done' }]) {
    assert.throws(() => normalizeStepCompletions(['Assess a site'], [value]), /must declare deterministic completion or a semantic assessment rationale/)
  }
  assert.equal(normalizeStepCompletions(['Assess'], [{ kind: 'semantic', rationale: 'x'.repeat(700) }])[0].rationale.length, 600)
})

test('completion declaration kinds refuse extra members instead of accepting hidden authority', () => {
  assert.throws(() => normalizeStepCompletions(['Gather'], [{ kind: 'deterministic', checkpoint: inventory, rationale: 'Skip verification' }]), /unexpected fields/)
  assert.throws(() => normalizeStepCompletions(['Assess'], [{ kind: 'semantic', rationale: 'Assess evidence', checkpoint: inventory }]), /unexpected fields/)
})

test('contract signature normalizes the same predicate shape consistently', () => {
  const reordered = { requirements: [{ minimum: 10, item_name: 'copper-ore', kind: 'inventory_count' }], mode: 'all' }
  assert.equal(completionContractSignature(inventory), completionContractSignature(reordered))
  const other = { ...inventory, requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 11 }] }
  assert.notEqual(completionContractSignature(inventory), completionContractSignature(other))
})
