# Jev Cloud Provider Trial, Run 4 — 2026-09-24

Fourth round of the same goal; follows `JEV_CLOUD_PROVIDER_TRIAL_RUN3_2026-09-24.md`.

## Scope and evidence

- Same sandbox and stack; fresh data directory.
- Source: branch `claude/docker-cloud-e2e-setup-psv6kx` at `3c2f30b`.
- Main LLM `deepseek-flash`; decision provider `jev-latest` (`jev-1.13.0`).
- Actor: standalone character `Cinder-1` (`npc-1`), actor_id 11.

## Round

- Goal `goal_mufz3rxd`, request `req_mufz3rxb_1`:
  `!luna mine 10 stone and craft a stone furnace`.
- The planner observed inventory, recipe, and nearby entities, then answered in
  Chinese although the player wrote in English.
- First plan: no goal definition → corrective retry (`goal_definition_required`).
- Second plan: `doneWhen: [{kind: "inventory_count", item: "stone-furnace", minimum: 1}]`
  → `invalid_goal_condition`: "goal.doneWhen inventory_count.item_name must be an exact
  Factorio internal name". The field was missing, not misspelled.
- That was the second failure, so the runtime stopped and asked the player to restate
  the goal. No world action ran; 3 provider calls.

## Finding 1 — the "ask the player" ending wrote no terminal trace event

`blockedWithoutMutation` returned the restate-the-goal message but emitted no
`request.completed` or `request.failed`, so the behavior trace looked like a stalled
request. The persisted state showed the goal active with no plan.

**Repair:** emit `request.completed` with `outcome: blocked_before_mutation`, the chat
message, the blocker, and usage.

## Finding 2 — a misleading correction and a one-retry budget ended the goal

The correction named the wrong problem, and the second of two different mistakes used
up the only corrective retry.

**Repair:** a missing field now reads
`goal.doneWhen inventory_count needs the field "item_name"; it has "item", "minimum"`.
A repeated identical mistake still stops at once; different mistakes get up to two
corrective retries.

## Finding 3 — reply language drift

The player's message was English; the planner's chat and plan were Chinese. The prompt
had no language rule. **Repair:** one prompt line: write chatMessage and plan steps in
the language of the player's message.
