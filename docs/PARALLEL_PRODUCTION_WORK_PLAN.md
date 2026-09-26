# Parallel production and thinking time: work plan and checklist

Owner direction, 2026-09-25. This file tracks progress across sessions. Tick items
as they land and put each item's commit next to it.

## Why

In the 100 iron + 100 copper plate test, the NPC built one burner drill and one
furnace per metal. It worked, but it was slow: at game-data rates one burner drill
mines 15 ore/min, so about 7 minutes for 100 plates, and scaling out would have cut
that to 2. The owner would scale out from the very start, and the lack of it makes
progress feel slow and unrewarding, early and mid game.

The NPC built one pair because nothing it saw made more pay off:

- the goal was a count with no time pressure;
- it doesn't see any machine rates or time estimates;
- the skill library has no scale-out pattern.

Meanwhile the LLM's own thinking has become the slowest part of the loop. After the
reasoning budgets went up, each tool round in one request took 40–55 s (live trace,
2026-09-25 15:05–15:07), and one round spent its whole output budget thinking.

## Rules for this work

- Same rules as before: doc it, fix it, test it. Add tests to existing files and
  lanes, no new CI jobs. Test in Docker (`npc-dev` image / `tests/factorio`), not on
  Windows. Build and deploy from local sources only.
- **No hard-wired strategy**. The harness
  supplies facts computed from game data (rates, times, estimates) and generic
  mechanics. How many machines to build, and when to scale out, is the LLM's call,
  guided by skills in the skill library.
- Rates come from prototypes and measured statistics only. No unvalidated
  inserter/belt throughput (AGENTS.md).
- No provider (API) runs without asking the owner first.
- Pace usage: stop starting new work at 70% weekly / 85% of the 5-hour window.

## P0 — placement ignores the size of the entity being placed (owner, 2026-09-25)

Goes before everything below, including the rest of W2. Owner report: "the
placement solver does not actually calculate the size of the entity it is placing
down".

