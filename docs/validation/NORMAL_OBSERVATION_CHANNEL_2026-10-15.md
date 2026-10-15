# Normal observation channel — 2026-10-15

Status: frozen static/native checks and independent review pass; local integration gate pending; no live trial yet.
Source: `08e35a6a52c12434141ba43e442ad745067ad689` on `fix/normal-observation-channel`.

Frozen reviewed candidate: `339c0cc6601345d078c00e67f1f14346a2930468`. Final official native image: `sha256:547814b73f728ceec186daacec9a2ae31d5de2682b5284e2261bfc9911314c8b`.

## Problem and resulting behavior

Run T made native bootstrap progress but exhausted its existing six goal resumes during the lab prerequisite slice. One malformed reply was repaired; it was not the terminal cause. The actual final wire retained valid observation baselines and action permissions. Luna also repeatedly omitted actions, chose redundant facts and claimed unsupported blockers.

A separate harness phase error made one of those choices unnecessarily costly: Luna submitted a typed `getResearchStatus` request while ordinary observation tools were open. The closed-decision handler consumed the persistent one-fact allowance, evicted the ordinary cached result and recursively continued with tools closed. Its advertised eligibility also ignored whether ordinary tools were open.

The change translates a validated open-phase typed request into the same ordinary read-only tool call the model requested. The existing turn or recovery loop applies cache, budget, duplicate suppression and actor fences. It neither spends the closed ledger nor forces closure. Exact plan/step identity, no-edit and grounded-target validation remain required. Closed decisions retain the existing one-fact allowance and all existing bounds. The control state advertises that exception only while ordinary tools are closed; guidance directs open decisions to ordinary tools.

This fixes the channel mismatch. It does not establish that Luna will stop making redundant requests or that Run T would have completed.

## Verification gates

- [x] Canonical Docker runtime/mod/typecheck/Lua gates: 2,452 runtime and 1,144 mod tests, typecheck and generated Lua; actual exit 0.
- [x] Twenty-one static full-loop and focused regressions pass, including repeated Jev observation requests across C6, with ordinary cache/budget and actor/epoch/cancellation fences. The recorded fixture explicitly labels its reconstructed typed reply.
- [x] Final 21-case original-runtime control: 14 behavior failures and seven captured-evidence/strict-negative passes; actual exit 1 as expected, with no import failures.
- [x] Final official real-engine full loop passes, actual exit 0: model clears 52 iron output, collects five NEW copper plates, natively crafts a lab and unlocks red science. Three admitted batches, nine serialized provider calls (two Sol/seven Luna), same actor/plan/checkpoint, unchanged six prior resumes, zero humans, speed 1 and fully idle operation/crafting/movement/mining/follow state.
- [x] All thirteen existing native canaries pass individually, including the changed closed-action and three-mode local-transfer fixtures. All 31 compiled mod files and production runtime are unchanged from that canary image to the final image. The initial fourteen-lane aggregate failed only the subsequently corrected new fixture; it is not reported as an all-fourteen aggregate pass.
- [x] Separate read-only reviewer APPROVED frozen `339c0cc6`, including final engine proof, original-code controls, hash manifests and official-image byte checks.
- [ ] Local no-ff integration and merged canonical gate.

The original two runtime modules overlaid on the same final official image fail at the intended behavior boundary: the open typed research request consumes the targeted ledger and continues with tools closed. Both runtime modules and the final runner were independently verified against their exact official-image bytes. The evidence manifest, final proof and original failure are retained locally.

Initial native fixture failures are preserved. Corrections use the actual prototype trigger shape (`item: {name: "lab"}`), an exact unit scan on the actor surface/force, native input reservation (four visible ores plus one pending copper craft from five inserted), and the mandatory planner grounding confirmation. Final assertions still require five new copper, native ingredient costs, immutable checkpoint and idle state; the positive native progress assertion is stronger. No production shortcut or post-setup correction was added.

The engine fixture declares the captured bootstrap supplies, furnace state and already-completed steam-power/electronics prerequisites. Fixture setup is test evidence for the recovery path, not proof of a naturally built factory. Only the eventual fresh live trial can prove the complete goal.

Existing Q static/native fixtures and the local-transfer native fixture now use real observations or actual omission repair to reach a closed decision. Their closed-action, production, immutable-plan and cancellation assertions remain. Run E expects ordinary admission for its open typed resource read. The context golden changes provider guidance/control hashes; request contexts, event order and counts are unchanged. Logs are retained under `test-results/normal-observation/` and `test-results/normal-observation-static/`.

## Run U observer preparation

The independently reviewed ignored observer helper also fixes Run T's retained `paused_at` timestamp case. It requires fresh isolated cancellation and ordered same-goal operator-pause traces, durable operator pause, cleared intake retry and a matching idle native actor before result/save. Twenty-six network-disabled Docker tests include the actual T failure, original-helper rejection, production pause/stop behavior and negative controls. Measurement, starter and all run limits are unchanged. Prepared helper hashes: run-live `752df15fb5776f21250786f9dd0ab99eecf5c4ed1064fbdb05ab724e101619f3`; terminal `a2b516581f19894485920c5d9fc81ab512973b7eb338b6021fc9edea1e9b84de`.

No push, release, deployment or live run was performed for this task checkpoint. The complete unattended factory and throughput goal remain unproven.
