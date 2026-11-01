# Lookup tool measurement, 2026-09-28

Read-only analysis for plan item 2.12. No runtime/harness code was changed. Data was
read from the recorded trace files in the main checkout's `data/logs/` (outside this
worktree) and is not copied into the repository; only derived counts appear below.
Historical checkpoint: do not update it to describe a later commit — add a new dated
file instead.

## Data sources and time ranges used

- `data/logs/sgluna-behavior.jsonl` (~1.9 MB) — the per-event planner trace. This is
  the primary source: every `tool.call` / `tool.result` pair, `operations.ack`
  (admitted mutation receipts), `actor.bound`, `factorio.event_coalesced`, and
  `request.completed` outcome for each request.
- `data/logs/sgluna-decision.jsonl` (~22 KB) — Jev decision log, all 29 entries dated
  2026-09-26T21:50–23:02Z. Used only to confirm the qwen-round time window; it carries
  no tool-level detail.
- `data/logs/sgluna-prompts.jsonl` (~5.2 MB) — not needed once the behavior trace's
  `tool.call`/`tool.result` events proved to carry tool name, arguments and result
  size directly; not parsed in this pass (see caveats).
- No `.env` file was read. No key-like strings were observed in the parsed data; the
  provider-metadata fields the harness itself already redacts (e.g.
  `requested_token_field`, `reported_output_tokens`) came back as the literal string
  `"[REDACTED]"` in the trace, confirming the harness redacts before writing.

**Runs identified**, from `request.received.data.text` (goal text), `request_id`, and
the model name on the request's first `provider.response.data.provider.model`:

| request_id | run | ts range (UTC) | model | goal text |
|---|---|---|---|---|
| `req_muhsihjg_1` | **steam run** | 2026-09-26T02:48:16 – 03:26:59 | `deepseek-flash` | "Can you get steam power going and run an electric mining drill with it?" |
| `req_muixboqf_1` | **qwen round 1** | 2026-09-26T21:50:43 – 21:54:26 | `qwen3-coder-30b-a3b-instruct` | "you can try to pick it up so the item inside it should also land in your inventory" (amend) |
| `req_muixvrpo_1` | **qwen round 2** | 2026-09-26T22:06:20 – 22:07:24 | `qwen3-coder-30b-a3b-instruct` | "mine 10 stone" |
| `req_muizw6hg_2` | **qwen round 3** | 2026-09-26T23:02:39 – 23:03:46 | `qwen3-coder-30b-a3b-instruct` | "mine 5 iron ore and 5 coal, then craft a stone furnace" |

These are the only 4 `request_id`s present in the behavior trace at all (the file also
has one trailing, request-less `request.cancelled` line from 2026-09-28, unrelated —
`actor_replaced_stale_turn` from an unconnected later session, ignored). The steam run
matches the existing `docs/validation/E2E_STEAM_POWER_2026-09-26.md` cold-start
DeepSeek record (same actor/goal); this document adds tool-call-level counts that
record does not have.

## Method and definitions

**Lookup tool** — a read-only tool. The exact set was taken from the runtime's own
catalog, not guessed: `deploy/pterodactyl/staging/structured-policy.mjs`
`export const toolDefinitions` (the base read-only catalog, checked by
`isObservationToolName`) plus the additional read-only definitions appended in
`deploy/pterodactyl/runtime-v8/structured-policy.mjs` `export const toolDefinitions`
(`...base.toolDefinitions, placementCandidatesDefinition, productionScopeDefinition,
solveProductionDefinition, miningDetailsDefinition, productionEstimateDefinition,
transportCapacityDefinition, localSpatialObservationDefinition,
placementPlannerDefinition, constructionSiteDefinition,
constructionPlanValidationDefinition, constructionIntentDefinition,
researchPathDefinition`). This is the same 38-name set keyed in that file's
`OBSERVATION_TOOL_FAMILY` / `OBSERVATION_TOOL_TIER` tables:

