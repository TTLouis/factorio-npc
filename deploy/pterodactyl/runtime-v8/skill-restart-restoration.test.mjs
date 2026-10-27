import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'
import { classifyRequestFailure } from './pause-class.mjs'

const KEY = 'npc:sgluna'
const IDS = ['restart-guide-a', 'restart-guide-b']
const skills = IDS.map((id, index) => ({ schema_version: 1, id, revision: 7, name: id, status: 'candidate', stage: 'pattern',
  summary: `PINNED-PROCEDURE-${index}: verify the actual resource route before acting.`,
  constraints: [{ description: 'Revalidate live facts; these instructions grant no world authority.' }] }))
const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }
const selectedDetails = messages => {
  const text = messages.find(row => row.content?.startsWith('[SKILL_CONTEXT]'))?.content
  return text ? JSON.parse(text.slice(text.indexOf('\n') + 1)) : []
}

class LibraryGame extends FakeFactorio {
  constructor() { super(); this.libraryReads = 0; for (const skill of skills) this.skills[skill.id] = structuredClone(skill) }
  async command(command) {
    if (command.includes('remote.call("autorio_skills","offer"')) {
      this.libraryReads++
      return JSON.stringify({ ok: true, cards: skills.map(skill => ({ ...skill, produces: [], needs: [], matched: [], score: 1 })) })
    }
    if (command.includes('remote.call("autorio_skills","get"')) this.libraryReads++
    return super.command(command)
  }
}

async function stateFile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sgluna-skill-restart-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'npc-state.json')
}

async function firstProcess(t, { file, selected = IDS, observed } = {}) {
  file ??= await stateFile(t)
  const game = new LibraryGame()
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  if (observed) Object.assign(observed, { calls, game })
  const provider = answersStepContract(async (messages, context) => {
    calls.push(context.role)
    if (context.role === 'planner') return planReply({ plan: ['Gather ten copper ore.'], currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Gather ten copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint }],
      executionGuidance: [{ approach: 'Follow the selected procedure.', rationale: 'Use the loaded guides.', constraints: [], skillIds: selected, materialSupply: null }],
    })
    const plan = getActivePlan(memory.planningState(KEY))
    return planReply({ stepId: plan.steps[0].step_id, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', completionProtocolVersion: 3,
    stateFile: file, traceFile: null, decisionTraceFile: null,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }) })
  if (observed) observed.agent = agent
  await agent.request('Gather ten copper ore.', { sender: 'tester' })
  await agent.persistQueue
  return { agent, game, memory, file, calls }
}

