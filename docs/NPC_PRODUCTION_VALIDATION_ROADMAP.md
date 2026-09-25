# AIRI Factorio — Production Capability Validation Roadmap

Status: **canonical production E2E validation direction**
Branch of origin: `experiment/jev-agent-architecture`
Adopted: 2026-09-19

This document defines how AIRI production-building capability is staged, tested, promoted, and diagnosed.

It is intentionally separate from:

- `docs/validation/NPC_PRODUCTION_PLANNING_HANDOFF.md` (historical), which describes production-planning machinery and token-efficiency work;
- `docs/NPC_PLANNING_ROADMAP.md`, which defines Goal / LOD Shelf / immutable Active Plan / Jev planning authority.

The central rule is:

> **Code presence is not gameplay validation.** A deterministic solver, topology candidate, construction validator, throughput API, or fluid-geometry reader can be correct in isolation while the end-to-end production capability remains unproven.

## 1. Current capability baseline

The historical validation state must be represented explicitly instead of inferred from the current codebase.

| Capability | Status | Meaning |
| --- | --- | --- |
| Burner mining drill -> stone furnace | **historical pass / canary** | User-reported real gameplay success in earlier work. Keep as a cheap production regression canary; do not treat the historical pass alone as proof of current HEAD. |
| Powered assembler production cell | **unproven frontier** | More advanced production attempts were not successfully validated end-to-end because harness failures prevented trustworthy conclusions. |
| Belt/inserter production transport | **unproven frontier** | Supporting deterministic tooling exists, but a reliable complete production line has not been established as a current E2E capability. |
| Multi-stage item production | **unproven frontier** | Solver/topology support exists; real construction + operation + semantic verification remains to be proven. |
| Fluid construction / connectivity / operation | **known-red historical area** | User-reported prior fluid attempt failed. Current prototype-level fluid geometry support is preparation, not proof that live fluid networks work. |
| Sustained throughput / SPM-style operation | **later maturity work** | Do not use as the immediate production acceptance gate until basic powered item and fluid systems are proven. |

When a new real-E2E pass is obtained, record the exact deployed SHA, fixture/save, Factorio/mod versions, model/provider configuration, trace references, and acceptance evidence in a new `docs/validation/` checkpoint.

## 2. Production capability must be tested in three autonomy modes

Do not ask an autonomous model to solve design, execution, and verification simultaneously until the lower layers are known good.

For each production scenario, use this ladder:

```text
A1  deterministic exact-layout fixture
    test harness receives a known-good exact construction/configuration target
    (the model does not see this layout)
        |
        v
    proves harness / engine mechanics only

A2  guided AI arrangement
    machine set + topology + bounded site + grounded constraints are supplied
        |
        v
    LLM authors the exact spatial arrangement and executes it

A3  autonomous AI production objective
    only the production objective / allowed scope + grounded game facts are supplied
        |
        v
    LLM chooses route / topology / site / spatial arrangement / execution
```

Interpret failures by rung:

- **A1 fails:** runtime/harness/game-mechanics defect. Do not blame planner quality.
- **A1 passes, A2 fails:** arrangement/tool-contract/model-interface problem.
- **A2 passes, A3 fails:** production planning/reasoning/grounding problem.

Do not skip A1 merely because a similar production pattern once worked.


### 2.1 Factory designs are model-authored

The production-validation harness must not become a hidden factory designer.

For provider-driven design tests, AIRI / the Main LLM owns the **spatial production design**. The deterministic side may provide grounded engineering facts and bounded constraints such as:

- recipe inputs/outputs and machine compatibility;
- required machine counts and target rates;
- machine footprints and collision geometry;
- inserter pickup/drop reach;
- belt direction/connectivity rules;
- fluidbox connection positions and rotation semantics;
- power requirements / coverage facts;
- bounded free construction areas;
- transport-capacity or throughput evidence;
- precise validation failures.

The deterministic side may also expose coarse topology families such as:

```text
belt-fed
direct-insertion
shared-intermediate
pipe-fed
```

These are design archetypes, not layouts.

The Main LLM remains responsible for choices such as:

- where each machine is placed;
- machine orientation;
- where inputs enter and outputs leave;
- inserter placement/direction;
- belt routing;
- pipe routing;
- power-pole arrangement;
- spacing and expansion room;
- how the selected topology is realized geometrically.

Do **not** provide a library of known-good production blueprints, internet-derived layouts, hidden canonical factory designs, or deterministic layout generators to A2/A3 and then claim that AIRI designed the factory.

The intended relationship is:

```text
grounded constraints / candidates
        ↓
      LLM DESIGN
        ↓
deterministic validation
        ↓
 precise accept / reject facts
        ↓
LLM corrects its own design if needed
```

