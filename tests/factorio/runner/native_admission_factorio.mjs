#!/usr/bin/env node
// Real-engine fixtures for the native admission preflights and natural-only
// harvest selection. Each refusal asserts the native `code` AND that the world
// is untouched (inventory, actor position, queue, task state, admission
// high-water). Executed work runs through the OG batch wrapper
// (executeAuthorizedBatch, commands rendered by the production structured
// policy) or the OG agent loop with a scripted provider. Declared fixture
// stock only, game.speed=1, zero connected players. No provider, no inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}

const results = path.resolve(arg('results'))
const key = 'npc:sgluna'
const transcript = []
const evidence = {}
let connection

const ACTOR = 'local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
const rcon = { command: async (command, options) => {
  const response = await connection.command(command, options)
  transcript.push({ command: command.slice(0, 600), response: String(response).slice(0, 1200) })
  return response
} }
const lua = async body => {
  const raw = await rcon.command(`/silent-command ${ACTOR}${body}`)
  try { return JSON.parse(raw) }
  catch { throw new Error(`Lua command did not return JSON: ${String(raw).slice(0, 800)}\nCommand: ${body.slice(0, 400)}`) }
}
const preflight = (name, argsLua) => lua(`rcon.print(helpers.table_to_json(remote.call("autorio_preflight","operation","${name}",${argsLua})))`)
const MAIN = 'a.get_inventory(defines.inventory.character_main)'
// Everything a refusal must leave alone, read from the engine.
const snapshot = () => lua('local o=remote.call("autorio_operations","status"); local d=remote.call("autorio_operation_admission","status"); '
  + `rcon.print(helpers.table_to_json({inventory=${MAIN}.get_contents(),position={x=a.position.x,y=a.position.y},queue_length=o.queue_length,`
  + 'task_state=o.task_state,tasks_added=o.tasks_added,high_water=d.high_water,humans=#game.connected_players,speed=game.speed}))')
const noEffect = (before, after, label) => {
  assert.deepEqual(after, before, `${label}: refusal must leave inventory, position, queue, task state and admission high-water unchanged`)
  assert.equal(after.humans, 0, label)
  assert.equal(after.speed, 1, label)
}
const clearStock = () => lua(`${MAIN}.clear(); rcon.print(helpers.table_to_json({ok=true}))`)
const insertStock = stock => lua(`${MAIN}.clear(); local added={}; for name,count in pairs(${stockLua(stock)}) do added[name]=a.insert{name=name,count=count} end; rcon.print(helpers.table_to_json(added))`)
const stockLua = stock => `{${Object.entries(stock).map(([name, count]) => `["${name}"]=${count}`).join(',')}}`
// Remove natural trees and rocks around the actor so each geometry fixture owns its neighbourhood.
const clearNaturals = (radius = 24) => lua(`local n=0; for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=${radius},type={"tree","simple-entity"},force="neutral"}) do e.destroy(); n=n+1 end; rcon.print(helpers.table_to_json({destroyed=n}))`)
const furnaceNear = (varName, dx) => `local p=a.surface.find_non_colliding_position("stone-furnace",{a.position.x+(${dx}),a.position.y},16,0.5); assert(p); local ${varName}=a.surface.create_entity{name="stone-furnace",position=p,force=a.force}; assert(${varName}); `

async function untilIdle(label, timeoutMs = 90000) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const status = await lua('local o=remote.call("autorio_operations","status"); rcon.print(helpers.table_to_json({task_state=o.task_state,queue_length=o.queue_length,last_cancelled=o.last_cancelled_batch}))')
    if (status.task_state === 'idle' && status.queue_length === 0) return status
    assert.ok(Date.now() < until, `${label}: native work did not finish`)
    await delay(250)
  }
}

// One production-rendered command through the OG authorized-batch wrapper.
async function runOperation(name, args) {
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  const command = renderOperation(parseOperation({ name, args }))
  const batch = await executeAuthorizedBatch(rcon, status.epoch, [command])
  assert.equal(batch.results.length, 1)
  assert.notEqual(batch.results[0]?.[0], false, `${name} was refused natively: ${JSON.stringify(batch.results[0])}`)
  return untilIdle(name)
}

