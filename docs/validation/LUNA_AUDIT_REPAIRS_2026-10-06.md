# Luna harness audit repairs — October 6, 2026

Owner-authorized repair of the five defects reported by `Audit runtime planning harness`, checked against clean integration baseline `9c8db7a808f4ad6cfd0bd2c645766758b2718028`. This is a scripted-provider repair checkpoint; no live Luna/Jev run or production deployment is authorized by this unit.

## Build checklist

| Unit / owner | Scope | Commit | Status |
| --- | --- | --- | --- |
| Planner boundaries / audit_planner_fixes | Goal/actor completion fences, fatal provider diagnostics, Jev-only routing quota | Units `e2e005ee`, `94672d1c`, merge `3128bb45` | Review blocker fixed and re-reviewed; unit runtime 1,835 passed; combined integration all 1,846 runtime / 1,036 mod passed |
| Receipt reconciliation / audit_receipt_fixes | Correlated historical completion after restart; reject unsupported new receipt contracts | Unit `20df5a15`, merge `95b545fb` | Independent review: no blockers; integration all passed (1,834 runtime / 1,036 mod, typechecks, generated Lua) |
| Reservation / audit_budget_fixes | Atomic concurrent provider reservations | Unit `89801667`, merge `abcdb1d9` | Independent review: no blockers; integration all passed (1,828 runtime / 1,036 mod, typechecks, generated Lua) |
| Native fixtures / parent | Shelf evidence, unmet checkpoint, isolated controller worlds/restart and explicit native save | Units `6bcee04a`, `fdbbc161`, `31b669f1`, `c1ce5eca`, `ffec8df5`, `e3e4be55`; final merge `8b6f25d4` | Independently reviewed; final native resilience verdict recorded below |
| Integration / parent | Independent reviews, sequential merges, installer repin, official Docker all/build/payload gates | Code candidate `8b6f25d4`, payload source `3128bb45` | Final static/native gates recorded below |

## Acceptance

- Changed actor or canonical goal cannot inherit old goal evaluation or baseline writes; stable and intentional force-only evaluations remain valid.
- Fatal provider refusals cannot become executable plans through normalization or salvage.
- Typed-only interaction routing makes zero main-provider reservations; actual language fallback reserves once.
- Fully correlated completed historical work settles after restart; missing/mismatched evidence and unfinished old-generation work remain guarded.
- Concurrent final-slot reservations admit exactly one; persisted counts, rollover and recovery reserve remain correct.
- Unsupported newly authored wait/research receipt declarations are rejected; native research completion remains available and legacy saved contracts remain intact.

## Boundaries and evidence

Durable shared campaign allowance design remains separate unfinished work. This repair preserves existing guards and does not choose new quota units or numeric limits. Autonomous red-to-green science, repeatability, automated production and multiplayer acceptance remain open.

Starting weekly usage snapshot: 8% used; first completed unit snapshot: 9%; reviewed integration snapshot: 10%; final native verification snapshot: 12%. The four-percentage-point increase remains within the owner's five-point budget. Snapshots are account-wide evidence, not per-agent billing.

## Implemented behavior and review

- Goal evaluation carries canonical goal/definition, runtime generation/context lineage and authoritative deployment session/actor/epoch identity. Reads and baseline/satisfaction writes are fenced; satisfaction persistence and terminal settlement trace awaits are checked before subsequent writes and request cleanup. Stable evaluations and unchanged force-only no-body death gaps remain supported. Extra bounded deployment-status reads are intentional.
- Fatal provider filtering is rejected before plan extraction or salvage. Normalized messages preserve non-enumerable provider diagnostics and closed-round metadata. Mock HTTP runs through the real adapter; valid and salvageable filtered replies produce no executable plan.
- Jev-only routing does not reserve main-provider quota, even when that quota is exhausted. Language fallback reserves once immediately before the actual call.
- Cross-generation completion requires exact admission key/attempt/signature/actor/epoch/ordinal/count, full ordered successful slots, and matching completed receipt references for queued work. Empty references retain the mod's existing synchronous-slot meaning. Missing/mismatched evidence and unfinished work remain held. Historical settlement does not manufacture board or goal progress.
- Newly authored `stepCompletions` reject unsupported receipt predicates, including `wait` and `research_technology`, using the same strict operation policy as the verifier. Native `research_completed` remains supported. Existing saved contracts and standalone legacy checkpoint compatibility are preserved without inventing completion proof.
- Provider reservation queues cover the entire read/check/increment/write transaction per resolved path, including rejection-safe cleanup. Independent files progress separately. This is process-local protection for the source-supported single-supervisor deployment; cross-process, symlink aliases and shared-host locking are not claimed.

The independent reviewer found a post-persistence/terminal-settlement supersession gap in the first planner commit. Follow-up `94672d1c` closes it with three additional regression groups; re-review found no remaining concrete blocker. An existing actor-replacement regression now asserts the earlier `goal.evaluation_discarded` refusal with exact request/reason, retaining zero restages/provider wakes and the active canonical goal.

Twenty-three new test cases across the three units include twenty receipt identity/evidence negative variants and multiple persistence/trace supersession variants. The tests establish the specified harness boundaries with scripted worlds, not autonomous gameplay success. Remaining reviewer coverage limits: queued reservations crossing an hour boundary, Windows case/symlink aliases, all-synchronous historical completion and explicit cancelled-outcome variants beyond existing cancellation checks.

Unit logs reside in ignored `test-results/audit-*-unit.log`; final gates use separate integration logs. No live provider calls or production deployment occurred.

## Frozen candidate gates (October 7)

