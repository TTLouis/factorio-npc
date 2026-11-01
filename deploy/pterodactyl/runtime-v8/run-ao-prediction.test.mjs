import assert from 'node:assert/strict'
import test from 'node:test'
import { ao, aoWorld, preserveAoRepair } from './run-ao-fixture.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'

test('exact Run AO timeout/resume/batch24: stale advisory prediction cannot cancel a fresh verified activation', async () => {
  const w = await aoWorld()
  assert.equal(w.oldPrediction.requestId, ao.old_request_id)
  assert.equal(w.agent.traceRequest.id, ao.resumed_request_id)
  assert.equal(w.game.batchId, ao.native_batch_id)
  assert.equal(w.held().active_step_index, 0)
  const first = structuredClone(w.held().steps[0])
  await w.close()
  assert.equal(w.game.inventory['iron-plate'], 50)
  assert.equal(w.held().active_step_index, 1)
  assert.deepEqual(w.held().steps[0], first, 'verified semantics remain immutable')
  assert.equal(w.held().steps[1].contract_binding.binding, 'just_in_time')
  assert.equal(w.contracts.length, 2, 'old advisory reply plus one fresh current-owner JIT call')
  assert.equal(w.game.batchId, ao.native_batch_id + 1, 'next step automatically admits real work')
  assert.equal(w.game.mutations.filter(text => text.includes("'move_items_exact'")).length, 1, 'never replay the 34-plate transfer')
  assert.ok(w.events.some(row => row.event === 'plan.contract_prediction_fallback' && row.data.reason === 'prediction_owner_changed'))
  preserveAoRepair('prevention', w)
})

test('checker diagnoses original Run AO stale-contract unpaused idle, including the later operator stop', () => {
  const result = analyzeBehaviorTrace(ao.events)
  assert.ok(result.findings.some(row => row.signature === 'unpaused_idle_controller' && row.request_id === ao.resumed_request_id))
})

for (const boundary of ['plan.contract_requested', 'plan.contract_prediction_discarded', 'plan.contract_prediction_fallback']) {
  test(`current activation replaced during ${boundary} cannot bind, charge or pause replacement`, async () => {
    let armed = false
    const w = await aoWorld({ traceHook: ({ row, agent }) => {
      if (armed && row.event === boundary) {
        armed = false
        agent.traceRequest = { id: 'replacement-current-activation', usage: {} }
      }
    } })
    armed = true
    try { await w.close() } catch (error) { assert.match(error.message, /superseded|cancelled/i) }
    assert.equal(armed, false, 'race must occur inside the actual awaited trace boundary')
    assert.equal(w.held().steps[1].completion_contract, null, JSON.stringify(w.events.slice(-30).map(r => ({ event: r.event, request: r.request_id, reason: r.data?.reason }))))
    assert.equal(w.game.mutations.length, 1)
    assert.deepEqual(w.agent.traceRequest.usage, {})
    assert.equal(w.memory.pauseRecord(ao.key).paused, false)
  })
}
