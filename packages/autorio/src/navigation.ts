import type { LuaEntity, OnScriptPathRequestFinishedEvent, PathfinderWaypoint } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersWalkToEntity } from './types'
import { select_navigation_escape_point } from './construction_planning'
import { resolve_entity_reference } from './entity_reference'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MAX_SEARCH_RADIUS = 4096
const MAX_NAVIGATION_TICKS = 10 * 60 * 60
const PATH_REQUEST_TIMEOUT_TICKS = 15 * 60
const STUCK_TICKS = 3 * 60
const PHYSICAL_STUCK_TICKS = 90
const PHYSICAL_SAMPLE_TICKS = 30
const PHYSICAL_PROGRESS_DISTANCE = 0.12
const PATH_RETRY_DELAY_TICKS = 30
const MAX_PATH_ATTEMPTS = 4
const WAYPOINT_REACHED_DISTANCE = 0.5
const TARGET_REACHED_DISTANCE = 2.5
const TARGET_REPATH_DISTANCE = 4
const PROGRESS_DISTANCE = 0.25
const MAX_PLAYER_REACH_DISTANCE = 64
const MIN_REACH_DISTANCE = 0.25
const RECOVERY_REACHED_DISTANCE = 0.75
const MAX_COORDINATE = 1000000

type NavigationTargetKind = 'nearest_entity' | 'exact_entity' | 'position' | 'player'
type NavigationCode = 'started' | 'reached' | 'cancelled' | 'no_actor' | 'invalid_radius' | 'invalid_entity_name'
  | 'invalid_position' | 'invalid_unit_number' | 'invalid_reach_distance'
  | 'no_target' | 'actor_changed' | 'target_gone' | 'path_start_unavailable'
  | 'path_busy' | 'unreachable' | 'path_timeout' | 'stuck' | 'timeout'
  | 'player_unavailable' | 'different_surface'

interface NavigationResult {
  accepted: boolean
  completed: boolean
  code: NavigationCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  target_kind?: NavigationTargetKind
  entity_name?: string
  player_name?: string
  target_unit_number?: number
  target_position?: { x: number, y: number }
  path_request_id?: number
  path_attempts?: number
  blocked_reason?: string
  recovery_stage?: string
  spatial_observation?: unknown
}

type NavigationTask = PlayerParametersWalkToEntity & {
  target_kind?: NavigationTargetKind
  requested_position?: { x: number, y: number }
  persistent_follow?: boolean
  recovery_position?: { x: number, y: number }
  recovery_stage?: 'escape' | 'repath'
  last_recovery_reason?: string
  last_spatial_observation?: unknown
  last_repath_tick?: number
  physical_sample_position?: { x: number, y: number }
  physical_sample_tick?: number
  last_physical_progress_tick?: number
}

declare const storage: {
  airi_last_navigation_result?: NavigationResult
  airi_follow_state?: {
    active?: boolean
    player_name?: string
  }
}

function valid_radius(radius: number) {
  return typeof radius === 'number'
    && radius === math.floor(radius)
    && radius >= 1
    && radius <= MAX_SEARCH_RADIUS
}

function valid_unit_number(unit_number: number) {
  return typeof unit_number === 'number'
    && unit_number === math.floor(unit_number)
    && unit_number >= 1
    && unit_number <= 9007199254740991
}

function valid_coordinate(value: number) {
  return typeof value === 'number'
    && value === value
    && value >= -MAX_COORDINATE
    && value <= MAX_COORDINATE
}

function valid_reach_distance(value: number) {
  return typeof value === 'number'
    && value === value
    && value >= MIN_REACH_DISTANCE
    && value <= MAX_PLAYER_REACH_DISTANCE
}

function copy_position(position: { x: number, y: number }) {
  return { x: position.x, y: position.y }
}

