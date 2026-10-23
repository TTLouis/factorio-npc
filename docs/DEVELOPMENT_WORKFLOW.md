# Development workflow for Factorio NPC

This applies the useful parts of Chris Titus Tech's
[coding workflow](https://www.youtube.com/watch?v=wcRR5P0S2Us) and
[companion article](https://christitus.com/my-ai-workflow/) to this project.
Existing actor, planning, secret and promotion rules remain authoritative.

## Start from a bounded failure or outcome

Read the parent workspace policy/ownership registry, `AGENTS.md` and `SPEC.md`.
Confirm the actual checkout, branch, upstream and current Jev source SHA. Reuse
the task branch when resuming. Preserve occupied checkouts and historical evidence.
Open only the relevant subsystem and design references; use exact searches before
loading long status histories. Do not create a second project roadmap.

For substantial work, keep a short task note with this shape:

```markdown
Problem and observed trigger:
Owner / task branch / source SHA:
Requested outcome and excluded work:
Dependencies / existing task ownership:
Acceptance criteria (observable result -> proving test or evidence):
Invariants affected (actor/epoch, plan authority, budget, receipts, secrets):

- [ ] Reproduce with a deterministic fixture or native lane
- [ ] Implement one bounded change
- [ ] Validate the candidate; record commands, exits, versions and evidence paths
- [ ] Independent review; fix or explain each actionable finding
- [ ] Integrate through the owned integration checkout and validate merged SHA

Checkpoint: candidate SHA, completed items, next action, unresolved limits
```

Use an existing design note's build section or a task note, with one owner. A note
or registry entry does not authorize live calls, deployment or another session's
checkout. A plan-only task can finish without implementation; describe its scope.

## Choose evidence that matches the claim

For an E2E-derived fix, apply the [E2E repair requirements](E2E_REPAIR_REQUIREMENTS.md).
Name the failure class and harness owner; supply shared prevention and bounded
harness-owned self-correction. Reproduce the original failure, deliberately test a
residual miss through the real lifecycle, and prove safe continuation plus honest
exhaustion. Prompt improvements and one passing regression do not meet this gate.
Use the guide's repair closeout fields in the task note and PR evidence.

| Change | Minimum useful proof |
| --- | --- |
| Runtime recovery / observation / prompt flow | Recorded/scripted full-loop regression with realistic replies; assert request-correlated traces and existing budget/uncertainty fences |
| Factorio placement / transfer / crafting / fluids | Deterministic real-engine lane, exact version/layout and semantic output; retain the negative control when fixing an engine assumption |
| Actor / operation / restart / planning authority | Stale actor/epoch/restart/refusal cases; committed plan and durable allowance stay valid |
| Installer / shipped runtime | Payload repin as a separate commit, payload check/tests, appropriate package gates at promotion |
| Workflow / docs | Executable command checks, config parsing and link/diff review; no gameplay capability claim |

Run `git diff --check`, then the repository's offline gate:

```sh
bash scripts/test-local.sh all
```

Run it in Git Bash on Windows or a POSIX shell on Linux/macOS, with Docker and an
existing `npc-dev` image. Missing dependencies/image are a blocker to report;
never repair them with a Windows host install. The script never pulls an image
or accesses the network. Keep the full log and real exit status. CI additionally
runs lint, the ordinary agent tests, TypeScript/build, deployment/payload contracts
and deterministic Factorio checks. Existing required-check names stay intact.

The `package.json` pre-commit configuration runs staged whitespace checks and the
offline Docker gate. Existing installations must refresh their `simple-git-hooks`
hook in a supported dependency environment for this configuration to take effect;
this task does not rewrite the workspace's shared Git hooks. On Windows, run the
gate directly and do not install dependencies/hooks through host `pnpm`. The hook
does not auto-fix or re-stage files. Review the staged diff separately when the
working tree has unstaged changes; hooks test the working tree.

## Review and integration

For future accelerated E2E construction, follow
[tick-sprint preparation and adoption gates](E2E_TICK_SPRINT.md). The owner has
approved the direction, not an unvalidated speed change in an existing runner.
Freeze the profile before a new trial; preserve normal-speed baselines and never
retrofit active or sealed runs. Native guard and boundary-barrier proof precede
the first accelerated provider trial.

Use `.github/pull_request_template.md` for a reviewable summary: trigger, result,
acceptance evidence, limits and recovery. A separate reviewer reads the actual
diff and verifies claims. For every actionable finding, fix the cause or record
why it does not apply; then rerun the affected checks on the latest candidate.

Use the workspace's existing integration procedure and owner permissions. Confirm
the integration checkout is available before writing; never switch branches or
overwrite another session's changes. Record candidate and merged SHAs, and require
fresh CI for the resulting head. Human approval/target-environment verification
remain the final release gate. Local checks do not configure GitHub branch rules.

## Security and dependency maintenance

`security.yml` scans JavaScript/TypeScript (including the deployed `.mjs` runtime)
with CodeQL and reviews PR dependency changes. Dependency review rejects newly
introduced high/critical vulnerabilities in runtime, development and unknown
scopes. This covers build-time tooling as well as the server process.

An opt-in [Dependabot example](examples/dependabot.yml) proposes grouped weekly
pnpm and Actions updates against the Jev integration branch, with bounded open
PRs and no automatic merge. It is deliberately outside `.github/dependabot.yml`:
recurring PR generation needs an explicit owner request. To activate it, copy the
example to that path and land it on the default branch after owner authorization.
Keep compatible updates separate from major upgrades; use the same tests and
review as any other change. CodeQL does not validate generated Lua or Factorio
engine semantics.

GitHub must support/enable code scanning and the dependency graph/review for these
jobs. Required checks and default CodeQL setup are repository settings: confirm
those before making the new jobs required, and avoid duplicate default/advanced
CodeQL runs. Their first hosted execution is still needed to confirm service
availability. No external review bot or additional provider credential is
configured by this workflow.
