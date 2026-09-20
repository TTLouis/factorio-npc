# Jev RCON E2E Findings — 2026-09-20

## Scope and evidence

- Sandbox: `jev-rcon-e2e`, launched with `compose.yml` and `compose.e2e.yml`.
- Transport: local loopback RCON mapping; the tick smoke test and authentication
  both succeeded before either round began.
- Evidence sources: task-board status over RCON and
  `/data/logs/sgluna-behavior.jsonl` in the Factorio container.
- No reset was forced. Each round used a distinct natural-language objective and
  the UI control queue was flushed before it was sent.

## Finding 1 — completed current step can remain active and reject its successor

**Round / identifiers**

- Goal: `goal_mu93hpfp`
- Request: `req_mu93hpg2_8`
- Objective: plan and build a minimal coal-fuelled stone-furnace unit, including
  live observation, a non-blocking placement, fuel loading, and verification.

**Observed sequence**

1. The planner observed actor status, inventory, and nearby entities.
2. It created a three-step plan whose first step was to gather two stone.
3. `gather_resource { resource_name: "stone", count: 2, search_radius: 256 }`
   passed `operations.preflight_ok`, was admitted, and returned an acknowledgement.
4. The runtime later recorded a completed receipt for batch 13 (walking plus
   mining), with `entity_name: "stone"` and `requested_count: 2`.
5. The harness emitted deterministic verification that the batch had strict
   completion semantics.
6. The next proposed operation, `craft_item(stone-furnace, 1)`, was rejected
   twice as `belongs_to_later_step`, because canonical step 1 remained active
   even though its gather operation had a completed, verified receipt.
7. The request ended with
   `provider_semantic_alignment_failed: proposed operations still do not align
   with active canonical step after re-anchor; relation=belongs_to_later_step`.

**Expected behavior**

Once the verified receipt establishes the active gather step's semantic result,
the canonical board should advance to the crafting step (or deterministically
revalidate the active step and mark it complete) before admitting the successor
operation.

**Likely repair area**

Examine the handoff between completion receipt / deterministic verification and
canonical task-board step advancement. In particular, avoid preserving a
`keep_step_open` checkpoint when its operation receipt already proves the active
step's requested effect, and ensure semantic re-anchor can commit the proposed
focus transition before checking successor-operation alignment.

## Finding 2 — advanced production-planning round is created correctly; completion is pending

**Round / identifiers**

- Goal: `goal_mu93kj1l`
- Request: `req_mu93kj1r_9`
- Objective: create a 1/s iron-gear automated-production plan; inspect recipes,
  current production scope, belt capacity, and legal placement candidates; build
  only if every constraint passes, otherwise report the exact blocker.

**Observed result**

- The request was classified as `new_goal`, received a new goal id instead of
  folding into the furnace round, and bound the standalone actor cleanly.
- Jev selected `hierarchy_initial_split` with `reasoning_budget: "deep"`,
  `planning_horizon: "subgoal"`, and `observation_budget: 4`.
- At evidence capture the first provider round was still active. This is not a
  pass or failure of the full production task; it is a resumable live round that
  should be revisited after fixing Finding 1 or when the provider round settles.

## Follow-up checklist

1. Add a focused regression test that feeds a completed strict gather receipt to
   a current gather step, then verifies that an immediately proposed craft step
   is admitted rather than rejected as a later-step operation.
2. Preserve the exact receipt-to-step correlation in the test: actor id/epoch,
   batch id/generation, operation name, requested count, and canonical step id.
3. Re-run the furnace objective in the disposable Jev RCON sandbox.
4. Resume or replace the production-planning objective with a fresh distinct
   objective only after recording the furnace regression outcome; external reset
   remains unreliable.
