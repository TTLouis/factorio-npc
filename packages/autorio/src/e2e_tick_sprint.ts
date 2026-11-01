import type { ControlledActor } from './actors/types'
import type { OperationAdmission } from './operation_admission'
import type { TaskBoardUiSnapshot } from './task_board_ui'
import { find_world_entities } from './npc_vision'

export const SPRINT_GUARD_VERSION = 'tick-sprint-v1'
export const SPRINT_LIMITS = { speed: 4, burst_ticks: 600, episode_ticks: 3600, episodes: 1024 }
export interface SprintBinding { run_id: string, source_sha: string, profile: 'accelerated' }
export interface SprintLease extends SprintBinding {
  lease_id: string
  request_id: string
  actor_id: number
  epoch: number
  goal_id: string
  plan_id: string
  plan_version: number
  step_id: string
  board_step_id: string
  operation_key: string
  signature: string
  batch_ref: string
  episode_id: string
  wall_started_ms: number
  wall_deadline_ms: number
  start_tick: number
  end_tick: number
  health: number
  native_checks: number
}
interface FinishedLease extends SprintLease { restored_tick: number, reason: string, actual_ticks: number }
interface SprintState {
  phase?: 'construction' | 'closed'
  binding?: SprintBinding
  lease?: SprintLease
  last?: FinishedLease
  episodes: Record<string, number>
  episode_count: number
  fault?: string
}
declare const storage: { sgluna_tick_sprint?: SprintState }
function state(): SprintState {
  storage.sgluna_tick_sprint ??= { episodes: {}, episode_count: 0 }
  return storage.sgluna_tick_sprint
}
function text(value: unknown, max = 192): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function matches(binding: SprintBinding | undefined, other: SprintBinding) {
  return binding?.run_id === other.run_id && binding?.source_sha === other.source_sha && other.profile === 'accelerated'
}

