# Luna controller repair implementation checkpoint — 2026-10-06

Owner: Codex integration; bounded units delegated to continuation/protocol, lifecycle, and mod synchronization agents. Base: `1eb6172f75089d89122b101cd56aaccbeafafcd3`, `experiment/jev-agent-architecture`.

The owner authorized implementation with a five-percentage-point weekly budget, beginning at 30%, with a 35% ceiling. The last usage report jumped from 34% to 36%; the cap was exceeded by one percentage point and work was stopped. No other user tasks were running. The candidate is incomplete and uncommitted.

## Head check and stop checkpoint

At the owner's request, remote refs were fetched and inspected. Local HEAD remains `1eb6172f`; `origin/experiment/jev-agent-architecture` is `48e2f1f7`, eight commits ahead. Claude's changes include the native research-trigger ladder (`26f06640`) and reviewed G1/G2 settlement (`9b2e2e12`), including a pending-amendment hold. The remote G4 identity-rebinding deltas are proposals, not implemented fixes. Remote HEAD has not been merged into this modified checkout; working changes have been preserved.

Before resuming: reconcile the shared settlement implementation with Claude's reviewed amendment guard, preserve the single settlement authority and no operation reinterpretation, and integrate the trigger-ladder evidence. Check all three agent-owned final diffs and their targeted logs, then rerun the full runtime suite. The second full gate had 1,774 pass / 9 fail before subsequent fixes; no later complete green integration gate is claimed. Initial semantic empty-batch admission and stale executor step rejection were still undergoing narrow regression verification when work stopped. Final payload repinning, candidate SHA freeze, and deployment remain outstanding.

## Scope and authority

Luna remains the planner/executor model and Jev remains a bounded judgment layer. The harness checks declared world predicates, operation authority, correlated receipts, actor epochs, and canonical goal completion. The assisted red-to-green sequence is historical evidence only. This repair has made zero gameplay interventions and zero live provider calls. The running observer world/server and owner client mods have not been changed.

## Implemented units

- Closed-round JSON control instructions preserve proxy tool definitions and `tool_choice: none`. Conflicting plan objects are refused. Interaction classification does not receive gameplay steering.
- New live plans require aligned deterministic/semantic `stepCompletions`, validated before commitment. Research predicates require completed native research. Existing committed contracts/history remain immutable; legacy saved plans remain readable.
- Production sessions opt into completion protocol version 2; version 1 is retained for historical programmatic replay callers. Strict controller regressions explicitly exercise version 2.
- Final task retirement requires matching canonical goal identity and canonical completion. Legacy board completion alone cannot retire an active canonical goal. Unmeasured shelf nodes retain partial progress.
- A shared idle checkpoint settlement discards actions authored for a just-closed step. Committed machine monitoring is distinct from current mutation bindings. Actor/epoch/goal/plan/step fences remain required.
- Executor handoffs preserve a bounded inventory shortlist, cached recipe dependencies, and explicit unknown/stale counts. Correlated receipt refresh replaces the volatile step snapshot while preserving the committed plan prefix and conversation identity.
- One persisted fresh-context recovery per goal follows ordinary bounded repair, using existing provider guards. Further failure retains goal/evidence and pauses.
- Task execution, queue, craft snapshots, and batch ownership use synchronized serializable mod storage. Status is observational. Explicit supervisor startup reconciliation is deployment-session idempotent and retains restart cancellation policy.
- Placement candidate ordering uses deterministic merge sorting, with ranking/diversity/scan limits preserved.

## Gates and evidence

- Official Docker mod gate passed: 120 files, 1,036 tests, TypeScript, TSTL compilation, generated-Lua checks. Evidence: `test-results/luna-system-fixes-2026-10-06/mod-full.log`.
- Installer closure/parity focused gate: 15 passed; independent canonical-finalization fixture gate: 27 passed.
- Strict controller, contract, and protocol/recovery regressions passed in focused gates. Historical packets are replayed unchanged, with separate corrected replies for continuation.
- Full integrated runtime gate is still being reconciled. Earlier failures and every rerun are preserved under `test-results/luna-system-fixes-2026-10-06/`; a focused pass does not substitute for this gate.
- Isolated real-Factorio image built. Native lab research, placement/smelting, handcraft accounting/cancellation, persistence, death recovery, navigation, and crafting restart passed in bounded scenarios without network access or published ports. Evidence is under `engine-evidence-2` and `engine-evidence-3`; corrected restart chain exited 0. Earlier runner mistakes remain logged. These proofs do not establish autonomous green-science success. Maximum-radius query follow-up was requested; verify its final status before claiming that gate.

## Remaining acceptance gates

1. Finish integration failures and rerun the complete Docker runtime/mod gates.
2. Review and freeze candidate source, regenerate/repin the immutable installer payload, and verify payload/package checks against the exact candidate.
3. Separately obtain authorization for the fresh Luna/Jev run: existing starter kit; 45 minutes, 60 main-provider calls, 120 Jev calls, normal speed, natural resources, zero connected humans. Require native red production/consumption, completed `logistic-science-pack`, enabled green recipe, and consistent completed canonical goal/board. Record all interventions; gameplay takeover disqualifies success.
4. Owner-operated matching-client multiplayer gate: idle join, pre-craft join, mid-craft join, polling, objective ingress; five join/leave cycles per case. Require stable actor identity, receipts, and CRCs; capture paired reports on failure.

Task-state persistence is a source-supported synchronization defect. Attribution of the historical recorded desync remains unconfirmed until reproduced. Maximum-radius placement performance and multiplayer desync are separate checks. No autonomous milestone or multiplayer reliability success is claimed at this checkpoint.
