# Testing

Choose checks that prove the changed behavior. All commands below run from the
repository root. None of the offline checks needs real provider credentials.

## Shared Windows workspace

Use Git Bash and the existing `npc-dev` Docker image:

```sh
bash scripts/test-local.sh all
```

The script launches Docker containers; it does not run tests inside your host
Node environment. It uses reviewed mounts, `--pull never` and `--network none`,
prints run-owned container names, records IDs and cleans up on exit. It does not
install dependencies. `all` runs `tooling`, `agent`, `runtime`, then `mod`, stopping on the
first failure. `tooling` exercises runner routing, failure propagation,
interruption, evidence retention and cleanup using fake Docker calls. `agent` selects the ordinary-agent Vitest suite used by CI, reading
current source, package scripts, configuration and the shared contract through
read-only mounts. `runtime` selects staging/runtime-v8 tests; `mod` selects Autorio
tests, typecheck, Lua build and generated-Lua verification, using this checkout's
package scripts, TypeScript configuration and Vitest setup.

Do not run host `pnpm`, `vitest`, `eslint`, `tstl`, package installation or hook
installation in this workspace: its `node_modules` directories are WSL symlinks.
Do not invent partial mounts or alter another checkout's dependencies. If Docker
or the prepared `npc-dev` image is unavailable, report that prerequisite; do not
silently install packages, pull images or restart Docker Desktop to repair it.

## Independent Linux/container environment

CI uses Node 24. Use the package manager pinned in `package.json` and
`pnpm-lock.yaml`; install dependencies only in your own supported environment:

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run test --run
pnpm run build
pnpm run typecheck
node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

These are useful ordinary checks, not a replacement for the full CI workflow.
The [CI configuration](../.github/workflows/ci.yml) owns the complete job list.
The Factorio test Dockerfile separately pins its build environment and engine;
record actual versions rather than assuming all images match host Node.

## GitHub Actions

CI and package gates target `main` and `experiment/jev-agent-architecture`.
The historical `feat/npc-transition-work` branch no longer triggers these gates.
Existing job/check names stay unchanged. The local composite action
[setup-workspace](../.github/actions/setup-workspace/action.yml) installs the
pinned pnpm dependencies on Node 24 for lint, unit and build jobs. Native jobs
install/build inside their Dockerfile and need no second host dependency install.

The Jev native job uses one built image for the complete existing CI selection:

```sh
bash scripts/test-factorio-suite.sh
```

This runs core/research-combat/resilience/production, fresh topology, direct-feed
observation, partial transfer, ground-item pickup, placement clearing and water
reach approach. Each invocation uses [the evidence wrapper](../scripts/test-factorio-ci.sh).
A failed lane leaves the suite failed while later lanes still run; interruption
stops the suite. Each lane retains its logs, saves, native/wrapper exit codes and
container ownership/cleanup receipts under `test-results/factorio-ci/`. Both CI
and the package gate upload native evidence even after failure (14-day retention).
The package gate runs the base native lanes on `main` and manual dispatch;
Jev pushes receive their full native coverage from CI.

Run the shell regression checks alone with `bash scripts/test-local.sh tooling`.
They do not start Factorio or call providers. Local full test logs remain ignored
and must not be committed. A hosted workflow pass still requires publication and
an actual Actions run; local configuration checks cannot establish that result.

## Match evidence to the claim

| Change | Useful proof |
| --- | --- |
| Documentation | Relative links, referenced paths/settings/commands, whitespace and diff review |
| Runtime, observation, recovery or prompt flow | Recorded/scripted full-loop regressions with realistic replies and request-correlated traces |
| Actor, epoch, restart, plan or allowance ownership | Stale/refused/uncertain cases and durable limits across the actual lifecycle |
| Placement, transfer, crafting, fluids or transport | Deterministic exact-version Factorio lane and semantic native output |
| Installer or shipped runtime | Payload check/tests, separate repin and package gates at promotion |

Run `git diff --check`. Implementation and integration also require the ordinary
offline gate above; run the relevant additional checks when the affected contract
requires them. Preserve full logs and the command's real exit status. Do not pipe
test output through `head` or `tail` and mistake that process's success for a pass.

## Deterministic Factorio checks

The full build gate is:

```sh
docker build -f tests/factorio/Dockerfile --target build .
```

For real-engine coverage, build the
[test image](../tests/factorio/Dockerfile), then select an existing lane from
[the lane runner](../tests/factorio/runner/run_lane.sh). For example, the core lane:

```sh
docker build -f tests/factorio/Dockerfile -t factorio-npc-test .
docker run --rm -e NPC_TEST_LANES=core factorio-npc-test
```

Builds may download dependencies and Factorio. In a supported cloud sandbox,
`bash scripts/e2e-cloud.sh` supplies the repository's deterministic engine wrapper;
it is distinct from `scripts/stack-cloud.sh`, which can start a provider-backed
server and needs separate authorization. Run engine lanes at relevant milestones.
Use unique run-owned names and the workspace cleanup rules when driving them.

Static/unit success does not prove engine behavior, and engine fixtures do not
prove autonomous gameplay. Keep negative controls for repaired assumptions.
E2E-derived fixes additionally follow
[the repair requirements](E2E_REPAIR_REQUIREMENTS.md).

## Installer payload changes

When the installer payload or files it ships change, follow the existing pin
contract. The generator names its immutable source in
[`PAYLOAD_REF`](../deploy/pterodactyl/build-payload.mjs).

1. Commit the reviewed payload source, then set `PAYLOAD_REF` in the generator
   and its test to that full commit SHA.
2. In a supported environment, run `node deploy/pterodactyl/build-payload.mjs`
   and set the test's `PAYLOAD_SHA256` to the printed checksum.
3. Run `node deploy/pterodactyl/build-payload.mjs --check` and
   `node --test deploy/pterodactyl/build-payload.test.mjs`.
4. Commit the repin separately and run the appropriate package/promotion gates.

Documentation-only edits do not require a payload repin. Check actual shipped
files before deciding a change is documentation-only.
