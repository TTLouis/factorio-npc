# Factory cell physical lifecycle, October 29, 2026

Status: implementation and focused deterministic proof in progress. This document
does not establish native gameplay success, full tracker completion or permission
for a trial, publication or deployment.

The host ledger in
[factory-cell-lifecycle.mjs](../../deploy/pterodactyl/runtime-v8/factory-cell-lifecycle.mjs)
preserves the original cell assignment and membership history. Its operational
projection supplies the current installation to observation, dependency and
admission callers. A change degrades the installation before any operation; native
receipt reconciliation changes its residual members. Final installation proof is
separate from commissioning. Retirement retains an empty installation tombstone,
the original assignment and all native evidence.

Each transaction freezes the registry revision, lifecycle event sequence, exact
affected cell revisions/digests, transitive consumers, operations, owner and bounded
action allowance. Claiming an operation precedes native submission and must be
persisted. Each received native result must likewise be persisted before clearing
the ordinary pending guard or authorizing subsequent work. Restart replays the
hash-linked host ledger; it cannot silently renew an allowance or resend a claim.

Removal success requires the original protocol-2 identity, session, exact native
target and quality, a completed singleton batch, and recomputed item custody:
the actor's inventory must equal its previous inventory plus the target's native
contents and native removal products. Native boolean success or disappearance is
insufficient. Empty fluidboxes are explicitly proven by the native snapshot;
unsupported contents domains remain unavailable. Placement uses the existing
qualified placement receipt derivation and requires the intended exact prototype
and position.

A false removal return may partially transfer contents. Such an attempt remains
held until fresh evidence proves the exact remaining target, actor inventory,
consumer status and recovery capacity. Only conserved contents can release that
attempt for a bounded new claim. Unknown custody, missing journals, changed owner,
busy native work and exhaustion remain fenced. A safe hold is not successful
repair.

Temporary assets require a durable pre-placement intent specifying purpose,
beneficiaries, the exact placement operation/member and a retirement condition.
A second durable event binds the original protocol-2 pending operation before
submission. Classification reads the private canonical placement store and matches
the qualified receipt's plan, semantic step, request, operation, prototype, position
and scope. Previously retained placements are excluded; supplied receipt labels
cannot classify an unrelated permanent asset.
Verified completion of every beneficiary schedules reconciliation only. Actual
cleanup additionally requires complete native consumer coverage, proven redundancy
and the same custody transaction used for ordinary retirement. Idle machinery,
an empty declared graph or omission from preserve is never sufficient.

## Focused evidence and remaining verification

[factory-cell-lifecycle.test.mjs](../../deploy/pterodactyl/runtime-v8/factory-cell-lifecycle.test.mjs)
uses labeled synthetic native records and the real operation signature,
reconciliation and placement receipt helpers. It covers strict durability,
tombstones, wrong/lost custody, native identity and owner fences, busy state,
restart and duplicate exclusion, consumer/capacity refusals, same-job expansion,
temporary beneficiaries and bounded partial-removal reconciliation/exhaustion.
Synthetic counts are not game recipes or capacity facts.

Sixteen focused tests now pass, including the actual canonical facade,
`NpcAgentLoop.persistState` and shared `settleOutstandingOperation` boundary.
Controlled filesystem tests prove that native custody is persisted with the old
pending guard before that guard clears, and a failed write can persist the same
receipt on a later settlement without executing native work again. They also cover
expansion followed by metadata bound to an added member, two-phase persistence,
cold restore, common mutation admission and rejection of stale physical/metadata
revisions. Controlled I/O proves ordering and serialized content, not OS durability.

Early independent review identified two gaps: temporary placement provenance
binding, and partial receipts classified without a correlated terminal batch.
Both are fixed. Partial/refused results retain and revalidate the exact admission
and cancelled singleton mining batch, including attempt/signature/ordinal,
generation, batch reference and terminal tick. Wrong, expired or missing journals
stay uncertain through settlement, residual reconciliation and attempted admission.
Residual custody uses the same bounded before/after inventory, aggregate contents,
duplicate-index, slot and empty-fluid-domain checks as successful removal.

