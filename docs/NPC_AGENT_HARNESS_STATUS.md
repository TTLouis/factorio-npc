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
    - A body that really died still respawns at the Nauvis spawn point.
    - Goal conditions are checked only at slice boundaries, not mid-slice.
    - An RCON failure during the goal check counts as "not yet met", so one extra slice may be planned.

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
- all map/remote operations;
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
