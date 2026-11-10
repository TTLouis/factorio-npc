<h1 align="center">Factorio NPC</h1>

<p align="center">
  <img alt="Modes: external, plan, pursuit" src="https://img.shields.io/badge/modes-external%20%7C%20plan%20%7C%20pursuit-2563eb?style=flat-square">
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-experimental-d97706?style=flat-square">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-64748b?style=flat-square"></a>
</p>

<p align="center">
  <strong>SGLuna is an AI teammate that lives inside a Factorio world.</strong> It controls a standalone character with real inventory, crafting and mining, and can operate on a headless server with nobody connected.
</p>

<p align="center">
  <strong><a href="#install-and-connect-your-ai-assistant">Install</a> · <a href="#latest-proof">Latest proof</a> · <a href="#choose-your-harness">Choose your harness</a></strong>
</p>

---

## Install and connect your AI assistant

In `external` mode, a local AI harness controls your
standalone Factorio NPC through MCP. Your assistant
plans the work and directs native game actions through a local connection.

This workflow is one of three experimental modes shipped together on `main`.
**Quick setup:** paste this into an assistant with local command access
and automatic setup enabled:

```text
Set up https://github.com/TTLouis/factorio-npc/tree/main
for this harness. Follow the repository setup instructions and stop when ready
for my goal.
```

The [portable setup instructions](docs/EXTERNAL_HARNESS_SETUP.md) let the
assistant prepare a private game, connect your harness and verify it is ready.
They cover different local harnesses and explain what remote-only clients need.

> [!TIP]
> Setup prepares the connection and stops ready for your goal. Your assistant
> needs local command access, runtime permissions and authorized Factorio access.

Once setup is complete, give your connected assistant a goal in its own chat.
The assistant observes the world through MCP, plans the work, submits bounded
game actions and reads their results before deciding what to do next. You can
review its progress and redirect it through your usual harness conversation.

The game bridge validates actions and returns native observations and operation
receipts. Your assistant handles planning and responding to refusals or changed
conditions. Computer vision is not required. For manual setup and tool usage,
see the [runtime guide](docs/EXTERNAL_HARNESS.md). The assistant can consult the
[knowledge and gameplay method library](docs/EXTERNAL_HARNESS.md#read-only-method-library)
for methods, and use current game observations for recipes and other game facts.

**Status: experimental external-harness integration.** Results depend on your
assistant, model and goal. The [latest proof](#latest-proof) documents measured
automatic science production and lab delivery, with the remaining limitations.
It does not establish reliable completion of arbitrary gameplay goals.

---

## Choose your harness

All three modes use one codebase on `main`, one native mod and shared world tools.
Select a lifecycle at startup; no branch switch is needed.

| Mode | How it works |
| --- | --- |
| `external` | Your external assistant plans and operates the NPC through stdio MCP. |
| `plan` | Built-in planner and executor follow committed plans and step contracts; Jev is optional. |
| `pursuit` | One built-in operator uses tools, a notebook and native goal evaluation with bounded continuation. |

See [mode selection and setup](docs/HARNESS_MODES.md) for commands, requirements,
compatibility entrypoints and the preserved safety boundaries. All modes remain
experimental; historical evidence applies only to its recorded candidate.

The source CLI defaults to `external`; installed `start-sgluna.sh` defaults to
`plan`. Select the mode explicitly with `--mode` or `SGLUNA_HARNESS_MODE` before
startup. External and pursuit connect to an existing bound host; plan's installed
supervisor owns its Factorio process. Never run competing controllers on one host.

All modes use the same advisory knowledge and skill-method library. Search and
read the relevant entries, then obtain current recipes, resource availability,
geometry and sizing from live game tools. Library text and model judgments do
not grant execution or completion authority; native validation and correlated
receipts do.

---

## Latest proof

### Electrified starter base with automatic red and green science

**November 9, 2026 · External harness · Factorio 2.1.24**

| New science packs | Hands-off measurement | Delivery |
| :---: | :---: | :---: |
| **120 red and 100 green** | **20 game minutes** | **Electric mining, automatic fuel and lab feed** |

The external operator built an electrified starter base from vanilla crash-site
supplies. After construction, the base ran steam power, belt-fed smelting,
science production and research during a hands-off measurement with zero
humans and no operator calls.

![Post-stop view of Trial 6 showing electric mining, smelting, science and steam power](docs/proofs/images/2026-11-09-electrified-red-green/base-overview.jpg)

> [!NOTE]
> **Limits:** production fell short of the trial’s throughput targets. The
> layout had limited space to expand and an unintended belt connection.

**[Read the Trial 6 proof](docs/proofs/2026-11-09-electrified-red-green-science.md)
· [Browse all proofs](docs/proofs/README.md)**

---

## Start here

| Your goal | Next step |
| --- | --- |
| Connect an external AI harness | [Portable setup](docs/EXTERNAL_HARNESS_SETUP.md), [runtime/tool guide](docs/EXTERNAL_HARNESS.md) |
| Run SGLuna on your own server | [Docker setup](deploy/docker/README.md) or [Pterodactyl setup](deploy/pterodactyl/README.md) |
| Help with a bug, test or explanation | [Contributing](CONTRIBUTING.md) |
| Understand the design | [Project contract](SPEC.md) and [documentation index](docs/README.md) |
| Work with a coding agent | [AGENTS.md](AGENTS.md) |

---

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

---

## Branches and development

Use **`main` for external, plan and pursuit**, including optional Jev support
in plan mode. The old `feat/builtin-harness-plan`,
`feat/builtin-harness-pursuit` and integration/experiment refs preserve earlier
work and evidence; they are not required to install or select a mode.

Start a bounded `<type>/<task-slug>` branch from current main and target main
for shared-runtime or mode changes. Reuse the same branch when resuming a task.
In the owner's shared workspace, register and respect checkout ownership before
editing. Explicitly scoped experiments remain separate. See the
[development workflow](docs/DEVELOPMENT_WORKFLOW.md#branches-and-integration-target)
for review, integration and publication rules.

---

## Contribute

Development for all three modes integrates into **`main`**. See
[CONTRIBUTING.md](CONTRIBUTING.md) for small first changes,
bug reports and pull requests, and [TESTING.md](docs/TESTING.md) for commands.
The shared Windows checkout requires Docker tests because its dependency
folders are WSL symlinks; do not run a Windows host package install there.

Useful starting areas are setup feedback, clearer documentation and deterministic
regressions for reproducible failures. The [development workflow](docs/DEVELOPMENT_WORKFLOW.md)
defines scope, evidence and review. [Authorized live trials](docs/LIVE_E2E.md)
are separate from ordinary tests. The opt-in
[desktop operator adapter](tools/desktop-rcon-operator.mjs) is an operator/test
surface, not autonomous provider operation.

---

## Origin, license and credits

Factorio NPC originated from [moeru-ai/airi-factorio](https://github.com/moeru-ai/airi-factorio)
and the original `autorio` work, and has since diverged into a standalone NPC
runtime. Git history and upstream attribution are preserved under the
[MIT license](LICENSE). The [migration tracker](docs/PROJECT_MIGRATION_TRACKER.md)
records the identity transition.

The [provider avatars](packages/autorio/graphics/icons/provider/) are AI-generated
character art, not human illustrations or official vendor artwork.
