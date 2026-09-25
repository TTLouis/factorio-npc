# NPC spatial semantics and placement candidate architecture

## Purpose

This document records the design agreed after observing AIRI make semantically invalid but mechanically legal Factorio placements, including mining drills placed on weak resource coverage and downstream containers placed near, but not actually on, a mining-drill output.

The goal is to move deterministic Factorio geometry and placement legality out of LLM reasoning and into the local Autorio/harness runtime while preserving the LLM's role in strategic choice.

The architecture must remain mod-aware. It must derive capabilities and geometry from the running Factorio instance, prototypes, LuaEntity runtime state, fluidboxes, recipe state, and native placement checks rather than from hard-coded vanilla entity names or remembered Factorio wiki rules.

## Design principles

1. **Game state is authoritative.** Runtime/prototype data from the current server is the source of truth. Model memory is never authoritative for entity geometry, fluid ports, mining coverage, or special placement rules.
2. **Capability-driven, not name-driven.** Spatial enrichment is attached only when an entity actually exposes the relevant capability. Vanilla prototype names must not be used as the primary dispatch mechanism.
3. **Harness computes geometry.** The LLM should not manually rotate offsets, infer output sides, determine shoreline tiles, or enumerate candidate coordinates when the harness can calculate them deterministically.
4. **LLM chooses among bounded candidates.** The harness finds valid candidates and exposes a compact set of materially different choices. The LLM chooses according to the current production/layout goal.
5. **Placement is revalidated at execution time.** Candidate selection never bypasses live `can_place_entity` or capability-specific validation because the world can change between candidate generation and execution.
6. **Token cost is bounded.** Spatial semantics are attached only when useful, null/empty fields are omitted, and candidate lists are small and diverse.
7. **Relationships require evidence.** Nearby does not imply connected. AIRI may claim a miner feeds a chest, an inserter links two entities, or a pipe is connected only when runtime spatial/topology evidence supports that relationship.

## Capability-driven spatial enrichment

Nearby/entity status observations should remain compact by default. A `spatial` section is added only when the entity exposes a relevant capability.

### Direct item output

For entities with runtime direct output geometry, expose compact output information derived from the placed LuaEntity:

```json
{
  "spatial": {
    "item_output": {
      "position": { "x": 62.5, "y": 89.5 },
      "target_unit_number": 745
    }
  }
}
```

The first consumer is mining drills. Other modded entities can use the same representation when the runtime exposes equivalent output geometry.

### Inserter-like transfer geometry

For entities that expose pickup/drop geometry, include:

- pickup position
- drop position
- pickup target identity when known
- drop target identity when known

This is runtime geometry after rotation; it is not reconstructed from model memory.

### Fluid-capable entities

Any entity with runtime fluidbox pipe connections can expose a compact fluid-port summary regardless of vanilla name or entity family.

Each port should be derived from the current LuaFluidBox/LuaFluidBoxPrototype data and may include:

- fluidbox/storage index
- production type / role from the current prototype
- current absolute connection position
- flow direction / connection type when available
- connected target identity and target position when present
- recipe-dependent fluid role where Factorio exposes it

This is intentionally generic so modded assemblers, refineries, pumps, boilers, generators, storage entities, and other custom fluid machines are handled by their actual runtime capabilities.

### Mining/resource semantics

For entities that have mining capability and whose useful placement depends on resource coverage, expose current resource overlap/coverage computed from the active prototype and current map resources. The result should be compact, for example:

```json
{
  "spatial": {
    "mining": {
      "resources": [
        { "name": "stone", "tiles": 9, "amount": 12450 }
      ]
    }
  }
}
```

The implementation should use the entity/prototype mining area and current resource entities rather than assuming vanilla drill dimensions.

## Exact identity resolution

All exact-entity observation paths should use the same resilient identity resolution contract.

If a nearby/entity-status observation has already returned `unit_number`, subsequent geometry/topology calls must resolve that same entity consistently. The existing entity-reference hint cache should be the fallback when direct `game.get_entity_by_unit_number()` lookup fails.

