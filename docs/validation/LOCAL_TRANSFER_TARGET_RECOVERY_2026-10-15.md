# Run S local transfer target recovery — October 15, 2026

## Problem and scope

Run S (`7ca69aed`) admitted legacy name-based copper-ore and coal transfers. Native `moving_items:no_target` means the local interaction-reach search found no machine. The furnace still existed 39.67 tiles away. The harness froze the semantic step as `transfer_failed:no_target` before the model's final blocked reply. Exact identity resolution was not exercised.

The historical receipt does not prove whole-batch absence: reconciliation correctly retained `admitted_cancelled`, `partial_unknown`, `settled:false`. That evidence is preserved unchanged in the sanitized full-wire fixture and ignored original trial artifacts. Classification and effect settlement are separate decisions.

## Implementation

- Recover only a failed, non-player, legacy `moving_items:no_target` receipt matching the admitted `move_items` intent. Require explicit native refusal flags, matching tick/type/actor, a fresh native actor/epoch, exact admission journal/batch/signature, and the active canonical goal/plan/step. Exact-target, authority and destruction failures retain their existing paths.
- Reuse the same persistent transfer-supply recovery allowance of two. Keep the semantic step, contract and requested result. No automatic travel, extra read, provider call allowance, resume allowance, name substitution or cached-ID authority.
- Tell the model that historical coordinates are travel guidance only. After model-selected travel and its receipt, obtain fresh spatial identity and current counts before proposing exact delivery. Retain original effect uncertainty and replay guards.
- The engine now marks the specific legacy local `no_target` refusal before any inventory access as `failed_before_mutation`. Existing journal reconciliation permits whole-batch absence only when `started_count === 1`. A successful prefix, or the old unproved Run S receipt, retains `partial_unknown`; no reconciler or duplicate-guard relaxation was added.
- Named `transfer.target_recovery` carries `request_id`, operation key, step, reason and the unchanged bound. Existing recovery and reconciliation traces remain authoritative.

Production consists of two runtime modules and `basic_operations.ts`. Installer bootstrap/payload bytes are unchanged.

## Frozen candidates and validation

- Source base: `34e15ae5aca487d02cc873702fe62645e5b38a70`.
- Initial frozen implementation: `818c41b49fa2612c1b714183af4130e8155b60bb`.
- Final code/tests: `6b374d2c1c52b8c9bb453db89c4cdc4837460478`; production is identical to `818c41b4`.
- Official native image: `sha256:888261dd5c0a4867bb20c73931d785e59d003dec39b116fec6de431af67c7259`, built at `6b374d2c`.

Checklist:

- [x] Canonical Docker gate: 2,431 runtime tests, 1,144 mod tests, typecheck, Lua build/generated-Lua checks. The strengthened static prefix fixture passes the same 2,431 runtime tests again.
- [x] Seventeen new static cases: captured Run S receipt/wire and terminal gap; actual Session/role resolver/provider serializer through local refusal, chosen travel, fresh identity and existing one-fact inventory allowance, exact delivery and ten copper/electronics completion; historical unknown and executed movement-prefix replay guards; ten invalid correlation/type/authority cases; persistent bound two; stop/epoch proposal fences.
- [x] Two native-controller unit cases prove no inventory mutation/tail execution on a first local miss and preserve the started count of a completed prefix.
- [x] Read-only original runtime overlays: six new recovery cases fail at the missing recovery boundary; eleven captured-evidence/strict-negative cases pass.
- [x] All twelve existing native canaries pass individually with the changed production controller/runtime.
- [x] New native lane: three pristine worlds for remote target/decoy recovery to ten copper/electronics, completed native movement-prefix uncertainty, and actual native target removal followed by exact `target_gone`. Final selected-lane aggregate exits 0. Main recovery uses seven serialized calls (two Sol/five Luna), three admitted batches, fresh target/counts and native furnace output. Prefix uses four calls, actual earlier movement and `started_count:2`; destruction uses five calls, actual recovered furnace item and `target_gone`. Both controls preserve uncertain effects, zero copper output and an untouched decoy. All worlds have zero humans, speed 1 and idle queues.
- [x] Original native runtime and original compiled controller controls inspected at the expected missing-guidance/proof boundaries. Both exit 1 for the behavioral assertions; no import/setup failure.
- [x] Independent final frozen review approved `6b374d2c`; all source, static/native proof and original-code controls inspected.
- [ ] Local no-ff integration and merged canonical gate.

The initial thirteen-lane run failed only the new fixture: it omitted the real planner's mandatory `requirements_grounding` confirmation. The actual native prompt and failure remain in `native-final.log`/`native-initial-results`. The fixture now asserts that confirmation and both Sol calls explicitly; no production assertion or allowance was weakened. A subsequent native recovery reached ten copper/electronics but still failed the old one-Sol role assertion, so that run is not counted as passed. With that assertion corrected, both recovery and the actual movement-prefix control passed; destruction then exposed Factorio saving back over the pristine start-server path. Each control now starts from its own copy, preserving the original pristine fixture. The destruction script also includes the normal zero-action executor report after the harness independently blocks the exact `target_gone` receipt. All twelve other lanes passed.

The static fixture initially requested a second ordinary read after its one-read steering budget; it now uses the existing targeted inventory allowance. A stale-epoch regression prompted a fresh native epoch check at receipt classification. All diagnostic logs are retained.

Ignored evidence: `test-results/local-transfer-target/` contains canonical logs, original read-only sources/controller, original controls, native builds/results and a durable parent checkpoint. The original compiled controller comes from the retained prior official targeted-water image; only its bundled `control.lua` is overlaid read-only. There are no live providers in these tests (`--network none`, injected scripted inference only).

Parent verified final image runtime/native-runner bytes against the frozen source, retained an eleven-file SHA256 evidence manifest, and confirmed all isolated test containers stopped. Only the unrelated pre-existing Endfield container remained running.

The separate ignored Run T observer repair passed independent review and 21 offline Docker cases. It recognizes canonical structural blockers even with `run.paused:false` and waits for source-faithful stop confirmation/native idle before result/save. Finalized-goal receipts without an actor stamp require fresh isolated-run log provenance and independent native actor verification. Timeout is explicitly incomplete. Measurement, starter fixture and limits are unchanged. Reviewed helper hashes: runner `c56240aa14a81ecf4072398fc02130abc19dccc49e0e1f8620f665b520f074fc`, terminal helper `d40d1f8e9240ff64cd52998e8ac05f9b050018da04e68499a321067162d43837`.

## Promotion boundary

No live trial, push, release or Pterodactyl deployment is part of this task checkout. Full natural-resource automatic red science and the five-wall-minute speed-two unattended benchmark remain unproven. A later supervised local trial requires passing native controls, independent review, local integration, merged checks and the unchanged exact deployment/proxy/cold-world preflight.
