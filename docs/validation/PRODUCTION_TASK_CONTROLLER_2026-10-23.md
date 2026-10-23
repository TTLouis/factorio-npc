# Run AN repair: production task controller

Problem and observed trigger: Run AN repeatedly interpreted desired item units as recipe executions, acquired redundant copper, and sent partial furnace production back through model observation/review loops. The full build spans immutable slices; a slice is not a complete factory design.

Owner / task branch / source SHA: session 01a16167 / `feat/production-task-controller` / `449e3769b177ae07206ea3e54a9852b5c1dbc2b1`.

Requested outcome: deterministic quantity compilation, a durable material ledger, bounded harness-owned finite production tasks, and next-step contract prediction. No new live trial, provider calls, deployment or publication. Existing native operations, completion authority and immutable plan meaning remain authoritative.

Dependencies: existing JIT contract binding, native admission/receipt reconciliation, actor/epoch fencing and canonical planning memory. Shared integration checkout remains read-only until integration ownership is checked.

Acceptance criteria:

- [x] Preserve exact Run AN pole/cable recipe and refused-count evidence in a minimal fixture; show the old admission path rejects the recorded excess request.
- [x] Desired two poles compile to one pole craft and one cable craft; retained finished targets and reservations cannot become spendable intermediates.
- [x] Real loop lifecycle automatically reconciles an injected residual quantity/stock miss, completes only the fresh deficit, and returns to ordinary verified step settlement without a model repair.
- [x] Finite furnace output uses distinct fuel, wait and collect batches, grounded exact native identities and fresh stock.
- [x] Busy/uncertain work cannot replay; actor/goal/plan changes cannot admit or pause another owner; restart/restage/repeated intent cannot renew durable recovery limits; exhaustion pauses explicitly.
- [x] Prediction is a single cancellable side call after admission; fresh validation and binding occur only at the next step boundary. Material-only, stale or failed predictions fall back to JIT.
- [x] Docker offline gates, deterministic native proof, independent diff review, payload repin and integration verification.

Evidence: immutable Run AN directory `test-run-an-red-automation/test-results/red-automation-live-2026-10-22an`, particularly `analysis/bootstrap-audit/`, canonical plans and retained behavior traces. This note and new tests are derived evidence; historical artifacts stay sealed.

## Repair boundaries and evidence

Failure class: desired item counts mistaken for recipe executions, fragmented
finite production and missing continuation signals. Harness owners:
`quantity-compiler.mjs`, `material-ledger.mjs`, `production-task*.mjs`, the existing
operation/receipt lifecycle, and `supervisor.mjs` completion admission. Prompts
describe the typed intent; they neither decide correctness nor own recovery.

The fixture preserves the observed P6 steam-kit state immediately before AN's
`copper-cable count=2` refusal (one held plate, one craft possible), the original
native refusal, per-craft recipe quantities and the P4 iron-step snapshot with
drill 43/furnace 44. The negative control retains the old executable intent and
shows native refusal without useful work. It does not claim to reproduce the
provider's hour of choices. The native lane independently confirms that refusal
against actual Factorio recipe mechanics.

Prevention compiles desired two poles into one cable execution and one pole
execution. Every transition reads fresh inventory and exact machine facts;
protected checkpoint stock has a separate ledger reservation, while pending
output never becomes stock. A native craft already in progress can justify one
bounded wait even after its last ingredient leaves the input inventory. Global
salvage metadata cannot hide an enabled canonical recipe.

Residual injections deliberately change the internal cable operation back to the
exact AN count=2 before admission, and remove an ingredient between observation
and preflight. The actual admission boundary refuses; the controller persists
recovery expenditure, rereads facts and compiles the remaining demand. Tests
continue through real `completed()` callbacks and ordinary step verification,
with no model repair. The exact AN iron replay fuels the two recorded identities,
collects only the missing 50 plates over partial outputs and retains immutable
step semantics. Its production progression is scripted; it is not native proof
of the complete AN iron layout.

Recovery is bounded by 3 corrections, 256 transitions, a 30-minute task deadline,
a 60-second no-progress interval and the explicit non-renewable fuel maximum.
Existing lost-acknowledgment and global runtime guards also remain. Restart,
restage and repeated intent retain the same counters. Unknown admission, partial
effects, native busy state, owner/epoch changes and corrupt ledger state cannot
authorize replay. Only exact canonically completed steps retire budget records.
Exhaustion pauses with a guard class; that pause is not successful correction.

