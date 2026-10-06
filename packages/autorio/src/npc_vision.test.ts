import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ControlledActor } from './actors/types'
import { new_awareness_controller } from './awareness'
// control.ts registers the on_init / on_configuration_changed sweeps when imported.
import './control'
import { get_configuration_changed_handler, get_init_handler } from './test-event-registry'
import {
  count_world_entities,
  find_world_entities,
  is_npc_vision_entity,
  new_npc_vision_controller,
  NPC_VISION_ENTITY_NAME,
  without_npc_vision,
} from './npc_vision'

// ---- fakes ----------------------------------------------------------------

let next_unit_number = 100

function make_vision_entity(surface: any, position: { x: number, y: number }) {
  const entity: any = {
    valid: true,
    name: NPC_VISION_ENTITY_NAME,
    unit_number: next_unit_number++,
    surface,
    position: { ...position },
    force: { name: 'player', index: 1 },
    destructible: true,
    minable: true,
    operable: true,
    rotatable: true,
    active: true,
    is_military_target: false,
    teleport: vi.fn((target: { x: number, y: number }, to_surface?: any) => {
      entity.position = { ...target }
      if (to_surface) entity.surface = to_surface
      return true
    }),
    destroy: vi.fn(() => {
      entity.valid = false
      surface.vision_entities = surface.vision_entities.filter((candidate: any) => candidate !== entity)
    }),
  }
  return entity
}

function make_surface(index = 1) {
  const surface: any = {
    index,
    valid: true,
    vision_entities: [] as any[],
    request_to_generate_chunks: vi.fn(),
    get_chunks: vi.fn(() => []),
    find_entities_filtered: vi.fn((filters: any) => {
      if (filters.name === NPC_VISION_ENTITY_NAME) return surface.vision_entities.filter((entity: any) => entity.valid)
      return []
    }),
    create_entity: vi.fn((args: any) => {
      const entity = make_vision_entity(surface, args.position)
      surface.vision_entities.push(entity)
      return entity
    }),
  }
  return surface
}

function make_actor(options: { actor_id?: number, kind?: string, surface?: any, position?: { x: number, y: number } } = {}) {
  const surface = options.surface ?? make_surface()
  const force: any = { index: 1, connected_players: [], chart: vi.fn(), is_chunk_charted: vi.fn(() => false), is_chunk_visible: vi.fn(() => false) }
  const actor: any = {
    position: options.position ?? { x: 40, y: -1 },
    surface,
    force,
    status_snapshot: vi.fn(() => ({
      kind: options.kind ?? 'standalone_character',
      valid: true,
      name: 'SGLuna',
      position: actor.position,
      has_character: true,
      actor_id: options.actor_id ?? 9,
    })),
  }
  return { actor: actor as ControlledActor & { position: { x: number, y: number } }, surface, force }
}

function trace_lines() {
  return ((globalThis as any).log as ReturnType<typeof vi.fn>).mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('npc.vision.'))
}

beforeEach(() => {
  next_unit_number = 100
  ;(globalThis as any).storage = {}
  ;(globalThis as any).log = vi.fn()
  ;(globalThis as any).game.tick = 1
  ;(globalThis as any).game.surfaces = {}
})

function register_surfaces(...surfaces: any[]) {
  ;(globalThis as any).game.surfaces = Object.fromEntries(surfaces.map(surface => [surface.index, surface]))
}

// ---- lifecycle ------------------------------------------------------------

