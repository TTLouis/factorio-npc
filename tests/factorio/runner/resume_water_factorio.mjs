// Deterministic real-engine proof: concentric native water discovery and a
// protocol-3 operator-paused committed goal across a real engine/host restart.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { answersStepContract, planReply, gather } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in resume-water fixture') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const mode = arg('mode')
assert.ok(['prepare', 'verify'].includes(mode))
let connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
const transcript = []; const trace = []; const calls = []
const rcon = { command: async command => {
  const answer = await connection.command(command)
  transcript.push({ command, answer: String(answer) })
  return answer
} }
const KEY = 'npc:sgluna'
const file = path.join(results, 'resume-water-state.json')
const json = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const operations = () => json('rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))')
async function idle() {
  for (let i = 0; i < 300; i++) {
    const status = await operations()
    if (status.task_state === 'idle' && status.queue_length === 0) return status
    await delay(100)
  }
  throw new Error('native idle deadline')
}
const description = 'Gather ten iron ore.'
const checkpoint = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] }
const memory = new CanonicalTaskBoardMemory()
let agent
try {
  const deadline = Date.now() + 15000
  while (true) {
    try { await connection.connect(); break }
    catch (error) {
      connection.close()
      if (Date.now() >= deadline) throw error
      await delay(100)
      connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    }
  }
  await configureNpcSession(rcon, 'resume-water-fixture')
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  if (mode === 'prepare') {
    await json(`local a=game.get_entity_by_unit_number(${actor.actor_id}); assert(a and a.valid);
      local s=game.create_surface("resume-water",{seed=424242,water=0,autoplace_settings={entity={treat_missing_as_default=false,settings={}}}});
      s.request_to_generate_chunks({0,0},9); s.force_generate_chunk_requests();
      for _,e in pairs(s.find_entities()) do e.destroy() end;
      local tiles={}; for x=-255,255 do for y=-255,255 do tiles[#tiles+1]={name="landfill",position={x,y}} end end;
      for x=160,191 do for y=-128,-97 do tiles[#tiles+1]={name="water",position={x,y}} end end;
      for x=-48,-32 do for y=-8,8 do tiles[#tiles+1]={name="water",position={x,y}} end end;
      s.set_tiles(tiles,true,false,true); assert(a.teleport({0,0},s)); a.get_main_inventory().clear();
      s.create_entity{name="iron-ore",position={5,0},amount=5000}; game.speed=1;
      rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players}))`)
    const water = await json('rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_fluid_source_tiles",{fluid_name="water",search_radius=256,limit=8})))')
    assert.equal(water.ok, true)
    assert.equal(water.nearest_samples_proven, true)
    assert.equal(water.ordering, 'nearest_first')
    assert.ok(water.samples.length > 0 && water.samples.every(s => s.position.x < 0 && s.distance < 50))
    assert.ok(water.nearest_query_count <= 19)
    await fs.writeFile(path.join(results, 'nearest-water-proof.json'), JSON.stringify(water, null, 2))
  }
  agent = new NpcAgentLoop({ rcon, memory, npcId: 'sgluna', stateFile: file, traceFile: path.join(results, `resume-water-${mode}-behavior.jsonl`),
    decisionTraceFile: null, completionProtocolVersion: 3,
    onActivity: (event, data) => trace.push({ event, data }),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: mode === 'prepare' ? 'new_goal' : 'continue_current', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      calls.push(context.role)
      const held = getActivePlan(memory.planningState(KEY))
      if (context.role === 'planner') return planReply({ plan: [description], operations: [],
        ...(mode === 'prepare' ? { goal: { scope: 'finite', summary: description,
          doneWhen: [{ kind: 'inventory_count', item_name: 'iron-ore', minimum: 10 }] },
        stepCompletions: [{ kind: 'deterministic', checkpoint }],
        executionGuidance: [{ approach: 'Gather from the local iron deposit.', rationale: 'Meet the native inventory target.', constraints: [], skillIds: [], materialSupply: null }] } : {}) })
      return planReply({ stepId: held.steps[0].step_id, operations: [gather('iron-ore', mode === 'prepare' ? 1 : 9)] })
    }) })
  if (mode === 'verify') await agent.loadPersistentState()
  const before = mode === 'verify' ? structuredClone(memory.planningState(KEY)) : null
  if (before) assert.equal(before.run.paused, true)
  await agent.request(mode === 'prepare' ? description : 'continue', { sender: 'fixture-owner' })
  await idle()
  if (mode === 'prepare') {
    await agent.reconcileOutstandingOperation({ trigger: 'fixture_native_receipt' })
    await agent.settleOutstandingOperation(await agent.readTaskStatusRaw())
    assert.equal(memory.pendingOperations(KEY).length, 0)
    memory.pausePlan(KEY, 'user_stop', { pause_class: 'operator' })
    await agent.persistState({ strict: true })
    await fs.writeFile(path.join(results, 'resume-water-original.json'), JSON.stringify(memory.planningState(KEY), null, 2))
  }
  else {
    assert.deepEqual(calls, ['planner', 'executor'])
    assert.equal(memory.planningState(KEY).run.paused, false)
    assert.equal(memory.planningState(KEY).goal.goal_id, before.goal.goal_id)
    assert.deepEqual(getActivePlan(memory.planningState(KEY)).steps, getActivePlan(before).steps)
    assert.deepEqual(memory.planningState(KEY).run.auto_resume, before.run.auto_resume)
    const native = await json(`local a=game.get_entity_by_unit_number(${actor.actor_id}); rcon.print(helpers.table_to_json({iron=a.get_item_count("iron-ore"),humans=#game.connected_players}))`)
    assert.equal(native.humans, 0)
    assert.equal(native.iron, 10)
    await agent.completed()
    assert.equal(getActivePlan(memory.planningState(KEY)).status, 'COMPLETED')
    await fs.writeFile(path.join(results, 'resume-water-proof.json'), JSON.stringify({ status: 'pass', mode, actor, native,
      original_goal_id: before.goal.goal_id, final: memory.planningState(KEY), calls, trace }, null, 2))
  }
  console.log(`resume-water ${mode} PASS`)
}
finally {
  await fs.writeFile(path.join(results, `resume-water-${mode}-transcript.json`), JSON.stringify({ calls, trace, transcript }, null, 2))
  connection.close()
}
