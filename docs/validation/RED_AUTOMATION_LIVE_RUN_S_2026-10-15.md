# CLI-proxy Run S: nearby-name transfer miss became a structural blocker while the furnace still existed

One bounded local trial under the owner's active red-science goal. The supervising subagent preserved the blocker, stopped AI, saved and shut down the isolated stack. No operator gameplay correction, additional campaign, source/observer change, push or deployment occurred.

## Target and preflight

- Build the complete natural-resource power, automatic mining/fuel, smelting, gears, red assembly and native-logistics chain. Construction may hand craft/feed. Readiness requires **1 new red pack per game minute** for **five wall minutes at speed 2**, at least ten game minutes and ten new packs, with AI mutations paused and generated enemies removed/expansion disabled during measurement.
- The unchanged reviewed observer requires native upstream/machine/steam/fluid/network evidence, physical supply/fuel topology and an immutable SHA/source/goal/actor-bound packet explicitly reviewed by parent before measurement. No measurement or corresponding world changes occurred in this run.
- Frozen clean source **`7ca69aed3b8d8d3e4409c35e1fe916ca5ee64e7b`**, production/tests identical to reviewed targeted-water fix **`41642d05`**. Merged canonical gates passed **2,414 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks**; twelve native lanes, original-code controls and independent review passed against identical production code.
- Official local build: `scripts/build-docker-local.ps1 -NoEnvUpdate`; image **`sha256:aa7b043360c14990fbb9b9bd7a9d48b8768ae48257105075a69e8eed5898f7a1`**. Exact **50 runtime/staging modules**, prompt and manifest match the frozen source; **31 active mod files** match the release and native-tested bytes. No mixed runtime overlay.
- Resolver proved **Sol6.1 planner / Luna6 executor**, dedicated Jev present. Existing loopback SSH tunnel was verified with elevated visibility and left unchanged. Actual game-container authenticated model discovery returned HTTP200/33 models with both roles available. Seven unchanged offline Docker observer checks passed; zero pre-release provider calls.
- Cold seed **1727171543**, standalone actor **3**, empty inventory/board, no machines, zero humans, speed 1 and idle queues. Starter: burner drill 1, furnace 1, iron plates 8, pistol 1 and ammunition 10. Goal **`goal_046rvj5_1`**, initial request **`req_mva1nzc1_1`**.

## Result

Runner **21:22:02.088–21:28:02.582 UTC**, **6m0.494s**, including the supervision/termination interval after the canonical blocker. Actual terminal gameplay boundary: **21:24:59.239 UTC**, request **`recovery_mva1r99c`**, canonical plan **`BLOCKED`** after **`transfer_failed:no_target`**. Recorded actual stop reason: **`structural_blocked_target_reacquisition`**.

**17 provider requests / 17 responses / zero errors**: **3 Sol / 14 Luna**. Jev **13 requests / 13 responses / zero errors**. One planner-parking handoff, three context restages and one bounded automatic resume establish actual delegation/recovery. No further provider call occurred after the structural blocker.

The NPC gathered **ten copper ore and ten coal** and placed stone furnace **10** at **(11, −62)**. It never supplied that furnace successfully; native output stayed **zero plates**, and the actor retained both ingredients and eight starter iron plates. Only the furnace was placed. No power kit, connected power, lab, automation or red science output. Zero humans and speed 1 remained invariant.

The active immutable slice still required ten copper plates/electronics, followed by fifty iron plates/steam power. **The targeted-water fix was not exercised live**: zero fluid-source/local-spatial reads, zero JIT contract calls and zero baseline rebase events. **The five-minute benchmark did not start.**

## Exact target-reacquisition boundary

Recovery **`recovery_mva1r99c`** submitted two legacy **`move_items`** operations, one for copper ore and one for coal, each with `entity_name:"stone-furnace"`, `max_count:10`, `to_entity:true`. Both preflight entries returned **`ok:true, validation:"not_required"`**, then the batch was admitted and acknowledged.

The first native transfer failed **`transfer_failed:no_target`**. The recovery's fresh nearby scan found no furnace within **20 tiles** of the actor. However, independent native snapshots still contained furnace 10 at (11, −62), while the actor was at approximately **(6.539, −101.414)**: **39.67 tiles** away. Its historical location/identity remained in carried context. This was a local name-lookup miss with an existing furnace elsewhere, not evidence that the furnace had been destroyed or that the science goal was impossible.

The model then reported the committed step structurally blocked, citing the failed transfer and empty local scan. The canonical plan became **`BLOCKED`**, with revision authority withheld and a user decision requested. No relocation/reacquisition ran afterward. The exact operation arguments, native receipt/status, historical and fresh observations/locators, actor/furnace positions and canonical blocking decision are preserved in **`run-s-target-reacquisition-case.json`**. Its four actual recovery provider requests use shared-message references to retain the wire without duplicating repeated context. Parent owns classification/recovery design and regressions; this record does not prescribe an identity bypass or unvalidated global target binding.

## Separate supervision coverage gap

The canonical plan was **`BLOCKED` while `run.paused` remained false**. The fixed observer's terminal checks did not recognize that state, so it would have continued idle until its wall limit. Parent authorized stopping at this reproducible blocker.

The supervisor used the existing generic stop flag to enter the runner's normal **AI stop → checkpoint save** path. The flag's historical filename is `stop-at-hard-floor`; its raw runner result was `weekly_hard_floor`. **No usage-floor condition occurred.** The untouched raw result is preserved separately as `e2e-runner-result-original.json`; the normalized result records `structural_blocked_target_reacquisition`, the generic mechanism and stop authority explicitly. This observer coverage gap is separate from the target/recovery defect. No helper code changed during the trial.

## Evidence and shutdown

Ignored **`test-results/red-automation-live-2026-10-15s/`** retains the durable supervisor note, build/exact deployment/model/tunnel proofs, seven-check observer log, complete target-reacquisition case and native frames, canonical state, provider/Jev traces, original/normalized termination records, summary, a **seventeen-file SHA256 manifest**, and **860,822-byte** `data/saves/red-automation-s-checkpoint.zip`.

Offline Docker run-check exits **1**; its findings are recorded in the summary and `run-check.json`. Diagnostic signatures do not independently establish multiple defects. The isolated container/network were removed; the existing tunnel, VM services, unrelated container and older dirty root remain untouched. No retry followed this supervision cycle.
