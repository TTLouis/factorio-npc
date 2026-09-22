# Jev Workload Refinement Audit — 2026-09-22

Status: **pre-E2E architecture cleanup authority**

This audit pauses Phase 9 E2E work until the live Jev workload matches the current
TypeSafe/System One programming model closely enough that an experiment would measure
Jev itself rather than avoidable adapter/orchestration mistakes.

## Sources

This audit compares the live branch against current TypeSafe guidance, especially:

- TypeSafe official skill:
  https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md
- System One:
  https://docs.typesafe.ai/concepts/system-one
- How to build with System One:
  https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- State:
  https://docs.typesafe.ai/concepts/state
- Primitive reference:
  https://docs.typesafe.ai/primitives
- Confidence:
  https://docs.typesafe.ai/confidence
- Function calling:
  https://docs.typesafe.ai/cookbooks/function_calling
- Speculative fan-out:
  https://docs.typesafe.ai/patterns/fan-out

The relevant provider model is:

> code owns the workflow; Jev supplies bounded typed semantic judgments where normal
> code needs common sense.

Choice, Noul, and Score outputs are judgments/probabilities, not generated prose,
permission, world truth, or workflow correctness.

## 1. Live workload trace

As of HEAD `584b04832dc0b6964aaee9171f0a1be384535785`, Jev is called in these live roles:

| Boundary | Live Jev workload | Current status |
| --- | --- | --- |
| incoming interaction | intent Choice, queue-conflict Noul, reasoning budget, planning horizon, 11 observation-relevance Nouls | shadow classifier alongside a separate Main-LLM interaction router |
| goal/plan boundary steering | development/steering Choice | useful semantic classification, but schema/parser currently expect unsupported extra generated fields |
| observation selection | 11 parallel relevance Nouls | strong TypeSafe-native fit |
| typed operation projection | one Choice across complete harness-built candidates plus observe/planner/user fallbacks | strong TypeSafe-native fit |
| post-step boundary | route, development, reasoning, horizon, 11 observation Nouls, bottleneck/readiness/risk/conflict | valid fan-out mechanics, but too many unrelated policy roles share one broad state |
| recovery | failure-class Choice plus recovery-route Choice | partly useful, partly duplicates deterministic lifecycle/failure knowledge |

## 2. Keep as core Jev responsibilities

### 2.1 Observation relevance fan-out

Keep the M7 model:

- narrow independent Nouls;
- deterministic observations produce facts;
- code thresholds/caps/caches;
- Jev never invents observation values.

This is close to the official speculative fan-out pattern.

### 2.2 Complete candidate / typed operation selection

Keep and expand cautiously:

1. Main LLM or deterministic code decides semantic intent;
2. runtime enumerates authoritative complete candidates;
3. Jev selects one candidate or a fallback;
4. code checks freshness, schema, risk and preflight;
5. Autorio executes.

This follows the official "select instead of generate" / function-calling pattern.

## 3. Required cleanup before E2E

### 3.1 P0 — exact provider-schema fidelity

The adapter must model the TypeSafe wire contract exactly rather than as generic JSON.

Required corrections:

- top-level `state` accepts the documented string/object/array forms, not arbitrary
  scalar JSON values;
- structured `instructions` do not accept root `null`;
- Score criteria entries do not accept root `null`;
- Noul true/false descriptions do not accept root `null`;
- Choice descriptions may remain nullable where TypeSafe explicitly permits it;
- tests must exercise the exact accepted/rejected forms.

Do this before interpreting any E2E provider failure as a Jev/model failure.

### 3.2 P1 — redesign steering into real typed questions

The current steering parser expects:

- `reason_codes`;
- `critical_path_summary`;
- `candidate_shelf_nodes`;

but the live TypeSafe request does not ask typed questions capable of producing those
fields. The request also duplicates the same development-mode judgment as both
`development` and `steering`.

Replace this with independently useful typed judgments only.

Target shape:

```text
development_mode:
  Choice(vertical | horizontal | maintain | recover)

next_shelf_node:
  Choice(runtime-generated shelf node ids + none)
  only when candidate shelf nodes exist and selection is useful

world_invalidated_current_direction:
  Noul
  only when the boundary state can genuinely invalidate the current direction

capacity_is_current_bottleneck:
  Noul
  only when that distinction changes the next slice
```

Do not ask Jev for generated reason text or summaries. Code may render typed values and
authoritative provenance for the Main LLM.

### 3.3 P2 — remove permanent interaction-router duplication

