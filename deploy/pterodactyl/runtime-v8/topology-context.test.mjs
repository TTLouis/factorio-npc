import assert from 'node:assert/strict'
import test from 'node:test'
import { topologyCapacity, topologyEntities, topologyJson, topologyObstruction, topologyText, TOPOLOGY_PREFIX } from './topology-context.mjs'
import { KEY, recoveryWorld, recoverySession, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'
import { FakeFactorio, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { getActivePlan } from './planning-state.mjs'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'

export const nativeBoiler = {
  name: 'boiler', type: 'boiler', unit_number: 21, position: { x: -21.5, y: -95 }, direction: 8, status_name: 'no_fuel',
  spatial: { fluid: { storages: [{ index: 1, capacity: 200, contents: { name: 'water', amount: 200, temperature: 15 },
    connections: [{ connection_index: 1, position: { x: -20.5, y: -95.5 }, target: { name: 'offshore-pump', unit_number: 20 }, reciprocal: true }] },
    { index: 2, capacity: 200, connections: [{ connection_index: 1, position: { x: -21.5, y: -94 }, target_position: { x: -21.5, y: -93 }, flow_direction: 'output' }] }] },
    power: { stored_energy_joules: 0, prototype: { power: { consumption_watts: 1800000 }, thermal: { source: 'running_prototype',
      target_temperature: 165, output_fluid: 'steam', fluid_output_per_second_at_target: 60, prototype_quality: 'normal', conditional_on: 'full_energy_supply_and_input_fluid_at_default_temperature' } } } },
}
export const nativeNearby = () => ({ actor_id: 18, observed_tick: 1000, surface_index: 1, force_index: 1, entities: [structuredClone(nativeBoiler)], truncated: false })
export const nativeEngine = { found: true, entity: { name: 'steam-engine', type: 'generator', power: { production_watts: 900000, fluid_usage_per_second: 30, maximum_temperature: 165 }, fluidboxes: [{ filter: 'steam' }] } }
export const nativeBlocked = () => ({ ok: true, entity_name: 'steam-engine', legal_candidate_count: 0, candidates: [], obstructions: {
  source: 'native_placement_checks', actor_id: 18, observed_tick: 1000, surface_index: 1, force_index: 1, scope: 'sampled_footprints', examined_count: 2, rejected_count: 2, unknown_count: 0, truncated: false,
  samples: [{ position: { x: -21.5, y: -90.5 }, direction: 0, unknown: false, terrain_tiles: [{ name: 'water', position: { x: -21, y: -91 } }], entities: [{ name: 'small-electric-pole', position: { x: -21.5, y: -92.5 } }] }],
} })
const contextOf = messages => {
  const lines = messages.flatMap(row => String(row.content ?? '').split('\n')).filter(line => line.startsWith(TOPOLOGY_PREFIX))
  assert.equal(lines.length, 1, 'one fresh compact record replaces all older records')
  assert.ok(lines[0].length <= 1950)
  return JSON.parse(lines[0].slice(TOPOLOGY_PREFIX.length))
}
class TopologyGame extends FakeFactorio {
  constructor() {
    super({ inventory: { 'steam-engine': 1, 'iron-plate': 2 } })
    this.status.surface_index = 1; this.status.force_index = 1
    this.topologyReads = []; this.nativeNearby = nativeNearby(); this.blocked = nativeBlocked()
  }
  async command(text) {
    if (text.includes('"get_nearby_entities"')) { this.topologyReads.push('nearby'); this.onTopologyRead?.(); return typeof this.nativeNearby === 'string' ? this.nativeNearby : JSON.stringify(this.nativeNearby) }
    if (text.includes('"get_inventory_items"')) this.topologyReads.push('inventory')
    if (text.includes('"autorio_prototypes","details"')) { this.topologyReads.push('prototype'); return JSON.stringify(nativeEngine) }
    if (text.includes('"get_placement_candidates"')) { this.topologyReads.push('placement'); return JSON.stringify(this.blocked) }
    return super.command(text)
  }
}
const STEP = 'Route the steam engine inland with pipes without redesigning the boiler'
const cp = inventoryCheckpoint('pipe', 1)
const draft = () => planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: cp, stepCompletions: [{ kind: 'deterministic', checkpoint: cp }],
  goal: { scope: 'finite', summary: 'Route the steam engine inland and have one pipe', doneWhen: cp.requirements } })
