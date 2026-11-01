# NPC Provider Continuation and Recovery

Status: active implementation contract for `feat/npc-transition-work`.

This document records the provider failure mode observed in the September 17 prompt/behavior traces and defines the intended runtime behavior before further prompt/runtime changes.

## Observed failure

A successful Autorio placement batch completed, but the follow-up provider turn exhausted its output budget in reasoning and produced no visible JSON/tool call. The harness then entered generic recovery with tools disabled. The model correctly needed a fresh observation to discover the newly created entity identity/geometry, but recovery could no longer call tools, so it returned `operations: []`. The durable plan layer then classified that no-op as a blocker even though the Factorio operation itself had succeeded.

The failure is therefore provider orchestration, not deterministic Factorio placement failure.

## Required policy

### 1. Disable reasoning on successful batch continuation when the provider supports it

Successful `[MOD] Autorio operation batch completed.` continuation is a constrained state-transition step. It normally needs to read the receipt/Task Board, optionally make one or more bounded tool observations, and return strict JSON. It should not spend a large hidden reasoning budget.

For the official DeepSeek OpenAI-compatible Chat Completions API, send:

```json
{"thinking":{"type":"disabled"}}
```

on successful completion continuations and their output-budget recovery attempts. The official DeepSeek API documents `thinking.type = disabled` / `reasoning_effort = none` as disabling thinking mode.

Do not send provider-specific reasoning controls to unknown OpenAI-compatible providers. Provider capability detection must be conservative.

If thinking cannot be disabled for the configured provider, use a larger continuation output cap instead of assuming the current small cap is sufficient.

### 2. Treat empty `finish_reason=length` as output-budget exhaustion

`finish_reason=length` with no visible content and no tool calls is not a semantic/JSON mistake. Classify it separately as output-budget exhaustion.

A retry for this case must:

- remain compact;
- preserve tool availability when the failed turn had tools available;
- avoid turning a missing visible answer into a fake semantic blocker;
- use a larger bounded output budget if reasoning could not be disabled.

### 3. Recovery must not always disable tools

Generic invalid-JSON/tool-loop recovery may still use a no-tools strict-JSON path when the model already has every fact needed to finish the decision.

However, output-budget exhaustion during a continuation is different. If the next correct action may require an observation (for example, resolving the unit number of an entity created by the previous successful batch), the first recovery attempt must keep tools enabled.

Only transition to no-tools recovery after a real tool/format failure or after the harness has enough state to demand a strict final plan without further observation.

### 4. Candidate placement is a tool/operation contract

The deterministic placement engine is authoritative for resource coverage, output geometry, fluid ports, shoreline-sensitive placement, and live revalidation.

If `getPlacementCandidates` is advertised, the same composed provider contract must also advertise/accept the matching `place_candidate {candidate_set_id,candidate_id}` operation. The prompt must not tell the model to retype coordinates from a returned placement candidate.

`place_entity` remains a low-level operation for cases where exact coordinates are independently known; it is not the preferred resource-bound/miner semantic placement path.

### 5. `operations: []` is not automatically a world blocker

An empty operation list after a provider orchestration failure must not become `no_autorio_operation_for_remaining_plan` merely because recovery removed the observation tool the model needed.

The harness should distinguish:

- verified goal completion;
- healthy persistent runtime mode;
- explicit human/action blocker;
- provider/recovery failure;
- model no-op with unresolved work.

Provider/recovery failure should be reported as such and must not be persisted as semantic Factorio evidence.

### 6. Strict recovery cannot author a semantic world blocker

Generic strict recovery is entered because the provider failed a response/protocol contract such as invalid JSON. Its no-tools sandbox is an orchestration constraint, not Factorio evidence.

If canonical work remains and a strict-recovery answer has no executable operation, the runtime must not persist `BLOCKED` merely because that recovery turn cannot observe again. Even an explicit `BLOCKED:` response from that strict-recovery call is treated as an unresolved provider failure rather than durable world truth.

The request should fail upward. When authoritative Autorio state is `idle` with an empty queue, the supervisor pauses the durable task while preserving the verified Task Board prefix. A later Continue/resume starts a fresh tool-capable planner turn from that verified state.

Normal planner turns may still report a truthful explicit blocker when grounded evidence establishes a real world/human/capability condition.

## Calculated / condition-based waits (machine steps: plan 2.5)

Machine waits are now calculated by the runtime from game data
(`deploy/pterodactyl/runtime-v8/production-wait.mjs`,
`packages/autorio/src/production_eta.ts`):

- each condition answer for a crafting machine carries its expectation: seconds per craft (recipe energy / live crafting speed, modules and beacons included), crafts still needed, seconds to the checkpoint, seconds until the loaded inputs or fuel run out, and what limits it (`inputs`, `fuel`, `power`, `output_full`);
- the condition wait takes its wake deadline from that expectation (expected x 1.5 + 30 s, at most 2 h) and a check budget that cannot end it first; later answers only refresh the expected finish. A passive wait may be lengthened, never shortened, since a fed machine outlives its loaded inputs;
- when the planner returns no operations while the active step's single checkpoint is an output count on a machine observed working, the runtime holds a completion wait on that checkpoint instead of a guessed `wait {ticks}`; the step closes only when the checkpoint holds;
- the planner wakes early when the machine stops, and on overrun with `expected_seconds` and `elapsed_seconds` in the recovery details;
- elapsed time is never proof of production. Engine lane: `tests/factorio/runner/machine_eta_cell.py`.

Still planner-selected: a `wait {ticks}` operation in a batch, and waits with no machine expectation (hand work, research, several requirements); those keep the bounded defaults.

## Budget strategy

Preferred order for successful completion continuation:

1. compact continuation prompt/context;
2. disable reasoning when the provider explicitly supports it;
3. keep the normal bounded tool set available;
4. use the compact continuation output cap;
5. if the provider cannot disable reasoning, raise the continuation cap to a bounded fallback;
6. if a response still ends `length` with empty visible content, perform one tool-capable output-budget recovery with the larger cap before generic recovery.

This policy is intentionally different from ordinary user-request turns, where reasoning may still be useful.

## Validation requirements

Unit/contract tests should cover:

- DeepSeek official endpoint completion requests include `thinking.type=disabled`;
- unknown/OpenAI-compatible endpoints do not receive DeepSeek-only request fields;
- normal request turns do not have reasoning disabled by this continuation policy;
- continuation output-budget exhaustion is distinguished from malformed JSON;
- the first output-budget recovery retains tools;
- the fallback continuation token cap is larger when reasoning cannot be disabled;
- `getPlacementCandidates` and `place_candidate` are advertised together;
- a provider output-budget failure does not get persisted as a Factorio semantic blocker.

## CI scope

Keep these checks in the existing lightweight Node/Vitest/Pterodactyl contract suites. Do not add full Factorio headless E2E to default CI. Real miner/chest/offshore-pump semantic placement remains a separate on-demand/nightly E2E lane.
