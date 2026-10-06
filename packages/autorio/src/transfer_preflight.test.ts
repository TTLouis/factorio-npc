import type { ControlledActor } from './actors/types'
import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transfer_preflight_facts } from './transfer_preflight'

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
})

describe('transfer preflight facts: supply_entity', () => {
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

  it('rejects the batch when any one item would certainly move nothing, and lists every item', () => {
    const { actor } = actor_with({ 'iron-ore': 50 })
    const target = furnace(15, furnace_parts())

    const facts = transfer_preflight_facts(actor, target, 'supply_entity', {
      unit_number: 15,
      items: [{ item_name: 'iron-ore', count: 50 }, { item_name: 'coal', count: 5 }],
    })!

    expect(facts.code).toBe('supply_missing')
    expect(facts.transfer.items.map(item => item.status)).toEqual(['ok', 'supply_missing'])
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

  it('does not apply the transfer facts to other exact operations, and stale targets still reject first', () => {
    current_target = exact(15)
    expect(preflight('rotate_entity', { unit_number: 15 })).toMatchObject({ ok: true, field: 'unit_number' })
    expect(preflight('rotate_entity', { unit_number: 15 }).transfer).toBeUndefined()

    current_target = undefined
    expect(preflight('move_items_exact', { item_name: 'coal', unit_number: 99, max_count: 5, to_entity: true })).toMatchObject({ ok: false, code: 'stale_exact_target' })
  })
})
