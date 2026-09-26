# E2E steam power run, 2026-09-26 (cold start, DeepSeek)

Observer record. Read-only: nothing was deployed, restarted, retried or sent to the game
or the NPC while it was written. Times are UTC unless marked; local time is UTC-4.
Historical checkpoint: do not update it for later commits.

## Verdict

**The run never reached the fluid work, so steam power is neither proven nor disproven.**
It stopped at step 2 of 6 (smelting and crafting) after 38 min 42 s, blocked on a failed
item transfer and, 44 s later, a failed provider request. The owner ended the session
there.

What worked:

- Cold start was clean: a freshly generated world, a new NPC (`Cinder-1`, actor 15), no
  persisted state, first goal got a new `goal_id`.
- Step 1 (hand-mine 390 ore) completed and was closed by the deterministic completion
  contract from real inventory counts, not from the model's say-so.
- Three stone furnaces were crafted, placed and supplied with ore and coal.
- Chat narration dropped from most plan submissions to one of nine (see the verbosity
  section). The new DeepSeek style block worked for chat.
- Two malformed `submitPlan` calls were recovered by the harness within about 2 s each.

What failed:

- **The NPC stayed on one serial lane.** 28 min 21 s of the 38 min 42 s was hand mining
  and 10 min was thinking; almost nothing overlapped. No burner drill was ever planned.
- **Time tools were offered and never used.** `getMiningDetails` and
  `estimateProductionTime` are in the prompt and tool list; neither was called.
- **The request died on its output cap.** One request carried the whole goal for 38 min
  and hit `provider_turn_output_cap_exceeded` (107,322 > 100,000 output units, 99,874 of
  them reasoning). Marked non-recoverable.
- **A supply batch failed on its first move and cancelled all six moves in it**
  (`nothing_moved`), leaving the plan blocked as `transfer_failed:nothing_moved`. The
  cause of the zero-item move is unconfirmed.
- **The goal's completion condition does not prove power** (see verification honesty).

Where it stopped: plan blocked (`transfer_failed:nothing_moved`), goal still `active`,
step 2 open, nothing waiting to resume. That is the silent-stall state described in the
memory note on provider failures; no UI signal was observed from the logs.

## Setup

| Item | Value |
|---|---|
| Commit | `56b89fec` (local build, container `airi-factorio-sgluna-factorio-1`) |
| Cold start | 02:42:31Z; world `data/saves/sgluna-world.zip` freshly generated; log shows "No valid controlled actor found" then reconciliation for actor 15 |
| Player joined | 02:46:06Z (left 03:29:17Z) |
| Provider | DeepSeek (`deepseek-flash`), thinking enabled, effort `max` for plan authoring |
| Goal | `goal_muhsnnd8`, defined 02:52:17Z; the player asked for a coal-fuelled steam plant running an electric mining drill (paraphrased) |
| Request | `req_muhsihjg_1`, received 02:48:16Z, failed 03:26:59Z |
| Before this run | the previous world, state and logs are in `save-backups/cold-start-20260925-224057` (baseline for the comparisons below) |

The goal definition (scope `long_horizon`) requires, counted from goal start:
`items_produced` of 1 offshore pump, 1 boiler, 1 steam engine, 1 electric mining drill,
and 180 coal. The committed six-step plan: hand-mine the first quota; smelt and craft;
build red science and research steam power plus the electric drill; craft the parts;
find water and build pump, boiler and engine; place the drill and wire it.

## Timeline

