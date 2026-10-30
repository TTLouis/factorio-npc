# Documentation

Start with the page that matches your task. Architecture/design documents define
contracts; the status page and dated evidence establish what has been verified.

## Use or contribute

| I want to… | Read |
| --- | --- |
| Understand SGLuna and its limits | [Project overview](../README.md), [current status](NPC_AGENT_HARNESS_STATUS.md) |
| Run a server | [Docker](../deploy/docker/README.md) or [Pterodactyl](../deploy/pterodactyl/README.md) |
| Use an external Codex/Claude harness | [Experimental local MCP operator](EXTERNAL_HARNESS.md) |
| Make a first contribution or report a bug | [Contributing](../CONTRIBUTING.md) |
| Work with a coding agent | [AGENTS.md](../AGENTS.md) |
| Choose tests and a supported environment | [Testing](TESTING.md) |
| Scope, review and integrate a task | [Development workflow](DEVELOPMENT_WORKFLOW.md) |
| Understand the project contract | [SPEC.md](../SPEC.md) |

## Find the owning contract

| Area | Reference |
| --- | --- |
| Character, inventory and standalone actor | [Character architecture](NPC_CHARACTER_ARCHITECTURE.md) |
| Runtime/adapters and shared tool contracts | [Architecture ownership](ARCHITECTURE_OWNERSHIP.md), [tool manifest](../contracts/factorio-tool-contract.json) |
| Harness direction and promotion gates | [Harness plan](NPC_AGENT_HARNESS_PLAN.md) |
| Goal, Roadmap Shelf, Active Plan and Jev authority | [Planning roadmap](NPC_PLANNING_ROADMAP.md) |
| Task interruption, authority and campaign allowance | [Macro execution design](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md) |
| Production capability and engine proof | [Production validation ladder](NPC_PRODUCTION_VALIDATION_ROADMAP.md) |
| Spatial placement | [Placement architecture](NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md) |
| Repairing an E2E failure | [Repair requirements](E2E_REPAIR_REQUIREMENTS.md) |
| Running an authorized provider trial | [Live E2E procedure](LIVE_E2E.md) |
| Accelerated trial profiles | [Tick-sprint contract and adoption gates](E2E_TICK_SPRINT.md) |

Other design and dated work notes in this directory provide subsystem context;
their existence does not establish implementation or current readiness. In
particular, swarm/vision proposals are separate from the single-NPC baseline.

## History and documentation maintenance

[Validation history](validation/README.md) contains dated runs, checkpoints and
superseded handoffs. Their SHAs, commands and paths describe the recorded run;
they are not instructions to restart it. Use
[current status](NPC_AGENT_HARNESS_STATUS.md) to find the relevant checkpoint.
The [migration tracker](PROJECT_MIGRATION_TRACKER.md) records origin/identity work.

Keep the overview in the root README, contribution steps in CONTRIBUTING, coding
agent rules in AGENTS, and test commands in TESTING. Update an existing owning
document before adding a competing roadmap. Preserve existing filenames and
historical evidence so old links and retained run references remain usable.