describe('NPC vision vehicle lifecycle', () => {
  it('creates exactly one vehicle for the standalone NPC, built without any world effect', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const vision = new_npc_vision_controller()

    vision.tick(actor, actor.status_snapshot(), true)
    vision.tick(actor, actor.status_snapshot(), false)
    vision.tick(actor, actor.status_snapshot(), true)

    expect(surface.create_entity).toHaveBeenCalledTimes(1)
    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'sgluna-npc-vision',
      position: { x: 40, y: -1 },
      force: actor.force,
      raise_built: false,
      create_build_effect_smoke: false,
      spawn_decorations: false,
      move_stuck_players: false,
      preserve_ghosts_and_corpses: true,
    })
    expect(surface.vision_entities).toHaveLength(1)
    expect(trace_lines().filter((line: string) => line.includes('npc.vision.created'))).toEqual([
      '[AUTORIO] npc.vision.created actor_id=9 unit_number=100 surface_index=1 x=40 y=-1 reason=no_vehicle',
    ])
  })

  it('switches off every way of touching it', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    new_npc_vision_controller().tick(actor, actor.status_snapshot(), true)

    const entity = surface.vision_entities[0]
    expect(entity.destructible).toBe(false)
    expect(entity.minable).toBe(false)
    expect(entity.operable).toBe(false)
    expect(entity.rotatable).toBe(false)
    expect(entity.is_military_target).toBe(false)
  })

  it('follows the NPC when it changes chunk and corrects a stale position on a timer', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)
    const entity = surface.vision_entities[0]

    // Same chunk, off the correction tick: nothing moves.
    ;(globalThis as any).game.tick = 7
    actor.position = { x: 45, y: -1 }
    vision.tick(actor, actor.status_snapshot(), false)
    expect(entity.teleport).not.toHaveBeenCalled()

    // New chunk: it follows immediately, without raising a teleported event.
    actor.position = { x: 40 + 32 * 3, y: -1 }
    vision.tick(actor, actor.status_snapshot(), true)
    expect(entity.teleport).toHaveBeenCalledTimes(1)
    expect(entity.teleport).toHaveBeenLastCalledWith({ x: 136, y: -1 }, surface, false, false)

    // Same chunk again: the periodic correction catches up.
    ;(globalThis as any).game.tick = 120
    actor.position = { x: 140, y: -2 }
    vision.tick(actor, actor.status_snapshot(), false)
    expect(entity.teleport).toHaveBeenCalledTimes(2)
    expect(entity.position).toEqual({ x: 140, y: -2 })

    // Already on the NPC: the correction does nothing.
    ;(globalThis as any).game.tick = 180
    vision.tick(actor, actor.status_snapshot(), false)
    expect(entity.teleport).toHaveBeenCalledTimes(2)
    expect(surface.vision_entities).toHaveLength(1)
  })

  it('recreates the vehicle after it was removed, and traces why', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)
    const removed = surface.vision_entities[0]
    removed.valid = false
    surface.vision_entities = []

    vision.tick(actor, actor.status_snapshot(), false)

    expect(surface.vision_entities).toHaveLength(1)
    expect(surface.vision_entities[0]).not.toBe(removed)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.destroyed actor_id=9 unit_number=100 reason=entity_invalid entity_valid=false')
    expect(trace_lines().filter((line: string) => line.includes('npc.vision.created'))).toHaveLength(2)
  })

  it('destroys the old vehicle when the actor is replaced and recreates it only for the new actor', () => {
    const first = make_actor({ actor_id: 9 })
    register_surfaces(first.surface)
    const vision = new_npc_vision_controller()
    vision.tick(first.actor, first.actor.status_snapshot(), true)
    const old_entity = first.surface.vision_entities[0]

    const replacement = make_actor({ actor_id: 12, surface: first.surface, position: { x: 0, y: 0 } })
    vision.tick(replacement.actor, replacement.actor.status_snapshot(), true)

    expect(old_entity.destroy).toHaveBeenCalledWith({ raise_destroy: false })
    expect(first.surface.vision_entities).toHaveLength(1)
    expect(first.surface.vision_entities[0]).not.toBe(old_entity)
    const lines = trace_lines()
    expect(lines).toContain('[AUTORIO] npc.vision.destroyed actor_id=9 unit_number=100 reason=actor_replaced entity_valid=true')
    expect(lines).toContain('[AUTORIO] npc.vision.created actor_id=12 unit_number=101 surface_index=1 x=0 y=0 reason=no_vehicle')
    // The stale actor can never get a vehicle back: its record is gone.
    expect(vision.status()).toMatchObject({ present: true, actor_id: 12 })
  })

  it('destroys the vehicle when there is no NPC to follow', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)

    expect(vision.release('no_controlled_actor')).toBe(true)
    expect(surface.vision_entities).toHaveLength(0)
    expect(vision.release('no_controlled_actor')).toBe(false)
    expect(vision.status()).toEqual({ present: false, stored: false })
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.destroyed actor_id=9 unit_number=100 reason=no_controlled_actor entity_valid=true')
  })

  it('never gives a connected human actor a vehicle, and drops one left over from NPC mode', () => {
    const npc = make_actor()
    register_surfaces(npc.surface)
    const vision = new_npc_vision_controller()
    vision.tick(npc.actor, npc.actor.status_snapshot(), true)

    const human = make_actor({ kind: 'connected_player', surface: npc.surface })
    vision.tick(human.actor, human.actor.status_snapshot(), true)

    expect(npc.surface.vision_entities).toHaveLength(0)
    expect(npc.surface.create_entity).toHaveBeenCalledTimes(1)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.destroyed actor_id=9 unit_number=100 reason=actor_not_standalone entity_valid=true')
  })

  it('follows the NPC across surfaces, and rebuilds the vehicle if the engine refuses to teleport it', () => {
    const nauvis = make_surface(1)
    const platform = make_surface(2)
    register_surfaces(nauvis, platform)
    const { actor } = make_actor({ surface: nauvis })
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)
    const entity = nauvis.vision_entities[0]

    ;(actor as any).surface = platform
    vision.tick(actor, actor.status_snapshot(), true)
    expect(entity.teleport).toHaveBeenCalledWith({ x: 40, y: -1 }, platform, false, false)
    expect(entity.surface).toBe(platform)
    expect(vision.status()).toMatchObject({ present: true, surface_index: 2 })

    // The engine refuses the next hop: destroy and recreate next to the NPC.
    ;(actor as any).surface = nauvis
    entity.teleport.mockReturnValueOnce(false)
    platform.vision_entities = [entity]
    vision.tick(actor, actor.status_snapshot(), true)
    expect(entity.destroy).toHaveBeenCalled()
    expect(nauvis.vision_entities).toHaveLength(1)
    expect(nauvis.vision_entities[0]).not.toBe(entity)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.destroyed actor_id=9 unit_number=100 reason=surface_teleport_refused entity_valid=true')
  })

  it('backs off after a failed create instead of retrying every tick', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    surface.create_entity.mockReturnValue(undefined)
    const vision = new_npc_vision_controller()

    vision.tick(actor, actor.status_snapshot(), true)
    ;(globalThis as any).game.tick = 50
    vision.tick(actor, actor.status_snapshot(), false)
    expect(surface.create_entity).toHaveBeenCalledTimes(1)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.create_failed actor_id=9 reason=create_entity_returned_nothing trigger=no_vehicle failures=1')

    // Retry once the back-off passed, and succeed.
    ;(globalThis as any).game.tick = 400
    surface.create_entity.mockImplementation((args: any) => {
      const entity = make_vision_entity(surface, args.position)
      surface.vision_entities.push(entity)
      return entity
    })
    vision.tick(actor, actor.status_snapshot(), false)
    expect(surface.create_entity).toHaveBeenCalledTimes(2)
    expect(vision.status()).toMatchObject({ present: true })
  })
})