not:

```text
deterministic factory-layout solution
        ↓
LLM merely replays coordinates
```

A1 is the deliberate exception only because A1 tests **harness mechanics, not design intelligence**. A known-good exact placement may be hardcoded in test code or generated by the fixture so that the runtime can prove placement, configuration, transport, power/fluid behavior, and verification independently of model design quality.

That A1 layout must remain **test-only and hidden from the model**. It must not be surfaced through prompts, observations, retrieval, blueprint libraries, or later A2/A3 context.

Therefore:

> **The harness may validate factory designs and provide grounded engineering constraints, but model-facing spatial production designs are authored by the LLM. Test-only exact layouts may validate harness mechanics, but they are never production solutions supplied to AIRI.**


## 3. Production lifecycle states

"Placed" is not "working".

Use progressively stronger semantic states:

```text
BUILT
  entities exist at verified positions
        |
        v
CONNECTED
  material/power/fluid connectivity is physically valid
        |
        v
CONFIGURED
  recipes/directions/settings match the intended block
        |
        v
OPERATING
  machines are able to run and have no structural operating blocker
        |
        v
PRODUCING
  intended output is actually observed
        |
        v
SUSTAINING
  target production is maintained over a defined observation window
```

Near-term micro-production tests may stop at **PRODUCING**.

Rate-based production planning, later SPM work, and claims of sustainable capacity require **SUSTAINING**.

Operation admission, entity placement, or batch completion must never be used as substitutes for these semantic states.

## 4. Item-production validation track

### B0 — burner mining canary

```text
ore patch
  ↓
burner mining drill
  ↓
direct insertion
  ↓
stone furnace
  ↓
iron/copper plate observed
```

Purpose:

- preserve the historically successful minimum production capability;
- catch regressions below the old baseline after harness/planning changes.

Status: historical success; rerun on current candidate when production internals change materially.

This is a **canary**, not the next capability milestone.

### B1 — powered assembler cell

This is the immediate production frontier.

Recommended fixture:

```text
input chest
    ↓
 inserter
    ↓
assembling machine
 recipe: simple one-input item
    ↓
 inserter
    ↓
output chest
```

Use a simple deterministic recipe such as an iron intermediate when available in the fixture.

The fixture should begin with:

- required technology already researched;
- exact construction materials available;
- sufficient input material already present;
- deterministic clear build area;
- known electrical power source or explicitly constructed power fixture;
- enemies disabled/irrelevant.

Acceptance requires:

1. exact entities are built;
2. assembler recipe is configured;
3. power is available;
4. input inserter moves the intended material into the assembler;
5. assembler crafts;
6. output inserter removes the product;
7. output inventory count increases.

The last three conditions are the important proof.

### B2 — belt-fed assembler cell

```text
source inventory
    ↓
 inserter
    ↓
 belt segment(s)
    ↓
 inserter
    ↓
 assembler
    ↓
 output
```

Prove:

- belt orientation;
- pickup/drop geometry;
- material actually reaches the consumer;
- the assembler produces;
- output is observed.

Do not require maximum or target throughput yet. First prove functional connectivity.

### B3 — two-stage assembler chain

```text
external raw input
      ↓
assembler A
 intermediate
      ↓
transport
      ↓
assembler B
 final product
```

This is the first test where the line has a true internal dependency.

Prove that the intermediate is not merely produced but reaches the downstream recipe.

### B4 — red science from supplied plates

Supply iron/copper plates externally so mining/smelting do not obscure the new capability under test.

Target:

```text
iron plates -> gears --+
                       +-> automation science
copper plates ---------+
```

This is the first meaningful multi-recipe science line.

### B5 — full early science production

Expand the same target to include upstream smelting and resource supply.

Only attempt after B4 is stable.

### B6 — production-target planning

Give a bounded target rate rather than an exact layout:

```text
"Produce automation science at X/s."
```

AIRI may use deterministic production solving and bounded topology candidates, then choose the layout.

### B7 — natural-language autonomous production

Example:

```text
"Establish automated red science."
```

No exact prototype names.

This validates grounded capability discovery + scope choice + planning + construction + verification together.

### B8 — sustained-rate validation

After functionality is reliable, require an observation window and compare measured output/transport capacity to the plan target.

This is the bridge from "factory works" to later scaling/SPM work.

## 5. Fluid validation is a separate track

Do not bundle fluid behavior into B1-B4.

Fluid geometry, connection semantics, network identity, and flow are different enough to deserve independent gates.

The current code can expose bounded Factorio-native prototype fluidbox / pipe-connection geometry. That does **not** prove that AIRI can build a connected live network.

### C0 — prototype geometry contract

Keep deterministic regression coverage for:

- fluidbox existence;
- production type;
- legal pipe connection positions;
- direction/rotation semantics;
- bounded modded connection lists.

This is already preparation, not an E2E success claim.

### C1 — source -> pipes -> storage

Use the smallest live fluid fixture possible.

Conceptual target:

```text
water source
    ↓
 pipe
    ↓
 pipe
    ↓
storage tank
```

Acceptance:

- source is valid;
- exact pipe endpoints connect;
- network contains the expected fluid;
- destination receives fluid;
- destination amount changes over the observation window.

### C2 — source -> fluid consumer

Connect a single fluid source to one consuming machine.

Acceptance adds:

- correct machine fluid input is connected;
- expected fluid reaches the correct input;
- consumer operates.

### C3 — fluid input + transformed fluid output

Use one processing machine with a fluid input and a different output.

Prove correct input/output port interpretation and output flow.

### C4 — multi-port fluid production

Only after C1-C3 pass should the project test refinery/chemical-style networks with several ports and multiple simultaneous fluids.

## 6. Required deterministic connectivity checks

Before relying on autonomous layouts, add or verify deterministic checks for the connectivity semantics that the game already knows.

### Item transport

For inserter-based connections, determine where feasible:

- pickup target intersects the intended source;
- drop target intersects the intended destination;
- orientation matches the desired direction;
- the source can provide the relevant item;
- the destination can accept the relevant item/recipe input.

Then verify actual movement separately.

### Belts

Verify:

- connected belt geometry;
- direction continuity;
- material reaches the intended pickup region.

Capacity/lanes are a later, stronger gate than basic functional connectivity.

### Fluids

A future fluid-plan validator should be able to reject, before full construction:

- one-tile connection gaps;
- wrong machine rotation;
- pipe that does not meet the actual fluidbox connection;
- wrong input/output port;
- incompatible fluid network connection;
- invalid multi-fluid merge.

A useful conceptual contract is:

```text
validateFluidPlan(exact placements + rotations + intended edges)
  -> grounded connection graph
  -> accepted / precise rejection
```

This should remain deterministic and engine-backed; it should not become a hidden factory designer.

## 7. Production-block observation and diagnostics

Do not debug failed production by forcing the LLM to inspect every entity repeatedly.

Introduce a bounded semantic production-block observation when E2E shows the need.

Useful facts include:

```text
machine:
  identity / position
  recipe
  powered
  operating state
  missing ingredients / blocked output
  relevant inventories / fluidboxes

item edge:
  source
  destination
  orientation / reach
  movement observed?

belt path:
  direction
  expected item present?
  destination reached?

fluid edge:
  endpoints connected?
  fluid identity
  flow / amount changing?
```

The runtime reports facts and precise failure conditions.

It should not automatically choose the strategic repair when several valid designs exist.

## 8. Failure-injection regression track

Once a scenario passes, deliberately break one thing at a time and verify that AIRI/runtime localizes the defect.

Examples:

- inserter reversed;
- inserter one tile out of reach;
- assembler recipe missing/wrong;
- power pole absent;
- output blocked;
- belt reversed;
- belt gap;
- machine placement collision;
- required construction item absent;
- drill working area misses the resource patch;
- pipe gap;
- wrong fluid connection side;
- wrong machine rotation;
- incompatible fluid merge.

The important assertion is not merely "the task fails".

It should identify the correct failure layer without falsely marking the production plan complete or rewriting a healthy committed semantic plan.

## 9. Deterministic production E2E fixtures

Production tests should start from versioned, reproducible Factorio states rather than ad-hoc saves.

Recommended fixture families:

```text
P0  empty clear construction field
P1  clear field + required construction inventory
P2  powered assembler fixture
P3  item-transport fixture
P4  multi-stage item fixture
F1  simple fluid-source fixture
F2  fluid-processing fixture
R*  deliberately broken variants for recovery tests
```

Each fixture should define:

- map/save identifier and revision;
- Factorio version;
- enabled mods and versions;
- force research state;
- initial inventory/entities;
- expected resource positions;
- enemy state;
- intended acceptance observations.

Avoid test-only mechanics that bypass real production behavior. Fixtures may control initial conditions, but construction, transport, crafting, power, fluids, and verification must use real game semantics.

Fixtures may contain exact test-only coordinates for A1 harness verification. Those coordinates are not reusable AIRI blueprints and must not be exposed as candidate designs during A2/A3.

## 10. Evidence required for a production E2E claim

Every real-provider production checkpoint should record:

- repository/deployed SHA;
- exact fixture/save revision;
- Factorio version;
- mod set;
- provider/model configuration;
- exact user goal;
- autonomy rung: A1 / A2 / A3;
- plan id/version where applicable;
- behavior/prompt trace references;
- operation receipts;
- semantic production observations;
- final pass/fail reason;
- provider usage metrics where available.

