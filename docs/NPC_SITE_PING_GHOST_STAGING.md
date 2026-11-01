# SGLuna Factorio — Large-Build Site Proposal, Ping Relocation, and Ghost Staging

**Status:** Planned requirements. Not implemented. No engine validation is claimed.

## Purpose

Large production builds should not immediately place real buildings or immediately spray ghosts across the factory.

For sufficiently large projects, SGLuna should:

1. calculate the production requirements;
2. identify a suitable build site;
3. place a visible ping/preview at the proposed site;
4. ask whether the area is acceptable;
5. allow the player to confirm or ping another location;
6. if the site changes, re-evaluate the site-specific layout and all input/output/power routing;
7. after site acceptance, stage the complete project as ghosts;
8. reconcile the ghost layout with the world;
9. physically construct the approved project;
10. verify delivered production.

The key rule is:

> A relocation ping is not just a coordinate change. It invalidates site-specific layout and routing assumptions and requires a new site revision.

This extends the production-planning harness. It does not replace the existing requirements for production balance, inserter throughput, belt/lane/stacking capacity, physical inventory, project authorization, or runtime verification.

---

# 1. When this workflow applies

The harness, not the LLM, decides whether a build is large enough to require site proposal and ghost staging.

Suggested initial triggers are configurable and should be tuned through testing:

- enclosing project footprint area >= 256 tiles;
- longest project dimension >= 32 tiles;
- planned entity count >= 50;
- user explicitly requests preview/ghost staging;
- the project changes or connects multiple existing production routes.

The threshold applies to the complete planned project, not each operation batch. A model must not bypass this workflow by splitting one large construction into many small placement requests.

Small builds may still use direct construction when policy permits it.

---

# 2. Separate production design from site design

A production project should have two related but distinct representations.

## 2.1 Production design

This describes what the block must do independent of its exact map position.

Example:

```text
Green circuit block

Target:
  10 electronic circuits/s

Imports:
  copper plates: 15/s
  iron plates: 10/s
  electrical power

Internal production:
  copper cable production
  circuit production
  internal direct insertion / belt transport

Export:
  electronic circuits: 10/s
```

This layer owns:

- production target;
- machine counts;
- recipes;
- internal material flow;
- inserter throughput requirements;
- internal belt/lane/stacking requirements;
- nominal footprint;
- input/output interface requirements;
- expected power demand;
- expansion preferences.

## 2.2 Site design

This describes how the production design fits into the current world.

This layer owns:

- map position;
- orientation and optional mirroring;
- exact footprint;
- input-source selection;
- input route geometry;
- output route geometry;
- power connection;
- terrain/conflicts;
- belt crossings;
- underground/splitter requirements;
- interaction with existing production;
- construction access;
- future expansion space.

A production design may remain unchanged while the site design is regenerated several times.

---

# 3. Explicit block interfaces

A production block should expose logical connection ports rather than assuming one fixed world orientation.

Illustrative representation:

```json
{
  "ports": [
    {
      "id": "copper-in",
      "kind": "input",
      "material": "copper-plate",
      "requiredRatePerSecond": 15,
      "preferredSides": ["west", "north"]
    },
    {
      "id": "iron-in",
      "kind": "input",
      "material": "iron-plate",
      "requiredRatePerSecond": 10,
      "preferredSides": ["west", "south"]
    },
    {
      "id": "circuits-out",
      "kind": "output",
      "material": "electronic-circuit",
      "requiredRatePerSecond": 10,
      "preferredSides": ["east"]
    }
  ]
}
```

The harness may rotate or mirror the block to better align these ports with nearby infrastructure.

Port placement must still pass the same belt, lane, stacking, inserter, and throughput checks as every other material connection.

---

# 4. Persistent site proposal state

A large project should create a harness-owned `BuildSiteProposal` with separate production and site revisions.

Illustrative structure:

```json
{
  "projectId": "green-circuit-01",
  "productionRevision": 4,
  "siteRevision": 2,
  "anchor": {
    "surface": "nauvis",
    "x": 120,
    "y": -40
  },
  "anchorMode": "near_anchor",
  "orientation": "east",
  "mirrored": false,
  "footprint": {
    "width": 30,
    "height": 18
  },
  "ports": [
    {"id": "copper-in", "side": "west", "routeId": "route-copper-2"},
    {"id": "iron-in", "side": "south", "routeId": "route-iron-2"},
    {"id": "circuits-out", "side": "east", "routeId": "route-output-2"}
  ],
  "routing": {
    "status": "analytically_feasible",
    "warnings": []
  },
  "status": "awaiting_confirmation"
}
```

