#!/usr/bin/env node
// Scripted native evidence, zero providers/humans. Terrain/resources/stock are
// declared fixture setup; machines and fuel use normal admitted NPC operations.
// Run prepare, restart the exact saved world, then reload. Parent owns resources.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand, parseOperation, renderOperation, luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { createFactoryCellObserver } from '../pterodactyl/runtime-v8/factory-cell-observation.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('Inference forbidden in factory-cell native proof') }
const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const phase = arg('phase')
const results = path.resolve(arg('results'))
const statePath = path.join(results, 'factory-cell-state.json')
const trace = []
const evidence = { phase, status: 'fail', factorio: '2.0.77', operations: [], events: [] }
let connection
const rcon = { command: async text => { const response = await connection.command(text); trace.push({ text, response }); return response } }
const lua = async body => {
  const result = await rcon.command(`/silent-command ${body}`)
  try { return JSON.parse(result) } catch { throw new Error(`Native JSON failed: ${result}`) }
}
const tool = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const native = (method, payload) => lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory",${luaString(method)}${payload === undefined ? '' : `,${typeof payload === 'string' ? luaString(payload) : `helpers.json_to_table(${luaString(JSON.stringify(payload))})`}`})))`)
async function operation(name, args) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const admission = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation({ name, args }))])
  const deadline = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) {
      const receipt = status.basic_operation?.last_result
      assert.equal(receipt?.completed, true, JSON.stringify(status))
      evidence.operations.push({ name, args, admission, receipt })
      return receipt
    }
    assert.ok(Date.now() < deadline, `${name} timed out`); await delay(100)
  }
}
async function place(name, request) {
  const candidates = await tool('getPlacementCandidates', { entity_name: name, limit: 4, ...request })
  assert.ok(candidates.candidates?.length, JSON.stringify(candidates))
  const candidate = candidates.candidates[0]
  const receipt = await operation('place_candidate', { candidate_set_id: candidates.candidate_set_id, candidate_id: candidate.id })
  assert.ok(receipt.placed_unit_number)
  return { candidate, receipt }
}
const KEY = 'npc:factory-cell-native'
function task(memory, resource) {
  const checkpoint = { mode: 'all', requirements: [{ id: 'held', kind: 'inventory_count', item_name: resource === 'copper-ore' ? 'copper-plate' : 'iron-plate', minimum: 1 }] }
  memory.recordPlan(KEY, { sender: 'owner', text: `Build dedicated ${resource} production without converting assigned suppliers` }, {
    chatMessage: 'Use live native production facts.', plan: ['Inspect dedicated production'], currentStep: 0, operations: [],
    executionGuidance: [{ approach: 'Inspect the assigned source and its exact native output route.', rationale: 'Keep each accepted production assignment.', constraints: [], skillIds: [], materialSupply: { mode: 'direct_feed', resource } }],
    stepCompletions: [{ kind: 'deterministic', checkpoint }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
}
function host(memory, setup, actor, receipts = new Map()) {
  const context = { surface_index: setup.surface_index, force_index: setup.force_index, actor_id: actor.actor_id, actor_epoch: actor.epoch,
    session_id: actor.session ?? 'factory-cell-native-20261029', request_id: `native-${phase}`, native_idle: true, pending: false, uncertain: false }
  const observer = createFactoryCellObserver({ memory, key: KEY,
    readContext: () => ({ ...context, world_id: memory.factoryWorldBinding().world_id }),
    callNative: native, readPlacementReceipt: id => structuredClone(receipts.get(id)),
    trace: (name, payload) => evidence.events.push({ name, ...payload }) })
  return { observer, context, receipts }
}
function register(memory, observer, receipts, members, actualReceipts) {
  const scope = observer.runtime.scope()
  const originalIntent = JSON.stringify({ goal: memory.planningState(KEY).goal, plans: memory.planningState(KEY).plans })
  const registered = members.map((locator, index) => {
    const receipt = actualReceipts[index]
    assert.equal(receipt.placed_unit_number, locator.unit_number)
    memory.recordNpcPlacement(KEY, { unit_number: locator.unit_number, entity_name: locator.name, actor_id: scope.actor_id, actor_epoch: scope.actor_epoch })
    const receiptId = `native-factory/${locator.unit_number}/${receipt.tick ?? 'completed'}`
    receipts.set(receiptId, { ...scope, ...locator, receipt_id: receiptId })
    return observer.runtime.recordPlacement({ ...locator, provenance: { source: 'npc_placement_receipt', receipt_id: receiptId } }, scope)
  })
  assert.equal(JSON.stringify({ goal: memory.planningState(KEY).goal, plans: memory.planningState(KEY).plans }), originalIntent, 'recording actual placement history cannot change goal or committed plans')
  const before = JSON.stringify(memory.planningState(KEY))
  const cell = observer.runtime.registerCell({ surface_index: scope.surface_index, force_index: scope.force_index,
    assignment: { products: ['copper-plate'], purpose: 'Retain the copper supplier', method: 'Native drill direct feed into furnace' },
    members: registered, ports: [{ port_id: 'fuel', direction: 'input', kind: 'fuel', resource: 'coal' },
      { port_id: 'output', direction: 'output', kind: 'item', resource: 'copper-plate' }],
    origin: { ...registered[0].provenance, source: 'runtime_registration' } }, observer.runtime.scope())
  assert.equal(JSON.stringify(memory.planningState(KEY)), before)
  assert.equal(cell.state, 'unverified')
  return cell
}
async function compare(memory, observer, cell, members, expected) {
  const planning = JSON.stringify(memory.planningState(KEY))
  const board = JSON.stringify(memory.currentPlan(KEY))
  const registry = JSON.stringify(memory.getFactoryRegistry())
  let result
  const deadline = Date.now() + 15000
  const samples = []
  for (;;) {
    result = await observer.observe({ cell_id: cell.cell_id, binding: {
      source_unit_number: members[0].unit_number, target_unit_number: members[1].unit_number, product: 'copper-plate' } })
    assert.equal(JSON.stringify(memory.planningState(KEY)), planning)
    assert.equal(JSON.stringify(memory.currentPlan(KEY)), board)
    assert.equal(JSON.stringify(memory.getFactoryRegistry()), registry)
    samples.push({ tick: result.native.tick, state: result.state, checks: result.checks })
    const dormant = expected === 'compatible' && result.state === 'unverified'
      && result.checks.some(row => row.code === 'target_recipe_unknown')
      && result.checks.every(row => ['native_member_identity_match', 'target_recipe_unknown', 'assigned_product_capability_unverified'].includes(row.code))
    if (!dormant || Date.now() >= deadline) break
    await delay(150)
  }
  evidence.observation_samples ??= []
  evidence.observation_samples.push({ expected, samples })
  assert.equal(result.state, expected, JSON.stringify(result))
  assert.equal(JSON.stringify(memory.planningState(KEY)), planning, 'observation cannot rewrite the original goal or committed plan')
  assert.equal(JSON.stringify(memory.currentPlan(KEY)), board)
  assert.equal(JSON.stringify(memory.getFactoryRegistry()), registry, 'raw facts do not commission/reassign the registry')
  return result
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  const deadline = Date.now() + 30000
  for (;;) { try { await connection.connect(); break } catch (error) { connection.close(); if (Date.now() >= deadline) throw error; await delay(200) } }
  assert.match(await rcon.command('/version'), /2\.0\.77/)
  if (phase === 'prepare') {
    await configureNpcSession(rcon, 'factory-cell-native-20261029')
    const actor = await deploymentStatus(rcon, { requireAllowed: true })
    const setup = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local ox=math.floor(a.position.x);local oy=math.floor(a.position.y);game.speed=1;
      local area={{ox-12,oy-12},{ox+12,oy+12}};for _,e in pairs(s.find_entities_filtered{area=area}) do if e.type~="character" and e.name~="sgluna-npc-vision" then e.destroy() end end;
      local tiles={};for x=ox-12,ox+12 do for y=oy-12,oy+12 do tiles[#tiles+1]={name="landfill",position={x,y}} end end;s.set_tiles(tiles,true,false,true);
      for x=ox+3,ox+6 do for y=oy-2,oy+1 do assert(s.create_entity{name="copper-ore",position={x+0.5,y+0.5},amount=1000}) end end;
      local fixtures={};for _,spec in pairs({{"pipe",ox-7.5,oy+3.5},{"pipe",ox-6.5,oy+3.5},{"transport-belt",ox-7.5,oy+6.5},{"transport-belt",ox-6.5,oy+6.5}}) do
        local e=s.create_entity{name=spec[1],position={spec[2],spec[3]},force=a.force,direction=defines.direction.east};assert(e);fixtures[#fixtures+1]={unit_number=e.unit_number,name=e.name,position=e.position,surface_index=s.index,force_index=e.force.index};if e.type=="pipe" then e.insert_fluid{name="water",amount=10} end end;
      local inv=a.get_main_inventory();inv.clear();for _,v in pairs({{"burner-mining-drill",1},{"stone-furnace",1},{"coal",4}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end;
      rcon.print(helpers.table_to_json({ox=ox,oy=oy,humans=#game.connected_players,speed=game.speed,actor_id=a.unit_number,surface_index=s.index,force_index=a.force.index,fixtures=fixtures}))`)
    assert.equal(setup.humans, 0); assert.equal(setup.speed, 1); evidence.setup = setup
    const drill = await place('burner-mining-drill', { center: { x: setup.ox + 5, y: setup.oy }, radius: 4, target_resource: 'copper-ore' })
    const furnace = await place('stone-furnace', { covers_position: drill.candidate.item_output_position })
    const machines = [drill, furnace]
    for (const machine of machines) await operation('supply_entity', { unit_number: machine.receipt.placed_unit_number, items: [{ item_name: 'coal', count: 2 }] })
    const members = await lua(`local s=game.surfaces[${setup.surface_index}];local rows={};for _,id in pairs({${machines.map(row => row.receipt.placed_unit_number).join(',')}}) do
      local found;for _,e in pairs(s.find_entities_filtered{force=${setup.force_index},type={"mining-drill","furnace"}}) do if e.unit_number==id then found=e end end;assert(found);
      rows[#rows+1]={unit_number=found.unit_number,name=found.name,position=found.position,surface_index=s.index,force_index=found.force.index} end;rcon.print(helpers.table_to_json(rows))`)
    const productionDeadline = Date.now() + 30000
    for (;;) {
      const production = await lua(`local s=game.surfaces[${setup.surface_index}];local d=s.find_entities_filtered{name="burner-mining-drill",position={${members[0].position.x},${members[0].position.y}}}[1];local f=s.find_entities_filtered{name="stone-furnace",position={${members[1].position.x},${members[1].position.y}}}[1];
        rcon.print(helpers.table_to_json({plates=f.get_inventory(defines.inventory.furnace_result).get_item_count("copper-plate"),drop_target=d.drop_target and d.drop_target.unit_number,tick=game.tick,humans=#game.connected_players,speed=game.speed}))`)
      assert.equal(production.humans, 0); assert.equal(production.speed, 1)
      if (production.plates > 0 && production.drop_target === members[1].unit_number) { evidence.production = production; break }
      assert.ok(Date.now() < productionDeadline, `no native copper output: ${JSON.stringify(production)}`); await delay(150)
    }
    const memory = new CanonicalTaskBoardMemory(); task(memory, 'copper-ore')
    const w = host(memory, setup, actor)
    evidence.world = await w.observer.initializeWorld()
    const cell = register(memory, w.observer, w.receipts, members, machines.map(row => row.receipt))
    evidence.compatible = await compare(memory, w.observer, cell, members, 'compatible')
    const worldId = memory.factoryWorldBinding().world_id
    const nativeRequest = { schema_version: 1, request_id: 'native-readonly-proof', world_id: worldId, actor_id: actor.actor_id,
      surface_index: setup.surface_index, force_index: setup.force_index, members }
    evidence.readonly = await lua(`local before=helpers.table_to_json(storage.sgluna_entity_reference_hints or {});local id=storage.sgluna_factory_world_id;local result=remote.call("sgluna_factory","observe",helpers.json_to_table(${luaString(JSON.stringify(nativeRequest))}));
      assert(result.ok);assert(before==helpers.table_to_json(storage.sgluna_entity_reference_hints or {}));assert(id==storage.sgluna_factory_world_id);rcon.print(helpers.table_to_json({hints_unchanged=true,world_unchanged=true,result=result}))`)
    evidence.foreign_world = await native('observe', { ...nativeRequest, world_id: randomUUID() })
    assert.equal(evidence.foreign_world.code, 'world_identity_mismatch')
    evidence.static_fixture_geometry = await native('observe', { ...nativeRequest, request_id: 'declared-static-fixtures', members: setup.fixtures })
    assert.equal(evidence.static_fixture_geometry.ok, true)
    const fixtureRows = evidence.static_fixture_geometry.members
    assert.ok(fixtureRows[0].fluids.storages.some(row => row.current_fluid?.name === 'water' && row.current_fluid.amount > 0))
    assert.ok(fixtureRows[0].fluids.storages.some(row => row.connections.some(edge => edge.state === 'connected' && edge.target?.unit_number === setup.fixtures[1].unit_number)))
    assert.ok(fixtureRows[1].fluids.storages.some(row => row.connections.some(edge => edge.state === 'connected' && edge.target?.unit_number === setup.fixtures[0].unit_number)))
    assert.ok(fixtureRows[2].item_routes.routes.some(edge => edge.kind === 'belt_output' && edge.target?.unit_number === setup.fixtures[3].unit_number))
    assert.ok(fixtureRows[3].item_routes.routes.some(edge => edge.kind === 'belt_input' && edge.target?.unit_number === setup.fixtures[2].unit_number))
    evidence.rebind = await native('bind_world_id', randomUUID())
    assert.equal(evidence.rebind.ok, false); assert.equal(evidence.rebind.world_id, worldId)
    const second = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: worldId }); second.restore(memory.snapshot())
    second.clearTaskContext(KEY); task(second, 'iron-ore')
    const iron = host(second, setup, actor); await iron.observer.initializeWorld()
    evidence.iron_mismatch = await compare(second, iron.observer, cell, members, 'mismatch')
    assert.ok(JSON.stringify(evidence.iron_mismatch).includes('mining_source_resource_mismatch'))
    assert.deepEqual(memory.getFactoryRegistry().cells[0].assignment.products, ['copper-plate'])
    await fs.writeFile(statePath, JSON.stringify({ worldId, setup, members, cell, snapshot: memory.snapshot() }, null, 2))
    const save = path.resolve(arg('save')); const previous = await fs.stat(save)
    assert.equal(path.extname(save), '.zip', 'exact restart save must be a ZIP')
    const saveName = path.basename(save, '.zip')
    assert.match(saveName, /^[A-Za-z0-9_-]+$/, 'explicit safe native save basename')
    await rcon.command(`/silent-command game.server_save(${luaString(saveName)})`)
    const saveDeadline = Date.now() + 30000
    while ((await fs.stat(save)).mtimeMs <= previous.mtimeMs) { assert.ok(Date.now() < saveDeadline, 'native save did not finish'); await delay(100) }
    const savedBytes = await fs.readFile(save)
    assert.equal(savedBytes.readUInt32LE(0), 0x04034B50, 'exact saved file has a ZIP local header')
    evidence.save = { path: save, basename: saveName, bytes: savedBytes.length, modified_after_prepare: true, zip_header: true,
      full_zip_integrity: 'parent runner must verify before exact-save restart' }
  }
  else {
    assert.equal(phase, 'reload')
    const saved = JSON.parse(await fs.readFile(statePath, 'utf8'))
    const actor = await deploymentStatus(rcon, { requireAllowed: true })
    assert.equal(actor.actor_id, saved.setup.actor_id)
    evidence.world = await native('world_identity')
    assert.equal(evidence.world.world_id, saved.worldId)
    evidence.rebind = await native('bind_world_id', randomUUID())
    assert.equal(evidence.rebind.ok, false); assert.equal(evidence.rebind.world_id, saved.worldId)
    const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: saved.worldId }); memory.restore(saved.snapshot)
    const w = host(memory, saved.setup, actor); await w.observer.initializeWorld()
    evidence.compatible = await compare(memory, w.observer, saved.cell, saved.members, 'compatible')
    assert.equal(memory.getFactoryRegistry().cells[0].state, 'unverified')
  }
  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
  console.log(`PASS: factory-cell ${phase}; bounded native facts, immutable assignments and world binding`)
}
catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  connection?.close()
  await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, `factory-cell-${phase}.json`), JSON.stringify({ ...evidence, forbiddenFetchCalls }, null, 2))
  await fs.writeFile(path.join(results, `factory-cell-${phase}-transcript.json`), JSON.stringify(trace, null, 2))
}
