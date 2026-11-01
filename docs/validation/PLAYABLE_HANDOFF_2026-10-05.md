# Playable red-science handoff — October 5, 2026

This preserves the unfinished work from the playable-checkpoint conversation so
old messages can be cleared. Use the configured project; no local paths or machine
setup are required by this handoff. Read the current source and instructions first.
Do not reset the project to an older checkpoint.

## Current integration and evidence

- Repository: `TTLouis/factorio-npc`.
- Integration branch: `experiment/jev-agent-architecture`; main is separate.
- Observed integration HEAD before this documentation change:
  `467dd799f11b567484ebd4ceafe17a152e007a53`, synchronized with the locally recorded
  origin tracking ref. Recheck current HEAD when resuming.
- During this handoff write, concurrent work added `b98d65b2` for an isolated
  locked-goal requirements Factorio lane. No lane execution result was inspected
  here. Preserve it and check subsequent commits rather than resetting to the
  earlier observed HEAD.
- This conversation pushed status checkpoint `58339984` on the owner's request.
  Later integration work is already present; do not repeat the old handoff's claim
  that the operation ledger is unmerged.
- Current shipped payload reference: `ff9f8e2da723c101bac97cd44e161f14bbb0ff8f`,
  repinned by `4f833278`. Source HEAD, payload reference and deployed files are
  different evidence; verify what actually runs before an engine test.
- Latest regression result recorded in the current status document: **1,624 runtime
  and 965 mod tests**, typecheck, Lua build and generated-Lua checks for goal
  requirements grounding. These tests were not rerun by this handoff update.
- **The three-seed playable checkpoint has not passed.** Unit tests, a package pin
  and individual owner live findings do not establish acceptance or provider autonomy.

Read `AGENTS.md`, `docs/NPC_AGENT_HARNESS_STATUS.md`,
`docs/validation/PLAYABLE_BUILD_2026-10-03.md`,
`docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md`,
`docs/NPC_PLANNING_ROADMAP.md` and `docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md`.
Some dated October 3 paragraphs still describe their historical boundary. Current
source and later dated evidence take precedence for implementation status.

## Work already landed; preserve it

1. Native exact admissions, successful-prefix receipts and durable ordinal fences;
   physical own-NPC corpse tracking/retrieval with compatible equipped ammo checks;
   buffered-stock planner guidance; conservative output candidate monitor.
2. Durable operation ledger integrated by `9eda4404`, with payload shipping added
   by `9e25244a`. Later review corrected an overly broad hold that made ordinary
   refusals permanent. Mod-proven pre-mutation refusals of validate-then-queue
   operations and proven pre-transport failures settle exactly, allowing bounded
   placement recovery. Genuinely uncertain effects remain held. **Do not restore
   tests or behavior that block all cancelled/refused placement retries regardless
   of authoritative absence evidence.** Do not infer absence from an error alone.
3. Legacy operation records settle only with unambiguous baseline evidence;
   otherwise they raise one user question. The recorded follow-up is that no
   production path can answer that question yet.
4. Remote-interface fix `876157a5`: admission and output-proof controllers use
   arrow-function interface tables. Bare TSTL controller registration caused nil
   correlation on the owner's first live admission. Preserve the generated-Lua
   guard and validate remote ABI behavior in the real engine, not only TS tests.
5. Plan slices are nested under their named roadmap node; keep shelf intents short
   and preserve the unified Plan Tracker tree. NPC time split reaches planning as
   harness facts; time-efficiency prompt additions were removed by owner request.
6. Game-grounded goal requirements, merged through `ff9f8e2d`/`4f833278`, expose
   locked recipes, ingredients, compatible machines and unlocking research paths.
   The first plan receives one grounding round when required, before commit or
   admission; provider-error recovery skips it. `recipe_locked` remains terminal
   with unlock evidence. The curated `automation-science-bootstrap` skill was
   retired. Do not revive a hidden bootstrap recipe/layout shortcut.
7. The owner approved the requirements ordering rule in `DURABLE_PLAN_PROMPT` on
   October 5. Optional base-game/Space Age guide artifacts are later roadmap work,
   not an immediate checkpoint dependency.

Requirements-grounding follow-ups from the current status: skill cards choose an
unlock technology differently from the requirements block (direct prerequisites
versus pending path nodes); mined/pumped items may be misclassified as locked
(unconfirmed). The new goal-requirements Lua has no recorded engine run yet.

## Remaining candidate work and availability

These branches were inspected in the original environment on October 5. The task,
allowance and circuit candidates are **not ancestors of current integration HEAD**.
Their branch refs were not present in the recorded origin refs. A remote session
must locate/import the candidates before assuming it has them; do not silently
duplicate substantial completed work or assume an old subagent is running.

| Candidate branch | Commit / state | Evidence and required follow-up |
| --- | --- | --- |
| `fix/playable-task-retention` | `4ac4b8df44fe420f163729a0f9699327ca61d9be` | 1,585 runtime tests passed, but separate review found clock fences missing from completion handoff and pending starts. Repair and review before merge. |
| `feat/playable-provider-allowance` | `f9c5bcf8a920b695d6aece02c81f693931759a61` | Reviewed allowance and test-only reply bridge modules. New tests passed; inherited reservation expectations require the complete task retirement unit. |
| `feat/playable-campaign-transport` | **Uncommitted changes on `f9c5bcf8`** | Preserve the working tree. Last recorded gate: 1,609/1,612; one Jev fixture issue and two inherited reservation expectations. Commit, separately review and verify integration. |
| `feat/playable-buffer-circuits` | `29c14eb313a34ee957b4a199c160b72d56abea8e` | 920 mod tests plus typecheck/Lua passed. Separate review, bounded runtime contracts and native stop/restart/overshoot evidence remain. |
| `fix/playable-durable-operations` | `a85b7c6b4b0f19a9c8b4747543ca306926394706` | Already integrated with subsequent clearance fixes. Original branch is archival context, not the next merge. |

