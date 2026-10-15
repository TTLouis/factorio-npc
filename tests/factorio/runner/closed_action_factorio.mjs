#!/usr/bin/env node
// Run Q: closed observation tools retain the validated assistant-JSON action channel.
// Real Session, role routing, provider serializer and native physics; injected
// scripted inference only. No gameplay correction after the setup boundary.
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

globalThis.fetch = async () => { throw new Error('uninjected inference forbidden in closed-action fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = [], sent = [], wire = [], wireFaults = []
let connection, ctx, furnaceUnit
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); ' + body))
const snapshot = () => lua(`local o=remote.call("autorio_operations","status"); local s=a.surface;
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local machines={}; for _,e in pairs(s.find_entities_filtered{force=a.force,type={"furnace","mining-drill"}}) do machines[#machines+1]={name=e.name,unit_number=e.unit_number,position=e.position} end;
  local f=s.find_entities_filtered{force=a.force,type="furnace"}[1];
  rcon.print(helpers.table_to_json({held=counts(a.get_main_inventory()),machines=machines,
    output=f and counts(f.get_output_inventory()) or {},source=f and counts(f.get_inventory(defines.inventory.crafter_input)) or {},fuel=f and counts(f.get_fuel_inventory()) or {},
    actor_id=a.unit_number,tick=game.tick,humans=#game.connected_players,speed=game.speed,
    electronics=a.force.technologies.electronics.researched,copper_produced=a.force.get_item_production_statistics(s).get_input_count("copper-plate"),
    queue_length=o.queue_length,task_state=o.task_state,last_completed=o.last_completed_batch,
    journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(wireFaults, [], 'closed wire must advertise the validated JSON operation proposal channel')
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 90000) {
  const end = Date.now() + timeout
  for (;;) {
    healthy()
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < end, `timeout ${label}; labels=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('native idle and settled admission', async () => {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    const records = Array.isArray(s.journal.records) ? s.journal.records : []
    return s.queue_length === 0 && s.task_state === 'idle' && !records.some(row => row.state === 'admitted') ? s : false
  })
}
async function completion() {
  const s = await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  healthy()
  return s
}
const checkpoint = { mode: 'all', requirements: [{ id: 'electronics', kind: 'research_completed', technology: 'electronics' }] }
const STEP = 'Place the held furnace and smelt ten copper plates to unlock electronics'
const goal = { scope: 'finite', summary: 'Unlock electronics by producing ten copper plates in a native furnace', doneWhen: [
  { kind: 'research_completed', technology: 'electronics' }, { kind: 'items_produced', item_name: 'copper-plate', minimum: 10 },
] }
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint,
  ...(ctx?.world.memory.currentPlan(KEY)?.task_board.active_step_id ? { stepId: ctx.world.memory.currentPlan(KEY).task_board.active_step_id } : {}),
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
function control(messages) {
  const message = [...messages].reverse().find(row => String(row.content).startsWith('[CONTROL_DECISION_STATE]'))
  assert.ok(message, 'production provider request includes current control decision state')
  return JSON.parse(message.content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
}
const descriptor = { channel: 'assistant_json', validation: 'required', grantsAuthority: false }
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-electronics-checkpoint', reply([], { goal }))
  .push('planner', 'sol:confirm-live-trigger-requirements', messages => {
    assert.match(messages.findLast(row => String(row.content).startsWith('[HARNESS]')).content, /requirements_grounding/)
    return reply([], { goal })
  })
  .push('executor', 'luna:one-targeted-inventory-request', messages => {
    const state = control(messages)
    assert.equal(state.phase, 'committed'); assert.equal(state.targetedReadEligible, true)
    return { content: JSON.stringify({ plan: [STEP], currentStep: 0, stepId: state.stepId, operations: [],
      observationRequest: { stepId: state.stepId, tool: 'getInventoryItems', args: {},
        rationale: 'Confirm the held furnace and copper ore before choosing a native placement action.' } }) }
  })
  .push('executor', 'luna:closed-json-held-furnace-placement', async (messages, context) => {
    assert.equal(context.allowTools, false)
    const state = control(messages)
    const prompt = messages.map(row => String(row.content)).join('\n')
    if (JSON.stringify(state.operationSubmission) !== JSON.stringify(descriptor)
      || !prompt.includes('Tool closure does not disable gameplay-operation proposals')
      || !/place_entity \{entity_name\} needs neither coordinates nor an existing unit_number/.test(prompt)) {
      wireFaults.push({ reason: 'closed_round_action_channel_missing_or_ambiguous', operationSubmission: state.operationSubmission,
        closureGuidance: prompt.includes('Tool closure does not disable gameplay-operation proposals') })
      throw new Error('serialized closed round omits the validated assistant-JSON action channel or held-placement guidance')
    }
    assert.equal(state.toolsEnabled, false)
    assert.equal(state.targetedAllowanceUsed, true); assert.equal(state.targetedReadEligible, false)
    assert.equal(sent.length, 0, 'targeted read carries no gameplay authority')
    const s = await snapshot()
    assert.equal(s.machines.length ?? Object.keys(s.machines).length, 0)
    assert.equal(s.held['stone-furnace'], 1); assert.equal(s.held['copper-ore'], 10)
    assert.equal(s.electronics, false)
    const tool = [...messages].reverse().find(row => row.role === 'tool')
    assert.ok(tool); assert.match(tool.content, /stone-furnace/); assert.match(tool.content, /copper-ore/)
    // No position or nonexistent unit id is invented for unconstrained held placement.
    return reply([{ name: 'place_entity', args: { entity_name: 'stone-furnace' } }])
  })
  .push('executor', 'luna:fresh-furnace-identity-after-receipt', { content: null, tool_calls: [{ id: 'fresh-native-furnace', type: 'function',
    function: { name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', radius: 32 }) } }] })
  .push('executor', 'luna:supply-fresh-native-target', messages => {
    const status = JSON.parse([...messages].reverse().find(row => row.role === 'tool').content)
    assert.equal(status.observation_mode, 'full'); assert.equal(status.entity.name, 'stone-furnace')
    assert.ok(status.entity.unit_number > 0)
    furnaceUnit = status.entity.unit_number
    return reply([{ name: 'supply_entity', args: { unit_number: furnaceUnit,
      items: [{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 10 }] } }])
  })

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, 'closed-action-native-session')
  const setup = await lua(`game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=a.surface; local inv=a.get_main_inventory(); inv.clear();
    for _,e in pairs(s.find_entities_filtered{position=a.position,radius=20}) do if e~=a then e.destroy() end end;
    for _,e in pairs(s.find_entities_filtered{force=a.force,type={"furnace","mining-drill"}}) do e.destroy() end;
    local tiles={} for dx=-20,20 do for dy=-20,20 do tiles[#tiles+1]={name="landfill",position={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy}} end end; s.set_tiles(tiles,true,false,true);
    for _,v in pairs({{"burner-mining-drill",1},{"stone-furnace",1},{"iron-plate",8},{"coal",10},{"copper-ore",10}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end;
    assert(not a.force.technologies.electronics.researched);
    local prereqs={} for _,t in pairs(a.force.technologies.electronics.prerequisites) do prereqs[#prereqs+1]=t.name end;
    rcon.print(helpers.table_to_json({actor_id=a.unit_number,electronics_prerequisites=prereqs}))`)
  // SETUP ENDS HERE. No subsequent stock insertion, teleport, technology edit,
  // terrain repair, direct placement, or manually forced completion occurs.
  assert.equal(setup.electronics_prerequisites.length ?? Object.keys(setup.electronics_prerequisites).length, 0,
    'electronics has no prerequisites; the fixture does not seed steam-power research')
  const before = await idle()
  assert.deepEqual(before.held, { 'burner-mining-drill': 1, 'stone-furnace': 1, 'iron-plate': 8, coal: 10, 'copper-ore': 10 })
  assert.equal(before.machines.length ?? Object.keys(before.machines).length, 0)
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key', OPENAI_API_BASEURL: 'https://provider.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: path.join(results, 'closed-action-provider.jsonl'),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      wire.push({ body, role: context.role, allowTools: context.allowTools, actor_id: context.actorId, epoch: context.epoch })
      if (context.allowTools === false) assert.equal(body.tool_choice, 'none')
      const message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ id: `closed-script-${wire.length}`, model: body.model,
        choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'nearby_world', 'entity_status']) if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config })
  world.agent.provider = (messages, context) => bridge.roleProvider(messages, context)
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Use the held furnace to smelt ten copper plates and unlock electronics')
  await settle(ctx.session); healthy()
  const canonical = structuredClone(world.memory.planningState(KEY))
  const planId = canonical.plans.at(-1).plan_id
  assert.equal(sent.length, 1)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  const placed = await completion()
  assert.equal(placed.machines.length, 1); assert.equal(placed.machines[0].name, 'stone-furnace')
  assert.equal(placed.machines[0].unit_number, furnaceUnit)
  assert.equal(placed.electronics, false); assert.equal(placed.held['stone-furnace'] ?? 0, 0)
  assert.equal(sent.length, 2)
  const same = world.memory.planningState(KEY)
  assert.equal(same.goal.goal_id, canonical.goal.goal_id)
  assert.equal(same.plans.at(-1).plan_id, planId)
  assert.deepEqual(same.plans.at(-1).steps, canonical.plans.at(-1).steps)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'placement and identity discovery cannot prove electronics')
  const loaded = await idle()
  assert.equal(loaded.held['copper-ore'] ?? 0, 0)
  assert.equal(loaded.held['burner-mining-drill'], 1); assert.equal(loaded.held['iron-plate'], 8)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  const smelted = await until('ten real native copper plates and electronics trigger', async () => {
    const s = await snapshot()
    return s.output['copper-plate'] === 10 && s.electronics ? s : false
  })
  await completion()
  const after = await idle()
  assert.equal(after.output['copper-plate'], 10)
  assert.equal(after.copper_produced - before.copper_produced, 10)
  assert.equal(after.electronics, true)
  assert.equal(after.actor_id, before.actor_id)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  assert.equal(sent.length, 2, 'only held placement and fresh-identity supply; no replay, collection or invented craft')
  const grants = world.named('observation.targeted_granted')
  assert.equal(grants.length, 1); assert.equal(grants[0].tool, 'getInventoryItems')
  assert.ok(grants[0].request_id)
  assert.deepEqual(world.named('observation.targeted_refused'), [])
  assert.ok(world.named('control.decision_state').some(row => row.request_id
    && row.reason === 'guidance_matches_effective_tools_and_canonical_phase'
    && JSON.stringify(row.operation_submission) === JSON.stringify(descriptor)))
  assert.deepEqual(wire.map(row => row.body.model), [PLANNER_MODEL, PLANNER_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL])
  assert.equal(wire[3].allowTools, false)
  assert.ok(wire.every(row => row.actor_id === status.actor_id && row.epoch === status.epoch))
  assert.deepEqual(model.remaining, []); healthy()
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, 'closed-action-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    setup, before, placed, loaded, smelted, after, wire, trace: world.trace }, null, 2))
  process.stdout.write('closed-action native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'closed-action-error.txt'), `${error.stack}\n${JSON.stringify({ wireFaults, wire, labels: model.labels, logs: ctx?.logs, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
