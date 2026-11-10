import type { ControlledActor } from './actors/types'
import { find_world_entities } from './npc_vision'

// A harness-only accelerated hands-off measurement window. It is separate from
// the construction tick sprint: no operation may run while it is armed, and the
// engine restores 1x itself at the end tick or at the first safety event, even
// if the host disconnects. The interface is absent from the model tool catalog.
export const MEASUREMENT_SPRINT_VERSION = 'measurement-sprint-v1'
export const MEASUREMENT_SPRINT_LIMITS = { min_speed: 2, max_speed: 16, max_ticks: 108000, history: 16 }

export interface MeasurementLease {
  measurement_id: string
  actor_id: number
  epoch: number
  speed: number
  ticks: number
  start_tick: number
  end_tick: number
  health: number
  native_checks: number
}
interface FinishedMeasurement extends MeasurementLease { restored_tick: number, actual_ticks: number, reason: string }
interface MeasurementState { lease?: MeasurementLease, history: FinishedMeasurement[], used: Record<string, boolean> }
declare const storage: { sgluna_measurement_sprint?: MeasurementState }
function state(): MeasurementState {
  storage.sgluna_measurement_sprint ??= { history: [], used: {} }
  return storage.sgluna_measurement_sprint
}

// 8-100 characters of [A-Za-z0-9_-]; checked by character codes (no regular expressions in Lua).
function measurement_id(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 100) return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (!(c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 45 || c === 95)) return false
  }
  return true
}

interface NativeWork { task_state: string, queue_length: number, active_batch?: unknown }
interface Deployment { allowed?: boolean, actor_id?: number, epoch?: number, connected_players?: number }

export function new_measurement_sprint_guard(actor: () => ControlledActor | undefined, work: () => NativeWork,
  deployment: () => Deployment, construction_sprint: () => { speed: number, lease?: unknown, phase?: string }) {
  function status() {
    const data = state()
    return { version: MEASUREMENT_SPRINT_VERSION, tick: game.tick, speed: game.speed, limits: MEASUREMENT_SPRINT_LIMITS,
      lease: data.lease, last: data.history[data.history.length - 1] }
  }
  function finish(reason: string, expected_id?: string) {
    const data = state()
    const lease = data.lease
    if (expected_id && lease && lease.measurement_id !== expected_id) return { ok: false, reason: 'measurement_superseded', ...status() }
    game.speed = 1
    if (lease) {
      const done = { ...lease, restored_tick: game.tick, actual_ticks: game.tick - lease.start_tick, reason }
      data.history.push(done)
      while (data.history.length > MEASUREMENT_SPRINT_LIMITS.history) data.history.shift()
      data.lease = undefined
      log(`[AUTORIO] measurement_sprint.restored ${helpers.table_to_json(done)}`)
    }
    return { ok: true, ...status() }
  }
  // Any change that could make the window something other than an unattended
  // run of the built factory ends it early; the host reports the early reason.
  function refusal(lease: Pick<MeasurementLease, 'actor_id' | 'epoch' | 'health'>) {
    const current = actor()
    const character = current?.character
    if (!current?.is_valid || !character?.valid || character.unit_number !== lease.actor_id || !(character.health! > 0)) return 'actor_changed'
    const guard = deployment()
    if (guard.actor_id !== lease.actor_id || guard.epoch !== lease.epoch) return 'epoch_changed'
    if (guard.connected_players !== 0 || game.connected_players.length !== 0) return 'humans_present'
    if ((character.health ?? 0) < lease.health) return 'actor_damaged'
    if (find_world_entities(current.surface, { position: current.position, radius: 48, force: 'enemy', limit: 1 }).length > 0) return 'nearby_threat'
    const native = work()
    if (native.task_state !== 'idle' || native.queue_length !== 0 || native.active_batch) return 'native_work_started'
    return undefined
  }
  function checked(lease: Pick<MeasurementLease, 'actor_id' | 'epoch' | 'health'>) {
    try { return refusal(lease) } catch { return 'authoritative_guard_state_unreadable' }
  }
  function arm(raw: { measurement_id: string, actor_id: number, epoch: number, speed: number, ticks: number }) {
    const data = state()
    if (!raw || !measurement_id(raw.measurement_id)) return { ok: false, reason: 'invalid_measurement_id', ...status() }
    if (data.used[raw.measurement_id]) return { ok: false, reason: 'measurement_id_used', ...status() }
    if (!Number.isInteger(raw.speed) || raw.speed < MEASUREMENT_SPRINT_LIMITS.min_speed || raw.speed > MEASUREMENT_SPRINT_LIMITS.max_speed
      || !Number.isInteger(raw.ticks) || raw.ticks < 60 || raw.ticks > MEASUREMENT_SPRINT_LIMITS.max_ticks) return { ok: false, reason: 'invalid_window', ...status() }
    if (!(raw.actor_id > 0) || !(raw.epoch > 0)) return { ok: false, reason: 'invalid_identity', ...status() }
    const construction = construction_sprint()
    if (data.lease || game.speed !== 1 || construction.speed !== 1 || construction.lease || construction.phase === 'construction') return { ok: false, reason: 'guard_not_ready', ...status() }
    const health = actor()?.character?.health ?? 0
    const reason = checked({ actor_id: raw.actor_id, epoch: raw.epoch, health })
    if (reason) return { ok: false, reason, ...status() }
    data.used[raw.measurement_id] = true
    data.lease = { measurement_id: raw.measurement_id, actor_id: raw.actor_id, epoch: raw.epoch, speed: raw.speed, ticks: raw.ticks,
      start_tick: game.tick, end_tick: game.tick + raw.ticks, health, native_checks: 0 }
    game.speed = raw.speed
    log(`[AUTORIO] measurement_sprint.started ${helpers.table_to_json(data.lease)}`)
    return { ok: true, ...status() }
  }
  function tick() {
    const lease = state().lease
    if (!lease) return
    lease.native_checks++
    const reason = game.speed !== lease.speed ? 'unexpected_speed'
      : game.tick >= lease.end_tick ? 'window_complete' : checked(lease)
    if (reason) finish(reason)
  }
  function safety(reason: string) { return state().lease ? finish(reason) : { ok: true, ...status() } }
  return { arm, finish, status, tick, safety }
}
