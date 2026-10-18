# Executor method selection and advisory review: offline fix

Owner: Codex session01a14fa4. Task: `fix/executor-strategy-review`, based on
Jev `34bc779106342fdf311e045d60c0b5ddd38dfef1`. The owner requested an offline
fix for Run AB's manual default and unused planner review. No live provider/Jev
call, gameplay trial or deployment is authorized by this task.

## Observed causes and change

Run AB delivered the selected details and brief to every executor request, but
the planner's reuse/direct-output prose did not encode a chosen resource method.
The executor could hand-mine and hand-feed while staying inside the broad plate
checkpoint. Selecting a skill is knowledge, not a commitment to its layout.

New planner briefs expose `materialSupply`: either `direct_feed` or
`manual_bootstrap` for a named resource, or null for other work. New selections
of `direct-miner-smelting` must make that choice explicitly. The planner compares
held machines, remaining work and live setup/mining/delivery costs. Reusing an
owned miner/furnace can still mean direct feeding. Additional dedicated cells
remain optional investments justified by time savings; no machine count is
mandated. Old persisted briefs retain their original meaning.

When direct feeding is explicitly chosen, manual collection/hand-delivery of
that resource cannot silently replace it. The runtime refuses the entire batch
before admission and requests advisory strategy review. It covers ordinary,
positioned and exact observed-resource mining plus raw-material transfer aliases.
Startup fuel, unrelated stone and finished-plate collection remain available.
Choosing manual bootstrap or a null/non-production scope preserves manual work.
This is a bounded guard on named supply operations, not a general semantic proof
that every operation follows all prose constraints.

Protocol 3 previously appended review guidance while retaining conflicting
legacy `BLOCKED` directions in the role suffix, durable system prompt, compact
and closed contracts, action-omission repair, recovery capsule and fresh recovery.
The fix rewrites those specific harness instructions for protocol 3. It preserves
older protocol behavior and does not rewrite player text, observations or receipts.

If a protocol 3 executor still returns legacy `BLOCKED`, only an authority-rejected
provider claim at an idle, settled, current step can be routed into the existing
advisory review handler. Accepted deterministic blockers and uncertain effects
retain their existing handling. The advisory pauses and returns planner context;
it does not itself invoke an unbounded planner loop, authorize replacement,
advance completion or replenish any allowance. Current-actor/generation checks
also run after asynchronous persistence and planner return.

New request-correlated traces are `executor.strategy_refused` and
`executor.legacy_blocker_review`; existing `executor.planner_review_requested`
records the handback. Their tests assert reason and absence of world authority.

## Acceptance and evidence

- [x] Reproduce actual pre-fix admission of an ambiguous selected-skill plan.
- [x] Replay Run AB's recorded final response against the original runtime:
  it spends fresh recovery and fails without a review request.
- [x] Candidate rejects the ambiguous draft before mutation, requires a method,
  and routes the same recorded response into one advisory review without fresh
  recovery. These are actual baseline/candidate module runs with scripted replies.
- [x] Full-loop controls: explicit direct-feed drift refuses the whole batch;
  manual/null choices and startup fuel remain allowed; method survives restore;
  accepted blockers, unresolved effects, stale actors and superseded review
  returns preserve their guards.
- [x] Actual system prefix plus ordinary/compact/open/closed/repair/fresh-recovery
  instructions advertise review rather than legacy blocked prose.
- [ ] Final full Docker gate, current-config lint, immutable payload pin.
- [ ] Frozen native protocol 3 canary, including physical no-admission proof for
  a mismatched batch and preservation of the existing powered-load scenario.
- [ ] Independent review, integration gate and publication.

Evidence: `test-results/executor-strategy-review`. The baseline/candidate probe
disables external inference and uses network-disabled Docker. Its recorded fixture
retains non-secret water/navigation context, but the scripted replay exercises
the final response and review path; it does not reproduce Run AB's entire map or
prove autonomous exploration. Passing these gates cannot prove a live model will
choose the fastest strategy or that autonomous red throughput is achieved.
