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

- [ ] Reproduce with deterministic scripted loop and library fixtures
- [ ] Implement bounded loading and relevance/guidance correction
- [ ] Offline Docker gate, payload checks and original-code negative controls
- [ ] Independent review and affected rechecks
- [ ] Integrate, fresh merged gate and exact-head CI

Checkpoint: implementation in progress; no autonomous gameplay claim.
