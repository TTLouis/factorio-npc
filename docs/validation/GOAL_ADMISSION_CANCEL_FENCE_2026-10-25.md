# Goal-admission cancellation fence — 2026-10-25

Owner: `goal_cancel_fence`, parent Codex chat `01a171d1`. Branch: `fix/goal-admission-cancel-fence`. Source: `e6cd51550ab02a217ae7c36a24fe52d1e82453c7` (runtime unchanged from `11d182c1`). The parent owns integration and the separate contract-obligation repair. This branch changes intake ownership only.

## Failure and owner

The actual `NpcAgentLoop`, `CanonicalTaskBoardMemory` and protocol-speaking `FakeFactorio` admit a goal, await goal-admission steering, receive `cancel('user_stop_immediate')`, and then continue through either an undefined or AbortError advisory fallback. Both baseline cases call the offline provider sentinel once after cancellation, with later steering, actor binding and budget reservation. Paired-owner original evidence remains untouched at `../test-paired-red-automation/test-results/paired-kit/r1-runtime-repro/`. This branch retains its own immutable-source replay under ignored `test-results/goal-cancel-fence/`.

The invariant belongs to request intake: before a base turn exists, old async work must not admit/persist work, call advisory/main providers or mutate replacement-owned state. Earlier generation/lineage guards became effective only when the base request started. Advisory fallback did not distinguish owned work from a stopped request. First restore also marked state loaded before its disk await, allowing another request to run ahead of pending restore.

## Shared prevention and bounded correction

A transient async intake scope owns the intake, NPC, generation/lineage, actor and eventual trace. Intake awaits and nested classification/shape/steering helpers fence successful continuations. Fresh native deployment identities fence steering effects and the base handoff. Optional undefined/failed advice retains its normal fallback while owned. An optional staging assertion callback runs immediately after actor capture, before assigning the epoch or rebuilding active state/conversation; ordinary staging callers retain their behavior.

Skill/requirement callbacks fence late side calls, facts and ledger writes. A legitimate shadow skill answer can finish after its own base transition. Queued intake persistence checks before publishing its snapshot. A shared process restore barrier runs outside request scope; all callers await it before intake, and cancelled callers drop after initialization. Existing unreadable-state handling stays unchanged: a single restore attempt is logged/ignored; no new retry or execution authority.

Residual correction is deterministic refusal/drop at the same boundary, including ignored aborts and already queued trace/persistence callbacks. It never retries a model/world operation or spends recovery allowance. A stopped request has no next wake; replacement work continues through its own intake. The exact held-advice fixtures deliberately ignore cooperative abort so the runtime fence establishes safety.

Guarded persistent pause checks physical checkpoint and captured admission ownership before invalidating anything, then rechecks after loading/persistence. Admission comparison is specific to guarded pause; chat/status intake does not globally invalidate physical completion checkpoints. Refusal rows retain old intake/request/actor identity and bypass replacement trace sequence, timing and judgment accounting.

## Evidence matrix

| Variant | Evidence and result |
| --- | --- |
| Exact original undefined / AbortError | `baseline-repro.log`: one real offline provider sentinel after stop per case, exit 0. New primary regressions on unchanged baseline: `baseline-tests.log`, 2 expected sentinel failures / 1 valid-fallback pass, exit 1. |
| Owned optional advice | Undefined fallback reaches ordinary planner; existing slow shadow Jev test remains valid. |
| Stop before goal/trace | Held preload/status and actual Session chat stop; no provider and no fabricated pause receipt for a nonexistent goal. |
| Async traces/base binding | Request/admission/skill/actor-bound trace waits, steering decision trace before provider call, and stop/supersession during base actor capture; no late active/conversation mutation. |
| Replacement/actor ownership | Supersession, local actor/epoch/session/NPC/request trace changes, fresh native actor/session changes; old memory/trace/budget state cannot overwrite replacement. |
| Persistence/first load | Cancelled queued snapshot never publishes; cancelled first intake and replacement share one actual disk read/restore before admission. |
| Guarded pause | Old physical checkpoint still matches before replacement's first trace/base generation, but stale intake token refuses pause; replacement during pause preload survives too. |
| Compatibility | Default staging caller, legacy error identity/budget unwind, routing/busy-world, optional Jev and time accounting. |

Twenty-eight new regressions exercise the real runtime entry points. Safety drop is the intended terminal disposition for cancellation, rather than automatic resume or gameplay success. No native mechanics changed; no new engine/autonomous-gameplay claim is made.

## Validation and closeout

- Focused legacy/safety selection: 92 passed; shared-restore/scope selection: 40 passed. Full logs and baseline archives remain local and ignored.
- Final serialized `all05`: exit 0; 103 agent, 3,476 runtime, 1,378 mod tests; typecheck, Lua build and generated-Lua verification passed.
- Scoped lint and `git diff --check` passed. Earlier attempts/failures remain retained: compatibility findings were fixed; `all03` had two unmodified mod import/hook timeouts while tests ran concurrently (cause unproven). No assertions/timeouts were weakened. Parent serialized final heavy gate.
- Final gate containers `npc-static-623-1418-agent`, `-runtime`, `-mod` verified absent including stopped containers (`final-gate-cleanup.json`). Other run-owned CID/name absence is retained in final local cleanup evidence.
- Source and separate payload repin commits identify the immutable candidate. The repin uses the full source SHA, generator/checksum and nine payload checks. Independent review and integration remain the parent's responsibility.

No live/provider/Jev/network trial, deployment, publication, corrective gameplay or background work was performed. Historical Run AV and other writers' sources remain untouched. This establishes the original regression fix and composed intake safety; native gameplay remains unproven by this repair.

## Independent review follow-up

