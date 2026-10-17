# Fresh topology, placement obstructions and capacity planning

Owner-requested follow-up to Run W: give planner and executor lean, fresh
world/topology facts; explain sampled native placement obstructions; expose
prototype-grounded capacity ratios for sensible expansion planning. Validate
through full-loop static and real-Factorio tests, independently review, merge
into `experiment/jev-agent-architecture` and push after checks. The live E2E
goal stays paused; this task authorizes no provider/Jev inference or deployment.

## Design and authority

- Native observations describe current connections, fluid contents, power
  network/status and running-prototype capacities. Rated capacity is distinct
  from current generation or a throughput guarantee.
- Failed placement checks carry bounded samples of intersecting terrain and
  entities, with explicit unknown/truncated flags. No direct connected candidate
  is not proof that a pipe-routed network is impossible. Samples grant no
  clearance, removal, navigation or placement authority.
- Planner context remains a small current summary, not the executor transcript
  or a whole-world dump. Executor context carries the same relevant grounded
  facts. Observation tick, actor/epoch, surface and source accompany facts;
  changed lineage, pending mutations and unavailable reads must not masquerade
  as fresh knowledge.
- Context refresh is bounded at safe boundaries. It does not mint candidate IDs
  through automatic placement searches, reset the model observation ledger or
  create additional closed-turn targeted reads. Already admitted placement
  observations supply obstruction information.
- Capacity ratios come from compatible native fluid/temperature/rate facts.
  A vanilla boiler's nominal two-engine capacity is an expansion-layout fact,
  conditional on full heat/input supply, rather than a rule that two engines
  must be built now. Unknown or modded values must not inherit a memorized ratio.
- Immutable goal/plan ownership, admission, actor/epoch fences and all existing
  provider/output/recovery limits remain authoritative. Asynchronous next-step
  contract prediction is outside this change.

## Ownership and gates

| Work | Owner | Required evidence |
| --- | --- | --- |
| Native observations and obstruction/capacity derivation | topology_native_facts | Bounded read-only facts, mod tests, typecheck/Lua |
| Context delivery and serialized full-loop static tests | topology_runtime | Both actual roles, freshness/budget/size negatives, original-code controls |
| Full-loop native fixture | topology_engine_tests | Real Session, typed reads, admitted pipe route, measured generation/load, baseline controls |
| Review, integration, merged gates and push | parent | Independent frozen review, canonical checks, exact remote SHA |

Task starts from integration `a4a7e387`, with reviewed saved-layout replay
`1137d98a` retained as a dependency. Current remote was fetched as `37d5728b`.
Historical Run W saves/traces and the separate replay evidence remain unchanged.

## Implemented behavior

Native nearby/status reads now include actor/tick/surface/force scope, machine
status, fluid contents/capacity and reciprocal connection evidence. Prototype
power and thermal ratings are nominal **normal quality**. Compatible boiler
output and generator input rates produce a conditional expansion ratio; live
generation and stored energy remain separate observations.

`getPlacementCandidates` now explains at most three native-rejected compatible
footprints. Each sample checks at most 64 tiles and 32 entities and returns at
most four tile/entity witnesses. These are collision-mask intersections, not
an exhaustive cause list or permission to clear a player structure. Unknown
and truncated results are explicit. Candidate legality, TTL, exact target and
held-item admission remain unchanged.

`topology-context.mjs` projects the relevant observations into a volatile record
of at most **1,950 characters**. Planner and executor see the same relevant
facts, including JIT contract and C7 common recovery boundaries; the executor's
combined handoff remains within its existing **6,000-character** limit. No
executor transcript is copied into the planner. Selected inventory omissions
mean unknown, never an authoritative zero. Nested port/storage omissions also
set the truncation flag.

