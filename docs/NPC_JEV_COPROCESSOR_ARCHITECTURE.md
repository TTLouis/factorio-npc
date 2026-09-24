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

Jev judges relevance from facts the runtime computes, not from what it would have to
infer. The relevance state carries `known_observations` (recent fresh reads, each
marked `stale` once a newer batch has completed), `plan_steps`, and
`active_step_has_completion_evidence`. A missing or stale read never counts as
sufficient evidence.

Reads cost no API money; extra planner rounds and large results do. Jev's budget
therefore bounds rounds, not which facts the planner may see. Every read tool has an
admission tier (`OBSERVATION_TOOL_TIER` in `structured-policy.mjs`):

| Tier | Reads | Jev's role |
|---|---|---|
| fact | current state (actor, task, navigation, crafting, combat, inventory, equipment, entity status/geometry, research status), deterministic game data (recipes, production scope/solve, prototype details, technology, research path), and harness placement choices (`getPlacementCandidates`, `planPlacement`) | none; only harness caps apply (per-batch cap, cache, duplicate suppression) |
| discovery | nearby and long-range entities, enemies, spatial observation, logistics, transport, construction queries, prototype search | ranks them; one is admitted per batch when the planner asks |
| optional | player state, skill lookup | relevance gates them |

Every admitted fresh read counts against the budget. When it reaches zero the
observation phase closes and nothing is admitted, facts included, until the next
decision: that is what bounds the planner's rounds.

