import type { LuaEntity, LuaInventory, LuaItemStack, OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersAttackNearestEnemy } from './types'
import { plan_placement, select_navigation_escape_point } from './construction_planning'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MAX_SEARCH_RADIUS = 256
const MAX_SINGLE_COMBAT_TICKS = 60 * 60
const MAX_CLEAR_AREA_TICKS = 10 * 60 * 60
const COMBAT_PATH_STUCK_TICKS = 3 * 60
const LEGACY_DIRECT_STUCK_TICKS = 10 * 60
const COMBAT_PHYSICAL_STUCK_TICKS = 90
const COMBAT_PHYSICAL_SAMPLE_TICKS = 30
const COMBAT_PHYSICAL_PROGRESS_DISTANCE = 0.12
const DISTANCE_PROGRESS_EPSILON = 0.25
const MOBILE_THREAT_PRIORITY_RADIUS = 28
const KITE_DISTANCE = 12
const PANIC_DISTANCE = 7
const LOW_HEALTH_RATIO = 0.35
const TURRET_DANGER_DISTANCE = 10
const TURRET_STAGING_DISTANCE = 24
const TURRET_MIN_ADVANCE_DISTANCE = 6
const TURRET_BEHIND_ACTOR_DISTANCE = 3.5
const TURRET_LATERAL_SPACING = 2.5
const TURRET_ACTOR_CLEARANCE = 2.5
const TURRET_TARGET_SAFETY_MARGIN = 0.5
const TURRET_PLACEMENT_SEARCH_RADIUS = 3
const TURRET_PLACEMENT_CANDIDATES = 6
const TURRET_LOAD_COUNT = 20
const MAX_SUPPORT_TURRETS = 4
const TURRET_AMMO_PRIORITY = ['uranium-rounds-magazine', 'piercing-rounds-magazine', 'firearm-magazine']
const COMBAT_PATH_MAX_ATTEMPTS = 4
const COMBAT_PATH_REQUEST_TIMEOUT_TICKS = 15 * 60
const COMBAT_PATH_RETRY_DELAY_TICKS = 30
const COMBAT_PATH_APPROACH_GOAL_RADIUS = 8
const COMBAT_PATH_CHASE_GOAL_RADIUS = 2.5
const COMBAT_PATH_RETREAT_GOAL_RADIUS = 1.5
const COMBAT_PATH_RECOVERY_GOAL_RADIUS = 0.5
const COMBAT_PATH_WAYPOINT_DISTANCE = 0.5
const COMBAT_PATH_PROGRESS_DISTANCE = 0.25
const COMBAT_PATH_TARGET_REPATH_DISTANCE = 2
const COMBAT_RECOVERY_REACHED_DISTANCE = 0.75

type CombatPathMode = 'approach' | 'retreat'
type CombatCode = 'started' | 'target_destroyed' | 'area_cleared' | 'no_actor' | 'invalid_radius'
  | 'no_target' | 'no_weapon_or_ammo' | 'actor_changed' | 'low_health' | 'stuck' | 'timeout'
  | 'path_unreachable' | 'path_timeout'

type CombatTask = PlayerParametersAttackNearestEnemy & {
  combat_recovery_position?: { x: number, y: number }
  combat_recovery_stage?: 'escape' | 'repath'
  combat_last_recovery_reason?: string
  combat_last_spatial_observation?: unknown
  combat_physical_sample_position?: { x: number, y: number }
  combat_physical_sample_tick?: number
  combat_last_physical_progress_tick?: number
  last_turret_placement_plan?: unknown
}

interface CombatResult {
  accepted: boolean
  completed: boolean
  code: CombatCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  mode?: 'single' | 'clear_area'
  target_name?: string
  target_unit_number?: number
  target_initial_health?: number
  targets_destroyed?: number
  turrets_placed?: number
  initial_static_threats?: number
  support_turret_budget?: number
  support_stage_started?: boolean
  last_turret_position?: { x: number, y: number }
  last_turret_unit_number?: number
  turret_ammo_name?: string
  last_turret_ammo_loaded?: number
  path_mode?: CombatPathMode
  path_request_id?: number
  path_attempts?: number
  path_waypoints_remaining?: number
  recovery_stage?: string
  spatial_observation?: unknown
}

