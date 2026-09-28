import type { ControlledActor } from './actors/types'
import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { remember_entity_reference } from './entity_reference'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function inventory(initial: Record<string, number> = {}) {
  const counts = { ...initial }
  const api = {
    counts,
    find_item_stack: vi.fn((name: string) => {
      const count = counts[name] ?? 0
      return count > 0 ? [{ name, count }, 1] : [undefined, undefined]
    }),
    get_item_count: vi.fn((name: string) => counts[name] ?? 0),
    can_insert: vi.fn(() => true),
    insert: vi.fn(({ name, count }: { name: string, count: number }) => {
      counts[name] = (counts[name] ?? 0) + count
      return count
    }),
    remove: vi.fn(({ name, count }: { name: string, count: number }) => {
      const available = counts[name] ?? 0
      const removed = Math.min(available, count)
      counts[name] = available - removed
      return removed
    }),
    index: 1,
    name: 'chest',
    length: 16,
    count_empty_stacks: vi.fn(() => 16 - Object.values(counts).filter(count => count > 0).length),
    get_contents: vi.fn(() => Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
  }
  return api as unknown as LuaInventory & { counts: Record<string, number> }
}

function entity(unit_number: number, targetInventory: LuaInventory, overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    name: 'gun-turret',
    type: 'ammo-turret',
    unit_number,
    position: { x: 2, y: 0 },
    surface: { index: 1 },
    force: { index: 1 },
    get_max_inventory_index: vi.fn(() => 1),
    get_inventory: vi.fn(() => targetInventory),
    get_output_inventory: vi.fn(() => undefined),
    get_fuel_inventory: vi.fn(() => undefined),
    get_burnt_result_inventory: vi.fn(() => undefined),
    ...overrides,
  } as unknown as LuaEntity
}

function context() {
  const actorInventory = inventory({ 'firearm-magazine': 20 })
  const findEntities = vi.fn(() => [])
  const surface = {
    index: 1,
    find_entities_filtered: findEntities,
  }
  const actor = {
    is_valid: true,
    character: { valid: true },
    force: { index: 1 },
    position: { x: 0, y: 0 },
    surface,
    get_main_inventory: vi.fn(() => actorInventory),
    status_snapshot: vi.fn(() => ({
      actor_id: 18,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'Nova-1',
      position: { x: 0, y: 0 },
    })),
  } as unknown as ControlledActor
  const resolve = vi.fn(() => actor)
  const manager = new_task_manager(resolve)
  const controller = new_basic_operation_controller(resolve, manager)
  const runtime = new_basic_operation_runtime(manager, controller)
  return { actor, actorInventory, findEntities, manager, controller, runtime }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).game.get_entity_by_unit_number = () => undefined
})

