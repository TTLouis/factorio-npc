import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { FakeFactorio, answersStepContract, planReply } from './task-loop-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import { compactLoadedSkill, selectedPlannerSkillDetails, capturePlannerSkillHandoff, restorePlannerSkillHandoffs, renderSkillCard, skillOfferBlock, loadOfferedSkillDetails } from './skill-offers.mjs'
import { compactKnowledge, sanitizeLibraryToolOutput, withoutKnowledgeExchange, KNOWLEDGE_LIMITS } from './knowledge-retrieval.mjs'
import { createHash } from 'node:crypto'

const pack = JSON.parse(readFileSync(new URL('../../../packages/autorio/src/fixtures/leveled-library-v1.json', import.meta.url), 'utf8'))
const reference = { ...pack.knowledge[0], summary: 'REFERENCE-ONLY-MARKER: inspect live capabilities.' }
const call = (name, args, id = `call-${name}`) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = (...tool_calls) => ({ content: null, tool_calls })
class ReferenceGame extends FakeFactorio {
  constructor() { super(); this.referenceReads = []; this.skills = Object.fromEntries(pack.skills.map(skill => [skill.id, skill])) }
  async command(command) {
    if (command.includes('remote.call("autorio_references"')) {
      this.referenceReads.push(command)
      return JSON.stringify(command.includes('"find"') ? { ok: true, results: [reference] } : reference)
    }
    if (command.includes('remote.call("autorio_skills","offer"')) return JSON.stringify({ ok: true, cards: [reference, ...pack.skills.slice(0, 6)].map(entry => ({ ...entry, produces: [], needs: [], matched: [], score: 1 })) })
    return super.command(command)
  }
}
function fixture(role = 'planner') {
  const game = new ReferenceGame()
  const events = []
  const agent = new NpcAgentLoop({ rcon: game, provider: async () => { throw new Error('No inference') }, completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null, onActivity: (event, data) => events.push({ event, data }) })
  Object.assign(agent, { active: true, epoch: { ...game.status }, traceRequest: { id: 'reference-test', usage: { tool_calls: 0, tool_result_chars: 0, duplicate_tool_calls: 0 } } })
  agent.agentContext.beginLineage(role)
  return { agent, game, events }
}

test('typed reference projection refuses procedure and malformed results, and never imports authority fields', () => {
  assert.equal(pack.knowledge.length, 6)
  for (const entry of pack.knowledge) assert.ok(compactKnowledge(entry, entry.id))
  for (const raw of [pack.skills[0], { ...reference, content_type: 'recipe' }, { ...reference, id: '../escape' }]) assert.equal(compactKnowledge(raw), undefined)
  assert.equal(compactLoadedSkill(reference), undefined)
  assert.equal(compactKnowledge(reference, 'other'), undefined)
  const payload = compactKnowledge({ ...reference, stage: 'executable_candidate', status: 'verified', verification: { production_output: 'passed' }, operations: [{ name: 'mine' }] })
  assert.equal(payload.guidance, undefined); assert.deepEqual(payload.reference, reference.reference)
  assert.equal(payload.stage, undefined); assert.equal(payload.verification, undefined); assert.equal(payload.operations, undefined)
  assert.equal(JSON.parse(sanitizeLibraryToolOutput('getSkillDetails', reference)).ok, false)
  assert.deepEqual(JSON.parse(sanitizeLibraryToolOutput('findSkills', { ok: true, results: [reference, pack.skills[0]] })).results.map(item => item.id), [pack.skills[0].id])
})

