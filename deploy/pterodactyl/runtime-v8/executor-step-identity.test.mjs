import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE_PROMPT } from './agent-roles.mjs'
import { compactCompletionReceipt } from './provider-base.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { FakeFactorio, planReply, recordingJev } from './task-loop-fixtures.mjs'

// Executor step identity (Haiku live run 2026-10-08, request req_muz4y1hy_1). An executor binds its operations to the
// committed active step by the stable step id from [CONTROL_DECISION_STATE]; the plan list and currentStep it echoes no
// longer decide ownership. A reply without the id keeps the index rule, and a refusal is a bounded correction (2 per
// active step), not a failed request. Both executor replies below are the recorded live replies, byte for byte.
// Static scenarios: a fake Factorio and scripted model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'
const GOAL = { scope: 'long_horizon', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const SHELF = [{ id: 'node_start', intent: 'iron and copper plates in hand' }]
const STEPS = [
  'Gather 10 iron ore',
  'Place the stone furnace, fuel it, and smelt at least 50 iron plates total',
  'Hand-mine copper ore and smelt at least 20 copper plates',
]
const checkpoint = (item, minimum) => ({ mode: 'all', requirements: [{ id: 'requirement_1', kind: 'inventory_count', item_name: item, minimum }] })
const STEP_COMPLETIONS = [
  { kind: 'deterministic', checkpoint: checkpoint('iron-ore', 10) },
  { kind: 'deterministic', checkpoint: checkpoint('iron-plate', 50) },
  { kind: 'deterministic', checkpoint: checkpoint('copper-plate', 20) },
]

// Recorded executor reply 2: step 2's checkpoint is met, so the harness closes step 2 on a fresh read.
const RECORDED_STEP_TWO_REPLY = '{"chatMessage":"Step 2 checkpoint is met: my inventory holds 58 iron plates (requirement: at least 50), after the furnace at (-78,5) output 50 plates to me. Handing off to the next committed step.","plan":["Place the stone furnace, fuel it, and smelt at least 50 iron plates total","Hand-mine copper ore and smelt at least 20 copper plates"],"currentStep":1,"operations":[],"checkpoint":{"mode":"all","requirements":[{"id":"requirement_1","kind":"inventory_count","item_name":"iron-plate","minimum":50}],"confidence":0}}'
// Recorded executor reply 4: indexes the two-entry list it last saw (currentStep 1 = "Hand-mine copper ...") while the
// committed plan has three steps and step 3 is index 2.
const RECORDED_COPPER_REPLY = '{"chatMessage":"Copper step is now active. I\'ll start by hand-mining 20 copper ore from the nearest copper patch. Smelting copper comes after that, once I\'ve re-checked the furnace state. This batch only starts the mining.","plan":["Place the stone furnace, fuel it, and smelt at least 50 iron plates total","Hand-mine copper ore and smelt at least 20 copper plates"],"currentStep":1,"operations":[{"name":"gather_resource","args":{"resource_name":"copper-ore","count":20,"search_radius":256}}]}'

const withStepId = (content, stepId) => ({ content: JSON.stringify({ ...JSON.parse(content), stepId }) })
const recorded = content => ({ content })

function plannerCommit(extra = {}) {
  return planReply({
    ...extra,
    plan: STEPS,
    currentStep: 0,
    operations: [{ name: 'gather_resource', args: { resource_name: 'iron-ore', count: 10, search_radius: 32 } }],
    stepCompletions: STEP_COMPLETIONS,
    goal: GOAL,
    roadmap: SHELF,
  })
}

// The real loop against a fake Factorio. The planner commits the three-step slice, step 1 closes on the game, the
// executor submits recorded reply 2 (step 2 is already met), and the replies after it follow.
function harness(afterStepTwo, { plannerExtra } = {}) {
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  // The reply with no operations meets the finite-goal nudge once (the harness asks for an action or a grounded claim),
  // and the same reply sent again is what the harness settles: step 2's checkpoint is met, so it closes on a fresh read.
  const script = [plannerCommit(plannerExtra), recorded(RECORDED_STEP_TWO_REPLY), recorded(RECORDED_STEP_TWO_REPLY), ...afterStepTwo]
  const calls = []
  const trace = []
  const jev = recordingJev(async (_state, questions) => (questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined))
  const agent = new NpcAgentLoop({
    rcon: game,
    memory,
    provider: async (messages) => {
      calls.push(messages.map(message => ({ ...message })))
      const entry = script[calls.length - 1]
      assert.ok(entry, `unscripted provider call ${calls.length}`)
      // An entry may be a function of the world, for replies that name a step id the plan only gets once committed.
      const next = typeof entry === 'function' ? entry(world) : entry
      return { ...next }
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'executor step identity test system prompt',
    goalDefinitionPolicy: 'required',
    completionProtocolVersion: 2, // production: version 2 refuses any step-index mismatch
    maxContinuations: 64,
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
  })
  agent.behaviorTrace = { emit: async (record) => { trace.push(record) } }
  const world = {
    agent,
    game,
    memory,
    calls,
    rows: event => trace.filter(record => record.event === event),
    tracker: () => getActivePlan(memory.planningState(KEY)),
    board: () => memory.currentPlan(KEY),
    // Runs to the executor's reply for step 3 (the harness closes steps 1 and 2 on the way).
    async toStepThree() {
      await agent.request('get iron and copper plates', { sender: 'TTLouis' })
      game.inventory['iron-ore'] = 10
      game.inventory['iron-plate'] = 58
      return agent.completed()
    },
  }
  return world
}

const textOf = message => (typeof message?.content === 'string' ? message.content : '')
const harnessMessagesOf = messages => messages.map(textOf).filter(text => text.startsWith('[HARNESS]'))
const stepThreeOf = world => world.tracker().steps[2]
const stepTwoOf = world => world.tracker().steps[1]

test('prompt: the executor is told to send the active step id from CONTROL_DECISION_STATE, and no longer to echo the plan and index', () => {
  assert.ok(EXECUTOR_ROLE_PROMPT.includes('In submitPlan send stepId as the active step id from [CONTROL_DECISION_STATE]; plan and currentStep are not needed. The harness ignores plan changes from you and records that it did.'))
  assert.doesNotMatch(EXECUTOR_ROLE_PROMPT, /currentStep as the active step index/)
  assert.doesNotMatch(EXECUTOR_ROLE_PROMPT, /plan as the committed steps unchanged/)
})

test('recorded reply 4 as-is (no stepId): the legacy index rule refuses it, and the refusal is a bounded correction, not request.failed or a pause', async () => {
  const world = harness([recorded(RECORDED_COPPER_REPLY), w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()

  assert.equal(world.calls.length, 5, 'planner, step-2 reply (nudged, then settled), legacy reply (corrected), bound reply')
  const [stale] = world.rows('executor.stale_step_rejected')
  assert.equal(stale.data.incoming_step_index, 1)
  assert.equal(stale.data.expected_step.index, 2)
  assert.equal(stale.data.expected_step.stepId, stepThreeOf(world).step_id)
  assert.equal(stale.data.reason, 'step_index_not_the_active_step')
  assert.ok(stale.data.request_id)
  const [legacy] = world.rows('executor.legacy_step_index_used')
  assert.equal(legacy.data.incoming_step_index, 1)
  assert.equal(legacy.data.reason, 'reply_without_step_id_uses_index_rule')
  assert.equal(legacy.data.request_id, stale.data.request_id)

  const [correction] = world.rows('executor.step_identity_correction')
  assert.equal(correction.data.request_id, stale.data.request_id)
  assert.equal(correction.data.step_id, stepThreeOf(world).step_id)
  assert.equal(correction.data.attempt, 1)
  assert.equal(correction.data.limit, 2)
  assert.equal(correction.data.reason, 'step_index_not_the_active_step')
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.rows('goal.paused').length, 0)
  assert.equal(world.board().status, 'active')
  assert.equal(world.agent.planCategoryRetries, 0, 'the shared plan_category allowance was not spent')

  const message = harnessMessagesOf(world.calls[4]).at(-1)
  // The index pointed at text identical to the active step's own, so the message does not call that text "not the active step".
  assert.equal(message, `[HARNESS] Operations were sent with step index 1; nothing ran. The active step is "${STEPS[2]}" (stepId ${stepThreeOf(world).step_id}, index 2). The committed plan is unchanged.`)
  assert.equal(world.game.mutations.length, 2, 'the planner batch and the bound executor batch; the refused reply ran nothing')
})

test('recorded reply 4 plus the active step id: accepted, bound by id, and the operation is admitted for step 3', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()

  const [bound] = world.rows('executor.step_bound')
  assert.equal(bound.data.step_id, stepThreeOf(world).step_id)
  assert.equal(bound.data.reason, 'step_id_matches_active_step')
  assert.ok(bound.data.request_id)
  assert.equal(world.rows('executor.stale_step_rejected').length, 0)
  assert.equal(world.rows('executor.step_identity_correction').length, 0)
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.game.mutations.length, 2)
  assert.match(world.game.mutations[1], /copper-ore/)
  assert.equal(world.board().task_board.completed_count, 2, 'steps 1 and 2 closed; step 3 is the one the batch serves')
  assert.equal(world.board().task_board.active_index, 2, 'step 3 is the board active step')
  // The committed plan and its progress are the harness's, not the reply's: the echoed two-entry list changed nothing.
  assert.deepEqual(world.tracker().steps.map(step => step.description), STEPS)
  assert.equal(world.tracker().active_step_index, 2)
})

test('a stepId naming the closed step 2 is refused and corrected, and nothing is admitted for it', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepTwoOf(w).step_id), w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()

  const [stale] = world.rows('executor.stale_step_rejected')
  assert.equal(stale.data.incoming_step_id, stepTwoOf(world).step_id)
  assert.equal(stale.data.reason, 'step_id_names_another_step')
  assert.equal(stale.data.expected_step.stepId, stepThreeOf(world).step_id)
  const [correction] = world.rows('executor.step_identity_correction')
  assert.equal(correction.data.incoming_step_id, stepTwoOf(world).step_id)
  assert.equal(correction.data.attempt, 1)
  assert.equal(world.rows('executor.legacy_step_index_used').length, 1, 'only the id-less step-2 reply used the index rule; a reply with an id never does')
  const message = harnessMessagesOf(world.calls[4]).at(-1)
  assert.ok(message.startsWith(`[HARNESS] Operations were sent for step "${STEPS[1]}", stepId ${stepTwoOf(world).step_id}, which is not the active step; nothing ran. `))
  assert.ok(message.endsWith(`The active step is "${STEPS[2]}" (stepId ${stepThreeOf(world).step_id}). The committed plan is unchanged.`))
  // Only the corrected reply reached admission.
  assert.equal(world.game.mutations.length, 2)
  assert.equal(world.rows('executor.step_bound').length, 1)
  assert.equal(world.calls.length, 5)
  assert.equal(world.rows('request.failed').length, 0)
})

