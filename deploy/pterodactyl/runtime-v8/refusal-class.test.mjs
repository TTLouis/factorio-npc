import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ADMISSION_REFUSAL, ADMISSION_REFUSAL_CLASS, ADMISSION_REFUSAL_CODES } from './authorization.mjs'
import { classifyBlockedEnd, EXECUTOR_RECOVERY, EXECUTOR_UNFIXABLE_WORLD_CODES, executorCannotFix, REFUSAL_CLASS, REFUSAL_CLASSES, refusalClassLabel, refusalClassOf } from './refusal-class.mjs'
import { NEVER_WAKE_PREFLIGHT_CODES } from './replacement-wake.mjs'

// The mod owns the code -> class registry (packages/autorio/src/refusal_classes.ts). This runtime reads it as text so that the
// two packages are proven to agree without importing TypeScript here. The gate mounts packages/autorio/src (see
// scripts/test-local.sh), as the other mod/runtime contract tests need it too.
const registrySource = readFileSync(new URL('../../../packages/autorio/src/refusal_classes.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const modClasses = registrySource.match(/REFUSAL_CLASSES = \[([^\]]*)\] as const/)[1].match(/'([a-z]+)'/g).map(item => item.slice(1, -1))
const modRegistry = Object.fromEntries([...registrySource.matchAll(/^ {2}([a-z][a-z0-9_]*): '([a-z]+)',$/gm)].map(match => [match[1], match[2]]))

// What the loop's three hand-kept lists said before refusal classes existed, captured verbatim. This is the behaviour the
// class-derived dispatch must reproduce code by code.
const OLD_RESEARCH_PREFLIGHT_RECOVERABLE_CODES = ['missing_prerequisites', 'trigger_research', 'force_busy'] // only for operation research_technology
const OLD_MODEL_CORRECTABLE_PREFLIGHT_CODES = [
  'unknown_prototype', 'unknown_recipe', 'invalid_unit_number', 'invalid_target_kind', 'invalid_preflight_args',
  'not_recipe_machine', 'navigation_position_inside_furnace_collision', 'invalid_navigation_position', 'invalid_navigation_reach_distance',
  'invalid_navigation_search_radius', 'invalid_harvest_search_radius', 'invalid_resource_count', 'invalid_resource_position', 'invalid_resource_search_radius',
  'placement_candidate_unavailable', 'no_natural_harvest_source',
]
// Deliberate behaviour changes from the old lists (integrator decision): a wrong technology name is a naming error like unknown_recipe,
// so these two now get the one bounded correction turn instead of the blocked end. Anything not listed here must match oldPath.
const INTENTIONAL_CHANGES = { invalid_name: 'argument', unknown_technology: 'argument' }

// Every admission refusal except authorization_stale (ADMISSION_REFUSAL_CODES minus the stale grant).
const OLD_AUTHORIZATION_RECOVERABLE_CODES = ['protected_entity_refused', 'reserved_supply_refused', 'reserved_supply_ambiguous_target', 'player_inventory_excluded']

// The path the old chain took for a generic refusal (the dedicated per-code handlers such as stale_exact_target or requires_machine
// ran first and, once spent, fell through to the same chain).
function oldPath(code, operation) {
  if (operation === 'research_technology' && OLD_RESEARCH_PREFLIGHT_RECOVERABLE_CODES.includes(code)) return 'prerequisite'
  if (OLD_AUTHORIZATION_RECOVERABLE_CODES.includes(code)) return 'authority'
  if (OLD_MODEL_CORRECTABLE_PREFLIGHT_CODES.includes(code)) return 'argument'
  return 'world'
}

test('the closed set of classes is the same in the mod and the runtime', () => {
  assert.deepEqual(modClasses, [...REFUSAL_CLASSES])
  assert.deepEqual([...REFUSAL_CLASSES].sort(), ['argument', 'authority', 'prerequisite', 'world'])
  assert.ok(Object.isFrozen(REFUSAL_CLASS) && Object.isFrozen(REFUSAL_CLASSES))
})

test('the mod registry parsed here is not empty and uses only the closed set', () => {
  assert.ok(Object.keys(modRegistry).length >= 40, `parsed ${Object.keys(modRegistry).length} registry entries`)
  for (const [code, refusalClass] of Object.entries(modRegistry)) assert.ok(REFUSAL_CLASSES.includes(refusalClass), `${code} -> ${refusalClass}`)
})

test('equivalence: the mod-declared class reproduces the old hand-list path for every mod preflight code', () => {
  const operationOf = code => (OLD_RESEARCH_PREFLIGHT_RECOVERABLE_CODES.includes(code) ? 'research_technology' : 'other')
  for (const code of [...OLD_RESEARCH_PREFLIGHT_RECOVERABLE_CODES, ...OLD_MODEL_CORRECTABLE_PREFLIGHT_CODES]) {
    assert.ok(Object.hasOwn(modRegistry, code), `${code} from an old list is classified by the mod`)
  }
  for (const [code, declared] of Object.entries(modRegistry)) {
    if (Object.hasOwn(INTENTIONAL_CHANGES, code)) {
      assert.equal(oldPath(code, operationOf(code)), 'world', `${code} was on the blocked path before`)
      assert.equal(declared, INTENTIONAL_CHANGES[code], `${code}: recorded intentional change`)
      continue
    }
    assert.equal(declared, oldPath(code, operationOf(code)), `${code}: class-derived path equals the old path`)
  }
  for (const code of Object.keys(INTENTIONAL_CHANGES)) assert.ok(Object.hasOwn(modRegistry, code), code)
  // The classes' sizes are the old lists' sizes plus the recorded changes: nothing else moved onto a recovery path.
  const count = refusalClass => Object.values(modRegistry).filter(declared => declared === refusalClass).length
  assert.equal(count('argument'), OLD_MODEL_CORRECTABLE_PREFLIGHT_CODES.length + Object.keys(INTENTIONAL_CHANGES).length)
  assert.equal(count('prerequisite'), OLD_RESEARCH_PREFLIGHT_RECOVERABLE_CODES.length)
  assert.equal(count('authority'), 0, 'the mod preflight has no authority refusals; admission produces them')
})

test('equivalence: the "nothing found in radius" family and the codes with dedicated handlers stay on the world path', () => {
  for (const code of [
    // owner question still pending: not decided by this change
    'resource_source_not_found', 'navigation_target_not_found', 'natural_harvest_source_not_found',
    'resource_source_insufficient', 'supply_destination_conflict', 'player_unavailable',
    // dedicated per-code recovery first, the blocker path when it is spent
    'stale_exact_target', 'supply_missing', 'extraction_empty', 'destination_full', 'requires_machine',
    'bootstrap_dependency_unresolved', 'recipe_locked', 'placement_item_missing',
    // not on the old correction list, so identical behaviour keeps them blocked
    'no_actor', 'different_surface', 'technology_disabled', 'research_disabled',
  ]) assert.equal(modRegistry[code], 'world', code)
})

test('equivalence: admission refusals declare the class the old authorization set implied', () => {
  assert.deepEqual(Object.keys(ADMISSION_REFUSAL_CLASS).sort(), [...ADMISSION_REFUSAL_CODES].sort(), 'every admission code declares a class')
  for (const code of ADMISSION_REFUSAL_CODES) {
    assert.equal(ADMISSION_REFUSAL_CLASS[code], oldPath(code, 'other'), code)
  }
  assert.equal(ADMISSION_REFUSAL_CLASS[ADMISSION_REFUSAL.AUTHORIZATION_STALE], 'world')
  assert.deepEqual([...OLD_AUTHORIZATION_RECOVERABLE_CODES].sort(), ADMISSION_REFUSAL_CODES.filter(code => code !== ADMISSION_REFUSAL.AUTHORIZATION_STALE).sort())
})

test('a refusal with a missing, unknown or non-string class is unclassified and takes the world path', () => {
  for (const preflight of [undefined, null, {}, { code: 'x' }, { refusal_class: 'someday' }, { refusal_class: 3 }, { refusal_class: 'World' }]) {
    assert.deepEqual(refusalClassOf(preflight), { refusal_class: 'world', classified: false })
    assert.equal(refusalClassLabel(preflight), 'unclassified')
  }
  for (const refusalClass of REFUSAL_CLASSES) {
    assert.deepEqual(refusalClassOf({ refusal_class: refusalClass }), { refusal_class: refusalClass, classified: true })
    assert.equal(refusalClassLabel({ refusal_class: refusalClass }), refusalClass)
  }
})

// Static guard. A refusal object literal is one that says `ok: false` and has its own top-level `code:`. Every one built in the
// loop or the memory facade must carry a refusal_class, or the refusal reaches the loop unclassified. The scan balances braces, so
// nested literals (conflict: {...}, duplicate: {...}) inside a refusal do not cut it short.
function refusalLiterals(text) {
  const found = []
  for (const start of text.matchAll(/\{\s*ok: false\b/g)) {
    let depth = 0
    let quote
    let end = -1
    for (let i = start.index; i < text.length; i++) {
      const char = text[i]
      if (quote) {
        if (char === String.fromCharCode(92)) i++
        else if (char === quote) quote = undefined
        continue
      }
      if (char === '\'' || char === '"' || char === '`') quote = char
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { end = i; break }
    }
    assert.ok(end > 0, `unbalanced literal near offset ${start.index}`)
    const literal = text.slice(start.index, end + 1)
    // Top level only: drop every nested {...} before looking for keys.
    let top = literal.slice(1, -1)
    for (let previous; previous !== top;) { previous = top; top = top.replace(/\{[^{}]*\}/g, '') }
    if (/\bcode:/.test(top)) found.push({ literal, top })
  }
  return found
}

for (const [file, minimum] of [['npc-agent-loop.mjs', 6], ['canonical-task-board-memory.mjs', 1], ['batch-stock.mjs', 2]]) {
  test(`every refusal literal built in ${file} declares its refusal_class`, () => {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const refusals = refusalLiterals(text)
    assert.ok(refusals.length >= minimum, `found ${refusals.length} refusal literals in ${file}`)
    for (const { literal, top } of refusals) assert.match(top, /\brefusal_class:/, literal.replace(/\s+/g, ' ').slice(0, 140))
  })
}

test('the step_contract_pending refusal is among the guarded literals', () => {
  const text = readFileSync(new URL('./canonical-task-board-memory.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(refusalLiterals(text).some(({ top }) => /STEP_CONTRACT_PENDING_CODE/.test(top) && /refusal_class: REFUSAL_CLASS\.WORLD/.test(top)))
})

test('the guard does catch a refusal that forgot its class, including one with a nested literal', () => {
  const missing = refusalLiterals('x.preflight = {\n  ok: false,\n  code: \'a\',\n  conflict: { n: 1 },\n  detail: \'}\',\n}')
  assert.equal(missing.length, 1)
  assert.doesNotMatch(missing[0].top, /refusal_class:/)
  assert.match(missing[0].top, /detail:/, 'a nested literal and a brace inside a string do not end the scan early')
})

// --- unit 13: who can fix a refusal ---------------------------------------------------------------------------------------------

test('the world refusals an executor cannot fix are declared once and every one is a never-wake code of the refusal class it names', () => {
  assert.deepEqual(Object.keys(EXECUTOR_UNFIXABLE_WORLD_CODES).sort(),
    ['authorization_stale', 'bootstrap_dependency_unresolved', 'different_surface', 'duplicate_effect_suppressed', 'no_actor', 'recipe_locked'])
  for (const code of Object.keys(EXECUTOR_UNFIXABLE_WORLD_CODES)) {
    assert.equal(NEVER_WAKE_PREFLIGHT_CODES.includes(code), true, `${code} is also a never-wake code`)
    assert.equal(executorCannotFix({ code }) !== undefined, true)
  }
  // The two meanings differ: the executor's own inventory accounting is never world evidence, but a fresh executor can fix it.
  assert.equal(NEVER_WAKE_PREFLIGHT_CODES.includes('supply_missing'), true)
  assert.equal(executorCannotFix({ code: 'supply_missing' }), undefined)
  assert.equal(executorCannotFix({}), undefined)
})

test('classifyBlockedEnd: the pause class follows who can fix the refusal, and every answer names its reason', () => {
  const world = code => ({ code, refusal_class: 'world' })
  const cases = [
    // [label, input, pause_class, reason]
    ['argument after its retry', { preflight: { code: 'unknown_prototype', refusal_class: 'argument' }, recoverySpent: [EXECUTOR_RECOVERY.ARGUMENT_RETRY] }, 'model_recoverable', 'argument_refusal_after_retry'],
    ['world after the supply recovery', { preflight: world('supply_missing'), recoverySpent: [EXECUTOR_RECOVERY.SUPPLY_RECOVERY] }, 'model_recoverable', 'world_refusal_after_supply_recovery'],
    ['world after the correction turn', { preflight: world('natural_harvest_source_not_found'), recoverySpent: [EXECUTOR_RECOVERY.WORLD_CORRECTION] }, 'model_recoverable', 'world_refusal_after_world_correction'],
    ['world with no recovery spent', { preflight: world('natural_harvest_source_not_found'), recoverySpent: [] }, 'guard', 'no_executor_recovery_spent'],
    ['authority', { preflight: { code: 'protected_entity_refused', refusal_class: 'authority' }, recoverySpent: [EXECUTOR_RECOVERY.ARGUMENT_RETRY] }, 'guard', 'authority_refusal_needs_a_person'],
    ['prerequisite', { preflight: { code: 'force_busy', refusal_class: 'prerequisite' }, recoverySpent: [EXECUTOR_RECOVERY.WORLD_CORRECTION] }, 'guard', 'prerequisite_refusal_outside_research_recovery'],
    ['plan-level world refusal', { preflight: world('recipe_locked'), recoverySpent: [EXECUTOR_RECOVERY.WORLD_CORRECTION] }, 'guard', 'executor_cannot_fix:plan_level'],
    ['lifecycle', { preflight: world('no_actor'), recoverySpent: [] }, 'guard', 'executor_cannot_fix:lifecycle'],
    ['harness hold', { preflight: world('duplicate_effect_suppressed'), recoverySpent: [EXECUTOR_RECOVERY.WORLD_CORRECTION] }, 'guard', 'executor_cannot_fix:harness_hold'],
    ['world evidence whose wake was skipped', { preflight: world('extraction_empty'), recoverySpent: [EXECUTOR_RECOVERY.SUPPLY_RECOVERY], worldEvidence: true }, 'guard', 'world_evidence_wake_skipped'],
    ['unclassified', { preflight: { code: 'brand_new_mod_code' }, recoverySpent: [EXECUTOR_RECOVERY.ARGUMENT_RETRY] }, 'guard', 'unclassified_refusal_fails_closed'],
  ]
  for (const [label, input, pauseClass, reason] of cases) {
    const verdict = classifyBlockedEnd(input)
    assert.deepEqual([verdict.pause_class, verdict.reason, verdict.executor_correctable], [pauseClass, reason, pauseClass === 'model_recoverable'], label)
  }
  assert.deepEqual(classifyBlockedEnd({}).pause_class, 'guard', 'no input at all fails closed')
})