describe('NPC vision vehicle creation failures', () => {
  afterEach(() => {
    delete (globalThis as any).pcall
  })

  it('treats a create_entity that throws like one that returns nothing, with the same back-off', () => {
    ;(globalThis as any).pcall = (fn: () => unknown) => {
      try { return [true, fn()] }
      catch (error) { return [false, String(error)] }
    }
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    surface.create_entity.mockImplementation(() => { throw new Error('surface refuses the entity') })
    const vision = new_npc_vision_controller()

    vision.tick(actor, actor.status_snapshot(), true)
    ;(globalThis as any).game.tick = 50
    vision.tick(actor, actor.status_snapshot(), false)

    expect(surface.create_entity).toHaveBeenCalledTimes(1)
    expect(vision.status()).toEqual({ present: false, stored: false })
    expect(trace_lines()).toEqual([
      '[AUTORIO] npc.vision.create_failed actor_id=9 reason=create_entity_threw:Error: surface refuses the entity trigger=no_vehicle failures=1',
    ])
    ;(globalThis as any).game.tick = 400
    vision.tick(actor, actor.status_snapshot(), false)
    expect(surface.create_entity).toHaveBeenCalledTimes(2)
  })

  it('logs the first failure and then only every twelfth, and stays quiet while the sweep finds nothing', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    surface.create_entity.mockReturnValue(undefined)
    const vision = new_npc_vision_controller()
    for (let attempt = 0; attempt < 25; attempt++) {
      ;(globalThis as any).game.tick = 1 + attempt * 300
      vision.tick(actor, actor.status_snapshot(), false)
    }

    expect(surface.create_entity).toHaveBeenCalledTimes(25)
    const failed = trace_lines().filter((line: string) => line.includes('create_failed'))
    expect(failed).toHaveLength(3)
    expect(failed[1]).toContain('failures=12')
    expect(failed[2]).toContain('failures=24')
    expect(trace_lines().filter((line: string) => line.includes('npc.vision.swept'))).toEqual([])
  })
})

