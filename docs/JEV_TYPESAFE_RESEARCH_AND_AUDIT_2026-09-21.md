# Jev / TypeSafe Research and AIRI Architecture Audit

Status: **current design audit**
Date: 2026-09-21
Branch: `experiment/jev-agent-architecture`
Audited HEAD: `9d5c0d2fe2a06cd9ddec74be8aa5b833550c00e7`

This document records what Jev actually is, where the current AIRI experiment matches
TypeSafe's intended programming model, where it diverges, and the revised implementation
roadmap.

It is deliberately source-backed. The live TypeSafe documentation remains the external
source of truth for Jev API behavior and design guidance.

## 1. What Jev actually is

Jev is TypeSafe AI's first public **System One** model.

It is not a chat LLM and it does not generate text, code, explanations, JSON blobs, or tool
calls in the usual generative-model sense.

Its programming model is:

```text
state
+
typed questions
    |
    v
typed probabilistic answers
```

The public primitives are:

- **Choice** — select one option from a caller-defined finite set; returns the selected
  option, a probability distribution, and confidence.
- **Score** — evaluate a caller-defined ordered rubric; returns a score, the level
  distribution, and confidence.
- **Noul** — evaluate a true/false statement; returns P(true) from 0 to 1.

The model does not invent a value outside the options supplied by code. TypeSafe describes
this as "unstructured state in, typed probabilistic decisions out."

Relevant official sources:

- https://typesafe.ai/blog/introducing-system-one-models-and-jev
- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one
- https://docs.typesafe.ai/introduction/coding-agents
- https://docs.typesafe.ai/agent-skill

## 2. TypeSafe's intended architecture

TypeSafe explicitly recommends:

1. **Code owns control flow, deterministic rules, and side effects.**
2. Use System One only for narrow semantic judgments that ordinary code cannot make
   robustly.
3. Ask many independent questions over the same state in parallel.
4. Compose the answers in code.
5. Treat confidence/probabilities as routing signals, not as proof of correctness.
6. Escalate uncertainty to code, a reasoning model, or a person.
7. Generate/fetch candidate values in code whenever possible, then let Jev select among
   them.

This is much closer to a software decision primitive than to a second agent.

The official workflow guidance says:

```text
deterministic rules -> code
semantic judgment   -> System One
composition         -> code
side effect         -> code
```

This supports the direction of removing Jev from AIRI's correctness-authority path.

## 3. The most relevant TypeSafe patterns for Factorio

### 3.1 Function calling

TypeSafe has an official function-calling cookbook:

https://docs.typesafe.ai/cookbooks/function_calling

Its design is directly relevant to AIRI.

The cookbook:

- gives Jev a Choice over known functions;
- turns closed-set arguments such as enums/Literals into Choice questions;
- uses Noul for optional flags/presence;
- asks all independent function/argument questions together;
- lets code consume only the answers for the selected function;
- leaves free-form numbers, free text, and other open values to code/defaults rather than
  pretending Jev can generate them.

The important lesson for AIRI is:

> Jev can route to an Autorio operation and fill closed-set arguments, but it should not be
> treated as an arbitrary operation-object generator.

### 3.2 Pre-parsed candidate selection

TypeSafe's extraction cookbook uses ordinary code to over-generate candidate values, then
has Jev select one of those candidates verbatim:

https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook

That is highly suitable for Factorio.

Examples of candidates AIRI can construct deterministically:

- nearby entity identities;
- known resource patches;
- current recipes;
- researched/researchable technologies;
- inventory item names;
- placement candidates;
- construction plans;
- machine targets;
- player names;
- currently valid controller modes.

Jev then selects among real candidates. It cannot fabricate an omitted value.

### 3.3 Smart-home command decomposition

TypeSafe's smart-home demo evaluates one request with parallel questions for request
category, domain, device, and action, then code performs the actual operation:

https://docs.typesafe.ai/demos/smart-home

This is a close analogue for:

```text
Factorio semantic intent
    |
    +-- operation family
    +-- target kind
    +-- target candidate
    +-- action variant
    +-- optional flags
    |
    v
code assembles an Autorio operation
```

### 3.4 Intent routing

Jev is well suited to deciding which handler should run:

https://docs.typesafe.ai/patterns/intent-routing

For AIRI that includes:

- deterministic runtime continuation;
- targeted observation;
- typed operation projection;
- full Main-LLM wake;
- user clarification.

### 3.5 Confidence is not authority

TypeSafe's confidence guidance is explicit:

https://docs.typesafe.ai/confidence

Confidence is a routing signal derived from a Choice/Score distribution. It is not a
certificate that the result is correct and must not replace deterministic validation.

