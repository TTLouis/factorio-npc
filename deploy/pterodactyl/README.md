# AIRI Factorio — Pterodactyl deployment

> [!IMPORTANT]
> This guide belongs to the older `main` snapshot. For current SGLuna, use
> [`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/tree/experiment/jev-agent-architecture)
> and its deployment guide. Jev is optional on that branch. Keep the branch's
> scripts/settings together; this snapshot still uses AIRI-era identifiers.

This directory contains the Pterodactyl deployment for this fork's standalone AIRI Factorio NPC.

## Deployment channels

There are now **two distinct PTDL_v2 eggs**:

| File | Pterodactyl name | Default `AIRI_SOURCE_REF` | Use |
| --- | --- | --- | --- |
| `egg-airi-factorio-server.json` | `AIRI Factorio Server (Main)` | `main` | stable/main servers |
| `egg-airi-factorio-npc-e2e.json` | `AIRI Factorio Server (NPC E2E)` | `feat/npc-transition-work` | active NPC/E2E testing |

Import the desired file through **Admin → Nests → Import Egg**. They are intentionally separate so a stable server cannot be mistaken for an E2E server.

Both use:

```text
ghcr.io/ptero-eggs/yolks:debian_bookworm
```

Startup command:

```text
bash ./start-airi.sh
```

The only externally exposed AIRI service required is Factorio's normal game port. Internal RCON is dynamically allocated on `127.0.0.1` and owned by the supervisor.

## How updates work

The channel eggs keep the installer payload itself immutable and checksummed. On **Reinstall**, the egg resolves `AIRI_SOURCE_REF` to an exact Git commit SHA, then uses the audited installer payload to build and install that exact snapshot.

A normal **Restart never resolves the branch and never changes installed code**.

Examples:

```text
Main egg reinstall:
main -> exact commit SHA -> validate/build -> activate

NPC E2E egg reinstall:
feat/npc-transition-work -> exact commit SHA -> validate/build -> activate
```

For reproducible debugging, set `AIRI_SOURCE_REF` to an exact 40-character SHA before reinstalling.

The installed manifest records the exact source SHA. The generated channel release revision also contains the channel and short SHA, so startup logs make the installed build obvious.

## Transactional install and rollback

Each successful installation stages a new release under `.airi/releases/` and switches `start-airi.sh` only after the new release is complete. A failed test/build/download leaves the previous completed release active.

To return to the previous managed release:

```bash
bash ./rollback-airi.sh
```

Rollback changes the managed startup target only. It does not rewrite saves, user mods, or `airi-config.json`.

## Server file layout

The server root is kept intentionally small and separates user content from AIRI-managed internals:

```text
/home/container/
├── start-airi.sh                 # managed startup symlink
├── rollback-airi.sh              # managed rollback helper
├── airi-config.json              # effective non-secret runtime config
├── client-mods/
│   ├── autorio_0.1.0.zip         # downloadable client-side Autorio package
│   └── SHA256SUMS
├── mods/                         # user-installed Factorio mods only
├── saves/                        # Factorio saves
├── data/                         # server-settings.json and Factorio writable data
├── logs/                         # AIRI behavior/debug logs
└── .airi/                        # managed releases/runtime state; do not edit manually
```

`client-mods/` is **not** the directory Factorio loads server mods from. It is the user-facing place to download the exact managed Autorio client package when a joining client needs it. User-supplied mods remain under `mods/`. At runtime the supervisor builds an isolated `.airi/run-*/mods/` directory, copies approved user mods into it, injects the managed Autorio build, and passes that directory explicitly through Factorio's `--mod-directory` flag.

Reinstall removes the old legacy root-level `autorio_0.1.0.zip` after publishing the same package under `client-mods/`.

## Egg variables

| Purpose | Setting | Meaning |
| --- | --- | --- |
| Source channel | `AIRI_SOURCE_REF` | branch, tag, or exact commit resolved on reinstall only |
| Actor ownership | `AIRI_ACTOR_MODE` | fixed to `npc` |
| Chat authorization | `AIRI_CHAT_PLAYERS` | blank/`*` = everyone, `none` = nobody, otherwise comma-separated exact-name allowlist |
| Provider credential | `OPENAI_API_KEY` | required; environment-only and never written to `airi-config.json` |
| Model | `OPENAI_MODEL` | defaults to non-real placeholder `replace-me` |
| Provider URL | `OPENAI_API_BASEURL` | defaults to non-routable `https://provider.invalid/v1` |
| Provider timeout | `PROVIDER_TIMEOUT_MS` | defaults to `120000` ms; failed turns recover instead of permanently wedging the agent |
| Provider budget | `MAX_PROVIDER_REQUESTS_PER_HOUR` | defaults to `300` |
| Save | `SAVE_NAME` | optional explicit save; blank chooses newest or creates `airi-world.zip` |
| Factorio account | `FACTORIO_USERNAME` / `FACTORIO_TOKEN` | both blank = hidden/private; both set = public listing path |
| Shutdown timeout | `SHUTDOWN_TIMEOUT_MS` | time allowed for Factorio's clean `/quit` path before bounded signal fallback |
| Factorio version | `FACTORIO_VERSION` | `latest`, `experimental`, or exact supported `2.0.x` |

`OPENAI_MODEL` and `OPENAI_API_BASEURL` are synchronized into `airi-config.json` on startup. Secrets are not. Factorio username/token must be supplied together or startup fails.

## Runtime behavior relevant to Pterodactyl

- Factorio stdout/stderr are forwarded to the Pterodactyl console once.
- Commands typed into the Pterodactyl console are forwarded unchanged to Factorio stdin.
- Input listeners are detached on exit/stop and broken-pipe errors are handled.
- Pterodactyl's `^C` stop action signals the AIRI supervisor. The supervisor pauses durable AIRI state, cancels active Autorio work, requests Factorio's native `/quit` over authenticated loopback RCON, and waits for Factorio to save and exit itself. SIGINT and then SIGKILL are bounded fallbacks only if the native quit path does not finish before `SHUTDOWN_TIMEOUT_MS`.
- `data/server-settings.json` is reconciled at startup while preserving unrelated Factorio fields.
- provider failures/timeouts clear the active AIRI turn and are reported back to game chat;
- `!airi stop` can abort an in-flight provider request;
- RCON queue failures do not permanently poison later commands.

## AI behavior trace for NPC E2E

The NPC runtime writes a bounded JSONL behavior trace to `logs/airi-behavior.jsonl` under the server root. It correlates one AIRI request across actor binding, provider-budget reservations, provider calls, tool observations, structured plans, operation admission acknowledgements, completion signals, and verification/status reads. Provider timing and safe response metadata are included when available. Sensitive fields and bearer/API-key-like values are redacted before writing. The trace rotates at roughly 5 MiB and retains up to five files; trace-write failures are fail-open and do not stop AIRI.

For the current E2E phase this intentionally lives inside the **existing packaged runtime files**. That keeps the installer/bootstrap contract unchanged: after this source change reaches `feat/npc-transition-work`, the existing NPC E2E egg only needs a **Reinstall** to pick it up. Do not require a new egg import for behavior-trace changes unless the installer/bootstrap contract itself later changes.

The trace is for debugging/evaluation only. Completion task-status snapshots recorded by the trace are not silently injected into model context, and the trace records only explicit model-visible structured plans rather than hidden reasoning.

## Generated artifacts

- `payload-src/installer.sh` — audited, human-readable transactional installer payload.
- `install.sh` — immutable checksummed loader for that payload; useful for integrity verification/manual packaging.
- `build-payload.mjs` — generator and drift checker for the immutable loader plus both channel eggs.
- `egg-airi-factorio-server.json` — Main channel egg.
- `egg-airi-factorio-npc-e2e.json` — NPC E2E channel egg.

Regenerate/check with:

```bash
node deploy/pterodactyl/build-payload.mjs
node deploy/pterodactyl/build-payload.mjs --check
```

The checker validates the immutable payload loader and requires both eggs to contain the expected channel installer and source-ref defaults.

The immutable loader also supports:

```bash
AIRI_INSTALL_ROOT=/tmp/airi-bootstrap-check bash deploy/pterodactyl/install.sh --verify-only
```

## Package and E2E gates

Minimum generated/runtime checks:

```bash
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
```

The Docker package smoke and real zero-player Factorio harness validate the deployment without real provider credentials. The package smoke requires both the supervisor's clean-shutdown acknowledgement and Factorio's own `Goodbye` marker after `/quit`, so a wrapper exit caused only by forced process termination is not accepted as graceful. Production provider validation remains an operational check rather than a repository-CI requirement.

## Source/update boundary

Changing AI harness/runtime/Autorio code does **not** require repinning the immutable installer payload. Push or merge the source change to the branch followed by the selected egg, then reinstall the server. The branch is resolved to an exact SHA during that reinstall.

Changing the installer/bootstrap contract itself still requires regenerating/re-importing the egg so the audited bootstrap changes explicitly.

## Hardening roadmap

The Docker image is still selected by the `debian_bookworm` tag. Pinning it to an immutable digest remains planned hardening and is intentionally separate from source-channel updates.
