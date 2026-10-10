import test from 'node:test'
import assert from 'node:assert/strict'
import { GoalPursuit, newPursuit, pursuitDecision } from './goal-pursuit.mjs'

const actor = { actor_id: 18, epoch: 3, mode: 'npc', actor_kind: 'standalone_character' }
const action = { notes: 'Acquire inputs before research.', operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 10 } }] }
function fixture({ reply = action, options = {}, provider } = {}) {
  let time = 1000
  const saved = [], events = [], sent = []
  const world = { actor: { ...actor }, runtime: { batch_generation: 1, task_state: 'idle', queue_length: 0, admission_journal: [] }, observation: { inventory: {} } }
  const adapter = {
    world: async () => structuredClone(world), verify: async () => ({ read: true, satisfied: false }),
    observe: async () => '{"inventory":{}}', admit: async () => ({ ok: true }),
    dispatch: async (operations, identity) => sent.push({ operations, identity }),
    save: async state => saved.push(state), trace: async row => events.push(row),
  }
  const state = newPursuit({ objective: 'Research green science using native red production and consumption.',
    predicate: { research: 'logistic-science-pack', redProduced: 75, redConsumed: 75 }, actor, ...options })
  let calls = 0
  const wrapped = async (...args) => { calls++; return provider ? provider(...args) : structuredClone(reply) }
  const loop = new GoalPursuit({ state, adapter, provider: wrapped, now: () => time })
  return { loop, world, adapter, sent, saved, events, state, calls: () => calls, now: () => time, advance: ms => { time += ms } }
}

test('strategy evolves independently; dispatch receives an immutable correlated native identity persisted first', async () => {
  const f = fixture()
  f.adapter.dispatch = async (operations, identity) => {
    assert.equal(f.saved.at(-1).pending.operation_key, identity.operation_key)
    f.sent.push({ operations, identity })
  }
  await f.loop.wake('owner_intake')
  assert.equal(f.calls(), 1)
  assert.equal(f.sent.length, 1)
  assert.equal(f.loop.snapshot().notes, action.notes)
  assert.equal(f.sent[0].identity.protocol_version, 2)
  assert.equal(f.sent[0].identity.ordinal, 1)
  assert.equal(f.sent[0].identity.actor.actor_id, actor.actor_id)
  assert.equal(f.loop.snapshot().objective, f.state.objective)
  assert.ok(f.events.every(row => row.request_id && row.reason))
})

test('uncertain dispatch survives restart and suppresses all replay and provider calls', async () => {
  const f = fixture()
  f.adapter.dispatch = async () => { throw new Error('acknowledgement missing') }
  await f.loop.wake('owner_intake')
  const state = f.loop.snapshot()
  assert.ok(state.pending)
  state.status = 'active' // explicit resume may reconcile, never erase pending
  const restarted = new GoalPursuit({ state, adapter: f.adapter, provider: async () => { throw new Error('must not call') } })
  const result = await restarted.wake('restart')
  assert.match(result.pauseReason, /uncertain_operation/)
  assert.equal(result.budget.calls, 1)
  assert.equal(result.pending.operation_key, state.pending.operation_key)
})

