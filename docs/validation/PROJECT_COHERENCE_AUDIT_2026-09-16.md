# Factorio NPC project coherence audit — 2026-09-16

This document records the current architecture/coherence audit for `TTLouis/factorio-npc`, with `feat/npc-transition-work` treated as the active future-main integration branch.

The purpose is to separate intentional branch strategy from real architecture debt, preserve evidence for later implementation, and prevent future coding agents from “cleaning up” project-owned functionality that is actually current.

## Implementation status update — 2026-09-19

This audit remains the historical finding record, but several items have since moved:

- restart-safe operation/batch identity is implemented on the Jev experiment branch, including persisted sequence/generation, stable `batch_ref`, verifier stale-generation reconciliation, and Task Board receipt identity;
- entity-to-placement-item resolution is implemented through one prototype-backed resolver shared by local validation, physical placement, and remote construction;
- Pterodactyl tool-contract drift now has a canonical manifest/parity regression layer, although full generated single-source ownership remains future cleanup;
- the canonical repository metadata now points at `TTLouis/factorio-npc`;
- fresh generated Pterodactyl eggs default `SGLUNA_CHAT_PLAYERS` to `none`; `*` remains the explicit opt-in for allow-everyone compatibility.

Treat the original finding text below as rationale and regression history where a status update above says implementation is complete.

## Branch model

The intended development model is:

```text
main
  = stable release/deployment baseline

feat/npc-transition-work
  = primary single-NPC integration + E2E line

swarm development
  = NPC baseline + swarm coordination layer
```

`feat/npc-transition-work` being substantially ahead of `main` is intentional and is not itself a defect. `main` should move by validated promotion checkpoints, not by constant synchronization.

The important branch risk is the opposite direction: experimental swarm work must be rebased/ported onto the current NPC baseline without reintroducing deleted AIRI/YOLO-era files or bypassing NPC regression gates.

## Findings by priority

### P0/P1 — operation identity is not restart-safe

`packages/autorio/src/task_manager.ts` keeps the task queue, `batch_sequence`, `active_batch_id`, `last_completed_batch`, and `last_cancelled_batch` only in module-local memory. A runtime/mod reload resets the sequence back to `1`.

At the same time, durable consumers retain batch references across reloads:

- Task Board deterministic evidence uses refs such as `batch_1`.
- Skill verification runs are stored in Factorio `storage` and persist `active_batch_id`.

This creates two failure modes:

1. a persisted verifier can wait forever for a batch that disappeared during restart;
2. after restart, an unrelated new `batch=1` can be mistaken for the verifier’s old batch or collide with old Task Board evidence.

Root cause: operation/batch identity is neither persisted nor scoped by an epoch/session/body revision.

Desired direction:

```text
operation identity = runtime epoch/session + batch id
```

or a fully persisted monotonically increasing batch identity with explicit restart reconciliation.

The fix must also define what happens to an active persisted verification run on restart: resume only with provable matching execution identity, otherwise fail/block safely and require deterministic retry.

### P1 — real-Factorio E2E covers body/runtime better than full agent trajectories

The existing real-Factorio lanes are strong at proving the standalone body/runtime does not regress: core operations, research/combat, restart/resilience, and related low-level behavior.

Production planning, construction planning, Task Board/provider orchestration, learning, and skill verification also have meaningful unit/contract coverage.

The missing shape is an ordinary user-goal trajectory such as:

```text
player goal
 -> provider/agent plan
 -> deterministic production solve
 -> topology/layout choice
 -> deterministic validation
 -> physical construction/configuration
 -> world receipt/evidence
 -> Task Board advancement
 -> completion verification
```

The project currently proves many individual layers, but does not yet make this whole path a default reproducible real-Factorio regression lane.

### P1 — learning verification mutates the persistent world without a cleanup policy

The current skill verifier is deliberately real:

- translates a learned instance into a different area;
- validates and builds through normal NPC construction;
- configures recipes and supplies inputs through normal operations;
- re-observes live topology;
- requires a bounded real output delta before promoting a skill.

This is good evidence discipline and must not be replaced by fake/test-only verification.

However, successful/failed verification appears to leave the translated verification factory in the real world and consumes real actor inventory/resources. On a long-running server with autonomous bounded learning, this can accumulate physical verification artifacts.

The project needs an explicit verification-environment policy, for example:

- designated verification zone/sandbox;
- ownership tags/provenance for verification-created entities;
- deterministic cleanup/deconstruction after success/failure where safe;
- explicit resource accounting/reconciliation;
- a policy for when cleanup is intentionally skipped.

Do not implement cleanup by deleting entities magically if the production path is meant to preserve physical constraints.

### P1 — public-server command authority has an unsafe default

`AIRI_CHAT_PLAYERS=""` currently means “allow everyone”, and the NPC E2E deployment defaults to an empty allowlist.

When Factorio credentials make a server public, forgetting to configure an allowlist means any player who can join can also issue the NPC’s chat/UI control requests.

This is not equivalent to arbitrary RCE: model mutation remains constrained by structured policies and Factorio operations. It is still an unsafe operational default for a public autonomous agent.

Recommended policy direction:

- private/dev server may explicitly opt into `*`;
- public deployment should default deny or require an explicit allowlist;
- the runtime should clearly log which command-auth policy is active.

### P1/P2 — placement item resolution is internally inconsistent

Remote robot construction correctly derives the required construction item from `prototype.items_to_place_this`.

Local physical construction currently assumes `entity_name == inventory item name` in at least two places:

- local construction plan inventory validation;
- basic placement runtime inventory lookup/consumption.

That holds for many common vanilla entities, but it is not a general Factorio API invariant and can fail for modded/special entities.

The source of truth should be one shared deterministic helper that resolves the concrete item stack(s) capable of placing an entity. Validation and execution must use the same resolution semantics.

Fail closed for ambiguous/unsupported multi-item placement instead of guessing.

### P1/P2 — swarm is an extension conceptually, but its historical branch is not a clean NPC superset

The current swarm branch contains valuable project-owned coordination work, including Mission/Objective/Project/WorkItem, Blackboard, claims/leases, actor/body revision semantics, requests, reservations, results, and swarm learning provenance.

The branch also contains stale AIRI/YOLO/Pixi-era files and has diverged substantially from the current NPC integration branch.

Swarm integration should therefore be ported/layered onto the latest NPC baseline instead of blindly merging the old branch.

Swarm CI should run:

```text
NPC baseline regression gates
+
swarm-specific regression gates
```

not replace ordinary TypeScript/unit/runtime gates with swarm-only lanes.

### P2 — duplicate Agent/Factorio tool contract authority

Tool semantics are represented in multiple places, notably:

- `packages/agent/src/llm/*`
- `deploy/pterodactyl/staging/structured-policy.mjs`
- `deploy/pterodactyl/runtime-v8/structured-policy.mjs`

The overlap includes names, schemas, argument validation, descriptions, Factorio remote mappings, and completion semantics.

This is not merely code duplication: it creates the possibility that the ordinary agent can use a tool the production/Pterodactyl agent cannot, or vice versa.

Long-term target:

```text
canonical tool/operation definition
  -> packages/agent adapter
  -> Pterodactyl/runtime adapter
  -> shared contract tests
```

If full centralization is too disruptive, first establish a manifest/parity test that fails when tool names/schema/mappings drift.

### P2 — staging/runtime policy ownership is hard to reason about

`runtime-v8/structured-policy.mjs` extends/imports the staging policy, which makes the naming imply the reverse of the actual authority relationship.

This can remain technically valid, but the repository should make one answer obvious:

> Where is the authoritative production tool policy changed?

