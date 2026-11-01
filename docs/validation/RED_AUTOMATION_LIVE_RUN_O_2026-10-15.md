# CLI-proxy Run O: stopped before planning because the proxy refused connections

One owner-authorized trial after the reviewed observation-baseline recovery fix. A bounded subagent supervised preparation, the trial, evidence and shutdown. The trial is complete; its isolated stack is down. No second trial, source change, push or deployment occurred.

## Target and preflight

- Complete natural-resource chain: real steam power, automatic iron/copper/coal mining, smelting, gear assembly and red science assembly with native logistics and fuel routing. Hand crafting and feeding are permitted during construction only.
- Readiness target remains **five wall minutes at speed 2**, at least ten game minutes and **1 new red pack per game minute**. AI mutations must be paused throughout measurement, generated enemies removed and expansion disabled first. Native upstream production, assembler output, physical supply topology, queue idleness and factory continuity must support the result. Green science, lab delivery and defense/upkeep remain follow-up milestones.
- Frozen local source **`c0bad249983293f6683be198cc22c58b4821fecb`**, including reviewed observation-baseline code/tests `cd717daa`. Existing gates: **2,390 runtime/staging tests, 1,142 mod tests, typecheck/Lua checks and nine native lanes**, plus original-code red controls and independent review. No production source changed during this trial.
- Server image **`sha256:6aa4224096c0b1dddfbaecfdbfd3e8f5276c2eb815ca6cea3be5ea4ee73559c9`**, built from the clean pinned checkout with `scripts/build-docker-local.ps1 -NoEnvUpdate`. All **50 shipped runtime/staging modules**, packaged prompt and release manifest match the frozen source. All **31 active mod files** match both the release and the final native-tested mod. No mixed runtime overlay.
- CLI-proxy role resolver proved **`gpt-6.1-sol` planner / `gpt-6-luna` executor**, with the dedicated Jev credential present. The isolated ignored overlay corrected the model list before submission; pre-release provider-request count was zero. Credentials and private endpoints were never printed or copied into this report. Four offline Docker observer checks passed.
- Cold world: seed **2305947038**, standalone actor **18**, empty inventory and task board, no machines, zero humans, speed 1, idle native operations. Declared starter: one burner drill, one furnace, eight iron plates, one pistol and ten ammunition. Initial goal **`goal_06hgp79_1`**, request **`req_mv9vtutz_1`**.

## Result

The runner started at **18:38:38.446 UTC**, submitted its initial provider request at **18:38:39.542 UTC**, and recorded terminal **`request_failed`** at **18:40:08.626 UTC**: **90.180 seconds**. All CLI-proxy connection attempts failed before a model response with **`ECONNREFUSED` / `fetch failed`**.

The complete trace through shutdown contains **three provider attempts, zero responses and three errors**. Existing bounded intake recovery initiated two retries, without an operator retry or corrective prompt. The third attempt occurred during checkpoint finalization after the runner had already recorded its terminal result:

| Request | Error time (UTC) | Round | Native transport cause |
| --- | --- | --- | --- |
| `req_mv9vtutz_1` | 18:38:39.580 | 0 | `ECONNREFUSED` |
| `req_mv9vuipx_2` | 18:39:10.454 | 0 | `ECONNREFUSED` |
| `req_mv9vvtl5_3` | 18:40:11.224 | 0 | `ECONNREFUSED` |

Jev completed **12 requests / 12 responses / zero errors**. This isolates the observed failure to the planner/executor provider transport path; it does not establish which host service or network component refused the connection. Model role configuration was verified, but **no actual Sol/Luna delegation or gameplay reasoning occurred**. There were no executor handoffs or `observation.baseline_rebased` events; the baseline fix was not exercised live.

The actor remained at its initial position. Native production counters stayed at zero, no machines were placed, red science remained locked and green research remained incomplete. No operator gameplay corrections occurred after the starter.

**The five-minute benchmark did not start.** No AI measurement lockout, enemy removal, expansion change or speed 2 was applied. This run provides no automation throughput or full-chain readiness evidence.

## Evidence and next boundary

Ignored directory **`test-results/red-automation-live-2026-10-15o/`** retains `supervisor-status.md`, the server build log, exact deployment/native-mod hashes, initial/native snapshots, objective contract, provider and Jev traces, canonical state, terminal result, summary, an eleven-file SHA256 manifest, and **743,177-byte** `data/saves/red-automation-o-checkpoint.zip`. Private overlay/configuration remain ignored and excluded from the manifest. The isolated stack and its network were removed; the unrelated Endfield container was left running.

Offline Docker run-check exits **0**, reporting three informational intake-retry signatures and no parse errors. This confirms the analyzer recognized the existing transport-retry classification; it is not a successful live gameplay test.

Restore or verify the configured CLI proxy's availability before proposing another explicitly authorized cold trial. Do not treat this connection refusal as evidence of a new gameplay regression or spend another provider campaign without a new go. No release promotion follows from this run.
