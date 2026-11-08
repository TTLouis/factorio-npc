// Deliberately imports only APIs present in frozen 34c43507. Running this same
// positive assertion against that source must fail on the actual stock refusal,
// never on a missing new helper or an absent export.
import assert from 'node:assert/strict'
import test from 'node:test'
import { stockWorld, original } from './bg-stock-fixtures.mjs'

for (const initial of [0, 1]) test(`unchanged BG ${original[initial].tap} proposal progresses across authoritative stock barrier`, async () => {
  const w = stockWorld({ initial })
  await w.start()
  assert.ok(w.rows.some(row => row.event === 'operations.batch_stock_checked' && row.data.refused === 'batch_stock_unverified_dependency'))
  assert.equal(w.game.mutations.length, 1, JSON.stringify(w.rows.filter(row => /preflight_rejected|preflight_recoverable|request.failed|preservation_refused/.test(row.event))))
  const calls = w.calls.length
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.calls.length, calls)
})

test('BG tap24 after prior tap14 durable correction progresses without refunding that claim', async () => {
  const w = stockWorld({ initial: 1, spentArgument: true })
  await w.start()
  assert.equal(w.game.mutations.length, 1)
  await w.agent.completed()
  assert.equal(w.game.mutations.length, 2)
  assert.equal(w.memory.planningState('npc:bg-stock').goal.argument_corrections.claims.length, 1)
})
