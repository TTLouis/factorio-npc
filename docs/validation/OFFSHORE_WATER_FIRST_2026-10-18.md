# Offshore pump water-first candidate enforcement — 2026-10-18

Owner request: close Run Y's generic offshore-pump placement bypass, discover water before looking for pump locations, and inspect recoverable landfill/native super-force preparation hints.

Source: integration `250dc81d` (production `957ebedf`). Task: fix/offshore-water-first, owned by /root session01a14afd; shared task checkout under workspace .worktrees. Run Y's sealed evidence remains unchanged. No live inference is authorized by this implementation task.

## Behavior and invariants

- Native offshore-pump prototype type requires place_candidate with exact stored registry identity; generic place_entity is refused with or without coordinates. Candidate proof is checked at submission and again at physical execution, including actor, surface, force, expiry, geometry and live manual placement legality.
- Generic placement planning, raw construction plans and remote ghost preparation/staging cannot bypass the candidate requirement. Other entity types retain their existing routes.
- Pump candidate scans require a recent successful native fluid observation scoped to canonical actor, force, surface and 3,600 native ticks. Without it, water_search_required returns before placement scanning. Without exposed source samples, water_source_not_exposed returns covered-water/exploration hints without a scan. Omitted center uses the nearest returned exposed source sample; returned samples remain bounded and may be truncated.
- Water observations include bounded hidden/double-hidden fluid hints under native minable cover. They are separate from exposed water and never authorize placement or terrain mutation. Pump observations expose at most 8 native tile-buildability rules and 16 collision layers per mask, explicitly north-unrotated and not placement authority.
- Native super-force build stages a pump ghost and landfill deconstruction proxy. Ordinary manual placement may remain false until terrain removal; hidden source-fluid information is not proof of build legality. This task adds no production terrain-mutation operation.
- A fresh native water_search_required refusal can use the existing single targeted water fact when ordinary observations are closed. The existing ledger, campaign cap and recovery counters remain in force; no additional allowance is introduced. The bounded fluid parsing envelope is 8 KiB to retain the additional covered-water facts; provider and observation call budgets are unchanged.
- New request-correlated events: observation.pump_water_prerequisite and operations.pump_candidate_required.

## Validation checklist

- [x] Independent initial and updated code review; bypass findings addressed.
- [x] Factorio 2.0.77 native API probes distinguish ordinary placement from super-force blueprint staging; preserved under ignored task evidence.
- [x] Candidate runtime gate: 2,538 tests; mod gate: 1,202 tests, typecheck and generated Lua checks. The subsequent missing-center regression passed in its 13-test focused suite; merged full gate remains required.
- [x] All 25 native lane scopes covered: 23 passed in the first matrix; targeted-water and shoreline-recovery then passed with offshore-water-first in a three-lane rerun after correcting the no-scan recovery edge case. The unchanged original native image fails the new water-first assertion as expected. Both matrices also ran the 92 Python regressions.
- [ ] Installer payload repin and merged gates.
- [ ] Owned-resource cleanup and integration.

Final results and immutable candidate commits will be recorded here after validation.


## Native findings and evidence

The first broad matrix caught a missing-center access in the new prerequisite recovery path. A prerequisite refusal truthfully has no scanned center. The correction now uses water-only evidence and preserves the existing single-read/campaign ledger. A named serialized regression covers this case. The shoreline native fixture likewise asserts water-only correction rather than fabricating an empty pump scan.

- `test-results/offshore-native-matrix/`: first full matrix, 23 pass / 2 fail; all failure logs retained.
- `test-results/offshore-native-rechecked/`: corrected targeted-water, shoreline-recovery and offshore-water-first, exit0.
- `test-results/offshore-original-control/`: original native code, expected exit1 at the missing water-first guard.
- `test-results/offshore-water-first-native/attempt8/`: successful focused native pipeline and super-force staging proof; earlier failed probe/setup attempts preserved.
- `test-results/offshore-water-superforce-probe/`: native build modes and prototype tile-rule evidence.

The native super-force blueprint produced a pump ghost and six deconstructible tile proxies for the fixture, leaving the covered water marked for deconstruction. Direct character `mine_tile` returned false even after marking, with unchanged tile/inventory. Autonomous landfill removal is therefore not proven or implemented. A separately declared exposed-water fixture proves subsequent fresh water reads, candidate lookup and real pump construction; it is not reported as autonomous removal.

Candidate lint passes with this checkout's ESLint configuration. The first lint invocation used a stale cached-image configuration; the corrected invocation mounts the current configuration. No lint rule was weakened. Prompt fingerprints changed only for the intentional tool/recovery guidance; healthy trace ordering and message counts remain equal.
