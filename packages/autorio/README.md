# autorio.ts

> [!NOTE]
> This package is a heavily modified fork of the original `autorio` implementation from [`moeru-ai/airi-factorio`](https://github.com/moeru-ai/airi-factorio), originally authored by **LemonNekoGH**. The current fork is maintained by **TTLouis** as the Factorio execution mod for the SGLuna / Factorio NPC project.
>
> The Factorio mod name remains `autorio` for compatibility with existing saves and deployment tooling; the retained name does not imply that this fork is maintained by the original author.

## Fork scope

The fork has diverged substantially from the upstream package. In addition to the original automation foundation, this version contains standalone NPC actor ownership, actor-aware operations, navigation and recovery, combat, research, production-planning primitives, map operations, skills/verification, task-board UI, throughput tooling, and the supporting deterministic test harnesses used by this repository.

Upstream code and the modifications in this fork are distributed under the **MIT License**. The original copyright notice is retained. See [`LICENSE`](./LICENSE) for the package copy and [`../../LICENSE`](../../LICENSE) for the repository-level license.

## Example

To make a burner inserter, we need to:

```text
/c remote.call("autorio_operations", "walk_to_entity", "coal", 500); -- walk to coal
remote.call("autorio_operations", "mine_entity", "coal"); -- mine coal
remote.call("autorio_operations", "walk_to_entity", "iron-ore", 500); -- walk to iron ore
remote.call("autorio_operations", "mine_entity", "iron-ore"); -- mine iron ore
remote.call("autorio_operations", "mine_entity", "iron-ore"); -- mine iron ore
remote.call("autorio_operations", "mine_entity", "iron-ore"); -- mine iron ore
remote.call("autorio_operations", "place_entity", "stone-furnace"); -- place stone furnace
remote.call("autorio_operations", "auto_insert_nearby", "coal", "stone-furnace", 1); -- insert coal into furnace
remote.call("autorio_operations", "auto_insert_nearby", "iron-ore", "stone-furnace", 5); -- insert iron ore into furnace

/c remote.call("autorio_operations", "pick_up_item", "iron-plate", 5, "stone-furnace") -- pick up iron plate

/c remote.call("autorio_operations", "craft_item", "iron-gear-wheel", 1) -- craft iron gear wheel
/c remote.call("autorio_operations", "craft_item", "burner-inserter", 1) -- craft burner inserter

/c remote.call("autorio_operations", "place_entity", "burner-inserter", 1) -- place burner inserter
```

<!-- ## Game compatibility -->

## TODO

- [ ] Suspend operation on error
