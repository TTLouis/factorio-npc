# Luna planner-first delegation — October 6, 2026

The owner selected Luna planner → Luna executor for one NPC. This extends the existing C3 delegation boundary; it does not add NPCs or change model routing. With one configured Luna model, both roles use that model in separate contexts.

## Behavior and authority

A new protocol-v2 planner decision may declare a nonempty plan, aligned supported `stepCompletions`, `currentStep: 0`, and `operations: []`. The harness grounds and validates the completion declarations before recording and committing the draft. The commit records `runtime_validation.scope: completion_contracts`; it does not claim an operation preflight or successful world mutation. No batch, receipt or completed step is invented.

C3 then parks the planner and builds a fresh executor context with the immutable plan, active step, actor identity and current facts. The executor selects the first actions. Their preflight, operation authority, stock protection, duplicate-effect checks and admission fences remain required. Receipt predicates may name approved future operations at the draft boundary; a named operation is not evidence that it ran.

Eligibility excludes committed plans, replacements, pending amendments, explicit blockers, semantic completion claims, active repairs, non-idle actors and pending/in-flight operations. Legacy and action-bearing decisions retain their previous paths. Disabling executor handoff retains the existing bounded initial-action repair. If the initial handoff fails, the goal and committed semantics are retained with zero progress and a truthful pause; no planner retry loop is created.

Fresh chat lineages and restaged planner contexts receive the same delegation guidance. The executor retains its separate immutable-plan role instructions. No output allowance or budget generation resets at C3.

## Verification

Seven new scripted runtime regressions exercise the actual request/provider/commit path:

- Initial plan-only commitment, fresh executor ownership, parked planner, zero initial admissions, immutable IDs/contracts through memory restore, and output accounting of 100 → 200 units within generation 1.
- Deferred approved receipt contract, including a root checkpoint, without synthetic completion.
- Missing declarations corrected before commitment.
- Executor preflight refusal after commitment, admitting no gameplay.
- Disabled handoff retaining bounded initial-action repair.
- Failed handoff retaining the unfinished goal and returning a truthful pause.
- Actor/epoch replacement refusing the executor's first admission.

The unit worktree's official Docker `all` gate passed 1,811 runtime tests and 1,036 mod tests, plus typechecks, TSTL and generated-Lua checks. After adding the accounting, initial-prefix and stale-actor assertions, the runtime gate passed 1,812/1,812. The planning probe's four scripted cases also passed, with zero HTTP calls, Jev calls, game connections or admissions. An independent read-only review checked planning authority, identity fences, restart state and accounting.

The probe's first-case instruction and validation now permit a valid plan-only delegation. Earlier captured Luna replies and their historical outcomes remain unchanged. This is a new contract, not a retroactive successful live run. The probe is an isolated declaration/tracker test; the new runtime regressions separately prove the executor handoff and admission path.

## Build checkpoint

| Unit | Owner | State |
|---|---|---|
| Planner-only admission and C3 handoff | Integration owner | Implemented; scripted gates green |
| Independent invariant review | Separate read-only reviewer | No remaining merge blocker |
| Updated planning probe | Integration owner | 4/4 offline samples green |
| Integration merge, installer repin and final Docker gates | Integration owner | Required before publication; recorded in the current status document |
| Real Luna planning or gameplay follow-up | Owner-authorized live trial | Not run in this checkpoint |

Local evidence is retained under `test-results/luna-system-fixes-2026-10-06/planner-first/` after integration. Autonomous green research and multiplayer acceptance remain open. This change supplies no gameplay walkthrough or operator-authored actions to Luna.
