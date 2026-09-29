import { beforeEach, describe, expect, it } from 'vitest'
import { evaluate_world_condition } from './goal_world_conditions'
import { MAX_FED_ENTITIES, mining_targets_at, note_hand_mining, record_hand_crafted_tick, record_hand_insert, record_hand_mined_item } from './hand_work'

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
      'stone-furnace': { type: 'furnace', mineable_properties: { minable: true, products: [{ type: 'item', name: 'stone-furnace' }] } },
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

describe('production_rate with a hand-fed machine', () => {
  interface FakeMachine { valid: boolean, unit_number: number, name: string, type: string, position: { x: number, y: number }, surface: { index: number }, input: Record<string, number> }
  let machines: Record<number, FakeMachine> = {}

  function inventory(index: number, name: string, contents: () => Record<string, number>) {
    return { index, name, get_contents: () => Object.entries(contents()).map(([item, count]) => ({ name: item, count, quality: 'normal' })) }
  }

  // Slots as the engine names them for a furnace: fuel, input, output.
  function furnace(unit_number: number, input: Record<string, number>): any {
    const machine: FakeMachine = { valid: true, unit_number, name: 'stone-furnace', type: 'furnace', position: { x: unit_number * 3, y: 4 }, surface: SURFACES[1], input }
    const fuel = inventory(1, 'fuel', () => ({ coal: 5 }))
    const source = inventory(2, 'crafter_input', () => machine.input)
    const output = inventory(3, 'crafter_output', () => ({ 'iron-plate': 9 }))
    machines[unit_number] = machine
    return Object.assign(machine, {
      get_max_inventory_index: () => 3,
      get_inventory: (index: number) => [undefined, fuel, source, output][index],
      get_fuel_inventory: () => fuel,
      get_output_inventory: () => output,
      get_burnt_result_inventory: () => undefined,
    })
  }

  beforeEach(() => {
    machines = {}
    // Furnaces are not indexed by game.get_entity_by_unit_number (engine 2.0.77),
    // so the fake game does not answer it; they are found on their surface.
    ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
    ;(globalThis as any).game.get_surface = () => ({
      valid: true,
      find_entities_filtered: (filter: { name: string, position: { x: number, y: number }, radius: number }) => Object.values(machines)
        .filter(machine => machine.name === filter.name && Math.hypot(machine.position.x - filter.position.x, machine.position.y - filter.position.y) <= filter.radius),
    })
  })

  it('stays void past 1.1x the window while the machine still holds hand-fed ore, and clears when it is used up', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    const stone = furnace(7, { 'iron-ore': 50 })
    record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, stone)
    ;(globalThis as any).game.tick += 4000 // past 60 s * 1.1 = 3960 ticks
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 }))
      .toMatchObject({ satisfied: false, void_reason: 'hand_inserted', void_item: 'iron-ore', void_entity: 'stone-furnace' })
    ;(globalThis as any).game.tick += 6000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: false, void_reason: 'hand_inserted' })
    machines[7].input = {}
    // What it smelted until it emptied is still in the window that follows.
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: false, void_reason: 'hand_inserted', void_entity: 'stone-furnace' })
    expect((globalThis as any).storage.airi_hand_work[1].fed).toEqual([])
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true, void_reason: undefined })
  })

  it('does not track fuel inserts or chests beyond the insert window', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    const stone = furnace(8, { 'iron-ore': 50 })
    record_hand_insert(1, 'coal', 'stone-furnace', 'furnace', true, stone)
    const chest = { valid: true, unit_number: 9, name: 'wooden-chest', type: 'container', position: { x: 1, y: 1 }, surface: SURFACES[1] }
    machines[9] = chest as any
    record_hand_insert(1, 'iron-ore', 'wooden-chest', 'container', false, chest as any)
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true })
    expect((globalThis as any).storage.airi_hand_work[1].fed ?? []).toEqual([])
  })

  it('ignores hand-fed input the machine no longer holds, and machines that vanished', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    const a = furnace(10, { 'iron-ore': 1 })
    const b = furnace(11, { 'iron-ore': 1 })
    record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, a)
    record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, b)
    ;(globalThis as any).game.tick += 4000
    machines[10].input = { 'copper-ore': 4 } // holds something, but not what was hand-fed
    delete machines[11]
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: false, void_reason: 'hand_inserted' })
    ;(globalThis as any).game.tick += 4000
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true })
  })

  it('keeps a bounded list and voids everything once it overflows, until it drains and a long hold passes', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    for (let unit = 100; unit <= 100 + MAX_FED_ENTITIES; unit++) {
      record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, furnace(unit, { 'iron-ore': 5 }))
    }
    expect((globalThis as any).storage.airi_hand_work[1].fed).toHaveLength(MAX_FED_ENTITIES)
    ;(globalThis as any).game.tick += 4000
    for (const machine of Object.values(machines)) machine.input = {}
    // Every tracked machine is empty, but one was not tracked: still void.
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: false, void_reason: 'hand_inserted' })
    ;(globalThis as any).game.tick += 20 * 3600
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 20 })).toMatchObject({ satisfied: true })
  })

  it('makes room when tracked machines have drained', () => {
    for (let unit = 200; unit < 200 + MAX_FED_ENTITIES; unit++) record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, furnace(unit, { 'iron-ore': 5 }))
    for (const machine of Object.values(machines)) machine.input = {}
    record_hand_insert(1, 'iron-ore', 'stone-furnace', 'furnace', false, furnace(999, { 'iron-ore': 5 }))
    const store = (globalThis as any).storage.airi_hand_work[1]
    expect(store.fed).toHaveLength(1)
    expect(store.fed_overflow_tick).toBeUndefined()
  })
})