Prefer a shared/core policy with explicit staging and runtime adapters, or document the current layering and enforce it with tests before renaming directories.

### P2 — single-NPC and swarm learning duplicate orchestration

The single-NPC learning stack is current project-owned functionality and must be preserved:

- `factory_area_learning`
- `learning_pipeline`
- `learning_opportunities`
- `skills`
- `skill_verification`

Swarm already reuses several of these core pieces, which is good. However, swarm also duplicates parts of novelty, candidate qualification, duplicate merge, and verification queue orchestration.

Target shape:

```text
shared Learning Core
  -> single-NPC provenance/trigger adapter
  -> swarm agent/actor/body-revision provenance adapter
```

The skill lifecycle and bounded verification rules should not fork into two independent implementations.

### P2 — long-horizon skill storage/GC policy is incomplete

Individual skill records and verifier history are bounded in several places, but the active skill registry itself can continue accumulating candidate/verified/deprecated definitions over a long-lived server.

A persistent learning server needs an explicit lifecycle policy for:

- active skills;
- failed candidates;
- superseded/deprecated revisions;
- archived/exported skills;
- duplicate scan cost;
- UI/listing limits;
- save-file growth.

This is a long-horizon policy gap, not a reason to remove the learning system.

### P2 — provider loop observes usage well, but admission is request-count centric

The current provider/agent loop already includes useful protections and observability such as:

- epoch guards;
- bounded tool loops;
- duplicate suppression;
- event batching/coalescing;
- prompt compaction;
- static/prototype caching;
- detailed usage tracing.

The remaining gap is that usage information is mostly observational. Request-count limits exist, but there is not yet an equally explicit token/context-cost budget used as admission/backpressure for long goals.

Potential future policy:

- per-goal input/output token budget;
- maximum compacted context size;
- deterministic local-compute escalation before another provider round;
- budget-exhausted pause/block reason visible in Task Board/debug UI.

### P2 — Pterodactyl build provenance includes a deterministic source transform

The deployment builder checks out a source ref and then the source-preparation stage injects the deployment guard into the Factorio source before compilation.

The transform is deterministic and the generated payload is hashed, so this is not inherently unreproducible. The provenance model is simply less obvious because the Git commit tree is not byte-for-byte the compiler input tree.

Recommended future improvement:

- treat source transformation as an explicit named build stage;
- emit a transformed-source manifest/fingerprint;
- include source ref + transform version/fingerprint in release/debug metadata.

### P3 — UI semantic aliases are carrying historical naming debt

The debug/projects UI currently reuses legacy action/slot names. In particular, names such as `DEBUG_CLOSE_BUTTON_NAME` and `close_debug_ui()` can route to Projects behavior for compatibility.

This can work correctly today but makes future maintenance error-prone because identifiers no longer describe their semantics.

Eventually replace hidden aliasing with an explicit UI action router while preserving compatibility at the boundary.

### P3 — repository/deployment naming still has compatibility residue

Some human-readable AIRI/repository names remain in release/deployment surfaces. Compatibility identifiers such as these should not be removed casually:

- `AIRI_*` environment variables;
- `autorio` mod id;
- `autorio_*` remote interfaces;
- `airi-config.json`.

Human-readable artifact names/default repository URLs can be migrated separately when their immutable/pinned deployment chain is intentionally repinned and tested.

## Areas that currently look coherent

The audit did **not** find a reason to redesign these directions:

### Deterministic production planning

The production solver is intentionally conservative:

- reads live recipes/prototypes;
- fails on unsupported probabilistic/multi-product/productivity-sensitive models instead of inventing ratios;
- emits explicit route candidates when recipes are ambiguous;
- requires explicit machine selections for reliable sizing;
- marks topology candidates as unvalidated until belt/inserter/fluid/adjacency validators prove them.

The main future gap is richer Factorio 2.x/Space Age sizing: modules, beacons, quality, real modifiers, fluid constraints, and other advanced mechanics. These should remain explicit unsupported/unvalidated cases until deterministic support exists.

