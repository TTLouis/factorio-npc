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
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { captureFactoryPlacementContext } from '../pterodactyl/runtime-v8/factory-placement-provenance.mjs'
import { ensureCommittedFactoryCellBeforeClose } from '../pterodactyl/runtime-v8/factory-cell-enrollment.mjs'

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
async function operation(name, args, tracking) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const parsed = parseOperation({ name, args })
  let pending, captured, preflight
  if (tracking) {
    const state = tracking.memory.planningState(KEY)
    const plan = state.plans.find(row => ['COMMITTED', 'EXECUTING'].includes(row.status))
    assert.ok(plan)
    const ordinal = (state.operation_ledger?.sequence ?? 0) + 1
    const requestId = `native-placement-${ordinal}`
    preflight = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_preflight","operation",${luaString(name)},helpers.json_to_table(${luaString(JSON.stringify(args))}))))`)
    assert.equal(preflight.ok, true, JSON.stringify(preflight))
    tracking.agent.traceRequest = { id: requestId, seq: 0 }
    pending = await tracking.agent.recordPendingOperationBeforeSend([parsed], actor, [preflight])
    assert.ok(pending)
    captured = captureFactoryPlacementContext(tracking.memory, KEY, actor)
    assert.equal(captured?.candidates.length, 1)
  }
  const admission = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parsed)], undefined, pending)
  const deadline = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) {
      const receipt = status.basic_operation?.last_result
      assert.equal(receipt?.completed, true, JSON.stringify(status))
      let retained
      if (tracking) {
        assert.equal(receipt.placed_world_id, tracking.memory.factoryWorldBinding().world_id)
        assert.equal(receipt.placed_force_index, tracking.setup.force_index)
        assert.equal(receipt.placed_surface_index, tracking.setup.surface_index)
        assert.equal(receipt.actor_id, actor.actor_id)
        assert.equal(receipt.actor_kind, 'standalone_character')
        assert.ok(receipt.placed_last_user == null)
        for (const field of ['batch_id', 'batch_generation', 'batch_ref']) assert.equal(receipt[`placed_${field}`], status.last_completed_batch[field])
        const settlement = await tracking.agent.taskStatusReceipt()
        assert.equal(settlement.view.status_error, undefined, JSON.stringify(settlement))
        const receiptId = `${receipt.placed_world_id}/${receipt.placed_batch_ref}/${receipt.operation_id}`
        retained = { status: 'recorded', receipt: tracking.memory.factoryPlacementReceipt(receiptId) }
        assert.ok(retained.receipt)
        assert.equal(tracking.memory.pendingOperations(KEY).length, 0)
      }
      evidence.operations.push({ name, args, admission, receipt, ...(tracking ? { preflight, pending, captured, retained, terminal_status: status } : {}) })
      return receipt
    }
    assert.ok(Date.now() < deadline, `${name} timed out`); await delay(100)
  }
}
async function place(name, request, tracking) {
  const candidates = await tool('getPlacementCandidates', { entity_name: name, limit: 4, ...request })
  assert.ok(candidates.candidates?.length, JSON.stringify(candidates))
  const candidate = candidates.candidates[0]
  const receipt = await operation('place_candidate', { candidate_set_id: candidates.candidate_set_id, candidate_id: candidate.id }, tracking)
  assert.ok(receipt.placed_unit_number)
  return { candidate, receipt }
}
const KEY = 'npc:factory-cell-native'
function task(memory, resource) {
  const checkpoint = { mode: 'all', requirements: [{ id: 'held', kind: 'inventory_count', item_name: resource === 'copper-ore' ? 'copper-plate' : 'iron-plate', minimum: 1 }] }
  memory.recordPlan(KEY, { sender: 'owner', text: `Build dedicated ${resource} production without converting assigned suppliers` }, {
    chatMessage: 'Use live native production facts.', plan: ['Inspect dedicated production'], currentStep: 0, operations: [],
    executionGuidance: [{ approach: 'Inspect the assigned source and its exact native output route.', rationale: 'Keep each accepted production assignment.', constraints: [], skillIds: [], materialSupply: { mode: 'direct_feed', resource }, cellIntent: { kind: 'direct_feed', product: resource === 'copper-ore' ? 'copper-plate' : 'iron-plate', sourceEntity: 'burner-mining-drill', targetEntity: 'stone-furnace', purpose: 'Retain the dedicated supplier' } }],
    stepCompletions: [{ kind: 'deterministic', checkpoint }],
  }, { validatedPlannerAdmission: true })
  memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
}
function host(memory, setup, actor) {
  const context = { surface_index: setup.surface_index, force_index: setup.force_index, actor_id: actor.actor_id, actor_epoch: actor.epoch,
    session_id: actor.session ?? 'factory-cell-native-20261029', request_id: `native-${phase}`, native_idle: true, pending: false, uncertain: false }
  const observer = createFactoryCellObserver({ memory, key: KEY,
    readContext: () => ({ ...context, world_id: memory.factoryWorldBinding().world_id }),
    callNative: native,
    trace: (name, payload) => evidence.events.push({ name, ...payload }) })
  return { observer, context }
}
function enrollmentAgent(memory, actor) {
  const agent = new NpcAgentLoop({ rcon, memory, stateFile: null, traceFile: null, decisionTraceFile: null,
    npcId: 'factory-cell-native', completionProtocolVersion: 3, jevCheckpoints: false,
    provider: async () => { forbiddenFetchCalls++; throw new Error('Inference forbidden') } })
  agent.active = true; agent.epoch = { ...actor }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: `enrollment-${phase}`, seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0)
  agent.behaviorTrace = { emit: async row => { evidence.events.push(row) } }
  agent.persistState = async () => { await fs.writeFile(path.join(results, `canonical-${phase}.json`), JSON.stringify(memory.snapshot(), null, 2)) }
  return agent
}
async function register(memory, agent) {
  const original = JSON.stringify(memory.planningState(KEY))
  // Deterministic proof sampling only: a furnace between executions may report
  // no current recipe. Retain every refused snapshot; never weaken production's
  // unknown-fact pause or alter the game to manufacture compatible evidence.
  const sample = async label => {
    const deadline = Date.now() + 15000
    evidence.enrollment_attempts ??= []
    for (let attempt = 1; ; attempt++) {
      const eventStart = evidence.events.length
      try {
        const result = await ensureCommittedFactoryCellBeforeClose(agent, agent.captureCheckpointOwner())
        evidence.enrollment_attempts.push({ label, attempt, status: 'accepted', result })
        return result
      }
      catch (error) {
        const refusal = evidence.events.slice(eventStart).findLast(row => row.event === 'factory_cell.enrollment_refused')?.data
        evidence.enrollment_attempts.push({ label, attempt, status: 'refused', code: error.code, refusal })
        const dormant = error.code === 'factory_enrollment_native_unverified' && refusal?.state === 'unverified'
          && refusal.codes?.includes('target_recipe_unknown')
          && refusal.codes.every(code => ['native_member_identity_match', 'target_recipe_unknown', 'assigned_product_capability_unverified'].includes(code))
        if (!dormant || Date.now() >= deadline) throw error
        await delay(150)
      }
    }
  }
  const enrolled = await sample('enroll')
  assert.equal(enrolled.ok, true)
  assert.equal(JSON.stringify(memory.planningState(KEY)), original, 'enrollment cannot rewrite the committed plan or close its step')
  const cell = memory.getFactoryRegistry().cells.find(row => row.cell_id === enrolled.cell_id)
  assert.equal(cell.enrollment.receipt_ids.length, 2)
  assert.equal(cell.state, 'unverified')
  const again = await sample('duplicate')
  assert.equal(again.duplicate, true); assert.equal(again.cell_id, cell.cell_id)
  evidence.enrollment = { first: enrolled, duplicate: again,
    coverage: 'Actual production pre-send, post-batch receipt and enrollment helper; full shared applyStepClose checkpoint flow is covered by deterministic host lifecycle tests, not invoked by this native lane.' }
  return cell
}
async function compareBurnerRequirements(nativeResult, members) {
  assert.equal(nativeResult.ok, true)
  evidence.burner_requirement_comparisons ??= []
  for (const locator of members) {
    const row = nativeResult.members.find(member => member.unit_number === locator.unit_number)
    assert.ok(row, 'requirement must belong to the exact observed member')
    assert.equal(row.state, 'observed')
    for (const key of ['name', 'surface_index', 'force_index']) assert.equal(row[key], locator[key])
    assert.deepEqual(row.position, locator.position)
    const requirement = row.burner_fuel_requirement
    assert.ok(requirement)
    assert.equal(requirement.scope, 'burner_fuel_only')
    for (const key of ['supply', 'delivery', 'external_source']) assert.equal(requirement[key], 'unverified')
    // Positive live API corroboration only. The convenience details projection
    // may collapse read errors, so its absence never proves a non-burner here.
    const details = await tool('getPrototypeDetails', { name: row.name })
    assert.equal(details.found, true)
    assert.equal(details.entity.name, row.name)
    assert.ok(details.entity.burner)
    assert.ok(Array.isArray(details.entity.burner.fuel_categories) && details.entity.burner.fuel_categories.length > 0)
    assert.equal(requirement.state, 'known')
    assert.equal(requirement.required, true)
    assert.equal(requirement.truncated, false)
    assert.deepEqual(requirement.fuel_categories, [...details.entity.burner.fuel_categories].sort())
    evidence.burner_requirement_comparisons.push({ request_id: nativeResult.request_id, world_id: nativeResult.world_id,
      tick: nativeResult.tick, locator, requirement, prototype_details: details })
  }
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
  await compareBurnerRequirements(result.native, members)
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
    const memory = new CanonicalTaskBoardMemory(); task(memory, 'copper-ore')
    const immutableIntent = () => JSON.stringify({ goal: memory.planningState(KEY).goal,
      steps: memory.planningState(KEY).plans.map(plan => plan.steps) })
    const originalIntent = immutableIntent()
    const w = host(memory, setup, actor)
    evidence.world = await w.observer.initializeWorld()
    evidence.world_before_placement = await native('world_identity')
    assert.equal(evidence.world_before_placement.world_id, memory.factoryWorldBinding().world_id)
    const agent = enrollmentAgent(memory, actor)
    const tracking = { memory, setup, agent }
    const drill = await place('burner-mining-drill', { center: { x: setup.ox + 5, y: setup.oy }, radius: 4, target_resource: 'copper-ore' }, tracking)
    const furnace = await place('stone-furnace', { covers_position: drill.candidate.item_output_position }, tracking)
    assert.equal(immutableIntent(), originalIntent,
      'automatic placement provenance capture cannot rewrite goal or committed plans')
    evidence.retained_placements = memory.snapshot().factory_placement_receipts
    assert.equal(evidence.retained_placements.length, 2)
    // Neither actual placements nor automatic provenance retention enroll cells.
    assert.deepEqual(memory.getFactoryRegistry().cells, [])
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
    const cell = await register(memory, agent)
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
    for (const row of fixtureRows) {
      assert.equal(row.burner_fuel_requirement.state, 'not_applicable')
      assert.equal(row.burner_fuel_requirement.required, false)
      assert.equal(row.burner_fuel_requirement.truncated, false)
      assert.equal(row.burner_fuel_requirement.supply, 'unverified')
    }
    assert.ok(fixtureRows[0].fluids.storages.some(row => row.current_fluid?.name === 'water' && row.current_fluid.amount > 0))
    assert.ok(fixtureRows[0].fluids.storages.some(row => row.connections.some(edge => edge.state === 'connected' && edge.target?.unit_number === setup.fixtures[1].unit_number)))
    assert.ok(fixtureRows[1].fluids.storages.some(row => row.connections.some(edge => edge.state === 'connected' && edge.target?.unit_number === setup.fixtures[0].unit_number)))
    assert.ok(fixtureRows[2].item_routes.routes.some(edge => edge.kind === 'belt_output' && edge.target?.unit_number === setup.fixtures[3].unit_number))
    assert.ok(fixtureRows[3].item_routes.routes.some(edge => edge.kind === 'belt_input' && edge.target?.unit_number === setup.fixtures[2].unit_number))
    evidence.rebind = await native('bind_world_id', randomUUID())
    assert.equal(evidence.rebind.ok, false); assert.equal(evidence.rebind.world_id, worldId)
    const second = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: worldId }); second.restore(memory.snapshot())
    for (const receipt of evidence.retained_placements) assert.deepEqual(second.factoryPlacementReceipt(receipt.receipt_id), receipt)
    second.clearTaskContext(KEY); task(second, 'iron-ore')
    const iron = host(second, setup, actor); await iron.observer.initializeWorld()
    evidence.iron_mismatch = await compare(second, iron.observer, cell, members, 'mismatch')
    assert.ok(JSON.stringify(evidence.iron_mismatch).includes('mining_source_resource_mismatch'))
    assert.deepEqual(memory.getFactoryRegistry().cells[0].assignment.products, ['copper-plate'])
    await fs.writeFile(statePath, JSON.stringify({ worldId, setup, members, cell, retained_placements: evidence.retained_placements, snapshot: memory.snapshot() }, null, 2))
    const save = path.resolve(arg('save')); const previous = await fs.stat(save)
    assert.equal(path.extname(save), '.zip', 'exact restart save must be a ZIP')
    const saveName = path.basename(save, '.zip')
    assert.match(saveName, /^[A-Za-z0-9_-]+$/, 'explicit safe native save basename')
    const saveReply = await rcon.command(`/silent-command game.server_save(${luaString(saveName)})`)
    assert.ok(!/Cannot execute command|Error:/i.test(saveReply), `native save command refused: ${saveReply}`)
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
    evidence.retained_placements = saved.retained_placements.map(receipt => {
      const restored = memory.factoryPlacementReceipt(receipt.receipt_id)
      assert.deepEqual(restored, receipt)
      assert.equal(restored.world_id, evidence.world.world_id)
      return restored
    })
    assert.equal(evidence.retained_placements.length, 2)
    const w = host(memory, saved.setup, actor); await w.observer.initializeWorld()
    const agent = enrollmentAgent(memory, actor)
    const reEnrolled = await register(memory, agent)
    assert.equal(reEnrolled.cell_id, saved.cell.cell_id)
    assert.equal(memory.getFactoryRegistry().cells.length, 1)
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