test('two consecutive wrong-step replies are corrected twice; the third pauses the goal with executor_step_identity_exhausted', async () => {
  const world = harness([recorded(RECORDED_COPPER_REPLY), recorded(RECORDED_COPPER_REPLY), recorded(RECORDED_COPPER_REPLY)])
  const result = await world.toStepThree()

  assert.equal(world.calls.length, 6)
  assert.deepEqual(world.rows('executor.step_identity_correction').map(row => row.data.attempt), [1, 2])
  const [exhausted] = world.rows('executor.step_identity_exhausted')
  assert.equal(exhausted.data.attempts, 2)
  assert.equal(exhausted.data.limit, 2)
  assert.equal(exhausted.data.reason, 'executor_step_identity_exhausted')
  assert.equal(exhausted.data.step_id, stepThreeOf(world).step_id)
  assert.ok(exhausted.data.request_id)
  assert.equal(world.rows('request.failed').length, 0, 'a visible pause, not a failed request')
  assert.equal(world.game.mutations.length, 1, 'nothing from the three wrong replies ran')
  assert.equal(world.board().status, 'paused')
  assert.equal(world.board().pause_reason, 'executor_step_identity_exhausted')
  const [paused] = world.rows('goal.paused')
  assert.equal(paused.data.cause, 'executor_step_identity_exhausted')
  const [completed] = world.rows('request.completed').slice(-1)
  assert.equal(completed.data.outcome, 'executor_step_identity_exhausted')
  assert.match(result.chatMessage, /^I paused this goal/)
  assert.equal(result.goalStatus, 'paused')
  // The committed plan did not change.
  assert.deepEqual(world.tracker().steps.map(step => step.description), STEPS)
})

