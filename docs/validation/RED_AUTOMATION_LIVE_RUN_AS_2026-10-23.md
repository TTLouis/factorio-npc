# Run AS — latest candidate after Run AR mining repair

**Gameplay FAIL; stopped safely after 7m30.707s.** The NPC mined coal and copper
and smelted 10 copper plates, but produced zero automation science packs. It stopped
on `blocked_decision:exact_entity_requires_live_observation` at the copper-bootstrap
collection step. This run does **not** demonstrate the new mining self-correction:
there were no residual-gather or nearby-coordinate correction events.

One owner-authorized cold trial; no corrective gameplay prompts, manual resumes,
provider retries, second trial, push or deployment. Cheaper `gpt-6-luna` overwatch
reviewed source/evidence and observed host logs only. Its final review is retained
in [overwatch observations](../../test-results/red-automation-live-2026-10-23as/overwatch/observations.md).

## Frozen source and contract

Local candidate `cdbc95eda101e6c2f559c0e2848bcaa923df1be6`; published Jev
`b9574fc4556eafb431f158ebee80fe3f1807a02d` freshly verified online before testing.
Task branch `test/run-as-red-automation`, owned by Codex /root chat01a16ab4. The
integration checkout remained read-only throughout the trial.

Factorio **2.0.77**, actor **12**, seed **1495202104**, goal **goal_0cfa0th_1**.
Before the declared one-time vanilla starter, the board/inventory/machines were
empty, native queues idle, zero humans, speed 1× and zero provider/Jev requests.
Starter: eight iron plates, one burner drill, one furnace, pistol and ammunition.
The unchanged acceptance goal was automatic production of at least one science
pack per game minute from natural resources, with a 60-minute construction cap.
The required topology review and separate sustained-output measurement were not
entered.

The run selected the already validated **accelerated** profile: harness-only
bursts up to 4×, 600 ticks/3 wall seconds per burst and 3,600 charged ticks per
episode, with native guard, host watchdog and 1× observation/admission barriers.
This is an accelerated result, separate from normal-speed baselines.

All 71 installer-enumerated runtime modules, prompt and 32 native files matched
the candidate; native files were independently compiled for comparison. Effective
CLI-proxy roles were planner `gpt-6.1-sol`, executor `gpt-6-luna`, with the dedicated
Jev configuration and required role catalogs. Payload ref `b982ba96`, SHA-256
`31be67220bbf0a7e6f6f836780b8a9f41652c5f3f6954a50c71144c83514857f`.

Pretrial gates: 3,302 runtime / 1,378 mod tests, typecheck, Lua/generated-Lua,
payload 9, helper 45, response recorder 1 and archive 10 all passed. The official
build initially failed when the default release lookup returned an unsupported
Factorio version; it succeeded with explicit 2.0.77 before any inference. No
candidate source or live control was changed. Fifty-two helper inputs stayed frozen.

## Actual plan and terminal failure

The retained Roadmap Shelf contains copper bootstrap, iron bootstrap, science
access, steam electricity, automation research, automatic fuel, automatic iron,
automatic copper, automatic gears and continuous science. Only the copper-bootstrap
slice was committed: plan `goal_0cfa0th_1_p3`, version 1.

1. Acquire 10 coal — verified complete.
2. Acquire 10 copper ore — verified complete.
3. Place the held furnace and obtain its identity — verified complete.
4. Smelt/collect 10 copper plates and verify electronics researched — incomplete.

The furnace at **(55,63)**, native unit **19**, physically finished 10 copper plates;
they remained in its output. After context transitions, attempts to use that exact
unit in `supply_entity` were refused because it lacked a live binding in the active
request. Targeted observation requests also received `entity_not_grounded`.
At 23:14:32.380Z the first exact-entity rejection instructed fresh observation;
at 23:15:06.969Z the repeated unit was rejected with `deterministic_no_retry:true`.
The guard paused at 23:15:07.170Z. The external runner classified the terminal
pause and submitted strict stop at 23:16:00.616Z.

The guard preserved exact-entity authority; the runtime did not renew the binding
and continue automatically. This is a separate live-binding recovery gap, rather
than a replay of AR's coal `mining_rejected`/partial-batch failure. Its complete
causal implementation path still needs a focused regression investigation.

