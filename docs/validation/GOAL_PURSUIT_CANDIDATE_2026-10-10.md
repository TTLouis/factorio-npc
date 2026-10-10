# Goal pursuit candidate — 2026-10-10

Owner: this chat; checkout `D:/SideProjects/airi-factorio-npc/goal-pursuit-harness`, branch `experiment/goal-pursuit-harness`. Preserves checkpoints `8415a486` (direct routing only) and `3c0f988f` (unfinished core checkpoint). The owner renewed continuation after reset; original 56% checkpoint/61% stop still apply. No live call has occurred at this candidate preparation milestone.

## Gates and retained evidence

Evidence root: `test-results/goal-pursuit-2026-10-10/` (gitignored; retained on disk).

- `final-all.log`: `bash scripts/test-local.sh all`, exit 0. Runtime 2,102/2,102; mod 1,046/1,046 in 120 files; typecheck, Lua build and generated-Lua guard passed.
- `full-build.log`: required full build exit 0. `full-build-final.log` refresh confirms exact final source.
- `engine-build-final.log`: complete Factorio gate image build exit 0.
- `native-final.log`: pursuit and provenance lanes exit 0. `native-final-lanes/pursuit/results/pursuit-evidence.json` records native craft completion, zero humans, four fixture plates consumed, two gears, two cumulative calls and ordinal two across an on-disk reload/new goal. Traces, durable state, RCON commands and saves are retained in that lane folder.
- `native-gate.log` and `native-lanes/`: earlier failed pursuit lane retained. Approved inventory tool prints serpent text rather than JSON; runtime now preserves the observation text, regression uses realistic Lua text, corrected lane passed. Provenance passed in both runs; human last_user arm cannot be exercised with zero offline humans and remains an explicit engine limitation.

## Independent invariant review

Reviewer `/root/pursuit_invariant_review` performed read-only bounded source review, no tests, provider calls, edits or secret access. Reported blockers: ambiguous `harvest_product` could mine protected assets; new goals reset global admission ordinal; work could start between world read and native admission. Also reported queued transport deadline/cancellation gap. All were fixed with regressions: deny ambiguous harvesting; carry local/native high-water ordinal; atomic native idle check before journal begin; deadline/generation check immediately before socket write.

Final reviewer finding: “No remaining promotion blocker found in this bounded source review.” Approval conditional on final Docker gates, real-engine evidence and freezing the candidate. Narrow follow-up review of inventory text: “No new blocker found”; completion/admission remain trusted structured reads and actor fences surround inventory observation.

The final gates above meet the code/engine conditions. Candidate commit, installer repin, full shipped-runtime/mod comparison and single-trial results will be appended as new evidence milestones. This is an experimental local candidate, not production promotion or proof of red-to-green autonomy.
