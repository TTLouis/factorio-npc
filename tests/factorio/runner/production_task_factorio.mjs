#!/usr/bin/env node
// Run AN quantity/compiler repair: real Factorio preflight, native hand crafts,
// finite furnace production and the actual Session completed() lifecycle.
// Provider/Jev replies are scripted local fixtures; external inference is fatal.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { renderOperationPreflight } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { compileQuantities } from '../pterodactyl/runtime-v8/quantity-compiler.mjs'
import { getActivePlan } from '../pterodactyl/runtime-v8/planning-state.mjs'
import { recoveryWorld, recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const snapshots = []
const sourceIdentity = {}
let forbiddenFetch = 0; let connection; let ctx; let identity; let fixture; let injectResidual = false; let residualInjected = false
globalThis.fetch = async () => { forbiddenFetch++; throw new Error('External inference is forbidden in production-task lane') }
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = body => rcon.command(`/silent-command ${body}`).then(JSON.parse)
const actorLua = body => lua(`local a=game.get_entity_by_unit_number(${identity.actor_id}); assert(a and a.valid); ${body}`)
const snapshot = async () => {
  const state = await actorLua(`local f=nil;for _,e in pairs(a.surface.find_entities_filtered{type="furnace"}) do if e.unit_number==${fixture.furnace} then f=e end end;assert(f and f.valid,"fixture furnace missing");local o=remote.call("autorio_operations","status");
    local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=(t[v.name] or 0)+v.count end return t end;
    local statistics=a.force.get_item_production_statistics(a.surface);
    rcon.print(helpers.table_to_json({tick=game.tick,humans=#game.connected_players,speed=game.speed,actor_id=a.unit_number,
      held=counts(a.get_main_inventory()),source=counts(f.get_inventory(defines.inventory.crafter_input)),output=counts(f.get_output_inventory()),fuel=counts(f.get_fuel_inventory()),
      furnace_status=f.status,crafting_progress=f.crafting_progress,produced={poles=statistics.get_input_count("small-electric-pole"),cables=statistics.get_input_count("copper-cable"),plates=statistics.get_input_count("copper-plate")},
      credited={poles=remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="small-electric-pole",minimum=1}).current,
        cables=remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="copper-cable",minimum=1}).current,
        plates=remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="copper-plate",minimum=1}).current},
      task_state=o.task_state,queue_length=o.queue_length,journal=remote.call("autorio_operation_admission","status")}))`)
  assert.equal(state.actor_id, identity.actor_id); assert.equal(state.humans, 0); assert.equal(state.speed, 1)
  snapshots.push(state)
  return state
}
function healthy() {
  if (!ctx) return
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [], JSON.stringify(ctx.logs))
  assert.deepEqual(ctx.world.named('goal.paused'), [], JSON.stringify(ctx.world.trace.slice(-12)))
  assert.equal(ctx.world.memory.pauseRecord(KEY).paused, false, JSON.stringify(ctx.world.trace.slice(-12)))
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function idle() {
  // Enqueue can precede the native manager's next tick. Never infer completion
  // from the same-tick idle state immediately after the admission acknowledgement.
  await delay(250)
  const end = Date.now() + 90000
  for (;;) {
    healthy()
    const state = await snapshot()
    const records = Array.isArray(state.journal.records) ? state.journal.records : []
    if (state.task_state === 'idle' && state.queue_length === 0 && !records.some(row => row.state === 'admitted')) return state
    assert.ok(Date.now() < end, 'Native production operation timed out')
    await delay(100)
  }
}
async function complete() {
  await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  healthy()
}
const checkpoint = (item_name, minimum) => ({ mode: 'all', requirements: [{ kind: 'inventory_count', item_name, minimum }] })
const objective = (item, count) => `Produce and hold ${count} ${item} through finite harness production`
const planner = (item, count, supply = null) => planReply({ plan: [objective(item, count)], currentStep: 0, operations: [],
  goal: { scope: 'finite', summary: objective(item, count), doneWhen: checkpoint(item, count).requirements },
  stepCompletions: [{ kind: 'deterministic', checkpoint: checkpoint(item, count) }],
  executionGuidance: [{ approach: 'Use the existing declared stock and observed native recipe yields.', rationale: 'Compile desired item units in the harness and settle native batches before continuing.', constraints: [], skillIds: [], materialSupply: supply }],
})
const execute = productionTask => () => {
  const held = getActivePlan(ctx.world.memory.planningState(KEY))
  return planReply({ stepId: held.steps[held.active_step_index].step_id, operations: [], productionTask })
}

try {
  await fs.mkdir(results, { recursive: true })
  for (const filename of ['npc-agent-loop.mjs', 'production-task-runtime.mjs', 'production-repair.mjs', 'production-task.mjs', 'quantity-compiler.mjs', 'material-ledger.mjs', 'structured-policy.mjs']) {
    sourceIdentity[filename] = createHash('sha256').update(await fs.readFile(new URL(`../pterodactyl/runtime-v8/${filename}`, import.meta.url))).digest('hex')
  }
  sourceIdentity.native_control = createHash('sha256').update(await fs.readFile(`${process.env.FACTORIO_ROOT ?? '/opt/factorio'}/mods/autorio_0.1.0/control.lua`)).digest('hex')
  const ready = Date.now() + 20000
  for (;;) {
    connection?.close()
    connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); break }
    catch (error) { assert.ok(Date.now() < ready, error.message); await delay(100) }
  }
  await configureNpcSession(rcon, 'production-task-session')
  identity = await deploymentStatus(rcon, { requireAllowed: true })
  fixture = await actorLua(`game.speed=1;remote.call("autorio_operations","cancel_all_tasks");
    local s=game.create_surface("production-task",{seed=424242,width=64,height=64,water=0,autoplace_settings={entity={treat_missing_as_default=false,settings={}}}});
    s.request_to_generate_chunks({0,0},1);s.force_generate_chunk_requests();for _,e in pairs(s.find_entities()) do e.destroy() end;
    local tiles={} for x=-16,16 do for y=-16,16 do tiles[#tiles+1]={name="grass-1",position={x,y}} end end;s.set_tiles(tiles);assert(a.teleport({0,3},s));
    local inventory=a.get_main_inventory();inventory.clear();for name,count in pairs({wood=1,["copper-plate"]=1,["copper-ore"]=2,coal=2}) do assert(inventory.insert{name=name,count=count}==count) end;
    local required={["small-electric-pole"]=true,["copper-cable"]=true,["copper-plate"]=true};local unlocks={};
    for name,technology in pairs(a.force.technologies) do for _,effect in pairs(technology.prototype.effects or {}) do
      if effect.type=="unlock-recipe" and required[effect.recipe] then technology.researched=true;unlocks[#unlocks+1]=name end end end;
    for name in pairs(required) do assert(a.force.recipes[name].enabled,"fixture recipe must be unlocked: "..name) end;
    local f=s.create_entity{name="stone-furnace",position={0,0},force=a.force};assert(f);
    rcon.print(helpers.table_to_json({furnace=f.unit_number,base=script.active_mods.base,seed=s.map_gen_settings.seed,declared_recipe_unlocks=unlocks}))`)
  assert.equal(fixture.base, process.env.FACTORIO_VERSION ?? '2.0.77')
  // Declared fixture ends. No stock insertion, terrain/entity edits, teleport,
  // research manipulation, human connection or clock acceleration follows.
  const before = await idle()
  const recipes = []
  for (const item of ['small-electric-pole', 'copper-cable']) {
    const detail = await actorLua(`rcon.print(helpers.table_to_json(remote.call("autorio_knowledge","recipe_details","${item}",1)))`)
    assert.equal(detail.found, true); assert.equal(detail.truncated, false)
    recipes.push(detail.recipes.find(row => row.name === item))
  }
  const bill = compileQuantities({ targets: [{ item_name: 'small-electric-pole', count: 2 }], recipes, inventory: before.held })
  assert.deepEqual(bill.nodes.map(row => [row.name, row.crafts, row.produced_items]), [['copper-cable', 1, 2], ['small-electric-pole', 1, 2]])
  assert.deepEqual(bill.acquisition, [])
  const negative = JSON.parse(await rcon.command(renderOperationPreflight({ name: 'craft_item', args: { item_name: 'copper-cable', count: 2 } })))
  assert.equal(negative.ok, false)
  assert.equal(negative.code, 'bootstrap_dependency_unresolved')
  assert.equal(negative.requested_count, 2); assert.equal(negative.craftable_now_count, 1)
  const unchanged = await snapshot()
  assert.deepEqual(unchanged.held, before.held)
  assert.equal(sent.length, 0)

  const model = new ScriptedModel()
    .push('planner', 'AN:desired-two-poles', planner('small-electric-pole', 2))
    .push('executor', 'AN:harness-compiled-crafts', execute({ targets: [{ item_name: 'small-electric-pole', count: 2 }] }))
    .push('planner', 'AN:finite-furnace-output', planner('copper-plate', 2, { mode: 'manual_bootstrap', resource: 'copper-ore' }))
    .push('executor', 'AN:harness-fuel-wait-collect', execute({ targets: [{ item_name: 'copper-plate', count: 2 }], producers: [{ recipe_name: 'copper-plate', unit_number: fixture.furnace }], fuel: { item_name: 'coal', count: 2 } }))
  const world = recoveryWorld({ game: rcon, model, completionProtocolVersion: 3 })
  ctx = { world, model, ...recoverySession(world, { actorId: identity.actor_id, epoch: identity.epoch }) }
  ctx.session.ensureAuthorization = () => deploymentStatus(rcon, { requireAllowed: true })
  const commit = world.agent.commitPlan.bind(world.agent)
  world.agent.commitPlan = plan => {
    if (injectResidual && !residualInjected && world.agent.productionAdmission
      && plan.operations?.[0]?.name === 'craft_item' && plan.operations[0].args.item_name === 'copper-cable') {
      // Deliberately bypass quantity prevention with AN's exact wrong craft
      // count. The real native preflight sees and refuses this actual intent;
      // the harness must detect, reread/recompile and automatically continue.
      residualInjected = true
      plan = structuredClone(plan)
      plan.operations[0].args.count = 2
    }
    return commit(plan)
  }
  injectResidual = true
  ctx.session.queuePlayerRequest('TTLouis', objective('small-electric-pole', 2))
  await settle(ctx.session)
  healthy()
  for (let i = 0; i < 8 && world.memory.currentPlan(KEY); i++) await complete()
  const poles = await idle()
  assert.equal(world.memory.currentPlan(KEY), undefined, 'Finite pole result passed ordinary native goal verification')
  assert.equal(residualInjected, true)
  assert.equal(poles.held['small-electric-pole'], 2)
  assert.equal(poles.held['copper-cable'] ?? 0, 0)
  assert.equal(poles.held['copper-plate'] ?? 0, 0)
  // Factorio 2.0.77 does not count player-less hand-crafted products in force
  // statistics. The native-queue completion counter augments items_produced;
  // hand_craft_statistics_cell.py separately guards this engine behavior.
  assert.equal(poles.produced.poles - before.produced.poles, 0)
  assert.equal(poles.produced.cables - before.produced.cables, 0)
  assert.equal(poles.credited.poles - before.credited.poles, 2)
  assert.equal(poles.credited.cables - before.credited.cables, 2)
  assert.equal(sent.length, 2, 'Exactly one cable craft and one pole craft ran')
  assert.ok(sent.every(text => text.includes("'craft_item'")))
  const recoveries = world.named('production.recovery')
  assert.equal(recoveries.length, 1)
  assert.equal(recoveries[0].reason, negative.code)

  const furnaceStart = sent.length
  ctx.session.queuePlayerRequest('TTLouis', objective('copper-plate', 2))
  await settle(ctx.session)
  healthy()
  for (let i = 0; i < 24 && world.memory.currentPlan(KEY); i++) await complete()
  const final = await idle()
  assert.equal(world.memory.currentPlan(KEY), undefined, 'Finite furnace result passed ordinary native goal verification')
  assert.equal(final.held['copper-plate'], 2)
  assert.equal(final.produced.plates - before.produced.plates, 2)
  assert.equal(final.credited.plates - before.credited.plates, 2)
  assert.equal(final.held['small-electric-pole'], 2)
  assert.equal(final.held['copper-ore'] ?? 0, 0)
  const batches = sent.slice(furnaceStart)
  assert.ok(batches.some(text => text.includes("'supply_entity'")))
  assert.ok(batches.some(text => text.includes("'move_items_exact'")))
  assert.ok(batches.every(text => [...text.matchAll(/return remote\.call\('autorio_operations'/g)].length === 1), 'Fuel, input, waits and withdrawals have separate settled batches')
  assert.equal(model.labels.length, 4, 'No model observation, quantity repair or production continuation call')
  assert.deepEqual(model.remaining, []); assert.deepEqual(model.violations, [])
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  assert.equal(forbiddenFetch, 0)
  await fs.writeFile(path.join(results, 'production-task-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    source_identity: sourceIdentity, fixture, before, recipes, bill, negative, unchanged, poles, final, recoveries, admitted_batches: sent.length,
    scripted_model_calls: model.labels, external_inference_calls: forbiddenFetch, trace: world.trace }, null, 2))
  console.log('PASS Run AN production tasks: exact native excess-count refusal, one automatic recompile, two native crafts, separate furnace batches and verified output')
} catch (error) {
  await fs.writeFile(path.join(results, 'production-task-error.txt'), `${error.stack}\n${JSON.stringify({ labels: ctx?.model.labels, logs: ctx?.logs, trace: ctx?.world.trace }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); ctx.world.agent.cancel('native_lane_finished') }
  await fs.writeFile(path.join(results, 'production-task-transcript.json'), JSON.stringify(transcript, null, 2))
  await fs.writeFile(path.join(results, 'production-task-snapshots.json'), JSON.stringify(snapshots, null, 2))
  await fs.writeFile(path.join(results, 'production-task-source-identity.json'), JSON.stringify(sourceIdentity, null, 2))
  connection?.close()
}
