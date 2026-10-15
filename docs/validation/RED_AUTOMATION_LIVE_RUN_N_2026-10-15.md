# CLI-proxy Run N: red automation construction stopped at a missing observation baseline

One owner-authorized delegated trial after Unit 22's reviewed local integration. The trial is complete, its isolated stack is down, and no second trial is authorized by this checkpoint.

## Target and deployment

- Build the complete natural-resource chain: steam power, automatic iron/copper/coal mining, smelting, gear assembly and red science assembly, supplied through native logistics. Construction may use hand crafting and hand feeding.
- Owner-selected readiness check: **five wall minutes at speed 2**, at least ten game minutes and **1 new red pack per game minute**. Pause AI mutations throughout measurement; remove existing enemies and disable expansion first. Record new upstream production and assembler output, native queue idleness, damage and factory continuity. Review physical supply topology separately before claiming the complete chain. Automatic lab delivery, green science and defense/upkeep are subsequent milestones.
- Frozen local source **`77e65f4b579be8bae180516a8ea3ed82997926ee`**, including reviewed Unit 22 code/tests `adc0821a`. Existing green gates: 2,380 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks and eight native lanes. No production source changes during this trial.
- Server image **`sha256:078a4717ccd02b694a806d7d54f96722877d9623e50800cd89e0ead144502020`**, built from the clean local checkout with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All **50 shipped runtime/staging modules**, packaged prompt and manifest match; all **31 active mod files** match the release and native-tested mod. No runtime overlay. No push or Pterodactyl deployment.
- Existing CLI-proxy transport; **`gpt-6.1-sol` planner / `gpt-6-luna` executor**, dedicated live Jev. Role resolver checked before submission. Credentials and endpoint remain private; the exposed local RCON credential from preflight process inspection was replaced for the isolated stack before the goal was submitted.
- Fresh seed **4230758198**, standalone actor **6**, goal **`goal_0vqlnov_1`**, initial request **`req_mv9oiydt_1`**. Preflight confirmed empty inventory/board, no machines, zero humans and speed 1. Same declared starter: burner drill 1, furnace 1, iron plates 8, pistol 1 and ammunition 10. Four offline observer checks passed, including rejecting hand-crafted/stored output, inactive upstream stages, short windows, queued work and damage.

## Result

**15:14:12.638–15:36:44.956 UTC**, **22m32.318s**. Stop: **`auto_resume_exhausted`**, reason **`step_limit_reached_without_verified_progress`**. The lab step spent its two resumes; four goal resumes had been spent out of six. No operator corrections or second provider run.

**61 provider requests / 61 responses / zero provider errors**: **5 Sol / 56 Luna**. Jev **38 requests / 38 responses**. Two planner-parking handoffs and eight context restages establish actual live delegation. Weekly usage remained **86% available** at the completed-smelting milestone; no reset credit used.

Native production reached **72 iron plates and 10 copper plates**, plus hand-crafted **10 gears and 20 cable**. The NPC recovered from copper output blocking iron smelting by collecting the copper. Electronics and steam-power triggers completed, and Sol committed the lab/steam construction slice.

Only one furnace was placed. At termination it held **44 iron plates** in output, **2 coal** in fuel and no source ingredient. Held inventory included coal 10, iron ore 28, copper ore 10, iron plates 16, gears 10 and cable 20. **No lab, connected power system, automated mining/assembly chain or red science output.** The red recipe remained locked; green research remained incomplete.

**The five-minute measurement did not start.** AI lockout, speed 2 and enemy removal/expansion changes were therefore never applied. Construction ran at speed 1 with zero humans. There is no measured throughput or peaceful-factory readiness claim.

## Concrete next regression

Final request **`recovery_mv9paqb0`** read a live lab recipe: five more copper plates were required; copper ore and a placed furnace were available. Its `getEntityStatus(unit_number:13)` response was:

```json
{"observation_mode":"unchanged","source":"live_factorio_entity_status","reference":"entity:13","query":{"name":"","radius":8}}
```

The final provider request, round 3, contained **12 messages, one unchanged entity-status response, zero full entity-status responses and zero `[ENTITY_STATUS_BASELINE]` messages**. Luna reported that it needed a fresh furnace identity/current-state read before processing copper. Outcome authority correctly rejected the unsupported world-blocker claim, and the per-step recovery limit ended the trial.

Source inspection supports a conversation-continuity defect: `supervisor-adapter.mjs` retains bounded entity/nearby diff baselines and appends them through the inherited continuation path. Runtime context restages replace the conversation and clear the general tool cache without clearing or delivering those diff baselines. A compact live read can consequently refer to a baseline absent from the rebuilt executor's messages. This explains an observed missing-fact boundary; it is not a claim that fixing it alone will complete autonomous science automation.

Before another live trial:

1. Bind compact-observation eligibility to the exact delivered conversation lineage and actor/surface/epoch/query identity. On a rebuilt context, obtain/deliver a fresh full native snapshot before using diffs or unchanged markers. Keep historical location metadata distinct from executable entity references. Apply the same rule to nearby-entity compaction. Preserve observation/resume caps and world-state completion authority.
2. Add an exact Run N full-loop scripted-provider/Jev regression: carried furnace metadata, restored lab checkpoint, fresh copper-processing dependency, full entity observation, native-shaped processing/crafting receipts and verified lab/power continuation. The original implementation must fail at the missing-baseline boundary. Cover C3/C5/C7 restages, unchanged and changed machines, query/identity changes, cancellation and restart without replay.
3. Add real-engine recovery coverage for copper→iron→copper switching with actual output clearing, fresh furnace discovery and lab crafting through a rebuilt executor context. Continue to connected power and native output verification. No operator feeding, teleporting or fabricated completion after setup.
4. Review the frozen patch and pass canonical static/native gates before proposing another owner-authorized live trial. The prepared five-minute observer still requires live validation and supply-topology review before claiming full-chain throughput.

## Preserved evidence

Ignored integration-checkout directory **`test-results/red-automation-live-2026-10-15n/`** contains summary, exact replay events, `baseline-delivery-proof.json`, deployment/model proofs, observer contract, native snapshots, canonical state, rotated traces, a ten-file SHA256 evidence manifest and **805,639-byte** `data/saves/red-automation-n-checkpoint.zip`. Private overlay/configuration is excluded from the manifest and Git.

Offline Docker run-check exits **1** with seven analyzer findings: three tracker-behind-batch signatures, one restage-loop signature, two no-chat signatures and terminal auto-resume exhaustion. These signatures are not seven independently corroborated defects; a completed acquisition/crafting batch does not prove the retained lab checkpoint. The missing baseline is independently established by the exact provider payload. The initial attempt to invoke run-check from the packaged server failed because this developer analyzer is not shipped; the recorded report comes from the subsequent offline development-image invocation.

The current integration checkout is `og-port-integration`, serving `experiment/jev-agent-architecture`. The older root checkout and its unrelated uncommitted documents remain untouched. No push, runtime fix, limit increase, live retry or release promotion occurred.