describe('NPC vision vehicle orphan sweep', () => {
  it('keeps only the vehicle stored for the current actor and destroys every other one', () => {
    const { actor, surface } = make_actor()
    const other_surface = make_surface(2)
    register_surfaces(surface, other_surface)
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)
    const kept = surface.vision_entities[0]
    const orphan_a = make_vision_entity(surface, { x: 5, y: 5 })
    const orphan_b = make_vision_entity(other_surface, { x: 6, y: 6 })
    surface.vision_entities.push(orphan_a)
    other_surface.vision_entities.push(orphan_b)

    expect(vision.sweep(9, 'on_configuration_changed')).toBe(2)

    expect(kept.valid).toBe(true)
    expect(orphan_a.valid).toBe(false)
    expect(orphan_b.valid).toBe(false)
    expect(vision.status()).toMatchObject({ present: true, unit_number: kept.unit_number })
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.swept keep_actor_id=9 kept_unit_number=100 destroyed=2 reason=on_configuration_changed')
  })

  it('destroys everything and forgets the record when the stored vehicle belongs to another actor', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const vision = new_npc_vision_controller()
    vision.tick(actor, actor.status_snapshot(), true)

    expect(vision.sweep(77, 'on_init')).toBe(1)
    expect(surface.vision_entities).toHaveLength(0)
    expect(vision.status()).toEqual({ present: false, stored: false })
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.swept keep_actor_id=77 destroyed=1 reason=on_init')
  })

  it('sweeps a vehicle nothing stores (an old save) before it builds a new one', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const stray = make_vision_entity(surface, { x: 1, y: 1 })
    surface.vision_entities.push(stray)

    new_npc_vision_controller().tick(actor, actor.status_snapshot(), true)

    expect(stray.valid).toBe(false)
    expect(surface.vision_entities).toHaveLength(1)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.swept keep_actor_id=9 destroyed=1 reason=before_create:no_vehicle')
  })

  it('is driven by on_init and on_configuration_changed with the current NPC', () => {
    const surface = make_surface()
    register_surfaces(surface)
    ;(globalThis as any).storage.sgluna_actor_mode = 'player'
    surface.vision_entities.push(make_vision_entity(surface, { x: 3, y: 3 }))

    get_init_handler()()
    expect(surface.vision_entities).toHaveLength(0)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.swept destroyed=1 reason=on_init')

    surface.vision_entities.push(make_vision_entity(surface, { x: 3, y: 3 }))
    get_configuration_changed_handler()()
    expect(surface.vision_entities).toHaveLength(0)
    expect(trace_lines()).toContain('[AUTORIO] npc.vision.swept destroyed=1 reason=on_configuration_changed')
  })
})

describe('awareness drives the vision vehicle', () => {
  it('creates it on the first tick and moves it with the NPC chunk by chunk', () => {
    const { actor, surface } = make_actor()
    register_surfaces(surface)
    const awareness = new_awareness_controller()

    awareness.tick(actor)
    expect(surface.create_entity).toHaveBeenCalledTimes(1)
    expect(surface.create_entity.mock.calls[0][0].name).toBe('sgluna-npc-vision')
    const entity = surface.vision_entities[0]

    actor.position.x = 40 + 32 * 10
    awareness.tick(actor)
    expect(entity.teleport).toHaveBeenCalledTimes(1)
    expect(entity.position.x).toBe(360)
    expect(surface.vision_entities).toHaveLength(1)
  })

  it('does not create one for a connected human actor', () => {
    const { actor, surface } = make_actor({ kind: 'connected_player' })
    register_surfaces(surface)
    new_awareness_controller().tick(actor)
    expect(surface.create_entity).not.toHaveBeenCalled()
  })
})

