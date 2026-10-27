#!/usr/bin/env node
// Offline native facts only. Fixture terrain/stock are declared setup; every
// construction/fuel action uses normal epoch-checked operations at 1x, no model.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand, parseOperation, renderOperation, renderOperationPreflight, luaString } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { preservationGeometry, preservedProofMatches } from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import { constructionPlanWitnessCommand, nonfluidConstructionWitness } from '../pterodactyl/runtime-v8/contract-obligation-runtime.mjs'
import { BATCH_FOOTPRINT_OVERLAP_CODE, batchFootprintOverlap } from '../pterodactyl/runtime-v8/batch-footprint.mjs'
import { buildPendingOperation, batchWatermark } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { NEXT_SLICE_OWNERSHIP_COMMAND, readNextSliceOwnership } from '../pterodactyl/runtime-v8/supervisor-adapter.mjs'
import { nextSliceOwner, nextSliceNativeState } from '../pterodactyl/runtime-v8/next-slice-liveness.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in fluid preservation fixture') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const evidence = { status: 'fail', factorio: '2.0.77', transcript: [], operations: [] }
let connection
const rcon = { command: async command => {
  // Any authorized batch (admission-journal or plain): the fault runs in the same callback, after the batch was queued.
  if (rcon.queueFault && command.includes('"sgluna_deployment","authorize"') && command.includes('SGLUNA_RESULT_')) {
    const at = command.lastIndexOf('; rcon.print('); assert.ok(at > 0)
    command = `${command.slice(0, at)}; ${rcon.queueFault}${command.slice(at)}`
    rcon.queueFault = undefined
  }
  const response = await connection.command(command); evidence.transcript.push({ command, response }); return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a; for _,s in pairs(game.surfaces) do local c=s.find_entities_filtered{name="character"}; if #c>0 then a=c[1]; break end end; assert(a); ${body}`))
const tool = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const geometry = id => tool('getEntityGeometry', { unit_number: id })
async function worldFacts() {
  const raw = await lua(`local v=storage.fluid_preservation_fixture; local rows={}; for _,e in pairs(v.s.find_entities_filtered{area={{v.ox-14,v.oy-16},{v.ox+26,v.oy+20}}}) do
    if e.type~="character" then rows[#rows+1]={id=e.unit_number or 0,name=e.name,type=e.type,x=e.position.x,y=e.position.y,direction=e.direction,
      stack=e.type=="item-entity" and {name=e.stack.name,count=e.stack.count} or nil} end end;
    rcon.print(helpers.table_to_json({tick=game.tick,entities=rows,inventory=a.get_main_inventory().get_contents(),actor=a.unit_number,position=a.position}))`)
  const status = await tool('getTaskStatus', {})
  const fluids = raw.entities.filter(row => ['offshore-pump', 'boiler', 'steam-engine', 'pipe'].includes(row.name)).sort((a, b) => a.id - b.id)
  const protectedGeometry = []
  for (const row of fluids) protectedGeometry.push(preservationGeometry(await geometry(row.id), row.id))
  // The actor's own vision proxy follows the actor on its own schedule; it is compared by identity, not by its lagging position.
  const entities = raw.entities.map(row => row.name === 'sgluna-npc-vision' ? { id: row.id, name: row.name, type: row.type } : row)
  return { tick: raw.tick, status, world: { actor: raw.actor, position: raw.position,
    entities: entities.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y),
    inventory: raw.inventory.sort((a, b) => a.name.localeCompare(b.name)), protectedGeometry } }
}
async function omittedProofRefusal(name, args, label) {
  let before = await worldFacts()
  const previous = before.status.basic_operation?.last_result
  if (previous?.code === 'placement_candidate_required') {
    const deadline = Date.now() + 2000
    while (before.tick <= previous.tick) { assert.ok(Date.now() < deadline); await delay(25); before = await worldFacts() }
  }
  let error
  try { await operation(name, args) } catch (caught) { error = String(caught) }
  assert.ok(error, `${label}: transport unexpectedly accepted omitted proof`)
  const after = await worldFacts()
  const result = after.status.basic_operation?.last_result
  assert.equal(result?.code, 'placement_candidate_required', error)
  assert.equal(result.accepted, false); assert.equal(result.completed, false)
  assert.ok(result.tick >= before.tick)
  if (previous?.code === 'placement_candidate_required') assert.ok(result.tick > previous.tick, 'unrelated transport failure cannot reuse an old refusal')
  assert.deepEqual(after.world, before.world, `${label}: zero clear/pickup/create/inventory/old-edge change`)
  assert.equal(after.status.queue_length, 0); assert.equal(after.status.task_state, 'idle')
  assert.deepEqual(batchWatermark(after.status), batchWatermark(before.status), `${label}: no queued batch`)
  return { label, error, native_refusal: result, before, after }
}
async function operation(name, args, prepared) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const admission = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(parseOperation({ name, args }))], undefined, prepared?.pending, prepared?.envelope)
  evidence.operations.push({ name, args, admission })
  const deadline = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0) {
      const result = status.basic_operation?.last_result
      assert.equal(result?.completed, true, JSON.stringify(status)); return result
    }
    assert.ok(Date.now() < deadline, `native ${name} timeout`); await delay(100)
  }
}
async function freeze(set, candidate, target) {
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const journal = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')
  const ordinal = journal.high_water + 1
  const owner = { goal_id: 'goal_fluid_native', plan_id: 'goal_fluid_native_p1', plan_version: 1, step_id: `native_step_${ordinal}`,
    semantic_step_id: `native_step_${ordinal}`, actor_id: actor.actor_id, actor_epoch: actor.epoch, session: actor.session }
  const pending = buildPendingOperation({ requestId: 'native-fixture', operationKey: `native-fixture/${ordinal}`, attemptId: `native-fixture/${ordinal}`,
    ordinal, protocolVersion: 2, operations: [{ name: 'place_candidate', args: { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id } }],
    goalId: owner.goal_id, planId: owner.plan_id, stepId: owner.step_id, actor, baseline: batchWatermark(await tool('getTaskStatus', {})), now: Date.now() })
  const context = { signature: pending.signature, owner }
  const guard = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_preflight","fluid_preservation_candidate",${luaString(set.candidate_set_id)},${luaString(candidate.id)},${luaString(pending.operation_key)},{${target}},helpers.json_to_table(${luaString(JSON.stringify(context))}))))`)
  assert.equal(guard.ok, true, JSON.stringify(guard))
  return { pending, envelope: { version: 2, operation_key: pending.operation_key, attempt_id: pending.attempt_id,
    ordinal, signature: pending.signature, owner: Object.fromEntries(Object.entries(owner).filter(([key]) => key !== 'session')), candidate: guard.preservation_join } }
}
async function place(name, request, before) {
  const set = await tool('getPlacementCandidates', { entity_name: name, limit: 8, ...request })
  evidence.candidates ??= []; evidence.candidates.push(set)
  assert.ok(set.candidates?.length, `no native ${name} candidate`)
  const candidate = set.candidates[0]
  const args = { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id }
  const preflight = JSON.parse(await rcon.command(renderOperationPreflight({ name: 'place_candidate', args })))
  let preservedBefore
  let prepared
  if (request.connects_to) assert.equal(preflight.preservation_join?.complete, true, JSON.stringify(preflight))
  if (request.connects_to) {
    prepared = await freeze(set, candidate, request.connects_to.unit_number)
    preflight.preservation_join = prepared.envelope.candidate
    preservedBefore = preservationGeometry(prepared.envelope.candidate.protected_geometry.find(row => row.entity.unit_number === request.connects_to.unit_number), request.connects_to.unit_number)
  }
  if (before) await before(preflight.preservation_join)
  const result = await operation('place_candidate', args, prepared)
  assert.ok(result.placed_unit_number)
  if (preservedBefore) {
    const fresh = preservationGeometry(await geometry(request.connects_to.unit_number), request.connects_to.unit_number)
    const join = preflight.preservation_join.connects_to
    const port = fresh.fluid.storages.find(row => row.index === join.target_port.storage_index).ports.find(row => row.index === join.target_port.connection_index)
    const pair = row => ({ actor_id: row.actor_id, actor_epoch: 1, intent_signature: 'native-addition', preserved: [row] })
    assert.equal(preservedProofMatches(pair(preservedBefore), pair(fresh), { addition: { source_unit_number: join.unit_number,
      source_storage_index: join.target_port.storage_index, source_connection_index: join.target_port.connection_index, endpoint: port.target } }), true,
    JSON.stringify({ message: 'every allowed native additive output must preserve old layout/edges/constraints', preservedBefore, fresh }))
  }
  return { result, candidate, preflight }
}
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); await connection.connect()
  assert.equal(JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json', 'utf8')).version, '2.0.77')
  await configureNpcSession(rcon, 'fluid-preservation-native-20261025')
  const atomicActor = await deploymentStatus(rcon, { requireAllowed: true })
  const probe = { rcon, epoch: atomicActor, generation: 1, agentContext: { lineageSequence: 1 },
    activePlanKey: () => 'native-fixture', memory: { planningState: () => undefined, pendingOperations: () => [] }, batchInFlight: false }
  evidence.atomic_ownership = { command: NEXT_SLICE_OWNERSHIP_COMMAND, dto: await readNextSliceOwnership(rcon),
    normalized: await nextSliceNativeState(probe, nextSliceOwner(probe)) }
  assert.equal(evidence.atomic_ownership.normalized.unknown, false)
  assert.equal(evidence.atomic_ownership.normalized.uncertain, false)
  assert.equal(evidence.atomic_ownership.normalized.busy, false)
  evidence.setup = await lua(`local s=a.surface; local ox=math.floor(a.position.x)+20; local oy=math.floor(a.position.y); game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{ox-14,oy-16},{ox+26,oy+20}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={}; for x=ox-14,ox+26 do for y=oy-16,oy+20 do tiles[#tiles+1]={name=x<ox and "water" or "landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);
    storage.fluid_preservation_fixture={x=a.position.x,y=a.position.y,ox=ox,oy=oy,s=s}; assert(a.teleport({ox+5,oy},s)); a.get_main_inventory().clear();
    for _,item in pairs({{"offshore-pump",2},{"boiler",2},{"steam-engine",1},{"pipe",2},{"coal",5},{"small-electric-pole",2},{"lab",1}}) do assert(a.insert{name=item[1],count=item[2]}==item[2]) end;
    rcon.print(helpers.table_to_json({center={x=ox,y=oy},actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(evidence.setup.humans, 0); assert.equal(evidence.setup.speed, 1)
  evidence.water = await tool('getFluidSourceTiles', { fluid_name: 'water', search_radius: 16, limit: 8 })
  assert.ok(evidence.water.samples?.length)
  evidence.virgin_claim_registry = await lua(`local count=0; for _ in pairs(storage.sgluna_fluid_preservation_claims or {}) do count=count+1 end;
    rcon.print(helpers.table_to_json({count=count,initialized=storage.sgluna_fluid_preservation_claims_initialized==true,
      lua_not_empty_length=not #{},explicit_empty=(#{}==0)}))`)
  assert.deepEqual(evidence.virgin_claim_registry, { count: 0, initialized: false, lua_not_empty_length: false, explicit_empty: true })
  const pump = await place('offshore-pump', { center: evidence.setup.center, radius: 8 })
  evidence.virgin_unguarded_pump = pump.result
  const pumpId = pump.result.placed_unit_number
  const open = preservationGeometry(await geometry(pumpId), pumpId)
  evidence.open = open
  assert.equal(open.fluid.storages[0].ports.some(port => port.connected), false)
  const boiler = await place('boiler', { connects_to: { unit_number: pumpId } })
  assert.equal(boiler.preflight.preservation_join?.complete, true, JSON.stringify(boiler.preflight))
  const boilerId = boiler.result.placed_unit_number
  const joined = preservationGeometry(await geometry(pumpId), pumpId)
  const boilerRaw = await geometry(boilerId)
  const boilerProof = preservationGeometry(boilerRaw, boilerId)
  assert.deepEqual(boilerProof.fluid.storages.flatMap(row => row.prototypes), boiler.preflight.preservation_join.candidate_storages.map(row => ({
    index: row.index, production_type: row.production_type, volume: row.volume, filter: row.filter ?? null,
    minimum_temperature: row.minimum_temperature ?? null, maximum_temperature: row.maximum_temperature ?? null })))
  const witness = boiler.preflight.preservation_join.connects_to
  const port = joined.fluid.storages.find(row => row.index === witness.target_port.storage_index).ports.find(row => row.index === witness.target_port.connection_index)
  assert.equal(port.target.entity.unit_number, boilerId)
  const reciprocal = boilerProof.fluid.storages.find(row => row.index === witness.candidate_port.storage_index).ports.find(row => row.index === witness.candidate_port.connection_index)
  assert.equal(reciprocal.target.entity.unit_number, pumpId)
  const pair = row => ({ actor_id: evidence.setup.actor, actor_epoch: 1, intent_signature: 'native-facts', preserved: [row] })
  assert.equal(preservedProofMatches(pair(open), pair(joined)), false)
  const addition = { source_unit_number: pumpId, source_storage_index: witness.target_port.storage_index,
    source_connection_index: witness.target_port.connection_index, endpoint: port.target }
  assert.equal(preservedProofMatches(pair(open), pair(joined), { addition }), true)
  evidence.additive = { preflight: boiler.preflight, receipt: boiler.result, joined, boiler: boilerProof }
  const steam = boilerProof.fluid.storages.find(row => row.prototypes.some(p => p.filter === 'steam'))
  assert.ok(steam, JSON.stringify(boilerRaw))
  const pipe = await place('pipe', { connects_to: { unit_number: boilerId, storage_index: steam.index } })
  assert.equal(pipe.preflight.preservation_join?.complete, true, JSON.stringify(pipe.preflight))
  const pipeId = pipe.result.placed_unit_number
  const engine = await place('steam-engine', { connects_to: { unit_number: pipeId } })
  assert.equal(engine.preflight.preservation_join?.complete, true, JSON.stringify(engine.preflight))
  const engineId = engine.result.placed_unit_number
  await operation('supply_entity', { unit_number: boilerId, items: [{ item_name: 'coal', count: 1 }] })
  const deadline = Date.now() + 30000
  for (;;) {
    const raw = await geometry(engineId)
    if (raw.fluid_storages.some(row => row.current_fluid?.name === 'steam' && row.current_fluid.amount > 0)) { evidence.production = raw; break }
    assert.ok(Date.now() < deadline, 'normal unfueled→first fuel must produce actual steam'); await delay(100)
  }
  assert.deepEqual(preservationGeometry(await geometry(pumpId), pumpId), joined, 'production counters do not change protected pump topology')
  evidence.pipe = preservationGeometry(await geometry(pipeId), pipeId)
  evidence.engine = preservationGeometry(await geometry(engineId), engineId)
  // Run BC A/C: a validated nonfluid local batch beside the producing, protected plant. The native witness (read-only)
  // must bind the exact validation, the runtime verifier must accept it, normal execution must build exactly the batch,
  // and every protected fluid entity must be unchanged. Fixture stock is declared setup; no model, no teleport.
  {
    const witnessOf = async (id, count) => JSON.parse(await rcon.command(constructionPlanWitnessCommand({ name: 'execute_construction_plan', args: { validation_id: id, placement_count: count } })))
    const quiet = facts => ({ entities: facts.world.entities, inventory: facts.world.inventory, protectedGeometry: facts.world.protectedGeometry, position: facts.world.position })
    const here = (await worldFacts()).world.position
    const validateSite = async () => {
      for (const [dx, dy] of [[3.5, -6.5], [-1.5, -6.5], [3.5, 6.5], [-1.5, 6.5], [6.5, -3.5], [6.5, 3.5]]) {
        const x = Math.floor(here.x + dx) + 0.5; const y = Math.floor(here.y + dy) + 0.5
        const placements = [{ entity_name: 'lab', x, y, direction: 0 }, { entity_name: 'small-electric-pole', x: x + 3, y, direction: 0 }]
        const result = await tool('validateConstructionPlan', { plan_id: 'native-lab-pole-beside-plant', placements })
        if (result.ok === true) return { validated: result, x, y }
      }
      return {}
    }
    // R1-2: the witness promises a placement-only effect at EXECUTION time. The first placement runs inside the admitting
    // callback, right after the submission-time re-evaluation, so the execution window is every later placement. A natural
    // blocker injected in that callback on the pole's tile (after the batch was queued, before the pole's placing tick) must be
    // refused before any mutation: the tree stays, nothing is mined or picked up, the pole stays in stock, and the protected
    // plant is untouched. Only the lab, placed before the blocker existed, was built.
    {
      const site = await validateSite()
      assert.ok(site.validated, 'a deterministic free lab+pole site within build reach of the plant')
      const lateId = site.validated.validation_id; const lateCount = site.validated.placement_count
      const lateWitness = await witnessOf(lateId, lateCount)
      assert.equal(lateWitness.execution_clearance, 'refused', JSON.stringify(lateWitness))
      assert.equal(lateWitness.preservation_nonfluid_output.execution_clearance, 'refused')
      const surfaceIndex = lateWitness.preservation_nonfluid_output.surface_index
      const lateBefore = await worldFacts()
      rcon.queueFault = `local e=game.surfaces[${surfaceIndex}].create_entity{name="tree-01",position={${site.x + 3},${site.y}},force="neutral"}; assert(e); storage.fluid_preservation_late_construction_tree=e;`
      let lateError
      try { await operation('execute_construction_plan', { validation_id: lateId, placement_count: lateCount }) } catch (caught) { lateError = String(caught?.message ?? caught) }
      const lateProbe = await lua(`local t=storage.fluid_preservation_late_construction_tree; local p={${site.x + 3},${site.y}}; rcon.print(helpers.table_to_json({injected=t~=nil, tree_valid=t~=nil and t.valid or false, tree_position=t~=nil and t.valid and t.position or nil, tree_box=t~=nil and t.valid and t.bounding_box or nil, pole_can_place_now=a.surface.can_place_entity{name="small-electric-pole",position=p,force=a.force}, poles=#a.surface.find_entities_filtered{name="small-electric-pole",position=p}}))`)
      evidence.construction_late_blocker_probe = { error: lateError, probe: lateProbe, fault_pending: rcon.queueFault !== undefined }
      assert.equal(rcon.queueFault, undefined, `the late-blocker fault must have run inside the admission callback: ${JSON.stringify(evidence.construction_late_blocker_probe)}`)
      assert.match(lateError ?? '', /construction_plan_blocked_no_clear/, JSON.stringify(evidence.construction_late_blocker_probe))
      const lateAfter = await worldFacts()
      const lateResult = lateAfter.status.basic_operation?.last_result
      evidence.construction_late_blocker = { site: { x: site.x, y: site.y }, result: lateResult, before: lateBefore, after: lateAfter }
      assert.equal(lateResult.code, 'construction_plan_blocked_no_clear', JSON.stringify(lateResult))
      assert.equal(lateResult.completed, false)
      assert.equal(lateResult.entities_cleared, undefined); assert.equal(lateResult.ground_items_picked_up, undefined)
      assert.equal(lateAfter.status.queue_length, 0); assert.equal(lateAfter.status.task_state, 'idle')
      const tree = await lua('local t=storage.fluid_preservation_late_construction_tree; rcon.print(helpers.table_to_json({valid=t.valid}))')
      assert.equal(tree.valid, true, 'the late tree must still stand: nothing may be mined to make room')
      const earlyLab = row => row.name === 'lab' && row.x === site.x && row.y === site.y
      assert.equal(lateAfter.world.entities.filter(earlyLab).length, 1, 'the first placement ran before the blocker existed')
      assert.equal(lateAfter.world.entities.some(row => row.name === 'small-electric-pole' && row.x === site.x + 3 && row.y === site.y), false, 'the blocked pole was not built')
      const unchanged = rows => rows.filter(row => row.name !== 'tree-01' && !earlyLab(row))
      assert.deepEqual(unchanged(lateAfter.world.entities), unchanged(lateBefore.world.entities), 'nothing but the lab and the tree changed')
      const stock = (rows, name) => rows.filter(row => row.name === name).reduce((sum, row) => sum + row.count, 0)
      assert.equal(stock(lateAfter.world.inventory, 'lab'), stock(lateBefore.world.inventory, 'lab') - 1, 'only the lab was consumed')
      const others = rows => rows.filter(row => row.name !== 'lab')
      assert.deepEqual(others(lateAfter.world.inventory), others(lateBefore.world.inventory), 'pole still in stock, no wood gained')
      assert.deepEqual(lateAfter.world.protectedGeometry, lateBefore.world.protectedGeometry, 'protected topology unchanged')
      // Fixture teardown so the positive case below starts from the same stock and free site.
      await lua(`local t=storage.fluid_preservation_late_construction_tree; assert(t.valid); t.destroy(); local l=a.surface.find_entity("lab",{${site.x},${site.y}}); assert(l); l.destroy(); a.insert{name="lab",count=1}; rcon.print("{}")`)
    }
    // Milestone 4 L1: a lab at (x, y) and a small pole requested at (x + 1.4, y). Asked about alone, the engine accepts each;
    // execution builds the pole at its grid-snapped centre x + 1, inside the lab. The plan must be refused at validation,
    // before anything is built. The engine is asked about the pair with a scratch lab that is destroyed again.
    {
      const site = await validateSite()
      assert.ok(site.validated, 'a deterministic free lab+pole site within build reach of the plant')
      const poleX = site.x + 1.4
      const engine = await lua(`local s=a.surface; local lab={${site.x},${site.y}}
        local alone_lab=s.can_place_entity{name="lab",position=lab,force=a.force}
        local alone_pole=s.can_place_entity{name="small-electric-pole",position={${poleX},${site.y}},force=a.force}
        local l=s.create_entity{name="lab",position=lab,force=a.force}; assert(l)
        local joint_requested=s.can_place_entity{name="small-electric-pole",position={${poleX},${site.y}},force=a.force}
        local joint_snapped=s.can_place_entity{name="small-electric-pole",position={${site.x + 1},${site.y}},force=a.force}
        l.destroy()
        rcon.print(helpers.table_to_json({alone_lab=alone_lab,alone_pole=alone_pole,joint_requested=joint_requested,joint_snapped=joint_snapped}))`)
      const jointBefore = await worldFacts()
      const refused = await tool('validateConstructionPlan', { plan_id: 'native-l1-snapped-overlap',
        placements: [{ entity_name: 'lab', x: site.x, y: site.y, direction: 0 }, { entity_name: 'small-electric-pole', x: poleX, y: site.y, direction: 0 }] })
      const jointAfter = await worldFacts()
      evidence.l1_joint_layout = { site: { x: site.x, y: site.y }, engine, refused }
      assert.equal(engine.alone_lab, true, JSON.stringify(engine)); assert.equal(engine.alone_pole, true, JSON.stringify(engine))
      assert.equal(engine.joint_snapped, false, `the engine must refuse the pole at its built centre beside the lab: ${JSON.stringify(engine)}`)
      assert.equal(refused.ok, false, JSON.stringify(refused))
      assert.equal(refused.error.code, 'PLANNED_COLLISION', JSON.stringify(refused))
      assert.deepEqual(refused.error.indices, [0, 1])
      assert.deepEqual(refused.error.placements[1].planned_position, { x: site.x + 1, y: site.y }, JSON.stringify(refused))
      assert.deepEqual(quiet(jointAfter), quiet(jointBefore), 'a refused plan builds, consumes and moves nothing')
      assert.equal(jointAfter.status.queue_length, 0); assert.equal(jointAfter.status.task_state, 'idle')
    }
    const { validated } = await validateSite()
    assert.ok(validated, 'a deterministic free lab+pole site within build reach of the plant')
    const id = validated.validation_id; const count = validated.placement_count
    assert.equal(count, 2)
    const before = await worldFacts()
    const witness = await witnessOf(id, count)
    evidence.construction_witness = witness
    assert.equal(witness.ok, true, JSON.stringify(witness))
    assert.equal(witness.preservation_clears_count, 0)
    assert.equal(witness.execution_clearance, 'refused')
    assert.equal(witness.preservation_nonfluid_output.execution_clearance, 'refused')
    assert.equal(witness.preservation_nonfluid_output.fluid_port_count, 0)
    assert.deepEqual(witness.preservation_nonfluid_output.entity_names, ['lab', 'small-electric-pole'])
    // Milestone 4 L1: the witness carries each placement's native footprint, so a batch that adds a placement on the plan's
    // tiles is refused before admission. The second placement is the engine's own preflight answer.
    for (const row of witness.construction_placements) {
      assert.ok(row.planned_footprint?.collision_layers?.length > 0, JSON.stringify(row))
      assert.deepEqual(row.planned_footprint.position, row.position)
    }
    const [labRow] = witness.construction_placements
    const onTheLab = { name: 'place_entity', args: { entity_name: 'small-electric-pole', x: labRow.position.x, y: labRow.position.y, direction: 0 } }
    const onTheLabPreflight = JSON.parse(await rcon.command(renderOperationPreflight(onTheLab)))
    assert.equal(onTheLabPreflight.ok, true, JSON.stringify(onTheLabPreflight))
    const planOperation = { name: 'execute_construction_plan', args: { validation_id: id, placement_count: count } }
    const batchRefusal = batchFootprintOverlap([planOperation, onTheLab], [witness, onTheLabPreflight])
    evidence.l1_batch_footprint = { preflight: onTheLabPreflight, refusal: batchRefusal }
    assert.equal(batchRefusal?.code, BATCH_FOOTPRINT_OVERLAP_CODE, JSON.stringify(evidence.l1_batch_footprint))
    assert.equal(batchRefusal.batch_footprint.overlaps.construction_placement_index, 0)
    assert.equal(batchRefusal.batch_footprint.overlaps.entity_name, 'lab')
    assert.equal(nonfluidConstructionWitness(witness, { name: 'execute_construction_plan', args: { validation_id: id, placement_count: count } },
      { actor_id: atomicActor.actor_id, preserved: before.world.protectedGeometry.map(row => ({ surface_index: row.surface_index, force_index: row.force_index })) }), true,
    JSON.stringify(witness))
    // Exact binding and read-only behaviour on the real engine.
    assert.equal((await witnessOf(id + 1, count)).code, 'construction_plan_unavailable')
    assert.equal((await witnessOf(id, count - 1)).code, 'construction_plan_count_mismatch')
    const afterReads = await worldFacts()
    assert.deepEqual(quiet(afterReads), quiet(before), 'witness reads change nothing')
    assert.equal(afterReads.status.queue_length, 0); assert.equal(afterReads.status.task_state, 'idle')
    const receipt = await operation('execute_construction_plan', { validation_id: id, placement_count: count })
    evidence.construction_receipt = receipt
    const after = await worldFacts()
    const builtNames = after.world.entities.map(row => row.name)
    assert.equal(builtNames.filter(name => name === 'lab').length, before.world.entities.filter(row => row.name === 'lab').length + 1)
    assert.equal(builtNames.filter(name => name === 'small-electric-pole').length, before.world.entities.filter(row => row.name === 'small-electric-pole').length + 1)
    assert.deepEqual(after.world.protectedGeometry, before.world.protectedGeometry, 'protected pump/boiler/pipe/engine topology is unchanged')
    for (const row of before.world.entities.filter(entity => entity.id)) {
      assert.ok(after.world.entities.some(entity => entity.id === row.id && entity.name === row.name && entity.x === row.x && entity.y === row.y),
        `pre-existing ${row.name} ${row.id} must be untouched`)
    }
    // The consumed validation cannot be replayed or described again.
    assert.equal((await witnessOf(id, count)).code, 'construction_plan_unavailable')
  }
  // Fault scheduling occurs after the actual correlated candidate was queued,
  // inside the same native callback, before its first execution tick. No wait
  // or second production operation is smuggled into the single-slot batch.
  await operation('walk_to_position', { x: evidence.setup.center.x + 5, y: evidence.setup.center.y + 9 })
  const secondPump = await place('offshore-pump', { center: { x: evidence.setup.center.x, y: evidence.setup.center.y + 9 }, radius: 2 })
  const secondPumpId = secondPump.result.placed_unit_number
  const secondOpen = preservationGeometry(await geometry(secondPumpId), secondPumpId)
  const delayedSet = await tool('getPlacementCandidates', { entity_name: 'boiler', connects_to: { unit_number: secondPumpId }, limit: 8 })
  assert.ok(delayedSet.candidates?.length)
  const delayedCandidate = delayedSet.candidates[0]
  const delayedArgs = { candidate_set_id: delayedSet.candidate_set_id, candidate_id: delayedCandidate.id }
  const prepared = await freeze(delayedSet, delayedCandidate, secondPumpId)
  // Native claimed-footprint enforcement is independent of the host helper.
  evidence.generic_omission = await omittedProofRefusal('place_entity', { entity_name: 'boiler', x: delayedCandidate.position.x,
    y: delayedCandidate.position.y, direction: delayedCandidate.direction }, 'exact guarded boiler footprint')
  const edge = delayedCandidate.footprint.world_box.right_bottom.x
  const rawPole = { x: edge + 0.2, y: delayedCandidate.position.y }
  const snappedPole = { x: Math.floor(rawPole.x) + 0.5, y: Math.floor(rawPole.y) + 0.5 }
  evidence.off_grid_geometry = await lua(`local p=prototypes.entity["small-electric-pole"]; rcon.print(helpers.table_to_json({width=p.tile_width,height=p.tile_height,
    raw_left=${rawPole.x}+p.collision_box.left_top.x,snapped_left=${snappedPole.x}+p.collision_box.left_top.x,claim_right=${edge}}))`)
  assert.equal(evidence.off_grid_geometry.width, 1); assert.equal(evidence.off_grid_geometry.height, 1)
  assert.ok(evidence.off_grid_geometry.raw_left > edge && evidence.off_grid_geometry.snapped_left < edge,
    'actual native pole geometry must demonstrate raw nonoverlap and snapped overlap')
  await lua(`local e=a.surface.create_entity{name="tree-01",position={${snappedPole.x},${snappedPole.y}},force="neutral"}; assert(e); storage.fluid_preservation_late_tree=e; rcon.print("{}")`)
  evidence.generic_off_grid = await omittedProofRefusal('place_entity', { entity_name: 'small-electric-pole', ...rawPole, direction: 0 },
    'off-grid raw miss snaps into claimed footprint with a late natural blocker')
  await lua('assert(storage.fluid_preservation_late_tree.valid); storage.fluid_preservation_late_tree.destroy(); rcon.print("{}")')
  const otherPort = prepared.envelope.candidate.candidate_ports.find(port => port.storage_index === 1
    && port.connection_index !== delayedCandidate.connects_to.candidate_port.connection_index)
  assert.ok(otherPort)
  const offset = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }[otherPort.direction]
  rcon.queueFault = `local e=game.surfaces[${prepared.envelope.candidate.surface_index}].create_entity{name="pipe",position={${otherPort.position.x + offset[0]},${otherPort.position.y + offset[1]}},force="player"}; assert(e); storage.fluid_preservation_late=e; storage.fluid_preservation_late_tick=game.tick;`
  await assert.rejects(operation('place_candidate', delayedArgs, prepared), /completed|false|true|ASSERTION/)
  evidence.delayed_refusal = await tool('getTaskStatus', {})
  assert.equal(evidence.delayed_refusal.basic_operation?.last_result?.code, 'placement_candidate_unavailable')
  assert.equal(evidence.delayed_refusal.basic_operation.last_result.completed, false)
  evidence.delayed_world = await lua('rcon.print(helpers.table_to_json({boilers=a.surface.count_entities_filtered{name="boiler"},held=a.get_main_inventory().get_item_count("boiler"),fault_tick=storage.fluid_preservation_late_tick}))')
  assert.equal(evidence.delayed_world.boilers, 1); assert.equal(evidence.delayed_world.held, 1)
  assert.deepEqual(preservationGeometry(await geometry(secondPumpId), secondPumpId), secondOpen)
  evidence.atomic_after_fault = await nextSliceNativeState(probe, nextSliceOwner(probe))
  assert.equal(evidence.atomic_after_fault.unknown, false)
  assert.equal(evidence.atomic_after_fault.uncertain, true, 'idle queue alone cannot hide the unresolved native guard-refused admission')
  await lua(`local s=a.surface; local e; for _,v in pairs(s.find_entities_filtered{name="boiler"}) do if v.unit_number==${boilerId} then e=v end end; assert(e); e.destroy(); rcon.print("{}")`)
  assert.equal(preservedProofMatches(pair(joined), pair(preservationGeometry(await geometry(pumpId), pumpId))), false, 'removing the receiver cannot erase an established edge')
  await lua(`for _,v in pairs(a.surface.find_entities_filtered{name="offshore-pump"}) do if v.unit_number==${pumpId} then v.force=game.forces.enemy end end; rcon.print("{}")`)
  assert.throws(() => preservationGeometry(evidence.open, pumpId)) // a stored projection is never a fresh native response
  assert.throws(() => preservationGeometry({ ...evidence.production, actor_force_index: -1 }, engineId))
  assert.throws(() => preservationGeometry({ ...evidence.production, fluid_storages_truncated: true }, engineId))
  evidence.foreign = await geometry(pumpId)
  assert.throws(() => preservationGeometry(evidence.foreign, pumpId))
  evidence.status = 'pass'
  console.log('PASS native2.0.77 fluid preservation: empty pump, exact boiler/pipe/engine joins, first-fuel steam and lost-edge/scope refusal')
} finally {
  if (connection) connection.close()
  await fs.mkdir(path.resolve(arg('results')), { recursive: true })
  await fs.writeFile(path.join(path.resolve(arg('results')), 'fluid-preservation-native.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
