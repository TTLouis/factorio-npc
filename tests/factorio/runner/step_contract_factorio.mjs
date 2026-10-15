#!/usr/bin/env node
// Run P: a JIT step contract uses its own canonical wire output schema.
// Real Session/role resolution, production admission and native physics; all
// provider replies use an injected scripted fetch; every uninjected fetch fails.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { configuration, Session } from '../pterodactyl/runtime-v8/supervisor.mjs'
import { providerRequest } from '../pterodactyl/runtime-v8/provider.mjs'
import { STEP_CONTRACT_SCHEMA } from '../pterodactyl/runtime-v8/luna-step-contracts.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in step-contract fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = [], sent = [], seen = {}, identities = {}, placements = {}, wire = [], wireFaults = [], contractCalls = []
let connection, ctx, water
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command('/silent-command local a=game.surfaces["step-contract"].find_entities_filtered{name="character"}[1]; assert(a); ' + body))
const heldCount = name => lua(`rcon.print(a.get_main_inventory().get_item_count("${name}"))`)
const snapshot = () => lua(`local o=remote.call("autorio_operations","status"); local s=a.surface; local entities={};
  for _,e in pairs(s.find_entities_filtered{force=a.force,name={"offshore-pump","boiler","steam-engine","lab","small-electric-pole"}}) do
    local st=nil; for k,v in pairs(defines.entity_status) do if v==e.status then st=k end end;
    local d={name=e.name,unit_number=e.unit_number,position=e.position,status=st,fluid_targets={}};
    for i=1,#e.fluidbox do for _,c in pairs(e.fluidbox.get_pipe_connections(i)) do
      local t=c.target and c.target.owner; if t and t.valid then d.fluid_targets[#d.fluid_targets+1]=t.unit_number end
    end end;
    if e.name=="lab" or e.name=="steam-engine" then d.energy=e.energy; d.network=e.electric_network_id or 0 end;
    if e.name=="steam-engine" then d.generating=e.energy_generated_last_tick; local f=e.fluidbox[1]; d.steam=f and f.amount or 0 end;
    if e.name=="boiler" then local f=e.fluidbox[1]; d.water=f and f.amount or 0 end;
    if e.name=="lab" then d.science=e.get_item_count("automation-science-pack") end; entities[#entities+1]=d
  end;
  local chunks=0; for c in s.get_chunks() do chunks=chunks+1 end;
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,position=a.position,entities=entities,chunks=chunks,tick=game.tick,
    humans=#game.connected_players,speed=game.speed,queue_length=o.queue_length,task_state=o.task_state,
    current=a.force.current_research and a.force.current_research.name,progress=a.force.research_progress,
    artificial=s.count_entities_filtered{type={"electric-energy-interface","solar-panel","accumulator"}},
    journal=remote.call("autorio_operation_admission","status")}))`)
