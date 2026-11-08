# One codebase, three harness modes

`main` contains the shared runtime and all three selectable lifecycles. A mode
changes who plans and owns continuation; it does not select a different native
mod, world-tool implementation or recipe library. All modes remain experimental.

| Mode | Decision and lifecycle owner | Startup |
| --- | --- | --- |
| `external` | External assistant; serialized durable operation journal, stdio MCP | Connects to an already running, bound Factorio host; no internal provider calls |
| `plan` | Built-in planner/executor; immutable committed plan, step contracts, bounded recovery and optional Jev | Existing installed server supervisor starts and owns Factorio |
| `pursuit` | One built-in operator; durable notebook, context rotation, budgets, native goal evaluation and bounded unaccepted yields | Connects to an already running, bound Factorio host with an explicit goal profile |

## Select before startup

From the source checkout, using Node 24:

```sh
node tools/harness/cli.mjs --mode external
node tools/harness/cli.mjs --mode plan
node tools/harness/cli.mjs --mode pursuit --profile /private/pursuit-profile.json
```

The source command defaults to `external`. `SGLUNA_HARNESS_MODE` accepts exactly
`external`, `plan` or `pursuit`; a conflicting `--mode` or an unknown value fails
before loading a lifecycle. `--help` requires no credentials or game connection.
The matching package scripts are `harness`, `harness:external`, `harness:plan`
and `harness:pursuit`. No command changes a running controller's mode.

The source `plan` command requires the existing installed server layout
(manifest, Factorio binary, compiled mod and configuration); a plain clone is
not that installation. Use the [server installer](../deploy/pterodactyl/README.md)
or [Docker build](../deploy/docker/README.md) first. The installed command is
`node <release>/src/runtime-v8/harness-cli.mjs --mode <mode> ...`. The installed
`start-sgluna.sh` retains `plan` as its default and honors `SGLUNA_HARNESS_MODE`.
For pursuit through that script, set `SGLUNA_PURSUIT_PROFILE` to the profile path.
Both server channels now resolve the same `main` source. Their historical names
remain compatibility labels, not different implementations.
The panel exposes optional RCON, world-session, state-directory and pursuit
provider fields. Fill the fields required by the selected mode. In particular,
set the existing host's RCON port explicitly for external or pursuit; leaving
the panel port blank preserves plan's automatic port selection. Password and
gateway-key fields are hidden and remain environment-only.

External and pursuit startup do **not** start a second Factorio server. Prepare
the host and session using [external setup](EXTERNAL_HARNESS_SETUP.md), then
connect the selected lifecycle. A plan controller must not own that host at the
same time. External and pursuit share the same durable journal lock. Their
native session, actor, epoch, pending-work and uncertainty checks remain active.
Stop the previous controller, reconcile receipts, prove native idle and preserve
the paired save/state before an intentional mode change. No automatic rebinding,
save conversion, replay or state migration is performed.

Legacy entrypoints remain supported: `tools/external-harness/cli.mjs` selects
external, `tools/pursuit/cli.mjs` selects pursuit, and `supervisor.mjs` selects
plan. Each rejects an environment requesting a different mode. Imported APIs
re-export the canonical implementation without starting it.

## Configuration and evidence

External uses `SGLUNA_RCON_HOST` (loopback), `SGLUNA_RCON_PORT`, injected
`SGLUNA_RCON_PASSWORD`, `EXTERNAL_HARNESS_SESSION` and
`EXTERNAL_HARNESS_STATE_DIR`. The setup guide covers one-time binding and private
state requirements, including durable Windows journal replacement on local NTFS.

Plan retains its existing `sgluna-config.json`, environment precedence, provider
roles, owner-goal intake, task board and supervisor stop/save lifecycle. Mode
selection does not replace its provider configuration or grant live-run authority.

Pursuit adds injected `OPERATOR_PROVIDER_BASE` and `CLI_PROXY_GATEWAY_KEY`.
Its non-secret JSON profile contains `runId`, `goalId`, `model`, `brief`,
`wallCapMs`, `goal`, and optional `options`, `cacheSystemPrompt`, `maxTokens`.
`goal` uses the common deterministic goal-definition contract. Supply an explicit
owner goal and read current recipes and sizing from live tools. State, notebook
and original provider/tool evidence remain under
`<STATE_DIR>/pursuit/<goalId>/`. Wall caps, signals and a matching `STOP` file
stop inference; the host still owns native cancellation, idle proof and save.
Provider failure is terminal for that pursuit attempt, not permission to retry.

## Shared authority and intentional differences

`packages/autorio/src` is the sole native implementation. The existing staging
policy/authorized admission adapter and runtime-v8 policy extensions own shared
operation parsing, observation schemas, legality, admission, exact receipts,
cancellation and stale/uncertain-work fences. `method-library.mjs` and the one
leveled library export supply advisory knowledge to all lifecycles. Native goal
conditions and `machine-delivery.mjs` remain the acceptance authority.
The canonical advisory search projection is bounded to eight results with a
default of five. The older native `autorio_skills.find` compatibility endpoint
retains its ten-result maximum; the host projection does not advertise that
broader native bound. Neither bound is a gameplay fact or execution permission.

Within runtime-v8, `operator-native-bridge.mjs`, `operator-runtime.mjs` and
`operator-tool-surface.mjs` are shared by external and pursuit. External MCP and
pursuit's in-process tools use the **same catalog object, argument validation
and dispatcher**. The old tools-directory paths are compatibility wrappers.
The installer ships this complete module set, library export and Windows helper
once and includes them in its integrity manifest.
Installed `start-sgluna.sh` verifies that manifest before importing any selected
lifecycle or opening native/provider connections. A damaged or unreadable
release stops with `release_integrity_failed`; success emits no stdout. Source
CLI use retains its existing setup requirements and does not require an installed
manifest. Direct plan-supervisor startup keeps its own manifest check.

Plan's `NpcAgentLoop` and `Session` additionally enforce committed-plan authority,
placement provenance, factory-cell enrollment, step preservation and recovery
budgets. These are plan lifecycle requirements and are not removed to make the
operator modes imitate a committed plan. Pursuit's operator cannot assert native
success; unaccepted yields receive native unmet conditions and are bounded.
Context rotation cannot reset its request/tool budgets or replay operations.
External leaves strategic continuation with its caller while keeping the same
world-action safety boundaries. The contract manifest records intentional tool
surface differences; this migration does not grant unsupported operations.

## Preservation checkpoint

The shared source combines external main `a6e5f85a`, plan `a6155156` and pursuit
`75b9d2f5`. Main's shared world tooling, canonical library, finite delivery,
Factorio 2.1 compatibility and terminal transfer-refusal behavior are retained.
Plan contributes its owner-goal intake, factory lifecycle/provenance, library
retrieval, notebook and starter-base native acceptance. Pursuit contributes the
operator/provider, shared operator catalog and continuation/yield supervisor.
Historical refs and reports remain unchanged. In particular, the earlier plan
placement-provenance failure is not repaired or reclassified by consolidation.
Offline route/native checks establish only the exercised boundaries; this source
migration does not constitute a new autonomous gameplay trial or production proof.
