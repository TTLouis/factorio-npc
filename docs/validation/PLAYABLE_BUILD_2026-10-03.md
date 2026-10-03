# Playable red-science implementation checklist — October 3, 2026

This is a resumable implementation record, not gameplay acceptance or package
promotion. Integration is `experiment/jev-agent-architecture`; reviewed native
receipt fencing, physical corpse retrieval and planner stock guidance have landed
locally through `9b03a240`. Main and live deployment have not changed. No push is authorized.

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
| Durable ordinal fence after receipt pruning | parent / `playable-mod-receipt-fence` | `78b90c1a` | Reviewed and integrated by `7f33e26e`; combined gate passed |
| Campaign operation ledger and exact reconciliation | parent / `playable-durable-operations` | `df416148` | Runtime 1,570/1,570; final semantic review underway |
| 32-task retention, task-local authority/questions | task migration / `playable-task-retention` | `4ac4b8df` plus review repair underway | Runtime 1,585/1,585; review caught missing clock fence on completion handoff |
| Physical corpse tracking/retrieval and ammo compatibility | corpse migration / `playable-corpse-recovery` | `de137419` | Reviewed and integrated by `f54d850b`; combined gate passed; native engine pending |
| Campaign allowance and manual provider bridge | provider migration / `playable-provider-allowance` | `f9c5bcf8` | New bridge/allowance tests passed; two inherited reservation tests require complete task integration |
| Paid-transport admission and global campaign persistence | provider migration / `playable-campaign-transport` | In progress | Default paid transport disabled; fake transport fixture/shipping closure fixes underway |
| Exact supplying-line output monitor | production migration / `playable-output-proof` | `10685826` | Reviewed candidate; mod 911/911; satisfaction and upstream automation flags remain false |
| Buffered stock planner guidance | stock migration / `playable-buffer-stock-guidance` | `0ae5e392` | Reviewed and integrated by `9b03a240`; separate mod gate 903/903 |
| Bounded buffered circuit API | circuit migration / `playable-buffer-circuits` | `29c14eb3` | Mod 920/920, typecheck/Lua passed; separate review pending; stop/restart unverified |

## Dependency order and remaining work

- [x] Run native admission/fence regression gates and runtime ledger gates.
- [ ] Complete final ledger review and integrate runtime foundation (native foundation integrated).
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
- [x] Update in-game planner skill cards: buildings at least two live stacks;
  belt tiers roughly 400–600, grounded planner target and explicit quantity wins.
  No caps for science or other continuously consumed flows.
- [ ] Revalidate burner/furnace, natural-water steam, powered assembler/inserters,
  then complete automated red-science chain in dependency order.
- [ ] Freeze a passing integrated SHA and run all Docker regression gates,
  package promotion checks and all three real-engine acceptance runs.
- [ ] Update playable status and conflicting roadmap notes with actual evidence.

## Validation evidence and remaining gates

Docker's Linux engine is available again. All regression runs below use the
canonical Docker-only script; no host dependency installation or paid calls.

- `logs/playable-integration-receipts-2026-10-03.log`: integration `7f33e26e`,
  all gate exit 0: 1,561 runtime and 903 mod tests, typecheck/Lua/generated guard.
- `logs/playable-integration-corpses-2026-10-03.log`: integration `f54d850b`,
  all gate exit 0: 1,561 runtime and 912 mod tests, typecheck/Lua/generated guard.
- `logs/playable-operations-runtime-2026-10-03-r6.log`: ledger `df416148`,
  runtime gate exit 0, 1,570/1,570.
- `logs/playable-task-maintenance.log`: retention `4ac4b8df`, runtime gate
  exit 0, 1,585/1,585. Separate review repair needs a new gate.
- `logs/output-proof-mod-2026-10-03.log`: output candidate `10685826`, mod
  gate exit 0, 911/911 plus typecheck/Lua/generated guard.
- `logs/buffer-circuits-mod-2026-10-03-final.log`: circuit `29c14eb3`, mod
  gate exit 0, 920/920 plus typecheck/Lua/generated guard.

No new real-engine acceptance, package promotion or actual provider autonomy
claim is established by these gates. Candidate branches must be integrated,
review repairs checked and the shipped payload repinned before promotion checks.

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
- Exact sealed receipts can settle historical work by the original actor;
  unfinished old-actor work remains uncertain. Local cancellation before the
  transport call can prove absence; a restart alone cannot.
- A refused uncertain retry followed by an explicit blocker uses exact harness
  uncertainty evidence, instead of offering a provider-failure Resume.
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