describe('mining_targets_at', () => {
  const at = (entities: unknown[]) => ({ find_entities_filtered: () => entities }) as any

  it('finds minable entities at the position, whatever is selected, and none when nothing is there', () => {
    const ore = { valid: true, name: 'iron-ore', type: 'resource', position: { x: 4.5, y: 6.5 } }
    const neighbour = { valid: true, name: 'iron-ore', type: 'resource', position: { x: 5.5, y: 6.5 } }
    const body = { valid: true, name: 'character', type: 'character', position: { x: 4.5, y: 6.5 } }
    expect(mining_targets_at(at([neighbour, ore, body]), { x: 4.5, y: 6.5 })).toEqual([ore])
    expect(mining_targets_at(at([neighbour]), { x: 4.5, y: 6.5 })).toEqual([])
    expect(mining_targets_at(at([ore]), undefined)).toEqual([])
  })

  it('voids every item when no target is found at the position', () => {
    flows = { 'iron-plate': { [PRECISION.one_minute]: 20 } }
    note_hand_mining(1, true, mining_targets_at(at([]), { x: 4.5, y: 6.5 }))
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-plate', per_minute: 5 }, true)).toMatchObject({ void_reason: 'hand_mined', void_item: '*' })
  })

  it('a hand-mined iron-ore target voids an iron-ore rate but not a copper-ore one', () => {
    flows = { 'iron-ore': { [PRECISION.one_minute]: 20 }, 'copper-ore': { [PRECISION.one_minute]: 20 } }
    ;(globalThis as any).prototypes.item['copper-ore'] = {}
    const ore = { valid: true, name: 'iron-ore', type: 'resource', position: { x: 4.5, y: 6.5 } }
    note_hand_mining(1, true, mining_targets_at(at([ore]), { x: 4.5, y: 6.5 }))
    expect(evaluate({ kind: 'production_rate', item_name: 'iron-ore', per_minute: 5 }, true)).toMatchObject({ void_reason: 'hand_mined', void_item: 'iron-ore' })
    expect(evaluate({ kind: 'production_rate', item_name: 'copper-ore', per_minute: 5 }, true)).toMatchObject({ satisfied: true })
  })
})

it('answers undefined for kinds it does not own', () => {
  expect(evaluate({ kind: 'items_produced', item_name: 'iron-ore', minimum: 1 })).toBeUndefined()
})
