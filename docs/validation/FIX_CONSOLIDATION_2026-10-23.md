# Jev fix and workspace consolidation — October 23, 2026

Owner: Codex /root chat01a16ab4. Scope selected by the owner: **consolidate first;
prepare the next patch**. No runtime implementation, new trial, push or deployment.

## One candidate, explicit proof levels

The consolidated executable baseline is the Run AS candidate
`cdbc95eda101e6c2f559c0e2848bcaa923df1be6`. Reviewed AS report `e9f6002c` was merged
as `54efda35`. Historical reports and this consolidation change documentation only;
runtime/native bytes and payload remain unchanged. Published Jev was last verified
as `b9574fc4556eafb431f158ebee80fe3f1807a02d` before Run AS. No history is squashed or
rewritten, and no unpublished source is claimed published.

The working integration checkout remains `og-port-integration`, the existing
temporary checkout for the sole development destination
`experiment/jev-agent-architecture`. The primary checkout has protected local
documentation edits and is retained without branch switching, reset or stash.

| Shared boundary | Consolidated changes / anchors | Evidence and remaining limit |
| --- | --- | --- |
| Observation decisions and fact delivery | AJ recovery-budget and post-placement facts; `8477c9e7`, `e406a8d6`, `3920dfaa`, `6b8f0287`; `state-scopes`, observation budgets, handoff/topology/post-batch facts | Composed/static/native gates retained. A durable locator still does not grant a fresh executable exact identity. |
| Async ownership and native fact reuse | Preventive consolidation `ab47531d`; scope fences, shared native facts, topology evidence | Superseded callbacks cannot write replacement state. Keep these fences when adding any refresh. |
| Admission, receipts and step progress | Multi-batch contracts `3e937fe9`, AM receipts `dbcbd837`, fresh checkpoint self-correction `19c4c42f`; operation ledger/reconciliation and ordinary close evaluator | Partial/uncertain effects remain fenced. A closed checkpoint, not a model statement or admission, advances progress. |
| Finite production and material deficits | `cd757d8b`; `production-task`, `production-task-runtime`, quantity/material accounting and advisory next-contract prediction | Native finite acquisition/crafting/smelting/collection proven. Sustained automatic factory output remains unproven; AS exposed an exact-binding integration gap. |
| Idle/resumed-controller liveness | AO repair `bf773cac`; supervisor/native idle reconciliation and stale prediction fallback | Bounded same-owner continuation has offline proof; no bypass of intentional guard/operator pauses. |
| Native construction and resource mechanics | Area reservation `0f056a4d`, earlier placement/transfer/water work; native authority remains in `packages/autorio` | Exact-version proof is retained per task. These changes do not establish broad autonomous production. |
| Mining prevention and residual reconciliation | AR repair `b982ba96` plus checker timing `d332703a`; exact native selection, `gather-recovery`, acquisition-only partial receipts | 41 runtime/12 added mod cases and four native cases pass, including injected residual continuation. AS mined normally and exercised none of the new correction paths. |
| Bounded world acceleration | `adcf08ed`, startup repairs `64922f0a`/`a1b59a70`; native guard, shared boundary barrier and host watchdog | Native lifecycle proof retained; AS had 19 restored bursts. Expected stop closure still emitted one alarm during confirmation. |

These are already merged changes, not pending branches to merge again. Do not
cherry-pick old fix heads over this candidate or let a new patch create a parallel
completion/replay rule. The next patch should join the existing observation,
owner, admission and production boundaries described below.

## Current proof summary

The last executable candidate passed 3,302 runtime / 1,378 mod tests, typecheck,
Lua/generated-Lua, payload tests and independent review. The immutable payload ref
is `b982ba96559e16ddad6e0cae2708d52b5512b7bd`, SHA-256
`31be67220bbf0a7e6f6f836780b8a9f41652c5f3f6954a50c71144c83514857f`.

