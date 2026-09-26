# AIRI Factorio — Planning Architecture Roadmap

Status: **canonical planning direction**
Branch of origin: `experiment/jev-agent-architecture`
Adopted: 2026-09-19

This document is the authority for Goal / Roadmap Shelf / immutable-plan lifecycle. Jev's current authority model is defined by `NPC_JEV_COPROCESSOR_ARCHITECTURE.md`; where older Jev planning-review text in this file conflicts with that document, the coprocessor architecture wins.

The redesign is intentionally simpler than the earlier experimental hierarchy/checkpoint stack:

> The user owns the goal. The Main LLM authors semantic plans and intent. The deterministic runtime validates structured operations and owns world truth. Jev is a cognitive coprocessor for observation selection, state compression, routing, recovery, reasoning effort, and advisory steering; Jev is not a correctness gate for the Main LLM. A committed plan is immutable. Future intent lives on a non-executable shelf and is progressively refined like level of detail (LOD).

## 1. Core invariants

### 1.1 A committed plan is immutable

Once a plan enters `COMMITTED` / `EXECUTING`, its semantic steps, ordering, and completion meaning do not change in place.

Normal execution, local recovery, new observations, planner preference, Jev output, or a later model turn must not rewrite the active plan.

If execution reaches a **real structural blocker**, the current plan becomes `BLOCKED`; it still does not mutate. AIRI must surface the blocker to the user and ask what to do.

If the user approves a change, create a **new plan version**:

```text
Plan v3 -- BLOCKED / SUPERSEDED
        |
        +--> user approves revision
                 |
                 v
              Plan v4
```

Completed, still-valid work may be carried forward as verified evidence, but the old plan remains preserved as history.

### 1.2 Goal, shelf, and active plan are different objects

Do not overload one Plan Tracker object with long-horizon intent, tentative milestones, executable steps, and progress.

The durable planning model has three semantic layers:

1. **Goal** — the user's durable intent and explicit constraints.
2. **Roadmap Shelf** — coarse future guidance. Tentative, progressively refinable, and never executable.
3. **Active Plan** — the current bounded executable slice. Immutable after commit.

The shelf is not abandoned work. It is the guide for subsequent planning rounds.

### 1.2.1 Goal definition: the harness owns goal completion

In project-management terms the three layers are rolling-wave planning: the goal is decomposed into work packages (committed plan slices), near-term work is detailed while later work stays coarse on the shelf, and each slice is progressively elaborated from verified results.

The rolling wave needs a fixed end condition. On the first plan of every goal, the Main LLM interprets the user's words into a **goal definition** (`submitPlan.goal`):

- `scope`: `finite` (one plan of at most 30 steps completes it) or `long_horizon` (several slices; the first plan must also send the Roadmap Shelf);
- `summary`: one sentence restating the goal as understood;
- `doneWhen`: game-checkable conditions — `research_completed`, `rockets_launched`, `items_produced` (force-wide, summed across every surface), `inventory_count`, `space_location_unlocked`.

The harness validates the definition (one corrective retry, then it stops and asks the player), stores it on the reducer goal (`GOAL_DEFINED`; the planner defines once, only the user may redefine), and prints it in game as the system's understanding of the goal.

Completion then belongs to the harness: at the end of every plan slice it reads each `doneWhen` condition from the game through `autorio_tools.evaluate_condition`. All met → `GOAL_SATISFIED` with runtime evidence. Any unmet → the next slice, with the unmet conditions named to the planner. Finishing a plan's steps never completes a defined goal by itself, and a goal with unmet conditions is not retired when a plan completes. A condition the game cannot recognise (unknown technology/item/location) pauses the goal and asks the player rather than rolling slices forever.

The conditions are force-level facts on purpose, so the same contract carries to Space Age (other planets, space platforms) without base-game assumptions. They are read from the NPC's force even while its body is dead, so a goal met during a respawn gap is not missed.

`rockets_launched` and `items_produced` are cumulative counters, so they count from when the goal starts (`countFrom: "goal_start"`, the default): "launch a rocket" on a save that already launched one needs a new launch.
- The harness reads where each counter stood when the goal was defined and records it through the runtime-only `GOAL_BASELINES_RECORDED` event.
- The event fills a missing baseline and never moves a recorded one, and a baseline sent by the planner is dropped.
- If that first read fails, the next evaluation records it, and the condition stays unmet until then.
- `countFrom: "save_start"` is for a player who explicitly means the save's lifetime total.

#### Production goals are rate goals (owner decision, 2026-09-25; not implemented yet)

`items_produced` counts items no matter how they were made. In burner canary
attempts 4 and 5, plates the NPC smelted by hand-feeding a furnace satisfied "build a
drill that feeds a furnace and produce 10 plates". Counting entities doesn't fix
this: it checks the means rather than the result, and a planner can score it
without the factory working.

- A request to build production ends in `production_rate {item_name, per_minute}`.
  The harness measures it itself at goal-check time: the force's production
  statistics over a window of at least one minute, read from the game.
- `items_produced` stays for requests that ask for a quantity, not a working
  production setup.
- The rate counts only automated output. If, during the window, the NPC inserts
  anything other than fuel into a machine or container in the measured chain, or
  crafts the measured item itself, the window is void and the condition stays
  unmet. Inserting fuel by hand (for example coal into an early burner drill and
  stone furnace) is allowed.
