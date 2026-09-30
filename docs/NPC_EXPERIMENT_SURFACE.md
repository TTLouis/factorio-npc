# SGLuna Factorio — NPC Experiment Surface / Workshop

**Status:** Design discussion draft. Not implemented. No engine validation is claimed.

## 1. Purpose

SGLuna should have access to an isolated Factorio experiment environment where it can test gameplay hypotheses against the real game engine instead of relying only on model memory, static reasoning, or risky experimentation in the live factory.

The experiment surface is not a gameplay automation system and must not contain hard-coded solutions to Factorio problems.

Its responsibility is to provide controlled experimental conditions, execute the requested setup using the actual Factorio engine, and return structured observations.

Conceptually:

```text
Goal / unknown gameplay problem
        ↓
Agent forms hypothesis
        ↓
Experiment specification
        ↓
Isolated Factorio surface
        ↓
Real engine execution
        ↓
Structured observations
        ↓
Agent accepts / rejects / revises hypothesis
        ↓
Possible SkillCandidate
```

The harness provides the laboratory.

The model decides what experiment to run and what the result means.

---

## 2. Relationship to existing systems

The experiment surface is separate from both normal construction and large-project ghost staging.

```text
Experiment Surface
"What happens if I build this?"
        ↓
knowledge / evidence

Ghost Staging
"I intend to build this here."
        ↓
construction preview

Normal World
"Build and operate it for real."
```

The existing large-build proposal and ghost-staging design is concerned with planning authorized construction in the live factory. It explicitly treats ghosts as construction plans rather than proof that production works.

The Workshop addresses a different problem: testing whether an idea itself works before committing it to the live world.

Relevant adjacent documents include:

- `docs/NPC_SITE_PING_GHOST_STAGING.md`
- `docs/NPC_LEARNING_BOOTSTRAP_E2E.md`
- `docs/NPC_AGENT_HARNESS_PLAN.md`
- `docs/NPC_AGENT_HARNESS_STATUS.md`

---

## 3. Architectural boundary

The Workshop must preserve the same separation of responsibility as the rest of the NPC architecture.

```text
Harness:
- creates controlled conditions
- executes engine operations
- measures facts
- enforces isolation and budgets

Skill:
- stores reusable Factorio knowledge and evidence

Agent:
- forms hypotheses
- designs experiments
- interprets results
- chooses what to learn and reuse
```

A useful test for every Workshop feature is:

> Does this feature tell SGLuna what happens, or does it tell SGLuna what it should do?

The former belongs here.

The latter usually does not.

The Workshop must not become a hidden Factorio strategy engine or a collection of special-case solvers such as `testCoalSnake()` or `solveSmelterLayout()`.

---

## 4. Core isolation rule

Nothing created for an experiment may provide gameplay progress to the normal world.

The Workshop may use privileged engine facilities because its purpose is semantic testing rather than resource progression.

It may create:

- entities without consuming normal inventory;
- controlled resource patches;
- arbitrary test items;
- artificial power;
- infinite item and fluid sources;
- item and fluid sinks;
- controlled terrain;
- bounded test enemies where explicitly required by a later scope.

However, experiment state must not leak back into normal gameplay.

At minimum, the Workshop should isolate:

```text
surface
force or equivalent experiment authority
inventories
research effects where practical
pollution
entities
resources
production output
experiment fixtures
```

Items produced in the Workshop must never become normal SGLuna inventory.

Technologies unlocked only for an experiment must not unlock normal-force technologies.

An experiment is evidence, not progression.

---

## 5. System under test versus fixtures

The Workshop should explicitly distinguish the **system under test** from the **test fixtures** surrounding it.

This distinction is essential for trustworthy evidence.

```text
fixture source
     ↓
┌────────────────────┐
│  System Under Test │
└────────────────────┘
     ↓
fixture sink
```

Fixtures may provide deterministic inputs and measurements.

They must not replace the mechanism being tested.

General rule:

> Fixtures may replace irrelevant prerequisites, never the behavior under test.

Examples:

- If testing an assembler layout, upstream mining and smelting may be replaced by controlled plate sources.
- If testing a furnace feeding strategy, furnaces and their feeding mechanism must remain inside the system under test.
- If testing inserter throughput, a loader must not bypass the inserter being evaluated.
- If testing burner-miner self-fueling, infinite coal must not be injected into the tested drills after initialization.

Experiment evidence should record which entities and flows are fixtures and which belong to the system under test.

---

## 6. Map-resource fixtures

