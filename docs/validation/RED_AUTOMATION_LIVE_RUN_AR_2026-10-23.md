# Run AR: accelerator exercised, red-science automation blocked

Run AR ended after **4m30.461s** with `controller_blocked:canonical_plan`.
It gathered 10 copper ore, then native coal mining returned `mining_rejected`.
The partially completed batch remained `partial_unknown`; duplicate-effect
protection refused further coal gathering and the committed plan blocked.
No machines were placed and no science was produced. This is a real in-run
execution/reconciliation failure, not a cold-start infrastructure failure.

The accelerator ran 6 bursts, all 6 restored, with 1,836 actual ticks and 1,836 native
guard checks. Native log timestamps measure 8.278s at sprint speed; 30.600s is
the estimated1x equivalent, implying 22.322s estimated native-time saving. This
is not a measured end-to-end comparison with a separate baseline or another seed.

## Frozen source and preparation

Local Jev candidate `2f5f52820aae8b84ed92c0cbf71cdcfe63f7e66a`; freshly verified
published Jev `b9574fc4556eafb431f158ebee80fe3f1807a02d`. Task/integration
ownership: Codex /root session01a16167, feat/e2e-tick-sprint and the registered
temporary og-port integration checkout. No push or production deployment.
Payload ref`a1b59a70dc8333db1e36c4d12c8a032d92de5eae`, payloadSHA256
`ecc7f3c7d9619ce14b6fa605465600a7b65c0b8533c94d907e5bbb587b93e577`.

Merged gates: 3261 runtime / 1366 mod tests, typecheck, Lua build/generated-Lua,
changed lint, payload 9 tests, 45 offline helper tests and cleanup negative controls.
Independent startup/console/helper reviews approved. Native14 proved exact2.0.77
finite-batch safety, fresh-console confirmation attempts[2,1], independent clock,
one residual settings correction and durable exhaustion with zero inference.
The final diagnostic reason field was covered by the actual Session fixture.

Official local build118.793s; cold preflight47.531s. All 70 shipped runtime modules,
prompt/release manifest and 32 native files matched the frozen deployment.
The native compilation was reused from AP because native sources/guard/preparer
were unchanged, then independently hash-matched to active/release bytes.
Zero humans, fresh actor 25 / seed 2634398660 / empty board and inventory before one
vanilla starter. Goal`goal_1u1qvv2_1`:
“Build a fully automated factory producing at least one automation-science-pack
per game minute from natural resources.” Effective planner`gpt-6.1-sol`,
executor`gpt-6-luna`, dedicated Jev1.14.0; Luna read-only overwatch was separate.

AP was sealed as invalid startup; AQ was a zero-goal/zero-inference cold preflight
failure. They were not silently retried or edited. Their separate reports record
the unsupported auto-pause command and first-console confirmation gap. AR was
the owner-authorized fresh goal trial. The ready-fence preflight observed 61 ticks
in1.016s before inference, proving the clock fix rather than console-driven ticks.

## Actual plans and failure

One committed plan, `goal_1u1qvv2_1_p3` version1, at21:20:39.518Z:

1. Acquire 10 copper ore and 10 coal for electronics bootstrap, retaining the furnace.
   Contract: inventory copper-ore>=10, coal>=10, stone-furnace>=1. Blocked/incomplete.
2. Install the held furnace, then observe its exact identity. Never activated;
   its later completion contract remained null/unbound.
3. Smelt/collect 10 copper plates and verify electronics research. Never activated;
   its later completion contract remained null/unbound.

The 11-node shelf covered copper/iron bootstrap, steam electricity, science unlock,
assembly research, automatic fuel/iron/copper/gears, science assembly and throughput.
No later slice or plan revision committed. Prediction for step2 started after
admission and was discarded`native_step_failed`; it never bound or ran.

[Full issued plans and guidance](../../test-results/red-automation-live-2026-10-23ar/analysis/plans.md)
include exact contracts, original drafts/proposals and disposition.
[Canonical structured copies](../../test-results/red-automation-live-2026-10-23ar/analysis/canonical-plans.json),
[wire responses](../../test-results/red-automation-live-2026-10-23ar/analysis/full-issued-responses.json)
and[provenance](../../test-results/red-automation-live-2026-10-23ar/analysis/plan-provenance.json)
retain request/model/timestamp/prompt/observation sources. All 11 responses have
complete captures, 0 missing original request bodies and 0 recorder errors. No plan
was reconstructed into a cleaner original and no private thinking was requested.