test('the allowance is keyed by goal, plan and step, persists, and is not renewed by a restage or a restart inside the same step', async () => {
  const world = harness([recorded(RECORDED_COPPER_REPLY), recorded(RECORDED_COPPER_REPLY), recorded(RECORDED_COPPER_REPLY)])
  await world.toStepThree()
  const snapshot = JSON.parse(JSON.stringify(world.memory.snapshot()))
  assert.equal(snapshot.executor_step_identity_ledger.length, 1)
  const [key, spent] = snapshot.executor_step_identity_ledger[0]
  assert.equal(spent, 2)
  const [goalId, planId, stepId] = JSON.parse(key)
  assert.equal(goalId, world.memory.planningState(KEY).goal.goal_id)
  assert.equal(planId, world.tracker().plan_id)
  assert.equal(stepId, stepThreeOf(world).step_id)
  // A restart restores the spent allowance with the rest of the memory.
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  assert.deepEqual([...restored.executorStepIdentityLedger.entries()], [[key, 2]])
  // Malformed rows are dropped on restore.
  const hostile = new CanonicalTaskBoardMemory()
  hostile.restore({ ...snapshot, executor_step_identity_ledger: [[key, 0], [key, 'x'], ['k', 3], 7, [`${key}`, 2]] })
  assert.deepEqual([...hostile.executorStepIdentityLedger.entries()], [['k', 3], [key, 2]])
})