The required merged `scripts/test-local.sh all` gate was also rerun during this
consolidation: 3,302 runtime / 1,378 mod tests, typecheck and Lua checks passed.
Its two uniquely named containers are confirmed absent, including stopped state;
the archive directory retains the gate log and resource-verification JSON.

[AR repair](RUN_AR_MINING_RECONCILIATION_FIX_2026-10-23.md) proves the exact
regression, composed harness correction and physical mining separately from
autonomous science production. [Run AS](RED_AUTOMATION_LIVE_RUN_AS_2026-10-23.md)
failed after 450.707 seconds at furnace identity renewal: 10 copper plates smelted,
zero science. Its eight control-retry episodes are five continuations and three
failures; they are not eight successful harness corrections. New mining recovery
paths were unexercised. Stop/save/pristine 2.0.77 load/cleanup passed.

## Workspace and evidence ownership

Inventory: 54 registered worktrees before cleanup. Forty-two task checkouts were
selected for full backup; 41 are authorized for retirement under the present owner
cleanup request. They are all direct children of the shared `.worktrees` directory.
Every HEAD is absorbed into `54efda35`; nine checkouts have only an untracked historical
validation report. Those reports were copied byte-identically into integration;
the five existing integration reports also retain their original bytes.
Git normalizes CRLF to LF in two committed report blobs under the existing policy;
the exact original working-file and archived bytes remain preserved. The archive
index records that distinction and verifies no other blob differences.

The primary, integration, ten unconfirmed legacy checkouts and
`feat-planner-executor-contracts` form the protected 13-checkout set. That last
checkout still has historical side-chat/report ownership ambiguity and is retained
despite verified absorption and backup. Old registry entries are not represented
as explicit prior releases. An absorbed HEAD alone is insufficient to take another
owner's active checkout. Their contents/branches are not modified by this cleanup.

Full selected working files, ignored evidence/saves, staging patches and exact
HEADs are captured in private ZIPs and a self-contained Git bundle before removal.
Every file is hashed inside its archive and again against source; independent
bundle restoration and full Git object checks must pass. Removal rechecks exact
paths, owner selection, branch/HEAD/index, locks and all current Docker bind mounts.
No linked directories or embedded repositories are traversed or removed.

Recovery index and live progress:
`D:/SideProjects/airi-factorio-npc/branch-archives/2026-10-23/README.md`,
`cleanup-plan.json`, `bundle-recovery-verification.json` and `final-verification.json`.
The payload directory is restricted to the Windows owner and SYSTEM. It may hold
private local material and must never be committed or published.

AR/AS evidence remains directly accessible under this checkout's ignored
`test-results/red-automation-live-2026-10-23ar` and
`test-results/red-automation-live-2026-10-23as`. Full mirrors were file-hash checked,
including AR's 216 and AS's 222 sealed inputs. They are historical evidence;
copied runner scripts do not authorize another trial. Older retired paths are
resolved through the archive index; restores must use a new empty approved path.

## Checkpoint

- [x] Audit Git, owner records, ignored files, links and mount metadata.
- [x] Absorb the reviewed AS report; preserve 14 historical reports unchanged.
- [x] Copy and verify current AR/AS evidence for continued use.
- [x] Verify all 42 full archives and standalone bundle restoration.
- [x] Independent deletion-safety review and guarded retirement: 41 removed; 13 retained.
- [x] Confirm final retained set, branch/ref recovery and protected hashes.
- [x] Commit the consolidated status and reviewed next-patch plan.

Closeout: 41 checkouts retired, 32 already-absorbed task branches deleted through
Git's normal guard, nine retired checkouts already detached, and all 42 recovery
refs retained. The 42 full snapshots total 1,419,268,302 bytes, plus the standalone
78,401,647-byte bundle. Final verification checks the actual documentation commit,
clean integration status, unchanged executable paths, all retained checkout
identities and the protected primary bytes. Independent final review approved.

The scoped implementation proposal is
[Run AS next patch](../RUN_AS_NEXT_PATCH_PLAN_2026-10-23.md). It is not implemented
by this consolidation and does not authorize a new live test.
