#!/usr/bin/env node
// Run M: local dry/incomplete searches do not establish a world blocker.
// Real Session/role resolution, production admission and native physics; all
// provider replies are scripted and fetch is forbidden.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in shoreline fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const waterOnly = process.argv.includes('--water-only')
const proofName = waterOnly ? 'shoreline-water-only' : 'shoreline-recovery'
const transcript = []; const sent = []; const seen = {}; const identities = {}; const placements = {}
let connection, ctx, eastward, water
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces["shoreline-recovery"].find_entities_filtered{name="character"}[1]; assert(a); ${  body}`))
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
const checkpoint = { mode: 'all', requirements: [{ id: 'powered_lab', kind: 'entity_count', prototype: 'lab', minimum: 1, state: 'powered' }] }
const goal = { scope: 'finite', summary: 'Power one lab with a native steam chain', doneWhen: [{ kind: 'electric_network_satisfied', entity_name: 'lab', minimum: 1 }] }
const step = 'Explore for water and construct a connected steam-powered lab'
const reply = (operations = [], extra = {}) => planReply({ plan: [step], currentStep: 0, operations, checkpoint,
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
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
  .push('planner', 'sol:immutable-powered-lab-slice', reply([], { goal }))
  .push('executor', 'luna:bounded-local-searches', reads(waterOnly ? [
    ['getFluidSourceTiles', { fluid_name: 'water', search_radius: 128, limit: 8 }],
  ] : [
    ['getFluidSourceTiles', { fluid_name: 'water', search_radius: 128, limit: 8 }],
    ['getPlacementCandidates', { entity_name: 'offshore-pump', radius: 24, limit: 8 }],
    ['getFluidSourceTiles', { fluid_name: 'water', search_radius: 256, limit: 8 }],
  ]))
  .push('executor', 'luna:unsupported-local-world-blocker', (messages, context) => {
    seen.toolsBeforeBlocker = context.allowTools
    const answers = messages.filter(message => message.role === 'tool').slice(waterOnly ? -1 : -3).map(message => JSON.parse(message.content))
    if (waterOnly) {
      seen.local = seen.wide = answers[0]
      assert.equal(transcript.filter(row => row.command.includes('get_placement_candidates')).length, 0)
      assert.equal(transcript.filter(row => row.command.includes('get_fluid_source_tiles')).length, 1)
    } else {
      ;[seen.local, seen.pump, seen.wide] = answers
      assert.equal(seen.local.returned_count, 0); assert.equal(seen.local.empty_result_is_conclusive, true)
      assert.equal(seen.pump.legal_candidate_count, 0)
    }
    assert.equal(seen.wide.returned_count, 0); assert.equal(seen.wide.coverage_complete, false)
    assert.ok(seen.wide.ungenerated_chunk_count > 0)
    eastward = seen.wide.ungenerated_chunks.find(row => row.center.x > (waterOnly ? 100 : 150) && Math.abs(row.center.y - 16) < 40)?.center
    assert.ok(eastward, JSON.stringify(seen.wide))
    return reply([], { chatMessage: waterOnly
      ? 'BLOCKED: The available actor-centered water scan found no water tiles, and its terrain coverage was incomplete. I cannot identify a legal shoreline placement site from the current evidence.'
      : 'BLOCKED: No water was found within radius 128, no offshore-pump candidate within radius 24, and radius 256 was incomplete with no samples. I cannot finish the steam-powered lab.' })
  })
  .push('executor', 'luna:bounded-exploration-correction', async (messages, context) => {
    assert.ok(messages.some(row => String(row.content).includes('[LOCAL_FLUID_SEARCH_RECOVERY]')), 'missing bounded local-fluid exploration correction')
    assert.equal(context.allowTools, seen.toolsBeforeBlocker, 'local correction does not replenish the tool budget')
    assert.equal(sent.length, 0, 'local blocker refusal cannot dispatch gameplay')
    const s = await snapshot()
    assert.equal(s.entities.length ?? Object.keys(s.entities).length, 0)
    return reply([{ name: 'walk_to_position', args: { ...eastward, reach_distance: 2 } }])
  })
  .push('executor', 'luna:fresh-fluid-read-after-walk', reads([['getFluidSourceTiles', { fluid_name: 'water', search_radius: 128, limit: 8 }]]))
  .push('executor', 'luna:approach-observed-shore', messages => {
    seen.afterWalk = lastTool(messages)
    assert.ok(seen.afterWalk.samples?.length > 0, JSON.stringify(seen.afterWalk))
    water = seen.afterWalk.samples[0].position
    return reply([{ name: 'walk_to_position', args: { x: water.x - 8, y: water.y + 0.5, reach_distance: 2 } }])
  })
  .push('executor', 'luna:fresh-shoreline-candidates', () => reads([['getPlacementCandidates', { entity_name: 'offshore-pump', center: water, radius: 12, limit: 8 }]]))
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
    assert.equal(ctx.world.memory.currentPlan(KEY).task_board.completed_count, 0, 'all equipment and science cannot close the powered checkpoint')
    const engine = placements['steam-engine'].position; const labPosition = placements.lab.position
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
  await configureNpcSession(rcon, 'shoreline-recovery-delegation-session')
  const setup = JSON.parse(await rcon.command(`/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); `
    + `game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local s=game.create_surface("shoreline-recovery",{seed=424242,width=0,height=0,water=0,cliff_settings={cliff_elevation_interval=0},autoplace_settings={entity={treat_missing_as_default=false,settings={}}}}); ${
     waterOnly ? 's.request_to_generate_chunks({16,16},2); s.request_to_generate_chunks({224,16},1); ' : 's.request_to_generate_chunks({16,16},4); s.request_to_generate_chunks({288,16},1); '
     }s.force_generate_chunk_requests(); `
    + `for _,e in pairs(s.find_entities()) do e.destroy() end; local tiles={}; ${
     waterOnly
      ? 'for x=-64,95 do for y=-64,95 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; for x=192,255 do for y=-32,63 do tiles[#tiles+1]={name=x>=216 and "water" or "landfill",position={x,y}} end end; '
      : 'for x=-128,159 do for y=-128,159 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; for x=256,319 do for y=-32,63 do tiles[#tiles+1]={name=x>=280 and "water" or "landfill",position={x,y}} end end; '
     }s.set_tiles(tiles,true,false,true); assert(a.teleport({16,16},s)); s.always_day=true; local inv=a.get_main_inventory(); inv.clear(); `
    + `for _,v in pairs({{"offshore-pump",1},{"boiler",1},{"steam-engine",1},{"lab",1},{"small-electric-pole",1},{"coal",10},{"automation-science-pack",10}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end; `
    + `for _,n in pairs({"steam-power","electronics","automation-science-pack"}) do a.force.technologies[n].researched=true end; `
    + `assert(not a.force.technologies.automation.researched); rcon.print(helpers.table_to_json({actor_id=a.unit_number,surface_index=s.index,position=a.position}))`))
  // Setup ends here: no teleport, terrain edit, generated-chunk request, stock
  // insertion, or corrective command is issued after this boundary.
  const before = await idle()
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
  const world = delegatedRecoveryWorld({ game: rcon, model, decisionScript })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Find a shoreline and power a lab using a connected steam chain')
  await settle(ctx.session)
  assertHealthy()
  const goalId = world.memory.planningState(KEY).goal.goal_id
  const canonicalSteps = structuredClone(world.memory.planningState(KEY).plans.at(-1).steps)
  const rejected = world.named('recovery.local_fluid_search_blocker_rejected')
  assert.equal(rejected.length, 1); assert.ok(rejected[0].request_id)
  assert.equal(rejected[0].reason, 'local_fluid_search_is_not_world_blocker')
  if (waterOnly) assert.equal(rejected[0].basis, 'water_only')
  else assert.ok(rejected[0].water_search && rejected[0].pump_search)
  assert.equal(world.named('recovery.auto_resume_started').length, 0)
  assert.equal(sent.length, 1)
  for (let index = 0; index < 7; index++) {
    await completion()
    assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonicalSteps)
  }
  await until('native steam-powered lab research', async () => {
    const s = await snapshot(); const lab = s.entities.find(e => e.name === 'lab'); const engine = s.entities.find(e => e.name === 'steam-engine')
    return lab?.energy > 0 && engine?.generating > 0 && s.progress > 0 ? s : false
  })
  const poweredBefore = await snapshot()
  await completion()
  await until('native science consumption and advancing research', async () => {
    const s = await snapshot(); const lab = s.entities.find(e => e.name === 'lab')
    return lab?.science < 10 && s.progress > poweredBefore.progress ? s : false
  })
  const after = await idle()
  const lab = after.entities.find(e => e.name === 'lab'); const engine = after.entities.find(e => e.name === 'steam-engine'); const boiler = after.entities.find(e => e.name === 'boiler')
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
  assert.equal(sent.length, 8, 'walk, shore approach, pump, boiler, engine, lab, supply/research, pole: bounded batches only')
  assert.equal(world.modelRequests[0].model, PLANNER_MODEL)
  assert.ok(world.modelRequests.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, `${proofName}-proof.json`), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null, waterOnly,
    setup, before, seen, poweredBefore, after, identities, placements, models: world.modelRequests, trace: world.trace }, null, 2))
  process.stdout.write(`${proofName} native delegation PASS\n`)
} catch (error) {
  await fsp.writeFile(path.join(results, `${proofName}-error.txt`), `${error.stack}\n${JSON.stringify({ labels: model.labels, logs: ctx?.logs, seen, trace: ctx?.world.trace, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume() }
  connection?.close()
}
