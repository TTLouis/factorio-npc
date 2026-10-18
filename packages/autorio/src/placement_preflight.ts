import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { placement_footprint, snap_placement_center } from './placement_geometry'
import { resolve_entity_placement_item } from './placement_item'

// A read of current held stock, not a reservation or a promise about dispatch.
// Execution repeats the same resolver/count check before creating an entity.
export function placement_item_preflight(actor: ControlledActor | undefined, entity_name: string) {
  if (!actor || !actor.is_valid) return { ok: false, code: 'no_actor' }
  const inventory = actor.get_main_inventory()
  if (!inventory) return { ok: false, code: 'no_inventory' }
  const resolved = resolve_entity_placement_item(entity_name)
  if (!resolved.ok) return resolved
  const held_count = inventory.get_item_count(resolved.requirement.item_name)
  const placement_item = { ...resolved.requirement, held_count }
  if (typeof held_count !== 'number' || held_count !== held_count
    || held_count !== math.floor(held_count) || held_count < 0 || held_count > 9007199254740991) {
    return { ok: false, code: 'placement_item_unreadable', entity_name }
  }
  if (held_count < resolved.requirement.count) return { ok: false, code: 'placement_item_missing', placement_item }
  return { ok: true, placement_item }
}

// The tiles a coordinate placement will occupy, from the same grid snap and footprint execution uses, and the
// collision layers that decide what it may share them with. Geometry only: the surface is not consulted, so this
// says nothing about whether the spot is free now. The runtime compares the footprints of one batch with each other.
export function planned_placement_footprint(entity_name: string, x: unknown, y: unknown, direction: unknown) {
  const prototype = prototypes.entity[entity_name]
  if (!prototype || typeof x !== 'number' || typeof y !== 'number' || x !== x || y !== y
    || math.abs(x) === math.huge || math.abs(y) === math.huge) return undefined
  const facing = typeof direction === 'number' ? direction : 0
  const position = snap_placement_center(prototype, { x, y }, facing)
  const footprint = placement_footprint(prototype, position, facing)
  const mask: any = protected_read(() => prototype.collision_mask)
  const enabled: Record<string, boolean> | undefined = mask?.layers
  const layers: string[] = []
  if (enabled) for (const [layer, on] of pairs(enabled)) if (on === true) layers.push(layer)
  layers.sort()
  return {
    entity_name,
    position,
    direction: facing,
    tile_box: footprint.tile_box,
    world_box: footprint.world_box,
    collision_layers: layers,
    ...(enabled === undefined ? { collision_unknown: true } : {}),
    ...(mask?.not_colliding_with_itself === true ? { not_colliding_with_itself: true } : {}),
    ...(mask?.colliding_with_tiles_only === true ? { colliding_with_tiles_only: true } : {}),
  }
}
