# AIRI Factorio — Jev Cognitive Coprocessor Architecture

Status: **canonical Jev direction**
Branch: `experiment/jev-agent-architecture`
Adopted: 2026-09-21

This document replaces the older model of Jev as a correctness reviewer inside the NPC harness.

The architectural rule is:

> **Jev may decide what reasoning should happen next. Jev does not decide whether the Main LLM was correct.**

The harness must remain correct if Jev is unavailable, wrong, slow, or omitted.

## 1. Authority model

### User

The user owns:

- the goal;
- explicit constraints and priorities;
- approval of material goal changes;
- cancellation and direct steering.

### Main LLM

The Main LLM owns semantic intent:

- strategy;
- plan authoring;
- plan boundaries;
- semantic/prose step meaning;
- operation intent;
- optional deterministic completion contracts;
- deciding when a non-deterministic semantic step is complete;
- revising strategy when runtime evidence shows the current approach no longer works.

The Main LLM is not checked by another AI for correctness before the harness may proceed.

### Deterministic runtime / Autorio / harness

The deterministic layer owns facts and enforcement:

- live Factorio world state;
- actor/session/epoch identity;
- tool schema validation;
- operation preflight;
- physical/safety constraints;
- supported completion predicates;
- operation receipts;
- deterministic completion evaluation;
- persistent-controller health;
- cancellation and lifecycle enforcement;
- persistence and restore invariants.

A deterministic rejection must state the concrete violated contract or world fact. The runtime must not reject an operation because an AI judged it semantically inelegant, too broad, or unrelated to a prose step.

### Jev

Jev is a cheap cognitive coprocessor.

It may:

- choose useful deterministic observations;
- produce typed state-distillation judgments over authoritative world/runtime evidence; deterministic code renders those judgments into bounded Main-LLM context;
- decide whether deterministic work should continue, whether more observation is worthwhile, whether the Main LLM should wake, or whether the user must be asked;
- classify bounded recovery situations and choose the next reasoning route;
- recommend Main-LLM reasoning effort;
- recommend planning horizon;
- classify user interaction intent;
- provide advisory strategic steering such as `vertical | horizontal | maintain | recover`.

Jev does **not**:

- approve or reject a Main-LLM plan;
- decide whether an operation belongs to a semantic step;
- decide whether a plan is "good";
- define or synthesize completion truth on behalf of the planner;
- vote on deterministic step completion;
- reinterpret authoritative receipts as correctness;
- mutate committed plans;
- author replacement plan steps;
- override runtime facts or user priorities.

## 2. Target execution loop

```text
USER GOAL
   |
   v
authoritative runtime snapshot
   |
   v
JEV typed observation relevance / state features
   |------------------------------+
   | missing useful fact          |
   v                              |
deterministic observations -------+
   |
   v
MAIN LLM
strategy / plan / semantic intent
   |
   v
HARNESS BUILDS SCOPED TYPE/CANDIDATE SET
   |
   v
JEV TYPED PROJECTION (when useful)
Choice / Score / Noul over bounded options
   |
   v
DETERMINISTIC HARNESS
compose selected values + schema + identity + preflight + safety
   |
   v
FACTORIO / AUTORIO
   |
   v
authoritative event / receipt / world delta
   |
   v
JEV ROUTING
   |
   +--> continue deterministic runtime
   +--> request targeted observations
   +--> wake Main LLM
   +--> ask user
```

Jev is beside the authoritative execution path, not in front of it as a gate.

## 3. Planning and commit

A Main-LLM draft commits when deterministic structural/runtime admission requirements pass.

Normal commit flow:

```text
Main LLM draft
   |
   v
deterministic validation
   |
   v
COMMITTED
```

The runtime may reject malformed or impossible structured content, for example:

- unsupported operation;
- invalid argument;
- stale exact entity identity;
- locked recipe or technology;
- impossible placement;
- unsupported deterministic completion predicate;
- invalid actor/session/epoch.

The runtime must not ask Jev whether the draft is actionable, well scoped, semantically aligned, or at a good checkpoint before commit.

Plan quality is the Main LLM's responsibility. Poor plans should fail or produce evidence naturally, then cause replanning through the normal reasoning loop.

## 4. Completion

There are two completion classes.

### 4.1 Deterministic step

If the Main LLM supplies a supported deterministic target, runtime closes it automatically when the target is satisfied.

Example:

```text
Step: Have at least 100 stone.
Contract: inventory_count(stone) >= 100
Runtime reads 103 stone.
=> complete
```

Jev is not involved.

