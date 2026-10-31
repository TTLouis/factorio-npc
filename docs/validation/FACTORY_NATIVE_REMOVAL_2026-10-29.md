# Exact-building removal custody — October 29, 2026

This change gives standalone `mine_entity_exact` building operations measured
native custody evidence. Generic/name-based and resource mining retain their
existing paths. Host retirement and temporary cleanup must still authorize the
exact affected assets and consumers; a removal receipt grants no such authority.

The unchanged operation arguments and `getTaskStatus` input are listed in
`contracts/factorio-tool-contract.json`. That manifest contains dispatch/argument
parity, not a result schema. The additive result is `entity_removal` under both
`basic_operation.last_result` and the existing admission journal record. The
public status exposes that journal as an array; the internal admission status
lookup returns `{ records }`. No new public tool or remote API is introduced.

Exact-building removal requires a singleton protocol-2 admission and current
actor/epoch/session, batch, world and visible exact-member identity. It uses the
existing approach/reach behavior and live native mining-time calculation before
one synchronous native `mine` call. Complete bounded inventories and current
native deterministic mining products supply expected custody. Combined capacity
is checked before the call; independent per-item capacity checks are insufficient.

Receipt states are `prepared`, `verified`, `refused`, `partial` and `uncertain`.
`verified` requires a successful native return, exact target disappearance and
the complete actor inventory equaling its prior contents plus all expected
contents/products, including qualities. Positive measured deltas are retained.
False returns, exceptions and mismatched/unreadable custody cannot complete
retirement. Nonempty fluids, in-flight crafting, metadata-bearing/spoiling stacks,
unsupported transport/mobile contents, random yields, active inventory filters
and bars refuse before mining. `fluids_empty: true` means every reported fluidbox
was observed empty; `fluidboxes` counts those boxes.

The existing admission record retains the receipt across cancellation/restart;
the task does not retry removal. The host must durably settle its singleton
lifecycle and copy the receipt before issuing another operation. Missing/expired
journal evidence is unknown and does not authorize replay. Existing admission
ordinal/high-water and startup uncertainty rules remain authoritative.

Local evidence under the shared workspace's
`test-results/factory-tracker-stack-20261029/continuation-native-removal/`:

- `probe-01/native-removal-probe.json` and transcript: nine declared native API
  lanes on Factorio 2.0.77 with zero providers. A full destination returned true
  and removed a chest without recovering its building item. Combined capacity
  failure returned false after moving part of its contents. Nonempty fluid was
  discarded. Quality-aware contents and a metadata blueprint survived supported
  successful fixture calls; the implementation conservatively refuses metadata
  until its complete custody contract is supported. A same-prototype neighbor
  stayed unchanged, and external destruction produced no recovered items.
- `mod-01.log` retains the first failing iteration; it is not passing evidence.
  Further mod/type/Lua checks and compiled native `entity_removal_factorio.mjs`
  prepare/reload proof are pending at this implementation checkpoint.

This is a native custody prerequisite. It does not establish complete cell
lifecycle, consumer independence, automatic recovery, or autonomous E2E success.

Verified continuation addendum, October 29: `mod-03.log` passed all 1,773 mod
tests, TypeScript/Lua compilation and generated-Lua checks. `native-01/results/`
passed the newly compiled exact 2.0.77 prepare/reload proof with zero providers
or humans, restored pause/1× and full save ZIP checks. Its fluid fixture stopped
at `removal_target_working`; it did not exercise the fluid-specific guard.
`native-02/results/` reran the driver against that unchanged compiled custody
core with a separately hashed driver override. Its inactive boiler reached
exactly `removal_fluid_present`, and prepare/reload and ZIP checks passed.
`MOD_READY.json` and `build-source-manifest-01.json` identify the frozen core.
The native false-return partial transfer is an API-probe result; the production
receipt's partial branch has unit coverage, not an injected native production
proof. Host lifecycle composition and the separate observation changes require
their own candidate checks.
