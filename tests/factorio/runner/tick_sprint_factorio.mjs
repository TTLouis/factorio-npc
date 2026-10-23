/* eslint-disable antfu/no-top-level-await, no-console */
import process from 'node:process'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { pauseSprintStartup, resumeSprintStartup, sprintCommand, sprintSpeedValid, TickSprintController } from '../pterodactyl/runtime-v8/tick-sprint.mjs'
import { renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const phase = arg('phase')
const binding = { profile: 'accelerated', run_id: 'native-sprint-proof', source_sha: process.env.NPC_TEST_CANDIDATE_SHA ?? 'a'.repeat(40) }
const transcript = []; const cases = []
let forbidden = 0; let ordinal = 0; let connection
globalThis.fetch = async () => { forbidden++; throw new Error('External inference forbidden') }
const connect = async () => {
  const deadline = Date.now() + 20000
  for (;;) {
    connection = new Rcon(Number(arg('port')), arg('password'), 3000, { host: arg('host') })
    try { await connection.connect(); return } catch (error) { connection.close(); assert.ok(Date.now() < deadline, error.message); await delay(100) }
  }
}
const command = async text => { const answer = await connection.command(text); transcript.push({ text, answer }); return answer }
const json = async text => JSON.parse(await command(text))
const lua = body => json(`/silent-command ${body}`)
const guard = () => json(sprintCommand('status'))
const waitRestored = async () => {
  const deadline = Date.now() + 4000
  for (;;) {
    const state = await guard()
    if (state.speed === 1 && !state.lease) return state
    assert.ok(Date.now() < deadline, 'Native guard restoration timed out')
    await delay(25)
  }
}

try {
  await fs.mkdir(results, { recursive: true })
  await connect()
  if (phase === 'verify') {
    const saved = JSON.parse(await fs.readFile(path.join(results, 'tick-sprint-proof.json'), 'utf8'))
    const loaded = await guard()
    await delay(500)
    assert.equal((await guard()).tick, loaded.tick, 'startup remains paused before replicated reconciliation')
    assert.ok(loaded.lease, 'restart negative control loads an active saved lease')
    await pauseSprintStartup({ command })
    await configureNpcSession({ command }, 'native-sprint-restart-session')
    const status = await json(sprintCommand('configure', binding))
    assert.equal(status.speed, 1); assert.equal(status.lease, undefined)
    assert.deepEqual(status.episodes, saved.saved.episodes)
    assert.equal(status.binding.run_id, binding.run_id)
    await resumeSprintStartup({ command })
    const tick = (await guard()).tick
    await delay(250)
    assert.ok((await guard()).tick > tick, 'replicated unpause and auto-pause setting allow zero-human progress')
    await json(sprintCommand('seal', 'native_restart_verified'))
    assert.equal((await guard()).phase, 'closed')
    const config = await json(sprintCommand('configure', binding))
    assert.equal(config.ok, false, 'sealed construction cannot reopen for measurement')
    await fs.writeFile(path.join(results, 'tick-sprint-restart.json'), JSON.stringify({ status: 'pass', actual: status, sealed: await guard() }, null, 2))
  } else {
    await configureNpcSession({ command }, 'native-sprint-session')
    const identity = await deploymentStatus({ command }, { requireAllowed: true })
    const fixture = await lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});assert(a and a.valid);game.speed=1;
      local s=game.create_surface("tick-sprint-proof",{seed=232323,width=128,height=128,water=0,autoplace_settings={entity={treat_missing_as_default=false,settings={}}}});
      s.request_to_generate_chunks({0,0},2);s.force_generate_chunk_requests();for _,e in pairs(s.find_entities()) do e.destroy() end;
      local tiles={};for x=-60,60 do for y=-60,60 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles);assert(a.teleport({0,3},s));
      a.get_main_inventory().clear();assert(a.insert{name="wood",count=100}==100);local f=s.create_entity{name="stone-furnace",position={0,0},force=a.force};assert(f);
      assert(f.insert{name="copper-ore",count=16}==16);assert(f.insert{name="coal",count=5}==5);
      remote.call("autorio_task_board","set_snapshot",{goal_id="sprint-goal",objective="Native finite work",status="active",blocker="",pause_reason="",
        plan={plan_id="sprint-plan",plan_version=1},active_index=0,steps={{id="sprint-step",description="Native finite work",status="active"}}});
      rcon.print(helpers.table_to_json({furnace=f.unit_number,base=script.active_mods.base,humans=#game.connected_players}))`)
    assert.equal(fixture.base, '2.0.77'); assert.equal(fixture.humans, 0)
    assert.equal((await json(sprintCommand('configure', binding))).ok, true)
    const admit = async operation => {
      ordinal++
      const key = `native-sprint/op_${ordinal}`
      const signature = `native-signature-${ordinal}`
      const admission = await lua(`local c={operation_key="${key}",attempt_id="attempt-${ordinal}",actor_id=${identity.actor_id},epoch=${identity.epoch},signature="${signature}",ordinal=${ordinal},operation_count=1};
        local b=remote.call("autorio_operation_admission","begin",c);assert(b.ok,helpers.table_to_json(b));
        local ok,result=${renderOperation(operation)};assert(ok,result);local s=remote.call("autorio_operations","status");assert(s.active_batch,"native batch missing");
        local slot=remote.call("autorio_operation_admission","slot",c.operation_key,1,{ok=true,result=result,operation="${operation.name}",batch_refs={s.active_batch}});assert(slot.ok,helpers.table_to_json(slot));
        local done=remote.call("autorio_operation_admission","finish",c.operation_key,{ok=true});assert(done.ok,helpers.table_to_json(done));rcon.print(helpers.table_to_json(s))`)
      return { ...binding, lease_id: `native-lease-${ordinal}`, request_id: 'native-sprint', actor_id: identity.actor_id, epoch: identity.epoch,
        goal_id: 'sprint-goal', plan_id: 'sprint-plan', plan_version: 1, step_id: 'sprint-step', board_step_id: 'sprint-step',
        operation_key: key, signature, batch_ref: admission.active_batch.batch_ref, episode_id: admission.active_batch.batch_ref,
        wall_started_ms: Date.now(), wall_deadline_ms: Date.now() + 3000 }
    }
    const arm = async lease => { lease.wall_started_ms = Date.now(); lease.wall_deadline_ms = lease.wall_started_ms + 3000; return json(sprintCommand('arm', lease)) }
    // Let the exact admitted batch finish. Cancelling partially executed work
    // deliberately leaves an uncertain admission and must refuse another sprint.
    const cancel = async () => {
      const deadline = Date.now() + 70000
      for (;;) {
        const work = await json('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))')
        if (work.task_state === 'idle' && work.queue_length === 0 && !work.active_batch) return
        assert.ok(Date.now() < deadline, 'Declared fixture batch did not finish')
        await delay(100)
      }
    }
    const snapshot = () => lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});local f=nil;for _,e in pairs(a.surface.find_entities_filtered{type="furnace"}) do if e.unit_number==${fixture.furnace} then f=e end end;assert(f,"exact fixture furnace missing");rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed,humans=#game.connected_players,
      plates=f.get_output_inventory().get_item_count("copper-plate"),chests=a.get_main_inventory().get_item_count("wooden-chest"),actor_id=a.unit_number}))`)
    // Host disconnect: only the engine-resident tick guard remains. Real furnace
    // production and a real finite native wait continue; no stock is fabricated.
    const before = await snapshot()
    const wait = await admit({ name: 'wait', args: { ticks: 900 } })
    const armed = await arm(wait)
    assert.equal(armed.ok, true, JSON.stringify(armed))
    assert.equal(armed.speed, 4)
    assert.equal(sprintSpeedValid({ ...armed, sprint_guard: armed, actor_id: identity.actor_id, epoch: identity.epoch, goal_id: wait.goal_id,
      plan_id: wait.plan_id, plan_version: 1, board_step_id: wait.board_step_id, active_batch_ref: wait.batch_ref },
    { profile: 'accelerated', runId: binding.run_id, sourceSha: binding.source_sha }), true)
    connection.close(); await delay(2800); await connect()
    const restored = await waitRestored()
    assert.equal(restored.last.reason, 'tick_cap'); assert.equal(restored.last.actual_ticks, 600)
    const produced = await snapshot()
    assert.ok(produced.plates > before.plates, 'Native smelting progressed during sprint')
    cases.push({ name: 'host_disconnect_tick_cap_smelting', before, restored, after: produced })
    await cancel()
    const wallLease = await admit({ name: 'wait', args: { ticks: 900 } })
    const wallArmed = await arm(wallLease)
    assert.equal(wallArmed.ok, true, JSON.stringify(wallArmed))
    const watchdog = new Rcon(Number(arg('port')), arg('password'), 700, { host: arg('host'), auxiliary: true })
    await watchdog.connect()
    try {
      const controller = new TickSprintController({ session: { rcon: { command }, agent: { epoch: identity,
        captureCheckpointOwner: () => undefined, noteWorldMutation: () => {} } }, watchdog, binding, persist: async () => {}, emit: async () => {} })
      controller.lease = { ...wallArmed.lease, monotonicStart: performance.now() }
      await delay(2050)
      await controller.watchdogTick()
      const wallRestored = await guard()
      assert.equal(wallRestored.last.reason, 'host_wall_watchdog')
      assert.equal(wallRestored.speed, 1)
      assert.ok(wallRestored.last.actual_ticks < 600)
      cases.push({ name: 'independent_real_rcon_wall_watchdog', restored: wallRestored })
    } finally { watchdog.close() }
    await cancel()
    const craft = await admit({ name: 'craft_item', args: { item_name: 'wooden-chest', count: 2 } })
    const craftArmed = await arm(craft)
    assert.equal(craftArmed.ok, true, JSON.stringify(craftArmed))
    const completed = await waitRestored()
    assert.equal(completed.last.reason, 'native_work_finished')
    assert.equal((await snapshot()).chests, 2)
    cases.push({ name: 'native_craft_completion_restore', completed, after: await snapshot() })
    for (const fault of ['threat', 'damage', 'player']) {
      const lease = await admit({ name: 'wait', args: { ticks: 900 } })
      assert.equal((await arm(lease)).ok, true)
      if (fault === 'threat') await lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});assert(a.surface.create_entity{name="small-biter",position={40,3},force="enemy"});rcon.print('{}')`)
      if (fault === 'damage') await lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});a.damage(1,game.forces.enemy,"physical");rcon.print('{}')`)
      if (fault === 'player') await json(sprintCommand('safety_event', 'player_joined_game'))
      const stopped = await waitRestored()
      assert.equal(stopped.last.reason, fault === 'threat' ? 'nearby_threat' : fault === 'damage' ? 'actor_damaged' : 'player_joined_game')
      cases.push({ name: `native_${fault}_event`, stopped, note: fault === 'player' ? 'Synthetic invocation of the native arrival-safety hook; real engine join dispatch/networking untested. Handler wiring and connected-human refusal covered separately.' : undefined })
      await cancel()
      if (fault === 'threat') await lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});for _,e in pairs(a.surface.find_entities_filtered{force="enemy"}) do e.destroy() end;rcon.print('{}')`)
    }
    const budgetLease = await admit({ name: 'wait', args: { ticks: 900 } })
    for (let i = 0; i < 6; i++) {
      budgetLease.lease_id = `budget-${i}`
      assert.equal((await arm(budgetLease)).ok, true)
      const status = await json(sprintCommand('finish', 'observation_boundary'))
      assert.equal(status.speed, 1)
    }
    assert.equal((await arm(budgetLease)).reason, 'episode_exhausted')
    assert.equal((await json(sprintCommand('configure', binding))).episodes[budgetLease.episode_id], 3600)
    await cancel()
    const restartLease = await admit({ name: 'wait', args: { ticks: 900 } })
    await command('/silent-command game.tick_paused=true')
    const saved = await arm(restartLease)
    assert.equal(saved.speed, 4)
    assert.ok(saved.lease)
    // SIGTERM saves the startup world again after finally restores the live
    // process. Reload a separately named active-lease artifact, never that save.
    await command('/server-save sprint-active-negative-control')
    const activeSave = path.join(path.dirname(arg('save')), 'factorio-data/saves/sprint-active-negative-control.zip')
    const saveDeadline = Date.now() + 10000
    while (!(await fs.stat(activeSave).catch(() => null))?.size) {
      assert.ok(Date.now() < saveDeadline, 'Active-lease negative-control save missing')
      await delay(50)
    }
    await fs.writeFile(path.join(results, 'tick-sprint-proof.json'), JSON.stringify({ status: 'pass', fixture, binding, before, cases, saved,
      zero_external_inference: forbidden === 0, human_event_limit: 'Native arrival-safety hook invoked directly; registered-handler source wiring tested separately; real join dispatch/networking untested' }, null, 2))
  }
  assert.equal(forbidden, 0)
  console.log(`PASS tick sprint ${phase}: native clock/work/guard safety and durable boundaries`)
} catch (error) {
  await fs.writeFile(path.join(results, `tick-sprint-${phase}-error.txt`), `${error.stack}\n${JSON.stringify(cases, null, 2)}`)
  throw error
} finally {
  try { await command(sprintCommand('finish', 'native_proof_exit')) } catch {}
  await fs.writeFile(path.join(results, `tick-sprint-${phase}-transcript.json`), JSON.stringify(transcript, null, 2))
  connection?.close()
}
