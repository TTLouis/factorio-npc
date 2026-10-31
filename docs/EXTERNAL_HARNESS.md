# External-harness experiment

This opt-in entrypoint lets a co-located Codex, Claude, or other MCP-capable
harness operate the standalone NPC **without starting an in-repository model
planner**. It is a bounded experimental integration, not a replacement for the
existing autonomous runtime or a claim of reliable factory-building capability.
The Docker/Pterodactyl and ordinary-agent entrypoints are unchanged.

For automatic setup from a repository/branch link, start with the
[portable setup workflow](EXTERNAL_HARNESS_SETUP.md). It covers host discovery,
isolated installation, supported MCP registration, readiness and cleanup for
different kinds of harnesses. This page defines the runtime and tool contract.

## Ownership: three layers

| Layer | Owns | Does not own |
| --- | --- | --- |
| Native mod and deterministic execution runtime | Actor/session validation, bounded operation parsing and preflight, exact native admission/receipts, cancellation, durable operation identity and uncertainty fences | Model calls, task decomposition, unrestricted Lua, or guesses that a goal succeeded |
| Local MCP adapter | Structured tool schemas, stdio request/response transport, compact context and on-demand details | Gameplay semantics, independent planning, or permission to bypass runtime refusals |
| External harness and [operator skill](../.agents/skills/factorio-external-operator/SKILL.md) | User-goal interpretation, planning, overall progress and durable reasoning/checkpoints | Inventing native facts, erasing uncertain operations, changing acceptance criteria, or approving its own additional authority |

The experiment reuses `runtime-v8/structured-policy.mjs`, the correlated
`staging/supervisor-adapter.mjs` execution path, native admission/task journals,
and runtime reconciliation. It does not reinterpret HTTP `202` from the older
[desktop operator](../tools/desktop-rcon-operator.mjs) as completion.

External planning is deliberately separate from the autonomous runtime's
committed-plan/UI lifecycle. Do not run both planners against the same actor.
Keep the user goal, accepted plan and interrupted work in the external harness's
durable workspace; the operation journal is an execution ledger, not a second
task board and not evidence of user approval. Existing autonomous-mode plan,
allowance and recovery contracts remain unchanged.

## Current capability boundary

Use `factorio_capabilities` to discover the exact supported operation names,
arguments and bounded observation tools for the running revision. This initial
slice supports walking, waiting, crafting, mining known resource positions,
exact item transfers and tightly restricted nonfluid placement. Unsupported operations fail closed; the complete existing
runtime-v8 catalog is **not** implicitly exposed.

`place_entity` accepts only `stone-furnace`, `burner-mining-drill` and
`wooden-chest`, with explicit exact-grid coordinates. Native prototype/footprint
and collision checks must prove a clear, nonfluid site. The bridge always passes
the native execution-time `refuse_clearance` flag: a later blocker causes refusal,
not clearing or replacement. It refuses older mods without the explicit safety
capability marker. The flag is not model-selectable. Discover and inspect the
actual placed entity before supplying it; placement alone proves no production.

Advanced placement/construction, fluid
preservation, autonomous research/combat, multiplayer coordination and
unrestricted world queries are outside this slice. The established preservation
path has not been integrated into external mode; it is not replaced with prompts.
Do not emulate a missing operation with RCON, generated Lua or shell commands.
The native world remains authoritative for inventory, recipes, reach, collisions,
crafting time, mining and actual output.

## Prepare an isolated local game

Prerequisites:

- Node 24 and the package manager pinned by `package.json`.
- An authorized Factorio installation; the repository's deterministic engine
  baseline is **2.0.77**. This package does not include the Factorio executable.
- A fresh disposable save and its own mod, write-data and runtime-state
  directories. Do not use a production save for the first run.
- One local controller only. Stop any ordinary agent, supervisor, desktop
  operator or other RCON writer for this save before binding the external mode.
- For a native Windows bridge: Windows PowerShell 5.1 at
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with script
  execution and `Add-Type` permitted, and a private state directory on a local
  fixed NTFS drive. Preserve `SystemRoot` in the launch environment. Network
  shares, mapped network drives, removable drives and other Windows filesystems
  are not supported for the execution ledger. Paths through junctions, symbolic
  links or other reparse points are refused, including volume mount directories.
  Execution-policy, constrained
  language, sandbox or endpoint-security restrictions fail closed; the bridge
  does not bypass them.

