# Factorio NPC project contract

This `main` snapshot controls a standalone Factorio character through structured
observations and bounded operations. Zero connected humans is valid; native game
mechanics and authoritative world-state verification are required.

Current development lives on
[`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/tree/experiment/jev-agent-architecture),
which also runs without Jev enabled. Use its
[current contract](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/SPEC.md)
for newer planning, tool and recovery semantics. This summary does not claim those
newer contracts are implemented in `main`.

For this snapshot, [AGENTS.md](AGENTS.md) owns coding constraints,
[character architecture](docs/NPC_CHARACTER_ARCHITECTURE.md) owns the actor/body,
and the [harness plan](docs/NPC_AGENT_HARNESS_PLAN.md) owns its design direction.
[Status](docs/NPC_AGENT_HARNESS_STATUS.md) and
[dated validation](docs/validation/README.md) establish evidence at their recorded
SHAs, not current readiness. The [documentation index](docs/README.md) separates
these retained references from current development guides.
