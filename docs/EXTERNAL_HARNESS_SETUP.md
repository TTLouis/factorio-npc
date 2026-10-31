# Set up an external harness

Give an auto-capable local coding harness this repository branch link and ask it
to set up Factorio NPC:

```text
Set up https://github.com/TTLouis/factorio-npc/tree/feat/external-harness-mcp
for this harness. Follow the repository setup instructions, make routine choices
automatically, and stop when the connection is verified and ready for my goal.
```

The intended result is an isolated local Factorio world connected to the harness
through MCP. Setup creates and binds the NPC; it does not start gameplay work.
No model-provider key, internal planner, Jev service or running desktop game is
needed. This is an experimental source installation. A link alone cannot grant
host permissions, supply a licensed Windows game or give a remote-only harness
access to local processes.

## Choose the path automatically

These instructions apply to any harness that can inspect a repository and run
local commands. Use the host's actual capabilities rather than assuming a
particular product, configuration directory or operating system.

| Harness capability | Setup path |
| --- | --- |
| Local commands and stdio MCP registration | Perform the workflow below and register the local server with the host's supported MCP command/tool or documented configuration mechanism |
| Local commands but no direct MCP support/hot registration | Use this repository's [process adapter](#process-adapter-for-harnesses-with-local-commands), which preserves the actual MCP schemas and complete responses; report adapter mode |
| Remote harness with an existing trusted local execution/MCP adapter | Run the workflow on that local host through the adapter; keep credentials and the game connection local |
| Browser/chat-only or cloud-only harness with no local adapter | Report the missing local capability; this repository does not provide a public remote MCP endpoint |

Do not turn stdio into an unauthenticated network server or expose RCON to make
an unsupported host work. The bridge intentionally accepts only literal
loopback addresses. An MCP descriptor is not a universal client configuration:
discover and use the installed host's registration mechanism. Never invent
private configuration paths for a named assistant.

## Automatic setup workflow

For a setup request, complete the following without asking the user to choose
routine paths, ports, session names or connection layouts. Use existing explicit
preferences first. Ask only for an unavailable permission, licensed binary or
host capability that prevents progress. Keep an actionable checkpoint if blocked.

### 1. Freeze the requested source and inspect prerequisites

Read root `README.md`, `AGENTS.md`, this page and the
[runtime/operation guide](EXTERNAL_HARNESS.md). Stay on the branch in the supplied
link; the contribution instruction to start new development from Jev does not
change the source for installing this separate experiment. Do not merge branches
or modify application code during setup.

Use a fresh clone or an existing clean installation owned by this setup. For a
new clone, the branch selection is explicit:

```sh
git clone --single-branch --branch feat/external-harness-mcp https://github.com/TTLouis/factorio-npc.git factorio-npc-external
cd factorio-npc-external
git status --short --branch
git rev-parse HEAD
```

Record the resolved full commit SHA. Freeze both bridge source and mod-build
source to that same commit; do not update a running installation underneath its
save/ledger. Preserve other checkouts, dependency directories and existing saves.
The owner's shared workspace has additional ownership rules; an independent
clone does not need the owner's parent `WORKTREES.md`.

Inspect Git, Node 24, pinned pnpm from `package.json`, Docker availability when
needed, and authorized Factorio access. This branch's engine baseline is
**2.0.77**. Check the actual binary version, not its directory name. Prefer an
already installed matching Windows binary when available. Otherwise choose an
isolated Docker Linux server when Docker works; use an exact-version headless
Factorio distribution and record its identity. A Linux local server is also
supported. macOS may host a Docker Linux server; native macOS game/ledger support
has not been validated by this branch.

Do not install host dependencies into someone else's checkout, change system
execution policy, restart Docker Desktop, or download a Windows game without
authorization. If a prerequisite can be provided inside an owned container,
prefer that to changing shared host tooling. A real blocker is a missing licensed
Windows binary with no available Docker route, unavailable Docker permissions,
or a host that cannot register/launch the local adapter.

### 2. Build a guarded mod from the frozen source