// ---- invisibility ---------------------------------------------------------

describe('every entity scan excludes the vision vehicle', () => {
  function scan_surface(entities: any[]) {
    return {
      find_entities_filtered: vi.fn(() => entities),
      count_entities_filtered: vi.fn(() => entities.length),
    } as any
  }

  it('names the entity and filters lists', () => {
    expect(NPC_VISION_ENTITY_NAME).toBe('sgluna-npc-vision')
    expect(is_npc_vision_entity({ name: 'sgluna-npc-vision' })).toBe(true)
    expect(is_npc_vision_entity({ name: 'car' })).toBe(false)
    expect(without_npc_vision([{ name: 'a' }, { name: 'sgluna-npc-vision' }, { name: 'b' }])).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('find_world_entities drops it from area, radius and type scans', () => {
    const chest = { name: 'wooden-chest' }
    const vision = { name: 'sgluna-npc-vision' }
    const surface = scan_surface([chest, vision])

    expect(find_world_entities(surface, { area: [[0, 0], [10, 10]] })).toEqual([chest])
    expect(find_world_entities(surface, { position: { x: 0, y: 0 }, radius: 5 })).toEqual([chest])
    expect(find_world_entities(surface, { type: 'car' })).toEqual([chest])
  })

  it('find_world_entities never even asks the engine for the vehicle by name', () => {
    const surface = scan_surface([{ name: 'sgluna-npc-vision' }])

    expect(find_world_entities(surface, { name: 'sgluna-npc-vision' })).toEqual([])
    expect(find_world_entities(surface, { name: ['sgluna-npc-vision'] })).toEqual([])
    expect(surface.find_entities_filtered).not.toHaveBeenCalled()

    // A list that also names real entities keeps those and drops the vehicle.
    expect(find_world_entities(surface, { name: ['wooden-chest', 'sgluna-npc-vision'] })).toEqual([])
    expect(surface.find_entities_filtered).toHaveBeenCalledWith({ name: ['wooden-chest'] })
  })

  it('count_world_entities does not count the vehicle by name', () => {
    const surface = scan_surface([{ name: 'wooden-chest' }])
    expect(count_world_entities(surface, { name: 'sgluna-npc-vision' })).toBe(0)
    expect(surface.count_entities_filtered).not.toHaveBeenCalled()
    expect(count_world_entities(surface, { name: 'wooden-chest', radius: 4, position: { x: 0, y: 0 } })).toBe(1)
  })

  it('counts and lists without the vehicle for unnamed, type, area and limited scans', () => {
    // A surface that really filters: one chest, one real car and two vision vehicles.
    const chest = { name: 'wooden-chest', type: 'container' }
    const car = { name: 'car', type: 'car' }
    const vision_a = { name: 'sgluna-npc-vision', type: 'car' }
    const vision_b = { name: 'sgluna-npc-vision', type: 'car' }
    const everything = [vision_a, chest, vision_b, car]
    const surface: any = {
      find_entities_filtered: vi.fn((filters: any) => {
        let found = everything.filter((entity) => {
          const names = filters.name === undefined ? undefined : ([] as string[]).concat(filters.name)
          const types = filters.type === undefined ? undefined : ([] as string[]).concat(filters.type)
          const match = (names === undefined || names.includes(entity.name)) && (types === undefined || types.includes(entity.type))
          return filters.invert === true ? !match : match
        })
        if (filters.limit !== undefined) found = found.slice(0, filters.limit)
        return found
      }),
      count_entities_filtered: vi.fn((filters: any) => surface.find_entities_filtered(filters).length),
    }

    expect(count_world_entities(surface, { area: [[0, 0], [10, 10]] })).toBe(2)
    expect(count_world_entities(surface, { type: 'car' })).toBe(1)
    expect(count_world_entities(surface, { type: ['car', 'container'] })).toBe(2)
    expect(count_world_entities(surface, { position: { x: 0, y: 0 }, radius: 5 })).toBe(2)
    expect(find_world_entities(surface, { type: 'car' })).toEqual([car])
    // The engine would fill limit 1 with a vehicle and the filter would drop it.
    expect(find_world_entities(surface, { type: 'car', limit: 1 })).toEqual([car])
    expect(find_world_entities(surface, { area: [[0, 0], [10, 10]], limit: 1 })).toEqual([chest])
    expect(count_world_entities(surface, { type: 'car', limit: 1 })).toBe(1)
  })

  it('handles inverted filters: the vehicle never comes back through invert', () => {
    const chest = { name: 'wooden-chest', type: 'container' }
    const vision = { name: 'sgluna-npc-vision', type: 'car' }
    const surface: any = {
      find_entities_filtered: vi.fn((filters: any) => (filters.invert === true && filters.name === 'wooden-chest' ? [vision] : [chest, vision])),
      count_entities_filtered: vi.fn(() => 1),
    }

    // "everything except chests" would be just the vehicle: it is dropped.
    expect(find_world_entities(surface, { name: 'wooden-chest', invert: true })).toEqual([])
    expect(count_world_entities(surface, { name: 'wooden-chest', invert: true })).toBe(0)
    // Inverting a filter that names the vehicle is still passed through, then filtered.
    expect(find_world_entities(surface, { name: 'sgluna-npc-vision', invert: true })).toEqual([chest])
  })

  it('repeats a limited scan without the limit when orphan vehicles filled the extra window', () => {
    const chest = { name: 'wooden-chest', type: 'container' }
    const orphans = [{ name: 'sgluna-npc-vision' }, { name: 'sgluna-npc-vision' }]
    const surface: any = {
      find_entities_filtered: vi.fn((filters: any) => [...orphans, chest].slice(0, filters.limit)),
      count_entities_filtered: vi.fn(() => 2),
    }
    expect(find_world_entities(surface, { area: [[0, 0], [1, 1]], limit: 1 })).toEqual([chest])
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(2)
    expect(surface.find_entities_filtered).toHaveBeenLastCalledWith({ area: [[0, 0], [1, 1]] })
  })

  it('does not pay for a post-filter when no vehicle exists or the filter names real entities', () => {
    const chest = { name: 'wooden-chest' }
    const surface: any = {
      find_entities_filtered: vi.fn(() => [chest]),
      count_entities_filtered: vi.fn((filters: any) => (filters.name === 'sgluna-npc-vision' ? 0 : 1)),
    }
    expect(find_world_entities(surface, { area: [[0, 0], [1, 1]], limit: 1 })).toEqual([chest])
    expect(surface.find_entities_filtered).toHaveBeenCalledTimes(1)
    expect(surface.find_entities_filtered).toHaveBeenLastCalledWith({ area: [[0, 0], [1, 1]], limit: 2 })
    // A type filter without cars cannot match the vehicle: no extra window.
    expect(find_world_entities(surface, { type: 'container', limit: 1 })).toEqual([chest])
    expect(surface.find_entities_filtered).toHaveBeenLastCalledWith({ type: 'container', limit: 1 })
    expect(count_world_entities(surface, { type: 'container' })).toBe(1)
    expect(find_world_entities(surface, { name: 'wooden-chest', limit: 1 })).toEqual([chest])
    expect(surface.find_entities_filtered).toHaveBeenLastCalledWith({ name: 'wooden-chest', limit: 1 })
  })

  it('leaves no mod source calling the engine scan directly', () => {
    const root = fileURLToPath(new URL('.', import.meta.url))
    // The helper itself, and the NPC body lookup that filters on name 'character'.
    const allowed = new Set(['npc_vision.ts', 'actors/standalone_character_actor.ts'])
    const offenders: string[] = []
    const visit = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          visit(`${directory}${entry.name}/`, `${prefix}${entry.name}/`)
          continue
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.startsWith('test-')) continue
        const relative = `${prefix}${entry.name}`
        if (allowed.has(relative)) continue
        const source = readFileSync(`${directory}${entry.name}`, 'utf8')
        // Comments may mention the engine call; code may not use it.
        const code = source.split(/\r?\n/).filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*')).join('\n')
        if (/\.(?:find|count)_entities_filtered\(/.test(code)) offenders.push(relative)
      }
    }
    visit(root, '')
    expect(offenders).toEqual([])
  })

  it('keeps the prototype name in data.lua in step with the constant', () => {
    const data = readFileSync(fileURLToPath(new URL('../data.lua', import.meta.url)), 'utf8')
    expect(data).toContain(`name = "${NPC_VISION_ENTITY_NAME}"`)
  })
})
