# Explicit production-block startup repair

BL source `20cdcd072b512c814c8af071f4f9ad1fe087f942` accepted a placement-only
step with an immutable iron output role. Its ordinary checkpoint and exact
native member identity passed; selected recipe was absent and generic explicit
role validation refused. The subsequent supply step was unreachable. Original
BL wire14/17 and B1081–1098 remain sealed; local causal artifacts are under
`test-results/run-bl-20261101/closeout/a` in the shared workspace.

The owning boundary is assignment compatibility and enrollment, not native
commissioning. A fresh enabled unique recipe-machine capability for the explicit
output proves only a potential startup job. Keep same-step custody, immutable
method/output/intent, actual recipe-none observations and ordinary supply guards.
The same rule is consumed at close and first use. Registered dormant matching
output uses the existing collection proof; it cannot enroll an unknown producer.

## Proof matrix

| Layer | Evidence / boundary |
| --- | --- |
| Baseline | Local baseline03 fails in unchanged `ensureCommittedFactoryCellBeforeClose` with `factory_enrollment_native_unverified`, after actual shared pre-send and receipt ingestion. Earlier baseline01/02 were Docker permission attempts, not defect proof. |
| Prevention | `factory-cell-enrollment.test.mjs`: BL explicit startup, same-method supply/exact inbound/typed producer, strict role/output and current native evidence. |
| Composed lifecycle | `production-block-startup-loop.test.mjs`: actual request/runTurn/completed, placement and checkpoint, normal next-step contract binding, finite supply/wait/collection; one placement, no corrective model call, immutable semantics and durable registry. |
| Residual | Inject the omitted close prevention at the loop seam, then real residual native reconciliation, durable allowance, ordinary close/advance and collection. No native mutation is replayed by recovery. |
| Safety | Ambiguous/disabled/truncated capability; wrong output/type/member; unknown/nonempty inventories/progress; no grant/state file; busy/pending/uncertain; actor/request/goal/cancel during reads; trace/persist cancellation, strict persistence failure, changed capability after claim. |
| Restart/limits | Exact registry/job persistence, fresh use after restore; durable same-request duplicate and shared three-attempt goal cap; no allowance refund or metadata publication on exhaustion. |
| Neighbor regressions | Existing observation/enrollment/finite production/assigned-advisory suites: affected16 339/339; subsequent scoped proof receipts identify later changes. |
| Native | Driver below. Engine execution and full candidate/merged gates belong to the parent; this document makes no unexecuted native or autonomous-goal success claim. |

All synthetic recipes in tests are explicit fixture data. Native proof reads
current facts from the engine. No native TypeScript or game mechanics change.
Source and payload identities, final gate counts and independent review are
recorded in local task evidence, not copied historical archives.

## Exact-version native proof recipe

Parent creates a fresh isolated Factorio2.0.77 save/server with the frozen
matching native mod, an owned RCON port and zero humans. Record exact container
ID/project, image/native manifest and output directory before starting. No
provider/Jev configuration or live endpoints are needed. Use the existing
strict save/ZIP/pristine-load/finally-cleanup wrapper; do not rerun setup after
loading the resulting checkpoint.

```sh
node tests/factorio/runner/production_block_startup_factorio.mjs \
  --repo /source --results /results --host factorio --port 27015 \
  --execution-form finite --goal-scope long_horizon --residual true
```

The offline RCON fixture password is `offline-fixture-only`, matching the
existing native wrapper. `--residual false` exercises ordinary prevention;
`true` injects one pre-enrollment close miss. The latter also proves subsequent
ordinary startup use and native collection. One native residual lane plus the
unit prevention proof suffices; no live model trial is authorized by this guide.

The driver primes the known console handshake, declares terrain/inventory setup,
reads recipe/machine/fuel/research facts live, and issues only scripted ordinary
planner/executor replies. `replacementWake:true` requests the production
supervisor's normal player-objective grant; the driver asserts its exact ID and
revision before placement and after completion. No synthetic grant is inserted.
The overall long-horizon goal stays active; later slice planning is explicitly
outside the proof through existing `allowContinuation:false`.

Outputs: `canary.json`, `events.json`, `transcript.json`, `scripted-replies.json`,
`canonical-state.json`. Required canary status `passed`, providers0, actual held
output/products_finished and research completion from native facts; the
assignment method remains `production_block`, placement/enrollment origin uses
the same semantic step. Recipe selection remains nullable. Bounded exact
surface/position/unit locator lookup, separate actor identity, and the existing
closed-plan diagnostic receipt-tail restore contract are preserved.

For pristine reload use `canary.retained_placement` exact locator plus
`canary.native_product.output_item`/`expected_recipe`, compare native held output,
products_finished, world UUID from `sgluna_factory.world_identity`, zero humans,
1x and idle/empty queues. Do not use global unit lookup alone for buildings or
require a non-null active furnace recipe. Preserve the pre-reload ZIP separately.
Finally stop/remove only owned resources, verify absence and retain all logs,
state and saves. Native failure remains failure even if a partial assertion
passed; no automatic extra native or live trial follows from this document.
