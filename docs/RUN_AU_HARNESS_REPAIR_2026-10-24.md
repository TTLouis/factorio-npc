# Run AU drill identity and stop-boundary repair

Owner/task: Codex /root chat01a16ab4, `fix/run-au-harness-recovery`, starting at
current Jev integration `709d10eb38853941c06bb4b5c39f6235e9f0f61a` (executable
baseline `0776b39b`). No new E2E, real provider/Jev call, push or deployment.

## Failure and shared ownership

[Run AU](validation/RED_AUTOMATION_LIVE_RUN_AU_2026-10-23.md) stopped on drill15's
missing exact binding. Its historical locator retained name/type/position but no
surface index; a matching actor6/epoch1 placement receipt remained. The old refresh
entry check rejected that locator before any authoritative probe. Earlier AS tests
always supplied complete locators and bypassed ordinary model-facing projections.

The producer bug is in `NpcAgentLoop.handleToolBatch`: the adapter's full/diff/
unchanged entity output is for the model. It can omit native scope or the entity
entirely. Recording executable bindings from this projection dropped native
surface metadata and could not renew an unchanged identity after invalidation.
The already-fenced batch's raw native cache answer is now the binding source.
Cached results cannot resurrect an invalidated binding. Named reconciliation
telemetry and its ownership/read fences precede publication.

Residual repair remains in `entity-refresh.mjs`. A missing historical surface is
resolved only through fresh deployment/body/entity agreement, recorded NPC
placement, exact unit/name/type/position/force checks and existing ownership
fences. An explicit conflicting/invalid surface is refused. The same rule covers
restored collection fences. No guessed surface, old model ID or placement admission
alone grants execution authority. Old proposals are discarded, then the existing
collection controller or an ordinary remaining-work decision proceeds from fresh
facts. No stale fuel batch is replayed.

The separate AU fault was `Sprint boundary owner superseded` during strict stop
confirmation. The external supervisor seals construction before cancellation.
`TickSprintController.fail` previously required construction to remain open even
when retiring an old owner at verified1x. A correctly sealed guard therefore
became a global fault. Retirement now accepts confirmed closed1x with matching
run/source/profile, no lease and no native fault, retires the callback and disables
further sprinting. It never resumes construction, clears durable episode spending,
executes the retired payload or cancels a replacement. Unreadable, wrong-binding,
leased/fast or faulted guards retain global safety failure. Trace-write failure
does not negate an already verified physical restoration. `sprint.boundary_retired`
records the disposition; the checker also detects the original false global-fault
event rather than silently missing this failure class.

## Limits and proof matrix

Existing targeted-observation allowance, 2/step and6/goal controller limits,
128-record bounds, per-request decision limits and durable entity claims remain
unchanged. Claims persist before the probe. Interrupted/used allowance cannot
renew on restore/restage; exhaustion pauses visibly. Native work, uncertain
effects, existing waits/crafting/follow, amendments and changed owner/actor/epoch/
surface/step retain their fences. Goal/Shelf/committed steps and checkpoint
requirements remain unchanged.

- Exact inputs: original AU tap22 andtap25 submitPlan arguments, original active
  plan/locators/placement history, and exact stop fault event. Fixture provenance
  and SHA are embedded in `fixtures/run-au-recovery.json`. The retained final
  native-settled operation ledger replaces an earlier snapshot's still-pending
  wait5; no step or contract is rewritten. Scripted native facts retain the actual
  actor/epoch/units/positions. Historical evidence is read-only.
- Prevention: fresh raw identity scope survives full/diff output; cached output
  cannot renew a cleared binding. Trace-await replacement cannot publish old facts.
- Residual: real Session/runTurn/commit path deliberately loses drill binding
  after parsing, detects it at admission, verifies native identity and returns to
  ordinary execution. Historical six-plate stock remains insufficient for the
  ten-plate checkpoint; the old two-target fuel proposal is not replayed.
- Native callback variant: four physical scripted furnace smelts from explicitly
  declared fixture ore/fuel extend six output plates to ten. Ordinary collection
  completes through the native receipt; the callback schedules another relevant
  native wait. The unchanged checkpoint's receipt clauses remain unmet, so this
  proves safe continuation and collection, **not checkpoint or gameplay success**.
  Two post-refresh model calls are ordinary decisions across a native callback;
  the harness itself renews identity before either can propose executable work.
- Stop prevention and injected residual: exact externally sealed/cancelled shape
  and direct failure-handler miss both run through real Session stop processing,
  preserve operator pause, confirm1x/no lease and leave no acceleration fault.
- Safety: wrong force/unit/position/surface, missing native proof, native busy/
  crafting/pending effects; request/actor/epoch/surface/step/amendment changes during
  awaits; durable interruption/exhaustion; wrong guard binding, native fault,
  unreadable/fast restoration and retirement telemetry failure. Existing AS and
  AT restart, replacement-lease, wait, timer and uncertain-effect tests also run.

The no-restage golden gains diagnostic events and shifted sequence numbers; all
11 frozen provider request fingerprints remain identical. No assertion or
completion contract is weakened to obtain a pass.

## Validation checkpoint

- [x] Preserve original AU evidence and causal negative controls.
- [x] Shared producer correction and bounded missing-scope reconciliation.
- [x] Real Session residual/native callback and strict-stop regressions.
- [x] Focused131 cases pass (31new); baseline final negative suite retained.
- [ ] Fresh full runtime/mod/type/Lua, scoped lint and payload checks.
- [ ] Immutable independent review; integrate and rerun merged offline gates.
- [ ] Reverify historical seals, owned Docker cleanup and evidence mirror.

Evidence: `test-results/run-au-harness-recovery/` (ignored, retained locally).
Initial fixture setup failures and full-gate trace-sequence failure remain in the
logs alongside final passing runs. The corrected baseline uses unchanged709d10eb
production files in a separate ignored source directory; positive AU cases must
fail for the actual missing binding/false global fault, not a missing test API.

No Factorio mechanics or native files changed. Prior exact2.0.77 native scope,
same-entity collection and sprint guard proof remains applicable to unchanged
native code; this repair's new composition is offline/scripted evidence. A future
live trial still requires a newly frozen candidate and its own authorization.
