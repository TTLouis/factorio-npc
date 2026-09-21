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