The immutable `38f9bec7` source / `24784f0a` repin received changes requested for three neighboring interleavings. Those commits and all earlier evidence remain intact. Follow-up source and repin commits supersede their approval status; no history was rewritten.

- **R1, nested amendment:** `stageCompatibleAmendment` fences after planner return and before staging text/flags. The parked-planner return also fences its earlier `assertCurrent` await. Actual executor/parked-planner regressions hold `context.planner_resumed` or current-actor validation, then stop or replace the intake. Releasing the old path cannot append the withdrawn amendment or alter the newer conversation/memory.
- **R2, physical guard provenance:** checkpoint capture records only an actual bound-turn intake provenance from the caller's async scope. It cannot borrow the global pending question/request, including when a physical callback inherits an unbound intake scope. Guard pause checks the canonical physical checkpoint across its awaits, revokes only its own intake, and preserves/reanchors an unrelated pre-base intake across the physical reset. Explicit operator stop still revokes pending intake. Actual continuation-limit and fresh-checkpoint guards run after another intake starts its held status read; status questions and replacement goals both continue under their own token. This is concurrent-entry contract coverage; normal Session event processing serializes ordinary chat and physical callbacks, so these tests do not establish a normal-queue live race.
- **R3, late shadow errors/results:** rejected/aborted callbacks check ownership before fallback accounting and after the awaited fallback write. Successful ledger-write completion is fenced too. Stale diagnostic rows retain the old request/decision/actor with sequence zero, bypassing replacement timing, judgment and trace accounting. The raw recorded-provider wrapper similarly retains actual late `decision.exchange` results/errors under their original identity, rather than dropping an API outcome or incrementing a replacement sequence. Existing stop activity notification is preserved only for that exact stopped lineage with no replacement intake/trace; normal own slow shadow behavior remains covered.

Thirteen additional review regressions retain all 28 original controls. The initial 12-case review selection on immutable `24784f0a` produced nine expected actual failures (two amendment writes, four consumed newer intakes, three late-shadow attribution cases) and three already-safe controls. Logs are `review-baseline01.log` / exit 1. The earlier `assertCurrent` variants and positive global-stop control already passed on that source. The subsequently added inherited-intake-scope test exercises the same provenance rule.

Focused source proof: `review-focused07.log`, 139 passed, covering all original and new controls plus legacy executor, skill and unwind behavior. `review-lint01.log` includes scoped lint and 27 lifecycle/scope passes. The review full gate and follow-up immutable SHAs are recorded in the local final summary after completion. Full logs, baseline snapshots and failed intermediate fixture-development attempts remain local/ignored. Neither retries, timeout increases, prompt/goal changes nor new runtime/native authority were introduced.

Final follow-up validation: `review-all02` exit 0, 103 agent / 3,489 runtime / 1,378 mod tests, typecheck/Lua/generated checks passed; final scoped lint `review-lint02` passed. `review-all01` is retained with its two C7 compatibility findings: guard pause can synchronously reconcile a torn legacy/reducer projection, so post-persistence ownership now fences that exact owned result rather than rejecting the legitimate pre/post identity difference. Focused C7 plus all original/review controls passed 56 cases (`review-focused08`) before the corrected full gate. No assertion was changed. Both review full-gate runs' five exact container names were verified absent including stopped containers; no native files or mechanics changed.

## Final diagnostic and successful-shadow helper boundaries

The `a1c8663c` source / `5fad453e` repin rereview accepted the original R1–R3 repairs and requested two remaining internal await fences. Those immutable commits and their evidence are retained.

- **R4:** a no-live-trace canonical guard pause can await its final `goal.paused` row. The exact post-pause checkpoint and admission identity are now checked again after that row, immediately before skill/contract aborts and reset. Three real-runtime tests hold the row while B waits before its trace (status and replacement routes) or advances its real trace; releasing the old pause refuses its stale cleanup and preserves B's token, checkpoint, generation and abort controllers.
- **Successful shadow helper:** the skill callback passes its bounded `current()` predicate into `recordSkillOrder`, `record`, trace-row emission and retirement scoring. Each internal continuation checks before tracker/ledger/scoring mutation and after its awaited abandon/judgment trace. The normal plan-commit skill-retirement caller also retains its exact offer and fences its retirement trace/scoring await before later state writes. A recorded judgment or abandonment performed while still owned remains historical truth; a late callback cannot recreate a tracker, score a retired offer or schedule a new persist against replacement state. Raw API evidence from the earlier callback handling remains intact.

Thirteen additional tests cover abandon and real `jev.judgment_recorded` waits, cancellation and real replacement intake, both retired/loaded and unretired offers, the three final-pause cases and two unchanged-owner slow-success controls. Against immutable `5fad453e`, these exact tests produce 11 expected actual failures / 2 positive passes (`residual-baseline01`, exit 1). Candidate exact controls pass 13/13; `residual-focused02` passes 162 including all original 41 cancellation/review regressions, real Jev-ledger/skill behavior, canonical C7 recovery and stop coverage, with scoped lint passed. No assertions, timeouts, prompt policy, native semantics or execution authority changed. Later immutable source/repin and full-gate results are retained in `residual-final-summary.json` alongside earlier summaries; local archives/logs remain ignored.

Final residual gate: `residual-all01` exit 0, 103 agent / 3,502 runtime / 1,378 mod tests, typecheck/Lua/generated checks passed. All three exact gate containers `npc-static-1664-21712-agent`, `-runtime`, `-mod` were verified absent including stopped containers (`residual-gate-cleanup.json`). The task now contains 54 new regressions across its immutable follow-ups. No additional broad gate is needed without a source change or new finding; independent final audit and combined integration remain with the parent.
