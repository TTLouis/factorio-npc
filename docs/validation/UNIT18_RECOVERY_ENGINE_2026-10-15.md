# Unit 18: native recovery completion and restart regression

October 15, 2026. Local deterministic Factorio evidence for the unit-17 recovery chain. This checkpoint does not authorize run J.

## Frozen candidate and delivered coverage

Code/test candidate **`4783226c2ce8df958863742cc13671607288095c`** contains runtime fix `7b8fe59` and the new `recovery-loop` engine lane. It builds through `tests/factorio/Dockerfile`; the final run uses the image directly, without runtime or runner overlays. Image config digest: `sha256:3a373242db537b3a0a046b5b7718e84d07562e8fcf73c3bf273eb5fa71d48df6`.

The lane has four separate Node invocations. Factorio also restarts between the first three phases; cancellation uses a separate pristine world.

1. **G/H prepare:** native supply and smelting produce 12 copper plates, then native collection leaves nine held and three in furnace output. The mixed iron/copper supply is rejected before dispatch. The real 15-second production timer resumes the committed plan, accepts a checkpoint-only reply, rejects an unsupported blocker, and pauses with one durable step/goal attempt consumed.
2. **I collect after restart:** the startup dispatcher restores the same goal/plan and allowance from disk. Its real timer resumes with freshly read furnace output covering the residual. Native collection obtains the remaining three plates. The fixture drops the dispatch acknowledgement and withholds completion notification, then saves both native and runtime state with two attempts consumed.
3. **Settle after another restart:** exact historical operation evidence settles the pending transfer. Fresh native inventory verifies the ten-plate goal with 12 held and zero left in output. An attempted collection replay produces **zero new authorized dispatches**. The goal is finalized, with no harness fault, silent stall or exhausted-resume finding.
4. **Cancel:** public player stop cancels the pending recovery timer. After its original deadline passes, no recovery starts, no extra dispatch occurs, the operator pause remains, and held/output stock remains nine/three. This proves pending-timer cancellation, not interruption of an already-running native batch.

The fixture seeds one furnace, a copper patch, coal 10, copper ore 12 and iron ore 20 once per independent world. Subsequent gameplay uses admitted native operations; there is no corrective insertion, teleport or entity spawning. Recovery runs with zero connected humans and game speed 1. This is recovery/mechanics evidence, not autonomous production or green-science proof.

Cached entity identity is only a locator. After restart, the fixture requires a fresh bounded nearby scan to match the native unit number, name, position and surface. Recovery packets themselves rebuild fresh machine observations; cached stock never supplies the completion assertion. Entities without usable native unit identity remain outside this particular fixture.

All main-model and Jev replies are scripted, with contract assertions at the fixture boundary. `fetch` throws, and the engine container runs with `--network none`. No real provider adapter, credentials or private endpoint is used.

## Real-timer defect and fix

Native attempt 3 exposed a production scheduling difference hidden by the mocked timer: a recovery timer inherited the completed provider turn's AsyncLocalStorage scope. Recovery activated, but its next provider round carried the old generation and was rejected as stale before the scripted provider could answer.

`7b8fe59` detaches a newly queued supervisor event from an inherited turn scope before registering its queue continuation. The originating provider continuation retains its own scope; actor/generation cancellation and stale-round checks remain intact. Trace event `recovery.queue_scope_detached` carries request correlation and reason `supervisor_event_starts_fresh_turn`. The new `R-scope` composed regression fires recovery under a discarded scope and requires verified completion without a stale drop. There are now 15 composed recovery scenarios.

Independent read-only reviews of the runtime fix and final engine runner found no concrete merge blockers. Retry caps, pause classes, authority and committed-plan ownership are unchanged. Installer payload source and copy list are unchanged.

## Verification and local evidence

- Final image build: exit 0, including mod tests/typecheck/Lua build.
- Post-fix canonical Docker runtime gate: **2,353 passed**, zero failed/skipped/todo; exit 0 (`unit18-runtime-scope.log`).
- Native attempt 5: all four recovery phases passed, exit 0. This diagnostic run used read-only runner/runtime overlays; it is retained separately from the frozen-image proof.
- Frozen-image engine pool: **recovery-loop, production, craft-trigger, native-admission and steam-lab all passed**, exit 0 (`unit18-engine-final.log`). Container inspection confirms network mode `none`, no mounts/overlays and no OOM. The recovery result records the frozen candidate SHA, zero humans, speed 1, 12 held plates, empty output and zero replay dispatches.
- The actual tested image's `supervisor.mjs`, recovery runner and lane shell script match frozen source after CR normalization; copies are retained under `test-results/unit18-final/source-check/`.
- Merged canonical `bash scripts/test-local.sh all`: **2,353 runtime/staging tests; 1,142 mod tests across 128 files passed**, plus typecheck, Lua build and generated-Lua checks; exit 0 (`unit18-integration-all.log` in the integration worktree).

Uncommitted evidence stays in `.claude/worktrees/unit18-recovery-engine/`: `unit18-build-final.log`, `unit18-engine-final.log`, and `test-results/unit18-final/` for the final image; `test-results/unit18-attempt3/` retains the actual stale-turn failure. Earlier logs/artifacts retain fixture lookup, scenario and reconnect failures rather than erasing them. Each recovery phase writes behavior JSONL and an RCON transcript; the lane also preserves manifests, durable state and native saves. `recovery-complete.json` records the frozen candidate SHA, native inventory and zero replay dispatches; `recovery-cancel.json` records the cancellation comparison.

## Integration and remaining promotion gates

Reviewed changes merged locally into `og-port-integration` at **`e39eea278f1a0fbf319043f82f9694c4d033d893`**. The merged runtime/mod/engine sources match frozen candidate `4783226c`; only documentation differs. The full static gate passed after this merge. The installer bootstrap pin remains valid because its payload source did not change; its existing tests are included in the runtime gate.

No push, live provider run, server deployment or release promotion occurred. A later live run still requires the pushed/frozen deployment to be verified file by file and Louis's explicit go under the [reconciled plan](RECOVERY_LOOP_RECONCILIATION_2026-10-14.md).