const read = () => ({ tool_calls: [{ id: 'blocked-engine', type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name: 'steam-engine', connects_to: { unit_number: 21, storage_index: 2 }, limit: 4 }) } }] })
const craft = () => planReply({ plan: [STEP], currentStep: 0, operations: [{ name: 'craft_item', args: { item_name: 'pipe', count: 1 } }], checkpoint: cp })
function harness(game = new TopologyGame(), { rawProvider = false } = {}) {
  const model = new ScriptedModel()
  const wires = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna', AI_API_METHOD: 'cli-proxy' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); wires.push({ ...body, role: context.role })
    const reply = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ choices: [{ finish_reason: reply.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...reply } }], usage: { prompt_tokens: 2000, completion_tokens: 120 } }), { status: 200 })
  } })
  const world = recoveryWorld({ game, model, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context),
    decisionScript: (_state, questions) => ({ overrides: Object.fromEntries(Object.keys(questions).filter(key => key.startsWith('need_')).map(key => [key, { noul: 0.9 }])) }) })
  world.modelRequests = wires
  if (rawProvider) world.agent.provider = (messages, context) => bridge.roleProvider(messages, context)
  const ctx = { game, model, world, ...recoverySession(world) }
  return ctx
}
async function begin(ctx) { ctx.session.queuePlayerRequest('TTLouis', 'Use the held steam engine to power the factory'); await settle(ctx.session) }

test('full Session delegates lean fresh topology and admitted obstruction facts without changing plan or allowances', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness(); let committed, allowance, beforeClosed, boundaryReads
  ctx.model.push('planner', 'fresh planner', messages => {
    const facts = contextOf(messages)
    assert.equal(facts.state, 'fresh'); assert.equal(facts.held['steam-engine'], 1)
    assert.equal(facts.entities[0].name, 'boiler'); assert.equal(facts.entities[0].fluid[0].ports[0].reciprocal, true)
    assert.equal(facts.capacity[0].consumers_per_producer, 2); assert.match(facts.expansion, /Reserve room/)
    return draft()
  }).push('executor', 'fresh executor observes legal-footprint failure', messages => {
    const facts = contextOf(messages); assert.equal(facts.held['steam-engine'], 1); assert.equal(facts.capacity[0].consumers_per_producer, 2)
    committed = structuredClone(getActivePlan(ctx.world.memory.planningState(KEY)))
    allowance = structuredClone(ctx.world.memory.autoResumeAllowance(KEY))
    ctx.world.agent.observationBudgetRemaining = 1
    boundaryReads = ctx.game.topologyReads.length
    return read()
  }).push('executor', 'closed decision uses sampled water obstruction and held engine', (messages, context) => {
    assert.equal(context.allowTools, false)
    const facts = contextOf(messages)
    assert.equal(facts.held['steam-engine'], 1)
    assert.equal(facts.obstructions[0].samples[0].terrain[0].name, 'water')
    assert.equal(facts.obstructions[0].samples[0].entities[0].name, 'small-electric-pole')
    assert.equal(ctx.game.topologyReads.length, boundaryReads + 1, 'closed turn adds no free native refresh or placement solve')
    beforeClosed = ctx.world.agent.observationBudgetRemaining
    return craft()
  })
  await begin(ctx)
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.equal(ctx.game.topologyReads.filter(name => name === 'placement').length, 1, 'only the admitted model observation solves candidates')
  assert.equal(beforeClosed, 0)
  const plan = getActivePlan(ctx.world.memory.planningState(KEY))
  assert.deepEqual(plan.steps, committed.steps); assert.equal(plan.plan_id, committed.plan_id)
  assert.deepEqual(ctx.world.memory.autoResumeAllowance(KEY), allowance)
  assert.ok(ctx.world.named('context.topology_refreshed').every(row => row.request_id && row.reason && row.reads_attempted <= 3 && row.candidate_solves === 0))
  assert.deepEqual(ctx.world.modelRequests.map(row => row.model), ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-luna'])
  assert.deepEqual(ctx.world.modelRequests.map(row => row.tool_choice), ['auto', 'auto', 'none'])
  for (const wire of ctx.world.modelRequests) {
    assert.equal(wire.tools.length, 40)
    contextOf(wire.messages)
    const handoff = wire.messages.filter(row => String(row.content).startsWith('[HANDOFF]') || String(row.content).startsWith('--- step block ---') || String(row.content).startsWith(TOPOLOGY_PREFIX))
    if (handoff.some(row => String(row.content).startsWith('[HANDOFF]'))) assert.ok(handoff.reduce((n, row) => n + row.content.length + 1, 0) <= 6000)
  }
  assert.equal(ctx.game.mutations.length, 1)
})

