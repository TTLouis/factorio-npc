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

test('planning packets expose the cumulative wall allowance across actions and restart without extending it', async () => {
  const packets = []
  const provider = async packet => { packets.push(packet); return action }
  const f = fixture({ provider, options: { maxWallMs: 12000 } })
  await f.loop.wake('owner_intake')
  assert.equal(packets[0].remainingWallMs, 12000)
  const pending = f.loop.snapshot().pending
  f.advance(3000)
  f.world.runtime.admission_journal = [{ ...pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'completed', slots: [] }]
  const restarted = new GoalPursuit({ state: f.loop.snapshot(), adapter: f.adapter, provider, now: f.now })
  await restarted.wake('receipt_after_restart')
  assert.equal(packets[1].remainingWallMs, 9000)
  assert.equal(packets[1].remainingCalls, 29)
  assert.equal(restarted.snapshot().budget.startedAt, 1000)
  const reserved = f.events.filter(row => row.event === 'pursuit.provider_reserved')
  assert.deepEqual(reserved.map(row => row.packet_remaining_wall_ms), [12000, 9000])
  assert.deepEqual(reserved.map(row => row.packet_at_ms), [1000, 4000])
  f.advance(9000)
  f.world.runtime.admission_journal.at(-1).state = 'completed'
  // Complete the second exact admission before checking the expired allowance.
  f.world.runtime.admission_journal.push({ ...restarted.snapshot().pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'completed', slots: [] })
  assert.equal((await restarted.wake('wall_expired')).pauseReason, 'wall_budget_exhausted')
  assert.equal(packets.length, 2)
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
    { maxCalls: 501 }, { maxWallMs: 3600001 }, { startedAt: NaN },
  ]) {
    const state = structuredClone(f.state)
    Object.assign(state.budget, budget)
    assert.throws(() => new GoalPursuit({ state, adapter: f.adapter, provider: async () => action }), /budget|limit/)
  }
})

test('approved sixty-call campaign stops at its own cap without changing the default', async () => {
  assert.equal(fixture().state.budget.maxCalls, 30)
  const remaining = []
  const f = fixture({ options: { maxCalls: 60, maxInputChars: 4000000 }, provider: async packet => {
    remaining.push(packet.remainingCalls)
    return { observations: [{ name: 'getInventoryItems', args: {} }] }
  } })
  for (let index = 0; index < 60; index++) await f.loop.wake('read')
  const stopped = await f.loop.wake('over_cap')
  assert.equal(f.calls(), 60)
  assert.equal(stopped.pauseReason, 'call_budget_exhausted')
  assert.equal(stopped.budget.calls, 60)
  assert.equal(stopped.budget.maxInputChars, 4000000)
  assert.equal(stopped.budget.maxWallMs, 1200000)
  assert.deepEqual(remaining, Array.from({ length: 60 }, (_, index) => 60 - index))
})

test('completion trial can pass the old wall ceiling but stops at its original configured deadline', async () => {
  const remaining = []
  const f = fixture({ options: { maxCalls: 500, maxInputChars: 50000000, maxWallMs: 3600000 }, provider: async packet => {
    remaining.push(packet.remainingWallMs)
    return { observations: [{ name: 'getInventoryItems', args: {} }] }
  } })
  await f.loop.wake('start')
  f.advance(1200000)
  await f.loop.wake('past_old_ceiling')
  assert.deepEqual(remaining, [3600000, 2400000])
  f.advance(2400000)
  const stopped = await f.loop.wake('configured_deadline')
  assert.equal(stopped.pauseReason, 'wall_budget_exhausted')
  assert.equal(stopped.budget.calls, 2)
})

