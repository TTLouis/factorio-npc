import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { EXECUTOR_ROLE } from './agent-roles.mjs'
import { DECISION_BUDGET_FIELDS } from './decision-budgets.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, planReply } from './task-loop-fixtures.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }))
const read = id => ({ content: '', tool_calls: [{ id, type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } }] })
const transportError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
const budgetValues = agent => DECISION_BUDGET_FIELDS.map(field => agent[field])

function world() {
  const game = new FakeFactorio({ inventory: { 'iron-plate': 4 } })
  game.status.connected_players = 0
  const calls = []
  const rows = []
  const received = []
  const agent = new NpcAgentLoop({ rcon: game, memory: new CanonicalTaskBoardMemory(),
    provider: async (messages, context) => {
      const entry = { messages: structuredClone(messages), requestId: context.requestId }
      calls.push(entry)
      assert.ok(worldState.reply, 'all provider calls must have a scripted response')
      return worldState.reply(entry)
    },
    systemPrompt: 'Request unwind ownership fixture.', npcId: 'sgluna',
    stateFile: null, traceFile: null, decisionTraceFile: null, executorHandoff: false })
  const worldState = { agent, game, calls, rows, received, reply: undefined, onRow: undefined }
  agent.behaviorTrace = { emit: async row => {
    rows.push(structuredClone(row))
    if (row.event === 'request.received') received.push(row.request_id)
    await worldState.onRow?.(row)
  } }
  // The observation fixture needs no map topology; inventoryRound seeds its committed wait step.
  // All request setup, guarded turns, tool admission, delivery and failure cleanup are production methods.
  agent.gatherTopologyContext = async () => undefined
  agent.postBatchStepKey = () => 'request-unwind-fixture-step'
  return worldState
}

async function inventoryRound(w, id) {
  // Seed a committed observation fixture without admitting an operation; the public turn
  // then exercises result fencing and executes its one scripted wait normally.
  const key = w.agent.activePlanKey()
  w.agent.memory.recordPlan(key, w.agent.requestInfo, { chatMessage: 'Inspect before waiting.',
    plan: ['Wait briefly'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 60 } }] })
  w.agent.memory.commitPlanningPlan(key, { runtime_validation: { passed: true } })
  assert.ok(getActivePlan(w.agent.memory.planningState(key)))
  w.agent.agentContext.role = EXECUTOR_ROLE
  w.game.inventory['iron-plate'] = 4
  const bundle = await w.agent.postBatchFactBundle('targeted_observation', { families: ['inventory_equipment'] })
  assert.equal(bundle.reads.length, 1)
  w.agent.deliverPostBatchFacts(bundle)
  w.game.inventory['iron-plate'] = 9
  w.agent.observationBudgetRemaining = 4
  w.agent.observationDecisionForced = false
  return read(id)
}

function replacementState(agent) {
  const references = { request: agent.traceRequest, usage: agent.traceRequest?.usage, requestInfo: agent.requestInfo,
    messages: agent.messages, baseMessages: agent.baseMessages, facts: agent.postBatchFacts,
    inventory: agent.handoffInventoryObservations, skills: agent.loadedSkillContext, entities: agent.liveEntityObservations, cache: agent.toolCache,
    startRestage: agent.startRestage }
  const values = structuredClone({ requestId: agent.traceRequest?.id, usage: agent.traceRequest?.usage,
    lastTool: agent.traceRequest?.last_tool, requestInfo: agent.requestInfo, messages: agent.messages,
    baseMessages: agent.baseMessages, facts: agent.postBatchFacts, inventory: [...agent.handoffInventoryObservations], skills: [...agent.loadedSkillContext],
    entities: [...agent.liveEntityObservations], cache: [...agent.toolCache],
    chatRequestPending: agent.chatRequestPending, startRestage: agent.startRestage,
    budgets: budgetValues(agent), epoch: agent.epoch, mutation: agent.worldMutationSeq,
    generation: agent.generation, lineage: agent.agentContext.lineageSequence })
  return { references, values }
}
function assertReplacement(agent, held) {
  const current = replacementState(agent)
  for (const [key, value] of Object.entries(held.references)) assert.equal(current.references[key], value, `replacement ${key} identity`)
  assert.deepEqual(current.values, held.values, 'the old unwind must leave replacement bookkeeping unchanged')
}
function evidence(label, data) {
  if (process.env.UNWIND_EVIDENCE_DIR) fs.writeFileSync(`${process.env.UNWIND_EVIDENCE_DIR}/${process.env.UNWIND_RUN_LABEL}-${label}.json`, JSON.stringify(data, null, 2))
}

