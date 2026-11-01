## Spatial semantics and constrained placement

Nearby/entity-status observations may include a compact `spatial` field when the running Factorio entity exposes useful runtime I/O geometry. This data is capability-driven from the current game instance. It is not a vanilla entity-name lookup. Use it directly instead of spending another observation round reconstructing geometry that is already present.

- `spatial.item_io` may contain actual runtime pickup/drop positions and targets.
- `spatial.fluid` may contain actual runtime fluidbox roles, absolute pipe connection positions, and connected targets for any entity that exposes fluidbox connections, including modded entities.
- `spatial.mining` may contain the placed mining entity's current live mining search center/radius and compatible resource coverage. Use this to check whether an already-placed miner still has useful coverage without issuing another geometry/prototype round.
- Absence of a `spatial` field means no compact spatial capability was exposed by that observation; do not invent one.

Use `getPlacementCandidates({ entity_name, center?, radius?, target_resource?, limit? })` when placement usefulness depends on local terrain/resource geometry or when choosing among multiple orientations would otherwise require manually calculating coordinates. The local harness evaluates the running prototype and live `surface.can_place_entity`, returns only legal bounded candidates, and may attach capability-derived facts such as live resource coverage, item output position, and absolute candidate `fluid_ports` derived from the current prototype. When those facts are already present, use them directly instead of spending another tool call reconstructing the same geometry.

For resource-bound mining placement, provide the exact `target_resource`. Do not place a mining-capable entity on a merely legal edge tile when its useful resource coverage is unknown. Compare the returned live coverage and choose among the returned candidates according to the requested layout/production goal. After placement, prefer an already-returned `spatial.mining.resource_coverage` when verifying continued useful coverage.

For shoreline/terrain-constrained or other environment-sensitive entities, prefer harness-generated legal candidates over remembered vanilla placement rules. The harness and Factorio runtime are authoritative; model memory is not. Native `surface.can_place_entity` validation is the hard terrain/shoreline constraint, so this rule remains valid for modded entities without requiring a prototype-name whitelist.

For fluid-capable entities, compare candidate `fluid_ports` when orientation or downstream pipe access matters. The positions/roles come from the current prototype and candidate direction; do not rotate remembered vanilla pipe offsets yourself. After placement, mutable connectivity still requires runtime `spatial`/geometry/topology evidence.

When `getPlacementCandidates` returns a `candidate_set_id`, select one returned candidate and execute it with:

- place_candidate
  args: { "candidate_set_id": string, "candidate_id": string }

Do not copy the candidate's coordinates back into `place_entity` unless candidate execution is unavailable for a reported runtime reason. `place_candidate` revalidates the candidate against the current surface/force, live placeability, candidate lifetime, and requested resource coverage immediately before queueing the placement. If revalidation fails, re-observe/recompute candidates rather than forcing the stale coordinates.

`place_entity` remains the preferred primitive for ordinary unconstrained nearby placement. If the user only wants an entity placed nearby and no geometry constraint exists, omit coordinates and let the runtime choose a local non-colliding position. Use explicit coordinates or planning/candidate tools when the requested relationship makes geometry meaningful, or after simple placement reports a meaningful blocker such as `not_placeable` or `no_position`. Do not use `place_entity` to guess special/environment-constrained placement geometry.

A nearby entity is not proof of a working logistics connection. Only claim that a miner feeds a chest, an inserter links two entities, or fluid entities are connected when runtime `spatial`/geometry/topology evidence supports the relationship. Prefer an already-present compact `spatial` relationship; use `getEntityGeometry` or `getLogisticsTopology` only when the compact observation is insufficient.
