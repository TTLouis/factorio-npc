# NPC Production Planning / Token-Efficiency Handoff

_Last updated from `feat/npc-transition-work` on 2026-09-16. The branch is active and may advance concurrently; always re-read HEAD before writes._

## Purpose

This document is the handoff point for the current NPC planning and LLM-efficiency work. It exists so a new ChatGPT/Codex session can resume without relying on the full conversation history.

Primary repository: `TTLouis/factorio-npc`

Primary working branch: `feat/npc-transition-work`

Repository history note: this project was previously under `TTLouis/airi-factorio`; the repository was renamed/detached to `factorio-npc`. Do not assume the old repo URL is authoritative.



## Production E2E validation authority

Production planning machinery and real gameplay capability are intentionally tracked separately.

Use:

- `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`

for the canonical production capability ladder, current historical baseline, powered-assembler frontier, fluid validation track, E2E fixtures, semantic acceptance states, and evidence requirements.

Important current direction:

- the historically successful burner mining drill -> stone furnace case is a **canary**, not the next milestone;
- the immediate new capability frontier is a powered chest -> inserter -> assembler -> inserter -> chest production cell;
- validate each scenario first as a deterministic exact-layout fixture, then guided AI arrangement, then autonomous AI planning;
- fluid systems remain a separate known-red validation track;
- code-level solver/topology/geometry coverage must not be reported as a real production E2E pass.

## Governing design principle

The goal is not to turn the NPC into a giant deterministic factory bot.

Deterministic/runtime code should do what Factorio itself can know or calculate reliably:

- read authoritative world state;
- aggregate and compress observations;
- cache immutable/static facts;
- calculate recipe ratios and machine counts;
- validate capacities and geometry;
- enumerate bounded feasible choices;
- reject impossible plans;
- verify execution outcomes.

The LLM should retain meaningful agency:

- decide how large a production expansion should be;
- choose among valid recipe routes;
- choose among topology/design archetypes;
- choose actual arrangement/site tradeoffs;
- adapt strategy when the world changes;
- decide what to do next after verified execution.

The token-efficiency rule is:

> Only send the LLM information that is necessary for the next decision. Anything Factorio/runtime can determine, compress, cache, aggregate, diff, or validate locally should not be repeatedly placed in model context.

Every proposed optimization should be judged by:

1. Does it reduce provider calls?
2. Does it reduce repeated input tokens?
3. Does it increase decision-relevant information per token?

Logging, durable memory, and active prompt context are separate concerns:

- **Logging** may be verbose and persistent.
- **Memory** may retain durable task state or learned facts.
- **Prompt context** should stay compact and decision-relevant.

## Current planning pipeline

The intended pipeline is now:

```text
Player goal
  ↓
Production scope facts
  ↓
LLM chooses production scale / target rate
  ↓
Deterministic recipe-route candidates
  ↓
LLM chooses route
  ↓
Deterministic topology candidates
  ↓
LLM chooses topology
  ↓
Layout readiness / machine groups
  ↓
LLM chooses desired factory envelope / arrangement strategy
  ↓
Deterministic construction-site candidates
  ↓
LLM chooses a site and exact arrangement
  ↓
Exact construction validation
  ↓
Execution
  ↓
Deterministic verification / continuation
```

The runtime must not silently collapse this into "local code chooses everything".

---

# Completed work

## 1. Provider usage / prompt observability

The runtime now has request-level usage tracking for provider calls and tool activity. Important request-level fields include provider call counts, input/cache/output usage units, tool calls, duplicate calls, tool-result characters, and coalesced runtime events.

Behavior trace default path on Pterodactyl:

```text
/home/container/logs/sgluna-behavior.jsonl
```

Pterodactyl File Manager path:

```text
logs/sgluna-behavior.jsonl
```

A full final-payload prompt trace was also added. It records the actual final provider payload after compact continuation/steering is applied, not a pre-compression approximation.

Prompt trace default path:

```text
/home/container/logs/sgluna-prompts.jsonl
```

File Manager path:

```text
logs/sgluna-prompts.jsonl
```

The prompt trace is bounded/rotated and secret-sanitized. Use it to answer questions like:

- What did model round 6 actually receive?
- Why did a request reach 100k+ cached input?
- Which tool schemas/messages were still present?

## 2. Duplicate/static observation reduction

### Static prototype cache

`getPrototypeDetails` is treated as static prototype data during the server runtime lifetime.

The first lookup gets the full prototype facts. Later rounds reuse a compact static baseline/reference rather than repeating the full RCON response.

Important constraint: this is only for truly static prototype data. Mutable entity/inventory/world state must not be treated this way.

### Mutable entity status diff

`getEntityStatus` remains a live RCON read every time, but the LLM-facing observation is compressed to:

- `full`
- `diff`
- `unchanged`

Diff reuse is only valid when the stable entity identity matches (`unit_number`). If the nearest matching entity changes identity, the runtime sends a new full snapshot.

### Nearby entity diff

`getNearbyEntities` also remains a live read, but results are canonicalized before diffing.

Identity rules:

- prefer `unit_number` when present;
- otherwise use a bounded fallback identity derived from name/type/position.

Array ordering changes do not create fake diffs.

If a scan is truncated, diffing is disabled and a full result is used because "removed" cannot be inferred safely from a truncated list.

## 3. Agent-loop no-progress reduction

Repeated identical observation loops no longer get multiple extra tool-enabled rounds.

Previous behavior could spend roughly:

```text
1 real RCON observation
+ repeated cached observation rounds
+ up to several provider calls
+ final failure
```

Current behavior:

```text
first observation
→ first duplicate/no-progress observation
→ immediately switch to tools-disabled recovery
→ model must act from already collected facts or report a blocker
```

This preserved recovery opportunity while reducing wasteful provider/tool loops.

## 4. Completion/event coalescing

The runtime already has:

- supervisor-level completion/error debounce;
- semantic receipt coalescing in the agent layer;
- deterministic task receipt verification.

Do not add another generic debounce unless a real E2E trace proves a separate duplicate wake-up path exists.

## 5. Direct UI controls do not use the LLM

Explicit UI controls such as Follow are direct runtime operations.

General rule:

> explicit, parameter-complete, deterministic UI controls → direct runtime;
> natural-language intent requiring interpretation → LLM.

Do not reintroduce LLM calls into Follow just for consistency with chat commands.

---

# Production planning status

## 6. Exact deterministic production solver

The core production solver already calculates a bounded production graph locally, including:

- recipe dependency graph;
- target production rates;
- crafts/second;
- ingredient rates;
- external inputs;
- explicit machine sizing;
- utilization.

The LLM should not recompute these values manually.

Transport capacity remains a separate validation concern.

Inserter prototype facts must not be converted into guessed fixed items/second. Scenario-specific throughput must be measured or otherwise deterministically validated.

## 7. Production scope context

A major architecture gap was identified: exact planning is useless if the requested production rate was guessed without understanding the current factory.

The current architecture therefore separates **scope choice** from **route solving**.

`getProductionScope` provides current-surface observed facts for the target and bounded upstream materials, including short/long flow windows such as observed production, consumption, and net flow.

Important semantics:

- observed net flow is not guaranteed sustainable spare capacity;
- the tool does not return `recommended_target_rate`;
- the model chooses the intended rate/scale;
- if the player already provided an explicit production rate/scope, avoid the extra scope observation.

Desired reasoning sequence:

```text
"expand green circuits"
→ getProductionScope
→ model decides e.g. +6/s
→ solveProduction at 6/s
```

instead of:

```text
"expand green circuits"
→ model guesses 30/s
→ solver perfectly solves the wrong scale
```

## 8. Multiple recipe-route candidates

Automatic recipe ambiguity is no longer intended to force the LLM to guess a route before the deterministic solver can help.

The candidate layer now performs bounded route enumeration and solves each route using the existing exact solver.

Important rules:

- single-route solving remains supported;
- explicit `included_recipe_names` still narrows to the requested route scope;
- route choices are deterministic/canonical, not ranked as "best";
- shared ambiguous intermediates must use a globally consistent recipe choice inside a candidate;
- candidate enumeration is bounded;
- if more than the supported complete candidate count exists, fail closed with a limit error rather than silently pretending the first few candidates are the full choice set.

