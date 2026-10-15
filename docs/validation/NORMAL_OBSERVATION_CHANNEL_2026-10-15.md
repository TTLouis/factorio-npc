# Normal observation channel — 2026-10-15

Status: static gates pass; frozen real-engine verification and final review pending; no live trial yet.
Source: `08e35a6a52c12434141ba43e442ad745067ad689` on `fix/normal-observation-channel`.

## Problem and resulting behavior

Run T made native bootstrap progress but exhausted its existing six goal resumes during the lab prerequisite slice. One malformed reply was repaired; it was not the terminal cause. The actual final wire retained valid observation baselines and action permissions. Luna also repeatedly omitted actions, chose redundant facts and claimed unsupported blockers.

A separate harness phase error made one of those choices unnecessarily costly: Luna submitted a typed `getResearchStatus` request while ordinary observation tools were open. The closed-decision handler consumed the persistent one-fact allowance, evicted the ordinary cached result and recursively continued with tools closed. Its advertised eligibility also ignored whether ordinary tools were open.

The change translates a validated open-phase typed request into the same ordinary read-only tool call the model requested. The existing turn or recovery loop applies cache, budget, duplicate suppression and actor fences. It neither spends the closed ledger nor forces closure. Exact plan/step identity, no-edit and grounded-target validation remain required. Closed decisions retain the existing one-fact allowance and all existing bounds. The control state advertises that exception only while ordinary tools are closed; guidance directs open decisions to ordinary tools.

This fixes the channel mismatch. It does not establish that Luna will stop making redundant requests or that Run T would have completed.

## Verification gates

- [x] Canonical Docker runtime/mod/typecheck/Lua gates: 2,452 runtime and 1,144 mod tests, typecheck and generated Lua; actual exit 0.
- [x] Twenty-one static full-loop and focused regressions pass, including repeated Jev observation requests across C6, with ordinary cache/budget and actor/epoch/cancellation fences. The recorded fixture explicitly labels its reconstructed typed reply.
- [x] Final 21-case original-runtime control: 14 behavior failures and seven captured-evidence/strict-negative passes; actual exit 1 as expected, with no import failures.
- [ ] Real-engine full loop: actual native furnace output obstruction, model-selected extraction, new copper production, native lab crafting and red-science trigger.
- [ ] Relevant existing native canaries.
- [ ] Independent frozen-candidate review.
- [ ] Local no-ff integration and merged canonical gate.

The engine fixture declares the captured bootstrap supplies, furnace state and already-completed steam-power/electronics prerequisites. Fixture setup is test evidence for the recovery path, not proof of a naturally built factory. Only the eventual fresh live trial can prove the complete goal.

Existing Q static/native fixtures and the local-transfer native fixture now use real observations or actual omission repair to reach a closed decision. Their closed-action, production, immutable-plan and cancellation assertions remain. Run E expects ordinary admission for its open typed resource read. The context golden changes provider guidance/control hashes; request contexts, event order and counts are unchanged. Logs are retained under `test-results/normal-observation/` and `test-results/normal-observation-static/`.

## Run U observer preparation

The independently reviewed ignored observer helper also fixes Run T's retained `paused_at` timestamp case. It requires fresh isolated cancellation and ordered same-goal operator-pause traces, durable operator pause, cleared intake retry and a matching idle native actor before result/save. Twenty-six network-disabled Docker tests include the actual T failure, original-helper rejection, production pause/stop behavior and negative controls. Measurement, starter and all run limits are unchanged. Prepared helper hashes: run-live `752df15fb5776f21250786f9dd0ab99eecf5c4ed1064fbdb05ab724e101619f3`; terminal `a2b516581f19894485920c5d9fc81ab512973b7eb338b6021fc9edea1e9b84de`.

No push, release, deployment or live run was performed for this task checkpoint. The complete unattended factory and throughput goal remain unproven.