When the experiment concerns extraction, mining-drill orientation, direct mining output, resource coverage, mining throughput, or self-sustaining burner mining, the Workshop should create actual Factorio resource entities.

Examples include:

```text
coal
iron-ore
copper-ore
stone
uranium-ore
crude-oil
```

The experiment specification should be able to describe resource setup using fields such as:

```text
resource prototype
patch position
patch shape / radius
per-tile amount
optional richness profile
```

A mining experiment should normally use a real resource patch rather than supplying ore through an Infinity chest.

This preserves real mining-drill semantics including coverage, orientation, output position, mining progress, and resource depletion behavior where relevant.

For experiments not concerned with depletion, resource amounts may be intentionally very large so that depletion does not contaminate a short bounded test.

---

## 7. Item-source fixtures

For experiments where raw material acquisition is not itself under test, SGLuna needs controlled item sources.

The primary V1 item fixture should be an **Infinity chest** or equivalent engine-supported infinite container.

Typical arrangement:

```text
Infinity chest
  iron-plate = controlled source
        ↓
transport mechanism
        ↓
experimental production cell
```

This allows SGLuna to ask questions such as:

```text
Will this assembler arrangement actually run?

Can this belt feed all machines?

Does this inserter configuration sustain the required flow?

Does this production chain produce the expected output?
```

without first recreating an entire mining and smelting economy.

The source should be configurable by the experiment spec rather than by hard-coded gameplay categories.

Useful source controls may include:

```text
item name
source inventory slot/filter
source mode
optional bounded starting count
optional sustained unlimited supply
```

---

## 8. Loader fixtures

Loaders are useful Workshop fixtures for creating deterministic belt boundaries.

For example:

```text
Infinity chest
      ↓
    Loader
      ↓
====== belt ======
      ↓
experimental block
```

or:

```text
experimental block
      ↓
====== belt ======
      ↓
    Loader
      ↓
Infinity sink chest
```

Loaders should normally live at the experimental boundary.

They must not be inserted inside the system under test unless loader behavior itself is the subject of the experiment.

### Fixture-boundary example

If the question is:

> Can this inserter feed an assembler fast enough?

then this is invalid:

```text
Infinity chest
      ↓
Loader
      ↓
Assembler
```

because the loader bypasses the inserter behavior being tested.

A valid arrangement is closer to:

```text
Infinity chest
      ↓
Loader
      ↓
input belt
      ↓
TESTED INSERTER
      ↓
Assembler
```

The Workshop may simplify irrelevant upstream or downstream systems, but it must not simplify away the mechanism whose behavior is being investigated.

---

## 9. Output sinks and measurement

An experiment often needs an unlimited destination as well as an unlimited source.

An Infinity chest configured as a sink, optionally reached through a loader, can prevent output blockage from invalidating a throughput experiment unless output storage or backpressure is itself part of the test.

Example:

```text
test assemblers
      ↓
output belt
      ↓
Loader
      ↓
Infinity sink
```

The Workshop should still measure output crossing the experiment boundary before it is discarded.

Useful measurements include:

```text
items produced
items consumed
items crossing each experiment boundary
inventory deltas
machine crafting cycles
blocked / starved states
fuel state
belt contents
recipe progress
power state
fluid state / throughput where measurable
stable operating duration
```

The model should receive measurements rather than an opaque design verdict whenever practical.

Prefer:

```text
transport-belt produced: 184
iron-plate consumed: 368
gear-wheel consumed: 184
assembler idle due to missing input: 0 ticks
output blocked: false
observed duration: 3600 ticks
```

instead of:

```text
"This factory design is good."
```

---

## 10. Fluid fixtures

The same fixture principle should extend to fluids.

Use an Infinity pipe or equivalent engine-supported fixture when a controlled fluid source or sink is needed and fluid generation is not itself under test.

For example:

```text
Infinity pipe (water source)
        ↓
pipe network under test
        ↓
chemical plant
```

If the question concerns pumps, pipe behavior, fluid routing, fluid-box compatibility, or machine fluid consumption, those mechanisms must remain part of the system under test.

If the question concerns water acquisition or offshore-pump behavior, an Infinity pipe must not bypass that behavior.

---

## 11. Electricity fixtures

Use an Electric energy interface or equivalent artificial power fixture where electricity generation is not under test.

For example:

```text
Electric energy interface
        ↓
experimental electric network
```

If the question concerns steam generation, boiler ratios, generators, power distribution, accumulator behavior, or network sufficiency, artificial power must not bypass that part of the system.

