// Deterministic native acquisition barrier proof; no model/provider requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { activeStockDependencyBarrier } from '../pterodactyl/runtime-v8/bg-stock-dependency.mjs'
import { answersStepContract, planReply } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('Live inference forbidden in native stock proof') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', scope: 'new native fixture with scripted proposal; not sealed BG world replay', transcript: [], events: [], calls: [] }
let connection, agent
const rcon = { command: async command => {
  const response = await connection.command(command)
  evidence.transcript.push({ command, response }); return response
} }
const tool = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a;for _,s in pairs(game.surfaces)do local c=s.find_entities_filtered{name="character"};if #c>0 then a=c[1];break end end;assert(a);${body}`))
async function idle() {
  const until = Date.now() + 90000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) return status
    assert.ok(Date.now() < until, 'native stock proof deadline'); await delay(100)
  }
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); await connection.connect()
  evidence.factorio = JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json', 'utf8')).version
  assert.equal(evidence.factorio, '2.0.77')
  await configureNpcSession(rcon, 'bg-stock-native-fixture')
  evidence.setup = await lua(`local s=a.surface;local x=math.floor(a.position.x)+12;local y=math.floor(a.position.y);game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{x-6,y-6},{x+8,y+8}}})do if e.type~="character" then e.destroy()end end;
    local tiles={};for tx=x-6,x+8 do for ty=y-6,y+8 do tiles[#tiles+1]={name="landfill",position={tx,ty}}end end;s.set_tiles(tiles,true,false,true);
    assert(a.teleport({x,y},s));a.get_main_inventory().clear();local coal=s.create_entity{name="coal",position={x+2,y+2},amount=200};assert(coal);
    local furnace=s.create_entity{name="stone-furnace",position={x+4,y},force=a.force};assert(furnace);storage.bg_stock_fixture={furnace=furnace};
    rcon.print(helpers.table_to_json({furnace=furnace.unit_number,actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  assert.equal(evidence.setup.humans, 0); assert.equal(evidence.setup.speed, 1)
  const furnace = evidence.setup.furnace
  const operations = [{ name: 'gather_resource', args: { resource_name: 'coal', count: 3, search_radius: 16 } },
    { name: 'supply_entity', args: { unit_number: furnace, items: [{ item_name: 'coal', count: 1 }] } }]
  const memory = new CanonicalTaskBoardMemory(); const key = 'npc:bg-stock-native'
  const obligations = { outcome: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'coal', minimum: 2 }] }, preserve: [] }
  let observed = false
  agent = new NpcAgentLoop({ memory, rcon, npcId: 'bg-stock-native', completionProtocolVersion: 3, requireTypedObligations: true, replacementWake: true,
    stateFile: path.join(results, 'bg-stock-state.json'), traceFile: null, decisionTraceFile: null, systemPrompt: 'Deterministic native stock proof.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      evidence.calls.push(context.role)
      if (context.role === 'planner') {
        const journal = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')
        assert.ok(Number.isSafeInteger(journal.high_water))
        memory.planningState(key).operation_ledger = { sequence: journal.high_water, records: [], closed: [] }
        return planReply({ plan: ['Acquire coal for the existing furnace.'], operations: [],
          goal: { scope: 'finite', summary: 'Supply one coal and retain two.', doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 2 }] },
          stepCompletions: [{ kind: 'deterministic', checkpoint: obligations.outcome, obligations }],
          executionGuidance: [{ approach: 'Acquire then supply coal.', rationale: 'Bootstrap fuel.', constraints: [], skillIds: [], materialSupply: null }] })
      }
      if (!observed) { observed = true; return { content: '', tool_calls: [{ id: 'native-stock-observation', type: 'function', function: { name: 'getNearbyEntities', arguments: JSON.stringify({ radius: 32 }) } }] } }
      const held = getActivePlan(memory.planningState(key))
      return planReply({ stepId: held.steps[held.active_step_index].step_id, operations })
    }) })
  agent.behaviorTrace = { emit: async row => { evidence.events.push(row) } }
  evidence.started = await agent.request('Supply the existing furnace.', { sender: 'Louis' })
  const steps = structuredClone(getActivePlan(memory.planningState(key)).steps)
  assert.equal(activeStockDependencyBarrier(agent)?.state, 'prefix_pending')
  evidence.prefix_native = await idle()
  assert.equal(await lua('rcon.print(a.get_item_count("coal"))'), 3)
  const count = evidence.calls.length
  // Deliberately settle receipt first, then replace canonical memory as after a
  // restart. The barrier's exact original witness must survive this normal clear.
  await agent.taskStatusReceipt(); await agent.persistState({ strict: true })
  const restored = new CanonicalTaskBoardMemory(); restored.restore(memory.snapshot()); agent.memory = restored
  evidence.continued = await agent.completed()
  assert.equal(activeStockDependencyBarrier(agent)?.state, 'suffix_pending')
  assert.equal(evidence.calls.length, count, 'no corrective model call')
  assert.deepEqual(getActivePlan(restored.planningState(key)).steps, steps, 'prefix inventory checkpoint did not advance the semantic step')
  evidence.suffix_native = await idle()
  assert.equal(await lua('rcon.print(storage.bg_stock_fixture.furnace.get_item_count("coal"))'), 1)
  assert.equal(await lua('rcon.print(a.get_item_count("coal"))'), 2)
  evidence.finished = await agent.completed()
  assert.equal(activeStockDependencyBarrier(agent), undefined)
  assert.equal(agent.memory.planningState(key).goal.status, 'completed')
  assert.equal(evidence.events.filter(row => row.event === 'stock_dependency.completed').length, 1)
  const sends = evidence.transcript.filter(row => row.command.includes('SGLUNA_RESULT_') && row.command.includes('autorio_operation_admission'))
  assert.equal(sends.length, 2); assert.ok(sends[0].command.includes("'gather_resource'")); assert.ok(sends[1].command.includes("'supply_entity'"))
  evidence.status = 'pass'
} catch (error) { evidence.error = String(error); throw error }
finally {
  if (agent) { await agent.persistQueue; await fs.writeFile(path.join(results, 'bg-stock-memory.json'), `${JSON.stringify(agent.memory.snapshot(), null, 2)}\n`) }
  connection?.close(); await fs.writeFile(path.join(results, 'bg-stock-native.json'), `${JSON.stringify(evidence, null, 2)}\n`)
}
