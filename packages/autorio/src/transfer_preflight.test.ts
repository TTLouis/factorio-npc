import type { ControlledActor } from './actors/types'
import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transfer_preflight_facts, transfer_unknown_item } from './transfer_preflight'

interface InventoryOptions {
  name?: string
  index?: number
  /** Free room for any item; `can_insert` is false at zero. */
  room?: number
}

function inventory(initial: Record<string, number> = {}, options: InventoryOptions = {}) {
  const counts = { ...initial }
  const room = options.room ?? 1000
  return {
    counts,
    get_item_count: vi.fn((name: string) => counts[name] ?? 0),
    can_insert: vi.fn(() => room > 0),
    get_insertable_count: vi.fn(() => room),
    index: options.index ?? 1,
    name: options.name ?? 'chest',
    length: 4,
    count_empty_stacks: vi.fn(() => (room > 0 ? 1 : 0)),
    get_contents: vi.fn(() => Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
  } as unknown as LuaInventory
}

function chest(unit_number: number, chest_inventory: LuaInventory) {
  return {
    valid: true,
    name: 'wooden-chest',
    type: 'container',
    unit_number,
    get_max_inventory_index: vi.fn(() => 1),
    get_inventory: vi.fn(() => chest_inventory),
    get_output_inventory: vi.fn(() => undefined),
    get_fuel_inventory: vi.fn(() => undefined),
    get_burnt_result_inventory: vi.fn(() => undefined),
  } as unknown as LuaEntity
}

function furnace(unit_number: number, parts: { fuel: LuaInventory, source: LuaInventory, output: LuaInventory }) {
  const by_index = [undefined, parts.fuel, parts.source, parts.output]
  return {
    valid: true,
    name: 'stone-furnace',
    type: 'furnace',
    unit_number,
    get_max_inventory_index: vi.fn(() => 3),
    get_inventory: vi.fn((index: number) => by_index[index]),
    get_output_inventory: vi.fn(() => parts.output),
    get_fuel_inventory: vi.fn(() => parts.fuel),
    get_burnt_result_inventory: vi.fn(() => undefined),
  } as unknown as LuaEntity
}

function furnace_parts(options: {
  fuel?: Record<string, number>
  source?: Record<string, number>
  output?: Record<string, number>
  source_room?: number
  fuel_room?: number
} = {}) {
  return {
    fuel: inventory(options.fuel, { name: 'fuel', index: 1, room: options.fuel_room }),
    source: inventory(options.source, { name: 'crafter_input', index: 2, room: options.source_room }),
    output: inventory(options.output, { name: 'crafter_output', index: 3 }),
  }
}

function actor_with(held: Record<string, number>, options: InventoryOptions = {}) {
  const main = inventory(held, options)
  return {
    actor: { is_valid: true, get_main_inventory: vi.fn(() => main) } as unknown as ControlledActor,
    main,
  }
}

beforeEach(() => {
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.item = {
    ...(globalThis as any).prototypes.item,
    'coal': {},
    'iron-ore': {},
    'iron-gear-wheel': {},
  }
})

describe('transfer preflight facts: supply_entity', () => {
  it.each([true, false])('refuses different ores competing for one initially empty slot, copper first=%s', (copper_first) => {
    const { actor } = actor_with({ coal: 20, 'copper-ore': 80, 'iron-ore': 200 })
    const parts = furnace_parts()
    ;(parts.fuel as any).length = 1
    ;(parts.source as any).length = 1
    ;(parts.fuel as any).can_insert = vi.fn((stack: { name: string }) => stack.name === 'coal')
    ;(parts.source as any).can_insert = vi.fn((stack: { name: string }) => stack.name !== 'coal')
    const copper = { item_name: 'copper-ore', count: 80 }; const iron = { item_name: 'iron-ore', count: 120 }
    const target = furnace(11, parts)
    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 11,
      items: [{ item_name: 'coal', count: 20 }, ...(copper_first ? [copper, iron] : [iron, copper])],
    })!
    expect(facts).toMatchObject({ ok: false, code: 'supply_destination_conflict', transfer: {
      destination_conflict: { inventory_index: 2, slot_count: 1, item_names: copper_first ? ['copper-ore', 'iron-ore'] : ['iron-ore', 'copper-ore'] },
    } })
    expect(facts.transfer.items.every(item => item.expected_moved > 0)).toBe(true)
    expect(transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 11,
      items: [{ item_name: 'coal', count: 20 }, copper],
    })!.ok).toBe(true)
    // Multiple native input slots do not establish this sole-slot conflict.
    ;(parts.source as any).length = 2
    expect(transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 11, items: [copper, iron] })!.ok).toBe(true)
  })

  it('rejects with supply_missing and counts when the NPC holds none of the item (zero coal)', () => {
    const { actor } = actor_with({ 'iron-plate': 10 })
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('supply_missing')
    expect(facts.transfer.direction).toBe('to_entity')
    expect(facts.transfer.items).toEqual([expect.objectContaining({
      item_name: 'coal',
      requested: 5,
      source_count: 0,
      destination_accepts: 2000,
      expected_moved: 0,
      missing: 5,
      status: 'supply_missing',
    })])
  })

  it('accepts partial stock with the counts and the missing amount, never as a failure', () => {
    const { actor } = actor_with({ coal: 2 })
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] })!

    expect(facts.ok).toBe(true)
    expect(facts.code).toBeUndefined()
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 2, requested: 5, missing: 3, expected_moved: 2, status: 'partial' })
  })

  it('reports a normal supply as ok with nothing missing', () => {
    const { actor } = actor_with({ coal: 20, 'iron-ore': 50 })
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', {
      unit_number: 15,
      items: [{ item_name: 'coal', count: 5 }, { item_name: 'iron-ore', count: 50 }],
    })!

    expect(facts.ok).toBe(true)
    expect(facts.transfer.items.map(item => [item.item_name, item.status, item.missing, item.expected_moved])).toEqual([
      ['coal', 'ok', 0, 5],
      ['iron-ore', 'ok', 0, 50],
    ])
  })

  it('rejects when the destination accepts none of the item (destination_full) and says why', () => {
    const { actor } = actor_with({ 'iron-ore': 50 })
    const target = furnace(15, furnace_parts({ source: { 'copper-ore': 10 }, source_room: 0, fuel_room: 0 }))

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'iron-ore', count: 50 }] })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('destination_full')
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 50, destination_accepts: 0, expected_moved: 0, status: 'destination_full', refusal_cause: 'input_slot_holds_other_item' })
    expect(facts.transfer.items[0].target_inventories?.map(entry => entry.role)).toEqual(['fuel', 'input', 'output'])
  })

  it('uses only input and fuel inventories as destination capacity, never the output slot', () => {
    const { actor } = actor_with({ 'iron-plate': 10 })
    const parts = furnace_parts({ source_room: 0, fuel_room: 0 })
    const target = furnace(15, parts)
    ;(parts.output as any).can_insert = vi.fn(() => true)
    ;(parts.output as any).get_insertable_count = vi.fn(() => 500)

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'iron-plate', count: 10 }] })!

    expect(facts.code).toBe('destination_full')
    expect(facts.transfer.items[0].destination_accepts).toBe(0)
  })

  it('caps expected movement by destination room', () => {
    const { actor } = actor_with({ 'iron-ore': 50 })
    const target = furnace(15, furnace_parts({ source_room: 8, fuel_room: 0 }))

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'iron-ore', count: 50 }] })!

    expect(facts.ok).toBe(true)
    expect(facts.transfer.items[0]).toMatchObject({ destination_accepts: 8, expected_moved: 8, status: 'ok' })
  })

  it('refuses a mixed batch when one destination takes nothing, retaining every item fact', () => {
    // Fuel slot full: coal has nowhere to go (a refusal), while the ore still moves natively.
    const { actor } = actor_with({ 'iron-ore': 50, coal: 5 })
    const parts = furnace_parts({ fuel_room: 0 })
    ;(parts.source as any).can_insert = vi.fn((stack: { name: string }) => stack.name !== 'coal')
    const target = furnace(15, parts)

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', {
      unit_number: 15,
      items: [{ item_name: 'iron-ore', count: 50 }, { item_name: 'coal', count: 5 }],
    })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('destination_full')
    expect(facts.transfer.items.map(item => [item.item_name, item.status])).toEqual([['iron-ore', 'ok'], ['coal', 'destination_full']])
  })

  it.each([true, false])('refuses occupied furnace input with usable fuel, blocked ore first=%s', (ore_first) => {
    const { actor } = actor_with({ 'copper-ore': 75, wood: 18 })
    const parts = furnace_parts({ source: { 'iron-ore': 42 } })
    ;(parts.source as any).count_empty_stacks = vi.fn(() => 0)
    ;(parts.source as any).can_insert = vi.fn((stack: { name: string }) => stack.name === 'iron-ore')
    ;(parts.fuel as any).can_insert = vi.fn((stack: { name: string }) => stack.name === 'wood')
    const ore = { item_name: 'copper-ore', count: 75 }; const fuel = { item_name: 'wood', count: 18 }
    const facts = transfer_preflight_facts(actor, furnace(3, parts), 'supply_entity', {
      unit_number: 3, items: ore_first ? [ore, fuel] : [fuel, ore],
    })!
    expect(facts).toMatchObject({ ok: false, code: 'destination_full' })
    expect(facts.transfer.items.find(item => item.item_name === 'copper-ore')).toMatchObject({
      source_count: 75, expected_moved: 0, status: 'destination_full', refusal_cause: 'input_slot_holds_other_item',
    })
    expect(facts.transfer.items.find(item => item.item_name === 'wood')).toMatchObject({ expected_moved: 18, status: 'ok' })
  })

  it.each([true, false])('refuses all supply when one source is missing, missing item first=%s', (missing_first) => {
    const { actor } = actor_with({ 'iron-ore': 50 })
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', {
      unit_number: 15,
      items: missing_first
        ? [{ item_name: 'coal', count: 5 }, { item_name: 'iron-ore', count: 50 }]
        : [{ item_name: 'iron-ore', count: 50 }, { item_name: 'coal', count: 5 }],
    })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('supply_missing')
    expect(facts.transfer.items.find(item => item.item_name === 'coal')).toMatchObject({ status: 'supply_missing', source_count: 0, missing: 5 })
    expect(facts.transfer.items.find(item => item.item_name === 'iron-ore')).toMatchObject({ status: 'ok', source_count: 50, expected_moved: 50 })
  })

  it('lists every item when all supply sources are missing', () => {
    const { actor } = actor_with({})
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', {
      unit_number: 15,
      items: [{ item_name: 'iron-ore', count: 50 }, { item_name: 'coal', count: 5 }],
    })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('supply_missing')
    expect(facts.transfer.items.map(item => item.status)).toEqual(['supply_missing', 'supply_missing'])
  })

  it('reports unknown item names so the caller can reject them before any inventory call', () => {
    expect(transfer_unknown_item('supply_entity', { unit_number: 15, items: [{ item_name: 'iron-ore', count: 1 }, { item_name: 'colal', count: 5 }] })).toBe('colal')
    expect(transfer_unknown_item('move_items_exact', { item_name: 'iron-oar', unit_number: 15, max_count: 5, to_entity: true })).toBe('iron-oar')
    expect(transfer_unknown_item('supply_entity', { unit_number: 15, items: [{ item_name: 'coal', count: 1 }] })).toBeUndefined()
    expect(transfer_unknown_item('move_items_exact', { item_name: 'coal', unit_number: 15, max_count: 5, to_entity: true })).toBeUndefined()
    expect(transfer_unknown_item('rotate_entity', {})).toBeUndefined()
  })

  it('leaves malformed arguments to the native admission', () => {
    const { actor } = actor_with({ coal: 5 })
    const target = furnace(15, furnace_parts())

    expect(transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [] })).toBeUndefined()
    expect(transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15, items: [{ item_name: 'coal', count: 0 }] })).toBeUndefined()
    expect(transfer_preflight_facts(actor, target, 'supply_entity', { unit_number: 15 })).toBeUndefined()
  })
})

