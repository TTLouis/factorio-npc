# AIRI Factorio — NPC Agent Harness Status

This file is the current status summary for the single-NPC integration line. Historical detailed checkpoints are retained under `docs/validation/`.

## Promotion status

As of 2026-09-16, `feat/npc-transition-work` is the active promotion-candidate/integration branch. During the documentation cleanup the branch HEAD was `02167ac690c46b056ba2f0a62db056438c702419` (`fix(autorio): preserve skills close handler`) and ordinary repository CI was green.

That SHA is a status reference, not a permanent release pin. If the branch moves before promotion, freeze a new candidate SHA and rerun the promotion gates against that exact commit.

## Experimental Jev planning line — verified lifecycle checkpoint

The planning architecture described in `docs/NPC_PLANNING_ROADMAP.md` has a separate experimental implementation line on
`experiment/jev-agent-architecture`. This is not a promotion claim for `feat/npc-transition-work` or `main`.

As of 2026-09-20, code checkpoint
`8a64a2e6bc93e9b7dd8d23e3882d8ae6726dfa25` passed:

- GitHub Actions CI run `35544667059` — `pterodactyl-runtime`, `typescript-quality`, and `factorio-npc-deterministic` all successful;
- Pterodactyl release-gates run `35544667056` — successful.

That checkpoint verifies the redesigned planning acceptance path against real Factorio, including:

- reducer-owned Goal / Roadmap Shelf / Plan Tracker authority;
- player-facing Plan Tracker rendering from `planTrackerView()`, not stale legacy-board progress;
- bounded Jev pre-commit refinement with rejected drafts blocked from operation admission;
- durable plan-to-shelf lineage and verified-result feedback;
- boundary steering reaching the next Main-LLM draft;
- `VERTICAL -> HORIZONTAL -> VERTICAL` across bounded slices;
- real Factorio restart with active planning/shelf/steering lineage preserved;
- structural preflight blocker freezing without mutation;
- ordinary continuation remaining frozen while blocked;
- explicit user revision creating a versioned successor with `derived_from_plan_id`;
- committed completion semantics frozen against post-commit checkpoint rewriting;
- legacy Task Board and `[RUNTIME_COMPAT_STATE]` retained only as compatibility projections, with `[PLANNING_STATE]` the sole model-facing planning authority.

### 2026-09-24 hand trace of the rocket-goal tracks (unit/integration evidence only)

This round was traced and fixed without E2E. Each item has a deterministic regression test, but none of it has real-Factorio evidence yet.

- **Restart mid-slice:** the goal definition, Roadmap Shelf and committed step are restored, and there is no request to redefine the goal.
  - Fixed: a planner restating a *different* checkpoint for a committed step threw `committed_completion_contract_is_immutable` after the plan was already persisted as admitting. That killed the continuation, and after a restart it paused the plan as "could not safely recover".
  - The committed contract is now kept, the proposal is ignored and traced (`step.checkpoint_change_ignored`), and the planner is told why.
- **Between slices** (slice verified, goal still active): restart, a provider failure, and shutdown all silently stranded the goal. The legacy plan reads `completed` there, so neither restart recovery nor auto-resume picked it up.
  - `goalAwaitingNextSlice()` now makes the goal recoverable.
  - Recovery re-checks `doneWhen` in game (and completes the goal if it was met while down) before planning the next slice.
  - Transient failures there schedule auto-resume.
  - Shutdown no longer pauses the verified slice.
- **Space Age:** after a save load, the NPC body was searched only on `game.surfaces[1]`. A body on another planet or a space platform was treated as dead, and a second body spawned on Nauvis.
  - It is now found game-wide by unit number.
  - Known limits:
    - A body that really died respawns empty-handed at (0, 0) of the surface it was last alive on; the mod remembers that surface while the body lives.
    - Goal conditions are checked only at slice boundaries, not mid-slice.
    - An RCON failure during the goal check counts as "not yet met", so one extra slice may be planned.

### 2026-09-24 rocket-path edge cases and QoL (unit/integration evidence only)

A second offline round, again without E2E. Each item has a regression test.

- **Launch:** nothing could launch a built rocket.
  - `launch_rocket {unit_number}` now targets one exact, live-observed silo.
  - It never passes a character to `launch_rocket()`, because that would board the NPC.
  - It completes only when the force's `rockets_launched` rises.
  - `rocket_not_ready` reports the silo's `rocket_parts`, and `getEntityStatus` on a silo reports parts and readiness.
- **Counter goals:** `rockets_launched` and `items_produced` count from goal start, with a game-read baseline. A save that had already launched a rocket completed "launch a rocket" instantly.
- **Dead body:** force-level goal checks now work with no body.
  - A body that died on a space platform respawns on Nauvis.
  - A failed respawn create falls back to Nauvis instead of retrying every tick.
- **Transfers:** NPC→entity and player transfers now move the whole held count, not just the first stack.
- **Player control:**
  - `status` (and `进度`, `状态`) answers without a model call.
  - `Stop!`, `pause`, `停止` and `暂停` now stop at once.
  - A progress line is printed after each verified slice.
