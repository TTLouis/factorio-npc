# Jev Cloud Burner-Drill Canary, Attempt 2 — 2026-09-24

Follows `JEV_CLOUD_BURNER_CANARY_ATTEMPT1_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh map; empty NPC inventory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `e0c4797` (first-turn
  handoff keeps the goal and player request).
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Ember-1` (`npc-1`), actor_id 16.

## Round

- Same request as attempt 1. Jev again rated it `strategic`.
- The first turn spent 5,152 output units reasoning just to choose three reads
  (actor, inventory, nearby entities). The tools-off decision turn then spent all
  8,000 units reasoning and returned no content.
- The budget handoff now kept the goal: the fresh generation wrote the right outline
  (observe; gather and craft; place the drill on iron ore; place the furnace aligned
  to the drill output; fuel both; wait for 10 iron plates) and a goal definition of
  `inventory_count iron-plate >= 10`.
- But the fresh generation ran with tools off. It tried to re-observe (DeepSeek
  tool-call markup instead of JSON), then returned the outline with no operations.
  Strict recovery ended the request: `Provider strict recovery could not safely resolve
  remaining canonical work without a fresh normal tool-capable turn`. 5 provider calls
  (13,697 output units, 13,533 of them reasoning), no world action.

## Finding 1 — the handoff generation inherited a closed observation phase

The capsule replaces the conversation, so the fresh generation has none of the earlier
reads, yet it kept the previous turn's "observation phase closed" state.

**Repair:** a budget handoff resets the observation phase and restores the read
budget to at least the new-goal bootstrap minimum of 3.

## Finding 2 — heavy planning turns reason through every later step first

Both heavy turns spent their output on reasoning before emitting anything: 5,152 units
to choose three reads, then the full 8,000-unit cap. The planner was told how far to
plan (`planning_horizon`) but not that its whole reply, reasoning included, has a
fixed budget, or that later steps should stay coarse.

**Repair:** new-goal turns and turns Jev rates `deep` or `strategic` get a
`[PLANNING_LOD]` instruction: plan at outline level; before any reads, decide only
which reads are needed; write the goal definition, one short line per step (plus
Roadmap Shelf nodes for a long-horizon goal), and operations only for the active step;
refine each step when it becomes active. The 8,000-unit cap is unchanged.
