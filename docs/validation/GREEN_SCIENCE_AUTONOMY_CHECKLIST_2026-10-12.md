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
- **This week's port** (units 1, 2a and 2b, pushed; 2c merged and repinned; unit 3 merged, `572d4600`): native admission fixes, power and fluid facts, provider timeout diagnostics, declared refusal classes, historical water anchors and recipe closure.

## Checklist

| # | Item | Status |
|---|---|---|
| 1 | Unit 2c: refusal classes replace the loop's code lists | Done: merge `e818d83a`, repin `ce4b025e`, gate green, lane PASS |
| 2 | Unit 2 docs: status doc and port-plan build status (Haiku) | Done (this commit) |
| 3 | First GPT-6 proxy live run on the current build, cold start, objective "research logistic science" | Done 2026-10-13 (run c, `572d4600`): paused at step 1 on an unverified copper-ore blocker; see LUNA_GPT6_PROXY_LIVE_RUN_C_2026-10-13.md |
| 4 | Turn each live finding into a design fix plus a static fixture | In progress: unit 6 (raw-leaf facts) and run C recovery merged; run F and G findings addressed by units 7 to 12 (merged, static and engine lanes); live confirmation in run H |
| 5 | Unit 3: active-step fact handoff (port plan) | Done: merge `572d4600` (3a water anchors, 3b recipe closure; 3c deferred) |
| 6 | Unit 4: dependency-aware batch stock accounting | Done: merge `0708bd4b`, fresh recipe integration `16138b9a`. Combined gates green |
| 7 | Repeat runs (one per window) until green science is researched autonomously, verified from world state and logs | Open. Run H is ready on `7f8d0021` (units 7 to 12, gate green, four engine lanes passed); waiting for the owner's go or the next allowance window |
| 8 | Unit 7: pause classes and model-recoverable auto-resume | Done: merge `89eb30a5`, repin `9d86ec39`. First live auto-resume in run G |
| 9 | Unit 8: executor targeted reads, trigger production, machine energy and burner fuel facts | Done: merge `e695d251`. Static and engine lanes; not live-validated |
| 10 | Unit 9: entity_count contracts, build bills, science residual, harvest sources, trigger readiness | Done: merge `26814155`, fix-forward `ec6b8385`. Candidate `ec6b8385` gate and four engine lanes passed; not live-validated |
| 11 | Unit 10: fluid-port placement, nearest-first water, electric prototype facts | Done: merge `b45d9f7f`. Candidate `ec6b8385` lanes passed; not live-validated |
| 12 | Unit 11: transport cause codes and durable intake retry | Done: merge `010e84a7`. Static scenarios only; not live-validated |
| 13 | Unit 12: world-refusal correction turn and declared terminal pause | Done: merge `9501a5fe`, engine fixture `7f8d0021`. 2291 runtime tests and four engine lanes passed; not live-validated |
| 14 | Live run F (`ec6b8385`): provider DNS failure at goal intake | Done 2026-10-14: no gameplay. Led to unit 11. See LUNA_GREEN_LIVE_RUN_F_2026-10-14.md |
| 15 | Live run G (`ec6b8385`): first live auto-resume, then a silent world-refusal stall | Done 2026-10-14: unit 7 auto-resume seen live; the stall led to unit 12. See LUNA_GREEN_LIVE_RUN_G_2026-10-14.md |

Acceptance: `logistic-science-pack` researched with `by_script=false`, zero operator operations, zero
humans, game speed 1, and evidence in the structured logs (`run-check.mjs`).
