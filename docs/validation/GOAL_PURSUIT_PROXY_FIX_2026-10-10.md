# Pursuit CLI-proxy request fix — October 10, 2026

The owner requested correction of the Luna provider timeout. The new pursuit protocol skipped the established local GPT closed-tool contract: unlike legacy closed rounds, it omitted `tool_choice: none`. Historical recorded CLI-proxy replay evidence demonstrated unsolicited generated images when tool choice was omitted. The original October 10 oversized body was not retained, and the later 120-second timeout did not identify its transport stage, so those exact failures cannot retrospectively be attributed to image generation.

## Change

Local GPT pursuit requests now explicitly send `tool_choice: none`. They continue to use bounded JSON decisions and do not expose legacy planner/function schemas. Other model families and the legacy request shape retain their existing behavior. No timeout or response-size limit was raised and no retry was added.

A correlated `provider.pursuit_wire_contract` event records the restriction and actual pursuit decision fields. Pursuit no longer emits incorrect legacy completion-field metadata. Future timeout records identify waiting for headers versus reading/parsing a body, bytes received, HTTP status when available and bounded content-type metadata. Partial response bodies and credentials are not logged. The diagnostic byte counter includes partial HTTP error bodies.

Five deterministic regressions cover the local GPT pursuit restriction, non-GPT compatibility, timeouts before headers, partial HTTP 200 bodies and partial HTTP 503 error bodies. Existing provider response-size, cancellation, actor/admission and cumulative-budget regressions remain intact. A separate bounded read-only reviewer found no merge blocker in the fix or the partial-error-body follow-up.

## Live transport verification

Exactly one diagnostic inference request began at 2026-10-10 16:28:33.016 UTC (12:28:33.016 Toronto). It replayed the failed E2E request's exact messages, through the same CLI proxy with `gpt-6-luna`, a 120-second deadline and 4,000 requested output-token cap. It used the corrected source mounted read-only into an isolated short-lived Docker container. This was a transport diagnostic, not a full deployed gameplay trial. Credentials were consumed opaquely by Compose. There was no gameplay dispatcher, provider retry or corrective gameplay prompt.

The request returned in **3,525 ms** with a **650-byte** response, valid JSON content and finish reason `stop`. Reported usage: 6,484 input tokens (5,888 cached; 596 uncached), 72 output tokens (including 43 reasoning tokens), 6,556 total. No image or wire tool call was returned.

Luna's decision was `{"pauseReason":"I can’t take any in-game actions this turn, so the objective remains in progress."}`. This establishes that the corrected request completes and parses through the actual proxy. It does not establish autonomous gameplay progress or prove the historical timeout's upstream cause. The green-science goal remains unmet.

Full diagnostic evidence is retained in `test-results/luna-pursuit-proxy-fix-20261010/`: `probe-started.json`, `probe-result.json`, `probe-prompts.jsonl`, `probe.log`, `static-all.log` and `static-final.log`. First Docker all gate passed 2,107 runtime tests and 1,046 mod tests with typechecks/Lua guards. Final gate, source commit, installer pin and full-image verification are recorded below as they complete.

Final source Docker all gate passed: **2,108 runtime tests**, **1,046 mod tests in 120 files**, typechecks, Lua compilation and generated-Lua checks. Both gate processes exited 0. The reviewer also approved the follow-up error-body diagnostics.
