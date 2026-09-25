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

## Next week (after the 2026-09-28 reset): everything open, in order

The owner is spending next week's usage on this list. Every open item from this
plan, the agents' reports and the 2026-09-25 live runs is here once, with where its
detail lives. Waves run one after another; items inside a wave run in parallel,
each agent in its own worktree, merged and re-tested by the main session.

**Merge protocol (every item).** Agent commits on its worktree branch, no push, no
attribution lines. Main session reviews the diff, merges with `--no-ff`, re-runs the
full checks on the merged tree, pushes, and ticks the item here with the hash.
Deploys only through `scripts/build-docker-local.ps1` (or the mod overlay when only
the mod changed), and only when the owner asks.

**Checks for "done".** Mod: vitest, `tsc`, Lua build, `check-generated-lua`, eslint
on changed files. Runtime: `node --test` on `staging` and `runtime-v8` with
`deploy/pterodactyl` **and `contracts/`** mounted (without `contracts/` two parity
tests fail falsely). Engine behaviour: the relevant `tests/factorio` lane. No
provider calls without the owner.

### Wave 1: stop the live loop from breaking (P0)

| # | Item | Detail | Model |
|---|---|---|---|
| 1.1 | Placement footprint | P0 section above: shared footprint helper, `place_entity` reasons, placement by relation, candidate footprints, `plan_placement` fixes, engine lane for the self-feeding drill pair. **In progress in another session** (`032d02e`..`fdd71a9`, pushed 2026-09-25): footprint helper, size-aware candidates and `plan_placement`, refusal geometry in receipts, relational-placement guidance, a production-lane cell for the reciprocal drill pair. Unit suite green at `fdd71a9` (802). Finish: confirm the engine lane passes and review against the P0 list, then tick the P0 list | Opus |
| 1.2 | A refused placement freezes the plan | `canonical-task-board-memory.mjs` `recordBoardEvidence`: any `operation_error_receipt` in a batch with an unverified transfer becomes `world_blocked` `transfer_failed:<reason>`. A `not_placeable` at a planner-chosen coordinate is a correctable planning error; it should go back to the planner (bounded) with the new placement reason, and block only when retries run out or the world truly prevents the step. Keep real transfer failures blocking. Regression test with the 16:15 batch shape (`placing` + dependent `moving_items`) | Opus |
| 1.3 | Thinking effort per round + output budget | W2a second item. Also: the output budget still runs out at high effort (`finish_reason: length` 16:12 and 15:07; screenshot: 11 rounds, 178 s, slowest 75 s). Size the output cap with the effort, or lower the effort for fact-gathering rounds, so a round never spends the whole cap thinking. Pass `request_id` into the trace | Opus |
| 1.4 | Local test setup | One script (or package.json alias) that runs the runtime and mod suites in `npc-dev` with the right mounts (`deploy/pterodactyl`, `contracts/`, repo-root files the compose tests read), so agents stop hitting false failures. `local-compose-secret-boundary.test.mjs` also fails on Windows CRLF in the devcontainer compose file; make it line-ending tolerant or normalise the file (`.gitattributes`) — don't weaken what it checks | Sonnet |

1.1 and 1.2 touch different files (mod placement vs. runtime board memory); 1.3
is `provider.mjs`/`npc-agent-loop.mjs`. All four can run at once.

### Wave 2: facts the planner needs to scale out

| # | Item | Detail | Model |
|---|---|---|---|
| 2.1 | Scale-out skill | W4: curated pattern skill using W1 rates and the P0 footprints; `direct-miner-smelting` and `starter-smelting-row` point to it; Jev may rank it when throughput is on the critical path | Sonnet |
| 2.2 | `fuel_name` for `getRecipeDetails` | W1 open item: the tool is shared with the ordinary agent, so both contract sides change | Sonnet |
| 2.3 | Engine coverage for the 2.0 `crafting_speed` fix | `solveProduction` with a machine selection and prototype details for crafting machines, in an existing lane (they raised live before `6476fdc`) | Sonnet |
| 2.4 | Hand-craft / hand-mining modifiers | W1 assumed the force and character modifiers add; measure it in the engine lane | Sonnet |
| 2.5 | Waits from game data | W2b first item: expected finish for a running step from W1 rates and live machine state, used to schedule the next planner wake-up | Opus |

### Wave 3: goals that prove production

| # | Item | Detail | Model |
|---|---|---|---|
| 3.1 | Production-rate goals | W3 section. The 16:1x run's goal was "20 × coal produced from now on", a count, so the same hand-feeding hole is still open | Opus |
| 3.2 | Plan tracker lag | In the screenshot the tracker was on step 3 of 7 ("walk to the coal patch") while the batch was placing drill B (step 5), and drill A (step 4) was already built. Part of this is the owner's "close on the next turn after a resume" choice; check whether the rest is a missed deterministic close | Opus |

