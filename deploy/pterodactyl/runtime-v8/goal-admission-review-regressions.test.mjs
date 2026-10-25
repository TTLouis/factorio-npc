import assert from 'node:assert/strict'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { FakeFactorio, gather, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { PAUSE_CLASS } from './pause-class.mjs'
import { getActivePlan } from './planning-state.mjs'

const KEY = 'npc:sgluna'
function deferred() {
  let resolve, reject
  const promise = new Promise((r, j) => { resolve = r; reject = j })
  return { promise, resolve, reject }
}
const goal = { scope: 'long_horizon', summary: 'Launch one rocket.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const slice = () => planReply({ plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), goal, roadmap: [{ id: 'node_iron', intent: 'Gather iron ore' }] })
async function physicalWorld(options = {}) {
  const game = options.game ?? new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const rows = []; const decisions = []
  let calls = 0
  const agent = new NpcAgentLoop({ rcon: game, memory, provider: async () => { calls++; return slice() },
    systemPrompt: 'offline review regression', npcId: 'sgluna', goalDefinitionPolicy: 'required',
    stateFile: null, traceFile: null, decisionTraceFile: null, ...options })
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  agent.decisionTrace = { emit: async row => { decisions.push(row) } }
  await agent.request('Gather iron toward launching a rocket', { sender: 'Louis' })
  assert.equal(agent.agentContext.role, 'executor')
  assert.ok(agent.agentContext.hasParkedPlanner)
  assert.equal(agent.active, true)
  game.taskState = 'mining'
  game.queueLength = 1
  return { agent, memory, game, rows, decisions, calls: () => calls }
}
function conversation(agent) {
  return { messages: structuredClone(agent.messages), baseMessages: structuredClone(agent.baseMessages),
    pending: structuredClone(agent.pendingInteractionAmendment), pendingSeq: agent.pendingAmendmentConversationSeq,
    seq: agent.agentContext.conversationSeq, trace: agent.traceRequest, traceSeq: agent.traceRequest?.seq }
}
for (const boundary of ['planner_resumed', 'assertCurrent']) {
  for (const disposition of ['cancel', 'replacement']) {
    test(`R1 compatible amendment ${disposition} while ${boundary} waits cannot write the later conversation`, async () => {
      const w = await physicalWorld()
      w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'amend_current', queue_conflict: false, reply: '' }) })
      const entered = deferred(); const held = deferred()
      if (boundary === 'planner_resumed') {
        const emit = w.agent.behaviorTrace.emit
        w.agent.behaviorTrace.emit = async row => {
          await emit(row)
          if (row.event === 'context.planner_resumed') { entered.resolve(); await held.promise }
        }
      }
      else {
        const current = w.agent.assertCurrent.bind(w.agent)
        let first = true
        w.agent.assertCurrent = async () => {
          if (first) { first = false; entered.resolve(); await held.promise }
          return current()
        }
      }
      const pending = assert.rejects(w.agent.request('Withdrawn amendment', { sender: 'Louis' }), /cancelled|superseded/)
      await entered.promise
      w.agent.cancel('user_stop_immediate')
      if (disposition === 'replacement') {
        w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) })
        await w.agent.request('Replacement goal', { sender: 'Louis' })
      }
      const before = conversation(w.agent)
      const snapshot = w.memory.snapshot()
      held.resolve()
      await pending
      assert.deepEqual(conversation(w.agent), before)
      assert.deepEqual(w.memory.snapshot(), snapshot)
      assert.equal(w.agent.baseMessages.some(row => row.content?.includes('Withdrawn amendment')), false)
    })
  }
}
for (const owned of [false, true]) {
  for (const route of ['status_query', 'new_goal']) {
    test(`R2 ${owned ? 'fresh-checkpoint' : 'actual continuation-limit'} physical guard preserves newer ${route} intake`, async () => {
      const w = await physicalWorld()
      w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: route, queue_conflict: false, reply: '' }) })
      const entered = deferred(); const held = deferred()
      const read = w.agent.readInteractionTaskStatus.bind(w.agent)
      let first = true
      w.agent.readInteractionTaskStatus = async () => {
        if (first) { first = false; entered.resolve(); await held.promise }
        return read()
      }
      const pending = w.agent.request(route === 'status_query' ? 'How is the current task?' : 'Replacement goal', { sender: 'Louis' })
      await entered.promise
      const intake = w.agent.requestAdmissionOwner
      const trace = w.agent.traceRequest
      assert.equal(intake.requestId, undefined, 'new intake has not minted its trace or base generation')
      const before = w.memory.planningState(KEY)
      const immutableGoal = structuredClone(before.goal)
      const immutablePlan = structuredClone(getActivePlan(before))
      let guardOwner
      if (owned) {
        const owner = guardOwner = w.agent.captureCheckpointOwner()
        await w.agent.pausePersistentPlan('physical_guard', { pause_class: PAUSE_CLASS.GUARD }, owner)
      }
      else {
        w.agent.continuations = 64
        w.agent.sliceContinuationBaseline = 0
        await assert.rejects(w.agent.continueFromModMessage('[MOD] work ended', 'factorio.completed'), /Continuation limit reached/)
      }
      assert.equal(w.agent.requestAdmissionOwner, intake)
      if (owned) assert.notEqual(guardOwner.admissionOwner, intake, 'a physical capture cannot borrow the global intake')
      assert.equal(w.agent.traceRequest, trace)
      assert.equal(intake.requestId, undefined)
      const paused = w.memory.planningState(KEY)
      assert.deepEqual(paused.goal, immutableGoal)
      assert.deepEqual(getActivePlan(paused), immutablePlan)
      assert.equal(paused.run.paused, true)
      held.resolve()
      const result = await pending
      assert.equal(result.routedOnly, route === 'status_query')
      // New-goal admission uses its ordinary grounding/planner rounds; a status reply uses none.
      assert.equal(w.calls(), route === 'status_query' ? 1 : 3)
    })
  }
}
test('R2 explicit global operator stop still revokes newer pre-trace intake', async () => {
  const w = await physicalWorld()
  const entered = deferred(); const held = deferred()
  const read = w.agent.readInteractionTaskStatus.bind(w.agent)
  w.agent.readInteractionTaskStatus = async () => { entered.resolve(); await held.promise; return read() }
  const pending = assert.rejects(w.agent.request('How is the task?', { sender: 'Louis' }), /cancelled|superseded/)
  await entered.promise
  w.agent.cancel('user_stop_immediate')
  assert.equal(w.agent.requestAdmissionOwner, null)
  held.resolve()
  await pending
  assert.equal(w.calls(), 1)
})
class ReviewSkillFactorio extends FakeFactorio {
  constructor() {
    super()
    this.skills['iron-starter'] = { id: 'iron-starter', name: 'Iron starter', revision: 1, status: 'candidate', stage: 'pattern', summary: 'Gather starter iron.' }
  }

