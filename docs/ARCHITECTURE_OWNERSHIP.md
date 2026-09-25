# NPC architecture ownership

This document records the current single-NPC ownership boundaries on `feat/npc-transition-work`. It is a runtime contract, not a migration wish list: provider differences are documented as they exist today, and adapters are added only when a provider actually needs the capability.

## Canonical Factorio contract

`contracts/factorio-tool-contract.json` is the review/test manifest for structured operations and provider-visible Factorio tools. It is not a runtime dependency and does not replace the independent TypeScript and Pterodactyl adapters.

The parity tests are the drift guard:

- `packages/agent/src/llm/factorio-contract-parity.test.ts` checks the complete ordinary-agent operation/tool surface against the manifest.
- `deploy/pterodactyl/runtime-v8/tool-contract-parity.test.mjs` checks the complete runtime-v8 tool surface, remote mappings, operation layering, and shared defaults.

Provider asymmetry is intentional when the manifest says so. Current runtime-v8-only tools are `measureTransportThroughput`, `getResearchRequest`, `getLocalSpatialObservation`, `planPlacement`, `validateConstructionPlan`, `getResearchPath`, `getMiningDetails` and `estimateProductionTime`. `getPlacementCandidates` and `findConstructionSites` are already available on both providers and must remain marked shared unless one implementation is deliberately removed.

Structured operations have a similar intentional asymmetry: `gather_resource`, `supply_entity`, and `execute_construction_plan` are runtime-v8-only provider operations. `place_candidate` is shared at the provider surface even though its Pterodactyl parser/renderer is owned by the runtime-v8 extension layer.

## Pterodactyl staging and runtime-v8

Keep the existing path names. `deploy/pterodactyl/staging/structured-policy.mjs` is the shared Pterodactyl policy base and `deploy/pterodactyl/runtime-v8/structured-policy.mjs` extends it.

The ownership rule is behavioral rather than aesthetic:

- staging owns the base structured operation parser/renderer and base status/inspection tools;
- runtime-v8 delegates base operations to staging;
- runtime-v8 owns provider-specific extensions such as `place_candidate` and its additional deterministic planning tools;
- release/deployment code must copy the complete transitive runtime dependency set, but this cleanup does not rename staging/runtime-v8 paths.

Do not force parser identity or duplicate an adapter just to make two provider surfaces look symmetrical. Parity means that shared capabilities have compatible contracts and intentional differences are explicit.

## Runtime state authority

Factorio simulation state and deterministic mod helpers are authoritative for world state. Provider prompts, model responses, console projections, and debug views are consumers/projections of that state; they are not alternate state stores.

The task/goal lifecycle remains owned by the current NPC runtime. Provider output proposes actions; deterministic runtime code validates, queues, executes, and records them. New architecture work should extend that ownership rather than introducing a second task board or provider-owned lifecycle.

## Learning and verification ownership

Learning and verification deliberately use separate lifecycle layers:

- `LearningOpportunity.state` describes the learning pipeline (`detected`, analysis/candidate states, `awaiting_verification`, and terminal learning outcomes).
- `SkillVerificationRun.state` describes one concrete verification execution (`validating`, construction/configuration/supply/re-observation states, then `verified`, `failed`, or `blocked`).
- `LearningVerificationQueueItem` is the one canonical queue record type. Its queue state is only `queued`, `running`, or `blocked`.

The queue transition contract is:

1. `queued -> running` when a verifier claims the item.
2. `running -> verified/remove` when live verification succeeds.
3. `running -> failed/remove` when verification fails.
4. `running -> blocked` when an environmental/precondition issue prevents completion.
5. `blocked -> queued` only through explicit retry.

A blocked run does not collapse the learning opportunity into failure. Likewise, the queue state and the verification-run state must not be reused as aliases for `LearningOpportunity.state`.

Semantic verification failures remain learning evidence. The current learning bridge may turn a structured semantic counterexample into a revised candidate and requeue that new revision; architecture cleanup must preserve that newer behavior.

## Verified-skill authority

`skills.ts` owns schema/canonical storage, but caller-supplied records are untrusted. External `autorio_skills.put_definition` imports may create/update non-verified records; they may not assert `status=verified`.

Verified promotion authority belongs to the live verifier in `skill_verification.ts`. `promote_verified_skill` may write a verified revision only after deterministic translated rebuild/topology/output checks produce the required evidence. Keeping the internal storage primitive available to the verifier does not make it an external trust boundary.

## Construction and placement semantics

Construction helpers are deterministic capability surfaces, not parallel construction authorities. Candidate enumeration, site search, spatial observation, placement planning, plan validation, and construction intent inspection may differ by provider; the manifest records those surfaces. Execution authority remains in the Factorio runtime and current NPC construction path.

Do not add provider adapters solely because a helper exists on the other surface. Add one when the provider workflow requires it, then update the manifest and parity tests in the same change.

## Change rules

When changing a structured operation or provider-visible Factorio tool:

1. update the owning implementation;
2. update `contracts/factorio-tool-contract.json` in the same change;
3. update/add parity fixtures for new arguments/defaults/remote mappings;
4. keep intentional surface differences explicit instead of labelling them as accidental drift;
5. run build/typecheck, Autorio + agent tests, Pterodactyl runtime tests, and the deterministic NPC harness when available.

When changing learning state, update the canonical queue record and verification transition tests rather than defining another local queue shape or adding casts around ownership mismatches.
