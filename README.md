# Factorio NPC

An AI teammate that lives inside a Factorio world, with its own character,
inventory and native game actions.

> [!IMPORTANT]
> **For the current project, use
> [`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/tree/experiment/jev-agent-architecture).**
> That branch contains the current SGLuna runtime, documentation and development.
> **Jev is optional on that branch:** it also runs without a Jev/TypeSafe key.
> For Docker, leave `JEV_TYPESAFE_API_KEY` blank; your main LLM provider is still
> required. The branch name does not mean you must enable Jev.

`main` retains an older AIRI-era runtime snapshot. This documentation update does
not promote the newer runtime to `main`. Its settings, scripts and evidence differ
from current development, so follow the documentation on the branch you run.

## Start with current development

```sh
git clone --branch experiment/jev-agent-architecture https://github.com/TTLouis/factorio-npc.git
cd factorio-npc
```

| Your goal | Current guide on the Jev branch |
| --- | --- |
| Run a server | [Docker](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/deploy/docker/README.md) or [Pterodactyl](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/deploy/pterodactyl/README.md) |
| Make a first contribution | [Contributing](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/CONTRIBUTING.md) |
| Understand the design | [Project contract](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/SPEC.md) and [documentation index](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/docs/README.md) |
| Check demonstrated behavior and limits | [Current status](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/docs/NPC_AGENT_HARNESS_STATUS.md) |

## What the project does

The NPC uses structured game observations and bounded operations, rather than
screenshots or a connected human player's body. Deterministic code owns game
facts, admission, receipts and recovery; Factorio remains the simulation authority.
Computer vision is not required. The runtime supports standalone actors, inventory,
navigation, crafting, research and combat operations, with server deployment and
saved state.

The project is experimental. Operation admission, placement and passing static
tests do not prove reliable autonomous factory building. Check exact-commit
native evidence before relying on a capability. Single-NPC reliability and grounded
production remain the focus; swarm coordination and optional vision are later work.

## Working with this main snapshot

For existing deployments pinned to `main`, the local
[documentation index](docs/README.md) links its retained setup, architecture and
evidence. This snapshot uses `AIRI_*`, `airi-config.json` and the older deployment
files. Do not mix current SGLuna settings or test commands into it.

New development and ordinary contributions target the Jev branch.
[CONTRIBUTING.md](CONTRIBUTING.md) explains the branch distinction, and
[AGENTS.md](AGENTS.md) provides coding-agent rules for this snapshot.

## Origin and license

Factorio NPC originated from [moeru-ai/airi-factorio](https://github.com/moeru-ai/airi-factorio)
and the original `autorio` work. Git history and upstream attribution are preserved
under the [MIT license](LICENSE). The retained
[migration tracker](docs/PROJECT_MIGRATION_TRACKER.md) records the earlier identity work.
