# AIRI Factorio — NPC Agent Harness Roadmap

This is the current single-NPC roadmap. Historical pass-by-pass plans are retained under `docs/validation/` and should not be treated as current release gates.

## Current checkpoint

The project has moved beyond the original "prove a zero-player character can wait/move/mine/craft" transition phase. The standalone-NPC architecture is now the baseline being prepared for promotion to `main`.

As of the 2026-09-16 promotion cleanup, `feat/npc-transition-work` had a green ordinary CI at commit `02167ac690c46b056ba2f0a62db056438c702419`. The branch is long-lived and continues to move, so any actual promotion must freeze and record a fresh candidate SHA before heavyweight validation.



## Planning architecture authority

The planning subsystem now has a dedicated canonical roadmap:

- `docs/NPC_PLANNING_ROADMAP.md`

Its core direction is:

- separate the durable user goal, the non-executable LOD Roadmap Shelf, and the current Active Plan;
- use shelfed long-horizon intent as progressive-detail guidance for later planning rounds instead of discarding it;
- let the Main LLM author plan drafts;
- use Jev as a bounded **pre-commit scope critic**, not a co-planner or Plan Tracker writer;
- make committed plans immutable;
- freeze on structural blockers and ask the user before creating a revised plan version;
- fix semantic completion contracts before commit;
- make Plan Tracker a read-only view of the one committed plan and its accepted evidence;
- consolidate plan advancement/replacement behind one transition authority.

Where older Task Board, Project Board, hierarchy, checkpoint, or Jev planning experiments conflict with that roadmap, `NPC_PLANNING_ROADMAP.md` is authoritative.

## Promotion goal

Promote a **validated standalone-NPC baseline** to `main` without claiming that every experimental capability on the integration branch has equivalent E2E coverage.

A promotion checkpoint must preserve these baseline properties:

- AIRI owns a standalone Factorio `character`, not a connected human body;
- zero-player simulation and NPC operation remain supported;
- model mutations use bounded structured operations;
- real inventory/crafting/mining/research/combat/navigation semantics remain engine-backed;
- task completion/cancellation releases physical controls safely;
- restart/death/replacement invalidate stale logical work rather than silently continuing it;
- Pterodactyl install/update/rollback remains transactional;
- environment/Egg configuration remains authoritative over `airi-config.json`;
- ordinary CI is green on the candidate;
- package smoke and real Factorio integration pass for the frozen promotion candidate.

## Validation ladder

Use the cheapest deterministic layer that can actually prove the behavior:

```text
unit/type/contract test
        ↓
compiled/generated-artifact checks
        ↓
real Factorio deterministic harness
        ↓
packaged deployment smoke / upgrade / rollback
        ↓
real provider E2E when the behavior specifically depends on model interaction
```

Do not substitute lower layers for higher layers when the failure mode is engine-, process-, package-, or provider-specific.

## Near-term single-NPC work

### Priority 0 — Grounded capability / prototype discovery

Treat this as a **high-priority harness gap before expanding deeper autonomous production-layout intelligence or compensating with a larger system prompt**.

The current harness already has important pieces of deterministic discovery, but most of them start **after the model already knows an exact Factorio identity**:

- `getRecipeDetails(item_or_recipe)` can resolve producers for an exact item/recipe and derive compatible crafting-machine prototypes from live recipe categories;
- `getPrototypeDetails(name)` exposes static capability metadata for an exact item/fluid/entity prototype, including mining-drill resource categories;
- `solveProduction` can recursively discover bounded enabled recipe routes from an exact target material and return bounded alternative candidates;
- local observation can filter entities by Factorio type, and `findNearestEnemy` is an example of semantic discovery that does not require an exact hostile prototype name.

The missing bootstrap layer is:

```text
human/model intent
"I need something that can automatically mine this resource"
        ↓
bounded deterministic capability query
        ↓
current-game candidate prototype identities
        ↓
exact recipe/prototype inspection
        ↓
LLM chooses among grounded alternatives
```

Without that bridge, a model that does not already know Factorio names can still guess concepts such as "pickaxe", "miner", a recipe name, technology name, or modded machine identity and only discover the mistake during mutation admission.

This capability layer must **not** become a complete prototype dump or a giant deterministic mod encyclopedia. Large overhaul mods make unbounded enumeration both expensive and cognitively useless. Preserve the same bounded-candidate design already used elsewhere:

- query by narrow engine-backed capability/type/category rather than broad natural-language semantic search;
- derive candidates from the running game's prototype/recipe data and current force state rather than a vanilla hardcoded catalogue;
- prefer currently relevant/unlocked/craftable candidates when that distinction is deterministic;
- cap candidate counts and return an explicit `LIMIT_EXCEEDED`/narrowing requirement rather than dumping hundreds of modded prototypes;
- allow hierarchical refinement (capability/category first, exact candidate inspection second);
- return canonical ordering and facts, **not a subjective "best machine" ranking**;
- keep exact mutations gated by existing recipe/prototype validation and world observations.

The architecture goal is not to teach the LLM all of Factorio or every installed mod. It is to make the running Factorio instance capable of answering bounded questions such as "what currently available entities can perform this engine-defined capability?" so the model can choose without inventing identities.

Before adding a new API, audit whether an existing recipe/prototype/planning query can be generalized safely. Prefer a small composable discovery primitive over multiple hardcoded tools such as `getAvailableMiningDrills`, `getAvailableFurnaces`, etc.

A representative E2E acceptance case should start from a high-level goal with no prototype names (for example early automatic resource extraction) and prove that a weaker model can reach valid exact identities entirely through deterministic game queries, without remembered Factorio wiki knowledge.

Validation evidence from the 2026-09-17 early-resource E2E is recorded in `docs/validation/NPC_GROUNDED_BOOTSTRAP_E2E_2026-09-17.md`. That capture also exposed a separate high-severity Task Board correctness issue: a successful operation receipt must not, by positional plan advancement alone, mark an unrelated semantic step complete. Keep batch completion and semantic step completion as separate evidence claims.

### 1. Promotion cleanup and baseline freeze

- keep ordinary CI green;
- reconcile main-only documentation/deployment changes without discarding them;
- archive superseded staging/release notes as historical validation records;
- freeze one candidate SHA;
- run heavyweight Pterodactyl/package and real-Factorio promotion gates;
- promote only after those gates pass.

### 2. E2E harness and observability

Turn real gameplay failures into reproducible regressions. Prefer fixes in observations, tools, runtime semantics, receipts, recovery, and deterministic game knowledge over indefinitely expanding the system prompt.

The detailed learning/bootstrap E2E sequence and acceptance gates are maintained in `docs/NPC_LEARNING_BOOTSTRAP_E2E.md`. That document is the handoff for fresh-start research progression, automated red science, skill verification/reuse, and the later Coal Snake discovery benchmark.

Keep end-to-end behavior traceable:

```text
player request
→ model/provider turn
→ observations/tools
→ structured plan/actions
→ operation admission
→ Factorio execution/result
→ verification/replan
```

Do not log hidden chain-of-thought. Persist only operational plan/state, receipts, safe provider metadata, and explicit model-visible content.

### 3. Map-first remote interaction

For operations Factorio can legitimately perform from map/remote-view semantics, build and validate the map-side primitive before designing vehicle/train/space-platform behavior around local character movement.

The map foundation includes exact entity references, construction/ghost placement, rotation/orientation, deconstruction, upgrade, and other bounded operations with explicit verification.

### 4. Deterministic production planning

The planning path should continue to move game facts out of LLM guesswork and into deterministic tools/contracts.

The intended checkpoint order is:

```text
autorio_planning remote interface
→ contract test
→ CI
→ ordinary-agent solveProduction tool
→ prompt integration
→ Pterodactyl policy/tests
```

Only after that baseline is validated should the planner rely on validated inserter throughput, belt-lane capacity, stacking capacity, and similar transport constraints. Do not pass unverified throughput guesses to the model.

### 5. Vehicle / train / space-platform interaction

Build these on top of validated map and actor primitives. Avoid creating a second ad-hoc control architecture for each transport type.

### 6. Swarm / multi-agent coordination

Swarm work remains a separate layer. Single-NPC ownership, receipts, exact actor identity, map operations, and deterministic planning should be solid before swarm coordination becomes part of the main baseline.

## What is not required for the next main promotion

The next promotion does **not** require:

- perfect autonomous factory design;
- complete production-line reasoning;
- swarm readiness;
- every map primitive to be finished;
- vehicle/train/space-platform support;
- production provider calls in repository CI.

It does require that the promoted baseline accurately documents which capabilities are verified, partially verified, or experimental.