At21:20:50.808Z one batch admitted two`gather_resource` operations: 10 copper ore
and 10 coal, radius1024. Copper completed; coal did not. Native receipt at tick15306
cancelled batch-g1-1 as`mining:mining_rejected`. Reconciliation read the exact
cancelled receipt three times but retained`admitted_cancelled/partial_unknown`,
settled=false. Two subsequent admissions were duplicate-suppressed; at21:21:53.517Z
the guard paused the goal. Fresh native facts still showed 10 copper ore / 0 coal,
no placed machines and zero science. The cause of native mining rejection is not
proved by the selected-tree snapshot; selection/repositioning is a follow-up
hypothesis, not an established causal finding.

[Exact failure fixture](../../test-results/red-automation-live-2026-10-23ar/analysis/failure-fixture.json)
and[failure timeline](../../test-results/red-automation-live-2026-10-23ar/analysis/failure-timeline.jsonl)
preserve this evidence. The unresolved-effect fence prevented uncertain replay;
it did not self-correct the failed acquisition. Future repair must prove per-slot
residual effects and safe bounded continuation at the harness boundary, preserve
the duplicate guard/immutable plan, and reproduce native rejection separately.

## Recoveries and tools

[Machine metrics](../../test-results/red-automation-live-2026-10-23ar/analysis/metrics.json)
contain grouping by reason, mechanism and canonical plan/step. Validation retry
episodes: 5 attempted, 1 completed, 3 failed, 1 unresolved: requirements_grounding1/1;
duplicate_observation2/0; observation_decision_pressure1/0;
observation_decision_budget_complete1unresolved. These count control outcomes,
not gameplay success. One authoritative native reconciliation episode remained
unresolved; its 3 receipt reads are not 3 recoveries. Automatic resumes0,
planner-review requests0; one normal executor context restage. Operator gameplay
recovery0; the terminal runner stop is separate from recovery.

| Model observation tool | Calls/results | Successful | Failed/refused | Cached | Average ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| getRecipeDetails |2/2|2|0|0|416.5|
| getResearchPath |1/1|1|0|0|418.0|
| getMiningDetails |1/1|1|0|0|413.0|
| getInventoryItems |3/3|3|0|2|94.333|
| getNearbyEntities |2/2|2|0|0|221.5|

Native mutation channel: 1 admitted/acknowledged batch, 2 gather operations,
4 queued task entries; 0 completed batch receipts and 1 cancelled batch. Internal
navigation/mining retries are separate task segments, not extra model operations.
Proposal/admission/result counts are distinct in metrics. Static cache can avoid
native execution even with cached=false; exact native-query/coalescing totals
remain unavailable. No craft/place/transfer/research production was admitted.

Harness sprint polling is separate from model observations. The retained runner
counter snapshot includes prelaunch controller startup: configure 1,
boundary_restore1886, eligibility19, arm6, identity_refresh12, inventory_refresh6.
The later post-stop alarm carries boundary_restore1920 plus emergency_control1;
these are cumulative snapshots, not additive totals or model tool calls.
The frozen compact host renderer hit a null plan before commitment; its underlying
observer preserved state/rotations and subsequent observations used that reader.
No frozen control or gameplay action changed to work around this display error.

## Time, API usage and price completeness

Trial21:18:13.014Z–21:22:43.475Z:270.461s; runner entry76ms earlier.
Stop confirmed21:22:43.792Z,317ms after submission. Stop/save/cleanup28.115s;
measurement not entered. Observed native game delta17,570ticks =292.833game seconds.

| Request role | Completed calls | Total latency s | Average s | Range s |
| --- | ---: | ---: | ---: | --- |
| Planner |4|145.741|36.435|3.616–85.761|
| Executor |7|46.506|6.644|2.316–10.166|
| Jev |7|1.560|0.223|0.153–0.405|

