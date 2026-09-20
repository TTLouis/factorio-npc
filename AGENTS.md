# AGENTS.md

These repository notes are for coding agents working on this fork. They describe current project invariants and validation expectations; user instructions for a specific task remain authoritative.

## Project direction

AIRI is an autonomous in-world Factorio NPC. The core runtime must not depend on owning or impersonating a connected human player.

The intended actor is a real standalone Factorio `character` controlled through bounded mod/runtime APIs. Human players are requesters and observers, not AIRI's body.

## Architecture invariants

- Keep NPC ownership actor-based, not `LuaPlayer`-ownership based.
- Zero connected humans must remain a valid operating state.
- Preserve physical game mechanics where practical: real inventory, native hand crafting, real mining state, research, combat, reach/collision constraints, save/restart behavior, and character death/recovery.
- Do not replace difficult Factorio mechanics with test-only teleporting, instant item insertion, fake completion, or other production shortcuts.
- Model mutations must remain structured and bounded. Do not reintroduce arbitrary model-generated Lua, shell commands, console commands, or unrestricted `remote.call(...)` strings.
- The harness/runtime owns authoritative state, validation, admission, receipts, and recovery. The model chooses actions from approved observations/tools.
- Planning has explicit ownership boundaries: user goal, non-executable LOD Roadmap Shelf, and immutable committed Active Plan. The Main LLM authors drafts; Jev may critique scope before commit but must not mutate committed plan semantics or advance Plan Tracker.
- A structural blocker freezes the committed plan. Do not silently replan; a revised plan version requires explicit user approval. Ordinary bounded runtime recovery that preserves the committed semantic step does not require user interruption.
- Strategic steering (`vertical | horizontal | maintain | recover`) is evaluated at safe planning boundaries and is relative to the current critical path. It may guide which shelf node the Main LLM refines next, but it must not mutate or replace a healthy committed plan; vertical/horizontal cadence is evidence-driven, not a forced alternation.
- Prefer deterministic game data and validated constraints over asking the LLM to guess Factorio rules.
- Do not silently treat a successful admission/command as proof that the user's gameplay goal is complete. Verify relevant world state.
- Preserve exact actor/operation correlation across asynchronous work. Stale work after actor replacement, death, restart, or epoch change must fail safely.

## Validation rules

- Unit tests and typechecks are required regression gates but are not proof of real Factorio engine behavior.
- For engine semantics, prefer deterministic real-Factorio integration coverage under `tests/factorio/`.
- Never weaken a failing E2E assertion merely to make a scenario pass. Fix the runtime/harness assumption or make the limitation explicit.
- Do not pass unvalidated throughput assumptions to the model. Inserter, belt-lane, stacking, recipe, and transport constraints should be measured or derived deterministically before becoming planning facts.
- Keep real provider credentials out of repository tests and CI.
- Pterodactyl package smoke/release gates are separate from ordinary CI and should be used for promotion checkpoints.
- Production gameplay capability is promoted by real Factorio evidence, not by code presence alone. Follow `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`: exact-layout harness proof before guided/autonomous provider trials, semantic output verification instead of placement-only success, and a separate fluid validation track.
- Preserve the historical burner-drill -> furnace path as a production canary. The current unproven frontier is powered assembler/inserter production; fluid systems remain known-red until revalidated from a minimal live network.

## Branch and promotion policy

- `main` is the stable integration/deployment baseline.
- `feat/npc-transition-work` is the active single-NPC integration/E2E branch and may contain capabilities newer than main.
- A green feature HEAD is not automatically a release. Freeze a candidate SHA, run the appropriate heavyweight gates, then promote a validated checkpoint.
- Preserve main-only deployment/documentation changes when reconciling a long-lived feature branch.
- Do not mix swarm experiments into a single-NPC promotion unless they are explicitly in scope and independently validated.
- Do not force-push or rewrite shared branch history unless the user explicitly requests it.

## Current development priorities

1. Keep the standalone-NPC baseline reliable and promotion-ready.
2. Turn E2E failures into deterministic regression cases and useful behavior traces.
3. Prefer map-first remote operations for interactions that Factorio can perform from map/remote-view semantics.
4. Keep production planning deterministic where the game can supply exact recipe/topology/capacity data.
5. Validate inserter throughput, belt lanes, stacking capacity, and similar transport constraints before relying on them in LLM planning.
6. Build vehicle/train/space-platform interaction after the map-operation foundation is sound.
7. Treat swarm/message-board work as a later coordination layer, not a prerequisite for the single-NPC baseline.

## Pterodactyl configuration authority

Deployment environment/Egg variables are the source of truth. Runtime-visible non-secret values may be mirrored into `airi-config.json`, but that file must not override environment values.

Secrets such as `OPENAI_API_KEY` and Factorio credentials must not be committed or persisted into non-secret config files.

## Documentation roles

- `README.md`: current public/project overview and deployment entry points.
- `docs/NPC_CHARACTER_ARCHITECTURE.md`: stable actor/body design decisions.
- `docs/NPC_AGENT_HARNESS_PLAN.md`: current single-NPC roadmap and promotion gates.
- `docs/NPC_PLANNING_ROADMAP.md`: canonical planning semantics and implementation roadmap; Goal / LOD Shelf / immutable Active Plan / Jev review authority.
- `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`: canonical production-building E2E ladder, fixture/evidence requirements, powered-item frontier, fluid validation track, and later sustained-throughput maturity path.
- `docs/NPC_AGENT_HARNESS_STATUS.md`: current verified status and known limits.
- `docs/validation/`: historical checkpoints, transcripts, superseded staging plans, and release-candidate evidence.
- `deploy/pterodactyl/README.md`: current Pterodactyl operational contract.

Do not update a historical validation record in place to describe a newer commit. Create a new checkpoint or update the current status document instead.

## Model/Hugging Face subproject notes

The older Hugging Face/model guidance applies only when working specifically under the model/training subproject (for example `models/factorio-yolo-v0`) or publishing its artifacts:

- publish model and dataset to separate Hub repos;
- include a README/model card;
- pin consumers to a tag/commit rather than a moving ref;
- treat label-definition changes as incompatible and keep `classes.json` consistent;
- keep one user-facing `notebook.ipynb` in a model repo and keep training/EDA/debug notebooks elsewhere;
- clear notebook outputs before publishing.

Do not apply those model-publishing notes to the core NPC runtime, deployment, or agent harness unless the task actually concerns the model subproject.
