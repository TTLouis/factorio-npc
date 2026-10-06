# SGLuna — Factorio Pterodactyl deployment

This directory contains the Pterodactyl deployment for **SGLuna**, the user-facing Factorio NPC/agent identity maintained by TTLouis. The repository remains `TTLouis/factorio-npc`, and upstream AIRI/Autorio lineage and MIT attribution remain documented.

## Deployment channels

There are two PTDL_v2 eggs:

| File | Pterodactyl name | Default `SGLUNA_SOURCE_REF` | Use |
| --- | --- | --- | --- |
| `egg-sgluna-factorio-server.json` | `SGLuna Factorio Server (Main)` | `main` | stable/main servers |
| `egg-sgluna-factorio-npc-e2e.json` | `SGLuna Factorio Server (NPC E2E)` | `feat/npc-transition-work` | active NPC/E2E testing |

Import the desired file through **Admin → Nests → Import Egg**.

For a clean SGLuna deployment, import the new egg and run **Reinstall**. The generated egg exposes SGLuna deployment variables directly; a fresh install does not require AIRI-named variables.

For an existing legacy deployment, re-import the matching SGLuna egg and run Reinstall once. Saves and user mods remain outside the managed release. If only `airi-config.json` exists, its non-secret settings are migrated into canonical `sgluna-config.json`.

Both eggs use:

```text
ghcr.io/ptero-eggs/yolks:debian_bookworm
```

Canonical startup command:

```text
bash ./start-sgluna.sh
```

The only externally exposed SGLuna service required is Factorio's normal game port. Internal RCON is loopback-only and owned by the supervisor.

## Update model

A normal **Restart never resolves a branch and never updates code**.

On **Reinstall**, the selected egg resolves `SGLUNA_SOURCE_REF` to an exact Git commit SHA and installs that exact source snapshot transactionally.

```text
Main:
main -> exact SHA -> validate/build -> activate

NPC E2E:
feat/npc-transition-work -> exact SHA -> validate/build -> activate
```

For reproducible debugging, set `SGLUNA_SOURCE_REF` to an exact 40-character commit SHA before reinstalling.

If both `SGLUNA_SOURCE_REF` and legacy `AIRI_SOURCE_REF` are supplied with different non-empty values, SGLuna wins and the installer prints a compatibility warning.

## Transactional install and rollback

Successful installs stage releases under the internal `.sgluna/releases/` state store and switch the canonical `start-sgluna.sh` symlink only after the new release is complete.

Canonical rollback:

```bash
bash ./rollback-sgluna.sh
```

Legacy `start-airi.sh` and `rollback-airi.sh` are compatibility symlinks to the SGLuna helpers; they do not contain separate implementations.

Rollback changes the managed startup target only. It does not rewrite Factorio saves or user mods.

## Server file layout

```text
/home/container/
├── start-sgluna.sh                # canonical managed startup symlink
├── rollback-sgluna.sh             # canonical managed rollback helper
├── start-airi.sh                  # compatibility symlink -> start-sgluna.sh
├── rollback-airi.sh               # compatibility symlink -> rollback-sgluna.sh
├── sgluna-config.json             # canonical non-secret runtime config
├── airi-config.json               # legacy input only; ignored once canonical config exists
├── README-SGLUNA.txt              # short operator guide
├── client-mods/
│   ├── autorio_0.1.0.zip          # exact client package for users to download
│   └── SHA256SUMS
├── mods/                          # user-installed Factorio mods
├── saves/                         # Factorio saves
├── data/                          # server-settings.json and Factorio writable data
├── logs/
│   ├── sgluna-behavior.jsonl
│   └── sgluna-prompts.jsonl
└── .sgluna/                      # internal managed state; do not edit manually
```

The internal `.sgluna/` directory is authoritative for managed releases, the operation lock, provider budget, durable NPC state, rollback metadata, and runtime temp directories. Worlds and deployments created before the SGLuna rename are disposable test state; there is no migration from the former state directory, actor id, or save keys.

At runtime, managed Autorio is injected into an isolated `.sgluna/run-*/mods/` directory. User mods stay under `mods/`; the downloadable exact client package stays under `client-mods/`.

