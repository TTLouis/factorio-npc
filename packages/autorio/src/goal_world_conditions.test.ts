import { beforeEach, describe, expect, it } from 'vitest'
import { evaluate_world_condition } from './goal_world_conditions'
import { note_hand_mining, record_hand_crafted_tick, record_hand_insert, record_hand_mined_item } from './hand_work'

const STATUS = { working: 1, no_power: 2, low_power: 3, no_minable_resources: 4, waiting_for_space_in_destination: 5, not_plugged_in_electric_network: 6 }
const PRECISION = { five_seconds: 0, one_minute: 1, ten_minutes: 2 }

interface FakeEntity {
  name: string
  type: string
  status?: number
  electric_network_id?: number
  surface: { index: number }
  electric_network_statistics?: unknown
}

// Lua tables iterate with pairs(); the stand-in supports for..of like one.
function lua_table<T>(entries: Record<string, T>) {
  return Object.assign(Object.create({
    *[Symbol.iterator]() { yield* Object.entries(entries) },
  }), entries)
}

function pole_statistics(output: Record<string, number>) {
  return {
    output_counts: lua_table(Object.fromEntries(Object.keys(output).map(name => [name, 1]))),
    get_flow_count: ({ name, category, precision_index }: { name: string, category: string, precision_index: number }) => {
      expect(category).toBe('output')
      expect(precision_index).toBe(PRECISION.one_minute)
      return output[name] ?? 0
    },
  }
}

let entities: FakeEntity[] = []
let flows: Record<string, Record<number, number>> = {}
const force = {
  index: 1,
  get_item_production_statistics: () => ({
    get_flow_count: ({ name, category, precision_index, count }: { name: string, category: string, precision_index: number, count: boolean }) => {
      expect(category).toBe('input')
      expect(count).toBe(true)
      return flows[name]?.[precision_index] ?? 0
    },
  }),
}

function surface(index: number) {
  return {
    index,
    find_entities_filtered: (filter: { name?: string, type?: string }) => entities.filter(entity => entity.surface.index === index
      && (filter.name === undefined || entity.name === filter.name)
      && (filter.type === undefined || entity.type === filter.type)),
  }
}

const SURFACES: Record<number, ReturnType<typeof surface>> = { 1: surface(1), 2: surface(2) }

function drill(status: number, network?: number): FakeEntity {
  return { name: 'electric-mining-drill', type: 'mining-drill', status, electric_network_id: network, surface: SURFACES[1] }
}

function pole(network: number, output: Record<string, number>): FakeEntity {
  return { name: 'small-electric-pole', type: 'electric-pole', electric_network_id: network, surface: SURFACES[1], electric_network_statistics: pole_statistics(output) }
}

function evaluate(request: Record<string, unknown>, actor_mining = false) {
  return evaluate_world_condition(force as any, request.kind, request, actor_mining) as any
}

beforeEach(() => {
  entities = []
  flows = {}
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100_000
  ;(globalThis as any).game.surfaces = new Map([[1, SURFACES[1]], [2, SURFACES[2]]])
  ;(globalThis as any).defines.entity_status = lua_table(STATUS)
  ;(globalThis as any).defines.flow_precision_index = PRECISION
  ;(globalThis as any).prototypes = {
    entity: {
      'electric-mining-drill': { type: 'mining-drill' },
      'steam-engine': { type: 'generator' },
      'solar-panel': { type: 'solar-panel' },
      'electric-energy-interface': { type: 'electric-energy-interface' },
      'accumulator': { type: 'accumulator' },
      'iron-ore': { type: 'resource', mineable_properties: { minable: true, products: [{ type: 'item', name: 'iron-ore' }] } },
    },
    item: { 'iron-ore': {}, 'iron-plate': {} },
  }
})

describe('entity_working', () => {
  it('counts only entities the engine reports as working, across surfaces', () => {
    entities = [drill(STATUS.working, 1), drill(STATUS.no_power, 1), { ...drill(STATUS.working, 4), surface: SURFACES[2] }]
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 2 }))
      .toMatchObject({ ok: true, satisfied: true, current: 2, found: 3, statuses: { working: 2, no_power: 1 } })
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 3 })).toMatchObject({ satisfied: false, current: 2 })
  })

  it('defaults to one and is unmet when none exists or none works', () => {
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill' })).toMatchObject({ ok: true, satisfied: false, current: 0, minimum: 1 })
    entities = [drill(STATUS.waiting_for_space_in_destination, 1)]
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill' })).toMatchObject({ satisfied: false })
  })

  it('rejects unknown prototypes and invalid minimums', () => {
    expect(evaluate({ kind: 'entity_working', entity_name: 'not-a-thing' })).toEqual({ ok: false, error: 'unknown_entity', entity_name: 'not-a-thing' })
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 0 })).toMatchObject({ ok: false, error: 'invalid_entity_working_condition' })
    expect(evaluate({ kind: 'entity_working', entity_name: 'electric-mining-drill', minimum: 1.5 })).toMatchObject({ ok: false })
    expect(evaluate({ kind: 'entity_working', minimum: 1 })).toMatchObject({ ok: false })
  })
})

