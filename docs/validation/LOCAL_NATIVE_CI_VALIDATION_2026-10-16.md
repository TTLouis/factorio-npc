# Local CI and real-engine verification — October 16, 2026

Pulled remote `37d5728be12fd07eab456c0d4490726ae8a6156e` into the clean
integration checkout by fast-forward. Completed its local validation and
reproduced the deterministic engine failure. The E2E goal remains **paused**.
No live provider/Jev calls, service deployment, push, or actual `.env` reads or
changes were performed.

## Engine findings and fixture corrections

1. The lifecycle test compared refused-request iron ore with its earlier planning
   snapshot (six ore). The intervening persistence fixture intentionally replaces
   inventory with 17 iron plates and 13 copper plates, leaving no iron ore. Measure
   effects immediately before/after the refused request on the exact NPC body,
   comparing all main-inventory item/quality counts, force, surface and humans.
   Require sufficient crafting ingredients so the locked recipe remains the
   structural cause. Record both snapshots in the native proof.
2. The next persisted-blocker fixture used an invented resource prototype to
   expect a structural BLOCKED state. Unknown prototypes are correctable argument
   failures. Use the real `iron-gear-wheel` recipe, disabled on the actual NPC
   force, through the approved `craft_item` operation. Require `recipe_locked`,
   one scripted provider call, guard pause and no admitted work. Preserve the
   real restart, frozen plan/lineage, ordinary-continuation refusal, and explicit
   user-revision successor checks. Restoring recipe availability alone cannot
   revise the frozen plan.

Production refusal classification, recovery, limits and operation permissions
are unchanged. The two changed files are native test runners. Independent review
approved frozen `b36872af`; local no-ff integration is `8df6d2cc`.

## Verification

| Check | Result |
| --- | --- |
| Merged canonical runtime/staging | 2,468 passed |
| Merged Autorio unit tests | 1,144 passed |
| Ordinary-agent unit tests | 102 passed |
| Repository lint / changed runner lint | Pass; zero warnings/errors |
| Workspace build/typecheck and generated-Lua semantic checks | Pass |
| LuaJIT parse of ordinary and guarded `control.lua` | Pass |
| Isolated native deployment guard typecheck/build | Pass |
| Installer consistency and verifier | Pass; nine tests |
| Compose configuration, secret boundaries and loopback listeners | Pass |
| Full corrected resilience lane, including restart/death/navigation/crafting | Pass |
| Final official native suite | All 22 lanes passed; 92 Python regressions passed |

The initial 22-lane engine run at `37d5728b` passed 21 lanes and failed the
historical inventory comparison. The corrected refusal proof retains 17 iron
plates and 13 copper plates across the rejected request. An isolated mutation
control removes one real iron plate after refusal; the new complete-inventory
assertion correctly rejects 16 versus 17. The original downstream
unknown-prototype fixture failure is also retained.

Final engine image:
`sha256:07b956a02a393680f6446e0aa9f0b63ed926d673142f55d14164b9607ee2781a`.
Both changed native runner files match reviewed `b36872af` after CR normalization.
Engine runs use the official Factorio 2.0.77 image with `--network none` and
scripted provider replies. Local Docker tooling uses Node 22.23.3 and pinned
pnpm 10.30.1; these results do not claim a new hosted Node 24 CI run.

Compose uses copied public files, synthetic sentinel credentials, and a child
environment excluding host credentials. The missing-password negative control
fails as required. No services are started; real `.env` values and API URL/key/model
selections stay untouched.

Ignored logs, initial failures, build evidence, Compose fixture and merged gates
are retained under integration `test-results/head-validation-2026-10-16/`.
Final engine, corrected lifecycle and mutation proofs are retained under task
`test-results/native-lifecycle-baseline/`. No assertion was relaxed, no production
shortcut was added, and no installer repin is needed for native-runner-only edits.
Complete unattended factory throughput remains unproven and paused.
