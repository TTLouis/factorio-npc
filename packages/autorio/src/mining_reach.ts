import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

const MINING_REACH_MARGIN = 0.25
const MIN_MINING_REACH = 0.5
const FALLBACK_MINING_REACH = 2.5
const REJECTED_START_APPROACH_STEP = 0.75

export const MAX_MINING_START_REJECTIONS = 3

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function is_placed_building_entity(entity: LuaEntity) {
  const prototype = entity.prototype
  const place_items = prototype.items_to_place_this
  return prototype.is_building === true
    && (prototype.is_entity_with_owner === true
      || (place_items !== undefined && place_items.length > 0))
}

function finite_world_mining_target(entity: LuaEntity) {
  if (entity.type === 'resource') return true
  const prototype = entity.prototype
  return !is_placed_building_entity(entity)
    && prototype.mineable_properties !== undefined
    && prototype.mineable_properties.minable !== false
}

/**
 * Conservative player-equivalent mining reach. Resource patches and finite
 * natural mineables such as trees/rocks use resource_reach_distance; placed
 * buildings keep ordinary reach_distance for explicit deconstruction mining.
 */
export function mining_reach_distance(actor: ControlledActor, entity: LuaEntity) {
  const character = actor.character
  if (!character) return MIN_MINING_REACH
  const raw = finite_world_mining_target(entity)
    ? character.resource_reach_distance
    : character.reach_distance
  const reach = typeof raw === 'number' && raw === raw && raw > 0 && raw < math.huge
    ? raw
    : FALLBACK_MINING_REACH
  return math.max(MIN_MINING_REACH, reach - MINING_REACH_MARGIN)
}

export function within_mining_reach(actor: ControlledActor, entity: LuaEntity) {
  const reach = mining_reach_distance(actor, entity)
  return squared_distance(actor.position, entity.position) <= reach ** 2
}

/** Force a closer approach after Factorio rejects a mining start in nominal reach. */
export function mining_navigation_reach(actor: ControlledActor, entity: LuaEntity, rejected_starts: number = 0) {
  const normal = mining_reach_distance(actor, entity)
  if (rejected_starts <= 0) return normal
  const distance = math.sqrt(squared_distance(actor.position, entity.position))
  return math.max(MIN_MINING_REACH, math.min(normal, distance - REJECTED_START_APPROACH_STEP))
}

export function mining_navigation_requires_movement(actor: ControlledActor, entity: LuaEntity, reach: number) {
  return squared_distance(actor.position, entity.position) > reach ** 2
}

/** Bind mining to the exact already-observed entity rather than same-name proximity. */
export function select_exact_mining_target(actor: ControlledActor, target: LuaEntity) {
  const select_position = (position: { x: number, y: number }) => {
    actor.update_selected_entity(position)
    const selected = actor.character?.selected
    if (!selected || !selected.valid) return false
    if (target.unit_number !== undefined || selected.unit_number !== undefined) {
      return target.unit_number !== undefined && selected.unit_number === target.unit_number
    }
    return selected === target
  }
  if (select_position(target.position)) return true
  // Overlapping natural selection boxes can cover an ore or tree centre.
  // Probe only bounded interior points of this exact mineable's native
  // selection box; never select a substitute entity or clear the obstruction.
  const natural = (target.type === 'tree' || target.type === 'simple-entity') && finite_world_mining_target(target)
  if ((target.type !== 'resource' && !natural) || !target.selection_box) return false
  const box = target.selection_box
  const centre = { x: (box.left_top.x + box.right_bottom.x) / 2, y: (box.left_top.y + box.right_bottom.y) / 2 }
  const dx = (box.right_bottom.x - box.left_top.x) * 0.4
  const dy = (box.right_bottom.y - box.left_top.y) * 0.4
  if (!(dx > 0 && dy > 0 && dx < math.huge && dy < math.huge)) return false
  for (const offset of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    if (select_position({ x: centre.x + dx * offset[0], y: centre.y + dy * offset[1] })) {
      const reason = target.type === 'resource' ? 'resource_centre_occluded' : 'natural_centre_occluded'
      log(`[AUTORIO] mining.exact_selection_recovered reason=${reason} actor_id=${actor.status_snapshot().actor_id} entity=${target.name} position=${serpent.line(target.position)}`)
      return true
    }
  }
  return false
}
