# Fresh Luna + Jev trial after contract repair — October 7, 2026

The owner authorized one new live run on pushed candidate `bea69cbccfb21e8b5b9f4baf05f14413809e4146`. The controller completed electronics, then paused during the steam-power step. Autonomous red-to-green acceptance failed: native red production and consumption remained zero, `logistic-science-pack` remained unresearched and its recipe disabled. The canonical goal stayed active and the board paused truthfully at 1/4.

## Candidate and conditions

The candidate's recorded Docker gates passed 1,855 runtime tests, 1,036 mod tests, typechecks, generated Lua, full build, nine payload checks and deterministic native research/crafting/restart lanes. The live image was rebuilt using `scripts/build-docker-local.ps1 -NoEnvUpdate`, Factorio 2.0.77. All 41 deployed runtime modules matched committed source hashes; active mod control matched the compiled release, SHA256 `d9434a7652c9c9cee836d06b96e17065c77d9805be2b479cf31b259ed23c8f17`.

Tailscale proxy health and authenticated models returned HTTP 200; `gpt-6-luna` and the dedicated Jev token were available. Credentials were handled opaquely by Docker; `.env` was unchanged. The owner's Luna preference overrides the older repository model rule for this task.

A separate initially empty data directory generated seed `1457519261`, standalone actor 6, epoch 1, speed 1, zero humans, empty initial inventory, no machines and no board. The existing starter supplied eight iron plates, a burner drill, a stone furnace, pistol and ten magazines. One raw objective requested native red production/consumption and green research, allowing hand crafting and hand-fed machines. No corrective prompts, operator gameplay after the starter, actor replacement, human joins or external provider retries occurred. The 45-minute bound and existing runtime admission/recovery guards were retained; the owner had removed the earlier 60/120 trial call limits.

## Observed sequence

The run started at `2026-10-07T08:49:42Z` (04:49 Toronto), lasted 330.916 seconds, and used 21 Luna requests/responses and 19 Jev requests/responses. Luna usage was 539,563 input units and 5,831 output units; 403,968 input units were cached. Some Jev calls are shadow judgments and are excluded from the narrower 17-call runtime health summary.

1. Luna authored four deterministic research checkpoints: electronics, steam power, automation science, then logistic science. The harness committed `goal_065pf7k_1_p3` and delegated to the executor. The previous all-semantic execution-contract failure did not recur.
2. Luna mined ten copper ore and five coal. A first furnace placement failed with `placing:no_position`; Luna recovered through an observed validated placement candidate and placed furnace 12. It fed copper ore and coal, and native smelting produced ten copper plates.
3. Luna also attempted additional copper gathering while smelting; that batch failed with `mining:mining_rejected`. Shared world-state settlement subsequently verified completed electronics and advanced to the steam-power step. The failed operation was not treated as a successful receipt.
4. Luna mined 50 iron ore. Final inventory held those ore and the starter's eight iron plates; furnace 12 held ten copper plates in output and four coal in fuel, with no source items.
5. After a recipe observation and the observation-budget closure, Luna returned: `BLOCKED: The 50 iron ore has been gathered, but the available live recipe data shows the only nearby stone furnace is set to copper-plate. I can’t safely change or supply that exact furnace without a fresh entity observation, and observations are closed for this decision.`
6. The harness rejected an unsupported world-blocked claim and recorded `recoverable_provider_failure:provider_reported_blocker`, preserving the active goal `goal_065pf7k_1` and pausing step 2. No green completion or false goal retirement occurred.

This trial demonstrates autonomous progression beyond the repaired contract boundary: native gathering, placement-error recovery, furnace supply, electronics completion and next-step mining. It does not establish red-to-green autonomy. The next investigation is the evidence and decision boundary around reusing the observed furnace after its first recipe finishes; the retained packet contains recipe data and a closed observation envelope. A specific harness defect or sufficient continuation fix has not yet been established.

## Evidence and closeout

The local evidence root is `test-results/luna-semantic-live-2026-10-07/`. It retains deployment verification, build/server/observation logs, exact prompt and decision JSONL, final state, retained control replies, usage summary and SHA256 manifest. The offline checker parsed 286 behavior rows for one request without parse errors or findings; its current patterns do not diagnose this new blocker.

The terminally paused container and its Docker network were removed after evidence capture. Only verified trial-directory save ZIPs were discarded; other projects and their containers were untouched. No server remains on UDP 34201 for this run.

Shared weekly usage reached 19%, this phase's ceiling from a 14% starting point. Another task shares the account, so the five-point change cannot be attributed entirely to this work. Further trials and repairs stop at this budget checkpoint; no additional live retry was launched.
