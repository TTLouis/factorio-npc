# Luna green-science live run K — October 15, 2026

## Result

The newly authorized longer CLI-proxy trial ran **40 minutes 36 seconds**. Luna autonomously crafted a lab, unlocked red science and hand-crafted **21 automation science packs**. Three bounded auto-resumes fired and resumed their plans. Run J's `checkpoint_requires_active_step` fault did not recur.

**Green science remains unproven.** The trial stopped at a separate native admission-timing defect: a batch queued a copper-plate withdrawal and then tried to admit a craft using that plate before the withdrawal completed. The first operation completed; the second was refused. Save/traces are preserved and the isolated stack is down. No corrective prompt, operator gameplay, cap increase or live retry followed.

## Candidate, checks and authority

- Louis requested the Run J fix and its full-loop regression, integration after local checks, and one further longer CLI-proxy attempt. [Unit 19](UNIT19_COMPLETED_SLICE_CHECKPOINT_2026-10-15.md) delivered fix `2e24b74f`, reviewed and merged at `01424bcd`.
- Pushed source candidate **`bcc4e84395889a24862da92ff2a07e270455fb78`**. Unit and merged canonical Docker gates passed: **2,358 runtime/staging tests, 1,142 mod tests**, typecheck and Lua checks. Frozen-code recovery-loop, production, craft-trigger, native-admission and steam-lab lanes all passed. Five new full-loop scenarios cover Run J, both successor routes, bounded exhaustion, stop and epoch fencing.
- Required `scripts/build-docker-local.ps1 -NoEnvUpdate` passed. Actual image: **`sha256:fc2755fb13d43b57b19fa64330d0d5a06dd2db32e1fa67ac9e009e27d37dd78b`**. Running-container preflight matched all **50 runtime/staging modules** to committed source, the prompt to its committed hash, the manifest to its files, and all **31 active mod files** to the packaged build. No runtime override or `.env` edit.
- Non-secret config and all 112 main-provider responses confirm **`gpt-6-luna`**, API method `local`, via the previously confirmed CLI proxy; dedicated Jev enabled. Private routing/configuration and raw traces remain ignored, not committed.
- New project `luna-green-20261015k`, empty isolated data directory, seed **3977678815**, standalone actor **6**, fresh goal **`goal_0oftv47_1`**, root request **`req_mv9aifph_1`**. Empty inventory and nil board before the unchanged starter: drill 1, furnace 1, iron plates 8, pistol 1, ammunition 10. Zero humans and speed 1 throughout observed snapshots. Existing worlds were preserved; RCON publishes only on `127.0.0.1:27016`.
- One raw-chat objective toward green science. No preset duration/poll-count cutoff. Started **04:41:53 EDT**, driver concluded **05:22:29 EDT** (08:41:53.809–09:22:29.843 UTC), elapsed **2,436,034 ms**. The terminal refusal occurred at 09:21:30.054 UTC. Weekly remaining was 96% afterward, above the standing 50% floor.

## Verified progress

- Native copper acquisition/smelting/collection reached 10 held copper plates and empty output.
- A full 50-ore iron smelt produced 50 new plates, rather than netting eight starter plates against the production trigger. Later slices gathered/smelted further resources and crafted lab ingredients.
- A native snapshot at 09:02:57 UTC showed a held lab and `red_unlocked: true`; the lab plan had completed.
- Native hand crafting produced 21 red science packs. The mod's authoritative `items_produced` evaluator reports `current: 21`, `hand_crafted: 21`. The engine's force input statistic remains zero for these standalone-character hand crafts, as the existing native hand-craft statistics gate documents. The observer reports the authoritative NPC count and retains the raw engine statistic separately.
- All three real 15-second auto-resumes activated their paused plans and continued; no harness-state fault was recorded. The completed-slice-specific blocker route added in unit 19 did **not** fire in K, so its exact failure-path repair is proved by the red-to-green composed regression, not a claim of direct live reproduction here.
- The lab remained in inventory. No powered lab/steam cell or research progress was reached; red packs consumed **0**, green technology researched **false**, green recipe enabled **false**.