Review also found a liveness hole outside the quantity example: the supervisor's
250ms completion debounce could discard the sole wake for a fast next batch.
Completion admission now relies on the loop's existing batch/receipt-key
coalescing. A real Session regression delivers distinct completions at the same
wall-clock instant and verifies both batches settle without extra operations.

## Validation checkpoint

There are 27 production and 16 prediction regressions. The candidate Docker gate
reports **3,166 runtime tests** and **1,346 mod tests / 135 files**, with typecheck,
Lua build and generated-Lua validation. ESLint passes after splitting declarations;
no dependency or host installation was performed. Logs live under
`test-results/production-task-controller/` (`all-reviewed.log`, `lint-final.log`).

The deterministic native `production-task` lane passed on Factorio 2.0.77,
seed 424242, zero humans and speed 1: two poles in two native crafts, an injected
excess-count miss automatically corrected once, and two copper plates produced
and collected through six separate batches. Eight total batches, four scripted
planner/executor replies, zero external inference. Native-queue handcraft credit,
held inventory and furnace production statistics establish the respective
outputs. `native/SUMMARY.md`, `native/metrics.json` and the full transcript retain
the exact proof boundary and source hashes; fixture setup stops before proof.
An exact final-commit rerun and payload/integration closeout will be appended.

Independent review was read-only and found no remaining actionable issue after
fixing owner-bound pauses, bounded record compaction, unconfigured assemblers and
completion debounce. All **306** original AN raw files still match their seal
`a6c47491d54bff75ebbc7251a5233e7234efac120447c345ef0b2278fe73c0df`
(`run-an-preservation.json`). Historical reports were not rewritten.

Limits: tasks currently produce finite held stock from deterministic, single
item-output recipes. The ledger is scoped to the active task/checkpoint; it is
not yet a global factory optimizer or shared stock allocator for multiple NPCs.
Layout design, placement/configuration, fluids, probabilistic/multi-output
allocation, sustained logistics and construction robots remain separate work.
Prediction covers the next step inside a slice; future slices still require
fresh Shelf refinement. No autonomous red-science success, live model trial,
publication or deployment is claimed.

## Final local integration

Runtime source `cd757d8bf4e9fc38970ced87a51215c71268e7d7`, separate payload
repin `117f57548e0ca73be2c7e4dfbbe460208cc1eee3`, and local integration merge
`5af29619e67b6ce8e4a79228b77863e4c67ae648`. The merge tree equals the reviewed
repin tree. Payload SHA-256 is
`6a800b4a96aee9675385dc84d40c673c9fedd9a4603ada3978dcc88d29623a14`.
The final closeout commit changes documentation only.

Fresh merged checks passed: **3,166 runtime tests**, **1,346 mod tests**, TypeScript,
Lua build/generated-Lua checks, **9 payload tests**, payload identity and ESLint.
Commands: `bash scripts/test-local.sh all`, payload `--check` and its test file,
and ESLint over runtime modules, changed native tools/tests and the new lane.
Logs: `merged-all.log` and `merged-payload-lint.log`, both exit 0.

The frozen rerun built an immutable Git archive of the runtime source. Factorio
2.0.77 again passed the same eight-batch proof, including one attempted and
completed harness correction, zero failed corrections/operator interventions,
two poles and two newly smelted plates. Runner wall time was **19.383 seconds**;
fixture/setup and packaging intervals overlap and are not additive. All **9/9
runtime files** and **32/32 loaded native files** matched the preserved source
identities. The parent also matched those nine runtime files against the merged
checkout. The lane's common Python gate passed **92 regressions**. This rerun
uses scripted replies; asynchronous prediction is covered by its 16 runtime
regressions, not this single-step native fixture.

Frozen evidence is in `native/frozen-cd757d8b/`: `SUMMARY.md`, `metrics.json`,
`deployed-runtime-matches.json`, `loaded-native-matches.json` and the full native
transcript under `lanes/production-task/results/`. Failed setup attempts remain
preserved separately. `final-summary.json` links the merged checks, original AN
preservation and final resource checks. These artifacts remain in the retained
task checkout's `test-results/production-task-controller/` directory.

Independent review is complete. The five protected integration reports retain
their original hashes, and all 306 sealed AN raw files remain unchanged. Owned
test containers and the two task-created engine image tags are absent; detailed
native cleanup also verifies their exact IDs. No Compose project, network,
disposable volume, tunnel or background worker remains. Shared development/base
images and host evidence are retained. No live provider trial, push or deployment
was performed. Bounded integration ownership is released after this closeout.
