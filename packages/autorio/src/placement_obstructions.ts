import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { placement_footprint } from './placement_geometry'
import { find_world_entities } from './npc_vision'

// Diagnostics explain a few rejected footprints. They are observations, never
// alternative placement admission or authority to clear an obstruction. The one
// clearance a build may do, picking up ground items as a player's build does,
// is decided in placement_ground_items.
export function placement_obstruction_sample(actor: ControlledActor, prototype: any, position: { x: number, y: number }, direction: number) {
  const footprint = placement_footprint(prototype, position, direction)
  const terrain_tiles: Array<Record<string, unknown>> = []
  const entities: Array<Record<string, unknown>> = []
  const layers: Record<string, boolean> | undefined = protected_read(() => prototype.collision_mask.layers)
  let unknown = layers === undefined
  let truncated = false
  let tiles_checked = 0
  if (layers !== undefined) {
    const box = footprint.world_box
    for (let y = math.floor(box.left_top.y); y < math.ceil(box.right_bottom.y); y++) {
      for (let x = math.floor(box.left_top.x); x < math.ceil(box.right_bottom.x); x++) {
        tiles_checked++
        if (tiles_checked > 64) { truncated = true; break }
        const tile = protected_read(() => actor.surface.get_tile(x, y))
        if (!tile) { unknown = true; continue }
        let collides = false
        for (const [layer, enabled] of pairs(layers)) {
          if (!enabled) continue
          const hit = protected_read(() => tile.collides_with(layer))
          if (hit === undefined) unknown = true
          if (hit === true) collides = true
        }
        if (collides) {
          if (terrain_tiles.length < 4) terrain_tiles.push({ name: tile.name, position: { x, y }, reason: 'terrain_collision_mask' })
          else truncated = true
        }
      }
      if (tiles_checked > 64) break
    }
    const nearby = protected_read(() => find_world_entities(actor.surface, { area: footprint.world_box, limit: 33 }))
    if (!nearby) unknown = true
    else {
      let checked = 0
      for (const entity of nearby) {
        if (!entity.valid) continue
        if (++checked > 32) { truncated = true; break }
        const other: Record<string, boolean> | undefined = protected_read(() => (entity.prototype as any).collision_mask.layers)
        if (!other) { unknown = true; continue }
        let overlaps = false
        for (const [layer, enabled] of pairs(layers)) if (enabled && other[layer] === true) overlaps = true
        if (!overlaps) continue
        if (entities.length < 4) entities.push({ name: entity.name, type: entity.type, unit_number: entity.unit_number, position: entity.position, reason: 'entity_collision_mask_overlap' })
        else truncated = true
      }
    }
  }
  if (terrain_tiles.length === 0 && entities.length === 0) unknown = true
  return { position, direction, footprint, terrain_tiles, entities, unknown, truncated }
}
