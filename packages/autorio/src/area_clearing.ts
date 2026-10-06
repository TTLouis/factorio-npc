import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { is_placed_building_entity, MAX_MINING_START_REJECTIONS, mining_navigation_reach, mining_navigation_requires_movement, select_exact_mining_target, within_mining_reach } from './mining_reach'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersClearConstructionArea, PlayerParametersWalkToEntity } from './types'
import { TaskStates } from './types'
import { find_world_entities } from './npc_vision'

type TaskManager = ReturnType<typeof new_task_manager>

const MAX_DIMENSION = 64
const MAX_AREA_TILES = 4096

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -1000000 && value <= 1000000
}

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function task_area(task: PlayerParametersClearConstructionArea) {
  const half_width = task.width / 2
  const half_height = task.height / 2
  return {
    left_top: { x: task.center.x - half_width, y: task.center.y - half_height },
    right_bottom: { x: task.center.x + half_width, y: task.center.y + half_height },
  }
}

/**
 * Authoritative construction-clearing predicate.
 *
 * Factorio's prototype.is_building is broader than "player-placed building":
 * it also includes SimpleEntityPrototype, which is the engine type used for
 * mineable rocks. Protect force-owned / item-placeable buildings, while
 * retaining finite natural simple entities as valid construction blockers.
 */
export function clearable_construction_blocker(entity: LuaEntity | undefined) {
  if (!entity || !entity.valid) return false
  const prototype = entity.prototype
  const prototype_type = prototype.type
  if (prototype_type === 'resource' || prototype_type === 'character') return false
  if (is_placed_building_entity(entity)) return false
  const mineable = prototype.mineable_properties
  return entity.minable === true && mineable.minable === true
}

function position_inside_area(position: { x: number, y: number }, area: ReturnType<typeof task_area>) {
  return position.x >= area.left_top.x
    && position.x <= area.right_bottom.x
    && position.y >= area.left_top.y
    && position.y <= area.right_bottom.y
}

function nearest_blocker(actor: ControlledActor, task: PlayerParametersClearConstructionArea) {
  const area = task_area(task)
  const entities = find_world_entities(actor.surface, { area })
  let nearest: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    if (!position_inside_area(entity.position, area) || !clearable_construction_blocker(entity)) continue
    const distance = squared_distance(actor.position, entity.position)
    if (distance < best) {
      nearest = entity
      best = distance
    }
  }
  return nearest
}

function navigation_to_target(actor: ControlledActor, target: LuaEntity, rejected_starts: number = 0): PlayerParametersWalkToEntity | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: '',
    search_radius: 1,
    target_kind: 'position',
    requested_position: { x: target.position.x, y: target.position.y },
    reach_distance: mining_navigation_reach(actor, target, rejected_starts),
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: target.position.x, y: target.position.y },
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    started_tick: undefined,
    last_progress_tick: game.tick,
  }
}

