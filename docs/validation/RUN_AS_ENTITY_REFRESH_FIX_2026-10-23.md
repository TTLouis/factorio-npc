# Run AS entity-refresh repair — October 23, 2026

Owner: Codex /root chat01a16ab4. Unit A implementation only; no new live trial,
push or deployment. [Implementation and proof matrix](../RUN_AS_ENTITY_REFRESH_FIX_2026-10-23.md).

## Immutable identities

| Boundary | Identity |
| --- | --- |
| Consolidated source | `10e2c307f94a6683353ddfc26689df263099faa2` |
| Original AS executable | `cdbc95eda101e6c2f559c0e2848bcaa923df1be6` |
| Freshly checked published Jev | `b9574fc4556eafb431f158ebee80fe3f1807a02d` |
| Runtime and installer source | `a6989b92965e4cb14c5b78757d804efa1fd57d25` |
| Payload pin commit | `3f31e4b881c584b6594eeef464df82939c9c15d9` |
| Approved candidate, including native-lane port fix | `9a3c9e42a680f67861fc4f29756fddf4cd550655` |
| Local integration merge | `6beb6dc72de590ff35c97d4ffc6012f9e1d6df87` |
| Installer payload SHA-256 | `6d9ff05468d450708b8ae00650f825380291c5022206f8963154512688245be4` |

Payload imports/copy closure includes the new module. Candidate and merged deploy/
test trees match. This closeout adds documentation only after the tested merge.
The published branch remains unchanged; the protected primary was not switched.

## Verification and limits

- Exact baseline controls: final two positive tests fail on unchanged10e2c307 for
  exact-entity live-binding guard and typed-observation entity-not-grounded refusal.
- Candidate/frozen/merged `scripts/test-local.sh all`:3,343runtime/1,378mod,
  typecheck and Lua/generated-Lua PASS.41new runtime tests. Changed-file lint has
  zero diagnostics. Candidate and merged payload checksum/tests:9PASS.
- Dedicated Factorio2.0.77 native04: prevention and genuine post-parse binding-loss
  residual cases, each1native collection batch,10plates held/0output, ore10 and
  fuel9 unchanged,10physical smelts, original canonical step verified, unchanged
  committed steps.1x, zero humans, zero inference;92runner helper tests pass.
- Explicit native fixture substitutions: new current actor/epoch/unit/surface,
  independent declared stock/terrain and monotone native journal watermark. Runtime
  placement/supply/smelting/collection are physical. A scoped fixture boundary ends
  only after ordinary Session/native checkpoint close, before unrelated next-slice
  planning. It does not complete the science goal.
- Restart/exhaustion/uncertainty/stale-request tests preserve existing authority,
 2/step6/goal controller limits and targeted-read allowance. Disappearing output
  cannot become new production authority. Restored collection wakes and final
  admission share fresh native wait/craft/follow fences. Checker clearing requires
  the full verified owner tuple; incomplete historical diagnostics remain unresolved.
- Independent immutable review APPROVED9a3c9e42. All eight findings resolved with
  regressions, including test-lane collision;35lane mappings and9wrapper lifecycle
  cases PASS, original duplicate mapping produces the expected negative failure.

Initial candidate mod timeouts during concurrent compilation pass isolated/full
reruns without weakened limits. Failed native fixture attempts are retained:
ordinal and empty-journal setup errors, then two blocked fixture-stub next-slice
provider invocations after verified recovery. Network-disabled tests made no real
provider/Jev calls. These attempts are not passing recovery evidence. Native04
attempted zero inference. No billed-cost claim is made.

Evidence remains in the clean retained task checkout:
`D:/SideProjects/airi-factorio-npc/.worktrees/fix-run-as-entity-refresh/test-results/run-as-entity-refresh/`.
Read `final-summary.json`, `independent-review.md`, `baseline-negative-final.log`,
`candidate-frozen-all.log`, `merged-all.log`, `payload-merged.log`, `lint-final.log`,
`tooling-final.log`/`tooling-negative.log`, and `native-04/` results/transcripts/saves.
All native source hashes match the tested runtime; Git CRLF normalization is
recorded independently and does not alter executable semantics.

Owned Docker names/IDs and test image identities are in `cleanup-final.json`.
Containers are absent including stopped state; task images are removed/absent.
No run-owned Compose project/network/volume/tunnel/config link was created.
Shared base images and evidence are retained. No background work remains.
Sealed216AR+222ASfiles and31historical reports are rehashed unchanged.

The exact regression, composed self-correction and native mechanics are proven
within this scope. Autonomous science-rate gameplay success remains unproven.
Units B shutdown-alarm classification and C accounting helpers remain future work.
