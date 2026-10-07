import { beforeEach, describe, expect, it, vi } from 'vitest'

const actor_state: { actor: unknown } = { actor: undefined }

vi.mock('./actors/actor_controller', () => ({
  create_actor_remote_interface: () => {},
  get_controlled_actor: () => actor_state.actor,
}))

vi.mock('./spatial_semantics', () => ({
  compact_spatial_summary: () => undefined,
}))

// Lua tables are both indexable and iterable with pairs(); the TS source
// iterates them with for..of, so the stand-in supports both.
function lua_table<T>(entries: Record<string, T>) {
  return Object.assign(Object.create({
    *[Symbol.iterator]() { yield* Object.entries(entries) },
  }), entries)
}

function force(rockets_launched: number) {
  return {
    index: 1,
    rockets_launched,
    technologies: lua_table({
      'automation': { enabled: true, researched: true },
      'rocket-silo': { enabled: true, researched: false },
    }),
    get_item_production_statistics: () => ({ get_input_count: () => 7 }),
  }
}

async function tools_interface() {
  const interfaces: Record<string, Record<string, (...args: any[]) => any>> = {}
  ;(globalThis as any).remote.add_interface = (name: string, functions: Record<string, (...args: any[]) => any>) => {
    interfaces[name] = functions
  }
  const { create_tools_remote_interface } = await import('./tools')
  create_tools_remote_interface()
  return interfaces.autorio_tools
}

beforeEach(() => {
  actor_state.actor = undefined
  ;(globalThis as any).script.active_mods = { base: '2.0.0' }
  ;(globalThis as any).prototypes = { item: { 'iron-gear-wheel': {} }, space_location: {} }
})

describe('goal conditions while the NPC body is dead', () => {
  it('reads force-level conditions from the player force when there is no live actor', async () => {
    ;(globalThis as any).game.forces = { player: force(2) }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'rockets_launched', minimum: 1 })).toMatchObject({ ok: true, satisfied: true, current: 2 })
    expect(tools.evaluate_condition({ kind: 'research_completed', technology: 'automation' })).toMatchObject({ ok: true, satisfied: true })
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 5 })).toMatchObject({ ok: true, current: 7 })
  })

  it('adds the crafts the NPC finished to the production statistics for items_produced', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    ;(globalThis as any).storage = { sgluna_crafted_items: { 1: { 'iron-gear-wheel': 3, 'pipe': 9 } } }
    const tools = await tools_interface()

    // 7 from machine statistics + 3 hand-crafted; another item's count is not mixed in.
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 10 }))
      .toMatchObject({ ok: true, satisfied: true, current: 10, production_statistics: 7, hand_crafted: 3 })
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 11 }))
      .toMatchObject({ satisfied: false, current: 10 })
    ;(globalThis as any).storage = {}
  })

  it('does not count trigger craft flow twice, including older unmirrored crafts', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    ;(globalThis as any).storage = { sgluna_crafted_items: { 1: { 'iron-gear-wheel': 3 } }, sgluna_craft_trigger_statistics: { 1: { 'iron-gear-wheel': 2 } } }
    const tools = await tools_interface()
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 8 }))
      .toMatchObject({ current: 8, production_statistics: 7, hand_crafted: 3, hand_crafted_in_statistics: 2 })
  })

  it('counts hand crafting alone when the machine statistics are empty (goal baseline still reads the same evaluator)', async () => {
    const empty_force = { ...force(0), get_item_production_statistics: () => ({ get_input_count: () => 0 }) }
    ;(globalThis as any).game.forces = { player: empty_force }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    ;(globalThis as any).storage = { sgluna_crafted_items: { 1: { 'iron-gear-wheel': 1 } } }
    const tools = await tools_interface()

    const baseline = tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 1 })
    expect(baseline).toMatchObject({ satisfied: true, current: 1, hand_crafted: 1, production_statistics: 0 })
    ;(globalThis as any).storage = { sgluna_crafted_items: { 1: { 'iron-gear-wheel': 4 } } }
    expect(tools.evaluate_condition({ kind: 'items_produced', item_name: 'iron-gear-wheel', minimum: 1 }))
      .toMatchObject({ current: 4 })
    ;(globalThis as any).storage = {}
  })

  it('reads world-state goal conditions (plan 3.7) without a body, and passes whether the body is mining', async () => {
    const rate_force = { ...force(0), get_item_production_statistics: () => ({ get_flow_count: () => 12 }) }
    ;(globalThis as any).game.forces = { player: rate_force }
    ;(globalThis as any).game.surfaces = new Map([[1, {}]])
    ;(globalThis as any).defines.flow_precision_index = { one_minute: 1, ten_minutes: 2 }
    ;(globalThis as any).storage = {}
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'production_rate', item_name: 'iron-gear-wheel', per_minute: 10 }))
      .toMatchObject({ ok: true, kind: 'production_rate', satisfied: true, current: 12 })

    // Hand mining in progress on the live body voids the window.
    ;(globalThis as any).storage = { sgluna_hand_work: { 1: { mining_active: { 'iron-gear-wheel': 0 } } } }
    actor_state.actor = { force: rate_force, is_valid: true, get_mining_state: () => ({ mining: true }) }
    expect(tools.evaluate_condition({ kind: 'production_rate', item_name: 'iron-gear-wheel', per_minute: 10 }))
      .toMatchObject({ satisfied: false, void_reason: 'hand_mined' })
    ;(globalThis as any).storage = {}
  })

  it('still needs a body for conditions about the NPC itself', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 1 })).toEqual({ ok: false, error: 'no_actor' })
  })

  it('reports save progress facts without a body', async () => {
    ;(globalThis as any).game.forces = { player: force(1) }
    const tools = await tools_interface()

    expect(tools.goal_progress_facts({ technologies: ['automation', 'rocket-silo', 'not-a-tech'] })).toEqual({
      ok: true,
      rockets_launched: 1,
      researched_technologies: 1,
      enabled_technologies: 2,
      milestones: { 'automation': true, 'rocket-silo': false },
      space_age: false,
    })
  })

  it('prefers the live actor force when there is one', async () => {
    ;(globalThis as any).game.forces = { player: force(0) }
    actor_state.actor = { force: force(5) }
    const tools = await tools_interface()

    expect(tools.evaluate_condition({ kind: 'rockets_launched', minimum: 1 })).toMatchObject({ current: 5 })
  })
})

