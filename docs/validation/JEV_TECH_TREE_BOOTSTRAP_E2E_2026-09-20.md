# Tech-Tree Bootstrap E2E Observation — 2026-09-20

## Purpose

Record the first observed failure mode from the renewed real E2E run for the user goal:

```text
advance at least 3 stages of the tech tree.
```

This is an observation record, not a claim that the branch or deployed runtime is currently broken in exactly the same way on every run.

Repository branch inspected while recording this note:

- branch: `experiment/jev-agent-architecture`
- branch HEAD at documentation time: `756e277c3ca8acb9bebfa38a4af131592d8b13b7`
- that branch HEAD is **not** asserted to be the exact deployed SHA of the screenshot/run; the deployed SHA was not visible in the captured UI.

## Observed UI state

The E2E UI showed:

- goal remained active: `advance at least 3 stages of the tech tree.`
- generated plan had three semantic steps:
  1. gather bootstrap raw materials: coal for fuel and iron ore;
  2. smelt iron plates and hand-craft the first red science packs;
  3. research and complete at least three technologies;
- no plan step had been verified;
- AIRI was idle after finishing the request rather than executing the first gather operation;
- the visible failure text was:
  `[Plan needs clarification] The draft still did not converge after 2 bounded refinement passes. Jev reasons: jev_scope_review_unavailable.`

The execution activity repeated bootstrap-planning prose / observations and did not visibly enter the actual `gather_resource` operation before the request ended.

## Classification

This goal should remain an E2E target. It is not considered too difficult merely because this run failed.

The failure happened before meaningful Factorio execution. The primary classification is therefore:

```text
planner / Jev refinement-path failure
not
Factorio gameplay-task impossibility
```

The specific first suspect is the scope-review/refinement path represented by:

```text
jev_scope_review_unavailable
```

A failure to obtain the optional Jev scope review should not, by itself, force a reasonable high-level gameplay goal back to the user for clarification if a safe executable frontier can still be formed.

## Plan-quality issue exposed by the run

The three-step draft was directionally reasonable but under-specified for a true empty-start technology bootstrap.

The plan only named coal, iron, smelting/red science, and research. A valid early-game dependency chain may also require the planner/runtime to discover and satisfy additional grounded prerequisites such as:

- copper for automation science;
- a lab;
- electrical power needed by the lab;
- materials for the required power infrastructure;
- technology prerequisite ordering;
- additional crafting/material dependencies exposed by the actual live Factorio state.

The harness should not hardcode one prose bootstrap recipe merely to make this scenario pass. Instead, deterministic Factorio-backed dependency/preflight data should expose the missing prerequisites and keep invalid downstream operations from being admitted.

This observation is consistent with the existing research-preflight design: Factorio / Autorio owns exact technology eligibility and prerequisite facts, while provider/Jev logic should use those facts rather than inventing a second research authority.

## Acceptance interpretation

Keep the user-facing goal broad:

```text
advance at least 3 stages of the tech tree.
```

For deterministic E2E acceptance, normalize the measurable outcome to something equivalent to:

```text
Complete at least 3 new technologies relative to the research state at task start.
```

Do not require the user to name the exact technologies in advance. The planner should choose a valid route from current game state.

A healthy semantic progression can be represented as:

```text
observe current bootstrap state
-> establish required resources/material processing
-> establish required lab/power/science infrastructure
-> research technology 1
-> satisfy newly exposed prerequisite frontier
-> research technology 2
-> satisfy next prerequisite frontier
-> research technology 3
-> verify at least 3 new completed technologies
```

The exact steps may differ. The important requirement is that the active frontier remains executable and grounded.

## Follow-up run currently in progress

After the first failure, the user supplied an additional corrective prompt and started another attempt.

Do not mark that attempt pass/fail until its actual trace/result is observed.

The corrective prompt should be treated as a diagnostic aid, not as the permanent solution. A successful run that only succeeds because an operator manually explains the missing planning behavior should generate a harness/planning follow-up so the same goal works without special coaching.

## Failure-to-repair prompt protocol

