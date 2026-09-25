// Deterministic time and rate facts read from live prototypes.
//
// The planner decides how many machines to build; this module only turns game
// data into per-machine rates so it can do that arithmetic itself. Nothing here
// suggests a machine count or a layout.
//
// Factorio 2.0 notes:
//   - LuaEntityPrototype has no `crafting_speed` key; get_crafting_speed() is a
//     method (CraftingMachine or Character only). Reading an absent key on a
//     LuaObject raises, so the prototype stays typed and methods are dot calls.
//   - get_max_energy_usage() is joules per tick; watts = value * 60.
//   - Properties documented "Can only be used if this is X" raise on other
//     prototype types, so callers read mining_speed only on drills/characters.
//
// Rates exclude modules, beacons, quality and research recipe productivity.
import type { LuaBurnerPrototype, LuaEntityPrototype, LuaForce } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'

export const RATE_BASIS = 'from prototypes; excludes modules, beacons, quality and recipe productivity research; assumes inputs and fuel never run out'

export function round_rate(value: number) {
  return math.floor(value * 10000 + 0.5) / 10000
}

export function sorted_keys(value: Record<string, unknown> | undefined) {
  const keys: string[] = []
  if (value === undefined) return keys
  for (const [key] of pairs(value)) keys.push(key)
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

// Expected amount of one product per craft or mining cycle.
export function expected_product_amount(product: any) {
  let amount = product.amount
  if (amount === undefined) {
    if (product.amount_min === undefined || product.amount_max === undefined) return 0
    amount = (product.amount_min + product.amount_max) / 2
  }
  const probability = product.probability ?? 1
  return (amount + (product.extra_count_fraction ?? 0)) * probability
}

export function product_rates_per_minute(products: any[] | undefined, cycles_per_second: number, multiplier: number = 1) {
  const result: Array<{ type: string, name: string, per_minute: number }> = []
  for (const product of products ?? []) {
    result.push({
      type: product.type,
      name: product.name,
      per_minute: round_rate(expected_product_amount(product) * multiplier * cycles_per_second * 60),
    })
  }
  return result
}

// Crafting speed of the actor's own hands: the character prototype speed times
// (1 + force manual crafting modifier + the character's own modifier).
export function hand_crafting_speed(actor: ControlledActor) {
  const character = actor.character
  if (character === undefined) return undefined
  const base = character.prototype.get_crafting_speed()
  return base * (1 + (actor.force.manual_crafting_speed_modifier ?? 0) + (character.character_crafting_speed_modifier ?? 0))
}

export function hand_mining_speed(actor: ControlledActor) {
  const character = actor.character
  if (character === undefined) return undefined
  const base = character.prototype.mining_speed
  if (base === undefined) return undefined
  return base * (1 + (actor.force.manual_mining_speed_modifier ?? 0) + (character.character_mining_speed_modifier ?? 0))
}

export function drill_productivity_bonus(force: LuaForce, drill: LuaEntityPrototype) {
  if (drill.uses_force_mining_productivity_bonus === false) return 0
  return force.mining_drill_productivity_bonus ?? 0
}

export function fuel_burn(energy_watts: number, burner: LuaBurnerPrototype, fuel_name: string) {
  const item = prototypes.item[fuel_name]
  if (item === undefined) return { name: fuel_name, accepted: false, error: 'unknown item' }
  const category = item.fuel_category
  const fuel_value = item.fuel_value
  if (category === undefined || burner.fuel_categories[category] !== true || !(fuel_value > 0)) {
    return { name: fuel_name, accepted: false, error: 'this burner does not accept this fuel' }
  }
  return {
    name: fuel_name,
    accepted: true,
    fuel_value_joules: fuel_value,
    per_minute: round_rate(energy_watts * 60 / (fuel_value * burner.effectivity)),
  }
}

// Energy source facts for one machine; a named fuel adds its burn rate at full load.
export function energy_facts(prototype: LuaEntityPrototype, fuel_name: string | undefined) {
  const energy_watts = prototype.get_max_energy_usage() * 60
  const burner = prototype.burner_prototype
  if (burner === undefined) {
    return {
      energy_source: prototype.electric_energy_source_prototype !== undefined ? 'electric' : 'other',
      energy_watts: round_rate(energy_watts),
    }
  }
  return {
    energy_source: 'burner',
    energy_watts: round_rate(energy_watts),
    burner_effectivity: burner.effectivity,
    fuel_categories: sorted_keys(burner.fuel_categories),
    fuel: fuel_name === undefined ? undefined : fuel_burn(energy_watts, burner, fuel_name),
  }
}

// Per-machine crafting rate for a recipe (recipe.energy is seconds at speed 1).
export function machine_craft_rate(prototype: LuaEntityPrototype, recipe: any, fuel_name: string | undefined) {
  const crafting_speed = prototype.get_crafting_speed()
  const energy = recipe.energy
  if (!(crafting_speed > 0) || !(energy > 0)) {
    return { crafting_speed, ...energy_facts(prototype, fuel_name) }
  }
  const crafts_per_second = crafting_speed / energy
  return {
    crafting_speed,
    seconds_per_craft: round_rate(energy / crafting_speed),
    crafts_per_second: round_rate(crafts_per_second),
    products_per_minute: product_rates_per_minute(recipe.products, crafts_per_second),
    ...energy_facts(prototype, fuel_name),
  }
}

export function resource_mining_time(resource: LuaEntityPrototype) {
  return (resource.mineable_properties as any).mining_time as number
}

// Per-drill mining rate on one resource, including the force's mining
// productivity bonus when the drill uses it.
export function drill_mining_rate(force: LuaForce, drill: LuaEntityPrototype, resource: LuaEntityPrototype, fuel_name: string | undefined) {
  const mining_speed = drill.mining_speed ?? 0
  const mining_time = resource_mining_time(resource)
  const productivity_bonus = drill_productivity_bonus(force, drill)
  if (!(mining_speed > 0) || !(mining_time > 0)) {
    return { mining_speed, productivity_bonus, ...energy_facts(drill, fuel_name) }
  }
  const cycles_per_second = mining_speed / mining_time
  return {
    mining_speed,
    productivity_bonus,
    seconds_per_cycle: round_rate(mining_time / mining_speed),
    products_per_minute: product_rates_per_minute((resource.mineable_properties as any).products, cycles_per_second, 1 + productivity_bonus),
    ...energy_facts(drill, fuel_name),
  }
}