describe('electric_network_satisfied', () => {
  it('is unmet with no power, low power, or no network', () => {
    entities = [drill(STATUS.no_power, 1), drill(STATUS.low_power, 1), drill(STATUS.working, undefined), pole(1, { 'steam-engine': 50 })]
    expect(evaluate({ kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill' }))
      .toMatchObject({ ok: true, satisfied: false, current: 0, found: 3 })
  })

  it('is met when a consumer is powered by a network whose real producer delivered energy', () => {
    entities = [drill(STATUS.working, 1), pole(1, { 'steam-engine': 50 })]
    expect(evaluate({ kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill' }))
      .toMatchObject({ ok: true, satisfied: true, current: 1, producers: ['steam-engine'] })
  })

  it('counts a powered consumer that is idle for another reason (output blocked)', () => {
    entities = [drill(STATUS.waiting_for_space_in_destination, 1), pole(1, { 'solar-panel': 3 })]
    expect(evaluate({ kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill' })).toMatchObject({ satisfied: true })
  })

  it('does not accept an electric-energy-interface or an accumulator as the producer', () => {
    entities = [drill(STATUS.working, 1), pole(1, { 'electric-energy-interface': 90, 'accumulator': 10 })]
    expect(evaluate({ kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill' }))
      .toMatchObject({ satisfied: false, without_producer: 1 })
  })

  it('requires the producer to have delivered energy within the last minute, per network', () => {
    entities = [drill(STATUS.working, 1), drill(STATUS.working, 2), pole(1, { 'steam-engine': 0 }), pole(2, { 'steam-engine': 7 })]
    expect(evaluate({ kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill', minimum: 2 }))
      .toMatchObject({ satisfied: false, current: 1, without_producer: 1 })
  })
})

describe('production_rate', () => {
  it('reads the engine flow over the window, per minute, summed over surfaces', () => {
    flows = { 'iron-ore': { [PRECISION.one_minute]: 15, [PRECISION.ten_minutes]: 120 } }
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 30 }))
      .toMatchObject({ ok: true, satisfied: true, current: 30, produced: 30, window_minutes: 1 })
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 12, window_minutes: 10 }))
      .toMatchObject({ satisfied: true, current: 24, produced: 240 })
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 31 })).toMatchObject({ satisfied: false, current: 30 })
  })

  it('rejects malformed requests and unknown items', () => {
    for (const request of [
      { item_name: 'iron-ore', per_minute: 0 },
      { item_name: 'iron-ore', per_minute: 'fast' },
      { item_name: 'iron-ore', per_minute: 10, window_minutes: 5 },
      { per_minute: 10 },
    ]) {
      expect(evaluate({ kind: 'production_rate', ...request })).toEqual({ ok: false, error: 'invalid_production_rate_condition' })
    }
    expect(evaluate({ kind: 'production_rate', item_name: 'gold', per_minute: 1 })).toEqual({ ok: false, error: 'unknown_item', item_name: 'gold' })
  })

  it('is void while the NPC hand-mines an entity yielding the item, and for the window after', () => {
    flows = { 'iron-ore': { [PRECISION.one_minute]: 60 } }
    const ore = { valid: true, name: 'iron-ore' }
    note_hand_mining(1, true, ore as any)
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 10 }, true))
      .toMatchObject({ satisfied: false, current: 120, void_reason: 'hand_mined', void_item: 'iron-ore' })
    // Another item is not affected.
    flows['iron-plate'] = { [PRECISION.one_minute]: 60 }
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 10 }, true)).toMatchObject({ satisfied: true })

    ;(globalThis as any).game.tick += 600
    note_hand_mining(1, false, undefined)
    ;(globalThis as any).game.tick += 3600
    // The stop is still within the widened window (60 s + 10 %).
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 10 })).toMatchObject({ satisfied: false, void_reason: 'hand_mined' })
    ;(globalThis as any).game.tick += 400
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 10 })).toMatchObject({ satisfied: true, void_reason: undefined })
  })

  it('closes mining the body no longer does at the evaluation tick, so the next window is still void', () => {
    flows = { 'iron-ore': { [PRECISION.one_minute]: 60 } }
    note_hand_mining(1, true, undefined) // unknown target: every item
    ;(globalThis as any).game.tick += 10_000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 10 }, false)).toMatchObject({ satisfied: false, void_reason: 'hand_mined', void_tick: 110_000 })
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 10 }, false)).toMatchObject({ satisfied: true })
  })

  it('is void after a non-fuel hand insert, but not after refuelling or loading a turret', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    record_hand_insert(1, 'coal', 'stone-furnace', 'furnace', true)
    record_hand_insert(1, 'firearm-magazine', 'gun-turret', 'ammo-turret', false)
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true })
    record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false)
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 }))
      .toMatchObject({ satisfied: false, void_reason: 'hand_inserted', void_item: 'iron-ore', void_entity: 'stone-furnace' })
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true })
  })

  it('is void after hand crafting or player hand mining of the measured item only', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 }, 'iron-ore': { [PRECISION.one_minute]: 20 } }
    record_hand_crafted_tick(1, 'iron-plate')
    record_hand_mined_item(1, 'iron-ore')
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 5 })).toMatchObject({ void_reason: 'hand_crafted' })
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 5 })).toMatchObject({ void_reason: 'hand_mined' })
    record_hand_mined_item(2, 'iron-plate') // another force
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 5 })).toMatchObject({ satisfied: true })
  })
})

it('answers undefined for kinds it does not own', () => {
  expect(evaluate({ kind: 'items_produced', item_name: 'iron-ore', minimum: 1 })).toBeUndefined()
})
