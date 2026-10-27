// Committed placement scope (M2). A step whose outcome says "at least N of prototype X within radius R of anchor A" (an anchored
// entity_count requirement, step-completion.mjs) fixes where an X may be placed for the step to count: entity-center distance
// <= R from A, the same Euclidean test contract-obligations.mjs applies after the fact. This module turns that requirement into
// the region a getPlacementCandidates search is filtered by BEFORE ranking and truncation, and into the check a place_candidate
// preflight result must pass before admission. Pure functions over stored obligations; nothing here reads the world.

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

// What the search is sent with and why. `committed` is the list of anchored regions for the prototype; with none, or with more
// than one (no single hard area exists), the model's own region passes through unchanged. Returns
//   { region, injected }                         the region to send (undefined: none) and whether the runtime supplied it
//   { refusal: { code, committed_region, ... } } the model's region is not wholly inside the committed one
export function compilePlacementScope(modelRegion, committed) {
  if (!Array.isArray(committed) || committed.length !== 1 || !representableRegion(committed[0])) return { region: modelRegion, injected: false }
  const [circle] = committed
  if (modelRegion === undefined) return { region: circle, injected: true }
  if (regionWithinCircle(modelRegion, circle)) return { region: modelRegion, injected: false }
  return { refusal: { code: 'region_outside_committed_scope', committed_region: circle, requested_region: modelRegion } }
}

// The pre-admission test of a place_candidate. `committed` as above (several: the candidate must lie in at least one, since each
// is its own counted area). Positions come only from the native preflight result of that very operation.
export function candidateScopeVerdict(committed, position) {
  if (!Array.isArray(committed) || committed.length === 0) return { applies: false }
  if (!finite(position?.x) || !finite(position?.y)) return { applies: true, ok: false, code: 'candidate_region_unproven' }
  if (committed.some(circle => pointInCircle(position, circle))) return { applies: true, ok: true }
  return { applies: true, ok: false, code: 'candidate_outside_committed_region' }
}

export function distanceFromAnchor(circle, position) {
  return Math.hypot(position.x - circle.center.x, position.y - circle.center.y)
}