test('native capacity is conditional and uses modded prototype rates rather than a memorized two', () => {
  const nearby = topologyEntities(nativeNearby())
  assert.equal(topologyCapacity(nearby, nativeEngine)[0].consumers_per_producer, 2)
  const engine = structuredClone(nativeEngine); engine.entity.power.fluid_usage_per_second = 20
  assert.equal(topologyCapacity(nearby, engine)[0].consumers_per_producer, 3)
  engine.entity.power.maximum_temperature = 100; assert.deepEqual(topologyCapacity(nearby, engine), [])
  engine.entity.power.maximum_temperature = 165; engine.entity.fluidboxes[0].filter = 'water'; assert.deepEqual(topologyCapacity(nearby, engine), [])
  delete nearby.entities[0].thermal.source; assert.deepEqual(topologyCapacity(nearby, nativeEngine), [])
  const hot = structuredClone(nativeEngine); hot.entity.fluidboxes[0].minimum_temperature = 500; hot.entity.power.maximum_temperature = 1000
  assert.deepEqual(topologyCapacity(topologyEntities(nativeNearby()), hot), [])
})

test('malformed and oversized reads never produce authoritative fresh topology; serialization stays whole and bounded', () => {
  for (const raw of ['no-json', '[]', 'x'.repeat(50000)]) assert.equal(topologyJson(raw), undefined)
  assert.equal(topologyEntities({ entities: [] }), undefined)
  assert.equal(topologyObstruction({ ...nativeBlocked(), obstructions: { source: 'made-up', samples: [] } }), undefined)
  const facts = { state: 'fresh', entities: Array.from({ length: 100 }, () => nativeBoiler), obstructions: [topologyObstruction(nativeBlocked())], capacity: [] }
  const text = topologyText(facts); assert.ok(text.length <= 1950); assert.equal(JSON.parse(text.slice(TOPOLOGY_PREFIX.length)).truncated, true)
})

for (const scenario of ['malformed', 'oversized', 'missing_scope', 'actor_mismatch', 'surface_mismatch', 'force_mismatch', 'stale_tick']) test(`full Session refuses fresh topology from ${scenario}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new TopologyGame()
  if (scenario === 'malformed') game.nativeNearby = 'not-json'
  if (scenario === 'oversized') game.nativeNearby = 'x'.repeat(50000)
  if (scenario === 'missing_scope') delete game.status.surface_index
  if (scenario === 'actor_mismatch') game.nativeNearby.actor_id = 999
  if (scenario === 'surface_mismatch') game.nativeNearby.surface_index = 99
  if (scenario === 'force_mismatch') game.nativeNearby.force_index = 99
  if (scenario === 'stale_tick') game.nativeNearby.observed_tick = -1
  const ctx = harness(game)
  const check = messages => {
    const facts = contextOf(messages); assert.equal(facts.state, 'unavailable'); assert.equal(facts.entities, undefined); assert.equal(facts.held, undefined); assert.equal(facts.capacity, undefined)
  }
  ctx.model.push('planner', 'unknown world is explicit', messages => { check(messages); return draft() })
    .push('executor', 'unknown world remains explicit', messages => { check(messages); return craft() })
  await begin(ctx)
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.equal(ctx.game.topologyReads.filter(read => read === 'placement').length, 0)
  if (scenario === 'missing_scope') assert.equal(ctx.game.topologyReads.filter(read => read === 'nearby').length, 0)
})

test('full Session retains relevant engine count beyond eight held items and labels omitted stock unknown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const game = new TopologyGame()
  game.inventory = { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`unrelated-${i}`, 1])), 'steam-engine': 1, 'iron-plate': 2 }
  const ctx = harness(game)
  const check = messages => { const facts = contextOf(messages); assert.equal(facts.held['steam-engine'], 1); assert.ok(facts.held_omitted > 0); assert.match(facts.held_scope, /omitted_counts_unknown/); assert.equal(facts.truncated, true) }
  ctx.model.push('planner', 'relevant stock first', messages => { check(messages); return draft() })
    .push('executor', 'relevant stock survives role handoff', messages => { check(messages); return craft() })
  await begin(ctx); assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
})

for (const change of ['actor', 'epoch', 'session', 'surface', 'force', 'cancel']) test(`full Session discards a topology refresh superseded during its native await: ${change}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.game.onTopologyRead = () => {
    ctx.game.onTopologyRead = undefined
    if (change === 'actor') ctx.game.status.actor_id++
    if (change === 'epoch') ctx.game.status.epoch++
    if (change === 'session') ctx.game.status.session = 'fedcba9876543210fedcba9876543210'
    if (change === 'surface') ctx.game.status.surface_index++
    if (change === 'force') ctx.game.status.force_index++
    if (change === 'cancel') ctx.world.agent.cancel()
  }
  await begin(ctx)
  assert.equal(ctx.world.modelRequests.length, 0, 'no wire request receives obsolete facts')
  assert.equal(ctx.game.mutations.length, 0)
})

