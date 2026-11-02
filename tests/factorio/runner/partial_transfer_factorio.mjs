#!/usr/bin/env node
// Run X migrated to a dedicated copper assignment. A prior bootstrap goal places the
// furnace and enrolls it from its real placement receipt. An explicit native source-capacity
// content race AFTER normal admission causes a real partial prefix; Session owns recovery.
// Unknown-receipt control deliberately removes evidence, never native effects.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest } from '../pterodactyl/runtime-v8/provider.mjs'
import { providerToolDefinitions, executorProviderToolDefinitions, planningOnlyProviderToolDefinitions, executionOnlyProviderToolDefinitions, toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { planReply, jevContractLog, answersStepContract } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in partial-transfer fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const mode = arg('mode')
assert.ok(['recovery', 'unknown'].includes(mode))
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const wire = []; const seen = {}; const corruptions = []
let connection; let ctx; let unit; let injectedCapacity = false; let regression = false
const refusal = 'moving_items:nothing_moved:input_slot_holds_other_item'
const rcon = { command: async (command, options) => {
  // The bootstrap goal's own copper supply is ordinary production, never the race target.
  if (regression && !injectedCapacity && command.includes('"authorize"') && command.includes("'supply_entity'") && command.includes('copper-ore')) {
    // Test-only content race: queue/journal admission has succeeded in this same
    // callback, but no task tick has run. Keep all returned acknowledgements real.
    const end = command.indexOf('rcon.print("SGLUNA_RESULT_')
    assert.ok(end > 0)
    const race = `if ok then local f=game.surfaces["partial-transfer"].find_entity("stone-furnace",{6,4});assert(f and f.unit_number==${unit},"capacity_race_exact_target_missing");local inv=f.get_inventory(defines.inventory.furnace_source);assert(inv.is_empty(),"capacity_race_source_not_empty");f.active=false;assert(#inv==1,"content_race_requires_single_input_slot");assert(inv[1].set_stack{name="iron-ore",count=1},"content_race_stack_refused");storage.partial_transfer_capacity_race={unit=f.unit_number,item="iron-ore",count=1,tick=game.tick};end; `
    command = command.slice(0, end) + race + command.slice(end)
    injectedCapacity = true
    seen.residualInjection = { mechanism: 'native incompatible-source-content race after journal finish; no forged acknowledgement', original_batch_admission: 'normal host and native guards', reset: 'remove exactly injected stock after terminal receipt' }
  }
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('storage.partial_transfer_capacity_race=')) assert.match(String(answer), /SGLUNA_RESULT_[a-f0-9]{24}:/, 'Native capacity injection must succeed before observing its real receipt')
  if (regression && command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  // The diagnostic snapshot below nests operations, so it always preserves the
  // complete real receipt. Only ordinary production status reads lose a field.
  if (mode === 'unknown' && command.includes('"autorio_operations","status"')) {
    let status
    try { status = JSON.parse(answer) } catch { /* non-JSON native diagnostic */ }
    if (status?.task_state && status.last_cancelled_batch?.reason === refusal) {
      const before = structuredClone(status.last_cancelled_batch)
      delete status.last_cancelled_batch.completed_count
      for (const receipt of status.receipt_journal ?? []) if (receipt.reason === refusal) delete receipt.completed_count
      corruptions.push({ reason: 'missing_terminal_completed_count', before, after: structuredClone(status.last_cancelled_batch) })
      return JSON.stringify(status)
    }
  }
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["partial-transfer"].find_entities_filtered{name="character"}[1]; assert(a); ${body}`))
const snapshot = () => lua(`local f=a.surface.find_entity("stone-furnace",{6,4}); assert(f and f.unit_number==${unit});
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local o=remote.call("autorio_operations","status");
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,tick=game.tick,
    held=counts(a.get_main_inventory()),source=counts(f.get_inventory(defines.inventory.furnace_source)),output=counts(f.get_output_inventory()),fuel=counts(f.get_fuel_inventory()),
    remaining_fuel=f.burner.remaining_burning_fuel,energy=f.energy,crafting_progress=f.crafting_progress,recipe=f.get_recipe() and f.get_recipe().name,
    position=a.position,target={unit_number=f.unit_number,position=f.position,surface_index=f.surface.index},
    copper_produced=a.force.get_item_production_statistics(a.surface).get_input_count("copper-plate"),
    operations=o,journal=remote.call("autorio_operation_admission","status")}))`)
// The unresolved unknown partial is refused at the factory boundary before any send.
let expectedFailures = []
function healthy() {
  if (!ctx) return
  assert.deepEqual(model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed').map(row => row.failure_code), expectedFailures)
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 90000) {
  const end = Date.now() + timeout
  for (;;) { healthy(); const result = await predicate(); if (result) return result
    assert.ok(Date.now() < end, `timeout ${label}; labels=${JSON.stringify(model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('native idle', async () => {
    const s = await snapshot(); assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    return s.operations.queue_length === 0 && s.operations.task_state === 'idle' ? s : false
  })
}
async function completion() {
  await idle(); ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session); healthy()
}
const STEP = 'Collect two existing copper plates and produce five new copper plates in the dedicated copper furnace to hold fifteen'
const checkpoint = { mode: 'all', requirements: [{ id: 'copper15', kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] }
const goal = { scope: 'finite', summary: 'Hold fifteen copper plates after smelting five new copper plates', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 15 }] }
const reply = (operations = [], extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, checkpoint,
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
const initial = () => [
  { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 1, to_entity: false } },
  { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 1, to_entity: false } },
  { name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 4 }] } },
]
let readId = 0
const readStatus = () => ({ content: null, tool_calls: [{ id: `partial-status-${++readId}`, type: 'function', function: { name: 'getEntityStatus', arguments: JSON.stringify({ name: 'stone-furnace', radius: 12 }) } }] })
const lastTool = messages => JSON.parse(messages.findLast(row => row.role === 'tool').content)
function rawRepair() {
  const active = ctx.world.memory.planningState(KEY).plans.at(-1)
  return { content: JSON.stringify({ stepId: active.steps[active.active_step_index].step_id ?? ctx.world.memory.currentPlan(KEY).task_board.active_step_id,
    operations: [
      { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 1, to_entity: false } },
      { name: 'supply_entity', args: { unit_number: unit, items: [{ item_name: 'copper-ore', count: 4 }] } },
    ], checkpoint: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 1 }] },
    chatMessage: 'The fresh dedicated copper furnace has one newly completed copper plate and fuel. Collect that output and load four copper ore.' }) }
}
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-fifteen-copper-checkpoint', reply([], { goal }))
  .push('executor', 'luna:observe-real-reserved-copper-craft', () => readStatus())
  .push('executor', 'luna:collect-prefix-and-refuel-dedicated-copper', messages => {
    const status = lastTool(messages); assert.equal(status.entity.unit_number, unit)
    seen.initialDeliveredEntity = structuredClone(status.entity)
    const items = status.entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(!items.some(row => row.name === 'copper-ore'))
    assert.ok(items.some(row => row.name === 'copper-plate' && row.count === 2))
    return reply(initial())
  })
