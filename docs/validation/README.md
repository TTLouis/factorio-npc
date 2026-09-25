# Validation history

This directory contains historical evidence and superseded checkpoint documents. Files here are intentionally immutable descriptions of the commit/state they were written for; they are not the current roadmap or deployment manual.

Current documentation lives in:

- `../../README.md` — project overview and branch/deployment model;
- `../NPC_AGENT_HARNESS_PLAN.md` — current single-NPC roadmap and promotion gates;
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

When a new promotion checkpoint is validated, add a new dated file here. Do not rewrite an older record to make it describe a newer commit.
