# Jev Workload Refinement Audit — 2026-09-22

Status: **pre-E2E architecture cleanup authority — M11A-E implementation reconciled on 2026-09-22; CI/E2E validation still pending**

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
| incoming interaction | intent Choice + queue-conflict Noul; planner-shape questions only when planning will wake | M11C hybrid: high-confidence simple intents route directly from Jev; ambiguous, conversational, and uncertain amendment-conflict cases use the Main-LLM language router |
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

The adapter must model the current official TypeSafe SDK contract exactly rather than
a remembered/hand-written approximation.

The current official JavaScript SDK defines `EntryType` as:

```text
string | object | array | null
```

and uses it for state, instructions and criterion descriptions. Therefore:

- top-level `state` must reject root number/boolean values, but **null is valid**;
- `instructions` are optional and may be `null`;
- Choice descriptions may be `null`;
- Score rubric entries may be `null`;
- Noul criteria may be absent, `null`, or an object containing optional
  `true`/`false` EntryType descriptions;
- nested JSON inside an object/array may still contain ordinary JSON scalars;
- tests must mirror the official SDK's accepted/rejected forms rather than impose
  stricter undocumented rules.

The current adapter already gets several of these right; M11A should change only real
contract mismatches.

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

### 3.3 P2 — redesign interaction routing as a hybrid, not a Jev replacement

The user interface is still natural language. Jev should not replace the Main LLM's
ability to understand nuance, converse naturally, explain state, or interpret open-ended
requests.

Before M11C, the live flow spent a Main-LLM JSON interaction-router call plus a Jev
classifier call on every routed interaction. M11C removes that permanent duplication.

The live policy now uses the Jev intent/conflict result directly for high-confidence,
low-ambiguity lifecycle intents. It calls the Main-LLM language router only when
natural-language nuance is still useful: conversational replies, low-confidence intent,
or an amendment whose queue-conflict probability is not decisive.

Selective double evaluation remains intentional where both calculations provide
independent value.

Target policy:

```text
user natural language
        |
        +--> Jev bounded intent / conflict signal
        |
        +--> Main LLM natural-language interpretation when semantic nuance,
             amendment meaning, conversational response, or open-ended planning matters
        |
        v
deterministic lifecycle dispatch
```

For obvious low-ambiguity control intents, Jev plus deterministic state may be enough to
avoid a separate Main-LLM routing-only call. For ambiguous/high-impact interactions,
**double evaluation is allowed and desirable** when the Main LLM and Jev answer different
questions:

- Jev: bounded intent/conflict probability;
- Main LLM: natural-language meaning, user-facing interpretation and semantic planning.

Do not require duplicate classification on every turn merely for agreement. Use the
second calculation where disagreement/ambiguity/high impact changes handling, and trace
both signals so later measurement can determine whether the extra call is worth it.

Natural-language user interaction remains a first-class Main-LLM responsibility.

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

Interaction intent is a hybrid boundary: Jev contributes a typed signal, while the Main
LLM remains available for natural-language interpretation and user-facing conversation.
Selective double evaluation is part of the design when the two computations are
meaningfully independent.

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

Status: **implemented / contract-audited; CI validation pending.**

Fix the TypeSafe adapter and exact contract tests.

### M11B — steering contract redesign

Status: **implemented; typed steering heads and finite shelf-node selection are live.**

Delete generated-field expectations and duplicate steering questions. Add finite
runtime shelf-node selection only where useful.

### M11C — hybrid interaction routing

Status: **implemented on 2026-09-22.** High-confidence bounded Jev intents can now handle simple routing directly; ambiguous, low-confidence, amendment-conflict, and conversational cases retain the Main-LLM language router. Planning/open-ended semantics still wake the Main LLM.

Remove wasteful routing-only duplication without removing natural-language interaction.

Use Jev as a typed intent/conflict signal; retain Main-LLM interpretation for ambiguous,
open-ended, conversational, amendment, and planning-heavy requests. Permit selective
double evaluation where independent signals improve handling.

### M11D — recovery simplification

Status: **implemented and regression expectations reconciled on 2026-09-22; CI validation pending.**

Move deterministic classifications/routes entirely into code and retain Jev only for
ambiguous semantic recovery.

### M11E — typed-state demotion

Status: **implemented.** Typed state remains trace-only telemetry and is not injected into Main-LLM context.

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
