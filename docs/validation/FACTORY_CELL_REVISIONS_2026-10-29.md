# Factory cell metadata revision prerequisite

Problem and observed trigger: cells were fixed at revision one, so there was no
atomic host path for appending exact declared input bindings and dependency
metadata while retaining immutable physical assignments and provenance.

Owner / task branch / source SHA: Astra implementation, Sol review, parent
integration; `feat/factory-cell-revisions`, based on
`36431a95522e62093c7fc2664f1a7f212f182487`.

Requested outcome: additive metadata CAS/history through canonical memory and
the actual guarded persistence pipeline. No model write tool, physical update,
runtime recipe facts, retirement, cleanup, commissioning or recovery behavior.
Native requirement observation is owned by the separate native-input task.

Acceptance evidence is the host Node suite `factory-cell-revisions.test.mjs`,
the original enrollment regression plus the registry/runtime/dependency/read-tool
suites. It covers multiple edges per transaction, supplier CAS, immutable goal and
member state, exact typed endpoint declarations, legacy restore, full history
prefixes, corruption, duplicate conflicts, capacities, actual queue/WAL/rename
failures, lost acknowledgements, stale scope and real operator pause/replacement
request persistence. Filesystem hooks model deterministic I/O boundaries, not
power-loss durability. Full logs stay in the owner's local evidence directory:
`test-results/factory-tracker-stack-20261029/factory-cell-revisions`.

Invariants: no gameplay authority; native busy/pending/uncertain and stale
actor/world/session/request/plan fences; immutable goal, assignments and physical
members; retained transaction IDs/history with no budget resets. No providers,
Docker resources, deployment or live trial were used by this implementation.

Restart reconciliation: versioned pending markers retain the exact predecessor,
request and owner scope. Cold restore recomputes one candidate, accepts only an
exact predecessor or candidate digest, clears observation caches and emits
`factory_metadata.reconciled`. The predecessor discards the uncommitted intent;
the candidate retains unverified metadata and its transaction history. Neither
path replays gameplay or restores an old capability. Unknown/conflicting markers,
explicit persisted faults and restore during a live publication remain blocked.
Repeated cold normalization is idempotent; a normal save durably clears the marker.
Cold rollback of a wholly self-consistent file needs an external watermark and
is not solved here. Failed initial prepare persistence leaves the old valid
registry. A staged candidate is retained behind fault on later failure; no
best-effort fault write is presented as guaranteed when storage is unavailable.

Checkpoint: uncommitted prerequisite patch; parent owns full offline gates,
installer payload repin, integration and any native evidence. Passing this stage
does not complete the full factory tracker or authorize the parked focused E2E.

Earlier host result: `focused-07.log` passes all 197 registry, revision,
dependency, enrollment, observation/tool and cancellation tests; `git diff
--check` passes. The broader `focused-06.log` has 201 passes and 13 failures in
the existing skill disk-restart suite, each blocked by sandbox temporary-file
rename `EPERM` (including its intentional-directory-error assertion receiving
that earlier error). Those disk tests still require the parent-owned offline
gate; mocked I/O tests are not substituted for them.

## Continuation prerequisite verification

Evidence directory: the workspace's local
`test-results/factory-tracker-stack-20261029/continuation-revisions`.
`focused-04.log` passes 235 tests across revision, registry, dependency,
enrollment, observation/tool, cancellation, blocked-stop and auto-resume suites.
`focused-03.log` additionally exercised intake-retry: seven host disk cases
failed sandbox temporary-file rename `EPERM` or its dependent missing-file
assertions. The parent-owned Docker gate remains required for those cases.

Failure class and owner: canonical pause acknowledgement previously could hide
a stale-snapshot write refusal. The preserved partial patch already added three
fresh ordinary-snapshot attempts and strict pause persistence; this continuation
completes supervisor cancellation and ownership fences. Actual second-write
`recordNpcPlacement` interleaving now saves the paused fresh snapshot. Repeated
churn exhausts after three writes; I/O errors remain visible. The pause stops only
its unchanged owner, with `goal.pause_save_failed` carrying original correlation.
`Session.queuePlayerRequest` still cancels that owner's native work on save
failure, but fences a changed cancellation generation, actor, epoch, session,
agent or goal across save and authorization awaits. A late stale failure cannot
enter generic request-error recovery against the replacement goal.

`baseline-01.log` runs unchanged sealed STOP runtime files over base
`36431a95522e62093c7fc2664f1a7f212f182487`, with the new test file only. Both
selected tests fail for the intended old behavior: actual Session native cancel
count is zero after save exhaustion, and a complete candidate marker faults at
cold restore. The sealed STOP source already includes the initial snapshot retry
fix; this is not a replay of the earlier unsealed swallowed-fence implementation.
The new second-write test exercises the actual persistence queue and pause method,
with controlled filesystem boundaries; no OS power-loss or native gameplay claim
is made. Original historical logs remain unchanged.

Residual and safety coverage includes known predecessor/candidate outcomes,
lost acknowledgements, conflicting markers, exact duplicate/conflicting duplicate
transaction IDs, history capacity, multi-input and multi-supplier transactions,
cycles, reverse impact, and actor/epoch/session/request changes after WAL rename.
The parent owns full candidate and merged gates, independent review, payload pin
and integration. This source freeze is only the revision/persistence prerequisite;
physical lifecycle, commissioning, cleanup and same-goal gameplay recovery remain
separate full-tracker requirements.