function nearest(actor: ControlledActor, entities: LuaEntity[]) {
  let result: LuaEntity | undefined
  let best = math.huge
  for (const entity of entities) {
    const candidate = distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      result = entity
    }
  }
  return result
}

function identity_matches(actor: ControlledActor, task: PlayerParametersWalkToEntity) {
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function draw_path(actor: ControlledActor, path: PathfinderWaypoint[]) {
  for (let i = 0; i < path.length - 1; i++) {
    rendering.draw_line({
      color: { r: 0, g: 1, b: 0 },
      width: 2,
      from: path[i].position,
      to: path[i + 1].position,
      surface: actor.surface,
      time_to_live: 600,
      draw_on_ground: true,
    })
  }
}

function navigation_destination(task: NavigationTask) {
  if (task.target?.valid) return task.target.position
  if (task.target_kind === 'position' && task.requested_position) return task.requested_position
  return task.target_position ?? undefined
}

function record(actor: ControlledActor | undefined, raw_task: PlayerParametersWalkToEntity | undefined, accepted: boolean, completed: boolean, code: NavigationCode): NavigationResult {
  const task = raw_task as NavigationTask | undefined
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const destination = task ? navigation_destination(task) : undefined
  const result: NavigationResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    target_kind: task?.target_kind,
    entity_name: task?.entity_name || undefined,
    player_name: task?.target_player_name,
    target_unit_number: task?.target_unit_number,
    target_position: destination ? copy_position(destination) : undefined,
    path_request_id: task?.path_request_id,
    path_attempts: task?.path_attempts,
    blocked_reason: !completed && ['unreachable', 'path_timeout', 'stuck', 'path_busy'].indexOf(code) >= 0 ? code : undefined,
    recovery_stage: task?.recovery_stage,
    spatial_observation: task?.last_spatial_observation,
  }
  storage.airi_last_navigation_result = result
  return result
}