async function until(label, predicate, timeout = 90000) {
  const deadline = Date.now() + timeout
  for (;;) {
    assertHealthy()
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < deadline, `timeout ${label}; model=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
function assertHealthy() {
  if (!ctx) return
  assert.deepEqual(wireFaults, [], 'serialized step-contract request must contain only canonical contract output rules')
  assert.deepEqual(model.violations, [], 'native fixture provider script violated its bounded call contract')
  assert.deepEqual(ctx.world.named('request.failed'), [], `native request failed; logs=${JSON.stringify(ctx.logs)}`)
  const bad = [...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line))
  assert.deepEqual(bad, [], 'native fixture session reported a failed continuation')
}
async function idle() {
  await delay(250)
  return until('native settled admission', async () => {
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
  assertHealthy()
  return s
}
const STEPS = ['Craft the pump, boiler, steam engine, four pipes and one pole', 'Place an offshore pump and boiler with native water connection', 'Complete a connected steam chain and power a lab']
const crafted = [['offshore-pump', 1], ['boiler', 1], ['steam-engine', 1], ['pipe', 4], ['small-electric-pole', 1]]
const craftCheckpoint = { mode: 'all', requirements: crafted.map(([item_name, minimum], i) => ({ id: `crafted_${i}`, kind: 'inventory_count', item_name, minimum })) }
const placedCheckpoint = { mode: 'all', requirements: ['offshore-pump', 'boiler'].map((prototype, i) => ({ id: `placed_${i}`, kind: 'entity_count', prototype, minimum: 1 })) }
const poweredCheckpoint = { mode: 'all', requirements: [{ id: 'powered_lab', kind: 'entity_count', prototype: 'lab', minimum: 1, state: 'powered' }] }
const goal = { scope: 'finite', summary: 'Craft steam equipment, connect water and steam, and power a lab', doneWhen: [{ kind: 'electric_network_satisfied', entity_name: 'lab', minimum: 1 }] }
function reply(operations = [], extra = {}) {
  const board = ctx?.world.memory.currentPlan(KEY)?.task_board
  const plan = ctx?.world.memory.planningState(KEY)?.plans?.at(-1)
  return board ? planReply({ chatMessage: '', plan: STEPS, currentStep: plan.active_step_index, stepId: board.active_step_id, operations })
    : planReply({ plan: STEPS, currentStep: 0, operations, checkpoint: craftCheckpoint,
      stepCompletions: [{ kind: 'deterministic', checkpoint: craftCheckpoint }, { kind: 'deterministic' }, { kind: 'deterministic' }], ...extra })
}
let call = 0
const reads = tools => ({ content: null, tool_calls: tools.map(([name, args]) => ({ id: `native-${++call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) })
const lastTool = messages => JSON.parse([...messages].reverse().find(message => message.role === 'tool').content)
function placeFrom(messages, name, choose = rows => rows[0]) {
  const set = lastTool(messages)
  assert.ok(set.ok !== false && set.candidate_set_id && set.candidates?.length, `${name}: ${JSON.stringify(set)}`)
  const candidate = choose(set.candidates)
  assert.ok(candidate, `${name}: no matching native candidate ${JSON.stringify(set)}`)
  placements[name] = candidate
  return reply([{ name: 'place_candidate', args: { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id } }])
}
function entityFrom(messages, name) {
  const status = lastTool(messages)
  const entity = status.entity
  assert.ok(entity?.unit_number > 0, `${name}: ${JSON.stringify(status)}`)
  identities[name] = entity.unit_number
  return entity
}
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-three-step-slice', reply([], { goal }))
  .push('executor', 'luna:craft-native-equipment', () => reply(crafted.map(([item_name, count]) => ({ name: 'craft_item', args: { item_name, count } }))))
  .push('executor', 'luna:fresh-water-after-JIT', reads([['getFluidSourceTiles', { fluid_name: 'water', search_radius: 64, limit: 8 }]]))
  .push('executor', 'luna:fresh-shoreline-candidates', messages => {
    const source = lastTool(messages)
    assert.ok(source.samples?.length > 0)
    water = source.samples[0].position
    return reads([['getPlacementCandidates', { entity_name: 'offshore-pump', center: water, radius: 12, limit: 8 }]])
  })
  .push('executor', 'luna:place-observed-pump', messages => placeFrom(messages, 'offshore-pump'))
  .push('executor', 'luna:fresh-pump-identity', reads([['getEntityStatus', { name: 'offshore-pump', radius: 32 }]]))
  .push('executor', 'luna:connected-boiler-candidates', messages => {
    const e = entityFrom(messages, 'offshore-pump')
    return reads([['getPlacementCandidates', { entity_name: 'boiler', connects_to: { unit_number: e.unit_number }, limit: 8 }]])
  })
  .push('executor', 'luna:place-connected-boiler', messages => placeFrom(messages, 'boiler'))
  .push('executor', 'luna:fresh-boiler-identity', reads([['getEntityStatus', { name: 'boiler', radius: 32 }]]))
  .push('executor', 'luna:connected-engine-candidates', messages => {
    const e = entityFrom(messages, 'boiler')
    const steam = placements.boiler.fluid_ports.find(port => port.filter === 'steam')
    assert.ok(steam?.storage_index)
    return reads([['getPlacementCandidates', { entity_name: 'steam-engine', connects_to: { unit_number: e.unit_number, storage_index: steam.storage_index }, limit: 8 }]])
  })
  .push('executor', 'luna:place-connected-engine', messages => placeFrom(messages, 'steam-engine'))
  .push('executor', 'luna:fresh-engine-and-lab-candidates', () => reads([
    ['getEntityStatus', { name: 'steam-engine', radius: 32 }],
    ['getPlacementCandidates', { entity_name: 'lab', center: placements['steam-engine'].position, radius: 6, limit: 8 }],
  ]))
  .push('executor', 'luna:place-unpowered-lab', messages => {
    const tools = messages.filter(message => message.role === 'tool').slice(-2)
    entityFrom([tools[0]], 'steam-engine')
    return placeFrom([tools[1]], 'lab')
  })
  .push('executor', 'luna:fresh-lab-identity', reads([['getEntityStatus', { name: 'lab', radius: 32 }]]))
  .push('executor', 'luna:fuel-and-science', messages => {
    entityFrom(messages, 'lab')
    return reply([
      { name: 'supply_entity', args: { unit_number: identities.boiler, items: [{ item_name: 'coal', count: 10 }] } },
      { name: 'supply_entity', args: { unit_number: identities.lab, items: [{ item_name: 'automation-science-pack', count: 10 }] } },
      { name: 'research_technology', args: { technology_name: 'automation' } },
    ])
  })
  .push('executor', 'luna:power-bridge-candidates', async () => {
    const s = await snapshot()
    seen.unpowered = s
    const lab = s.entities.find(e => e.name === 'lab')
    assert.equal(lab.energy, 0)
    assert.equal(s.progress, 0)
    assert.equal(ctx.world.memory.currentPlan(KEY).task_board.completed_count, 2, 'placed equipment and science cannot close the powered checkpoint')
    const engine = placements['steam-engine'].position, labPosition = placements.lab.position
    return reads([['getPlacementCandidates', { entity_name: 'small-electric-pole', center: { x: (engine.x + labPosition.x) / 2, y: (engine.y + labPosition.y) / 2 }, radius: 8, limit: 8 }]])
  })
  .push('executor', 'luna:connect-power-bridge', messages => placeFrom(messages, 'small-electric-pole', rows => rows.find(row => {
    const covered = row.electric?.covers_entities ?? []
    return covered.some(e => e.unit_number === identities.lab) && covered.some(e => e.unit_number === identities['steam-engine'])
  })))

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, 'step-contract-delegation-session')
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
    + 'game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=game.create_surface("step-contract",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); '
    + 's.request_to_generate_chunks({16,16},4); s.force_generate_chunk_requests(); for _,e in pairs(s.find_entities()) do e.destroy() end; local tiles={}; '
    + 'for x=-64,95 do for y=-64,95 do tiles[#tiles+1]={name=x>=32 and "water" or "landfill",position={x,y}} end end; '
    + 's.set_tiles(tiles,true,false,true); assert(a.teleport({16,16},s)); s.always_day=true; local inv=a.get_main_inventory(); inv.clear(); '
    + 'for _,v in pairs({{"iron-plate",100},{"copper-plate",50},{"stone",10},{"wood",10},{"lab",1},{"coal",10},{"automation-science-pack",10}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end; '
    + 'for _,n in pairs({"steam-power","electronics","automation-science-pack"}) do a.force.technologies[n].researched=true end; '
    + 'assert(not a.force.technologies.automation.researched); rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index,position=a.position}))'))
  // Setup ends here: no teleport, terrain edit, generated-chunk request, stock
  // insertion, or corrective command is issued after this boundary.
  const before = await idle()
  for (const [name] of crafted) assert.equal(await heldCount(name), 0, 'only crafting inputs are seeded for the equipment step')
  // Native construction genuinely needs current geometry after every receipt.
  // Select four existing observation families using the live noul contract;
  // the runtime's normal limits and counters remain authoritative.
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'nearby_world', 'placement_candidates', 'entity_status']) {
      const key = `need_${family}`
      if (questions[key]) overrides[key] = { noul: 0.9 }
    }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const bridge = Object.create(Session.prototype)
  bridge.config = configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only-not-a-real-key', OPENAI_API_BASEURL: 'https://provider.example.test/v1', AI_API_METHOD: 'local', OPENAI_MODEL: `${PLANNER_MODEL},${EXECUTOR_MODEL}` })
  bridge.provider = (config, messages, context) => providerRequest(config, messages, {
    ...context, promptTraceFile: path.join(results, 'step-contract-provider.jsonl'),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      const captured = { body, role: context.role, trigger: context.triggerSource, request_id: context.requestId, actor_id: context.actorId, epoch: context.epoch }
      wire.push(captured)
      let message
      if (context.triggerSource === 'step_contract') {
        contractCalls.push(captured)
        const all = body.messages.map(row => String(row.content)).join('\n')
        const tools = body.tools?.map(tool => tool.function.name) ?? []
        if (/\[CONTROL_OUTPUT\]|\[STEERING\]|\[PROVIDER_STYLE\]/.test(all) || tools.some(name => name !== 'defineStepContract')) {
          wireFaults.push({ reason: 'conflicting_gameplay_contract_in_serialized_step_contract_request', tools, has_control_output: /\[CONTROL_OUTPUT\]/.test(all) })
          throw new Error('serialized step-contract request includes conflicting CONTROL_OUTPUT or gameplay tools')
        }
        assert.equal(body.model, PLANNER_MODEL)
        assert.equal(context.allowTools, false)
        assert.equal(body.max_tokens, 6000)
        assert.equal(body.tool_choice, 'none')
        assert.deepEqual(tools, ['defineStepContract'])
        assert.ok(body.messages.some(row => row.role === 'system' && String(row.content).startsWith('[STEP_CONTRACT_OUTPUT]')))
        assert.ok(all.includes(JSON.stringify(STEP_CONTRACT_SCHEMA)), 'canonical schema reaches serialized prompt')
        assert.deepEqual(body.tools[0].function.parameters, STEP_CONTRACT_SCHEMA)
        const request = body.messages.find(row => row.role === 'user' && row.content.startsWith('[STEP_CONTRACT_REQUEST]'))
        assert.ok(request)
        const packet = JSON.parse(request.content.slice(request.content.indexOf(' {"goal"') + 1))
        captured.packet = packet
        const index = packet.target.index
        assert.ok(index === 1 || index === 2)
        assert.equal(packet.slice.steps[0].status, 'completed')
        assert.ok(packet.verified_results.some(row => row.step_id === packet.slice.steps[0].step_id))
        const live = await snapshot()
        if (index === 1) {
          assert.equal(sent.length, 1, 'future contract follows only the real equipment craft batch')
          captured.heldEquipment = {}
          // One small-pole craft yields two poles in this native engine.
          for (const [name, count] of crafted) {
            captured.heldEquipment[name] = await heldCount(name)
            assert.equal(captured.heldEquipment[name], name === 'small-electric-pole' ? count * 2 : count)
          }
          assert.equal(live.entities.length ?? Object.keys(live.entities).length, 0)
        }
        if (contractCalls.length === 1) {
          // Exact Run P malformed requirement shape, with only the target id rebound.
          message = { content: JSON.stringify({ stepId: packet.target.step_id, checkpoint: { mode: 'all', requirements: [{ kind: 'entity_exists', entity_name: 'offshore-pump', minimum: 1 }, { kind: 'entity_exists', entity_name: 'boiler', minimum: 1 }] } }) }
        } else {
          if (index === 1) {
            assert.equal(contractCalls.length, 2)
            assert.ok(body.messages.some(row => row.role === 'user' && /checkpoint_not_supported/.test(row.content)), 'strict first-reply rejection reaches bounded correction')
          } else assert.equal(contractCalls.length, 3)
          message = { content: JSON.stringify({ stepId: packet.target.step_id, checkpoint: index === 1 ? placedCheckpoint : poweredCheckpoint }) }
        }
      } else message = await model.provide(body.messages, context)
      return new Response(JSON.stringify({ id: `scripted-wire-${wire.length}`, model: body.model, choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const world = recoveryWorld({ game: rcon, model, decisionScript, agentRoleConfig: bridge.config })
  // Contract calls traverse the actual serializer, never answersStepContract.
  world.agent.provider = (messages, context) => bridge.roleProvider(messages, context)
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Craft steam equipment, place a water-connected pump and boiler, then power a lab')
  await settle(ctx.session)
  assertHealthy()
  const goalId = world.memory.planningState(KEY).goal.goal_id
  const canonicalSteps = structuredClone(world.memory.planningState(KEY).plans.at(-1).steps)
  const planId = world.memory.planningState(KEY).plans.at(-1).plan_id
  assert.equal(sent.length, 1)
  assert.equal(contractCalls.length, 0, 'no JIT prediction before equipment craft completion')
  seen.crafted = await completion()
  assert.equal(contractCalls.length, 2, 'first malformed contract gets exactly one correction')
  assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1)
  for (let index = 0; index < 5; index++) {
    if (index === 1) {
      // Check actual topology/flow BEFORE delivering the boiler completion
      // receipt. The supported count contract is not connectivity authority.
      seen.waterConnected = await until('native pump-to-boiler water before placement milestone', async () => {
        const s = await snapshot(), pump = s.entities.find(e => e.name === 'offshore-pump'), boiler = s.entities.find(e => e.name === 'boiler')
        return boiler?.water > 0 && boiler.fluid_targets.includes(pump?.unit_number) ? s : false
      })
      assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 1)
    }
    await completion()
    if (index === 1) assert.equal(contractCalls.length, 3)
    assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
    assert.equal(world.memory.planningState(KEY).plans.at(-1).plan_id, planId)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps.map(row => [row.step_id, row.description]), canonicalSteps.map(row => [row.step_id, row.description]))
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps[0].completion_contract, canonicalSteps[0].completion_contract, 'JIT contract binding preserves the already verified craft checkpoint')
  }
  await until('native steam-powered lab research', async () => {
    const s = await snapshot(), lab = s.entities.find(e => e.name === 'lab'), engine = s.entities.find(e => e.name === 'steam-engine')
    return lab?.energy > 0 && engine?.generating > 0 && s.progress > 0 ? s : false
  })
  const poweredBefore = await snapshot()
  await completion()
  await until('native science consumption and advancing research', async () => {
    const s = await snapshot(), lab = s.entities.find(e => e.name === 'lab')
    return lab?.science < 10 && s.progress > poweredBefore.progress ? s : false
  })
  const after = await idle()
  const lab = after.entities.find(e => e.name === 'lab'), engine = after.entities.find(e => e.name === 'steam-engine'), boiler = after.entities.find(e => e.name === 'boiler')
  assert.equal(after.actor_id, before.actor_id)
  assert.equal(after.artificial, 0)
  assert.ok(lab.energy > 0 && lab.network > 0 && lab.network === engine.network)
  assert.ok(engine.steam > 0 && engine.generating > 0 && boiler.water > 0)
  assert.ok(boiler.fluid_targets.includes(identities['offshore-pump']) && boiler.fluid_targets.includes(engine.unit_number))
  assert.ok(engine.fluid_targets.includes(boiler.unit_number))
  assert.ok(after.progress > poweredBefore.progress && after.progress > 0)
  assert.ok(lab.science < 10)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  const candidateChecks = world.named('step.candidate_placement_receipt_checked')
  assert.ok(candidateChecks.length > 0, 'native candidate placement must receive strict receipt checking before its world checkpoint')
  assert.ok(candidateChecks.every(row => row.request_id && row.reason === 'strict_native_placement_receipt_requires_world_checkpoint'))
  assert.equal(world.memory.currentPlan(KEY), undefined)
  assert.deepEqual(world.named('request.failed'), [])
  assert.deepEqual(world.named('recovery.routed'), [])
  assert.equal(sent.length, 7, 'craft, pump, boiler, engine, lab, supply/research, pole: exact bounded batches with no replay')
  assert.equal(wire[0].body.model, PLANNER_MODEL)
  assert.ok(wire.filter(row => row.trigger !== 'step_contract').slice(1).every(row => row.body.model === EXECUTOR_MODEL))
  assert.equal(contractCalls.length, 3)
  assert.equal(wire.length, model.calls.length + 3, 'only the scripted gameplay calls and three bounded JIT calls reach transport')
  assert.ok(contractCalls.every(row => row.actor_id === status.actor_id && row.epoch === status.epoch))
  assert.equal(contractCalls[0].packet.target.step_id, contractCalls[1].packet.target.step_id)
  assert.ok(contractCalls.every(row => row.packet.slice.plan_id === planId))
  assert.deepEqual(world.named('plan.contract_call_attempt').map(row => [row.attempt, row.outcome]), [[1, 'rejected'], [2, 'accepted'], [1, 'accepted']])
  assert.deepEqual(world.named('plan.contract_call_failed'), [])
  const providerRows = (await fsp.readFile(path.join(results, 'step-contract-provider.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const outputTraces = providerRows.filter(row => row.event === 'provider.step_contract_output_contract')
  assert.equal(outputTraces.length, 3)
  assert.ok(outputTraces.every(row => row.request_id && row.reason === 'step_contract_requires_target_checkpoint_json'))
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, 'step-contract-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    setup, before, seen, poweredBefore, after, identities, placements, wire, contractCalls, trace: world.trace }, null, 2))
  process.stdout.write('step-contract native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'step-contract-error.txt'), `${error.stack}\n${JSON.stringify({ wireFaults, wire, labels: model.labels, logs: ctx?.logs, seen, trace: ctx?.world.trace, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume() }
  connection?.close()
}
