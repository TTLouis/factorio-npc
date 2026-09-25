# Jev Cloud Burner-Drill Canary, Attempt 3 — 2026-09-24

Follows `JEV_CLOUD_BURNER_CANARY_ATTEMPT2_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh map; empty NPC inventory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `f76d9fa` (outline-level
  planning guidance; observation phase re-opened after a budget handoff).
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Kite-1` (`npc-1`), actor_id 11.

## Round

- Same request as attempts 1 and 2. The first tools-off turn again spent the full
  8,000-unit cap reasoning, although `[PLANNING_LOD]` was present; the handoff now
  continued with the goal and with tools.
- The NPC then worked for about 8 minutes: 4 of 7 steps closed; it gathered
  materials, crafted and placed a stone furnace, and loaded it with 5 coal and
  9 iron ore to smelt plates for the drill.
- At step 5 (placing the drill and aligning the furnace), post-step decisions got a
  read budget of 1 with `placement_candidates` selected. The observation phase closed
  after one read, and three tools-off turns in a row exhausted their output caps
  (5,000, 3,000, 3,000 units). One generation also crossed the 20,000-unit
  per-generation cap. The fourth budget handoff hit the limit and the goal was paused
  as a recoverable provider failure at 21:19.
- 34 provider calls, 56,306 output units. No Jev fallbacks.

## Finding 1 — tools-off turns cost two-thirds of the output and every blowout

| Turn type | Calls | Output units | Average | Max |
|---|---|---|---|---|
| tools on | 18 | 19,164 | 1,064 | 2,886 |
| tools off | 16 | 37,142 | 2,321 | 8,000 |

All four output-budget exhaustions were tools-off decision turns. Closing the
observation phase was meant to bound rounds, but a planner that still lacks a fact
reasons around it for far longer than a read round costs. The placement step needed
several spatial reads; Jev's budget of 1 plus the one-discovery-read floor left it
blind. Not changed yet: this is a design change to discuss.

## Finding 2 — the recoverable pause wrote no terminal trace event

After `budget.handoff_limit_reached` the request ended paused, but only
`planner.skipped` was traced, so the run read as stalled for 20 minutes.

**Repair:** the pause-recoverable and ask-user recovery endings emit
`request.completed` (`paused_recoverable`, `asked_user`); the wait-runtime ending emits
`request.waiting`.

## Also

- Before the next run the branch was fast-forwarded to
  `experiment/jev-agent-architecture` (`2b81588`) for the console UI changes. Runtime
  (878) and Autorio (749) tests passed.
