// This control deliberately imports ONLY the pre-existing loop API. Against
// 11d182c1 it fails because the exact bad checkpoint is accepted, not because a
// new helper/API/schema is absent. The step's typed intent is an explicitly
// labelled positive-fixture substitution; historical AV remains untyped.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const { NpcAgentLoop } = await import(process.env.AV_BASELINE_RUNTIME_MODULE ?? './npc-agent-loop.mjs')
const fixture = JSON.parse(readFileSync(new URL('./fixtures/run-av-contract-drift.json', import.meta.url)))
const actual = JSON.parse(fixture.exact_assistant_replies.tap_63.content).checkpoint
test('AV negative control: a correction may not add global preservation counts to declared typed outcomes', async () => {
  const loop = new NpcAgentLoop({ rcon: { command: async () => JSON.stringify({ ok: true, current: 1 }) },
    provider: async () => { throw new Error('provider forbidden') }, stateFile: null, traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Offline baseline comparator.' })
  const step = { obligations: { outcome: { mode: 'all', requirements: [actual.requirements[0], actual.requirements[3]] }, preserve: [21, 22] } }
  const result = await loop.validatePlannerCheckpointContract(actual, [], { plannerOnlyDraft: true, step })
  assert.equal(result.accepted, false, 'observed defect: the baseline accepts evaluable global counts introduced by the AV correction')
  assert.equal(result.reason, 'contract_obligation_mismatch')
})