for (const failure of ['supersession', 'supersession-replacement-setup', 'bind', 'setup', 'runtime-status', 'runtime-pause-skipped', 'runtime-failed-trace', 'bind-failed-trace', 'setup-failed-trace']) {
  test(`old ${failure} unwind preserves an active replacement and its captured batch owner`, { timeout: 10000 }, async () => {
    const w = world()
    const oldPaused = deferred()
    const oldRelease = deferred()
    const replacementPaused = deferred()
    const replacementRelease = deferred()
    const failureError = failure === 'runtime-status' || failure === 'runtime-pause-skipped' ? new Error('Provider fixture failure') : transportError()
    let statusArmed = false
    const readStatus = w.agent.readInteractionTaskStatus.bind(w.agent)
    w.agent.readInteractionTaskStatus = async () => {
      if (statusArmed) {
        statusArmed = false
        if (failure === 'runtime-status') { oldPaused.resolve(); await oldRelease.promise }
        return { task_state: 'running', queue_empty: false, queue_length: 1 }
      }
      return readStatus()
    }
    const bind = failure.startsWith('bind')
    if (bind) {
      const capture = w.agent.captureEpoch.bind(w.agent)
      let first = true
      w.agent.captureEpoch = async () => {
        if (first) {
          first = false
          if (failure === 'bind') { oldPaused.resolve(); await oldRelease.promise }
          throw failureError
        }
        return capture()
      }
    }
    w.reply = async ({ requestId, messages }) => {
      if (requestId === w.received[0]) {
        if (failure.startsWith('supersession')) return inventoryRound(w, 'old-inventory')
        if (failure === 'runtime-status' || failure === 'runtime-pause-skipped') {
          await inventoryRound(w, 'old-inventory')
          statusArmed = true
        }
        throw failureError
      }
      const count = w.calls.filter(call => call.requestId === requestId).length
      if (count === 1) return inventoryRound(w, 'replacement-inventory')
      assert.equal(count, 2, 'no retry or recovery provider call is permitted')
      assert.equal(w.agent.traceRequest?.id, requestId)
      assert.ok(messages.some(row => row.role === 'tool' && row.tool_call_id === 'replacement-inventory' && row.content.includes('9')))
      return planReply({ plan: ['Wait briefly'], operations: [{ name: 'wait', args: { ticks: 60 } }] })
    }
    w.onRow = async row => {
      if (failure.startsWith('setup') && row.request_id === w.received[0] && row.event === 'planning.goal_admitted') {
        if (failure === 'setup') { oldPaused.resolve(); await oldRelease.promise }
        throw failureError
      }
      const pauseOld = failure.startsWith('supersession') ? row.event === 'observation.post_batch_fact_superseded'
        : failure === 'runtime-pause-skipped' ? row.event === 'goal.pause_skipped'
          : failure.endsWith('failed-trace') && row.event === 'request.failed'
      if (row.request_id === w.received[0] && pauseOld) { oldPaused.resolve(); await oldRelease.promise }
      const replacementEvent = failure === 'supersession-replacement-setup' ? 'request.received' : 'tool.result'
      if (row.request_id === w.received[1] && row.event === replacementEvent) { replacementPaused.resolve(); await replacementRelease.promise }
    }
    const old = outcome(w.agent.request('inspect old inventory', { sender: 'old-requester' }))
    let replacement
    try {
      await oldPaused.promise
      const oldRequestId = w.received[0]
      if (failure !== 'supersession-replacement-setup') w.agent.cancel('user_cancel')
      replacement = outcome(w.agent.request('inspect replacement inventory', { sender: 'replacement-requester' }))
      await replacementPaused.promise
      // Replacement-owned pending work can be queued while a result trace is waiting.
      w.agent.chatRequestPending = true
      w.agent.startRestage = { reason: 'replacement_pending_restage', semanticScope: 'keep_target' }
      const selected = ['deep', 7, 6, ['inventory_equipment'], 'next_slice']
      DECISION_BUDGET_FIELDS.forEach((field, index) => { w.agent[field] = selected[index] })
      const held = replacementState(w.agent)
      const callsBefore = w.calls.length
      const mutationsBefore = w.game.mutations.length
      oldRelease.resolve()
      const dropped = await old
      assert.ok(dropped.error, 'old request must reject')
      if (failure.startsWith('supersession')) assert.match(dropped.error.message, /cancelled|superseded/)
      else assert.equal(dropped.error, failureError)
      assert.equal(w.calls.length, callsBefore, 'old failure cleanup makes no provider calls')
      assert.equal(w.game.mutations.length, mutationsBefore, 'old failure cleanup sends no native mutation')
      assertReplacement(w.agent, held)
      const failures = w.rows.filter(row => row.event === 'request.failed')
      assert.ok(failures.every(row => row.request_id === oldRequestId), 'old failure must never be attributed to the replacement')
      assert.equal(failures.length, failure.endsWith('failed-trace') ? 1 : 0)
      assert.equal('intake_failure' in dropped.error, failure === 'runtime-failed-trace', 'stale unwind cannot attach replacement intake metadata')
      replacementRelease.resolve()
      const continued = await replacement
      assert.equal(continued.error, undefined, continued.error?.stack)
      assert.equal(continued.value.operations[0].name, 'wait', 'replacement proceeds through its own batch fence and native admission')
      assert.equal(w.agent.traceRequest, held.references.request, 'successful active request keeps its exact trace object')
      assert.equal(w.calls.filter(call => call.requestId === held.values.requestId).length, 2)
      assert.equal(w.calls.length, bind || failure.startsWith('setup') ? 2 : 3)
      assert.equal(w.game.mutations.length, 1)
      evidence(failure, { oldRequestId, replacement: held.values, failures, calls: w.calls, rows: w.rows, dropped: dropped.error.message })
    }
    finally {
      oldRelease.resolve()
      replacementRelease.resolve()
      await old
      if (replacement) {
        const final = await replacement
        evidence(`${failure}-settled`, { rows: w.rows, calls: w.calls, replacementError: final.error?.message, mutations: w.game.mutations })
      }
    }
  })
}

