# Working on Factorio NPC

This is the older `main` snapshot. Current development and its maintained agent
instructions are on
[`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/AGENTS.md).
Jev is optional on that branch. Do not infer a Jev dependency from its name.
Explicit user instructions remain authoritative.

## Start with the right branch

- New implementation targets the current Jev candidate, not this older snapshot.
  Updating `main` documentation does not authorize promoting a runtime to `main`.
- Inspect status, branch, upstream and worktrees before editing. Preserve existing
  changes; never reset, stash or overwrite another session's work.
- In the owner's shared workspace, read the parent `AGENTS.md` and `WORKTREES.md`
  before branch/worktree operations. Register one owner and bounded task first.
  Independent clones do not require those machine-local files.
- Use [CONTRIBUTING.md](CONTRIBUTING.md), [SPEC.md](SPEC.md) and the
  [documentation index](docs/README.md) for this snapshot. Check out the Jev branch
  and read its own instructions before working on current runtime behavior.

## Runtime boundaries

- Own a standalone Factorio `character`, never a connected human `LuaPlayer`.
  Zero connected humans must remain a valid state.
- Preserve native inventory, crafting, mining, research, combat, reach/collision,
  death and save/restart behavior. Do not replace production mechanics with
  teleporting, instant item insertion or fake completion.
- Model actions must be structured and bounded. Do not introduce arbitrary
  model-generated Lua, shell/console commands or unrestricted remote calls.
- The harness owns authoritative state, validation, admission, receipts and
  recovery. Verify the requested world state; admission does not prove completion.
- Correlate asynchronous work with the exact actor, operation and epoch. Stale
  work after replacement, death or restart must fail safely.
- Derive recipes, topology, geometry, ratios and transport capacities
  deterministically; do not ask models to guess unverified game facts.
- Prefer map-first operations when the native game supports them. Keep later
  vehicle/train/platform and swarm work separate from the single-NPC baseline.

## Validation, configuration and evidence

- Follow [TESTING.md](docs/TESTING.md). Unit/type checks protect regressions;
  engine semantics need deterministic real-Factorio coverage. Never weaken an
  assertion to turn a failure into a pass or present placement as production.
- Windows shared-workspace dependencies may be WSL symlinks. Never run host
  package installation, tests or hook installation there; use a supported isolated
  environment. This snapshot has no `scripts/test-local.sh`.
- Deployment environment/Egg variables override non-secret `airi-config.json`.
  Keep credentials out of Git and non-secret config. Never read, print or copy
  `.env`, credentials or private endpoints into commands, logs, commits or reports.
- Offline tests/CI need no real provider credentials. Live provider/Jev calls,
  retries, autonomous trials, pushes and deployment require their existing owner
  authorization. One E2E instruction permits one trial; do not correct gameplay
  manually. Follow current workspace trial/stop/save/evidence rules.
- Preserve historical reports, traces, saves and user configuration. Add a new
  checkpoint instead of rewriting old evidence. Use package smoke/release gates
  at promotion; a green feature SHA is not a release.
- Own exact run-scoped Docker resources and clean up on every exit after preserving
  evidence. Never prune globally, delete persistent data, affect other sessions
  or restart Docker Desktop. Report cleanup that cannot be verified.

## Review and publication

Keep changes bounded and record acceptance evidence. A separate reviewer checks
actual diffs and claims; resolve actionable findings. Preserve main-only
configuration/documentation and upstream MIT attribution. Do not mix swarm work
into single-NPC promotion without explicit scope and proof. Follow the owning
branch's payload-repin procedure if shipped files change. Use small conventional
commits with no tool/co-author trailers, and preserve existing newline styles.
Never force-push or rewrite shared history without an explicit request.