Current default design target is at most about 5 complete route candidates presented to the LLM.

## 9. Production topology candidates

A deterministic topology layer was added on top of a solved production graph.

The topology layer does **not** repeat the whole recipe graph inside each candidate. Common transfer information is factored out to keep token cost low.

Current topology archetypes include bounded options such as:

- belt-fed / distributed feed;
- direct insertion when internal item transfers are compatible with one-to-one adjacency;
- shared-intermediate distribution when one produced intermediate serves multiple downstream consumers;
- pipe requirements for fluid flows.

Important agency/safety boundaries:

- topology candidates are canonical but **not ranked**;
- the candidate list is not claimed to exhaust every possible Factorio factory design;
- external item transport strategy may remain unresolved rather than being silently forced to belts;
- direct insertion still requires adjacency and inserter-throughput validation;
- topology metadata is a design option, not an executable layout;
- do not claim sustainable throughput until required validations have passed.

## 10. Layout readiness

The topology result also exposes whether the solved route is ready for spatial planning.

Conceptually:

```text
layout_readiness:
  ready
  missing_machine_selections
  machine_groups
```

If machine selection/sizing is incomplete:

```text
ready: false
```

and the model must choose machine prototypes before site/layout planning.

When fully sized, compact machine groups provide the actual recipe group, machine prototype, and exact machine count required by the solver.

The runtime does not silently choose an assembler tier for the LLM.

---

# Construction-site planning status

## 11. Construction-site candidate core

A deterministic free-envelope site finder has been added and verified in the Autorio/ordinary-agent path.

Core file:

```text
packages/autorio/src/construction_site_planning.ts
```

The purpose is to answer:

> Where are a few bounded rectangular areas large enough for the LLM's requested factory envelope?

It deliberately does **not** answer:

> Where should every assembler, inserter, belt, pipe, and pole go?

Current request shape is approximately:

```text
findConstructionSites({
  width,
  height,
  anchor_unit_number?,
  position?,
  search_radius?,
  max_candidates?
})
```

Important bounds/semantics:

- envelope size is bounded (currently small factory-block scale, up to roughly 32x32);
- search radius is bounded;
- results are bounded to a small candidate list;
- total evaluation count is bounded;
- non-character entities reject the strict empty envelope;
- blocking water/out-of-map rejects the envelope;
- characters are treated as transient occupancy and reported rather than permanently invalidating a long-term site;
- rejection details are aggregated instead of dumping hundreds of rejected coordinates;
- a returned site is a **free rectangular envelope only**;
- exact machine placements still require `validateConstructionPlan` before execution.

This is intentionally conservative. A future policy may allow removable natural obstacles, but it should be introduced only after E2E evidence justifies it.

### Ordinary-agent / Autorio exposure

The core is already exposed through the Autorio planning remote and ordinary-agent tool path.

The core/site-finder work was previously verified by runtime/tests/typecheck/TSTL/native guard CI.

---

# CURRENT IN-PROGRESS WORK

## 12. Pterodactyl runtime-v8 exposure for `findConstructionSites`

This is the immediate unfinished task.

The real E2E NPC uses `deploy/pterodactyl/runtime-v8/structured-policy.mjs`, so the site-finder is not considered fully integrated until Nova/runtime-v8 can see and render the tool.

Needed change:

1. add strict `findConstructionSites` parser/schema to active runtime-v8 structured policy;
2. add safe Lua command rendering to `autorio_planning.find_construction_sites`;
3. add runtime policy regression for bounds, anchor/position exclusivity, extra-field rejection, and rendering;
4. run the complete Pterodactyl/runtime test suite;
5. run TypeScript/TSTL/LuaJIT/native guard CI.

### Current implementation state at handoff

A local exact patch for the active runtime policy and its regression was prepared and syntax-checked, but it was **not committed** because the GitHub connector did not expose a patch-file action and blindly replacing a ~24–27KB policy through truncated tool output was considered unsafe.

Do not assume that local scratch files from a previous chat/session still exist.

Before continuing:

- re-read current `feat/npc-transition-work` HEAD;
- re-read `deploy/pterodactyl/runtime-v8/structured-policy.mjs`;
- re-read `deploy/pterodactyl/runtime-v8/production-planning-policy.test.mjs` or create a focused site-policy test if more appropriate;
- prefer an atomic detached blob/tree commit when possible;
- do not force-push.

### Packaging constraint

The Pterodactyl installer currently copies the active runtime-v8 `structured-policy.mjs` directly. A wrapper/extra-module approach would require changing installer copy lists, manifest checks, and release-copy contracts.

That is too much deployment churn for this small tool exposure unless a later refactor intentionally modularizes runtime policy.

Therefore the near-term preferred fix is a small direct additive patch to the active runtime policy, followed by regression/CI.

---

# Planned next work

## 13. Site candidate → arrangement handoff

After runtime-v8 can call `findConstructionSites`, do **not** jump directly to a fully deterministic factory auto-layout engine.

The intended next step is to give the LLM enough compact geometric facts to choose an arrangement inside the selected free envelope.

Useful deterministic inputs may include:

- machine footprints;
- selected topology transfer edges;
- adjacency requirements;
- pipe connection directions/positions;
- required input/output corridors;
- power corridor/reserved expansion intent;
- orientation constraints.

The LLM should still choose the meaningful factory arrangement/topology tradeoff.

Then exact placements go through:

```text
validateConstructionPlan
→ execute_construction_plan
```

Do not skip exact placement validation.

## 14. Transport validation

Before claiming a production block sustains its target rate, validate relevant transport constraints.

Already-supported deterministic facts include belt/lane limits and researched stacking ceilings.

Still important:

- inserter scenario throughput must not be guessed from hand size;
- direct-insertion candidates need real adjacency + transfer validation;
- pipe/fluid throughput must be treated explicitly when it matters;
- external transport strategy may need observation of existing logistics rather than assuming a new belt.

## 15. Production-block semantic observation

A later high-value token optimization is a compact production-block/world model so the LLM does not repeatedly query individual machines.

Candidate semantic hierarchy:

```text
surface
  └─ region
      ├─ resource_patch
      ├─ production_block
      ├─ logistics_corridor
      ├─ power_network
      ├─ train_network
      ├─ defense_zone
      └─ free_build_area
```

Do not attempt the whole hierarchy at once.

Start with the pieces that directly reduce expensive repeated observations:

- production block summary;
- resource patch summary;
- free-area/site summary;
- logistics/transport summary.

## 16. Region/world revision and observation lifecycle

The current entity/nearby diff work still performs live reads before deciding full/diff/unchanged.

A future optimization can add bounded region/world revisions so some observation paths can avoid even the redundant RCON/materialization step when the relevant region is known unchanged.

Safe conceptual envelope:

```text
ObservationEnvelope {
  key
  revision
  mode: full | diff | unchanged
  base_revision?
  summary
  delta?
  stats
}
```

Do not send a delta if the model no longer has a usable baseline. Fall back to a compact full refresh when required.

## 17. Production scope context improvements

Current scope context is intentionally modest. Future additions should be evidence-driven and token-conscious.

Possible additions:

- installed nominal capacity;
- observed utilization;
- existing production-block count;
- power margin / power state;
- logistics bottleneck summary;
- force-wide vs current-surface context for multi-surface/Space Age production.

Do not dump all item statistics for the entire save into every prompt.

Prefer target-oriented expansion around the current production goal.

## 18. Pareto pruning / candidate compression

Route/topology candidate sets should remain small.

A future local pruning stage may remove clearly dominated candidates across dimensions such as:

- machine count;
- external input burden;
- belt count / logistics complexity;
- footprint estimate;
- required technologies;
- validation burden.

The deterministic layer may prune strictly dominated choices, but it should not create a subjective "best factory" ranking.

The LLM should choose among materially distinct surviving options.

## 19. Efficiency regression gates

After the structural planning path is stable, add E2E efficiency metrics around representative player goals.

Track at least:

- provider calls per completed player goal;
- output tokens per goal;
- cache-miss input per goal;
- duplicate observations;
- no-progress rounds;
- replans;
- total tool-result characters;
- whether the request completed successfully.

