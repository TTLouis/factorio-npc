# Planning Refactor — Integration & Deletion Plan

Status: **working plan**
Companion to: `docs/NPC_PLANNING_ROADMAP.md` (canonical semantics)
Branch: `experiment/jev-agent-architecture`
Started: 2026-09-19

This file is the *mechanical* counterpart to the roadmap. The roadmap says what the
planning system should mean; this says which code has to go, in what order, and what
breaks if the order is wrong.

## Decisions that override the roadmap

Settled with the project owner on 2026-09-19. Where these conflict with
`NPC_PLANNING_ROADMAP.md`, **these win**.

1. **"Immutable" means frozen against its own authors.** Once the system commits a
   plan, neither Jev nor the Main LLM may change it. Post-commit, both flip from
   authoring to *fulfilling* the committed step checkpoints.
2. **Deadlock is measured, not categorized — and harness-side only.** Roadmap §7's
   local-vs-structural category lists become documentation, not logic. Three
   deterministic signals, no model call: evidence stall over N batches, same failure
   reason code K times, provably unsatisfiable contract. A seam exists for a future
   Jev semantic signal; it is deliberately not implemented.
3. **Completion contracts are BEST-EFFORT.** Overrides roadmap §6, which refuses to
   commit a step lacking a grounded predicate. Prose-only steps are legal.
   *Consequence:* deadlock signals 1 and 3 both require a contract to exist, so
   prose-only steps are deadlock-invisible except via repeating-failure. Mitigated by
   a hard operation-count ceiling plus a `reduced_confidence` marker.
4. **Auto-commit; no user approval in the normal path.** A plan commits once Jev
   returns `actionable` and runtime validation passes. The user is pulled in on
   deadlock. Separately, explicit **user steering** may supersede the active plan at
   any time.

Old milestone/project/hierarchy machinery is **deleted, not migrated** — persisted
state need not survive.

## What exists now

| Module | State |
|---|---|
| `runtime-v8/planning-state.mjs` | **New.** Goal / minimal Shelf / immutable Plan + `applyPlanningEvent` single transition authority + harness deadlock detection. 49 tests. Not yet wired in. |
| `runtime-v8/jev-decision-taxonomy.mjs` | **Rebuilt.** `granularity` / `completion` / `milestone_transition` stripped of authority; `scope_review` + boundary steering added. Carries a **deprecation shim** at the foot of the file. |
| `runtime-v8/canonical-task-board-memory.mjs` | Untouched. Still the old shape. |
| `runtime-v8/npc-agent-loop.mjs` | Untouched. Still consumes hierarchy telemetry. |

### The deprecation shim

`npc-agent-loop.mjs` imports five symbols the rebuilt taxonomy no longer needs.
Removing them outright makes the entire runtime fail at module load. The shim at the
end of `jev-decision-taxonomy.mjs` re-exports them, marked `@deprecated`, purely to
keep the import graph resolvable.

Two tripwires guard it: `parseDecisionFamily` must **degrade rather than throw** for
retired families (throwing routes the whole decision down the provider-failure path),
and the test `'retired hierarchy exports survive only as scaffolding'` asserts the
shim still exists. **At Step 6, delete the shim block and invert that test.**

## Deletion order

Nine steps. The suite should pass between each. Baseline before this work:
**561/563** — the two standing failures are the prompt-trace test and the RCON E2E
(needs a live Factorio server). Neither is related to planning.

| Step | Scope | Risk |
|---|---|---|
| 0 | Unbreak the import graph | **done** — via the shim |
| 1 | Freeze invariants with regression tests | none, pure addition |
| 2 | UI leaves: `task_board_debug_render.ts` → `task_board_debug.ts` → `supervisor.mjs` debug fields | low, absent-tolerant both directions |
| 3 | `render_project_board` + `sanitize_project` in `task_board_ui.ts` | low |
| 4 | `supervisor.mjs` hierarchy control flow | medium — structural-recovery failures begin pausing normally |
| 5 | Prompt-injection strings + trigger ladder in `npc-agent-loop.mjs` | medium |
| 6 | Jev decision families; **delete the shim**, invert its tripwire | medium |
| 7 | Memory-layer writers; delete `project-board.mjs` | **highest** — touches persistence |
| 8 | `allowReplan` + land `STRUCTURAL_BLOCKER_CONFIRMED` | high, see below |
| 9 | Fold remaining writers into `applyPlanningEvent` | medium |

**Critical path:** `0 → 1 → 5 → 6 → 7 → 8 → 9`, with `2 → 3` and `4` as a parallel
branch that must rejoin before Step 7.