The LLM may propose a site, orientation, or relocation, but it cannot mark the site accepted or validated by itself.

---

# 5. Ping-first user interaction

For a large build, use this normal flow:

```text
user goal
    ↓
production requirements calculated
    ↓
candidate site selected
    ↓
site layout + routes evaluated
    ↓
SGLuna creates proposal ping / preview
    ↓
AWAITING_SITE_CONFIRMATION
```

SGLuna should show a compact summary such as:

```text
Proposed green-circuit block
Target: 10 circuits/s
Approximate footprint: 30 x 18 tiles

Copper input: west
Iron input: south
Circuit output: east

Is this area clear?
Ping another location if you want it moved.
```

The proposal ping must be associated with the project and site revision.

The full native ghost layout should not be staged before this site-confirmation step.

---

# 6. Player ping as a relocation event

A player ping while a project is waiting for site confirmation should be captured as structured project input, not only chat text.

Illustrative event:

```json
{
  "type": "project_site_ping",
  "projectId": "green-circuit-01",
  "player": "Louis",
  "surface": "nauvis",
  "position": {"x": 164.5, "y": -22.5},
  "tick": 123456
}
```

If several projects are awaiting location input, require disambiguation instead of guessing.

A relocation ping creates a new site revision. It does not change the accepted production target by itself.

---

# 7. Approximate anchors and exact anchors

By default, a ping means:

> Build around here.

The harness should search a bounded area around the ping for a valid anchor and orientation.

Suggested initial behavior:

- configurable search radius, such as 16-32 tiles;
- evaluate north/east/south/west orientations;
- evaluate mirrored variants when supported;
- prefer candidates reasonably close to the player's ping;
- preserve the same production requirements unless the new location makes them infeasible.

This lets SGLuna avoid nearby belts, cliffs, water, machines, and protected areas while respecting the player's chosen region.

The site proposal should report how far the selected anchor moved from the ping.

If the player explicitly says "exactly here," "put the northwest corner here," or otherwise requests an exact anchor, that position becomes a hard constraint. If the block cannot fit, return the conflict and alternatives rather than silently shifting it.

---

# 8. Relocation invalidates site-dependent assumptions

When a new anchor is supplied, invalidate and recompute at least:

- world footprint and collision checks;
- block orientation and mirroring;
- input-source choice where location affects suitability;
- all input route geometry;
- output route geometry;
- belt distances;
- lane assignments;
- splitters and merges;
- underground belt requirements;
- belt crossings;
- stacking transitions;
- inserter interfaces at block boundaries;
- power connection;
- utility routing;
- actor construction access;
- construction order where routes cross the project;
- expansion space;
- interaction with protected/existing production.

Do not merely translate all previous coordinates.

A relocation may leave the internal production cell valid while changing the best orientation or external routing. If the new site makes the original production scope infeasible, return that as a project-level decision instead of silently changing the target.

---

# 9. Route evaluation before ghost staging

A site is not ready for ghost staging merely because the machines fit.

Before staging the full ghost layout, validate:

```text
footprint
AND
input routes
AND
output routes
AND
power / utilities
AND
transport capacity
AND
site authorization
```

For each route, expose at least:

- source or destination reference;
- material;
- required rate;
- belt tier;
- lane allocation;
- stack-height assumption and evidence;
- estimated path length;
- splitters/merges;
- underground segments;
- crossings;
- expected residual capacity where shared;
- warnings and unknowns.

A valid footprint with an invalid copper route is not a valid site.

---

# 10. Candidate-site comparison

Expose transparent candidate properties rather than one opaque "best site" score.

Example:

| Metric | Site A | Site B |
|---|---:|---:|
| Distance from requested ping | 4 tiles | 11 tiles |
| Copper route | 18 belt tiles | 25 belt tiles |
| Iron route | 9 belt tiles | 12 belt tiles |
| Output route | 24 belt tiles | 18 belt tiles |
| Belt crossings | 2 | 0 |
| Underground sections | 3 | 1 |
| Power connection distance | 8 | 5 |
| Free expansion space | 8 tiles | 34 tiles |
| Protected conflicts | 0 | 0 |

