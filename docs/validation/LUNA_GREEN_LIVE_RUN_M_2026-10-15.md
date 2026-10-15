# CLI-proxy Run M: Sol/Luna delegation worked; shoreline recovery exhausted

One owner-authorized trial after the reviewed [Unit 21 recovery fix and full-loop gates](UNIT21_RUN_L_DELEGATION_RECOVERY_2026-10-15.md). The isolated stack is down. This checkpoint does not authorize another provider run.

## Frozen deployment

- Pushed source **`517fcdc1955c76d2f8fad235d7e5663deaf10d71`**, reviewed code/tests `b9d25643`, no-ff integration `c07f506a`. Frozen and merged gates: **2,373 runtime/staging, 1,142 mod tests**, typecheck/Lua checks; all seven frozen native lanes pass.
- Server image **`sha256:6292a51a1d8be0aeff35c6f31a449eff7675547291fd194142f9ec70416cf8b7`**, built from clean pushed source with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All **50 runtime/staging modules**, prompt and manifest match; all **31 active mod files** match the release and the passing native image. No runtime overlay.
- Process/ignored-overlay model selection: **`gpt-6.1-sol` planner, `gpt-6-luna` executor**, existing local CLI-proxy transport and dedicated Jev. The production role resolver was checked before submission. `.env` was not read or edited; endpoint and credentials remain private.
- Fresh seed **904933658**, standalone actor **16**, goal **`goal_1cubhys_1`**, initial request **`req_mv9g5v9o_1`**. Zero humans, speed 1, empty initial inventory/board and no prebuilt machines. Same one-time starter: drill 1, furnace 1, iron plates 8, pistol 1 and ammo 10.
- One raw-chat objective: unlock `logistic-science-pack` through native red production and lab research. No duration cutoff, operator gameplay or corrective prompts after starter. Existing limits and six goal-level auto-resumes remain unchanged. Driver observes every 90 seconds and preserves rotated trace rows. Offline completion-proof tests pass.

## Result and live delegation

**11:20:04.935–12:00:41.637 UTC**, **40m36.702s**. Stop: **`auto_resume_exhausted`**. The final controller event at **11:59:13.921 UTC** is `recovery.auto_resume_exhausted`, reason `goal_limit_reached`, goal **6/6**, current-step **1/2**. Polling detected it afterward. No additional run or operator retry.

**141 main-provider requests / 141 responses / 0 provider errors**: **7 Sol, 134 Luna**. Jev **91 requests, 90 successful responses, one fallback**: `planning_boundary_steering` returned HTTP 499 at a completed-plan boundary; the existing runtime default applied without automatic retry. Weekly usage was **91% remaining** at the lab milestone, above the 50% stop floor; no reset credit used.

The role-specific traces establish real delegation, beyond configuration alone: Sol returned structured tool calls, C3 created executor contexts and parked the planner on three plan commitments, and all 134 Luna responses carry executor attribution. Sol ran again at subsequent slice boundaries. After recovery discarded the parked context, C2 explicitly used `planner_fresh_at_slice_close_no_parked_context`; this is a fresh planner return, not proof of resuming the original parked conversation. There are 12 total restages, including six auto-resumes and one fresh-context action-omission recovery.

Native progress: copper and iron smelting, electronics/steam-power slice closure, gears/belts/circuits, a real **lab**, **offshore pump**, **boiler** and **steam engine** crafted. Red science recipe unlocked. Final held items include those four machines, coal 6, iron ore 20, copper ore 45, iron plates 4 and copper plates 5. Only the furnace was placed; no connected power chain or powered lab. **Red produced 0, red consumed 0, green researched/enabled false.** The user goal did not complete, and automation remains unproved.

Neither Unit 21 rejection event fired live. Its invalid-reference and checkpoint-scope fixes are established by original-code red replay and passing static/native full-loop tests; this trial did not exercise their failure conditions. Earlier pauses concerned stale/missing observations and unsupported blockers. Auto-resumes sometimes made native progress, including clearing copper output to permit iron smelting, but repeatedly spent the shared goal allowance.

## Terminal boundary and next local regression

Final request **`recovery_mv9hjabz`**, committed power-plan step **`goal_1cubhys_1_p5_v1_s2_1t8bovc`**:

1. `getFluidSourceTiles(water,128)` returned no samples with complete generated coverage and `empty_result_is_conclusive:true`. That is bounded local absence, not a global impossibility.
2. `getPlacementCandidates(offshore-pump,24)` returned zero legal candidates around the actor.
3. After three observation-only rounds, decision pressure allowed one targeted observation. The radius-256 water query returned **182 generated / 107 ungenerated chunks**, no samples, **`coverage_complete:false`, `scan_truncated:true`, `empty_result_is_conclusive:false`**, and concrete ungenerated chunk centers. Tools then closed under the existing observation budget.
4. Luna reported that it could not safely build without a viable water source, rather than choosing bounded exploration. Outcome authority rejected `world_blocked` as `world_blocked_without_authoritative_evidence`; the unverified-blocker recovery and goal auto-resume allowance exhausted. The world was not proven impossible.

Before another live trial, the next unit should:

- Preserve this exact tool/result/control sequence as a static full-loop fixture. Local absence and incomplete terrain coverage must lead to bounded exploration or an explicit planner recovery handoff while retaining the same goal and power checkpoint. Do not raise observation/resume limits or accept an unsupported global blocker.
- Investigate the generated-terrain sampling/limit behavior and observation-packet relevance separately from model action choice. Repeated nearby scans were also truncated by resource entities; a bare entity ID or an unqualified cached observation is insufficient. Any carried machine reference must retain actor/surface/epoch and freshness evidence, with fresh discovery before targeted mutation.
- Add a deterministic native map with a shoreline beyond the initial placement/local-water radius, then drive exploration, fresh pump placement discovery, connected power and native powered-lab verification. No operator relocation, fabricated water, instant production or hidden corrective gameplay after setup.
- Include bounded no-progress exhaustion, cancellation/epoch change and lost-ack/restart negatives; preserve exact receipts and avoid replay. Native component crafting alone must not close the connected/powered result checkpoint.

This is the remaining recovery/exploration boundary, not a new live-run authorization. Automated red and green science remains the next production milestone after reliable powered research and unlock evidence.

## Preserved evidence

Ignored integration-worktree directory **`test-results/luna-green-live-2026-10-15m/`**: safe summary, exact terminal `recovery-validation-case.json`, role/handoff proof, deployment checks, rotated provider/decision/behavior logs, native snapshots, canonical state, a 12-file hash manifest and **652,035-byte** `data/saves/luna-green-m-checkpoint.zip`. Stack down; unrelated containers untouched.

Offline run-check exits **1** over **2,029 rows / 7 requests**, **zero parse errors, nine findings**: stale-step signatures, restage-loop signatures, final no-chat signature and auto-resume exhaustion. These are analyzer findings requiring calibration, not nine independently validated defects. In particular, completing an acquisition batch does not prove the retained research checkpoint; nevertheless, the repeated recovery and terminal exhaustion are visible in the trace. No green gameplay success is claimed.
