# Jev Burner-Drill Canary, Attempt 5 — 2026-09-25

Follows `JEV_CLOUD_BURNER_CANARY_ATTEMPT4_2026-09-24.md`.

## Scope and evidence

- Local Windows + Docker Desktop stack (`compose.yml` + `compose.e2e.yml`), not the
  cloud sandbox. Cold start: stack stopped, `npc-state.json` and every save moved to a
  backup outside the repo, world regenerated.
- Source: `experiment/jev-agent-architecture` at `645a8cc` (`SGLUNA_SOURCE_REF`, full
  no-cache rebuild). Checked that the deployed `npc-agent-loop.mjs` and `supervisor.mjs`
  are byte-identical to that commit.
- Main LLM `deepseek-flash`; decision provider `jev-latest`.
- Actor: standalone character `Aster-1` (`npc-1`), actor_id 7, empty inventory,
  `NULL_BOARD` before the goal.
- Same request as attempt 4:
  `!luna build a burner mining drill on iron ore that feeds a stone furnace, fuel both
  with coal, and produce 10 iron plates`.

## Round 1 — failed before the plan was committed (environment defect)

- 03:55:17 goal `goal_mugfgtho` admitted (new goal_id; steering `maintain`).
- Round 0 (tools on) read the NPC's inventory, its status and nearby iron ore.
- Round 1 (tools off, plan authoring) spent 94 s and 18,863 output units, 18,279 of
  them reasoning. The plan's `doneWhen` used `entity_exists`, which isn't a valid goal
  condition kind; ordinary recovery asked for a correction.
- Round 2 returned a valid plan (1,878 output units). The generation total was then
  21,270 units, over a 20,000 cap, so the request failed with
  `provider_turn_output_cap_exceeded` and `recoverable: false`. The board stayed
  `idle` with 0 steps.
- 3 Main-LLM calls: 44,235 input units (40,576 cached) and 21,270 output units (20,011
  reasoning). Jev made 3 decisions: interaction route, planner shape and goal-admission
  steering.

### Finding 1 — Compose did not pass the per-generation output cap

The runtime default is 100,000 (`11d00b1`), and the Pterodactyl eggs set 100,000.
`compose.yml` didn't pass `MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN` at all, so the
supervisor fell back to the persisted `data/sgluna-config.json`. That file had been
written locally on 2026-09-19 with 20,000. Attempt 4 ran in the cloud sandbox with the
default and never met this cap.

The local `.env` also still had `PROVIDER_TIMEOUT_MS=120000`, while the current default
is 300,000. The 94 s plan turn fit inside that, but a 32,000-unit plan-authoring reply
might not.

**Repair:** `compose.yml` now passes `MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN` (default
100000), and both `.env` examples list it. A test in `build-payload.test.mjs` fails if
Compose stops passing any of the egg's provider budget variables
(`PROVIDER_TIMEOUT_MS`, `MAX_PROVIDER_REQUESTS_PER_HOUR`,
`MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN`) or gives one a different default. The local
`.env` now sets 300,000 ms and 100,000 units. The runtime was unchanged, so no rebuild
was needed.

### Finding 2 — the planner again reached for an entity goal condition

As attempt 4 noted, the goal conditions can't express "a drill feeds a furnace". This
time the planner tried to express it anyway, with `entity_exists` for both machines,
and paid for a correction turn. This isn't fixed; adding a checkable entity or link
condition is a product decision.

## Round 2 — the harness reported `verified_complete`, but the canary failed

Approved by the owner. Cold start again (saves and state backed up), source
`023107c`. Its runtime is the same as `645a8cc`'s plus the nearby-ordering and
map-reference changes. `MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN=100000` and
`PROVIDER_TIMEOUT_MS=300000`, confirmed in the container. The deployed runtime is
byte-identical to `023107c`. New actor `Nova-1`, actor_id 11, empty inventory,
`NULL_BOARD`, same request.

- 04:36:09 request, 04:40:21 goal `goal_muggxdy1` defined. `doneWhen`:
  `inventory_count iron-plate >= 10` and `items_produced iron-plate` (baseline 0).
  The plan had 8 steps.
- The NPC gathered, crafted and placed a stone furnace as a hand-fed smelter
  (04:43), then smelted plates, crafted the drill, and placed it at (-59.5, 59.5)
  facing west (04:51). It computed that position itself; it never called
  `getPlacementCandidates` and never read the drill's drop target.
- 04:54:02 `verified_complete`: 21 plates in inventory, 30 produced.
- 40 Main-LLM calls: 916,557 input units (626,944 cached), 159,417 output units
  (153,015 reasoning), 38 tool calls. The per-generation cap tripped once
  (109,901 > 100,000) and was handed off three times in total. There was no pause.

### Checked in the game afterwards: the drill does not feed the furnace

- Drill at (-59, 60), facing west, mining `iron-ore`, 4 coal: `drop_target` is
  nil and its drop position is (-60.3, 60.5), on the ground. One ore lies there, so
  the drill is `waiting_for_space_in_destination`.
- Furnace at (-62, 59): 12 coal, empty source and output, `no_ingredients`.
- Every plate came from hand-feeding the furnace.

**Result: fail.** By attempt 4's pass criterion (the drill's `drop_target` is the
furnace, and it works) this round failed, even though the harness verified the goal.
The goal conditions check counters that hand-feeding satisfies. This is the case
behind the owner's production-rate goal decision (`docs/NPC_PLANNING_ROADMAP.md`,
"Production goals are rate goals"). A measured automated rate would have stayed
unmet here, and a `feeds` observation would have shown the planner the missing
link. The planner also didn't use the placement candidates that attempt 4's repair
made work.
