import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get_load_handler } from '../test-event-registry'
import {
  get_actor_mode,
  get_controlled_actor,
  get_load_reconciliation_status,
  get_npc_recovery_status,
  reconcile_npc_after_load,
  register_npc_recovery_handler,
  set_actor_mode,
} from './actor_controller'

function fake_character(unit_number: number, valid = true) {
  return {
    valid,
    unit_number,
    position: { x: 4, y: 5 },
    surface: undefined as any,
    force: undefined as any,
    mining_state: { mining: false },
    walking_state: { walking: false, direction: 'north' },
    shooting_state: { state: 'not_shooting', position: { x: 4, y: 5 } },
    crafting_queue: [] as Array<{ index: number, recipe: string, count: number, prerequisite: boolean }>,
    get_main_inventory: vi.fn(),
    get_craftable_count: vi.fn(() => 0),
    begin_crafting: vi.fn(),
    cancel_crafting: vi.fn(),
  }
}

function make_world() {
  const force = {
    name: 'player',
    index: 1,
    get_spawn_position: vi.fn(() => ({ x: 0, y: 0 })),
  }
  const surface = {
    name: 'nauvis',
    index: 1,
    valid: true,
    find_entities_filtered: vi.fn(() => [] as any[]),
    find_non_colliding_position: vi.fn(() => ({ x: 1, y: 2 })),
    create_entity: vi.fn(),
    is_chunk_generated: vi.fn(() => true),
    request_to_generate_chunks: vi.fn(),
    force_generate_chunk_requests: vi.fn(),
  }
  return { force, surface }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  const { force, surface } = make_world()
  ;(globalThis as any).game = {
    connected_players: [],
    surfaces: { 1: surface },
    get_surface: vi.fn((index: number) => (index === 1 ? surface : undefined)),
    forces: { player: force },
    print: vi.fn(),
    tick: 123,
    is_multiplayer: vi.fn(() => false),
    get_entity_by_unit_number: vi.fn(() => undefined),
  }
  ;(globalThis as any).rendering = { clear: vi.fn() }
  register_npc_recovery_handler(undefined)
  set_actor_mode('player')
})

