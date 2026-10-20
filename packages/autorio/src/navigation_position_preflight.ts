import type { ControlledActor } from './actors/types'
import { find_world_entities } from './npc_vision'

const finite = (value: unknown): value is number => typeof value === 'number' && value === value && math.abs(value) !== math.huge

// How far a correction may be searched for: the nearest place the character fits, offered when a goal is refused.
const CORRECTION_SEARCH_RADIUS = 16
const CORRECTION_PRECISION = 0.5

// Narrow negative proofs: axis-aligned furnace collisions, and a goal whose own tile collides with the character (the
// middle of a lake, for example). These do not establish a route or promise future availability; execution remains native.
export function navigation_position_preflight(actor: ControlledActor | undefined, args: Record<string, any>) {
  const reject = (code: string, details: Record<string, unknown> = {}) => ({ ok: false, operation: 'walk_to_position', code, ...details })
  if (!actor || !actor.is_valid || !actor.character?.valid) return reject('no_actor')
  const x = args.x; const y = args.y; const reach = args.reach_distance ?? 0.75
  if (!finite(x) || !finite(y)) return reject('invalid_navigation_position')
  if (!finite(reach) || reach < 0.25 || reach > 64) return reject('invalid_navigation_reach_distance')
  const character = actor.character
  const box = character.prototype.collision_box
  const mask = character.prototype.collision_mask
  if (box && mask?.layers && !mask.colliding_with_tiles_only) {
    for (const entity of find_world_entities(actor.surface, { position: { x, y }, radius: 16, type: 'furnace', limit: 64 })) {
      if (!entity.valid || entity.direction % 4 !== 0) continue
      const obstacle_mask = entity.prototype.collision_mask
      if (!obstacle_mask?.layers || obstacle_mask.colliding_with_tiles_only) continue
      // With both exemption flags set, layer-set equality can exempt different
      // prototypes too. Defer these cases instead of inventing a collision.
      if (mask.not_colliding_with_itself && obstacle_mask.not_colliding_with_itself) continue
      let shared_layer = false
      for (const [layer, collides] of pairs(mask.layers)) {
        if (collides && obstacle_mask.layers[layer]) { shared_layer = true; break }
      }
      if (!shared_layer) continue
      const obstacle = entity.bounding_box
      const values = [box.left_top.x, box.left_top.y, box.right_bottom.x, box.right_bottom.y,
        obstacle.left_top.x, obstacle.left_top.y, obstacle.right_bottom.x, obstacle.right_bottom.y]
      if (!values.every(finite)) continue
      // Empty collision boxes are noncolliding, regardless of shared layers.
      if (!(box.right_bottom.x > box.left_top.x && box.right_bottom.y > box.left_top.y
        && obstacle.right_bottom.x > obstacle.left_top.x && obstacle.right_bottom.y > obstacle.left_top.y)) continue
      const clearance = math.min(x - (obstacle.left_top.x - box.right_bottom.x), (obstacle.right_bottom.x - box.left_top.x) - x,
        y - (obstacle.left_top.y - box.right_bottom.y), (obstacle.right_bottom.y - box.left_top.y) - y)
      if (clearance > reach) return reject('navigation_position_inside_furnace_collision', {
        position: { x, y }, reach_distance: reach, minimum_collision_clearance: clearance,
        obstacle: { name: entity.name, unit_number: entity.unit_number, position: entity.position },
      })
    }
  }
  // AB-3 (18ab): a path request whose goal point lies on a tile the character collides with is answered "no path" within
  // milliseconds, whatever the reach (checked natively: a land goal 0.2 tiles from water is reached, a water goal 0.25 tiles
  // from land never is). The tile's collision mask against the character's decides, so nothing here names a tile. The mask
  // considers tile transitions, so a shoreline tile of a colliding kind can still hold the character: such a goal is only
  // refused when the engine also says the character cannot be placed at the goal, which keeps this a proof, not a guess.
  const surface = actor.surface
  const tile = surface.get_tile(math.floor(x), math.floor(y))
  const tile_layers = tile.prototype.collision_mask?.layers
  if (mask?.layers && tile_layers) {
    const colliding_layers: string[] = []
    for (const [layer, collides] of pairs(mask.layers)) {
      if (collides && tile_layers[layer]) colliding_layers.push(layer)
    }
    if (colliding_layers.length > 0 && !surface.can_place_entity({ name: character.name, position: { x, y }, force: actor.force })) {
      colliding_layers.sort()
      const nearest = surface.find_non_colliding_position(character.name, { x, y }, CORRECTION_SEARCH_RADIUS, CORRECTION_PRECISION)
      return reject('navigation_position_inside_tile_collision', {
        position: { x, y }, reach_distance: reach, tile: tile.name, colliding_layers,
        nearest_walkable_position: nearest ? { x: nearest.x, y: nearest.y } : undefined,
        nearest_walkable_search_radius: CORRECTION_SEARCH_RADIUS,
      })
    }
  }
  return { ok: true, operation: 'walk_to_position' }
}
