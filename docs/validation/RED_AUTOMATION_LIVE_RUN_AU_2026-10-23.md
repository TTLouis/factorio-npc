# Run AU: polling prevention exercised; identity repair still incomplete

The Run AT polling-budget failure did not recur. The new shared inline guard
boundary ran thousands of times without spending a separate control RPC for each
check. **Residual polling recovery was not triggered**, so this trial does not
establish live self-correction of a polling miss.

The science goal **failed** after **7 m 30.782 s** from objective submission to
strict stop submission (runner elapsed **7 m 31.199 s**). The harness paused on
`exact_entity_requires_live_observation` for burner-mining-drill **15**, then did
not recover it. Six copper plates and zero automation-science packs were produced.
Safe refusal is not successful self-correction. There was one authorized trial,
no corrective gameplay prompt, manual resume, provider retry, push or production
deployment. The run label retains October 23 local launch date; timestamps below
are October 24 UTC.

## Candidate, ownership and preflight

Frozen local integration **`0776b39bf0fd32c18543148e64fea576d99d389a`**; independent
runtime approval `f379a8b4b19ce28e7c196136cbea6e1807528505`, runtime commit
`378f514ff6736ff200a9fd77ff8978e91cb5d382`. Published Jev was freshly checked as
`b9574fc4556eafb431f158ebee80fe3f1807a02d`. Task branch
`test/run-au-red-automation`, owner Codex /root chat01a16ab4. Executable source and
frozen runner controls stayed fixed throughout the trial.

Payload source `bfadd2d9ee41f4d4452632f145e3bc2b70f89efe`, SHA-256
`6d9ff05468d450708b8ae00650f825380291c5022206f8963154512688245be4`.
The official local-source build, 72 shipped runtime/prompt/manifest checks and 32
independently compiled active native files matched the frozen candidate. Factorio
**2.0.77**. Fresh gates passed: **3,371 runtime / 1,378 mod**, typecheck, Lua and
generated-Lua check; payload 9, runner helpers 45, recorder 1, ZIP checker 10 and
entity-accounting 5 tests. Prior polling repair has 28 new regressions, 50 focused
cases, two exact-baseline failures and two exact-version native proof runs; their
scope and limits remain in the [repair record](../RUN_AT_POLLING_REPAIR_2026-10-23.md).

One cold isolated project `red-automation-20261023au`, actor **6**, seed
**210771490**, new goal **`goal_072qkvb_1`**, zero humans, empty board/inventory and
idle native queues before the declared one-time vanilla starter. The starter was
8 iron plates, 1 burner drill, 1 furnace, pistol and 10 magazines. Catalog GETs and
mocked preflight contracts are separate from inference; no inference or goal ran
before the final preflight passed.

The newly frozen accelerated profile uses 1× baseline and harness-leased sprints
up to 4×, 600 ticks / 3 wall seconds per burst and 3,600 ticks per durable wait
episode. Current native guard, source binding, startup clock and host watchdog
proofs were required. These results remain separate from normal-speed baselines.
Effective roles were CLI-proxy planner **gpt-6.1-sol**, executor **gpt-6-luna** and
dedicated **Jev 1.14.0**. Independent read-only **gpt-6-luna** overwatch ended with
the trial; [its final review](../../test-results/red-automation-live-2026-10-23au/overwatch/final-review.md)
corroborates the outcome and limits.

Two preparation failures are retained separately, neither a second trial nor a
provider retry. The first official build's `stable` selector resolved an
unsupported release. The successful build used a run-scoped explicit 2.0.77 pin
without changing shared configuration. The first independent-native comparison
correctly failed because the parent precreated the output directory and nested
the compiled files under `dist`. That preflight world and logs were archived,
the exact already-compiled bytes were laid out correctly, and a fresh cold world
passed all comparisons. Both failed preparations were cleaned up before the
sole objective was submitted. See [build attempts](../../test-results/red-automation-live-2026-10-23au/analysis/build-attempts.json)
and [preflight attempts](../../test-results/red-automation-live-2026-10-23au/analysis/preflight-attempts.json).

