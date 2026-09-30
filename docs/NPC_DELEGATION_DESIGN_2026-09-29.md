# Delegation inside one NPC: design note (plan item 3.1)

Status: **design for owner review, 2026-09-29. Nothing here is built or approved.** It
answers `NPC_PLANNING_ROADMAP.md` "Agent split" and the "Monday discussion proposal" in
`PARALLEL_PRODUCTION_WORK_PLAN.md`. Where the older row 3.1 text (per-role env settings)
disagrees, the owner's 1.10 settings win. Claims marked **(unsure)** were not verified.

## 1. The decision in one paragraph

A long goal runs as **many short conversations over one durable state**. At defined
checkpoints the harness discards the running conversation and starts a fresh one from a
**handoff packet** it builds from reducer state (not the transcript, not a model summary).
Two conversation roles share one body, one at a time: a **roadmap agent** on the main model
(`OPENAI_MODEL[0]`) that authors goal, shelf and plan drafts, and a **plan agent** on the
subagent model (`[1]`, falling back to `[0]`) that carries one committed plan. Jev takes
routing, ranking and observation selection where TypeSafe judgment fits. No concurrency yet.

## 2. What exists today (the seams)

- **One conversation carries the goal.** `continueFromModMessage` appends a `[MOD]` user
  message to the same `this.messages` after a slice closes (`npc-agent-loop.mjs:5598`,
  called from the `next_shelf_slice` wake at `:5675`). Only `compactWorkingContext` bounds
  it (`:2551`): it folds old tool exchanges but never discards the thread.
- **Two restage mechanisms already exist, both narrow.** (a) A reasoning-epoch bump rebuilds
  `baseMessages` from durable memory (`refreshPlanningReasoningEpoch`, `:2608`); the reducer
  bumps it only on goal accepted, roadmap revised, plan superseded, revision approved and
  plan cancelled (`planning-state.mjs:357`), deliberately **not** on healthy execution
  (2026-09-19 decision 6). (b) The budget handoff replaces messages with
  `providerBudgetHandoffCapsule` (`:2287`, applied at `:8681`), built from the legacy task
  board, not the reducer. This note generalizes both into one `restage()` and one packet.
- **Budgets.** The generation counter rolls at step close but keeps the same messages
  (`:6044`); the request ceiling is 5x the per-turn cap (`:2136`, `:6104`). Effort and
  output brackets: `provider.mjs:68`, `:164`.
- **Cache layout** (2.9): tools, system, request context, history, then tail; breakpoints at
  the end of system and of request context (`prompt-prefix.mjs:138`). `role_switch` and
  `continuation_reset` are already expected prefix breaks (`prefix-report.mjs:15`).
- **Model list** is parsed (`supervisor.mjs:131`, `:199-201`); nothing reads `subagentModel`
  yet. Capability resolves per call from a config object (`provider-base.mjs:508-533`), so a
  role config is `{...config, model: models[i]}`.
- **Jev** already routes at step boundaries (`post_step.routed`, `:4418`) and shadow-ranks
  skills (`skill-offers.mjs:38`).
- **Recovery entry points** for restart and actor replacement: `recoverInterruptedPlan`
  (`supervisor.mjs:2344`, called at `:2640`, `:2796`).

## 3. Shape

```text
        reducer (planning-state.mjs)  =  the only writer
   goal | shelf | committed plan | evidence | receipts | usage ledger
     | ^                                   | ^
 build| |events                        build| |events (ops -> receipts)
 packet| |                              packet| |
     v |                                   v |
 ROADMAP AGENT  model[0]              PLAN AGENT  model[1] (else [0])
 fresh per node pickup:               fresh per committed slice / step:
 pick node, draft slice               observe + operate one committed
     \____ validate, time review, commit ____/   plan; never authors plan
 Jev (TypeSafe): route, observation families, skill rank, scope critique
 one body: one actor_id + epoch; exactly one conversation may act at a time
```

Swarm mapping (`SWARM_COORDINATION_ARCHITECTURE.md` §4, §6.3, §16): the committed plan is
the work item; a plan agent's return is a `WorkResult` with evidence refs, never a claim;
the packet is the §16 "bounded agent decision packet". Claims and reservations (§7, §14) are
not needed while one conversation acts at a time; the records keep their shape for a second
body.

## 4. Checkpoints and handoffs

A restage discards `this.messages`, rebuilds base messages from system prompt plus one
`[HANDOFF]` block, resets observation/duplicate counters (as `:2626-2635` does), and traces
`context.restaged` with `request_id`, `checkpoint`, `role`, `handoff_id`, packet hash and
size. It never changes plan semantics. Late replies from a discarded conversation are
dropped by `handoff_id` plus actor epoch and traced.

| # | Checkpoint | Trigger seam | Packet adds beyond the common core (section 5) | Who wakes next |
|---|---|---|---|---|
| C1 | Slice/plan closed | `settleCompletedStepState`, after `evaluateGoalCompletion` (`:5638`) | closed plan's verified evidence refs, goal progress per `doneWhen`, time estimate vs measured, usage of the slice | harness: goal met -> done; unmet -> C2 |
| C2 | Shelf node picked up | `next_shelf_slice` wake (`:5675`), plus goal admission | candidates from `shelfRefinementCandidates` (`planning-state.mjs:1067`), steering context, node verified results, shelf-pickup skill cards (2.8) | roadmap agent drafts a slice |
| C3 | Slice committed | after `commitPlan` validation and time review (`:7570`) | the immutable plan, step 1 contract, loaded-skill refs | plan agent |
| C4 | Step closed | step verified by the completion gate | next step and contract, evidence of the closed step, refreshed facts; the plan-level block is byte-identical (cache) | Jev route first: `continue`/`wait` -> no LLM wake; `observe`/`replan` -> fresh plan agent |
| C5 | Budget or ceiling pause | `pauseAtProviderBudgetCap` (`:6121`), handoff (`:8681`) | active step, what the reducer recorded during the exhausted thread, reason code | generation cap: same role, fresh thread, up to `maxProviderBudgetHandoffs` (default 4); ceiling: visible pause, Resume restages |
| C6 | Blocker | structural blocker confirmed | blocker reason code, verified prefix, carried-forward evidence | **the user** (Revise / Keep / Cancel). Approved revision -> roadmap agent (C2 shape). Ordinary bounded recovery keeps the semantic step: fresh plan agent, no user interruption |
| C7 | Restart, actor replaced, death | `recoverInterruptedPlan` (`supervisor.mjs:2344`) | fresh actor snapshot with new epoch, persisted plan state | plan agent if a plan is active, else pause with chat line |
| C8 | Size/turn safety net | after one compaction fold, or N rounds in one thread | same as the last checkpoint kind, current step | same role as before |

