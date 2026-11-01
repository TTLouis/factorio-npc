#!/usr/bin/env node
// Deterministic native contract proof. Fixture-only entities/stock, zero humans,
// 1x speed, no inference. Production growth may change inventories while the
// preservation projection stays stable; native rotation/force/surface/identity
// changes must not pass that projection.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand, parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { preservationGeometry, preservedProofMatches, compileObligations } from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { answersStepContract, planReply } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('live inference forbidden in preservation geometry fixture') }

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', source: 'native_exact_geometry', transcript: [] }
let connection
const rcon = { command: async command => {
  const response = await connection.command(command)
  evidence.transcript.push({ command, response })
  return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a; for _,s in pairs(game.surfaces) do local chars=s.find_entities_filtered{name="character"}; if #chars>0 then a=chars[1]; break end end; assert(a); ${body}`))
const geometry = async id => JSON.parse(await rcon.command(toolCommand('getEntityGeometry', { unit_number: id })))
async function operation(label, op) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const admission = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation(op))])
  const until = Date.now() + 120000
  for (;;) {
    const status = JSON.parse(await rcon.command(toolCommand('getTaskStatus', {})))
    if (status.task_state === 'idle' && status.queue_length === 0) {
      assert.equal(status.basic_operation?.last_result?.completed, true, `${label}: native operation completed`)
      return { admission, status }
    }
    assert.ok(Date.now() < until, `${label}: native operation timed out`)
    await delay(100)
  }
}
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  await configureNpcSession(rcon, 'contract-obligation-engine-20261025')
  const version = JSON.parse(await fsp.readFile('/opt/factorio/data/base/info.json', 'utf8')).version
  assert.equal(version, '2.0.77')
  evidence.factorio_version = version
  const fixture = await lua(`local s=a.surface; local ox=math.floor(a.position.x)+16; local oy=math.floor(a.position.y); game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{ox-4,oy-4},{ox+10,oy+6}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={}; for x=ox-4,ox+10 do for y=oy-4,oy+6 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);
    local f=s.create_entity{name="stone-furnace",position={ox+4,oy},force=a.force};
    for x=ox+4,ox+5 do for y=oy+1,oy+2 do s.create_entity{name="iron-ore",position={x+0.5,y+0.5},amount=1000} end end;
    local d=s.create_entity{name="burner-mining-drill",position={ox+5,oy+2},direction=defines.direction.north,force=a.force}; assert(f and d);
    a.get_main_inventory().clear(); assert(a.insert{name="coal",count=2}==2);
    storage.contract_obligation_fixture={f=f,d=d,x=a.position.x,y=a.position.y,s=s};
    remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100);
    rcon.print(helpers.table_to_json({furnace=f.unit_number,drill=d.unit_number,actor=a.unit_number,surface=s.index,force=a.force.index,humans=#game.connected_players,speed=game.speed,
      unfueled_drill=remote.call("autorio_knowledge","entity_geometry",d.unit_number),unfueled_furnace=remote.call("autorio_knowledge","entity_geometry",f.unit_number),iron_plates=f.get_item_count("iron-plate")}))`)
  evidence.fixture = fixture
  assert.equal(fixture.humans, 0)
  assert.equal(fixture.speed, 1)
  assert.equal(fixture.iron_plates, 0)
  const unfueled = { intent_signature: 'native-bootstrap', actor_id: fixture.actor, actor_epoch: 1,
    preserved: [preservationGeometry(fixture.unfueled_furnace, fixture.furnace), preservationGeometry(fixture.unfueled_drill, fixture.drill)] }
  assert.equal(unfueled.preserved[1].item_io.drop_target, null, 'native bootstrap begins with a genuinely unresolved lazy target')
  const fuelingActor = await deploymentStatus(rcon, { requireAllowed: true })
  await executeAuthorizedBatch(rcon, fuelingActor.epoch, [fixture.drill, fixture.furnace].map(unit_number =>
    renderOperation(parseOperation({ name: 'supply_entity', args: { unit_number, items: [{ item_name: 'coal', count: 1 }] } }))))
  const deadline = Date.now() + 25000
  let produced = 0
  while (Date.now() < deadline) {
    produced = await lua('rcon.print(storage.contract_obligation_fixture.f.get_item_count("iron-plate"))')
    if (produced > 0) break
    await delay(100)
  }
  assert.ok(produced > 0, 'native direct-feed mining/smelting must actually produce an iron plate')
  const before = preservationGeometry(await geometry(fixture.drill), fixture.drill)
  const furnace = preservationGeometry(await geometry(fixture.furnace), fixture.furnace)
  assert.equal(before.actor_id, fixture.actor)
  assert.equal(before.surface_index, fixture.surface)
  assert.equal(before.force_index, fixture.force)
  assert.equal(before.item_io.drop_target.unit_number, fixture.furnace)
  assert.equal(furnace.entity.unit_number, fixture.furnace)
  const producing = { ...unfueled, preserved: [furnace, before] }
  assert.equal(preservedProofMatches(unfueled, producing), true, 'only fresh native target resolution to the existing preserved furnace refines unknown')
  assert.equal(preservedProofMatches(producing, unfueled), false, 'resolved native knowledge cannot regress to unknown')
  evidence.bootstrap = { unfueled, producing, first_action: 'two_native_supply_entity_operations', output_before_first_fuel: 0 }
  const initialOutput = produced
  while (produced === initialOutput && Date.now() < deadline) {
    await delay(100)
    produced = await lua('rcon.print(storage.contract_obligation_fixture.f.get_item_count("iron-plate"))')
  }
  assert.ok(produced > initialOutput, 'additional normal native production must occur between geometry samples')
  assert.deepEqual(preservationGeometry(await geometry(fixture.drill), fixture.drill), before, 'normal native production preserves geometry')
  evidence.production = { iron_plates: produced, geometry: before }
  // BD's missing composition: ordinary native work can leave an otherwise
  // unchanged preservation set outside visible chunks. Travel is an operation,
  // never fixture teleportation; the only supplied stock above was the fuel.
  const travel = await lua(`local v=storage.contract_obligation_fixture; local x=v.f.position.x>=0 and -105 or 105; local y=105;
    local tiles={}; for tx=math.floor(math.min(v.x,x))-4,math.ceil(math.max(v.x,x))+4 do for ty=math.floor(math.min(v.y,y))-4,math.ceil(math.max(v.y,y))+4 do tiles[#tiles+1]={name="landfill",position={tx,ty}} end end; v.s.set_tiles(tiles,true,false,true);
    for _,e in pairs(v.s.find_entities_filtered{area={{math.min(v.x,x)-4,math.min(v.y,y)-4},{math.max(v.x,x)+4,math.max(v.y,y)+4}}}) do if e~=v.f and e~=v.d and e.type~="character" and e.name~="iron-ore" then e.destroy() end end;
    assert(v.s.create_entity{name="copper-ore",position={x+0.5,y+0.5},amount=100});
    rcon.print(helpers.table_to_json({home={x=v.x,y=v.y},remote={x=x,y=y},copper_before=a.get_item_count("copper-ore")}))`)
  assert.equal(travel.copper_before, 0)
  const outward = await operation('leave protected cell', { name: 'walk_to_position', args: { ...travel.remote, reach_distance: 2 } })
  await delay(250)
  const hidden = await geometry(fixture.drill)
  assert.equal(hidden.found, false)
  assert.equal(hidden.code, 'entity_not_visible', 'public geometry refuses the old protected cell in fog')
  assert.throws(() => preservationGeometry(hidden, fixture.drill), /preservation_/)
  const gathered = await operation('remote copper gathering', { name: 'gather_resource', args: { resource_name: 'copper-ore', count: 2, search_radius: 8 } })
  const copper = await lua('rcon.print(a.get_item_count("copper-ore"))')
  assert.equal(copper, 2, 'native gathering actually produced the requested ore')
  const homeward = await operation('return for fresh preservation proof', { name: 'walk_to_position', args: { ...travel.home, reach_distance: 2 } })
  await delay(250)
  const reacquired = { ...producing, preserved: [preservationGeometry(await geometry(fixture.furnace), fixture.furnace), preservationGeometry(await geometry(fixture.drill), fixture.drill)] }
  assert.equal(preservedProofMatches(producing, reacquired), true, 'fresh same-identity geometry matches after native return')
  assert.equal(await lua('rcon.print(a.get_item_count("copper-ore"))'), copper, 'return/reobservation never replays completed gathering')
  evidence.visibility_reacquisition = { travel, outward, hidden, gathered, copper, homeward, reacquired,
    scope: 'native mechanics and contract projection; runtime automatic recovery is tested separately' }
  // Actual loop, scripted model replies, native receipts and the same committed
  // preservation baseline. There is no operator-directed return in this case.
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  const key = 'npc:preservation-native'
  const obligations = { outcome: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 4 }] }, preserve: [fixture.drill, fixture.furnace].sort((a, b) => a - b) }
  let plannerCalls = 0
  let executorCalls = 0
  const agent = new NpcAgentLoop({ rcon, memory, npcId: 'preservation-native', completionProtocolVersion: 3,
    replacementWake: true, requireTypedObligations: true, stateFile: path.join(results, 'preservation-native-state.json'),
    traceFile: null, decisionTraceFile: null, systemPrompt: 'Deterministic preservation recovery fixture, no live inference.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      if (context.role === 'planner') {
        assert.equal(++plannerCalls, 1, 'recovery does not ask the planner to repair preservation')
        return planReply({ plan: ['Gather two more copper ore while preserving the existing iron cell.'], currentStep: 0, operations: [],
          goal: { scope: 'finite', summary: 'Hold four copper ore while preserving the iron cell.', doneWhen: obligations.outcome.requirements },
          stepCompletions: [{ kind: 'deterministic', checkpoint: compileObligations(obligations), obligations }],
          executionGuidance: [{ approach: 'Gather two copper ore from the remote fixture patch.', rationale: 'Native travel and gathering under unchanged preservation.', constraints: [], skillIds: [], materialSupply: { mode: 'manual_bootstrap', resource: 'copper-ore' } }] })
      }
      assert.equal(++executorCalls, 1, 'completed gathering must not be proposed again')
      const plan = getActivePlan(memory.planningState(key))
      return planReply({ stepId: plan.steps[plan.active_step_index].step_id,
        operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 2, search_radius: 256 } }] })
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  evidence.composed_recovery = { status: 'started', events: rows }
  try {
    const requested = await agent.request('Hold four copper ore while preserving the existing iron cell.', { sender: 'Louis' })
    const originalPlan = structuredClone(getActivePlan(memory.planningState(key)))
    assert.ok(originalPlan, JSON.stringify(requested))
    const until = Date.now() + 180000
    let result = requested
    while (Date.now() < until) {
      const status = JSON.parse(await rcon.command(toolCommand('getTaskStatus', {})))
      if (status.task_state !== 'idle' || status.queue_length !== 0) { await delay(100); continue }
      result = await agent.completed()
      if (memory.planningState(key)?.goal?.status === 'completed' || result?.goalStatus === 'completed') break
      assert.notEqual(result?.goalStatus, 'paused', JSON.stringify({ result, rows: rows.slice(-8) }))
      await delay(100)
    }
    assert.equal(memory.planningState(key)?.goal?.status, 'completed', JSON.stringify({ result, rows: rows.slice(-8) }))
    assert.equal(await lua('rcon.print(a.get_item_count("copper-ore"))'), 4)
    assert.ok(rows.some(row => row.event === 'contract.preservation_recovery_admitted'), 'real loop admitted native return navigation')
    assert.ok(rows.some(row => row.event === 'contract.preservation_recovery_completed'), 'fresh native geometry completed preservation recovery')
    assert.equal(rows.some(row => row.event === 'contract.preservation_recovery_exhausted' || row.event === 'request.failed'), false)
    const finalPlan = memory.planningState(key).plans.find(plan => plan.plan_id === originalPlan.plan_id)
    assert.deepEqual(finalPlan.steps.map(step => step.obligation_proof), originalPlan.steps.map(step => step.obligation_proof), 'recovery never replaces the immutable baseline')
    evidence.composed_recovery = { requested, result, originalPlan, plannerCalls, executorCalls, events: rows,
      planning: memory.planningState(key), scope: 'real NpcAgentLoop, scripted replies, native gather/navigation/receipts; zero providers' }
    console.log('PASS native preservation recovery: remote gathering, automatic native return, immutable proof, exact-once inventory and goal completion')
  } finally {
    evidence.composed_recovery.events = rows
    evidence.composed_recovery.planning = memory.planningState(key)
    agent.cancel('fixture_cleanup')
  }
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation({ name: 'rotate_entity', args: { unit_number: fixture.drill } }))])
  for (let n = 0; n < 100; n++) {
    const status = JSON.parse(await rcon.command(toolCommand('getTaskStatus', {})))
    if (status.task_state === 'idle' && status.queue_length === 0) break
    await delay(50)
  }
  const rotated = await geometry(fixture.drill)
  assert.notEqual(rotated.entity.direction, before.entity.direction, 'the native drill really rotated')
  assert.equal(preservedProofMatches(producing, { ...producing, preserved: [furnace, preservationGeometry(rotated, fixture.drill)] }), false,
    'rotation/lost target cannot replace already-established native preservation')
  evidence.rotated = rotated
  await lua('storage.contract_obligation_fixture.f.force=game.forces.enemy; rcon.print("{}")')
  const foreign = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(foreign, fixture.furnace), /preservation_geometry_unproven/)
  evidence.foreign = foreign
  await lua('local v=storage.contract_obligation_fixture; v.f.force=a.force; remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100); local other=game.create_surface("obligation-other",{width=32,height=32}); other.request_to_generate_chunks({0,0},1); other.force_generate_chunk_requests(); local tiles={}; for x=-3,3 do for y=-3,3 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; other.set_tiles(tiles,true,false,true); assert(a.teleport({0,0},other)); rcon.print("{}")')
  const away = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(away, fixture.furnace), /preservation_geometry_unproven/)
  evidence.other_surface = away
  await lua('local v=storage.contract_obligation_fixture; assert(a.teleport({v.x,v.y},v.s)); local p=v.f.position; v.f.destroy(); v.replacement=v.s.create_entity{name="stone-furnace",position=p,force=a.force}; assert(v.replacement); rcon.print("{}")')
  const stale = await geometry(fixture.furnace)
  assert.throws(() => preservationGeometry(stale, fixture.furnace), /preservation_geometry_unproven/)
  evidence.stale = stale
  evidence.status = 'pass'
  console.log('PASS native 2.0.77 obligation geometry: production, item route, rotation, force/surface and stale identity')
} finally {
  if (connection) {
    try { await lua('local v=storage.contract_obligation_fixture; if v then if a.surface~=v.s then a.teleport({v.x,v.y},v.s) end; for _,e in pairs({v.f,v.d,v.replacement}) do if e and e.valid then e.destroy() end end end; local other=game.get_surface("obligation-other"); if other then game.delete_surface(other) end; rcon.print("{}")') } catch (error) { evidence.cleanup_error = error.message }
    connection.close()
  }
  await fsp.mkdir(results, { recursive: true })
  await fsp.writeFile(path.join(results, 'contract-obligation-geometry.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
