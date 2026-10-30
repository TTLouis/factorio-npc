# Working on Factorio NPC

Instructions for coding agents contributing to SGLuna, the standalone Factorio
NPC. Read this file first, then only the references relevant to the task.
Explicit user instructions remain authoritative.

## Start here

1. Identify the requested outcome, affected subsystem and acceptance evidence.
   Use [SPEC.md](SPEC.md) for the project contract and
   [docs/README.md](docs/README.md) to find its owning document.
2. Inspect Git status, branch, upstream and worktrees before editing. Preserve
   existing changes; never reset, stash or overwrite another session's work.
3. In the owner's shared workspace, read its parent `AGENTS.md` and `WORKTREES.md`.
   Register ownership before creating a checkout; use its naming, source and
   integration rules. Those local files are not prerequisites for an independent
   contributor's clone. See [CONTRIBUTING.md](CONTRIBUTING.md).
4. Start development from the current Jev candidate. The sole development target
   is `experiment/jev-agent-architecture`; `main` is the stable baseline.
   `feat/npc-transition-work` is historical. Do not switch another session's branch.
5. Keep one bounded task per branch. For substantial work, record owner, source
   SHA, dependencies, acceptance criteria and a resumable checkpoint using the
   [development workflow](docs/DEVELOPMENT_WORKFLOW.md).

## Runtime invariants

- SGLuna owns a standalone Factorio `character`, never a human `LuaPlayer`.
  Zero connected humans must remain a valid operating state.
- Preserve native inventory, crafting, mining, research, combat, reach/collision,
  death and save/restart behavior. Do not substitute teleporting, instant items
  or fake completion for production mechanics.
- Models receive structured observations and choose bounded operations. Never
  introduce model-generated Lua, shell/console commands or unrestricted remote
  calls. Deterministic code derives game facts, constraints and valid candidates.
- The harness owns authoritative state, admission, receipts, recovery and
  completion. Admission, placement and a clean wrapper exit do not establish
  gameplay success; verify the requested native world state.
- Correlate asynchronous work with the exact actor, operation and epoch. Stale,
  uncertain or native-busy work must fail safely, including after restart/death.
- Preserve the User Goal, non-executable LOD Roadmap Shelf and immutable committed
  Active Plan. The Main LLM drafts plans; optional Jev selects/ranks/routes without granting
  permission, approving correctness, mutating committed plans or advancing steps.
- Structural blockers freeze the committed plan. A replacement needs verified
  standing task authority or user approval outside that grant. Preserve the
  requested result and verified history. Ask before substantially redesigning
  player structures, using reserved supplies or changing the result. Bounded
  recovery preserving the committed semantic step does not require interruption.
- Interrupted accepted tasks belong to a durable ledger, separate from future
  shelf work. Questions block affected work only. Campaign allowances cannot
  reset on restage, plan slices or restart; preserve existing guards until a new
  accounting contract is implemented and validated.
- Strategic `vertical | horizontal | maintain | recover` steering occurs at safe
  planning boundaries relative to the critical path. It cannot replace a healthy
  committed plan or impose an arbitrary alternating cadence.

The [planning roadmap](docs/NPC_PLANNING_ROADMAP.md) and
[macro design](docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md) define these contracts;
design requirements are not claims that every path is implemented.
For tool/operation changes, update the owning adapter,
[contract manifest](contracts/factorio-tool-contract.json) and parity tests
together. Preserve intentional provider differences; see
[architecture ownership](docs/ARCHITECTURE_OWNERSHIP.md).

## Validation and evidence

- Use [docs/TESTING.md](docs/TESTING.md) for commands and environment requirements.
  On this shared Windows workspace, dependency directories are WSL symlinks:
  never run host `pnpm`, `vitest`, `eslint`, `tstl` or dependency/hook installation.
  Use the existing Docker runner and its reviewed mounts.