test('completion trial stops before a 501st provider call and keeps legacy defaults', async () => {
  const f = fixture({ options: { maxCalls: 500, maxInputChars: 50000000, maxWallMs: 3600000 },
    reply: { observations: [{ name: 'getInventoryItems', args: {} }] } })
  for (let index = 0; index < 500; index++) await f.loop.wake('read')
  const stopped = await f.loop.wake('over_cap')
  assert.equal(f.calls(), 500)
  assert.equal(stopped.pauseReason, 'call_budget_exhausted')
  assert.equal(fixture().state.budget.maxWallMs, 1200000)
  assert.equal(fixture().state.budget.maxInputChars, 2000000)
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

test('invalid decision array shape or cardinality refuses every request and corrects within the same allowance', async () => {
  for (const [invalid, code] of [
    [{ observations: Array.from({ length: 5 }, () => ({ name: 'getInventoryItems', args: {} })) }, 'observations_limit'],
    [{ observations: { name: 'getInventoryItems', args: {} } }, 'observations_limit'],
    [{ operations: Array.from({ length: 17 }, () => action.operations[0]) }, 'operations_limit'],
    [{ operations: action.operations[0] }, 'operations_limit'],
  ]) {
    let turn = 0, reads = 0, admits = 0
    const f = fixture({ provider: async packet => {
      if (++turn === 1) return { notes: 'Unaccepted notes must not persist.', ...invalid }
      assert.match(packet.observations.at(-1).result, new RegExp(`${code}.*array of at most`))
      return action
    } })
    f.adapter.observe = async () => { reads++; return '{}' }
    f.adapter.admit = async () => { admits++; return { ok: true } }
    const refused = await f.loop.wake('invalid_array')
    assert.equal(refused.status, 'active'); assert.equal(refused.pending, null); assert.equal(refused.ordinal, 0)
    assert.equal(refused.notes, ''); assert.equal(reads, 0); assert.equal(admits, 0); assert.equal(f.sent.length, 0)
    assert.equal(refused.budget.calls, 1); assert.equal(refused.metrics.length, 1)
    assert(f.events.some(row => row.event === 'pursuit.decision_refused' && row.reason === 'invalid_bounded_argument'
      && row.request_id === refused.request_id && row.message.startsWith(code)))
    f.advance(5)
    const corrected = await f.loop.wake('correction')
    assert.equal(corrected.budget.calls, 2); assert.equal(corrected.budget.startedAt, refused.budget.startedAt)
    assert(corrected.budget.inputChars > refused.budget.inputChars)
    assert.equal(corrected.request_id, refused.request_id); assert.equal(corrected.objective, refused.objective)
    assert.equal(reads, 0); assert.equal(admits, 1); assert.equal(f.sent.length, 1)
  }
})

test('repeated malformed read arrays cannot replenish the campaign or bypass its call ceiling', async () => {
  const f = fixture({ options: { maxCalls: 2 }, reply: { observations: {} } })
  await f.loop.wake('invalid_one')
  const first = f.loop.snapshot()
  f.advance(1)
  await f.loop.wake('invalid_two')
  const exhausted = await f.loop.wake('limit')
  assert.equal(exhausted.pauseReason, 'call_budget_exhausted')
  assert.equal(exhausted.budget.calls, 2); assert.equal(exhausted.budget.startedAt, first.budget.startedAt)
  assert.equal(exhausted.pending, null); assert.equal(f.sent.length, 0); assert.equal(f.calls(), 2)
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

test('native pre-dispatch refusals preserve bounded historical reads and replace only refusal feedback', async () => {
  let turn = 0, refusal = 'resource_source_not_found'
  const f = fixture({ provider: async packet => {
    if (++turn === 1) return { observations: [{ name: 'getInventoryItems', args: {} },
      { name: 'getNearbyEntities', args: { radius: 20, limit: 5 } }] }
    if (turn > 2) {
      assert.equal(packet.observations.length, 3)
      assert(packet.observations.slice(0, 2).every(row => row.historical === true && row.observed_at_ms === 1000))
      assert.equal(packet.world.inventory['copper-ore'], 4)
      assert.equal(packet.observations.at(-1).historical, false)
      assert.equal(JSON.parse(packet.observations.at(-1).result).code, turn === 3 ? 'resource_source_not_found' : 'supply_missing')
    }
    return action
  } })
  f.adapter.observe = async read => JSON.stringify({ source: read.name, inventory: { 'copper-ore': 0 } })
  f.adapter.admit = async () => ({ ok: false, code: refusal })
  await f.loop.wake('read')
  f.advance(10)
  await f.loop.wake('refused')
  f.world.observation.inventory['copper-ore'] = 4
  refusal = 'supply_missing'
  f.advance(10)
  await f.loop.wake('refused_again')
  await f.loop.wake('feedback')
  assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().pending, null)
  assert.equal(f.loop.snapshot().ordinal, 0)
  assert.equal(f.loop.snapshot().budget.calls, 4)
  assert.equal(f.loop.snapshot().budget.startedAt, 1000)
  const restarted = new GoalPursuit({ state: f.loop.snapshot(), adapter: f.adapter, provider: async () => action })
  assert.deepEqual(restarted.snapshot().observations, [])
})

test('native refusal retention obeys row and character bounds while feedback remains fresh', async () => {
  let item = 0
  const f = fixture({ provider: async () => ({ observations: [{ name: 'getRecipe', args: { item: `recipe-${item++}` } }] }) })
  f.adapter.observe = async () => 'x'.repeat(7500)
  for (let index = 0; index < 8; index++) await f.loop.wake('read')
  f.loop.provider = async () => action
  f.adapter.admit = async () => ({ ok: false, code: 'refused', detail: 'y'.repeat(9000) })
  await f.loop.wake('refused')
  const rows = f.loop.snapshot().observations
  assert(rows.length <= 12 && JSON.stringify(rows).length <= 48000)
  assert(rows.slice(0, -1).every(row => row.historical === true))
  assert.equal(rows.at(-1).name, 'admission')
  assert.equal(rows.at(-1).historical, false)
  assert.match(rows.at(-1).result, /Native observation truncated/)
  assert.equal(f.sent.length, 0)
})

test('retained mixed action/read decision is refused without effects and can correct within its original allowance', async () => {
  let turn = 0, reads = 0
  const f = fixture({ provider: async packet => {
    if (++turn === 1) return { ...action, observations: [{ name: 'getInventoryItems', args: {} }] }
    assert.match(packet.observations.at(-1).result, /one_decision_kind_required/)
    return action
  } })
  f.adapter.observe = async () => { reads++; return '{}' }
  await f.loop.wake('mixed')
  assert.equal(reads, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().status, 'active')
  assert.equal(f.loop.snapshot().budget.calls, 1)
  await f.loop.wake('corrected')
  assert.equal(f.sent.length, 1)
  assert.equal(f.loop.snapshot().budget.calls, 2)
})

test('retained read-in-action-list mistake gives actionable feedback without relocating or executing requests', async () => {
  let turn = 0, reads = 0, admits = 0
  const read = { name: 'getNearbyEntities', args: { radius: 10, limit: 20 } }
  const f = fixture({ provider: async packet => {
    if (++turn === 1) return { operations: [read] }
    assert.match(packet.observations.at(-1).result, /read_request_in_operations.*getNearbyEntities.*decision.observations/)
    return { observations: [read] }
  } })
  f.adapter.observe = async request => { reads++; assert.deepEqual(request, read); return '{}' }
  f.adapter.admit = async () => { admits++; return { ok: true } }
  await f.loop.wake('wrong_slot')
  assert.equal(reads, 0); assert.equal(admits, 0); assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().budget.calls, 1)
  assert.equal(f.loop.snapshot().pending, null)
  await f.loop.wake('corrected_read')
  assert.equal(reads, 1); assert.equal(admits, 0); assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().budget.calls, 2)
})

test('read mixed with an action in operations refuses the entire list before admission', async () => {
  const f = fixture({ reply: { operations: [...action.operations, { name: 'getActorStatus', args: {} }] } })
  let reads = 0, admits = 0
  f.adapter.observe = async () => { reads++; return '{}' }
  f.adapter.admit = async () => { admits++; return { ok: true } }
  await f.loop.wake('mixed_slots')
  assert.match(f.loop.snapshot().observations.at(-1).result, /read_request_in_operations/)
  assert.equal(reads, 0); assert.equal(admits, 0); assert.equal(f.sent.length, 0)
  assert.equal(f.loop.snapshot().budget.calls, 1)
  assert.equal(f.loop.snapshot().ordinal, 0)
})

test('placement mixed with later navigation is refused whole, then a single placement uses a new charged decision', async () => {
  for (const placement of [
    { name: 'place_entity', args: { entity_name: 'stone-furnace', x: 16, y: -96 } },
    { name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } },
  ]) {
    let turn = 0, admits = 0
    const f = fixture({ provider: async packet => {
      if (++turn === 1) return { operations: [placement, { name: 'walk_to_position', args: { x: 16, y: -96, reach_distance: 0.75 } }] }
      assert.match(packet.observations.at(-1).result, /placement_action_boundary_required/)
      return { operations: [placement] }
    } })
    f.adapter.admit = async () => { admits++; return { ok: true } }
    await f.loop.wake('mixed_placement')
    assert.equal(admits, 0); assert.equal(f.sent.length, 0)
    assert.equal(f.loop.snapshot().budget.calls, 1)
    await f.loop.wake('single_placement')
    assert.equal(admits, 1); assert.equal(f.sent.length, 1)
    assert.equal(f.loop.snapshot().budget.calls, 2)
    assert.equal(f.sent[0].operations.length, 1)
  }
})

