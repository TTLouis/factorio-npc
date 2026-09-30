# SGLuna Factorio — Learning + Bootstrap E2E Handoff

This document captures the remaining end-to-end validation work discussed during the learning/skill design thread so that the conversation itself can be archived without losing the roadmap.

The active integration branch is `feat/npc-transition-work`. At the time this handoff was written, that branch already contained the learning/skill infrastructure, including factory-area learning, learning opportunities, skill export, and a `skill_verification` implementation. Code presence does **not** imply that the full real-game/provider E2E sequence below has passed.

## Why the next E2E focus is bootstrap, not more skill UI

The skill infrastructure is now ahead of SGLuna's proven early-game autonomy. A realistic learning benchmark is difficult to interpret while SGLuna still cannot reliably progress from an early-game state to the first automation technology and an actually automated science line.

The main gameplay validation order should therefore be:

```text
Skill verification infrastructure gate
        ↓
Fresh start → Automation researched
        ↓
Automated red-science production
        ↓
Autonomous technology progression
        ↓
Skill retrieval + reuse
        ↓
Cold-vs-warm benchmark
        ↓
Novel skill discovery (Coal Snake benchmark)
        ↓
Skill refinement / composition
```

Do not treat fixture-level skill verification as proof that SGLuna can autonomously play Factorio.

---

## Gate 0 — Skill rebuild + verification infrastructure

### Purpose

Prove that a `SkillCandidate` can be instantiated somewhere other than its source example, rebuilt through normal NPC execution, re-observed, and promoted only when real acceptance evidence passes.

### Reference scenario

Use a small production cell:

```text
iron plate input
    ↓
gear assembler
    ↓
transport-belt assembler
    ↓
transport-belt output
```

Area A is the learned source. Area B is a different, empty verification area.

### Must prove

- source absolute coordinates are not reused as skill authority;
- source-relative layout may be used as a known-good seed, while topology/constraints remain the reusable authority;
- Area B does not overlap Area A;
- construction uses the normal NPC construction/task path, not `create_entity`, teleport, or free-item injection;
- recipes and required relationships are configured correctly;
- live re-observation sees the rebuilt topology;
- target output actually increases during a bounded observation window;
- acceptance checks store engine-backed evidence;
- only complete required evidence can promote `candidate` → `verified_skill`;
- unmeasured sustained throughput remains `unvalidated`.

### Required negative case

Break the gear-transfer relationship after construction or instantiate an intentionally broken equivalent.

Expected result:

```text
entities may exist
+ recipes may be configured
+ structural checks may partly pass
BUT target output does not appear
→ semantic verification failure
→ skill remains candidate
```

This prevents "entities were placed" from becoming equivalent to "skill was learned."

### Failure classification

Keep these distinct:

- `blocked`: missing item/technology, no safe destination, provenance unavailable, no valid placement;
- `execution failure`: navigation/construction/runtime failure;
- `semantic failure`: requested structure exists but the learned relationship does not produce the required result.

Semantic failures should remain useful as future refinement counterexamples.

---

## Gate 1 — Fresh Start to Automation

### Purpose

This is the first major gameplay E2E milestone. SGLuna should be able to make early-game progress without a prebuilt factory and research `Automation` by itself.

### Suggested user goal

```text
Develop from this early-game state until Automation is researched.
Do not ask me to manually perform routine mining, smelting, crafting, fueling,
placement, or lab-feeding steps unless the game state genuinely blocks you.
```

Do not provide the detailed solution sequence to the model during the actual benchmark.

### Expected capability chain

SGLuna must autonomously handle the necessary subset of:

```text
resource discovery
→ coal / iron / copper acquisition
→ burner-miner or manual bootstrap where appropriate
→ miner orientation
→ fuel handling
→ furnace placement + fueling
→ smelting
→ crafting prerequisites
→ lab construction
→ automation science pack production
→ lab placement / feeding
→ research selection
→ research progress
→ Automation unlocked
```

### Pass criteria

- `Automation` is actually researched in engine state;
- no human manually performs the core bootstrap actions;
- plan/task state does not silently reset between phases;
- ordinary routine completions do not require unnecessary repeated provider turns;
- failures produce structured blocker/error evidence rather than vague retries;
- no privileged item/entity spawning is used.

### What to capture

Record at minimum:

- provider calls and token usage;
- replans;
- failed operations and their reasons;
- construction/placement retries;
- navigation/fueling failures;
- research selection/progress events;
- total elapsed game/wall time where practical.

Any failure discovered here should become a reproducible regression when possible.

---

## Gate 2 — Automated red science

### Purpose

After `Automation` is available, prove SGLuna can create its first genuinely automated production loop instead of merely hand-crafting science packs.

### Suggested user goal

```text
Build a small automated automation-science production line and keep a lab supplied.
```

### Must prove

- assembling machines are built/configured through normal gameplay;
- iron/copper smelting and required intermediates are supplied;
- gear production is automated where required;
- automation science packs are produced by machines, not only hand-crafted;
- transport/inserter orientation and machine I/O are physically correct;
- the lab receives science packs without repeated user intervention;
- science production continues for a bounded observation period.

A one-time batch manually transferred into a lab is not sufficient.

This gate is the first meaningful real-world producer for the learning system: a successful line should naturally become a learning opportunity/candidate without the user saying "learn this."

---

## Gate 3 — Autonomous technology progression