test('one shared helper builds the step-transition fact for the fresh-read close and for the receipt close, with the new step id', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()

  const stepThreeId = stepThreeOf(world).step_id
  // Fresh-read close: the reply that closed step 2 gets the fact that names step 3 and its id.
  const fresh = harnessMessagesOf(world.calls[3]).find(text => text.includes('closed that step'))
  assert.ok(fresh, 'the fresh-read close fact reached the executor')
  assert.ok(fresh.includes(`The active step is now "${STEPS[2]}" (stepId ${stepThreeId}).`))
  assert.match(fresh, /Facts only: the committed plan is unchanged and only its progress advanced\.$/)

  // Receipt close: step 1 closed on its batch receipt; the continuation names step 2 the same way.
  const continuation = world.calls[1].map(textOf).find(text => text.startsWith('[MOD] Autorio operation batch completed'))
  assert.ok(continuation, 'the receipt continuation reached the executor')
  assert.ok(continuation.includes(`[HARNESS] The active step is now "${STEPS[1]}" (stepId ${stepTwoOf(world).step_id}).`))

  // Both come from the one builder.
  const board = world.board()
  assert.equal(world.agent.stepTransitionFact(board), `The active step is now "${STEPS[2]}" (stepId ${stepThreeId}).`)
  assert.equal(world.agent.stepTransitionFact({ status: 'completed', task_board: board.task_board }), '', 'no active step, no fact')
})

