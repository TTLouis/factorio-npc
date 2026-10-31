# Native factory activity facts — October 29, 2026

The existing internal exact-member observer adds four bounded factual views.
They remain subordinate to its world/actor, idle and current-visibility fences.
They do not enroll cells, bind suppliers, authorize cleanup or commission output.

`progress_facts` reports native completed crafting cycles for crafters, cyclic
progress for drills, and the last-tick energy sample and quality-aware maximum
production for generators. Zero, missing, error and non-applicable are distinct.
Crafting cycles are not item quantities; mining progress is not a cumulative
output counter. `fuel_item_facts` classifies accepted fuel from live item fuel
categories and values, capped at 2,048 inspected prototypes and 64 matches.
Incomplete membership cannot prove that an item is not fuel.

`consumer_facts` and `incoming_item_facts` share a whole-surface, all-force native
transport enumeration capped at 128 candidates. They describe direct ordinary
inventory interfaces: inserter pickup/drop, miner drop and loader container
links. Exact connected rows remain distinct from potential dormant geometry;
potential links make coverage incomplete. Ordinary containers and machines are
not belt-connectable, so unrelated belts do not block their inventory cuts.
Native loader container links identify even an empty connected container.
Hidden fixed-vector inserters may be excluded by live prototype reach/footprint
bounds. Custom or unknown hidden endpoints remain unresolved; no arbitrary
search radius grants absence. Unsupported logistics, fluid, heat and shared
electric cleanup are not certified by this direct item adapter.

`electric_component_facts` enumerates native electric-source prototypes, poles
and switches, then a capped whole-surface entity set. It reports exact visible
members of the current native network, their buffers, quality-aware production
capability, roles and native copper wire edges. Storage, interfaces and additional
producers remain explicit even if unregistered. Unknown capabilities, connected
switches, hidden candidates and truncation prevent complete coverage. Limits are
4,096 inspected prototypes, 512 selected names, 128 entities, 16 connectors per
pole and 64 connections per connector. Network IDs describe only the current
observation; they are not durable endpoint identities or delivery evidence.

`removal_readiness` reuses the exact removal implementation's pure bounded
snapshot, actor inventory and aggregate capacity check. Its known snapshot is
instantaneous evidence; admission revalidates it before any native removal.
Refusal and unreadable evidence remain distinct. A complete missing-member
query adds `absence_facts` scoped only to that exact locator. It does not prove
global entity disappearance or custody. Top-level `actor_inventory` remains
available when every requested locator is absent, bound to the native actor,
epoch/session, world, request and tick. Unsupported contents or unreadable
ownership/inventory produce unknown/error instead of a partial known inventory.

The host may compare two fresh owned frames only under its independent stable
configuration, exact revision, no-intervening-mutation and measured-delta guards.
A sole complete incoming cut or a closed electric component is one prerequisite
for attribution. Static compatible routes, counters or common network IDs alone
do not establish delivered or commissioned output.

Local API evidence lives under shared
`test-results/factory-tracker-stack-20261029/continuation-native-progress/`:
`probe-02` proves getter availability at one paused tick; `consumer-01` proves
loader-container links, non-belt-connectable container interfaces and ignored
fixed-vector inserter overrides; `electric-01` proves native network, energy and
wire-connector getter availability. `electric_connected_entities` is absent in
2.0.77, and network flow statistics are deliberately not used for exact-source
attribution. All three probes used exact 2.0.77 with zero providers. They do not
prove productive delivery. Compiled projection and host delivery-window proof
remain pending at this checkpoint. Earlier `activity-mod-01.log` failed the old
single-scan assertion after adding a separate bounded transport scan; it is not
passing evidence.

The first compiled projection run (`native-final-01`) stopped at the loader
input assertion: the fixture changed its mode and sampled in the same tick.
`loader-01` measured exact 2.0.77 behavior with zero providers: the mode setter
reverses direction immediately and temporarily clears `loader_container`; one
tick restores the same container. Output mode moved four items from container
to loader lines, and input mode moved two seeded line items into that container.
The projection fixture now waits exactly one guarded native tick after the mode
change and compares the direct getter's exact container before asserting the
incoming edge. This fixes fixture timing; native relation semantics are unchanged.
