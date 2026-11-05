import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { crash_site_setup_status, FREEPLAY_CRASH_SITE_POSITION, spawn_freeplay_crash_site } from './crash_site_setup'

describe('one-time freeplay crash-site setup for a zero-player NPC', () => {
  const originalRemote = (globalThis as any).remote
  const originalPrototypes = (globalThis as any).prototypes
  let freeplay: Record<string, any>
  let calls: [string, string, ...unknown[]][]

  beforeEach(() => {
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 77
    ;(globalThis as any).prototypes = { item: { 'iron-plate': {}, 'wood': {}, 'burner-mining-drill': {}, 'stone-furnace': {}, 'firearm-magazine': {} } }
    freeplay = {
      init_ran: false,
      disable_crashsite: false,
      created_items: { 'iron-plate': 8, 'wood': 1, 'burner-mining-drill': 1, 'stone-furnace': 1, 'firearm-magazine': 10, 'removed-mod-item': 3 },
      ship_items: { 'firearm-magazine': 8 },
      debris_items: { 'iron-plate': 8 },
      ship_parts: [{ name: 'crash-site-spaceship-wreck-big-1' }],
    }
    calls = []
    const functions: Record<string, (...args: any[]) => unknown> = {
      get_init_ran: () => freeplay.init_ran,
      get_disable_crashsite: () => freeplay.disable_crashsite,
      set_disable_crashsite: (value: boolean) => { freeplay.disable_crashsite = value },
      get_created_items: () => freeplay.created_items,
      get_ship_items: () => freeplay.ship_items,
      get_debris_items: () => freeplay.debris_items,
      get_ship_parts: () => freeplay.ship_parts,
    }
    ;(globalThis as any).remote = {
      interfaces: { freeplay: Object.fromEntries(Object.keys(functions).map(name => [name, true])) },
      // A real remote call returns a copy of the callee's table.
      call: (iface: string, name: string, ...args: unknown[]) => { calls.push([iface, name, ...args]); return structuredClone(functions[name](...args)) },
    }
  })
  afterEach(() => {
    ;(globalThis as any).remote = originalRemote
    ;(globalThis as any).prototypes = originalPrototypes
  })

  function fixture() {
    const created: { name: string, position: { x: number, y: number }, unit_number: number, valid: boolean }[] = []
    const surface = { index: 1, find_entities_filtered: vi.fn(() => [...created,
      { name: 'tree-01', position: { x: -3, y: -3 }, unit_number: 9, valid: true }]) }
    const received: unknown[] = []
    const crash_site = {
      create_crash_site: vi.fn((_surface: unknown, position: { x: number, y: number }, ship_items: Record<string, number>, part_items: Record<string, number>, ship_parts: unknown) => {
        received.push(structuredClone([ship_items, part_items, ship_parts]))
        // Like freeplay's module, it consumes the item tables it inserts from.
        for (const items of [ship_items, part_items]) for (const name of Object.keys(items)) delete items[name]
        created.push({ name: 'crash-site-spaceship', position: { ...position }, unit_number: 1, valid: true })
        created.push({ name: 'crash-site-spaceship-wreck-big-1', position: { x: position.x + 4, y: position.y + 2 }, unit_number: 2, valid: true })
      }),
      default_ship_parts: vi.fn(() => []),
    }
    const inventory: Record<string, number> = {}
    const character = { valid: true, insert: vi.fn((stack: { name: string, count: number }) => {
      // The NPC has room for one wood only.
      const inserted = stack.name === 'wood' ? 1 : stack.count
      inventory[stack.name] = (inventory[stack.name] ?? 0) + inserted
      return inserted
    }) }
    const actor = { is_valid: true, character, surface, status_snapshot: () => ({ actor_id: 5 }) } as any
    return { actor, surface, crash_site, inventory, received }
  }

  it('creates freeplay\'s crash site with freeplay\'s items, gives created_items, then disables freeplay\'s own', () => {
    const { actor, crash_site, inventory, received } = fixture()
    const result = spawn_freeplay_crash_site(actor, crash_site) as any
    expect(crash_site.create_crash_site).toHaveBeenCalledTimes(1)
    expect(crash_site.create_crash_site.mock.calls[0].slice(0, 2)).toEqual([actor.surface, FREEPLAY_CRASH_SITE_POSITION])
    expect(received).toEqual([[{ 'firearm-magazine': 8 }, { 'iron-plate': 8 }, [{ name: 'crash-site-spaceship-wreck-big-1' }]]])
    expect(crash_site.default_ship_parts).not.toHaveBeenCalled()
    expect(freeplay.disable_crashsite).toBe(true)
    // Disabling happens after creation, so freeplay never skips the creation itself.
    const order = calls.map(call => call[1])
    expect(order.indexOf('set_disable_crashsite')).toBeGreaterThan(order.indexOf('get_ship_parts'))
    // As freeplay does, the ship and debris items stay in the wrecks: 10 - 8 magazines, 8 - 8 plates. The module consumed
    // the tables it was given, so this subtraction must come from fresh copies (native lane, 2026-11-04: 8 extra plates).
    expect(inventory).toEqual({ 'burner-mining-drill': 1, 'firearm-magazine': 2, 'stone-furnace': 1, 'wood': 1 })
    expect(result).toMatchObject({
      ok: true, already_done: false, tick: 77, actor_id: 5, surface_index: 1, entity_count: 2, freeplay_crash_site_disabled: true,
      entities: [{ name: 'crash-site-spaceship', unit_number: 1 }, { name: 'crash-site-spaceship-wreck-big-1', unit_number: 2 }],
    })
    // An item prototype that no longer exists is skipped rather than inserted.
    expect(result.starter_items.map((item: any) => item.name)).toEqual(['burner-mining-drill', 'firearm-magazine', 'stone-furnace', 'wood'])
  })

  it('is idempotent: a second call reports the first result and creates nothing', () => {
    const { actor, crash_site } = fixture()
    const first = spawn_freeplay_crash_site(actor, crash_site) as any
    const second = spawn_freeplay_crash_site(actor, crash_site) as any
    expect(crash_site.create_crash_site).toHaveBeenCalledTimes(1)
    expect(actor.character.insert).toHaveBeenCalledTimes(4)
    expect(second).toMatchObject({ ok: true, already_done: true, tick: first.tick, entity_count: 2 })
    expect(crash_site_setup_status()).toMatchObject({ ok: true, done: true, entity_count: 2 })
  })

  it('refuses after freeplay already ran its start for a human, or when its crash site is disabled', () => {
    const { actor, crash_site } = fixture()
    freeplay.init_ran = true
    expect(spawn_freeplay_crash_site(actor, crash_site)).toEqual({ ok: false, code: 'freeplay_start_already_ran' })
    freeplay.init_ran = false
    freeplay.disable_crashsite = true
    expect(spawn_freeplay_crash_site(actor, crash_site)).toEqual({ ok: false, code: 'freeplay_crash_site_disabled' })
    expect(crash_site.create_crash_site).not.toHaveBeenCalled()
    expect(actor.character.insert).not.toHaveBeenCalled()
    expect(crash_site_setup_status()).toEqual({ ok: true, done: false })
  })

  it('refuses without freeplay, without the core module, without an actor, or off the freeplay surface', () => {
    const { actor, crash_site } = fixture()
    expect(spawn_freeplay_crash_site(undefined, crash_site)).toEqual({ ok: false, code: 'no_actor' })
    expect(spawn_freeplay_crash_site(actor, undefined)).toEqual({ ok: false, code: 'crash_site_module_unavailable' })
    actor.surface.index = 2
    expect(spawn_freeplay_crash_site(actor, crash_site)).toEqual({ ok: false, code: 'actor_not_on_freeplay_surface' })
    ;(globalThis as any).remote.interfaces.freeplay.get_init_ran = undefined
    expect(spawn_freeplay_crash_site(actor, crash_site)).toEqual({ ok: false, code: 'freeplay_interface_incomplete' })
    ;(globalThis as any).remote.interfaces = {}
    expect(spawn_freeplay_crash_site(actor, crash_site)).toEqual({ ok: false, code: 'freeplay_not_loaded' })
    expect(crash_site.create_crash_site).not.toHaveBeenCalled()
  })
})