if (mode === 'recovery') model
  .push('executor', 'luna:fresh-observation-after-accounted-partial-effect', () => readStatus())
  .push('executor', 'luna:canonical-continuation-without-new-completion-contracts', messages => {
    const status = lastTool(messages)
    seen.freshDeliveredStatus = structuredClone(status)
    let entity = status.entity
    if (status.observation_mode === 'diff') {
      assert.equal(status.reference, `entity:${unit}`)
      assert.equal(status.query.name, 'stone-furnace')
      assert.ok(Array.isArray(status.changes?.entity?.inventories), 'fresh inventories must be present in the delivered diff')
      const fullTool = messages.filter(row => row.role === 'tool').map(row => {
        try { return JSON.parse(row.content).entity } catch { return undefined }
      }).find(row => row?.unit_number === unit)
      const deliveredBlock = messages.find(row => row.role === 'user' && row.content.startsWith('[ENTITY_STATUS_BASELINE]'))
      const carried = deliveredBlock ? JSON.parse(deliveredBlock.content.slice(deliveredBlock.content.indexOf('\n') + 1)) : []
      const carriedSnapshot = carried.find(row => row.reference === status.reference && row.query.name === status.query.name && row.query.radius === status.query.radius && row.entity?.unit_number === unit)
      const baseline = fullTool ?? carriedSnapshot?.entity
      assert.deepEqual(baseline, seen.initialDeliveredEntity, 'the actual current provider conversation must retain the delivered full baseline')
      seen.currentConversationRetainsBaseline = true
      seen.deliveredBaselineBlock = deliveredBlock?.content ?? null
      entity = { ...baseline, ...status.changes.entity }
    }
    assert.equal(entity.unit_number, unit)
    seen.freshDeliveredEntity = structuredClone(entity)
    const items = entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : [])
    assert.ok(items.some(row => row.name === 'copper-plate' && row.count === 1))
    assert.ok(items.some(row => row.name === 'coal' && row.count === 4))
    assert.ok(!items.some(row => row.name === 'copper-ore'))
    assert.equal(sent.length, 1, 'no completed prefix may replay before the model chooses a fresh repair')
    seen.beforeRepairPlan = structuredClone(ctx.world.memory.planningState(KEY).plans.at(-1))
    return rawRepair()
  })
  .push('executor', 'luna:collect-four-remaining-new-copper', () => reply([
    { name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 4, to_entity: false } },
  ]))