export function new_area_clearing_controller(
  get_actor: () => ControlledActor | undefined,
  manager: TaskManager,
) {
  function identity_matches(actor: ControlledActor, task: PlayerParametersClearConstructionArea) {
    const identity = actor.status_snapshot()
    return task.owner_actor_id !== undefined
      && task.owner_actor_id === identity.actor_id
      && task.owner_actor_kind === identity.kind
      && task.owner_force_index === actor.force.index
  }

  function clear_target(actor: ControlledActor, task: PlayerParametersClearConstructionArea) {
    actor.set_mining_state({ mining: false })
    task.target = null
    task.target_name = undefined
    task.target_position = undefined
    task.mining_rejects = 0
    task.mining_attempted = false
  }

  function finish(actor: ControlledActor, task: PlayerParametersClearConstructionArea) {
    clear_target(actor, task)
    log(`[AUTORIO] Construction area clear: center=${serpent.line(task.center)}, size=${task.width}x${task.height}, cleared=${task.cleared_count}`)
    manager.reset_task_state()
    manager.next_task()
  }

  function fail(actor: ControlledActor | undefined, task: PlayerParametersClearConstructionArea, reason: string) {
    if (actor?.is_valid) actor.set_mining_state({ mining: false })
    manager.cancel_all_tasks(`clear_construction_area:${reason}`)
    log(`[AUTORIO] [ERROR] Construction area clearing failed: ${reason}`)
  }

  function submit(x: number, y: number, width: number, height: number): [boolean, string] {
    if (!valid_coordinate(x) || !valid_coordinate(y)) return [false, 'x and y must be finite bounded map coordinates']
    if (!valid_integer(width, 1, MAX_DIMENSION) || !valid_integer(height, 1, MAX_DIMENSION) || width * height > MAX_AREA_TILES) {
      return [false, `width/height must be positive integers <= ${MAX_DIMENSION} with area <= ${MAX_AREA_TILES} tiles`]
    }

    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      return [false, 'controlled actor is unavailable']
    }

    manager.add_task({
      type: TaskStates.CLEARING_AREA,
      center: { x, y },
      width,
      height,
      cleared_count: 0,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    })
    return [true, 'Construction-area clearing task started']
  }

  function reposition_after_rejected_start(actor: ControlledActor, task: PlayerParametersClearConstructionArea, target: LuaEntity) {
    actor.set_mining_state({ mining: false })
    task.mining_attempted = false
    task.mining_rejects = (task.mining_rejects ?? 0) + 1
    if (task.mining_rejects > MAX_MINING_START_REJECTIONS) {
      fail(actor, task, 'mining_rejected')
      return
    }
    const navigation = navigation_to_target(actor, target, task.mining_rejects)
    const reach = navigation?.reach_distance ?? 0
    if (!navigation || !mining_navigation_requires_movement(actor, target, reach)
      || !manager.interrupt_current_with(navigation, task)) {
      fail(actor, task, 'mining_rejected')
      return
    }
    log(`[AUTORIO] Mining start rejected for construction blocker ${target.name}; repositioning closer before retry ${task.mining_rejects}/${MAX_MINING_START_REJECTIONS}`)
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_clear_construction_area
    if (!task || manager.player_state.task_state !== TaskStates.CLEARING_AREA) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }

    const previous_target = task.target ?? undefined
    if (previous_target && !previous_target.valid) {
      task.cleared_count++
      clear_target(actor, task)
    }
    else if (previous_target && !clearable_construction_blocker(previous_target)) {
      clear_target(actor, task)
    }

    let target = task.target ?? undefined
    if (!target) {
      target = nearest_blocker(actor, task)
      if (!target) {
        finish(actor, task)
        return
      }
      task.target = target
      task.target_name = target.name
      task.target_position = { x: target.position.x, y: target.position.y }
      task.mining_rejects = 0
      task.mining_attempted = false
    }

    if (!within_mining_reach(actor, target)) {
      actor.set_mining_state({ mining: false })
      const navigation = navigation_to_target(actor, target)
      if (!navigation || !manager.interrupt_current_with(navigation, task)) fail(actor, task, 'navigation_failed')
      return
    }

    if (actor.get_mining_state().mining) return
    if (task.mining_attempted) {
      reposition_after_rejected_start(actor, task, target)
      return
    }
    if (!select_exact_mining_target(actor, target)) {
      reposition_after_rejected_start(actor, task, target)
      return
    }

    actor.set_mining_state({ mining: true, position: target.position })
    task.mining_attempted = true
    if (!actor.get_mining_state().mining) {
      reposition_after_rejected_start(actor, task, target)
      return
    }

    log(`[AUTORIO] Clearing exact construction blocker ${target.name} at ${serpent.line(target.position)}`)
  }

  function on_player_mined_entity(actor: ControlledActor, player_index: number, mined_entity?: LuaEntity) {
    if (!actor.owns_player_index(player_index) || manager.player_state.task_state !== TaskStates.CLEARING_AREA) return
    const task = manager.player_state.parameters_clear_construction_area
    if (!task || !identity_matches(actor, task) || !task.target) return
    if (mined_entity && mined_entity !== task.target) return
    task.cleared_count++
    clear_target(actor, task)
  }

  return { submit, tick, on_player_mined_entity }
}