If the next E2E run fails again, stop giving only narrative diagnosis. Produce a copy-paste repository repair prompt targeted to the observed failure class.

### Case A — same `jev_scope_review_unavailable` / refinement failure before execution

The repair prompt should instruct an agent to:

- fetch latest `experiment/jev-agent-architecture` HEAD first;
- reproduce/trace the initial plan refinement path;
- determine why unavailable Jev scope review exhausts bounded refinement;
- preserve bounded refinement but add a safe fallback when the goal is already actionable;
- ensure fallback cannot silently rewrite a committed active plan;
- add a focused deterministic regression for:
  `reasonable new goal -> Jev scope review unavailable -> executable plan/frontier still produced or precise non-user clarification failure`;
- verify no no-op planning loop and no repeated identical refinement prose;
- keep research dependency authority in Factorio/Autorio rather than Jev.

### Case B — plan commits, but bootstrap omits grounded prerequisites

The repair prompt should instruct an agent to:

- trace the exact planning observations and preflight packets available to the planner;
- verify recipe, research, lab, power, ingredient, and technology-prerequisite facts are reachable through existing deterministic tools;
- add only the missing grounded capability/read if a fact is unavailable;
- do not hardcode a red-science/three-tech scenario script;
- add regression coverage proving known missing prerequisites prevent invalid downstream action and expose an actionable frontier.

### Case C — research operation reaches deterministic `missing_prerequisites` but the task stalls/blocks

The repair prompt should build directly on `docs/NPC_RESEARCH_PREFLIGHT_HANDOFF_2026-09-19.md` and verify:

- preflight returns bounded `next_actionable`;
- same goal and canonical step remain intact during correction;
- recoverable preflight does not become `WORLD_BLOCKED`;
- corrected prerequisite research can be admitted and followed through native completion;
- the active plan advances only on verified completion.

### Case D — repeated planning/no-op loop

The repair prompt should inspect live authoritative planning-state wiring, restore/frontier advancement, and no-progress detection. The fix should eliminate repeated equivalent planner rounds rather than merely increasing retry counts or timeouts.

## Promotion rule for this scenario

Do not call this tech-tree E2E capability validated from a single lucky model run.

A useful promotion record should capture at minimum:

- exact deployed SHA;
- Factorio/mod/save or fixture state;
- provider/model/reasoning configuration;
- exact user goal;
- generated committed plan;
- operation/preflight receipts;
- completed technology set at task start and finish;
- whether any operator corrective prompt was required;
- final pass/fail reason;
- provider usage and no-progress/refinement counts.

Once one clean unassisted run passes, repeat the same initial-state fixture enough times to distinguish a real capability from a stochastic one-off.


## Second observed failure — simpler production goal

A second E2E attempt used the substantially simpler user goal:

```text
半自动化铁和铜片
```

The generated five-step draft was:

1. collect iron ore;
2. collect copper ore;
3. collect coal and make a stone furnace;
4. place/configure the furnace for iron/copper smelting;
5. verify iron- and copper-plate output.

This attempt failed at the same pre-commit boundary before meaningful execution completed:

```text
[Plan needs clarification] The draft still did not converge after 2 bounded refinement passes.
Jev reasons: jev_scope_review_unavailable.
```

The debug state simultaneously showed the active first operation as aligned with the current step and semantically advancing it. This makes the failure materially stronger evidence that the problem is not simply an over-ambitious tech-tree goal.

### Source inspection after the second failure

Inspection of current `deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs` on branch HEAD showed the exact fail-closed path:

- if no scope-review provider exists at all, the runtime returns an `actionable` review with reason `jev_unavailable_no_decision_provider`;
- if a scope-review provider exists but throws/fails, the catch path converts that availability failure into:
  - `verdict: needs_grounding`;
  - `reason_codes: [jev_scope_review_unavailable]`;
- `handleScopeReviewRefusal()` then increments `scopeRefinementAttempts`;
- after the bounded refinement budget is exhausted, the runtime ends the request as `awaiting_user_clarification`.

This means a Jev transport/provider/capability failure is currently treated like a substantive semantic criticism of the Main LLM's draft.

