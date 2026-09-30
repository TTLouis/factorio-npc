# Macro provider usage: September 30 estimate note

Status: **measured short-run baseline plus illustrative extrapolations; no victory cost measured**.
No campaign limit or paid run is approved by this note.

## Meaning of the campaign allowance

One durable usage ledger and an owner-selected ceiling cover the Auto campaign's
planner, executor and Jev calls, including supporting work, interruptions and recovery.
This prevents new contexts/slices from erasing spending history. It is not a prepaid
allocation or a prediction of what winning costs. The amount, accounting unit and
warning threshold remain undecided. See [the macro design](../NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md).

## Measured baseline

Claude's `LIVE_DEEPSEEK_FLASH_2026-09-29.md`, inspected in its `jev-local-compose`
worktree at `8985f909`, records roughly CAD 0.55 of LLM usage across 146 direct-Flash
calls: 85 steam calls, 20 furnace/plate calls and 41 burner-drill calls. It used
off-peak rates and an approximate historical conversion of USD 1 = CAD 1.38.
This is about CAD 0.0038 per LLM call for that particular token mix.

That steam trial ended without electricity. The short scenarios also exposed goal
verification/transfer failures. No full base-game victory run is recorded, and the
new context delegation has not been priced in a fresh live run. Cheap calls are
not proof of useful progress or a known number of calls to win.

## Pricing checked September 30

[DeepSeek's official pricing](https://api-docs.deepseek.com/quick_start/pricing/)
lists Flash per million tokens in USD: cache-hit input 0.003 off-peak / 0.006 peak,
cache-miss input 0.15 / 0.30, and output 0.60 / 1.20. The current direct model is
`deepseek-flash`; the older V4-Flash name routes to V4.1-Flash. Provider billing windows
and actual cache hits must be taken from the applicable billing data.

[TypeSafe's Jev announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
lists USD 0.042 per million input tokens and no output charge. Jev has separate
metering; the recorded CAD 0.55 is not demonstrated to include its charges.

## Call-count scenarios, not forecasts of calls required to win

The table holds September 29's average token mix and historical currency conversion
constant. Peak values double the off-peak model rates. It does not include Jev,
hosting, development-model usage or retries beyond the stated call counts.

| LLM calls | Off-peak, approximate CAD | Peak, approximate CAD |
| --- | --- | --- |
| 1,000 | 3.8 | 7.6 |
| 5,000 | 19 | 38 |
| 10,000 | 38 | 76 |

For scale only, a Jev call with 5,000 input tokens costs about USD 0.00021 at the
listed rate; 10,000 such calls cost USD 2.10. Actual event frequency and state size
determine its cost. This is not a measured Jev bill or permission for frequent polling.

There is no defensible expected full-game call count yet. Late-game context sizes,
reasoning effort, caching, recovery loops, routing savings, terrain and enemies can
all change these figures. Do not describe CAD 19–76 as a quoted cost to beat the game
or select the campaign cap from it without owner input.

## Measurements needed for a useful victory estimate

Record successful output and total usage at cold-start power, automated red/green
science, oil/blue science and the rocket chain. Separate planned/executed steps,
verified production, recovery, cached/missed input and role/Jev calls. Establish
cost per verified milestone after the sequential delegation build, then estimate
the remaining campaign with explicit assumptions. Keep a separate allowance for
failed development trials if the owner chooses one; no amount is chosen here.
