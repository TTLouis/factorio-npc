# Run X — minimum-prompt delegated red-science trial

One owner-authorized CLI-proxy trial used frozen pushed source
`ffc0a04669649a898734c015ee2a46d7245b080a`. It stopped at a canonical structural
blocker after **14.22 wall minutes**, before the 60-minute construction cap.
The unattended measurement never started: **red output was zero**, with no
power or automated mining/science chain placed. The broader goal remains paused.

## Objective, limits and release

The only gameplay objective was:

> !luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.

The owner explicitly approved a **30% weekly-remaining floor for this trial**.
Initial usage was 33% remaining, live-start usage 32%, and the final supervisor
reading 31%; the floor did not cause the stop. Construction stayed at speed 1.
All existing provider, read, output, admission and recovery limits remained.
The original starter was granted once; no corrective gameplay, additional
prompts, manual resumes, provider retries or second trial were performed.

Measurement rules stayed outside the minimum prompt: canonical completion and
parent-reviewed native topology; empty native task/crafting queues; paused AI
mutations; enemies removed and expansion disabled; five wall minutes at 2x,
at least ten game minutes and ten NEW red packs at >=1 per game minute, with
verified physical ore/item/fuel paths, upstream production and real steam power.
None of these measurement gates was reached.

The parent built the source using `scripts/build-docker-local.ps1 -NoEnvUpdate`,
with process-only Factorio 2.0.77. Actual image ID:
`sha256:6cbdfee74135f27c0a280a812d5545589b71fc4400c5d5d470352534cfc281af`.
Parent and independent review verified 51 shipped modules, packaged prompt,
release manifest, 31 compiled mod files and both actual role serializers.
Text hashes strip CR consistently; binary files compare exact bytes. Forty
offline helper checks, ten JavaScript syntax checks and six PowerShell parse
checks passed before launch.

Preflight caught and preserved three setup failures before any inference:
raw-versus-normalized native manifest hashes; inherited Qwen role selection;
and multiple unused run workspaces after a model-only restart. The expected
manifest was regenerated from the sealed native fixture, the same prior-run
Sol/Luna process override restored, and unused startup data archived before
the final empty world. No `.env`, API URL or API key changes were made.
The existing configured loopback proxy route was independently probed and its
strict-host-key SSH forwarder restored only after connection refusal was proved.
CLI-proxy remains an upstream inference profile independent of that transport.

Final preflight packet SHA256:
`c8c3e5f4974108e5bef643db1fb99d250f45c8ee6823abfee6dc6f8ab8db91c7`.
It proves empty inventory/board/goal/queues, no starter, zero humans and zero
provider/Jev calls; actual Sol/Luna CLI-proxy closed wire retains 40 tools and
`tool_choice:none`; the read-only model catalog returned 401/200 and both models.

## Live delegation and progress

Actor **25**, seed **2989469963**, goal `goal_05q1qx6_1`, started at
`2026-10-17T10:25:15.016Z`. The subagent owned observation, usage checks,
classification, stopping and safe archival; the parent owned release verification,
consequential review and the trial-owned forwarder. No human connected.

- Actual replies: **8 Sol 6.1 planner / 47 Luna executor**, **55/55 total**,
  zero provider transport errors; Jev **50/50**, zero fallbacks.
- The minimum objective became a long-horizon production-rate goal with
  `automation-science-pack`, `per_minute:1`, `window_minutes:1`.
- **27** fresh topology refresh events are retained. A parent wire audit
  confirms fresh scoped context reaches both real model roles. The first
  audited segment has 27 prefixed records across 31 requests, maximum 825
  characters, actor 25. JIT/typed packets use their own representation; this
  count is not a claim that every call contains that text prefix.
- Final native production is **60 new iron / ten copper plates**; mining is
  67 iron ore, 20 copper ore and ten coal. Ten real hand-crafted gears are held.
  Only furnace 49 is placed; the starter drill remains held. There is no pump,
  boiler, engine, lab, automatic ore/fuel route or red assembler.

This run validates live delivery of the new context but ends before steam
placement. It does not establish autonomous shoreline recovery or throughput.

## Confirmed terminal boundary

The step was **Gather and smelt 5 additional copper ore to hold 15 copper
plates**, active plan `goal_05q1qx6_1_p4`. Native batch 20 started four transfer
tasks: **three completed, one refused**, with
`moving_items:nothing_moved:target_rejects_item` for copper ore at furnace 49.
The journal retains partial-effect uncertainty; no whole-batch replay was made.

Fresh post-stop native evidence agrees with the final normalized tool response:
furnace input empty, four coal in its fuel inventory and one iron plate still
in output. The
earlier snapshot with seven iron ore/seventeen output plates was before batch
20, so comparing those snapshots does not demonstrate stale tool observation.
An in-progress iron product finishing during clearing/refueling is a plausible
recipe-switch race; an offline causal replay is still required.

