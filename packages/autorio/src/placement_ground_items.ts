import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { count_world_entities, find_world_entities } from './npc_vision'
import { placement_check_args, placement_footprint } from './placement_geometry'
import { placement_obstruction_sample } from './placement_obstructions'

// Items lying on the ground (a burner drill fueled before its output machine
// exists spills ore onto its drop tile) fail the default script build check,
// but a player's build picks them up instead. The NPC build does the same: a
// footprint whose only collisions are ground items is a candidate that lists
// them, and placing it picks them up into the actor inventory before the native
// check decides again. Tile-rule entities keep the strict manual check.

const MAX_GROUND_ITEMS = 16

export interface GroundItem {
  name: string
  count: number
  quality?: string
  position: { x: number, y: number }
}

type Box = { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

function ground_item_entities(actor: ControlledActor, box: Box): LuaEntity[] {
  return protected_read(() => find_world_entities(actor.surface, { area: box, type: 'item-entity', limit: MAX_GROUND_ITEMS + 1 })) ?? []
}

function describe(entity: LuaEntity): GroundItem | undefined {
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
 * The ground items that are the only reason the native check refuses this
 * footprint, or undefined when it is refused for anything else (terrain, another
 * entity, an unknown cause) or the entity uses a tile-rule check.
 */
export function ground_item_blockers(actor: ControlledActor, prototype: any, entity_name: string, position: { x: number, y: number }, direction: number | undefined): GroundItem[] | undefined {
  if (placement_check_args(entity_name).build_check_type !== undefined) return undefined
  const box = placement_footprint(prototype, position, direction).world_box
  const count = protected_read(() => count_world_entities(actor.surface, { area: box, type: 'item-entity' })) ?? 0
  if (count <= 0 || count > MAX_GROUND_ITEMS) return undefined
  const sample = placement_obstruction_sample(actor, prototype, position, direction ?? 0)
  if (sample.unknown || sample.truncated || sample.terrain_tiles.length > 0 || sample.entities.length === 0) return undefined
  for (const entity of sample.entities) if (entity.type !== 'item-entity') return undefined
  const items: GroundItem[] = []
  for (const entity of ground_item_entities(actor, box)) {
    if (!entity.valid) continue
    const item = describe(entity)
    if (item) items.push(item)
  }
  return items.length > 0 ? items : undefined
}

/** True when the native check accepts the footprint, or would once its ground items are picked up. */
export function placeable_or_ground_items_only(actor: ControlledActor, prototype: any, entity_name: string, position: { x: number, y: number }, direction: number | undefined) {
  if (actor.surface.can_place_entity({ name: entity_name, position, direction, force: actor.force, ...placement_check_args(entity_name) })) return true
  return ground_item_blockers(actor, prototype, entity_name, position, direction) !== undefined
}

/**
 * Picks up every ground item in the footprint into the actor inventory, as a
 * player's build does. A stack that does not fit stays on the ground with what
 * was not inserted, and the result says the inventory is full.
 */
export function pick_up_ground_items(actor: ControlledActor, inventory: LuaInventory, prototype: any, position: { x: number, y: number }, direction: number | undefined) {
  const box = placement_footprint(prototype, position, direction).world_box
  const picked_up: GroundItem[] = []
  for (const entity of ground_item_entities(actor, box)) {
    if (!entity.valid) continue
    const item = describe(entity)
    if (!item) continue
    const inserted = inventory.insert(entity.stack!)
    if (inserted >= item.count) {
      entity.destroy()
      picked_up.push(item)
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
