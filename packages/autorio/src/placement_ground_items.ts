import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { find_world_entities } from './npc_vision'
import { placement_footprint } from './placement_geometry'

// Items lying on the ground (a burner drill fueled before its output machine
// exists spills ore onto its drop tile) fail the default script build check,
// but a player's build picks them up instead. The NPC build does the same: a
// footprint whose only collisions are ground items is a candidate that lists
// them, and placing it picks them up into the actor inventory before the native
// check decides again. Whether a footprint qualifies is decided with every
// other clearable blocker in placement_clearing; this file only reads and
// picks up the items.

export const MAX_GROUND_ITEMS = 16

export interface GroundItem {
  name: string
  count: number
  quality?: string
  position: { x: number, y: number }
}

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

export function ground_item_entities(actor: ControlledActor, box: Box): LuaEntity[] {
  return protected_read(() => find_world_entities(actor.surface, { area: box, type: 'item-entity', limit: MAX_GROUND_ITEMS + 1 })) ?? []
}

export function describe_ground_item(entity: LuaEntity): GroundItem | undefined {
  const stack = protected_read(() => entity.stack)
  if (!stack || !stack.valid_for_read) return undefined
  return {
    name: stack.name,
    count: stack.count,
    quality: protected_read(() => (stack as any).quality?.name),
    position: { x: entity.position.x, y: entity.position.y },
  }
}

/**
 * Picks up every ground item in the footprint into the actor inventory, as a
 * player's build does. A stack that does not fit stays on the ground with what
 * was not inserted, and the result says the inventory is full. picked_up holds
 * only what the inventory insert measured, so an empty list means nothing
 * changed. uncertain: a stack was inserted but its ground entity remained.
 */
export function pick_up_ground_items(actor: ControlledActor, inventory: LuaInventory, prototype: any, position: { x: number, y: number }, direction: number | undefined) {
  const box = placement_footprint(prototype, position, direction).world_box
  const picked_up: GroundItem[] = []
  for (const entity of ground_item_entities(actor, box)) {
    if (!entity.valid) continue
    const item = describe_ground_item(entity)
    if (!item) continue
    const inserted = inventory.insert(entity.stack!)
    if (inserted >= item.count) {
      entity.destroy()
      picked_up.push(item)
      if (entity.valid) return { ok: false as const, uncertain: true, picked_up, left: item }
      continue
    }
    if (inserted > 0) {
      entity.stack!.count = item.count - inserted
      picked_up.push({ ...item, count: inserted })
    }
    return { ok: false as const, picked_up, left: { ...item, count: item.count - inserted } }
  }
  return { ok: true as const, picked_up }
}
