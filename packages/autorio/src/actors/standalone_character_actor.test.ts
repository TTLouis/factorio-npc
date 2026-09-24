import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StandaloneCharacterActor } from './standalone_character_actor'

function fake_character(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    unit_number: 42,
    position: { x: 10, y: 20 },
    surface: { name: 'nauvis' },
    force: { name: 'player' },
    color: undefined,
    selected: undefined,
    mining_state: { mining: false },
    character_mining_progress: 0,
    crafting_queue: [],
    update_selected_entity: vi.fn(),
    get_main_inventory: vi.fn(() => 'main-inventory'),
    get_craftable_count: vi.fn(() => 7),
    begin_crafting: vi.fn(),
    cancel_crafting: vi.fn(),
    ...overrides,
  }
}

function fake_surface(entities_by_query: Record<string, unknown[]> = {}) {
  return {
    create_entity: vi.fn(),
    find_entities_filtered: vi.fn((query: { name?: string }) => entities_by_query[query.name ?? ''] ?? []),
  } as any
}

beforeEach(() => {
  (globalThis as any).storage = {}
  ;(globalThis as any).game = { get_entity_by_unit_number: vi.fn(() => undefined) }
})

describe('StandaloneCharacterActor.create', () => {
  it('creates a character entity and persists its physical and logical identity', () => {
    const character = fake_character()
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(character)
    const force = { name: 'player' } as any

    const actor = StandaloneCharacterActor.create(surface, force, { x: 10, y: 20 })

    expect(surface.create_entity).toHaveBeenCalledWith({ name: 'character', position: { x: 10, y: 20 }, force })
    expect(actor).toBeDefined()
    expect(actor!.character).toBe(character)
    expect((character as any).color).toEqual({ r: 0.35, g: 0.65, b: 1, a: 1 })
    expect((globalThis as any).storage.standalone_character_unit_number).toBe(42)
    expect((globalThis as any).storage.standalone_npc_identity).toEqual({ id: 'npc-1', name: 'Aster-1' })
  })

  it('keeps the same logical name when a replacement body is created', () => {
    const surface = fake_surface()
    surface.create_entity
      .mockReturnValueOnce(fake_character({ unit_number: 42 }))
      .mockReturnValueOnce(fake_character({ unit_number: 99 }))

    const first = StandaloneCharacterActor.create(surface, {} as any, { x: 0, y: 0 })!
    const identity = first.status_snapshot()
    const replacement = StandaloneCharacterActor.create(surface, {} as any, { x: 5, y: 5 })!

    expect(replacement.status_snapshot().npc_id).toBe(identity.npc_id)
    expect(replacement.status_snapshot().name).toBe(identity.name)
    expect(replacement.status_snapshot().actor_id).toBe(99)
    expect((globalThis as any).storage.standalone_npc_identity_serial).toBe(2)
  })

  it('returns undefined when the engine refuses to create the entity', () => {
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(undefined)

    const actor = StandaloneCharacterActor.create(surface, {} as any, { x: 0, y: 0 })

    expect(actor).toBeUndefined()
    expect((globalThis as any).storage.standalone_character_unit_number).toBeUndefined()
  })
})

describe('StandaloneCharacterActor.reacquire', () => {
  it('returns undefined when nothing was ever created', () => {
    const surface = fake_surface()

    expect(StandaloneCharacterActor.reacquire(surface)).toBeUndefined()
  })

  it('finds the persisted character by unit_number among same-named entities', () => {
    (globalThis as any).storage.standalone_character_unit_number = 42
    const character = fake_character({ unit_number: 42 })
    const other = fake_character({ unit_number: 99 })
    const surface = fake_surface({ character: [other, character] })

    const actor = StandaloneCharacterActor.reacquire(surface)

    expect(actor).toBeDefined()
    expect(actor!.character).toBe(character)
    expect((character as any).color).toEqual({ r: 0.35, g: 0.65, b: 1, a: 1 })
    expect(actor!.status_snapshot()).toMatchObject({ npc_id: 'npc-1', name: 'Aster-1' })
  })

  it('finds the body on another surface (planet or space platform) instead of respawning it', () => {
    (globalThis as any).storage.standalone_character_unit_number = 42
    const character = fake_character({ unit_number: 42, name: 'character', surface: { name: 'vulcanus' } })
    ;(globalThis as any).game.get_entity_by_unit_number = vi.fn(() => character)
    const nauvis = fake_surface({ character: [] })

    const actor = StandaloneCharacterActor.reacquire(nauvis)

    expect(actor?.character).toBe(character)
    expect(nauvis.find_entities_filtered).not.toHaveBeenCalled()
  })

  it('returns undefined when the persisted unit_number no longer exists (e.g. it died)', () => {
    (globalThis as any).storage.standalone_character_unit_number = 42
    const surface = fake_surface({ character: [] })

    expect(StandaloneCharacterActor.reacquire(surface)).toBeUndefined()
  })
})

