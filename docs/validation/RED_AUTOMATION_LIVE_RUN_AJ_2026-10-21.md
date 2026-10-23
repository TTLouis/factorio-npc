# Run AJ — b9574fc4 red-science automation E2E

**The source and deployment checks passed; the autonomous factory trial failed.** The NPC produced 53 iron plates and 12 copper plates and placed a shoreline pump, then exhausted both automatic recovery attempts while trying to establish the connected boiler/steam-engine chain. It produced and consumed zero automation-science-packs.

Frozen source: `b9574fc4556eafb431f158ebee80fe3f1807a02d`, verified against the published `experiment/jev-agent-architecture` ref before preparation. This commit pins the installer payload to code commit `07288ed466341437152699b8bc77ae4f96f484d8`: placement clearing, water reach/approach and the C3/C8 restage fold. The source was not edited. One owner-authorized trial ran in isolated branch `test/run-aj-red-automation`; no push or Pterodactyl deployment occurred.

## Readiness

| Check | Result |
| --- | --- |
| Standard offline Docker gate | 2,881 runtime / 1,332 mod tests; typecheck, Lua build and generated-Lua checks passed |
| Payload check/tests | Passed, 9/9 |
| Runner helper / archive checker tests | Passed, 44/44 and 10/10; cleanup-inventory refusal checks passed |
| Official pinned local build | Passed; Factorio 2.0.77; no environment-file update |
| Deployed identity | All 58 installer-enumerated runtime modules, prompt/release manifest and 31 independently compiled native files matched |
| Cold world / provider contract | Actor 18, seed 3023884473; empty inventory/board, zero machines/humans, speed 1; zero provider/Jev inference calls before launch; CLI-proxy catalog and role wire contracts passed |

A cheaper `gpt-6-luna` subagent reviewed source/pin and runner safeguards, then provided independent host-only oversight. Another Luna subagent prepared copied run helpers and inspected offline analyzer inputs. The parent reviewed, validated and integrated that work and owned all live controls and teardown.

## Autonomous trial

The raw objective was: `!luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.` The reviewed starter was 8 iron plates, one burner drill, one stone furnace, pistol and ammunition. There were no corrective prompts, manual resumes or operator gameplay actions after the starter.

Run interval: **13:54:40–14:24:44 UTC on 2026-10-21** (09:54:40–10:24:44 America/Toronto), **1,804,252 ms / 30.07087 minutes**. The 60-minute construction limit was not reached. Goal `goal_19qf4j1_1` remained globally **active**; plan p5 remained **EXECUTING**, step 5 of 6: “Establish a shoreline pump, connected boiler and steam engine using validated live fluid geometry.” Completed p3/p4 slices did not complete the global goal. No automated-rate measurement or topology-approval candidate was reached.

Final native production: 53 iron plates, 12 copper plates, 53 iron ore, 12 copper ore, 25 coal; **zero red science produced/consumed**. Machines were iron drill 35, furnace 36 and offshore pump 37 at `(7.5,50.5)`, direction 4. The boiler and steam engine remained held. No connected steam/electric production was demonstrated. The previous Run AI stone-mining rejection did not recur; this does not establish its cause or remediation.

## Terminal blocker

At 14:20:25, the executor requested planner review for missing placement/fluid geometry. It subsequently placed the pump (authoritative placement receipt at 14:22:04), but requested another review because the closed observation round lacked the facts needed to place the connected boiler.

Automatic resumes ran at **14:22:19** and **14:23:07**. Their open observation rounds were spent on navigation/actor/nearby/inventory facts, then fluid-source/inventory/equipment facts. Both reached `allow_tools=false` without obtaining the remaining boiler/engine placement candidates. They returned `local_recovery_exhausted` / `approach_infeasible`. At **14:23:31**, `recovery.auto_resume_exhausted` recorded `step_limit_reached_without_verified_progress`, step 2/2 and goal 2/6. The runner independently classified `current_automatic_recovery_exhausted` at 14:24:44 and stopped. This establishes an observation/recovery dead end; it does not prove a physical shoreline impossibility or isolate a regression to this commit stack.

Water-source reads carried approach facts, and pump candidates supplied fluid-port geometry. Searches reported incomplete generated coverage. **Placement clearing and the successful C3/C8 fold were not exercised**: clearing candidates were zero, and both fold opportunities reported `not_step_close_restage`. Their live correctness is therefore not established by this run.

## Traces and preservation

115 provider requests / 115 responses / zero errors: 22 Sol planner and 93 Luna executor calls. Jev: 87 requests/exchanges, 85 parsed responses, two cancelled/superseded fallbacks, zero `decision.error` events. Two automatic resumes; zero provider requests after strict stop submission. Twelve semantic steps verified; 22 close attempts declined.

Combined traces contain 1,981 behavior, 419 prompt and 293 decision rows, with zero malformed rows. Context-reference analysis found zero dangling references; all four lifecycle flags were zero. `run-check` was red with four findings: two restage loops, a tracker-behind-batch warning and automatic-resume exhaustion. The completed pump-placement batch did not satisfy the whole connected-power step. Restage-loss analysis covered 12/16 swaps (four lacked an after snapshot), with zero blocker-after-swap findings. These diagnostic passes do not make the gameplay result pass.

Fresh paired cancellation and same-goal operator-pause receipts were confirmed at **14:24:44.610 UTC**. The subsequent **535,074-byte** save passed full ZIP integrity (55 entries), exact 31-file active-mod verification and pristine **Factorio 2.0.77** native load. Source and pristine-copy save hashes matched: `c850edabda5dfa57ef58204734d000d45d6033455acafedf6a193a7226a7a656`.

The wrapper finished at **14:24:56 UTC**, `failed=false`, Compose down exit 0; this reports successful preservation/cleanup, not successful gameplay. Parent verification at 14:25:34 confirmed no owned containers, networks, volumes, unique image tag or SSH tunnel remained. The temporary ignored configuration hard link was removed; shared `factorio-npc:local` was retained. Weekly allowance was 89% remaining at preparation and the steam-prerequisite milestone, and 88% at closeout. Oversight finished; no background work or second trial remains.

Evidence: `test-results/red-automation-live-2026-10-21aj/`, especially `analysis/acceptance-proof.json`, analyzer outputs, `overwatch/summary.md`, final-save/native-load proofs and `parent-cleanup-proof.json`. Offline/build logs are in `test-results/run-aj-checks/`. Final evidence seals are recorded in the workspace `WORKTREES.md`.