[Complete actual plans and issued planner material](../../test-results/red-automation-live-2026-10-23as/analysis/plans.md),
[canonical goal/shelf/plan/contracts/history](../../test-results/red-automation-live-2026-10-23as/analysis/canonical-plans.json),
[all original responses](../../test-results/red-automation-live-2026-10-23as/analysis/full-issued-responses.json)
and [provenance](../../test-results/red-automation-live-2026-10-23as/analysis/plan-provenance.json)
preserve descriptions, guidance, contracts, outcomes, IDs, timestamps and prompt/
observation references. Rejected drafts are labelled separately. All 22 responses
were captured completely; no original request bodies are missing and the recorder
reported zero errors. No private reasoning was requested or reconstructed.

## Recovery and tool metrics

[Machine metrics](../../test-results/red-automation-live-2026-10-23as/analysis/metrics.json)
group episodes by mechanism, reason and active plan/step. Eight validation/
observation retry episodes: **5 control continuations, 3 failed**, none unresolved.
A control continuation means subsequent admitted work or a native/condition wake;
it does not mean that the gameplay blocker or goal was repaired.

| Retry reason | Attempted | Continued | Failed |
| --- | ---: | ---: | ---: |
| requirements_grounding | 1 | 1 | 0 |
| duplicate_observation | 2 | 1 | 1 |
| invalid_production_task | 1 | 1 | 0 |
| observation_request_refused | 2 | 2 | 0 |
| exact_entity_requires_live_observation | 2 | 0 | 2 |

Automatic resumes **0**; planner-review requests/rounds **0**; context restages **2**,
counted separately. The single `recovery.routed` event is routing detail, not another
recovery. Operator gameplay recovery **0**; terminal strict stop is separate.
New harness partial-gather recoveries **0**, nearby mining corrections **0**, native
occluded-resource exact-selection recoveries **0**. Mining completed normally; none
of those specific failure paths was exercised. Their deterministic repair proofs
remain separate from this live result.

| Observation tool | Calls/results | Success | Failure/refusal | Cached | Mean ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| getRecipeDetails | 4/4 | 4 | 0 | 1 | 327.25 |
| getResearchPath | 1/1 | 1 | 0 | 0 | 485 |
| getMiningDetails | 1/1 | 1 | 0 | 0 | 476 |
| getTechnology | 2/2 | 2 | 0 | 1 | 263.5 |
| getPrototypeDetails | 1/1 | 1 | 0 | 0 | 324 |
| getEntityStatus | 1/1 | 1 | 0 | 0 | 192 |
| getInventoryItems | 1/1 | 1 | 0 | 0 | 191 |

Targeted control-read refusals are retained in recovery/proposal events; they are
not fabricated successful tool executions. Native execution/coalescing totals for
observation tools are unavailable; cache flags alone cannot prove native execution.
Structured submission calls are listed separately in metrics.

Native mutation channel: **7 admitted/acknowledged/completed batches**, **8 operations**:
gather 4, placement 1, supply 1, wait 1, walking 1. Thirteen native task entries
completed: walking 5, mining 4, placement 1, moving-items 2 and waiting 1. A tool
submission, operation, task segment and completed batch are distinct counters.
Native production statistics show 20 coal and 20 copper ore mined and 10 copper
plates smelted; this finite, hand-fed bootstrap is not automated science production.

## Model usage, time and price completeness

Trial objective boundary: **23:08:29.909Z–23:16:00.616Z**, **450.707 seconds**.
Runner elapsed was 451.124 seconds, including its earlier entry. All dates are
October 23, 2026; event times here are UTC for trace correlation.

| Provider/model/role | Requests/responses | Input | Cached input | Uncached input | Output | Reasoning tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CLI proxy / gpt-6.1-sol / planner | 7/7 | 167,576 | 49,664 | 117,912 | 6,232 | 2,203 |
| CLI proxy / gpt-6-luna / executor | 15/15 | 442,448 | 257,920 | 184,528 | 4,519 | 2,998 |
| TypeSafe / jev-1.14.0 / semantic routing | 24/24 | unavailable | unavailable | unavailable | unavailable | unavailable |

CLI usage is complete for 22 calls: **610,024 input, 307,584 cached input, 302,440
uncached input, 10,751 output**, including 5,201 reasoning tokens. Do not add
reasoning tokens again to billed output. There were zero provider failures,
cancellations, transport retries or fallbacks, and no provider/Jev requests after
either stop submission or confirmation. Repeated model validation turns are
counted in the 22 requests and separately in recovery metrics.