## New terminal defect: eventual transfer stock is not current craft-admission stock

The last executor reply proposed, in one batch:

1. `move_items_exact(copper-plate, unit=14, max_count=1, to_entity=false)`.
2. `craft_item(automation-science-pack, count=1)`.

Fresh furnace output supported the withdrawal. `operations.batch_stock_checked` approved the batch as `batch_within_observed_stock`; operation 2 was explicitly `covered_by_earlier_op`, with the copper plate deferred from operation 1.

That stock model conflicts with the native API's admission phase. `packages/autorio/src/crafting.ts` checks `actor.get_craftable_count(item_name)` **before** adding a crafting task. The queued transfer has not executed when the same Lua admission call validates the craft. It therefore returned `Not enough ingredients`.

Exact native record **`recovery_mv9bw53e/batch_39`** has two slots: withdrawal accepted with native batch reference `batch-g1-39`; craft refused before mutation, `mutation_unknown: false`. The whole admission remains `uncertain` because it has an accepted prefix. Native batch 39 subsequently completed the one-item transfer; final actor inventory contains **one copper plate**, **39 gears**, **21 red packs**, the lab, burner drill and 130 iron ore. The refusing craft produced no pack. The controller retained the prefix and blocked as `operation_admission_failed`, then reported an unrecoverable request failure.

This is an admission/execution timing mismatch, not a CLI-proxy failure or the completed-slice bug. Preserve the prefix and receipt correlation; never retry the whole batch or pretend the withdrawal did not happen.

## Proposed fix and regression case

Distinguish **stock already usable at admission** from **effects of queued operations**. A craft requiring a queued withdrawal must be rejected/corrected before dispatch, or separated into a receipt-gated later batch. Reuse the existing bounded correction path and committed step identity; do not synthesize inventory, weaken native ingredient validation, reopen completed plans or increase retry caps.

The captured `queued-transfer-craft-case.json` includes the exact reply, stock decision, native admission, completion receipt and post-failure state. The next static and native full-loop regression should begin with copper 0 in the actor, copper 1 in fresh furnace output and an available gear: reproduce the two-operation refusal, prevent speculative craft admission, then prove collect-only receipt followed by separate craft reaches verified science output. Cover an already-held ingredient positive case and partial-prefix/lost-acknowledgement/actor-epoch restart negatives with no replay.

**This separate production fix and runnable regression remain open.** Unit 19 is integrated and green; no additional runtime/mod patch or further provider run was performed after K.

## Evidence and diagnostics

- **112 main-provider requests / 112 responses / 0 provider errors; 94 Jev requests / 94 responses.** Counts come from the full retained traces, not the current rotated prompt segment.
- Full behavior checker: **4 requests, 1,771 rows, zero parse errors**, exit 1. Findings: one `request_failed_unrecoverable`, three `stale_step_tracker_behind_batch`. The latter occur while the broader 75-pack checkpoint remains unmet; partial batch progress alone does not establish tracker corruption. No `harness_state_fault` finding.
- Driver exit 0 means it recorded the terminal stop, not gameplay success. Final save **`data/saves/luna-green-k-checkpoint.zip`** is non-empty. RCON closed; only the run-K Compose project was removed. No live Pterodactyl deployment changed.
- The longer run exposed observer issues without changing gameplay: a successful goal may retire before the next poll, so the observer now accepts native success only with matching canonical completion or its correlated verified terminal receipt; two offline observer tests passed. Rotated prompt segments are preserved and deduplicated for cumulative analysis. Current-segment counters in older raw driver snapshots are not cumulative totals.

Ignored local root in `peaceful-saha-a52c6f`: `test-results/luna-green-live-2026-10-15k/`. It holds `summary.json`, `queued-transfer-craft-case.json`, `run-check.json`, `evidence-sha256.json`, complete `sgluna-*.full.jsonl`, retained rotated segments, observer tests, driver/start/down logs, deployment verification, native snapshots, result, final canonical state and save. No raw private endpoint or credentials are included in this committed checkpoint.
