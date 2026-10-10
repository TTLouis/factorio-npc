# Single Luna pursuit trial — 2026-10-10

The authorized experiment is complete, with a failed autonomous gameplay result. The real opt-in harness, independent invariant review, Docker/static/engine gates and frozen deployment verification preceded exactly one Luna trial. The trial paused before any gameplay action. The allowance is consumed; no second attempt, restart, corrective prompt or provider retry is authorized by this record.

## Candidate and gates

- Source integration: `c1194b28d5f18f3d885181f3f0223a6bd6cae13a`; separate installer repin/deployed image: `cea70174d2bcd2a5fabfadc48264bfae6182321f`.
- External controller fix: `d4e048be367d810b0c4a35423ffdf3760d475908`. Only the unshipped host watchdog changed: discover the bundled Node binary from the pinned release and persist a pre-launch attempt marker. The frozen image remained unchanged. All runtime modules in HEAD equal the deployed candidate.
- Required Docker all gate passed before trial: 2,102 runtime tests; 1,046 mod tests in 120 files; typecheck, Lua build and generated-Lua checks. `candidate-all.log` records the post-repin all gate, exit 0.
- Required full build passed, `full-build-final.log`. Engine image build and pursuit/provenance lanes passed, `native-final.log`. Native proof: four fixture plates consumed to craft two gears, campaign reload/new owner goal, cumulative calls and ordinals both two, zero humans. Offline provenance cannot exercise the human last_user arm.
- Clean pinned full local build used `scripts/build-docker-local.ps1 -NoEnvUpdate`, opaque original env-file consumption, unique image/project/data/ports, no runtime override. All 49 shipped modules matched source; active compiled Lua matched release and engine-tested Lua exactly (SHA256 `6826dbe19ca5ff379b9ab3f83e930014c6e09077845e800414872446a38c20e8`). Proxy root/model listing returned 200 and listed gpt-6-luna; these GETs did not invoke inference.
- Independent reviewer `/root/pursuit_invariant_review` approved the fixed source invariants, inventory-text fix and external watchdog. Post-trial evidence review found no new invariant blocker and explicitly classified this as a safe failed trial, not autonomous success.
- Post-trial deterministic regression reproduces the observed oversized-response byte count, asserts one durable charge, zero admission and no automatic retry after restart. Docker all passed: 2,103 runtime tests and unchanged 1,046 mod tests, with typecheck/Lua guards. Runtime behavior was not changed after the trial.

## Trial contract and actual outcome

The exact immutable objective was: “Reach green science: produce red science packs and consume them in native lab research to complete logistic-science-pack and enable green science. Hand crafting and hand-fed machines are allowed; factory automation is optional. Use natural resources and native game mechanics. Finish when logistic-science-pack is researched and its recipe is enabled.” Trusted done conditions required at least 75 red packs produced, 75 consumed and logistic-science-pack research complete. The observer also required the green recipe enabled for success.

Starter kit, inserted once before raw chat: 8 iron plates, 1 burner mining drill, 1 stone furnace, 1 pistol and 10 firearm magazines. Fresh world seed 3213092024, standalone actor 6, zero connected humans, game.speed 1. No replenishment, cheats after the declared fixture, operator gameplay takeover or corrective prompts.

| Measurement | Actual result |
| --- | --- |
| Trial start | 2026-10-10 14:23:28.025 UTC |
| Goal identity | pursuit_4dc62ca9-0bd4-415d-9bd4-c8f9156506e6 |
| Provider requests / retries / Jev calls | 1 / 0 / 0 |
| Cumulative charged input | 31,015 characters, including stable instructions/tool schemas |
| Requested output cap | max_tokens 4,000 |
| Request-to-error latency | 41.669 seconds |
| Body bytes observed at cancellation | 263,521 (exceeds existing 256 KiB guard) |
| Cached/uncached input, output tokens | Unavailable; no valid response parsed |
| Controller duration / successful container stop | 45.280 seconds / 48.876 seconds |
| Admitted batches / duplicates | 0 / 0 |
| Time to first action / native reaction latency | Unobserved; no action |
| Native idle state | No trial gameplay task or pending admission; ordinal zero |
| Red produced / consumed | 0 / 0 |
| Green research / recipe enabled | false / false |
| Final status | paused: Provider response too large |

The body was cancelled and not retained after crossing the guard. Its content and the cause of its size are unknown; the 4,000-token request is not proof the proxy enforced that cap. No usage estimate is presented as a provider token count. The provider control-contract trace still lists legacy completion-field metadata; the actual pursuit prompt/protocol uses observations/operations/notes/pauseReason. That metadata is diagnostic debt, not completion authority.

The external watchdog bounded the entire isolated container at 19m50s (ten seconds below the authorized 20-minute cap), began before controller launch, and killed the container on every exit/error path. It stopped on the truthful pause, exit 137. The runtime retained the charged allowance and objective, with no pending operation. A native checkpoint save was written before shutdown. The isolated container is stopped; other containers/worktrees were not modified.

## Evidence and next step

Small immutable result/trace/manifest records are committed in `goal-pursuit-2026-10-10/` beside this document. Full local evidence remains under `test-results/goal-pursuit-2026-10-10/`: static/build logs, failed and corrected engine lanes, native saves, actual prompt trace, pursuit state, observer snapshots, raw container logs and deployment hashes. Trial saves: `live/data/saves/luna-pursuit-20261010-checkpoint.zip` (516,589 bytes) and `luna-pursuit-fresh-20261010.zip` (495,310 bytes); hashes are in the committed evidence manifest. No secret or proxy hostname was copied into these committed records.

The October 8 legacy trial made six calls, 132,033 input tokens (73,728 cached), 1,108 output tokens and no gameplay actions. Both runs failed before gameplay, but this run failed at a transport size boundary rather than the old planner/executor blocker. Their older commits, different goals/fixtures/lifecycles and unequal durations prevent a controlled performance comparison. This experiment proves safety/accounting and native scripted integration, not improved autonomous red-to-green capability.

Next concrete work is an offline investigation of the proxy response framing/output-cap contract, using retained diagnostics and mocked responses. Do not weaken the size guard or infer an oversized model decision without evidence. Natural wood harvesting also remains unavailable through the conservatively refused ambiguous harvest operation; native source-specific protection is required before admitting it. Any additional live trial needs fresh explicit authorization.

Final shared usage: 46% five-hour and 52% weekly, below the retained 56% checkpoint and 61% stop boundary. No reset credit consumed. All authorized work is closed; no live allowance remains.
