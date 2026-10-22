import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { activeStepVerifiedOperationNames, getActivePlan } from './planning-state.mjs'
import { normalizePlannerReview, repairPlannerReview } from './role-contracts.mjs'
import { FakeFactorio } from './task-loop-fixtures.mjs'

const am = JSON.parse(await fs.readFile(new URL('./fixtures/run-am-receipt-liveness.json', import.meta.url), 'utf8'))
const review = am.refused_decision.plannerReview
const gather = { name: 'gather_resource', args: { resource_name: 'coal', count: 1, search_radius: 32 } }

function recordedWorld({ count = 2, receipt = 'verified', onCount, firstAction = false, finalSlice = false, invalidNextContract = false } = {}) {
  const snapshot = structuredClone(am.memory)
  if (finalSlice) {
    const legacy = snapshot.plans[0].state
    legacy.plan = legacy.plan.slice(0, 4)
    legacy.task_board.steps = legacy.task_board.steps.slice(0, 4)
    getActivePlan(snapshot.planning_states[0].state).steps = getActivePlan(snapshot.planning_states[0].state).steps.slice(0, 4)
  }
  if (receipt !== 'verified') {
    snapshot.plans[0].state.task_board.evidence = snapshot.plans[0].state.task_board.evidence
      .filter(row => !(row.kind === 'deterministic_verification' && row.step_id === 'step_4'))
    const state = snapshot.planning_states[0].state
    const held = getActivePlan(state)
    if (held?.steps?.[3]) delete held.execution.receipts[held.steps[3].step_id]
  }
  const memory = new CanonicalTaskBoardMemory()
  memory.restore(snapshot)
  const game = new FakeFactorio()
  Object.assign(game.status, { actor_id: 8, epoch: 1, connected_players: 0 })
  const native = game.command.bind(game)
  const calls = []
  const events = []
  let reads = 0
  let agent
  game.command = async text => {
    if (text.includes('evaluate_condition') && text.includes('entity_count')) {
      reads++
      await onCount?.({ agent, memory, game, reads })
      if (count === 'unreadable') return '{"ok":false,"error":"unavailable"}'
      const prototype = text.includes('stone-furnace') ? 'stone-furnace' : 'burner-mining-drill'
      return JSON.stringify({ ok: true, kind: 'entity_count', prototype, minimum: 2,
        current: prototype === 'stone-furnace' ? 1 : count, found: count, truncated: false, satisfied: prototype !== 'stone-furnace' && count >= 2 })
    }
    return native(text)
  }
  const held = () => getActivePlan(memory.planningState(am.key))
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'npc-1', completionProtocolVersion: 3,
    systemPrompt: 'Recorded AM autonomous reconciliation fixture', stateFile: null, traceFile: null, decisionTraceFile: null,
    provider: async (_messages, context) => {
      if (context.triggerSource === 'step_contract') return { content: invalidNextContract ? '{}' : JSON.stringify({ stepId: held().steps[held().active_step_index].step_id,
        checkpoint: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 2 }] } }) }
      calls.push(context)
      assert.ok(calls.length <= 2, JSON.stringify(events.filter(row => row.event === 'replan.started').map(row => row.data.reason)))
      if (calls.length === 1) {
        if (!firstAction) return structuredClone(am.refused_reply)
        return { content: '', tool_calls: [{ id: 'redundant-placement', type: 'function', function: { name: 'submitPlan',
          arguments: JSON.stringify({ stepId: held().steps[3].step_id,
            operations: [{ name: 'place_entity', args: { entity_name: 'burner-mining-drill', x: -66, y: 96, direction: 0 } }] }) } }] }
      }
      assert.equal(held().active_step_index, 4, 'executor continues only after the recorded copper step actually closes')
      return { content: '', tool_calls: [{ id: 'next-step-action', type: 'function', function: { name: 'submitPlan',
        arguments: JSON.stringify({ stepId: held().steps[4].step_id, operations: [gather] }) } }] }
    } })
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: am.key,
    requestInfo: { memoryKey: am.key, turnId: 1, sender: '<server>', text: 'Continue the committed copper cell' },
    traceRequest: { id: 'run-am-self-correction' } })
  agent.agentContext.beginLineage('executor')
  agent.behaviorTrace = { emit: async row => events.push(row) }
  return { agent, memory, game, calls, events, held, reads: () => reads }
}

