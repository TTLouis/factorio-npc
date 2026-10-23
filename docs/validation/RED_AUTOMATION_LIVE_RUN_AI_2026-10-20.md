# Run AI — repeated passive pump wait fix and autonomous E2E

**The repeated passive pump wait fix is published on Jev. The factory E2E failed at an unrelated stone-mining/recovery guard.** No pump or passive wait occurred in this trial, so live exercise of the fixed path is not claimed. Its direct proof is seven original-source failures versus passing regression fixtures.

Frozen candidate: `eab66b13712cc6bcf3c7c45344fd03e6d7e0879c`, published to `experiment/jev-agent-architecture`. Unit `ef0f79c4976356bb46cd6e64bc92bccbbc09b859`; separate payload repin `fa970bbfab3bc7a7e40b3c9be30cb5f8d1747d63`; original source `2a90c8e07219d7c624114d64b2dcf3a22a4d0075`. Stable main and other owners' unpublished placement/water changes were excluded.

## Fix and checks

Run AH spent 900 checks waiting on a working offshore pump while its boiler and engine remained held, then registered the same wait again after timeout. A working flag supplies no finite production expectation. The shared passive-wait registration path now requires a fresh exact-machine read with a native recipe, positive craft duration and finite positive seconds until idle. Both zero-operation fallback and wait-only conversion use the guard. Missing proof emits request-correlated `runtime.passive_wait_declined` with `no_finite_native_production_expectation`, returning concrete facts to existing bounded act-or-block/review handling. Saved active waits missing the proof wake at the first poll with `passive_progress_not_measurable`, without completing a step.

Fresh reads are fenced by actor/epoch, goal/step, generation and canonical step version. Wait-only reuse carries scope captured before its read. Exact output-completion waits and productive finite-ETA furnace waits retain their existing semantics. No pump name list, model judgment, allowance reset, native gameplay shortcut or timeout-policy change was introduced.

Seven selected integration regressions fail on original runtime source (zero pass) and pass with the fix. Fixtures cover first/repeated pump conversion, full zero-operation bounded repair, saved legacy wake and asynchronous actor/step/generation/version replacement. Separate ETA tests reject malformed native production estimates. A separate strong reviewer approved the final diff and pre-read scope fence.