## What corrected, and what did not

The Run AT prevention path was exercised. The runner's last sprint summary had
**3,616 inline checks / 198 dedicated boundary restores**. The controller-close
event, which includes startup and shutdown, had **3,702 inline checks / 204
dedicated restores**, plus configure 1, superseded restore 4, eligibility 93, arm
12, identity refresh 24, inventory refresh 12 and emergency control 1. These are
cumulative lane counts, not a per-minute rate. Inline checks share an existing
world RPC; the **1,200 additional control RPC/minute cap remained unchanged**.
There were **0 control-budget refusals**, and the largest sampled bucket count
was 86 (not a claim of exhaustive peak measurement).

Polling residual correction: **0 attempted / 0 completed / 0 failed / 0 exhausted**.
Entity-refresh and gather correction: also **0 episodes**. The injected residual,
restart, exhaustion, uncertain-effect, native-busy and stale-owner variants retain
their offline proof; none was demonstrated by a live recovery here. The ordinary
coal gather succeeded, but the exact-resource and nearby-coordinate repair paths
were not exercised. Three advisory contract predictions bound successfully.

At **03:59:45.456Z**, mutation validation requested a retry because drill 15 lacked
a live exact binding. A duplicate observation retry followed. At
**04:00:11.867Z**, the repeated exact target was rejected again, and at
**04:00:12.014Z** the harness guard-paused p3/v1/step 4 with
`blocked_decision:exact_entity_requires_live_observation`, before mutation. The
durable semantic locator was burner-mining-drill at **(-95, 39)**; furnace 16 was
at **(-95, 37)**. The already-rejected identity could not grant renewed admission.
No `entity.refresh_*` recovery event or verified automatic continuation followed.
The retained checker reports `exact_entity_binding_unrecovered` and
`blocked_before_mutation`. The exact replies/events are preserved in the
[failure fixture](../../test-results/red-automation-live-2026-10-23au/analysis/run-au-failure-fixture.json).
This establishes a remaining harness coverage gap; its implementation cause is
not proved by this report.

A separate sprint fault, **`Sprint boundary owner superseded`**, occurred at
**04:00:35.412Z**, during strict stop confirmation, after cancellation submission
at 04:00:35.281Z and before confirmation at 04:00:35.629Z. It was **not** the trial's
earlier guard cause or another polling-budget exhaustion. There were zero sprint
faults before stop submission and zero after confirmation. The runner snapshot
predates that event and reports faults 0; the later raw fault is retained and
reconciled separately, without rewriting the snapshot.

At the last pre-stop native sample (**04:00:35.172Z**, tick 37,942), three of four
committed steps were complete. A physical drill→furnace copper feed existed;
20 coal and 6 copper ore/plates had been produced. The actor held 18 coal and the
8 starter iron plates; all 6 copper plates remained in the furnace output.
Neither machine retained fuel, and the drill had no burner energy. No new iron or
science was produced. The fourth step still required 10 collected copper plates
and electronics research. Passive production may continue before the save; these
are sample-boundary counts, not exact post-save stock. Measurement never began.

## Recovery counts

| Mechanism / reason | Attempts | Continued/completed | Failed | Plan/step |
| --- | ---: | ---: | ---: | --- |
| Validation retry: requirements_grounding | 1 | 1 | 0 | Initial draft, before commitment |
| Validation retry: observation_decision_pressure | 1 | 1 | 0 | p3/v1/s2 |
| Validation retry: observation_decision_pressure | 1 | 1 | 0 | p3/v1/s4 |
| Validation retry: duplicate_observation | 2 | 0 | 2 | p3/v1/s4 |
| Validation retry: exact_entity_requires_live_observation | 2 | 0 | 2 | p3/v1/s4 |
| Harness polling / entity-refresh / gather correction | 0 | 0 | 0 | Unexercised |
| Automatic resume / planner-review requests | 0 | 0 | 0 | No operator resume |

