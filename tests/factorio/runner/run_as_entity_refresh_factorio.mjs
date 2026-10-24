// Deterministic AS same-layout fixture. No provider/Jev or live-run controls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { buildPendingOperation, batchWatermark } from '../pterodactyl/runtime-v8/operation-reconciliation.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { recoverySession, settle } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'

const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const fixture = JSON.parse(await fs.readFile(new URL('../pterodactyl/runtime-v8/fixtures/run-as-entity-refresh.json', import.meta.url)))
const transcript = []; const cases = []; const events = []; const source = {}
let connection; let inference = 0; let identity; let furnace; let nativeMutations = 0
globalThis.fetch = async () => { inference++; throw new Error('External inference forbidden in AS native proof') }
const rcon = { command: async text => {
  const answer = await connection.command(text)
  transcript.push({ text, answer })
  if (text.includes('local ok,result=pcall') && text.includes('"authorize"')) nativeMutations++
  return answer
} }
const lua = body => rcon.command(`/silent-command ${body}`).then(JSON.parse)
const status = () => lua('rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))')
const ordinal = value => {
  const journal = value.admission_journal
  const records = Array.isArray(journal) ? journal : journal?.records ?? []
  return Math.max(0, ...records.map(row => row.ordinal))
}
const facts = () => lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});assert(a and a.valid);local f=nil;for _,e in pairs(a.surface.find_entities_filtered{name="stone-furnace"}) do if e.unit_number==${furnace} then f=e end end;assert(f and f.valid);local function counts(i)local t={} for _,v in pairs(i.get_contents()) do t[v.name]=(t[v.name] or 0)+v.count end return t end;rcon.print(helpers.table_to_json({base=script.active_mods.base,tick=game.tick,speed=game.speed,humans=#game.connected_players,actor_id=a.unit_number,surface_index=a.surface.index,position=a.position,unit_number=f.unit_number,furnace_position=f.position,held=counts(a.get_main_inventory()),output=counts(f.get_output_inventory()),fuel=counts(f.get_fuel_inventory()),products_finished=f.products_finished,electronics=a.force.technologies.electronics.researched}))`)
async function idle() {
  await delay(150)
  const deadline = Date.now() + 30000
  for (;;) {
    const value = await status()
    if (value.task_state === 'idle' && value.queue_empty && value.queue_length === 0 && !value.active_batch) return value
    assert.ok(Date.now() < deadline, 'Native setup/collection timeout')
    await delay(100)
  }
}
async function setupOperation(operation, caseName) {
  const before = await status()
  const pending = buildPendingOperation({ requestId: `as-setup-${caseName}`, operationKey: `as-setup-${caseName}/${nativeMutations}`,
    ordinal: ordinal(before) + 1,
    protocolVersion: 2, actor: identity, surfaceIndex: identity.surface_index,
    operations: [operation], baseline: batchWatermark(before) })
  await executeAuthorizedBatch(rcon, identity.epoch, [renderOperation(operation)], undefined, pending)
  return idle()
}

try {
  await fs.mkdir(results, { recursive: true })
  for (const file of ['npc-agent-loop.mjs', 'entity-refresh.mjs', 'production-task-runtime.mjs', 'production-task.mjs', 'canonical-task-board-memory.mjs']) {
    source[file] = createHash('sha256').update(await fs.readFile(new URL(`../pterodactyl/runtime-v8/${file}`, import.meta.url))).digest('hex')
  }
  for (let i = 0; i < 100; i++) {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); break } catch { await delay(100) }
  }
  for (const residual of [false, true]) {
    const name = residual ? 'injected_residual' : 'prevention'
    await configureNpcSession(rcon, `as-entity-${name}`)
    identity = await deploymentStatus(rcon, { requireAllowed: true })
    // One declared independent fixture per case. Stock and terrain are set only
    // here. Placement, supply, 10 native smelts and collection then run physically.
    await lua(`local a=game.get_entity_by_unit_number(${identity.actor_id});game.speed=1;game.tick_paused=false;remote.call("autorio_operations","cancel_all_tasks");
      local s=game.create_surface("as-entity-${name}",{seed=1495202104,width=160,height=160,water=0,autoplace_settings={entity={treat_missing_as_default=false,settings={}}}});
      s.request_to_generate_chunks({55,63},1);s.force_generate_chunk_requests();for _,e in pairs(s.find_entities()) do e.destroy() end;
      local tiles={} for x=48,64 do for y=56,70 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles);assert(a.teleport({57,63},s));
      local inv=a.get_main_inventory();inv.clear();for n,c in pairs({["stone-furnace"]=1,["copper-ore"]=20,coal=20,["iron-plate"]=8,["burner-mining-drill"]=1}) do assert(inv.insert{name=n,count=c}==c) end;rcon.print("{}")`)
    identity = await deploymentStatus(rcon, { requireAllowed: true })
    const placed = await setupOperation({ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 55, y: 63 } }, name)
    furnace = placed.basic_operation?.last_result?.placed_unit_number
    assert.ok(Number.isSafeInteger(furnace), JSON.stringify(placed))
    await setupOperation({ name: 'supply_entity', args: { unit_number: furnace, items: [{ item_name: 'copper-ore', count: 10 }, { item_name: 'coal', count: 10 }] } }, name)
    const smeltDeadline = Date.now() + 60000
    let before
    do { before = await facts(); if (before.output['copper-plate'] === 10) break; assert.ok(Date.now() < smeltDeadline, 'Native ten-plate smelting timeout'); await delay(200) } while (true)
    assert.equal(before.base, '2.0.77'); assert.equal(before.humans, 0); assert.equal(before.speed, 1)
    assert.equal(before.held['copper-plate'] ?? 0, 0); assert.equal(before.held['copper-ore'], 10)
    assert.equal(before.products_finished, 10)
    const restored = structuredClone(fixture.memory)
    // The independent second case shares this engine's monotone journal. Keep
    // its ordinal watermark; never reset native replay protection to AS's value.
    restored.planning_states[0].state.operation_ledger.sequence = Math.max(
      restored.planning_states[0].state.operation_ledger.sequence,
      ordinal(await status()))
    const memory = new CanonicalTaskBoardMemory(); memory.restore(restored)
    const held = () => getActivePlan(memory.planningState(fixture.key))
    const steps = structuredClone(held().steps)
    const agent = new NpcAgentLoop({ rcon, memory, npcId: 'npc-1', completionProtocolVersion: 3,
      stateFile: null, traceFile: null, decisionTraceFile: null, provider: async () => { inference++; throw new Error('No model repair in AS native proof') } })
    Object.assign(agent, { active: true, epoch: identity, lastMemoryKey: fixture.key,
      requestInfo: { memoryKey: fixture.key, turnId: 1, sender: '<server>', text: fixture.memory.plans[0].state.objective },
      traceRequest: { id: `native-as-${name}`, usage: {} }, messages: [], baseMessages: [] })
    agent.agentContext.beginLineage('executor')
    agent.behaviorTrace = { emit: async row => events.push(row) }
    // AS's old ownership is not authority for this new native actor/epoch.
    await assert.rejects(agent.parsePlanMessageChecked({ content: fixture.responses.find(row => row.tap_request_id === 'tap_24').choices[0].message.content }),
      error => error.code === 'exact_entity_requires_live_observation')
    // Current-epoch ownership comes from the actual placement receipt above,
    // never a fabricated completion or a rewritten committed step.
    agent.recordPlacementReceipt(placed)
    const current = memory.currentPlan(fixture.key)
    memory.recordLocators(fixture.key, current, { exactTargetAudit: [{ unit_number: furnace, operation_name: 'supply_entity',
      locator: { name: 'stone-furnace', type: 'furnace', position: { x: 55, y: 63 }, surface_index: identity.surface_index } }] })
    const original = JSON.parse(fixture.responses.find(row => row.tap_request_id === 'tap_24').choices[0].message.content)
    original.operations[0].args.unit_number = furnace // Explicit native-fixture identity mapping; exact IDs are replayed in the offline regression.
    let plan
    if (residual) {
      agent.recordLiveEntityToolResult('getEntityStatus', await rcon.command(agent.observationToolCommand('getEntityStatus', { unit_number: furnace })))
      plan = await agent.parsePlanMessageChecked({ content: JSON.stringify(original) })
      agent.liveEntityObservations.clear() // Residual miss after validation, before real admission.
    } else {
      agent.liveEntityObservations.clear()
      plan = await agent.parsePlanMessageChecked({ content: JSON.stringify(original) })
    }
    const sendsBefore = nativeMutations
    const result = await agent.commitPlan(plan)
    assert.equal(result.operations[0].name, 'move_items_exact')
    assert.equal(result.operations[0].args.to_entity, false)
    assert.equal(nativeMutations - sendsBefore, 1)
    await idle()
    const after = await facts()
    assert.equal(after.held['copper-plate'], 10); assert.equal(after.output['copper-plate'] ?? 0, 0)
    assert.equal(after.held['copper-ore'], before.held['copper-ore']); assert.deepEqual(after.fuel, before.fuel)
    assert.equal(after.products_finished, before.products_finished, 'Collection must not trigger another supply/production batch')
    const ctx = recoverySession({ agent, game: rcon }, { actorId: identity.actor_id, epoch: identity.epoch })
    const close = agent.settleCompletedStepState.bind(agent)
    agent.settleCompletedStepState = async (state, options) => {
      const result = await close(state, { ...options, allowContinuation: false })
      assert.equal(held().execution.step_progress[steps[3].step_id].status, 'completed')
      // End this scoped proof only after the ordinary native checkpoint closes.
      // Authoring the next roadmap slice is outside this deterministic fixture.
      return result ?? { fixtureBoundary: 'verified_original_step', operations: [] }
    }
    ctx.session.onGameLine('[AUTORIO] All operations completed'); await settle(ctx.session)
    assert.equal(held().execution.step_progress[steps[3].step_id].status, 'completed', JSON.stringify(ctx.logs))
    assert.deepEqual(held().steps, steps)
    cases.push({ name, declared_identity_mapping: { original_actor: 12, native_actor: identity.actor_id, original_unit: 19, native_unit: furnace,
      original_surface: 1, native_surface: identity.surface_index, native_epoch: identity.epoch }, before, after,
      native_batches: nativeMutations - sendsBefore, original_step_verified: true })
    await agent.cancel('native_fixture_complete')
  }
  assert.equal(inference, 0)
  await fs.writeFile(path.join(results, 'run-as-entity-refresh.json'), JSON.stringify({ pass: true, source, cases, inference,
    limitation: 'Deterministic same-layout current-epoch fixture. No autonomous science-rate or new live-trial claim.' }, null, 2))
} finally {
  connection?.close()
  await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, 'run-as-entity-refresh-transcript.json'), JSON.stringify({ source, cases, events, inference, transcript }, null, 2))
}
