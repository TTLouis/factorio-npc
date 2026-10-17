# Run Y — minimum-prompt delegated red-science trial

Run Y used frozen published source `957ebedf5e79ff7ac9652fc74cee19121a19f84e`.
It stopped after **57.18 wall minutes** at authoritative automatic-recovery
exhaustion, before the unchanged 60-minute construction cap. **No red science
was produced.** The unattended throughput measurement never began.

## Objective and authority

The sole gameplay prompt was:

> !luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.

The owner approved continuing while leaving approximately 5% weekly usage.
The supervisor used a conservative 7% remaining live-stop threshold to leave
shutdown/report margin. The final prelaunch reading was 17%; the terminal
reading was 11%. Usage monitoring selected the 10,080-minute window by duration.
No usage reset credit, manual gameplay correction, corrective objective or manual
resume was used. Existing provider and recovery limits were unchanged.

The starter was granted once in the fresh live world. Actor 1, seed 305095892,
goal `goal_0o02hq4_1`, started at `2026-10-17T18:21:56Z`. Construction stayed at
speed 1 with zero connected humans. The supervisor owned observation, usage,
terminal classification and archival; the parent owned release verification,
consequential decisions and the loopback transport.

Measurement remained outside the gameplay prompt: paused AI mutations and native
idle, parent-reviewed full natural-resource ore/fuel/item paths and real steam
power, enemies removed, five wall minutes at 2x, at least ten game minutes and
ten NEW red packs at >=1 per game minute. No measurement setup was performed.

## Release and preflight

The official `scripts/build-docker-local.ps1 -NoEnvUpdate` build passed with
process-only Factorio 2.0.77. The actual image is
`sha256:ebffde5f539c4d48db75ec7d972989a6c1f82f02e7741fdc2b32d3f64afc1fcf`.
Parent and independent review verified all 51 shipped runtime/staging modules,
packaged prompt, release manifest and 31 compiled mod files. Native expected
bytes came from the sealed final Run X fixture `273520b2`; the candidate differs
from that fixture source only in documentation. Text comparisons normalize CR;
binaries compare exact bytes, and active mod files match the release exactly.

Preparation passed 42 JavaScript checks, ten syntax checks, ten archive-test
groups and six PowerShell parse checks. The 33-helper manifest SHA256 is
`2c3c455527e17bea32d2687c62b62b1c3f001e502f502b0a9fd30216ac0a7551`.
Strict paired-stop/measurement/save checks and exact native file-set rejection
were reviewed before inference. Production files and `.env` were unchanged.

The first unused preflight world was archived after the local Tailscale client
reported `NoState`. The owner reconnected it; a fresh second world passed all
cold checks with no starter, goal, inventory, machines, native work or inference.
Read-only model catalog checks returned unauthenticated 401/authenticated 200
with both role models present. Actual runtime serializers resolved CLI-proxy
Sol 6.1 planner and Luna executor, retaining 40 tools and `tool_choice:none`
in closed mode. Final preflight packet SHA256:
`09329536765c67c96aa56de110639254d983ccd338493a282dac14ff723f5450`.

## Progress and confirmed terminal boundary

Rotated logs record **181 provider requests, 177 replies and four provider
transport errors**. Actual replies were ten `gpt-6.1-sol` and 167 `gpt-6-luna`.
Jev completed all 125 request/response pairs. The run produced 76 new iron plates and 25 copper plates. Two stone furnaces
were placed: one finished 101 products and the other remained idle. The actor
held a lab, offshore pump, boiler, steam engine, six poles and the starter drill
at termination. No steam-power network or automated science chain was placed.

The canonical active plan was `goal_0o02hq4_1_p5`, version 1, step
`goal_0o02hq4_1_p5_v1_s2_0283fqw`: build/fuel a connected water-to-steam system
and verify the steam engine works. The last native placement attempt refused
an offshore pump at `(14.5, -88.5)` with `not_placeable`; the diagnostic footprint
listed copper-ore resource tiles. That refusal is evidence of this attempted
placement, not proof that the world lacks a usable shoreline.