A single successful model run may prove feasibility, but it does not by itself prove reliability.

For provider-driven promotion, run repeated identical-fixture trials and record the pass rate. The exact reliability threshold should be chosen deliberately; do not hide stochastic failures by keeping only the successful transcript.

## 11. Near-term execution order

The production project should now prefer proof over additional planning sophistication.

Recommended order:

1. Preserve B0 as a cheap current-HEAD canary.
2. Build/version the deterministic B1 fixture.
3. Prove B1 in A1 exact-layout mode.
4. Add the minimum semantic verifier needed to distinguish BUILT / CONFIGURED / OPERATING / PRODUCING.
5. Run B1 in A2 guided arrangement mode.
6. Convert every harness failure into a deterministic regression.
7. Run B1 in A3 autonomous mode only after A1/A2 are stable.
8. Add B2 belt transport.
9. Add B3 two-stage item production.
10. Add B4 red science from supplied plates.
11. In parallel after B1 is stable, restart fluid validation at C1 rather than jumping directly to oil/refinery complexity.
12. Do not claim sustained target-rate production until B8-style measurement has passed.

## 12. Relationship to immutable planning

Production validation must follow the canonical planning architecture.

A committed production plan may contain semantic steps such as:

```text
1. establish a powered assembler production cell
2. verify input delivery and recipe operation
3. verify output collection
```

Local issues such as pathing, a transient entity reference, or retrying one valid placement do not rewrite the plan.

If the committed design contains a structural false assumption — for example the selected connection topology is impossible under verified Factorio geometry — freeze the plan as blocked and follow the user-approved revision protocol.

Do not use production debugging as a loophole for silent semantic replanning.

## 13. Later production maturity goals

The first rocket is not inherently the terminal factory objective.

After basic production construction, fluids, transport, and sustained-rate validation are proven, later roadmap work can introduce capability frontiers such as:

- sustained science per minute (SPM);
- scaling from one stable throughput frontier to another;
- power/logistics/resource headroom;
- resilience and recovery;
- throughput bottleneck localization;
- expansion cost and resource horizon;
- late-game / infinite-research operation.

For these continuous goals:

```text
PLACED != PRODUCING
PRODUCING != SUSTAINING
PEAK RATE != SUSTAINABLE RATE
FRONTIER REACHED != PROJECT ENDED
```

SPM is a useful measurable capability axis, not automatically the sole objective.

The planning shelf may remain open-ended:

```text
current verified frontier
  -> next useful frontier
  -> consolidate/scale
  -> next frontier
  -> ...
```

These are intentionally later goals. Do not let them distract from proving B1-B4 and C1-C3 first.

## 14. Open design decisions to settle with E2E evidence

These are important, but they should be answered from real production traces rather than abstract over-design:

1. **Production-block identity:** how should a group of machines/transport edges be named and correlated across observations/restarts?
2. **Semantic verifier boundary:** which facts belong in one compact `inspectProductionBlock`-style observation versus existing entity/transport tools?
3. **Connectivity validation:** how much inserter/belt/fluid geometry should be rejected pre-construction versus diagnosed post-construction?
4. **Repair authority:** which production failures are local executor recovery and which are structural blockers requiring user-approved plan revision?
5. **Provider reliability gate:** what repeated-run threshold is required before calling A2/A3 production behavior stable?
6. **Fixture ownership:** where should versioned real-Factorio production saves/scenarios live so CI and manual Pterodactyl E2E can use the same semantics?
7. **Fluid graph model:** can Factorio-native runtime APIs give us enough live network identity/connection evidence to avoid reconstructing fluid semantics incorrectly?
8. **Throughput observation window:** what windows are long enough to distinguish buffer drain/peak output from sustainable production?

The immediate implementation does not need all eight answers. B1 A1/A2 should generate evidence for the first decisions.

## 15. Summary

The production-validation strategy is:

> Preserve the historically successful burner drill -> furnace case as a canary.

> Make a powered chest -> inserter -> assembler -> inserter -> chest cell the next real capability frontier.

> Separate harness proof, guided arrangement, and autonomous planning.

> Keep spatial factory design model-authored in A2/A3; deterministic code validates constraints and outcomes rather than supplying a blueprint.

> Judge success by observed production, not placement.

> Validate belts and multi-stage item production incrementally.

> Treat fluids as an independent known-red track and restart with the smallest source -> pipe -> storage network.

> Convert each real failure into a deterministic regression before increasing autonomy or complexity.

> Leave SPM/megabase-style optimization for the later maturity phase, after AIRI has proven it can physically build and verify ordinary production systems.
