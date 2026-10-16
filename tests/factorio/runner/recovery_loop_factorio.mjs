#!/usr/bin/env node
// Test-only native G/H/I recovery fixture. Scripted providers; no model-facing gameplay walkthrough.
// Separate invocations are separate Node processes. run_lane.sh also restarts Factorio between phases.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, stepBlockLines, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { inventoryCheckpoint, planReply, jevContractLog, gather } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from '../pterodactyl/runtime-v8/run-check.mjs'

// No provider adapter can silently turn this deterministic lane into live inference.
globalThis.fetch = async () => { throw new Error('network inference forbidden in recovery-loop fixture') }
function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}
const mode = arg('mode')
assert.ok(['prepare', 'collect', 'settle', 'cancel'].includes(mode))
const results = path.resolve(arg('results'))
const stateFile = path.join(results, mode === 'cancel' ? 'cancel-state.json' : 'recovery-state.json')
const manifestFile = path.join(results, 'recovery-manifest.json')
const transcript = []
const sent = []
let connection
let ctx
let dropAck = false
let unit
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  const mutation = command.includes('local ok,result=pcall') && command.includes('"authorize"')
  if (mutation) sent.push(command)
  transcript.push({ command, answer: String(answer) })
  if (mutation && dropAck) { dropAck = false; return '' }
  return answer
} }
const ACTOR = 'local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
async function lua(body) {
  return JSON.parse(await rcon.command(`/silent-command ${ACTOR}${body}`))
}
async function snapshot() {
  return lua(`local f=nil; for _,e in pairs(a.surface.find_entities_filtered{type="furnace",position=a.position,radius=32}) do if e.unit_number==${unit} then f=e end end; assert(f); local o=remote.call("autorio_operations","status");
    local function counts(i) local r={} for _,v in pairs(i.get_contents()) do r[v.name]=v.count end return r end
    rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,
      target={unit_number=f.unit_number,name=f.name,position={x=f.position.x,y=f.position.y},surface_index=f.surface.index},
      held=counts(a.get_main_inventory()),fuel=counts(f.get_fuel_inventory()),source=counts(f.get_inventory(defines.inventory.crafter_input)),
      output=counts(f.get_output_inventory()),queue_length=o.queue_length,task_state=o.task_state,
      generation=o.batch_generation,journal=remote.call("autorio_operation_admission","status")}))`)
}
async function until(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < deadline, `timeout: ${label}; calls=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  return until('native idle', async () => {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    return s.queue_length === 0 && s.task_state === 'idle' ? s : false
  })
}
async function completion() {
  await idle()
  ctx.session.lastCompletionAt = 0
  // Deliver the native queue-completion signal through the production supervisor input.
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
}
const STEP = 'Smelt copper ore and collect 10 copper plates'
const CHECKPOINT = inventoryCheckpoint('copper-plate', 10)
const goal = { scope: 'finite', summary: 'Hold 10 copper plates.', doneWhen: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] }
const reply = (operations, extra = {}) => planReply({ plan: [STEP], currentStep: 0, operations, ...extra })
const observe = () => ({ content: null, tool_calls: [{ id: 'observe_furnace', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 17, name: 'stone-furnace', limit: 3 }) } }] })
const supply = items => ({ name: 'supply_entity', args: { unit_number: unit, items } })
const collect = count => ({ name: 'move_items_exact', args: { item_name: 'copper-plate', unit_number: unit, max_count: count, to_entity: false } })
const mixed = () => reply([gather('copper-ore', 10), supply([{ item_name: 'coal', count: 5 }, { item_name: 'iron-ore', count: 20 }, { item_name: 'copper-ore', count: 10 }])])
const blocked = () => reply([], { chatMessage: 'BLOCKED: cannot verify an executable copper acquisition route' })

async function harness(model) {
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  const world = recoveryWorld({ game: rcon, model, stateFile })
  const session = recoverySession(world, { actorId: status.actor_id, epoch: status.epoch })
  ctx = { model, world, ...session }
  // Reuse the real authorization health read, not the static fixture's fake status.
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  await world.agent.loadPersistentState()
  return ctx
}
function strict() {
  assert.deepEqual(jevContractLog.filter(entry => !entry.ok), [], 'all scripted Jev requests satisfy the live contract')
  assert.deepEqual(ctx.model.remaining, [])
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|trace write failed/.test(line)), [])
}
async function saveMap() {
  await ctx.world.agent.persistState()
  const save = arg('save')
  const before = (await fsp.stat(save)).mtimeMs
  await rcon.command('/silent-command game.server_save()')
  await until('save written', async () => (await fsp.stat(save)).mtimeMs > before)
}
function stopTimers() {
  if (!ctx) return
  ctx.session.stopping = true
  ctx.session.clearAutoResume()
  if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer)
}
async function setup() {
  await configureNpcSession(rcon, `recovery-loop-${mode === 'cancel' ? 'cancel' : 'chain'}-session`)
  const made = await lua(`game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local inv=a.get_main_inventory(); inv.clear();
    for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=12}) do if e~=a then e.destroy() end end
    local tiles={} for dx=-12,12 do for dy=-12,12 do tiles[#tiles+1]={name="landfill",position={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy}} end end
    a.surface.set_tiles(tiles,true,false,true)
    local f=a.surface.create_entity{name="stone-furnace",position={x=math.floor(a.position.x)+3,y=math.floor(a.position.y)},force=a.force}; assert(f);
    a.surface.create_entity{name="copper-ore",amount=100,position={x=math.floor(a.position.x)+8,y=math.floor(a.position.y)+4}};
    inv.insert{name="coal",count=10}; inv.insert{name="copper-ore",count=12}; inv.insert{name="iron-ore",count=20};
    rcon.print(helpers.table_to_json({unit=f.unit_number,actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  unit = made.unit
  assert.equal(made.humans, 0); assert.equal(made.speed, 1)
  // Fixture setup ends here: no subsequent inventory insertion, entity creation, teleport or gameplay repair.
  return made
}
async function reachG() {
  const model = new ScriptedModel()
    .push('planner', 'planner:observe', observe())
    .push('planner', 'planner:load', reply([supply([{ item_name: 'coal', count: 5 }, { item_name: 'copper-ore', count: 12 }])], { checkpoint: CHECKPOINT, goal, stepCompletions: [{ kind: 'deterministic', checkpoint: CHECKPOINT }] }))
    .push('executor', 'executor:observe', observe())
    .push('executor', 'executor:collect9', reply([collect(9)]))
    .push('executor', 'executor:observe-again', observe())
    .push('executor', 'g:mixed', () => mixed())
    .push('executor', 'g:mixed-again', () => mixed())
  await harness(model)
  assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'smelt ten copper plates in the furnace'), true)
  await settle(ctx.session)
  await idle()
  await until('12 plates smelted natively', async () => (await snapshot()).output['copper-plate'] === 12)
  await completion()
  await completion()
  strict()
  assert.equal(ctx.world.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
  assert.equal(ctx.world.named('operations.preflight_recoverable').length, 1)
  assert.equal(ctx.world.named('recovery.auto_resume_scheduled').length, 1)
  assert.equal(sent.length, 2, 'refused mixed supply never dispatched')
  const s = await snapshot()
  assert.equal(s.held['copper-plate'], 9); assert.equal(s.output['copper-plate'], 3)
  assert.equal(s.held['iron-ore'], 20)
  return s
}
async function main() {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { connection.close(); return false }
  }, 20000)
  if (mode === 'prepare' || mode === 'cancel') {
    await setup()
    const g = await reachG()
    if (mode === 'cancel') {
      const dispatched = sent.length
      assert.equal(ctx.session.queuePlayerRequest('TTLouis', 'stop'), true)
      await settle(ctx.session)
      await delay(16000) // let the original production 15s deadline pass
      await settle(ctx.session)
      assert.equal(sent.length, dispatched)
      assert.equal(ctx.world.named('recovery.auto_resume_started').length, 0)
      assert.equal(ctx.world.memory.pauseRecord(KEY).pause_class, 'operator')
      const stopped = await snapshot()
      assert.deepEqual(stopped.held, g.held); assert.deepEqual(stopped.output, g.output)
      strict()
      await fsp.writeFile(path.join(results, 'recovery-cancel.json'), JSON.stringify({ status: 'pass', before: g, after: stopped, dispatched }, null, 2))
    }
    else {
      ctx.model.push('executor', 'h:checkpoint', reply([], { checkpoint: CHECKPOINT }))
        .push('executor', 'h:blocked', blocked(), 2)
      await until('H timer recovery finishes', async () => {
        await settle(ctx.session)
        return ctx.world.named('recovery.auto_resume_scheduled').length === 2
      })
      strict()
      assert.equal(ctx.world.named('recovery.harness_state_fault').length, 0)
      assert.equal(ctx.world.memory.currentPlan(KEY).status, 'paused')
      const allowance = ctx.world.memory.autoResumeAllowance(KEY)
      assert.deepEqual([allowance.step_attempts, allowance.goal_attempts], [1, 1])
      stopTimers()
      await saveMap()
      await fsp.writeFile(manifestFile, JSON.stringify({ unit, target: g.target, g, allowance, goal_id: allowance.goal_id, plan_id: allowance.plan_id }, null, 2))
    }
  }
  else {
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'))
    unit = manifest.unit
    assert.deepEqual((await snapshot()).target, manifest.target, 'the cached fixture locator must still match native name, position and surface')
    await configureNpcSession(rcon, 'recovery-loop-chain-session')
    const model = new ScriptedModel()
    if (mode === 'collect') model.push('executor', 'i:collect', messages => {
      const lines = stepBlockLines(messages)
      const residual = lines.find(line => line.startsWith('residual_needs'))
      assert.match(residual, new RegExp(`in_machine_output=3@stone-furnace unit=${unit} missing_after_machine=0`))
      assert.doesNotMatch(residual, /copper-ore required=/)
      assert.equal(lines.some(line => line.startsWith('raw_leaf_acquisition')), false)
      assert.match(lines.find(line => line.startsWith('placed_machines')), /\[FRESH as_of=/)
      assert.equal(ctx.world.memory.currentPlan(KEY).status, 'active')
      dropAck = true
      return reply([collect(3)])
    })
    else model.push('executor', 'settle:observe', observe()).push('executor', 'settle:attempt-replay', reply([collect(3)]))
    await harness(model)
    const before = ctx.world.memory.autoResumeAllowance(KEY)
    assert.equal(before.goal_id, manifest.goal_id); assert.equal(before.plan_id, manifest.plan_id)
    ctx.session.queueStartupRecovery(ctx.session.currentPlanState())
    if (mode === 'collect') {
      await until('I automatic collection dispatch', async () => { await settle(ctx.session); return sent.length === 1 })
      await idle() // deliberately lose the completion notification too
      strict()
      assert.ok(['in_flight', 'happened'].includes(ctx.world.memory.pendingOperation(KEY).effect), 'native exact admission or completion proves the lost-acknowledgement batch')
      const s = await snapshot()
      assert.equal(s.held['copper-plate'], 12)
      const allowance = ctx.world.memory.autoResumeAllowance(KEY)
      assert.deepEqual([allowance.step_attempts, allowance.goal_attempts], [2, 2])
      stopTimers()
      await saveMap()
      await fsp.writeFile(path.join(results, 'recovery-collected.json'), JSON.stringify({ status: 'prepared', world: s, allowance }, null, 2))
    }
    else {
      await settle(ctx.session)
      strict()
      assert.equal(sent.length, 0, 'completed collection cannot dispatch twice after restart')
      assert.equal(ctx.world.named('operation.recovery_settled').length, 1)
      assert.equal(ctx.world.named('goal.evaluated').at(-1).satisfied, true)
      assert.equal(ctx.world.memory.currentPlan(KEY), undefined)
      const s = await snapshot()
      assert.equal(s.held['copper-plate'], 12); assert.equal(s.output['copper-plate'] ?? 0, 0)
      const signatures = analyzeBehaviorTrace(ctx.world.trace).findings.map(finding => finding.signature)
      for (const bad of ['harness_state_fault', 'silent_blocked_stall', 'auto_resume_exhausted']) assert.equal(signatures.includes(bad), false)
      await fsp.writeFile(path.join(results, 'recovery-complete.json'), JSON.stringify({ status: 'pass', candidate_sha: process.env.NPC_TEST_CANDIDATE_SHA, world: s, no_replay_dispatches: sent.length, provider_mode: 'scripted', signatures }, null, 2))
    }
  }
  console.log(`PASS: native recovery-loop ${mode}`)
}
main().catch(async error => {
  await fsp.mkdir(results, { recursive: true })
  await fsp.writeFile(path.join(results, `recovery-${mode}-error.txt`), `${error.stack ?? error}\nlabels=${JSON.stringify(ctx?.model.labels)}\nlogs=${JSON.stringify(ctx?.logs)}\nagentLogs=${JSON.stringify(ctx?.world.agentLogs)}\n`)
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  stopTimers()
  await fsp.writeFile(path.join(results, `recovery-${mode}-transcript.json`), JSON.stringify(transcript, null, 2)).catch(() => {})
  await fsp.writeFile(path.join(results, `recovery-${mode}-behavior.jsonl`), `${(ctx?.world.trace ?? []).map(row => JSON.stringify(row)).join('\n')  }\n`).catch(() => {})
  connection?.close()
})
