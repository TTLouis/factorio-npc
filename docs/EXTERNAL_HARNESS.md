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
arguments and bounded observation tools for the running revision. The bridge
exposes native walking, crafting, harvesting, exact transfers and supply,
research, construction, custody-backed exact removal, equipment and combat.
Human-player workflows and composite plan/layout/registry lifecycles belong to
separate adapters. Unsupported operations fail closed.

`place_entity` accepts native nonfluid prototypes with explicit exact-grid
coordinates. There is no prototype-name authorization list; the empty legacy
prototype-list fields mean eligibility is determined by native witnesses.
Read native placement candidates to obtain valid snapped centers, including
half-grid centers; do not assume integer coordinates. Native prototype/footprint
and collision checks must prove a clear, nonfluid site. The bridge always passes
the native execution-time `refuse_clearance` flag: a later blocker causes refusal,
not clearing or replacement. It refuses older mods without the explicit safety
capability marker. The flag is not model-selectable. Discover and inspect the
actual placed entity before supplying it; placement alone proves no production.

`place_candidate` uses the native preservation path for fluid prototypes whose
complete bounded port/storage geometry can be proved. Generic and modded names
must satisfy the same native constraints; listing a name grants no permission.
Fluid machines do not use the zero-fluidbox coordinate shortcut. First discover
current prototype, source-tile and placement facts with `getPrototypeDetails`,
`getFluidSourceTiles` and `getPlacementCandidates`. A candidate without a declared
relation is accepted only when a complete native scan proves zero possible fluid
joins. A connection candidate must prove exactly its declared single additive
join; the target's connected geometry is frozen by the shared native guard.
That guard walks the target's whole connected fluid network and proves at most
16 entities (`capabilities.limits.fluid_network_entities`); every entity it walks
must be visible and of a supported prototype. `getPlacementCandidates` reports the
same walk as `connects_to.preservation_network` (`provable`, `entity_count` or
`entity_count_at_least`, `limit`, and `unit_number` for an entity it cannot read)
and marks every candidate of an unprovable join `external_preservation.eligible=false`
with the native reason. Those candidates are refused before admission; a network
that grew past the limit after listing is refused with `native_code`
`preservation_guard_network_over_limit`, `limit` and `entity_count_at_least`.
A join to a 16-entity network brings it to 17; a larger network cannot be joined
through this path.
The bridge persists the exact frozen claim before sending the v2 operation;
queued execution rechecks owner, session, epoch, candidate lifetime, native
admission and protected geometry, and refuses clearance. Missing guard capability,
unknown geometry, extra joins, changed targets or lost claim history fail closed.
An unused frozen claim remains durable; deleting claims or the ledger is unsafe.

`place_line` places a straight run of `transport-belt` or a line of
`small-electric-pole` in one admitted operation:
`{entity_name, x, y, direction?, line_direction, count, spacing?}`. Tile `i` is
`(x, y)` plus `i * spacing` steps along `line_direction` (0 north, 4 east, 8 south,
12 west); `direction` is each entity's own facing (default 0), `count` is 1–32
(`capabilities.limits.line_count`) and `spacing` 1–8 (default 1). It is
external-only: not part of the shared ordinary-agent or runtime-v8 catalog, and
it needs the mod capability `external_line_placement_supported`.
Preflight is strict and read-only: the actor must hold all `count` items, and every
tile must pass the same exact-grid, NPC-reservation, native collision and external
footprint checks as `place_entity`, within 128 tiles of the actor (rechecked at
admission). Items on the ground and any other character block a tile. The actor's own
character does not: execution steps out of each tile before placing it, so a line may
start where the previous one ended. Any failing tile refuses the whole line before it is sent (`not_happened`), with
`tile_index` and up to 8 blockers. A refusal at admission (the world changed after
preflight) is a terminal `native_refused_before_admission` receipt whose
`evidence.refusal` names the guard code and, when the atomic preflight re-run refused,
its `native_code`, `tile_index` and blockers. Execution queues `count` native placements in one
journal slot; each placement re-checks its tile with the same footprint rule and the
native `refuse_clearance` flag; if the actor stands inside a tile it steps
out first. Nothing is cleared or replaced.
A `completed` receipt requires the native line record to list every tile as placed;
its `line_placement` field lists each entity (`index`, `unit_number`, `position`,
`direction`). A blocker that appears during execution, or a cancel, stops the line.
The receipt is then `partial` (`exact_line_placement_partial`): the placed prefix,
which tiles are missing or were never placed, and the first refusal (`index`, `code`,
`blockers`). It is never reported as success. A refusal on the first tile, before
anything was placed, is a native proven refusal. After a restart or a batch generation
change the line is `uncertain`; inspect the tiles instead of resubmitting blindly.
A finished line also reads `uncertain` (`line_receipt_incomplete`) until a receipt reads
the native line record of exactly this request and it lists every tile as placed.
Script-placed poles and belts get the native placement result only; read
`getEntityStatus` for wire connections and belt state.

