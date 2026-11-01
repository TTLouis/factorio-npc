# Jev Cloud Provider Trial, Run 5 — 2026-09-24

Fifth round of the same goal; follows `JEV_CLOUD_PROVIDER_TRIAL_RUN4_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh data directory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `c914873`.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Vale-1` (`npc-1`), actor_id 5.

## Round

- Goal `goal_mufzk46k`, request `req_mufzk46j_1`:
  `!luna mine 10 stone and craft a stone furnace`.
- Goal definition needed two corrections, both now named precisely
  (`needs the field "item_name"; it has "item", "min"`, then `minimum`), and was
  accepted on the third attempt: `inventory_count stone-furnace >= 1`.
- Plan (in Chinese): mine 10 stone; hand-craft 1 stone furnace.
- The implied completion claim closed step 1 when the planner moved to the craft.
- After the craft, a completion-proof read (`getCraftingStatus`) and an inventory read
  showed `stone-furnace` x1, `stone` x5. The planner said done, and step 2 closed
  through the final-completion path.
- Harness outcome: `request.completed`, both steps completed, after 8 provider calls
  (124,047 input units, 93,056 cached; 1,935 output units). No Jev fallbacks and no
  invalid Jev answers.

First run in this series that completed.

## Finding 1 — the goal definition was never checked in the game

The final-completion path (planner `plan: []` on the last step with grounded
evidence) recorded the plan complete and ended the request, but never evaluated the
goal's `done_when`. No `goal.evaluated` event was written. The answer was right only
because the furnace was really there. A replay against a fake game with an unmet
condition reported `[Plan complete] Done` while the goal stayed active and nothing
continued it.

Root cause: after the plan completed, `ensurePlanningDraft` saw a COMPLETED active
plan with an active goal and minted a new DRAFT from the finished legacy task board,
copying completed steps. The settle step then saw a DRAFT instead of a completed plan
and skipped the goal check.

**Repair:**

- The final-completion ending now settles the goal against the game when it has a
  definition: met → goal satisfied and a verified-complete reply; unmet → one extra
  planning turn with the unmet conditions, and a second "done" without work ends
  with an honest "goal not met yet" reply and the goal still active.
- `ensurePlanningDraft` no longer mints a draft from a legacy state that is itself
  completed; the next slice comes from the planner's next submission.

## Noted, not changed

- The planner still answered in Chinese to an English request, despite the new prompt
  line. A deterministic reply-language hint derived from the player's message would be
  the next step if this matters.