test('exact Run AM review is clipped, reconciled from recorded proof and fresh world state, then next-step execution continues automatically', async () => {
  const w = recordedWorld()
  const original = structuredClone(w.held().steps[3])
  const allowance = structuredClone(w.memory.autoResumeAllowance(am.key))
  await w.agent.runGuardedTurn()
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.deepEqual(w.held().steps[3], original, 'immutable descriptions, guidance and completion contract remain intact')
  assert.deepEqual(activeStepVerifiedOperationNames(w.memory.planningState(am.key)), [], 'previous step proof cannot migrate to the next step')
  assert.equal(w.calls.length, 2, JSON.stringify(w.events.filter(row => row.event === 'replan.started').map(row => row.data.reason)))
  assert.equal(w.game.mutations.length, 1)
  assert.match(w.game.mutations[0], /gather_resource/)
  assert.doesNotMatch(w.game.mutations[0], /place_entity|place_candidate|mine_entity/)
  assert.equal(w.memory.pauseRecord(am.key).paused, false)
  assert.equal(w.memory.autoResumeAllowance(am.key).goal_attempts, allowance.goal_attempts, 'does not replenish or spend an automatic resume')
  assert.equal(w.events.filter(row => row.event === 'executor.planner_review_requested').length, 0)
  for (const [event, reason] of [['executor.review_advisory_repaired', 'advisory_rationale_length_clipped'],
    ['executor.review_reconciled', 'committed_checkpoint_already_satisfied']]) {
    assert.ok(w.events.some(row => row.event === event && row.request_id === 'run-am-self-correction' && row.data.reason === reason))
  }
  assert.equal(w.events.filter(row => row.event === 'plan.step_closed_on_fresh_read').length, 1)
})

test('idle settlement recovers the recorded mixed contract without needing a new completion signal or model decision', async () => {
  const w = recordedWorld()
  assert.equal((await w.agent.settleIdleStepCheckpoint()).closed, true)
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.equal(w.calls.length, 0)
  assert.equal(w.game.mutations.length, 0)
})

test('a duplicate placement proposal is discarded after verified mixed-checkpoint settlement and only newly authored next-step work runs', async () => {
  const w = recordedWorld({ firstAction: true })
  await w.agent.runGuardedTurn()
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.equal(w.calls.length, 2)
  assert.equal(w.game.mutations.length, 1)
  assert.doesNotMatch(w.game.mutations[0], /place_entity|place_candidate/)
  assert.ok(w.events.some(row => row.event === 'plan.step_closed_on_fresh_read' && row.data.operations_not_run.includes('place_entity')))
})

test('a reconciled final slice uses ordinary goal settlement and cannot declare an unmet user goal complete', async () => {
  const w = recordedWorld({ finalSlice: true })
  let settlements = 0
  const settle = w.agent.settleCompletedStepState.bind(w.agent)
  w.agent.settleCompletedStepState = async (state, options) => {
    settlements++
    assert.equal(options.withinTurn, true)
    assert.equal(state.status, 'completed')
    // Stop before a genuinely new slice needs a model. The production goal
    // settlement is separately exercised below with continuation disabled.
    return { settled: true }
  }
  const result = await w.agent.runGuardedTurn()
  assert.equal(result.settled, true)
  assert.equal(settlements, 1)
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.equal(w.memory.planningState(am.key).goal.status, 'active')
  assert.equal(w.calls.length, 1)
  assert.equal(w.game.mutations.length, 0)
  w.agent.settleCompletedStepState = settle
  await settle(w.memory.currentPlan(am.key), { allowContinuation: false, withinTurn: true })
  assert.equal(w.memory.planningState(am.key).goal.status, 'active', 'step/slice proof does not satisfy the red-science goal')
})

