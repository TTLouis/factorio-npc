# Validation history

This directory contains historical evidence and superseded checkpoint documents. Files here are intentionally immutable descriptions of the commit/state they were written for; they are not the current roadmap or deployment manual.

Current documentation lives in:

- `../README.md` — documentation index: guides, shared and built-in planner contracts, proposals;
- `../../README.md` — project overview and branch/deployment model;
- `../NPC_AGENT_HARNESS_PLAN.md` — built-in planner roadmap and promotion gates;
- `../NPC_AGENT_HARNESS_STATUS.md` — current verified status and known limits;
- `../NPC_CHARACTER_ARCHITECTURE.md` — stable actor/body architecture;
- `../../deploy/pterodactyl/README.md` — current Pterodactyl operation/deployment contract.

Historical records currently include the original NPC harness plan/status snapshots, the v7→v8 Pterodactyl staging design, the 2026-09-14 v8 release-candidate record, and user-supplied runtime transcripts.

On 2026-09-25, finished handoffs, dated audits and the completed console UI P0 plan
moved here from `docs/`: `CONSOLE_UI_P0_PLAN.md`,
`HANDOFF_2026-09-24_console_redesign.md`, `NPC_ACTIVE_WORK_HANDOFF.md`,
`NPC_CONSOLE_CONTEXT_HANDOFF.md`, `NPC_CONSOLE_AND_HARNESS_ARCHITECTURE_2026-09-18.md`,
`NPC_COHERENCE_FIX_HANDOFF.md`, `NPC_PRODUCTION_PLANNING_HANDOFF.md`,
`NPC_RESEARCH_PREFLIGHT_HANDOFF_2026-09-19.md`, `PROJECT_COHERENCE_AUDIT_2026-09-16.md`,
`JEV_TYPESAFE_RESEARCH_AND_AUDIT_2026-09-21.md` and
`JEV_REFINED_WORKLOAD_AUDIT_2026-09-22.md`. They are unchanged, so paths inside them
such as `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md` or `../packages/...` refer to where
the files were when written; read `docs/X.md` as `docs/validation/X.md` for these
names.

Live E2E records: `E2E_STEAM_POWER_2026-09-26.md` (cold-start DeepSeek run for steam power; stopped at step 2 by a transfer failure and the per-request output cap; fluids not reached).

On 2026-11-04, dated repair notes, finished work plans and the superseded Jev
decision-layer design moved here from `docs/` with unchanged filenames:
`AX_CANDIDATE_REPAIR_2026-10-25.md`, `AY_HARNESS_RECOVERY_2026-10-26.md`,
`CONTRACT_OBLIGATION_RECOVERY_2026-10-25.md`, `FLUID_PRESERVATION_PROOF_2026-10-25.md`,
`GOAL_ADMISSION_CANCEL_FENCE_2026-10-25.md`, `RUN_AS_NEXT_PATCH_PLAN_2026-10-23.md`,
`RUN_AT_POLLING_REPAIR_2026-10-23.md`, `RUN_AU_HARNESS_REPAIR_2026-10-24.md`,
`NPC_USER_EXPERIENCE_WEEKLY_PLAN_2026-09-28.md`, `PARALLEL_PRODUCTION_WORK_PLAN.md`,
`NPC_PLANNING_REFACTOR_INTEGRATION.md`, `NPC_RELIABILITY_WORK.md` and
`JEV_DECISION_LAYER_ARCHITECTURE.md`. `docs/RUN_AS_ENTITY_REFRESH_FIX_2026-10-23.md`
became `RUN_AS_ENTITY_REFRESH_IMPLEMENTATION_2026-10-23.md`, because a shorter record
with the original name was already here. The status page's dated checkpoints became
`NPC_AGENT_HARNESS_STATUS_LOG_2026-09-16_TO_2026-10-24.md`. Relative links in these
files were adjusted for the new location; plain-text paths such as
`docs/PARALLEL_PRODUCTION_WORK_PLAN.md` in other records still name the old place.

When a new promotion checkpoint is validated, add a new dated file here. Do not rewrite an older record to make it describe a newer commit.

## Finding a record

Filenames carry the topic and the date. Most records belong to one of these series.

| Series | Files | Covers |
| --- | --- | --- |
| Status and plan snapshots | `NPC_AGENT_HARNESS_STATUS_LOG_2026-09-16_TO_2026-10-24.md`, `NPC_AGENT_HARNESS_STATUS_2026-09-13.md`, `NPC_AGENT_HARNESS_PLAN_2026-09-13.md`, `2026-09-13-npc-core.txt` | The status page's dated checkpoints, and the original plan/status snapshots |
| External harness | `EXTERNAL_HARNESS_CHECKPOINT_2026-10-30.md`, `EXTERNAL_HARNESS_WINDOWS_2026-10-30.md` | Checkpoint and Windows validation; gameplay proofs are in [`../proofs/`](../proofs/README.md) |
| Red-automation runs | `RED_AUTOMATION_LIVE_RUN_<N…AV>_*`, `RED_AUTOMATION_PAIRED_RUN_<AW,AX>_*`, `RED_AUTOMATION_PREFLIGHT_AQ_*`, `RED_AUTOMATION_NEXT_TRIAL_PLAN_*` | Built-in planner red-science trials, October 15–25 |
| Repairs from a named run | `RUN_<run>_*` (Runs C, V–X and AC–AU), `AW_HARNESS_REPAIR_*`, `AX_A_TYPED_CONTRACT_CARDINALITY_*`, `AX_CANDIDATE_REPAIR_*`, `AY_HARNESS_RECOVERY_*`, `CONTRACT_OBLIGATION_RECOVERY_*` (Run AV), `FLUID_PRESERVATION_PROOF_*` (AW F1), `GOAL_ADMISSION_CANCEL_FENCE_*` | Diagnosis, fix plans, reviews and proofs for one run's failure |
| Green-science runs | `LUNA_GREEN_LIVE_RUN_<F…M>_*`, `GREEN_SCIENCE_*` | October 12–15 |
| Luna trials and repairs | Other `LUNA_*` files | October 5–13 |
| CLI-proxy trials | `CLI_PROXY_*` | October 5–15 |
| Recovery units | `UNIT17_*` to `UNIT22_*` | October 14–15 |
| Jev trials and checkpoints | `JEV_CLOUD_PROVIDER_TRIAL_*`, `JEV_CLOUD_BURNER_CANARY_ATTEMPT*`, other `JEV_*` files | September 19–25 |
| Playable build | `PLAYABLE_*` | October 2–5 |
| Pterodactyl | `PTERODACTYL_*` | September 14 v8 staging and release candidate |
| Session handoffs | `*HANDOFF*` | Superseded handoffs between sessions |
| Finished work plans and superseded designs | `PARALLEL_PRODUCTION_WORK_PLAN.md`, `NPC_USER_EXPERIENCE_WEEKLY_PLAN_2026-09-28.md`, `NPC_PLANNING_REFACTOR_INTEGRATION.md`, `NPC_RELIABILITY_WORK.md`, `JEV_DECISION_LAYER_ARCHITECTURE.md`, `CONSOLE_UI_P0_PLAN.md` | Closed checklists and designs replaced by current contracts |

Other files are single dated checkpoints; search by topic word and date.
