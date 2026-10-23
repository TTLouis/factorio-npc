# Run AD: read reopen and planner review work; direct-feed geometry still stalls

One owner-authorized cold E2E ran on latest published Jev
`053518b8293695faa104d7f76d1b015aecf2d898`. It stopped after **7.5152 minutes**
with **10 copper plates, zero new iron plates and zero automation science packs**.
Both Run AC fixes were exercised: a closed read phase reopened, and a genuine
review received one planner round followed by a fresh executor. The same iron
step later requested another review and paused at the intended allowance bound.
Automated red-science output and direct-fed iron production remain unproven.

## Candidate and conditions

The candidate includes code `124be497` and payload repin `053518b8` from the
[Run AC review-gap checkpoint](RUN_AC_REVIEW_GAPS_2026-10-19.md).
The integration checkout fast-forwarded from `50f099a0`; published remote HEAD
was verified before building. The official local builder ran with `-NoEnvUpdate`.
All **55 installer-shipped runtime modules**, the prompt and release manifest,
and **31 independently compiled native files** matched the deployed candidate.
Provider contract/catalog probes made zero inference calls and confirmed the
configured CLI proxy, Sol planner, Luna executor and dedicated Jev token.

Prelaunch gates passed **2,635 runtime tests, 1,234 mod tests, typecheck and Lua
checks**, plus 44 helper tests, ten archive tests and the cleanup-inventory
failure regression. No runtime code was changed during this task.

The sole goal remained:

> Build a fully automated factory producing at least one automation-science-pack
> per game minute from natural resources.

Cold preflight verified actor **4**, seed **1447020480**, speed one, zero humans,
empty inventory, no machines/goal/board, idle native operations and zero prior
provider/Jev requests. The unchanged starter supplied eight iron plates, one
burner miner, one stone furnace, pistol and ten magazines. Construction cap was
60 minutes; weekly live stop/reserve remained 7%/5%. No corrective prompt,
manual resume, allowance reset or second trial ran.

| Evidence | Result |
| --- | --- |
| Goal | `goal_1a2e7r6_1` |
| Provider requests / replies / errors | 22 / 22 / 0 |
| Actual response models | Sol 5; Luna 17 |
| Jev requests / replies / errors | 16 / 16 / 0 |
| Committed delegations / admitted batches | 1 / 5 |
| Read reopen / planner review round / same-step handback | 1 / 1 / 1 |
| Genuine executor reviews | 2, both advisory with `world_blocker_proven:false` |
| Strategy refusals / role-contract refusals | 0 / 0 |
| Native production | 8 coal, 10 copper ore, 10 copper plates; zero iron ore/new iron/red packs |
| Final machines | None; furnace recovered, miner never placed |
| Terminal result | `controller_paused:guard` |

## What changed relative to Run AC

The copper bootstrap completed with ordinary manual gathering and furnace
smelting. The next committed step required the held burner drill to feed natural
iron ore directly into the furnace and smelt 50 iron plates for steam power.
There was no manual-iron substitution.

At **11:24:00.424 UTC**, an executor-authored `approach_infeasible` review from a
post-batch-closed read phase triggered `observation.phase_reopened_for_review`.
The preceding covered family was only `research_state`. The next two outgoing
executor requests had `allow_tools:true` and `tool_choice:auto`. No tool call
was made during this reopened interval; the executor then requested genuine
review, reporting missing iron-resource/coverage/output-alignment facts.
At 11:24:05.579 UTC, `observation.targeted_refused` rejected an observation
request because targeted recovery allowed exact status facts or one
native-grounded resource search, while general discovery was unavailable.
Thus, enabling provider tools did not itself remove that observation-channel
restriction; this is another concrete follow-up to investigate.

At **11:24:16.068 UTC**, `planner.review_round` claimed the bounded advisory
round. The planner returned the same committed step at **11:24:30.185 UTC** with
958 characters of notes. A fresh executor received `[PLANNER_REVIEW_NOTES]` and
continued. Seven provider requests followed the review, including six executor
requests after handback. This demonstrates actual inference and continuation,
where Run AC had zero provider requests after its review.

The fresh executor queried actor/inventory/furnace state and nearby iron. The
nearby search found none within radius 20; the long-range search then found iron
at **(-47.5,-12.5)**, about 22.2 tiles away. It confirmed the exact furnace and
successfully mined that furnace for relocation. The final inventory retained
both the miner and furnace, seven coal, the eight starter iron plates and ten
copper plates.

After furnace recovery, the post-batch selector again chose only
`research_state`, the harness supplied that fact and closed reads. The outgoing
executor request and action-omission repair both had `tool_choice:none`.
The executor requested `local_recovery_exhausted` review at **11:25:32.097 UTC**,
citing missing coverage/output geometry in the closed round. The per-step read
reopen and planner-round allowances were already spent; the guard pause followed.
No drill placement, direct-feed output or throughput measurement occurred.

The remaining investigation is how the active direct-feed brief obtains resource
coverage and output-alignment observations after a world-changing batch, when
post-batch family coverage supplies only research state. The trace proves a
known iron location and unavailable closed-round tools; it does **not** prove
physical infeasibility or justify bypassing the plan/allowance guards.

The read-only trace checker reports `stale_step_tracker_behind_batch` after
batch 5. That completed batch recovered the furnace; it did not establish the
50-iron/steam-power checkpoint. The diagnostic alone is not evidence of incorrect
tracker advancement.

## Stop, save and cleanup

The authoritative observer confirmed the nonresumable guard pause. Fresh
supervisor cancellation and same-goal operator pause were paired, native work
was idle, crafting/operation queues were empty and intake retry was cleared.
The fresh **898,615-byte** save passed all **56 ZIP-entry CRCs**. A pristine copy
loaded with exact Factorio **2.0.77**, the matching active mod and network disabled,
and completed one benchmark tick. Save SHA256:
`62b3f508c3eb7862726347d1c2dfdbb1ff3ff96db65716fd787b59517f9ba637`.

The wrapper exited zero. Compose project `red-automation-20261019ad`, its
containers/network/disposable volumes, proof containers, unique image tag and
SSH PID 3416 were removed. A separate parent inventory corroborated absence.
The shared `factorio-npc:local` alias and evidence/save are retained.
The untracked Run AA report was restored byte-for-byte after the clean build;
historical Run AC and Run AB evidence were preserved.

Evidence: `test-results/red-automation-live-2026-10-19ad`, especially
`analysis/routing-proof.json`, `analysis/trace-summary.json`, deployment/native
proofs, `data/logs/e2e-result.json`, save/load proof and cleanup inventories.
This report records one local trial; no follow-up gameplay correction or further
trial was performed.

Separate read-only evidence review approved with limitations. Final evidence seal:
**215 files / 12976882 bytes**; all entries reverified.
Manifest SHA256: `162a53121ae46821862436da17f9db55ca847580b8ad5550254aeefe3065edaf`. All 46 frozen helpers, 208 historical
Run AC files, 216 Run AB files and the original Run AA report were reverified
unchanged. Weekly remaining was 75% at closeout; no reset credit was used.