- **CI and tracing:**
  - The runtime suite no longer uses `--test-force-exit`, which had silently dropped the last tests of `planning-state.test.mjs`.
  - Prompt tracing now recovers after a failed write.
- **Dry runs:** `rocket-goal-dry-run.test.mjs` runs a whole rocket goal through the real loop against the fake game. It covers a restart, a boundary provider failure, `status`, a death, `rocket_not_ready`, and the launch.

Still unverified in real Factorio:
- the launch confirmation bound (3600 ticks);
- base-game victory handling on a headless server after the first launch;
- whether transfers into a silo can spill into its non-input inventories;
- respawn on platforms.

### 2026-09-24 console redesign (unit evidence only, not yet seen in Factorio)

The left column of the NPC console was rebuilt from the approved "Chosen" mock-up. The right column (camera, inventory, wanted, equipped) is unchanged.

- **Title bar:** Learn, Old tasks and Debug are icon buttons before Close. A status sprite and label show the phase and its detail.
- **Tabs:**
  - NOW: the Goal card (the goal's game checks with progress), the Now card (current step, next steps, pause or block reasons, last result), the Latest card (the 3 newest feed rows plus an "All activity" button) and the conversation.
  - PLAN: the Goal card and the Roadmap Shelf / Active Plan tracker.
  - ACTIVITY: the execution feed with its filters and LIVE button. It was built but hidden before; Debug keeps its own copy.
- **Always visible:** a blocked plan is a banner above the tabs. The prompt and the PAUSE / FOLLOW / … row (NEW TASK and TERMINATE are in …) sit below the tabs.
- **Scroll positions:** pages are built once and a tab switch only flips visibility, so each scroll-pane keeps its position. The selected tab is stored per player, written only in the click handler.
- **Merged repeats:** consecutive identical feed lines show as one row with ×N, updated in place.
- **LuaJIT limit:** `new_combat_controller` was over LuaJIT's 60-upvalue limit. Its tuning constants are now one table.

Not yet checked in real Factorio: the layout as a whole, the icon sprites, `toggled` on frame action buttons and tab buttons, and heights at 1080p.

2026-09-25 (morning): the owner tried the new console in the game and found many things wrong with it. Other agents' fixes (up to `e905cc4`, prompt focus and live conversation reading) did not fix it. The console UI is **P0** for the next work session, ahead of production-rate goals. Don't treat this layout as accepted.

Owner's P0 spec (2026-09-25):

- **Dragging feels laggy, and typing gets interrupted.** The console is refreshed
  continuously, even while the player drags it or types in it. A first look:
  `task_board_ui.ts` refreshes every open console every 60 ticks. Most of the left
  column only rebuilds when a signature changes, but the skills pop-out clears and
  rebuilds its whole body on every refresh, whether or not anything changed.
- **Fix:** split the console into sections that update independently. A section is
  rebuilt only when its own data changes, and an update must not touch the text
  input or the window being dragged.
- **Skills work like past plans:** a list of skills to select from, with a detail
  view for each. The player can also edit a skill.
- **Later, a bigger slice:** the player picks which skill the LLM must use. It is
  not part of P0.
- Buttons also felt laggy (owner): a rebuild between press and release destroys
  the button, so the click is lost.

Fix, `055538a` (unit evidence; not yet seen in the client). The root cause was a
lookup bug, not the refresh rate: since `af1adf3` the tracker refresh couldn't find
the plan list inside its new body flow, so it always failed. Every second and on
every snapshot, the whole console window was destroyed and rebuilt. Now each card
redraws only when its own content changes. Debug and Old tasks do the same, and the
skills pop-out is a skills window like Old tasks, with a list, a detail pane and
EDIT/EXPORT. A GUI stand-in test counts every add/clear/destroy: with all windows
open, a refresh or a repeated snapshot with nothing new changes nothing. Progress:
`docs/validation/CONSOLE_UI_P0_PLAN.md`.

Owner check in the client, 2026-09-25: the console feels a lot better, and the owner
considers the redesign finished. Follow-ups `5d2937b` (status light centred in the
title bar; the preview's clipped "X" coordinate button replaced by a map-pin locate
button) and `0fbd0d7` (the … menu crashed the server: `vertical_spacing` on a frame
is a non-recoverable mod error; the blocked banner had the same latent bug).

### 2026-09-25 log fixes, rate facts and think time (unit + engine-lane evidence)

Deployed locally at `6476fdc`. Plan and checklist:
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md`.

- **Provider HTTP 400 after an output-budget handoff** (`7acc1e3`): the skill
  context was inserted between an assistant `tool_calls` message and its replies. It
  now goes before the first model turn, and a split tool exchange fails locally
  instead of reaching the provider.
- **A refused semantic completion claim failed the request** (`aebbaf25`): claims
  are checked at parse time and go back to the planner as a correction. After a
  resume, a satisfied step closes on the next turn (owner's choice).
- **Router replies were all traced as invalid plans** (`109bc90`): trace-only fix.
- **Recipe and mining rate facts** (W1, merge `96418eb`): `getRecipeDetails` machine
  rates and hand-craft time, new `getMiningDetails` and `estimateProductionTime`
  tools. The `production` engine lane checks the rates against prototypes and a
  measured 40 s window. The harness does the arithmetic; the model picks machine
  counts.
- **`crafting_speed` read on 2.0 prototypes raised** (`6476fdc`):
  `solveProduction` with a machine selection and prototype details now call
  `get_crafting_speed()`. Unit evidence only; no engine lane covers these paths yet.
- **Think time measured** (`a34b569`): plan authoring rounds take 99 s at the
  median (max, on every round of the request), ordinary planning 37 s. The Debug
  window shows the last request's think time. The per-round effort policy is next.

The compatibility projection should not be deleted merely for cosmetic cleanup while other runtime/UI
features still consume it. Future removal should be driven by eliminating those consumers, not by creating
another planning source of truth.

## Verified standalone-NPC foundation

User-reported real-Factorio acceptance work has covered the bounded single-NPC foundation at its stated scopes, including:

- zero connected players with a continuously advancing simulation;
- creation/reacquisition of a standalone `character` with stable actor identity;
- wait, movement, mining, native hand crafting, placement, and bidirectional inventory transfer;
- physical input cleanup after completion/cancellation;
- bounded research submission/follow-through;
- bounded combat, including no-target/no-ammo/cancellation behavior;
- save/process restart with actor reacquisition and fail-safe logical task reconciliation;
- NPC death/replacement with stale-work invalidation;
- bounded navigation around obstacles, moving-target repath, unreachable-target failure, and distinction between AIRI-controlled walking and passive belt displacement.

See the archived harness records and `docs/NPC_RELIABILITY_WORK.md` for the detailed scenarios and limitations of those gates.

## Verified packaged Pterodactyl foundation

The historical v8 release-candidate checkpoint recorded passing package/deployment gates including:

- generated payload/egg integrity checks;
- production-runtime/staging tests;
- zero-player packaged Factorio boot;
- standalone actor readiness;
- graceful save/shutdown;
- existing-save upgrade and rollback without rewriting user saves/mods/config.

The exact historical candidate data is preserved at `docs/validation/PTERODACTYL_V8_RELEASE_CANDIDATE_2026-09-14.md`. It must not be mistaken for proof that every later integration-branch commit has run those same heavyweight gates.

## Current branch capabilities beyond the original baseline

The integration branch now contains substantially more than the original NPC transition. It includes work in areas such as:

- richer task/plan UI and console interaction;
- behavior tracing and provider recovery/steering;
- production-planning helpers and transport-capacity tooling;
- map construction/deconstruction/upgrade/orientation primitives;
- discovery/knowledge/learning/skill work;
- additional reliability and operation-receipt contracts;
- early swarm-facing identifiers/foundations.

These features do **not** all share the same level of real-engine/provider E2E evidence. Their presence on the branch should not be read as an assertion that they are all release-complete.

## Current promotion blockers

There is no longer a known architectural blocker that requires keeping the standalone-NPC baseline permanently off `main`.

Before promotion, however, the repository should still:

1. keep the frozen candidate's ordinary CI green;
2. reconcile the six main-only commits intentionally rather than overwriting them;
3. preserve main's Docker Compose WIP documentation and Python/CI decisions;
4. run the heavyweight Pterodactyl package smoke and real zero-player Factorio integration against the exact candidate SHA;
5. record the promotion SHA and gate results as a new validation checkpoint;
6. avoid pulling unrelated failing swarm work into the single-NPC promotion.

## Known non-blocking limitations / future work

The next main promotion does not claim complete coverage of:

- autonomous end-to-end production-line design;
- validated inserter/belt-lane/stacking throughput reasoning across all relevant research states;
- map/remote operations: with zero connected players they now read the NPC's own 5x5 map knowledge (`docs/validation/NPC_MAP_KNOWLEDGE_LIVE_VALIDATION_2026-09-25.md`); the player-join map sync is unit-tested only, and neutral unit-numbered entities cannot be marked for deconstruction by the engine;
- vehicles, trains, or space platforms;
- swarm/multi-agent coordination;
- every provider/model-specific behavior in production conditions.

These remain roadmap work and should continue to be validated incrementally rather than hidden behind a larger prompt.

## Documentation authority

- Current roadmap: `docs/NPC_AGENT_HARNESS_PLAN.md`
- Planning architecture: `docs/NPC_PLANNING_ROADMAP.md` — canonical Goal / LOD Shelf / immutable Active Plan / Jev pre-commit review direction.
- Production validation: `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` — canonical production E2E ladder, historical canary, powered-assembler frontier, fluid known-red track, and promotion evidence.
- Stable actor architecture: `docs/NPC_CHARACTER_ARCHITECTURE.md`
- Current Pterodactyl operation/deployment: `deploy/pterodactyl/README.md`
- Detailed single-NPC reliability history: `docs/NPC_RELIABILITY_WORK.md`
- Historical checkpoints and superseded staging docs: `docs/validation/`
