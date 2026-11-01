# Cloud CI health pass — October 15, 2026 (Toronto)

## Scope and baseline

Reviewed `experiment/jev-agent-architecture` at `138c0ce635cf6aae83611e4ec31469c2d411a68c`. This is a cloud-only CI and offline regression cleanup. It does not establish autonomous factory reliability or completion of a gameplay milestone.

The baseline GitHub run was [38827379440](https://github.com/TTLouis/factorio-npc/actions/runs/38827379440): runtime tests passed, TypeScript quality stopped at lint, and the native planning lifecycle scenario failed. A separate local run exposed a contract-parity test hidden behind the lint failure.

## Changes

1. **Contract inventory:** include the existing `getFluidSourceTiles` tool in the explicit runtime-v8-only inventory in the ordinary-agent parity test. No tool capability or permissions are added.
2. **Lint cleanup:** unused bindings/imports, duplicate imports, declaration layout, noncapturing regular-expression groups, fixture callbacks, and documentation. Node-only engine runners now use the same Node global/console policy as other CLIs and may use top-level await. Fixture closures may reference outer setup variables initialized before invocation; same-scope temporal-dead-zone checks remain enabled. Production safety rules are not disabled.
3. **Parser maintenance:** rewrite two overlapping whitespace quantifiers in DSML diagnostics and reserve-command parsing without changing their accepted syntax. Add whitespace/punctuation/long near-match regressions. Keep unknown operation names as raw data in the recovery fixture parser, including names inherited by ordinary JavaScript objects.
4. **CI visibility:** lint, unit tests, and TypeScript/build checks run independently. The existing `typescript-quality` job name remains as an aggregate that fails unless all three succeed, preserving the old check's meaning for any branch protection referencing it. CI uses Node 24 and frozen installs. Unit tests explicitly run once rather than depending on CI watch-mode detection.
5. **Native lifecycle candidate:** replace the invented-resource structural-blocker premise with a real disabled recipe on the fixture NPC's force. Retain committed-plan identity, frozen status, no automatic successor, restart, explicit revision, successor lineage, and reasoning-epoch assertions. Also assert durable guard pause and unchanged iron inventory, then restore the recipe setting. Do not change production refusal classification or simply change `blocked` to `paused`.

## Verification boundary

Final offline run: Node v24.19.0, repository-pinned pnpm 10.30.1. All commands below exited zero:

| Gate | Result |
| --- | --- |
| `pnpm run lint` | Pass; 0 errors, 0 warnings |
| Runtime + staging `node --test` | 2,468 passed; 0 failed, skipped or cancelled |
| `pnpm run test --run` — ordinary agent | 102 passed across 19 files |
| `pnpm run test --run` — Autorio | 1,144 passed across 128 files |
| `pnpm run build` and `pnpm run typecheck` | Pass |
| Generated-Lua semantic check | Pass |
| Isolated deployment-guard preparation, `tsc --noEmit`, `tstl` | Pass |
| Payload consistency / verifier | Pass; 9 verifier tests |
| CI YAML/job structure, native runner syntax, `git diff --check` | Pass |

The checked scope is:

- Lint with zero errors/warnings.
- Runtime/staging Node tests, including recovery, cancellation, stale observations, receipt reconciliation, and bounded-budget suites.
- Ordinary-agent and Autorio unit tests.
- Workspace build/typecheck and generated-Lua semantic check.
- Deployment-guard source preparation, TypeScript check, and Lua build in an isolated copy.
- Generated installer consistency and payload-verifier tests.
- YAML parsing, independent-job/aggregate structure, native runner syntax, and whitespace validation.

The cloud environment has no Docker or LuaJIT executable. The changed real-Factorio lifecycle scenario has **not** been run in the engine here. The LuaJIT bytecode parse and Compose execution checks also remain for CI. No real inference, CLI proxy, Tailscale connection, game server, or deployment was used. Offline successes must not be described as a green GitHub run or live autonomy proof.

The existing Windows `scripts/test-local.sh all` covers runtime and Autorio checks; it does **not** cover the ordinary-agent suite or lint. Do not treat that command alone as complete CI parity.

## System map for continued maintenance

```text
Player goal / supervisor lifecycle
              |
              v
Planning state + canonical task board + durable task/effect ledgers
              |
              v
Planner authors plan and dedicated checkpoint contracts
              |
              v
Executor chooses bounded actions from current observations
              |
              v
Schemas -> validation -> authority/budget/admission -> native Autorio
              |                                          |
              |                                          v
              +---- recovery / next task <- receipts and world evidence

Jev: bounded observation selection, ranking and routing alongside this flow.
It cannot authorize changes, approve correctness, or manufacture completion.
```

- `supervisor.mjs`: lifecycle, input handling, queued work and bounded wake/resume.
- `npc-agent-loop.mjs`: provider turns and orchestration across observation, contracts, admission, execution and recovery. At the baseline it exceeds 16,000 lines; this pass deliberately avoids a broad extraction.
- `planning-state.mjs` / `canonical-task-board-memory.mjs`: immutable plan ownership, reducer state and durable projections.
- `provider.mjs` / `agent-roles.mjs`: transport/capability contracts and planner/executor role configuration. The recently integrated dedicated CLI-proxy profile is retained.
- `structured-policy.mjs`, authorization and allowance modules: bounded language, validation, authority and spending limits.
- `operation-reconciliation.mjs` and effect ledgers: acknowledgements, uncertain effects and replay prevention.
- `packages/autorio`: real Factorio actor, operations, observation, admission journal and execution receipts.
- `packages/agent`: separate ordinary adapter with its own tool-surface contract and tests; it must remain visible in CI.

## Next work after this pass

1. Verify the candidate in GitHub CI after owner-approved push, especially the native lifecycle scenario. If it fails, retain the exact engine evidence and correct the scenario/runtime contract; do not weaken assertions for a green result.
2. Maintain an explicit recovery-loop matrix covering provider response, validation, admission, native execution, receipt, recovery and next-task handoff. Preserve separate ordinary-read and bounded closed-round policies.
3. Only extract orchestration components once their contracts and complete-loop tests are pinned. Avoid broad refactors mixed with gameplay fixes.
4. Settle the gameplay milestone's exact acceptance contract before claiming completion. Natural-resource chain and unattended science throughput still require authorized live evidence.
