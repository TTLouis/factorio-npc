# Built-in tutorial methods in the leveled library

Owner direction, October 29, 2026: incorporate the basic patterns into the leveled
library and use Factorio's built-in tutorials as foundation material.

Local source inspection used the bundled Factorio **2.0.77** tutorial campaign,
interactive tutorial scripts, tips definitions and selected simulations. Source
files and their hashes remain in local evidence under
`test-results/leveled-library-foundations-20261029`; proprietary game scripts,
blueprints and maps are not redistributed in this repository.

The teaching pattern is useful: establish a bounded objective, demonstrate an
interface, perform the action, inspect its result, then connect the next part.
Tutorial scenarios also contain provided inventory, altered research, scripting
and player-only controls. None of those is an NPC capability or ordinary-world
fact. Recipes, rates, ratios, sizes and unlock conditions are always read live.
Keyboard shortcuts become admitted inventory/interaction operations only where
the current NPC tool contract supports them. A lesson topic is not a verified
autonomous gameplay capability.

| Bundled material | Method incorporated | Canonical entries |
| --- | --- | --- |
| `campaigns/tutorial/level-01/control.lua` | Inspect inventories, acquire the next needed item, supply a process and inspect new output | `missing-item-bootstrap`, `direct-miner-smelting` |
| `campaigns/tutorial/level-02/control.lua` | Give each transfer device usable energy; validate orientation and actual item movement | `burner-inserter-refueling`, `starter-mining-belt-output` |
| `campaigns/tutorial/level-03/control.lua` | Connect source, fluid interfaces, generation and electrical consumers; verify operation under load | `steam-power-bootstrap`, `skill-place-observe-connect` |
| `campaigns/tutorial/level-04/control.lua` | Inspect available research and verify the goal-specific result rather than copying the tutorial's research order | `skill-trigger-aware-progression`, `knowledge-available-capabilities` |
| `campaigns/tutorial/level-05/control.lua` | Inspect and reuse existing infrastructure before committing to repair or expansion | `skill-reuse-before-building`, `skill-upgrade-without-losing-service` |
| `tutorials/entity-transfers/control.lua`, `tutorials/stack-transfers/control.lua` | Distinguish source/destination inventory roles and observe the actual transferred amount | `missing-item-bootstrap`, `skill-direct-transfer` |
| `prototypes/tips-and-tricks.lua`: burner-inserter-refueling, inserters | Check startup and continuing device fuel independently of upstream machine fuel; prove surplus takeoff does not starve production | `burner-inserter-refueling`, `burner-coal-loop` |
| Same tips definitions: belt-lanes, splitters | Inspect actual lane loading, merge behavior and downstream delivery | `two-item-half-belt`, `belt-side-load-merge`, `skill-deliberate-belt-routing` |
| Same tips definitions: steam-power, electric-network, electric-pole-connections, low-power | Separate generation, connectivity, coverage and load | `steam-power-bootstrap`, `skill-find-actual-bottleneck` |
| Same tips definitions: limit-chests, insertion-limits, circuit-network | Apply authorized stock policies only to buffered stock; verify supported controls and actual delivery | `buffered-building-stock`, `skill-define-production-interfaces` |
| `tutorials/trains-stations`, `tutorials/trains-basic-signals`, `tutorials/trains-advanced-signals` | Stage supported rail work with actual route, block and station evidence | `skill-build-rail-clearance` and the existing rail/logistics methods; current admitted capabilities remain prerequisites |

The original basic profile stays available for historical comparisons. The
leveled profile incorporates every basic canonical ID as a classified method,
with live checks, procedural steps, completion evidence and related entries.
The new burner-inserter method fills a specific commissioning gap. No copied
tutorial coordinate, blueprint, inventory grant, ingredient bill, ratio or
research order is stored in those methods.

Built-in tutorials are source material, not the E2E acceptance contract. The BF
maps remain historical evidence of the former replacement profile; changing
this catalog neither modifies those runs nor repairs their harness failures.