test('repeated whole-envelope refusals spend the original cap and never admit actions', async () => {
  const f = fixture({ options: { maxCalls: 1 }, provider: async () => ({ refusal: {
    code: 'pursuit_wire_envelope_invalid', message: 'Submit only decision.' } }) })
  let admits = 0, reads = 0
  f.adapter.admit = async () => { admits++; return { ok: true } }
  f.adapter.observe = async () => { reads++; return '{}' }
  const first = await f.loop.wake('invalid_envelope')
  assert.equal(first.status, 'active'); assert.equal(first.budget.calls, 1)
  assert.equal(first.pending, null); assert.equal(first.ordinal, 0)
  const last = await f.loop.wake('correction')
  assert.equal(last.status, 'paused'); assert.equal(last.pauseReason, 'call_budget_exhausted')
  assert.equal(f.calls(), 1); assert.equal(admits, 0); assert.equal(reads, 0); assert.equal(f.sent.length, 0)
})

test('whole-envelope refusal feedback reaches the next charged decision without prior effects', async () => {
  let calls = 0
  const f = fixture({ provider: async packet => {
    if (++calls === 1) return { refusal: { code: 'pursuit_wire_envelope_invalid', message: 'Submit only decision.' } }
    assert.match(packet.observations.at(-1).result, /pursuit_wire_envelope_invalid/)
    return action
  } })
  await f.loop.wake('refused')
  assert.equal(f.sent.length, 0); assert.equal(f.loop.snapshot().pending, null)
  await f.loop.wake('corrected')
  assert.equal(f.sent.length, 1); assert.equal(f.loop.snapshot().budget.calls, 2)
})

