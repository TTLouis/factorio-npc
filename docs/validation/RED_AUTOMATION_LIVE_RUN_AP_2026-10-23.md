# Run AP: invalid accelerator startup

Run AP did not establish red-science automation or accelerator performance. The
harness attempted unsupported `/config set auto-pause false`; Factorio2.0.77
returned `Unknown config: auto-pause`. Manual unpause left server auto-pause
active. Two pre-stop snapshots advanced1005ticks in90.079s (11.16UPS), while
console traffic could itself advance the clock. The parent terminated the trial
for this startup defect. This is a harness failure, not an NPC gameplay verdict.

Frozen local source: `4c11c146e11d98c5ae403193a032667682f213e0`; published Jev:
`b9574fc4556eafb431f158ebee80fe3f1807a02d`. Exact2.0.77 official local image;
70 shipped runtime and32 native files matched deployment. Zero humans, fresh
actor5/goal`goal_08lf929_1`, seed2940585149, empty board/inventory before the
one-time vanilla starter. Planner`gpt-6.1-sol`, executor`gpt-6-luna`, Jev1.14.0;
Luna read-only overwatch stayed separate from NPC inference.

Objective: Build a fully automated factory producing at least one
`automation-science-pack` per game minute from natural resources.

Evidence root: `test-results/red-automation-live-2026-10-23ap/`.
[Metrics](../../test-results/red-automation-live-2026-10-23ap/analysis/metrics.json),
[controller accounting](../../test-results/red-automation-live-2026-10-23ap/analysis/controller-metrics.json),
[acceleration accounting](../../test-results/red-automation-live-2026-10-23ap/analysis/acceleration-metrics.json).
Raw evidence is sealed:224files/10,061,636bytes; manifestSHA256
`1e3a2c9cb3f99cde431914426bc32b6b96a4cfb306e1d6e0dbe3f5215428446a`.
Derived analysis does not rewrite the emergency result or original helpers.

## Actual plan and exercised paths

The committed plan`goal_08lf929_1_p3` version1 had three steps:

1. Acquire10copper ore and4coal for electronics bootstrap.
2. Place the held stone furnace and obtain its live identity for exact supply.
3. Smelt and collect10copper plates, then verify electronics research.

No step completed. One`gather_resource(copper-ore,10)` batch was admitted and
acknowledged; native walking began, with no completed batch receipt. No placed
factory or automated science output was verified. The last pre-stop world
snapshot precedes this late admission; it must not be represented as a complete
terminal world observation.

The shelf included electronics, steam and science unlocks, automatic fuel,
electricity, automation research, automatic iron/copper/gears and science.
[Full readable plans](../../test-results/red-automation-live-2026-10-23ap/analysis/plans.md)
retain exact guidance/contracts and label issued drafts separately.
`canonical-plans.json`, `full-issued-responses.json`, `plan-provenance.json` and
`plan-events.json` retain IDs, timestamps, observations, prompts and outcomes.
Prediction started after admission and was discarded as`stale_cancelled` at stop.
Quantity compilation, material ledger, production task admission and prediction
were exercised; sprint acceleration was not:0leases/0sprint ticks/0native guard
checks. These zero counters do not prove construction effectiveness.

## Accounting

Trial:20:18:04.690Z to stop submission20:20:58.119Z,173.429s; runner entry was
61ms earlier. Paired stop confirmed20:20:58.479Z (360ms). Build95.453s,
preflight33.393s, stop/save/cleanup17.267s; measurement not entered.
Planner completed-request latency146.920s total/48.973s average (6.230–81.028s);
executor16.780s/8.390s average (7.766–9.014s); Jev1.089s/217.8ms average
(136–401ms). LLM/Jev interval union166.042s; tool-batch union442ms. These views
and native work overlap and are not an additive wall-time partition. Native
walking was interrupted; complete action and exclusive waiting durations are
unavailable. Measured thinking time is unavailable; request latency includes
queueing/network/generation. Reasoning tokens are not time.

Two correlated validation retries completed control recovery: one
`requirements_grounding` before commitment, one`invalid_production_task` on
plan p3/step1. No automatic resume or planner-review request; one normal
executor context restage. No operator gameplay correction. The parent terminal
stop is explicitly separate from recovery. Recovery episode IDs/scopes and
attribution limits are in metrics; completed recovery is not completed gameplay.

Model observation calls/results: `getRecipeDetails`2/2, `getResearchPath`1/1,
`getMiningDetails`1/1, all successful,0reported cache hits/refusals. Additional
harness production reads: inventory1, recipe2. No complete native-query or
coalescing count is exposed; unknown is not zero. Native admissions:1batch,
1gather operation,1acknowledgement,0completion receipts. Per-tool averages,
proposals and response-versus-execution distinctions are retained in metrics.

CLI requests6/responses5/cancellations1/errors0/retries0/fallbacks0:
planner4/3 (one cancelled), executor2/2. Completed planner usage94,189input
(49,664cached/44,525uncached),5,060output including1,550reasoning;
executor46,048input (19,840cached/26,208uncached),435output including175reasoning.
Jev5requests/5responses/0failures; only partial reported units7,346input/766output,
complete billable tokens unavailable. No new calls after strict stop submission
or confirmation. Rotated traces deduplicate by request identity. Codex parent/
overwach usage is unavailable separately and excluded from NPC totals.

USD estimates and actual billed costs are unknown:11unpriced requests,
unverified internal alias rates, partial Jev usage and no billing evidence.
Pricing checked2026-10-23 with no verified applicable source/rates. Reported Jev
zero cost is not evidence of free billing. No reasoning double count; a future
token-price equivalent must be distinguished from subscription incremental cost.

## Stop, save and cleanup

Fresh cancellation and same-goal operator pause confirmed native idle/empty
queues at1x. Emergency save after that boundary:947,078bytes/56ZIPentries,
full ZIP integrity passed, SHA256
`a227ae09636ad1ff584aed54683fa711eea8a9443281429c1c36a72414aba011`.
Pristine exact2.0.77 load passed with no supervisor/providers. The live wrapper
had already removed its transient mods directory: verification reconstructed the
32 files from independently retained, hash-matched deployed native bytes. The
first verifier setup attempt failed before engine execution; v2passed. This
provenance limitation is recorded rather than hidden.

Project`red-automation-20261023ap`, exact container
`red-automation-20261023ap-sgluna-factorio-1`/CID
`5e3801e43c2b9bf061a17c9ef1dda7b99bcc5961ffb1614c777fdb2fd1d65444`, owned
networks/volumes, verification containers, tunnelPID13140, recorder and unique
image tag were removed; temporary configuration hardlink removed. Shared
`factorio-npc:local` retained. Cleanup proof and overwatch final review retained.
No live AP inference or background work remains.

The old native10 positive-tick startup assertion was a false positive and is
superseded for startup adoption. The repair must reload a replicated paused
world under authoritative non-auto-pausing settings, prove an observation-free
clock before NPC wake, and durably permit at most one residual correction with
terminal exhaustion. A fresh trial is separately owner-authorized only because
AP stopped for the harness error.
