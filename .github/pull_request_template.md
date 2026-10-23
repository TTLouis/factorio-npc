## Problem and result

<!-- Concrete trigger, prior behavior, and observable result. Link the task/design. -->

## Acceptance evidence

<!-- Criterion -> command/scenario -> result and evidence path. Record tested SHA.
Unit/static gates do not prove engine behavior; placement does not prove production.
For workflow/docs-only changes, give the relevant command/config/link checks. -->

<!-- For E2E-derived fixes, follow docs/E2E_REPAIR_REQUIREMENTS.md. Name the
failure class and harness owner, shared prevention, residual-miss detection,
bounded harness correction/automatic continuation, safety/exhaustion controls,
and baseline negative evidence. Prompt-only or model-managed retry is insufficient. -->

| Criterion | Proof | Result |
| --- | --- | --- |
| | | |

## Review and limits

<!-- Independent reviewer and disposition of actionable findings; unproven behavior,
dependencies, recovery/revert procedure, and any payload repin. No secret values. -->

- [ ] Scope and acceptance criteria match the requested change.
- [ ] Required checks pass on the latest candidate; evidence names the tested SHA.
- [ ] Independent review is complete and actionable feedback is addressed.
- [ ] Affected actor/epoch, plan authority, budget, receipt and secret boundaries are preserved (or explained as unaffected).
- [ ] Documentation matches the behavior; historical validation records are preserved.
- [ ] For an E2E-derived fix, shared prevention and harness-owned self-correction are evidenced, including a residual miss, safe continuation and bounded exhaustion; otherwise marked not applicable with a reason.

<!-- Target experiment/jev-agent-architecture for development. Live provider trials,
deployment and promotion require their existing authorization/evidence gates. -->
