#!/usr/bin/env node
// Deterministic declared fixtures; real protocol-2 exact-building operations.
// Parent owns isolated native resources and exact-save restart/ZIP verification.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { luaString, toolCommand, parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0, `missing --${name}`); return process.argv[at + 1] }
const phase = arg('phase'); const results = path.resolve(arg('results'))
const evidence = { status: 'fail', phase, providers: 0, lanes: [] }; const trace = []
globalThis.fetch = async () => { evidence.providers++; throw new Error('Providers forbidden') }
let connection
const rcon = { command: async command => { const response = await connection.command(command); trace.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const status = async () => JSON.parse(await rcon.command(toolCommand('getTaskStatus', {})))
const lookup = target => `local e;for _,v in pairs(game.surfaces[${target.surface_index}].find_entities_filtered{position={${target.position.x},${target.position.y}},radius=0.25,name=${luaString(target.name)}}) do if v.unit_number==${target.unit_number} then e=v;break end end`
const array = v => Array.isArray(v) ? v : (assert.deepEqual(v, {}), [])
const journalRows = state => array(state.admission_journal?.records ?? state.admission_journal)
let ordinal = 0
async function submit(actor, target, label) {
  const operation = parseOperation({ name: 'mine_entity_exact', args: { unit_number: target.unit_number } })
  const correlation = { protocol_version: 2, operation_key: `native-removal/${label}`, attempt_id: `fixture-${label}`, signature: `mine-exact-${target.unit_number}`,
    actor: { actor_id: actor.actor_id, epoch: actor.epoch }, ordinal: ++ordinal, surface_index: target.surface_index }
  const acknowledgement = await executeAuthorizedBatch(rcon, actor.epoch, [renderOperation(operation)], undefined, correlation)
  return { correlation, acknowledgement }
}
async function advanceOne() {
  await lua('local until_tick=game.tick+1;script.on_nth_tick(1,function()if game.tick>=until_tick then game.tick_paused=true;script.on_nth_tick(1,nil) end end);game.tick_paused=false;rcon.print("{}")')
  for (let i = 0; i < 30; i++) {
    const state = await lua('rcon.print(helpers.table_to_json({paused=game.tick_paused,tick=game.tick}))')
    if (state.paused) return state
    await delay(25)
  }
  throw new Error('Bounded one-tick fixture advance did not pause')
}
try {
  connection = new Rcon(Number(arg('rcon-port')), 'offline-fixture-only'); await connection.connect()
  const marker = '/silent-command rcon.print("native-removal-fixture-ready")'; await rcon.command(marker); assert.match(await rcon.command(marker), /native-removal-fixture-ready/)
  evidence.before = await lua('game.tick_paused=true;game.speed=1;rcon.print(helpers.table_to_json({tick=game.tick,humans=#game.connected_players,mods=script.active_mods}))')
  assert.equal(evidence.before.mods.base, '2.0.77'); assert.equal(evidence.before.humans, 0)
  if (phase === 'reload') {
    const saved = JSON.parse(await fs.readFile(path.join(results, 'removal-state.json'), 'utf8'))
    await configureNpcSession(rcon, 'native-removal-reload-session')
    const state = await status()
    const record = journalRows(state).find(row => row.operation_key === saved.pending.correlation.operation_key)
    assert.ok(record); assert.equal(record.state, 'uncertain'); assert.equal(record.entity_removal.native_call, 'not_attempted')
    assert.notEqual(record.entity_removal.state, 'verified')
    evidence.restart = { status: state, record, exact_target: await lua(`${lookup(saved.target)};rcon.print(helpers.table_to_json({present=e~=nil}))`) }
    assert.equal(evidence.restart.exact_target.present, true)
  }
  else {
    assert.equal(phase, 'prepare')
    await configureNpcSession(rcon, 'native-removal-prepare-session')
    const actor = await deploymentStatus(rcon, { requireAllowed: true })
    evidence.world = await lua(`rcon.print(helpers.table_to_json(remote.call("sgluna_factory","bind_world_id",${luaString(randomUUID())})))`)
    assert.equal(evidence.world.ok, true)
    const setup = async (label, name = 'steel-chest') => {
      const fixture = await lua(`local a=game.get_entity_by_unit_number(${actor.actor_id});assert(a);local s=a.surface;local x=math.floor(a.position.x)+3.5;local y=math.floor(a.position.y)+0.5
        for _,e in pairs(s.find_entities_filtered{area={{x-2,y-2},{x+2,y+2}}}) do if e~=a and e.name~="sgluna-npc-vision" then e.destroy() end end
        local tiles={};for tx=x-2.5,x+2.5 do for ty=y-2.5,y+2.5 do tiles[#tiles+1]={name="landfill",position={tx,ty}} end end;s.set_tiles(tiles,true,false,true)
        local inv=a.get_main_inventory();inv.clear();local names={};for n,p in pairs(prototypes.item) do if p.type=="item" and p.stack_size>1 and not p.spoil_result then names[#names+1]=n end end;table.sort(names);assert(#names>=3)
        local qnames={};for n,q in pairs(prototypes.quality) do if q.level>0 then qnames[#qnames+1]=n end end;table.sort(qnames);assert(qnames[1]);local q=${label === 'quality' ? 'qnames[1]' : 'a.quality.name'}
        local e=s.create_entity{name=${luaString(name)},position={x,y},force=a.force,quality=q};assert(e)
        if ${luaString(label)}=="quality" or ${luaString(label)}=="capacity" then local source=e.get_inventory(defines.inventory.chest);assert(source.insert{name=names[1],count=2,quality=q}==2);assert(source.insert{name=names[2],count=3,quality=q}==3) end
        if ${luaString(label)}=="capacity" then for i=1,#inv-1 do assert(inv[i].set_stack{name=names[3],count=prototypes.item[names[3]].stack_size}) end end
        if ${luaString(label)}=="fluid" then e.active=false;local filter=e.fluidbox.get_filter(1);assert(filter and filter.name);local f=prototypes.fluid[filter.name];e.fluidbox[1]={name=f.name,amount=math.min(10,e.fluidbox.get_capacity(1)),temperature=f.default_temperature};assert(e.fluidbox[1]);assert(e.status~=defines.entity_status.working,"fluid fixture must exercise the fluid guard") end
        if ${luaString(label)}=="metadata" then local names={};for n,p in pairs(prototypes.item) do if p.type=="blueprint" then names[#names+1]=n end end;table.sort(names);local i=e.get_inventory(defines.inventory.chest);assert(i[1].set_stack{name=names[1],count=1});i[1].label="retirement-protected-metadata" end
        rcon.print(helpers.table_to_json({unit_number=e.unit_number,name=e.name,position=e.position,surface_index=s.index,force_index=e.force.index,quality=e.quality.name}))`)
      // Normal public observation records the exact native reference hint.
      const seen = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_entity_status",${luaString(name)},12)))`)
      assert.equal(seen.found, true)
      evidence.lanes.push({ label, target: fixture, observed: seen }); return fixture
    }
    for (const [label, name, expected] of [['empty', 'steel-chest', 'verified'], ['quality', 'steel-chest', 'verified'], ['capacity', 'steel-chest', 'refused'], ['fluid', 'boiler', 'refused'], ['metadata', 'steel-chest', 'refused']]) {
      const target = await setup(label, name); const lane = evidence.lanes.at(-1)
      lane.submission = await submit(actor, target, label)
      await lua('game.tick_paused=false;rcon.print("{}")')
      const deadline = Date.now() + 15000
      for (;;) { lane.status = await status(); if (lane.status.task_state === 'idle' && lane.status.queue_length === 0 && !lane.status.active_batch) break; assert.ok(Date.now() < deadline, `${label} timed out`); await delay(25) }
      await lua('game.tick_paused=true;rcon.print("{}")')
      lane.receipt = lane.status.basic_operation.last_result.entity_removal
      assert.equal(lane.receipt.state, expected, JSON.stringify(lane.status))
      if (label === 'fluid') assert.equal(lane.receipt.code, 'removal_fluid_present')
      const journal = journalRows(lane.status).find(row => row.operation_key === lane.submission.correlation.operation_key)
      assert.deepEqual(journal.entity_removal, lane.receipt)
      assert.equal(lane.receipt.before?.target.unit_number ?? target.unit_number, target.unit_number)
      if (expected === 'verified') { assert.equal(lane.receipt.target_gone, true); assert.equal(lane.receipt.native_call, 'returned_true'); assert.ok(array(lane.receipt.recovered_items).length > 0) }
      else assert.equal(lane.receipt.native_call, 'not_attempted')
      lane.exact_after = await lua(`${lookup(target)};rcon.print(helpers.table_to_json({present=e~=nil}))`)
      assert.equal(lane.exact_after.present, expected !== 'verified')
    }
    const target = await setup('restart-pending')
    const pending = await submit(actor, target, 'restart-pending')
    await advanceOne()
    const pendingStatus = await status()
    const record = journalRows(pendingStatus).find(row => row.operation_key === pending.correlation.operation_key)
    assert.equal(record.entity_removal.state, 'prepared'); assert.equal(record.entity_removal.native_call, 'not_attempted')
    await fs.mkdir(results, { recursive: true })
    await fs.writeFile(path.join(results, 'removal-state.json'), JSON.stringify({ target, pending, pendingStatus }, null, 2))
    const save = path.resolve(arg('save')); const before = await fs.stat(save); const name = path.basename(save, '.zip'); assert.match(name, /^[A-Za-z0-9_-]+$/)
    await rcon.command(`/silent-command game.server_save(${luaString(name)})`)
    const deadline = Date.now() + 15000
    while ((await fs.stat(save)).mtimeMs <= before.mtimeMs) { assert.ok(Date.now() < deadline, 'save timed out'); await delay(50) }
    evidence.pending = { target, pending, pendingStatus, save }
  }
  evidence.after = await lua('rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))')
  assert.equal(evidence.after.paused, true); assert.equal(evidence.after.speed, 1); assert.equal(evidence.after.humans, 0); assert.equal(evidence.providers, 0)
  evidence.status = 'pass'
} catch (error) { evidence.error = String(error?.stack ?? error); console.error(evidence.error); process.exitCode = 1 }
finally {
  if (connection) { try { await rcon.command('/silent-command game.tick_paused=true;game.speed=1;script.on_nth_tick(1,nil)') } catch { evidence.pause_cleanup = 'unconfirmed' } }
  connection?.close(); await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, `entity-removal-${phase}.json`), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, `entity-removal-${phase}-transcript.json`), JSON.stringify(trace, null, 2))
}
