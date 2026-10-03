# Playable red-science implementation checklist — October 3, 2026

This is a resumable implementation record, not gameplay acceptance or package
promotion. Integration remains `experiment/jev-agent-architecture` at
`4d89ed5d`. Main and live deployment have not been changed. No push is authorized.

## Acceptance contract

Three consecutive assistant-driven fresh normal maps, seeds **424242, 424243,
424244**, enemies enabled, natural terrain/resources, ordinary research, zero
connected humans and one declared vanilla starter kit. Each run needs at least
10 automatically delivered red science packs in **each of five consecutive
game-minute windows**, into one exact named output chest with automated upstream
supply. Measurement inputs may not be hand-fed. Science has no buffered stock cap.

Only settled decision boundaries may pause while waiting for assistant replies.
Actions, combat and measurement run normally. Separately test provider delays
with the simulation running. Record exchanges and save/actor/operation identities.
Assistant-driven acceptance does not establish actual NPC-provider autonomy.

## Units and owners

All paths below are siblings of the integration checkout under
`D:/SideProjects/airi-factorio-npc`. Candidates are local and unpushed.

| Unit | Owner / worktree | Candidate | Status |
| --- | --- | --- | --- |
| Native exact admission and prefix receipts | mod receipt migration / `playable-mod-receipts` | `8674ed27` | Separate review; original mod gate passed 901 tests plus typecheck/Lua checks |
| Durable ordinal fence after receipt pruning | parent / `playable-mod-receipt-fence` | `78b90c1a` | Reviewed; new tests unexecuted |
| Campaign operation ledger and exact reconciliation | parent / `playable-durable-operations` | `595009b4` | Separate review in progress; static syntax checks; Docker gate pending |
| 32-task retention, task-local authority/questions | task migration / `playable-task-retention` | `5959981f` plus follow-up underway | Initial unit committed; scheduler/facade integration underway |
| Physical corpse tracking/retrieval and ammo compatibility | corpse migration / `playable-corpse-recovery` | `de137419` | Review findings corrected; Docker/native-engine tests pending |
| Campaign allowance and manual provider bridge | provider migration / `playable-provider-allowance` | `f9c5bcf8` | Reviewed timing fixes; tests written, unexecuted; transport/persistence wiring pending |
| Exact supplying-line output monitor | production migration / `playable-output-proof` | Pending | Conservative direct assembler/inserter/chest monitor underway; native delivery semantics unverified |

## Dependency order and remaining work

- [ ] Run native admission/fence regression gates and runtime ledger gates.
- [ ] Complete separate review and integrate those foundational units.
- [ ] Complete task facade/scheduler wiring, including refusal before physical
  cancellation, preserved queued constraints and pending FIFO resume.
- [ ] Verify full 32-task queue, isolated questions, checkpoint omission from
  prompts, ordering and 15-game-minute aging without downtime.
- [ ] Wire standing authority into first commit and replacement plans; revocation
  cannot silently become an ungranted ordinary task.
- [ ] Retire chest reservations throughout commands/preflight; exclude human
  inventories even through exact entity operations.
- [ ] Implement committed-material/essential-equipment retention and surplus
  returns to source then compatible shared storage, with physical return-chest
  construction when necessary. Exclude science measurement storage.
- [ ] Wire corpse tools into structured contracts and runtime priority. The
  planner chooses the weapon/ammunition kit; verify compatible equipped ammo
  before approaching danger. Reconcile old work before replacement-body actions.
- [ ] Preserve recovery attempt/time limits across plans and deaths; full inventory
  uses return trips, unsafe/expired corpse work remains visible.
- [ ] Wire global campaign persistence and all planner/executor/interaction/Jev
  transport admissions/usage receipts. Missing allowance profile disables paid
  transport; missing billed usage is uncertainty, never zero.
- [ ] Wire test bridge at the injection seam, deterministic replay and timing
  scenarios (delay, changing world, attack, disconnect, cancellation, late reply).
- [ ] Validate exact chest/item/force/surface/supplying-line output proof and
  invalidate manual deposits, identity changes, deficient minutes and ambiguity.
- [ ] Add bounded circuit connection/configuration/readback with existing-wiring,
  identity and reach checks. Validate buffered line stop/restart and overshoot.
- [ ] Update in-game planner skill cards: buildings at least two live stacks;
  belt tiers roughly 400–600, grounded planner target and explicit quantity wins.
  No caps for science or other continuously consumed flows.
- [ ] Revalidate burner/furnace, natural-water steam, powered assembler/inserters,
  then complete automated red-science chain in dependency order.
- [ ] Freeze a passing integrated SHA and run all Docker regression gates,
  package promotion checks and all three real-engine acceptance runs.
- [ ] Update playable status and conflicting roadmap notes with actual evidence.

## Validation evidence and current blocker

Docker Desktop's Linux engine is unavailable: `docker version` fails with missing
`dockerDesktopLinuxEngine` pipe. Repository instructions prohibit agents from
restarting Docker Desktop. Owner action is needed to restore the engine. Code
work may continue; tests and real Factorio validation remain pending.

`logs/playable-mod-receipts.log` contains the passing original native receipt gate
for **8674ed27 only**, before ordinal/corpse changes. An earlier runtime ledger
attempt in `logs/playable-operations-runtime.log` had **1549/1565 passing, 16
failing** before subsequent edits. It is not a passing result for current HEAD.
Task, corpse and allowance gate attempts stopped before executing tests because
Docker was unavailable. Host checks are syntax/whitespace only, not tests.

## Review findings incorporated

- Preserve global operations through goal changes, interruption, resume and
  goalless restore; omit the global ledger from task checkpoints.
- Reconcile existing exact records after a goal stops; refuse new admissions
  without an active goal. Never report settlement when the state change refused.
- Missing exact receipts, changed generations and stale actors stay uncertain.
  Legacy watermark-only records are conservatively migrated; changing quantities
  or plans cannot bypass unresolved material/target conflicts.
- Persist native ordinal high-water marks so pruned receipts cannot permit late
  replay. Bind the exact canonical batch with SHA-256 and retain successful
  prefixes before subsequent commands.
- Corpse deduplication includes full request identity; validate the live corpse's
  surface and force. Runtime must derive distinct retrieval ordinals per slot.
- Bound bridge tracing, filesystem waits and identity hooks; timeout/close/cancel
  must release safe-boundary pause. No timeout falls through to paid transport.

## Known proof limitation under investigation

Factorio exposes held stacks, drop/pickup targets and machine output counters,
but no native per-chest delivery event. The output unit must reject ambiguous
intervals rather than count chest growth as automatic delivery. Its initial scope
is a direct assembler-to-inserter-to-chest line. Complete upstream automation
still requires separate world/evidence validation and the real-engine runs.
