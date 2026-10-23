# Run AA: post-batch optimization exercised; zero-transfer reconciliation blocks red automation

The owner authorized another fresh E2E after Claude's optimizations, retaining the goal of autonomous red science production. Frozen candidate `623d695dd588a0c134242aa74210fa25e866fa0f` includes family-directed post-batch reads, same-batch footprint preflight and completed-prefix reconciliation. The existing integration checkout was clean and fast-forwarded to the freshly fetched integration ref; other checkouts were untouched.

The sole gameplay objective was unchanged:

```text
!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.
```

The fresh world used seed `3781758573`, actor 6 and new goal `goal_13cfn6m_1`. Construction retained the 60-minute cap, provider/recovery limits and inherited starter. There were no corrective prompts, manual resumes or allowance resets. Success still required the automated upstream chain and at least ten new red packs over ten game minutes, with AI mutations paused. That measurement was never reached.

## Validation and deployed release

- Required Docker gates passed: 2,590 runtime/staging tests, 1,229 mod tests, typecheck, Lua build and generated-Lua checks.
- All 42 offline runner/measurement/strict-stop tests passed. The first preparation attempt lacked two copied fixture files; its failure is retained, and the complete rerun passed without changing assertions.
- Official build used `scripts/build-docker-local.ps1 -NoEnvUpdate`. Its image ID was `sha256:730feb4def01855dcfbea0c51a3f6527f1c6581667dcb0fc8f6312b1e19377f6`.
- All 54 shipped runtime/staging modules, packaged prompt and manifest matched the candidate. All 31 native files matched an independent prepared-source compilation using the established symmetric text CR normalization. Packaged and active native files matched raw bytes.
- Before inference, both complete 41-tool role catalogs, closed-tool serialization, catalog authentication, full native idle, empty inventory, empty task board, zero humans and zero provider/Jev requests passed.
- Actual response traces prove four `gpt-6.1-sol` and fourteen `gpt-6-luna` replies, with 18 requests, 18 replies and zero provider errors. All 23 Jev exchanges succeeded.

## Outcome and optimization evidence

Run AA started at `2026-10-18T15:40:00.973Z` and ended after **631,191 ms (10.51985 minutes)** as `controller_blocked:canonical_plan`. Native production reached ten copper plates, 42 iron ore and 30 coal. It produced **zero new iron plates and zero red science**; eight starter iron plates remained held. The only placed production machine was stone furnace 13. There was no steam-power chain or automated science factory.

The new post-batch path ran nine times across nine acknowledged batches. Seven observation phases closed with reason `post_batch_facts_cover_selected_families`; the harness supplied the selected facts directly. Four provider replies contained tool calls, including initial discovery. These traces establish that the optimization executes live. They do not establish an end-to-end speedup: Run AA used a different map and stopped at an earlier production milestone than Run Z.

Same-batch placement overlap and completed-prefix reconciliation were not exercised before this blocker. Their static gates passed; this trial adds no live proof for those paths.

## Exact blocker and next regression

Furnace 13 retained ten copper plates in its output while iron ore and coal were loaded for iron smelting. Batch 9, operation `req_mvdzrp37_1/batch_9`, requested legacy name-based `move_items` from `stone-furnace`: `item_name=iron-plate`, `max_count=50`, `to_entity=false`.

The native result at tick 39697 was `nothing_moved`, `moved_count=0`. The cancelled receipt had one task, `started_count=1` and `tasks_started=1`, but **no `failed_before_mutation` proof**. Its admission journal remained `uncertain` / `batch_reconciliation_required`. Runtime reconciliation consequently retained `admitted_cancelled` / `partial_unknown` / `exact_batch_cancelled`. At `15:49:27.965Z`, the uncertainty guard blocked the step; canonical outcome was structural `unresolved_operation_effect`. This was not a provider error or time/usage cap.

The next deterministic regression should replay copper-to-iron furnace reuse and this exact zero-transfer receipt. A fix must establish native no-effect proof with exact actor, operation, task and batch correlation before releasing the hold; it must retain the guard for unknown or genuinely partial transfers. No follow-up runtime change or second live trial was made here. `blocker-batch9-packet.json` preserves the exact admission, receipt, native result, furnace inventories and terminal classification.

## Stop, save and cleanup

Fresh cancellation and same-goal operator-pause receipts confirmed strict stop at `15:50:32.163Z`, with native idle and empty task/crafting queues. The new checkpoint completed after stop: **898,738 bytes**, SHA-256 `09ef57a53369ff4bb7a53af0ce4906627ba318b1be3b8cdce7ddcff1c3661bde`. All 56 ZIP entries passed CRC. A pristine copy loaded with exact Factorio **2.0.77** and the released native mod, performed one update and exited zero with networking disabled. Original and copied save hashes matched.

Compose project `red-automation-20261018aa`, its live/proof containers, network and disposable volumes are absent. Exact owned SSH PID 61032 and its listener are absent, and the unique run image tag was removed. Generic `factorio-npc:local` remains: automatic approval review rejected removing a potentially shared alias without exclusive ownership proof, so cleanup retained it. No global prune, unrelated resource removal or Docker restart occurred.

The wrapper's initial tunnel identity guard safely refused cleanup because PowerShell's JSON DateTime conversion lost the UTC offset during string coercion. A separately recorded cleanup helper preserved the UTC string and verified the exact SSH process start, then removed it. Save/load and stack teardown had already passed. Frozen gameplay/preflight helpers remained unchanged throughout.

Weekly usage remaining was 89% before inference and 88% after cleanup; no reset credit was used.

## Sealed evidence

Local evidence is retained at `test-results/red-automation-live-2026-10-18aa/`. The 199-file, 13,293,195-byte manifest is SHA-256 `e5724084d7f6764fe51d0b416309e300b7d07c28825e83289c30631131010ed3`; all entries were verified after sealing. Manifest/self-hash files are excluded from their own file set. All 186 previously sealed Run Z files and their exact file set were independently rechecked unchanged by the post-run script. No runtime code was changed or pushed during this validation.
