import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { protected_read } from './electric_facts'
import { placement_footprint, type PlacementFootprint } from './placement_geometry'
import { find_world_entities } from './npc_vision'

const MAX_TILES_CHECKED = 64
const MAX_ENTITIES_CHECKED = 32

export function collision_layers(prototype: any): Record<string, boolean> | undefined {
  return protected_read(() => prototype.collision_mask.layers)
}

/**
 * The entities in the footprint whose collision mask overlaps the prototype's
 * (an ore patch, whose mask is disjoint, is not one). unknown: a mask or the
 * entity search could not be read. truncated: more entities than were checked.
 */
export function colliding_entities(actor: ControlledActor, layers: Record<string, boolean>, footprint: PlacementFootprint) {
  const entities: LuaEntity[] = []
  let unknown = false
  let truncated = false
  const nearby = protected_read(() => find_world_entities(actor.surface, { area: footprint.world_box, limit: MAX_ENTITIES_CHECKED + 1 }))
  if (!nearby) return { entities, unknown: true, truncated }
  let checked = 0
  for (const entity of nearby) {
    if (!entity.valid) continue
    if (++checked > MAX_ENTITIES_CHECKED) { truncated = true; break }
    const other: Record<string, boolean> | undefined = protected_read(() => (entity.prototype as any).collision_mask.layers)
    if (!other) { unknown = true; continue }
    let overlaps = false
    for (const [layer, enabled] of pairs(layers)) if (enabled && other[layer] === true) overlaps = true
    if (overlaps) entities.push(entity)
  }
  return { entities, unknown, truncated }
}

/**
 * Tiles under the footprint whose terrain collides with the prototype's mask.
 * collides is undefined when it cannot be said: a tile or layer read failed, or
 * the footprint is larger than the bounded scan.
 */
export function terrain_collisions(actor: ControlledActor, layers: Record<string, boolean>, footprint: PlacementFootprint, keep: number = 0) {
  const tiles: Array<Record<string, unknown>> = []
  let unknown = false
  let truncated = false
  let collisions = 0
  let tiles_checked = 0
  const box = footprint.world_box
  for (let y = math.floor(box.left_top.y); y < math.ceil(box.right_bottom.y); y++) {
    for (let x = math.floor(box.left_top.x); x < math.ceil(box.right_bottom.x); x++) {
      tiles_checked++
      if (tiles_checked > MAX_TILES_CHECKED) { truncated = true; break }
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
        collisions++
        if (tiles.length < keep) tiles.push({ name: tile.name, position: { x, y }, reason: 'terrain_collision_mask' })
        else if (keep > 0) truncated = true
      }
    }
    if (tiles_checked > MAX_TILES_CHECKED) break
  }
  return { tiles, collisions, unknown, truncated }
}

// Diagnostics explain a few rejected footprints. They are observations, never
// alternative placement admission and never the clearance decision, which lives
// in placement_clearing (it reuses collision_layers, colliding_entities and
// terrain_collisions above, so both read the same collisions).
export function placement_obstruction_sample(actor: ControlledActor, prototype: any, position: { x: number, y: number }, direction: number) {
  const footprint = placement_footprint(prototype, position, direction)
  const terrain_tiles: Array<Record<string, unknown>> = []
  const entities: Array<Record<string, unknown>> = []
  const layers = collision_layers(prototype)
  let unknown = layers === undefined
  let truncated = false
  if (layers !== undefined) {
    const terrain = terrain_collisions(actor, layers, footprint, 4)
    for (const tile of terrain.tiles) terrain_tiles.push(tile)
    if (terrain.unknown) unknown = true
    if (terrain.truncated) truncated = true
    const found = colliding_entities(actor, layers, footprint)
    if (found.unknown) unknown = true
    if (found.truncated) truncated = true
    for (const entity of found.entities) {
      if (entities.length < 4) entities.push({ name: entity.name, type: entity.type, unit_number: entity.unit_number, position: entity.position, reason: 'entity_collision_mask_overlap' })
      else truncated = true
    }
  }
  if (terrain_tiles.length === 0 && entities.length === 0) unknown = true
  return { position, direction, footprint, terrain_tiles, entities, unknown, truncated }
}
