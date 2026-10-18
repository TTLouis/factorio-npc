#!/usr/bin/env node
// Run W regression: real Session and role resolution, native observations,
// candidate admission, pipe routing and sustained generation under real load.
// The declared pre-objective layout reproduces W's shoreline obstruction;
// every gameplay mutation after setup is an admitted scripted model action.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest } from '../pterodactyl/runtime-v8/provider.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

let fetchCalls = 0
globalThis.fetch = async () => { fetchCalls++; throw new Error('inference forbidden in fresh-topology native fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const seen = {}; const identities = {}; const placements = {}
let connection, ctx, setup
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["fresh-topology"].find_entities_filtered{name="character"}[1]; assert(a); ${body}`))
const snapshot = () => lua(`local o=remote.call("autorio_operations","status"); local entities={};
  for _,e in pairs(a.surface.find_entities_filtered{force=a.force,name={"offshore-pump","boiler","pipe","steam-engine","small-electric-pole","inserter"}}) do
    local d={name=e.name,unit_number=e.unit_number,position=e.position,direction=e.direction,energy=e.energy,fluid_targets={}};
    for i=1,#e.fluidbox do for _,c in pairs(e.fluidbox.get_pipe_connections(i)) do local t=c.target and c.target.owner; if t and t.valid then d.fluid_targets[#d.fluid_targets+1]=t.unit_number end end end;
    if e.name=="steam-engine" then d.generating=e.energy_generated_last_tick; d.network=e.electric_network_id or 0; local f=e.fluidbox[1]; d.steam=f and f.amount or 0 end;
    if e.name=="inserter" then d.network=e.electric_network_id or 0 end;
    if e.name=="boiler" then local f=e.fluidbox[1]; d.water=f and f.amount or 0 end; entities[#entities+1]=d
  end;
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,position=a.position,entities=entities,tick=game.tick,humans=#game.connected_players,speed=game.speed,inventory=a.get_main_inventory().get_contents(),
    queue_length=o.queue_length,task_state=o.task_state,artificial=a.surface.count_entities_filtered{type={"electric-energy-interface","solar-panel","accumulator"}},journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 90000) {
  const deadline = Date.now() + timeout
  for (;;) { healthy(); const value = await predicate(); if (value) return value
    assert.ok(Date.now() < deadline, `timeout ${label}; labels=${JSON.stringify(model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('settled native admission', async () => {
    const s = await snapshot(); assert.equal(s.humans, 0); assert.equal(s.speed, 1); assert.equal(s.artificial, 0)
    const records = Array.isArray(s.journal.records) ? s.journal.records : []
    return s.queue_length === 0 && s.task_state === 'idle' && !records.some(row => row.state === 'admitted') ? s : false
  })
}
async function completion() {
  await idle(); ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session); healthy()
}
const checkpoint = { mode: 'all', requirements: [{ id: 'powered_load', kind: 'entity_count', prototype: 'inserter', minimum: 1, state: 'powered' }] }
const goal = { scope: 'finite', summary: 'Use the held steam engine to power one inserter through the existing boiler', doneWhen: [{ kind: 'electric_network_satisfied', entity_name: 'inserter', minimum: 1 }] }
const STEP = 'Route steam inland around the shoreline obstruction and power an inserter using the held steam engine'
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint, stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
let call = 0
const reads = tools => ({ content: null, tool_calls: tools.map(([name, args]) => ({ id: `topology-${++call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
const lastTool = messages => JSON.parse(messages.findLast(row => row.role === 'tool').content)
function place(messages, name, choose = rows => rows[0]) {
  const set = lastTool(messages); assert.ok(set.ok !== false && set.candidate_set_id && set.candidates?.length, `${name}: ${JSON.stringify(set)}`)
  const candidate = choose(set.candidates); assert.ok(candidate, `no ${name} candidate`); placements[name] = candidate
  return reply([{ name: 'place_candidate', args: { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id } }])
}
function entity(messages, name) {
  const status = lastTool(messages); assert.ok(status.entity?.unit_number > 0, JSON.stringify(status))
  identities[name] = status.entity.unit_number; return status.entity
}
function contextFacts(messages, role) {
  const text = messages.map(row => String(row.content)).join('\n')
  const line = text.split('\n').findLast(row => row.startsWith('fresh_topology: '))
  assert.ok(line, `${role} must receive the fresh bounded topology context`)
  assert.ok(line.length <= 1950, `${role} topology must stay lean`)
  const facts = JSON.parse(line.slice('fresh_topology: '.length))
  assert.equal(facts.state, 'fresh'); assert.equal(facts.source, 'native_bounded_reads')
  assert.equal(facts.actor_id, setup.actor_id); assert.equal(facts.surface_index, setup.surface_index)
  assert.equal(facts.held['steam-engine'], 1, 'a held engine cannot become a missing-item blocker')
  const boiler = facts.entities.find(e => e.name === 'boiler')
  assert.ok(boiler)
  assert.ok(boiler.fluid.some(storage => storage.ports.some(port => port.target?.name === 'offshore-pump' && port.reciprocal === true)), `${role} must distinguish actual reciprocal water connection from neighboring geometry`)
  const capacity = facts.capacity.find(row => row.producer === 'boiler' && row.consumer === 'steam-engine')
  assert.ok(capacity, `${role} requires compatible native capacity facts`)
  assert.equal(capacity.consumers_per_producer, capacity.producer_units_per_second / capacity.consumer_units_per_second)
  assert.equal(capacity.consumers_per_producer, 2)
  assert.equal(capacity.state, 'conditional_prototype_capacity')
  assert.match(facts.expansion, /Reserve room/)
  seen[`${role}Context`] = facts
}
const model = new ScriptedModel()
  .push('planner', 'sol:fresh-lean-world-context', messages => { contextFacts(messages, 'planner'); return reply([], { goal }) })
  .push('executor', 'luna:fresh-held-engine-and-topology', messages => {
    contextFacts(messages, 'executor')
    return reads([['getEntityStatus', { unit_number: setup.boiler }], ['getPlacementCandidates', { entity_name: 'steam-engine', connects_to: { unit_number: setup.boiler, storage_index: 2 }, limit: 8 }]])
  })
  .push('executor', 'luna:water-and-pole-obstructions-not-missing-engine', messages => {
    const tools = messages.filter(row => row.role === 'tool').slice(-2).map(row => JSON.parse(row.content))
    seen.boiler = tools[0]; seen.directEngine = tools[1]
    assert.equal(seen.boiler.entity.unit_number, setup.boiler)
    assert.equal(seen.directEngine.legal_candidate_count, 0)
    assert.equal(seen.directEngine.obstructions.source, 'native_placement_checks')
    assert.ok(seen.directEngine.obstructions.samples.some(row => row.terrain_tiles?.some(tile => tile.name === 'water')))
    assert.ok(seen.directEngine.obstructions.samples.some(row => row.entities?.some(e => e.name === 'small-electric-pole')))
    const summaryLine = messages.flatMap(row => String(row.content).split('\n')).findLast(row => row.startsWith('fresh_topology: '))
    assert.ok(summaryLine)
    const summary = JSON.parse(summaryLine.slice('fresh_topology: '.length))
    assert.equal(summary.held['steam-engine'], 1)
    assert.ok(summary.obstructions?.some(row => row.samples.some(sample => sample.terrain.some(tile => tile.name === 'water'))), 'admitted sampled obstruction must survive the provider context boundary')
    seen.obstructionContext = summary
    const thermal = seen.boiler.entity.spatial.power.prototype.thermal
    const output = thermal.fluid_output_per_second_at_target
    assert.equal(thermal.source, 'running_prototype'); assert.ok(output > 0)
    seen.nativeBoilerOutputPerSecond = output
    return reply([{ name: 'craft_item', args: { item_name: 'pipe', count: 2 } }])
  })
  .push('executor', 'luna:fresh-boiler-outlet-pipe', () => reads([['getPlacementCandidates', { entity_name: 'pipe', connects_to: { unit_number: setup.boiler, storage_index: 2 }, limit: 8 }]]))
  .push('executor', 'luna:place-steam-outlet', messages => place(messages, 'pipe1'))
  .push('executor', 'luna:identify-first-pipe', reads([['getEntityStatus', { name: 'pipe', radius: 32 }]]))
  .push('executor', 'luna:turn-inland-from-observed-port', async messages => {
    const e = entity(messages, 'pipe1'); seen.firstPipe = e
    // Project an actual native four-port pipe through the production helper.
    // This component assertion covers nested omission even when the full-loop
    // lean packet above drops the pipe to retain the boiler and capacity.
    // Delayed import preserves the original-image missing-context control.
    const { topologyEntities, topologyText } = await import('../pterodactyl/runtime-v8/topology-context.mjs')
    // The model observation normalizer deliberately omits native envelope
    // metadata. Reuse the already captured raw native answer, never synthesize
    // its scope from the fixture or re-read the world for this projection.
    const native = transcript.filter(row => row.command.includes('"get_entity_status"'))
      .map(row => JSON.parse(row.answer)).findLast(status => status.entity?.unit_number === e.unit_number)
    assert.ok(native)
    assert.equal(native.actor_id, setup.actor_id)
    assert.equal(native.surface_index, setup.surface_index)
    assert.ok(Number.isSafeInteger(native.observed_tick))
    const actual = topologyEntities({ ...native, entities: [native.entity] })
    assert.ok(actual, 'actual native pipe envelope must supply valid observation provenance')
    assert.ok(native.entity.spatial.fluid.storages.some(storage => storage.connections.length === 4))
    const compact = JSON.parse(topologyText({ state: 'fresh', ...actual }).slice('fresh_topology: '.length))
    assert.equal(compact.truncated, true)
    assert.ok(compact.entities[0].fluid.some(storage => storage.truncated === true && storage.ports.length === 3))
    seen.nativePipeProjection = compact
    seen.nativePipeStatus = native
    return reads([['getPlacementCandidates', { entity_name: 'pipe', connects_to: { unit_number: e.unit_number, storage_index: 1, connection_index: 4 }, limit: 8 }]])
  })
  .push('executor', 'luna:place-inland-pipe', messages => place(messages, 'pipe2'))
  .push('executor', 'luna:identify-inland-pipe', () => reads([['getNearbyEntities', { name: 'pipe', radius: 32, limit: 8 }]]))
  .push('executor', 'luna:fresh-connected-engine-after-routing', messages => {
    // Exact position selection remains native; never infer an entity ID from order.
    const status = lastTool(messages)
    const rows = status.entities ?? status
    const e = rows.find(row => Math.abs(row.position.x - placements.pipe2.position.x) < 0.1 && Math.abs(row.position.y - placements.pipe2.position.y) < 0.1)
    assert.ok(e?.unit_number); identities.pipe2 = e.unit_number; assert.notEqual(e.unit_number, identities.pipe1)
    return reads([['getPlacementCandidates', { entity_name: 'steam-engine', connects_to: { unit_number: e.unit_number }, limit: 8 }]])
  })
  .push('executor', 'luna:place-held-engine-on-legal-inland-footprint', messages => place(messages, 'steam-engine'))
  .push('executor', 'luna:fresh-engine-capacity-and-connectivity', reads([['getEntityStatus', { name: 'steam-engine', radius: 32 }]]))
  .push('executor', 'luna:derive-future-expansion-from-native-capacity', messages => {
    const e = entity(messages, 'steam-engine'); seen.engine = e
    const usage = e.spatial.power.prototype.power.fluid_usage_per_second
    assert.ok(usage > 0); seen.capacityRatio = seen.nativeBoilerOutputPerSecond / usage
    assert.equal(seen.capacityRatio, 2, 'running vanilla prototypes support two full-load engines per fully supplied boiler')
    return reads([['getPlacementCandidates', { entity_name: 'steam-engine', connects_to: { unit_number: e.unit_number }, limit: 8 }]])
  })
  .push('executor', 'luna:keep-a-legal-second-engine-footprint-without-expanding-the-goal', async messages => {
    const future = lastTool(messages)
    assert.ok(future.ok === true && future.candidates?.length > 0, 'the observed first-engine route must leave a native-feasible connected second-engine footprint')
    seen.futureEngineCandidates = future
    const line = messages.flatMap(row => String(row.content).split('\n')).findLast(row => row.startsWith('fresh_topology: '))
    assert.ok(line)
    seen.futureEngineContext = JSON.parse(line.slice('fresh_topology: '.length))
    if (Object.hasOwn(seen.futureEngineContext.held, 'steam-engine')) assert.equal(seen.futureEngineContext.held['steam-engine'], 0)
    else assert.match(seen.futureEngineContext.held_scope, /omitted_counts_unknown/, 'an omitted lean inventory item is not an authoritative zero')
    const native = await snapshot()
    assert.equal(native.inventory.filter(item => item.name === 'steam-engine').reduce((count, item) => count + item.count, 0), 0)
    seen.futureEngineNativeInventory = native.inventory
    assert.equal(ctx.world.memory.planningState(KEY).plans.at(-1).steps[0].description, STEP, 'expansion observation must preserve the committed current step')
    const first = placements['steam-engine'].footprint.world_box
    assert.ok(future.candidates.some(candidate => {
      const second = candidate.footprint.world_box
      return second.right_bottom.x <= first.left_top.x || second.left_top.x >= first.right_bottom.x
        || second.right_bottom.y <= first.left_top.y || second.left_top.y >= first.right_bottom.y
    }), 'future engine footprint must not overlap the placed engine')
    return reply([{ name: 'craft_item', args: { item_name: 'inserter', count: 1 } }, { name: 'supply_entity', args: { unit_number: setup.boiler, items: [{ item_name: 'coal', count: 5 }] } }])
  })
  .push('executor', 'luna:legal-load-within-retained-pole-coverage', () => reads([['getPlacementCandidates', { entity_name: 'inserter', center: { x: -21.5, y: -92.5 }, radius: 3, limit: 8 }]]))
  .push('executor', 'luna:place-real-inserter-load', messages => place(messages, 'inserter', rows => rows.find(row => Math.abs(row.position.x + 21.5) <= 2 && Math.abs(row.position.y + 92.5) <= 2)))

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => { connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); try { await connection.connect(); return true } catch { return false } }, 20000)
  await configureNpcSession(rcon, 'fresh-topology-delegation-session')
  setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); '
    + 'local s=game.create_surface("fresh-topology",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); s.request_to_generate_chunks({-24,-94},2); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; '
    + 'local tiles={}; for x=-64,31 do for y=-128,-33 do tiles[#tiles+1]={name=((x>=-20) or (x==-21 and y>=-91)) and "water" or "landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); assert(a.teleport({-26,-97},s)); s.always_day=true; '
    + 'local pump=s.create_entity{name="offshore-pump",position={-19.5,-95.5},direction=4,force=a.force}; local boiler=s.create_entity{name="boiler",position={-21.5,-95},direction=8,force=a.force}; assert(pump and boiler); '
    + 'local p1=s.create_entity{name="small-electric-pole",position={-21.5,-92.5},force=a.force}; local p2=s.create_entity{name="small-electric-pole",position={-19.5,-94.5},force=a.force}; assert(p1 and p2); '
    + 'a.get_main_inventory().clear(); for _,v in pairs({{"steam-engine",1},{"iron-plate",8},{"copper-plate",9},{"coal",5}}) do assert(a.insert{name=v[1],count=v[2]}==v[2]) end; for _,n in pairs({"steam-power","electronics"}) do a.force.technologies[n].researched=true end; '
    + 'rcon.print(helpers.table_to_json({actor_id=a.unit_number,boiler=boiler.unit_number,pump=pump.unit_number,poles={p1.unit_number,p2.unit_number},surface_index=s.index}))'))
  // Setup boundary. No terrain, stock, teleport, fuel insertion or arbitrary
  // world write occurs below: only production Session-authorized operations.
  const before = await idle()
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'nearby_world', 'placement_candidates', 'entity_status']) if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const wires = []
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key',
    OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}`, AI_API_METHOD: 'cli-proxy' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    wires.push({ model: body.model, role: context.role, tool_choice: body.tool_choice, tools: body.tools?.length ?? 0 })
    assert.equal(body.tools.length, 41); assert.ok(body.tools.some(tool => tool.function?.name === 'getPumpSitePreparation'))
    assert.equal(body.tool_choice, context.allowTools === false ? 'none' : 'auto')
    const response = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ choices: [{ finish_reason: response.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...response } }],
      usage: { prompt_tokens: 2000, completion_tokens: 120 } }), { status: 200 })
  } })
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  world.modelRequests = wires
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', goal.summary)
  await settle(ctx.session); healthy()
  const goalId = world.memory.planningState(KEY).goal.goal_id
  const canonicalSteps = structuredClone(world.memory.planningState(KEY).plans.at(-1).steps)
  for (let i = 0; i < 6; i++) {
    await completion()
    if (world.memory.planningState(KEY)?.plans?.length) assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonicalSteps)
  }
  seen.steadySamples = []
  await until('native generation powering real inserter drain', async () => {
    const s = await snapshot(); const e = s.entities.find(row => row.name === 'steam-engine'); const load = s.entities.find(row => row.name === 'inserter')
    return e?.generating > 0 && e.steam > 0 && load?.energy > 0 && e.network > 0 && e.network === load.network ? s : false
  })
  for (let i = 0; i < 3; i++) { await delay(1000); const s = await snapshot(); const e = s.entities.find(row => row.name === 'steam-engine'); const load = s.entities.find(row => row.name === 'inserter')
    assert.ok(e.generating > 0 && e.steam > 0 && load.energy > 0 && e.network > 0 && e.network === load.network); seen.steadySamples.push(s)
  }
  await completion()
  const after = await idle()
  assert.equal(after.actor_id, before.actor_id); assert.equal(after.artificial, 0)
  assert.equal(after.entities.filter(e => e.name === 'pipe').length, 2)
  assert.equal(after.entities.filter(e => e.name === 'steam-engine').length, 1, 'capacity guidance cannot silently enlarge the committed one-engine goal')
  assert.deepEqual(after.entities.filter(e => e.name === 'small-electric-pole').map(e => e.unit_number).sort((a,b) => a-b), [...setup.poles].sort((a,b) => a-b))
  assert.ok(after.entities.find(e => e.unit_number === identities.pipe1).fluid_targets.includes(setup.boiler))
  assert.ok(after.entities.find(e => e.unit_number === identities.pipe2).fluid_targets.includes(identities['steam-engine']))
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  assert.ok(world.named('step.candidate_placement_receipt_checked').length >= 4)
  assert.deepEqual(model.remaining, []); assert.deepEqual(jevContractLog.filter(row => !row.ok), []); assert.equal(fetchCalls, 0)
  assert.equal(world.modelRequests[0].model, PLANNER_MODEL); assert.ok(world.modelRequests.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assert.deepEqual(world.named('recovery.auto_resume_started'), [], 'fresh native facts do not buy extra resumes')
  await fsp.writeFile(path.join(results, 'fresh-topology-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, goalId, setup, before, seen, after, identities, placements, models: world.modelRequests, trace: world.trace, fetchCalls }, null, 2))
  process.stdout.write('fresh-topology native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'fresh-topology-error.txt'), `${error.stack}\n${JSON.stringify({ labels: model.labels, logs: ctx?.logs, sentCount: sent.length, seen, trace: ctx?.world.trace, transcript }, null, 2)}`)
  throw error
} finally { if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume() }; connection?.close() }
