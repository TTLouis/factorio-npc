import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { distance } from './utils/math'

const DEFAULT_DEFENSE_RADIUS = 24

type DefenseCode = 'armed' | 'disabled' | 'idle' | 'engaging' | 'target_out_of_range' | 'no_actor' | 'no_weapon_or_ammo'

interface DefenseState {
  enabled: boolean
  radius: number
  code: DefenseCode
  updated_tick: number
  target_name?: string
  target_unit_number?: number
  target_position?: { x: number, y: number }
  target_distance?: number
}

declare const storage: {
  sgluna_defense_state?: DefenseState
}

function current_state(): DefenseState {
  if (!storage.sgluna_defense_state) {
    storage.sgluna_defense_state = {
      enabled: true,
      radius: DEFAULT_DEFENSE_RADIUS,
      code: 'armed',
      updated_tick: game.tick,
    }
  }
  return storage.sgluna_defense_state
}

function clear_target(state: DefenseState) {
  state.target_name = undefined
  state.target_unit_number = undefined
  state.target_position = undefined
  state.target_distance = undefined
}

function stop_shooting(actor: ControlledActor | undefined) {
  if (!actor || !actor.is_valid || !actor.character) return
  actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
}

function has_selected_weapon_and_ammo(character: LuaEntity) {
  const factorioIndex = character.selected_gun_index
  const guns = character.get_inventory(defines.inventory.character_guns)
  const ammo = character.get_inventory(defines.inventory.character_ammo)
  if (!factorioIndex || !guns || !ammo) return false
  const index = factorioIndex - 1
  return guns[index]?.valid_for_read === true && ammo[index]?.valid_for_read === true
}

export function new_defense_controller(get_actor: () => ControlledActor | undefined) {
  function set_enabled(enabled: boolean): [boolean, string] {
    const state = current_state()
    state.enabled = enabled
    state.code = enabled ? 'armed' : 'disabled'
    state.updated_tick = game.tick
    clear_target(state)
    if (!enabled) stop_shooting(get_actor())
    return [true, enabled ? 'Auto-defense enabled' : 'Auto-defense disabled']
  }

  function suspend(actor?: ControlledActor) {
    stop_shooting(actor ?? get_actor())
    const state = current_state()
    if (state.enabled && state.code === 'engaging') {
      state.code = 'armed'
      state.updated_tick = game.tick
      clear_target(state)
    }
  }

  function tick(actor: ControlledActor) {
    const state = current_state()
    if (!state.enabled) {
      stop_shooting(actor)
      state.code = 'disabled'
      state.updated_tick = game.tick
      clear_target(state)
      return false
    }

    const identity = actor.status_snapshot()
    const character = actor.character
    if (!actor.is_valid || !character || identity.kind !== 'standalone_character') {
      stop_shooting(actor)
      state.code = 'no_actor'
      state.updated_tick = game.tick
      clear_target(state)
      return false
    }

    const target = actor.surface.find_nearest_enemy({
      position: actor.position,
      max_distance: state.radius,
      force: actor.force,
    })
    if (!target || !target.valid) {
      stop_shooting(actor)
      state.code = 'idle'
      state.updated_tick = game.tick
      clear_target(state)
      return false
    }

    state.target_name = target.name
    state.target_unit_number = target.unit_number
    state.target_position = { x: target.position.x, y: target.position.y }
    state.target_distance = distance(actor.position, target.position)
    state.updated_tick = game.tick

    if (!has_selected_weapon_and_ammo(character)) {
      stop_shooting(actor)
      state.code = 'no_weapon_or_ammo'
      return false
    }

    if (!character.can_shoot(target, target.position)) {
      stop_shooting(actor)
      state.code = 'target_out_of_range'
      return false
    }

    actor.update_selected_entity(target.position)
    actor.set_shooting_state({ state: defines.shooting.shooting_selected, position: target.position })
    state.code = 'engaging'
    return true
  }

  function status() {
    return {
      ...current_state(),
      actor: get_actor()?.status_snapshot(),
    }
  }

  return { set_enabled, suspend, tick, status }
}
