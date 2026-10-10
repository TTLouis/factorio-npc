// Single owner-authorized Luna experiment controller, mounted read-only in the
// isolated full deployment. No provider requests, gameplay advice or retries.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

assert(process.argv.includes('--go'), 'Explicit --go required')
const root = '/data/logs'
const verification = JSON.parse(await fsp.readFile(`${root}/deployment-verification.json`))
assert.equal(verification.verified, true)
assert.equal(process.env.OPENAI_MODEL, 'gpt-6-luna')
assert.equal(process.env.SGLUNA_GOAL_PURSUIT_MODE, 'direct')
const goal = JSON.parse(process.env.SGLUNA_GOAL_PURSUIT_GOAL)
const release = path.dirname(await fsp.realpath('/opt/sgluna/start-sgluna.sh'))
const { Rcon } = await import(pathToFileURL(path.join(release, 'src/runtime-v8/common.mjs')))
const rcon = new Rcon(27015, process.env.SGLUNA_RCON_PASSWORD, 15000)
const snapshot = '/silent-command local s=game.surfaces[1]; local id=remote.call("autorio_actor","status"); local a=game.get_entity_by_unit_number(id.actor.actor_id); assert(a and a.valid); local f=a.force; local st=f.get_item_production_statistics(s); local ok,b=pcall(function() return remote.call("autorio_task_board","status") end); rcon.print(helpers.table_to_json({tick=game.tick,seed=s.map_gen_settings.seed,speed=game.speed,humans=#game.connected_players,actor_id=a.unit_number,actor=id,position=a.position,inventory=a.get_main_inventory().get_contents(),red_unlocked=f.recipes["automation-science-pack"].enabled,green_researched=f.technologies["logistic-science-pack"].researched,green_enabled=f.recipes["logistic-science-pack"].enabled,red_produced=remote.call("autorio_tools","evaluate_condition",{kind="items_produced",item_name="automation-science-pack",minimum=75}),red_consumed=st.get_output_count("automation-science-pack"),board=ok and b or nil,operations=remote.call("autorio_operations","status")}))'
const read = async () => JSON.parse(await rcon.command(snapshot))
let final, result, before, goalId
const started = Date.now()
try {
  await fsp.mkdir(root, { recursive: true })
  // Durable single-attempt marker. A restarted operator cannot submit again.
  await fsp.writeFile(`${root}/trial-started.json`, JSON.stringify({ started, goal }), { flag: 'wx' })
  await rcon.connect()
  before = await read()
  assert.equal(before.humans, 0); assert.equal(before.speed, 1)
  assert.equal(before.actor.mode, 'npc'); assert.equal(before.actor.actor.kind, 'standalone_character')
  assert.equal(Object.keys(before.inventory).length, 0)
  assert.equal(before.red_unlocked, false); assert.equal(before.green_researched, false)
  assert(!before.board)
  assert.equal(await fsp.stat('/data/.sgluna/pursuit-state.json').then(() => true, () => false), false)
  const starter = JSON.parse(await rcon.command('/silent-command local id=remote.call("autorio_actor","status"); local a=game.get_entity_by_unit_number(id.actor.actor_id); assert(not storage.luna_pursuit_starter_given); local given={}; for n,c in pairs({["iron-plate"]=8,["burner-mining-drill"]=1,["stone-furnace"]=1,["pistol"]=1,["firearm-magazine"]=10}) do given[n]=a.insert{name=n,count=c}; assert(given[n]==c) end; storage.luna_pursuit_starter_given=true; storage.airi_task_board_ui_inputs={}; rcon.print(helpers.table_to_json(given))'))
  await fsp.writeFile(`${root}/trial-contract.json`, JSON.stringify({ started, candidate: verification.candidate,
    goal, starter, max_calls: 30, max_wall_ms: 1200000, before, corrective_prompts: 0, gameplay_takeover: 0 }, null, 2))
  console.log(JSON.stringify({ event: 'trial.started', started, goal, starter }))
  await rcon.command(`!luna ${goal.objective}`)
  while (Date.now() - started < 1200000) {
    await delay(5000)
    final = await read()
    const envelope = JSON.parse(await fsp.readFile('/data/.sgluna/pursuit-state.json').catch(() => '{}'))
    const state = envelope.current
    await fsp.appendFile(`${root}/trial-snapshots.jsonl`, JSON.stringify({ at: Date.now(), budget: envelope.budget, ...final }) + '\n')
    if (state) {
      goalId ??= state.request_id
      assert.equal(state.request_id, goalId); assert.equal(state.objective, goal.objective)
      assert(state.budget.calls <= 30)
    }
    if (final.actor_id !== before.actor_id || final.humans !== 0 || final.speed !== 1) { result = 'invariant_changed'; break }
    if (state?.status === 'completed') {
      assert(final.green_researched && final.green_enabled && final.red_produced.satisfied && final.red_consumed >= 75)
      result = 'native_red_to_green_success'; break
    }
    if (state?.status === 'paused') { result = `paused:${state.pauseReason}`; break }
    console.log(JSON.stringify({ event: 'trial.observed', elapsed_ms: Date.now() - started, calls: envelope.budget?.calls,
      red_produced: final.red_produced, red_consumed: final.red_consumed, green: final.green_researched }))
  }
  result ??= 'wall_time_limit'
  const envelope = JSON.parse(await fsp.readFile('/data/.sgluna/pursuit-state.json').catch(() => '{}'))
  await fsp.writeFile(`${root}/trial-result.json`, JSON.stringify({ result, goal_id: goalId, elapsed_ms: Date.now() - started,
    budget: envelope.budget, before, final, corrective_prompts: 0, gameplay_takeover: 0 }, null, 2))
  console.log(JSON.stringify({ event: 'trial.finished', result, budget: envelope.budget }))
  await rcon.command('/server-save luna-pursuit-20261010-checkpoint')
  for (let i = 0; i < 20; i++) {
    if (await fsp.stat('/data/saves/luna-pursuit-20261010-checkpoint.zip').then(s => s.size > 0, () => false)) break
    await delay(1000)
  }
} catch (error) {
  await fsp.writeFile(`${root}/trial-error.json`, JSON.stringify({ error: error.message, elapsed_ms: Date.now() - started, before, final }, null, 2))
  throw error
} finally { rcon.close() }
