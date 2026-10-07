# Luna + Jev audit-candidate live trial — October 7, 2026

## Outcome

The owner authorized one fresh E2E on pushed candidate `3278c4b19f45609da3f0f144af27eb09ff88b4bb`. Autonomous red-to-green acceptance failed: the controller paused before any gameplay batch. Native red production/consumption remained zero; `logistic-science-pack` research and its recipe remained false. The canonical goal stayed active and the board paused truthfully at 0/3.

The trial started at 03:43:01 Toronto (`2026-10-07T07:43:01.821Z`), lasted 60.229 seconds, and used seven Luna calls and five Jev requests/responses. The request itself finished after 42.060 seconds. There were zero operator gameplay actions after the declared starter, corrective operator prompts, external provider retries, connected humans, speed changes or actor replacements. No production deployment or additional trial occurred.

## Candidate and preflight

- The exact candidate was clean and pushed. Its prior gates passed 1,846 runtime tests, 1,036 mod tests, typechecks, generated Lua, full build, nine payload checks and deterministic native research/resilience scenarios.
- Proxy root and authenticated model list returned HTTP 200 from Docker over the owner's Tailscale endpoint. `gpt-6-luna` was available and the dedicated Jev token was present. Credentials were supplied opaquely by Docker's env-file handling; `.env` was unchanged.
- Built through `scripts/build-docker-local.ps1 -NoEnvUpdate`, pinned to Factorio 2.0.77. All 41 deployed runtime modules matched hashes from `git show HEAD`; active mod control bytes matched the compiled release (`d9434a7652c9c9cee836d06b96e17065c77d9805be2b479cf31b259ed23c8f17`). No supervisor-only overlay was used.
- Removed the previous stopped trial container. Used a separate initially empty data directory and new map seed `3673305575`, standalone actor 3, epoch 2, speed 1 and zero humans. Before objective ingress: inventory empty, no machines, no board and no red/green unlocks. The UDP mapping was corrected before objective ingress; RCON remained loopback-only. The pre-objective container recreation did not resume any previous goal or gameplay trial.
- Used the existing starter: eight iron plates, one burner mining drill, one stone furnace, one pistol and ten magazines. One raw `!luna` objective requested native red production and green research, allowing hand crafting and hand-fed machines.
- Retained the 45-minute wall bound. Per the owner's earlier instruction there was no old 60/120 trial call-count stop; existing admission/recovery guards, supported 1,200/hour provider rate guards and 100,000-unit output allowance remained. None was exhausted.

## Captured failure sequence

1. Intake created canonical goal `goal_088r72h_1`. Luna observed actor/inventory and the exact native research path: ten copper plates for electronics, fifty iron plates for steam power, a lab trigger for automation science, then 75 red packs through native lab research for logistic science.
2. The harness's requirements-grounding correction supplied those authoritative dependencies before commitment. Luna then committed plan `goal_088r72h_1_p3` with no operations and three semantic completion declarations: complete electronics/steam-power triggers, complete automation-science trigger, research logistic science. The first rationale claimed no deterministic checkpoint could establish both prerequisite technologies. All three persisted steps were assessments, with no deterministic contracts.
3. C3 delegated to fresh executor `ho_1fbdb58d3af9` and explicitly restored four bounded observations (`context.executor_observation_started`). The executor successfully read electronics, steam power and research status. This confirms the earlier research-fact/zero-observation handoff defect did not recur in its previous form.
4. Luna's executor submitted gathering ten copper ore with search radius 4096. It also supplied deterministic `research_completed` requirements for the same descriptions. Those new declarations conflicted with the already committed semantic contracts; an executor reply cannot silently rewrite them. The harness rejected the mutation with `semantic_step_cannot_mutate`. No operation reached admission or gameplay.
5. Luna requested inventory, consumed the last observation, then returned a BLOCKED reply saying it could not confirm a copper source with observations closed. The packet explicitly told it that `gather_resource` finds its own target and does not need a prior resource lookup. No resource lookup established an actual world obstruction.
6. Outcome authority rejected `world_blocked_without_authoritative_evidence`, classified the reply as `recoverable_provider_failure:provider_reported_blocker`, and paused the board while retaining the active canonical goal. No false completion, goal retirement or shelf realization occurred.

This is evidence of a planner/executor contract mismatch, with correct refusal at mutation admission. It does not prove the map lacked copper, that the proxy stalled, or that Luna would finish after repairing this mismatch. Jev's observation-family judgment was shadow-only and did not authorize or advance the plan.

## Next bounded repair

Replay the retained failure without changing its outcome. Improve the planning contract and its structured correction so world-progress work is declared deterministically before commitment; retain legitimate semantic assessment steps and do not infer predicates from prose. The executor must honor frozen contracts. If an assessment reveals required world work, route that need through the existing authorized planner/successor boundary rather than accepting an inline contract rewrite or coercing operations into the current step. Prove both rejection and corrected continuation with scripted replies before another fresh live run.

Also cover redundant observation use and the log-checker's missing diagnostic: it returned zero findings over 85 rows with no parse errors despite this captured failure. That result is a detector coverage limit, not autonomous success.

## Evidence, usage and cleanup

Ignored evidence root: `test-results/luna-audit-live-2026-10-07/`. It contains the build and exact run scripts, committed hash list, deployment report, before/final snapshots, objective/starter contract, behavior/prompt/decision traces, persisted state and budget snapshots, retained control replies, server log, checker output, provider-usage summary and cleanup report. The first offline checker invocation had an incomplete import mount; its error is retained separately. The complete verified test-image invocation exited 0 with no findings.

Luna reported 146,483 input units, including 93,696 cached, plus 1,513 output units: 147,996 total. All seven responses returned normally. The terminal Jev health summary covers three contracts; the full decision trace records five requests and five responses.

The owner extended this phase's budget to five weekly percentage points from the 14% starting snapshot. Closeout reads 15%, a one-point account-wide increase shared with another active agent; this is not per-task billing.

The server stopped cleanly (exit 0), and its container/network were removed after capture. Four current/previous trial save files were discarded as requested. Logs, contracts and state remain; no stalled world is retained. The evidence manifest hashes captured files. Multiplayer reliability and autonomous science acceptance remain open.
