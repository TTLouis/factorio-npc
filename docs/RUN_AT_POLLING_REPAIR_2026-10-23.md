# Run AT polling repair

Failure: Run AT at `9b4037679688612f75ac1c49df6b188d6cf2adbc` stopped on
`Sprint harness polling budget exhausted`. Its last cumulative counters contained
6,152 `boundary_restore` calls. That is a run total, not a per-minute count.
The original fault and preceding telemetry are preserved in
`runtime-v8/fixtures/run-at-polling.json`, with the sealed source trace digest.
Implementation starts from local integration `8426105c`.

The broken invariant belongs to `TickSprintController`: a world-command boundary
must establish native 1× and refresh sprint-affected facts without amplifying
ordinary traffic into unbounded additional control polling. The old controller
sent a separate `finish` RPC before every command. Its tests covered restoration
and finite sprint episodes, but omitted sustained boundary traffic and recovery
after the polling guard rejected that traffic.

The shared command wrapper now checks native guard identity, current speed,
absence of a lease and reconciliation of the last lease in the same native Lua
invocation as the original command. The command is withheld if those facts do
not hold. One restoration/refresh can then precede one retry of a payload proved
unexecuted. Missing or malformed execution proof never authorizes replay. The
original command determines primary versus auxiliary UI routing. An active host
lease still takes the existing restoration and freshness path first.

The unchanged 1,200/minute limit now explicitly measures **additional controller
RPCs**. Inline native guard reads are counted separately in `boundary_inline`:
they share a world-command RPC and remain under that caller's existing budgets.
This is a change in boundary transport and accounting, not a claim that all
native guard inspections fit under 1,200/minute. Lease ticks, wall limits,
episode expenditure, provider/recovery budgets and construction cap are unchanged.

Residual saturation has one durable harness-owned attempt per frozen run/source.
The controller disables future acceleration, restores 1× through at most four
independent emergency reads (finish, identity, inventory, identity), waits for the
natural monotonic-minute rollover, then refreshes those facts again through the
ordinary budget before continuation. It neither resets the bucket nor refills
episode allowance. Waits wake at most every 100 ms to release promptly on a stop
or replacement. Existing native work may continue at 1×; no operation is replayed,
completed or admitted by this recovery. Ordinary validators still own completion.

The wall watchdog has one lease-scoped emergency finish before any wait on the
primary serial barrier. This remains independent when the primary lane is held.
Eligibility, arm and ordinary boundary saturation enter the same recovery.
Unreadable native facts, uncertain host effects, amendments, paused authority,
failed persistence/telemetry and a second miss fail visibly. Attempted/exhausted
ledgers cannot be resumed after restart. A completed ledger disables subsequent
sprints on restart. Superseded recovery retires its original owner, restores 1×
without cancelling or faulting its replacement, and retains its spent allowance;
the replacement can wait out only the original bucket and obtain fresh facts.
Operator safety cancellation does not wait for that minute rollover.

Named attempt/completion/exhaustion/supersession traces carry request and canonical
identity where available. Polling telemetry includes the actual minute bucket and
accepted additional-read count. The checker detects the exact historical fault
even without a request ID and recognizes an exhausted correction. Successful
recovery phases are not themselves a failure signature.

Proof uses the actual AT fault/counters with explicitly substituted saturation at
the causal 1,200-read bound, plus the recorded AO committed-plan fixture to drive
the real `Session`/`NpcAgentLoop` callback and next admission. Both new positive
cases fail the unchanged baseline with the original error, rather than a missing
new API. The failure matrix covers traffic prevention, residual callback progress,
withheld inline work, eligibility/arm/watchdog paths, held-primary wall safety,
post-wait facts, busy native work, stop, replacement during awaits/traces,
uncertainty, unreadable facts, durable restart, exhaustion and stalled clocks.

Build checkpoints:

- [x] Preserve exact failure; reproduce baseline negative controls.
- [x] Shared prevention and composed residual continuation regressions.
- [x] First exact Factorio 2.0.77 inline-framing/UI and sprint lifecycle proof.
- [ ] Freeze reviewed candidate, payload pin and final offline/native/lint gates.
- [ ] Independent immutable review, merged offline gates and owned cleanup.

Evidence is under `test-results/run-at-polling-recovery/`; old AT/AR/AS evidence
remains sealed and unchanged. Native framing/lifecycle proof does not establish
autonomous science production. No new live E2E, provider retry, publication or
production deployment is authorized by this repair.