### Wave 4: live proof (owner approves each run; API calls)

| # | Item | Detail |
|---|---|---|
| 4.1 | Burner drill pair | "Automate coal with only burner drills" end to end: placements through the tools, no `not_placeable` freeze |
| 4.2 | Plates, count and rate | W5: 100 iron + 100 copper, then a rate goal. Pass: machine counts sized from the rates, think time per request down from today's numbers |
| 4.3 | Run-ahead, first slice | W2b second item, only after 4.1–4.2 are green |

### Wave 5: cleanup (small, any time a slot is free)

| # | Item | Model |
|---|---|---|
| 5.1 | Router requests still get the ~0.8k `[STEERING]` planner message | Haiku |
| 5.2 | `compactWorkingContext`: `baseMessages.length` drifts after a budget handoff (affects which exchanges compact, not validity) | Sonnet |
| 5.3 | TSTL truthiness warning, `task_board_debug_render.ts:140` | Haiku |
| 5.4 | Mining that also needs a fluid (uranium) is left out of estimates with a warning | Sonnet |
| 5.5 | Review the docs not read on 2026-09-25 (`NPC_RELIABILITY_WORK`, `NPC_PROVIDER_CONTINUATION_RECOVERY`, `NPC_PLANNING_REFACTOR_INTEGRATION`, `PTERODACTYL_NPC_STAGING`); archive to `docs/validation/` only what is finished | Haiku |

### Along the way: open items from other docs

Checked on 2026-09-25 against the code, not only the doc text. Each is paired with
the wave whose files it already touches, so it costs little extra.

| With | Item | Source | Model |
|---|---|---|---|
| Wave 1 (1.1) | The deployed NPC never gets the spatial or production-planning prompts: only `packages/agent` imports `spatial-placement-prompt.md` and `production-planning-prompt.md`; runtime-v8 relies on tool descriptions and guidance. Give placement guidance one source both paths use, starting with the P0 relational-placement rule | `NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md` "Architecture debt" | Opus |
| Wave 1 (1.4) | Confirm the tool contract really has one source now (`contracts/factorio-tool-contract.json` + parity tests); if yes, close the debt note, if not, list the remaining skew | same | Sonnet |
| Wave 2 (2.5) | Waits: planner-chosen `wait {ticks}` → a bounded wait derived from recipe energy, machine speed and remaining output, ending early when the condition holds; never proof of completion | `NPC_PROVIDER_CONTINUATION_RECOVERY.md` "Deferred: calculated / condition-based waits" (same work as 2.5; do them as one) | Opus |
| Wave 2 | Crafting while doing other work: an owned hand craft is refused with `native_queue_busy` if the character's queue already has anything. Decide how concurrent operations (Later) interact with this rule before building run-ahead | `NPC_RELIABILITY_WORK.md` native crafting ownership; `crafting.ts` | Opus (design note only) |
| Wave 4 | Skill value check: a warm run (skills learned) should be cheaper, faster or more reliable than a cold run; measure it on 4.1/4.2 using the think-time report | `NPC_LEARNING_BOOTSTRAP_E2E.md` | — (owner run) |
| Wave 4 | Player-join map sync is unit-tested only: when the owner joins, the map should show what the NPC charted. Add to the owner's client checks | `NPC_AGENT_HARNESS_STATUS.md` limitations | — (owner check) |
| After wave 4 | Promotion checkpoint: freeze a candidate SHA, reconcile the six main-only commits, Pterodactyl package smoke + zero-player integration on that SHA, record a new `docs/validation/` checkpoint. Owner decides when | `NPC_AGENT_HARNESS_STATUS.md` "Current promotion blockers" | Opus |
| Wave 5 (5.5) | Stale statements to correct while reviewing docs: `NPC_PLANNING_REFACTOR_INTEGRATION.md` says `planning-state.mjs` is "not yet wired in" (it is imported by the loop, board memory and supervisor); `NPC_RELIABILITY_WORK.md` says native crafting is "not yet engine-verified" (`tests/factorio/runner/crafting.py` covers it); the status doc's 2026-09-24 console section still lists client checks the owner has since done | those docs | Haiku |
| Owner only | `PROJECT_MIGRATION_TRACKER.md`: repository topics and checking clone remotes are GitHub settings for the owner. Regenerating `pnpm-lock.yaml` and renaming the `@proj-airi/*` TSTL plugin need a networked `pnpm install`, so they wait until the metered-network period ends | tracker | — |

Not along the way (their own tracks, after this plan): powered assembler/inserter
production and the fluid known-red track (`NPC_PRODUCTION_VALIDATION_ROADMAP.md`),
site pings / ghost staging and the experiment surface (design drafts), Jev offline
question tuning, swarm coordination, vehicles/trains/space platforms.

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
