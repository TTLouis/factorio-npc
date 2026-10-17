# Run X offline recovery fixes

Owner request: fix partial-transfer recovery, completion-contract rejection and
the missing stop trace; add full-loop static/native regressions and integrate
into `experiment/jev-agent-architecture`. No live provider run is authorized here.
Source: `de1b92c97dcf8d7cfb4188d72ff7a7d60d0cbe59`.

## Design and authority

Run X's four-task native receipt records three completed transfers and one
`nothing_moved:target_rejects_item` refusal. Cancellation alone remains uncertain.
The native order is ore withdrawal, plate withdrawal, copper insertion refusal,
then coal insertion: the three successes are not all a contiguous prefix.
A new narrow exact proof requires current actor/epoch and generation, the complete
admission signature/ordinal/slot identities, idle native queues, and fully
accounted transfer-only receipts. It archives `admitted_partial/partial_known`,
never whole-batch success or absence. Native admission records become terminal
`partial` so they do not pin unresolved capacity. Missing or malformed witnesses
keep the original uncertainty and scope guard. A closed-partial signature guard
refuses replay of the original batch for the same immutable step.

The existing persistent two-attempt transfer allowance covers the same-step
repair. The executor observes current counts and chooses the missing effects;
neither completed work nor the requested outcome is replaced. Its root checkpoint
cannot lower the committed fifteen-copper checkpoint. A structurally blocked
executor continuation reaches canonical blocked admission rather than being
misread as a new draft missing completion declarations. Planner replacement
drafts retain their original declaration validation.

The stop trace now uses canonical run pause truth, including an operator pause
while the plan projection remains BLOCKED. It preserves the blocker and uncertain
operations. Strict paired trace proof remains unchanged.

## Build checklist

- [x] Causal source fixes and named diagnostic events.
- [x] Full Session/provider static repair and blocked-continuation regressions.
- [x] Native admission positive and malformed-proof unit coverage.
- [x] Separate source review; fresh-actor fallback finding fixed and covered.
- [x] Frozen source, payload repin and full canonical gates.
- [x] Native reserved-iron furnace repair and unknown-proof control.
- [x] Original-source failure controls and native regression canaries.
- [x] Final review, integration and merged canonical gate.

All tests use scripted providers, Docker and isolated local Factorio. Historical
Run X evidence and its checkpoint remain unchanged; the broader live goal stays
paused. Final results and immutable source/evidence mapping will be added here.

## Static and build evidence

Production source is `2865d1b47eab22ccd71c6d243f3ef3c0de90f68e`.
Installer source pin commit `be270286f4c6d1f208e15d7eb538fff4337afb5e`
contains the payload pinned to that production source; generated payload SHA256
is `a4553af87969f67ace02763099d7b8760b13dc8b199dde884b5e7a0e1df41f27`.
Later static-test edits improve causal controls and lint without production changes.

Task canonical gate: **2,536 runtime/staging and 1,181 mod tests PASS**,
typecheck, Lua build and generated-Lua checks PASS. Repository lint and all nine
installer payload tests PASS. Targeted final Run X static suite: sixteen PASS.
Original `de1b92c9` runtime fails both positive-loop and blocked-continuation
controls on `missing_step_completions`; the stop-trace original-source control
fails all three new cases. Native admission focused suite: 53 PASS.

Ignored evidence is retained under this task's `test-results/`:
`run-x-task-all-final.log`, `run-x-runtime-final.log`,
`run-x-original-static-control-final.log`, `run-x-lint-payload-verified.log`,
`run-x-native-admission-focused.log` and `run-x-stop-trace/`.

The first official Factorio image build passed at production source 2865d1b4:
`sha256:ffee7fab1964ada41be0147a929b4ef3dc4a3f07ded25af2d2f40b221110a55a`.
Its first native execution independently reproduced the reserved iron craft,
three successful transfers, one copper rejection and exact partial reconciliation.
A fixture callback incorrectly assumed a full entity observation instead of
merging its legitimate diff; that initial failure and save are retained.
This initial execution is not counted as a passing full-loop gate.

