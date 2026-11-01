# Production skill loading

Problem and observed trigger: Run AA offered production cards but loaded no full
skill before committing its plan. Weak matches on “least” and “one” crowded the
direct miner/furnace pattern down the list.

Owner / task branch / source SHA: Codex session01a14fa4,
`fix/production-skill-loading`, `03709933fccbe42ab8eecacc20a7cb28d502ff69`.

Requested outcome: load bounded relevant library details before plan authoring;
present dedicated direct-fed furnace pairs as a way to save time, comparing setup
cost with repeated hand supply and switching a shared furnace. Manual bootstrap
remains an option. No live provider trial, deployment, forced layout or throughput
claim. Integration ownership was transferred to this chat by the owner.

Acceptance criteria:

- The exact Run AA goal ranks direct smelting and rate guidance in the first
  three; generic quantity words alone offer no pattern (native library tests).
- The first scripted planner request contains actual loaded constraints/topology,
  and commitment traces the loaded IDs even without model detail-tool calls.
- Discovery cards alone never become loaded context. Missing, malformed, timed
  out or stale details do not load; reads are capped at three per boundary and a
  shared time deadline. No per-execution-step loading or new provider calls.
- New-goal, shelf, revision, cancellation and actor/request fences retain task
  locality. Existing world observation and mutation admission are unchanged.
- Skill text explains possible time savings and setup payback, with finite manual
  smelting allowed; geometry, fuel and recipe checks remain live prerequisites.

Dependencies: existing skill library, offer boundary and task-local skill context.
No other task owns these changes. Static library reads carry no live-world proof
or mutation authority; Jev skill ranking stays shadow-only.

- [x] Reproduce with deterministic scripted loop and library fixtures
- [x] Implement bounded loading and relevance/guidance correction
- [x] Offline Docker gate, payload checks and original-code negative controls
- [x] Independent review and affected rechecks
- [x] Integrate and run fresh merged offline gates
- [ ] Exact published-head CI (see shared WORKTREES.md for final run status)

Candidate code `19395ce5`; separate payload repin `22f3ff0d` points at that
immutable source. `bash scripts/test-local.sh all` exited 0: 2,599 runtime tests,
1,234 mod tests, typecheck, Lua build and generated-Lua checks. The final pass did
not enable snapshot updates. The intentional prompt snapshot update changes only
body/provider-request hashes; context hashes, message counts and trace shape stay
unchanged. Payload build/check, nine payload tests and ESLint on all three changed
TypeScript files exited 0, using existing `npc-dev` with network disabled.

Evidence: ignored `test-results/production-skills/` contains complete logs and
exit records. The same standalone first-planner assertion passes on the candidate
and fails on the original skill-offer module because the detail context is empty.
The native-library regression fails with both original source files because the
first three omit direct smelting. Both controls use unchanged new assertions;
neither failure is an import/build error. No provider or Jev credentials/calls.

The task's scripted Run AA case checks actual detail text, request-correlated
load/commit traces and next-goal isolation. Additional cases cover detail failure,
timeout, large-context priority, replaced offers, actor/epoch/session/request and
generation/lineage changes. Existing shelf/revision, budget, uncertainty and
handoff suites remain green. The curated direct-smelting revision is now 4 so
existing unedited library copies receive the guidance through normal seeding.

Owned test containers use the runner's logged `npc-static-*` scopes and the exact
`npc-production-skills-{positive,original,mod-original,payload}-01a14fa4` names.
All are removed after their run, including expected negative failures; no Compose
project, persistent volume or new image was created.

Independent reviewer `production_skills_review` approved code `19395ce5` and
follow-ups `22f3ff0d`/`a7762ace`, with no blockers. Integration merge
`439c65ab4e2e14e950ec836bd2d75c417686ca11` passed the fresh offline gate
(2,599 runtime / 1,234 mod / type / Lua) and payload check plus nine tests, all
exit 0. Merged evidence is retained in
`test-results/production-skills-integration/`. Candidate evidence is sealed:
17 files, 2,256,512 bytes, manifest SHA256
`f3198b945180488d7136521224b3b98f95d6e9248f12f885ef995db32931ba5c`.
The historical Run AA report remains untracked and unchanged (SHA256
`1d0df36e51981bc9c29323575592aaf5a616dc878d00f3b7b6f602509227d101`).

Checkpoint: merged offline checks complete; published-head CI pending. These
checks prove context delivery and matching; autonomous layout choice and sustained
red science still require a separately authorized live trial.

## CI topology follow-up

Initial published CI `39150833598` passed six jobs and the default real-engine
harness, but failed its separate fresh-topology lane. Package `39150833538` and
Security `39150833537` passed. Local exact-code reproduction found the same
failure: a 4,092-character executor packet left 1,908 characters for the native
topology record. Three newly loaded skill IDs occupied 88 redundant characters;
the topology serializer dropped the boiler rather than exceed its limit.

The follow-up removes that ID-only line from the provider copy only when the
packet is under size pressure and every ID already has full details in the actual
rendered skill prefix. It preserves the canonical packet, loaded details, live
facts, 6,000-character handoff cap, 1,950-character topology cap and read limits.
The request-correlated `context.skill_refs_deduplicated` trace states the reason
and released space. Missing/malformed/partial skill context never removes IDs.

The unchanged native geometry/output assertions fail before the fix and pass
with the fixed runtime: two pipes, the held engine, powered inserter, three stable
generation samples, unchanged poles and immutable goal, zero inference fetches.
The native lane additionally asserts full loaded guidance reaches both roles and
checks the deduplication trace. Evidence and original failure saves are retained
under `test-results/production-skills-ci-followup/`; frozen rerun, review and
repromotion pending at that checkpoint.

Frozen follow-up code `7821af20`, payload `fc3a8956`: offline gate exited 0
(2,600 runtime / 1,234 mod / type / Lua), payload check and nine tests passed.
The frozen real-Factorio 2.0.77 image passed fresh-topology and both
partial-transfer cases (ordinary recovery and unknown-effect control), including
92 Python runner regressions. Independent review approved the final code after
the outgoing-context guard and correlated trace assertions addressed its two
findings. All native evidence/saves were copied out before teardown; the three
run-owned images and every owned container are removed. Repromotion pending.

Final integration merge `31392fec4feaae40efd737b97925c3082a69d5e2` passed the
fresh merged offline gate (2,600 / 1,234 / type / Lua) and payload check/nine tests,
all exit 0. Follow-up evidence is sealed: 207 files, 19,170,093 bytes, manifest
SHA256 `4efc0a910a682fb89f44a09b51f11ce6f8094fcc728c093cc7195a1b517bc877`.
Original candidate evidence and the historical Run AA report remain unchanged.
Published-head hosted results are recorded in shared `WORKTREES.md`; live
autonomous red-science production remains untested by this offline fix.

CI `39152243119` flagged two `prefer-template` violations in the new pressure
fixture. Reviewed correction `4628ef39` preserves the exact generated strings;
runtime and payload are unchanged. ESLint on every changed JS/TS file with the
current repository configuration exited 0. Both candidate and fresh merge
`f47158700b5e09069eeed7d552722a0e981c874e` passed the offline gate
(2,600 runtime / 1,234 mod / type / Lua). The payload continues to pin `7821af20`.
