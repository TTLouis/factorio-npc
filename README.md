# Factorio NPC

**SGLuna is an AI teammate that lives inside a Factorio world.** It controls a
standalone character with real inventory, crafting and mining, and can operate
on a headless server with nobody connected.

> [!NOTE]
> **Use this branch for current development. Jev is optional:**
> `experiment/jev-agent-architecture` also runs without a Jev/TypeSafe key.
> For Docker, leave `JEV_TYPESAFE_API_KEY` blank to disable Jev. Your main LLM
> provider is still required; the runtime uses its non-Jev decision paths.

The runtime gives models structured game observations and bounded actions.
Deterministic code handles game facts, validation and recovery; Factorio remains
the source of truth. Computer vision is not required.

**Status: experimental and under active development.** Runtime operations and
deterministic tests do not establish reliable autonomous factory building.
Repeatable autonomous science production remains unproven. Read the
[current status and exact-commit evidence](docs/NPC_AGENT_HARNESS_STATUS.md) before
choosing a checkpoint; newer development is not automatically a stable release.

## Start here

| Your goal | Next step |
| --- | --- |
| Run SGLuna on your own server | [Docker setup](deploy/docker/README.md) or [Pterodactyl setup](deploy/pterodactyl/README.md) |
| Help with a bug, test or explanation | [Contributing](CONTRIBUTING.md) |
| Understand the design | [Project contract](SPEC.md) and [documentation index](docs/README.md) |
| Work with a coding agent | [AGENTS.md](AGENTS.md) |

## What is in the project?

- A standalone NPC body, independent of a connected human player.
- Structured inventory, navigation, crafting, research, combat and construction
  operations, with actor/operation correlation and validated admission.
- Deterministic recipe, production-planning and transport-capacity helpers.
- A planning harness and in-game task/plan UI, provider budgets and behavior traces.
- Persistent saves, managed release rollback, and Docker/Pterodactyl deployment.

Capability is verified in stages: contract tests, deterministic real-engine lanes,
then an explicitly frozen provider-backed trial. Successful placement is not proof
of production. See the [production validation ladder](docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md)
for acceptance criteria and the status page for current limits.

Single-NPC reliability and grounded production are the current focus. Wider
swarm coordination, vehicles/trains/platforms and optional vision are later work.

## Run a server

You need Docker or a Pterodactyl host, a compatible Factorio setup, and credentials
for your chosen model provider. Provider-backed operation may incur API charges.
Offline contribution/tests do not require production credentials.

For Docker, follow the full [setup guide](deploy/docker/README.md). Its basic
startup, after configuration, is:

```sh
cp .env.example .env
# Edit .env locally: set FACTORIO_RCON_PASSWORD and the required provider settings.
# For this branch, set SGLUNA_SOURCE_REF=experiment/jev-agent-architecture (or an exact SHA).
docker compose up -d --build
```

The Compose build defaults to `main`. Set `SGLUNA_SOURCE_REF` deliberately for a
development build, or pin a full commit SHA for reproduction. Keep credentials
outside Git, and use your own persistent data directory.

For Pterodactyl, choose a channel and follow its
[configuration and update guide](deploy/pterodactyl/README.md):

| Egg | Default source | Purpose |
| --- | --- | --- |
| [Main](deploy/pterodactyl/egg-sgluna-factorio-server.json) | `main` | Stable baseline |
| [NPC E2E / Jev Experiment](deploy/pterodactyl/egg-sgluna-factorio-npc-e2e.json) | `experiment/jev-agent-architecture` | Experimental development |

Restart keeps the installed code. Pterodactyl reinstall resolves the selected
ref again. Docker can reuse its source layer; use an exact SHA or the Docker
guide's `SGLUNA_SOURCE_NONCE` procedure to pick up a branch update.
Managed Pterodactyl installs provide `rollback-sgluna.sh` and preserve saves,
user mods and non-secret configuration across completed releases.

SGLuna uses `SGLUNA_*` settings, `sgluna-config.json` and `!luna` chat input.
Legacy AIRI settings/input aliases are documented in the deployment guide.

## Contribute

Development integrates into **`experiment/jev-agent-architecture`**; `main` is the
stable baseline. See [CONTRIBUTING.md](CONTRIBUTING.md) for small first changes,
bug reports and pull requests, and [TESTING.md](docs/TESTING.md) for commands.
The shared Windows checkout requires Docker tests because its dependency
folders are WSL symlinks; do not run a Windows host package install there.

Useful starting areas are setup feedback, clearer documentation and deterministic
regressions for reproducible failures. The [development workflow](docs/DEVELOPMENT_WORKFLOW.md)
defines scope, evidence and review. [Authorized live trials](docs/LIVE_E2E.md)
are separate from ordinary tests. The opt-in
[desktop operator adapter](tools/desktop-rcon-operator.mjs) is an operator/test
surface, not autonomous provider operation.

## Origin, license and credits

Factorio NPC originated from [moeru-ai/airi-factorio](https://github.com/moeru-ai/airi-factorio)
and the original `autorio` work, and has since diverged into a standalone NPC
runtime. Git history and upstream attribution are preserved under the
[MIT license](LICENSE). The [migration tracker](docs/PROJECT_MIGRATION_TRACKER.md)
records the identity transition.

The [provider avatars](packages/autorio/graphics/icons/provider/) are AI-generated
character art, not human illustrations or official vendor artwork.
