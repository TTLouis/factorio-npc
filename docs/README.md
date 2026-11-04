# Documentation

Start with the page that matches your task. This repository holds two lines that
share one standalone NPC: the **external harness** on `main`, where your own AI
harness drives the NPC through MCP, and the **built-in planner/Jev** line,
developed on `experiment/jev-agent-architecture`. Contracts say what must hold;
the [status page](NPC_AGENT_HARNESS_STATUS.md), [proofs](proofs/README.md) and
dated records say what has been verified.

## Use or contribute

| I want to… | Read |
| --- | --- |
| Understand SGLuna and its limits | [Project overview](../README.md), [current status](NPC_AGENT_HARNESS_STATUS.md) |
| Run a server | [Docker](../deploy/docker/README.md) or [Pterodactyl](../deploy/pterodactyl/README.md) |
| Set up an external AI harness | [Portable automatic setup](EXTERNAL_HARNESS_SETUP.md), [local MCP runtime/tools](EXTERNAL_HARNESS.md) |
| See demonstrated external-harness progress | [Latest proofs and in-game screenshots](proofs/README.md), [release notes](releases/external-harness-v0.1.0-pre.1.md) |
| Make a first contribution or report a bug | [Contributing](../CONTRIBUTING.md) |
| Work with a coding agent | [AGENTS.md](../AGENTS.md) |
| Choose tests and a supported environment | [Testing](TESTING.md) |
| Scope, review and integrate a task | [Development workflow](DEVELOPMENT_WORKFLOW.md) |
| Understand the project contract | [SPEC.md](../SPEC.md) |

## Shared contracts

These apply to the NPC whichever line controls it.

| Area | Reference |
| --- | --- |
| Character, inventory and standalone actor | [Character architecture](NPC_CHARACTER_ARCHITECTURE.md) |
| Runtime/adapters and shared tool contracts | [Architecture ownership](ARCHITECTURE_OWNERSHIP.md), [tool manifest](../contracts/factorio-tool-contract.json) |
| Spatial placement | [Placement architecture](NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md) |
| Production capability and engine proof | [Production validation ladder](NPC_PRODUCTION_VALIDATION_ROADMAP.md) |
| Repairing an E2E failure | [Repair requirements](E2E_REPAIR_REQUIREMENTS.md) |

## Built-in planner and Jev contracts

These describe the `experiment/jev-agent-architecture` line. Their presence on
`main` does not mean `main` runs the built-in planner. Several are approved
designs that are only partly built; each page's status line says how far.

| Area | Reference |
| --- | --- |
| Harness direction and promotion gates | [Harness plan](NPC_AGENT_HARNESS_PLAN.md) |
| Goal, Roadmap Shelf, Active Plan and Jev authority | [Planning roadmap](NPC_PLANNING_ROADMAP.md) |
| Jev's role and limits | [Jev coprocessor architecture](NPC_JEV_COPROCESSOR_ARCHITECTURE.md) |
| Task interruption, authority and campaign allowance | [Macro execution design](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md) |
| Planner/executor delegation inside one NPC | [Delegation design](NPC_DELEGATION_DESIGN_2026-09-29.md) |
| Provider failure, continuation and waits | [Provider continuation and recovery](NPC_PROVIDER_CONTINUATION_RECOVERY.md) |
| Experimental opt-in executor progress audit (off by default) | [Executor progress auditor](EXECUTOR_PROGRESS_AUDITOR.md) |
| Running an authorized provider trial | [Live E2E procedure](LIVE_E2E.md) |
| Accelerated trial profiles | [Tick-sprint contract and adoption gates](E2E_TICK_SPRINT.md) |

## Proposals and experiments

These are designs, plans and experiments, not current contracts; none
establishes current readiness. Swarm and vision work stays separate from the single-NPC baseline.

| Topic | Reference | Status |
| --- | --- | --- |
| Engine-backed experiment workshop | [Experiment surface](NPC_EXPERIMENT_SURFACE.md) | Design draft |
| Large-build site proposal and ghost staging | [Site, ping and ghost staging](NPC_SITE_PING_GHOST_STAGING.md) | Planned requirements |
| Multi-NPC coordination | [Swarm coordination](SWARM_COORDINATION_ARCHITECTURE.md) | Planned architecture |
| Executor run-ahead during a native batch | [Run-ahead design](NPC_EXECUTOR_RUN_AHEAD_DESIGN_2026-10-18.md) | Shelved October 18, 2026 |
| Planner skill discovery and factory guides | [Two-run comparison plan](PLANNER_SKILLS_CONTEXT_EXPERIMENT.md) | Experiment plan, October 27, 2026 |
| Learning and bootstrap validation gates | [Learning + bootstrap E2E](NPC_LEARNING_BOOTSTRAP_E2E.md) | Earlier gate plan |

## History and documentation maintenance

[Validation history](validation/README.md) contains dated runs, repair notes,
checkpoints, finished work plans and superseded designs. Their SHAs, commands
and paths describe the recorded run; they are not instructions to restart it.
The [status log](validation/NPC_AGENT_HARNESS_STATUS_LOG_2026-09-16_TO_2026-10-24.md)
holds the dated status checkpoints through October 24, 2026. The
[migration tracker](PROJECT_MIGRATION_TRACKER.md) records origin/identity work.

Keep the overview in the root README, contribution steps in CONTRIBUTING, coding
agent rules in AGENTS, and test commands in TESTING. Update an existing owning
document before adding a competing roadmap. Put dated repair notes, run records
and closed work plans in `validation/`, not beside the contracts here. Preserve
existing filenames and historical evidence so old links and retained run
references remain usable.
