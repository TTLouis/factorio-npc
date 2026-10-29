import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { toolCommand, renderOperationPreflight } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { preservationGeometry, preservedProofMatches, compileObligations } from '../pterodactyl/runtime-v8/contract-obligations.mjs'
import { itemPreservationConflict } from '../pterodactyl/runtime-v8/contract-obligation-runtime.mjs'
import { NpcAgentLoop } from '../pterodactyl/runtime-v8/npc-agent-loop.mjs'
import { CanonicalTaskBoardMemory } from '../pterodactyl/runtime-v8/canonical-task-board-memory.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { answersStepContract, planReply } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('No live inference in deterministic native proof') }
const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const evidence = { status: 'fail', scope: 'new native fixture; scripted decisions; original BF world not resumed', transcript: [], cases: [] }
let connection, agent, captureMissUnit
const rcon = { command: async command => {
  const response = await connection.command(command)
  evidence.transcript.push({ command, response })
  if (captureMissUnit && command.includes('entity_geometry') && command.includes(`,${captureMissUnit})`)) {
    captureMissUnit = undefined
    evidence.transcript.at(-1).injected_transport_miss = true
    throw new Error('injected lost native capture response')
  }
  return response
} }
const tool = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a;for _,s in pairs(game.surfaces) do local c=s.find_entities_filtered{name="character"};if #c>0 then a=c[1];break end end;assert(a);${body}`))
async function idle() {
  const until = Date.now() + 60000
  for (;;) {
    const status = await tool('getTaskStatus', {})
    if (status.task_state === 'idle' && status.queue_length === 0 && !status.active_batch) return status
    assert.ok(Date.now() < until, 'native work timed out'); await delay(100)
  }
}
try {
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') }); await connection.connect()
  evidence.factorio_version = JSON.parse(await fs.readFile('/opt/factorio/data/base/info.json', 'utf8')).version
  assert.equal(evidence.factorio_version, '2.0.77')
  await configureNpcSession(rcon, 'bf-item-preservation-offline')
  const setup = await lua(`local s=a.surface; local x=math.floor(a.position.x)+10.5; local y=math.floor(a.position.y)+0.5; game.speed=1;
    for _,e in pairs(s.find_entities_filtered{area={{x-5,y-5},{x+5,y+5}}}) do if e.type~="character" then e.destroy() end end;
    local tiles={};for tx=math.floor(x)-5,math.floor(x)+5 do for ty=math.floor(y)-5,math.floor(y)+5 do tiles[#tiles+1]={name="landfill",position={tx,ty}} end end;s.set_tiles(tiles,true,false,true);
    local i=s.create_entity{name="burner-inserter",position={x,y},direction=defines.direction.east,force=a.force};assert(i);
    local c=s.create_entity{name="wooden-chest",position=i.pickup_position,force=a.force};local b=s.create_entity{name="transport-belt",position=i.drop_position,direction=defines.direction.north,force=a.force};assert(c and b);
    c.insert{name="iron-plate",count=10};i.insert{name="coal",count=1}; a.get_main_inventory().clear();a.insert{name="coal",count=2};a.insert{name="stone-furnace",count=1};
    storage.bf_preservation_fixture={i=i,c=c,b=b};remote.call("autorio_tools","get_nearby_entities",64,nil,nil,100);
    rcon.print(helpers.table_to_json({inserter=i.unit_number,chest=c.unit_number,belt=b.unit_number,actor=a.unit_number,humans=#game.connected_players,speed=game.speed}))`)
  evidence.setup = setup; assert.equal(setup.humans, 0); assert.equal(setup.speed, 1)
  let initial
  for (let n = 0; n < 100; n++) {
    initial = await tool('getEntityGeometry', { unit_number: setup.inserter })
    if (initial.item_io?.drop_target?.unit_number === setup.belt && initial.item_io?.pickup_target?.unit_number === setup.chest) break
    await delay(100)
  }
  assert.equal(initial.item_io.drop_target.unit_number, setup.belt)
  assert.equal(initial.item_io.pickup_target.unit_number, setup.chest)
  const chest = await tool('getEntityGeometry', { unit_number: setup.chest })
  assert.equal(preservationGeometry(chest, setup.chest).entity.type, 'container')
  // Native tile coverage extends past collision coverage. Read the actual
  // footprint; no recipe/size facts are supplied from model memory.
  const placement = { name: 'place_entity', args: { entity_name: 'stone-furnace', x: initial.entity.position.x + 4.5, y: initial.entity.position.y + 4.5 } }
  const preflight = JSON.parse(await rcon.command(renderOperationPreflight(placement)))
  const fp = preflight.planned_footprint
  assert.ok(fp.tile_box.right_bottom.y > fp.world_box.right_bottom.y)
  const boundary = { x: fp.position.x, y: (fp.tile_box.right_bottom.y + fp.world_box.right_bottom.y) / 2 }
  const projection = preservationGeometry(initial, setup.inserter)
  projection.item_io.drop_position = boundary
  projection.item_io.drop_target = null
  assert.equal(itemPreservationConflict({ preserved: [projection] }, [placement], [preflight]).reason, 'item_port_occupancy_changed')
  evidence.tile_boundary = { preflight, boundary, substitution: 'Synthetic open-port position between the actual native tile and collision boundaries; tested guard geometry only.' }
  for (const residual of [false, true]) {
    await configureNpcSession(rcon, `bf-item-preservation-${residual}`)
    await lua('a.get_main_inventory().remove{name="coal",count=100};storage.bf_preservation_fixture.c.insert{name="coal",count=200};rcon.print("{}")')
    captureMissUnit = residual ? setup.chest : undefined
    const key = `npc:bf-native-${residual}`
    const memory = new CanonicalTaskBoardMemory(); const rows = []; let executors = 0
    const obligations = { outcome: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'coal', minimum: 3 }] }, preserve: [setup.inserter, setup.chest].sort((a, b) => a - b) }
    agent = new NpcAgentLoop({ memory, rcon, npcId: `bf-native-${residual}`, completionProtocolVersion: 3,
      requireTypedObligations: true, replacementWake: true, stateFile: path.join(results, `bf-native-${residual}.json`), traceFile: null, decisionTraceFile: null,
      systemPrompt: 'Offline deterministic preservation fixture.',
      interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
      provider: answersStepContract(async (_messages, context) => {
        if (context.role === 'planner') {
          // This lane shares a native actor with preceding deterministic cases.
          // Seed only the new fixture memory's ordinal from its real settled
          // journal; never reset the native journal or replay an old admission.
          const journal = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))')
          assert.ok(Number.isSafeInteger(journal.high_water))
          memory.planningState(key).operation_ledger = { sequence: journal.high_water, records: [], closed: [] }
          return planReply({ plan: ['Collect three coal from the chest while preserving the chest and inserter.'], currentStep: 0, operations: [],
          goal: { scope: 'finite', summary: 'Collect three coal while preserving the chest and its item route.', doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 3 }] },
          stepCompletions: [{ kind: 'deterministic', checkpoint: compileObligations(obligations), obligations }],
          executionGuidance: [{ approach: 'Collect three coal from the existing chest.', rationale: 'Preserve source and target identities.', constraints: [], skillIds: [], materialSupply: null }] })
        }
        const held = getActivePlan(memory.planningState(key)); const stepId = held.steps[0].step_id
        const liveBelt = await tool('getEntityGeometry', { unit_number: setup.belt })
        agent.recordLiveEntityObservation(liveBelt.entity, undefined, 'native_fixture_input')
        return planReply({ stepId, operations: ++executors === 1 ? [{ name: 'mine_entity_exact', args: { unit_number: setup.belt } }]
          : [{ name: 'move_items_exact', args: { unit_number: setup.chest, item_name: 'coal', max_count: 3, to_entity: false } }] })
      }) })
    agent.behaviorTrace = { emit: async row => { rows.push(row) } }
    if (residual) {
      const original = agent.preflightOperations.bind(agent); let bypassed = false
      agent.preflightOperations = async operations => { if (!bypassed) { bypassed = true; return operations.map(() => ({ ok: true })) } return original(operations) }
    }
    const item = { residual, events: rows }; evidence.cases.push(item)
    await agent.request('Collect three coal while preserving the chest and its item route.', { sender: 'Louis' })
    item.original_plan = structuredClone(getActivePlan(memory.planningState(key)))
    await idle(); item.result = await agent.completed(); await idle()
    const after = preservationGeometry(await tool('getEntityGeometry', { unit_number: setup.inserter }), setup.inserter)
    const before = preservationGeometry(initial, setup.inserter)
    assert.equal(preservedProofMatches({ preserved: [before] }, { preserved: [after] }), true)
    assert.equal((await tool('getEntityGeometry', { unit_number: setup.belt })).found, true)
    assert.equal(await lua('rcon.print(a.get_item_count("coal"))'), 3)
    assert.equal(rows.filter(row => row.event === 'contract.preservation_capture_recovered').length, residual ? 1 : 0)
    assert.equal(rows.filter(row => row.event === 'operations.preflight_recoverable').length, 1)
    assert.equal(rows.find(row => row.event === 'contract.item_preservation_refused').data.boundary, residual ? 'transport' : 'preflight')
    assert.equal(executors, 2)
    item.planning = memory.planningState(key)
    assert.equal(item.planning.goal.status, 'completed')
    assert.deepEqual(item.planning.plans[0].steps, item.original_plan.steps)
    const restored = new CanonicalTaskBoardMemory(); restored.restore(memory.snapshot())
    assert.equal(restored.planningState(key).goal.argument_corrections.claims.length, 1)
    agent.cancel('fixture_done'); agent = undefined
  }
  evidence.status = 'pass'
  console.log('PASS native BF item-route prevention/residual correction, container capture, exact receipts, unchanged identities and durable restore')
} finally {
  agent?.cancel('fixture_cleanup')
  if (connection) {
    try { await lua('local f=storage.bf_preservation_fixture;if f then for _,e in pairs(f) do if e.valid then e.destroy() end end end;rcon.print("{}")') } catch (error) { evidence.cleanup_error = error.message }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true }); await fs.writeFile(path.join(results, 'item-preservation.json'), JSON.stringify(evidence, null, 2))
}
