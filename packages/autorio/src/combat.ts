import type { LuaEntity, LuaInventory, LuaItemStack, OnScriptPathRequestFinishedEvent } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersAttackNearestEnemy } from './types'
import { plan_placement, select_navigation_escape_point } from './construction_planning'
import { entity_interaction_reach } from './interaction_range'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

// Tuning constants live in one table: new_combat_controller captures each
// module-level local as an upvalue, and LuaJIT allows at most 60 per function.
const COMBAT = {
  MAX_SEARCH_RADIUS: 256,
  MAX_SINGLE_COMBAT_TICKS: 60 * 60,
  MAX_CLEAR_AREA_TICKS: 10 * 60 * 60,
  COMBAT_PATH_STUCK_TICKS: 3 * 60,
  LEGACY_DIRECT_STUCK_TICKS: 10 * 60,
  COMBAT_PHYSICAL_STUCK_TICKS: 90,
  COMBAT_PHYSICAL_SAMPLE_TICKS: 30,
  COMBAT_PHYSICAL_PROGRESS_DISTANCE: 0.12,
  DISTANCE_PROGRESS_EPSILON: 0.25,
  MOBILE_THREAT_PRIORITY_RADIUS: 28,
  LOCAL_SAFETY_WINDOW_TICKS: 120,
  KITE_DISTANCE: 12,
  PANIC_DISTANCE: 7,
  LOW_HEALTH_RATIO: 0.35,
  TURRET_DANGER_DISTANCE: 10,
  TURRET_STAGING_DISTANCE: 24,
  TURRET_MIN_ADVANCE_DISTANCE: 6,
  TURRET_FRONTLINE_ADVANCE_DISTANCE: 6,
  TURRET_MAX_ADVANCE_DISTANCE: 8,
  TURRET_FRONTLINE_REAR_DISTANCE: 2.5,
  TURRET_ACTOR_CLEARANCE: 2.5,
  TURRET_TARGET_SAFETY_MARGIN: 0.5,
  TURRET_COVER_MARGIN: 2,
  TURRET_PLACEMENT_SEARCH_RADIUS: 3,
  TURRET_PLACEMENT_CANDIDATES: 6,
  TURRET_LOAD_COUNT: 20,
  SUPPORT_THREAT_PER_TURRET: 4,
  MAX_SUPPORT_TURRETS_PER_STAGE: 8,
  TURRET_AMMO_PRIORITY: ['uranium-rounds-magazine', 'piercing-rounds-magazine', 'firearm-magazine'],
  WORM_THREAT_SCAN_MULTIPLIER: 2,
  WORM_NAMES: ['small-worm-turret', 'medium-worm-turret', 'big-worm-turret', 'behemoth-worm-turret'],
  COMBAT_PATH_MAX_ATTEMPTS: 4,
  COMBAT_PATH_REQUEST_TIMEOUT_TICKS: 15 * 60,
  COMBAT_PATH_RETRY_DELAY_TICKS: 30,
  COMBAT_PATH_APPROACH_GOAL_RADIUS: 8,
  COMBAT_PATH_CHASE_GOAL_RADIUS: 2.5,
  COMBAT_PATH_RETREAT_GOAL_RADIUS: 1.5,
  COMBAT_PATH_RECOVERY_GOAL_RADIUS: 0.5,
  COMBAT_PATH_WAYPOINT_DISTANCE: 0.5,
  COMBAT_PATH_PROGRESS_DISTANCE: 0.25,
  COMBAT_PATH_TARGET_REPATH_DISTANCE: 2,
  COMBAT_RECOVERY_REACHED_DISTANCE: 0.75,
}

type CombatPathMode = 'approach' | 'retreat'
type CombatPhase = 'engage' | 'safety' | 'cleanup'
type CombatSafetyGoal = 'cleanup' | 'resume'
type CombatCode = 'started' | 'target_destroyed' | 'area_cleared' | 'no_actor' | 'invalid_radius'
  | 'no_target' | 'no_weapon_or_ammo' | 'actor_changed' | 'low_health' | 'stuck' | 'timeout'
  | 'path_unreachable' | 'path_timeout'

type CombatTask = PlayerParametersAttackNearestEnemy & {
  combat_phase?: CombatPhase
  combat_safety_goal?: CombatSafetyGoal
  local_safe_since_tick?: number
  encounter_owned_turrets?: LuaEntity[]
  encounter_static_target?: LuaEntity
  cleanup_target_unit_number?: number
  combat_recovery_position?: { x: number, y: number }
  combat_recovery_stage?: 'escape' | 'repath'
  combat_last_recovery_reason?: string
  combat_last_spatial_observation?: unknown
  combat_physical_sample_position?: { x: number, y: number }
  combat_physical_sample_tick?: number
  combat_last_physical_progress_tick?: number
  last_turret_placement_plan?: unknown
  initial_threat_score?: number
  support_stage_anchor_position?: { x: number, y: number }
  support_stage_start_turret_count?: number
  support_stage_target_turret_count?: number
  support_stage_batch_size?: number
  support_pressure_preemptions?: number
}

interface PersistentCombatSupportRegistry {
  actor_id: number
  actor_kind: string
  force_index: number
  turrets: LuaEntity[]
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
  initial_threat_score?: number
  support_turret_budget?: number
  support_stage_started?: boolean
  support_stage_batch_size?: number
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
  airi_owned_combat_support?: PersistentCombatSupportRegistry
}

function copy_position(position: { x: number, y: number }) {
  return { x: position.x, y: position.y }
}

function support_registry_matches(owner_actor_id?: number, owner_actor_kind?: string, owner_force_index?: number) {
  if (owner_actor_id === undefined || owner_actor_kind === undefined || owner_force_index === undefined) return false
  const registry = storage.airi_owned_combat_support
  return registry !== undefined
    && registry.actor_id === owner_actor_id
    && registry.actor_kind === owner_actor_kind
    && registry.force_index === owner_force_index
}

function registered_support_turrets(owner_actor_id?: number, owner_actor_kind?: string, owner_force_index?: number) {
  const registry = storage.airi_owned_combat_support
  if (!registry || !support_registry_matches(owner_actor_id, owner_actor_kind, owner_force_index)) return []
  const live = registry.turrets.filter(entity => entity.valid)
  if (live.length === 0) storage.airi_owned_combat_support = undefined
  else registry.turrets = live
  return live
}