Jev made 24 deduplicated request/response exchanges, zero failures/fallbacks.
Twenty-two responses exposed partial usage fields totaling 72,046 input units and
5,122 output units; these are not asserted to be complete token counts. Missing
usage and runtime-default zero cost fields do not establish free billing.

| Duration view | Total s | Mean s | Range s |
| --- | ---: | ---: | --- |
| Planner requests | 170.640 | 24.377 | 2.982–84.773 |
| Executor requests | 127.670 | 8.511 | 2.267–20.982 |
| Jev requests | 4.562 | 0.190 | 0.122–0.310 |
| Native mining segments | 47.272 | 11.818 | 6.734–20.177 |
| Native navigation segments | 16.281 | 3.256 | 0.031–11.553 |
| Native item transfers | 0.016 | 0.008 | 0.003–0.013 |
| Native placement | 0.006 | 0.006 | 0.006 |
| Native waiting segment | 3.290 | 3.290 | 3.290 |

Tool batch-envelope union was 1.093s. Build/setup orchestration span was 253.783s
(includes failed default-version build and gaps), preflight 34.795s, and stop/save/
cleanup 19.440s. The raw PowerShell duration subtraction had a timezone error;
derived metrics use the explicit retained UTC start/end timestamps without editing
the sealed artifact. Provider, Jev, world, retry and tool intervals can overlap;
these are not an additive wall-time partition. Recovery durations and unions are
in metrics. Exclusive waiting/production durations are unavailable. Measured
thinking duration is **unavailable**; request latency includes generation, queueing
and network time.

All 46 provider/Jev requests are **unpriced**, currency USD. As of October 23,
no verified alias-specific public rate mapping or billing evidence was available
for this report; per-role rates, sources, estimated totals and actual charges are
unknown, rather than zero. Jev usage is partial. Any future token-price equivalent
must apply separate cached/uncached rates and avoid double-counting reasoning;
CLI subscription incremental charge is a separate question. Author/overwatch Codex
token usage and cost are unavailable and excluded from NPC totals; quota percentages
are not monetary cost. Overwatch used `gpt-6-luna` and ended with the trial.

## Acceleration, strict stop and preservation

Nineteen native sprint starts/restorations, **3,485 actual sprint ticks**, 15.246s
measured native sprint wall time, 3,486 guard checks. The 42.837s saving against
the ticks' 1× equivalent is an estimate, not a measured normal-speed comparison or
end-to-end performance claim. Harness polling/refusals and leases are retained in
[acceleration metrics](../../test-results/red-automation-live-2026-10-23as/analysis/acceleration-metrics.json).

One `sprint.fault`, `Sprint construction authority closed`, occurred at
**23:16:00.917Z**, between stop submission and confirmation. It was a stop-boundary
control alarm, not a fault-free run or the cause of the earlier gameplay guard.
There were no such faults after confirmation and no inference after stop.

Fresh supervisor cancellation plus the same-goal operator-pause receipt confirmed
at **23:16:00.946Z** (330ms), with speed 1×, native idle and empty operation/crafting
queues. The post-boundary save is **840,870 bytes**, full ZIP integrity **55 entries**,
SHA-256 `f307a5cec61671093f971b4ff57216a0cd03c25c55b95472f76f2f13c0a51b7f`.
A pristine copy loaded under 2.0.77 with all 32 active native files matching.

Cleanup removed the exact owned Compose stack/network, disposable resources,
tunnel, response recorder/listeners and unique run image tag. The temporary
configuration hard link was removed; shared configuration and cached images were
retained. No background work remains.

Raw evidence: `test-results/red-automation-live-2026-10-23as/`, **222 files**,
14,147,546 bytes, manifest SHA-256
`2798d5d78e9009e21c53105522102459bdc12d663e89be9dffd55acdc10cdf2c`.
[Final machine closeout](../../test-results/red-automation-live-2026-10-23as/analysis/final-summary.json)
and [cleanup verification](../../test-results/red-automation-live-2026-10-23as/analysis/cleanup-final.json)
confirm all five recorded container IDs and three static-script names absent,
along with the run prefix/project resources. All 222 raw files, 52 frozen inputs,
216 historical AR files and five protected integration reports rehashed unchanged.
Derived analysis and overwatch live outside that seal. The behavior checker reports
`blocked_before_mutation`; it does not report an unresolved gather. Historical AR
evidence was not edited. This trial preserves the next failure for a focused
harness repair; safe refusal and successful mining do not establish general
self-correction or autonomous production success.