### Updated diagnosis

The current gate is too strict specifically around **review availability**, not necessarily around Jev's semantic scope criteria.

The desired distinction is:

```text
Jev says "refine / needs grounding"
    -> semantic refusal; bounded re-authoring is appropriate

Jev says "needs user clarification"
    -> user clarification is appropriate

Jev review cannot be obtained
    -> control-plane availability failure; do not pretend Jev semantically rejected the draft
```

An unavailable review should not repeatedly consume the same semantic refinement budget and should not be transformed into a user-clarification requirement.

The fix should preserve the pre-commit safety boundary without making Jev a single point of failure. The exact fallback should be regression-driven, but it should distinguish `review unavailable` from an actual negative review, keep the error visible in telemetry, and either:

- safely commit when deterministic/runtime validation plus the existing plan contract make the draft independently admissible; or
- return a precise recoverable control-plane failure without asking the user to clarify an already-clear goal.

Simply increasing `JEV_SCOPE_REFINEMENT_BUDGET` is not considered a real fix.


## Scope-review packet expansion — implementation started 2026-09-20

The first repair intentionally does **not** loosen Jev's verdict handling or increase the refinement budget. It expands the evidence packet first so the next E2E can distinguish a genuinely strict reviewer from an under-informed reviewer.

The scope-review packet is being upgraded from roughly:

```text
goal
+ step descriptions
+ has_completion_contract true/false
```

to a bounded V2 packet containing:

- goal and draft identity;
- active step index and plan lineage metadata;
- each draft step's completion-contract status and supported contract when available;
- current proposed operation names/arguments;
- deterministic operation-preflight results;
- step semantic-alignment/checkpoint result;
- bounded recent observation-tool results, including inventory/recipe/research/world reads already obtained by the Main LLM;
- a bounded live-entity summary from observed nearby/exact entities;
- current runtime task status when available;
- explicit review semantics distinguishing the current executable frontier from later steps that are intentionally produced by earlier steps.

The key semantic clarification is:

```text
current frontier
  -> must be grounded enough to execute now

later step whose prerequisite is explicitly produced earlier in the same draft
  -> conditionally grounded / planned dependency
  -> not automatically an ungrounded world assumption
```

This keeps Jev a critic rather than a planner and keeps Factorio/runtime as world-truth authority. The packet is bounded so the repair does not turn scope review into a full world dump.

The separate `jev_scope_review_unavailable` fail-closed behavior is intentionally left unchanged in this first slice. Re-run E2E with the richer packet before deciding whether the next repair should alter provider-failure handling.


## Screenshot correction — stale `LAST` row was from the previous terminated run

A later review of the second screenshot clarified that the Status panel's red `LAST` value:

```text
submitPlan.plan must be an array
```

did **not** belong to the current `半自动化铁和铜片` attempt. It was retained from the previous run that the user terminated and remained visible after starting a new task.

Source inspection explains the UI artifact: `packages/autorio/src/task_board_ui.ts` prefers the global retained `activity_state.activity_history()` when rendering the Status-panel `LAST` row. The New Task path resets the task conversation but does not reset or re-scope that retained activity history. Therefore an old blocker/result can remain visible under a new logical task.

Do not use that stale `submitPlan.plan must be an array` row as evidence for the current Jev scope-review failure.

The current run still ended with:

```text
jev_scope_review_unavailable
```

after the richer V2 review packet was installed. That keeps the next diagnostic priority on the scope-review provider/parse path itself.

Follow-up UI requirement:

- make retained activity task-scoped (prefer `conversation_id`, with `goal_id` as fallback);
- reset/rebind it on New Task and runtime-originated logical-task changes;
- ensure Status `LAST`, Plan Tracker activity, and Debug activity cannot display a previous task as though it belongs to the current task;
- keep historical activity available only through old-task/project history surfaces.

Follow-up Jev observability requirement:

- surface the exact `planning.scope_review_failed.reason` in the live debug UI;
- show scope-review state explicitly as `actionable | refine | needs_grounding | needs_user_clarification | unavailable`;
- keep `jev_scope_review_unavailable` as the classification, but expose whether the underlying failure was provider, parse/schema, transport, timeout, cancellation, or another concrete error.


