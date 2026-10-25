# Paired red automation harness

Owner: `paired_e2e_harness`, parent `/root` in chat `01a171d1`. Task branch:
`test/paired-red-automation`, created from Jev
`11d182c1aa8650c9254a58ee8dc4bfc3fe7b936a`. Parent owns candidate review,
integration, builds, live controls, quota observations, overwatch and reports.
This kit does not authorize a trial, provider retry, publication or deployment.

Preparation is candidate agnostic. The contract-obligation repair must be
reviewed and integrated before the parent selects the next runtime candidate.
Do not freeze the old AV runtime merely because this kit was developed from it.
The separately reproduced goal-admission cancellation fence must also be fixed
and checked on the combined candidate: the old runtime can start a provider
request after an aborted steering call. Kit tests prove control dispatch and
intake ordering; they do not prove that old runtime safe to launch.

## Provenance and contracts

All 62 AV helper inputs were checked against its manifest SHA-256
`8dbb4ccf9bf0d0b54c3a01468d9e730f7258e408c0738ac8eef6cfb75af56559`.
`av-provenance.json` records the explicit helper allowlist and original/adapted
hashes. The three historical regression inputs have separately verified hashes.
Templates contain no AV data, traces, saves, runtime configuration, release image
identity, expected deployed modules, compiled mod or old run/resource intent.
Those inputs are freshly generated from the selected candidate or supplied
independent compile. AV remains sealed and is never edited by this kit.

The AV goal, starter, normal 1x construction, 60 minute construction cap, provider
and recovery limits, and separate five wall minute / ten game minute measurement
at 2x remain in force. Acceptance requires new native red assembler output of at
least one pack per game minute plus verified upstream production and topology
approval. No corrective prompts, manual resumes or provider retries are added.

Each lane has its own map seed, data directory, model recorder, tunnel, Docker
project, RCON/game host ports, checkpoint, identity, approvals and evidence. Both
internal RCON listeners use 27015. Each game listener uses its matching distinct
host/internal `SERVER_PORT` (34197 or 34198). All host publications are loopback.
Numeric native actor IDs may coincide across fresh worlds; identify an actor by
`(runId, actor_id)` and a goal by `(runId, goal_id)` in pair reports.

## Offline verification

Run from this checkout in PowerShell:

```powershell
& scripts/e2e-pair/test-offline.ps1
& 'C:/Program Files/Git/bin/bash.exe' scripts/test-local.sh all
```

The first command creates a unique ignored evidence directory and a clearly
labelled fake-native helper fixture. It runs built-in Node freezer/schema tests,
PowerShell parsing and real-script cleanup mocks, then cached Docker helper and
ZIP regressions with `--pull never --network none`. It records exact names/IDs
before use and verifies absence in `finally`. It creates no live world, model
request, tunnel, recorder or image. Never use its fake native tree for a run.
The second command is the repository's unchanged required offline gate.

The R1-R3 follow-up also executes the complete runner entry point under explicit
filesystem/RCON substitutes, and the actual top-level prepare/launch scripts with
resource-boundary substitutes. It injects owner/stale/floor stops before intake
and while LLM/Jev work is pending without a persisted goal; no-goal confirmations
remain incomplete. Immutable `ff98d3e5` negative controls reproduce all three
review findings. The original runtime cancellation defect has its own real-agent
offline reproduction and remains a separate combined-candidate launch gate.

Coverage includes resource/port isolation, map seed drift/refusal, source/native
manifest mismatch, immutable output, each lane's fresh stop/save sequence,
stale/floor/ambiguous quota evidence, runner/emergency exceptions, failed Docker
inventory, sibling independence and image-retention fences. Native map generation,
installed file matches, strict save verification and pristine Factorio 2.0.77 load
still run independently in each actual lane. Offline fixtures do not prove native
engine or autonomous gameplay success.

## Freeze a reviewed version

The parent supplies a new local `freeze-input.json` under ignored `test-results/`:

```json
{
  "repo": "D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation",
  "output": "D:/SideProjects/airi-factorio-npc/.worktrees/test-paired-red-automation/test-results/red-automation-pair-2026-10-25aw",
  "candidate": "FULL_REVIEWED_INTEGRATION_SHA",
  "published": "FULL_FRESHLY_VERIFIED_PUBLISHED_SHA",
  "imageId": "sha256:IMMUTABLE_BUILT_IMAGE_ID",
  "nativeBuildSource": "FULL_REVIEWED_INTEGRATION_SHA",
  "nativeDir": "ABSOLUTE_NEW_INDEPENDENT_COMPILED_MOD_DIRECTORY",
  "nativeManifest": "ABSOLUTE_NEW_EXPECTED_NATIVE_MOD_MANIFEST",
  "version": "aw",
  "date": "2026-10-25",
  "seeds": [2026102501, 2026102502]
}
```

The manifest format is an array of `{ "path": "relative/path", "sha256": "..." }`
using CR-normalized Lua/JSON/LICENSE text, as in the AV verifier. Verify the native
compile's provenance, offline gates, payload ref/hash, source ownership and image
contents before supplying these inputs. Record online published verification and
all gate/build/payload identities in the parent's source-freeze evidence. The
freezer derives installer-enumerated runtime hashes and prompt hash directly with
`git show` from `candidate`; it checks the complete native compile file set/hash.
It also copies the candidate's exact `compose.yml` and `compose.e2e.yml` into each
lane's `frozen-compose/`. Stack up/down use only these manifest-listed copies and
the lane overlay, with immediate embedded hash checks. `--project-directory` is
the lane directory, `/data` and `/e2e` mounts are absolute, and the overlay resets
the build section because only the immutable prebuilt image may be used. Later
changes to the source checkout's Compose files cannot redirect setup or cleanup.

```powershell
node scripts/e2e-pair/pair.mjs freeze test-results/freeze-input.json
```

No default candidate/image is chosen. Existing output is never replaced. The
result contains `a/`, `b/`, `pair.json`, coordinator scripts and a pair manifest.
The parent must review that exact kit and manifests before launch. Source/image,
seeds and helpers stay fixed throughout both lanes.

The parent builds one unique pair image/tag without replacing a shared tag.
Before building, prove `factorio-npc:run-aw-20261025` absent. Preserve that check
and the build/image receipt, then create `image-capability.json` beside `pair.json`:

```json
{
  "pairId": "red-automation-20261025aw",
  "imageTag": "factorio-npc:run-aw-20261025",
  "imageId": "sha256:THE_SAME_IMMUTABLE_IMAGE_ID",
  "tagInitiallyAbsent": true
}
```

This is a record of verified ownership, not permission to assert ownership of an
existing tag. Use the reviewed local build procedure with a unique-tag override;
do not invoke an unmodified builder that overwrites `factorio-npc:local`. Compose
uses the immutable image ID. Neither lane builds or deletes images.

## Parent-controlled launch and stop

The following commands operate on the **frozen output directory**, after the
parent's review and live authorization. Run them from the candidate repository
or supply absolute paths. They are operating instructions, not preparation tests.

1. Read live account usage with `get_usage_limits`. Select exactly one window
   whose `windowDurationMins` is 10080. Record the actual shared-account remaining
   percentage, observation timestamp in Unix milliseconds and match count:

   ```powershell
   & ./record-quota.ps1 -RemainingPercent 25 -ObservedAtUnixMs ACTUAL_TIMESTAMP -MatchingWeeklyWindows 1
   & ./prepare-pair.ps1
   ```

   The example percentage is illustrative. Never reuse it as an observation.
   Refresh with actual account evidence at least every 90 seconds, including
   preparation. Evidence expires after 180 seconds. Exactly one weekly window,
   `get_usage_limits`, parent ownership and pair identity are mandatory. Reserve
   remains 5%; live stop is 7% across the shared account, not 7% per lane.
   Preparation holds an exclusively created `controller.lock` and records the
   exact `pair-prepared.json` ownership capability on success. A later launch
   atomically acquires that controller capability and records a single launch
   attempt before checking quota/preflight. Refusal cleans both owned prepared
   lanes, even if the first cleanup fails. An existing controller or lifecycle
   attempt makes a duplicate invocation refuse without touching its resources.
   A stale lock is evidence requiring owner inspection; the kit never steals it.