Make a second clean copy of the frozen commit and execute the
[guarded mod build commands](EXTERNAL_HARNESS.md#build-the-guarded-mod) there.
The source preparer edits that copy; keep the bridge copy unprepared. Use an
owned clean Linux/container build if host dependencies are unavailable or
belong to another environment. Preserve command exit codes and private logs.
Copy the complete `packages/autorio/dist` output to the isolated runtime as
`mods/autorio_0.1.0`, and hash the copied files against the build output. Do not
reuse another branch's mod or add test fixtures.

Do **not** use root Compose, the ordinary Docker deployment, the Pterodactyl
installer, `pnpm dev`, or the internal agent bootstrap for this path. Those are
different launch paths and may start the built-in planner. External setup starts
only Factorio and `tools/external-harness/cli.mjs`.

### 3. Create a private, isolated runtime

Choose a new private runtime directory and available loopback ports. Keep a
non-secret ownership manifest containing the source SHA, engine version/layout,
absolute paths, generated session identity, chosen ports and owned process or
Docker resource identities. Keep credentials in a separate private file or host
secret store; create them programmatically without printing their values. Use
owner-only permissions/ACLs. Ignoring a path in Git does not make it private.

Use separate write-data/saves, mods, logs and execution-ledger directories.
Meet the [Windows ledger prerequisites](EXTERNAL_HARNESS.md#prepare-an-isolated-local-game):
fixed local NTFS, no synchronization/reparse-point ancestors, preserved
`SystemRoot` and a permitted bundled PowerShell helper.

Create a fresh vanilla save with no test fixture, user inventory grant or extra
mods. Enable `base` and the prepared `autorio` mod; disable optional expansion
mods unless that exact configuration is separately supported. Use an isolated
Factorio config whose `read-data` points at the selected engine's data and whose
`write-data` points at this runtime. Use that same config and mod directory for
both map creation and server startup. Set server listing `visibility.public`
and `visibility.lan` to false, `auto_pause` to false, and keep game speed at 1.
Do not load an existing user world or connect a human during setup.

Launch the selected binary with its supported `--config`, `--mod-directory`,
`--create` and then `--start-server`/`--server-settings` arguments. Derive them
from the actual engine's `--help`; all save/config paths must be absolute. Pass
the generated RCON password through a local launcher/secret mechanism, never a
literal command displayed in chat or a logged command line. Factorio can require
that value in its own process arguments; do not publish process/Docker
inspection output that includes it.

For native Windows/Linux, bind RCON to `127.0.0.1:<chosen-port>`. For a Docker
server, record its exact owned image/container/network IDs, mount only this
runtime and publish only `127.0.0.1:<chosen-port>:27015/tcp`; the container's RCON
listener may bind its interface. Publish no game port for setup. The Windows
bridge still connects to literal `127.0.0.1`, with the ledger on Windows NTFS.
A Linux bridge can instead share the server's network namespace and persist its
ledger on a local Linux filesystem supporting directory `fsync`.

### 4. Bind once and register the local MCP server

Generate one `external-` plus UUID session per world and retain it with the save
and ledger across reconnects. Supply the
[five bridge environment variables](EXTERNAL_HARNESS.md#bind-once-then-launch-mcp)
through a private launcher/secret pass-through: literal loopback, chosen local
port, generated private RCON password, persisted session and absolute ledger path.

After local server readiness, invoke this operator setup action once with that
environment:

```sh
node tools/external-harness/cli.mjs --bind
```

Binding confirms Factorio's Lua-console readiness, disables achievements for the
disposable save and selects the standalone NPC. It refuses busy or already bound
worlds. Never clear a session or delete its ledger to make binding succeed. If
the reply is lost, reconnect with the same identity and inspect context first.

Register `node` with the absolute path to `tools/external-harness/cli.mjs` as a
stdio MCP server using the host's actual supported registration mechanism. The
[generic descriptor](EXTERNAL_HARNESS.md#bind-once-then-launch-mcp) shows the
process contract, not a client-specific file location. Use absolute executable
paths when the host has a restricted `PATH`. Preserve required OS environment
variables and inject the secret at process launch. Never put the password in a
shared MCP config. Do not launch a second MCP process while the first owns this
world's ledger lock.

If the host cannot register/reload MCP automatically but can run local commands,
use the process adapter below. Identify that mode explicitly; a descriptor alone
is not a connected native client.

### 5. Prove readiness through the registered connection

With the private bridge environment supplied and no other client holding its
ledger lock, run:

```sh
node tools/external-harness/setup-check.mjs --fresh --output /absolute/private/path/readiness.json
```

The helper launches the actual stdio CLI twice, negotiates MCP, compares all
seven full tool schemas, reads context/capabilities/actor status, and checks
native idle/empty queues, ownership, zero native high-water/ledger records and
stable actor/epoch/session after clean reconnect. It never binds, submits,
cancels or starts a model. Its receipt says `local_stdio_ready` and explicitly
does **not** claim native host registration. On ordinary restarts, omit `--fresh`:
settled history is retained, while pending/uncertain work still blocks readiness.
Never erase history to satisfy a freshness check.

For native MCP registration, then read `factorio_context`,
`factorio_capabilities` and the bounded `getActorStatus` observation through the
registered host itself. For process-adapter mode, execute the commands below
from that harness. A successful helper probe without either usable host path
does not establish that the user's harness is connected.

Write a private non-secret readiness receipt with the frozen SHA, build/mod
hashes, actual engine version, layout/resource IDs, host registration identity,
tool names, timestamps and above check outcomes. Report **ready for a goal** only
after those checks succeed. Report remaining host blockers precisely. Do not
claim gameplay or factory-building success from setup checks.

## Process adapter for harnesses with local commands

For a host without native stdio registration, use the bundled thin MCP client.
It launches `cli.mjs` with the same private bridge environment, initializes MCP,
forwards one request and closes cleanly. Every invocation preserves the same
session/ledger. Use it sequentially; do not run it beside another ledger owner.

```sh
node tools/external-harness/mcp-call.mjs --list
node tools/external-harness/mcp-call.mjs --call factorio_context --arguments '{}'
node tools/external-harness/mcp-call.mjs --call factorio_capabilities --arguments '{}'
node tools/external-harness/mcp-call.mjs --call factorio_observe --arguments '{"name":"getActorStatus","args":{}}'
```

`--list` returns the running server's complete `result.tools`, including each
`inputSchema`. A call returns the complete JSON-RPC envelope. Read
`result.structuredContent` and `result.isError` for tool outcomes; top-level
`error` is a protocol error. Do not strip the `request_id`/`operation` envelope
from `factorio_submit`, invent an alternate argument shape or turn a refusal
into a success. Nonzero exit status can accompany a preserved error response.
Save full responses and durable request/operation IDs in the harness workspace.

For repeat use, generate a private local launcher which loads the stored secret
without printing it and invokes this adapter with literal arguments. Register
that launcher as the host's supported process tool or use its existing local
command tool; never store secrets in tool metadata. This is **process-adapter
mode**, not a claim that native MCP configuration was registered. Subsequent
gameplay still uses only the MCP catalog and requires a user goal. Raw RCON,
arbitrary Lua and shell gameplay bypasses are not supported fallbacks.

## Handoff and cleanup

On successful interactive setup, the isolated game is intentionally retained
for the user's next goal. State which owned server resources remain, where the
private manifest/launcher are, and how to restart and stop them. Retain the same
session, save and ledger; never rebind on ordinary restart. Keep the external
goal and future request/operation checkpoints in the harness's durable workspace.
Read [operation and interruption rules](EXTERNAL_HARNESS.md#operation-protocol)
before acting. Obtain recipes, capacities and other game facts from live tools.

On setup failure or cancellation, stop any temporary MCP clients and owned game
processes/containers, preserve logs and private state first, then verify their
absence. Remove only owned disposable networks/volumes, never shared images or
other sessions' resources. Preserve the failure even if cleanup has another
error; record remaining resource IDs and an exact recovery command. Never run
global prune or restart Docker to clean up.

Once gameplay has occurred, closing stdio is not a gameplay stop. Follow exact
operation cancellation/reconciliation and the operator closeout procedure;
preserve the paired save/ledger before deleting runtime resources. A setup
request does not authorize gameplay, publication, a provider call, an autonomous
trial or changes to an existing world.
