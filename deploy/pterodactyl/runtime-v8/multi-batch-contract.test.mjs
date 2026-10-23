import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { activeStepVerifiedOperationNames, applyPlanningEvent, getActivePlan, PLANNING_EVENT, restorePlanningState, serializePlanningState } from './planning-state.mjs'
import { FakeFactorio, gather, planReply, recordingJev } from './task-loop-fixtures.mjs'

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/run-al-multi-batch-contract.json', import.meta.url), 'utf8'))
const KEY = 'npc:sgluna'
const coal = fixture.coal_step
const iron = fixture.failed_step
const supply = fixture.failed_proposal.data.operations.map(({ name, args }) => ({ name, args }))
const collect = { name: 'move_items_exact', args: { unit_number: 38, item_name: 'iron-plate', max_count: 50, to_entity: false } }

// Reduce the earlier placement steps to their observed world preconditions;
// replay the exact AL failed step/contract/two-coal batch after a genuine JIT
// boundary. Fake native receipts go through admission and reconciliation.
function world({ resend = true } = {}) {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 8 } })
  game.knownTechnologies.add('steam-power')
  game.nearby.actor_position = { x: -74.4453125, y: -70.328125 }
  game.nearby.entities = [
    { unit_number: 37, name: 'burner-mining-drill', type: 'mining-drill', position: { x: -83, y: -70 } },
    { unit_number: 38, name: 'stone-furnace', type: 'furnace', position: { x: -84, y: -72 } },
  ]
  game.onMutation = text => {
    const proof = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: game.status.actor_id, accepted: true, completed: true, code: 'completed', type: 'moving_items', target_unit_number: 38 }
    if (text.includes("'supply_entity'")) game.lastBasicResult = { ...proof, moved_count: 1, to_entity: true }
    if (text.includes("'move_items_exact'")) game.lastBasicResult = { ...proof, moved_count: 50, to_entity: false }
  }
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  let calls = 0
  let contractCalls = 0
  let goalBaseline
  const step = () => getActivePlan(memory.planningState(KEY))?.steps[1]
  const jev = recordingJev()
  const agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'sgluna', completionProtocolVersion: 3,
    systemPrompt: 'Run AL multi-batch regression.', stateFile: null, traceFile: null, decisionTraceFile: null,
    interactionDecisionProvider: jev, steeringDecisionProvider: jev,
    provider: async (_messages, context) => {
      if (context.triggerSource === 'step_contract') {
        contractCalls++
        return { content: JSON.stringify({ stepId: step().step_id, checkpoint: iron.completion_contract }) }
      }
      calls++
      if (calls === 1) return planReply({ plan: [coal.description, iron.description], currentStep: 0, operations: [],
        stepCompletions: [{ kind: 'deterministic', checkpoint: coal.completion_contract }, { kind: 'deterministic' }],
        executionGuidance: [coal, iron].map(s => ({ ...s.execution_guidance, skillIds: [] })),
        goal: { scope: 'long_horizon', summary: fixture.goal.summary, doneWhen: fixture.goal.done_when },
        roadmap: fixture.roadmap.map(({ id, intent, why_it_matters, depends_on }) => ({ id, intent, why_it_matters, depends_on })),
        roadmapNodeIds: ['iron-bootstrap'] })
      if (calls === 2) return planReply({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [gather('coal', 20)] })
      if (calls === 3) return { content: '', tool_calls: [{ id: 'al-exact-machines', type: 'function', function: { name: 'getNearbyEntities', arguments: '{"radius":32}' } }] }
      if (calls === 4) {
        goalBaseline = structuredClone(getActivePlan(memory.planningState(KEY)).steps)
        return planReply({ stepId: step().step_id, operations: supply, ...(resend ? { checkpoint: iron.completion_contract } : {}) })
      }
      if (calls === 5) return planReply({ stepId: step().step_id, operations: [collect], ...(resend ? { checkpoint: iron.completion_contract } : {}) })
      throw new Error(`Unscripted call ${calls} role=${context.role}: ${JSON.stringify(events.slice(-16).map(r => ({event:r.event,reason:r.data?.reason,error:r.data?.error})))}`)
    },
  })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  return { game, memory, agent, events, step, calls: () => calls, contractCalls: () => contractCalls,
    committedSteps: () => goalBaseline,
    async fuel() {
      await agent.request(fixture.goal.summary, { sender: 'Louis' })
      game.inventory.coal = 20
      await agent.completed()
    },
  }
}

