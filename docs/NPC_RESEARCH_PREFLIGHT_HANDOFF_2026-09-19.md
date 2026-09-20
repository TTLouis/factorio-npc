# Research Preflight Recovery Handoff — 2026-09-19

## Status

Implementation is intentionally deferred until the current five-hour Codex usage window resets. At handoff time, approximately 21% remained and the user requested a hard 20% reserve.

Target branch: `experiment/jev-agent-architecture`

Current remote head: `93156e1` (`fix(autorio): approach rejected mining targets`)

## Observed failure

The user requested progress through at least two technology-tree nodes. The planner called `getResearchPath`, but then submitted:

```text
research_technology { technology_name: "automation" }
```

Autorio rejected the operation with:

```text
[false,"missing_prerequisites",1]
```

Because `research_technology` is not currently included in deterministic operation preflight, the rejection happened during batch admission. The harness then correctly refused to replay the batch because earlier operations might already have produced side effects, but this converted a recoverable dependency-selection error into a durable blocked task.

This is not a completion-receipt bug: the research mutation was never accepted and therefore cannot produce completion evidence.

## Root cause

- `deploy/pterodactyl/staging/structured-policy.mjs` omits `research_technology` from `PREFLIGHTED_OPERATIONS`.
- `packages/autorio/src/control.ts` has no research branch in `operation_preflight`.
- `packages/autorio/src/research.ts` already exports deterministic `research_error(actor, name)`.
- `packages/autorio/src/research_path.ts` already exports `plan_research_path(actor, target, max_nodes)` with dependency-first `pending_path` and `next_actionable`.
- `deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs` only treats `stale_exact_target` as a recoverable preflight result. Other preflight rejections become durable blockers.

The system prompt already tells the planner to follow `getResearchPath.next_actionable`; prompt wording alone is therefore not a sufficient fix.

## Required behavior

### Autorio preflight

Add `research_technology` to deterministic preflight.

For that operation, validate the requested technology against the current controlled actor and return bounded structured data:

- ready or already queued/researched: `ok: true`;
- `missing_prerequisites`: `ok: false`, including the requested technology and bounded `research_path.next_actionable`;
- `trigger_research`: `ok: false`, including the exact deterministic `research_trigger` from the path node;
- `force_busy`: `ok: false`, including enough current research/queue identity to re-observe or wait safely;
- `unknown_technology`, `technology_disabled`, or `research_disabled`: deterministic blocker.

Do not make preflight itself start research or mark a technology complete. Admission must recheck eligibility to protect against state changes between preflight and execution.

### Harness recovery

Treat `missing_prerequisites`, `trigger_research`, and `force_busy` as recoverable research-preflight outcomes:

1. record step-scoped evidence without marking the canonical task blocked;
2. preserve the same goal and active canonical step;
3. return the structured path/trigger/current-research facts to the planner;
4. keep tools enabled and request one corrected executable decision;
5. enforce a small retry limit so a provider that repeatedly ignores `next_actionable` fails upward as a recoverable provider failure instead of looping or inventing a world blocker.

Permanent deterministic research errors remain blockers.

### Jev boundary

No Jev call is needed to compute the technology dependency path or select `next_actionable`; those are exact game facts.

Jev may be used only for a bounded semantic question such as whether the canonical step wording should remain focused on the target technology or be represented as prerequisite progress. Any such result is a typed proposal and cannot override the deterministic path, trigger, admission result, or completion evidence.

## Suggested parallel work

1. **Autorio preflight agent**
   - update `structured-policy.mjs`, `control.ts`, and Autorio tests;
   - reuse `research_error` and `plan_research_path`;
   - keep returned details bounded.
2. **Harness recovery agent**
   - add bounded recoverable research-preflight routing in `npc-agent-loop.mjs`;
   - preserve goal/step identity and prevent retry loops;
   - add runtime integration tests.
3. **Review/test agent**
   - test ready, missing prerequisite, trigger, busy, disabled, repeated-ignore, and actor/epoch replacement cases;
   - confirm no batch admission occurs after a failed preflight;
   - verify permanent blockers remain fail-closed.

Agents share the same worktree. Coordinate before editing `npc-agent-loop.mjs`; do not overwrite unrelated work.

## Validation gates

- Autorio research and preflight unit tests.
- Runtime structured-policy and recovery integration tests.
- Existing research Factorio runner remains semantically correct: direct `automation` submission without prerequisites must still be rejected by Autorio admission.
- `git diff --check` and relevant syntax/type checks.
- If local Factorio is already available, rerun the minimal scenario: request two technology-tree nodes and confirm the first submitted mutation targets `getResearchPath.next_actionable`, not the blocked final target.

Do not weaken the real-Factorio assertion that locked research is rejected.

## Commit and push plan

Create one or two focused commits, for example:

```text
fix(autorio): preflight research dependencies
fix(jev): recover research prerequisite selection
```

Fetch before pushing and fast-forward `origin/experiment/jev-agent-architecture`. Never force-push. The configured remote currently redirects from `TTLouis/airi-factorio` to `TTLouis/factorio-npc`; the redirect worked for the preceding push.

