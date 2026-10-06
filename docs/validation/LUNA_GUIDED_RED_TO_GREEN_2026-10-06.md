# Assisted red-to-green finish — October 6, 2026 (Toronto)

**Succeeded: 75 red packs natively crafted and 75 consumed by steam-powered labs; green science researched and its recipe enabled.** Completed at `2026-10-06T09:15:04.531Z` (05:15 Toronto). This was operator-assisted after the [autonomous retry paused](LUNA_JEV_RESUME_2026-10-06.md).

The owner authorized: “just push to the goal with your help, and log things down again.”

## Exact assistance

| Owner | Contribution |
|---|---|
| Luna | Chose the initial copper-gathering plan and natively mined ten copper ore. Then twice omitted step completion and paused. |
| Jev | Routed the initial goal and supplied bounded judgments: seven requests/responses, no decision fallback. |
| Operator (Codex) | Chose and drove all remaining gathering, smelting, native recursive crafts, power construction, all 75 red crafts, lab feeding, normal research request and verification. |

The guided trace contains **66 admissions and 65 completions**. One coal operation was interrupted and rolled back during recovery, then repeated natively. Main-provider calls stayed at **seven total**; no further Luna prompt or replay finished the goal. This does not establish autonomous Luna completion.

## Native proof

Unchanged candidate `1eb6172f75089d89122b101cd56aaccbeafafcd3`, Factorio 2.0.77, seed 1196625720, standalone actor 25, speed 1. The owner connected during parts of the run; final verification had zero connected humans. Actor identity came from `autorio_actor.status`, not the first character entity.

No operator item grants followed the starter kit, and there was no teleporting, speed increase, technology grant or artificial production-statistics call. Existing deployed native-crafting bridge behavior supplies the engine's missing research-trigger statistics for confirmed standalone native crafts.

The live recursive recipe bill was **264 iron plates and 106 copper plates**. Eight starter iron plates plus 256 mined/smelted ore supplied iron. Luna's ten copper ore plus 96 operator-directed native mining cycles supplied copper. Native harvesting yielded 45 stone and four wood. Six additional furnaces were crafted using 30 stone; together with the starter furnace, six were placed and one was consumed by the boiler recipe. Fifty coal were gathered, with 30 supplied to furnaces and 20 to the boiler.

Four furnaces each produced 64 iron plates; two each produced 53 copper plates. Native plate production unlocked electronics and steam power; two native lab crafts unlocked red science. The pump, boiler, engine, two poles, two labs and science intermediates were natively crafted from the verified bill.

Live fluid-port geometry and bounded placement checks determined a direct pump → boiler → engine layout. Final observation showed water and steam in the boiler, steam in the engine, and both labs energized on network 1. Five native batches of 15 red packs were hand-fed into the labs. Live research cost: 75 units, one red pack per unit, five seconds per unit.

Final research receipt: accepted and completed, `logistic-science-pack`, **`by_script: false`**. Production condition: exactly 75 red; consumption statistics: exactly 75. Technology researched and recipe enabled were both true.

The task-board world check reads **1/1 met**, but its status remains `paused` from Luna's failure. The gameplay objective is complete; planner lifecycle and autonomous continuation still need repair. No board completion status was forced.

## Recovery and logs

A human joining during the third red-craft batch subsequently suffered a confirmed client/server CRC desync. The first recorded mismatch was tick 104177, one tick after batch completion at 104176; the server received the notification about 71 seconds after joining and continued to finish research. External command/polling involvement and join causation remain unproven. No new Luna/Jev call occurred around the incident. [Multiplayer incident record and captured logs](MULTIPLAYER_JOIN_DESYNC_2026-10-06.md). This assisted gameplay success does not establish multiplayer stability.

An operator read-only request for five radius-24 candidate sets blocked the engine during candidate sorting. RCON timed out. The blocked container was stopped and the saved checkpoint containing Luna's copper restored; unfinished coal progress was discarded. The first recreation raced the configuration edit and briefly loaded the initial world. This was detected and corrected before any gameplay or provider action. Recovery verified actor 25 and its copper, with epoch 2. Radius-4 queries and explicit small placement checks then succeeded. These mistakes and recoveries are logged.

Ignored evidence: `test-results/luna-jev-resume-2026-10-06/data/logs/`.

- `e2e-guided-operations.jsonl`: assisted actions, receipts, snapshots, recovery and milestones.
- `e2e-guided-contract.json`, `e2e-guided-recipe-check.json`: assistance boundary and verified bill.
- `e2e-red-to-green-success.json`, `e2e-guided-final-audit.json`, `e2e-guided-npc-state-final.json`: physical proof, attribution and persisted state.
- Original prompt, behavior, decision and failed autonomous observations remain intact. The failing offline run-check was not reclassified as a passing autonomous test.

Successful checkpoint: `luna-guided-red-green-success.zip`, 766,917 bytes, SHA256 `ac77d4a34e323b4a3cc7130f5ed7b55178b93350656092806856e1fdc80ed16c`. The one current Factorio server remains available on UDP 34201: `127.0.0.1:34201`, or `100.98.209.103:34201` over Tailscale. Earlier containers were not restored. Its matching client mod is installed in the owner's requested mods folder.

No production source changed. Source gates and deployment checks are in the autonomous retry record. Guided scripts passed Docker-hosted syntax checks, and live goal assertions/final audit passed. This validates the assisted path and this concrete steam/lab layout; generalized production and autonomous planning remain unproven.
