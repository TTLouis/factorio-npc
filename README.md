# Factorio NPC — Built-in plan mode

![Mode: built-in plan](https://img.shields.io/badge/mode-built--in%20plan-7c3aed?style=flat-square)
![Status: experimental](https://img.shields.io/badge/status-experimental-d97706?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

Run an AI teammate inside your Factorio world, with its own character,
inventory, crafting and mining. The built-in planner and executor use your
model provider directly; no external AI assistant needs to stay connected.

**[Install](#install) · [Use your NPC](#use-your-npc) · [Choose your harness](#choose-your-harness)**

---

## Install

You need Docker, Git, and credentials for a supported model provider. The
server runs headless and can operate with no human players connected. This
mode is experimental; reliable autonomous factory building remains unproven.

### Docker

Run these commands in a POSIX shell, such as Git Bash:

```sh
git clone --single-branch --branch feat/builtin-harness-plan https://github.com/TTLouis/factorio-npc.git factorio-npc-plan
cd factorio-npc-plan
cp .env.example .env
```

Edit `.env` locally to set `FACTORIO_RCON_PASSWORD` and your provider settings.
**Jev is optional:** leave `JEV_TYPESAFE_API_KEY` blank to run without it. Your
main model provider is still required. Then start the server:

```sh
export SGLUNA_SOURCE_REF=feat/builtin-harness-plan
docker compose up -d --build
docker compose logs -f sgluna-factorio
```

> [!IMPORTANT]
> Keep the explicit source selection above: it selects plan mode even though
> the Compose default is `main`.

Follow the [Docker guide](deploy/docker/README.md) for configuration, joining
the game, persistent data, shutdown and updates. Keep `.env` private; provider
usage may incur charges. Restarting keeps the installed code; updating needs
a deliberate rebuild with the source revision you want.

### Pterodactyl

Follow the [Pterodactyl setup guide](deploy/pterodactyl/README.md) and use the
[NPC E2E / Jev Experiment egg](deploy/pterodactyl/egg-sgluna-factorio-npc-e2e.json).
Set its source ref to `feat/builtin-harness-plan`, or an exact commit from that
branch. Configure your provider and use your own persistent data directory;
reinstalling resolves the selected source again.

---

## Use your NPC

SGLuna uses `!luna` chat input and `sgluna-config.json`. See the server setup
guide for connection and configuration instructions. Give the NPC a goal; its
planner breaks the work into steps and its executor carries them out through
bounded native game actions.

Read [current status](docs/NPC_AGENT_HARNESS_STATUS.md) for verified capabilities
and known limits before relying on autonomous production.

---

## Choose your harness

Choose how you want to control your NPC. Each branch has its own setup and
experimental status.

| Line | Branch | How it works |
| --- | --- | --- |
| External harness | [`main`](https://github.com/TTLouis/factorio-npc/tree/main) | Your external AI assistant plans and operates the NPC through MCP. |
| Built-in harness: plan mode | [`feat/builtin-harness-plan`](https://github.com/TTLouis/factorio-npc/tree/feat/builtin-harness-plan) | An internal planner and executor follow committed plans and step contracts; Jev is optional. |
| Built-in harness: pursuit mode | [`feat/builtin-harness-pursuit`](https://github.com/TTLouis/factorio-npc/tree/feat/builtin-harness-pursuit) | One internal operator model pursues the goal through tools, with a notebook and native goal evaluation. In development. |

---

## How plan mode works

The planner commits a plan, and the executor works through steps with explicit
completion checks. The harness handles game facts, operation admission,
receipts, budgets and recovery. Optional Jev helps rank or route decisions;
the harness determines whether work is permitted and complete.

The NPC follows native inventory, crafting, mining, research and collision
rules. It uses structured game observations; computer vision is not required.
Successful placement alone does not establish a working production line.

---

## Contribute

Plan-mode work belongs on `feat/builtin-harness-plan`, previously named
`experiment/jev-agent-architecture`. See [Contributing](CONTRIBUTING.md), the
[documentation index](docs/README.md), [testing guide](docs/TESTING.md) and
[agent instructions](AGENTS.md) for development requirements.

---

## Origin, license and credits

Factorio NPC originated from [moeru-ai/airi-factorio](https://github.com/moeru-ai/airi-factorio)
and the original `autorio` work, and has since diverged into a standalone NPC
runtime. Git history and upstream attribution are preserved under the
[MIT license](LICENSE). The [migration tracker](docs/PROJECT_MIGRATION_TRACKER.md)
records the identity transition.

The [provider avatars](packages/autorio/graphics/icons/provider/) are AI-generated
character art, not human illustrations or official vendor artwork.
