import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { ensureSkillOffers, parseSkillOffers, skillDiscoveryPolicy } from './skill-offers.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'

const pack = JSON.parse(await readFile(new URL('../../../packages/autorio/src/fixtures/factory-playbooks-v1.json', import.meta.url), 'utf8'))
const cards = Array.from({ length: 12 }, (_, index) => ({ id: `pattern-${index}`, name: `Pattern ${index}`, summary: `Build pattern ${index}.`, produces: [], needs: [], matched: ['factory'], score: 20-index }))
const details = cards.map(card => ({ ...card, revision: 1, constraints: [{ description: `Validate actual geometry for ${card.id}.` }] }))
const contextIds = messages => {
  const block = messages.find(m => m.content?.startsWith('[SKILL_CONTEXT]'))?.content
  return block ? JSON.parse(block.slice(block.indexOf('\n')+1)).map(skill => skill.id) : []
}

class LibraryGame extends FakeFactorio {
  constructor() { super(); this.offers = []; this.reads = []; for (const skill of details) this.skills[skill.id] = skill }
  async command(command) {
    if (command.includes('remote.call("autorio_skills","offer"')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(command)[1]
      const request = JSON.parse(encoded.replace(/\\(.)/g, '$1'))
      this.offers.push(request)
      return JSON.stringify({ ok: true, cards: cards.slice(0, request.limit) })
    }
    if (command.includes('remote.call("autorio_skills","get"')) this.reads.push(command)
    return super.command(command)
  }
}

test('separated planner loads six of ten ranked matches, executor and legacy policies stay focused', async () => {
  const game = new LibraryGame()
  const agent = new NpcAgentLoop({ rcon: game, provider: async () => { throw Error('No inference') }, completionProtocolVersion: 3, stateFile: null, traceFile: null, decisionTraceFile: null })
  assert.equal(agent.agentContext.role, 'planner')
  agent.epoch = { actor_id: 18, epoch: 3 }
  await ensureSkillOffers(agent, { memoryKey: agent.activePlanKey(), intent: 'new_goal', text: 'Build a factory' })
  assert.equal(game.offers[0].limit, 10)
  assert.equal(game.reads.length, 6)
  assert.equal(agent.loadedSkillContext.size, 6)
  assert.equal(contextIds([{ content: agent.skillContext() }]).length, 6)
  assert.deepEqual(contextIds([{ content: agent.skillContext() }]), details.slice(0, 6).map(skill => skill.id).reverse())
  assert.equal(agent.skillChoicePending, undefined, 'deterministic lookup creates no Jev ranking job')
  assert.equal(skillDiscoveryPolicy({ completionProtocolVersion: 3, agentContext: { role: 'executor' } }).rendered, 3)
  assert.equal(skillDiscoveryPolicy({ completionProtocolVersion: 2, agentContext: { role: 'planner' } }).stored, 3)
  assert.equal(parseSkillOffers(JSON.stringify({ ok: true, cards }), 10).cards.length, 10)
})

test('real request hands only selected details to executor and traces the actual role exposure without a skill Jev provider', async () => {
  const game = new LibraryGame()
  const memory = new CanonicalTaskBoardMemory()
  const events = []
  const calls = []
  const description = 'Hold the starting iron plate.'
  const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }
  const provider = answersStepContract(async (messages, context) => {
    calls.push({ role: context.role, ids: contextIds(messages) })
    if (context.role === 'planner') return planReply({ plan: [description], currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Hold a plate.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 2 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint }],
      executionGuidance: [{ approach: description, rationale: 'Use one relevant loaded pattern.', constraints: [], skillIds: ['pattern-4'], materialSupply: null }],
    })
    const plan = getActivePlan(memory.planningState('npc:sgluna'))
    return planReply({ stepId: plan.steps[0].step_id, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  }, { contracts: { [description]: checkpoint } })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    onActivity: (event, data) => events.push({ event, data }) })
  await agent.request('Build a factory and hold a plate.', { sender: 'Louis' })
  assert.equal(calls[0].role, 'planner')
  assert.equal(calls[0].ids.length, 6)
  const executed = calls.find(call => call.role === 'executor')
  assert.deepEqual(executed?.ids, ['pattern-4'])
  const exposure = events.filter(e => e.event === 'skill.context_presented')
  assert.ok(exposure.some(e => e.data.role === 'planner' && e.data.presented_ids.length === 6))
  assert.ok(exposure.some(e => e.data.role === 'executor' && e.data.presented_ids.join() === 'pattern-4'))
  assert.ok(exposure.every(e => e.data.request_id), 'exposure is request-correlated')
  assert.equal(events.filter(e => e.event === 'decision.request' && e.data.contract === 'skill_choice').length, 0)
})

test('all factory procedures survive real compaction and fit together inside the wider planner prefix', () => {
  const agent = new NpcAgentLoop({ rcon: { command: async () => '{}' }, provider: async () => {}, completionProtocolVersion: 3, stateFile: null, traceFile: null, decisionTraceFile: null })
  assert.equal(pack.default_enabled, false)
  for (const skill of pack.skills) {
    const loaded = agent.recordLoadedSkillToolResult('getSkillDetails', { id: skill.id }, JSON.stringify(skill))
    assert.equal(loaded.constraints.length, skill.constraints.length)
    for (let i=0; i<skill.constraints.length; i++) assert.equal(loaded.constraints[i].description, skill.constraints[i].description)
    assert.ok(JSON.stringify(loaded).length < 7000)
  }
  const context = agent.skillContext()
  assert.ok(context.length < 32500)
  assert.equal(contextIds([{ content: context }]).length, 6)
  assert.match(context, /hand-craft that finite bootstrap quantity/)
  assert.match(context, /bootstrap packs outside automated-output accounting/)
})

test('the live supervisor does not wire a Jev skill provider while other Jev providers remain configured', async () => {
  const source = await readFile(new URL('./supervisor.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /skillDecisionProvider\s*:/)
  assert.match(source, /interactionDecisionProvider:\s*jevDecisionProvider/)
})
