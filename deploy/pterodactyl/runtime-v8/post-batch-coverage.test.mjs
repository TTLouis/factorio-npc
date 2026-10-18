import assert from 'node:assert/strict'
import test from 'node:test'

import { EXECUTOR_ROLE } from './agent-roles.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { POST_BATCH_COVERAGE_REASON, POST_BATCH_FACTS_PREFIX, postBatchStepKey } from './post-batch-facts.mjs'

// Run Z (2026-10-18, e86934e2): every one of 21 batch receipts was routed to targeted_observation, and the decision
// opened with a read-only `gather` round (37 of them for 21 batches, 3.7 of 19.5 min). The selected families and
// receipts below are the run's shapes; the model replies are scripted and no provider is called.
const RESEARCH_ONLY = ['research_state']
const INVENTORY_ONLY = ['inventory_equipment']
const ENTITY_ONLY = ['entity_status']
const FOUR_FAMILIES = ['research_state', 'recipe_production', 'runtime_status', 'inventory_equipment']
const PLACEMENT_ONLY = ['placement_candidates']

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 15,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 1,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

function activePlan() {
  return {
    goal_id: 'goal_red',
    owner: '<server>',
    objective: 'automate red science',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['place the steam power block', 'research automation'],
    current_step: 0,
    revision: 1,
    last_chat_message: 'Building.',
    last_operations: [],
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_red',
      status: 'active',
      blocker: '',
      pause_reason: '',
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_2',
      steps: [
        { id: 'step_2', description: 'place the steam power block', status: 'active' },
        { id: 'step_3', description: 'research automation', status: 'pending' },
      ],
      evidence: [],
    },
  }
}

// The receipt of Run Z batch 20: the batch placed offshore-pump unit 35.
const PLACED_PUMP = {
  task_state: 'idle',
  queue_empty: true,
  queue_length: 0,
  last_completed_batch: { batch_id: 20, task_count: 2, task_types: ['walking', 'placing'], tick: 9000 },
  basic_operation: { last_result: { type: 'placing', completed: true, code: 'completed', tick: 8990, actor_id: 15,
    entity_name: 'offshore-pump', placed_unit_number: 35, placed_position: { x: 10.5, y: -4.5 }, placed_entity_type: 'offshore-pump' } },
}
// A batch with two placements: its last result names only the second entity.
const PLACED_TWO = {
  ...PLACED_PUMP,
  last_completed_batch: { batch_id: 21, task_count: 3, task_types: ['walking', 'placing', 'placing'], tick: 9000 },
}
const CRAFTED = {
  task_state: 'idle',
  queue_empty: true,
  queue_length: 0,
  last_completed_batch: { batch_id: 7, task_count: 1, task_types: ['crafting'], tick: 1234 },
}

class RunZRcon {
  constructor(status) {
    this.status = status
    this.commands = []
  }

  async command(text) {
    this.commands.push(text)
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify(this.status)
    if (text.includes('"get_inventory_items"')) return JSON.stringify({ items: [{ name: 'iron-plate', count: 14 }, { name: 'boiler', count: 1 }] })
    if (text.includes('remote.call("autorio_research","status")')) {
      return JSON.stringify({ current: null, queue: [], last_request: { technology: 'automation', state: 'researched' } })
    }
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ mode: 'npc', valid: true, position: { x: 3, y: 4 } })
    if (text.includes('"get_entity_status"')) {
      return JSON.stringify({ found: true, entity: { name: 'offshore-pump', unit_number: 35, position: { x: 10.5, y: -4.5 }, status: 'working' } })
    }
    return '{}'
  }
}

function runZAgent({ families, status = CRAFTED, route = 'targeted_observation' }) {
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set('npc:sgluna', activePlan())
  const calls = []
  const events = []
  const rcon = new RunZRcon(status)
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    systemPrompt: 'executor',
    npcId: 'sgluna',
    // The scripted model: records what each round offered and stops the request after the first one.
    provider: async (messages, context) => {
      calls.push({ allowTools: context.allowTools, roundPhase: context.roundPhase, messages })
      throw new Error('scripted stop after the first round')
    },
    traceFile: null,
    decisionTraceFile: null,
    stateFile: null,
  })
  const traceEvent = agent.traceEvent.bind(agent)
  agent.traceEvent = async (event, data) => {
    events.push({ event, data })
    return traceEvent(event, data)
  }
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = 'npc:sgluna'
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: '[CHAT] <server>: automate red science' },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = { memoryKey: 'npc:sgluna', turnId: 1, sender: '<server>', text: 'automate red science' }
  agent.agentContext.role = EXECUTOR_ROLE
  agent.postBatchStepKey = () => postBatchStepKey('npc:standalone_character:15:1', 'plan-red', 'step_2')
  // Jev's post-step decision as Run Z traced it (post_step.routed).
  agent.routePostStepDecision = async () => ({
    route,
    decision_called: true,
    steering: {
      reasoning_budget: 'normal',
      planning_horizon: 'checkpoint',
      observation_budget: families.length,
      observation_relevance: { source: 'typed_relevance', threshold: 0.5, selected_families: families, budget: families.length },
    },
  })
  return { agent, rcon, calls, events }
}

async function firstRound(options) {
  const world = runZAgent(options)
  await world.agent.completed().catch(() => undefined)
  assert.ok(world.calls.length >= 1, 'the decision reached the model')
  const request = world.events.find(row => row.event === 'provider.request')
  const facts = world.calls[0].messages.find(message => String(message.content).startsWith(POST_BATCH_FACTS_PREFIX))?.content ?? ''
  return { ...world, first: world.calls[0], request: request?.data, facts }
}