describe('transfer preflight facts: move_items_exact', () => {
  it('rejects extraction_empty when the ore was already moved and the entity holds none (source zero)', () => {
    const { actor } = actor_with({})
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'iron-ore', unit_number: 15, max_count: 50, to_entity: false })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('extraction_empty')
    expect(facts.transfer.direction).toBe('from_entity')
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 0, requested: 50, missing: 50, status: 'extraction_empty' })
  })

  it('rejects supply_missing for ore the NPC does not hold even though the furnace already holds it', () => {
    const { actor } = actor_with({})
    const target = furnace(15, furnace_parts({ source: { 'iron-ore': 50 } }))

    const facts = transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'iron-ore', unit_number: 15, max_count: 50, to_entity: true })!

    expect(facts.code).toBe('supply_missing')
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 0, status: 'supply_missing' })
  })

  it('accepts extraction with partial stock, counting every entity inventory including the output slot', () => {
    const { actor } = actor_with({})
    const target = furnace(15, furnace_parts({ output: { 'iron-plate': 30 }, source: { 'iron-plate': 5 } }))

    const facts = transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'iron-plate', unit_number: 15, max_count: 100, to_entity: false })!

    expect(facts.ok).toBe(true)
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 35, requested: 100, missing: 65, expected_moved: 35, status: 'partial' })
  })

  it('rejects destination_full when the NPC inventory cannot take the extracted item', () => {
    const { actor } = actor_with({ 'iron-plate': 100 }, { room: 0 })
    const target = chest(77, inventory({ 'iron-plate': 40 }))

    const facts = transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'iron-plate', unit_number: 77, max_count: 40, to_entity: false })!

    expect(facts.ok).toBe(false)
    expect(facts.code).toBe('destination_full')
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 40, destination_accepts: 0, expected_moved: 0 })
  })

  it('leaves the normal case unchanged: a held item into a chest is ok', () => {
    const { actor } = actor_with({ 'iron-plate': 100 })
    const target = chest(77, inventory())

    const facts = transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'iron-plate', unit_number: 77, max_count: 60, to_entity: true })!

    expect(facts.ok).toBe(true)
    expect(facts.transfer.items[0]).toMatchObject({ source_count: 100, requested: 60, missing: 0, expected_moved: 60, status: 'ok' })
  })

  it('ignores operations it does not cover and malformed move arguments', () => {
    const { actor } = actor_with({ coal: 5 })
    const target = chest(77, inventory())

    expect(transfer_preflight_facts(actor, target, 'rotate_entity', {})).toBeUndefined()
    expect(transfer_preflight_facts(actor, target, 'move_items_exact', { item_name: 'coal', unit_number: 77, max_count: 5 })).toBeUndefined()
  })
})