declare const storage: {
  airi_last_combat_result?: CombatResult
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

function preferred_target(actor: ControlledActor, entities: LuaEntity[]) {
  let nearest_mobile: LuaEntity | undefined
  let mobile_distance = math.huge
  for (const entity of entities) {
    if (entity.type !== 'unit') continue
    const candidate = distance(actor.position, entity.position)
    if (candidate <= MOBILE_THREAT_PRIORITY_RADIUS && candidate < mobile_distance) {
      nearest_mobile = entity
      mobile_distance = candidate
    }
  }
  return nearest_mobile ?? nearest(actor, entities)
}

function valid_radius(radius: number) {
  return typeof radius === 'number'
    && radius === math.floor(radius)
    && radius >= 1
    && radius <= MAX_SEARCH_RADIUS
}

function identity_matches(actor: ControlledActor, task: PlayerParametersAttackNearestEnemy) {
  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function has_selected_weapon_and_ammo(character: LuaEntity) {
  const factorioIndex = character.selected_gun_index
  const guns = character.get_inventory(defines.inventory.character_guns)
  const ammo = character.get_inventory(defines.inventory.character_ammo)
  if (!factorioIndex || !guns || !ammo) return false
  const typescriptIndex = factorioIndex - 1
  const gun = guns[typescriptIndex]
  const magazine = ammo[typescriptIndex]
  return gun?.valid_for_read === true && magazine?.valid_for_read === true
}

function is_alive(entity: LuaEntity | null | undefined) {
  return !!entity && entity.valid && !(entity.health !== undefined && entity.health !== null && entity.health <= 0)
}

function is_static_enemy(entity: LuaEntity) {
  return entity.type === 'unit-spawner' || entity.type === 'turret'
}

function support_turret_budget(static_threats: number) {
  if (static_threats <= 0) return 0
  if (static_threats === 1) return 1
  if (static_threats <= 3) return 2
  if (static_threats <= 6) return 3
  return MAX_SUPPORT_TURRETS
}

function retreat_position(actor: ControlledActor, threat: LuaEntity) {
  const dx = actor.position.x - threat.position.x
  const dy = actor.position.y - threat.position.y
  return { x: actor.position.x + dx, y: actor.position.y + dy }
}

function selected_support_ammo(inventory: LuaInventory): { name: string, stack: LuaItemStack } | undefined {
  for (const name of TURRET_AMMO_PRIORITY) {
    const [stack] = inventory.find_item_stack(name)
    if (stack?.valid_for_read === true && stack.count > 0) return { name, stack }
  }
  return undefined
}

function record(actor: ControlledActor | undefined, raw_task: PlayerParametersAttackNearestEnemy | undefined, accepted: boolean, completed: boolean, code: CombatCode): CombatResult {
  const task = raw_task as CombatTask | undefined
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: CombatResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    mode: task?.combat_mode,
    target_name: task?.target_name,
    target_unit_number: task?.target_unit_number,
    target_initial_health: task?.target_initial_health,
    targets_destroyed: task?.targets_destroyed,
    turrets_placed: task?.turrets_placed,
    initial_static_threats: task?.initial_static_threats,
    support_turret_budget: task?.support_turret_budget,
    support_stage_started: task?.support_stage_started,
    last_turret_position: task?.last_turret_position,
    last_turret_unit_number: task?.last_turret_unit_number,
    turret_ammo_name: task?.turret_ammo_name,
    last_turret_ammo_loaded: task?.last_turret_ammo_loaded,
    path_mode: task?.combat_path_mode,
    path_request_id: task?.combat_path_request_id,
    path_attempts: task?.combat_path_attempts,
    path_waypoints_remaining: task?.combat_path?.length,
    recovery_stage: task?.combat_recovery_stage,
    spatial_observation: task?.combat_last_spatial_observation,
  }
  storage.airi_last_combat_result = result
  return result
}

export function new_combat_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function submit_task(search_radius: number, combat_mode: 'single' | 'clear_area'): [boolean, string] {
    if (!valid_radius(search_radius)) {
      record(get_actor(), undefined, false, false, 'invalid_radius')
      return [false, 'invalid_radius']
    }
    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor')
      return [false, 'no_actor']
    }
    manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius,
      combat_mode,
      origin_position: copy_position(actor.position),
      target: null,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
      targets_destroyed: 0,
      turrets_placed: 0,
      combat_path: null,
      combat_path_attempts: 0,
      started_tick: game.tick,
    })
    return [true, combat_mode === 'clear_area' ? 'Area-clear combat task queued' : 'Combat task queued']
  }

  function submit(search_radius: number = 50): [boolean, string] {
    return submit_task(search_radius, 'single')
  }

  function submit_clear(search_radius: number = 96): [boolean, string] {
    return submit_task(search_radius, 'clear_area')
  }

  function stop_actor_combat(actor: ControlledActor) {
    actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function clear_combat_path(task: CombatTask, reset_attempts = false) {
    task.combat_path_mode = undefined
    task.combat_path = null
    task.combat_path_request_id = undefined
    task.combat_path_requested_tick = undefined
    task.combat_path_next_retry_tick = undefined
    task.combat_path_target_position = undefined
    task.combat_path_last_progress_tick = undefined
    task.combat_path_last_waypoint_distance = undefined
    task.combat_recovery_position = undefined
    task.combat_recovery_stage = undefined
    task.combat_last_recovery_reason = undefined
    task.combat_physical_sample_position = undefined
    task.combat_physical_sample_tick = undefined
    task.combat_last_physical_progress_tick = undefined
    if (reset_attempts) task.combat_path_attempts = 0
  }

  function reset_combat_physical_progress(actor: ControlledActor, task: CombatTask) {
    task.combat_physical_sample_position = copy_position(actor.position)
    task.combat_physical_sample_tick = game.tick
    task.combat_last_physical_progress_tick = game.tick
  }

  function physical_path_stuck(actor: ControlledActor, task: CombatTask) {
    if (!task.combat_physical_sample_position || task.combat_physical_sample_tick === undefined || task.combat_last_physical_progress_tick === undefined) {
      reset_combat_physical_progress(actor, task)
      return false
    }
    if (game.tick - task.combat_physical_sample_tick >= COMBAT_PHYSICAL_SAMPLE_TICKS) {
      if (distance(actor.position, task.combat_physical_sample_position) >= COMBAT_PHYSICAL_PROGRESS_DISTANCE) {
        task.combat_last_physical_progress_tick = game.tick
      }
      task.combat_physical_sample_position = copy_position(actor.position)
      task.combat_physical_sample_tick = game.tick
    }
    return game.tick - task.combat_last_physical_progress_tick > COMBAT_PHYSICAL_STUCK_TICKS
  }

  function fail(actor: ControlledActor, task: CombatTask, code: CombatCode) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, false, false, code)
    manager.cancel_all_tasks()
    log(`[AUTORIO] [ERROR] Combat task failed: ${code}; queued operations cancelled`)
  }

  function complete_single(actor: ControlledActor, task: CombatTask) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'target_destroyed')
    manager.reset_task_state()
    manager.next_task()
    log('[AUTORIO] Combat task complete: target destroyed')
  }

  function complete_area(actor: ControlledActor, task: CombatTask) {
    stop_actor_combat(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'area_cleared')
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Combat area clear: destroyed ${task.targets_destroyed ?? 0} targets, placed ${task.turrets_placed ?? 0}/${task.support_turret_budget ?? 0} support turrets`)
  }

  function area_enemies(actor: ControlledActor, task: CombatTask) {
    const origin = task.origin_position ?? actor.position
    return actor.surface.find_entities_filtered({ position: origin, radius: task.search_radius, force: 'enemy' })
  }

  function initialize_support_plan(task: CombatTask, enemies: LuaEntity[]) {
    if (task.combat_mode !== 'clear_area' || task.support_turret_budget !== undefined) return
    let static_threats = 0
    for (const entity of enemies) if (is_alive(entity) && is_static_enemy(entity)) static_threats++
    task.initial_static_threats = static_threats
    task.support_turret_budget = support_turret_budget(static_threats)
    log(`[AUTORIO] Combat support plan: static_threats=${static_threats}, turret_budget=${task.support_turret_budget}`)
  }

  function bind_target(actor: ControlledActor, task: CombatTask, target: LuaEntity, reason: 'acquired' | 'preempted') {
    if (task.target !== target) clear_combat_path(task, true)
    task.target = target
    task.target_name = target.name
    task.target_unit_number = target.unit_number
    task.target_initial_health = target.health ?? undefined
    task.last_progress_tick = game.tick
    task.last_distance = distance(actor.position, target.position)
    const result = record(actor, task, true, false, 'started')
    log(`[AUTORIO] Combat target ${reason}: ${result.target_name} unit=${result.target_unit_number ?? 'n/a'} mode=${task.combat_mode ?? 'single'}`)
  }

  function acquire(actor: ControlledActor, task: CombatTask) {
    const enemies = area_enemies(actor, task)
    initialize_support_plan(task, enemies)
    const target = preferred_target(actor, enemies)
    if (!target) {
      if (task.combat_mode === 'clear_area') complete_area(actor, task)
      else fail(actor, task, 'no_target')
      return false
    }
    bind_target(actor, task, target, 'acquired')
    return true
  }

  function nearby_mobile_threat(actor: ControlledActor) {
    let threat: LuaEntity | undefined
    let best = math.huge
    const local_units = actor.surface.find_entities_filtered({ position: actor.position, radius: MOBILE_THREAT_PRIORITY_RADIUS, force: 'enemy', type: 'unit' })
    for (const entity of local_units) {
      if (!is_alive(entity)) continue
      const candidate = distance(actor.position, entity.position)
      if (candidate < best) {
        threat = entity
        best = candidate
      }
    }
    return threat
  }

  function preempt_static_target_for_mobile_threat(actor: ControlledActor, task: CombatTask) {
    const target = task.target
    if (task.combat_mode !== 'clear_area' || !target || !is_alive(target) || !is_static_enemy(target)) return false
    const threat = nearby_mobile_threat(actor)
    if (!threat || threat === target) return false
    bind_target(actor, task, threat, 'preempted')
    stop_actor_combat(actor)
    return true
  }

  function clear_bound_target(task: CombatTask) {
    task.target = null
    task.target_name = undefined
    task.target_unit_number = undefined
    task.target_initial_health = undefined
    task.last_distance = undefined
    task.last_progress_tick = game.tick
    clear_combat_path(task, true)
  }

  function target_destroyed(actor: ControlledActor, task: CombatTask) {
    task.targets_destroyed = (task.targets_destroyed ?? 0) + 1
    if (task.combat_mode !== 'clear_area') {
      complete_single(actor, task)
      return
    }
    clear_bound_target(task)
    stop_actor_combat(actor)
    acquire(actor, task)
  }

  function nearest_mobile_enemy_distance(actor: ControlledActor) {
    let result = math.huge
    const local_units = actor.surface.find_entities_filtered({ position: actor.position, radius: TURRET_DANGER_DISTANCE, force: 'enemy', type: 'unit' })
    for (const entity of local_units) {
      if (!is_alive(entity)) continue
      const candidate = distance(actor.position, entity.position)
      if (candidate < result) result = candidate
    }
    return result
  }

  function should_place_support(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (task.combat_mode !== 'clear_area' || !is_static_enemy(target)) return false
    const budget = task.support_turret_budget ?? 0
    if ((task.turrets_placed ?? 0) >= budget) return false
    if (nearest_mobile_enemy_distance(actor) <= TURRET_DANGER_DISTANCE) return false
    if (!task.support_stage_started) {
      const origin = task.origin_position ?? actor.position
      const advanced = distance(actor.position, origin) >= TURRET_MIN_ADVANCE_DISTANCE
      const staged = distance(actor.position, target.position) <= TURRET_STAGING_DISTANCE
      if (!advanced || !staged) return false
      task.support_stage_started = true
      log(`[AUTORIO] Combat support staging established after advancing ${distance(actor.position, origin)} tiles; budget=${budget}`)
    }
    return true
  }

  function support_anchor(actor: ControlledActor, target: LuaEntity, turret_index: number) {
    let away_x = actor.position.x - target.position.x
    let away_y = actor.position.y - target.position.y
    const magnitude = math.sqrt(away_x * away_x + away_y * away_y)
    if (magnitude > 0.001) {
      away_x /= magnitude
      away_y /= magnitude
    }
    else {
      away_x = -1
      away_y = 0
    }
    const perpendicular_x = -away_y
    const perpendicular_y = away_x
    let lateral = 0
    if (turret_index > 0) {
      const rank = math.floor((turret_index + 1) / 2)
      const side = turret_index % 2 === 1 ? 1 : -1
      lateral = rank * TURRET_LATERAL_SPACING * side
    }
    return {
      x: actor.position.x + away_x * TURRET_BEHIND_ACTOR_DISTANCE + perpendicular_x * lateral,
      y: actor.position.y + away_y * TURRET_BEHIND_ACTOR_DISTANCE + perpendicular_y * lateral,
    }
  }

  function planned_support_position(actor: ControlledActor, task: CombatTask, target: LuaEntity, anchor: { x: number, y: number }) {
    // Factorio surfaces always expose can_place_entity. The fallback keeps older
    // lightweight test doubles usable while production uses the shared planner.
    if (!actor.surface.can_place_entity) {
      return actor.surface.find_non_colliding_position('gun-turret', anchor, 2, 0.25, false)
    }
    const placement = plan_placement(actor, {
      entity_name: 'gun-turret',
      position: anchor,
      side: 'any',
      search_radius: TURRET_PLACEMENT_SEARCH_RADIUS,
      max_candidates: TURRET_PLACEMENT_CANDIDATES,
    })
    task.last_turret_placement_plan = placement
    if (!placement.ok || !('candidates' in placement)) return undefined
    const actor_target_distance = distance(actor.position, target.position)
    for (const candidate of placement.candidates ?? []) {
      const position = candidate.position as { x: number, y: number }
      if (distance(position, actor.position) < TURRET_ACTOR_CLEARANCE) continue
      if (distance(position, target.position) + TURRET_TARGET_SAFETY_MARGIN < actor_target_distance) continue
      return position
    }
    return undefined
  }

  function place_support_turret(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (!should_place_support(actor, task, target)) return false
    const inventory = actor.get_main_inventory()
    if (!inventory) return false
    const [turret_stack] = inventory.find_item_stack('gun-turret')
    if (!turret_stack || !turret_stack.valid_for_read || turret_stack.count <= 0) return false
    const ammo = selected_support_ammo(inventory)
    if (!ammo) return false
    const turret_index = task.turrets_placed ?? 0
    const anchor = support_anchor(actor, target, turret_index)
    const position = planned_support_position(actor, task, target, anchor)
    if (!position) {
      log(`[AUTORIO] No safe shared-planner support turret position near ${serpent.line(anchor)}`)
      return false
    }
    if (distance(position, actor.position) < TURRET_ACTOR_CLEARANCE) {
      log(`[AUTORIO] Refusing support turret position ${serpent.line(position)} inside actor clearance ${TURRET_ACTOR_CLEARANCE}`)
      return false
    }
    const turret = actor.surface.create_entity({ name: 'gun-turret', position, raise_built: true, ...actor.entity_build_args() })
    if (!turret) return false
    const turret_inventory = turret.get_inventory(defines.inventory.turret_ammo)
    if (!turret_inventory) {
      turret.destroy()
      return false
    }
    const removed_turret = inventory.remove({ name: 'gun-turret', count: 1 })
    if (removed_turret !== 1) {
      turret.destroy()
      return false
    }
    const requested_ammo = math.min(TURRET_LOAD_COUNT, ammo.stack.count)
    const removed_ammo = inventory.remove({ name: ammo.name, count: requested_ammo })
    if (removed_ammo <= 0) {
      inventory.insert({ name: 'gun-turret', count: 1 })
      turret.destroy()
      return false
    }
    const inserted_ammo = turret_inventory.insert({ name: ammo.name, count: removed_ammo })
    if (inserted_ammo < removed_ammo) inventory.insert({ name: ammo.name, count: removed_ammo - inserted_ammo })
    if (inserted_ammo <= 0) {
      inventory.insert({ name: 'gun-turret', count: 1 })
      turret.destroy()
      return false
    }
    task.turrets_placed = turret_index + 1
    task.last_turret_position = copy_position(position)
    task.last_turret_unit_number = turret.unit_number
    task.turret_ammo_name = ammo.name
    task.last_turret_ammo_loaded = inserted_ammo
    log(`[AUTORIO] Combat support turret ${task.turrets_placed}/${task.support_turret_budget ?? 0} placed at ${serpent.line(position)} unit=${turret.unit_number ?? 'n/a'} with ${inserted_ammo} ${ammo.name}`)
    return true
  }

  function health_ratio(character: LuaEntity) {
    if (character.health === undefined || character.health === null || character.max_health <= 0) return 1
    return character.health / character.max_health
  }

  function walk_toward(actor: ControlledActor, position: { x: number, y: number }) {
    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, position) })
  }

  function supports_combat_path_runtime(actor: ControlledActor) {
    const character = actor.character as any
    const surface = actor.surface as any
    return !!character
      && !!character.prototype
      && !!character.prototype.collision_box
      && !!character.prototype.collision_mask
      && typeof surface.request_path === 'function'
  }

  function supports_spatial_recovery(actor: ControlledActor) {
    const surface = actor.surface as any
    return supports_combat_path_runtime(actor)
      && typeof surface.find_non_colliding_position === 'function'
      && typeof surface.get_tile === 'function'
  }

  function supports_mobile_combat_path(actor: ControlledActor, task: CombatTask) {
    return task.last_turret_position
      ? supports_combat_path_runtime(actor)
      : supports_spatial_recovery(actor)
  }

  function path_goal_changed(task: CombatTask, goal: { x: number, y: number }, mode: CombatPathMode) {
    if (task.combat_recovery_position) return task.combat_path_mode !== mode
    return task.combat_path_mode !== mode
      || !task.combat_path_target_position
      || distance(task.combat_path_target_position, goal) >= COMBAT_PATH_TARGET_REPATH_DISTANCE
  }

  function path_goal_radius(task: CombatTask, mode: CombatPathMode) {
    if (task.combat_recovery_position) return COMBAT_PATH_RECOVERY_GOAL_RADIUS
    if (mode === 'retreat') return COMBAT_PATH_RETREAT_GOAL_RADIUS
    return task.target && is_alive(task.target) && is_static_enemy(task.target)
      ? COMBAT_PATH_APPROACH_GOAL_RADIUS
      : COMBAT_PATH_CHASE_GOAL_RADIUS
  }

  function maybe_prepare_combat_escape(actor: ControlledActor, task: CombatTask, goal: { x: number, y: number }, reason: string) {
    if (!supports_spatial_recovery(actor)) return false
    if ((task.combat_path_attempts ?? 0) < 2 || task.combat_recovery_position) return false
    const recovery = select_navigation_escape_point(actor, goal, (task.combat_path_attempts ?? 0) >= 3 ? 8 : 6)
    task.combat_last_spatial_observation = recovery.spatial_observation
    task.combat_last_recovery_reason = reason
    if (!recovery.ok || !recovery.best?.position) return false
    task.combat_recovery_position = copy_position(recovery.best.position)
    task.combat_recovery_stage = 'escape'
    log(`[AUTORIO] Combat recovery selected escape point ${serpent.line(task.combat_recovery_position)} after ${reason}`)
    return true
  }

  function request_combat_path(actor: ControlledActor, task: CombatTask, goal: { x: number, y: number }, mode: CombatPathMode) {
    const character = actor.character
    if (!character) {
      fail(actor, task, 'no_actor')
      return false
    }
    if ((task.combat_path_attempts ?? 0) >= COMBAT_PATH_MAX_ATTEMPTS) {
      fail(actor, task, task.combat_last_recovery_reason === 'physical_stuck' ? 'stuck' : 'path_timeout')
      return false
    }
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    task.combat_path_mode = mode
    task.combat_path_attempts = (task.combat_path_attempts ?? 0) + 1
    task.combat_path = null
    task.combat_path_target_position = copy_position(goal)
    const request_goal = task.combat_recovery_position ? copy_position(task.combat_recovery_position) : copy_position(goal)
    task.combat_path_request_id = actor.surface.request_path({
      bounding_box: character.prototype.collision_box,
      collision_mask: character.prototype.collision_mask,
      radius: path_goal_radius(task, mode),
      start: copy_position(character.position),
      goal: request_goal,
      force: actor.force,
      entity_to_ignore: character,
      pathfind_flags: { cache: false, no_break: true, prefer_straight_paths: false, allow_paths_through_own_entities: false },
    })
    task.combat_path_requested_tick = game.tick
    task.combat_path_next_retry_tick = undefined
    task.combat_path_last_progress_tick = game.tick
    task.combat_path_last_waypoint_distance = undefined
    reset_combat_physical_progress(actor, task)
    log(`[AUTORIO] Combat ${mode} path requested id=${task.combat_path_request_id} attempt=${task.combat_path_attempts} from ${serpent.line(character.position)} toward ${serpent.line(request_goal)}${task.combat_recovery_position ? ' (recovery)' : ''}`)
    return true
  }

  function retry_combat_path(actor: ControlledActor, task: CombatTask, goal: { x: number, y: number }, mode: CombatPathMode, exhausted_code: CombatCode, reason: string) {
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    task.combat_path = null
    task.combat_path_request_id = undefined
    task.combat_path_requested_tick = undefined
    task.combat_path_next_retry_tick = undefined
    task.combat_path_last_waypoint_distance = undefined
    task.combat_path_last_progress_tick = game.tick
    task.combat_last_recovery_reason = reason
    if ((task.combat_path_attempts ?? 0) >= COMBAT_PATH_MAX_ATTEMPTS) {
      if (!task.combat_last_spatial_observation) maybe_prepare_combat_escape(actor, task, goal, reason)
      fail(actor, task, exhausted_code)
      return false
    }
    maybe_prepare_combat_escape(actor, task, goal, reason)
    return request_combat_path(actor, task, goal, mode)
  }

  function active_path_goal(task: CombatTask) {
    if (task.combat_path_mode === 'approach') {
      const target = task.target
      return target && is_alive(target) ? target.position : undefined
    }
    if (task.combat_path_mode === 'retreat') return task.last_turret_position ?? task.combat_path_target_position
    return undefined
  }

  function finish_escape_and_repath(actor: ControlledActor, task: CombatTask, goal: { x: number, y: number }, mode: CombatPathMode) {
    task.combat_recovery_position = undefined
    task.combat_recovery_stage = 'repath'
    task.combat_path = null
    task.combat_path_request_id = undefined
    task.combat_path_requested_tick = undefined
    task.combat_path_next_retry_tick = undefined
    task.combat_path_last_waypoint_distance = undefined
    task.combat_path_last_progress_tick = game.tick
    reset_combat_physical_progress(actor, task)
    return request_combat_path(actor, task, goal, mode)
  }

  function on_path_finished(event: OnScriptPathRequestFinishedEvent) {
    const task = manager.player_state().parameters_attack_nearest_enemy as CombatTask | undefined
    if (!task || manager.player_state().task_state !== TaskStates.ATTACKING) return
    if (task.combat_path_request_id === undefined || event.id !== task.combat_path_request_id) return
    const actor = get_actor()
    if (!actor || !identity_matches(actor, task)) return
    const goal = active_path_goal(task)
    if (!goal || !task.combat_path_mode) {
      clear_combat_path(task, true)
      return
    }
    task.combat_path_request_id = undefined
    task.combat_path_requested_tick = undefined
    if (event.try_again_later || !event.path || event.path.length === 0) {
      task.combat_last_recovery_reason = event.try_again_later ? 'path_busy' : 'unreachable'
      if ((task.combat_path_attempts ?? 0) >= COMBAT_PATH_MAX_ATTEMPTS) {
        if (!task.combat_last_spatial_observation) maybe_prepare_combat_escape(actor, task, goal, task.combat_last_recovery_reason)
        fail(actor, task, 'path_unreachable')
        return
      }
      maybe_prepare_combat_escape(actor, task, goal, task.combat_last_recovery_reason)
      task.combat_path_next_retry_tick = game.tick + COMBAT_PATH_RETRY_DELAY_TICKS
      log(`[AUTORIO] Combat ${task.combat_path_mode} path unavailable on attempt ${task.combat_path_attempts ?? 0}; retry scheduled`)
      return
    }
    task.combat_path = event.path
    task.combat_path_last_progress_tick = game.tick
    task.combat_path_last_waypoint_distance = distance(actor.position, event.path[0].position)
    reset_combat_physical_progress(actor, task)
  }

  function follow_combat_path(actor: ControlledActor, task: CombatTask, goal: { x: number, y: number }, mode: CombatPathMode) {
    if (!supports_combat_path_runtime(actor)) {
      clear_combat_path(task, true)
      walk_toward(actor, goal)
      return true
    }
    if (path_goal_changed(task, goal, mode)) clear_combat_path(task, true)
    if (mode === 'retreat' && distance(actor.position, goal) <= COMBAT_PATH_RETREAT_GOAL_RADIUS) {
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      clear_combat_path(task, true)
      return true
    }
    if (task.combat_recovery_position && distance(actor.position, task.combat_recovery_position) <= COMBAT_RECOVERY_REACHED_DISTANCE) {
      return finish_escape_and_repath(actor, task, goal, mode)
    }
    if (task.combat_path_request_id !== undefined) {
      const requested_tick = task.combat_path_requested_tick ?? game.tick
      if (game.tick - requested_tick > COMBAT_PATH_REQUEST_TIMEOUT_TICKS) retry_combat_path(actor, task, goal, mode, 'path_timeout', 'request_timeout')
      return true
    }
    if (task.combat_path_next_retry_tick !== undefined) {
      if (game.tick >= task.combat_path_next_retry_tick) request_combat_path(actor, task, goal, mode)
      return true
    }
    const path = task.combat_path
    if (!path || path.length === 0) return request_combat_path(actor, task, goal, mode)
    const next_position = path[0].position
    const waypoint_distance = distance(actor.position, next_position)
    if (waypoint_distance <= COMBAT_PATH_WAYPOINT_DISTANCE) {
      path.shift()
      task.combat_path_last_progress_tick = game.tick
      task.combat_path_last_waypoint_distance = path.length > 0 ? distance(actor.position, path[0].position) : undefined
      reset_combat_physical_progress(actor, task)
      if (path.length === 0) {
        if (task.combat_recovery_position) return finish_escape_and_repath(actor, task, goal, mode)
        return request_combat_path(actor, task, goal, mode)
      }
      return true
    }
    const best = task.combat_path_last_waypoint_distance
    if (best === undefined || waypoint_distance <= best - COMBAT_PATH_PROGRESS_DISTANCE) {
      task.combat_path_last_waypoint_distance = waypoint_distance
      task.combat_path_last_progress_tick = game.tick
    }
    if (physical_path_stuck(actor, task)) {
      retry_combat_path(actor, task, goal, mode, 'stuck', 'physical_stuck')
      return true
    }
    if (game.tick - (task.combat_path_last_progress_tick ?? game.tick) > COMBAT_PATH_STUCK_TICKS) {
      retry_combat_path(actor, task, goal, mode, 'stuck', 'waypoint_stuck')
      return true
    }
    walk_toward(actor, next_position)
    return true
  }

  function stable_retreat_goal(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (task.last_turret_position) return task.last_turret_position
    if (task.combat_path_mode === 'retreat' && task.combat_path_target_position) return task.combat_path_target_position
    return retreat_position(actor, target)
  }

  function shoot_while_retreating(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    actor.update_selected_entity(target.position)
    actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
    const retreat_goal = stable_retreat_goal(actor, task, target)
    if (supports_mobile_combat_path(actor, task)) follow_combat_path(actor, task, retreat_goal, 'retreat')
    else walk_toward(actor, retreat_goal)
    task.last_progress_tick = game.tick
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state().parameters_attack_nearest_enemy as CombatTask | undefined
    if (!task || manager.player_state().task_state !== TaskStates.ATTACKING) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }
    if (!task.target && !acquire(actor, task)) return
    if (is_alive(task.target)) preempt_static_target_for_mobile_threat(actor, task)
    const target = task.target
    if (!is_alive(target)) {
      target_destroyed(actor, task)
      return
    }
    if (!target) return
    const character = actor.character
    if (!character || !has_selected_weapon_and_ammo(character)) {
      fail(actor, task, 'no_weapon_or_ammo')
      return
    }
    const started_tick = task.started_tick ?? game.tick
    const max_ticks = task.combat_mode === 'clear_area' ? MAX_CLEAR_AREA_TICKS : MAX_SINGLE_COMBAT_TICKS
    if (game.tick - started_tick > max_ticks) {
      fail(actor, task, 'timeout')
      return
    }
    const can_shoot = character.can_shoot(target, target.position)
    const current_distance = distance(actor.position, target.position)
    const previous_distance = task.last_distance ?? current_distance
    if (current_distance + DISTANCE_PROGRESS_EPSILON < previous_distance) {
      task.last_distance = current_distance
      task.last_progress_tick = game.tick
    }

    if (health_ratio(character) <= LOW_HEALTH_RATIO) {
      if (task.last_turret_position) {
        if (can_shoot) shoot_while_retreating(actor, task, target)
        else {
          stop_actor_combat(actor)
          follow_combat_path(actor, task, task.last_turret_position, 'retreat')
        }
        return
      }
      fail(actor, task, 'low_health')
      return
    }

    if (task.combat_mode === 'clear_area') place_support_turret(actor, task, target)

    if (can_shoot) {
      if (is_static_enemy(target)) clear_combat_path(task, false)
      actor.update_selected_entity(target.position)
      actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
      task.last_progress_tick = game.tick
      if (target.type === 'unit' && current_distance <= KITE_DISTANCE) {
        shoot_while_retreating(actor, task, target)
      }
      else if (is_static_enemy(target)) {
        actor.set_walking_state({ walking: false, direction: defines.direction.north })
      }
      else {
        const retreat_goal = stable_retreat_goal(actor, task, target)
        if (supports_mobile_combat_path(actor, task)) follow_combat_path(actor, task, retreat_goal, 'retreat')
        else walk_toward(actor, retreat_goal)
      }
      return
    }

    stop_actor_combat(actor)
    if (target.type === 'unit' && !supports_mobile_combat_path(actor, task)) {
      clear_combat_path(task, true)
      if (game.tick - (task.last_progress_tick ?? started_tick) > LEGACY_DIRECT_STUCK_TICKS) {
        fail(actor, task, 'stuck')
        return
      }
      if (current_distance <= PANIC_DISTANCE) walk_toward(actor, stable_retreat_goal(actor, task, target))
      else walk_toward(actor, target.position)
      return
    }
    if (target.type === 'unit' && current_distance <= PANIC_DISTANCE) {
      follow_combat_path(actor, task, stable_retreat_goal(actor, task, target), 'retreat')
      return
    }
    follow_combat_path(actor, task, target.position, 'approach')
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state().parameters_attack_nearest_enemy as CombatTask | undefined
    const target = task?.target
    return {
      task_active: manager.player_state().task_state === TaskStates.ATTACKING,
      actor: actor?.status_snapshot(),
      mode: task?.combat_mode,
      origin_position: task?.origin_position,
      targets_destroyed: task?.targets_destroyed ?? 0,
      turrets_placed: task?.turrets_placed ?? 0,
      initial_static_threats: task?.initial_static_threats ?? 0,
      support_turret_budget: task?.support_turret_budget ?? 0,
      support_stage_started: task?.support_stage_started ?? false,
      last_turret_position: task?.last_turret_position,
      last_turret_unit_number: task?.last_turret_unit_number,
      turret_ammo_name: task?.turret_ammo_name,
      last_turret_ammo_loaded: task?.last_turret_ammo_loaded,
      last_turret_placement_plan: task?.last_turret_placement_plan,
      path: task
        ? {
            mode: task.combat_path_mode,
            request_id: task.combat_path_request_id,
            attempts: task.combat_path_attempts ?? 0,
            waypoints_remaining: task.combat_path?.length ?? 0,
            retry_at_tick: task.combat_path_next_retry_tick,
            target_position: task.combat_path_target_position,
            last_progress_tick: task.combat_path_last_progress_tick,
            last_physical_progress_tick: task.combat_last_physical_progress_tick,
            recovery_position: task.combat_recovery_position,
            recovery_stage: task.combat_recovery_stage,
            last_recovery_reason: task.combat_last_recovery_reason,
            spatial_observation: task.combat_last_spatial_observation,
          }
        : undefined,
      target: target && target.valid
        ? {
            name: target.name,
            type: target.type,
            unit_number: target.unit_number,
            position: target.position,
            health: target.health,
            distance: actor ? distance(actor.position, target.position) : undefined,
          }
        : undefined,
      last_result: storage.airi_last_combat_result,
    }
  }

  return { submit, submit_clear, tick, on_path_finished, status }
}
