# Restage context detectors (A1–A3) and the B plan, 2026-10-19

Branch `test/restage-context-detectors`, from jev-arch `b9d96307`. Static Docker gates only; no live E2E.
Evidence: the 19 retained red-automation live runs 10-15n..10-19af (about 2.8k full provider prompts, 124 conversation swaps).

## Why delegation keeps producing regressions

Since 10-01, 138 of 476 jev-arch commits were fixes; 91 of them touched `npc-agent-loop.mjs`, and the restage golden was regenerated 35 times. Three structural causes:

1. **Restage replaced implicit transcript memory with an explicit allow-list.** Before delegation the transcript carried every fact the model had seen. A restage keeps only what the packet names, so each live run found the next missing fact family (research path, recipes, triggers, fluids, fuel, topology, skills, Run N diff baselines, Run AD direct-feed access). Meanwhile about 15 loop caches each kept their own hand-picked reset rule, independent of which conversation they described.
2. **Role, handoff and generation added a lifecycle axis with no transition table**, layered on pause, auto-resume, recovery, turn scope, in-flight work and epoch (Runs H and J, Haiku B).
3. **The role contract changed about four times** (planner-first, step-id binding, protocol 3, review round).

Scripted-reply tests cannot see a fact the model never received, and a live run stops at its first blocker, so each live run found about one bug. Units A make cause 1 measurable; units B remove its mechanism.

## A1 — dangling-reference invariant (`context-references.mjs`)

Every `diff`/`unchanged` observation in an outgoing provider request must have its baseline in that same request. This covers entity status, nearby entities, static prototypes and task receipts. The loop traces each new violation as `context.dangling_reference` and does not repair it. run-check reports high severity as `dangling_context_reference`; a task-receipt diff without a full receipt is informational (`dangling_task_receipt_diff`). The CLI scans `sgluna-prompts.jsonl`.

Corpus result:

| kind | severity | count | where |
|---|---|---|---|
| entity_status diff/unchanged | high | 4 | Run N only (10-15n), recovery requests; fixed by 1cc3867d, none since |
| task receipt diff | low | 191 | every run after 10-15n, after `context.restaged` |

The steam replay with no restage also sends one task-receipt diff without its full receipt: a continuation rebuild drops the receipt but keeps `lastTaskStatusView`. The golden gains that one trace row, and provider bodies are unchanged.

Scenario test: on the C3 restage path, a repeat `getPrototypeDetails` answers `unchanged`, and the continuation re-delivers `[STATIC_PROTOTYPE_CACHE]`, so nothing dangles. A3 shows other swap sites skip that re-delivery (below).

## A2 — restage-loss report (`restage-loss-report.mjs`, advisory)

89 of 124 swaps could be analyzed. The rest fall in truncated prompt logs in 17y, 18z and 18ab, or come after the last prompt.

- About 660 tool-result keys were lost across swaps; 50 were re-read with identical arguments.
- `getInventoryItems` was re-read 78% of the time, usually in the next request. That is mutable state, so re-reading may be correct.
- Research and recipe facts were re-read about 21% of the time, with 11 more recipe reads under other arguments.
- Recovery auto-resume restages (C7) are 49 of 104 executor restages and hold 8 of the top 10 re-read swaps.
- Every MOD receipt and most baseline blocks vanish at every swap.

Loss here means "not verbatim in the new conversation". Packet summaries are invisible to this method.

## A3 — state scope registry (`state-scopes.mjs`)

All 197 loop and helper fields now declare a scope, model visibility and owner. A new undeclared field fails the lint. There are 17 conversation swap sites. `--report` prints the reset matrix. Findings:

1. `prototypeRefsThisRequest` is cleared by `reset()` only. The epoch rebuild, capsule fallback, start restage, supervisor recovery and compaction never re-deliver `[STATIC_PROTOTYPE_CACHE]`, so a repeat read there answers "already present" about nothing. This is latent and was not seen in the corpus.
2. The capsule fallback in `recoverPlanRoute` skips `toolCache.clear()`, so its fresh decision can get "Duplicate observation suppressed". The payload is still inlined.
3. `unchangedFactReads` survives every swap: identical reads after a swap stop being charged against the observation budget.
4. `finiteNoOperationPressureUsed`, `toolValidationRetries` and `planCategoryRetries` are not reset by restage, planner resume or epoch rebuild.
5. Observation budgets across restage are re-seeded only by C3 and the capsule fallback.

