import { beforeEach, expect, it, vi } from 'vitest'
import { new_tick_sprint_guard, SPRINT_LIMITS } from './e2e_tick_sprint'

const binding = { run_id: 'sprint-test', source_sha: 'a'.repeat(40), profile: 'accelerated' as const }
function world() {
  const character = { valid: true, unit_number: 19, health: 250 }
  const deployment = { actor_id: 19, epoch: 1, allowed: true, connected_players: 0 }
  const board: any = { goal_id: 'goal', status: 'active', blocker: '', pause_reason: '', plan: { plan_id: 'plan', plan_version: 1 }, active_index: 0, steps: [{ id: 'step_1' }] }
  const tasks: any = { task_state: 'crafting', queue_length: 0, active_batch: { batch_ref: 'batch-g1-1' } }
  const admission: any = { operation_key: 'req/op_1', signature: 'signature', actor_id: 19, epoch: 1, state: 'admitted',
    slots: [{ ok: true, batch_refs: [{ batch_ref: 'batch-g1-1' }] }] }
  const threats: any[] = []
  const actor: any = { is_valid: true, character, surface: { find_entities_filtered: () => threats }, position: { x: 0, y: 0 } }
  ;(globalThis as any).remote.call = (name: string) => name === 'sgluna_deployment' ? deployment : board
  const guard = new_tick_sprint_guard(() => actor, () => tasks, () => [admission])
  const lease = { ...binding, lease_id: 'lease1', request_id: 'req', actor_id: 19, epoch: 1, goal_id: 'goal', plan_id: 'plan', plan_version: 1,
    step_id: 'step_1', board_step_id: 'step_1', operation_key: 'req/op_1', signature: 'signature', batch_ref: 'batch-g1-1',
    episode_id: 'batch-g1-1', wall_started_ms: 1000, wall_deadline_ms: 4000 }
  expect(guard.configure(binding).ok).toBe(true)
  return { guard, lease, character, deployment, board, tasks, admission, threats, actor }
}
beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 10
  ;(globalThis as any).game.speed = 1
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).log = vi.fn()
})

it('native guard reserves before arming and independently restores at600 actual ticks', () => {
  const w = world()
  expect(w.guard.arm(w.lease)).toMatchObject({ ok: true, speed: 4 })
  expect(w.guard.status().episodes['batch-g1-1']).toBe(600)
  ;(globalThis as any).game.tick = 609
  w.guard.tick()
  expect(game.speed).toBe(4)
  ;(globalThis as any).game.tick = 610
  w.guard.tick()
  expect(w.guard.status()).toMatchObject({ speed: 1, last: { reason: 'tick_cap', actual_ticks: 600 } })
  expect(w.guard.status().lease).toBeUndefined()
})

for (const change of ['humans', 'threat', 'damage', 'actor', 'epoch', 'goal', 'step', 'pause', 'complete', 'unknown_effects', 'signature', 'batch', 'speed']) {
  it(`native ${change} event restores1x without waiting for host observation`, () => {
    const w = world()
    expect(w.guard.arm(w.lease).ok).toBe(true)
    if (change === 'humans') w.deployment.connected_players = 1
    if (change === 'threat') w.threats.push({ name: 'small-biter' })
    if (change === 'damage') w.character.health--
    if (change === 'actor') w.character.unit_number++
    if (change === 'epoch') w.deployment.epoch++
    if (change === 'goal') w.board.goal_id = 'replacement'
    if (change === 'step') w.board.steps[0].id = 'replacement'
    if (change === 'pause') w.board.status = 'paused'
    if (change === 'complete') w.tasks.task_state = 'idle'
    if (change === 'unknown_effects') w.admission.state = 'uncertain'
    if (change === 'signature') w.admission.signature = 'changed'
    if (change === 'batch') w.tasks.active_batch.batch_ref = 'batch-g2-1'
    if (change === 'speed') (globalThis as any).game.speed = 8
    w.guard.tick()
    expect(game.speed).toBe(1)
    expect(w.guard.status().lease).toBeUndefined()
  })
}

it('idle, uncertain, forged, overlapping and unfrozen leases cannot arm', () => {
  const w = world()
  expect(w.guard.arm({ ...w.lease, source_sha: 'b'.repeat(40) }).ok).toBe(false)
  expect(w.guard.arm({ ...w.lease, episode_id: 'new-allowance' }).ok).toBe(false)
  w.tasks.task_state = 'idle'
  expect(w.guard.arm(w.lease)).toMatchObject({ ok: false, reason: 'native_work_finished' })
  w.tasks.task_state = 'crafting'; w.admission.state = 'uncertain'
  expect(w.guard.arm(w.lease).ok).toBe(false)
  w.admission.state = 'admitted'
  expect(w.guard.arm(w.lease).ok).toBe(true)
  expect(w.guard.arm({ ...w.lease, lease_id: 'overlap' }).ok).toBe(false)
})

it('same episode cannot renew allowance through restore, configure or reconstructed controller', () => {
  const w = world()
  for (let i = 0; i < SPRINT_LIMITS.episode_ticks / SPRINT_LIMITS.burst_ticks; i++) {
    expect(w.guard.arm({ ...w.lease, lease_id: `lease-${i}` }).ok).toBe(true)
    w.guard.finish('boundary')
    expect(w.guard.configure(binding).ok).toBe(true)
  }
  const again = new_tick_sprint_guard(() => w.actor, () => w.tasks, () => [w.admission])
  expect(again.arm(w.lease)).toMatchObject({ ok: false, reason: 'episode_exhausted' })
  expect(again.status().episodes['batch-g1-1']).toBe(3600)
})

it('stale watchdog cannot stop a replacement lease; sealed construction cannot restart or authorize measurement', () => {
  const w = world()
  expect(w.guard.arm(w.lease).ok).toBe(true)
  w.guard.finish('boundary')
  expect(w.guard.arm({ ...w.lease, lease_id: 'replacement' }).ok).toBe(true)
  expect(w.guard.finish('old-watchdog', 'lease1')).toMatchObject({ ok: false, speed: 4 })
  expect(w.guard.seal('measurement')).toMatchObject({ phase: 'closed', speed: 1 })
  expect(w.guard.configure(binding).ok).toBe(false)
  expect(w.guard.arm(w.lease).ok).toBe(false)
})

it('inactive profile safety hooks preserve normal game speed', () => {
  const actor: any = undefined
  const guard = new_tick_sprint_guard(() => actor, () => ({ task_state: 'idle', queue_length: 0 }), () => [])
  ;(globalThis as any).game.speed = 2
  guard.safety('player_joined_game')
  guard.tick()
  expect(game.speed).toBe(2)
})

it('an unreadable native dependency restores1x rather than crashing the active guard', () => {
  const w = world()
  expect(w.guard.arm(w.lease).ok).toBe(true)
  ;(globalThis as any).remote.call = () => { throw new Error('unreadable native status') }
  w.guard.tick()
  expect(w.guard.status()).toMatchObject({ speed: 1, last: { reason: 'authoritative_guard_state_unreadable' } })
})

it('malformed durable expenditure cannot overdraw the episode cap', () => {
  const w = world()
  const episodes = w.guard.status().episodes
  for (const spent of [101, 3501, 3601, -600]) {
    episodes['batch-g1-1'] = spent
    expect(w.guard.arm(w.lease)).toMatchObject({ ok: false, reason: 'episode_exhausted' })
    expect(game.speed).toBe(1)
  }
})
