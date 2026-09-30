# SGLuna runtime observability

This document describes the public, structured diagnostics used to debug the standalone Factorio NPC runtime. It intentionally excludes hidden chain-of-thought, credentials, authorization headers, API keys, and other secrets.

## Sources

The runtime writes two rotating JSONL traces under `logs/` by default:

- `airi-behavior.jsonl` — request/actor/provider/tool/plan/runtime event timeline.
- `airi-prompts.jsonl` — final provider request payload metadata plus provider response diagnostics.

Both writers sanitize common credentials before writing. Provider reasoning text is not persisted; only bounded metadata such as `reasoning_content_chars` is recorded.

The in-game SGLuna Debug window is a bounded projection of the current/latest live diagnostics. It is not the canonical trace store.

## Correlation

Use `request_id` as the primary correlation key across the two JSONL files. Behavior events also carry `turn`, `actor_id`, `epoch`, and an ordered `seq`. Provider events additionally carry `round` and `recovery_attempt`.

A normal investigation should follow:

`request.received -> actor.bound -> provider.request -> provider.response -> tool.call/result -> plan.accepted -> operations -> request.completed`

A structured-output failure normally follows:

`provider.response -> replan.started -> provider.request/response ... -> request.failed`

`request.failed.data.failure_snapshot` freezes the final provider event, recovery state, last tool, plan position, actor identity when available, and accumulated usage so the failure remains diagnosable after the active request unwinds.

## Provider diagnostics

`provider.response` metadata may include:

- `response_id`, `model`, `finish_reason`, `diagnostic_code`
- `response_bytes`
- `content_chars`, `content_utf8_bytes`
- `content_non_ascii_chars`, `content_replacement_chars`
- `normalized_content_chars`
- `reasoning_content_chars` (length only; no reasoning text)
- `tool_call_count`
- `structured_content.json_valid`
- `structured_content.plan_valid`
- `structured_content.error`
- token/cache usage
- a bounded, sanitized final content preview in the prompt trace

Important diagnostic codes include:

- `provider_output_budget_exhausted`
- `provider_output_truncated`
- `provider_empty_content`
- `provider_content_invalid_json`
- `provider_content_schema_invalid`
- `provider_body_invalid_json`
- `provider_missing_response_body`
- `provider_missing_assistant_message`
- `provider_response_too_large`
- `provider_http_error`
- `provider_timeout`
- `provider_cancelled`

Do not collapse these back into a single `Invalid provider content JSON` message in diagnostics. The player-facing NPC may use a natural fallback, but the debug path should preserve the actual failure class.

## Latest failure report

`runtime-v8/debug-report.mjs` correlates the latest `request.failed` event with provider and prompt traces without printing prompt payloads or hidden reasoning text.

From the installed runtime/repository root:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs
```

For machine-readable output:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs --json
```

Explicit JSONL paths may be passed as the first and second positional arguments:

```sh
node deploy/pterodactyl/runtime-v8/debug-report.mjs /path/to/airi-behavior.jsonl /path/to/airi-prompts.jsonl
```

The report includes the final failure, actor/epoch, provider round/recovery attempt, finish reason, diagnostic code, content/UTF-8/reasoning sizes, structured JSON/schema status, last tool, usage, prompt-size metadata, a short correlated event timeline, and bounded diagnosis hints.

## Interpreting the original empty-content failure

If a report shows all of the following:

- `finish_reason=length`
- `content_chars=0`
- `tool_call_count=0`
- large `reasoning_content_chars`

then the evidence points to the provider exhausting output budget before emitting visible structured content. Chinese text itself is not invalid JSON. Treat language as a possible verbosity/budget amplifier only if controlled A/B runs support that conclusion.

If `content_replacement_chars > 0`, investigate UTF-8 decoding or byte-based slicing. If content is non-empty with `structured_content.json_valid=false`, inspect the bounded final content preview for malformed/truncated JSON. If JSON is valid but `plan_valid=false`, investigate the SGLuna structured-response schema instead.

## Current implementation checkpoint

This section is intentionally narrow: it tracks observability only. NPC behavior policy, spatial behavior, and skill design are owned by their topic-specific documents/workstreams and should not be folded into this checklist.

At the latest inspected `experiment/jev-agent-architecture` state, the following observability pieces are already durable:

- provider request/response tracing with bounded content-shape, UTF-8, reasoning-length, tool-call, structured-JSON/schema, usage, and transport-error diagnostics;
- correlated behavior tracing with request/turn/actor/provider/tool/plan/runtime events;
- a frozen `request.failed.data.failure_snapshot` containing final provider diagnostics, recovery state, last tool, plan position, actor/epoch when available, and accumulated usage;
- `runtime-v8/debug-report.mjs` plus regressions that correlate behavior and prompt traces, tolerate malformed JSONL rows, and distinguish UTF-8 replacement evidence from structured JSON failure;
- in-game Debug UI projection for request/turn/provider/latency/tokens, provider capability/output-cap integrity, provider diagnostic code, finish reason, response identity/size/tool-call count, bounded content-shape metrics, structured JSON/plan validity and bounded structured error text, content/reasoning sizes, last tool/event, recovery, actor, world task, follow state, UI sync, and last error.

### Unfinished observability work

1. **Real-provider reproduction is still required before closing the original incident.** Unit/regression coverage proves that truncation, empty visible content, reasoning-only output, UTF-8 replacement evidence, JSON failure, schema failure, and output-cap enforcement anomalies are distinguishable. It does not prove which one the production provider returns for the original Chinese request. Reproduce one real failing/successful request and capture the correlated debug report before changing provider budgets or language behavior.

The former `obs/debug-ui-second-layer` isolation branch is no longer present and is not an implementation authority. The production second-layer projection is maintained directly with the current Jev branch observability code and its regression tests.

### Current validation caveat

Do not describe the shared branch as globally green merely because the observability regressions pass. Re-check the latest HEAD and the branch's current CI/workflow state before promotion because this branch is highly concurrent and unrelated work may move independently.

## Regression contract

Observability changes should preserve these properties:

1. A failed request can be diagnosed from the Debug UI plus the two JSONL traces without hidden reasoning.
2. Failure context survives request unwind and ordinary UI heartbeat refreshes.
3. Provider transport JSON errors are distinguishable from model structured-content errors.
4. Truncation, empty content, UTF-8 replacement evidence, JSON parse failure, and plan-schema failure remain distinguishable.
5. Logging failures never turn an otherwise valid provider request into a runtime failure.
6. Secrets are sanitized and reasoning text is never written to the trace.

Relevant regression tests include:

- `runtime-v8/behavior-trace.test.mjs`
- `runtime-v8/prompt-trace.test.mjs`
- `runtime-v8/debug-ui-bridge.test.mjs`
- `runtime-v8/debug-report.test.mjs`