2. Preparation runs native offline `--create --map-gen-settings` separately for
   the explicit seeds, with the independently compiled candidate mod. It then
   starts each lane's owned tunnel/recorder/stack and verifies installed modules,
   native files, effective models, cold state and **native seed equality**.
   It gives no starter and makes no inference request. A preparation failure
   attempts both lane cleanups, retaining failure evidence and the pair image.

3. The parent launches one dedicated read-only `gpt-6-luna` overwatch per lane,
   each writing only its own `overwatch/`. They finish with their lane, send no
   routine parent messages and cannot call providers or alter controls/gameplay.
   Launch the pair once:

   ```powershell
   & ./run-pair.ps1
   # Optional policy already authorized by the owner:
   # & ./run-pair.ps1 -StopPeerAfterVerifiedSuccess
   ```

   One lane failing does not stop its sibling. Each runner independently repeats
   the cold/seed check immediately before its one starter and normal goal intake.
   A successful wrapper exit is not gameplay success. Optional peer cancellation
   requires the other lane's native success result, measurement proof and fresh
   sample reevaluation; mere placement or claimed completion cannot trigger it.
   Before the starter, the runner writes `e2e-launch-control.json` with immutable
   run/source/actor/epoch/control identity. Host stop writers and the actual intake
   boundary share an exclusive launch gate. Stop requests can therefore cancel
   owned pending intake immediately without waiting for goal persistence. The
   control path reads durable identity/state and issues stop commands; it adds no
   native world observer. Once a goal is present, the original strict same-goal
   receipt/save contract applies. No-goal stop evidence stays explicitly
   incomplete and cannot become a fake strict confirmation or gameplay pass.

4. Parent stop commands preserve distinct results:

   ```powershell
   & ./request-stop.ps1 -Lane b -Reason owner_canceled
   # After a is verified by verify-peer-success.mjs:
   & ./request-stop.ps1 -Lane b -Reason canceled_after_peer_verified_success
   ```

   The second command rechecks the peer's immutable acceptance evidence and
   binds the request to B's own run/goal/actor. It never labels B a gameplay pass.
   Quota floor/stale/unavailable events write distinct requests to both lanes.
   The coordinator immediately requests lane-scoped supervisor cancellation;
   each runner then obtains its own fresh cancel + same-goal operator-pause,
   confirms native idle/empty queues, saves, checks the full ZIP and performs a
   pristine 2.0.77 load. The normal runner polls at its preserved 90s cadence;
   measurement cancellation is checked at its existing 15s sampling boundary.

5. Both lane wrappers clean their exact Compose resources and PID/start-time
   verified tunnel/recorder. The coordinator handles cancellation and worker
   exceptions, attempts both lanes even after a cleanup failure, and checks owned
   wrapper processes. A failed stop/save/load remains a failed verification with
   retained logs; cleanup is never represented as gameplay success.

6. Only `finish-pair.ps1` can remove the unique pair tag, after both lane cleanup
   receipts **and fresh** container/network/volume inventories plus wrapper
   absence. It verifies the pair capability and exact current tag ID and never
   uses `image rm -f`, deletes by image ID, prunes, or applies the invalid AV
   ancestor-any-container guard. An active sibling cannot lose its image through
   lane cleanup. If cleanup fails, the unique tag is retained and the failure
   artifact names the recovery boundary. Run that same finish command after
   resolving only the exact recorded owned leftovers.

`combined-call-index.json` indexes per-lane and combined request events across
rotations, with missing telemetry represented as unavailable. Cost remains
explicitly unpriced until the parent's complete per-model/role report provides
usage, rates/source/date and subscription assumptions. Preserve independent lane
reports for recovery/tools/time/actual plans/API usage/prices, plus the pair total;
do not turn per-lane request guards or Codex quota percentages into a global
request budget or monetary cost.

## Checkpoint and remaining gates

Implementation scope is harness preparation and deterministic verification only.
Parent review, final repaired candidate selection, immutable source/payload/build
freeze, independent per-lane native preflight, overwatch and actual paired trials
remain with the parent. No live world, inference, Jev call, image build, tunnel,
listener, publication or deployment was started during kit preparation.