for (const stage of ['bind', 'setup', 'runtime', 'runtime-restage']) {
  test(`same-owner ${stage} failure retains ordinary cleanup and intake metadata`, { timeout: 10000 }, async () => {
    const w = world()
    const failure = transportError()
    const initialBudgets = budgetValues(w.agent)
    let owner
    let generation
    let lineage
    if (stage === 'setup') w.onRow = async row => {
      if (row.event === 'planning.goal_admitted') { owner = w.agent.traceRequest; throw failure }
    }
    if (stage === 'bind') w.agent.captureEpoch = async () => { owner = w.agent.traceRequest; throw failure }
    w.reply = async () => {
      owner = w.agent.traceRequest
      generation = w.agent.generation
      lineage = w.agent.agentContext.lineageSequence
      if (stage === 'runtime-restage') {
        w.agent.replaceConversation({ baseMessages: [{ role: 'system', content: 'same-request restaged prefix' }, { role: 'user', content: 'same request' }] })
        w.agent.agentContext.role = EXECUTOR_ROLE
      }
      throw failure
    }
    const settled = await outcome(w.agent.request('inspect inventory', { sender: 'requester' }))
    assert.equal(settled.error, failure)
    assert.equal(w.agent.traceRequest, null)
    assert.equal(w.agent.chatRequestPending, false)
    assert.equal(w.agent.startRestage, undefined)
    const failed = w.rows.filter(row => row.event === 'request.failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].request_id, owner.id)
    assert.equal(failed[0].data.stage, stage === 'bind' || stage === 'setup' ? 'bind' : 'runtime')
    assert.equal(failed[0].data.cause_code, 'ECONNRESET')
    assert.equal(w.calls.length, stage === 'bind' || stage === 'setup' ? 0 : 1)
    assert.equal(w.game.mutations.length, 0)
    if (stage === 'bind' || stage === 'setup') assert.deepEqual(budgetValues(w.agent), initialBudgets)
    else {
      assert.ok(w.agent.generation > generation, 'ordinary runtime failure still resets the loop')
      assert.ok(w.agent.agentContext.lineageSequence > lineage)
      assert.equal(w.agent.requestInfo, null)
      assert.equal(w.agent.active, false)
      assert.equal(failed[0].data.intake_retry_candidate, true)
      assert.equal(failure.intake_failure.request_id, owner.id)
      assert.equal(failure.intake_failure.interaction_intent, 'new_goal')
      assert.ok(failure.intake_failure.goal_id)
    }
    evidence(stage, { failed, intake: failure.intake_failure, calls: w.calls.length })
  })
}

for (const boundary of ['generation', 'lineage', 'request-id']) {
  test(`${boundary} alone invalidates unwind while the exact trace object is retained`, { timeout: 10000 }, async () => {
    const w = world()
    const paused = deferred()
    const release = deferred()
    w.reply = () => inventoryRound(w, 'old-inventory')
    w.onRow = async row => {
      if (row.event === 'observation.post_batch_fact_superseded') { paused.resolve(); await release.promise }
    }
    const old = outcome(w.agent.request('inspect inventory', { sender: 'requester' }))
    try {
      await paused.promise
      if (boundary === 'generation') w.agent.generation++
      else if (boundary === 'lineage') w.agent.agentContext.beginLineage()
      else w.agent.traceRequest.id = 'req_reassigned_identity'
      w.agent.chatRequestPending = true
      w.agent.startRestage = { reason: 'new_owner_pending' }
      const selected = ['deep', 7, 6, ['inventory_equipment'], 'next_slice']
      DECISION_BUDGET_FIELDS.forEach((field, index) => { w.agent[field] = selected[index] })
      const held = replacementState(w.agent)
      release.resolve()
      const settled = await old
      assert.match(settled.error?.message ?? '', /cancelled|superseded/)
      assertReplacement(w.agent, held)
      assert.equal(w.rows.filter(row => row.event === 'request.failed').length, 0)
      assert.equal(w.calls.length, 1)
      assert.equal(w.game.mutations.length, 0)
      evidence(boundary, { retained: held.values, rows: w.rows, error: settled.error.message })
    }
    finally {
      release.resolve()
      await old
      w.agent.cancel('fixture_finished')
    }
  })
}

test('failure before trace mint leaves a replacement setup and its budgets intact', { timeout: 10000 }, async () => {
  const w = world()
  const oldPaused = deferred()
  const oldRelease = deferred()
  const replacementPaused = deferred()
  const replacementRelease = deferred()
  const failure = transportError()
  w.agent.traceRequest = { id: 'req_preexisting_before_setup' }
  let firstSupersession = true
  w.onRow = async row => {
    if (row.event === 'request.superseded' && firstSupersession) {
      firstSupersession = false
      oldPaused.resolve()
      await oldRelease.promise
      throw failure
    }
    if (row.event === 'request.received') { replacementPaused.resolve(); await replacementRelease.promise }
  }
  w.reply = async ({ requestId }) => {
    const count = w.calls.filter(call => call.requestId === requestId).length
    if (count === 1) return inventoryRound(w, 'replacement-inventory')
    assert.equal(count, 2, 'no additional recovery provider call')
    return planReply({ plan: ['Wait briefly'], operations: [{ name: 'wait', args: { ticks: 60 } }] })
  }
  const old = outcome(w.agent.request('inspect old inventory', { sender: 'old-requester' }))
  let replacement
  try {
    await oldPaused.promise
    replacement = outcome(w.agent.request('inspect replacement inventory', { sender: 'replacement-requester' }))
    await replacementPaused.promise
    w.agent.chatRequestPending = true
    w.agent.startRestage = { reason: 'replacement_setup_queued' }
    const selected = ['deep', 7, 6, ['inventory_equipment'], 'next_slice']
    DECISION_BUDGET_FIELDS.forEach((field, index) => { w.agent[field] = selected[index] })
    const held = replacementState(w.agent)
    oldRelease.resolve()
    assert.equal((await old).error, failure)
    assertReplacement(w.agent, held)
    assert.equal(w.rows.filter(row => row.event === 'request.failed').length, 0)
    assert.equal(w.calls.length, 0)
    assert.equal(w.game.mutations.length, 0)
    replacementRelease.resolve()
    const continued = await replacement
    assert.equal(continued.error, undefined, continued.error?.stack)
    assert.equal(continued.value.operations[0].name, 'wait')
    assert.equal(w.agent.traceRequest, held.references.request)
    assert.equal(w.calls.length, 2)
    assert.equal(w.game.mutations.length, 1)
    evidence('before-trace-mint', { replacement: held.values, rows: w.rows, calls: w.calls })
  }
  finally {
    oldRelease.resolve()
    replacementRelease.resolve()
    await old
    if (replacement) await replacement
  }
})
