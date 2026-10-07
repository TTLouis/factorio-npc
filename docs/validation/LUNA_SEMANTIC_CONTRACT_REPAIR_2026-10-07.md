# Luna semantic-contract boundary repair — October 7, 2026

The failed fresh run at `3278c4b1` committed world-progress work as three semantic assessments. Its executor then proposed mutations and different deterministic contracts. Admission correctly refused those mutations. This repair addresses the earlier draft boundary; it does not rewrite that saved plan or turn the failed trial into success.

## Implemented contracts

- A newly authored execution draft must contain at least one deterministic world-result checkpoint. An all-semantic draft with no operations is refused before commitment with `execution_plan_has_no_world_checkpoint` and a structured correction. Luna still chooses its outcomes, technologies and quantities.
- An intentionally observation-only slice declares the typed `assessmentOnly:true` intent, has only semantic steps and no gameplay operations, and stays with the planner. A conflicting declaration is refused with `assessment_only_conflicts_with_execution`. Both refusals emit `plan.completion_declarations_rejected` with request identity and reason. Executor replies cannot acquire planner authority through this field.
- Prompts and schema descriptions consistently include `research_completed`, future unmet outcomes, and `mode:"all"` for multiple required technologies. Missing current measurements do not turn a world result into an assessment. Closed rounds continue to return JSON control decisions with the existing tool definitions and `tool_choice:none`.
- Frozen committed contracts and legacy draft compatibility are checked before the new admission rule. Semantic closure still requires the exact active step and authoritative grounding. No predicate is inferred from prose or operation counts; no science walkthrough was added.
- The offline checker now reports the narrow `semantic_contract_dead_end` sequence: correlated delegation and executor reply, semantic mutation refusal, then terminal blocker pause without admission, receipt or step progress. Incomplete and mismatched traces do not establish this finding.

## Integration checklist

| Unit | Commit | Review / validation |
| --- | --- | --- |
| Retained failure diagnostic | `a81854af` | Independent review found no blockers; isolated Docker runtime 1,849 passed; merged as `09e94e8b` |
| Draft and protocol boundary | `9921eb4b` | Independent review found no blockers; isolated Docker runtime 1,852 passed; merged as `935250d5` |
| Installer repin | `26ad8871` | Immutable payload ref `935250d5363180301ca93f2c5679bacafcea84e2`; source SHA256 remains `ef8d9447c44009365022fac9dca158c0db8b622a229626e60bebcb1191586de5`; nine Docker payload checks passed |

The combined candidate is `26ad88713a566c6cfcced857c2045854ff478e1f`. Official `scripts/test-local.sh all` passed 1,855 runtime tests, 1,036 mod tests, typechecks, Lua build and generated-Lua checks, with zero TODOs. The full `tests/factorio/Dockerfile` build passed. Its 48 non-test runtime modules match the clean committed source with no mismatches. Compiled control SHA256 is `d9434a7652c9c9cee836d06b96e17065c77d9805be2b479cf31b259ed23c8f17`.

The retained historical trace is unchanged. The persisted planner declarations and captured executor arguments are also retained in the boundary fixture. The original draft is refused without gameplay or commitment; corrected scripted research declarations allow bounded copper gathering while research and the canonical goal remain unfinished. Restoring the actual committed historical assessment retains its contracts and refuses executor mutation. Explicit assessment intent, contradictory declarations and non-boolean control fields are covered. The new assessment case proves planner retention and truthful pause; successful grounded semantic closure uses existing unchanged coverage.

The prompt fingerprint fixture was regenerated because prompt/schema bytes changed. Request-body and provider-request hashes changed; context hashes, message counts, trace event sequence and all other trace hashes remain unchanged.

The freshly built Factorio 2.0.77 image passed isolated `research-combat` and `resilience` lanes, including native lab research, correlated research receipts, owned crafting/cancellation, active-craft restart cancellation and fresh crafting, planning persistence and explicit successor authority after restart. These are deterministic zero-human scenarios, with no real provider calls. The temporary container and world were removed after retaining its results; the image remains available for the next preflight.

## Evidence and remaining acceptance

Evidence is retained locally under `test-results/luna-semantic-contract-2026-10-07/`, with final gate logs named `luna-semantic-{all,payload,build,native}-2026-10-07.log` in `test-results/`. Historical live evidence remains at its original paths. This repair used scripted replies and deterministic game scenarios only: zero real Luna/Jev requests, operator gameplay or production deployment.

Autonomous native red production/consumption and green research remain unproven. A new live trial requires separate per-run owner authorization under `AGENTS.md`. Multiplayer join/desync and repeatability remain separate gates. Account-wide weekly usage was 17% at closeout, against this phase's 19% ceiling and 14% start; other work shares that usage window, so the three-point change cannot all be attributed to this task.