`getActorStatus, getTaskStatus, getInventoryItems, getEquipmentStatus, getRecipe,
getRecipeDetails, discoverPrototypes, getPrototypeDetails, findSkills, getSkillDetails,
getPlayerStatus, getNearbyEntities, findLongRangeEntities, findNearestEnemy,
getEntityStatus, getEntityGeometry, getLogisticsTopology, measureTransportThroughput,
getNavigationStatus, getFollowStatus, getDefenseStatus, getCraftingStatus,
getResearchStatus, getResearchRequest, getTechnology, getCombatStatus,
getProductionScope, solveProduction, getMiningDetails, estimateProductionTime,
getTransportCapacity, getLocalSpatialObservation, getPlacementCandidates,
planPlacement, findConstructionSites, validateConstructionPlan,
inspectConstructionIntent, getResearchPath`.

Only 10 of these 38 actually appear in the 4 recorded requests (see table below); the
rest have zero observed calls in this sample.

**Repeat** — same tool name with normalized-identical arguments (keys sorted,
JSON-compared) within the same `request_id`, with no mutation receipt, world event, or
epoch change between the two `tool.call` events. Events counted as invalidating a prior
call (any one clears every tracked signature, since a mutation can affect state the
harness does not label per-tool):
- `operations.ack` — an admitted, applied mutation (the harness's own mutation
  receipt);
- `factorio.event_coalesced` — an in-game event arrived from the mod side;
- `actor.bound` — the actor was (re)bound, a potential identity/epoch boundary;
- `planning.reasoning_epoch_reset` — the harness's own explicit epoch-bump/context
  rebuild boundary (same point where it clears its internal `toolCache`).

Cross-check: the harness already flags exact within-turn duplicates itself
(`tool.call.data.cached`, backed by `this.toolCache` in
`deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs`, cleared every continuation and at
`planning.reasoning_epoch_reset`). In the steam run, my repeat counts match the
harness's own `cached` flags exactly (`getInventoryItems`: 3 in both; `getEntityStatus`:
1 in both) — the independent count and the harness's built-in one agree.

**Cost** — the repeated result's exact `output_chars` (recorded verbatim per
`tool.result` in the trace) summed, then divided by 4 to estimate tokens. **This is an
estimate**: the trace does not record per-call input-token attribution, only aggregate
`usage` per provider round. No real token count was available at this granularity, so
characters/4 is used throughout and labeled as such.

**Rounds to first admitted action** — per request, the cumulative count of
`provider.request` events (the trace's own `round` field resets to 0 every new
turn/continuation, so this counts `provider.request` occurrences in trace order across
the whole request rather than trusting the raw `round` value across turn boundaries).
"Admitted" = the first `operations.ack` event in the request.

## Per-tool table (all 4 requests combined, 10 tools observed)

| tool | calls | repeats (strict) | repeat % | repeat cost (chars / est. tokens) | avg result chars | median result chars |
|---|---:|---:|---:|---:|---:|---:|
| `getRecipeDetails` | 25 | 0 | 0% | 0 / 0 | 4191 | 4273 |
| `getInventoryItems` | 16 | 3 | 18.8% | 552 / 138 | 172 | 189 |
| `getNearbyEntities` | 8 | 0 | 0% | 0 / 0 | 1781 | 816 |
| `getResearchPath` | 6 | 0 | 0% | 0 / 0 | 2944 | 3350 |
| `getEntityStatus` | 4 | 1 | 25% | 184 / 46 | 614 | 757 |
| `findLongRangeEntities` | 4 | 0 | 0% | 0 / 0 | 1103 | 1437 |
| `getTechnology` | 4 | 0 | 0% | 0 / 0 | 347 | 326 |
| `getActorStatus` | 3 | 0 | 0% | 0 / 0 | 658 | 630 |
| `getCraftingStatus` | 3 | 0 | 0% | 0 / 0 | 643 | 647 |
| `getRecipe` | 3 | 0 | 0% | 0 / 0 | 14 | 14 |
| `discoverPrototypes` | 1 | 0 | 0% | 0 / 0 | 517 | 517 |

