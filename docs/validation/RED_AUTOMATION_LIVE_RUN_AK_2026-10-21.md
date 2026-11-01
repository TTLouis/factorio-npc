# Run AK — latest local Jev candidate d651508c

The readiness checks passed; the autonomous red-science trial failed after **36.0881 minutes**. The NPC produced **99 iron plates and 10 copper plates**, connected an offshore pump to a fueled boiler, and produced native steam. The steam engine remained held, and zero automation-science-packs were produced or consumed.

## Frozen source and readiness

The latest local integration candidate was `d651508c3c2d075352dffc6602c9181de1dbc188`. A fresh fetch confirmed the published Jev ref was still `b9574fc4556eafb431f158ebee80fe3f1807a02d`, previously tested by Run AJ. Run AK tested the local candidate, containing the reviewed recovery-observation-budget and post-placement-facts changes; it did not publish it. The candidate pins the payload to `c213a374487e6fd7606966f4558a49a0bdf04d53`.

The isolated checkout was `test/run-ak-red-automation`. Production source stayed unchanged. The official `scripts/build-docker-local.ps1 -NoEnvUpdate` local-source mode built the committed candidate without changing the shared configuration.

| Check | Result |
| --- | --- |
| Offline Docker gate | 2,907 runtime and 1,332 mod tests passed; typecheck, Lua build and generated-Lua checks passed |
| Payload | Artifact check and 9/9 tests passed |
| Runner safeguards | 44/44 helper tests, 10/10 archive-checker tests and cleanup-inventory refusal checks passed |
| Exact deployment | All 58 installer-enumerated runtime modules, packaged prompt/release manifest and 31 independently compiled native files matched |
| Cold preflight | New actor 16, seed 3966330848; empty inventory/board, no machinery, zero humans, speed 1, zero provider/Jev inference calls before launch |

The first isolated payload invocation omitted the Compose-file mount and failed with ENOENT. The corrected invocation passed all nine tests; both logs are retained. No source change was needed.

## Trial and terminal blocker

One objective was submitted: `!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.` The declared one-time starter was eight iron plates, a burner drill, stone furnace, pistol and ammunition. There were no corrective prompts or operator gameplay actions after the starter. The 60-minute construction cap was not reached.

The trial ran approximately **22:23:53–22:59:58 America/Toronto on October 21, 2026** (02:23:53–02:59:58 UTC October 22). Goal `goal_0nw7beg_1` remained active. Plan p4 remained EXECUTING at step 3 of 4, the connected water/boiler/steam-engine step. Completed earlier slices did not complete the global goal.

Native evidence established the direct-fed iron canary: drill 32 targeted furnace 33, which finished 99 iron plates. Final pump 34 and boiler 35 had reciprocal native fluid connections. The boiler contained 200 water and 200 steam at 165 degrees, with coal remaining. No steam engine, electrical production chain or automated science output was demonstrated.

Repeated planner reviews and automatic recovery continued to encounter missing validated placement/connection facts. Six automatic resumes occurred across the iron and power steps. At **02:59:07.408 UTC**, recovery `recovery_mviybmwi` failed with:

`provider_jev_recovery_route_failed: checkpoint must be a runtime-supported semantic completion contract or be omitted`

The recovery response attempted a steam-engine placement with an entity-count checkpoint whose shape the runtime rejected. The controller entered a guard pause. The runner independently classified `nonresumable_controller_pause` and recorded `controller_paused:guard`. This is a runtime recovery-contract failure after partial construction, not provider transport failure or proof that the shoreline was physically impossible. Its introduction was not isolated to this candidate by a negative control.

## Changed paths and diagnostic limits

Fresh executor-observation decisions were traced at C3 four times and C7 seven times. Full review-note delivery metadata recorded 1,067 and 1,168 characters; one C3 handoff carried two placed-machine facts without dropping them for size. This exercises parts of both fixes. It does not establish every recovery path: C6 restages occurred without a corresponding executor-observation-start event, and a fresh non-folded C8 decision was not demonstrated. Selected post-batch entity/construction/placement families also remained uncovered in several bundles. The restage-loss analyzer reported two review-note blocks and eight post-batch blocks lost, without a recognized carried copy or reread; note content and semantic equivalence were not independently inspected. Its 18 analyzed fresh-topology blocks were carried. See the independent overwatch notes for exact events and remaining limits.

There were 135 provider requests and 135 responses: 13 planner Sol calls and 122 executor Luna calls, zero provider errors, and zero requests after strict stop submission. Jev recorded 91 requests/exchanges, 87 response events and four fallback events. These counters do not turn the gameplay result into a pass.

Combined traces contained 2,674 behavior, 498 prompt and 309 decision rows, with zero malformed rows. Context-reference analysis found zero dangling references; all four lifecycle flags were zero. Run-check reported nine findings, including restage loops, tracker-behind-batch warnings and a failed request without a chat reply. Restage-loss analysis covered 18 of 24 swaps; six lacked an after snapshot. Its zero blocker-after-swap findings do not establish that all required facts reached the executor.

## Preservation and cleanup

Fresh supervisor cancellation and a same-goal operator-pause receipt were confirmed at **02:59:58.408 UTC**, with native idle state and empty operation/crafting queues. The subsequent **897,272-byte** save passed full ZIP integrity across 56 entries. Its pristine copy loaded in exact **Factorio 2.0.77**, with all 31 active native files matching. Original and pristine-copy SHA-256 matched: `b5840885cb82180603775c823ef62525cb509542ebdb0e32f8aa4c23f3ae7b33`.

The wrapper completed with preservation/cleanup success and Compose-down exit 0 at 03:00:15 UTC. Parent inventory independently verified absence of owned containers, network, disposable volumes, unique image tag and SSH tunnel; the temporary ignored configuration link was removed. Shared `factorio-npc:local` remains as the official-build alias. No second trial, push or Pterodactyl deployment occurred.

A cheaper `gpt-6-luna` subagent provided read-only overwatch and final evidence review. The owner’s E2E and communication rules were recorded in the shared workspace `AGENTS.md`: overwatch prints its own observations, contacts the parent only for actionable issues/final review, and the parent avoids repeating status.

Evidence is retained under `test-results/red-automation-live-2026-10-21ak/`, especially `analysis/acceptance-summary.json`, combined traces/analyzers, `overwatch/`, strict-stop/final-save proofs, `native-save-load/` and `parent-cleanup-proof.json`. Offline/build evidence is sealed separately under `test-results/run-ak-static-evidence/`. Final seals are recorded in the workspace `WORKTREES.md`.
