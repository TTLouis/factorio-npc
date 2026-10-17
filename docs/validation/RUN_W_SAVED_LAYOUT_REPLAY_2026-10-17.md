# Run W saved-layout replay and planning audit

This checkpoint records an owner-requested offline replay of Run W's saved
shoreline, plus read-only audits of planner context and next-step prediction.
Source is local integration `a4a7e3877aff1ab042d0e0186444478d751ace38`, whose
runtime/mod code is unchanged from Run W's frozen `9e00fc5c`. No live provider
or Jev calls, goal resume, remote push or deployment is included. The broader
E2E goal remains paused.

## Replay provenance and boundary

The original save is retained unchanged under the integration checkout's
`test-results/red-automation-live-2026-10-16w/data/saves/`:

`red-automation-w-checkpoint.zip`, SHA256
`4288b6027bb1d116c6c0ee929482466438d74aaf1c3dc70ccce35d9e0264fd3f`.

The replay mounts it read-only, starts an isolated network-disabled Factorio
container and operates on a copy. JavaScript uses the production structured
parser/renderer and actor/epoch-checked admission. It neither starts a provider
supervisor nor resumes the exhausted goal. Scripted actions verify mechanics;
they do not prove Luna would discover or execute the repair autonomously.
Supplies, terrain, research, energy and actor position are not fabricated.
Any crafting, obstacle recovery, movement or placement must have normal native
receipts. Read limits stay within the existing public tool schema.

## Planner world information

Run W's planner was not missing all world context. Its initial tool sequence
read inventory, actor state, science recipes and research dependencies. Before
the steam slice, it read inventory/research, pump/boiler/engine/pole/lab recipes,
actor state and shoreline candidates. The step-contract call also received
fresh held-engine information. Its plan correctly called for connected steam
power. The final executor request contained engine count one in both the fresh
handoff and an immediate inventory tool response; its engine-absent claim was
therefore a misreading of delivered facts.

There is nevertheless a concrete context boundary worth improving later:

- `npc-agent-loop.mjs:3427` gathers fresh handoff facts for the executor;
  planner packets do not carry that gathered packet.
- `npc-agent-loop.mjs:3759` resumes the parked planner conversation without
  replaying disposable executor traffic. Verified slice results are fed back
  at safe boundaries (`:3559`, `:10502`), and the planner can request bounded
  observations.
- `goal-requirements.mjs:603` grounds native research/dependencies for initial
  authoring, revisions and shelf pickup; the author-only block is capped at
  2,400 characters. `handoff-packet.mjs:49` bounds executor handoffs at 6,000
  characters with deterministic whole-record dropping.

Recommended follow-up: a small world-change summary when the planner wakes,
covering relevant stock, placed machine readiness, observed connectivity and
resource/water anchors. Include observation tick, source, actor, epoch and
surface, and explicit unknown/stale/truncated flags. Keep complete typed facts
within a measured size cap; reobserve before mutation, and never turn a cached
entity ID into standing execution authority. This is a proposal, not an
implemented fix or a demonstrated explanation for the final inventory error.

## What next-move prediction currently means

The implemented runtime authors a pending step's completion contract **just
in time**, when that step becomes active. It validates fresh grounding and
binds the contract append-only (`npc-agent-loop.mjs:7628`, `:7668`).

The planned asynchronous lane—assume the active step succeeds, prepare the
next contract, then revalidate or discard it—is **not built**. The roadmap
explicitly marks P1/P2 implemented and P3 prediction/P4 regression scenarios
unbuilt (`docs/NPC_PLANNING_ROADMAP.md:1180`, `:1237`, `:1252`). An optional
`assumedOutcome` packet field is not evidence that the lane runs.

Jev's `c4_next_step` judges the clarity of an already committed next step;
shelf ranking orders future work. Neither predicts resulting world state.
Existing placement tools compute live legality, footprint, ports and pole
coverage. `estimateProductionTime` is conditional arithmetic over selected
machines, excluding walking, transfers, placement and inserter time. These
capabilities are not a general post-action world simulation.

For steam construction, prioritize deterministic topology/obstruction facts
and verification after mutation. Run-ahead contract prediction may later reduce
waiting, but cannot by itself establish fluid connectivity, preserve a future
footprint or correct a model's false inventory claim. No prediction/context
feature is implemented by this replay task.

## Replay result and verification

**PASS for scripted native mechanics.** A fresh exact-layout query for
`steam-engine` connected to boiler 21, storage 2, returned zero legal
candidates. Native tile/entity diagnostics show the inline engine footprint
crosses water, with additional pole/actor overlap. Exploratory copied-world
attempts confirmed that removing the pole and stepping aside do not establish
a legal direct connection. The initial pole-only hypothesis was too narrow.
These exploratory attempts are retained separately from the final proof.

The final replay restarted from the pristine original save and preserved both
original poles and all original buildings. Its eight admitted operations were:

1. Craft a pipe from held iron and place a fresh candidate at (-21.5, -93.5).
2. Clear one natural tree through normal construction-area clearing.
3. Craft a second pipe from held iron and place a fresh candidate at
   (-22.5, -93.5), routing steam inland.
4. Place the held engine from a fresh connection-specific candidate at
   (-25.5, -93.5), direction 4.
5. Craft an inserter from held materials and place it at (-22.5, -92.5).

Native pipe 24 connects boiler 21 to pipe 25, which connects engine 26.
The held engine is consumed; both saved poles 22/23 retain their positions and
directions. Newly crafted inserter 27 receives real electricity. Three steady
samples at ticks **85710, 85771 and 85832** each show engine generation
**6.6666667 J/tick**, approximately **400 W** at 60 ticks/second, 200 steam in
the engine and positive shared electric network 1. Inserter energy is
268.444444 J. This is a small real load, not a nominal engine-capacity or
factory-throughput measurement. Humans remain zero, speed one, artificial
power sources zero, actor 10 and admission epoch 3 stable.

The runner uses test-oracle geometry/identity reads for diagnosis, including
resolving the newly placed pipe by position before its public status query.
It does **not** exercise the full Session/planner/executor recovery loop,
original exhausted goal or their model/read/resume allowances. Public candidate
limits stay at eight or less, mutations use the production parser/renderer and
native epoch admission, and all crafted supplies come from real stock. The
result proves a feasible native repair from the saved resources; it does not
prove autonomous discovery, red science or unattended full-chain readiness.

This changes the next recommendation: expose compact current-step topology and
obstruction facts to the executor as well as a planner safe-wake summary. A
generic legal placement is not a connected placement; no direct candidate is
not proof that a pipe-routed network is impossible. Neither broad additional
world text nor speculative next-step contract authoring establishes that
distinction automatically. Any future context/solver change needs its own
full-loop regressions; none is implemented here.

Independent review approved the frozen helper and native evidence. Parent
recomputed the original save hash and inspected the steady samples, native
operations and captured source hashes. The native run exited zero; JavaScript
syntax and shell parse checks also pass. The helper source is reusable with
the pinned original save, which remains local evidence rather than a checked-in
CI fixture:

- `tests/factorio/runner/saved_layout_steam.sh`
- `tests/factorio/runner/saved_layout_steam_factorio.mjs`

Evidence resides under `test-results/run-w-saved-layout-2026-10-17/` in this
task checkout: final `results/saved-layout-proof.json`, transcript, native log,
input before/after hashes, source hashes, retained exploratory attempts and
final command/exit/cleanup records. Only isolated replay containers are used;
the original Run W stack and unrelated containers are left untouched.

Test-helper commit: `611c206d88ac6c43b6f748e8f39468523327270d`. Parent verified
all **364** manifest file hashes/sizes. Manifest SHA256:
`944b3f5e22a308c97ea39677d2a2790153f1cae19056fa7f06b2e42f2670d4bd`.
The pinned native image is
`sha256:ba7681362ee1fd8c27718b96893d1be0dcc7b6c4735469ea27d697b907da7632`.
All owned containers were removed; parent independently confirmed none remain.
Changes stay on local task branch `test/run-w-saved-layout`, without modifying
the integration checkout or production code.

## Reproduction

From this task checkout in PowerShell, use a new output directory. The image
must already be cached; the command does not build or pull it. It starts only
the native Factorio replay, with no provider configuration mounted.

```powershell
$replayRoot = (Get-Location).Path
$originalSave = 'D:/SideProjects/airi-factorio-npc/airi-factorio/.claude/worktrees/peaceful-saha-a52c6f/test-results/red-automation-live-2026-10-16w/data/saves/red-automation-w-checkpoint.zip'
$replayOutput = Join-Path $replayRoot 'test-results/run-w-saved-layout-reproduction'
if (Test-Path -LiteralPath $replayOutput) { throw 'Choose a new output directory' }
New-Item -ItemType Directory -Path $replayOutput | Out-Null
docker run --rm --network none --pull never --entrypoint bash `
  --mount "type=bind,src=$originalSave,dst=/input/checkpoint.zip,readonly" `
  --mount "type=bind,src=$replayOutput,dst=/replay" `
  --mount "type=bind,src=$replayRoot/tests/factorio/runner,dst=/test/runner,readonly" `
  --mount "type=bind,src=$replayRoot/deploy/pterodactyl/runtime-v8,dst=/test/pterodactyl/runtime-v8,readonly" `
  --mount "type=bind,src=$replayRoot/deploy/pterodactyl/staging,dst=/test/pterodactyl/staging,readonly" `
  sha256:ba7681362ee1fd8c27718b96893d1be0dcc7b6c4735469ea27d697b907da7632 `
  /test/runner/saved_layout_steam.sh
if ($LASTEXITCODE -ne 0) { throw "Replay failed: $LASTEXITCODE" }
```
