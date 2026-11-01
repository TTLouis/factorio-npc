#!/usr/bin/env node
// Run AD: real provider serializer + Session + native candidates/admission.
// The fixture starts with held machines and a declared natural-resource patch.
// After setup, only admitted scripted executor operations change the world.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest } from '../pterodactyl/runtime-v8/provider.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const transcript = []
const wire = []
const sent = []
const seen = {}
let connection, ctx, setup
let calls = 0
let forbiddenFetch = 0
globalThis.fetch = async () => { forbiddenFetch++; throw new Error('external inference forbidden') }
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["direct-feed-observation"].find_entities_filtered{name="character"}[1]; assert(a); ${body}`))
const snapshot = () => lua('local o=remote.call("autorio_operations","status"); local held={}; for _,i in pairs(a.get_main_inventory().get_contents()) do held[i.name]=(held[i.name] or 0)+i.count end; local machines={}; for _,e in pairs(a.surface.find_entities_filtered{force=a.force,name={"burner-mining-drill","stone-furnace"}}) do machines[#machines+1]={name=e.name,unit_number=e.unit_number,position=e.position,direction=e.direction,status=tostring(e.status)} end; rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,held=held,machines=machines,task_state=o.task_state,queue_length=o.queue_length,produced=a.force.get_item_production_statistics(a.surface).get_input_count("iron-plate")}))')
function healthy() {
  if (!ctx) return
  assert.deepEqual(model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, read, timeout = 90000) {
  const end = Date.now() + timeout
  for (;;) { healthy(); const value = await read(); if (value) return value
    assert.ok(Date.now() < end, `timeout ${label}; labels=${JSON.stringify(model.labels)}`); await delay(100) }
}
async function idle() {
  await delay(250)
  return until('native idle', async () => { const s = await snapshot(); assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    return s.task_state === 'idle' && s.queue_length === 0 ? s : false })
}
async function complete() { await idle(); ctx.session.lastCompletionAt = 0; ctx.session.onGameLine('[AUTORIO] All operations completed'); await settle(ctx.session); healthy() }
function control(messages) {
  const line = messages.findLast(row => String(row.content).startsWith('[CONTROL_DECISION_STATE]'))
  assert.ok(line); return JSON.parse(line.content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
}
const decision = (messages, operations) => planReply({ stepId: control(messages).stepId, operations })
const typed = (messages, context, tool, args, transport = 'submit') => {
  assert.equal(context.allowTools, true)
  const stepId = control(messages).stepId
  const intent = { stepId, operations: [], observationRequest: { stepId, tool, args, rationale: 'Read native resource and direct-feed placement facts for this committed step.' } }
  return transport === 'json' ? planReply(intent) : { content: '', tool_calls: [{ id: `spatial-${++calls}`, type: 'function', function: { name: 'submitPlan', arguments: JSON.stringify(intent) } }] }
}
const fact = messages => JSON.parse(messages.findLast(row => row.role === 'tool').content)
function place(messages, context, key) {
  assert.equal(context.allowTools, false, 'one fresh spatial read spends the unchanged one-read decision budget')
  const set = fact(messages)
  const candidate = set.candidates?.[0]
  assert.ok(set.ok && candidate?.id, JSON.stringify(set)); seen[key] = candidate
  if (key === 'drill') { assert.ok(candidate.resource_coverage.some(row => row.name === 'iron-ore' && row.entities > 0)); assert.ok(candidate.item_output_position) }
  return decision(messages, [{ name: 'place_candidate', args: { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id } }])
}
const objective = 'Produce and collect one new iron plate with the held direct-fed miner and furnace'
const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-plate', minimum: 1 }] }
const model = new ScriptedModel()
  .push('planner', 'sol:direct-feed-brief', () => planReply({ plan: [objective], currentStep: 0, operations: [],
    goal: { scope: 'finite', summary: objective, doneWhen: checkpoint.requirements },
    stepCompletions: [{ kind: 'deterministic', checkpoint }],
    executionGuidance: [{ approach: 'Validate native drill coverage and output, place a receiving furnace, fuel separately and collect a plate.',
      rationale: 'Use the held machines without substituting hand-mined or hand-delivered iron ore.', constraints: [], skillIds: [], materialSupply: { mode: 'direct_feed', resource: 'iron-ore' } }] }))
  .push('executor', 'luna:typed-resource-search', (m, c) => typed(m, c, 'getNearbyEntities', { name: 'iron-ore', radius: 32, limit: 8 }, 'json'))
  .push('executor', 'luna:approach-native-resource', m => { seen.resource = fact(m).entities[0]; assert.equal(seen.resource.name, 'iron-ore'); return decision(m, [{ name: 'walk_to_entity', args: { entity_name: 'iron-ore', search_radius: 32 } }]) })
  .push('executor', 'luna:typed-drill-coverage', (m, c) => typed(m, c, 'getPlacementCandidates', { entity_name: 'burner-mining-drill', center: seen.resource.position, target_resource: 'iron-ore', radius: 5, limit: 2 }))
  .push('executor', 'luna:place-covered-drill', (m, c) => place(m, c, 'drill'))
  .push('executor', 'luna:typed-output-covering-furnace', (m, c) => typed(m, c, 'getPlacementCandidates', { entity_name: 'stone-furnace', center: seen.drill.item_output_position, covers_position: seen.drill.item_output_position, radius: 4, limit: 2 }, 'json'))
  .push('executor', 'luna:place-output-covering-furnace', (m, c) => place(m, c, 'furnace'))
  .push('executor', 'luna:observe-exact-machine-identities', (m, c) => typed(m, c, 'getNearbyEntities', { radius: 32, limit: 40 }))
  .push('executor', 'luna:fuel-machines-separately', m => {
    const entities = fact(m).entities
    const drill = entities.find(e => e.name === 'burner-mining-drill')
    const furnace = entities.find(e => e.name === 'stone-furnace')
    assert.ok(drill?.unit_number && furnace?.unit_number); seen.units = { drill: drill.unit_number, furnace: furnace.unit_number }
    return decision(m, [drill, furnace].map(e => ({ name: 'supply_entity', args: { unit_number: e.unit_number, items: [{ item_name: 'coal', count: 2 }] } })))
  })
  .push('executor', 'luna:wait-for-native-production', m => decision(m, [{ name: 'wait', args: { ticks: 600 } }]))
  .push('executor', 'luna:read-native-output', (m, c) => typed(m, c, 'getEntityStatus', { unit_number: seen.units.furnace }))
  .push('executor', 'luna:collect-produced-plate', m => { const e = fact(m).entity; assert.equal(e.unit_number, seen.units.furnace)
    assert.ok(e.inventories.some(i => Array.isArray(i.items) && i.items.some(item => item.name === 'iron-plate' && item.count >= 1)))
    return decision(m, [{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: e.unit_number, max_count: 1, to_entity: false } }]) })
try {
  await until('RCON ready', async () => { connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); try { await connection.connect(); return true } catch { return false } }, 20000)
  await configureNpcSession(rcon, 'direct-feed-observation-native')
  setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=game.create_surface("direct-feed-observation",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); s.request_to_generate_chunks({0,0},2); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; local tiles={}; for x=-32,63 do for y=-32,63 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); for x=7,12 do for y=7,12 do assert(s.create_entity{name="iron-ore",position={x+0.5,y+0.5},amount=200}) end end; assert(a.teleport({0,0},s)); local inv=a.get_main_inventory(); inv.clear(); for _,v in pairs({{"burner-mining-drill",1},{"stone-furnace",1},{"coal",8}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end; rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index}))'))
  // SETUP ENDS: no later insertion, teleport, mining or fabricated production.
  const before = await snapshot(); assert.equal(before.held['iron-plate'] ?? 0, 0); assert.equal(before.produced, 0)
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://proxy.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna' })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: path.join(results, 'direct-feed-provider.jsonl'), fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); wire.push({ body, role: context.role, allowTools: context.allowTools })
    const message = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200 })
  } })
  const world = recoveryWorld({ game: rcon, model, completionProtocolVersion: 3, agentRoleConfig: bridge.config,
    roleProvider: (messages, context) => bridge.roleProvider(messages, context) })
  // The typed Run AD gate answer: only research is predicted, one fresh read.
  world.agent.routePostStepDecision = async () => ({ route: 'targeted_observation', decision_called: true,
    steering: { observation_budget: 1, observation_relevance: { source: 'typed_relevance', threshold: 0.5, selected_families: ['research_state'], budget: 1 } } })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch, sessionId: status.session }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', objective); await settle(ctx.session); healthy()
  const original = structuredClone(getActivePlan(world.memory.planningState(KEY)))
  assert.equal(sent.length, 1)
  const meaning = step => ({ id: step.step_id, description: step.description, contract: step.completion_contract, guidance: step.execution_guidance })
  seen.committedSteps = []
  for (let i = 0; i < 5; i++) {
    await complete()
    const held = getActivePlan(world.memory.planningState(KEY))
    assert.equal(held.plan_id, original.plan_id)
    assert.deepEqual(held.steps.map(meaning), original.steps.map(meaning))
    seen.committedSteps.push(structuredClone(held))
  }
  await complete()
  const after = await idle()
  assert.equal(after.held['iron-plate'], 1); assert.ok(after.produced >= 1)
  assert.equal(after.actor_id, before.actor_id); assert.equal(after.machines.length, 2)
  assert.equal(world.named('observation.targeted_granted').length, 0)
  assert.equal(world.named('observation.targeted_refused').length, 0)
  assert.equal(world.named('executor.planner_review_requested').length, 0)
  assert.ok(world.named('observation.phase_kept_open').length >= 4)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined, 'the verified completed goal retires its active plan')
  assert.equal(sent.length, 6)
  assert.deepEqual(model.remaining, []); assert.deepEqual(jevContractLog.filter(row => !row.ok), []); assert.equal(forbiddenFetch, 0)
  assert.ok(sent.every(command => !command.includes("'gather_resource'") && !command.includes("'mine_resource_at'")))
  await fs.writeFile(path.join(results, 'direct-feed-observation-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, setup, before, after, seen, sent, wire, trace: world.trace, transcript, forbiddenFetch }, null, 2))
  process.stdout.write('direct-feed-observation native PASS\n')
} catch (error) {
  await fs.writeFile(path.join(results, 'direct-feed-observation-error.txt'), `${error.stack}\n${JSON.stringify({ labels: model.labels, logs: ctx?.logs, seen, wire, transcript }, null, 2)}`); throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