test('a pending mutation suppresses cached facts and spends zero new topology reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.model.push('planner', 'initial current world', messages => { contextOf(messages); return draft() })
    .push('executor', 'native operation ready', () => craft())
  await begin(ctx)
  assert.equal(ctx.world.agent.batchInFlight, true)
  const count = ctx.game.topologyReads.length
  const facts = await ctx.world.agent.gatherTopologyContext()
  assert.equal(facts.state, 'deferred'); assert.equal(facts.entities, undefined); assert.equal(facts.held, undefined)
  assert.equal(ctx.game.topologyReads.length, count)
})

test('the exact minimal factory objective receives initial lean topology without a bootstrap prompt', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.model.push('planner', 'minimal goal sees native boiler and unknown ratio', messages => {
    const facts = contextOf(messages); assert.equal(facts.state, 'fresh'); assert.equal(facts.entities[0].name, 'boiler')
    assert.equal(facts.capacity.length, 0, 'no invented ratio before a named relevant consumer prototype is read')
    return draft()
  }).push('executor', 'explicit steam step now resolves held engine', messages => { assert.equal(contextOf(messages).capacity[0].consumers_per_producer, 2); return craft() })
  ctx.session.queuePlayerRequest('TTLouis', 'Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.')
  await settle(ctx.session); assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
})

for (const scope of ['surface_index', 'force_index']) test(`cached open-to-closed topology suppresses ${scope} changes`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.model.push('planner', 'draft', () => draft())
    .push('executor', 'last admitted observation', () => { ctx.world.agent.observationBudgetRemaining = 1; return read() })
    .push('executor', 'cached scope changed', messages => { const facts = contextOf(messages); assert.equal(facts.state, 'unavailable'); assert.equal(facts.entities, undefined); assert.equal(facts.obstructions, undefined); return craft() })
  const original = ctx.game.command.bind(ctx.game)
  ctx.game.command = async text => {
    const answer = await original(text)
    if (text.includes('"get_placement_candidates"')) ctx.game.status[scope]++
    return answer
  }
  await begin(ctx); assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
})

for (const field of ['actor_id', 'surface_index', 'force_index', 'observed_tick']) test(`admitted obstruction with wrong ${field} never enters fresh topology`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness(); ctx.game.blocked.obstructions[field] = field === 'observed_tick' ? 999 : 99
  ctx.model.push('planner', 'draft', () => draft())
    .push('executor', 'observe rejected footprint', () => read())
    .push('executor', 'do not reassign witness scope', messages => { assert.equal(contextOf(messages).obstructions, undefined); return craft() })
  await begin(ctx); assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
})

test('mutation watermark drops same-tick obstruction evidence', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.model.push('planner', 'draft', () => draft()).push('executor', 'observe', () => read())
    .push('executor', 'finish', messages => { assert.ok(contextOf(messages).obstructions); return craft() })
  await begin(ctx)
  ctx.world.agent.batchInFlight = false
  ctx.world.memory.pendingOperation = () => undefined
  const newer = await ctx.world.agent.gatherTopologyContext()
  assert.equal(newer.observed_tick, 1000)
  assert.equal(newer.obstructions, undefined, 'native tick equality cannot restore a pre-mutation witness')
})

