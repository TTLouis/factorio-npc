import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { validatesAgainstSchema } from './control-json-repair.mjs'
import { authoredCompletionContractSupported, COMPLETION_CONTRACT_SCHEMA, evaluateCompletionContract, sanitizeStepCompletionContract } from './step-completion.mjs'
import { parseOperation, renderOperation, renderOperationPreflight, toolCommand, toolDefinitions } from './structured-policy.mjs'

const proposal = { goal_id: 'goal-1', plan_id: 'plan-1', x: -6, y: 2, width: 10, height: 8 }
const operation = { name: 'reserve_construction_area', args: { reservation_id: 4, revision: 1 } }
const checkpoint = { mode: 'all', requirements: [{ kind: 'area_reservation_state', reservation_id: 4, revision: 1, expected: 'reserved' }] }

test('reservation tools and operations accept only bounded typed data and expose no player approval authority', () => {
  assert.deepEqual(parseOperation(operation), operation)
  assert.match(renderOperation(operation), /reserve_construction_area.*4,1/)
  assert.match(renderOperationPreflight(operation), /reserve_construction_area.*reservation_id=4,revision=1/)
  assert.match(toolCommand('validateConstructionReservation', proposal), /goal_id='goal-1'.*plan_id='plan-1'.*x=-6,y=2,width=10,height=8/)
  for (const key of Object.keys(proposal)) { const invalid = { ...proposal }; delete invalid[key]; assert.throws(() => toolCommand('validateConstructionReservation', invalid)) }
  for (const invalid of [{ ...proposal, width: 33 }, { ...proposal, x: 0.5 }, { ...proposal, mode: 'auto' }]) assert.throws(() => toolCommand('validateConstructionReservation', invalid))
  for (const args of [{ reservation_id: 0, revision: 1 }, { reservation_id: 4, revision: 1.5 }, { ...operation.args, approve: true }]) assert.throws(() => parseOperation({ ...operation, args }))
  assert.ok(toolDefinitions.some(t => t.function.name === 'getReservationDesignInput'))
  assert.match(toolCommand('getReservationDesignInput', { reservation_id: 4, revision: 1, offset: 16 }), /designer_input',4,1,16/)
  assert.match(toolCommand('getReservationDesignInput', { reservation_id: 4, revision: 1 }), /designer_input',4,1,0/)
  assert.throws(() => toolCommand('getReservationDesignInput', { reservation_id: 4, revision: 1, offset: -1 }))
  assert.ok(toolDefinitions.every(t => !/player_control|designer_returned|approveReservation/.test(JSON.stringify(t))))
})

test('reservation completion schema and runtime require matching authoritative native state', () => {
  assert.equal(validatesAgainstSchema(checkpoint, COMPLETION_CONTRACT_SCHEMA), true)
  assert.equal(authoredCompletionContractSupported(checkpoint), true)
  const contract = sanitizeStepCompletionContract(checkpoint)
  const fact = { kind: 'area_reservation_state', reservation_id: 4, revision: 1, state: 'reserved', authoritative: true }
  const passes = value => evaluateCompletionContract(contract, { requirement_1: value }).satisfied
  assert.equal(passes(fact), true)
  for (const value of [{ ...fact, authoritative: false }, { ...fact, reservation_id: 5 }, { ...fact, revision: 2 }, { ...fact, state: 'validated' }, { kind: 'authoritative_operation_receipt', operation_name: operation.name, authoritative: true }]) assert.equal(passes(value), false)
  for (const expected of ['conflict', 'validated', 'approved']) {
    const invalid = { mode: 'all', requirements: [{ ...checkpoint.requirements[0], expected }] }
    assert.equal(validatesAgainstSchema(invalid, COMPLETION_CONTRACT_SCHEMA), false)
    assert.equal(authoredCompletionContractSupported(invalid), false)
  }
})

test('harness binds validation, mutation preflight and completion facts to the committed goal and plan', async () => {
  const events = []; let row = { id: 4, revision: 1, state: 'reserved', goal_id: 'goal-1', plan_id: 'plan-1' }
  const agent = new NpcAgentLoop({ npcId: 'sgluna', systemPrompt: '', stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async () => { throw new Error('inference forbidden') }, rcon: { command: async command => JSON.stringify(command.includes("'status'") ? { ok: true, reservations: [row] } : { ok: true, reservation: row }) },
    onActivity: (event, data) => events.push({ event, data }) })
  agent.activePlanKey = () => 'npc:sgluna'
  agent.memory.planningState = () => ({ goal: { goal_id: 'goal-1' }, active_plan_id: 'plan-1', plans: [{ plan_id: 'plan-1' }] })
  agent.assertCurrent = async () => true
  agent.traceRequest = { id: 'reservation-check' }
  assert.match(agent.observationToolCommand('validateConstructionReservation', proposal), /validate/)
  assert.throws(() => agent.observationToolCommand('validateConstructionReservation', { ...proposal, plan_id: 'old-plan' }))
  assert.equal((await agent.preflightOperations([operation]))[0].ok, true)
  const check = async () => evaluateCompletionContract(checkpoint, await agent.completionFactsForContract(checkpoint, undefined, [])).satisfied
  assert.equal(await check(), true)
  row = { ...row, plan_id: 'old-plan' }
  await assert.rejects(agent.preflightOperations([operation]), error => error.preflight?.code === 'reservation_plan_identity_mismatch')
  assert.equal(await check(), false)
  row = { ...row, plan_id: 'plan-1', revision: 2 }
  assert.equal(await check(), false)
  assert.ok(events.some(e => e.event === 'step.area_reservation_checked' && e.data.request_id === 'reservation-check' && e.data.reason === 'native_reservation_state_not_command_admission'))
})
