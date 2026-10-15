# Run Q closed-round operation proposals: local regression checkpoint

Frozen code/tests: **825548ceda27fec49e6285177b30f60a193fa9a1**, branch `fix/closed-round-action-channel`, source `e77ed843`. Local only; no push, release, deployment or live provider call in this task.

## Diagnosis and change

Run Q gathered ten coal and ten copper ore but did not place its held furnace. After one targeted inventory read, the executor claimed that closed tools prevented placement. Its first recovery call had normal tools available. The final call closed observations after the one targeted fact; the harness already accepted gameplay proposals through strict assistant JSON. `place_entity {entity_name}` already supported ordinary held-item placement without coordinates or an existing entity identity. Independent diagnosis classified this as a model mistake amplified by contract ambiguity, not a missing native capability or admission failure.

The fix changes two production modules:

- `npc-agent-loop.mjs` advertises a typed operation-submission transport in each fresh control state: closed rounds use `assistant_json`, with validation required and no authority granted. The existing correlated `control.decision_state` trace carries that descriptor and the existing reason. The consumed-read tail explicitly preserves JSON operation proposals while observations remain closed.
- `provider-base.mjs` clarifies the distinction, renders approved operation arguments from the canonical catalog, and states the placement/identity dependency boundary. Ordinary held placement may precede identity discovery; dependent exact supply/configuration must wait for its receipt and a fresh observed identity. Geometry-sensitive placement still needs spatial facts/candidates.

No automatic gameplay action, observation, new retry, limit increase, parser relaxation, checkpoint change, or authority bypass was added. Tool guards, native preflight/admission and actor/epoch/cancellation fences remain intact. Prompt clarity does not guarantee future model compliance.

## Static full-loop evidence

Four new regressions use the real Session scheduling, Sol/Luna role resolver, provider serializer, NpcAgentLoop and normal admission against a stateful furnace fixture. The retained sanitized Run Q request/reply case remains unchanged evidence.

1. Captured unsupported blocker -> bounded pause -> actual C7 resume -> one targeted inventory read -> actual closed wire descriptor/instructions -> name-only held furnace placement -> receipt -> fresh entity identity -> coal/copper supply -> ten smelted plates -> electronics checkpoint and final goal verification. The committed goal, plan version and checkpoint remain unchanged, with exactly two admitted batches and no replay.
2. The captured blocker still fails outcome authority, admits nothing and exhausts exactly the existing two step resumes, inside the six-goal limit.
3. Stop during the valid closed placement decision cannot admit it.
4. Epoch change during that decision cannot admit it. Both negative tests require that the valid closed wire and actual cancellation boundary were reached; a swallowed provider assertion cannot pass them.

Canonical Docker `all-frozen.log`: **2,402 runtime/staging tests, 1,142 mod tests, typecheck, Lua build and generated-Lua check PASS**. Intentional control-state/request fingerprints were regenerated; request counts, context fingerprints, message counts and trace event order remain unchanged. The shared closed prompt hash changed intentionally; the compact executor prompt remains byte-identical.

Read-only overlays of the two original production modules in the same offline image give **three new expected failures and one strict-blocker PASS** (`original-static-final.log`). No source checkout was swapped or reset.

## Real-engine evidence

Official image: **sha256:2a84458f5686a7e6f21cfced789efbe1708077affb8e44e96512a6449f0d5ca0**. New lane `closed-action`, offset 18, uses actual Session role routing and provider serialization with injected scripted fetch. All uninjected inference is forbidden; containers run with `--network none`.

Declared setup represents Run Q after gathering: one burner drill, one furnace, eight iron plates, ten coal, ten copper ore, no placed machines. No research is seeded; native electronics has no prerequisites. No stock insertion, terrain repair, teleport, direct placement or forced completion occurs after setup.

Native sequence: Sol commits and confirms the harness's live trigger requirements; Luna requests one targeted inventory fact, proposes held furnace placement through the actual closed JSON channel, receives its native receipt, observes the new furnace identity and supplies that exact target. Real smelting raises the production counter **0 -> 10**, leaves **ten copper plates in furnace output**, consumes the ore/fuel and triggers native electronics. The harness verifies the unchanged checkpoint and finite goal. **Two admitted batches, six serialized calls (two Sol/four Luna), zero humans, speed 1, idle native queues.** `native-verified.log` and `native-proof.json` PASS.

The first native script omitted the mandatory initial live-requirements confirmation, so the harness correctly asked Sol again before delegation. That fixture failed and was corrected without production changes or weakened assertions. The ten existing lanes in that batch each passed: step-contract, observation-baseline, shoreline-recovery, invalid-reference, queued-craft, recovery-loop, production, craft-trigger, native-admission and steam-lab. The batch's aggregate exit was 1 because of the initial new-fixture error; it is not reported as an aggregate pass. Frozen `825548ce` differs from that canary candidate only in the new fixture and strengthened static cancellation assertions.

The corrected native original-code control fails at **closed_round_action_channel_missing_or_ambiguous**, with the old serialized state lacking the descriptor and clarification. It reaches the relevant boundary after native requirements grounding; it does not fail from a missing export or the earlier fixture error.

Ignored evidence under `test-results/closed-action/` includes canonical logs, native builds, proof/results, original static/native controls and the initial diagnostic failures. No credentials or private endpoints are included in this tracked checkpoint.

## Integration and limits

- [x] Static full-loop and cancellation gates.
- [x] Native physical continuation and original-code control.
- [x] Ten existing native canaries.
- [x] Independent frozen review approved `825548ce`; no corroborated merge blockers.
- [x] Local no-ff merge `fd791448`; merged canonical gate PASS 2,402 runtime/1,142 mod, typecheck and Lua checks; production/tests identical to frozen `825548ce`.

The full unattended natural-resource red-science chain and five-wall-minute speed-2 rate measurement remain unproven. Another supervised live trial requires the clean frozen integrated candidate, exact deployed bytes, working proxy and fresh isolated world. No success criteria or construction/provider/recovery limits change.
