# Factorio NPC — Built-in pursuit mode

![Mode: built-in pursuit](https://img.shields.io/badge/mode-built--in%20pursuit-0f766e?style=flat-square)
![Status: experimental](https://img.shields.io/badge/status-experimental-d97706?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

An AI teammate for your Factorio world, controlled by one built-in operator
model. Give it a goal and it works through game tools, keeping notes as it goes.

**[Install](#install) · [Availability](#current-availability) · [Choose your harness](#choose-your-harness)**

---

## Install

> [!IMPORTANT]
> **Pursuit mode is not yet available as a ready-to-run installation.** A
> pursuit-mode startup path has not been integrated. Existing Docker/Pterodactyl
> startup launches plan mode, not pursuit mode.

There is no supported pursuit-mode install command at this checkpoint. The
startup integration must be completed before this branch can offer a user
installation guide.

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

## What pursuit mode does

One model observes the world, chooses bounded actions and reads their results.
It uses a persistent notebook to keep its working plan and lessons, and can
start a fresh conversation when its context fills up. Factory cells are an
optional tool; a committed step-by-step plan is not required.

The harness handles operation admission, native receipts, safety fences,
budgets and goal evaluation. The model cannot declare success on its own.
The NPC keeps native inventory, crafting, mining, research and collision
rules, and does not need a connected human player or computer vision.

---

## Current availability

The operator tools, loop, notebook/context rotation, provider client and
supervisor are implemented as modules. Native integration and a live comparison
remain outstanding at this checkpoint. **No pursuit-mode live production result
has been established.**

The initial comparison targets red-science production and Automation research.
Production statistics also count hand-crafted packs, so the default goal check
alone does not prove machine-only or fully electrified automation.

The external harness has separate
[recorded results](https://github.com/TTLouis/factorio-npc/blob/main/docs/proofs/README.md).
Those results do not establish pursuit-mode success.

---

## Contribute

Pursuit-mode work belongs on `feat/builtin-harness-pursuit`. This line starts
from plan mode and includes external-harness tools through main `560529b4`;
later main changes are not automatically included.

Start with [Contributing](CONTRIBUTING.md), [testing](docs/TESTING.md) and
[agent instructions](AGENTS.md). The implementation is in the
[operator loop](deploy/pterodactyl/runtime-v8/operator-loop.mjs),
[shared tools](deploy/pterodactyl/runtime-v8/operator-tool-surface.mjs),
[provider client](deploy/pterodactyl/runtime-v8/operator-provider.mjs) and
[supervisor](deploy/pterodactyl/runtime-v8/pursuit-supervisor.mjs).

---

## Origin, license and credits

Factorio NPC originated from [moeru-ai/airi-factorio](https://github.com/moeru-ai/airi-factorio)
and the original `autorio` work, and has since diverged into a standalone NPC
runtime. Git history and upstream attribution are preserved under the
[MIT license](LICENSE). The [migration tracker](docs/PROJECT_MIGRATION_TRACKER.md)
records the identity transition.

The [provider avatars](packages/autorio/graphics/icons/provider/) are AI-generated
character art, not human illustrations or official vendor artwork.
