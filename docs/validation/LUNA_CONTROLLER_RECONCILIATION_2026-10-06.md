# Luna controller reconciliation — 2026-10-06

The owner requested reconciliation after the earlier usage stop, then started Docker Desktop for the required gates. This checkpoint supersedes the incomplete integration status in `LUNA_CONTROLLER_REPAIRS_2026-10-06.md`; that historical record remains unchanged.

## Source and integration

The local repairs were preserved in `90fc419c` before merging Claude's shared branch at `48e2f1f7`. Claude's research-trigger ladder and reviewed fresh-read checkpoint settlement are retained. The G4 exact-identity rebinding proposal remains unimplemented.

There is one fresh-read settlement implementation and one existing step-outcome authority. Settlement requires idle correlated work and captures actor, epoch, goal, canonical goal, plan version, step, contract, generation, handoff and conversation identity around asynchronous reads. Pending amendments hold settlement, including amendments arriving during the predicate read or final steering review. Closing a satisfied checkpoint drops operations written for the closed step and requests newly authored operations for the next step.

Strict protocol regressions also cover initially admitting an observation-only semantic step, explicit canonical step identity on semantic closure, repeated descriptions with stale executor indexes, and retaining an active canonical goal when a legacy board completes. Updated scripted replies prove continuation; retained failure packets remain separate evidence.

## Validation checklist

- [x] Read-only reconciliation review and inspection of the integrated source.
- [x] Official Docker `scripts/test-local.sh all`: 1,805 runtime tests passed, zero failures; 120 mod files / 1,036 tests passed; TypeScript, TSTL and generated-Lua checks passed. Log: `test-results/luna-system-fixes-2026-10-06/reconciliation-final-all.log`.
- [x] Full Docker build gate (exit 0): `test-results/luna-system-fixes-2026-10-06/reconciliation-build.log`.
- [x] Immutable installer payload repin at `fa0ce8bf`, pointing to source `8e89abfb25b87d43d33e2eb7dc0b19e6e8c910e3`; payload SHA256 `ef8d9447c44009365022fac9dca158c0db8b622a229626e60bebcb1191586de5`. Generated artifacts match; all nine payload tests passed. The official runtime/mod gate passed again after repinning (`reconciliation-pinned-all.log`).
- [x] Isolated reconciled real-Factorio trigger-ladder lane (exit 0), zero connected humans, no network or published ports. Native electronics, steam-power and automation-science-pack unlocks passed; this scripted lane runs at speed 4 and does not exercise logistic-science-pack lab research. Logs: `reconciliation-trigger-ladder.log` and `reconciliation-engine-evidence/trigger-ladder.log`. Disposable world removed with the container; detailed per-lane JSON was not exported.
- [x] Planning/tracker probe runner validated with scripted decisions: 4/4 passed, zero provider calls. New-plan declarations, unmet/stale research, satisfied-step continuation and grounded semantic closure use production provider/controller/tracker code against fixed observations.
- [ ] Owner-authorized live Luna planning probes: four attempted HTTP requests returned fetch failures with no HTTP/model response. DNS resolved; a separate TCP-only diagnostic returned `ECONNREFUSED`. Logs: `luna-planning-live.log`, `luna-planning-live/*.json`, `luna-proxy-connectivity.log`. No retries, Jev calls, game connections or gameplay admissions. Waiting for the owner to restore the proxy before further model requests.
- [ ] Separately authorized fresh autonomous Factorio run.
- [ ] Owner-client multiplayer join/leave gate.

Earlier isolated real-engine crafting, native research, placement/smelting, restart, persistence and death-recovery evidence remains in the preceding repair checkpoint. No source gate or planning probe establishes autonomous green-science success. Historical desync attribution remains unconfirmed.

The reconciliation itself makes no gameplay interventions and does not deploy to the running server or update the owner's client mods. Live Luna planning probes were separately authorized by the owner after the Docker suite passed; their prompts, raw model decisions and deterministic validation results will be recorded independently.