for (const options of [{ count: 1 }, { count: 'unreadable' }, { receipt: 'unverified' }]) {
  test(`recorded mixed contract stays open with ${JSON.stringify(options)}`, async () => {
    const w = recordedWorld(options)
    const result = await w.agent.settleIdleStepCheckpoint()
    assert.equal(result.closed, false)
    assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 3)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.calls.length, 0)
  })
}

for (const fence of ['busy', 'pending', 'amendment', 'actor', 'goal', 'version', 'step']) {
  test(`self-correction respects ${fence} fence`, async () => {
    const w = recordedWorld({ onCount: ({ game, memory }) => {
      if (fence === 'actor') game.status.epoch++
      if (fence === 'goal') memory.planningState(am.key).goal.goal_id = 'new-owner'
      if (fence === 'version') w.held().plan_version++
      if (fence === 'step') w.held().active_step_index++
    } })
    if (fence === 'busy') { w.game.taskState = 'placing'; w.game.queueLength = 1 }
    if (fence === 'pending') w.memory.pendingOperation = () => ({ state: 'uncertain' })
    if (fence === 'amendment') w.agent.pendingInteractionAmendment = { sender: 'Louis', text: 'Pending change' }
    try { assert.equal((await w.agent.settleIdleStepCheckpoint()).closed, false) }
    catch (error) { assert.match(error.message, /epoch|superseded|cancelled/) }
    assert.equal(w.events.some(row => row.event === 'plan.step_closed_on_fresh_read'), false)
    assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, fence === 'step' ? 4 : 3, 'no progress beyond the externally advanced step')
    assert.equal(w.game.mutations.length, 0)
  })
}

test('advisory overflow repair is bounded and cannot repair authority, extra fields or invalid structure', () => {
  for (const length of [400, 401, 402, 800]) {
    const original = { ...review, rationale: 'x'.repeat(length) }
    const result = repairPlannerReview(original)
    assert.equal(result.review.rationale.length, 400)
    assert.equal(result.repaired, length > 400)
    assert.deepEqual(normalizePlannerReview(result.review), result.review)
    assert.equal(original.rationale.length, length)
  }
  for (const bad of [{ ...review, rationale: 'x'.repeat(801) }, { ...review, rationale: '' },
    { ...review, reason: 'replace_plan' }, { ...review, operations: [gather] }, { ...review, rationale: 402 }]) {
    assert.throws(() => repairPlannerReview(bad))
  }
})

for (const change of ['goal', 'version', 'step']) {
  test(`review cannot escalate an unmet reading after ${change} ownership changes`, async () => {
    const w = recordedWorld({ count: 1, onCount: ({ memory }) => {
      if (change === 'goal') memory.planningState(am.key).goal.goal_id = 'replacement'
      if (change === 'version') w.held().plan_version++
      if (change === 'step') w.held().active_step_index++
    } })
    const stepId = w.held().steps[3].step_id
    await assert.rejects(w.agent.handlePlannerReview({ operations: [], plannerReview: { ...review, rationale: review.rationale.slice(0, 400) } }, stepId), /superseded|cancelled/)
    assert.equal(w.agent.active, true)
    assert.equal(w.memory.pauseRecord(am.key).paused, false)
    assert.equal(w.events.some(row => row.event === 'executor.planner_review_requested'), false)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.calls.length, 0)
  })
}

