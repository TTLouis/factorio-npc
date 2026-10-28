import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, answersStepContract, planReply, gather } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const description = 'Gather ten iron ore.'
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explicit-resume-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const game = new FakeFactorio()
  const memory = new CanonicalTaskBoardMemory()
  const first = new NpcAgentLoop({ rcon: game, memory, npcId: 'sgluna', stateFile: file, traceFile: null, decisionTraceFile: null,
    completionProtocolVersion: 3, provider: answersStepContract(async (_messages, context) => context.role === 'planner'
      ? planReply({ plan: [description], operations: [], goal: { scope: 'finite', summary: description,
          doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] },
        executionGuidance: [{ approach: 'Gather at the observed deposit.', rationale: 'Meet the inventory checkpoint.', constraints: [], skillIds: [], materialSupply: null }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] } }] })
      : planReply({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id, operations: [gather('iron-ore', 1)] })),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }) })
  const initialResult = await first.request(description, { sender: 'owner' })
  assert.ok(getActivePlan(memory.planningState(KEY)), JSON.stringify({ initialResult, state: memory.planningState(KEY) }))
  await first.reconcileOutstandingOperation({ trigger: 'fixture_completed_gather' })
  await first.settleOutstandingOperation(await first.readTaskStatusRaw())
  assert.equal(memory.pendingOperations(KEY).length, 0, 'Fixture must settle its original admitted receipt before stopping')
  memory.pausePlan(KEY, 'fixture_prior_recovery', { pause_class: 'model_recoverable' })
  const priorPlan = getActivePlan(memory.planningState(KEY))
  assert.equal(memory.recordAutoResumeStarted(KEY, { plan_id: priorPlan.plan_id, plan_version: priorPlan.plan_version, step_id: priorPlan.steps[0].step_id }).recorded, true)
  assert.equal(memory.resumePausedPlan(KEY, { pauseClasses: ['model_recoverable'] }).resumed, true)
  memory.pausePlan(KEY, 'user_stop', { pause_class: 'operator' })
  await first.persistState({ strict: true })
  const original = structuredClone(memory.planningState(KEY))
  const restartedMemory = new CanonicalTaskBoardMemory()
  const calls = []; const events = []
  const agent = new NpcAgentLoop({ rcon: game, memory: restartedMemory, npcId: 'sgluna', stateFile: file, traceFile: null, decisionTraceFile: null,
    completionProtocolVersion: 3, onActivity: (event, data) => events.push({ event, data }),
    provider: answersStepContract(async (_messages, context) => {
      calls.push(context.role)
      const held = getActivePlan(restartedMemory.planningState(KEY))
      return context.role === 'planner'
        ? planReply({ plan: [description], currentStep: 0, operations: [] })
        : planReply({ stepId: held.steps[0].step_id, operations: [gather('iron-ore', 10)] })
    }), interactionProvider: async () => ({ content: JSON.stringify({ intent: 'continue_current', queue_conflict: false, reply: '' }) }) })
  await agent.loadPersistentState()
  return { agent, memory: restartedMemory, game, calls, events, original, file }
}

test('recorded paused committed-plan empty-operations handoff resumes same goal before executor restage', async t => {
  const f = await setup(t)
  const beforeMutations = f.game.mutations.length
  await f.agent.request('continue', { sender: '<server>' })
  assert.deepEqual(f.calls, ['planner', 'executor'])
  const after = f.memory.planningState(KEY)
  assert.equal(after.run.paused, false)
  assert.equal(after.goal.goal_id, f.original.goal.goal_id)
  assert.deepEqual(getActivePlan(after).steps, getActivePlan(f.original).steps)
  assert.deepEqual(after.run.auto_resume, f.original.run.auto_resume)
  assert.equal(f.game.mutations.length, beforeMutations + 1)
  assert.ok(f.events.some(e => e.event === 'goal.explicit_resume_completed' && e.data.stage === 'intake'))
  f.game.inventory['iron-ore'] = 10
  await f.agent.completed()
  assert.equal(getActivePlan(f.memory.planningState(KEY))?.status, 'COMPLETED')
})

test('residual loss of primary transition is reconciled once at real C3 without a second user prompt', async t => {
  const f = await setup(t)
  const restage = f.agent.restageContext.bind(f.agent)
  let injected = false
  f.agent.restageContext = async args => {
    if (args.role === 'executor' && !injected) {
      injected = true
      // Fault injection: restore exactly the old pause tuple without creating a
      // new owner stop. A genuinely new pause must not inherit this authority.
      const state = f.memory.planningState(KEY)
      Object.assign(state.run, { paused: true, paused_at: f.original.run.paused_at,
        pause_count: f.original.run.pause_count, pause_class: 'operator', pause_reason: 'user_stop' })
      const legacy = f.memory.planByNpc.get(KEY)
      legacy.status = 'paused'; legacy.pause_class = 'operator'; legacy.pause_reason = 'user_stop'
    }
    return restage(args)
  }
  await f.agent.request('continue', { sender: 'owner' })
  assert.deepEqual(f.calls, ['planner', 'executor'])
  assert.equal(f.memory.planningState(KEY).run.explicit_resume.attempts, 2)
  assert.ok(f.events.some(e => e.event === 'goal.explicit_resume_completed' && e.data.stage === 'executor_restage'))
})