### 4.2 Semantic/prose step

Some useful steps are not representable by a deterministic predicate.

Example:

```text
Establish a sensible starter smelting area.
```

Such a step is legal. The Main LLM owns the semantic decision that it is complete.

Do not insert Jev as a pseudo-deterministic semantic judge.

Principle:

> If correctness can be deterministic, make it deterministic. If correctness is semantic, the primary planner owns it.

## 5. Observation selection

Observation selection is a primary Jev responsibility.

M7 implements this as eleven named deterministic observation families rather than an
integer-only observation budget:

```text
runtime_status
inventory_equipment
recipe_production
prototype_knowledge
player_state
nearby_world
entity_status
logistics_transport
research_state
placement_candidates
construction_state
```

The TypeSafe request asks one parallel Noul question per family. Deterministic code
applies a `0.5` threshold and a four-family cap, then maps every observation tool to
exactly one family.

Selection governs **fresh** information acquisition. A fresh read outside the selected
families is deferred before execution and still remains subject to the existing
per-turn observation cap. Cached observations remain reusable even when their family
is not selected because they are already-grounded evidence, not new world reads.

A completely new, ungrounded goal preserves the existing minimum bootstrap read
allowance. If Jev selects no family there, the runtime fails open for observation
selection rather than starving the Main LLM of all world grounding.

The old integer `observation_budget` response is retained only as parser compatibility;
the live TypeSafe decision envelopes no longer ask that Score question.

All observations remain deterministic reads. Jev chooses relevance only and does not
manufacture their values.

## 6. Typed state distillation and working memory

Jev does not generate prose summaries. TypeSafe System One returns typed judgments
(Choice, Score, and Noul), so semantic compression is implemented as bounded typed
features over authoritative state.

M8's first live slice runs at the post-step boundary and derives four features from the
same bounded state already supplied to routing:

```text
state_bottleneck:
  none_known | materials | power | logistics | production |
  research | spatial | safety | runtime_health | information

state_readiness:
  Score 0..4 over a grounded-readiness rubric

state_risk:
  Score 0..3 over semantic consequence/reversibility

state_evidence_conflict:
  Noul probability
```

The deterministic runtime, not Jev, derives provenance labels from the authoritative
state sections actually supplied. Code renders the result in a fixed
`[JEV_TYPED_STATE]` block before the post-step Main-LLM continuation.

The rendered block explicitly says it is advisory and is not world truth, completion
evidence, plan authority, operation admission, or user authority. Malformed or absent
answers render no synthetic state.

The M8 questions are batched into the existing post-step Jev request rather than creating
another provider call. The local conservation default allows 24 questions; the current
M7+M8 post-step request uses 19.

Jev must never be treated as a prose summarizer or free-form memory generator.

## 6.1 Typed operation projection

One strong Jev role is converting already-decided semantic intent into bounded typed
choices when the harness can supply the option space.

The preferred pattern follows TypeSafe's function-calling and pre-parsed-selection
guidance:

1. the harness determines the active operation scope;
2. code enumerates valid operation types and authoritative candidate values;
3. Jev chooses among finite options and closed-set arguments;
4. code composes the selected answers into an operation object;
5. the normal parser and deterministic preflight validate it before execution.

Jev does not invent open-ended quantities, coordinates, prototype names, recipes,
technologies, entity identities, or nested operation objects. Such values must come
from the Main LLM, deterministic computation, or a runtime-generated candidate set.

When a required value is still semantically undecided, Jev should route to observation,
the Main LLM, or the user rather than fabricate it.

## 7. Routing

After an authoritative runtime boundary, Jev chooses the cheapest useful next reasoning route:

```text
continue_runtime
observe
wake_planner
ask_user
```

Examples:

- a healthy persistent controller is still progressing -> `continue_runtime`;
- one mutable fact is missing -> `observe`;
- the result changes strategy or the current plan no longer explains the situation -> `wake_planner`;
- the goal itself is ambiguous or requires user preference -> `ask_user`.

Routing is not correctness review. The runtime validates whether a requested wait/continue route is actually possible.

## 8. Recovery

Jev may choose among bounded recovery paths after a deterministic failure.

Example:

```text
place_entity -> blocked_position

Jev may choose:
- inspect placement candidates;
- reuse a known valid candidate;
- wake planner;
- ask user if a genuine preference is required.
```

Jev never decides that the failed operation actually succeeded, and it never turns a runtime failure into a completion claim.

## 9. Reasoning effort and horizon

Jev may recommend how much Main-LLM reasoning to buy:

```text
normal
deep
strategic
```

and how far it should reason:

```text
immediate
checkpoint
subgoal
strategic
```

These are resource-allocation decisions, not quality gates. Jev does not review the resulting Main-LLM answer afterward.

The old `micro` mode may remain temporarily for compatibility, but new-goal first turns should not be starved by an under-informed Jev classification.

## 10. Strategic steering

`vertical | horizontal | maintain | recover` remains useful as advisory planning context.

Jev may summarize current pressure and recommend a direction. The Main LLM remains free to choose another direction.

Steering must never:

- block plan commit;
- reject mixed work;
- rewrite plan steps;
- advance completion;
- force a mode transition.

## 11. Harness independence requirement

The deterministic harness must be able to operate with Jev disabled.

A Jev outage may cause:

- more Main-LLM wakes;
- less efficient observation selection;
- larger planner context;
- less efficient recovery.

It must not cause:

- inability to commit a structurally valid plan;
- inability to admit an otherwise valid operation;
- inability to evaluate deterministic completion;
- false plan blockers;
- false completion;
- corruption of durable planning state.

This is the key regression contract for the migration.

## 12. Migration from the current experiment

The existing branch contains useful deterministic infrastructure mixed with Jev correctness gates.

Preserve:

- goal / Roadmap Shelf / immutable plan state;
- deterministic preflight;
- grounded predicates and completion evaluation;
- operation receipts;
- Outcome Authority;
- condition waits;
- persistent controller health;
- recovery evidence;
- tracing and debug telemetry;
- interaction routing;
- post-runtime wake/sleep decisions;
- advisory steering.

Remove from active authority paths:

1. pre-commit `scope_review` gating;
2. `step_relation` as an operation-admission gate;
3. Jev `checkpoint_boundary` as a correctness gate;
4. Jev completion-contract selection/synthesis as required authority;
5. `receipt_completion_normalizer` as required semantic completion authority;
6. Jev-triggered plan rejection/refinement loops;
7. Jev-derived user blockers such as refinement-budget exhaustion.

Old helpers may remain temporarily as dead compatibility code while callers/tests are migrated, but they must not remain on the live authority path.

## 13. Migration order

### Slice A — plan commit authority

- remove Jev scope review from plan commit;
- make deterministic runtime validation the commit gate;
- remove Jev refinement as a reason to pause a valid task;
- keep old scope-review code temporarily only if needed for compatibility while tests are migrated.

### Slice B — operation/checkpoint authority

- stop using Jev `step_relation` to admit/reject operation batches;
- stop requiring Jev checkpoint-boundary judgments;
- accept planner-authored supported deterministic contracts directly;
- preserve deterministic contract validation.

### Slice C — completion authority

- remove receipt semantic normalization;
- deterministic contracts close deterministically;
- semantic/prose completion returns to the Main LLM.

### Slice D — useful Jev work

- add explicit observation selection;
- add typed state-distillation judgments plus deterministic rendering into bounded Main-LLM context;
- simplify post-runtime routing to `continue_runtime | observe | wake_planner | ask_user`;
- feed selected context and evidence provenance to the Main LLM.

### Slice E — measurement

Compare:

- Main-LLM-only baseline;
- current Jev architecture;
- cognitive-coprocessor Jev architecture.

Measure:

- task success;
- Main-LLM calls;
- Main-LLM input/output units;
- Jev calls;
- observations;
- operations;
- failed operations;
- replans;
- wall-clock time;
- human intervention.

Every retained Jev responsibility should either save a Main-LLM call, improve the next Main-LLM context, prevent a known bad action through bounded routing, or reduce recovery cost. Otherwise remove it.

## 14. Non-goals

This redesign does not:

- make Jev a second planner or free-form JSON/prose generator;
- make the harness trust free-form AI output;
- remove deterministic safety/preflight;
- remove immutable committed plans;
- remove the Roadmap Shelf;
- remove runtime completion contracts;
- remove user control over structural revisions;
- turn deterministic Factorio mechanics into prompt-only knowledge.

The goal is not "less harness". The goal is a **deterministic harness with less AI bureaucracy**.


## 15. Provider-reality note (2026-09-21)

The current design is grounded in live TypeSafe documentation and the provider adapter.
See `JEV_TYPESAFE_RESEARCH_AND_AUDIT_2026-09-21.md` for the source-backed audit.

The key correction is:

> Jev is a typed probabilistic decision primitive, not a small generative agent.

Design new Jev features around finite selection, classification, scoring, routing, and
candidate choice. Let deterministic code compose and execute the result.