describe('exact entity item transfers', () => {
  it('loads only the requested unit number and never scans same-name neighbors', () => {
    const c = context()
    const selectedInventory = inventory()
    const distractorInventory = inventory()
    const selected = entity(101, selectedInventory)
    const distractor = entity(202, distractorInventory)
    c.findEntities.mockReturnValue([distractor] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn((unit: number) => unit === 101 ? selected : distractor)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 7, true)).toEqual([true, 'Task started'])
    expect(c.runtime.state_moving_items(c.actor)).toBe(7)

    expect(selectedInventory.counts['firearm-magazine']).toBe(7)
    expect(distractorInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['firearm-magazine']).toBe(13)
    expect(c.findEntities).not.toHaveBeenCalled()
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      moved_count: 7,
      target_unit_number: 101,
    })
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('uses the actor current reach instead of a hard-coded eight-tile transfer limit', () => {
    const c = context()
    ;(c.actor.character as any).reach_distance = 10
    const selectedInventory = inventory()
    const selected = entity(101, selectedInventory, { position: { x: 9, y: 0 } })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => selected)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 5, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(5)

    expect(selectedInventory.counts['firearm-magazine']).toBe(5)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      moved_count: 5,
      target_unit_number: 101,
    })
  })

  it('fails closed when the observed unit is gone and only a replacement remains at the hint location', () => {
    const c = context()
    const selectedInventory = inventory()
    const distractorInventory = inventory()
    const selected = entity(101, selectedInventory)
    const replacement = entity(202, distractorInventory, { position: selected.position })
    remember_entity_reference(selected)
    c.findEntities.mockReturnValue([replacement] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => undefined)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 7, true)).toEqual([true, 'Task started'])
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)

    expect(c.findEntities).toHaveBeenCalled()
    expect(selectedInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(distractorInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'target_gone',
      completed: false,
      target_unit_number: 101,
    })
  })

  it.each([
    ['target_gone', undefined],
    ['different_surface', entity(101, inventory(), { surface: { index: 2 } })],
    ['wrong_force', entity(101, inventory(), { force: { index: 2 } })],
    ['too_far', entity(101, inventory(), { position: { x: 9, y: 0 } })],
  ])('fails closed with %s and never falls back to another entity', (expectedCode, selected) => {
    const c = context()
    const fallbackInventory = inventory()
    const fallback = entity(202, fallbackInventory)
    c.findEntities.mockReturnValue([fallback] as any)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => selected)

    expect(c.controller.submit_move_exact('firearm-magazine', 101, 5, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)

    expect(c.controller.status().last_result).toMatchObject({
      code: expectedCode,
      accepted: false,
      target_unit_number: 101,
    })
    expect(fallbackInventory.counts['firearm-magazine'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['firearm-magazine']).toBe(20)
    expect(c.findEntities).not.toHaveBeenCalled()
    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
  })

  it('moves more than one stack when the NPC holds several stacks of the item', () => {
    const c = context()
    c.actorInventory.counts['iron-plate'] = 250
    // A real find_item_stack returns one stack (100 plates); the transfer must
    // not be capped by it.
    ;(c.actorInventory.find_item_stack as any).mockImplementation((name: string) =>
      (c.actorInventory.counts[name] ?? 0) > 0 ? [{ name, count: Math.min(100, c.actorInventory.counts[name]) }, 1] : [undefined, undefined])
    const targetInventory = inventory()
    const target = entity(101, targetInventory, { name: 'wooden-chest', type: 'container' })
    remember_entity_reference(target)
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => target)

    expect(c.controller.submit_move_exact('iron-plate', 101, 200, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(200)

    expect(targetInventory.counts['iron-plate']).toBe(200)
    expect(c.actorInventory.counts['iron-plate']).toBe(50)
    expect(c.controller.status().last_result).toMatchObject({ code: 'completed', moved_count: 200 })
  })
})

// Steam-power run 2026-09-26 (item 1.6): a supply batch to three furnaces
// failed on its first move with a bare nothing_moved and cancelled all six
// moves. The engine lane (tests/factorio/runner/furnace_supply_refusal.py)
// showed Factorio 2.0.77 accepts a script insert of ore into a furnace's
// crafter_output slot, so the old "every inventory that can_insert" loop
// overflowed ore into the result slot and later refused everything.
const STACK = 50

function slotInventory(options: { index: number, name: string, slots?: number, accepts?: (item: string) => boolean, initial?: Record<string, number> }) {
  const slots = options.slots ?? 1
  const accepts = options.accepts ?? (() => true)
  const counts: Record<string, number> = { ...(options.initial ?? {}) }
  const used = () => Object.values(counts).reduce((total, count) => total + Math.ceil(count / STACK), 0)
  const room = (item: string) => {
    if (!accepts(item)) return 0
    const held = counts[item] ?? 0
    const partial = held % STACK === 0 ? 0 : STACK - (held % STACK)
    return partial + Math.max(0, slots - used()) * STACK
  }
  return {
    index: options.index,
    name: options.name,
    length: slots,
    counts,
    can_insert: vi.fn(({ name }: { name: string }) => room(name) > 0),
    insert: vi.fn(({ name, count }: { name: string, count: number }) => {
      const moved = Math.min(count, room(name))
      if (moved > 0) counts[name] = (counts[name] ?? 0) + moved
      return moved
    }),
    remove: vi.fn(({ name, count }: { name: string, count: number }) => {
      const removed = Math.min(counts[name] ?? 0, count)
      counts[name] = (counts[name] ?? 0) - removed
      return removed
    }),
    get_item_count: vi.fn((name: string) => counts[name] ?? 0),
    get_contents: vi.fn(() => Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, quality: 'normal', count }))),
    count_empty_stacks: vi.fn(() => Math.max(0, slots - used())),
  }
}

type SlotInventory = ReturnType<typeof slotInventory>