describe('StandaloneCharacterActor as a ControlledActor', () => {
  function create_actor(overrides: Record<string, unknown> = {}) {
    const character = fake_character(overrides)
    const surface = fake_surface()
    surface.create_entity.mockReturnValue(character)
    const actor = StandaloneCharacterActor.create(surface, {} as any, { x: 0, y: 0 })!
    return { actor, character }
  }

  it('reads identity/position/force/surface/character straight through from the character entity', () => {
    const { actor, character } = create_actor()

    expect(actor.is_valid).toBe(true)
    expect(actor.character).toBe(character)
    expect(actor.surface).toBe(character.surface)
    expect(actor.force).toBe(character.force)
    expect(actor.position).toBe(character.position)
  })

  it('delegates main inventory and native crafting controls to the character entity', () => {
    const queue = [
      { index: 1, recipe: 'copper-cable', count: 4, prerequisite: true },
      { index: 2, recipe: 'electronic-circuit', count: 2, prerequisite: false },
    ]
    const { actor, character } = create_actor({ crafting_queue: queue })

    expect(actor.get_main_inventory()).toBe('main-inventory')
    expect(actor.get_craftable_count('iron-gear-wheel')).toBe(7)
    expect(character.get_craftable_count).toHaveBeenCalledWith('iron-gear-wheel')

    actor.begin_crafting({ count: 2, recipe: 'iron-gear-wheel' })
    expect(character.begin_crafting).toHaveBeenCalledWith({ count: 2, recipe: 'iron-gear-wheel' })

    expect(actor.get_crafting_queue()).toEqual(queue)
    expect(actor.get_crafting_queue_count('electronic-circuit')).toBe(2)

    actor.cancel_crafting({ index: 2, count: 1 })
    expect(character.cancel_crafting).toHaveBeenCalledWith({ index: 2, count: 1 })
  })

  it('gets and sets mining/walking/shooting state directly on the character entity while mining is progressing', () => {
    const selected = { name: 'iron-ore' }
    const { actor, character } = create_actor({
      selected,
      character_mining_progress: 0.5,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: true, position: { x: 1, y: 1 } })

    actor.set_mining_state({ mining: false })
    expect((character as any).mining_state).toEqual({ mining: false })

    actor.set_walking_state({ walking: true, direction: 4 as any })
    expect((character as any).walking_state).toEqual({ walking: true, direction: 4 })

    actor.set_shooting_state({ state: 'shooting_enemies' as any, position: { x: 5, y: 5 } })
    expect((character as any).shooting_state).toEqual({ state: 'shooting_enemies', position: { x: 5, y: 5 } })
  })

  it('reports mining as effectively stopped when Factorio clears the selected entity', () => {
    const { actor } = create_actor({
      selected: undefined,
      character_mining_progress: 0.5,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: false })
  })

  it('preserves freshly started mining while Factorio progress is still zero', () => {
    const { actor } = create_actor({
      selected: { name: 'iron-ore' },
      character_mining_progress: 0,
      mining_state: { mining: true, position: { x: 1, y: 1 } },
    })

    expect(actor.get_mining_state()).toEqual({ mining: true, position: { x: 1, y: 1 } })
  })

  it('never claims a LuaPlayer-sourced event, since it has no LuaPlayer behind it', () => {
    const { actor } = create_actor()

    expect(actor.owns_player_index(1)).toBe(false)
    expect(actor.owns_player_index(0)).toBe(false)
  })

  it('builds entity_build_args with only a force, unlike ConnectedPlayerActor', () => {
    const { actor, character } = create_actor()

    expect(actor.entity_build_args()).toEqual({ force: character.force })
  })

  it('produces a status snapshot with persistent logical identity and bounded mining diagnostics', () => {
    const { actor } = create_actor()

    expect(actor.status_snapshot()).toEqual({
      kind: 'standalone_character',
      valid: true,
      name: 'Aster-1',
      npc_id: 'npc-1',
      position: { x: 10, y: 20 },
      has_character: true,
      actor_id: 42,
      selected_entity: undefined,
      mining_state: { mining: false },
      mining_progress: 0,
    })
  })
})