### Build the guarded mod

Use a **second clean copy of this exact source revision**, not another person's
checkout. The source preparer intentionally modifies `control.ts` and adds a
deployment guard in that build copy. Ensure `pnpm --version` matches
`package.json` (10.30.1 for this revision); use `corepack pnpm` in place of `pnpm`
if that is how your environment selects pinned versions. In an independent
Linux/container copy:

```sh
pnpm install --frozen-lockfile
pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build
node deploy/pterodactyl/staging/source-preparer.mjs . deploy/pterodactyl/staging/guard.ts
pnpm --filter autorio.ts run typecheck
pnpm --filter autorio.ts run build
pnpm --filter autorio.ts run check:lua
```

Copy the resulting `packages/autorio/dist` directory to the isolated game's mod
directory as `autorio_0.1.0`. Keep the original source checkout unchanged. A
plain unprepared Autorio build lacks the guard required by this experiment and
must be rejected, not silently upgraded by a model tool.

Start the disposable save with RCON bound to loopback, a strong private RCON
password, public/LAN listing disabled, and `auto_pause: false` so native work can
finish with zero connected players. Keep normal game speed. Factorio's
`--rcon-bind 127.0.0.1:27015` selects a loopback RCON listener; check the installed
binary's `--help` and the [official command-line reference](https://wiki.factorio.com/Command_line_parameters)
for its complete launch options. This guide does not authorize opening firewall
ports, exposing RCON or changing an existing server's security settings.

### Windows and Docker connection layouts

The bridge runs under Node on Windows or Linux. Its RCON address remains literal
loopback in every layout; no provider service or network MCP server is needed.

| Bridge | Factorio server | Connection and state |
| --- | --- | --- |
| Windows host | Native Windows process | Bind Factorio to `127.0.0.1:27015`; keep the bridge ledger on local NTFS |
| Windows host | Docker Linux container | Publish RCON **only** as `127.0.0.1:27015:27015/tcp`; connect the bridge to `127.0.0.1:27015`, with its ledger on local Windows NTFS |
| Linux process/container | Same host/network namespace | Use native loopback; keep the ledger on a persistent local Linux filesystem with working directory `fsync` |

For the Windows-to-Docker layout, the Factorio listener inside the isolated
container must accept traffic on its container interface (for example,
`--rcon-bind 0.0.0.0:27015`). The **host publication** must still specify
`127.0.0.1`; Docker's bare `27015:27015` publishes more broadly and is not this
supported setup. Keep the container on its own private Docker network and do not
attach unrelated containers. This fragment illustrates the port setting for an
already prepared, isolated Factorio service:

```yaml
ports:
  - "127.0.0.1:27015:27015/tcp"
```

Use the prepared guarded mod and server's existing secret-injection mechanism;
do not put a password in the example or in shell arguments. Inspect Docker's
published bindings before connecting. Binding and MCP commands below then run
on Windows unchanged. A different unused host port can be selected by changing
the host publication and `SGLUNA_RCON_PORT` together.

A Linux bridge in a separate container can share the isolated server's network
namespace to reach its loopback listener. A normal Docker service hostname,
`host.docker.internal` or container IP is intentionally rejected by the bridge;
do not broaden the allowlist. Keep a container bridge's persistent journal in
that Linux environment rather than assuming a Windows bind mount supplies
POSIX directory-flush semantics. Preserve the game save and corresponding
bridge journal together whichever side hosts them.

### Bind once, then launch MCP

Provide credentials through the process environment or your host's secret
injection. Do not put a real password in the repository, MCP configuration,
examples, transcripts or shared logs. These settings are for the local bridge:

| Variable | Meaning |
| --- | --- |
| `SGLUNA_RCON_HOST` | Only literal `127.0.0.1` (default) or `::1` is accepted; remote addresses and hostnames are rejected |
| `SGLUNA_RCON_PORT` | Local RCON TCP port; default `27015` |
| `SGLUNA_RCON_PASSWORD` | Private game RCON credential, injected at launch |
| `EXTERNAL_HARNESS_SESSION` | Unique identity for this disposable world/controller binding; retain it across restarts |
| `EXTERNAL_HARNESS_STATE_DIR` | Private persistent directory for this world's execution ledger |

Choose a fresh, high-entropy session identity for each new world (for example,
`external-` followed by a newly generated UUID; 32–120 letters, digits, `_` or
`-`). Never reuse one for an unrelated save. Set the same session and state
directory every time the MCP process reconnects to this save.

