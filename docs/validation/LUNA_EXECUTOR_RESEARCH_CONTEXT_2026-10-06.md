# Executor research context repair — October 6, 2026

## Result

The owner authorized repairs after the planner-first live failure. The harness now derives research subjects from the active committed completion contract, reads their authoritative paths before briefing the executor, and includes their trigger/science item subjects in the bounded inventory shortlist. Initial C3 delegation starts a new bounded observation decision without resetting the provider/campaign allowance. The captured blocker remains a failure in replay; a corrected scripted executor response proves admission using the supplied facts. No live providers, gameplay or production deployment occurred.

Unit `15d15b21`, integration merge `c0511b0194e55f68d0745c01ac6ba034d6dc9b3f`, installer repin `c66f3a16`. Independent read-only review found one supersession race; the fix and regression were reviewed with no remaining merge blocker.

## Behavioral changes

- `stepContractNeeds` names technology subjects for every `research_completed` requirement, including alternatives, without choosing an alternative or inventing intended item quantities.
- Each handoff reads at most four research targets with at most eight nodes per path through the existing approved `getResearchPath` command. Actor/epoch fences surround reads; existing goal/plan/step guards protect the assembled context. Research facts are rebuilt from durable contract subjects, not conversation caches.
- Whole research-path records retain exact engine trigger/science data, including the returned quantities. Missing, wrong-target, malformed, incomplete and oversized answers are explicitly unavailable. Required research coverage records survive packet trimming; an oversized mandatory packet remains a truthful restage refusal. No partial path is labeled complete.
- Research-trigger items and science ingredients are refreshed ahead of unrelated cached items within the existing 12-item cap. Facts supply observations; Luna still chooses the intended actions, quantities and production method.
- In-flight work defers research reads alongside inventory/machine facts. The correlated-receipt refresh rebuilds current research and inventory facts rather than preserving stale in-flight assertions.
- Successful initial planner-to-executor C3 starts four fresh observation slots, clears exhausted decision state and previous family restrictions, and emits `context.executor_observation_started` with request identity and reason. Other context compactions do not receive this allowance reset. Shared provider generation/output accounting remains unchanged.
- The reset is guarded by captured generation, lineage, actor/epoch, active role/handoff, canonical goal, plan/version and step identity immediately before synchronous writes. Request-level observation-scope restoration also checks generation/lineage, so a superseded request cannot overwrite a newer lineage's allowance.
- `context.executor_facts_carried` now reports current research-path coverage and missing subjects. The observational log checker reports `executor_research_facts_missing` for a paused research step whose executor lacked coverage. Legacy traces without the new metadata are labeled explicitly; the detector does not claim every research pause is a context failure.

## Regression and acceptance evidence

Eleven new regressions cover the retained blocker, corrected continuation through real loop admission, bounded observation reset and unchanged output accounting, unavailable facts, actor replacement during reads, cache-independent restoration, in-flight deferral/refresh and scan limits, supersession during awaited handoff work, research-subject extraction, malformed/oversized paths, mandatory packet records and the retained trace diagnostic.

The captured final planner reply, executor blocker, authoritative research path and executor messages are stored in `fixtures/luna-research-handoff-2026-10-06.json`. The 65-row behavior trace is retained in `fixtures/run-check/luna-research-handoff-paused.jsonl`. Replaying the unchanged blocker still pauses with zero gameplay and zero completed steps; it does not become a retroactive autonomous success. The corrected scripted reply sees the exact ten-copper-plate/fifty-iron-plate triggers and current counts, then proposes a native gathering operation through ordinary preflight/admission. Research and goal completion remain unmet.

Both the unit and final integration official Docker all gates passed: **1,823 runtime tests**, **1,036 mod tests across 120 files**, typechecks, TSTL build and generated-Lua checks. The integration full Docker build exited 0. Nine installer payload tests passed. Payload source pins merge `c0511b0194e55f68d0745c01ac6ba034d6dc9b3f`; installer source SHA256 remains `ef8d9447c44009365022fac9dca158c0db8b622a229626e60bebcb1191586de5`.

Running the upgraded checker against the original live evidence returns the expected one missing-research finding, zero parse errors; exit 1 is the expected diagnostic result, not a failing test gate. Historical validation records remain unchanged.

Local ignored evidence is retained under `test-results/executor-research-context-*`: unit runtime/gate logs, `unit-green.log`, `integration-all.log`, `full-build.log`, `payload.log` and `retained-check.json`. The last account usage read at integration was 7% weekly used; this is an account snapshot, not a measurement of this unit's model cost. No main-provider or Jev calls were made for this repair.

## Remaining gates

This unit fixes the reproduced research handoff and observation-lifecycle failure. Broader schema consolidation and typed recovery classification for other missing-fact/blocker families remain further work. An explicit model BLOCKED reply still pauses truthfully; the harness does not infer a corrective gameplay sequence from its prose. Fresh autonomous red-to-green gameplay, repeatability, automated science production and the separate multiplayer acceptance cases remain unproved. A new live run needs its own owner authorization and pinned local deployment verification.
