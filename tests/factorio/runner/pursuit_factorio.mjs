// Deterministic native integration lane. No provider credentials or inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession } from '../pterodactyl/runtime-v8/supervisor-adapter.mjs'
import { PursuitRuntime } from '../pterodactyl/runtime-v8/pursuit-runtime.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
const commands = []
const calls = []
const rcon = { command: async (command, options) => {
  const response = await connection.command(command, options)
  commands.push({ command, response })
  return response
} }
const goal = minimum => ({ objective: `Hand-craft and hold ${minimum} iron gear wheels.`, predicate: {
  scope: 'finite', summary: `Hold ${minimum} iron gear wheels.`, doneWhen: [
    { kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum },
  ] } })

async function settle(agent) {
  const until = Date.now() + 90000
  while (agent.active && Date.now() < until) { await delay(500); await agent.pollPursuit() }
  assert.equal(agent.loop.state.status, 'completed', agent.loop.state.pauseReason)
}

try {
  await fsp.mkdir(results, { recursive: true })
  await connection.connect()
  await configureNpcSession(rcon, 'pursuit-engine-fixture-0001')
  // Declared fixture once. Native hand crafting consumes these four plates.
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); game.speed=1; a.get_inventory(defines.inventory.character_main).clear(); local added=a.insert{name="iron-plate",count=4}; rcon.print(helpers.table_to_json({added=added,connected_players=#game.connected_players,speed=game.speed}))'))
  assert.equal(setup.added, 4)
  assert.equal(setup.connected_players, 0)
  assert.equal(setup.speed, 1)
  // A missing local resource is a pre-dispatch refusal, not an admitted batch
  // that immediately cancels navigation and loses its effect certainty.
  const missingSource = JSON.parse(await rcon.command('/silent-command local before=remote.call("autorio_operations","status"); local result=remote.call("autorio_preflight","operation","gather_resource",{resource_name="uranium-ore",count=75,search_radius=1}); local after=remote.call("autorio_operations","status"); rcon.print(helpers.table_to_json({result=result,before=before,after=after}))'))
  assert.equal(missingSource.result.ok, false)
  assert.equal(missingSource.result.code, 'resource_source_not_found')
  assert.equal(missingSource.before.queue_length, missingSource.after.queue_length)
  assert.equal(missingSource.before.task_state, missingSource.after.task_state)
  const missingNavigation = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local before=remote.call("autorio_operations","status"); local p={x=a.position.x,y=a.position.y}; local result=remote.call("autorio_preflight","operation","walk_to_entity",{entity_name="uranium-ore",search_radius=1}); local after=remote.call("autorio_operations","status"); rcon.print(helpers.table_to_json({result=result,before=before,after=after,position_before=p,position_after=a.position}))'))
  assert.equal(missingNavigation.result.ok, false)
  assert.equal(missingNavigation.result.code, 'navigation_target_not_found')
  assert.equal(missingNavigation.before.queue_length, missingNavigation.after.queue_length)
  assert.equal(missingNavigation.before.task_state, missingNavigation.after.task_state)
  assert.deepEqual(missingNavigation.position_before, missingNavigation.position_after)
  const furnaceCollision = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+3,a.position.y},16,0.5); assert(p); local e=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(e); local before=remote.call("autorio_operations","status"); local tight=remote.call("autorio_preflight","operation","walk_to_position",{x=e.position.x,y=e.position.y,reach_distance=0.75}); local wide=remote.call("autorio_preflight","operation","walk_to_position",{x=e.position.x,y=e.position.y,reach_distance=2}); local after=remote.call("autorio_operations","status"); local result={tight=tight,wide=wide,position_requested=p,position_actual=e.position,before=before,after=after,humans=#game.connected_players,speed=game.speed}; assert(e.destroy()); rcon.print(helpers.table_to_json(result))'))
  await fsp.writeFile(path.join(results, 'furnace-collision-preflight.json'), JSON.stringify(furnaceCollision, null, 2))
  assert.equal(furnaceCollision.tight.ok, false)
  assert.equal(furnaceCollision.tight.code, 'navigation_position_inside_furnace_collision')
  assert(furnaceCollision.tight.minimum_collision_clearance > 0.75)
  assert.equal(furnaceCollision.wide.ok, true)
  assert.equal(furnaceCollision.before.queue_length, furnaceCollision.after.queue_length)
  assert.equal(furnaceCollision.before.task_state, furnaceCollision.after.task_state)
  assert.deepEqual(furnaceCollision.before.actor.position, furnaceCollision.after.actor.position)
  assert.equal(furnaceCollision.humans, 0)
  assert.equal(furnaceCollision.speed, 1)
  // Replay the live supply -> furnace recipe -> wait finding with scripted
  // decisions and declared fixture stock. Preflight must refuse the whole batch
  // while the actor still holds every item and no native ordinal is reserved.
  const recipeSetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+3,a.position.y},16,0.5); assert(p); local e=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(e); storage.pursuit_recipe_furnace=e; remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); assert(a.insert{name="wood",count=22}==22); assert(a.insert{name="iron-ore",count=12}==12); assert(a.insert{name="copper-ore",count=75}==75); local input=e.get_inventory(defines.inventory.furnace_source); rcon.print(helpers.table_to_json({unit_number=e.unit_number,input_slots=#input,iron_room=input.get_insertable_count{name="iron-ore"},copper_room=input.get_insertable_count{name="copper-ore"},inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status")}))'))
  let recipeCalls = 0
  const recipeGuard = new PursuitRuntime({ rcon, stateFile: path.join(results, 'recipe-guard-state.json'),
    traceFile: path.join(results, 'recipe-guard-trace.jsonl'), provider: async messages => {
      if (++recipeCalls === 1) return { content: JSON.stringify({ operations: [
        { name: 'supply_entity', args: { unit_number: recipeSetup.unit_number, items: [
          { item_name: 'wood', count: 22 }, { item_name: 'iron-ore', count: 12 }, { item_name: 'copper-ore', count: 75 } ] } },
        { name: 'set_machine_recipe', args: { unit_number: recipeSetup.unit_number, recipe_name: 'iron-plate' } },
        { name: 'wait', args: { ticks: 1200 } },
      ] }) }
      const refusal = JSON.parse(JSON.parse(messages[1].content).observations.find(row => row.name === 'admission').result)
      assert.equal(refusal.code, 'not_recipe_machine'); assert.equal(refusal.operation_index, 1)
      assert.equal(refusal.observed_type, 'furnace')
      return { content: JSON.stringify({ pauseReason: 'Fixture intentionally ends after verifying the pre-dispatch refusal.' }) }
    } })
  await recipeGuard.request(JSON.stringify(goal(1)))
  assert.equal(recipeCalls, 2)
  assert.equal(recipeGuard.loop.state.status, 'paused')
  assert.equal(recipeGuard.loop.state.budget.calls, 2)
  assert.equal(recipeGuard.loop.state.pending, null)
  assert.equal(recipeGuard.loop.state.ordinal, recipeSetup.admission.high_water)
  const recipeFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local e=storage.pursuit_recipe_furnace; local result={inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status"),fuel=e.get_fuel_inventory().get_item_count("wood"),iron=e.get_inventory(defines.inventory.furnace_source).get_item_count("iron-ore"),humans=#game.connected_players,speed=game.speed}; assert(e.destroy()); rcon.print(helpers.table_to_json(result))'))
  assert.deepEqual(recipeFinal.inventory, recipeSetup.inventory)
  assert.equal(recipeFinal.operations.queue_length, recipeSetup.operations.queue_length)
  assert.equal(recipeFinal.operations.tasks_added, recipeSetup.operations.tasks_added)
  assert.equal(recipeFinal.operations.task_state, recipeSetup.operations.task_state)
  assert.deepEqual(recipeFinal.operations.actor.position, recipeSetup.operations.actor.position)
  assert.deepEqual(recipeFinal.admission, recipeSetup.admission)
  assert.equal(recipeFinal.fuel, 0); assert.equal(recipeFinal.iron, 0)
  assert.equal(recipeFinal.humans, 0); assert.equal(recipeFinal.speed, 1)
  const recipeTrace = (await fsp.readFile(path.join(results, 'recipe-guard-trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert(recipeTrace.some(row => row.event === 'pursuit.admission_refused' && row.request_id === recipeGuard.loop.state.request_id
    && row.admission.code === 'not_recipe_machine'))
  assert.equal(recipeSetup.input_slots, 1)
  assert(recipeSetup.iron_room > 0 && recipeSetup.copper_room > 0)
  // Independent native capacity probe: individual empty-slot capacities do
  // not promise that two different ores can be supplied together. Keep the
  // existing partial-transfer execution policy and report the engine facts.
  const recipeCapabilities = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+3,a.position.y},16,0.5); assert(p); local e=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(e); local input=e.get_inventory(defines.inventory.furnace_source); assert(input.insert{name="iron-ore",count=12}==12); local mixed={iron=input.get_item_count("iron-ore"),copper_can_insert=input.can_insert{name="copper-ore"},copper_room=input.get_insertable_count{name="copper-ore"}}; assert(e.destroy()); local p2=a.surface.find_non_colliding_position("assembling-machine-1",p,16,0.5); assert(p2); local m=a.surface.create_entity{name="assembling-machine-1",position=p2,force=a.force}; assert(m); remote.call("autorio_tools","get_nearby_entities",32,"assembling-machine-1","assembling-machine",16); local recipe=remote.call("autorio_preflight","operation","set_machine_recipe",{unit_number=m.unit_number,recipe_name="iron-gear-wheel"}); assert(m.destroy()); rcon.print(helpers.table_to_json({mixed=mixed,assembler_recipe=recipe}))'))
  assert.equal(recipeCapabilities.mixed.iron, 12)
  assert.equal(recipeCapabilities.mixed.copper_can_insert, false)
  assert.equal(recipeCapabilities.mixed.copper_room, 0)
  assert.equal(recipeCapabilities.assembler_recipe.ok, true)
  assert.equal(recipeCapabilities.assembler_recipe.target.name, 'assembling-machine-1')
  await fsp.writeFile(path.join(results, 'recipe-guard-evidence.json'), JSON.stringify({ setup: recipeSetup, final: recipeFinal,
    capabilities: recipeCapabilities, state: recipeGuard.loop.snapshot(), trace: recipeTrace }, null, 2))
  // The next live finding supplied available iron followed by absent coal.
  // Native item_missing cancels the batch; preflight must prevent even the
  // earlier iron transfer, while permitting a new charged model decision.
  const missingSupplySetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a.get_item_count("coal")==0); local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+3,a.position.y},16,0.5); assert(p); local e=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(e); storage.pursuit_missing_supply_furnace=e; remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); rcon.print(helpers.table_to_json({unit_number=e.unit_number,inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status")}))'))
  let missingSupplyCalls = 0
  const missingSupply = new PursuitRuntime({ rcon, stateFile: path.join(results, 'missing-supply-state.json'),
    traceFile: path.join(results, 'missing-supply-trace.jsonl'), provider: async messages => {
      if (++missingSupplyCalls === 1) return { content: JSON.stringify({ operations: [
        { name: 'supply_entity', args: { unit_number: missingSupplySetup.unit_number, items: [
          { item_name: 'iron-ore', count: 12 }, { item_name: 'coal', count: 38 } ] } },
        { name: 'wait', args: { ticks: 12000 } },
      ] }) }
      const refusal = JSON.parse(JSON.parse(messages[1].content).observations.find(row => row.name === 'admission').result)
      assert.equal(refusal.code, 'supply_missing'); assert.equal(refusal.operation_index, 0)
      assert.equal(refusal.transfer.items[0].expected_moved, 12)
      assert.equal(refusal.transfer.items[1].source_count, 0)
      return { content: JSON.stringify({ pauseReason: 'Fixture ends after observing the missing-source no-effect refusal.' }) }
    } })
  await missingSupply.request(JSON.stringify(goal(1)))
  assert.equal(missingSupplyCalls, 2)
  assert.equal(missingSupply.loop.state.status, 'paused')
  assert.equal(missingSupply.loop.state.budget.calls, 2)
  assert.equal(missingSupply.loop.state.pending, null)
  assert.equal(missingSupply.loop.state.ordinal, missingSupplySetup.admission.high_water)
  const missingSupplyFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local e=storage.pursuit_missing_supply_furnace; local result={inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status"),iron=e.get_inventory(defines.inventory.furnace_source).get_item_count("iron-ore"),coal=e.get_fuel_inventory().get_item_count("coal"),humans=#game.connected_players,speed=game.speed}; assert(e.destroy()); rcon.print(helpers.table_to_json(result))'))
  assert.deepEqual(missingSupplyFinal.inventory, missingSupplySetup.inventory)
  assert.deepEqual(missingSupplyFinal.admission, missingSupplySetup.admission)
  assert.equal(missingSupplyFinal.operations.queue_length, missingSupplySetup.operations.queue_length)
  assert.equal(missingSupplyFinal.operations.tasks_added, missingSupplySetup.operations.tasks_added)
  assert.equal(missingSupplyFinal.operations.task_state, missingSupplySetup.operations.task_state)
  assert.deepEqual(missingSupplyFinal.operations.actor.position, missingSupplySetup.operations.actor.position)
  assert.equal(missingSupplyFinal.iron, 0); assert.equal(missingSupplyFinal.coal, 0)
  assert.equal(missingSupplyFinal.humans, 0); assert.equal(missingSupplyFinal.speed, 1)
  const missingSupplyTrace = (await fsp.readFile(path.join(results, 'missing-supply-trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert(missingSupplyTrace.some(row => row.event === 'pursuit.admission_refused' && row.request_id === missingSupply.loop.state.request_id
    && row.admission.code === 'supply_missing'))
  await fsp.writeFile(path.join(results, 'missing-supply-evidence.json'), JSON.stringify({ setup: missingSupplySetup, final: missingSupplyFinal,
    state: missingSupply.loop.snapshot(), trace: missingSupplyTrace }, null, 2))
  // Replay occupied iron input plus copper and usable wood from attempt 20.
  // Native refusal taints exact-batch completion; preflight must prevent even the
  // otherwise usable fuel transfer before returning a charged decision.
  const blockedSupplySetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; a.remove_item{name="wood",count=100000}; assert(a.insert{name="wood",count=18}==18); local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+3,a.position.y},16,0.5); assert(p); local e=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(e); assert(e.get_inventory(defines.inventory.furnace_source).insert{name="iron-ore",count=42}==42); storage.pursuit_blocked_supply_furnace=e; remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); rcon.print(helpers.table_to_json({unit_number=e.unit_number,inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status")}))'))
  let blockedSupplyCalls = 0
  const blockedSupply = new PursuitRuntime({ rcon, stateFile: path.join(results, 'blocked-supply-state.json'),
    traceFile: path.join(results, 'blocked-supply-trace.jsonl'), provider: async messages => {
      if (++blockedSupplyCalls === 1) return { content: JSON.stringify({ operations: [
        { name: 'supply_entity', args: { unit_number: blockedSupplySetup.unit_number, items: [
          { item_name: 'copper-ore', count: 75 }, { item_name: 'wood', count: 18 } ] } },
        { name: 'wait', args: { ticks: 12000 } },
      ] }) }
      const refusal = JSON.parse(JSON.parse(messages[1].content).observations.find(row => row.name === 'admission').result)
      assert.equal(refusal.code, 'destination_full'); assert.equal(refusal.operation_index, 0)
      assert.equal(refusal.transfer.items[0].expected_moved, 0); assert.equal(refusal.transfer.items[0].refusal_cause, 'input_slot_holds_other_item')
      assert.equal(refusal.transfer.items[1].expected_moved, 18)
      return { content: JSON.stringify({ pauseReason: 'Fixture ends after observing the occupied-input no-effect refusal.' }) }
    } })
  await blockedSupply.request(JSON.stringify(goal(1)))
  assert.equal(blockedSupplyCalls, 2)
  assert.equal(blockedSupply.loop.state.status, 'paused')
  assert.equal(blockedSupply.loop.state.budget.calls, 2)
  assert.equal(blockedSupply.loop.state.pending, null)
  assert.equal(blockedSupply.loop.state.ordinal, blockedSupplySetup.admission.high_water)
  const blockedSupplyFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local e=storage.pursuit_blocked_supply_furnace; local result={inventory=a.get_inventory(defines.inventory.character_main).get_contents(),operations=remote.call("autorio_operations","status"),admission=remote.call("autorio_operation_admission","status"),iron=e.get_inventory(defines.inventory.furnace_source).get_item_count("iron-ore"),wood=e.get_fuel_inventory().get_item_count("wood"),humans=#game.connected_players,speed=game.speed}; assert(e.destroy()); rcon.print(helpers.table_to_json(result))'))
  assert.deepEqual(blockedSupplyFinal.inventory, blockedSupplySetup.inventory)
  assert.deepEqual(blockedSupplyFinal.admission, blockedSupplySetup.admission)
  assert.equal(blockedSupplyFinal.operations.queue_length, blockedSupplySetup.operations.queue_length)
  assert.equal(blockedSupplyFinal.operations.tasks_added, blockedSupplySetup.operations.tasks_added)
  assert.equal(blockedSupplyFinal.operations.task_state, blockedSupplySetup.operations.task_state)
  assert.deepEqual(blockedSupplyFinal.operations.actor.position, blockedSupplySetup.operations.actor.position)
  assert.equal(blockedSupplyFinal.iron, 42); assert.equal(blockedSupplyFinal.wood, 0)
  assert.equal(blockedSupplyFinal.humans, 0); assert.equal(blockedSupplyFinal.speed, 1)
  const blockedSupplyTrace = (await fsp.readFile(path.join(results, 'blocked-supply-trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert(blockedSupplyTrace.some(row => row.event === 'pursuit.admission_refused' && row.request_id === blockedSupply.loop.state.request_id
    && row.admission.code === 'destination_full'))
  await fsp.writeFile(path.join(results, 'blocked-supply-evidence.json'), JSON.stringify({ setup: blockedSupplySetup, final: blockedSupplyFinal,
    state: blockedSupply.loop.snapshot(), trace: blockedSupplyTrace }, null, 2))
  const options = { rcon, stateFile: path.join(results, 'pursuit-state.json'), traceFile: path.join(results, 'pursuit-trace.jsonl'),
    campaignBudget: { maxCalls: 500, maxInputChars: 50000000, maxWallMs: 3600000 },
    provider: async (messages, context) => {
      calls.push({ messages, controlProtocol: context.controlProtocol })
      assert.equal(context.controlProtocol, 'pursuit')
      if (calls.length === 1) return { content: JSON.stringify({
        operations: [{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }],
        observations: [{ name: 'getInventoryItems', args: {} }] }) }
      if (calls.length === 2) {
        assert.match(messages[1].content, /one_decision_kind_required/)
        return { content: JSON.stringify({ observations: [{ name: 'getNearbyEntities', args: { radius: 128 } }] }) }
      }
      if (calls.length === 3) {
        assert.match(messages[1].content, /radius must be an integer from 1 to 64/)
        return { content: JSON.stringify({ observations: [{ name: 'getRecipeDetails', args: { item_or_recipe: 'iron-gear-wheel', requested_count: 1 } }] }) }
      }
      if (calls.length === 4) {
        assert(JSON.parse(messages[1].content).recipeKnowledge.some(fact => fact.name === 'iron-gear-wheel' && fact.complete))
        return { content: JSON.stringify({ operations: [{ name: 'gather_resource', args: { resource_name: 'uranium-ore', count: 75, search_radius: 1 } }] }) }
      }
      if (calls.length === 5) {
        const packet = JSON.parse(messages[1].content)
        assert(packet.observations.some(row => row.name === 'getRecipeDetails' && row.historical === true))
        const refusal = packet.observations.find(row => row.name === 'admission')
        assert.equal(refusal.historical, false)
        assert.equal(JSON.parse(refusal.result).code, 'resource_source_not_found')
      }
      return { content: JSON.stringify({ notes: 'Native hand crafting.', operations: [{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }] }) }
    } }
  const first = new PursuitRuntime(options)
  await first.request(JSON.stringify(goal(1)))
  await settle(first)
  assert.equal(first.loop.state.budget.calls, 5)
  assert.equal(first.loop.state.budget.maxCalls, 500)
  assert.equal(first.loop.state.budget.maxInputChars, 50000000)
  assert.equal(first.loop.state.budget.maxWallMs, 3600000)
  assert(first.loop.state.recipeKnowledge.some(fact => fact.name === 'iron-gear-wheel' && fact.historical))
  assert.equal(first.loop.state.history[0].requested_actions[0].args.count, 1)
  const ordinal = first.loop.state.ordinal
  // Reload the on-disk campaign and dispatch a second goal against real global
  // native high-water state. Neither ordinal nor provider allowance can reset.
  const restarted = new PursuitRuntime({ ...options, campaignBudget: undefined })
  await restarted.request(JSON.stringify(goal(2)))
  await settle(restarted)
  assert.equal(restarted.loop.state.budget.calls, 6)
  assert.equal(restarted.loop.state.budget.maxCalls, 500)
  assert.equal(restarted.loop.state.budget.maxInputChars, 50000000)
  assert.equal(restarted.loop.state.budget.startedAt, first.loop.state.budget.startedAt)
  assert.equal(restarted.loop.state.ordinal, ordinal + 1)
  assert.equal(calls.length, 6)
  const final = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; rcon.print(helpers.table_to_json({plates=a.get_item_count("iron-plate"),gears=a.get_item_count("iron-gear-wheel"),connected_players=#game.connected_players}))'))
  assert.equal(final.plates, 0)
  assert.equal(final.gears, 2)
  assert.equal(final.connected_players, 0)
  // Independent declared engine fixture: a natural tree, mined by the real
  // standalone actor. Production trials never create these fixture sources.
  const naturalSetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local s=a.surface; local p=s.find_non_colliding_position("tree-01",{a.position.x+2,a.position.y},8,0.5); assert(p); local e=s.create_entity{name="tree-01",position=p,force="neutral"}; assert(e); local ok,u=pcall(function() return e.last_user end); rcon.print(helpers.table_to_json({created=true,kind=e.type,force=e.force.name,last_user_readable=ok,has_last_user=u~=nil,wood_before=a.get_item_count("wood")}))'))
  assert(naturalSetup.last_user_readable && !naturalSetup.has_last_user)
  const presentNavigation = JSON.parse(await rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_preflight","operation","walk_to_entity",{entity_name="tree-01",search_radius=64})))'))
  assert.equal(presentNavigation.ok, true)
  assert.deepEqual(presentNavigation.navigation_search, { radius: 64, target_present: true })
  const woodGoal = { objective: 'Harvest and hold one wood from an unowned natural source.', predicate: {
    scope: 'finite', summary: 'Hold at least one wood.', doneWhen: [{ kind: 'inventory_count', item_name: 'wood', minimum: naturalSetup.wood_before + 1 }] } }
  const harvester = new PursuitRuntime({ ...options, provider: async (_messages, context) => {
    calls.push({ controlProtocol: context.controlProtocol, operation: 'harvest_product' })
    return { content: JSON.stringify({ operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 64 } }] }) }
  } })
  await harvester.request(JSON.stringify(woodGoal))
  await settle(harvester)
  assert.equal(harvester.loop.state.budget.calls, 7)
  assert.equal(harvester.loop.state.ordinal, ordinal + 2)
  const naturalFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; rcon.print(helpers.table_to_json({wood=a.get_item_count("wood"),connected_players=#game.connected_players,speed=game.speed}))'))
  assert(naturalFinal.wood >= naturalSetup.wood_before + 1)
  assert.equal(naturalFinal.connected_players, 0)
  assert.equal(naturalFinal.speed, 1)
  // Reproduce native tree selection covering an ore centre. Fixture setup is
  // declared; the runtime must mine the exact ore without harvesting the tree.
  const overlapSetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local s=a.surface; local e=s.create_entity{name="copper-ore",position={math.floor(a.position.x)+1.5,math.floor(a.position.y)+0.5},amount=10}; assert(e); local t=s.create_entity{name="tree-05",position={e.position.x-0.0625,e.position.y+1.9375},force="neutral"}; assert(t); storage.pursuit_overlap_resource=e; storage.pursuit_overlap_tree=t; a.update_selected_entity(e.position); rcon.print(helpers.table_to_json({position=e.position,amount=e.amount,centre_selects_tree=a.selected==t,copper=a.get_item_count("copper-ore"),wood=a.get_item_count("wood")}))'))
  assert.equal(overlapSetup.centre_selects_tree, true)
  const exactAmountRefusal = JSON.parse(await rcon.command(`/silent-command local e=storage.pursuit_overlap_resource; local before=remote.call("autorio_operations","status"); local result=remote.call("autorio_preflight","operation","mine_resource_at",{resource_name="copper-ore",x=e.position.x,y=e.position.y,count=e.amount+1}); local after=remote.call("autorio_operations","status"); rcon.print(helpers.table_to_json({result=result,before=before,after=after,amount=e.amount}))`))
  assert.equal(exactAmountRefusal.result.ok, false)
  assert.equal(exactAmountRefusal.result.code, 'resource_source_insufficient')
  assert.equal(exactAmountRefusal.result.resource_target.amount, overlapSetup.amount)
  assert.equal(exactAmountRefusal.amount, overlapSetup.amount)
  assert.equal(exactAmountRefusal.before.queue_length, exactAmountRefusal.after.queue_length)
  assert.equal(exactAmountRefusal.before.task_state, exactAmountRefusal.after.task_state)
  const overlapGoal = { objective: 'Mine one exact copper ore under an overlapping tree selection box.', predicate: {
    scope: 'finite', summary: 'Gain one native copper ore.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: overlapSetup.copper + 1 }] } }
  const overlapMiner = new PursuitRuntime({ ...options, provider: async (_messages, context) => {
    calls.push({ controlProtocol: context.controlProtocol, operation: 'mine_resource_at' })
    return { content: JSON.stringify({ operations: [{ name: 'mine_resource_at', args: {
      resource_name: 'copper-ore', count: 1, x: overlapSetup.position.x, y: overlapSetup.position.y } }] }) }
  } })
  await overlapMiner.request(JSON.stringify(overlapGoal))
  await settle(overlapMiner)
  assert.equal(overlapMiner.loop.state.budget.calls, 8)
  assert.equal(overlapMiner.loop.state.ordinal, ordinal + 3)
  const overlapFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local e=storage.pursuit_overlap_resource; local t=storage.pursuit_overlap_tree; rcon.print(helpers.table_to_json({amount=e.valid and e.amount or 0,tree_valid=t.valid,copper=a.get_item_count("copper-ore"),wood=a.get_item_count("wood"),humans=#game.connected_players,speed=game.speed}))'))
  assert.equal(overlapFinal.copper, overlapSetup.copper + 1)
  assert.equal(overlapFinal.amount, overlapSetup.amount - 1)
  assert.equal(overlapFinal.wood, overlapSetup.wood)
  assert.equal(overlapFinal.tree_valid, true)
  assert.equal(overlapFinal.humans, 0)
  assert.equal(overlapFinal.speed, 1)
  // Two declared natural trees reproduce the failed live tree-on-tree selection.
  // Only the nearest exact tree may be harvested; its neighbour stays intact.
  const treeOverlapSetup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; local s=a.surface; local t=s.create_entity{name="tree-01",position={a.position.x-1.25,a.position.y},force="neutral"}; assert(t); local n=s.create_entity{name="tree-01",position={t.position.x-0.5,t.position.y+1.25},force="neutral"}; assert(n); storage.pursuit_exact_tree=t; storage.pursuit_neighbour_tree=n; a.update_selected_entity(t.position); rcon.print(helpers.table_to_json({centre_selects_neighbour=a.selected==n,wood=a.get_item_count("wood"),position=t.position,actor=a.position}))'))
  assert.equal(treeOverlapSetup.centre_selects_neighbour, true)
  const treeGoal = { objective: 'Harvest four wood from the nearest natural tree under another tree selection box.', predicate: {
    scope: 'finite', summary: 'Gain four native wood.', doneWhen: [{ kind: 'inventory_count', item_name: 'wood', minimum: treeOverlapSetup.wood + 4 }] } }
  const treeHarvester = new PursuitRuntime({ ...options, provider: async (_messages, context) => {
    calls.push({ controlProtocol: context.controlProtocol, operation: 'harvest_product' })
    return { content: JSON.stringify({ operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 4, search_radius: 8 } }] }) }
  } })
  await treeHarvester.request(JSON.stringify(treeGoal))
  await settle(treeHarvester)
  assert.equal(treeHarvester.loop.state.budget.calls, 9)
  assert.equal(treeHarvester.loop.state.ordinal, ordinal + 4)
  const treeOverlapFinal = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; rcon.print(helpers.table_to_json({target_valid=storage.pursuit_exact_tree.valid,neighbour_valid=storage.pursuit_neighbour_tree.valid,wood=a.get_item_count("wood"),actor=a.position,humans=#game.connected_players,speed=game.speed}))'))
  assert.equal(treeOverlapFinal.target_valid, false)
  assert.equal(treeOverlapFinal.neighbour_valid, true)
  assert.equal(treeOverlapFinal.wood, treeOverlapSetup.wood + 4)
  assert.deepEqual(treeOverlapFinal.actor, treeOverlapSetup.actor)
  assert.equal(treeOverlapFinal.humans, 0)
  assert.equal(treeOverlapFinal.speed, 1)
  await fsp.writeFile(path.join(results, 'pursuit-evidence.json'), JSON.stringify({ setup, final, calls: calls.length,
    ordinal: treeHarvester.loop.state.ordinal, state: treeHarvester.loop.snapshot(), missingSource, missingNavigation, furnaceCollision, presentNavigation, naturalSetup, naturalFinal, overlapSetup, exactAmountRefusal, overlapFinal, treeOverlapSetup, treeOverlapFinal, commands }, null, 2))
  console.log('PASS pursuit: native hand-craft receipts, zero humans, persistent campaign and cross-goal ordinals')
}
finally { connection.close() }