- Link facts such as a drill's or inserter's `feeds: {unit_number, name}` are added
  to observations as world information for the planner. They are never goal
  conditions.

The player can ask `status` at any time and gets a deterministic answer (conditions read from the game, current slice, roadmap progress) without a model call. After each verified slice with the goal still open, one progress line is printed in game.

Production runs with `goalDefinitionPolicy: 'required'`; direct constructions of the loop default to `optional` and accept a definition when present.

### 1.2.2 Jev's blind second reading of a new goal

Jev does not review the goal definition. It independently reads the same evidence, and the harness compares the two readings in code (`goal-reading.mjs`).

**Jev's input rule:** give Jev the evidence a referee needs, never the work being refereed.

- **Jev sees:** the player's words, and deterministic save-progress facts from `autorio_tools.goal_progress_facts`:
  - rockets launched;
  - researched / enabled technology counts;
  - which milestone technologies are done;
  - whether Space Age is active.
- **Jev never sees:** the planner's `goal`, roadmap, plan, system prompt, or tool catalog.
- **Where the questions go:** they ride in the existing `interaction_planner_shape` request for a `new_goal`, so Jev gets no extra request. They are:
  - `goal_scope`: `finite | long_horizon | unclear`;
  - `goal_family`: `rocket_launch | research | produce_items | space_travel | build | gather | other`;
  - `goal_measurable` (noul).

**Harness rule**, applied once per goal after the definition passes validation:

| Reading | Result |
|---|---|
| Agreement, `unclear`, or confidence below 0.6 | Accept the planner's definition. |
| Confident scope disagreement | One corrective retry, citing the save facts. |
| Confident `rocket_launch / research / produce_items / space_travel` family with no matching `doneWhen` kind | One corrective retry. |
| Planner's answer after that retry | Final. Jev never blocks, and a long-horizon revision still needs its shelf. |
| Jev error, budget, or an older mod without the facts call | Fail open to the planner. |

Continuing slices of a defined goal are never re-read. The comparison is traced on `goal.defined` (`jev_goal_reading`). When the retry was used, the in-game goal message gains one "Double-checked" line.

This stays within §1.3: Jev critiques scope before commit, and it can neither reject a plan nor block execution.

### 1.3 Jev is a cognitive coprocessor, not a correctness reviewer

Jev is outside the authoritative correctness path.

Jev may help decide:

- which deterministic observations are worth gathering before a Main-LLM wake;
- whether healthy deterministic runtime work can continue without waking the Main LLM;
- whether a runtime result is material enough to wake the Main LLM;
- which bounded recovery route to try next;
- how much Main-LLM reasoning effort and planning horizon are justified;
- advisory strategic steering such as `vertical | horizontal | maintain | recover`;
- bounded semantic compression of authoritative runtime facts.

Jev must not approve or reject a Main-LLM plan, decide whether an operation belongs to a semantic step, synthesize required completion truth, vote on deterministic completion, or block execution because it dislikes plan scope.

The harness must remain correct when Jev is unavailable. Jev failure may reduce efficiency; it must not make a structurally valid plan uncommittable or an otherwise valid operation inadmissible.

For the complete current Jev contract, see `NPC_JEV_COPROCESSOR_ARCHITECTURE.md`.

### 1.4 Runtime owns truth, admission, and completion evidence

The runtime remains authoritative for:

- live Factorio world state;
- structured operation admission;
- actor/session/epoch identity;
- operation receipts;
- deterministic predicates;
- supported completion checks;
- physical execution and cancellation;
- whether verified evidence satisfies a committed step contract.

The planner and Jev must not manufacture world facts.

## 2. LOD planning model

The Roadmap Shelf should behave like a level-of-detail system. We retain the same long-horizon direction while only resolving the part close enough to execute.

```text
LOD 0  USER GOAL / CONSTRAINTS
       "Build toward a rocket-capable factory."
          |
          v
LOD 1  ROADMAP SHELF
       coarse, tentative guidance
       [early smelting]
       [automation + red/green science]
       [oil + blue science]
       [late-game production]
       [rocket]
          |
          | resolve only the nearest useful node
          v
LOD 2  DRAFT PLAN SLICE
       Main LLM proposes a bounded checkpoint-sized plan
          |
          v
       DETERMINISTIC VALIDATION
       schema / supported contracts / identity
          |
          v
LOD 3  COMMITTED ACTIVE PLAN
       exact semantic steps + completion contracts
          |
          v
LOD 4  EXECUTION DETAIL
       bounded operations / local recovery under each
       committed step, without mutating the plan
```

The important property is **progressive refinement with lineage**.

A coarse shelf node is not discarded when we zoom in. The active plan records which shelf node(s) it resolves. When that plan completes, verified results are attached back to the shelf lineage before the next planning round.

Representative linkage:

```text
goal_id
  |
  +-- roadmap_revision
       |
       +-- node early_smelting
       |      |
       |      +-- resolved_by plan_v1
       |      +-- verified_result ...
       |
       +-- node automation_science
              |
              +-- next planning target
```

This gives later rounds continuity without giving the coarse roadmap execution authority.

## 3. Roadmap Shelf semantics

The shelf is a **guide**, not a queue of commands.

Shelf nodes may contain:

- intent / desired outcome;
- why the node matters to the larger goal;
- known dependencies;
- useful sequencing relationships;
- uncertainty or assumptions;
- status such as `tentative | ready_to_refine | partially_realized | realized | invalidated`;
  - **Amended 2026-09-20.** `tentative <-> ready_to_refine` moves in BOTH directions. A node is
    promoted when its declared dependencies are satisfied and demoted when they stop being
    satisfied, so it cannot sit refinable forever on a premise the world has since contradicted.
    Both directions are computed from the same readiness reading; demotion is never a claim.
    The upper rungs stay monotonic: `partially_realized` and `realized` rest on verified plan
    results, and a node whose guidance is genuinely void is `invalidated` instead.
  - Nodes parked by the refinement fan-out cap are held at `tentative` and marked
    `deferred_by_fanout` — remembered, but not refinable until a sibling frees a slot.
- lineage to previous roadmap revisions;
- links to active/completed plan versions that refined the node.

Shelf nodes should remain coarse enough that they do not pretend to know future world state.

Example:

```json
{
  "id": "roadmap_early_smelting",
  "intent": "establish reliable early iron and copper smelting",
  "status": "ready_to_refine",
  "depends_on": [],
  "resolved_by": [],
  "assumptions": []
}
```

A shelf revision is allowed when verified world state or explicit user direction invalidates long-horizon guidance. That is different from mutating an active plan.

Shelf revisions should preserve lineage and record the reason for the change instead of replacing history silently.


## 4. Strategic steering between plan slices

Games such as Factorio are not well served by a single monotonically "forward" planning style. Effective development often has a **tick-tock cadence**:

```text
VERTICAL
unlock / reach the next useful capability
      |
      v
HORIZONTAL
make the new capability sustainable, scalable, and resilient
      |
      v
VERTICAL
use that foundation to reach the next capability frontier
      |
      v
HORIZONTAL
broaden again
      |
     ...
```

This is **strategic steering**, not plan mutation.

Steering is evaluated at planning boundaries and influences which Roadmap Shelf node should be refined next and what planning style the Main LLM should use for the next draft.

It does not alter an already committed Active Plan.

### 4.1 Steering modes

Use the existing useful semantic distinction, with narrower authority:

```text
development_mode =
  vertical
  horizontal
  maintain
  recover
```

**Vertical** means pushing the current critical path forward toward a new capability, unlock, production tier, or other goal-relevant frontier.

Examples may include:

- enabling a required technology;
- establishing the first usable instance of a new production chain;
- reaching the next science tier;
- unlocking a capability required by the user's long-horizon goal.

**Horizontal** means strengthening an already-reached frontier so later vertical progress is sustainable.

Examples may include:

- increasing mining/smelting capacity;
- improving power margin;
- expanding logistics throughput;
- adding buffers or redundancy;
- making an early production chain reliable enough to support the next tier;
- broadening defensive or supply support when it protects the current development frontier.

**Maintain** means the current direction remains valid and no strategic change is justified yet. This may include waiting for an already-started deterministic process or continuing bounded work that does not need another strategic plan.

**Recover** means restoring a previously established capability or resolving material degradation before normal development can continue.

### 4.2 Vertical/horizontal are relative to the critical path

Do not classify development mode from the surface action.

For example:

- building more miners can be **vertical** if insufficient ore is the direct blocker to the next required capability;
- researching a technology can be **horizontal** if it is optional support rather than part of the active critical path;
- adding power can be **vertical** when power is the current gating dependency, or **horizontal** when it is adding margin for future growth.

The classification is therefore relative to:

```text
user goal
+ current roadmap frontier
+ current critical path
+ verified world state
+ known constraints
```

The runtime supplies grounded facts. Jev and the Main LLM interpret those facts semantically.

### 4.3 Steering happens only at safe semantic boundaries

Normal steering points are:

- initial goal admission;
- completion of an immutable Active Plan;
- explicit user-approved revision after a structural blocker;
- explicit user change of goal/priority.

Do **not** switch vertical/horizontal mode halfway through a healthy committed plan.

If new evidence merely changes low-level execution details, use local recovery.

If new evidence destroys a committed semantic assumption, freeze the plan as `BLOCKED`; do not use "steering" as a loophole for silent replanning.

### 4.4 Tick-tock is a bias, not a hard alternation rule

The system should remember development cadence, but must not enforce:

```text
vertical -> horizontal -> vertical -> horizontal
```

as a blind state machine.

Sometimes two vertical slices in succession are correct because the existing foundation is already sufficient. Sometimes several horizontal slices are required before further vertical progress is viable.

Use **steering hysteresis** so the system does not oscillate modes merely because the previous plan used the other mode.

A durable advisory steering record may contain:

```json
{
  "current_mode": "horizontal",
  "previous_mode": "vertical",
  "reason": "new oil capability exists but throughput and power margin are insufficient for blue science",
  "critical_path": "stable petroleum and sulfur production",
  "pressure": {
    "vertical": ["blue science remains unreached"],
    "horizontal": ["power margin low", "petroleum throughput unstable"]
  },
  "last_plan_id": "plan_12"
}
```

This record is planning context, not execution authority.

### 4.5 One dominant steering mode per plan slice

Because vertical and horizontal development use different planning approaches, each committed Active Plan should normally have **one dominant development mode**.

Small supporting work from the opposite mode is allowed when it is necessary to make the slice executable, but a draft that substantially mixes both directions should be treated as a scope smell.

