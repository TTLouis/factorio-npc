# AIRI Factorio — Planning Architecture Roadmap

Status: **canonical planning direction**
Branch of origin: `experiment/jev-agent-architecture`
Adopted: 2026-09-19

This document is the authority for future planning, Plan Tracker, roadmap/shelf, and Jev planning-review work. Where older planning or Jev documents conflict with this file, this file wins.

The redesign is intentionally simpler than the current experimental hierarchy/checkpoint stack:

> The user owns the goal. The Main LLM authors plans. Jev critiques draft scope. The runtime validates and executes. A committed plan is immutable. Future intent lives on a non-executable shelf and is progressively refined like level of detail (LOD).

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

### 1.3 Jev is a plan critic, not a co-planner

For planning, Jev's primary role is **pre-commit scope review**.

Jev may judge whether a draft is:

- actionable;
- too vague;
- too broad;
- too long-horizon for the currently known world;
- missing an obvious prerequisite;
- mixing multiple semantic outcomes into one step;
- ending at a poor checkpoint;
- insufficiently grounded for deterministic validation.

Jev does **not** rewrite the plan. It returns bounded criticism to the Main LLM, which authors the next draft.

After commitment, Jev has no authority to add/remove/reorder steps, advance the Plan Tracker, redefine completion, or silently replan around a blocker.

Jev may still assist with **diagnosing** an execution failure, but runtime evidence owns the failure fact and the user owns approval of any plan revision.

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
       JEV SCOPE REVIEW
       refine <----------+
          |              |
          +----> Main LLM+
          |
       actionable
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

Jev's pre-commit scope review should detect substantial mixed-direction drafts and ask the Main LLM to choose a cleaner boundary unless the mixture is genuinely inseparable.

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
            JEV SCOPE REVIEW
                   |
             refine / actionable
                   |
                   v
          RUNTIME VALIDATION
                   |
                   v
        COMMITTED IMMUTABLE PLAN
```

Steering review and scope review are separate questions:

- **Steering:** what kind of development should the next slice pursue?
- **Scope:** is the proposed slice concrete and bounded enough to commit?

Keeping them separate prevents "vertical/horizontal" from becoming another hidden planning authority.


## 5. Draft -> review -> commit lifecycle

Planning should have an explicit pre-commit boundary:

```text
DRAFT
  |
  v
JEV_REVIEW
  |\
  | +--> REFINE --> Main LLM --> DRAFT
  |
  +----> ACTIONABLE
             |
             v
      RUNTIME_VALIDATION
             |
             v
           READY
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

### 5.1 No fixed maximum step count

Do not define actionability as a hard rule such as `steps <= 5`.

Six small concrete steps may be better than two enormous vague ones.

Jev should judge semantic scope using signals such as:

- can the current world support choosing the action now?
- is the completion condition observable?
- does the step represent one useful semantic outcome?
- is dependency uncertainty bounded?
- is the plan horizon close enough that later world changes are unlikely to invalidate most of it?
- does the slice end at a meaningful re-observation/replanning checkpoint?

Plan length may be a signal, not authority.

### 5.2 Actionable prefix / tail shelving

When an initial draft reaches too far ahead, Jev may identify an **actionable prefix** or an appropriate earlier checkpoint.

Representative response:

```json
{
  "verdict": "refine",
  "reason_codes": ["horizon_too_long", "step_too_vague"],
  "actionable_prefix": 3,
  "problem_steps": ["draft_step_4"],
  "recommended_boundary": "first_stable_smelting_checkpoint"
}
```

This is criticism, not rewriting.

The Main LLM produces a new bounded draft from that feedback. The deferred tail remains represented on the Roadmap Shelf as higher-level guidance for later rounds.

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

The intended pre-commit collaboration is:

```text
Main LLM proposes semantic step
        |
        v
Jev checks scope / ambiguity
        |
        v
runtime validates that the completion contract is supported
        |
        v
commit
```

Do not wait until post-operation execution to renegotiate what a semantic step meant.

If a required semantic completion condition cannot be represented by supported grounded predicates, the draft is not ready to commit. The planner should refine/split it or explicitly define a supported control-only boundary.

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
- `JEV_REFINEMENT_REQUESTED`
- `PLAN_COMMITTED`
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

## 11. Jev planning-review contract

Keep the contract intentionally narrow.

Suggested verdicts:

```text
actionable
refine
needs_grounding
needs_user_clarification
```

Suggested reason codes:

```text
too_broad
horizon_too_long
step_too_vague
mixed_outcomes
missing_dependency
completion_not_observable
unsupported_completion_contract
assumption_not_grounded
bad_checkpoint_boundary
```

Jev may additionally return:

- indices/ids of problematic draft steps;
- an actionable prefix length;
- a recommended semantic boundary;
- a compact explanation for the Main LLM.

Jev must not return replacement operations or authoritative new plan steps.

## 12. User interaction rules

Ask the user when the semantic contract truly needs user authority, especially:

- a committed plan hits a structural blocker requiring a different route;
- the user's constraints conflict;
- there are materially different goal interpretations and choosing one would change the requested outcome;
- the user explicitly asks to alter/cancel the plan.

Do not interrupt the user for ordinary runtime recovery that stays within the committed semantics.

When blocked, present the verified reason and bounded choices without silently selecting a new strategy.

## 13. Implementation roadmap

### Phase 1 — Freeze the invariants with regression tests

Before further Jev planning features, add tests that prove:

- committed plan content cannot change during ordinary continuation;
- planner `currentStep`/focus cannot advance Plan Tracker;
- Jev cannot mutate committed plan state;
- ordinary local recovery cannot replace a plan;
- structural blocker freezes rather than replans;
- only explicit user-approved revision creates a successor plan;
- plan/shelf lineage survives persistence/restart.

### Phase 2 — Introduce explicit Goal / Shelf / Plan data model

Add durable, versioned objects for:

- user goal;
- roadmap revision + shelf nodes;
- active plan identity/version;
- immutable committed step contracts.

Migrate existing Project Board / Task Board state without allowing ordinary `recordPlan` calls to drop extension state.

### Phase 3 — Make Plan Tracker read-only with respect to planning

Consolidate semantic transition authority.

Remove direct state advancement/replacement from planner reconciliation, Jev routing, trigger strings, and incidental post-operation paths.

### Phase 4 — Move Jev to pre-commit scope review

Implement the bounded draft-review loop:

```text
Main LLM draft
-> Jev scope review
-> Main LLM refine if needed
-> runtime contract validation
-> commit
```

Do not let this loop run indefinitely. Use a bounded number of refinement passes; if it cannot converge because user intent is ambiguous, ask the user rather than fabricating precision.

### Phase 5 — Implement LOD Roadmap Shelf

Make deferred long-horizon intent durable and useful across planning rounds:

- preserve shelf nodes;
- link active plans to nodes;
- attach verified results back to lineage;
- refine the nearest useful node after each completed plan;
- revise shelf guidance only from user changes or grounded world changes;
- keep the shelf non-executable.

### Phase 6 — Add strategic steering at plan boundaries

Add durable advisory steering context and a bounded Jev steering contract:

- evaluate `vertical | horizontal | maintain | recover` only at safe planning boundaries;
- classify mode relative to the current critical path, not the action type;
- preserve previous mode/reason to provide hysteresis and avoid oscillation;
- allow shelf nodes to carry non-binding development hints;
- feed steering recommendation into the Main LLM before it drafts the next plan slice;
- keep scope review separate from steering review;
- require one dominant steering mode per committed slice unless a mixed slice is demonstrably inseparable;
- prove that steering cannot mutate or replace an executing plan.

### Phase 7 — Blocker / user revision protocol

Add a first-class `BLOCKED` state and user-facing choices.

Revision produces `plan_vN+1`; it never edits `plan_vN` in place.

### Phase 8 — Retire conflicting experimental hierarchy writers

Once the new lifecycle is covered, remove/simplify old behavior that conflicts with it, including any path where:

- Jev splits or rewrites an executing plan;
- milestone trigger strings reset the Task Board;
- post-step checkpoint synthesis changes committed semantic meaning;
- multiple components can independently declare semantic plan advancement.

Preserve useful grounded predicates, receipt correlation, provider routing, condition waits, and deterministic runtime recovery where they fit the new authority model.

### Phase 9 — Full real lifecycle E2E

Add a representative long goal:

```text
user long-horizon goal
-> LOD shelf
-> Jev recommends VERTICAL at boundary
-> Main LLM drafts bounded vertical slice
-> Jev scope-refines
-> commit v1
-> execute several steps
-> local recovery without replan
-> complete v1 / reach new frontier
-> verified world state shows weak support
-> Jev recommends HORIZONTAL
-> Main LLM refines shelf into capacity/resilience slice
-> commit v2
-> complete horizontal foundation
-> Jev recommends VERTICAL toward next frontier
-> draft/commit v3
-> restart/persist/restore with steering + shelf lineage intact
-> encounter structural blocker
-> freeze
-> user approves revision
-> successor plan supersedes blocked plan
-> continue without losing goal/shelf/steering lineage
```

This E2E is the acceptance gate for the redesigned planning subsystem.

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

## 15. Summary

The planning system should converge on five simple ownership rules:

> **Goal:** user-owned intent.

> **Shelf:** LOD-style long-horizon guidance for future rounds; tentative, durable, lineage-preserving, non-executable.

> **Steering:** planning-boundary guidance about whether the next slice should advance the frontier, broaden the foundation, maintain, or recover; advisory and relative to the current critical path.

> **Plan:** Main-LLM-authored bounded executable slice with one dominant development mode; immutable after commit.

> **Jev:** pre-commit critic that decides whether the draft is scoped and grounded enough to commit, not a second planner.

Everything else in Plan Tracker, completion, recovery, hierarchy, and UI should be simplified around those boundaries.