// OG agent loop with a scripted provider and the real mod behind rcon.
function agentHarness(label, memory = new CanonicalTaskBoardMemory()) {
  const traceFile = path.join(results, `${label}-behavior.jsonl`)
  const script = []
  const calls = []
  const agent = new NpcAgentLoop({
    rcon, memory, npcId: 'sgluna', stateFile: null, traceFile, decisionTraceFile: null, systemPrompt: 'Scripted native admission fixture',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: async messages => {
      calls.push(messages.length)
      const next = script.shift()
      assert.ok(next, `${label}: unscripted provider call ${calls.length}`)
      return typeof next === 'function' ? next(messages) : next
    },
  })
  const plan = (operations, plan = ['Do the current step']) => ({ content: JSON.stringify({ chatMessage: '', plan, currentStep: 0, operations }) })
  const observe = (name, type) => ({ content: null, tool_calls: [{ id: 'observe', type: 'function',
    function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32, name, ...(type ? { type } : {}), limit: 4 }) } }] })
  return {
    agent, memory, script, calls, plan, observe,
    rows: async () => (await fsp.readFile(traceFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse),
  }
}
const blockedBy = (result, code, harness, rows) => {
  assert.equal(result.blocker?.code, code, JSON.stringify(result.blocker))
  const rejected = rows.find(row => row.event === 'operations.preflight_rejected')
  assert.ok(rejected, 'the OG rejection trace row exists')
  assert.equal((rejected.data ?? rejected).preflight.code, code, 'the OG record carries the native code unchanged')
  assert.ok(rejected.request_id, 'the OG rejection trace row carries request_id')
  const board = harness.memory.currentPlan(key)
  assert.equal(board.blocker, `operation_preflight_failed:${code}`)
  const durable = board.task_board.evidence.find(row => row.summary?.includes(code))
  assert.ok(durable && JSON.parse(durable.summary).reason_code === code && JSON.parse(durable.summary).request_id, 'durable blocker evidence names the code and request_id')
}

