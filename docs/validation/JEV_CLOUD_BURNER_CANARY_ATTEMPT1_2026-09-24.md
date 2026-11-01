# Jev Cloud Burner-Drill Canary, Attempt 1 — 2026-09-24

First provider-backed attempt at the production canary from `AGENTS.md`, after the
stone-furnace series (`JEV_CLOUD_PROVIDER_TRIAL_RUN8_2026-09-24.md` and earlier).

## Scope and evidence

- Same sandbox and stack; fresh map and data directory; the NPC starts with an empty
  inventory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `ad6d300`.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Mira-1` (`npc-1`), actor_id 27.

## Round

- Request `!luna build a burner mining drill on iron ore that feeds a stone furnace,
  fuel both with coal, and produce 10 iron plates`.
- Jev rated the goal `strategic`, which maps to maximum reasoning effort with an
  8,000-unit output cap.
- The planner asked for five reads; three ran (actor, inventory, nearby entities) and
  two long-range searches were deferred. The exhausted read budget closed the
  observation phase.
- The tools-off decision turn spent all 8,000 output units on reasoning and returned
  no content (`finish_reason: length`, 45 s).
- The harness handed off to a fresh planner generation. The handoff capsule had
  `goal: null`: on the first turn of a new goal no plan had been stored yet, and the
  capsule replaces the whole conversation.
- The fresh generation replied that it had no pending goal and asked what to do. The
  harness accepted the empty plan and ended the request `no_operations`: the player's
  goal was dropped silently. 3 provider calls, about 1 minute, no world action.

## Finding 1 — a budget handoff on the first turn dropped the goal

**Repair:** when no plan is stored yet, the handoff capsule carries the goal already
admitted in the planning state (marked `first_plan_of_goal`) and the player's
original request.

## Finding 2 — strategic effort can exhaust the output cap on deepseek-flash (not changed)

Maximum effort with an 8,000-unit cap produced reasoning only. With Finding 1
repaired, the handoff continues at low effort with the goal intact, so this costs
8,000 wasted output units rather than the goal. Revisit if it recurs.

## Finding 3 — discovery floor is per batch (not changed)

`getNearbyEntities` used the batch's one discovery admission, so the two
`findLongRangeEntities` searches for ore were deferred. Watch whether the planner
lacks resource locations in later attempts.
