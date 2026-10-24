# Development workflow

For new work, start on
[`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/tree/experiment/jev-agent-architecture)
and follow its [current workflow](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/docs/DEVELOPMENT_WORKFLOW.md).
Jev is optional there. `main` retains an older runtime; documentation maintenance
is not authority to promote newer behavior into it.

For an explicitly requested main documentation backport:

1. Inspect status, branch, upstream and ownership. In the shared workspace, follow
   the parent `AGENTS.md` and `WORKTREES.md`; preserve other sessions' changes.
2. Record the exact source SHA, requested outcome, dependencies and acceptance
   evidence. Use one owned branch/checkout for the bounded backport.
3. Match every setting, script and local link to files in `main`. Point to current
   Jev documents explicitly rather than implying their runtime exists here.
4. Check relative links, commands, diff/whitespace and unchanged runtime/history.
   Use [TESTING.md](TESTING.md) for this snapshot's supported checks.
5. Have a separate reviewer inspect the actual diff. Fix or explain actionable
   findings, then commit and publish only under the owner's authorization.

Runtime changes follow their own review, native evidence, payload and release
gates. Do not infer release readiness from a documentation update or static pass.
Preserve dated reports, saves, credentials and upstream MIT attribution.