async function main() {
  await fsp.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  await configureNpcSession(rcon, 'native-admission-engine-0001')
  const baseline = await lua(`game.speed=1; ${MAIN}.clear(); rcon.print(helpers.table_to_json({humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(baseline.humans, 0)
  assert.equal(baseline.speed, 1)

  // 12efe768: a known resource prototype with no source in the radius.
  {
    const before = await snapshot()
    const result = await preflight('gather_resource', '{resource_name="uranium-ore",count=75,search_radius=1}')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'resource_source_not_found')
    assert.equal(result.search_radius, 1)
    noEffect(before, await snapshot(), 'gather_resource absent source')
    evidence.resource_absent = { before, result }
  }

  // 50e4ec03: a known entity prototype with no navigation target in the radius.
  {
    const before = await snapshot()
    const result = await preflight('walk_to_entity', '{entity_name="uranium-ore",search_radius=1}')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'navigation_target_not_found')
    noEffect(before, await snapshot(), 'walk_to_entity absent target')
    evidence.navigation_absent = { before, result }
  }

  // a6e58a94: a walk_to_position centre deep inside a furnace collision box.
  {
    const before = await snapshot()
    const collision = await lua(`${furnaceNear('e', 3)} local tight=remote.call("autorio_preflight","operation","walk_to_position",{x=e.position.x,y=e.position.y,reach_distance=0.75}); `
      + 'local wide=remote.call("autorio_preflight","operation","walk_to_position",{x=e.position.x,y=e.position.y,reach_distance=2}); assert(e.destroy()); rcon.print(helpers.table_to_json({tight=tight,wide=wide}))')
    assert.equal(collision.tight.ok, false)
    assert.equal(collision.tight.code, 'navigation_position_inside_furnace_collision')
    assert(collision.tight.minimum_collision_clearance > 0.75)
    assert.equal(collision.wide.ok, true)
    noEffect(before, await snapshot(), 'walk_to_position furnace collision')
    evidence.furnace_collision = collision
  }

  // 56cc1391: a furnace is not a recipe machine; an assembler is. Also the engine fact that
  // grounds the shared-slot refusal: an occupied furnace input slot accepts no other ore.
  {
    await insertStock({ wood: 22, 'iron-ore': 12 })
    const before = await snapshot()
    const probe = await lua(`${furnaceNear('f', 3)} remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); `
      + 'local recipe=remote.call("autorio_preflight","operation","set_machine_recipe",{unit_number=f.unit_number,recipe_name="iron-plate"}); '
      + 'local input=f.get_inventory(defines.inventory.furnace_source); assert(input.insert{name="iron-ore",count=12}==12); '
      + 'local mixed={iron=input.get_item_count("iron-ore"),copper_can_insert=input.can_insert{name="copper-ore"},copper_room=input.get_insertable_count{name="copper-ore"}}; assert(f.destroy()); '
      + 'local p2=a.surface.find_non_colliding_position("assembling-machine-1",{a.position.x+6,a.position.y},16,0.5); assert(p2); '
      + 'local m=a.surface.create_entity{name="assembling-machine-1",position=p2,force=a.force}; assert(m); remote.call("autorio_tools","get_nearby_entities",32,"assembling-machine-1","assembling-machine",16); '
      + 'local assembler=remote.call("autorio_preflight","operation","set_machine_recipe",{unit_number=m.unit_number,recipe_name="iron-gear-wheel"}); assert(m.destroy()); '
      + 'rcon.print(helpers.table_to_json({recipe=recipe,mixed=mixed,assembler=assembler}))')
    assert.equal(probe.recipe.ok, false)
    assert.equal(probe.recipe.code, 'not_recipe_machine')
    assert.equal(probe.recipe.observed_type, 'furnace')
    assert.equal(probe.recipe.expected_type, 'assembling-machine')
    assert.equal(probe.mixed.iron, 12)
    assert.equal(probe.mixed.copper_can_insert, false)
    assert.equal(probe.mixed.copper_room, 0)
    assert.equal(probe.assembler.ok, true)
    assert.equal(probe.assembler.target.name, 'assembling-machine-1')
    noEffect(before, await snapshot(), 'set_machine_recipe on a furnace')
    evidence.recipe_machine = probe
  }

  // 56cc1391 through the OG loop: supply, furnace recipe, wait. The whole batch is refused before
  // admission, so the earlier supply never runs; the code reaches the OG record unchanged.
  {
    await insertStock({ wood: 22, 'iron-ore': 12 })
    const setup = await lua(`${furnaceNear('f', 3)} rcon.print(helpers.table_to_json({unit_number=f.unit_number}))`)
    const before = await snapshot()
    const world = agentHarness('recipe-guard')
    world.script.push(world.observe('stone-furnace', 'furnace'), world.plan([
      { name: 'supply_entity', args: { unit_number: setup.unit_number, items: [{ item_name: 'wood', count: 22 }, { item_name: 'iron-ore', count: 12 }] } },
      { name: 'set_machine_recipe', args: { unit_number: setup.unit_number, recipe_name: 'iron-plate' } },
      { name: 'wait', args: { ticks: 1200 } },
    ]))
    const result = await world.agent.request('load the furnace and set its recipe', { sender: 'tester' })
    const rows = await world.rows()
    blockedBy(result, 'not_recipe_machine', world, rows)
    assert.equal((rows.find(row => row.event === 'operations.preflight_rejected').data ?? {}).preflight.operation_index, 1)
    noEffect(before, await snapshot(), 'OG recipe-guard batch')
    const after = await lua(`local f=a.surface.find_entities_filtered{name="stone-furnace",position=a.position,radius=8}[1]; rcon.print(helpers.table_to_json({wood=f.get_fuel_inventory().get_item_count("wood"),iron=f.get_inventory(defines.inventory.furnace_source).get_item_count("iron-ore")}))`)
    assert.equal(after.wood, 0)
    assert.equal(after.iron, 0)
    await lua('for _,e in pairs(a.surface.find_entities_filtered{name="stone-furnace",position=a.position,radius=8}) do e.destroy() end; rcon.print(helpers.table_to_json({ok=true}))')
    evidence.recipe_guard_og = { result: result.blocker, before }
  }

  // 3562d0bd / b02caea7: available iron followed by absent coal. The whole supply is refused so
  // the earlier transfer cannot run; the available item still reports its expected movement.
  {
    await insertStock({ 'iron-ore': 12 })
    const setup = await lua(`${furnaceNear('f', 3)} remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); rcon.print(helpers.table_to_json({unit_number=f.unit_number}))`)
    const before = await snapshot()
    const result = await preflight('supply_entity', `{unit_number=${setup.unit_number},items={{item_name="iron-ore",count=12},{item_name="coal",count=38}}}`)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'supply_missing')
    assert.equal(result.transfer.items[0].expected_moved, 12)
    assert.equal(result.transfer.items[1].source_count, 0)
    noEffect(before, await snapshot(), 'supply_missing mixed')
    // Occupied iron input plus copper and usable wood: zero-transfer item refuses the whole supply.
    await insertStock({ 'copper-ore': 75, wood: 18 })
    await lua(`local f=a.surface.find_entities_filtered{name="stone-furnace",position=a.position,radius=8}[1]; assert(f.get_inventory(defines.inventory.furnace_source).insert{name="iron-ore",count=42}==42); rcon.print(helpers.table_to_json({ok=true}))`)
    const before2 = await snapshot()
    const full = await preflight('supply_entity', `{unit_number=${setup.unit_number},items={{item_name="copper-ore",count=75},{item_name="wood",count=18}}}`)
    assert.equal(full.ok, false)
    assert.equal(full.code, 'destination_full')
    assert.equal(full.transfer.items[0].expected_moved, 0)
    assert.equal(full.transfer.items[0].refusal_cause, 'input_slot_holds_other_item')
    assert.equal(full.transfer.items[1].expected_moved, 18)
    noEffect(before2, await snapshot(), 'destination_full mixed')
    const furnace = await lua('local f=a.surface.find_entities_filtered{name="stone-furnace",position=a.position,radius=8}[1]; local r={iron=f.get_inventory(defines.inventory.furnace_source).get_item_count("iron-ore"),wood=f.get_fuel_inventory().get_item_count("wood"),coal=f.get_fuel_inventory().get_item_count("coal")}; assert(f.destroy()); rcon.print(helpers.table_to_json(r))')
    assert.equal(furnace.iron, 42)
    assert.equal(furnace.wood, 0)
    assert.equal(furnace.coal, 0)
    evidence.supply_mixed = { missing: result, destination_full: full }
  }

  // b70c5eb9: two ore kinds that each fit an empty single-slot input individually, but not together.
  {
    await insertStock({ 'iron-ore': 188, 'copper-ore': 5, coal: 20 })
    const setup = await lua(`${furnaceNear('f', 3)} remote.call("autorio_tools","get_nearby_entities",16,"stone-furnace","furnace",16); rcon.print(helpers.table_to_json({unit_number=f.unit_number}))`)
    const before = await snapshot()
    const positive = await preflight('supply_entity', `{unit_number=${setup.unit_number},items={{item_name="coal",count=20},{item_name="copper-ore",count=5}}}`)
    assert.equal(positive.ok, true, JSON.stringify(positive))
    const conflict = await preflight('supply_entity', `{unit_number=${setup.unit_number},items={{item_name="coal",count=20},{item_name="copper-ore",count=5},{item_name="iron-ore",count=120}}}`)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'supply_destination_conflict')
    assert.equal(conflict.transfer.destination_conflict.inventory_index, 2)
    assert.equal(conflict.transfer.destination_conflict.slot_count, 1)
    assert.deepEqual(conflict.transfer.destination_conflict.item_names, ['copper-ore', 'iron-ore'])
    assert(conflict.transfer.items.every(item => item.expected_moved > 0))
    noEffect(before, await snapshot(), 'supply_destination_conflict')
    const furnace = await lua('local f=a.surface.find_entities_filtered{name="stone-furnace",position=a.position,radius=8}[1]; local i=f.get_inventory(defines.inventory.furnace_source); local r={coal=f.get_fuel_inventory().get_item_count("coal"),iron=i.get_item_count("iron-ore"),copper=i.get_item_count("copper-ore")}; assert(f.destroy()); rcon.print(helpers.table_to_json(r))')
    assert.deepEqual(furnace, { coal: 0, iron: 0, copper: 0 })
    evidence.supply_shared_slot = { positive, conflict }
  }

  // 402f8d66: the NPC display name is not a human LuaPlayer identity.
  {
    await clearStock()
    const before = await snapshot()
    const probe = await lua('assert(game.get_player("SGLuna")==nil); rcon.print(helpers.table_to_json({craft=remote.call("autorio_preflight","operation","craft_item",{item_name="iron-gear-wheel",count=1}),'
      + 'transfer=remote.call("autorio_preflight","operation","move_items_with_player",{player_name="SGLuna",item_name="copper-ore",max_count=74,to_player=true})}))')
    assert.equal(probe.transfer.ok, false)
    assert.equal(probe.transfer.code, 'player_unavailable')
    assert.equal(probe.transfer.identity, 'SGLuna')
    noEffect(before, await snapshot(), 'move_items_with_player absent player')
    evidence.absent_player = probe
  }

  // 44b5e241 / 1efbdefc: harvest_product needs an eligible natural source inside the radius.
  {
    await clearStock()
    const before = await snapshot()
    const result = await preflight('harvest_product', '{product_name="stone",search_radius=1}')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'natural_harvest_source_not_found')
    assert.equal(result.search_radius, 1)
    assert(result.source_names.length > 0)
    noEffect(before, await snapshot(), 'harvest_product absent natural source')
    const world = agentHarness('absent-harvest')
    world.script.push(world.plan([
      { name: 'harvest_product', args: { product_name: 'stone', count: 5, search_radius: 1 } },
      { name: 'wait', args: { ticks: 1200 } },
    ]))
    const blocked = await world.agent.request('harvest five stone nearby', { sender: 'tester' })
    blockedBy(blocked, 'natural_harvest_source_not_found', world, await world.rows())
    noEffect(before, await snapshot(), 'OG absent natural harvest batch')
    evidence.absent_harvest = { result, blocker: blocked.blocker }
  }

  // 1efbdefc: a built entity that yields the product when mined is never a harvest source, and a
  // natural tree is still harvested through the OG admission path. (A player-touched natural entity cannot be
  // fabricated with zero connected players, so the last_user and force guards stay unit-tested only.)
  const natural = agentHarness('natural-harvest')
  {
    await clearNaturals()
    await clearStock()
    const setup = await lua(`${furnaceNear('f', -4)} `
      + 'local t=a.surface.create_entity{name="tree-01",position=a.surface.find_non_colliding_position("tree-01",{a.position.x+2,a.position.y},8,0.5),force="neutral"}; assert(t); '
      + 'local ok,u=pcall(function() return t.last_user end); '
      + 'storage.native_admission_fixture={furnace=f,tree=t}; '
      + 'rcon.print(helpers.table_to_json({tree_force=t.force.name,last_user_readable=ok,has_last_user=u~=nil,wood=a.get_item_count("wood"),stone=a.get_item_count("stone")}))')
    assert(setup.last_user_readable && !setup.has_last_user)
    assert.equal(setup.tree_force, 'neutral')
    const before = await snapshot()
    const built = await preflight('harvest_product', '{product_name="stone-furnace",search_radius=64}')
    assert.equal(built.ok, false)
    assert.equal(built.code, 'no_natural_harvest_source')
    const native = await lua('rcon.print(helpers.table_to_json({submitted=remote.call("autorio_operations","harvest_product","stone-furnace",1,64)}))')
    assert.equal(native.submitted[0], false)
    const noRock = await preflight('harvest_product', '{product_name="stone",search_radius=8}')
    assert.equal(noRock.ok, false)
    assert.equal(noRock.code, 'natural_harvest_source_not_found')
    noEffect(before, await snapshot(), 'built and non-neutral harvest sources')
    // Submitting directly (bypassing preflight) with no eligible natural source cancels without mining anything.
    await lua('rcon.print(helpers.table_to_json({submitted=remote.call("autorio_operations","harvest_product","stone",1,8)}))')
    const cancelled = await untilIdle("harvest without a natural source")
    assert.match(cancelled.last_cancelled?.reason ?? '', /harvest:no_target/)
    const intact = await lua('local f=storage.native_admission_fixture; rcon.print(helpers.table_to_json({furnace=f.furnace.valid,tree=f.tree.valid,stone=a.get_item_count("stone")}))')
    assert.deepEqual(intact, { furnace: true, tree: true, stone: 0 })
    // The natural tree harvests through the OG loop, and the reconciled admission record completes.
    const present = await preflight('harvest_product', '{product_name="wood",search_radius=64}')
    assert.equal(present.ok, true)
    assert.deepEqual(present.source_search, { radius: 64, target_present: true })
    assert.equal(present.natural_source.name, 'tree-01')
    natural.script.push(natural.plan([{ name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 64 } }], ['Harvest one wood']))
    const admitted = await natural.agent.request('harvest one wood from a natural tree', { sender: 'tester' })
    assert.deepEqual(admitted.operations.map(operation => operation.name), ['harvest_product'])
    await untilIdle('natural wood harvest')
    const final = await lua('local f=storage.native_admission_fixture; local d=remote.call("autorio_operation_admission","status"); '
      + 'rcon.print(helpers.table_to_json({wood=a.get_item_count("wood"),furnace=f.furnace.valid,tree=f.tree.valid,records=d.records,humans=#game.connected_players,speed=game.speed}))')
    assert(final.wood >= setup.wood + 1)
    assert.equal(final.furnace, true)
    assert.equal(final.tree, false, 'the natural tree was the harvested entity')
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    const record = final.records.at(-1)
    assert.equal(record.state, 'completed', JSON.stringify(record))
    await lua('local f=storage.native_admission_fixture; f.furnace.destroy(); storage.native_admission_fixture=nil; rcon.print(helpers.table_to_json({ok=true}))')
    evidence.natural_only = { setup, built, noRock, present, final }
  }

  // b84919aa: a pole prototype and its ingredients are not a held pole (both native placement paths).
  const placementEvidence = []
  for (const pathName of ['place_entity', 'place_candidate']) {
    await clearNaturals(12)
    const before0 = await lua(`${MAIN}.clear(); assert(${MAIN}.insert{name="wood",count=1}==1); assert(${MAIN}.insert{name="copper-cable",count=2}==2); `
      + 'local choices=remote.call("autorio_tools","get_placement_candidates",{entity_name="small-electric-pole",center={x=a.position.x+3,y=a.position.y},radius=2,limit=1}); '
      + 'assert(choices.ok and #choices.candidates==1, serpent.line(choices)); rcon.print(helpers.table_to_json({choices=choices}))')
    const args = pathName === 'place_entity' ? '{entity_name="small-electric-pole"}'
      : `{candidate_set_id="${before0.choices.candidate_set_id}",candidate_id="${before0.choices.candidates[0].id}"}`
    const before = await snapshot()
    const refusal = await preflight(pathName, args)
    assert.equal(refusal.ok, false)
    assert.equal(refusal.code, 'placement_item_missing')
    assert.deepEqual(refusal.placement_item, { entity_name: 'small-electric-pole', item_name: 'small-electric-pole', count: 1, held_count: 0 })
    noEffect(before, await snapshot(), `${pathName} missing held item`)
    // A genuinely held pole passes the preflight and is consumed by the native placement.
    await lua(`assert(${MAIN}.insert{name="small-electric-pole",count=1}==1); rcon.print(helpers.table_to_json({ok=true}))`)
    const positive = await preflight(pathName, args)
    assert.equal(positive.ok, true, JSON.stringify(positive))
    assert.equal(positive.placement_item.held_count, 1)
    const poles = await lua('rcon.print(helpers.table_to_json({count=a.surface.count_entities_filtered{name="small-electric-pole",position=a.position,radius=12}}))')
    if (pathName === 'place_entity') await runOperation('place_entity', { entity_name: 'small-electric-pole' })
    else await runOperation('place_candidate', { candidate_set_id: before0.choices.candidate_set_id, candidate_id: before0.choices.candidates[0].id })
    const final = await lua(`local list=a.surface.find_entities_filtered{name="small-electric-pole",position=a.position,radius=12}; local r={placed=#list,held=a.get_item_count("small-electric-pole"),wood=a.get_item_count("wood"),cable=a.get_item_count("copper-cable"),humans=#game.connected_players,speed=game.speed}; for _,e in pairs(list) do e.destroy() end; ${MAIN}.clear(); rcon.print(helpers.table_to_json(r))`)
    assert.equal(final.placed, poles.count + 1)
    assert.equal(final.held, 0)
    assert.equal(final.wood, 1)
    assert.equal(final.cable, 2)
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    placementEvidence.push({ path: pathName, refusal, positive, final })
  }
  evidence.placement_item = placementEvidence

  // OG batch dependency: a craft of the placement item earlier in the same batch defers the
  // held-item snapshot; the real engine crafts the chest and then places it.
  {
    await clearNaturals(12)
    await insertStock({ wood: 2 })
    const snapshotPreflight = await preflight('place_entity', '{entity_name="wooden-chest"}')
    assert.equal(snapshotPreflight.code, 'placement_item_missing', 'the pre-craft snapshot is a refusal on its own')
    const before = await snapshot()
    natural.script.push(natural.plan([
      { name: 'craft_item', args: { item_name: 'wooden-chest', count: 1 } },
      { name: 'place_entity', args: { entity_name: 'wooden-chest' } },
    ], ['Craft and place a chest']))
    const result = await natural.agent.request('craft and place a wooden chest', { sender: 'tester' })
    assert.deepEqual(result.operations.map(operation => operation.name), ['craft_item', 'place_entity'], JSON.stringify({ result, events: (await natural.rows()).map(row => row.event).slice(-14) }).slice(0, 2500))
    const rows = await natural.rows()
    const deferred = rows.find(row => row.event === 'placement.preflight_item_deferred')
    assert.ok(deferred, 'the deferral is traced')
    assert.ok(deferred.request_id)
    assert.equal((deferred.data ?? deferred).code, 'placement_item_missing')
    await untilIdle('craft then place')
    const final = await lua('local list=a.surface.find_entities_filtered{name="wooden-chest",position=a.position,radius=16}; '
      + 'local r={placed=#list,held=a.get_item_count("wooden-chest"),crafted_per_recipe=prototypes.recipe["wooden-chest"].products[1].amount,humans=#game.connected_players,speed=game.speed}; for _,e in pairs(list) do e.destroy() end; '
      + `${MAIN}.clear(); rcon.print(helpers.table_to_json(r))`)
    assert.equal(final.placed, 1)
    assert.equal(final.held, final.crafted_per_recipe - 1)
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    assert.equal(before.high_water + 1, (await snapshot()).high_water)
    evidence.craft_then_place = { snapshotPreflight, final }
  }

  // 5ebebdbc / 7129b529: exact ore under an overlapping tree selection box; exact amount beyond a finite tile refused.
  {
    await clearNaturals()
    await clearStock()
    const setup = await lua('local s=a.surface; local e=s.create_entity{name="copper-ore",position={math.floor(a.position.x)+1.5,math.floor(a.position.y)+0.5},amount=10}; assert(e); '
      + 'local t=s.create_entity{name="tree-05",position={e.position.x-0.0625,e.position.y+1.9375},force="neutral"}; assert(t); storage.native_admission_overlap={resource=e,tree=t}; '
      + 'a.update_selected_entity(e.position); rcon.print(helpers.table_to_json({position=e.position,amount=e.amount,centre_selects_tree=a.selected==t,copper=a.get_item_count("copper-ore"),wood=a.get_item_count("wood")}))')
    assert.equal(setup.centre_selects_tree, true)
    const before = await snapshot()
    const refusal = await preflight('mine_resource_at', `{resource_name="copper-ore",x=${setup.position.x},y=${setup.position.y},count=${setup.amount + 1}}`)
    assert.equal(refusal.ok, false)
    assert.equal(refusal.code, 'resource_source_insufficient')
    assert.equal(refusal.resource_target.amount, setup.amount)
    noEffect(before, await snapshot(), 'mine_resource_at beyond tile amount')
    const accepted = await preflight('mine_resource_at', `{resource_name="copper-ore",x=${setup.position.x},y=${setup.position.y},count=1}`)
    assert.equal(accepted.ok, true, JSON.stringify(accepted))
    await runOperation('mine_resource_at', { resource_name: 'copper-ore', count: 1, x: setup.position.x, y: setup.position.y })
    const final = await lua('local o=storage.native_admission_overlap; local r={amount=o.resource.valid and o.resource.amount or 0,tree=o.tree.valid,copper=a.get_item_count("copper-ore"),wood=a.get_item_count("wood"),humans=#game.connected_players,speed=game.speed}; '
      + 'if o.resource.valid then o.resource.destroy() end; o.tree.destroy(); storage.native_admission_overlap=nil; rcon.print(helpers.table_to_json(r))')
    assert.equal(final.copper, setup.copper + 1)
    assert.equal(final.amount, setup.amount - 1)
    assert.equal(final.wood, setup.wood)
    assert.equal(final.tree, true)
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    evidence.exact_ore_under_tree = { setup, refusal, final }
  }

  // aa44967e: nearest natural tree under another tree's selection box; its neighbour must survive.
  {
    await clearNaturals()
    await clearStock()
    const setup = await lua('local s=a.surface; local t=s.create_entity{name="tree-01",position={a.position.x-1.25,a.position.y},force="neutral"}; assert(t); '
      + 'local n=s.create_entity{name="tree-01",position={t.position.x-0.5,t.position.y+1.25},force="neutral"}; assert(n); storage.native_admission_trees={target=t,neighbour=n}; '
      + 'a.update_selected_entity(t.position); rcon.print(helpers.table_to_json({centre_selects_neighbour=a.selected==n,wood=a.get_item_count("wood"),actor={x=a.position.x,y=a.position.y}}))')
    assert.equal(setup.centre_selects_neighbour, true)
    await runOperation('harvest_product', { product_name: 'wood', count: 4, search_radius: 8 })
    const final = await lua('local o=storage.native_admission_trees; local r={target=o.target.valid,neighbour=o.neighbour.valid,wood=a.get_item_count("wood"),actor={x=a.position.x,y=a.position.y},humans=#game.connected_players,speed=game.speed}; '
      + 'if o.neighbour.valid then o.neighbour.destroy() end; storage.native_admission_trees=nil; rcon.print(helpers.table_to_json(r))')
    assert.equal(final.target, false)
    assert.equal(final.neighbour, true)
    assert.equal(final.wood, setup.wood + 4)
    assert.deepEqual(final.actor, setup.actor)
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    evidence.tree_on_tree = { setup, final }
  }

  // 37c776bb: a natural target whose selection box is covered by a neighbour at every probe point.
  {
    await clearNaturals()
    await clearStock()
    const setup = await lua('local s=a.surface; local p={x=a.position.x-0.29296875,y=a.position.y+2.40234375}; local t=s.create_entity{name="dry-hairy-tree",position=p,force="neutral"}; '
      + 'local n=s.create_entity{name="tree-06",position={x=p.x+0.25,y=p.y+1.0625},force="neutral"}; assert(t and n); storage.native_admission_occluded={target=t,neighbour=n}; '
      + 'local exact=0; local function probe(q) a.update_selected_entity(q); if a.selected==t then exact=exact+1 end end; probe(t.position); '
      + 'local b=t.selection_box; local c={x=(b.left_top.x+b.right_bottom.x)/2,y=(b.left_top.y+b.right_bottom.y)/2}; local dx=(b.right_bottom.x-b.left_top.x)*0.4; local dy=(b.right_bottom.y-b.left_top.y)*0.4; '
      + 'for _,v in pairs({{-1,-1},{0,-1},{1,-1},{-1,0},{1,0},{-1,1},{0,1},{1,1}}) do probe{x=c.x+dx*v[1],y=c.y+dy*v[2]} end; a.mining_state={mining=false}; '
      + 'rcon.print(helpers.table_to_json({exact_probe_count=exact,wood=a.get_item_count("wood"),inventory=a.get_main_inventory().get_contents(),actor={x=a.position.x,y=a.position.y}}))')
    assert.equal(setup.exact_probe_count, 0, 'the fixture must occlude all nine probes natively')
    await runOperation('harvest_product', { product_name: 'wood', count: 2, search_radius: 8 })
    const final = await lua('local o=storage.native_admission_occluded; local op=remote.call("autorio_operations","status"); '
      + 'local r={target=o.target.valid,neighbour=o.neighbour.valid,wood=a.get_item_count("wood"),inventory=a.get_main_inventory().get_contents(),actor={x=a.position.x,y=a.position.y},queue_length=op.queue_length,humans=#game.connected_players,speed=game.speed}; '
      + 'if o.neighbour.valid then o.neighbour.destroy() end; storage.native_admission_occluded=nil; rcon.print(helpers.table_to_json(r))')
    assert.equal(final.target, false)
    assert.equal(final.neighbour, true)
    assert.equal(final.wood, setup.wood + 2)
    assert.deepEqual(final.actor, setup.actor)
    assert.equal(final.queue_length, 0)
    assert.equal(final.humans, 0)
    assert.equal(final.speed, 1)
    evidence.occluded_tree = { setup, final }
  }

  await fsp.writeFile(path.join(results, 'native-admission-engine.json'), JSON.stringify({
    status: 'pass', scenario: 'native-admission-preflights-and-natural-harvest', candidate_sha: process.env.NPC_TEST_CANDIDATE_SHA,
    provider_mode: 'scripted', evidence,
  }, null, 2))
  console.log('PASS: native admission refusals left the real world untouched and reached the OG record unchanged; natural-only harvest, exact selection and held-item placement ran in the real engine')
}

main().catch(async error => {
  await fsp.mkdir(results, { recursive: true })
  await fsp.writeFile(path.join(results, 'native-admission-error.txt'), `${error.stack ?? error}\n`)
  await fsp.writeFile(path.join(results, 'native-admission-transcript.json'), JSON.stringify(transcript.slice(-60), null, 2)).catch(() => {})
  console.error(error)
  process.exitCode = 1
}).finally(() => connection?.close())
