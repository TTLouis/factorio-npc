#!/usr/bin/env node
// Exact-version isolated canary, with scripted messages only. Parent owns the
// fresh server, native build, final save/load proof, resource ledger and teardown.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i >= 0) return process.argv[i + 1]; assert.notEqual(fallback, undefined, `missing --${name}`); return fallback }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon, confirmLuaConsoleReady } = await load('runtime-v8/common.mjs')
const { toolCommand, luaString } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { getActivePlan } = await load('runtime-v8/planning-state.mjs')
const { answersStepContract, planReply } = await load('runtime-v8/task-loop-fixtures.mjs')
const KEY = 'npc:cross-step-native'
const evidence = { status: 'failed', providers: 0, scripted_replies: 0, kind: 'finite_cross_step_native_canary',
  fixture: 'One held furnace and native-derived input/fuel seeded into an isolated actor. Terrain cleared only during declared setup. Placement, step verification, enrollment, supply, wait and collection use the actual harness/native operations. No automated-production claim.' }
const transcript = []; const events = []; const issued = []
let connection; let agent
globalThis.fetch = async () => { evidence.providers++; throw new Error('External inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
try {
  await fs.mkdir(results, { recursive: true })
  await assert.rejects(fs.access(path.join(results, 'canary.json')), 'Never overwrite prior proof')
  connection = new Rcon(Number(arg('port')), 'offline-fixture-only', 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  evidence.handshake = await confirmLuaConsoleReady(rcon)
  await lua('assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;rcon.print("{}")')
  await configureNpcSession(rcon, 'cross-step-native-20261031')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
  assert.equal(world.ok, true); evidence.world_id = world.world_id
  const detail = await tool('getRecipeDetails', { item_or_recipe: 'copper-plate', requested_count: 1 })
  const recipe = detail.recipes?.find(row => row.name === 'copper-plate')
  assert.equal(detail.truncated, false); assert.equal(recipe?.enabled, true)
  assert.equal(recipe.ingredients.length, 1); assert.equal(recipe.products.length, 1)
  const input = recipe.ingredients[0]; const output = recipe.products[0]
  assert.equal(input.type, 'item'); assert.equal(output.type, 'item')
  assert.ok(input.amount > 0 && output.amount > 0 && (output.probability === undefined || output.probability === 1))
  const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace'); assert.ok(machine)
  const fuel = detail.burner_fuels.items.find(row => machine.fuel_categories.includes(row.category) && row.fuel_value > 0); assert.ok(fuel)
  const fuelCount = Math.max(1, Math.ceil(recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 1)
  assert.ok(Number.isSafeInteger(fuelCount) && fuelCount <= 10)
  evidence.live_facts = { detail, fuel, fuelCount }
  evidence.setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y)
    for _,e in pairs(s.find_entities_filtered{area={{x-10,y-10},{x+10,y+10}}})do if e~=a and e.name~="sgluna-npc-vision"then e.destroy()end end
    local tiles={};for xx=x-10,x+10 do for yy=y-10,y+10 do tiles[#tiles+1]={name="landfill",position={xx,yy}}end end;s.set_tiles(tiles,true,false,true)
    local inv=a.get_main_inventory();inv.clear();assert(inv.insert{name="stone-furnace",count=1}==1);assert(inv.insert{name=${luaString(input.name)},count=${input.amount}}==${input.amount});assert(inv.insert{name=${luaString(fuel.name)},count=${fuelCount}}==${fuelCount})
    rcon.print(helpers.table_to_json({x=x+4,y=y,surface_index=s.index,force_index=a.force.index,tick=game.tick,humans=#game.connected_players}))`)
  const memory = new CanonicalTaskBoardMemory(); memory.initializeFactoryRegistry(world.world_id)
  const stateFile = path.join(results, 'canonical-state.json')
  const inventoryContract = { mode: 'all', requirements: [{ id: 'finite-product', kind: 'inventory_count', item_name: output.name, minimum: output.amount }] }
  const guidance = { approach: 'Use exact retained placement and current native recipe evidence.', rationale: 'Finite bootstrap on the same immutable goal.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: input.name } }
  const objective = `Place the held furnace, then produce and collect ${output.amount} ${output.name}.`
  let planner = 0; let executor = 0
  const scripted = answersStepContract(async (_messages, context) => {
    if (context.role === 'planner') {
      assert.equal(++planner, 1)
      return planReply({ plan: ['Place the held furnace', 'Produce and collect the finite product'], operations: [],
        goal: { scope: 'finite', summary: objective, doneWhen: inventoryContract.requirements }, executionGuidance: [guidance, guidance],
        stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ id: 'placed', kind: 'entity_count', prototype: 'stone-furnace', minimum: 1 }] } },
          { kind: 'deterministic', checkpoint: inventoryContract }] })
    }
    assert.ok(++executor <= 2, 'No model retry or correction permitted')
    const plan = getActivePlan(memory.planningState(KEY)); const step = plan.steps[plan.active_step_index]
    if (plan.active_step_index === 0) return planReply({ stepId: step.step_id, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: evidence.setup.x, y: evidence.setup.y } }] })
    const receipts = memory.snapshot().factory_placement_receipts
    assert.equal(receipts.length, 1); const receipt = receipts[0]
    assert.notEqual(receipt.semantic_step_id, step.semantic_step_id ?? step.step_id)
    assert.equal(plan.execution.step_progress[receipt.step_id].status, 'completed')
    evidence.retained_placement = structuredClone(receipt)
    return planReply({ stepId: step.step_id, operations: [], productionTask: { targets: [{ item_name: output.name, count: output.amount }],
      producers: [{ recipe_name: recipe.name, unit_number: receipt.unit_number }], fuel: { item_name: fuel.name, count: fuelCount } } })
  })
  agent = new NpcAgentLoop({ rcon, memory, npcId: 'cross-step-native', completionProtocolVersion: 3, jevCheckpoints: false,
    stateFile, traceFile: null, decisionTraceFile: null, systemPrompt: 'Scripted offline native canary.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: async (messages, context) => { const row = { role: context.role, trigger: context.triggerSource, messages: structuredClone(messages) }; issued.push(row)
      row.reply = await scripted(messages, context); evidence.scripted_replies++; return row.reply } })
  agent.behaviorTrace = { emit: async row => events.push(row) }
  await lua('game.tick_paused=false;rcon.print("{}")')
  await agent.request(objective, { sender: 'owner' })
  const deadline = Date.now() + 180000
  while (memory.planningState(KEY)?.goal?.status !== 'completed') {
    assert.ok(Date.now() < deadline, 'Bounded native finite-production timeout')
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) await agent.completed()
    assert.notEqual(memory.pauseRecord(KEY)?.paused, true, JSON.stringify(events.slice(-5)))
    await delay(100)
  }
  const cells = memory.getFactoryRegistry().cells
  assert.equal(cells.length, 1); assert.equal(cells[0].members[0].unit_number, evidence.retained_placement.unit_number)
  assert.equal(cells[0].members[0].provenance.semantic_step_id, evidence.retained_placement.semantic_step_id)
  assert.notEqual(cells[0].origin.semantic_step_id, evidence.retained_placement.semantic_step_id)
  assert.deepEqual(memory.snapshot().factory_placement_receipts, [evidence.retained_placement])
  assert.equal(events.filter(row => row.event === 'factory_cell.enrolled_from_production').length, 1)
  assert.equal(events.filter(row => row.event === 'factory_cell.enrollment_recovery_started').length, 0, 'Normal prevention spends no residual allowance')
  evidence.native_product = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});local f=game.get_entity_by_unit_number(${evidence.retained_placement.unit_number});assert(a and f);rcon.print(helpers.table_to_json({held=a.get_main_inventory().get_item_count(${luaString(output.name)}),products_finished=f.products_finished,recipe=f.get_recipe() and f.get_recipe().name,recipe_selected=f.get_recipe()~=nil,speed=game.speed,humans=#game.connected_players}))`)
  evidence.native_product.expected_recipe = recipe.name
  evidence.native_product.output_item = output.name
  evidence.native_product.recipe ??= null // Actual unselected native recipe, not expected assignment.
  assert.ok(evidence.native_product.held >= output.amount); assert.ok(evidence.native_product.products_finished > 0)
  assert.ok(evidence.native_product.recipe_selected === false || evidence.native_product.recipe === recipe.name); assert.equal(evidence.native_product.speed, 1); assert.equal(evidence.native_product.humans, 0)
  await agent.persistState({ strict: true })
  const restored = new CanonicalTaskBoardMemory(); restored.restore(JSON.parse(await fs.readFile(stateFile, 'utf8')))
  assert.deepEqual(restored.getFactoryRegistry(), memory.getFactoryRegistry())
  assert.deepEqual(restored.snapshot().factory_placement_receipts, memory.snapshot().factory_placement_receipts)
  assert.deepEqual(restored.planningState(KEY), memory.planningState(KEY))
  evidence.final_snapshot = memory.snapshot(); assert.equal(evidence.providers, 0); evidence.status = 'passed'
} catch (error) { evidence.error = String(error?.stack ?? error); process.exitCode = 1 }
finally {
  if (connection) {
    try {
      if (agent) { agent.active = false; agent.generation++ }
      evidence.final_native = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))')
      evidence.final_task = await tool('getTaskStatus')
      assert.equal(evidence.final_native.paused, true); assert.equal(evidence.final_native.speed, 1); assert.equal(evidence.final_native.humans, 0)
      assert.equal(evidence.final_task.task_state, 'idle'); assert.equal(evidence.final_task.queue_length, 0); assert.ok(!evidence.final_task.active_batch)
    } catch (error) { evidence.status = 'failed'; evidence.final_error = String(error); process.exitCode = 1 }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true })
  for (const [name, value] of [['canary', evidence], ['transcript', transcript], ['events', events], ['scripted-replies', issued]]) await fs.writeFile(path.join(results, `${name}.json`), JSON.stringify(value, null, 2))
  console.log(JSON.stringify({ status: evidence.status, providers: evidence.providers, scripted_replies: evidence.scripted_replies }))
}