Final code candidate: `8b6f25d43818f90aa10a29d24ff636d5488102e4`. Installer repin: `0a6a99a3cbf7c874f2828187023bc46ba7e653f5`; bootstrap source: `3128bb45cb62071964778c6cc424ee23a161593e`; payload SHA256 remains `ef8d9447c44009365022fac9dca158c0db8b622a229626e60bebcb1191586de5`. Later changes are test fixtures only.

| Gate | Result | Ignored evidence |
| --- | --- | --- |
| Official Docker `scripts/test-local.sh all` | Exit 0; 1,846 runtime tests, 1,036 mod tests across 120 files, typechecks, TSTL and generated Lua | `test-results/audit-isolated-all.log` |
| Full Docker `--target build` | Exit 0 | `test-results/audit-full-build.log` |
| Installer generator/check/nine payload tests | Exit 0 | `test-results/audit-payload.log` |
| Final isolated Factorio 2.0.77 image build, including full build stage | Exit 0 | `test-results/audit-engine-build-isolated.log` |
| Six changed runtime modules and three fixtures in final engine image | All nine SHA256 byte matches candidate checkout | `test-results/audit-isolated-hashes.json` |
| Native research/combat lane | Passed native research/follow-through, idempotence, rejection and combat on the first image; runtime bytes unchanged afterward | `test-results/audit-engine-run.log`, `test-results/audit-engine-first/research-combat/` |
| Final native resilience lane | Exit 0; full planning lifecycle, blocked-plan restore/revision, save/restart, death recovery, navigation, native crafting/cancellation and crafting restart passed | `test-results/audit-resilience-isolated.log`, `test-results/audit-engine-isolated/` |

The engine scenarios exercise existing native research/follow-through, death recovery, navigation, crafting/cancellation and real process restart acceptance. The newly repaired async and historical-receipt edge cases are proven by scripted regressions; these engine lanes do not replace a dedicated native reproduction of every new edge case.

### First engine attempt and fixture reconciliation

At `0a6a99a3`, the network-disabled two-lane run exited 1: native research/follow-through and combat passed, but resilience stopped at `planning_lifecycle_factorio.mjs`'s assertion that an unmeasured shelf node was fully `realized`. The reducer deliberately returns `partially_realized` for nodes without a separate capability-frontier recognition contract, as required by the owner's October 6 plan. Runtime `attachPlanResultsToShelf` already implements that boundary; none of the five audit repairs changed it.

Reviewed test-only unit `6bcee04a` replaces that invalid expectation with stricter progress evidence at prepare, restore and revision: no recognition contract, partial status, exact completed-plan membership in `resolved_by`, and nonempty verified results. All native three-ore inventory checks, provider/steering counts, goal/plan/revision identities, blocking and explicit revision checks remain. No production behavior changes or synthetic realization evidence were added. Original failed evidence remains at `test-results/audit-engine-run.log` and `test-results/audit-engine-first/`; its disposable container/world was removed after capturing results.

### Further fixture reconciliation

Three later failed attempts are retained unchanged in `test-results/audit-engine-second/`, `audit-engine-third/` and `audit-engine-fourth/`, with logs `audit-resilience-final.log`, `audit-resilience-verified.log` and `audit-resilience-complete.log`. These disposable worlds were discarded after capturing logs and JSON evidence.

`fdbbc161` accepts both null and undefined for an absent serialized frontier. `31b669f1` checks that the dependent frontier remains tentative with explicit `dependencies_unsatisfied` evidence; it also raises the third checkpoint by one ore so three real gathers leave it genuinely unmet at restart. Existing native inventory, identities, provider counts and explicit-revision assertions remain.

The fourth attempt completed the full planning lifecycle and real restart, then exposed two independent test controllers sharing one NPC operation-ordinal journal. `c1ce5eca` sequences each controller's prepare/restore around its own restart. Independent review caught that the new restart also needed an explicit native save; `ffec8df5` saves and waits for the save file to advance before restarting. The production ordinal guard is unchanged. These fixture corrections were independently reviewed without remaining blockers.

The fifth attempt at `d99146fd` again passed the full lifecycle/restart, then refused the blocked-plan controller's ordinal 1 after the previous controller persisted ordinal 4. Its native save was verified, confirming that sequencing and restart alone do not isolate a persisted world journal. Failure logs/JSON are retained in `test-results/audit-resilience-delivery.log` and `test-results/audit-engine-delivery/`, including `ordinal-summary.json`. The failed container was stopped (exit 143) after the assertion failure and removed after capture; this is not a successful gate exit.

Reviewed `e3e4be55` captures the untouched generated save before any controller runs, then gives the independent blocked-plan controller that pristine world. Its native save/restart/verify remains intact; no production journal reset or weakened replay guard was introduced. Final fixture merge is `8b6f25d4`; production runtime and installer bytes remain unchanged from `0a6a99a3`. Research/combat need no repeat because all subsequent corrections touch only the resilience runner.

### Final disposition

The final fresh native resilience run exited 0. Its blocked-plan controller retained the same committed plan across restart, refused ordinary continuation, and created a successor only after explicit scripted user authority. Native crafting verified real output and cancellation, then restarted and completed a fresh craft. Zero connected humans and no network/provider credentials were used. These are deterministic engine scenarios, not an autonomous Luna science run or multiplayer acceptance.

Logs and JSON evidence were captured before removing every disposable container/world created for this repair. The four completed unit worktrees were verified clean and removed; their branches, commits and integration evidence remain. Final account-wide weekly snapshot is 12%, up four percentage points from 8%, within the owner's five-point budget.

The reviewed repair candidate is ready for a separately authorized live Luna trial after the standard committed/pushed-head deployment and byte-verification preflight. Shared campaign accounting, autonomous science, repeatability and multiplayer gates remain open; no production deployment or autonomous success is claimed.