The experiment result should record whether power was artificial or produced by the system under test.

---

## 12. Technology and recipe context

An experiment must record the technology context under which it ran.

Default behavior should be conservative:

> Begin from a snapshot equivalent to SGLuna's relevant live-world technology availability.

This helps answer:

> Does this idea work with what SGLuna currently knows and can build?

The Workshop may later support explicit counterfactual technology tests, such as temporarily enabling a technology to answer:

> Would this design work after technology X is researched?

Counterfactual technology must be clearly recorded in experiment provenance and must never unlock the live world.

Evidence produced under counterfactual technology must not be confused with evidence valid under current live-world prerequisites.

---

## 13. Experiment specification

The first version should use a structured experiment definition rather than arbitrary Lua.

Illustrative shape:

```json
{
  "purpose": "test whether this production cell sustains belt production",
  "environment": {
    "size": 64,
    "terrain": "controlled",
    "technology_mode": "live_snapshot"
  },
  "resources": [
    {
      "name": "coal",
      "center": { "x": 0, "y": 0 },
      "radius": 5,
      "amount": 100000
    }
  ],
  "fixtures": [
    {
      "id": "iron-source",
      "type": "item_source",
      "item": "iron-plate",
      "mode": "unlimited"
    },
    {
      "id": "belt-sink",
      "type": "item_sink",
      "item": "transport-belt"
    }
  ],
  "system_under_test": {
    "entities": [
      "...agent-proposed entities and configuration..."
    ]
  },
  "observation": {
    "ticks": 3600,
    "measure": [
      "production",
      "consumption",
      "entity_status",
      "inventory_delta"
    ]
  }
}
```

The exact schema should be designed after inspecting the existing construction, factory-area learning, entity geometry, logistics topology, and skill-verification types so that types can be reused where practical.

Do not expose arbitrary Lua through this interface.

---

## 14. Experiment lifecycle

A bounded experiment should have an explicit lifecycle:

```text
DRAFT
  ↓
VALIDATED
  ↓
PREPARING
  ↓
RUNNING
  ↓
OBSERVING
  ↓
COMPLETE
```

Infrastructure failure states should distinguish at least:

```text
invalid_spec
setup_failed
engine_execution_failed
observation_incomplete
budget_exhausted
```

A failed hypothesis is not an experiment-system failure.

For example:

```text
All entities were created successfully.
Experiment ran for 1800 ticks.
Target assembler produced zero items because no copper cable arrived.
```

is a successful experiment whose tested design did not produce the expected outcome.

That distinction is important for future skill refinement and negative evidence.

---

## 15. Bounded experimentation

The Workshop must not become an unlimited brute-force search engine.

Each experiment should have explicit limits such as:

```text
maximum area
maximum entity count
maximum resource entities
maximum fixtures
maximum simulated ticks
maximum simultaneous experiments
maximum experiments per goal
```

The agent should revise hypotheses deliberately rather than generate thousands of layouts.

Experiment results should be compact enough that repeated testing does not consume excessive provider context.

Large raw snapshots should remain harness-side; the provider should receive structured deltas and summaries unless deeper inspection is requested.

---

## 16. Skill-system integration

The Workshop should produce evidence usable by the existing learning system without automatically promoting a skill.

The current skill architecture already distinguishes candidates from verified skills and gives live verification authority over promotion. Workshop evidence should preserve that boundary.

Proposed learning flow:

```text
unknown problem
    ↓
experiment
    ↓
engine-backed semantic evidence
    ↓
successful pattern
    ↓
SkillCandidate
    ↓
independent reconstruction
    ↓
normal-world / constrained verification
    ↓
Verified Skill
```

Workshop success proves:

> The proposed relationship can work in Factorio under the stated experimental conditions.

It does not prove:

> SGLuna can construct and operate this solution under normal gameplay constraints.

Those should remain separate evidence classes.

Possible evidence classes include:

```text
semantic_experiment
normal_execution
live_production
long_duration_observation
```

A future skill should be able to retain multiple evidence records rather than collapsing all of them into one generic "verified" claim.

---

## 17. Experiment provenance

A successful Workshop experiment may become a Skill example or candidate source.

The source should record enough provenance to reproduce or audit the experiment:

```text
experiment id
experiment revision
surface/environment configuration
technology snapshot or counterfactual overrides
fixture definitions
system-under-test definition
resource definitions
observation duration
measured results
relevant engine evidence refs
```

