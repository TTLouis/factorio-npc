import assert from 'node:assert/strict'
import test from 'node:test'
import { captureDecisionBudgets, DECISION_BUDGET_FIELDS, restoreDecisionBudgets } from './decision-budgets.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

function world() {
  const agent = new NpcAgentLoop({ rcon: new FakeFactorio(), provider: async () => { throw new Error('no provider expected') },
    systemPrompt: 'Decision lifetime fixture.', npcId: 'sgluna', stateFile: null, traceFile: null, decisionTraceFile: null })
  const rows = []
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  return { agent, rows }
}
const values = agent => DECISION_BUDGET_FIELDS.map(field => agent[field])
const original = ['normal', 2, 1, ['inventory'], 'current_step']
const newer = ['deep', 3, 2, ['entities'], 'next_slice']
const set = (agent, selected) => DECISION_BUDGET_FIELDS.forEach((field, index) => { agent[field] = selected[index] })

test('a conversation replacement within a wake preserves ownership of all five decision overrides', async () => {
  const { agent, rows } = world()
  set(agent, original)
  const scope = captureDecisionBudgets(agent, { requestId: 'req_same_wake' })
  await agent.startExecutorObservationDecision({ requestId: 'req_same_wake', reason: 'fixture_executor_handoff' })
  agent.replaceConversation({ baseMessages: [{ role: 'user', content: 'Same wake, rebuilt context.' }] })
  assert.deepEqual(values(agent).slice(1, 4), [4, 4, null], 'the handoff seeds its own bounded decision')
  assert.equal(await restoreDecisionBudgets(agent, scope), true)
  assert.deepEqual(values(agent), original, 'the seeded decision cannot leak past its owning wake')
  const row = rows.at(-1)
  assert.equal(row.event, 'decision.budgets_restored')
  assert.deepEqual(row.data, { request_id: 'req_same_wake', reason: 'decision_scope_finished' })
})

for (const boundary of ['cancel', 'lineage']) {
  test(`${boundary} alone invalidates old decision cleanup without changing the newer overrides`, async () => {
    const { agent, rows } = world()
    set(agent, original)
    const scope = captureDecisionBudgets(agent, { requestId: `req_old_${boundary}` })
    if (boundary === 'cancel') agent.cancel('fixture_cancel')
    else agent.agentContext.beginLineage()
    set(agent, newer)
    assert.equal(await restoreDecisionBudgets(agent, scope), false)
    assert.deepEqual(values(agent), newer)
    assert.equal(rows.at(-1).event, 'decision.budgets_restore_skipped')
    assert.deepEqual(rows.at(-1).data, { request_id: `req_old_${boundary}`, reason: 'decision_owner_superseded' })
  })
}

test('a failed cleanup trace preserves restoration and never masks the original scope failure', async () => {
  const { agent } = world()
  set(agent, original)
  const scope = captureDecisionBudgets(agent, { requestId: 'req_cleanup_error' })
  agent.behaviorTrace = { emit: async () => { throw new Error('scripted trace failure') } }
  const originalError = new Error('original scope failure')
  await assert.rejects(async () => {
    try { set(agent, newer); throw originalError }
    finally { await restoreDecisionBudgets(agent, scope) }
  }, error => error === originalError)
  assert.deepEqual(values(agent), original)
})
