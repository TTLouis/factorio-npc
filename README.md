# Factorio NPC

> [!IMPORTANT]
> **Factorio NPC** is an independent, headless-first autonomous NPC runtime for Factorio servers. This project originated as a fork of [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio), but has substantially diverged from the original CV/YOLO-driven game-playing architecture. Upstream history and attribution are intentionally preserved.

The project is designed for persistent server-side NPCs that live inside a real Factorio simulation. NPCs use structured game state, deterministic helpers, and validated operations instead of depending on screenshots or a connected human player.

## Project direction

The target architecture is:

```text
Factorio headless server
        ↓
Factorio Lua runtime / remote interfaces
        ↓
structured observations + deterministic game logic
        ↓
agent runtime / planning harness
        ↓
LLM strategy and tool selection
        ↓
validated structured operations
        ↓
standalone Factorio NPC character(s)
```

Computer vision is not part of the required runtime. The inherited YOLO work is considered legacy research baggage for the current headless-first architecture; vision may return later only as an optional sensor/research mode.

## Current capabilities

The standalone-NPC baseline includes:

- zero-player NPC ownership backed by a real Factorio `character`;
- structured model operations instead of model-generated Lua;
- actor-aware inventory, entity, navigation, crafting, research, and combat operations;
- deterministic production-planning and transport-capacity helpers;
- transactional operation-batch admission and correlated operation outcomes;
- persistent saves plus managed release rollback;
- loopback-only supervisor-owned RCON;
- Pterodactyl console input forwarded to the real Factorio child process;
- startup reconciliation of `data/server-settings.json` without overwriting unrelated Factorio settings;
- environment-only provider secrets, with effective non-secret provider settings synchronized into `sgluna-config.json`;
- provider timeout/recovery handling so one failed request does not permanently stall the NPC;
- configurable provider request budgeting;
- bounded behavior tracing for E2E/debugging;
- an in-game task/plan UI used by the current NPC harness;
- Docker and Pterodactyl deployment paths for headless servers.

`main` is the stable integration/deployment baseline. `feat/npc-transition-work` remains the active single-NPC integration/E2E line while newer work is promoted in validated checkpoints.

## Validation model

For engine behavior, real Factorio integration evidence is authoritative. Unit/type tests protect contracts and regressions, but they do not by themselves prove Factorio runtime semantics.

```text
feature/integration work
        ↓
ordinary CI + deterministic regressions
        ↓
freeze a candidate SHA
        ↓
package smoke + real zero-player Factorio harness
        ↓
promote validated checkpoint to main
```

Historical validation records live under [`docs/validation/`](./docs/validation/). Current single-NPC roadmap/status live in [`docs/NPC_AGENT_HARNESS_PLAN.md`](./docs/NPC_AGENT_HARNESS_PLAN.md) and [`docs/NPC_AGENT_HARNESS_STATUS.md`](./docs/NPC_AGENT_HARNESS_STATUS.md).

The repository de-fork / identity migration is tracked in [`docs/PROJECT_MIGRATION_TRACKER.md`](./docs/PROJECT_MIGRATION_TRACKER.md).

## Deployment

### Pterodactyl

Two PTDL_v2 eggs keep stable deployments separate from active E2E work:

| Egg | Default source ref | Purpose |
| --- | --- | --- |
| [`deploy/pterodactyl/egg-sgluna-factorio-server.json`](./deploy/pterodactyl/egg-sgluna-factorio-server.json) | `main` | Stable/main deployment |
| [`deploy/pterodactyl/egg-sgluna-factorio-npc-e2e.json`](./deploy/pterodactyl/egg-sgluna-factorio-npc-e2e.json) | `feat/npc-transition-work` | Active NPC/E2E testing |

Fresh deployments use **SGLuna** end to end: `SGLUNA_*` deployment variables, `sgluna-config.json`, `start-sgluna.sh`, `rollback-sgluna.sh`, and `!luna`. Legacy `AIRI_*` variables, `airi-config.json`, `start-airi.sh`, `rollback-sgluna.sh`, and `!airi` remain compatibility aliases. The internal `.airi/` state directory plus actor/protocol/save identifiers remain intentionally unchanged.

**Restart does not update application code.** A normal server restart keeps the already installed managed release.