| Time (Z) | Event |
|---|---|
| 02:48:16 | Request received (`new_goal`). |
| 02:48:23 to 02:52:17 | Four plan-authoring rounds at `max`: 6.5 s, 51.3 s, 18.5 s, 162.6 s (238.9 s of provider time). No chat content on any. |
| 02:52:17 | Goal defined, six-step plan committed. Step 1: four `gather_resource` ops (80 coal, 60 stone, 180 iron ore, 70 copper ore = 390 ore). |
| 03:05:45 | Step 1 verified by the deterministic contract (13 min 26 s after it started). |
| 03:06:09 | Craft 6 stone furnaces. |
| 03:07:20 | Place a furnace, move coal and iron ore in (asked 180 ore, `moved_count` 120). |
| 03:07:33 | Two more furnaces placed (one receipt captured: requested = placed = (101, -35), unit 57). |
| 03:08:12 | `supply_entity` x3 (units 55, 56, 57): 30 iron ore + 8 coal each on two, 70 copper ore on the third. |
| 03:09:47 | Back to hand mining: 150 coal, radius 4096. Done 03:15:02 (5 min 15 s). |
| 03:15:09 | Invalid `submitPlan` JSON (first). Harness routed to deterministic recovery; plan accepted 03:15:11: 160 iron ore. |
| 03:20:39 | Iron ore done (5 min 28 s). |
| 03:20:48 | Invalid `submitPlan` JSON (second). Recovered 03:20:50: 120 copper ore. |
| 03:25:03 | Copper ore done (4 min 12 s). |
| 03:25:05 to 03:26:14 | Four rounds: inventory, furnace status, research path and recipes for the drill, boiler and engine, `steam-power` technology. Round 4 took 47.5 s at `high`. |
| 03:26:15 | `supply_entity` x3 (95 and 94 iron ore, 120 copper ore, 20 coal each). |
| 03:26:16 | First move returns `nothing_moved` (95 iron ore into unit 55, 0 moved). The mod cancels the batch: all six moves. |
| 03:26:20 to 03:26:59 | Two `failure` rounds at `high` (3.9 s, 38.6 s). Request-wide output reaches 107,322 and fails, non-recoverable. |
| 03:29:17 | Player leaves; container later found exited. |

Persisted state afterwards (`data/.airi/npc-state.json`): plan `blocked`, blocker
`transfer_failed:nothing_moved`, goal `active`.

## Where the 38 min 42 s went

Provider time summed over 37 rounds is 599 s (10.0 min). Hand mining was 28 min 21 s
(13:26 + 5:15 + 5:28 + 4:12). Together that is 38.4 min of the 38.7 min request: the
two never overlapped. The NPC mined while nothing thought and thought while nothing
mined. Smelting time is not separate because ore was only loaded at 03:08 and
03:26 and nothing waited on it.

