# External harness experimental operator — October 30, 2026

## Scope and identity

Problem: the desktop `/operate` prototype reports HTTP 202 admission, not exact
native completion, and lacks an interruption-safe external-agent protocol.

Local branch: `experiment/external-harness-mcp`.
Source: `1ec2b1980f09788971d4cd9712ece73a1a30da28`, from
`experiment/jev-agent-architecture` in `TTLouis/factorio-npc`.
The delivered source is this base plus the accompanying patch, not a published
commit. No push, deployment, user-computer access or live-world change occurred.

Outcome: an opt-in three-layer experiment. External Codex/Claude plus an Agent
Skill owns planning. Local stdio MCP owns bounded contextual access. The
provider-free execution adapter reuses deterministic policy, native v2 admission
and exact receipt reconciliation. Autonomous entrypoints remain separate.

Implemented operations: walk, wait, craft, mine known resources, exact item
transfer and restricted placement of stone furnaces, burner mining drills and
wooden chests. Placement requires an exact-grid clear nonfluid footprint and an
execution-time no-clearance flag. Unsupported capabilities remain unavailable.

## Acceptance evidence

- Write-ahead durable request identity precedes mutation. Identical requests,
  lost acknowledgements and reconnects do not replay an operation.
- Actor/epoch/session/surface/native-journal fences and exact cancellation are
  enforced by deterministic code rather than the skill's prose.
- Admission remains running until exact native receipt evidence. Historical
  execution is separate from current reconciliation and overall goal proof.
- Restored in-flight state contradicting an old completion creates a durable
  scheduling fence. Lower native tick or journal high-water is refused.
- Negative walk coordinates are parenthesized Lua operands, not `--` comments.
- Context is compact; detailed observations and their schemas are on demand.
- MCP framing, argument validation, bounded waiting, cancellation interleaving,
  duplicate IDs, restart, journal locks and mock RCON exchange have regressions.
- Native `place_entity` forwards the optional no-clearance flag into the existing
  placement controller. Omitted flags retain existing autonomous behavior.

## Final verification

Environment: independent Linux cloud checkout, Node **24.22.1**, pinned pnpm
**10.30.1** selected with `corepack pnpm`. The existing package-manager cache
needed `COREPACK_HOME` set to its workspace location after environment recovery.
Initial cache-location failures are retained separately from the successful
reruns in `evidence/final/bootstrap-failure/`.

Commands and their actual exit codes are supplied in `evidence/final/` in the
handoff ZIP. Executed against the final implementation on October 30, 2026:

| Check | Result |
| --- | --- |
| `node --test tools/external-harness/*.test.mjs` | **71 passed**, exit 0 |
| Scoped ESLint on external harness and changed/new Autorio source | **Passed**, exit 0 |
| `pnpm run test --run` | Agent **104 passed**; Autorio **1,697 passed**, exit 0 |
| `pnpm run build` | **Passed**, exit 0 |
| `pnpm run typecheck` | **Passed**, exit 0 |
| `pnpm --filter autorio.ts run check:lua` | **Passed**, exit 0 |
| Staging and runtime-v8 Node test suites | **4,368 passed**, exit 0 |
| Guarded-source preparation in a disposable copy | **Passed**, exit 0 |
| Guarded mod typecheck, Lua build and generated-Lua check | **Passed**, each exit 0 |
| Relative links in changed/new operator documentation | **Passed** |
| `git diff --check` | **Passed**, exit 0 |
| `pnpm run lint` across repository | **Failed**: 15 errors and 10 warnings, exit 1; every reported file is byte-identical to base |
| `bash scripts/test-local.sh all` | **Blocked**: Docker not installed, exit 127 at tooling lane; not a full offline-gate pass |
| Real Factorio engine / native gameplay lanes | **Not run**; executable download/run authorization remained pending |
| Real Codex or Claude client + game end-to-end run | **Not run** |
| Hosted GitHub Actions / release package gate | **Not run**; nothing published |

The repository-wide lint findings were not silently fixed outside this bounded
change. `lint-baseline-check.log` records the byte-identical base-file comparison.
Independent read-only review found no confirmed actionable defect in this diff
and independently passed all 71 focused tests. Its review remains static/mock
validation, not native-engine proof.

The documented source-preparer + guarded mod build was exercised without
launching Factorio. Build outputs were isolated from the delivered clean source.
This proves compilation and setup compatibility, not gameplay correctness.

## Remaining validation and promotion boundary

This is an **experimental source handoff**, not a production-promoted release.
No model-provider calls were made. No Factorio executable, credentials, saves,
runtime ledger, dependency tree or generated mod build is included.

Before native use, follow `docs/EXTERNAL_HARNESS.md` in an isolated authorized
Factorio 2.0.77 save. Retain native evidence for gather → craft → place → verify,
interruption/resume, partial results, cancellation, restored-save fences and a
blocker appearing after placement admission. Verify native output and inventory,
not just successful tool admission. Then test the real external MCP client.

The existing deployment payload pins and installers are not promoted by this
experiment; use the documented source-build path. A release requires the
repository's payload repin, native lanes and full promotion gates. Preserve
existing deployment/save/configuration until those checks are complete.

Excluded: advanced fluid preservation, composite construction, combat,
autonomous task execution and multi-controller coordination. No automatic
controller takeover or reconciliation override is provided.