test('a stepId in an executor reply is lifted off the plan surface: a reply with only chatMessage, operations and stepId parses', async () => {
  const world = harness([w => ({ content: JSON.stringify({ chatMessage: 'Mining copper.', stepId: stepThreeOf(w).step_id, operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 20, search_radius: 256 } }] }) })])
  await world.toStepThree()
  assert.equal(world.rows('executor.step_bound').length, 1)
  assert.equal(world.rows('request.failed').length, 0)
  assert.equal(world.game.mutations.length, 2)
})

test('run-check reports the stale-step rejections and the unrecoverable failure of the recorded shape', () => {
  const row = (seq, event, data) => ({ schema: 1, ts: `2026-10-08T06:14:${40 + seq}.000Z`, seq, event, request_id: 'req_muz4y1hy_1', turn: 1, actor_id: 18, epoch: 3, data })
  const result = analyzeBehaviorTrace([
    row(1, 'request.received', {}),
    row(2, 'executor.stale_step_rejected', { incoming_step_index: 1, expected_step: { index: 2, stepId: 'step_3' }, operation_count: 1 }),
    row(3, 'request.failed', { stage: 'runtime', message: 'executor_stale_step: choose new operations for the current committed active step', recoverable: false }),
  ])
  const signatures = result.findings.map(finding => finding.signature)
  assert.ok(signatures.includes('executor_stale_step_rejected'))
  assert.ok(signatures.includes('request_failed_unrecoverable'))
})

test('submitPlan with only stepId, chatMessage and operations is accepted by the tool contract and carries the id through', async () => {
  const { plannerControlPayloadFromMessage } = await import('./structured-policy.mjs')
  const call = args => ({ content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(args) } }] })
  const operations = [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 20, search_radius: 256 } }]
  const bound = plannerControlPayloadFromMessage(call({ chatMessage: 'Mining copper.', stepId: ' step_3 ', operations }))
  assert.deepEqual({ plan: bound.plan, currentStep: bound.currentStep, stepId: bound.stepId }, { plan: [], currentStep: 0, stepId: 'step_3' })
  assert.throws(() => plannerControlPayloadFromMessage(call({ chatMessage: 'x', operations })), /submitPlan.plan must be an array/, 'without the id the plan is still required')
  assert.throws(() => plannerControlPayloadFromMessage(call({ plan: [], currentStep: 0, operations, stepId: '' })), /submitPlan.stepId/)
  assert.equal(plannerControlPayloadFromMessage(call({ plan: ['a'], currentStep: 0, operations: [] })).stepId, undefined)
})

test('the step-closing continuation keeps the transition fact in the lead, so receipt compaction still works and keeps the fact', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()
  const continuation = world.calls[1].map(textOf).find(text => text.startsWith('[MOD] Autorio operation batch completed'))
  const fact = `[HARNESS] The active step is now "${STEPS[1]}" (stepId ${stepTwoOf(world).step_id}).`
  assert.ok(continuation.indexOf(fact) > 0 && continuation.indexOf(fact) < continuation.indexOf('Detailed task receipt:'), 'the fact precedes the receipt')
  // The receipt as the builder writes it: the lead (fact included), then the receipt JSON and nothing after it.
  const receipt = { observation_mode: 'full', task_state: 'idle', queue_empty: true, queue_length: 0, last_completed_batch: { batch_id: 1, task_count: 2, task_types: ['mining'], tick: 601 }, extra_bulk: 'x'.repeat(400) }
  const built = `[MOD] Autorio operation batch completed. ${fact} Detailed task receipt: ${JSON.stringify(receipt)}`
  const compact = compactCompletionReceipt(built)
  assert.ok(compact.includes(fact), 'the fact survives compaction')
  assert.match(compact, /Compact task receipt: \{/)
  assert.doesNotMatch(compact, /extra_bulk/, 'and the receipt really was compacted')
})