## B plan (one mechanism instead of per-field rules)

- **B1 — ConversationState on AgentContext.** The facts whose meaning depends on what is in `messages` move into one object that lives and dies with the conversation: `toolCache`, `prototypeRefsThisRequest`, `unchangedFactReads`, `lastTaskStatusView`. A new conversation (lineage, restage) gets a fresh one, and a parked planner keeps its own and gets it back on resume. The loop reads them through accessors, so call sites do not change.
- **B2 — one swap path plus carry-forward.** Every site that replaces the conversation wholesale goes through one loop method, which installs a fresh ConversationState. Every rebuild of `messages` (continuation, swap) then runs one carry-forward registry. Each producer of relative observations either re-delivers its baseline (static prototypes; entity and nearby baselines stay with the adapter) or forgets it, so its next answer is full (task receipts). A1 is the gate: no `context.dangling_reference` in any scenario.

Out of scope: the decision-pressure counters (A3 finding 4) and the lifecycle transition table (option C).

## B results (static gates only, not live-tested)

- **B1** (`7d8f6009`). `AgentContext.conversationState` holds `toolCache`, `prototypeRefs`, `unchangedFactReads` and a new `taskStatusDiffBaseline`. A restage or a new lineage starts it empty, and a parked planner gets its own back on resume. `lastTaskStatusView` stays request-scoped: it is the latest world receipt and feeds the tick fences, so only the diff baseline moved. In the C3 scenario, a repeat `getPrototypeDetails` after the restage now returns full `cached_static` facts and nothing dangles.
- **B2** (`4f7af235`). The epoch rebuild, the capsule fallback and both supervisor recovery paths call `replaceConversation`, which closes A3 findings 1–3 at those sites. `CONVERSATION_SLOT_CARRY` sets keep or forget per slot for the two in-place rebuilds:

  | slot | continuation | fold |
  |---|---|---|
  | toolCache | keep (the continuation path clears it itself) | keep |
  | prototypeRefs | keep (re-delivered) | forget |
  | unchangedFactReads | forget | forget |
  | taskStatusDiffBaseline | forget (the rebuild drops the last receipt) | keep |

  A slot read without a carry rule throws. Handoff packets carry the full receipt view. The state-scope lint now treats `replaceConversation` as a swap.
- **Golden.** The no-restage steam replay loses its one `context.dangling_reference` row. Three provider bodies change, and only in a single task receipt (`diff` → `full`, same fields). One repeat read after the continuation is no longer flagged `unchanged_fact`. Calls and the event order are otherwise identical.
- **Gates.** The full suite passed 2700 of 2700, and `build-payload` passed 9 of 9. The payload is repinned to `4f7af235`, which ships B1 as well.
- **Not done.** No live run. A2 was not rerun on new prompts, and A1 has no corpus of post-B prompts yet. The next live run's `run-check` should show `dangling_task_receipt_diff` at zero.

## C results: one lifecycle table (static gates only, not live-tested)

Option C: the lifecycle is one tuple read from existing fields. Each entry point traces it, and one table decides which transitions are refused. C4 (moving the tuple into the reducer) waits until after the release.

### C1: lifecycle snapshot and trace (`lifecycle.mjs`, `lifecycle-scan.mjs`), `0ebeb9f8`

`lifecycleSnapshot` projects these existing fields into one tuple, stores nothing, and reads `unknown` when an axis cannot be read:
- goal (legacy board status);
- run and pause class (reducer);
- plan status and step (reducer);
- role and parked planner (AgentContext);
- batch in flight;
- pending operation;
- request;
- provider recovery.

All 12 entry points call `lifecycleEnter`, which traces `lifecycle.entered` with that state: request start, reset, restage, planner return, epoch rebuild, continuation, checkpoint persist, slice close, batch send, plan recovery, task resume and supervisor recovery. A static test proves that each listed site calls it with its own event. The no-restage golden gains seven trace rows only.

The advisory `lifecycle-scan.mjs` projects the same tuple offline from retained behaviour traces. Over the 10-14g…10-19af runs:
- `executor_restage_while_paused` fired at:
  - Run G (10-14g) row 149;
  - Run H (10-14h) rows 456 and 490.
  Each was an automatic resume that restaged the executor onto a `model_recoverable` paused plan.
- One `batch_send_while_paused`, in Run G (row 192): the goal read active while the reducer run still read paused. That is a goal/run disagreement and is left open.
- Run J (10-15j) persisted a plan on a completed board just before `request.failed`. The inline checkpoint guard refused it.

