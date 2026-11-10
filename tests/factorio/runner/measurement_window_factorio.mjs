#!/usr/bin/env node
// Supervisor-only accelerated hands-off measurement against the real engine with zero humans:
//
//   WINDOW     a fueled stone furnace runs unattended through a 3,600-tick window at speed 8; the engine restores 1x at
//              exactly the end tick (window_complete), the result counts the plates made in that window from the force
//              production statistics, and the host saw the game advance faster than real time
//   FENCED     while the window runs, the external bridge refuses an operator action (nonstandard_game_speed)
//   EARLY      a speed change during a second window ends it at 1x with reason unexpected_speed; the result is not valid
//   REUSE      a used measurement id is refused before any speed change
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { NativeBridge } from '../external-harness/tools/external-harness/native-bridge.mjs'
import { measureWindow } from '../external-harness/tools/external-harness/measure-window.mjs'

globalThis.fetch = async () => { throw new Error('live inference forbidden in the measurement-window lane') }

const arg = name => { const at = process.argv.indexOf(`--${name}`); assert.ok(at >= 0 && process.argv[at + 1], `missing --${name}`); return process.argv[at + 1] }
const results = path.resolve(arg('results'))
const evidence = {}
let connection
let actorId

const command = text => connection.command(text)
const lua = async body => JSON.parse(await command(`/silent-command local a=game.get_entity_by_unit_number(${actorId}); assert(a and a.valid); local s=a.surface; ${body}`))
const bridge = new NativeBridge({ rcon: { command }, session: 'measurement-window-lane-20261108-a1b2c3d4e5f6' })

async function window() {
  const running = measureWindow({ rcon: { command }, speed: 8, ticks: 3600, evidenceDir: path.join(results, 'window'), measurementId: 'lane-window-1', pollMs: 250 })
  await delay(500)
  let refused
  try { await bridge.prepare({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }, 'during-window') }
  catch (error) { refused = error }
  const result = await running
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 2000))
  assert.equal(result.reason, 'window_complete')
  assert.equal(result.valid_window, true)
  assert.equal(result.native.actual_ticks, 3600)
  assert.equal(result.native.restored_tick, result.native.end_tick)
  assert.ok(result.items['iron-plate']?.produced >= 15, `plates made in the window: ${JSON.stringify(result.items)}`)
  assert.ok(result.observed_speed > 1.5, `the game advanced faster than real time: ${result.observed_speed}`)
  assert.equal(result.actor_inventory_unchanged, true)
  const after = await lua('rcon.print(helpers.table_to_json({speed=game.speed}))')
  assert.equal(after.speed, 1)
  assert.ok(refused, 'the bridge refused an operator action during the window')
  assert.equal(refused.code, 'nonstandard_game_speed', `${refused?.code}: ${refused?.message}`)
  evidence.window = { result, refused: refused.code }
  console.log(`PASS: WINDOW - 3600 ticks at speed 8 (observed ${result.observed_speed}x), ${result.items['iron-plate'].produced} plates, restored 1x at the end tick`)
  console.log('PASS: FENCED - the bridge refused an operator action during the window')
}

async function early() {
  const running = measureWindow({ rcon: { command }, speed: 4, ticks: 36000, evidenceDir: path.join(results, 'early'), measurementId: 'lane-window-2', pollMs: 250 })
  await delay(500)
  await command('/silent-command game.speed=2')
  const result = await running
  assert.equal(result.ok, true)
  assert.equal(result.reason, 'unexpected_speed')
  assert.equal(result.valid_window, false)
  assert.ok(result.native.actual_ticks < 36000)
  assert.equal((await lua('rcon.print(helpers.table_to_json({speed=game.speed}))')).speed, 1)
  evidence.early = result
  console.log(`PASS: EARLY - a speed change ended the window after ${result.native.actual_ticks} ticks at 1x; not valid`)
}

async function reuse() {
  const result = await measureWindow({ rcon: { command }, speed: 8, ticks: 600, measurementId: 'lane-window-1' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'measurement_refused')
  assert.equal(result.reason, 'measurement_id_used')
  assert.equal((await lua('rcon.print(helpers.table_to_json({speed=game.speed}))')).speed, 1)
  evidence.reuse = result
  console.log('PASS: REUSE - a used measurement id was refused at 1x')
}

try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
  const ready = Date.now() + 30000
  for (;;) {
    try { await connection.connect(); break }
    catch (error) { connection.close(); if (Date.now() >= ready) throw error; await delay(200) }
  }
  const bound = await bridge.bind()
  actorId = bound.actor.actor_id
  // Fixture: one stone furnace with fuel and ore beside the actor; nothing else feeds it.
  const placed = await lua('local p={x=math.floor(a.position.x)+4,y=math.floor(a.position.y)}; local f=s.create_entity{name="stone-furnace",position=p,force=a.force}; f.insert{name="coal",count=20}; f.insert{name="iron-ore",count=50}; rcon.print(helpers.table_to_json({ok=f.valid}))')
  assert.equal(placed.ok, true)
  await window()
  await early()
  await reuse()
  evidence.status = 'pass'
}
catch (error) {
  evidence.status = 'fail'; evidence.error = String(error?.stack ?? error)
  await fs.writeFile(path.join(results, 'measurement-window-error.txt'), `${error?.stack ?? error}\n`)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, 'measurement-window.json'), JSON.stringify(evidence, null, 2))
  connection?.close()
}