| Gate before the objective | Result |
| --- | --- |
| Candidate and merged standard Docker gate | 2,833 runtime / 1,249 mod tests; typecheck, Lua build and generated-Lua check passed |
| Changed-file ESLint / whitespace | Zero diagnostics; passed |
| Installer generation/check/tests | 9/9 passed; separate repin |
| Exact-head [CI 39508113940](https://github.com/TTLouis/factorio-npc/actions/runs/39508113940) | All seven jobs passed; deterministic native job 7m29s |
| Exact-head [CodeQL](https://github.com/TTLouis/factorio-npc/actions/runs/39508114018) / [package smoke](https://github.com/TTLouis/factorio-npc/actions/runs/39508113931) | Passed; conditional non-applicable jobs skipped |
| Run helper checks | 44 helper tests, 10 archive tests and cleanup-inventory checks passed; 46 helper hashes frozen |
| Deployed identity | 57 installer-enumerated modules, prompt/release manifest and 31 independently compiled native files matched the candidate |

## One live trial

Owner authorized one run after checks. Official local builder used committed/pushed source with `-NoEnvUpdate`, Factorio 2.0.77. Cold actor **19**, seed **3244327878**, goal **goal_1buwufp_1**. Zero humans, speed 1, empty inventory/board and zero machines before the approved starter (8 iron plates, burner drill, furnace, pistol/ammunition). One raw objective: build a fully automated factory producing at least one automation-science-pack per game minute from natural resources. No corrective prompts, manual resumes or gameplay actions after the starter.

A cheaper `gpt-6-luna` subagent provided periodic read-only overwatch from host evidence, with durable notes and internal updates. It controlled no gameplay, providers or Docker resources.

Prelaunch attempts made zero inference calls. Local Tailscale reported valid `NoState`, so the scoped helper used the already configured SSH host with the same key/port, strict known-host checking and loopback-only forwarding. No remote configuration or service restart occurred. A subsequent native-RCON startup race was cleaned up and archived before the goal; the final startup waited for the native TCP listener and then passed all cold/provider catalog/deployment checks. These preparation attempts were not additional gameplay trials.

Result: `controller_paused:guard`, **1,532,770 ms (25.54617 minutes)**, classified at **23:06:59 UTC**. The global goal stayed **active**; plan **p4 EXECUTING**, third of eight steps: “Gather 5 stone for a temporary copper furnace that will later become the boiler.” No automated science chain, topology-review candidate or rate measurement was reached.

Native production totals were **138 iron plates**, **10 copper plates**, 211 iron ore, 17 copper ore, 74 coal and **zero automation-science-packs produced/consumed**. The placed machines were burner drill 37 and iron furnace 38, feeding directly. The actor remained 19 with zero humans and speed 1. Stationary actor/inventory intervals included real machine production; they are not evidence of a runtime stall.

The run verified six semantic steps and declined eleven closes (six target-unmet, five lacking authoritative operation receipt). Plan slice p3 completed, the explicit goal evaluation returned `satisfied=false`/zero of one condition, and planning continued into p4. There was no global goal-completion claim. The lifecycle scan's legacy `goal=completed` label at slice close refers to that slice projection, not canonical global-goal completion.

There were zero passive-condition events, zero `runtime.passive_wait_declined`, and no pump. Three separate ordinary `wait.blind_with_fresh_read` events reported `no_machine_known` (22:46:03, 22:53:40 and 22:57:30 UTC). They used bounded native waiting and did not exercise the new passive admission guard. No repeated pump wait recurred, but this trial ended before building the steam system, so that absence is limited evidence.

## New E2E blocker

At **23:05:38.223 UTC**, native status reported stone-mining batch **18** cancelled with `mining:mining_rejected`; basic operation 22 was `accepted=false`, `completed=false`, `entity_name=stone`, requested count 5. The operation ledger reconciled this to `admitted_cancelled` / `partial_unknown`, `settled=false`. At **23:06:04.370**, the next proposed world mutation was refused as `unresolved_operation_scope_conflict`. At **23:06:12.034**, recovery failed nonrecoverably: **“Review requires the exact active step and an idle safe point with no unsettled operation.”** The controller then paused with class `guard`. Native queue idle alone did not settle the ledger's uncertain effect. The trace also records observation-no-progress pressure (three observation-only rounds, targeted allowance one). This establishes the cancellation/recovery sequence; it does not establish the underlying reason the engine rejected mining. No manual resume, further fix or second trial was performed.

Whole-run prompt trace totals: **55 provider requests / 55 responses / zero errors** (14 Sol planner, 41 Luna executor). Jev: **49 requests / exchanges / parsed responses**, zero errors. The request's narrower Jev-health summary is 38/38 with zero fallbacks, a different scope. No automatic resumes and no inference requests after strict stop submission.

Combined traces contain **1,051 behavior / 195 prompt / 165 decision rows**, zero malformed. Context-reference check: 55 requests, zero parse errors/findings. All four configured lifecycle flags are zero. `run-check` remains red with two findings: tracker behind completed batch 17 while stone step 3 remained unverified, and the unrecoverable request failure above. A previous batch's successful action receipt does not prove the stone inventory contract. Restage analysis covered five of six swaps (one lacked an after snapshot), zero blocker-after-swap findings. These diagnostics do not make the gameplay result pass.

## Stop, save, cleanup and evidence

Fresh cancellation and same-goal operator-pause receipts were confirmed at **23:06:59.717 UTC**, after stop submission at **23:06:59.370**. The runner saved only after strict stop/native idle. Fresh checkpoint: **912,662 bytes**, **56 ZIP entries**, split native level chunks 0/1; full ZIP integrity and pristine **Factorio 2.0.77** native load passed with the exact 31 active native files. Source and pristine-copy hashes match: `e346cc436a60703078891e6bc8418188c805286a871508c9a12c5daa9767f3d3`.

Wrapper finished **23:07:11 UTC**, `failed=false`, Compose down exit 0; this means preservation/cleanup succeeded, not that the factory succeeded. Parent independently verified teardown at **23:08:12 UTC**, including stopped owned containers, project networks/volumes, unique run image tag and SSH PID 20056. The task-only ignored configuration hard link was removed; shared `factorio-npc:local` retained. The cheaper overwatch agent finished its final report and stopped. Weekly allowance stayed 91% remaining during the trial, above the 7% live-stop / 5% reserve policy. No external background work remains.

Evidence includes `analysis/acceptance-proof.json`, all analyzer outputs, final-save/native-load proof, independent parent cleanup proof, and `overwatch/summary.md`. Final report review and evidence seals are recorded in the shared worktree registry outside the sealed evidence trees.

Evidence: task-local `test-results/red-automation-live-2026-10-20ai/`; static and original-source controls in `test-results/repeated-pump-wait/`. Historical AH/static/AG/preparation/AF archives (1,475 files across five seals) were verified unchanged before launch. Five protected integration reports were preserved. No Pterodactyl deployment or second gameplay trial was authorized.
