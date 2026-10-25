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