for (const [label, families, status, coveredBy] of [
  ['research_state (Run Z: 10 decisions, 7 read only getResearchStatus)', RESEARCH_ONLY, CRAFTED, { research_state: 'getResearchStatus' }],
  ['inventory_equipment (Run Z: re-read the prefetched inventory, then decided)', INVENTORY_ONLY, CRAFTED, { inventory_equipment: 'getInventoryItems' }],
  ['entity_status after a placement (Run Z batch 20, offshore-pump unit 35)', ENTITY_ONLY, PLACED_PUMP, { entity_status: 'getEntityStatus' }],
]) {
  test(`covered ${label}: the decision opens as decide with no read-only round`, async () => {
    const { first, request, facts, events, agent } = await firstRound({ families, status })
    assert.equal(first.allowTools, false, 'no tool round: the observation phase opens closed')
    assert.equal(first.roundPhase, 'decide')
    assert.equal(request.round_phase_reason, POST_BATCH_COVERAGE_REASON)
    const closed = events.find(row => row.event === 'observation.phase_closed')
    assert.equal(closed.data.reason_code, POST_BATCH_COVERAGE_REASON)
    assert.deepEqual(closed.data.covered_by, coveredBy)
    assert.equal(closed.data.tools_enabled, false)
    // The facts arrive as the harness fact block, not as history and not as a rule.
    assert.match(facts, new RegExp(`${Object.values(coveredBy)[0]} `))
    assert.match(facts, new RegExp(`Selected observation families these reads answer: ${families.join(', ')}$`))
    assert.equal(agent.messages.some(message => String(message.content).startsWith(POST_BATCH_FACTS_PREFIX)), false)
    assert.equal(agent.messages.some(message => /observation phase for this decision is now closed/.test(String(message.content))), false)
    // The closed-round contract is the existing one: its one targeted read stays available.
    const control = events.find(row => row.event === 'control.decision_state')
    assert.equal(control.data.tools_enabled, false)
    const bundle = events.find(row => row.event === 'observation.post_batch_facts')
    assert.deepEqual(bundle.data.uncovered_families, [])
  })
}

for (const [label, families, status, uncovered] of [
  ['research+recipe+runtime+inventory (Run Z: 7 decisions read new recipes)', FOUR_FAMILIES, CRAFTED, ['recipe_production']],
  ['placement_candidates (no argument-free read)', PLACEMENT_ONLY, CRAFTED, ['placement_candidates']],
  ['entity_status after a batch that placed nothing', ENTITY_ONLY, CRAFTED, ['entity_status']],
  ['entity_status after a batch that placed two entities', ENTITY_ONLY, PLACED_TWO, ['entity_status']],
]) {
  test(`uncovered ${label}: the read-only round still opens`, async () => {
    const { first, request, events, facts } = await firstRound({ families, status })
    assert.equal(first.allowTools, true)
    assert.equal(first.roundPhase, 'gather')
    assert.equal(request.round_phase_reason, 'observation_phase_open')
    assert.equal(events.some(row => row.event === 'observation.phase_closed'), false)
    const bundle = events.find(row => row.event === 'observation.post_batch_facts')
    assert.deepEqual(bundle.data.uncovered_families, uncovered)
    // The covered part is still delivered as facts.
    assert.ok(facts.startsWith(POST_BATCH_FACTS_PREFIX))
  })
}

test('the four-family shape still reads every family that has a default, so the model need not', async () => {
  const { facts, events } = await firstRound({ families: FOUR_FAMILIES })
  assert.match(facts, /getResearchStatus \{\} => \{"current":null/)
  assert.match(facts, /getActorStatus \{\} => \{"mode":"npc"/)
  assert.match(facts, /getInventoryItems \{\} => /)
  const bundle = events.find(row => row.event === 'observation.post_batch_facts')
  assert.deepEqual(bundle.data.covered_families, ['research_state', 'runtime_status', 'inventory_equipment'])
})

test('a failure receipt carries the family facts but never closes the read-only phase', async () => {
  const world = runZAgent({ families: RESEARCH_ONLY })
  await world.agent.failed('placement refused: entity overlap').catch(() => undefined)
  assert.equal(world.calls[0].allowTools, true)
  assert.equal(world.events.some(row => row.event === 'observation.phase_closed'), false)
  const bundle = world.events.find(row => row.event === 'observation.post_batch_facts')
  assert.deepEqual(bundle.data.covered_families, RESEARCH_ONLY)
})

test('a failure receipt does not name an older batch\'s placement as the entity to read', async () => {
  const world = runZAgent({ families: ENTITY_ONLY, status: PLACED_PUMP })
  await world.agent.failed('placement refused: entity overlap').catch(() => undefined)
  assert.equal(world.rcon.commands.some(command => command.includes('"get_entity_status"')), false)
  const bundle = world.events.find(row => row.event === 'observation.post_batch_facts')
  assert.deepEqual(bundle.data.uncovered_families, ENTITY_ONLY)
})

test('a planner, or a continue route without a Jev selection, keeps today\'s rounds', async () => {
  const planner = runZAgent({ families: RESEARCH_ONLY })
  planner.agent.agentContext.role = 'planner'
  await planner.agent.completed().catch(() => undefined)
  assert.equal(planner.events.some(row => row.event === 'observation.phase_closed'), false)

  const empty = runZAgent({ families: [], route: 'continue_current' })
  await empty.agent.completed().catch(() => undefined)
  assert.equal(empty.events.some(row => row.event === 'observation.phase_closed'), false)
})