All calls and all strict repeats came from the steam run except one `getInventoryItems`
call each in `req_muixboqf_1`/`req_muixvrpo_1`/`req_muizw6hg_2` (no repeats there — each
qwen round only ever got one round of lookups admitted; see below).

### The strict definition undercounts the largest offender

`getRecipeDetails` and `getTechnology` show 0 strict repeats because an
`operations.ack` (a mutation elsewhere — e.g. a craft or a mine) happened to fall
between the re-asks, which the strict "no world change in between" rule then treats as
a fresh call. But recipe/technology data is static, deterministic game data — it is
never invalidated by a world mutation, only by a game-version/mod change that does not
happen mid-session. Re-checking the same `item_or_recipe`/`name` argument later in the
same request is a pure re-ask regardless of what mutated in between. Counting
same-argument re-asks for the deterministic-data tools (`getRecipeDetails`,
`getTechnology`, `getRecipe`, `discoverPrototypes`, `getPrototypeDetails`, `findSkills`,
`getSkillDetails`) without the mutation-clears-everything rule, in the steam run alone:

| tool | calls | same-target re-asks | re-ask cost (chars / est. tokens) |
|---|---:|---:|---:|
| `getRecipeDetails` | 25 | 10 (40%) | — |
| `getTechnology` | 4 | 2 (50%) | — |
| combined | 29 | 12 | 43,498 / **10,875** |

`boiler`, `steam-engine`, and `electric-mining-drill` were each re-queried via
`getRecipeDetails` 4–5 times across different turns of the same request, at ~4.2 KB a
result. This single pattern cost an estimated 10,875 tokens in one request — roughly
30% of the entire steam run's lookup-result volume (148,700 chars / ~37,175 est. tokens
across all 68 lookup calls in that request) — and none of it shows up under the plan's
strict repeat definition because it is deterministic data, not world state.

## Rounds-to-first-action distribution per run

**Steam run** (`req_muhsihjg_1`, 10 turns/continuations, 37 provider rounds total, 9 of
10 turns reached an admitted mutation): rounds-to-admit per turn (provider rounds
within that turn before its `operations.ack`): `4, 3, 5, 2, 5, 5, 3, 4, 4`. Min 2, max
5, median 4, mean ≈3.9. The very first admitted mutation in the request (turn 1)
happened after 4 provider rounds.

**Qwen rounds** (all three, `req_muixboqf_1`/`req_muixvrpo_1`/`req_muizw6hg_2`): **0 of
3 requests ever reached an admitted mutation.** Each ran a first round of 1–3 lookup
calls, then the harness closed the observation phase (Jev observation-budget cap) and
the model kept returning observation-tool calls anyway; the harness rejected those
(`recovery.classified` `reason_code: observation_phase_closed`, 3–4 times per request)
without executing them, and each request ended `request.completed` /
`outcome: blocked_before_mutation` after 5, 5, and 8 provider rounds respectively —
"Provider repeatedly requested observation tools after the runtime closed the
observation phase." No `tool.call` trace event exists for the rejected re-asks (see
caveats), so it is not possible to say from this trace whether those blocked attempts
repeated the same 1–3 tools from round 1 or asked for something new — only that the
model kept trying to look things up and the harness kept refusing after the cap closed.

## Ranked 3–4 tools to convert first (for 3.9)

1. **`getRecipeDetails`** — by far the largest measured waste: 10 of 25 calls (40%) in
   the steam run alone re-asked for a target (`boiler`, `steam-engine`,
   `electric-mining-drill`, `offshore-pump`) already returned earlier in the same
   request, at ~4.2 KB/call, ≈10,875 estimated tokens of pure re-ask in one request.
   Data is static/deterministic (never invalidated by a world mutation), so this is the
   cleanest case for a "still the same, unchanged" compact recheck — no freshness logic
   beyond "has the requested item/count changed" is needed.
2. **`getInventoryItems`** — highest strict-repeat rate and cost among mutable-state
   tools (3/16 calls, 18.8%, 552 chars/≈138 est. tokens), called more often than any
   other tool except `getRecipeDetails` (16 of 68 lookup calls across all 4 requests),
   and its receipt shape (`inventory_count`) is already scaffolded in
   `runtimeConditionCommand` in `deploy/pterodactyl/staging/structured-policy.mjs` —
   the cheapest of the four to wire up.
