#!/usr/bin/env node
// Zero-inference Factorio 2.1.24 regression. The same entrypoint/assertions run
// against baseline and candidate. Fixture technology flags are scripted setup;
// the rejected request, durable ledger, resume and next action use the real
// external runtime/NativeBridge. No production fault switch or guessed queue cap.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { NativeBridge } from '../pterodactyl/runtime-v8/operator-native-bridge.mjs'
import { openRuntime } from '../pterodactyl/runtime-v8/operator-runtime.mjs'
import { nativeAdmissionJournal } from '../pterodactyl/staging/native-admission-journal.mjs'

const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0 && process.argv[i + 1], `missing --${name}`); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const session = 'research-reconciliation-native-00000001'
const evidence = { fixture: 'scripted technology flags; real engine queue capacity and real external runtime', inference_calls: 0 }
const transcript = []
let connection, runtime, actorId
let submitCommands = 0
globalThis.fetch = async () => { evidence.inference_calls++; throw new Error('inference forbidden') }
const rcon = { command: async command => {
  if (command.includes('local refusal=')) submitCommands++
  const response = await connection.command(command)
  transcript.push({ command, response: String(response) })
  return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
async function terminal(row) {
  for (const end = Date.now() + 10000; !row.terminal && Date.now() < end;) {
    await delay(50)
    row = await runtime.get({ operation_id: row.operation_id })
  }
  return row
}
async function main() {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  await connection.connect()
  const bridge = new NativeBridge({ rcon, session })
  const bound = await bridge.bind()
  actorId = bound.actor.actor_id
  evidence.engine = await lua('rcon.print(helpers.table_to_json({version=script.active_mods.base,humans=#game.connected_players,speed=game.speed}))')
  assert.equal(evidence.engine.version, '2.1.24')
  assert.equal(evidence.engine.humans, 0)
  assert.equal(evidence.engine.speed, 1)
  // Every prerequisite is obtained from the live graph. Selected technologies
  // must be independent of other selected entries. No fixed science or capacity.
  const fixture = await lua(`local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local f=a.force; assert(f.research_enabled); f.research_queue={};
    for _,t in pairs(f.technologies) do if not t.prototype.research_trigger then t.researched=true end end;
    local names={}; for name,t in pairs(f.technologies) do if t.enabled and not t.prototype.research_trigger and not t.prototype.hidden then names[#names+1]=name end end; table.sort(names);
    local selected={}; local target; for _,name in ipairs(names) do local t=f.technologies[name]; local eligible=true;
      for pname,p in pairs(t.prerequisites) do if not p.researched then eligible=false end end;
      for _,prior in ipairs(selected) do if f.technologies[prior].prerequisites[name] then eligible=false end end;
      if eligible then t.researched=false; local accepted=f.add_research(t); if not accepted then target=name; break end; selected[#selected+1]=name end;
    end; local queue={}; for _,t in ipairs(f.research_queue or {}) do queue[#queue+1]=t.name end;
    assert(target and #queue>0,'fixture could not reach a native append refusal'); rcon.print(helpers.table_to_json({target=target,queue=queue,current=f.current_research.name,tick=game.tick}))`)
  evidence.fixture_state = fixture
  runtime = await openRuntime({ bridge, directory: path.join(results, 'ledger'), session, pollMs: 50 })
  const input = { request_id: 'ext-158', operation: { name: 'research_technology', args: { technology_name: fixture.target } } }
  const submitted = await runtime.submit(input)
  const rejected = await terminal(submitted)
  evidence.rejected = rejected
  evidence.snapshot = await bridge.snapshot()
  evidence.native_research = await bridge.observe('getResearchStatus', {})
  // Baseline reaches this assertion with cancelled/partial_unknown, reproducing
  // the real defect rather than failing because a new fixture API is missing.
  assert.equal(rejected.state, 'rejected', JSON.stringify(rejected))
  assert.equal(rejected.effect, 'not_happened')
  assert.equal(rejected.execution?.requires_reconciliation, false)
  const admission = evidence.snapshot.status.admission_journal.find(row => row.research_request?.technology === fixture.target)
  assert.equal(admission?.state, 'failed')
  assert.equal(admission.proven_refusal, true)
  const after = await lua(`local f=game.get_entity_by_unit_number(${actorId}).force; local queue={}; for _,t in ipairs(f.research_queue or {}) do queue[#queue+1]=t.name end; rcon.print(helpers.table_to_json({queue=queue,current=f.current_research.name}))`)
  assert.deepEqual(after.queue, fixture.queue)
  assert.equal(after.current, fixture.current)
  assert.equal((await runtime.resume({ operation_id: rejected.operation_id })).state, 'rejected')
  assert.equal((await runtime.submit(input)).operation_id, rejected.operation_id)
  assert.equal(submitCommands, 1, 'resume/duplicate never resubmit the native mutation')
  await runtime.close()
  runtime = await openRuntime({ bridge, directory: path.join(results, 'ledger'), session, pollMs: 50 })
  assert.equal((await runtime.resume({ operation_id: rejected.operation_id })).state, 'rejected')
  evidence.next_action = await terminal(await runtime.submit({ request_id: 'next-action', operation: { name: 'wait', args: { ticks: 1 } } }))
  assert.equal(evidence.next_action.state, 'completed')
  assert.equal(submitCommands, 2)
  // Known disabled-technology eligibility is refused before another task is admitted.
  await lua(`game.get_entity_by_unit_number(${actorId}).force.technologies[${JSON.stringify(fixture.target)}].enabled=false; rcon.print('{}')`)
  await assert.rejects(runtime.submit({ request_id: 'preflight', operation: input.operation }), error => {
    evidence.prevention = { code: error.code, native_code: error.details?.native_code, effect: error.effect, notSent: error.notSent };
    return error.code === 'preflight_rejected' && error.details?.native_code === 'technology_disabled'
      && error.effect === 'not_happened' && error.notSent === true
  })
  assert.equal(submitCommands, 2)
  await runtime.close(); runtime = undefined
  evidence.stop = await lua('local before=remote.call("sgluna_deployment","status"); local cancelled=remote.call("sgluna_deployment","cancel"); local disabled=remote.call("sgluna_deployment","disable"); local after=remote.call("sgluna_deployment","status"); local s=remote.call("autorio_operations","status"); local j=remote.call("autorio_operation_admission","status"); s.admission_journal=j.records; rcon.print(helpers.table_to_json({before=before,cancelled=cancelled,disabled=disabled,after=after,status=s,tick=game.tick,speed=game.speed,old_authorized=remote.call("sgluna_deployment","authorize",before.epoch),current_authorized=remote.call("sgluna_deployment","authorize",after.epoch)}))')
  assert.equal(evidence.stop.cancelled, true)
  assert.equal(evidence.stop.disabled, true)
  assert.equal(evidence.stop.after.allowed, false)
  assert.equal(evidence.stop.old_authorized, false)
  assert.equal(evidence.stop.current_authorized, false)
  assert.equal(evidence.stop.status.task_state, 'idle')
  assert.equal(evidence.stop.status.queue_length, 0)
  assert.equal(evidence.stop.status.queue_empty, true)
  assert.ok(!evidence.stop.status.active_batch)
  const journal = nativeAdmissionJournal(evidence.stop.status.admission_journal)
  assert.equal(journal.known, true)
  assert.equal(journal.unresolved, false)
  assert.equal(evidence.inference_calls, 0)
  evidence.strict_native_stop = true
  console.log('PASS: real native research refusal -> durable exact no-effect -> restored runtime continuation -> strict native idle stop')
}
try { await main() }
catch (error) { evidence.error = String(error?.stack ?? error); throw error }
finally {
  await runtime?.close?.()
  await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, 'research-reconciliation.json'), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, 'research-reconciliation-transcript.json'), JSON.stringify(transcript, null, 2))
  connection?.close?.()
}