For AIRI:

- high-confidence low-risk projection may be admitted to deterministic preflight;
- uncertain projection should request observation or wake the Main LLM;
- destructive/irreversible operations may require stricter thresholds or explicit
  planner/user authority;
- every accepted operation is still parsed/preflighted by the harness.

## 4. What the current AIRI redesign gets right

### 4.1 Removing Jev correctness review is correct

The removal of:

- plan `scope_review`;
- semantic `step_relation` admission;
- `checkpoint_boundary` voting;
- receipt-completion semantic judging;
- Jev-authored/refined completion truth;

is aligned with TypeSafe's own architecture.

Jev is designed to provide structured judgments to code. It should not become a second
planner that grades the first planner.

### 4.2 Deterministic harness authority is correct

Keeping these in code/runtime is strongly aligned with TypeSafe guidance:

- schemas;
- actor/session/epoch identity;
- preflight;
- prototype/recipe/technology validation;
- safety;
- physical execution;
- receipts;
- completion predicates;
- persistence;
- plan lifecycle invariants.

### 4.3 Scoped operation types are directionally correct

The new operation metadata added on this branch is useful:

- approved operation names;
- argument-key metadata;
- semantic operation scopes such as navigation/resources/construction/production.

It gives the harness a finite domain from which to construct Jev questions.

However, the scope map is **our application taxonomy**, not a Jev primitive. It must remain
reviewable, tested, and derived from the operation registry so it cannot silently drift.

## 5. What the current redesign gets wrong or overstates

### 5.1 Jev cannot write semantic working-memory prose

The current canonical coprocessor document says Jev should compress runtime evidence into
a bounded semantic summary.

That is wrong if interpreted as generated prose.

Jev can instead produce a **typed state distillation**, for example:

```json
{
  "bottleneck": "stone",
  "iron_ready": true,
  "copper_ready": true,
  "fuel_risk": "low",
  "planner_wake": "not_needed"
}
```

Those values must come from Choice/Score/Noul answers over authoritative state.

Code may then render a compact deterministic text block for the Main LLM.

### 5.2 Jev cannot formulate a user question

Jev may classify:

```text
route = ask_user
reason = ambiguous_target
```

but it cannot generate the actual conversational question.

The Main LLM or a deterministic template must produce the user-facing wording.

### 5.3 Jev is not an arbitrary JSON formatter

It is valid to say TypeSafe replaces fragile "return JSON" prompts for decisions, but it
does so by constraining each answer to a primitive.

It does **not** mean Jev can accept:

```text
"build a furnace over there"
```

and emit an arbitrary object containing coordinates, quantities, recipe names, entity ids,
and nested operation structures.

For open-valued arguments AIRI needs one of:

1. a value already supplied by the Main LLM and validated by code;
2. a value computed deterministically;
3. a finite candidate set generated by runtime and selected by Jev;
4. a planner wake when the value is genuinely semantic and still undecided.

### 5.4 The first typed-projection prototype has an independence bug

Current file:

`deploy/pterodactyl/runtime-v8/jev-typed-projection.mjs`

asks separate questions for:

- projection route;
- operation type;
- operation candidate.

TypeSafe evaluates questions in the same request independently. Therefore the three answers
may legitimately disagree.

The parser currently detects some mismatches and falls back to `wake_planner`, which is
safe, but the contract is needlessly self-conflicting.

Do not wire this prototype into execution unchanged.

For a candidate set below the Choice cardinality limit, prefer one primary Choice such as:

```text
projection_action:
  candidate_17
  candidate_42
  need_observation
  wake_planner
  ask_user
```

or use TypeSafe's official function-calling shape:

- one function Choice;
- parallel questions for each function's closed-set arguments;
- code consumes only arguments belonging to the selected function.

Use a second request only when the first answer is genuinely required to construct the
second request's candidates/options.

### 5.5 Our TypeSafe wrapper under-models the public API

Current `provider.mjs` validation requires:

- string `instructions`;
- string Choice criteria descriptions.

Current TypeSafe docs allow instructions and criteria to be strings, objects, or arrays.

This matters because structured criteria are useful for:

- target role;
- exclusions;
- examples;
- source/provenance;
- scope-specific contrasts.

The wrapper should be updated to accept the provider's actual supported structured shapes
with bounded validation rather than flattening everything into strings.

## 6. Revised AIRI responsibility split

### User

Owns:

- goal;
- constraints;
- material preferences;
- cancellation;
- approval of structural plan changes.

### Main LLM

Owns slow semantic reasoning:

- strategy;
- plan authoring;
- semantic step meaning;
- decisions involving open-ended quantities/layout/novel construction;
- open-valued arguments that cannot be computed or enumerated;
- semantic completion for prose-only steps;
- user-facing conversation.

### Jev / TypeSafe

Owns fast bounded judgments:

- request/interaction classification;
- operation-family routing;
- closed-set argument selection;
- selection among runtime-generated candidates;
- optional-argument presence;
- observation relevance;
- runtime-vs-planner-vs-user routing;
- recovery-route classification;
- reasoning-budget / horizon choice;
- typed state features and bottleneck labels;
- advisory strategic steering.

Jev does not own:

- plan correctness;
- world truth;
- arbitrary numeric generation;
- arbitrary text generation;
- operation execution;
- completion authority;
- side effects.

### Deterministic harness / Autorio

Owns:

- candidate discovery;
- schemas;
- open-value parsing when deterministic;
- operation assembly;
- scope/type registry;
- confidence/risk policy;
- preflight;
- identity;
- safety;
- execution;
- receipts;
- completion predicates;
- persistence;
- lifecycle.

## 7. Revised target flow

```text
USER
 |
 v
MAIN LLM
strategy + semantic plan + open-ended intent
 |
 v
HARNESS builds projection state
- active step
- authoritative facts
- operation scope
- valid candidates
- known closed sets
 |
 v
JEV / SYSTEM ONE
typed judgments only
- select operation family/candidate
- select closed-set args
- flag missing observation
- route to planner/user when uncertain
 |
 v
HARNESS
- compose selected typed answers
- apply confidence/risk rules
- validate operation schema
- deterministic preflight
 |
 v
AUTORIO / FACTORIO
 |
 v
authoritative receipt/world state
 |
 +--> deterministic completion
 |
 +--> JEV routing / observation relevance
 |
 +--> MAIN LLM when semantic reasoning is needed
```

## 8. Revised implementation roadmap

### Phase 0 — freeze and document provider reality

Status: **in progress**

- keep this research document current;
- correct canonical Jev architecture claims that assume text generation;
- remove remaining stale planning-roadmap scope-review text;
- mark the current typed-projection module as experimental/not wired;
- do not add new Jev authority until the provider contract is aligned.

Exit condition:

- docs agree on what Jev can and cannot output.

### Phase 1 — TypeSafe adapter fidelity

Update `provider.mjs` so our local contract matches the live provider:

- structured instructions;
- structured Choice criteria;
- current Choice cardinality;
- correct Score/Noul shapes;
- model/version handling;
- bounded request-size checks;
- tests against representative provider responses.

Centralize Jev questions and threshold constants in reviewable files, consistent with
TypeSafe's own agent guidance.

Exit condition:

- the AIRI adapter is no longer a lossy approximation of TypeSafe's public API.

### Phase 2 — authoritative operation/type registry

Turn operation metadata into a single reviewable source of truth.

For each operation record:

- operation name;
- semantic scopes;
- argument names;
- argument kind:
  - deterministic/open numeric;
  - boolean flag;
  - closed enum;
  - runtime candidate;
  - exact entity identity;
  - free semantic value requiring planner;
- risk class;
- preflight support;
- candidate provider where applicable.

Add invariants:

- every approved operation has metadata;
- every scope references real operations;
- runtime-v8 extensions cannot shadow incompatible base metadata;
- candidate providers return values accepted by `parseOperation`.

Exit condition:

- the harness can mechanically say what Jev may decide and what it may not.

### Phase 3 — Main-LLM intent boundary

Do not force the Main LLM to perfectly serialize every low-level operation.

Keep `submitPlan` for durable plan/control state, but introduce a clear distinction between:

- semantic operation intent;
- already-complete deterministic operation objects.

The Main LLM remains responsible for values Jev cannot natively produce, especially
open-ended quantities or novel layouts.

Exit condition:

- prose/action-omission failures no longer require the LLM to reconstruct the entire
  low-level operation format when enough semantic intent is already present.

### Phase 4 — TypeSafe-native operation projection

Replace the current prototype with the official function-calling pattern.

For a bounded active scope:

1. code enumerates valid functions/operations;
2. code gathers candidate sets;
3. Jev chooses the operation;
4. Jev answers parallel questions for closed-set arguments and optional flags;
5. code ignores answers for non-selected functions;
6. open arguments come from deterministic code, runtime candidates, or Main LLM intent;
7. code assembles the operation;
8. parser + preflight remain mandatory.

Where the exact operation is already represented as a finite candidate object, use a single
Choice over candidate IDs plus escape hatches.

Exit condition:

- Jev can materially reduce malformed/omitted LLM control output without becoming a
  planner or side-effect authority.

### Phase 5 — observation selection