test('full Session routes inland via fresh candidate reads through JIT planner context and verified power completion', async t => {
  // Declared deterministic world: the native lane separately proves terrain and electric physics.
  // Here every state transition is caused by the real loop admitting the corresponding operation.
  const game = new TopologyGame(); game.inventory['iron-plate'] = 8
  let pipes = 0
  let engine = false
  const original = game.command.bind(game)
  game.command = async text => {
    if (text.includes("remote.call('autorio_preflight','operation','place_candidate'")) return JSON.stringify({ ok: true })
    if (text.includes('"evaluate_condition"') && text.includes('"kind":"entity_count"')) return JSON.stringify({ ok: true, kind: 'entity_count', satisfied: engine, current: engine ? 1 : 0, found: engine ? 1 : 0, minimum: 1, prototype: 'steam-engine', tick: 1000, truncated: false })
    if (text.includes('"get_placement_candidates"')) {
      game.topologyReads.push('placement')
      const pipe = text.includes("entity_name='pipe'")
      if (!pipe && pipes < 2) return JSON.stringify(game.blocked)
      return JSON.stringify({ ok: true, entity_name: pipe ? 'pipe' : 'steam-engine', candidate_set_id: `placement-${pipes + 1}`, legal_candidate_count: 1, returned_candidate_count: 1,
        candidates: [{ id: `candidate-${pipe ? pipes + 1 : 3}`, position: { x: -23.5 - pipes, y: -94 }, direction: 0 }] })
    }
    return original(text)
  }
  game.onMutation = text => {
    if (text.includes("'craft_item','pipe',2")) { game.inventory['iron-plate'] -= 2; game.inventory.pipe = 2 }
    if (text.includes("'place_candidate'")) {
      game.lastTaskTypes = ['placing']
      if (text.includes("'candidate-3'")) { assert.equal(pipes, 2); assert.equal(game.inventory['steam-engine'], 1); game.inventory['steam-engine']--; engine = true }
      else { assert.ok(game.inventory.pipe > 0); game.inventory.pipe--; pipes++ }
    }
    game.worldReadings['electric_network_satisfied:steam-engine'] = [{ ok: true, satisfied: engine, current: engine ? 1 : 0 }]
  }
  const ctx = harness(game, { rawProvider: true })
  t.after(() => { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  const steps = ['Craft two pipes for the steam engine', STEP]
  const first = inventoryCheckpoint('pipe', 2)
  const power = { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'steam-engine', state: 'powered', minimum: 1 }] }
  const control = (operations, checkpoint = power) => planReply({ plan: steps, currentStep: checkpoint === first ? 0 : 1, operations, checkpoint })
  const tool = entity_name => ({ tool_calls: [{ id: `route-${entity_name}-${pipes}`, type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name, connects_to: { unit_number: 21, storage_index: 2 }, limit: 4 + pipes }) } }] })
  const place = messages => {
    const result = JSON.parse(messages.findLast(row => row.role === 'tool').content)
    assert.ok(result.candidates[0]?.id)
    return control([{ name: 'place_candidate', args: { candidate_set_id: result.candidate_set_id, candidate_id: result.candidates[0].id } }])
  }
  ctx.model.push('planner', 'finite plan leaves room for two but builds one engine', messages => {
    assert.equal(contextOf(messages).capacity[0].consumers_per_producer, 2)
    return planReply({ plan: steps, currentStep: 0, operations: [], checkpoint: first,
      stepCompletions: [{ kind: 'deterministic', checkpoint: first }, { kind: 'deterministic', checkpoint: power }],
      goal: { scope: 'finite', summary: 'Power one held steam engine through the existing boiler', doneWhen: [{ kind: 'electric_network_satisfied', entity_name: 'steam-engine', minimum: 1 }] } })
  }).push('executor', 'craft pipes from real fixture stock', () => control([{ name: 'craft_item', args: { item_name: 'pipe', count: 2 } }], first))
    .push('planner', 'JIT sees refreshed topology after crafting', messages => {
      const packet = JSON.parse(messages.find(row => String(row.content).startsWith('[STEP_CONTRACT_REQUEST]')).content.split('nothing else. ')[1])
      assert.equal(packet.facts.topology.state, 'fresh'); assert.equal(packet.facts.topology.held.pipe, 2)
      assert.equal(packet.facts.topology.capacity[0].consumers_per_producer, 2)
      return { content: JSON.stringify({ stepId: packet.target.step_id, checkpoint: power }) }
    }).push('executor', 'read direct illegal footprint', () => tool('steam-engine'))
    .push('executor', 'water witness selects pipe route', messages => { assert.equal(contextOf(messages).obstructions[0].samples[0].terrain[0].name, 'water'); return tool('pipe') })
    .push('executor', 'place pipe one', place)
    .push('executor', 'read refreshed second pipe placement', messages => { assert.equal(contextOf(messages).held.pipe, 1); assert.equal(contextOf(messages).obstructions, undefined); return tool('pipe') })
    .push('executor', 'place pipe two', place)
    .push('executor', 'read refreshed engine placement', () => tool('steam-engine'))
    .push('executor', 'place only held engine', place)
  await begin(ctx)
  const goalId = ctx.world.memory.planningState(KEY).goal.goal_id
  assert.deepEqual(ctx.model.violations, [], JSON.stringify(ctx.world.trace.filter(row => /rejected|refused|invalid|correction|failed/.test(row.event)).map(row => ({ event: row.event, data: row.data }))))
  assert.deepEqual(ctx.world.named('request.failed'), [])
  const committed = structuredClone(getActivePlan(ctx.world.memory.planningState(KEY)).steps)
  for (let n = 0; n < 4; n++) { ctx.session.lastCompletionAt = 0; ctx.session.onGameLine('[AUTORIO] All operations completed'); await settle(ctx.session) }
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual(ctx.model.remaining, []); assert.equal(engine, true); assert.equal(pipes, 2)
  assert.equal(game.mutations.length, 4); assert.equal(game.inventory['steam-engine'], 0)
  assert.ok(ctx.world.named('plan.persisted').filter(row => row.goal_id).every(row => row.goal_id === goalId))
  assert.equal(ctx.world.memory.planningState(KEY).goal, null)
  assert.ok(ctx.world.named('plan.accepted').every(row => JSON.stringify(row.plan) === JSON.stringify(committed.map(step => step.description))))
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.world.named('recovery.auto_resume_started').length, 0)
})

