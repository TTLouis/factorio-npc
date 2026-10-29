import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { analyzeBehaviorTrace } from './run-check.mjs'
const original = JSON.parse(fs.readFileSync(new URL('./fixtures/bg-terminal-events.json', import.meta.url)))
test('BG original stock exhaustion is detected without calling it a preservation failure', () => {
  const result = analyzeBehaviorTrace(original.a)
  assert.equal(result.findings.filter(row => row.signature === 'stock_dependency_guard').length, 1)
  assert.equal(result.findings.some(row => row.signature === 'preservation_guard'), false)
})
test('BG original controller production pause is detected even without a request id', () => {
  for (const rows of [original.b, original.b.map(({ request_id: _request, ...row }) => row)]) {
    assert.equal(analyzeBehaviorTrace(rows).findings.filter(row => row.signature === 'production_binding_guard').length, 1)
  }
})
test('successful recovery markers and ordinary requests alone are not terminal guards', () => {
  const rows = ['stock_dependency.completed', 'production.recovery', 'production.admission_repaired', 'production.started', 'provider.response'].map(event => ({ event, ts: '2026-10-29T04:00:00Z', request_id: 'new' }))
  assert.equal(analyzeBehaviorTrace(rows).findings.some(row => ['stock_dependency_guard', 'production_binding_guard', 'production_controller_guard'].includes(row.signature)), false)
})

test('bounded stock barrier exhaustion is a visible terminal finding', () => {
  const rows = [{ event: 'stock_dependency.exhausted', ts: '2026-10-29T04:00:00Z', data: { reason: 'stock_dependency_limit_exhausted', goal_id: 'g', plan_id: 'p', step_id: 's' } }]
  assert.equal(analyzeBehaviorTrace(rows).findings.filter(row => row.signature === 'stock_dependency_guard').length, 1)
})

for (const reason of ['production_recovery_exhausted', 'production_producer_binding_unrepairable', 'production_task_exhausted', 'production_no_progress']) {
  test(`corrected producer terminal ${reason} reaches the checker without implying successful recovery`, () => {
    const rows = [
      { event: 'production.recovery', ts: '2026-10-29T04:00:00Z', data: { mechanism: 'exact_producer_binding', outcome: 'setup_required', plan_id: 'p', step_id: 's' } },
      { event: 'production.paused', ts: '2026-10-29T04:01:00Z', data: { reason, plan_id: 'p', step_id: 's' } },
    ]
    const result = analyzeBehaviorTrace(rows)
    assert.equal(result.findings.filter(row => ['production_binding_guard', 'production_controller_guard'].includes(row.signature)).length, 1)
    assert.equal(analyzeBehaviorTrace(rows.slice(0, 1)).findings.some(row => ['production_binding_guard', 'production_controller_guard'].includes(row.signature)), false)
  })
}

for (const row of [
  { event: 'request.blocked_plan_paused', data: { reason: 'blocked_decision_with_idle_native_runtime', code: 'production_producer_unbound', pause_class: 'guard' } },
  { event: 'production.admission_exhausted', data: { reason: 'production_producer_unbound', attempts: 2, limit: 2 } },
]) test(`${row.event} makes exhausted producer correction visible`, () => {
  const result = analyzeBehaviorTrace([{ ...row, ts: '2026-10-29T04:00:00Z', request_id: 'r' }])
  assert.equal(result.findings.filter(item => item.signature === 'production_binding_guard').length, 1)
})
