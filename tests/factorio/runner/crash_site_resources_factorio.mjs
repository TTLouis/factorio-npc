#!/usr/bin/env node
// External-trial-3 follow-ups against the real engine with zero humans:
//
//   CRASH SITE  the operator-only setup remote runs freeplay's own crashed-ship site for the standalone NPC: the
//               spaceship and wrecks exist on the player force holding freeplay's ship and debris items, the NPC holds
//               freeplay's created_items minus the items left in the wrecks (as a joining player would), freeplay's own
//               crash site is disabled afterwards and freeplay's start has still not run; a repeat creates nothing
//   RESOURCES   getResourceAmounts, through the production renderer, reports exact per-tile ore totals for a 5x5
//               fixture, agrees with a direct engine count over a wider visible area, refuses a non-resource name, and
//               reports an ungenerated far area as unseen without generating or charting it
//   RELOAD      after game.server_save() and a real process restart the setup record persists, a repeat still creates
//               nothing, and the wreck items are unchanged
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { toolCommand } from '../pterodactyl/runtime-v8/structured-policy.mjs'
import { configureNpcSession, deploymentStatus } from '../pterodactyl/staging/supervisor-adapter.mjs'

let forbiddenFetchCalls = 0
globalThis.fetch = async () => { forbiddenFetchCalls++; throw new Error('live inference forbidden in the crash-site lane') }

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0 && process.argv[at + 1], `missing --${name}`); return process.argv[at + 1] }
const phase = arg('phase')
const results = path.resolve(arg('results'))
const statePath = path.join(results, 'crash-site-state.json')
const transcript = []
const evidence = { phase }
let connection
let actorId

const rcon = () => ({ command: (text, options) => connection.command(text, options) })
const command = async text => {
  const response = await connection.command(text)
  transcript.push({ command: text.slice(0, 800), response: String(response).slice(0, 4000) })
  return response
}
const parse = (raw, label) => {
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} did not return JSON: ${String(raw).slice(0, 800)}`) }
}
const lua = async body => parse(await command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; ${body}`), body.slice(0, 200))
const tool = async (name, args) => parse(await command(toolCommand(name, args)), name)
// helpers.table_to_json writes an empty Lua table as {}.
const list = value => (Array.isArray(value) ? value : [])

const STARTER_NAMES = ['iron-plate', 'wood', 'pistol', 'firearm-magazine', 'burner-mining-drill', 'stone-furnace']
const npcItems = () => lua(`local out={}; for _,n in pairs(${luaList(STARTER_NAMES)}) do out[n]=a.get_item_count(n) end; rcon.print(helpers.table_to_json(out))`)
function luaList(names) { return `{${names.map(name => JSON.stringify(name)).join(',')}}` }

// The ship and every wreck part near freeplay's position, with the items each holds, read straight from the engine.
// Freeplay's crash fires burn out, so they are left out.
const wreckage = () => lua('local out={}; for _,e in pairs(s.find_entities_filtered{position={-5,-6},radius=48}) do '
  + 'if string.sub(e.name,1,20)=="crash-site-spaceship" then local items={}; local inv=e.get_inventory(defines.inventory.chest); '
  + 'if inv then for _,it in pairs(inv.get_contents()) do items[it.name]=(items[it.name] or 0)+it.count end end; '
  + 'out[#out+1]={name=e.name,force=e.force.name,unit_number=e.unit_number,x=e.position.x,y=e.position.y,items=items} end end; '
  + 'rcon.print(helpers.table_to_json({entities=out}))')
const freeplayFlags = () => lua('rcon.print(helpers.table_to_json({init_ran=remote.call("freeplay","get_init_ran")==true,'
  + 'disabled=remote.call("freeplay","get_disable_crashsite")==true,humans=#game.connected_players,players=#game.players}))')
const spawn = () => lua('rcon.print(helpers.table_to_json(remote.call("autorio_setup","spawn_crash_site")))')
const itemTotals = entities => {
  const totals = {}
  for (const entity of entities) for (const [name, count] of Object.entries(entity.items ?? {})) totals[name] = (totals[name] ?? 0) + count
  return totals
}