Examples:

```text
VERTICAL slice:
"Reach a usable oil-processing capability."

May include:
- the minimum extra power required for the oil setup.

Should normally not also include:
- broad redesign of the entire electrical grid,
- large defensive expansion,
- unrelated smelting scale-up.
```

```text
HORIZONTAL slice:
"Raise iron production and logistics to reliably support the next science tier."

May include:
- an enabling belt/inserter technology if it is necessary for that scaling target.

Should normally not also include:
- pushing through multiple new science tiers.
```

Jev's pre-commit scope review should detect substantial mixed-direction drafts and ask the Main LLM to choose a cleaner boundary.

**Amended 2026-09-20.** This originally read "unless the mixture is genuinely inseparable", implemented as a yes/no question to Jev. That made an unverifiable model claim able to suppress the very finding this section exists to produce, so it is gone. Jev reports the smell and never waives it; the Main LLM — the author, and the only party that can actually move the boundary — decides whether the mixed slice stands. Genuinely small supporting work is still allowed, but by the measured tolerance in `mixedDirectionThresholds()`, not by assertion.

### 4.6 Steering changes how the Main LLM should plan

A **vertical** planning prompt should bias toward:

- the shortest grounded route to the next useful capability frontier;
- minimum sufficient supporting infrastructure;
- explicit dependencies on the active critical path;
- stopping once the new capability is demonstrably usable;
- avoiding speculative broad expansion.

A **horizontal** planning prompt should bias toward:

- capacity, throughput, resilience, logistics, and support;
- measurable sufficiency for the next expected vertical push;
- improving weak links in the already-reached frontier;
- avoiding unnecessary new capability horizons;
- ending when the foundation is demonstrably adequate rather than "maximized."

A **recover** prompt should bias toward restoring the last known valid frontier with minimum semantic change.

A **maintain** decision should avoid waking the Main LLM when deterministic progress can continue safely without a new semantic plan.

### 4.7 Jev's steering role

Jev may provide a bounded **steering recommendation** at a plan boundary:

```json
{
  "recommended_mode": "horizontal",
  "confidence": "high",
  "reason_codes": [
    "frontier_reached",
    "capacity_below_next_frontier_need",
    "power_margin_low"
  ],
  "critical_path_summary": "stabilize oil throughput before blue science",
  "candidate_shelf_nodes": [
    "roadmap_oil_stabilization",
    "roadmap_power_margin"
  ]
}
```

This is advisory.

Jev does not:

- author the next plan;
- mutate the Roadmap Shelf directly;
- pick arbitrary Factorio operations;
- change a committed plan;
- force a mode transition against explicit user priorities.

The Main LLM receives the user goal, shelf, verified world state, steering history, and Jev recommendation, then chooses the actual next shelf refinement and writes the draft.

### 4.8 Shelf nodes carry steering intent without becoming executable

Roadmap nodes may optionally record coarse development intent:

```json
{
  "id": "roadmap_scale_iron",
  "intent": "increase iron throughput enough to sustain the next science push",
  "development_hint": "horizontal",
  "status": "ready_to_refine",
  "depends_on": ["roadmap_automation_frontier"]
}
```

This hint may change in a later roadmap revision because the same work can become part of a different critical path.

The hint is not an operation and is not binding on the executor.

### 4.9 Planning-boundary flow with steering

The full boundary now becomes:

```text
completed immutable plan
        |
        v
verified world results
        |
        +--------------------+
        |                    |
        v                    v
LOD Roadmap Shelf      steering history
        |                    |
        +----------+---------+
                   |
                   v
          JEV STEERING REVIEW
        vertical / horizontal /
          maintain / recover
                   |
                   v
             MAIN LLM
      choose next shelf refinement
        + draft bounded plan
                   |
                   v
          RUNTIME VALIDATION
                   |
                   v
        COMMITTED IMMUTABLE PLAN
```

Steering is advisory context only:

- **Steering:** what kind of development might best support the next slice?
- **Commit:** deterministic structure/runtime validation decides whether the authored
  slice can enter the immutable plan lifecycle.

This prevents "vertical/horizontal" from becoming hidden planning authority.


## 5. Draft -> deterministic validation -> commit lifecycle

Planning has an explicit pre-commit boundary, but no second-AI correctness review:

```text
DRAFT
  |
  v
DETERMINISTIC VALIDATION
  |
  +--> malformed / unsupported / stale -> Main LLM repair or observe
  |
  +--> valid
          |
          v
      COMMITTED
          |
          v
      EXECUTING
       /      \
      /        \
COMPLETED     BLOCKED
                 |
                 v
               USER
                 |
        +--------+---------+
        |                  |
    keep paused       approve change
                           |
                           v
                      PLAN vN+1
```

The plan remains freely editable only before `COMMITTED`.

Plan quality, decomposition, and semantic scope are Main-LLM responsibilities. The
runtime may reject concrete contract violations, but it does not ask Jev whether a draft
is "actionable", "too broad", or at the right semantic boundary.

### 5.1 No fixed maximum step count

Do not define actionability as a hard rule such as `steps <= 5`.

Six small concrete steps may be better than two enormous vague ones.

The Main LLM should keep the active slice bounded enough that later world changes do not
invalidate most of it. Jev may recommend planning horizon or strategic steering before
the draft, but it does not grade the resulting plan afterward.

