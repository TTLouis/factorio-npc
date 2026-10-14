import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { electric_prototype_facts, nearest_pole_for_unpowered, pole_candidate_facts, pole_reach, prototype_number, status_shows_no_power } from './electric_facts'

// A key that Factorio rejects for the prototype type raises on read.
function raising(prototype: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) Object.defineProperty(prototype, key, { get() { throw new Error(`${key} is not defined for ${String(prototype.type)}`) } })
  return prototype
}

describe('electric facts read from prototypes', () => {
  const originalPairs = (globalThis as any).pairs
  beforeEach(() => { ;(globalThis as any).pairs = Object.entries })
  afterEach(() => { ;(globalThis as any).pairs = originalPairs })

  it('reads an attribute, then a quality-aware method, and treats a raising key as absent', () => {
    expect(prototype_number({ a: 4 }, ['a'], ['get_a'])).toBe(4)
    expect(prototype_number({ get_a: () => 5 }, ['a'], ['get_a'])).toBe(5)
    expect(prototype_number(raising({ get_a: () => 6 }, 'a'), ['a'], ['get_a'])).toBe(6)
    expect(prototype_number(raising({}, 'a', 'get_a'), ['a'], ['get_a'])).toBeUndefined()
    expect(prototype_number({ a: Number.NaN, get_a: () => Infinity }, ['a'], ['get_a'])).toBeUndefined()
    expect(prototype_number(undefined, ['a'], ['get_a'])).toBeUndefined()
  })

  it('reports pole supply area and wire reach for an electric-pole prototype only', () => {
    const small_pole = { name: 'small-electric-pole', type: 'electric-pole', supply_area_distance: 2.5, max_wire_distance: 7.5 }
    expect(pole_reach(small_pole)).toEqual({ supply_area_distance: 2.5, max_wire_distance: 7.5 })
    expect(electric_prototype_facts(small_pole)).toEqual({ electric_pole: { supply_area_distance: 2.5, supply_area_tiles: 5, max_wire_distance: 7.5 } })
    // 2.0 quality-aware methods.
    const substation = raising({ name: 'substation', type: 'electric-pole', get_supply_area_distance: () => 9, get_max_wire_distance: () => 18 }, 'supply_area_distance', 'max_wire_distance')
    expect(pole_reach(substation)).toEqual({ supply_area_distance: 9, max_wire_distance: 18 })
    // Not a pole: no reach, even when a modded prototype carries the same keys.
    expect(pole_reach({ type: 'lab', supply_area_distance: 2.5, max_wire_distance: 7.5 })).toBeUndefined()
    expect(pole_reach({ type: 'electric-pole', supply_area_distance: 2.5 })).toBeUndefined()
  })

  it('reports watts for a lab and a boiler, production and steam use for an engine, fuel categories and pump speed', () => {
    // The engine reports joules per tick; 1000 J/tick is 60 kW.
    const lab = raising({ name: 'lab', type: 'lab', get_max_energy_usage: () => 1000 }, 'max_energy_usage', 'max_energy_production', 'fluid_usage_per_tick', 'pumping_speed')
    expect(electric_prototype_facts(lab)).toEqual({ power: { consumption_watts: 60000 } })

    const boiler = { name: 'boiler', type: 'boiler', get_max_energy_usage: () => 30000, burner_prototype: { effectivity: 1, fuel_categories: { chemical: true, nuclear: false, 'modded-fuel': true } } }
    expect(electric_prototype_facts(boiler)).toEqual({
      power: { consumption_watts: 1800000 },
      burner: { fuel_categories: ['chemical', 'modded-fuel'], effectivity: 1 },
    })

    const engine = { name: 'steam-engine', type: 'generator', get_max_energy_production: () => 15000, get_fluid_usage_per_tick: () => 0.5 }
    expect(electric_prototype_facts(engine)).toEqual({ power: { production_watts: 900000, fluid_usage_per_second: 30 } })

    expect(electric_prototype_facts({ name: 'offshore-pump', type: 'offshore-pump', pumping_speed: 1 })).toEqual({ pump: { pumping_speed_per_second: 60 } })
    expect(electric_prototype_facts({ name: 'wooden-chest', type: 'container' })).toEqual({})
  })
})

const small_pole = { name: 'small-electric-pole', type: 'electric-pole', supply_area_distance: 2.5, max_wire_distance: 7.5 }
const weak_pole = { name: 'weak-pole', type: 'electric-pole', supply_area_distance: 1, max_wire_distance: 3 }
const lab_prototype = { name: 'lab', type: 'lab', electric_energy_source_prototype: {} }
const chest_prototype = { name: 'wooden-chest', type: 'container' }

function entity(unit_number: number, prototype: any, x: number, y: number, half: number, network?: number) {
  return {
    valid: true,
    unit_number,
    name: prototype.name,
    type: prototype.type,
    prototype,
    position: { x, y },
    electric_network_id: network,
    bounding_box: { left_top: { x: x - half, y: y - half }, right_bottom: { x: x + half, y: y + half } },
  }
}

// Emulates LuaSurface.find_entities_filtered for the filters electric_facts uses.
function surface_of(all: any[]) {
  return {
    index: 1,
    find_entities_filtered: (filters: any) => all.filter((candidate) => {
      if (filters.type !== undefined && candidate.type !== filters.type) return false
      if (filters.position !== undefined && Math.hypot(candidate.position.x - filters.position.x, candidate.position.y - filters.position.y) > filters.radius) return false
      if (filters.area !== undefined) {
        const [left_top, right_bottom] = filters.area
        const box = candidate.bounding_box
        if (box.right_bottom.x < left_top.x || box.left_top.x > right_bottom.x || box.right_bottom.y < left_top.y || box.left_top.y > right_bottom.y) return false
      }
      return true
    }),
  }
}