Every other restage, checkpoint, batch, planner return and recovery in the corpus ran on an active goal. Some `restage.executor` rows (8 in the corpus) carried a batch still in flight; that case is not refused yet.

### C2: the transition table (`LIFECYCLE_TABLE`), `7e12867b`

The table has one entry per event: the states that refuse it, and the per-decision counters it resets. A rule refuses only on positive evidence: an axis that reads `unknown` never matches a `refuse` list. An event with no rule records why none is enforced, so no event can be added unexamined. `lifecycleEnter` returns the refusal and traces `lifecycle.refused`, and the site then refuses through its existing path, before acting.

| event | refused when | site path | evidence |
|---|---|---|---|
| restage (executor) | goal paused, completed or cancelled | `context.restage_refused`, `{restaged:false}` | runs G, H |
| checkpoint.persist | goal not active (unknown fails closed, as before) | `checkpoint_requires_active_step` (replaces the inline status check) | run J |
| recovery.interrupted (step boundary) | goal paused, completed or cancelled | `{recovered:false, reason:'lifecycle_refused'}` | runs G, H; supervisor rule |

These events have no rule yet, each with its reason recorded in the table:
- request start, reset, planner return (the MW5 replacement may return to a blocked plan);
- epoch rebuild, continuation, slice close;
- batch send (one-off requests act outside a running goal; the Run G goal/run disagreement stays open);
- plan recovery, task resume.

**Counter resets (A3 finding 4).** A successful restage, a parked-planner return and a planner epoch rebuild now reset three counters, as a continuation already did: `finiteNoOperationPressureUsed`, `toolValidationRetries` and `planCategoryRetries`. The model in the new conversation never saw the rejections those counters counted. The state-scope reset matrix counts these resets.

**Static proofs:**
- every rule's site consumes the refusal, and no rule-less site does;
- every resetting event applies its resets at its own site, and they are declared loop fields.

**Gates:** the full suite passed 2736 of 2736, and `build-payload` passed 9 of 9. The payload was pinned to `7e12867b` (`1cda841a`). The golden is unchanged.

### C3: scenario matrix and regressions (`lifecycle-scenarios.test.mjs`), `e073e0f1`

- **Generated matrix.** Each `LIFECYCLE_TABLE` rule gets refuse and pass cases. Every refusing value refuses; a `require` rule refuses both `unknown` and `none`; allowed values pass; a mismatched `when` passes. A new rule gets cases automatically.
- **Site scenarios on a real `NpcAgentLoop` with canonical memory:**
  - An executor restage onto a paused goal is refused before anything changes: messages, role, handoff id and reducer state are untouched. It is traced as `context.restage_refused` and `lifecycle.refused`. The planner on that same goal is not refused.
  - A restage on an active goal succeeds and resets the counters.
  - A checkpoint on a completed goal throws `checkpoint_requires_active_step`, from the table.
  - A planner return and a planner epoch rebuild reset the counters. An executor epoch bump does not.
  - A supervisor recovery whose reactivation left the goal paused returns `lifecycle_refused` and never rebuilds or runs a turn.
- **Regressions.** A scrubbed fixture holds the states from Run G row 149, Run H rows 456 and 490, and Run J rows 689 and 691. It contains ids, statuses and pause classes only, and a test enforces that. The scanner still flags G and H, and the real sites refuse them. Run J's raw trace has no flag, because the refused persist wrote no row. The test therefore pairs J's completed `plan.persisted` row with the `lifecycle.entered` row the site now writes.
- **Coverage lint.** Each rule reason and each resetting event must have exactly one site scenario.
- **Fix found along the way.** `lifecycle.refused` used to let the rule's reason overwrite a site's own `reason` detail. The rule now goes in `refusal`.
- **Gates.** The full suite passed 2768 of 2768, and `build-payload` passed 9 of 9. The payload is pinned to `e073e0f1` (`2ed59612`).

### Still open after C

- No live run.
  - The next run should show `lifecycle.entered` rows, and `lifecycle.refused` rows only if a G/H/J shape recurs.
  - Rerun `lifecycle-scan.mjs` on it: the runtime rows replace the projection.
- Candidates for rules with no evidence yet:
  - batch send while the reducer run is paused (Run G row 192);
  - executor restage with a batch still in flight (8 corpus rows).
- C4, moving the tuple into the reducer, is planned for after the release.