The seven validation attempts yielded three control continuations and four
failed/superseded attempts, not three verified gameplay repairs. Each attempt ends
at its next retry or correlated continuation/failure; several events do not become
several physical recoveries. One context restage is counted separately. Missing
episode-local plan/step IDs are temporally attributed from canonical step
timestamps and explicitly labelled in [metrics](../../test-results/red-automation-live-2026-10-23au/analysis/metrics.json).
Operator gameplay interventions: **0**. The required terminal cancellation and
operator-pause receipt are stop controls, not a gameplay repair.

## Tools and native work

| Observation tool | Attempts lower bound / traced / results | Failures/refusals | Cached | Envelope total / mean seconds |
| --- | ---: | ---: | ---: | ---: |
| getRecipeDetails | 3 / 3 / 3 | 0 | 0 | 0.580 / 0.193 |
| getResearchPath | 1 / 1 / 1 | 0 | 0 | 0.181 / 0.181 |
| getMiningDetails | 2 / 2 / 2 | 0 | 0 | 0.372 / 0.186 |
| discoverPrototypes | 1 / 1 / 1 | 0 | 0 | 0.059 / 0.059 |
| getNearbyEntities | 1 / 1 / 1 | 0 | 0 | 0.188 / 0.188 |
| getPlacementCandidates | 2 / 2 / 2 | 0 | 0 | 0.396 / 0.198 |
| getLogisticsTopology | 1 / 1 / 1 | 0 | 0 | 0.184 / 0.184 |
| getEntityStatus | 8 / 8 / 8 | 0 | 3 | 0.837 / 0.105 |
| getTechnology | 3 / 3 / 3 | 0 | 1 | 0.382 / 0.127 |
| getResearchStatus | 1 / 1 / 1 | 0 | 0 | 0.137 / 0.137 |
| getInventoryItems | 1 / 1 / 1 | 0 | 0 | 0.119 / 0.119 |

All **24** traced observation envelopes returned success, including 4 cached
results. This counts harness tool execution; exact native RPC and per-tool
coalescing counts are unavailable, not zero. Additional production-controller
reads were getInventoryItems 1 and getRecipeDetails 1; failed attempts, cache and
individual durations are not exposed by that channel. Sprint control reads above
are separate again.

Provider replies returned **31 tool calls**: 24 observations and **7 submitPlan**
control calls. Six normalized proposals are separate from admitted world work.
There were **6 admitted operations in 5 batches**, 5 acknowledgements and 5 native
completed-batch receipts: gather_resource 1, place_candidate 2, supply_entity 2,
wait 1. Native receipts contained **7 tasks**: walking 1, mining 1, placing 2,
transfers 2, waiting 1. Internal navigation/resume markers are not additional model
actions. Admission and native batch completion do not prove the active checkpoint
or gameplay goal.

## Timing

| Interval | Total seconds | Mean / range seconds |
| --- | ---: | --- |
| Successful official pinned build | 82.648 | Separate from trial |
| Successful cold preflight | 32.546 | Separate from build |
| All preparation start → objective submission | 743.110 | Includes offline work and failed preparations |
| Objective submission → strict stop submission | 450.782 | Runner clock 451.199 |
| Planner requests (6) | 146.526 | 24.421; 3.683–72.682 |
| Executor requests (17) | 154.624 | 9.096; 3.332–24.488 |
| Jev requests (17) | 3.344 | 0.197; 0.118–0.298 |
| LLM wire interval union | 300.245 | Overlap deduplicated |
| LLM+Jev interval union | 303.102 | Jev intervals inferred from response latency |
| Observation envelope interval union | 1.619 | Per-tool sums may overlap |
| Completed retry steering spans (3) | 85.459 | Overlap provider/tool/world work |
| Strict stop confirmation | 0.348 | Included below |
| Stop submission → wrapper cleanup complete | 22.407 | Save, integrity and pristine load included |
| Measurement | 0 | Not entered |

