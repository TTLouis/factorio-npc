# Run AR hand-mining and partial-batch harness repair

Owner: Codex /root chat01a16ab4. Task: `fix/run-ar-mining-reconciliation` at
`D:/SideProjects/airi-factorio-npc/.worktrees/fix-run-ar-mining-reconciliation`.
Source: local Jev candidate `18509c77033a89af3e810f1dc1ea7f1a9d6127ff`;
its runtime/native tree is the AR tested candidate `2f5f5282`. Cached published
Jev remains `b9574fc4`; this task's remote lookup failed DNS. No publication,
deployment, live provider/Jev trial, or changes to sealed AR evidence are included.

## Failure and harness ownership

AR admitted copper ore x10 and coal x10 in one four-task batch. Copper finished;
coal failed `mining:mining_rejected`, leaving the whole batch
`admitted_cancelled/partial_unknown`. The duplicate guard correctly prevented
uncertain replay, but the harness could not reconcile the acquisition or continue.
The immutable checkpoint required copper ore >=10, coal >=10 and the held furnace.

The original report did not establish the native rejection cause. Read-only-save
diagnosis on Factorio 2.0.77 establishes it: at coal (-90.5,-30.5), all nine native
selection probes selected overlapping `tree-08-red` (-90.9375,-29.625). The existing
exact native selection fallback excluded resources. Repeated closer walks could
not fix the selection identity. The fix binds the exact observed resource through
native selection after the bounded probes, with the existing reach, standalone
actor, validity and surface fences. It does not remove the tree, teleport the NPC,
insert a yield or replace real mining time.

Preserved inputs: `deploy/pterodactyl/runtime-v8/fixtures/run-ar-mining.json` contains
the original immutable goal/shelf/plan/contracts, exact native admission/receipt,
three complete recorded executor replies and the original failure event shapes.
The fixture labels its scheduling rewind, reattached original operation arguments,
new surface metadata from the restored-save proof, and simulated future callbacks.
Historical report: `RED_AUTOMATION_LIVE_RUN_AR_2026-10-23.md`. Original retained
evidence is in the detached `feat-e2e-tick-sprint` checkout; it is never overwritten.

## Shared prevention and residual correction

Native admission and runtime reconciliation now agree on a narrow terminal partial
class: an exactly correlated acquisition-only batch (`gather_resource` and/or
`mine_resource_at`), with its exact queued-task layout, same generation and sealed
mining cancellation. This is partial acquisition, never whole-batch success or
proof that a failed mining task yielded zero. Mixed mutations, missing receipts,
wrong lineage and uncertain outcomes retain their hold.

At a real failure callback or an executor wake after a missed callback, the harness:

1. Checks the immutable step, current actor/epoch and original surface, native idle,
   persistent controllers, crafting, condition waits, amendments and user stops.
2. Reads complete native inventory and mining products. Only deterministic,
   hand-mineable, single-item resource yields matching the inventory checkpoint
   qualify. Preserved stock outside this acquisition must still be held.
3. Computes only the checkpoint deficit, bounded by the admitted quantities. It
   never repeats the completed copper prefix. An already-satisfied checkpoint goes
   through the ordinary fresh evaluator and Plan Tracker close exactly once.
4. Persists a recovery claim before settling the effect hold, then submits the
   missing acquisition through ordinary preflight, authority and native admission.
   The native callback owns the next wake. Lost acknowledgements are reconciled;
   unsupported preflight/native outcomes pause instead of asking a model to repair.

Recovery limits are supplementary: two claims per immutable step, six per goal,
128 retained goal records. Restage/restart cannot renew them. A crash between source
settlement and successor admission restores to an explicit guard pause. Existing
provider, wall-time, observation, no-progress and campaign guards remain in force.
The scoped bypass of a *closed, terminal gathering* duplicate signature is available
only to this fresh-deficit path; ordinary model replay and transfer/mixed partials
remain fenced. Unknown or absent surface metadata cannot authorize recovery.

The owner's follow-up also requests harness-owned correction of nearby bad mining
coordinates. Native preflight offers a deterministic same-resource, same-surface
candidate within **five tiles** when an exact resource cell is absent/depleted or
insufficient. For an unchanged inventory-acquisition step, the harness can take that
candidate through normal validation/admission without an executor retry. It shares
the durable recovery limits, cannot chain coordinate hops, and does not substitute
an exact entity or player-built structure. Surface identity is checked across host
awaits, atomically at native admission, and on the native mining task itself.

The executor receives a position reminder in its conversation and durable step
receipt tail. The reminder survives restore/restage and grants no completion proof.
Named traces distinguish residual detection, fresh deficit, continuation, position
correction and exhaustion. The checker recognizes both AR's original unresolved
partial shape and corrected continuations across request restages.
An all-met inventory read does not clear the checker finding. Only an admitted
missing-effect continuation or the operation-correlated `gather.checkpoint_closed`
event does so; the latter follows ordinary verified closure. A stock-change and
interrupted-trace regression proves an unsuccessful close remains visible.

## Acceptance and evidence

- [x] Exact runtime negative controls on unchanged `18509c77`: three expected failures
  (terminal reconciliation, real Session continuation and coordinate correction).
- [x] Exact native-source unit negative control: the coal-selection assertion fails
  on unchanged source, rather than on a missing API or fixture setup.
- [x] Unchanged Factorio 2.0.77/save negative control reproduces `mining_rejected`
  with zero coal, ten copper ore and the tree intact.
