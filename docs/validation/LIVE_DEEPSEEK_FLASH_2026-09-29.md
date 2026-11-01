# Live DeepSeek flash run, 2026-09-29

This was one owner-approved live run in DeepSeek's off-peak window, with a budget of 1–2 CAD. It used the local Docker stack on a fresh world, with Jev on and the model called directly as `deepseek-flash`.

**Images:**
- `79d56e73` for the first 43 minutes.
- `580d85e3` after the mid-run fixes. The goal was restored from the persisted state, not restarted.

**What was tested:**
1. How one long goal is divided into roadmap stages and plan slices.
2. Two short scenarios, each from a cold start.

**Spend:** 0.55 CAD in total, measured with the run record (`think-time-report.mjs --prices`). The prices were converted from USD at about 1.38 CAD per USD, so the figures are approximate. Prices used, per 1M units: input 0.207 on a cache miss, 0.0042 on a cache hit; output 0.828.

| Run | Goal | Provider calls | Verified steps | Input (cached) | Output (reasoning) | CAD |
|---|---|---|---|---|---|---|
| 1 | get steam power going and run an electric mining drill on iron ore | 85 | 8 | 2.27M (69%) | 293k (96%) | 0.394 |
| 2 | craft a stone furnace and smelt 10 iron plates | 20 | 5 | 468k (73%) | 53k (95%) | 0.072 |
| 3 | place a burner mining drill on iron ore, fuel it, and collect 10 iron ore from it | 41 | 6 | 1.02M (79%) | 51k (88%) | 0.090 |

## Run 1: one long goal

**First plan:**
- It took 99.9 s, one round of 93 s at `max` reasoning, with 17k reasoning tokens.
- The goal definition was long_horizon, with done when: steam-power research, 1 steam engine produced, 1 electric mining drill produced.
- Jev's blind reading said `finite` at 0.34 confidence.
- The model wrote a 3-node roadmap: raw supply, then steam capability, then a powered drill.
- **The roadmap was lost** (finding 1). The goal ran with no roadmap stages at all.

**Slice 1 (4 steps: supplies, smelting, burner drill, drill on coal):** all 4 verified in 7 minutes.
- The time estimates were close: hand mining measured 2.02–2.08 s per item against the 2 s formula.
- Steps that include walking ran 1.3–1.6× their estimates. Walking is excluded from the estimates by design.

**Slice boundary:**
- The last step's completion claim arrived together with next-slice operations.
- The request failed and did not recover. No next slice was planned until the player typed "continue" (finding 2).
- After "continue" the model planned slice 2 correctly and found the steam-power research trigger (craft 50 iron plates) through `getResearchPath`.

**Blocked, then revised:**
- A coal supply failed with `item_missing`.
- The model's recovery idea was right (feed wood, gather coal), but it arrived as raw tool-call text instead of plan JSON (finding 3).
- The retry repeated the failed supply, and the plan was blocked with no chat line (finding 4).
- A chat revision from the player ("gather 40 coal first…") went through the Revise flow. A 6-step revised plan was active 3 minutes later.

**Steam build:**
- Three more steps were verified, the steam-power research trigger was completed, and a boiler was placed.
- At the steam build itself every reply ran out of output budget before producing a plan (finding 5).
- The model chose `place_candidate` and was refused it (finding 6).

**Restart:** after the image rebuild the board went back from 4 of 6 completed steps to 1 of 6 (finding 7).

It was stopped at 10:53 with no electricity. This matches the pre.2 hypothesis that a model stronger than flash is needed for electricity.

## Runs 2 and 3: short scenarios, each from a cold start

- **Run 2:**
  - All 5 steps were verified in 3.3 minutes, and it really did craft the furnace and smelt 12 plates.
  - But the goal check reported `items_produced stone-furnace: 0` (finding 8), so the goal stayed open and the NPC kept planning.
  - The final chat line came back in Chinese although the request was in English (finding 9).
- **Run 3:**
  - 6 of 7 steps were verified: gather, craft, place the drill, fuel it, mining running.
  - The last step took ore from a furnace that the drill feeds. The furnace had turned the ore into plates, so nothing moved, and the plan was blocked `transfer_failed:nothing_moved`.
  - This is a model planning error, and a blocked plan is a strict response to it.

## Findings

| # | Finding | Status |
|---|---|---|
| 1 | Roadmap nodes sent as `{id, text}` were all dropped: the sanitizer needs `intent`. The prompt never named the fields, and on a tools-off round the model does not see the submitPlan schema. The long-horizon check counted raw entries, so it passed. A false `provider_content_schema_invalid` was also logged on every goal or roadmap plan. | **Fixed** in 5843dcfc |
| 2 | A final-step completion claim sent together with next-slice operations failed the request with no recovery. The slice showed complete, but nothing planned the next one. The no-operations claim on a defined goal had the same stall. This is exactly checkpoint C1 in the delegation design. | **Fixed** in 8cbfd716 + e550eb1f (merged in 580d85e3). The operations are dropped and traced, the slice settles within the same request, and a chain cap limits repeats. |
| 3 | On tools-off rounds, flash writes tool calls as DeepSeek's native tool-call text (`<｜DSML｜…>`) inside content, and it is rejected as invalid JSON. A good recovery plan was lost this way. | Open. Evidence for the pending `tools_kept_when_closed` decision, or for converting those calls into plan JSON. |
| 4 | A blocked plan, and a failed request, end with an empty chat_message, so the player gets no chat line. run-check flagged it 4 times. | Open |
| 5 | At the steam build every reply ran out of output budget (`finish=length`) at every effort level: 8k low, 12k high, even 40k max. All of the budget went to reasoning. | Open. Candidate for a stronger model, the wave 5 question. |
| 6 | `place_candidate` was advertised in the prompt but refused as "Unapproved operation". `parsePlanMessage` used the staging parser, whose operation list lacks it. | **Fixed** in 580d85e3 |
| 7 | After a restart the board showed 1 of 6 completed steps; before the restart the legacy board had 4. Steps closed on the revised plan (`step_2_r10` and so on) were recorded only on the legacy board, not in the reducer. This is the tracker lag of 3.8, with live evidence. | Open. It is 3.3 move 5 / 3.8. |
| 8 | `items_produced` did not count the NPC's hand-crafted stone furnace (0), while furnace output did count (12 plates). Production statistics apparently don't count crafting by a character with no player. A goal defined by "produce X" for a hand-craftable X can then never complete. | Open. Needs an engine-lane check, then a counter the harness keeps itself, or a different goal condition kind. |
| 9 | A model reply in Chinese to an English request. | Open, low |
| 10 | Each post-step continuation restates the whole plan. The effect on step text is shown in the trace, but the committed plan stays immutable (`step.checkpoint_change_ignored`). | Known (tool audit, finding 8) |

## Evidence

Traces and state from all three runs (behavior, prompts, decision, npc-state, saves) are kept in the local session scratchpad and were not committed. Tools used: `run-check.mjs` and `think-time-report.mjs`.
</content>
</invoke>