LLM/Jev wire interval union193.347s; tool-batch union0.914s. Native logged walking
segments6/14.655s total/2.443s average (0.066–7.074s), mining segments5/6.419s/
1.284s average (0.017–6.350s). They include internal retries and overlap with model
prediction and acceleration. Requirements-grounding retry envelope52.671s;
guard pause preceded terminal detection by~49.958s. Categories are separate views,
not an additive exclusive partition. Exhaustive waiting duration is unavailable.
Measured reasoning/thinking duration is unavailable; request latency includes
queueing/network/generation. Reasoning token counts are not duration.

CLI 11 requests / 11 responses,0transport failures/cancellations/retries/fallbacks.
Planner111,876input (49,664cached/62,212uncached),5,684output including1,870reasoning;
executor200,187input (119,040cached/81,147uncached),1,341output including929reasoning.
All 11 CLI replies have usage. Jev 7 requests / 7 responses,0failures/fallbacks; partial
reported units14,636input/1,334output from5usage-bearing responses, complete billed
usage unknown. No new CLI/Jev request after stop submission or confirmation.
Rotated traces are deduplicated by request identity. Parent / overwatch usage is
unavailable separately and excluded from NPC usage.

USD estimated and actual billed totals are unknown/partial:18 unpriced requests,
no verified alias-specific pricing source/rates as of2026-10-23, incomplete Jev
usage and no billing evidence. Reported Jev zero cost does not prove free billing.
Reasoning is already in output, with no double count. A token-price equivalent
would differ from an incremental subscription/CLI-proxy charge. Quota is not cost.

## Accelerator scope, stop and evidence

[Native speed history](../../test-results/red-automation-live-2026-10-23ar/analysis/acceleration-metrics.json)
retains lease/episode/request/actor/epoch/plan/step IDs, wall/tick boundaries,
restoration reasons and refresh evidence. All 6 leases returned 1x; no unconfirmed
restoration. Actual 1836 ticks consumed conservatively reserved 3600 episode ticks;
13 eligibility refusals include exhausted allowance. No in-trial fault.
One`Sprint construction authority closed` safe-stop alarm occurred 33ms after
strict stop confirmation. It is a post-stop lifecycle issue, preserved separately
from the pre-stop zero-fault snapshot, not erased as a successful recovery.

Exercised: cold startup handshake/reload/quiet clock, native gather/navigation,
serialized accelerator admission/restoration/freshness, durable episode cap,
observation/cache pressure, native reconciliation/duplicate fence, stale prediction
discard, sealed paired stop/save/load. Quantity compiler, material ledger,
harness production tasks, reservation/designer, prediction binding and later
production construction were not exercised. Real human join/network behavior
remains unvalidated; the adopted profile was zero-human.

Fresh cancellation and same-goal operator-pause receipts confirmed1x/native idle/
empty queues before save. Checkpoint674,548bytes/55ZIPentries passed full integrity;
SHA256`707b01b98e0663348d97e2d3e83a5fb3f26b82a10703d5b23aa7f0359b1e00c0`.
Pristine exact2.0.77 load passed using copied active runtime mods, no providers.

Project red-automation-20261023ar; container
red-automation-20261023ar-sgluna-factorio-1/CID
`1ba241035947228296fdbc9331744106730f0531a293c8223e194d1ef338ab58`.
Recorded container/proof resources, networks/volumes, tunnelPID79496, recorder and
unique image tag removed; temporary configuration hardlink removed before start.
Shared images and host evidence/save retained. Overwatch closed; no background
work remains. Offline proof containers/image were also cleaned independently.

Evidence root`test-results/red-automation-live-2026-10-23ar/`,216 sealed raw files,
10,383,779bytes; manifestSHA256
`45a270bebeb7693cdff473fa7a8b4bbb8eb60f2e4fd942191862133fab9131b4`.
Trace sources: behavior/prompts/decision JSONL including retained rotations, full
wire responses, native Factorio log, runner snapshots/state/result and stop/save/
load/cleanup proofs. Analysis/overwatch remain outside the immutable raw seal.
Unknown telemetry is marked unknown, not zero; source references/counting rules
and complete structured plans are retained in the linked artifacts.
