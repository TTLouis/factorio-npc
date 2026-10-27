import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { get_controlled_actor } from './actors/actor_controller'
import { create_placement_candidate_set } from './placement_candidates'

// The anchor a candidate request names must reach the placement task through the shipped place_candidate
// remote entry in control.ts, not only through a test double for submit_placement.

const FURNACE = {
  name: 'stone-furnace',
  type: 'furnace',
  tile_width: 2,
  tile_height: 2,
  collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
  collision_mask: { layers: { object: true, item: true } },
  items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
}

const interfaces: Record<string, any> = {}
let control: typeof import('./control')

beforeAll(async () => {
  ;(globalThis as any).remote.add_interface = (name: string, value: any) => { interfaces[name] = value }
  control = await import('./control')
})

describe('place_candidate through the shipped remote entry', () => {
  const originalEntityPrototypes = (globalThis as any).prototypes.entity
  const originalGetEntity = (globalThis as any).game.get_entity_by_unit_number
  const originalPairs = (globalThis as any).pairs

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes.entity = { 'stone-furnace': FURNACE }
    ;(globalThis as any).game.tick = 100
    ;(globalThis as any).log = vi.fn()
    ;(globalThis as any).storage.sgluna_actor_mode = 'player'
    control.task_manager.cancel_all_tasks()
  })

  afterEach(() => {
    ;(globalThis as any).prototypes.entity = originalEntityPrototypes
    ;(globalThis as any).game.get_entity_by_unit_number = originalGetEntity
    ;(globalThis as any).game.connected_players = []
    ;(globalThis as any).pairs = originalPairs
    control.task_manager.cancel_all_tasks()
  })

  it('forwards the anchor to the queued placement task', () => {
    const anchor: any = { valid: true, name: 'stone-furnace', type: 'furnace', unit_number: 31, position: { x: -30.5, y: -30.5 }, surface: { index: 1 }, force: { index: 1 } }
    const surface: any = {
      index: 1,
      get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
      find_entities_filtered: vi.fn(() => []),
      count_entities_filtered: vi.fn(() => 0),
      can_place_entity: vi.fn(() => true),
    }
    const player: any = {
      valid: true,
      index: 1,
      name: 'SGLuna',
      connected: true,
      character: { valid: true },
      position: { x: -33, y: -33 },
      surface,
      force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      walking_state: { walking: false },
      mining_state: { mining: false },
      crafting_queue: [],
    }
    ;(globalThis as any).game.connected_players = [player]
    ;(globalThis as any).game.get_entity_by_unit_number = (unit: number) => unit === 31 ? anchor : undefined
    const actor = get_controlled_actor()!
    const generated = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', center: { x: -33, y: -33 }, radius: 3, limit: 1, anchor: { unit_number: 31 } }) as any
    expect(generated.ok).toBe(true)

    const accepted = interfaces.autorio_operations.place_candidate(generated.candidate_set_id, generated.candidates[0].id)

    expect(accepted[0]).toBe(true)
    expect(control.task_manager.player_state.parameters_place_entity?.protected_unit_numbers).toEqual([31])
  })

  it('queues a placement with no protected list when the request named no anchor', () => {
    const surface: any = {
      index: 1,
      get_tile: () => ({ name: 'grass-1', collides_with: () => false }),
      find_entities_filtered: vi.fn(() => []),
      count_entities_filtered: vi.fn(() => 0),
      can_place_entity: vi.fn(() => true),
    }
    ;(globalThis as any).game.connected_players = [{ valid: true, index: 1, name: 'SGLuna', connected: true, character: { valid: true }, position: { x: -33, y: -33 }, surface, force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      walking_state: { walking: false }, mining_state: { mining: false }, crafting_queue: [] }]
    const actor = get_controlled_actor()!
    const generated = create_placement_candidate_set(actor, { entity_name: 'stone-furnace', center: { x: -33, y: -33 }, radius: 3, limit: 1 }) as any

    expect(interfaces.autorio_operations.place_candidate(generated.candidate_set_id, generated.candidates[0].id)[0]).toBe(true)
    expect(control.task_manager.player_state.parameters_place_entity?.protected_unit_numbers).toBeUndefined()
  })
})