This is the run that led to W2c and the time-efficiency section in
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md`.

## Fluid findings

**None; not reached.** No offshore pump, boiler or steam engine was crafted, placed or
queried. The 65 log lines that mention them come from the goal text and plan
descriptions only. Consequently these are all still unconfirmed live:

- shoreline search and offshore pump placement;
- boiler orientation and steam-engine alignment, fluidbox connections;
- whether water or steam ever flows and whether any power is produced.

Research was also not started, and the crafting of these buildings is locked behind
research (`steam-power`, plus the electric-drill technology), which the plan correctly
put first. The NPC did call `getResearchPath` and `getTechnology` at 03:25 and looked up
the recipes, so the research dependency was visible to it, about 33 min in.

## Placement findings (the new snapping, retry and blocker naming)

- **Snap on off-grid centres: not exercised.** Only one placement receipt reached the
  behavior log (the trace keeps the latest receipt per status): (101, -35), requested
  equal to placed. The other two placements (units 55 and 56) have no captured receipt.
  Whether they were on-grid is unconfirmed.
- **Refused placement going back to the planner (2 retries): not exercised.** There were
  no `not_placeable` or `placement_failed` events.
- **Blocker naming: exercised once, and correct.** The blocker was named after the real
  operation that failed, `transfer_failed:nothing_moved`, for a genuine item move, and
  not for a placement.
- Furnaces were placed roughly 100 tiles from the origin ((101, -35)); the ore patches
  and the furnaces were far apart, which the estimate does not cost (walking excluded).

### The `nothing_moved` batch

`supply_entity` to unit 55 moved 0 of 95 iron ore. The mod then cancelled the batch
with "dependent operations cancelled", so the coal and the copper for units 56 and 57 in
the same batch never moved either. The mod log gives no cause. Candidates (none
confirmed): the furnace's source slot was already full; the character held fewer than
95 iron ore at that moment (inventory was not read back; the earlier 180-ore move
delivered 120); or the supplied item did not fit the slot in use. Independent of the
cause, one refused item cancelling five independent moves to other furnaces is a
design question worth a lane case.

## Verification honesty

- **No completion was claimed** and no step was closed on model assertion. Step 1
  closed through `deterministic_completion_contract` from inventory counts (coal 80,
  stone 60, iron ore 180, copper ore 70). That is real world evidence.
- Seven `step.close_declined` events (`semantic_completion_requires_planner`) kept step
  2 open after batches finished, as intended for a step that needs planner judgement.
- **Risk in the goal definition (not triggered).** The `done_when` conditions are
  produced-item counters for the pump, boiler, engine and drill, and coal produced. All
  can be satisfied by crafting the four items and hand mining 180 coal, without any water
  connection, boiler fuel or power. The same counter hole was seen with the earlier drill
  canary. The goal says "steam power running", so a power-flowing condition (an engine
  with output, an electric network satisfaction, the drill status `working`) is missing.
  Flagged; nothing in this run reached the point of claiming success.
- One operation, `gather_resource`, was called as a tool once (03:20:45) and rejected by
  the harness as a world mutation; the harness corrected it. Also 4 duplicate tool calls
  were suppressed across the request.

## DeepSeek chat verbosity

Before 56b89fec (previous run, `save-backups/.../logs`) versus this run:

| Measure | Before | This run |
|---|---|---|
| Plan submissions carrying a non-empty `chatMessage` | 83 of 88 (94%) | **1 of 9 (11%)** |
| DeepSeek tool-call responses with assistant content | 44 of 201 (22%), about 126 chars each | **0 of 32 (0%)** |
| `request.completed` with chat | 23 of 23 | none (request failed) |
| All DeepSeek responses with any content | 112 of 285 | 6 of 38 |

The one non-empty chat message, on the first plan at 02:52:17, was a one-sentence
acknowledgement ("starting with the material bootstrap now; research, steam power,
and the powered drill follow"). The six responses with content were plan submissions
sent as JSON content (about 800 to 1,100 characters, no tool call), not narration.
Caveat: the previous run's window included longer, more varied goals; the direction is
clear but the ratio is not a controlled comparison. The four completion messages that the
style block still allows (answer, decision, `BLOCKED:`, verified completion) never
occurred here.

Possible side effect, **unconfirmed**: both invalid `submitPlan` calls carried
`"chatMessage": ""` with a stray extra `}` (one before the key, one after it). The
previous run had 7 invalid submissions in 279 responses (2.5%); this run had 2 in 37
(5.4%). The sample is too small to say the style block causes it. Worth counting over a
longer run.

## Owner hypothesis: the style block may be too strict (added after the run)

Owner, 2026-09-26: the output blow-up may come from the model trying to describe what
it has done while being told to say nothing, so the DeepSeek style block could be
loosened about half way (chat allowed roughly half the time). Recorded as a hypothesis
to test, not a change: no prompt was edited.

What the logs show for and against:

| Measure | Previous run | This run |
|---|---|---|
| Output units, total | 763,771 | 107,322 |
| of which reasoning | 720,901 (94.4%) | 99,874 (93.1%) |
| of which visible (chat, tool arguments, plan JSON) | 39,257 (5.1%) | 7,071 (6.6%) |

- **The cap failure is reasoning, not narration.** 93% of the 107,322 output units were
  reasoning. Visible output was 6.6%, a slightly larger share than before the style
  block, so cutting chat did not make the model's output lighter and loosening chat
  would not have bought back the 100,000 cap. Chat is not where the budget went.
- **A link to the malformed plans is plausible but unproven.** Both invalid
  `submitPlan` calls were the ones carrying an empty `chatMessage`, each with one
  stray closing brace, which fits a model fumbling a field it is told to leave empty.
  Two samples; the previous run's 7 of 279 (2.5%) happened before the style block, so
  the brace problem is not new.
- **One thing chat would give back:** a short status line while working is also the
  player's only signal. The run went 24 minutes (03:06 to 03:29) with no chat at all and
  ended blocked with no message. An occasional line, and always a line on a blocker,
  would have covered that and does not require the model to narrate every turn.

How to test it, next run, without guessing: keep the current block as arm A and a looser
block (chat allowed when a step closes or a batch fails, empty otherwise) as arm B, and
compare per arm: invalid `submitPlan` rate, reasoning tokens per round, non-empty chat
share, and whether a blocked or failed request produced any player-visible message.
The cap problem needs the separate fix listed under regressions (the budget per request).

## Usage and price efficiency

Owner, 2026-09-26: if the style and budget rules are loosened, usage and price
efficiency has to be a first-class concern too. No price table exists in the repo and
none is assumed here; the numbers below are provider units from the trace, so any price
is a multiplication once the rates are configured. Price per outcome is unconfirmed.

Whole run (37 provider calls, 38.7 min, 300 requests per hour allowed, about 57 used):

| Measure | Value |
|---|---|
| Input units | 904,658 (614,272 cached, 67.9%; 290,386 cache miss) |
| Output units | 107,322 (99,874 reasoning) |
| Total units | 1,011,980 |
| Verified outcomes | 1 step (step 1); no goal, no power |
| Units per verified step | about 1.0 million (step 1 itself cost far less; the rest bought nothing that closed) |

| Round type | Rounds | Input | Cached | Output | Output per round |
|---|---|---|---|---|---|
| `plan_authoring` (max) | 4 | 93,107 | 76% | 42,915 | 10,729 |
| `ordinary_replan` (high) | 7 | 206,838 | 74% | 34,079 | 4,868 |
| `ordinary_planning` (high) | 10 | 327,087 | 66% | 19,664 | 1,966 |
| `deterministic_completion` (low) | 14 | 233,117 | 69% | 10,287 | 735 |
| `strict_recovery` | 2 | 44,509 | 26% | 377 | 189 |

Observations that matter for cost:

- **Effort drives output cost.** The 21 `high` and `max` rounds produced 90% of the
  output (96,658 of 107,322); the 14 `low` rounds produced 10% (10,287). Plan authoring
  alone was 40% of output in 4 rounds, one round at 27,816.
- **Input dominates volume, and cache reuse is uneven.** 904k input against 107k output.
  Cache hit is 66 to 76% on normal rounds and 26% on the two recovery rounds, which pay
  nearly full input price for a two-second fix.
- **Rounds bought little.** Fourteen `deterministic_completion` rounds averaged 735
  output units, cheap; but ten `ordinary_planning` and seven `ordinary_replan` rounds
  spent 53,743 output units, and the last six (03:25 to 03:27, ending in the failure) spent
  20,941 output units on a state that then failed anyway.
- **Waste signals in the trace:** 4 duplicate tool calls, 3 `duplicate_observation` and
  5 observation-pressure recoveries (rounds that observed again instead of acting), 2
  invalid plan submissions that each cost a re-planning round, one request that failed at
  the cap after spending roughly a million units for a blocked plan.
- **Time and money move together.** The 10 minutes of provider time was also the spend.
  A plan that waits with the machines running, or a step that needs one cheap round
  instead of a 50 s high-effort one, saves both.

Suggested metrics for the next run (data only; see W2d in
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md`): units and estimated cost per verified step,
per goal and per game minute of progress; cache-miss input share; output share by effort
level; cost of rounds that led to no world change (observation-only, recovery,
duplicate); and units spent after a plan is already blocked.