A safe-boundary refresh uses at most three bounded data reads (nearby,
inventory and one relevant named prototype), plus deployment scope fences.
Repeated decisions at the same boundary reuse the scoped snapshot; they do
not solve placement candidates or refund/extend a model observation ledger.
Context is as of its observation tick, not a continuously live simulation.
Changed actor/session/epoch/surface/force, a pending mutation or changed mutation
watermark invalidates it. Sampled placement witnesses come only from already
admitted observation calls and cannot survive an intervening mutation even if
both operations finish at the same tick. Trace `context.topology_refreshed`
records request, reason, scope, read count and zero background candidate solves.

The running vanilla prototypes report 60 steam units/second from a fully
supplied boiler at target temperature, versus 30/second rated engine use:
**two engines per boiler**. This suggests leaving room and pipe access for
compatible capacity partners. It does not add a second engine to the committed
goal, reserve a footprint or claim both engines are currently fueled/powered.
Missing, incompatible or nonfinite capacity evidence produces no assumed ratio.

## Static verification and integration findings

- **33 focused topology cases** cover actual Session and role-resolved CLI-proxy
  serialization; planner/executor records; held engine ninth in inventory;
  candidate rejection and pipe routing; JIT contract planning; C7 receipt to
  fresh executor context; immutable goal/steps and unchanged resume allowance;
  stale/malformed/oversized or wrong actor/session/scope data; pending and
  same-tick mutations; nominal/modded/unknown temperature/rate compatibility;
  whole-record size and nested truncation.
- Pre-feature runtime `020b9573` fails the new positive case specifically because
  the fresh compact record is missing. Controls are retained under task
  `test-results/`; they do not use live model credentials.
- The broad gate found two integration omissions beyond the focused tests:
  shared prompt-tail recognition and installer module shipping. Both were
  fixed. A new prefix test proves changing topology leaves stable prefix bytes,
  cache breakpoints and terminal/last-user classification intact. Golden
  updates retain 11 provider calls and the original 144 event names/order,
  adding exactly three zero-data-read unavailable/deferred context trace rows.
- Installer copy and manifest lists include the new module. The standalone
  source and payload pins were updated through immutable ancestor commits;
  channel defaults and API URL/key/model fields were not changed. The payload
  SHA256 is `657b8897a86ff1aa70a61dba8d2ce9b301d252edff18a641731d02e912d7fe6b`.
- Final task runtime gate passes **2,517 tests**. The prior complete gate passes
  **1,150 mod tests**, typecheck, Lua build and generated-Lua validation; mod
  code is unchanged by the final summary-only delta. Nine payload tests pass.
  Merged checks and final native evidence are recorded at promotion below.

## Full-loop native proof

The `fresh-topology` lane creates a declared deterministic W-like shoreline,
pump/boiler/two poles and startup stock before the objective. It does not load
or alter the original Run W save. After objective submission, a real Session
uses role-resolved scripted replies and the actual CLI-proxy serializer. Native
reads and normal admitted crafting/placement supply the world changes. There
are zero humans, external model/Jev inference, artificial power or post-start
terrain/stock/teleport edits.

Both provider roles receive native-scoped context and the conditional 1:2 ratio.
The executor observes zero direct engine candidates plus shoreline/pole
witnesses, crafts two real pipes, routes steam inland, places its held engine
and crafts/places a real inserter load. Three steady samples show steam present,
**400 W generation** and an energized consumer on the same positive network.
The original poles remain. A further admitted read reports two legal candidates and returns one
nonoverlapping connected footprint for a future second engine; the goal/step stays
unchanged and exactly **one** engine is placed. Lean inventory omission and
authoritative native engine depletion are asserted separately.

A component assertion projects an actual four-port native pipe through the
production summary helper and verifies three retained ports with explicit
truncation. Static full-loop tests separately verify that truncation on both
serialized roles. The native test is included in the existing required CI
Factorio job after its ordinary deterministic lanes.

This proves full-loop contract delivery and native continuation with scripted
decisions. It does not prove that a live model will select the repair, sustained
red-science throughput, stored footprint reservations or asynchronous next-step
prediction. The broader live goal remains paused.