`pick_up_ground_items` picks up items lying on the ground (`item-on-ground`
entities) in a small box: `{x, y, radius?}` covers the tiles within `radius` (0–2,
default 0; `capabilities.limits.pickup_radius`) of `(x, y)`. Placement never clears a
footprint, so this is the separate operation for a tile that a ground item blocks.
It is external-only and needs the mod capability `external_ground_pickup_supported`.
Preflight is read-only and within 128 tiles of the actor (rechecked at admission): it
lists 1–16 ground stacks (`capabilities.limits.pickup_items`) and refuses with
`no_ground_items`, `ground_items_over_limit` or `inventory_full` when the inventory
cannot take one of them. Execution walks into reach and picks the stacks up by native
character mining; it mines no tree, rock, building or resource in the box (as with
every walk, navigation may clear a tree or rock that blocks the only path).
It stops with `inventory_full` before mining a stack that no longer fits, and after 32
pickups if items keep arriving. The receipt's `observed_effect` holds the inventory
counts of the found items before and after; read the box again to confirm it is empty.

`research_technology` submits native research; its completed operation receipt does
not prove research completion. Read `getTechnology({name})` and
`getResearchStatus({})` for current requirements, progress and researched state.
`getResearchStatus` also lists `available`: up to 24 technologies the force can
research now, each with the recipes it unlocks (`unlocks`, up to 12), its science
ingredients and unit count, or `trigger_type` for a technology completed by its
trigger rather than by labs. `getTechnology` lists `unlocks` for any technology.
While other force research is active, a request is appended behind it in the
native research queue (result `queued_behind`; preflight `ready_queued_behind`)
and never replaces or reorders it. A prerequisite that is already current or
queued counts as satisfied, since it finishes first. Queue the next technology
before the current one completes so labs do not idle. `force_busy` means the
native queue refused the append: wait or replan.
A recipe that a technology still locks is reported as `recipe_locked`, not as
craftable.
Obtain recipes, availability, ingredients and sizing from live observations.
`getResourceAmounts({resource_name?, center?, radius?})` totals resource amounts
in a square of `2*radius+1` tiles around a center tile (radius 0–48, default 16;
radius 2 is an electric drill's 5x5 area). It reads only chunks the NPC can see
now: other chunks are listed as unseen, `coverage_complete` is false, and their
ore is unknown rather than zero. With `resource_name`, up to 64 tiles nearest the
center are listed with their amounts. Reading never generates or charts chunks.
`harvest_product` uses native harvesting within 64 tiles, at most 100 requested
items; its omitted radius defaults to this external bound. No items are injected.

Other advanced construction, combat, multiplayer coordination and unrestricted
world queries remain outside this slice.
Do not emulate a missing operation with RCON, generated Lua or shell commands.
The native world remains authoritative for inventory, recipes, reach, collisions,
crafting time, mining and actual output.

## Prepare an isolated local game

Prerequisites:

- Node 24 and the package manager pinned by `package.json`.
- An authorized Factorio installation; the repository's deterministic engine
  baseline is **2.1.24**. This package does not include the Factorio executable.
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
context rather than attempting takeover.

Freeplay creates its crashed-ship site and gives the starting items only when
the first player joins. A standalone NPC with zero humans never triggers that,
so a fresh save has no wreckage. To give the NPC the start a joining player
would get, run this optional operator setup action after `--bind` and before
the goal starts:

```sh
node tools/external-harness/cli.mjs --crash-site
```

It runs freeplay's own crash-site module with freeplay's configured ship,
debris and part settings, at freeplay's position. It gives the NPC freeplay's
`created_items` minus the ship and debris items, which stay in the wreckage, as
freeplay does for a joining player. It then disables freeplay's crash site so a
later human join cannot spawn a second. It refuses an unowned session, busy
native work, unsettled journal entries, a save where freeplay's start already
ran or its crash site is disabled, an incomplete freeplay remote interface, and
a non-freeplay surface. It runs once per
save; a repeat creates nothing and reports the first result. It is not an MCP
tool, so the model cannot call it. It prints a JSON report of the created
entities and inserted items.

Once bound, the MCP client launches:

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
| `factorio_library` | Search/get typed knowledge or skill guidance on demand; local advisory content, no game calls |
| `bindMachineDelivery` | Select one exact newly actor-placed chest for the already armed finite-output goal; immutable goal metadata only, with session/actor/epoch fences |
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

`factorio_capabilities` returns `operation_notes` for semantics the schemas do
not show: `craft_item` counts recipe crafts rather than items, inserter
`direction` names the pickup side, and a completed `research_technology` receipt
means research started.

`getPlacementCandidates` results carry `external_footprint` on each returned
candidate (up to 8) and an `external_placement` summary. The native search
applies `can_place_entity` only, while external placement also refuses any
non-resource entity in the footprint, such as items on the ground or the actor.
The bridge re-checks each footprint with that same rule: `eligible: false`
names the blockers. `eligible: true` covers this footprint rule only; the other
preflight checks still apply. Native candidate fields are unchanged, and
`checked: false` means the re-check was unavailable. The NPC's hidden vision
vehicle (`sgluna-npc-vision`) has no collision and is never a blocker. A checked
candidate whose footprint covers resource tiles also carries `covers_resources`,
the tile count per resource name (for example `[{name: "iron-ore", tiles: 4}]`);
it is a fact for the caller, not a refusal.
The actor's own position counts as a blocker: walk clear of the footprint
before placing there. A placed `burner-inserter` starts without fuel; it refuels
itself only from fuel it moves, so supply fuel before relying on it.

A `factorio_submit` error with `"effect": "not_happened"` and
`"journal_slot_used": false` means this call was refused before its operation
was sent to the game.
Its message names the cause, such as the walk distance and limit or invalid
arguments. Bounded `details` may name placement blockers (for example items on
the ground or the actor) and the planned footprint. Any other error keeps the
uncertain wording: read the receipt or native state before assuming no effect.

A terminal receipt may include `observed_effect`: the actor position before and
after, and the actor inventory delta for the operation's item. It is an
observation of the actor, not attribution. Other activity in the same ticks can
contribute, and `available: false` means the actor could not be re-read. It is
absent when the actor could not be read before submission.

A running receipt carries the same observation as `observed_progress`, read
once per reply and never stored; a waiting `factorio_get` reads it once, at the
end of its wait. With reason `exact_admission_in_flight` it also carries
`guidance`: the game has admitted the operation, which is queued or executing.
The reason names the native admission record; it does not mean the operation is
waiting for admission.

`observation_notes` in `factorio_capabilities` state two native rules. The
`getNearbyEntities` radius is centred on the actor's current position, so an
operation that walks the actor moves it. `getEntityStatus` reads only chunks the
force sees live now (near the actor, or radar coverage): `entity_not_visible`
means there is no live vision there, not that the entity is gone. Status names
are the native `defines.entity_status` values.

## Read-only method library

`factorio_library` exposes separate `knowledge` references and `skill` methods.
Use `action: "search"` with a nonempty `query` and optional `limit` (1–8), then
`action: "get"` with the exact `id` for full guidance. A library may declare
knowledge categories; `factorio_capabilities` lists them under
`library.knowledge_categories` with their name, summary, record count and
whether they are ordered. A search with `kind: "knowledge"` and a `category`
lists that category's records without a query, or searches only them with one.
A record's `get` returns its authored fields, the methods it names and, for an
ordered category, its position and neighbours. An unknown category is refused
with `library_category_not_found`. Search cards are bounded;
full entries are returned intact or refused above 7 KiB. A get call does not
accept query/limit, and a search does not accept an ID. No full catalog is added
to context automatically.

```json
{"kind":"knowledge","action":"search","query":"individual refueling"}
{"kind":"knowledge","action":"search","category":"stage"}
{"kind":"knowledge","action":"get","id":"stage-burner-loops"}
{"kind":"skill","action":"search","query":"smelting"}
```

The loader knows no category, entry or count by name: it validates the pack's
structure (schema, unique ids, method and related ids that resolve, bounded
size) and reports what the pack contains, so a different library loads through
the same code (`openLibrary({ file, source })`). The shipped library is the
leveled method library, the single knowledge source on every branch; its
`stage` category holds ordered game stages. `factorio_library` reads its exported fixture
`packages/autorio/src/fixtures/leveled-library-v1.json`; see
[the local library](../tools/external-harness/library/README.md) for the source
and regeneration. Source IDs are retained in each entry. Full skill
`guidance` is preserved; executable templates and native verification fields are
not exposed as authority. All entries remain untrusted advisory content, not
current availability, live facts, native mastery or permission to act.

The MCP instructions point the operator to the library before each new part
of a goal and name no category or entry. Goal acceptance is not a harness
prompt: state it in the goal text. For this owner's full-automation goals that
text carries the owner bar: the agent must not fuel individual machines as the
operating design, and initial manual priming is a declared finite bootstrap
phase only. Prefilled stocks or a short production demonstration do not
establish full automation.

Read current prototype/technology/recipe and tool facts first, including the
admitted electric-miner candidate capability. Library guidance does not add
operations or prove an unlock. Surface any missing capability before a future
goal rather than keep burner miners in the finished design. This update does not deploy
or launch a model trial.

## Automatic production tools

Generic placement eligibility comes from current prototype, recipe, inventory,
geometry and hydraulic facts. Use fresh `getPlacementCandidates` positions and
directions with explicit `place_entity` for nonfluid prototypes; exact-grid and
no-clear execution checks remain. Nonfluid candidate IDs map to their exact
coordinates, while fluid candidate IDs use the frozen native preservation path.

`set_machine_recipe {unit_number, recipe_name}` requires the exact native
compatible assembling machine. A matching recipe is idempotent; replacing an
existing recipe is refused. First assignment requires no active crafting, fluid
contents or occupied inventory. The external native witness also proves complete
empty disconnected fluid ports. Disabled recipe ports require complete prototype
geometry and a bounded visible neighbor scan proving no possible join. The same
checks run during atomic admission and immediately before execution. Unknown
geometry fails closed.

`mine_entity_exact` requires a bound persistent world identity, visible exact
actor-force/surface target, admitted session/epoch/batch identity, native mining
duration, unchanged contents and full combined inventory capacity. A verified
receipt proves recovered-item custody; partial/uncertain effects are never
replayed. Active processes and unsupported contents are refused.

Hydraulic removal and rotation share a mandatory native proof on every exact
submission, including internal plan adapters. A bounded complete current network
must be empty, idle, visible and outside every durable preservation claim's
network entities, edge endpoints and candidate footprint. Rotation additionally
proves all networks in a complete prototype-derived port/footprint envelope,
including a current-prototype search margin for off-center neighbour ports.
The queue captures world, actor/session/epoch, geometry and claim count; execution
repeats the proof and refuses any changed witness. Models cannot disable it.
Internal plans retain their additional preservation obligations and authority.

Complete claim history starts only in native `on_init` at tick zero with no prior
claim storage. An independent monotonic count is compared with the retained
claim registry and its integrity inventory. Loading/upgrading an older save,
observation or world binding never creates that history. Missing/legacy history,
truncation, nonempty/active networks, unsupported connection geometry, unseen
areas and bounded-scan exhaustion are explicit refusals. Legacy saves can still
use nonfluid paths; this is a provenance limitation, not proof that no claims
existed. New-game comparisons use the same shared proof on all three adapters.

Natural trees and rocks can be removed with `clear_construction_area`, whose
native predicate preserves resources, characters and placed/force-owned
buildings. `prepare_pump_site` executes only a current native bounded landfill
proposal. Neither action relaxes placement's no-clear flag.

Name-targeted item transfers map to bounded entity discovery and
`move_items_exact` with the selected unit number and the same item/count/direction.
Name-targeted mining maps to exact removal for supported buildings, exact
resource-position mining or bounded gathering for resources, and native
`harvest_product` for natural products. Lost exact targets never fall back to a
nearest name. These are adapter mappings, not claims of identical search policy.

`getWorldEntityFacts {request_id,members}` reads up to 32 exact locators containing
`unit_number`, `name`, `position`, `surface_index` and `force_index`. The native
world/actor/scope are derived in the same callback; callers cannot override them.
It returns input, inventory, endpoint, topology, progress, power, fluid and
removal facts without creating a factory registry or task. Unknown/truncated
facts stay unknown. Only explicit fresh-save operator setup binds a world UUID;
observation of an old unbound save refuses rather than inventing provenance.

Production, mining, research-path, spatial, map and logistics helpers share the
typed native renderers. `getTaskStatus` and `getResearchRequest` expose bounded
native receipt state. `measureTransportThroughput` owns one exact measurement
ID, checks actor/session/epoch and native idle state on start and polls, and
cancels a stalled/failed/expired sample within a bounded wall-clock budget.
It never changes game speed or treats an interrupted sample as a measurement.

Use `getEntityGeometry {unit_number}` for exact native pickup/drop relationships
and `getTransportCapacity` for live belt/inserter facts. Prototype rates are not
proof of observed throughput. `getEntityStatus {unit_number}` now includes native
`products_finished` for furnaces and assembling machines, alongside observed tick,
recipe, progress, inventories and spatial facts. Compare samples for the same
machine and recipe; a craft counter delta needs live recipe products and delivery
proof before claiming an item quantity or automatic goal completion. These reads
retain actor visibility constraints; machine status additionally requires the
actor's force and surface, while geometry reports native force/surface identities
for the caller to check before claiming a production connection. Manual input delivery
or handcrafting the final product does not prove a fully automatic production
chain; a run must freeze and verify its own acceptance window and provenance.

### Accelerated hands-off measurement (supervisor only)

`tools/external-harness/measure-window.mjs` measures an unattended window faster
than real time. It is not an MCP tool; the supervisor runs it after the operator
stops making calls, with the NPC idle and zero humans connected:

```bash
node tools/external-harness/measure-window.mjs --evidence <new dir> --speed 8 --ticks 72000
```

It reads force production statistics, research state and the actor inventory at
1×, then arms the mod's `sgluna_measurement_sprint` window. The engine restores
1× itself at the end tick, or earlier when a human joins, the actor changes or is
damaged, an enemy comes near, native work starts or the speed changes. A host
watchdog ends a window that has not finished within its 1× duration plus two
minutes. While the window runs the bridge refuses operator actions
(`nonstandard_game_speed`). The result is valid only when `reason` is
`window_complete`; rates are per game minute from actual native ticks, and
`observed_speed` is game time over wall time. Speed is limited to 2–16× and a
window to 108,000 ticks. Each measurement id can be used once.

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
While another live process holds the lock, a second one stops with code
`state_locked` (exit status 75). Issue harness calls one at a time; a
`state_locked` refusal sent nothing to the game.
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
Its `journal_write_failed` error carries `details.cause`: the failed `stage`
(`temp_write`, `windows_replace`, `rename` or `directory_sync`) and, where known, the
native error code, helper exit code, helper refusal name or a timeout flag.
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