export function new_navigation_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function fail(actor: ControlledActor | undefined, task: NavigationTask, code: NavigationCode) {
    if (actor?.is_valid) actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, false, false, code)
    rendering.clear()
    if (actor && identity_matches(actor, task)) {
      manager.cancel_all_tasks(task.persistent_follow ? `follow_${code}` : `navigation_${code}`)
    }
    else manager.discard_all_tasks_after_actor_loss()
    log(`[AUTORIO] [ERROR] Navigation task failed: ${code}; queued operations cancelled`)
  }

  function complete(actor: ControlledActor, task: NavigationTask) {
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'reached')
    rendering.clear()
    manager.reset_task_state()
    manager.next_task()
    const destination = navigation_destination(task)
    const label = task.target_player_name
      ?? (task.target_kind === 'position' && destination ? serpent.line(destination) : task.entity_name)
      ?? 'target'
    log(`[AUTORIO] Navigation task complete: reached ${label}`)
  }

  function cancel_follow_navigation(actor: ControlledActor, task: NavigationTask) {
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'cancelled')
    rendering.clear()
    manager.reset_task_state()
    manager.next_task()
    log('[AUTORIO] Persistent follow navigation cancelled')
  }

  function actor_for_submission() {
    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor')
      return undefined
    }
    return { actor, identity }
  }

  function make_task(
    actor: ControlledActor,
    identity: ReturnType<ControlledActor['status_snapshot']>,
    entity_name: string,
    search_radius: number,
    target_player_name?: string,
    reach_distance?: number,
    target_kind: NavigationTargetKind = 'nearest_entity',
  ): NavigationTask {
    return {
      type: TaskStates.WALKING_TO_ENTITY,
      entity_name,
      search_radius,
      target_player_name,
      reach_distance,
      target_kind,
      path: null,
      path_drawn: false,
      path_index: 1,
      calculating_path: false,
      target_position: null,
      target: null,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
      path_attempts: 0,
      last_physical_progress_tick: game.tick,
      physical_sample_position: copy_position(actor.position),
      physical_sample_tick: game.tick,
    }
  }

  function submit(entity_name: string, search_radius: number): boolean {
    if (typeof entity_name !== 'string' || entity_name.length === 0 || !prototypes.entity[entity_name]) {
      record(get_actor(), undefined, false, false, 'invalid_entity_name')
      return false
    }
    if (!valid_radius(search_radius)) {
      record(get_actor(), undefined, false, false, 'invalid_radius')
      return false
    }

    const resolved = actor_for_submission()
    if (!resolved || resolved.identity.actor_id === undefined) return false
    manager.add_task(make_task(resolved.actor, resolved.identity, entity_name, search_radius, undefined, undefined, 'nearest_entity'))
    return true
  }

  function submit_exact(unit_number: number, reach_distance: number = TARGET_REACHED_DISTANCE): [boolean, string] {
    if (!valid_unit_number(unit_number)) {
      record(get_actor(), undefined, false, false, 'invalid_unit_number')
      return [false, 'unit_number must be a positive safe integer']
    }
    if (!valid_reach_distance(reach_distance)) {
      record(get_actor(), undefined, false, false, 'invalid_reach_distance')
      return [false, 'reach_distance must be from 0.25 to 64']
    }
    const resolved = actor_for_submission()
    if (!resolved || resolved.identity.actor_id === undefined) return [false, 'No controlled actor']
    const entity = resolve_entity_reference(resolved.actor, unit_number, 'map_visible')
    if (!entity || !entity.valid) {
      record(resolved.actor, undefined, false, false, 'target_gone')
      return [false, `Entity unit ${unit_number} not found`]
    }
    if (entity.surface.index !== resolved.actor.surface.index) {
      record(resolved.actor, undefined, false, false, 'different_surface')
      return [false, 'Entity is on a different surface']
    }
    const task = make_task(resolved.actor, resolved.identity, entity.name, 1, undefined, reach_distance, 'exact_entity')
    task.target_unit_number = unit_number
    // Keep the resolved entity: ordinary buildings are not indexed by
    // game.get_entity_by_unit_number(), so acquire must not look it up again.
    task.target = entity
    manager.add_task(task)
    return [true, 'Task started']
  }

  function submit_position(x: number, y: number, reach_distance: number = RECOVERY_REACHED_DISTANCE): [boolean, string] {
    if (!valid_coordinate(x) || !valid_coordinate(y)) {
      record(get_actor(), undefined, false, false, 'invalid_position')
      return [false, 'x and y must be finite map coordinates']
    }
    if (!valid_reach_distance(reach_distance)) {
      record(get_actor(), undefined, false, false, 'invalid_reach_distance')
      return [false, 'reach_distance must be from 0.25 to 64']
    }
    const resolved = actor_for_submission()
    if (!resolved || resolved.identity.actor_id === undefined) return [false, 'No controlled actor']
    const task = make_task(resolved.actor, resolved.identity, '', 1, undefined, reach_distance, 'position')
    task.requested_position = { x, y }
    task.target_position = { x, y }
    manager.add_task(task)
    return [true, 'Task started']
  }

  function submit_player(player_name: string, reach_distance: number = TARGET_REACHED_DISTANCE): [boolean, string] {
    if (typeof player_name !== 'string' || player_name.length === 0) return [false, 'player_name is required']
    if (!valid_reach_distance(reach_distance) || reach_distance < 1) {
      return [false, 'reach_distance must be from 1 to 64']
    }
    const resolved = actor_for_submission()
    if (!resolved || resolved.identity.actor_id === undefined) return [false, 'No controlled actor']
    const player = game.get_player(player_name)
    if (!player || !player.valid || !player.connected || !player.character) {
      record(resolved.actor, undefined, false, false, 'player_unavailable')
      return [false, 'Player is not connected with a character']
    }
    if (player.surface.index !== resolved.actor.surface.index) {
      record(resolved.actor, undefined, false, false, 'different_surface')
      return [false, 'Player is on a different surface']
    }
    const task = make_task(resolved.actor, resolved.identity, player.character.name, MAX_SEARCH_RADIUS, player_name, reach_distance, 'player')
    const follow = storage.airi_follow_state
    task.persistent_follow = follow?.active === true && follow.player_name === player_name
    manager.add_task(task)
    return [true, 'Task started']
  }

  function reset_physical_progress(actor: ControlledActor, task: NavigationTask) {
    task.physical_sample_position = copy_position(actor.position)
    task.physical_sample_tick = game.tick
    task.last_physical_progress_tick = game.tick
  }

  function maybe_prepare_escape(actor: ControlledActor, task: NavigationTask, reason: string) {
    if ((task.path_attempts ?? 0) < 2 || task.recovery_position) return false
    const target_position = navigation_destination(task)
    if (!target_position) return false
    const recovery = select_navigation_escape_point(actor, target_position, (task.path_attempts ?? 0) >= 3 ? 8 : 6)
    task.last_spatial_observation = recovery.spatial_observation
    task.last_recovery_reason = reason
    if (!recovery.ok || !recovery.best?.position) return false
    task.recovery_position = copy_position(recovery.best.position)
    task.recovery_stage = 'escape'
    log(`[AUTORIO] Navigation recovery selected escape point ${serpent.line(task.recovery_position)} after ${reason}`)
    return true
  }

  function request_path(actor: ControlledActor, task: NavigationTask) {
    const character = actor.character
    if (!character) {
      fail(actor, task, 'no_actor')
      return false
    }
    if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
      fail(actor, task, task.last_recovery_reason === 'physical_stuck' ? 'stuck' : 'path_timeout')
      return false
    }

    const start = copy_position(character.position)
    const target = task.target
    if (task.target_kind !== 'position' && (!target || !target.valid)) {
      fail(actor, task, 'target_gone')
      return false
    }
    const destination = navigation_destination(task)
    if (!destination) {
      fail(actor, task, 'no_target')
      return false
    }

    const character_prototype = character.prototype
    task.path_attempts = (task.path_attempts ?? 0) + 1
    task.target_position = copy_position(destination)
    const goal = task.recovery_position ? copy_position(task.recovery_position) : copy_position(destination)
    const arrival_radius = task.recovery_position
      ? 0.5
      : math.max(MIN_REACH_DISTANCE, math.min(task.reach_distance ?? TARGET_REACHED_DISTANCE, 2))
    task.path_request_id = actor.surface.request_path({
      bounding_box: character_prototype.collision_box,
      collision_mask: character_prototype.collision_mask,
      radius: arrival_radius,
      start,
      goal,
      force: actor.force,
      entity_to_ignore: character,
      pathfind_flags: {
        cache: false,
        no_break: true,
        prefer_straight_paths: false,
        allow_paths_through_own_entities: false,
      },
    })
    task.path_requested_tick = game.tick
    task.last_repath_tick = game.tick
    task.calculating_path = true
    task.path = null
    task.path_drawn = false
    task.last_waypoint_distance = undefined
    task.next_retry_tick = undefined
    reset_physical_progress(actor, task)
    log(`[AUTORIO] Requested path id=${task.path_request_id} attempt=${task.path_attempts} from ${serpent.line(start)} to ${serpent.line(goal)}${task.recovery_position ? ' (recovery)' : ''}`)
    return true
  }

  function acquire(actor: ControlledActor, task: NavigationTask) {
    if (task.target_kind === 'position') {
      if (!task.requested_position) {
        fail(actor, task, 'no_target')
        return false
      }
      task.target = null
      task.target_position = copy_position(task.requested_position)
      task.started_tick = game.tick
      task.last_progress_tick = game.tick
      task.last_waypoint_distance = undefined
      reset_physical_progress(actor, task)
      record(actor, task, true, false, 'started')
      return request_path(actor, task)
    }

    let target: LuaEntity | undefined
    if (task.target_player_name) {
      const player = game.get_player(task.target_player_name)
      if (!player || !player.valid || !player.connected || !player.character) {
        fail(actor, task, 'player_unavailable')
        return false
      }
      if (player.surface.index !== actor.surface.index) {
        fail(actor, task, 'different_surface')
        return false
      }
      target = player.character
    }
    else if (task.target_kind === 'exact_entity' && task.target_unit_number !== undefined) {
      target = task.target?.valid && task.target.unit_number === task.target_unit_number
        ? task.target
        : resolve_entity_reference(actor, task.target_unit_number, 'map_visible')
      if (!target || !target.valid) {
        fail(actor, task, 'target_gone')
        return false
      }
      if (target.surface.index !== actor.surface.index) {
        fail(actor, task, 'different_surface')
        return false
      }
    }
    else {
      target = nearest(actor, actor.surface.find_entities_filtered({ position: actor.position, radius: task.search_radius, name: task.entity_name }))
    }
    if (!target) {
      fail(actor, task, 'no_target')
      return false
    }

    task.target = target
    task.target_unit_number = target.unit_number
    task.target_position = copy_position(target.position)
    task.started_tick = game.tick
    task.last_progress_tick = game.tick
    task.last_waypoint_distance = undefined
    reset_physical_progress(actor, task)
    record(actor, task, true, false, 'started')
    return request_path(actor, task)
  }

  function repath(actor: ControlledActor, task: NavigationTask, exhausted_code: NavigationCode, reason: string = 'repath') {
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    rendering.clear()
    task.path = null
    task.path_drawn = false
    task.calculating_path = false
    task.path_request_id = undefined
    task.path_requested_tick = undefined
    task.next_retry_tick = undefined
    task.last_progress_tick = game.tick
    task.last_waypoint_distance = undefined
    task.last_recovery_reason = reason
    if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
      if (!task.last_spatial_observation) maybe_prepare_escape(actor, task, reason)
      fail(actor, task, exhausted_code)
      return false
    }
    maybe_prepare_escape(actor, task, reason)
    return request_path(actor, task)
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const raw_task = manager.player_state.parameters_walk_to_entity
    if (!raw_task || manager.player_state.task_state !== TaskStates.WALKING_TO_ENTITY) return
    const task = raw_task as NavigationTask
    if (task.path_request_id === undefined || event.id !== task.path_request_id) return

    const actor = get_actor()
    if (!actor || manager.player_state.parameters_walk_to_entity !== task) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }

    task.calculating_path = false
    task.path_request_id = undefined
    task.path_requested_tick = undefined

    if (event.try_again_later) {
      if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
        fail(actor, task, 'path_busy')
        return
      }
      task.last_recovery_reason = 'path_busy'
      task.next_retry_tick = game.tick + PATH_RETRY_DELAY_TICKS
      return
    }

    if (!event.path || event.path.length === 0) {
      if ((task.path_attempts ?? 0) >= MAX_PATH_ATTEMPTS) {
        task.last_recovery_reason = 'unreachable'
        if (!task.last_spatial_observation) maybe_prepare_escape(actor, task, 'unreachable')
        fail(actor, task, 'unreachable')
        return
      }
      task.last_recovery_reason = 'unreachable'
      maybe_prepare_escape(actor, task, 'unreachable')
      task.next_retry_tick = game.tick + PATH_RETRY_DELAY_TICKS
      log(`[AUTORIO] No path found on attempt ${task.path_attempts ?? 0}; adaptive recovery scheduled from actual actor position`)
      return
    }

    task.path = event.path
    task.path_drawn = false
    task.path_index = 1
    task.last_progress_tick = game.tick
    task.last_waypoint_distance = distance(actor.position, event.path[0].position)
    reset_physical_progress(actor, task)
  }

  function physical_stuck(actor: ControlledActor, task: NavigationTask) {
    const sample_tick = task.physical_sample_tick ?? game.tick
    if (game.tick - sample_tick < PHYSICAL_SAMPLE_TICKS) return false
    const sample_position = task.physical_sample_position ?? copy_position(actor.position)
    const moved = distance(sample_position, actor.position)
    task.physical_sample_tick = game.tick
    task.physical_sample_position = copy_position(actor.position)
    if (moved >= PHYSICAL_PROGRESS_DISTANCE) {
      task.last_physical_progress_tick = game.tick
      return false
    }
    return game.tick - (task.last_physical_progress_tick ?? game.tick) >= PHYSICAL_STUCK_TICKS
  }

  function follow_path(actor: ControlledActor, task: NavigationTask) {
    const path = task.path
    if (!path || path.length === 0) return false

    if (!task.path_drawn) {
      draw_path(actor, path)
      task.path_drawn = true
    }

    const next_position = path[0].position
    const waypoint_distance = distance(next_position, actor.position)
    if (waypoint_distance <= WAYPOINT_REACHED_DISTANCE) {
      path.shift()
      task.last_progress_tick = game.tick
      task.last_waypoint_distance = path.length > 0 ? distance(path[0].position, actor.position) : undefined
      reset_physical_progress(actor, task)
      return true
    }

    const best_distance = task.last_waypoint_distance
    if (best_distance === undefined || waypoint_distance <= best_distance - PROGRESS_DISTANCE) {
      task.last_waypoint_distance = waypoint_distance
      task.last_progress_tick = game.tick
    }

    if (physical_stuck(actor, task)) {
      repath(actor, task, 'stuck', 'physical_stuck')
      return true
    }
    if (game.tick - (task.last_progress_tick ?? game.tick) > STUCK_TICKS) {
      repath(actor, task, 'stuck', 'waypoint_no_progress')
      return true
    }

    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, next_position) })
    return true
  }

  function refresh_player_target(actor: ControlledActor, task: NavigationTask) {
    if (!task.target_player_name) return true
    const player = game.get_player(task.target_player_name)
    if (!player || !player.valid || !player.connected || !player.character) {
      fail(actor, task, 'player_unavailable')
      return false
    }
    if (player.surface.index !== actor.surface.index) {
      fail(actor, task, 'different_surface')
      return false
    }
    if (task.target !== player.character) {
      task.target = player.character
      task.target_unit_number = player.character.unit_number
      task.target_position = copy_position(player.character.position)
      repath(actor, task, 'stuck', 'player_character_changed')
      return false
    }
    return true
  }

  function persistent_follow_disabled(task: NavigationTask) {
    if (!task.persistent_follow) return false
    const follow = storage.airi_follow_state
    return follow?.active !== true || follow.player_name !== task.target_player_name
  }

  function tick(actor: ControlledActor) {
    const raw_task = manager.player_state.parameters_walk_to_entity
    if (!raw_task || manager.player_state.task_state !== TaskStates.WALKING_TO_ENTITY) return
    const task = raw_task as NavigationTask
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }
    if (persistent_follow_disabled(task)) {
      cancel_follow_navigation(actor, task)
      return
    }

    if (task.started_tick === undefined && !acquire(actor, task)) return
    if (!refresh_player_target(actor, task)) return

    const target = task.target
    if (task.target_kind !== 'position' && (!target || !target.valid)) {
      fail(actor, task, 'target_gone')
      return
    }
    const destination = navigation_destination(task)
    if (!destination) {
      fail(actor, task, 'no_target')
      return
    }

    const started_tick = task.started_tick ?? game.tick
    if (game.tick - started_tick > MAX_NAVIGATION_TICKS) {
      fail(actor, task, 'timeout')
      return
    }

    const reach_distance = task.reach_distance ?? TARGET_REACHED_DISTANCE
    if (distance(actor.position, destination) <= reach_distance) {
      complete(actor, task)
      return
    }

    if (task.recovery_position && distance(actor.position, task.recovery_position) <= RECOVERY_REACHED_DISTANCE) {
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      task.recovery_position = undefined
      task.recovery_stage = 'repath'
      task.path = null
      task.path_drawn = false
      task.calculating_path = false
      task.last_progress_tick = game.tick
      request_path(actor, task)
      return
    }

    if (target?.valid && !task.recovery_position && task.target_position && distance(task.target_position, target.position) >= TARGET_REPATH_DISTANCE) {
      task.path_attempts = math.max(0, (task.path_attempts ?? 1) - 1)
      repath(actor, task, 'stuck', 'target_moved')
      return
    }

    if (task.calculating_path) {
      const requested_tick = task.path_requested_tick ?? game.tick
      if (game.tick - requested_tick > PATH_REQUEST_TIMEOUT_TICKS) repath(actor, task, 'path_timeout', 'path_request_timeout')
      return
    }

    if (task.next_retry_tick !== undefined) {
      if (game.tick >= task.next_retry_tick) request_path(actor, task)
      return
    }

    if (task.path && task.path.length > 0) {
      follow_path(actor, task)
      return
    }

    repath(actor, task, 'stuck', 'empty_path')
  }

  function status() {
    const actor = get_actor()
    const raw_task = manager.player_state.parameters_walk_to_entity
    const task = raw_task as NavigationTask | undefined
    const target = task?.target
    const destination = task ? navigation_destination(task) : undefined
    const active = manager.player_state.task_state === TaskStates.WALKING_TO_ENTITY
    const last = storage.airi_last_navigation_result
    const blocked = !active && last !== undefined && ['unreachable', 'path_timeout', 'stuck', 'path_busy'].indexOf(last.code) >= 0
    return {
      task_active: active,
      state: active ? (task?.recovery_position ? 'recovering' : task?.calculating_path ? 'pathfinding' : 'navigating') : blocked ? 'blocked' : last?.code === 'reached' ? 'reached' : 'idle',
      actor: actor?.status_snapshot(),
      target_kind: task?.target_kind,
      player_name: task?.target_player_name,
      persistent_follow: task?.persistent_follow === true,
      reach_distance: task?.reach_distance,
      destination: destination
        ? {
            position: copy_position(destination),
            distance: actor ? distance(actor.position, destination) : undefined,
          }
        : undefined,
      target: target && target.valid
        ? {
            name: target.name,
            unit_number: target.unit_number,
            position: target.position,
            distance: actor ? distance(actor.position, target.position) : undefined,
          }
        : undefined,
      path: task
        ? {
            calculating: task.calculating_path,
            request_id: task.path_request_id,
            attempts: task.path_attempts ?? 0,
            waypoints_remaining: task.path?.length ?? 0,
            best_waypoint_distance: task.last_waypoint_distance,
            last_progress_tick: task.last_progress_tick,
            physical_last_progress_tick: task.last_physical_progress_tick,
            stuck_for_ticks: task.last_progress_tick === undefined ? undefined : game.tick - task.last_progress_tick,
            physical_stuck_for_ticks: task.last_physical_progress_tick === undefined ? undefined : game.tick - task.last_physical_progress_tick,
            retry_at_tick: task.next_retry_tick,
            last_repath_tick: task.last_repath_tick,
            recovery_stage: task.recovery_stage,
            recovery_position: task.recovery_position,
            last_recovery_reason: task.last_recovery_reason,
          }
        : undefined,
      blocked_reason: blocked ? last?.blocked_reason ?? last?.code : undefined,
      last_spatial_observation: task?.last_spatial_observation ?? last?.spatial_observation,
      last_result: last,
    }
  }

  return { submit, submit_exact, submit_position, submit_player, tick, on_path_finished, status }
}