describe('actor mode', () => {
  it('defaults to the legacy connected-player mode', () => {
    ;(globalThis as any).storage = {}
    expect(get_actor_mode()).toBe('player')
  })

  it('resolves the first connected player in player mode', () => {
    const player = {
      valid: true,
      index: 1,
      name: 'Louis',
      position: { x: 0, y: 0 },
      surface: { name: 'nauvis' },
      force: { name: 'player' },
      character: { valid: true },
      get_main_inventory: vi.fn(),
      update_selected_entity: vi.fn(),
      get_craftable_count: vi.fn(),
      begin_crafting: vi.fn(),
      cancel_crafting: vi.fn(),
      crafting_queue: [],
    }
    ;(globalThis as any).game.connected_players = [player]

    const actor = get_controlled_actor()

    expect(actor?.status_snapshot().kind).toBe('connected_player')
    expect(actor?.status_snapshot().name).toBe('Louis')
  })

  it('creates a standalone character in npc mode and persists its identity', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.create_entity.mockReturnValue(character)

    set_actor_mode('npc')
    const actor = get_controlled_actor()

    expect(surface.create_entity).toHaveBeenCalledWith({
      name: 'character',
      position: { x: 1, y: 2 },
      force,
    })
    expect(actor?.status_snapshot().kind).toBe('standalone_character')
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(42)
    expect(get_npc_recovery_status().last_result).toBeUndefined()
  })

  it('forces only a bounded 3x3 spawn neighborhood before creating the NPC when no player ever generated it', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.is_chunk_generated.mockReturnValue(false)
    surface.create_entity.mockReturnValue(character)

    set_actor_mode('npc')
    const actor = get_controlled_actor()

    expect(surface.is_chunk_generated).toHaveBeenCalledWith({ x: 0, y: 0 })
    expect(surface.request_to_generate_chunks).toHaveBeenCalledWith({ x: 0, y: 0 }, 1)
    expect(surface.force_generate_chunk_requests).toHaveBeenCalled()
    expect(actor?.status_snapshot().kind).toBe('standalone_character')
  })

  it('skips chunk generation requests when the spawn chunk already exists', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.create_entity.mockReturnValue(character)

    set_actor_mode('npc')
    get_controlled_actor()

    expect(surface.request_to_generate_chunks).not.toHaveBeenCalled()
    expect(surface.force_generate_chunk_requests).not.toHaveBeenCalled()
  })

  it('respawns a dead NPC at (0, 0) of the surface it was last alive on', () => {
    const nauvis = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const platform = {
      name: 'platform-1',
      index: 7,
      valid: true,
      find_entities_filtered: vi.fn(() => [] as any[]),
      find_non_colliding_position: vi.fn(() => ({ x: 0.5, y: 0.5 })),
      create_entity: vi.fn(),
      is_chunk_generated: vi.fn(() => true),
      request_to_generate_chunks: vi.fn(),
      force_generate_chunk_requests: vi.fn(),
    }
    ;(globalThis as any).game.get_surface = vi.fn((index: number) => (index === 1 ? nauvis : index === 7 ? platform : undefined))
    const first = fake_character(42)
    first.surface = nauvis
    first.force = force
    nauvis.create_entity.mockReturnValueOnce(first)

    set_actor_mode('npc')
    expect(get_controlled_actor()?.character).toBe(first)
    expect((globalThis as any).storage.airi_npc_surface_index).toBe(1)

    // It travels, then dies there.
    first.surface = platform
    get_controlled_actor()
    expect((globalThis as any).storage.airi_npc_surface_index).toBe(7)
    first.valid = false
    const replacement = fake_character(99)
    replacement.surface = platform
    replacement.force = force
    platform.create_entity.mockReturnValueOnce(replacement)

    expect(get_controlled_actor()?.character).toBe(replacement)
    expect(platform.find_non_colliding_position).toHaveBeenCalledWith('character', { x: 0, y: 0 }, 32, 0.5)
    expect(nauvis.create_entity).toHaveBeenCalledTimes(1)
    expect(force.get_spawn_position).not.toHaveBeenCalled()
  })

  it('reacquires a persisted standalone character instead of creating a duplicate', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.standalone_character_unit_number = 42

    set_actor_mode('npc')
    const actor = get_controlled_actor()

    expect(actor?.character).toBe(character)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(get_npc_recovery_status().last_result).toBeUndefined()
  })

  it('invalidates stale work before replacing a missing standalone character', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const first = fake_character(42)
    const replacement = fake_character(99)
    first.surface = surface
    first.force = force
    replacement.surface = surface
    replacement.force = force
    surface.create_entity.mockReturnValueOnce(first)
    const recovery_handler = vi.fn()
    register_npc_recovery_handler(recovery_handler)

    set_actor_mode('npc')
    const actor = get_controlled_actor()
    expect(actor?.character).toBe(first)

    first.valid = false
    ;(globalThis as any).storage.airi_owned_crafting = {
      actor_id: 42,
      actor_kind: 'standalone_character',
      force_index: 1,
      item_name: 'iron-gear-wheel',
      requested_count: 5,
      started_tick: 100,
    }
    surface.find_entities_filtered.mockReturnValue([])
    surface.create_entity.mockImplementationOnce(() => {
      expect(recovery_handler).toHaveBeenCalledWith({ previous_actor_id: 42 })
      expect((globalThis as any).storage.airi_owned_crafting).toBeUndefined()
      return replacement
    })
    const recovered = get_controlled_actor()

    expect(recovered?.character).toBe(replacement)
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(99)
    expect(recovery_handler).toHaveBeenCalledTimes(1)
    expect((globalThis as any).rendering.clear).toHaveBeenCalledTimes(1)
    expect(get_npc_recovery_status()).toEqual({
      policy: 'discard_autorio_tasks_and_create_empty_replacement',
      pending_from_actor_id: undefined,
      last_result: {
        reason: 'missing_persisted_actor',
        previous_actor_id: 42,
        replacement_actor_id: 99,
        force_index: 1,
        tick: 123,
        inventory_policy: 'no_transfer',
      },
    })
  })

  it('does not repeatedly invalidate work when replacement creation temporarily fails', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const first = fake_character(42)
    first.surface = surface
    first.force = force
    surface.create_entity.mockReturnValueOnce(first)
    const recovery_handler = vi.fn()
    register_npc_recovery_handler(recovery_handler)

    set_actor_mode('npc')
    get_controlled_actor()
    first.valid = false
    surface.find_entities_filtered.mockReturnValue([])
    surface.create_entity.mockReturnValue(undefined)

    expect(get_controlled_actor()).toBeUndefined()
    expect(get_controlled_actor()).toBeUndefined()
    expect(recovery_handler).toHaveBeenCalledTimes(1)
    expect(get_npc_recovery_status().pending_from_actor_id).toBe(42)
  })

  it('reacquires the same saved npc and clears stale physical inputs after on_load', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    character.walking_state = { walking: true, direction: 'east' }
    character.mining_state = { mining: true, position: { x: 5, y: 5 } } as any
    character.shooting_state = { state: 'shooting_selected', position: { x: 6, y: 5 } }
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    ;(globalThis as any).storage.standalone_character_unit_number = 42

    get_load_handler()()
    expect(get_load_reconciliation_status().pending).toBe(true)

    const actor = get_controlled_actor()

    expect(actor?.character).toBe(character)
    expect(surface.create_entity).not.toHaveBeenCalled()
    expect(character.walking_state).toEqual({ walking: false, direction: 'north' })
    expect(character.mining_state).toEqual({ mining: false })
    expect(character.shooting_state).toEqual({ state: 'not_shooting', position: character.position })
    expect((globalThis as any).rendering.clear).toHaveBeenCalledTimes(1)
    expect(get_load_reconciliation_status()).toEqual({
      policy: 'discard_autorio_tasks_and_stop_npc_controls_on_load',
      owned_crafting_policy: 'cancel_persisted_autorio_owned_native_queue_on_load',
      trigger: 'lazy_in_single_player_replicated_remote_call_in_multiplayer',
      pending: false,
      last_actor_id: 42,
      last_tick: 123,
      owned_crafting: undefined,
    })
  })

  it('cancels only a persisted Autorio-owned native crafting queue after load', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    character.crafting_queue = [
      { index: 1, recipe: 'copper-cable', count: 6, prerequisite: true },
      { index: 2, recipe: 'electronic-circuit', count: 2, prerequisite: false },
    ]
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    ;(globalThis as any).storage.standalone_character_unit_number = 42
    ;(globalThis as any).storage.airi_owned_crafting = {
      actor_id: 42,
      actor_kind: 'standalone_character',
      force_index: 1,
      item_name: 'electronic-circuit',
      requested_count: 2,
      started_tick: 100,
    }

    get_load_handler()()
    get_controlled_actor()

    expect(character.cancel_crafting).toHaveBeenCalledWith({ index: 2, count: 2 })
    expect(character.cancel_crafting).toHaveBeenCalledWith({ index: 1, count: 6 })
    expect((globalThis as any).storage.airi_owned_crafting).toBeUndefined()
    expect(get_load_reconciliation_status().owned_crafting).toEqual({
      actor_id: 42,
      item_name: 'electronic-circuit',
      requested_count: 2,
      cancelled_queue_count: 8,
    })
  })

  it('does not cancel an unmarked native crafting queue merely because a save loaded', () => {
    const surface = (globalThis as any).game.surfaces[1]
    const force = (globalThis as any).game.forces.player
    const character = fake_character(42)
    character.surface = surface
    character.force = force
    character.crafting_queue = [{ index: 1, recipe: 'copper-cable', count: 20, prerequisite: false }]
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    ;(globalThis as any).storage.standalone_character_unit_number = 42

    get_load_handler()()
    get_controlled_actor()

    expect(character.cancel_crafting).not.toHaveBeenCalled()
    expect(get_load_reconciliation_status().owned_crafting).toBeUndefined()
  })

  it('does not clear a connected player control state merely because a save loaded', () => {
    const player = {
      valid: true,
      index: 1,
      name: 'Louis',
      position: { x: 0, y: 0 },
      surface: { name: 'nauvis' },
      force: { name: 'player' },
      character: { valid: true },
      walking_state: { walking: true, direction: 'east' },
      mining_state: { mining: false },
      shooting_state: { state: 'not_shooting' },
      crafting_queue: [],
      get_main_inventory: vi.fn(),
      update_selected_entity: vi.fn(),
      get_craftable_count: vi.fn(),
      begin_crafting: vi.fn(),
      cancel_crafting: vi.fn(),
    }
    ;(globalThis as any).game.connected_players = [player]
    ;(globalThis as any).storage.airi_actor_mode = 'player'

    get_load_handler()()
    const actor = get_controlled_actor()

    expect(actor?.status_snapshot().kind).toBe('connected_player')
    expect(player.walking_state).toEqual({ walking: true, direction: 'east' })
    expect((globalThis as any).rendering.clear).not.toHaveBeenCalled()
    expect(get_load_reconciliation_status().pending).toBe(true)
  })

  function loaded_multiplayer_npc() {
    const surface = (globalThis as any).game.surfaces[1]
    const character = fake_character(42)
    character.surface = surface
    character.force = (globalThis as any).game.forces.player
    character.walking_state = { walking: true, direction: 'east' }
    surface.find_entities_filtered.mockReturnValue([character])
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    ;(globalThis as any).storage.standalone_character_unit_number = 42
    ;(globalThis as any).game.is_multiplayer.mockReturnValue(true)
    return character
  }

  it('never reconciles a loaded NPC from on_load alone in multiplayer', () => {
    const character = loaded_multiplayer_npc()

    get_load_handler()()
    const actor = get_controlled_actor()

    // on_load runs again on every joining client, but the server cleared its own
    // flag at its load. Stopping the NPC here would change synchronized state on
    // one peer only while the server keeps walking it, which desyncs the game.
    expect(actor?.character).toBe(character)
    expect(character.walking_state).toEqual({ walking: true, direction: 'east' })
    expect(character.shooting_state).toEqual({ state: 'not_shooting', position: { x: 4, y: 5 } })
    expect((globalThis as any).rendering.clear).not.toHaveBeenCalled()
    expect(get_load_reconciliation_status().pending).toBe(true)
  })

  it('reconciles a loaded multiplayer NPC from the replicated remote call instead', () => {
    const character = loaded_multiplayer_npc()
    character.shooting_state = { state: 'shooting_selected', position: { x: 6, y: 5 } }

    get_load_handler()()
    get_controlled_actor()
    expect(character.walking_state).toEqual({ walking: true, direction: 'east' })

    // RCON is replicated to every peer as one input action, so this runs at the
    // same tick against the same storage everywhere.
    const result = reconcile_npc_after_load()

    expect(result).toEqual({ reconciled: true, reason: 'reconciled', actor_id: 42, tick: 123 })
    expect(character.walking_state).toEqual({ walking: false, direction: 'north' })
    expect(character.mining_state).toEqual({ mining: false })
    expect(character.shooting_state).toEqual({ state: 'not_shooting', position: character.position })
    expect(get_load_reconciliation_status().pending).toBe(false)
  })

  it('keeps a replicated reconcile a no-op instead of spawning a body or touching a player actor', () => {
    ;(globalThis as any).storage.airi_actor_mode = 'npc'
    const surface = (globalThis as any).game.surfaces[1]

    expect(reconcile_npc_after_load()).toEqual({
      reconciled: false,
      reason: 'no_persisted_npc_body',
      tick: 123,
    })
    expect(surface.create_entity).not.toHaveBeenCalled()

    ;(globalThis as any).storage.airi_actor_mode = 'player'
    expect(reconcile_npc_after_load()).toEqual({
      reconciled: false,
      reason: 'actor_mode_is_player',
      tick: 123,
    })
  })
})