test('C7 common recovery restage refreshes topology after a real receipt and preserves plan, prefix and resume allowance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  const target = inventoryCheckpoint('pipe', 2)
  ctx.game.onMutation = text => { if (text.includes("'craft_item','pipe',1")) { ctx.game.inventory['iron-plate']--; ctx.game.inventory.pipe = (ctx.game.inventory.pipe ?? 0) + 1 } }
  const next = () => planReply({ plan: [STEP], currentStep: 0, operations: [{ name: 'craft_item', args: { item_name: 'pipe', count: 1 } }], checkpoint: target })
  ctx.model.push('planner', 'two-pipe goal', () => planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: target,
    stepCompletions: [{ kind: 'deterministic', checkpoint: target }], goal: { scope: 'finite', summary: 'Have two pipes for the steam engine route', doneWhen: target.requirements } }))
    .push('executor', 'first pipe batch', () => next())
    .push('executor', 'fresh C7 executor uses post-receipt counts', messages => {
      const facts = contextOf(messages)
      assert.equal(facts.state, 'fresh'); assert.equal(facts.held.pipe, 1); assert.equal(facts.held['steam-engine'], 1)
      assert.equal(facts.capacity[0].consumers_per_producer, 2)
      assert.ok(messages.some(row => String(row.content).includes('checkpoint=C7')))
      return next()
    })
  await begin(ctx)
  const committed = structuredClone(getActivePlan(ctx.world.memory.planningState(KEY)))
  const prefix = ctx.world.modelRequests[1].messages.find(row => String(row.content).startsWith('[HANDOFF]')).content
  // Same receipt reader and same common C7 restage entrypoint used by supervisor recovery;
  // no timer or durable allowance is manufactured for this context-only boundary.
  await ctx.world.agent.taskStatusReceipt()
  const allowance = structuredClone(ctx.world.memory.autoResumeAllowance(KEY))
  const result = await ctx.world.agent.restageBetweenTurns({ checkpoint: 'C7', role: 'executor', reason: 'recovery:topology_receipt_test', actor: ctx.world.agent.epoch, requestId: 'topology-c7' })
  assert.equal(result.restaged, true)
  await ctx.world.agent.continueFromModMessage('[MOD] The first pipe batch completed; continue the committed steam route.', 'factorio.completion_continuation')
  assert.deepEqual(ctx.world.memory.autoResumeAllowance(KEY), allowance)
  assert.deepEqual(getActivePlan(ctx.world.memory.planningState(KEY)).steps, committed.steps)
  assert.equal(ctx.world.modelRequests[2].messages.find(row => String(row.content).startsWith('[HANDOFF]')).content, prefix)
  ctx.session.lastCompletionAt = 0; ctx.session.onGameLine('[AUTORIO] All operations completed'); await settle(ctx.session)
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), []); assert.deepEqual(ctx.model.remaining, [])
  assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(ctx.game.mutations.length, 2)
})