A useful long-term regression style is:

```text
functional: PASS
requests: <= budget
replans: <= budget
no_progress: <= budget
```

Initially treat efficiency budgets as warnings until enough E2E data exists.

---

# Operational / concurrency rules

The branch is actively modified by multiple agents.

Before **every write**:

1. re-read the current branch HEAD;
2. check whether concurrent commits touched the same files/semantics;
3. if they did, rebase/merge the logic intentionally;
4. never overwrite another agent's work;
5. never force-push.

For multi-file changes, prefer an atomic Git-data commit:

```text
create blobs
→ create tree against exact latest parent
→ create detached commit
→ inspect diff
→ re-read HEAD
→ fast-forward with force=false
```

Do not leave the branch in a test-only/intermediate state if it can be avoided.

During long work, provide frequent progress updates. The user explicitly needs visible progress so the system does not interpret long silent tool work as a hung session.

---

# E2E debugging guidance

When a Factorio E2E request appears stuck in `THINKING` with many `OBS` events and no `ACT`:

1. inspect `sgluna-prompts.jsonl` for the exact provider rounds;
2. inspect `sgluna-behavior.jsonl` for tool sequence/usage;
3. distinguish different-prototype/entity reads from true duplicate reads;
4. convert the bad trace into a regression case;
5. prefer harness/runtime/tool fixes over adding large prompt text.

A request such as "continue building power" or "expand green circuits" should increasingly follow this compact reasoning path:

```text
scope facts
→ one explicit LLM scope decision
→ deterministic solved routes
→ one route choice
→ deterministic topology options
→ one topology choice
→ site/layout facts
→ exact validated construction
```

not:

```text
getNearbyEntities
getEntityStatus xN
getPrototypeDetails xN
model round N
more observation
more observation
...
```

---

# Suggested new-chat prompt

If this conversation becomes too long, start a new ChatGPT/Codex conversation with the following prompt:

```text
Continue work on TTLouis/factorio-npc, branch feat/npc-transition-work.

First read:
- docs/NPC_PRODUCTION_PLANNING_HANDOFF.md
- docs/NPC_AGENT_HARNESS_STATUS.md
- AGENTS.md if present/relevant

Do not assume the branch HEAD from the previous chat; fetch the latest HEAD first.

Primary goal: continue the token-efficient NPC production-planning pipeline while preserving LLM agency. Deterministic/runtime code should aggregate facts, calculate exact ratios, enumerate bounded feasible candidates, validate constraints, and verify execution. The LLM should still decide production scope, route/design/topology, site/arrangement tradeoffs, and adaptations.

Immediate unfinished task from the handoff document: finish Pterodactyl runtime-v8 exposure for findConstructionSites, with strict schema/renderer regression and full CI. Do not redesign the site-finder core unless current branch changes or failing tests require it.

After that, continue the roadmap in the handoff document one small verified milestone at a time. Convert E2E failures into regression tests. Prefer runtime/tool/harness fixes over larger prompts. Keep smaller/cheaper models in mind.

Branch concurrency is high: re-read HEAD before every write, preserve concurrent commits, prefer atomic commits, never force-push, and give frequent progress updates while working.
```

---

# Quick status summary

As of this handoff:

```text
Prompt/usage observability                     DONE
Static prototype cache                        DONE
Entity full/diff/unchanged                     DONE
Nearby-entity canonical diff                   DONE
No-progress duplicate-loop recovery            DONE
Completion/receipt coalescing                  DONE
Production scope context                       DONE
Exact production solve                         DONE
Bounded multi-route candidates                 DONE
Topology archetypes                            DONE
Layout readiness / machine groups              DONE
Construction-site finder core                  DONE
Ordinary-agent site-tool exposure              DONE
Pterodactyl runtime-v8 site-tool exposure       IN PROGRESS
Exact arrangement/site execution integration   NEXT
Transport validation hardening                 LATER
Region/world revision model                    LATER
Production semantic world model                LATER
Efficiency E2E budgets                         LATER
```

Keep this document updated when a milestone is completed so future sessions can resume from repo state instead of chat history.
