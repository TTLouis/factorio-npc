# Run C static follow-up — October 13, 2026

This continues [Claude's live run C](LUNA_GPT6_PROXY_LIVE_RUN_C_2026-10-13.md). The historical run record is unchanged. These are static repairs, not evidence that Luna has achieved green science.

## Completed checklist

| Unit | Owner | Commit / merge | Status |
|---|---|---|---|
| 6: raw-material acquisition facts | Codex, continuing Claude's unfinished unit 6 draft | `ab2290f3` / `015c2ab3` | Independently reviewed; full static gate passed |
| Rejected-blocker recovery and run-check | Codex | `fdb55d72` / `b974dc97` | Independently reviewed; combined static gate passed |
| Installer repin | Codex integrator | `473327a0`, payload ref `b974dc977c4834d9ca39cb13217e3563bfb152fa` | Generated artifacts checked; 9 payload tests passed |

Integration is in the existing `peaceful-saha-a52c6f` worktree on `og-port-integration`, targeting `origin/experiment/jev-agent-architecture`. Unit 4's separate unfinished worktree was not modified.

## Behavior

- Native recipe details report the resource prototypes whose mining yields the queried material even when recycling or crushing recipes also produce it. Exact recipe queries are tracked separately from incidental products, so a cached multi-output crushing recipe cannot suppress copper's mining metadata.
- Raw materials stop recipe expansion and their producer recipes are omitted from this mining-oriented executor brief. Fresh residual shortages receive up to three distinct native resource searches, each bounded to 1,024 tiles and one result, under actor/epoch fences. Held material and in-flight batches spend no source searches. The hints describe observations; reachability and path safety remain unverified.
- Source results distinguish found, no source within the full radius, failed read, and not read. Locations are re-read rather than cached. Acquisition gets a separate bounded packet record so a long lab recipe chain cannot consume its entire text allowance. Recipe-prefetch fence rollback restores all related caches.
- A rejected model blocker no longer becomes `recoverable_provider_failure:provider_reported_blocker`. The controller first uses its existing durable one-per-goal fresh-context recovery allowance. The committed plan and verified prefix are retained; assessment-only work keeps planner ownership. A successful recovery can admit an action. Unavailable or exhausted recovery raises `provider_action_omission_repair_failed: unverified_blocker_recovery_exhausted`; the existing controller-failure policy still applies. This does not promise endless autonomous retries or prohibit legitimate exhaustion pauses.
- Outcome authority rejects attempts to relabel `provider_reported_blocker` as a provider failure. `run-check` detects the correlated rejected-world-blocker → validated-provider-failure → paused-terminal chain within one request and actor/epoch. The retained run C fixture contains only allowlisted structural fields, without provider endpoints or credentials.
- New trace events: `context.raw_leaf_acquisition` and `recovery.unverified_blocker`, both carrying request IDs and reasons and asserted by tests.

## Verification

At the combined code checkpoint `b974dc97`, with the payload repin applied:

- `bash scripts/test-local.sh all` in Docker: exit 0; 2,129 runtime/staging tests and 1,105 mod tests across 124 files passed. Typecheck, Lua compilation, and generated-Lua checks passed.
- Payload `--check` and `build-payload.test.mjs` using the canonical runtime mounts in Docker: exit 0; 9 tests passed. Payload source SHA-256 remains `e11c66c75c9c6b3421bbfa5aaa2939ce9fbad7ef5ea516e6162a06e7f7da2ca2` because the installer source did not change.
- The revised checker scanned the original run C behavior log: 1 request, 99 rows, 1 `rejected_blocker_pause` finding at `2026-10-13T03:27:16.465Z`. Exit 1 is the expected finding status. The old checker reported no known signatures.
- Static scenarios cover the starter inventory, copper-source discovery beyond the empty local radius, realistic recipe-detail size, collateral recipe products, failed/empty reads, actor changes, bounded searches, in-flight work, separate acquisition packet rendering, recovery success/exhaustion, and preservation of assessment ownership.
- Independent review found no remaining merge-blocking issues. No real provider/Jev calls, real-engine gameplay run, server deployment, or gameplay correction was performed.

Local gate logs: `test-run-c-integration.log` and `test-run-c-payload.log` in the integration worktree (not committed).

## Remaining work

1. Review and finish unit 4 dependency-aware batch stock accounting in its existing worktree; do not overwrite its unfinished changes.
2. Finish unit 5's exact-layout powered-lab/research-progress fixture before the next green-science live attempt.
3. Run C finding 3 is mitigated for raw-resource discovery by harness facts, but the general four-read executor observation policy is unchanged. Revisit it with a fixture requiring missing non-resource facts rather than raising every budget indiscriminately.
4. Run C finding 4 is addressed for mined raw leaves; general surface/expansion-aware recipe eligibility remains open. The new mining brief is not a complete recipe-route selector for Space Age or modded worlds.
5. The next live run remains gated by the owner's per-run go or the documented standing allowance, after the outstanding static/engine prerequisites. Static success is not a green-science capability claim.