// Factorio 2.0 stone furnace: fuel(1), crafter_input(2), crafter_output(3),
// crafter_modules(4, no slots), burnt_result(6, no slots). The output slot
// accepts any item from a script insert, as the real engine does.
function furnace(unit_number: number, initial: { source?: Record<string, number>, fuel?: Record<string, number> } = {}) {
  const fuel = slotInventory({ index: 1, name: 'fuel', accepts: item => item === 'coal', initial: initial.fuel })
  const input = slotInventory({ index: 2, name: 'crafter_input', accepts: item => item === 'iron-ore' || item === 'copper-ore', initial: initial.source })
  const output = slotInventory({ index: 3, name: 'crafter_output' })
  const modules = slotInventory({ index: 4, name: 'crafter_modules', slots: 0, accepts: () => false })
  const burnt = slotInventory({ index: 6, name: 'burnt_result', slots: 0, accepts: () => false })
  const inventories: Record<number, SlotInventory> = { 1: fuel, 2: input, 3: output, 4: modules, 6: burnt }
  const entity = {
    valid: true,
    name: 'stone-furnace',
    type: 'furnace',
    unit_number,
    position: { x: 2, y: unit_number % 5 },
    surface: { index: 1 },
    force: { index: 1 },
    get_max_inventory_index: vi.fn(() => 8),
    get_inventory: vi.fn((index: number) => inventories[index]),
    get_output_inventory: vi.fn(() => output),
    get_fuel_inventory: vi.fn(() => fuel),
    get_burnt_result_inventory: vi.fn(() => burnt),
  } as unknown as LuaEntity
  return { entity, fuel, input, output }
}