With the environment supplied, the operator explicitly binds the fresh save:

```sh
node tools/external-harness/cli.mjs --bind
```

Binding performs Factorio's Lua-console readiness confirmation (which disables
achievements for this disposable save), then selects the standalone NPC. It is a gameplay-affecting setup action,
not an MCP tool. It refuses an existing session or busy state rather than
silently taking control. Do not clear another controller's session to make it
succeed. If the bind reply is lost, reconnect with the same session and inspect
context rather than attempting takeover. Once bound, the MCP client launches:

```sh
node tools/external-harness/cli.mjs
```

A generic stdio server registration descriptor is:

```json
{
  "command": "node",
  "args": ["/absolute/path/factorio-npc/tools/external-harness/cli.mjs"],
  "env": {
    "SGLUNA_RCON_HOST": "127.0.0.1",
    "SGLUNA_RCON_PORT": "27015",
    "EXTERNAL_HARNESS_SESSION": "external-00000000-0000-4000-8000-000000000000",
    "EXTERNAL_HARNESS_STATE_DIR": "/absolute/private/path/world-execution-state"
  }
}
```

Replace the all-zero example session with the identity actually bound to your
save. Put this descriptor in the MCP server registration supported by your
installed harness; its surrounding config format is client-specific. Configure
that client's secret environment pass-through for `SGLUNA_RCON_PASSWORD`; it is
intentionally absent from the descriptor. Start from an absolute path, and load
[the operator skill](../.agents/skills/factorio-external-operator/SKILL.md) through
your harness's supported skill mechanism. The repository skill path is
`.agents/skills/factorio-external-operator`; other hosts may require an explicit
skill import or loading its `SKILL.md`.

For Windows registration, use absolute paths such as
`C:/FactorioHarness/tools/external-harness/cli.mjs` and a private NTFS state path
such as `D:/FactorioState/disposable-world`. Forward slashes avoid JSON
backslash escaping; spaces and Unicode are supported. The PowerShell journal
helper is resolved relative to `runtime.mjs`, so retain it with the source.

MCP uses inherited stdio, not an HTTP listener or bearer-token server. Access is
granted by allowing the trusted harness to launch this process with the local
RCON credential. Do not attach an untrusted client or expose its pipes over a
network. Stdout is protocol-only; startup/diagnostic output belongs on stderr.
The bridge needs no model-provider key, imports no internal model planner and
makes no model-provider calls. The MCP entrypoint opens no network listener; its
only game connection is to the explicitly configured local RCON service.

## Operation protocol

| Tool | Purpose |
| --- | --- |
| `factorio_capabilities` | Read the supported operation/observation schemas and limits |
| `factorio_context` | Get a compact actor and execution summary; not a full-world dump |
| `factorio_observe` | Fetch one approved, argument-bounded native detail |
| `factorio_submit` | Validate and admit one operation, using a stable caller `request_id` |
| `factorio_receipt` | Read or bounded-wait for the exact operation outcome |
| `factorio_cancel` | Request cancellation of that exact operation; inspect the resulting evidence |
| `factorio_resume` | Reconcile a recorded operation after interruption; **never resend it** |

Example arguments after checking the current recipe/inventory and capabilities:

```json
{
  "request_id": "goal-gear-001-craft-01",
  "operation": {
    "name": "craft_item",
    "args": { "item_name": "iron-gear-wheel", "count": 1 }
  }
}
```

Retain the returned `operation_id` with the accepted plan step. Reusing the same
`request_id` with the same operation retrieves the existing operation; reusing
it with changed arguments is a conflict, not a retry. A fresh request ID denotes
new work and must not be used to disguise a possibly completed duplicate.

Ask `factorio_receipt` with `{ "operation_id": "<returned-id>", "wait_ms": 30000 }`
to let the deterministic runtime wait. A wait deadline is not cancellation or
failure proof. Avoid model-side rapid polling, full-world dumps and repeated
unchanged context. Fetch only the recipe, entity, inventory or local spatial
detail needed for the next decision.

Request IDs are 1–120 characters, begin with an alphanumeric character and may
contain letters, digits, `.`, `_`, `:` or `-`. The runtime permits only one
outstanding operation. Native busy state,
identity mismatch and uncertain earlier effects block new mutation. Exact
receipts distinguish execution outcomes; neither successful admission nor a
completed task automatically proves the user's whole goal. For example, a
positive item transfer can be smaller than requested: inspect actual moved
counts and destination state. Prove a crafting/mining quantity from native
result/inventory evidence, navigation from the observed position, and production
from actual output, not merely a placed machine.