describe('electric pole candidate facts and unpowered pole hints', () => {
  const originalPairs = (globalThis as any).pairs
  beforeEach(() => { ;(globalThis as any).pairs = Object.entries })
  afterEach(() => { ;(globalThis as any).pairs = originalPairs })

  it('lists the poles a new pole could wire to and the powered entities its supply area covers', () => {
    const near = entity(11, small_pole, 0.5, 0.5, 0.5, 5)
    const out_of_reach = entity(12, small_pole, 30.5, 0.5, 0.5, 6)
    // Within the new pole reach (5 tiles) but beyond this pole own wire reach (3): no wire.
    const short_wired = entity(13, weak_pole, 0.5, 10.5, 0.5, 7)
    const lab = entity(21, lab_prototype, 4.5, 0.5, 1.5)
    const chest = entity(22, chest_prototype, 4.5, 1.5, 0.5)
    const live_lab = entity(23, lab_prototype, 3.5, 2.5, 1.5, 5)
    const actor = { surface: surface_of([near, out_of_reach, short_wired, lab, chest, live_lab]), force: { index: 1 } } as any

    const facts = pole_candidate_facts(actor, small_pole, { x: 0.5, y: 5.5 }) as any
    expect(facts.poles_in_wire_reach).toEqual([{ unit_number: 11, name: 'small-electric-pole', position: { x: 0.5, y: 0.5 }, distance: 5, electric_network_id: 5 }])
    expect(facts).toMatchObject({ poles_in_wire_reach_count: 1, poles_in_wire_reach_truncated: false, would_join_networks: [5] })
    expect(facts.supply_area).toEqual({ left_top: { x: -2, y: 3 }, right_bottom: { x: 3, y: 8 } })
    // The chest has no electric energy source; the pole is not a consumer; the lab at (4.5, 0.5) is out of the area.
    expect(facts.covers_entities).toEqual([{ unit_number: 23, name: 'lab', type: 'lab', position: { x: 3.5, y: 2.5 }, electric_network_id: 5 }])
    expect(facts).toMatchObject({ covers_entities_count: 1, covers_entities_truncated: false })

    expect(pole_candidate_facts(actor, chest_prototype, { x: 0, y: 0 })).toBeUndefined()
  })

  it('bounds the reported links and covered entities and keeps the nearest first', () => {
    const poles = Array.from({ length: 6 }, (_, index) => entity(100 + index, small_pole, 0.5 + index, 0.5, 0.5, 1))
    const labs = Array.from({ length: 8 }, (_, index) => entity(200 + index, lab_prototype, 10.5, 20.5 - index * 0.25, 1.5))
    const actor = { surface: surface_of([...poles, ...labs]), force: { index: 1 } } as any
    const facts = pole_candidate_facts(actor, small_pole, { x: 6.5, y: 0.5 }) as any
    expect(facts.poles_in_wire_reach.map((pole: any) => pole.unit_number)).toEqual([105, 104, 103, 102])
    expect(facts).toMatchObject({ poles_in_wire_reach_count: 6, poles_in_wire_reach_truncated: true, would_join_networks: [1] })
    const near = pole_candidate_facts(actor, small_pole, { x: 10.5, y: 19.5 }) as any
    expect(near.covers_entities).toHaveLength(6)
    expect(near).toMatchObject({ covers_entities_count: 8, covers_entities_truncated: true })
  })

  it('names the nearest pole, its distance and how far its supply area is from an unpowered entity', () => {
    const lab = entity(30, lab_prototype, 20.5, 0.5, 1.5)
    const near = entity(31, small_pole, 10.5, 0.5, 0.5, 9)
    const far = entity(32, small_pole, 40.5, 0.5, 0.5, 9)
    const surface = surface_of([lab, near, far])
    ;(lab as any).surface = surface
    ;(lab as any).force = { index: 1 }

    const hint = nearest_pole_for_unpowered(lab as any) as any
    expect(hint).toMatchObject({ search_radius: 64, poles_found: 2 })
    expect(hint.nearest_pole).toEqual({
      unit_number: 31,
      name: 'small-electric-pole',
      position: { x: 10.5, y: 0.5 },
      distance: 10,
      electric_network_id: 9,
      supply_area_distance: 2.5,
      max_wire_distance: 7.5,
      supply_area_covers_entity: false,
      supply_gap_tiles: 6,
    })

    // A pole whose supply area already reaches the entity: the gap is zero.
    const adjacent = entity(33, small_pole, 17.5, 0.5, 0.5, 9)
    const covered = nearest_pole_for_unpowered(Object.assign(lab, { surface: surface_of([lab, adjacent]) }) as any) as any
    expect(covered.nearest_pole).toMatchObject({ unit_number: 33, distance: 3, supply_area_covers_entity: true, supply_gap_tiles: 0 })

    // No known pole: only the search is reported.
    const alone = nearest_pole_for_unpowered(Object.assign(lab, { surface: surface_of([lab]) }) as any)
    expect(alone).toEqual({ search_radius: 64, poles_found: 0 })
  })

  it('recognises the statuses that mean short of power', () => {
    for (const name of ['no_power', 'low_power', 'not_plugged_in_electric_network']) expect(status_shows_no_power(name)).toBe(true)
    for (const name of ['working', 'normal', 'no_ingredients', undefined]) expect(status_shows_no_power(name as any)).toBe(false)
  })
})
