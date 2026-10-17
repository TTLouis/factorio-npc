import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prototype_details } from './prototype_knowledge'

// Prototype fields as the 2.0 runtime serves them: quality-aware values are methods,
// and a key that is not defined for the prototype type raises on read.
function raising(prototype: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) Object.defineProperty(prototype, key, { get() { throw new Error(`${key} is not defined`) } })
  return prototype
}

describe('prototype details expose electric and fluid-throughput facts', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    const entity = {
      'small-electric-pole': raising({ name: 'small-electric-pole', type: 'electric-pole', is_building: true, tile_width: 1, tile_height: 1,
        electric_energy_source_prototype: undefined, supply_area_distance: 2.5, max_wire_distance: 7.5 }, 'get_max_energy_usage'),
      lab: { name: 'lab', type: 'lab', is_building: true, tile_width: 3, tile_height: 3, electric_energy_source_prototype: {}, get_max_energy_usage: () => 1000 },
      boiler: { name: 'boiler', type: 'boiler', is_building: true, tile_width: 3, tile_height: 2, burner_prototype: { effectivity: 1, fuel_categories: { chemical: true } },
        get_max_energy_usage: () => 30000 },
      'steam-engine': { name: 'steam-engine', type: 'generator', is_building: true, tile_width: 3, tile_height: 5, electric_energy_source_prototype: {},
        get_max_energy_production: () => 15000, get_fluid_usage_per_tick: () => 0.5 },
      'offshore-pump': { name: 'offshore-pump', type: 'offshore-pump', is_building: true, tile_width: 1, tile_height: 2, pumping_speed: 1 },
    }
    ;(globalThis as any).prototypes = { entity, item: {}, fluid: {} }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes = originalPrototypes
  })

  const entity_of = (name: string) => (prototype_details(name) as any).entity

  it('gives the pole supply area and wire reach', () => {
    expect(entity_of('small-electric-pole').electric_pole).toEqual({ supply_area_distance: 2.5, supply_area_tiles: 5, max_wire_distance: 7.5 })
  })

  it('gives watts for the lab, the boiler and the steam engine, and the boiler fuel categories', () => {
    expect(entity_of('lab').power).toEqual({ consumption_watts: 60000, prototype_quality: 'normal' })
    expect(entity_of('boiler').power).toEqual({ consumption_watts: 1800000, prototype_quality: 'normal' })
    expect(entity_of('boiler').burner).toEqual({ fuel_categories: ['chemical'], effectivity: 1 })
    expect(entity_of('steam-engine').power).toEqual({ production_watts: 900000, fluid_usage_per_second: 30, prototype_quality: 'normal' })
  })

  it('gives the pump speed and adds nothing to entities that have none of these facts', () => {
    expect(entity_of('offshore-pump').pump).toEqual({ pumping_speed_per_second: 60 })
    const pump = entity_of('offshore-pump')
    expect(pump.power).toBeUndefined()
    expect(pump.electric_pole).toBeUndefined()
    expect(pump.burner).toBeUndefined()
    expect(entity_of('lab').electric_pole).toBeUndefined()
  })
})