### Map/remote construction boundaries

Remote construction largely follows the desired boundary:

- charted/visible world inspection;
- deterministic validation/preparation;
- actor/force binding;
- expiry and live recheck;
- ghost staging rather than magical completed construction;
- robot/item fulfillment remains a real world condition.

### Project history UI

`packages/autorio/src/projects/project_window.ts` is not a third canonical project/task system. It is a bounded historical projection/archive of durable Task Board goals. It should remain a projection.

### Swarm coordination model

The swarm Mission/Objectives/Projects/WorkItems, Blackboard, claims/leases, actor body revision, evidence-gated results, and reservation concepts are valuable and already model real coordination problems. The main issue is branch baseline/integration discipline, not the existence of these abstractions.

## External-project gap map

Compared with similar Factorio-agent projects, the project has distinctive strengths:

- real persistent standalone NPC body;
- headless/Pterodactyl deployment focus;
- deterministic mechanics and validated operations;
- persistent goals/Task Board;
- evidence-based learning/verification;
- planned multi-agent coordination.

The most useful gaps highlighted by other projects are:

### Factorio Learning Environment (FLE)

FLE treats evaluation trajectories as a first-class artifact: scenario config, agent outputs, environment feedback, game state, usage, and comparable runs.

Factorio NPC already has much of the raw material through behavior traces, usage traces, deterministic receipts, and E2E harnesses. The missing layer is a standardized benchmark object:

```text
scenario
 + initial save/state
 + user goal
 + allowed tools/policy
 + success/failure conditions
 + trajectory/event log
 + provider usage
 + turns/time
 + deterministic final assertions
```

This would allow comparing agent versions rather than only checking whether one regression test passes.

### Agentic-Factorio

Its coordinator/worker/companion-lease model is easier to explain because ownership boundaries are compact. Factorio NPC has richer coordination abstractions, but therefore needs especially explicit canonical ownership and adapter/projection rules.

### Factorio Buddy

Its minimal architecture is a useful complexity check. Factorio NPC intentionally has more layers because it targets persistence, planning, learning, deployment, and swarm behavior. Each additional layer should therefore have a clear authority boundary and measurable value.

## Recommended implementation order

1. Make operation/batch identity restart-safe and add restart regression coverage.
2. Unify entity-to-placement-item resolution between validation and execution.
3. Add a full ordinary-agent real-Factorio production/construction trajectory lane.
4. Define learning verification sandbox/cleanup/resource policy and implement it without fake world mutation.
5. Harden public-server chat/control authorization defaults.
6. Establish canonical tool-contract ownership/parity tests.
7. Consolidate learning orchestration between NPC and swarm.
8. Add long-horizon skill registry GC/archive policy.
9. Turn behavior/usage traces into comparable benchmark trajectories.
10. Add advanced deterministic production sizing only when mechanics can be proven from live state.

## Safe implementation candidates for the current audit branch

The following are bounded enough to implement independently with existing architecture/tests:

- restart-safe operation/batch identity and verifier restart reconciliation;
- shared deterministic placement-item resolver used by both construction validation and physical placement runtime;
- focused regression tests for those changes.

The following should be handled as separate scoped work rather than partially implemented here:

- end-to-end benchmark framework;
- learning verification sandbox/cleanup;
- public-server authorization migration/default change;
- full tool-contract centralization;
- swarm baseline reconstruction;
- advanced Factorio 2.x/Space Age production sizing.

## Non-goals for this audit

- do not keep `main` constantly synchronized with NPC;
- do not remove current learning/skill modules;
- do not replace deterministic mechanics with prompt instructions;
- do not mark skill verification successful without real world evidence;
- do not merge the historical swarm branch wholesale into NPC;
- do not rename compatibility APIs merely for cosmetic consistency;
- do not publish a release from audit work.