test('replacement during reconciliation trace cannot reach continuation messages, resets or operations', async () => {
  const w = recordedWorld()
  const emit = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => {
    await emit(row)
    if (row.event === 'executor.review_reconciled') w.memory.planningState(am.key).goal.goal_id = 'replacement-during-trace'
  }
  const messages = structuredClone(w.agent.messages)
  await assert.rejects(w.agent.handlePlannerReview({ operations: [], plannerReview: { ...review, rationale: review.rationale.slice(0, 400) } }, w.held().steps[3].step_id), /superseded|cancelled/)
  assert.deepEqual(w.agent.messages, messages)
  assert.equal(w.agent.active, true)
  assert.equal(w.agent.traceRequest.id, 'run-am-self-correction')
  assert.equal(w.calls.length, 0)
  assert.equal(w.game.mutations.length, 0)
  assert.ok(w.events.some(row => row.event === 'step.reconciliation_superseded' && row.request_id && row.data.reason === 'checkpoint_owner_changed'))
})

test('a reconciled review preserves the intentional next-contract pause and its player explanation', async () => {
  const w = recordedWorld({ invalidNextContract: true })
  const result = await w.agent.runGuardedTurn()
  assert.equal(result.goalStatus, 'paused')
  assert.match(result.chatMessage, /could not get a valid completion checkpoint.*Resume/)
  assert.equal(w.agent.active, false)
  assert.equal(w.memory.currentPlan(am.key).task_board.completed_count, 4)
  assert.equal(w.memory.pauseRecord(am.key).pause_reason, 'step_contract_unavailable')
  assert.equal(w.calls.length, 1)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.events.some(row => row.event === 'executor.planner_review_requested'), false)
})

test('replacement during a terminal contract-pause trace supersedes the old review result', async () => {
  const w = recordedWorld({ invalidNextContract: true })
  const emit = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => {
    await emit(row)
    if (row.event === 'plan.step_closed_on_fresh_read') {
      w.memory.planningState(am.key).goal.goal_id = 'replacement-after-pause'
      w.agent.traceRequest = { id: 'new-request' }
      w.agent.active = true
    }
  }
  await assert.rejects(w.agent.handlePlannerReview({ operations: [], plannerReview: { ...review, rationale: review.rationale.slice(0, 400) } }, w.held().steps[3].step_id), /superseded|cancelled/)
  assert.equal(w.agent.traceRequest.id, 'new-request')
  assert.equal(w.agent.active, true)
  assert.equal(w.game.mutations.length, 0)
})

for (const work of ['native_busy', 'new_pending']) {
  test(`review defers to ${work} discovered after the initial idle actor reading`, async () => {
    const w = recordedWorld({ onCount: ({ memory }) => {
      if (work === 'new_pending') memory.pendingOperation = () => ({ state: 'admitted' })
    } })
    if (work === 'native_busy') { w.game.taskState = 'placing'; w.game.queueLength = 1 }
    assert.equal(w.game.status.idle, true, 'the newer task-status read must win over deployment idle')
    const before = structuredClone(w.held().steps)
    const allowance = structuredClone(w.memory.planningState(am.key).goal.review_continuation_steps)
    const result = await w.agent.handlePlannerReview({ operations: [], plannerReview: { ...review, rationale: review.rationale.slice(0, 400) } }, w.held().steps[3].step_id)
    assert.equal(result.waitingForNativeReceipt, true)
    assert.equal(w.agent.active, true, 'ordinary completion/error callbacks remain enabled')
    assert.equal(w.agent.traceRequest.id, 'run-am-self-correction')
    assert.equal(w.memory.pauseRecord(am.key).paused, false)
    assert.deepEqual(w.held().steps, before)
    assert.deepEqual(w.memory.planningState(am.key).goal.review_continuation_steps, allowance)
    assert.equal(w.calls.length, 0)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.events.some(row => row.event === 'executor.planner_review_requested'), false)
    assert.ok(w.events.some(row => row.event === 'executor.review_deferred' && row.request_id && row.data.reason === 'native_work_or_receipt_in_progress'))
    assert.ok(w.events.some(row => row.event === 'request.waiting'))
  })
}
