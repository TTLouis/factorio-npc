# Dedicated CLI-proxy profile and offline preflight

The Run U configuration gap is repaired locally. `AI_API_METHOD=cli-proxy`
selects its own capability profile rather than LM Studio's `local` profile.
The E2E goal remains **paused**; no live trial, provider inference, push or
deployment was performed for this change.

## Contract

- Hosting and transport are independent of the profile. Ordinary HTTPS proxy
  endpoints work; existing local or Tailscale HTTP transports are optional and
  retain the existing URL safety rules.
- `OPENAI_API_BASEURL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` retain their names
  and selection semantics. Existing `.env` contents were neither read nor changed.
- Verified GPT-6 planner/executor calls retain function schemas and explicitly
  set `tool_choice: "none"` on closed decisions. Existing flat reasoning control
  uses low/medium/high, with max clamped to high. Other upstream families remain
  conservative pending validation; the GPT trial preflight rejects them.
- CLI proxy has no LM Studio 64K context floor or no-cache pricing assumption.
  Reported cached usage remains available. Legacy local/direct/router/auto
  behavior, the 256KiB response guard, and call/recovery/output limits remain.
- Selection is explicit. Endpoint/model names and saved mirror fields cannot
  infer the method. The offline preflight rejects legacy `local`, unset,
  direct/router and inconsistent role contracts before readiness.

The production preflight exercises both actual role serializers using an owned
in-memory transport. Its proof contains the correlated
`provider.cli_proxy_contract_verified` event, reason, models, capabilities and
closed bodies, with zero external inference calls. Closed decisions also emit
`provider.closed_tool_contract` with reason
`cli_proxy_openai_explicit_tool_choice_none`.

## Local evidence

- Reviewed implementation `1f0efe63`; final reviewed task `3b2cc106` includes
  separate installer repin `d3a6290c` and comment cleanup. Independent review
  found no merge blockers. Local no-ff integration: `506e1b10`.
- Merged canonical Docker gate: **2,465 runtime tests, 1,144 mod tests,
  typecheck, Lua build and generated-Lua checks pass**.
- Installer generator/check and all **9 payload tests pass**. The payload source
  checksum is unchanged; its immutable ref now points to `1f0efe63`.
- Official real-Factorio `normal-observation` lane passes with network disabled.
  Runtime snapshot matches frozen `1f0efe63` after CR normalization. Image:
  `sha256:f1305cc0a7771cedf31ef57672db898decfd021cc349c0cde2ef6b3bc595e862`.
  Both role preflights pass before RCON/world work; the missing-method negative
  control rejects with no inference. Native recovery preserves nine scripted
  gameplay calls (two Sol/seven Luna), three admissions, six prior resumes,
  immutable plan/step/checkpoint, zero humans and idle queues. It clears furnace
  output, produces five new copper plates, crafts a lab and unlocks red science.
- Paused trial preparation now selects `cli-proxy`; all **31 offline helper
  tests** and runner/verifier syntax checks pass. It still references Run U's
  deployment candidate and must be refrozen before any future readiness/live
  release. Its prior measurement, stop fence and starter limits are preserved.

Ignored evidence is retained in the task checkout under
`test-results/cli-proxy-profile/` (canonical/payload/helper logs, official build
log and native lane proofs), and in the integration checkout under
`test-results/cli-proxy-profile/merged-all.log`. Historical Run U evidence and
its unavailable failed response body remain unchanged. No attachment/content
claim is made about that rejected body.

These results prove the profile and scripted recovery path. A fresh provider
trial and the complete unattended natural-resource factory/throughput remain
unproven and paused.