3. **`getEntityStatus`** — highest strict-repeat rate of any tool observed (1/4, 25%),
   and its receipt shapes (`entity_exists`, `entity_state`) are also already scaffolded
   in the same `runtimeConditionCommand` enum. Small per-call size, but the repeat
   pattern (same entity re-checked after doing something unrelated) is exactly what
   3.9 describes converting.
4. **`getNearbyEntities`** — no exact-argument repeats were observed (each of its 8
   calls varied `radius`/`name`/`type`), but it has the largest average result size of
   any tool actually called (1781 chars aggregate avg, up to 2587 in the steam run) and
   is called on nearly every turn to re-orient. It is included as a size-driven
   candidate rather than a repeat-driven one — flagged explicitly so 3.9 does not
   over-read this as a measured-repeat result the way `getRecipeDetails` and
   `getInventoryItems` are.

`getResearchPath` (2944–3350 avg chars, called 6 times, all with a `name` argument)
was the next-largest by size but showed 0 same-target re-asks in this sample (each call
targeted a different technology), so it is not ranked in the top 4 on this evidence.

## Caveats

- **Sample size is thin.** Only 4 requests, 1 of which (the steam run) supplies almost
  all the tool-call volume (68 of 71 total lookup calls); the 3 qwen requests never
  reached a mutation at all, so they contribute essentially no *admitted-repeat*
  evidence, only the "0/3 reached admission" finding above. Every number in the
  per-tool table above is dominated by one 38-minute session with one model
  (`deepseek-flash`); it is not evidence about qwen's or any other model's repeat
  behavior specifically, only about what the harness's admission/observation-budget
  path did under qwen in these 3 short requests.
- **Rejected re-asks are invisible to this trace.** When the harness closes the
  observation phase mid-request (as in all 3 qwen rounds) and the model keeps
  returning tool calls anyway, the trace only records `recovery.classified` with a
  reason code — not the tool name/arguments the model tried to call. 3.9's measurement
  needs the harness to log the attempted tool + arguments even when rejected, or this
  specific failure mode (repeated lookup pressure that gets refused outright, ending
  the whole request in `blocked_before_mutation`) cannot be measured, only inferred.
- **The strict "any world change invalidates everything" rule is conservative and,
  for static/deterministic tools, wrong in the direction that hides waste** (see the
  `getRecipeDetails`/`getTechnology` section above). 3.9 should split the invalidation
  rule by tool: world-mutation-only invalidation for genuinely mutable facts
  (inventory, entity/task/research status, nearby-entity scans), and session/epoch-only
  invalidation (or none at all within a session) for static game data (recipes,
  prototypes, technologies, skills).
- **`getNearbyEntities`/`findLongRangeEntities`-style fuzzy repeats are not counted.**
  Two calls with different `radius` or `limit` over the same effective area were
  treated as distinct because arguments differ, even though they may be requesting
  overlapping information. A later measurement that wants to size a "same area, no
  world change" recheck for spatial tools needs a looser equivalence than exact
  argument match.
- **This pass did not parse `sgluna-prompts.jsonl`.** The behavior trace already
  carried tool name, arguments, and result size directly, so the larger prompts log
  (full request/response bodies) was not needed for this measurement and was not read.
- **No true input-token counts were available per tool call**, only aggregate
  provider-round `usage` and exact result character counts; all "cost" figures above
  are the stated chars/4 estimate, not measured tokens.

## Scripts used (not committed)

Two throwaway Node scripts were used to parse the trace and are not part of this
commit: `analyze.mjs` (first pass; per-tool strict repeat counts) and `analyze2.mjs`
(adds per-turn/cumulative round-to-admit tracking and the `blocked_before_mutation`
check). Both live only in this session's scratch directory. They read
`sgluna-behavior.jsonl` read-only and wrote no files back into `data/logs/`.