C8 numbers are **(unsure)**: start at "second fold needed" or 24 rounds, and set both from
the first live run. `context_window` from the `local` profile is not yet read by compaction
(plan row 1.9), so C8 must read it.

The reducer's `reasoning_epoch` keeps its meaning (plan lineage). Restage is recorded as its
own ledger event (`CONTEXT_RESTAGED`, no plan effect), so 2026-09-19 decision 6 stands.

## 5. The handoff packet

Built by one pure function from reducer state plus explicit runtime records; same input,
same bytes, same hash. Bounded (start 6,000 characters **(unsure)**; larger inputs are
dropped by a fixed priority order, never truncated mid-record).

- **Mandatory, deterministic, never Jev-filtered:** `handoff_id`, checkpoint kind, role,
  `goal_id`, plan id/version, active step id, `actor_id` and epoch; goal definition
  (`scope`, `doneWhen`) and progress; committed plan steps, active step and completion
  contract; last N verified evidence refs and receipts; blocker and failure reason codes;
  runtime/task state; inventory and position summary; the role's budget line (effort, cap,
  remaining ceiling).
- **Selected facts:** deterministic fact families the step needs (recipes, nearby
  entities, entity status, research). Deterministic default first; Jev picks families
  later (section 7).
- **Skills:** ids and revisions of loaded skills, plus the compact 2.8 cards; skill text
  loads through `getSkillDetails`, not the packet.
- **Annotation (optional):** at most 500 characters of the ending thread's own note,
  labeled unverified. It can never be the only carrier of state.
- **Layout:** plan-level block first (goal, plan, skills), step-level block second, both
  before the tail. The plan-level block does not change across step restages, so the
  provider cache still hits up to it.

## 6. Models, budgets and cache prefix per role

Settings stay exactly the owner's five (`AI_API_METHOD`, URL, model list, key, Jev key).
**No new env settings.** Effort, caps and thresholds are code constants beside the existing
brackets; `MAX_PROVIDER_REQUESTS_PER_HOUR` and `MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN` stay
the two global caps.

| Role | Model | Effort and cap (existing brackets, `provider.mjs`) | Ceiling | Prefix (identical across conversations of the role) |
|---|---|---|---|---|
| Roadmap agent | `[0]` | `plan_authoring` max / 40,000; `new_goal` high | per slice, see Q3 | system + planning tools |
| Plan agent | `[1]`, else `[0]` | gather low / 6,000; `same_goal_continue` 8,000; bounded recovery replan 16,000 | per slice | system + execution tools |
| Jev | TypeSafe (`DECISION_PROVIDER_*`) | own provider | own limits | not applicable |

The roles have different system messages and tool blocks, so a role switch is an expected
prefix break (`role_switch`); what must stay stable is the prefix within a role across
restages. Role-specific tool blocks are the 2.9 rule. Whether the plan agent's tool surface
can drop plan-authoring fields without splitting `submitPlan` is **(unsure)**; the contract
check "operations for a committed step only" belongs in 3.4. Providers with a
model-family-dependent profile resolve per role from the role config; on the `direct`
method, a `deepseek` profile chosen from the host would also apply to a `[1]` of another
family **(unsure)**.

A plan agent's input is roughly packet plus rounds since the last restage, not the whole
goal; the steam run's 904k input units in one request is the case to beat.

## 7. Jev first, in order shadow -> advisory -> gating

Authority unchanged: Jev selects, ranks, classifies, routes. It never builds the packet's
facts, mutates a committed plan, advances the tracker or declares completion.

| Judgment | Now | Path |
|---|---|---|
| Step-boundary route (continue / observe / replan / wait) | active (`:4418`) | decides whether C4 wakes any LLM; measure LLM wakes avoided |
| Observation families for the packet (11 families, threshold 0.5, cap 4: `jev-decision-taxonomy.mjs:15-40`) | exists for observation budgets | shadow: compute at each restage, compare with the lookups the agent then actually makes; advisory: add Jev families to the mandatory set; never remove mandatory ones |
| Skill card order | shadow (`skill-offers.mjs:38`) | advisory ordering inside the packet |
| Next shelf node at C2 | deterministic nearest target plus advisory steering | Jev ranks the complete `shelfRefinementCandidates` set, advisory |
| Scope critique of drafts | existing authority | unchanged |

Promotion needs traced agreement with later outcomes over a stated sample. A judgment that saves no context, calls, time or recovery cost is
removed. Checkpoint triggers, mandatory fields and size limits stay deterministic code.

**Owner decisions, 2026-09-30 (build unit U11, after U6):**

- **Why Jev comes back.** In the live flash run of 2026-09-29, Jev was healthy (31 requests, no fallbacks, 150–280 ms) but saved no LLM wake. The C4 gate chose `targeted_observation` 24 times out of 24, because `continue`/`wait` are allowed only while authoritative runtime work is already running, and an ordinary step close has none. U11 fixes that with a new route, `next committed step is clear -> straight to the executor, no planner wake`, which starts in shadow.
- **Also in U11:**
  - shadow observation families per restage packet (they may only add to the mandatory facts);
  - advisory ranking of the next shelf node at C2;
  - skill card order stays in shadow.