async function crashSite() {
  const flags = await freeplayFlags()
  assert.deepEqual(flags, { init_ran: false, disabled: false, humans: 0, players: 0 }, 'a fresh freeplay save with zero humans has never run freeplay\'s start')
  const configured = await lua('rcon.print(helpers.table_to_json({created=remote.call("freeplay","get_created_items"),ship=remote.call("freeplay","get_ship_items"),debris=remote.call("freeplay","get_debris_items")}))')
  const before = { items: await npcItems(), wrecks: list((await wreckage()).entities) }
  assert.equal(before.wrecks.length, 0, 'no crash site exists before the setup action')
  const status = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_setup","crash_site_status")))')
  assert.deepEqual(status, { ok: true, done: false })

  const report = await spawn()
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.already_done, false)
  assert.equal(report.actor_id, actorId)
  assert.equal(report.freeplay_crash_site_disabled, true)
  assert.deepEqual(report.position, { x: -5, y: -6 })
  const wrecks = list((await wreckage()).entities)
  assert.ok(wrecks.some(entity => entity.name === 'crash-site-spaceship'), `the spaceship exists: ${JSON.stringify(wrecks)}`)
  assert.ok(wrecks.length >= 2, 'the ship and its wreck parts exist')
  // As freeplay's module creates them: the ship on the player force (the NPC's), the wreck parts neutral.
  assert.ok(wrecks.filter(entity => entity.name === 'crash-site-spaceship').every(entity => entity.force === 'player'), JSON.stringify(wrecks))
  assert.ok(wrecks.filter(entity => entity.name !== 'crash-site-spaceship').every(entity => entity.force === 'neutral'), JSON.stringify(wrecks))
  if (report.entities_truncated !== true) assert.equal(report.entity_count, list(report.entities).length)
  const reportedUnits = list(report.entities).map(entity => entity.unit_number).sort((x, y) => x - y)
  const engineUnits = wrecks.filter(entity => Math.hypot(entity.x + 5, entity.y + 6) <= 24).map(entity => entity.unit_number).sort((x, y) => x - y)
  assert.deepEqual(reportedUnits, engineUnits, 'the report names exactly the crash-site entities the engine holds near the site')

  // Freeplay's own ship and debris items are in the wreckage, not invented by the harness.
  const held = itemTotals(wrecks)
  const expectedWreckItems = {}
  for (const items of [configured.ship, configured.debris]) for (const [name, count] of Object.entries(items ?? {})) expectedWreckItems[name] = (expectedWreckItems[name] ?? 0) + count
  assert.deepEqual(held, expectedWreckItems, 'the wrecks hold exactly freeplay\'s ship and debris items')

  // The NPC gets what a joining player keeps: created_items minus the items left in the wrecks.
  const after = await npcItems()
  const delta = Object.fromEntries(STARTER_NAMES.map(name => [name, after[name] - before.items[name]]).filter(([, count]) => count !== 0))
  const kept = {}
  for (const [name, count] of Object.entries(configured.created ?? {})) {
    const left = count - (expectedWreckItems[name] ?? 0)
    if (left > 0) kept[name] = left
  }
  assert.deepEqual(delta, kept, 'the NPC inventory gained freeplay\'s created_items minus the wreck items')
  assert.deepEqual(Object.fromEntries(list(report.starter_items).map(item => [item.name, item.inserted])), kept, 'the report names what was inserted')
  assert.ok(list(report.starter_items).every(item => item.requested === item.inserted), 'every starter item fit')

  const flagsAfter = await freeplayFlags()
  assert.deepEqual(flagsAfter, { init_ran: false, disabled: true, humans: 0, players: 0 }, 'freeplay\'s crash site is disabled; its start has not run')

  const repeat = await spawn()
  assert.equal(repeat.ok, true)
  assert.equal(repeat.already_done, true)
  assert.equal(repeat.tick, report.tick, 'a repeat reports the first result')
  assert.deepEqual(list((await wreckage()).entities), wrecks, 'a repeat creates nothing')
  assert.deepEqual(await npcItems(), after, 'a repeat gives nothing')

  evidence.crash_site = { configured, before, report, wrecks, delta, flags_after: flagsAfter, repeat_tick: repeat.tick }
  console.log(`PASS: CRASH SITE - freeplay's own ${wrecks.length} crash-site entities hold its ship/debris items; the NPC kept ${JSON.stringify(kept)}; freeplay's site disabled; repeat idempotent`)
  return { report, wrecks, items: after }
}

