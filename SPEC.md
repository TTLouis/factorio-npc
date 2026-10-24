# Factorio NPC project contract

SGLuna serves Factorio server owners and players by carrying out requested work
with a persistent, standalone in-world character, including with zero connected
humans. This is a navigation summary; the linked design documents own the details.
Use the [documentation index](docs/README.md) to choose a guide and
[CONTRIBUTING.md](CONTRIBUTING.md) for a first contribution.

Jev is optional on `experiment/jev-agent-architecture`. With no decision-provider
key configured, the runtime uses non-Jev decision paths; a main LLM provider is
still required. In Docker, leave `JEV_TYPESAFE_API_KEY` blank. These configuration
choices do not change the runtime's authority or gameplay acceptance contracts.

| Boundary | Required behavior | Authority |
| --- | --- | --- |
| Body | Real inventory, reach/collision, native crafting/mining, death and save/restart behavior; stale actor work fails safely | [Character architecture](docs/NPC_CHARACTER_ARCHITECTURE.md), [AGENTS.md](AGENTS.md) |
| Decisions | Structured observations and bounded operations; deterministic recipe/topology/geometry facts where available | [Harness plan](docs/NPC_AGENT_HARNESS_PLAN.md) |
| Planning | User Goal, non-executable LOD Shelf and immutable committed Active Plan; Main LLM authors drafts; Jev selects/routes without granting authority or advancing completion | [Planning roadmap](docs/NPC_PLANNING_ROADMAP.md), [macro design](docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md) |
| Completion | Admission is not completion; correlate receipts and verify the requested world state | [Production validation ladder](docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md) |
| Deployment | Environment settings take precedence; credentials stay outside Git and non-secret config; preserve user saves/config during upgrades | [Pterodactyl contract](deploy/pterodactyl/README.md) |

## Acceptance and evidence

Each task names an observable outcome and the evidence that would disprove it.
Unit/type/static gates protect contracts. Real Factorio lanes prove engine
semantics. A frozen candidate's autonomous trial proves only that recorded run;
it does not promote every newer commit. Keep unknown and partial effects explicit.

The [current status](docs/NPC_AGENT_HARNESS_STATUS.md) and exact-SHA records under
[docs/validation](docs/validation/) describe evidence, not a blanket readiness claim.
Use the [development workflow](docs/DEVELOPMENT_WORKFLOW.md) to select gates and
record limitations. The existing roadmaps retain their phase and exit criteria.

## Scope and toolchain

Single-NPC reliability and validated production are the current focus. Swarms,
vehicles/trains/platforms and optional vision remain later work. Fake gameplay
completion, arbitrary model-generated code, and player impersonation are outside
the runtime contract. Do not bypass uncertainty fences to improve success counts.

Use `package.json`'s pinned package manager and `pnpm-lock.yaml` with frozen
installs in supported containers/CI. CI specifies Node; `tests/factorio/Dockerfile`
pins the deterministic engine version. Record actual image/engine versions in
evidence; deployment's configurable Factorio version is a separate setting.
Windows dependency symlinks must remain untouched. Live model/Jev runs and live
deployment follow the explicit authorization rules in `AGENTS.md`.
