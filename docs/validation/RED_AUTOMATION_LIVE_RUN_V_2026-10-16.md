# Run V — delegated CLI-proxy trial, stopped early

One owner-authorized trial ran for about 24 minutes at frozen candidate
`4cc7b57eecbd563a8765b6096aaecd9bd2a3f90b`. It ended under a parent-directed
operator stop, **not** autonomous recovery exhaustion or throughput success.
The broader E2E goal remains **paused**. No second trial, push or deployment
was performed. The owner-approved 40% weekly remaining floor applied only to
this trial; the ordinary 50% reserve remains the boundary for future work.

## Verified progress

- Fresh actor 6, seed 2330120865, new goal `goal_01zf04a_1`, zero humans and
  construction speed 1. Only the original starter was granted. No operator
  gameplay after starter, corrective prompts or manual provider retries.
- Real delegation: Sol 6.1 planner made eight requests/eight responses; Luna
  executor made 63 requests/62 responses. Total 71 requests/70 responses,
  zero provider errors, with one outstanding response at cancellation. Jev
  completed 55/55. Closed gameplay requests retained 40 tools with explicit
  `tool_choice:none`; exclusive checkpoint requests retained their one-schema
  contract. No role/model mismatch was reported.
- Native production reached 119 iron ore, ten copper ore, 35 coal, **50 new
  iron plates and ten copper plates**. Iron production proves continuation
  past Run U's copper-output obstruction. One stone furnace was placed.
- The actor acquired a pump, boiler, steam engine and two poles. None formed
  a placed power network. Red production was zero; no automated mining,
  smelting, gears/science chain, topology candidate or measurement was proven.
  Ten gears consumed during handcraft bootstrap do not prove automatic gears.

## Early-stop chronology and interpretation

At 15:48:21.495Z and 15:48:25.939Z, Luna returned empty-operation `BLOCKED`
replies claiming inadequate legal-shoreline evidence. The runtime rejected
these as `world_blocked_without_authoritative_evidence` and entered a
`model_recoverable` action-omission pause at 15:48:26.263Z.

Built-in recovery attempt one started at 15:48:41.315Z and resumed the plan at
15:48:41.375Z. At 15:49:03.573Z it proposed a local offshore-pump placement;
native admission refused it as `not_placeable`, without mutation, at
(-103.5, 24.5). A full snapshot at 15:49:08.386Z proves `paused:false` before
the parent-directed stop was submitted at 15:49:08.393Z.

The parent mistakenly treated the observed recoverable pause as an immediate
stop condition during a context refresh. The correction to preserve the
approved automatic-recovery rules arrived after stop submission. No
`recovery.auto_resume_exhausted` event occurred. The subsequent recovery
outcome is unknown, so this truncated run cannot establish an unavoidable
shoreline blocker or justify a production change by itself.

Before another trial, make the supervisor's terminal decision use the frozen
runner's authoritative classification: structural terminal, nonresumable
pause, exhausted automatic recovery, uncleared-pause timeout or an existing
budget/invariant limit. Preserve bounded automatic recovery for transient
`model_recoverable` and transport pauses. Investigate the shoreline fact and
placement sequence offline using the retained exact wire and native receipts.

## Deployment, save and cleanup evidence

Server image:
`sha256:9ccd2bb05fb303ee3f4ae088dff8faa97d52de56d68cb509353d3dfe08d41e13`.
Preflight verified 50 runtime/staging modules, prompt, release manifest and
31 active compiled-mod files against the frozen source and the validated
Factorio 2.0.77 image. Both role-contract preflights made zero inference
calls. The readonly authenticated model catalog passed after restoration of
the existing loopback SSH forwarder; `.env` selections were unchanged.

Same-goal cancellation/operator pause, intake clearing and native idle with
empty task/crafting queues were confirmed at 15:49:36.660Z. Factorio completed
the fresh **875,954-byte** checkpoint at 15:49:38.209Z. Full CRC verification
passed all 56 archive entries. The external verifier's legacy `level.dat`
assumption was corrected after the run to accept the native complete split
format, with exact same-root membership, duplicate rejection, contiguous
chunks and script/info files. Stop, freshness, save-log completion and
stability checks were preserved; independent review approved it before down.

Save SHA-256:
`9a0a72902e5d0d406cefa766cc44d89e528df6bd76adde88d03983511c629b18`.
Post-run verifier SHA-256:
`ce76fc9173708d8b17c5036b892d91c40e52854703e3991164343557ef8d6a85`.
The original preflight/helper freeze remains historical and unchanged.

Only isolated project `red-automation-20261016v` was taken down, after save
verification. The parent then verified and stopped only the trial-owned SSH
forwarder by exact PID/name/start time and confirmed its listener absent.
The VM and unrelated stacks/processes were untouched.

Ignored evidence and checkpoint are retained under
`test-results/red-automation-live-2026-10-16v/`: `final-summary.json`,
`final-handoff.md`, `final-evidence-manifest.json`, raw prompt/behavior/decision
traces, native snapshots, pre-stop chronology, `final-save-proof.json`,
`stack-down-proof.json` and `tunnel-cleanup-proof.json`.
