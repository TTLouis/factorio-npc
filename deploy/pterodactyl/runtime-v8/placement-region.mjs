// Committed placement scope (M2). A step whose outcome says "at least N of prototype X within radius R of anchor A" (an anchored
// entity_count requirement, step-completion.mjs) fixes where an X may be placed for the step to count: entity-center distance
// <= R from A, the same Euclidean test contract-obligations.mjs applies after the fact. This module turns that requirement into
// the region a getPlacementCandidates search is filtered by BEFORE ranking and truncation, and into the check every placing
// operation's preflight result (place_candidate, place_entity, execute_construction_plan) must pass before admission. Pure functions over stored obligations; nothing here reads the world.

export const REGION_EPSILON = 1e-6
const COORDINATE_LIMIT = 1_000_000

const finite = value => typeof value === 'number' && Number.isFinite(value)
const round = value => Math.round(value * 100) / 100

// The anchored entity_count requirements of the obligations for one prototype, as circle regions (distinct by anchor and radius).
export function committedPlacementRegions(obligations, entityName) {
  const rows = obligations?.outcome?.requirements
  if (!Array.isArray(rows) || typeof entityName !== 'string') return []
  const regions = []
  for (const row of rows) {
    if (row?.kind !== 'entity_count' || row.prototype !== entityName || !row.anchor || !finite(row.anchor.x) || !finite(row.anchor.y)
      || !Number.isSafeInteger(row.radius) || row.radius < 1) continue
    if (regions.some(region => region.center.x === row.anchor.x && region.center.y === row.anchor.y && region.radius === row.radius)) continue
    regions.push({ shape: 'circle', center: { x: row.anchor.x, y: row.anchor.y }, radius: row.radius })
  }
  return regions
}

// A region the search interface can carry (its coordinate bound), so an unrepresentable committed anchor is never half-injected.
export function representableRegion(region) {
  return region?.shape === 'circle' && finite(region.radius) && region.radius > 0 && region.radius <= 256
    && Math.abs(region.center.x) <= COORDINATE_LIMIT && Math.abs(region.center.y) <= COORDINATE_LIMIT
}

export function pointInCircle(point, circle) {
  return finite(point?.x) && finite(point?.y) && Math.hypot(point.x - circle.center.x, point.y - circle.center.y) <= circle.radius + REGION_EPSILON
}

// Whole-region containment in a committed circle: circle-in-circle by center distance plus radius, a box by all four corners (a
// circle is convex, so the corners bound the box).
export function regionWithinCircle(inner, circle) {
  if (inner?.shape === 'circle') {
    return Math.hypot(inner.center.x - circle.center.x, inner.center.y - circle.center.y) + inner.radius <= circle.radius + REGION_EPSILON
  }
  if (inner?.shape === 'box') {
    const { left_top: a, right_bottom: b } = inner
    return [[a.x, a.y], [b.x, a.y], [a.x, b.y], [b.x, b.y]].every(([x, y]) => pointInCircle({ x, y }, circle))
  }
  return false
}

const number = value => String(round(value))

export function describeRegion(region) {
  if (region?.shape === 'circle') return `circle center (${number(region.center.x)}, ${number(region.center.y)}) radius ${number(region.radius)}`
  if (region?.shape === 'box') return `box left_top (${number(region.left_top.x)}, ${number(region.left_top.y)}) right_bottom (${number(region.right_bottom.x)}, ${number(region.right_bottom.y)})`
  return 'unknown region'
}

// What the search is sent with and why. `committed` is the list of anchored regions for the prototype; with none (or one the
// search interface cannot carry) the model's own region passes through unchanged. Returns
//   { region, injected }                          the region to send (undefined: none) and whether the runtime supplied it
//   { refusal: { code, committed_regions, ... } } region_outside_committed_scope: the model's region is not wholly inside any
//                                                 committed one; region_choice_required: several committed areas and no region,
//                                                 so no single area can be injected and an unscoped search could rank all of its
//                                                 returned slots outside every one of them
export function compilePlacementScope(modelRegion, committed) {
  if (!Array.isArray(committed) || committed.length === 0 || !committed.every(representableRegion)) return { region: modelRegion, injected: false }
  if (modelRegion === undefined) {
    if (committed.length === 1) return { region: committed[0], injected: true }
    return { refusal: { code: 'region_choice_required', committed_regions: committed } }
  }
  if (committed.some(circle => regionWithinCircle(modelRegion, circle))) return { region: modelRegion, injected: false }
  return { refusal: { code: 'region_outside_committed_scope', committed_regions: committed, requested_region: modelRegion } }
}

// The pre-admission test of one placement against the committed regions of its prototype (several: it must lie in at least one,
// since each is its own counted area). Positions come only from the native preflight result of that very operation. The codes
// name the operation kind: candidate_* for place_candidate, placement_* for place_entity and execute_construction_plan.
export function candidateScopeVerdict(committed, position, { candidate = true } = {}) {
  if (!Array.isArray(committed) || committed.length === 0) return { applies: false }
  const prefix = candidate ? 'candidate' : 'placement'
  if (!finite(position?.x) || !finite(position?.y)) return { applies: true, ok: false, code: `${prefix}_region_unproven` }
  if (committed.some(circle => pointInCircle(position, circle))) return { applies: true, ok: true }
  return { applies: true, ok: false, code: `${prefix}_outside_committed_region` }
}

// The placements one operation's native preflight resolved, as { entity_name, position } (position undefined when the native
// result does not state one). place_candidate: the candidate registry's prototype and candidate_position. place_entity: its own
// entity_name and the grid-snapped centre of its planned_footprint (absent without coordinates: the runtime then chooses where).
// execute_construction_plan: every validated placement with its snapped position. Any other operation places nothing here.
export function resolvedPlacements(operation, result, entityNameOf) {
  if (result?.ok !== true) return []
  if (operation?.name === 'place_candidate' || operation?.name === 'place_entity') {
    const entityName = entityNameOf(operation, result)
    if (!entityName) return []
    const footprint = result.planned_footprint
    const position = operation.name === 'place_candidate' ? result.candidate_position
      : footprint?.entity_name === entityName ? footprint.position : undefined
    return [{ entity_name: entityName, position }]
  }
  if (operation?.name === 'execute_construction_plan' && Array.isArray(result.construction_placements)) {
    return result.construction_placements.filter(row => typeof row?.entity_name === 'string').map(row => ({ entity_name: row.entity_name, position: row.position }))
  }
  return []
}

export function distanceFromAnchor(circle, position) {
  return Math.hypot(position.x - circle.center.x, position.y - circle.center.y)
}