### 5.2 Deferred long-horizon work stays on the shelf

When a draft would reach too far ahead, the Main LLM should keep only the current useful
slice executable and leave the deferred tail represented by Roadmap Shelf nodes.

This is authoring discipline, not a Jev rejection loop.

## 6. Step contracts are fixed before commit

A committed semantic step should already know what successful completion means.

Example:

```json
{
  "step_id": "plan_7_step_2",
  "description": "Acquire enough stone for two furnaces",
  "completion": {
    "kind": "inventory_at_least",
    "item": "stone",
    "count": 10
  }
}
```

or:

```json
{
  "step_id": "plan_7_step_4",
  "description": "Establish the first iron smelting furnace",
  "completion": {
    "kind": "entity_configured_and_operational",
    "entity": "stone-furnace",
    "input": "iron-ore"
  }
}
```

The intended pre-commit flow is:

```text
Main LLM proposes semantic step
        |
        v
runtime validates any deterministic completion contract
        |
        v
commit
```

Do not wait until post-operation execution to renegotiate what a deterministic completion
contract meant.

A semantic/prose step may intentionally have no deterministic predicate; in that case the
Main LLM retains semantic completion authority. Jev is not inserted as a substitute judge.

## 7. Execution and recovery do not rewrite the plan

Under a committed step, the executor may perform bounded operations and local recovery.

Examples that should normally remain local:

- path detour;
- stale local position observation;
- a tree blocking a route;
- retrying a valid placement at another allowed coordinate;
- reacquiring a transient entity reference;
- waiting for an already-started deterministic process;
- obtaining another observation needed to execute the same committed semantic step.

These are implementation details beneath the plan's semantic level.

A **structural plan blocker** is different. Examples include:

- a required technology or capability is unavailable contrary to the plan's assumption;
- the required resource cannot be found within the allowed scope;
- a user constraint makes the committed route impossible;
- a planned dependency is not producible in the current game/mod state;
- the requested semantic outcome is incompatible with verified world conditions.

On a structural blocker:

1. record deterministic evidence;
2. mark the immutable plan `BLOCKED`;
3. stop automatic semantic replanning;
4. explain the blocker to the user;
5. ask whether to keep it paused, revise, or cancel;
6. if revision is approved, create a new version with lineage to the blocked plan.

## 8. Plan Tracker becomes a view of one immutable plan

The Plan Tracker should stop acting as a mutable planning workspace.

It should render the committed plan and authoritative progress:

- plan version / plan id;
- source roadmap node;
- immutable ordered semantic steps;
- active step;
- verified completed prefix;
- blocker if present;
- completion evidence references;
- superseded-by / derived-from relationships.

Planner-proposed future focus must not advance the active step.

Jev output must not advance the active step.

Only accepted evidence satisfying the committed current step contract may advance the Plan Tracker.

## 9. One transition authority

The current experiment accumulated multiple semantic writers: planner reconciliation, Jev completion logic, hierarchy transitions, outcome authority, and milestone reset paths.

Replace that with one state-transition authority.

Conceptually:

```text
applyPlanningEvent(state, event) -> newState
```

Events may include:

- `GOAL_ACCEPTED`
- `ROADMAP_REVISED`
- `DRAFT_CREATED`
- - `PLAN_COMMITTED`
- `STEP_EVIDENCE_ACCEPTED`
- `STEP_COMPLETED`
- `PLAN_COMPLETED`
- `STRUCTURAL_BLOCKER_CONFIRMED`
- `USER_REVISION_APPROVED`
- `PLAN_SUPERSEDED`
- `PLAN_CANCELLED`

Planner, Jev, runtime receipts, and UI should emit facts/events into this boundary rather than mutating Plan Tracker fields independently.

## 10. Identity and lineage

Do not rely on reusable positional IDs such as only `goal_id + step_1`.

At minimum carry:

```text
goal_id
roadmap_revision_id
roadmap_node_id
plan_id
plan_version
step_id
execution_epoch / batch_id where relevant
```

Receipts and completion evidence must correlate to the active committed plan identity, not merely to a step number that may recur in later plan slices.

## 11. Jev coprocessor contract

Jev is a TypeSafe/System One coprocessor, not a plan reviewer.

Use Jev for bounded typed judgments such as:

- interaction/intent classification;
- observation relevance;
- operation-family routing;
- closed-set argument selection;
- selection among runtime-generated candidates;
- recovery-route choice;
- Main-LLM wake/continue routing;
- reasoning effort and planning horizon;
- advisory `vertical | horizontal | maintain | recover` steering;
- typed state features that code can render into bounded planner context.

Jev returns Choice / Score / Noul answers and probabilities. It does not generate free-form
plan steps, prose summaries, arbitrary JSON operations, exact numeric arguments, or user-facing
questions.

For the complete provider-grounded contract, see:

- `NPC_JEV_COPROCESSOR_ARCHITECTURE.md`
- `validation/JEV_TYPESAFE_RESEARCH_AND_AUDIT_2026-09-21.md`

## 12. User interaction rules

Ask the user when the semantic contract truly needs user authority, especially:

- a committed plan hits a structural blocker requiring a different route;
- the user's constraints conflict;
- there are materially different goal interpretations and choosing one would change the requested outcome;
- the user explicitly asks to alter/cancel the plan.

Do not interrupt the user for ordinary runtime recovery that stays within the committed semantics.

