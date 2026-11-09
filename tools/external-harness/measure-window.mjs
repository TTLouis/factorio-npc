import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { Rcon } from '../../deploy/pterodactyl/runtime-v8/common.mjs'

// Supervisor-only hands-off measurement. Not an MCP tool; the operator never
// calls it. It reads fixed production/research facts at 1x, arms the native
// measurement window (which restores 1x itself at the end tick or on a safety
// event), waits with a host wall watchdog, confirms 1x and reads again.
// Every RCON command here is fixed text plus validated names and numbers.

export const DEFAULT_ITEMS = Object.freeze(['iron-ore', 'copper-ore', 'coal', 'stone', 'iron-plate', 'copper-plate', 'steel-plate',
  'stone-brick', 'iron-gear-wheel', 'copper-cable', 'electronic-circuit', 'inserter', 'transport-belt',
  'automation-science-pack', 'logistic-science-pack'])
export const DEFAULT_FLUIDS = Object.freeze(['water', 'steam'])
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const PREFIX = '/silent-command rcon.print(helpers.table_to_json('

const luaList = names => `{${names.map(name => `"${name}"`).join(',')}}`
export function snapshotCommand(items, fluids) {
  if (![...items, ...fluids].every(name => NAME.test(name))) throw new Error('invalid_watch_name')
  return `${PREFIX}(function() local g=remote.call("sgluna_deployment","status"); local s=remote.call("autorio_operations","status"); `
    + `local m=remote.call("sgluna_measurement_sprint","status"); local f=game.forces[g.force_index]; local surface=game.surfaces[g.surface_index]; `
    + `local out={tick=game.tick,speed=game.speed,humans=#game.connected_players,guard=g,work={task_state=s.task_state,queue_length=s.queue_length,active=s.active_batch~=nil},measurement=m}; `
    + `if not f or not surface then out.facts_unavailable=true; return out end; `
    + `local ip=f.get_item_production_statistics(surface); local fp=f.get_fluid_production_statistics(surface); local items,fluids={},{}; `
    + `for _,n in pairs(${luaList(items)}) do if prototypes.item[n] then items[n]={produced=ip.get_input_count(n),consumed=ip.get_output_count(n)} end end; `
    + `for _,n in pairs(${luaList(fluids)}) do if prototypes.fluid[n] then fluids[n]={produced=fp.get_input_count(n),consumed=fp.get_output_count(n)} end end; `
    + `local researched={}; for name,t in pairs(f.technologies) do if t.researched then researched[#researched+1]=name end end; table.sort(researched); `
    + `local queue={}; for i,t in pairs(f.research_queue or {}) do queue[#queue+1]=t.name end; `
    + `out.items=items; out.fluids=fluids; out.researched=researched; out.research={current=f.current_research and f.current_research.name or nil,progress=f.research_progress,queue=queue}; `
    + `local c=g.actor_id and game.get_entity_by_unit_number(g.actor_id); if c and c.valid then local inv=c.get_main_inventory(); out.actor_inventory=inv and inv.get_contents() or {} end; `
    + `return out end)()))`
}
const armCommand = lease => `${PREFIX}remote.call("sgluna_measurement_sprint","arm",helpers.json_to_table('${JSON.stringify(lease)}'))))`
const STATUS = `${PREFIX}remote.call("sgluna_measurement_sprint","status")))`
const finishCommand = id => `${PREFIX}remote.call("sgluna_measurement_sprint","finish","host_wall_cap","${id}")))`

function delta(before = {}, after = {}, minutes) {
  const rows = {}
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const produced = (after[name]?.produced ?? 0) - (before[name]?.produced ?? 0)
    const consumed = (after[name]?.consumed ?? 0) - (before[name]?.consumed ?? 0)
    if (produced === 0 && consumed === 0) continue
    rows[name] = { produced, consumed, produced_per_minute: Math.round(produced / minutes * 100) / 100, consumed_per_minute: Math.round(consumed / minutes * 100) / 100 }
  }
  return rows
}
const inventory = contents => Object.fromEntries((Array.isArray(contents) ? contents : []).map(row => [`${row.name}:${row.quality ?? 'normal'}`, row.count]).sort())

