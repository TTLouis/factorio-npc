import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { answersStepContract, FakeFactorio, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:sgluna'
const basePrompt = await fs.readFile(new URL('../../../packages/agent/src/llm/prompt.md', import.meta.url), 'utf8')
const loop = version => new NpcAgentLoop({ rcon: { command: async () => '{}' }, provider: async () => { throw new Error('no inference') },
  npcId: 'sgluna', systemPrompt: `${basePrompt}\n\n## Runtime reliability additions\nKeep fixture reliability.`, completionProtocolVersion: version,
  stateFile: null, traceFile: null, decisionTraceFile: null })

test('protocol 3 delivers distinct planning and execution prefixes while preserving native tools and legacy wires', () => {
  const agent = loop(3)
  const planner = agent.rolePrefixMessages('planner')[0].content
  const executor = agent.rolePrefixMessages('executor')[0].content
  assert.match(planner, /CONSTRUCTION BOUNDARIES/)
  assert.match(planner, /every promised kit item belongs in the checkpoint/)
  assert.match(executor, /\[EXECUTOR STATE\]/)
  assert.match(executor, /Never guess fluid connections/)
  assert.match(executor, /\[POST_BATCH_FACTS\]/)
  assert.doesNotMatch(executor, /Every goal starts with a goal definition|On every newly authored plan/)
  for (const prefix of [planner, executor]) {
    assert.doesNotMatch(prefix, /Your entire non-tool response MUST be one strict JSON object with exactly these fields/)
    assert.match(prefix, /Keep fixture reliability/)
    assert.match(prefix, /### Complete operation list/)
    assert.match(prefix, /validateConstructionPlan|execute_construction_plan/)
    assert.match(prefix, /untrusted/)
    assert.match(prefix, /anchor.*requires.*radius|anchor.*ALWAYS requires/)
  }
  assert.match(loop(2).rolePrefixMessages('executor')[0].content, /Your entire non-tool response MUST/)
  assert.equal(agent.rolePrefixMessages('executor')[0].content, executor, 'prefix stays stable across restages')
  assert.ok(executor.length < planner.length, 'executor no longer receives the durable goal/shelf authoring protocol')
})

// This proves orchestration and contract boundaries with scripted responses,
// not Factorio fluid physics or a real model's compliance with the new prompt.
test('pump, boiler and engine boundaries retain the global goal and allow fresh reads at the newly active step', async () => {
  const names = ['offshore-pump', 'boiler', 'steam-engine']
  const descriptions = ['Install the shoreline pump.', 'Join the boiler at the observed pump outlet.', 'Join the engine at the observed boiler steam outlet.']
  const contracts = Object.fromEntries(descriptions.map((text, i) => [text,
    { mode: 'all', requirements: [{ kind: 'entity_count', prototype: names[i], minimum: 1 }] }]))
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio({ inventory: Object.fromEntries(names.map(name => [name, 1])) })
  game.status.connected_players = 0
  const placed = []
  const evaluate = game.evaluateGoalCondition.bind(game)
  game.evaluateGoalCondition = request => request.kind === 'entity_count'
    ? { ok: true, kind: request.kind, prototype: request.prototype, minimum: request.minimum,
        current: placed.filter(e => e.name === request.prototype).length,
        satisfied: placed.some(e => e.name === request.prototype), tick: ++game.gameTick }
    : evaluate(request)
  const calls = []
  const readSteps = new Set()
  const events = []
  const provider = answersStepContract(async (messages, context) => {
    calls.push({ role: context.role, messages })
    if (context.role === 'planner') return planReply({ plan: descriptions, currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Build working steam generation.', doneWhen: [{ kind: 'entity_working', entity_name: 'steam-engine', minimum: 1 }] },
      stepCompletions: descriptions.map((text, i) => ({ kind: 'deterministic', ...(i === 0 ? { checkpoint: contracts[text] } : {}) })),
      executionGuidance: descriptions.map(text => ({ approach: text, rationale: 'Resolve the next new native identity at its own boundary.', constraints: ['Keep the functional goal.'], skillIds: [], materialSupply: null })),
    })
    const plan = getActivePlan(memory.planningState(KEY))
    const index = plan.active_step_index
    const stepId = plan.steps[index].step_id
    if (index > 0 && !readSteps.has(stepId)) {
      assert.equal(agent.controlDecisionState(true).toolsEnabled, true)
      readSteps.add(stepId)
      return { content: '', tool_calls: [{ id: `boundary-${index}`, type: 'function',
        function: { name: 'getNearbyEntities', arguments: JSON.stringify({ name: names[index - 1], radius: 8, limit: 4 }) } }] }
    }
    if (index > 0) assert.ok(messages.some(m => m.role === 'tool' && m.content.includes(String(100 + index - 1))), 'new placement identity was delivered before the next stage')
    return planReply({ stepId, operations: [{ name: 'place_entity', args: { entity_name: names[index], x: index * 4, y: 0 } }] })
  }, { contracts })
  const agent = new NpcAgentLoop({ rcon: game, memory, provider, npcId: 'sgluna', systemPrompt: basePrompt,
    completionProtocolVersion: 3, replacementWake: true, stateFile: null, traceFile: null, decisionTraceFile: null,
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    onActivity: (event, data) => events.push({ event, data }) })
  game.onMutation = () => {
    const index = getActivePlan(memory.planningState(KEY)).active_step_index
    placed.push({ name: names[index], unit_number: 100 + index, position: { x: index * 4, y: 0 } })
    game.nearby = { actor_position: { x: 0, y: 0 }, entities: [...placed] }
  }
  await agent.request('Build working steam generation.', { sender: 'Louis' })
  await agent.completed()
  await agent.completed()
  const plan = getActivePlan(memory.planningState(KEY))
  assert.deepEqual(placed.map(e => e.name), names)
  assert.equal(readSteps.size, 2)
  assert.equal(game.mutations.length, 3)
  assert.equal(plan.active_step_index, 2)
  assert.equal(memory.planningState(KEY).goal.status, 'active', 'three placements do not establish powered operation')
  assert.deepEqual(plan.steps.map(s => s.description), descriptions, 'the harness did not rewrite the committed plan')
  assert.equal(provider.contractCalls.length, 2, 'later contracts are bound only at their boundary')
  assert.ok(events.some(e => e.event === 'step.entity_count_checked' && e.data.request_id), 'native checkpoint checks remain request-correlated')
  assert.equal(calls.filter(c => c.role === 'planner').length, 1)
})
