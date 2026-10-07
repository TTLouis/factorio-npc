# Luna targeted observation recovery — October 7

The owner authorized five additional shared weekly usage points, from 19% to a 24% ceiling, to repair the missing-fact boundary exposed by the preceding fresh-world trial. This phase uses deterministic tests and scripted replies; it does not authorize another live provider run.

## Conflict and evidence

The retained final request from `bea69cbc` supplied a compatible stone furnace, unit 12, and 50 iron ore. Its recipe observation reported `previous_recipe_name:copper-plate` with no current recipe. Luna interpreted that historical hint as a configured copper recipe. The packet also retained a step-one C3 handoff beside authoritative step-two planning state, required fresh mutable facts, and prohibited another observation. No entity-status read had occurred. The explicit blocker bypassed action-omission recovery and truthfully paused the unfinished goal.

The four original final request/reply rows and saved state are retained unchanged as parsed evidence under runtime fixtures `luna-furnace-closed-2026-10-07.jsonl` and `luna-furnace-state-2026-10-07.json`. The original blocker remains a failure: the harness does not infer a read request from its prose. Corrected scripted replies explicitly declare the missing fact and resume the captured goal without rewriting committed contracts or verified history.

## Implemented contract

- A JSON control decision can declare `observationRequest:{stepId,tool,args,rationale}`, with the unchanged plan/currentStep and empty operations. The supported facts are exact `getEntityStatus({unit_number})`, inventory, or research status. Discovery, plan edits and completion claims in the same decision are rejected.
- The harness requires an active frozen plan, exact step identity, a grounded entity identity, idle native execution and no unresolved operation ownership. Actor, epoch, goal, plan, step, receipt, generation and handoff fences protect admission, result publication and post-read accounting.
- One read is allowed until a new correlated operation receipt or active-step change. The claim is persisted before reading; restaging and restart do not refund it. It cannot stack with a consumed closed-round or action-omission observation. The final tools-closed provider decision uses the existing reservation/accounting path.
- Exact entity reads enforce the NPC's force and surface and refuse missing/replaced units. They never substitute a nearer machine. Native furnace recipe and bounded inventory facts are exposed.
- Superseded volatile handoff step facts are removed from provider input while stable committed plan, current planning state, conversation history and allowance remain. Traces record grant/refusal and handoff supersession with request identity and reasons.

This is a generic fact-recovery protocol, not a science walkthrough or harness-authored action. Luna still chooses the next operation and normal preflight/admission validates it.

## Build checklist

| Unit | Commit | Status |
| --- | --- | --- |
| Exact entity observation | `9f7b10de`, merge `e761e28a` | Independently reviewed; native exact furnace scenario passed |
| Typed recovery and handoff conflict | `8c0c1efa`, `64eeb05b`, `9f0414b6`; merge `17990b14` | Independently reviewed; 1,868 runtime regressions passed |
| Installer repin | `61f70f54` | Nine payload checks passed; source pin `17990b1479dd5ab0f9295866a0724388535c228a` |
| Frozen candidate | `61f70f5492e9278dc2f8cc742ab0072d10d3ab9b` | Final integration gates passed; native exact entity/research passed, restart passed on fresh retry |

Review found a post-read supersession race during diagnostic/result-trace awaits. The follow-up fix fences those publication/accounting boundaries. Regressions replace the context at diagnostics, tool calls and result tracing and prove newer messages, facts, cache and observation flags stay unchanged. Other coverage includes stale identities, mixed requests, busy execution, unpersisted claims, restart accounting, receipt renewal and the full scripted closed-round interception path.

The provider-body golden changed only where prompt/schema bytes changed; context hashes, message counts and existing trace sequence remain unchanged.

The final official Docker gate passed 1,868 runtime tests and 1,041 mod tests across 120 files, typechecks, TSTL and generated-Lua checks. The full Docker build and nine payload checks passed. All 45 shipped runtime files in the native test image match the frozen candidate after newline normalization. Compiled `control.lua` SHA256 is `f0c1967b749c68d498e0f3b09fad208f5e54d294dd929ff340b6980e460aeb61`; installer source SHA256 is `36895e95ddb9803369d827bce38fc878e2a58f57a6fc05c8e7c89ce2770470d2`.

Native `entity-observation` and `research-combat` passed on the final image: exact same-name furnace selection, native recipe/output, force/surface/replacement refusal, native lab research and correlated receipts. The first final `resilience` attempt stalled in the test driver's process shutdown after saving its BLOCKED fixture; it is not counted as a pass. Its evidence was retained before removing the container. One isolated fresh-world retry on the unchanged image passed the full lane: planning lineage/frozen BLOCKED restore, explicit successor authority, body replacement, native owned crafting/cancellation, active-craft restart cancellation and fresh post-restart crafting. Cause of the shutdown stall remains unconfirmed; no assertions were weakened or gameplay interventions used to pass it.

Evidence is retained under `test-results/targeted-observation-2026-10-07/`, including the candidate manifest, final gate logs, stalled-attempt logs, successful native lane results and file hashes. Test containers/worlds were discarded after retention. The reusable image remains; no live server was deployed. Shared weekly usage was 21% at closeout, two points above the 19% start and below the 24% ceiling; concurrent unrelated work shares the account.

## Remaining acceptance

Autonomous red production/consumption and completed green-science research remain unproven. A new live Luna run needs per-run owner authorization after the candidate gates and deployment verification. Multiplayer CRC/join reliability, repeatability and automated science production remain separate gates. No live providers, operator gameplay or production deployment occurred in this repair phase.