test('receipt polling while an admitted batch runs spends no further provider calls', async () => {
  const f = fixture()
  await f.loop.wake('owner_intake')
  const pending = f.loop.snapshot().pending
  f.world.runtime.task_state = 'running'
  f.world.runtime.queue_length = 1
  f.world.runtime.admission_journal = [{ ...pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'admitted', slots: [{ index: 1, ok: true, batch_refs: [{ batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1' }] }] }]
  await f.loop.wake('receipt_poll')
  assert.equal(f.calls(), 1)
  assert.equal(f.sent.length, 1)
  assert.ok(f.loop.snapshot().pending)
})

test('cancelled partial effects retain their immutable identity and prohibit replay', async () => {
  const f = fixture()
  await f.loop.wake('owner_intake')
  const pending = f.loop.snapshot().pending
  f.world.runtime.admission_journal = [{ ...pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'failed', slots: [{ index: 1, ok: true,
      batch_refs: [{ batch_id: 1, batch_generation: 1, batch_ref: 'batch-g1-1' }] }] }]
  f.world.runtime.receipt_journal = [{ batch_ref: 'batch-g1-1', state: 'cancelled' }]
  const result = await f.loop.wake('receipt_poll')
  assert.equal(result.status, 'paused')
  assert.match(result.pauseReason, /uncertain_operation:exact_batch_cancelled/)
  assert.equal(result.pending.operation_key, pending.operation_key)
  assert.equal(f.calls(), 1)
  assert.equal(f.sent.length, 1)
})

test('an exact completed receipt permits strategy revision without replacing the user objective', async () => {
  const f = fixture({ options: { maxCalls: 1 } })
  await f.loop.wake('owner_intake')
  const pending = f.loop.snapshot().pending
  f.world.runtime.admission_journal = [{ ...pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'completed', slots: [] }]
  const result = await f.loop.wake('receipt_poll')
  assert.equal(result.pending, null)
  assert.equal(result.history[0].verdict, 'admitted_completed')
  assert.equal(result.objective, f.state.objective)
  assert.equal(result.pauseReason, 'call_budget_exhausted')
})

test('a backwards clock cannot reopen a persisted wall allowance', async () => {
  const f = fixture({ reply: { observations: [{ name: 'getInventoryItems', args: {} }] } })
  await f.loop.wake('owner_intake')
  f.advance(-1)
  assert.equal((await f.loop.wake('observations_ready')).pauseReason, 'wall_clock_regressed')
  assert.equal(f.calls(), 1)
})

test('actor changes during provider await discard actions and preserve charged call', async () => {
  const f = fixture({ provider: async () => { f.world.actor.epoch++; return action } })
  const result = await f.loop.wake('owner_intake')
  assert.equal(result.status, 'paused')
  assert.equal(result.pauseReason, 'pursuit_stale_actor')
  assert.equal(result.budget.calls, 1)
  assert.equal(f.sent.length, 0)
})

test('failed providers and observation decisions consume a durable cumulative allowance', async () => {
  const f = fixture({ options: { maxCalls: 1 }, reply: { notes: 'Inspect inventory.', observations: [{ name: 'getInventoryItems', args: {} }] } })
  await f.loop.wake('owner_intake')
  const restarted = new GoalPursuit({ state: f.loop.snapshot(), adapter: f.adapter, provider: async () => { throw new Error('budget bypass') }, now: f.now })
  assert.equal((await restarted.wake('observations_ready')).pauseReason, 'call_budget_exhausted')
  const failed = fixture({ provider: async () => { throw new Error('provider timeout') } })
  await failed.loop.wake('owner_intake')
  assert.equal(failed.loop.snapshot().budget.calls, 1)
  assert.equal(failed.loop.snapshot().pauseReason, 'provider timeout')
})

test('restored reservations cannot lose the start time or counters', () => {
  const f = fixture()
  for (const budget of [
    { calls: 1, startedAt: null }, { calls: -1 }, { calls: 31 }, { inputChars: -1 },
    { maxCalls: 31 }, { maxWallMs: 1200001 }, { startedAt: NaN },
  ]) {
    const state = structuredClone(f.state)
    Object.assign(state.budget, budget)
    assert.throws(() => new GoalPursuit({ state, adapter: f.adapter, provider: async () => action }), /budget|limit/)
  }
})

test('restart discards mutable reads and preserves the charged allowance and objective', async () => {
  const f = fixture({ reply: { observations: [{ name: 'getInventoryItems', args: {} }] } })
  await f.loop.wake('owner_intake')
  const state = f.loop.snapshot()
  assert.equal(state.observations.length, 1)
  let packet
  const restarted = new GoalPursuit({ state, adapter: f.adapter, now: f.now, provider: async value => { packet = value; return action } })
  await restarted.wake('restart')
  assert.deepEqual(packet.observations, [])
  assert.equal(packet.objective, state.objective)
  assert.equal(restarted.snapshot().budget.calls, 2)
})

test('a larger fresh input allowance cannot replenish an existing campaign on restart', async () => {
  const f = fixture()
  const state = f.loop.snapshot()
  state.budget = { ...state.budget, maxInputChars: 500, inputChars: 499, calls: 1, startedAt: 1000 }
  const restarted = new GoalPursuit({ state, adapter: f.adapter, provider: async () => { throw new Error('budget bypass') }, now: f.now })
  const result = await restarted.wake('restart')
  assert.equal(result.pauseReason, 'input_budget_exhausted')
  assert.equal(result.budget.maxInputChars, 500)
  assert.equal(result.budget.inputChars, 499)
  assert.equal(result.budget.calls, 1)
})

test('unreadable and unowned native work cannot spend a provider call or append operations', async () => {
  for (const runtime of [null, {}, { task_state: 'running', queue_length: 1, batch_generation: 1 }]) {
    const f = fixture()
    f.world.runtime = runtime
    const result = await f.loop.wake('receipt_poll')
    assert.equal(result.status, 'paused')
    assert.match(result.pauseReason, /native_status_unreadable|unowned_native_work/)
    assert.equal(f.calls(), 0)
    assert.equal(f.sent.length, 0)
  }
})

test('cancellation settles a provider that ignores AbortSignal and fences a late answer', async () => {
  let resolve, entered
  const ready = new Promise(done => { entered = done })
  const f = fixture({ provider: async () => { entered(); return new Promise(done => { resolve = done }) } })
  const running = f.loop.wake('owner_intake')
  await ready
  f.loop.cancel()
  const result = await running
  assert.equal(result.status, 'paused')
  assert.equal(result.budget.calls, 1)
  resolve(action)
  await Promise.resolve()
  assert.equal(f.sent.length, 0)
})

test('cancellation while persisting a dispatch reservation keeps uncertainty without sending', async () => {
  const f = fixture()
  f.adapter.save = async state => { f.saved.push(state); if (state.pending) f.loop.cancel() }
  const result = await f.loop.wake('owner_intake')
  assert.equal(result.status, 'paused')
  assert.ok(result.pending)
  assert.equal(f.sent.length, 0)
})

test('idle cancellation survives restart and cannot be reopened by another wake', async () => {
  const f = fixture()
  await f.loop.cancel()
  assert.equal(f.saved.at(-1).status, 'paused')
  const restarted = new GoalPursuit({ state: f.saved.at(-1), adapter: f.adapter,
    now: f.now, provider: async () => { throw new Error('cancel bypass') } })
  assert.equal((await restarted.wake('receipt_poll')).status, 'paused')
  assert.equal(f.calls(), 0)
})

test('slow admission and persistence cannot dispatch after the cumulative wall deadline', async () => {
  for (const delayed of ['admit', 'save']) {
    const f = fixture({ options: { maxWallMs: 100 } })
    if (delayed === 'admit') f.adapter.admit = async () => { f.advance(100); return { ok: true } }
    else f.adapter.save = async state => { f.saved.push(state); if (state.pending && state.status === 'active') f.advance(100) }
    const result = await f.loop.wake('owner_intake')
    assert.equal(result.pauseReason, 'wall_budget_exhausted')
    assert.equal(f.sent.length, 0)
    assert.equal(result.budget.calls, 1)
  }
})

test('a late provider answer at the wall limit cannot dispatch; consumed allowance persists', async () => {
  const f = fixture({ options: { maxWallMs: 100 }, provider: async () => { f.advance(100); return action } })
  assert.equal((await f.loop.wake('owner_intake')).pauseReason, 'wall_budget_exhausted')
  assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().budget.calls, 1)
})

test('provider cannot change the user predicate, issue generated Lua, or claim world completion', () => {
  assert.throws(() => pursuitDecision({ predicate: { satisfied: true } }), /unknown_field/)
  assert.throws(() => pursuitDecision({ operations: [{ name: 'remote.call', args: {} }] }), /Unapproved/)
  assert.throws(() => pursuitDecision({ observations: [{ name: 'shell', args: { command: 'anything' } }] }))
  assert.throws(() => pursuitDecision({ completed: true }), /unknown_field/)
})

test('native permission refusal is model-visible evidence and never admits an action', async () => {
  const f = fixture()
  f.adapter.admit = async () => ({ ok: false, code: 'protected_structure' })
  const result = await f.loop.wake('owner_intake')
  assert.equal(result.status, 'active')
  assert.equal(f.sent.length, 0)
  assert.equal(result.pending, null)
  assert.match(result.observations[0].result, /protected_structure/)
})

test('retained live invalid-radius decision supplies bounded correction without executing the rejected reads', async () => {
  let calls = 0, reads = 0
  const f = fixture({ provider: async packet => {
    if (++calls === 1) return { observations: [{ name: 'getNearbyEntities', args: { radius: 128 } }] }
    assert.match(packet.observations.at(-1).result, /radius must be an integer from 1 to 64/)
    return action
  } })
  f.adapter.observe = async () => { reads++; return '{}' }
  const refused = await f.loop.wake('intake')
  assert.equal(refused.status, 'active')
  assert.equal(refused.budget.calls, 1)
  assert.equal(refused.metrics.length, 1)
  assert.equal(f.sent.length, 0)
  assert.equal(reads, 0)
  assert.equal(f.events.at(-1).reason, 'invalid_bounded_argument')
  await f.loop.wake('correction')
  assert.equal(f.sent.length, 1)
  assert.equal(f.loop.snapshot().budget.calls, 2)
})

test('native read memory retains earlier facts as historical, refreshes duplicates and stays bounded', async () => {
  let item = 'iron-plate'
  const f = fixture({ provider: async () => ({ observations: [{ name: 'getRecipe', args: { item } }] }) })
  f.adapter.observe = async () => '{ "value": 0.9900000000000000 }'
  await f.loop.wake('read')
  f.advance(1); item = 'copper-plate'
  await f.loop.wake('read')
  const rows = f.loop.snapshot().observations
  assert.equal(rows[0].historical, true)
  assert.equal(rows[1].historical, false)
  assert.equal(rows[0].result, '{"value":0.99}')
  assert.equal(rows[0].observed_at_ms, 1000)
  assert.equal(rows[1].observed_at_ms, 1001)
  item = 'iron-plate'
  await f.loop.wake('refresh')
  assert.equal(f.loop.snapshot().observations.length, 2)
  assert.equal(f.loop.snapshot().observations.at(-1).args.item, 'iron-plate')
  for (let index = 0; index < 15; index++) { item = `recipe-${index}`; await f.loop.wake('read') }
  assert.equal(f.loop.snapshot().observations.length, 12)
  assert.equal(f.events.some(row => row.event === 'pursuit.observations_retained' && row.request_id), true)
})

test('completion requires the trusted adapter to read and satisfy the owner predicate', async () => {
  const f = fixture()
  f.adapter.verify = async () => ({ read: true, satisfied: true, redProduced: 75, redConsumed: 75 })
  assert.equal((await f.loop.wake('condition_transition')).status, 'completed')
  assert.equal(f.calls(), 0)
  const unknown = fixture()
  unknown.adapter.verify = async () => ({ read: false, satisfied: true })
  assert.equal((await unknown.loop.wake('owner_intake')).status, 'active')
})

test('retained Oct 8 blocker shape is a truthful provider pause without goal retirement or synthetic action', async () => {
  const f = fixture({ reply: { notes: 'Copper and iron triggers remain unmet.', operations: [], pauseReason: 'Cannot verify or perform remaining work this turn.' } })
  const result = await f.loop.wake('observations_ready')
  assert.equal(result.status, 'paused')
  assert.match(result.pauseReason, /^provider_reported:/)
  assert.deepEqual(result.predicate, f.state.predicate)
  assert.equal(f.sent.length, 0)
  assert.equal(f.events.some(row => row.event === 'pursuit.completed'), false)
})
