# JEV verified checkpoint — 2026-09-19

Evidence for JEV-era work had been distributed across older status docs, RCON tests that mock the `command()` call in-process, and a separate uncommitted Docker worktree. This is the first single checkpoint that freezes one exact SHA and records ordinary CI, package smoke, and the real zero-player Factorio integration all together for that SHA.

## Frozen candidate

- Branch: `experiment/jev-agent-architecture`
- SHA: `30493ff51ae5fae72743e6f7e1fc128b26156868` ("Add desktop RCON operator adapter")
- This SHA predates the desktop-operator/checkpoint fixes below; it is the baseline this checkpoint verifies, not the tip of the branch.

## Ordinary CI (GitHub Actions)

Run [`35471022963`](https://github.com/TTLouis/factorio-npc/actions/runs/35471022963) — **all green** for this exact SHA:

- `typescript-quality`: success
- `pterodactyl-runtime`: success
- `factorio-npc-deterministic`: success — this job **is** the real zero-player Factorio integration test (`pnpm test:npc`: `tests/factorio/Dockerfile` + `run.sh`, real headless Factorio, real RCON, Python runner asserting the core/research-combat/resilience lanes, not a mock)

## Package smoke, pinned to this exact SHA

`deploy/pterodactyl/package-smoke.sh`/`.ps1` was not previously wired to run in CI for this branch (only `main` push and `workflow_dispatch`); there is no automatic CI record of it for this SHA. Verified manually instead:

```powershell
deploy/pterodactyl/package-smoke.ps1 -SourceRef 30493ff51ae5fae72743e6f7e1fc128b26156868
```

**PASS.** The generated PTDL_v2 egg installed source pinned to exactly this SHA (not `main`, not the working tree — `package-smoke.ps1` previously had no way to pin an exact source ref at all; a `-SourceRef` parameter mirroring the `.sh` script's `SGLUNA_SMOKE_SOURCE_REF` was added as part of this checkpoint), started a real zero-player standalone NPC (`SGLuna Factorio ready; npc=Mira-1 (npc-1), actor_id=5`), and shut down cleanly after `/quit` (`Goodbye`, `SGLuna Factorio stopped cleanly`, non-empty save produced).

`package-smoke.sh` itself could not be run directly on this Windows host: Git Bash's MSYS path auto-conversion mangles the `-v host:container` bind-mount arguments the script passes to `docker run` (a pre-existing, documented limitation — see `docs/validation/PTERODACTYL_V8_RELEASE_CANDIDATE_2026-09-14.md`, "Windows development note"). `package-smoke.ps1` avoids this by using `docker.exe` argument arrays directly.

## Fixes bundled with this checkpoint (P0 desktop-operator work)

Verifying the desktop operator adapter surfaced two real defects unrelated to package smoke's own coverage (package smoke uses the Pterodactyl egg path, not `compose.yml`/`deploy/docker/Dockerfile`, so neither defect below affected the CI result above):

1. **`deploy/docker/Dockerfile` was corrupted at this exact committed SHA.** A shell `if`/`then` clause in the source-resolution `RUN` block was split apart: the `then` branch and a full duplicate tail were spliced in *after* `ENTRYPOINT`, ending in a second stray `ENTRYPOINT`. `docker build`/`docker compose build` would fail outright (`unknown instruction`). Fixed by reassembling the one coherent `RUN` block and removing the duplicate tail.
2. **Factorio's RCON was unreachable from any sibling container.** `deploy/pterodactyl/runtime-v8/supervisor.mjs` hardcoded `--rcon-bind 127.0.0.1:<port>` with a random port and a random per-run password — by design for production, but it meant the desktop-operator adapter's `compose.desktop-operator.yml` (which expects to reach `sgluna-factorio:27015` over the internal Compose network) pointed at nothing reachable. Added `localRconOverride()`: an **opt-in-only** override (`SGLUNA_RCON_PASSWORD`/`SGLUNA_RCON_PORT`/`SGLUNA_RCON_BIND`) that activates only when `SGLUNA_RCON_PASSWORD` is explicitly set; production behavior (random password/port, loopback-only bind) is unchanged when it is unset. Covered by a real end-to-end test in `runtime-v8.test.mjs` that spawns the fixture Factorio binary and confirms the fixed port/password/bind actually reach its argv and a real RCON handshake succeeds.

Also delivered as part of making the desktop operator shippable:

- `compose.e2e.yml` committed with the required service contract (RCON reachable by `sgluna-factorio`'s service name over the internal network only; never published to the host).
- `scripts/check-compose.sh` + a CI step statically validates that merged contract (service dependency, matching RCON password/port on both sides, the bind override, no host-published RCON port, operator bound to `127.0.0.1` only) without building or starting anything.
- `tools/desktop-rcon-operator.e2e.test.mjs`: a new adapter test over a **real TCP RCON connection** (the same `Rcon` client class production uses, talking to a fake Source-RCON TCP server) covering unauthorized request, bounded observation, rejected preflight, and admitted operation in one flow. The existing in-process-mock unit tests in `desktop-rcon-operator.test.mjs` remain for fast iteration.
- `.github/workflows/pterodactyl-release.yml`: package smoke and (main-only, to avoid duplicating `factorio-npc-deterministic`) the real Factorio integration now also trigger on `feat/npc-transition-work` and `experiment/jev-agent-architecture` pushes, closing the coverage gap that let both defects above go unnoticed by CI.

## What this checkpoint does not cover

- Production provider validation (a real provider-to-NPC goal against a packaged server with a real API key) remains deferred, matching every prior checkpoint in this directory.
- The pre-existing, unrelated eslint backlog in `deploy/pterodactyl/runtime-v8/supervisor.mjs` (hundreds of pre-existing style violations, `pnpm eslint` confirmed) is untouched; it predates this checkpoint and fixing it was out of scope for these two P0s.
- This checkpoint's own fix commit (Dockerfile repair, RCON override, compose/CI additions) is itself **not yet the frozen/CI-verified SHA** described above — it is the change that produces the next candidate. Freeze and verify the new SHA the same way (ordinary CI green, then package smoke pinned to that exact SHA) before treating it as promotable.