- **Promotion thresholds:**
  - A judgment that acts on its own (for example skipping the planner) needs at least 60 judgments at 90% agreement or better before it may decide.
  - An advisory judgment needs at least 30.
- **How agreement is scored.** Against the outcome, not only against the LLM: did the planner choose the same next step, did the step verify, did the fresh agent actually need the facts Jev chose.
- **After promotion.** Tracing continues, and a judgment that falls below 90% is demoted automatically. A judgment that turns out to be fully predictable from state may become deterministic code.
- **Success metric.** The LLM input and output tokens and the wakes saved per run, reported in the run record.
- **Unchanged.** Fact reads stay ungated (`a22cb415`). Jev never authors plans, advances the tracker or declares completion.

## 8. Sequential first; before concurrency is allowed

Concurrency stays off until all hold: (1) a live run shows restaged goals reach the same
verified results as one thread; (2) the reducer is the only writer and work-item/result
records have revision protection; (3) lane reservations are enforced in admission, with an
engine test that two operations are admitted only when the body can do both (walk plus
hand-craft); (4) `handoff_id` and actor epoch are on every operation and receipt; (5) the
hourly request cap is counted across agents; (6) disjoint lanes come from deterministic data,
not a model; (7) run-ahead has an assumed-outcome comparator.

## 9. Minimum of 3.3 needed first

Full Phase 8 removal is not needed. The packet builder must read only reducer state plus a
few runtime records, each with one write path.
Today the budget capsule reads `state.task_board`, `state.persistent_runtime` and durable
locators from the legacy plan (`npc-agent-loop.mjs:2312-2316`); `provider_recovery` and
evidence recording also live on that side (`canonical-task-board-memory.mjs:1530`).
Minimum: (a) those records get reducer-side or single-writer runtime storage; (b) every
agent output reaches state through `dispatchPlanningEvent` (`:463`); (c) `CONTEXT_RESTAGED`
exists as a ledger event; (d) the legacy board is a read-only projection (`syncPlanningState`,
`:388`, is already one way for steps). I did not audit every legacy writer **(unsure)**;
that audit is the first task of 3.3.

## 10. Testing

**Static scenarios** (scripted model replies, fake Factorio, deterministic assertions, using
`task-loop-fixtures.mjs`, `steam-run-fixtures.mjs` and the slice-boundary and death tests).
Every scenario asserts: a `context.restaged` event with `checkpoint`, `role`, `handoff_id`;
the next provider request contains the packet and none of the earlier messages; the packet
is byte-equal to the golden built from the same reducer state; committed plan and tracker
are unchanged by the restage.

- C1/C2: a slice completes with unmet `doneWhen`; the roadmap agent starts fresh with the
  candidate set.
- C3/C4: commit then step close; a `continue` route makes zero provider calls; `replan`
  yields a fresh plan agent with a byte-identical plan-level block.
- C5: cap overflow restages the same step up to the handoff limit; the ceiling gives a
  visible pause plus Resume, then a restage.
- C6: a blocker wakes no model until a user choice; approved revision starts a roadmap
  agent; bounded recovery restages the plan agent silently.
- C7: restart and actor replacement; a late reply from the old conversation is dropped and
  traced; zero connected humans stays valid.
- C8: a fixture at the size threshold restages instead of a second fold.
- Model list: `[1]` absent falls back to `[0]`; each role's request carries its own model.
- Packet: mandatory fields always present; over-size drops by priority.