for (const role of ['planner', 'executor']) test(`${role} retrieves explicit references as tool results without autoload, Jev, world budget or handoff facts`, async () => {
  const { agent, game, events } = fixture(role)
  agent.observationBudgetRemaining = 0
  agent.jev = { noteObservations: () => { throw new Error('References must not route through Jev') } }
  const before = JSON.stringify(agent.memory.snapshot())
  await agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id })))
  assert.equal(game.referenceReads.length, 1)
  assert.equal(agent.loadedSkillContext.size, 0)
  assert.equal(agent.skillContext(), '')
  assert.equal(agent.observationBudgetRemaining, 0)
  assert.equal(agent.freshObservationSinceContinuation, false)
  assert.equal(JSON.stringify(agent.memory.snapshot()), before)
  const messages = agent.providerMessages()
  assert.equal(messages.filter(row => row.content?.includes('REFERENCE-ONLY-MARKER')).length, 1)
  assert.equal(messages.find(row => row.content?.includes('REFERENCE-ONLY-MARKER')).role, 'tool')
  assert.ok(events.some(row => row.event === 'knowledge.reference_delivered' && row.data.request_id === 'reference-test'))
  await agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }, 'repeat')))
  assert.equal(game.referenceReads.length, 1, 'one-request bounded cache coalesces only explicit repeated requests')
  assert.equal(agent.knowledgeReads.cache.size, 1)
})

test('reference allowance survives conversation restage; mixed, closed and over-budget reads fail before native dispatch', async () => {
  const { agent, game } = fixture()
  await assert.rejects(agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }), call('getInventoryItems', {}))), /separate_bounded_batch/)
  assert.equal(game.referenceReads.length, 0)
  for (let i = 0; i < KNOWLEDGE_LIMITS.calls; i++) {
    if (i === 3) agent.agentContext.conversationSeq++
    await agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }, `read-${i}`)))
  }
  await assert.rejects(agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }, 'exhausted'))), /budget_exhausted/)
  assert.equal(game.referenceReads.length, 1)
  agent.traceRequest = { id: 'new-request', usage: { tool_calls: 0, tool_result_chars: 0, duplicate_tool_calls: 0 } }
  agent.observationDecisionForced = true
  await assert.rejects(agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }))), /closed_or_targeted/)
  agent.observationDecisionForced = false
  await agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id })))
  assert.equal(game.referenceReads.length, 2)
})

test('compaction removes old reference exchanges without promoting their content into automatic prefixes', async () => {
  const { agent } = fixture()
  await agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id })))
  agent.messages.push({ role: 'assistant', content: null, tool_calls: [call('getInventoryItems', {}, 'newer')] },
    { role: 'tool', tool_call_id: 'newer', content: '{"items":[]}' })
  agent.maxWorkingMessages = 1
  agent.compactWorkingContext()
  assert.ok(agent.messages.every(row => !row.content?.includes('REFERENCE-ONLY-MARKER')))
  assert.equal(agent.skillContext(), '')
})

test('wrong-type native results cannot enter skill context even through direct loaded cache writes', async () => {
  const { agent, game } = fixture()
  game.skills[reference.id] = reference
  await agent.handleToolBatch(reply(call('getSkillDetails', { id: reference.id })))
  assert.equal(agent.loadedSkillContext.size, 0)
  assert.ok(agent.messages.every(row => !row.content?.includes('REFERENCE-ONLY-MARKER')))
  agent.loadedSkillContext.set(reference.id, reference)
  assert.equal(agent.skillContext(), '')
})

test('a mixed historical snapshot holds only an active selected knowledge reference and stays immutable', () => {
  const skill = pack.skills[0]
  const planning = { goal: { goal_id: 'goal' }, active_plan_id: 'plan', plans: [{ plan_id: 'plan', plan_version: 1, active_step_index: 0,
    steps: [{ step_id: 'a', execution_guidance: { skillIds: [skill.id] } }, { step_id: 'b', execution_guidance: { skillIds: [reference.id] } }] }] }
  // Manufacture a legitimate old schema-1 record, before knowledge was separated.
  const loaded = new Map([[skill.id, skill], [reference.id, { ...reference, content_type: 'skill' }]])
  const record = capturePlannerSkillHandoff('key', planning, loaded)
  assert.ok(record)
  record.skills.find(item => item.id === reference.id).content_type = 'knowledge'
  const payload = { schema: record.schema, scope: record.scope, skills: record.skills }
  record.sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const before = JSON.stringify(record)
  const restored = restorePlannerSkillHandoffs([['key', record]]).get('key')
  assert.deepEqual(selectedPlannerSkillDetails('key', planning, restored).selected_ids, [skill.id])
  planning.plans[0].active_step_index = 1
  assert.throws(() => selectedPlannerSkillDetails('key', planning, restored), /legacy_knowledge_selected_as_skill/)
  assert.equal(JSON.stringify(restored), before)
})

