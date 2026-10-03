# Native output delivery candidate — October 3, 2026

This unit supplies an **engine-unvalidated candidate witness**, not a passing
playable checkpoint. `satisfied` is always false. Native Factorio conformance
remains unverified. Docker became available after the implementation checkpoint.

`autorio_output_delivery_proof.register(spec)` binds one exact named chest, item,
force and surface to at most eight direct assembler → inserter → chest paths.
`status(proof_id)` reports five consecutive game-minute buckets, each requiring
at least ten witnessed deliveries. At most four witnesses are retained.

Factorio 2.0.75 installed typings expose `held_stack`, `pickup_target`,
`drop_target` and assembler `products_finished`. They expose no native cumulative
inserter/chest delivery counter or generic chest-inventory-change event. The
candidate therefore samples every tick and accepts a depletion only when it
balances both the exact chest delta and newly finished output credits from its
bound assembler. Force-wide production and chest growth alone never count.

Sampling gaps, deficient minutes, unexplained deposits/withdrawals, changed
identities/topology/recipes, destruction and attached humans reset the witness.
The synchronized task-batch generation resets every witness when the existing
runtime establishes the new generation after reload. The harness must establish
that generation before registering or evaluating a witness after reconnect.
There is no peer-local `on_load` mutation or generation increment in this monitor.
Clock rollback or a missing tick invalidates the window; prior valid buckets
never survive those observed gaps. Native restart conformance remains unverified.
Existing NPC hand-insert and hand-craft accounting invalidates affected output
and declared supply paths. Initialization waits for empty producer output and
empty inserter hands, excluding pre-existing science buffers.
Manual fuel deposits into declared supply entities also invalidate measurement;
the older global hand-work fuel exemption does not apply to this witness.

Unsupported cases include belt intermediaries, downstream withdrawals from the
measurement chest, probabilistic/multiple-product recipes, non-normal quality,
connected humans and mutations by uninstrumented third-party scripts. Simultaneous
unobserved script inserts/removals can conceal provenance; this is why the
candidate cannot be promoted without an explicit supported-environment contract
and native conformance tests. Full upstream automation is a separate validator;
the delivery witness cannot establish the provenance of every upstream input.

The deterministic cases cover five valid windows, a deficient window after a
surplus, manual chest growth, hand feeding/crafting, replacement at the same
coordinates, topology changes, sampling gaps, attached humans and source-free
hand depletion and save-generation changes.

The canonical Docker mod gate passed against implementation commit `275bd5bf`:
115 test files / 911 tests, TypeScript typecheck, Lua build and generated-Lua
guard. The log is `logs/output-proof-mod-2026-10-03.log` in the enclosing workspace.
These gates verify regression behavior and compilation; they do not promote the
candidate to native delivery proof or establish playable red-science acceptance.
