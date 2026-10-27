import assert from 'node:assert/strict'
import test from 'node:test'

import { renderPlacementCandidatesResult } from './placement-candidates-render.mjs'

// M2: how a region-constrained getPlacementCandidates answer reads to the model. BC C: a ranked top-8 outside the committed
// area was read as "no room". The answer now states the region, how far the search got, what it verified and whether the
// candidates can be executed, and the sentences never claim more than the fields establish.

const LIMIT = 12000
const REGION = { shape: 'circle', center: { x: 10, y: 10 }, radius: 6 }
const CANDIDATES = [1, 2, 3, 4, 5, 6, 7, 8].map(index => ({ id: `candidate-${index}`, position: { x: 8 + index * 0.5, y: 10.5 }, direction: 0,
  distance_from_anchor: index, footprint: { tile_width: 2, tile_height: 2 }, in_region: true }))
const completeness = (extra = {}) => ({ complete: true, search_shape: 'square_rings', search_center: { x: 10, y: 10 }, search_radius: 8,
  evaluated_positions: 289, legal_candidate_count: 0, returned_count: 0, region_rejected_count: 120, ...extra })
const answer = (extra = {}) => ({ ok: true, entity_name: 'burner-mining-drill', region: REGION, region_semantics: 'entity_center', spatial_status: 'candidates_found',
  search_completeness: completeness({ legal_candidate_count: 2, returned_count: 2 }), material_status: { status: 'held', item_name: 'burner-mining-drill', held_count: 3, required_count: 1 },
  execution_eligibility: 'eligible', ordering: 'nearest_to_anchor_first', legal_candidate_count: 2, returned_candidate_count: 2, candidates: CANDIDATES.slice(0, 2), ...extra })
const renderOf = value => JSON.parse(renderPlacementCandidatesResult(JSON.stringify(value), LIMIT))
const empty = { candidates: [], legal_candidate_count: 0, returned_candidate_count: 0, execution_eligibility: 'no_candidate' }

test('region, spatial status, completeness, material and eligibility lead the answer, ahead of the candidates', () => {
  const rendered = renderOf(answer({ obstructions: { source: 'native_placement_checks', samples: [] } }))
  assert.deepEqual(Object.keys(rendered).slice(0, 9), ['ok', 'entity_name', 'region', 'region_semantics', 'spatial_status', 'execution_eligibility', 'material_status', 'search_completeness', 'ordering'])
  assert.ok(Object.keys(rendered).indexOf('candidates') > Object.keys(rendered).indexOf('search_completeness'))
  assert.equal(Object.keys(rendered).at(-1), 'obstructions')
  assert.deepEqual(rendered.region, REGION)
  assert.equal(rendered.scope_report, undefined, 'a complete search that found candidates needs no extra sentence')
  assert.equal(rendered.execution_report, undefined)
  assert.ok(rendered.candidates.every(candidate => candidate.in_region === true && candidate.executable_now === undefined))
})

test('none_in_verified_scope says what was verified and never claims the placement cannot exist', () => {
  const rendered = renderOf(answer({ spatial_status: 'none_in_verified_scope', ...empty, search_completeness: completeness() }))
  assert.match(rendered.scope_report, /^none in the verified region \(circle center \(10, 10\) radius 6\): the search was complete/)
  assert.match(rendered.scope_report, /289 positions evaluated, 120 outside the region/)
  assert.match(rendered.scope_report, /Only that region was verified/)
  assert.doesNotMatch(JSON.stringify(rendered), /impossible|infeasible|cannot be placed|no room/i)
  assert.equal(rendered.spatial_status, 'none_in_verified_scope')
})