test('scripted full planner-executor loop reads references only when each role asks, with no planning authority transfer', async () => {
  const game = new ReferenceGame()
  const memory = new CanonicalTaskBoardMemory()
  const requests = []
  const description = 'Hold the starting iron plate.'
  const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }
  const readRoles = new Set()
  const provider = answersStepContract(async (messages, context) => {
    requests.push({ role: context.role, messages: structuredClone(messages) })
    for (const row of messages) if (row.content?.includes('REFERENCE-ONLY-MARKER')) assert.equal(row.role, 'tool')
    if (!readRoles.has(context.role)) {
      agent.observationDecisionPressure = true; agent.observationDecisionPressureRemaining = 1
      readRoles.add(context.role); return reply(call('getKnowledgeDetails', { id: reference.id }, `${context.role}-reference`)) }
    assert.equal(agent.observationDecisionPressureRemaining, 1, 'reference reads do not spend the targeted world observation allowance')
    if (context.role === 'planner') return planReply({ plan: [description], currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Hold a plate.', doneWhen: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 2 }] },
      stepCompletions: [{ kind: 'deterministic', checkpoint }],
      executionGuidance: [{ approach: description, rationale: 'Use the held stock.', constraints: [], skillIds: [], materialSupply: null }] })
    const plan = getActivePlan(memory.planningState('npc:sgluna'))
    return planReply({ stepId: plan.steps[0].step_id, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  }, { contracts: { [description]: checkpoint } })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', completionProtocolVersion: 3,
    stateFile: null, traceFile: null, decisionTraceFile: null,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }) })
  await agent.request('Hold a plate.', { sender: 'tester' })
  assert.deepEqual([...readRoles].sort(), ['executor', 'planner'])
  assert.equal(game.referenceReads.length, 1, 'the second explicit read reuses the same request cache')
  assert.ok(requests.filter(item => item.messages.some(row => row.role === 'tool' && row.content?.includes('REFERENCE-ONLY-MARKER'))).length >= 2)
  assert.ok(!agent.loadedSkillContext.has(reference.id))
  assert.deepEqual(getActivePlan(memory.planningState('npc:sgluna')).steps[0].execution_guidance.skillIds, [])
})

test('mixed historical exchange with out-of-order results compacts only correctly paired world evidence', () => {
  const { agent } = fixture()
  agent.baseMessages = []
  agent.messages = [
    { role: 'assistant', tool_calls: [call('getKnowledgeDetails', { id: reference.id }, 'reference'), call('getInventoryItems', {}, 'inventory')] },
    { role: 'tool', tool_call_id: 'inventory', content: 'WORLD-INVENTORY-MARKER' },
    { role: 'tool', tool_call_id: 'reference', content: 'REFERENCE-ONLY-MARKER' },
    { role: 'assistant', tool_calls: [call('getTaskStatus', {}, 'newest')] },
    { role: 'tool', tool_call_id: 'newest', content: '{}' },
  ]
  agent.maxWorkingMessages = 1
  agent.compactWorkingContext()
  const digest = agent.messages.find(row => row.content?.startsWith('[OBSERVATIONS COMPACTED]'))?.content
  assert.match(digest, /getInventoryItems.*WORLD-INVENTORY-MARKER/)
  assert.doesNotMatch(digest, /REFERENCE-ONLY-MARKER|getKnowledgeDetails/)
})

