#!/usr/bin/env node
// Run N: a fresh C7 conversation must receive its own mutable-world baseline.
// Native furnace physics and real Session/Sol-Luna routing; scripted inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'
import { recoverySession, ScriptedModel, settle, KEY } from '../pterodactyl/runtime-v8/recovery-loop-fixtures.mjs'
import { delegatedRecoveryWorld, PLANNER_MODEL, EXECUTOR_MODEL } from '../pterodactyl/runtime-v8/invalid-reference-fixtures.mjs'
import { planReply, jevContractLog } from '../pterodactyl/runtime-v8/task-loop-fixtures.mjs'

globalThis.fetch = async () => { throw new Error('inference forbidden in observation-baseline fixture') }
const arg = name => { const i = process.argv.indexOf(`--${name}`); assert.ok(i >= 0); return process.argv[i + 1] }
const results = path.resolve(arg('results'))
const transcript = []; const sent = []; const observations = []; const phases = []
let connection; let ctx; let unit; let labPosition; let call = 0
const rcon = { command: async (command, options) => {
  const answer = await connection.command(command, options)
  transcript.push({ command, answer: String(answer) })
  if (command.includes('local ok,result=pcall') && command.includes('"authorize"')) sent.push(command)
  return answer
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); ${  body}`))
const snapshot = () => lua(`local f=nil; for _,e in pairs(a.surface.find_entities_filtered{type="furnace",force=a.force}) do if e.unit_number==${unit} then f=e end end; assert(f);
  local function counts(i) local t={} for _,v in pairs(i.get_contents()) do t[v.name]=v.count end return t end;
  local o=remote.call("autorio_operations","status"); local labs={}; for _,e in pairs(a.surface.find_entities_filtered{name="lab",force=a.force}) do labs[#labs+1]={unit_number=e.unit_number,position=e.position,energy=e.energy} end;
  rcon.print(helpers.table_to_json({actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed,tick=game.tick,
    red_researched=a.force.technologies["automation-science-pack"].researched,red_recipe_enabled=a.force.recipes["automation-science-pack"].enabled,
    held=counts(a.get_main_inventory()),fuel=counts(f.get_fuel_inventory()),source=counts(f.get_inventory(defines.inventory.crafter_input)),output=counts(f.get_output_inventory()),
    target={unit_number=f.unit_number,name=f.name,position=f.position},labs=labs,queue_length=o.queue_length,task_state=o.task_state,
    journal=remote.call("autorio_operation_admission","status")}))`)
function healthy() {
  if (!ctx) return
  assert.deepEqual(ctx.model.violations, [])
  assert.deepEqual(ctx.world.named('request.failed'), [])
  assert.deepEqual([...ctx.logs, ...ctx.world.agentLogs].filter(line => /listener failed|Unable to|follow-up failed|Behavior trace write failed/.test(line)), [])
}
async function until(label, predicate, timeout = 180000) {
  const end = Date.now() + timeout
  for (;;) {
    healthy()
    const result = await predicate()
    if (result) return result
    assert.ok(Date.now() < end, `timeout ${label}; calls=${JSON.stringify(ctx?.model.labels)} logs=${JSON.stringify(ctx?.logs)}`)
    await delay(100)
  }
}
async function idle() {
  await delay(250)
  return until('native idle and settled journal', async () => {
    const s = await snapshot()
    assert.equal(s.humans, 0); assert.equal(s.speed, 1)
    const records = Array.isArray(s.journal.records) ? s.journal.records : []
    return s.queue_length === 0 && s.task_state === 'idle' && !records.some(row => row.state === 'admitted') ? s : false
  })
}
async function completion() {
  const s = await idle()
  ctx.session.lastCompletionAt = 0
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  healthy()
  return s
}
const checkpoint = { mode: 'all', requirements: [{ id: 'placed_lab', kind: 'entity_count', prototype: 'lab', minimum: 1 }] }
// Placement is independently required by the immutable slice checkpoint. The
// counter proves one actual craft, and makes no claim about power or automation.
const goal = { scope: 'finite', summary: 'Craft one lab from furnace-smelted plates and place it', doneWhen: [{ kind: 'items_produced', item_name: 'lab', minimum: 1 }] }
const step = 'Smelt copper, iron, and copper in one furnace; craft and place a lab'
const reply = (operations = [], extra = {}) => planReply({ plan: [step], currentStep: 0, operations, checkpoint,
  stepCompletions: [{ kind: 'deterministic', checkpoint }], ...extra })
const read = (name, args) => ({ id: `baseline-${++call}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
// Each decision observes a query only once, preserving the production duplicate-
// observation guard. Focused static continuation tests cover unchanged compaction;
// this lane proves full native baselines on both sides of a real C7 recovery.
const observe = (radius = 16) => ({ content: null, tool_calls: [read('getEntityStatus', { name: 'stone-furnace', radius }), read('getNearbyEntities', { name: 'stone-furnace', radius, limit: 3 })] })
function answers(messages) { return messages.filter(row => row.role === 'tool').slice(-2).map(row => JSON.parse(row.content)) }
function fullPair(messages, label) {
  const [entity, nearby] = answers(messages)
  assert.equal(entity.observation_mode, 'full', `${label}: first entity read in this conversation needs a full baseline`)
  assert.equal(nearby.observation_mode, 'full', `${label}: first nearby read in this conversation needs a full baseline`)
  assert.ok(entity.entity?.unit_number > 0)
  assert.equal(entity.entity.unit_number, unit)
  assert.ok(nearby.entities.some(row => row.unit_number === unit))
  assert.ok(entity.entity.inventories.flatMap(row => Array.isArray(row.items) ? row.items : []).some(row => row.name === 'copper-plate' && row.count === 10))
  observations.push({ label, entity, nearby })
}
const supply = items => ({ name: 'supply_entity', args: { unit_number: unit, items: items.map(([item_name, count]) => ({ item_name, count })) } })
const collect = (item_name, max_count) => ({ name: 'move_items_exact', args: { unit_number: unit, item_name, max_count, to_entity: false } })
function plateBill(recipes, name, count = 1, visiting = new Set()) {
  if (name === 'iron-plate' || name === 'copper-plate') return { [name]: count }
  assert.ok(!visiting.has(name), `cyclic native lab bill: ${name}`)
  const recipe = recipes[name]
  assert.ok(recipe, `missing native recipe in lab bill: ${name}`)
  const product = recipe.products.find(row => row.type === 'item' && row.name === name)
  assert.ok(product && Number.isInteger(product.amount) && product.amount > 0 && (product.probability ?? 1) === 1)
  const crafts = Math.ceil(count / product.amount); const bill = {}; const ancestors = new Set([...visiting, name])
  for (const ingredient of recipe.ingredients) {
    assert.equal(ingredient.type, 'item')
    for (const [plate, amount] of Object.entries(plateBill(recipes, ingredient.name, crafts * ingredient.amount, ancestors))) bill[plate] = (bill[plate] ?? 0) + amount
  }
  return bill
}
// Two ores cannot share one native furnace source slot. Repeating this real
// preflight refusal exercises the ordinary bounded correction/pause/C7 route.
const conflict = () => reply([supply([['iron-ore', 40], ['copper-ore', 5]])])
const model = new ScriptedModel()
  .push('planner', 'sol:immutable-lab-slice', reply([], { goal }))
  .push('executor', 'luna:discover-furnace', observe(8))
  .push('executor', 'luna:load-first-copper', messages => {
    const [entity] = answers(messages)
    assert.equal(entity.observation_mode, 'full')
    assert.equal(entity.entity.unit_number, unit)
    unit = entity.entity.unit_number // Gameplay uses the identity just observed.
    return reply([supply([['coal', 5], ['copper-ore', 10]])])
  })
  .push('executor', 'luna:observe-copper-output', observe())
  .push('executor', 'luna:mixed-source-refusal', messages => { fullPair(messages, 'before-C7'); return conflict() })
  .push('executor', 'luna:repeat-mixed-source-refusal', () => conflict())
  .push('executor', 'luna:C7-observe-same-world', () => {
    assert.ok(ctx.world.trace.some(row => row.event === 'context.restaged' && row.data.checkpoint === 'C7'))
    assert.equal(sent.length, 1, 'neither refused batch reached native admission')
    return observe()
  })
  .push('executor', 'luna:C7-clear-copper-output', messages => { fullPair(messages, 'after-C7'); return reply([collect('copper-plate', 10)]) })
  .push('executor', 'luna:load-iron-after-clear', () => reply([supply([['iron-ore', 40]])]))
  .push('executor', 'luna:collect-iron', () => reply([collect('iron-plate', 40)]))
  .push('executor', 'luna:load-second-copper-after-clear', () => reply([supply([['copper-ore', 5]])]))
  .push('executor', 'luna:collect-second-copper', () => reply([collect('copper-plate', 5)]))
  .push('executor', 'luna:craft-lab-from-smelted-stock', () => reply([{ name: 'craft_item', args: { item_name: 'lab', count: 1 } }]))
  .push('executor', 'luna:place-crafted-lab', () => reply([{ name: 'place_entity', args: { entity_name: 'lab', ...labPosition } }]))

try {
  await fsp.mkdir(results, { recursive: true })
  await until('RCON ready', async () => {
    connection?.close(); connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
    try { await connection.connect(); return true } catch { return false }
  }, 20000)
  await configureNpcSession(rcon, 'observation-baseline-native-session')
  const setup = await lua(`game.speed=1; remote.call("autorio_operations","cancel_all_tasks"); local inv=a.get_main_inventory(); inv.clear();
    for _,e in pairs(a.surface.find_entities_filtered{position=a.position,radius=20}) do if e~=a then e.destroy() end end;
    local tiles={} for dx=-20,20 do for dy=-20,20 do tiles[#tiles+1]={name="landfill",position={x=math.floor(a.position.x)+dx,y=math.floor(a.position.y)+dy}} end end; a.surface.set_tiles(tiles,true,false,true);
    local f=a.surface.create_entity{name="stone-furnace",position={x=math.floor(a.position.x)+3,y=math.floor(a.position.y)},force=a.force}; assert(f);
    for _,v in pairs({{"coal",5},{"copper-ore",15},{"iron-ore",40}}) do assert(inv.insert{name=v[1],count=v[2]}==v[2]) end;
    a.force.technologies["steam-power"].researched=true; a.force.technologies.electronics.researched=true;
    assert(not a.force.technologies["automation-science-pack"].researched); assert(not a.force.recipes["automation-science-pack"].enabled);
    local recipes={} for _,n in pairs({"lab","iron-gear-wheel","electronic-circuit","copper-cable","transport-belt"}) do local r=a.force.recipes[n]; assert(r); recipes[n]={ingredients=r.ingredients,products=r.products} end;
    rcon.print(helpers.table_to_json({unit=f.unit_number,lab_position={x=math.floor(a.position.x),y=math.floor(a.position.y)+5},actor_id=a.unit_number,recipes=recipes}))`)
  unit = setup.unit; labPosition = setup.lab_position
  // SETUP ENDS HERE. No inventory insertion, teleport, terrain repair, forced
  // crafting/completion, or entity creation occurs after this boundary.
  const before = await idle()
  assert.equal(before.held.lab ?? 0, 0); assert.equal(before.labs.length ?? Object.keys(before.labs).length, 0)
  assert.equal(before.red_researched, false); assert.equal(before.red_recipe_enabled, false)
  // Resolve the bill from this engine's real recipes, including two belts per
  // craft. Factorio 2.0.77's lab consumes 36 iron and 15 copper, leaving four iron.
  const labBill = plateBill(setup.recipes, 'lab')
  assert.deepEqual(labBill, { 'iron-plate': 36, 'copper-plate': 15 })
  const decisionScript = (_state, questions) => {
    const overrides = {}
    for (const family of ['runtime_status', 'nearby_world', 'entity_status']) if (questions[`need_${family}`]) overrides[`need_${family}`] = { noul: 0.9 }
    if (questions.intent) overrides.intent = { choice: 'new_goal', confidence: 0.9 }
    return { overrides }
  }
  const world = delegatedRecoveryWorld({ game: rcon, model, decisionScript })
  const status = await deploymentStatus(rcon, { requireAllowed: true })
  ctx = { world, model, ...recoverySession(world, { actorId: status.actor_id, epoch: status.epoch }) }
  ctx.session.ensureAuthorization = async () => deploymentStatus(rcon, { requireAllowed: true })
  ctx.session.queuePlayerRequest('TTLouis', 'Smelt copper then iron then copper in this furnace, craft one lab from those plates and place it')
  await settle(ctx.session)
  healthy()
  const goalId = world.memory.planningState(KEY).goal.goal_id
  const canonicalSteps = structuredClone(world.memory.planningState(KEY).plans.at(-1).steps)
  const samePlan = () => {
    assert.equal(world.memory.planningState(KEY).goal.goal_id, goalId)
    assert.deepEqual(world.memory.planningState(KEY).plans.at(-1).steps, canonicalSteps)
    assert.equal(world.memory.currentPlan(KEY).task_board.completed_count, 0)
  }
  await idle()
  await until('first copper10', async () => (await snapshot()).output['copper-plate'] === 10)
  phases.push({ phase: 'first-copper', ...(await completion()) })
  samePlan()
  assert.equal(world.memory.pauseRecord(KEY).pause_class, 'model_recoverable')
  assert.equal(world.named('operations.preflight_recoverable').length, 1)
  assert.equal(world.named('recovery.auto_resume_scheduled').length, 1)
  assert.equal(sent.length, 1)
  await until('production recovery timer/C7 read and copper collection admission', async () => {
    await settle(ctx.session)
    return model.labels.includes('luna:C7-clear-copper-output') && sent.length === 2
  }, 25000)
  samePlan()
  phases.push({ phase: 'copper-cleared', ...(await completion()) })
  assert.equal(phases.at(-1).output['copper-plate'] ?? 0, 0)
  assert.equal(phases.at(-1).held['copper-plate'], 10)
  await idle()
  await until('iron40', async () => (await snapshot()).output['iron-plate'] === 40)
  phases.push({ phase: 'iron-smelted', ...(await completion()) })
  samePlan()
  phases.push({ phase: 'iron-cleared', ...(await completion()) })
  assert.equal(phases.at(-1).output['iron-plate'] ?? 0, 0)
  assert.equal(phases.at(-1).held['iron-plate'], 40)
  await idle()
  await until('second copper5', async () => (await snapshot()).output['copper-plate'] === 5)
  phases.push({ phase: 'second-copper-smelted', ...(await completion()) })
  samePlan()
  phases.push({ phase: 'second-copper-cleared', ...(await completion()) })
  assert.equal(phases.at(-1).output['copper-plate'] ?? 0, 0)
  assert.equal(phases.at(-1).held['copper-plate'], 15)
  assert.equal(phases.at(-1).red_researched, false, 'smelting does not bypass the native lab-craft trigger')
  phases.push({ phase: 'lab-crafted', ...(await completion()) })
  samePlan()
  assert.equal(phases.at(-1).held.lab, 1, 'real recursive native hand crafting produced the lab')
  await completion()
  await until('native lab craft unlocks red science', async () => {
    const s = await snapshot()
    return s.red_researched && s.red_recipe_enabled
  }, 10000)
  const after = await idle()
  assert.equal(after.labs.length, 1); assert.equal(after.held.lab ?? 0, 0)
  assert.equal(after.output['copper-plate'] ?? 0, 0); assert.equal(after.output['iron-plate'] ?? 0, 0)
  assert.equal(after.held['copper-ore'] ?? 0, 0); assert.equal(after.held['iron-ore'] ?? 0, 0)
  assert.equal(after.held['copper-plate'] ?? 0, 15 - labBill['copper-plate'])
  assert.equal(after.held['iron-plate'] ?? 0, 40 - labBill['iron-plate'])
  assert.equal(after.red_researched, true); assert.equal(after.red_recipe_enabled, true)
  assert.equal(sent.length, 8, 'exactly eight intended admitted batches; refused supplies and old batches never replay')
  assert.equal(world.named('recovery.auto_resume_started').length, 1)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(world.memory.currentPlan(KEY), undefined)
  const rebased = world.named('observation.baseline_rebased')
  assert.ok(rebased.some(row => row.request_id && row.reason === 'current_conversation_has_no_delivered_baseline'))
  assert.equal(world.modelRequests[0].model, PLANNER_MODEL)
  assert.ok(world.modelRequests.slice(1).every(row => row.model === EXECUTOR_MODEL))
  assert.deepEqual(model.remaining, []); healthy()
  assert.deepEqual(jevContractLog.filter(row => !row.ok), [])
  await fsp.writeFile(path.join(results, 'observation-baseline-proof.json'), JSON.stringify({ status: 'pass', candidate: process.env.NPC_TEST_CANDIDATE_SHA ?? null,
    before, phases, after, native_recipes: setup.recipes, lab_plate_bill: labBill, observations, admitted_batches: sent.length, models: world.modelRequests, trace: world.trace }, null, 2))
  process.stdout.write('observation-baseline native delegation PASS\n')
} catch (error) {
  await fsp.writeFile(path.join(results, 'observation-baseline-error.txt'), `${error.stack}\n${JSON.stringify({ labels: ctx?.model.labels, logs: ctx?.logs, observations, phases, transcript }, null, 2)}`)
  throw error
} finally {
  if (ctx) { ctx.session.stopping = true; ctx.session.clearAutoResume(); if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) }
  connection?.close()
}