## Scope-review observability + current-task UI boundary implemented

The diagnostic/UI follow-up has now landed. The implementation intentionally leaves Jev's semantic review criteria and the existing unavailable-review fail-closed behavior unchanged so the next E2E can reveal the actual failure rather than masking it.

Implementation sequence:

- `4cf6b6c8b08f8a5ce0d20a5e40836ed17c514c53` — exact Jev scope-review failure classification and live debug wiring;
- `bdccf2afd88a1199b30b4f10bde40cd831a91d04` — current-task retained-activity context plus three-column Debug layout;
- `1df03bc008d615db364fb17f1f47f940bdd743a5` — New Task / Terminate / snapshot boundaries explicitly rebind retained activity;
- `f7e110e18219e98e441369f9386613e78995cb4a` — read-only Roadmap Shelf projected through the authoritative Plan Tracker view;
- `3b65f6f49fa019ffd9a31c50d56909bbb16e0c1d` — Roadmap Shelf rendered in the left planning column and active immutable plan slice moved to the right;
- follow-up regression alignment through `252bac478cd832d63804dc9ffbc5f5ef9155533e`.

### Jev scope-review diagnostics

The runtime now separates scope-review failure stage from semantic verdict:

```text
scope-review provider call throws
  -> planning.scope_review_failed
  -> failure_stage=provider
  -> failure_kind=provider | transport | timeout | cancellation | unknown

provider call returns, parseScopeReview throws
  -> planning.scope_review_failed
  -> failure_stage=parse
  -> failure_kind=parse_schema
```

The live Debug snapshot now carries:

- scope-review status;
- reason codes and confidence;
- actionable prefix;
- review packet version;
- grounding-observation count;
- live-entity count;
- deterministic-preflight count;
- exact bounded failure stage/kind and reason.

The Debug UI is now three columns:

```text
LLM / Provider | Jev / Planning | Step / Runtime
```

so provider-generation diagnostics, Jev/planning diagnostics, and runtime/step diagnostics no longer compete for the same two columns.

Request-local scope-review/post-step failure fields are cleared when a new request begins. Cumulative Jev economics/counters may persist, while stale request-local verdicts/errors do not.

### Current-task activity boundary

Retained execution activity is now treated as a current-logical-task cache rather than a global feed. It is keyed primarily by `conversation_id`, with `goal_id` as fallback.

A logical-task change, New Task, Terminate, or board clear resets/rebinds that retained activity. Therefore:

- Status `LAST`;
- the retained Plan Tracker activity compatibility feed;
- Debug execution activity

must not present a previous terminated task as though it belongs to the current task. Historical task activity remains an Old Tasks / project-history concern.

### Roadmap Shelf visibility

The authoritative read-only `planTrackerView` now carries a bounded Roadmap Shelf projection alongside the immutable active plan slice.

The console Plan Tracker renders approximately:

```text
+----------------------+------------------------------------------+
| Roadmap Shelf        | Active immutable plan slice              |
| ~1/3                 | ~2/3                                     |
| coarse future intent | executable semantic steps + verification |
+----------------------+------------------------------------------+
```

Shelf nodes expose bounded planning context such as intent, status, dependencies, development hint, and whether the node is linked to the active slice. They remain non-executable storage: rendering the Shelf does not give it operation authority.

### Validation

At final implementation HEAD `252bac478cd832d63804dc9ffbc5f5ef9155533e`:

- CI run `35552750568`: **success**
  - `factorio-npc-deterministic`: success
  - `typescript-quality`: success
  - `pterodactyl-runtime`: success
- Pterodactyl release gates run `35552750731`: **success**

The next real E2E should reuse the simple diagnostic goal:

```text
半自动化铁和铜片
```

If scope review is unavailable again, capture the new Debug rows `Jev scope review`, `Scope review packet`, and `Scope review failure`. That should identify whether the remaining defect is provider, transport/timeout, cancellation, or parse/schema without relying on the generic `jev_scope_review_unavailable` wrapper.