test('native seed consumes durable wall time before one charged decision and exposes only bounded prototype rules', async () => {
  const f = fixture({ provider: async packet => {
    assert.equal(packet.remainingWallMs, 1199990)
    assert.equal(packet.recipeKnowledge[0].name, 'native-part')
    assert.equal(packet.recipeKnowledge[0].ingredients[0].amount, 2)
    assert.equal(packet.recipeKnowledge[0].enabled, undefined)
    assert.equal(packet.knowledgeSeed.recipe_reads, 1)
    assert.equal(packet.knowledgeSeed.historical, true)
    return action
  } })
  let seeds = 0
  f.adapter.seedKnowledge = async (_predicate, read) => {
    seeds++; await read({ name: 'getRecipeDetails', args: { item_or_recipe: 'native-part' } })
    return { recipe_reads: 1 }
  }
  f.adapter.observe = async () => {
    assert.equal(f.saved.at(-1).budget.startedAt, 1000)
    f.advance(10)
    return JSON.stringify({ found: true, recipes: [{ name: 'native-part', enabled: true,
      ingredients: [{ name: 'native-ore', amount: 2 }], products: [{ name: 'native-part', amount: 1 }] }] })
  }
  await f.loop.wake('seed')
  assert.equal(seeds, 1); assert.equal(f.calls(), 1); assert.equal(f.sent.length, 1)
  assert(f.events.some(row => row.event === 'pursuit.knowledge_seeded' && row.request_id && row.reason))
  await f.loop.wake('pending')
  assert.equal(seeds, 1); assert.equal(f.calls(), 1)
})

test('expired seed reads suppress provider and admission without resetting the campaign start', async () => {
  const f = fixture({ options: { maxWallMs: 10 } })
  f.adapter.seedKnowledge = async (_predicate, read) => read({ name: 'getRecipeDetails', args: { item_or_recipe: 'native-part' } })
  f.adapter.observe = async () => { f.advance(11); return '{}' }
  const result = await f.loop.wake('seed')
  assert.equal(result.pauseReason, 'wall_budget_exhausted')
  assert.equal(result.budget.startedAt, 1000); assert.equal(result.budget.calls, 0); assert.equal(f.calls(), 0); assert.equal(f.sent.length, 0)
})

test('a clock regression during a seed read cannot extend the persisted allowance', async () => {
  const f = fixture()
  f.adapter.seedKnowledge = async (_predicate, read) => read({ name: 'getRecipeDetails', args: { item_or_recipe: 'native-part' } })
  f.adapter.observe = async () => { f.advance(-1); return '{}' }
  const result = await f.loop.wake('seed')
  assert.equal(result.pauseReason, 'wall_clock_regressed'); assert.equal(result.budget.startedAt, 1000)
  assert.equal(result.budget.calls, 0); assert.equal(f.calls(), 0); assert.equal(f.sent.length, 0)
})

