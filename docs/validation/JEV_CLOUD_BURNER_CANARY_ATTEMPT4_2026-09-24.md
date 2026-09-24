# Jev Cloud Burner-Drill Canary, Attempt 4 — 2026-09-24

Follows `JEV_CLOUD_BURNER_CANARY_ATTEMPT3_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh map; empty NPC inventory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `cc1dd95`: console UI changes
  pulled from `experiment/jev-agent-architecture`, raised output brackets with the
  plan-authoring bracket, outline-level planning guidance, and the placement
  `covers_position` filter with placement reads in the fact tier.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Ember-1` (`npc-1`), actor_id 6.

## Round — passed, verified in the game

- Request `!luna build a burner mining drill on iron ore that feeds a stone furnace,
  fuel both with coal, and produce 10 iron plates`, 21:56 → 22:09:55 (about 14 minutes).
- The NPC gathered stone, coal and iron ore, crafted and placed a stone furnace, smelted
  15 plates by hand-feeding it, crafted 3 gears and a burner mining drill, moved the
  furnace next to the ore, placed the drill at (-103, 33) facing south and the furnace
  at (-103, 35), and fuelled both.
- The request ended `verified_complete`: `items_produced iron-plate` 41 (goal 10).
- Checked directly over RCON afterwards: the drill is mining `iron-ore`, its
  `drop_target` is the stone furnace at (-103, 35), and the furnace is working with 29
  plates in its output.
- 38 provider calls; 844,339 input units (528,384 cached); 120,470 output units
  (113,685 reasoning); no output-budget exhaustion; one per-generation cap handoff
  (103,525 > 100,000).

## Finding 1 — the placement candidate system crashed in the live game

Every `getPlacementCandidates` call failed with
`LuaEntityPrototype doesn't contain key rotatable` in `directions_for`. `rotatable` is a
`LuaEntity` field; Factorio objects raise on unknown keys, and the unit tests used plain
mocks, so the defect predates this series and never showed. The planner fell back to
hand-computed coordinates, which happened to be correct.

A probe of every prototype field the candidate code reads on 2.0.77 found `rotatable`
to be the only invalid one.

**Repair:** use `supports_direction` and the `not-rotatable` flag. A regression test
mocks the prototype as a strict object that raises on keys 2.0.77 does not have.

## Finding 2 — larger caps removed wasted retries but raised reasoning spend

| Bracket | Tools | Calls | Output units | Max |
|---|---|---|---|---|
| Jev normal | off | 8 | 37,749 | 11,846 (cap 12,000) |
| Jev normal | on | 8 | 24,639 | 7,301 |
| plan authoring | off | 3 | 19,611 | 11,461 |
| plan authoring | on | 1 | 17,228 | 17,228 |
| recovery continue | off | 2 | 7,749 | 7,414 |
| Jev micro | off / on | 14 | 13,115 | 3,140 |

No response exhausted its cap (attempt 3 had four). Total output rose from 56,306 to
120,470 units. Tools-off turns are again the largest share (about 65,000 units).
Not changed yet.

## Noted

- The goal definition (`items_produced iron-plate >= 10`) counts plates smelted before
  the drill existed; the drill-to-furnace link was verified by the planner's reads and
  the RCON check above, not by a goal condition.