**Live** (owner's go each time; the 2026-09-29 off-peak flash run is the first). (a) One
long-scope goal: record shelf nodes, slices per node, plan lengths, restages by kind.
(b) A few small goals through C3/C4/C7. Measured per slice and per role from the 2.7 run
record and 2.11 checks: input units (cached and missed), restage count, cache hit,
time to first action (2.10). **Gaps to close first:** run-record rows are per request and
carry no `role` or `handoff_id`, so per-slice and per-role figures need those fields on
round rows. Add `run-check` signatures for a restage loop (many restages, no step progress),
an over-size packet and a dropped stale reply. Target: no request approaches the steam
run's 904k input units; other thresholds set from the first run **(unsure)**.

## 11. Implementation order

| Order | Item | Size | Independent unit? |
|---|---|---|---|
| 1 | 3.2 swarm branch audit (read-only) | S | yes, any time |
| 1 | 3.8 tracker lag (the packet's active step must be authoritative) | S | yes |
| 2 | 3.3 minimum (section 9) | M | after audit of writers |
| 3 | 3.4a pure packet builder and `restage()` with golden tests, unwired | M | yes, on reducer state |
| 3 | 3.4b role config: `[1]` fallback, per-role brackets, trace | S | yes |
| 4 | 3.4c wire C7 and C5 (they already discard; replace the capsule) | S each | one at a time |
| 5 | 3.4d wire C3 then C4 (plan agent), then C8 | M | after 4 |
| 6 | 3.5 roadmap agent (C1, C2, drafting on `[0]`, W2c stays there) | M | after 5 |
| 7 | 3.6 Jev shadow probes: observation families, next-node ranking | S-M | after 3.4a |
| 8 | 3.9 compact lookups feed the packet's facts | L | parallel; uses 2.12 ranking |
| 9 | 3.7 rate and power goals | L | independent of delegation |

3.4 splits from one row into a-d so each can merge alone. First live run after step 5.

## 12. Open questions for the owner

1. **First delegation unit.** One committed slice, or restage at every step close (C4) as
   the owner's list says? C4 costs a fresh thread per step; the shared plan-level block
   should keep most of the cache, but only a live run shows it. Default: on, measured.
2. **Who drafts a slice.** The roadmap agent on `[0]` (this note) keeps expensive
   authoring rounds on the strong model. Alternative: `[1]` drafts and `[0]` only owns the
   shelf. Which?
3. **Request ceiling scope.** 1.5's 5x ceiling is request-wide; a long goal would hit it.
   Reset it per slice (goal-level spend stays the 2.7 warning)?
4. **Annotation allowed?** May the ending thread leave a 500-character unverified note in
   the packet, or should packets carry no model prose at all?
5. **Jev promotion evidence.** What sample size and agreement rate promote a judgment from
   shadow to advisory?
6. **Reasoning epoch.** Keep `CONTEXT_RESTAGED` separate from the plan-lineage
   `reasoning_epoch` (this note), or extend the epoch to bump at every checkpoint?

### 12a. Owner answers (2026-09-29, Q&A before the weekly reset)

1. **When to restage: size plus slice.** Once the context passes a soft size limit, the
   harness restages at the next slice close. A hard limit, about 2× the soft one,
   restages at the next step close, so one long slice can't grow without bound.
   Restaging at every step close (C4) is not the default.
2. **Roles.** `[0]` drafts the roadmap and plan slices; `[1]` executes steps and falls back
   to `[0]`. This is the same as the note.
3. **Ceiling.** The request ceiling resets per slice.
4. **Handoff note.** Allowed: at most 500 characters, marked unverified in the packet.
5. **Jev promotion.** Shadow, then advisory, then decision loop. Each stage needs at least
   30 judgments with at least 90% agreement.
6. **Reasoning epoch.** `CONTEXT_RESTAGED` stays a separate event. The owner's reason: the
   point of delegation is to keep the **planning agent's** context long-lived and
   uncluttered, while disposable work goes to executor subagents that are thrown away.
   So restaging targets the executor side mostly, and it is not a plan-level reasoning
   reset.

Related decisions from the same session:
- **Tools-off rounds (live finding 3).** Keep tools visible on closed rounds and salvage
  calls made there. A world-mutation call, whether structured or DSML text, becomes
  validated plan operations for the committed step. An observation call gets one extra
  bounded look if Jev's observation budget allows.
- **Live models (owner, 09-29, replaces the earlier `deepseek-v4-pro` choice).** DeepSeek
  flash only, for both the roadmap/planner agent and the plan/executor subagents. There
  is no pro drafting model and no mixed-model run. The `[0]`/`[1]` role mapping stays as
  a mechanism; the live config sets one model, so both roles resolve to flash.

### 12b. Implementation notes: U4 restage seam (2026-09-29)

Built in `agent-context.mjs` and `NpcAgentLoop.restageContext`; nothing calls the seam yet (U5-U8 wire the checkpoints). What the code guarantees, and what it leaves to callers:

- **One active conversation.** The loop's `messages`/`baseMessages` live in one `AgentContext` (role, model, handoff id, per-conversation counters, monotonic size counter). A restage swaps that conversation in place: system prefix, then the packet stable block, then its volatile block. Every lineage start and restage takes the next value of a monotonic conversation sequence; a handoff id already used in the lineage is refused.
- **Restage is sequential.** `restageContext` refuses (typed result plus a `context.restage_refused` row) while a provider round is in flight, while a turn holds the current conversation unless the caller presents that turn's token, when the packet's plan is not the active plan, and when the reducer rejects the event. The token is `restageContext({ safePoint: this.turnToken })`: it must be the identity of the current open turn's marker and not stale; `true`, a copy, an older round's token, or any token when no turn is open is refused as `round_open`. **Contract for U7/U8:** call it only from the running turn's own call chain, after the last model reply has been fully admitted and appended (after `commitPlan`/`executeAuthorizedBatch` and its `messages.push`) and before the next `callProvider`; a test restages at exactly that boundary (after an observation round, before the next round). Refusals change nothing. The guard covers a round only while `callProvider` runs and while a turn is open (marker cleared when the outermost `runTurn` or `runGuarded` ends); a caller that bypasses `restageContext` (swapping through `agentContext.restage`) is covered only by the stale-reply defence below.
- **Stale replies (defence in depth).** A request is stale when a restage replaced its conversation after it was sent, judged by the sequence, not the id. The check runs when the reply arrives, in `assertCurrent` (before every admission, including directly before `executeAuthorizedBatch`), before the tool batch's assistant message is appended, before closed-round salvage and before an output-budget recovery retry (a dropped retry also clears its in-flight recovery marker). A stale reply or error is traced (`context.stale_reply_dropped`, attributed to its own conversation) and never appended or admitted. It does not itself reset the active conversation: the turn is re-driven on it, at most twice. After that the request stops with `provider_stale_reply_after_restage`, a provider failure the normal pause and `request.failed` paths report (not a cancellation); that path may pause the goal or reset the loop, so its text promises only that the goal and plan state are unchanged and Resume restarts from them. Its output units count request-wide but not against the active budget generation. A reply that outlives a reset (a new lineage) is left to the existing generation check.
- **Attribution gate (byte-identical default).** `role` and `handoff_id` appear on provider request/response/error rows, and `role` on the provider call context, only after the current lineage has restaged once (a stale reply is always attributed). A run that never restages writes the rows and sends the requests it did before U4 (pinned by `fixtures/context-restage/no-restage-steam-replay.golden.json`). Every reset starts a planner lineage, unrestaged again.
- **Restage order and effects.** Validate the packet, dispatch `CONTEXT_RESTAGED` (the ledger entry stores the `handoff_id` the trace carries), swap the conversation, reset the loop counters, write `context.restaged`. Loaded skill context is kept; the generation/request budget counters are not reset here (that is the per-slice ceiling unit). Trace rows carry the open request id; between requests there is none, so callers pass `requestId` or the rows are invisible to every run-check detector.
- **One sanitizer.** `durable-text.mjs` holds `sanitizeDurableModelText` (and `cleanMemoryText`, `sanitizeDurableModelValue`); durable memory and the handoff note both use it. It redacts the whole text and only then truncates, so a cut can never leave a partial unit number. Durable memory output changes only in that edge (text longer than its cap that carries an identity near the cut).

### 12c. Implementation notes: U7 planner wiring (2026-09-30)

The planner conversation is the long-lived one. U7 wires it to the U4 seam at the slice-close wake and gives it one harness-built message instead of raw traffic. What the code does, and what it leaves for U6 (the executor):

- **Role tagging.** Planner rounds run on `models[0]` through `Session.roleProvider`. `role: 'planner'` goes into the provider call context (`providerRoleFields`) once delegation is active (the U4 rule) or when the config runs the roles on different models (`AgentContext.rolesDiffer`, fed by the supervisor's `agentRoleConfig`), which is where `roleProvider` needs it. With one model in `OPENAI_MODEL` (the live flash-only config) both roles resolve to `[0]`, so naming the role changes nothing and it is not sent: the never-restaged golden passes unregenerated. There is no new setting.
- **Verified-results message (`verified-results.mjs`, pure).** At each slice-close wake, `settleCompletedStepState` appends one `[VERIFIED_RESULTS]` block to the existing `[MOD]` slice-completed message: the closed plan's steps with accepted evidence refs and the receipts the reducer's ledger holds, goal progress per `doneWhen` (the game reading `evaluateGoalCompletion` just took, or "could not be read"), and estimated versus measured time per step (the harness estimate and the wall clock `PlanTiming` records at a step close; a step with no game-rate estimate says so). It reads reducer state and those two explicit records, never `task_board` and never the message history, is bounded (3,600 characters; whole records drop, receipts first), and says it is evidence for the slice only: goal completion still goes through `evaluateGoalCompletion`.
- **Until U6 exists, execution traffic still lives in the one conversation.** So U7 is about size, not about a separate executor thread. Below the soft limit the history is left as it is and the wake only gains the verified-results block. Past it, the slice-close wake restages the planner: the conversation becomes the system prefix plus the packet, and the wake message follows as its first new message.
- **Size and limits.** The size is `AgentContext.sizeTokens` (U3/U4: the larger of the provider-reported input tokens of any request since the last restage and chars/4 of the growth, monotonic). It includes the fixed prefix (system prompt and tool schemas). The soft limit is `restageSoftLimitTokens(role)`: an explicit `restageSoftLimitTokens` loop option (a number or `{planner, executor}`) wins; otherwise it is **prefix-aware**: the fixed prefix plus the working-context ceiling in tokens (`maxWorkingChars / 4`), so the limit measures what the conversation grew beyond its prefix. The prefix is `AgentContext.prefixTokens`: measured from the first reply that reports input tokens (input minus chars/4 of the messages after the system prompt, never below the system prompt's own chars/4), else chars/4 of the system prompt. It is kept across restages. The hard limit is 2x, applied by `decideRestage`. A bare `maxWorkingChars / 4` default was wrong for every provider except `local`: only a profile that declares a `context_window` (today `local`) scales `maxWorkingChars`; DeepSeek, OpenAI and OpenRouter keep the 40,000-character default, a 10,000-token bare limit that the real system prompt (about 58,000 characters) already exceeds, which restaged every slice close. (An earlier version of this note said the fallback applied only before the first response reports a window; that was incorrect.) With a real prompt, about 14.6k prefix tokens plus 10k gives a soft limit near 25k tokens before tool schemas are counted. Tests use the real `prompt.md` and guidance.
- **Checkpoint.** `decideRestage` (boundary `slice_close`) decides. The restage is recorded as C2 when the wake picks up a shelf node (`next_shelf_slice` with `shelfRefinementCandidates` non-empty) and as C1 otherwise. One restage per wake, never two. The packet is `buildHandoffPacket({ role: 'planner', checkpoint, shelfCandidates })`; the candidates ride the volatile step block (`shelf_candidate N: node [status]: intent | why | depends_on | verified`), never the stable plan block, and drop after the budget line and before the roadmap node when the packet is over its limit. Plan, tracker and `reasoning_epoch` are untouched (a test compares the reducer state before and after).
- **One helper each, shared with U8 (§12d).** `buildRestagePacket` is the one packet builder (it takes `shelfCandidates` and an optional `planningState` override). `restageInTurn` is the only place a restage presents `this.turnToken ?? undefined` as `safePoint`; `restageBetweenTurns` passes none. Both accept a prebuilt `packet` or the builder arguments, default `requestId` to the open request, refuse a BLOCKED plan (`plan_blocked`) and a goal that is not active (`goal_not_active`), and never throw: a failure (a packet that does not fit, a memory that cannot restage) is `{ restaged: false, reason: 'restage_error' }` with a `context.restage_error` row, so a C5 budget handoff falls back to its capsule. The slice-close wake uses `restageInTurn` when it runs inside the turn (the semantic-claim path) and `restageBetweenTurns` from the completion signal. A refusal (`round_in_flight`, `round_open`) never fails the wake: it proceeds on the existing conversation and the next slice close retries.
- **Left for U6.** The executor role and its fresh thread at plan commit (C3), the C8 hard-limit restage at a step close (the policy decides it; nothing calls it), and moving execution traffic out of the planner's conversation. U7 restages only the planner and only at a slice close.
- **Review hardening (2026-09-30).** The wake never restages a plan that is BLOCKED or a goal that is met or not active. The time records (`PlanTiming.closedStepTimes`) match by goal id, step position and a start at or after the plan's commit, because board step ids (`step_N`) repeat across plans and goals. The verified-results message is a hard cap: over the limit, optional records drop first, then step and doneWhen lines collapse into a "more" line, so `over_limit` does not occur. Model-authored text inside it has the record separator and bracketed harness markers neutralized, and unit numbers are redacted.

### 12d. Implementation notes: U8 checkpoints C5-C7 through the packet (2026-09-30)

- **C5 (budget handoff).** A generation-cap exhaustion inside a turn now restages from a handoff packet (`restageInTurn`, same role, fresh conversation: system prompt, packet plan block, packet step block, nothing from the exhausted thread). The packet's step block carries the reason code with the semantic scope (`restage: ... reason=provider_budget_handoff scope=keep_target cause=...`), the budget line (`provider budget generation G; handoff N of 4; output cap ...`), the actor snapshot, runtime task state, the active step, its contract and the receipt tail. The handoff limit of 4, the visible request-ceiling pause and the recovery-route pause are unchanged. Resume after a budget or ceiling pause (and a resumed `budget_handoff`) restages at the request's first turn (`applyStartRestage`, checkpoint C5, reason `provider_budget_resume ...`). The old capsule (`providerBudgetHandoffCapsule`) survives only as the fallback when the restage is refused (no admitted goal, reducer rejection); it is traced as `budget.handoff_restage_fallback`.
- **C7 (restart, actor replaced, death).** `recoverInterruptedAgentPlan` rebuilds the conversation from a C7 packet (persisted plan state, the fresh actor snapshot with its new epoch, runtime task state); the `[HARNESS]` recovery instruction follows the packet as the step tail. It restages between turns (no `safePoint`). If the reducer holds no active plan the goal is paused and the session prints a chat line (`no_active_plan`); nothing wakes a model. The between-slices recovery branch (a completed slice with an active goal) is a C2 shape and is left as it was (TODO U5/U6).
- **C6 (blocker).** Verified, not changed: a blocked plan wakes no model (a chat continue explains the blocker, `recoverInterruptedAgentPlan` returns `plan_not_recoverable`, a restart keeps it frozen). Ordinary bounded recovery keeps continuing the current conversation in today's role; the fresh executor-shaped context needs the U6/U7 executor role (TODO in `recoverPlanRoute`). An approved Revise is C2-shaped and is not wired either.
- **Roles.** Both restages keep the role the loop has today (planner). C7 becomes the executor when U6/U7 give that role its prompt and tool block.
- **In-flight rounds are per lineage.** `restageContext` refuses `round_in_flight` only while a round of the CURRENT conversation lineage is open. A round that outlives a reset (a cancelled turn whose provider call has not returned) belongs to a discarded lineage: its reply is dropped by the generation check, and it can never touch the new conversation, so it no longer blocks the C7 restage that follows the cancel.
- **The one safePoint helper** is `NpcAgentLoop.restageInTurn` (it presents `this.turnToken ?? undefined`); supervisor and request-start restages use `restageBetweenTurns` and pass none.
- **Packet additions (step block only).** `actor:` (whitelisted actor_id, actor_kind, epoch, connected_players), `active_step_contract:` (kinds, names and minimums, never entity identities), `runtime:` (task_state, queue_length, idle). `stableText` is byte-identical with or without them.

### 12e. Implementation notes: U6 executor wiring (2026-09-30)

The executor now has its own conversation. Owner rules (§12a) as built: the planner conversation is long-lived and uncluttered, executor conversations are disposable, the executor never authors or changes the committed plan, and there are no new env settings.

- **C3, the handoff at the plan commit.** `commitPlan` notes when THIS reply committed the plan (the draft was DRAFT, RUNTIME_VALIDATION or READY and the reducer commit ran). After the batch is admitted and the reply appended, and before anything else can call the provider, `startExecutorAtCommit` restages from a C3 packet through `restageInTurn` (the only helper that presents the turn token): the immutable plan, the active step and its contract, the loaded-skill ids (`buildRestagePacket` adds them from `loadedSkillContext`; ids only, in the volatile step block) and the fresh actor snapshot. `decideRestage` (boundary `plan_commit`, role executor) supplies the checkpoint and reason (`executor_fresh_at_plan_commit`). The executor's system message is the shared system prompt plus `EXECUTOR_ROLE_PROMPT` (`agent-roles.mjs`, `roleSystemPrompt`, `NpcAgentLoop.rolePrefixMessages`): execute the committed active step only; return operations and observations; do not author or revise the plan. Provider rounds of the executor carry `role: 'executor'` (the U4 attribution rule: named once delegation is active), so `Session.roleProvider` sends them to `models[1] ?? models[0]`. With one model both roles run on `[0]`, but the executor is still a separate conversation with its own system suffix and packet.
- **The planner is parked, not discarded.** `AgentContext.commitRestage(..., { parkPlanner })` sets the planner conversation aside whole (messages, base messages, handoff id, counters, size counter) when a planner conversation hands off to an executor. The executor never writes into it, so the planner's messages contain no executor tool traffic and its size counter (which the U7 soft limit reads) counts only its own rounds. An executor-to-executor restage (C6, C8) leaves the parked planner alone; a restage as the planner, and every new lineage (`reset()`), drops it. Exactly one conversation acts: parking and resuming both advance the monotonic conversation sequence, so a reply still in flight for the other conversation is stale and is dropped and traced by the existing `dropIfStale` / turn-scope machinery (`context.stale_reply_dropped`, with the reply's own role and handoff id).
- **Return to the planner at the slice close.** `planSliceCloseWake` (both slice-close routes, in-turn and from the completion signal) and `continueUnmetGoal` call `returnControlToPlanner` when the executor is running. It refuses (`context.planner_resume_refused`, reasons `round_in_flight`, `round_open`, `turn_superseded`) exactly as `restageContext` does (`restageGuardRefusal` is the shared check), then either resumes the parked planner (`context.planner_resumed`: planner handoff id, the dropped executor's handoff id, message counts, route and reason) or, when nothing is parked (a restart or an actor replacement rebuilt the executor from a C7 packet), builds a fresh planner from a packet (C2 when a shelf node is picked up, else C1; reason `planner_fresh_at_slice_close_no_parked_context`). The verified-results wake message is then appended to the planner conversation as in U7, and the U7 soft-limit rule runs on the planner's own size. The executor's final reply is not appended to the planner conversation. There is no reducer event for a resume (the planner conversation is not rebuilt from a packet), so `CONTEXT_RESTAGED` stays a separate event and the plan, the tracker and `reasoning_epoch` are untouched.
- **The executor's plan contract.** There is one `submitPlan` tool for both roles; the role suffix and `enforceExecutorContract` (top of `commitPlan`) differ. An executor reply that restates the committed steps with different text or order (`restatedPlanVerdict`: an exact restatement, or a contiguous run of the committed steps, is unchanged), or that carries a goal definition (scope, doneWhen), a roadmap, roadmap node ids or a development mode, keeps the committed plan and the Plan Tracker as they are: the goal, roadmap and development-mode fields are dropped before admission, the step list is reconciled to the committed steps by the unchanged admission (it never let a continuation change a committed suffix), and `executor.plan_semantics_ignored` is written with `request_id`, `role`, `handoff_id`, `plan_id`, `reason` (`steps_changed`, `order_changed`, `goal_definition_changed`, `roadmap_is_planner_authority`, `development_mode_is_planner_authority`) and `ignored_fields`. The step list is deliberately not blanked: `plan: []` with no operations is a final-completion claim, so blanking would have changed a rewrite into a claim. `currentStep`, `checkpoint` and `semanticCompletion` are not plan semantics and keep their existing handling (an implied claim needs the active and next step text unchanged). The advisory planner focus the tracker shows is recorded, never acted on, and stays on a committed step. A user amendment in flight has user authority (`pendingInteractionAmendment`) and bypasses the check; that path is otherwise unchanged.
- **C8, the hard-limit restage at a step close.** `executorStepCloseBoundary` runs at a verified step close inside a slice (after `settleCompletedStepState` in `completed()`, and at the end of `commitPlan` for a step a reply closed). A close is detected by the reducer's closed-step count moving past the mark taken at the last executor restage (`executorStepMark`, set in `restageContext`). `decideRestage` (boundary `step_close`) restages only past the hard limit (2x the executor's soft limit): checkpoint C8, reason `context_over_hard_limit_at_step_close`, executor role, a fresh conversation from a packet whose plan block is byte-identical to the previous executor's (the cache prefix). Every check writes `context.step_close_decision` (size, soft and hard limit, closed steps, restage yes or no). The last step of a slice is the planner's slice-close boundary, never this one. The executor's soft limit is `restageSoftLimitTokens('executor')` (an explicit option, or the U7 prefix-aware default).
- **C6 and C7 are executor-shaped.** Ordinary bounded recovery in `recoverPlanRoute` (Jev routes `wake_planner` and `targeted_observation`) restages a fresh executor from a C6 packet when the reducer holds a committed plan (`startExecutorForRecovery`; reason `bounded_recovery route=... cause=...`), then appends the `[RECOVERY_ROUTE]` message. No user question, plan and tracker untouched, the parked planner untouched. A recovery that is still authoring its first plan stays on the planner conversation. C7 (`restageRecoveryConversation`) restages as the executor when the reducer holds a committed plan (a draft keeps the planner role), with the fresh actor snapshot and the new epoch. It parks nothing: the conversation a restart rebuilt is only recovery scaffolding, so the slice close builds a fresh planner from a packet. A blocked plan still wakes no model. The C5 budget handoff keeps the running role (executor during step execution). The TODO(U6/U7) markers are resolved.
- **Test switch.** `executorHandoff: false` is a construction option of `NpcAgentLoop` (not an env setting; default on, and the supervisor never sets it). The tests of the older seams (U4 restage, U7 planner soft limit, the no-restage steam replay golden) construct the loop with it off so that they keep exercising one conversation; the delegated run has its own tests (`executor-wiring.test.mjs`). The `no-restage-steam-replay.golden.json` is unchanged. The tests of C5 and C7 after a committed plan now expect the executor role, and count only their own checkpoint's rows.
- **Prefix layout.** A handoff packet is the whole request context (`prompt-prefix.mjs` `requestContextEnd`): the cache breakpoint moves to the end of the packet's step block, and the first continuation after it is classified `continuation_reset` rather than a history rewrite. In the delegated steam replay every prefix break is an expected one (the role switch at C3 is a system-message change).
- **U8 review carry-overs.** (a) The recovery `runGuardedTurn` runs after a failed turn now executes under that turn's scope (`currentTurnScope`), so a reset that outlives it is dropped before admission. (b) A stale turn superseded by a reset leaves the in-flight `provider_recovery` marker for the fail-closed restart path and writes nothing (`provider.output_budget_recovery_marker_kept`); a restage of the same lineage still clears it (the retry never ran for the active conversation). The stale error carries `staleKind` (`restage` or `superseded`). (c) An active goal a restart finds with no plan at all is paused in the reducer (`RUN_PAUSED`, reason `runtime_restart_before_first_plan`; the goal and its objective stand) with a chat line saying Resume re-drives it and no model woken (`runtime.goal_without_plan`, `request_id`, `model_woken: false`); a bare Resume or continue then plans that same goal from its own objective (`goal.redriven_after_restart`). The startup notices moved into `Session.startupGoalNoticeKind` / `announceStartupGoal`. (d) Trace writes in the restage helpers and the C7 supervisor path use try/await, so a writer that throws before it returns a promise cannot abort them. (e) The post-commit trace and persist of `restageContext` are independent: a failing trace write still persists the reducer state, and each failure is reported as `context.restage_persist_failed` with its step. (f) The `turn_superseded` refusal rows carry the request id captured before the awaits. (g) The stale drop row prefers the reply's own attribution to the turn scope's role and handoff id, and an in-turn restage refreshes the scope.
- **Review fixes (2026-09-30).**
  - *Reasoning epoch.* `refreshPlanningReasoningEpoch` rebuilds a planner-shaped context (planner system prompt, `[CHAT]` text) when the reducer epoch moved. A second goal in the same process, or a slice whose committing reply revised the shelf, moved it between C3 and the first continuation, which wiped the executor's packet and role suffix. Now `restageContext` records the current epoch as seen (a packet restage is itself a rebuild from durable state), and an executor never takes the planner-shaped rebuild: it keeps its conversation, a planner parked across a bump is dropped (it went stale), and `executor.reasoning_epoch_moved` records it. The slice close then builds a fresh planner from a C1/C2 packet.
  - *The executor never authors.* The contract is about the role, not the plan status: an executor reply while no plan is committed (COMPLETED, nothing drafted) is ignored (`executor.plan_semantics_ignored`, reason `executor_cannot_author_plan:plan_status_X`) and ends the request visibly. A return to the planner that is refused (`round_in_flight`, `round_open`) is retried once after the loop yields (`context.planner_resume_retried`); a second refusal, or a failed fresh-planner restage, never wakes the executor: `endSliceWithoutPlanner` writes `executor.slice_wake_deferred` (request id, reason, route, `model_woken: false`), ends the request with a chat line and Resume, and leaves the goal active between slices. The same holds for the unmet-goal continuation.
  - *Amendments.* A compatible user amendment during an executor slice returns control to the planner (`context.planner_resumed`, reason `user_amendment`) and is staged in the planner conversation; if the planner cannot be reached it is not deferred (`amendment.not_deferred`) and takes the cancelling amend route. `pendingInteractionAmendment` is tied to the conversation sequence that holds its text (`currentPendingAmendment`): any restage, return to the planner or reset clears it (`amendment.flag_cleared`), and `reset()` clears it, so a new request cannot inherit it. The executor contract has no amendment bypass any more.
  - *Smaller.* Rebuilds (the C5 capsule fallback, the epoch rebuild) use `rolePrefixMessages(role)`. The Resume re-drive uses `CONTINUATION_WORDS` / `isBareContinuation` (one list, exported by the loop and used by the supervisor's navigation policy; English and Chinese). The startup notice decides its kind when the queued event runs and prints a pause only when one was recorded (`pause_not_applied` otherwise). `restatedPlanVerdict` no longer accepts a completed prefix as a restatement of the remaining steps.
- **Known limits.** (1) Zero-operation commits (a plan committed by a condition-wait registration with no operation in the reply) get no C3 handoff: no batch is admitted and the request ends; the executor starts at the wake that resumes it (C7, `condition_*` recovery), and the planner conversation keeps acting until then. (2) A Resume request starts a new lineage as the planner even when the plan it continues is committed; it becomes an executor only at the next plan commit, C6 or C7. (3) `AgentContext.measuredPrefixTokens` is measured once from the first reply that reports input tokens, whichever role made it, and is shared by both roles and all conversations of the loop; the executor suffix (about 350 tokens) is therefore inside the measured prefix only when the executor made that first reply. (4) An epoch bump while an executor acts with no parked planner changes nothing for the executor; the plan it carries is immutable, so a bump that supersedes it arrives as a new request (a reset). (5) A user-deferred amendment's text is lost with the conversation that held it (by design of the flag tie); the player sees the deferral reply only.
- **Not built.** C4 (a fresh executor at every step close) stays off, per the owner. The roadmap agent (plan item 3.5) is separate work. A Resume request (a new lineage) starts as the planner even when the plan it continues is committed: its conversation only becomes an executor at the next plan commit, C6 or C7. Hard and soft limits, and the request ceiling, are unchanged.

## 13. Build status (2026-09-30, fusion branch `experiment/jev-agent-architecture`)

Unit and integration evidence only: static scenarios with scripted model replies. There has been no live run since the delegation build started. Each merge ran `scripts/test-local.sh all` (Docker) green and was pushed.

| Unit | What | State |
|---|---|---|
| U1 | Role config: planner = `OPENAI_MODEL[0]`, executor = `[1] ?? [0]` (`agent-roles.mjs`, `Session.roleProvider`) | merged `1b07e210` |
| U2 | Pure handoff packet (`handoff-packet.mjs`, `stableText`/`volatileText`, ≤500-char unverified note) | merged `d6f75e6e` |
| U3 | Pure restage and slice-ceiling policy (`restage-policy.mjs`, token-counted limits) | merged `d6f75e6e` |
| U9 | Run record and run-check rows: role, `handoff_id`, restage loop, oversize packet, stale reply | merged `a8bf6004` |
| U4 | Restage seam: `AgentContext`, `restageContext`, `CONTEXT_RESTAGED`, stale-reply drop and bounded re-drive, turn-token safe point, shared `durable-text.mjs` (§12b) | merged `0d790092`, follow-ups `df81b21d` |
| U5 | Per-slice output ceiling (aggregate minus the slice baseline, reset at the slice-close wake) | merged `19194cf5` |
| U8 | C5 budget handoff and Resume, and C7 restart/actor replacement, through the packet; C6 blocked plan wakes no model (§12d) | merged `ebfcec43` (repin `aa4b30bd`) |
| U7 | Planner wiring: verified-results `[MOD]` at slice close, C1/C2 soft-limit restage with a prefix-aware default limit, planner role tagging | built and review fixes done; merges next, after folding its restage helper into U8's |
| U8 follow-ups | Generation/lineage staleness at the admission points, the `startRestage` leak, the startup no-plan branch, test gaps | queued after U7 |
| U6 | Executor at C3, the hard-limit restage at step close, `executor.plan_semantics_ignored`; C6/C7 bounded recovery becomes executor-shaped; U8 review carry-overs (§12e) | done, pending merge |
| U11 | Jev at the checkpoints (§7 owner decisions) | not started, after U6 |
| U10 | Docs: plan rows 3.4–3.6, status doc, this note | this section; final pass after U11 |

After U11: the flash-only live test (both roles on DeepSeek flash, ≤2 CAD; ask the owner about a harness-enforced spend cap first). It also collects the first Jev agreement samples.
