# AY terminal harness repair acceptance — 2026-10-26

Owner: Codex /root/ay_fixes, chat01a176d4. Source candidate:
44e822e26772387781b32f368f540e30ee370987. Task branch:
`fix/ay-harness-recovery`; parent owns review/integration. No live calls,
trial, provider retry, publication or deployment performed.

## Failure and preserved evidence

AY tested source was ce80603b6403dbc55ba18c7a92855f4df5636206. Sealed
raw evidence remains in the paired-red-automation checkout under
`test-results/paired-kit/ay-closeout` without modification.

A: request recovery_mvo6q1lo, batch101 walk_to_position, actor13/epoch1,
goal_19286yp_1_p6 step1. Exact native snapshot18:53:31.244Z retained its
uncertain admission and cancelled navigation_unreachable receipt. The host
blanket cancellation branch retained partial_unknown. Later batch102 satisfied
all eight predicates, but pending101 deferred closure and the controller paused
with controller_native_outcome_uncertain. The fixture retains the exact pending
record and native snapshot; only unrelated journal rows were removed.

Earlier divergence: the executor submitted four coordinate-free place_entity
belt operations; native nearby placements fell outside the committed anchored
count radius. Existing bounded recovery reclaimed and replaced them. This change
does not add placement-intent/anchor admission constraints or topology planning.

B: goal_1h7s8kx_1_p6 step2 contained seven inventory outcomes and preserved
identities37/38/39. The tested compiler's eight-predicate generic limit rejected
the ten-predicate typed contract at activation, attempts0. Candidate44e822 already
contains the typed-capacity repair merged by c45cd95d; no duplicate fix is added.

## Shared invariant and correction

Exact terminal navigation-only cancellation releases an outstanding-work hold as
partial_known, never destination success, absence of effects, or replay authority.
Walks can move and clear obstacles. Exact actor/epoch, operation key, attempt,
signature, ordinal, generation, complete slots/ref/tasks, terminal reason/tick and
idle queues must agree. Mixed effects, unreadable/duplicate journals and malformed
or missing proof remain held. Closed-ledger original-signature replay protection
remains active. No successful operation receipt is manufactured.

Ordinary receipt settlement consumes the shared rule. If that receipt path was
missed, the real Session idle controller invokes owned settlement before its
uncertain-native fence. A native uncertain row is exempt only when the exact
retained host identity can be re-proven from the fresh journals; a closed ledger
entry alone is insufficient. Existing fresh checkpoint/preservation validation
owns progress. The existing durable controller caps (2/step,6/goal), restart
accounting, guarded exhaustion, operator stop and ownership fences remain intact.

## Verification and boundaries

Local logs and baseline source copies are ignored under `test-results/ay-repair`.

- `baseline.log`: controls both exit1 for the actual defects. A uses unchanged
  public reconcilePendingOperation from44e822 and returns partial_unknown. B
  executes the retained ce806 source's production ensureActiveStepContract and
  returns unsupported_or_malformed_contract, attempts0. The baseline wrapper
  exits0 only after confirming both expected failure exits.
- Exact AY native proof, mixed/stale/unknown/duplicate/queue/receipt controls,
  original-signature replay hold and journal-without-host-record are exercised
  by ay-navigation.test.mjs.
- Real Session missed-receipt recovery uses the exact AY native witness with
  explicitly substituted AO lifecycle/actor identities. It clears only101,
  preserves the native uncertain row, and automatically admits the next batch
  exactly once. Request replacement during live actor read cannot clear the hold,
  mutate or charge recovery. Existing controller tests cover restored step/goal
  exhaustion, amendments, waits, user pauses and ownership changes during awaits.
- AY-B exact seven+three predicates and preserved native geometry activate
  through the production lifecycle without provider calls or mutations. Existing
  AX activation fixture supplies ownership; actor IDs are explicitly substituted.
- `offline-all.log`: required scripts/test-local.sh all exit0:103 agent,
  3926 runtime/staging,1383 mod tests; mod typecheck, Lua build and generated-Lua
  verification pass. git diff --check passes. Initial focused logs are retained;
  they exposed fixture/assertion mistakes, subsequently corrected.

Named operation.reconciled reason exact_terminal_navigation_cancelled retains
request, operation, plan and step identity, terminal receipt ref/tick and settled
state. Controller recovery traces retain reasons and bounded disposition. Existing
checker/controller tests cover stranded-controller detection; no new dedicated
navigation detector is claimed.

Native admission bookkeeping now seals exact navigation cancellation as terminal partial, using the established gather/transfer pattern. Gameplay mechanics are unchanged.
This proves the exact reconciliation regression and composed scripted harness
continuation, plus current typed activation and narrow compiled native bookkeeping. It does not establish autonomous gameplay success. Parent independent review, merged
verification and separate payload repin remain pending.

## Cleanup

Reviewed Docker runner used unique npc-static names, --rm, no network and no
Compose project. Exit traps recorded owned IDs and verified removal. Final
`docker ps -a --filter name=npc-static` returned no containers. No volumes,
networks, providers, tunnels or background agents were created. Full logs/private
baseline copies remain local and are excluded from Git.

## Independent review follow-up

