# Run AS entity refresh repair

Owner: Codex /root chat01a16ab4. Branch `fix/run-as-entity-refresh`.
Source: `10e2c307f94a6683353ddfc26689df263099faa2` (executable `cdbc95ed`).
Published Jev rechecked: `b9574fc4556eafb431f158ebee80fe3f1807a02d`.

Unit A only from [the reviewed plan](RUN_AS_NEXT_PATCH_PLAN_2026-10-23.md).
No new E2E, provider/Jev call, deployment, push, shutdown-alarm fix or accounting
refactor. Units B/C remain separate work.

## Failure and harness owner

AS physically smelted ten copper plates but could neither read nor use furnace19
once its request binding expired. Mutation parsing required a live exact binding;
the closed-round typed observation path also required an entity checkpoint and
refused this inventory checkpoint. Repeated model replies exhausted recovery.
A durable locator remained advisory, and the full production controller was not
joined to that refresh boundary. Existing tests covered each refusal separately,
not their combined ownership and continuation lifecycle.

The fixture preserves actor12/surface1/furnace19 at(55,63), p3/v1/step4, exact
issued tap21/22/24 replies, actual native recipe seq337, and original pre-refusal
planning history at23:14:30.414Z. Its remaining ledgers come from final memory;
the scripted world begins with AS's final verified output stock. Provenance hashes
and substitutions are inside `runtime-v8/fixtures/run-as-entity-refresh.json`.
No historical trace is changed or claimed to be a corrected execution.

## Shared prevention and residual correction

`entity-refresh.mjs` joins typed observations, exact mutation validation and the
admission backstop. It accepts only a complete durable locator plus this NPC's
same-epoch placement receipt. Fresh native actor/surface/force and same-unit,
name/type/position facts must match before any raw response is cached or published.
Unrecorded/player-owned targets retain existing refusals.

Detection -> one durable targeted read and shared controller claim -> validated
binding -> current inventory/output reconciliation -> bounded collection through
the existing production controller -> ordinary native receipt/checkpoint close.
An old supply proposal is discarded. When complete output exists, the internal
persisted `collection_only` task can only collect the proven deficit; disappearing
stock pauses instead of feeding, crafting or gathering. When collection is not
proved, the existing bounded ordinary decision receives fresh facts; its statement
cannot grant repair/completion authority.

A residual binding loss after successful parse runs through real Session admission,
native completion and canonical progress without an operator or corrective model.
Claims remain charged across restore. Interrupted claimed/bound work without a
responsible durable successor pauses explicitly. A restored collection successor
uses the same fresh idle/follow/crafting/wait/uncertainty fences on every wake and
at final pretransport admission. Superseded cleanup cannot overwrite a replacement
request's admission marker.

Existing targeted-read allowance, controller limits2/step and6/goal and bounded
128-record ledgers remain authoritative. No eviction or restart grants a free retry.
Actor/epoch/request/conversation/goal/plan/version/step, amendments, user stop,
pending/uncertain native effects and active controllers remain fenced across awaits.
Committed goal, roadmap, steps and completion contracts remain unchanged.

## Proof matrix

| Claim | Evidence |
| --- | --- |
| Original defect reproduced | Final exact positive tests against unchanged10e2c307 fail for `exact_entity_requires_live_observation` and `entity_not_grounded`; no missing-helper/setup failure. |
| Shared prevention | Exact mutation and typed observation, normal/closed tools, production reads and residual admission use the same identity contract. |
| Composed self-correction | Session queue -> injected post-parse miss -> collect10 already produced -> native receipt -> original checkpoint closes; no replay/supply/model repair. |
| Partial/stale/busy safety | Collect4 when6 held; disappeared stock pauses; wrong/replaced/truncated/force/surface identity; request/step/epoch/amendment changes during awaits; native queues/follow/crafting/waits/uncertain pending effects. |
| Restart/exhaustion | Charged claims and2/step6/goal budgets restore; no-successor crash pauses; durable successor resumes from fresh stock; restored wait/crafting/follow/late-admission fences and cleanup supersession. |
| Diagnostics | Request-correlated detected/bound/exhausted/decision-wake/settled traces. Checker clears only complete matching request/unit/goal/plan/version/step verified settlement. Historical rows missing owner fields remain conservatively unresolved. |
| Native mechanics | Dedicated Factorio2.0.77 lane physically places, supplies, smelts10 and collects output in prevention and injected residual cases at1x/zero humans. Explicit native actor/unit/surface and journal-watermark mapping; no fabricated completion. Ends after verified original step before unrelated next-slice planning. |

41 new runtime regressions. Full candidate `scripts/test-local.sh all`:3343/3343
runtime,1378/1378 mod, typecheck and Lua/generated-Lua PASS (`candidate-all-02.log`).
Initial concurrent native compilation caused two mod timing failures; isolated and
full reruns pass without threshold changes. Changed-file lint:zero diagnostics.
Native fixture attempts are all retained, including ordinal/empty-journal setup
mistakes and attempted stubbed next-slice calls; those are not passing proof.

Evidence directory: `test-results/run-as-entity-refresh/` in the task checkout.
Native logs, saves, transcripts, source hashes and Docker identities are preserved
outside disposable containers. Offline Docker runs have no network/providers.

## Review and promotion checkpoint

Independent reviewer found and resolved: output-disappearance replay authority,
stale request markers, native busy races, premature durable continuation, restored
collection safety fences, incomplete checker owner correlation and stale cleanup
overwriting a replacement marker. Regressions cover each. Draft reread reports no
remaining blockers; immutable source/payload review and local integration remain
pending at this source checkpoint.

- [x] Exact baseline control; shared prevention and composed residual correction.
- [x] Partial output, stale/busy/uncertain fences, durable restart/exhaustion/checker.
- [x] Candidate runtime/mod/type/Lua and changed-file lint gates.
- [x] Final native proof: `native-04`, two cases,92 helper tests, zero inference.
- [ ] Immutable payload pin and independent commit review.
- [ ] Verified local integration and merged offline gates.

The exact regression, composed harness recovery and native mechanics are separate
claims. Autonomous science production remains unproven. No new live E2E is started.