- [x] Real Session regression drives the native failure line through settlement,
  deficit admission, native completion and verified advancement without model repair.
- [x] Safety matrix covers partial yield, already-met checkpoint, stale actor,
  signature/ordinal/generation/task witness, surface changes during awaits,
  missing surface metadata, unreadable inventory, pending/mixed effects, native
  queues/follow/crafting, waits, amendments, cancellation, lost acknowledgements,
  native refusal, restart/restage and durable exhaustion/interrupted claims.
- [x] Deterministic native residual proof deliberately bypasses exact selection for
  a new current-epoch copy of AR's exact copper/coal batch, then verifies harness
  coal-only continuation and physical yield. Old-epoch historical work stays held.
- [x] Native nearby-coordinate correction, intact-tree proof and atomic surface
  refusal pass with zero external inference. The broader science goal is unproven.
- [x] Final immutable candidate, payload pin, full offline gates and lint recorded.
- [x] Independent final review, local integration and fresh merged gate recorded.

Full commands, actual exits, captured native transcripts, baseline controls and
machine-readable closeout are retained under
`D:/SideProjects/airi-factorio-npc/.worktrees/fix-run-ar-mining-reconciliation/test-results/run-ar-mining-reconciliation/`.
Static checks do not establish
autonomous science production or recovery for arbitrary mixed/uncertain mutations.

## Build checkpoint

Complete and merged locally. Reviewed source candidate:
`d332703af7c2aca1db62b668930fa0a3e6688e94`; fresh tested integration merge:
`60af51084303fef50ed99b96b779cd6735e3bd17`. The subsequent closeout commit changes
this report only. Code owners are the native selection/admission boundary, runtime
reconciliation/ledger and executor lifecycle. Planner prompts and Jev judgments
have no correction or completion authority.

| Gate | Result / evidence |
| --- | --- |
| Exact unchanged runtime controls | Three expected failures on `18509c77`; `baseline-runtime.log` |
| Exact unchanged native unit control | Expected exact-coal-selection assertion failure; `baseline-mod.log` |
| Unchanged native 2.0.77/save | `mining_rejected`, coal 0, copper 10, tree intact; `native-baseline.json` |
| Scoped runtime matrix | 41/41 pass, including exact Session failure/callback and changed-stock checker case; `targeted-final.log` |
| Candidate full offline gate | 3,302 runtime + 1,378 mod, typecheck, Lua build/generated-Lua pass; `all-final-candidate.log` |
| Fresh merged offline gate | Same 3,302 + 1,378 and type/Lua pass; `all-merged.log` |
| Final changed-code ESLint | Zero errors/warnings, including executor loop; `lint-changed-final.json`, `lint-loop-candidate.json` |
| Installer | Nine payload tests, generator check and shell syntax pass; `payload-merged.log` |
| Real native candidate | Four cases pass, zero external inference; `native-final-result.json` and `native-final.log` |
| Independent review | `/root/review_ar_repair` approved immutable `d332703a`, no remaining blockers; source/log inspection, no reviewer rerun |
| Preservation and cleanup | 216 sealed AR files and five integration reports unchanged; 12 recorded container IDs and 23 script names absent; `cleanup-final.json` |

Reproducible primary gate: `bash scripts/test-local.sh all` in each frozen checkout.
The targeted, baseline and payload scripts in the evidence directory use the same
reviewed Docker mount/cleanup contract and cached `npc-dev`, with network disabled.
`build-native.sh` compiles the committed native source/guard in that cached image;
`run-native.sh` and the committed `tests/factorio/runner/run_ar_mining_factorio.mjs`
run the isolated saved-world proof in cached `factorio-npc-test:final` at 2.0.77.
The final acceptance commands in the table exited zero; baseline controls retain
their intentional failures. Earlier diagnostic/fixture attempts remain in the
evidence directory and are not counted as passing acceptance runs.

The native test loads the original save into a new disposable deployment epoch;
historical epoch work remains held. It admits a new current-epoch copy of the exact
AR batch and uses a test-only compiled shim to inject the coal-selection miss.
The failure physically leaves copper 10, coal 0; after disabling the shim, the real
failure lifecycle admits only coal 10, mines it natively and advances the checkpoint.
The separate coordinate case removes the previous case's coal as an explicit fixture
setup, then proves physical mining and the durable executor reminder. An isolated
surface teleport is used only for the atomic refusal negative case. None of these
fixture actions is claimed as autonomous gameplay or production progress.

The installer ships `gather-recovery.mjs`. Its immutable payload ref is
`b982ba96559e16ddad6e0cae2708d52b5512b7bd`, SHA-256
`31be67220bbf0a7e6f6f836780b8a9f41652c5f3f6954a50c71144c83514857f`;
repin commit `0da1c9e7`. The channel still resolves its selected source independently.

`final-summary.json` provides machine-readable counts, identities, evidence sources,
test durations and limits. The native transcript has 664 RCON entries; its event
counts are separate from recoveries. There is one operation-key-scoped residual
recovery and one separate coordinate correction, both physically completed, with
zero model repair calls. Whole-test runtime durations are measured; aggregate
mining/host-poll subdivisions are unavailable and concurrent gates are not added.
NPC provider/Jev requests and incremental provider charges are zero for this offline
proof. Codex author/reviewer usage is separate and unavailable; no thinking duration
is inferred from request latency.

No new live trial, publication, push or deployment occurred. No owned containers,
networks, named volumes or background work remain; pre-existing shared images and
host evidence/saves are retained. Autonomous red-science production remains unproven.