## Think time per round

`node deploy/pterodactyl/runtime-v8/think-time-report.mjs data/logs/sgluna-prompts.jsonl`
(38 rounds, 11 reconstructed requests; the trace still has no `request_id`):

| Policy reason | Rounds | p50 | Max | Reasoning tokens |
|---|---|---|---|---|
| `plan_authoring` (max) | 4 | 18.5 s | 162.5 s | 40,970 |
| `ordinary_replan` (high) | 7 | 18.8 s | 53.4 s | 32,669 |
| `ordinary_planning` (high) | 10 | 7.8 s | 24.1 s | 18,235 |
| `deterministic_completion` (low) | 14 | 4.1 s | 9.5 s | 8,000 |
| `strict_recovery` | 2 | 2.0 s | 2.2 s | none |
| `interaction_router` | 1 | 1.2 s | 1.2 s | none |

Overall p50 6 s, max 162.5 s. Two `failure` rounds (`ordinary_replan`, `high`) after the
transfer failure took 3.9 s and 38.6 s; the 38.6 s round spent 7,268 reasoning tokens
and tipped the request over its cap. Request totals: 37 provider calls, 68 tool calls,
904,658 input units (614,272 cached), 107,322 output units, 148,700 characters of tool
results. Observation-pressure recoveries: 5 `observation_decision_pressure`, 2 budget
exhausted, 3 `duplicate_observation`, 1 budget complete.

