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

## Independent review correction

The first immutable review (ed00025b) found one reachable downstream bypass:
restored collection accepted a missing historical surface, while production facts
skipped exact validation when that field was absent. Five negative controls
reproduced unsafe admission for changed position, actor, surface, force or missing
placement. Collection-only tasks now always require matching recorded placement,
actor/epoch and full raw entity/body validation, regardless of historical surface
presence. The positive missing-surface restore and all five refusals pass through
the real restored controller. First review and red/green logs remain retained.

## Validation checkpoint

- [x] Preserve original AU evidence and causal negative controls.
- [x] Shared producer correction and bounded missing-scope reconciliation.
- [x] Real Session residual/native callback and strict-stop regressions.
- [x] Focused137 cases pass (37new); baseline and review negative controls retained.
- [x] Candidate and merged3408runtime/1378mod, type/Lua/generated-Lua; scoped lint0 errors/warnings and payload9 pass.
- [x] Independent review approved6a7dbecd after R1 correction; mergeddd3e0cac, fresh full gate and merged payload9 pass.
- [x] Historical seals/validation files reverified; owned cleanup and new evidence mirror recorded in machine closeout.

Evidence: `test-results/run-au-harness-recovery/` (ignored, retained locally).
Initial fixture setup failures and full-gate trace-sequence failure remain in the
logs alongside final passing runs. The corrected baseline uses unchanged709d10eb
production files in a separate ignored source directory; positive AU cases must
fail for the actual missing binding/false global fault, not a missing test API.

No Factorio mechanics or native files changed. Prior exact2.0.77 native scope,
same-entity collection and sprint guard proof remains applicable to unchanged
native code; this repair's new composition is offline/scripted evidence. A future
live trial still requires a newly frozen candidate and its own authorization.

Final executable candidate: `6a7dbecdfa9fa0d20c195df592469af584d8fe0d`, runtime
correction `c04295563cbf1a524339e8912b7bbe8b2dd94b51`, payload source the same
runtime commit; unchanged bootstrap payload SHA-256
`6d9ff05468d450708b8ae00650f825380291c5022206f8963154512688245be4`.
Tested local merge: `dd3e0cac4fb1d55b604d20a932f66b81a6ccfc58`; production tree
matches the approved candidate exactly. Later closeout commits change documents
only. The original blocked review is retained beside final approval.

The original709d10eb baseline suite records131tests/25expected failures; this
includes auxiliary new-branch diagnostics and safety cases that cannot reach their
new seams on the old source, not25independent live failures. The original drill
replies and false stop fault fail for their original reasons. The separateed00025b
review control records137tests/5unsafe-admission failures; final focused137/137
pass. Frozen provider request fingerprints remain11/11 unchanged.

Machine closeout, gates, review, negative controls, cleanup and history proofs:
[test-results/run-au-harness-recovery/final-summary.json](../test-results/run-au-harness-recovery/final-summary.json).
All988AR/AS/AT/AU sealed files and187historical validation files remain unchanged.
Source, ignored evidence and shared images are retained; task-only containers are
absent, with no background review or model work. No new live trial or publication.