**Live case (req_muh5t1wa_1, 16:15, goal "automate coal with only burner
drills").** Drill A came from `findPlacementCandidates` and was placed correctly at
(-70, -9); its drop position is (-70.5, -10.3). For drill B, whose output should
land in A, the planner passed A's drop point as B's *centre*:
`place burner-mining-drill (-70.5, -10.5) direction 8`. A burner drill is 2×2, so
its centre must sit on whole coordinates, and a 2×2 footprint around that point
overlaps A. The engine refused (`placing:not_placeable`), the harness passed that
on with no reason, and the plan blocked (`transfer_failed:not_placeable`). The
right tool existed (`findPlacementCandidates` with `covers_position`, which does
check the footprint), but nothing steered the planner to it, and a raw centre was
accepted without any footprint handling.

What the code does today:

| Path | Size handling | Problem |
|---|---|---|
| `place_entity` op (`basic_operation_runtime.ts`) | none; `can_place_entity` at the given centre | a point meant to be *covered* is treated as the centre; off-grid centres for even-sized entities; `not_placeable` gives no reason (blockers, grid, footprint) |
| `findPlacementCandidates` (`placement_candidates.ts`) | `tile_width/height` for grid snapping, `covers_position`, `can_place_entity` | grid offset isn't swapped for rotated non-square entities; candidates don't return their footprint, so the planner can't reason about spacing between several machines |
| `plan_placement` (`construction_planning.ts`; remote + combat) | none in the search | `snap_center` always snaps to x.5 (wrong for 2×2, i.e. most early machines); "side of anchor" compares centres, ignoring both footprints; the ring search starts inside the anchor's footprint; the future-extension check uses a fixed 2 tiles; blockers are searched in a fixed 1.5 radius |
| construction ghosts (`construction_execution.ts`) | rotated collision box | reports `world_collision_box`; not checked further here |

Fix list (deterministic geometry only; the planner still chooses where):

- [x] One shared footprint helper from the prototype (`tile_width/height`,
  `collision_box`, rotation swap): valid grid for the centre, world box for a centre
  + direction, and "centres whose footprint covers point P". `032d02e` (`placement_geometry.ts`)
- [x] `place_entity`: snap to the entity's grid only when unambiguous; otherwise
  refuse with the reason. `not_placeable` reports the footprint box tried, what
  collides inside it, and the grid rule. Never move an entity silently to a
  different spot than the planner asked for. Off-grid centres are refused with the nearest valid centre, never moved; collisions list the entities inside the footprint; both survive the runtime receipt. `8c2ceca`, `dc9c951`, `462aa27`
- [x] Let placement target a relation instead of a centre (e.g. place so the
  footprint covers a point / receives another entity's output), resolved by the
  candidate search, and point the planner guidance at it for "output into X"
  placements. Done as guidance, not a new operation: the `planPlacement` description says to use `getPlacementCandidates` with `covers_position` for output/drop-point relations and execute the candidate id. `f01a7db`, `3ee3706`. Whether the model follows it is a wave 5 live check
- [x] `findPlacementCandidates`: rotation-aware grid offset; return each
  candidate's footprint (tile size + world box). `8eddeb7`, `d69dd0e`, `45b103b`
- [x] `plan_placement`: size-aware snapping, side and ring search from footprint
  edges, extension clearance from the entity size, blockers inside the footprint. `8c2d5f4`, `980e2a0`
- [x] Engine lane: the self-feeding burner drill pair (B's footprint covers A's
  drop point and vice versa) built through the tools, plus off-grid and overlap
  refusals with their reasons. Unit tests alone are not proof here. Production lane green at `27ab40d` (2.0.77): OFF-GRID, OVERLAP (drill A named as blocker) and RECIPROCAL. `drop_target` stays nil for drill → drill, so the loop is proven by outcome: both drills refuel each other (5 → 6 coal). `63fec8a`, `e5552ee`, `27ab40d`
- [x] Off-grid centres snap instead of failing (owner call, 2026-09-25). An
  engine probe on 2.0 showed scripted placement always lands on the grid:
  `create_entity` snaps (odd sizes take the tile under the point, even sizes the
  nearest tile corner) and the default `can_place_entity` checks the snapped
  spot, which is the same rule as `snap_placement_center`. So `place_entity`
  snaps the centre itself and the receipt keeps `requested_position` beside
  `placed_position`. The probe also showed `create_entity` does not test
  collisions and the `script` build check accepted a chest on a chest, so the
  default build check stays. Lanes: core places a chest at an off-grid point on
  the tile under it; production's OFF-GRID case now snaps A's drop point onto A
  and is refused with A named.

## W0 — bugs from the 2026-09-25 container log (do first)

- [x] **… button crashed the server.** `vertical_spacing` set on a frame (the …
  menu and, latent, the blocked banner). Fixed, with a regression test and a test
  GUI stand-in that rejects spacing on frames like the engine does. `0fbd0d78`
- [x] **B1 Provider HTTP 400 after an output-budget exhaustion.** Round 5
  (`ordinary_planning`, high) ended with `finish_reason: length`; the
  `jev_recovery_continue` request that followed sent an assistant message with
  `tool_calls` and no matching tool replies, and DeepSeek rejected it
  ("insufficient tool messages following tool_calls message"). The goal paused.
  Fix: whatever history a recovery path builds, every assistant `tool_calls` entry
  is followed by a reply for each `tool_call_id`, or the unanswered call is
  dropped. Test with a realistic fixture (`task-loop-fixtures.mjs`).
  Cause: the budget handoff swapped the working messages for a two-message
  capsule prefix but left `baseMessages` at three, and the skill context was
  inserted at `baseMessages.length`, i.e. between the fresh round's assistant
  `tool_calls` and its tool replies. It now goes before the first model turn,
  and a split exchange fails locally before any provider call. `7acc1e3e`
- [x] **B2 `semantic_completion_requires_active_step` failed a request.** After the
  pause, a player message led to a `same_goal_continue` plan that claimed a step
  was complete while the goal was paused. The guard is right to refuse the claim;
  the fault is that one refused claim failed the whole request instead of being
  reported back to the planner. Find why the continue path ran against a paused
  goal, and handle the refused claim without failing the request.
  Why: the player's "continue" (also what UI Resume sends) is the resume path; a
  paused goal turns active only when that turn's operations are admitted, after
  the claim check. Claim checks now also run at parse time, so a refusal takes the
  plan-correction path and the resubmitted operations resume the goal. A
  satisfied step can be closed only on the turn after a resume; the owner chose to
  keep it that way (2026-09-25, the safer option), so there is no resume step that
  closes work in the same turn. `aebbaf25`
- [x] **B3 `interaction_router` returned invalid content** (`effort: none`). The
  fallback worked, so this is low priority: note the frequency, fix if cheap.
  Every router reply in the container traces (30 of 30, 2026-09-20..25) was
  flagged; the replies were valid and routing used them. The trace diagnostic
  checked them against the plan schema. Fixed. Also noted: router requests
  still get a `[STEERING]` planner message appended (~0.8k chars). `109bc90f`

## W1 — recipe time and rate facts (deterministic, from game data)

The LLM should be able to measure time and parallelism itself, like the owner does.

- [x] `recipe_details` gains, per machine candidate: crafting speed, crafts per
  second (`crafting_speed / energy`), and output per minute. Hand crafting gets the
  seconds per craft for the actor (`energy / character crafting speed`, including
  the force's manual crafting modifier). `546b0516`
- [x] Resources and drills: mining time of the resource, the drill's mining speed,
  and ore per minute per drill. Burner machines: fuel burn per minute for a named
  fuel (from energy usage and fuel value). `546b0516` (`mining_details`)
- [x] A time estimate for a recipe tree: given a target item, count and a machine
  count per step, the harness returns the total time, the slowest step (the
  bottleneck), and how the time falls as machines are added. The LLM chooses the
  machine counts; the harness only does the arithmetic. `546b0516`, model tools
  `getMiningDetails` / `estimateProductionTime` `db648df2`
- [x] Real-Factorio lane check that the stone furnace / burner drill figures match
  the engine (e.g. measured plates over a fixed window vs. the computed rate).
  `81eee251` (production lane: 10 ore and 10 plates in 40 s, computed 10.0)

## W2 — thinking time and better waits

Two parts. The owner's wording was "make the harness calculate better wait time";
this is the reading used here. Correct it if it's wrong.

**W2a — thinking budget per round.** Today only the first round of a request gets
the trigger's policy; every later tool round falls through to
`ordinary_planning` = high (`deploy/pterodactyl/runtime-v8/provider.mjs`
`selectReasoningPolicy`). One request re-thinks at high effort 4–5 times.

- [x] Measure first: per-round latency, effort, reasoning tokens and
  `finish_reason` from `/data/logs/sgluna-prompts.jsonl`, grouped by request and
  policy reason. Show think time in the Debug window. `a34b569a`
  (`think-time-report.mjs`). Live trace, 2026-09-25, 11 requests / 35 rounds:

  | policy reason | rounds | p50 | max |
  |---|---|---|---|
  | plan_authoring (max) | 5 | 99.1 s | 129.9 s |
  | ordinary_planning (high) | 6 | 36.5 s | 54.0 s |
  | ordinary_replan (high) | 3 | 17.3 s | 51.8 s |
  | deterministic_completion (low) | 11 | 3.2 s | 15.5 s |
  | same_goal_continue (low) | 4 | 2.3 s | 11.0 s |

  Plan authoring dominates. `max` applies to every round of an authoring request,
  including the rounds that only gather facts with tools. The trace also never
  records `request_id` (the loop doesn't pass it to the provider), so requests are
  reconstructed from round 0 boundaries.
- [ ] Then set the effort per round from what the round has to do: gathering facts
  with tools doesn't need the full budget; writing or revising a plan does. Keep
  `max` for the round that writes the plan, not for every round of an authoring
  request. Record the chosen effort in the trace, as today, and pass `request_id`
  into the trace.

**W2b — the harness computes waits from game data.** When the NPC waits on
production (smelting, crafting, research), the harness works out the expected
finish from W1's rates and the live machine state and wakes the planner then, not
on an LLM-guessed delay. The planner thinks while the machines run, instead of the
world waiting for the planner. This is also the generic mechanic run-ahead needs
later.

- [ ] Expected-finish estimate for a running production/crafting step, exposed in
  observations and used to schedule the next planner wake-up.
- [ ] While a step runs, the next planning request can start early; its result is
  used only if the world at the finish matches what it assumed (first slice of
  run-ahead, `NPC_PLANNING_ROADMAP.md` "Parallel work and run-ahead planning").

## W2c — a plan that runs long must trigger a parallelization review

Owner direction, 2026-09-26, from the steam-power live run
(`docs/validation/E2E_STEAM_POWER_2026-09-26.md`). The NPC is still single-threaded:
asked for steam power and an electric drill, it committed one batch of four
hand-mining operations (80 coal, 60 stone, 180 iron ore, 70 copper ore = 390 ore) as
step 1 of 6. Hand mining is one serial lane, about 2 s per ore at the character's
speed. Measured in that run: coal + stone (140 items) took about 4.9 min of game time,
so the step needs roughly 13-14 min before any smelting, research or building starts.
No burner drill, no second lane, and no time figure was ever put next to the plan.

What already exists, and what the run showed:

- W1 facts and `estimateProductionTime` (which also covers hand mining and hand
  crafting) are in the system prompt and the tool list. The model never called
  `getMiningDetails` or `estimateProductionTime` in this run (tool calls: one inventory,
  one actor status, one nearby scan, four long-range searches, four recipe lookups).
  Offering a tool is not enough; nothing makes the plan face its own duration.
- The harness computes no duration for a committed plan, step or batch. There is no
  expected finish, no elapsed-vs-expected, and nothing that notices "this step will
  take 14 minutes on one lane".
- Planning itself is slow and serial with the world: 239 s of think time (4 rounds)
  before the first action, of which one round was 162 s at `max` effort.

### Time efficiency is its own consideration, not only scaling

Owner note, 2026-09-26: the NPC should weigh time efficiency in every plan, not just
choose between scaling up (a faster machine or lane, "vertical") and scaling out (more
machines, "horizontal"). Some time is lost with no machine involved, and the planner
should see it as a cost the way a player does:

- **Idle time.** The actor waiting on a smelt, a craft or research while it could be
  mining, crafting or walking. Measure it (share of the request's wall time in which
  the actor had no active operation) and show it.
- **Critical path.** Which step gates the goal. Work off the path can overlap with it;
  work on it is where extra machines pay. The harness can compute the path from step
  dependencies and W1 estimates; the LLM chooses what to overlap.
- **Payback.** Building a machine costs its own crafting, materials and placement
  time. Whether it pays back inside the time the plan still has to run is arithmetic
  the harness can supply (cost in seconds, saving per minute, break-even minutes). One
  more drill is not automatically better; for a 10-item job it is worse.
- **Travel.** Walking between the ore patch, the furnaces and the build site is time.
  Placement that keeps the lanes close, and batching trips, cut it. The estimate marks
  walking as excluded today; measured walking per step should be recorded so the next
  estimate can include it.
- **Planning time.** The thinking rounds count too (239 s before the first action in
  the 2026-09-26 run). A plan step that saves 2 min but costs 3 min of extra thinking
  is not a saving; effort per round (item 1.3) and run-ahead (W2b) address this.

Same rule as the rest of the plan: the harness supplies measured or derived numbers
(idle share, critical path, break-even, walking seconds); the LLM decides, guided by
skills. Extends the W2c items below with:

- [ ] Per-request time accounting in the trace and Debug window: think, walk, work
  (mining/crafting/machine-bound), idle.
- [ ] Break-even estimate for "build N more machines" alongside the existing "total
  with one more machine" in `estimateProductionTime`.
- [ ] Critical path and idle share on the task board step, next to the W2c estimate.

**Rule.** When a work plan (a step, a batch, or the sum of the remaining steps) is
expected to take long, the planner must be asked to look for parallelism before the
plan runs, and again when a running step overruns. The harness supplies the numbers
and the trigger; the LLM chooses how to parallelize, with the scale-out skill (W4). No
hard-wired build orders (see "Rules for this work").

- [ ] **Harness time estimate per plan step and batch.** From the operations in an
  admitted batch and the step's completion contract, compute the expected serial time
  on the actor's own lane (hand mining, hand crafting from W1 rates; walking is
  excluded and flagged as excluded) and, where machines exist, on machine lanes. Put it
  on the task board step (`expected_seconds`, `lane`, `basis`) and in observations
  and the Debug window next to elapsed time. Arithmetic over prototype rates only, the
  same source as `estimateProductionTime`. This is the "time calculation from the
  harness" the plan was missing for whole plans; W1 only answers when the model asks.
- [ ] **Elapsed vs expected.** Track the wall/game time each step has been running
  against its estimate. Overrun (elapsed above a factor of the estimate) is a fact in
  the next observation, not something the model must remember.
- [ ] **Long-plan trigger.** When the estimate for the active step, or for the
  committed plan, crosses a threshold (start at 5 min for one step, 20 min for the
  remaining plan; tune from traces) and the work is on a single lane, the planner
  request carries a parallelization prompt: the estimate, the lane it sits on, and the
  W1 tools to test alternatives (`estimateProductionTime` with more machines or a
  second lane). A batch that runs while the planner thinks is the same mechanism as
  W2b run-ahead. The model may decline with a reason; the reason is traced.
- [ ] **Plan-time check at commit.** A plan whose estimate exceeds the threshold and
  whose trace shows no estimate tool call gets one steering round ("your step 1 is
  about 13 min of hand mining; consider a burner drill + furnace lane or crafting
  while mining") before it runs. Bounded to one round per plan revision, like the
  other steering messages.
- [ ] **What "parallel" means here** (mechanics only, strategy stays with skills):
  more machines on the same job (W4); different work at once, for example the native
  hand-craft queue while the character mines, subject to the `native_queue_busy` rule
  (Wave 2 design note in "Along the way" and Later: concurrent operations).
- [ ] **Regression cases.** Unit: a four-op hand-mining batch of 390 ore produces an
  estimate near 13 min on the actor lane and trips the long-plan trigger; a batch of
  10 ore does not. Trace test: the steering message is sent once per revision and
  carries the estimate. Engine lane: measured hand-mining seconds per ore matches the
  computed rate (extends item 2.4).

## W2d — usage and price efficiency

Owner direction, 2026-09-26 (steam-power run, `docs/validation/E2E_STEAM_POWER_2026-09-26.md`):
loosening how the model is held back (chat style, output budgets) means cost has to
be tracked alongside time. The run spent about 1.01M provider units (904k input, 68% of it
cached; 107k output, 93% reasoning) and closed one step. No price is configured anywhere.

- [ ] **Cost accounting in the trace and Debug window.** Units per request already
  exist; add a price table setting per provider/model (input, cached input, output; no
  default guessed in code, empty means "units only") and show cost per request, per step,
  per goal, and cost per verified step. Cached input is its own rate.
- [ ] **Cost of rounds with no world change.** Count spend on observation-only rounds,
  recovery rounds, duplicate tool calls, invalid plan submissions, and rounds after a plan
  is already blocked. That is the waste the harness can remove.
- [ ] **Budget per goal, not only per request.** Today the cap is per request
  generation (100,000 output units) and a request can span a whole goal. A goal-level
  budget in units or cost, with a warning threshold shown to the player, and a bounded
  request budget that hands off at a step boundary (the existing handoff mechanism)
  instead of failing.
- [ ] **Effort follows value.** Output is 90% high/max effort. Continue item 1.3 (effort
  per round), and measure it: cost per verified step by policy reason, so a policy that
  spends a lot for no closed step is visible.
- [ ] **Cache discipline.** Keep the stable prompt prefix stable (the two recovery rounds
  had 26% cache hit); track cache-miss input share per round type.
- [ ] **Time and cost together.** The plan-duration estimate (W2c) and the cost estimate
  use the same round accounting; a parallelization or run-ahead decision should show its
  extra cost next to the time it saves (run-ahead spends model calls whose result may be
  thrown away).
- [ ] **Cheap and expensive roles.** With the roadmap agent plus per-plan agents idea
  (`docs/NPC_PLANNING_ROADMAP.md`, "Agent split") the model per role becomes a cost
  choice; W2d supplies the numbers to decide it.

## W3 — production-rate goals (plan 2)

Design: `docs/NPC_PLANNING_ROADMAP.md` "Production goals are rate goals".

- [ ] `production_rate {item_name, per_minute}` goal condition, measured by the
  harness from force production statistics over at least one minute.
- [ ] The window is void if the NPC inserts anything but fuel into the measured
  chain, or crafts the measured item itself.
- [ ] Goal definition picks `production_rate` for "build production" requests;
  `items_produced` stays for quantity requests, which also show an ETA (W1).

## W4 — scale-out through the skill library

- [ ] Curated `pattern` skill "scale out a production line": use W1 rates to size
  machine counts for a rate or a deadline, and the early "snowball": the first
  pair's plates pay for the next drills. Guidance, not a script; revised from
  evidence.
- [ ] `direct-miner-smelting` and `starter-smelting-row` point to it.
- [ ] Jev may rank it when throughput is the critical-path blocker (horizontal
  steering, §4.2).

## W5 — live check (needs the owner's go-ahead: API calls)

- [ ] Re-run "produce 100 iron and 100 copper plates" and a rate goal. Pass: the NPC
  sizes machines from the rates, and the think time per request drops.

## Next week (after the 2026-09-28 reset): everything open, in order

Revised 2026-09-26 after the steam-power live run
(`docs/validation/E2E_STEAM_POWER_2026-09-26.md`) and the owner discussion that
followed it. The earlier wave list (placement P0 first) is folded in below; items
already done keep their hashes.

### Target for `v0.1.0-pre.2` (owner, 2026-09-26)

Any model stronger than DeepSeek flash takes a cold-start NPC **to electricity**: an
electric mining drill working on steam power, verified from world state (electric
network satisfied, drill status `working`), not from item counters. Stretch: automated
red and green science (`automation-science-pack`, `logistic-science-pack` from
powered assemblers, measured as a rate). "Any model" means at least two non-DeepSeek
models pass, with DeepSeek flash kept as the baseline.

How we get there, in the owner's order:

1. **Delegation inside one NPC first.** One conversation carrying a whole goal is the
   failure of the steam run (one request, 38 min, 904k input units, dead at the
   100,000 output cap). Split the work into a roadmap agent and per-plan agents that
   share one body, before any multi-NPC swarm. Built on the swarm design's records
   (`docs/SWARM_COORDINATION_ARCHITECTURE.md`) so a second body later reuses the same
   contract. Design note: `NPC_PLANNING_ROADMAP.md` "Agent split".
2. **Jev integrated as far as it can go**, inside its authority (AGENTS.md: Jev may
   critique scope before commit; it never mutates a committed plan or advances the
   tracker). Jev was not even on in the steam run: `jev_health.measurement` was
   `jev_off` with 0 requests, because the local stack (`compose.yml`) does not pass
   the Jev key; only `compose.e2e.yml` does.
3. **Usage, cached input included, is planned, not observed afterwards.** The run was
   904,658 input units (614,272 cached, 290,386 cache miss) and 107,322 output for one
   closed step. With delegation there are more, smaller conversations, so prefix
   stability per role decides the bill.
4. **Skill lookup has to work without the model remembering to ask.** The library has
   `steam-power-bootstrap` and `automation-science-bootstrap`, and `findSkills` is in
   the prompt, yet the steam run never called it. Today's search
   (`packages/autorio/src/skills.ts` `find_skill_definitions`) is substring matching
   over the skill text, top 5, with no weighting by status or preconditions.

**Merge protocol (every item).** Agent commits on its worktree branch, no push, no
attribution lines. Main session reviews the diff, merges with `--no-ff`, re-runs the
full checks on the merged tree, pushes, and ticks the item here with the hash.
Deploys only through `scripts/build-docker-local.ps1` (or the mod overlay when only
the mod changed), and only when the owner asks.

**Checks for "done".** `scripts/test-local.sh all` (mod: vitest, `tsc`, Lua build,
`check-generated-lua`; runtime: `node --test` with `deploy/pterodactyl` and
`contracts/` mounted). Engine behaviour: the relevant `tests/factorio` lane. No
provider calls without the owner.

**Cut line.** This is more than one week of usage at about 10% a day. If the week runs
short, finish waves 1 and 2, then 3.1–3.4 and 4.1, and carry the rest.

### Wave 1: stop the live loop from breaking (P0)

| # | Item | Detail | Model |
|---|---|---|---|
| 1.1 | Placement footprint | **Done** (engine lane green at `27ab40d`); off-grid centres snap like the engine (`641d81c3`) | — |
| 1.2 | A refused placement freezes the plan | **Done** (`b234ef39`) | — |
| 1.3 | Thinking effort per round + output budget | W2a second item. Size the output cap with the effort, or lower the effort for fact-gathering rounds, so a round never spends the whole cap thinking. Pass `request_id` into the trace. Precondition from `OBSERVABILITY.md`: capture one failing and one successful request first | Opus |
| 1.4 | Local test setup | **Done** (`55714018`) | — |
| 1.5 | New output budget per step, visible failure | Steam run regressions 3 and 4. The budget generation only rolls on an output-budget handoff (`npc-agent-loop.mjs`, `providerBudgetGeneration`), so one request carried the goal until `provider_turn_output_cap_exceeded` (non-recoverable). Roll the generation at every step close, and when a request still fails at the cap, leave the goal visibly paused with one chat line and a Resume, never a silent `blocked` plan. First slice of delegation: a fresh budget per plan | Opus |
| 1.6 | One refused move must not cancel its siblings; `nothing_moved` gets a cause | Steam run regressions 1 and 2. Narrowed from the code (`basic_operation_runtime.ts` entity move): the NPC held the ore (else `item_missing`) and `insert` accepts partial counts, so "held fewer than 95" is ruled out; the furnace accepted zero, so its source slot held another item or `entity_inventories` chose the wrong inventory. Receipt carries held count and target slot contents; independent moves in a batch are not cancelled by one refusal. Engine lane case with three furnaces, one with a foreign item in its source slot | Opus |
| 1.7 | OpenRouter provider profile | Today `openrouter.ai` falls back to `generic`: no effort is sent, no style block, cached/reasoning usage may not parse. Add an `openrouter` profile whose behaviour is resolved from the model family, not once per process (today `providerCapabilityProfile` in `provider-base.mjs` runs once from the single `OPENAI_*` config): effort in OpenRouter's `reasoning` field (check against their docs in a unit test), the DeepSeek style block for DeepSeek models, `cache_control` breakpoints for Anthropic models (no caching without them), usage fields parsed. Written as a function of a model config so 3.1's per-role configs reuse it. Pin the upstream provider per role, so runs compare and cache hits stay stable | Sonnet |
| 1.8 | Jev on in local runs | `scripts/build-docker-local.ps1 -Jev` adds `compose.e2e.yml` (which maps `JEV_TYPESAFE_API_KEY`); the Debug window shows `jev_off` clearly when it is not set. No key printed or persisted | Haiku |
| 1.9 | Local provider (LM Studio) | Owner, 2026-09-26: use the models already downloaded in LM Studio on the owner's machine (RTX 4080 Laptop 12 GB, 64 GB DDR5); see "Local models" below. `providerEndpoint` (`provider-base.mjs`) accepts plain `http` only for `localhost`, `127.0.0.1` and `[::1]`, but the runtime runs in Docker and reaches the host as `host.docker.internal`: allow exactly that host name over `http`, nothing wider. Add a `local` capability profile (reasoning control per model family, no cached-input pricing, usage parsed from LM Studio's OpenAI-compatible responses) and a declared context window (start at 64k) so the runtime compacts before it overflows. Unconfirmed: whether LM Studio must serve on the local network for the container to reach it | Sonnet |

### Wave 2: facts, time, cost and skills the planner needs

| # | Item | Detail | Model |
|---|---|---|---|
| 2.1 | Scale-out skill | W4: curated pattern skill using W1 rates and the P0 footprints; `direct-miner-smelting` and `starter-smelting-row` point to it; Jev may rank it when throughput is on the critical path | Sonnet |
| 2.2 | `fuel_name` for `getRecipeDetails` | W1 open item: the tool is shared with the ordinary agent, so both contract sides change | Sonnet |
| 2.3 | Engine coverage for the 2.0 `crafting_speed` fix | `solveProduction` with a machine selection, in an existing lane | Sonnet |
| 2.4 | Hand-craft / hand-mining modifiers | Measure in the engine lane; the steam run measured about 2.1 s per hand-mined item including walking | Sonnet |
| 2.5 | Waits from game data | W2b first item, done together with the calculated waits from `NPC_PROVIDER_CONTINUATION_RECOVERY.md` | Opus |
| 2.6 | Plan duration estimate and parallelization trigger | W2c. Live case: 390 ore of hand mining in one step. Includes steam run regressions 7 and 8 | Opus |
| 2.7 | Cost accounting and goal-level budget | W2d. Also moves the steam run's one-off counters (verbosity, time split, spend by round type) into `think-time-report.mjs`, so a run record is one command | Opus |
| 2.8 | Skill lookup | (a) The harness offers the top skill candidates in plan-authoring context (summaries; loading stays explicit through `getSkillDetails`). (b) Better scoring: goal items and entities matched against skill outputs and topology, `verified` above `candidate`, preconditions checked against world state (research unlocked, items at hand). (c) Jev ranks the candidates (pulled forward from Jev tier 2 "skill retrieval"). (d) Trace which skills were offered, loaded and followed. Eval: fixed goal texts (steam power, red science, burner coal, smelting row) → expected skill id in the top 3, as a unit test. (e) Optional meaning-based scoring with the local `nomic-embed-text-v1.5` model (1.9), always falling back to keyword scoring, since a Pterodactyl deployment has no LM Studio | Opus |
| 2.9 | Cache and usage plan | Audit what changes the prompt prefix between rounds (steering placement, compaction, the style block, tool list order) and fix it so only the tail changes. Per-role prefixes for delegation: shared system + tool block first and identical across agents of the same role, role-specific tools only, dynamic state last. The prefix layout must survive a per-role model choice: Anthropic models cache only at explicit breakpoints, others cache automatically, so the breakpoints go where the stable prefix ends for every role. Targets per role: cache-miss input share and input units per round, reported by 2.7. The two recovery rounds of the steam run had a 26% cache hit | Sonnet |

### Wave 3: delegation inside one NPC, with Jev

| # | Item | Detail | Model |
|---|---|---|---|
| 3.1 | Design note: delegation inside one NPC | Roles (roadmap agent, plan agent, Jev), their interface as swarm records (mission, work item, result with evidence; `SWARM_COORDINATION_ARCHITECTURE.md` §4–§7), the body's lanes (movement and mining, the hand-craft queue) as reservations (§14), model, effort, budget and cache prefix per role, and how the output budget and "close on the next turn" apply per agent. **Per-role provider config:** today the runtime has one main provider (`OPENAI_API_KEY`, `OPENAI_API_BASEURL`, `OPENAI_MODEL`, read in `configuration()` in `supervisor.mjs`) and global budgets (`MAX_PROVIDER_REQUESTS_PER_HOUR`, `MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN`). Design: one OpenRouter key and base URL shared by all roles; optional per-role model overrides (for example `ROADMAP_MODEL`, `PLAN_MODEL`), a role without one falling back to `OPENAI_*` so single-model runs are unchanged; per-role effort, request budget and output cap replacing the global budgets. Jev stays on its own TypeSafe decision provider (`DECISION_PROVIDER_*`). Deployment env stays authoritative; keys stay secret and are never mirrored into `airi-config.json` (AGENTS.md). Answers the open questions in `NPC_PLANNING_ROADMAP.md` "Agent split". Doc only | Opus |
| 3.2 | Swarm branch audit | Read-only: what `origin/experiment/swarm-jev-integration` (1,505 behind, 282 ahead, last 2026-09-19) has that 3.3–3.5 can take, especially the Project Jev strategic split before the first planner decision and the milestone transitions; no merge of the branch | Sonnet |
| 3.3 | The reducer is the only writer | Phase 8 minimum: every agent's output reaches plan state through the reducer; the legacy Task Board becomes a read-only projection (full removal can follow). Needed before several agents produce plan updates | Opus |
| 3.4 | Plan agent | One committed plan or step per conversation, started from a harness-built brief (goal, plan, step, evidence so far, loaded skill), its own budget and context, returns verified evidence, never a claim. Several plan agents only on disjoint lanes | Opus |
| 3.5 | Roadmap agent | Owns the shelf, milestones, steering, the W2c parallelization review and skill choice; runs at plan boundaries only and sees summaries, not raw tool traffic | Opus |
| 3.6 | Jev in the split | Each goes shadow → advisory → gating on evidence: (a) critique of roadmap drafts before commit (existing authority); (b) the strategic split from 3.2 as input to the roadmap agent; (c) tier 1: loop detection feeding the deadlock counter, exact prototype name alignment, judgments logged with outcomes for a failure predictor; (d) skill ranking (2.8c); (e) the existing post-step decisions (continue, observe, reanchor, replan) at the plan agent's step boundaries | Opus |
| 3.7 | Goals that prove production and power | Rate goals (W3). A "running" goal gets a world-state condition (electric network satisfied, drill `working`); the rate counter excludes items the character mined or crafted by hand, or the hand-feeding hole reopens (steam run regression 5) | Opus |
| 3.8 | Plan tracker lag | Was 3.2: tracker on step 3 while the batch placed step 5 | Opus |

Role-to-model split (recommendation, not decided; settle it in 3.1 with 2.7's numbers):

- **Roadmap agent:** rare calls at plan boundaries on summaries only, so the strongest
  affordable model.
- **Plan agent:** the high-volume tool loop, so a mid-tier model with reliable tool
  calling and good caching.
- **Jev:** stays on TypeSafe.
- **Free models:** only for low-stakes, non-authoritative side jobs (compaction, log
  summaries). Not for the plan agent or the electricity trial: their rate limits would
  stall a run and read as model weakness. Check OpenRouter's current free-tier limits
  before citing numbers.

### Wave 4: engine proof for the pre.2 target (no API calls)

| # | Item | Detail | Model |
|---|---|---|---|
| 4.1 | Minimal steam lane | Exact layout in the production lane: offshore pump on a shoreline, boiler, steam engine, pole, electric mining drill `working`. Settles orientation and fluidbox alignment, and whether a water-edge fact query is needed (a fact, not a build order). First rung of the fluid track in `NPC_PRODUCTION_VALIDATION_ROADMAP.md` §5 | Opus |
| 4.2 | Powered assembler and inserter lane | Exact layout: powered assemblers making gears and red science, fed by inserters, measured as a rate. The frontier AGENTS.md names; needed for the stretch | Opus |
| 4.3 | Checkpoint saves | Save the world and NPC state after each verified step and restore one for a rerun, so a live attempt at steam starts with its materials instead of 28 min of hand mining. Test fixture only; cold runs stay cold | Sonnet |
| 4.4 | Local plumbing runs | After each of waves 1–3 lands, run ladder rungs 1–3 (10 stone; 5 gears; furnace + 10 plates) live on a local model through 1.9, from checkpoint saves (4.3). They prove the mechanics (budget per step, handoffs between agents, Jev wiring, pause and resume), not model quality, and cost no API calls. A paid wave 5 run starts only after these pass. The run record states the local model, so a failure there is not read as a harness verdict on stronger models | Sonnet |
### Local models (owner, 2026-09-26: use what is already downloaded)

On the owner's machine in LM Studio: `qwen3-coder-30b-a3b-instruct` (30B MoE, about 3B
active, 18.6 GB), `qwen3.5-35b-a3b-uncensored-hauhaucs-aggressive` (35B MoE, about 3B
active, 12.4 GB), `qwen/qwen3.5-9b`, `google/gemma-4-e4b`, `deepseek-r1-0528-qwen3-8b`
and the embedding model `nomic-embed-text-v1.5`.

| Use | Model | Why |
|---|---|---|
| Plan agent in local plumbing runs (4.4) | `qwen3-coder-30b-a3b-instruct` first, `qwen3.5-35b-a3b` as the second | Tool loop; the coder model is non-thinking, so rounds stay short. The 35B is an uncensored finetune: count its invalid tool calls before trusting it, since such finetunes often follow instructions less reliably |
| Side jobs (compaction summaries, run-record numbers) | `qwen/qwen3.5-9b` or `gemma-4-e4b` | Small and fast; never authoritative |
| Skill scoring (2.8e) | `nomic-embed-text-v1.5` | Optional, keyword fallback |
| Not used | `deepseek-r1-0528-qwen3-8b` | A reasoning distill; not a tool-calling model |

Not for the roadmap agent and not for the pre.2 electricity trial (5.3): the target
is a model stronger than DeepSeek flash. A local model on ladder rungs is a floor
data point only.

Expectations, estimated and to be measured in the first 4.4 run: with most experts
on the CPU, decode is roughly 20–35 tokens/s, so a round of about 2.9k output (the
steam run's average) takes around 2 minutes; about 24k input per round means prompt
processing costs time whenever the prefix changes, which makes 2.9's stable prefixes
a speed matter locally. RAM is shared with Windows, the Factorio client and Docker's
VM, so the 30B class is the ceiling while the game runs. LM Studio runs natively on
Windows; nothing here touches Docker Desktop.

### Wave 5: live proof (owner approves each run; API calls)

Every run gets an observer session writing a `docs/validation/` record from the steam
run's template, with the numbers from 2.7.

| # | Item | Detail |
|---|---|---|
| 5.1 | Burner drill pair | "Automate coal with only burner drills" end to end |
| 5.2 | Plates, count and rate | W5: 100 iron + 100 copper, then a rate goal |
| 5.3 | Electricity (pre.2 must-have) | Cold start, one short player request, first with a frontier model through OpenRouter (for example `openai/gpt-6-sol` or `anthropic/claude-opus-5.5`), then a second non-DeepSeek model; DeepSeek flash as baseline. Change one variable at a time: with delegation in, hold the roadmap agent's model fixed and vary only `PLAN_MODEL`; before 3.5 lands, vary `OPENAI_MODEL`. The run record lists the model and upstream provider per role. The DeepSeek style-block A/B from the steam run doc rides along |
| 5.4 | Red and green science (stretch) | From a checkpoint save with power running |
| 5.5 | Run-ahead, first slice | W2b second item, only after 5.1–5.3 are green |

### Wave 6: cleanup (small, any time a slot is free)

| # | Item | Model |
|---|---|---|
| 6.1 | Router requests still get the ~0.8k `[STEERING]` planner message | Haiku |
| 6.2 | `compactWorkingContext`: `baseMessages.length` drifts after a budget handoff | Sonnet |
| 6.3 | ~~TSTL truthiness warning, `task_board_debug_render.ts:140`~~ **Done** | — |
| 6.4 | Mining that also needs a fluid (uranium) is left out of estimates with a warning | Sonnet |
| 6.5 | Review the docs not read on 2026-09-25 (`NPC_RELIABILITY_WORK`, `NPC_PROVIDER_CONTINUATION_RECOVERY`, `NPC_PLANNING_REFACTOR_INTEGRATION`, `PTERODACTYL_NPC_STAGING`); archive to `docs/validation/` only what is finished | Haiku |
| 6.6 | Invalid `submitPlan` with a stray `}` (both shapes from the steam run): salvage without a model round if the repair is safe (steam run regression 6) | Sonnet |

### Along the way: open items from other docs

Checked on 2026-09-25 against the code, not only the doc text. Each is paired with
the wave whose files it already touches, so it costs little extra.

| With | Item | Source | Model |
|---|---|---|---|
| Wave 3 (3.4) | The deployed NPC never gets the spatial or production-planning prompts: only `packages/agent` imports `spatial-placement-prompt.md` and `production-planning-prompt.md`. Give placement guidance one source both paths use; the plan agent's brief is the natural place | `NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md` "Architecture debt" | Opus |
| Wave 1 | Confirm the tool contract really has one source now (`contracts/factorio-tool-contract.json` + parity tests); if yes, close the debt note, if not, list the remaining skew | same | Sonnet |
| Wave 3 (3.1) | Crafting while doing other work: an owned hand craft is refused with `native_queue_busy` if the character's queue already has anything. The lane reservations in 3.1 decide how concurrent operations interact with this rule | `NPC_RELIABILITY_WORK.md` native crafting ownership; `crafting.ts` | Opus (design) |
| Wave 5 | Skill value check: a warm run (skills learned) should be cheaper, faster or more reliable than a cold run; measure it with the 2.7 report | `NPC_LEARNING_BOOTSTRAP_E2E.md` | — (owner run) |
| Wave 5 | Player-join map sync is unit-tested only; add to the owner's client checks | `NPC_AGENT_HARNESS_STATUS.md` limitations | — (owner check) |
| After wave 5 | **Merge back to `feat/npc-transition-work` and publish `v0.1.0-pre.2`** when the target above is met. Freeze a candidate SHA, reconcile the six main-only commits, run the Pterodactyl package smoke + zero-player integration on that SHA, record a new `docs/validation/` checkpoint. Needs the fallback comparison below green | `NPC_AGENT_HARNESS_STATUS.md` "Current promotion blockers"; owner 2026-09-25/26 | Opus |
| Wave 6 (6.5) | Stale statements to correct while reviewing docs: `NPC_PLANNING_REFACTOR_INTEGRATION.md` says `planning-state.mjs` is "not yet wired in"; `NPC_RELIABILITY_WORK.md` says native crafting is "not yet engine-verified" (`tests/factorio/runner/crafting.py` covers it); the status doc's 2026-09-24 console section still lists client checks the owner has since done | those docs | Haiku |
| Owner only | `PROJECT_MIGRATION_TRACKER.md`: repository topics and clone remotes are GitHub settings for the owner. Regenerating `pnpm-lock.yaml` and renaming the `@proj-airi/*` TSTL plugin wait until the metered-network period ends | tracker | — |

### Planned but not built: roadmaps and approved plans

| With | Item | Source | Model |
|---|---|---|---|
| Wave 5 | Scenario ladder, cold, all five rungs: 10 stone; 5 gears; furnace + 10 plates; burner-drill iron setup; research automation (rung 5 has never run). Then check that skills are written and reused | memory `roadmap-2026-09-21` items 2 and 4 | — (owner runs) |
| Wave 6 | Record the status of planning-roadmap phases 1–4 (TypeSafe adapter fidelity, operation/type registry, Main-LLM intent boundary, TypeSafe-native projection) | `NPC_PLANNING_ROADMAP.md` §13 | Sonnet |
| After pre.2 | Phase 8 full removal of the legacy Task Board, if 3.3 left it as a projection | memory `roadmap-2026-09-21` item 3 | Opus |
| Before the merge back | Phase 9 comparison = **the fallback path** (owner, 2026-09-25): the Main-LLM-only path (Jev off) must work on the 5.3 scenario (success, calls, tokens, latency, interventions), so the branch can merge back with Jev off as a safe fallback. Needs the pre-Phase-9 M11 gate first | `NPC_PLANNING_ROADMAP.md` §13 | Opus |

Not in this plan (their own tracks, after pre.2): several NPC bodies coordinating
through the message board (the swarm proper; 3.1 keeps its contract ready), Jev
tier-2/3 uses other than skill ranking (player understanding, speak timing, chat
truthfulness), the player forcing a skill, fluids beyond the minimal steam lane (oil,
fluid mining), site pings / ghost staging and the experiment surface (design drafts),
Jev offline question tuning, vehicles/trains/space platforms.

### Owner checks in the client (no code)

From the e2e-planning session: the … menu, map pin, status light, blocked banner
(seen working in the 16:15 screenshot), Debug think-time row, pause → Resume.

## Later

- Doing two things at once (crafting while walking or mining): admission rules for
  concurrent operations. Needed for full run-ahead; not in this slice.
- Player forces a skill on the LLM (from the console UI plan).

## Assignments (subagents)

Model choice rule: Opus for runtime state, recovery paths, Factorio engine
semantics and goal rules; Sonnet for well-specified changes with clear tests;
Haiku for mechanical cleanup. The per-item model is in the wave tables above.

Done this week: W0 (Opus), W1 (Opus), W2a measurement (Sonnet).
