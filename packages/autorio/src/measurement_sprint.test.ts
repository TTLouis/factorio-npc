import { beforeEach, expect, it, vi } from 'vitest'
import { MEASUREMENT_SPRINT_LIMITS, new_measurement_sprint_guard } from './measurement_sprint'

function world() {
  const character = { valid: true, unit_number: 19, health: 250 }
  const deployment = { actor_id: 19, epoch: 3, allowed: true, connected_players: 0 }
  const work: any = { task_state: 'idle', queue_length: 0 }
  const construction: any = { speed: 1 }
  const threats: any[] = []
  const actor: any = { is_valid: true, character, surface: { find_entities_filtered: () => threats }, position: { x: 0, y: 0 } }
  const guard = new_measurement_sprint_guard(() => actor, () => work, () => deployment, () => construction)
  const lease = { measurement_id: 'trial5-window', actor_id: 19, epoch: 3, speed: 8, ticks: 72000 }
  return { guard, lease, character, deployment, work, construction, threats, actor }
}
beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.speed = 1
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).log = vi.fn()
})

it('holds the requested speed for exactly the window and restores 1x natively at the end tick', () => {
  const w = world()
  expect(w.guard.arm(w.lease)).toMatchObject({ ok: true, speed: 8, lease: { start_tick: 100, end_tick: 72100 } })
  ;(globalThis as any).game.tick = 72099
  w.guard.tick()
  expect(game.speed).toBe(8)
  ;(globalThis as any).game.tick = 72100
  w.guard.tick()
  expect(w.guard.status()).toMatchObject({ speed: 1, last: { reason: 'window_complete', actual_ticks: 72000, measurement_id: 'trial5-window' } })
  expect(w.guard.status().lease).toBeUndefined()
})

for (const change of ['humans', 'threat', 'damage', 'actor', 'epoch', 'work', 'queue', 'speed']) {
  it(`a ${change} change ends the window early at 1x with its reason`, () => {
    const w = world()
    expect(w.guard.arm(w.lease).ok).toBe(true)
    if (change === 'humans') w.deployment.connected_players = 1
    if (change === 'threat') w.threats.push({ name: 'small-biter' })
    if (change === 'damage') w.character.health--
    if (change === 'actor') w.character.unit_number++
    if (change === 'epoch') w.deployment.epoch++
    if (change === 'work') w.work.task_state = 'crafting'
    if (change === 'queue') w.work.queue_length = 1
    if (change === 'speed') (globalThis as any).game.speed = 4
    ;(globalThis as any).game.tick = 500
    w.guard.tick()
    expect(game.speed).toBe(1)
    expect(w.guard.status().lease).toBeUndefined()
    expect(w.guard.status().last.reason).not.toBe('window_complete')
    expect(w.guard.status().last.actual_ticks).toBe(400)
  })
}

it('refuses busy, accelerated, construction-sprint, out-of-range and reused windows without changing speed', () => {
  const w = world()
  expect(w.guard.arm({ ...w.lease, speed: MEASUREMENT_SPRINT_LIMITS.max_speed + 1 }).reason).toBe('invalid_window')
  expect(w.guard.arm({ ...w.lease, speed: 1 }).reason).toBe('invalid_window')
  expect(w.guard.arm({ ...w.lease, ticks: MEASUREMENT_SPRINT_LIMITS.max_ticks + 1 }).reason).toBe('invalid_window')
  expect(w.guard.arm({ ...w.lease, measurement_id: 'x' }).reason).toBe('invalid_measurement_id')
  w.work.task_state = 'walking'
  expect(w.guard.arm(w.lease).reason).toBe('native_work_started')
  w.work.task_state = 'idle'
  w.construction.phase = 'construction'
  expect(w.guard.arm(w.lease).reason).toBe('guard_not_ready')
  delete w.construction.phase
  w.deployment.epoch = 4
  expect(w.guard.arm(w.lease).reason).toBe('epoch_changed')
  expect(game.speed).toBe(1)
  w.deployment.epoch = 3
  expect(w.guard.arm(w.lease).ok).toBe(true)
  expect(w.guard.arm({ ...w.lease, measurement_id: 'trial5-second' }).reason).toBe('guard_not_ready')
  w.guard.finish('host_watchdog', 'trial5-window')
  expect(w.guard.arm(w.lease).reason).toBe('measurement_id_used')
})

it('a host finish for another window cannot end the current one; a safety event always does', () => {
  const w = world()
  expect(w.guard.arm(w.lease).ok).toBe(true)
  expect(w.guard.finish('host_watchdog', 'other-window')).toMatchObject({ ok: false, reason: 'measurement_superseded', speed: 8 })
  w.guard.safety('player_created')
  expect(w.guard.status()).toMatchObject({ speed: 1, last: { reason: 'player_created' } })
})
