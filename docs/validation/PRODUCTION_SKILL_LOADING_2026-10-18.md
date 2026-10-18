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
- [ ] Independent review and affected rechecks
- [ ] Integrate, fresh merged gate and exact-head CI

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

Checkpoint: independent review and integration pending. These checks prove
context delivery and matching; autonomous layout choice and sustained red science
still require a separately authorized live trial.
