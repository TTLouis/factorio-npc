import assert from 'node:assert/strict'
import test from 'node:test'
import { recoveryWorld, recoverySession, ScriptedModel, settle } from './recovery-loop-fixtures.mjs'
import { FakeFactorio, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'
import { configuration, Session } from './supervisor.mjs'
import { providerRequest } from './provider.mjs'
import { toolCommand } from './structured-policy.mjs'

// M3: the bounded map context the mod reports (a chunk crop with its surface, origin, tick and revision, and what it left
// out) reaches the model through the real runtime: the executor's tool batch, the tool renderers, the context assembler,
// and every supported provider serializer. No live inference: the provider is a fetch fixture.

const SURFACE = { surface_index: 1, surface_name: 'nauvis' }
const TICK = 51234
const REVISION = 17

// Shapes and sizes follow the mod's map_crop and candidate_map_context (packages/autorio/src/map_knowledge.ts,
// placement_candidates.ts): radius 3 around the actor for getMapContext, radius 2 around the evaluated area for candidates.
export function nativeCrop({ center = { x: -1, y: -3 }, radius = 3 } = {}) {
  const size = radius * 2 + 1
  const rows = []
  const counts = { visible: 0, fogged: 0, unknown: 0, total: size * size }
  for (let dy = -radius; dy <= radius; dy++) {
    let row = ''
    for (let dx = -radius; dx <= radius; dx++) {
      const letter = Math.max(Math.abs(dx), Math.abs(dy)) <= 2 ? 'V' : dx < 0 ? 'F' : 'U'
      row += letter
      counts[letter === 'V' ? 'visible' : letter === 'F' ? 'fogged' : 'unknown']++
    }
    rows.push(row)
  }
  const origin = { x: center.x - radius, y: center.y - radius }
  return {
    source: 'npc_map_knowledge', ...SURFACE, force_index: 1, observed_tick: TICK, revision: REVISION, chunk_size: 32,
    center_chunk: center, radius_chunks: radius, origin: { chunk: origin, tile: { x: origin.x * 32, y: origin.y * 32 } },
    legend: 'V visible now; F explored, fogged (old observation, not fresh); U never explored', rows, counts,
    visible_window: { chunk: { x: -1, y: -3 }, chunk_radius: 2 },
    explored_record: { chunks_on_surface: 61, outside_crop: 61 - counts.visible - counts.fogged, chunk_bounds: { min: { x: -9, y: -8 }, max: { x: 2, y: 1 } } },
  }
}

// A realistic answer: eight candidates with clears and fluid ports, and sampled rejected footprints, well over the
// renderer's leading block, so map_context must survive ordering and the 12000-character tool-output limit.
export function nativeCandidates() {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: `cand-${index + 1}`, entity_name: 'steam-engine', position: { x: -30.5 + index * 3, y: -88.5 }, direction: 0,
    footprint: { left_top: { x: -32 + index * 3, y: -91 }, right_bottom: { x: -29 + index * 3, y: -86 } },
    distance_from_anchor: 4.5 + index, fluid_ports: [{ position: { x: -30.5 + index * 3, y: -91.5 }, target_position: { x: -30.5 + index * 3, y: -92.5 } }],
    clears: [{ name: 'tree-02', reason: 'natural_obstruction', position: { x: -31 + index * 3, y: -88 } }],
    ground_items: [], execution_eligible: true,
  }))
  const samples = Array.from({ length: 12 }, (_, index) => ({ position: { x: -21.5 + index, y: -90.5 }, direction: 0, unknown: false,
    terrain_tiles: [{ name: 'water', position: { x: -21 + index, y: -91 } }], entities: [{ name: 'small-electric-pole', position: { x: -21.5 + index, y: -92.5 } }] }))
  const evaluated = { left_top: { x: -48, y: -112 }, right_bottom: { x: 0, y: -64 } }
  return {
    obstructions: { source: 'native_placement_checks', observed_tick: TICK, ...SURFACE, scope: 'sampled_footprints', examined_count: 40, rejected_count: 32, truncated: true, samples },
    candidates, ok: true, entity_name: 'steam-engine', legal_candidate_count: 8, returned_candidate_count: 8,
    anchor: { unit_number: 21, name: 'boiler' },
    map_context: {
      source: 'npc_map_knowledge', observed_tick: TICK, revision: REVISION, ...SURFACE, candidate_authority: 'currently_visible_chunks_only',
      visible_window: { surface_index: 1, chunk: { x: -1, y: -3 }, chunk_radius: 2 }, explored_chunks: 61, evaluated_area: evaluated,
      evaluated_area_coverage: { chunks: 4, visible: 4, fogged: 0, unknown: 0 },
      crop: nativeCrop({ center: { x: -1, y: -3 }, radius: 2 }),
    },
    search_completeness: { complete: true, evaluated_positions: 40 },
  }
}

