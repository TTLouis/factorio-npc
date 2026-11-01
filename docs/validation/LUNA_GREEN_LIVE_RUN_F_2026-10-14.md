# Luna green-science live run F (2026-10-14)

## Candidate

- Commit `ec6b8385` on `experiment/jev-agent-architecture`, which includes:
  - units 7 (pause classes and model-recoverable auto-resume)
  - unit 8 (executor targeted reads, trigger production, machine energy and burner fuel facts)
  - unit 9 (entity_count contracts, build bills, science residual, harvest sources, trigger readiness)
  - unit 10 (fluid-port placement, nearest-first water, chunk coverage, electric prototype facts)
- Static gate: `bash scripts/test-local.sh all` exit 0, 2259 runtime tests passing.
- Real-engine lanes passed on the same commit: `production`, `craft-trigger`, `native-admission` and `steam-lab`.
- Deployment verified inside the container:
  - All 50 shipped runtime modules match `git show ec6b8385` with CR stripped.
  - All 31 active mod files match the release.
  - Model `gpt-6-luna`, method `local`; Jev token present.

## Setup

- Isolated compose project with an empty data directory, so the world was freshly generated (seed 1498036413).
- Actor 11; zero connected humans; game speed 1.
- Starter kit as in run E: 8 iron plates, burner mining drill, stone furnace, pistol and 10 magazines.
- One objective, the same text as run E. No operator gameplay actions after the starter.

## Result: `request_failed` after 1 second; no gameplay was tested

- At 09:03:48Z the first planner call for the new goal failed after 187 ms with `fetch failed`.
- The request was marked `recoverable=false`, the runtime reset, and the goal was never admitted. There were no provider responses and no world actions.
- `run-check.mjs` reported one finding: `request_failed_unrecoverable`, for `req_mv7vuqp4_1`.

## Cause

- **Infrastructure.** The CLI-proxy hostname did not resolve:
  - inside the container: `ENOTFOUND`;
  - on the Windows host: DNS resolution failed and the Tailscale client reported `BackendState=NoState`.
- The provider was therefore unreachable. Run E reached the same proxy on 2026-10-13.
- These probes were DNS and TCP checks only. No provider request was retried.

## System findings (not dependent on the network outage)

1. **The cause code is dropped.**
   - `provider.error` and `request.failed` carry only `message: "fetch failed"`.
   - The error's cause code (`ENOTFOUND`) and the transport pause class/subkind are not recorded.
   - As a result, the logs alone cannot tell a DNS outage from a refused connection or a timeout.
2. **A transport failure at goal intake loses the goal.**
   - Before admission there is no plan.
   - Unit 7's transport and model-recoverable auto-resume only recovers a paused plan.
   - So a transient network failure on the first call drops the objective, and with zero humans the NPC stays idle.

## Status

- Not counted as a gameplay validation of units 7–10.
- A rerun needs:
  - the proxy to be reachable again;
  - an e2e allowance window, or the owner's go.
