# Luna controller reconciliation — 2026-10-06

The owner requested reconciliation after the earlier usage stop, then started Docker Desktop for the required gates. This checkpoint supersedes the incomplete integration status in `LUNA_CONTROLLER_REPAIRS_2026-10-06.md`; that historical record remains unchanged.

## Source and integration

The local repairs were preserved in `90fc419c` before merging Claude's shared branch at `48e2f1f7`. Claude's research-trigger ladder and reviewed fresh-read checkpoint settlement are retained. The G4 exact-identity rebinding proposal remains unimplemented.

There is one fresh-read settlement implementation and one existing step-outcome authority. Settlement requires idle correlated work and captures actor, epoch, goal, canonical goal, plan version, step, contract, generation, handoff and conversation identity around asynchronous reads. Pending amendments hold settlement, including amendments arriving during the predicate read or final steering review. Closing a satisfied checkpoint drops operations written for the closed step and requests newly authored operations for the next step.

Strict protocol regressions also cover initially admitting an observation-only semantic step, explicit canonical step identity on semantic closure, repeated descriptions with stale executor indexes, and retaining an active canonical goal when a legacy board completes. Updated scripted replies prove continuation; retained failure packets remain separate evidence.

## Validation checklist

- [x] Read-only reconciliation review and inspection of the integrated source.
- [x] Official Docker `scripts/test-local.sh all`: 1,805 runtime tests passed, zero failures; 120 mod files / 1,036 tests passed; TypeScript, TSTL and generated-Lua checks passed. Log: `test-results/luna-system-fixes-2026-10-06/reconciliation-final-all.log`.
- [ ] Full Docker build gate: `test-results/luna-system-fixes-2026-10-06/reconciliation-build.log`.
- [ ] Immutable installer payload repin and generated-artifact checks.
- [ ] Owner-authorized bounded Luna planning/tracker probes; no gameplay operations or Jev calls.
- [ ] Separately authorized fresh autonomous Factorio run.
- [ ] Owner-client multiplayer join/leave gate.

Earlier isolated real-engine crafting, native research, placement/smelting, restart, persistence and death-recovery evidence remains in the preceding repair checkpoint. No source gate or planning probe establishes autonomous green-science success. Historical desync attribution remains unconfirmed.

The reconciliation itself makes no gameplay interventions and does not deploy to the running server or update the owner's client mods. Live Luna planning probes were separately authorized by the owner after the Docker suite passed; their prompts, raw model decisions and deterministic validation results will be recorded independently.