## Promotion record

Frozen production source: `f3903af52c79796ac8c8837fecab692a3cc0b2d4`.
Final test-only correction: `932e21443a02e8642626f4e1de14814268db490a`.
Independent source, invariants, follow-up delta and immutable payload review
approved without blocking findings.

Native validation deliberately maps two immutable sources rather than claiming
all lanes ran on the same final image:

| Source | Image ID | Scope |
| --- | --- | --- |
| `3d89bc164b1440605304b655a03a482cece02863` | `sha256:2c6b89adbf477f0b7fb5f97aee4a73ce36f31dc1b16d82d839864da5e1d396ab` | Complete 23-lane suite, including fresh topology |
| `f3903af52c79796ac8c8837fecab692a3cc0b2d4` | `sha256:bfc20cce285e75998c2d5d844ac3e47ba921c6822d6e58e10ee783c0735a31aa` | Final production delta: shoreline recovery and normal observation pass; fresh-topology fixture provenance failure retained |
| `932e21443a02e8642626f4e1de14814268db490a` | `sha256:c23de29f686824ca7598116b07ed0b80697af354edef26c0e0eea20287fb3697` | Corrected fresh-topology fixture, with identical production files |

The native compiled mod bundle, Session runtime, prompt-tail classification,
supervisor adapter, structured policy and admission guard are byte-identical
between these images. The production delta is the bounded topology helper's
nested truncation flag; its five added full-loop cases pass in the final
2,517-test runtime gate. The final native fixture also checks actual four-port
projection and separates inventory omission from authoritative depletion.
Payload pin changes are verified separately by the nine installer tests.

Production metadata source archive SHA256 (`f3903af5`):
`9dc93dda1957890c5647eeac350c1aeff99b571d09e8214c6f23886ce03f101c`.
Final fixture source archive SHA256 (`932e2144`):
`5ccf0cad9dbce743d3403aa52fab33033d810929a0d38a7bc6f6e9db4e270cf6`.
Final shipped helper SHA256:
`0f97be1436cb5c79afab22952b6f39fa8f17cc752ca2d6052037561a42f345cc`.
Native compiled mod SHA256:
`8152e680c6591e28eb199c64d1e87120c9db0ada54a8c4cd80410452c6c62f8d`.

The first final-image fresh-topology replay exposed a component-fixture error:
it projected the normalized tool reply, which intentionally omits native scope.
The helper correctly rejected it. Test-only `932e2144` instead reuses the same
captured raw native reply for the observed pipe and asserts its actor/surface,
native tick, four actual ports, three retained ports and both truncation flags.
There is no extra world read or synthetic provenance. The failed artifacts
remain preserved. Independent review approved this correction without changing
production or weakening either truncation assertion.

All 23 native lanes pass on `3d89bc16` (six batch exits zero, plus the new
fresh-topology lane; 92 Python smoke assertions). On `f3903af5`, shoreline
recovery and normal observation pass. The corrected `932e2144` fresh-topology
lane passes with actual native four-port/three-port truncation proof and three
steady generation/load samples. Every native container runs with network
disabled. The original-runtime negative control fails specifically on missing
planner context before any admitted gameplay command (`sentCount: 0`).

Native evidence is sealed in `evidence-manifest.json`: **1,531 files**,
SHA256 `ee77536ebaa681cf976eb295d41d60bfcc704e20828058b95108599e1295bed3`.
The parent independently verified every relative path, byte count and file
SHA256, as well as the manifest count/hash. Final native proof SHA256 is
`6a23f4b6cf1cc1a26cefbd678d35bb4131202d20181770c78a073343f7b7edc2`.
Source archives and the original Run W save hash were independently checked.
All owned native containers are down; exports, saves and failed-attempt
evidence remain preserved. No unrelated container was modified.

Merged gate and publication target follow below. Local evidence is retained
under task checkout
`test-results/fresh-topology-2026-10-17/` and `test-results/topology-*.log`.
