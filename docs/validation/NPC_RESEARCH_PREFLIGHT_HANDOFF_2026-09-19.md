# Research Preflight Recovery Checkpoint — 2026-09-19

## Status

The deterministic research-preflight and bounded harness-recovery slice is implemented and validated on:

- branch: `experiment/jev-agent-architecture`
- validated branch head: `d88b09fb310be20562dc6b327a272aed48adf050` (`test(devcontainer): satisfy regex lint`)
- CI run: `35486993799`
- CI result: **success**
  - `typescript-quality`: success
  - `factorio-npc-deterministic`: success
  - `pterodactyl-runtime`: success

The research-specific implementation landed in the commit series ending at:

- `df2b2f2680dbbf4b688b7bcc0d309afe8a6c6031` — `fix(research): preflight dependencies and bound recovery`
- `e0ab8c4c17fc9a18230cf9019affbd2f4add6b1b` — `test(research): satisfy CI lint`
- `59df6ab1ae1a763b5604ba40a0cc555c16488b4e` — `fix(research): keep preflight bounds Lua-safe`
- `9dd499eca134e0fdeb86b3320d3797848b861ad2` — `fix(research): type bounded Lua arrays explicitly`
- `1aa91e272a2ff123297f5677a60165051ae085c9` — `fix(research): keep path ingredients Lua-safe`

The later `d88b09f` commit fixes unrelated devcontainer/RCON test lint and is the first branch head after this work with the full CI suite green.

## Original failure

The original agent failure was:

1. the planner observed a dependency path;
2. it nevertheless submitted a locked final technology such as `automation`;
3. Autorio rejected the mutation with `missing_prerequisites`;
4. because research was not deterministically preflighted before batch admission, the runtime could not safely replay or repair the batch and converted a recoverable planning error into a durable blocked task.

This was not a research-completion receipt bug. The mutation had never been admitted.

## Root causes fixed

The slice fixed all three authority gaps that caused the failure:

- `research_technology` is now included in deterministic operation preflight;
- Autorio now computes research preflight from current Factorio state instead of relying on model interpretation;
- the runtime recognizes bounded recoverable research-preflight outcomes and returns deterministic correction facts to the planner without manufacturing a world blocker.

The implementation reuses Factorio-backed research state and dependency planning rather than introducing a second semantic source of truth.

## Deterministic Autorio preflight behavior

Research preflight is read-only. It does not start research, alter the queue, or mark technology complete.

For `research_technology`, current authoritative Factorio state now produces:

- ready / already researched / valid already queued or active: `ok: true`;
- `missing_prerequisites`: `ok: false` with a bounded dependency path and deterministic `next_actionable`;
- `trigger_research`: `ok: false` with the exact deterministic research trigger;
- `force_busy`: `ok: false` with bounded current-research / queue identity;
- permanent errors such as unknown technology, disabled technology, or force research disabled remain deterministic blockers.

Returned path, prerequisite, ingredient, queue, and blocker details are bounded.

Actual operation execution still rechecks eligibility after preflight, so a state change between preflight and admission cannot bypass Factorio authority.

## Harness recovery behavior

The runtime treats these research-preflight reasons as recoverable:

- `missing_prerequisites`
- `trigger_research`
- `force_busy`

For those cases the runtime now:

1. rejects the candidate operation before any mutation batch is admitted;
2. records step-scoped `operation_preflight_recoverable` evidence;
3. preserves the same goal and active canonical semantic step;
4. returns bounded deterministic correction facts to the planner;
5. keeps tools available for a corrected executable decision;
6. allows at most two correction retries after the original provider decision;
7. terminates repeated provider refusal as a recoverable provider/control-plane failure rather than `WORLD_BLOCKED`.

Permanent deterministic research failures continue through the normal blocker path.

Actor/epoch replacement during preflight also cancels the stale turn without inventing a world blocker.

## Authority boundary

The authority split is now:

### Factorio / Autorio authority

Owns:

- technology existence and enabled state;
- force research enabled state;
- prerequisite satisfaction;
- current research and queue identity;
- exact gameplay research trigger;
- dependency-first `next_actionable`;
- mutation admission;
- native completion.

