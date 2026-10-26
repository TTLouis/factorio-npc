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

No native mechanics changed, so no new native-engine build/run was performed.
This proves the exact reconciliation regression and composed scripted harness
continuation, plus current typed activation. It does not establish a new native
engine result or autonomous gameplay success. Parent independent review, merged
verification and separate payload repin remain pending.

## Cleanup

Reviewed Docker runner used unique npc-static names, --rm, no network and no
Compose project. Exit traps recorded owned IDs and verified removal. Final
`docker ps -a --filter name=npc-static` returned no containers. No volumes,
networks, providers, tunnels or background agents were created. Full logs/private
baseline copies remain local and are excluded from Git.
