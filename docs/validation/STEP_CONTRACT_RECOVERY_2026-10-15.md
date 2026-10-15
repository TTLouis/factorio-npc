# Run P step-contract provider recovery

Follow-up to the exact [Run P checkpoint failure](RED_AUTOMATION_LIVE_RUN_P_2026-10-15.md). Task source `369587144a09d785063acffbc822573fcc0ce078`; frozen code/tests **`8f7ac8ee25a18f74bbadc05a9095f86d9d9389fc`**. No live inference, push, release or Pterodactyl deployment is part of this fix.

## Cause and change

The just-in-time planner side call accepts only `{stepId, checkpoint}`. The provider wrapper nevertheless appended normal gameplay `[STEERING]`/`[CONTROL_OUTPUT]` instructions requiring `chatMessage`, `plan`, `currentStep` and `operations`, and supplied the gameplay tool catalog. Run P's first malformed `entity_exists {entity_name, minimum}` checkpoint was correctly rejected; the correction followed that incompatible gameplay envelope and explicitly requested the accepted predicate schema. The two-attempt guard correctly paused before unbound placement.

Contract calls now receive an exclusive `[STEP_CONTRACT_OUTPUT]` system instruction and the canonical checkpoint schema after the stable planner prefix and before dynamic facts. Gameplay steering, closed-control instructions and style additions are excluded. Local CLI-proxy profiles retain the existing explicit `tool_choice:none` wire guard with only a dedicated, non-executable `defineStepContract` schema reference; no gameplay or observation tools are offered. Other profiles preserve their existing closed-tool policy. Generic gameplay-envelope normalization and leaked `submitPlan` salvage cannot convert a contract reply into checkpoint authority.

The strict target parser, supported predicates, two attempts, token/reserve accounting, planner/executor ownership, native admission and cancellation/actor/epoch fences are unchanged. `provider.step_contract_output_contract` records the request ID, reason `step_contract_requires_target_checkpoint_json`, allowed fields and disabled-tool metadata. No new executable tool or automatic action was added.

## Verified gates

- [x] Canonical Docker gate: **2,398 runtime/staging tests, 1,142 mod tests**, typecheck, Lua build and generated-Lua checks, exit 0.
- [x] Full-loop static transport replay: actual Session role resolution and serialized Sol/Luna requests, completed native-shaped craft, exact Run P malformed first checkpoint, bounded schema correction, persisted binding before placement, preserved goal/plan/prior verified result and verified final goal. Exact two invalid live replies still pause without placement; stop/epoch changes during the serialized correction bind and admit nothing.
- [x] Profile coverage checks canonical schema, no gameplay steering, closed-tool guard, correlated trace and strict refusal of gameplay wrappers/leaked tools. Ordinary gameplay control behavior remains covered by the pre-existing gate.
- [x] Independent final read-only review of immutable `8f7ac8ee` found no corroborated merge blocker.
- [x] Original two-module static control: **2,398 total / 2,390 pass / eight expected failures**, exit 1. Every new regression fails and every pre-existing test passes.
- [x] Official frozen Factorio image and all **ten network-disabled native lanes** pass: step-contract, observation-baseline, shoreline-recovery, invalid-reference, queued-craft, recovery-loop, production, craft-trigger, native-admission and steam-lab.
- [x] Native original-code control fails specifically because the serialized contract request contains conflicting gameplay `[CONTROL_OUTPUT]` instructions and tool catalog, rather than a missing export or test-only shortcut.
- [x] Local no-ff integration `449a0014fb3b0edd3b2dd4db8b91a1631cb167dd` and merged canonical gate: 2,398 runtime/staging, 1,142 mod, typecheck/Lua/generated-Lua checks, exit 0. Frozen production/test files match the merged tree exactly.

Official image **`sha256:148077f2f5c34be5073fec82803f877abddcf9bdee488561d9ffe355196cf4fc`**, pinned Factorio **2.0.77**. The new lane uses actual production Session/provider serialization, scripted Sol/Luna transport and normalized scripted Jev with network disabled. Setup declares ordinary crafting inputs plus a lab, science and startup fuel on a deterministic shoreline. After setup there is no inventory insertion, teleport, terrain/chunk edit or corrective gameplay.

The engine really crafts the equipment, rejects the exact malformed first checkpoint, accepts its one bounded correction, then uses fresh native candidates to place a pump and connected boiler. The test independently requires water and the native pump-to-boiler fluid path before delivering the placement completion receipt. Later native admission builds the steam chain, fuels it, supplies the lab and connects the electric pole. The final proof records **seven admitted batches, three JIT calls**, unchanged goal/plan/actor/epoch, zero humans, speed 1, no artificial electric source, boiler water 200, engine steam 200 with positive generation, a shared powered lab network, one science pack consumed and advancing research. Entity presence counts alone are explicitly not fluid-connectivity proof.

Ignored task evidence under `test-results/step-contract/` includes canonical/static-control logs, official build/ten-lane log, native proof, original native failure and copied lane logs, with a seven-file SHA256 manifest. The original static control is a tracked-only archive with only the two original production modules substituted; the source checkout was never swapped. Native control uses the same image/tests with those modules mounted read-only.

Local integration uses the established `og-port-integration` coordinator for `experiment/jev-agent-architecture`; the older root checkout and its pre-existing edits remain protected. Merged canonical evidence is `test-results/step-contract/integration-all.log` in that checkout. Installer/bootstrap payload bytes are unchanged; the runtime follows the exact selected source on the next canonical local server build. No push or live inference occurred during this fix.

This fixes the corroborated contract wire boundary and proves native continuation through connected power. The full natural-resource automated red-science chain and its five-wall-minute, AI-paused speed-2 throughput benchmark remain unproven. The active goal continues with fresh-run preflight.