### Purpose

Move from "execute a named recipe" to "reason about the technology path required for a higher-level capability."

### Example goal

```text
Develop until you can automatically produce logistics science packs.
```

### Must prove

SGLuna can:

- inspect current technologies and prerequisites;
- identify missing research;
- derive required production expansion;
- schedule research and construction in a persistent multi-stage goal;
- verify each unlocked capability before advancing;
- recover from missing materials/space/power without resetting the whole goal.

The model should not require the user to enumerate every prerequisite technology.

---

## Gate 4 — Skill retrieval + reuse

Do this only after Gates 1–2 are reasonably stable; otherwise failures are too difficult to attribute.

### Purpose

Prove learned knowledge changes future behavior.

When a new goal arrives, the planner should check applicable **verified** skills before redesigning the solution from scratch.

Conceptual flow:

```text
new goal
→ deterministic/structured skill lookup
→ applicability + precondition check
→ instantiate against current spatial state
→ execute
```

V1 does not require a vector database. Prefer a deterministic index over fields such as:

- kind;
- inputs/outputs;
- recipes;
- technologies;
- topology/pattern tags;
- verification state.

Do not retrieve an unverified candidate as if it were an authoritative executable skill.

---

## Gate 5 — Cold vs warm benchmark

### Purpose

Measure whether learning actually reduces cost and increases reliability.

### Cold run

```text
no applicable verified skill
→ normal reasoning/planning
→ build
→ learn
→ verify
```

### Warm run

```text
verified skill already exists
→ retrieve
→ instantiate
→ build
```

Compare:

- success rate;
- provider calls;
- input/output tokens;
- replans;
- failed operations;
- placement/construction retries;
- elapsed time;
- wasted material where measurable.

If the warm run is not clearly cheaper, faster, or more reliable, the skill system is not yet providing its intended value even if the storage/export UI works.

---

## Gate 6 — Novel skill discovery benchmark: Coal Snake

Run this only after the early-game and reuse gates are stable.

### Goal

Use a prompt that states the gameplay objective without revealing the topology, for example:

```text
There is no electricity yet. Establish coal mining that does not need frequent
manual refueling.
```

Do **not** hard-code or prompt-inject the Coal Snake solution.

### Expected discovery loop

```text
no known verified skill
→ bounded hypothesis / experiment
→ engine observation
→ failure or success
→ refine if needed
→ successful novel solution
→ LearningOpportunity
→ SkillCandidate
→ rebuild elsewhere
→ verify
→ Verified Skill
```

### Success criteria

- SGLuna independently discovers a self-sustaining burner-miner relationship;
- the arrangement remains operational for a bounded period;
- success is determined by engine evidence, not model narration;
- the learned skill can be reconstructed on a different coal patch;
- the initial skill library did not already contain the solution.

Do not use Coal Snake failures to debug basic miner placement, orientation, fueling, or task-continuation bugs; those should already be covered by earlier gates.

---

## Gate 7 — Refinement and composition (later)

These are follow-on learning milestones, not prerequisites for the early-game bootstrap E2E.

### Refinement

A verified skill that later encounters a semantic counterexample should produce a new revision proposal rather than silently mutating old verified knowledge:

```text
verified v1
→ counterexample
→ proposed v2
→ independent verification
→ verified v2
```

### Composition

Over time, reusable knowledge should be able to represent smaller patterns as well as whole production blocks, for example:

- direct insertion;
- belt-side machine cell;
- shared input belt;
- output buffering;
- smelting block;
- production block boundaries.

The long-term planner should compose these instead of accumulating one monolithic blueprint-like skill for every possible factory.

---

## Validation-layer rule

Use the cheapest layer that proves the failure mode, but do not stop too low:

```text
unit / type / contract
→ compiled artifact checks
→ real Factorio deterministic harness
→ packaged Pterodactyl smoke where deployment matters
→ real provider E2E for autonomous planning/learning claims
```

Fixture tests can prove `SkillVerification` logic. They cannot prove that SGLuna autonomously progresses through the game.

## E2E evidence policy

For each gate, keep enough evidence to answer:

- what exact goal was given;
- what world/save state was used;
- which branch SHA was tested;
- which model/provider configuration was used;
- what actions/receipts occurred;
- where the first meaningful failure happened;
- whether the failure was engine/runtime/planning/provider-related;
- whether the result is reproducible.

Do not store hidden chain-of-thought. Operational plans, structured tool calls/results, receipts, game observations, and provider usage metadata are sufficient.

## Scope boundary

This handoff intentionally does **not** make the following immediate E2E blockers:

- skill import/trust;
- vector retrieval;
- swarm skill sharing;
- large-scale factory optimization;
- vehicles/trains/space platforms;
- globally optimal layouts;
- unvalidated sustained inserter throughput claims.

Those should remain separate follow-up work.

## Conversation handoff / archive note

The learning/skill design conversation that produced this roadmap can be considered **EOL for planning purposes** once this document is present on the active integration branch.

Future work should start by reading:

- `docs/NPC_AGENT_HARNESS_PLAN.md`
- `docs/NPC_AGENT_HARNESS_STATUS.md`
- this file: `docs/NPC_LEARNING_BOOTSTRAP_E2E.md`

Then inspect the actual latest `feat/npc-transition-work` HEAD before changing code. Do not rely on historical SHAs in chat transcripts as the current branch state.