async function resources() {
  const at = await lua('rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))')
  // A 5x5 fixture well clear of the crash site, inside the NPC's own visible window.
  const center = { x: Math.floor(at.x) + 24, y: Math.floor(at.y) + 24 }
  const fixture = await lua(`local cx,cy=${center.x},${center.y}; `
    + 'for _,e in pairs(s.find_entities_filtered{area={{cx-2,cy-2},{cx+3,cy+3}},type="resource"}) do e.destroy() end; '
    + 'local n=0; for dx=-2,2 do for dy=-2,2 do assert(s.create_entity{name="iron-ore",position={cx+dx+0.5,cy+dy+0.5},amount=100+n}); n=n+1 end end; '
    + 'rcon.print(helpers.table_to_json({count=n}))')
  assert.equal(fixture.count, 25)

  const exact = await tool('getResourceAmounts', { resource_name: 'iron-ore', center, radius: 2 })
  assert.equal(exact.ok, true, JSON.stringify(exact))
  assert.equal(exact.coverage_complete, true)
  assert.equal(exact.unseen_chunk_count, 0)
  assert.deepEqual(exact.center_tile, center)
  assert.equal(list(exact.resources).length, 1)
  assert.deepEqual(list(exact.resources)[0], {
    name: 'iron-ore', tile_count: 25, total_amount: 25 * 100 + (24 * 25) / 2, min_amount: 100, max_amount: 124, infinite: false,
    bounding_box: { left_top: { x: center.x - 1.5, y: center.y - 1.5 }, right_bottom: { x: center.x + 2.5, y: center.y + 2.5 } },
  })
  assert.equal(list(exact.tiles).length, 25, 'each tile is counted once')
  assert.equal(new Set(list(exact.tiles).map(tile => `${tile.position.x},${tile.position.y}`)).size, 25)

  // A wider unnamed read agrees with a direct engine count over the same area, every resource kind included.
  const wide = await tool('getResourceAmounts', { center: { x: at.x, y: at.y }, radius: 40 })
  assert.equal(wide.ok, true, JSON.stringify(wide))
  assert.equal(wide.coverage_complete, true, 'the NPC window covers the area around it')
  const area = wide.area
  const engine = await lua(`local t={}; for _,e in pairs(s.find_entities_filtered{area={{${area.left_top.x},${area.left_top.y}},{${area.right_bottom.x},${area.right_bottom.y}}},type="resource"}) do `
    + `local p=e.position; if p.x>=${area.left_top.x} and p.x<${area.right_bottom.x} and p.y>=${area.left_top.y} and p.y<${area.right_bottom.y} then `
    + 'local r=t[e.name] or {name=e.name,tile_count=0,total_amount=0}; r.tile_count=r.tile_count+1; r.total_amount=r.total_amount+e.amount; t[e.name]=r end end; '
    + 'local out={}; for _,r in pairs(t) do out[#out+1]=r end; rcon.print(helpers.table_to_json({resources=out}))')
  const byName = rows => Object.fromEntries(list(rows).map(row => [row.name, { tile_count: row.tile_count, total_amount: row.total_amount }]))
  if (list(engine.resources).length <= 8) {
    assert.equal(wide.resources_truncated, false)
    assert.deepEqual(byName(wide.resources), byName(engine.resources), 'the read equals a direct engine count over its area')
  }
  assert.ok(byName(wide.resources)['iron-ore']?.tile_count >= 25, 'the fixture is inside the wide read')

  const refused = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_resource_amounts",{resource_name="iron-plate"})))')
  assert.deepEqual({ ok: refused.ok, code: refused.code }, { ok: false, code: 'unknown_resource' })
  assert.throws(() => toolCommand('getResourceAmounts', { radius: 49 }), 'the renderer bounds the radius before any game call')

  // Far outside anything the NPC has seen: unknown, and reading it generates and charts nothing.
  const far = { x: 4016, y: 4016 } // only chunk (125, 125)
  const worldBefore = await lua('rcon.print(helpers.table_to_json({generated=s.is_chunk_generated({125,125}),charted=a.force.is_chunk_charted(s,{125,125})}))')
  const unseen = await tool('getResourceAmounts', { resource_name: 'iron-ore', center: far, radius: 4 })
  assert.equal(unseen.ok, true, JSON.stringify(unseen))
  assert.equal(unseen.coverage_complete, false)
  assert.equal(unseen.visible_chunks, 0)
  assert.equal(unseen.unseen_chunk_count, 1)
  assert.equal(list(unseen.resources).length, 0, 'an unseen area reports no amounts, not zero ore')
  const worldAfter = await lua('rcon.print(helpers.table_to_json({generated=s.is_chunk_generated({125,125}),charted=a.force.is_chunk_charted(s,{125,125})}))')
  assert.deepEqual(worldAfter, worldBefore, 'the read neither generates nor charts')

  evidence.resources = { center, exact, wide_summary: { area, resources: wide.resources, engine: engine.resources }, unseen, world: worldBefore }
  console.log(`PASS: RESOURCES - 5x5 fixture totals exact (${list(exact.resources)[0].total_amount}); wide read equals the engine count; unseen far area unknown and untouched`)
}