Subsequent `recovery.unverified_blocker` events rejected unsupported world-blocker
claims and required grounded action recovery. The following provider action
omission repair failed with `unverified_blocker_recovery_exhausted; no
authoritative world blocker was established`. At `19:17:36.516Z`, the persisted
same-goal automatic recovery reached **6/6 goal attempts**, with **2/2 step
attempts**. The refreshed external classifier confirmed
`current_automatic_recovery_exhausted`; the terminal result was
`auto_resume_exhausted`. It was not a throughput success, time-cap stop or
usage-floor stop. No manual reset or additional trial followed.

The next regression scope is the exact refused pump placement and the following
observation/blocker/action-omission sequence. Preserve placement geometry,
current delivered facts, observation limits, immutable step and exhausted
campaign allowance; do not infer a global shoreline failure from one refusal.

## Transport interruption

The parent-owned SSH forwarder exited during the run. Four provider fetch
failures entered existing bounded transport recovery. Read-only inspection
proved the owned process/listener absent while Tailscale and the known peer
were online. The parent restored the same strict-host-key, loopback-only tunnel
once at `19:06:11Z`, preserving the original receipt and diagnostics. This was
an infrastructure repair: no gameplay command, provider request, manual resume,
configuration change, budget reset or construction-clock extension accompanied
it. The runtime subsequently resumed through its existing automatic recovery.
The interruption is retained as a limitation of this live trial.

## Stop and checkpoint

The strict stop pair passed on the same goal: `request.cancelled` at
`19:19:06.195Z`, then operator `goal.paused` at `19:19:06.210Z`, following the
stop submitted at `.192Z` and before confirmation at `.579Z`. The parent verified
receipt scope, actor/goal identity, cleared intake and empty native task/craft
queues. This is a successful live paired-trace check of the Run X stop fix.

A PowerShell verifier initially produced a false-negative because default
`ConvertFrom-Json` converted ISO strings to DateTime, then string coercion lost
fractional seconds/timezone. The frozen original and failure are preserved.
A separate verifier adds `-DateKind String`; an exact UTC-order regression and
parent diff review pass without weakening any stop/save assertion.

The fresh named checkpoint is **903,638 bytes**, SHA256
`249f35b23730135d6829aa242e8a7be3d6b8239f9179bbe8049aef843307a1ba`.
Named native save-start/completion, freshness after stop, all 56 archive entries,
full CRC/decompression and contiguous nonempty level chunks `[0,1]` pass.
Native-load and final cleanup receipts are recorded in the final section below.

Evidence is retained under
`test-results/red-automation-live-2026-10-17y/`, including the unused first
preflight archive, transport history, frozen helpers and terminal proofs.
Historical Run X and other archived evidence remain unchanged.
## Final native validation and cleanup

Factorio 2.0.77 from the exact server image loaded a pristine checkpoint copy
with the actual 31 active mod files, performed one benchmark update and exited
0 in a network-disabled disposable container. The original checkpoint's size,
SHA256 and modification time were unchanged. Four setup failures were preserved
separately before the successful validation; all five disposable attempt IDs
were removed. No provider or Jev inference occurred during validation.

Native-load proof SHA256:
`6f520b0db85274a2d9c60e13b0e3df7aab4ff1d46d10cb53aa3bb63cfe390d44`.
The parent verified all 14 bounded unique paths, lengths and digests in its
manifest, SHA256
`cfbdd6965d29f365b1dd44d2f37fd7ad61a917c8386231186aaf44584c680171`.

The exact Run Y Compose container/network and all project volumes are gone.
Save/trace/proof files remained unchanged across graceful teardown, and unrelated
containers were untouched. The parent verified the restored SSH PID/start time
before stopping it, then verified both owned tunnel PIDs and the configured
listener absent. No owned runtime, tunnel or disposable validation container
remains. Bind evidence, checkpoints and shared verified images are retained.

The final outcome is a failed autonomous red-science trial with a valid saved
world and successful strict stop/archive/cleanup gates. The next work is an
offline causal regression for the refused pump placement and subsequent
unsupported blocker/action-omission recovery loop; this run authorizes no second
live trial, manual continuation or budget reset.

Post-cleanup account usage was 8% weekly remaining, above the owner's approximate 5% reserve.
