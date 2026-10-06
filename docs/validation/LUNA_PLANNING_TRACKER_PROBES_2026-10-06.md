# Luna planning and tracker probes — 2026-10-06

The owner authorized planning/tracker tests with Luna and identified the local Docker VM hosting CLI proxy. This is a follow-up to the reconciliation at `df2da567`, not an autonomous Factorio run. Private network identifiers remain in the local session; endpoint examples below are anonymized.

## Connection and health

Tailscale was brought online with its existing shields-up setting preserved; launching the installed background client completed startup. The online Docker peer's Tailscale DNS name was used for the health checks and probes.

From Docker, `http://<docker-peer>.<tailnet>.ts.net:18317/` returned HTTP 200 and identified itself as CLI Proxy API Server. Authenticated `/v1/models` returned HTTP 200, 14 models, including `gpt-6-luna`. Port 8317 refused the diagnostic connection.

The configured `.env` endpoint currently uses Docker's host alias; its local listener remains unavailable. These probes used an ephemeral `OPENAI_API_BASEURL=http://<docker-peer>.<tailnet>.ts.net:18317/v1` override. `.env` and proxy account routing were not changed. Credentials were injected opaquely by Docker and omitted from evidence.

## Four one-shot decisions

The existing opt-in runner supplied production role/reliability prompts, closed-round provider protocol, fixed authoritative observations and local tracker fixtures. There were four provider requests, no retries or corrective prompts, zero Jev calls, no game connections and no gameplay admissions. Each request had a 90-second timeout and the production 256 KiB response limit.

| Probe | Model response | Result |
| --- | --- | --- |
| New plan | Aligned copper inventory and completed-research predicates; `operations: []` for the initial deterministic step. | Action admission failed. The runner initially reported an undefined `task_board` dereference; a subsequent diagnostic-only guard now reports the missing initial operations directly. |
| Unmet/stale research | Kept the current index open and made no completion claim, but returned `BLOCKED` with no action. | Truthful tracker retention passed; the probe's requirement for a next research action failed. |
| Satisfied-step continuation | Used index 1 and proposed `research_technology` for automation with a research checkpoint; did not replay gathering. | Passed. |
| Grounded semantic closure | Returned no operations and an evidence-grounded semantic completion for the exact canonical step ID. | Passed. |

The live runner exited 1: **2/4 passed**, with two action-selection failures retained unchanged. These results do not justify calling Luna's autonomous controller repaired end to end. The new-plan prompt explicitly stated that proposals would not execute, and the unmet-research fixture lacked further recipe/prerequisite observations; both are limitations of this planning-only experiment. A future test should distinguish a valid grounded pause from an avoidable action omission using sufficient authoritative facts, without relaxing tracker or admission checks.

## Evidence and attribution

Ignored evidence directory: `test-results/luna-system-fixes-2026-10-06/luna-planning-tailnet-live/`. Each case records the sanitized actual wire request, raw assistant response, validation outcome and elapsed time. `summary.json` records limits and call counts. Separate logs are `cli-proxy-tailnet-health.log`, `cli-proxy-tailnet-models-health.log` and `luna-planning-tailnet-live.log`.

Luna authored all four live decisions. The operator supplied the fixed test cases, inspected health and validated responses; the fixture harness seeded tracker state and closed the already-satisfied inventory checkpoint. No real research, crafting or inventory progress occurred. Scripted samples remain separate from model evidence; the diagnostic guard change does not change the saved live replies or turn either failed case into a pass.

After the diagnostic change, all four scripted samples passed again without network access. The official Docker gate also passed again: 1,805 runtime tests, 1,036 mod tests, typechecks, TSTL build and generated-Lua checks. Logs: `luna-planning-tailnet-offline.log` and `luna-planning-followup-all.log`. Weekly account usage was 38% at this checkpoint.
