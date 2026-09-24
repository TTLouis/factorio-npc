# Jev Cloud Provider Trial, Run 3 — 2026-09-24

Third round of the same goal; follows `JEV_CLOUD_PROVIDER_TRIAL_RUN2_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh data directory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `477153a` (adds the implied
  completion claim from a one-step focus advance).
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Nova-1` (`npc-1`), actor_id 8.

## Round

- Goal `goal_mufyvtst`, request `req_mufyvtss_1`:
  `!luna mine 10 stone and craft a stone furnace`.
- Plan: mine 10 stone; craft 1 stone furnace; verify stone and furnace in inventory.
  Goal definition: `inventory_count stone-furnace >= 1`.
- Physical outcome: 10 stone mined; furnace crafted; inventory read shows
  `stone-furnace` x1, `stone` x5.
- Harness outcome: `request.failed`, `semantic_completion_requires_runtime_grounding`,
  after 8 provider calls (125,325 input units, 95,232 cached; 2,462 output units).

The Plan Tracker id repair from run 2 worked: the planner's claim with the
`[PLANNING_STATE]` id closed step 1.

## Finding 1 — the implied claim did not fire because a later step was reworded

When the planner moved to step 2 with the craft, it reworded step 3 ("Verify 10 stone
were mined and the stone furnace is in inventory" → "Verify the stone furnace is in
inventory"). The implied-claim check required the whole plan to match, so step 1 stayed
active and the craft receipt was again booked against step 1.

**Repair:** compare only the active step and the next step; later steps are proposals
the committed plan ignores.

## Finding 2 — closing a step discarded the fresh read that grounds the next one

After step 1 closed, the harness reset its action-omission state, which also cleared
the "fresh observation in this continuation" flag. The planner's claim for step 2,
grounded only by the inventory read taken a few seconds earlier with nothing run
since, was refused.

A unit test also showed that the synthetic fresh-observation evidence used one ref per
request. The evidence store drops a repeated ref, so a second step's claim had nothing
bound to it even when the flag survived.

**Repair:** keep the flag when a step closes (a new batch always returns through a
continuation, which clears it) and give the fresh-observation evidence a per-step ref.

## Finding 3 — one invalid Jev answer still discarded the whole batch

The first post-step planner-shape call fell back:
`planning_horizon choice is not the highest-probability option`. All 17 answers were
dropped, and the raw answer was not logged because validation threw inside the
provider.

**Repair:** validate answers one by one. An invalid answer is dropped alone and
reported as `invalid_answers` (reason and raw answer) in the `decision.exchange`
record; the request fails only when every answer is invalid.

## Noted, not changed

- **DeepSeek tool-call markup as content.** With tools disabled, one reply was
  DeepSeek's internal `<｜｜DSML｜｜ invoke name="submitPlan">` markup instead of
  JSON. Generic recovery absorbed it with one extra call.
- **Goal check on "done".** The planner's own rationale argued that
  `done_when` (`inventory_count stone-furnace >= 1`) was met, so the remaining
  steps were complete. Checking the goal definition in the game when the planner
  declares the goal done would save the per-step claim calls. Deferred until a run
  shows it is still needed after the repairs above.