class MapGame extends FakeFactorio {
  constructor() {
    super({ inventory: { 'steam-engine': 1, 'iron-plate': 2 } })
    this.status.surface_index = 1; this.status.force_index = 1
    this.reads = []
  }
  async command(text) {
    if (text.includes('"autorio_map","crop"')) { this.reads.push(text); return JSON.stringify({ ok: true, code: 'ok', crop: nativeCrop() }) }
    if (text.includes('"get_placement_candidates"')) { this.reads.push(text); return JSON.stringify(nativeCandidates()) }
    return super.command(text)
  }
}

const STEP = 'Place the held steam engine next to the boiler'
const cp = inventoryCheckpoint('pipe', 1)
const draft = () => planReply({ plan: [STEP], currentStep: 0, operations: [], checkpoint: cp, stepCompletions: [{ kind: 'deterministic', checkpoint: cp }],
  goal: { scope: 'finite', summary: 'Place the steam engine and have one pipe', doneWhen: cp.requirements } })
const reads = () => ({ tool_calls: [
  { id: 'map-candidates', type: 'function', function: { name: 'getPlacementCandidates', arguments: JSON.stringify({ entity_name: 'steam-engine', anchor: { unit_number: 21 }, limit: 8 }) } },
  { id: 'map-crop', type: 'function', function: { name: 'getMapContext', arguments: JSON.stringify({ radius: 3 }) } },
] })
const craft = () => planReply({ plan: [STEP], currentStep: 0, operations: [{ name: 'craft_item', args: { item_name: 'pipe', count: 1 } }], checkpoint: cp })

// The runtime's own Session on the cli-proxy profile, recording each provider call's pre-serialization messages and
// context so the same assembled request can be sent through every other provider serializer.
function harness() {
  const game = new MapGame()
  const model = new ScriptedModel()
  const calls = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna', AI_API_METHOD: 'cli-proxy' })
  bridge.provider = (config, messages, context) => {
    const call = { config, messages: structuredClone(messages), context: { ...context } }
    calls.push(call)
    return providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
      call.wire = JSON.parse(options.body)
      const reply = await model.provide(call.wire.messages, context)
      return new Response(JSON.stringify({ choices: [{ finish_reason: reply.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...reply } }], usage: { prompt_tokens: 2000, completion_tokens: 120 } }), { status: 200 })
    } })
  }
  const world = recoveryWorld({ game, model, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context),
    decisionScript: (_state, questions) => ({ overrides: Object.fromEntries(Object.keys(questions).filter(key => key.startsWith('need_')).map(key => [key, { noul: 0.9 }])) }) })
  return { game, model, world, calls, ...recoverySession(world) }
}

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(block => block?.text ?? '').join('') : ''
const toolResult = (messages, id) => {
  const rows = messages.filter(row => row.role === 'tool' && row.tool_call_id === id)
  assert.equal(rows.length, 1, `exactly one tool result for ${id}`)
  return JSON.parse(textOf(rows[0].content))
}

// What the model must be able to read from the request: the crop and its correlation keys, with nothing dropped.
function assertMapContext(messages) {
  const crop = toolResult(messages, 'map-crop').crop
  assert.deepEqual(crop, nativeCrop(), 'getMapContext reaches the request unchanged')
  const candidates = toolResult(messages, 'map-candidates')
  const context = candidates.map_context
  assert.deepEqual(context, nativeCandidates().map_context, 'candidate map_context (with its crop) reaches the request unchanged')
  for (const record of [crop, context, context.crop]) {
    assert.equal(record.surface_index, 1); assert.equal(record.surface_name, 'nauvis')
    assert.equal(record.observed_tick, TICK); assert.equal(record.revision, REVISION)
  }
  assert.equal(context.candidate_authority, 'currently_visible_chunks_only', 'the hard constraint stays with the candidates')
  for (const record of [crop, context.crop]) {
    assert.ok(record.origin.chunk && record.origin.tile, 'origin is present')
    assert.equal(record.rows.length, record.radius_chunks * 2 + 1)
    assert.equal(record.counts.visible + record.counts.fogged + record.counts.unknown, record.counts.total)
    assert.ok(Number.isSafeInteger(record.explored_record.outside_crop), 'what the crop omits is counted')
  }
  assert.equal(candidates.candidates.length, 8, 'the candidates themselves are not displaced by the map context')
  const keys = Object.keys(candidates)
  assert.ok(keys.indexOf('map_context') < keys.indexOf('candidates'), 'map_context leads the candidates')
}

