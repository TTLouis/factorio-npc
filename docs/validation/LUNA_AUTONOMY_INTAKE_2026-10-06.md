# Luna autonomy trial — October 6, 2026 UTC

Result: **the fresh-world task was misclassified as chat; no gameplay plan was admitted**. Red science and green research were not reached. This trial does not validate or invalidate the newly repaired execution paths, because none ran.

## Candidate and checks

Candidate `1eb6172f75089d89122b101cd56aaccbeafafcd3`, on `experiment/jev-agent-architecture`, contains merged repair units A–E. Independently checked from a clean tree:

- `scripts/test-local.sh all`: exit 0; 1,749 runtime tests passed, zero failed, three TODO; 1,030 mod tests passed, typecheck, Lua build and generated-Lua check passed.
- Installer generated-artifact check and all nine payload tests: exit 0, offline Docker.
- Supported full local build, `scripts/build-docker-local.ps1 -NoEnvUpdate`, Factorio 2.0.77: exit 0. The secret `.env` was neither read nor rewritten by the operator.
- All 39 deployed top-level non-test runtime modules matched committed source after CR normalization. The running mod's `control.lua` matched the compiled release, SHA256 `f33f561bf8ca035028b650490b91ea0ba2c417e7e819dafdadf4f614d44946e2`.

The recorded replay's three TODO gaps remain: a wait on an idle machine with an already-met checkpoint, closing that stock checkpoint before a later extraction, and refreshed held counts for a prose-only executor step. No merge-blocking issue was established in the newly inspected repair paths; this was a bounded check, not exhaustive certification.

## Run contract and assistance

The owner explicitly requested this Luna run. The owner's CLI proxy on Tailscale was used with `gpt-6-luna`, `AI_API_METHOD=local`, and Jev disabled. Existing client credentials were loaded opaquely by Compose. Proxy account priority/routing was not changed or verified.

Separate project `luna-autonomy-20261006`; fresh data under ignored `test-results/luna-autonomy-2026-10-06/data/`. Natural default-generated world, seed 3132815441, standalone actor 7, zero humans, speed 1, initially empty inventory, no task board and no built machines. RCON was published only at `127.0.0.1:27018`; earlier worlds and unrelated containers were untouched.

One declared vanilla starter kit was supplied before the objective: eight iron plates, one burner mining drill, one stone furnace, a pistol and ten magazines. The engine equipped the weapon/ammunition. No later items, terrain edits, teleports, research grants, direct gameplay operations, corrective prompts or provider replays were supplied.

The one raw chat objective was:

> Produce red science and use it to research logistic-science-pack and unlock green science. Hand crafting and hand-fed machines are allowed; factory automation is optional. Use natural resources and native game mechanics. Finish when logistic-science-pack is researched and its recipe is enabled.

The operator built and verified the candidate, configured isolation, supplied the declared kit, submitted this goal once, observed read-only world state and stopped the idle container. Luna made no gameplay decisions or operations in this attempt. The goal was not reworded to force admission.

## Observed intake failure

At `2026-10-06T07:41:50.197Z` the interaction router request carried the objective, `current_goal: null`, and runtime `task_state: idle`, `queue_empty: true`, `queue_length: 0`.

At `07:41:58.174Z` the proxy returned a valid response for `gpt-6-luna`:

```json
{"intent":"chat_only","queue_conflict":false,"reply":""}
```

The runtime accepted this route, printed its fallback “I am here.” and retained the exchange only as dialogue. Persisted `plans` and `planning_states` remained empty. The UI had an idle conversation with empty goal ID and zero steps; no new goal or request ID was minted. Actor 7 remained at (0,0) with the original construction supplies. At the last observation, tick 14089, red production and consumption were both zero; red and green recipes were disabled and green was unresearched.

Exactly one provider request and one response were retained: 812 input units, 314 output units (including 292 reasoning), 1,126 total, zero cached input. These are reported usage units, not billed dollars. The request asked for 180 output units; the provider diagnostic reported `provider_output_cap_ignored`.

The isolated container was stopped cleanly (exit 0) at `07:44:37.132Z`. Its saved world was `data/saves/luna-autonomy-fresh.zip`, 946,646 bytes, SHA256 `c556efe9df9d3192ef96e5ac0c50f7e9cdc5cd03b6acb1b766f6ed11b5ba125b`. The owner subsequently requested cleanup on October 6: the container, saved world and duplicate server logs were removed; captured trial evidence remains at its original log paths.

## Concrete follow-up finding

The captured router payload has an extra, final user-role `[STEERING]` block after the JSON containing the actual human objective. It gives generic gameplay decision-order, batching, locality and success-evidence guidance. The production path confirms why: `provider-base.mjs` calls `applySteeringMessages` unconditionally, including for `interactionRouter: true`. Thus the classifier does not receive an isolated classification packet.

The inappropriate extra message is proven by the captured payload and source. **Whether it caused the `chat_only` answer is unproven**; no counterfactual model call was made. The router rubric also describes `new_goal` as a materially different goal without explicitly describing a first task when no goal exists. That is a contract weakness, not proof of which words caused this answer.

Next repair should isolate classifier requests from gameplay steering and cover first-task intake with `current_goal: null`. Preserve normal chat/status/cancel behavior; do not promote every idle message into a gameplay goal or insert a hand-authored Factorio walkthrough. Add deterministic payload/recorded-route regression coverage before another owner-approved live trial. Units A–E and their three known gaps remain separate from this intake blocker.

## Evidence and observer limit

Ignored evidence directory `test-results/luna-autonomy-2026-10-06/`: `live.compose.yml`, `run-live.mjs`, `live-observation.log`, deployed runtime copy, `data/logs/sgluna-prompts.jsonl`, initial/periodic world snapshots, contract, persisted state and derived result. Gate/build logs are `test-results/luna-head-2026-10-06-{gates,payload,build}.log`.

No behavior JSONL was created before goal admission, so the original observer printed `provider_calls: 0` while the prompt log correctly recorded the router call. The derived result counts prompt requests and reports one. The ignored observer has subsequently been corrected to count prompt requests and terminate after a response leaves no admitted goal; it was not rerun. Stopping the container terminated its observation process (exit 137); that is operator cleanup after the confirmed intake failure, not a provider or Factorio crash. No `run-check` success is claimed for an absent gameplay trace.