When blocked, present the verified reason and bounded choices without silently selecting a new strategy.

## 13. Updated implementation roadmap

The older scope-review roadmap is retired. The current roadmap is organized around
deterministic planning authority plus TypeSafe-native semantic offload.

### Phase 0 — provider reality and document reconciliation

Status: **in progress / mostly complete**

- keep the TypeSafe research/audit current;
- remove stale scope-review references from canonical docs and tests;
- mark experimental typed-projection code as non-authoritative until validated;
- keep the harness correct with Jev disabled.

Exit condition: docs, code comments, and tests agree on Jev's actual capabilities.

### Phase 1 — TypeSafe adapter fidelity

Update the local decision-provider adapter to match the live public API:

- structured instructions;
- structured Choice criteria;
- correct Choice / Score / Noul validation;
- current provider/model limits;
- bounded request sizes;
- representative provider-response tests.

Exit condition: the wrapper is not a lossy or invented subset of TypeSafe.

### Phase 2 — authoritative operation/type registry

For every Autorio operation, centralize:

- name;
- semantic scopes;
- argument keys and argument kinds;
- risk class;
- preflight support;
- candidate source where applicable.

Argument kinds should distinguish:

- closed enum / boolean;
- deterministic numeric/default;
- runtime candidate;
- exact entity identity;
- planner-owned open semantic value.

Add invariants that every approved operation has compatible metadata.

### Phase 3 — Main-LLM intent boundary

Keep `submitPlan` for durable plan state, but separate:

- semantic operation intent;
- fully formed deterministic operation objects.

Do not require the Main LLM to reconstruct low-level formatting when enough intent and
runtime candidates already exist for the harness/Jev to project safely.

### Phase 4 — TypeSafe-native operation projection

Use the official function-calling / candidate-selection pattern:

1. harness determines active scope;
2. code enumerates valid operations and candidates;
3. Jev chooses the function/operation;
4. parallel Choice/Noul questions fill closed-set arguments;
5. code ignores unused branch answers;
6. deterministic code or Main LLM supplies open numeric/free values;
7. code assembles the operation;
8. normal parser + preflight remain mandatory.

If a complete operation is already represented as a finite runtime candidate, prefer one
Choice over candidate IDs plus `need_observation / wake_planner / ask_user`.

### Phase 5 — typed observation selection

Status: **implemented in M7 (2026-09-21)**

Integer-only observation-budget questions are no longer emitted to Jev. The live
decision envelopes ask parallel Noul relevance questions for eleven deterministic
observation families: runtime status, inventory/equipment, recipe/production,
prototype/skill knowledge, player state, nearby world, exact entity status/geometry,
logistics/transport, research state, placement candidates, and construction state.

Deterministic code applies a `0.5` relevance threshold and a four-family cap. Fresh
read-only tool calls must belong to a selected family and still fit the existing
deterministic observation-call cap. Cached observations remain reusable regardless of
the current relevance selection.

A first turn for a completely new goal keeps the existing minimum bootstrap read
allowance and fails open when Jev selects no family, so an under-informed relevance
classification cannot starve the Main LLM of all world grounding.

The old integer `observation_budget` response remains parse-only compatibility for
older fixtures/providers; it is not part of the live TypeSafe question contract.

Jev chooses relevance only. Every admitted observation is still a deterministic
Factorio/Autorio read, and Jev never manufactures observation values.

### Phase 6 — typed state distillation

Status: **implemented in M8 (2026-09-21), first live post-step slice**

The live post-step Jev request now distills four bounded state features over the same
authoritative state already used for routing: a dominant bottleneck Choice, a grounded
readiness Score, a semantic-risk Score, and an evidence-conflict Noul.

Deterministic code owns provenance and renders the parsed values into a fixed
`[JEV_TYPED_STATE]` block before the post-step Main-LLM continuation. The block is
explicitly advisory and has no world-truth, completion, planning, operation-admission,
or user-authority role. Malformed or absent answers render no synthetic state.

The M8 questions share the existing post-step Jev request instead of spending a second
provider round. The local question-conservation default is 24; the current M7+M8
post-step request uses 19 questions.

Broader routing and recovery remain Phase 7 work.

### Phase 7 — routing and recovery

Status: **implemented in M9 (2026-09-21)**

Post-step routing and recovery now expose the same canonical Jev control-plane vocabulary:

```text
continue_runtime
observe
wake_planner
ask_user
```

The runtime interprets those requests conservatively:

- `continue_runtime` only suppresses the Main LLM when authoritative runtime work is actually active;
- `observe` enters the existing bounded read-only observation path and still obeys M7 relevance/cap admission;
- `wake_planner` enters the existing planner path; recovery maps bounded failure classes onto low/high reasoning without giving Jev plan authority;
- `ask_user` only surfaces an already-authoritative lifecycle boundary requiring user choice. It cannot create one.

Deterministic final completion is checked before recovery Jev is called. Jev is no longer
offered `deterministic_close` or `propose_blocker`, and recovery cannot convert an old
world-evidence record into a new durable blocker. Provider-budget recovery also no longer
asks Jev to choose a semantic scope; new handoffs preserve the committed target.

Legacy route names and persisted semantic-scope values remain parse/restore compatibility
only. They are normalized into the canonical non-authoritative routes and are not emitted
in live TypeSafe questions.

