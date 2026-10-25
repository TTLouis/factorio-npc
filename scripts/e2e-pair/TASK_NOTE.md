# Paired harness preparation checkpoint — 2026-10-25

- Owner: `paired_e2e_harness`; parent `/root`, chat `01a171d1`.
- Branch/worktree: `test/paired-red-automation`, `.worktrees/test-paired-red-automation`.
- Starting Jev SHA: `11d182c1aa8650c9254a58ee8dc4bfc3fe7b936a`.
- Dependency: parent review/integration of the separate contract-obligation repair,
  then selection and independent compile/build of the actual next candidate.
- Authorized scope: parameterized paired helpers, offline tests and commit only.
  No runtime/game contract changes, live world, inference/Jev, tunnel/listener,
  image build, deployment, push or further delegation.

The kit freezes two normal-speed AW lanes with distinct explicit native map seeds,
projects, ports, data/evidence, approvals and checkpoints. Each gets independent
installed-file/model/cold-world/seed proofs and strict cancel/pause/save/ZIP/pristine
2.0.77 verification. One image/compile can be reused; only the pair finalizer owns
the unique tag. A failed lane leaves its peer running. Optional peer-success
cancellation requires verified native measurement acceptance, never wrapper exit
or claimed goal completion. Parent quota evidence is shared across the pair,
expires after 180 seconds and distinguishes stale/unavailable from a true 7% floor.
The 5% reserve, 60 minute construction cap and original measurement remain intact.

Acceptance evidence:

- All 62 original AV helper hashes verified against manifest
  `8dbb4ccf9bf0d0b54c3a01468d9e730f7258e408c0738ac8eef6cfb75af56559`.
  Explicit copied-helper and immutable regression-input hashes are tracked in
  `av-provenance.json`; AV historical data was never modified.
- 8 Node freezer/schema/acceptance tests PASS.
- 51 PowerShell syntax/actual-script fault checks PASS: lane cleanup while sibling
  runs, runner/emergency failure, exact independent teardown, failed inventory,
  unfinished-peer image retention and successful pair-only tag removal.
- 58 rendered helper tests PASS, including per-lane fresh cancel + same-goal pause
  + save sequencing, external cancellation scope, original stop negative control,
  closed role contracts, topology/measurement and response recorder.
- 10 ZIP integrity/layout tests PASS. No native-engine or gameplay proof claimed.
- Unchanged repository gate PASS: 103 agent, 3448 runtime, 1378 mod tests, type/Lua
  and generated-Lua checks. `git diff --cached --check` PASS.
- Final cleanup: eight recorded offline Docker IDs plus three all-gate container
  names absent. No images, networks or volumes created; no resources retained.

Full logs and generated fixtures remain ignored locally at
`test-results/paired-kit/`; final focused attempt
`attempt-20261025T082340-46806a`, repository gate `all.log`/`all.exit`, original AV
verification `av-input-verification.json`, cleanup `final-cleanup-proof.json`.
Earlier failed fixture-layout/mock-isolation attempts are retained and corrected;
no provider or live trial was involved.

Remaining parent gates: independent kit review, actual repaired candidate and
payload/build/source freeze, both real native preflights, dedicated Luna overwatch
per lane and the explicitly authorized paired launch. The run instructions and
failure/cleanup recovery boundaries are in `README.md`. Full per-lane and combined
metrics/cost reports remain required after any real pair; the kit's combined call
index explicitly marks costs/unknown telemetry unavailable.

## R1-R3 review follow-up

Immutable reviewed baseline: `ff98d3e5df2fe69006b3803092c131bc445656db`.
The owner's external `paired-harness-review.md` requested three changes. The
follow-up keeps this checkout the sole kit writer and changes no runtime/native
or game-contract file.

- **R1:** durable run/source/actor/epoch/control identity now precedes the
  starter. The actual intake boundary and host stop writer serialize through
  the same exclusive gate. The external supervisor can cancel from launch
  identity while goal persistence is pending; once a goal exists, it uses the
  actual same-goal strict receipt/save path. No-goal evidence remains explicitly
  incomplete. Complete runner-entry tests inject owner/stale/floor stops before
  intake and during pending LLM/Jev work, execute the actual coordinator control
  functions and external supervisor, and prove lane isolation/no duplicate
  intake/no fake strict success. Filesystem/RCON transport is substituted;
  native engine behavior and provider cancellation are not inferred.
- **R2:** exclusive controller creation distinguishes owned prepared-to-launch
  work from duplicate active controllers. Successful preparation records a
  pair/source/image/lane capability. Launch refusal after ownership transfer is
  inside cleanup, attempts both lanes even if A fails, checks resource/process
  absence and records image retention/removal. Duplicate invocations cannot
  stop the existing owner; a stale capability is never silently stolen.
- **R3:** exact candidate Compose inputs are frozen per lane and manifest-listed.
  Actual up/down use these files with immediate embedded hashes, an explicit
  relocated project directory, absolute mounts and disabled build context.
  A distinct-candidate regression mutates both external working Compose files,
  proves frozen up/down, then proves corrupted frozen input cannot reach Docker.

Original controls execute actual immutable baseline entry-point source: R1
submits intake after owner stop and dispatches no immediate cancel; R2 refuses
quota with neither lane cleaned; R3 uses external Compose paths. All three
expected failures are retained separately from positive results.

**Separate runtime launch blocker:** the real unchanged `NpcAgentLoop` also
reproduces an abort-swallow bug during goal-admission steering. Both an undefined
steering result and `AbortError` after `agent.cancel('user_stop_immediate')` lead
to one mocked provider request after cancellation. Parent assigned the separate
`fix/goal-admission-cancel-fence` owner. This branch does not fix runtime, and
cannot claim no further runtime inference until that repair is integrated and
the combined candidate passes its real-runtime regression. Evidence/source tree
identity and exact offline container cleanup are retained under
`test-results/paired-kit/r1-runtime-repro/`.

Follow-up verification and final local attempt are recorded below after the
focused gate. The required repeated repository all gate is
`test-results/paired-kit/all-r1-r3.log` / `all-r1-r3.exit`: 103 agent, 3448 runtime,
1378 mod plus type/Lua/generated PASS. Its selected production/test paths remain
unchanged by subsequent kit-only test/document refinements. No new heavy gate
was started after the parent's shared-resource serialization instruction.

Final focused attempt: `test-results/paired-kit/attempt-20261025T085742-3510bb/`.
All per-phase exit receipts are zero: 32 Node tests (including nine complete
runner-entry scenarios), three immutable reviewed-baseline controls, 82 actual
top-level coordinator assertions across 11 scenarios, 51 existing lifecycle/AST
checks, 58 rendered helper tests and 10 archive tests. The PowerShell assertion
counts include syntax checks and mocks; they are not counts of live trials.

`r1-r3-final-cleanup-proof.json` freshly verifies 17 recorded offline container
IDs and six repository-gate names absent, no retained resources or newly created
images/networks/volumes, and all 62 original AV helper hashes unchanged. All
runtime/native/contracts and ordinary all-gate-selected paths remain unchanged.
Full failure attempts, exact baseline source controls and runtime-bug evidence
stay ignored locally. Parent independent follow-up review remains required;
actual candidate freeze and paired launch remain blocked on combined runtime
repair verification and the existing live/native gates.
