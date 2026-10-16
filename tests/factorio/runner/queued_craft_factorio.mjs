#!/usr/bin/env node
// Run K: real native synchronous craft admission, then the complete production
// Session loop. Control and proof run on independent pristine worlds.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus, executeAuthorizedBatch } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { parseOperation, renderOperation } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { inventoryCheckpoint, planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('provider forbidden in queued-craft lane') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const mode = arg('mode')
assert.ok(['control', 'proof'].includes(mode))
const results = path.resolve(arg('results'))
const transcript = []; const sent = []
let connection, ctx, unit
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); ${  body}`))
const snapshot = () => lua(`local f=nil; for _,e in pairs(a.surface.find_entities_filtered{type="furnace",position=a.position,radius=32}) do if e.unit_number==${unit} then f=e end end; assert(f and f.valid); local o=remote.call("autorio_operations","status");
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end
  rcon.print(helpers.table_to_json({held=counts(a.get_main_inventory()),output=counts(f.get_output_inventory()),humans=#game.connected_players,speed=game.speed,
  actor_id=a.unit_number,target={unit_number=f.unit_number,name=f.name,position={x=f.position.x,y=f.position.y},surface_index=f.surface.index},
  queue_length=o.queue_length,task_state=o.task_state,last_completed=o.last_completed_batch,last_cancelled=o.last_cancelled_batch,basic=o.basic_operation,journal=remote.call("autorio_operation_admission","status")}))`)
async function idle() {
  // add_task is accepted before the manager's next on_tick; a same-tick idle
  // snapshot does not mean the just-enqueued batch has completed.
  await delay(250)
  const deadline = Date.now() + 60000
  for (;;) {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    if (s.queue_length === 0 && s.task_state === 'idle') return s
    assert.ok(Date.now() < deadline, 'native operation timeout')
    await delay(100)
  }
}
const collect = () => ({ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 1, to_entity: false } })
const craft = { name: 'craft_item', args: { item_name: 'automation-science-pack', count: 1 } }
const checkpoint = inventoryCheckpoint('automation-science-pack', 1)
const reply = (operations, initial = false) => planReply({ plan: ['Craft one red science pack'], currentStep: 0, operations,
  stepCompletions: [{ kind: 'deterministic', checkpoint }],
  ...(initial ? { checkpoint, stepCompletions: [{ kind: 'deterministic', checkpoint }],
    goal: { scope: 'finite', summary: 'Hold one red science pack', doneWhen: [{ kind: 'inventory_count', item_name: 'automation-science-pack', minimum: 1 }] } } : {}),
})
const observe = { content: null, tool_calls: [{ id: 'furnace', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17, name: 'stone-furnace', limit: 3 }) } }] }
async function completion() {
  await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
}
try {
  await fsp.mkdir(results, { recursive: true })
  const readyDeadline = Date.now() + 20000
  for (;;) {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); break }
    catch (error) { assert.ok(Date.now() < readyDeadline, `RCON not ready: ${error.message}`); await delay(100) }
  }
  await configureNpcSession(rcon, `queued-craft-${mode}-session`)
  const setup = await lua(`game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); a.get_main_inventory().clear();
    for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=12}) do if e~=a then e.destroy() end end;
    local tiles={} for dx=-12,12 do for dy=-12,12 do tiles[#tiles+1]={name="landfill",position={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy}} end end;
    a.surface.set_tiles(tiles,true,false,true);
    local f=a.surface.create_entity{name="stone-furnace",position={x=math.floor(a.position.x)+3,y=math.floor(a.position.y)},force=a.force}; assert(f);
    assert(f.get_output_inventory().insert{name="copper-plate",count=1}==1); assert(a.insert{name="iron-gear-wheel",count=1}==1);
    a.force.technologies["automation-science-pack"].researched=true;
    rcon.print(helpers.table_to_json({unit=f.unit_number}))`)
  unit = setup.unit
  // Declared fixture ends here. No further stock insertion, entity creation,
  // teleport, research manipulation or provider call is permitted.
  const before = await idle()
  assert.equal(before.held['copper-plate'] ?? 0, 0)
  assert.equal(before.output['copper-plate'], 1)
  let evidence
  if (mode === 'control') {
    // Resolve through the production discovery API, which registers the live
    // entity handle. A fixture unit number alone is not an operation target.
    const discovered = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_nearby_entities",17,"stone-furnace",nil,3)))')
    assert.ok(discovered.entities.some(entity => entity.unit_number === unit))
    const status = await deploymentStatus(rcon, { requireAllowed: true })
    let failure
    try { await executeAuthorizedBatch(rcon, status.epoch, [collect(), craft].map(op => renderOperation(parseOperation(op))), undefined,
      { protocol_version: 2, operation_key: 'queued-craft-control/batch_1', attempt_id: 'control-1', signature: 'run-k-control', actor: { actor_id: status.actor_id }, ordinal: 1 }) }
    catch (error) { failure = error }
    assert.ok(failure)
    assert.match(failure.message, /operation 2: Not enough ingredients/)
    assert.equal(failure.operationIndex, 1)
    assert.equal(failure.admission.state, 'uncertain')
    assert.equal(failure.admission.slots[0].ok, true)
    assert.equal(failure.admission.slots[1].refused_before_mutation, true)
    const after = await idle()
    assert.equal(after.held['copper-plate'], 1, `accepted withdrawal prefix actually executes: ${JSON.stringify(after)}`)
    assert.equal(after.held['automation-science-pack'] ?? 0, 0)
    assert.equal(after.held['iron-gear-wheel'], 1)
    evidence = { before, after, error: failure.message, operationIndex: failure.operationIndex, admission: failure.admission }
  }
  else {
    const model = new ScriptedModel().push('planner', 'observe', observe)
      .push('planner', 'run-k', reply([collect(), craft], true))
      .push('planner', 'correct-collect-only', async messages => {
        assert.equal(sent.length, 0, 'nothing was dispatched before correction')
        assert.deepEqual(await snapshot(), before, 'native world and admission high-water are unchanged by refusal')
        assert.match(messages.map(m => m.content).join('\n'), /wait for its receipt/)
        return reply([collect()])
      })
      .push('executor', 'craft-after-receipt', reply([craft]))
    const world = recoveryWorld({ game: rcon, model })
    const status = await deploymentStatus(rcon, { requireAllowed: true })
    ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
    ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
    ctx.session.queuePlayerRequest('TTLouis', 'Craft one red science pack')
    await settle(ctx.session)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].includes("'craft_item'"), false, 'unsafe mixed batch never admitted')
    const routed = world.named('craft.preflight_receipt_required')
    assert.equal(routed.length, 1)
    assert.equal(routed[0].reason, 'craft_requires_settled_inventory')
    assert.ok(routed[0].request_id)
    const plan = structuredClone(world.memory.planningState(KEY))
    await completion()
    assert.equal(sent.length, 2)
    assert.equal(sent[1].includes("'move_items_exact'"), false)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, plan.goal.goal_id)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, plan.plans.at(-1).steps)
    await completion()
    const after = await idle()
    assert.deepEqual(after.target, before.target)
    assert.equal(after.held['automation-science-pack'], 1)
    assert.equal(after.held['copper-plate'] ?? 0, 0)
    assert.equal(after.output['copper-plate'] ?? 0, 0)
    assert.equal(after.held['iron-gear-wheel'] ?? 0, 0)
    const produced = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="automation-science-pack",minimum=1})))')
    assert.equal(produced.satisfied, true)
    assert.equal(produced.current, 1)
    assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
    assert.equal(world.memory.currentPlan(KEY), undefined)
    assert.deepEqual(world.named('request.failed'), [])
    assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
    assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
    assert.deepEqual([...ctx.logs, ...world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed/.test(line)), [])
    evidence = { before, after, produced, admitted: sent.length, trace: world.trace }
  }
  await fsp.writeFile(path.join(results, `queued-craft-${mode}.json`), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, ...evidence }, null, 2))
  process.stdout.write(`queued-craft ${mode} PASS\n`)
}
catch (error) {
  await fsp.writeFile(path.join(results, `queued-craft-${mode}-error.txt`), `${error.stack}\n${JSON.stringify({ labels: ctx?.model.labels, logs: ctx?.logs, transcript }, null, 2)}`)
  throw error
}
finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume() }
  connection?.close()
}
