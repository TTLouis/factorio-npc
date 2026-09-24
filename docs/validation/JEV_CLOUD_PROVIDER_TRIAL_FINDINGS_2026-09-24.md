# Jev Cloud Provider Trial Findings — 2026-09-24

## Scope and evidence

- Sandbox: Claude Code on the web cloud container, launched with
  `scripts/stack-cloud.sh` (`compose.yml` + `compose.e2e.yml`), Factorio
  headless 2.0.77, fresh private map, zero connected players.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `30df548`.
- Main LLM: DeepSeek `deepseek-flash` through the OpenAI-compatible endpoint.
- Decision provider: TypeSafe `jev-latest`, reported as `jev-1.13.0`.
- Actor: standalone character `Aster-1` (`npc-1`), actor_id 13, epoch 1.
- Evidence sources: `/data/logs/sgluna-behavior.jsonl`,
  `/data/logs/sgluna-decision.jsonl`, and a direct `getInventoryItems` read over
  RCON after the request ended.

## Round

- Goal: `goal_mufx9yr3`; request: `req_mufx9yr2_1`.
- Chat: `!luna mine 10 stone and craft a stone furnace`, sent over RCON as
  `<server>`.
- Plan accepted from the Main LLM: gather 10 stone, verify 10 stone in
  inventory, hand-craft 1 stone furnace, verify the furnace in inventory. No
  step carried a completion checkpoint.
- Physical outcome: batch 1 walked and mined 10 stone; batch 2 hand-crafted one
  stone furnace. Inventory after the request: `stone-furnace` x1, `stone` x5.
- Harness outcome: `request.failed`, stage `runtime`,
  `semantic_completion_requires_runtime_grounding`, not recoverable, after
  10 provider calls (159,997 input units, 124,672 cached; 6,911 output units,
  6,084 of them reasoning).

The world reached the requested state; the request still failed. Findings 1
and 2 are harness defects with deterministic repairs. Findings 3 and 4 are
recorded for follow-up and are not changed here.

## Finding 1 — rounded Jev distributions discard the whole planner-shape answer

**Observed**

`decision.fallback` for `interaction_planner_shape` at goal admission:
`Decision provider answer goal_scope probabilities must sum to 1`. All 16
answers in that response (reasoning budget, horizon, the 11 observation
relevance families, and the goal reading) were discarded and the planner ran
on defaults.

**Reproduction**

The same 16-question request was sent directly to the Jev endpoint 30 times.
Jev reports every probability with two decimals. Two responses (about 7%)
returned `goal_scope` as `{finite: 0.93, unclear: 0.05, long_horizon: 0.01}`,
which sums to 0.99. Every other distribution in every response summed to 1.

**Root cause**

`probabilityDistribution` in `runtime-v8/provider.mjs` accepts a total only
within 0.0001 of 1. Rounding each of `n` values to two decimals can move the
total by up to `n × 0.005`, so any distribution with three or more options can
fail by rounding alone.

**Repair**

Accept a total within the rounding error of the reported values
(`0.005` per option, never less than the previous 0.0001). A distribution
that is actually wrong, such as `{a: 0.8, b: 0.1}`, is still rejected.

## Finding 2 — the observe route can carry an observation budget of zero

**Observed**

After batch 2, the post-step gate chose `targeted_observation` (confidence
0.53). The separate planner-shape call answered every `need_*` relevance
question below the 0.5 threshold (highest: `inventory_equipment` 0.29,
`runtime_status` 0.27). The harness therefore selected no family and set the
observation budget to 0. The planner asked for `getCraftingStatus` and
`getInventoryItems`; both were deferred with
`jev_observation_budget_exhausted` ("selected families: none"), and tools were
disabled for the forced decision.

**Consequence**

The planner could not read the inventory it needed to verify the craft. Its
later semantic completion claim for step 2 had no step-2 evidence (batch 2's
receipt was recorded against step 1, which was still active) and no fresh
observation in the request, so `applySemanticCompletionClaim` raised
`semantic_completion_requires_runtime_grounding` and the request failed.

**Root cause**

The route and the family relevance are two independent Jev judgments. The
harness applied the relevance answer literally even when it contradicted the
route: an `observe` route with zero admissible reads cannot make progress.

**Repair**

When the applied post-step route is `targeted_observation` and relevance
selected no family, keep one bounded fresh read on the highest-ranked family
(or, with no typed relevance at all, one read without a family filter). The
`post_step.routed` trace marks this with `observation_relevance.floor`. Relevance above the threshold, and every
non-observe route, keep their current behavior. In this round the floor would
have admitted `getInventoryItems`.

## Finding 3 — craft admitted while the gather step was still active (not changed)

The replan after batch 1 kept step 1 active and admitted the step-3 craft
(`proposed_focus_index` 2, `active_index` 0). Batch 2's receipt was then
attributed to step 1. This is the same family as Finding 1 of
`JEV_RCON_E2E_FINDINGS_2026-09-20.md` (verified receipt does not advance the
canonical step). It should be handled with that finding, not here.

## Finding 4 — `deepseek-flash` exhausted its output budget on reasoning (not changed)

In the second action-omission recovery call the provider returned 2,048 output
units, all reasoning, and no content. The harness handled it as designed
(`provider_output_budget_exhausted` → deterministic budget handoff). It
reflects the chosen model's reasoning length under micro budgets, not a
harness defect.

## Follow-up validation

- Unit coverage for Findings 1 and 2 lives in the existing
  `runtime-v8` test files; no new CI job is added.
- Re-run the same goal on the cloud stack after the repair and record the
  result as a new dated checkpoint rather than editing this file.
