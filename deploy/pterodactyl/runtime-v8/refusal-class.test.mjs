import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ADMISSION_REFUSAL, ADMISSION_REFUSAL_CLASS, ADMISSION_REFUSAL_CODES } from './authorization.mjs'
import { REFUSAL_CLASS, REFUSAL_CLASSES, refusalClassLabel, refusalClassOf } from './refusal-class.mjs'

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
    assert.equal(declared, oldPath(code, operationOf(code)), `${code}: class-derived path equals the old path`)
  }
  // The classes' sizes are exactly the old lists' sizes: nothing else moved onto a recovery path.
  const count = refusalClass => Object.values(modRegistry).filter(declared => declared === refusalClass).length
  assert.equal(count('argument'), OLD_MODEL_CORRECTABLE_PREFLIGHT_CODES.length)
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
    'invalid_name', 'unknown_technology', 'no_actor', 'different_surface',
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

test('every refusal the loop itself raises declares its class where it builds the refusal', () => {
  // Static guard: a new `.preflight = { ok: false, ... }` in the loop must carry a refusal_class, or the refusal arrives unclassified.
  const loop = readFileSync(new URL('./npc-agent-loop.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const blocks = [...loop.matchAll(/\.preflight = \{([^}]*)\}/g)].map(match => match[1])
  const refusals = blocks.filter(block => /\bok: false\b/.test(block))
  assert.ok(refusals.length >= 6, `found ${refusals.length} loop-built refusals`)
  for (const block of refusals) assert.match(block, /refusal_class:/, block.replace(/\s+/g, ' ').slice(0, 120))
})