The uncommitted campaign work includes provider/supervisor/loop wiring, installer
shipping closure, fake transport fixtures and new `campaign-errors.mjs`,
`campaign-store.mjs`, `campaign-transport.test.mjs`. Do not delete/reset its worktree
or assume these files can be recovered from GitHub. No worker should continue
without an explicit bounded assignment and a verified checkout.

## Immediate blockers and next dependency order

1. Repair task clock fencing. Interrupted completion handoff must not restore or
   recover work after detected rollback/map change or an unreadable trusted clock.
   Pending starts need authoritative clock/start-tick evidence; missing evidence
   must defer, not bypass the three-attempt/15-minute bound. The surface/seed
   fingerprint cannot detect same-seed forward save swaps; wire exact save identity.
   Preserve the immediate-first-reply completion fix, cap, isolated questions,
   original result/destination, actor checks and accepted-task FIFO.
2. Finish global campaign store and every planner/executor/interaction/Jev transport
   admission/usage settlement. Reserve durably before physical calls; missing usage
   or possibly sent requests remain uncertain. Keep existing guards. Explicit
   allowance profile and grounded input bounds are required for any paid transport.
   Campaign errors must not fall through advisory fallback or reset on task switches.
3. Wire standing Auto/player-task authority into initial commit and replacement
   plans. Same-result recovery may proceed within the grant; changed destinations
   or substantial player-structure redesign require task-local approval. Finish
   legacy chest-reservation retirement while preserving explicit constraints and
   excluding human inventories, including exact entity operations.
4. Implement physical inventory retention/returns and death orchestration. Keep
   committed-work materials and essential equipment; return surplus to source
   chests first, then compatible shared storage. Build return storage normally if
   needed; never use the science measurement chest. After death reconcile old work,
   rebuild supplies and let the planner choose a weapon/ammo kit. **Verify compatible
   equipped ammunition before approaching danger or attempting corpse recovery.**
   Prioritize own-corpse cleanup once a viable route exists. Full inventory requires
   return trips, not copied items or deleted occupied corpses. Derive retrieval IDs
   and unique per-slot ordinals in the harness; preserve unsafe/expired tasks and
   recovery limits across replacement plans and repeated deaths.
5. Expose circuit and output tools through bounded contracts. Validate exact
   identities, force/surface, reach and existing wiring before mutation. Test
   buffered-line stop/restart and bounded inserter overshoot. Output witness remains
   `satisfied:false`, engine/upstream automation unverified; validate delivery
   attribution and full automated upstream supply, and add bounded proof retirement
   or rebinding so destroyed output chests cannot exhaust the small registry.
6. Wire the test-only reply bridge at the provider seam; reject stale/duplicate/late
   replies with no paid fallback. Record observations, replies, admissions, receipts,
   timing, goal evidence and exact save identity. Test delays, changing world state,
   attacks, disconnects, cancellation and actor replacement with simulation running.
7. Revalidate dependency canaries, freeze a candidate SHA, repin/check the shipped
   package and perform the real-engine acceptance below. No live deployment is
   authorized by this handoff; prior approvals for particular owner live runs do
   not authorize another paid run.

## Settled acceptance and owner decisions

- Three consecutive assistant-driven fresh normal maps: **424242, 424243, 424244**.
  Normal enemies, natural terrain/ore, ordinary research, zero connected humans,
  a declared one-time vanilla starter kit; no terrain fixtures, respawn replenishment
  or production shortcuts during acceptance.
- Each run must automatically deliver **at least 10 red packs in each of five
  consecutive game-minute windows** into one exact named output chest. Upstream
  supply must be automated and production inputs cannot be hand-fed during proof.
  Manual deposits, unrelated production and surplus returns cannot satisfy it.
  Changed/destroyed output identity or a deficient minute restarts the complete proof.
- Pause only at settled decision boundaries awaiting assistant planner/executor
  replies. Actions, combat and measurement run normally. Separately test delayed
  replies with the simulation running. This proves assistant-driven gameplay,
  not actual NPC-provider autonomy.
- Support **32 accepted open tasks including active work**, reject overflow without
  eviction; retain questions/grants/checkpoints together. Full checkpoints stay out
  of model prompts. Pending tasks run in acceptance order; neglected tasks resurface
  after 15 game-minutes, excluding downtime. Preserve recovery limits across deaths
  and replacement plans. Unresolved effects survive cancellation/restart; only
  disjoint independently authorized work can proceed around an uncertainty hold.
- Buffered buildings generally keep at least two live stacks; each belt tier
  approximately 400–600. Planner selects grounded targets; explicit player quantities
  override them. **Do not cap science or other continuously consumed flows.**
- One durable allowance across roles/tasks/restarts; warning at 75%, pause at 100%.
  Synthetic usage is separate from billed usage. Paid transport remains disabled
  for this checkpoint. Never read/print `.env`, credentials or tokens.

Follow repository worktree/review/regression rules, use meaningful tests and retain
logs. Test the actual shipped files. Do not weaken an engine assertion to hide a
limitation, force-push, overwrite concurrent work or interpret an admission as goal
completion. Keep current docs separate from historical evidence.