- Run the offline gate `bash scripts/test-local.sh all` for implementation work
  and before integration. Documentation changes also need link, command and
  diff review. Keep full logs and real exit codes; do not hide failures with pipes.
- Unit/type checks protect contracts. Engine claims require deterministic real
  Factorio coverage under `tests/factorio/`, with the exact version and layout.
  Never weaken an assertion to obtain a pass or give models unmeasured transport,
  recipe, stacking or throughput assumptions.
- E2E-derived fixes must meet [E2E_REPAIR_REQUIREMENTS.md](docs/E2E_REPAIR_REQUIREMENTS.md):
  shared harness prevention, authoritative detection and bounded harness-owned
  correction; original failure, residual miss, safe continuation, safety fences,
  restart limits and exhaustion evidence. Prompt promises do not own correctness.
- Add a named, request-correlated reason trace and regression for behavior changes.
  Check the [production validation ladder](docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md)
  before claiming a capability; retain the burner-drill/furnace canary.
- Read [current status](docs/NPC_AGENT_HARNESS_STATUS.md) for verified limits.
  Preserve dated reports, traces and saves. Add a new checkpoint instead of
  rewriting historical evidence to describe a newer commit.

## Configuration, secrets and live activity

- For authorized external-harness deployment on a user's machine, follow the
  [local deployment guide](docs/EXTERNAL_HARNESS.md): build the exact guarded
  source; choose native Windows or Windows-host-to-Docker with loopback-only
  RCON; keep the Windows ledger on local fixed NTFS with the PowerShell helper
  permitted. Keep runtime credentials and state private, and verify native
  execution receipts rather than treating admission as completion.
- Deployment environment/Egg variables override non-secret config mirrors.
  `sgluna-config.json` is canonical; `airi-config.json` is a compatibility input.
- Never read, print or copy `.env`, credentials or private provider endpoints
  into commands, logs, commits or reports. CI and offline fixtures use no real
  provider credentials. Public `.env.example` files document setting names.
- Live model/Jev calls, autonomous trials, provider retries, pushes and deployment
  need the owner's authorization for that action. One E2E instruction authorizes
  one trial. Usage thresholds and old standing allowances do not authorize runs.
- Before any authorized trial, follow [docs/LIVE_E2E.md](docs/LIVE_E2E.md) and the
  current workspace rules. Freeze exact source/profile/deployment identity. Use
  configured CLI-proxy planner/executor roles and dedicated Jev settings; verify
  effective models from non-secret evidence. Never change the owner's models.
- Normal speed is the baseline. Acceleration requires the separately frozen,
  validated profile in [E2E_TICK_SPRINT.md](docs/E2E_TICK_SPRINT.md); never retrofit
  an active run. Do not manually correct gameplay or resume the NPC.
- Own and clean up exact run-scoped Docker resources on every exit path, preserving
  evidence first. Never prune globally, delete persistent data, affect another
  session's resources or restart Docker Desktop. Report unverified cleanup.

## Review and integration

Use the [development workflow](docs/DEVELOPMENT_WORKFLOW.md) and PR template.
Commit one logical change with a conventional message and no tool/co-author
trailers. A separate reviewer checks the actual diff and acceptance evidence;
resolve actionable findings before integration. Delegate only authorized,
independent work with clear ownership and completion criteria.

The integrator must own the integration checkout, verify the reported tests,
merge with `--no-ff` and run the merged offline gate. Do not push automatically:
publication and promotion retain their explicit authorization and release gates.
Never force-push or rewrite shared history without an explicit request.

If the installer or shipped files change, follow the payload repin procedure in
[TESTING.md](docs/TESTING.md) and commit the repin separately. Package smoke and
release gates are additional promotion checks. Preserve main-only deployment
changes, user saves/configuration and upstream MIT attribution. Keep swarm or
optional vision work separate from single-NPC promotion unless explicitly scoped.
Preserve existing newline styles when editing files.
