# Playable-build checkpoint — 2026-10-02

## Owner and scope

The owner requested catching up to current HEAD and the Claude folders, then finishing work toward a playable NPC. This checkpoint covers repository synchronization, a bounded MW2 receipt fix, and the next gameplay gates. It does not promote a release or authorize a provider run or deployment.

## Baseline and Claude handoff

- Fetched `origin/experiment/jev-agent-architecture` and fast-forwarded the clean checkout from `8bbb8eb3` to `c6f494aacdc48390c09b95bad76c619a85ca9df3`.
- Reviewed the project-specific Claude memory indexes and current handoffs, including the September 30 owner decisions and October 5 work plan. Checked every local `.claude/worktrees` entry for working-tree changes.
- `affectionate-mclaren-beebd2`, `exciting-clarke-e610d3`, and `trusting-boyd-7b3755` have clean tracked trees and HEADs already contained in the updated integration line. `peaceful-saha-a52c6f` is a clean, separate September 19 main/CI line; it was not merged. The old `mw2-task-ledger` and `fix-openrouter-deepseek-closed-round` folders contain no remaining files and are not registered worktrees. Existing session worktrees were preserved.
- The current HEAD includes U11 checkpoint judgments, MW1 authorization checks, MW2 task persistence/reconciliation, console layout adjustments, and the October 1 OpenRouter fixes. Their presence does not establish end-to-end gameplay readiness.
- Offline baseline: 1,558 runtime tests and 895 mod tests passed, together with typecheck, Lua build and generated-Lua checks. Docker was available; no running gameplay stack was found.

## Finished in this checkpoint

Implementation `e4e8238a7796f1805aa37682d2f78d42105f3fb0`, integrated by `b3a7c7010ce08925e6b2198049e09f9a8e7c8980`:

- An idle cancelled batch keeps its `partial_unknown` effect and duplicate-delivery guard. Cancellation proves that the queue stopped, not that no items moved.
- An earlier acknowledgement no longer clears an unknown effect after a mod reload or a missing baseline.
- Retained receipt verdicts are persisted, and `operation.reconciled` records `settled: false`, a reason and a request ID. A receipt after its originating turn closes uses the request ID in the pending operation key.
- A correlated completed batch still settles normally.
- Three new scripted test groups exercise both lost and received acknowledgements, cancellation, persistence, reload, missing baseline and normal completion. They call the real loop receipt path and use no live model.
- A separate read-only review found no blockers. The steam replay golden includes one additional reconciliation event. A Docker comparison verified unchanged provider-call fingerprints and unchanged pre-existing trace contents after accounting for the inserted event and subsequent sequence-number increments. The permanent golden assertions remain exact.

These are scripted runtime proofs. No new real-Factorio or provider evidence is claimed.

## Final verification

The integrated tree passed the complete offline Docker gate, exit code 0:

- Installer artifact `--check` and all 9 payload tests.
- All 1,561 runtime tests, with golden regeneration disabled.
- All 895 mod tests in 113 files, TypeScript typecheck, Lua build and generated-Lua check.

The final gate used a temporary copy of `scripts/test-local.sh all` with the two
installer checks prepended to the runtime command; all repository-approved mounts
were preserved. The temporary script and diagnostic probes were removed. Full log:
`D:/SideProjects/airi-factorio-npc/logs/npc-playable-2026-10-02.log`.

The installer payload is repinned to integration commit `b3a7c701`. Its installer
source bytes and SHA-256 remain unchanged:
`c9afee9d190c43b02ed2b225c8ead8bd9dd3c84152a127862f43acc7e73ad09d`.

## Remaining reconciliation limitations

The existing reconciliation algorithm still infers attribution from batches newer than a baseline rather than binding the exact acknowledged batch. A joined open batch can finish before reconciliation and be misclassified as not admitted. A later changed batch can overwrite the one pending record, and unknown effects do not yet have a verified-observation clearance path. These need a separate correlation slice and real-engine restart/joined-batch coverage; this fix does not resolve them.

## Next work in dependency order

1. Finish the remaining MW2 correlation follow-ups, particularly exact batch attribution and joined-batch completion. Keep partial/unknown effects guarded until authoritative evidence resolves them.
2. MW4: persist one provider-token campaign ledger shared by planner, executor and Jev. The owner selected per-meter token accounting, a roughly 2 CAD equivalent allowance, a 75% warning and a visible pause at exhaustion. Exact per-meter limits still need a grounded conversion; restage, slice changes and restart must not refill it.
3. With the owner's explicit run authorization, execute the bounded direct-DeepSeek V4.1 Flash test after static gates. The current target is a cold-start NPC reaching a steam-powered electric mining drill that actually produces ore. Use the selected campaign limits and record semantic output and correlated traces.
4. MW3: task-local questions, deterministic resume order, and the selected 3-attempt / 15-game-minute stagnation and aging bounds.
5. MW5: issue and revalidate actor-bound mandates from actual player/Auto tasks, wire planner replacement requests and executor handoffs, preserve the requested result, and expose meaningful recovery notifications. MW1 currently supplies checks and facades; it does not yet supply this live flow.
6. MW6: integrate interruption, approval, restart, no-Jev operation, exhaustion and verified output in one correlated scenario. Obtain current-engine powered assembler/inserter production proof before calling automated red-science production playable.

The existing minimal-steam lane is useful A1 mechanics evidence. Autonomous cold-start electricity, powered assembler/inserter output, and broader fluid systems are separate gates. The owner-visible console also needs a client check of the latest layout on matching server/client mod versions.

## Resume

Branch: `experiment/jev-agent-architecture`. Changes are local until explicitly pushed. No provider calls, gameplay stack start, deployment, credential read or destructive worktree cleanup was performed.

Ordinary gate: run `bash scripts/test-local.sh all` from Git Bash with Docker available. Installer verification additionally runs `node deploy/pterodactyl/build-payload.mjs --check` and `node --test deploy/pterodactyl/build-payload.test.mjs` inside the same repository-approved Docker mounts.