The resulting Skill should retain reusable relationships and constraints rather than treating exact experiment coordinates as authority.

Exact layouts may remain examples or known-good seeds.

They should not automatically become mandatory gameplay scripts.

---

## 18. Example: burner coal experiment

User goal:

```text
Make our early coal production less dependent on manual refueling.
```

SGLuna has no applicable verified skill.

It may formulate:

```text
Hypothesis:
Two burner mining drills may be able to provide fuel to each other
if their output directions are arranged appropriately.
```

The Workshop creates:

```text
real coal resource patch
two real burner mining drills
small initial coal seed
no infinity coal feed into the drills after initialization
```

Why no sustained Infinity source?

Because self-sustaining fuel flow is exactly what is being tested.

The Workshop then observes:

```text
fuel inventories
coal extracted
coal transferred
drill operating state
duration of uninterrupted operation
```

If the design fails, SGLuna may revise orientation or arrangement and run another bounded experiment.

If it succeeds consistently, that evidence may produce a candidate skill.

This allows discovery without hard-coding the Coal Snake solution into the harness.

---

## 19. Example: assembler throughput experiment

Question:

```text
Can this belt/inserter arrangement sustain the requested production rate?
```

The Workshop may use:

```text
Infinity item sources
        ↓
Loaders
        ↓
controlled input belts
        ↓
SYSTEM UNDER TEST
        ↓
controlled output belts
        ↓
Loaders
        ↓
Infinity sinks
```

Here the upstream mining/smelting economy is irrelevant.

The belt, inserters, assemblers, and relationships being tested remain real entities and must operate normally.

This is the intended role of infinity fixtures: remove unrelated uncertainty without replacing the behavior being measured.

---

## 20. Relationship to blueprint-like representations

A blueprint or blueprint-like structure may be useful as an experiment input/output representation, but the Workshop itself should not be defined as a blueprint feature.

A blueprint describes a proposed arrangement.

It does not prove that the arrangement functions.

Conceptually:

```text
agent draft
    ↓
blueprint-like representation
    ↓
instantiate real entities in Workshop
    ↓
run real Factorio engine
    ↓
observe behavior
```

A later version may support importing/exporting experiment snapshots through native blueprint strings or blueprint books where that provides value.

V1 should not depend on full blueprint-book management.

---

## 21. V1 scope

V1 should focus on stationary production and logistics experiments.

Include:

```text
separate experiment surface
experiment isolation / dedicated force or equivalent
controlled terrain
real resource patches
Infinity item source/sink fixtures
loader boundary fixtures
Infinity fluid source/sink fixtures
artificial electric supply
entity placement/configuration
bounded engine execution
structured observation
experiment cleanup/reset
experiment provenance
```

Defer:

```text
combat simulation
trains
vehicles
space platforms
large-scale combinatorial layout search
automatic optimization
automatic skill promotion
cross-experiment evolutionary search
full blueprint-book management
```

The goal of V1 is not to solve factories.

The goal is:

> Give SGLuna a safe place to ask the Factorio engine questions.

---

## 22. Implementation questions to resolve before coding

The following should be discussed before implementation begins.

### Surface lifecycle

- one persistent reusable Workshop surface versus per-experiment surfaces;
- deterministic reset versus destroy/recreate;
- how to avoid chunk-generation overhead;
- whether several experiments may coexist.

### Force isolation

- dedicated persistent experiment force versus per-experiment force;
- which live technology/modifier state should be copied;
- how to prevent production statistics, research, and other force state from leaking into normal gameplay.

### Time

- whether V1 uses ordinary game ticks only;
- whether experiment execution can be accelerated safely without affecting the live surface;
- whether a server-wide tick-rate change is unacceptable because it would also affect live gameplay.

### Fixtures

- exact Infinity chest source/sink semantics;
- loader direction and throughput configuration;
- Infinity pipe semantics;
- artificial electric network setup;
- cleanup guarantees for fixture-owned entities.

### Observation

- which measurements can be captured directly from engine state;
- which require periodic sampling;
- how to measure material crossing a fixture boundary without distorting the tested layout;
- how to represent starvation, blockage, and stability compactly.

### Skill evidence

- how Workshop experiment IDs become skill evidence refs;
- whether `SkillSource.kind` should eventually gain an explicit experiment subtype beyond the existing `experiment` source;
- how negative semantic results should be stored for later refinement without polluting verified authority.

These questions should be resolved against the current runtime architecture rather than introducing a second parallel execution stack.