## Egg variables

Fresh eggs expose these preferred deployment controls:

| Purpose | Setting | Meaning |
| --- | --- | --- |
| Source channel | `SGLUNA_SOURCE_REF` | branch, tag, or exact commit resolved on reinstall |
| Actor ownership | `SGLUNA_ACTOR_MODE` | currently fixed to `npc` |
| Chat authorization | `SGLUNA_CHAT_PLAYERS` | blank/`*` = everyone, `none` = nobody, otherwise comma-separated exact names |
| AI API method | `AI_API_METHOD` | `direct` / `router` / `local`; see "AI provider method" below |
| Provider URL | `OPENAI_API_BASEURL` | OpenAI-compatible endpoint; `direct`/`router` require HTTPS |
| Model list | `OPENAI_MODEL` | comma-separated model identifiers: `[0]` main agent, `[1]` subagent (reserved, not yet used) |
| Provider credential | `OPENAI_API_KEY` | required; environment-only |
| Jev credential | `TYPESAFE_API_KEY` (NPC E2E egg only; local Compose maps `JEV_TYPESAFE_API_KEY` to it) | optional; environment-only; blank disables Jev |
| Provider timeout | `PROVIDER_TIMEOUT_MS` | provider request timeout |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | persisted hourly request cap |
| Save | `SAVE_NAME` | blank chooses newest existing save or creates `sgluna-world.zip` |
| Factorio account | `FACTORIO_USERNAME` / `FACTORIO_TOKEN` | both blank = private/hidden; both set = public |
| Shutdown timeout | `SHUTDOWN_TIMEOUT_MS` | bounded graceful shutdown time |
| Factorio version | `FACTORIO_VERSION` | `latest`, `experimental`, or exact supported 2.0.x |

No separate `PRIVATE_SERVER` flag exists.

### AI provider method

`AI_API_METHOD` picks exactly one wire contract; it replaces hand-picking a `PROVIDER_PROFILE`:

- `direct` — the wire format is detected from `OPENAI_API_BASEURL`'s host and the model, the same as today's default (`auto`) behaviour. Requires HTTPS.
- `router` — the OpenRouter capability profile (reasoning field, style block, cache breakpoints, usage parsing resolved per model). Requires HTTPS.
- `local` — the LM Studio-style local capability profile. Plain `http` is allowed to `localhost`, `127.0.0.1`, `[::1]`, `host.docker.internal`, or a hostname ending in `.ts.net` for a Tailscale tunnel.

For CLIProxyAPI over Tailscale, set `AI_API_METHOD=local`, `OPENAI_API_BASEURL=http://<machine>.<tailnet>.ts.net:18317/v1`, and the exact proxy model ID (for example, `OPENAI_MODEL=gpt-6-luna`). `OPENAI_API_KEY` is the proxy's client API key; upstream OAuth credentials stay in CLIProxyAPI. A credential priority prefers an account but does not guarantee exclusive routing if the proxy falls back. Use account-specific routing or disable competing credentials for an account-isolated test.

Leaving `AI_API_METHOD` unset keeps the legacy `PROVIDER_PROFILE`-driven behaviour exactly as before, including an explicit `PROVIDER_PROFILE` value. If both are set, `AI_API_METHOD` wins and the startup log says so. The startup log and the in-game Debug window both show one line, e.g. `AI: method=router host=openrouter.ai main=<model[0]> subagent=<model[1]|none>` — never a key.

### Legacy environment compatibility

The runtime still accepts:

- `AIRI_SOURCE_REF`
- `AIRI_ACTOR_MODE`
- `AIRI_CHAT_PLAYERS`
- older `AIRI_CHAT_PLAYER` / `AIRI_PLAYER` fallbacks
- Docker `AIRI_SOURCE_REF` / `AIRI_REPO` build-arg fallbacks
- legacy prompt/behavior trace environment variables

Equivalent SGLuna values take precedence. Conflicting non-empty primary/legacy values produce a compatibility warning where safe.

## Config migration

`sgluna-config.json` is authoritative.

Startup behavior is deterministic:

1. if `sgluna-config.json` exists, use and update it;
2. otherwise, if legacy `airi-config.json` exists, read it once and atomically write the migrated result to `sgluna-config.json`;
3. otherwise create a fresh `sgluna-config.json`.

Provider secrets remain environment-only. The runtime does not keep two independently authoritative writable config files.

## In-game command

Preferred human chat command:

```text
!luna <request>
```

Legacy `!airi <request>` remains a compatibility alias and routes through the same authorization and request path.

Examples:

```text
!luna build power
!luna stop
```

The in-game console UI advertises **SGLuna** and **Prompt SGLuna**. The runtime actor name and id are `SGLuna` / `sgluna`.

## Factorio public/private behavior

Visibility is derived automatically from Factorio listing credentials:

- username blank + token blank → private/hidden, user verification disabled, stale credentials cleared;
- username + token → public, user verification enabled;
- only one supplied → startup/configuration error.

Authentication tokens are never printed in diagnostics.

## Runtime behavior

- Factorio stdout/stderr are forwarded to the Pterodactyl console.
- Pterodactyl console input is forwarded to Factorio stdin.
- `!luna stop` can abort an in-flight provider turn; legacy `!airi stop` behaves identically. `pause`, `停止`, `暂停` and the same words with trailing punctuation (`Stop!`) stop the same way.
- `!luna status` (or `!airi status`, `进度`, `状态`) prints the active goal, each done-when check read from the game now, the current slice step and roadmap progress. It makes no model call, does not wait behind a running turn, and does not cancel a pending automatic resume.
- shutdown requests Factorio's native save/quit path before bounded signal fallback;
- `data/server-settings.json` is reconciled without discarding unrelated Factorio settings;
- provider failures/timeouts clear the active turn rather than permanently wedging the NPC.

## Traces and debugging

New default trace files are:

```text
logs/sgluna-behavior.jsonl
logs/sgluna-prompts.jsonl
```

Legacy `AIRI_BEHAVIOR_TRACE_FILE` and `AIRI_PROMPT_TRACE_FILE` environment overrides remain accepted. The debug-report reader can also fall back to legacy `airi-behavior.jsonl` / `airi-prompts.jsonl` when the SGLuna files do not exist.

Trace schemas and provider metadata fields such as `_sglunaProvider` use SGLuna naming.

## Generated artifacts

Source of truth:

```text
deploy/pterodactyl/build-payload.mjs
```

Generated artifacts:

- `deploy/pterodactyl/install.sh`
- `deploy/pterodactyl/egg-sgluna-factorio-server.json`
- `deploy/pterodactyl/egg-sgluna-factorio-npc-e2e.json`

Regenerate/check with:

```bash
node deploy/pterodactyl/build-payload.mjs
node deploy/pterodactyl/build-payload.mjs --check
```

The immutable loader can be verified without installing:

```bash
SGLUNA_INSTALL_ROOT=/tmp/sgluna-bootstrap-check bash deploy/pterodactyl/install.sh --verify-only
```

## Package and runtime gates

```bash
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

Heavy Docker/Factorio smoke remains the authoritative packaging/runtime gate.

## Internal identifiers

These internal identifiers use SGLuna naming. There are no aliases for the former AIRI names, and no save migration:

- actor name/id: `SGLuna` / `sgluna`;
- durable memory keys such as `npc:sgluna`;
- `sgluna_deployment` remote interface;
- `SGLUNA_RESULT_*`, `SGLUNA_CONFIG_*`, and `SGLUNA_UI_*` protocol markers;
- Factorio `storage.sgluna_*` keys, GUI element ids, sprite/prototype ids;
- Autorio mod id and remote interfaces;
- internal `.sgluna/` managed-state directory;
- manifest/runtime revisions that are part of deployed contracts.

Only settings and input keep AIRI compatibility aliases: the `AIRI_*` deployment variables listed above, `airi-config.json`, `start-airi.sh` / `rollback-airi.sh`, the `!airi` chat command, the Docker `AIRI_*` build args, and the legacy trace environment/file inputs. Upstream AIRI/Autorio lineage and MIT attribution remain documented separately and are not migration targets.