Parent review found two additional consumers and durable native accounting:
next-slice dual samples and fluid preservation admission/correction still fenced
historical uncertain navigation. Host closed evidence expires at64 records;
native uncertain admissions retain capacity and pin receipts. The native
operation-admission reconciler now seals exact navigation-only cancellations as
partial/okfalse/exact_terminal_navigation_cancelled, matching established gather
and transfer bookkeeping. It does not claim reaching a destination or no effects.
Ordinary admission refresh persists that terminal state; subsequent history trim
can remove it after receipts and host closed records expire.

Legacy frozen uncertain rows are still supported at the shared host boundary.
Both next-slice samples independently re-prove exact terminal navigation against
retained host pending/closed identity and the matching live actor. Existing dual
journal identity, watermark, crafting/follow ownership and stability checks stay
in force. The three fluid candidate eligibility, unsent correction and admission
checks share the same rule without changing preservation authority or current
operation absence checks. Missing/malformed journal or receipt arrays,
duplicate/conflicting exact references, mixed mutations and changed lineage stay
fenced. Native partial rows still need exact terminal evidence before the host
can settle a pending hold; the original signature remains non-replayable.

External trial-stop policy has no host ledger and remains conservative on a
legacy uncertain row. New native terminal partial classification resolves that
for new/current runtimes; no no-host-proof exemption was added. Tick-sprint policy
only validates guard/speed evidence and does not own admission settlement.

Added composed next-slice orphan recovery with retained AY witness, mismatch and
changed-second-sample controls; fluid candidate correction/admission after legacy
navigation with unsafe signature control; and native admission lifecycle tests
covering terminal persistence, restore, receipt expiry and140 later admissions
through history eviction. New native helper controls cover duplicate receipts,
mixed slots, generation/ref/start-accounting and malformed lineage.

Updated validation (local test-results/ay-repair):
- review-runtime.log:3935 runtime/staging tests PASS, exit0.
- review-mod-2.log:1390 mod tests, typecheck, Lua build and generated Lua PASS,
  exit0. review-mod.log retained the initial fixture sequencing failure: status()
  is read-only; the corrected test persists via ordinary admission refresh.
- review-focused.log retained an exposed malformed-receipt fallback exception;
  corrected before the passing runtime gate.
- native-proof/verification.json: Factorio2.0.77 build84539 linux64 headless
  actually executed current compiled admission.status with retained AY native
  evidence and asserted partial disposition, duplicate receipt rejection and
  mixed mutation rejection. PASS marker appears in create.log after all asserts.
  Benchmark loaded that save and completed one tick. This is a narrow bookkeeping
  proof with a test-only bundle entrypoint; no live trial/gameplay success claim.
- Original compiled bundle SHA256:
  E912DF23BFE93A1E824BF191DAC685D30B32034BA4F004E3B8E1EB370EF728B0.
  Test entrypoint overlay SHA256:
  958B94073F8D332E196AB408310FAA5F952F06EB933370C7A499B9FB22D6D59F.
  Overlay replaces only the final control entrypoint with the deterministic
  fixture assertions; compiled admission implementation is unchanged. A final
  source-only comment relocation does not change executable admission semantics.
- Engine wrapper exit2 is retained: CRLF grep filename plus checking benchmark
  rather than create on_init output. Separate host verification exit0 explicitly
  validates version, positive/negative assertion source, actual PASS log and
  completed benchmark. The engine was not rerun for this evidence-script issue.
- Owned --rm container ay-native-admission-01a176d4,
  ID506c2ed55be46f5432883372e80ea032593ca67d4c4ddfde5e1ecfca2dff5dd1,
  removed. No network, Compose project, volumes, providers or tunnels created.

Parent immutable re-review, integration and separate payload repin remain pending.

Final pin-boundary audit and proof:
- task_manager.ts calls pinned_operation_batch_refs only from retain_receipt
  (native receipt mutation/pruning) and begin_or_extend_batch (new batch mutation).
  No observational RPC gains mutation; operation_admission.status stays read-only.
- Before releasing a proven terminal navigation receipt, pin calculation now
  persists only its terminal partial classification. This prevents receipt
  eviction from reviving the historical uncertain admission without a new begin.
- native-pin-build.log: focused67 admission tests, typecheck, refreshed Lua build
  and generated-Lua checks PASS. Native history test now covers pin-before-next-
  admission persistence, restore, receipt expiry and140 later admissions.
- native-pin-proof: final exact Factorio2.0.77 build84539 proof PASS, wrapper
  exit0. In addition to prior assertions it executes the current compiled pin
  helper, verifies stored partial BEFORE releasing the receipt, removes the
  receipt, and verifies status remains partial. Actual assertion marker appears
  in create.log; benchmark performs one update. This additional execution was
  required by the changed native pin path, not a retry of the prior log check.
- Final original compiled bundle SHA256:
  2AE23D8731091ACCD3364FAA58F2BBE26AF4D326DAC5AA74A90A7A7709C395CC.
  Final test entrypoint overlay SHA256:
  742D96A2DB52AEC13C0D3D41A05E6198A06FA3CA8B61BD3BBB96BFC4723784AA.
- Final owned --rm container ay-native-pin-01a176d4,
  ID17f1b6bcbdcdfbe70f38fcd6ead4c16ffcb8a1352ccacf6239d158d8efb2c479,
  removed; no network or persistent Docker resources created.
- If the host still has an unresolved hold but its required receipts genuinely
  disappeared, native partial text alone cannot clear it: host reconciliation
  stays guarded. This is honest missing-evidence handling, not fabricated proof.
