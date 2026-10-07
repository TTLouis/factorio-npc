# Fresh Luna trial after targeted observation recovery — October 7

The owner authorized one new E2E and temporarily removed the shared weekly usage ceiling. The fresh run at pushed candidate `38bc20185def2b83d224253bf87eba0fea984a9e` failed autonomous red-to-green acceptance. Luna paused before any gameplay batch. Native red production/consumption stayed zero, green research and recipe remained false, and the canonical goal stayed active with the board paused at 0/4.

## Preflight and conditions

The candidate differs from the previously gated `61f70f54` only by documentation. Recorded gates passed 1,868 runtime and 1,041 mod tests, typechecks, generated Lua, full Docker build and nine payload checks; native exact-entity/research passed, with restart passing on one fresh retry after a retained shutdown stall.

Tailscale proxy root health and authenticated models returned HTTP 200, with `gpt-6-luna` and the dedicated Jev token available. The owner's Luna instruction overrides the older repository model rule for this task. The live image was rebuilt through `scripts/build-docker-local.ps1 -NoEnvUpdate`; `.env` was handled opaquely and unchanged. All 45 deployed runtime files matched committed candidate hashes. The active compiled mod matched the release and frozen control SHA256 `f0c1967b749c68d498e0f3b09fad208f5e54d294dd929ff340b6980e460aeb61`.

A new initially empty data directory generated seed `3816007824`, standalone actor 12/epoch 1, no initial inventory, machines or board, speed 1 and zero humans. Ports were loopback-only. The existing starter supplied eight iron plates, a burner drill, a furnace, pistol and ten magazines. The only submitted objective requested native red production/consumption and completed logistic-science-pack research with enabled green recipe; hand crafting and hand-fed machines were allowed. The 45-minute guard remained, with no trial provider-call caps. No corrective prompts, operator gameplay after the starter, client joins, actor changes or external provider retries occurred.

## Result and failure sequence

The run began `2026-10-07T16:27:47.748Z` (12:27 Toronto) and stopped after 60.194 seconds. Five Luna requests/responses used 115,936 input units, including 79,872 cached, and 1,129 output units. Four Jev requests/responses occurred. There were zero gameplay submissions, zero targeted-read grants and one targeted-read refusal.

1. Initial observations supplied actor, inventory, research and recipe data. Luna's first draft ordered red production before its unlocking prerequisites. Authoritative goal grounding returned the native trigger ladder and requested correction.
2. Luna then declared four deterministic research steps in prerequisite order, but proposed `craft_item(copper-plate,10)`. Native preflight correctly returned `requires_machine`, with a held furnace and no placed furnace, before any batch executed. The canonical plan `goal_1a1xaqt_1_p3` remained `DRAFT`; no planner-to-executor handoff occurred.
3. The recoverable fact message said tools remained enabled, while the next actual packet had `tool_choice:none` and zero observation budget. Global closed-round guidance advertised the typed targeted-read route.
4. Luna requested `getResearchStatus` with `stepId:"science-prereqs"`, a roadmap identity rather than the reducer step ID. Its rationale concerned smelting with an unplaced furnace. Admission refused with `no_eligible_active_step`: the route requires a frozen committed plan and does not grant draft-stage execution authority. The wrong identity was not reached because draft eligibility failed first.
5. The refusal returned the existing plan/currentStep and a blocker without completion declarations. The following format correction reported `missing_step_completions` before commit. Luna then returned: “BLOCKED: The active plan has no committed reducer step, and the live game reported that copper plates require a furnace rather than hand crafting. I can’t safely proceed without an active step and a fresh plan decision.”
6. Outcome authority rejected the unsupported world-blocked claim and truthfully paused as `recoverable_provider_failure:provider_reported_blocker`. Goal `goal_1a1xaqt_1` remains active; its original four-step draft and zero progress are retained.

This exercises the new refusal boundary, not a successful committed-step fact recovery or furnace reuse. Luna made an invalid hand-crafting choice and an ineligible read request. The harness also exposed inconsistent tool guidance and a draft-stage refusal that became a completion-contract format error. The next bounded investigation is planner recovery before commitment: clearly distinguish draft authoring from frozen-step recovery and preserve a valid correction contract after recoverable preflight refusal. Do not remove native crafting restrictions, commit a failing operation, infer intent from prose, or turn this run into a science walkthrough.

## Evidence and cleanup

Evidence is retained at `test-results/luna-targeted-live-2026-10-07/`: build/health/deployment logs, full behavior/decision/prompt JSONL, snapshots, final state, exact replies/refusals, usage summary and SHA256 manifest. The offline checker parsed 62 behavior rows for one request with zero parse errors/findings; current patterns do not diagnose this draft-stage failure.

The paused test container and its dedicated Docker network were removed after capture. Trial save ZIPs were hashed and discarded. Other work and containers were untouched. No live server remains on UDP 34201 for this trial. Shared weekly usage was 24% at closeout; the owner temporarily lifted the ceiling for this run. No additional live retry was started.
