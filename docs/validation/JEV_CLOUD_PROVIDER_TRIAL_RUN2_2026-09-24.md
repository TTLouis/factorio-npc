# Jev Cloud Provider Trial, Run 2 — 2026-09-24

Follow-up to `JEV_CLOUD_PROVIDER_TRIAL_FINDINGS_2026-09-24.md`, repeating the same
goal after its repairs and the Jev input-contract changes.

## Scope and evidence

- Sandbox and stack as in run 1 (`scripts/stack-cloud.sh`, Factorio headless 2.0.77,
  zero connected players, fresh data directory).
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `2c87924`.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Kite-1` (`npc-1`), actor_id 10.
- Evidence: `sgluna-behavior.jsonl`, `sgluna-decision.jsonl` (now with
  `decision.exchange` records), `sgluna-prompts.jsonl`.

## Round

- Goal `goal_mufyj6zf`, request `req_mufyj6zd_1`:
  `!luna mine 10 stone and craft a stone furnace`.
- Plan: mine 10 stone; hand-craft 1 stone furnace; verify the furnace in inventory.
  Goal definition: `inventory_count stone-furnace >= 1`.
- Physical outcome: batch 1 mined 10 stone (inventory read: `stone` x10); batch 2
  crafted the furnace (inventory read: `stone-furnace` x1, `stone` x5).
- Harness outcome: `request.failed`, `semantic_completion_step_mismatch`, after
  8 provider calls (133,794 input units, 119,424 cached; 2,364 output units).

Run 1 for comparison: 10 calls, 159,997 input units, 6,911 output units, failed on
`semantic_completion_requires_runtime_grounding`.

## Run-1 repairs observed working

- No `decision.fallback` events (run 1 lost the whole planner-shape answer to a
  rounded `goal_scope` distribution). Seven Jev exchanges were recorded.
- Both post-step `targeted_observation` routes still had every relevance family below
  0.5; the observe-route floor admitted one read each time.
- Both times the planner asked for `getInventoryItems`, which the selected family
  (`recipe_production`) would have deferred. It was admitted as a completion-proof
  read, and the planner saw the real inventory.
- Steering at goal admission asked 2 pressure questions instead of 18, both with
  supporting `save_progress` facts; nothing like `machine_idle_no_input` was asked.
- No provider output-budget exhaustion.

## Finding 1 — the prompt's step id was rejected by the completion check

The last planner reply claimed `semanticCompletion` for
`goal_mufyj6zf_p2_v1_s1_1odt2b8`, the Plan Tracker id of the active step. The prompt
tells the planner to "use the stable active step id from [PLANNING_STATE]", but
`applySemanticCompletionClaim` compared the claim only with the Task Board
projection's id (`step_1`) and failed the request.

**Repair:** accept the Plan Tracker id when the tracker's active step and the Task
Board's active step are the same step. Any other id is still rejected.

## Finding 2 — step 1 stayed active while the craft ran (not changed)

As in run 1 (Finding 3) and `JEV_RCON_E2E_FINDINGS_2026-09-20.md` (Finding 1), the
verified mining receipt did not advance the canonical step, so the craft ran and was
recorded against step 1. The planner's first attempt to add a checkpoint was rejected
as an unsupported contract. This remains the next step-advancement issue to fix.

## Finding 3 — Jev relevance still ignores stale reads (not changed)

With `known_observations` marking the only inventory read as stale, Jev still rated
`need_inventory_equipment` at 0.27. The completion-proof rule made this harmless in
this round. Tune the wording with the offline replay proposal in
`NPC_JEV_COPROCESSOR_ARCHITECTURE.md` §16, using this round's recorded exchanges.

## Minor — exchange contract label

Post-step planner-shape exchanges were labelled with the gate's contract name because
both share one state object. Exchanges now take the contract from their
`decision.request`.
