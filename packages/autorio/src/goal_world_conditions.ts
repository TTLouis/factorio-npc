// Goal conditions that prove a factory is running, read from the engine
// (plan 3.7). `items_produced` counts items however they were made, so "get
// steam power going and run an electric mining drill" could be scored by
// crafting a steam engine and a drill that never ran (live run 2026-09-29).
// These kinds answer the question the player asked instead:
//
//   entity_working {entity_name, minimum}
//       at least `minimum` entities of that prototype on the force report
//       status `working` right now.
//   electric_network_satisfied {entity_name, minimum}
//       at least `minimum` entities of that prototype are on an electric
//       network, are not short of power (no_power, low_power, not plugged in),
//       and their network delivered energy from a real producer (steam engine,
//       solar panel, ...; never an electric-energy-interface or an accumulator
//       alone) within the last minute, read from the network's own statistics.
//   production_rate {item_name, per_minute, window_minutes}
//       the force produced the item at `per_minute` or more over the last
//       1 or 10 minutes, read from the engine's production flow statistics,
//       and the window holds no hand work that the statistics would count as
//       production (see hand_work.ts): the rate is automated output only.
//
// The first two are instantaneous; the harness samples them a few times over
// a few seconds so a single flicker does not decide a goal.

import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import { hand_work_since } from './hand_work'

export const WORLD_CONDITION_KINDS: Record<string, boolean> = {
  entity_working: true,
  electric_network_satisfied: true,
  production_rate: true,
}

// Bounds: a goal check never scans more than this many entities, and a
// minimum above it can never be proven.
const MAX_SCANNED_ENTITIES = 2000
const MAX_MINIMUM = 1000
const MAX_PER_MINUTE = 1_000_000
const RATE_WINDOW_MINUTES: Record<number, boolean> = { 1: true, 10: true }
// The engine's flow buckets do not end exactly on the current tick; hand work
// is looked for over a span this much wider than the window so none that the
// flow may still include is missed. Widening only ever voids more windows.
const HAND_WORK_MARGIN = 0.1

const POWER_SHORTAGE: Record<string, boolean> = {
  no_power: true,
  low_power: true,
  not_plugged_in_electric_network: true,
}
// Entity types that turn something else into electricity. An
// electric-energy-interface is a script/editor source and an accumulator only
// returns energy a producer stored earlier, so neither proves power is running.
const REAL_PRODUCER_TYPES: Record<string, boolean> = {
  'generator': true,
  'burner-generator': true,
  'solar-panel': true,
  'fusion-generator': true,
  'lightning-attractor': true,
}

function positive_integer(value: unknown) {
  return typeof value === 'number' && value === math.floor(value) && value > 0
}

function status_name(status: defines.entity_status | undefined) {
  if (status === undefined) return undefined
  for (const [name, value] of pairs(defines.entity_status)) {
    if (value === status) return name as string
  }
  return undefined
}

function minimum_of(request: Record<string, unknown>) {
  const minimum = request.minimum ?? 1
  return positive_integer(minimum) && (minimum as number) <= MAX_MINIMUM ? minimum as number : undefined
}

// Every entity of the prototype on the force, across surfaces, up to the scan bound.
function force_entities(force: LuaForce, entity_name: string) {
  const found: LuaEntity[] = []
  let truncated = false
  for (const [, surface] of game.surfaces) {
    for (const entity of surface.find_entities_filtered({ name: entity_name, force })) {
      if (found.length >= MAX_SCANNED_ENTITIES) {
        truncated = true
        break
      }
      found.push(entity)
    }
    if (truncated) break
  }
  return { found, truncated }
}

function count_statuses(statuses: Record<string, number>, name: string | undefined) {
  const key = name ?? 'unknown'
  statuses[key] = (statuses[key] ?? 0) + 1
}

function entity_prototype_request(kind: string, request: Record<string, unknown>) {
  const entity_name = request.entity_name
  const minimum = minimum_of(request)
  if (typeof entity_name !== 'string' || minimum === undefined) return { error: { ok: false, error: `invalid_${kind}_condition` } }
  if (!prototypes.entity[entity_name]) return { error: { ok: false, error: 'unknown_entity', entity_name } }
  return { entity_name, minimum }
}

function evaluate_entity_working(force: LuaForce, request: Record<string, unknown>) {
  const parsed = entity_prototype_request('entity_working', request)
  if (parsed.error) return parsed.error
  const { entity_name, minimum } = parsed as { entity_name: string, minimum: number }
  const { found, truncated } = force_entities(force, entity_name)
  const statuses: Record<string, number> = {}
  let working = 0
  for (const entity of found) {
    const name = status_name(entity.status)
    count_statuses(statuses, name)
    if (entity.status === defines.entity_status.working) working += 1
  }
  return {
    ok: true,
    kind: 'entity_working',
    satisfied: working >= minimum,
    current: working,
    minimum,
    entity_name,
    found: found.length,
    truncated,
    statuses,
    tick: game.tick,
    progress_known: false,
  }
}

