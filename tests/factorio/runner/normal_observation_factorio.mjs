#!/usr/bin/env node
// Run T: typed read decisions use ordinary tools/budget/cache while tools are open.
// Native output clearing, copper smelting, lab crafting and red-science trigger.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DeploymentError, Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest, verifyCliProxyProviderContracts } from '../pterodactyl/runtime-v8/provider.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('uninjected inference forbidden in normal-observation fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const wire = []; const wireFaults = []; const seen = {}
const preflight = {}
let connection, ctx, unit, initialNativeReads
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["normal-observation"].find_entities_filtered{name="character"}[1]; assert(a); ${  body}`))
const snapshot = () => lua(`local o=remote.call("autorio_operations","status"); local f;
  for _,e in pairs(a.surface.find_entities_filtered{force=a.force,name="stone-furnace"}) do if e.unit_number==${unit} then f=e; break end end; assert(f and f.valid,"declared furnace identity missing");
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,tick=game.tick,
    held=counts(a.get_main_inventory()),source=counts(f.get_inventory(defines.inventory.crafter_input)),output=counts(f.get_output_inventory()),fuel=counts(f.get_fuel_inventory()),
    furnace={unit_number=f.unit_number,position=f.position,recipe=f.get_recipe() and f.get_recipe().name,crafting_progress=f.crafting_progress},red=a.force.technologies["automation-science-pack"].researched,red_recipe=a.force.recipes["automation-science-pack"].enabled,
    lab_recipe=a.force.recipes.lab.enabled,copper_produced=a.force.get_item_production_statistics(a.surface).get_input_count("copper-plate"),
    crafting_queue_length=#(a.crafting_queue or {}),walking=a.walking_state.walking,mining=a.mining_state.mining,
    crafting=remote.call("autorio_crafting","status"),follow=remote.call("autorio_follow","status"),navigation=remote.call("autorio_navigation","status"),
    queue_length=o.queue_length,task_state=o.task_state,last_completed=o.last_completed_batch,journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(wireFaults, [], 'open JSON read must use normal observation handling')
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
  return until('native idle and settled journal', async () => {
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
  await settle(ctx.session); healthy()
  return s
}
const checkpoint = { mode: 'all', requirements: [{ id: 'lab', kind: 'inventory_count', item_name: 'lab', minimum: 1 },
  { id: 'red', kind: 'research_completed', technology: 'automation-science-pack' }] }
const STEP = 'Clear the furnace iron output, collect five newly smelted copper plates, and craft a lab to unlock red science'
const goal = { scope: 'finite', summary: 'Craft and hold a lab and unlock automation science packs', doneWhen: [
  { kind: 'inventory_count', item_name: 'lab', minimum: 1 }, { kind: 'research_completed', technology: 'automation-science-pack' },
] }
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint,
  ...(ctx?.world.memory.currentPlan(KEY)?.task_board.active_step_id ? { stepId: ctx.world.memory.currentPlan(KEY).task_board.active_step_id } : {}),
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
function control(messages) {
  const row = [...messages].reverse().find(message => String(message.content).startsWith('[CONTROL_DECISION_STATE]'))
  assert.ok(row)
  return JSON.parse(row.content.split('\n')[0].slice('[CONTROL_DECISION_STATE] '.length))
}
const requestResearch = messages => {
  const state = control(messages)
  return { content: JSON.stringify({ plan: [STEP], currentStep: 0, stepId: state.stepId, operations: [],
    observationRequest: { stepId: state.stepId, tool: 'getResearchStatus', args: {},
      rationale: 'Check native research before the lab-craft trigger without changing the committed result.' } }) }
}
const read = (name, args, id) => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const collect = (item_name, max_count) => ({ name: 'move_items_exact', args: { item_name, max_count, unit_number: unit, to_entity: false } })
const researchCalls = () => ctx.world.named('tool.call').filter(row => row.name === 'getResearchStatus')
function assertNormal(messages, context, expectedCalls) {
  const state = control(messages)
  if (context.allowTools !== true || state.toolsEnabled !== true || state.targetedReadEligible !== false
    || ctx.world.memory.targetedObservationLedger?.has(KEY)) {
    wireFaults.push({ reason: 'open_observation_request_consumed_targeted_allowance_or_closed_normal_tools',
      allowTools: context.allowTools, toolsEnabled: state.toolsEnabled, targetedReadEligible: state.targetedReadEligible,
      ledgerUsed: Boolean(ctx.world.memory.targetedObservationLedger?.has(KEY)) })
    throw new Error('open JSON research read used closed targeted recovery instead of ordinary observations')
  }
  assert.equal(researchCalls().length, expectedCalls)
  assert.deepEqual(ctx.world.named('observation.targeted_granted'), [])
  assert.equal(sent.length, 0, 'normal read and cached read confer no gameplay authority')
}
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-lab-and-red-slice', reply([], { goal }))
  .push('planner', 'sol:confirm-native-lab-trigger-requirements', messages => {
    const grounding = messages.findLast(row => String(row.content).startsWith('[HARNESS]')).content
    assert.match(grounding, /requirements_grounding/)
    assert.match(grounding, /trigger item lab/)
    return reply([], { goal })
  })
  .push('executor', 'luna:open-typed-research-read', async (messages, context) => {
    assert.equal(context.allowTools, true)
    // Declared historical harness policy, not gameplay: the original goal has
    // already used all six resumes. Ordinary reads must not reset that count.
    const held = ctx.world.memory.planningByNpc.get(KEY)
    held.run.auto_resume = { goal_id: held.goal.goal_id, goal_total: 6, steps: [] }
    await ctx.world.agent.persistState()
    assert.equal(ctx.world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
    initialNativeReads = transcript.filter(row => row.command.includes('autorio_research') && row.command.includes('status')).length
    return requestResearch(messages)
  })
  .push('executor', 'luna:ordinary-research-read-then-cached-repeat', (messages, context) => {
    assertNormal(messages, context, 1)
    assert.equal(researchCalls()[0].cached, false)
    seen.afterNormal = ctx.world.agent.observationBudgetRemaining
    return requestResearch(messages)
  })
  .push('executor', 'luna:cached-research-does-not-spend-another-read', (messages, context) => {
    assertNormal(messages, context, 2)
    assert.equal(researchCalls()[1].cached, true)
    assert.equal(ctx.world.agent.observationBudgetRemaining, seen.afterNormal)
    assert.equal(transcript.filter(row => row.command.includes('autorio_research') && row.command.includes('status')).length - initialNativeReads, 1)
    return read('getEntityStatus', { name: 'stone-furnace', radius: 32 }, 'fresh-furnace-iron-output')
  })
  .push('executor', 'luna:extract-obstructing-native-iron', messages => {
    const status = JSON.parse([...messages].reverse().find(row => row.role === 'tool').content)
    assert.equal(status.observation_mode, 'full')
    assert.equal(status.entity.unit_number, unit)
    const items = status.entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(items.some(row => row.name === 'iron-plate' && row.count === 52))
    assert.ok(items.some(row => row.name === 'copper-ore' && row.count === 4), 'one of the five setup ores is already reserved in the native copper craft')
    unit = status.entity.unit_number
    return reply([collect('iron-plate', 52)])
  })
  .push('executor', 'luna:fresh-exact-copper-output', () => read('getEntityStatus', { unit_number: unit }, 'fresh-exact-copper-output'))
  .push('executor', 'luna:collect-five-new-native-copper', messages => {
    const status = JSON.parse([...messages].reverse().find(row => row.role === 'tool').content)
    assert.equal(status.observation_mode, 'full'); assert.equal(status.entity.unit_number, unit)
    const items = status.entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(items.some(row => row.name === 'copper-plate' && row.count === 5))
    assert.ok(!items.some(row => row.name === 'iron-plate'))
    return reply([collect('copper-plate', 5)])
  })
  .push('executor', 'luna:craft-lab-after-real-plate-recovery', () => reply([{ name: 'craft_item', args: { item_name: 'lab', count: 1 } }]))

try {
  await fsp.mkdir(results, { recursive: true })
  // Run U configuration gate: offline serializer probes precede this runner's
  // RCON connection, world fixture, Session and scripted gameplay provider.
  // Probe transport is owned by production preflight, never model inference.
  const providerEnv = { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key',
    OPENAI_API_BASEURL: 'https://provider.example.test/v1', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` }
  const emptyMethod = configuration({}, { ...providerEnv, AI_API_METHOD: '' })
  assert.equal(emptyMethod.aiApiMethod, undefined)
  await assert.rejects(() => verifyCliProxyProviderContracts(emptyMethod, { requestId: 'native_run_u_missing_method' }), error => {
    assert.ok(error instanceof DeploymentError)
    assert.equal(error.message, 'CLI-proxy preflight requires AI_API_METHOD=cli-proxy')
    preflight.rejected = { status: 'rejected', request_id: 'native_run_u_missing_method', reason: error.message }
    return true
  })
  assert.equal(connection, undefined)
  assert.equal(ctx, undefined)
  assert.equal(transcript.length, 0)
  assert.equal(wire.length, 0)
  assert.equal(sent.length, 0)
  assert.deepEqual(model.labels, [])
  assert.equal(forbiddenFetchCalls, 0)
  const providerConfig = configuration({}, { ...providerEnv, AI_API_METHOD: 'cli-proxy' })
  preflight.verified = await verifyCliProxyProviderContracts(providerConfig, { requestId: 'native_cli_proxy_profile' })
  assert.equal(preflight.verified.event, 'provider.cli_proxy_contract_verified')
  assert.equal(preflight.verified.request_id, 'native_cli_proxy_profile')
  assert.equal(preflight.verified.reason, 'explicit_cli_proxy_method_and_role_closed_wire_verified')
  assert.equal(preflight.verified.status, 'pass')
  assert.equal(preflight.verified.ai_api_method, 'cli-proxy')
  assert.equal(preflight.verified.external_inference_calls, 0)
  assert.deepEqual(preflight.verified.roles.map(row => [row.role, row.model]), [['planner', PLANNER_MODEL], ['executor', EXECUTOR_MODEL]])
  for (const role of preflight.verified.roles) {
    assert.equal(role.profile, 'cli-proxy')
    assert.deepEqual(role.capabilities, { id: 'cli-proxy', model_family: 'openai-gpt', tools_kept_when_closed: true, tool_support: true })
    assert.equal(role.body.model, role.model)
    assert.equal(role.body.tool_choice, 'none')
    assert.equal(role.body.max_tokens, 4000, 'neutral offline probe cap is separate from gameplay budgets')
    assert.ok(role.body.tools.length > 0)
    assert.ok(role.body.tools.every(tool => tool.type === 'function'))
    assert.ok(role.body.tools.some(tool => tool.function.name === 'submitPlan'))
  }
  assert.equal(connection, undefined)
  assert.equal(transcript.length, 0)
  assert.equal(wire.length, 0, 'two offline serializer probes are not scripted game-provider calls')
  assert.equal(sent.length, 0)
  assert.deepEqual(model.labels, [])
  assert.equal(forbiddenFetchCalls, 0)
  await fsp.writeFile(path.join(results, 'cli-proxy-preflight-proof.json'), JSON.stringify(preflight, null, 2))
  await until('RCON ready', async () => {
    connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, 'normal-observation-native-session')
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
    + 'game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=game.create_surface("normal-observation",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); '
    + 's.request_to_generate_chunks({16,16},2); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; local tiles={}; '
    + 'for x=-32,63 do for y=-32,63 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); assert(a.teleport({16,16},s)); '
    + 'local inv=a.get_main_inventory(); inv.clear(); for _,v in pairs({{"iron-plate",62},{"copper-plate",10},{"iron-gear-wheel",10}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end; '
    + 'local f=s.create_entity{name="stone-furnace",position={19,16},force=a.force}; assert(f); assert(f.get_output_inventory().insert{name="iron-plate",count=52}==52); '
    + 'assert(f.get_inventory(defines.inventory.crafter_input).insert{name="copper-ore",count=5}==5); assert(f.get_fuel_inventory().insert{name="coal",count=10}==10); '
    + 'a.force.technologies["steam-power"].researched=true; a.force.technologies.electronics.researched=true; assert(not a.force.technologies["automation-science-pack"].researched); '
    + 'local prerequisites={} for n,t in pairs(a.force.technologies["automation-science-pack"].prerequisites) do prerequisites[t.name]=t.researched end; '
    + 'local recipes={} for _,n in pairs({"lab","iron-gear-wheel","electronic-circuit","copper-cable","transport-belt"}) do local r=a.force.recipes[n]; recipes[n]={ingredients=r.ingredients,products=r.products,enabled=r.enabled} end; '
    + 'rcon.print(helpers.table_to_json({actor_id=a.unit_number,unit=f.unit_number,prerequisites=prerequisites,recipes=recipes,trigger=a.force.technologies["automation-science-pack"].prototype.research_trigger}))'))
  unit = setup.unit
  // SETUP ENDS HERE. Seeded steam-power/electronics are Run T's already
  // verified prerequisites; red science remains locked. No later insertion,
  // teleport, terrain/research edit, forced craft or corrective gameplay.
  assert.deepEqual(setup.prerequisites, { 'steam-power': true, electronics: true })
  assert.equal(setup.recipes.lab.enabled, true, 'the native lab recipe is enabled; the science recipe is the locked result')
  assert.deepEqual(setup.trigger, { type: 'craft-item', item: { name: 'lab' }, count: 1 })
  const before = await idle()
  assert.equal(before.output['iron-plate'], 52)
  assert.equal(before.source['copper-ore'], 4, 'native furnace reserves one input before the obstructed output is cleared')
  assert.equal(before.furnace.recipe, 'copper-plate')
  assert.ok(before.furnace.crafting_progress > 0 && before.furnace.crafting_progress <= 1, 'reserved input is in a native craft already in progress')
  assert.equal(before.copper_produced, 0, 'reserved ore is not yet a produced plate')
  assert.equal(before.red, false); assert.equal(before.red_recipe, false)
  assert.deepEqual(before.held, { 'iron-plate': 62, 'copper-plate': 10, 'iron-gear-wheel': 10 })
  const bridge = Object.create(Session.prototype)
  bridge.config = providerConfig
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context,
    promptTraceFile: path.join(results, 'normal-observation-provider.jsonl'), fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      wire.push({ body, role: context.role, allowTools: context.allowTools, actor_id: context.actorId, epoch: context.epoch })
      const message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ id: `normal-read-${wire.length}`, model: body.model,
        choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'research_state', 'entity_status', 'inventory_equipment']) if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config,
    stateFile: path.join(results, 'normal-observation-state.json') })
  world.agent.provider = (messages, context) => bridge.roleProvider(messages, context)
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Clear the furnace iron output, recover five copper plates, then craft and hold a lab to unlock automation science packs')
  await settle(ctx.session); healthy()
  const canonical = structuredClone(world.memory.planningState(KEY))
  assert.equal(sent.length, 1)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  seen.smelted = await until('five native copper plates after iron output clearing', async () => {
    const s = await snapshot()
    return s.output['copper-plate'] === 5 ? s : false
  })
  seen.ironExtracted = await completion()
  assert.equal(seen.ironExtracted.held['iron-plate'], 114)
  assert.equal(seen.ironExtracted.red, false)
  assert.equal(sent.length, 2)
  seen.copperExtracted = await completion()
  assert.equal(seen.copperExtracted.held['copper-plate'], 15)
  assert.equal(seen.copperExtracted.output['copper-plate'] ?? 0, 0)
  assert.equal(sent.length, 3)
  assert.equal(world.memory.planningState(KEY).goal.goal_id, canonical.goal.goal_id)
  assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonical.plans.at(-1).steps)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  assert.equal(world.memory.autoResumeAllowance(KEY).goal_attempts, 6)
  await until('native lab craft trigger enables red science', async () => {
    const s = await snapshot()
    return s.held.lab === 1 && s.red && s.red_recipe ? s : false
  })
  seen.allowanceBeforeGoal = world.memory.autoResumeAllowance(KEY)
  assert.equal(seen.allowanceBeforeGoal.goal_attempts, 6)
  await completion()
  const after = await idle()
  assert.equal(after.held.lab, 1); assert.equal(after.red, true); assert.equal(after.red_recipe, true)
  assert.equal(after.copper_produced - before.copper_produced, 5)
  assert.equal(after.held['copper-plate'] ?? 0, 0)
  assert.equal(after.held['iron-plate'], 98, 'native lab consumes16iron when10gears are already held')
  assert.equal(after.actor_id, before.actor_id)
  assert.equal(after.crafting_queue_length, 0)
  assert.equal(after.crafting.task_active, false)
  assert.equal(after.navigation.task_active, false)
  assert.equal(after.follow.active, false)
  assert.equal(after.walking, false); assert.equal(after.mining, false)
  assert.equal(sent.length, 3, 'only iron extraction, copper extraction and native lab crafting')
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  const retainedResume = world.memory.planningByNpc.get(KEY)?.run?.auto_resume
  if (retainedResume?.goal_id === canonical.goal.goal_id) assert.equal(retainedResume.goal_total, 6)
  assert.equal(world.named('observation.normal_from_control').length, 2)
  assert.ok(world.named('observation.normal_from_control').every(row => row.request_id && row.reason === 'normal_tools_available_use_existing_observation_budget'))
  assert.deepEqual(world.named('observation.targeted_granted'), [])
  assert.equal(world.memory.targetedObservationLedger?.has(KEY) ?? false, false)
  assert.deepEqual(world.named('recovery.auto_resume_started'), [])
  assert.deepEqual(world.named('recovery.fresh_context_started'), [])
  const plannerWire = wire.filter(row => row.role === 'planner')
  assert.equal(wire.length, 9, 'preflight must not add gameplay-provider calls')
  assert.equal(plannerWire.length, 2, 'initial slice and mandatory live requirements grounding confirmation')
  assert.ok(plannerWire.every(row => row.body.model === PLANNER_MODEL))
  assert.ok(wire.filter(row => row.role === 'executor').every(row => row.body.model === EXECUTOR_MODEL))
  assert.ok(wire.every(row => row.actor_id === status.actor_id && row.epoch === status.epoch))
  assert.deepEqual(model.remaining, []); healthy()
  assert.equal(forbiddenFetchCalls, 0)
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, 'normal-observation-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    setup, before, seen, after, wire, trace: world.trace }, null, 2))
  process.stdout.write('normal-observation native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'normal-observation-error.txt'), `${error.stack}\n${JSON.stringify({ preflight, forbiddenFetchCalls, wireFaults, wire, seen, labels: model.labels, logs: ctx?.logs, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
