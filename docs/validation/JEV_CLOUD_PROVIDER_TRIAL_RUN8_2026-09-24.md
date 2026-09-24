# Jev Cloud Provider Trial, Run 8 — 2026-09-24

Eighth round of the same goal; follows `JEV_CLOUD_PROVIDER_TRIAL_RUN7_2026-09-24.md`.
First round with tiered observation admission and the spelled-out `doneWhen` fields.

## Scope and evidence

- Same sandbox and stack; fresh data directory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `ad6d300`.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Luma-1` (`npc-1`), actor_id 21.

## Round — passed

- Goal `goal_mug0fk8d`, request `req_mug0fk8b_1`:
  `!luna mine 10 stone and craft a stone furnace`.
- The first plan omitted the goal definition (one correction); the second was
  accepted with no field errors: `items_produced stone >= 10` and
  `inventory_count stone-furnace >= 1`. Runs 4, 5 and 7 each needed two field
  corrections; this definition also reads the request correctly (stone mined, not
  stone still held).
- Tiered admission: at goal start `findLongRangeEntities` ran within Jev's budget
  and `getRecipeDetails` was admitted as a fact read past it. After mining,
  `getInventoryItems` was admitted as a fact read although Jev selected only
  `recipe_production`; after crafting, `getCraftingStatus` likewise. Each time the
  exhausted budget then closed the observation phase.
- The implied claim closed step 1 when the planner moved to the craft.
- After the craft the planner said done with the verify step open. The game reported
  `2/2 goal conditions met` (stone produced 10, furnace held 1) and the request ended
  `goal_verified_complete`.
- 9 provider calls (146,795 input units, 125,696 cached; 1,553 output units), 8 tool
  calls, no Jev fallbacks.

## Noted, not changed

- **DeepSeek tool-call markup in tools-off turns.** As in run 3, one reply in a
  tools-off decision turn was prose plus DeepSeek's internal
  `<｜｜DSML｜｜ invoke name="craft_item">` markup instead of JSON. Generic recovery
  absorbed it with one extra call. This happens when the observation phase closes and
  the model still wants to act through a tool.
- The planner's chat stays in Chinese for an English request.
