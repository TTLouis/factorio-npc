import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { find_world_entities } from './npc_vision'

// Electric-network facts read straight from live prototypes and live entity
// positions. Nothing here knows an entity name: a pole is whatever prototype has
// type `electric-pole` and reports its own supply area and wire reach, a powered
// entity is whatever prototype carries an electric energy source.
//
// Prototype keys are read through protected reads: Factorio raises on a key that
// is not defined for a prototype type, and 2.0 moved several of these from
// attributes to quality-aware methods, so each fact tries the attribute and then
// the method (a bound function, called without self).

const MAX_POLE_LINKS = 4
const MAX_COVERED_ENTITIES = 6
// How far an unpowered entity looks for the nearest pole (tiles).
export const MAX_POLE_SEARCH_RADIUS = 64
const TICKS_PER_SECOND = 60
const REACH_EPSILON = 0.000001

function finite(value: number) {
  return value === value && value !== math.huge && value !== -math.huge
}

function round_tenth(value: number) {
  return math.floor(value * 10 + 0.5) / 10
}

/** First finite number among the named attributes, then the named methods; undefined when the prototype defines none. */
export function prototype_number(prototype: any, fields: string[], methods: string[]): number | undefined {
  if (!prototype) return undefined
  for (const field of fields) {
    try {
      const value = prototype[field]
      if (typeof value === 'number' && finite(value)) return value
    }
    catch { /* key not defined for this prototype type */ }
  }
  for (const method of methods) {
    try {
      const read = prototype[method] as ((this: void) => unknown) | undefined
      if (typeof read === 'function') {
        const value = read()
        if (typeof value === 'number' && finite(value)) return value
      }
    }
    catch { /* method not defined for this prototype type */ }
  }
  return undefined
}

export interface PoleReach {
  supply_area_distance: number
  max_wire_distance: number
}

/** Supply area half-width and wire reach of an electric-pole prototype, undefined for any other prototype. */
export function pole_reach(prototype: any): PoleReach | undefined {
  if (!prototype || prototype.type !== 'electric-pole') return undefined
  const supply = prototype_number(prototype, ['supply_area_distance'], ['get_supply_area_distance'])
  const wire = prototype_number(prototype, ['max_wire_distance'], ['get_max_wire_distance'])
  if (supply === undefined || wire === undefined) return undefined
  return { supply_area_distance: supply, max_wire_distance: wire }
}

function sorted_true_keys(value: any): string[] {
  const keys: string[] = []
  if (!value) return keys
  for (const [key, flag] of pairs(value as Record<string, unknown>)) {
    if (flag === true) keys.push(key)
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[j] < keys[i]) {
        const tmp = keys[i]
        keys[i] = keys[j]
        keys[j] = tmp
      }
    }
  }
  return keys
}

/**
 * Electric and fluid-throughput facts of one entity prototype, for entity_details.
 * Powers are watts (the engine reports joules per tick), fluid rates per second.
 * Only facts the prototype actually defines appear.
 */
