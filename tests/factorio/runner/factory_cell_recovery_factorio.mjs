#!/usr/bin/env node
// Scripted isolated native recovery proof; no live providers. Parent owns the
// exact compiled mod, container, terminal save/reload, evidence seal and cleanup.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i >= 0) return process.argv[i + 1]; assert.notEqual(fallback, undefined, `missing --${name}`); return fallback }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon } = await load('runtime-v8/common.mjs')
const { toolCommand, luaString } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { registerFactoryCell } = await load('runtime-v8/factory-registry.mjs')
const { getActivePlan } = await load('runtime-v8/planning-state.mjs')
const { answersStepContract, planReply } = await load('runtime-v8/task-loop-fixtures.mjs')
const KEY = 'npc:factory-recovery-native'
const OBJECTIVE = 'Produce iron for the requested factory while keeping the dedicated copper production intact.'
const evidence = { status: 'fail', providers: 0, mode: 'scripted_native_same_goal_recovery',
  fixture: 'Declared synthetic initially productive copper and iron pairs; initial registration is fixture-only. A fixture-only injected commit-prevention miss reaches the real shared pre-send refusal and guarded structural successor. Live recipe facts determine all input/fuel quantities; Warmup must exceed every seeded ingredient; recovery must collect real iron into initially empty actor inventory.' }