async function prepare() {
  await configureNpcSession(rcon(), 'crash-site-resources-20261104')
  actorId = (await deploymentStatus(rcon(), { requireAllowed: true })).actor_id
  assert.ok(Number.isInteger(actorId), 'the deployment names its standalone actor')
  const site = await crashSite()
  await resources()
  await fs.writeFile(statePath, JSON.stringify({ actorId, report: site.report, wrecks: site.wrecks, items: site.items }, null, 2))
  const save = arg('save'); const old = await fs.stat(save)
  await command('/silent-command game.server_save()')
  const deadline = Date.now() + 30000
  while ((await fs.stat(save)).mtimeMs <= old.mtimeMs) { assert.ok(Date.now() < deadline, 'the server save was written'); await delay(100) }
}

async function verify() {
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
  await configureNpcSession(rcon(), 'crash-site-resources-20261104-verify')
  actorId = (await deploymentStatus(rcon(), { requireAllowed: true })).actor_id
  assert.equal(actorId, state.actorId, 'the same standalone NPC after restart')
  const status = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_setup","crash_site_status")))')
  assert.equal(status.done, true)
  assert.equal(status.tick, state.report.tick)
  const repeat = await spawn()
  assert.equal(repeat.already_done, true)
  assert.equal(repeat.tick, state.report.tick)
  const wrecks = list((await wreckage()).entities)
  assert.deepEqual(wrecks, state.wrecks, 'the wrecks and their items persist unchanged; a repeat after restart creates nothing')
  assert.deepEqual(await npcItems(), state.items, 'a repeat after restart gives nothing')
  assert.deepEqual(await freeplayFlags(), { init_ran: false, disabled: true, humans: 0, players: 0 })
  evidence.reload = { status, repeat_tick: repeat.tick, wreck_count: wrecks.length }
  console.log('PASS: RELOAD - setup record, wrecks and freeplay flags persist through a real restart; a repeat is still idempotent')
}

try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  const ready = Date.now() + 30000
  for (;;) {
    try { await connection.connect(); break }
    catch (error) { connection.close(); if (Date.now() >= ready) throw error; await delay(200) }
  }
  assert.match(await command('/version'), /2\.0\.77/)
  if (phase === 'prepare') await prepare()
  else await verify()
  assert.equal(forbiddenFetchCalls, 0)
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, `crash-site-${phase}-error.txt`), `${error?.stack ?? error}\n`)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, `crash-site-${phase}.json`), JSON.stringify({ evidence, transcript }, null, 2))
  connection?.close()
}