**Strictly sequential, and why:** 5→6 (Step 6 removes `parseHierarchyTelemetry`, which
Step 5's ladder consumes) · 6→7 (Step 7 deletes `activateNextMilestone`, which Step 6's
ladder calls) · 7→8 (the `allowReplan` clamp lives in the file Step 7 rewrites) · 5→8
(Step 5 makes the hierarchy half of the grant dead, reducing Step 8 to a two-token
edit rather than a judgment call) · 8→9 · 2→3 · 4→7.

**Safely parallel:** Step 1 against anything · UI (2+3) against supervisor (4) ·
the ten prompt/trigger sites within Step 5 · the two clusters within Step 7 ·
test rewrites outside `canonical-task-board-memory.test.mjs` once their source step lands.

## The `allowReplan` risk — resolved

`npc-agent-loop.mjs:5588` grants replan authority when `planUpdateReason` is
`'failure'` or `'reanchor_plan'`, or on six hierarchy trigger strings.

**`'failure'` is not the provider-failure path.** It is set in exactly one place
(`failed()`, called only from `supervisor.mjs` on an `[AUTORIO] [ERROR]` line) — an
in-game operation error. Provider/LLM failures travel a different road entirely
(`recoverPlan` → `recovery-route.mjs`) and never set it. Crash/restart recovery uses
`'recovery'`, which has **never** had `allowReplan` and works fine.

So removing the grant does **not** convert recoverable hiccups into hard stops.

**The real regression is subtler and must be guarded.** With `allowReplan: false`,
`canonicalContinuationPlan` discards the model's proposed plan and substitutes the old
canonical steps *before* `reconcileTaskBoard` ever sees it. The failure mode is not a
hard stop but a **silent no-op loop**: the model re-proposes a suffix that is clamped
away every turn. Therefore Step 8 must land `STRUCTURAL_BLOCKER_CONFIRMED` in the same
commit, so an operation error that genuinely invalidates the plan produces `BLOCKED` +
a user question instead of looping.

This connects to the known silent auto-pause bug — the roadmap's `BLOCKED` state is
the principled version of that behavior, so Step 8 should fix it rather than deepen it.

## Semantic writers to consolidate (roadmap §9)

Beyond the known set (`recordPlan`, `applyOutcomeAuthority`, `activateNextMilestone`,
`reconcileTaskBoard`, trigger-string resets), two were **not** previously catalogued
and are the most insidious:

- **`canonical-task-board-memory.mjs:271` `setStepCompletionContract`** — rewrites a
  *committed* step's completion contract post-hoc. Directly violates roadmap §6; must
  move pre-commit.
- **`canonical-task-board-memory.mjs:585` `recordBoardEvidence`** — calls
  `applyOutcomeAuthority({kind:'world_blocked'})` from inside an evidence-*recording*
  function. A write hiding in a read path.

Also: **`npc-agent-loop.mjs:1068` `beginActionOmissionRecovery`** fabricates an entire
durable state — `goal_id`, `plan`, `current_step`, a fresh task board — when none
exists. A provider omission can currently mint a goal.

## Known integration gaps

- **Shape mismatch is total.** `planning-state.mjs` shares no fields with
  `state.plan` (string array) / `state.current_step` (int) / `state.task_board`. An
  adapter is required.
- **Evidence granularity gap.** `verifyDeterministicReceipt` produces batch-level
  "verified_complete", not requirement-level satisfaction. Something must map a
  verified batch to `satisfied_requirement_ids`, or grounded steps never complete.
- **`retireCompletedPlan` deletes completed goals** from the memory map;
  `planning-state.mjs` deliberately preserves them for lineage. Deletion policy must
  move to the snapshot layer or lineage is lost.
- **No `BLOCKED` UI exists.** `task_board_ui.ts` `status()` accepts only
  `active|blocked|paused|completed`; a first-class blocked state with user choices,
  plus `plan_id` / `plan_version` / `superseded_by`, is net-new UI, not deletion.

## Affected tests

45 across 13 runtime-v8 files, plus 1 in `packages/autorio/src/task_board_ui.test.ts`.
Heaviest: `canonical-task-board-memory.test.mjs` (12/35), `project-board.test.mjs`
(8/8, delete whole file), `condition-wait-integration.test.mjs` (6/24).

Two enshrine behavior the new architecture forbids and should be **inverted**, not
deleted: `'explicit failure replan is still allowed to replace the remaining suffix'`
(`canonical-task-board-memory.test.mjs:116`) and its `common.mjs`-level twin
`'failure recovery may replace only the remaining suffix…'` (`task-board-lite.test.mjs:53`).

One must be **kept and rewritten, not deleted**: `'durable step completion contracts
survive snapshot restore…'` (`canonical-task-board-memory.test.mjs:817`) — the
contract-rehydration path it covers has to survive Step 7 intact.
