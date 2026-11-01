import type { ControlledActor } from './actors/types'
import { direction_towards } from './utils/direction'
import { distance } from './utils/math'

const MIN_FOLLOW_DISTANCE = 1
const MAX_FOLLOW_DISTANCE = 64
const FOLLOW_HYSTERESIS = 1.5
const FOLLOW_REPATH_COOLDOWN_TICKS = 2 * 60
const BLOCKED_RETRY_TARGET_MOVEMENT = 6

type FollowCode = 'following' | 'holding' | 'stopped' | 'no_actor' | 'invalid_player' | 'player_unavailable' | 'different_surface' | 'navigation_blocked'
type FollowRuntimeState = 'following' | 'holding' | 'paused' | 'blocked' | 'stopped'
type NavigateToPlayer = (player_name: string, reach_distance: number) => [boolean, string]

interface FollowState {
  active: boolean
  state: FollowRuntimeState
  player_name?: string
  follow_distance?: number
  clear_obstacles?: boolean
  code: FollowCode
  updated_tick: number
  last_navigation_tick?: number
  blocked_reason?: string
  blocked_target_position?: { x: number, y: number }
}

type NavigationStatus = {
  task_active?: boolean
  state?: string
  player_name?: string
  persistent_follow?: boolean
  target?: { position?: { x: number, y: number }, distance?: number }
  path?: {
    request_id?: number
    attempts?: number
    waypoints_remaining?: number
    last_progress_tick?: number
    physical_last_progress_tick?: number
    stuck_for_ticks?: number
    physical_stuck_for_ticks?: number
    last_repath_tick?: number
    recovery_stage?: string
    last_recovery_reason?: string
  }
  blocked_reason?: string
  last_result?: { code?: string, tick?: number, player_name?: string, blocked_reason?: string }
}

declare const storage: {
  sgluna_follow_state?: FollowState
}

function current_state(): FollowState {
  if (!storage.sgluna_follow_state) {
    storage.sgluna_follow_state = { active: false, state: 'stopped', code: 'stopped', updated_tick: game.tick }
  }
  const state = storage.sgluna_follow_state
  if (!state.state) state.state = state.active ? 'paused' : 'stopped'
  if (state.clear_obstacles === undefined) state.clear_obstacles = true
  return state
}

function stop_walking(actor: ControlledActor | undefined) {
  if (!actor || !actor.is_valid || !actor.character) return
  actor.set_walking_state({ walking: false, direction: defines.direction.north })
}

function navigation_status(): NavigationStatus | undefined {
  const interfaces = remote.interfaces
  if (!interfaces || interfaces.autorio_navigation === undefined || typeof remote.call !== 'function') return undefined
  return remote.call('autorio_navigation', 'status') as NavigationStatus
}

function copy_position(position: { x: number, y: number } | undefined) {
  return position ? { x: position.x, y: position.y } : undefined
}

function moved_materially(a: { x: number, y: number } | undefined, b: { x: number, y: number } | undefined) {
  if (!a || !b) return false
  return distance(a, b) >= BLOCKED_RETRY_TARGET_MOVEMENT
}

function navigation_blocked(nav: NavigationStatus | undefined, player_name: string) {
  if (!nav || nav.task_active) return undefined
  const last = nav.last_result
  if (!last || last.player_name !== player_name) return undefined
  if (['unreachable', 'path_timeout', 'stuck', 'path_busy'].indexOf(last.code ?? '') < 0) return undefined
  return last.blocked_reason ?? last.code
}