for (const fault of ['native_busy', 'unknown_native', 'pending', 'amendment', 'new_pause', 'actor_change', 'cancel_during_claim']) {
  test(`explicit resume fences ${fault} without executor admission`, async t => {
    const f = await setup(t)
    if (fault === 'native_busy') { f.game.taskState = 'running'; f.game.queueLength = 1 }
    if (fault === 'unknown_native') f.agent.readInteractionTaskStatus = async () => ({ status_error: 'unavailable' })
    if (fault === 'pending') f.memory.planningState(KEY).run.pending_operation = { state: 'uncertain' }
    if (fault === 'amendment') f.agent.pendingInteractionAmendment = { text: 'new instructions' }
    if (['new_pause', 'actor_change', 'cancel_during_claim'].includes(fault)) {
      const persist = f.agent.persistState.bind(f.agent)
      let injected = false
      f.agent.persistState = async opts => {
        await persist(opts)
        if (f.memory.planningState(KEY).run.explicit_resume && !injected) {
          injected = true
          if (fault === 'new_pause') f.memory.pausePlan(KEY, 'new_user_stop', { pause_class: 'operator' })
          if (fault === 'actor_change') f.game.status.epoch++
          if (fault === 'cancel_during_claim') f.agent.cancel()
        }
      }
    }
    const mutations = f.game.mutations.length
    await f.agent.request('continue', { sender: 'owner' }).catch(() => {})
    assert.ok(!f.calls.includes('executor'))
    assert.equal(f.game.mutations.length, mutations)
    assert.equal(f.memory.planningState(KEY).run.paused, true)
  })
}

test('durable explicit resume exhaustion survives restore and never resets automatic allowances', async t => {
  const f = await setup(t)
  const held = getActivePlan(f.original)
  f.memory.planningState(KEY).run.explicit_resume = { goal_id: f.original.goal.goal_id, plan_id: held.plan_id,
    plan_version: held.plan_version, step_id: held.steps[0].step_id, paused_at: f.original.run.paused_at,
    pause_count: f.original.run.pause_count, attempts: 2, request_id: 'old-request', stage: 'executor_restage', at: Date.now() }
  await f.agent.persistState({ strict: true })
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(await fs.readFile(f.file, 'utf8')))
  assert.equal(restored.planningState(KEY).run.explicit_resume.attempts, 2)
  const before = f.game.mutations.length
  await assert.rejects(f.agent.request('continue', { sender: 'owner' }), /durable_allowance_exhausted/)
  assert.equal(f.game.mutations.length, before)
  assert.equal(f.memory.planningState(KEY).run.paused, true)
})

for (const fault of ['claim_write_failure', 'transition_write_failure', 'corrupt_durable_allowance', 'stale_step_after_claim']) {
  test(`explicit resume fails safely for ${fault}`, async t => {
    const f = await setup(t)
    const mutations = f.game.mutations.length
    if (fault === 'corrupt_durable_allowance') {
      const raw = f.memory.snapshot()
      raw.planning_states[0].state.run.explicit_resume = { attempts: -1 }
      f.memory.restore(raw)
      assert.equal(f.memory.planningState(KEY).run.explicit_resume_fault, true)
    }
    else {
      const persist = f.agent.persistState.bind(f.agent)
      f.agent.persistState = async opts => {
        const state = f.memory.planningState(KEY)
        if (state.run.explicit_resume) {
          if (fault === 'claim_write_failure' || fault === 'transition_write_failure' && !state.run.paused) throw new Error('injected disk write failure')
          if (fault === 'stale_step_after_claim') {
            await persist(opts)
            getActivePlan(state).plan_version++
            return
          }
        }
        return persist(opts)
      }
    }
    await assert.rejects(f.agent.request('continue', { sender: 'owner' }))
    assert.equal(f.game.mutations.length, mutations)
    assert.ok(!f.calls.includes('executor'))
    assert.equal(f.memory.planningState(KEY).run.paused, true)
  })
}


for (const replacement of [false, true, 'native_unavailable']) test(`post-activation intake setup failure settles only its owner (replacement=${replacement})`, async t => {
  const f = await setup(t)
  const before = f.game.mutations.length
  f.agent.requestInteractionPlannerShape = async () => {
    assert.equal(f.memory.planningState(KEY).run.paused, false)
    if (replacement === 'native_unavailable') f.game.command = async () => { throw new Error('native read unavailable') }
    if (replacement === true) {
      f.memory.pausePlan(KEY, 'new_user_stop', { pause_class: 'operator' })
      f.agent.cancel()
    }
    throw new Error('injected planner setup failure')
  }
  await assert.rejects(f.agent.request('continue', { sender: 'owner' }), /setup failure/)
  const state = f.memory.planningState(KEY)
  assert.equal(state.run.paused, true)
  assert.equal(state.run.pause_reason, replacement === true ? 'new_user_stop' : 'explicit_resume_setup_failed')
  assert.equal(f.game.mutations.length, before)
  assert.equal(f.calls.includes('executor'), false)
})
