import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { PlayerParametersWalkToEntity } from './types'
import { distance } from './utils/math'
import { find_world_entities } from './npc_vision'

const SAMPLE_TICKS = 30
const STUCK_TICKS = 90
const PROGRESS_DISTANCE = 0.12
const SCAN_RADIUS = 4
const CLEAR_TIMEOUT_TICKS = 15 * 60

type NavigationTask = PlayerParametersWalkToEntity & {
  persistent_follow?: boolean
  recovery_stage?: string
  last_recovery_reason?: string
  physical_sample_position?: { x: number, y: number }
  physical_sample_tick?: number
  last_physical_progress_tick?: number
}

interface ObstacleRecoveryState {
  signature: string
  clear_obstacles: boolean
  sample_position: { x: number, y: number }
  sample_tick: number
  last_progress_tick: number
  clearing_target?: LuaEntity
  clearing_started_tick?: number
}

declare const storage: {
  sgluna_navigation_clear_obstacles?: boolean
  sgluna_navigation_obstacle_recovery?: ObstacleRecoveryState
  sgluna_follow_state?: {
    active?: boolean
    clear_obstacles?: boolean
  }
}

function copy_position(position: { x: number, y: number }) {
  return { x: position.x, y: position.y }
}

function task_signature(actor: ControlledActor, task: NavigationTask) {
  const identity = actor.status_snapshot()
  return [
    identity.actor_id ?? 0,
    task.owner_actor_id ?? 0,
    task.target_player_name ?? '',
    task.entity_name,
    task.target_unit_number ?? 0,
    task.started_tick ?? 0,
  ].join(':')
}

export function is_natural_navigation_obstacle(entity: Pick<LuaEntity, 'type' | 'name'>) {
  if (entity.type === 'tree') return true
  return entity.type === 'simple-entity' && entity.name.includes('rock')
}

function task_policy(task: NavigationTask) {
  if (task.persistent_follow && storage.sgluna_follow_state?.active === true) {
    return storage.sgluna_follow_state.clear_obstacles !== false
  }
  return storage.sgluna_navigation_clear_obstacles !== false
}

function state_for(actor: ControlledActor, task: NavigationTask) {
  const signature = task_signature(actor, task)
  let state = storage.sgluna_navigation_obstacle_recovery
  if (!state || state.signature !== signature) {
    state = {
      signature,
      clear_obstacles: task_policy(task),
      sample_position: copy_position(actor.position),
      sample_tick: game.tick,
      last_progress_tick: game.tick,
    }
    storage.sgluna_navigation_obstacle_recovery = state
  }
  return state
}

function nearest_natural_obstacle(actor: ControlledActor) {
  const candidates = find_world_entities(actor.surface, {
    position: actor.position,
    radius: SCAN_RADIUS,
  }).filter(entity => entity.valid && is_natural_navigation_obstacle(entity))

  let nearest: LuaEntity | undefined
  let best = math.huge
  for (const entity of candidates) {
    const candidate = distance(actor.position, entity.position)
    if (candidate < best) {
      best = candidate
      nearest = entity
    }
  }
  return nearest
}

function reset_navigation_progress(actor: ControlledActor, task: NavigationTask, state: ObstacleRecoveryState) {
  const position = copy_position(actor.position)
  state.sample_position = position
  state.sample_tick = game.tick
  state.last_progress_tick = game.tick
  task.physical_sample_position = position
  task.physical_sample_tick = game.tick
  task.last_physical_progress_tick = game.tick
  task.last_progress_tick = game.tick
  task.last_waypoint_distance = undefined
}

function stop_clearing(actor: ControlledActor, task: NavigationTask, state: ObstacleRecoveryState, reason: string) {
  actor.set_mining_state({ mining: false })
  state.clearing_target = undefined
  state.clearing_started_tick = undefined
  task.recovery_stage = 'repath'
  task.last_recovery_reason = reason
  reset_navigation_progress(actor, task, state)
}