The earlier failed build has no exact retained start boundary; its duration is
unavailable. Failed preflight boundaries/logs remain in its archive. Build,
preflight, trial and closeout phases are distinct. Runner entry was 69 ms before
objective submission; both clock boundaries are retained.

| Native task segments | Segments | Wall seconds | Mean seconds |
| --- | ---: | ---: | ---: |
| Mining | 2 | 24.800 | 12.400 |
| Transfers | 2 | 0.017 | 0.009 |
| Placement | 3 | 0.024 | 0.008 |
| Explicit waiting | 1 | 29.699 | 29.699 |
| Navigation | 3 | 11.395 | 3.798 |

Segments use Factorio process-log wall timestamps; navigation/resumed placement
can exceed top-level task counts. No crafting task was traced. Exclusive passive
production/research waiting and total idle duration are unavailable. These views
overlap LLM/Jev/tool/recovery activity and must not be summed as an exclusive wall
partition. **Measured thinking duration is unavailable**; request latency includes
queueing, network and generation. Reasoning tokens are not a duration.

All **12 sprint leases restored**, with **1,606 actual ticks**, 1,606 native tick
guard checks and **6.766 s measured native sprint wall time**. At 60 ticks/s the
estimated 1× equivalent is 26.767 s and estimated native-time saving is 20.001 s;
this is not a measured normal-speed baseline or end-to-end improvement. **81**
durable episode-budget lease refusals are separate from the zero polling-budget
refusals and are not failed recoveries.

## Model usage and price completeness

| Provider / model / role | Requests / responses | Input | Cached input | Uncached input | Output | Reasoning included in output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CLI-proxy / gpt-6.1-sol / planner | 6 / 6 | 150,760 | 64,256 | 86,504 | 5,976 | 1,774 |
| CLI-proxy / gpt-6-luna / executor | 17 / 17 | 539,440 | 317,440 | 222,000 | 5,349 | 3,365 |
| Typesafe / Jev 1.14.0 / semantic checkpoints | 17 / 17 | unavailable tokens | unavailable | unavailable | unavailable tokens | unavailable |

CLI totals: **690,200 input, 381,696 cached, 308,504 uncached, 11,325 output and
5,139 reasoning tokens already included in output**. All 23 original wire
request/response bodies were retained, with complete reported CLI usage and zero
recording errors. CLI errors/cancellations/retries/fallbacks: **0**. Jev failures,
unmatched requests and fallbacks: **0**. Partial trace-reported Jev units are
52,155 input / 3,656 output, with usage fields on 15 of 17 responses; their token
mapping and completeness are unknown. A recorded cost of 0 is not proof of free
usage. Two preflight catalog GETs are separate from inference.

**No NPC or Jev request started after strict stop submission or confirmation.**
Requests are deduplicated by correlated identity across retained/rotated traces,
with role/round/recovery attempt and response-ID matching. See
[provider calls](../../test-results/red-automation-live-2026-10-23au/analysis/provider-calls.json)
and [provenance/completeness](../../test-results/red-automation-live-2026-10-23au/analysis/plan-provenance.json).

Estimated USD cost per provider/model/role and total: **unavailable/partial**;
**40 unpriced inference requests**. Alias-specific rates, cache rates and pricing
sources are unknown as of 2026-10-24; no verified public-price alias mapping or
billing evidence is retained. No extra reasoning charge is added. Subscription
token-price equivalent differs from actual incremental charge. Parent/overwatch
per-agent tokens and billing are unavailable and excluded from NPC totals. Shared
Codex weekly usage was 70% used before launch and 71% at closeout; that is not a
trial-specific usage bill or monetary cost.

## Actual plans

> Build a new automated factory that continuously produces at least one automation-science-pack per game minute from natural resources.

