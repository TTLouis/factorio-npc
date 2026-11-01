# Planner/executor contracts

Problem: both roles can currently submit gameplay operations, and loaded strategy
skills reach the executor without an explicit planner selection.

Owner: side chat session01a1504b, branch feat/planner-executor-contracts.
Source: cached Jev 761861801716d972f605abba302a88201944df8e, matching integration
HEAD at inspection (2026-10-18 14:07 Toronto). Fetch failed in the sandbox.

Outcome: production protocol 3 separates planning-only decisions from execution;
the planner passes durable per-step approach/rationale/constraints/selected skills.
Executor review requests preserve frozen plans, evidence gates and allowances.
Legacy protocols and saved plans remain readable. No model settings change.

Acceptance: scripted full-loop planner refusal then executor action, focused
context across step changes/restart, immutable guidance, strict schema, stale
step/actor and replacement refusal controls, request-correlated traces, offline
Docker gates. Native testing only with scripted decisions, no provider calls.

Invariants: actor/epoch, operation admission, authoritative completion, immutable
committed semantics, bounded recovery and persistent budgets remain authoritative.

- [x] Implement role contracts and focused context
- [x] Scripted regressions and offline gates
- [x] Separate code and installer payload commits
- [ ] Independent review (required before integration)
- [ ] Integration by the integration checkout owner

This side chat owns only its isolated task checkout. No subagents, integration
ownership, live inference, deployment or external messages are authorized here.

Production Session selects completion protocol 3. Protocols 1/2 retain their
existing interfaces. New execution drafts carry aligned executionGuidance:
approach, rationale, constraints and loaded skillIds. The executor receives the
active brief and its selected skill details; fresh native topology retains its
1,950-character slot within the existing 6,000-character handoff budget.
Briefs survive checkpoint refresh, serialization and replacement lineage, and
the executor cannot change them. Healthy committed slices return to execution
after planner consultation without accepting a new strategy.

plannerReview distinguishes approach_infeasible, scope_change and
local_recovery_exhausted. It requires an idle, current actor/step and no unsettled
operation. An already-proven structural blocker may use the existing grant-backed
replacement wake. Otherwise execution pauses, the planner receives the advisory
reason, and durable memory retains it for resume. A model's claim neither proves
a world blocker nor authorizes replacement. No allowance is replenished.

Validation (logs under ignored test-results/planner-executor-contracts/):

- `bash scripts/test-local.sh all`: exit 0; all-final.log, 2,617 runtime and
  1,234 mod tests; TypeScript, Lua build and generated-Lua checks passed.
- Follow-up submitPlan transport and explicit human Revise cases:
  runtime-revision.log, exit 0, 2,619/2,619. Both role schemas run through the
  loop; actionless replacements retain the verified prefix and commit-time grant
  check, while Revise still requires a fresh human chat origin.
- Current-config ESLint: exit 0, lint-candidate.log, every changed JavaScript
  file in the committed feature range. Payload generator/test lint also passed.
- Factorio 2.0.77 native fresh-topology with NPC_TEST_ROLE_CONTRACTS=1:
  native-committed/run.log and lane-results/fresh-topology-proof.json, exact
  feature SHA fba2a419728b597fb7c0f6aca7f7bdc6be1c5e97; PASS, zero
  connected humans, no live inference, actual fluid connection/placement,
  sustained generation under load, immutable committed brief. Python 92/92 PASS.
- Archived original runtime is a negative control: its action-capable planner
  schema fails the same strict contract assertion. No objective action admitted.
- First native image attempt omitted deployment source preparation and failed
  setup before the objective; retained under native-candidate/. Corrected builder
  uses the repository's source-preparer and guard, then the native case passed.
- Installer generation, --check, nine payload tests and generator/test lint:
  payload.log, exit 0. Immutable payload source pinned to fba2a419; SHA256
  01125551dfca41df20395f64bc222222ae09d8fd4df47966d7b4fafdec6a4021.

Owned runs have exact container CID and cleanup logs. All owned containers and
the task image tag/remaining build image were removed and absence verified
(image-cleanup.log). Shared dependency/Factorio images were retained. Evidence
stays in this task checkout. Independent review and integration remain pending
with the integration owner; this side chat did not push or write that checkout.

## Integration review

The owner requested integration and one new red-science E2E on 2026-10-18.
Integration owner session01a14fa4 reviewed the exact feature against Jev76186180;
independent reviewer `planner_contract_review` corroborated the sealed tests and
native evidence. Review found one context-ceiling edge: a cached detail could be
omitted from the rendered planner prefix while still being selectable. The
integration guard now validates selected IDs against rendered details; a real-loop
regression reads three approximately6KB details, rejects the omitted choice, then
verifies every corrected selected detail reaches the executor before mutation.
The reviewer approved that fix, and all17 focused contract tests plus current
configuration lint passed. The source feature checkout remains unchanged.

Cold restart preserves the brief and selected IDs; missing cached details still
require `getSkillDetails`. The normal production request queue serializes planner
review returns; a broader programmatic post-return race was not proven in this
review. These limits are not a claim of live autonomous red-science success.
Full merged gates, payload repin, frozen native validation and hosted checks remain
the integration acceptance boundary before the owner-authorized live trial.

Integration candidate 5bec9163 (reviewed runtime merge 3bc607f4, separate payload
repin 5bec9163) passed 2,620 runtime tests, 1,234 mod tests, typecheck, Lua build
and generated-Lua checks. All changed JavaScript passed current-config lint;
payload generation/check and nine installer tests passed. Frozen Factorio 2.0.77
fresh-topology validation with NPC_TEST_ROLE_CONTRACTS=1 passed, including
92 Python regressions. Evidence is retained under
`test-results/planner-executor-integration`; its native container was removed.
Hosted checks and exact-deployment preflight precede the authorized live run.
