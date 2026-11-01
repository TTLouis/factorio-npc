# Preventive consolidation — 2026-10-22

## Scope and ownership

Owner: parent T3 thread bd8ab49e-2657-4442-893a-7b4ab68e3d8c. The owner approved preventive implementation after the read-only review. Run AK follow-up remains plan-only; no push, deployment or new autonomous trial is authorized.

Task: `fix/preventive-consolidation` in workspace `.worktrees/fix-preventive-consolidation`. Source: local Jev candidate `d651508c3c2d075352dffc6602c9181de1dbc188`, also the frozen Run AK source. Published Jev `b9574fc4556eafb431f158ebee80fe3f1807a02d` was freshly checked by `git ls-remote` on October 22. The initial network restriction was resolved by approved read-only escalation.

At most two GPT 6.1 Sol children worked concurrently with detailed, non-overlapping ownership. Workers never committed. The parent validated findings, reviewed changes, owned the index/commits, reserved the existing local integration checkout and runs final verification. Workspace `WORKTREES.md` records integration outcome and ownership; no other checkout or canonical checked-out branch is reset or rewritten.

## Accepted implementation

| Area | Result | Proving regression / evidence |
| --- | --- | --- |
| Decision budgets | Shared capture/restore of all five existing overrides, owned by generation/lineage; request/setup, completed/failed wakes and both supervisor recovery branches covered. Numeric limits unchanged. | `decision-budgets.test.mjs`, `recovery-observation-budget.test.mjs`, state-scope and slice/provider tests |
| Recovery preparation | Ownership captured before initial state/epoch/helper awaits; intentional recovery cancel adopted once. Superseded recovery cannot restage, seed budgets or run a newer owner. | 17 cancellation windows, three valid delayed controls; 170 focused tests; independent R3 approval |
| Native inventory | Complete strict Serpent/JSON-array parsing shared by handoff and post-batch coverage; malformed, partial/error and unsafe counts fail closed. | `inventory-facts.test.mjs`, native-shaped post-batch and placement fixtures; 218 initial focused tests |
| Context consolidation | Shared 6000-character packet measurement, note sanitation and record formatting; preserves 1950 topology slot, separate 8000 prefetch budget, drop order and mandatory over-limit behavior. | `handoff-format.test.mjs`, unchanged provider replay fingerprints |
| Stale fact suppression | A delivered successful full native answer supersedes only the same-signature old post-batch tail fact. Errors, partial/diff baselines and unrelated facts remain. | `context-fact-supersession.test.mjs`, actual provider-payload inventory 4→9 / fluid 0→200 controls |
| Result/unwind fencing | Stale result handling and outer request failure cleanup cannot update or clear replacement request state, usage, facts, pending setup or budgets; same-owner failure and role restages still work. | 21 deferred batch invalidations; 17 public request/guarded-turn cases; 535 related tests; independent R5 approval |
| CI/native evidence | Build image once; add placement-clearing and water-reach lanes; preserve logs/results/saves before exact-ID cleanup and upload evidence even on failure. | Nine fake-Docker wrapper scenarios plus existing local-runner tooling |
| Shipped closure | Installer copy and checksum lists include all three shared helpers; precisely enumerated release imports the real supervisor successfully. | `installer-preventive-closure.test.mjs`, 2/2 tests |

Named behavior traces include `decision.budgets_restored`, `decision.budgets_restore_skipped`, `context.executor_decision_superseded` and `observation.post_batch_fact_superseded`, with originating request and reason. No new campaign allowance, mutation authority, provider retry or goal-completion shortcut is introduced.

## Reviews, controls and compatibility

- R1 found late supervisor ownership capture; parent corroborated it, a worker corrected it, and R3 approved the stable correction.
- R2 found post-supersession-trace result bookkeeping; a worker fenced it. R4 found its stale rejection could still clear the replacement during outer request unwind. A separate bounded worker correction added public-path coverage; R5 approved the combined production source. All 104 sealed review files matched.
- The finalized unwind control fails 13 regressions on incoming source while four same-owner controls pass. Earlier budget controls reproduced 13 failures plus a setup failure; context controls reproduced four stale-fact failures and then 21 cancellation failures. Full logs distinguish genuine behavior controls from initial missing-module fixtures.
- Golden replay update was not an assertion relaxation: all 11 provider body/context/message-count fingerprints and all 154 retained trace hashes were proved unchanged after accounting only for three new cleanup events and their request-local sequence increments. The final strict fixture compares all 157 rows; 35/35 tests pass.
- Parent lint found three template-concatenation errors in the new closure test. A disjoint worker made only equivalent template-literal changes; its tests/lint and subsequent complete changed-module lint pass.