const transcript = []; const events = []; const replies = []; let connection; let agent
globalThis.fetch = async () => { evidence.providers++; throw new Error('Live inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => { const raw = await rcon.command(`/silent-command ${body}`); try { return JSON.parse(raw) } catch { throw new Error(`native JSON invalid: ${raw}`) } }
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
const locator = row => Object.fromEntries(['unit_number', 'name', 'position', 'surface_index', 'force_index'].map(key => [key, row[key]]))
// Synthetic hardware uses the same authoritative placement-candidate path as
// the retained native observation fixture; candidate geometry comes from game.
const nativePairPlacement = `local dc=remote.call("autorio_tools","get_placement_candidates",{entity_name="burner-mining-drill",center={x=cx,y=cy},radius=4,target_resource=resourceName,limit=4});assert(dc.candidates and #dc.candidates>0,helpers.table_to_json(dc));local dp=dc.candidates[1];assert(dp.item_output_position);
  local d=s.create_entity{name="burner-mining-drill",position=dp.position,direction=dp.direction,force=a.force};assert(d);
  local fc=remote.call("autorio_tools","get_placement_candidates",{entity_name="stone-furnace",covers_position=dp.item_output_position,limit=4});assert(fc.candidates and #fc.candidates>0,helpers.table_to_json(fc));local fp=fc.candidates[1];
  local f=s.create_entity{name="stone-furnace",position=fp.position,direction=fp.direction,force=a.force};assert(f);`
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password', 'offline-fixture-only'), 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  await configureNpcSession(rcon, 'factory-recovery-native-20261031')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const facts = []
  for (const product of ['copper-plate', 'iron-plate']) {
    const detail = await tool('getRecipeDetails', { item_or_recipe: product, requested_count: 1 })
    const recipe = detail.recipes?.find(row => row.name === product)
    assert.equal(detail.truncated, false); assert.equal(recipe?.enabled, true)
    assert.equal(recipe.ingredients.length, 1); assert.equal(recipe.products.length, 1)
    const input = recipe.ingredients[0]; const output = recipe.products[0]
    assert.equal(input.type, 'item'); assert.equal(output.type, 'item'); assert.ok(output.amount > 0)
    assert.ok(output.probability === undefined || output.probability === 1)
    const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace'); assert.ok(machine)
    const fuel = detail.burner_fuels.items.find(row => machine.fuel_categories.includes(row.category) && row.fuel_value > 0); assert.ok(fuel)
    const mining = await tool('getMiningDetails', { resource_or_item: input.name })
    const resource = mining.resources.find(row => row.drills.some(drill => drill.name === 'burner-mining-drill')); assert.ok(resource)
    // Ten cycles is a declared fixture stock size, not a stored recipe ratio.
    const seededCycles = 10
    const fuelCount = Math.max(1, Math.ceil((seededCycles + 8) * recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 2)
    facts.push({ product, recipe, input, output, resource: resource.name, fuel, fuelCount, seededCycles })
  }
  evidence.live_facts = facts
  const setup = await lua(`local a;for _,s in pairs(game.surfaces) do for _,e in pairs(s.find_entities_filtered{type="character",limit=128}) do if e.unit_number==${actor.actor_id} then a=e end end end;assert(a);assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;
    local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y);local tiles={};for xx=x-16,x+16 do for yy=y-12,y+12 do tiles[#tiles+1]={name="landfill",position={xx,yy}} end end;s.set_tiles(tiles,true,false,true);
    for _,e in pairs(s.find_entities_filtered{area={{x-15,y-11},{x+15,y+11}}}) do if e.type~="character" and e.name~="sgluna-npc-vision" then e.destroy() end end;
    local specs=helpers.json_to_table(${luaString(JSON.stringify(facts))});local cells={};local inv=a.get_main_inventory();inv.clear();
    for i,sp in ipairs(specs) do local cx=x+(i==1 and -7 or 7);local cy=y+3;for xx=cx-1,cx+1 do for yy=cy-1,cy+1 do assert(s.create_entity{name=sp.resource,position={xx,yy},amount=10000}) end end;
      local resourceName=sp.resource;${nativePairPlacement}
      assert(f.get_inventory(defines.inventory.furnace_source).insert{name=sp.input.name,count=sp.input.amount*sp.seededCycles}==sp.input.amount*sp.seededCycles);
      assert(f.get_fuel_inventory().insert{name=sp.fuel.name,count=sp.fuelCount}==sp.fuelCount);
      assert(d.get_fuel_inventory().insert{name=sp.fuel.name,count=sp.fuelCount}==sp.fuelCount);
      local function loc(e) return {unit_number=e.unit_number,name=e.name,position=e.position,surface_index=s.index,force_index=a.force.index} end;
      cells[#cells+1]={source=loc(d),target=loc(f),product=sp.product,source_candidate=dp,target_candidate=fp};end;
    rcon.print(helpers.table_to_json({cells=cells,surface_index=s.index,force_index=a.force.index,humans=#game.connected_players,tick=game.tick,paused=game.tick_paused}))`)
  evidence.setup = setup
  const world = await lua(`local id=storage.sgluna_factory_world_id or ${luaString(randomUUID())};rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",id)))`)
  assert.equal(world.ok, true)
  await lua('game.tick_paused=false;rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed}))')
  await tool('getNearbyEntities', { radius: 32, limit: 16 })
  const sample = () => lua(`local cells=helpers.json_to_table(${luaString(JSON.stringify(setup.cells))});local rows={};local function exact(loc)local found;for _,e in pairs(game.surfaces[loc.surface_index].find_entities_filtered{name=loc.name,position=loc.position,force=loc.force_index,limit=9})do if e.unit_number==loc.unit_number and e.position.x==loc.position.x and e.position.y==loc.position.y then assert(not found);found=e end end;return found end;
    for _,c in ipairs(cells)do local d=exact(c.source);local f=exact(c.target);rows[#rows+1]={source_found=d~=nil,target_found=f~=nil,source=d and d.unit_number,target=f and f.unit_number,source_position=d and d.position,target_position=f and f.position,direction=d and d.direction,drop_position=d and d.drop_position,target_box=f and f.bounding_box,recipe=f and f.get_recipe() and f.get_recipe().name,products_finished=f and f.products_finished,output=f and f.get_inventory(defines.inventory.furnace_result).get_item_count(c.product),drop_target=d and d.drop_target and d.drop_target.unit_number}end;
    local actor=game.get_entity_by_unit_number(${actor.actor_id});assert(actor);local inv=actor.get_main_inventory();rcon.print(helpers.table_to_json({tick=game.tick,cells=rows,actor_inventory={iron=inv.get_item_count(${luaString(facts[1].product)}),copper=inv.get_item_count(${luaString(facts[0].product)})},humans=#game.connected_players,speed=game.speed}))`)
  // Initial productive hardware is declared fixture setup, not recovery. Keep
  // every structured native sample before testing connection or output claims.
  evidence.native_warmup = []
  const readyUntil = Date.now() + 120000
  for (;;) {
    const row = await sample(); evidence.native_warmup.push(row)
    assert.equal(row.humans, 0); assert.equal(row.speed, 1)
    if (row.cells.every((cell, i) => cell.drop_target === setup.cells[i].target.unit_number
      && cell.products_finished > facts[i].seededCycles && cell.output >= facts[i].output.amount * (facts[i].seededCycles + 2))) {
      evidence.initial_production = row; break
    }
    assert.ok(Date.now() < readyUntil, `native productive fixture unavailable: ${JSON.stringify(row)}`); await delay(250)
  }
  assert.deepEqual(evidence.initial_production.actor_inventory, { iron: 0, copper: 0 })
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(world.world_id)
  let registry = memory.getFactoryRegistry()
  for (const cell of setup.cells) registry = registerFactoryCell(registry, { surface_index: setup.surface_index, force_index: setup.force_index,
    assignment: { products: [cell.product], purpose: `Dedicated fixture ${cell.product}`, method: 'direct_feed' },
    members: [cell.source, cell.target].map(row => ({ ...locator(row), provenance: { source: 'declared_synthetic_native_fixture' } })),
    ports: [{ port_id: 'out', direction: 'output', kind: 'item', resource: cell.product }], origin: { source: 'declared_synthetic_native_fixture' } })
  memory.restore({ ...memory.snapshot(), factory_registry: registry })
  const copper = structuredClone(registry.cells[0]); let plannerCalls = 0; let executorCalls = 0
  const checkpoint = { mode: 'all', requirements: [{ id: 'iron-stock', kind: 'inventory_count', item_name: facts[1].product, minimum: facts[1].output.amount * (facts[1].seededCycles + 2) }] }
  const guidance = { approach: 'Use the exact dedicated iron pair; keep the copper pair assigned to copper.', rationale: 'Current native source and output identities control use.', constraints: [], skillIds: [], materialSupply: { mode: 'direct_feed', resource: facts[1].input.name } }
  class ResidualMissLoop extends NpcAgentLoop {
    async commitPlan(plan) {
      if (!this.fixtureMissInjected && plan.operations?.some(row => row.name === 'move_items_exact' && row.args.unit_number === setup.cells[0].target.unit_number)) {
        this.fixtureMissInjected = true
        evidence.residual_injection = { earlier_boundary: 'commitPlan factory resolution deliberately bypassed in isolated fixture',
          detector: 'actual recordPendingOperationBeforeSend factory pre-send resolution', transport: 'forbidden unless later normal successor admission succeeds' }
        await this.traceEvent('fixture.factory_commit_prevention_bypassed', evidence.residual_injection)
        await this.recordPendingOperationBeforeSend(plan.operations, this.epoch, [])
        throw new Error('Residual fixture unexpectedly passed pre-send; no transport authorized')
      }
      return super.commitPlan(plan)
    }
  }
  agent = new ResidualMissLoop({ rcon, memory, npcId: 'factory-recovery-native', completionProtocolVersion: 3, replacementWake: true, jevCheckpoints: false,
    stateFile: path.join(results, 'canonical-state.json'), traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted native factory recovery proof.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (messages, context) => {
      // Retain the supplied request even if a bounded script assertion refuses
      // the next turn. These are fixture messages, never live provider inputs.
      const issued = { role: context.role, messages: structuredClone(messages) }; replies.push(issued)
      let reply
      if (context.role === 'planner') {
        plannerCalls++; assert.ok(plannerCalls <= 2)
        reply = planReply({ plan: [plannerCalls === 1 ? 'Produce iron using the existing pair' : 'Produce iron using the correctly assigned iron pair'], operations: [],
          ...(plannerCalls === 1 ? { goal: { scope: 'finite', summary: OBJECTIVE, doneWhen: checkpoint.requirements } } : {}),
          stepCompletions: [{ kind: 'deterministic', checkpoint }], executionGuidance: [guidance] })
      } else {
        executorCalls++; assert.ok(executorCalls <= 4)
        if ([1, 3].includes(executorCalls)) reply = { content: '', tool_calls: [{ id: `discover-${executorCalls}`, type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, limit: 16 }) } }] }
        else reply = planReply({ stepId: getActivePlan(memory.planningState(KEY)).steps[0].step_id,
          operations: [{ name: 'move_items_exact', args: { unit_number: setup.cells[executorCalls === 2 ? 0 : 1].target.unit_number,
            item_name: facts[executorCalls === 2 ? 0 : 1].product, to_entity: false, max_count: checkpoint.requirements[0].minimum } }] })
      }
      issued.reply = structuredClone(reply); return reply
    }) })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  evidence.result = await agent.request(OBJECTIVE, { sender: 'owner' })
  assert.equal(plannerCalls, 2, JSON.stringify(events.slice(-4))); assert.equal(executorCalls, 4)
  const state = memory.planningState(KEY); const current = getActivePlan(state)
  assert.equal(current.plan_version, 2); assert.equal(current.derived_from_plan_id, state.plans[0].plan_id)
  assert.equal(state.goal.objective, OBJECTIVE); assert.ok(state.plans.every(plan => plan.goal_id === state.goal.goal_id))
  assert.equal(state.plans[0].steps[0].description, 'Produce iron using the existing pair')
  assert.deepEqual(memory.getFactoryRegistry().cells[0], copper)
  assert.equal(events.filter(row => row.event === 'factory_cell.recovery_started').length, 1)
  assert.equal(events.filter(row => row.event === 'fixture.factory_commit_prevention_bypassed').length, 1)
  assert.equal(events.filter(row => row.event === 'operations.admit').length, 1, 'wrong copper action must remain completely unsent')
  const deadline = Date.now() + 120000
  for (;;) {
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) {
      await agent.taskStatusReceipt(); assert.equal(memory.pendingOperations(KEY).length, 0); evidence.settlement = status; break
    }
    assert.ok(Date.now() < deadline, 'native collection timeout'); await delay(100)
  }
  evidence.progress = await sample()
  assert.ok(evidence.progress.actor_inventory.iron >= checkpoint.requirements[0].minimum, JSON.stringify(evidence.progress))
  assert.equal(evidence.progress.actor_inventory.copper, 0)
  assert.ok(evidence.progress.cells[0].output >= evidence.initial_production.cells[0].output, 'wrong copper withdrawal remained unsent')
  assert.ok(evidence.progress.cells[1].products_finished > facts[1].seededCycles)
  assert.equal(evidence.progress.cells[0].drop_target, setup.cells[0].target.unit_number)
  assert.equal(evidence.progress.cells[0].recipe, facts[0].recipe.name)
  assert.equal(evidence.progress.cells[1].drop_target, setup.cells[1].target.unit_number)
  assert.equal(evidence.progress.cells[1].recipe, facts[1].recipe.name)
  assert.equal(evidence.progress.humans, 0); assert.equal(evidence.progress.speed, 1); assert.equal(evidence.providers, 0)
  evidence.final_snapshot = memory.snapshot()
  assert.equal(evidence.final_snapshot.factory_use_recovery.records[0].attempts.length, 1)
  await agent.persistState({ strict: true })
  evidence.status = 'pass'
  console.log('PASS: real shared refusal -> same-goal authorized successor -> automatic native iron inventory gain from productive assigned supplier; copper preserved')
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  if (connection) { try { evidence.final_native = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))') } catch (error) { evidence.final_native_error = String(error) } connection.close() }
  await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'recovery.json'), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, 'transcript.json'), JSON.stringify(transcript, null, 2)); await fs.writeFile(path.join(results, 'events.json'), JSON.stringify(events, null, 2))
  await fs.writeFile(path.join(results, 'scripted-replies.json'), JSON.stringify(replies, null, 2))
}