describe('nearby entity observation', () => {
  function nearby_entity(name: string, type: string, x: number, unit_number?: number) {
    return { valid: true, name, type, unit_number, position: { x, y: 0 }, surface: { index: 1 }, force: { index: 1, name: 'player' } }
  }

  it('keeps buildings ahead of resource tiles, nearest first, and counts every match', async () => {
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 10
    // Engine order puts the ore tiles first; a cap of 3 used to drop both buildings.
    const matches = [
      nearby_entity('iron-ore', 'resource', 1),
      nearby_entity('iron-ore', 'resource', 2),
      nearby_entity('iron-ore', 'resource', 3),
      nearby_entity('stone-furnace', 'furnace', 9, 42),
      nearby_entity('burner-mining-drill', 'mining-drill', 5, 41),
    ]
    const find = vi.fn(() => matches)
    actor_state.actor = { position: { x: 0, y: 0 }, surface: { index: 1, find_entities_filtered: find } }
    const tools = await tools_interface()

    const result = tools.get_nearby_entities(20, undefined, undefined, 3)

    expect(result.entities.map((entity: any) => entity.unit_number ?? entity.name)).toEqual([41, 42, 'iron-ore'])
    expect(result.entities[2].position).toEqual({ x: 1, y: 0 })
    expect(result).toMatchObject({ matched_count: 5, returned_count: 3, truncated: true })
    expect(result.type_counts).toEqual({ 'resource': 3, 'furnace': 1, 'mining-drill': 1 })
    expect((globalThis as any).storage.sgluna_entity_reference_hints[41]).toMatchObject({ name: 'burner-mining-drill' })
  })
})