The 100,000 cap is per request generation, and a request here spans every step
transition of the goal: 38 minutes, not one decision. That is a structure problem, not a
single bad round: a long goal will hit it whichever model runs.

## Regressions to add

Deterministic engine-lane or unit cases, one per failure:

1. **One refused move cancels its independent siblings.** Engine lane: a supply batch
   to three furnaces where the first target cannot take the item. Assert what happens to
   the moves to the other two furnaces, and that the receipt names the refused move and
   the reason (source slot full, insufficient held count), not only `nothing_moved`.
2. **`nothing_moved` needs a cause.** The receipt should carry why (held count, target
   slot state). Unit test on the receipt shape; lane test with a full source slot.
3. **Output cap per request, not per goal.** Unit test that a request spanning many
   step transitions rolls its output budget at a safe boundary (or hands off, as the
   existing budget handoff does) instead of failing non-recoverably at 100,000; and that
   a failure at the cap leaves the goal resumable or visibly paused.
4. **Cap-failed request must not leave a silent `blocked` plan.** Unit test: after
   `request.failed` recoverable=false, the board and UI signal say why and what resumes.
5. **Completion needs power evidence.** Goal-definition test: a "steam power running"
   request must produce at least one condition that reads world state (engine output or
   electric-network satisfaction, drill `working`), not only `items_produced`.
6. **Invalid `submitPlan` JSON with a stray brace.** Unit case with both malformed
   shapes from this run (extra `}` before and after `chatMessage`): the harness recovers
   deterministically, and if the brace repair is safe, salvages it without a model round.
7. **Long serial plan trigger (W2c).** Unit: a 390-ore hand-mining batch estimates near
   13 min on the actor lane and triggers the parallelization prompt; 10 ore does not.
8. **Time tools unused.** Trace test that a plan with an estimate above the threshold and
   no estimate tool call gets one steering round before it runs.
9. **Fluid lane (unchanged, still open).** Offshore pump on a shoreline, boiler and
   engine orientation, fluidbox connections, power flow: `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`
   section 5. This run adds no evidence for or against.

## Owner direction from this run

- DeepSeek is not handling the long agentic workload well at this point (single-request
  output cap, 162 s authoring round, no use of the time tools, serial plan).
- Next time, try subagents: one for the overall roadmap and one per active plan. Recorded
  as an idea, for discussion elsewhere, in `docs/NPC_PLANNING_ROADMAP.md` ("Agent split").

## Unconfirmed and gaps

- The cause of the `nothing_moved` result (see above).
- Placement receipts for units 55 and 56 and whether their positions were on-grid.
- Whether furnaces were actually smelting at 03:26 (no furnace state read: no RCON reads
  were sent, by design).
- Whether the goal or UI showed any paused/blocked signal to the player.
- Whether the invalid-JSON rate rose with the new style block (sample of 2).
- The hand-mining rate (about 2.1 s per item including walking, from 390 items in
  13 min 26 s) is measured for this world; the 2 s per ore prototype rate is derived.
- Everything fluid.

## Evidence

`data/logs/sgluna-behavior.jsonl` (374 events), `sgluna-prompts.jsonl`,
`data/factorio-current.log`, `docker logs --since 2026-09-26T02:40:00Z`, and
`data/.airi/npc-state.json` for the final state. These are local and not committed.
The scratch helpers (a poller and a verbosity counter) live outside the repo.
