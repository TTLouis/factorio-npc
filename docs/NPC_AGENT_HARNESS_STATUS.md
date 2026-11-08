# SGLuna Factorio — NPC Agent Harness Status

External, plan and pursuit now share one source codebase; see [harness modes](HARNESS_MODES.md).
The historical evidence below retains its original candidate and scope. Consolidation
does not establish new gameplay success. Dated checkpoints through October 24, 2026 are in
the [status log](https://github.com/TTLouis/factorio-npc/blob/b860bd9e7b54d02d690d8b6cf74e2c9c1fb8ba98/docs/validation/NPC_AGENT_HARNESS_STATUS_LOG_2026-09-16_TO_2026-10-24.md).
Newer dated evidence is in [proofs](proofs/README.md) and
[validation history](validation/README.md). Keep new raw evidence locally; publish only reviewed proof summaries.

## Current state

All three lifecycles develop and integrate on `main`; use
[runtime mode selection](HARNESS_MODES.md) rather than a legacy built-in branch.
Optional Jev support is available in plan mode without switching source lines.
Branch availability does not establish that every feature or proposed design
has passed the same native or provider-backed gates.

### External harness (`main`)

- Latest prerelease: [v0.1.0-pre.1](releases/external-harness-v0.1.0-pre.1.md),
  source `c4108ab1`.
- Furthest published production proof: [electrified starter base on November 5](proofs/2026-11-05-electrified-starter-base.md),
  with 21 new science packs during a 10-minute 19-second hands-off window,
  electric mining, automatic fuel service and lab delivery. Its Factorio 2.0.77
  source and limited production layout remain historical evidence, not validation
  of every later 2.1.24 candidate or either built-in lifecycle.
- After the prerelease, November 2–3 fixes on `main` explain refusals, report
  observed operation effects and running-receipt progress, mark placement
  candidates that external placement refuses, and report the fluid preservation
  network bound. They have no new gameplay proof.
- Supported operations and limits are in the
  [runtime guide](EXTERNAL_HARNESS.md#current-capability-boundary).

### Built-in planner and Jev (plan mode; historical experiment evidence)

The last checkpoint recorded on this page is the
[reviewed Run AU repair](https://github.com/TTLouis/factorio-npc/blob/b860bd9e7b54d02d690d8b6cf74e2c9c1fb8ba98/docs/validation/RUN_AU_HARNESS_REPAIR_2026-10-24.md) of
October 24. It restores safe continuation; it is not gameplay success. Later Run
AV–AY repair records (October 25–26) are listed in
[validation history](validation/README.md). Those reports refer to their own
historical experiment candidate. The implementation is now preserved in the shared codebase.

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
- bounded navigation around obstacles, moving-target repath, unreachable-target failure, and distinction between SGLuna-controlled walking and passive belt displacement.

See the archived harness records and `docs/validation/NPC_RELIABILITY_WORK.md` for the detailed scenarios and limitations of those gates.

## Verified packaged Pterodactyl foundation

The historical v8 release-candidate checkpoint recorded passing package/deployment gates including:

- generated payload/egg integrity checks;
- production-runtime/staging tests;
- zero-player packaged Factorio boot;
- standalone actor readiness;
- graceful save/shutdown;
- existing-save upgrade and rollback without rewriting user saves/mods/config.

The exact historical candidate data is preserved at `docs/validation/PTERODACTYL_V8_RELEASE_CANDIDATE_2026-09-14.md`. It must not be mistaken for proof that every later integration-branch commit has run those same heavyweight gates.

## Built-in planner capabilities beyond the original baseline

The shared codebase preserves substantially more than the original NPC transition. It includes work in areas such as:

- richer task/plan UI and console interaction;
- behavior tracing and provider recovery/steering;
- production-planning helpers and transport-capacity tooling;
- map construction/deconstruction/upgrade/orientation primitives;
- discovery/knowledge/learning/skill work;
- additional reliability and operation-receipt contracts;
- early swarm-facing identifiers/foundations.

These features do **not** all share the same level of real-engine/provider E2E evidence. Their presence on main should not be read as an assertion that they are all release-complete.

## Historical built-in planner promotion checkpoint (September 26, 2026)

The following checkpoint predates the shared-main integration. It preserves
that candidate's promotion work and target, not a current instruction to move
plan mode from a separate branch.

There is no longer a known architectural blocker that requires keeping the standalone-NPC baseline permanently off `main`.

Before promotion, however, the repository should still:

1. keep the frozen candidate's ordinary CI green;
2. reconcile the six main-only commits intentionally rather than overwriting them;
3. preserve main's Docker Compose WIP documentation and Python/CI decisions;
4. run the heavyweight Pterodactyl package smoke and real zero-player Factorio integration against the exact candidate SHA;
5. record the promotion SHA and gate results as a new validation checkpoint;
6. avoid pulling unrelated failing swarm work into the single-NPC promotion.

Target for `v0.1.0-pre.2` (owner, 2026-09-26): any model stronger than DeepSeek flash
takes a cold-start NPC to electricity (an electric mining drill working on steam power,
verified from world state); stretch goal automated red and green science. Not met yet:
the 2026-09-26 steam run (`docs/validation/E2E_STEAM_POWER_2026-09-26.md`) stopped at
step 2 of 6 on the per-request output cap. Plan: `docs/validation/PARALLEL_PRODUCTION_WORK_PLAN.md`
"Next week".

## Known non-blocking limitations / future work

The shared main codebase does not claim complete coverage of:

- autonomous end-to-end production-line design;
- validated inserter/belt-lane/stacking throughput reasoning across all relevant research states;
- map/remote operations: with zero connected players they now read the NPC's own 5x5 map knowledge (`docs/validation/NPC_MAP_KNOWLEDGE_LIVE_VALIDATION_2026-09-25.md`); the player-join map sync is unit-tested only, and neutral unit-numbered entities cannot be marked for deconstruction by the engine;
- vehicles, trains, or space platforms;
- swarm/multi-agent coordination;
- every provider/model-specific behavior in production conditions.

These remain roadmap work and should continue to be validated incrementally rather than hidden behind a larger prompt.

## Documentation authority

- Documentation index and owning contracts: [docs/README.md](README.md)
- External harness runtime and setup: `docs/EXTERNAL_HARNESS.md`, `docs/EXTERNAL_HARNESS_SETUP.md`
- Built-in planner roadmap: `docs/NPC_AGENT_HARNESS_PLAN.md`
- Planning architecture: `docs/NPC_PLANNING_ROADMAP.md` — canonical Goal / LOD Shelf / immutable Active Plan / Jev pre-commit review direction.
- Production validation: `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` — canonical production E2E ladder, historical canary, powered-assembler frontier, fluid known-red track, and promotion evidence.
- Stable actor architecture: `docs/NPC_CHARACTER_ARCHITECTURE.md`
- Current Pterodactyl operation/deployment: `deploy/pterodactyl/README.md`
- Detailed single-NPC reliability history: `docs/validation/NPC_RELIABILITY_WORK.md`
- Historical checkpoints and superseded staging docs: `docs/validation/`
