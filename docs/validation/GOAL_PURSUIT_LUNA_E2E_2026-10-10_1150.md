# Goal-pursuit Luna E2E — October 10, 2026, 11:50 Toronto

The owner requested a new E2E run through CLI proxy with GPT-6 Luna. This fresh authorization supersedes the earlier trial record's consumed live allowance for this one additional isolated attempt. The gameplay result failed: the first provider request timed out after 120 seconds, and the harness paused before admitting any operation. No retry or corrective prompt occurred.

## Candidate and preflight

- Branch: `experiment/goal-pursuit-harness`; tested HEAD: `fd47a3df7c36ad8df8475e3526754096305a9d0b`.
- Fresh `scripts/test-local.sh all` Docker gate passed: 2,103 runtime tests, 1,046 mod tests in 120 files, typechecks, Lua compilation and generated-Lua checks.
- Full pinned build used `scripts/build-docker-local.ps1 -NoEnvUpdate` with opaque original env-file consumption, a unique image, Compose project, data directory and loopback ports. No credential values were read or copied.
- All 49 shipped runtime modules matched HEAD. Active compiled mod matched the release and earlier real-engine gate exactly: SHA256 `6826dbe19ca5ff379b9ab3f83e930014c6e09077845e800414872446a38c20e8`.
- Proxy health and model-list GETs returned HTTP 200; the list included `gpt-6-luna`. The container used that model, the opt-in direct pursuit loop, and no Jev provider. Health GETs did not invoke inference.
- No production runtime or mod source changed. Since the previous native gate, branch changes comprise tests, evidence, documentation and the external controller. The native gates were retained evidence, not rerun engine lanes.

## Trial contract

Started at 2026-10-10 15:50:13.271 UTC (11:50:13.271 Toronto). Fresh world seed `3940049443`; standalone character actor `11`; zero connected humans; speed `1`. Fresh initial inventory and task board were empty.

Objective: reach green science by producing red science and consuming it in native research to complete `logistic-science-pack` and enable its recipe. Trusted success checks required 75 red packs produced, 75 consumed, completed research and the enabled green recipe. Hand crafting and hand-fed machines were allowed; automation was optional.

Declared starter fixture, inserted once: eight iron plates, one burner mining drill, one stone furnace, one pistol and ten firearm magazines. There was no replenishment, gameplay takeover or corrective prompt. Cumulative limits were 30 provider attempts or 20 minutes; requested output cap was 4,000 tokens; provider timeout was 120,000 ms. A host watchdog bounded the isolated container to 19m50s and killed it on controller exit.

## Observed result

| Measurement | Result |
| --- | --- |
| Goal identity | `pursuit_addcab20-25aa-443b-b36e-30878df99d5f` |
| Provider attempts / retries / Jev calls | 1 / 0 / 0 |
| Charged input | 31,016 characters, including instructions and schemas |
| Reservation-to-error latency | 120,105 ms |
| Provider token usage | Unavailable; no valid response parsed |
| Controller duration | 125,533 ms |
| Watchdog elapsed time / stop exit | 128,878 ms / 0 |
| Admitted operations / operation ordinal | 0 / 0 |
| Red produced / consumed | 0 / 0 |
| Green research / recipe enabled | false / false |
| Final state | `paused:Provider timed out after 120000 ms` |

The controller exited 0 because it successfully observed and recorded the pause; this is a failed gameplay outcome. The container exited 137 after the intended watchdog kill. Native checkpoint save was preserved before shutdown. Final actor identity, zero-human state and normal speed were unchanged.

This run establishes proxy model-list availability and safe timeout handling. It does not establish that inference completed or diagnose the proxy's upstream failure. The previous trial failed at the response-size guard; this one reached the timeout. Neither produced gameplay evidence.

## Retained evidence and next step

Full evidence is in `test-results/luna-pursuit-e2e-20261010-1546/`: `static-all.log`, `build.log`, `health.log`, `verification.log`, `container.log`, `controller.log`, `watchdog.json`, `summary.json`, `save-manifest.json`, and the native logs/state under `data/`. Saves are `data/saves/luna-pursuit-fresh-20261010-1546.zip` (716,604 bytes) and `data/saves/luna-pursuit-20261010-1546-checkpoint.zip` (739,274 bytes). SHA256 hashes are retained in `save-manifest.json`.

The deterministic provider-timeout regression already exists in `deploy/pterodactyl/runtime-v8/goal-pursuit.test.mjs` and passed in the fresh all gate. The actual timeout trace and result are retained for future transport investigation. The isolated container is stopped; earlier trial evidence, other worktrees, original env file and other containers were preserved.

Next work is to inspect CLI-proxy request/upstream logs for this timestamp and verify its inference/framing contract. A model-list GET alone cannot explain the missing decision. No additional live attempt was made.
