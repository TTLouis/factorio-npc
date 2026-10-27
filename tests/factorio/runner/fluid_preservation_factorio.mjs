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
import { buildPendingOperation, batchWatermark, reconcilePendingOperation } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
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
  // Milestone 4 L2/L3: typed layout connections on the real engine. Fixture stock and ore are declared setup; every build
  // goes through validateConstructionPlan and an authorized execute_construction_plan. The harness's virtual proof chooses
  // nothing here: the runner tries fixed site lists, and the engine's own targets/networks after placement are the verdict.
  {
    await lua(`for _,item in pairs({{"wooden-chest",3},{"burner-inserter",1},{"lab",1},{"small-electric-pole",1},{"burner-mining-drill",1}}) do assert(a.insert{name=item[1],count=item[2]}==item[2]) end; rcon.print("{}")`)
    const layoutStatus = async id => {
      const read = JSON.parse(await rcon.command(`/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","construction_layout_status",${id})))`))
      assert.equal(read.ok, true, JSON.stringify(read))
      return read.layout
    }
    const quiet = facts => ({ entities: facts.world.entities, inventory: facts.world.inventory, protectedGeometry: facts.world.protectedGeometry, position: facts.world.position })
    const stock = (rows, name) => rows.filter(row => row.name === name).reduce((sum, row) => sum + row.count, 0)
    const validate = (plan_id, placements, connections) => tool('validateConstructionPlan', { plan_id, placements, ...(connections ? { connections } : {}) })
    const here = (await worldFacts()).world.position
    const cell = (x, y) => ({ x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 })
    const unitOf = (status, slot) => status.nodes.find(node => node.slot === slot)?.unit_number
    // L2: a spatially valid layout that cannot run yet says so, separately, and builds nothing.
    {
      const before = await worldFacts()
      let free
      for (const [dx, dy] of [[2, -4], [-2, -4], [2, 4], [-2, 4], [4, 2], [-4, 2]]) {
        const spot = cell(here.x + dx, here.y + dy)
        if ((await validate('native-l2-free-cell', [{ entity_name: 'wooden-chest', ...spot }])).ok === true) { free = spot; break }
      }
      assert.ok(free, 'a free cell within build reach')
      const far = cell(here.x, here.y + 13)
      const missing = await validate('native-l2-missing-material', [{ entity_name: 'iron-chest', ...free }])
      const route = await validate('native-l2-out-of-reach', [{ entity_name: 'wooden-chest', ...far }])
      const port = await validate('native-l2-unproved-port', [{ entity_name: 'wooden-chest', ...free, slot: 'chest' }],
        [{ kind: 'fluid', from: { slot: 'chest' }, to: { unit_number: boilerId } }])
      const after = await worldFacts()
      evidence.l2_layout = { free, far, missing, route, port }
      for (const [label, result] of [['missing material', missing], ['inaccessible route', route], ['unproved port', port]]) {
        assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`)
        assert.equal(result.planning_status, 'spatially_valid', `${label}: ${JSON.stringify(result)}`)
        assert.equal(result.execution_eligible, false, `${label}: ${JSON.stringify(result)}`)
        assert.equal(result.validation_id, undefined, `${label}: an ineligible layout gets no execution token`)
      }
      assert.ok(missing.eligibility_blockers.some(row => row.code === 'ITEMS_MISSING' && row.item_name === 'iron-chest'), JSON.stringify(missing))
      assert.ok(route.eligibility_blockers.some(row => row.code === 'OUTSIDE_LOCAL_BUILD_REACH'), JSON.stringify(route))
      assert.ok(port.eligibility_blockers.some(row => row.code === 'CONNECTION_UNPROVEN' && typeof row.staged_requirement === 'string'), JSON.stringify(port))
      assert.deepEqual(quiet(after), quiet(before), 'planning reads build, consume and move nothing')
      assert.equal(after.status.queue_length, 0); assert.equal(after.status.task_state, 'idle')
    }
    // L3 chest → inserter → existing boiler: the virtual proof must agree with the engine's own pickup and drop targets.
    {
      const boiler = await lua(`local b; for _,v in pairs(a.surface.find_entities_filtered{name="boiler"}) do if v.unit_number==${boilerId} then b=v end end; assert(b); rcon.print(helpers.table_to_json({box=b.bounding_box}))`)
      const { left_top: lt, right_bottom: rb } = boiler.box
      const sites = []
      for (let x = Math.floor(lt.x); x < Math.ceil(rb.x); x++) {
        sites.push({ inserter: { x: x + 0.5, y: Math.floor(lt.y) - 0.5 }, chest: { x: x + 0.5, y: Math.floor(lt.y) - 1.5 } })
        sites.push({ inserter: { x: x + 0.5, y: Math.ceil(rb.y) + 0.5 }, chest: { x: x + 0.5, y: Math.ceil(rb.y) + 1.5 } })
      }
      for (let y = Math.floor(lt.y); y < Math.ceil(rb.y); y++) {
        sites.push({ inserter: { x: Math.floor(lt.x) - 0.5, y: y + 0.5 }, chest: { x: Math.floor(lt.x) - 1.5, y: y + 0.5 } })
        sites.push({ inserter: { x: Math.ceil(rb.x) + 0.5, y: y + 0.5 }, chest: { x: Math.ceil(rb.x) + 1.5, y: y + 0.5 } })
      }
      const plan = (site, direction) => validate('native-l3-chest-inserter-boiler',
        [{ entity_name: 'wooden-chest', ...site.chest, slot: 'chest' }, { entity_name: 'burner-inserter', ...site.inserter, direction, slot: 'inserter' }],
        [{ kind: 'inserter', inserter: { slot: 'inserter' }, pickup: { slot: 'chest' }, drop: { unit_number: boilerId } }])
      const tried = []
      let found
      for (const site of sites) {
        for (const direction of [0, 4, 8, 12]) {
          const result = await plan(site, direction)
          tried.push({ site, direction, ok: result.ok, code: result.error?.code })
          if (result.ok === true) { found = { site, direction }; break }
        }
        if (found) break
      }
      assert.ok(found, `a chest/inserter site feeding the boiler: ${JSON.stringify(tried)}`)
      const reversed = await plan(found.site, (found.direction + 8) % 16)
      assert.equal(reversed.ok, false, JSON.stringify(reversed))
      assert.equal(reversed.error.code, 'CONNECTION_GEOMETRY_MISMATCH', JSON.stringify(reversed))
      const validated = await plan(found.site, found.direction)
      assert.equal(validated.ok, true, JSON.stringify(validated))
      assert.equal(validated.execution_eligible, true)
      const before = await worldFacts()
      await operation('execute_construction_plan', { validation_id: validated.validation_id, placement_count: validated.placement_count })
      const after = await worldFacts()
      const status = await layoutStatus(validated.validation_id)
      const inserterId = unitOf(status, 'inserter'); const chestId = unitOf(status, 'chest')
      // The engine sets the inserter's own target fields a few ticks after it is built; wait (bounded) until both are set.
      const readInserter = () => lua(`local i; for _,v in pairs(a.surface.find_entities_filtered{name="burner-inserter"}) do if v.unit_number==${inserterId} then i=v end end; assert(i);
        local function at(p) local r={}; for _,e in pairs(i.surface.find_entities_filtered{position=p}) do if e.unit_number and e.unit_number~=i.unit_number and e.type~="character" then r[#r+1]=e.unit_number end end; return r end
        local function invs(e) local c=0; for k=1,e.get_max_inventory_index() do if e.get_inventory(k) then c=c+1 end end; return c end; local function inv(p) local r={}; for _,e in pairs(i.surface.find_entities_filtered{position=p}) do if e.unit_number and e.unit_number~=i.unit_number and e.type~="character" then r[#r+1]=invs(e) end end; return r end
        rcon.print(helpers.table_to_json({pickup=i.pickup_target and i.pickup_target.unit_number or nil,drop=i.drop_target and i.drop_target.unit_number or nil,pickup_position=i.pickup_position,drop_position=i.drop_position,
          at_pickup=at(i.pickup_position),at_drop=at(i.drop_position),inventories_at_pickup=inv(i.pickup_position),inventories_at_drop=inv(i.drop_position),direction=i.direction,tick=game.tick}))`)
      const firstRead = await readInserter()
      let native = firstRead
      for (let attempt = 0; attempt < 40 && (native.pickup === undefined || native.drop === undefined); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        native = await readInserter()
      }
      evidence.l3_inserter = { tried, found, reversed, validated, status, first_read: firstRead, native }
      // The engine's own target fields are the verdict, independent of the harness's point fallback.
      assert.equal(native.pickup, chestId, `the inserter's pickup_target: ${JSON.stringify(native)}`)
      assert.equal(native.drop, boilerId, `the inserter's drop_target: ${JSON.stringify(native)}`)
      assert.ok(native.inventories_at_pickup.every(count => count > 0) && native.inventories_at_drop.every(count => count > 0), JSON.stringify(native))
      assert.equal(status.state, 'complete', JSON.stringify(status))
      assert.equal(status.production, 'not_asserted')
      assert.ok(Number.isSafeInteger(inserterId) && Number.isSafeInteger(chestId), JSON.stringify(status))
      // The engine acts on the entity at its native pickup/drop point, the same ones its target fields name.
      assert.deepEqual(native.at_pickup, [chestId], JSON.stringify(native))
      assert.deepEqual(native.at_drop, [boilerId], JSON.stringify(native))
      assert.equal(status.connections[0].state, 'verified', JSON.stringify(status))
      const [chestNode, inserterNode] = ['chest', 'inserter'].map(slot => status.nodes.find(node => node.slot === slot))
      assert.ok(chestNode.execution_rank < inserterNode.execution_rank && chestNode.placed_tick <= inserterNode.placed_tick, JSON.stringify(status))
      assert.equal(stock(after.world.inventory, 'wooden-chest'), stock(before.world.inventory, 'wooden-chest') - 1)
      assert.equal(stock(after.world.inventory, 'burner-inserter'), stock(before.world.inventory, 'burner-inserter') - 1)
      assert.deepEqual(after.world.protectedGeometry, before.world.protectedGeometry, 'feeding the boiler leaves its fluid topology unchanged')
    }
    // L3 lab/pole: the pole's supply area must actually put the lab on the pole's electric network.
    {
      let validated
      const tried = []
      for (const [dx, dy] of [[3.5, -6.5], [-1.5, -6.5], [3.5, 6.5], [-1.5, 6.5], [6.5, -3.5], [6.5, 3.5], [-5.5, 6.5], [-5.5, -6.5]]) {
        const x = Math.floor(here.x + dx) + 0.5; const y = Math.floor(here.y + dy) + 0.5
        const result = await validate('native-l3-lab-pole', [{ entity_name: 'lab', x, y, slot: 'lab' }, { entity_name: 'small-electric-pole', x: x + 3, y, slot: 'pole' }],
          [{ kind: 'power', pole: { slot: 'pole' }, consumer: { slot: 'lab' } }])
        tried.push({ x, y, ok: result.ok, code: result.error?.code })
        if (result.ok === true) { validated = result; break }
      }
      assert.ok(validated, `a free lab/pole site: ${JSON.stringify(tried)}`)
      await operation('execute_construction_plan', { validation_id: validated.validation_id, placement_count: validated.placement_count })
      const status = await layoutStatus(validated.validation_id)
      const labId = unitOf(status, 'lab'); const poleId = unitOf(status, 'pole')
      const native = await lua(`local l, p; for _,v in pairs(a.surface.find_entities_filtered{name={"lab","small-electric-pole"}}) do if v.unit_number==${labId} then l=v end; if v.unit_number==${poleId} then p=v end end; assert(l and p);
        rcon.print(helpers.table_to_json({lab=l.electric_network_id,pole=p.electric_network_id}))`)
      evidence.l3_power = { tried, validated, status, native }
      assert.equal(status.state, 'complete', JSON.stringify(status))
      assert.equal(status.production, 'not_asserted')
      assert.ok(Number.isSafeInteger(native.pole) && native.lab === native.pole, JSON.stringify(native))
      assert.equal(status.connections[0].state, 'verified', JSON.stringify(status))
      const [labNode, poleNode] = ['lab', 'pole'].map(slot => status.nodes.find(node => node.slot === slot))
      assert.ok(labNode.execution_rank < poleNode.execution_rank, JSON.stringify(status))
    }
    // L3 constrained miner/receiver: the drill is placed first and the receiver must be its actual drop target.
    {
      const ore = await lua(`local s=a.surface; local px=math.floor(a.position.x); local py=math.floor(a.position.y); local found
        for _,o in pairs({{-4,-4},{4,-4},{-4,4},{4,4},{0,-6},{0,6},{-6,0},{6,0}}) do local x=px+o[1]; local y=py+o[2]
          if s.count_entities_filtered{area={{x-3,y-3},{x+3,y+3}}}==0 then found={x=x,y=y}; break end end
        assert(found); for dx=-1,0 do for dy=-1,0 do assert(s.create_entity{name="iron-ore",position={found.x+dx+0.5,found.y+dy+0.5},amount=500}) end end
        rcon.print(helpers.table_to_json(found))`)
      const chests = [[-0.5, -1.5], [0.5, -1.5], [-0.5, 1.5], [0.5, 1.5], [-1.5, -0.5], [-1.5, 0.5], [1.5, -0.5], [1.5, 0.5]]
      const tried = []
      const plan = (direction, dx, dy) => validate('native-l3-drill-receiver',
        [{ entity_name: 'burner-mining-drill', x: ore.x, y: ore.y, direction, slot: 'drill' }, { entity_name: 'wooden-chest', x: ore.x + dx, y: ore.y + dy, slot: 'receiver' }],
        [{ kind: 'drill_output', drill: { slot: 'drill' }, receiver: { slot: 'receiver' } }])
      let found
      for (const direction of [0, 4, 8, 12]) {
        for (const [dx, dy] of chests) {
          const result = await plan(direction, dx, dy)
          tried.push({ direction, dx, dy, ok: result.ok, code: result.error?.code })
          if (result.ok === true) { found = { direction, dx, dy }; break }
        }
        if (found) break
      }
      assert.ok(found, `a drill/receiver geometry on the fixture ore: ${JSON.stringify(tried)}`)
      // The same receiver on the opposite side of the drill is off the output point and refused before mutation.
      const mismatch = await plan(found.direction, -found.dx, -found.dy)
      assert.equal(mismatch.error?.code, 'CONNECTION_GEOMETRY_MISMATCH', JSON.stringify(mismatch))
      // A wall on the output point holds no items: the planned receiver is refused as an incompatible endpoint.
      const wallReceiver = await validate('native-l3-drill-wall-receiver',
        [{ entity_name: 'burner-mining-drill', x: ore.x, y: ore.y, direction: found.direction, slot: 'drill' }, { entity_name: 'stone-wall', x: ore.x + found.dx, y: ore.y + found.dy, slot: 'receiver' }],
        [{ kind: 'drill_output', drill: { slot: 'drill' }, receiver: { slot: 'receiver' } }])
      assert.equal(wallReceiver.planning_status, 'spatially_invalid', JSON.stringify(wallReceiver))
      assert.equal(wallReceiver.error?.code, 'CONNECTION_ENDPOINT_INCOMPATIBLE', JSON.stringify(wallReceiver))
      const validated = await plan(found.direction, found.dx, found.dy)
      assert.equal(validated.ok, true, JSON.stringify(validated))
      await operation('execute_construction_plan', { validation_id: validated.validation_id, placement_count: validated.placement_count })
      const status = await layoutStatus(validated.validation_id)
      const drillId = unitOf(status, 'drill'); const receiverId = unitOf(status, 'receiver')
      const native = await lua(`local d; for _,v in pairs(a.surface.find_entities_filtered{name="burner-mining-drill"}) do if v.unit_number==${drillId} then d=v end end; assert(d);
        local r={}; for _,e in pairs(d.surface.find_entities_filtered{position=d.drop_position}) do if e.unit_number and e.unit_number~=d.unit_number and e.type~="character" then r[#r+1]=e.unit_number end end
        local function invs(e) local c=0; for k=1,e.get_max_inventory_index() do if e.get_inventory(k) then c=c+1 end end; return c end; local n={}; for _,e in pairs(d.surface.find_entities_filtered{position=d.drop_position}) do if e.unit_number and e.unit_number~=d.unit_number and e.type~="character" then n[#n+1]=invs(e) end end
        rcon.print(helpers.table_to_json({drop=d.drop_target and d.drop_target.unit_number or nil,drop_position=d.drop_position,at_drop=r,inventories_at_drop=n,direction=d.direction,tick=game.tick}))`)
      evidence.l3_drill = { ore, tried, mismatch, wall_receiver: wallReceiver, validated, status, native }
      assert.equal(status.state, 'complete', JSON.stringify(status))
      assert.equal(status.production, 'not_asserted')
      // An unfuelled burner drill leaves drop_target unset (o5a4); the one entity on its native drop point, which holds items,
      // is the receiver. The target field, when the engine has set it, must agree.
      assert.deepEqual(native.at_drop, [receiverId], JSON.stringify(native))
      assert.ok(native.inventories_at_drop.every(count => count > 0), JSON.stringify(native))
      if (native.drop !== undefined) assert.equal(native.drop, receiverId, JSON.stringify(native))
      assert.equal(status.connections[0].state, 'verified', JSON.stringify(status))
      const [drillNode, receiverNode] = ['drill', 'receiver'].map(slot => status.nodes.find(node => node.slot === slot))
      assert.ok(drillNode.execution_rank < receiverNode.execution_rank && drillNode.placed_tick <= receiverNode.placed_tick, JSON.stringify(status))
    }
    // An existing entity without an item interface (a wall) exactly on an inserter's drop point is not a drop endpoint; an
    // existing chest in the same cell, with the same geometry, is.
    {
      const spot = await lua(`local s=a.surface; local px=math.floor(a.position.x); local py=math.floor(a.position.y); local found
        for _,o in pairs({{3,-5},{-3,-5},{3,5},{-3,5},{5,-3},{-5,-3},{5,3},{-5,3}}) do local x=px+o[1]; local y=py+o[2]
          if s.count_entities_filtered{area={{x-1,y-2},{x+2,y+3}}}==0 and s.can_place_entity{name="wooden-chest",position={x+0.5,y-0.5},force=a.force}
            and s.can_place_entity{name="wooden-chest",position={x+0.5,y+0.5},force=a.force} and s.can_place_entity{name="wooden-chest",position={x+0.5,y+1.5},force=a.force} then found={x=x,y=y}; break end end
        local function invs(e) local c=0; for k=1,e.get_max_inventory_index() do if e.get_inventory(k) then c=c+1 end end; return c end; assert(found); local w=s.create_entity{name="stone-wall",position={found.x+0.5,found.y-0.5},force=a.force}; assert(w and w.unit_number)
        rcon.print(helpers.table_to_json({x=found.x,y=found.y,wall=w.unit_number,wall_max_inventory_index=w.get_max_inventory_index(),wall_inventories=invs(w)}))`)
      const plan = drop => validate('native-l3-inserter-wall',
        [{ entity_name: 'wooden-chest', x: spot.x + 0.5, y: spot.y + 1.5, slot: 'chest' }, { entity_name: 'burner-inserter', x: spot.x + 0.5, y: spot.y + 0.5, direction: 8, slot: 'inserter' }],
        [{ kind: 'inserter', inserter: { slot: 'inserter' }, pickup: { slot: 'chest' }, drop: { unit_number: drop } }])
      // An exact reference to an entity the harness did not build needs fresh nearby discovery first, as for the model.
      const seeWall = await tool('getNearbyEntities', { name: 'stone-wall', radius: 16, limit: 8 })
      const before = await worldFacts()
      const wall = await plan(spot.wall)
      const swap = await lua(`local s=a.surface; for _,e in pairs(s.find_entities_filtered{name="stone-wall",position={${spot.x + 0.5},${spot.y - 0.5}}}) do if e.unit_number==${spot.wall} then e.destroy() end end
        local c=s.create_entity{name="wooden-chest",position={${spot.x + 0.5},${spot.y - 0.5}},force=a.force}; assert(c and c.unit_number); rcon.print(helpers.table_to_json({chest=c.unit_number}))`)
      const seeChest = await tool('getNearbyEntities', { name: 'wooden-chest', radius: 16, limit: 16 })
      const chest = await plan(swap.chest)
      await lua(`for _,e in pairs(a.surface.find_entities_filtered{name="wooden-chest",position={${spot.x + 0.5},${spot.y - 0.5}}}) do if e.unit_number==${swap.chest} then e.destroy() end end; rcon.print("{}")`)
      const after = await worldFacts()
      evidence.l3_inserter_wall = { spot, see_wall: seeWall, wall, see_chest: seeChest, chest }
      // The engine's get_max_inventory_index is not per entity (8 for a stone wall on 2.0.77); the wall has no actual inventory.
      assert.equal(spot.wall_inventories, 0, JSON.stringify(spot))
      assert.equal(wall.ok, false, JSON.stringify(wall))
      assert.equal(wall.planning_status, 'spatially_invalid', JSON.stringify(wall))
      assert.equal(wall.error?.code, 'CONNECTION_ENDPOINT_INCOMPATIBLE', JSON.stringify(wall))
      assert.equal(wall.error?.endpoint_role, 'drop', JSON.stringify(wall))
      assert.equal(wall.validation_id, undefined)
      // The control differs only in the endpoint: its geometry holds (the burner inserter stock was spent above, so it is not
      // eligible to run, which is beside the point here).
      assert.equal(chest.planning_status, 'spatially_valid', JSON.stringify(chest))
      assert.deepEqual(quiet(after).inventory, quiet(before).inventory, 'validation spends nothing')
      assert.equal(after.status.queue_length, 0)
    }
    // Native automation flags are directional: 2.0.77's cargo-landing-pad has an inventory but forbids automated insertion.
    // An inserter may never be planned to drop into it; picking up from the same pad, with the same cells, is spatially valid.
    {
      const spot = await lua(`local s=a.surface; local px=math.floor(a.position.x); local py=math.floor(a.position.y); local found
        local proto=prototypes.entity["cargo-landing-pad"]; assert(proto, "no cargo-landing-pad prototype")
        local pad_alone=0
        for dx=-14,14 do for dy=-10,14 do local x=px+dx; local y=py+dy
          if not found and (math.abs(a.position.x-(x+1))>5 or a.position.y<y-9 or a.position.y>y+1) and s.can_place_entity{name="cargo-landing-pad",position={x+1,y-4},force=a.force} then pad_alone=pad_alone+1
            if s.can_place_entity{name="wooden-chest",position={x+0.5,y+0.5},force=a.force} and s.can_place_entity{name="wooden-chest",position={x+0.5,y+1.5},force=a.force} then found={x=x,y=y} end end end end
        local function invs(e) local c=0; for k=1,e.get_max_inventory_index() do if e.get_inventory(k) then c=c+1 end end; return c end
        assert(found, "no free pad site: pad_alone="..pad_alone.." existing_pads="..s.count_entities_filtered{name="cargo-landing-pad"})
        local pad=s.create_entity{name="cargo-landing-pad",position={found.x+1,found.y-4},force=a.force}; assert(pad and pad.unit_number, "pad not created")
        rcon.print(helpers.table_to_json({x=found.x,y=found.y,pad=pad.unit_number,pad_inventories=invs(pad),no_insertion=proto.flags["no-automated-item-insertion"]==true,no_removal=proto.flags["no-automated-item-removal"]==true}))`)
      const seePad = await tool('getNearbyEntities', { name: 'cargo-landing-pad', radius: 24, limit: 4 })
      const before = await worldFacts()
      const into = await validate('native-l3-inserter-into-pad',
        [{ entity_name: 'wooden-chest', x: spot.x + 0.5, y: spot.y + 1.5, slot: 'chest' }, { entity_name: 'burner-inserter', x: spot.x + 0.5, y: spot.y + 0.5, direction: 8, slot: 'inserter' }],
        [{ kind: 'inserter', inserter: { slot: 'inserter' }, pickup: { slot: 'chest' }, drop: { unit_number: spot.pad } }])
      const from = await validate('native-l3-inserter-from-pad',
        [{ entity_name: 'burner-inserter', x: spot.x + 0.5, y: spot.y + 0.5, direction: 0, slot: 'inserter' }, { entity_name: 'wooden-chest', x: spot.x + 0.5, y: spot.y + 1.5, slot: 'chest' }],
        [{ kind: 'inserter', inserter: { slot: 'inserter' }, pickup: { unit_number: spot.pad }, drop: { slot: 'chest' } }])
      await lua(`for _,e in pairs(a.surface.find_entities_filtered{name="cargo-landing-pad"}) do if e.unit_number==${spot.pad} then e.destroy() end end; rcon.print("{}")`)
      const after = await worldFacts()
      const gone = await lua(`local n=0; for _,e in pairs(a.surface.find_entities_filtered{name="cargo-landing-pad"}) do if e.unit_number==${spot.pad} then n=n+1 end end; rcon.print(helpers.table_to_json({pads=n}))`)
      evidence.l3_inserter_pad = { spot, see_pad: seePad, into, from, gone }
      assert.equal(spot.no_insertion, true, JSON.stringify(spot))
      assert.equal(spot.no_removal, false, JSON.stringify(spot))
      assert.ok(spot.pad_inventories > 0, JSON.stringify(spot))
      assert.equal(into.ok, false, JSON.stringify(into))
      assert.equal(into.planning_status, 'spatially_invalid', JSON.stringify(into))
      assert.equal(into.error?.code, 'CONNECTION_ENDPOINT_INCOMPATIBLE', JSON.stringify(into))
      assert.equal(into.error?.endpoint_role, 'drop', JSON.stringify(into))
      assert.match(into.error?.message ?? '', /no-automated-item-insertion/, JSON.stringify(into))
      assert.equal(into.validation_id, undefined)
      assert.equal(from.planning_status, 'spatially_valid', JSON.stringify(from))
      assert.ok(!(from.eligibility_blockers ?? []).some(blocker => /^CONNECTION_/.test(blocker.code)), JSON.stringify(from))
      assert.deepEqual(quiet(after).inventory, quiet(before).inventory, 'validation spends nothing')
      assert.equal(after.status.queue_length, 0)
      assert.equal(gone.pads, 0)
    }
    // Milestone 4 L4/L5: an execution interrupted after its first node is settled from the game, only the proven remainder is
    // validated and built on the same layout record, and a superseded or expired token changes nothing that was admitted. The
    // interruption is the engine's own cancellation (the task manager's cancel_all_tasks) taken after exactly one node was
    // built: the game is paused and stepped one tick at a time, so no later node can be built before it. Stock is declared setup.
    {
      await lua(`assert(a.insert{name="wooden-chest",count=2}==2); assert(a.insert{name="burner-inserter",count=1}==1); rcon.print("{}")`)
      const chainPlan = (x, y, direction) => validate('native-l4-chain',
        [{ entity_name: 'wooden-chest', x, y, slot: 'src' }, { entity_name: 'burner-inserter', x: x + 1, y, direction, slot: 'ins' }, { entity_name: 'wooden-chest', x: x + 2, y, slot: 'dst' }],
        [{ kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { slot: 'dst' } }])
      const tried = []
      let found
      for (const [dx, dy] of [[-5, -3], [-5, 3], [-5, -5], [-5, 5], [3, -5], [3, 5], [-7, 0], [5, 0]]) {
        const x = Math.floor(here.x + dx) + 0.5; const y = Math.floor(here.y + dy) + 0.5
        for (const direction of [4, 12]) {
          const result = await chainPlan(x, y, direction)
          tried.push({ x, y, direction, ok: result.ok, code: result.error?.code })
          if (result.ok === true) { found = { x, y, direction, validated: result }; break }
        }
        if (found) break
      }
      assert.ok(found, `a free chest, inserter, chest row: ${JSON.stringify(tried)}`)
      const first = found.validated
      assert.equal(first.placement_count, 3)
      const layoutId = first.validation_id
      const executeOp = validation => ({ name: 'execute_construction_plan', args: { validation_id: validation.validation_id, placement_count: validation.placement_count } })
      let session = await deploymentStatus(rcon, { requireAllowed: true })
      const ordinal = (await lua('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')).high_water + 1
      const pending = buildPendingOperation({ requestId: 'native-l4', operationKey: `native-l4/${ordinal}`, attemptId: `native-l4/${ordinal}`, ordinal, protocolVersion: 2,
        operations: [executeOp(first)], goalId: 'goal_layout_native', planId: 'goal_layout_native_p1', stepId: 'native_l4_step', actor: session,
        baseline: batchWatermark(await tool('getTaskStatus', {})), now: Date.now() })
      const stockBefore = (await worldFacts()).world.inventory

      const clock = () => lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused}))')
      const advance = async ticks => {
        const start = (await clock()).tick
        await lua(`game.ticks_to_run=${ticks}; rcon.print("{}")`)
        const deadline = Date.now() + 10000
        let now = await clock()
        while (now.tick < start + ticks) { assert.ok(Date.now() < deadline, 'the paused game did not run the requested ticks'); await delay(25); now = await clock() }
        assert.equal(now.tick, start + ticks); assert.equal(now.paused, true)
      }
      let interruption
      let bootToken
      let early
      await lua('game.tick_paused=true; rcon.print("{}")')
      try {
        const paused = await clock()
        assert.equal(paused.paused, true)
        await delay(300)
        assert.equal((await clock()).tick, paused.tick, 'a paused game does not tick')
        const admission = await executeAuthorizedBatch(rcon, session.epoch, [renderOperation(parseOperation(executeOp(first)))], undefined, pending, undefined)
        evidence.operations.push({ name: 'execute_construction_plan', args: executeOp(first).args, admission })
        let seen
        for (let step = 0; step < 24 && !seen; step++) {
          await advance(1)
          const status = await layoutStatus(layoutId)
          if (status.nodes.some(node => node.state === 'placed')) seen = status
        }
        assert.ok(seen, 'the first node of the layout was built within 24 ticks')
        assert.equal(seen.nodes.filter(node => node.state === 'placed').length, 1, JSON.stringify(seen))
        assert.equal(seen.state, 'running', JSON.stringify(seen))
        // The shipped boot order, step by step: the guard's configure cancels the queue (the interrupted batch closes as a
        // cancelled receipt of this generation) and bumps the deployment epoch; startup reconciliation follows below.
        bootToken = `native-l4-boot-${Date.now()}-session-token`
        await lua(`assert(remote.call("sgluna_deployment","configure","npc",${luaString(bootToken)})==${luaString(bootToken)}); rcon.print("{}")`)
        // A remainder validated in the middle of the boot is not the boot's remainder.
        early = await tool('resumeConstructionLayout', { layout_id: layoutId })
        assert.equal(early.ok, true, JSON.stringify(early))
        interruption = { paused, seen }
      }
      finally {
        await lua('game.tick_paused=false; rcon.print("{}")')
      }
      const idleDeadline = Date.now() + 10000
      for (;;) {
        const status = await tool('getTaskStatus', {})
        if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) break
        assert.ok(Date.now() < idleDeadline, 'native queue did not drain after the cancellation'); await delay(50)
      }
      // Then startup reconciliation, as supervisor.mjs reconcileNpcAfterLoad runs it with the boot's session: the batch generation
      // advances and the actor is reconciled. (No server save/restart: the runner has no supported path for one.)
      const priorSession = session
      const generationBefore = (await tool('getTaskStatus', {})).batch_generation
      const startup = JSON.parse(await rcon.command(`/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","reconcile_startup",${luaString(bootToken)})))`))
      assert.equal(startup.ok, true, JSON.stringify(startup)); assert.equal(startup.reconciled, true, JSON.stringify(startup))
      assert.equal(startup.batch_generation, generationBefore + 1)
      await rcon.command('/silent-command remote.call("autorio_actor","reconcile_after_load")')
      session = await deploymentStatus(rcon, { requireAllowed: true })
      assert.equal(session.session, bootToken); assert.equal(session.epoch, priorSession.epoch + 1); assert.equal(session.actor_id, priorSession.actor_id)
      const authorizes = await lua(`rcon.print(helpers.table_to_json({old=remote.call("sgluna_deployment","authorize",${priorSession.epoch}),current=remote.call("sgluna_deployment","authorize",${session.epoch})}))`)
      assert.deepEqual(authorizes, { old: false, current: true })
      const refuse = (validation, pattern) => assert.rejects(
        executeAuthorizedBatch(rcon, session.epoch, [renderOperation(parseOperation(executeOp(validation)))]), error => pattern.test(String(error?.message ?? error)))
      // The remainder validated before the boot ended predates the rebind and the restart: refused before admission.
      await refuse(early, /LAYOUT_TOKEN_PREDATES_REBIND/)
      assert.equal((await tool('getTaskStatus', {})).queue_length, 0)

      // L4 settle: the placed node is retained under its unit, the rest were never built, and the layout reads as paused.
      const settled = await layoutStatus(layoutId)
      const src = settled.nodes.find(node => node.slot === 'src')
      const sourceUnit = src.unit_number
      assert.equal(src.state, 'placed', JSON.stringify(settled)); assert.ok(Number.isSafeInteger(sourceUnit), JSON.stringify(settled))
      assert.deepEqual(settled.nodes.filter(node => node.slot !== 'src').map(node => node.state), ['not_placed', 'not_placed'], JSON.stringify(settled))
      assert.equal(settled.state, 'paused', JSON.stringify(settled)); assert.equal(settled.pause_reason, 'remainder_unplaced', JSON.stringify(settled))
      assert.equal(settled.executions_used, 1); assert.equal(settled.executions_max, 3)
      assert.deepEqual(settled.executions[0].settled.placed, [src.index], JSON.stringify(settled))
      assert.equal(settled.executions[0].settled.not_placed.length, 2)
      const unitsAt = async (name, position) => {
        const read = await lua(`local r={}; for _,e in pairs(a.surface.find_entities_filtered{name="${name}",position={${position.x},${position.y}},radius=0.2}) do r[#r+1]=e.unit_number end; rcon.print(helpers.table_to_json({units=r}))`)
        return Array.isArray(read.units) ? read.units : []
      }
      assert.deepEqual(await unitsAt('wooden-chest', src.position), [sourceUnit])
      for (const node of settled.nodes.filter(node => node.slot !== 'src')) {
        assert.deepEqual(await unitsAt(node.entity_name, node.position), [], `${node.node_id} was never built`)
      }
      // The same cancellation sealed its admission: the exact placed and unplaced nodes, and the runtime re-proves it from the
      // retained row and the native receipt instead of trusting that string.
      const sealed = (await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status",${luaString(pending.operation_key)})))`)).records[0]
      assert.equal(sealed.state, 'partial', JSON.stringify(sealed)); assert.equal(sealed.error, 'exact_construction_layout_partial', JSON.stringify(sealed))
      assert.equal(sealed.layout_id, layoutId); assert.deepEqual(sealed.placed_node_ids, [src.node_id])
      assert.equal(sealed.not_placed_node_ids.length, 2)
      // Sealed by the guard's own cancellation: a cancelled receipt of the old generation, under the previous epoch, before
      // startup reconciliation advanced the generation. The runtime settles it across the epoch change.
      assert.equal(sealed.epoch, priorSession.epoch); assert.equal(sealed.generation, generationBefore)
      assert.equal(sealed.layout_receipt.state, 'cancelled'); assert.equal(sealed.layout_receipt.batch_generation, generationBefore)
      const nativeStatus = await tool('getTaskStatus', {})
      assert.equal(nativeStatus.batch_generation, generationBefore + 1)
      assert.equal(pending.actor.epoch, priorSession.epoch); assert.notEqual(pending.actor.epoch, session.epoch)
      const verdict = reconcilePendingOperation(pending, { status: nativeStatus, actor: { actor_id: session.actor_id, epoch: session.epoch } })
      assert.equal(verdict.verdict, 'admitted_partial', JSON.stringify(verdict)); assert.equal(verdict.reason, 'exact_construction_layout_partial', JSON.stringify(verdict))
      assert.equal(verdict.effect, 'partial_known')

      // L4 resume: only the remainder is validated, at its stored geometry, with the retained chest as an existing endpoint.
      const resume1 = await tool('resumeConstructionLayout', { layout_id: layoutId })
      assert.equal(resume1.ok, true, JSON.stringify(resume1))
      assert.equal(resume1.layout_id, layoutId); assert.equal(resume1.placement_count, 2); assert.equal(resume1.executions_used, 1)
      assert.deepEqual(resume1.retained.map(row => row.unit_number), [sourceUnit], JSON.stringify(resume1))
      assert.equal(resume1.remainder.length, 2)
      assert.deepEqual(resume1.placements.map(row => row.slot).sort(), ['dst', 'ins'])
      assert.deepEqual(await layoutStatus(layoutId), settled, 'validating a remainder leaves the layout record alone')

      // L5: a newer remainder validation supersedes the older token, which is refused before admission.
      const resume2 = await tool('resumeConstructionLayout', { layout_id: layoutId })
      assert.equal(resume2.ok, true, JSON.stringify(resume2)); assert.ok(resume2.validation_id > resume1.validation_id)
      const quietBefore = quiet(await worldFacts())
      await refuse(resume1, /superseded/)
      assert.deepEqual(await layoutStatus(layoutId), settled, 'a superseded token does not touch the layout')
      assert.deepEqual(quiet(await worldFacts()), quietBefore, 'a refused token builds and spends nothing')

      // L5: the remaining token expires (3600 ticks); the partially completed layout and its retained node stay as they were.
      const clockAtExpiry = await clock()
      assert.ok(resume2.expires_tick > clockAtExpiry.tick)
      await lua('game.speed=20; rcon.print("{}")')
      try {
        const expiryDeadline = Date.now() + 120000
        while ((await clock()).tick <= resume2.expires_tick) { assert.ok(Date.now() < expiryDeadline, 'the validation did not reach its expiry tick'); await delay(250) }
      }
      finally {
        await lua('game.speed=1; rcon.print("{}")')
      }
      await refuse(resume2, /expired/)
      assert.deepEqual(await layoutStatus(layoutId), settled, 'an expired token does not erase or alter the layout')
      assert.deepEqual(await unitsAt('wooden-chest', src.position), [sourceUnit])

      // A fresh validation of the remainder continues the same record: node 1 keeps its unit and is not rebuilt.
      const resume3 = await tool('resumeConstructionLayout', { layout_id: layoutId })
      assert.equal(resume3.ok, true, JSON.stringify(resume3)); assert.equal(resume3.placement_count, 2)
      const receipt = await operation('execute_construction_plan', { validation_id: resume3.validation_id, placement_count: resume3.placement_count })
      const done = await layoutStatus(layoutId)
      const stockAfter = (await worldFacts()).world.inventory
      assert.equal(done.layout_id, layoutId); assert.equal(done.state, 'complete', JSON.stringify(done))
      assert.equal(done.executions_used, 2); assert.equal(done.executions_max, 3)
      assert.ok(done.nodes.every(node => node.state === 'placed'), JSON.stringify(done))
      const doneSrc = done.nodes.find(node => node.slot === 'src')
      assert.equal(doneSrc.unit_number, sourceUnit); assert.equal(doneSrc.placed_tick, src.placed_tick)
      assert.equal(done.connections[0].state, 'verified', JSON.stringify(done)); assert.equal(done.production, 'not_asserted')
      assert.deepEqual(await unitsAt('wooden-chest', src.position), [sourceUnit])
      const doneDst = done.nodes.find(node => node.slot === 'dst'); const doneIns = done.nodes.find(node => node.slot === 'ins')
      assert.deepEqual(await unitsAt('wooden-chest', doneDst.position), [doneDst.unit_number])
      assert.deepEqual(await unitsAt('burner-inserter', doneIns.position), [doneIns.unit_number])
      assert.equal(stock(stockAfter, 'wooden-chest'), stock(stockBefore, 'wooden-chest') - 2, 'each chest was spent once')
      assert.equal(stock(stockAfter, 'burner-inserter'), stock(stockBefore, 'burner-inserter') - 1)
      // The inserter built by the resume acts on the retained chest and the new one, by the engine's own target fields.
      const readInserter = () => lua(`local i; for _,v in pairs(a.surface.find_entities_filtered{name="burner-inserter"}) do if v.unit_number==${doneIns.unit_number} then i=v end end; assert(i);
        rcon.print(helpers.table_to_json({pickup=i.pickup_target and i.pickup_target.unit_number or nil,drop=i.drop_target and i.drop_target.unit_number or nil}))`)
      let targets = await readInserter()
      for (let attempt = 0; attempt < 40 && (targets.pickup === undefined || targets.drop === undefined); attempt++) { await delay(100); targets = await readInserter() }
      assert.equal(targets.pickup, sourceUnit, JSON.stringify(targets)); assert.equal(targets.drop, doneDst.unit_number, JSON.stringify(targets))
      // Retained parts are read again before a resume: a second small layout is cancelled after its inserter is built and its
      // item connection verified (the unconnected pole is still to come); the retained inserter is then turned on the engine.
      {
        await lua(`assert(a.insert{name="wooden-chest",count=2}==2); assert(a.insert{name="burner-inserter",count=1}==1); rcon.print("{}")`)
        const rowPlan = (x, y, direction) => validate('native-l4-retained',
          [{ entity_name: 'wooden-chest', x, y, slot: 'a' }, { entity_name: 'burner-inserter', x: x + 1, y, direction, slot: 'i' }, { entity_name: 'wooden-chest', x: x + 2, y, slot: 'b' },
            { entity_name: 'small-electric-pole', x: x + 4, y }],
          [{ kind: 'inserter', inserter: { slot: 'i' }, pickup: { slot: 'a' }, drop: { slot: 'b' } }])
        const rowTried = []
        let row
        for (const [dx, dy] of [[-5, -5], [-5, 5], [-5, -1], [-5, 3], [3, -7], [3, 7], [-7, 2], [2, 2]]) {
          const x = Math.floor(here.x + dx) + 0.5; const y = Math.floor(here.y + dy) + 0.5
          for (const direction of [4, 12]) {
            const result = await rowPlan(x, y, direction)
            rowTried.push({ x, y, direction, ok: result.ok, code: result.error?.code })
            if (result.ok === true) { row = { x, y, direction, validated: result }; break }
          }
          if (row) break
        }
        assert.ok(row, `a second free row for the retained-part layout: ${JSON.stringify(rowTried)}`)
        const rowId = row.validated.validation_id
        assert.equal(row.validated.placement_count, 4)
        const rowStock = (await worldFacts()).world.inventory
        await lua('game.tick_paused=true; rcon.print("{}")')
        let rowStatus
        try {
          await executeAuthorizedBatch(rcon, session.epoch, [renderOperation(parseOperation(executeOp(row.validated)))])
          for (let step = 0; step < 24; step++) {
            await advance(1)
            rowStatus = await layoutStatus(rowId)
            if (rowStatus.nodes.filter(node => node.state === 'placed').length >= 3) break
          }
          assert.equal(rowStatus.nodes.filter(node => node.state === 'placed').length, 3, JSON.stringify(rowStatus))
          assert.deepEqual(rowStatus.nodes.filter(node => node.state === 'placed').map(node => node.slot).sort(), ['a', 'b', 'i'], JSON.stringify(rowStatus))
          await lua('remote.call("autorio_operations","cancel_all_tasks"); rcon.print("{}")')
        }
        finally {
          await lua('game.tick_paused=false; rcon.print("{}")')
        }
        const rowIdle = Date.now() + 10000
        for (;;) {
          const status = await tool('getTaskStatus', {})
          if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) break
          assert.ok(Date.now() < rowIdle, 'native queue did not drain after the cancellation'); await delay(50)
        }
        const rowSettled = await layoutStatus(rowId)
        const inserterNode = rowSettled.nodes.find(node => node.slot === 'i')
        assert.equal(rowSettled.state, 'paused', JSON.stringify(rowSettled)); assert.equal(rowSettled.pause_reason, 'remainder_unplaced', JSON.stringify(rowSettled))
        assert.equal(inserterNode.state, 'placed', JSON.stringify(rowSettled)); assert.equal(rowSettled.connections[0].state, 'verified', JSON.stringify(rowSettled))
        const turn = quarter => lua(`local i; for _,v in pairs(a.surface.find_entities_filtered{name="burner-inserter"}) do if v.unit_number==${inserterNode.unit_number} then i=v end end; assert(i);
          local before=i.direction; i.direction=(before+${quarter})%16; rcon.print(helpers.table_to_json({before=before,after=i.direction,pickup=i.pickup_target and i.pickup_target.unit_number or nil,drop=i.drop_target and i.drop_target.unit_number or nil}))`)
        const turned = await turn(4)
        assert.notEqual(turned.after, turned.before, JSON.stringify(turned))
        const quietTurned = quiet(await worldFacts())
        const paused = await layoutStatus(rowId)
        assert.equal(paused.state, 'paused', JSON.stringify(paused))
        assert.match(paused.pause_reason, new RegExp(`^retained_node_changed: ${inserterNode.node_id}$`), JSON.stringify(paused))
        const refused = await tool('resumeConstructionLayout', { layout_id: rowId })
        assert.equal(refused.ok, false, JSON.stringify(refused)); assert.equal(refused.error?.code, 'LAYOUT_RETAINED_NODE_CHANGED', JSON.stringify(refused))
        assert.deepEqual(quiet(await worldFacts()), quietTurned, 'a refused resume builds and spends nothing')
        assert.equal(paused.nodes.find(node => node.slot === 'i').unit_number, inserterNode.unit_number, 'the retained inserter keeps its unit and is never rebuilt')
        assert.equal(paused.executions_used, 1)
        // Turned back, the retained part holds again; the same layout then builds its last node and completes.
        const restored = await turn(12)
        assert.equal(restored.after, turned.before, JSON.stringify(restored))
        const resumeRow = await tool('resumeConstructionLayout', { layout_id: rowId })
        assert.equal(resumeRow.ok, true, JSON.stringify(resumeRow)); assert.equal(resumeRow.placement_count, 1)
        await operation('execute_construction_plan', { validation_id: resumeRow.validation_id, placement_count: resumeRow.placement_count })
        const rowDone = await layoutStatus(rowId)
        assert.equal(rowDone.state, 'complete', JSON.stringify(rowDone)); assert.equal(rowDone.executions_used, 2)
        assert.equal(rowDone.nodes.find(node => node.slot === 'i').unit_number, inserterNode.unit_number)
        assert.equal(rowDone.connections[0].state, 'verified')
        const rowAfter = (await worldFacts()).world.inventory
        assert.equal(stock(rowAfter, 'wooden-chest'), stock(rowStock, 'wooden-chest') - 2); assert.equal(stock(rowAfter, 'burner-inserter'), stock(rowStock, 'burner-inserter') - 1)
        evidence.l4_retained = { rowTried, row, rowSettled, turned, paused, refused, restored, resumeRow, rowDone }
      }
      // The expiry wait outlived the 3600-tick freshness of the water read the later offshore-pump steps depend on (the engine
      // fact is that a placement candidate only accepts a recent fluid-source observation); observe it again, as at setup.
      const water = await tool('getFluidSourceTiles', { fluid_name: 'water', search_radius: 16, limit: 8 })
      assert.ok(water.samples?.length, JSON.stringify(water))
      evidence.l4_resume = { tried, found, first, interruption, settled, sealed, verdict, resume1, resume2, resume3, receipt, done, targets,
        stock: { before: stockBefore, after: stockAfter } }
      assert.equal((await tool('getTaskStatus', {})).queue_length, 0)
    }
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
  console.log('PASS native2.0.77 fluid preservation: empty pump, exact boiler/pipe/engine joins, first-fuel steam, lost-edge/scope refusal, layout planning/connections and interrupted-layout settle/resume')
} finally {
  if (connection) connection.close()
  await fs.mkdir(path.resolve(arg('results')), { recursive: true })
  await fs.writeFile(path.join(path.resolve(arg('results')), 'fluid-preservation-native.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
