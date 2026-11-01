# Recovery completion proof fix — 2026-10-20

Owner: Codex session01a15959. Branch: `fix/semantic-completion-proof`.
Source: `2bad40672e2a6d4a057a6ca748ffbf5eae41739d` (published Jev).

Run AG completed its canonical final iron/research step after batch 13 only transferred coal into a drill. The latest `deterministic_verification` receipt proves an action finished; it cannot prove a semantic step, committed slice, or user goal. Recovery had directly submitted this receipt as unscoped completion authority.

The fix removes that shortcut. Recovery follows its existing runtime/provider routes. Step and goal completion retain the ordinary fresh-world checkpoint and separate goal settlement gates. A request-correlated `recovery.batch_proof_not_goal_completion` event explains why the batch proof does not close the goal. No actor, epoch, budget, or gameplay authority changes.

- [x] Replace unsafe positive fixture with recovery regression; add same-step Run AG supply receipt plus committed iron/research contract.
- [x] Original-source negative control: both fixtures fail with false `completed` (exit 1).
- [x] Candidate standard offline Docker gate: 2,825 runtime / 1,249 mod tests, typecheck, Lua build and generated-Lua check pass.
- [x] Changed runtime/test ESLint: zero errors and warnings.
- [x] Independent actual-diff review approved; unchanged positive completion, unmet-goal continuation and recovery tests pass.
- [ ] Merge, repin installer, merged gates and exact published CI.
- [ ] One owner-authorized Run AH, passive subagent overwatch, strict stop/save/load proof and owned-resource teardown.

Evidence: ignored `test-results/semantic-completion-proof/`. Historical Run AG, AF and preparation evidence remain protected. Claude's separate unpublished placement task is excluded. No live Pterodactyl deployment.