The actual Shelf had **11** nodes: establish bootstrap copper; bootstrap iron;
unlock automation science; establish steam electricity; research automated
assembly; automate coal/fuel delivery; sustained iron; sustained copper; iron
gears; science assembly/output; verify autonomous throughput. Future nodes are
intentions, not completed factories. Only **p3/v1** committed.

| Step description copied from canonical plan | Final outcome |
| --- | --- |
| Acquire 20 coal as startup fuel for the copper mining and smelting cell. | completed |
| Place the held burner-mining-drill over natural copper ore and obtain its live identity and actual output position. | completed |
| Place the held stone-furnace at a validated position covering the drill output and obtain its live identity. | completed |
| Fuel the copper cell, verify direct ore delivery, collect 10 newly smelted copper plates, and verify electronics researched. | active, native board guard-paused |

Full original goal/Shelf, execution guidance, completion contracts, outcomes and
snapshot history: [readable plans](../../test-results/red-automation-live-2026-10-23au/analysis/plans.md),
[canonical copies](../../test-results/red-automation-live-2026-10-23au/analysis/canonical-plans.json),
[full issued drafts/replies/review notes](../../test-results/red-automation-live-2026-10-23au/analysis/full-issued-responses.json)
and [request/model/prompt/source/observation provenance](../../test-results/red-automation-live-2026-10-23au/analysis/plan-provenance.json).
Rejected drafts/proposals are labelled separately; these are retained messages
and snapshots, not a reconstructed cleaner plan.

## Stop, evidence and cleanup

Fresh supervisor cancellation and same-goal operator-pause receipt confirmed in
**348 ms**, with native idle/empty task and crafting queues before saving. The
save followed confirmation: **881,166 bytes / 56 ZIP entries**, full CRC/integrity
PASS, SHA-256 `5c280d4c32c95174c3aac9f8b61f7a13ad5fce51f452281dd0ef959c96f487a9`.
A pristine copy loaded successfully with exact Factorio **2.0.77** and the exact
32-file active native mod. Wrapper exit 0 proves closeout, not gameplay success.

All recorded Run AU container IDs and exact names, including stopped containers,
the exact Compose project's networks/disposable volumes, both preparation/trial
tunnels and recorders, listeners, unique run image tag and temporary config link
are absent. Shared configuration values were not inspected or changed. Host
evidence/saves/source and shared cached images are retained. No background work
remains. [Cleanup verification](../../test-results/red-automation-live-2026-10-23au/analysis/cleanup-final.json)
retains exact identities and daemon events, including `--rm` proof containers.

Raw controls, traces, saves, native proofs and failed preparation archive are
sealed (**312 files / 19,469,453 bytes**, manifest SHA-256
`ddaf74884533d6540c47e0bbb78524f3e72204890edb6267b7fc912e4c41e4b4`)
in [raw manifest/seal](../../test-results/red-automation-live-2026-10-23au/raw-seal.json).
Derived analysis and overwatch remain outside that seal. All 53 frozen helper
inputs, 676 AR/AS/AT sealed historical files, 186 historical validation files (including the 32 protected reports) and the prior
polling repair evidence are reverified unchanged. Complete
[machine-readable metrics](../../test-results/red-automation-live-2026-10-23au/analysis/metrics.json),
[polling boundaries](../../test-results/red-automation-live-2026-10-23au/analysis/polling-metrics.json),
[acceleration](../../test-results/red-automation-live-2026-10-23au/analysis/acceleration-metrics.json),
[evidence verification](../../test-results/red-automation-live-2026-10-23au/analysis/evidence-verification.json)
and [closeout](../../test-results/red-automation-live-2026-10-23au/analysis/final-summary.json)
are retained under this new run, without altering historical evidence.

The next repair should cover the unrecovered exact drill binding at the shared
harness boundary, with the exact AU sequence and injected residual continuation
regressions. The separate cancellation-boundary sprint fault also remains open.
This report authorizes no implementation or second trial.
