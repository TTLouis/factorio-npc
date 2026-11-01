# Run R targeted water recovery: local checkpoint

Frozen final code/tests: **41642d057ece5ee69ef6fef3e330e7f209554b78**, branch `fix/targeted-water-recovery`, source `282d461c`. Native image was built at **505f1181047737a55a14e913169dbf54874b1e51**; the final candidate differs only by one additional static regression. Runtime and native fixture files are identical. No live provider calls, push, release or deployment in this task.

## Actual failure and bounded fix

Run R acquired its power kit and successfully bound the JIT placement checkpoint. Its executor then spent four normal observations on actor status, inventory, nearby entities and an actor-centered offshore-pump candidate search within radius 24. The candidate result was empty. Normal observations closed, while the targeted one-fact allowance remained unused. Its grammar could not request water coverage, and Unit 22 had no native incomplete-coverage evidence from which to expose exploration centers.

Luna also supplied a malformed `entity_exists {entity_name}` checkpoint with proposed placements. Strict rejection of that complete response was correct; no placements were salvaged. The subsequent unsupported world-blocker claim was correctly rejected, and the six-goal-resume guard correctly stopped further retries. Neither assertion is weakened here.

The fix permits **one actor-centered water coverage read through the existing targeted fact allowance**:

- Fresh empty offshore-pump observation, implicit actor center, committed execution, exact goal/plan/step/actor/epoch/request/world-mutation scope and existing 120-second freshness are required. Explicit center or connection-target searches cannot open this path.
- The control state advertises `targetedWaterSearch` only when that fact is eligible and the allowance unused. The request grammar/schema accepts only water, radius 1..256 and limit 1..8, with no arbitrary center or draft use. The offered request uses radius 256/limit 8, within existing native tool bounds.
- The same durable ledger is consumed before transport; normal observations stay closed. Rejection, cancellation, restaging and restart cannot refund it or mint another fact. Current incomplete water coverage suppresses a redundant read; stale coverage cannot suppress the missing fact.
- The captured pump evidence is fenced through result publication. Recording the new water result does not invalidate its own read; another pump observation, mutation, identity/request change or expiry does. The new `observation.targeted_water_search` trace carries `request_id` and reason `fresh_empty_pump_search_needs_water_coverage`.
- The existing Unit 22 correction uses native unexplored chunk centers. The model chooses exploration and later placement; the harness performs no automatic movement, chunk generation or gameplay correction. Local absence remains insufficient evidence of a world blocker.

No provider, observation-count, category-correction or resume limit increases. Immutable checkpoints, strict parsing and native admission remain authoritative. This adds a gated fact category to an already available one-read allowance; it does not reopen general discovery.

## Static gates and original-code control

Twelve new cases cover actual serialized Sol/Luna requests and production Session scheduling. The captured malformed checkpoint remains refused. With all six goal resumes already spent and persisted, the same request consumes its one missing water fact, receives native incomplete-coverage evidence, follows the existing bounded correction, admits a model-selected walk, settles the receipt, discovers fresh water and reaches a verified powered result. Every subsequent provider boundary checks that the durable goal counter remains six.

Negative coverage includes malformed/draft/nonwater/oversized/center-override requests; absent, forged, old/future, off-center or mismatched pump evidence; a redundant read with fresh water already available; second-read/restage/restart claims; cancellation, epoch, request or mutation changes during the read; stop/epoch during the exploration decision; and repeated blockers exhausting the original category cap. No stale results enter messages or cache, and no read alone admits gameplay.

Docker **runtime-frozen.log: 2,414 runtime/staging tests PASS**. Canonical **all-final.log: 2,413 runtime tests, 1,142 mod tests, typecheck, Lua build and generated-Lua checks PASS**, before the final static-only case. The merged canonical gate must confirm the complete final candidate before the next live trial. The intentional schema/guidance request fingerprints changed; request counts, contexts, message counts and trace event order remain unchanged.

With read-only overlays of the three original production modules in the same network-disabled image, all twelve new tests fail as expected (`original-static.log`). The native original-code control reaches the closed boundary and fails specifically at **pump_only_closed_round_has_no_eligible_targeted_water_search**; it does not fail from a missing helper export.

## Native continuation proof

Official native image: **sha256:12652c1b6cabb2431cdf0e57e1623ffc648111bc4edecbd3c57321255434bc1e**. New lane `targeted-water`, offset 19. Containers use `--network none`; the real Session role resolver and provider serializer use injected scripted fetch, and uninjected inference fails.

Declared fixture setup supplies steam equipment, a lab, fuel and ten science packs on a dry initial surface with distant real shoreline. Setup researches the declared prerequisites. After that boundary there are no stock insertions, terrain edits, teleports, direct entity placements, chunk-generation requests or operator corrections. These are unit-test fixture inputs, not changes to the live starter.

The lane uses exactly four normal reads, with no earlier water query. The closed wire advertises the eligible water fact, consumes the persisted existing ledger, and supplies genuine incomplete generated-area coverage. The model chooses an observed unexplored center, walks there natively, discovers water afresh, selects revalidated placements and builds a connected pump/boiler/engine/lab network. Final proof: **eight admitted batches, 21 serialized calls (one Sol/twenty Luna), prior goal resumes still six, no automatic/fresh-context resume, zero humans, speed 1 and idle queues**. Native boiler water and engine steam reach 200 each; the engine generates, shares network 1 with the powered lab, and the lab consumes a science pack while research advances. Fluid connections and electric-network identities are independently asserted. `native-proof.json` passes.

## Required integration checkpoint

- [x] Static full loop, provenance, ledger and stale-work coverage.
- [x] Native targeted-water connected-power lane and original-code control.
- [x] Eleven existing native canaries; all twelve selected network-disabled lanes pass in one aggregate run.
- [x] Independent final frozen review approved `41642d05`; no corroborated merge blockers.
- [x] Local no-ff merge `7252e412`; merged canonical gate PASS 2,414 runtime/1,142 mod, typecheck and Lua; production/tests identical to frozen `41642d05`.

Ignored evidence lives under `test-results/targeted-water/`: canonical runtime/mod logs, native build/results/proof, original-code controls and initial fixture diagnostics. The full natural-resource automated red-science chain and five-wall-minute speed-2 measurement remain unproven. Run S requires a clean frozen integrated candidate, exact deployment, verified proxy and fresh isolated world; no success criteria or limits change.