test('search_incomplete names the limit that stopped the search and says absence is not established', () => {
  for (const reason of ['scan_limit', 'clearance_check_limit', 'region_exceeds_search_limit']) {
    const rendered = renderOf(answer({ spatial_status: 'search_incomplete', ...empty, search_completeness: completeness({ complete: false, reason, evaluated_positions: 10000 }) }))
    assert.match(rendered.scope_report, new RegExp(`^search incomplete: ${reason} \\(10000 positions evaluated`))
    assert.match(rendered.scope_report, /not fully verified, so the absence of a candidate is not established/)
    assert.doesNotMatch(rendered.scope_report, /impossible|infeasible|no room/i)
  }
})

test('candidates found by an incomplete search are marked as such; answers without the new fields or on the join path are untouched', () => {
  const rendered = renderOf(answer({ search_completeness: completeness({ complete: false, reason: 'scan_limit', legal_candidate_count: 2, returned_count: 2 }) }))
  assert.match(rendered.scope_report, /^candidates found in the region \(circle center \(10, 10\) radius 6\); search incomplete: scan_limit/)
  assert.match(rendered.scope_report, /further in-region positions may exist/)
  const joined = renderOf({ ok: true, entity_name: 'boiler', spatial_status: 'candidates_found', search_completeness: { complete: true, search_shape: 'solved_join_footprints', evaluated_positions: 3 }, candidates: [] })
  assert.equal(joined.scope_report, undefined)
  assert.equal(joined.search_completeness.search_shape, 'solved_join_footprints')
  const legacy = { ok: true, entity_name: 'steam-engine', candidates: [], scanned: 4 }
  assert.deepEqual(renderOf(legacy), legacy)
})

test('candidates under stock_shortfall read as planning options and each one says it is not executable now', () => {
  const rendered = renderOf(answer({ execution_eligibility: 'stock_shortfall', material_status: { status: 'stock_shortfall', item_name: 'burner-mining-drill', held_count: 0, required_count: 1 } }))
  assert.match(rendered.execution_report, /^stock_shortfall: burner-mining-drill held 0 of 1 required\. These candidates are planning options, not executable now/)
  assert.equal(rendered.candidates.length, 2)
  assert.ok(rendered.candidates.every(candidate => candidate.executable_now === false && candidate.id.startsWith('candidate-')))
  assert.ok(Object.keys(rendered).indexOf('execution_report') < Object.keys(rendered).indexOf('candidates'))
})

test('material_unknown is not read as executable either, and the item count is the native one', () => {
  const unknown = renderOf(answer({ execution_eligibility: 'material_unknown', material_status: { status: 'unknown', item_name: 'steam-engine', held_count: 0, required_count: 1 } }))
  assert.match(unknown.execution_report, /^material_unknown: whether steam-engine is held could not be resolved\. .*not verified executable/)
  assert.ok(unknown.candidates.every(candidate => candidate.executable_now === false))
  const several = renderOf(answer({ execution_eligibility: 'stock_shortfall', material_status: { status: 'stock_shortfall', item_name: 'rail', held_count: 1, required_count: 2 } }))
  assert.match(several.execution_report, /rail held 1 of 2 required/)
})

test('protection and hard-constraint facts the mod sent are kept, and the trimmed headline keeps the status fields', () => {
  const protectedEntities = [{ unit_number: 31, name: 'stone-furnace', reason: 'part_of_running_chain' }]
  const heavy = answer({ protected_entities: protectedEntities, hard_constraints: { never_clears: ['player_building'] },
    candidates: CANDIDATES.map(candidate => ({ ...candidate, resource_coverage: [{ note: 'x'.repeat(1800) }] })) })
  const rendered = renderOf(heavy)
  assert.deepEqual(rendered.protected_entities, protectedEntities)
  assert.deepEqual(rendered.hard_constraints, { never_clears: ['player_building'] })
  const headline = JSON.parse(renderPlacementCandidatesResult(JSON.stringify({ ...heavy, connects_to: { note: 'y'.repeat(20000) } }), 4000))
  assert.equal(headline.truncated_for_size, true)
  assert.equal(headline.spatial_status, 'candidates_found')
  assert.deepEqual(headline.region, REGION)
})