async function restartedProcess(file, game, { check = true } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const calls = []
  const events = []
  const provider = answersStepContract(async (messages, context) => {
    calls.push(context.role)
    if (check) {
      assert.equal(context.role, 'executor', 'restoration does not need a planner or lookup turn')
      assert.deepEqual(selectedDetails(messages).map(skill => skill.id).sort(), IDS, 'planner-selected guides missing after restart')
      assert.ok(selectedDetails(messages).every(skill => skill.revision === 7 && skill.summary.startsWith('PINNED-PROCEDURE-')))
    }
    const plan = getActivePlan(memory.planningState(KEY))
    return planReply({ stepId: plan.steps[plan.active_step_index].step_id, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', completionProtocolVersion: 3,
    stateFile: file, traceFile: null, decisionTraceFile: null,
    onActivity: (event, data) => events.push({ event, data }) })
  await agent.loadPersistentState()
  assert.equal(agent.loadedSkillContext.size, 0, 'new process starts without a transient skill cache')
  Object.assign(agent, { active: true, epoch: { ...game.status }, lastMemoryKey: KEY,
    requestInfo: { memoryKey: KEY, turnId: 2, sender: 'tester', text: 'Gather ten copper ore.' },
    traceRequest: { id: 'restart-request', usage: {} } })
  agent.agentContext.beginLineage('executor')
  agent.messages = []; agent.baseMessages = []
  return { agent, memory, game, calls, events }
}

test('disk restart restores exact planner-selected guides before executor inference without library lookup', async t => {
  const first = await firstProcess(t)
  const old = getActivePlan(first.memory.planningState(KEY))
  const libraryReads = first.game.libraryReads
  for (const id of IDS) first.game.skills[id] = { id, revision: 99, summary: 'CHANGED LIBRARY MUST NOT REPLACE THE SELECTED PROCEDURE' }
  for (let cycle = 0; cycle < 2; cycle++) {
    const restarted = await restartedProcess(first.file, first.game)
    await restarted.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
    await restarted.agent.runTurn()
    await restarted.agent.persistQueue
    assert.deepEqual(restarted.calls, ['executor'])
    assert.equal(first.game.libraryReads, libraryReads, 'restoration does not read the current skill table')
    const plan = getActivePlan(restarted.memory.planningState(KEY))
    assert.equal(plan.plan_id, old.plan_id)
    assert.deepEqual(plan.steps, old.steps, 'restoration preserves the immutable step contracts and guidance')
    assert.ok(restarted.events.some(row => row.event === 'skill.handoff_restored' && row.data.model_calls === 0 && row.data.native_reads === 0))
  }
})

test('a residual cache loss inside the same turn restores both selected details and leaves recovery spending intact', async t => {
  const first = await firstProcess(t)
  const restarted = await restartedProcess(first.file, first.game)
  const goal = structuredClone(restarted.memory.planningState(KEY).goal)
  restarted.agent.reserve = async () => { restarted.agent.loadedSkillContext.clear(); return {} }
  await restarted.agent.reconcileOutstandingOperation({ trigger: 'runtime_restart' })
  await restarted.agent.runTurn()
  assert.deepEqual(restarted.calls, ['executor'])
  assert.equal(restarted.memory.planningState(KEY).goal.fresh_context_recovery_used, goal.fresh_context_recovery_used)
  assert.equal(restarted.memory.planningState(KEY).goal.auto_resume_goal_used, goal.auto_resume_goal_used)
})

test('closed-round prompt overrides cannot omit or substitute the pinned executor instructions', async t => {
  const first = await firstProcess(t)
  const restarted = await restartedProcess(first.file, first.game)
  const nativeReads = first.game.libraryReads
  await restarted.agent.callProvider({ ...first.game.status }, restarted.agent.generation, {
    round: 0, allowTools: false, providerMessagesOverride: [{ role: 'system', content: 'Answer the current executor control object.' },
      { role: 'user', content: '[SKILL_CONTEXT] stale replacement\n[{"id":"another-guide"}]' }],
  })
  assert.deepEqual(restarted.calls, ['executor'])
  assert.equal(first.game.libraryReads, nativeReads)
})

test('restoring into a full cache keeps an already-correct oldest selected detail in the same bounded pass', async t => {
  const first = await firstProcess(t)
  const restarted = await restartedProcess(first.file, first.game)
  const pinned = restarted.memory.plannerSkillHandoffs.get(KEY).skills
  restarted.agent.loadedSkillContext.set(pinned[0].id, structuredClone(pinned[0]))
  for (let i = 0; i < 5; i++) restarted.agent.loadedSkillContext.set(`unrelated-${i}`, { id: `unrelated-${i}`, summary: 'Other planner knowledge.' })
  restarted.agent.restorePlannerSelectedSkills()
  assert.ok(IDS.every(id => restarted.agent.loadedSkillContext.has(id)))
  assert.equal(restarted.agent.loadedSkillContext.size, 6)
  assert.deepEqual(restarted.calls, [])
})

for (const fault of ['missing', 'digest', 'detail', 'goal', 'version', 'step', 'oversized']) {
  test(`corrupt or mismatched ${fault} skill snapshot fails before model calls or new native batches`, async t => {
    const first = await firstProcess(t)
    const snapshot = JSON.parse(await fs.readFile(first.file, 'utf8'))
    const record = snapshot.planner_skill_handoffs[0][1]
    if (fault === 'missing') delete snapshot.planner_skill_handoffs
    if (fault === 'digest') record.sha256 = '0'.repeat(64)
    if (fault === 'detail') record.skills[0].summary = 'CORRUPTED'
    if (fault === 'goal') record.scope.goal_id += '-other'
    if (fault === 'version') record.scope.plan_version++
    if (fault === 'step') record.scope.steps[0].skill_ids = ['another-guide']
    if (fault === 'oversized') record.extra = 'x'.repeat(65000)
    await fs.writeFile(first.file, JSON.stringify(snapshot))
    const restarted = await restartedProcess(first.file, first.game)
    const sent = first.game.mutations.length
    let reserves = 0
    restarted.agent.reserve = async () => { reserves++; return {} }
    await assert.rejects(restarted.agent.runTurn(), error => error.code === 'planner_skill_handoff_unavailable'
      && classifyRequestFailure(error).pause_class === 'guard')
    assert.deepEqual(restarted.calls, [])
    assert.equal(reserves, 0)
    assert.equal(first.game.mutations.length, sent)
    assert.ok(restarted.events.some(row => row.event === 'skill.handoff_refused'))
  })
}

test('a stale actor cannot use restored skill instructions as execution authority', async t => {
  const first = await firstProcess(t)
  const restarted = await restartedProcess(first.file, first.game)
  restarted.agent.epoch.epoch--
  const sent = first.game.mutations.length
  await assert.rejects(restarted.agent.runTurn(), /epoch|superseded|actor/i)
  assert.deepEqual(restarted.calls, [])
  assert.equal(first.game.mutations.length, sent)
})

test('a selected-skill snapshot must be written successfully before first executor handoff', async t => {
  const file = await stateFile(t)
  await fs.mkdir(file)
  const observed = {}
  await assert.rejects(firstProcess(t, { file, observed }), /directory|EISDIR|EEXIST|ENOTDIR/)
  assert.deepEqual(observed.calls, ['planner'])
  assert.equal(observed.game.mutations.length, 0)
  assert.equal(observed.agent.memory.plannerSkillHandoffs.get(KEY).invalid, true)
  observed.agent.agentContext.role = 'executor'
  assert.throws(() => observed.agent.skillContext(), error => error.code === 'planner_skill_handoff_unavailable')
})