for (const resend of [true, false]) {
  test(`Run AL exact deferred step-4 contract allows fueling then plate collection in separate batches (checkpoint resent=${resend})`, async () => {
    const w = world({ resend })
    await w.fuel()
    assert.equal(w.contractCalls(), 1, JSON.stringify(w.events.filter(row => /contract_prediction/.test(row.event))))
    assert.equal(w.step().contract_binding.binding, 'prediction')
    assert.equal(w.calls(), 4, JSON.stringify(w.events.filter(r => /rejected|refused|failed|recovery|plan.accepted/.test(r.event)).map(r => ({event:r.event,data:r.data}))))
    assert.equal(w.game.mutations.length, 2, 'coal gathering then the exact two-supply batch are admitted')
    assert.match(w.game.mutations[1], /supply_entity',37/)
    assert.match(w.game.mutations[1], /supply_entity',38/)
    assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 1)
    assert.deepEqual(w.step().completion_contract.requirements, iron.completion_contract.requirements)
    if (resend) assert.ok(w.events.some(r => r.event==='step.checkpoint_batch_deferred'
      && r.data.request_id && r.data.reason==='committed_step_contract_spans_operation_batches'
      && r.data.receipt_names.includes('move_items_exact')))

    // Even with live stock and research met, the collection receipt is still
    // missing. Fuel completion cannot advance the step or finish the goal.
    w.game.inventory['iron-plate'] = 58
    w.game.researched.add('steam-power')
    await w.agent.completed()
    assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 1)
    assert.equal(w.game.mutations.length, 3, 'collection is a later separately admitted batch')
    assert.match(w.game.mutations[2], /move_items_exact/)
    assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)), ['supply_entity'], JSON.stringify(getActivePlan(w.memory.planningState(KEY)).execution.receipts))

    // Preserve the already completed fueling across a durable memory roundtrip.
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(JSON.parse(JSON.stringify(w.memory.snapshot())))
    w.agent.memory = restored
    assert.deepEqual(activeStepVerifiedOperationNames(restored.planningState(KEY)), ['supply_entity'])
    const receipt = await w.agent.taskStatusReceipt()
    const result = await w.agent.routeStepCompletionDecision(receipt)
    assert.equal(result.verified, true, 'both receipt types plus fresh stock/research satisfy the whole step')
    assert.equal(restored.currentPlan(KEY).task_board.completed_count, 2)
    assert.deepEqual(getActivePlan(restored.planningState(KEY)).steps, w.committedSteps(), 'contracts and guidance remain immutable')
    const proofs = w.events.filter(r => r.event==='step.receipt_progress_checked')
    assert.ok(proofs.some(r => r.data.request_id && r.data.operation_names.includes('supply_entity') && r.data.operation_names.includes('move_items_exact')))
  })
}

test('Run AL refuses premature completion when collection finishes but live iron/research outcomes are unmet', async () => {
  const w = world()
  await w.fuel()
  await w.agent.completed()
  const receipt = await w.agent.taskStatusReceipt()
  const result = await w.agent.routeStepCompletionDecision(receipt)
  assert.equal(result.verified, false)
  assert.equal(w.memory.currentPlan(KEY).task_board.completed_count, 1)
})

test('only runtime-verified receipts in the active plan and step accumulate; admission/error/prose and stale plans cannot count', async () => {
  const w = world()
  await w.fuel()
  let state = w.memory.planningState(KEY)
  const plan = getActivePlan(state)
  const event = (kind, stepId = plan.steps[1].step_id, extra = {}) => ({ type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED,
    source: 'runtime', goal_id: state.goal.goal_id, plan_id: plan.plan_id, step_id: stepId,
    kind, ref: 'batch_999', summary: JSON.stringify({ verdict: 'verified_complete', operations: ['move_items_exact'] }), ...extra })
  for (const kind of ['operation_receipt','operation_error_receipt','operation_preflight_blocker']) state=applyPlanningEvent(state,event(kind))
  state=applyPlanningEvent(state,event('deterministic_verification',plan.steps[0].step_id))
  state=applyPlanningEvent(state,event('deterministic_verification',undefined,{plan_id:'superseded-plan'}))
  state=applyPlanningEvent(state,event('deterministic_verification',undefined,{goal_id:'other-goal'}))
  state=applyPlanningEvent(state,event('deterministic_verification',undefined,{summary:'move_items_exact completed'}))
  assert.deepEqual(activeStepVerifiedOperationNames(restorePlanningState(serializePlanningState(state))), [])
})

test('a collection receipt with no verified transfer effect cannot finish Run AL even when live stock and research are met', async () => {
  const w = world()
  await w.fuel()
  w.game.inventory['iron-plate']=58
  w.game.researched.add('steam-power')
  await w.agent.completed()
  w.game.lastBasicResult.moved_count=0
  const result=await w.agent.routeStepCompletionDecision(await w.agent.taskStatusReceipt())
  assert.equal(result.verified,false)
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(KEY)),['supply_entity'])
})

test('an executor cannot replace the committed Run AL contract while progressing a partial batch', async () => {
  const w = world()
  await w.fuel()
  const before=structuredClone(w.step().completion_contract)
  const result=await w.agent.persistPlannerCheckpoint({ checkpoint:{mode:'all',requirements:[{kind:'inventory_count',item_name:'iron-plate',minimum:8}]},operations:supply })
  assert.equal(result.ignored,true)
  assert.deepEqual(w.step().completion_contract,before)
})
