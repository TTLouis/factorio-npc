# Green-science autonomy checklist (2026-10-12)

Owner goal (2026-10-12): the system reaches at least green science on its own, under the owner's
rules. Those rules are:

- Fix the system; don't add patch lists.
- Steer with facts, not prompt advice.
- No pre-baked build orders.
- Static fixtures are the default gate.
- At most one agent-started live e2e per 5-hour window, only after the window is more than 60% used, through the CLI proxy with GPT-6 as Luna's model.
- Use Sonnet 5.5 and Haiku 5.5 subagents.

## What is already proven

- **Mechanics, in the real engine.**
  - Steam power: `steam_power_cell.py`, since 2026-09-29.
  - Powered assembler: `powered_assembler_cell.py`.
  - Research: `research.py`, `research_followthrough.py`.
- **Guided runs to green science.** On 2026-10-05 and 2026-10-06, an operator finished each run through Luna's native operations. The model planned only the early steps.
- **Furthest autonomous run.** Haiku trial C (2026-10-08): 9 steps, red science unlocked, then a pause on a semantic smelting step. The fixes for that pause are static-only and have not been tested live:
  - minimal MW5 recovery;
  - step identity by text;
  - just-in-time step contracts.
- **This week's port** (units 1, 2a and 2b, pushed): native admission fixes, power and fluid facts, provider timeout diagnostics.

## Checklist

| # | Item | Status |
|---|---|---|
| 1 | Unit 2c: refusal classes replace the loop's code lists | Reviewed, follow-up in progress (`invalid_name`, `unknown_technology` → argument; guard regex). Then merge, gate, lane, **installer repin** (`refusal-class.mjs` is now copied), push |
| 2 | Unit 2 docs: status doc and port-plan build status (Haiku) | Pending |
| 3 | First GPT-6 proxy live run on the current build, cold start, objective "research logistic science" | Waiting for the 5-hour window to pass 60%. Evidence goes in a new `docs/validation/` checkpoint |
| 4 | Turn each live finding into a design fix plus a static fixture | Pending run 3 |
| 5 | Unit 3: active-step fact handoff (port plan) | Not started; reprioritize after run 3 |
| 6 | Unit 4: dependency-aware batch stock accounting | Not started; reprioritize after run 3 |
| 7 | Repeat runs (one per window) until green science is researched autonomously, verified from world state and logs | Open |

Acceptance: `logistic-science-pack` researched with `by_script=false`, zero operator operations, zero
humans, game speed 1, and evidence in the structured logs (`run-check.mjs`).
