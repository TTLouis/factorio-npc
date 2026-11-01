# Run C recipe applicability static follow-up

Owner: recipe-applicability unit, based on `48182d2a`; branch `fix/run-c-recipe-applicability`.

## Change

`getRecipeDetails` derives recipe eligibility from the loaded native recipe prototype's `surface_conditions`, the actor's native surface properties, and `ignore_surface_conditions`. It records available, unavailable, or unknown independently of recipe enablement. Recipe names and expansion names are never used as eligibility rules. Native applicable alternatives precede unavailable matches before the eight-recipe response cap; an unavailable exact-name producer does not suppress local alternatives.

Executor recipe ingestion excludes only a valid native surface-condition mismatch and evicts an older eligible fact for that recipe. Unknown/missing metadata remains labeled unknown. Locked recipes remain planning dependencies; enabled, hidden, hidden-from-player-crafting and hand-craftable-category fields survive normalization for execution eligibility consumers.

Surface-bound available facts are expired before each executor handoff and re-read through the existing bounded native recipe closure. This covers same-epoch surface changes, actor replacement, and changes to the native ignore flag. Failed/deferred refresh cannot resurrect them. Excluded recipes are not negative-memoized: exact-query history alone never satisfies a later recipe-cache hit. The correlated `context.recipe_applicability` event records `request_id` and either `native_surface_condition_mismatch` or `surface_evidence_requires_refresh`.

## Gates

`bash scripts/test-local.sh all`, executed using Git Bash and the existing `npc-dev` Docker image: **exit 0**.

- Runtime: 2,133 tests passed, 0 failed.
- Mod: 1,107 tests passed across 124 files.
- TypeScript typecheck, Lua build and generated-Lua validation passed.
- `git diff --check` passed.
- Full local output: `recipe-applicability-gates.log` (ignored, retained in the unit worktree).

Regression seams include native property bounds/ignore flag/unreadable properties, response-cap ordering with nine unavailable alternatives, exact-query ingestion and correlated exclusion, actor replacement and same-epoch surface change, failed/deferred refresh, locked/hidden metadata preservation and explicit unknowns.

An initial generated-Lua check caught an untyped array `.length` on conditions; declaring the installed native `SurfaceCondition[]` type corrected the Lua output. The final gate above includes that correction.

## Limits and integration

This is deterministic/static evidence, not real-engine or autonomous completion. No live model, Jev call, deployment, secret read or push occurred. The installed `typed-factorio` native declarations were the API source. Loaded prototype presence is not proof that an unbuilt machine or its research is available: those remain separate prerequisites. This unit filters proven recipe surface incompatibility; it does not invent machine placement or planet-travel capability from recipe names. Research-dependent `enabled` metadata is observation-time evidence and must be refreshed by an execution consumer after research changes.

Parent owns merge review, installer payload repin, integration gates and any real-engine/live promotion. Changes to `npc-agent-loop.mjs` are confined to the recipe-details cache seam, recipe prefetch request correlation, and handoff surface-fact expiry.