function start_clearing(actor: ControlledActor, task: NavigationTask, state: ObstacleRecoveryState, reason: string) {
  if (!state.clear_obstacles || state.clearing_target?.valid) return false
  const obstacle = nearest_natural_obstacle(actor)
  if (!obstacle) return false

  actor.set_walking_state({ walking: false, direction: defines.direction.north })
  actor.update_selected_entity(obstacle.position)
  actor.set_mining_state({ mining: true, position: obstacle.position })
  state.clearing_target = obstacle
  state.clearing_started_tick = game.tick
  task.recovery_stage = 'clearing_obstacle'
  task.last_recovery_reason = reason
  log(`[AUTORIO] Navigation clearing natural obstacle ${obstacle.name} at ${serpent.line(obstacle.position)} after ${reason}`)
  return true
}

function clearing_tick(actor: ControlledActor, task: NavigationTask, state: ObstacleRecoveryState) {
  const obstacle = state.clearing_target
  if (!obstacle) return false

  actor.set_walking_state({ walking: false, direction: defines.direction.north })
  if (!obstacle.valid) {
    stop_clearing(actor, task, state, 'natural_obstacle_cleared')
    log('[AUTORIO] Navigation natural obstacle cleared; resuming path')
    return false
  }

  if (game.tick - (state.clearing_started_tick ?? game.tick) >= CLEAR_TIMEOUT_TICKS) {
    stop_clearing(actor, task, state, 'natural_obstacle_clear_timeout')
    log(`[AUTORIO] Navigation obstacle clear timed out for ${obstacle.name}; returning to bounded path recovery`)
    return false
  }

  const mining = actor.get_mining_state()
  if (!mining.mining) {
    actor.update_selected_entity(obstacle.position)
    actor.set_mining_state({ mining: true, position: obstacle.position })
  }
  return true
}

function physically_stuck(actor: ControlledActor, state: ObstacleRecoveryState) {
  if (game.tick - state.sample_tick < SAMPLE_TICKS) return false
  const moved = distance(state.sample_position, actor.position)
  state.sample_position = copy_position(actor.position)
  state.sample_tick = game.tick
  if (moved >= PROGRESS_DISTANCE) {
    state.last_progress_tick = game.tick
    return false
  }
  return game.tick - state.last_progress_tick >= STUCK_TICKS
}

export function new_navigation_obstacle_recovery() {
  function set_enabled(enabled: boolean) {
    storage.sgluna_navigation_clear_obstacles = enabled !== false
    if (enabled === false && storage.sgluna_navigation_obstacle_recovery) {
      storage.sgluna_navigation_obstacle_recovery.clear_obstacles = false
    }
    return storage.sgluna_navigation_clear_obstacles
  }

  function enabled() {
    return storage.sgluna_navigation_clear_obstacles !== false
  }

  function suspend(actor: ControlledActor | undefined) {
    const state = storage.sgluna_navigation_obstacle_recovery
    if (state?.clearing_target && actor?.is_valid) actor.set_mining_state({ mining: false })
    storage.sgluna_navigation_obstacle_recovery = undefined
  }

  function tick(actor: ControlledActor, raw_task: PlayerParametersWalkToEntity | undefined) {
    if (!raw_task || !actor.is_valid || !actor.character) return false
    const task = raw_task as NavigationTask
    const state = state_for(actor, task)

    if (clearing_tick(actor, task, state)) return true
    if (!state.clear_obstacles) return false

    if (task.last_recovery_reason === 'unreachable' && task.next_retry_tick !== undefined) {
      if (start_clearing(actor, task, state, 'unreachable')) return true
    }

    if (task.path && task.path.length > 0 && physically_stuck(actor, state)) {
      if (start_clearing(actor, task, state, 'physical_stuck')) return true
    }
    return false
  }

  function status() {
    const state = storage.sgluna_navigation_obstacle_recovery
    const target = state?.clearing_target
    return {
      clear_obstacles: enabled(),
      clearing: !!target?.valid,
      obstacle: target?.valid
        ? { name: target.name, type: target.type, position: target.position }
        : undefined,
      started_tick: state?.clearing_started_tick,
    }
  }

  return { set_enabled, enabled, suspend, tick, status }
}
