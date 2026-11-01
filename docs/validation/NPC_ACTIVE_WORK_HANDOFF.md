# NPC Active Work Handoff

_Last refreshed: 2026-09-16 local time. This is the short operational handoff for the active chat/workstream. Read this first when starting a new session, then follow the topic-specific documents below._

## Repository / branch

- Repository: `TTLouis/factorio-npc`
- Branch: `feat/npc-transition-work`
- Repository history note: this project was previously named `TTLouis/airi-factorio`; use `factorio-npc` as the current canonical repository.
- Last verified implementation HEAD before this handoff commit: `6896bf69c390cef862a1add569e801d5c27769fb`
- Latest verified CI for that implementation HEAD: GitHub Actions run `35167410995` — **all green**:
  - `pterodactyl-npc-staging`: success
  - `test-typescript`: success
  - TypeScript typecheck: success
  - generated Lua parse with LuaJIT: success
  - raw-JavaScript-slice generated-Lua guard: success
  - native NPC Pterodactyl guard compile: success

The branch is highly concurrent. Never assume the HEAD above is still current. Re-read branch HEAD before every write and preserve concurrent changes.

## What was just completed

### Pterodactyl runtime-v8 `findConstructionSites` exposure — DONE

Commit: `6896bf69c390cef862a1add569e801d5c27769fb`

The active runtime-v8 policy now exposes the already-existing deterministic construction-site finder to the real Pterodactyl E2E NPC.

Implemented in `deploy/pterodactyl/runtime-v8/structured-policy.mjs`:

- strict `findConstructionSites` tool definition;
- strict parser for `width`, `height`, `anchor_unit_number`, `position`, `search_radius`, and `max_candidates`;
- envelope bounds: width/height `2..32`;
- search radius `2..64`;
- candidate count `1..8`;
- exact finite x/y coordinate validation;
- `anchor_unit_number` and `position` are mutually exclusive;
- safe rendering to `autorio_planning.find_construction_sites`;
- the tool description explicitly states that a returned site is only a free envelope, **not** a machine layout or construction approval.

Regression coverage was added in:

`deploy/pterodactyl/runtime-v8/construction-site-policy.test.mjs`

It covers schema strictness, exact/position anchoring, rendering, missing required fields, bounds, extra-field rejection, anchor/position exclusivity, unsafe coordinates, and preservation of the base allowlist boundary.

This closes the previous immediate unfinished item recorded in `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md` section 12.

## Current production-planning baseline

Do not rebuild these from an old chat. The current branch already contains substantial planning work, including:

- provider usage and final-payload prompt observability;
- static prototype caching;
- mutable entity and nearby-entity full/diff/unchanged compression;
- no-progress duplicate-observation recovery;
- receipt/completion coalescing;
- production scope context;
- deterministic production solving;
- bounded multiple recipe-route candidates;
- production topology candidates;
- layout readiness and exact machine groups;
- construction-site finder core;
- ordinary-agent/Autorio `findConstructionSites` exposure;
- Pterodactyl runtime-v8 `findConstructionSites` exposure.

For exact current behavior, read the source and `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md`; the list above is a checkpoint summary, not an API specification.

## Immediate next milestone

### Site candidate -> arrangement handoff

The next work should **not** become a fully deterministic auto-layout engine. The intended split remains:

```text
production scope facts
-> LLM chooses target scale
-> deterministic recipe-route candidates
-> LLM chooses route
-> deterministic topology candidates
-> LLM chooses topology
-> deterministic free construction-site candidates
-> LLM chooses site / arrangement strategy
-> deterministic exact-placement validation
-> bounded execution
-> deterministic verification
```

Before implementing anything, inspect current branch source because concurrent agents may already have advanced this milestone. In particular inspect:

- `packages/autorio/src/construction_site_planning.ts`
- `packages/autorio/src/construction_planning.ts`
- `packages/autorio/src/production_topology.ts`
- `packages/autorio/src/production_planning*.ts`
- current ordinary-agent planning/site tools
- `deploy/pterodactyl/runtime-v8/structured-policy.mjs`
- relevant construction/runtime tests

The likely missing handoff is a compact deterministic geometry packet that gives the LLM enough facts to choose an arrangement inside a selected envelope without asking it to rediscover Factorio mechanics. Candidate facts include machine footprints, selected topology transfer edges, adjacency requirements, pipe connection positions/directions, input/output corridors, power/expansion reservations, and orientation constraints.

Exact coordinates must still pass:

```text
validateConstructionPlan
-> execute_construction_plan
```

Do not let a site candidate itself authorize placement.

## Work after the immediate milestone

The preferred order is:

1. Finish the site-candidate -> arrangement handoff with bounded deterministic geometry facts while preserving LLM design agency.
2. Harden transport validation before claiming sustainable throughput: direct-insertion transfer validation, inserter scenario throughput, belt lane/stacking constraints, and fluid/pipe constraints where relevant.
3. Add production-block semantic observations that summarize a block/resource patch/free area/logistics context instead of repeatedly probing individual entities.
4. Add a bounded region/world revision lifecycle so unchanged regions can avoid redundant materialization when safe, while falling back to a full refresh when the model lacks a valid baseline.
5. Improve production-scope evidence only when E2E shows it is needed: installed nominal capacity, observed utilization, existing block count, power margin, logistics bottlenecks, and multi-surface context.
6. Add Pareto-style pruning of **strictly dominated** route/topology candidates without creating a subjective “best factory” ranking; the LLM keeps meaningful choices.
7. Add efficiency regression gates around representative goals: provider calls, cache-miss input, output tokens, duplicate observations, no-progress rounds, replans, tool-result characters, and successful completion.

Broader project direction remains: keep the standalone NPC reliable first; continue map-first spatial controls and E2E regression harvesting; vehicles/trains/space-platform interactions come after the map foundation; swarm/message-board coordination remains later unless the user explicitly changes scope.

## Rules while continuing

- Fetch current branch HEAD before **every write**.
- If another commit touched the same file or semantics, re-read and intentionally merge; never overwrite it.
- Prefer atomic blob/tree/commit + diff inspection + `force=false` fast-forward for multi-file changes.
- Never force-push this shared branch.
- Convert real E2E failures into deterministic regressions.
- Prefer runtime/tool/harness improvements over growing the prompt.
- Keep smaller/cheaper models in mind: deterministic Factorio facts, calculations, validation, and compression should stay local.
- Do not equate operation admission/completion with goal completion; verify world state.
- Do not invent or expose arbitrary Lua to the model.
- During long tool work, provide visible progress updates instead of remaining silent.

## Documents to read in a new session

Start with this file, then read only the topic documents needed for the task:

- `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md` — production planning and token-efficiency authority.
- `docs/NPC_AGENT_HARNESS_STATUS.md` — current single-NPC integration/promotion status.
- `docs/NPC_AGENT_HARNESS_PLAN.md` — broader harness roadmap.
- `docs/NPC_CONSOLE_CONTEXT_HANDOFF.md` — UI/map/task-board context and broader project decisions.
- `AGENTS.md` — repository invariants and validation rules.

## Copy-paste prompt for a new chat

```text
Continue work on TTLouis/factorio-npc, branch feat/npc-transition-work.

First read:
- docs/NPC_ACTIVE_WORK_HANDOFF.md
- docs/NPC_PRODUCTION_PLANNING_HANDOFF.md
- docs/NPC_AGENT_HARNESS_STATUS.md
- AGENTS.md

Do not trust the previous chat's HEAD. Fetch the latest branch HEAD and current CI before changing anything. This branch is highly concurrent; re-read HEAD before every write, preserve concurrent work, prefer atomic commits, never force-push, and give frequent progress updates.

The most recently verified milestone was Pterodactyl runtime-v8 exposure for findConstructionSites at implementation commit 6896bf69c390cef862a1add569e801d5c27769fb; CI run 35167410995 was fully green. Treat that SHA only as a checkpoint, not as the assumed current HEAD.

Primary current goal: continue the token-efficient production-planning pipeline while preserving LLM agency. The next milestone is the site-candidate -> arrangement handoff. First inspect the latest construction_site_planning, construction_planning, production_topology, production_planning, agent-tool, runtime-v8 policy, and related test code to see what concurrent work already exists.

Do NOT build a giant deterministic auto-layout engine. Deterministic/runtime code should supply compact authoritative geometry/capability facts, validate exact placements, calculate/validate Factorio constraints, and verify execution. The LLM should still choose meaningful factory arrangement/site/topology tradeoffs. Exact placements must go through validateConstructionPlan -> execute_construction_plan.

After that, continue the priorities in NPC_ACTIVE_WORK_HANDOFF.md one small verified milestone at a time: transport validation, semantic production-block observations, region/world revision lifecycle, evidence-driven production-scope improvements, strictly-dominated candidate pruning, and efficiency regression gates.

Convert real E2E failures into regressions. Prefer runtime/tool/harness fixes over larger prompts. Keep smaller/cheaper models in mind. Do not expand into swarm unless the user explicitly changes scope.
```

## Maintenance rule

After each completed milestone, update **this short file** with the new verified checkpoint, CI result, current next milestone, and continuation prompt. Keep deep historical/design details in the topic-specific handoff documents instead of allowing this file to grow into another large archive.
