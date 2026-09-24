import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { resolve_exact_entity } from './entity_reference'
import { build_interaction_reach, entity_interaction_reach } from './interaction_range'
import type { new_task_manager } from './task_manager'
import type {
  PlayerParameters,
  PlayerParametersWalkToEntity,
} from './types'
import { TaskStates } from './types'

const LEGACY_ENTITY_SEARCH_DISTANCE = 8
const PLACEMENT_ESCAPE_REACH = 0.75
const PLACEMENT_ESCAPE_MARGIN = 0.75

type Manager = ReturnType<typeof new_task_manager>
type Position = { x: number, y: number }
type RecoveryNavigationTask = PlayerParametersWalkToEntity & {
  target_kind?: 'nearest_entity' | 'exact_entity' | 'position' | 'player'
  requested_position?: Position
}

function squared_distance(a: Position, b: Position) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let result: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    const candidate = squared_distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      result = entity
    }
  }
  return result
}

function entity_navigation(actor: ControlledActor, entity: LuaEntity, reach_distance: number, target_player_name?: string): RecoveryNavigationTask | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: entity.name,
    search_radius: 1,
    target_player_name,
    reach_distance,
    target_kind: target_player_name ? 'player' : 'exact_entity',
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: entity.position.x, y: entity.position.y },
    target: entity,
    target_unit_number: entity.unit_number,
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    started_tick: game.tick,
    last_progress_tick: game.tick,
  }
}

function position_navigation(actor: ControlledActor, position: Position, reach_distance: number): RecoveryNavigationTask | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: '',
    search_radius: 1,
    reach_distance,
    target_kind: 'position',
    requested_position: { x: position.x, y: position.y },
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: position.x, y: position.y },
    target: null,
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    last_progress_tick: game.tick,
  }
}

function placement_clearance(entity_name: string) {
  const box = prototypes.entity[entity_name]?.collision_box
  if (!box) return 1.75
  const radius = math.max(
    math.abs(box.left_top.x),
    math.abs(box.left_top.y),
    math.abs(box.right_bottom.x),
    math.abs(box.right_bottom.y),
  )
  return radius + PLACEMENT_ESCAPE_MARGIN
}

function placement_escape_position(actor: ControlledActor, target: Position, clearance: number) {
  const character_name = actor.character?.name ?? 'character'
  const distance = clearance + PLACEMENT_ESCAPE_MARGIN
  const offsets = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
  ]
  for (const offset of offsets) {
    const desired = { x: target.x + offset.x * distance, y: target.y + offset.y * distance }
    const safe = actor.surface.find_non_colliding_position(character_name, desired, 1.5, 0.5, true)
    if (!safe) continue
    if (squared_distance(safe, target) <= clearance ** 2) continue
    return { x: safe.x, y: safe.y }
  }
  return undefined
}

function interrupt(manager: Manager, recovery: PlayerParameters | undefined, resume: PlayerParameters, reason: string) {
  if (!recovery) return false
  if (!manager.interrupt_current_with(recovery, resume)) return false
  log(`[AUTORIO] Interaction recovery started: ${reason}; resuming ${resume.type} afterwards`)
  return true
}

export function new_interaction_recovery(manager: Manager) {
  function tick(actor: ControlledActor) {
    if (!actor.is_valid || !actor.character) return false

    if (manager.player_state.task_state === TaskStates.PLACING) {
      const task = manager.player_state.parameters_place_entity
      if (!task?.position) return false
      const reach = build_interaction_reach(actor)
      const distance_to_placement = squared_distance(actor.position, task.position)
      if (distance_to_placement > reach ** 2) {
        return interrupt(
          manager,
          position_navigation(actor, task.position, reach),
          task,
          `placement approach to <=${reach} tiles without walking onto the build coordinate`,
        )
      }

      if (actor.surface.can_place_entity({
        name: task.entity_name,
        position: task.position,
        direction: task.direction,
        force: actor.force,
      })) return false

      const clearance = placement_clearance(task.entity_name)
      if (distance_to_placement > clearance ** 2 || clearance >= reach) return false
      const escape = placement_escape_position(actor, task.position, clearance)
      if (!escape) return false
      return interrupt(
        manager,
        position_navigation(actor, escape, PLACEMENT_ESCAPE_REACH),
        task,
        `AIRI occupies the requested build footprint; stepping aside to ${serpent.line(escape)}`,
      )
    }

    if (manager.player_state.task_state === TaskStates.ROTATING) {
      const task = manager.player_state.parameters_rotate_entity
      if (!task) return false
      const target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      const reach = entity_interaction_reach(actor)
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `rotation approach to <=${reach} tiles`)
    }

    if (manager.player_state.task_state === TaskStates.SETTING_RECIPE) {
      const task = manager.player_state.parameters_set_recipe
      if (!task) return false
      const target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      const reach = entity_interaction_reach(actor)
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `recipe-machine approach to <=${reach} tiles`)
    }

    if (manager.player_state.task_state === TaskStates.LAUNCHING_ROCKET) {
      const task = manager.player_state.parameters_launch_rocket
      if (!task || task.launch_ordered_tick !== undefined) return false
      const target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      const reach = entity_interaction_reach(actor)
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `rocket-silo approach to <=${reach} tiles`)
    }

    if (manager.player_state.task_state !== TaskStates.MOVING_ITEMS) return false
    const task = manager.player_state.parameters_move_items
    if (!task) return false
    const reach = entity_interaction_reach(actor)

    if (task.player_name) {
      const player = game.get_player(task.player_name)
      if (!player || !player.valid || !player.connected || !player.character || player.surface.index !== actor.surface.index) return false
      if (squared_distance(actor.position, player.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, player.character, reach, task.player_name), task, `player-transfer approach to <=${reach} tiles`)
    }

    if (task.target_unit_number !== undefined) {
      const target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid || target.surface.index !== actor.surface.index || target.force.index !== actor.force.index) return false
      if (squared_distance(actor.position, target.position) <= reach ** 2) return false
      return interrupt(manager, entity_navigation(actor, target, reach), task, `exact entity-transfer approach to <=${reach} tiles`)
    }

    if (!task.entity_name || !prototypes.entity[task.entity_name]) return false
    const nearby = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: math.max(LEGACY_ENTITY_SEARCH_DISTANCE, reach),
      name: task.entity_name,
      force: actor.force,
    })
    const target = nearest_entity(actor, nearby)
    if (!target || squared_distance(actor.position, target.position) <= reach ** 2) return false
    return interrupt(manager, entity_navigation(actor, target, reach), task, `nearby entity-transfer approach to <=${reach} tiles`)
  }

  return { tick }
}