  async command(command) {
    if (command.includes('remote.call("autorio_skills","offer"')) {
      return JSON.stringify({ ok: true, cards: [{ id: 'iron-starter', name: 'Iron starter', status: 'candidate', summary: 'Gather iron', produces: ['iron-ore'], needs: [], matched: ['iron'], score: 1 }] })
    }
    return super.command(command)
  }
}
for (const disposition of ['reject', 'aborted-result', 'fallback-trace']) {
  test(`R3 old real shadow ${disposition} cannot write a replacement trace/accounting`, async () => {
    const entered = deferred(); const held = deferred(); const fallbackEntered = deferred(); const fallbackHeld = deferred()
    let first = true
    const w = await physicalWorld({ game: new ReviewSkillFactorio(), skillDecisionProvider: async () => {
      if (first) { first = false; entered.resolve(); return held.promise }
      return undefined
    } })
    await entered.promise
    const oldRequestId = w.rows.find(row => row.event === 'request.received').request_id
    const oldShadow = w.agent.skillChoicePending
    assert.ok(oldShadow)
    if (disposition === 'fallback-trace') {
      const emit = w.agent.decisionTrace.emit
      w.agent.decisionTrace.emit = async row => {
        await emit(row)
        if (row.event === 'decision.fallback' && !fallbackEntered.seen) {
          fallbackEntered.seen = true
          fallbackEntered.resolve()
          await fallbackHeld.promise
        }
      }
      held.reject(new Error('owned shadow fixture failure'))
      await fallbackEntered.promise
    }
    // Hold B's real minted trace while A's deliberately uncooperative provider
    // settles. This exercises the actual replacement identity, not a fake row.
    w.agent.cancel('user_stop_immediate')
    w.game.status.actor_id = 19
    w.game.status.epoch = 4
    w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) })
    const replacementEntered = deferred(); const replacementHeld = deferred()
    const emit = w.agent.behaviorTrace.emit
    w.agent.behaviorTrace.emit = async row => {
      await emit(row)
      if (row.event === 'request.received') { replacementEntered.resolve(); await replacementHeld.promise }
    }
    const replacement = w.agent.request('Replacement goal', { sender: 'Louis' })
    await replacementEntered.promise
    const trace = w.agent.traceRequest
    const traceSeq = trace.seq
    const decisionSeq = w.agent.decisionTraceSequence
    const rows = w.rows.length
    const decisions = w.decisions.length
    const state = w.memory.snapshot()
    const health = structuredClone(w.agent.jevHealth)
    if (disposition === 'reject') held.reject(new Error('late old shadow fixture failure'))
    else if (disposition === 'aborted-result') held.resolve(undefined)
    else fallbackHeld.resolve()
    await oldShadow
    assert.equal(w.agent.traceRequest, trace)
    assert.equal(trace.seq, traceSeq)
    assert.equal(w.agent.decisionTraceSequence, decisionSeq, JSON.stringify(w.decisions.slice(decisions)))
    for (const row of w.rows.slice(rows)) {
      assert.equal(row.request_id, oldRequestId)
      assert.equal(row.seq, 0)
      assert.equal(row.actor_id, 18)
    }
    for (const row of w.decisions.slice(decisions)) {
      assert.equal(row.request_id, oldRequestId)
      assert.equal(row.seq, 0)
      assert.equal(row.actor_id, 18)
    }
    assert.deepEqual(w.memory.snapshot(), state)
    assert.deepEqual(w.agent.jevHealth, health)
    replacementHeld.resolve()
    await replacement
    await w.agent.skillChoicePending
  })
}
test('R2 a physical guard entered from the intake async scope cannot borrow that intake', async () => {
  const w = await physicalWorld()
  w.agent.interactionProvider = async () => ({ content: JSON.stringify({ intent: 'status_query', queue_conflict: false, reply: '' }) })
  const read = w.agent.readInteractionTaskStatus.bind(w.agent)
  let first = true
  w.agent.readInteractionTaskStatus = async () => {
    if (first) {
      first = false
      const intake = w.agent.requestAdmissionOwner
      const owner = w.agent.captureCheckpointOwner()
      assert.notEqual(owner.admissionOwner, intake)
      await w.agent.pausePersistentPlan('physical_guard_from_read', { pause_class: PAUSE_CLASS.GUARD }, owner)
      assert.equal(w.agent.requestAdmissionOwner, intake)
    }
    return read()
  }
  const result = await w.agent.request('How is the task?', { sender: 'Louis' })
  assert.equal(result.routedOnly, true)
  assert.equal(w.calls(), 1)
})