describe('operation_preflight wiring (autorio_preflight.operation)', () => {
  const interfaces: Record<string, any> = {}
  let preflight: (name: string, args: Record<string, any>) => any
  let held: ReturnType<typeof actor_with>
  let current_target: LuaEntity | undefined

  beforeEach(async () => {
    vi.resetModules()
    ;(globalThis as any).remote = { interfaces: {}, add_interface: (name: string, value: any) => { interfaces[name] = value }, call: () => undefined }
    held = actor_with({ 'iron-ore': 50 })
    ;(held.actor as any).surface = { index: 1 }
    ;(held.actor as any).force = { index: 1 }
    current_target = undefined
    ;(globalThis as any).game.get_entity_by_unit_number = () => current_target
    ;(globalThis as any).game.get_player = () => undefined
    vi.doMock('./actors/actor_controller', async (original) => ({
      ...(await original<typeof import('./actors/actor_controller')>()),
      get_controlled_actor: () => held.actor,
    }))
    await import('./control')
    preflight = interfaces.autorio_preflight.operation
  })

  function exact(unit_number: number) {
    const base: any = furnace(unit_number, furnace_parts())
    base.surface = { index: 1 }
    base.force = { index: 1 }
    base.position = { x: 1, y: 1 }
    return base as LuaEntity
  }

  it('refuses unavailable player identities before dispatch without treating the actor name as a player', () => {
    const args = { player_name: 'SGLuna', item_name: 'copper-ore', max_count: 74, to_player: true }
    const lookup = vi.fn((): any => undefined)
    ;(globalThis as any).game.get_player = lookup
    ;(held.actor as any).status_snapshot = () => ({ name: 'SGLuna' })
    const inventory_calls = (held.main.get_item_count as any).mock.calls.length
    expect(preflight('move_items_with_player', args)).toMatchObject({ ok: false, code: 'player_unavailable',
      operation: 'move_items_with_player', field: 'player_name', identity: 'SGLuna' })
    expect(lookup).toHaveBeenCalledWith('SGLuna')
    for (const player of [{ valid: false, connected: true, character: {} }, { valid: true, connected: false, character: {} },
      { valid: true, connected: true }]) {
      lookup.mockReturnValue(player)
      expect(preflight('move_items_with_player', args)).toMatchObject({ ok: false, code: 'player_unavailable' })
    }
    lookup.mockReturnValue({ valid: true, connected: true, character: {} })
    expect(preflight('move_items_with_player', args)).toMatchObject({ ok: true, identity: 'SGLuna' })
    expect((held.main.get_item_count as any).mock.calls.length).toBe(inventory_calls)
    lookup.mockClear()
    for (const player_name of ['', undefined, 42]) {
      expect(preflight('move_items_with_player', { ...args, player_name })).toMatchObject({ ok: false, code: 'player_unavailable' })
    }
    expect(lookup).not.toHaveBeenCalled()
    ;(held.actor as any).is_valid = false
    expect(preflight('move_items_with_player', args)).toMatchObject({ ok: false, code: 'no_actor' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(['furnace', 'container', 'mining-drill'])('refuses setting a recipe on a %s before any recipe or inventory read', (type) => {
    const target: any = exact(15)
    target.type = type
    current_target = target
    Object.defineProperty(held.actor.force, 'recipes', { get: () => { throw new Error('must not read recipes') } })
    const inventory_calls = (held.main.get_item_count as any).mock.calls.length

    expect(preflight('set_machine_recipe', { unit_number: 15, recipe_name: 'iron-plate' }))
      .toMatchObject({ ok: false, code: 'not_recipe_machine', operation: 'set_machine_recipe',
        identity: 15, observed_type: type, expected_type: 'assembling-machine', target: { unit_number: 15 } })
    expect((held.main.get_item_count as any).mock.calls.length).toBe(inventory_calls)
  })

  it('keeps recipe preflight available for an exact assembling machine and preserves unknown-recipe refusal', () => {
    const target: any = exact(15)
    target.type = 'assembling-machine'
    target.name = 'assembling-machine-1'
    current_target = target
    ;(held.actor.force as any).recipes = { 'iron-gear-wheel': { name: 'iron-gear-wheel' } }
    expect(preflight('set_machine_recipe', { unit_number: 15, recipe_name: 'iron-gear-wheel' }))
      .toMatchObject({ ok: true, recipe_name: 'iron-gear-wheel', target: { unit_number: 15, name: 'assembling-machine-1' } })
    expect(preflight('set_machine_recipe', { unit_number: 15, recipe_name: '__absent__' }))
      .toMatchObject({ ok: false, code: 'unknown_recipe' })
  })

  it('refuses navigation to a known prototype absent from the requested native search', () => {
    ;(globalThis as any).prototypes.entity['copper-stromatolite'] = { type: 'simple-entity' }
    ;(held.actor as any).position = { x: 25, y: -46 }
    const scan = vi.fn(() => [])
    ;(held.actor as any).surface.find_entities_filtered = scan
    expect(preflight('walk_to_entity', { entity_name: 'copper-stromatolite', search_radius: 4096 }))
      .toMatchObject({ ok: false, code: 'navigation_target_not_found', identity: 'copper-stromatolite', search_radius: 4096 })
    expect(scan).toHaveBeenCalledWith({ position: held.actor.position, radius: 4096, name: 'copper-stromatolite', limit: 64 })
  })

  it('requires a live navigation target and validates radius and actor before scanning', () => {
    ;(globalThis as any).prototypes.entity['tree-01'] = { type: 'tree' }
    const target = { valid: true, name: 'tree-01' }
    const scan = vi.fn(() => [target])
    ;(held.actor as any).surface.find_entities_filtered = scan
    expect(preflight('walk_to_entity', { entity_name: 'tree-01', search_radius: 8 }))
      .toMatchObject({ ok: true, navigation_search: { radius: 8, target_present: true } })
    target.valid = false
    expect(preflight('walk_to_entity', { entity_name: 'tree-01', search_radius: 8 })).toMatchObject({ ok: false, code: 'navigation_target_not_found' })
    scan.mockClear()
    for (const radius of [undefined, 0, 4097, 1.5, Number.NaN, Infinity]) {
      expect(preflight('walk_to_entity', { entity_name: 'tree-01', search_radius: radius })).toMatchObject({ ok: false, code: 'invalid_navigation_search_radius' })
    }
    ;(held.actor as any).is_valid = false
    expect(preflight('walk_to_entity', { entity_name: 'tree-01', search_radius: 8 })).toMatchObject({ ok: false, code: 'no_actor' })
    expect(scan).not.toHaveBeenCalled()
  })

  it('refuses a known resource with no live source inside the exact gather radius', () => {
    ;(globalThis as any).prototypes.entity['copper-ore'] = { type: 'resource' }
    ;(held.actor as any).position = { x: 25, y: -46 }
    const scan = vi.fn(() => [])
    ;(held.actor as any).surface.find_entities_filtered = scan
    expect(preflight('gather_resource', { resource_name: 'copper-ore', count: 75, search_radius: 8 }))
      .toMatchObject({ ok: false, code: 'resource_source_not_found', identity: 'copper-ore', search_radius: 8 })
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ position: held.actor.position, radius: 8, name: 'copper-ore', type: 'resource' }))
  })

  it('admits a live resource source and rejects depleted sources and invalid gather radius', () => {
    ;(globalThis as any).prototypes.entity['copper-ore'] = { type: 'resource' }
    const source = { valid: true, name: 'copper-ore', amount: 75, position: { x: 1.5, y: 2.5 } }
    const scan = vi.fn(() => [source])
    ;(held.actor as any).surface.find_entities_filtered = scan
    expect(preflight('gather_resource', { resource_name: 'copper-ore', count: 75, search_radius: 8 }))
      .toMatchObject({ ok: true, resource_search: { radius: 8, position: source.position, amount: 75 } })
    source.amount = 0
    expect(preflight('gather_resource', { resource_name: 'copper-ore', search_radius: 8 })).toMatchObject({ ok: false, code: 'resource_source_not_found' })
    scan.mockClear()
    expect(preflight('gather_resource', { resource_name: 'copper-ore', search_radius: 0 })).toMatchObject({ ok: false, code: 'invalid_resource_search_radius' })
    expect(scan).not.toHaveBeenCalled()
  })

  it('refuses exact mining beyond a finite tile amount before dispatch and reports the observed limit', () => {
    ;(globalThis as any).prototypes.entity['iron-ore'] = { type: 'resource', infinite_resource: false }
    const source = { valid: true, name: 'iron-ore', amount: 40, position: { x: -23.5, y: -68.5 } }
    const scan = vi.fn(() => [source])
    ;(held.actor as any).surface.find_entities_filtered = scan
    const args = { resource_name: 'iron-ore', x: -23.5, y: -68.5, count: 50 }
    expect(preflight('mine_resource_at', args)).toMatchObject({ ok: false, code: 'resource_source_insufficient',
      resource_target: { amount: 40, requested_count: 50, position: source.position, infinite: false } })
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ position: source.position, radius: 0.25, limit: 1, type: 'resource' }))
    expect(preflight('mine_resource_at', { ...args, count: 40 })).toMatchObject({ ok: true, resource_target: { amount: 40 } })
    ;(globalThis as any).prototypes.entity['iron-ore'].infinite_resource = true
    expect(preflight('mine_resource_at', args)).toMatchObject({ ok: true, resource_target: { infinite: true } })
  })

  it('refuses missing or depleted exact sources and malformed coordinates or counts', () => {
    ;(globalThis as any).prototypes.entity['iron-ore'] = { type: 'resource' }
    const source = { valid: true, amount: 0, position: { x: 1.5, y: 2.5 } }
    const scan = vi.fn(() => [source])
    ;(held.actor as any).surface.find_entities_filtered = scan
    const args = { resource_name: 'iron-ore', x: 1.5, y: 2.5, count: 1 }
    expect(preflight('mine_resource_at', args)).toMatchObject({ ok: false, code: 'resource_source_not_found' })
    scan.mockReturnValue([])
    expect(preflight('mine_resource_at', args)).toMatchObject({ ok: false, code: 'resource_source_not_found' })
    scan.mockClear()
    expect(preflight('mine_resource_at', { ...args, x: Number.NaN })).toMatchObject({ ok: false, code: 'invalid_resource_position' })
    expect(preflight('mine_resource_at', { ...args, y: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, code: 'invalid_resource_position' })
    expect(preflight('mine_resource_at', { ...args, count: 0 })).toMatchObject({ ok: false, code: 'invalid_resource_count' })
    expect(preflight('mine_resource_at', { ...args, count: 1.5 })).toMatchObject({ ok: false, code: 'invalid_resource_count' })
    expect(scan).not.toHaveBeenCalled()
  })

  it('offers only a bounded same-resource same-surface correction while retaining the exact-location refusal', () => {
    ;(globalThis as any).prototypes.entity.coal = { type: 'resource' }
    const surface = held.actor.surface
    const sources = [
      { valid: true, name: 'coal', type: 'resource', surface, amount: 100, position: { x: 4, y: 0 } },
      { valid: true, name: 'coal', type: 'resource', surface, amount: 100, position: { x: 3, y: 0 } },
      { valid: true, name: 'coal', type: 'resource', surface, amount: 100, position: { x: 6, y: 0 } },
      { valid: true, name: 'coal', type: 'resource', surface: { index: surface.index + 1 }, amount: 100, position: { x: 1, y: 0 } },
      { valid: true, name: 'copper-ore', type: 'resource', surface, amount: 100, position: { x: 1, y: 0 } },
    ]
    ;(surface as any).find_entities_filtered = vi.fn((query: any) => query.radius === 0.25 ? [] : sources)
    expect(preflight('mine_resource_at', { resource_name: 'coal', x: 0, y: 0, count: 10 })).toMatchObject({
      ok: false, code: 'resource_source_not_found', resource_correction: { resource_name: 'coal', position: { x: 3, y: 0 }, radius: 5, surface_index: surface.index },
    })
  })

  it('keeps the exact-target identity fields on accepted transfers and adds the counts', () => {
    current_target = exact(15)

    const result = preflight('supply_entity', { unit_number: 15, items: [{ item_name: 'iron-ore', count: 20 }] })

    expect(result.ok).toBe(true)
    expect(result).toMatchObject({ operation: 'supply_entity', field: 'unit_number', identity: 15 })
    expect(result.target).toMatchObject({ unit_number: 15, name: 'stone-furnace', surface_index: 1, force_index: 1 })
    expect(result.transfer.items[0]).toMatchObject({ item_name: 'iron-ore', source_count: 50, expected_moved: 20, status: 'ok' })
  })

  it('rejects supply_missing with the exact target and the counts', () => {
    current_target = exact(15)

    const result = preflight('supply_entity', { unit_number: 15, items: [{ item_name: 'coal', count: 5 }] })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ code: 'supply_missing', operation: 'supply_entity', identity: 15 })
    expect(result.target.unit_number).toBe(15)
    expect(result.transfer.items[0]).toMatchObject({ item_name: 'coal', source_count: 0, requested: 5, missing: 5 })
  })

  it('rejects the live mixed supply even when its preceding ore transfer could move', () => {
    current_target = exact(15)
    const result = preflight('supply_entity', { unit_number: 15, items: [
      { item_name: 'iron-ore', count: 41 }, { item_name: 'coal', count: 38 },
    ] })
    expect(result).toMatchObject({ ok: false, code: 'supply_missing', target: { unit_number: 15 } })
    expect(result.transfer.items[0]).toMatchObject({ source_count: 50, expected_moved: 41, status: 'ok' })
    expect(result.transfer.items[1]).toMatchObject({ source_count: 0, expected_moved: 0, status: 'supply_missing' })
  })

  it('rejects an unknown item name as the model-correctable unknown_prototype for supply_entity and move_items_exact', () => {
    current_target = exact(15)
    const inventory_calls = (held.main.get_item_count as any).mock.calls.length

    const supply = preflight('supply_entity', { unit_number: 15, items: [{ item_name: 'colal', count: 5 }] })
    const move = preflight('move_items_exact', { item_name: 'iron-oar', unit_number: 15, max_count: 5, to_entity: false })

    expect(supply).toMatchObject({ ok: false, code: 'unknown_prototype', field: 'item_name', identity: 'colal', expected_type: 'item', operation: 'supply_entity' })
    expect(move).toMatchObject({ ok: false, code: 'unknown_prototype', field: 'item_name', identity: 'iron-oar', expected_type: 'item', operation: 'move_items_exact' })
    expect((held.main.get_item_count as any).mock.calls.length).toBe(inventory_calls)
  })

  it('does not apply the transfer facts to other exact operations, and stale targets still reject first', () => {
    current_target = exact(15)
    expect(preflight('rotate_entity', { unit_number: 15 })).toMatchObject({ ok: true, field: 'unit_number' })
    expect(preflight('rotate_entity', { unit_number: 15 }).transfer).toBeUndefined()

    current_target = undefined
    expect(preflight('move_items_exact', { item_name: 'coal', unit_number: 99, max_count: 5, to_entity: true })).toMatchObject({ ok: false, code: 'stale_exact_target' })
  })

  it('refuses harvest_product with a named code unless a current unowned natural source exists in the radius', () => {
    ;(globalThis as any).prototypes.item.stone = {}
    ;(globalThis as any).prototypes.item['stone-furnace'] = {}
    const prototype = { type: 'simple-entity', is_building: false, mineable_properties: {
      minable: true, products: [{ type: 'item', name: 'stone', amount: 20 }],
    } }
    ;(globalThis as any).prototypes.entity['fixture-rock'] = prototype
    ;(globalThis as any).prototypes.entity['stone-furnace'] = { type: 'furnace', is_building: true, mineable_properties: {
      minable: true, products: [{ type: 'item', name: 'stone-furnace', amount: 1 }],
    } }
    ;(held.actor as any).position = { x: 0, y: 0 }
    const scan = vi.fn((): any[] => [])
    ;(held.actor as any).surface.find_entities_filtered = scan
    expect(preflight('harvest_product', { product_name: 'stone', search_radius: 64 }))
      .toMatchObject({ ok: false, code: 'natural_harvest_source_not_found', operation: 'harvest_product', search_radius: 64 })
    expect(scan.mock.calls.map((call: any[]) => call[0].radius)).toEqual([8, 16, 32, 64])
    const source: any = { valid: true, name: 'fixture-rock', type: 'simple-entity', prototype,
      force: { name: 'neutral' }, position: { x: 1, y: 0 } }
    scan.mockReturnValue([source])
    expect(preflight('harvest_product', { product_name: 'stone', search_radius: 64 }))
      .toMatchObject({ ok: true, source_search: { radius: 64, target_present: true },
        natural_source: { name: 'fixture-rock', position: source.position } })
    source.last_user = { index: 1 }
    expect(preflight('harvest_product', { product_name: 'stone', search_radius: 64 }))
      .toMatchObject({ ok: false, code: 'natural_harvest_source_not_found' })
    scan.mockClear()
    // A built entity that yields the product when mined is never a harvest source.
    expect(preflight('harvest_product', { product_name: 'stone-furnace', search_radius: 64 }))
      .toMatchObject({ ok: false, code: 'no_natural_harvest_source', operation: 'harvest_product' })
    expect(preflight('harvest_product', { product_name: 'not-an-item', search_radius: 64 }))
      .toMatchObject({ ok: false, code: 'unknown_prototype' })
    for (const search_radius of [0, 4097, 1.5, Number.NaN, Infinity]) {
      expect(preflight('harvest_product', { product_name: 'stone', search_radius }))
        .toMatchObject({ ok: false, code: 'invalid_harvest_search_radius' })
    }
    expect(scan).not.toHaveBeenCalled()
  })

  it('declares a refusal_class on every refused result at the interface and never on an accepted one', () => {
    expect(preflight('harvest_product', { product_name: 'not-an-item' })).toMatchObject({ ok: false, code: 'unknown_prototype', refusal_class: 'argument' })
    expect(preflight('harvest_product', { product_name: 'stone', search_radius: 0 })).toMatchObject({ ok: false, code: 'invalid_harvest_search_radius', refusal_class: 'argument' })
    expect(preflight('move_items_with_player', { player_name: '' })).toMatchObject({ ok: false, code: 'player_unavailable', refusal_class: 'world' })
    expect(preflight('research_technology', { technology_name: 42 })).toMatchObject({ ok: false, code: 'invalid_name', refusal_class: 'argument' })
    expect(preflight('craft_item', { item_name: 42 })).toMatchObject({ ok: false, code: 'unknown_recipe', refusal_class: 'argument' })
    expect(preflight('walk_to_position', null as any)).toMatchObject({ ok: false, code: 'invalid_preflight_args', refusal_class: 'argument' })
    expect(preflight('rotate_entity', { unit_number: 'x' })).toMatchObject({ ok: false, code: 'invalid_unit_number', refusal_class: 'argument' })
    const target: any = exact(15)
    target.type = 'furnace'
    current_target = target
    expect(preflight('set_machine_recipe', { unit_number: 15, recipe_name: 'iron-plate' }))
      .toMatchObject({ ok: false, code: 'not_recipe_machine', refusal_class: 'argument' })
    current_target = undefined
    expect(preflight('unlisted_operation', {})).not.toHaveProperty('refusal_class')
  })
})
