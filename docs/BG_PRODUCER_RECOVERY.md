# BG producer binding recovery

Owner: BG producer implementation subtask, shared `fix/bg-harness-recovery`.
Base: `34c43507df01223478f2ca286cd8214ce7c89d04`.
Integration, independent review, full gates and native execution belong to the
parent task. No live inference, publication or deployment is performed here.

## Failure and evidence

Run BG lane B's original `tap_150` submitted a finite target of ten automation
science packs, empty operations and no producer bindings. Its native quantity
closure needed a non-handcraft dependency. The old controller immediately paused
with `production_producer_unbound:copper-plate`, zero transitions and zero
recoveries. A completed earlier copper gathering batch was separate evidence.

The preserved source is the workspace's local
`test-results/run-bg-20261029/live/b/sealed-before-disposal/raw/data/logs/`;
the causal review is `test-results/run-bg-20261029/closeout/b/CAUSAL_REVIEW.md`.
The checked-in [replay fixture](../deploy/pterodactyl/runtime-v8/fixtures/run-bg-production-binding.json)
retains the original submission, held stock, committed p11 step and preservation
proof, authorization, placement ownership and latest verified batch 53 receipt.
The selected fixture omits dialogue, earlier closed batches, review history and
superseded locator audits; normalized comparison verifies the retained active
plan/proof, authority/world, production record, target payload and latest receipt
against sealed source. Tests explicitly reopen terminal
fixture flags and supply scripted native recipe/entity responses where original
terminal read bodies are unavailable. Those substitutions do not establish that
historical furnace 50 was safe to bind.

## Shared rule and correction

[Production admission and continuation](../deploy/pterodactyl/runtime-v8/production-task-runtime.mjs)
use the same native recipe closure and
[producer resolver](../deploy/pterodactyl/runtime-v8/bg-production-binding.mjs).
Admission refuses missing non-handcraft bindings before creating an active task.
A unique eligible existing machine can be bound from exact native evidence.

Automatic reuse requires current actor/session/epoch, surface and force agreement,
exact NPC placement ownership, a matching locator and native identity, compatible
recipe, explicit complete inventories and progress, empty input/output, no shared
production owner, and settled native work/admission journals. Preserved item-route
endpoints are excluded even when their input is empty. Direct-feed strategy does
not become manual feeding authority. Every resulting mutation still passes the
ordinary operation authorization, preservation, preflight and receipt path.

An old admitted record retains its original intent. Successful residual binding
adds a validated `producer_bindings` sidecar and spends one durable production
recovery. If authoritative checks establish that no eligible producer exists,
the controller first persists `producer_wait` and one recovery claim, then issues
one bounded same-step executor correction after releasing its controller flight.
The executor may propose ordinary authorized setup operations. It cannot approve
its own machine binding or change the committed result.

Verified setup receipts wake the same resolver. A still-incomplete setup stays
in the same waiting episode and retains its deadline, no-progress clock and
existing executor budgets. A target-only resubmission is a bounded admission
refusal. A legacy task with no fuel grant requires an already-fueled burner before
adoption; the controller never invents a new fuel allowance during residual
recovery. Successful binding spends a second recovery and returns to native
production and ordinary checkpoint verification.

Ambiguous, unreadable, changed-preservation or uncertain facts cannot grant a
binding. Exhaustion and expiry produce a durable guard pause. Restore retains
the waiting marker, sidecar, clocks and spent allowance. Request, actor/epoch,
conversation, intake and amendment fences cover native reads, tracing, strict
persistence, timeout handling and the final executor wake.
Original player-request plans use ordinary operation-admission authority without
requiring a replacement grant. Replacement lineage still requires its grant;
an existing grant is pinned and rechecked across awaits. Native attempt 04 exposed
the prior mandatory-grant regression. The focused suite now covers grant-free
setup and missing replacement-grant refusal without provider-stale retries.

## Acceptance evidence

[Lifecycle tests](../deploy/pterodactyl/runtime-v8/bg-production-binding.test.mjs)
exercise the original target and preserved drill49-to-furnace50 route. The full
residual path gathers setup material, crafts and places a separate furnace,
ingests the placement receipt, fuels it, adopts only that exact producer and
reaches ten held science packs through the real supervisor completion path.
Original committed steps and protected route facts remain unchanged. Additional
cases cover an existing safe machine, unsupported/ambiguous facts, cancellation
during reads/store/trace, restored waiting progress, duplicate terminal callbacks,
absolute deadline/no-progress limits and visible correction exhaustion.

Local evidence: `test-results/bg-harness-recovery-20261029/producer/`.
`focused-15.log` records **87/87 passing** across the new producer tests and the
existing production-task suite. `baseline-control.log` records **three expected
failures** using unchanged base source plus only the new test fixtures: the old
runtime pauses with the original unbound reason instead of preventing/recovering
it. `baseline-control-pruned.log` confirms those same three failures after fixture
selection cleanup. No missing new API causes those controls to fail. Logs remain local.

The [native driver](../tests/factorio/runner/bg_producer_recovery_factorio.mjs)
uses an explicitly narrower three-copper-plate fixture with Factorio 2.0.77. It
reads recipe/input/fuel sizing from the engine, preserves a live existing iron
route, and establishes new-producer ownership only through an actual admitted
placement receipt. The parent runs and records this proof; merely adding the
driver is not a native pass. Scripted lifecycle success and native fixture
success are distinct from an autonomous gameplay goal.

## Diagnostics and remaining gates

`production.recovery` identifies `exact_producer_binding`, the original unbound
reason, proof failure detail, exact bindings, spent count and disposition.
`setup_required` and `reconcile` are nonterminal; `production.binding_setup_required`
names the responsible bounded executor transition. Original `production.pause`
and `production.paused` remain terminal. Repeated target-only corrections can
terminate as `blocked_decision:production_producer_unbound`; waiting deadlines,
stalls and allowance exhaustion retain their existing classified reason codes.

Independent Sol review, the parent-owned cross-fix seam, exact-version native
execution, full offline and merged gates, installer payload identity and the
separately authorized one live trial remain parent acceptance responsibilities.
