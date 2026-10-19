# Run AD observation gaps: offline correction

Owner: Codex /root session01a153de. Task `fix/direct-feed-observation-gaps`,
source `053518b8293695faa104d7f76d1b015aecf2d898`.

Run AD reopened provider reads but rejected a typed nearby-world observation
through the closed-round whitelist. After planner review and successful furnace
recovery, research-only predicted coverage again closed reads before placement
geometry was obtained. The requested outcome is ordinary bounded access to
resource/coverage/output-placement facts and continued direct-feed execution.
No new live provider/Jev trial is authorized by this task.

Acceptance requirements:

- Open typed controls use the same approved tool names, argument validation,
  cache, relevance tiers, budget and actor/epoch/cancellation fences as direct
  calls. Closed controls retain their narrower whitelist and durable allowance.
- Research/inventory-only predicted coverage cannot close the read phase of an
  active explicit direct-feed brief. Fresh read budgets, plan authority, review
  allowance and operation admission stay authoritative.
- Scripted full-loop regression obtains native-shaped resource and drill/furnace
  placement facts, admits the direct-feed placements across completion receipts,
  and continues on the same committed step. Original-code negative controls fail.
- Focused/full Docker, payload/lint and a deterministic native canary pass;
  independent review and validated local integration precede another E2E.

Progress:

- [x] Inspect exact Run AD traces and isolate both failures.
- [x] Implement channel and coverage corrections with full-loop regressions.
- [x] Validate candidate and original-code controls offline.
- [ ] Independent review, integration and merged validation.

## Implementation and evidence

The typed observation envelope is parsed independently of read-phase permission.
Open requests validate against the ordinary observation catalog and normal
argument renderers, then enter the existing cache/budget/fence pipeline. The
provider schema advertises that catalog; closed requests still pass the strict
targeted grammar, grounding checks and durable allowance. Gameplay/control tool
names, malformed arguments, mixed operations and stale identities are refused.

An active executor brief explicitly selecting `materialSupply.mode:direct_feed`
keeps ordinary reads open after predicted-family coverage. Research/inventory
coverage cannot establish drill resource coverage or output alignment, which
require model-selected arguments. This does not add read slots or reset budgets:
the regression uses one fresh read per native completion decision and proves the
next provider request closes normally once that read is spent. Other covered
briefs retain their optimization. Trace `observation.phase_kept_open` records
request/plan/step, resource, reason and remaining budget.

- Final Docker gate: **2,655 runtime / 1,234 mod tests**, typecheck and Lua checks
  passed, without snapshot update mode. The intentional provider schema/guidance
  change updates only request-body fingerprints in the restage golden; context,
  message counts and behavior trace fingerprints remain unchanged.
- Original `053518b8` runtime fails all eight new open-channel/schema/full-loop
  regressions. Restoring only its coverage method fails the full-loop placement
  continuation, independently of the channel fix.
- New native lane `direct-feed-observation`, exact Factorio **2.0.77**: the real
  Session and provider serializer, scripted planner/executor replies, native
  resource observations and candidate-based admission placed the drill and an
  output-covering furnace. Native machines produced **two iron plates**; the
  actor collected one and the goal verified complete. The active step's meaning
  was checked after each preceding receipt, then the verified goal retired its
  plan. Only admitted operations changed gameplay after declared fixture setup;
  no hand-mined or hand-delivered iron ore, forced completion or external
  inference occurred. Existing `normal-observation` native canary also passed.
- The same native lane with exact original runtime fails on the typed discovery
  refusal. Failure evidence is preserved separately from successful evidence.
- New placement-channel actor/epoch/cancellation/read-failure cases pass alongside
  existing closed allowance, cache, bounded recovery and role-authority controls.

Evidence is retained in `test-results/direct-feed-observation-gaps`, including
`native-pass/lanes/direct-feed-observation/results/direct-feed-observation-proof.json`,
the original-code controls, full gate logs and the native image build log.
The native lane is registered in the runner and CI. Live autonomous selection of
the right placement observations remains a separate E2E question; this task
validates capability and continuation offline and does not run another trial.
