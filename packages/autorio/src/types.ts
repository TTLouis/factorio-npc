import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, PathfinderWaypoint } from 'factorio:runtime'

export enum TaskStates {
  IDLE = 'idle',
  WALKING_TO_ENTITY = 'walking_to_entity',
  MINING = 'mining',
  HARVESTING = 'harvesting',
  CLEARING_AREA = 'clearing_area',
  PLACING = 'placing',
  ROTATING = 'rotating',
  CRAFTING = 'crafting',
  RESEARCHING = 'researching',
  WALKING_DIRECT = 'walking_direct',
  MOVING_ITEMS = 'moving_items',
  SETTING_RECIPE = 'setting_recipe',
  LAUNCHING_ROCKET = 'launching_rocket',
  ATTACKING = 'attacking',
  WAITING = 'waiting',
}

export interface PlayerParametersWalkToEntity {
  type: TaskStates.WALKING_TO_ENTITY
  /** Prototype name for nearest-name and entity-bound navigation. Position targets leave this empty. */
  entity_name: string
  search_radius: number
  /** Explicit target semantics so observability can distinguish nearest-name, exact identity, coordinate, and player movement. */
  target_kind?: 'nearest_entity' | 'exact_entity' | 'position' | 'player'
  /** Fixed world coordinate selected by the caller. Unlike target_position, this remains authoritative across repaths. */
  requested_position?: MapPositionStruct
  /** When set, navigation binds this exact connected player's character instead
   * of searching for a generic character prototype. */
  target_player_name?: string
  /** Arrival distance for this navigation task. */
  reach_distance?: number
  /** True when this leg was spawned by the persistent follow controller. Routine
   * follow legs stay out of player-facing batch chatter while failures still surface. */
  persistent_follow?: boolean
  path: PathfinderWaypoint[] | null
  path_drawn: boolean
  path_index: number
  calculating_path: boolean
  target_position: MapPositionStruct | null
  target?: LuaEntity | null
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  target_unit_number?: number
  path_request_id?: number
  path_requested_tick?: number
  path_attempts?: number
  next_retry_tick?: number
  started_tick?: number
  last_progress_tick?: number
  /** Best observed distance to the current waypoint. Environmental motion such
   * as transport belts must not count as progress unless it actually reduces
   * this distance. */
  last_waypoint_distance?: number
}

export interface PlayerParametersWalkingDirect {
  type: TaskStates.WALKING_DIRECT
  target_position: MapPositionStruct | null
}

export interface PlayerParametersMineEntity {
  type: TaskStates.MINING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  /** Prototype name for nearest-name or exact-position mining. Exact-identity mining resolves the name at runtime. */
  entity_name?: string
  /** Stable Factorio identity when the caller selected one exact mineable entity. */
  target_unit_number?: number
  /** Exact requested resource position. Unlike `position`, this survives mining/reposition recovery. */
  requested_position?: MapPositionStruct
  /** Remaining mining cycles requested by the operation. */
  count: number
  /** Original requested cycle count, retained while count is decremented. */
  requested_count?: number
  /** Current resolved target position while a mining cycle is active. */
  position?: MapPositionStruct
  /** Resource amount seen on the previous tick for standalone-NPC polling. */
  last_target_amount?: number
  /** Consecutive engine-rejected mining starts for bounded approach recovery. */
  mining_rejects?: number
  /** True after this target was handed to Factorio; a stopped state on a later tick is a rejected start. */
  mining_attempted?: boolean
}

export interface PlayerParametersHarvestProduct {
  type: TaskStates.HARVESTING
  product_name: string
  requested_count: number
  search_radius: number
  source_names: string[]
  inventory_count_before: number
  verified_gain: number
  target?: LuaEntity | null
  target_name?: string
  target_position?: MapPositionStruct
  mining_rejects?: number
  mining_attempted?: boolean
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
}

export interface PlayerParametersClearConstructionArea {
  type: TaskStates.CLEARING_AREA
  center: MapPositionStruct
  width: number
  height: number
  cleared_count: number
  target?: LuaEntity | null
  target_name?: string
  target_position?: MapPositionStruct
  mining_rejects?: number
  mining_attempted?: boolean
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
}

export interface PlayerParametersPlaceEntity {
  type: TaskStates.PLACING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  entity_name: string
  /** Exact requested placement position. When omitted the runtime finds a local valid position. */
  position?: MapPositionStruct
  /** Factorio direction value (0..15) for precise placement. */
  direction?: number
}

export interface PlayerParametersRotateEntity {
  type: TaskStates.ROTATING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  /** Stable Factorio identity of the exact placed entity to rotate. */
  target_unit_number: number
  /** Factorio rotate direction: false clockwise, true counter-clockwise. */
  reverse: boolean
}

export interface PlayerParametersMoveItems {
  type: TaskStates.MOVING_ITEMS
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  item_name: string
  /** Entity prototype target for legacy nearby entity transfers. */
  entity_name?: string
  /** Stable Factorio entity identity for an exact entity transfer. */
  target_unit_number?: number
  /** Exact connected player target for player transfers. */
  player_name?: string
  max_count: number
  to_entity?: boolean
  to_player?: boolean
}