test('native recipe rules and exact submitted quantities survive settlement without retaining mutable reads or replaying', async () => {
  let turn = 0
  const packets = []
  const f = fixture({ provider: async packet => {
    packets.push(packet)
    if (++turn === 1) return { observations: [{ name: 'getRecipeDetails', args: { item_or_recipe: 'iron-plate' } }] }
    return turn === 2 ? action : { pauseReason: 'test checkpoint' }
  } })
  f.adapter.observe = async () => JSON.stringify({ found: true, inventory: { 'iron-ore': 999 }, enabled: true,
    recipes: [{ name: 'iron-plate', energy: 3.2, categories: ['smelting'], enabled: true,
      ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1 }],
      crafting_machines: [{ name: 'stone-furnace' }] }] })
  await f.loop.wake('read')
  await f.loop.wake('act')
  const pending = f.loop.snapshot().pending
  assert.deepEqual(pending.requested_actions, f.sent[0].operations)
  f.world.runtime.admission_journal = [{ ...pending, actor_id: actor.actor_id, epoch: actor.epoch,
    generation: 1, operation_count: 1, state: 'completed', slots: [] }]
  await f.loop.wake('settled')
  const packet = packets.at(-1)
  assert.deepEqual(packet.observations, [])
  assert.equal(packet.recipeKnowledge[0].name, 'iron-plate')
  assert.equal(packet.recipeKnowledge[0].complete, true)
  assert.equal(packet.recipeKnowledge[0].historical, true)
  assert.deepEqual(packet.recipeKnowledge[0].ingredients, [{ type: 'item', name: 'iron-ore', amount: 1 }])
  assert.equal(JSON.stringify(packet.recipeKnowledge).includes('999'), false)
  assert.equal(JSON.stringify(packet.recipeKnowledge).includes('enabled'), false)
  assert.deepEqual(packet.receipts[0].requested_actions, f.sent[0].operations)
  assert.equal(packet.receipts[0].verdict, 'admitted_completed')
  assert.equal(f.sent.length, 1)
  assert.ok(f.events.some(row => row.event === 'pursuit.recipe_knowledge_retained'
    && row.reason === 'native_prototype_quantities_only' && row.request_id))
  const restarted = new GoalPursuit({ state: f.loop.snapshot(), adapter: f.adapter, provider: async () => action, now: f.now })
  assert.deepEqual(restarted.snapshot().recipeKnowledge, [])
  assert.equal(restarted.snapshot().budget.calls, 3)
})

test('prototype knowledge refuses unreadable answers, preserves incomplete flags and remains bounded', async () => {
  const f = fixture({ reply: { observations: [{ name: 'getRecipeDetails', args: { item_or_recipe: 'iron-plate' } }] } })
  f.adapter.observe = async () => 'unreadable native text'
  await f.loop.wake('read')
  assert.deepEqual(f.loop.snapshot().recipeKnowledge, [])
  f.adapter.observe = async () => JSON.stringify({ found: true, recipes: Array.from({ length: 40 }, (_, i) => ({
    name: `recipe-${i}`, ingredients: Array.from({ length: 50 }, (_, j) => ({ name: `item-${j}`, amount: 1 })),
    products: [{ name: `recipe-${i}`, amount: 1 }], crafting_machines: [] })) })
  await f.loop.wake('read')
  const knowledge = f.loop.snapshot().recipeKnowledge
  assert.ok(knowledge.length > 0 && knowledge.length <= 32)
  assert.ok(JSON.stringify(knowledge).length <= 16000)
  assert.ok(knowledge.every(fact => fact.complete === false))
  f.adapter.observe = async () => JSON.stringify({ found: true, recipes: [
    { name: 'missing-ingredient-quantity', ingredients: [{ name: 'iron-ore' }], products: [{ name: 'iron-plate', amount: 1 }] },
    { name: 'missing-product-quantity', ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate' }] },
    { name: 'invalid-probability', ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1, probability: 2 }] },
    { name: 'unreadable-probability', ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1, probability: 'invalid' }] },
    { name: 'null-probability', ingredients: [{ name: 'iron-ore', amount: 1 }], products: [{ name: 'iron-plate', amount: 1, independent_probability: null }] },
  ] })
  await f.loop.wake('malformed quantities')
  assert.ok(f.loop.snapshot().recipeKnowledge.slice(-5).every(fact => fact.complete === false))
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