export function electric_prototype_facts(prototype: any): Record<string, unknown> {
  const facts: Record<string, unknown> = {}
  if (!prototype) return facts

  const reach = pole_reach(prototype)
  if (reach !== undefined) {
    facts.electric_pole = {
      supply_area_distance: reach.supply_area_distance,
      supply_area_tiles: reach.supply_area_distance * 2,
      max_wire_distance: reach.max_wire_distance,
    }
  }

  const usage = prototype_number(prototype, ['max_energy_usage'], ['get_max_energy_usage'])
  const production = prototype_number(prototype, ['max_energy_production'], ['get_max_energy_production'])
  const steam = prototype_number(prototype, ['fluid_usage_per_tick'], ['get_fluid_usage_per_tick'])
  const power: Record<string, unknown> = {}
  let has_power = false
  if (usage !== undefined && usage > 0) {
    power.consumption_watts = usage * TICKS_PER_SECOND
    has_power = true
  }
  if (production !== undefined && production > 0) {
    power.production_watts = production * TICKS_PER_SECOND
    has_power = true
  }
  if (steam !== undefined && steam > 0) {
    power.fluid_usage_per_second = steam * TICKS_PER_SECOND
    has_power = true
  }
  if (has_power) facts.power = power

  const burner = prototype.burner_prototype
  if (burner) {
    facts.burner = {
      fuel_categories: sorted_true_keys(burner.fuel_categories),
      effectivity: burner.effectivity,
    }
  }

  const pumping = prototype_number(prototype, ['pumping_speed'], ['get_pumping_speed'])
  if (pumping !== undefined && pumping > 0) facts.pump = { pumping_speed_per_second: pumping * TICKS_PER_SECOND }

  return facts
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function pole_summary(pole: LuaEntity, distance: number) {
  const network = pole.electric_network_id
  const summary: Record<string, unknown> = {
    unit_number: pole.unit_number,
    name: pole.name,
    position: { x: pole.position.x, y: pole.position.y },
    distance: round_tenth(distance),
  }
  if (typeof network === 'number') summary.electric_network_id = network
  return summary
}

function has_electric_energy_source(entity: LuaEntity) {
  return (entity.prototype as any).electric_energy_source_prototype !== undefined
}

/**
 * For an electric pole that would stand at `position`: the existing poles it
 * could wire to (each pair connects when the distance is within the shorter of the
 * two wire reaches), the networks it would join, and the powered entities its
 * supply area would cover. The engine auto-connects a subset of the poles in reach.
 */
export function pole_candidate_facts(actor: ControlledActor, prototype: any, position: { x: number, y: number }) {
  const reach = pole_reach(prototype)
  if (reach === undefined) return undefined

  const poles: Array<{ pole: LuaEntity, distance: number }> = []
  for (const pole of find_world_entities(actor.surface, { position, radius: reach.max_wire_distance, type: 'electric-pole', force: actor.force } as any)) {
    if (!pole.valid) continue
    const other = pole_reach(pole.prototype)
    const limit = other === undefined ? reach.max_wire_distance : math.min(reach.max_wire_distance, other.max_wire_distance)
    const distance = math.sqrt(squared_distance(position, pole.position))
    if (distance <= limit + REACH_EPSILON) poles.push({ pole, distance })
  }
  poles.sort((left, right) => left.distance < right.distance ? -1 : left.distance > right.distance ? 1 : 0)
  const links: Array<Record<string, unknown>> = []
  const networks: number[] = []
  for (const entry of poles) {
    const network = entry.pole.electric_network_id
    if (typeof network === 'number' && !networks.includes(network)) networks.push(network)
    if (links.length < MAX_POLE_LINKS) links.push(pole_summary(entry.pole, entry.distance))
  }

  const half = reach.supply_area_distance
  const covered: Array<{ entity: LuaEntity, distance: number }> = []
  for (const entity of find_world_entities(actor.surface, {
    area: [{ x: position.x - half, y: position.y - half }, { x: position.x + half, y: position.y + half }],
    force: actor.force,
  } as any)) {
    if (!entity.valid || entity.type === 'electric-pole' || !has_electric_energy_source(entity)) continue
    covered.push({ entity, distance: math.sqrt(squared_distance(position, entity.position)) })
  }
  covered.sort((left, right) => left.distance < right.distance ? -1 : left.distance > right.distance ? 1 : 0)
  const covers: Array<Record<string, unknown>> = []
  for (const entry of covered) {
    if (covers.length >= MAX_COVERED_ENTITIES) break
    const network = entry.entity.electric_network_id
    const summary: Record<string, unknown> = {
      unit_number: entry.entity.unit_number,
      name: entry.entity.name,
      type: entry.entity.type,
      position: { x: entry.entity.position.x, y: entry.entity.position.y },
    }
    if (typeof network === 'number') summary.electric_network_id = network
    covers.push(summary)
  }

  return {
    supply_area: {
      left_top: { x: position.x - half, y: position.y - half },
      right_bottom: { x: position.x + half, y: position.y + half },
    },
    poles_in_wire_reach: links,
    poles_in_wire_reach_count: poles.length,
    poles_in_wire_reach_truncated: poles.length > links.length,
    would_join_networks: networks,
    covers_entities: covers,
    covers_entities_count: covered.length,
    covers_entities_truncated: covered.length > covers.length,
  }
}

const NO_POWER_STATUSES: Record<string, boolean> = {
  no_power: true,
  low_power: true,
  not_plugged_in_electric_network: true,
}

/** True when the entity status name says it is short of electric power. */
export function status_shows_no_power(status_name: string | undefined) {
  return status_name !== undefined && NO_POWER_STATUSES[status_name] === true
}

/**
 * Nearest known pole to an entity that shows no power, with the distance and the
 * gap between the pole supply area and the entity bounding box (0 when the
 * area already covers the entity). Searches a bounded radius.
 */
export function nearest_pole_for_unpowered(entity: LuaEntity) {
  const position = { x: entity.position.x, y: entity.position.y }
  const poles = find_world_entities(entity.surface, { position, radius: MAX_POLE_SEARCH_RADIUS, type: 'electric-pole', force: entity.force } as any)
  let nearest: LuaEntity | undefined
  let nearest_squared = math.huge
  let found = 0
  for (const pole of poles) {
    if (!pole.valid) continue
    found += 1
    const squared = squared_distance(position, pole.position)
    if (squared < nearest_squared) {
      nearest = pole
      nearest_squared = squared
    }
  }

  const result: Record<string, unknown> = { search_radius: MAX_POLE_SEARCH_RADIUS, poles_found: found }
  if (nearest === undefined) return result

  const summary = pole_summary(nearest, math.sqrt(nearest_squared))
  const reach = pole_reach(nearest.prototype)
  if (reach !== undefined) {
    const box = (entity as any).bounding_box
    const half = reach.supply_area_distance
    const gap_x = math.max(0, box.left_top.x - (nearest.position.x + half), (nearest.position.x - half) - box.right_bottom.x)
    const gap_y = math.max(0, box.left_top.y - (nearest.position.y + half), (nearest.position.y - half) - box.right_bottom.y)
    const gap = math.max(gap_x, gap_y)
    summary.supply_area_distance = reach.supply_area_distance
    summary.max_wire_distance = reach.max_wire_distance
    summary.supply_area_covers_entity = gap <= REACH_EPSILON
    summary.supply_gap_tiles = round_tenth(gap)
  }
  result.nearest_pole = summary
  return result
}