// The remote interface is harness-only. It is deliberately absent from the
// model tool/operation catalog and cannot grant admission or completion.
export function new_tick_sprint_guard(actor: () => ControlledActor | undefined, tasks: () => {
  task_state: string, queue_length: number, active_batch?: { batch_ref: string }
}, admissions: () => OperationAdmission[]) {
  function finish(reason: string, expected_lease_id?: string) {
    const data = state()
    const lease = data.lease
    if (expected_lease_id && lease?.lease_id !== expected_lease_id) return { ok: false, reason: 'lease_superseded', ...status() }
    game.speed = 1
    if (lease) {
      data.last = { ...lease, restored_tick: game.tick, reason, actual_ticks: game.tick - lease.start_tick }
      data.lease = undefined
      log(`[AUTORIO] tick_sprint.restored ${helpers.table_to_json(data.last)}`)
    }
    return status()
  }
  function status() {
    const data = state()
    return { version: SPRINT_GUARD_VERSION, tick: game.tick, speed: game.speed,
      phase: data.phase,
      binding: data.binding, lease: data.lease, last: data.last, fault: data.fault,
      episode_count: data.episode_count, episodes: data.episodes }
  }
  function eligibility(lease: SprintLease) {
    const current = actor()
    const character = current?.character
    if (!current?.is_valid || !character?.valid || character.unit_number !== lease.actor_id || !(character.health! > 0)) return 'actor_changed'
    const deployment = remote.call('sgluna_deployment', 'status') as { actor_id?: number, epoch?: number, allowed?: boolean, connected_players?: number }
    if (deployment.allowed !== true || deployment.actor_id !== lease.actor_id || deployment.epoch !== lease.epoch) return 'epoch_changed'
    if (deployment.connected_players !== 0 || game.connected_players.length !== 0) return 'humans_present'
    if ((character.health ?? 0) < lease.health) return 'actor_damaged'
    if (find_world_entities(current.surface, { position: current.position, radius: 48, force: 'enemy', limit: 1 }).length > 0) return 'nearby_threat'
    const board = remote.call('autorio_task_board', 'status') as TaskBoardUiSnapshot | undefined
    if (!board || board.status !== 'active' || board.blocked !== undefined
      || typeof board.blocker !== 'string' || board.blocker.length > 0
      || typeof board.pause_reason !== 'string' || board.pause_reason.length > 0
      || board.goal_id !== lease.goal_id || board.plan?.plan_id !== lease.plan_id || board.plan.plan_version !== lease.plan_version
      || board.steps[board.active_index]?.id !== lease.board_step_id) return 'goal_plan_or_step_changed'
    const work = tasks()
    if (work.task_state === 'idle' && work.queue_length === 0) return 'native_work_finished'
    if (work.active_batch?.batch_ref !== lease.batch_ref) return 'native_batch_changed'
    const records = admissions()
    if (records.some(row => row.state === 'uncertain' || row.state === 'admitting')) return 'uncertain_native_effects'
    const record = records.find(row => row.operation_key === lease.operation_key)
    if (!record || record.state !== 'admitted' || record.signature !== lease.signature || record.actor_id !== lease.actor_id || record.epoch !== lease.epoch
      || !record.slots.some(slot => slot.ok === true && slot.batch_refs.some(ref => ref.batch_ref === lease.batch_ref))) return 'admission_unconfirmed'
    return undefined
  }
  function checked_eligibility(lease: SprintLease) {
    try { return eligibility(lease) } catch { return 'authoritative_guard_state_unreadable' }
  }
  function configure(binding: SprintBinding) {
    const data = state()
    if (!binding || binding.profile !== 'accelerated' || !text(binding.run_id, 100) || !text(binding.source_sha, 40)
      || binding.source_sha.length !== 40 || data.phase === 'closed' || (data.binding && !matches(data.binding, binding))) return { ok: false, reason: 'frozen_binding_mismatch' }
    finish('configure_or_restart')
    data.binding = binding
    data.phase = 'construction'
    return { ok: true, ...status() }
  }
  function arm(raw: Omit<SprintLease, 'start_tick' | 'end_tick' | 'health' | 'native_checks'>) {
    const data = state()
    if (data.phase !== 'construction') return { ok: false, reason: 'construction_closed' }
    if (data.fault || data.lease || game.speed !== 1 || !raw || !matches(data.binding, raw)) return { ok: false, reason: 'guard_not_ready' }
    if (![raw.lease_id, raw.request_id, raw.goal_id, raw.plan_id, raw.step_id, raw.board_step_id, raw.operation_key, raw.signature, raw.batch_ref, raw.episode_id].every(value => text(value, 512))
      || !text(raw.step_id, 80) || raw.step_id !== raw.board_step_id
      || raw.episode_id !== raw.batch_ref || !(raw.actor_id > 0) || !(raw.epoch > 0) || !(raw.plan_version > 0)) return { ok: false, reason: 'invalid_lease' }
    if (!(raw.wall_started_ms > 0) || raw.wall_deadline_ms !== raw.wall_started_ms + 3000) return { ok: false, reason: 'invalid_wall_bound' }
    const spent = data.episodes[raw.episode_id] ?? 0
    if (!Number.isInteger(spent) || spent < 0 || spent % SPRINT_LIMITS.burst_ticks !== 0
      || spent + SPRINT_LIMITS.burst_ticks > SPRINT_LIMITS.episode_ticks) return { ok: false, reason: 'episode_exhausted' }
    if (spent === 0 && data.episode_count >= SPRINT_LIMITS.episodes) return { ok: false, reason: 'episode_ledger_full' }
    const lease = { ...raw, start_tick: game.tick, end_tick: game.tick + SPRINT_LIMITS.burst_ticks, health: actor()?.character?.health ?? 0, native_checks: 0 }
    const refusal = checked_eligibility(lease)
    if (refusal) return { ok: false, reason: refusal }
    // Conservative expenditure precedes speed change. Early restoration never
    // refunds an episode, including reloads and duplicate completion callbacks.
    data.episodes[raw.episode_id] = spent + SPRINT_LIMITS.burst_ticks
    if (spent === 0) data.episode_count++
    data.lease = lease
    game.speed = SPRINT_LIMITS.speed
    log(`[AUTORIO] tick_sprint.started ${helpers.table_to_json(lease)}`)
    return { ok: true, ...status() }
  }
  function tick() {
    const data = state()
    const lease = data.lease
    if (!lease) {
      if (data.binding && data.phase === 'construction' && game.speed !== 1) { data.fault = 'unleased_speed'; finish(data.fault) }
      return
    }
    lease.native_checks++
    const reason = game.speed !== SPRINT_LIMITS.speed ? 'unexpected_speed'
      : game.tick >= lease.end_tick ? 'tick_cap' : checked_eligibility(lease)
    if (reason) finish(reason)
  }
  function seal(reason: string) { finish(reason); state().phase = 'closed'; return status() }
  function fail(reason: string) { state().fault = reason; return seal('controller_fault') }
  function safety(reason: string) { return state().binding && state().phase === 'construction' ? finish(reason) : status() }
  return { configure, arm, finish, status, tick, seal, fail, safety }
}