test('a reply bound by the active step id always normalises currentStep to the committed active index unless it carries a semanticCompletion claim', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()
  const active = world.tracker().active_step_index
  const stepId = world.tracker().steps[active].step_id
  const operations = [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 20, search_radius: 256 } }]
  const forward = await world.agent.enforceExecutorContract({ chatMessage: '', plan: STEPS, currentStep: active + 1, operations, stepId })
  assert.equal(forward.currentStep, active, 'active+1 with a bound id is not the implied-next-step form')
  assert.deepEqual(forward.plan, STEPS)
  assert.equal('stepId' in forward, false)
  const behind = await world.agent.enforceExecutorContract({ chatMessage: '', plan: STEPS.slice(1), currentStep: 1, operations, stepId })
  assert.equal(behind.currentStep, active, 'the recorded tail-relative index is normalised too')
  const claim = await world.agent.enforceExecutorContract({ chatMessage: '', plan: STEPS, currentStep: active + 1, operations, stepId, semanticCompletion: { stepId, rationale: 'done' } })
  assert.equal(claim.currentStep, active + 1, 'an explicit claim keeps the currentStep it was written with')
})

test('a bound zero-operation reply keeps the plan array it sent, so the completion paths see the shape of a reply without a step id', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()
  const stepId = stepThreeOf(world).step_id
  const legacy = { chatMessage: 'All done.', plan: [], currentStep: 0, operations: [] }
  const legacyOut = await world.agent.enforceExecutorContract(legacy)
  const boundOut = await world.agent.enforceExecutorContract({ ...legacy, stepId })
  assert.deepEqual(boundOut, legacyOut, 'identical input for verifiedFinalCompletion, finishIfGoalMet, unmetGoalNote and persistentRuntimeStatus')
  assert.deepEqual(boundOut.plan, [])
  const withPlan = await world.agent.enforceExecutorContract({ chatMessage: '', plan: STEPS.slice(2), currentStep: 0, operations: [], stepId })
  assert.deepEqual(withPlan.plan, STEPS.slice(2), 'the sent plan is not replaced by the committed descriptions')
  assert.equal(withPlan.currentStep, world.tracker().active_step_index)
})

test('a planner draft that carries a stepId is unchanged by it, and the ignored id is traced with the request id and a reason', async () => {
  const world = harness([], { plannerExtra: { stepId: 'step_1' } })
  await world.toStepThree()
  const [ignored] = world.rows('planner.step_id_ignored')
  assert.ok(ignored.data.request_id)
  assert.equal(ignored.data.reason, 'step_id_is_executor_only')
  assert.equal(ignored.data.role, 'planner')
  assert.deepEqual(world.tracker().steps.map(step => step.description), STEPS)
  assert.equal(world.rows('request.failed').length, 0)
})

test('a superseded reply is not counted as a stale-step rejection: the fence runs before the rejection is traced', async () => {
  const world = harness([w => withStepId(RECORDED_COPPER_REPLY, stepThreeOf(w).step_id)])
  await world.toStepThree()
  const before = world.rows('executor.stale_step_rejected').length
  const operations = [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 20, search_radius: 256 } }]
  const original = world.agent.assertCurrent.bind(world.agent)
  world.agent.assertCurrent = async () => { throw new Error('Model turn was cancelled or superseded') }
  await assert.rejects(world.agent.enforceExecutorContract({ chatMessage: '', plan: [], currentStep: 0, operations, stepId: stepTwoOf(world).step_id }), /superseded/)
  await assert.rejects(world.agent.enforceExecutorContract({ chatMessage: '', plan: STEPS.slice(1), currentStep: 1, operations }), /superseded/)
  world.agent.assertCurrent = original
  assert.equal(world.rows('executor.stale_step_rejected').length, before, 'no rejection row for a superseded reply')
})
