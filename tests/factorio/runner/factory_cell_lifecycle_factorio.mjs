#!/usr/bin/env node
// Deterministic isolated native proof. No providers/humans; parent owns Docker,
// exact mod/source identities, save verification and resource teardown.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); if (index < 0) { assert.notEqual(fallback, undefined, `missing --${name}`); return fallback } return process.argv[index + 1] }
const repo = path.resolve(arg('repo')); const results = path.resolve(arg('results'))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon } = await load('runtime-v8/common.mjs')
const { luaString, parseOperation, toolCommand } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { createFactoryRegistry, registerFactoryCell, factoryMetadataDigest: digest } = await load('runtime-v8/factory-registry.mjs')
const { getActivePlan } = await load('runtime-v8/planning-state.mjs')
const { operationIdentity } = await load('runtime-v8/operation-reconciliation.mjs')
const { prepareFactoryCellHost } = await load('runtime-v8/factory-cell-tools.mjs')
const { beginFactoryCellLifecycle, reconcileFactoryCellLifecycle, declareFactoryTemporaryAsset } = await load('runtime-v8/factory-cell-lifecycle-controller.mjs')
const KEY = 'npc:factory-lifecycle-native'
const evidence = { status: 'failed', mode: 'scripted_native_host_lifecycle', providers: 0, fixture: 'Declared synthetic stock and initial furnace; all recipe, fuel and placement amounts queried live.' }
const transcript = []; const events = []; let connection; let agent
globalThis.fetch = async () => { evidence.providers++; throw new Error('Inference forbidden') }
const rcon = { command: async command => { const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => { const raw = await rcon.command(`/silent-command ${body}`); try { return JSON.parse(raw) } catch { throw new Error(`native JSON invalid: ${raw}`) } }
const tool = async (name, args = {}) => JSON.parse(await rcon.command(toolCommand(name, args)))
const loc = row => Object.fromEntries(['unit_number', 'name', 'position', 'surface_index', 'force_index'].map(key => [key, row[key]]))
const exactLua = locator => `local s=game.surfaces[${locator.surface_index}];local e;for _,v in pairs(s.find_entities_filtered{name=${luaString(locator.name)},position={${locator.position.x},${locator.position.y}},force=${locator.force_index},limit=9}) do if v.unit_number==${locator.unit_number} and v.position.x==${locator.position.x} and v.position.y==${locator.position.y} then assert(not e);e=v end end;`
async function settle() {
  const deadline = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus')
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) {
      await agent.taskStatusReceipt()
      assert.equal(agent.memory.pendingOperations(KEY).length, 0, JSON.stringify(status))
      return status
    }
    assert.ok(Date.now() < deadline, 'native operation deadline'); await delay(100)
  }
}
async function operation(raw, lifecycle = false) {
  const parsed = parseOperation(raw)
  const owner = agent.captureCheckpointOwner()
  const result = lifecycle ? await agent.executeFactoryLifecycleOperation(parsed)
    : await agent.commitPlan({ chatMessage: '', stepId: owner.stepId, plan: [], currentStep: 0, operations: [parsed] })
  const status = await settle()
  evidence.operations ??= []; evidence.operations.push({ raw, result, status })
  return status
}
async function candidates(center) {
  const choices = await tool('getPlacementCandidates', { entity_name: 'wooden-chest', center, radius: 3, limit: 4 })
  assert.ok(choices.candidates?.length, JSON.stringify(choices)); const candidate = choices.candidates[0]
  return { candidate, operation: parseOperation({ name: 'place_candidate', args: { candidate_set_id: choices.candidate_set_id, candidate_id: candidate.id } }) }
}
function change(memory, cell, id, kind, operations) {
  const registry = memory.getFactoryOperationalRegistry()
  return { transaction_id: id, cell_id: cell.cell_id, kind, assignment: structuredClone(cell.assignment), operations,
    action_limit: operations.length + 1, expected_registry_revision: registry.revision, expected_lifecycle_revision: memory.factoryLifecycleRevision(),
    expected_cells: [{ cell_id: cell.cell_id, revision: cell.revision, digest: digest(cell) }] }
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password', 'offline-fixture-only'), 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect(); assert.match(await rcon.command('/version'), /2\.0\.77/)
  await configureNpcSession(rcon, 'factory-lifecycle-native-20261029')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const setup = await lua(`local a;for _,s in pairs(game.surfaces) do for _,e in pairs(s.find_entities_filtered{type="character",limit=128}) do if e.unit_number==${actor.actor_id} then a=e end end end;assert(a);assert(#game.connected_players==0);game.speed=1;game.tick_paused=false;
    local s=a.surface;local x=math.floor(a.position.x);local y=math.floor(a.position.y);local tiles={};for xx=x-12,x+12 do for yy=y-12,y+12 do tiles[#tiles+1]={name="landfill",position={xx,yy}} end end;s.set_tiles(tiles,true,false,true);
    for _,e in pairs(s.find_entities_filtered{area={{x-10,y-10},{x+10,y+10}}}) do if e.type~="character" and e.name~="sgluna-npc-vision" then e.destroy() end end;
    local f=s.create_entity{name="stone-furnace",position={x+5,y},force=a.force};assert(f);
    local choices={};for name,r in pairs(a.force.recipes) do if r.enabled and f.prototype.crafting_categories[r.category] and #r.ingredients==1 and r.ingredients[1].type=="item" and #r.products==1 and r.products[1].type=="item" and r.products[1].amount and (not r.products[1].probability or r.products[1].probability==1) then choices[#choices+1]=name end end;table.sort(choices);local recipe=a.force.recipes[choices[1]];assert(recipe);
    local fuelNames={};for name,p in pairs(prototypes.item) do if p.fuel_value>0 and f.prototype.burner_prototype.fuel_categories[p.fuel_category] then fuelNames[#fuelNames+1]=name end end;table.sort(fuelNames);local fuel=fuelNames[1];assert(fuel);
    local ing=recipe.ingredients[1];local cycles=4;assert(f.get_inventory(defines.inventory.furnace_source).insert{name=ing.name,count=math.ceil(ing.amount*cycles)}==math.ceil(ing.amount*cycles));assert(f.get_fuel_inventory().insert{name=fuel,count=1}==1);
    local inv=a.get_main_inventory();inv.clear();local place=prototypes.entity["wooden-chest"].items_to_place_this;assert(place and #place==1);assert(inv.insert{name=place[1].name,count=place[1].count*4}==place[1].count*4);
    rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index,force_index=a.force.index,origin={x=x,y=y},healthy={unit_number=f.unit_number,name=f.name,position=f.position,surface_index=s.index,force_index=f.force.index},recipe={name=recipe.name,ingredients=recipe.ingredients,products=recipe.products},fuel=fuel,placement_items=place,synthetic_cycles=cycles,humans=#game.connected_players,speed=game.speed}))`)
  evidence.setup = setup
  let produced; const deadline = Date.now() + 60000
  for (;;) {
    produced = await lua(`${exactLua(setup.healthy)}assert(e);local n=e.get_inventory(defines.inventory.furnace_result).get_item_count(${luaString(setup.recipe.products[0].name)});if n>0 then e.active=false end;rcon.print(helpers.table_to_json({count=n,tick=game.tick,products_finished=e.products_finished}))`)
    if (produced.count > 0) break
    assert.ok(Date.now() < deadline, 'fixture did not produce live selected output'); await delay(100)
  }
  evidence.initial_production = produced
  const world = await lua(`local id=storage.sgluna_factory_world_id;if not id then id=${luaString(randomUUID())} end;rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",id)))`)
  assert.equal(world.ok, true)
  const memory = new CanonicalTaskBoardMemory({ expectedFactoryWorldId: world.world_id })
  const contract = { mode: 'all', requirements: [{ id: 'healthy-output', kind: 'entity_inventory_count', unit_number: setup.healthy.unit_number,
    item_name: setup.recipe.products[0].name, minimum: produced.count + 1 }] }
  memory.recordPlan(KEY, { sender: 'owner', text: 'Keep the assigned native furnace output while expanding and removing a redundant container; clean the declared temporary asset after its beneficiary completes.' }, {
    chatMessage: '', plan: ['Preserve the healthy output and retire redundant temporary support'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', checkpoint: contract }],
  }, { validatedPlannerAdmission: true }); memory.commitPlanningPlan(KEY, { runtime_validation: { passed: true } })
  const registry = registerFactoryCell(createFactoryRegistry(world.world_id), { surface_index: setup.surface_index, force_index: setup.force_index,
    assignment: { products: [setup.recipe.products[0].name], purpose: 'Retain exact native furnace output', method: 'Declared initial synthetic native production fixture' },
    members: [{ ...setup.healthy, provenance: { source: 'declared_synthetic_native_fixture' } }],
    ports: [{ port_id: 'output', direction: 'output', kind: 'item', resource: setup.recipe.products[0].name }], origin: { source: 'declared_synthetic_native_fixture' } })
  memory.restore({ ...memory.snapshot(), factory_registry_world_id: world.world_id, factory_registry: registry })
  agent = new NpcAgentLoop({ rcon, memory, stateFile: path.join(results, 'canonical-state.json'), traceFile: null, decisionTraceFile: null,
    npcId: 'factory-lifecycle-native', completionProtocolVersion: 3, jevCheckpoints: false, provider: async () => { evidence.providers++; throw new Error('Inference forbidden') } })
  agent.active = true; agent.epoch = { ...actor }; agent.requestInfo = { memoryKey: KEY }; agent.traceRequest = { id: 'native-lifecycle-host', seq: 0 }
  agent.turnConversation = agent.agentContext.beginRequest(0); agent.behaviorTrace = { emit: async row => events.push(row) }
  const semantics = () => {
    const state = memory.planningState(KEY)
    return { goal: Object.fromEntries(['goal_id', 'objective', 'constraints', 'definition'].filter(key => state.goal[key] !== undefined).map(key => [key, state.goal[key]])),
      plans: state.plans.map(plan => ({ plan_id: plan.plan_id, plan_version: plan.plan_version, steps: plan.steps.map(step =>
        Object.fromEntries(['step_id', 'semantic_step_id', 'description', 'execution_guidance', 'completion_contract'].filter(key => step[key] !== undefined).map(key => [key, step[key]]))) })) }
  }
  const immutable = structuredClone(semantics())
  await agent.persistState({ strict: true })
  // Use the production C3 handoff: constructing an agent starts a planner,
  // whose protocol-3 role must never be allowed to author gameplay operations.
  evidence.executor_handoff = await agent.startExecutorAtCommit({ planId: getActivePlan(memory.planningState(KEY)).plan_id, requestId: agent.traceRequest.id })
  assert.equal(evidence.executor_handoff.restaged, true, JSON.stringify(evidence.executor_handoff))
  assert.equal(agent.agentContext.role, 'executor'); assert.equal(agent.agentContext.hasParkedPlanner, true)
  const extra = await candidates({ x: setup.origin.x + 3, y: setup.origin.y + 4 })
  const expanded = change(memory, registry.cells[0], 'native-expand', 'expand', [{ kind: 'add', name: 'wooden-chest', position: extra.candidate.position, operation: extra.operation }])
  await beginFactoryCellLifecycle(agent, expanded); await operation(extra.operation, true); await reconcileFactoryCellLifecycle(agent, expanded.transaction_id)
  let cell = memory.getFactoryOperationalRegistry().cells[0]; const added = cell.members.find(row => row.unit_number !== setup.healthy.unit_number); assert.ok(added)
  const nativeAdded = await prepareFactoryCellHost(agent, observer => observer.observe({ cell_id: cell.cell_id })).execute()
  const quality = nativeAdded.native.members.find(row => row.locator.unit_number === added.unit_number)?.removal_readiness?.snapshot?.target?.quality
  assert.equal(typeof quality, 'string')
  const modified = change(memory, cell, 'native-remove-redundant', 'modify', [{ kind: 'remove', member: added, quality, operation: { name: 'mine_entity_exact', args: { unit_number: added.unit_number } } }])
  await beginFactoryCellLifecycle(agent, modified); await operation(modified.operations[0].operation, true); await reconcileFactoryCellLifecycle(agent, modified.transaction_id)
  cell = memory.getFactoryOperationalRegistry().cells[0]; assert.equal(cell.members.length, 1); assert.equal(cell.members[0].unit_number, setup.healthy.unit_number)
  assert.deepEqual(semantics(), immutable)
  const temporary = await candidates({ x: setup.origin.x - 3, y: setup.origin.y + 4 })
  const state = memory.planningState(KEY); const plan = getActivePlan(state); const step = plan.steps[plan.active_step_index]
  await declareFactoryTemporaryAsset(agent, { intent_id: 'native-temporary-support', classification: 'temporary', purpose: 'Temporary support for the original native output beneficiary',
    retirement_condition: 'beneficiaries_complete_and_redundant', placement_intent_digest: operationIdentity(temporary.operation),
    placement: { name: 'wooden-chest', position: temporary.candidate.position, surface_index: setup.surface_index, force_index: setup.force_index, operation: temporary.operation },
    beneficiaries: [{ goal_id: state.goal.goal_id, semantic_step_id: step.semantic_step_id ?? step.step_id }] })
  await operation(temporary.operation)
  assert.equal(memory.factoryTemporaryAssets().length, 1)
  // Synthetic initial hardware has no placement receipt/native exact-reference
  // hint. Use ordinary bounded discovery; factory observation is deliberately
  // read-only and cannot manufacture the checkpoint resolver's reference cache.
  await agent.handleToolBatch({ content: '', tool_calls: [{ id: 'discover-healthy-checkpoint', type: 'function',
    function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 12, name: setup.healthy.name, limit: 8 }) } }] })
  assert.ok(agent.liveObservedExactTarget(setup.healthy.unit_number), 'healthy checkpoint target must be rebound by actual discovery')
  await lua(`${exactLua(setup.healthy)}assert(e);e.active=true;rcon.print(helpers.table_to_json({tick=game.tick,synthetic_fixture_production_gate_released=true}))`)
  const closeDeadline = Date.now() + 60000
  for (;;) {
    const closed = await agent.closeActiveStepOnFreshRead({ previousState: memory.currentPlan(KEY), trigger: 'native_lifecycle_proof', operations: [] })
    evidence.close = closed
    if (closed.closed) break
    assert.ok(!closed.contractPause && Date.now() < closeDeadline, JSON.stringify(closed)); await delay(150)
  }
  assert.equal(memory.factoryLifecycleTransactions().filter(tx => tx.kind === 'cleanup' && tx.state === 'retired').length, 1)
  assert.equal(memory.pendingOperations(KEY).length, 0)
  assert.deepEqual(semantics(), immutable)
  evidence.final_snapshot = memory.snapshot()
  evidence.healthy = await lua(`${exactLua(setup.healthy)}assert(e);rcon.print(helpers.table_to_json({unit_number=e.unit_number,products_finished=e.products_finished,recipe=e.get_recipe() and e.get_recipe().name,humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(evidence.healthy.unit_number, setup.healthy.unit_number); assert.ok(evidence.healthy.products_finished > produced.products_finished)
  assert.equal(evidence.providers, 0); assert.equal(evidence.healthy.humans, 0); assert.equal(evidence.healthy.speed, 1)
  evidence.status = 'pass'; console.log('PASS: actual host lifecycle expansion, removal custody, verified beneficiary close and automatic temporary cleanup')
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  if (connection) { try { evidence.final_native = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))') } catch (error) { evidence.final_native_error = String(error) } connection.close() }
  await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'lifecycle.json'), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, 'transcript.json'), JSON.stringify(transcript, null, 2)); await fs.writeFile(path.join(results, 'events.json'), JSON.stringify(events, null, 2))
}