export interface PlayerParametersSetRecipe {
  type: TaskStates.SETTING_RECIPE
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  /** Stable Factorio entity identity. Recipe configuration never falls back to a same-name machine. */
  target_unit_number: number
  /** Exact Factorio recipe prototype name to set on the target assembling machine. */
  recipe_name: string
}

export interface PlayerParametersLaunchRocket {
  type: TaskStates.LAUNCHING_ROCKET
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  /** Stable Factorio identity of the exact rocket silo. Never falls back to another silo. */
  target_unit_number: number
  /** Force rockets_launched when the launch was ordered; set once the order succeeds. */
  rockets_launched_before?: number
  /** Tick the launch was ordered; bounds the wait for the launch to register. */
  launch_ordered_tick?: number
}

export interface PlayerParametersCraftItem {
  type: TaskStates.CRAFTING
  item_name: string
  count: number
  crafted: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  started?: number
  started_tick?: number
  output_count_before?: number
  expected_output_delta?: number
  owns_native_queue?: boolean
}

export interface PlayerParametersAttackNearestEnemy {
  type: TaskStates.ATTACKING
  search_radius: number
  /** One-shot preserves the original behavior; clear_area keeps reacquiring
   * enemies until the bounded origin area is clear. */
  combat_mode?: 'single' | 'clear_area'
  /** Runtime lifecycle phase for deterministic clear-area handoff and support cleanup. */
  combat_phase?: 'engage' | 'safety' | 'cleanup'
  /** What the current safety window unlocks once it remains stable. */
  combat_safety_goal?: 'cleanup' | 'resume'
  /** First tick of the current uninterrupted local-safety window. */
  local_safe_since_tick?: number
  /** Exact support-turret entities created and paid for by the current combat encounter. */
  encounter_owned_turrets?: LuaEntity[]
  origin_position?: MapPositionStruct
  target: LuaEntity | null
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  target_name?: string
  target_unit_number?: number
  target_initial_health?: number
  started_tick?: number
  last_progress_tick?: number
  last_distance?: number
  targets_destroyed?: number
  turrets_placed?: number
  /** Number of hostile spawners/worm turrets observed when an area-clear task
   * first acquires its bounded combat area. */
  initial_static_threats?: number
  /** Deterministic maximum support-turret count derived from initial_static_threats. */
  support_turret_budget?: number
  /** Becomes true only after the NPC has advanced to a safe staging distance;
   * prevents dropping a turret immediately at the task origin. */
  support_stage_started?: boolean
  last_turret_position?: MapPositionStruct
  last_turret_unit_number?: number
  turret_ammo_name?: string
  last_turret_ammo_loaded?: number
  /** Combat-owned path state. Approach paths target static nests; retreat paths
   * return to the latest known support-turret position. */
  combat_path_mode?: 'approach' | 'retreat'
  combat_path?: PathfinderWaypoint[] | null
  combat_path_request_id?: number
  combat_path_requested_tick?: number
  combat_path_attempts?: number
  combat_path_next_retry_tick?: number
  combat_path_target_position?: MapPositionStruct
  combat_path_last_progress_tick?: number
  combat_path_last_waypoint_distance?: number
}

export interface PlayerParametersResearchTechnology {
  type: TaskStates.RESEARCHING
  technology_name: string
  /** Monotonic Autorio request identifier used to correlate asynchronous native research. */
  request_id?: number
  /** Technology level observed when the request was admitted. Repeatable technologies
   * are complete only after a later native completion advances beyond this level. */
  requested_level?: number
  /** Bind deferred research submission to the requesting actor and force. */
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
}

export interface PlayerParametersWaiting {
  type: TaskStates.WAITING
  operation_id?: number
  owner_actor_id?: number
  owner_actor_kind?: string
  owner_force_index?: number
  remaining_ticks: number
  requested_ticks?: number
}

export type PlayerParameters
  = | PlayerParametersWalkToEntity
    | PlayerParametersWalkingDirect
    | PlayerParametersMineEntity
    | PlayerParametersHarvestProduct
    | PlayerParametersClearConstructionArea
    | PlayerParametersPlaceEntity
    | PlayerParametersRotateEntity
    | PlayerParametersMoveItems
    | PlayerParametersSetRecipe
    | PlayerParametersLaunchRocket
    | PlayerParametersCraftItem
    | PlayerParametersAttackNearestEnemy
    | PlayerParametersResearchTechnology
    | PlayerParametersWaiting

export interface PlayerState {
  task_state: TaskStates
  parameters_walk_to_entity?: PlayerParametersWalkToEntity
  parameters_walking_direct?: PlayerParametersWalkingDirect
  parameters_mine_entity?: PlayerParametersMineEntity
  parameters_harvest_product?: PlayerParametersHarvestProduct
  parameters_clear_construction_area?: PlayerParametersClearConstructionArea
  parameters_place_entity?: PlayerParametersPlaceEntity
  parameters_rotate_entity?: PlayerParametersRotateEntity
  parameters_move_items?: PlayerParametersMoveItems
  parameters_set_recipe?: PlayerParametersSetRecipe
  parameters_launch_rocket?: PlayerParametersLaunchRocket
  parameters_craft_item?: PlayerParametersCraftItem
  parameters_attack_nearest_enemy?: PlayerParametersAttackNearestEnemy
  parameters_research_technology?: PlayerParametersResearchTechnology
  parameters_waiting?: PlayerParametersWaiting
}