At `10:39:15.064Z`, the final executor reply proposed clearing the residual plate
and loading copper but failed the `missing_step_completions` contract. At
`10:39:28.469Z`, the external shared classifier independently refreshed native,
trace and canonical state twice and confirmed active plan `BLOCKED`, structural
`transfer_failed:nothing_moved:target_rejects_item`, `requires_user_decision:true`.
This canonical decision is the terminal authority. The runner later labeled its
intended result `request_failed`; that coarser label is not substituted for the
canonical evidence.

The next regression scope is the real furnace recipe transition with a completed
transfer prefix, safe partial-effect recovery and the following completion
contract. It must preserve existing effects and limits rather than replaying
the completed batch or resetting recovery credit. The missing `goal.paused`
trace and the strict stop-confirmation failure also require offline regression
coverage; the archival workaround below does not fix that production boundary.

## Stop, save and cleanup evidence

The strict runner exited with `stop_confirmation_timeout` and its original
`e2e-incomplete.json` is preserved. Same-goal operator pause and native idle are
durable, with fresh cancellation receipts, but **no `goal.paused` trace event**
was emitted. The original paired-trace gate therefore **did not pass**.

Parent-authorized safe archival used the existing default durable-pause proof
bound to the actual first external stop: observed time `1792233568469`, fresh
cancel `1792233568475`, canonical operator pause `1792233568476`. Current actor,
goal, empty native queues, cleared intake and unchanged 55 provider calls were
verified; pending `partial_unknown` effects remain intact. This archival
exception does not establish measurement success or fabricate a missing event.

Fresh checkpoint: **598,298 bytes**, SHA256
`91758e3c46967b58d8e73c742c29cf33b241ed48e97a5db969e235971e922556`.
It is the named `red-automation-x-checkpoint.zip` written after stop confirmation,
with native save-completion evidence. The old archive guard assumed two split
level chunks; this smaller save has one. Independent offline validation passed
full CRC/decompression for all 55 unique entries, a safe common root, metadata
and contiguous nonempty chunk `[0]`. Factorio 2.0.77 loaded a pristine copy,
performed one benchmark update and exited 0 with matching five enabled mods
and 31 compiled mod files. Original hash, size and modification time did not
change; the network-disabled disposable validation container was removed.

Native-load proof SHA256:
`ac800e89b58151b297e6db694a34fe019a8c6407a45796ecfd529f00d3335af9`.
The parent independently verified all 52 files in its manifest, SHA256
`793e9c5b42ddf33f27f5422dfdf1d5be51ca01870b10c5ed111c652100fee7cb`.
Archive-helper corrections and final teardown are recorded below.

All local evidence remains under the integration checkout's
`test-results/red-automation-live-2026-10-17x/`, with parent release receipts in
`test-results/run-x-*.json`. No production code changed during the run.
## Final archival verification and teardown

The local archive helper now accepts a nonempty contiguous split-chunk sequence
starting at zero with `level.datmetadata`, while retaining same-root entries,
duplicate refusal, required script/info and full CRC checks. Ten meaningful
regression groups pass for one/multiple chunks, missing metadata, gaps, absent
chunk zero, metadata without chunks, duplicates, legacy compatibility and
empty-required-file/unsafe-path subcases. Required native files must be
nonempty and member path components must stay within the common root. The final
PowerShell verifier parses successfully. All original 27 preflight helpers are
preserved byte-for-byte in `preflight-helper-freeze/`; the four archival helper
changes have a separate manifest. No production/runtime file was changed.

`final-save-proof.json` SHA256:
`eff6b0a50ebd52a1876d217272e674e7dc2f5b17642e322fc9cc50113ba0f0c2`.
Before teardown, parent accepted the earlier `deec71cd...` proof, verified
the unchanged checkpoint and reviewed the then-current archival helpers.
After teardown, the additional empty-file/path checks produced the current
`eff6b0a5...` proof on the same unchanged save; parent and independent reviewer
verified all four current helper hashes. No new save, engine replay or live
trial followed this additional helper correction. The original strict
paired-trace failure remains false; native save validity and safe archival
are separate successful checks.

The exact Run X Compose project was removed with its networks and disposable
volumes. All three recorded startup-container IDs, including stopped containers,
are absent. Parent independently verified project cleanup, then checked the
owned SSH PID/start time and removed only that forwarder; its listener is gone.
Bind data, the unused preflight archive, saves, traces, failed-attempt evidence
and shared verified images remain. The unrelated Endfield service is untouched.

Final run evidence contains **144 files**; manifest SHA256
`66ebf160a56eb0187f951027c65a35293f9e1e8fff0e5f133a805e654d87e2bc`.
Parent and independent reviewer each verified every bounded unique path,
byte count and SHA256, as well as the original 27 preflight-helper freeze.
The native-load evidence remains separately sealed and verified (52 files).
The broader goal remains paused. There was no second live trial, production patch, remote push
or Pterodactyl deployment in this task.