else model.push('executor', 'luna:blocked-continuation-cannot-bypass-canonical-authority', () => {
  assert.equal(ctx.world.memory.planningState(KEY).plans.at(-1).status, 'BLOCKED')
  return rawRepair()
})

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => { connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); try { await connection.connect(); return true } catch { return false } }, 20000)
  await configureNpcSession(rcon, `partial-transfer-${mode}-session`)
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); remote.call("autorio_operations","cancel_all_tasks"); '
    + 'local s=game.create_surface("partial-transfer",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); s.request_to_generate_chunks({4,4},1); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; '
    + 'local tiles={}; for x=-16,31 do for y=-16,31 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true); assert(a.teleport({3,4},s)); s.always_day=true; '
    + 'a.get_main_inventory().clear(); rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index}))'))
  // Bootstrap goal: the furnace becomes the dedicated copper cell only through a real
  // authorized placement and receipt-backed production enrollment, never a declared member.
  const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
  const detail = await tool('getRecipeDetails', { item_or_recipe: 'copper-plate', requested_count: 1 })
  const recipe = detail.recipes?.find(row => row.name === 'copper-plate')
  assert.equal(detail.truncated, false); assert.equal(recipe?.enabled, true)
  assert.equal(recipe.ingredients.length, 1); assert.equal(recipe.products.length, 1)
  const input = recipe.ingredients[0]; const output = recipe.products[0]
  assert.equal(input.name, 'copper-ore'); assert.equal(output.name, 'copper-plate')
  const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace'); assert.ok(machine)
  const fuel = detail.burner_fuels.items.find(row => row.name === 'coal' && machine.fuel_categories.includes(row.category) && row.fuel_value > 0); assert.ok(fuel)
  const bootstrapFuel = Math.max(1, Math.ceil(recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 1)
  assert.ok(Number.isSafeInteger(bootstrapFuel) && bootstrapFuel <= 5)
  await lua(`local inv=a.get_main_inventory();for _,v in pairs({{"stone-furnace",1},{"copper-ore",${input.amount}},{"coal",${bootstrapFuel}}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end;rcon.print("true")`)
  const factoryWorld = await lua(`local id=storage.sgluna_factory_world_id or "${randomUUID()}";rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",id)))`)
  assert.equal(factoryWorld.ok, true)
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(factoryWorld.world_id)
  const stateFile = path.join(results, `partial-transfer-${mode}-state.json`)
  const bootstrapEvents = []; let bootstrapPlanner = 0; let bootstrapExecutor = 0
  const bootstrapSummary = 'Place the held furnace, then produce and collect one copper plate.'
  const bootstrapContract = { mode: 'all', requirements: [{ id: 'bootstrap-copper', kind: 'inventory_count', item_name: output.name, minimum: output.amount }] }
  const guidance = { approach: 'Use exact retained placement and current native recipe evidence.', rationale: 'Finite bootstrap that establishes the dedicated copper furnace.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: input.name } }
  const bootstrap = new NpcAgentLoop({ rcon, memory, npcId: 'sgluna', completionProtocolVersion: 3, jevCheckpoints: false,
    stateFile, traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted offline partial-transfer bootstrap.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      if (context.role === 'planner') {
        assert.ok(++bootstrapPlanner <= 1, 'the bootstrap planner is scripted once')
        return planReply({ plan: ['Place the held stone furnace', 'Smelt and collect one copper plate in that furnace'], operations: [],
          goal: { scope: 'finite', summary: bootstrapSummary, doneWhen: bootstrapContract.requirements }, executionGuidance: [guidance, guidance],
          stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ id: 'placed', kind: 'entity_count', prototype: 'stone-furnace', minimum: 1 }] } },
            { kind: 'deterministic', checkpoint: bootstrapContract }] })
      }
      assert.ok(++bootstrapExecutor <= 2, 'no bootstrap executor retry or correction')
      const plan = getActivePlan(memory.planningState(KEY)); const step = plan.steps[plan.active_step_index]
      if (plan.active_step_index === 0) return planReply({ stepId: step.step_id, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 6, y: 4 } }] })
      const [receipt] = memory.snapshot().factory_placement_receipts
      return planReply({ stepId: step.step_id, operations: [], productionTask: { targets: [{ item_name: output.name, count: output.amount }],
        producers: [{ recipe_name: recipe.name, unit_number: receipt.unit_number }], fuel: { item_name: fuel.name, count: bootstrapFuel } } })
    }) })
  bootstrap.behaviorTrace = { emit: async row => bootstrapEvents.push(row) }
  await bootstrap.request(bootstrapSummary, { sender: 'owner' })
  const bootstrapDeadline = Date.now() + 180000
  while (memory.planningState(KEY)?.goal?.status !== 'completed') {
    assert.ok(Date.now() < bootstrapDeadline, 'bounded bootstrap production timeout')
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) await bootstrap.completed()
    assert.notEqual(memory.pauseRecord(KEY)?.paused, true, JSON.stringify(bootstrapEvents.slice(-5)))
    await delay(100)
  }
  bootstrap.active = false; bootstrap.generation++
  const receipts = memory.snapshot().factory_placement_receipts
  assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].position, { x: 6, y: 4 })
  const cells = memory.getFactoryRegistry().cells
  assert.equal(cells.length, 1); assert.equal(cells[0].members.length, 1)
  assert.equal(cells[0].assignment.method, 'native_recipe:copper-plate')
  assert.equal(cells[0].members[0].unit_number, receipts[0].unit_number)
  assert.equal(cells[0].members[0].provenance.receipt_id, receipts[0].receipt_id)
  assert.equal(bootstrapEvents.filter(row => row.event === 'factory_cell.enrolled_from_production').length, 1)
  unit = receipts[0].unit_number
  seen.bootstrap = { receipt: structuredClone(receipts[0]), cell: structuredClone(cells[0]), planner: bootstrapPlanner, executor: bootstrapExecutor }
  // Declared stock setup on the enrolled furnace. Bootstrap leaves timing-dependent
  // burner residue, so zero it, load a full ore stack and exactly one coal, then trim after exhaustion.
  seen.stockSetup = await lua(`local f=a.surface.find_entity("stone-furnace",{6,4});assert(f and f.unit_number==${unit},"bootstrap_furnace_missing")
    local inv=a.get_main_inventory();inv.clear();for _,v in pairs({{"copper-plate",8},{"copper-ore",10},{"coal",5}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end
    local residue={remaining_fuel=f.burner.remaining_burning_fuel,energy=f.energy,crafting_progress=f.crafting_progress}
    assert(f.crafting_progress==0,"bootstrap_craft_in_progress");f.burner.currently_burning=nil;f.burner.remaining_burning_fuel=0;f.energy=0;f.get_output_inventory().clear()
    local fuel=f.get_fuel_inventory();fuel.clear();assert(fuel.insert{name="coal",count=1}==1)
    local source=f.get_inventory(defines.inventory.furnace_source);assert(source.is_empty(),"bootstrap_source_not_empty");assert(source.insert{name="copper-ore",count=50}==50)
    assert(f.get_output_inventory().insert{name="copper-plate",count=4}==4)
    game.speed=16;rcon.print(helpers.table_to_json({unit=f.unit_number,residue=residue,output=f.get_output_inventory().get_item_count("copper-plate"),remaining_fuel=f.burner.remaining_burning_fuel}))`)
  seen.nativeSetup = await until('real coal exhaustion with a reserved unfinished copper craft', async () => {
    const s = await snapshot()
    return (s.fuel.coal ?? 0) === 0 && s.remaining_fuel === 0 && s.energy === 0 && s.crafting_progress > 0 && s.crafting_progress < 1 ? s : false
  }, 20000)
  seen.setupTrim = await lua(`game.speed=1;local f=a.surface.find_entity("stone-furnace",{6,4});local source=f.get_inventory(defines.inventory.furnace_source);local out=f.get_output_inventory()
    local ore=source.get_item_count("copper-ore");local plates=out.get_item_count("copper-plate");assert(ore>0,"fuel_must_exhaust_before_ore");assert(plates>=2)
    assert(source.remove{name="copper-ore",count=ore}==ore);if plates>2 then assert(out.remove{name="copper-plate",count=plates-2}==plates-2) end
    rcon.print(helpers.table_to_json({removed_ore=ore,removed_plates=plates-2}))`)
  // Declared setup ends here. Partial progress comes from real fuel consumption.
  // The only later fixture stock mutation is the labeled, accounted capacity race.
  const before = await idle()
  assert.equal(before.source['copper-ore'] ?? 0, 0); assert.equal(before.output['copper-plate'], 2)
  assert.equal(before.held['copper-plate'], 8)
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', AI_API_METHOD: 'cli-proxy', OPENAI_API_KEY: 'fixture-only-not-a-real-key', OPENAI_API_BASEURL: 'https://fixture.example.test/v1', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, { ...context, promptTraceFile: null, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    const expectedTools = context.completionProtocolVersion >= 3
      ? context.role === 'executor' ? executionOnlyProviderToolDefinitions : planningOnlyProviderToolDefinitions
      : context.role === 'executor' ? executorProviderToolDefinitions : providerToolDefinitions
    // Continuation requests may shorten descriptions; identities and schemas stay exact.
    const contracts = tools => tools.map(({ type, function: tool }) => ({ type, name: tool.name, parameters: tool.parameters }))
    assert.deepEqual(contracts(body.tools), contracts(expectedTools), 'wire must preserve current role-specific tool identities and schemas'); assert.ok(body.tools.some(tool => tool.function?.name === 'getPumpSitePreparation')); assert.equal(body.tool_choice, context.allowTools === false ? 'none' : 'auto')
    wire.push({ role: context.role, model: body.model, tool_choice: body.tool_choice, tools: body.tools.length })
    const message = await model.provide(body.messages, context)
    return new Response(JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 2000, completion_tokens: 120 } }), { status: 200 })
  } })
  const decisionScript = (_state, questions) => ({ overrides: Object.fromEntries(Object.keys(questions).filter(key => key.startsWith('need_')).map(key => [key, { noul: 0.9 }])) })
  // The regression agent inherits the bootstrap's save-scoped registry, receipts and state file.
  const world = recoveryWorld({ game: rcon, model, memory, decisionScript, agentRoleConfig: bridge.config, roleProvider: (messages, context) => bridge.roleProvider(messages, context), stateFile })
  await world.agent.persistState({ strict: true })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch, sessionId: status.session }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  regression = true
  ctx.session.queuePlayerRequest('TTLouis', goal.summary)
  await settle(ctx.session); healthy()
  const canonical = structuredClone(world.memory.planningState(KEY))
  seen.failed = await until('native copper refusal after three completed transfer tasks', async () => {
    const s = await snapshot()
    return s.operations.last_cancelled_batch?.reason === refusal ? s : false
  })
  const failed = seen.failed.operations.last_cancelled_batch
  assert.equal(failed.task_count, 4); assert.equal(failed.started_count, 4)
  assert.equal(failed.completed_count, 3); assert.equal(failed.refused_count, 1)
  assert.equal(seen.failed.operations.basic_operation.last_result.moved_count, 0)
  assert.ok(['partial', 'uncertain'].includes(seen.failed.journal.records.at(-1).state))
  seen.capacityRaceReset = await lua(`local race=storage.partial_transfer_capacity_race;assert(race and race.unit==${unit});local f=a.surface.find_entity("stone-furnace",{6,4});assert(f and f.unit_number==race.unit and not f.active,"capacity_race_reset_owner_changed");local removed=f.get_inventory(defines.inventory.furnace_source).remove{name=race.item,count=race.count};assert(removed==race.count);f.active=true;rcon.print(helpers.table_to_json({removed=removed,injected=race.count,tick=game.tick}))`)
  seen.afterReservedCraft = await until('reserved native copper product finishes after real refuelling', async () => {
    const s = await snapshot(); return s.output['copper-plate'] === 1 && (s.source['copper-ore'] ?? 0) === 0 ? s : false
  })
  assert.equal(sent.length, 1)
  ctx.session.lastErrorAt = 0
  if (mode === 'unknown') expectedFailures = ['factory_runtime_not_idle']
  ctx.session.onGameLine('[AUTORIO] [ERROR] moving_items failed: nothing_moved:input_slot_holds_other_item; dependent operations cancelled')
  await settle(ctx.session); healthy()
  if (mode === 'recovery') {
    assert.equal(sent.length, 2)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, canonical.goal.goal_id)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonical.plans.at(-1).steps)
    assert.ok(world.named('operation.reconciled').some(row => row.verdict === 'admitted_partial' && row.effect === 'partial_known' && row.reason === 'exact_terminal_transfer_refusal'))
    assert.equal(seen.failed.journal.records.at(-1).state, 'partial', 'the real native journal must preserve the fully accounted terminal partial effect')
    const closed = world.memory.planningState(KEY).operation_ledger.closed.find(row => row.verdict === 'admitted_partial')
    assert.equal(closed.effect, 'partial_known')
    assert.equal(world.memory.pendingOperations(KEY).some(row => row.operation_key === closed.operation_key), false)
    seen.reconciledLedger = structuredClone(world.memory.planningState(KEY).operation_ledger)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'the root one-plate checkpoint cannot close the committed fifteen-plate step')
    seen.smelted = await until('five real new copper plates', async () => {
      const s = await snapshot(); return s.output['copper-plate'] === 4 && s.copper_produced - before.copper_produced === 5 ? s : false
    })
    await completion()
    assert.equal(sent.length, 3)
    await completion()
    const after = await idle()
    assert.equal(after.held['copper-plate'], 15); assert.equal(after.copper_produced - before.copper_produced, 5)
    assert.equal(after.held['iron-ore'] ?? 0, 0); assert.equal(after.held['iron-plate'] ?? 0, 0, 'dedicated copper assignment never imports an iron job')
    assert.equal(after.held['copper-ore'], 6); assert.equal(after.held.coal ?? 0, 0)
    assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
    assert.equal(world.memory.currentPlan(KEY), undefined)
    assert.equal(sent[0].split(`'move_items_exact','copper-plate',${unit},1,false`).length - 1, 2)
    assert.equal(sent.slice(1).filter(command => command.includes(`'move_items_exact','copper-plate',${unit},1,false`)).length, 1, 'only the newly produced residual output is collected; no prefix replay')
    seen.after = after
  } else {
    assert.ok(corruptions.length > 0)
    const pending = world.memory.pendingOperations(KEY)
    assert.ok(pending.some(row => row.effect === 'partial_unknown'))
    seen.replayGuard = world.memory.checkDuplicateEffect(KEY, { operations: initial() }, { requestId: 'partial-transfer-unknown-replay-control' })
    assert.equal(seen.replayGuard.refuse, true)
    assert.equal(seen.replayGuard.effect, 'partial_unknown')
    assert.equal(sent.length, 1, 'missing receipt fields cannot authorize a repair or completed-prefix replay')
    assert.equal(world.named('operation.reconciled').some(row => row.verdict === 'admitted_partial'), false)
    assert.equal(world.memory.currentPlan(KEY).status, 'blocked')
    assert.equal(world.named('request.failed').length, 1)
    assert.equal(world.named('factory_cell.boundary_refused')[0].current_batch_sent, false)
    const originalPlan = structuredClone(world.memory.planningState(KEY).plans.at(-1))
    const originalPending = structuredClone(world.memory.pendingOperations(KEY))
    const calls = wire.length
    seen.stopPairs = []
    for (let i = 0; i < 2; i++) {
      const traceStart = world.trace.length
      ctx.session.queuePlayerRequest('TTLouis', 'stop')
      await settle(ctx.session)
      const traces = world.trace.slice(traceStart)
      const cancelled = traces.find(row => row.event === 'request.cancelled' && row.data?.reason === 'user_stop_immediate')
      const paused = traces.find(row => row.event === 'goal.paused' && row.data?.cause === 'user_stop' && row.data?.pause_class === 'operator' && row.data?.goal_id === canonical.goal.goal_id)
      assert.ok(cancelled && paused, 'each actual stop must emit a fresh cancel and same-goal operator pause pair')
      assert.deepEqual(world.memory.planningState(KEY).plans.at(-1), originalPlan)
      assert.deepEqual(world.memory.pendingOperations(KEY), originalPending)
      assert.equal(wire.length, calls)
      seen.stopPairs.push({ cancelled, paused })
    }
    seen.after = await idle()
    assert.equal(seen.after.held['copper-plate'], 10)
    assert.equal(seen.after.held['copper-ore'], 10)
    assert.equal(seen.after.output['copper-plate'], 1)
    assert.equal(seen.after.copper_produced - before.copper_produced, 1)
  }
  assert.equal(seen.after.actor_id, before.actor_id)
  assert.equal(wire[0].model, PLANNER_MODEL)
  assert.ok(wire.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), []); assert.equal(forbiddenFetchCalls, 0)
  assert.deepEqual(world.named('recovery.auto_resume_started'), [], 'neither a proven partial effect nor operator stop replenishes automatic resumes')
  await fsp.writeFile(path.join(results, `partial-transfer-${mode}-proof.json`), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, mode, setup, before, seen, wire, corruptions, sent, trace: world.trace, forbiddenFetchCalls }, null, 2))
  process.stdout.write(`partial-transfer ${mode} native full-loop PASS\n`)
} catch (error) {
  await fsp.writeFile(path.join(results, `partial-transfer-${mode}-error.txt`), `${error.stack}\n${JSON.stringify({ mode, seen, corruptions, labels: model.labels, logs: ctx?.logs, trace: ctx?.world.trace, wire, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
