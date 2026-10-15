# CLI-proxy Run L: operation-argument recovery stopped before smelting

One owner-authorized trial on October 15, 2026, after the reviewed [Unit 20 fix and full-loop gates](UNIT20_QUEUED_CRAFT_ADMISSION_2026-10-15.md). This trial is concluded and its isolated stack is down. It does not authorize another provider run.

## Frozen deployment and procedure

- Pushed source **`0fbc4bff18ac14bba5c3273740e73d36cff22d3c`**, containing reviewed source/tests `da8d3bdb` and no-ff integration `d16a15db`. Server image **`sha256:e5f08fc885dbaeded19b7c2c3732bc355a4bfadf4c5a4e8481e3d649f2ce96ca`**, built only with `scripts/build-docker-local.ps1 -NoEnvUpdate` from a clean pushed tree.
- Deployed verification: all **50 runtime/staging modules**, committed prompt and release manifest matched. All **31 active mod files** matched the release; an additional network-disabled packaging check matched the release mod against the frozen passing native-test image after text CR normalization. No runtime overlay.
- Actual configured/model-trace model **`gpt-6-luna`**, local CLI-proxy method, dedicated Jev enabled. Endpoint and credentials remain private/ignored.
- Fresh seed **73247206**, standalone actor **24**, epoch **1**, goal **`goal_1t2ivg4_1`**, request **`req_mv9dvmsy_1`**. Zero humans, speed 1, empty initial inventory/board and no prebuilt machines. Same one-time starter: drill 1, furnace 1, iron plates 8, pistol 1 and ammo 10.
- Single raw-chat objective: unlock `logistic-science-pack` through native red production and lab research. No preset duration cutoff, no corrective prompts or gameplay after starter, existing controller limits unchanged. Driver observes every 90 seconds and retains trace rows across rotation. Offline completion-proof tests passed before the trial.

## Result

The driver started **10:16:08.371 UTC**, stopped at approximately **10:20:38.714 UTC**, elapsed **4m30.343s**, with `controller_paused:guard`. The last behavior row is 10:20:16.794 UTC; polling detected the pause afterward.

**11 main-provider requests / 11 responses / 0 provider errors; Jev 17 / 17.** No model auto-resume started. The guard pause is outside the automatic-resume allowlist. Weekly usage remained **94% available** at conclusion; no reset credit used.

Autonomous native gathering reached **10 copper ore, 50 iron ore and 5 stone**. The starter furnace remained held; no furnace/power/lab cell was placed. Red production and consumption stayed **0**; green research and recipe remained **false**. The requested research goal did not complete.

Neither the Unit 19 completed-slice blocker route nor Unit 20 receipt-required trace fired live. There was no Run J checkpoint fault or Run K partial craft admission; this trial stopped before reaching those conditions. The new fixes are proved by their original-code red replay and passing static/native full-loop tests, not by this short live trial.

## Failure boundary and next regression

At **10:20:08.726 UTC**, the executor submitted two structured operations for the copper-smelting step. Parsing rejected an invalid `unit_number` before admission; `replan.started` records `unit_number must be an integer from 1 to 9007199254740991`. The captured provider response metadata does **not** retain the submitted tool arguments, so the exact operation kinds and invalid value cannot be asserted or reconstructed as fact.

The recovery trace classified this as **`unknown`**, selected **`wake_planner`** (confidence 0.65), restaged the executor and called it with **`allow_tools:false`**. That matches the current compact recovery branch in `npc-agent-loop.mjs`, which enables tools only for `targeted_observation`. The model then returned an unsupported blocker about unavailable furnace/smelting verification. The one permitted fresh-context recovery also ran with observations disabled and returned another unsupported blocker. Outcome authority rejected both world claims. The terminal reason is:

`provider_jev_recovery_route_failed: provider_action_omission_repair_failed: unverified_blocker_recovery_exhausted; no authoritative world blocker was established`

This is a separate recovery/classification boundary, not proof that the world was impossible. Before another live trial:

1. Add a scripted full-loop regression using a **representative** invalid entity reference, clearly distinguished from the unavailable raw Run L arguments. Assert no admission or native mutation from the malformed batch.
2. Classify deterministic operation-argument errors through a bounded model-correctable route that can obtain the missing current facts without changing the committed goal/step or raising limits. Never invent an ID for an unplaced entity; use placement receipt followed by fresh nearby discovery before targeted supply/collection.
3. Drive correction through real placement/supply/smelting/collection receipts to a verified copper result; add existing-cap exhaustion, stop/epoch and no-replay variants. Mirror the successful chain in a native fixture before a new authorized provider trial.
4. Include a checkpoint-scope negative. This run also shows a furnace-crafting draft corrected to gather stone: the retained step description stayed “Craft a stone furnace,” while its contract became `stone >= 5` and closed after mining. A furnace was already held, but acquisition evidence must not replace the committed result requirement. Preserve this observed contract discrepancy in the replay rather than treating it as additional native production proof.
5. Preserve bounded structured details of invalid operation submissions so future argument failures can be replayed exactly without recording arbitrary provider payloads or secrets.

## Evidence

Ignored integration-worktree directory: `test-results/luna-green-live-2026-10-15l/`. It contains deployment/native-mod checks, driver/observer scripts, `summary.json`, `recovery-validation-case.json`, behavior/prompts/decision logs, native snapshots, final canonical state, hash manifest and a **577,689-byte** `data/saves/luna-green-l-checkpoint.zip`. The case explicitly marks the missing raw operation arguments.

Offline `run-check` exits **0** over **235 rows / 1 request**, zero parse errors and no flagged signatures. This analyzer result does not mean the gameplay goal succeeded: the recorded result is a recoverable runtime failure ending in a guard pause. Save/traces are preserved, the trial Compose project is down, and unrelated containers were left alone.

The following production milestone remains **automated red and green science**: deterministic powered assembler/inserter output and lab-research continuity before guided/autonomous promotion, as described in the Unit 20 checkpoint and production validation roadmap. Hand crafting and an unlocked recipe are insufficient evidence of automation.
