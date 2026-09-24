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

Successful installs stage releases under the internal `.airi/releases/` state store and switch the canonical `start-sgluna.sh` symlink only after the new release is complete.

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
└── .airi/                         # internal compatibility state; do not edit manually
```

The internal `.airi/` directory remains authoritative for managed releases, the operation lock, provider budget, durable NPC state, rollback metadata, and runtime temp directories. It is intentionally **not renamed** in this migration because doing so safely requires a broader transactional state migration.

At runtime, managed Autorio is injected into an isolated `.airi/run-*/mods/` directory. User mods stay under `mods/`; the downloadable exact client package stays under `client-mods/`.

## Egg variables

Fresh eggs expose these preferred deployment controls:

| Purpose | Setting | Meaning |
| --- | --- | --- |
| Source channel | `SGLUNA_SOURCE_REF` | branch, tag, or exact commit resolved on reinstall |
| Actor ownership | `SGLUNA_ACTOR_MODE` | currently fixed to `npc` |
| Chat authorization | `SGLUNA_CHAT_PLAYERS` | blank/`*` = everyone, `none` = nobody, otherwise comma-separated exact names |
| Provider credential | `OPENAI_API_KEY` | required; environment-only |
| Model | `OPENAI_MODEL` | OpenAI-compatible model identifier |
| Provider URL | `OPENAI_API_BASEURL` | OpenAI-compatible HTTPS endpoint |
| Provider timeout | `PROVIDER_TIMEOUT_MS` | provider request timeout |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | persisted hourly request cap |
| Save | `SAVE_NAME` | blank chooses newest existing save or creates `sgluna-world.zip` |
| Factorio account | `FACTORIO_USERNAME` / `FACTORIO_TOKEN` | both blank = private/hidden; both set = public |
| Shutdown timeout | `SHUTDOWN_TIMEOUT_MS` | bounded graceful shutdown time |
| Factorio version | `FACTORIO_VERSION` | `latest`, `experimental`, or exact supported 2.0.x |

No separate `PRIVATE_SERVER` flag exists.

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

The in-game console UI advertises **SGLuna** and **Prompt SGLuna**. The underlying runtime actor identity remains `AIRI` / `airi` for compatibility.

## Factorio public/private behavior

Visibility is derived automatically from Factorio listing credentials:

- username blank + token blank → private/hidden, user verification disabled, stale credentials cleared;
- username + token → public, user verification enabled;
- only one supplied → startup/configuration error.

Authentication tokens are never printed in diagnostics.

## Runtime behavior

- Factorio stdout/stderr are forwarded to the Pterodactyl console.
- Pterodactyl console input is forwarded to Factorio stdin.
- `!luna stop` can abort an in-flight provider turn; legacy `!airi stop` behaves identically.
- `!luna status` (or `!airi status`) prints the active goal, each done-when check read from the game now, the current slice step and roadmap progress. It makes no model call, does not wait behind a running turn, and does not cancel a pending automatic resume.
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

Trace schemas, provider metadata fields such as `_airiProvider`, and other runtime protocol identifiers are intentionally unchanged.

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

## Compatibility surfaces intentionally retained

These are not normal deployment branding and are deliberately unchanged:

- actor name/id: `AIRI` / `airi`;
- durable memory keys such as `npc:airi`;
- `airi_deployment` remote interface;
- `AIRI_RESULT_*`, `AIRI_CONFIG_*`, and `AIRI_UI_*` protocol markers;
- Factorio `storage.airi_*` keys, GUI element ids, sprite/prototype ids;
- Autorio mod id and remote interfaces;
- internal `.airi/` managed-state directory;
- manifest/runtime compatibility revisions that are part of deployed contracts.

Historical upstream AIRI lineage and MIT attribution remain documented separately and are not migration targets.