describe('exact entity status observation', () => {
  function fixture() {
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 12
    ;(globalThis as any).defines.entity_status = { working: 1 }
    const actor_force = { index: 1, name: 'player' }
    const find = vi.fn(() => [] as any[])
    const surface = { index: 1, find_entities_filtered: find }
    actor_state.actor = { position: { x: 0, y: 0 }, surface, force: actor_force }
    const lookup = vi.fn((_unit: number) => undefined as any)
    ;(globalThis as any).game.get_entity_by_unit_number = lookup
    function furnace(unit_number: number, x: number, count: number) {
      return {
        valid: true, name: 'stone-furnace', type: 'furnace', unit_number,
        position: { x, y: 0 }, surface, force: actor_force, status: 1,
        get_max_inventory_index: () => 1,
        get_inventory: () => ({ get_contents: () => [{ name: 'iron-plate', count, quality: 'normal' }] }),
        get_recipe: () => [{ name: 'iron-plate' }, undefined],
      }
    }
    return { surface, actor_force, find, lookup, furnace }
  }

  it('reads the requested same-name furnace and its native inventory and recipe, even when another is nearer', async () => {
    const { find, lookup, furnace } = fixture()
    const near = furnace(41, 2, 1)
    const far = furnace(42, 80, 17)
    find.mockReturnValue([near])
    lookup.mockImplementation(unit => unit === 42 ? far : near)
    const tools = await tools_interface()
    const result = tools.get_entity_status(undefined, undefined, 42)
    expect(result).toMatchObject({ found: true, unit_number: 42, entity: {
      unit_number: 42, position: { x: 80, y: 0 }, recipe: 'iron-plate', working: true,
      inventories: [{ index: 1, items: [{ name: 'iron-plate', count: 17, quality: 'normal' }] }],
    } })
    expect(result.radius).toBeUndefined()
    expect(find).not.toHaveBeenCalled()
    expect((globalThis as any).storage.sgluna_entity_reference_hints[42]).toMatchObject({ surface_index: 1, force_index: 1 })
  })

  it('rejects direct-index entities on another surface or force without a nearest fallback', async () => {
    const { find, lookup, furnace } = fixture()
    const own = furnace(41, 2, 1)
    const foreign_force = { ...furnace(42, 3, 9), force: { index: 2, name: 'enemy' } }
    const foreign_surface = { ...furnace(43, 4, 11), surface: { index: 2 } }
    find.mockReturnValue([own])
    lookup.mockImplementation(unit => unit === 42 ? foreign_force : foreign_surface)
    const tools = await tools_interface()
    for (const unit of [42, 43]) {
      expect(tools.get_entity_status(undefined, undefined, unit)).toMatchObject({ found: false, error: 'exact_entity_not_found', unit_number: unit })
    }
    expect(find).not.toHaveBeenCalled()
  })

  it('resolves a remembered ordinary building but never substitutes its replacement', async () => {
    const { find, lookup, furnace } = fixture()
    const observed = furnace(42, 3, 17)
    find.mockReturnValue([observed])
    const tools = await tools_interface()
    expect(tools.get_entity_status('stone-furnace', 8).entity.unit_number).toBe(42)
    // Ordinary buildings need the persisted lookup hint when the engine index misses.
    expect(tools.get_entity_status(undefined, undefined, 42).entity.unit_number).toBe(42)
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'stone-furnace', radius: 0.25, force: observed.force }))
    find.mockReturnValue([furnace(99, 3, 20)])
    expect(tools.get_entity_status(undefined, undefined, 42)).toMatchObject({ found: false, error: 'exact_entity_not_found', unit_number: 42 })
    expect(lookup).toHaveBeenCalledWith(42)
  })

  it('truthfully rejects unknown identities and invalid or mixed direct arguments', async () => {
    const { find, lookup } = fixture()
    const tools = await tools_interface()
    expect(tools.get_entity_status(undefined, undefined, 404)).toMatchObject({ found: false, error: 'exact_entity_not_found', unit_number: 404 })
    lookup.mockClear()
    for (const args of [
      [undefined, undefined, 0], [undefined, undefined, 1.5], [undefined, undefined, Infinity],
      [undefined, undefined, 9007199254740992], ['stone-furnace', undefined, 42], [undefined, 8, 42],
    ]) expect(tools.get_entity_status(...args)).toMatchObject({ found: false, error: 'invalid_exact_identity' })
    expect(tools.get_entity_status()).toMatchObject({ found: false, error: 'invalid_entity_name' })
    expect(find).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('keeps the legacy nearest-name scan and radius bounds', async () => {
    const { find, lookup, furnace } = fixture()
    find.mockReturnValue([furnace(42, 7, 17), furnace(41, 2, 1)])
    const tools = await tools_interface()
    expect(tools.get_entity_status('stone-furnace').entity.unit_number).toBe(41)
    expect(find).toHaveBeenLastCalledWith({ name: 'stone-furnace', position: { x: 0, y: 0 }, radius: 8 })
    tools.get_entity_status('stone-furnace', 90)
    expect(find).toHaveBeenLastCalledWith(expect.objectContaining({ radius: 32 }))
    expect(lookup).not.toHaveBeenCalled()
  })
})