Known nonblocking diagnostic limit: the existing generic trace emitter can attribute a stale diagnostic envelope/sequence to the current request, while captured `data.request_id` remains correct. Reviewed consumers do not turn that into admissions, cache/budget changes or completion authority. No general tracing rewrite is included.

## Native milestone and baseline finding

The initial parent native milestone passed placement-clearing, water-reach-approach, recovery-loop and direct-feed-observation. Fresh-topology failed at the first scripted planner's unconditional `facts.expansion` assertion.

An independent investigation reproduced the same failure against exact archived `d651508c` on the same immutable Factorio 2.0.77 image. Current and baseline provider topology blocks were 1,677 characters, identical except observation tick, with held engine, reciprocal boiler/pump connectivity and conditional 60/30=2 capacity intact. Both explicitly reported `truncated:true` and `fields_omitted:["expansion","session","reason"]`. Compaction has intentionally dropped non-world advice before native facts since `6b8f0287`; this was a stale native test expectation, not a preventive production regression.

The bounded test-only correction requires the original guidance when the property exists; otherwise it requires true truncation and an explicit array omission marker. Missing/unmarked/not-truncated and malformed-present controls fail. Every native gameplay assertion and action sequence remains intact. The corrected full native lane verifies one engine, two pipes, preserved poles, reciprocal connections, three steady real-load samples, steam/electrical generation and semantic completion, with zero humans, normal speed and zero live inference calls. This different map is not proof of the exact Run AK layout or autonomous capability.

## Parent verification and packaging

Evidence root (ignored): `test-results/preventive-consolidation/`.

| Check | Recorded result / location |
| --- | --- |
| Full candidate offline gate | Exit 0; 3054/3054 runtime/staging, 1332 mod tests in 134 files, TypeScript noEmit, Lua build and generated-Lua checks; `parent/full-candidate.*` |
| Complete changed-module lint + payload + tooling | Exit 0; `parent/complete-final-checks.*` |
| Installer artifacts | Regenerate/check and 9/9 verifier tests pass; `parent/payload-repin.*` |
| Native Docker build | Exit 0; `parent/native-build.*` |
| Initial five-lane milestone | Four pass / stale expectation failure, all evidence retained; `parent/native-candidate/` |
| Exact baseline diagnosis | Two strict failures, matching native mod/runtime identities and provider topology; `native-topology-investigation/REPORT.md` |
| Corrected native lane | Full semantic PASS, strict omission-guard controls and lint pass; `native-topology-contract/` |
| Final local integration | Exact merged SHA, fresh merged gate, final native evidence and cleanup recorded in workspace `WORKTREES.md` and `parent/` closeout records |

Commits: runtime/installer `ab47531d3357846b00990f9897ab6c229310ec9b`; CI `a2675ed1ac0fc4257a197fb07caf95d9021caa5d`; separate payload repin `614f1b2578312496449af5f4270bef7a15941a70`. Payload source is immutable `a2675ed1`; SHA-256 `fc084262fd6e48d19923b751baa3a86257f80ae0a530df3c489efe963f0dc9b5`. The pinned installer Git blob and workspace bytes match. Main/NPC channel eggs regenerate identically; only the immutable loader and builder/test pins change. These commits remain unpublished.

All tests use Docker, not Windows host Node/pnpm. Shared `npc-dev` identity: `sha256:5ebe30259a5ad6e935317e9ad4e831bb9135c75c653c4e743029eaf5f511602f`. Native engine: Factorio 2.0.77. Tests are network-disabled, scripted/offline and scoped by exact names/CIDs, with finally cleanup after evidence preservation. Container identities and absence checks are retained under each evidence directory. The parent retains the task checkout/evidence until publication decisions; shared images and unrelated stopped containers are not cleanup targets.

## Run AK next-fix plan only

See [RUN_AK_NEXT_FIX_PLAN_2026-10-22.md](RUN_AK_NEXT_FIX_PLAN_2026-10-22.md), independently approved against sealed source/prompts. AK produced 99 iron / 10 copper / zero science and native boiler steam; its terminal recovery checkpoint had an anchor without required radius. The validator correctly rejects that malformed scope. The proposed next work is bounded pure-validation recovery correction preserving the committed contract/limits, realistic C6/C7 contract/notes continuity, and exact AK-layout engine join plus steam/electric output proof before a separately authorized autonomous trial.

The final AK prompt did carry boiler geometry and one held engine; earlier/per-round packet losses must not be generalized into total absence or physical impossibility. No AK fix is implemented here. Historical report hash remains `72a254d3e8ebe0ae78b6ad2dece45d7f718b3775cd3506f58a36c8dd7e62428a`, with frozen tracked/index diffs unchanged. Five historical untracked integration reports are hash-protected. No new live E2E, push or deployment is claimed.