## Interruption, cancellation and restart

1. Save the `request_id`, `operation_id`, accepted semantic step and last observed
   evidence in the external harness's durable checkpoint.
2. After a timeout or lost connection, reconnect with the **same** game/session,
   state directory and operation ID, then call `factorio_resume` or
   `factorio_receipt`. Do not submit replacement work first.
3. Cancellation is an explicit `factorio_cancel` call for the exact operation.
   Cancelling an MCP request or closing the harness is not proof that gameplay
   stopped. A cancellation can leave partial effects; re-observe before planning
   remaining work. Native state and exact correlated receipts decide the result.
   Even a terminal `cancelled` or `partial` result can carry
   `requires_reconciliation: true`; an unresolved native admission still blocks
   further mutation. This experiment does not expose a model-controlled journal
   resolution override.
4. If the result is uncertain, actor identity changed, the save was rolled back,
   or the expected journal evidence is absent, preserve the fence and report the
   blocker. Do not delete/edit the state file, reset a session or invent a new
   operation ID to bypass it. Operator reconciliation may be required.

The state directory contains `ledger.json` and a single-process `owner.lock`.
If a process crashes, the lock deliberately remains: an operator must verify
that the old process is no longer running and no other host owns the directory
before removing **only `owner.lock`**. Never delete the ledger as lock recovery.
The journal retains up to 512 request identities and refuses new work when full
rather than silently evicting duplicate protection. Do not rotate it over a live
world to bypass that limit.

Receipts label their scope. `historical_execution` preserves past evidence; it
does not assert that a restored world still contains the effects. Resume checks
current native evidence; contradictory restored state creates a durable fence.
Native tick/high-water rollback also refuses work. A legitimately evicted old
native receipt remains explicitly historical with unknown current reconciliation,
never permission to repeat it. `current_world_verified` and `goal_verified` remain
false: verify the requested world outcome through fresh observations.

A failed durable journal write prevents further mutation in that process.
Preserve its files and investigate storage failure before restarting.

Before each mutation, the bridge writes and flushes the complete temporary
ledger and closes its file handle. On Linux it renames that file and flushes the
parent directory. On Windows it invokes the bundled helper with literal argv
paths and requests Win32 `MoveFileExW` with `REPLACE_EXISTING | WRITE_THROUGH`;
it does not attempt unsupported directory `fsync` or ignore `EPERM`. The helper
receives no RCON or provider credentials, runs hidden without profiles, has a
15-second timeout, and must exit successfully before mutation is sent. Any
write, flush, close, replacement or helper failure poisons that runtime, even if
the new ledger is already visible. Never replay work to recover a helper error.

These are operating-system persistence requests, not certification of a disk's
power-loss behavior. The process-crash and lost-acknowledgement tests do not
simulate physical power loss or validate network/synchronized storage. Keep the
private ledger outside synchronization folders and retain paired backups.
Windows starts a short PowerShell process for each ledger replacement; this adds
latency but requires no resident helper or native addon. Microsoft's
[MoveFileExW documentation](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
defines the native write-through flag.

The local ledger is persisted before sending mutation. A crash between that
write and a native reply is intentionally conservative: it may have happened.
Restart performs exact reconciliation, not automatic replay. Keep the ledger
and game save backed up together; restoring only one can make correlation
unprovable. Do not run two MCP processes over the same state directory or two
independent journals over one actor. Keep runtime data private and out of source
packages.

## Validation and limits

Run the focused bridge/runtime/MCP tests from the repository root:

```sh
node --test tools/external-harness/*.test.mjs
```

Then follow [Testing](TESTING.md) for the repository's ordinary/offline gates.
Fake RCON/native fixtures establish adapter contracts and failure handling, not
Factorio gameplay. A live-engine claim needs retained evidence from the exact
engine version, guarded mod revision and isolated save. A provider-free native
run still does not establish autonomous Codex/Claude task performance.

This experiment is not production-promoted. Final test commands, results and
remaining environment limits belong in the supplied implementation checkpoint;
read that evidence before relying on a capability. It does not authorize paid
model calls, installation of Factorio, deployment, publication or access to a
user's existing game.
