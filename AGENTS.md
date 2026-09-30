# AGENTS.md

These repository notes are for coding agents working on this fork. They describe current project invariants and validation expectations; user instructions for a specific task remain authoritative.

## Project direction

SGLuna is an autonomous in-world Factorio NPC. The core runtime must not depend on owning or impersonating a connected human player.

The intended actor is a real standalone Factorio `character` controlled through bounded mod/runtime APIs. Human players are requesters and observers, not SGLuna's body.

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

Deployment environment/Egg variables are the source of truth. Runtime-visible non-secret values may be mirrored into `sgluna-config.json` (the legacy `airi-config.json` is still read as a fallback), but that file must not override environment values.

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

## Local test gates (Windows host)

- Never run `pnpm`, `vitest`, `eslint`, `tstl` or `pnpm install` on the Windows host. The checkout's `node_modules` are WSL symlinks that Windows Node cannot follow, and a host install can delete links that other worktrees are using. All tests run in Docker.
- The ordinary gate is `bash scripts/test-local.sh all`, run from Git Bash inside the `npc-dev` image. It never installs packages or touches the network. `runtime` runs `node --test` over `deploy/pterodactyl/staging` and `runtime-v8`, with the mounts those suites need. `mod` runs autorio vitest, `tsc --noEmit`, the Lua build and the generated-Lua check. Do not invent ad hoc mounts; missing `contracts/` or repo-root compose files cause false failures.
- The full build gate is `docker build -f tests/factorio/Dockerfile --target build .`. Real-engine lanes run with `docker build -f tests/factorio/Dockerfile -t factorio-npc-test . && docker run --rm -e NPC_TEST_LANES=<lane> factorio-npc-test`, or `scripts/e2e-cloud.sh` in a cloud sandbox. Run the real-engine lanes at milestones, not before every push.
- Redirect long test output to a log file and report the real exit code. Piping into `tail` or `head` hides failures.
- Batch edits and verify once at the end instead of rerunning the suite after every small change.
- Installer payload pin. Whenever `deploy/pterodactyl/installer.sh` or the files it ships change, repin the payload:
  1. Set `PAYLOAD_REF` in `deploy/pterodactyl/build-payload.mjs` and `build-payload.test.mjs` to the new commit.
  2. Run `node deploy/pterodactyl/build-payload.mjs`. It prints the sha256.
  3. Set `PAYLOAD_SHA256` in the test to that sha256.
  4. Run `node deploy/pterodactyl/build-payload.mjs --check`, then `node --test deploy/pterodactyl/build-payload.test.mjs`.
  5. Commit the repin as its own commit.
- Line endings: `core.autocrlf=true`. When scripting file edits, keep each file's existing newline style.

## Live E2E procedure (local Docker stack)

Live runs call real providers and cost money. Do not start one (RCON rounds, the e2e overlay, subagent e2e sessions, or anything that calls a real model or Jev) until the owner says so for that run. Before an owner-approved live run, stop after the static gates and report that the build is ready. Static scenarios with scripted or recorded model replies are the default harness gate. Turn every live finding into one of those fixtures, using realistic output sizes and live Jev shapes.

- **Secrets.** Secrets live only in the gitignored `.env`. Agents never read, print or echo it, and never copy its values into commands, logs, commits or docs. The stack fails fast without `FACTORIO_RCON_PASSWORD`, `OPENAI_API_KEY`, `OPENAI_API_BASEURL`, `OPENAI_MODEL` and `JEV_TYPESAFE_API_KEY`.
- **Build what you test.**
  - Build the local server image only with `scripts/build-docker-local.ps1` (full: pins `SGLUNA_SOURCE_REF` to the committed, pushed HEAD) or `scripts/update-docker-mod-local.ps1` (mod-only changes). Both need a clean tree. Do not pass `--no-cache` or `--pull`.
  - The e2e overlay's `SGLUNA_LOCAL_RUNTIME_OVERRIDE` copies only `supervisor.mjs`, so a container can be a mixed deploy.
  - Verify what is deployed by diffing the container's release files against `git show HEAD:<path>`, with CR stripped from both. Do not trust the release directory name or `/opt/airi/SOURCE_SHA`.
- **Preflight.**
  - `docker ps` for the container name; do not assume it.
  - Confirm the `/data` bind-mount source still exists on the host. A deleted mount leaves RCON answering while every file write fails with ENOENT.
  - RCON is port 27015 inside the container and is published on host loopback only (127.0.0.1:27016). Never publish it on the LAN.
  - A hang on connect usually means a wrong RCON password.
  - Use one `Rcon` instance (from `runtime-v8/common.mjs`) per run and always `close()` it.
  - Do not touch Docker Desktop itself. If the engine is down, report it and let the owner restart it.
