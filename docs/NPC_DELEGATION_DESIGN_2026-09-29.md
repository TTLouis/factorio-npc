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

Promotion needs traced agreement with later outcomes over a stated sample **(number to be
set by the owner)**. A judgment that saves no context, calls, time or recovery cost is
removed. Checkpoint triggers, mandatory fields and size limits stay deterministic code.

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