// The producers that delivered energy into one electric network during the
// last minute, read from the statistics of a pole on that network. Undefined
// when no pole of the network is found (a consumer is only ever connected
// through poles, so that network has no reachable producer either).
function network_producers(pole: LuaEntity) {
  const statistics = pole.electric_network_statistics
  const producers: string[] = []
  for (const [name] of pairs(statistics.output_counts)) {
    const prototype = prototypes.entity[name as string]
    if (!prototype || !REAL_PRODUCER_TYPES[prototype.type]) continue
    const flow = statistics.get_flow_count({ name: name as string, category: 'output', precision_index: defines.flow_precision_index.one_minute })
    if (flow > 0) producers.push(name as string)
  }
  return producers
}

function poles_by_network(surface: LuaSurface, force: LuaForce) {
  const poles: Record<number, LuaEntity> = {}
  let scanned = 0
  for (const pole of surface.find_entities_filtered({ type: 'electric-pole', force })) {
    scanned += 1
    if (scanned > MAX_SCANNED_ENTITIES) break
    const id = pole.electric_network_id
    if (id !== undefined && poles[id] === undefined) poles[id] = pole
  }
  return poles
}

function evaluate_electric_network_satisfied(force: LuaForce, request: Record<string, unknown>) {
  const parsed = entity_prototype_request('electric_network_satisfied', request)
  if (parsed.error) return parsed.error
  const { entity_name, minimum } = parsed as { entity_name: string, minimum: number }
  const { found, truncated } = force_entities(force, entity_name)
  const statuses: Record<string, number> = {}
  const pole_maps: Record<number, Record<number, LuaEntity>> = {}
  const producers_by_network: Record<string, string[]> = {}
  const producer_names: Record<string, boolean> = {}
  let powered = 0
  let without_producer = 0
  for (const entity of found) {
    const name = status_name(entity.status)
    count_statuses(statuses, name)
    const network = entity.electric_network_id
    if (network === undefined || name === undefined || POWER_SHORTAGE[name]) continue
    const surface = entity.surface
    const key = `${surface.index}:${network}`
    let producers = producers_by_network[key]
    if (producers === undefined) {
      const poles = pole_maps[surface.index] ?? poles_by_network(surface, force)
      pole_maps[surface.index] = poles
      const pole = poles[network]
      producers = pole !== undefined ? network_producers(pole) : []
      producers_by_network[key] = producers
    }
    if (producers.length === 0) {
      without_producer += 1
      continue
    }
    for (const producer of producers) producer_names[producer] = true
    powered += 1
  }
  return {
    ok: true,
    kind: 'electric_network_satisfied',
    satisfied: powered >= minimum,
    current: powered,
    minimum,
    entity_name,
    found: found.length,
    truncated,
    statuses,
    without_producer,
    producers: Object.keys(producer_names),
    tick: game.tick,
    progress_known: false,
  }
}

function evaluate_production_rate(force: LuaForce, request: Record<string, unknown>, actor_mining: boolean) {
  const item_name = request.item_name
  const per_minute = request.per_minute
  const window_minutes = request.window_minutes ?? 1
  if (typeof item_name !== 'string' || typeof per_minute !== 'number' || !(per_minute > 0) || per_minute > MAX_PER_MINUTE
    || typeof window_minutes !== 'number' || !RATE_WINDOW_MINUTES[window_minutes]) {
    return { ok: false, error: 'invalid_production_rate_condition' }
  }
  if (!prototypes.item[item_name]) return { ok: false, error: 'unknown_item', item_name }
  const precision_index = window_minutes === 10 ? defines.flow_precision_index.ten_minutes : defines.flow_precision_index.one_minute
  // Items produced during the window on every surface, as the engine's own
  // production graph counts them. Hand-crafted products never reach these
  // statistics (crafted_items.ts), so the NPC's crafting adds nothing here.
  let produced = 0
  for (const [, surface] of game.surfaces) {
    produced += force.get_item_production_statistics(surface).get_flow_count({ name: item_name, category: 'input', precision_index, count: true })
  }
  const window_ticks = window_minutes * 3600
  const since_tick = game.tick - math.ceil(window_ticks * (1 + HAND_WORK_MARGIN))
  const hand_work = hand_work_since(force.index, item_name, since_tick, actor_mining)
  const rate = math.floor(produced / window_minutes * 100 + 0.5) / 100
  return {
    ok: true,
    kind: 'production_rate',
    satisfied: hand_work === undefined && rate >= per_minute,
    current: rate,
    per_minute,
    window_minutes,
    produced,
    void_reason: hand_work?.reason,
    void_tick: hand_work?.tick,
    void_item: hand_work?.item_name,
    void_entity: hand_work?.entity_name,
    tick: game.tick,
    progress_known: false,
  }
}

/** Undefined for any other kind. `actor_mining`: the NPC's body is mining now. */
export function evaluate_world_condition(force: LuaForce, kind: unknown, request: Record<string, unknown>, actor_mining: boolean) {
  if (kind === 'entity_working') return evaluate_entity_working(force, request)
  if (kind === 'electric_network_satisfied') return evaluate_electric_network_satisfied(force, request)
  if (kind === 'production_rate') return evaluate_production_rate(force, request, actor_mining)
  return undefined
}