function sync_support_registry(task: CombatTask, turrets: LuaEntity[]) {
  if (task.combat_mode !== 'clear_area'
    || task.owner_actor_id === undefined
    || task.owner_actor_kind === undefined
    || task.owner_force_index === undefined) return
  const live = turrets.filter(entity => entity.valid)
  if (live.length === 0) {
    if (support_registry_matches(task.owner_actor_id, task.owner_actor_kind, task.owner_force_index)) {
      storage.airi_owned_combat_support = undefined
    }
    return
  }
  storage.airi_owned_combat_support = {
    actor_id: task.owner_actor_id,
    actor_kind: task.owner_actor_kind,
    force_index: task.owner_force_index,
    turrets: live,
  }
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
    if (candidate <= COMBAT.MOBILE_THREAT_PRIORITY_RADIUS && candidate < mobile_distance) {
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
    && radius <= COMBAT.MAX_SEARCH_RADIUS
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

function selected_weapon_range(character: LuaEntity) {
  const factorioIndex = character.selected_gun_index
  const guns = character.get_inventory(defines.inventory.character_guns)
  if (!factorioIndex || !guns) return undefined
  const gun = guns[factorioIndex - 1]
  const range = gun?.valid_for_read === true ? gun.prototype?.attack_parameters?.range : undefined
  return typeof range === 'number' && range > 0 ? range : undefined
}

function gun_turret_range() {
  const range = typeof prototypes !== 'undefined' ? prototypes.entity['gun-turret']?.turret_range : undefined
  return typeof range === 'number' && range > 0 ? range : 18
}

function support_placement_target_range(actor: ControlledActor) {
  const turret_range = gun_turret_range()
  const weapon_range = actor.character ? selected_weapon_range(actor.character) : undefined
  if (weapon_range === undefined) return turret_range
  return math.min(turret_range, math.max(1, weapon_range - COMBAT.TURRET_FRONTLINE_REAR_DISTANCE))
}

function is_alive(entity: LuaEntity | null | undefined) {
  return !!entity && entity.valid && !(entity.health !== undefined && entity.health !== null && entity.health <= 0)
}

function is_static_enemy(entity: LuaEntity) {
  return entity.type === 'unit-spawner' || entity.type === 'turret'
}

function is_worm_enemy(entity: LuaEntity) {
  if (entity.type !== 'turret') return false
  for (const name of COMBAT.WORM_NAMES) if (entity.name === name) return true
  return false
}

function worm_attack_range(entity?: LuaEntity, prototype_name?: string) {
  const live_range = entity ? (entity.prototype as any).attack_parameters?.range : undefined
  if (typeof live_range === 'number' && live_range > 0) return live_range
  const name = prototype_name ?? entity?.name
  if (!name || typeof prototypes === 'undefined') return undefined
  const prototype_range = (prototypes.entity[name] as any)?.attack_parameters?.range
  return typeof prototype_range === 'number' && prototype_range > 0 ? prototype_range : undefined
}

function worm_threat_radius(entity?: LuaEntity, prototype_name?: string) {
  const range = worm_attack_range(entity, prototype_name)
  return range === undefined ? 0 : math.min(COMBAT.MAX_SEARCH_RADIUS, range * COMBAT.WORM_THREAT_SCAN_MULTIPLIER)
}

function max_worm_threat_scan_radius() {
  let radius = 0
  for (const name of COMBAT.WORM_NAMES) radius = math.max(radius, worm_threat_radius(undefined, name))
  return radius
}

function is_ranged_mobile_enemy(entity: LuaEntity) {
  if (entity.type !== 'unit') return false
  switch (entity.name) {
    case 'small-spitter':
    case 'medium-spitter':
    case 'big-spitter':
    case 'behemoth-spitter':
      return true
    default:
      return false
  }
}

function is_support_target(entity: LuaEntity) {
  return is_static_enemy(entity) || is_ranged_mobile_enemy(entity)
}

function enemy_threat_weight(entity: LuaEntity) {
  switch (entity.name) {
    case 'small-biter':
    case 'small-spitter':
      return 1
    case 'medium-biter':
    case 'medium-spitter':
      return 2
    case 'big-biter':
    case 'big-spitter':
      return 4
    case 'behemoth-biter':
    case 'behemoth-spitter':
      return 7
    case 'small-worm-turret':
      return 2
    case 'medium-worm-turret':
      return 4
    case 'big-worm-turret':
      return 6
    case 'behemoth-worm-turret':
      return 8
    case 'biter-spawner':
    case 'spitter-spawner':
      return 4
    default:
      if (entity.type === 'unit-spawner') return 4
      if (entity.type === 'turret') return 3
      if (entity.type === 'unit') return 2
      return 1
  }
}

function support_threat_score(enemies: LuaEntity[]) {
  let score = 0
  for (const entity of enemies) if (is_alive(entity)) score += enemy_threat_weight(entity)
  return score
}

function support_turret_budget(threat_score: number) {
  if (threat_score <= 0) return 0
  return math.min(COMBAT.MAX_SUPPORT_TURRETS_PER_STAGE, math.max(1, math.ceil(threat_score / COMBAT.SUPPORT_THREAT_PER_TURRET)))
}

function support_stage_batch_size(threat_score: number) {
  if (threat_score <= 0) return 0
  if (threat_score <= 4) return 1
  if (threat_score <= 8) return 2
  if (threat_score <= 16) return 3
  if (threat_score <= 24) return 4
  if (threat_score <= 32) return 5
  if (threat_score <= 40) return 6
  if (threat_score <= 48) return 7
  return COMBAT.MAX_SUPPORT_TURRETS_PER_STAGE
}

function retreat_position(actor: ControlledActor, threat: LuaEntity) {
  const dx = actor.position.x - threat.position.x
  const dy = actor.position.y - threat.position.y
  const current_distance = math.sqrt(dx * dx + dy * dy)
  if (current_distance <= 0.001) return { x: actor.position.x - COMBAT.KITE_DISTANCE, y: actor.position.y }
  const retreat_distance = math.max(0, COMBAT.KITE_DISTANCE - current_distance)
  return {
    x: actor.position.x + dx / current_distance * retreat_distance,
    y: actor.position.y + dy / current_distance * retreat_distance,
  }
}

function selected_support_ammo(inventory: LuaInventory): { name: string, stack: LuaItemStack } | undefined {
  for (const name of COMBAT.TURRET_AMMO_PRIORITY) {
    const [stack] = inventory.find_item_stack(name)
    if (stack?.valid_for_read === true && stack.count > 0) return { name, stack }
  }
  return undefined
}

function support_resources_available(actor: ControlledActor) {
  const inventory = actor.get_main_inventory()
  if (!inventory) return false
  const [turret] = inventory.find_item_stack('gun-turret')
  return turret?.valid_for_read === true && turret.count > 0 && selected_support_ammo(inventory) !== undefined
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
    initial_threat_score: task?.initial_threat_score,
    support_turret_budget: task?.support_turret_budget,
    support_stage_started: task?.support_stage_started,
    support_stage_batch_size: task?.support_stage_batch_size,
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
    const carried_support = combat_mode === 'clear_area'
      ? registered_support_turrets(identity.actor_id, identity.kind, actor.force.index)
      : []
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
      combat_phase: 'engage',
      encounter_owned_turrets: [...carried_support],
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

  function stop_actor_cleanup(actor: ControlledActor) {
    const maybeActor = actor as ControlledActor & { set_mining_state?: ControlledActor['set_mining_state'] }
    if (typeof maybeActor.set_mining_state === 'function') maybeActor.set_mining_state({ mining: false })
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
    if (game.tick - task.combat_physical_sample_tick >= COMBAT.COMBAT_PHYSICAL_SAMPLE_TICKS) {
      if (distance(actor.position, task.combat_physical_sample_position) >= COMBAT.COMBAT_PHYSICAL_PROGRESS_DISTANCE) {
        task.combat_last_physical_progress_tick = game.tick
      }
      task.combat_physical_sample_position = copy_position(actor.position)
      task.combat_physical_sample_tick = game.tick
    }
    return game.tick - task.combat_last_physical_progress_tick > COMBAT.COMBAT_PHYSICAL_STUCK_TICKS
  }

  function fail(actor: ControlledActor, task: CombatTask, code: CombatCode) {
    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, false, false, code)
    manager.cancel_all_tasks()
    log(`[AUTORIO] [ERROR] Combat task failed: ${code}; queued operations cancelled`)
  }

  function complete_single(actor: ControlledActor, task: CombatTask) {
    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'target_destroyed')
    manager.reset_task_state()
    manager.next_task()
    log('[AUTORIO] Combat task complete: target destroyed')
  }

  function complete_area(actor: ControlledActor, task: CombatTask) {
    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    record(actor, task, true, true, 'area_cleared')
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Combat area clear: destroyed ${task.targets_destroyed ?? 0} targets, placed ${task.turrets_placed ?? 0} support turrets; stage_budget=${task.support_turret_budget ?? 0}`)
  }

  function area_enemies(actor: ControlledActor, task: CombatTask) {
    const origin = task.origin_position ?? actor.position
    return actor.surface.find_entities_filtered({ position: origin, radius: task.search_radius, force: 'enemy' })
  }

  function live_owned_turrets(task: CombatTask) {
    const owned: LuaEntity[] = []
    const add_live_unique = (entity: LuaEntity) => {
      if (!entity.valid) return
      for (const existing of owned) {
        if (existing === entity) return
        if (existing.unit_number !== undefined && entity.unit_number !== undefined && existing.unit_number === entity.unit_number) return
      }
      owned.push(entity)
    }
    for (const entity of task.encounter_owned_turrets ?? []) add_live_unique(entity)
    if (task.combat_mode === 'clear_area') {
      for (const entity of registered_support_turrets(task.owner_actor_id, task.owner_actor_kind, task.owner_force_index)) add_live_unique(entity)
    }
    task.encounter_owned_turrets = owned
    sync_support_registry(task, owned)
    return owned
  }

  function frontmost_support(task: CombatTask, target: LuaEntity) {
    let result: LuaEntity | undefined
    let best = math.huge
    for (const support of live_owned_turrets(task)) {
      const candidate = distance(support.position, target.position)
      if (candidate < best) {
        best = candidate
        result = support
      }
    }
    return result
  }

  function frontline_rear_position(task: CombatTask, target: LuaEntity) {
    const support = frontmost_support(task, target)
    if (!support) return undefined
    const away_x = support.position.x - target.position.x
    const away_y = support.position.y - target.position.y
    const magnitude = math.sqrt(away_x * away_x + away_y * away_y)
    if (magnitude <= 0.001) return undefined
    return {
      x: support.position.x + away_x / magnitude * COMBAT.TURRET_FRONTLINE_REAR_DISTANCE,
      y: support.position.y + away_y / magnitude * COMBAT.TURRET_FRONTLINE_REAR_DISTANCE,
    }
  }

  function actor_is_behind_frontline(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    const support = frontmost_support(task, target)
    if (!support) return false
    return distance(actor.position, target.position) + COMBAT.DISTANCE_PROGRESS_EPSILON >= distance(support.position, target.position)
  }

  function support_cover_goal(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    const support = nearest(actor, live_owned_turrets(task))
    if (!support) return undefined
    const turret_range = support.prototype.turret_range
    if (typeof turret_range !== 'number' || turret_range <= 0) return undefined
    const cover_radius = math.max(COMBAT.COMBAT_PATH_RETREAT_GOAL_RADIUS + 0.5, turret_range - COMBAT.TURRET_COVER_MARGIN)
    const actor_in_cover = distance(actor.position, support.position) <= cover_radius
    const desired = actor_in_cover ? retreat_position(actor, target) : copy_position(actor.position)
    const dx = desired.x - support.position.x
    const dy = desired.y - support.position.y
    const desired_distance = math.sqrt(dx * dx + dy * dy)
    if (desired_distance <= cover_radius) return desired
    if (desired_distance <= 0.001) return copy_position(support.position)
    return {
      x: support.position.x + dx / desired_distance * cover_radius,
      y: support.position.y + dy / desired_distance * cover_radius,
    }
  }

  function initialize_support_plan(task: CombatTask, enemies: LuaEntity[]) {
    if (task.combat_mode !== 'clear_area' || task.support_turret_budget !== undefined) return
    let static_threats = 0
    for (const entity of enemies) if (is_alive(entity) && is_static_enemy(entity)) static_threats++
    const threat_score = support_threat_score(enemies)
    task.initial_static_threats = static_threats
    task.initial_threat_score = threat_score
    task.support_turret_budget = support_turret_budget(threat_score)
    log(`[AUTORIO] Combat support plan: static_threats=${static_threats}, threat_score=${threat_score}, stage_budget=${task.support_turret_budget}`)
  }

  function bind_target(actor: ControlledActor, task: CombatTask, target: LuaEntity, reason: 'acquired' | 'preempted') {
    if (task.target !== target) clear_combat_path(task, true)
    if (task.combat_mode === 'clear_area' && is_support_target(target)) {
      const target_score = enemy_threat_weight(target)
      task.initial_threat_score = math.max(task.initial_threat_score ?? 0, target_score)
      task.support_turret_budget = math.max(task.support_turret_budget ?? 0, support_turret_budget(target_score))
      if (is_static_enemy(target)) task.initial_static_threats = math.max(task.initial_static_threats ?? 0, 1)
    }
    task.combat_phase = 'engage'
    task.local_safe_since_tick = undefined
    task.target = target
    if (is_static_enemy(target)) {
      if (task.encounter_static_target !== target) task.support_pressure_preemptions = 0
      task.encounter_static_target = target
    }
    task.target_name = target.name
    task.target_unit_number = target.unit_number
    task.target_initial_health = target.health ?? undefined
    task.last_progress_tick = game.tick
    task.last_distance = distance(actor.position, target.position)
    const result = record(actor, task, true, false, 'started')
    log(`[AUTORIO] Combat target ${reason}: ${result.target_name} unit=${result.target_unit_number ?? 'n/a'} mode=${task.combat_mode ?? 'single'}`)
  }

  function enter_safety(actor: ControlledActor, task: CombatTask, goal?: CombatSafetyGoal) {
    clear_combat_path(task, true)
    task.combat_phase = 'safety'
    task.combat_safety_goal = goal
    if (task.local_safe_since_tick === undefined) task.local_safe_since_tick = game.tick
    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
  }

  function nearby_mobile_threat(actor: ControlledActor, radius = COMBAT.MOBILE_THREAT_PRIORITY_RADIUS) {
    let threat: LuaEntity | undefined
    let best = math.huge
    const local_units = actor.surface.find_entities_filtered({ position: actor.position, radius, force: 'enemy', type: 'unit' })
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

  function nearby_worm_threat(actor: ControlledActor) {
    const scan_radius = max_worm_threat_scan_radius()
    if (scan_radius <= 0) return undefined
    let threat: LuaEntity | undefined
    let best = math.huge
    const local_turrets = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: scan_radius,
      force: 'enemy',
      type: 'turret',
    })
    for (const entity of local_turrets) {
      if (!is_alive(entity) || !is_worm_enemy(entity)) continue
      const candidate = distance(actor.position, entity.position)
      const awareness_radius = worm_threat_radius(entity)
      if (awareness_radius <= 0 || candidate > awareness_radius) continue
      if (candidate < best) {
        threat = entity
        best = candidate
      }
    }
    return threat
  }

  function nearby_priority_threat(actor: ControlledActor) {
    const mobile = nearby_mobile_threat(actor)
    const worm = nearby_worm_threat(actor)
    if (!mobile) return worm
    if (!worm) return mobile
    return distance(actor.position, mobile.position) <= distance(actor.position, worm.position) ? mobile : worm
  }

  function remaining_clear_target(actor: ControlledActor, task: CombatTask) {
    const priority = nearby_priority_threat(actor)
    if (priority) return priority
    const enemies = area_enemies(actor, task).filter(is_alive)
    initialize_support_plan(task, enemies)
    return preferred_target(actor, enemies)
  }

  function enter_cleanup(actor: ControlledActor, task: CombatTask) {
    clear_combat_path(task, true)
    task.combat_phase = 'cleanup'
    task.combat_safety_goal = 'cleanup'
    task.local_safe_since_tick = undefined
    task.cleanup_target_unit_number = undefined
    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
  }

  function tick_cleanup(actor: ControlledActor, task: CombatTask) {
    const remaining_target = remaining_clear_target(actor, task)
    if (remaining_target) {
      stop_actor_cleanup(actor)
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      task.combat_safety_goal = 'cleanup'
      bind_target(actor, task, remaining_target, 'preempted')
      return
    }

    const owned = live_owned_turrets(task)
    if (owned.length === 0) {
      stop_actor_cleanup(actor)
      task.cleanup_target_unit_number = undefined
      task.encounter_static_target = undefined
      task.last_turret_position = undefined
      task.last_turret_unit_number = undefined
      task.support_turret_budget = undefined
      task.support_stage_started = false
      task.support_stage_anchor_position = undefined
      task.support_stage_start_turret_count = undefined
      task.support_stage_target_turret_count = undefined
      task.support_stage_batch_size = undefined
      task.support_pressure_preemptions = undefined
      task.initial_static_threats = undefined
      task.initial_threat_score = undefined
      enter_safety(actor, task, 'resume')
      return
    }

    const turret = owned[0]
    if (task.cleanup_target_unit_number !== turret.unit_number) {
      stop_actor_cleanup(actor)
      task.cleanup_target_unit_number = turret.unit_number
    }

    stop_actor_combat(actor)
    const reach = entity_interaction_reach(actor)
    if (distance(actor.position, turret.position) > reach) {
      stop_actor_cleanup(actor)
      actor.update_selected_entity(turret.position)
      actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, turret.position) })
      return
    }

    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    actor.update_selected_entity(turret.position)
    if (!actor.get_mining_state().mining) {
      actor.set_mining_state({ mining: true, position: turret.position })
      log(`[AUTORIO] Combat cleanup mining owned support turret unit=${turret.unit_number ?? 'n/a'} at ${serpent.line(turret.position)}`)
    }
  }

  function tick_safety(actor: ControlledActor, task: CombatTask) {
    const safety_target = task.combat_safety_goal === 'cleanup'
      ? remaining_clear_target(actor, task)
      : nearby_priority_threat(actor)
    if (safety_target) {
      bind_target(actor, task, safety_target, 'preempted')
      return
    }

    stop_actor_combat(actor)
    stop_actor_cleanup(actor)
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    if (task.local_safe_since_tick === undefined) task.local_safe_since_tick = game.tick
    if (game.tick - task.local_safe_since_tick < COMBAT.LOCAL_SAFETY_WINDOW_TICKS) return

    if (task.combat_safety_goal === 'cleanup') {
      enter_cleanup(actor, task)
      tick_cleanup(actor, task)
      return
    }

    const enemies = area_enemies(actor, task).filter(is_alive)
    initialize_support_plan(task, enemies)
    const target = preferred_target(actor, enemies)
    if (task.combat_safety_goal === 'resume') {
      task.combat_safety_goal = undefined
      task.local_safe_since_tick = undefined
      if (target) bind_target(actor, task, target, 'acquired')
      else complete_area(actor, task)
      return
    }

    if (target) {
      bind_target(actor, task, target, 'acquired')
      return
    }

    complete_area(actor, task)
  }

  function acquire(actor: ControlledActor, task: CombatTask) {
    const enemies = area_enemies(actor, task).filter(is_alive)
    initialize_support_plan(task, enemies)
    const target = preferred_target(actor, enemies)
    if (!target) {
      if (task.combat_mode === 'clear_area') {
        const cleanup_goal = live_owned_turrets(task).length > 0 ? 'cleanup' : undefined
        enter_safety(actor, task, cleanup_goal)
      }
      else fail(actor, task, 'no_target')
      return false
    }
    bind_target(actor, task, target, 'acquired')
    return true
  }

  function support_covers_target(task: CombatTask, target: LuaEntity) {
    for (const support of live_owned_turrets(task)) {
      const turret_range = support.prototype.turret_range
      if (typeof turret_range !== 'number' || turret_range <= 0) continue
      if (distance(support.position, target.position) <= turret_range) return true
    }
    return false
  }

  function mobile_threat_requires_preemption(actor: ControlledActor, task: CombatTask, threat: LuaEntity) {
    const character = actor.character
    if (!character || health_ratio(character) <= COMBAT.LOW_HEALTH_RATIO) return true
    if (distance(actor.position, threat.position) <= COMBAT.PANIC_DISTANCE) return true
    return !support_covers_target(task, threat)
  }

  function preempt_static_target_for_worm_threat(actor: ControlledActor, task: CombatTask) {
    const target = task.target
    if (task.combat_mode !== 'clear_area' || !target || !is_alive(target) || !is_static_enemy(target) || is_worm_enemy(target)) return false
    const threat = nearby_worm_threat(actor)
    if (!threat || threat === target || support_covers_target(task, threat)) return false
    bind_target(actor, task, threat, 'preempted')
    stop_actor_combat(actor)
    log(`[AUTORIO] Combat worm threat preempted current target at distance=${distance(actor.position, threat.position)} scan_radius=${worm_threat_radius(threat)} attack_range=${worm_attack_range(threat) ?? 'unknown'}`)
    return true
  }

  function preempt_static_target_for_panic_threat(actor: ControlledActor, task: CombatTask) {
    const target = task.target
    if (task.combat_mode !== 'clear_area' || !target || !is_alive(target) || !is_static_enemy(target)) return false
    const threat = nearby_mobile_threat(actor, COMBAT.PANIC_DISTANCE)
    if (!threat || threat === target) return false
    if (!task.support_stage_started) task.support_pressure_preemptions = (task.support_pressure_preemptions ?? 0) + 1
    bind_target(actor, task, threat, 'preempted')
    stop_actor_combat(actor)
    return true
  }

  function preempt_static_target_for_mobile_threat(actor: ControlledActor, task: CombatTask) {
    const target = task.target
    if (task.combat_mode !== 'clear_area' || !target || !is_alive(target) || !is_static_enemy(target)) return false
    const threat = nearby_mobile_threat(actor, COMBAT.TURRET_DANGER_DISTANCE)
    if (!threat || threat === target) return false
    if (!mobile_threat_requires_preemption(actor, task, threat)) return false
    if (!task.support_stage_started) task.support_pressure_preemptions = (task.support_pressure_preemptions ?? 0) + 1
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
    const encounter_static = task.encounter_static_target
    const encounter_static_destroyed = encounter_static !== undefined && !is_alive(encounter_static)
    clear_bound_target(task)
    stop_actor_combat(actor)

    // A mobile preemption belongs to the current static encounter. Once that
    // mobile target is gone, resume the locked nest/worm before considering
    // unrelated targets elsewhere in the clear area.
    if (encounter_static && is_alive(encounter_static)) {
      bind_target(actor, task, encounter_static, 'acquired')
      return
    }

    // The static encounter is actually over. Before recovering temporary support,
    // finish every remaining clear-area hostile, plus any worm/mobile threat
    // already inside the extended danger scan.
    const remaining_target = remaining_clear_target(actor, task)
    if (remaining_target) {
      bind_target(actor, task, remaining_target, 'acquired')
      return
    }

    const owned_turrets = live_owned_turrets(task)
    if (task.combat_safety_goal === 'cleanup' || (owned_turrets.length > 0 && encounter_static_destroyed)) {
      enter_safety(actor, task, 'cleanup')
      return
    }
    acquire(actor, task)
  }

  function begin_support_stage(actor: ControlledActor, task: CombatTask, stage_budget: number, owned_count: number) {
    const batch_size = support_stage_batch_size(task.initial_threat_score ?? stage_budget * COMBAT.SUPPORT_THREAT_PER_TURRET)
    if (batch_size <= 0) return false
    task.support_stage_anchor_position = copy_position(actor.position)
    task.support_stage_start_turret_count = owned_count
    task.support_stage_batch_size = batch_size
    task.support_stage_target_turret_count = owned_count + batch_size
    log(`[AUTORIO] Combat support stage opened at ${serpent.line(actor.position)}: batch=${batch_size}, deployed=${owned_count}, stage_budget=${stage_budget}`)
    return true
  }

  function should_place_support(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (task.combat_mode !== 'clear_area' || !is_support_target(target)) return false
    if (target.type === 'unit' && distance(actor.position, target.position) <= COMBAT.PANIC_DISTANCE) return false
    const stage_budget = task.support_turret_budget ?? 0
    const owned_count = live_owned_turrets(task).length
    if (stage_budget <= 0 || !support_resources_available(actor)) return false
    // Support is the frontline, not a rear battery. Ranged mobile pressure may
    // establish the first line immediately; panic-range threats still preempt first.
    if (!task.support_stage_started) {
      const origin = task.origin_position ?? actor.position
      const advance_distance = distance(actor.position, origin)
      const advanced = advance_distance >= COMBAT.TURRET_MIN_ADVANCE_DISTANCE
      const pressure_override = is_ranged_mobile_enemy(target) || (task.support_pressure_preemptions ?? 0) >= 2
      const staged = distance(actor.position, target.position) <= COMBAT.TURRET_STAGING_DISTANCE
      if ((!advanced && !pressure_override) || !staged) return false
      task.support_stage_started = true
      if (!begin_support_stage(actor, task, stage_budget, owned_count)) return false
      log(`[AUTORIO] Combat support staging established after advancing ${advance_distance} tiles; ranged_pressure=${is_ranged_mobile_enemy(target)}; pressure_preemptions=${task.support_pressure_preemptions ?? 0}; stage_budget=${stage_budget}`)
    }
    else {
      const stage_target = task.support_stage_target_turret_count ?? owned_count
      if (owned_count >= stage_target) {
        // A completed support stage does not need geometric spacing from the next
        // one. Open another stage whenever the live frontline no longer reaches
        // the active nest / swarm and inventory can establish fresh coverage.
        if (support_covers_target(task, target)) return false
        if (!begin_support_stage(actor, task, stage_budget, owned_count)) return false
      }
    }

    return owned_count < (task.support_stage_target_turret_count ?? owned_count)
  }

  function support_anchor(actor: ControlledActor, target: LuaEntity, _turret_index: number, advance_distance = COMBAT.TURRET_FRONTLINE_ADVANCE_DISTANCE) {
    let toward_x = target.position.x - actor.position.x
    let toward_y = target.position.y - actor.position.y
    const magnitude = math.sqrt(toward_x * toward_x + toward_y * toward_y)
    if (magnitude > 0.001) {
      toward_x /= magnitude
      toward_y /= magnitude
    }
    else {
      toward_x = 1
      toward_y = 0
    }
    // Do not impose artificial spacing between support turrets. The placement
    // planner and Factorio collision rules decide how tightly a frontline can be
    // packed; combat only cares that the position is safe and reaches the target.
    return {
      x: actor.position.x + toward_x * advance_distance,
      y: actor.position.y + toward_y * advance_distance,
    }
  }

  function support_staging_goal(actor: ControlledActor, target: LuaEntity) {
    const actor_target_distance = distance(actor.position, target.position)
    if (actor_target_distance <= 0.001) return copy_position(actor.position)
    const desired_distance = math.max(
      COMBAT.TURRET_ACTOR_CLEARANCE + 1,
      support_placement_target_range(actor) + COMBAT.TURRET_FRONTLINE_ADVANCE_DISTANCE - 1,
    )
    const away_x = (actor.position.x - target.position.x) / actor_target_distance
    const away_y = (actor.position.y - target.position.y) / actor_target_distance
    return {
      x: target.position.x + away_x * desired_distance,
      y: target.position.y + away_y * desired_distance,
    }
  }

  function planned_support_position(actor: ControlledActor, task: CombatTask, target: LuaEntity, anchor: { x: number, y: number }) {
    const target_range = support_placement_target_range(actor)
    if (!actor.surface.can_place_entity) {
      const position = actor.surface.find_non_colliding_position('gun-turret', anchor, 2, 0.25, false)
      if (!position) return undefined
      if (distance(position, actor.position) < COMBAT.TURRET_ACTOR_CLEARANCE) return undefined
      if (distance(position, target.position) > target_range) return undefined
      return position
    }
    const placement = plan_placement(actor, {
      entity_name: 'gun-turret',
      position: anchor,
      side: 'any',
      search_radius: COMBAT.TURRET_PLACEMENT_SEARCH_RADIUS,
      max_candidates: COMBAT.TURRET_PLACEMENT_CANDIDATES,
    })
    task.last_turret_placement_plan = placement
    if (!placement.ok || !('candidates' in placement)) return undefined
    const actor_target_distance = distance(actor.position, target.position)
    let fallback: { x: number, y: number } | undefined
    for (const candidate of placement.candidates ?? []) {
      const position = candidate.position as { x: number, y: number }
      if (distance(position, actor.position) < COMBAT.TURRET_ACTOR_CLEARANCE) continue
      const target_distance = distance(position, target.position)
      if (target_distance > target_range) continue
      if (target_distance + COMBAT.TURRET_TARGET_SAFETY_MARGIN < actor_target_distance) return position
      if (!fallback) fallback = position
    }
    return fallback
  }

  function place_support_turret(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (!should_place_support(actor, task, target)) return false
    const inventory = actor.get_main_inventory()
    if (!inventory) return false
    const [turret_stack] = inventory.find_item_stack('gun-turret')
    if (!turret_stack || !turret_stack.valid_for_read || turret_stack.count <= 0) return false
    const ammo = selected_support_ammo(inventory)
    if (!ammo) return false
    const owned_count = live_owned_turrets(task).length
    const stage_start = task.support_stage_start_turret_count ?? owned_count
    const turret_index = math.max(0, owned_count - stage_start)
    const total_placements = (task.turrets_placed ?? 0) + 1
    const anchor_distances = [
      COMBAT.TURRET_FRONTLINE_ADVANCE_DISTANCE,
      math.max(COMBAT.TURRET_ACTOR_CLEARANCE + 1, COMBAT.TURRET_FRONTLINE_ADVANCE_DISTANCE - 1.5),
      COMBAT.TURRET_ACTOR_CLEARANCE + 0.75,
    ]
    // Staging can stop short of its planned distance. When even the fixed
    // advance anchor is outside turret range, its whole search ring is too, so
    // first try an anchor one tile inside range, within local build reach.
    const actor_target_distance = distance(actor.position, target.position)
    const target_range = support_placement_target_range(actor)
    const in_range_advance = actor_target_distance - (target_range - 1)
    if (actor_target_distance - anchor_distances[0] > target_range && in_range_advance <= COMBAT.TURRET_MAX_ADVANCE_DISTANCE)
      anchor_distances.unshift(in_range_advance)
    let anchor = support_anchor(actor, target, turret_index, anchor_distances[0])
    let position: { x: number, y: number } | undefined
    for (const advance_distance of anchor_distances) {
      anchor = support_anchor(actor, target, turret_index, advance_distance)
      position = planned_support_position(actor, task, target, anchor)
      if (position) break
    }
    if (!position) {
      const plan = task.last_turret_placement_plan as { ok?: boolean, candidates?: Array<{ position: unknown }>, rejected?: Array<{ position: unknown, reason: unknown }> } | undefined
      const plan_summary = {
        ok: plan?.ok,
        candidates: (plan?.candidates ?? []).map(candidate => candidate.position),
        rejected: (plan?.rejected ?? []).slice(0, 4).map(rejection => ({ position: rejection.position, reason: rejection.reason })),
        target_range: support_placement_target_range(actor),
      }
      log(`[AUTORIO] No safe shared-planner support turret position near frontline anchors; actor=${serpent.line(actor.position)} target=${serpent.line(target.position)} last_plan=${serpent.line(plan_summary)}`)
      return false
    }
    if (distance(position, actor.position) < COMBAT.TURRET_ACTOR_CLEARANCE) {
      log(`[AUTORIO] Refusing support turret position ${serpent.line(position)} inside actor clearance ${COMBAT.TURRET_ACTOR_CLEARANCE}`)
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
    const requested_ammo = math.min(COMBAT.TURRET_LOAD_COUNT, ammo.stack.count)
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
    task.turrets_placed = total_placements
    task.last_turret_position = copy_position(position)
    task.last_turret_unit_number = turret.unit_number
    task.turret_ammo_name = ammo.name
    task.last_turret_ammo_loaded = inserted_ammo
    ;(task.encounter_owned_turrets ??= []).push(turret)
    const stage_target = task.support_stage_target_turret_count ?? live_owned_turrets(task).length
    const stage_start_count = task.support_stage_start_turret_count ?? 0
    log(`[AUTORIO] Combat support turret ${live_owned_turrets(task).length - stage_start_count}/${task.support_stage_batch_size ?? 0} in current stage placed at ${serpent.line(position)} unit=${turret.unit_number ?? 'n/a'} with ${inserted_ammo} ${ammo.name}; stage_target=${stage_target}; total_placements=${task.turrets_placed}`)
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
      || distance(task.combat_path_target_position, goal) >= COMBAT.COMBAT_PATH_TARGET_REPATH_DISTANCE
  }

  function path_goal_radius(task: CombatTask, mode: CombatPathMode) {
    if (task.combat_recovery_position) return COMBAT.COMBAT_PATH_RECOVERY_GOAL_RADIUS
    if (mode === 'retreat') return COMBAT.COMBAT_PATH_RETREAT_GOAL_RADIUS
    return task.target && is_alive(task.target) && is_static_enemy(task.target)
      ? COMBAT.COMBAT_PATH_APPROACH_GOAL_RADIUS
      : COMBAT.COMBAT_PATH_CHASE_GOAL_RADIUS
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
    if ((task.combat_path_attempts ?? 0) >= COMBAT.COMBAT_PATH_MAX_ATTEMPTS) {
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
    if ((task.combat_path_attempts ?? 0) >= COMBAT.COMBAT_PATH_MAX_ATTEMPTS) {
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
    if (task.combat_path_mode === 'retreat') return task.combat_path_target_position
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
    const task = manager.player_state.parameters_attack_nearest_enemy as CombatTask | undefined
    if (!task || manager.player_state.task_state !== TaskStates.ATTACKING) return
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
      if ((task.combat_path_attempts ?? 0) >= COMBAT.COMBAT_PATH_MAX_ATTEMPTS) {
        if (!task.combat_last_spatial_observation) maybe_prepare_combat_escape(actor, task, goal, task.combat_last_recovery_reason)
        fail(actor, task, 'path_unreachable')
        return
      }
      maybe_prepare_combat_escape(actor, task, goal, task.combat_last_recovery_reason)
      task.combat_path_next_retry_tick = game.tick + COMBAT.COMBAT_PATH_RETRY_DELAY_TICKS
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
    if (mode === 'retreat' && distance(actor.position, goal) <= COMBAT.COMBAT_PATH_RETREAT_GOAL_RADIUS) {
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      clear_combat_path(task, true)
      return true
    }
    if (task.combat_recovery_position && distance(actor.position, task.combat_recovery_position) <= COMBAT.COMBAT_RECOVERY_REACHED_DISTANCE) {
      return finish_escape_and_repath(actor, task, goal, mode)
    }
    if (task.combat_path_request_id !== undefined) {
      const requested_tick = task.combat_path_requested_tick ?? game.tick
      if (game.tick - requested_tick > COMBAT.COMBAT_PATH_REQUEST_TIMEOUT_TICKS) retry_combat_path(actor, task, goal, mode, 'path_timeout', 'request_timeout')
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
    if (waypoint_distance <= COMBAT.COMBAT_PATH_WAYPOINT_DISTANCE) {
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
    if (best === undefined || waypoint_distance <= best - COMBAT.COMBAT_PATH_PROGRESS_DISTANCE) {
      task.combat_path_last_waypoint_distance = waypoint_distance
      task.combat_path_last_progress_tick = game.tick
    }
    if (physical_path_stuck(actor, task)) {
      retry_combat_path(actor, task, goal, mode, 'stuck', 'physical_stuck')
      return true
    }
    if (game.tick - (task.combat_path_last_progress_tick ?? game.tick) > COMBAT.COMBAT_PATH_STUCK_TICKS) {
      retry_combat_path(actor, task, goal, mode, 'stuck', 'waypoint_stuck')
      return true
    }
    walk_toward(actor, next_position)
    return true
  }

  function stable_retreat_goal(actor: ControlledActor, task: CombatTask, target: LuaEntity) {
    if (task.combat_path_mode === 'retreat' && task.combat_path_target_position
      && distance(task.combat_path_target_position, target.position) > distance(actor.position, target.position) + COMBAT.DISTANCE_PROGRESS_EPSILON) {
      return task.combat_path_target_position
    }
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

  function hold_behind_support_frontline(actor: ControlledActor, task: CombatTask, target: LuaEntity, can_shoot: boolean) {
    const rear = frontline_rear_position(task, target)
    if (!rear) return false
    const behind_frontline = actor_is_behind_frontline(actor, task, target)
    if (can_shoot) {
      actor.update_selected_entity(target.position)
      actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
    }
    else {
      stop_actor_combat(actor)
    }
    if (!behind_frontline) {
      follow_combat_path(actor, task, rear, 'retreat')
    }
    else if (!can_shoot && distance(actor.position, rear) > COMBAT.COMBAT_PATH_RETREAT_GOAL_RADIUS) {
      // Being behind the turret line is not a reason to freeze outside weapon
      // range. Advance only as far as the protected rear position.
      follow_combat_path(actor, task, rear, 'retreat')
    }
    else {
      clear_combat_path(task, true)
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
    }
    task.last_progress_tick = game.tick
    return true
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_attack_nearest_enemy as CombatTask | undefined
    if (!task || manager.player_state.task_state !== TaskStates.ATTACKING) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }
    if (task.combat_mode === 'clear_area' && task.combat_phase === 'safety') {
      tick_safety(actor, task)
      return
    }
    if (task.combat_mode === 'clear_area' && task.combat_phase === 'cleanup') {
      tick_cleanup(actor, task)
      return
    }
    if (!task.target && !acquire(actor, task)) return
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
    const max_ticks = task.combat_mode === 'clear_area' ? COMBAT.MAX_CLEAR_AREA_TICKS : COMBAT.MAX_SINGLE_COMBAT_TICKS
    if (game.tick - started_tick > max_ticks) {
      fail(actor, task, 'timeout')
      return
    }
    const can_shoot = character.can_shoot(target, target.position)
    const current_distance = distance(actor.position, target.position)
    const previous_distance = task.last_distance ?? current_distance
    if (current_distance + COMBAT.DISTANCE_PROGRESS_EPSILON < previous_distance) {
      task.last_distance = current_distance
      task.last_progress_tick = game.tick
    }

    if (health_ratio(character) <= COMBAT.LOW_HEALTH_RATIO) {
      const cover_goal = support_cover_goal(actor, task, target)
      if (cover_goal) {
        if (can_shoot) {
          actor.update_selected_entity(target.position)
          actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
        }
        else {
          stop_actor_combat(actor)
        }
        follow_combat_path(actor, task, cover_goal, 'retreat')
        task.last_progress_tick = game.tick
        return
      }
      fail(actor, task, 'low_health')
      return
    }

    if (preempt_static_target_for_panic_threat(actor, task)) return
    if (preempt_static_target_for_worm_threat(actor, task)) return

    if (task.combat_mode === 'clear_area' && place_support_turret(actor, task, target)) {
      stop_actor_combat(actor)
      actor.set_walking_state({ walking: false, direction: defines.direction.north })
      task.last_progress_tick = game.tick
      return
    }

    // Give a ready support placement one tick of priority over non-panic mobile
    // reinforcement. Panic threats preempt above; unsupported pressure still
    // preempts here instead of being ignored.
    if (preempt_static_target_for_mobile_threat(actor, task)) return

    if (target.type === 'unit' && current_distance <= COMBAT.PANIC_DISTANCE) {
      if (can_shoot) shoot_while_retreating(actor, task, target)
      else if (supports_mobile_combat_path(actor, task)) follow_combat_path(actor, task, stable_retreat_goal(actor, task, target), 'retreat')
      else walk_toward(actor, stable_retreat_goal(actor, task, target))
      return
    }

    if (task.combat_mode === 'clear_area' && (is_ranged_mobile_enemy(target) || target.type === 'turret')
      && hold_behind_support_frontline(actor, task, target, can_shoot)) return

    if (can_shoot) {
      if (is_static_enemy(target)) clear_combat_path(task, false)
      actor.update_selected_entity(target.position)
      actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
      task.last_progress_tick = game.tick
      if (target.type === 'unit' && current_distance <= COMBAT.KITE_DISTANCE) {
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
      if (game.tick - (task.last_progress_tick ?? started_tick) > COMBAT.LEGACY_DIRECT_STUCK_TICKS) {
        fail(actor, task, 'stuck')
        return
      }
      if (current_distance <= COMBAT.PANIC_DISTANCE) walk_toward(actor, stable_retreat_goal(actor, task, target))
      else walk_toward(actor, target.position)
      return
    }
    if (target.type === 'unit' && current_distance <= COMBAT.PANIC_DISTANCE) {
      follow_combat_path(actor, task, stable_retreat_goal(actor, task, target), 'retreat')
      return
    }
    if (task.combat_mode === 'clear_area' && is_static_enemy(target)
      && (support_resources_available(actor) || target.type === 'turret')) {
      const support_available = support_resources_available(actor)
      const covered = support_covers_target(task, target)
      if (support_available && !covered) {
        const staging_goal = support_staging_goal(actor, target)
        const staging_distance = distance(staging_goal, target.position)
        if (current_distance > staging_distance + COMBAT.DISTANCE_PROGRESS_EPSILON) {
          // Old support must not pin AIRI in the rear when it no longer reaches
          // the active static target. Advance only far enough to make a new
          // frontline placement feasible, then retry support on the next tick.
          // Use the tighter retreat-path tolerance for this precise staging
          // waypoint. Static-target approach paths use an 8-tile goal radius,
          // which can report an empty path when the staging point is only a few
          // tiles away and then burn through retries without moving.
          follow_combat_path(actor, task, staging_goal, 'retreat')
          return
        }
        if (!is_worm_enemy(target)) {
          // If local collision still prevents a new nest-facing support point,
          // keep making combat progress instead of oscillating behind the stale
          // line forever. Worms retain the more conservative ranged behavior.
          follow_combat_path(actor, task, target.position, 'approach')
          return
        }
      }
      const frontline_goal = frontline_rear_position(task, target)
      if (frontline_goal) {
        follow_combat_path(actor, task, frontline_goal, 'retreat')
        return
      }
    }
    follow_combat_path(actor, task, target.position, 'approach')
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state.parameters_attack_nearest_enemy as CombatTask | undefined
    const target = task?.target
    const encounter_owned_turrets = task?.encounter_owned_turrets?.filter(entity => entity.valid) ?? []
    return {
      task_active: manager.player_state.task_state === TaskStates.ATTACKING,
      actor: actor?.status_snapshot(),
      mode: task?.combat_mode,
      combat_phase: task?.combat_phase,
      combat_safety_goal: task?.combat_safety_goal,
      local_safe_since_tick: task?.local_safe_since_tick,
      encounter_owned_turret_count: encounter_owned_turrets.length,
      encounter_owned_turret_unit_numbers: encounter_owned_turrets.map(entity => entity.unit_number),
      cleanup_target_unit_number: task?.cleanup_target_unit_number,
      origin_position: task?.origin_position,
      targets_destroyed: task?.targets_destroyed ?? 0,
      turrets_placed: task?.turrets_placed ?? 0,
      initial_static_threats: task?.initial_static_threats ?? 0,
      initial_threat_score: task?.initial_threat_score ?? 0,
      support_turret_budget: task?.support_turret_budget ?? 0,
      support_stage_started: task?.support_stage_started ?? false,
      support_stage_anchor_position: task?.support_stage_anchor_position,
      support_stage_start_turret_count: task?.support_stage_start_turret_count,
      support_stage_target_turret_count: task?.support_stage_target_turret_count,
      support_stage_batch_size: task?.support_stage_batch_size ?? 0,
      support_pressure_preemptions: task?.support_pressure_preemptions ?? 0,
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
