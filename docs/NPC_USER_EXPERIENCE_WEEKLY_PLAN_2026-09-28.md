# NPC macro and user experience — weeks 1 and 2

Owner direction, 2026-09-28; week numbering corrected by the owner, 2026-09-30.
Week 1 (current): 2026-09-28 through 2026-10-04 — macro harness and loop.
Week 2 (next): 2026-10-05 through 2026-10-11 — user-experience follow-up plan.
This is a separate track from `PARALLEL_PRODUCTION_WORK_PLAN.md`. It records the
user-facing behavior wanted alongside the production and delegation work. Mark an
item complete only after its evidence is recorded here with the implementing commit.

The accepted Week 1 build contract is [NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md).
It supersedes older blanket revision-approval rules for in-scope Auto/player-task
recovery. The Q&A below records the decisions; implementation evidence stays separate.

## Outcome

SGLuna starts useful work promptly, shows meaningful progress, asks the player a
clear question only when the decision belongs to them, and completes production
goals as quickly as grounded game facts allow. It also has a standing gameplay
mode for autonomous play, factory upkeep, or companionship. Supplying a System
One/Jev API key is optional; the same goal and safety rules work without it.

The default is **time to the next useful result**, including planning, travel,
construction, ramp-up, and production time. There is no separate cheap mode. Cost
and provider usage remain visible guardrails, not a reason to choose a slower
gameplay strategy by default.

## Boundaries and dependencies

- The existing Goal / Roadmap Shelf / immutable Active Plan contract stays in
  force. Observation is read-only. A world mutation starts only after a plan
  slice is committed and the complete action has passed schema, identity,
  preflight, and actor/session/epoch checks. A partial streamed tool call is not
  an action.
- Jev selects or ranks bounded choices when configured. It never supplies world
  facts, approves plan correctness, or becomes required for admission. No-Jev
  mode uses deterministic facts and routing plus the Main LLM for semantic
  choices; it must not simulate Jev through invented deterministic strategy.
- Show short **intent and progress summaries**, never raw private reasoning.
  Runtime events and verified receipts are the source for world claims.
- Reuse the existing blocked-plan controls and Console layout where practical.
  A semantic change creates a new plan version. In-scope Auto/player-task recovery
  uses harness-verified standing authority; an answer changing the result or other
  protected constraint requires explicit approval correlated with the new revision.
- Any player on SGLuna's force may change its standing mode or approve a revised
  plan. Serialize competing commands against a mode/goal revision: record the
  accepted player and reject a stale answer or command with the current state.
  This is separate from physical inventory access.
- This track depends on the current plan's 1.5 visible pause behavior, 2.6 time
  estimates, 2.7 timing/usage report, 2.10 quick acknowledgement, 3.3 reducer
  ownership, and 3.4 bounded plan agents where noted below. Avoid duplicate
  implementations; cross-reference the evidence from those items.
- Static/provider-scripted and real-Factorio tests may run under the existing
  repository rules. No live model-provider run or deployment without the
  owner's go-ahead. No new CI job is needed.

**Harness task contract (owner, 2026-09-28):** At goal acceptance, the harness
supplies the completion predicate. For a quantity goal it names the destination,
item identity, and delivered amount; for a rate goal it names the measurement
boundary, minimum rate, and sustained observation window. The LLM may choose
how to satisfy that predicate but cannot declare a different one complete.
Record observed delivery or rate evidence, not merely a successful command or
running machine. A missing or changed destination requires re-observation and,
if it changes the requested result, a visible goal revision.

Material claims guide planning and never prevent a player from withdrawing
items; a withdrawal invalidates the claim. When shared materials are temporarily
unavailable, the first recovery choice may be to wait for a bounded next check
while keeping the task active. If waiting cannot make progress, inspect live
recipes and inventories for a legal manual-crafting route using available basic
inputs such as iron plate, copper
plate, or steel. Do not assume an item can be hand-crafted; the running game's
recipe and force availability decide. Keep the same completion predicate and
material authority through a wait or handcraft detour.

**Autonomy direction (owner, 2026-09-28):** The harness supplies the active
save's winning trigger and its evidence, including the relevant objective or
achievement when applicable. Auto pursues that exact trigger; an arbitrary
achievement unlock is not victory. AIRI physically builds committed designs
first. After robots are unlocked and actually available, logistic robots may
bring supplies and construction robots may build ghosts within their network's
coverage when the required items are reachable. Ghost placement alone is never
construction or production proof.

Schedule by time sensitivity within this default order: explicit player
requests, defense, upkeep, then Auto progression. A new player command can
interrupt active defense, as already specified; the Console shows the paused
defense work and its current threat. Preserve and revalidate the lower-priority
step before resuming. Aging and bounded checkpoints prevent a long Auto goal
from being silently forgotten during sustained upkeep.