export async function measureWindow({ rcon, speed = 8, ticks = 72000, items = DEFAULT_ITEMS, fluids = DEFAULT_FLUIDS, evidenceDir,
  pollMs = 2000, wallSlackMs = 120000, now = () => Date.now(), sleep = delay, measurementId = `window-${randomUUID()}` }) {
  // helpers.table_to_json writes an empty Lua table as {}; these fields are lists.
  const read = async () => {
    const value = JSON.parse(await rcon.command(snapshotCommand(items, fluids)))
    for (const key of ['researched', 'actor_inventory']) if (value[key] !== undefined && !Array.isArray(value[key])) value[key] = []
    if (value.research && !Array.isArray(value.research.queue)) value.research.queue = []
    return value
  }
  const persist = async (name, value) => { if (evidenceDir) await fs.writeFile(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }) }
  if (evidenceDir) await fs.mkdir(evidenceDir, { recursive: true })
  const before = await read()
  await persist('before.json', before)
  const ready = before.speed === 1 && before.humans === 0 && !before.measurement?.lease && !before.facts_unavailable
    && before.work.task_state === 'idle' && before.work.queue_length === 0 && !before.work.active
    && Number.isSafeInteger(before.guard?.actor_id) && Number.isSafeInteger(before.guard?.epoch)
  if (!ready) return { ok: false, code: 'measurement_not_ready', before }
  const lease = { measurement_id: measurementId, actor_id: before.guard.actor_id, epoch: before.guard.epoch, speed, ticks }
  const wallStarted = now()
  const armed = JSON.parse(await rcon.command(armCommand(lease)))
  await persist('armed.json', armed)
  if (armed.ok !== true) return { ok: false, code: 'measurement_refused', reason: armed.reason, before }
  // The native guard owns the tick bound; the host owns the wall bound. A window
  // the server cannot accelerate still ends by wall time, as an invalid window.
  const wallDeadline = wallStarted + Math.ceil(ticks / 60) * 1000 + wallSlackMs
  let status = armed, watchdog = false, readFailures = 0
  while (status.lease?.measurement_id === measurementId) {
    await sleep(pollMs)
    if (now() > wallDeadline && !watchdog) { watchdog = true; status = JSON.parse(await rcon.command(finishCommand(measurementId))); continue }
    try { status = JSON.parse(await rcon.command(STATUS)); readFailures = 0 }
    catch (error) { if (++readFailures > 15) throw error }
  }
  const wallMs = now() - wallStarted
  const after = await read()
  await persist('after.json', after)
  const last = after.measurement?.last
  const restored = after.speed === 1 && !after.measurement?.lease && last?.measurement_id === measurementId
  const actual = restored ? last.actual_ticks : null
  // The statistics are read before arming and after restoration, so their deltas cover before.tick..after.tick, which
  // includes a few 1x ticks either side of the lease (Sol review). Rates use that interval; both are reported.
  const statsTicks = restored && Number.isSafeInteger(after.tick) && Number.isSafeInteger(before.tick) ? after.tick - before.tick : null
  const minutes = statsTicks > 0 ? statsTicks / 3600 : null
  const researchedBefore = new Set(before.researched ?? [])
  const result = {
    ok: restored, measurement_id: measurementId, requested: { speed, ticks }, restored_to_1x: restored,
    reason: last?.reason ?? null, valid_window: restored && last.reason === 'window_complete' && actual >= ticks && !watchdog,
    native: restored ? { start_tick: last.start_tick, end_tick: last.end_tick, restored_tick: last.restored_tick, actual_ticks: actual, native_checks: last.native_checks } : null,
    game_time_s: actual ? Math.round(actual / 60 * 1000) / 1000 : null, wall_ms: wallMs,
    rate_interval: statsTicks ? { from_tick: before.tick, to_tick: after.tick, ticks: statsTicks, outside_lease_ticks: actual ? statsTicks - actual : null } : null,
    observed_speed: actual ? Math.round(actual / 60 / (wallMs / 1000) * 100) / 100 : null, host_watchdog_fired: watchdog,
    items: minutes ? delta(before.items, after.items, minutes) : null, fluids: minutes ? delta(before.fluids, after.fluids, minutes) : null,
    research: { completed_during_window: (after.researched ?? []).filter(name => !researchedBefore.has(name)), before: before.research, after: after.research },
    actor_inventory_unchanged: JSON.stringify(inventory(before.actor_inventory)) === JSON.stringify(inventory(after.actor_inventory)),
    humans_after: after.humans, work_after: after.work,
  }
  await persist('result.json', result)
  return result
}

const HELP = `Supervisor-only accelerated hands-off measurement (not an operator tool).

Usage: node tools/external-harness/measure-window.mjs --evidence <new dir> [--speed 8] [--ticks 72000]

Uses SGLUNA_RCON_PASSWORD / SGLUNA_RCON_HOST (loopback) / SGLUNA_RCON_PORT.
Run only while the operator makes no calls and the NPC is idle. The game
restores 1x itself at the end tick or on a safety event; the result is
valid only when reason is window_complete.
`

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes('--help')) { process.stdout.write(HELP); return }
  const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
  const evidenceDir = option('--evidence')
  const speed = Number(option('--speed', 8)), ticks = Number(option('--ticks', 72000))
  if (!evidenceDir) throw new Error('evidence_directory_required')
  const host = env.SGLUNA_RCON_HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('loopback_required')
  if (!env.SGLUNA_RCON_PASSWORD) throw new Error('rcon_password_required')
  const rcon = new Rcon(Number(env.SGLUNA_RCON_PORT ?? 27015), env.SGLUNA_RCON_PASSWORD, 5000, { host })
  await rcon.connect()
  try {
    const result = await measureWindow({ rcon, speed, ticks, evidenceDir: path.resolve(evidenceDir) })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok || result.valid_window === false) process.exitCode = 2
  } finally { rcon.close() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`measure-window failed: ${error.message}\n`); process.exitCode = 1 })
}
