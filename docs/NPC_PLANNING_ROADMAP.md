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

## 4. Draft -> review -> commit lifecycle

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

### 4.1 No fixed maximum step count

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

### 4.2 Actionable prefix / tail shelving

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

## 5. Step contracts are fixed before commit

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

## 6. Execution and recovery do not rewrite the plan

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

## 7. Plan Tracker becomes a view of one immutable plan

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

## 8. One transition authority

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

## 9. Identity and lineage

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

## 10. Jev planning-review contract

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

## 11. User interaction rules

Ask the user when the semantic contract truly needs user authority, especially:

- a committed plan hits a structural blocker requiring a different route;
- the user's constraints conflict;
- there are materially different goal interpretations and choosing one would change the requested outcome;
- the user explicitly asks to alter/cancel the plan.

Do not interrupt the user for ordinary runtime recovery that stays within the committed semantics.

When blocked, present the verified reason and bounded choices without silently selecting a new strategy.

## 12. Implementation roadmap

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

### Phase 6 — Blocker / user revision protocol

Add a first-class `BLOCKED` state and user-facing choices.

Revision produces `plan_vN+1`; it never edits `plan_vN` in place.

### Phase 7 — Retire conflicting experimental hierarchy writers

Once the new lifecycle is covered, remove/simplify old behavior that conflicts with it, including any path where:

- Jev splits or rewrites an executing plan;
- milestone trigger strings reset the Task Board;
- post-step checkpoint synthesis changes committed semantic meaning;
- multiple components can independently declare semantic plan advancement.

Preserve useful grounded predicates, receipt correlation, provider routing, condition waits, and deterministic runtime recovery where they fit the new authority model.

### Phase 8 — Full real lifecycle E2E

Add a representative long goal:

```text
user long-horizon goal
-> LOD shelf
-> draft slice
-> Jev refine
-> commit v1
-> execute several steps
-> local recovery without replan
-> complete v1
-> use shelf to draft v2
-> restart/persist/restore
-> encounter structural blocker
-> freeze
-> user approves revision
-> v3 supersedes v2
-> continue without losing goal/shelf lineage
```

This E2E is the acceptance gate for the redesigned planning subsystem.

## 13. Non-goals

This roadmap does not mean:

- deterministic code chooses gameplay strategy;
- Jev becomes the primary planner;
- the shelf becomes a hidden executable mega-plan;
- every low-level operation must be frozen at plan commit;
- ordinary runtime recovery must ask the user;
- long-horizon planning is abandoned.

The goal is the opposite: preserve long-horizon direction at low detail, resolve only what is currently useful, and make the committed executable contract small enough to remain stable.

## 14. Summary

The planning system should converge on four simple ownership rules:

> **Goal:** user-owned intent.

> **Shelf:** LOD-style long-horizon guidance for future rounds; tentative, durable, lineage-preserving, non-executable.

> **Plan:** Main-LLM-authored bounded executable slice; immutable after commit.

> **Jev:** pre-commit critic that decides whether the draft is scoped and grounded enough to commit, not a second planner.

Everything else in Plan Tracker, completion, recovery, hierarchy, and UI should be simplified around those boundaries.