**Jev task-switch QTE (owner, 2026-09-28):** On a meaningful event such as a
player command, observed attack, production stoppage, completed step, or
resource loss, the harness forms a small, current set of runnable tasks with
their priority class, observed urgency, deadline, active-step interruptibility,
and evidence age. Jev may quickly rank `continue`, `switch to candidate`, or
`defer` with a confidence and reason code. The deterministic scheduler enforces
player authority, priority order, emergency rules, committed-plan boundaries,
and stale-response rejection before accepting a suggestion. A low-confidence,
late, missing, or invalid Jev response uses the same deterministic fallback;
only a genuinely semantic ambiguity escalates to the Main LLM or player. The
event handler never waits on Jev before acknowledging the player or admitting an
already validated urgent defense action. Do not call Jev every tick or for an
unchanged one-minute Idle check.

## Official-source grounding (2026-09-28)

The mod declares `factorio_version: "2.0"`; use the [stable 2.0 runtime API](https://lua-api.factorio.com/stable/)
as the implementation reference. The sources below establish available game
mechanics, not that this repository already implements the feature. Check the
actual game version in each real-Factorio test and keep provider streaming,
Jev fallback, Console UX, mode policy, and admission rules as repository-owned
contracts that require local tests.

| Plan IDs | Grounded fact and implementation consequence | Official source |
| --- | --- | --- |
| U4, U7, U9, U12 | Mod `storage` persists save data. Persist question IDs, mode revisions, player holds, and learning proposals there; reconstruct transient GUI on load. Do not mutate `storage` inside `on_load`. | [Storage and save/load](https://lua-api.factorio.com/stable/auxiliary/storage.html) |
| U5, U6 | Force item/fluid production statistics are scoped by surface, and flow statistics expose sampled counts. They can support aggregate rate estimates but cannot alone prove delivery from a particular line to its intended consumer. Pair them with a named output boundary and measurement window. | [LuaForce](https://lua-api.factorio.com/stable/classes/LuaForce.html), [LuaFlowStatistics](https://lua-api.factorio.com/stable/classes/LuaFlowStatistics.html) |
| U7, U12 | `on_nth_tick` schedules game ticks. Normal speed targets 60 UPS, but changed speed or slow UPS changes elapsed wall time. State whether a one-minute check means game time or wall time and test pause/restart behavior. | [LuaBootstrap](https://lua-api.factorio.com/stable/classes/LuaBootstrap.html), [Factorio time](https://wiki.factorio.com/Time) |
| U10 | Pollution is sampled by surface/chunk and evolution is read from the enemy force for a specified surface. Uncharted cloud edges and future attacks are estimates, not observed threats. | [LuaSurface](https://lua-api.factorio.com/stable/classes/LuaSurface.html), [LuaForce](https://lua-api.factorio.com/stable/classes/LuaForce.html) |
| U11 | An item's prototype supplies its stack size. Vanilla `/open` of another player's inventory is admin-only and says nothing about a standalone NPC character. Force-wide NPC access therefore needs a tested mod UI or transfer action with its own force and reach checks. | [LuaItemPrototype](https://lua-api.factorio.com/stable/classes/LuaItemPrototype.html), [Console commands](https://wiki.factorio.com/Console), [LuaControl](https://lua-api.factorio.com/stable/classes/LuaControl.html) |
| U13 | A force chart tag marks a point and requires that chunk to be charted; `rendering.draw_rectangle` can show a footprint to selected forces when its render mode is `chart` (the default is `game`). Use both, with a Console fallback for an uncharted proposed site. `can_place_entity` checks terrain/entity collision but does not prove connections or supply. | [LuaForce](https://lua-api.factorio.com/stable/classes/LuaForce.html), [LuaRendering](https://lua-api.factorio.com/stable/classes/LuaRendering.html), [LuaSurface](https://lua-api.factorio.com/stable/classes/LuaSurface.html) |
| U13, U14 | A blueprint build call produces ghosts. The Game blueprints tab belongs to the save and is force-shared; My blueprints is personal and cross-save. The 2.0 API exposes game-library records and sparse nested book contents. Recheck a record's content and live placement before creating ghosts. | [Blueprint library](https://wiki.factorio.com/Blueprint_library), [LuaGameScript](https://lua-api.factorio.com/stable/classes/LuaGameScript.html), [LuaRecord](https://lua-api.factorio.com/stable/classes/LuaRecord.html) |
| U14 | The API can create surfaces and forces; editor controller mode is set on a player. A separate force/surface is a usable rehearsal boundary only when every goal, victory event, receipt, and transfer also checks that boundary. | [LuaGameScript](https://lua-api.factorio.com/stable/classes/LuaGameScript.html), [LuaPlayer](https://lua-api.factorio.com/stable/classes/LuaPlayer.html) |
| U17 | `game.finished` denotes the visible victory screen and `finished_but_continuing` denotes play after continuing. Achievement conditions can also cover rocket launches or late research, so the harness must select the relevant save-specific winning trigger instead of treating any achievement as victory. | [LuaGameScript](https://lua-api.factorio.com/stable/classes/LuaGameScript.html), [objective achievement prototype](https://lua-api.factorio.com/stable/prototypes/CompleteObjectiveAchievementPrototype.html) |
| U18 | Construction robots build and repair ghosts when the items are available in their network; logistic robots deliver supplies. Network coverage, available robots, items, and power must be observed before assigning a robot path. | [Construction robot](https://wiki.factorio.com/Construction_robot), [Logistic robot](https://wiki.factorio.com/Logistic_robot), [Logistic network](https://wiki.factorio.com/Logistic_network) |

Remaining engine proofs before declaring U8–U14 implementation-ready: test a
non-admin force member's mod inventory access; map marker visibility and cleanup
on an uncharted/changing site; blueprint enumeration under multiple forces and
nested books; sandbox event/statistic isolation; and a sustained output boundary
under transport blockage. Keep the results and exact running game version with
each implementing commit.

## Work in dependency order

| ID | Owner | Deliverable and completion criterion | Dependency |
| --- | --- | --- | --- |
| U1 | Runtime and Main LLM integration | **No-Jev operating mode.** With no System One/TypeSafe key, startup and Console show the mode plainly. Deterministic code includes mandatory observation, lifecycle, and completion facts; the Main LLM brief carries the routing/recovery guidance Jev otherwise helps select. The Main LLM may be called more often, with bounded budgets and trace reasons. A scripted multi-slice goal completes with Jev absent, and a mid-goal Jev failure follows the same path without losing a committed step. Compare calls, latency, and outcome with Jev on. | Existing Phase 9 Main-LLM-only comparison; 1.10 optional Jev key; 3.4 if using plan agents |
| U2 | Runtime and Console | **Progress without interrupting work.** One immediate acknowledgement, then concise state changes such as observing, planning, moving, building, waiting for production, and verifying. Include current objective and the next expected check when grounded; update or withdraw an estimate when world state changes. Progress is derived from validated intent and runtime events, rate-limited to avoid chat spam, and never claims an unverified result. A slow scripted planner and a long engine operation show timely progress while the work continues. | 2.10 acknowledgement and metrics; 2.6 expected duration |
| U3 | Runtime and provider loop | **Earlier first action.** Measure request receipt → first admission → first world change. After a minimal slice commits, dispatch its first complete validated action immediately; do not wait for optional prose or a later planning round. Explore provider streaming only where a complete tool call can be delimited safely. If that cannot be proven, keep the current complete-response boundary and overlap the next reasoning round with already admitted game work. Scripted tests cover partial arguments, late cancellation, stale epochs, duplicate callbacks, and unchanged committed-plan meaning. | 1.5 budgets; 3.3 reducer; 3.4 slice handoff; existing admission rules |
| U4 | Console UI and runtime | **Player question card.** When a decision belongs to the player, persist one question with a short reason, 2–4 concrete options, a recommended option when justified, and a free-text reply path. Show it in the Console using the blocked/paused interaction pattern; chat may notify but is not the sole interface. Record question ID, goal/plan revision, authorized player, and answer. Duplicate or stale answers do nothing; reconnect/restart restores the card. A plan-changing answer enters explicit revised-plan approval. Static UI and runtime tests cover each path, including no-Jev mode. | Existing blocked-plan controls; 3.3 reducer |
| U5 | Deterministic planning facts and Main LLM | **Time-efficiency frontier for vertical scaling.** Build a bounded production possibility frontier (PPF) of feasible upgrade choices using measured or prototype-derived rates, setup materials, construction/travel time, power, and target quantity/rate. Report total time to target, sustainable rate, break-even point, assumptions, and dominated choices. Do arithmetic in the harness; Main LLM chooses strategy, with optional Jev ranking. Unknown transport or fluid throughput stays unknown rather than guessed. A small job favors the existing setup when an upgrade cannot pay back; a long job exposes the faster upgrade. | W1 rate facts; 2.4 measured modifiers; 2.6 duration estimates; 3.7 world-state goal verification |
| U6 | Goal and roadmap planning | **Horizontal scaling toward the next rate milestone.** For science production, choose the next explicit SPM milestone, build capacity toward it, verify sustained output at a specified consumer or delivery boundary over a named time window, then reassess. Force/surface production statistics are supporting evidence, not proof of one line's delivered SPM. For other production goals use the relevant item-per-minute milestone. The Main LLM owns the route and machine count; Jev may rank bounded candidates. A milestone must fit known resources, power, and verified transport limits, and must not silently replace the player's goal. Scripted cases cover an already-met milestone, a bottleneck, and an unreachable proposed rate. | W3 `production_rate`; W4 scale-out skill; U5 facts |

## Standing gameplay modes and shared-world behavior

The three modes below are standing instructions, distinct from a temporary player
task. A player command can interrupt any mode. Auto includes Maintain's upkeep
abilities; neither mode may silently revise an immutable committed plan or exceed
its authorized area and material scope. The runtime owns the current mode and
pending task-correlated questions as durable state, not a model transcript.

**Maintenance scope direction (owner, 2026-09-28):** the desired end state is
everything on the player's force, including player-built structures. Implement
this incrementally by action class: force-wide observation and diagnosis first,
then bounded routine upkeep, then construction/expansion and teardown only after
their own engine and recovery gates. A temporary implementation limit is a
capability limit, not a permanent designated-area product rule. For the first
Maintain release, refuel and repair may proceed without asking after normal
preflight; expansion and teardown require a player question and approval. Auto
may build as part of its separately authorized committed victory plan.

| Mode | Standing behavior | Resource depletion or threat |
| --- | --- | --- |
| Auto | Pursue the running save's victory condition, choosing a route from grounded game state; also maintain the factory and its defenses. Do not hardcode one victory condition for every mod/scenario. | Diagnose and act within the standing scope; ask when a material goal or plan revision needs player approval. |
| Maintain | Keep authorized production, power, supply, and defense working; replace depleted inputs and expand toward existing production commitments where authorized. Do not start a new victory campaign. | Diagnose and act within the standing scope; ask when the needed work exceeds it. |
| Idle | Follow the selected player, stay at a selected position, or wander within a safe designated area. The harness checks world-save changes once per minute, using bounded/event-indexed reads rather than scanning every entity each time. It sends an unchanged-status digest every 15 minutes and notifies sooner on meaningful changes. Routine checks do not call the Main LLM; Jev is called only for a bounded ambiguous decision that deterministic rules cannot settle. | Present choices before new construction or expansion. An imminent attack may trigger immediate defense without approval; forecast risk alone does not. |

An explicit temporary task suspends the standing mode. When that task reaches a
verified end, SGLuna returns to Maintain by default. If the suspended mode was
Auto, the Console asks whether to resume Auto; no automatic restart of the
victory campaign occurs before the answer. A status-only question does not count
as a temporary task and does not change the mode. Mode changes and task
interruptions are traced with their player and goal identities.

**Emergency priority (owner, 2026-09-28):** an observed imminent attack may
preempt ordinary work in every mode without asking for approval. Preserve the
committed step and exact actor/operation correlation; stop or suspend conflicting
work, defend, verify the threat and world state, then resume the same step where
it remains valid. A structural change freezes the old plan; a replacement version
requires a current standing grant or explicit approval for an out-of-scope change.
Pollution and evolution trends support preparation, but a forecast
alone is not an emergency override. A player command may interrupt any mode,
including an active defense response.

**Task endings (owner, 2026-09-28):** ordinary failures should invoke bounded,
evidence-led harness recovery so Auto can ultimately finish the game without
repeated human help. A retry or plan-agent handoff is not a new player task.
Only a structural blocker, unavailable essential capability, or exhausted
bounded recovery moves to a visible question or pause. Do not quietly switch
to Maintain while a temporary task is unfinished or has uncertain outcome.
Once verified complete, use the mode return rule above.

| ID | Owner | Deliverable and completion criterion | Dependency |
| --- | --- | --- | --- |
| U7 | Runtime, goals, Console | **Mode control.** Add Auto / Maintain / Idle selection and a visible current-mode indicator. Any player on SGLuna's force may switch modes or approve a revision; stale concurrent commands are refused with the accepted player's action visible. Persist mode, Idle follow/stay/wander choice, and suspended mode over save/restart. Define whether the one-minute sweep and 15-minute digest are wall-clock or game-time intervals; a tick-only timer slows with UPS and pauses with the save, so use harness wall time for real-time promises and game ticks for world simulation. A user task interrupts any mode; its verified end returns to Maintain and offers Resume Auto when applicable. Bounded recovery keeps an unfinished task active or visibly paused; it never counts as completion. An information-only request leaves mode unchanged. Scripted lifecycle cases cover switch, temporary task, completion, failure, cancellation, competing players, restart, and no-Jev operation. | U1 no-Jev path; U4 question card; existing pause/follow controls and reducer |
| U8 | Runtime and gameplay planning | **Upkeep and depletion.** Detect stopped production, fuel/power loss, depleted patches, blocked transport, and damaged or missing infrastructure across the player's force from world evidence. In Auto/Maintain, observe force-wide and act only within the currently validated action classes; in Idle, report and ask. First-release Maintain may refuel and repair after preflight, but asks before expansion or teardown. The target is full-force upkeep, including player-built machines. A standing maintenance mandate is not permission to rewrite an unrelated committed task. Engine fixtures cover a working line that stops, a depleted input, and restored verified output. | U7 mode; 3.7 semantic production goals; U4 questions |
| U9 | Console and spatial planner | **Player working in the build area.** Treat a player's recent edits or presence at a proposed site as a conflict signal, then pause that site choice. Offer `wait until I say done`, `use another location`, and `cancel this part` in the question card. Waiting has no guessed completion time; the player can explicitly release it. Re-observe and preflight the area before resuming. Engine/UI cases cover changed entities and a stale answer. | U4 question card; spatial placement validation; U7 mode |
| U10 | Gameplay facts and planner | **Defense as production.** Expose measured pollution in observed chunks, enemy-force evolution on the relevant surface, observed enemy pressure, defense coverage, ammunition flow, repair supply, and replenishment time. Plan turrets, walls, ammo, and power as a resilience/production goal alongside vertical and horizontal capacity choices. An observed imminent attack may preempt work in any mode without approval; Idle otherwise reports forecast risk and asks before expansion. An uncharted or unobserved pollution cloud edge stays unknown. Forecasts state uncertainty and never turn a predicted attack into a world fact. Engine cases cover attack preemption and same-step resumption, ammunition shortage, and a pollution/evolution risk trend. | U5 time facts; U7 mode; combat and production verification |
| U11 | Inventory and logistics, Console | **Shared supplies.** Size production and logistics buffers from actual demand and capacity. Keep at least two prototype-sized stacks of each produced ammunition type in its designated output chest as a replenishment target. Emergency defense may draw below it and must refill it afterward; it is not a hard minimum. Build a mod-mediated inventory UI or request/withdraw transfer for any player on SGLuna's force, checking force membership, same surface, and ordinary interaction reach before each action; a player on another force may not. Do not assume vanilla opening grants non-admin access to the standalone NPC character; test that interaction in the running game. Each withdrawal invalidates stale availability assumptions and forces re-observation before a pending spend. Inventory access and mode/plan authority remain separate checks. Give items directly to a player only on their explicit request; otherwise leave output and overflow in designated storage. Verify counts, actual delivery, and the ammunition stock target. | U7 mode; inventory transfer receipts |
| U12 | Learning and Console | **Learn after player work.** For a registered player task or marked production area with a known goal condition, the Idle harness checks completion from world evidence during its one-minute sweep. When the condition is met, ask whether SGLuna should learn the observed production method. Do not call the Main LLM just to poll; invoke bounded skill extraction only after player approval. Show the observed method, evidence, preconditions, output, and affected area. Do not infer an unregistered goal from player motion or publish a verified skill from one success. The skill remains guidance, not an executable blueprint. Test completed/incomplete areas, a rejected proposal, no-Jev mode, and a player correction. | Existing skill library and verification rules; U4 question card; U7 Idle sweep |
| U13 | Spatial planner, runtime, Console | **Choose and mark a new production site.** The harness returns a bounded set of grounded candidate areas with buildable footprint, resource and water access, power/transport connection cost, walking distance, pollution/defense exposure, future expansion room, and recent player activity or holds. The Main LLM chooses the site and authors its layout; the harness validates geometry and exact placements. Show a force-visible chart tag at the site's charted center and a force-filtered area outline rendered in chart mode plus the exact footprint in the Console with purpose, owner, and stage (`proposed`, `committed`, `building`, `operating`). After the plan commits, place validated construction ghosts for the chosen design; no ghosts are placed while the site is merely proposed. The chart tag is a point marker, so the outline carries the area. Check that the force has charted the center before adding the tag, and use a Console-only proposed marker if it has not. Mark or release changes by goal revision and clear the marker on cancellation. Other players may still edit the world, so re-observe and preflight before every mutation. Tests cover two candidate areas, player conflict, stale reservation, ghost timing, and marker cleanup. | Existing spatial placement candidates and map primitives; U4 questions; U9 player-site conflict |
| U14 | Spatial and learning design | **In-game testing surface and save-world blueprints.** Create a separate surface and a dedicated custom force for SGLuna's rehearsals, using mod-controlled editor-style fixtures; editor controller mode belongs to a player and is not a surface setting. Record the sandbox force's research, recipe availability, and modifiers against the production force; differences invalidate any capability claim until checked in the production world. Filter every production goal, victory event, statistic, receipt, and transfer by force and surface so sandbox entities, materials, receipts, statistics, research, and goal counters cannot satisfy production-world progress. Label sandbox evidence distinctly; success there does not prove the real site has materials, connections, power, or the same terrain. Use the production force's **Game blueprints** library as the save-local, force-shared blueprint source. A captured or imported blueprint becomes eligible only after a player saves it in that tab; an imported string merely held in the cursor, a physical blueprint item, and a blueprint in personal **My blueprints** are not automatically eligible. Enumerate game-library records through the supported runtime API, including nested books, and verify the running Factorio version's API before implementation. Record author/import provenance only when explicitly supplied or observed, otherwise mark it unknown; store a content fingerprint rather than inventing a library revision; re-read and revalidate if players edit or remove a record before placement. Validate each blueprint against the chosen live site before using it. A player-provided blueprint is an explicit design input, never evidence that SGLuna autonomously designed that layout. Keep developer A1 exact layouts hidden from autonomous A2/A3 provider trials, and do not use unrequested external blueprint libraries as hidden solutions. An approved sandbox design may become a candidate skill or blueprint, but every production-world placement and output still needs ordinary admission and verification. | `NPC_PRODUCTION_VALIDATION_ROADMAP.md` A1/A2/A3; U12 learning; U13 site selection |
| U15 | Runtime and goal verifier | **Durable task ledger.** Persist the harness-supplied completion predicate, committed slice/step, exact target and destination identities, material claims, pending operation and receipt IDs, evidence timestamps, question/revision state, and suspended mode. On reconnect/restart, reconcile the ledger with current world state before resuming or retrying; an uncertain command outcome is not success and must not be blindly reissued. Tests cover delivery after a restart, a removed destination, a transfer whose acknowledgement was lost, and an interrupted defense step. | U4 question state; U7 mode; 3.3 reducer; 3.7 goal verification |
| U16 | Runtime recovery and Main LLM | **Bounded scarcity and failure recovery.** Classify a missing material as temporarily in use, replenishing, craftable from observed available inputs, or structurally unavailable. Wait with a recorded next check and release or refresh stale claims; when waiting cannot progress, use a legal recipe-checked handcraft route within the committed plan's authority. Track repeated causes, elapsed time, actions, and evidence of progress so recovery can try a different route, ask on a structural revision, or visibly pause after its budget is exhausted. Never count a wait, retry, or handcraft detour as a new player task or as completion. Tests cover a player withdrawal, later replenishment, a valid manual-crafting route, an invalid recipe, and a no-progress retry loop. | U1 no-Jev path; U5 time facts; U11 shared supplies; U15 ledger |
| U17 | Goal adapter and runtime | **Save-specific win trigger.** At Auto start, the harness identifies the running save's winning objective or relevant achievement trigger and supplies the exact predicate, force/surface scope, and evidence to the planner. Where the scenario exposes victory state, confirm it with `game.finished` or `finished_but_continuing`; do not equate an unrelated achievement with winning. If the harness cannot identify the trigger, show the missing objective and pause Auto rather than inventing a universal rocket goal. Test a normal win, a continuing save, a modded objective, an unrelated achievement, and sandbox activity. | U7 Auto; U15 task predicate; scenario adapter |
| U18 | Construction runtime and spatial planner | **NPC-first building with optional robots.** AIRI carries materials and builds committed placements itself. After robot capability is unlocked, it may use logistic robots for supply and construction robots for ghost building only when a receiving chest is in logistic coverage, the ghosts are in construction coverage, robots and items are available, and the route improves the time-to-result or is needed for reach. Do not assume a standalone NPC character supports player logistic requests; use a receiving chest until proven. Record which actor built each entity, verify the actual entities and connections, and clean up only plan-owned abandoned ghosts after cancellation. Test manual build, unavailable network, logistics supply, robot construction, missing material, and player-built ghosts. | U13 site/ghost lifecycle; U15 ledger; U5 time estimate |
| U19 | Runtime scheduler, Jev integration, Console | **Time-sensitive work queue and Jev QTE.** Default order is explicit player requests, defense, upkeep, then Auto progression. On meaningful events, present Jev with only current runnable candidates and typed urgency/deadline/interruptibility facts; it may rank a quick continue/switch/defer recommendation. The harness applies deterministic authority, class priority, emergency, plan-commit, and revision gates, then records the switch and paused step. A new player command can preempt defense and shows the paused threat and work; other preemptions preserve the exact step and revalidate before resuming. Give Auto bounded checkpoints and aging so repeated upkeep cannot silently strand it. Jev timeout, low confidence, absent key, or stale response uses deterministic scheduling, with Main LLM escalation only for semantic ambiguity. Measure event-to-decision latency, call rate, task outcome, and unnecessary switches against no-Jev. Tests cover simultaneous work, emergency preemption, player override, a long Auto task, restart, stale/late Jev, and no-Jev operation. | U1 no-Jev fallback; U7 modes; U10 defense; U15 ledger; U16 recovery |

Logistic robots are a later delivery mechanism for U11. Keep the same source,
destination, reservation, throughput, and delivery-receipt contract so a future
robot delivery changes transport rather than material ownership rules.

## Week 2 schedule and checkpoints (2026-10-05 through 2026-10-11)

The table below is the Week 2 UX track. Week 1 macro decisions and acceptance
scope are recorded below in the September 30 Q&A section. Reuse verified Week 1
foundations rather than rebuilding them in Week 2; unfinished work must be carried
forward explicitly.

| Checkpoint | Work | Evidence to record |
| --- | --- | --- |
| Early week | Resolve U1 no-Jev contract and U3 action boundary; define U4 question record and Console placement. Specify U7 modes, the U15 durable task ledger and harness completion predicate, U16 recovery stopping rule, U17 save-specific win adapter, and U19 priority/Jev-QTE contract. | Short design decisions, trace fields, baseline timing on a scripted request, mode transition table, ledger schema, delivery/rate/win predicate examples, recovery budget, typed Jev candidates, deterministic fallback, and preemption cases. |
| Midweek | Implement and verify U1–U4 in narrow slices. Start U5 deterministic frontier calculations. Prototype U7 mode and U9 player-site question on the existing UI. | Targeted tests, relevant real-Factorio lane, first-action latency, question-card screenshots or UI snapshots, mode tests. |
| End of week | Finish U5–U6 where dependencies allow. Prepare U8–U19 bounded gameplay contracts and an integrated provider-scripted scenario: no Jev, a long production goal, progress, one player question, a resumed committed slice, and a verified destination or rate milestone. | Exact commands, SHA, trace, elapsed time, calls/usage, state before and after the answer, unresolved limitations. Live-provider comparison only after owner authorization. |

If the current plan's reducer, duration, or rate dependencies are not ready, keep
U3, U5, or U6 at design or deterministic-fixture state and carry implementation
forward explicitly. Week 2's minimum reviewable checkpoint is the U1 no-Jev
contract, U2 progress behavior, U4 question-card contract, U7 mode contract,
and U15 completion/ledger contract
with scripted tests; do not claim the integrated scenario passed from partial
component tests.

The integration owner reviews each diff, keeps this checklist current, and runs
the repository's existing validation gates after integration. Bounded component
work may be assigned separately, but no persistent agent or background run is
created by this plan.

## Questions to settle during U1–U19

1. Which Jev recommendations can be replaced by deterministic defaults, and
   which need an extra Main LLM turn in no-Jev mode? Record the behavior per
   decision point; do not make an absent Jev key look like a provider failure.
2. What is the earliest provider protocol boundary that yields a complete,
   immutable action? If streaming cannot guarantee this, measure the gain from
   shorter plan slices and overlapping reasoning before adding streaming.
3. Which player questions truly need an answer? Routine optimization stays
   autonomous. Ambiguous goal meaning or material revision can pause for a
   question; an optional preference should not stop a healthy committed step.
4. What is the first science SPM ladder? Choose milestone values from a verified
   starting production rate and measured capacity, not an arbitrary universal
   number. Keep the player's explicitly requested rate authoritative.
5. First-release Maintain may refuel and repair across the force; expansion and
   teardown ask first. Define exact repair eligibility and recovery when a
   player changes the target during the operation.
6. Any player on SGLuna's force may access its inventory, change mode, or
   approve a revised plan. Verify force membership at each interaction; reject
   stale commands by revision and show whose command took effect.
7. Idle checks a known player task/area once per minute and proposes learning
   only after its known world-state goal is met. A player approves before
   skill extraction. Define how the player registers a task or area when no
   deterministic goal predicate exists; do not infer success from motion alone.
8. Idle does not make routine Main LLM calls and minimizes Jev calls. The
   harness checks once per minute, gives an unchanged-status summary every
   15 minutes, and notifies immediately on urgent changes. Define a safe
   wandering area.
9. The ammo-output chest target is two full stacks using the running game's
   stack size. Emergency defense may draw below it and must replenish afterward;
   it is a target, not a hard reserve.
10. The testing surface is a separate in-game surface with a custom force and
    mod-controlled editor-style fixtures. Editor fixtures stay there and never satisfy production-world
    goals. A proposed site appears as a map area marker; ghosts appear only
    after commit. Player-provided blueprints captured here or imported and
    then saved here are eligible, after live-site validation. Preserve the
    hidden developer A1 fixture boundary and label player-supplied designs.
    Confirm that the blueprint is in the production force's save-bound Game
    blueprints tab; an imported string must be saved there before eligibility.
    Verify the API's force scope, nested books, and changes or deletion between
    selection and use.

## Macro Q&A decisions (2026-09-30)

Owner decisions from the project audit and Q&A. These are product requirements,
not implementation or validation evidence. They refine the earlier Auto authority
and task-interruption contracts; older planning/delegation documents still need
reconciliation before implementation. This record does not authorize a live
provider run, deployment, or a message to another worker.

### Standing Auto mandate and plan authority

Auto needs an ongoing mandate to expand resource gathering throughout the game,
not a mandate limited to an initial resource area. It may discover and develop
new deposits, connect mining and transport, extend power and processing, replace
depleted sources, and prepare defenses in service of the save-specific victory
condition. Concrete actions remain bounded by validated capabilities, current
world facts, player constraints, and ordinary admission checks.

Routine expansion and recovery within that mandate should not require repeated
player approval. Committed slices remain immutable: a changed semantic route
requires a new plan version with lineage, reason, and preserved verified evidence.
The Auto mandate can authorize such a version within its permitted scope; a change
to the requested outcome or an action outside that mandate still needs the player.
This refines the older rule that every structural revision needs a fresh user
approval. The exact authorization schema and recovery limits remain to be designed.

- Auto may build and connect new infrastructure independently. It must ask before
  removing or substantially redesigning player-built structures.
- Every expansion or proposed redesign gives a concise reason grounded in observed
  state. A redesign question identifies the change, benefit, disruption, and a
  viable alternative when available. Ordinary expansion explanations are progress
  feedback, not an additional approval gate. Report urgent emergency reasons as
  soon as practical without delaying already-authorized defense.
- Auto may spend materials from shared factory storage by default, excluding player
  inventories and explicitly reserved supplies. Recheck live availability before
  spending; a player withdrawal invalidates an old availability assumption.

### Recovery authority for temporary player tasks

Owner decision, 2026-09-30; Week 1 macro requirement. A temporary player request
also authorizes necessary supporting work and a changed approach when the original
requested result remains the same. If an NPC furnace is destroyed or a resource
source is depleted during a request for 100 plates delivered to a named chest,
the NPC may find another source or build replacement infrastructure without a
fresh approval for the route change.

Preserve the original completion predicate, destination, material restrictions,
and verified progress. A semantic route change creates a new committed plan
version with lineage; do not mutate the old plan or count uncertain operations as
success. Normal actor/epoch, capability, preflight, receipt and recovery gates
still apply. Ask when the requested result must change, reserved supplies are
needed, or removal/substantial redesign of player-built structures is required.

Tell the player what happened along the changes: the observed failure or shortage,
its effect on the task, the replacement approach and reason, and any revised
estimate supported by current evidence. Report meaningful changes promptly and
concisely; do not notify on every low-level retry or present an unverified outcome
as completed. Example: "The furnace was destroyed. I am building a replacement
and will still deliver the 100 plates to your requested chest."

### Interrupted tasks and work awaiting a decision

- A new temporary task interrupts and preserves the previous unfinished task;
  interruption is not cancellation. Explicit cancellation ends the selected task.
- Resume interrupted temporary tasks automatically in interruption order, after
  reconciling outstanding operations and revalidating world state. Example:
  deliver coal, then resume the interrupted 100-plate request.
- Preserve the task's original completion condition, exact targets, committed
  slice/step, verified progress, pending operations/receipts, and question state.
  The future Roadmap Shelf is separate from this suspended-task ledger.
- After all temporary tasks finish, retain the existing return rule: Maintain,
  with an offer to resume Auto when Auto was suspended. A failed, blocked, or
  uncertain task has not finished and does not trigger that return rule.
- A question blocks only the affected work. Continue independent, authorized
  upkeep or other runnable tasks that cannot interfere with the pending decision.
  Do not silently return to an unauthorized campaign or rewrite the blocked plan.
- Keep blocked and interrupted tasks visible and eligible for reconsideration;
  background work must not make them disappear or starve them indefinitely.
  Answers must be correlated with the affected task, question, and revision even
  while a different task is executing.

### Shared campaign provider allowance

Owner decision, 2026-09-30; Week 1 macro requirement. Planner, executor and Jev
share one persisted campaign usage allowance, including supporting work and
recovery. A new slice, request, task, replacement plan, context, budget generation
or restart does not replenish it. Keep the existing per-request/hourly limits too.
Trace each provider's usage and attribution; do not guess prices or treat missing
usage as zero. Exact amount, accounting unit and warning threshold are undecided.

On exhaustion, visibly pause provider-dependent work and notify the player. No
fresh-context retry or fallback provider may bypass the allowance. Safe already-
admitted work and independently authorized deterministic upkeep/defense can still
continue without new provider calls. An explicit extension or renewal is needed
to resume charged work; the lifetime ledger remains intact.

This is a spending guardrail, not a quoted cost to win, a prepaid allocation, or
authorization to spend a selected amount. No base-game victory run has measured
the complete campaign's usage. See the macro design §4 for accounting requirements.

### UI follow-up noted; layout discussion deferred

The owner requested visual feedback showing what each prompt is doing, while
explicitly keeping this Q&A focused on the macro work for this week. Record this
against UX U2/U4/U7/U15; no layout choice or UI implementation is approved here.

Desired feedback includes runtime acknowledgement, current execution phase,
verified progress, interruption reason and resume order, a pending decision and
its reason, and verified completion or a visible failure. Distinguish the NPC's
current work from the state of each request. Derive feedback from harness events
and receipts, preserve request/task correlation through switches and restart,
and do not present model prose or a spinner as evidence of world progress.

### Week 1 macro scope and acceptance evidence (2026-09-28 through 2026-10-04)

The accepted macro decisions above define requirements for the current week
(2026-09-28 through 2026-10-04), not a generic future backlog. This week's work
should make the harness able to authorize Auto expansion and new plan versions,
protect player-built infrastructure and reserved supplies, recover temporary
requests without changing their result and report meaningful changes, preserve and resume
interrupted tasks, and isolate work awaiting a player decision so other authorized
work can continue. Persist and enforce the shared campaign provider allowance.
Give actions and proposed changes grounded reasons.

The integration checkpoint should exercise these behaviors on a bounded,
multi-slice production task: planner/executor handoffs, task interruption and
resumption, a pending question while independent work continues, restart and
operation reconciliation, no-Jev fallback, and world-verified delivery or output.
Include campaign exhaustion across handoff/restart with no further provider call.
Record implementing commits and the integrated evidence; component tests alone
are not proof. If a requirement cannot land this week, identify it explicitly as
carryover rather than silently treating the accepted decision as later work.

Continuous resource expansion is the campaign policy being established; a full
playthrough to victory is not the week's acceptance test. The UI feedback request
is recorded for follow-up; layout design is outside this macro Q&A. The production
roadmap's cold-start electricity and promotion gates remain separate recorded
requirements, and their exact scheduling is not changed by this note. No paid live
run is authorized by this Q&A.

## Deferred

Conversational interruption features beyond the Week 1 task-ledger contract,
player-forced skills, multiple NPC
bodies, logistic-robot execution, and broad sustained-throughput optimization
remain later work. Basic pause, stop, cancellation, and stale-work safety
continue to apply now.