This specifically addresses the observed case where entity status found mining drill `744` while `getEntityGeometry({ unit_number: 744 })` returned `entity not found`.

### Resolution scopes (owner decision, 2026-09-25)

`game.get_entity_by_unit_number()` only indexes prototypes flagged
`get-by-unit-number`. Ordinary buildings aren't flagged, so a direct lookup
returns nil for them, and the observation hint is the path that normally finds
them. Callers differ in what they may reach, so the resolver takes an
explicit scope rather than one fixed rule:

- `actor_body`: the entity must be on the actor's surface and force. This is
  for body actions (operations, interaction, orientation, recipe, throughput)
  and matches the original `resolve_exact_entity` rule.
- `map_visible`: any surface and any force. The hint's own surface is
  searched, and the caller then applies its charted/visible checks. This is
  for map inspection, deconstruction and upgrade, exact-entity navigation (the
  actor's surface is checked afterwards), and construction anchors.

Both scopes verify identity by `unit_number` and never substitute a
replacement that only shares name and position.

Every observation path that returns a `unit_number` records a hint:
nearby/status reads, placement receipts, and map-remote area observations.
Before this change, map-remote observations didn't record one.

Exact-entity navigation resolves once at submit and keeps the `LuaEntity` in
the task. After that, each tick checks `valid`; it doesn't repeat the lookup.

Force policy for map mutations:
- upgrade and recipe changes: the actor's own force only (`wrong_force` otherwise);
- deconstruction: the actor's force or `neutral` (for example crash-site
  wrecks); any other force is rejected with `wrong_force`.

Known limit: with zero connected players the NPC force charts no chunks
(observed on 2.0.77, despite the awareness radar and `force.chart`), so map
operations resolve the entity and then stop at `area_uncharted`.

### Nearby observation ordering

`get_nearby_entities` caps its results, so the order in which matches are
kept decides what the model can see. The engine's order isn't meaningful: in
an ore field the first matches are all resource tiles, which crowded out the
buildings next to them. Matches are therefore kept in this order:

1. entities that carry a `unit_number` (buildings, vehicles), nearest first;
2. everything else (resources, trees, rocks), nearest first.

The result also carries `type_counts` over all matches, so the model can see
what the cap dropped and repeat the call with a `name` or `type` filter. The
change only adds fields; existing fields keep their meaning.

## Special placement candidates

Special placement should not require the LLM to calculate coordinates. The harness should enumerate and evaluate candidates locally.

### Unified LLM-facing interface

Prefer a single conceptual interface such as:

```text
getPlacementCandidates({
  entity_name,
  area?,
  target_resource?,
  desired_connections?,
  intent?
})
```

The implementation dispatches to capability-specific providers based on the prototype/runtime data available for the requested entity.

Do not expose one LLM tool per vanilla entity (`findBurnerMinerPlacement`, `findOffshorePumpPlacement`, etc.).

### Placement capability providers

Initial provider classes:

- **resource-bound placement**: entity usefulness depends on overlapping a mineable resource
- **shoreline/terrain-bound placement**: placement validity depends on water/terrain relationship or other native placement constraints
- **fluid-aware placement**: candidate features include actual fluid port locations and possible connection geometry
- **orientation-sensitive placement**: candidate features differ materially by direction

Future providers may cover rail/grid placement, heat networks, or other deterministic constraints without changing the LLM contract.

Providers should compose. A modded entity may be resource-bound, fluid-aware, and orientation-sensitive simultaneously.

## Candidate evaluation

The local harness may scan many `(position, direction)` combinations but should return only a small bounded candidate set.

### Hard constraints

Candidates failing any hard constraint are discarded. Examples:

- current `surface.can_place_entity(...)` fails
- required resource overlap is absent
- Factorio's runtime terrain/shoreline condition fails
- required connection geometry cannot exist
- candidate is on the wrong surface or otherwise invalid

### Features / soft scores

Valid candidates can expose facts useful to the LLM, such as:

- covered resource tiles and remaining resource amount by resource name
- direct output position and whether it is currently clear
- fluid-port positions and current nearby connection opportunities
- distance to an existing belt/pipe/machine
- free-space margin / collision pressure
- requested output-side compatibility

The harness should not silently turn these features into the final strategic decision. It should return a few diverse high-quality candidates so the LLM can choose according to the current task.

### Candidate diversity

Avoid returning several nearly identical positions. Prefer materially different options such as:

- maximum resource coverage
- preferred output orientation
- shortest logistics connection
- clearest local expansion space

A small top-K / Pareto-style set is preferable to a long numeric ranking.

## Candidate lifetime and execution

Candidate references are short-lived runtime objects.

Suggested shape:

```json
{
  "candidate_set_id": "placement-1842",
  "generated_tick": 824312,
  "entity_name": "some-modded-miner",
  "candidates": [
    {
      "id": "c1",
      "position": { "x": 62, "y": 88 },
      "direction": 0,
      "features": {}
    }
  ]
}
```

The LLM should execute by candidate identity rather than retyping coordinates:

```text
place_candidate({ candidate_set_id: "placement-1842", candidate_id: "c1" })
```

Before creation, runtime revalidates:

- candidate ownership/surface/entity prototype
- staleness/expiry
- live `can_place_entity`
- all capability-specific hard constraints

If revalidation fails, the operation returns a bounded reason and AIRI replans.

## Relationship verification

AIRI must not infer a logistics relationship from proximity alone.

Examples:

- a chest is fed by a mining drill only when the drill's actual output target/position intersects that chest
- an inserter connects two entities only when runtime pickup/drop targets support it
- fluid entities are connected only when the current fluidbox/pipe connection graph reports the connection

`getLogisticsTopology` remains the authoritative bounded relationship observation, while the enriched nearby `spatial` summary supplies enough direct geometry to avoid unnecessary follow-up calls for common construction decisions.

## Skills and learning

Skills should encode reusable semantic constraints, not vanilla coordinate assumptions.

Good skill semantics:

- placement requires sufficient target-resource coverage
- downstream receiver must intersect observed direct item output
- required recipe fluid must be connected to an observed compatible fluid input
- candidate must pass live runtime placement validation

Bad skill semantics:

- `burner-mining-drill` always outputs north for direction X
- chemical plant's south pipe is always a specific fluid
- replay an absolute `(x, y, direction)` from the source example

When a verified skill fails semantically in a new environment, that failure should become negative evidence used to revise constraints/preconditions and trigger re-verification rather than being treated as a transient execution retry.

## Implementation sequence

### Phase 1 - identity and compact spatial semantics

- make exact geometry/topology use resilient `resolve_exact_entity`
- add a shared compact spatial-summary helper
- enrich nearby/entity status only for entities with relevant runtime capabilities
- include fluidbox-derived ports for all fluid-capable entities
- add regression tests for exact identity fallback and compact enrichment

### Phase 2 - candidate engine foundation

- add candidate-set runtime storage with bounded lifetime
- add generic placement candidate generation API
- add live revalidation and candidate-id execution
- keep existing `place_entity` as a low-level primitive for ordinary/manual cases

### Phase 3 - initial providers

- resource-bound mining placement and coverage features
- shoreline/terrain-bound placement using native Factorio placement semantics
- fluid-aware/orientation-aware candidate features
- compact diverse top-K selection

### Phase 4 - agent policy and skill integration

- prompt rule: environment-constrained entities must use validated placement candidates rather than remembered geometry or empty-tile guesses
- use enriched observations to avoid redundant geometry calls
- record machine-readable placement/connection constraints in learned skills
- add semantic-failure revision/re-verification policy

## Acceptance criteria

The work is complete when all of the following are true:

1. A nearby placed miner observation can expose its actual direct output geometry without an extra LLM geometry call.
2. Any placed entity with fluidbox pipe connections can expose compact runtime fluid-port geometry independent of vanilla entity name.
3. Exact geometry/topology resolves an entity consistently after that entity was observed and remembered.
4. A mining placement request returns a bounded set of candidates with resource coverage derived from current game data.
5. Shoreline/terrain-constrained placement is locally validated by Factorio/runtime data rather than inferred by the LLM.
6. The LLM selects a candidate by ID and runtime revalidates it before placement.
7. Modded entities with equivalent capabilities automatically participate without adding prototype-name special cases.
8. AIRI cannot truthfully claim a downstream logistics connection from proximity alone; verification uses output/transfer/fluid topology evidence.

## Implementation checkpoint (2026-09-16)

### Implemented on `feat/npc-transition-work`

- Nearby/entity-status observations attach compact runtime `spatial` only when the placed entity exposes relevant capability. Inserters expose pickup/drop geometry, mining drills expose runtime drop geometry plus live compatible resource coverage, and fluid-capable entities expose current fluidbox pipe connections without a vanilla prototype-name whitelist.
- Runtime-v8 nearby/entity-status full/diff observation handling preserves `spatial`, so geometry/resource changes can be sent as bounded diffs rather than forcing repeated full observations.
- Exact geometry/topology observation uses the resilient exact-entity resolver and observed entity-reference hints.
- Generic placement candidates are generated locally from the current entity prototype and live surface. Candidate search uses `surface.can_place_entity`, current mining radius/resource categories, modded directional mining offsets, current resource amounts, current-prototype fluid ports, and bounded candidate diversity.
- Candidate sets are short-lived and bounded in storage. `place_candidate` executes by candidate identity and revalidates candidate lifetime, surface/force, live placeability, and requested resource coverage before queueing low-level placement.
- Runtime-v8 now exposes `getPlacementCandidates` and admits/renders `place_candidate`; existing operations such as `supply_entity` continue to delegate through the established staging operation policy.
- Shoreline/terrain validity is deliberately delegated to native live `surface.can_place_entity` rather than encoded as an offshore-pump name rule.
- Learned-skill novelty now includes semantic preconditions/constraints/acceptance meaning. Semantically different constraints are not merged only because they share the same broad constraint kind.
- Skill trust/evidence is tracked per revision outside the V1 skill JSON. Semantic verification failure quarantines the exact revision, execution failure is recorded without semantic quarantine, and successful verification activates the promoted revision.
- Regression tests have been added for modded mining offsets, fluid candidate orientation, native shoreline validity, candidate execution/revalidation, spatial observation preservation, semantic skill evidence, and runtime-v8 placement policy/copy contracts.

### Partially implemented

- `skill_semantic_evidence.ts` understands optional machine-readable constraint predicates when computing semantic signatures, but `skills.ts` canonical constraint serialization still strips unknown predicate fields. Predicate persistence therefore still needs an explicit schema/canonicalization migration before learned skills can rely on predicates as durable executable authority.
- The existing V1 skill verifier can quarantine semantic counterexamples through the trust/evidence bridge, but automatic synthesis of a revised constraint from that counterexample is still a later learning step.

### Architecture debt / follow-up

- Pterodactyl runtime prompt assembly and the packages/agent development prompt assembly do not yet have a single source of truth. The development agent composes `prompt.md`, `production-planning-prompt.md`, and `spatial-placement-prompt.md`; the Pterodactyl installer currently copies only `prompt.md`, while runtime-v8 supplements behavior through runtime guidance and tool descriptions. This should be unified once for production + spatial policy instead of adding another one-off prompt copy.
- Approved operation/tool contracts still exist in more than one layer. Current source admits `supply_entity`, but older deployment logs showed `Unapproved tool: supply_entity`, demonstrating that deployment/prompt/policy skew is possible. A generated registry/contract test should eventually drive provider tool definitions, operation parsing/rendering, and runtime availability from one source.
- The current connector session has no executed CI/test result for these commits. Tests and copy/import contracts are committed and code/diffs have been reviewed, but engine-level Factorio E2E remains the final authority for runtime semantics.
