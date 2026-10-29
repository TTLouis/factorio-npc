import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { answersStepContract, planReply } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import { createProductionTask } from '../pterodactyl/runtime-v8/production-task.mjs'
import { materialOwnerKey } from '../pterodactyl/runtime-v8/material-ledger.mjs'
import { compileObligations, preservationGeometry, preservedProofMatches } from '../pterodactyl/runtime-v8/contract-obligations.mjs'

globalThis.fetch = async () => { throw new Error('No live inference in deterministic native proof') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', scope: 'New deterministic native fixture, target three copper plates; narrower than original BG science10 replay. Original preserved route replay remains in bg-production-binding.test.mjs.', transcript: [], events: [] }
let connection, agent, placedUnit
let fixtureUnits = []
const rcon = { command: async command => {
  const response = await connection.command(command)
  evidence.transcript.push({ command, response })
  return response
} }
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a;for _,s in pairs(game.surfaces) do local c=s.find_entities_filtered{name="character"};if #c>0 then a=c[1];break end end;assert(a);${body}`))
async function idle() {
  const until = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) return status
    assert.ok(Date.now() < until, 'native work timed out'); await delay(100)
  }
}
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); await connection.connect()
  evidence.factorio_version = JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json', 'utf8')).version
  assert.equal(evidence.factorio_version, '2.0.77')
  await configureNpcSession(rcon, 'bg-producer-binding-native-offline')
  const recipes = await tool('getRecipeDetails', { item_or_recipe: 'copper-plate', requested_count: 1 })
  const recipe = recipes.recipes.find(row => row.name === 'copper-plate')
  assert.equal(recipe.enabled, true)
  const output = recipe.products.find(row => row.name === 'copper-plate')
  const input = recipe.ingredients.find(row => row.type !== 'fluid')
  assert.equal(recipe.ingredients.length, 1); assert.ok(input && output && output.amount > 0)
  const crafts = Math.ceil(3 / output.amount)
  const machine = recipe.crafting_machines.find(row => row.name === 'stone-furnace')
  assert.ok(machine)
  const fuels = recipes.burner_fuels.items.filter(row => machine.fuel_categories.includes(row.category) && row.fuel_value > 0)
  const fuel = fuels.find(row => row.name === 'coal'); assert.ok(fuel)
  const fuelCount = Math.max(1, Math.ceil(crafts * recipe.energy * machine.energy_watts / (machine.crafting_speed * machine.burner_effectivity * fuel.fuel_value)) + 1)
  evidence.live_recipe = { recipe, fuel, crafts, fuelCount }
  const setup = await lua(`local s=a.surface;local x=math.floor(a.position.x)+4;local y=math.floor(a.position.y)+4;game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{x-15,y-5},{x+3,y+5}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={};for tx=x-15,x+3 do for ty=y-5,y+5 do tiles[#tiles+1]={name="landfill",position={tx,ty}} end end;s.set_tiles(tiles,true,false,true);
    for tx=x-12,x-8 do for ty=y-2,y+2 do s.create_entity{name="iron-ore",position={tx,ty},amount=1000} end end;
    local d=s.create_entity{name="burner-mining-drill",position={x-10,y},direction=defines.direction.east,force=a.force};assert(d);
    local f=s.create_entity{name="stone-furnace",position=d.drop_position,force=a.force};assert(f);d.insert{name=${JSON.stringify(fuel.name)},count=5};f.insert{name=${JSON.stringify(fuel.name)},count=5};
    a.get_main_inventory().clear();a.insert{name="stone-furnace",count=1};a.insert{name=${JSON.stringify(input.name)},count=${input.amount * crafts}};a.insert{name=${JSON.stringify(fuel.name)},count=${fuelCount}};
    remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100);
    rcon.print(helpers.table_to_json({x=x,y=y,drill=d.unit_number,old_furnace=f.unit_number,actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(setup.humans, 0); assert.equal(setup.speed, 1); evidence.setup = setup
  fixtureUnits = [setup.drill, setup.old_furnace]
  let route
  for (let n = 0; n < 150; n++) {
    route = await tool('getEntityGeometry', { unit_number: setup.drill })
    if (route.item_io?.drop_target?.unit_number === setup.old_furnace && (await tool('getEntityStatus', { unit_number: setup.old_furnace })).entity?.working) break
    await delay(100)
  }
  assert.equal(route.item_io?.drop_target?.unit_number, setup.old_furnace)
  assert.equal((await tool('getEntityStatus', { unit_number: setup.old_furnace })).entity.working, true)
  const originalRoute = preservationGeometry(route, setup.drill)
  evidence.original_route = originalRoute
  const memory = new CanonicalTaskBoardMemory(); const key = 'npc:bg-producer-native'; let calls = 0
  const intent = { targets: [{ item_name: 'copper-plate', count: 3 }] }
  agent = new NpcAgentLoop({ memory, rcon, npcId: 'bg-producer-native', completionProtocolVersion: 3,
    requireTypedObligations: true, stateFile: path.join(results, 'bg-producer-native-state.json'), traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Offline deterministic producer recovery fixture.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      if (context.role === 'planner') {
        const journal = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')
        assert.ok(Number.isSafeInteger(journal.high_water))
        memory.planningState(key).operation_ledger = { sequence: journal.high_water, records: [], closed: [] }
        const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 3 }] }
        const obligations = { outcome: checkpoint, preserve: fixtureUnits.slice().sort((a, b) => a - b) }
        return planReply({ plan: ['Use native smelting to hold three copper plates while preserving the existing iron route.'], currentStep: 0, operations: [],
          goal: { scope: 'finite', summary: 'Hold three copper plates using a newly placed native furnace.', doneWhen: checkpoint.requirements },
          stepCompletions: [{ kind: 'deterministic', checkpoint: compileObligations(obligations), obligations }],
          executionGuidance: [{ approach: 'Use current native recipe facts and preserve exact machine ownership.', rationale: 'Finite native production proof.', constraints: [], skillIds: [], materialSupply: null }] })
      }
      const plan = getActivePlan(memory.planningState(key)); const stepId = plan.steps[0].step_id
      calls++
      if (calls === 1) {
        // Deliberately bypass new-intent prevention, as if this target-only
        // record was restored from the old runtime. Only the ledger is injected;
        // no machine ownership or game result is manufactured.
        const owner = { goal_id: plan.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version, step_id: stepId }
        memory.productionTasks ??= new Map()
        memory.productionTasks.set(`${key}/${materialOwnerKey(owner)}`, createProductionTask({ intent, owner, actor_id: agent.epoch.actor_id, epoch: agent.epoch.epoch }))
        return planReply({ stepId, operations: [], productionTask: intent })
      }
      if (calls === 2) return planReply({ stepId, operations: [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: setup.x, y: setup.y } }] })
      assert.equal(calls, 3, 'unexpected extra executor correction')
      const placement = memory.authorizationState(key).world.npc_placements.find(row => row.entity_name === 'stone-furnace')
      assert.ok(placement, 'must ingest real placement receipt before fueling')
      placedUnit = placement.unit_number; evidence.placement_provenance = structuredClone(placement)
      return planReply({ stepId, operations: [{ name: 'supply_entity', args: { unit_number: placedUnit, items: [{ item_name: fuel.name, count: fuelCount }] } }] })
    }) })
  agent.behaviorTrace = { emit: async row => { evidence.events.push(row) } }
  await agent.request('Hold three copper plates using a newly placed native furnace.', { sender: 'Louis' })
  const originalSteps = structuredClone(getActivePlan(memory.planningState(key)).steps)
  const deadline = Date.now() + 180000
  while (memory.planningState(key).goal.status !== 'completed') {
    assert.ok(Date.now() < deadline, 'producer proof timed out')
    await idle(); await agent.completed()
    assert.equal(memory.pauseRecord(key)?.paused ?? false, false, JSON.stringify(evidence.events.slice(-8)))
  }
  assert.equal(await lua('rcon.print(a.get_item_count("copper-plate"))'), 3)
  assert.equal(calls, 3)
  const recovered = evidence.events.filter(row => row.event === 'production.recovery' && row.data.mechanism === 'exact_producer_binding' && row.data.outcome === 'reconcile')
  assert.equal(recovered.length, 1)
  assert.deepEqual(recovered[0].data.bindings, [{ recipe_name: 'copper-plate', unit_number: placedUnit }])
  assert.equal(recovered[0].data.recovery, 2)
  assert.deepEqual(getActivePlan(memory.planningState(key)).steps, originalSteps)
  const finalRoute = preservationGeometry(await tool('getEntityGeometry', { unit_number: setup.drill }), setup.drill)
  assert.equal(preservedProofMatches({ preserved: [originalRoute] }, { preserved: [finalRoute] }), true)
  evidence.final_route = finalRoute
  // Automatic furnaces clear their recipe between input deliveries. Prove
  // continued native iron output over a bounded read-only interval instead of
  // requiring one instantaneous working/recipe sample at goal completion.
  evidence.preserved_output_samples = []
  const outputDeadline = Date.now() + 15000
  let initialIronOutput
  let finalIronOutput
  for (let sample = 0; sample < 61; sample++) {
    const preservedMachine = await tool('getEntityStatus', { unit_number: setup.old_furnace })
    evidence.preserved_output_samples.push({ elapsed_ms: Date.now() - (outputDeadline - 15000), status: preservedMachine })
    const entity = preservedMachine.entity
    const expected = originalRoute.item_io.drop_target
    assert.equal(preservedMachine.found, true)
    assert.equal(preservedMachine.surface_index, originalRoute.surface_index)
    assert.equal(preservedMachine.force_index, originalRoute.force_index)
    for (const field of ['unit_number', 'name', 'type', 'position', 'direction']) assert.deepEqual(entity[field], expected[field])
    assert.equal(entity.inventories_truncated, false)
    assert.equal(entity.inventory_items_truncated, false)
    assert.ok(entity.recipe === undefined || entity.recipe === 'iron-plate')
    const rawItems = entity.inventories.find(row => row.index === 3)?.items
    assert.ok(Array.isArray(rawItems) || rawItems && typeof rawItems === 'object' && Object.keys(rawItems).length === 0)
    const items = Array.isArray(rawItems) ? rawItems : []
    assert.ok(items.every(item => item.name === 'iron-plate' && Number.isSafeInteger(item.count) && item.count > 0))
    finalIronOutput = items.reduce((count, item) => count + item.count, 0)
    initialIronOutput ??= finalIronOutput
    assert.ok(finalIronOutput >= initialIronOutput, 'preserved output unexpectedly removed')
    if (finalIronOutput > initialIronOutput) {
      evidence.preserved_furnace = preservedMachine
      break
    }
    assert.ok(Date.now() < outputDeadline && sample < 60, 'preserved route produced no further iron output within bounded observation')
    await delay(250)
  }
  evidence.preserved_output_progress = { item_name: 'iron-plate', initial: initialIronOutput, final: finalIronOutput }
  const afterOutputRoute = preservationGeometry(await tool('getEntityGeometry', { unit_number: setup.drill }), setup.drill)
  assert.equal(preservedProofMatches({ preserved: [originalRoute] }, { preserved: [afterOutputRoute] }), true)
  evidence.final_route = afterOutputRoute
  evidence.final_inventory_raw = await rcon.command(toolCommand('getInventoryItems', {})); evidence.final_status = await idle()
  evidence.status = 'pass'
  console.log('PASS native BG producer setup -> real placement provenance -> bounded binding -> native smelting/collection -> exact inventory checkpoint')
} finally {
  agent?.cancel('fixture_cleanup')
  if (connection) {
    for (const unit of [...fixtureUnits, placedUnit].filter(Number.isSafeInteger)) try { await lua(`local e=game.get_entity_by_unit_number(${unit});if e and e.valid then e.destroy() end;rcon.print("{}")`) } catch (error) { evidence.cleanup_error = error.message }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'bg-producer-recovery.json'), JSON.stringify(evidence, null, 2))
}