Original retained native removal receipts were replayed unchanged through the host
custody verifier. Exact empty and quality-bearing native positives pass; capacity,
fluid/working-target and unsupported-item refusals remain negative. This exposed
and corrected the native empty-Lua-sequence JSON representation (`{}`); receipt data
is retained unchanged. This replay is parsing evidence, not a host-authorized native
lifecycle transaction.

Required verification still includes actual native expansion/removal/cleanup with
complete evidence, exact partial-effect continuation through the runtime, independent
review and the repository's candidate and merged gates. Complete native consumer
coverage and final job-preservation evidence must come from supported native facts;
callers cannot manufacture completeness from declarations. Changed actor, epoch,
session or request cannot reuse an old transaction's live capability. A restart
requiring ownership rebinding needs fresh host revalidation before continuation.

Local raw logs and checkpoints are under the shared workspace's
`test-results/factory-tracker-stack-20261029/continuation-lifecycle/` and remain
unstaged. The separate paused getter probe under `continuation-native-progress/`
measures getter availability only and makes no production or delivery claim.

The fresh-host rebind now preserves the original owner, appends owner lineage,
and retains the same operation IDs and action allowance. Canonical goal/plan
semantics plus the durable operator-control revision must remain unchanged.
Exact native idle ownership, known admission journals, retained custody and
fresh exact-locator absence corroboration are required. Prepared, uncertain or
pending native effects remain held. Canonical restart/restage and refusal tests
pass; this is not yet an engine restart proof of the complete host controller.

The internal lifecycle controller acquires native removal readiness, direct item
consumer coverage and current assigned-output capability through the existing
host observation fences. Shared pre-send acquisition refuses removal of the
last verified producer. Temporary support cells have no invented products: their
one-member declaration is bound to a qualified retained placement and a durable
pre-placement temporary intent. A private evaluated-checkpoint capability drives
beneficiary completion, automatic cleanup and final tombstone reconciliation.
Nested step closes defer while the controller is active; the original checkpoint
is re-evaluated after physical changes. Partial-effect acquisition uses the
separate exact-pending, read-only reconciliation seam.

Current focused evidence includes `continuation-lifecycle/residual-controller-03.log`
(20 lifecycle tests) and `controller-02.log` (3 controller tests), including
canonical temporary-support restore and actual host acquisition with strict
filesystem persistence. The composed exact-pending residual test exercises the
real read-only native seam and strict partial-ledger release; a mismatched native
signature stays held. Automatic cleanup through the full close hook and the new
native driver still require their composed execution proof. The syntax-checked native driver is
`tests/factorio/runner/factory_cell_lifecycle_factorio.mjs`; it queries fixture
recipe/fuel/placement facts live, exercises guarded expansion/removal, and calls
the actual deterministic step-close path for temporary cleanup. It has not yet
passed a native run. Electric/fluid/heat consumer cleanup remains unknown unless
the corresponding complete native evidence is supported; empty metadata or idle
machines never prove redundancy.

The first native host diagnostic stopped before its first placement because the
script had constructed the default planner context without the normal executor
handoff. The driver now calls the production `startExecutorAtCommit` C3 path and
requires an executor context with the planner parked. The planner mutation guard
is unchanged. `continuation-lifecycle/executor-handoff-01.log` passes all four
controller tests, including that real handoff and unchanged goal/plan semantics.
The failed diagnostic remains failure evidence; the corrected native path still
needs execution.

Independent review also found that a complete direct-item consumer scan was
being promoted to general consumer coverage. The controller now requires a
supported native member type and explicit native absence of electric, heat and
fluid interfaces; non-item output ports and contradictory native production facts
refuse. Complete power-component topology alone is not service-consumer proof.
Actual controller regressions cover unregistered power/fluid consumers and unknown
interfaces. Plain temporary-container cleanup remains positive, including native
empty Lua arrays. `consumer-domains-01.log` passes 25 tests; the final empty-array
regression passes all five controller tests in `consumer-domains-02.log`. The
unchanged diagnostic-01 native furnace reply also supplies every required absent
service-interface fact; this corroborates schema compatibility, not gameplay success.
