# Contributing to Factorio NPC

SGLuna is an experimental Factorio NPC runtime. Help with reproducible bugs,
clear setup instructions, deterministic tests and bounded runtime improvements
is welcome. You do not need to understand the entire planner to contribute.

## Find a useful first change

- Try the documented Docker or Pterodactyl setup and report the first confusing
  step, with your platform and source SHA.
- Improve a specific explanation or broken link. Check the
  [documentation index](docs/README.md) before creating another guide.
- Turn a reproducible failure into a recorded/scripted regression. Offline
  fixtures are useful contributions without paid model calls.
- For larger architecture changes, describe the problem and proposed scope in an
  issue first so a maintainer can check dependencies and existing work.

These are contribution ideas, not a claim that matching open issues already exist.
See [current status](docs/NPC_AGENT_HARNESS_STATUS.md) for known limits and
[SPEC.md](SPEC.md) for the project contract.

## Choose the right source

Development pull requests target **`experiment/jev-agent-architecture`**.
`main` is the stable baseline and can be behind current development. Start a
small task branch from the current Jev candidate, using `<type>/<task-slug>`:
`docs/setup-guide`, `fix/inventory-refresh` or `test/crafting-restart`, for example.

In an independent clone, fetch/check out the development branch before creating
your task branch. In the owner's shared workspace, first follow the parent
`AGENTS.md` and `WORKTREES.md` ownership/worktree procedure; never reuse another
chat's checkout. Those machine-local files are not required for outside contributors.

## Set up and validate

Factorio engine checks require Docker. Ordinary CI uses Node 24 and the package
manager pinned in [package.json](package.json), with the frozen lockfile.
Read [TESTING.md](docs/TESTING.md) for supported environments, exact commands and
what each check proves. Dependency directories in the shared Windows checkout
are WSL symlinks; installing packages on the Windows host can damage them.

You do not need production credentials for offline fixtures or CI. Do not start
a provider-backed server just to test a documentation or deterministic code change.
Live trials have separate [authorization and evidence rules](docs/LIVE_E2E.md).

Read [AGENTS.md](AGENTS.md) when using a coding agent, and preserve its runtime,
planning, secret and evidence boundaries in any implementation.

## Report a bug

Include the exact commit, platform, Factorio version, minimal steps, expected
result and actual result. Attach a small sanitized log excerpt or fixture with
timestamps and request/operation IDs when relevant. Say whether the failure was
offline, deterministic native-engine or provider-backed.

Never attach `.env`, API keys, private endpoints, a whole data directory or an
unreviewed save/trace bundle. Remove personal/provider details from evidence.

## Submit a pull request

Keep the change focused and use the repository's PR template. Explain the
observable problem/result, tested SHA, commands and outcomes, and remaining
limits. Record unavailable checks honestly. For an E2E-derived fix, include the
required [prevention and self-correction proof](docs/E2E_REPAIR_REQUIREMENTS.md).

Update the existing owning docs when behavior changes. Preserve historical
validation records and license attribution. Maintainer review, integration checks
and explicit release decisions govern publication; a local pass is not a release.
