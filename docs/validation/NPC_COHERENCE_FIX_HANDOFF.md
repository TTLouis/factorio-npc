# NPC coherence fix handoff

This handoff narrows the first implementation pass from `PROJECT_COHERENCE_AUDIT_2026-09-16.md` to two bounded correctness fixes. Do not combine this work with the larger benchmark, learning-sandbox, swarm, authorization, or tool-contract projects.

> Status update (2026-09-19): both bounded fixes are implemented on `experiment/jev-agent-architecture`. Restart-safe operation identity landed in `a1315c4`; shared entity-to-placement-item resolution landed in `270087d` with failure-code follow-up `ad6cade`. Keep the detailed requirements below as regression/upgrade contracts, not as open implementation work.

Base all implementation work on the latest `feat/npc-transition-work`.

## Fix A — restart-safe operation batch identity

### Problem

`packages/autorio/src/task_manager.ts` currently keeps batch identity only in module-local memory:

- `batch_sequence`
- `active_batch_id`
- `last_completed_batch`
- `last_cancelled_batch`

A runtime/mod reload resets the numeric sequence. Durable consumers do not reset at the same boundary:

- `SkillVerificationRun` is persisted in Factorio `storage` and can retain `active_batch_id`.
- the Pterodactyl durable Task Board records operation receipt refs.

A verification run can therefore wait on an operation that vanished during reload, or a newly reused numeric batch id can be mistaken for the pre-restart operation.

### Required semantics

Keep numeric `batch_id` for compatibility and human-readable logs, but add a restart-aware identity.

Recommended minimum representation:

```ts
interface TaskBatchIdentity {
  batch_id: number
  batch_generation: number
  batch_ref: string // e.g. "batch-g7-42"
}
```

`batch_generation` is the Task Manager runtime generation for the loaded save/runtime instance. `batch_id` is a monotonically increasing sequence persisted in Factorio `storage` rather than a module-local counter.

Suggested storage fields:

```ts
airi_task_batch_sequence?: number
airi_task_batch_generation?: number
```

On Task Manager initialization:

1. increment and persist `airi_task_batch_generation`;
2. do not reset `airi_task_batch_sequence`;
3. any new batch increments and persists the sequence.

Expose generation/ref in:

- `active_batch`;
- `last_completed_batch`;
- `last_cancelled_batch`;
- status snapshot top-level generation if useful for diagnostics.

Preserve existing `batch_id` fields and existing human-readable log text where possible.

### Skill verifier reconciliation

`packages/autorio/src/skill_verification.ts` currently stores only `active_batch_id` and compares only numeric batch IDs.

Add optional restart-safe identity fields without making existing saves crash. For example:

```ts
active_batch_id?: number
active_batch_generation?: number
active_batch_ref?: string
```

Do not assume an old persisted run lacking generation/ref can safely resume a pending execution phase.

For states that depend on a submitted batch (`constructing`, `configuring`, `supplying`):

- exact matching active receipt/active batch in the same generation => pending/completed/cancelled as appropriate;
- generation changed => classify as stale execution identity;
- legacy persisted run with `active_batch_id` but no generation/ref => classify as unsafe-to-resume;
- missing matching active/completion/cancellation receipt => do not wait forever.

A restart/stale execution identity is an environment/execution interruption, not evidence that the candidate skill is semantically wrong. Prefer:

```text
verification run -> blocked
opportunity -> awaiting_verification / blocked queue item
reason -> execution identity was interrupted by runtime reload; explicit retry required
```

Do **not** mark the skill verified or semantically failed.

`retry_blocked_skill_verification()` should remain the explicit recovery path.

### Task Board receipt identity

`deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs` currently creates receipt evidence refs from numeric batch IDs such as:

```text
batch_1
```

When new status includes `batch_ref`, use it as the evidence ref. Keep a backwards-compatible fallback for older runtimes that only expose `batch_id`.

Include `batch_generation` / `batch_ref` in the evidence summary for diagnostics.

The harness must not invent a generation if the Factorio runtime does not provide one.

### Tests required

At minimum add/adjust tests proving:

1. first manager can create/complete/cancel batches normally;
2. constructing a new Task Manager against the same persisted `storage` does not reuse the previous numeric `batch_id`;
3. a new manager receives a new generation;
4. active/completed/cancelled batch snapshots include a stable `batch_ref`;
5. a verifier waiting on generation N does not accept an unrelated batch with the same/other numeric ID in generation N+1;
6. stale generation causes verifier blocking, not verification success or semantic failure;
7. a legacy persisted verification run with a pending numeric ID but no restart-safe identity fails closed into a retryable blocked state;
8. Task Board receipt evidence prefers `batch_ref` and still supports old runtimes that only expose `batch_id`.

Do not merely make the numeric ID random. Identity must remain deterministic and diagnosable.

## Fix B — one entity-to-placement-item resolver

### Problem

Placement semantics are inconsistent.

`map_construction.ts` derives a construction item from `prototype.items_to_place_this`, while local construction currently assumes that an entity's prototype name is also the item name:

- `construction_execution.ts` validates inventory using `placement.entity_name`;
- `basic_operation_runtime.ts` calls `inventory.find_item_stack(task.entity_name)` and decrements that stack.

That assumption is common for vanilla entities but is not a safe general Factorio/mod invariant.

### Required semantics

Create one deterministic helper used by all three paths.

Suggested module:

```text
packages/autorio/src/placement_item.ts
```

Suggested result shape:

```ts
export interface PlacementItemRequirement {
  entity_name: string
  item_name: string
  count: number
}

export type PlacementItemResolution =
  | { ok: true, requirement: PlacementItemRequirement }
  | { ok: false, code: 'unknown_entity' | 'not_item_placeable' | 'ambiguous_placement_item' | 'invalid_placement_item' }
```

Resolver source of truth:

```text
prototypes.entity[entity_name].items_to_place_this
```

Requirements:

- never derive the item name from the entity name;
- verify the item/count are valid and bounded;
- if multiple placement-item alternatives cannot be represented unambiguously by the current operation contract, fail closed instead of choosing an arbitrary first entry;
- keep entity identity and item identity distinct in errors/results.

### Local construction validation

`construction_execution.ts` must sum inventory requirements by resolved **item name and item count**, not entity name.

Example:

```text
prototype entity = custom-assembler
items_to_place_this = [{ name: custom-assembler-kit, count: 1 }]
```

A plan for `custom-assembler` must require `custom-assembler-kit`, not `custom-assembler`.

If placement-item resolution is unsupported/ambiguous, validation must fail before issuing a validation token.

### Physical placement execution

`basic_operation_runtime.ts` must use exactly the same resolver before placement.

Before `surface.create_entity`:

- confirm the required concrete item is present in sufficient count;
- do not consume an entity-named item merely because the names happen to match.

After a successful entity creation, consume exactly the resolved placement item count using a bounded, deterministic inventory operation.

If creation fails, do not consume the item.

Do not add free-item compensation or magic inventory insertion.

### Remote construction

`map_construction.ts` should use the same shared resolver rather than maintaining its own `construction_item()` interpretation.

Remote ghost staging still does not directly consume the item; the resolved requirement is used to describe/check construction fulfillment.

### Tests required

Add a fixture where entity name differs from placing item name.

Prove:

1. local plan validation accepts inventory containing the resolved item alias;
2. local validation rejects inventory containing only the entity-named fake item;
3. physical placement looks up/consumes the resolved item alias;
4. blocked/failed placement does not consume it;
5. remote construction reports the same item requirement;
6. ambiguous/multiple placement-item definitions fail closed consistently in local and remote paths.

Keep existing common vanilla entity tests green.

## Scope guard

Do not use this work to modify:

- production solver architecture;
- provider prompts;
- Task Board plan semantics beyond receipt identity;
- learning candidate semantics;
- verification acceptance criteria;
- swarm coordination;
- chat authorization defaults;
- Pterodactyl repo repinning;
- AIRI/autorio compatibility names;
- `main`.

## Validation

Run at least:

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

Also run the applicable Autorio real-Factorio restart/resilience lane if available in the working environment.

Specifically verify a reload/restart between submission and verifier polling does not allow a post-restart batch to satisfy the pre-restart verifier.

## Delivery

Work on a branch derived from latest `feat/npc-transition-work`, e.g.:

```text
fix/npc-restart-operation-identity
```

A single PR may include both fixes only if tests remain clearly separated and the diff stays bounded. Otherwise split into:

```text
fix/restart-safe-operation-identity
fix/placement-item-resolution
```

Do not merge to `main`.
Do not publish a release.
Do not weaken tests.
