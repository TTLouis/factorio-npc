import { beforeEach, describe, expect, it, vi } from 'vitest'
import { set_actor_mode } from './actors/actor_controller'
import { task_manager } from './control'
import { get_handler } from './test-event-registry'
import { TaskStates } from './types'

beforeEach(() => {
  ;(globalThis as any).game.connected_players = []
  ;(globalThis as any).storage.airi_actor_mode = 'player'
  ;(globalThis as any).storage.airi_awareness_chunk = undefined
  task_manager.cancel_all_tasks()
  ;(globalThis as any).storage.standalone_character_unit_number = undefined
  ;(globalThis as any).serpent = {
    line: (value: unknown) => JSON.stringify(value),
    block: (value: unknown) => JSON.stringify(value),
  }
})

function configureNpcWorld(resource?: Record<string, any>) {
  const force: Record<string, any> = {
    name: 'player',
    index: 1,
    technologies: {},
    recipes: {},
    current_research: undefined,
    research_progress: 0,
    get_spawn_position: () => ({ x: 0, y: 0 }),
    chart: vi.fn(),
  }

  let character_created = false
  const character: Record<string, any> = {
    valid: true,
    unit_number: 42,
    name: 'character',
    type: 'character',
    position: { x: 0, y: 0 },
    force,
    selected: undefined,
    mining_state: { mining: false, position: { x: 0, y: 0 } },
    character_mining_progress: 0,
    walking_state: { walking: false, direction: 'north' },
    shooting_state: { state: 'not_shooting', position: { x: 0, y: 0 } },
    crafting_queue: [],
    get_main_inventory: vi.fn(() => ({ get_item_count: vi.fn(() => 0) })),
    get_craftable_count: vi.fn(() => 0),
    begin_crafting: vi.fn(() => 0),
    cancel_crafting: vi.fn(),
  }

  character.update_selected_entity = vi.fn(() => {
    character.selected = resource?.valid === false ? undefined : resource
  })

  const surface: Record<string, any> = {
    name: 'nauvis',
    daytime: 0,
    wind_speed: 0,
    wind_orientation: 0,
    find_non_colliding_position: vi.fn(() => ({ x: 0, y: 0 })),
    is_chunk_generated: vi.fn(() => true),
    request_to_generate_chunks: vi.fn(),
    force_generate_chunk_requests: vi.fn(),
    create_entity: vi.fn(({ name }: { name: string }) => {
      if (name !== 'character') return undefined
      character_created = true
      return character
    }),
    find_entities_filtered: vi.fn((filter: Record<string, any>) => {
      if (filter.force === 'enemy') return []
      if (filter.name === 'character') return character_created ? [character] : []
      if (resource && filter.name === resource.name && resource.valid !== false) return [resource]
      return []
    }),
  }

  character.surface = surface
  if (resource) resource.surface = surface
  ;(globalThis as any).game.surfaces[1] = surface
  ;(globalThis as any).game.forces = { player: force }

  set_actor_mode('npc')
  return { character, force, surface }
}

function add_owned_npc_mining(count: number) {
  task_manager.add_task({
    type: TaskStates.MINING,
    operation_id: 1,
    owner_actor_id: 42,
    owner_actor_kind: 'standalone_character',
    owner_force_index: 1,
    entity_name: 'iron-ore',
    count,
    requested_count: count,
  })
}

describe('standalone NPC completion polling', () => {
  it('counts real resource depletion without restarting mining when progress resets and selection remains valid', () => {
    const resource: Record<string, any> = {
      valid: true,
      name: 'iron-ore',
      type: 'resource',
      position: { x: 1, y: 0 },
      amount: 10,
    }
    const { character } = configureNpcWorld(resource)
    const on_tick = get_handler('on_tick')

    add_owned_npc_mining(2)

    on_tick({})
    expect(character.update_selected_entity).toHaveBeenCalledWith(resource.position)
    expect(character.selected).toBe(resource)
    expect(character.mining_state.mining).toBe(true)
    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(2)

    const selections_after_start = character.update_selected_entity.mock.calls.length
    resource.amount = 9
    character.character_mining_progress = 0
    on_tick({})
    expect(task_manager.player_state.parameters_mine_entity?.count).toBe(1)
    expect(task_manager.player_state.task_state).toBe(TaskStates.MINING)
    expect(character.mining_state.mining).toBe(true)
    expect(character.selected).toBe(resource)
    expect(character.update_selected_entity.mock.calls.length).toBe(selections_after_start)

    resource.amount = 8
    character.character_mining_progress = 0
    on_tick({})
    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(character.mining_state.mining).toBe(false)
  })

  it('moves closer instead of restarting every tick when Factorio clears the selected entity', () => {
    const resource: Record<string, any> = {
      valid: true,
      name: 'iron-ore',
      type: 'resource',
      position: { x: 1, y: 0 },
      amount: 10,
    }
    const { character } = configureNpcWorld(resource)
    const on_tick = get_handler('on_tick')

    add_owned_npc_mining(2)

    on_tick({})
    resource.amount = 9
    character.selected = undefined
    character.character_mining_progress = 0.5
    on_tick({})

    expect(task_manager.player_state.task_state).toBe(TaskStates.WALKING_TO_ENTITY)
    expect(task_manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.MINING],
      current_task: {
        target_kind: 'position',
        requested_position: resource.position,
      },
    })
    expect(character.selected).toBeUndefined()
    expect(character.mining_state.mining).toBe(false)
  })
})

describe('connected player completion compatibility', () => {
  it('finishes a one-count mining task on the final player mining event', () => {
    const player: Record<string, any> = {
      valid: true,
      index: 1,
      name: 'AIRI',
      character: {},
      position: { x: 0, y: 0 },
      surface: { find_entities_filtered: () => [] },
      force: { index: 1 },
      mining_state: { mining: true, position: { x: 1, y: 0 } },
      crafting_queue: [],
      begin_crafting: vi.fn(() => 0),
    }
    ;(globalThis as any).game.connected_players = [player]
    set_actor_mode('player')

    task_manager.add_task({
      type: TaskStates.MINING,
      operation_id: 1,
      owner_actor_id: 1,
      owner_actor_kind: 'connected_player',
      owner_force_index: 1,
      entity_name: 'iron-ore',
      count: 1,
      requested_count: 1,
    })

    const on_player_mined_entity = get_handler('on_player_mined_entity')
    on_player_mined_entity({ player_index: 1 })

    expect(task_manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(player.mining_state.mining).toBe(false)
  })
})