export function new_follow_controller(get_actor: () => ControlledActor | undefined, navigate_to_player?: NavigateToPlayer) {
  function submit(player_name: string, follow_distance: number = 4, clear_obstacles: boolean = true): [boolean, string] {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character) {
      storage.sgluna_follow_state = { active: false, state: 'stopped', code: 'no_actor', clear_obstacles, updated_tick: game.tick }
      return [false, 'No controlled actor']
    }
    if (typeof player_name !== 'string' || player_name.length === 0) {
      storage.sgluna_follow_state = { active: false, state: 'stopped', code: 'invalid_player', clear_obstacles, updated_tick: game.tick }
      return [false, 'player_name is required']
    }

    const bounded_distance = math.max(MIN_FOLLOW_DISTANCE, math.min(MAX_FOLLOW_DISTANCE, follow_distance || 4))
    const player = game.get_player(player_name)
    if (!player || !player.valid) {
      storage.sgluna_follow_state = { active: false, state: 'stopped', player_name, follow_distance: bounded_distance, clear_obstacles, code: 'invalid_player', updated_tick: game.tick }
      return [false, 'Player does not exist']
    }

    storage.sgluna_follow_state = {
      active: true,
      state: (!player.connected || !player.character || player.surface.index !== actor.surface.index) ? 'paused' : 'following',
      player_name,
      follow_distance: bounded_distance,
      clear_obstacles,
      code: (!player.connected || !player.character)
        ? 'player_unavailable'
        : player.surface.index !== actor.surface.index
          ? 'different_surface'
          : 'following',
      updated_tick: game.tick,
    }

    if (!player.connected || !player.character) {
      stop_walking(actor)
      return [true, `Follow armed for ${player_name}; waiting for the player to be available`]
    }
    if (player.surface.index !== actor.surface.index) {
      stop_walking(actor)
      return [true, `Follow armed for ${player_name}; waiting for the player to return to this surface`]
    }
    return [true, `Following ${player_name}`]
  }

  function stop(): [boolean, string] {
    const actor = get_actor()
    stop_walking(actor)
    const previous = current_state()
    storage.sgluna_follow_state = {
      active: false,
      state: 'stopped',
      player_name: previous.player_name,
      follow_distance: previous.follow_distance,
      clear_obstacles: previous.clear_obstacles,
      code: 'stopped',
      updated_tick: game.tick,
    }
    return [true, 'Follow mode stopped']
  }

  function suspend(actor: ControlledActor) {
    const state = current_state()
    if (!state.active) return
    stop_walking(actor)
  }

  function tick(actor: ControlledActor) {
    const state = current_state()
    if (!state.active || !state.player_name) return

    const player = game.get_player(state.player_name)
    if (!player || !player.valid) {
      stop_walking(actor)
      state.active = false
      state.state = 'stopped'
      state.code = 'invalid_player'
      state.updated_tick = game.tick
      return
    }

    if (!player.connected || !player.character) {
      stop_walking(actor)
      state.state = 'paused'
      state.code = 'player_unavailable'
      state.updated_tick = game.tick
      return
    }
    if (player.surface.index !== actor.surface.index) {
      stop_walking(actor)
      state.state = 'paused'
      state.code = 'different_surface'
      state.updated_tick = game.tick
      return
    }

    const follow_distance = state.follow_distance ?? 4
    const current_distance = distance(actor.position, player.position)
    if (current_distance <= follow_distance) {
      stop_walking(actor)
      state.state = 'holding'
      state.code = 'holding'
      state.blocked_reason = undefined
      state.blocked_target_position = undefined
      state.updated_tick = game.tick
      return
    }

    if (state.state === 'holding' && current_distance <= follow_distance + FOLLOW_HYSTERESIS) {
      stop_walking(actor)
      return
    }

    const nav = navigation_status()
    if (nav?.task_active && nav.player_name === state.player_name) {
      state.state = 'following'
      state.code = 'following'
      state.blocked_reason = undefined
      state.updated_tick = game.tick
      return
    }

    const blocked_reason = navigation_blocked(nav, state.player_name)
    if (blocked_reason) {
      const blocked_at = state.blocked_target_position
      if (!blocked_at || !moved_materially(blocked_at, player.position)) {
        stop_walking(actor)
        state.state = 'blocked'
        state.code = 'navigation_blocked'
        state.blocked_reason = blocked_reason
        state.blocked_target_position = blocked_at ?? copy_position(player.position)
        state.updated_tick = game.tick
        return
      }
      state.blocked_reason = undefined
      state.blocked_target_position = undefined
    }

    if (navigate_to_player) {
      stop_walking(actor)
      if (state.last_navigation_tick !== undefined && game.tick - state.last_navigation_tick < FOLLOW_REPATH_COOLDOWN_TICKS) return
      const [accepted] = navigate_to_player(state.player_name, follow_distance)
      state.last_navigation_tick = game.tick
      state.state = accepted ? 'following' : 'blocked'
      state.code = accepted ? 'following' : 'navigation_blocked'
      state.blocked_reason = accepted ? undefined : 'navigation_admission_rejected'
      state.blocked_target_position = accepted ? undefined : copy_position(player.position)
      state.updated_tick = game.tick
      return
    }

    actor.set_walking_state({ walking: true, direction: direction_towards(actor.position, player.position) })
    state.state = 'following'
    state.code = 'following'
    state.updated_tick = game.tick
  }

  function status() {
    const state = current_state()
    const actor = get_actor()
    const player = state.player_name ? game.get_player(state.player_name) : undefined
    const nav = navigation_status()
    const current_distance = actor && player?.valid && player.character && player.surface.index === actor.surface.index
      ? distance(actor.position, player.position)
      : undefined
    const live_navigation = state.active && nav?.task_active === true && nav.player_name === state.player_name
    const holding = state.active && state.state === 'holding' && current_distance !== undefined && current_distance <= (state.follow_distance ?? 4) + FOLLOW_HYSTERESIS
    const fallback_following = state.active && nav === undefined && state.state === 'following'
    const healthy = live_navigation || holding || fallback_following
    const last_progress_tick = nav?.path?.physical_last_progress_tick ?? nav?.path?.last_progress_tick ?? (holding ? game.tick : undefined)
    return {
      ...state,
      target_player: state.player_name,
      desired_distance: state.follow_distance,
      healthy,
      controller_live: live_navigation || holding || fallback_following,
      current_distance,
      last_position: actor ? { x: actor.position.x, y: actor.position.y } : undefined,
      last_progress_tick,
      stuck_for_ticks: nav?.path?.physical_stuck_for_ticks ?? nav?.path?.stuck_for_ticks,
      path_request_id: nav?.path?.request_id,
      path_attempts: nav?.path?.attempts,
      waypoints_remaining: nav?.path?.waypoints_remaining,
      last_repath_tick: nav?.path?.last_repath_tick,
      last_failure: state.blocked_reason ?? nav?.blocked_reason ?? nav?.path?.last_recovery_reason,
      navigation: nav
        ? {
            active: nav.task_active === true,
            state: nav.state,
            player_name: nav.player_name,
            persistent_follow: nav.persistent_follow,
            blocked_reason: nav.blocked_reason,
            path: nav.path,
          }
        : undefined,
      actor: actor?.status_snapshot(),
      player: player && player.valid
        ? {
            name: player.name,
            connected: player.connected,
            has_character: !!player.character,
            surface: player.surface.name,
            position: player.character ? player.position : undefined,
            distance: current_distance,
          }
        : undefined,
    }
  }

  return { submit, stop, suspend, tick, status }
}