Placement uses the harness candidate system rather than model geometry:
`getPlacementCandidates` returns legal positions (with `target_resource` coverage and
each candidate's `item_output_position`), and `covers_position` limits candidates to
footprints covering a point, so a furnace fed by a drill is two harness queries plus
`place_candidate`.

- **Observe-route floor.** When the post-step route is `targeted_observation` but no
  family clears the threshold, one read on the highest-ranked family is admitted.

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

M9 makes the live post-step and recovery vocabulary identical:

```text
continue_runtime
observe
wake_planner
ask_user
```

These are **control-plane requests**, not authority-bearing outcomes.

The deterministic runtime validates them as follows:

- `continue_runtime` is applied only when Autorio, a persistent controller, or a validated condition wait is authoritatively active;
- `observe` enters bounded read-only grounding and remains subject to M7 relevance/caching/cap rules;
- `wake_planner` wakes the Main LLM without changing immutable-plan or completion semantics;
- `ask_user` is honored only when reducer/runtime lifecycle state already requires user authority.

If a route cannot be validated, code falls back to a safer planner/runtime path. Jev does
not get to make runtime activity true by selecting `continue_runtime`, and it does not
get to create a user-authority boundary by selecting `ask_user`.

Reasoning effort, planning horizon, observation relevance, typed state, and strategic
steering remain bounded context/resource signals around this routing layer.

## 8. Recovery

Recovery uses the same four canonical routes plus a bounded failure-class classification.

M9 removes the old live recovery choices that blurred routing with authority:

- `deterministic_close` is no longer a Jev option. If deterministic final-completion
  proof already exists, Outcome Authority closes it **before Jev is called**.
- `propose_blocker` is no longer a Jev option. Jev cannot author durable BLOCKED state.
- `retry_compact | continue_low | replan_high` are no longer live route choices.
  The runtime maps canonical `wake_planner` plus the bounded failure class onto the
  existing planner reasoning path.
- provider-budget recovery no longer asks Jev to change semantic scope. New handoffs keep
  the committed target.

Legacy route names and old persisted semantic-scope values are accepted only so older
saved state/responses can be restored safely; they normalize into canonical
non-authoritative behavior.

Example:

```text
authoritative operation/runtime failure
        |
        v
Jev failure class + canonical route
        |
        +--> continue_runtime -> code proves runtime is active
        +--> observe          -> bounded deterministic read
        +--> wake_planner     -> Main LLM recovery reasoning
        +--> ask_user         -> only if lifecycle already requires user choice
```

Jev never decides that a failed operation succeeded, never claims completion, never
creates a blocker, and never turns confidence into user authority.

## 8.1 Confidence and risk policy

M10 centralizes confidence policy and keeps confidence separate from authority.

Typed operation projection uses operation metadata risk classes, but automatic projection
is **operation-specific**, not a blanket threshold per risk class. The only calibrated
live operation is currently:

```text
walk_to_entity_exact
risk: low
minimum confidence: 0.85
status: existing M6 live baseline
```

All other operations are marked `automatic_projection=false` pending Phase 9 AIRI E2E
measurement. In particular, moderate/high/combat candidates return to the Main LLM even
at confidence 1.0 rather than receiving guessed thresholds.

The routing layer records separate confidence roles for
`continue_runtime | observe | wake_planner | ask_user`, but deterministic guards remain
decisive. Confidence cannot make runtime work active, grant observation admission, claim
planner correctness, or create a user-authority boundary.

The M7 observation relevance probability threshold (`0.5`, at most four selected
families) is documented as an existing bounded-read baseline, not a universal confidence
standard.

Every projected operation still requires normal parsing, freshness checks where
applicable, and deterministic preflight. Confidence is a routing signal only.

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

### Output brackets (2026-09-24)

Each Main-LLM call gets an output cap, reasoning included (`reasoningOutputBudget` in
`runtime-v8/provider.mjs`). Caps are ceilings, not spend. A cap that is too small costs
twice: the exhausted call is discarded and retried, so every bracket leaves room for
reasoning plus the reply.

| Bracket | When | Effort | Cap |
|---|---|---|---|
| plan authoring | `new_goal`, `amend_current`, `plan_slice_completed`, `post_step_replan`, `recovery_replan_high`, whatever Jev rated | max | 32,000 |
| strategic | Jev `strategic` on other turns | max | 24,000 |
| deep / replan | Jev `deep`, ordinary and recovery replans | max / high | 16,000 |
| normal | Jev `normal` | high | 12,000 |
| continue / observe | continuation and observe routes | low | 8,000 |
| other low effort | Jev `micro` and the like | low | 6,000 |
| no reasoning | strict recovery, compact finalization | none | 4,000 |

Plan-authoring turns are never compacted, even right after a completed batch. Compact
continuation replies get 3,000 (thinking off) or 8,000. The per-generation total
(`MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN`) defaults to 100,000 and the provider timeout
(`PROVIDER_TIMEOUT_MS`) to 300,000 ms, since a 32,000-unit reply takes about three
minutes on `deepseek-flash`.

## 10. Strategic steering

`vertical | horizontal | maintain | recover` remains useful as advisory planning context.

Jev may summarize current pressure and recommend a direction. The Main LLM remains free to choose another direction.

Each pressure code carries a plain-language definition and the facts that could show
it (`STEERING_PRESSURE_EVIDENCE` in `planning-state.mjs`). Jev is asked a pressure only
when the steering state carries all of its facts. Today that is the Roadmap Shelf and
`save_progress`; production, power, logistics, resource, research, recipe, defense,
and operation-history facts are not gathered yet, so pressures that need them are not
asked. Add a fact detector when the runtime starts gathering one.

Steering must never:

- block plan commit;
- reject mixed work;
- rewrite plan steps;
- advance completion;
- force a mode transition.

## 10.1 Refined workload boundary — 2026-09-22

The current official TypeSafe guidance reinforces a stricter design rule:

> Keep rules, exact lookups, calculations and workflow control in code; use Jev for
> narrow typed semantic judgments that code cannot express reliably.

The live architecture therefore converges on five Jev responsibilities:

1. interaction intent routing;
2. observation relevance;
3. complete candidate / typed operation selection;
4. ambiguous semantic recovery;
5. optional bounded planning steering.

Before E2E measurement:

- finish exact TypeSafe adapter schema fidelity;
- redesign steering so every consumed value comes from an actual typed question;
- **implemented in M11C:** eliminate permanent Main-LLM-router + Jev-shadow duplication by using high-confidence Jev intent/conflict signals directly for simple lifecycle routing and reserving the language router for ambiguous/conversational cases;
- move deterministic recovery classification/routing out of Jev;
- demote typed-state-to-text planner injection to experimental/trace-only until measured.

See `JEV_REFINED_WORKLOAD_AUDIT_2026-09-22.md` for the full traced rationale and
M11A-E cleanup order.

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

## 16. Jev input contract (2026-09-24)

The TypeSafe request carries only `state`, `model`, and `questions`; there is no system
prompt. All guidance lives in the state the runtime sends and in each question's
`instructions` and `criteria`.

Jev is a general-purpose judge. It weighs supplied facts well but cannot be expected
to know Factorio mechanics or to see world state it was not given. Therefore:

- compute Factorio facts in deterministic code and send them as state;
- ask a question only when the state carries the facts needed to answer it;
- define domain terms in the question text instead of relying on code names.

Every Jev call is recorded in the decision trace as a `decision.exchange` event with
the state it judged, the question ids, and the answers or error. The player's message
is replaced by `message_chars`; the behavior trace holds it for the same request.

### Proposed: offline question tuning (not implemented)

Recorded `decision.exchange` states make wording changes testable without a new game
run or any Main-LLM calls:

1. collect exchanges from provider-backed rounds, keyed by contract;
2. replay each recorded state against Jev with the current and the reworded questions;
3. compare answer distributions against the known outcome of the round (for example,
   whether the read that proved the step was selected);
4. keep a wording change only when it improves those outcomes.

Replay costs only Jev calls. Thresholds such as the `0.5` relevance cutoff should be
calibrated from the same data rather than tuned by hand.