Reasoning effort, planning horizon, observation relevance, typed state, and advisory
steering remain bounded resource/context signals. No route may override deterministic
impossibility, claim completion, author a blocker, or invent user authority.

### Phase 8 — confidence/risk policy

Status: **implemented in M10 (2026-09-22), calibration framework complete**

Confidence policy is now explicit and centralized instead of being scattered through
callers.

For typed operation projection:

- operation metadata remains the source of `low | moderate | high | combat` risk;
- `walk_to_entity_exact` keeps the existing M6 live baseline of `0.85`;
- every other operation currently has `automatic_projection=false` and
  `calibration_status=pending_phase9_e2e`;
- moderate/high/combat operations therefore wake the Main LLM even at confidence 1.0
  until Phase 9 supplies real AIRI E2E evidence;
- confidence never bypasses normal parse/preflight/freshness validation.

For routing and observation:

- `continue_runtime`, `observe`, `wake_planner`, and `ask_user` each have an
  explicit confidence-role policy and deterministic guard;
- none of those policies lets confidence create runtime truth or authority;
- `ask_user` can never be authorized by confidence alone;
- M7's existing observation relevance baseline remains `0.5` with a four-family cap,
  explicitly marked as a bounded-read baseline pending Phase 9 measurement.

Legacy internal route aliases are normalized only for compatibility; live TypeSafe
questions remain canonical.

This deliberately does **not** invent stricter numeric thresholds for construction,
destruction, combat, or other higher-impact actions. Their automatic-projection policy
stays disabled until Phase 9 produces calibration data.

### Pre-Phase 9 gate — M11 workload refinement

Status: **required before E2E; added 2026-09-22 after re-auditing the live workload
against current official TypeSafe/System One guidance.**

Phase 9 is deferred until the cleanup in
`validation/JEV_REFINED_WORKLOAD_AUDIT_2026-09-22.md` is complete.

Required order:

1. exact provider-schema fidelity;
2. steering redesign into real typed questions;
3. interaction-router consolidation;
4. deterministic recovery simplification;
5. typed-state demotion to experimental/trace-only pending evidence.

The strongest current Jev roles — observation-relevance fan-out and complete candidate
selection — remain core and should not be weakened by this cleanup.

### Phase 9 — E2E comparison

After the pre-Phase 9 gate is green, compare:

1. Main-LLM-only structured-control baseline;
2. TypeSafe-native coprocessor.

Use retired correctness-gate traces as historical evidence only; do not revive that
architecture as a live experimental arm.

Measure:

- task success;
- malformed/omitted Main-LLM control outputs;
- Main-LLM calls and tokens;
- Jev calls/tokens;
- candidate/projection fallbacks;
- observation count;
- operation/preflight failures;
- replans;
- latency;
- human intervention.

Start with previously successful micro tasks, then production lines, research dependencies,
fluids, combat, and long-horizon factory work.

### Current branch checkpoint

As of 2026-09-21, the branch has already:

- removed live Jev plan-commit scope review;
- deleted the retired scope-review implementation/taxonomy;
- removed old Jev checkpoint/receipt correctness machinery from the main matrix;
- added shared operation-name/argument metadata;
- added scope-specific operation catalogs;
- added an **experimental** typed-projection module.

The experimental projection module is **not yet the final design**. Its independent
route/type/candidate questions should be replaced by a TypeSafe-native coherent
function/candidate-selection shape before live execution wiring.

No GitHub status checks/workflow runs were reported for audited HEAD
`9d5c0d2fe2a06cd9ddec74be8aa5b833550c00e7` during this audit, so this checkpoint
must not be described as CI-validated.

## 14. Non-goals

This roadmap does not mean:

- deterministic code chooses gameplay strategy;
- Jev becomes the primary planner;
- the shelf becomes a hidden executable mega-plan;
- every low-level operation must be frozen at plan commit;
- ordinary runtime recovery must ask the user;
- long-horizon planning is abandoned;
- vertical/horizontal steering becomes a blind alternating state machine;
- Jev steering recommendations become execution authority.

The goal is the opposite: preserve long-horizon direction at low detail, resolve only what is currently useful, and make the committed executable contract small enough to remain stable.



## Parallel work and run-ahead planning (owner direction, 2026-09-25; not designed yet)

The NPC should learn to do work in parallel instead of one thing at a time. There
are two kinds of parallel work:

- **More machines for the same work.** Several drills, furnaces or assemblers on
  one job, so it finishes sooner.
- **Different tasks at the same time.** For example, crafting while mining. In
  Factorio, the character's hand-crafting queue keeps running while it walks or
  mines. A plan that waits for crafting to finish before it moves on wastes that
  time.

The owner also wants the LLM to **run ahead**, like a CPU that predicts the next
instructions:

- While the current work is still running, the LLM plans what comes next on the
  assumption that the current work succeeds as intended.
- If the work finishes as predicted and nothing broke, that plan is used, and the
  time spent waiting for the LLM is saved.
- If the outcome differs, the plan made ahead is thrown away and the normal path
  runs.

**These are learned behaviours, not hard-wired ones.** The harness must not decide
when to parallelize, how many machines to build or what to predict. That is
strategy, and it goes through the skill library, the same way as production
patterns (`packages/autorio/src/skills.ts`, `basic_skill_library.ts`):