Further fixture checks preserve exact item/unit/count/direction replay assertions
and verify the full baseline in the actual serialized conversation before applying
a fresh entity diff. The harness legitimately carries that baseline in a
`[ENTITY_STATUS_BASELINE]` user context block after continuation removes old tool
messages. A tool-only fixture lookup incorrectly reported it missing; source
review confirmed the existing delivery path and the final assertion accepts only
the exact delivered block or full tool snapshot. No baseline runtime change was
made, and failed fixture attempts are retained separately from final passing gates.

## Final new native lane

Final fixture `273520b262f44d24e1dc470127b27d50438f12ae`, mounted read-only
over the official 0903aa92 image, passes both pristine-world modes. The image is
`sha256:2652b1767b33f4d9289a1ed30e49c2f0be555ca206d8c619001c83e423fc522d`.
All runtime and mod production paths are unchanged from 2865d1b4; only installer
pins, documentation and test assertions differ.

- Recovery: real reserved iron craft, four native transfer tasks / three completed
  / one refused, exact `partial_known` settlement, visible delivered baseline plus
  fresh diff, unchanged fifteen-copper contract, five new native copper plates and
  fifteen held, original withdrawals admitted only once.
- Missing-proof control: removing `completed_count` from ordinary status receipts
  retains `partial_unknown` and its duplicate guard. The original BLOCKED plan
  rejects the raw operation-only continuation through canonical authority, with
  no completion-declaration failure. Two actual chat stops each emit fresh cancel
  and same-goal operator-pause traces without more model calls or auto resumes.
- Original runtime/native image, same final fixture: expected exit 1 with
  `missing_step_completions` after the actual physical partial transfer. The
  delivered-baseline assertion passes before this causal failure.

Both final modes record zero external fetches and zero connected humans. Owned
containers are removed after logs, saves and receipts are exported. Evidence is
under `test-results/run-x-native/candidate-273520b2-new-*` and
`original-273520b2-new-*`. The historical Run X checkpoint remains 598,298 bytes
with SHA256 `91758e3c46967b58d8e73c742c29cf33b241ed48e97a5db969e235971e922556`.

## Full native checkpoint

All **24 native lanes and 92 unique Python checks PASS**. The existing 23 lanes
run the official 0903aa92 image unchanged; the new lane and original-source control
use the exact final committed fixture overlay described above. Both official
image builds passed. Nineteen owned container scopes, including earlier fixture
attempts and controls, have preserved evidence and confirmed removal; no native
networks or volumes were created. A scheduling mistake briefly overlapped five
lanes before the four-lane bound was restored; results and actual timing are
preserved, and no failure was concealed or retried as a production fix.

The sealed native manifest contains **1,529 entries**, SHA256
`1b0b5eb51b8b83b67e4fe95f134d3b4aec2f3895ceb10ab3b4860cd1aef8001b`.
The parent independently verified every bounded unique path, length and digest,
all 24 expected lane names, Python count and all 19 cleanup receipts. See
`test-results/run-x-native/final-native-summary.json`, its `evidence-manifest.json`
and `test-results/run-x-parent-native-verification.json`. Validated images, saves
and logs remain available; no owned Factorio or provider process remains running.

The complete task evidence index, including static checks, original controls,
source exports and the sealed native manifest, contains **3,434 entries**:
`test-results/run-x-offline-final-manifest.json`, SHA256
`83e559c87b41848adfdac3c727da7b7f34eb55ddf49d5abfc57c9e64dd0253e8`.

## Integration

Separate source and final evidence reviews approved clean task `5a2c3458`.
Both sealed manifests were independently verified again: all 3,434 task entries
and 1,529 native entries have unique bounded paths, matching sizes and digests.
The exact 19 owned native container IDs are absent.

Reviewed no-ff merge `a0a379fad374f766751c5a3cbe2aae7cbba8c205` lands the task
in the Jev integration checkout. Its source matches the reviewed task exactly.
The merged canonical gate passes **2,536 runtime/staging and 1,181 mod tests**,
typecheck, Lua generation and generated-Lua validation (exit 0). The immutable
payload was already repinned on the task branch and remains byte-identical to its
validated source. Merged gate evidence is retained in the integration checkout's
`test-results/run-x-merged-all.log` and `run-x-merged-all-exit.txt`.

Publication target is `experiment/jev-agent-architecture`, following the normal
green-merge push procedure. This checkpoint proves offline recovery mechanics;
it does not prove autonomous red throughput or resume the paused E2E goal.