test('complete canonical reference text survives projection; oversized details refuse rather than truncate', () => {
  const large = { ...reference, summary: 's'.repeat(900), reference: { concepts: Array.from({ length: 20 }, (_, i) => `${i}:${'c'.repeat(100)}`), interpretation_checks: ['q'.repeat(750)] } }
  const projected = compactKnowledge(large)
  assert.ok(projected)
  assert.equal(projected.summary, large.summary)
  assert.deepEqual(projected.reference, large.reference)
  const tooLarge = { ...large, reference: { concepts: Array.from({ length: 12 }, () => 'c'.repeat(1000)), interpretation_checks: [] } }
  assert.equal(compactKnowledge(tooLarge), undefined)
  assert.equal(JSON.parse(sanitizeLibraryToolOutput('getKnowledgeDetails', tooLarge)).ok, false)
  const entries = Array.from({ length: 10 }, (_, i) => ({ ...reference, id: `large-reference-${i}`, name: 'n'.repeat(200), summary: 's'.repeat(1000) }))
  const output = sanitizeLibraryToolOutput('findKnowledge', { ok: true, results: entries }, { limit: 10 })
  assert.ok(output.length <= KNOWLEDGE_LIMITS.chars)
  assert.ok(JSON.parse(output).results.length > 0 && JSON.parse(output).results.length < 10)
  assert.ok(JSON.parse(output).results.every(entry => entry.summary.length === 1000 && entry.name.length === 200))
})

test('request supersession during native reference lookup publishes no stale answer or durable context', async () => {
  const { agent, game } = fixture()
  const original = game.command.bind(game)
  game.command = async command => { const result = await original(command); if (command.includes('autorio_references')) agent.generation++; return result }
  await assert.rejects(agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }))), /superseded|cancel/i)
  assert.ok(!agent.messages.some(row => row.role === 'tool' && row.content?.includes('REFERENCE-ONLY-MARKER')))
  assert.equal(agent.loadedSkillContext.size, 0)
})

for (const swap of ['lineage', 'role', 'actor', 'epoch', 'session']) test(`reference lookup refuses ${swap} owner changes even with unchanged request/generation/sequence`, async () => {
  const { agent, game } = fixture()
  // Deliberately hold the native validator stable to isolate the host owner fence.
  agent.assertCurrent = async () => game.status
  const original = game.command.bind(game)
  game.command = async command => {
    const result = await original(command)
    if (command.includes('autorio_references')) {
      if (swap === 'lineage') agent.agentContext.lineageSequence++
      if (swap === 'role') agent.agentContext.role = 'executor'
      if (swap === 'actor') agent.epoch.actor_id++
      if (swap === 'epoch') agent.epoch.epoch++
      if (swap === 'session') agent.epoch.session = 'replacement'
    }
    return result
  }
  await assert.rejects(agent.handleToolBatch(reply(call('getKnowledgeDetails', { id: reference.id }))), /knowledge_request_superseded/)
  assert.ok(!agent.messages.some(row => row.role === 'tool'))
  assert.equal(agent.knowledgeReads.cache.size, 0)
})

test('ordinary compaction is unchanged and restored/malicious reference cards never render or autoload', async () => {
  const ordinary = [{ role: 'assistant', tool_calls: [call('getInventoryItems', {}, 'inventory')] }, { role: 'tool', content: 'legacy world result' }]
  assert.equal(withoutKnowledgeExchange(ordinary), ordinary)
  assert.equal(renderSkillCard(reference), '')
  assert.equal(skillOfferBlock({ cards: [reference] }), '')
  assert.doesNotThrow(() => renderSkillCard({ id: 'procedure', produces: 'hostile', needs: null }))
  const { agent, game } = fixture()
  const offer = { authoring: true, cards: [reference], memoryKey: agent.activePlanKey() }
  agent.skillOffers = offer
  await loadOfferedSkillDetails(agent, offer)
  assert.equal(agent.loadedSkillContext.size, 0)
  assert.equal(game.referenceReads.length, 0)
})