Intent classification is a natural Jev/System One task.

Current live flow spends:

```text
Main-LLM JSON interaction router
+
Jev interaction classifier in shadow
```

The target is:

```text
user message
   |
   v
Jev intent Choice
   |
   +--> status_query      -> deterministic status reply
   +--> continue_current  -> deterministic lifecycle
   +--> cancel_current    -> deterministic cancellation
   +--> amend_current     -> deterministic lifecycle / Main LLM when semantic work is needed
   +--> new_goal          -> Main LLM planner
   +--> chat_only         -> language model only if a natural reply is wanted
```

Promotion must preserve a deterministic/fallback path when Jev is unavailable.

### 3.4 P3 — shrink recovery to fuzzy judgments only

Keep exact rules in code.

Deterministic code already knows many cases:

- provider budget exhaustion;
- provider safety refusal;
- parse/format failure;
- authoritative runtime already active;
- deterministic completion;
- observation allowance exhausted;
- lifecycle already requires user choice.

Do not spend Jev judgment capacity re-classifying facts already known exactly.

The remaining useful semantic recovery question is closer to:

```text
recovery_semantics:
  Choice(missing_fact | semantic_replan | grounded_world_failure | unclear)
```

and/or a narrow Noul such as:

```text
can_one_bounded_observation_resolve_this?
```

Code then maps those judgments to `observe` or `wake_planner` and applies all lifecycle
guards itself.

### 3.5 P4 — typed state is experimental, not foundational

M8 currently asks for bottleneck/readiness/risk/conflict and renders those values back
into a `[JEV_TYPED_STATE]` text block for the Main LLM while detailed authoritative
state/receipts are still also present.

That does not yet prove context compression.

Until measured, typed-state distillation should be:

- trace-only or explicitly experimental;
- excluded from any authority path;
- removable without changing correctness;
- promoted back into planner context only if measurements show token/call/quality value.

## 4. Post-step fan-out policy

The current 19-question post-step call is not invalid merely because it has many
questions. TypeSafe explicitly supports independent speculative questions over shared
state.

The issue is semantic cohesion and state relevance.

Before E2E, separate the conceptual roles:

### Runtime-control/read-selection layer

- continue runtime vs wake planner;
- bounded observation relevance;
- facts tied closely to immediate runtime state.

### Planner-shape layer

Run only when the Main LLM will actually wake and the judgment can affect that wake:

- reasoning effort;
- planning horizon;
- optional strategic steering.

Avoid buying planner-shape judgments on a boundary where deterministic runtime will
continue and no Main-LLM call occurs.

## 5. Refined Jev target

The preferred steady-state architecture has five Jev responsibilities:

1. **interaction intent routing**;
2. **observation relevance fan-out**;
3. **complete candidate / typed operation selection**;
4. **ambiguous recovery classification**;
5. **optional bounded planning steering**.

Everything else must justify itself with measurable value.

A retained Jev call should do at least one of:

- remove a Main-LLM call;
- reduce Main-LLM context/tokens;
- select a safe bounded candidate from an authoritative set;
- avoid unnecessary observations;
- choose a cheaper semantic recovery path.

If it does none of those, remove it.

## 6. Revised milestone order

E2E comparison is deferred until this cleanup is complete.

### M11A — provider-schema fidelity

Fix the TypeSafe adapter and exact contract tests.

### M11B — steering contract redesign

Delete generated-field expectations and duplicate steering questions. Add finite
runtime shelf-node selection only where useful.

### M11C — interaction routing consolidation

Promote Jev intent routing from shadow toward the live routing source while preserving
fallback behavior.

### M11D — recovery simplification

Move deterministic classifications/routes entirely into code and retain Jev only for
ambiguous semantic recovery.

### M11E — typed-state demotion

Make M8 typed-state planner injection experimental/trace-only pending measurement.

### Later — Phase 9 E2E measurement

Only after M11A-E are stable compare Main-LLM-only and TypeSafe-coprocessor behavior.
Do not use the retired correctness-gate architecture as a live experimental arm;
historical traces are sufficient for that architecture.

## 7. Non-negotiable authority model

The cleanup does not change these invariants:

- user owns goals/preferences/structural approval;
- Main LLM owns semantic planning/open values;
- Jev owns bounded typed semantic judgments only;
- deterministic runtime owns world truth, schema, lifecycle, safety, preflight,
  receipts and deterministic completion;
- Autorio owns execution;
- Jev confidence is never permission or correctness.