The LLM can then make a contextual choice. A farther site may be better when the user prioritizes future expansion; a compact temporary build may prefer the closer site.

Shortest-route-only selection is not sufficient.

---

# 11. Site and construction state machine

```text
PLANNING
   ↓
SITE_SEARCH
   ↓
SITE_PROPOSED
   ↓
AWAITING_SITE_CONFIRMATION
   ├── player confirms
   │       ↓
   │   SITE_ACCEPTED
   │       ↓
   │   GHOST_STAGING
   │
   ├── player pings replacement location
   │       ↓
   │   SITE_REPLAN
   │       ↓
   │   SITE_PROPOSED
   │
   ├── player changes goal/scope
   │       ↓
   │   PRODUCTION_REPLAN
   │
   └── player cancels
           ↓
       CANCELLED
```

After staging:

```text
GHOST_STAGED
    ↓
CONSTRUCTION
    ↓
COMMISSIONING
    ↓
PRODUCTION_TEST
    ↓
COMPLETE
```

If the player requests relocation after ghost staging but before real construction:

```text
GHOST_STAGED
    ↓
RELOCATION_REQUESTED
    ↓
remove only project-owned unbuilt ghosts
    ↓
SITE_REPLAN
```

If physical construction has already started, a relocation ping must not automatically authorize demolition of completed buildings. That requires a separate modification/demolition decision.

---

# 12. Proposal preview versus native ghosts

The site proposal and native ghost staging are separate phases.

## Proposal phase

Use:

- map/world ping;
- optional label;
- optional lightweight footprint outline;
- optional port arrows/labels.

The purpose is:

> I want to build approximately here.

This phase should not create the full buildable ghost plan.

## Ghost phase

After the site is accepted and all site-specific routes pass validation, create the complete native ghost layout:

- machines;
- belts;
- underground belts;
- splitters;
- inserters;
- poles;
- chests;
- other authorized entities;
- supported recipe/configuration metadata where possible.

The ghost project should preserve project ID, site revision, placement ID, position, direction, quality, and relevant settings.

A complete ghost layout is a construction plan, not proof that the production line works.

---

# 13. Ghost reconciliation and relocation safety

Ghost operations must be idempotent.

For each placement:

- if the correct project ghost exists, keep it;
- if the correct real entity exists, record it as already built;
- if the tile contains an unauthorized conflicting entity, report a blocker;
- do not duplicate ghosts after retries or restarts.

Cancellation or relocation may remove only ghosts positively identified as belonging to that project revision.

Do not remove:

- another player's ghosts;
- another project's ghosts;
- completed real entities;
- unrelated nearby entities.

If a player manually removes a project ghost, surface it for reconciliation instead of immediately recreating it without checking whether the removal was intentional.

---

# 14. Construction admission

Physical construction may begin only when:

1. the production design is still valid;
2. the site revision is accepted;
3. the current ghost revision matches the accepted site;
4. input/output routes still meet capacity requirements;
5. construction materials are available or reserved;
6. world preconditions are fresh enough;
7. project authority still permits construction.

Routine NPC navigation and bounded local retries do not require another LLM call.

Meaningful world changes should invalidate and revalidate only the affected part of the plan where possible.

---

# 15. Model context for site decisions

The model does not need the whole map. Give it:

- accepted production requirements;
- nominal block footprint and explicit I/O ports;
- player's requested anchor and whether it is approximate or exact;
- bounded candidate-site facts;
- important routing constraints;
- expansion-space information;
- explicit violations and unknowns.

A compact candidate should include orientation, offset from player ping, route lengths, crossings, underground sections, protected conflicts, expansion room, and feasibility status.

The harness owns measurements, calculations, and validation status. The model chooses among alternatives or requests a different arrangement.

---

# 16. Proposed operations and events

Names are illustrative.

## Read/planning

- `getProjectSiteStatus(projectId)`
- `findBuildSiteCandidates(projectId, anchor, radius)`
- `evaluateBuildSite(projectId, candidateId)`
- `getSiteRouteSummary(projectId, siteRevision)`

## World-visible planning

- `placeProjectPing(projectId, siteRevision)`
- `showProjectFootprint(projectId, siteRevision)`
- `clearProjectPreview(projectId, siteRevision)`

