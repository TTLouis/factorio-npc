#!/usr/bin/env node
// Run L representative malformed reference + acquisition-checkpoint scope.
// Production Session/agent/model resolver, native receipts and physics. The
// providers are scripted; no inference call or post-setup repair is allowed.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { inventoryCheckpoint, planReply, jevContractLog, gather } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in invalid-reference fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = [], sent = []
let connection, ctx, placePosition, unit
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); ' + body))
const snapshot = () => lua(`local o=remote.call("autorio_operations","status");
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local f=a.surface.find_entities_filtered{type="furnace",force=a.force,position=a.position,radius=32}[1];
  rcon.print(helpers.table_to_json({held=counts(a.get_main_inventory()),output=f and counts(f.get_output_inventory()) or {},humans=#game.connected_players,speed=game.speed,
    actor_id=a.unit_number,target=f and {unit_number=f.unit_number,name=f.name,position={x=f.position.x,y=f.position.y},surface_index=f.surface.index} or nil,
    queue_length=o.queue_length,task_state=o.task_state,last_completed=o.last_completed_batch,last_cancelled=o.last_cancelled_batch,
    journal=remote.call("autorio_operation_admission","status")}))`)
async function until(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < deadline, `timeout ${label}; model=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250) // admission precedes the manager's next on_tick
  return until('native idle and settled admission', async () => {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    const records = Array.isArray(s.journal.records) ? s.journal.records : []
    return s.queue_length === 0 && s.task_state === 'idle' && !records.some(record => record.state === 'admitted') ? s : false
  })
}
async function completion() {
  const s = await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  return s
}
const furnaceContract = inventoryCheckpoint('stone-furnace', 1)
const copperContract = inventoryCheckpoint('copper-plate', 10)
const goal = { scope: 'finite', summary: 'Hold 10 copper plates', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] }
const craft = { name: 'craft_item', args: { item_name: 'stone-furnace', count: 1 } }
const draft = (step, checkpoint, operations, extra = {}) => planReply({ plan: [step], currentStep: 0, operations, checkpoint,
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra,
})
const furnaceReply = (operations, extra) => draft('Craft a stone furnace', furnaceContract, operations, extra)
const copperReply = operations => draft('Smelt and collect 10 copper plates', copperContract, operations)
const place = () => ({ name: 'place_entity', args: { entity_name: 'stone-furnace', ...placePosition } })
const supply = target => ({ name: 'supply_entity', args: { unit_number: target, items: [{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 10 }] } })
const observe = { content: null, tool_calls: [{ id: 'fresh-furnace', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17, name: 'stone-furnace', limit: 3 }) } }] }

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, 'invalid-reference-delegation-session')
  const setup = await lua(`game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); a.get_main_inventory().clear();
    for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=16}) do if e~=a then e.destroy() end end;
    local tiles={} for dx=-16,16 do for dy=-16,16 do tiles[#tiles+1]={name="landfill",position={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy}} end end;
    a.surface.set_tiles(tiles,true,false,true);
    local ore=a.surface.create_entity{name="stone",amount=100,position={x=math.floor(a.position.x)+6,y=math.floor(a.position.y)+3}}; assert(ore);
    assert(a.insert{name="coal",count=10}==10); assert(a.insert{name="copper-ore",count=10}==10);
    rcon.print(helpers.table_to_json({place={x=math.floor(a.position.x)+3,y=math.floor(a.position.y)},actor_id=a.unit_number}))`)
  placePosition = setup.place
  // Fixture setup ends here. Every subsequent game mutation is a production
  // operation chosen by a scripted role and admitted by the real harness.
  const before = await idle()
  assert.equal(before.held['stone-furnace'] ?? 0, 0)
  assert.equal(before.target, undefined)
  const model = new ScriptedModel()
    .push('planner', 'sol:craft-draft', furnaceReply([craft], { goal }))
    .push('planner', 'sol:bad-acquisition-checkpoint', planReply({ plan: ['Gather 5 stone', 'Craft a stone furnace'], currentStep: 0,
      operations: [gather('stone', 5)], checkpoint: inventoryCheckpoint('stone', 5),
      stepCompletions: [{ kind: 'deterministic', checkpoint: inventoryCheckpoint('stone', 5) }, { kind: 'deterministic' }],
    }))
    .push('planner', 'sol:preserve-result-acquire-stone', async () => {
      assert.equal(sent.length, 0)
      assert.deepEqual(await snapshot(), before, 'scope correction refusal leaves native state and journal unchanged')
      return furnaceReply([gather('stone', 5)])
    })
    .push('executor', 'luna:craft-real-result', furnaceReply([craft]))
    .push('planner', 'sol:next-smelting-slice', copperReply([]))
    .push('executor', 'luna:representative-invalid-reference', () => copperReply([place(), supply(0)]))
    .push('executor', 'luna:place-only', async (_messages, context) => {
      assert.equal(context.allowTools, true)
      assert.equal(sent.length, 2, 'invalid mixed batch never admitted its valid prefix')
      assert.equal((await snapshot()).target, undefined)
      return copperReply([place()])
    })
    .push('executor', 'luna:discover-after-placement', observe)
    .push('executor', 'luna:supply-current-identity', messages => {
      const tool = [...messages].reverse().find(message => message.role === 'tool')
      const entities = JSON.parse(tool.content).entities
      const target = entities.find(entity => entity.name === 'stone-furnace')
      assert.ok(target?.unit_number > 0)
      unit = target.unit_number
      return copperReply([supply(unit)])
    })
    .push('executor', 'luna:collect-output', () => copperReply([{ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: 10, to_entity: false } }]))
  const world = delegatedRecoveryWorld({ game: rcon, model })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Craft the furnace, then smelt and collect ten copper plates')
  await settle(ctx.session)
  const goalId = world.memory.planningState(KEY).goal.goal_id
  assert.equal(world.named('plan.preflight_checkpoint_change_rejected').length, 1)
  const acquired = await completion()
  assert.equal(acquired.held.stone, 5)
  assert.equal(acquired.held['stone-furnace'] ?? 0, 0)
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0, 'stone cannot close the furnace-result step')
  const crafted = await completion()
  assert.equal(crafted.held['stone-furnace'], 1)
  assert.equal(sent.length, 3, 'craft slice completed; planner returned and Luna admitted only placement')
  assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
  const routed = world.named('operations.arguments_rejected')
  assert.equal(routed.length, 1); assert.ok(routed[0].request_id)
  assert.equal(routed[0].reason, 'deterministic_operation_argument_validation')
  assert.equal(routed[0].arguments.unit_number, 0)
  const placed = await completion()
  assert.ok(placed.target?.unit_number > 0)
  assert.equal(unit, placed.target.unit_number)
  await idle()
  await until('10 real copper plates smelted', async () => (await snapshot()).output['copper-plate'] === 10)
  const smelted = await completion()
  assert.equal(smelted.output['copper-plate'], 10)
  assert.equal(smelted.held['copper-plate'] ?? 0, 0)
  await completion()
  const after = await idle()
  assert.equal(after.held['copper-plate'], 10)
  assert.equal(after.output['copper-plate'] ?? 0, 0)
  assert.equal(after.target.unit_number, unit)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  assert.deepEqual(world.named('request.failed'), [])
  assert.deepEqual(world.named('recovery.routed'), [], 'deterministic argument repair never asks Jev to reinterpret validation')
  assert.equal(sent.length, 5, 'acquisition, craft, placement, supply, collection: no replay or malformed batch')
  assert.deepEqual(world.modelRequests.map(row => row.model), [PLANNER_MODEL, PLANNER_MODEL, PLANNER_MODEL, EXECUTOR_MODEL, PLANNER_MODEL,
    EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL, EXECUTOR_MODEL])
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  assert.deepEqual([...ctx.logs, ...world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed/.test(line)), [])
  await fsp.writeFile(path.join(results, 'invalid-reference-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    before, acquired, crafted, placed, smelted, after, models: world.modelRequests, trace: world.trace }, null, 2))
  process.stdout.write('invalid-reference native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'invalid-reference-error.txt'), `${error.stack}\n${JSON.stringify({ labels: ctx?.model.labels, logs: ctx?.logs, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume() }
  connection?.close()
}
