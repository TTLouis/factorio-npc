# Luna with Jev — October 6, 2026 (Toronto)

Result: **Jev admitted the goal and Luna genuinely mined ten copper ore, then the run stopped after confusing a completed plan slice with the unfinished user goal.** Red science and green research were not reached. UTC timestamps below match the retained logs.

## Configuration and assistance

The owner explicitly requested this retry with the Jev token in `.env`. The preceding trial disabled Jev through an operator-selected overlay; that was not a missing token or a Jev context failure. This retry requires `JEV_TYPESAFE_API_KEY` through Compose and maps it to the runtime's `TYPESAFE_API_KEY`. Configuration was verified in the container as enabled, with `jev-latest` at the configured TypeSafe endpoint; responses identified `jev-1.13.0`. No credentials were read from `.env`, printed, copied into scripts, or rewritten.

Main model: `gpt-6-luna` through the same owner-selected CLI proxy, local API method. The exact objective was unchanged from the preceding intake trial. Bounds: 45 minutes, 60 main-provider calls, 120 Jev requests. The operator did not send corrective prompts, manually replay providers, resume/reopen the goal, or perform gameplay operations after the declared starter kit.

Candidate `1eb6172f75089d89122b101cd56aaccbeafafcd3`. The source HEAD and image were unchanged, so the preceding successful offline gates and full build were reused: 1,749 runtime tests, three TODO, 1,030 mod tests, typecheck, Lua build/generated-Lua check and nine installer tests. Image ID `sha256:60a28e9f8211b8a4a59fa951636826f5c80be6b951f4286eaafa6f96fe4d9d38`; the preceding deployment check matched all 39 top-level non-test runtime modules to committed source and the active mod to the compiled release. No production source was changed for this retry.

Separate project `luna-jev-autonomy-20261006`, fresh ignored data at `test-results/luna-jev-autonomy-2026-10-06/data/`, Factorio 2.0.77, natural default-generated seed 2103768926, actor 14, zero connected humans, speed 1. Before setup: empty NPC inventory, no board, no built production machines and green unresearched. One vanilla starter kit: eight iron plates, one burner mining drill, one stone furnace, a pistol and ten magazines. RCON published only at `127.0.0.1:27019`. Other stacks and earlier saves were untouched. The different natural seed means this is a fresh retry, not a controlled same-world counterfactual.

## What worked

- At `08:08:41`, Jev returned `new_goal` with reported confidence 0.98. The runtime applied Jev's route directly (`language_router_called: false`), bypassing the Luna classifier that rejected the preceding trial.
- A new goal `goal_1gdv7y2_1` and request `req_muwed21u_1` were admitted. Luna eventually defined the long-horizon goal with `doneWhen: research_completed(logistic-science-pack)` after ordinary harness validation supplied missing goal-definition and live prerequisite facts.
- Luna submitted a roadmap and a one-step plan: “Gather copper ore for the electronics trigger.” It chose `gather_resource(copper-ore, 10, search_radius=256)`.
- Native batch 1 walked to the resource and mined ten copper ore, completing at tick 5794. Actor 14's observed inventory contained those ten ore. No smelting or crafting happened.
- After a fresh inventory read, Luna semantically closed the gathering step. The harness evaluated the actual user goal at `08:10:15.121Z`: **0/1 goal conditions met**, green research false.

All nine retained Jev requests have a matching exchange and response event; no decision fallback/error event was recorded. That establishes successful calls and routing, not the correctness of every advisory judgment. Active contracts covered intake, goal/planning shape, boundary steering and the post-step gate/shape; four further calls were shadow skill/observation/shelf judgments.

## Where it stopped

The slice-close continuation explicitly told Luna:

> The current immutable plan slice is verified complete. The user goal remains active. The game reports 0/1 goal conditions met.

The same captured packet also contained:

| Record | Status |
|---|---|
| Canonical `PLANNING_STATE.goal` | `active`, green-research condition still required |
| Canonical Plan Tracker | `COMPLETED` for the one-step copper-gathering slice |
| Legacy `RUNTIME_COMPAT_STATE` and its board | `completed` |

At `08:10:18.524Z`, Luna returned `plan: []`, `operations: []`, saying the tracker had completed the goal and it could not safely continue until reopened. This contradicted the explicit active-goal continuation. The model did not claim green research had succeeded, but it declined to plan the next work.

At `08:10:18.569Z`, the runtime emitted `request.completed` with `outcome: no_operations` and a completed legacy task board. Persisted canonical state subsequently had `goal: null`, no roadmap and no plans. `task_ledger.refused: nothing_to_resume` followed. Further read-only observations through `08:12:11` showed no resumed work.

Source inspection identifies a concrete completion-boundary defect: `supervisor.mjs:1569` treats either `result.goalStatus === 'completed'` **or** `result.taskBoard.status === 'completed'` as sufficient to finalize the entire task. `finalizeCompletedTaskBoundary` then calls `finalizeCompletedTaskContext`, whose `clearTaskContext` drops canonical planning state. A completed slice's legacy board can therefore clear a still-active user goal after the model returns no next work. The live capture shows this exact distinction: canonical goal active immediately before the reply, legacy board completed, then canonical goal absent.

A separate semantic gap was also exposed: the roadmap node “Complete electronics trigger” was marked `realized` after its linked plan merely gathered copper ore. The trigger requires ten copper plates, and no furnace or smelting existed. Plan-step completion was treated as realization of a broader shelf intent without evidence of that intent. Luna authored the undersized refinement; runtime node bookkeeping promoted it. This was not a Jev-authorized world completion.

Next fixes should preserve the canonical active goal whenever `doneWhen` remains unmet, keep slice completion separate from whole-task finalization, and handle an empty slice-close continuation as a bounded retry/pause rather than deleting the goal. Add a deterministic recorded case from this packet/reply/receipt sequence. Separately verify shelf realization against the intended result instead of assuming every linked completed slice achieves it. Do not repair this world by granting research, replacing the planner's actions with a walkthrough, or claiming ore collection is electronics completion.

## Final physical result and retained evidence

Last observation, tick 14920: actor 14 at approximately (47.06,-43.35), zero humans, speed 1, ten copper ore plus the original construction supplies, no furnaces/labs/power machines placed, zero red packs crafted and consumed, red recipe disabled, green technology unresearched and green recipe disabled.

Eight Luna requests and eight usage-complete responses: 173,787 input units, including 113,664 cached; 1,648 output units, including 722 reasoning; 175,435 total. Nine Jev requests/exchanges/responses, zero fallback events. Reported units are not billed dollars; Jev billing was not established from these logs.

The container was stopped cleanly (exit 0) at `08:12:16.419Z`. Saved world: `data/saves/luna-jev-autonomy-fresh.zip`, 654,941 bytes, SHA256 `05ab23b851a3b17353b89ffe64e3678ff581b9474c356c90feacc1f69960b949`. Stopping the container terminated the observation process with exit 137; that is cleanup, not a Factorio or provider crash.

Offline `run-check` exited 0 over two request buckets / 108 rows, with no parse errors or listed findings. It did not detect this semantic lifecycle failure, and is not evidence of successful goal completion.

Ignored evidence under `test-results/luna-jev-autonomy-2026-10-06/`: overlay, observer, observation log, `provider-usage-summary.json`, `handoff-summary.json`, `run-check.json`, before/periodic/final world state, persisted NPC state, native behavior/prompt/decision logs and saved world. Source/document diffs passed `git diff --check`; only validation/status documentation was changed in the tracked tree.

Retention update, October 6: the owner subsequently requested cleanup. This trial's container and temporary viewing container were removed, and its saved world and duplicate server logs were deleted. Captured behavior, prompt, decision, observation and result logs remain at their original paths. The saved-world hash above records the test-end artifact; the artifact is no longer retained.
