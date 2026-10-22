# NPC reserved spaces

Owner request October 22, 2026: first purple/black checkerboard tile; automatic
validated cut/restore without confirmation; separate blueprint/pin review mode
that waits for a real player before releasing the site to a future designer.

Task `feat/npc-area-reservations`, Codex/root session01a16167. Source local Jev
candidate `62a585c58e9ad8d3cc75c7a4618f8dc6253fe40e`. Existing five historical
untracked integration reports remain protected. No push, live provider trial or
deployment is authorized by this implementation task.

Acceptance:

- [x] Native checkerboard blocks ordinary building; explicit NPC direct,
  candidate, batch and ghost fences cover the whole footprint.
- [x] Auto mode cuts only after native validation and a verified native backup;
  original visible/hidden/double-hidden tiles and supported entity state survive
  restore and save/reload. Unsupported or connected entities reject the site.
- [x] Review mode keeps the world intact, stores a real boundary blueprint and
  displays outline/pin; only a same-force native player action approves the
  unchanged revision/snapshot. Model proposals cannot change mode or approve.
- [x] Designer handoff is gated on actual reservation; exact revision return or
  player reversal restores originals. Intruders/partial errors preserve backup.
- [x] Canonical runtime tools, operation metadata and reservation completion
  predicates agree; receipts alone do not prove reservation or production.
- [x] Docker runtime/mod/type/Lua/lint, deterministic native lane, payload repin,
  independent review, local integration and exact owned-resource cleanup.

The initial round-trip support is intentionally explicit: natural trees,
solid resources and named vanilla rocks, vanilla chests and isolated vanilla furnaces /
assemblers. Unsupported entities, electrical/wire/fluid connections, actors,
vision vehicles, crude oil, filled fluid boxes and entities crossing the boundary are ineligible. Equipment/container/spoilable item stacks and entity snapshot entries exceeding 8 KB also reject before any cut. A reservation
does not grant permission to flatten an unsupported factory. Cloning replaces
native unit identities; restoration reports their mapping, and subsequent live
placement must revalidate. Blueprints are review artifacts, never world backups.

The future designer has a native gated input/return interface; no new inference
agent or autonomous designer is created by this feature. Construction robots
remain deferred. Tests use scripted models and native Factorio, without providers.

Proof and remaining scope:

- Offline Docker runtime/mod/type/Lua/generated-Lua and ESLint gates: 3,076
  runtime tests and 1,346 mod tests. Golden updates change request hashes for the
  new catalog/schema; observation context and gameplay traces are unchanged.
- Native Factorio 2.0.77, zero humans, normal speed, no providers: `native-16`
  proves save/process restart, visible/hidden/double-hidden tile layers,
  inventories/quality, blueprint metadata, in-progress furnace, seven normal
  placement refusals, all 37 admitted vanilla prototype round-trips, passive
  review markers, missing-player refusal and conflict-preserving reversal.
  Full logs and saves are under `test-results/npc-area-reservations/`.
- Each reservation owns `sgluna-reservation-<id>`, a temporary native surface,
  and a durable journal. Clones are checked before originals are cut; visible
  tiles are copied to the surface and hidden layers remain in the journal.
  Machines are frozen there. The surface survives restart and is deleted only
  after the complete restored scene matches. Conflicts retain it.
- Review uses a stone-path perimeter blueprint, purple native outline and map
  pin. Factorio cannot blueprint a tile without a placement item. No paving or
  ghosts alter the live site. Actual player approval and UI provenance have
  unit-test proof only: headless Factorio cannot manufacture a LuaPlayer. The
  test image prepends a fixture for mode/marker inspection, never approval.
  That fixture does not ship in the production installer.
- `/npc-spaces` selects modes, reviews and reverses sites. Trusted host operators
  may use native `reverse(id, revision)`, which cannot approve review. Models
  expose neither approval, reversal nor mode changes. Immutable designer input
  has stable offset pages (16 entries and bounded JSON). Completion binds native
  state to the canonical goal and plan.
- Initial limits: 2–32 tiles per side, 64 entities, four pending/active sites,
  validation age 3,600 ticks and the actor's visible local 64-tile area. Stale
  proposals retire without mutation. Restored unit IDs must be rebound. Other
  engine versions/mod combinations, connected factories, filled fluids and
  external mod state remain unpromoted.

Checkpoint: implementation complete; frozen-candidate and merged-head gates,
payload identity, independent final review and resource cleanup follow.