- Each way of working in parallel is a skill: a curated `pattern` to start with,
  and verified or learned skills later. The Main LLM finds one with `findSkills`,
  loads it with `getSkillDetails` into the task's Skill Context, and decides
  whether and how to use it in the plan it writes. Jev can rank which skill fits.
- A skill is guidance, not a script. The planner still checks it against the live
  world (recipes, inventory, placement, measured throughput) before relying on it.
- Skills are revised from evidence like any other skill. A pattern that wasted
  time or failed is marked down; one that saved time is kept.

The harness supplies only the generic mechanics these skills need. Those
mechanics hold no Factorio strategy:

- it admits two operations at once only if the real character can do both (for
  example, a hand-craft queue during a walk or mining). It never lets them claim
  the same items twice or send the body to two places;
- it keeps a run-ahead proposal with the outcome it assumed, compares that with
  the real world state when the work ends, and uses the proposal only if they
  match.

Constraints any design has to keep:

- Running ahead only prepares decisions. It must not act in the world early, and
  it must not change a committed plan (§1.1).
- "More machines" is a throughput decision. It follows the measured-throughput rule
  (no unvalidated inserter or belt figures) and fits the production-rate goals
  above.

## Agent split: a roadmap agent and one agent per active plan (owner idea, 2026-09-26; for discussion, not designed)

**Owner decision, 2026-09-26 (later the same day):** do delegation inside one NPC first
(several minds, one body), before several NPC bodies. Build it on the swarm design's
records (`docs/SWARM_COORDINATION_ARCHITECTURE.md`: mission, work item, result with
evidence, reservations for the body's lanes) so a second body later reuses the same
contract, and integrate Jev as far as its authority allows. The swarm branch is
audited for parts, not merged. Scheduled as wave 3 of
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md` "Next week", toward the `v0.1.0-pre.2`
electricity target stated there; the design note (item 3.1) answers the questions
below.

Trigger: the steam-power live run (`docs/validation/E2E_STEAM_POWER_2026-09-26.md`).
One request carried the whole goal for 38 minutes and died on its output cap
(107,322 > 100,000 output units, 99,874 of them reasoning). DeepSeek also authored a
plan slowly (one 162 s round), never used the time tools, and stayed on one serial
lane. The owner's conclusion: DeepSeek is not good enough at a long agentic workload
right now, so try subagents next time.

The idea, in the owner's words reduced to a shape:

- **A roadmap agent** owns the whole goal: the shelf (§3), the ordering of milestones,
  steering (§4) and the parallelization review (W2c in `docs/PARALLEL_PRODUCTION_WORK_PLAN.md`).
  It thinks slowly and rarely, and sees summaries, not raw tool traffic.
- **One subagent per active plan** owns one committed plan or slice (§1.1): its
  observations, its operations, its recovery. It has its own context and its own output
  budget, so a long goal is many small requests instead of one 38-minute request.
- Several plan agents could run at once when the plans use different lanes (crafting
  while mining, two machine lines), which is the concurrency W2c asks for.

Why it might help, from the run: the cap and the growing context are per request, and a
plan-scoped agent resets both at a natural boundary; a cheaper or faster model can run
plan agents while a stronger one authors the roadmap.

Questions to settle before any design (for the discussion elsewhere):

- What the interface between the roadmap agent and a plan agent is. It must stay the
  structured, bounded plan/step contract (§1.1, §6), not free text, and the harness
  still owns admission, receipts and completion (§1.4).
- How a plan agent's outcome returns: verified evidence only, never a claim (see the
  completion-honesty finding in the run doc).
- Which model per role, and who pays for the extra calls (usage pacing).
- How actor and epoch correlation is preserved when several agents share one body: two
  agents must not send the character to two places or claim the same items.
- Whether this replaces or extends the Jev coprocessor (§1.3, §11), which already reads
  goals and steers; the roles should not overlap.
- How the per-request output budget and the "close on the next turn" rule apply to a
  plan agent.

Constraints that hold whatever the design (AGENTS.md): the model chooses among approved
tools; the harness owns state and completion; zero connected humans stays valid; stale
work after actor replacement or restart fails safely.

## Later factory-performance frontiers

The planning shelf must not assume that "launch a rocket" is always the terminal node.

Once ordinary production construction, item transport, fluids, and sustained-rate verification are proven, later goals may use open-ended capability frontiers such as sustained science per minute (SPM), logistics/power headroom, resource expansion, resilience, and throughput scaling.

Treat these as later maturity work documented in `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`. They must not displace the current micro-production validation priority.

For continuous factory goals, distinguish:

```text
plan slice completed
!= capability frontier reached
!= user goal satisfied
!= project ended
```

## 15. Summary

The planning system should converge on five simple ownership rules:

> **Goal:** user-owned intent.

> **Shelf:** LOD-style long-horizon guidance for future rounds; tentative, durable, lineage-preserving, non-executable.

> **Steering:** planning-boundary guidance about whether the next slice should advance the frontier, broaden the foundation, maintain, or recover; advisory and relative to the current critical path.

> **Plan:** Main-LLM-authored bounded executable slice with one dominant development mode; immutable after commit.

> **Jev:** typed probabilistic coprocessor for bounded selection, routing, scoring, observation relevance, candidate choice, and advisory steering; never a correctness reviewer.

Everything else in Plan Tracker, completion, recovery, hierarchy, and UI should be simplified around those boundaries.