### Runtime / provider recovery

Owns:

- returning deterministic preflight facts to the provider;
- preserving task/step identity while requesting a corrected action;
- bounding correction retries;
- classifying repeated provider refusal as a recoverable provider/control-plane failure.

### Jev

Jev is not authoritative for deterministic research dependencies, triggers, admission, or completion. It may only contribute bounded semantic proposals around task wording or plan representation and cannot override current Factorio state.

## Files changed by the research slice

Primary files:

- `deploy/pterodactyl/staging/structured-policy.mjs`
- `deploy/pterodactyl/staging/structured-policy.test.mjs`
- `packages/autorio/src/control.ts`
- `packages/autorio/src/research_preflight.ts`
- `packages/autorio/src/research_preflight.test.ts`
- `packages/autorio/src/research_path.ts`
- `deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs`
- `deploy/pterodactyl/runtime-v8/research-preflight-recovery.test.mjs`
- `tests/factorio/runner/research.py`

## Regression coverage

### Autorio preflight tests

Coverage includes:

- ready technology;
- already researched;
- valid already queued;
- multi-level missing prerequisites;
- dependency-first `next_actionable`;
- exact trigger research;
- force busy with bounded queue information;
- unknown technology;
- technology disabled;
- force research disabled;
- missing actor;
- invalid name;
- long dependency/ingredient lists remaining bounded;
- confirmation that preflight itself never calls `add_research`.

### Runtime recovery tests

Coverage includes:

- failed research preflight prevents admission of the entire candidate mutation batch;
- missing-prerequisite recovery preserves the same goal and canonical active step;
- snapshot/restore preserves that goal/step after rejection;
- tools remain available for correction;
- deterministic `next_actionable` is returned to the provider;
- trigger and force-busy outcomes remain recoverable;
- permanent unknown technology becomes a blocker;
- repeated provider refusal is bounded to three provider decisions total;
- recoverable research evidence cannot become `operation_preflight_blocker` / `WORLD_BLOCKED`;
- actor epoch replacement cancels stale preflight work without a false blocker.

### Real Factorio assertions

The real Factorio research runner now performs deterministic preflight for:

- unknown technology;
- gameplay-trigger research;
- locked `automation`.

It verifies that:

- trigger identity matches the actual technology observation;
- locked `automation` returns `missing_prerequisites` and a different dependency-first `next_actionable`;
- preflight does not mutate current research or queue state.

The existing direct Autorio admission assertions remain intact:

- unknown research is rejected;
- trigger research is rejected;
- locked `automation` is rejected with `missing_prerequisites`.

The real-engine locked-research guard was not weakened.

## CI validation

On branch head `d88b09fb310be20562dc6b327a272aed48adf050`, CI run `35486993799` completed successfully.

Relevant gates include:

- ESLint;
- TypeScript typecheck;
- generated Lua parse;
- guard against raw JavaScript `.slice()` calls surviving into generated Lua;
- Autorio tests;
- deterministic Factorio NPC harness;
- real zero-player research gate;
- Pterodactyl runtime checks.

The Lua-safety follow-up commits were necessary because the new real Factorio preflight path exposed JavaScript-array assumptions that unit tests alone had not exercised.

## Remaining non-blocking follow-up

This slice is closed for deterministic research preflight and bounded provider recovery.

One stronger future regression is still worthwhile: a single end-to-end real-agent scenario that starts with a provider selecting a locked final technology, observes deterministic `next_actionable`, accepts the corrected prerequisite action, and follows that prerequisite through actual native research completion while preserving the canonical goal/step.

That is additional integration confidence, not a known blocker in the completed preflight implementation.

Broader research work such as repeatable/gameplay-trigger follow-through, interrupted/stalled research recovery through the full agent, and richer request/result correlation remains part of the wider reliability roadmap and should be audited against current source before implementation.

## Branch discipline

- Do not reopen or merge the experimental Jev PR merely because this slice is green.
- Do not merge this branch to `feat/npc-transition-work` or `main` without separate authorization and promotion gates.
- Do not touch swarm work as part of this slice.
- Other agents may modify this branch concurrently; fetch latest HEAD before any future edit and never force-push.