test('getMapContext parses bounded arguments and renders the read-only autorio_map crop call', () => {
  assert.equal(toolCommand('getMapContext', {}), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map","crop",nil)))')
  assert.equal(toolCommand('getMapContext', { radius: 2, position: { x: 10.5, y: -5 } }), '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_map","crop",2,10.5,-5)))')
  for (const args of [{ radius: 0 }, { radius: 5 }, { radius: 2.5 }, { position: { x: 1 } }, { position: { x: 1, y: 2, z: 3 } }, { center: { x: 0, y: 0 } }]) {
    assert.throws(() => toolCommand('getMapContext', args), `${JSON.stringify(args)} is refused`)
  }
})

const PROFILES = [
  ['generic', { base: 'https://provider.example/v1', key: 'fixture-only', model: 'gpt-5.6', profile: 'generic' }],
  ['deepseek', { base: 'https://api.deepseek.com/v1', key: 'fixture-only', model: 'deepseek-chat', profile: 'deepseek' }],
  ['openai-reasoning', { base: 'https://provider.example/v1', key: 'fixture-only', model: 'gpt-5.6', profile: 'openai-reasoning' }],
  ['openrouter-anthropic', { base: 'https://openrouter.ai/api/v1', key: 'fixture-only', model: 'anthropic/claude-opus-4.5', profile: 'openrouter' }],
  ['openrouter-deepseek', { base: 'https://openrouter.ai/api/v1', key: 'fixture-only', model: 'deepseek/deepseek-chat-v3.1', profile: 'openrouter' }],
  ['local', { base: 'http://host.docker.internal:1234/v1', key: 'fixture-only', model: 'qwen3-coder-30b-a3b-instruct', profile: 'local' }],
  ['cli-proxy', { base: 'https://proxy.example.test/v1', key: 'fixture-only', model: 'gpt-6-luna', profile: 'cli-proxy' }],
]

test('the runtime assembles candidate and map crop context into the executor request, and every provider serializer keeps it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = harness()
  ctx.model.push('planner', 'plan', () => draft())
    .push('executor', 'reads candidates and the map crop', () => reads())
    .push('executor', 'reads the map context from the request', messages => { assertMapContext(messages); return craft() })
  ctx.session.queuePlayerRequest('TTLouis', 'Use the held steam engine')
  await settle(ctx.session)
  assert.deepEqual(ctx.model.violations, []); assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.equal(ctx.game.reads.filter(text => text.includes('"autorio_map","crop"')).length, 1, 'one model-requested crop read; no hidden refresh')
  assert.equal(ctx.game.reads.filter(text => text.includes('"get_placement_candidates"')).length, 1)

  const assembled = ctx.calls.find(call => call.messages.some(row => row.role === 'tool' && row.tool_call_id === 'map-crop'))
  assert.ok(assembled, 'the runtime sent the tool results to the provider')
  assert.equal(assembled.context.role, 'executor')
  assertMapContext(assembled.messages)
  assertMapContext(assembled.wire.messages)
  assert.ok(assembled.wire.tools.some(tool => tool.function.name === 'getMapContext'), 'the executor is offered the read tool')
  const planner = ctx.calls.find(call => call.context.role === 'planner')
  assert.ok(planner.wire.tools.some(tool => tool.function.name === 'getMapContext'), 'the planner is offered the read tool')

  const wire = {}
  for (const [name, config] of PROFILES) {
    let body
    await providerRequest(config, structuredClone(assembled.messages), { ...assembled.context, promptTraceFile: null, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }), { status: 200 })
    } })
    assert.ok(body, `${name} sent a request`)
    assertMapContext(body.messages)
    wire[name] = [textOf(body.messages.find(row => row.tool_call_id === 'map-crop').content), textOf(body.messages.find(row => row.tool_call_id === 'map-candidates').content)]
    assert.ok(wire[name][1].length <= 12000, `${name}: the candidate result stays within the tool-output bound`)
  }
  for (const [name] of PROFILES) assert.deepEqual(wire[name], wire['cli-proxy'], `${name} carries the same map context text`)
  const anthropic = (await (async () => {
    let body
    await providerRequest(PROFILES[3][1], structuredClone(assembled.messages), { ...assembled.context, promptTraceFile: null, fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body)
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }), { status: 200 })
    } })
    return body
  })())
  assert.ok(anthropic.messages.some(row => Array.isArray(row.content)), 'the anthropic family really uses content blocks, so the text join above was exercised')
  assert.equal(ctx.game.mutations.length, 1, 'only the scripted craft mutates')
})