describe('to-entity item moves into furnaces (item 1.6)', () => {
  let savedLog: unknown
  let savedPrint: unknown
  let logSpy: ReturnType<typeof vi.fn>
  let printSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    savedLog = (globalThis as any).log
    savedPrint = (globalThis as any).game.print
    logSpy = vi.fn()
    printSpy = vi.fn()
    ;(globalThis as any).log = logSpy
    ;(globalThis as any).game.print = printSpy
    ;(globalThis as any).prototypes.item.coal = { fuel_value: 4000000 }
    ;(globalThis as any).prototypes.item['iron-ore'] = { fuel_value: 0 }
    ;(globalThis as any).prototypes.item['copper-ore'] = { fuel_value: 0 }
  })

  afterEach(() => {
    ;(globalThis as any).log = savedLog
    ;(globalThis as any).game.print = savedPrint
    delete (globalThis as any).prototypes.item.coal
    delete (globalThis as any).prototypes.item['iron-ore']
    delete (globalThis as any).prototypes.item['copper-ore']
  })

  function furnaceContext(held: Record<string, number>, furnaces: Array<ReturnType<typeof furnace>>) {
    const c = context()
    for (const [name, count] of Object.entries(held)) c.actorInventory.counts[name] = count
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn((unit: number) =>
      furnaces.find(target => (target.entity as any).unit_number === unit)?.entity)
    return c
  }

  function drain(c: ReturnType<typeof context>, limit = 20) {
    for (let i = 0; i < limit && c.manager.player_state.task_state !== TaskStates.IDLE; i++) {
      c.runtime.state_moving_items(c.actor)
    }
  }

  it('never inserts ore into the furnace result slot, even when asked for more than the source holds', () => {
    const target = furnace(55)
    const c = furnaceContext({ 'iron-ore': 180 }, [target])

    expect(c.controller.submit_move_exact('iron-ore', 55, 180, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(STACK)

    expect(target.input.counts['iron-ore']).toBe(STACK)
    expect(target.output.counts['iron-ore'] ?? 0).toBe(0)
    expect(target.output.insert).not.toHaveBeenCalled()
    expect(c.actorInventory.counts['iron-ore']).toBe(180 - STACK)
    expect(c.controller.status().last_result).toMatchObject({
      code: 'completed',
      completed: true,
      moved_count: STACK,
      requested_count: 180,
      held_count: 180,
    })
  })

  it('names the cause, held count and slot contents when a foreign item fills the source slot', () => {
    const target = furnace(57, { source: { 'copper-ore': STACK } })
    const c = furnaceContext({ 'iron-ore': 95 }, [target])

    expect(c.controller.submit_move_exact('iron-ore', 57, 95, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)

    expect(target.output.counts['iron-ore'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['iron-ore']).toBe(95)
    const result = c.controller.status().last_result!
    expect(result).toMatchObject({
      type: TaskStates.MOVING_ITEMS,
      accepted: false,
      completed: false,
      code: 'nothing_moved',
      moved_count: 0,
      requested_count: 95,
      held_count: 95,
      target_unit_number: 57,
      item_name: 'iron-ore',
      refusal_cause: 'input_slot_holds_other_item',
      refusal_tick: 100,
      batch_refused_count: 1,
    })
    const input = result.target_inventories!.find(inventory => inventory.name === 'crafter_input')
    expect(input).toEqual({
      unit_number: 57,
      index: 2,
      name: 'crafter_input',
      role: 'input',
      slot_count: 1,
      empty_slots: 0,
      can_insert: false,
      contents: [{ name: 'copper-ore', quality: 'normal', count: STACK }],
    })
    expect(result.target_inventories!.find(inventory => inventory.name === 'crafter_output')).toMatchObject({ role: 'output', can_insert: false })
    expect(result.target_inventories!.find(inventory => inventory.name === 'fuel')).toMatchObject({ role: 'fuel' })

    const batch = c.manager.get_status_snapshot().last_cancelled_batch
    expect(batch).toMatchObject({
      outcome: 'refused',
      task_count: 1,
      refused_count: 1,
      completed_count: 0,
      reason: 'moving_items:nothing_moved:input_slot_holds_other_item',
      refusals: [{ code: 'nothing_moved', cause: 'input_slot_holds_other_item', item_name: 'iron-ore', target_unit_number: 57, held_count: 95 }],
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\[AUTORIO\] \[ERROR\] moving_items refused: nothing_moved; cause=input_slot_holds_other_item item=iron-ore target=57 held=95 requested=95 slots=fuel\[empty\] crafter_input\[copper-ore x50\]; 1 of 1 operations refused, 0 completed/,
    ))
  })

  it('keeps running independent moves to other furnaces after one refused move and closes the batch as refused', () => {
    const refusing = furnace(55, { source: { 'copper-ore': 10 } })
    const first = furnace(56)
    const second = furnace(57)
    const c = furnaceContext({ 'iron-ore': 60, 'coal': 15 }, [refusing, first, second])

    for (const unit of [55, 56, 57]) {
      expect(c.controller.submit_move_exact('iron-ore', unit, 20, true)[0]).toBe(true)
      expect(c.controller.submit_move_exact('coal', unit, 5, true)[0]).toBe(true)
    }
    ;(globalThis as any).game.tick = 100
    drain(c)

    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(first.input.counts['iron-ore']).toBe(20)
    expect(second.input.counts['iron-ore']).toBe(20)
    expect(first.fuel.counts.coal).toBe(5)
    expect(second.fuel.counts.coal).toBe(5)
    expect(refusing.fuel.counts.coal).toBe(5)
    expect(refusing.input.counts['iron-ore'] ?? 0).toBe(0)
    expect(refusing.input.counts['copper-ore']).toBe(10)
    for (const target of [refusing, first, second]) expect(target.output.counts['iron-ore'] ?? 0).toBe(0)
    expect(c.actorInventory.counts['iron-ore']).toBe(20)
    expect(c.actorInventory.counts.coal).toBe(0)

    const snapshot = c.manager.get_status_snapshot()
    expect(snapshot.last_completed_batch).toBeUndefined()
    expect(snapshot.last_cancelled_batch).toMatchObject({
      outcome: 'refused',
      task_count: 6,
      refused_count: 1,
      completed_count: 5,
      reason: 'moving_items:nothing_moved:input_slot_holds_other_item',
    })
    expect(snapshot.last_cancelled_batch!.refusals).toHaveLength(1)
    // The failure receipt is published on the batch-close tick so the runtime
    // correlates it with the refused batch rather than the last sibling.
    expect(c.controller.status().last_result).toMatchObject({
      code: 'nothing_moved',
      target_unit_number: 55,
      item_name: 'iron-ore',
      held_count: 60,
      refusal_cause: 'input_slot_holds_other_item',
      tick: snapshot.last_cancelled_batch!.tick,
    })
    const printed = printSpy.mock.calls.map(call => String(call[0]))
    expect(printed.some(line => line.includes('All operations completed'))).toBe(false)
    expect(printed.some(line => line.startsWith('[AUTORIO] Operation batch refused:') && line.includes('refused=1, completed=5'))).toBe(true)
    const logged = logSpy.mock.calls.map(call => String(call[0]))
    // Only the batch close raises the runtime's error signal, never the
    // mid-batch refusal (the runtime would read a half-run batch).
    expect(logged.filter(line => line.includes('[AUTORIO] [ERROR]'))).toHaveLength(1)
    expect(logged.some(line => line.includes('moving_items refused: nothing_moved; cause=input_slot_holds_other_item') && line.includes('independent operations in the batch continue'))).toBe(true)
  })

  it('keeps an earlier refusal on the receipt when a later hard failure cancels the rest', () => {
    const refusing = furnace(55, { source: { 'copper-ore': 10 } })
    const c = furnaceContext({ 'iron-ore': 60 }, [refusing])

    expect(c.controller.submit_move_exact('iron-ore', 55, 20, true)[0]).toBe(true)
    expect(c.controller.submit_move_exact('iron-ore', 99, 20, true)[0]).toBe(true)
    expect(c.controller.submit_wait(60)[0]).toBe(true)
    drain(c, 2)

    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(c.manager.get_status_snapshot().last_cancelled_batch).toMatchObject({
      outcome: 'cancelled',
      task_count: 3,
      refused_count: 1,
      reason: 'moving_items:target_gone',
      refusals: [{ target_unit_number: 55, cause: 'input_slot_holds_other_item' }],
    })
    expect(c.manager.get_status_snapshot().last_cancelled_batch!.completed_count).toBeUndefined()
    expect(c.controller.status().last_result).toMatchObject({ code: 'target_gone', target_unit_number: 99 })
  })

  it.each([
    ['target_full', { source: { 'iron-ore': STACK } }, 'iron-ore'],
    ['target_full', { fuel: { coal: STACK } }, 'coal'],
    ['input_slot_holds_other_item', { fuel: { wood: STACK } }, 'coal'],
  ] as const)('reports %s for %s', (cause, initial, item) => {
    const target = furnace(58, initial as any)
    const c = furnaceContext({ [item]: 10 }, [target])

    expect(c.controller.submit_move_exact(item, 58, 10, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)
    expect(c.controller.status().last_result).toMatchObject({ code: 'nothing_moved', refusal_cause: cause, held_count: 10 })
  })

  it('reports no_input_inventory_for_item when only a fuel slot exists and the item is not fuel', () => {
    const fuel = slotInventory({ index: 1, name: 'fuel', accepts: item => item === 'coal', initial: { coal: 5 } })
    const burnt = slotInventory({ index: 6, name: 'burnt_result', slots: 0, accepts: () => false })
    const boiler = {
      valid: true,
      name: 'boiler',
      type: 'boiler',
      unit_number: 60,
      position: { x: 2, y: 0 },
      surface: { index: 1 },
      force: { index: 1 },
      get_max_inventory_index: vi.fn(() => 6),
      get_inventory: vi.fn((index: number) => (({ 1: fuel, 6: burnt }) as Record<number, SlotInventory>)[index]),
      get_output_inventory: vi.fn(() => undefined),
      get_fuel_inventory: vi.fn(() => fuel),
      get_burnt_result_inventory: vi.fn(() => burnt),
    } as unknown as LuaEntity
    const c = context()
    c.actorInventory.counts['iron-ore'] = 10
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => boiler)

    expect(c.controller.submit_move_exact('iron-ore', 60, 10, true)[0]).toBe(true)
    expect(c.runtime.state_moving_items(c.actor)).toBe(0)
    expect(c.controller.status().last_result).toMatchObject({ code: 'nothing_moved', refusal_cause: 'no_input_inventory_for_item' })
  })

  it('still cancels the batch when taking items from an entity moves nothing', () => {
    const source = furnace(61)
    const c = furnaceContext({}, [source])

    expect(c.controller.submit_move_exact('iron-plate', 61, 5, false)[0]).toBe(true)
    expect(c.controller.submit_wait(60)[0]).toBe(true)
    c.runtime.state_moving_items(c.actor)

    expect(c.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(c.manager.get_status_snapshot().last_cancelled_batch).toMatchObject({ reason: 'moving_items:nothing_moved', task_count: 2 })
    expect(c.manager.get_status_snapshot().last_cancelled_batch!.outcome).toBeUndefined()
  })
})
