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

- [ ] One shared footprint helper from the prototype (`tile_width/height`,
  `collision_box`, rotation swap): valid grid for the centre, world box for a centre
  + direction, and "centres whose footprint covers point P".
- [ ] `place_entity`: snap to the entity's grid only when unambiguous; otherwise
  refuse with the reason. `not_placeable` reports the footprint box tried, what
  collides inside it, and the grid rule. Never move an entity silently to a
  different spot than the planner asked for.
- [ ] Let placement target a relation instead of a centre (e.g. place so the
  footprint covers a point / receives another entity's output), resolved by the
  candidate search, and point the planner guidance at it for "output into X"
  placements.
- [ ] `findPlacementCandidates`: rotation-aware grid offset; return each
  candidate's footprint (tile size + world box).
- [ ] `plan_placement`: size-aware snapping, side and ring search from footprint
  edges, extension clearance from the entity size, blockers inside the footprint.
- [ ] Engine lane: the self-feeding burner drill pair (B's footprint covers A's
  drop point and vice versa) built through the tools, plus off-grid and overlap
  refusals with their reasons. Unit tests alone are not proof here.

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

## Later

- Doing two things at once (crafting while walking or mining): admission rules for
  concurrent operations. Needed for full run-ahead; not in this slice.
- Player forces a skill on the LLM (from the console UI plan).

## Assignments (subagents)

| Work | Model | Why |
|---|---|---|
| W0 B1/B2 | Opus 5.5 | Subtle state across recovery paths in `npc-agent-loop.mjs` |
| W1 | Opus 5.5 | Factorio 2.0 prototype API, TSTL limits, real-engine check |
| W2a measurement | Sonnet 5 | Well-defined trace analysis and a Debug field |
| W2a policy, W2b | Opus 5.5 | Policy choices, and the start of run-ahead |
| W3 | Opus 5.5 | Anti-cheat rules and goal semantics |
| W4 | Sonnet 5 | Skill data and tests, once W1's field names exist |

Order: W0 → W1 and W2a in parallel → W4 and W2b → W3 → W5. W0 and W2 both touch
`npc-agent-loop.mjs`/`provider.mjs`, so their agents run one after the other, or in
separate worktrees merged by the main session.
