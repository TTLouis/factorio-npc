import type { LuaEntity, LuaSurface, MapPosition } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { find_world_entities } from './npc_vision'

// Freeplay creates its crashed-ship site, and gives the starting items, only on
// the first on_player_created. A standalone NPC with zero connected humans never
// raises that event, so the start a joining player would get never appears.
// This one-time setup action runs freeplay's own crash-site module with
// freeplay's own configured items, gives the NPC freeplay's created_items, and
// then disables freeplay's crash site so a later human join cannot spawn a
// second one. It is an operator setup action, never a model operation.

interface CrashSiteModule {
  create_crash_site: (this: void, surface: LuaSurface, position: MapPosition, ship_items: Record<string, number>, part_items: Record<string, number>, ship_parts?: unknown) => void
  default_ship_parts?: (this: void) => unknown
}

declare function require(this: void, module: string): unknown

// Lua require works only while control.lua loads, so the core module is read
// here at module load. Under the unit tests no Lua require exists.
let core_crash_site: CrashSiteModule | undefined
try {
  core_crash_site = require('crash-site') as CrashSiteModule
}
catch {
  core_crash_site = undefined
}

// Freeplay's own crash-site position (freeplay.lua passes {-5, -6}).
export const FREEPLAY_CRASH_SITE_POSITION = { x: -5, y: -6 }
const REPORT_RADIUS = 24
const MAX_REPORTED_ENTITIES = 32
const MAX_ITEM_KINDS = 32

interface CrashSiteSetupRecord {
  tick: number
  actor_id?: number
  surface_index: number
  position: { x: number, y: number }
  entities: { name: string, unit_number?: number, position: { x: number, y: number } }[]
  entity_count: number
  starter_items: { name: string, requested: number, inserted: number }[]
  freeplay_crash_site_disabled: boolean
}

declare const storage: {
  sgluna_crash_site_setup?: CrashSiteSetupRecord
}

function refuse(code: string) {
  return { ok: false, code }
}

function item_counts(value: unknown) {
  const items: { name: string, count: number }[] = []
  if (typeof value !== 'object' || value === null) return items
  for (const [name, count] of pairs(value as Record<string, unknown>)) {
    if (typeof name === 'string' && typeof count === 'number' && count > 0 && count === math.floor(count) && prototypes.item[name] !== undefined) {
      items.push({ name, count })
    }
  }
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return items
}

function starter_item_counts(created: unknown, ...recovered_from_wrecks: unknown[]) {
  const taken: Record<string, number> = {}
  for (const items of recovered_from_wrecks) {
    for (const item of item_counts(items)) taken[item.name] = (taken[item.name] ?? 0) + item.count
  }
  const kept: { name: string, count: number }[] = []
  for (const item of item_counts(created)) {
    const count = item.count - (taken[item.name] ?? 0)
    if (count > 0) kept.push({ name: item.name, count })
  }
  return kept
}

function freeplay_call(name: string) {
  const freeplay = remote.interfaces.freeplay
  if (freeplay === undefined || freeplay[name] !== true) return undefined
  return remote.call('freeplay', name)
}

// The ship and its wreck parts persist; freeplay's crash also starts fires that
// burn out, so they are not part of the record.
function crash_site_entities(surface: LuaSurface) {
  const found: LuaEntity[] = find_world_entities(surface, { position: FREEPLAY_CRASH_SITE_POSITION, radius: REPORT_RADIUS })
  const entities: CrashSiteSetupRecord['entities'] = []
  for (const entity of found) {
    if (entity.valid && entity.name.startsWith('crash-site-spaceship')) {
      entities.push({ name: entity.name, unit_number: entity.unit_number, position: { x: entity.position.x, y: entity.position.y } })
    }
  }
  entities.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.position.y - b.position.y || a.position.x - b.position.x)
  return entities
}

function report(record: CrashSiteSetupRecord, already_done: boolean) {
  return {
    ok: true,
    already_done,
    ...record,
    entities: record.entities.slice(0, MAX_REPORTED_ENTITIES),
    entities_truncated: record.entities.length > MAX_REPORTED_ENTITIES,
  }
}

export function crash_site_setup_status() {
  const record = storage.sgluna_crash_site_setup
  return record === undefined ? { ok: true, done: false } : { ...report(record, true), done: true }
}

export function spawn_freeplay_crash_site(actor: ControlledActor | undefined, crash_site: CrashSiteModule | undefined = core_crash_site) {
  const done = storage.sgluna_crash_site_setup
  if (done !== undefined) return report(done, true)
  if (!actor || !actor.is_valid || !actor.character || !actor.character.valid) return refuse('no_actor')
  if (remote.interfaces.freeplay === undefined) return refuse('freeplay_not_loaded')
  if (crash_site === undefined) return refuse('crash_site_module_unavailable')
  // Without these freeplay functions the guards below cannot be proven.
  for (const name of ['get_init_ran', 'get_disable_crashsite', 'set_disable_crashsite', 'get_created_items', 'get_ship_items', 'get_debris_items']) {
    if (remote.interfaces.freeplay[name] !== true) return refuse('freeplay_interface_incomplete')
  }
  // After a human's first join freeplay has already run its own start: a crash
  // site exists (or was disabled) and that human got the starting items.
  if (freeplay_call('get_init_ran') === true) return refuse('freeplay_start_already_ran')
  if (freeplay_call('get_disable_crashsite') === true) return refuse('freeplay_crash_site_disabled')
  const surface = actor.surface
  if (surface.index !== 1) return refuse('actor_not_on_freeplay_surface')

  const ship_parts = freeplay_call('get_ship_parts') ?? crash_site.default_ship_parts?.()
  crash_site.create_crash_site(surface, FREEPLAY_CRASH_SITE_POSITION,
    (freeplay_call('get_ship_items') ?? {}) as Record<string, number>, (freeplay_call('get_debris_items') ?? {}) as Record<string, number>, ship_parts)
  // The site now exists. Record it before anything else can fail, so a repeat
  // reports this run instead of creating a second site.
  const record: CrashSiteSetupRecord = {
    tick: game.tick,
    surface_index: surface.index,
    position: { ...FREEPLAY_CRASH_SITE_POSITION },
    entities: [],
    entity_count: 0,
    starter_items: [],
    freeplay_crash_site_disabled: false,
  }
  storage.sgluna_crash_site_setup = record
  remote.call('freeplay', 'set_disable_crashsite', true)
  record.actor_id = actor.status_snapshot().actor_id

  // Freeplay inserts created_items, then takes back the items it put into the
  // wrecks (they are recovered by mining the wreckage), so a joining player
  // keeps created_items minus the ship and debris items. Fresh copies are read
  // here, since the crash-site module may consume the tables it was given.
  for (const item of starter_item_counts(freeplay_call('get_created_items'), freeplay_call('get_ship_items'), freeplay_call('get_debris_items')).slice(0, MAX_ITEM_KINDS)) {
    const inserted = actor.character.insert({ name: item.name, count: item.count })
    record.starter_items.push({ name: item.name, requested: item.count, inserted })
  }

  record.entities = crash_site_entities(surface)
  record.entity_count = record.entities.length
  record.freeplay_crash_site_disabled = freeplay_call('get_disable_crashsite') === true
  return report(record, false)
}