**Reinstall resolves the egg's `SGLUNA_SOURCE_REF` again.** The installer resolves the configured branch/tag/ref to one exact Git commit SHA, validates and builds that exact snapshot transactionally, records the SHA in the installed manifest, and only then activates it. A failed install leaves the previous completed release active.

Set `SGLUNA_SOURCE_REF` to a full 40-character commit SHA when reproducing a specific E2E failure. Managed installs also provide `rollback-sgluna.sh` to return to the previous completed release without rewriting saves, user mods, or `sgluna-config.json`.

See [`deploy/pterodactyl/README.md`](./deploy/pterodactyl/README.md) for import, configuration, testing, runtime, and rollback details.

### Docker Compose

Docker Compose support is included through [`compose.yml`](./compose.yml) and [`deploy/docker/`](./deploy/docker/). It is a thin deployment wrapper around the same standalone-NPC runtime rather than a second implementation.

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY, OPENAI_API_BASEURL, and OPENAI_MODEL.
docker compose up -d --build
```

See [`deploy/docker/README.md`](./deploy/docker/README.md) for source pinning, configuration, persistence, console attach, and shutdown details.

### Interactive desktop operator adapter

[`tools/desktop-rcon-operator.mjs`](./tools/desktop-rcon-operator.mjs) is an opt-in Node adapter for an interactive desktop session, including Codex. It is intentionally **not** an autonomous replacement for a configured provider: the desktop operator chooses the next action while the adapter only exposes the existing bounded observation and operation contracts over local HTTP.

For a local E2E run, set a distinct `DESKTOP_OPERATOR_TOKEN` (at least 16 characters) and start the normal stack with the E2E and operator overlays:

```bash
docker compose -f compose.yml -f compose.e2e.yml -f compose.desktop-operator.yml --profile desktop-operator up -d --build
```

The adapter binds to `127.0.0.1` only. Its `/observe` and `/operate` endpoints require `Authorization: Bearer <DESKTOP_OPERATOR_TOKEN>`; operations stay schema-validated and run deterministic preflight before they are admitted to Factorio. It is a test/operator surface, not a public API and does not expose raw RCON or arbitrary Lua. The Compose service reaches RCON only through the internal Docker network.

## Development

Install workspace dependencies with:

```bash
pnpm install
```

The active runtime and E2E/deployment harness live primarily under:

```text
deploy/pterodactyl/
deploy/docker/
packages/agent/
packages/autorio/
tests/factorio/
```

Useful deployment checks include:

```bash
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
pnpm test:npc
```

`pnpm test:npc` needs a working local Docker daemon. In a sandboxed cloud container (for example Claude Code on the web), use `pnpm test:npc:cloud` instead: it starts `dockerd` if needed, pulls base images through a registry mirror to avoid Docker Hub rate limits, trusts the sandbox egress-proxy CA inside a generated copy of the test Dockerfile, and copies lane logs to `test-results/factorio/`. Select lanes with `NPC_TEST_LANES=core,production` and use `NPC_TEST_PARALLEL=0` for ordered debug output; `--no-build` reruns the last image.

Repository CI does not use production provider credentials.

## Roadmap

Near-term work is deeper single-NPC E2E coverage, deterministic production/construction constraints, and progressively stronger planning/runtime contracts. Multi-agent/swarm coordination should build on the validated single-NPC runtime rather than bypass it.

The guiding boundary is:

- **deterministic code** computes game facts, constraints, ratios, capacities, and validated candidate actions;
- **LLMs** choose goals, strategy, priorities, and among already-grounded alternatives;
- **Factorio** remains the source of truth for simulation state.

## Origin, license, and credits

Factorio NPC was originally derived from [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio) and the original `autorio` work. The Git history is intentionally retained so the lineage remains auditable.

The repository remains MIT-licensed. The existing upstream copyright notice in [`LICENSE`](./LICENSE) is preserved. Project-specific attribution may be added without removing upstream attribution as the independent codebase evolves.

The provider avatars in [`packages/autorio/graphics/icons/provider/`](./packages/autorio/graphics/icons/provider/) - the character art the console's top-left button shows for whichever model is answering - are AI-generated images. They are not the work of a human illustrator and are not any vendor's official artwork.