## Construction staging

- `stageProjectGhosts(projectId, siteRevision)`
- `getGhostStageStatus(projectId, siteRevision)`
- `removeProjectGhosts(projectId, siteRevision)`

## Runtime events

- `project_site_ping`
- `project_site_confirmed`
- `project_site_relocation_requested`
- `project_site_rejected`
- `project_site_invalidated`

All interfaces should remain structured and bounded. Do not expose arbitrary Lua or arbitrary world deletion.

---

# 17. Deterministic test scenarios

## Site workflow

1. Large project enters `SITE_PROPOSED` instead of direct construction.
2. Proposal ping is created.
3. Player confirmation moves the project to `SITE_ACCEPTED`.
4. Replacement player ping creates a new site revision.
5. Old site-specific calculations are invalidated.
6. New orientation/routing is calculated before ghost staging.
7. Exact-anchor request does not silently move.
8. Approximate-anchor request may move within the configured search radius.

## Routing

9. Relocation makes copper routing invalid while the footprint still fits: do not ghost-stage.
10. Rotating the block removes a belt crossing: expose the improved route in the new revision.
11. A stacked input route changes to an unstacked segment: recalculate capacity and do not preserve the previous stacking assumption.
12. Output route becomes blocked: reject the site even when all input routes remain valid.
13. Shared bus lacks spare capacity: do not accept the site merely because the belt passes nearby.

## Ghost behavior

14. Ghost staging occurs only after the accepted site revision.
15. Retry does not duplicate project ghosts.
16. Matching real entities reconcile as already built.
17. Relocation removes only unbuilt ghosts owned by the old revision.
18. Relocation after construction has begun does not auto-demolish completed entities.
19. Another player's nearby ghost is preserved.
20. Manually removed project ghost is surfaced for reconciliation instead of blindly recreated.

## Smaller-model evaluation

21. Present a short-route/no-expansion site and a slightly longer/expandable site when the user requested future expansion. The planner must consider the expansion requirement.
22. Relocate a project across a main bus. The planner must reconsider I/O orientation and crossing costs.
23. Give an exact anchor that conflicts with existing production. The planner must report the conflict and alternatives rather than move silently.
24. Give the same location as "around here." The planner should search locally for a feasible alternative.

---

# 18. Implementation order

Do not begin with model-facing ping logic before project/site state exists.

Recommended sequence:

1. define `BuildSiteProposal` and site revision state;
2. define production-block port representation;
3. implement bounded candidate-site geometry search;
4. add route evaluation for input/output/power interfaces;
5. add transparent candidate summaries;
6. add project-associated ping-event ingestion;
7. add proposal ping/footprint rendering;
8. add confirmation and relocation state transitions;
9. add ghost staging with project/revision ownership;
10. add ghost reconciliation and cleanup;
11. add deterministic site/relocation/ghost tests;
12. add one real-Factorio large-build staging scenario;
13. only then add live-model evaluation of site choices.

---

# 19. First acceptance scenario

The first implementation does not need to solve arbitrary megabase layout.

It should prove this bounded workflow:

```text
known production block
    ↓
known plate input sources
    ↓
calculate required rates
    ↓
find candidate site
    ↓
show ping/footprint
    ↓
player pings alternate site
    ↓
recalculate orientation + all routes
    ↓
player confirms
    ↓
stage full ghosts
    ↓
verify ghost ownership/revision
    ↓
NPC begins bounded physical construction
```

The acceptance scenario must demonstrate that relocation changes route calculations rather than merely shifting coordinates.

---

# TL;DR

For large projects:

**calculate → propose a site → ping/preview it → ask whether the space is clear → accept a player relocation ping → regenerate orientation and all site-specific input/output/power routes → confirm the new site → stage native ghosts → construct → verify production.**

Important rules:

- a player ping normally means **"around here"**, not an exact corner;
- exact placement can be requested explicitly;
- relocation creates a **new site revision**;
- relocation invalidates site-specific routing, stacking, power, access, and expansion assumptions;
- production blocks should expose explicit **input/output ports** so they can rotate or mirror around the chosen site;
- a valid footprint is not enough: supply and output routes must also be feasible;
- native ghosts are staged only after the site is accepted;
- moving an already staged project removes only its own unbuilt ghosts;
- moving a partially built project must not automatically demolish completed structures.