Status: **implemented in M7 (2026-09-21)**

The live decision contract now replaces the integer observation-budget Score with
parallel Noul relevance judgments over eleven reviewable families:

```text
need_runtime_status
need_inventory_equipment
need_recipe_production
need_prototype_knowledge
need_player_state
need_nearby_world
need_entity_status
need_logistics_transport
need_research_state
need_placement_candidates
need_construction_state
```

The runtime has a complete observation-tool-to-family registry. Deterministic code uses
a `0.5` relevance threshold and selects at most four families. Fresh observation calls
outside the selected families are deferred before tool execution; the normal per-turn
read cap still applies. Identical cached observations remain reusable because relevance
selection controls new information acquisition, not access to already-grounded facts.

For a completely new ungrounded goal, the existing minimum bootstrap observation
allowance is preserved and an empty relevance selection fails open rather than starving
the Main LLM of all grounding. Legacy `observation_budget` Score answers are accepted
only as parser compatibility and are no longer emitted in the TypeSafe question set.

Jev chooses relevance; deterministic tools produce the facts.

Exit condition status:

- the typed selection/admission contract is implemented and covered by focused tests;
- measurement of whether it reduces redundant observations belongs to the later E2E
  comparison phase.

### Phase 6 — typed state distillation

Replace the impossible free-form "Jev summary" concept with typed features.

Examples:

- current bottleneck Choice;
- capability-present Nouls;
- uncertainty/risk Scores;
- next-handler Choice;
- resource/production readiness flags.

Code renders those features plus authoritative provenance into the Main-LLM context.

Exit condition:

- context reduction is measurable and does not invent prose/world facts.

### Phase 7 — routing and recovery

Retain/finish Jev where it naturally fits:

- continue runtime;
- observe;
- wake planner;
- ask user;
- bounded failure-class/recovery-route choice;
- reasoning effort;
- planning horizon;
- advisory vertical/horizontal/maintain/recover steering.

No route may override deterministic impossibility or claim completion.

### Phase 8 — confidence and risk policy

Add explicit per-decision/per-operation confidence policy.

Do not use one global threshold.

Examples:

- harmless observation routing: permissive;
- reversible movement: moderate;
- construction/destruction/combat: stricter;
- user-authority changes: never inferred solely from confidence.

Calibrate thresholds from AIRI E2E data rather than copying cookbook examples.

### Phase 9 — E2E measurement

Compare:

1. Main-LLM-only structured output baseline;
2. old Jev correctness-gate architecture;
3. revised TypeSafe-native coprocessor.

Measure at minimum:

- task success;
- malformed/omitted Main-LLM operation outputs;
- Main-LLM calls;
- Main-LLM input/output units;
- Jev calls/input tokens;
- Jev confidence distributions;
- projection fallbacks;
- observation count;
- operation/preflight failures;
- replans;
- wall-clock time;
- human interventions.

Run simple known-success tasks first, then production lines, research dependencies, fluid
systems, combat, and long-horizon factory tasks.

## 9. Current branch audit verdict

### Keep

- immutable plan / Goal / Roadmap Shelf architecture;
- deterministic runtime authority;
- deterministic preflight;
- completion contracts;
- Outcome Authority;
- condition waits;
- runtime receipts;
- interaction classification;
- reasoning/horizon routing;
- operation metadata work;
- removal of old Jev correctness gates.

### Correct before wiring

- `jev-typed-projection.mjs` question shape;
- `provider.mjs` structured instruction/criteria support;
- scope/type registry duplication and invariants;
- canonical docs that imply Jev writes summaries or explanations.

### Remove / keep removed

- scope review;
- step-relation admission;
- checkpoint-boundary correctness voting;
- receipt semantic completion judging;
- refinement-budget user blockers;
- any path where Jev says an operation/plan/result is "correct."

### Do not build

- a Jev free-form JSON generator;
- a Jev prose summarizer;
- a second autonomous Jev planning loop;
- confidence-as-permission without deterministic validation;
- hand-maintained candidate values that runtime could enumerate authoritatively.

## 10. Are we on the right track?

**Broadly yes, after this correction.**

The strongest parts of the redesign are:

- deleting Jev correctness authority;
- keeping code/runtime authoritative;
- using TypeSafe for cheap bounded semantic decisions;
- moving toward scope/candidate-aware operation projection.

The main mistake was thinking of Jev as a small structured generative model. It is better
understood as a set of fast probabilistic software primitives.

The architecture should therefore optimize for:

> **select, classify, score, route, and gate — then let code compose and execute.**

That is both closer to TypeSafe's intended use and a better fit for Factorio's strongly
structured world.