- **Cold start.** Every test starts cold:
  1. Run `docker compose -f compose.yml -f compose.e2e.yml down`.
  2. Remove `data/.airi/npc-state.json`.
  3. Move every `data/saves/*.zip`, including autosaves, to a backup outside the repo. The entrypoint regenerates the world only when the save is absent.
  4. Bring the stack back up with `up -d --force-recreate`.
  5. Confirm: a freshly generated world, a new actor_id, an empty inventory, and `NULL_BOARD` from the task-board status call.
  - The first objective must get a new `goal_id`, or the run does not count. There is no working in-game reset (`autorio_task_board.clear` is re-pushed by the supervisor).
  - `data/sgluna-config.json` persists across cold starts. Check it when a provider limit looks wrong.
- **Drive and observe.**
  - Send objectives as raw chat (`!luna <objective>`), not `/silent-command`.
  - Read the board through a nil-safe `remote.call("autorio_task_board","status")`.
  - Flush `storage.airi_task_board_ui_inputs` before a round.
  - Use a different objective each round, and test one input channel at a time.
  - Poll windows of at least ~90 s; shorter ones miss transitions.
  - In Git Bash, prefix `docker exec` and node argv containing `/...` paths or `/silent-command` with `MSYS_NO_PATHCONV=1`.
  - With zero connected players the NPC force charts nothing, so map ops return `area_uncharted`.
- **Evidence.**
  - The structured logs are the evidence, not the board: `<SGLUNA_DATA_DIR>/logs/sgluna-behavior.jsonl`, `sgluna-decision.jsonl` and `sgluna-prompts.jsonl`, read from the host. `docker logs --since <ISO>` is a fallback.
  - Filter each run to its start timestamp and check it with `node deploy/pterodactyl/runtime-v8/run-check.mjs <behavior.jsonl> [since] [--json]`.
  - Record results in `docs/NPC_AGENT_HARNESS_STATUS.md` or a new `docs/validation/` checkpoint, never by editing an old checkpoint.
- **Never deploy.** Never deploy to the live Pterodactyl server, and never retry providers on your own. A local container being up is not permission to run against it.

## Agent build workflow (worktrees and merges)

- **Integration worktree.** Work lands on the active integration branch (currently `experiment/jev-agent-architecture`) from one integration worktree.
  - Create each unit's worktree yourself with `git worktree add -b <branch> ../<name> HEAD`. Brief subagents with the absolute worktree path and a `cd` into it on every command. Do not rely on auto-created isolation worktrees: a resumed agent whose worktree was removed runs in the integration worktree.
  - Reviewers read diffs with `git -C <path>` or `git diff` and never `git checkout` inside another worktree.
  - Never use a bare `git stash` (the stack is shared across worktrees). Use a temporary WIP commit instead.
- **Merge protocol, per unit:**
  1. The agent commits on its unit branch and does not push.
  2. A separate reviewer checks the diff for merge-blocking issues. Invariant-heavy diffs (planning ownership, actor/epoch correlation, admission, budget) get the strongest reviewer. Uncorroborated findings are marked as such.
  3. The integrator confirms the tests the agent reported actually exist in the diff.
  4. `git merge --no-ff <branch>` into the integration worktree.
  5. Repin the installer payload if the installer or the files it ships changed.
  6. `bash scripts/test-local.sh all` must pass.
  7. `git push origin HEAD:<integration branch>`.
- **Commits.** Small conventional commits per logical unit, pushed once green. No co-author or tool-attribution trailers. No force-push or history rewrite.
- **Traceability.** Every behavior change adds a named trace event carrying `request_id` and a reason, asserted by a test, so a later live run can be diagnosed from the logs.
- **Progress tracking.** Track long builds in a checklist (unit, commit, status), not in chat scrollback. Update the design note's build-status section and the status doc as units merge.
- **Scope.** When a genuine product decision comes up, flag it to the owner and keep working on everything that does not depend on the answer.

## Claude Opus 5.5 guidance

- [Getting the most out of Opus 5.5](https://claude.dev/blog/getting-the-most-out-of-opus-5-5/): prompting and long-run guidance for Claude Opus 5.5. Key points for this repo:
  - State explicit completion criteria (for example "the tests pass") and let the run proceed autonomously.
  - Do not add "think carefully"-style instructions; the model already decides how much to think.
  - Keep clear stop/go rules, and confirm before anything destructive (deleting data, force-pushing).
  - Track long-run progress in a checklist file rather than in scrollback; split audits/migrations across subagents and verify their findings before consolidating.
  - Have diffs reviewed for merge-blocking issues before human review, and mark uncorroborated findings as such.

## Model/Hugging Face subproject notes

The older Hugging Face/model guidance applies only when working specifically under the model/training subproject (for example `models/factorio-yolo-v0`) or publishing its artifacts:

- publish model and dataset to separate Hub repos;
- include a README/model card;
- pin consumers to a tag/commit rather than a moving ref;
- treat label-definition changes as incompatible and keep `classes.json` consistent;
- keep one user-facing `notebook.ipynb` in a model repo and keep training/EDA/debug notebooks elsewhere;
- clear notebook outputs before publishing.

Do not apply those model-publishing notes to the core NPC runtime, deployment, or agent harness unless the task actually concerns the model subproject.
