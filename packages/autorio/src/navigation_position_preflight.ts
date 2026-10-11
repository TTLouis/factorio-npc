import type { ControlledActor } from './actors/types'
import { find_world_entities } from './npc_vision'

const finite = (value: unknown): value is number => typeof value === 'number' && value === value && math.abs(value) !== math.huge

// A narrow negative proof for axis-aligned furnace collisions. This does not
// establish a route or promise future availability; execution remains native.
export function navigation_position_preflight(actor: ControlledActor | undefined, args: Record<string, any>) {
  const reject = (code: string, details: Record<string, unknown> = {}) => ({ ok: false, operation: 'walk_to_position', code, ...details })
  if (!actor || !actor.is_valid || !actor.character?.valid) return reject('no_actor')
  const x = args.x, y = args.y, reach = args.reach_distance ?? 0.75
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
  return { ok: true, operation: 'walk_to_position' }
}
