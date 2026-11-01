# Authorized live E2E trials

This is an operating contract for agent-driven provider trials, not a quick-start
command. Live model/Jev calls consume resources. The owner's current workspace
rules and the explicitly frozen runner/profile govern each run.

## Authorization and preparation

- Get authorization for the specific trial. One instruction permits one run;
  old quota-based standing allowances do not permit additional runs or retries.
  Pushes, deployment, provider retries and gameplay corrections retain their
  separate authorization boundaries.
- Confirm the current Jev candidate and record exact local and published SHAs,
  ownership, offline checks, payload identity, and deployed runtime/native-file
  matches. If remote freshness cannot be checked, say so. Keep source fixed.
- Use the configured CLI-proxy planner/executor roles and dedicated Jev profile.
  Verify effective models from non-secret config or traces. Do not read `.env`,
  change the owner's model choices, or publish credentials/private endpoints.
- Build local runtime images through `scripts/build-docker-local.ps1` or, for
  eligible mod-only changes, `scripts/update-docker-mod-local.ps1`. Use a clean,
  committed candidate. These scripts can update local configuration/start a
  stack; use only within the authorized run scope. Do not force fresh downloads
  with `--no-cache`/`--pull`.
- Compare installed runtime/native files against the frozen source, normalizing
  CR where needed. A release directory, source marker, or supervisor-only overlay
  does not prove that every deployed file matches.

## Isolation and observation

Record the exact Compose project, files, container names/IDs, data directory and
tunnel identity before use. Check mount sources exist. Use a fresh isolated
project and data directory; never cold-reset a shared stack or delete its saves.

Start with zero humans, a new actor and goal, empty board/inventory, then only the
declared one-time vanilla starter. A server still answering RCON is not proof that
its mounted storage is writable. RCON must remain loopback-only; use one owned
connection and close it. Never restart Docker Desktop to fix an unavailable engine.

Use normal game speed during construction unless the run freezes a validated
accelerated profile under [E2E_TICK_SPRINT.md](E2E_TICK_SPRINT.md). Keep the reviewed
60-minute construction cap, terminal conditions, request/recovery/quota guards
and measurement contract. Acceleration cannot repair missing wakes, renew an
allowance or admit duplicate work. Restore/confirm 1× at required boundaries.

Use the reviewed runner's observation cadence and native interfaces. Old `.airi`
paths, manual board resets, queue-flushing recipes and arbitrary long polling
intervals from historical runs are not current operating instructions. Submit
the goal through the normal `!luna` channel. Do not send corrective gameplay
prompts or manually resume the NPC.

Use the owner's cheaper read-only overwatch model (currently `gpt-6-luna`) for the
authorized run. It observes source/evidence and host state only: no provider/Jev
calls, gameplay/source/control changes or routine parent messages. It saves
observations under the run's `overwatch/` directory, contacts the parent only for
an actionable issue/final review, and finishes with the trial. The parent owns
live commands, decisions, evidence and cleanup. Keep chat quiet between meaningful
issues and the final result.

## Success, stop and evidence

Judge gameplay against native automated output and the runner's acceptance
contract. Command admission, placement, plan-slice completion, static passes and
wrapper exit status do not prove success. Record which changed paths were exercised.

At stop, obtain fresh supervisor cancellation plus a same-goal operator-pause
receipt. Verify native idle/empty queues, save after that boundary, check full ZIP
integrity and pristine exact-version Factorio load, and check calls after strict
stop. Preserve structured behavior, decision and prompt traces (including rotated
files), actual plans, save and failure evidence outside disposable resources.
Use `deploy/pterodactyl/runtime-v8/run-check.mjs` for the applicable behavior checks;
the task board alone is not the evidence.

Each report needs a concise readable outcome and a machine-readable metrics
artifact, with boundaries, units, sources and counting rules:

- Recovery attempts/completions/failures by reason, mechanism and plan/step;
  separate automatic resumes, planner reviews, retries, restages and operator help.
- Per-tool attempted/executed/success/refusal/failure/cache/coalescing counts;
  separate observations, mutations and native batches/operations.
- Trial, preflight, measurement and stop/save/cleanup times; available model/Jev,
  tool, recovery and world-action durations, averages/ranges and overlapping intervals.
  Report thinking duration only if exposed by the provider; latency is not thinking.
- Full original goal, shelf, committed plan and every revision/slice, guidance,
  contracts, outcomes and review notes, with timestamps/IDs/models/source references.
  Label rejected drafts; do not reconstruct a cleaner plan as the original.
- Deduplicated API requests/responses/failures/cancellations/retries/fallbacks and
  available input/cache/output/reasoning tokens by provider/model/role, including
  Jev. Separate trial from orchestration/overwatch usage where available.
- Estimated currency cost by model/role with pricing source/date, cache rates and
  assumptions. Distinguish token-price equivalents from actual billed charges.
  Do not double-count reasoning already billed in output; mark unpriced calls,
  missing usage and partial estimates. Quota percentages are not monetary cost.

Use unknown/unavailable for missing telemetry. Put new analysis outside sealed
historical evidence. Repair findings through
[E2E_REPAIR_REQUIREMENTS.md](E2E_REPAIR_REQUIREMENTS.md), not live intervention.

## Cleanup on every exit

Preserve evidence, stop inference and save at the verified boundary, then remove
only owned containers (including stopped ones), exact Compose project networks
and disposable volumes, tunnels/recorders, temporary config links and unneeded
test-only images. Use `--rm` and finally/trap cleanup where appropriate. Never
delete persistent data, historical evidence, shared images or another run's resources;
never run global prune commands. Check interrupted runs for their own leftovers.

Verify absence by recorded IDs/project labels and report intentionally retained
resources with reasons. If cleanup cannot be verified, record exact leftovers and
recovery commands. No background work remains after closeout.
